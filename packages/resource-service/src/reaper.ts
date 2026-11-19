// The reaper: one pure decision per run + one tick that applies it. `resctl serve` loops `tick`.
import { graceMs, keepMs, type Env } from './env.ts';
import { endRun, type CleanupCtx } from './cleanup.ts';
import { sweepUnremoved } from './containers.ts';
import { groupIsOurs, isAlive } from './proc.ts';
import { withState, type Run } from './state.ts';

export type Decision =
  | { kind: 'none' }
  | { kind: 'enter-grace'; graceEndsAt: number }
  | { kind: 'cleanup'; reason: 'grace-expired' | 'max-life' }
  | { kind: 'purge' };

/** What to do with a run at `now`. Boundary: a grace is over at `now >= graceEndsAt`; `run start` re-adopts only while `now < graceEndsAt`. */
export function decide(run: Run, now: number, ownerAlive: boolean, o: { graceMs: number; keepMs: number }): Decision {
  if (run.state === 'cleaned') return now - (run.cleanedAt ?? 0) >= o.keepMs ? { kind: 'purge' } : { kind: 'none' };
  if (run.maxLifeAt !== undefined && now >= run.maxLifeAt) return { kind: 'cleanup', reason: 'max-life' };
  if (run.state === 'alive') return ownerAlive ? { kind: 'none' } : { kind: 'enter-grace', graceEndsAt: now + o.graceMs };
  if (run.graceEndsAt === undefined) return { kind: 'enter-grace', graceEndsAt: now + o.graceMs };
  return now >= run.graceEndsAt ? { kind: 'cleanup', reason: 'grace-expired' } : { kind: 'none' };
}

/** One reaper pass over the state dir. Cleanup runs OUTSIDE the state lock. */
/** `shouldStop` is polled between the runs due at once: a stop request (SIGTERM) finishes the run in flight, not all of them. */
export async function tick(dir: string, env: Env, log: (msg: string) => void, now: number = Date.now(), shouldStop: () => boolean = () => false): Promise<void> {
  const opts = { graceMs: graceMs(env), keepMs: keepMs(env) };
  const due: { run: Run; reason: string }[] = [];
  await withState((s) => {
    for (const run of Object.values(s.runs)) {
      // a lane whose group is empty (or whose leader pid now belongs to a stranger) is a stale record: drop it, never signal it later
      if (run.state !== 'cleaned') run.lanes = run.lanes.filter((l) => l.pgid !== l.pid || groupIsOurs({ pid: l.pid, startTime: l.startTime }) === 'ours');
      const d = decide(run, now, isAlive(run.owner), opts);
      if (d.kind === 'enter-grace') {
        run.state = 'grace';
        run.graceEndsAt = d.graceEndsAt;
        log(`run ${run.id}: owner ${run.owner.pid} is gone, grace until ${new Date(d.graceEndsAt).toISOString()}`);
      } else if (d.kind === 'cleanup') {
        due.push({ run: JSON.parse(JSON.stringify(run)), reason: d.reason });
      } else if (d.kind === 'purge') {
        delete s.runs[run.id];
      }
    }
  }, dir);
  const ctx: CleanupCtx = { env, log };
  for (const { run, reason } of due) {
    if (shouldStop()) break; // the rest stays due: the next daemon (or run end) cleans it
    log(`run ${run.id}: cleaning (${reason})`);
    const failures = await endRun(dir, run, ctx);
    if (failures.length) log(`run ${run.id}: cleanup failed, will retry: ${failures.map((f) => `${f.step}: ${f.error}`).join('; ')}`);
    else log(`run ${run.id}: cleaned`);
  }
  await sweepUnremoved(dir, ctx); // runs a reboot closed without the pipeline (A2)
}
