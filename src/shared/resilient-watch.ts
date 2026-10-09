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
  /** Directory BIRTH time in ms (null = missing or the filesystem does not record one). With the inode it proves « still the very directory I armed on » when the directory's own `rename` event arrives (a chmod/touch of it sends the same event). */
  birthOf?(dir: string): number | null;
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
/** A re-armed watch must stay up this long before its backoff starts over: one that dies right after every arm keeps climbing the schedule instead of re-arming every second forever. */
export const WATCH_STABLE_MS = 60_000;

export function describeWatchError(e: unknown): WatchErrorInfo {
  const o = e as { code?: unknown; message?: unknown } | null | undefined;
  const code = typeof o?.code === 'string' ? o.code : null;
  // an Error, or a plain `{code, message}` (the health check's own): read the message, never `String({})` (« [object Object] »)
  const message = typeof o?.message === 'string' ? o.message : String(e);
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
  let failStreak = 0; // index into the backoff schedule; reset only after a watch has stayed up WATCH_STABLE_MS
  let armedAt: number | null = null;
  let recoveries = 0;
  let handle: WatchHandle | null = null;
  let gen = 0; // a callback of an OLDER watch (closed, replaced) must never act
  let armedIno: number | null = null;
  let armedBirth: number | null = null;
  let retryTimer: unknown = null;
  let healthTimer: unknown = null;

  const dirName = spec.dir.replace(/\/+$/, '').split('/').pop() ?? ''; // basename of the watched directory (events about the directory itself carry this name); '' = nothing to match
  const selfNames = dirName === '' ? [] : [dirName, spec.dir.split('/').pop() ?? '']; // libuv names a self event after the path AS GIVEN: a trailing '/' makes it '' (#330 review m2)
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

  /** True only when the directory is PROVABLY the one we armed on (same inode AND a recorded, equal birth time): a chmod/touch of it is then not a removal. Anything unproven counts as replaced — a missed removal is silent staleness. */
  const stillTheSameDir = (): boolean => {
    if (!deps.inodeOf || !deps.birthOf || armedIno === null || armedBirth === null) return false;
    const ino = deps.inodeOf(spec.dir);
    const birth = deps.birthOf(spec.dir);
    return ino === armedIno && birth !== null && birth === armedBirth;
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
    if (state === 'ok' && armedAt !== null && deps.now() - armedAt >= WATCH_STABLE_MS) failStreak = 0; // it had been healthy long enough: a new incident starts at the first step
    failStreak++;
    if (state !== 'degraded') {
      state = 'degraded';
      since = deps.now();
      // edge-triggered: ONE line per degradation (a failed retry is silent)
      deps.warn(`watcher[${spec.name}]: DEGRADED — ${plainWatchError(info)}; retrying with backoff, fallback keeps running: ${spec.fallback} (${spec.label})`, e);
      transition();
    }
    if (stopped) return; // a listener stopped us from inside the transition: no retry to schedule
    const delay = WATCH_BACKOFF_MS[Math.min(failStreak - 1, WATCH_BACKOFF_MS.length - 1)];
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
      const ino0 = deps.inodeOf ? deps.inodeOf(spec.dir) : null; // sampled BEFORE the watch: a directory swapped in between fails safe (one spurious re-arm), never silently pinned to the old one
      const birth0 = deps.birthOf ? deps.birthOf(spec.dir) : null;
      const h = deps.watch(
        spec.dir,
        (event, filename) => {
          if (stopped || myGen !== gen) return;
          // The directory ITSELF was removed or renamed: the kernel says so with a `rename` named like the directory (measured on btrfs and tmpfs) and the inotify watch is dead from then on — no `error`, no more events. Do not wait for the
          // 30 s inode check (which a filesystem that reuses the inode number never trips): re-arm now. Before the site's filter, which would drop this event. (#330 review m1; the same inode + birth time proves a chmod/touch/same-named child of a LIVE directory, which then flows on as a normal event.)
          if (event === 'rename' && filename !== null && selfNames.includes(filename) && !stillTheSameDir()) {
            degrade({ code: 'ESTALE', message: `watched directory was removed or renamed: ${spec.dir}` });
            return;
          }
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
      armedIno = ino0;
      armedBirth = birth0;
      armedAt = deps.now();
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
    if (stopped) return; // stopped from inside onArmed: no catch-up for a watcher nobody owns any more
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
