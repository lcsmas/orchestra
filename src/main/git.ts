import { simpleGit } from 'simple-git';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { DiffFile, DiffStats } from '../shared/types';

const pexec = promisify(execFile);

/** Read the `origin` remote URL and normalize it to a browser-friendly form.
 * Handles the three forms git emits: scp-style (`git@host:owner/repo.git`),
 * `ssh://git@host/owner/repo.git`, and plain `https://host/owner/repo.git`.
 * Returns undefined for any URL we can't confidently rewrite to https — the
 * caller treats undefined as "no link in the UI". */
export async function detectRemoteUrl(repoPath: string): Promise<string | undefined> {
  const git = simpleGit(repoPath);
  let raw: string;
  try {
    raw = (await git.raw(['config', '--get', 'remote.origin.url'])).trim();
  } catch {
    return undefined;
  }
  if (!raw) return undefined;
  // scp-style: git@host:owner/repo(.git)
  const scp = raw.match(/^git@([^:]+):(.+?)(?:\.git)?$/);
  if (scp) return `https://${scp[1]}/${scp[2]}`;
  // ssh://git@host/owner/repo(.git) or ssh://host/owner/repo(.git)
  const ssh = raw.match(/^ssh:\/\/(?:[^@]+@)?([^/]+)\/(.+?)(?:\.git)?$/);
  if (ssh) return `https://${ssh[1]}/${ssh[2]}`;
  // https://host/owner/repo(.git) — drop the .git suffix if present
  const https = raw.match(/^(https?:\/\/[^/]+\/.+?)(?:\.git)?$/);
  if (https) return https[1];
  return undefined;
}

export async function detectDefaultBranch(repoPath: string): Promise<string> {
  const git = simpleGit(repoPath);
  try {
    const res = await git.raw(['symbolic-ref', 'refs/remotes/origin/HEAD']);
    return res.trim().replace('refs/remotes/origin/', '');
  } catch {
    // Fall through.
  }
  for (const b of ['main', 'master', 'develop']) {
    try {
      await git.revparse(['--verify', b]);
      return b;
    } catch {
      /* next */
    }
  }
  return 'main';
}

export async function isGitRepo(p: string): Promise<boolean> {
  try {
    const git = simpleGit(p);
    await git.revparse(['--is-inside-work-tree']);
    return true;
  } catch {
    return false;
  }
}

export async function listBranches(repoPath: string): Promise<string[]> {
  const git = simpleGit(repoPath);
  try {
    const res = await git.branchLocal();
    return res.all.slice().sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

export async function switchWorktreeBranch(
  worktreePath: string,
  branch: string,
): Promise<void> {
  const git = simpleGit(worktreePath);
  try {
    await git.raw(['switch', branch]);
  } catch (e) {
    const msg = (e as Error).message ?? '';
    // A branch can only be checked out in one worktree at a time. Translate
    // git's raw "already used by worktree at <path>" into something readable.
    if (/already used by worktree/i.test(msg)) {
      throw new Error(
        `Can't switch to '${branch}': it's already checked out in another worktree.`,
      );
    }
    throw e;
  }
}

/** Rename the branch checked out in `worktreePath`. The worktree directory
 * stays put — the dir is a stable container, the branch is just a property. */
export async function renameWorktreeBranch(
  worktreePath: string,
  oldBranch: string,
  newBranch: string,
): Promise<void> {
  if (oldBranch === newBranch) return;
  const wtGit = simpleGit(worktreePath);
  // `branch -m <old> <new>` works from any worktree of the repo.
  await wtGit.raw(['branch', '-m', oldBranch, newBranch]);
}

export async function createWorktree(
  repoPath: string,
  branch: string,
  baseBranch: string,
  worktreePath: string,
): Promise<void> {
  const git = simpleGit(repoPath);
  // Create branch from base, then worktree.
  const branches = await git.branchLocal();
  if (!branches.all.includes(branch)) {
    await git.raw(['branch', branch, baseBranch]);
  }
  await git.raw(['worktree', 'add', worktreePath, branch]);
}

/** Absolute paths of every worktree git currently tracks for `repoPath`,
 *  including the repo's own main worktree. Parsed from `git worktree list
 *  --porcelain` (one `worktree <path>` line per entry). Throws if the repo
 *  can't be read — callers treat that as "unknown, don't act". */
export async function listWorktreePaths(repoPath: string): Promise<string[]> {
  const git = simpleGit(repoPath);
  const out = await git.raw(['worktree', 'list', '--porcelain']);
  const paths: string[] = [];
  for (const line of out.split('\n')) {
    if (line.startsWith('worktree ')) paths.push(line.slice('worktree '.length).trim());
  }
  return paths;
}

export async function removeWorktree(repoPath: string, worktreePath: string): Promise<void> {
  const git = simpleGit(repoPath);
  try {
    await git.raw(['worktree', 'remove', '--force', worktreePath]);
  } catch {
    if (existsSync(worktreePath)) await rm(worktreePath, { recursive: true, force: true });
  }
}

export async function getDiff(worktreePath: string, _baseBranch: string): Promise<DiffFile[]> {
  const git = simpleGit(worktreePath);
  // Uncommitted-only diff: compare working tree + index against HEAD, plus
  // untracked files. Anything already committed to the branch does not appear.
  const workingStat = await safeRaw(git, ['diff', '--numstat', 'HEAD']);
  const untracked = await safeRaw(git, ['ls-files', '--others', '--exclude-standard']);

  const fileMap = new Map<string, DiffFile>();

  const parseNumstat = (raw: string) => {
    for (const line of raw.split('\n').filter(Boolean)) {
      const [addsStr, delsStr, file] = line.split('\t');
      if (!file) continue;
      const prev = fileMap.get(file);
      const additions = (prev?.additions ?? 0) + (addsStr === '-' ? 0 : Number(addsStr || 0));
      const deletions = (prev?.deletions ?? 0) + (delsStr === '-' ? 0 : Number(delsStr || 0));
      fileMap.set(file, {
        path: file,
        status: prev?.status ?? 'modified',
        additions,
        deletions,
        oldContent: '',
        newContent: '',
      });
    }
  };

  parseNumstat(workingStat);

  for (const f of untracked.split('\n').filter(Boolean)) {
    fileMap.set(f, {
      path: f,
      status: 'added',
      additions: 0,
      deletions: 0,
      oldContent: '',
      newContent: '',
    });
  }

  const out: DiffFile[] = [];
  for (const f of fileMap.values()) {
    const oldContent = await safeShow(git, `HEAD:${f.path}`);
    const newContent = await safeShow(git, `:${f.path}`); // index
    const workingContent = await readWorking(worktreePath, f.path);
    out.push({
      ...f,
      oldContent: truncate(oldContent),
      newContent: truncate(workingContent || newContent),
      status:
        oldContent && !workingContent && !newContent
          ? 'deleted'
          : !oldContent
            ? 'added'
            : 'modified',
    });
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

export async function getDiffStats(
  worktreePath: string,
  _baseBranch: string,
): Promise<DiffStats> {
  const git = simpleGit(worktreePath);
  const working = await safeRaw(git, ['diff', '--numstat', 'HEAD']);
  const untracked = await safeRaw(git, ['ls-files', '--others', '--exclude-standard']);

  const files = new Set<string>();
  let additions = 0;
  let deletions = 0;

  const parse = (raw: string) => {
    for (const line of raw.split('\n').filter(Boolean)) {
      const [addsStr, delsStr, file] = line.split('\t');
      if (!file) continue;
      files.add(file);
      additions += addsStr === '-' ? 0 : Number(addsStr || 0);
      deletions += delsStr === '-' ? 0 : Number(delsStr || 0);
    }
  };
  parse(working);
  for (const f of untracked.split('\n').filter(Boolean)) files.add(f);

  return { additions, deletions, files: files.size };
}

async function safeRaw(git: ReturnType<typeof simpleGit>, args: string[]): Promise<string> {
  try {
    return await git.raw(args);
  } catch {
    return '';
  }
}

async function safeShow(git: ReturnType<typeof simpleGit>, ref: string): Promise<string> {
  try {
    return await git.raw(['show', ref]);
  } catch {
    return '';
  }
}

async function readWorking(worktreePath: string, file: string): Promise<string> {
  try {
    const { readFile } = await import('node:fs/promises');
    return await readFile(path.join(worktreePath, file), 'utf8');
  } catch {
    return '';
  }
}

function truncate(s: string, max = 300_000): string {
  if (s.length > max) return s.slice(0, max) + '\n\n... (truncated by Orchestra) ...\n';
  return s;
}

/** Snapshot of how `branch` relates to `baseBranch`:
 *  - `merged`: branch was folded into base via a merge commit that takes the
 *    branch tip as a non-first parent. This excludes the lookalike case where
 *    a branch was created from an older commit on base and never advanced —
 *    that branch's tip sits on base's first-parent chain, satisfies "fully
 *    reachable from base", but no real merge ever happened.
 *  - `diverged`: branch has commits not reachable from base → unshipped work.
 *  - `unpushedAhead`: count of local commits not yet on the remote. If
 *    `origin/<branch>` exists, this is `origin/<branch>..<branch>`. If the
 *    branch was never pushed, every local commit ahead of base counts as
 *    unpushed (`baseBranch..branch`) so the renderer can still surface the
 *    "ready to push" signal on a virgin branch.
 *
 *  `merged` and `diverged` are mutually exclusive. A fast-forward or rebase
 *  merge leaves no merge commit, so topology alone can't tell it apart from
 *  "branched and never advanced" (both leave the branch tip reachable from
 *  base with no merge commit) — and when the fast-forward lands base exactly
 *  on the branch tip, it's also indistinguishable from a freshly-created
 *  workspace whose branch still equals base. To resolve that ambiguity we
 *  consult base's reflog: `git merge <branch>` (including the fast-forward
 *  Orchestra's own Merge button performs) writes a `merge <branch>:` entry
 *  to the base ref, which is the one durable record that the merge happened.
 *  Reflog entries expire (~90 days), after which such a branch falls back to
 *  `stalePointer` — acceptable, since merged workspaces are archived long
 *  before then. */
export async function getBranchMergeState(
  repoPath: string,
  branch: string,
  baseBranch: string,
): Promise<{
  merged: boolean;
  diverged: boolean;
  unpushedAhead: number;
  /** True when the branch tip is just a stale pointer at an older commit on
   *  base — branch is fully reachable from base, refs differ, but no merge
   *  commit folded it in. Used by callers to clear any stale `mergedAt`
   *  written by earlier buggy detection. */
  stalePointer: boolean;
}> {
  try {
    const git = simpleGit(repoPath);
    const unpushedAhead = await computeUnpushedAhead(git, branch, baseBranch);
    const aheadStr = (await git.raw(['rev-list', '--count', `${baseBranch}..${branch}`])).trim();
    const ahead = Number(aheadStr) || 0;
    if (ahead > 0) return { merged: false, diverged: true, unpushedAhead, stalePointer: false };
    // Branch is fully contained in base (nothing ahead) — so any work it did is
    // now reachable from base. The question is whether that's because the branch
    // was *merged*, or because the tip is a stale pointer at an old base commit
    // the branch was cut from and never advanced past. Three positive signals,
    // any of which proves a merge:
    //
    //  1. A real merge commit on base's mainline folded the tip in
    //     (`branchTipWasMergedInto`). Only possible when refs differ.
    //  2. base's reflog records a `merge <branch>` — the durable trace a
    //     fast-forward / rebase merge via the Merge button leaves behind.
    //  3. The branch authored the commit it points at (`branchAuthoredItsTip`):
    //     its own reflog shows a `commit`/`rebase`/`cherry-pick`/… entry, not
    //     just a `branch: Created from …`. Since the tip is fully contained in
    //     base, work the branch authored now living on base *is* a merge — by
    //     fast-forward, `update-ref`, or `push base:base`, none of which leave a
    //     `merge` reflog subject. This is the one signal that survives base
    //     advancing PAST the merged tip (the bug this replaces only checked it
    //     when `branchSha === baseSha`, so a branch lost its merged badge the
    //     moment one more commit landed on base) AND still rejects the
    //     stale-pointer case, whose reflog shows only its creation entry.
    const [branchSha, baseSha] = await Promise.all([
      git.raw(['rev-parse', branch]).then((s) => s.trim()),
      git.raw(['rev-parse', baseBranch]).then((s) => s.trim()),
    ]);
    const merged =
      (branchSha !== baseSha && (await branchTipWasMergedInto(git, branchSha, baseSha))) ||
      (await baseReflogRecordsMerge(git, baseBranch, branch)) ||
      (await branchAuthoredItsTip(git, branch));
    // Not merged + refs differ → the tip is a stale old commit on base's
    // history; clears any false-positive `mergedAt`. Not merged + equal refs →
    // a fresh branch still pointing at base, nothing to clear.
    return { merged, diverged: false, unpushedAhead, stalePointer: !merged && branchSha !== baseSha };
  } catch {
    return { merged: false, diverged: false, unpushedAhead: 0, stalePointer: false };
  }
}

/** True when base's reflog records a `git merge <branch>` — the durable trace
 *  a fast-forward or rebase merge leaves behind when no merge commit exists.
 *  Matches the reflog subject exactly (`merge <branch>:`) so a branch named
 *  `feat` doesn't match a `merge feature:` entry. Also matches a fast-forward
 *  merged by the branch tip's SHA (`merge <sha>:`) — git abbreviates the SHA in
 *  the subject, so a target token of >= 7 chars that prefixes the full tip SHA
 *  counts. Only meaningful for a branch already known to be fully contained in
 *  base; the caller guarantees that. */
async function baseReflogRecordsMerge(
  git: ReturnType<typeof simpleGit>,
  baseBranch: string,
  branch: string,
): Promise<boolean> {
  try {
    const out = await git.raw(['reflog', 'show', baseBranch, '--format=%gs']);
    const fullSha = (await git.raw(['rev-parse', branch])).trim();
    return out.split('\n').some((line) => {
      const m = line.trim().match(/^merge (\S+):/);
      if (!m) return false;
      const token = m[1];
      return token === branch || (token.length >= 7 && fullSha.startsWith(token));
    });
  } catch {
    return false;
  }
}

/** True when this branch authored the commit it currently points at — i.e. its
 *  reflog shows the tip arrived via a `commit`/`merge`/`rebase`/`cherry-pick` ON
 *  this branch, not solely a `branch:`/`Branch:` creation entry. This is the
 *  disambiguator for any branch fully contained in base (nothing ahead) that has
 *  no merge commit and no `merge <branch>` reflog trace: a branch that did work
 *  base then fast-forwarded/`update-ref`'d in looks, by topology, identical to a
 *  branch freshly cut from base — but their reflogs differ. A fresh branch's
 *  newest entry is its creation; a branch that committed has `commit:`-style
 *  entries above it. Works whether or not the branch tip still equals base's tip,
 *  so a merged branch keeps reading as merged after base advances past it.
 *
 *  Reads the reflog subjects (`%gs`) newest-first and asks whether any entry is
 *  a work-producing action rather than a branch create/reset/checkout. Robust to
 *  base being advanced by `update-ref`/`push` (which leave no trace on the
 *  branch side) because we look at what the BRANCH did, not how base moved. */
async function branchAuthoredItsTip(
  git: ReturnType<typeof simpleGit>,
  branch: string,
): Promise<boolean> {
  try {
    const out = await git.raw(['reflog', 'show', branch, '--format=%gs']);
    return out
      .split('\n')
      .map((s) => s.trim())
      .some((subject) => /^(commit|merge|rebase|cherry-pick|am|pull)\b/i.test(subject));
  } catch {
    return false;
  }
}

/** Did `branch` author the commit it currently points at — i.e. is its tip the
 *  product of work done on this branch, not merely the commit it was cut from?
 *  Wraps {@link branchAuthoredItsTip} for callers outside this module (e.g. the
 *  release-badge detector, which uses it to avoid lighting up a fresh branch
 *  whose base-point happens to already sit inside a shipped release). */
export async function didBranchAuthorItsTip(repoPath: string, branch: string): Promise<boolean> {
  return branchAuthoredItsTip(simpleGit(repoPath), branch);
}

/** True when a merge commit on base's *first-parent mainline* has `branchSha`
 *  as a non-first parent — i.e., base actually absorbed the branch.
 *
 *  The `--first-parent` restriction is the whole point: it scans only the
 *  merges that landed *on* base (where base's prior tip is parent 1 and the
 *  merged-in branch is parent 2+), and ignores merges in the opposite
 *  direction — a feature branch running `git merge <base>` to sync makes base's
 *  then-tip a *second* parent of an off-mainline merge. Without `--first-parent`
 *  that sync-merge made any branch whose tip happened to be a base commit look
 *  "merged" the moment some unrelated feature pulled base in and later landed
 *  (the classic stale-pointer false positive). Bounded to commits since
 *  branchSha so the scan is proportional to base's progress, not its history. */
async function branchTipWasMergedInto(
  git: ReturnType<typeof simpleGit>,
  branchSha: string,
  baseSha: string,
): Promise<boolean> {
  try {
    const out = await git.raw([
      'rev-list',
      '--first-parent',
      '--merges',
      '--parents',
      `${branchSha}..${baseSha}`,
    ]);
    for (const line of out.split('\n')) {
      const parts = line.trim().split(/\s+/);
      // parts[0] = commit, parts[1] = first parent, parts[2..] = merge parents.
      // A non-first-parent match means this mainline merge folded branchSha in.
      for (let i = 2; i < parts.length; i++) {
        if (parts[i] === branchSha) return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

async function computeUnpushedAhead(
  git: ReturnType<typeof simpleGit>,
  branch: string,
  baseBranch: string,
): Promise<number> {
  const remoteRef = `origin/${branch}`;
  try {
    await git.raw(['rev-parse', '--verify', remoteRef]);
    const out = (
      await git.raw(['rev-list', '--count', `${remoteRef}..${branch}`])
    ).trim();
    return Number(out) || 0;
  } catch {
    // No remote tracking ref → branch has never been pushed. Treat every
    // commit ahead of base as unpushed so the user still gets the signal.
    try {
      const out = (
        await git.raw(['rev-list', '--count', `${baseBranch}..${branch}`])
      ).trim();
      return Number(out) || 0;
    } catch {
      return 0;
    }
  }
}

export async function findPullRequest(
  repoPath: string,
  branch: string,
): Promise<import('../shared/types').PRsForBranch> {
  try {
    // Run from `repoPath` (the canonical repo), NOT the workspace's worktree.
    // `gh pr list --head` only needs to resolve the repo's remote — it doesn't
    // need the branch checked out — and the worktree can be missing/broken
    // (e.g. removed out-of-band), in which case `gh` would bail with "not a git
    // repository" and we'd silently report zero PRs. The main repo is always a
    // valid git dir, so PR state stays visible even for a stale worktree.
    const { stdout } = await pexec(
      'gh',
      [
        'pr',
        'list',
        '--head',
        branch,
        '--state',
        'all',
        '--json',
        'url,number,state,title',
        '--limit',
        '50',
      ],
      { cwd: repoPath },
    );
    const all = JSON.parse(stdout.trim() || '[]') as Array<{
      url: string;
      number: number;
      state: 'OPEN' | 'CLOSED' | 'MERGED';
      title: string;
    }>;
    // gh returns newest-first.
    const open = all.find((p) => p.state === 'OPEN') ?? null;
    const latest = all[0] ?? null;
    const mergedCount = all.filter((p) => p.state === 'MERGED').length;
    return { all, open, latest, mergedCount };
  } catch {
    return { all: [], open: null, latest: null, mergedCount: 0 };
  }
}

interface ReleaseRef {
  tag: string;
  /** Commit the tag resolves to locally (peeled through annotated tags). */
  sha: string;
  /** Epoch ms of the GitHub `publishedAt`, or 0 if unparseable. */
  publishedAt: number;
}

/** Per-repo cache of resolved published releases. A repo's release list is
 *  identical for every workspace that shares it, so we fetch once and reuse
 *  for a short TTL rather than firing one `gh` call per workspace each poll. */
const releaseCache = new Map<string, { at: number; releases: ReleaseRef[] }>();
const RELEASE_CACHE_TTL = 30_000;

/** Published (non-draft, non-prerelease) GitHub releases for the repo, each
 *  resolved to the local commit its tag points at. Releases whose tag isn't
 *  present locally are dropped — without the commit we can't prove ancestry,
 *  and Orchestra's own release flow creates tags locally before pushing, so
 *  they're normally present. Cached per repo for `RELEASE_CACHE_TTL`. */
async function getPublishedReleases(repoPath: string): Promise<ReleaseRef[]> {
  const cached = releaseCache.get(repoPath);
  if (cached && Date.now() - cached.at < RELEASE_CACHE_TTL) return cached.releases;
  let releases: ReleaseRef[] = [];
  try {
    const { stdout } = await pexec(
      'gh',
      ['release', 'list', '--json', 'tagName,isDraft,isPrerelease,publishedAt', '--limit', '50'],
      { cwd: repoPath },
    );
    const raw = JSON.parse(stdout.trim() || '[]') as Array<{
      tagName: string;
      isDraft: boolean;
      isPrerelease: boolean;
      publishedAt: string;
    }>;
    const git = simpleGit(repoPath);
    const resolved = await Promise.all(
      raw
        .filter((r) => !r.isDraft && !r.isPrerelease)
        .map(async (r): Promise<ReleaseRef | null> => {
          try {
            const sha = (await git.raw(['rev-parse', `${r.tagName}^{commit}`])).trim();
            return { tag: r.tagName, sha, publishedAt: Date.parse(r.publishedAt) || 0 };
          } catch {
            return null; // tag not present locally → can't confirm ancestry
          }
        }),
    );
    releases = resolved.filter((r): r is ReleaseRef => r !== null);
  } catch {
    releases = []; // gh missing, not authed, no remote, etc.
  }
  releaseCache.set(repoPath, { at: Date.now(), releases });
  return releases;
}

/** True when `ancestor` is an ancestor of (or equal to) `descendant`.
 *  `git merge-base --is-ancestor` exits 0 for yes, 1 for no; execFile rejects
 *  on any non-zero exit, so any throw is treated as "no". */
async function isAncestor(
  repoPath: string,
  ancestor: string,
  descendant: string,
): Promise<boolean> {
  try {
    await pexec('git', ['merge-base', '--is-ancestor', ancestor, descendant], { cwd: repoPath });
    return true;
  } catch {
    return false;
  }
}

/** Cheap, network-free check: is the branch tip already contained in the build
 *  of `tag` (i.e. the tip is an ancestor of the tag commit)? Lets callers decide
 *  whether a previously-recorded `releasedVersion` is still accurate before
 *  paying for the gh-backed `getReleaseState` recompute. Returns true on any
 *  error (tag missing locally, transient git failure) so we never thrash or
 *  drop a known-good version over a flaky read. */
export async function branchTipShippedIn(
  repoPath: string,
  branch: string,
  tag: string,
): Promise<boolean> {
  try {
    const git = simpleGit(repoPath);
    const branchSha = (await git.raw(['rev-parse', branch])).trim();
    const tagSha = (await git.raw(['rev-parse', `${tag}^{commit}`])).trim();
    return await isAncestor(repoPath, branchSha, tagSha);
  } catch {
    return true;
  }
}

/** Whether this branch's work has shipped: a published GitHub Release whose
 *  build contains the branch tip (the tag commit has the tip as an ancestor —
 *  the exact proxy for "the AppImage was built with this branch's commits").
 *  Returns the EARLIEST such release so the version label reflects when the
 *  work first shipped, not the latest release that happens to also contain it. */
export async function getReleaseState(
  repoPath: string,
  branch: string,
): Promise<{ released: boolean; version?: string; releasedAt?: number }> {
  try {
    const releases = await getPublishedReleases(repoPath);
    if (releases.length === 0) return { released: false };
    const git = simpleGit(repoPath);
    const branchSha = (await git.raw(['rev-parse', branch])).trim();
    // Oldest-first so the first match is the release that first shipped the tip.
    const ordered = [...releases].sort((a, b) => a.publishedAt - b.publishedAt);
    for (const rel of ordered) {
      if (await isAncestor(repoPath, branchSha, rel.sha)) {
        return { released: true, version: rel.tag, releasedAt: rel.publishedAt || undefined };
      }
    }
    return { released: false };
  } catch {
    return { released: false };
  }
}

/** Every published release whose build contains the branch tip, oldest-first.
 *  Where `getReleaseState` returns only the FIRST shipping release (the "when
 *  did this first ship" signal), this returns ALL of them so the UI can show a
 *  badge per version the workspace's work is part of (v0.2.0, v0.2.1, …).
 *  `releasedAt` mirrors the earliest release's publish time, so the two helpers
 *  agree on the "shipped at" timestamp. Empty list ⇒ not yet released. */
export async function getReleaseVersionsContaining(
  repoPath: string,
  branch: string,
  _baseBranch?: string,
): Promise<{ versions: string[]; releasedAt?: number }> {
  try {
    const releases = await getPublishedReleases(repoPath);
    if (releases.length === 0) return { versions: [] };
    const git = simpleGit(repoPath);
    const branchSha = (await git.raw(['rev-parse', branch])).trim();

    // Credit the branch for a release iff one of the commits that FIRST SHIPPED
    // in that release is part of the branch's history. The commits a release
    // first introduced are `prevTag..thisTag` — i.e. what landed between the
    // previous published release and this one. A branch "is part of" such a
    // commit when the commit is an ancestor of the branch tip.
    //
    // Why per-release ranges rather than "tip reachable from tag" (the old
    // approach): a tag's commit is reachable from EVERY later release too, so
    // the old test lit up a branch for its shipping release AND all subsequent
    // ones. Ranges pin each branch to exactly the release(s) its own work first
    // went out in — robust-workspace-status authored the v0.3.4 bump, so it gets
    // v0.3.4 only, never the later v0.3.5 it had no commit in.
    //
    // This intentionally ignores the stale branch *pointer* (a merged branch
    // whose ref still sits at an old commit while base advanced): we walk the
    // tag→tag ranges in true history, not `base..branch`, so a fully-merged
    // branch keeps the badge for what it shipped. The fresh-branch false
    // positive (a branch cut from an old release commit it never authored) is
    // filtered by the caller's `didBranchAuthorItsTip` reflog guard, not here.
    const ordered = [...releases].sort((a, b) => a.publishedAt - b.publishedAt);
    const versions: string[] = [];
    let releasedAt: number | undefined;
    let prevSha: string | null = null;
    for (const rel of ordered) {
      let credit: boolean;
      if (prevSha === null) {
        // Earliest release we can see: its predecessor is off the edge of the
        // fetched list, so `..thisTag` would be the tag's whole ancestry and
        // would credit EVERY branch built on top of it. We can't tell which of
        // those commits this release first introduced, so credit the branch
        // only when its tip IS exactly this release point.
        credit = branchSha === rel.sha;
      } else {
        // Commits this release first introduced: prevTag..thisTag. Credit the
        // branch iff one of them is in its history (ancestor of the tip).
        credit = await branchTipReachesAnyIn(git, `${prevSha}..${rel.sha}`, branchSha);
      }
      if (credit) {
        versions.push(rel.tag);
        if (releasedAt === undefined) releasedAt = rel.publishedAt || undefined;
      }
      prevSha = rel.sha;
    }
    return { versions, releasedAt };
  } catch {
    return { versions: [] };
  }
}

/** True when at least one commit in `range` is an ancestor of `branchSha`.
 *  Single `rev-list`: the commits in `range` that are also reachable from the
 *  branch tip (`<range> <branchSha>` would over-list, so we intersect by asking
 *  for `range` commits NOT excluded by `^branchSha`'s complement). We list the
 *  range and stop at the first one the branch contains. */
async function branchTipReachesAnyIn(
  git: ReturnType<typeof simpleGit>,
  range: string,
  branchSha: string,
): Promise<boolean> {
  try {
    // `rev-list <range> ^<branchSha>` = range commits the branch does NOT have.
    // If that's fewer than the full range, the branch contains the difference,
    // so it shares at least one commit the release first shipped.
    const fullOut = (await git.raw(['rev-list', range])).trim();
    const full = fullOut ? fullOut.split('\n').filter(Boolean).length : 0;
    if (full === 0) return false;
    const notInBranchOut = (await git.raw(['rev-list', range, `^${branchSha}`])).trim();
    const notInBranch = notInBranchOut ? notInBranchOut.split('\n').filter(Boolean).length : 0;
    return notInBranch < full;
  } catch {
    return false;
  }
}

/** Snapshot of how local `<baseBranch>` relates to `origin/<baseBranch>`,
 *  computed without any network access. The caller is responsible for
 *  running a fetch first when freshness is needed. Returns `hasUpstream:
 *  false` when no `origin/<baseBranch>` ref exists (repo not fetched yet,
 *  or remote doesn't have that branch). */
export async function getBaseSyncState(
  repoPath: string,
  baseBranch: string,
): Promise<{ behind: number; ahead: number; hasUpstream: boolean }> {
  try {
    const git = simpleGit(repoPath);
    try {
      await git.raw(['rev-parse', '--verify', `refs/remotes/origin/${baseBranch}`]);
    } catch {
      return { behind: 0, ahead: 0, hasUpstream: false };
    }
    const [behindStr, aheadStr] = await Promise.all([
      git.raw(['rev-list', '--count', `${baseBranch}..origin/${baseBranch}`]),
      git.raw(['rev-list', '--count', `origin/${baseBranch}..${baseBranch}`]),
    ]);
    return {
      behind: Number(behindStr.trim()) || 0,
      ahead: Number(aheadStr.trim()) || 0,
      hasUpstream: true,
    };
  } catch {
    return { behind: 0, ahead: 0, hasUpstream: false };
  }
}

/** Env block applied to every fetch/pull this module runs. The renderer has
 *  no UI to answer credential prompts, so any auth-requiring fetch must
 *  fail fast instead of hanging on `gnome-ssh-askpass` or git's terminal
 *  prompt. We also override the credential helper chain for github.com to
 *  delegate to `gh auth git-credential`, which serves the user's gh CLI
 *  token from the OS keyring — that's typically the only credential source
 *  guaranteed to work in a desktop app's non-interactive context. The
 *  GIT_CONFIG_COUNT/KEY/VALUE form lets us inject git config without
 *  touching `~/.gitconfig`. The empty-value entry first clears the
 *  inherited helper chain (e.g. a broken `store`), then `gh` becomes the
 *  only helper for github.com URLs. Non-github remotes are unaffected. */
const NON_INTERACTIVE_GIT_ENV = {
  ...process.env,
  GIT_TERMINAL_PROMPT: '0',
  GIT_ASKPASS: '/bin/echo',
  SSH_ASKPASS: '/bin/echo',
  SSH_ASKPASS_REQUIRE: 'never',
  GIT_CONFIG_COUNT: '2',
  GIT_CONFIG_KEY_0: 'credential.https://github.com.helper',
  GIT_CONFIG_VALUE_0: '',
  GIT_CONFIG_KEY_1: 'credential.https://github.com.helper',
  GIT_CONFIG_VALUE_1: '!gh auth git-credential',
} as NodeJS.ProcessEnv;

/** The branch currently checked out in `worktreePath`. Returns '' when HEAD is
 *  detached (`rev-parse --abbrev-ref` yields the literal "HEAD" mid-rebase /
 *  -bisect / detached checkout) or the call fails — callers treat '' as "no
 *  branch to track, leave the stored name alone". */
export async function getCurrentBranch(worktreePath: string): Promise<string> {
  try {
    const head = (await runGit(worktreePath, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
    return head === 'HEAD' ? '' : head;
  } catch {
    return '';
  }
}

async function runGit(repoPath: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await pexec('git', args, {
      cwd: repoPath,
      env: NON_INTERACTIVE_GIT_ENV,
    });
    return stdout;
  } catch (e) {
    // execFile errors swallow stderr behind a generic "Command failed"
    // message; surface the first stderr line so callers can show why.
    const err = e as { stderr?: string; message?: string };
    const detail = (err.stderr ?? '').trim().split('\n').filter(Boolean).pop();
    if (detail) throw new Error(detail);
    throw e;
  }
}

/** Bring `<baseBranch>` in sync with `origin/<baseBranch>` for the repo at
 *  `repoPath`. Strategy cascade (chosen because the base branch may or may
 *  not be checked out in a worktree):
 *
 *   1. `git fetch origin <base>:<base>` — atomic, updates both the local
 *      ref and the remote-tracking ref. Fails when `<base>` is checked out
 *      in any worktree.
 *   2. If `<base>` is checked out in `repoPath` itself: `git pull --ff-only
 *      origin <base>`. Safe with a dirty tree (ff-only refuses to clobber).
 *   3. Otherwise: `git fetch origin <base>` — updates only the remote ref,
 *      leaves local untouched. The base may be checked out in a worktree
 *      we don't manage; touching it from here would be a surprise.
 *
 *  Returns `localUpdated: true` only when the local `<base>` ref advanced. */
export async function syncBaseBranch(
  repoPath: string,
  baseBranch: string,
): Promise<{ localUpdated: boolean }> {
  try {
    await runGit(repoPath, ['fetch', 'origin', `${baseBranch}:${baseBranch}`]);
    return { localUpdated: true };
  } catch {
    /* base is checked out somewhere — try strategy 2 */
  }
  try {
    const head = (await runGit(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
    if (head === baseBranch) {
      await runGit(repoPath, ['pull', '--ff-only', 'origin', baseBranch]);
      return { localUpdated: true };
    }
  } catch {
    /* dirty tree or non-ff — fall through to remote-only fetch */
  }
  await runGit(repoPath, ['fetch', 'origin', baseBranch]);
  return { localUpdated: false };
}
