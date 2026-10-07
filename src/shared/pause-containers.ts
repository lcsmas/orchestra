// A Pause dure stops the member's ATTRIBUTED containers; the Reprise restarts exactly those (#292, epic #284, ADR 0004, ledger #295 FI-1.3–1.8).
// Pure: the shapes the Bilan de pause records (`BilanActivity.containers`, JSON — no migration), the merge rules a trap RETRY needs, and the one
// question the Reprise asks ("which stops are still owed a restart?"). The effectful half is `src/main/pause-containers.ts`.

import { DOCKER_LABEL_WS } from './docker-labels.ts';

export type ContainerStopOutcome = 'stopped' | 'skipped-autoremove' | 'failed';
/** A container the Pause LOOKED at because it carried the member's `orchestra.ws` label while running. Only `outcome:'stopped'` is ever restarted. */
export interface ContainerStopEntry {
  id: string;
  name: string;
  image: string;
  /** The `orchestra.run` label the relay stamped (the member's own run at create time), or null. */
  run: string | null;
  outcome: ContainerStopOutcome;
  error?: string;
  atMs: number;
}

export type ContainerRestartOutcome = 'started' | 'already-running' | 'gone' | 'failed';
export interface ContainerRestartEntry {
  id: string;
  outcome: ContainerRestartOutcome;
  error?: string;
  atMs: number;
}

export interface BilanContainers {
  stopped: ContainerStopEntry[];
  restarted?: ContainerRestartEntry[];
  /** The listing itself failed (Docker unavailable / API error): recorded, never blocks the trap or keeps it incomplete. */
  error?: string;
}

/** The label filter selecting what the relay attributed to one workspace — the ONLY thing a Pause may stop (FI-1.3). */
export function attributedLabelFilter(wsId: string): string {
  return `${DOCKER_LABEL_WS}=${wsId}`;
}

/** Entries kept per member (a runaway compose stack must not make a Bilan row unbounded). */
export const MAX_CONTAINER_ENTRIES = 200;

/**
 * Merge a trap RETRY's stop entries into what an earlier attempt recorded — BY ID, never stopping or listing a container twice:
 * an earlier `stopped` / `skipped-autoremove` entry is final (the container is no longer running, or was never ours to stop);
 * an earlier `failed` entry is replaced by the retry's fresh outcome. New ids are appended.
 */
export function mergeStopped(prior: readonly ContainerStopEntry[] | undefined, fresh: readonly ContainerStopEntry[]): ContainerStopEntry[] {
  const out = new Map<string, ContainerStopEntry>();
  for (const e of prior ?? []) out.set(e.id, e);
  for (const e of fresh) {
    const had = out.get(e.id);
    if (!had || had.outcome === 'failed') out.set(e.id, e);
  }
  return [...out.values()].slice(0, MAX_CONTAINER_ENTRIES);
}

/** Merge restart results BY ID — the newest result for an id wins (a `failed` retried later may become `started`). */
export function mergeRestarted(prior: readonly ContainerRestartEntry[] | undefined, fresh: readonly ContainerRestartEntry[]): ContainerRestartEntry[] {
  const out = new Map<string, ContainerRestartEntry>();
  for (const e of prior ?? []) out.set(e.id, e);
  for (const e of fresh) out.set(e.id, e);
  return [...out.values()].slice(0, MAX_CONTAINER_ENTRIES);
}

/**
 * Merge an OVERLAY (the result of the call that is writing now) onto the row's current value (`base`, possibly written by a concurrent writer): stops merged by
 * id, restarts by id, and the ERROR is the overlay's alone — a later attempt that succeeded must not inherit an earlier attempt's "Docker down".
 */
export function mergeContainers(base: BilanContainers | undefined, overlay: BilanContainers | undefined): BilanContainers | undefined {
  if (!base && !overlay) return undefined;
  const stopped = mergeStopped(base?.stopped, overlay?.stopped ?? []);
  const restarted = mergeRestarted(base?.restarted, overlay?.restarted ?? []);
  const error = overlay ? overlay.error : base?.error;
  return { stopped, ...(restarted.length ? { restarted } : {}), ...(error ? { error } : {}) };
}

/** Is there anything worth writing on a Bilan row? A member with no attributed container (and no error) keeps its row byte-identical to before #292. */
export function hasContainerFacts(c: BilanContainers | undefined | null): c is BilanContainers {
  return !!c && (c.stopped.length > 0 || !!c.error || (c.restarted?.length ?? 0) > 0);
}

/** The `outcome:'stopped'` entries that still have NO restart result — exactly what the Reprise owes (FI-1.7). A `failed` restart counts as attempted: reported, never retried forever. */
export function owedRestarts(c: BilanContainers | undefined | null): ContainerStopEntry[] {
  if (!c) return [];
  const done = new Set((c.restarted ?? []).map((r) => r.id));
  return c.stopped.filter((s) => s.outcome === 'stopped' && !done.has(s.id));
}

/** The Consigne lines for a member's containers; [] when the Pause touched none. Names/images are recorded text: callers strip control characters. */
export function containerConsigneLines(c: BilanContainers | undefined | null, strip: (s: string) => string): string[] {
  if (!c) return [];
  const out: string[] = [];
  const restarted = new Map((c.restarted ?? []).map((r) => [r.id, r]));
  const stopped = c.stopped.filter((s) => s.outcome === 'stopped');
  if (stopped.length) {
    out.push(`Containers the Pause STOPPED for you (${stopped.length}; stopped, never removed — their volumes are intact):`);
    for (const s of stopped.slice(0, 20)) {
      const r = restarted.get(s.id);
      const state = !r
        ? 'NOT restarted yet — the host is restarting it, check `docker ps`'
        : r.outcome === 'started'
          ? 'restarted by the Reprise'
          : r.outcome === 'already-running'
            ? 'already running again'
            : r.outcome === 'gone'
              ? 'GONE (removed while the Pause lasted) — nothing to restart'
              : `restart FAILED${r.error ? ` (${strip(r.error).slice(0, 120)})` : ''} — start it yourself: docker start ${strip(s.name || s.id).slice(0, 80)}`;
      out.push(`  - ${strip(s.name || s.id).slice(0, 80)} (${strip(s.image).slice(0, 80)}) — ${state}`);
    }
    if (stopped.length > 20) out.push(`  - … +${stopped.length - 20} more (orchestra run status)`);
  }
  const skipped = c.stopped.filter((s) => s.outcome === 'skipped-autoremove');
  if (skipped.length) out.push(`Containers the Pause did NOT stop because they are \`--rm\` (stopping would delete them): ${skipped.slice(0, 8).map((s) => strip(s.name || s.id).slice(0, 60)).join(', ')} — still running.`);
  const failed = c.stopped.filter((s) => s.outcome === 'failed');
  if (failed.length) out.push(`Containers the Pause could NOT stop (${failed.length}): ${failed.slice(0, 8).map((s) => `${strip(s.name || s.id).slice(0, 60)}${s.error ? ` (${strip(s.error).slice(0, 80)})` : ''}`).join('; ')} — still running.`);
  if (c.error) out.push(`Containers: the host could not list or stop your containers (${strip(c.error).slice(0, 160)}) — check \`docker ps\` yourself.`);
  return out;
}
