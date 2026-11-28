// The host timer of the orphan-container sweep (#696): wires `sweepOrphanContainers` to this app's store + bus + Docker daemons. Started after store.load() (index.ts), like the resource monitor.
// `ORCHESTRA_DOCKER_SWEEP=0` turns it off.

import { runKnownIn } from './container-window';
import { memberPinnedApis, windowDeps } from './resource-monitor';
import { cleanupDockerApi, sweepOrphanContainers, type CleanupDockerApi, type SweepDeps } from './docker-cleanup';
import { scoped } from './logger';

const slog = scoped('docker-sweep');

/** First pass after boot, then every this long. */
export const SWEEP_FIRST_MS = 2 * 60_000;
export const SWEEP_EVERY_MS = 10 * 60_000;

/** The app's own daemon plus every member-pinned one that is a DIFFERENT socket. */
async function sweepApis(): Promise<CleanupDockerApi[]> {
  const own = cleanupDockerApi();
  const seen = new Set<string>([(await own.resolveSocket().catch(() => null)) ?? '<own>']);
  const out: CleanupDockerApi[] = [own];
  for (const extra of memberPinnedApis()) {
    const p = await extra.resolveSocket().catch(() => null);
    if (p === null || seen.has(p)) continue;
    seen.add(p);
    out.push(extra);
  }
  return out;
}

export function productionSweepDeps(): SweepDeps {
  const runKnown = runKnownIn(windowDeps);
  return {
    apis: sweepApis,
    storeReady: () => windowDeps.storeReady(),
    workspaceExists: (id) => !!windowDeps.getWorkspace(id),
    runKnown,
    info: (m) => slog.info(m),
    warn: (m, meta) => slog.warn(m, meta),
  };
}

let timer: NodeJS.Timeout | null = null;
let first: NodeJS.Timeout | null = null;

export function startDockerSweep(): void {
  if (timer || process.env.ORCHESTRA_DOCKER_SWEEP === '0') return;
  const deps = productionSweepDeps();
  const pass = (): void => void sweepOrphanContainers(deps).catch((e) => slog.swallow('pass', e));
  first = setTimeout(pass, SWEEP_FIRST_MS);
  timer = setInterval(pass, SWEEP_EVERY_MS);
  first.unref?.();
  timer.unref?.();
}

export function stopDockerSweep(): void {
  if (first) clearTimeout(first);
  if (timer) clearInterval(timer);
  first = timer = null;
}

