import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_MEMORY_GUARD_SETTINGS,
  DEFAULT_THRESHOLDS,
  GIB,
  INITIAL_GUARD_STATE,
  MAX_ADMISSION_GB,
  MIN_CRITICAL_GB,
  SAMPLE_FAST_MS,
  SAMPLE_SLOW_MS,
  decideMemoryGuard,
  formatMemoryGuardLine,
  isAdmissionHolding,
  mayReleaseOneStart,
  memoryPauseDue,
  memoryPauseLiftable,
  nextSampleDelayMs,
  normalizeMemoryGuardSettings,
  parseMemAvailableBytes,
  thresholdsFrom,
  validateMemoryGuardSettings,
  type GuardState,
  type GuardTransitionKind,
  type MemoryGuardSnapshot,
} from './memory-guard.ts';

const T = DEFAULT_THRESHOLDS; // 6 GB Admission, 3 GB critical, 1 GB margin
const gb = (n: number) => n * GIB;
const kinds = (d: { transitions: Array<{ kind: GuardTransitionKind }> }) => d.transitions.map((x) => x.kind);

/** Feed a reading sequence through the pure function, returning every decision (the state threads through). */
function run(readings: Array<number | null>, from: GuardState = INITIAL_GUARD_STATE, t = T) {
  const out = [];
  let state = from;
  for (const r of readings) {
    const d = decideMemoryGuard(state, r === null ? null : gb(r), t);
    out.push(d);
    state = d.state;
  }
  return out;
}
const HELD: GuardState = { admission: 'held', pause: 'none', episode: 1 };
const CRITICAL: GuardState = { admission: 'held', pause: 'held', episode: 1 };

// ─── positive control: if this baseline is not "all quiet", every negative arm below is vacuous ─────────────────────
test('baseline: 10 GB from the initial state → open, no Pause, no transition, a start may go out', () => {
  const d = decideMemoryGuard(INITIAL_GUARD_STATE, gb(10), T);
  assert.deepEqual(d.state, { admission: 'open', pause: 'none', episode: 0 });
  assert.deepEqual(d.transitions, []);
  assert.equal(d.pause, 'none');
  assert.equal(d.mayReleaseOneStart, true);
  assert.equal(d.measured, true);
});

// ─── Admission: held strictly BELOW the threshold ───────────────────────────────────────────────────────────────────
test('admission_held_below: 1 byte under 6 GB → held, episode 1, the edge carries the memory + the threshold', () => {
  const d = decideMemoryGuard(INITIAL_GUARD_STATE, gb(6) - 1, T);
  assert.equal(d.state.admission, 'held');
  assert.equal(d.state.episode, 1);
  assert.deepEqual(d.transitions, [{ kind: 'admission_held', episode: 1, availBytes: gb(6) - 1, thresholdBytes: gb(6) }]);
});

test('admission_held_boundary: exactly 6 GB is NOT below the threshold → stays open', () => {
  const d = decideMemoryGuard(INITIAL_GUARD_STATE, gb(6), T);
  assert.equal(d.state.admission, 'open');
  assert.deepEqual(d.transitions, []);
});

// ─── Admission: reopens strictly ABOVE threshold + margin (hysteresis) ──────────────────────────────────────────────
test('admission_reopen_boundary: exactly 7 GB stays held; 1 byte above reopens', () => {
  assert.equal(decideMemoryGuard(HELD, gb(7), T).state.admission, 'held');
  const d = decideMemoryGuard(HELD, gb(7) + 1, T);
  assert.equal(d.state.admission, 'open');
  assert.deepEqual(d.transitions, [{ kind: 'admission_reopened', episode: 1, availBytes: gb(7) + 1, thresholdBytes: gb(7) }]);
});

test('hysteresis_band: 6.0 < x ≤ 7.0 GB keeps a held Admission held (no flap at the threshold)', () => {
  for (const r of run([6.01, 6.5, 6.99, 7.0], HELD)) {
    assert.equal(r.state.admission, 'held');
    assert.deepEqual(r.transitions, []);
  }
});

// ─── one episode per crossing ────────────────────────────────────────────────────────────────────────────────────────
test('one_episode_per_crossing: jitter around the threshold is ONE episode; a real recovery then a new fall is episode 2', () => {
  const ds = run([5.9, 6.1, 5.9, 6.5, 5.5, 6.9, 5.0]);
  assert.deepEqual(ds.map((d) => d.state.episode), [1, 1, 1, 1, 1, 1, 1]);
  assert.equal(ds.flatMap(kinds).filter((k) => k === 'admission_held').length, 1, 'exactly one admission_held edge for seven samples');
  const more = run([8.0, 5.0], ds[ds.length - 1].state);
  assert.deepEqual(kinds(more[0]), ['admission_reopened']);
  assert.deepEqual(kinds(more[1]), ['admission_held']);
  assert.equal(more[1].state.episode, 2);
});

test('steady_below: 100 samples below the threshold fire no second edge', () => {
  const ds = run(Array.from({ length: 100 }, () => 5.5), HELD);
  assert.equal(ds.flatMap(kinds).length, 0);
});

// ─── memory Pause: due strictly below critical, lifts strictly above the ADMISSION threshold ────────────────────────
test('pause_due_boundary: 1 byte under 3 GB → due; exactly 3 GB → not due', () => {
  const below = decideMemoryGuard(HELD, gb(3) - 1, T);
  assert.equal(below.pause, 'due');
  assert.equal(below.state.pause, 'held');
  assert.deepEqual(below.transitions, [{ kind: 'pause_due', episode: 1, availBytes: gb(3) - 1, thresholdBytes: gb(3) }]);
  const at = decideMemoryGuard(HELD, gb(3), T);
  assert.equal(at.pause, 'none');
  assert.equal(at.state.pause, 'none');
});

test('pause_lift_boundary: exactly 6 GB keeps the Pause; 1 byte above 6 GB makes it liftable (NOT +1 GB)', () => {
  const at = decideMemoryGuard(CRITICAL, gb(6), T);
  assert.equal(at.pause, 'held');
  assert.equal(at.state.pause, 'held');
  const above = decideMemoryGuard(CRITICAL, gb(6) + 1, T);
  assert.equal(above.pause, 'liftable');
  assert.equal(above.state.pause, 'none');
  assert.deepEqual(above.transitions, [{ kind: 'pause_liftable', episode: 1, availBytes: gb(6) + 1, thresholdBytes: gb(6) }]);
});

test('pause_one_per_crossing: 2.5 → 2.9 → 3.5 → 5.9 fires pause_due once; lifts at 6.5; falling again is a NEW due', () => {
  const ds = run([2.5, 2.9, 3.5, 5.9, 6.5, 2.5], HELD);
  assert.deepEqual(ds.map((d) => d.pause), ['due', 'held', 'held', 'held', 'liftable', 'due']);
  assert.equal(ds.flatMap(kinds).filter((k) => k === 'pause_due').length, 2);
});

test('pause_lift_leaves_admission_held: at 6.5 GB the Pause lifts but Admission stays held until above 7 GB', () => {
  const d = decideMemoryGuard(CRITICAL, gb(6.5), T);
  assert.equal(d.pause, 'liftable');
  assert.equal(d.state.admission, 'held');
  assert.equal(d.mayReleaseOneStart, false);
});

test('jump: 8 GB straight to 2 GB crosses both thresholds in ONE sample, in order', () => {
  const d = decideMemoryGuard(INITIAL_GUARD_STATE, gb(2), T);
  assert.deepEqual(kinds(d), ['admission_held', 'pause_due']);
  assert.deepEqual(d.state, { admission: 'held', pause: 'held', episode: 1 });
});

test('the 2026-10-06 night in miniature: open → held → critical → recovering → open, edges in order', () => {
  const ds = run([12, 8, 5.5, 4, 2.4, 2.9, 4.5, 6.3, 6.8, 7.4, 9]);
  assert.deepEqual(ds.map((d) => `${d.state.admission}/${d.state.pause}`), [
    'open/none', 'open/none', 'held/none', 'held/none', 'held/held', 'held/held', 'held/held', 'held/none', 'held/none', 'open/none', 'open/none',
  ]);
  assert.deepEqual(ds.flatMap(kinds), ['admission_held', 'pause_due', 'pause_liftable', 'admission_reopened']);
});

// ─── "may release one held start now" ───────────────────────────────────────────────────────────────────────────────
test('may_release_boundary: only strictly above 7 GB', () => {
  assert.equal(mayReleaseOneStart(gb(7), T), false);
  assert.equal(mayReleaseOneStart(gb(7) + 1, T), true);
  assert.equal(decideMemoryGuard(HELD, gb(7) + 1, T).mayReleaseOneStart, true);
  assert.equal(decideMemoryGuard(HELD, gb(6.9), T).mayReleaseOneStart, false);
});

test('release_re_measure: after a release the next one needs a FRESH reading above 7 GB (a drop to 6.8 stops the burst)', () => {
  const [reopen, afterFirstStart] = run([7.4, 6.8], HELD);
  assert.equal(reopen.mayReleaseOneStart, true);
  assert.equal(afterFirstStart.mayReleaseOneStart, false);
  assert.equal(afterFirstStart.state.admission, 'open', 'still open (hysteresis) — only the release is withheld');
});

// ─── unreadable memory is UNKNOWN: nothing fires, nothing is released ───────────────────────────────────────────────
test('unmeasured: null / NaN / -1 / Infinity / undefined leave the state untouched and fire nothing', () => {
  for (const bad of [null, undefined, NaN, -1, Infinity]) {
    const d = decideMemoryGuard(CRITICAL, bad as number | null, T);
    assert.equal(d.measured, false);
    assert.deepEqual(d.state, CRITICAL);
    assert.deepEqual(d.transitions, []);
    assert.equal(d.pause, 'held', 'a Pause in effect is not lifted by an unreadable reading');
    assert.equal(d.mayReleaseOneStart, false);
  }
  assert.equal(decideMemoryGuard(INITIAL_GUARD_STATE, null, T).pause, 'none');
});

// ─── stateless level predicates (what #290 re-evaluates against the PERSISTED run after a restart) ──────────────────
test('level predicates are strict at their boundaries', () => {
  assert.equal(memoryPauseDue(gb(3) - 1, T), true);
  assert.equal(memoryPauseDue(gb(3), T), false);
  assert.equal(memoryPauseLiftable(gb(6), T), false);
  assert.equal(memoryPauseLiftable(gb(6) + 1, T), true);
});

// ─── sampling cadence ───────────────────────────────────────────────────────────────────────────────────────────────
test('nextSampleDelayMs: 10 s strictly below the Admission threshold, 60 s at/above it, 10 s when unreadable', () => {
  assert.equal(nextSampleDelayMs(gb(6) - 1, T), SAMPLE_FAST_MS);
  assert.equal(nextSampleDelayMs(gb(6), T), SAMPLE_SLOW_MS);
  assert.equal(nextSampleDelayMs(gb(40), T), SAMPLE_SLOW_MS);
  assert.equal(nextSampleDelayMs(gb(1), T), SAMPLE_FAST_MS);
  assert.equal(nextSampleDelayMs(null, T), SAMPLE_FAST_MS);
  assert.equal(SAMPLE_FAST_MS, 10_000);
  assert.equal(SAMPLE_SLOW_MS, 60_000);
});

// ─── custom thresholds follow the settings, not the constants ───────────────────────────────────────────────────────
test('thresholds are the SETTINGS: 10/4 GB decides at 10/4, not 6/3', () => {
  const t = thresholdsFrom({ admissionGb: 10, criticalGb: 4, admissionEnabled: true });
  assert.equal(decideMemoryGuard(INITIAL_GUARD_STATE, gb(9), t).state.admission, 'held');
  assert.equal(decideMemoryGuard(INITIAL_GUARD_STATE, gb(9), T).state.admission, 'open');
  assert.equal(decideMemoryGuard(HELD, gb(11) + 1, t).state.admission, 'open');
  assert.equal(decideMemoryGuard(HELD, gb(10.5), t).state.admission, 'held');
});

// ─── settings ───────────────────────────────────────────────────────────────────────────────────────────────────────
test('settings default to 6 / 3 GB with the toggle ON', () => {
  assert.deepEqual(normalizeMemoryGuardSettings(undefined), { admissionGb: 6, criticalGb: 3, admissionEnabled: true });
  assert.deepEqual(DEFAULT_MEMORY_GUARD_SETTINGS, { admissionGb: 6, criticalGb: 3, admissionEnabled: true });
});

test('settings: a valid stored value is kept (decimals, toggle OFF)', () => {
  assert.deepEqual(normalizeMemoryGuardSettings({ admissionGb: 8.5, criticalGb: 2.5, admissionEnabled: false }), { admissionGb: 8.5, criticalGb: 2.5, admissionEnabled: false });
});

test('settings: garbage / an inverted pair falls back to the default PAIR, keeping the toggle', () => {
  assert.deepEqual(normalizeMemoryGuardSettings({ admissionGb: 2, criticalGb: 5, admissionEnabled: false }), { admissionGb: 6, criticalGb: 3, admissionEnabled: false });
  assert.deepEqual(normalizeMemoryGuardSettings({ admissionGb: 'x' as unknown as number, criticalGb: NaN }), DEFAULT_MEMORY_GUARD_SETTINGS);
  assert.deepEqual(normalizeMemoryGuardSettings({ admissionGb: 6, criticalGb: 6 }), DEFAULT_MEMORY_GUARD_SETTINGS);
});

test('validate: refuses an inverted pair, a sub-minimum critical, an absurd Admission; accepts the defaults', () => {
  assert.equal(validateMemoryGuardSettings(DEFAULT_MEMORY_GUARD_SETTINGS), null);
  assert.match(validateMemoryGuardSettings({ admissionGb: 3, criticalGb: 6, admissionEnabled: true }) ?? '', /must be below/);
  assert.match(validateMemoryGuardSettings({ admissionGb: 6, criticalGb: 6, admissionEnabled: true }) ?? '', /must be below/);
  assert.match(validateMemoryGuardSettings({ admissionGb: 6, criticalGb: MIN_CRITICAL_GB - 0.1, admissionEnabled: true }) ?? '', /at least/);
  assert.equal(validateMemoryGuardSettings({ admissionGb: 6, criticalGb: MIN_CRITICAL_GB, admissionEnabled: true }), null);
  assert.match(validateMemoryGuardSettings({ admissionGb: MAX_ADMISSION_GB + 1, criticalGb: 3, admissionEnabled: true }) ?? '', /at most/);
  assert.match(validateMemoryGuardSettings({ admissionGb: NaN, criticalGb: 3, admissionEnabled: true }) ?? '', /numbers/);
});

// ─── /proc/meminfo ──────────────────────────────────────────────────────────────────────────────────────────────────
test('parseMemAvailableBytes reads MemAvailable (kB → bytes) and refuses everything else', () => {
  const text = 'MemTotal:       32768000 kB\nMemFree:         1000000 kB\nMemAvailable:    6291456 kB\nBuffers:           10 kB\n';
  assert.equal(parseMemAvailableBytes(text), 6291456 * 1024);
  assert.equal(parseMemAvailableBytes(text), gb(6));
  assert.equal(parseMemAvailableBytes('MemTotal: 1 kB\n'), null);
  assert.equal(parseMemAvailableBytes(''), null);
  assert.equal(parseMemAvailableBytes('MemAvailable: lots kB\n'), null);
  assert.equal(parseMemAvailableBytes('XMemAvailable: 5 kB\n'), null, 'anchored at the line start');
});

// ─── what a consumer asks ───────────────────────────────────────────────────────────────────────────────────────────
test('isAdmissionHolding: held AND the toggle ON, nothing else', () => {
  assert.equal(isAdmissionHolding({ admission: 'held', admissionEnabled: true }), true);
  assert.equal(isAdmissionHolding({ admission: 'held', admissionEnabled: false }), false);
  assert.equal(isAdmissionHolding({ admission: 'open', admissionEnabled: true }), false);
  assert.equal(isAdmissionHolding({ admission: 'open', admissionEnabled: false }), false);
});

function snap(over: Partial<MemoryGuardSnapshot> = {}): MemoryGuardSnapshot {
  return {
    measured: true, availBytes: gb(12.3), readAt: 1_000, admission: 'open', admissionEnabled: true, pause: 'none', episode: 0,
    heldSince: null, pauseSince: null, admissionBytes: gb(6), criticalBytes: gb(3), releaseMarginBytes: gb(1), sampleIntervalMs: 60_000, ...over,
  };
}

test('formatMemoryGuardLine: open / held / memory Pause / toggle OFF / unmeasured', () => {
  assert.equal(formatMemoryGuardLine(snap()), 'memory: 12.3 GB available · admission open (holds below 6.0 GB) · memory Pause none (due below 3.0 GB)');
  assert.match(
    formatMemoryGuardLine(snap({ availBytes: gb(5.1), admission: 'held', episode: 3, heldSince: Date.UTC(2026, 9, 7, 14, 2, 11) })),
    /^memory: 5\.1 GB available · admission HELD since 2026-10-07T14:02:11\.000Z \(episode 3; reopens above 7\.0 GB\) · memory Pause none/,
  );
  assert.match(
    formatMemoryGuardLine(snap({ availBytes: gb(2.4), admission: 'held', pause: 'held', episode: 1, heldSince: 1, pauseSince: Date.UTC(2026, 9, 7, 14, 5, 0) })),
    /memory Pause IN EFFECT since 2026-10-07T14:05:00\.000Z \(lifts above 6\.0 GB\)/,
  );
  assert.match(formatMemoryGuardLine(snap({ admissionEnabled: false })), /toggle OFF — nothing is held$/);
  assert.match(formatMemoryGuardLine(snap({ measured: false, availBytes: null })), /^memory: UNMEASURED/);
  assert.match(formatMemoryGuardLine(snap({ measured: false })), /last good reading/);
});
