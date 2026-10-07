import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GIB } from './memory-guard.ts';
import { ALERT_SENDER, ALERT_SETTLE_MS, memoryAlertBody, type AlertEpisode, type AlertFacts } from './memory-alert.ts';

// #289 — the pure half: the text of the ONE escalation row per memory episode. Named arms are what scripts/memory-alert/mutate-unit.mjs reddens.

const EP: AlertEpisode = { episode: 3, admission: { at: Date.UTC(2027, 0, 15, 8, 0, 0), availBytes: 5.42 * GIB, thresholdBytes: 6 * GIB }, critical: null, pauseCycles: 0, endedAt: null };
const FACTS: AlertFacts = { heldStarts: 2, veille: 4, pausedRuns: [], unattributedContainers: 0, nowAvailBytes: 4.9 * GIB, nowAdmissionHeld: true, nowPause: false, eligibleRuns: 1, admissionEnabled: true, admissionBytes: 6 * GIB, criticalBytes: 3 * GIB, releaseMarginBytes: GIB, at: Date.UTC(2027, 0, 15, 8, 0, 20) };

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
  assert.match(b, /0 unattributed container\(s\)\./);
  assert.doesNotMatch(b, /not measured yet — #293/, 'the #289 placeholder suffix is gone (#293 supplies the number)');
  // each non-'ok' accounting state says WHY it was not measured — "unreachable" for a never-sampled meter would be a false cause
  const down = memoryAlertBody(EP, { ...FACTS, unattributedDocker: 'unavailable' });
  assert.match(down, /unattributed containers not measured \(Docker unreachable\)\./);
  assert.match(memoryAlertBody(EP, { ...FACTS, unattributedDocker: 'error' }), /unattributed containers not measured \(the Docker query failed\)\./);
  assert.match(memoryAlertBody(EP, { ...FACTS, unattributedDocker: 'not-sampled' }), /unattributed containers not measured yet \(no monitor tick since the app started\)\./);
  for (const st of ['unavailable', 'error', 'not-sampled'] as const) assert.doesNotMatch(memoryAlertBody(EP, { ...FACTS, unattributedDocker: st }), /\d+ unattributed container\(s\)/, `${st}: never a count`);
  assert.match(memoryAlertBody(EP, { ...FACTS, unattributedDocker: 'stale' }), /unattributed containers not measured \(the last Docker pass is too old\)\./);
  assert.match(memoryAlertBody(EP, { ...FACTS, unattributedDocker: 'ok', unattributedContainers: 3 }), /3 unattributed container\(s\)\./);
  assert.match(memoryAlertBody(EP, { ...FACTS, unattributedDocker: 'ok', unattributedContainers: 3, unattributedDaemonsDown: 1 }), /3 unattributed container\(s\) \(at least — 1 Docker daemon\(s\) did not answer\)\./, 'a partial outage makes the count a lower bound, said so');
  assert.match(b, /Now \(20[0-9-]+T[0-9:.]+Z\): MemAvailable 4\.90 GB · Admission HELD · memory Pause none\./);
  assert.doesNotMatch(b, /and below the CRITICAL threshold|already OVER/);
  assert.match(b, /You need not act/);
  assert.match(b, /If MemAvailable falls below the CRITICAL threshold \(3\.00 GB\) the host puts the eligible runs under the memory Pause WITHOUT another row for this episode — read the app banner/, 'the row says what a later critical crossing will not do');
});

test('BODY critical: a critical crossing is named with its threshold and reading; paused runs are listed with the lift threshold', () => {
  const b = memoryAlertBody({ ...EP, critical: { at: 1, availBytes: 2.31 * GIB, thresholdBytes: 3 * GIB, pauseCycle: 1 }, pauseCycles: 1 }, { ...FACTS, pausedRuns: ['L', 'Q'], nowPause: true, nowAvailBytes: 2.5 * GIB });
  assert.match(b, /and below the CRITICAL threshold \(3\.00 GB\) at 2\.31 GB/);
  assert.match(b, /memory Pause on run\(s\) L, Q \(lifted by the host above 6\.00 GB\)/);
  assert.match(b, /memory Pause IN EFFECT/);
  assert.doesNotMatch(b, /WITHOUT another row/, 'the critical crossing is already in the row: nothing to announce');
});

test('BODY states: toggle OFF says nothing is held; an unreadable meter says so; an ended episode says it is over', () => {
  assert.match(memoryAlertBody(EP, { ...FACTS, admissionEnabled: false }), /automatic starts NOT held \(the Admission toggle is OFF — the guard only measures\)/);
  assert.match(memoryAlertBody(EP, { ...FACTS, nowAvailBytes: null }), /Now \(20[0-9-]+T[0-9:.]+Z\): MemAvailable unreadable/);
  assert.match(memoryAlertBody({ ...EP, endedAt: Date.UTC(2027, 0, 15, 8, 5, 0) }, { ...FACTS, nowAdmissionHeld: false, nowAvailBytes: 8 * GIB }), /The episode is already OVER \(memory back above 7\.00 GB at 2027-01-15T08:05:00\.000Z\)\./);
});

test('BODY thresholds follow the settings in force (a custom Admission threshold and margin)', () => {
  const b = memoryAlertBody({ ...EP, admission: { ...EP.admission, thresholdBytes: 8 * GIB } }, { ...FACTS, admissionBytes: 8 * GIB, criticalBytes: 2 * GIB, releaseMarginBytes: 2 * GIB });
  assert.match(b, /below the Admission threshold \(8\.00 GB\)/);
  assert.match(b, /above 10\.00 GB/);
});

test('BODY now-line: Admission shows the EFFECTIVE state (HELD / open / OFF (toggle)), the memory Pause IN EFFECT only when a run is paused', () => {
  const now = (b: string): string => /^Now \(.*$/m.exec(b)?.[0] ?? '';
  assert.match(now(memoryAlertBody(EP, { ...FACTS, nowAdmissionHeld: true })), /Admission HELD · memory Pause none\./);
  assert.match(now(memoryAlertBody(EP, { ...FACTS, nowAdmissionHeld: false })), /Admission open · memory Pause none\./, 'reopened since the crossing');
  assert.match(now(memoryAlertBody(EP, { ...FACTS, admissionEnabled: false, nowAdmissionHeld: false })), /Admission OFF \(toggle\) · memory Pause none\./);
  assert.match(now(memoryAlertBody(EP, { ...FACTS, pausedRuns: ['L'], nowPause: true })), /memory Pause IN EFFECT\./);
});

test('BODY closing: ACT YOURSELF when critical was crossed, nothing is paused and the episode is still going; "need not act" lists only what the host will really do; an episode that is over asks for nothing', () => {
  const crit = { at: 1, availBytes: 2.3 * GIB, thresholdBytes: 3 * GIB, pauseCycle: 1 };
  const act = memoryAlertBody({ ...EP, critical: crit, pauseCycles: 1 }, FACTS);
  assert.match(act, /ACT YOURSELF: the CRITICAL threshold was crossed and NO run is under the memory Pause now \(none eligible — `pause` switch OFF, no live local fleet — a human \/ usage-limit pause already holds it, or its Reprise has begun\): the host has NOT stopped the fleet itself\./);
  assert.match(act, /if it is still running at critical memory, pause it \(`orchestra run pause --hard --run <id>`\)\./, 'the row names the action');
  assert.doesNotMatch(act, /keeps running at critical memory/, 'no unconditional claim about the fleet: it may have been paused by someone else or resuming');
  assert.doesNotMatch(act, /You need not act|WITHOUT another row/);
  const plain = memoryAlertBody(EP, FACTS);
  assert.match(plain, /You need not act: the host releases the held starts by itself once memory recovers\./);
  assert.doesNotMatch(plain, /lifts its own memory Pause/, 'nothing is paused: the host has no Pause to lift');
  const paused = memoryAlertBody({ ...EP, critical: crit, pauseCycles: 1 }, { ...FACTS, pausedRuns: ['L'], nowPause: true });
  assert.match(paused, /You need not act: the host releases the held starts and lifts its own memory Pause by itself once memory recovers\./);
  assert.doesNotMatch(paused, /ACT YOURSELF/);
  const over = memoryAlertBody({ ...EP, critical: crit, pauseCycles: 1, endedAt: Date.UTC(2027, 0, 15, 8, 5, 0) }, FACTS);
  assert.doesNotMatch(over, /ACT YOURSELF/, 'the episode is over');
  assert.match(over, /You need not act: the episode is over\./);
  assert.doesNotMatch(over, /releases the held starts|WITHOUT another row|once memory recovers/, 'an episode that is over promises nothing about releases or a later crossing');
  const overPaused = memoryAlertBody({ ...EP, critical: crit, pauseCycles: 1, endedAt: Date.UTC(2027, 0, 15, 8, 5, 0) }, { ...FACTS, pausedRuns: ['L'], nowPause: true });
  assert.match(overPaused, /You need not act: the host lifts its own memory Pause by itself\. A run under the memory Pause reads this row after its Reprise/);
  const off = memoryAlertBody(EP, { ...FACTS, admissionEnabled: false, nowAdmissionHeld: false });
  assert.match(off, /Nothing for the host to release \(the Admission toggle is OFF and no run is paused\)\./);
  assert.doesNotMatch(off, /You need not act/);
  const offPaused = memoryAlertBody({ ...EP, critical: crit, pauseCycles: 1 }, { ...FACTS, admissionEnabled: false, nowAdmissionHeld: false, pausedRuns: ['L'], nowPause: true });
  assert.match(offPaused, /You need not act: the host lifts its own memory Pause by itself once memory recovers\./, 'only what is real: nothing held to release');
});

test('BODY next-step: with an eligible run the row says a later critical crossing pauses it WITHOUT another row; with NONE eligible it says NOTHING will be paused, no further row, and to pause yourself; an episode that is over says neither', () => {
  const eligible = memoryAlertBody(EP, { ...FACTS, eligibleRuns: 2 });
  assert.match(eligible, /If MemAvailable falls below the CRITICAL threshold \(3\.00 GB\) the host puts the eligible runs under the memory Pause WITHOUT another row for this episode/);
  assert.doesNotMatch(eligible, /NO run is eligible/);
  const none = memoryAlertBody(EP, { ...FACTS, eligibleRuns: 0 });
  assert.match(none, /NO run is eligible for the memory Pause \(every `pause` switch is OFF or no live local fleet\): if MemAvailable falls below the CRITICAL threshold \(3\.00 GB\) the host will pause NOTHING and write NO further row for this episode/);
  assert.match(none, /pause the fleet yourself \(`orchestra run pause --hard --run <id>`\)\./);
  assert.doesNotMatch(none, /puts the eligible runs under the memory Pause/);
  const over = memoryAlertBody({ ...EP, endedAt: Date.UTC(2027, 0, 15, 8, 5, 0) }, FACTS);
  assert.doesNotMatch(over, /If MemAvailable falls below|NO run is eligible/, 'over: a new crossing opens a NEW episode with its own row');
});
