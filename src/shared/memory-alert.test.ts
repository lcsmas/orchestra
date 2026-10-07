import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GIB } from './memory-guard.ts';
import { ALERT_SENDER, ALERT_SETTLE_MS, memoryAlertBody, type AlertEpisode, type AlertFacts } from './memory-alert.ts';

// #289 — the pure half: the text of the ONE escalation row per memory episode. Named arms are what scripts/memory-alert/mutate-unit.mjs reddens.

const EP: AlertEpisode = { episode: 3, admission: { at: Date.UTC(2027, 0, 15, 8, 0, 0), availBytes: 5.42 * GIB, thresholdBytes: 6 * GIB }, critical: null, pauseCycles: 0, endedAt: null };
const FACTS: AlertFacts = { heldStarts: 2, veille: 4, pausedRuns: [], unattributedContainers: 0, nowAvailBytes: 4.9 * GIB, nowAdmissionHeld: true, nowPause: false, admissionEnabled: true, admissionBytes: 6 * GIB, criticalBytes: 3 * GIB, releaseMarginBytes: GIB, at: Date.UTC(2027, 0, 15, 8, 0, 20) };

test('constants: the host is the sender and the settle window is two fast samples', () => {
  assert.equal(ALERT_SENDER, 'host');
  assert.equal(ALERT_SETTLE_MS, 20_000);
});

test('BODY: threshold crossed + MemAvailable at the crossing, the host actions, the state now, what to expect', () => {
  const b = memoryAlertBody(EP, FACTS);
  assert.match(b, /^Memory guard — episode 3 \(since 2027-01-15T08:00:00\.000Z\): MemAvailable fell below the Admission threshold \(6\.00 GB\) at 5\.42 GB\.$/m);
  assert.match(b, /2 automatic fleet start\(s\) HELD \(released coordinators first, one at a time, on a fresh reading, once MemAvailable is above 7\.00 GB\)/);
  assert.match(b, /4 member\(s\) put in Veille since the crossing/);
  assert.match(b, /no run under the memory Pause/);
  assert.match(b, /0 unattributed container\(s\) \(not measured yet — #293\)/);
  assert.match(b, /Now: MemAvailable 4\.90 GB · Admission HELD · memory Pause none\./);
  assert.doesNotMatch(b, /CRITICAL|already OVER/);
  assert.match(b, /You need not act/);
});

test('BODY critical: a critical crossing is named with its threshold and reading; paused runs are listed with the lift threshold', () => {
  const b = memoryAlertBody({ ...EP, critical: { at: 1, availBytes: 2.31 * GIB, thresholdBytes: 3 * GIB, pauseCycle: 1 }, pauseCycles: 1 }, { ...FACTS, pausedRuns: ['L', 'Q'], nowPause: true, nowAvailBytes: 2.5 * GIB });
  assert.match(b, /and below the CRITICAL threshold \(3\.00 GB\) at 2\.31 GB/);
  assert.match(b, /memory Pause on run\(s\) L, Q \(lifted by the host above 6\.00 GB\)/);
  assert.match(b, /memory Pause IN EFFECT/);
});

test('BODY states: toggle OFF says nothing is held; an unreadable meter says so; an ended episode says it is over', () => {
  assert.match(memoryAlertBody(EP, { ...FACTS, admissionEnabled: false }), /automatic starts NOT held \(the Admission toggle is OFF — the guard only measures\)/);
  assert.match(memoryAlertBody(EP, { ...FACTS, nowAvailBytes: null }), /Now: MemAvailable unreadable/);
  assert.match(memoryAlertBody({ ...EP, endedAt: Date.UTC(2027, 0, 15, 8, 5, 0) }, { ...FACTS, nowAdmissionHeld: false, nowAvailBytes: 8 * GIB }), /The episode is already OVER \(memory back above 7\.00 GB at 2027-01-15T08:05:00\.000Z\)\./);
});

test('BODY thresholds follow the settings in force (a custom Admission threshold and margin)', () => {
  const b = memoryAlertBody({ ...EP, admission: { ...EP.admission, thresholdBytes: 8 * GIB } }, { ...FACTS, admissionBytes: 8 * GIB, criticalBytes: 2 * GIB, releaseMarginBytes: 2 * GIB });
  assert.match(b, /below the Admission threshold \(8\.00 GB\)/);
  assert.match(b, /above 10\.00 GB/);
});
