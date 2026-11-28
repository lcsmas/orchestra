// Docker cleanup of a deleted workspace (#696): `orchestra delete` removes the containers the keeper's relay stamped `orchestra.ws=<id>` WITH their anonymous volumes (`rm -v` — a database image's
// VOLUME otherwise outlives its container: 381 orphan volumes, 20 GB measured), and a periodic host sweep removes the ones whose workspace is gone. Selection is by that label ONLY, re-asserted on
// every row we act on. Platform-free (no store / bus / electron import): the deps are injected so node --test drives the real code on the fake Docker API.
// Docker unavailable / any API error is REPORTED, never thrown: a delete must not hang on a daemon.

import { createDockerApi, DockerApiError, type DockerApi, type DockerContainerSummary } from './docker-api.ts';
import { DOCKER_LABEL_RUN, DOCKER_LABEL_WS, attributedWorkspaceId } from '../shared/docker-labels.ts';
import { attributedLabelFilter } from '../shared/pause-containers.ts';
import { emptyCleanupReport, isAnonymousVolumeName, sweepLogLine, type DockerCleanupReport, type RemovedContainer } from '../shared/docker-cleanup.ts';

/** The graceful stop before the removal (a database gets to flush); the removal is forced anyway. */
export const REMOVE_STOP_TIMEOUT_SEC = 10;
/** Containers of ONE workspace removed at a time. */
export const REMOVE_CONCURRENCY = 4;
/** One sweep pass removes at most this many containers (a mislabelled mass is never wiped in one go); the rest waits for the next pass. */
export const SWEEP_MAX_PER_PASS = 20;

export type CleanupDockerApi = Pick<DockerApi, 'listContainers' | 'inspectContainer' | 'stopContainer' | 'removeContainer' | 'removeVolume'>;

let shared: DockerApi | null = null;
/** The app's REAL-socket client for the delete path and the sweep (resolved per use; its own instance, so the accounting's producer keeps its importers — FI-3.4). */
export function cleanupDockerApi(): DockerApi {
  return (shared ??= createDockerApi());
}

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e)).slice(0, 300);
const dockerAbsent = (e: unknown): boolean => e instanceof DockerApiError && e.kind === 'unavailable' && /no Docker socket found|ENOENT/.test(e.message);

type One = { kind: 'removed'; c: RemovedContainer } | { kind: 'gone' } | { kind: 'failed'; why: string };

/** Stop (best effort) then force-remove ONE container with its anonymous volumes. A container that is gone by the time we look is not ours to report. */
async function removeOne(api: CleanupDockerApi, row: DockerContainerSummary): Promise<One> {
  try {
    const insp = await api.inspectContainer(row.id);
    if (insp === null) return { kind: 'gone' };
    if (insp.running && !insp.autoRemove) await api.stopContainer(row.id, REMOVE_STOP_TIMEOUT_SEC).catch(() => undefined); // the forced removal below kills what a failed stop left
    const volumes = insp.mounts.filter((m) => m.type === 'volume' && m.name !== null).map((m) => m.name as string);
    if ((await api.removeContainer(row.id, { volumes: true, force: true })) === 'gone') return { kind: 'gone' };
    return {
      kind: 'removed',
      c: { id: row.id, name: row.name, image: row.image, anonymousVolumes: volumes.filter(isAnonymousVolumeName).length, namedVolumes: [...new Set(volumes.filter((v) => !isAnonymousVolumeName(v)))] },
    };
  } catch (e) {
    return { kind: 'failed', why: `${row.name || row.id.slice(0, 12)}: ${errText(e)}` };
  }
}

async function inPool<T, R>(items: readonly T[], n: number, f: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      for (;;) {
        const i = next++;
        if (i >= items.length) return;
        out[i] = await f(items[i]);
      }
    }),
  );
  return out;
}

/** Remove the named volumes the removed containers mounted — only when asked; the daemon refuses one another container still uses (never forced). */
async function settleNamedVolumes(api: CleanupDockerApi, r: DockerCleanupReport, removeNamed: boolean): Promise<void> {
  const names = [...new Set(r.removed.flatMap((c) => c.namedVolumes))];
  for (const name of names) {
    if (!removeNamed) {
      r.keptNamedVolumes.push(name);
      continue;
    }
    try {
      const o = await api.removeVolume(name);
      if (o === 'removed') r.removedNamedVolumes.push(name);
      else if (o === 'in-use') r.keptNamedVolumes.push(`${name} (still used by another container)`);
    } catch (e) {
      r.keptNamedVolumes.push(`${name} (${errText(e)})`);
    }
  }
}

/**
 * Remove every container labelled `orchestra.ws=<wsId>` (running or not) with its anonymous volumes; report what went. `removeNamedVolumes` also removes the named volumes they mounted
 * (default: listed, kept). Never throws.
 */
export async function removeWorkspaceContainers(api: CleanupDockerApi, wsId: string, o: { removeNamedVolumes?: boolean } = {}): Promise<DockerCleanupReport> {
  const report = emptyCleanupReport();
  let rows: DockerContainerSummary[];
  try {
    rows = await api.listContainers({ all: true, labels: [attributedLabelFilter(wsId)] });
  } catch (e) {
    if (dockerAbsent(e)) report.unavailable = true;
    else report.error = `list containers: ${errText(e)}`;
    return report;
  }
  // belt and braces: the daemon filtered by label already, but a removal is destructive — re-assert the label on each row
  const mine = rows.filter((r) => r.labels[DOCKER_LABEL_WS] === wsId);
  for (const res of await inPool(mine, REMOVE_CONCURRENCY, (r) => removeOne(api, r))) {
    if (res.kind === 'removed') report.removed.push(res.c);
    else if (res.kind === 'failed') report.failed.push(res.why);
  }
  await settleNamedVolumes(api, report, o.removeNamedVolumes === true);
  return report;
}

export interface SweepDeps {
  /** The daemons to look at (the app's own + member-pinned ones), deduped by the caller. */
  apis(): Promise<CleanupDockerApi[]>;
  /** The store has parsed store.json: before that EVERY labelled container would look orphaned. */
  storeReady(): boolean;
  workspaceExists(wsId: string): boolean;
  /** This app's bus has this run id. An orphan must carry a run stamp this app knows: a container stamped by ANOTHER Orchestra instance on the same daemon (a dev build beside the live app) is not ours. */
  runKnown(runId: string): boolean;
  info(message: string): void;
  warn(message: string, meta?: unknown): void;
}

export interface SweepResult {
  /** The pass did not run (store not ready, no daemon answered, another pass in flight). */
  skipped: string | null;
  removed: number;
  failed: number;
}

let sweeping = false;

/** One host pass: remove the containers whose `orchestra.ws` workspace no longer exists — one log line each. Single-flight; never throws. Named volumes are never removed here (listed in the log line). */
export async function sweepOrphanContainers(d: SweepDeps, o: { max?: number } = {}): Promise<SweepResult> {
  if (sweeping) return { skipped: 'in-flight', removed: 0, failed: 0 };
  if (!d.storeReady()) return { skipped: 'store-not-ready', removed: 0, failed: 0 };
  sweeping = true;
  try {
    const max = o.max ?? SWEEP_MAX_PER_PASS;
    let removed = 0;
    let failed = 0;
    let answered = 0;
    let deferred = 0;
    for (const api of await d.apis()) {
      let rows: DockerContainerSummary[];
      try {
        rows = await api.listContainers({ all: true, labels: [DOCKER_LABEL_WS] });
        answered += 1;
      } catch (e) {
        if (!dockerAbsent(e)) d.warn(`docker-sweep: list containers failed — ${errText(e)}`);
        continue;
      }
      for (const row of rows) {
        const ws = attributedWorkspaceId(row.labels);
        if (ws === null || d.workspaceExists(ws) || !d.runKnown(row.labels[DOCKER_LABEL_RUN] ?? '')) continue;
        if (removed + failed >= max) {
          deferred += 1;
          continue;
        }
        const res = await removeOne(api, row);
        if (res.kind === 'removed') {
          removed += 1;
          d.info(sweepLogLine(res.c, ws));
        } else if (res.kind === 'failed') {
          failed += 1;
          d.warn(`docker-sweep: could not remove container of deleted workspace ${ws} — ${res.why}`);
        }
      }
    }
    if (deferred > 0) d.info(`docker-sweep: ${deferred} more orphan container(s) wait for the next pass (limit ${max} per pass)`);
    return { skipped: answered === 0 ? 'no-daemon' : null, removed, failed };
  } catch (e) {
    d.warn('docker-sweep: pass failed', e);
    return { skipped: 'error', removed: 0, failed: 0 };
  } finally {
    sweeping = false;
  }
}

/** Test seam. */
export function __resetSweepForTests(): void {
  sweeping = false;
}
