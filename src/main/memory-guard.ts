// Memory guard — the SAMPLER half (#285, wave G ledger #295). Pure half: src/shared/memory-guard.ts (decision, cadence, settings).
// A light timer (reads ONE small file, never the process table) that measures MemAvailable through an injectable source, runs the
// pure decision, logs every transition WITH the memory at that moment, and exposes the state. It HOLDS NOTHING itself: #286
// (Admission), #288 (fast Veille), #289 (alert) and #290 (memory Pause) consume the API below. Map: docs/codebase-map/resources.md.
//
// STABLE API for downstream tracks (frozen on ledger #295):
//   getMemoryGuardSnapshot()  — the guard state (admission / pause / episode / thresholds / last MemAvailable)
//   subscribeMemoryGuard(fn)  — fn({transition, snapshot}) on every edge; returns an unsubscribe
//   sampleMemoryGuardNow()    — a FRESH reading + decision now (the re-measure between two releases)
//   decideMemoryGuard / isAdmissionHolding / mayReleaseOneStart / memoryPauseDue / memoryPauseLiftable — shared/memory-guard.ts

import { scoped } from './logger.ts';
import { readMemAvailableBytes } from './mem-available.ts';
import {
  DEFAULT_MEMORY_GUARD_SETTINGS,
  INITIAL_GUARD_STATE,
  SAMPLE_FAST_MS,
  decideMemoryGuard,
  formatGb,
  nextSampleDelayMs,
  normalizeMemoryGuardSettings,
  thresholdsFrom,
  type GuardState,
  type GuardTransition,
  type MemoryGuardSettings,
  type MemoryGuardSnapshot,
} from '../shared/memory-guard.ts';

export interface MemoryGuardDeps {
  /** The MemAvailable source (the test seam): bytes, or null = unreadable. */
  readAvailableBytes(): number | null;
  /** Read at EVERY sample, so a Settings change applies hot. */
  getSettings(): MemoryGuardSettings;
  now(): number;
  /** Arm one timer; the sampler re-arms after each sample because the delay changes (10 s / 60 s). */
  schedule(fn: () => void, ms: number): unknown;
  cancel(handle: unknown): void;
  info(message: string): void;
  warn(message: string, meta?: unknown): void;
}

export interface MemoryGuardTransitionEvent {
  transition: GuardTransition;
  /** The state AFTER the sample (every edge of one sample shares it). */
  snapshot: MemoryGuardSnapshot;
}
export type MemoryGuardListener = (e: MemoryGuardTransitionEvent) => void;

export interface MemoryGuard {
  start(): void;
  stop(): void;
  sampleNow(): MemoryGuardSnapshot;
  snapshot(): MemoryGuardSnapshot;
  subscribe(listener: MemoryGuardListener): () => void;
}

const glog = scoped('memory-guard');

export function realMemoryGuardDeps(over: Partial<MemoryGuardDeps> = {}): MemoryGuardDeps {
  return {
    readAvailableBytes: () => readMemAvailableBytes(),
    getSettings: () => DEFAULT_MEMORY_GUARD_SETTINGS,
    now: () => Date.now(),
    schedule: (fn, ms) => {
      const h = setTimeout(fn, ms);
      h.unref?.(); // the guard never keeps the process alive
      return h;
    },
    cancel: (h) => clearTimeout(h as NodeJS.Timeout),
    info: (m) => glog.info(m),
    warn: (m, meta) => glog.warn(m, meta),
    ...over,
  };
}

function describe(t: GuardTransition, enabled: boolean): string {
  const mem = `MemAvailable ${formatGb(t.availBytes, 2)}`;
  const thr = formatGb(t.thresholdBytes, 2);
  switch (t.kind) {
    case 'admission_held':
      return `admission HELD (episode ${t.episode}) — ${mem} < ${thr}${enabled ? '' : ' (toggle OFF: nothing is actually held)'}`;
    case 'admission_reopened':
      return `admission REOPENED (episode ${t.episode} over) — ${mem} > ${thr}`;
    case 'pause_due':
      return `memory Pause DUE (episode ${t.episode}) — ${mem} < critical ${thr}`;
    case 'pause_liftable':
      return `memory Pause LIFTABLE (episode ${t.episode}) — ${mem} > ${thr}`;
  }
}

export function createMemoryGuard(deps: MemoryGuardDeps): MemoryGuard {
  let state: GuardState = INITIAL_GUARD_STATE;
  let availBytes: number | null = null;
  let readAt: number | null = null;
  let measured = false;
  let heldSince: number | null = null;
  let pauseSince: number | null = null;
  let delayMs = SAMPLE_FAST_MS;
  let settings: MemoryGuardSettings = DEFAULT_MEMORY_GUARD_SETTINGS;
  let unreadableLogged = false;
  let started = false;
  let handle: unknown = null;
  const listeners = new Set<MemoryGuardListener>();

  function readSettings(): MemoryGuardSettings {
    try {
      return normalizeMemoryGuardSettings(deps.getSettings());
    } catch {
      return settings; // an unreadable store never changes the thresholds in force
    }
  }

  function snapshot(): MemoryGuardSnapshot {
    const t = thresholdsFrom(settings);
    return {
      measured,
      availBytes,
      readAt,
      admission: state.admission,
      admissionEnabled: settings.admissionEnabled,
      pause: state.pause,
      episode: state.episode,
      heldSince,
      pauseSince,
      admissionBytes: t.admissionBytes,
      criticalBytes: t.criticalBytes,
      releaseMarginBytes: t.releaseMarginBytes,
      sampleIntervalMs: delayMs,
    };
  }

  function sample(): MemoryGuardSnapshot {
    settings = readSettings();
    const t = thresholdsFrom(settings);
    let reading: number | null = null;
    try {
      reading = deps.readAvailableBytes();
    } catch {
      reading = null;
    }
    const now = deps.now();
    const d = decideMemoryGuard(state, reading, t);
    if (d.measured) {
      if (unreadableLogged) deps.info(`MemAvailable readable again — ${formatGb(reading as number, 2)}`);
      unreadableLogged = false;
      measured = true;
      availBytes = reading;
      readAt = now;
    } else {
      measured = false;
      if (!unreadableLogged) deps.warn('MemAvailable UNREADABLE — state unchanged, nothing new is decided until it reads again');
      unreadableLogged = true;
    }
    state = d.state;
    for (const tr of d.transitions) {
      if (tr.kind === 'admission_held') heldSince = now;
      else if (tr.kind === 'admission_reopened') heldSince = null;
      else if (tr.kind === 'pause_due') pauseSince = now;
      else pauseSince = null;
    }
    delayMs = nextSampleDelayMs(d.measured ? reading : null, t);
    const snap = snapshot();
    for (const tr of d.transitions) {
      const line = `${describe(tr, settings.admissionEnabled)}`;
      if (tr.kind === 'admission_held' || tr.kind === 'pause_due') deps.warn(line);
      else deps.info(line);
      for (const l of [...listeners]) {
        try {
          l({ transition: tr, snapshot: snap });
        } catch (e) {
          deps.warn('a transition listener threw (ignored)', e);
        }
      }
    }
    return snap;
  }

  function disarm(): void {
    if (handle !== null) deps.cancel(handle);
    handle = null;
  }

  function arm(): void {
    disarm();
    handle = deps.schedule(tick, delayMs);
  }

  function tick(): void {
    handle = null;
    try {
      sample();
    } catch (e) {
      delayMs = SAMPLE_FAST_MS;
      deps.warn('sample threw (will retry)', e);
    }
    if (started) arm();
  }

  return {
    start() {
      if (started) return;
      started = true;
      tick();
      deps.info(`started — sampling MemAvailable every ${delayMs / 1000}s`);
    },
    stop() {
      started = false;
      disarm();
    },
    sampleNow() {
      if (started) disarm();
      let snap: MemoryGuardSnapshot;
      try {
        snap = sample();
      } finally {
        if (started) arm();
      }
      return snap;
    },
    snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

// ─── The process-wide guard (index.ts starts it after store.load(); consumers import the facade below) ──────────────

let settingsReader: () => MemoryGuardSettings = () => DEFAULT_MEMORY_GUARD_SETTINGS;
let sourceOverride: (() => number | null) | null = null;
const listeners = new Set<MemoryGuardListener>();

function buildSingleton(over: Partial<MemoryGuardDeps> = {}): MemoryGuard {
  const g = createMemoryGuard(
    realMemoryGuardDeps({
      getSettings: () => settingsReader(),
      readAvailableBytes: () => (sourceOverride ? sourceOverride() : readMemAvailableBytes()),
      ...over,
    }),
  );
  g.subscribe((e) => {
    for (const l of [...listeners]) {
      try {
        l(e);
      } catch (err) {
        glog.warn('a transition listener threw (ignored)', err);
      }
    }
  });
  return g;
}
let singleton: MemoryGuard = buildSingleton();

/** Where the guard reads the thresholds (index.ts: the store). Read at every sample → hot. */
export function setMemoryGuardSettingsReader(fn: () => MemoryGuardSettings): void {
  settingsReader = fn;
}
export function startMemoryGuard(): void {
  singleton.start();
}
export function stopMemoryGuard(): void {
  singleton.stop();
}
export function getMemoryGuardSnapshot(): MemoryGuardSnapshot {
  return singleton.snapshot();
}
export function sampleMemoryGuardNow(): MemoryGuardSnapshot {
  return singleton.sampleNow();
}
export function subscribeMemoryGuard(listener: MemoryGuardListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Test/rig seam: replace the process-wide guard with one on injected deps (the memory source, the scheduler, the clock, the log).
 *  Stops the previous one; listeners and the settings reader survive. */
export function __rebuildMemoryGuardForTests(over: Partial<MemoryGuardDeps> = {}, source: (() => number | null) | null = null): MemoryGuard {
  singleton.stop();
  sourceOverride = source;
  singleton = buildSingleton(over);
  return singleton;
}
