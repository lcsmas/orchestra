// Rig isolation (#287 follow-up F3, ledger #295): rig drivers that run at the same time — a mutation sweep, the release gate, a reviewer's run — must neither share
// scratch dirs (one driver's `rmSync` of an arm dir under another's running arm = "the arm hung" / 16/17) nor overlap their timing-sensitive arms (CPU contention
// reads as a red arm). So: (1) every driver run gets its OWN scratch subtree (`<base>/<runId>/<arm>`), removed when the run is green; (2) each arm process runs
// under ONE host-wide flock(1), so arms of concurrent drivers are serialised (arm granularity: ~1-2 s each, never a whole sweep).

import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';

export const RIG_LOCK_PATH = path.join(os.homedir(), '.cache', 'e2e-admission-rigs.lock');
export const RIG_LOCK_WAIT_S = 1800;
/** flock(1) exit status when the lock wait timed out (distinct from any arm status). */
export const RIG_LOCK_TIMEOUT_RC = 97;

/** A fresh id for ONE driver run: two concurrent drivers never share a scratch subtree. */
export function newRigRunId() {
  return `${process.pid}-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
}

/** The run id an ARM process was started with (set by its driver). An arm run by hand, with no driver, is 'solo'. */
export function rigRunId(env = process.env) {
  return env.RIG_RUN_ID || 'solo';
}

export function armScratch(base, runId, arm) {
  return path.join(base, runId, arm);
}

export function flockAvailable() {
  return spawnSync('flock', ['--version'], { stdio: 'ignore' }).status === 0;
}

/** argv that runs `cmd args…` under the host-wide rig lock; the bare command when flock(1) is absent (non-Linux: no serialisation, scratch is still per-run). */
export function lockedArgv(cmd, args, { lockPath = RIG_LOCK_PATH, waitS = RIG_LOCK_WAIT_S, hasFlock = flockAvailable() } = {}) {
  if (!hasFlock) return [cmd, ...args];
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  return ['flock', '-w', String(waitS), '-E', String(RIG_LOCK_TIMEOUT_RC), lockPath, cmd, ...args];
}

/** Remove scratch run dirs older than `maxAgeMs` (failed runs keep theirs for debugging, but not forever). Never throws. */
export function pruneOldRuns(base, maxAgeMs = 24 * 3600 * 1000, now = Date.now()) {
  try {
    for (const e of fs.readdirSync(base, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const p = path.join(base, e.name);
      try {
        if (now - fs.statSync(p).mtimeMs > maxAgeMs) fs.rmSync(p, { recursive: true, force: true });
      } catch { /* raced with another driver's cleanup */ }
    }
  } catch { /* no base yet */ }
}
