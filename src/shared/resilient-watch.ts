// #330 (wave H, ledger #329; D-add) — a directory watch that HEALS ITSELF. PURE state machine: the watch primitive, the timers, the clock and the logger are injected, so `node --test` drives it with a fake
// clock and a scripted primitive. Production wiring (real `fs.watch`, the registry, the 7 sites): src/main/watchers.ts. Design + incident: docs/codebase-map/watchers.md.
//
// The failure it ends (2026-10-08, app v0.5.316): the per-user inotify instance limit was exhausted when the app booted, every `fs.watch` threw EMFILE, each site logged ONE warning and never tried again —
// the Réveil engine rode its 60 s sweep, the sidebar kept « en pause » after the Reprise, for as long as the app ran. A watch that cannot be armed (EMFILE / ENOSPC / a missing directory) or that dies later is
// RETRIED with a bounded backoff until it is back; the subsystem's existing fallback (sweep / poll / pull) keeps working meanwhile, and ONE catch-up pass runs on recovery so a change written while degraded is not missed.

export type WatchState = 'ok' | 'degraded';

export interface WatchErrorInfo {
  /** `err.code` (EMFILE, ENOSPC, ENOENT …) or null. */
  code: string | null;
  message: string;
}

/** What the registry, `bus-status` and the app's warning read. */
export interface WatcherSnapshot {
  /** Stable machine name (`bus-wake`). */
  name: string;
  /** Plain words for the human (`Réveils`) — what is affected. */
  label: string;
  dir: string;
  state: WatchState;
  /** Epoch ms of the last state change (armed → ok, failed → degraded). */
  since: number;
  /** The last arm / runtime error; null while ok. */
  lastError: WatchErrorInfo | null;
  /** Arm attempts since it degraded (0 while ok). */
  attempts: number;
  /** How many times it came back. */
  recoveries: number;
  /** What keeps the subsystem working while this watch is down (`60 s sweep`). */
  fallback: string;
}

export interface WatchHandle {
  close(): void;
}
/** The watch primitive. Throws on an arm failure; reports a later death through `onError`. */
export type WatchPrimitive = (
  dir: string,
  onEvent: (event: string, filename: string | null) => void,
  onError: (e: unknown) => void,
  opts?: { persistent?: boolean },
) => WatchHandle;

export interface ResilientWatchDeps {
  watch: WatchPrimitive;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  /** Wall clock (for `since` only — never for the backoff, so a clock step cannot stall or spin it). */
  now(): number;
  mkdirp?(dir: string): void;
  /** Directory inode (null = missing): the health check that catches a SILENT detach (a deleted and recreated directory; an inotify watch does not follow it and never emits `error`). */
  inodeOf?(dir: string): number | null;
  /** Health-check period (default {@link WATCH_HEALTH_MS}); a rig shortens it. */
  healthMs?: number;
  warn(message: string, err?: unknown): void;
  info(message: string): void;
}

export interface ResilientWatchSpec {
  name: string;
  label: string;
  dir: string;
  fallback: string;
  onChange(filename: string | null, event: string): void;
  /** false = ignore this event. A null filename is the caller's call (the sites treat it as a match: a spurious idempotent pass beats a missed one). */
  filter?(filename: string | null): boolean;
  /** ONE catch-up pass after a RECOVERY — never after the first arm. */
  onRecover?(): void;
  /** After EVERY successful arm (the first too): the site's own « armed » log line. */
  onArmed?(info: { recovered: boolean }): void;
  /** On every state change (ok ⇄ degraded) and on stop. */
  onTransition?(snap: WatcherSnapshot): void;
  ensureDir?: boolean;
  persistent?: boolean;
}

export interface ResilientWatcher {
  /** Arm now (synchronously, as the hand-rolled sites did). Idempotent. */
  start(): void;
  /** Cancel every pending retry and close the watch. Idempotent. */
  stop(): void;
  snapshot(): WatcherSnapshot;
}

/** Fast first retries, then capped (story 15): 1 s, 2 s, 5 s, 15 s, 30 s, then every 60 s. */
export const WATCH_BACKOFF_MS: readonly number[] = [1_000, 2_000, 5_000, 15_000, 30_000, 60_000];
/** How often a healthy watch is checked against its directory's inode. */
export const WATCH_HEALTH_MS = 30_000;

export function describeWatchError(e: unknown): WatchErrorInfo {
  const code = typeof (e as { code?: unknown })?.code === 'string' ? ((e as { code: string }).code) : null;
  const message = e instanceof Error ? e.message : String(e);
  return { code, message };
}

/** « system watch limit reached (EMFILE) » for the two kernel limits; the raw message otherwise. */
export function plainWatchError(info: WatchErrorInfo): string {
  if (info.code === 'EMFILE' || info.code === 'ENOSPC') return `system watch limit reached (${info.code})`;
  if (info.code === 'ENOENT') return 'directory missing (ENOENT)';
  return info.code ? `${info.message} (${info.code})` : info.message;
}

export function createResilientWatcher(spec: ResilientWatchSpec, deps: ResilientWatchDeps): ResilientWatcher {
  let state: WatchState = 'ok';
  let started = false;
  let stopped = false;
  let since = deps.now();
  let lastError: WatchErrorInfo | null = null;
  let attempts = 0;
  let recoveries = 0;
  let handle: WatchHandle | null = null;
  let gen = 0; // a callback of an OLDER watch (closed, replaced) must never act
  let armedIno: number | null = null;
  let retryTimer: unknown = null;
  let healthTimer: unknown = null;

  const snapshot = (): WatcherSnapshot => ({ name: spec.name, label: spec.label, dir: spec.dir, state, since, lastError: lastError ? { ...lastError } : null, attempts, recoveries, fallback: spec.fallback });
  const transition = (): void => {
    try {
      spec.onTransition?.(snapshot());
    } catch (e) {
      deps.warn(`watcher[${spec.name}]: transition listener failed`, e);
    }
  };
  const closeHandle = (): void => {
    gen++;
    const h = handle;
    handle = null;
    try {
      h?.close();
    } catch {
      /* already closed */
    }
  };
  const clearTimers = (): void => {
    if (retryTimer !== null) deps.clearTimer(retryTimer);
    if (healthTimer !== null) deps.clearTimer(healthTimer);
    retryTimer = null;
    healthTimer = null;
  };

  const scheduleHealth = (): void => {
    if (!deps.inodeOf || stopped) return;
    healthTimer = deps.setTimer(() => {
      healthTimer = null;
      if (stopped || state !== 'ok') return;
      const ino = deps.inodeOf!(spec.dir);
      if (ino === null) degrade({ code: 'ENOENT', message: `watched directory vanished: ${spec.dir}` });
      else if (armedIno !== null && ino !== armedIno) degrade({ code: 'ESTALE', message: `watched directory was replaced (inode ${armedIno} → ${ino}): ${spec.dir}` });
      else scheduleHealth();
    }, deps.healthMs ?? WATCH_HEALTH_MS);
  };

  function degrade(e: unknown): void {
    if (stopped) return;
    closeHandle();
    if (healthTimer !== null) deps.clearTimer(healthTimer);
    healthTimer = null;
    if (retryTimer !== null) deps.clearTimer(retryTimer);
    retryTimer = null;
    const info = describeWatchError(e);
    lastError = info;
    attempts++;
    if (state !== 'degraded') {
      state = 'degraded';
      since = deps.now();
      // edge-triggered: ONE line per degradation (a failed retry is silent)
      deps.warn(`watcher[${spec.name}]: DEGRADED — ${plainWatchError(info)}; retrying with backoff, fallback keeps running: ${spec.fallback} (${spec.label})`, e);
      transition();
    }
    const delay = WATCH_BACKOFF_MS[Math.min(attempts - 1, WATCH_BACKOFF_MS.length - 1)];
    retryTimer = deps.setTimer(() => {
      retryTimer = null;
      arm();
    }, delay);
  }

  function arm(): void {
    if (stopped) return;
    const myGen = ++gen;
    try {
      if (spec.ensureDir) deps.mkdirp?.(spec.dir);
      const h = deps.watch(
        spec.dir,
        (event, filename) => {
          if (stopped || myGen !== gen) return;
          if (spec.filter && !spec.filter(filename)) return;
          spec.onChange(filename, event);
        },
        (err) => {
          if (stopped || myGen !== gen) return; // a stale watch's error is not this watch's
          degrade(err);
        },
        spec.persistent === undefined ? undefined : { persistent: spec.persistent },
      );
      if (stopped || myGen !== gen) {
        try {
          h.close();
        } catch {
          /* ignore */
        }
        return;
      }
      handle = h;
      armedIno = deps.inodeOf ? deps.inodeOf(spec.dir) : null;
    } catch (e) {
      degrade(e);
      return;
    }
    const recovered = state === 'degraded';
    if (recovered) {
      const downMs = Math.max(0, deps.now() - since);
      state = 'ok';
      since = deps.now();
      lastError = null;
      attempts = 0;
      recoveries++;
      deps.info(`watcher[${spec.name}]: RECOVERED after ${Math.round(downMs / 1000)} s — directory watch re-armed (${spec.label})`);
      transition();
    }
    scheduleHealth();
    try {
      spec.onArmed?.({ recovered });
    } catch (e) {
      deps.warn(`watcher[${spec.name}]: onArmed failed`, e);
    }
    if (recovered) {
      try {
        spec.onRecover?.(); // the catch-up pass: whatever was written while the watch was down
      } catch (e) {
        deps.warn(`watcher[${spec.name}]: catch-up pass failed`, e);
      }
    }
  }

  return {
    start() {
      if (started || stopped) return;
      started = true;
      arm();
    },
    stop() {
      if (stopped) return;
      stopped = true;
      clearTimers();
      closeHandle();
      transition();
    },
    snapshot,
  };
}
