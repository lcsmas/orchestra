// Container memory accounting — the PRODUCER (#293, wave G ledger #295, epic #284; contract = ledger FI-3). Pure half: src/shared/container-accounting.ts.
//
// Refreshed once per resource-monitor tick (resource-monitor.ts `sampleTick`); every consumer — the Resources page, `bus-status`, the LEAD's memory alert —
// reads the LAST tick's result through `getContainerAccounting()` and never calls Docker itself. The daemon is the app's REAL one (`docker-api.ts`, FI-1.2,
// never a relay). Platform-free (no store / bus import: the run-start clock is injected) so node --test and the real-dockerd rig drive the real code.
//
// ONE container-stats pass per tick, and NONE when no attributed container exists (AC). A member whose relay is pinned to ANOTHER daemon is queried there too. A container the daemon cannot give a usable figure for is counted
// `unmeasured` — never guessed. Unattributed containers are listed, NEVER touched.

import { createDockerApi, type DockerApi, type DockerContainerSummary } from './docker-api.ts';
import { scoped } from './logger.ts';
import {
  buildAccounting,
  classifyContainers,
  containerMemoryBytes,
  emptyAccounting,
  type ContainerAccounting,
  type UnattributedContainer,
} from '../shared/container-accounting.ts';

const alog = scoped('container-accounting');

/** A hung daemon must not stall the tick: stats calls run this many at a time … */
export const STATS_CONCURRENCY = 4;
/** … and at most this many attributed containers are measured per pass (the rest are counted `unmeasured`). */
export const MAX_STATS_PER_PASS = 64;
/** A successful pass older than this (5 monitor ticks) is reported 'stale', never as the current figures. */
export const ACCOUNTING_STALE_MS = 5 * 60_000;

export interface ContainerAccountingDeps {
  /** The app's own daemon (the REAL socket). */
  api: DockerApi;
  /** Daemons members' relays are PINNED to when they differ from the app's (the daemon a container was STAMPED on is the one to ask — the #291 F2 lesson). Deduped by resolved socket. */
  extraApis?(): DockerApi[];
  /** Does this workspace id exist in the store? (absent = every id is known). A container labelled for an unknown workspace is an ORPHAN → unattributed. Gets the container's `orchestra.run` stamp too (an untrusted store trusts only that). */
  workspaceKnown?(workspaceId: string, runId: string): boolean;
  /** Does this app's bus have this run id? An orphan must carry a run stamp this app knows — a container stamped by ANOTHER Orchestra instance on the same daemon is not ours (absent = no check). */
  runKnown?(runId: string): boolean;
  /** Start of the earliest LIVE fleet run, epoch ms; null = none (nothing can be unattributed). */
  earliestLiveRunStartMs(): number | null;
  now(): number;
  info(message: string): void;
  warn(message: string, meta?: unknown): void;
}

let current: ContainerAccounting = emptyAccounting();
let lastDocker: ContainerAccounting['docker'] = 'not-sampled';
let lastPartial: boolean | null = null;
let lastUnattributedKey = '';
let inflight: Promise<ContainerAccounting> | null = null;
let sharedApi: DockerApi | null = null;

/** The app's REAL-socket client (resolved per use, re-resolved when the daemon moves). */
export function realDockerApi(): DockerApi {
  return (sharedApi ??= createDockerApi());
}

/** FI-3.2: the last refresh's result. Synchronous; never calls Docker. */
export function getContainerAccounting(now: number = Date.now()): ContainerAccounting {
  // a 'good' pass nobody has completed for ACCOUNTING_STALE_MS (a daemon so slow every pass overruns) must not read as current
  if (current.docker === 'ok' && current.sampledAt !== null && now - current.sampledAt > ACCOUNTING_STALE_MS) return emptyAccounting('stale', current.sampledAt);
  return current;
}

async function measure(attributed: Array<{ id: string; wsId: string; api: DockerApi }>, d: ContainerAccountingDeps): Promise<Array<{ wsId: string; bytes: number | null }>> {
  const out: Array<{ wsId: string; bytes: number | null } | null> = new Array(attributed.length).fill(null);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= attributed.length) return;
      const a = attributed[i];
      if (i >= MAX_STATS_PER_PASS) {
        out[i] = { wsId: a.wsId, bytes: null }; // over the pass budget: counted, not measured
        continue;
      }
      try {
        const stats = await a.api.containerStats(a.id);
        if (stats === null) out[i] = null; // 404: the container went away between the list and the stats — not counted
        else out[i] = { wsId: a.wsId, bytes: containerMemoryBytes(stats) };
      } catch (e) {
        d.warn(`container-accounting: stats of ${a.id.slice(0, 12)} (workspace ${a.wsId}) failed — counted unmeasured`, e);
        out[i] = { wsId: a.wsId, bytes: null };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(STATS_CONCURRENCY, attributed.length) }, worker));
  return out.filter((x): x is { wsId: string; bytes: number | null } => x !== null);
}

function logUnattributed(list: readonly UnattributedContainer[], d: ContainerAccountingDeps): void {
  const key = list.map((u) => u.id).sort().join(',');
  if (key === lastUnattributedKey) return;
  const had = lastUnattributedKey !== '';
  lastUnattributedKey = key;
  if (list.length > 0) {
    d.warn(
      `container-accounting: ${list.length} unattributed container(s) — ${list.map((u) => `${u.name || u.id.slice(0, 12)} (${u.id.slice(0, 12)})${u.orphanOf ? ` orphan of deleted workspace ${u.orphanOf}` : ''}`).join(', ')} — counted and reported, NEVER touched`,
    );
  } else if (had) {
    d.info('container-accounting: no unattributed container any more');
  }
}

/**
 * One refresh (what each monitor tick runs). Single-flight (a hung daemon cannot stack passes); never throws — an unreachable daemon is recorded as
 * `docker: 'unavailable'` (NOTHING measured, which is not "zero containers") and logged once per transition.
 */
export function refreshContainerAccounting(d: ContainerAccountingDeps): Promise<ContainerAccounting> {
  if (inflight) return inflight;
  inflight = (async () => {
    const now = d.now();
    // the app's own daemon first, then any member-pinned daemon that is a DIFFERENT socket (deduped by resolution; a daemon that does not resolve counts as the app's own)
    const apis: DockerApi[] = [d.api];
    const seen = new Set<string>([(await d.api.resolveSocket().catch(() => null)) ?? '<own>']);
    for (const extra of d.extraApis?.() ?? []) {
      const p = (await extra.resolveSocket().catch(() => null)) ?? null;
      if (p === null || seen.has(p)) continue;
      seen.add(p);
      apis.push(extra);
    }
    const running: Array<DockerContainerSummary & { api: DockerApi }> = [];
    let answered = 0;
    let firstError: unknown = null;
    for (const api of apis) {
      try {
        // running + PAUSED: a frozen container still holds its memory (`docker pause` / compose pause by a human; Orchestra never pauses — FI-1.4) — review m1
        for (const c of await api.listContainers({ status: ['running', 'paused'] })) if (!running.some((r) => r.id === c.id)) running.push({ ...c, api });
        answered += 1;
      } catch (e) {
        firstError ??= e;
      }
    }
    if (answered === 0) {
      if (lastDocker !== 'unavailable') d.info(`container-accounting: Docker not reachable (${firstError instanceof Error ? firstError.message : String(firstError)}) — container memory not measured`);
      lastDocker = 'unavailable';
      lastUnattributedKey = '';
      current = emptyAccounting('unavailable', now);
      return current;
    }
    if (answered < apis.length && lastPartial !== true) d.warn(`container-accounting: ${apis.length - answered} of ${apis.length} Docker daemon(s) did not answer — their containers are not counted this tick`, firstError);
    lastPartial = answered < apis.length;
    if (lastDocker === 'unavailable') d.info('container-accounting: Docker reachable again');
    lastDocker = 'ok';
    const { attributed, unattributed } = classifyContainers(running, d.earliestLiveRunStartMs(), d.workspaceKnown, d.runKnown);
    const apiOf = new Map(running.map((r) => [r.id, r.api]));
    // The AC: no container-stats call at all when there is no attributed container.
    const measured = attributed.length === 0 ? [] : await measure(attributed.map((a) => ({ ...a, api: apiOf.get(a.id) as DockerApi })), d);
    current = buildAccounting(measured, unattributed, now, apis.length - answered);
    logUnattributed(unattributed, d);
    return current;
  })()
    .catch((e) => {
      d.warn('container-accounting: refresh failed', e);
      current = emptyAccounting('error', d.now()); // an unexpected failure is not "the last figures are still right": nothing is trusted until the next good pass
      lastDocker = 'ok';
      return current;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/** The real deps; `earliestLiveRunStartMs` is wired by the caller (it needs the bus + store, which this module does not import). */
export function realContainerAccountingDeps(earliestLiveRunStartMs: () => number | null): ContainerAccountingDeps {
  return { api: realDockerApi(), earliestLiveRunStartMs, now: () => Date.now(), info: (m) => alog.info(m), warn: (m, meta) => alog.warn(m, meta) };
}

/** Test/rig seam. */
export function __resetContainerAccountingForTests(): void {
  current = emptyAccounting();
  lastDocker = 'not-sampled';
  lastPartial = null;
  lastUnattributedKey = '';
  inflight = null;
  sharedApi = null;
}
