import fs from 'node:fs';
import path from 'node:path';
import { orchestraHome } from './platform/index.ts';

// Single-BACKEND lock: at most one Orchestra backend — the Electron app OR the
// headless daemon — may own an ORCHESTRA_HOME at a time. Electron's
// requestSingleInstanceLock only fences app-vs-app (and is keyed by userData,
// which the daemon doesn't share), so this lockfile is the piece that makes
// app-vs-daemon mutually exclusive. The hazard it guards is real and
// documented: the events-spool startup wipe + seq reset of a second backend
// strands the first one's status dots, and store.json writes assume a single
// serialized writer (docs/gtk4-port-plan.md §1.1).
//
// Protocol: a JSON file `<orchestraHome>/backend.lock` holding the owner's
// {pid, kind, startedAt}. Liveness = a pid probe (`kill(pid, 0)`); a stale
// file left by a crash is silently reclaimed. Written atomically (tmp +
// rename) so a reader never sees a torn file. This is advisory locking with a
// small acquire race window — fine for the human-scale "user starts a second
// backend" case it exists for, and the loser of any race still refuses.
//
// Imports carry explicit `.ts` extensions so the module is testable under
// Node's type-stripping runner.

/** On-disk shape of the lock file. */
export interface BackendLockInfo {
  pid: number;
  kind: 'electron' | 'daemon';
  startedAt: number;
}

function lockPath(): string {
  return path.join(orchestraHome(), 'backend.lock');
}

function readLock(file: string): BackendLockInfo | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<BackendLockInfo>;
    if (typeof parsed.pid !== 'number' || !Number.isFinite(parsed.pid)) return null;
    return {
      pid: parsed.pid,
      kind: parsed.kind === 'daemon' ? 'daemon' : 'electron',
      startedAt: typeof parsed.startedAt === 'number' ? parsed.startedAt : 0,
    };
  } catch {
    return null; // missing or corrupt — treat as unheld
  }
}

/** Whether `pid` is a live process. EPERM means "alive but not ours" — still
 *  alive; only ESRCH proves death. */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Try to take the backend lock for this process. Returns `{ok: true}` on
 *  success (including reclaiming a stale lock), or the live holder's info so
 *  the caller can present a useful "already running" message. */
export function acquireBackendLock(
  kind: 'electron' | 'daemon',
): { ok: true } | { ok: false; holder: BackendLockInfo } {
  const file = lockPath();
  const existing = readLock(file);
  if (existing && existing.pid !== process.pid && pidAlive(existing.pid)) {
    return { ok: false, holder: existing };
  }
  const info: BackendLockInfo = { pid: process.pid, kind, startedAt: Date.now() };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(info), { mode: 0o600 });
  fs.renameSync(tmp, file);
  return { ok: true };
}

/** Release the lock iff this process still owns it (never clobber a lock a
 *  newer backend legitimately reclaimed after our stale-looking pid). */
export function releaseBackendLock(): void {
  const file = lockPath();
  const existing = readLock(file);
  if (existing && existing.pid !== process.pid) return;
  try {
    fs.unlinkSync(file);
  } catch {
    /* already gone */
  }
}

/** The current live holder, if any — for diagnostics ("is a backend running?"). */
export function currentBackendLockHolder(): BackendLockInfo | null {
  const existing = readLock(lockPath());
  if (!existing) return null;
  return pidAlive(existing.pid) ? existing : null;
}
