// EVERY environment read of the service goes through here (a test greps for stray `process.env` reads). Each reader takes the env so a test can pass its own.
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
export const diskPath = (env: Env = process.env): string => env.RESCTL_DISK_PATH || os.homedir();
export const unitName = (env: Env = process.env): string => env.RESCTL_UNIT_NAME || 'resctl.service';
