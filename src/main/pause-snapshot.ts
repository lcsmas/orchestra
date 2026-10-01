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
/** Entries of `skippedLarge` kept on the result / the Bilan row (the rest is only counted — a 100k-file un-ignored tree must not bloat `pause_records`). */
export const SKIPPED_LARGE_STORED = 200;
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
  /** Timeout of the `git add` calls (default {@link GIT_TIMEOUT_MS}); tests shrink it. */
  gitTimeoutMs?: number;
  /** Force the argv-only pathspec (what git < 2.25 gets): excludes beyond 200 are NOT applied — those files ARE in the ref and are reported in `notes`. */
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
  skippedLarge: Array<{ path: string; bytes: number; reason?: 'file-cap' | 'total-cap'; /** set on a wholly-untracked DIRECTORY dropped as one entry (`path` ends with `/`): the files it holds */ files?: number }>;
  /** How many entries were left out in total (`skippedLarge` keeps the {@link SKIPPED_LARGE_STORED} largest). */
  skippedLargeCount: number;
  /** Caveats about what IS in the ref (e.g. oversize files git < 2.25 could not exclude) — NOT "not captured". */
  notes: string[];
  /** Files `git add` could not read (permissions, vanished mid-add): everything else IS in the ref; these are not. */
  warnings: string[];
  /** Gitlinks (submodules) whose own worktree was snapshotted too (path → ref), or failed. */
  submodules: Array<{ path: string; ref: string | null; dirty: boolean; error?: string }>;
}

interface GitOut {
  stdout: Buffer;
  stderr: string;
}

/** A failed git call. `timedOut` = the {@link GIT_TIMEOUT_MS} timer killed it (empty stderr — NOT a version problem); `exitCode` 129 = usage error (an option this git does not know). */
class GitError extends Error {
  exitCode: number | null; // (no parameter properties: node's strip-only TypeScript mode rejects them)
  timedOut: boolean;
  stderr: string;
  cmd: string; // the git subcommand (add, ls-files, write-tree…)
  constructor(message: string, exitCode: number | null, timedOut: boolean, stderr: string, cmd: string) {
    super(message);
    this.exitCode = exitCode;
    this.timedOut = timedOut;
    this.stderr = stderr;
    this.cmd = cmd;
  }
}

/** The snapshot did not finish in time (a very large untracked tree): NO ref was written, nothing was staged beyond the temp index; the pause goes on (round-4: never read as "git < 2.25", never fall back to staging everything). */
export class SnapshotTimeoutError extends Error {
  constructor(ms: number, cmd = 'add') {
    super(`snapshot incomplete: timeout — git ${cmd} exceeded ${ms} ms on a very large tree; no ref was written (the pause still interrupts and kills)`);
    this.name = 'SnapshotTimeoutError';
  }
}

function git(cwd: string, args: string[], env: NodeJS.ProcessEnv = {}, input?: string, okCodes: number[] = [], timeoutMs: number = GIT_TIMEOUT_MS): Promise<GitOut> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      'git',
      // gc.auto=0: no background gc from a snapshot; fsmonitor=false: no hook on the user's repo.
      // hooksPath=/dev/null: the user's repo hooks (post-index-change, reference-transaction, …) must never run for a snapshot (review F6).
      ['-c', 'gc.auto=0', '-c', 'core.fsmonitor=false', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args],
      {
        cwd,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C', ...env }, // LC_ALL=C: git's messages are matched (usage error) and must not be localized
        encoding: 'buffer',
        maxBuffer: 256 * 1024 * 1024,
        timeout: timeoutMs,
      },
      (err, stdout, stderr) => {
        const errText = stderr?.toString('utf8') ?? '';
        if (err && !okCodes.includes(Number((err as { code?: unknown }).code))) {
          const e = err as Error & { killed?: boolean; code?: unknown; signal?: unknown };
          const timedOut = e.killed === true;
          const code = typeof e.code === 'number' ? e.code : null;
          // the message is built from git's STDERR only — never `e.message` ("Command failed: git … --pathspec-from-file=…"), which carries the command text a version-sniffing regex would match
          reject(new GitError(timedOut ? `git ${args[0]} timed out after ${timeoutMs} ms` : `git ${args[0]} failed: ${errText.trim().slice(0, 400) || `exit ${code ?? String(e.signal ?? '?')}`}`, code, timedOut, errText, args[0]));
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

interface Unit {
  path: string;
  raw: Buffer;
  bytes: number;
  files: number;
  dir?: boolean;
}

const yieldLoop = (): Promise<void> => new Promise((r) => setImmediate(r));

/** NUL-separated names from a git listing, as BYTES. */
async function listZ(cwd: string, args: string[], env: NodeJS.ProcessEnv = {}, timeoutMs: number = GIT_TIMEOUT_MS): Promise<Buffer[]> {
  const raw = (await git(cwd, args, env, undefined, [], timeoutMs)).stdout; // a failed or timed-out listing THROWS: swallowing it returned [] ⇒ no excludes ⇒ the size caps silently defeated (stage everything)
  const out: Buffer[] = [];
  let start = 0;
  for (let i = 0; i <= raw.length; i++) {
    if (i < raw.length && raw[i] !== 0) continue;
    if (i > start) out.push(Buffer.from(raw.subarray(start, i)));
    start = i + 1;
  }
  return out;
}

/**
 * Untracked (not ignored) work as UNITS: loose files, and every wholly-untracked DIRECTORY as ONE unit. `git ls-files --others --directory` only CHOOSES the units (its collapse also
 * swallows a directory that holds an ignored `node_modules`); the SIZES come from the plain non-ignored listing, grouped by unit — ignored content is never counted, never dropped
 * with its directory, and a directory holding only ignored files is no unit at all. A dropped directory is excluded by ONE directory pathspec: no tracked file lives below it, so
 * no tracked edit is lost — a 240k-file un-ignored tree costs one exclude (the per-file version took 150 s and froze the main process). Names are BYTES; the scan yields to the event loop.
 */
async function scanUntracked(cwd: string, perFileBytes: number, headIndex: () => Promise<NodeJS.ProcessEnv>, timeoutMs: number = GIT_TIMEOUT_MS): Promise<Unit[]> {
  const list = (env: NodeJS.ProcessEnv): Promise<[Buffer[], Buffer[]]> => Promise.all([listZ(cwd, ['ls-files', '--others', '--exclude-standard', '--directory', '-z'], env, timeoutMs), listZ(cwd, ['ls-files', '--others', '--exclude-standard', '-z'], env, timeoutMs)]);
  let collapsed: Buffer[];
  let files: Buffer[];
  try {
    [collapsed, files] = await list({});
  } catch (e) {
    // a TIMEOUT propagates (loud, no ref); a torn / split real index makes the listing fail too — list against a HEAD-seeded temp index instead (the same fallback the build has), never "no excludes"
    if (e instanceof GitError && e.timedOut) throw e;
    [collapsed, files] = await list(await headIndex());
  }
  const base = Buffer.from(`${cwd}${path.sep}`);
  const out: Unit[] = [];
  const dirs = new Map<string, Unit>(); // latin1(dir path without the trailing slash) → unit
  let n = 0;
  const sizeOf = (rel: Buffer): number | null => {
    try {
      const st = fs.lstatSync(Buffer.concat([base, rel]));
      return st.isFile() ? st.size : null;
    } catch {
      return null; // vanished mid-scan
    }
  };
  for (const name of collapsed) {
    if (name[name.length - 1] === 0x2f) {
      const rel = Buffer.from(name.subarray(0, name.length - 1));
      dirs.set(rel.toString('latin1'), { path: `${rel.toString('utf8')}/`, raw: rel, bytes: 0, files: 0, dir: true });
    } else {
      const sz = sizeOf(name);
      if (sz !== null) out.push({ path: name.toString('utf8'), raw: name, bytes: sz, files: 1 });
      if (++n % 2000 === 0) await yieldLoop();
    }
  }
  if (dirs.size > 0) {
    for (const name of files) {
      if (name[name.length - 1] === 0x2f) continue; // a nested repository entry: git records a gitlink, its files are not ours
      const key = name.toString('latin1');
      let unit: Unit | undefined;
      for (let i = key.indexOf('/'); i >= 0 && !unit; i = key.indexOf('/', i + 1)) unit = dirs.get(key.slice(0, i));
      if (!unit) continue; // a loose file: handled above
      const sz = sizeOf(name);
      if (sz === null) continue;
      if (sz > perFileBytes) out.push({ path: name.toString('utf8'), raw: name, bytes: sz, files: 1 }); // over the per-file cap inside a kept dir: its own exclude
      else {
        unit.bytes += sz;
        unit.files++;
      }
      if (++n % 2000 === 0) await yieldLoop();
    }
    for (const u of dirs.values()) if (u.files > 0) out.push(u);
  }
  return out;
}

/** What is left OUT of the snapshot for size: every FILE over the per-file cap, then — if the rest still exceeds the total cap — the LARGEST units of the rest (a file or a whole untracked directory) until it fits. */
export function selectSkipped<T extends { path: string; bytes: number; dir?: boolean }>(
  files: ReadonlyArray<T>,
  perFileBytes: number,
  totalBytes: number,
): Array<T & { reason: 'file-cap' | 'total-cap' }> {
  const skipped: Array<T & { reason: 'file-cap' | 'total-cap' }> = files.filter((f) => !f.dir && f.bytes > perFileBytes).map((f) => ({ ...f, reason: 'file-cap' as const }));
  const rest = files.filter((f) => f.dir || f.bytes <= perFileBytes).sort((a, b) => b.bytes - a.bytes);
  let total = 0;
  for (const f of rest) total += f.bytes;
  for (let i = 0; i < rest.length && total > totalBytes; i++) { // an index, never shift(): O(N), not O(N²) (240k files cost 150 s)
    skipped.push({ ...rest[i], reason: 'total-cap' });
    total -= rest[i].bytes;
  }
  return skipped;
}

async function buildTree(
  cwd: string,
  indexFile: string,
  seedFromRealIndex: boolean,
  head: string | null,
  excludes: Buffer[],
  warnings: string[],
  notes: string[],
  legacyPathspec = false,
  timeoutMs: number = GIT_TIMEOUT_MS,
): Promise<{ tree: string; applied: number }> {
  const env = { GIT_INDEX_FILE: indexFile };
  if (seedFromRealIndex) {
    const real = text(await git(cwd, ['rev-parse', '--git-path', 'index']));
    fs.copyFileSync(path.isAbsolute(real) ? real : path.join(cwd, real), indexFile);
  } else if (head) {
    await git(cwd, ['read-tree', head], env);
  }
  const specs: Buffer[] = [Buffer.from('.'), ...excludes.map((r) => Buffer.concat([Buffer.from(':(exclude,literal)'), r]))];
  const allUtf8 = excludes.every((r) => Buffer.from(r.toString('utf8'), 'utf8').equals(r)); // a non-UTF8 name cannot go through argv
  let applied = excludes.length;
  const viaArgv = async (limit: number): Promise<GitOut> => {
    const argv = specs.slice(0, limit).map((b) => b.toString('utf8'));
    applied = Math.min(excludes.length, argv.length - 1);
    if (specs.length > argv.length) notes.push(`${specs.length - argv.length} oversize entr(ies) could NOT be excluded (git < 2.25: exclude list capped at ${limit - 1}) — they ARE in the ref`);
    return git(cwd, ['add', '-A', '--ignore-errors', '--', ...argv], env, undefined, [1], timeoutMs);
  };
  // --ignore-errors: ONE unreadable file must not abort the whole snapshot (plain `git add -A` exits 128 and adds NOTHING);
  // exit 1 = "some files could not be added" — the rest is staged and reported in `warnings`.
  let added: GitOut;
  if ((excludes.length <= MAX_ARGV_EXCLUDES && allUtf8) || legacyPathspec) {
    added = await viaArgv(legacyPathspec ? 1 + 200 : specs.length);
  } else {
    // Many excludes (or a non-UTF8 name): a NUL-separated pathspec file in the TEMP dir — never truncated, no argv limit (round-3 F8). Never inside the worktree (D4).
    const specFile = `${indexFile}.pathspec`;
    fs.writeFileSync(specFile, Buffer.concat(specs.flatMap((b, i) => (i === 0 ? [b] : [Buffer.from([0]), b]))));
    try {
      added = await git(cwd, ['add', '-A', '--ignore-errors', `--pathspec-from-file=${specFile}`, '--pathspec-file-nul'], env, undefined, [1], timeoutMs);
    } catch (e) {
      // git < 2.25 does not know the option: usage error, exit 129, "unknown option" on STDERR — never a timeout (empty stderr) and never the command text. Anything else rethrows.
      // (`timedOut` is belt and braces: execFile destroys the pipes on a timeout, so a killed git has empty stderr and exit code null — it can never satisfy the two clauses after it)
      if (!(e instanceof GitError) || e.timedOut || e.exitCode !== 129 || !/unknown option/i.test(e.stderr) || !allUtf8) throw e;
      added = await viaArgv(1 + 200);
    } finally {
      fs.rmSync(specFile, { force: true });
    }
  }
  warnings.push(...added.stderr.split('\n').map((l) => l.trim()).filter((l) => /^(error|fatal):/.test(l)).slice(0, 10));
  return { tree: text(await git(cwd, ['write-tree'], env)), applied };
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
  try {
    return await snapshotWorktreeInner(input, depth);
  } catch (e) {
    // ANY git call that hit the timeout (ls-files, add, write-tree, commit-tree…) is the same loud outcome: incomplete, no ref, the pause goes on
    if (e instanceof GitError && e.timedOut) throw new SnapshotTimeoutError(input.gitTimeoutMs ?? GIT_TIMEOUT_MS, e.cmd);
    throw e;
  }
}

async function snapshotWorktreeInner(input: SnapshotInput, depth: number): Promise<SnapshotResult> {
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
  const addTimeout = input.gitTimeoutMs ?? GIT_TIMEOUT_MS;
  const perFileBytes = input.limits?.perFileBytes ?? SNAPSHOT_MAX_UNTRACKED_BYTES;
  const tmp = await makeTempIndexPath(gitDir);
  // Every plumbing call below runs against the TEMP index, never the real one: a torn or
  // corrupt real index cannot break them, and none of them can write it.
  const env = { GIT_INDEX_FILE: tmp.file };
  const warnings: string[] = [];
  const notes: string[] = [];
  try {
    const headIndexFile = `${tmp.file}.headlist`;
    const skipped = selectSkipped(
      await scanUntracked(cwd, perFileBytes, async () => {
        if (head) await git(cwd, ['read-tree', head], { GIT_INDEX_FILE: headIndexFile }, undefined, [], addTimeout); // unborn: a missing index file = an empty index
        return { GIT_INDEX_FILE: headIndexFile };
      }, addTimeout),
      perFileBytes,
      input.limits?.totalBytes ?? SNAPSHOT_MAX_TOTAL_UNTRACKED_BYTES,
    );
    fs.rmSync(headIndexFile, { force: true });
    const excludes = skipped.map((f) => f.raw);
    let tree: string;
    let applied: number;
    try {
      ({ tree, applied } = await buildTree(cwd, tmp.file, true, head, excludes, warnings, notes, input.legacyPathspec === true, addTimeout));
    } catch (e) {
      if (e instanceof GitError && e.timedOut) throw e; // a rebuild would only wait another full timeout (mapped to SnapshotTimeoutError by the caller)
      // A torn copy (the agent wrote its index mid-copy) or a split/shared index that cannot
      // be replayed from a copy: rebuild from HEAD, which still captures every worktree file.
      fs.rmSync(tmp.file, { force: true });
      warnings.length = 0;
      notes.length = 0;
      try {
        ({ tree, applied } = await buildTree(cwd, tmp.file, false, head, excludes, warnings, notes, input.legacyPathspec === true, addTimeout));
      } catch (e) {
        throw e;
      }
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
        await git(cwd, ['update-ref', ref, commit, ''], env, undefined, [], addTimeout); // '' = the ref must not exist yet
        break;
      } catch (e) {
        if (attempt >= 5 || (e instanceof GitError && e.timedOut)) throw e; // a timeout is not "the ref exists": never retried
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
    // only what was ACTUALLY excluded is "left out" (git < 2.25 cannot exclude more than 200: the rest is in the ref — said in `notes`); store the largest, count the rest
    const excluded = skipped.slice(0, applied);
    const skippedLarge = [...excluded]
      .sort((a, b) => b.bytes - a.bytes)
      .slice(0, SKIPPED_LARGE_STORED)
      .map((f) => ({ path: f.path, bytes: f.bytes, reason: f.reason, ...(f.dir ? { files: f.files } : {}) }));
    return { ref, commit, tree, head, branch, dirty: dirty || submodules.some((s) => s.dirty), changed, skippedLarge, skippedLargeCount: excluded.length, notes, warnings, submodules };
  } finally {
    fs.rmSync(`${tmp.file}.headlist`, { force: true });
    tmp.cleanup();
  }
}
