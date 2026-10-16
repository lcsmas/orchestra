// Relocating one workspace's transcript dir between account config dirs (#240). Pure node:fs — no electron, no store — so
// `node --test` loads it directly.
//
// Invariant: a transcript byte exists at the source OR the destination at every instant; nothing is ever removed that was
// not first renamed/copied-and-verified elsewhere.
//  - same dir however spelled (trailing slash, symlink, shared `projects/`, bind mount — `sameDir`): nothing to move. Master
//    compared strings, "moved" the dir onto itself and `rm -r`'d it;
//  - same filesystem: `rename` per entry (atomic; a writer holding the fd follows the inode); a mid-way failure renames
//    back what THIS call moved. Never overwrites a destination entry (the source entry is kept + a warning);
//  - cross-filesystem (EXDEV): copy ALL to tmp names, verify (size + sha256), rename into place, then remove each source
//    entry only if it is unchanged since it was read. The source dir goes by non-recursive `rmdir`: a file that appeared
//    meanwhile is never deleted.
// Two movers of one dir to the SAME destination converge; to DIFFERENT ones they would split the history — the caller's
// per-workspace lock (`migrationsInFlight`, workspaces.ts) is what excludes that.
import { createHash } from 'node:crypto';
import { createReadStream, type BigIntStats } from 'node:fs';
import { cp, lstat, mkdir, readdir, readlink, rename, rm, rmdir } from 'node:fs/promises';
import path from 'node:path';
import { sameDir } from './same-dir.ts';

export interface MoveReport {
  /** What the caller should surface (kept entries, leftover duplicates, an unreadable source). Empty = clean. */
  warnings: string[];
}

/** Test seams: `copy` = how one entry is copied, `rename` = the same-filesystem move, `lstat` = the identity probe. */
export interface MoveIo {
  copy?: (from: string, to: string) => Promise<void>;
  rename?: (from: string, to: string) => Promise<void>;
  lstat?: (p: string, opts: { bigint: true }) => Promise<BigIntStats>;
}

// Timestamps kept: `claude --continue` resumes the NEWEST transcript.
const defaultCopy = (from: string, to: string): Promise<void> =>
  cp(from, to, { recursive: true, force: false, errorOnExist: true, preserveTimestamps: true, verbatimSymlinks: true });

const errCode = (e: unknown): string | undefined => (e as NodeJS.ErrnoException | null)?.code;
const exists = (p: string): Promise<boolean> => lstat(p).then(() => true, () => false);

/** `dev:ino` of a path (a final symlink is not followed); null when gone or the FS reports no stable inode (0). */
async function objectId(p: string, lstatFn: NonNullable<MoveIo['lstat']>): Promise<string | null> {
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
  await walk(root, ''); // a node vanishing MID-walk throws: fail closed, never a partial snapshot
  return out;
}

/** null when every node under `from` exists under `to` with an equal signature, else the first difference. */
export async function firstMismatch(from: string, to: string): Promise<string | null> {
  const [a, b] = [await snapshot(from), await snapshot(to)];
  for (const [rel, sig] of a) {
    const got = b.get(rel);
    if (got !== sig) return `${rel || '.'}: source ${sig.slice(0, 24)} vs destination ${got === undefined ? 'MISSING' : got.slice(0, 24)}`;
  }
  return null;
}

/** Cheap change detector (no hashing): mode+size+mtime+inode of every node, dirs included. Re-taken right before a source is removed. */
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
  pre?: string; // statSig of the source before it was copied
  tmp?: string;
}

/** Move every entry of `srcDir` into `dstDir` (created if needed). No-op when `srcDir` is missing/empty or IS `dstDir`
 *  (identity, not string). Throws — source whole — when a move/copy/verification fails. */
export async function moveProjectTranscripts(srcDir: string, dstDir: string, io: MoveIo = {}): Promise<MoveReport> {
  const warnings: string[] = [];
  let entries: string[];
  try {
    entries = await readdir(srcDir);
  } catch (err) {
    // ENOENT/ENOTDIR = nothing recorded yet; anything else (EACCES…) is history we could not even list: say so.
    if (errCode(err) !== 'ENOENT' && errCode(err) !== 'ENOTDIR') {
      warnings.push(`cannot read ${srcDir} (${errCode(err) ?? err}) — its transcripts were NOT moved`);
    }
    return { warnings };
  }
  if (entries.length === 0) return { warnings };
  entries.sort();
  await mkdir(dstDir, { recursive: true });
  if (sameDir(srcDir, dstDir)) return { warnings }; // the SAME dir however spelled: nothing to move, nothing may be removed

  const lstatFn = io.lstat ?? lstat;
  const renameFn = io.rename ?? rename;
  const kept = new Set<string>(); // entries deliberately left in the source (each has a warning)
  const keep = (name: string, why: string): void => { kept.add(name); warnings.push(`kept ${name} in the source: ${why}`); };

  // A destination entry of the same name is never overwritten: the source entry stays, with a warning.
  const moves: Item[] = [];
  for (const name of entries) {
    const it: Item = { name, from: path.join(srcDir, name), to: path.join(dstDir, name) };
    if (!(await exists(it.to))) moves.push(it);
    else if (await exists(it.from)) keep(name, `the destination already has a ${name}`);
  }

  let viaCopy: boolean;
  try {
    viaCopy = (await lstatFn(srcDir, { bigint: true })).dev !== (await lstatFn(dstDir, { bigint: true })).dev;
  } catch (err) {
    if (errCode(err) === 'ENOENT' && !(await exists(srcDir))) return { warnings }; // a concurrent mover finished and removed it
    throw err;
  }
  if (!viaCopy) {
    const moved: Item[] = [];
    try {
      for (const it of moves) {
        try {
          await renameFn(it.from, it.to);
          moved.push(it);
        } catch (err) {
          if (errCode(err) === 'ENOENT' && !(await exists(it.from))) continue; // a concurrent mover took it: still in exactly one place
          throw err;
        }
      }
    } catch (err) {
      // Atomic renames: every file is in exactly one place. Put back what THIS call moved so the source is whole again.
      for (const it of moved.reverse()) {
        await renameFn(it.to, it.from).catch((e) => warnings.push(`could not put ${it.name} back (${errCode(e)}) — it is at ${it.to}`));
      }
      if (errCode(err) !== 'EXDEV') {
        const stranded = warnings.filter((w) => w.startsWith('could not put '));
        if (stranded.length && err instanceof Error) err.message = `${err.message} — ${stranded.join('; ')}`;
        throw err;
      }
      viaCopy = true; // same st_dev yet rename refuses (overlay/FUSE): the copy path below
    }
  }
  if (viaCopy) {
    await copyVerifyPlace(moves, io.copy ?? defaultCopy);
    // Sources now provably duplicated at the destination: remove each only if it is a distinct object, unchanged since read.
    for (const it of moves) {
      const [a, b] = [await objectId(it.from, lstatFn), await objectId(it.to, lstatFn)];
      if (a === null || b === null || a === b) { keep(it.name, 'it cannot be told apart from its destination copy'); continue; }
      if ((await statSig(it.from).catch(() => null)) !== it.pre) { keep(it.name, 'it changed while it was being copied — the destination copy may be stale'); continue; }
      try {
        await rm(it.from, { recursive: true, force: true });
      } catch (err) {
        kept.add(it.name);
        warnings.push(`could not remove ${it.from} (${errCode(err) ?? err}) — its transcripts are at ${it.to}; a duplicate remains in the source`);
      }
    }
  }
  // The dir itself only if it is empty (non-recursive: a file that appeared meanwhile is never deleted).
  await rmdir(srcDir).catch(async (err) => {
    if (errCode(err) === 'ENOENT') return;
    if (['ENOTEMPTY', 'EEXIST'].includes(errCode(err) ?? '')) {
      const stranded = (await readdir(srcDir).catch(() => [] as string[])).filter((n) => !kept.has(n));
      if (stranded.length) warnings.push(`left in ${srcDir}, created after the move began (not moved): ${stranded.join(', ')}`);
    } else warnings.push(`could not remove ${srcDir} (${errCode(err) ?? err})`);
  });
  return { warnings };
}

/** Cross-filesystem move of `items`: copy each to a tmp name beside its destination, verify ALL, then rename them into place.
 *  Throws with the source untouched and every tmp / placed copy of THIS call removed. Sets `pre` on each item. */
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
      await rename(it.tmp as string, it.to); // inside the destination filesystem: atomic
      ours.push(it.to);
    }
  } catch (err) {
    for (const p of ours) await rm(p, { recursive: true, force: true }).catch(() => undefined);
    throw err;
  }
}
