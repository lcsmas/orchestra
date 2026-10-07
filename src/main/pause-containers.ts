// The Docker half of a Pause dure (#292, epic #284, ADR 0004, ledger #295 FI-1.3–1.8): stop the member's ATTRIBUTED containers at the trap, restart
// exactly those at the Reprise. Selection is by the `orchestra.ws` label the keeper's relay stamped — never by name, never unlabelled containers.
// `stop` only (`POST /containers/{id}/stop?t=10`): never remove, kill or `docker pause`. A `--rm` container is NOT stopped (stopping deletes it).
// Docker unavailable / any API error is RECORDED and never blocks the trap or keeps it incomplete.

import { DockerApiError, type DockerApi } from './docker-api.ts';
import type { BusDb } from './bus.ts';
import { updateBilanContainers } from './bus-pause-records.ts';
import { owedRows } from './pause-reprise.ts';
import { DOCKER_LABEL_RUN, DOCKER_LABEL_WS } from '../shared/docker-labels.ts';
import {
  attributedLabelFilter,
  MAX_CONTAINER_ENTRIES,
  mergeRestarted,
  mergeStopped,
  owedRestarts,
  type BilanContainers,
  type ContainerRestartEntry,
  type ContainerStopEntry,
} from '../shared/pause-containers.ts';

/** What the trap and the Reprise need from Docker: the app's real-socket client (`docker-api.ts`, never a relay), injectable for tests. */
export type PauseDockerApi = Pick<DockerApi, 'listContainers' | 'inspectContainer' | 'stopContainer' | 'startContainer'>;

/** `docker stop -t`: SIGTERM, then SIGKILL after this long (FI-1.4). */
export const STOP_TIMEOUT_SEC = 10;

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e)).slice(0, 300);

/** Docker is simply NOT THERE (no socket at all / ENOENT — not installed, not started): then no container of this host is running, so nothing was left to stop and there is nothing to alarm
 *  the member about. A daemon that EXISTS but does not answer (refused, permission denied, timeout, an HTTP error) is a real "could not stop". */
function dockerAbsent(e: unknown): boolean {
  return e instanceof DockerApiError && e.kind === 'unavailable' && /no Docker socket found|ENOENT/.test(e.message);
}

/** States in which a container still holds memory and must be stopped: `running`, and `restarting` (a crash-looping one keeps running under a Pause otherwise). */
export const STOPPABLE_STATES = ['running', 'restarting'];
export interface StopResult {
  containers: BilanContainers;
  /** The pause was lifted (the Reprise began) while stopping: no further container was touched. */
  lifted: boolean;
  /** The ids THIS call stopped (a lifted trap restarts them itself — the Reprise's own read may have missed them). */
  stoppedNow: string[];
}

/**
 * Stop every RUNNING container labelled `orchestra.ws=<wsId>`. `prior` = what an earlier attempt of the same trap recorded (merged by id — a retry never
 * stops the same container twice and a `failed` one is simply tried again). `stillPaused` is re-read before EVERY container: a Reprise that began
 * mid-trap stops the trap before the next one (D4: a lift mid-trap touches nothing more).
 */
export async function stopAttributedContainers(
  api: PauseDockerApi,
  wsId: string,
  o: { stillPaused: () => boolean; now: () => number; prior?: BilanContainers; onProgress?: (c: BilanContainers) => void },
): Promise<StopResult> {
  let acc: BilanContainers = { stopped: mergeStopped(o.prior?.stopped, []), ...(o.prior?.restarted?.length ? { restarted: o.prior.restarted } : {}) };
  const stoppedNow: string[] = [];
  let rows;
  try {
    rows = await api.listContainers({ labels: [attributedLabelFilter(wsId)], status: STOPPABLE_STATES });
  } catch (e) {
    return { containers: dockerAbsent(e) ? acc : { ...acc, error: `list: ${errText(e)}` }, lifted: false, stoppedNow };
  }
  for (const row of rows) {
    // belt and braces: the daemon filtered by label already, but a stop is destructive — re-assert the label on the row we act on
    if (row.labels[DOCKER_LABEL_WS] !== wsId) continue;
    if (acc.stopped.some((s) => s.id === row.id && s.outcome !== 'failed')) continue; // already handled by an earlier attempt
    if (!o.stillPaused()) return { containers: acc, lifted: true, stoppedNow };
    // the Bilan keeps MAX_CONTAINER_ENTRIES per member: past it we stop ACTING (an unrecorded stop would never be restarted) and say so
    if (acc.stopped.length >= MAX_CONTAINER_ENTRIES) {
      acc = { ...acc, error: `more than ${MAX_CONTAINER_ENTRIES} attributed containers: the rest were NOT stopped` };
      break;
    }
    const base = { id: row.id, name: row.name, image: row.image, run: row.labels[DOCKER_LABEL_RUN] ?? null };
    let entry: ContainerStopEntry | null;
    try {
      const insp = await api.inspectContainer(row.id);
      if (insp === null) entry = null; // gone between the list and now: nothing of ours
      else if (insp.autoRemove) entry = { ...base, outcome: 'skipped-autoremove', atMs: o.now() }; // `docker run --rm`: a stop would DELETE it (FI-1.4)
      else {
        const r = await api.stopContainer(row.id, STOP_TIMEOUT_SEC);
        // 'already-stopped' (someone else stopped it first) and 'gone' are NOT ours: never recorded as stopped, so the Reprise never restarts them
        entry = r === 'stopped' ? { ...base, outcome: 'stopped', atMs: o.now() } : null;
        if (r === 'stopped') stoppedNow.push(row.id);
      }
    } catch (e) {
      // a stop that errored (a client-side timeout, a daemon hiccup) may still have taken effect: re-inspect before calling it failed — a container that IS down must be recorded
      // `stopped` (the Reprise restarts it); one reported "still running" would never be listed again (the retry lists running containers only)
      let down = false;
      try {
        const now = await api.inspectContainer(row.id);
        down = now !== null && !now.running;
      } catch {
        /* unreadable: stays failed */
      }
      entry = down ? { ...base, outcome: 'stopped', atMs: o.now() } : { ...base, outcome: 'failed', error: errText(e), atMs: o.now() };
      if (down) stoppedNow.push(row.id);
    }
    if (entry) {
      acc = { ...acc, stopped: mergeStopped(acc.stopped, [entry]) };
      o.onProgress?.(acc); // durable at once: a Reprise reading the Bilan mid-trap must see what is already stopped
    }
  }
  return { containers: acc, lifted: false, stoppedNow };
}

/** Restart one list of stop entries; every outcome is reported (404 → `gone`, already running → `already-running`, anything else → `failed`). A transient `unavailable` / `timeout` is
 *  retried ONCE after a short pause (a daemon that blinked must not leave the member to `docker start` by hand). `deadlineAt` bounds the whole step: past it every remaining
 *  entry is recorded `failed: restart deadline exceeded` — a hung daemon never keeps the coordinators parked for ever. */
export async function restartContainers(
  api: PauseDockerApi,
  entries: readonly ContainerStopEntry[],
  now: () => number,
  o: { deadlineAt?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<ContainerRestartEntry[]> {
  const out: ContainerRestartEntry[] = [];
  const nap = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (const e of entries) {
    if (o.deadlineAt !== undefined && now() >= o.deadlineAt) {
      out.push({ id: e.id, outcome: 'failed', error: 'restart deadline exceeded', atMs: now() });
      continue;
    }
    let last: unknown;
    let done: ContainerRestartEntry | null = null;
    for (let attempt = 0; attempt < 2 && !done; attempt++) {
      try {
        done = { id: e.id, outcome: await api.startContainer(e.id), atMs: now() };
      } catch (err) {
        last = err;
        const transient = err instanceof DockerApiError && (err.kind === 'unavailable' || err.kind === 'timeout');
        if (!transient) break;
        await nap(1000);
      }
    }
    out.push(done ?? { id: e.id, outcome: 'failed', error: errText(last), atMs: now() });
  }
  return out;
}

export interface RestartOwedDeps {
  getBus(): BusDb | null;
  api: PauseDockerApi | null;
  /** The client for ONE member (the daemon its relay stamps on); falls back to `api`. */
  apiFor?: (wsId: string) => PauseDockerApi | null;
  now(): number;
  warn?: (msg: string, err?: unknown) => void;
  /** Total time one carrier's container step may take before the rest is recorded failed (default {@link RESTART_STEP_MS}). */
  stepMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

/** The container step of one Reprise is bounded: the coordinators are released after this long whatever Docker does. */
export const RESTART_STEP_MS = 5 * 60_000;

const restarting = new Set<string>();

/**
 * THE Reprise's container step (FI-1.7): for every RESUMING carrier, start EXACTLY the `outcome:'stopped'` entries (of every epoch of the carrier) that have no restart result yet,
 * and record the result on each row that owed it (`activity.containers.restarted`). The coordinators are released only after this (`beginRepriseCore` / `sweepReprise` hold them while
 * `containersOwed`), so a member's Consigne — and its first command — find its containers up. Same path for a manual, a human (UI) and an automatic Reprise. A failure is a recorded
 * `failed`, never a stuck Reprise; the step is time-bounded ({@link RESTART_STEP_MS}). One container id is started once even when two epochs owe it.
 */
export async function restartOwedContainers(deps: RestartOwedDeps): Promise<number> {
  const db = deps.getBus();
  if (!db) return 0;
  let carriers: Array<{ id: string; paused_at: number }>;
  try {
    carriers = db.prepare('SELECT id, paused_at FROM runs WHERE paused_at IS NOT NULL AND resume_started_at IS NOT NULL').all() as Array<{ id: string; paused_at: number }>;
  } catch (e) {
    deps.warn?.('pause-containers: could not read resuming carriers', e);
    return 0;
  }
  let n = 0;
  for (const c of carriers) {
    if (restarting.has(c.id)) continue;
    restarting.add(c.id);
    try {
      const owing = owedRows(db, c.id);
      if (owing.length === 0) continue;
      // one container id is started ONCE (even when two epochs owe it), through the client of the member that owned it
      const unique = new Map<string, { entry: ContainerStopEntry; wsId: string }>();
      for (const r of owing) for (const e of r.owed) if (!unique.has(e.id)) unique.set(e.id, { entry: e, wsId: r.wsId });
      const deadlineAt = deps.now() + (deps.stepMs ?? RESTART_STEP_MS);
      const results = new Map<string, ContainerRestartEntry>();
      const got: ContainerRestartEntry[] = [];
      for (const { entry, wsId } of unique.values()) {
        const api = deps.apiFor?.(wsId) ?? deps.api;
        got.push(...(api
          ? await restartContainers(api, [entry], deps.now, { deadlineAt, ...(deps.sleep ? { sleep: deps.sleep } : {}) })
          : [{ id: entry.id, outcome: 'failed' as const, error: 'Docker is not available to the host', atMs: deps.now() }]));
      }
      for (const r of got) results.set(r.id, r);
      for (const row of owing) {
        const mine = row.owed.map((e) => results.get(e.id)).filter((x): x is ContainerRestartEntry => !!x);
        updateBilanContainers(db, c.id, row.wsId, row.pausedAt, (cur) => ({ stopped: cur?.stopped ?? [], restarted: mergeRestarted(cur?.restarted, mine), ...(cur?.error ? { error: cur.error } : {}) }));
      }
      n += got.length;
    } catch (e) {
      deps.warn?.(`pause-containers: restart of carrier ${c.id} failed`, e);
    } finally {
      restarting.delete(c.id);
    }
  }
  return n;
}
