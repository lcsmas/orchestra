// #603 (ledger #613 FROZEN NAMES v1) — parked / situation rounds / recorded choices / the run's pause: the pure state rules. Every rule has a must-pass and a must-FAIL arm.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CHOICES_MAX, FanoutStateError, SeatRefusal, TICKET_STATUSES, applyTicketPatch, applyWriteBack, newState, parkTicket, parkedTickets, parseState, pauseRun, pausedOf, readState,
  reconcile, recordChoice, recordRound, releaseUpstreamParks, resumeRun, situationFingerprint, unparkTicket, writeStateAtomic, type FanoutState, type Reality,
} from './fanout-state.ts';
import { holdCloseout, holdEmpty, renderHold } from './fanout-closeout.ts';

const T = '2026-11-25T10:00:00.000Z';
const T2 = '2026-11-25T11:00:00.000Z';
const SHA_A = 'a'.repeat(40);
const FP1 = crypto.createHash('sha256').update('one').digest('hex');
const FP2 = crypto.createHash('sha256').update('two').digest('hex');

/** A ← B ← C (a chain), D alone, E depends on both B and D (a diamond-ish join). All started on a branch. */
function world(): FanoutState {
  let s = newState('run1', { now: T });
  s = applyTicketPatch(s, 'A', { status: 'started', branch: 'a' }, T);
  s = applyTicketPatch(s, 'B', { dependsOn: ['A'], frozenInterface: 'ledger §1', status: 'started', branch: 'b' }, T);
  s = applyTicketPatch(s, 'C', { dependsOn: ['B'], frozenInterface: 'ledger §2', status: 'started', branch: 'c' }, T);
  s = applyTicketPatch(s, 'D', { status: 'started', branch: 'd' }, T);
  s = applyTicketPatch(s, 'E', { dependsOn: ['B', 'D'], frozenInterface: 'ledger §3', status: 'started', branch: 'e' }, T);
  return s;
}
const refusal = (fn: () => unknown, code: string): void => assert.throws(fn, (e: unknown) => e instanceof SeatRefusal && e.refusal === code && e.message.startsWith(`[${code}]`), code);
const roundtrip = (s: FanoutState): FanoutState => parseState(JSON.parse(JSON.stringify(s)));
const statuses = (s: FanoutState): string => Object.entries(s.tickets).map(([id, t]) => `${id}:${t.status}`).join(' ');

// ── v1 loads unchanged · unknown field refused ──────────────────────────────────────────────────────────────────────────
test('a v1 file (no parked / rounds / choices / pause) loads unchanged and writes back byte-for-byte the same shape', () => {
  const raw = JSON.parse(JSON.stringify(world()));
  const s = parseState(raw);
  assert.deepEqual(JSON.parse(JSON.stringify(s)), raw);
  for (const t of Object.values(s.tickets)) assert.ok(!('parked' in t) && !('rounds' in t));
  assert.ok(!('choices' in s) && !('pause' in s));
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'fanout-park-'));
  try {
    const f = path.join(dir, 'state.json');
    writeStateAtomic(f, s);
    assert.deepEqual(readState(f), s);
    assert.ok(!/parked|rounds|choices|pause/.test(fs.readFileSync(f, 'utf8')), 'a state that parks nothing persists none of the new keys');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('MUST-FAIL: an unknown field is still refused (top, ticket, parked, rounds, choices, pause)', () => {
  const parked = parkTicket(world(), 'D', { cause: 'ci', reason: 'red' }, T);
  const withAll = pauseRun(recordChoice(recordRound(parked, 'A', FP1, T).state, { ticket: 'A', question: 'q?', rule: 'reversible-default', answer: 'a' }, T), { reason: 'r', check: null, prs: [1] }, T);
  const ok = JSON.parse(JSON.stringify(withAll));
  assert.doesNotThrow(() => parseState(ok));
  const bad = (mut: (r: any) => void, re: RegExp): void => { const r = JSON.parse(JSON.stringify(ok)); mut(r); assert.throws(() => parseState(r), re); };
  bad((r) => { r.colour = 1; }, /unknown field "colour"/);
  bad((r) => { r.tickets.A.colour = 1; }, /unknown field "colour"/);
  bad((r) => { r.tickets.D.parked.colour = 1; }, /unknown field "colour"/);
  bad((r) => { r.tickets.A.rounds[0].colour = 1; }, /unknown field "colour"/);
  bad((r) => { r.choices[0].colour = 1; }, /unknown field "colour"/);
  bad((r) => { r.pause.colour = 1; }, /unknown field "colour"/);
});

// ── parked is a status of its own ───────────────────────────────────────────────────────────────────────────────────────
test('parked is a status, distinct from dropped and from merged', () => {
  assert.ok((TICKET_STATUSES as readonly string[]).includes('parked'));
  assert.notEqual('parked', 'dropped');
  const s = parkTicket(world(), 'D', { cause: 'question', reason: 'contradictory spec' }, T);
  assert.equal(s.tickets.D.status, 'parked');
  assert.deepEqual(s.tickets.D.parked, { cause: 'question', reason: 'contradictory spec', at: T });
  assert.notEqual(s.tickets.D.status, 'dropped');
});

test('MUST-FAIL: a parked ticket with no reason is refused — by the transition, by the patch, and when read from disk', () => {
  refusal(() => parkTicket(world(), 'D', { cause: 'question', reason: '' }, T), 'park-no-reason');
  refusal(() => parkTicket(world(), 'D', { cause: 'question', reason: '   ' }, T), 'park-no-reason');
  refusal(() => applyTicketPatch(world(), 'D', { status: 'parked' }, T), 'park-no-reason');
  refusal(() => applyTicketPatch(world(), 'D', { park: { cause: 'ci' } }, T), 'park-no-reason');
  const raw = JSON.parse(JSON.stringify(world()));
  raw.tickets.D.status = 'parked'; // status with no record
  refusal(() => parseState(raw), 'park-no-reason');
  raw.tickets.D.parked = { cause: 'ci', reason: ' ', at: T };
  refusal(() => parseState(raw), 'park-no-reason');
  const other = JSON.parse(JSON.stringify(world()));
  other.tickets.D.parked = { cause: 'ci', reason: 'red', at: T }; // a record on a ticket that is not parked
  assert.throws(() => parseState(other), /a `parked` record on a ticket whose status is started/);
});

test('MUST-FAIL: a bad cause, an unknown / merged / dropped ticket are refused with their names', () => {
  for (const cause of ['bogus', '', 'upstream', undefined as unknown as string]) refusal(() => parkTicket(world(), 'D', { cause, reason: 'x' }, T), 'park-bad-cause');
  refusal(() => parkTicket(world(), 'ghost', { cause: 'ci', reason: 'x' }, T), 'park-unknown-ticket');
  const merged = applyTicketPatch(world(), 'A', { status: 'merged' }, T);
  refusal(() => parkTicket(merged, 'A', { cause: 'ci', reason: 'x' }, T), 'park-merged');
  const dropped = applyTicketPatch(world(), 'D', { status: 'dropped' }, T);
  refusal(() => parkTicket(dropped, 'D', { cause: 'ci', reason: 'x' }, T), 'park-dropped');
  for (const cause of ['question', 'situation', 'ci'] as const) assert.equal(parkTicket(world(), 'D', { cause, reason: 'x' }, T).tickets.D.parked?.cause, cause);
});

// ── parking a ticket parks its transitive dependents ──────────────────────────────────────────────────────────────────
test('parking a ticket parks every transitive dependent with "blocked by <ticket>" — and nobody else', () => {
  const s = parkTicket(world(), 'A', { cause: 'situation', reason: 'the same findings twice' }, T);
  assert.equal(statuses(s), 'A:parked B:parked C:parked D:started E:parked');
  assert.deepEqual(s.tickets.A.parked, { cause: 'situation', reason: 'the same findings twice', at: T });
  for (const id of ['B', 'C', 'E']) assert.deepEqual(s.tickets[id].parked, { cause: 'upstream', reason: 'blocked by A', at: T, blockedBy: 'A' }, id);
  assert.deepEqual(parkedTickets(s).map((p) => p.ticket), ['A', 'B', 'C', 'E']);
  assert.equal(s.tickets.D.parked, undefined);
  assert.deepEqual(roundtrip(s), s);
});

test('a dependent names the ticket that blocks it — whichever one that is (a middle ticket, not only the first)', () => {
  const s = parkTicket(world(), 'B', { cause: 'ci', reason: 'red' }, T);
  assert.equal(statuses(s), 'A:started B:parked C:parked D:started E:parked');
  assert.deepEqual(s.tickets.C.parked, { cause: 'upstream', reason: 'blocked by B', at: T, blockedBy: 'B' });
  assert.equal(s.tickets.E.parked?.blockedBy, 'B');
});

test('MUST-FAIL (negative control): an upstream of the parked ticket and an unrelated ticket stay as they were', () => {
  const s = parkTicket(world(), 'C', { cause: 'ci', reason: 'same failure after its fix' }, T);
  assert.equal(statuses(s), 'A:started B:started C:parked D:started E:started');
  assert.deepEqual(parkTicket(world(), 'D', { cause: 'ci', reason: 'x' }, T).tickets.B, world().tickets.B);
});

test('a dependent already merged or dropped is left alone; one already parked for its own cause keeps it', () => {
  let s = world();
  s = applyTicketPatch(s, 'C', { status: 'dropped' }, T);
  s = parkTicket(s, 'E', { cause: 'question', reason: 'no safe option' }, T);
  s = parkTicket(s, 'A', { cause: 'ci', reason: 'red' }, T2);
  assert.equal(s.tickets.C.status, 'dropped');
  assert.equal(s.tickets.E.parked?.cause, 'question', 'its own park stays the reason');
  assert.equal(s.tickets.B.parked?.cause, 'upstream');
});

test('parking twice keeps the first record (a restarted loop does not rewrite history)', () => {
  const once = parkTicket(world(), 'A', { cause: 'ci', reason: 'first' }, T);
  const twice = parkTicket(once, 'A', { cause: 'ci', reason: 'second' }, T2);
  assert.deepEqual(twice.tickets.A.parked, { cause: 'ci', reason: 'first', at: T });
  assert.deepEqual(twice.tickets.B.parked, once.tickets.B.parked);
  // a dependent that was only held by an upstream becomes a root when it is parked for its own reason
  const own = parkTicket(once, 'B', { cause: 'question', reason: 'own question' }, T2);
  assert.deepEqual(own.tickets.B.parked, { cause: 'question', reason: 'own question', at: T2 });
});

// ── unpark ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
test('unpark returns the ticket to work and releases the dependents it held; one still held by another parked ticket stays, re-pointed', () => {
  const both = parkTicket(parkTicket(world(), 'A', { cause: 'ci', reason: 'red' }, T), 'D', { cause: 'question', reason: 'q' }, T);
  assert.equal(statuses(both), 'A:parked B:parked C:parked D:parked E:parked');
  const freed = unparkTicket(both, 'A', T2);
  assert.equal(statuses(freed), 'A:started B:started C:started D:parked E:parked');
  assert.deepEqual(freed.tickets.E.parked, { cause: 'upstream', reason: 'blocked by D', at: T, blockedBy: 'D' }, 'E is still held by D, and says so');
  assert.equal(freed.tickets.A.parked, undefined);
  const all = unparkTicket(freed, 'D', T2);
  assert.equal(statuses(all), 'A:started B:started C:started D:started E:started');
  assert.deepEqual(roundtrip(all), all);
});

test('unparking a ticket whose upstream is STILL parked leaves it held by that upstream, never live under it (and it goes back to work when the upstream does)', () => {
  let s = parkTicket(world(), 'B', { cause: 'question', reason: 'own question' }, T);
  s = parkTicket(s, 'A', { cause: 'ci', reason: 'red' }, T);
  assert.equal(s.tickets.B.parked?.cause, 'question', 'B keeps its own cause');
  const b = unparkTicket(s, 'B', T2);
  assert.equal(b.tickets.B.status, 'parked');
  assert.deepEqual(b.tickets.B.parked, { cause: 'upstream', reason: 'blocked by A', at: T2, blockedBy: 'A' });
  assert.equal(reconcile(b, {}).tickets.B.class, 'parked');
  assert.equal(statuses(unparkTicket(b, 'A', T2)), 'A:started B:started C:started D:started E:started');
  assert.deepEqual(roundtrip(b), b);
});

test('unpark clears the verdict of the work that was set aside; a parked ticket with an open PR whose head moved is not a divergence', () => {
  let s = applyTicketPatch(world(), 'D', { status: 'gated', head: SHA_A, verdict: 'pass', pr: 5 }, T);
  s = parkTicket(s, 'D', { cause: 'ci', reason: 'red' }, T);
  const moved: Reality = { D: { branchHead: SHA_A, mergedIntoTarget: false, pr: { state: 'OPEN', headRefOid: 'f'.repeat(40), baseRefName: 'master' } } };
  assert.deepEqual(reconcile(s, moved).divergences, []);
  assert.equal(reconcile(applyTicketPatch(s, 'D', { unpark: true }, T), moved).divergences.some((d) => d.kind === 'pr-head-moved'), true, 'control: once unparked the same reality IS a divergence');
  const back = unparkTicket(s, 'D', T2);
  assert.equal(back.tickets.D.status, 'started');
  assert.equal(back.tickets.D.verdict, 'none');
});

test('unpark goes back to todo when the ticket never had work; MUST-FAIL: not parked / parked only upstream / a status move on a parked ticket', () => {
  let s = newState('r', { now: T });
  s = applyTicketPatch(s, 'X', { dependsOn: [], status: 'todo' }, T);
  s = parkTicket(s, 'X', { cause: 'question', reason: 'q' }, T);
  assert.equal(unparkTicket(s, 'X', T2).tickets.X.status, 'todo');
  assert.throws(() => unparkTicket(world(), 'A', T), /is not parked/);
  const held = parkTicket(world(), 'A', { cause: 'ci', reason: 'red' }, T);
  assert.throws(() => unparkTicket(held, 'B', T), /unpark A/);
  assert.throws(() => applyTicketPatch(held, 'A', { status: 'started' }, T), /is parked .* --unpark/);
  assert.throws(() => applyTicketPatch(held, 'B', { status: 'nominated' }, T), /is parked/);
  assert.equal(applyTicketPatch(held, 'A', { findings: { F1: 'MINOR' } }, T).tickets.A.status, 'parked', 'a parked ticket still takes a recorded finding');
  assert.equal(applyTicketPatch(held, 'A', { unpark: true }, T).tickets.A.status, 'started');
});

test('the patch forms: park + status parked go together; other keys with a park or an unpark are refused', () => {
  const ok = applyTicketPatch(world(), 'D', { status: 'parked', park: { cause: 'ci', reason: 'red' } }, T);
  assert.equal(ok.tickets.D.status, 'parked');
  assert.throws(() => applyTicketPatch(world(), 'D', { status: 'started', park: { cause: 'ci', reason: 'red' } }, T), /cannot go with it/);
  assert.throws(() => applyTicketPatch(world(), 'D', { park: { cause: 'ci', reason: 'red' }, head: 'abcdef12' }, T), /takes only --park-reason/);
  assert.throws(() => applyTicketPatch(ok, 'D', { unpark: true, head: 'abcdef12' }, T), /--unpark takes no other flag/);
});

// ── reconcile / resume: parked is never merged ──────────────────────────────────────────────────────────────────────────
test('reconcile classifies a parked ticket as parked and never counts it merged — not even when its branch tip is contained in the target', () => {
  const s = parkTicket(world(), 'A', { cause: 'ci', reason: 'red' }, T);
  const contained: Reality = { A: { branchHead: SHA_A, mergedIntoTarget: true, pr: null }, B: { branchHead: SHA_A, mergedIntoTarget: false, pr: null } };
  const plan = reconcile(s, contained);
  assert.equal(plan.tickets.A.class, 'parked');
  assert.equal(plan.tickets.B.class, 'parked');
  assert.deepEqual(plan.writeBack, [], 'a trivially-contained branch is not a merge');
  assert.equal(plan.divergences.length, 0);
  // control: the same reality on a STARTED-then-nominated ticket would be a merge — proves the instrument can say merged
  const nominated = applyTicketPatch(applyTicketPatch(world(), 'D', { status: 'nominated', head: SHA_A }, T), 'D', { branch: 'd' }, T);
  assert.equal(reconcile(nominated, { D: { branchHead: SHA_A, mergedIntoTarget: true, pr: null } }).writeBack.some((w) => w.ticket === 'D' && w.patch.status === 'merged'), true);
});

test('a parked ticket whose branch is gone or whose PR was closed is not a divergence (the loop closes it on purpose)', () => {
  const s = parkTicket(world(), 'D', { cause: 'ci', reason: 'red' }, T);
  const withPr = applyTicketPatch(s, 'D', { pr: 9 }, T);
  const plan = reconcile(withPr, { D: { branchHead: null, mergedIntoTarget: false, pr: { state: 'CLOSED', headRefOid: SHA_A, baseRefName: 'master' } } });
  assert.deepEqual(plan.divergences, []);
  assert.equal(plan.tickets.D.class, 'parked');
});

test('a parked ticket merged by hand (its PR is MERGED on the target) is ADOPTED: merged, the parking gone, the dependents it held released', () => {
  const s = parkTicket(world(), 'A', { cause: 'ci', reason: 'red' }, T);
  const merged = { branchHead: null, mergedIntoTarget: true, pr: { state: 'MERGED' as const, headRefOid: SHA_A, baseRefName: 'master' } };
  const plan = reconcile(applyTicketPatch(s, 'A', { pr: 4 }, T), { A: merged });
  assert.equal(plan.tickets.A.class, 'diverged');
  assert.ok(plan.writeBack.some((w) => w.ticket === 'A' && w.patch.status === 'merged'));
  const after = applyWriteBack(applyTicketPatch(s, 'A', { pr: 4 }, T), plan.writeBack, T2);
  assert.equal(after.tickets.A.status, 'merged');
  assert.equal(after.tickets.A.parked, undefined);
  assert.equal(statuses(after), 'A:merged B:started C:started D:started E:started');
});

test('a parked ticket merged by hand at ANOTHER head than its verdict covered: adopted at the head that really merged, and the merged-at-ungated-head divergence stays', () => {
  const H1 = 'a'.repeat(40), H2 = 'b'.repeat(40);
  let s = applyTicketPatch(world(), 'A', { status: 'gated', head: H1, verdict: 'approve', pr: 4 }, T);
  s = parkTicket(s, 'A', { cause: 'ci', reason: 'red' }, T);
  const merged: Reality = { A: { branchHead: null, mergedIntoTarget: true, pr: { state: 'MERGED', headRefOid: H2, baseRefName: 'master' }, prTree: 'c'.repeat(40) } };
  const plan = reconcile(s, merged);
  assert.ok(plan.divergences.some((d) => d.ticket === 'A' && d.kind === 'merged-at-ungated-head'), 'the alarm a park must not hide');
  assert.ok(plan.divergences.some((d) => d.ticket === 'A' && d.kind === 'reality-merged-state-not'));
  const after = applyWriteBack(s, plan.writeBack, T2);
  assert.equal(after.tickets.A.status, 'merged');
  assert.equal(after.tickets.A.mergedHead, H2, 'the head that really merged, not the head the verdict covered');
  assert.equal(after.tickets.A.mergedTree, 'c'.repeat(40));
  assert.equal(after.tickets.A.head, H2);
  assert.equal(after.tickets.A.verdict, 'none');
  assert.equal(after.tickets.A.parked, undefined);
  assert.equal(statuses(after), 'A:merged B:started C:started D:started E:started', 'the dependents it held are released');
  // dependents do not count it merged in the same pass (the re-gate is still owed)
  assert.notEqual(plan.tickets.B.class, 'startable');
  // control: merged at the SAME head the verdict covered → plain adoption, no ungated alarm, mergedHead = that head
  const same = reconcile(s, { A: { ...merged.A, pr: { state: 'MERGED', headRefOid: H1, baseRefName: 'master' } } });
  assert.ok(!same.divergences.some((d) => d.kind === 'merged-at-ungated-head'));
  assert.equal(applyWriteBack(s, same.writeBack, T2).tickets.A.mergedHead, H1);
});

test('MUST-FAIL: parked is in no merged set — a dependent of a parked ticket is not startable on its word', () => {
  const s = parkTicket(world(), 'A', { cause: 'ci', reason: 'red' }, T);
  const plan = reconcile(s, {});
  for (const id of ['A', 'B', 'C', 'E']) assert.equal(plan.tickets[id].class, 'parked', id);
  assert.equal(plan.tickets.D.class, 'in-progress');
  assert.match(plan.tickets.A.next.detail, /never counted as merged/);
});

// ── rounds + the situation fingerprint ──────────────────────────────────────────────────────────────────────────────────
test('situationFingerprint = sha256 of "findings:" + sorted ids joined "," + "\\ntree:" + tree — order-free, content-sensitive', () => {
  const exact = crypto.createHash('sha256').update('findings:F1,F2,F3\ntree:abc123').digest('hex');
  assert.equal(situationFingerprint({ openFindings: ['F3', 'F1', 'F2'], tree: 'abc123' }), exact);
  assert.equal(situationFingerprint({ openFindings: ['F1', 'F2', 'F3'], tree: 'abc123' }), exact);
  assert.notEqual(situationFingerprint({ openFindings: ['F1', 'F2'], tree: 'abc123' }), exact);
  assert.notEqual(situationFingerprint({ openFindings: ['F1', 'F2', 'F3'], tree: 'abc124' }), exact);
  assert.match(exact, /^[0-9a-f]{64}$/);
  const input = ['b', 'a'];
  situationFingerprint({ openFindings: input, tree: 't' });
  assert.deepEqual(input, ['b', 'a'], 'the caller\'s list is not reordered');
  assert.equal(situationFingerprint({ openFindings: [], tree: 't' }), crypto.createHash('sha256').update('findings:\ntree:t').digest('hex'));
});

test('recordRound: the first sighting is not a repeat, the SAME fingerprint again is; another one is not; rounds are numbered and persisted', () => {
  let s = world();
  const r1 = recordRound(s, 'A', FP1, T); assert.equal(r1.repeat, false); s = r1.state;
  const r2 = recordRound(s, 'A', FP2, T); assert.equal(r2.repeat, false); s = r2.state;
  const r3 = recordRound(s, 'A', FP1, T2); assert.equal(r3.repeat, true); s = r3.state;
  assert.deepEqual(s.tickets.A.rounds, [{ n: 1, fingerprint: FP1, at: T }, { n: 2, fingerprint: FP2, at: T }, { n: 3, fingerprint: FP1, at: T2 }]);
  assert.equal(recordRound(s, 'B', FP1, T).repeat, false, 'a fingerprint is per ticket');
  assert.deepEqual(roundtrip(s), s);
});

test('MUST-FAIL: a round on an unknown ticket or with a non-hex fingerprint is refused; a hand-edited round list is refused', () => {
  assert.throws(() => recordRound(world(), 'ghost', FP1, T), /no such ticket/);
  for (const bad of ['', 'xyz', 'ABCDEF12', FP1 + 'ff']) assert.throws(() => recordRound(world(), 'A', bad, T), /lowercase hex/, bad);
  const raw = JSON.parse(JSON.stringify(recordRound(recordRound(world(), 'A', FP1, T).state, 'A', FP2, T).state));
  raw.tickets.A.rounds[0].n = 0; // not positive
  assert.throws(() => parseState(raw), /rounds\[0\]\.n must be an integer greater than 0/);
  raw.tickets.A.rounds[0].n = 3; raw.tickets.A.rounds[1].n = 3; // not strictly increasing
  assert.throws(() => parseState(raw), /rounds\[1\]\.n must be an integer greater than 3/);
  raw.tickets.A.rounds[0].n = 1.5;
  assert.throws(() => parseState(raw), /rounds\[0\]\.n must be an integer/);
});

test('rounds are numbered by REVIEW (ledger v1.1): gaps are read back — #606\'s pattern (round 2 first, then 4) survives parseState; recordRound takes the number, or last + 1', () => {
  let s = recordRound(world(), 'A', FP1, T, 2).state; // review 1 approved (no round), review 2 asked for changes
  s = recordRound(s, 'A', FP2, T, 4).state;
  assert.deepEqual(s.tickets.A.rounds!.map((r) => r.n), [2, 4]);
  assert.deepEqual(roundtrip(s), s, 'read back through parseState — a refusal here bricks the run');
  const next = recordRound(s, 'A', FP1, T2); // no number given: last + 1, still valid
  assert.deepEqual(next.state.tickets.A.rounds!.map((r) => r.n), [2, 4, 5]);
  assert.equal(next.repeat, true);
  assert.deepEqual(roundtrip(next.state), next.state);
  // the #606 shape: record with the default number, then overwrite the last round's n by the review's
  const raw = JSON.parse(JSON.stringify(recordRound(world(), 'B', FP1, T).state));
  raw.tickets.B.rounds[0].n = 2;
  assert.equal(parseState(raw).tickets.B.rounds![0].n, 2);
  // MUST-FAIL: a number that does not exceed the last one is refused (and nothing is recorded)
  for (const bad of [4, 3, 0, -1, 4.5]) assert.throws(() => recordRound(s, 'A', FP2, T, bad), /must be an integer greater than the last recorded round \(4\)/, String(bad));
});

test('a reason / check name over its bound is CUT, never refused: the park and the pause land', () => {
  const long = `NO SAFE OPTION: ${'x'.repeat(1500)}`;
  const s = parkTicket(world(), 'D', { cause: 'question', reason: long }, T);
  assert.equal(s.tickets.D.status, 'parked');
  assert.equal(s.tickets.D.parked!.reason.length, 1000);
  assert.ok(s.tickets.D.parked!.reason.endsWith('…') && s.tickets.D.parked!.reason.startsWith('NO SAFE OPTION: xx'));
  assert.deepEqual(roundtrip(s), s);
  const exact = 'y'.repeat(1000);
  assert.equal(parkTicket(world(), 'D', { cause: 'ci', reason: exact }, T).tickets.D.parked!.reason, exact, 'a reason at the bound is kept whole');
  const p = pauseRun(world(), { reason: 'z'.repeat(1200), check: 'c'.repeat(400), prs: [1] }, T);
  assert.equal(p.pause!.reason.length, 1000);
  assert.equal(p.pause!.check!.length, 300);
  assert.ok(p.pause!.check!.endsWith('…'));
  assert.deepEqual(roundtrip(p), p);
  assert.equal(pauseRun(world(), { reason: 'r', check: 'c'.repeat(300), prs: [] }, T).pause!.check, 'c'.repeat(300));
  // control: a control character is still refused (printable text only)
  assert.throws(() => parkTicket(world(), 'D', { cause: 'ci', reason: 'bad\x00text' }, T), FanoutStateError);
});

// ── choices ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
test('recordChoice numbers from 1, records both rules, and persists', () => {
  let s = recordChoice(world(), { ticket: 'B', question: 'rename the column?', rule: 'reversible-default', answer: 'keep the old name' }, T);
  s = recordChoice(s, { ticket: 'C', question: 'drop the table?', rule: 'no-safe-option', answer: 'ticket parked' }, T2);
  assert.deepEqual(s.choices, [
    { n: 1, ticket: 'B', question: 'rename the column?', rule: 'reversible-default', answer: 'keep the old name', at: T },
    { n: 2, ticket: 'C', question: 'drop the table?', rule: 'no-safe-option', answer: 'ticket parked', at: T2 },
  ]);
  assert.deepEqual(roundtrip(s), s);
});

test('MUST-FAIL: a choice with a blank question / answer, an unknown rule, a bad ticket id or an oversized text is refused [choice-bad]', () => {
  const ok = { ticket: 'B', question: 'q?', rule: 'reversible-default', answer: 'a' };
  for (const bad of [{ question: '' }, { answer: '  ' }, { rule: 'whatever' }, { ticket: '../x' }, { question: 'x'.repeat(2001) }, { answer: 'bad\x00text' }]) refusal(() => recordChoice(world(), { ...ok, ...bad }, T), 'choice-bad');
  refusal(() => recordChoice(world(), { ...ok, ticket: undefined as unknown as string }, T), 'choice-bad');
  let s = world();
  s = { ...s, choices: Array.from({ length: CHOICES_MAX }, (_, i) => ({ n: i + 1, ticket: 'B', question: 'q', rule: 'reversible-default' as const, answer: 'a', at: T })) };
  refusal(() => recordChoice(s, ok, T), 'choice-bad');
  const raw = JSON.parse(JSON.stringify(recordChoice(world(), ok, T)));
  raw.choices[0].rule = 'x';
  refusal(() => parseState(raw), 'choice-bad');
  raw.choices[0].rule = 'reversible-default'; raw.choices[0].n = 5;
  assert.throws(() => parseState(raw), /choices\[0\]\.n must be 1/);
});

// ── the run's pause ─────────────────────────────────────────────────────────────────────────────────────────────────────
test('pauseRun / resumeRun / pausedOf: the only pause of slice 1', () => {
  assert.equal(pausedOf(world()), null);
  let s = pauseRun(world(), { reason: 'lint is red on 3 pull requests', check: 'lint', prs: [12, 7, 12] }, T);
  assert.deepEqual(pausedOf(s), { at: T, reason: 'lint is red on 3 pull requests', check: 'lint', prs: [7, 12] });
  assert.deepEqual(roundtrip(s), s);
  s = pauseRun(s, { reason: 'ignored: the first reason stands', check: 'other', prs: [9] }, T2);
  assert.deepEqual(pausedOf(s), { at: T, reason: 'lint is red on 3 pull requests', check: 'lint', prs: [7, 9, 12] }, 'a second call keeps the first record and adds the pull requests');
  const back = resumeRun(s, T2);
  assert.equal(pausedOf(back), null);
  assert.ok(!('pause' in back));
  assert.equal(resumeRun(back, T2), back, 'resuming a run that is not paused changes nothing');
  assert.equal(pausedOf(pauseRun(world(), { reason: 'env', check: null, prs: [] }, T))?.check, null);
});

test('MUST-FAIL: a pause with no reason is refused [pause-no-reason]; a bad pr list is refused; a paused run still parks and records', () => {
  for (const reason of ['', '   ', undefined as unknown as string]) refusal(() => pauseRun(world(), { reason, check: null, prs: [] }, T), 'pause-no-reason');
  assert.throws(() => pauseRun(world(), { reason: 'x', check: null, prs: [0] }, T), /pull request numbers/);
  assert.throws(() => pauseRun(world(), { reason: 'x', check: null, prs: [1.5] }, T), /pull request numbers/);
  const raw = JSON.parse(JSON.stringify(pauseRun(world(), { reason: 'x', check: 'c', prs: [1] }, T)));
  raw.pause.reason = '';
  refusal(() => parseState(raw), 'pause-no-reason');
  const paused = pauseRun(world(), { reason: 'x', check: 'c', prs: [1] }, T);
  assert.equal(parkTicket(paused, 'D', { cause: 'ci', reason: 'r' }, T).pause?.reason, 'x');
});

// ── the report text ─────────────────────────────────────────────────────────────────────────────────────────────────────
test('renderHold prints each parked ticket (cause + reason), the situations seen, the choices and the pause — and nothing for a run that has none', () => {
  assert.equal(renderHold(world()), '');
  assert.ok(holdEmpty(holdCloseout(world())));
  let s = parkTicket(world(), 'A', { cause: 'situation', reason: 'the same two findings on the same tree' }, T);
  s = recordRound(recordRound(s, 'A', FP1, T).state, 'A', FP1, T).state;
  s = recordChoice(s, { ticket: 'D', question: 'which index?', rule: 'reversible-default', answer: 'btree' }, T);
  s = pauseRun(s, { reason: 'same check red', check: 'build', prs: [3, 4] }, T);
  const out = renderHold(s);
  assert.match(out, /run PAUSED \(#603\): same check red — check build red on PR #3, PR #4/);
  assert.match(out, /parked \(#603\): 4 ticket\(s\) set aside, never counted merged/);
  assert.match(out, /A {2}situation {2}the same two findings on the same tree/);
  assert.match(out, /B {2}upstream ← A {2}blocked by A/);
  assert.match(out, /situations seen \(#603\): A 2 round\(s\) \(SAME situation twice\)/);
  assert.match(out, /choices taken by agents \(#603\): 1\n {2}1\. D {2}reversible-default {2}Q: which index\? {2}→ btree/);
  assert.equal(holdCloseout(s).parked.length, 4);
});

test('releaseUpstreamParks is idempotent and a no-op on a state with no parking', () => {
  const w = world();
  assert.equal(releaseUpstreamParks(w, T), w);
  const s = parkTicket(w, 'A', { cause: 'ci', reason: 'red' }, T);
  assert.equal(releaseUpstreamParks(s, T2), s);
});
