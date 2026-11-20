import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  HANDOFF_SUMMARY_MAX_CHARS, HandoffTurnCounter, composeDroppedNotice, composeNudge, composeOpeningTurn, decideHandoffRun, handoffSummaryError,
  parseHandoffBound, resolveHandoffBound, validateHandoffSummary,
} from './handoff.ts';

const GOOD = `## STATE
Lever 2 coded, tests green on branch handoff-bounded-lifetime-466.
## NEXT STEPS
1. run the rig
2. nominate
## REFS
Ledger https://github.com/lcsmas/orchestra/issues/471, state file fanout/ops/state.json
## NOT VERIFIED
the packaged app was not driven`;

test('a well-formed summary passes and its sections are returned', () => {
  const v = validateHandoffSummary(GOOD);
  assert.equal(v.ok, true);
  if (v.ok) {
    assert.match(v.sections.state, /Lever 2 coded/);
    assert.match(v.sections.next, /nominate/);
    assert.match(v.sections.notVerified, /packaged app/);
  }
});

test('inline `LABEL: text` headers and bold labels are accepted', () => {
  const v = validateHandoffSummary('**STATE:** done\n**Next steps:** ship\nREFS: #466 and src/cli/handoff.ts\nNot verified: nothing beyond the unit tests');
  assert.equal(v.ok, true);
});

for (const [name, drop] of [['STATE', '## STATE\nLever 2 coded, tests green on branch handoff-bounded-lifetime-466.\n'], ['NEXT STEPS', '## NEXT STEPS\n1. run the rig\n2. nominate\n'], ['REFS', '## REFS\nLedger https://github.com/lcsmas/orchestra/issues/471, state file fanout/ops/state.json\n'], ['NOT VERIFIED', '## NOT VERIFIED\nthe packaged app was not driven']] as const) {
  test(`must-FAIL: a summary without ${name} is refused naming it`, () => {
    const v = validateHandoffSummary(GOOD.replace(drop, ''));
    assert.equal(v.ok, false);
    if (!v.ok) assert.ok(v.problems.some((p) => p.includes(`missing section ${name}`)), v.problems.join('|'));
  });
}

test('must-FAIL: an empty section, an empty summary and a non-string are refused', () => {
  const v = validateHandoffSummary(GOOD.replace('the packaged app was not driven', ''));
  assert.equal(v.ok, false);
  if (!v.ok) assert.ok(v.problems.some((p) => p.includes('NOT VERIFIED is empty')));
  assert.equal(validateHandoffSummary('   ').ok, false);
  assert.equal(validateHandoffSummary(undefined).ok, false);
  assert.equal(validateHandoffSummary(42).ok, false);
});

test('must-FAIL: REFS that name nothing findable are refused; each findable kind passes', () => {
  const bare = GOOD.replace(/Ledger https[^\n]*/, 'see above');
  const v = validateHandoffSummary(bare);
  assert.equal(v.ok, false);
  if (!v.ok) assert.ok(v.problems.some((p) => p.includes('names nothing findable')));
  for (const ref of ['#466', 'https://x.test/a', 'src/cli/handoff.ts', 'fanout/state.json', 'state.json', 'deadbeef1', 'a/b/c']) {
    assert.equal(validateHandoffSummary(GOOD.replace(/Ledger https[^\n]*/, ref)).ok, true, ref);
  }
  for (const nothing of ['defaced', 'effaced and/or whatever', 'see above', 'abcdefabcdef']) {
    assert.equal(validateHandoffSummary(GOOD.replace(/Ledger https[^\n]*/, nothing)).ok, false, `"${nothing}" names nothing findable`);
  }
});

test('must-FAIL: an oversized summary is refused with its size', () => {
  const v = validateHandoffSummary(GOOD + '\n' + 'x'.repeat(HANDOFF_SUMMARY_MAX_CHARS));
  assert.equal(v.ok, false);
  if (!v.ok) assert.ok(v.problems.some((p) => p.includes('max 16000')));
});

test('sections out of order are refused; all problems come back at once', () => {
  const swapped = 'NEXT STEPS: a\nSTATE: b\nREFS: #1\nNOT VERIFIED: c';
  const v = validateHandoffSummary(swapped);
  assert.equal(v.ok, false);
  if (!v.ok) assert.ok(v.problems.some((p) => p.includes('out of order')));
  const two = validateHandoffSummary('STATE: only this');
  assert.equal(two.ok, false);
  if (!two.ok) {
    assert.equal(two.problems.length, 3);
    assert.match(handoffSummaryError(two.problems), /^handoff-summary-invalid: /);
  }
});

test('a header inside a code fence is body text, not a header', () => {
  const v = validateHandoffSummary(GOOD.replace('1. run the rig', '```\nREFS: nope\n```\n1. run the rig'));
  assert.equal(v.ok, true);
  if (v.ok) assert.match(v.sections.next, /REFS: nope/);
});

test('opening turn carries the summary verbatim and names the saved file', () => {
  const t = composeOpeningTurn({ summary: GOOD, turns: 7, savedAt: '2026-11-19T10:00:00Z', file: '/h/handoff/x.md' });
  assert.ok(t.includes(GOOD));
  assert.match(t, /after 7 turns/);
  assert.match(t, /saved at \/h\/handoff\/x\.md/);
  assert.match(composeOpeningTurn({ summary: GOOD, savedAt: 'now' }), /previous context ended by your own/);
});

test('nudge text names the verb, the bound and that nothing is ended unless asked', () => {
  const n = composeNudge(42, 40);
  assert.match(n, /orchestra handoff --summary-file/);
  assert.match(n, /42 turns \(bound 40\)/);
  assert.match(n, /nothing is ended unless you run the command/);
});

test('bound: one env value; unset/0/garbage = off', () => {
  assert.deepEqual(parseHandoffBound({}), { bound: 0 });
  assert.deepEqual(parseHandoffBound({ ORCHESTRA_HANDOFF_BOUND_TURNS: '0' }), { bound: 0 });
  assert.deepEqual(parseHandoffBound({ ORCHESTRA_HANDOFF_BOUND_TURNS: ' 40 ' }), { bound: 40 });
  assert.equal(parseHandoffBound({ ORCHESTRA_HANDOFF_BOUND_TURNS: 'abc' }).bound, 0);
  assert.ok(parseHandoffBound({ ORCHESTRA_HANDOFF_BOUND_TURNS: '-3' }).invalid);
  assert.ok(parseHandoffBound({ ORCHESTRA_HANDOFF_BOUND_TURNS: '2.5' }).invalid);
  for (const v of ['1', '2', '3']) {
    const r = parseHandoffBound({ ORCHESTRA_HANDOFF_BOUND_TURNS: v });
    assert.equal(r.bound, 0, `bound ${v} is under the minimum`);
    assert.match(r.invalid ?? '', /under the minimum 4/);
  }
  assert.deepEqual(parseHandoffBound({ ORCHESTRA_HANDOFF_BOUND_TURNS: '4' }), { bound: 4 });
});

test('#478 resolveHandoffBound: env (set) > role bound; env 0 forces off; invalid env = off, never the role value; unset env = the role value', () => {
  const E = (v?: string) => (v === undefined ? {} : { ORCHESTRA_HANDOFF_BOUND_TURNS: v });
  assert.deepEqual(resolveHandoffBound(E(), 30), { bound: 30, source: 'role' });
  assert.deepEqual(resolveHandoffBound(E(''), 30), { bound: 30, source: 'role' }, 'an empty env is unset');
  assert.deepEqual(resolveHandoffBound(E('50'), 30), { bound: 50, source: 'env' }, 'env wins over the role');
  assert.deepEqual(resolveHandoffBound(E('50'), 0), { bound: 50, source: 'env' }, 'env turns on a role that is off');
  assert.deepEqual(resolveHandoffBound(E('0'), 30), { bound: 0, source: 'off' }, '0 forces off for a role that is on');
  const bad = resolveHandoffBound(E('abc'), 30);
  assert.deepEqual([bad.bound, bad.source], [0, 'off']);
  assert.match(bad.invalid ?? '', /not a non-negative integer/);
  assert.equal(resolveHandoffBound(E('2'), 30).bound, 0, 'under the minimum = off, not the role value');
  assert.deepEqual(resolveHandoffBound(E(), 0), { bound: 0, source: 'off' }, 'no env, role off');
});

test('counter: nudges ONCE at the bound, never before, never again in the same session', () => {
  const c = new HandoffTurnCounter();
  const seen: boolean[] = [];
  for (let i = 0; i < 8; i++) {
    const r = c.noteTurnEnd('w', 's1', 5);
    seen.push(r.nudge);
    if (r.nudge) c.markNudged('w'); // the caller confirms the send
  }
  assert.deepEqual(seen, [false, false, false, false, true, false, false, false]);
  const unsent = new HandoffTurnCounter(); // no markNudged ⇒ still owed at every turn end past the bound
  assert.deepEqual([1, 2, 3].map(() => unsent.noteTurnEnd('w', 's', 2).nudge), [false, true, true]);
  assert.equal(c.turnsOf('w'), 8);
});

test('counter: a new session id resets the count and re-arms the latch; workspaces are independent; bound 0 never nudges', () => {
  const c = new HandoffTurnCounter();
  for (let i = 0; i < 3; i++) { if (c.noteTurnEnd('w', 's1', 4).nudge) c.markNudged('w'); }
  assert.equal(c.turnsOf('w'), 3);
  c.markNudged('w');
  assert.equal(c.noteTurnEnd('w', 's2', 4).turns, 1);
  for (let i = 0; i < 3; i++) c.noteTurnEnd('w', 's2', 4);
  assert.equal(c.noteTurnEnd('w', 's2', 4).nudge, true, 'the new session was re-armed');
  assert.equal(c.noteTurnEnd('other', 's1', 3).turns, 1);
  const off = new HandoffTurnCounter();
  for (let i = 0; i < 50; i++) assert.equal(off.noteTurnEnd('w', 's', 0).nudge, false);
});

test('run decision: waits behind a queue or a pause, expires, otherwise runs', () => {
  assert.equal(decideHandoffRun({ queueLen: 0, paused: false, ageMs: 1 }), 'run');
  assert.equal(decideHandoffRun({ queueLen: 1, paused: false, ageMs: 1 }), 'wait');
  assert.equal(decideHandoffRun({ queueLen: 0, paused: true, ageMs: 1 }), 'wait');
  assert.equal(decideHandoffRun({ queueLen: 0, paused: false, ageMs: 11 * 60_000 }), 'expired');
});

test('m4: nudge and opening frame warn that background runs are stopped with the context; the dropped notice names why and what to do', () => {
  assert.match(composeNudge(40, 40), /processes your context started in the background.*are stopped with it/);
  assert.match(composeOpeningTurn({ summary: 'S', savedAt: 'now' }), /background run started by your previous context was STOPPED/);
  const n = composeDroppedNotice('its context already ended another way');
  assert.match(n, /did NOT run \(its context already ended another way\)/);
  assert.match(n, /Run `orchestra handoff --summary-file <path>` again/);
});
