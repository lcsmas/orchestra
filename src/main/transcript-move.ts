// Relocating one workspace's transcript dir between account config dirs (#240). Pure node:fs — no electron, no
// store — so `node --test` loads it directly.
//
// Invariant: a transcript byte exists at the source OR at the destination at every instant, and the source is never
// removed unless it is provably the SAME data as a verified destination copy.
//  - never on the same dir however spelled (trailing slash, `..`, symlink, shared `projects/`, bind mount) — master
//    compared strings, "moved" the dir onto itself and `rm -r`'d it;
//  - same filesystem: plain `rename` per entry (atomic; a writer holding the fd follows the inode). A mid-way failure
//    renames back what this call moved;
//  - cross-filesystem (EXDEV): copy to a tmp name → verify (size + sha256) → rename into place → re-stat the source
//    entry and remove it only if unchanged since the copy; an existing destination entry is NEVER overwritten.
import { createHash } from 'node:crypto';
import { createReadStream, type BigIntStats } from 'node:fs';
import { cp, lstat, mkdir, readdir, readlink, rename, rm, rmdir } from 'node:fs/promises';
import path from 'node:path';
import { sameDir } from './same-dir.ts';

export interface MoveReport {
  /** Things the caller should surface (kept entries, leftover duplicates, an unreadable source). Empty = clean. */
  warnings: string[];
}

export interface MoveIo {
  /** Test seams. `copy` = how one entry (file or tree) is copied (default `fs.cp`, timestamps kept — `claude
   *  --continue` resumes the NEWEST transcript); `rename` = the same-filesystem move (default `fs.rename`). */
  copy?: (from: string, to: string) => Promise<void>;
  rename?: (from: string, to: string) => Promise<void>;
  /** Identity probe (`dev:ino`) — lets a test model a filesystem that reports inode 0 / a source that aliases its copy. */
  lstat?: (p: string, opts: { bigint: true }) => Promise<BigIntStats>;
}

const defaultCopy = (from: string, to: string): Promise<void> =>
  cp(from, to, { recursive: true, force: false, errorOnExist: true, preserveTimestamps: true, verbatimSymlinks: true });

/** A temp copy of an interrupted cross-filesystem move (`<name>.orchestra-mv-<pid>-<time>`, see copyVerifyPlace). */
const TMP_COPY_RE = /\.orchestra-mv-\d+-[a-z0-9]+$/;

const errCode = (e: unknown): string | undefined => (e as NodeJS.ErrnoException | null)?.code;
const exists = (p: string): Promise<boolean> => lstat(p).then(() => true, () => false);

/** `dev:ino` of a path (a final symlink is not followed), or null when the FS reports no stable inode (0) or it is gone. */
async function objectId(p: string, lstatFn: NonNullable<MoveIo['lstat']> = lstat): Promise<string | null> {
  try {
    const st = await lstatFn(p, { bigint: true });
    return st.ino === 0n ? null : `${st.dev}:${st.ino}`;
  } catch {
    return null;
  }
}

async function sha256(file: string): Promise<string> {
  const h = createHash('sha256');
  for await (const chunk of createReadStream(file)) h.update(chunk as Buffer);
  return h.digest('hex');
}

/** relative path → signature (`f:<size>:<sha256>` / `d` / `l:<target>` / `o:<mode>`) for every node under `root`. */
async function snapshot(root: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const walk = async (p: string, rel: string): Promise<void> => {
    const st = await lstat(p);
    if (st.isSymbolicLink()) out.set(rel, `l:${await readlink(p)}`);
    else if (st.isDirectory()) {
      out.set(rel, 'd');
      for (const n of (await readdir(p)).sort()) await walk(path.join(p, n), rel ? `${rel}/${n}` : n);
    } else if (st.isFile()) out.set(rel, `f:${st.size}:${await sha256(p)}`);
    else out.set(rel, `o:${st.mode}`);
  };
  if (!(await exists(root))) return out; // a root that is not there is an empty snapshot → reported as MISSING
  await walk(root, ''); // anything vanishing MID-walk throws: fail closed, never a partial snapshot
  return out;
}

/** null when every node under `from` exists under `to` with an equal signature (extra nodes under `to` are fine),
 *  else a description of the first difference. */
export async function firstMismatch(from: string, to: string): Promise<string | null> {
  const a = await snapshot(from);
  const b = await snapshot(to);
  for (const [rel, sig] of a) {
    const got = b.get(rel);
    if (got !== sig) return `${rel || '.'}: source ${sig.slice(0, 24)} vs destination ${got === undefined ? 'MISSING' : got.slice(0, 24)}`;
  }
  return null;
}

/** Cheap change detector for a source entry (no hashing): mode + size + mtime + inode of every node, directories
 *  included (a dir's mtime moves when an entry is added or removed). Re-taken right before a source is removed. */
async function statSig(root: string): Promise<string> {
  const parts: string[] = [];
  const walk = async (p: string, rel: string): Promise<void> => {
    const st = await lstat(p, { bigint: true });
    parts.push(`${rel}|${st.mode}|${st.size}|${st.mtimeNs}|${st.ino}`);
    if (st.isDirectory()) for (const n of (await readdir(p)).sort()) await walk(path.join(p, n), rel ? `${rel}/${n}` : n);
  };
  await walk(root, '');
  return parts.join('\n');
}

interface Item {
  name: string;
  from: string;
  to: string;
  /** statSig of the source taken BEFORE it was copied / compared. */
  pre?: string;
  tmp?: string;
}

/** Move every entry of `srcDir` into `dstDir` (created if needed). No-op when `srcDir` is missing/empty or IS
 *  `dstDir` (identity, not string). Throws — source untouched — when a move/copy/verification fails. Never
 *  overwrites an existing destination entry (kept in the source + a warning). */
export async function moveProjectTranscripts(srcDir: string, dstDir: string, io: MoveIo = {}): Promise<MoveReport> {
  const warnings: string[] = [];
  let entries: string[];
  try {
    entries = await readdir(srcDir);
  } catch (err) {
    // ENOENT/ENOTDIR = nothing recorded yet. Anything else (EACCES…) is history we could not even list: say so.
    if (errCode(err) !== 'ENOENT' && errCode(err) !== 'ENOTDIR') {
      warnings.push(`cannot read ${srcDir} (${errCode(err) ?? err}) — its transcripts were NOT moved`);
    }
    return { warnings };
  }
  if (entries.length === 0) return { warnings };
  entries.sort();
  if (sameDir(srcDir, dstDir)) return { warnings }; // the SAME dir however spelled: nothing to move, nothing may be removed
  await mkdir(dstDir, { recursive: true });
  const idOf = (p: string): Promise<string | null> => objectId(p, io.lstat);
  const [srcId, dstId] = [await idOf(srcDir), await idOf(dstDir)];
  if (srcId === null || dstId === null) {
    throw new Error(`cannot tell ${srcDir} from ${dstDir} on this filesystem (no stable inode) — nothing was moved`);
  }

  // Plan: a destination entry of the same name is never overwritten — identical content = the source is a duplicate
  // (dropped below, guarded); different content = kept in the source with a warning.
  const moves: Item[] = [];
  const dups: Item[] = [];
  const kept = new Set<string>(); // entries deliberately left in the source (each has a warning)
  const keep = (name: string, why: string): void => { kept.add(name); warnings.push(`kept ${name} in the source: ${why}`); };
  for (const name of entries) {
    const item: Item = { name, from: path.join(srcDir, name), to: path.join(dstDir, name) };
    // A crash-orphaned temp copy is not a transcript: never carried onward (it would be moved as if it were one).
    if (TMP_COPY_RE.test(name)) { keep(name, 'it is the leftover temp copy of an interrupted move, not a transcript'); continue; }
    if (!(await exists(item.to))) { moves.push(item); continue; }
    item.pre = await statSig(item.from);
    const bad = await firstMismatch(item.from, item.to);
    if (bad === null) dups.push(item);
    else keep(name, `the destination already has a different ${name} (${bad})`);
  }

  const renameFn = io.rename ?? rename;
  const copied: Item[] = [];
  let viaCopy = (await lstat(srcDir)).dev !== (await lstat(dstDir)).dev;
  if (!viaCopy) {
    const moved: Item[] = [];
    try {
      for (const it of moves) { await renameFn(it.from, it.to); moved.push(it); }
    } catch (err) {
      // Atomic renames: every file is in exactly one place. Put back what THIS call moved so the source is whole again.
      for (const it of moved.reverse()) {
        if (await exists(it.from)) warnings.push(`could not put ${it.name} back: ${it.from} was recreated meanwhile — it is at ${it.to}`);
        else await renameFn(it.to, it.from).catch((e) => warnings.push(`could not put ${it.name} back (${errCode(e)}) — it is at ${it.to}`));
      }
      if (errCode(err) !== 'EXDEV') {
        // The rollback's own trouble (an entry that could not be put back) must reach the caller: it is on the error.
        const stranded = warnings.filter((w) => w.startsWith('could not put '));
        if (stranded.length && err instanceof Error) {
          err.message = `${err.message} — ${stranded.join('; ')}`;
          Object.assign(err, { warnings: stranded });
        }
        throw err;
      }
      viaCopy = true; // e.g. overlay/FUSE: same st_dev, yet rename refuses → copy path below
    }
  }
  if (viaCopy) {
    await copyVerifyPlace(moves, io.copy ?? defaultCopy);
    copied.push(...moves);
  }

  // Sources that are now provably duplicated at the destination: remove each only if unchanged since it was read.
  for (const it of [...copied, ...dups]) {
    const [a, b] = [await idOf(it.from), await idOf(it.to)];
    if (a === null || b === null || a === b) { keep(it.name, 'it cannot be told apart from its destination copy'); continue; }
    if (it.pre !== undefined && (await statSig(it.from).catch(() => null)) !== it.pre) {
      keep(it.name, 'it changed while it was being copied (a writer is still alive?) — the destination copy may be stale');
      continue;
    }
    try {
      await rm(it.from, { recursive: true, force: true });
    } catch (err) {
      kept.add(it.name);
      warnings.push(`could not remove ${it.from} (${errCode(err) ?? err}) — its transcripts are at ${it.to}; a duplicate remains in the source`);
    }
  }
  // The dir itself only if — and only if — it is empty (non-recursive: a file that appeared meanwhile is never deleted).
  await rmdir(srcDir).catch(async (err) => {
    if (errCode(err) === 'ENOENT') return;
    if (['ENOTEMPTY', 'EEXIST'].includes(errCode(err) ?? '')) {
      // Left-overs we did not deliberately keep were created AFTER the listing (a session that started mid-move): say so.
      const stranded = (await readdir(srcDir).catch(() => [] as string[])).filter((n) => !kept.has(n));
      if (stranded.length) warnings.push(`left in ${srcDir}, created after the move began (not moved): ${stranded.join(', ')}`);
    } else warnings.push(`could not remove ${srcDir} (${errCode(err) ?? err})`);
  });
  return { warnings };
}

/** Cross-filesystem move of `items`: copy each to a tmp name beside its destination, verify ALL, then rename them into
 *  place. Throws with the source untouched and every tmp / placed copy of THIS call removed. The source is not
 *  removed here (the caller does it, guarded). Sets `pre` on each item. */
async function copyVerifyPlace(items: Item[], copy: (from: string, to: string) => Promise<void>): Promise<void> {
  const tag = `.orchestra-mv-${process.pid}-${Date.now().toString(36)}`;
  const ours: string[] = [];
  try {
    for (const it of items) {
      it.pre = await statSig(it.from);
      it.tmp = `${it.to}${tag}`;
      ours.push(it.tmp);
      await copy(it.from, it.tmp);
    }
    for (const it of items) {
      const bad = await firstMismatch(it.from, it.tmp as string);
      if (bad) throw new Error(`transcript copy not verified (${it.name} — ${bad}); source left intact`);
    }
    for (const it of items) {
      if (await exists(it.to)) throw new Error(`destination ${it.name} appeared during the move; source left intact`);
      await rename(it.tmp as string, it.to); // within the destination filesystem: atomic
      ours.push(it.to);
    }
  } catch (err) {
    for (const p of ours) await rm(p, { recursive: true, force: true }).catch(() => undefined);
    throw err;
  }
}
