// The state file — `$RESCTL_STATE_DIR/state.json` — and its ONLY writer: `withState` takes `state.lock`, reads, runs the callback, writes tmp + rename.
// Keep callbacks short and synchronous: never signal, wait or spawn while the lock is held.
import fs from 'node:fs';
import path from 'node:path';
import { stateDir } from './env.ts';
import { acquire, release } from './lockfile.ts';
import type { Identity } from './proc.ts';

export type Lane = { pid: number; pgid: number; startTime: number; cmd: string[]; startedAt: number; scope?: string };
export type RunState = 'alive' | 'grace' | 'cleaned';
export type Run = {
  id: string;
  /** Random per run INSTANCE; exported to lanes as RESCTL_RUN_TOKEN so a cleanup sweeps only that instance (a re-started same id is a new instance). */
  token: string;
  owner: Identity;
  state: RunState;
  startedAt: number;
  graceEndsAt?: number;
  maxLifeAt?: number;
  lanes: Lane[];
  cleanedAt?: number;
  containers?: unknown;
  relay?: unknown;
};
export type State = { version: 1; runs: Record<string, Run> };

export const stateFile = (dir: string): string => path.join(dir, 'state.json');

function load(dir: string): State {
  let raw: string;
  try {
    raw = fs.readFileSync(stateFile(dir), 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, runs: {} };
    throw e;
  }
  const s = JSON.parse(raw); // a corrupt file fails closed: never pretend there are no runs to reap
  if (s?.version !== 1 || typeof s.runs !== 'object' || !s.runs) throw new Error(`${stateFile(dir)}: unsupported state (version ${s?.version})`);
  return s as State;
}

/** Read-only snapshot (no lock needed: writers rename atomically). */
export function readState(dir: string = stateDir()): State {
  return load(dir);
}

export async function withState<T>(fn: (s: State) => T, dir: string = stateDir()): Promise<T> {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const lock = await acquire(path.join(dir, 'state.lock'), 10_000);
  try {
    const s = load(dir);
    const before = JSON.stringify(s);
    const out = fn(s);
    const after = JSON.stringify(s);
    if (after !== before) {
      const tmp = `${stateFile(dir)}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, after + '\n', { mode: 0o600 });
      fs.renameSync(tmp, stateFile(dir));
    }
    return out;
  } finally {
    release(lock);
  }
}
