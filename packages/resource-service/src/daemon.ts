// Starting the reaper daemon on demand. `run start` calls ensureDaemon unless RESCTL_NO_AUTOSTART=1 (tests start their own `serve`).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readHolder } from './lockfile.ts';
import { isAlive } from './proc.ts';

export const daemonLockPath = (dir: string): string => path.join(dir, 'daemon.lock');

export function daemonRunning(dir: string): boolean {
  const h = readHolder(daemonLockPath(dir));
  return !!h && h !== 'unreadable' && isAlive(h);
}

/** Spawn a detached `resctl serve` for `dir` when none holds the lock (a lost race just makes the second one exit 3). */
export function ensureDaemon(dir: string, env: NodeJS.ProcessEnv = process.env): void {
  if (daemonRunning(dir)) return;
  const bin = fileURLToPath(new URL('../bin/resctl.mjs', import.meta.url));
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const log = fs.openSync(path.join(dir, 'serve.log'), 'a', 0o600);
  const childEnv: NodeJS.ProcessEnv = { ...env, RESCTL_STATE_DIR: dir };
  // a daemon started from inside a lane must not carry the lane's run marker (a sweep of that run would kill it)
  delete childEnv.RESCTL_RUN;
  delete childEnv.RESCTL_RUN_TOKEN;
  const child = spawn(process.execPath, [bin, 'serve'], { detached: true, stdio: ['ignore', log, log], env: childEnv });
  child.unref();
  fs.closeSync(log);
}
