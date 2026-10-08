// #330 (wave H, ledger #329) — the main process's one place that arms a directory watch. Every `fs.watch` of a directory goes through `createWatcher()` (the pure state machine is src/shared/resilient-watch.ts):
// a watch that cannot be armed (EMFILE / ENOSPC / ENOENT) or that dies later is retried with backoff, its owner's catch-up pass runs on recovery, and the state of every watcher is readable here — the `/busStatus`
// payload (`watchers:` lines) and the `watchers:update` push to the renderer (edge-triggered: only when the DEGRADED set changes). Design + incident: docs/codebase-map/watchers.md.
import fs from 'node:fs';
import { createResilientWatcher, type ResilientWatcher, type ResilientWatchDeps, type ResilientWatchSpec, type WatchPrimitive, type WatcherSnapshot } from '../shared/resilient-watch.ts';
import { degradedKey, type WatchersStatus } from '../shared/watcher-status.ts';
import { log } from './logger.ts';
import { platform } from './platform/index.ts';

/** The channel the renderer listens on; the payload is a {@link WatchersStatus}. */
export const WATCHERS_UPDATE_CHANNEL = 'watchers:update';

/** The real primitive: `fs.watch` + its `error` event. Options stay the platform default (persistent) unless the site asked otherwise — exactly what the hand-rolled sites passed. */
const realWatch: WatchPrimitive = (dir, onEvent, onError, opts) => {
  const w = fs.watch(dir, opts?.persistent === undefined ? {} : { persistent: opts.persistent }, (event, filename) => onEvent(String(event), filename === null || filename === undefined ? null : String(filename)));
  w.on('error', onError);
  return { close: () => w.close() };
};

/**
 * Operator/rig fault injection (the precedent is `ORCHESTRA_BUS_WATCHER=off`): while the file named by `ORCHESTRA_WATCH_FAULT_FILE` EXISTS, every arm attempt throws EMFILE — the very error the kernel's per-user inotify
 * limit produces — so a built app can be driven through degrade → recovery by creating then deleting one file. Read at each arm, never cached. Never reproduces real exhaustion (#330: injected EMFILE only).
 */
export function faultFileFrom(env: NodeJS.ProcessEnv): string | null {
  const p = (env.ORCHESTRA_WATCH_FAULT_FILE || '').trim();
  return p.length > 0 ? p : null;
}
function withFaultInjection(inner: WatchPrimitive): WatchPrimitive {
  return (dir, onEvent, onError, opts) => {
    const f = faultFileFrom(process.env);
    if (f && fs.existsSync(f)) throw Object.assign(new Error(`EMFILE: too many open files, watch '${dir}' (injected: ${f} exists)`), { code: 'EMFILE' });
    return inner(dir, onEvent, onError, opts);
  };
}

let primitiveOverride: WatchPrimitive | null = null;
/** Rig/unit seam: replace the watch primitive (e.g. one that throws EMFILE for the first K arms). null restores the real one. Read at each arm. */
export function __setWatchPrimitiveForTests(p: WatchPrimitive | null): void {
  primitiveOverride = p;
}

const inodeOf = (dir: string): number | null => {
  try {
    return fs.statSync(dir).ino;
  } catch {
    return null;
  }
};

let healthMsOverride: number | undefined;
/** Rig seam: shorten the silent-detach health check (production: 30 s) so a built-app / composition drive does not wait half a minute. undefined restores it. */
export function __setWatchHealthMsForTests(ms: number | undefined): void {
  healthMsOverride = ms;
}

const productionDeps = (): ResilientWatchDeps => ({
  watch: (dir, onEvent, onError, opts) => (primitiveOverride ?? withFaultInjection(realWatch))(dir, onEvent, onError, opts),
  setTimer: (fn, ms) => {
    const t = setTimeout(fn, ms);
    t.unref?.(); // a pending retry must never keep the process alive (a CLI-less rig, a quit)
    return t;
  },
  clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  now: () => Date.now(),
  mkdirp: (d) => void fs.mkdirSync(d, { recursive: true }),
  inodeOf,
  get healthMs() {
    return healthMsOverride;
  },
  warn: (message, err) => log.warn(message, err),
  info: (message) => log.info(message),
});

// ─── The registry ──────────────────────────────────────────────────────────

const armed = new Set<ResilientWatcher>();
const listeners = new Set<(s: WatchersStatus) => void>();
let lastPushedKey = '';

/** Every ARMED watcher's state, sorted by name. A stopped watcher is not listed (a transient watch registers only while it runs). */
export function watchersStatus(now: number = Date.now()): WatchersStatus {
  return { at: now, watchers: [...armed].map((w) => w.snapshot()).sort((a, b) => a.name.localeCompare(b.name) || a.dir.localeCompare(b.dir)) };
}

function notifyIfChanged(): void {
  const s = watchersStatus();
  const key = degradedKey(s);
  if (key === lastPushedKey) return; // edge-triggered: a re-read of the same degraded set is not a transition
  lastPushedKey = key;
  for (const fn of [...listeners]) {
    try {
      fn(s);
    } catch (e) {
      log.warn('watchers: a status listener failed', e);
    }
  }
}

/** Subscribe to degraded-set changes (a watcher degraded, recovered, or was stopped while degraded). Returns the unsubscribe. */
export function onWatchersChange(fn: (s: WatchersStatus) => void): () => void {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}

/**
 * THE way to watch a directory in the main process. Same contract as the pure `createResilientWatcher`, plus: registered in the registry from `start()` to `stop()`, and a degradation / recovery is pushed to the
 * renderer (`watchers:update`) exactly once. The returned handle is idempotent.
 */
export function createWatcher(spec: ResilientWatchSpec): ResilientWatcher {
  const inner = createResilientWatcher({ ...spec, onTransition: (snap: WatcherSnapshot) => {
    try {
      spec.onTransition?.(snap);
    } finally {
      notifyIfChanged();
    }
  } }, productionDeps());
  let handle: ResilientWatcher;
  handle = {
    start() {
      armed.add(handle);
      inner.start();
    },
    stop() {
      armed.delete(handle); // first: the stop's own transition must already see the watcher gone
      inner.stop();
      notifyIfChanged();
    },
    snapshot: () => inner.snapshot(),
  };
  return handle;
}

/** Shutdown: stop every armed watcher (cancels every pending retry). */
export function stopAllWatchers(): void {
  for (const w of [...armed]) w.stop();
}

/** Boot: push each degraded-set change to the attached UI. Called once from index.ts; the returned fn unsubscribes. */
export function pushWatchersToRenderer(): () => void {
  return onWatchersChange((s) => {
    try {
      platform.broadcast(WATCHERS_UPDATE_CHANNEL, s);
    } catch (e) {
      log.warn('watchers: push to the renderer failed', e);
    }
  });
}

/** Test/rig seam: forget every armed watcher and listener (the watchers themselves are NOT stopped — call stopAllWatchers first). */
export function __resetWatchersForTests(): void {
  armed.clear();
  listeners.clear();
  lastPushedKey = '';
  primitiveOverride = null;
  healthMsOverride = undefined;
}
