// The service's configuration lives here; each reader takes the env so a test can pass its own (exec/daemon pass `process.env` through to children).
import os from 'node:os';
import path from 'node:path';
import { parseDuration, parseSize } from './units.ts';

export type Env = Record<string, string | undefined>;

const duration = (env: Env, key: string, dflt: string): number => parseDuration(env[key] || dflt);

/** State directory: `$RESCTL_STATE_DIR`, else `${XDG_STATE_HOME:-~/.local/state}/resctl`. */
export function stateDir(env: Env = process.env): string {
  if (env.RESCTL_STATE_DIR) return path.resolve(env.RESCTL_STATE_DIR);
  return path.join(env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state'), 'resctl');
}
export const graceMs = (env: Env = process.env): number => duration(env, 'RESCTL_GRACE', '15m');
export const tickMs = (env: Env = process.env): number => duration(env, 'RESCTL_TICK', '1s');
/** How long a cleaned run stays listed. */
export const keepMs = (env: Env = process.env): number => duration(env, 'RESCTL_KEEP', '24h');
/** TERM → KILL delay of the process sweep (freeze: 3 s). */
export const termWaitMs = (env: Env = process.env): number => duration(env, 'RESCTL_TERM_WAIT', '3s');
export const noAutostart = (env: Env = process.env): boolean => env.RESCTL_NO_AUTOSTART === '1';
// Read by later tickets (A3 admit, A5 unit); defined here so every env read lives in one file.
export const minFreeMem = (env: Env = process.env): number => parseSize(env.RESCTL_MIN_FREE_MEM || '6G');
export const minFreeDisk = (env: Env = process.env): number => parseSize(env.RESCTL_MIN_FREE_DISK || '10GiB');
/** Where `admit` measures free disk: `$RESCTL_DISK_PATH`, else the home directory (where worktrees/containers write; the state dir may be a tmpfs). */
export const diskPath = (env: Env = process.env): string => env.RESCTL_DISK_PATH || os.homedir();
/** `admit` re-measures every poll (default 2 s) and repeats what it waits for every report interval (default 30 s). */
export const admitPollMs = (env: Env = process.env): number => Math.max(50, duration(env, 'RESCTL_ADMIT_POLL', '2s'));
export const admitReportMs = (env: Env = process.env): number => duration(env, 'RESCTL_ADMIT_REPORT', '30s');
/** How long `status` waits for the docker CLI (default 5 s). */
export const dockerTimeoutMs = (env: Env = process.env): number => duration(env, 'RESCTL_DOCKER_TIMEOUT', '5s');
export const unitName = (env: Env = process.env): string => env.RESCTL_UNIT_NAME || 'resctl.service';
