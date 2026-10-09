// #321 — the pure half of the Docker relay hold: which calls wait, which container a START may hold, the state the app publishes and how a keeper reads it (fail-open), the reason text, the lines.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ADMISSION_STATE_TTL_MS,
  admissionStateFile,
  admissionStateOf,
  describeHold,
  formatDockerHoldsLine,
  fmtWait,
  heldOpOf,
  heldWarning,
  holdIsLive,
  holdNoticeText,
  holdReason,
  holdsNow,
  mayReleaseOne,
  parseAdmissionState,
  parseHoldFile,
  startIsHoldable,
  stateIsFresh,
  type HoldFile,
} from './docker-hold.ts';
import { GIB } from './memory-guard.ts';

const snap = (over: Record<string, unknown> = {}) => ({ admission: 'held' as const, admissionEnabled: true, heldSince: 1_000, episode: 2, availBytes: 5.5 * GIB, admissionBytes: 6 * GIB, releaseMarginBytes: GIB, ...over });

test('heldOpOf: create and start (with or without the /vNN prefix) wait; every other call, method and look-alike path does not', () => {
  assert.deepEqual(heldOpOf('POST', '/containers/create?name=x'), { kind: 'create' });
  assert.deepEqual(heldOpOf('POST', '/v1.47/containers/create'), { kind: 'create' });
  assert.deepEqual(heldOpOf('POST', '/v1.47/containers/abc123/start'), { kind: 'start', id: 'abc123', prefix: '/v1.47' });
  assert.deepEqual(heldOpOf('POST', '/containers/my%2Dname/start?detachKeys=x'), { kind: 'start', id: 'my-name', prefix: '' });
  for (const [m, u] of [
    ['GET', '/containers/create'], ['GET', '/containers/abc/start'], ['POST', '/containers/abc/stop'], ['POST', '/containers/abc/restart'], ['POST', '/containers/abc/exec'],
    ['POST', '/containers/abc/startx'], ['POST', '/containers/a/b/start'], ['POST', '/build'], ['POST', '/images/create'], ['POST', '/exec/abc/start'], ['POST', '/containers/create/x'], [undefined, '/containers/create'], ['POST', undefined],
  ] as const) assert.equal(heldOpOf(m, u), null, `${m} ${u}`);
});

test('startIsHoldable: ONLY a stopped container labelled for THIS workspace; unknown / running / foreign / unlabelled / human stacks are never held', () => {
  const L = 'orchestra.ws';
  assert.equal(startIsHoldable({ labels: { [L]: 'ws-1' }, running: false }, 'ws-1', L), true);
  assert.equal(startIsHoldable({ labels: { [L]: 'ws-1' } }, 'ws-1', L), true);
  assert.equal(startIsHoldable({ labels: { [L]: 'ws-1' }, running: true }, 'ws-1', L), false);
  assert.equal(startIsHoldable({ labels: { [L]: 'ws-2' }, running: false }, 'ws-1', L), false);
  assert.equal(startIsHoldable({ labels: { 'com.docker.compose.project': 'p' }, running: false }, 'ws-1', L), false);
  assert.equal(startIsHoldable({ labels: null, running: false }, 'ws-1', L), false);
  assert.equal(startIsHoldable({ running: false }, 'ws-1', L), false);
  assert.equal(startIsHoldable(null, 'ws-1', L), false);
});

test('admissionStateOf: held = the EFFECTIVE hold (toggle ON and guard held) — a held guard with the toggle OFF publishes NOT held', () => {
  assert.equal(admissionStateOf(snap(), 9).held, true);
  assert.equal(admissionStateOf(snap({ admissionEnabled: false }), 9).held, false);
  assert.equal(admissionStateOf(snap({ admissionEnabled: false }), 9).enabled, false, 'the toggle itself is published: a line already waiting is released at once');
  assert.equal(admissionStateOf(snap(), 9).enabled, true);
  assert.equal(admissionStateOf(snap({ admission: 'open' }), 9).held, false);
  const s = admissionStateOf(snap(), 9);
  assert.deepEqual(s, { v: 1, ts: 9, held: true, enabled: true, heldSince: 1_000, episode: 2, availBytes: 5.5 * GIB, admissionBytes: 6 * GIB, releaseMarginBytes: GIB });
  assert.equal(admissionStateOf(snap({ admission: 'open' }), 9).heldSince, null, 'no heldSince when not held');
});

test('parseAdmissionState round-trips and rejects anything it does not fully understand (a keeper must never obey a half-file)', () => {
  const s = admissionStateOf(snap(), 9);
  assert.deepEqual(parseAdmissionState(JSON.stringify(s)), s);
  assert.deepEqual(parseAdmissionState(JSON.stringify({ ...s, availBytes: null, heldSince: null })), { ...s, availBytes: null, heldSince: null });
  for (const bad of ['', 'nope', '[]', 'null', JSON.stringify({ ...s, v: 2 }), JSON.stringify({ ...s, held: 'yes' }), JSON.stringify({ ...s, enabled: undefined }), JSON.stringify({ ...s, enabled: 1 }), JSON.stringify({ ...s, ts: 'x' }), JSON.stringify({ ...s, admissionBytes: null }), JSON.stringify({ ...s, heldSince: 'x' }), JSON.stringify({ ...s, availBytes: 'x' }), JSON.stringify({ ...s, episode: NaN })]) {
    assert.equal(parseAdmissionState(bad), null, bad.slice(0, 40));
  }
});

test('holdsNow is the fail-open rule: absent / stale (past the TTL, either direction) ⇒ no hold; fresh + held ⇒ hold; fresh + open ⇒ none', () => {
  const now = 10_000_000;
  const mk = (held: boolean, ts: number) => ({ ...admissionStateOf(snap({ admission: held ? 'held' : 'open' }), ts) });
  assert.equal(holdsNow(null, now), false);
  assert.equal(holdsNow(mk(true, now), now), true);
  assert.equal(holdsNow(mk(true, now - ADMISSION_STATE_TTL_MS), now), true, 'exactly at the TTL still counts');
  assert.equal(holdsNow(mk(true, now - ADMISSION_STATE_TTL_MS - 1), now), false, 'the app is gone');
  assert.equal(holdsNow(mk(true, now + ADMISSION_STATE_TTL_MS + 1), now), false, 'a state from the far future (clock step) must not wedge a hold');
  assert.equal(holdsNow(mk(false, now), now), false);
  assert.equal(stateIsFresh(mk(true, now), now), true);
});

test('mayReleaseOne: strictly ABOVE threshold + margin; an unreadable meter never wedges the line', () => {
  const t = { admissionBytes: 6 * GIB, releaseMarginBytes: GIB };
  assert.equal(mayReleaseOne(t, 7 * GIB + 1), true);
  assert.equal(mayReleaseOne(t, 7 * GIB), false, 'strict, like mayReleaseOneStart');
  assert.equal(mayReleaseOne(t, 6.5 * GIB), false);
  assert.equal(mayReleaseOne(t, 0), false);
  assert.equal(mayReleaseOne(t, null), true);
  assert.equal(mayReleaseOne(t, NaN), true);
  assert.equal(mayReleaseOne(t, -1), true);
});

test('holdReason says the reading, the threshold, when it reopens and since when', () => {
  assert.equal(holdReason(admissionStateOf(snap({ heldSince: Date.UTC(2026, 9, 9, 14, 3, 11) }), 1)), 'Admission hold: MemAvailable 5.50 GB < 6.00 GB (reopens above 7.00 GB; episode 2, held since 14:03:11Z)');
  assert.match(holdReason(admissionStateOf(snap({ availBytes: null, heldSince: null }), 1)), /^Admission hold: MemAvailable unknown < 6\.00 GB \(reopens above 7\.00 GB; episode 2\)$/);
});

test('fmtWait / heldWarning / admissionStateFile', () => {
  assert.equal(fmtWait(4_000), '4 s');
  assert.equal(fmtWait(125_000), '2 min 5 s');
  assert.equal(fmtWait(-5), '0 s');
  assert.equal(heldWarning(4_000, 'why'), 'orchestra: this container call waited 4 s under the Admission hold (why) and went through when memory was back');
  assert.match(heldWarning(4_000, 'why', true), /waited 4 s under the Admission hold \(why\) and was released because the Admission state is no longer published/);
  assert.equal(admissionStateFile('/home/u/.orchestra'), '/home/u/.orchestra/admission.state');
  assert.equal(admissionStateFile('/home/u/.orchestra/'), '/home/u/.orchestra/admission.state');
});

const HOLD: HoldFile = { v: 1, ts: 100_000, create: 2, start: 1, since: 40_000, heldSince: 30_000, episode: 5, reason: 'Admission hold: MemAvailable 5.00 GB < 6.00 GB (reopens above 7.00 GB; episode 5)' };

test('parseHoldFile / holdIsLive: only a recent, non-empty hold is live', () => {
  assert.deepEqual(parseHoldFile(JSON.stringify(HOLD)), HOLD);
  assert.equal(parseHoldFile(JSON.stringify({ ...HOLD, v: 2 })), null);
  assert.equal(parseHoldFile(JSON.stringify({ ...HOLD, reason: 3 })), null);
  assert.equal(parseHoldFile('x'), null);
  assert.equal(holdIsLive(HOLD, 100_000 + 30_000), true);
  assert.equal(holdIsLive(HOLD, 100_000 + 30_001), false, 'a dead keeper\'s leftover');
  assert.equal(holdIsLive({ ...HOLD, create: 0, start: 0 }, 100_000), false);
});

test('the lines: `docker holds:` says who waits, since when and why; empty when nothing waits; the notice tells the member nothing is refused', () => {
  const now = 100_000;
  assert.equal(formatDockerHoldsLine([], now), '');
  assert.equal(formatDockerHoldsLine([{ wsId: 'w', label: 'api', hold: { ...HOLD, ts: 1 } }], now), '', 'a stale file prints nothing');
  const line = formatDockerHoldsLine([{ wsId: 'w', label: 'api', hold: HOLD }, { wsId: 'x', label: 'web', hold: { ...HOLD, create: 0, start: 1 } }], now);
  assert.match(line, /^docker holds: api: 3 docker call\(s\) waiting \(2 create \+ 1 start\) for 1 min 0 s \(since 00:00:40Z\) — Admission hold: MemAvailable 5\.00 GB < 6\.00 GB/);
  assert.match(line, / \| web: 1 docker call\(s\) waiting \(1 start\)/);
  assert.match(describeHold('api', HOLD, now), /^api: 3 docker call\(s\)/);
  const n = holdNoticeText(HOLD, now);
  assert.match(n, /holding 3 of your docker call\(s\)/);
  assert.match(n, /BY THEMSELVES/);
  assert.match(n, /nothing is refused and nothing needs retrying/);
  assert.match(n, /never held/);
  assert.match(n, /orchestra bus-status/);
  assert.match(n, /abandoned, never replayed/);
});
