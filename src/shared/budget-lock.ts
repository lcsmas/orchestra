// Advisory lock files for the session-budget machinery (C4 #211, ledger #237 D7): "never two runs at once, never
// a re-run while a load campaign runs". `<ORCHESTRA_HOME>/session-budget/{suite,campaign}.lock` hold the owner
// `{pid, startTicks, kind, startedAt}`; a lock is LIVE only while that exact process is (pid alive AND /proc
// start time unchanged — a bare pid is a name, a crashed owner's pid gets recycled). C5/C6's campaign runner takes
// `campaign` (and checks `suite`) through this same module.
//
// Node-only (fs); imported by main and by scripts under `--experimental-strip-types`. No Electron.
import fs from 'node:fs';
import path from 'node:path';

export type LockName = 'suite' | 'campaign';

export interface LockOwner {
  pid: number;
  /** /proc/<pid>/stat field 22 at acquire time; null when unreadable (non-Linux). */
  startTicks: number | null;
  kind: string;
  startedAt: number;
}

export interface LockDeps {
  pid: number;
  now(): number;
  alive(pid: number): boolean;
  startTicks(pid: number): number | null;
}

export function lockPath(home: string, name: LockName): string {
  return path.join(home, 'session-budget', `${name}.lock`);
}

/** Process start time in clock ticks (identity), or null when /proc is unreadable. */
export function procStartTicks(pid: number): number | null {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    const n = Number(rest[19]); // field 22 (starttime); `rest` starts at field 3 (state)
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

export const realLockDeps: LockDeps = {
  pid: process.pid,
  now: () => Date.now(),
  alive: (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (e) {
      return (e as NodeJS.ErrnoException).code === 'EPERM'; // exists, not ours
    }
  },
  startTicks: procStartTicks,
};

/** Is the owner still THE process that took the lock? Fails CLOSED: an alive pid whose start time cannot be
 *  re-read is treated as live (a run refused for nothing is cheap; two campaigns at once is not). */
export function ownerIsLive(owner: LockOwner, deps: LockDeps): boolean {
  if (!deps.alive(owner.pid)) return false;
  if (owner.startTicks === null) return true;
  const now = deps.startTicks(owner.pid);
  return now === null ? true : now === owner.startTicks;
}

export function readLock(file: string): LockOwner | null {
  try {
    const o = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<LockOwner>;
    if (typeof o?.pid !== 'number' || typeof o.startedAt !== 'number' || typeof o.kind !== 'string') return null;
    return { pid: o.pid, startTicks: typeof o.startTicks === 'number' ? o.startTicks : null, kind: o.kind, startedAt: o.startedAt };
  } catch {
    return null;
  }
}

/** The LIVE owner of `name`, or null (absent, unreadable, or a dead/recycled owner). Read-only. */
export function liveOwner(home: string, name: LockName, deps: LockDeps = realLockDeps): LockOwner | null {
  const owner = readLock(lockPath(home, name));
  return owner && ownerIsLive(owner, deps) ? owner : null;
}

export type Acquired = { ok: true; owner: LockOwner; release(): void } | { ok: false; heldBy: LockOwner | null };

/** Take `name` exclusively (`wx`). A lock whose owner is dead/recycled is stale and replaced; release() removes
 *  the file only while it still names THIS owner (never a successor's). */
export function tryAcquire(home: string, name: LockName, kind: string, deps: LockDeps = realLockDeps): Acquired {
  const file = lockPath(home, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const owner: LockOwner = { pid: deps.pid, startTicks: deps.startTicks(deps.pid), kind, startedAt: deps.now() };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(file, `${JSON.stringify(owner)}\n`, { flag: 'wx' });
      return {
        ok: true,
        owner,
        release() {
          const cur = readLock(file);
          if (cur && cur.pid === owner.pid && cur.startedAt === owner.startedAt) fs.rmSync(file, { force: true });
        },
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      const cur = readLock(file);
      if (cur && ownerIsLive(cur, deps)) return { ok: false, heldBy: cur };
      fs.rmSync(file, { force: true }); // stale (dead/recycled owner) or corrupt — replace, then retry the wx once
    }
  }
  return { ok: false, heldBy: readLock(file) };
}
