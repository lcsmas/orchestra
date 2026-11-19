// `orchestra fanout deliver` (#467) — one PR per ticket into the target branch, CI awaited (0 checks / 0 steps is NOT green),
// merged at the verified head in ONE `gh pr merge --match-head-commit` call. Store-less (no socket): it only runs `gh`.
// The decision is PURE (src/shared/fanout-deliver.ts); this file is the I/O around it, with `gh` behind an injectable runner.
// Shares the `fanout` namespace with #469 (state/resume, src/cli/fanout-state.ts): the `fanout` case in index.ts routes `deliver` here.

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import {
  classifyMergeFailure,
  combinedSuiteCommand,
  DELIVER_EXIT,
  decideDelivery,
  isUserStep,
  normaliseRollupItem,
  parseActionsJobUrl,
  parseReviewVerdict,
  SAFE_REF,
  type DeliverCheck,
  type PrSnapshot,
  type RefuseReason,
  type ReviewVerdict,
  type RollupItem,
} from '../shared/fanout-deliver.ts';

export interface GhResult {
  code: number;
  stdout: string;
  stderr: string;
}
/** `gh` behind a seam: tests pass a fake, production spawns the real binary (argv, never a shell). */
export type GhRunner = (args: string[]) => Promise<GhResult>;

export const realGh: GhRunner = (args) =>
  new Promise((resolve) => {
    execFile('gh', args, { maxBuffer: 16 * 1024 * 1024, timeout: 120_000 }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? ((err as { code: number }).code) : 1) : 0;
      resolve({ code, stdout: String(stdout), stderr: err && (err as { code?: unknown }).code === 'ENOENT' ? 'gh: command not found' : String(stderr) });
    });
  });

export interface DeliverOpts {
  branch: string;
  into: string;
  ticket: string;
  reviewVerdict?: string;
  verifiedHead?: string;
  strategy: 'merge' | 'squash' | 'rebase';
  timeoutMs: number;
  intervalMs: number;
  noChecksGraceMs: number;
  suiteCmd?: string;
  repo?: string;
  requireChecks: string[];
}

export const DELIVER_USAGE =
  'usage: orchestra fanout deliver --branch <b> --into <target> --ticket <id> [--review-verdict <file>] [--verified-head <sha>]\n' +
  '       [--strategy merge|squash|rebase] [--timeout <s>] [--interval <s>] [--no-checks-grace <s>] [--suite-cmd <cmd>] [--repo <owner/name>] [--require-check <name>]…';

export type ParsedArgs = { ok: true; opts: DeliverOpts } | { ok: false; error: string };

/** Strict argv parse: an unknown flag or a ref that could be read as a gh option / shell metacharacter is a usage error (exit 1). */
export function parseDeliverArgs(args: string[]): ParsedArgs {
  const v: Record<string, string> = {};
  const known = new Set(['--branch', '--into', '--ticket', '--review-verdict', '--verified-head', '--strategy', '--timeout', '--interval', '--no-checks-grace', '--suite-cmd', '--repo', '--require-check']);
  const required: string[] = [];
  for (let i = 0; i < args.length; i += 2) {
    const k = args[i];
    if (!known.has(k)) return { ok: false, error: `unknown argument: ${k}\n${DELIVER_USAGE}` };
    const val = args[i + 1];
    if (val === undefined) return { ok: false, error: `${k} needs a value\n${DELIVER_USAGE}` };
    if (k === '--require-check') required.push(val);
    else v[k] = val;
  }
  for (const k of ['--branch', '--into', '--ticket']) if (!v[k]) return { ok: false, error: `${k} is required\n${DELIVER_USAGE}` };
  if (!SAFE_REF.test(v['--branch'])) return { ok: false, error: `unsafe --branch: ${v['--branch']}` };
  if (!SAFE_REF.test(v['--into'])) return { ok: false, error: `unsafe --into: ${v['--into']}` };
  if (v['--verified-head'] !== undefined && !/^[0-9a-f]{40}$/.test(v['--verified-head'])) return { ok: false, error: '--verified-head must be a full 40-hex sha' };
  if (v['--repo'] !== undefined && !/^[\w.-]+\/[\w.-]+$/.test(v['--repo'])) return { ok: false, error: '--repo must be <owner>/<name>' };
  const strategy = v['--strategy'] ?? 'merge';
  if (strategy !== 'merge' && strategy !== 'squash' && strategy !== 'rebase') return { ok: false, error: '--strategy must be merge, squash or rebase' };
  const secs = (flag: string, dflt: number): number | null => {
    if (v[flag] === undefined) return dflt;
    const n = Number(v[flag]);
    return v[flag].trim() !== '' && Number.isFinite(n) && n >= 0 ? n : null;
  };
  const timeout = secs('--timeout', 1800);
  const interval = secs('--interval', 20);
  const grace = secs('--no-checks-grace', 120);
  if (timeout === null || interval === null || interval < 1 || grace === null) return { ok: false, error: '--timeout/--interval/--no-checks-grace take non-negative seconds (--interval ≥ 1)' };
  return {
    ok: true,
    opts: {
      branch: v['--branch'],
      into: v['--into'],
      ticket: v['--ticket'],
      reviewVerdict: v['--review-verdict'],
      verifiedHead: v['--verified-head'],
      strategy,
      timeoutMs: timeout * 1000,
      intervalMs: interval * 1000,
      noChecksGraceMs: grace * 1000,
      suiteCmd: v['--suite-cmd'],
      repo: v['--repo'],
      requireChecks: required,
    },
  };
}

export interface DeliverResult {
  verdict: 'merged' | 'already-merged' | 'refused' | 'unchecked';
  reason?: RefuseReason | 'timeout' | 'gh-failed' | 'bad-verdict' | 'no-verified-head' | 'merge-failed';
  detail?: string;
  ticket: string;
  branch: string;
  into: string;
  pr?: number;
  url?: string;
  /** The head the merge was bound to (verified head). */
  head?: string;
  mergeCommit?: string;
  /** false ⇒ no `--review-verdict` was given: the merge was NOT gated by a review round. */
  reviewGated: boolean;
  /** Run this on the target after the merges (the verb never runs a repo suite). Present when the PR is on the target. */
  combinedSuite?: string;
}

export interface DeliverDeps {
  gh: GhRunner;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  readFile: (p: string) => string;
  /** Progress lines (stderr in production). */
  log: (s: string) => void;
}

export const realDeps = (): DeliverDeps => ({
  gh: realGh,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  now: () => Date.now(),
  readFile: (p) => fs.readFileSync(p, 'utf8'),
  log: (s) => process.stderr.write(`${s}\n`),
});

class GhError extends Error {}

export interface DeliverOutcome {
  exit: number;
  result: DeliverResult;
}

export async function deliver(opts: DeliverOpts, deps: DeliverDeps): Promise<DeliverOutcome> {
  const base = { ticket: opts.ticket, branch: opts.branch, into: opts.into };
  const done = (result: Omit<DeliverResult, 'ticket' | 'branch' | 'into' | 'reviewGated'>, reviewGated: boolean): DeliverOutcome => {
    const full: DeliverResult = { ...result, ...base, reviewGated };
    if (result.verdict === 'merged' || result.verdict === 'already-merged') full.combinedSuite = combinedSuiteCommand(opts.into, opts.suiteCmd);
    const exit = full.verdict === 'refused' ? DELIVER_EXIT.refused : full.verdict === 'unchecked' ? DELIVER_EXIT.unchecked : DELIVER_EXIT.merged;
    return { exit, result: full };
  };
  const repoArgs = opts.repo ? ['--repo', opts.repo] : [];
  const gh = async (args: string[]): Promise<GhResult> => deps.gh([...args, ...repoArgs]);
  const ghOk = async (args: string[]): Promise<string> => {
    const r = await gh(args);
    if (r.code !== 0) throw new GhError(`gh ${args.slice(0, 2).join(' ')} failed (exit ${r.code}): ${r.stderr.trim().slice(0, 400)}`);
    return r.stdout;
  };

  // 1. The verified head and the (optional) review verdict.
  let verdict: ReviewVerdict | undefined;
  if (opts.reviewVerdict) {
    let raw: string;
    try {
      raw = deps.readFile(opts.reviewVerdict);
    } catch (e) {
      return done({ verdict: 'unchecked', reason: 'bad-verdict', detail: `cannot read verdict file: ${(e as Error).message}` }, false);
    }
    const p = parseReviewVerdict(raw);
    if (!p.ok) return done({ verdict: 'unchecked', reason: 'bad-verdict', detail: p.error }, false);
    verdict = p.verdict;
  }
  const reviewGated = verdict !== undefined;
  const verifiedHead = opts.verifiedHead ?? verdict?.head;
  if (!verifiedHead) {
    return done({ verdict: 'unchecked', reason: 'no-verified-head', detail: 'give --verified-head <sha> or --review-verdict <file> (its "head"): the merge is bound to a head' }, reviewGated);
  }
  if (opts.verifiedHead && verdict && verdict.head !== opts.verifiedHead) {
    return done(
      { verdict: 'refused', reason: 'verdict-head-mismatch', detail: `--verified-head ${opts.verifiedHead.slice(0, 12)} != the verdict's head ${verdict.head.slice(0, 12)}`, head: opts.verifiedHead },
      reviewGated,
    );
  }

  try {
    // 2. Open or reuse the PR.
    const listed = JSON.parse(
      await ghOk(['pr', 'list', '--head', opts.branch, '--base', opts.into, '--state', 'all', '--json', 'number,url,state,headRefOid', '--limit', '10']),
    ) as { number: number; url: string; state: string; headRefOid?: string }[];
    // A MERGED PR is reused only when it was merged AT the verified head; a stale one from an earlier round must not shadow a new PR.
    let pr = listed.find((p) => p.state === 'OPEN') ?? listed.find((p) => p.state === 'MERGED' && p.headRefOid === verifiedHead);
    if (!pr) {
      const out = await ghOk([
        'pr', 'create', '--head', opts.branch, '--base', opts.into,
        '--title', `${opts.ticket}: ${opts.branch}`,
        '--body', `Ticket ${opts.ticket}. Delivered by \`orchestra fanout deliver\` (merge bound to head ${verifiedHead.slice(0, 12)}).`,
      ]);
      const url = out.trim().split('\n').pop() ?? '';
      const num = Number(/\/pull\/(\d+)\s*$/.exec(url)?.[1]);
      if (!Number.isInteger(num)) throw new GhError(`gh pr create printed no PR url: ${out.trim().slice(0, 200)}`);
      pr = { number: num, url, state: 'OPEN' };
      deps.log(`opened PR #${num} ${url}`);
    } else {
      deps.log(`reusing PR #${pr.number} (${pr.state}) ${pr.url}`);
    }
    const prId = String(pr.number);
    const prInfo = { pr: pr.number, url: pr.url };

    // 3. Wait → decide, until merge / refuse / timeout.
    const stepCache = new Map<string, number>(); // `${run}/${job}` → steps; only terminal (success) jobs are cached
    const t0 = deps.now();
    let prevNames: string | null = null;
    for (;;) {
      const view = JSON.parse(
        await ghOk(['pr', 'view', prId, '--json', 'state,baseRefName,headRefOid,mergeable,statusCheckRollup']),
      ) as PrSnapshot & { statusCheckRollup?: RollupItem[] };
      const rollup = view.statusCheckRollup ?? [];
      const stepsByUrl = new Map<string, number | null>();
      for (const it of rollup) {
        const url = it.detailsUrl ?? it.targetUrl;
        const job = parseActionsJobUrl(url);
        if (!url || !job || (it.conclusion ?? '').toUpperCase() !== 'SUCCESS' || stepsByUrl.has(url)) continue;
        const key = `${job.run}/${job.job ?? ''}`;
        let n = stepCache.get(key);
        if (n === undefined) {
          // Fail closed: an Actions job whose steps cannot be read is could-not-check, never "no steps to worry about".
          const jobs = JSON.parse(await ghOk(['run', 'view', job.run, '--json', 'jobs'])) as { jobs?: { databaseId?: number; steps?: { name?: string; conclusion?: string }[] }[] };
          const mine = (jobs.jobs ?? []).filter((j) => job.job === null || String(j.databaseId) === job.job);
          if (mine.length === 0) throw new GhError(`gh run view ${job.run}: job ${job.job} not found`);
          n = mine.reduce((a, j) => a + (j.steps ?? []).filter((s) => (s.conclusion ?? '').toLowerCase() === 'success' && isUserStep(s.name)).length, 0);
          stepCache.set(key, n);
        }
        stepsByUrl.set(url, n);
      }
      const checks: DeliverCheck[] = rollup.map((it) => normaliseRollupItem(it, (u) => (u && stepsByUrl.has(u) ? (stepsByUrl.get(u) as number | null) : null)));
      const names = JSON.stringify(checks.map((c) => c.name).sort());
      const stable = names === prevNames;
      prevNames = names;
      const d = decideDelivery({
        pr: view, checks, stable, requiredChecks: opts.requireChecks, into: opts.into, verifiedHead, verdict,
        waitedMs: deps.now() - t0, noChecksGraceMs: opts.noChecksGraceMs,
      });
      if (d.action === 'already-merged') return done({ verdict: 'already-merged', detail: 'the PR was already merged at the verified head (not re-gated by the review verdict or CI)', ...prInfo, head: view.headRefOid }, reviewGated);
      if (d.action === 'refuse') return done({ verdict: 'refused', reason: d.reason, detail: d.detail, ...prInfo, head: view.headRefOid }, reviewGated);
      if (d.action === 'merge') {
        // ONE call: the head is checked by GitHub inside the merge, so a push between decide and act makes it fail, not merge the wrong thing.
        const m = await gh(['pr', 'merge', prId, `--${opts.strategy}`, '--match-head-commit', d.head]);
        if (m.code !== 0) {
          if (classifyMergeFailure(m.stderr) === 'head-moved') {
            return done({ verdict: 'refused', reason: 'head-moved', detail: `the head moved during the merge call: ${m.stderr.trim().slice(0, 300)}`, ...prInfo, head: d.head }, reviewGated);
          }
          return done({ verdict: 'unchecked', reason: 'merge-failed', detail: `gh pr merge failed (exit ${m.code}): ${m.stderr.trim().slice(0, 400)}`, ...prInfo, head: d.head }, reviewGated);
        }
        // Read it back: exit 0 can mean "queued" (merge queue / auto-merge), which is not merged. Unknown state ⇒ could-not-check, never "merged".
        let after: { state?: string; mergeCommit?: { oid?: string } | null };
        try {
          after = JSON.parse(await ghOk(['pr', 'view', prId, '--json', 'state,mergeCommit']));
        } catch (e) {
          return done({ verdict: 'unchecked', reason: 'merge-failed', detail: `gh pr merge exited 0 but the PR state could not be read back: ${(e as Error).message}`, ...prInfo, head: d.head }, reviewGated);
        }
        if (after.state !== 'MERGED') {
          return done({ verdict: 'unchecked', reason: 'merge-failed', detail: `gh pr merge exited 0 but the PR is ${after.state ?? 'in an unknown state'} (merge queue / auto-merge?), not MERGED`, ...prInfo, head: d.head }, reviewGated);
        }
        const mergeCommit = after.mergeCommit?.oid ?? undefined;
        return done({ verdict: 'merged', ...prInfo, head: d.head, ...(mergeCommit ? { mergeCommit } : {}) }, reviewGated);
      }
      if (deps.now() - t0 + opts.intervalMs > opts.timeoutMs) {
        return done({ verdict: 'unchecked', reason: 'timeout', detail: `still waiting after ${Math.round((deps.now() - t0) / 1000)}s: ${d.why}`, ...prInfo }, reviewGated);
      }
      deps.log(`waiting: ${d.why}`);
      await deps.sleep(opts.intervalMs);
    }
  } catch (e) {
    return done({ verdict: 'unchecked', reason: 'gh-failed', detail: e instanceof Error ? e.message : String(e) }, reviewGated);
  }
}

/** `orchestra help fanout` text for the deliver half (appended to #469's FANOUT_USAGE in help.ts). */
export const DELIVER_HELP = `usage: orchestra fanout deliver --branch <b> --into <target> --ticket <id> [--review-verdict <file>] [--verified-head <sha>]
                                [--strategy merge|squash|rebase] [--timeout <s>] [--interval <s>] [--no-checks-grace <s>]
                                [--suite-cmd <cmd>] [--repo <owner/name>] [--require-check <name>]…

deliver: open or reuse the PR <branch> → <target>, wait for CI, then merge with
\`gh pr merge --match-head-commit <verified head>\` (check and merge are ONE call).
Refuses on: 0 checks, a passing check with 0 steps, red CI, BLOCKING/MAJOR > 0 in
the verdict file, a head that is not the verified head, a conflict, a --require-check
that is missing or skipped (name external CI with it: statuses alone are not green).
Prints ONE JSON line (verdict, reason, pr, head, combinedSuite = the command to run
on <target> after N merges). Verdict file: {"round":1,"blocking":0,"major":0,"minor":2,"head":"<40-hex>"}.
Exit codes: 0 = merged (or already merged at the verified head), 2 = refused,
            1 = could not check (usage, gh failed, timeout, unreadable verdict)`;

/** `orchestra fanout deliver <args>` — `args` is what follows `deliver`. The `fanout` case in index.ts routes here; #469's runFanout owns state/resume. */
export async function runDeliver(args: string[], deps: DeliverDeps = realDeps()): Promise<{ exit: number; stdout?: string; error?: string }> {
  const p = parseDeliverArgs(args);
  if (!p.ok) return { exit: 1, error: p.error };
  const { exit, result } = await deliver(p.opts, deps);
  return { exit, stdout: `${JSON.stringify(result)}\n` };
}
