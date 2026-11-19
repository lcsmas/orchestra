// #466 — the handoff state machine against fake collaborators. Every refusal has a must-FAIL arm: the asserted side effect (a context ended, a turn delivered) is
// counted by the fakes, so a controller that ends a context it should not shows a non-zero count.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHandoffController, type HandoffDeps } from './handoff-controller.ts';

const GOOD = 'STATE: coded\nNEXT STEPS: nominate\nREFS: https://github.com/lcsmas/orchestra/issues/466\nNOT VERIFIED: the packaged app';

function rig(opts: Partial<Omit<HandoffDeps, 'bound'>> & { bound?: number } = {}) {
  const { bound, ...over } = opts;
  const calls = { ended: [] as string[], opened: [] as { id: string; text: string }[], nudges: [] as { id: string; text: string }[], reports: [] as string[], saved: [] as string[] };
  let t = 1_000_000;
  const cur = { session: 's1' as string | undefined };
  const deps: HandoffDeps = {
    now: () => t,
    vouched: (id, key) => key === `key-${id}`,
    workspaceLive: () => true,
    runRefusal: () => null,
    blocked: () => null,
    sessionOf: () => cur.session,
    saveSummary: (id, s) => { calls.saved.push(s); return `/h/handoff/${id}/x.md`; },
    bound: () => bound ?? 0,
    endContext: async (id) => { calls.ended.push(id); },
    deliverOpening: async (id, text) => { calls.opened.push({ id, text }); return 'sent'; },
    sendNudge: async (id, text) => { calls.nudges.push({ id, text }); },
    report: (_id, text) => calls.reports.push(text),
    log: { info() {}, warn() {}, error() {} },
    ...over,
  };
  const c = createHandoffController(deps);
  return { c, calls, cur, tick: (ms: number) => { t += ms; } };
}
const turn = (c: ReturnType<typeof rig>['c'], id = 'w1', queueLen = 0, sessionId = 's1') => c.onTurnEnd({ wsId: id, sessionId, queueLen });

test('accepted handoff only SCHEDULES: nothing is ended until the turn end', async () => {
  const { c, calls } = rig();
  const r = c.dispatch({ id: 'w1', key: 'key-w1', summary: GOOD });
  assert.equal(r.ok, true);
  assert.deepEqual(calls.ended, []);
  assert.equal(c.pendingFor('w1'), true);
  assert.equal(calls.saved[0], GOOD);
});

test('at the turn end the context is ended ONCE and the summary becomes the opening turn, verbatim', async () => {
  const { c, calls } = rig();
  c.dispatch({ id: 'w1', key: 'key-w1', summary: GOOD });
  await turn(c);
  assert.deepEqual(calls.ended, ['w1']);
  assert.equal(calls.opened.length, 1);
  assert.ok(calls.opened[0].text.includes(GOOD));
  assert.match(calls.opened[0].text, /\/h\/handoff\/w1\/x\.md/);
  assert.equal(c.pendingFor('w1'), false);
  assert.equal(c.turnsOf('w1'), 0, 'the count restarts with the fresh context');
  await turn(c, 'w1', 0, 's2'); // the next turn end of the NEW session: nothing more happens
  assert.deepEqual(calls.ended, ['w1']);
  assert.equal(calls.opened.length, 1);
});

test('the end happens BEFORE the delivery (a start before the clear would resume the old conversation)', async () => {
  const order: string[] = [];
  const { c } = rig({ endContext: async () => { order.push('end'); }, deliverOpening: async () => { order.push('deliver'); return 'sent'; } });
  c.dispatch({ id: 'w1', key: 'key-w1', summary: GOOD });
  await turn(c);
  assert.deepEqual(order, ['end', 'deliver']);
});

test('must-FAIL: a session the host cannot vouch for ends nothing and schedules nothing', async () => {
  const { c, calls } = rig();
  for (const msg of [{ id: 'w1', key: 'wrong', summary: GOOD }, { id: 'w1', summary: GOOD }, { key: 'key-w1', summary: GOOD }]) {
    const r = c.dispatch(msg);
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, /^handoff-unvouched/);
  }
  await turn(c);
  assert.deepEqual(calls.ended, []);
  assert.equal(c.pendingFor('w1'), false);
});

test('must-FAIL: outside an open run → named error, nothing scheduled, nothing ended', async () => {
  const { c, calls } = rig({ runRefusal: () => 'handoff-outside-run: workspace w1 is not a member of an open run — …' });
  const r = c.dispatch({ id: 'w1', key: 'key-w1', summary: GOOD });
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /^handoff-outside-run/);
  await turn(c);
  assert.deepEqual(calls.ended, []);
  assert.equal(calls.saved.length, 0);
});

test('must-FAIL: an archived/unknown workspace is refused as outside a run', () => {
  const { c } = rig({ workspaceLive: () => false });
  const r = c.dispatch({ id: 'w1', key: 'key-w1', summary: GOOD });
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /^handoff-outside-run/);
});

test('must-FAIL: a malformed summary is refused with the shape error; nothing is saved or scheduled', async () => {
  const { c, calls } = rig();
  const r = c.dispatch({ id: 'w1', key: 'key-w1', summary: 'STATE: only' });
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /^handoff-summary-invalid: .*missing section NEXT STEPS/);
  assert.equal(calls.saved.length, 0);
  await turn(c);
  assert.deepEqual(calls.ended, []);
});

test('must-FAIL: a fleet Pause / paused sandbox refuses the request', () => {
  const { c } = rig({ blocked: () => 'run en pause' });
  const r = c.dispatch({ id: 'w1', key: 'key-w1', summary: GOOD });
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /^handoff-unavailable: run en pause/);
});

test('a second handoff while one is scheduled is refused (no double clear)', async () => {
  const { c, calls } = rig();
  assert.equal(c.dispatch({ id: 'w1', key: 'key-w1', summary: GOOD }).ok, true);
  const r = c.dispatch({ id: 'w1', key: 'key-w1', summary: GOOD });
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /^handoff-already-pending/);
  await turn(c);
  assert.equal(calls.ended.length, 1);
});

test('a prompt queued behind the turn delays the clear (it would be discarded); the next free turn end runs it', async () => {
  const { c, calls } = rig();
  c.dispatch({ id: 'w1', key: 'key-w1', summary: GOOD });
  await turn(c, 'w1', 2);
  assert.deepEqual(calls.ended, []);
  assert.equal(c.pendingFor('w1'), true);
  await turn(c, 'w1', 0);
  assert.deepEqual(calls.ended, ['w1']);
});

test('a handoff that never reaches a free turn end expires and the context is KEPT', async () => {
  const { c, calls, tick } = rig();
  c.dispatch({ id: 'w1', key: 'key-w1', summary: GOOD });
  tick(11 * 60_000);
  await turn(c);
  assert.deepEqual(calls.ended, []);
  assert.equal(c.pendingFor('w1'), false);
});

test('a failed clear keeps the old context, delivers nothing and reports', async () => {
  const { c, calls } = rig({ endContext: async () => { throw new Error('boom'); } });
  c.dispatch({ id: 'w1', key: 'key-w1', summary: GOOD });
  await turn(c);
  assert.equal(calls.opened.length, 0);
  assert.match(calls.reports[0], /still on the old context.*x\.md/);
});

test('a failed delivery after the clear is REPORTED with the saved file; a held one is not (the retry owns it)', async () => {
  const failed = rig({ deliverOpening: async () => 'failed' });
  failed.c.dispatch({ id: 'w1', key: 'key-w1', summary: GOOD });
  await turn(failed.c);
  assert.match(failed.calls.reports[0], /could not be delivered.*x\.md/);
  const held = rig({ deliverOpening: async () => 'held' });
  held.c.dispatch({ id: 'w1', key: 'key-w1', summary: GOOD });
  await turn(held.c);
  assert.deepEqual(held.calls.reports, []);
});

test('nudge: ONCE at the bound, never before, never again, and never an auto-end', async () => {
  const { c, calls } = rig({ bound: 3 });
  for (let i = 0; i < 2; i++) await turn(c);
  assert.equal(calls.nudges.length, 0);
  await turn(c);
  assert.equal(calls.nudges.length, 1);
  assert.match(calls.nudges[0].text, /orchestra handoff --summary-file/);
  for (let i = 0; i < 6; i++) await turn(c);
  assert.equal(calls.nudges.length, 1);
  assert.deepEqual(calls.ended, [], 'a nudge never ends a context');
});

test('must-FAIL control: bound 0 (handoff disabled) never nudges however long the session runs', async () => {
  const { c, calls } = rig({ bound: 0 });
  for (let i = 0; i < 100; i++) await turn(c);
  assert.equal(calls.nudges.length, 0);
});

test('nudge re-arms for the fresh session after a handoff (a new context may be nudged once more)', async () => {
  const { c, calls } = rig({ bound: 2 });
  await turn(c); await turn(c);
  assert.equal(calls.nudges.length, 1);
  c.dispatch({ id: 'w1', key: 'key-w1', summary: GOOD });
  await turn(c); // handoff runs here
  assert.equal(calls.ended.length, 1);
  await turn(c, 'w1', 0, 's2'); await turn(c, 'w1', 0, 's2');
  assert.equal(calls.nudges.length, 2);
});

test('a paused or archived member is not nudged; counters are per workspace', async () => {
  const { c, calls } = rig({ bound: 1, blocked: (id) => (id === 'w2' ? 'run en pause' : null) });
  await turn(c, 'w2');
  assert.equal(calls.nudges.length, 0);
  await turn(c, 'w1');
  assert.deepEqual(calls.nudges.map((n) => n.id), ['w1']);
  const gone = rig({ bound: 1, workspaceLive: () => false });
  await turn(gone.c);
  assert.equal(gone.calls.nudges.length, 0);
});

test('a scheduled handoff suppresses the nudge on the same turn end', async () => {
  const { c, calls } = rig({ bound: 1 });
  c.dispatch({ id: 'w1', key: 'key-w1', summary: GOOD });
  await turn(c, 'w1', 1); // waits behind a queue — and is NOT nudged on top
  assert.equal(calls.nudges.length, 0);
});

test('a handoff scheduled on one context is DROPPED if another context is running at the turn end (/clear in between)', async () => {
  const { c, calls, cur } = rig();
  c.dispatch({ id: 'w1', key: 'key-w1', summary: GOOD });
  cur.session = 's2';
  await turn(c, 'w1', 0, 's2');
  assert.deepEqual(calls.ended, [], 'the old summary is never applied to the new conversation');
  assert.equal(c.pendingFor('w1'), false);
});

test('an expired / orphaned pending handoff does not block the agent\'s retry; a live one still does', async () => {
  const { c, tick, cur } = rig();
  assert.equal(c.dispatch({ id: 'w1', key: 'key-w1', summary: GOOD }).ok, true);
  assert.equal(c.dispatch({ id: 'w1', key: 'key-w1', summary: GOOD }).ok, false);
  tick(11 * 60_000);
  assert.equal(c.dispatch({ id: 'w1', key: 'key-w1', summary: GOOD }).ok, true, 'expired → replaced');
  cur.session = 's9';
  assert.equal(c.dispatch({ id: 'w1', key: 'key-w1', summary: GOOD }).ok, true, 'its context is gone → replaced');
});

test('a nudge whose SEND failed or was skipped is not consumed: the next turn end nudges again', async () => {
  let fail = true;
  const sent: string[] = [];
  const { c } = rig({ bound: 2, sendNudge: async (id) => { if (fail) throw new Error('queue closed'); sent.push(id); } });
  await turn(c); await turn(c);
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(sent, []);
  fail = false;
  await turn(c);
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(sent, ['w1']);
  await turn(c); await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(sent, ['w1'], 'once accepted, never again for this session');
});

test('a nudge skipped by a Pause is owed, not lost', async () => {
  let paused = true;
  const { c, calls } = rig({ bound: 1, blocked: () => (paused ? 'run en pause' : null) });
  await turn(c);
  assert.equal(calls.nudges.length, 0);
  paused = false;
  await turn(c);
  assert.equal(calls.nudges.length, 1);
});
