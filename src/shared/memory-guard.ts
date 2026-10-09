// Memory guard — the PURE half (#285, wave G ledger #295, epic #284; CONTEXT.md "Admission" / "Pause automatique", ADR 0004).
// Impure half (sampler, logging, subscription): src/main/memory-guard.ts. This module is #286/#288/#289/#290's contract.
//
// Two thresholds on the host's MemAvailable. Below the ADMISSION threshold automatic fleet starts are held and idle members go
// into Veille; below the CRITICAL threshold a memory Pause is due. Hysteresis: Admission reopens only ABOVE threshold + margin,
// the memory Pause lifts only ABOVE the Admission threshold. One episode per downward crossing of the Admission threshold.
// This track holds NOTHING — it measures, decides and exposes; consumers act on the decision.
// "GB" everywhere is GiB (1024³), the unit of `awk '$2 > 6*1048576' /proc/meminfo` the wave's launch rule uses.

export const GIB = 1024 ** 3;
export const DEFAULT_ADMISSION_GB = 6;
export const DEFAULT_CRITICAL_GB = 3;
/** Plafond mémoire levels (#320, ADR 0005): the soft level slows a member, the hard level is what the kernel kills at. Values from 48 k monitor samples (running member p99 3.1 GB, max 6.3 GB). */
export const DEFAULT_CAP_SOFT_GB = 3;
export const DEFAULT_CAP_HARD_GB = 6;
/** Admission reopens, and a held start may go out, only ABOVE admission threshold + this margin (epic #284 "Pure decision module"). */
export const RELEASE_MARGIN_GB = 1;
/** Sampling cadence: fast while MemAvailable is below the Admission threshold, slow otherwise (epic #284 "Memory signal"). */
export const SAMPLE_FAST_MS = 10_000;
export const SAMPLE_SLOW_MS = 60_000;

// ─── Settings (Settings → thresholds in GB + the global Admission/fast-Veille toggle) ──────────────────────────────

export interface MemoryGuardSettings {
  /** Below this MemAvailable (GB) Admission is held. */
  admissionGb: number;
  /** Below this MemAvailable (GB) a memory Pause is due. Must be below `admissionGb`. */
  criticalGb: number;
  /** Global toggle of the Admission hold (#286) and the fast Veille (#288). Default ON. The guard measures, decides, logs and shows
   *  either way; the Pause is governed by each run's `pause` switch, not by this toggle. */
  admissionEnabled: boolean;
  /** Plafond mémoire soft level (GB) — read at each fleet member's session start (#320; the UI is #323). Must be below `capHardGb`. */
  capSoftGb: number;
  /** Plafond mémoire hard level (GB): the scope's `MemoryMax`. */
  capHardGb: number;
  /** Veille and Reliquats (#326): how long (minutes) an idle member with LIVE Reliquats waits before its Veille, which then stops and lists them. Never shorter than the normal
   *  Veille threshold; fast Veille (#288, Admission held) ignores it. Its own scalar: a bad value falls back to the default without resetting any other setting. UI: #323. */
  reliquatWaitMin: number;
}

export const DEFAULT_RELIQUAT_WAIT_MIN = 30;
/** A typed Reliquat delay outside this range is refused (0 would make the wait vanish; a day is already « never »). */
export const MIN_RELIQUAT_WAIT_MIN = 1;
export const MAX_RELIQUAT_WAIT_MIN = 24 * 60;

export const DEFAULT_MEMORY_GUARD_SETTINGS: MemoryGuardSettings = {
  admissionGb: DEFAULT_ADMISSION_GB,
  criticalGb: DEFAULT_CRITICAL_GB,
  admissionEnabled: true,
  capSoftGb: DEFAULT_CAP_SOFT_GB,
  capHardGb: DEFAULT_CAP_HARD_GB,
  reliquatWaitMin: DEFAULT_RELIQUAT_WAIT_MIN,
};

/** True when Admission, once held at this threshold, could never reopen on a machine with `totalBytes` of memory. */
export function thresholdUnreachable(admissionGb: number, totalBytes: number): boolean {
  return (admissionGb + RELEASE_MARGIN_GB) * GIB >= totalBytes;
}

/** Sanity bounds of a typed threshold: a 0 / 1000 GB typo is refused, not applied. */
export const MIN_CRITICAL_GB = 0.5;
export const MAX_ADMISSION_GB = 256;
/** A Plafond mémoire hard level below this is refused (a rig may go down to ~0.25 GB; a typo of 0 would kill every member's tool). */
export const MIN_CAP_HARD_GB = 0.1;

function isGb(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/** Why `next` (already merged over the current settings) cannot be applied, or null when it can. `totalBytes` (MemTotal, when readable)
 *  bounds the Admission threshold: Admission reopens only ABOVE threshold + margin and MemAvailable can never exceed MemTotal, so a
 *  threshold whose reopen point is at or above the machine's memory would hold forever once held. */
export function validateMemoryGuardSettings(s: MemoryGuardSettings, totalBytes?: number | null): string | null {
  if (!isGb(s.admissionGb) || !isGb(s.criticalGb)) return 'thresholds must be numbers';
  if (typeof s.admissionEnabled !== 'boolean') return 'the toggle must be true or false';
  if (s.criticalGb < MIN_CRITICAL_GB) return `the critical threshold must be at least ${MIN_CRITICAL_GB} GB`;
  if (s.admissionGb > MAX_ADMISSION_GB) return `the Admission threshold must be at most ${MAX_ADMISSION_GB} GB`;
  if (!(s.criticalGb < s.admissionGb)) return `the critical threshold (${s.criticalGb} GB) must be below the Admission threshold (${s.admissionGb} GB)`;
  if (!isGb(s.capSoftGb) || !isGb(s.capHardGb)) return 'the memory cap levels must be numbers';
  if (s.capHardGb < MIN_CAP_HARD_GB) return `the memory cap hard level must be at least ${MIN_CAP_HARD_GB} GB`;
  if (s.capHardGb > MAX_ADMISSION_GB) return `the memory cap hard level must be at most ${MAX_ADMISSION_GB} GB`;
  if (!(s.capSoftGb > 0 && s.capSoftGb < s.capHardGb)) return `the memory cap soft level (${s.capSoftGb} GB) must be above 0 and below the hard level (${s.capHardGb} GB)`;
  if (!isGb(s.reliquatWaitMin) || s.reliquatWaitMin < MIN_RELIQUAT_WAIT_MIN || s.reliquatWaitMin > MAX_RELIQUAT_WAIT_MIN) return `the Reliquat wait must be between ${MIN_RELIQUAT_WAIT_MIN} and ${MAX_RELIQUAT_WAIT_MIN} minutes`;
  if (typeof totalBytes === 'number' && totalBytes > 0 && thresholdUnreachable(s.admissionGb, totalBytes)) {
    return `the Admission threshold (${s.admissionGb} GB) plus the ${RELEASE_MARGIN_GB} GB reopen margin must be below this machine's memory (${(totalBytes / GIB).toFixed(1)} GB)`;
  }
  return null;
}

/** Complete, VALID settings from whatever the store holds (absent / malformed → the defaults; an invalid PAIR falls back to the
 *  defaults as a pair, never to a half-valid one). */
export function normalizeMemoryGuardSettings(raw: Partial<MemoryGuardSettings> | undefined | null): MemoryGuardSettings {
  const candidate: MemoryGuardSettings = {
    admissionGb: isGb(raw?.admissionGb) ? raw.admissionGb : DEFAULT_ADMISSION_GB,
    criticalGb: isGb(raw?.criticalGb) ? raw.criticalGb : DEFAULT_CRITICAL_GB,
    admissionEnabled: typeof raw?.admissionEnabled === 'boolean' ? raw.admissionEnabled : true,
    capSoftGb: isGb(raw?.capSoftGb) ? raw.capSoftGb : DEFAULT_CAP_SOFT_GB,
    capHardGb: isGb(raw?.capHardGb) ? raw.capHardGb : DEFAULT_CAP_HARD_GB,
    // its own scalar: out of range / not a number ⇒ the default, and never the reason another setting is reset
    reliquatWaitMin: isGb(raw?.reliquatWaitMin) && raw.reliquatWaitMin >= MIN_RELIQUAT_WAIT_MIN && raw.reliquatWaitMin <= MAX_RELIQUAT_WAIT_MIN ? raw.reliquatWaitMin : DEFAULT_RELIQUAT_WAIT_MIN,
  };
  if (validateMemoryGuardSettings(candidate) === null) return candidate;
  // Each PAIR falls back as a pair: a bad cap pair must not reset the thresholds, nor the reverse.
  const thresholdsOk = validateMemoryGuardSettings({ ...candidate, capSoftGb: DEFAULT_CAP_SOFT_GB, capHardGb: DEFAULT_CAP_HARD_GB }) === null;
  const capOk = validateMemoryGuardSettings({ ...candidate, admissionGb: DEFAULT_ADMISSION_GB, criticalGb: DEFAULT_CRITICAL_GB }) === null;
  return {
    admissionGb: thresholdsOk ? candidate.admissionGb : DEFAULT_ADMISSION_GB,
    criticalGb: thresholdsOk ? candidate.criticalGb : DEFAULT_CRITICAL_GB,
    admissionEnabled: candidate.admissionEnabled,
    capSoftGb: capOk ? candidate.capSoftGb : DEFAULT_CAP_SOFT_GB,
    capHardGb: capOk ? candidate.capHardGb : DEFAULT_CAP_HARD_GB,
    reliquatWaitMin: candidate.reliquatWaitMin,
  };
}

// ─── Thresholds ────────────────────────────────────────────────────────────────────────────────────────────────────

export interface GuardThresholds {
  admissionBytes: number;
  criticalBytes: number;
  releaseMarginBytes: number;
}

export function thresholdsFrom(s: MemoryGuardSettings): GuardThresholds {
  return { admissionBytes: s.admissionGb * GIB, criticalBytes: s.criticalGb * GIB, releaseMarginBytes: RELEASE_MARGIN_GB * GIB };
}

export const DEFAULT_THRESHOLDS: GuardThresholds = thresholdsFrom(DEFAULT_MEMORY_GUARD_SETTINGS);

// ─── The decision ──────────────────────────────────────────────────────────────────────────────────────────────────

export type AdmissionState = 'open' | 'held';
/** `held` = the memory Pause is wanted in effect (it began at a `pause_due` and has not yet become liftable). */
export type MemoryPauseState = 'none' | 'held';
/** What the memory Pause should do NOW: `due` = impose it, `held` = keep it, `liftable` = lift it, `none` = nothing. */
export type MemoryPauseAction = 'none' | 'due' | 'held' | 'liftable';

export interface GuardState {
  admission: AdmissionState;
  pause: MemoryPauseState;
  /** Counts downward crossings of the Admission threshold; 0 = none yet. Constant while an episode lasts. */
  episode: number;
  /** Counts memory Pauses (`pause_due` edges); 0 = none yet. A 2nd Pause inside ONE Admission episode has the same `episode` but the next
   *  `pauseCycle`, so "one alert per episode" (#289) and the Pause/Reprise bookkeeping (#290) can tell the cycles apart. */
  pauseCycle: number;
}

export const INITIAL_GUARD_STATE: GuardState = { admission: 'open', pause: 'none', episode: 0, pauseCycle: 0 };

export type GuardTransitionKind = 'admission_held' | 'admission_reopened' | 'pause_due' | 'pause_liftable';

export interface GuardTransition {
  kind: GuardTransitionKind;
  /** The Admission episode this transition belongs to (for `admission_reopened`, the one that just ended). */
  episode: number;
  /** The memory-Pause cycle at this edge (`pause_due` opens a new one; `pause_liftable` closes the cycle it names). */
  pauseCycle: number;
  /** MemAvailable at the moment of the transition. */
  availBytes: number;
  /** The threshold whose comparison fired it: the Admission threshold, the critical one, or Admission + margin (reopened). */
  thresholdBytes: number;
}

export interface GuardDecision {
  /** False when the memory could not be read: the state is returned UNCHANGED and nothing fires (unknown ≠ plenty ≠ critical). */
  measured: boolean;
  /** The next state. */
  state: GuardState;
  /** Edges crossed by THIS sample, in order. */
  transitions: GuardTransition[];
  pause: MemoryPauseAction;
  /** One held start may go out now: memory is above threshold + margin. Re-decide on a FRESH reading before the next release. */
  mayReleaseOneStart: boolean;
}

/** A usable reading: a finite, non-negative number of bytes. */
export function isMeasured(availBytes: number | null | undefined): availBytes is number {
  return typeof availBytes === 'number' && Number.isFinite(availBytes) && availBytes >= 0;
}

/** Level predicates (stateless — #290 re-evaluates them against the PERSISTED run state after an app restart, when the in-memory
 *  guard state is gone). Strict comparisons: exactly AT a threshold is not below / above it. */
export function memoryPauseDue(availBytes: number, t: GuardThresholds): boolean {
  return availBytes < t.criticalBytes;
}
export function memoryPauseLiftable(availBytes: number, t: GuardThresholds): boolean {
  return availBytes > t.admissionBytes;
}
/** True when memory is back far enough for a held start to go out (and for Admission to reopen). */
export function mayReleaseOneStart(availBytes: number, t: GuardThresholds): boolean {
  return availBytes > t.admissionBytes + t.releaseMarginBytes;
}

/** The pure transition function: previous state + one reading → next state, the edges crossed, and what is due. */
export function decideMemoryGuard(prev: GuardState, availBytes: number | null | undefined, t: GuardThresholds): GuardDecision {
  if (!isMeasured(availBytes)) {
    return { measured: false, state: prev, transitions: [], pause: prev.pause === 'held' ? 'held' : 'none', mayReleaseOneStart: false };
  }
  const transitions: GuardTransition[] = [];
  let { admission, pause, episode, pauseCycle } = prev;

  if (admission === 'open' && availBytes < t.admissionBytes) {
    admission = 'held';
    episode += 1;
    transitions.push({ kind: 'admission_held', episode, pauseCycle, availBytes, thresholdBytes: t.admissionBytes });
  } else if (admission === 'held' && availBytes > t.admissionBytes + t.releaseMarginBytes) {
    admission = 'open';
    transitions.push({ kind: 'admission_reopened', episode, pauseCycle, availBytes, thresholdBytes: t.admissionBytes + t.releaseMarginBytes });
  }

  let pauseAction: MemoryPauseAction = pause === 'held' ? 'held' : 'none';
  if (pause === 'none' && memoryPauseDue(availBytes, t)) {
    pause = 'held';
    pauseAction = 'due';
    pauseCycle += 1;
    transitions.push({ kind: 'pause_due', episode, pauseCycle, availBytes, thresholdBytes: t.criticalBytes });
  } else if (pause === 'held' && memoryPauseLiftable(availBytes, t)) {
    pause = 'none';
    pauseAction = 'liftable';
    transitions.push({ kind: 'pause_liftable', episode, pauseCycle, availBytes, thresholdBytes: t.admissionBytes });
  }

  // A one-sample recovery lifts the Pause BEFORE it reopens Admission (the Reprise precedes the released starts); a fall holds, then pauses.
  if (transitions.length === 2 && transitions[0].kind === 'admission_reopened') transitions.reverse();

  return { measured: true, state: { admission, pause, episode, pauseCycle }, transitions, pause: pauseAction, mayReleaseOneStart: mayReleaseOneStart(availBytes, t) };
}

/** Delay before the next sample: 10 s while MemAvailable is below the Admission threshold (or unreadable — retry soon), 60 s above. */
export function nextSampleDelayMs(availBytes: number | null | undefined, t: GuardThresholds): number {
  if (!isMeasured(availBytes)) return SAMPLE_FAST_MS;
  return availBytes < t.admissionBytes ? SAMPLE_FAST_MS : SAMPLE_SLOW_MS;
}

// ─── The state a consumer / `bus-status` / Settings reads ──────────────────────────────────────────────────────────

export interface MemoryGuardSnapshot {
  /** False until the sampler has tried a first reading ("not sampled yet" — the guard is still starting). */
  sampled: boolean;
  /** False until a first reading succeeded, and again while the latest read fails (the figures below are then the last GOOD ones). */
  measured: boolean;
  availBytes: number | null;
  /** Epoch ms of the last good reading. */
  readAt: number | null;
  admission: AdmissionState;
  /** The global toggle: the guard HOLDS only when `admissionEnabled && admission === 'held'` ({@link isAdmissionHolding}). */
  admissionEnabled: boolean;
  pause: MemoryPauseState;
  episode: number;
  /** See {@link GuardState.pauseCycle}. */
  pauseCycle: number;
  /** One held start may go out now — the LATEST decision's answer: false while the meter is unreadable (even though `availBytes` still holds
   *  the last GOOD reading, which must never release a start) and before the first sample. `sampleNow()` returns it fresh. */
  mayReleaseOneStart: boolean;
  /** Epoch ms the CURRENT held Admission / memory Pause began; null when not in effect. */
  heldSince: number | null;
  pauseSince: number | null;
  /** The thresholds in force (bytes) — read each sample, so a Settings change shows at once. */
  admissionBytes: number;
  criticalBytes: number;
  releaseMarginBytes: number;
  /** The cadence the sampler is on right now. */
  sampleIntervalMs: number;
}

/** The one question #286 (Admission) and #288 (fast Veille) ask: must an automatic fleet start wait / idle members sleep NOW? */
export function isAdmissionHolding(s: Pick<MemoryGuardSnapshot, 'admission' | 'admissionEnabled'>): boolean {
  return s.admissionEnabled && s.admission === 'held';
}

// ─── Reading + printing ────────────────────────────────────────────────────────────────────────────────────────────

/** MemAvailable in bytes from /proc/meminfo text; null when absent or not a number (never a fabricated figure). */
export function parseMemAvailableBytes(meminfo: string): number | null {
  const m = /^MemAvailable:\s+(\d+)\s+kB/m.exec(meminfo);
  if (!m) return null;
  const kb = Number(m[1]);
  return Number.isFinite(kb) ? kb * 1024 : null;
}

/** MemTotal in bytes from /proc/meminfo text; null when absent or not a number. */
export function parseMemTotalBytes(meminfo: string): number | null {
  const m = /^MemTotal:\s+(\d+)\s+kB/m.exec(meminfo);
  if (!m) return null;
  const kb = Number(m[1]);
  return Number.isFinite(kb) ? kb * 1024 : null;
}

/** MemTotal − MemAvailable in bytes (what the resource monitor logs as "used"); null when EITHER line is missing — never total-minus-nothing. */
export function parseMemUsedBytes(meminfo: string): number | null {
  const total = parseMemTotalBytes(meminfo);
  const avail = parseMemAvailableBytes(meminfo);
  if (total === null || avail === null) return null;
  return total - avail;
}

export function formatGb(bytes: number, digits = 1): string {
  return `${(bytes / GIB).toFixed(digits)} GB`;
}

/** A run that is REALLY under a memory Pause on the bus (a pause whose stored motive is `memory`, #290) — what the guard's own `pause` field cannot say (D1, ledger #329). */
export interface MemoryPausedRunView {
  runId: string;
  /** The coordinator's name, when known. */
  label?: string;
  /** Epoch ms the Pause began. */
  since: number;
  /** A Reprise is under way (the Pause is still in force until every member is back). */
  resuming: boolean;
}

/** The `memory:` line of `orchestra bus-status` — one line, the whole guard state.
 *  `paused` = the runs actually under a memory Pause on the bus. The guard's own `pause` only means "due NOW" (it reads `none` once memory
 *  recovered above the critical level while the Pause is still in force until the Admission threshold, and after an app restart): on its own it
 *  printed "memory Pause none" under a Pause in force (D1). When `paused` is given it is the truth for "in force"; absent (an older app) ⇒ the guard's word. */
export function formatMemoryGuardLine(s: MemoryGuardSnapshot, paused?: readonly MemoryPausedRunView[]): string {
  if (!s.sampled) return 'memory: not sampled yet — the guard is starting';
  if (!s.measured && s.availBytes === null) return 'memory: UNMEASURED — MemAvailable unreadable (a non-Linux host, or /proc/meminfo unreadable); the guard holds nothing';
  const at = (ms: number | null) => (ms === null ? '?' : new Date(ms).toISOString());
  const stale = s.measured ? '' : ' (last good reading — now unreadable)';
  const avail = `${formatGb(s.availBytes ?? 0)} available${stale}`;
  const admission =
    s.admission === 'held'
      ? `admission HELD since ${at(s.heldSince)} (episode ${s.episode}; reopens above ${formatGb(s.admissionBytes + s.releaseMarginBytes)})`
      : `admission open (holds below ${formatGb(s.admissionBytes)})`;
  let pause: string;
  if (paused && paused.length > 0) {
    const names = paused.slice(0, 3).map((r) => r.label ?? r.runId.slice(0, 8));
    const more = paused.length > 3 ? ` +${paused.length - 3}` : '';
    const resuming = paused.some((r) => r.resuming) ? '; Reprise under way' : '';
    pause = `memory Pause IN EFFECT on ${paused.length} run(s) (${names.join(', ')}${more}) since ${at(Math.min(...paused.map((r) => r.since)))}${resuming} (lifts above ${formatGb(s.admissionBytes)})`;
  } else if (s.pause === 'held') {
    // The guard WANTS a Pause. With the bus list known and empty nothing is paused — whatever the reason (the switch is OFF on the run, or a human already resumed): say the fact, never a guessed cause, never "IN EFFECT".
    pause = paused
      ? `memory Pause WANTED by the guard since ${at(s.pauseSince)} (lifts above ${formatGb(s.admissionBytes)}) — no run is paused on the bus`
      : `memory Pause IN EFFECT since ${at(s.pauseSince)} (lifts above ${formatGb(s.admissionBytes)})`;
  } else {
    pause = `memory Pause none (due below ${formatGb(s.criticalBytes)})`;
  }
  const toggle = s.admissionEnabled ? '' : ' · Admission/fast-Veille toggle OFF — nothing is held';
  return `memory: ${avail} · ${admission} · ${pause}${toggle}`;
}

// ─── Settings I/O contract (Settings dialog ↔ main) ────────────────────────────────────────────────────────────────

/** What the Settings dialog reads: the settings, the guard's state, and a FRESH memory reading beside them. */
export interface MemoryGuardView {
  settings: MemoryGuardSettings;
  snapshot: MemoryGuardSnapshot;
  /** MemAvailable read at the moment of the call (the snapshot's is up to one sampling interval old); null = unreadable. */
  liveAvailBytes: number | null;
  /** MemTotal, for scaling a gauge; null = unreadable. */
  totalBytes: number | null;
}

export type MemoryGuardSetResult = { ok: true; view: MemoryGuardView } | { ok: false; error: string; view: MemoryGuardView };

/** Apply a partial change over the current settings: the merged result when it is valid, else why not (nothing is written then). */
export function patchMemoryGuardSettings(
  current: MemoryGuardSettings,
  patch: Partial<MemoryGuardSettings> | null | undefined,
  totalBytes?: number | null,
): { ok: true; settings: MemoryGuardSettings } | { ok: false; error: string } {
  if (patch === null || typeof patch !== 'object') return { ok: false, error: 'invalid settings patch' };
  const merged: MemoryGuardSettings = {
    admissionGb: patch.admissionGb ?? current.admissionGb,
    criticalGb: patch.criticalGb ?? current.criticalGb,
    admissionEnabled: patch.admissionEnabled ?? current.admissionEnabled,
    capSoftGb: patch.capSoftGb ?? current.capSoftGb,
    capHardGb: patch.capHardGb ?? current.capHardGb,
    reliquatWaitMin: patch.reliquatWaitMin ?? current.reliquatWaitMin,
  };
  // The MemTotal bound judges the pair being CHOSEN: a toggle-only patch never fails on a stored pair the host cannot satisfy (a small
  // machine under the default 6/3) — the sampler warns about that case instead, and the user can still flip the toggle.
  const pairChanged = merged.admissionGb !== current.admissionGb || merged.criticalGb !== current.criticalGb;
  const error = validateMemoryGuardSettings(merged, pairChanged ? totalBytes : undefined);
  return error === null ? { ok: true, settings: merged } : { ok: false, error };
}
