// #553 — the close-out rule: one ticket text per MEASURED, non-process MINOR; the four parts; the recording refusal. Pure (no CLI).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyTicketPatch, FanoutStateError, newState } from './fanout-state.ts';
import { closeoutSkip, closeoutTexts, renderCloseout } from './fanout-closeout.ts';

const NOW = '2026-11-23T10:00:00.000Z';
const REP = { input: 'POST /x with []', happens: '500 instead of 400', where: 'src/api/x.ts:42', proof: 'curl -i → 500' };
const rec = (findings: Record<string, unknown>, ticket = 'T-1', settle?: Record<string, unknown>) => {
  const s0 = newState('r', { now: NOW });
  const s1 = applyTicketPatch(s0, ticket, { status: 'started', findings }, NOW);
  return settle ? applyTicketPatch(s1, ticket, { settle }, NOW) : s1;
};

test('one measured MINOR → exactly one ticket text carrying input / what happens / where / proof', () => {
  const r = closeoutTexts(rec({ 'F-1': { severity: 'MINOR', evidence: 'measured', report: REP } }));
  assert.equal(r.texts.length, 1);
  const t = r.texts[0];
  for (const v of Object.values(REP)) assert.ok(t.body.includes(v), `body lacks ${v}`);
  assert.deepEqual([t.ticket, t.finding, t.run], ['T-1', 'F-1', 'r']);
  assert.match(t.body, /fanoutcloseout[0-9a-f]{12}/);
  assert.match(renderCloseout(r, 'r'), /1 ticket text\(s\) to file/);
});

test('argued MINOR, process finding, BLOCKING/MAJOR, legacy string, already-fixed → no text, each counted', () => {
  const r = closeoutTexts(rec({
    A: { severity: 'MINOR', evidence: 'argued' },
    P: { severity: 'MINOR', evidence: 'measured', kind: 'process' },
    B: { severity: 'BLOCKING', evidence: 'measured', report: REP },
    M: 'MAJOR',
    L: 'MINOR',
    F: { severity: 'MINOR', evidence: 'measured', report: REP },
  }, 'T-1', { F: { how: 'fixed', ref: 'abc1234' } }));
  assert.equal(r.texts.length, 0);
  assert.deepEqual(r.skipped, { 'not-minor': 2, argued: 2, process: 1, 'settled-fixed': 1 });
  assert.equal(closeoutSkip({ severity: 'MINOR' }), 'argued');
  assert.equal(closeoutSkip({ severity: 'MINOR', evidence: 'measured', kind: 'code', report: REP }), null);
});

test('a measured MINOR missing ANY part (or blank) is refused at recording and nothing is recorded', () => {
  for (const part of Object.keys(REP) as Array<keyof typeof REP>) {
    for (const bad of [undefined, '', '  \n ']) {
      const report = { ...REP, [part]: bad };
      assert.throws(() => rec({ X: { severity: 'MINOR', evidence: 'measured', report } }), (e: unknown) => e instanceof FanoutStateError && e.message.includes(part), `${part}=${JSON.stringify(bad)}`);
    }
  }
  assert.throws(() => rec({ X: { severity: 'MINOR', evidence: 'measured' } }), (e: unknown) => e instanceof FanoutStateError && /needs report/.test(e.message));
  // a report with no evidence would count as argued and, evidence being never re-graded, lose its text for good
  assert.throws(() => rec({ X: { severity: 'MINOR', report: REP } }), (e: unknown) => e instanceof FanoutStateError && /needs evidence/.test(e.message));
  // the clauses that DO NOT need a report
  assert.doesNotThrow(() => rec({ X: { severity: 'MINOR', evidence: 'argued' } }));
  assert.doesNotThrow(() => rec({ X: { severity: 'MINOR', evidence: 'measured', kind: 'process' } }));
  assert.doesNotThrow(() => rec({ X: { severity: 'MAJOR', evidence: 'measured' } }));
});

test('a recorded grade is not rewritten: evidence / kind stay; a bare repeat keeps the report; legacy → record upgrades', () => {
  const s = rec({ 'F-1': { severity: 'MINOR', evidence: 'measured', report: REP }, 'F-L': 'MINOR' });
  assert.throws(() => applyTicketPatch(s, 'T-1', { findings: { 'F-1': { severity: 'MINOR', evidence: 'argued' } } }, NOW), /not rewritten/);
  assert.throws(() => applyTicketPatch(s, 'T-1', { findings: { 'F-1': { severity: 'MINOR', evidence: 'measured', kind: 'process', report: REP } } }, NOW), /not re-kinded/);
  assert.throws(() => applyTicketPatch(s, 'T-1', { findings: { 'F-1': 'MAJOR' } }, NOW), /already recorded as MINOR/);
  const kept = applyTicketPatch(s, 'T-1', { findings: { 'F-1': 'MINOR' } }, NOW);
  assert.equal(closeoutTexts(kept).texts.length, 1);
  const up = applyTicketPatch(s, 'T-1', { findings: { 'F-L': { severity: 'MINOR', evidence: 'measured', report: REP } } }, NOW);
  assert.equal(closeoutTexts(up).texts.length, 2);
});

test('texts come in ticket order, one per finding, across tickets', () => {
  let s = rec({ 'F-1': { severity: 'MINOR', evidence: 'measured', report: REP } }, 'T-1');
  s = applyTicketPatch(s, 'T-2', { status: 'started', findings: { 'F-2': { severity: 'MINOR', evidence: 'measured', report: REP }, 'F-3': { severity: 'MINOR', evidence: 'measured', report: REP } } }, NOW);
  assert.deepEqual(closeoutTexts(s).texts.map((t) => `${t.ticket}/${t.finding}`), ['T-1/F-1', 'T-2/F-2', 'T-2/F-3']);
});

test('a state edited by hand to hold a measured MINOR without a part is loud, not a silent drop', () => {
  const s = rec({ 'F-1': { severity: 'MINOR', evidence: 'measured', report: REP } });
  (s.tickets['T-1'].findings['F-1'] as { report: Record<string, string> }).report.proof = '';
  assert.throws(() => closeoutTexts(s), /no proof/);
});
