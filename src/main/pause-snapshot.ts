// Pause snapshot (#252 D1b, ADR 0003): capture a member's worktree — tracked
// edits, staged work AND untracked files — as a commit under
// `refs/orchestra/pause/<run>/<ws>/<ts>`, WITHOUT touching the worktree, the real
// index, HEAD or any branch (LEAD ruling D4). Only the object DB and that one new
// ref change. Dependency-free (node + git) so `node --test` drives it on real repos.
//
// HOW: a TEMPORARY index (`GIT_INDEX_FILE`) seeded from a copy of the real one, then
// `git add -A` into it, `write-tree`, `commit-tree -p HEAD`, `update-ref`. No command
// below reads-then-rewrites the real index (`git status` would: it opportunistically
// refreshes `.git/index`), and every git call runs with GIT_OPTIONAL_LOCKS=0.

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Untracked files above this are NOT committed into the ref (listed instead). */
export const SNAPSHOT_MAX_UNTRACKED_BYTES = 25 * 1024 * 1024;
/** ALL untracked (non-ignored) files together above this: the largest are left out (listed, reason `total-cap`) until the rest fits — a pause must not write tens of GB. */
export const SNAPSHOT_MAX_TOTAL_UNTRACKED_BYTES = 1024 * 1024 * 1024;
const GIT_TIMEOUT_MS = 120_000;
/** Excludes passed as argv up to this many; more go through `--pathspec-from-file` (no argv limit, no silent truncation — round-2 F8). */
const MAX_ARGV_EXCLUDES = 50;

export interface SnapshotInput {
  worktreePath: string;
  runId: string;
  wsId: string;
  /** Epoch ms stamped into the ref name. */
  at: number;
  /** Size caps (defaults: {@link SNAPSHOT_MAX_UNTRACKED_BYTES} per file, {@link SNAPSHOT_MAX_TOTAL_UNTRACKED_BYTES} in total). Tests shrink them. */
  limits?: { perFileBytes?: number; totalBytes?: number };
  /** Force the argv-only pathspec (what git < 2.25 gets): excludes beyond 200 are NOT applied and are reported in `warnings`. */
  legacyPathspec?: boolean;
}

export interface SnapshotResult {
  ref: string;
  commit: string;
  tree: string;
  /** HEAD at snapshot time (null on an unborn branch). */
  head: string | null;
  branch: string | null;
  /** The snapshot tree differs from HEAD's tree (any uncommitted/untracked work). */
  dirty: boolean;
  changed: { modified: number; added: number; deleted: number };
  /** Untracked files left out for size (path + bytes): `file-cap` = over the per-file cap, `total-cap` = the largest dropped to fit the total cap. */
  skippedLarge: Array<{ path: string; bytes: number; reason?: 'file-cap' | 'total-cap' }>;
  /** Files `git add` could not read (permissions, vanished mid-add): everything else IS in the ref; these are not. */
  warnings: string[];
  /** Gitlinks (submodules) whose own worktree was snapshotted too (path → ref), or failed. */
  submodules: Array<{ path: string; ref: string | null; dirty: boolean; error?: string }>;
}

interface GitOut {
  stdout: Buffer;
  stderr: string;
}

function git(cwd: string, args: string[], env: NodeJS.ProcessEnv = {}, input?: string, okCodes: number[] = []): Promise<GitOut> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      'git',
      // gc.auto=0: no background gc from a snapshot; fsmonitor=false: no hook on the user's repo.
      // hooksPath=/dev/null: the user's repo hooks (post-index-change, reference-transaction, …) must never run for a snapshot (review F6).
      ['-c', 'gc.auto=0', '-c', 'core.fsmonitor=false', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args],
      {
        cwd,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', ...env },
        encoding: 'buffer',
        maxBuffer: 256 * 1024 * 1024,
        timeout: GIT_TIMEOUT_MS,
      },
      (err, stdout, stderr) => {
        const errText = stderr?.toString('utf8') ?? '';
        if (err && !okCodes.includes(Number((err as { code?: unknown }).code))) {
          const e = err as Error & { stderr?: Buffer };
          reject(new Error(`git ${args[0]} failed: ${(errText || e.message).trim().slice(0, 400)}`));
        } else resolve({ stdout: stdout as unknown as Buffer, stderr: errText });
      },
    );
    if (input !== undefined) child.stdin?.end(input);
  });
}

const text = (o: GitOut): string => o.stdout.toString('utf8').trim();

/** A ref path component safe for any git version: [A-Za-z0-9._-], no `..`, no `.lock` tail. */
export function refSegment(s: string): string {
  let out = s.replace(/[^A-Za-z0-9._-]/g, '_').replace(/\.{2,}/g, '_').replace(/^\.+/, '_');
  if (out === '' ) out = '_';
  if (out.endsWith('.lock')) out = `${out.slice(0, -5)}_lock`;
  return out;
}

export function pauseRefName(runId: string, wsId: string, at: number): string {
  return `refs/orchestra/pause/${refSegment(runId)}/${refSegment(wsId)}/${at}`;
}

async function makeTempIndexPath(gitDir: string): Promise<{ file: string; cleanup: () => void }> {
  const tryDirs = [os.tmpdir(), gitDir];
  let lastErr: unknown;
  for (const base of tryDirs) {
    try {
      const dir = fs.mkdtempSync(path.join(base, 'orchestra-pause-idx-'));
      return { file: path.join(dir, 'index'), cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error(`no writable dir for the temporary index: ${String(lastErr)}`);
}

/** Untracked (not ignored) regular files with their sizes. */
async function listUntracked(cwd: string): Promise<Array<{ path: string; bytes: number }>> {
  let raw: Buffer;
  try {
    raw = (await git(cwd, ['ls-files', '--others', '--exclude-standard', '-z'])).stdout;
  } catch {
    return [];
  }
  const out: Array<{ path: string; bytes: number }> = [];
  for (const rel of raw.toString('utf8').split('\0')) {
    if (!rel) continue;
    try {
      const st = fs.lstatSync(path.join(cwd, rel));
      if (st.isFile()) out.push({ path: rel, bytes: st.size });
    } catch {
      /* vanished mid-scan */
    }
  }
  return out;
}

/** What is left OUT of the snapshot for size: every file over the per-file cap, then — if the rest still exceeds the total cap — the largest of the rest until it fits. */
export function selectSkipped(
  files: ReadonlyArray<{ path: string; bytes: number }>,
  perFileBytes: number,
  totalBytes: number,
): Array<{ path: string; bytes: number; reason: 'file-cap' | 'total-cap' }> {
  const skipped: Array<{ path: string; bytes: number; reason: 'file-cap' | 'total-cap' }> = files.filter((f) => f.bytes > perFileBytes).map((f) => ({ ...f, reason: 'file-cap' as const }));
  const rest = files.filter((f) => f.bytes <= perFileBytes).sort((a, b) => b.bytes - a.bytes);
  let total = rest.reduce((n, f) => n + f.bytes, 0);
  while (total > totalBytes && rest.length > 0) {
    const f = rest.shift() as { path: string; bytes: number };
    skipped.push({ ...f, reason: 'total-cap' });
    total -= f.bytes;
  }
  return skipped;
}

async function buildTree(
  cwd: string,
  indexFile: string,
  seedFromRealIndex: boolean,
  head: string | null,
  excludes: string[],
  warnings: string[],
  legacyPathspec = false,
): Promise<string> {
  const env = { GIT_INDEX_FILE: indexFile };
  if (seedFromRealIndex) {
    const real = text(await git(cwd, ['rev-parse', '--git-path', 'index']));
    fs.copyFileSync(path.isAbsolute(real) ? real : path.join(cwd, real), indexFile);
  } else if (head) {
    await git(cwd, ['read-tree', head], env);
  }
  const specs = ['.', ...excludes.map((p) => `:(exclude,literal)${p}`)];
  // --ignore-errors: ONE unreadable file must not abort the whole snapshot (plain `git add -A` exits 128 and adds NOTHING);
  // exit 1 = "some files could not be added" — the rest is staged and reported in `warnings`.
  let added: GitOut;
  if (excludes.length <= MAX_ARGV_EXCLUDES || legacyPathspec) {
    const argv = legacyPathspec ? specs.slice(0, 1 + 200) : specs;
    if (legacyPathspec && specs.length > argv.length) warnings.push(`${specs.length - argv.length} oversize file(s) could NOT be excluded (git < 2.25: exclude list capped at 200) — they ARE in the ref`);
    added = await git(cwd, ['add', '-A', '--ignore-errors', '--', ...argv], env, undefined, [1]);
  } else {
    // Many excludes: a NUL-separated pathspec file (git >= 2.25) — never truncated, no argv size limit (round-2 F8).
    const specFile = `${indexFile}.pathspec`;
    fs.writeFileSync(specFile, specs.join('\0'));
    try {
      added = await git(cwd, ['add', '-A', '--ignore-errors', `--pathspec-from-file=${specFile}`, '--pathspec-file-nul'], env, undefined, [1]);
    } finally {
      fs.rmSync(specFile, { force: true });
    }
  }
  warnings.push(...added.stderr.split('\n').map((l) => l.trim()).filter((l) => /^(error|fatal):/.test(l)).slice(0, 10));
  return text(await git(cwd, ['write-tree'], env));
}

/** Count M/A/D between HEAD's tree and the snapshot tree (no real-index read). */
async function diffCounts(cwd: string, env: NodeJS.ProcessEnv, head: string | null, tree: string): Promise<SnapshotResult['changed']> {
  const c = { modified: 0, added: 0, deleted: 0 };
  const base = head ? `${head}^{tree}` : '4b825dc642cb6eb9a060e54bf8d69288fbee4904'; // the empty tree
  const out = text(await git(cwd, ['diff-tree', '-r', '--no-renames', '--name-status', base, tree], env));
  for (const line of out.split('\n')) {
    const s = line[0];
    if (s === 'M' || s === 'T') c.modified++;
    else if (s === 'A') c.added++;
    else if (s === 'D') c.deleted++;
  }
  return c;
}

/** Gitlink (mode 160000) paths in a tree. */
async function gitlinkPaths(cwd: string, env: NodeJS.ProcessEnv, tree: string): Promise<string[]> {
  const out = (await git(cwd, ['ls-tree', '-r', '-z', tree], env)).stdout.toString('utf8');
  const paths: string[] = [];
  for (const rec of out.split('\0')) {
    const m = /^160000 commit [0-9a-f]+\t(.+)$/.exec(rec);
    if (m) paths.push(m[1]);
  }
  return paths;
}

/**
 * Snapshot `worktreePath` to a pause ref. Throws on failure (the caller records the
 * error in the Bilan and proceeds with the pause — a failed snapshot never blocks it).
 * Re-running with the same `at` is refused by `update-ref` (a ref is never overwritten).
 */
export async function snapshotWorktree(input: SnapshotInput, depth = 0): Promise<SnapshotResult> {
  const cwd = input.worktreePath;
  if (!fs.existsSync(cwd)) throw new Error(`worktree ${cwd} does not exist`);
  const gitDir = text(await git(cwd, ['rev-parse', '--absolute-git-dir']));
  let head: string | null = null;
  try {
    head = text(await git(cwd, ['rev-parse', '--verify', '-q', 'HEAD^{commit}']));
  } catch {
    head = null; // unborn branch
  }
  let branch: string | null = null;
  try {
    branch = text(await git(cwd, ['symbolic-ref', '-q', '--short', 'HEAD'])) || null;
  } catch {
    branch = null; // detached
  }
  const skippedLarge = selectSkipped(await listUntracked(cwd), input.limits?.perFileBytes ?? SNAPSHOT_MAX_UNTRACKED_BYTES, input.limits?.totalBytes ?? SNAPSHOT_MAX_TOTAL_UNTRACKED_BYTES);
  const excludes = skippedLarge.map((f) => f.path);
  const tmp = await makeTempIndexPath(gitDir);
  // Every plumbing call below runs against the TEMP index, never the real one: a torn or
  // corrupt real index cannot break them, and none of them can write it.
  const env = { GIT_INDEX_FILE: tmp.file };
  const warnings: string[] = [];
  try {
    let tree: string;
    try {
      tree = await buildTree(cwd, tmp.file, true, head, excludes, warnings, input.legacyPathspec === true);
    } catch {
      // A torn copy (the agent wrote its index mid-copy) or a split/shared index that cannot
      // be replayed from a copy: rebuild from HEAD, which still captures every worktree file.
      fs.rmSync(tmp.file, { force: true });
      warnings.length = 0;
      tree = await buildTree(cwd, tmp.file, false, head, excludes, warnings, input.legacyPathspec === true);
    }
    const message = `orchestra pause snapshot\n\nrun: ${input.runId}\nworkspace: ${input.wsId}\nbranch: ${branch ?? '(detached)'}\nhead: ${head ?? '(unborn)'}\n`;
    const ident = {
      GIT_AUTHOR_NAME: 'Orchestra pause',
      GIT_AUTHOR_EMAIL: 'pause@orchestra.local',
      GIT_COMMITTER_NAME: 'Orchestra pause',
      GIT_COMMITTER_EMAIL: 'pause@orchestra.local',
    };
    const commit = text(
      await git(cwd, ['commit-tree', tree, ...(head ? ['-p', head] : []), '-F', '-'], { ...env, ...ident }, message),
    );
    let at = input.at;
    let ref = pauseRefName(input.runId, input.wsId, at);
    for (let attempt = 0; ; attempt++) {
      try {
        await git(cwd, ['update-ref', ref, commit, ''], env); // '' = the ref must not exist yet
        break;
      } catch (e) {
        if (attempt >= 5) throw e;
        at += 1;
        ref = pauseRefName(input.runId, input.wsId, at);
      }
    }
    const headTree = head ? text(await git(cwd, ['rev-parse', `${head}^{tree}`], env)) : null;
    const dirty = headTree === null ? true : headTree !== tree;
    const changed = await diffCounts(cwd, env, head, tree);
    const submodules: SnapshotResult['submodules'] = [];
    if (depth < 2) {
      for (const sub of await gitlinkPaths(cwd, env, tree)) {
        const subPath = path.join(cwd, sub);
        const dotGit = path.join(subPath, '.git');
        if (!fs.existsSync(dotGit)) continue; // not checked out
        // A real submodule's `.git` is a FILE (a gitfile into the parent's .git/modules). A `.git` DIRECTORY is a nested standalone
        // repository: writing a ref into it would modify a path INSIDE the worktree, so it is reported and left untouched.
        if (!fs.lstatSync(dotGit).isFile()) {
          submodules.push({ path: sub, ref: null, dirty: false, error: 'nested repository (not a submodule) — left untouched, its own uncommitted work is not captured' });
          continue;
        }
        try {
          const r = await snapshotWorktree({ ...input, worktreePath: subPath, at }, depth + 1);
          submodules.push({ path: sub, ref: r.ref, dirty: r.dirty });
        } catch (e) {
          submodules.push({ path: sub, ref: null, dirty: false, error: e instanceof Error ? e.message : String(e) });
        }
      }
    }
    return { ref, commit, tree, head, branch, dirty: dirty || submodules.some((s) => s.dirty), changed, skippedLarge, warnings, submodules };
  } finally {
    tmp.cleanup();
  }
}
