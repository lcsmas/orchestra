// The state file — `$RESCTL_STATE_DIR/state.json` — and its ONLY writer: `withState` takes `state.lock`, reads, runs the callback, writes tmp + rename.
// Keep callbacks short and synchronous: never signal, wait or spawn while the lock is held.
import fs from 'node:fs';
import path from 'node:path';
import { stateDir } from './env.ts';
import { acquire, release } from './lockfile.ts';
import { bootId, type Identity } from './proc.ts';

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
  /** A4: last `exec --mem` scope number handed out for this run instance (scope name `resctl-<id>-<n>.scope`). */
  scopeSeq?: number;
  cleanedAt?: number;
  containers?: unknown;
  relay?: unknown;
};
/** `bootId`: the kernel boot the records belong to; after a reboot no recorded process can be alive, so every open run is closed on load. */
export type State = { version: 1; bootId?: string; runs: Record<string, Run> };

export const stateFile = (dir: string): string => path.join(dir, 'state.json');

function load(dir: string): { state: State; migrated: boolean } {
  const boot = bootId();
  let raw: string;
  try {
    raw = fs.readFileSync(stateFile(dir), 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { state: { version: 1, bootId: boot ?? undefined, runs: Object.create(null) }, migrated: false };
    throw e;
  }
  const s = JSON.parse(raw); // a corrupt file fails closed: never pretend there are no runs to reap
  if (s?.version !== 1 || typeof s.runs !== 'object' || !s.runs) throw new Error(`${stateFile(dir)}: unsupported state (version ${s?.version})`);
  // null-prototype: a run id like `constructor` or `toString` must be an ordinary key, never an inherited property
  const state: State = { version: 1, bootId: s.bootId, runs: Object.assign(Object.create(null), s.runs) };
  let migrated = false;
  if (boot && state.bootId !== boot) {
    if (state.bootId) {
      for (const run of Object.values(state.runs)) {
        if (run.state === 'cleaned') continue;
        run.state = 'cleaned'; // another boot: every recorded pid/pgid/starttime is meaningless, signalling any of them could hit a stranger
        run.cleanedAt = Date.now();
        run.lanes = [];
        delete run.graceEndsAt;
      }
    }
    state.bootId = boot;
    migrated = true;
  }
  return { state, migrated };
}

/** Read-only snapshot (no lock needed: writers rename atomically). */
export function readState(dir: string = stateDir()): State {
  return load(dir).state;
}

export async function withState<T>(fn: (s: State) => T, dir: string = stateDir()): Promise<T> {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const lock = await acquire(path.join(dir, 'state.lock'), 10_000);
  try {
    const { state: s, migrated } = load(dir);
    const before = JSON.stringify(s);
    const out = fn(s);
    const after = JSON.stringify(s);
    if (migrated || after !== before) {
      const tmp = `${stateFile(dir)}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, after + '\n', { mode: 0o600 });
      fs.renameSync(tmp, stateFile(dir));
    }
    return out;
  } finally {
    release(lock);
  }
}
