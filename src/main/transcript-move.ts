// Relocating one workspace's transcript dir between account config dirs (#240). Pure node:fs — no electron, no
// store — so `node --test` loads it directly.
//
// Invariant: a transcript byte exists at the source OR at the destination at every instant. The source is removed
// only after EVERY entry was copied AND verified (present, same size + sha256) at the destination, and never when
// source and destination are the same directory however they are spelled (trailing slash, `..`, symlink, shared
// `projects/`, bind mount). Master `rename`d then `rm -r`'d by raw-string compare: an aliased target wiped the history.
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { cp, lstat, mkdir, readdir, readlink, rm, rmdir } from 'node:fs/promises';
import path from 'node:path';
import { sameDir } from './same-dir.ts';

export interface MoveIo {
  /** Test seam: how one entry (file or directory tree) is copied. Default = `fs.cp`, timestamps preserved
   *  (`claude --continue` resumes the NEWEST transcript, so mtimes are part of the data). */
  copy?: (from: string, to: string) => Promise<void>;
}

const defaultCopy = (from: string, to: string): Promise<void> =>
  cp(from, to, { recursive: true, force: true, preserveTimestamps: true, verbatimSymlinks: true });

const exists = (p: string): Promise<boolean> => lstat(p).then(() => true, () => false);

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

/** null when every node under `from` exists under `to` with an equal signature (extra nodes under `to` are fine —
 *  a pre-existing session dir is merged into), else a description of the first difference. */
export async function firstMismatch(from: string, to: string): Promise<string | null> {
  const a = await snapshot(from);
  const b = await snapshot(to);
  for (const [rel, sig] of a) {
    const got = b.get(rel);
    if (got !== sig) return `${rel || '.'}: source ${sig.slice(0, 24)} vs destination ${got === undefined ? 'MISSING' : got.slice(0, 24)}`;
  }
  return null;
}

/** Move every entry of `srcDir` into `dstDir` (created if needed). No-op when `srcDir` is missing/empty or IS
 *  `dstDir` (identity, not string). Throws — with the source untouched — when any copy or verification fails;
 *  copies this call created at the destination are removed again (never a path that pre-existed). */
export async function moveProjectTranscripts(srcDir: string, dstDir: string, io: MoveIo = {}): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(srcDir);
  } catch {
    return; // no project dir under the source account → nothing to move
  }
  if (entries.length === 0) return;
  entries.sort();
  if (sameDir(srcDir, dstDir)) return; // the SAME dir however spelled: nothing to move, nothing may be removed
  await mkdir(dstDir, { recursive: true });

  const copy = io.copy ?? defaultCopy;
  const created: string[] = [];
  try {
    for (const name of entries) {
      const to = path.join(dstDir, name);
      if (!(await exists(to))) created.push(to);
      await copy(path.join(srcDir, name), to);
    }
    for (const name of entries) {
      const bad = await firstMismatch(path.join(srcDir, name), path.join(dstDir, name));
      if (bad) throw new Error(`transcript copy not verified (${name} — ${bad}); source left intact`);
    }
  } catch (err) {
    for (const to of created) await rm(to, { recursive: true, force: true }).catch(() => undefined);
    throw err;
  }
  // Verified at the destination: only now drop the source, entry by entry (a failure leaves a harmless duplicate;
  // the history is safe at dst), then the dir itself if — and only if — it is empty (non-recursive: a file that
  // appeared meanwhile is never deleted).
  for (const name of entries) await rm(path.join(srcDir, name), { recursive: true, force: true }).catch(() => undefined);
  await rmdir(srcDir).catch(() => undefined);
}
