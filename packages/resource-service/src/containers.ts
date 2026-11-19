// Cleanup step `remove-containers` (A2): close the run's relay, then force-remove every container carrying `resctl.run=<id>` on every daemon a relay of the run forwarded to.
import fs from 'node:fs';
import type { CleanupCtx } from './cleanup.ts';
import { removeRunContainers } from './docker-api.ts';
import { stateDir } from './env.ts';
import { closeRelay, own, relayOf, upstreamsOf } from './relay-host.ts';
import { readState, withState, type Run } from './state.ts';

const isSocket = (p: string): boolean => {
  try {
    return fs.statSync(p).isSocket();
  } catch {
    return false;
  }
};

/**
 * Idempotent. A run that never started a relay created no labelled container through us: nothing to remove, Docker is not even contacted. A daemon that cannot be reached FAILS the step
 * (retried by the reaper) — except an OLDER upstream (a relay respawned with another DOCKER_HOST/context) whose socket is gone: that daemon no longer exists to hold anything.
 */
export async function removeContainers(run: Run, ctx: CleanupCtx = {}): Promise<void> {
  const dir = stateDir(ctx.env ?? process.env);
  const rec = await closeRelay(dir, run);
  const ups = upstreamsOf(rec ?? undefined);
  if (!rec || ups.length === 0) return;
  let n = 0;
  for (const up of ups) {
    if (up !== rec.upstream && !isSocket(up)) {
      ctx.log?.(`run ${run.id}: older upstream ${up} is gone: skipped`);
      continue;
    }
    n += await removeRunContainers(up, run.id, run.token, ctx.log);
  }
  await withState((s) => {
    const cur = own(s.runs, run.id);
    if (cur && cur.token === run.token && cur.relay) cur.relay = { ...(cur.relay as object), removed: true };
  }, dir);
  if (n > 0) ctx.log?.(`run ${run.id}: removed ${n} container(s)`);
}

const lastSweep = new Map<string, number>();

/**
 * Runs that are `cleaned` but never had their containers removed: a reboot closes every open run on load (state.ts) without running the pipeline, and a container with a restart policy
 * comes back with the daemon. The reaper calls this each tick; a run is retried at most every 10 s until `removed` is set.
 */
export async function sweepUnremoved(dir: string, ctx: CleanupCtx = {}, now: number = Date.now()): Promise<void> {
  const due = Object.values(readState(dir).runs).filter((r) => {
    const rel = relayOf(r);
    return r.state === 'cleaned' && !!rel && upstreamsOf(rel).length > 0 && !rel.removed && now - (lastSweep.get(`${dir}:${r.id}:${r.token}`) ?? 0) >= 10_000;
  });
  for (const run of due) {
    lastSweep.set(`${dir}:${run.id}:${run.token}`, now);
    try {
      await removeContainers(run, { ...ctx, env: { ...(ctx.env ?? process.env), RESCTL_STATE_DIR: dir } });
      ctx.log?.(`run ${run.id}: containers of a run closed without cleanup removed`);
    } catch (e) {
      ctx.log?.(`run ${run.id}: container sweep failed, will retry: ${(e as Error).message}`);
    }
  }
}
