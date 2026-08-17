import { store } from './store';
import { platform } from './platform';
import { findPullRequestsByBranch } from './git';
import { parseLinearIssueCandidate, parsePrUrl } from '../shared/linear';
import type { PrLink } from '../shared/linear';
import { verifyLinearIssueByKey } from './linear';
import { scoped } from './logger';
import { isScratchLike, type Workspace } from '../shared/types';

const blog = scoped('link-backfill');

/** Current backfill revision. Bump to make the migration run again.
 *
 *  1 — v0.5.197: seeded the single `linkedPrUrl` + `linkedLinearKey`.
 *  2 — this change: `linkedPrs` is a LIST carrying owner/repo/number, so
 *      revision 1's stores hold a shape the badge path no longer reads. Every
 *      workspace revision 1 had already marked would otherwise be stranded
 *      with no badge and no way to get one back short of its agent running
 *      again — and most of these workspaces are finished work whose agent
 *      never will. That is precisely the population the backfill exists for,
 *      which is why a bare done/not-done flag was not enough. */
const LINK_BACKFILL_VERSION = 2;

/**
 * One-shot migration from branch-derived PR/Linear badges to agent-reported
 * links (`linkedPrs` / `linkedLinearKey`).
 *
 * Why this exists: neither badge reads the branch name any more, so
 * without a backfill every existing workspace would lose its badge the moment
 * this version ships and would only get it back if its agent ever ran again
 * and linked itself. Most workspaces here are finished work whose agent will
 * never run again — the badge would simply be gone forever. So we run the OLD
 * derivation exactly once and persist whatever it finds.
 *
 * Scope and safety:
 *  - Runs once ever, gated on a store flag; a second call is a no-op.
 *  - Only ever FILLS empty fields. An existing link (an agent got there first)
 *    is never overwritten — the agent is the source of truth, this is a guess.
 *  - Linear keys are VERIFIED before being stored, so the permissive branch
 *    regex can't persist junk like `POLL-429` from `usage-poll-429-backoff`.
 *    That is the one place this is strictly better than what it replaces: the
 *    old path re-guessed every poll, this bakes in only confirmed hits.
 *  - Failures are per-workspace and swallowed. A missing `gh`, a rate limit or
 *    an absent Linear key must not block startup or half-migrate the store —
 *    but note the flag is still set afterwards (see below).
 *
 * The flag is set even if individual lookups failed, deliberately: retrying
 * forever would re-run a full PR fetch and a Linear round-trip per workspace on
 * every single launch, which is exactly the quota drain this subsystem already
 * got burned by. A workspace the backfill couldn't resolve is not stuck — its
 * agent can link it, which is the mechanism this whole change is about.
 */
export async function backfillWorkspaceLinks(): Promise<void> {
  if (store.linkBackfillVersion >= LINK_BACKFILL_VERSION) return;

  const targets = store.workspaces.filter(
    (w) => !w.archived && !isScratchLike(w) && (!w.linkedPrs?.length || !w.linkedLinearKey),
  );
  if (targets.length === 0) {
    await store.markLinkBackfillVersion(LINK_BACKFILL_VERSION);
    return;
  }

  blog.info(`backfilling PR/Linear links for ${targets.length} workspace(s)`);
  let prFilled = 0;
  let linearFilled = 0;

  // Warm the per-repo PR cache ONCE per distinct repo, in parallel and under a
  // timeout, before the per-workspace loop.
  //
  // `findPullRequest` fetches every PR in a repo with `gh api --paginate` and
  // caches it for 60s, so N workspaces sharing a repo normally collapse into
  // one request — but only if the first call has RETURNED before the others
  // ask. Awaiting it serially per workspace does not collapse anything on a
  // cold cache; it just serialises N full fetches. Measured here: a repo with
  // ~9.6k PRs kept a single `gh --paginate` running for minutes, so the
  // backfill logged "backfilling…" and never reached its completion line —
  // startup work with no upper bound.
  //
  // Deliberately NOT awaited past the timeout: a repo too slow to answer is
  // one whose PR links this migration simply skips. That is a strictly better
  // outcome than blocking, because the whole feature is "agents report their
  // own links" — an unbackfilled workspace is asked by the SessionStart hook.
  const repos = [
    ...new Set(targets.filter((w) => !w.linkedPrs?.length).map((w) => w.repoPath)),
  ].filter(Boolean);
  if (repos.length) {
    const WARM_TIMEOUT_MS = 20_000;
    await Promise.all(
      repos.map((repoPath) =>
        Promise.race([
          // Any branch name works to prime the per-repo cache; we discard the
          // result and read it back per workspace below (a cache hit).
          findPullRequestsByBranch(repoPath, '').catch(() => null),
          new Promise((r) => setTimeout(r, WARM_TIMEOUT_MS)),
        ]),
      ),
    );
  }

  for (const ws of targets) {
    let next: Workspace | null = null;

    // --- PR: the branch head-ref match, exactly as the old badge did it.
    if (!ws.linkedPrs?.length) {
      try {
        // Normally a hit on the cache warmed above; a repo that timed out
        // re-enters here and is bounded the same way, so one slow repo cannot
        // stall the rest of the migration.
        const prs = (await Promise.race([
          findPullRequestsByBranch(ws.repoPath, ws.branch),
          new Promise<null>((r) => setTimeout(() => r(null), 5_000)),
        ])) as Awaited<ReturnType<typeof findPullRequestsByBranch>> | null;
        // `error` means gh couldn't be asked — NOT that there is no PR. Storing
        // nothing here is right; storing a link is what we skip.
        if (prs && !prs.error && prs.all.length) {
          // Store EVERY PR the branch matched, not just the newest: the schema
          // is now a list, and the old badge itself rendered up to three. Taking
          // only `latest` would quietly drop links the previous behaviour showed.
          // A URL that fails to parse is skipped rather than stored malformed —
          // it came from gh's own html_url, so this should never fire.
          const links = prs.all.map((p) => parsePrUrl(p.url)).filter((p): p is PrLink => !!p);
          if (links.length) {
            next = { ...(next ?? ws), linkedPrs: links };
            prFilled += links.length;
          }
        }
      } catch {
        /* per-workspace best-effort */
      }
    }

    // --- Linear: mine the branch, then CONFIRM before persisting.
    if (!ws.linkedLinearKey) {
      const candidate = parseLinearIssueCandidate(ws.branch);
      if (candidate) {
        try {
          const issue = await verifyLinearIssueByKey(candidate);
          if (issue) {
            next = { ...(next ?? ws), linkedLinearKey: issue.identifier };
            linearFilled++;
          }
        } catch {
          /* per-workspace best-effort */
        }
      }
    }

    if (next) {
      await store.upsertWorkspace(next);
      platform.broadcast('workspace:update', next);
    }
  }

  await store.markLinkBackfillVersion(LINK_BACKFILL_VERSION);
  blog.info(`backfill complete: ${prFilled} PR link(s), ${linearFilled} Linear link(s)`);
}
