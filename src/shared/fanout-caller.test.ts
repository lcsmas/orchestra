// #612 — who may run the verbs the spike found open: `state set --status merged`, `open`, `gate`, `check`; and the Pause refusal text of `deliver|open|gate`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { callerRefusal, pausedVerbResult, ticketArgOf, resolveCaller, CALLER_REFUSALS, type Caller } from './fanout-caller.ts';
import { blankTicket, newState, seatRecordsOn, type FanoutState } from './fanout-state.ts';
import { pauseGateDecision } from './bus-pause.ts';
import type { IdentityResolution } from './session-identity.ts';

const NOW = '2026-11-25T10:00:00.000Z';
function run(seat: boolean): FanoutState {
  const s = newState('ops-run', { now: NOW, ...(seat ? { switches: { seatRecords: 'on' } } : {}) });
  s.tickets.A = { ...blankTicket(NOW), implementer: 'impl-a', verifier: 'ver-1', review: { reviewer: { id: 'rev-a' } } } as FanoutState['tickets'][string];
  s.tickets.B = { ...blankTicket(NOW), implementer: 'impl-b' };
  return s;
}
const host: IdentityResolution = { source: 'host', runId: 'ops-run', generation: null } as IdentityResolution;
const who = (s: FanoutState, id: string | null, vouched = true): Caller => resolveCaller(s, id ? { ORCHESTRA_WS_ID: id } : {}, vouched ? host : null);
const refuse = (verb: Parameters<typeof callerRefusal>[0], s: FanoutState, c: Caller, ticket?: string) => callerRefusal(verb, s, seatRecordsOn(s), c, ticket);

test('state / open: ONLY the run owner (the coordinator), host-vouched', () => {
  const s = run(true);
  for (const verb of ['state', 'open'] as const) {
    assert.equal(refuse(verb, s, who(s, 'ops-run')), null, `${verb}: owner passes`);
    for (const id of ['impl-a', 'rev-a', 'ver-1', 'stranger']) assert.equal(refuse(verb, s, who(s, id))?.name, CALLER_REFUSALS[verb], `${verb}: ${id} refused`);
  }
});

test('fail closed: the owner id WITHOUT the host\'s word (env-asserted, host unreachable, nothing asked, no id at all) is refused by every verb', () => {
  const s = run(true);
  for (const verb of ['state', 'open', 'gate', 'check'] as const) {
    assert.match(refuse(verb, s, who(s, 'ops-run', false), 'A')!.detail, /host did not vouch/, verb);
    assert.match(refuse(verb, s, who(s, null), 'A')!.detail, /host did not vouch|unidentified/, verb);
  }
});

test('gate: any member of the run by position (coordinator, reviewer, implementer, verifier); a stranger is refused', () => {
  const s = run(true);
  for (const id of ['ops-run', 'rev-a', 'impl-a', 'impl-b', 'ver-1']) assert.equal(refuse('gate', s, who(s, id)), null, id);
  assert.equal(refuse('gate', s, who(s, 'stranger'))?.name, 'gate-caller');
});

test('check: the coordinator or THAT ticket\'s implementer — not another ticket\'s, not a reviewer', () => {
  const s = run(true);
  assert.equal(refuse('check', s, who(s, 'ops-run'), 'A'), null);
  assert.equal(refuse('check', s, who(s, 'impl-a'), 'A'), null);
  assert.equal(refuse('check', s, who(s, 'impl-b'), 'A')?.name, 'check-caller', 'B\'s implementer cannot record A\'s checks');
  assert.equal(refuse('check', s, who(s, 'rev-a'), 'A')?.name, 'check-caller');
  assert.equal(refuse('check', s, who(s, 'impl-a'), undefined)?.name, 'check-caller', 'no ticket named: only the coordinator');
});

test('control (the unfixed arm): seatRecords OFF or no state judges nobody — the v1 flow is untouched', () => {
  const off = run(false);
  for (const verb of ['state', 'open', 'gate', 'check'] as const) {
    assert.equal(refuse(verb, off, who(off, 'stranger', false), 'A'), null, `${verb} off`);
    assert.equal(callerRefusal(verb, null, true, who(off, 'stranger', false), 'A'), null, `${verb} no state`);
  }
});

test('Pause refusal of deliver / open / gate: reason run-paused, exit 2, the text of a refused spawn', () => {
  const text = pauseGateDecision({ runId: 'ops-run' })!;
  assert.equal(text, 'run en pause — orchestra run resume --run ops-run');
  for (const verb of ['deliver', 'open', 'gate'] as const) {
    const r = pausedVerbResult(verb, 'ops-run', text);
    assert.equal(r.exit, 2);
    const j = JSON.parse(r.stdout);
    assert.deepEqual([j.verdict, j.reason, j.verb, j.run, j.detail], ['refused', 'run-paused', verb, 'ops-run', text]);
    assert.equal(r.stderr, `${text}\n`);
  }
  assert.equal(pauseGateDecision(null), null, 'not paused ⇒ no refusal');
});

test('the ticket of a check / gate argv: flag order does not hide it (an implementer must not be refused for writing --run first)', () => {
  assert.equal(ticketArgOf('check', ['check', 'T1', '--run', 'r']), 'T1');
  assert.equal(ticketArgOf('check', ['check', '--run', 'r', 'T1']), 'T1');
  assert.equal(ticketArgOf('check', ['check', '--head', 'abc', '--run', 'r', 'T1']), 'T1');
  assert.equal(ticketArgOf('check', ['check', '--run', 'r']), undefined);
  assert.equal(ticketArgOf('gate', ['gate', '--branch', 'b', '--ticket', 'T2', '--run', 'r']), 'T2');
  assert.equal(ticketArgOf('gate', ['gate', '--branch', 'b']), undefined);
});
