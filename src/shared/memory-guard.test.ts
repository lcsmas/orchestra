import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_MEMORY_GUARD_SETTINGS,
  DEFAULT_THRESHOLDS,
  GIB,
  INITIAL_GUARD_STATE,
  MAX_ADMISSION_GB,
  MIN_CAP_HARD_GB,
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
  parseMemTotalBytes,
  parseMemUsedBytes,
  patchMemoryGuardSettings,
  thresholdUnreachable,
  thresholdsFrom,
  validateMemoryGuardSettings,
  type GuardState,
  type GuardTransitionKind,
  type MemoryGuardSnapshot,
  type MemoryPausedRunView,
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
const HELD: GuardState = { admission: 'held', pause: 'none', episode: 1, pauseCycle: 0 };
const CRITICAL: GuardState = { admission: 'held', pause: 'held', episode: 1, pauseCycle: 1 };

// ─── positive control: if this baseline is not "all quiet", every negative arm below is vacuous ─────────────────────
test('baseline: 10 GB from the initial state → open, no Pause, no transition, a start may go out', () => {
  const d = decideMemoryGuard(INITIAL_GUARD_STATE, gb(10), T);
  assert.deepEqual(d.state, { admission: 'open', pause: 'none', episode: 0, pauseCycle: 0 });
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
  assert.deepEqual(d.transitions, [{ kind: 'admission_held', episode: 1, pauseCycle: 0, availBytes: gb(6) - 1, thresholdBytes: gb(6) }]);
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
  assert.deepEqual(d.transitions, [{ kind: 'admission_reopened', episode: 1, pauseCycle: 0, availBytes: gb(7) + 1, thresholdBytes: gb(7) }]);
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
  assert.deepEqual(below.transitions, [{ kind: 'pause_due', episode: 1, pauseCycle: 1, availBytes: gb(3) - 1, thresholdBytes: gb(3) }]);
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
  assert.deepEqual(above.transitions, [{ kind: 'pause_liftable', episode: 1, pauseCycle: 1, availBytes: gb(6) + 1, thresholdBytes: gb(6) }]);
});

test('pause_one_per_crossing: 2.5 → 2.9 → 3.5 → 5.9 fires pause_due once; lifts at 6.5; falling again is a NEW due', () => {
  const ds = run([2.5, 2.9, 3.5, 5.9, 6.5, 2.5], HELD);
  assert.deepEqual(ds.map((d) => d.pause), ['due', 'held', 'held', 'held', 'liftable', 'due']);
  assert.equal(ds.flatMap(kinds).filter((k) => k === 'pause_due').length, 2);
});

test('pause_cycle: a 2nd memory Pause inside ONE Admission episode is cycle 2 with the SAME episode (what "one alert per episode" cannot tell apart)', () => {
  const ds = run([2.5, 6.5, 2.5, 6.5, 2.5], HELD);
  assert.deepEqual(ds.flatMap((d) => d.transitions.map((x) => `${x.kind}#${x.episode}/${x.pauseCycle}`)), [
    'pause_due#1/1', 'pause_liftable#1/1', 'pause_due#1/2', 'pause_liftable#1/2', 'pause_due#1/3',
  ]);
  assert.deepEqual(ds.map((d) => d.state.pauseCycle), [1, 1, 2, 2, 3]);
  assert.equal(ds[ds.length - 1].state.episode, 1, 'Admission never reopened: still ONE episode');
});

test('pause_lift_leaves_admission_held: at 6.5 GB the Pause lifts but Admission stays held until above 7 GB', () => {
  const d = decideMemoryGuard(CRITICAL, gb(6.5), T);
  assert.equal(d.pause, 'liftable');
  assert.equal(d.state.admission, 'held');
  assert.equal(d.mayReleaseOneStart, false);
});

test('jump_recovery: 2 GB straight to 8 GB lifts the Pause BEFORE it reopens Admission (the Reprise precedes released starts)', () => {
  const d = decideMemoryGuard(CRITICAL, gb(8), T);
  assert.deepEqual(kinds(d), ['pause_liftable', 'admission_reopened']);
  assert.deepEqual(d.state, { admission: 'open', pause: 'none', episode: 1, pauseCycle: 1 });
});

test('jump: 8 GB straight to 2 GB crosses both thresholds in ONE sample, in order', () => {
  const d = decideMemoryGuard(INITIAL_GUARD_STATE, gb(2), T);
  assert.deepEqual(kinds(d), ['admission_held', 'pause_due']);
  assert.deepEqual(d.state, { admission: 'held', pause: 'held', episode: 1, pauseCycle: 1 });
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
  assert.deepEqual(normalizeMemoryGuardSettings(undefined), { admissionGb: 6, criticalGb: 3, admissionEnabled: true, capSoftGb: 3, capHardGb: 6 });
  assert.deepEqual(DEFAULT_MEMORY_GUARD_SETTINGS, { admissionGb: 6, criticalGb: 3, admissionEnabled: true, capSoftGb: 3, capHardGb: 6 });
});

test('settings: a valid stored value is kept (decimals, toggle OFF)', () => {
  assert.deepEqual(normalizeMemoryGuardSettings({ admissionGb: 8.5, criticalGb: 2.5, admissionEnabled: false }), { admissionGb: 8.5, criticalGb: 2.5, admissionEnabled: false, capSoftGb: 3, capHardGb: 6 });
});

test('settings: garbage / an inverted pair falls back to the default PAIR, keeping the toggle', () => {
  assert.deepEqual(normalizeMemoryGuardSettings({ admissionGb: 2, criticalGb: 5, admissionEnabled: false }), { admissionGb: 6, criticalGb: 3, admissionEnabled: false, capSoftGb: 3, capHardGb: 6 });
  assert.deepEqual(normalizeMemoryGuardSettings({ admissionGb: 'x' as unknown as number, criticalGb: NaN }), DEFAULT_MEMORY_GUARD_SETTINGS);
  assert.deepEqual(normalizeMemoryGuardSettings({ admissionGb: 6, criticalGb: 6 }), DEFAULT_MEMORY_GUARD_SETTINGS);
});

test('validate_total: Admission + the 1 GB reopen margin must be BELOW the machine\'s memory (Admission could otherwise never reopen)', () => {
  const s = { admissionGb: 40, criticalGb: 3, admissionEnabled: true, capSoftGb: 3, capHardGb: 6 };
  assert.match(validateMemoryGuardSettings(s, gb(32)) ?? '', /plus the 1 GB reopen margin must be below this machine's memory \(32\.0 GB\)/);
  assert.match(validateMemoryGuardSettings({ ...s, admissionGb: 31 }, gb(32)) ?? '', /reopen margin/, '31 + 1 = 32 is not below 32');
  assert.match(validateMemoryGuardSettings({ ...s, admissionGb: 31.5 }, gb(32)) ?? '', /reopen margin/, 'the old Admission-only bound accepted this: 31.5 + 1 > 32');
  assert.equal(validateMemoryGuardSettings({ ...s, admissionGb: 30.99 }, gb(32)), null, '30.99 + 1 < 32: reachable');
  assert.equal(validateMemoryGuardSettings(s, null), null, 'an unreadable MemTotal bounds nothing');
  assert.equal(validateMemoryGuardSettings(s), null);
  assert.equal(thresholdUnreachable(30.99, gb(32)), false);
  assert.equal(thresholdUnreachable(31, gb(32)), true);
});

test('toggle_only_small_host: a toggle-only patch is never refused by the MemTotal bound (the default 6/3 exceeds a 4 GB host); changing the pair is', () => {
  const small = gb(4);
  assert.deepEqual(patchMemoryGuardSettings(DEFAULT_MEMORY_GUARD_SETTINGS, { admissionEnabled: false }, small), { ok: true, settings: { admissionGb: 6, criticalGb: 3, admissionEnabled: false, capSoftGb: 3, capHardGb: 6 } });
  assert.equal(patchMemoryGuardSettings(DEFAULT_MEMORY_GUARD_SETTINGS, { admissionGb: 3.5, criticalGb: 3 }, small).ok, false, '3.5 + 1 >= 4');
  assert.deepEqual(patchMemoryGuardSettings(DEFAULT_MEMORY_GUARD_SETTINGS, { admissionGb: 2, criticalGb: 1 }, small), { ok: true, settings: { admissionGb: 2, criticalGb: 1, admissionEnabled: true, capSoftGb: 3, capHardGb: 6 } });
});

test('patch_merge_keeps_stored_fields: a partial patch changes ONLY its fields (non-default stored settings survive)', () => {
  const stored = { admissionGb: 10, criticalGb: 4, admissionEnabled: false, capSoftGb: 3, capHardGb: 6 };
  assert.deepEqual(patchMemoryGuardSettings(stored, { admissionGb: 12 }), { ok: true, settings: { ...stored, admissionGb: 12 } });
  assert.deepEqual(patchMemoryGuardSettings(stored, { criticalGb: 5 }), { ok: true, settings: { ...stored, criticalGb: 5 } });
  assert.deepEqual(patchMemoryGuardSettings(stored, { admissionEnabled: true }), { ok: true, settings: { ...stored, admissionEnabled: true } });
  assert.deepEqual(patchMemoryGuardSettings(stored, {}), { ok: true, settings: stored });
});

test('validate_toggle_type: a non-boolean toggle is refused (validate, patch, and a string from IPC)', () => {
  assert.match(validateMemoryGuardSettings({ admissionGb: 6, criticalGb: 3, admissionEnabled: 'yes' as unknown as boolean, capSoftGb: 3, capHardGb: 6 }) ?? '', /toggle must be true or false/);
  assert.equal(patchMemoryGuardSettings(DEFAULT_MEMORY_GUARD_SETTINGS, { admissionEnabled: 'false' as unknown as boolean }).ok, false);
  assert.equal(patchMemoryGuardSettings(DEFAULT_MEMORY_GUARD_SETTINGS, { admissionEnabled: 0 as unknown as boolean }).ok, false);
});

test('patch: a null / undefined / non-object patch is {ok:false}, never a throw; a valid patch merges', () => {
  for (const bad of [null, undefined, 'x' as unknown as object, 5 as unknown as object]) {
    assert.deepEqual(patchMemoryGuardSettings(DEFAULT_MEMORY_GUARD_SETTINGS, bad as never), { ok: false, error: 'invalid settings patch' });
  }
  assert.deepEqual(patchMemoryGuardSettings(DEFAULT_MEMORY_GUARD_SETTINGS, { admissionGb: 8 }), { ok: true, settings: { ...DEFAULT_MEMORY_GUARD_SETTINGS, admissionGb: 8 } });
  assert.equal(patchMemoryGuardSettings(DEFAULT_MEMORY_GUARD_SETTINGS, { admissionGb: 40 }, gb(32)).ok, false);
});

test('validate: refuses an inverted pair, a sub-minimum critical, an absurd Admission; accepts the defaults', () => {
  assert.equal(validateMemoryGuardSettings(DEFAULT_MEMORY_GUARD_SETTINGS), null);
  assert.match(validateMemoryGuardSettings({ admissionGb: 3, criticalGb: 6, admissionEnabled: true, capSoftGb: 3, capHardGb: 6 }) ?? '', /must be below/);
  assert.match(validateMemoryGuardSettings({ admissionGb: 6, criticalGb: 6, admissionEnabled: true, capSoftGb: 3, capHardGb: 6 }) ?? '', /must be below/);
  assert.match(validateMemoryGuardSettings({ admissionGb: 6, criticalGb: MIN_CRITICAL_GB - 0.1, admissionEnabled: true, capSoftGb: 3, capHardGb: 6 }) ?? '', /at least/);
  assert.equal(validateMemoryGuardSettings({ admissionGb: 6, criticalGb: MIN_CRITICAL_GB, admissionEnabled: true, capSoftGb: 3, capHardGb: 6 }), null);
  assert.match(validateMemoryGuardSettings({ admissionGb: MAX_ADMISSION_GB + 1, criticalGb: 3, admissionEnabled: true, capSoftGb: 3, capHardGb: 6 }) ?? '', /at most/);
  assert.match(validateMemoryGuardSettings({ admissionGb: NaN, criticalGb: 3, admissionEnabled: true, capSoftGb: 3, capHardGb: 6 }) ?? '', /numbers/);
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

test('mem_used: MemTotal − MemAvailable (resource monitor\'s "used"); null when EITHER line is missing — never total-minus-nothing', () => {
  const text = 'MemTotal:       32768000 kB\nMemFree:         1000000 kB\nMemAvailable:    6291456 kB\n';
  assert.equal(parseMemUsedBytes(text), (32768000 - 6291456) * 1024);
  assert.equal(parseMemUsedBytes(text), gb(32768000 / 1048576) - gb(6), 'the difference, not the sum');
  assert.ok((parseMemUsedBytes(text) as number) < (parseMemTotalBytes(text) as number), 'used < total');
  assert.equal(parseMemUsedBytes('MemTotal: 32768000 kB\n'), null, 'no MemAvailable ⇒ null (not the whole total)');
  assert.equal(parseMemUsedBytes('MemAvailable: 6291456 kB\n'), null, 'no MemTotal ⇒ null');
  assert.equal(parseMemUsedBytes(''), null);
  assert.equal(parseMemUsedBytes('MemTotal: 100 kB\nMemAvailable: 100 kB\n'), 0, 'a fully idle host reads 0 used, not null');
  assert.equal(parseMemTotalBytes('MemTotal: lots kB\n'), null);
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
    sampled: true, measured: true, availBytes: gb(12.3), readAt: 1_000, admission: 'open', admissionEnabled: true, pause: 'none', episode: 0, pauseCycle: 0, mayReleaseOneStart: true,
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
  assert.match(formatMemoryGuardLine(snap({ measured: false, availBytes: null })), /^memory: UNMEASURED — MemAvailable unreadable/);
  assert.match(formatMemoryGuardLine(snap({ sampled: false, measured: false, availBytes: null })), /^memory: not sampled yet/);
  assert.match(formatMemoryGuardLine(snap({ measured: false })), /last good reading/);
});

// ─── D1 (ledger #329): the memory: line must say a memory Pause is IN FORCE when runs are really under one ───────────

const T0 = Date.UTC(2026, 9, 8, 12, 51, 0);
const paused = (over: Partial<MemoryPausedRunView> = {}): MemoryPausedRunView => ({ runId: '36773f53-0000-4000-8000-000000000000', label: 'bloc2-ops', since: T0, resuming: false, ...over });

test('D1 must-FAIL on master: guard.pause "none" (not due NOW) but a run IS under a memory Pause ⇒ the line says IN EFFECT, never "Pause none"', () => {
  // availBytes is back above the critical level, so the guard's own `pause` reads none while the Pause lifts only above the Admission threshold.
  const line = formatMemoryGuardLine(snap({ availBytes: gb(4.2), admission: 'held', pause: 'none', episode: 1, heldSince: 1 }), [paused()]);
  assert.match(line, /memory Pause IN EFFECT on 1 run\(s\) \(bloc2-ops\) since 2026-10-08T12:51:00\.000Z \(lifts above 6\.0 GB\)/);
  assert.doesNotMatch(line, /memory Pause none/);
});

test('D1: several runs are counted and named (3 shown, the rest counted); a Reprise under way is said so', () => {
  const many = [paused({ label: 'a' }), paused({ runId: 'b'.repeat(36), label: undefined, since: T0 + 5 }), paused({ runId: 'c'.repeat(36), label: 'c' }), paused({ runId: 'd'.repeat(36), label: 'd', resuming: true })];
  const line = formatMemoryGuardLine(snap(), many);
  assert.match(line, /IN EFFECT on 4 run\(s\) \(a, bbbbbbbb, c \+1\) since 2026-10-08T12:51:00\.000Z; Reprise under way \(lifts above 6\.0 GB\)/);
});

test('D1: no run paused ⇒ unchanged ("none"); the guard saying held while NO run is paused says that instead of pretending', () => {
  assert.match(formatMemoryGuardLine(snap(), []), /memory Pause none \(due below 3\.0 GB\)$/);
  assert.equal(formatMemoryGuardLine(snap()), 'memory: 12.3 GB available · admission open (holds below 6.0 GB) · memory Pause none (due below 3.0 GB)', 'no second argument = the old line, byte for byte');
  const wanted = formatMemoryGuardLine(snap({ pause: 'held', pauseSince: T0, availBytes: gb(2) }), []);
  assert.match(wanted, /memory Pause WANTED by the guard since 2026-10-08T12:51:00\.000Z \(lifts above 6\.0 GB\) — no run is paused on the bus/);
  assert.doesNotMatch(wanted, /IN EFFECT/, 'review m3: held + a known-empty bus list is NOT "in effect" (the old line contradicted itself)');
  assert.doesNotMatch(wanted, /switch|resume/, 'and it names no guessed cause');
  const old = formatMemoryGuardLine(snap({ pause: 'held', pauseSince: T0, availBytes: gb(2) }));
  assert.match(old, /memory Pause IN EFFECT since 2026-10-08T12:51:00\.000Z \(lifts above 6\.0 GB\)$/, 'an older app that sends no list keeps the guard\'s word');
});

// ─── #320: the Plafond mémoire levels ────────────────────────────────────────────────────────────────────────────────

test('cap levels: defaults 3/6; normalized as their own pair (a bad cap pair never resets the thresholds, nor the reverse)', () => {
  assert.equal(DEFAULT_MEMORY_GUARD_SETTINGS.capSoftGb, 3);
  assert.equal(DEFAULT_MEMORY_GUARD_SETTINGS.capHardGb, 6);
  assert.deepEqual(normalizeMemoryGuardSettings({ admissionGb: 8, criticalGb: 2, capSoftGb: 7, capHardGb: 4 }), { admissionGb: 8, criticalGb: 2, admissionEnabled: true, capSoftGb: 3, capHardGb: 6 });
  assert.deepEqual(normalizeMemoryGuardSettings({ admissionGb: 2, criticalGb: 5, capSoftGb: 1, capHardGb: 2 }), { admissionGb: 6, criticalGb: 3, admissionEnabled: true, capSoftGb: 1, capHardGb: 2 });
  assert.deepEqual(normalizeMemoryGuardSettings({ capSoftGb: 0.2, capHardGb: 0.25 }), { ...DEFAULT_MEMORY_GUARD_SETTINGS, capSoftGb: 0.2, capHardGb: 0.25 }, 'a rig-sized cap is a valid setting');
});

test('cap levels: validation — hard above soft, hard at least MIN_CAP_HARD_GB, numbers only', () => {
  const s = DEFAULT_MEMORY_GUARD_SETTINGS;
  assert.equal(validateMemoryGuardSettings(s), null);
  assert.match(validateMemoryGuardSettings({ ...s, capSoftGb: 6, capHardGb: 6 }) ?? '', /soft level \(6 GB\) must be above 0 and below the hard level/);
  assert.match(validateMemoryGuardSettings({ ...s, capSoftGb: 1, capHardGb: MIN_CAP_HARD_GB / 2 }) ?? '', /hard level must be at least/);
  assert.match(validateMemoryGuardSettings({ ...s, capSoftGb: 0 }) ?? '', /above 0/);
  assert.match(validateMemoryGuardSettings({ ...s, capHardGb: Number.NaN }) ?? '', /must be numbers/);
});

test('cap levels: a patch changes only what it names; an invalid pair writes nothing', () => {
  const ok = patchMemoryGuardSettings(DEFAULT_MEMORY_GUARD_SETTINGS, { capHardGb: 8 });
  assert.deepEqual(ok, { ok: true, settings: { ...DEFAULT_MEMORY_GUARD_SETTINGS, capHardGb: 8 } });
  assert.equal(patchMemoryGuardSettings(DEFAULT_MEMORY_GUARD_SETTINGS, { capSoftGb: 7 }).ok, false, 'soft 7 is not below the current hard 6');
});
