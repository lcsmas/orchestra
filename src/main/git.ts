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
    // Branch is fully contained in base. It was merged if either a real merge
    // commit folded the tip in, or base's reflog records a `merge <branch>`
    // (the fast-forward / rebase case, which leaves no merge commit). The
    // reflog check also disambiguates `branchSha === baseSha`: a fresh
    // workspace has no such entry, a fast-forward-merged branch does.
    const [branchSha, baseSha] = await Promise.all([
      git.raw(['rev-parse', branch]).then((s) => s.trim()),
      git.raw(['rev-parse', baseBranch]).then((s) => s.trim()),
    ]);
    const mergedViaCommit =
      branchSha !== baseSha && (await branchTipWasMergedInto(git, branchSha, baseSha));
    const merged = mergedViaCommit || (await baseReflogRecordsMerge(git, baseBranch, branch));
    // Differing refs with no detectable merge means the tip is a stale old
    // commit on base; equal refs with no merge is a fresh/never-merged branch.
    return { merged, diverged: false, unpushedAhead, stalePointer: !merged && branchSha !== baseSha };
  } catch {
    return { merged: false, diverged: false, unpushedAhead: 0, stalePointer: false };
  }
}

/** True when base's reflog records a `git merge <branch>` — the durable trace
 *  a fast-forward or rebase merge leaves behind when no merge commit exists.
 *  Matches the reflog subject exactly (`merge <branch>:`) so a branch named
 *  `feat` doesn't match a `merge feature:` entry. Only meaningful for a branch
 *  already known to be fully contained in base; the caller guarantees that. */
async function baseReflogRecordsMerge(
  git: ReturnType<typeof simpleGit>,
  baseBranch: string,
  branch: string,
): Promise<boolean> {
  try {
    const out = await git.raw(['reflog', 'show', baseBranch, '--format=%gs']);
    const needle = `merge ${branch}:`;
    return out.split('\n').some((line) => line.trim().startsWith(needle));
  } catch {
    return false;
  }
}

/** True when some commit reachable from `baseSha` has `branchSha` as a
 *  non-first parent — i.e., a merge commit folded the branch into base.
 *  Walks `branchSha..baseSha` with `--ancestry-path` so the scan is bounded
 *  by the work done since branchSha, not base's full history. */
async function branchTipWasMergedInto(
  git: ReturnType<typeof simpleGit>,
  branchSha: string,
  baseSha: string,
): Promise<boolean> {
  try {
    const out = await git.raw([
      'rev-list',
      '--parents',
      '--ancestry-path',
      `${branchSha}..${baseSha}`,
    ]);
    for (const line of out.split('\n')) {
      const parts = line.trim().split(/\s+/);
      // parts[0] = commit, parts[1] = first parent, parts[2..] = merge parents.
      // A non-first-parent match means a merge commit pulled branchSha in.
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
