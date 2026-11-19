// The ORDERED cleanup pipeline of a run. A1 registers `kill-processes`; A2 appends `remove-containers`, A4 appends `stop-scopes`.
// A step is idempotent (a run may be cleaned twice: `run end` racing the reaper) and must not hold the state lock.
import { termWaitMs, type Env } from './env.ts';
import { findByEnv, groupMembers, readStat, signalGroupIfOurs, signalIfSame, sleep, touchable, groupIsOurs, type Identity } from './proc.ts';
import { withState, type Run } from './state.ts';

export type CleanupCtx = { env?: Env; log?: (msg: string) => void };
export type CleanupStep = { name: string; run: (run: Run, ctx: CleanupCtx) => Promise<void> };

/** Env key the lanes carry (see exec.ts): one random value per run instance. */
export const TOKEN_ENV = 'RESCTL_RUN_TOKEN';

/** Every live process of the run: the recorded lane groups PLUS anything carrying the run's marker (double fork / setsid escapes the group, not the marker). */
export function collectRunProcesses(run: Run): Identity[] {
  const byPid = new Map<number, Identity>();
  const ours = run.lanes.filter((l) => l.pgid === l.pid && groupIsOurs({ pid: l.pid, startTime: l.startTime }) === 'ours');
  const born = new Map(ours.map((l) => [l.pgid, l.startTime]));
  for (const m of groupMembers(...born.keys())) {
    const pg = readStat(m.pid)?.pgrp;
    if (pg !== undefined && m.startTime >= (born.get(pg) ?? Infinity)) byPid.set(m.pid, m);
  }
  for (const m of findByEnv(TOKEN_ENV, run.token)) byPid.set(m.pid, m);
  return [...byPid.values()];
}

/** The members this process may signal (not init, not itself, not in its own process group). */
const sendable = (run: Run): Identity[] => collectRunProcesses(run).filter(touchable);

function signalRun(run: Run, sig: NodeJS.Signals): void {
  for (const lane of run.lanes) if (lane.pgid === lane.pid) signalGroupIfOurs({ pid: lane.pid, startTime: lane.startTime }, sig);
  for (const m of sendable(run)) signalIfSame(m, sig);
}

async function waitEmpty(run: Run, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  for (;;) {
    if (sendable(run).length === 0) return true;
    if (Date.now() >= deadline) return false;
    await sleep(25);
  }
}

/** Members of the run this process must NOT signal (its own group): cleanup cannot claim success while they live. */
function refuseIfBlocked(run: Run): void {
  const blocked = collectRunProcesses(run).filter((m) => !touchable(m));
  if (blocked.length) throw new Error(`run ${run.id}: ${blocked.length} process(es) of the run share the caller's own process group (${blocked.map((p) => p.pid).join(',')}); end the run from outside its lanes`);
}

/** TERM, wait RESCTL_TERM_WAIT, then KILL until nothing of the run is left. */
export async function killProcesses(run: Run, ctx: CleanupCtx = {}): Promise<void> {
  if (sendable(run).length > 0) {
    signalRun(run, 'SIGTERM');
    if (!(await waitEmpty(run, termWaitMs(ctx.env)))) {
      let gone = false;
      for (let round = 0; round < 20 && !gone; round++) {
        signalRun(run, 'SIGKILL');
        gone = await waitEmpty(run, 250);
      }
      if (!gone) throw new Error(`run ${run.id}: processes survived SIGKILL: ${sendable(run).map((p) => p.pid).join(',')}`);
    }
  }
  refuseIfBlocked(run);
}

export const CLEANUP_STEPS: CleanupStep[] = [{ name: 'kill-processes', run: killProcesses }];

/** Run every step in order; a failing step does not skip the next ones. Returns the failures. */
export async function cleanupRun(run: Run, ctx: CleanupCtx = {}): Promise<{ step: string; error: string }[]> {
  const failures: { step: string; error: string }[] = [];
  for (const step of CLEANUP_STEPS) {
    try {
      await step.run(run, ctx);
    } catch (e) {
      failures.push({ step: step.name, error: (e as Error).message });
    }
  }
  return failures;
}

const laneKey = (l: { pid: number; startTime: number }): string => `${l.pid}:${l.startTime}`;

/**
 * Clean a run and, only if every step succeeded, mark THAT instance (token) `cleaned`. A lane that registered while the steps ran (exec racing the
 * cleanup) is cleaned in another round before the mark; once `cleaned`, exec refuses to register and kills its own lane. Returns the failures.
 */
export async function endRun(dir: string, run: Run, ctx: CleanupCtx = {}): Promise<{ step: string; error: string }[]> {
  let snapshot = run;
  for (let round = 0; round < 3; round++) {
    const failures = await cleanupRun(snapshot, ctx);
    if (failures.length) return failures;
    const known = new Set(snapshot.lanes.map(laneKey));
    const raced = await withState((s): Run | null => {
      const cur = s.runs[run.id];
      if (!cur || cur.token !== run.token || cur.state === 'cleaned') return null;
      if (cur.lanes.some((l) => !known.has(laneKey(l)))) return JSON.parse(JSON.stringify(cur)); // a lane appeared meanwhile: not done
      cur.state = 'cleaned';
      cur.cleanedAt = Date.now();
      cur.lanes = [];
      delete cur.graceEndsAt;
      return null;
    }, dir);
    if (!raced) return [];
    snapshot = raced;
  }
  return [{ step: 'mark-cleaned', error: `run ${run.id}: new lanes kept appearing while it was being cleaned` }];
}
