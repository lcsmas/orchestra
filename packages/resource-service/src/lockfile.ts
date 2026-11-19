// Exclusive lock files holding the owner's identity. Created whole via link(2) (content is never half-written), stolen ONLY after the holder's
// pid+starttime fails the identity probe (a pid of a different process, or a dead one, is stale). Used by state.json (short) and daemon.lock (long).
import fs from 'node:fs';
import path from 'node:path';
import { identityOf, isAlive, sleep, type Identity } from './proc.ts';

export type Lock = { path: string; identity: Identity };
export type TryResult = { ok: true; lock: Lock } | { ok: false; heldBy: Identity | null };

const encode = (id: Identity): string => JSON.stringify(id) + '\n';

export function readHolder(file: string): Identity | null | 'unreadable' {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ENOENT' ? null : 'unreadable';
  }
  try {
    const j = JSON.parse(raw);
    return Number.isInteger(j?.pid) && Number.isFinite(j?.startTime) ? { pid: j.pid, startTime: j.startTime } : 'unreadable';
  } catch {
    return 'unreadable';
  }
}

/** Does the lock file still name `lock.identity`? */
export function holds(lock: Lock): boolean {
  const h = readHolder(lock.path);
  return !!h && h !== 'unreadable' && h.pid === lock.identity.pid && h.startTime === lock.identity.startTime;
}

/** One non-blocking attempt. A stale lock (holder dead, or its pid reused by another process) is stolen after RE-reading the file so a lock a rival just took is never unlinked. */
export function tryAcquire(file: string): TryResult {
  const me = identityOf(process.pid);
  if (!me) throw new Error('cannot read own identity from /proc');
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, encode(me), { mode: 0o600 });
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        fs.linkSync(tmp, file);
        return { ok: true, lock: { path: file, identity: me } };
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      }
      const holder = readHolder(file);
      if (holder === null) continue; // vanished between link and read: retry
      if (holder !== 'unreadable' && isAlive(holder)) return { ok: false, heldBy: holder };
      if (holder === 'unreadable' && Date.now() - mtimeMs(file) < 2000) return { ok: false, heldBy: null }; // maybe mid-creation by a foreign writer
      // stale: holder dead / pid reused. Re-read right before the unlink; only remove the very file we judged.
      const again = readHolder(file);
      if (JSON.stringify(again) !== JSON.stringify(holder)) continue;
      try {
        fs.unlinkSync(file);
      } catch {
        /* a rival removed it first */
      }
    }
    return { ok: false, heldBy: null };
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* already gone */
    }
  }
}

function mtimeMs(file: string): number {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

/** Wait up to `timeoutMs` for the lock. */
export async function acquire(file: string, timeoutMs: number): Promise<Lock> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const r = tryAcquire(file);
    if (r.ok) return r.lock;
    if (Date.now() >= deadline) throw new Error(`lock busy: ${file} (held by pid ${r.heldBy?.pid ?? '?'})`);
    await sleep(5 + Math.floor(Math.random() * 20));
  }
}

/** Remove the lock file only if it is still ours. */
export function release(lock: Lock): void {
  if (!holds(lock)) return;
  try {
    fs.unlinkSync(lock.path);
  } catch {
    /* already gone */
  }
}
