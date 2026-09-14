import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  decideEscalation,
  pruneEscalationLedger,
  escalationBody,
  phaseChanged,
  STALE_AFTER_MS,
  type MemberLivenessState,
  type EscalationLedgerEntry,
} from './bus-liveness.ts';

// The PURE liveness policy (#120, ledger #125). Every guard is exercised in both
// directions with a same-command control, so a mutant that deletes/flips a clause
// goes RED here without a bus or a session. Each test names the mutant it kills.

const NOW = 1_000_000_000_000;
const APP_START = NOW - 60 * 60 * 1000; // an hour ago

/** A member that IS stale by default — every field set so the ONLY thing keeping
 *  it alive is what a given test toggles. Silent for 11m (past the 10m bound). */
function staleMember(over: Partial<MemberLivenessState> = {}): MemberLivenessState {
  return {
    reader: 'ws-worker',
    coordinator: 'ws-ops',
    hasTask: true,
    lastActivityAt: NOW - 11 * 60 * 1000,
    appStartedAt: APP_START,
    running: false,
    waiting: false,
    ...over,
  };
}

// ── The two poles first: the decision can both FIRE and NOT fire ─────────────

test('a silent, tasked, coordinated member (switch ON) → escalate', () => {
  // The must-PASS pole. Without it every "skip" below could pass on a policy that
  // never escalates anything.
  const a = decideEscalation(staleMember(), undefined, NOW, true);
  assert.equal(a.kind, 'escalate');
  assert.equal(a.kind === 'escalate' && a.coordinator, 'ws-ops');
  assert.equal(a.kind === 'escalate' && a.reader, 'ws-worker');
});

test('the SAME member with the switch OFF → count, never escalate (C5)', () => {
  // COVERS: COUNTED, not FIRED while the switch is off (coexistence).
  // MUTANT: return `escalate` regardless of switchOn → this goes RED (kind is
  //   `count`, not `escalate`).
  const a = decideEscalation(staleMember(), undefined, NOW, false);
  assert.equal(a.kind, 'count');
  assert.equal(a.kind === 'count' && a.coordinator, 'ws-ops');
});

// ── Each exclusion guard, with the mutant it kills ───────────────────────────

test('no dispatched task → skip no-task', () => {
  // MUTANT: drop the `!m.hasTask` guard → a hand-made workspace escalates.
  const a = decideEscalation(staleMember({ hasTask: false }), undefined, NOW, true);
  assert.equal(a.kind, 'skip');
  assert.equal(a.kind === 'skip' && a.why, 'no-task');
});

test('no coordinator → skip no-coordinator', () => {
  // MUTANT: drop the `!m.coordinator` guard → a NULL recipient escalation is
  //   written (a send to nobody), or a throw. Either way this arm proves the
  //   member with no parent is never escalated.
  const a = decideEscalation(staleMember({ coordinator: null }), undefined, NOW, true);
  assert.equal(a.kind, 'skip');
  assert.equal(a.kind === 'skip' && a.why, 'no-coordinator');
});

test('RUNNING member is alive however old its clock — skip running (anti-trap)', () => {
  // COVERS acceptance 2 at the policy layer: a turn in flight is alive even when
  //   the discrete activity stamp aged past the bound (the slow-vs-dead reader).
  // MUTANT: remove the `m.running` guard → a member mid-8-min-build escalates
  //   because its lastActivityAt is 11m old. This is the trap the ticket names.
  const a = decideEscalation(
    staleMember({ running: true, lastActivityAt: NOW - 11 * 60 * 1000 }),
    undefined,
    NOW,
    true,
  );
  assert.equal(a.kind, 'skip');
  assert.equal(a.kind === 'skip' && a.why, 'running');
});

test('running is checked BEFORE the wall-clock test — order matters', () => {
  // If the staleness test ran first, a running member silent 11m would fall
  // through to escalate. Assert the guard ORDER by making the member both stale
  // AND running: it must skip `running`, not escalate.
  const a = decideEscalation(
    staleMember({ running: true, lastActivityAt: 0 }),
    undefined,
    NOW,
    true,
  );
  assert.equal(a.kind === 'skip' && a.why, 'running');
});

test('WAITING member excluded regardless of silence — skip waiting (T120.4)', () => {
  // MUTANT: remove the `m.waiting` guard → an asker parked on an ask escalates.
  const a = decideEscalation(
    staleMember({ waiting: true, lastActivityAt: 0 }),
    undefined,
    NOW,
    true,
  );
  assert.equal(a.kind, 'skip');
  assert.equal(a.kind === 'skip' && a.why, 'waiting');
});

// ── The staleness bound itself, both sides ───────────────────────────────────

test('active WITHIN the threshold → skip fresh', () => {
  // MUTANT: flip `<=` to `>` (or drop the freshness test) → a member active 1m
  //   ago escalates.
  const a = decideEscalation(
    staleMember({ lastActivityAt: NOW - 1 * 60 * 1000 }),
    undefined,
    NOW,
    true,
  );
  assert.equal(a.kind, 'skip');
  assert.equal(a.kind === 'skip' && a.why, 'fresh');
});

test('exactly AT the threshold is still fresh (boundary)', () => {
  // The boundary is inclusive-alive: silent for exactly STALE_AFTER_MS is fresh,
  // one ms more is stale. Pin both so a `<` vs `<=` mutant is caught.
  const atBound = decideEscalation(
    staleMember({ lastActivityAt: NOW - STALE_AFTER_MS }),
    undefined,
    NOW,
    true,
  );
  assert.equal(atBound.kind === 'skip' && atBound.why, 'fresh');
  const overBound = decideEscalation(
    staleMember({ lastActivityAt: NOW - STALE_AFTER_MS - 1 }),
    undefined,
    NOW,
    true,
  );
  assert.equal(overBound.kind, 'escalate');
});

test('undefined clock floors at appStartedAt', () => {
  // A member that never emitted activity this run: floored at app-start. With
  // app-start an hour ago it IS stale; with app-start 1m ago it is fresh.
  const old = decideEscalation(
    staleMember({ lastActivityAt: undefined, appStartedAt: NOW - 60 * 60 * 1000 }),
    undefined,
    NOW,
    true,
  );
  assert.equal(old.kind, 'escalate');
  const fresh = decideEscalation(
    staleMember({ lastActivityAt: undefined, appStartedAt: NOW - 60 * 1000 }),
    undefined,
    NOW,
    true,
  );
  assert.equal(fresh.kind === 'skip' && fresh.why, 'fresh');
});

// ── ONE per silence (acceptance 1) ───────────────────────────────────────────

test('a member already FIRED this silence → skip already-escalated', () => {
  // MUTANT: drop the `if (previous?.fired) skip` guard → a stale member escalates
  //   on EVERY sweep, not once per silence.
  const prev: EscalationLedgerEntry = { escalatedAtActivity: NOW - 11 * 60 * 1000, fired: true };
  const a = decideEscalation(staleMember(), prev, NOW, true);
  assert.equal(a.kind, 'skip');
  assert.equal(a.kind === 'skip' && a.why, 'already-escalated');
});

test('the ledger re-arms once the member is no longer stale', () => {
  // pruneEscalationLedger drops entries not in the still-stale set. A member that
  // resumed activity is pruned → its NEXT silence escalates again.
  const ledger = new Map<string, EscalationLedgerEntry>([
    ['ws-worker', { escalatedAtActivity: 0, fired: true }],
    ['ws-other', { escalatedAtActivity: 0, fired: true }],
  ]);
  pruneEscalationLedger(ledger, new Set(['ws-other'])); // ws-worker no longer stale
  assert.equal(ledger.has('ws-worker'), false);
  assert.equal(ledger.has('ws-other'), true);
  // ws-worker, now pruned, escalates on its next silence (previous === undefined).
  const a = decideEscalation(staleMember(), ledger.get('ws-worker'), NOW, true);
  assert.equal(a.kind, 'escalate');
});

// ── F1 (review-120): a switch OFF→ON flip must not suppress the first fire ────

test('F1: a member COUNTED while OFF still FIRES when the switch flips ON', () => {
  // The switch-flip bug: a member continuously stale across an OFF→ON flip is
  // counted while OFF (fired: false), and MUST escalate exactly once when ON.
  // MUTANT: mark the count entry `fired: true` (or suppress on mere presence) →
  //   this returns `skip already-escalated`, the first real escalation lost.
  const counted: EscalationLedgerEntry = { escalatedAtActivity: NOW - 11 * 60 * 1000, fired: false };
  const a = decideEscalation(staleMember(), counted, NOW, /* switchOn */ true);
  assert.equal(a.kind, 'escalate', 'a prior COUNT must not suppress the first FIRE');
});

test('F1: a member COUNTED while OFF is not counted AGAIN on the next OFF sweep', () => {
  // The other half: while still OFF, a prior count DOES suppress a second count
  // (no 60×/min count-storm — the #117 lesson). MUTANT: allow re-count → a stale
  //   member counts every sweep.
  const counted: EscalationLedgerEntry = { escalatedAtActivity: NOW - 11 * 60 * 1000, fired: false };
  const a = decideEscalation(staleMember(), counted, NOW, /* switchOn */ false);
  assert.equal(a.kind, 'skip');
  assert.equal(a.kind === 'skip' && a.why, 'already-escalated');
});

// ── F3 (review-120): an undefined clock floored SAFE, never dangerous ────────

test('F3: an undefined lastActivityAt floored at `now` reads as FRESH, not stale', () => {
  // The dangerous-floor bug: if the floor were 0 (epoch), `silentForMs = now`
  // always exceeds the threshold → every clockless member escalates. Floored at
  // `now` (what the sweep passes), a clockless member reads as just-active.
  // MUTANT: set appStartedAt to 0 → this escalates (silentForMs = now).
  const m = staleMember({ lastActivityAt: undefined, appStartedAt: NOW });
  const a = decideEscalation(m, undefined, NOW, true);
  assert.equal(a.kind, 'skip');
  assert.equal(a.kind === 'skip' && a.why, 'fresh');
});

// ── The body is a specific marker (carry-forward 2) ──────────────────────────

test('escalationBody names the member and the minutes silent', () => {
  const body = escalationBody('ws-worker', 11 * 60 * 1000 + 30_000);
  assert.match(body, /ws-worker/);
  assert.match(body, /11m/);
  // A body that merely MENTIONS the handle without the silence figure must not
  // satisfy a gate that certifies "escalated after 11m of silence".
  assert.ok(body.includes('11m'), 'the minutes figure is load-bearing');
});

// ── T120.3 phase change-guard: the zero control (unchanged re-set) ───────────

test('phaseChanged: a real transition is true, an unchanged re-set is false', () => {
  // MUTANT: `return true` always (drop the guard) → an unchanged re-set writes a
  //   status row, failing acceptance 3's "0 rows for an unchanged re-set".
  assert.equal(phaseChanged('', 'implementing'), true, 'empty → set is a change');
  assert.equal(phaseChanged('implementing', 'testing'), true, 'set → other is a change');
  assert.equal(phaseChanged('implementing', ''), true, 'set → cleared is a change');
  assert.equal(phaseChanged('implementing', 'implementing'), false, 'same text is NOT a change');
  assert.equal(phaseChanged('', ''), false, 'cleared → cleared is NOT a change');
});
