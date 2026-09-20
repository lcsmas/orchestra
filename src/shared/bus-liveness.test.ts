import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  decideEscalation,
  pruneEscalationLedger,
  escalationBody,
  hungCallEscalationBody,
  toolClassCeilingMs,
  phaseChanged,
  STALE_AFTER_MS,
  BASH_TOOL_CEILING_MS,
  UNCAPPED_TOOL_CEILING_MS,
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
    doneAndReleased: false,
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

// ── #160: the done-released exclusion, all 4 acceptance arms ──────────────────
//
// The discriminator is TASK STATE (`doneAndReleased`), never mail. Each arm names
// the mutant it kills and pairs with a same-command control so a policy that
// never/always escalates cannot pass it.

test('#160 arm 1: done+released+idle+silent → skip done-released (NO escalation)', () => {
  // The pre-fix bug: a cleanly-finished member (done, released, idle, silent 11m,
  //   ZERO mail) tripped the staleness clock exactly like a stall — the 5-burst at
  //   canary-5 wave end (F-C5-5).
  // MUTANT: remove the `m.doneAndReleased` guard → this member escalates (the
  //   pre-fix behaviour). With the guard it skips as `done-released`.
  const a = decideEscalation(
    staleMember({ doneAndReleased: true, lastActivityAt: NOW - 30 * 60 * 1000 }),
    undefined,
    NOW,
    true,
  );
  assert.equal(a.kind, 'skip', 'a finished member must not escalate');
  assert.equal(a.kind === 'skip' && a.why, 'done-released');
});

test('#160 arm 1 control: an OTHERWISE-IDENTICAL member NOT released → escalates', () => {
  // Same fields as arm 1 but `doneAndReleased: false` — proves the exclusion keys
  // on TASK STATE, not on the silence/idleness both members share. Without this
  // control, arm 1 would also pass on a policy that never escalates anything.
  const a = decideEscalation(
    staleMember({ doneAndReleased: false, lastActivityAt: NOW - 30 * 60 * 1000 }),
    undefined,
    NOW,
    true,
  );
  assert.equal(a.kind, 'escalate', 'an un-released silent member still escalates');
});

test('#160 arm 2: ZOMBIE (dispatched, never started, no mail, NOT released) → STILL escalates', () => {
  // The true positive that must survive the exclusion: canary-5's real zombie
  //   catch (831dc078) had a dispatched-never-started task and ZERO bus mail. The
  //   discriminator being TASK STATE (not empty-inbox) is exactly what keeps this
  //   RED: a never-started task never reaches done+released, so `doneAndReleased:
  //   false` and it escalates.
  // MUTANT: gate the exclusion on "no pending mail" instead of task state → this
  //   zombie (no mail) would be wrongly excluded. `doneAndReleased: false` keeps it
  //   escalating regardless of mail.
  const zombie = staleMember({
    doneAndReleased: false,
    running: false,
    waiting: false,
    // never started ⇒ no host activity this run; floored old ⇒ silent past bound
    lastActivityAt: NOW - 60 * 60 * 1000,
  });
  const a = decideEscalation(zombie, undefined, NOW, true);
  assert.equal(a.kind, 'escalate', 'a dispatched-never-started zombie must STILL escalate');
  assert.equal(a.kind === 'escalate' && a.reader, 'ws-worker');
});

test('#160 arm 3: STALLED (started, mid-task, silent 10m+) → STILL escalates, released or not', () => {
  // A genuinely stalled member — started work, then went silent past the bound —
  //   must still escalate. It has `doneAndReleased: false` (it never finished), so
  //   the guard does not touch it. Pending mail is irrelevant (task state, not mail).
  const stalled = staleMember({
    doneAndReleased: false,
    lastActivityAt: NOW - 15 * 60 * 1000,
  });
  const a = decideEscalation(stalled, undefined, NOW, true);
  assert.equal(a.kind, 'escalate', 'a mid-task stall must STILL escalate');
});

test('#160 arm 4: WAITING (open ask/gate) exclusion is UNCHANGED by the done-released guard', () => {
  // The pre-existing `waiting` exclusion must survive: a member parked on an ask
  //   is still skipped as `waiting`, not mis-labelled. `doneAndReleased: false`
  //   here proves the two exclusions are independent — the waiting path is reached
  //   exactly as before (the done-released guard sits above it but does not fire).
  const a = decideEscalation(
    staleMember({ waiting: true, doneAndReleased: false, lastActivityAt: 0 }),
    undefined,
    NOW,
    true,
  );
  assert.equal(a.kind, 'skip');
  assert.equal(a.kind === 'skip' && a.why, 'waiting', 'waiting exclusion unchanged');
});

test('#160: done-released is checked BEFORE the staleness clock (order)', () => {
  // A done+released member with an arbitrarily OLD clock must skip as
  //   `done-released`, never fall through to `escalate` on the wall clock — the
  //   guard order (done-released before fresh/stale) is what this asserts. MUTANT:
  //   move the guard AFTER the staleness test → an old-clocked finished member
  //   escalates before the exclusion is reached.
  const a = decideEscalation(
    staleMember({ doneAndReleased: true, lastActivityAt: 0 }),
    undefined,
    NOW,
    true,
  );
  assert.equal(a.kind === 'skip' && a.why, 'done-released');
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

// ═══ #127 — liveness v2, the PROGRESS bound (hung mid-tool-call) ══════════════
//
// The gap: a session HUNG mid-tool-call is `running: true` forever (a pretool
// fired, no posttool ever follows), so the `running` guard skips it. The
// progress bound catches it — a running member whose in-flight tool call blew
// its per-tool-class ceiling with ZERO progress escalates. Each arm is paired
// with a same-command control that must stay ALIVE (the dead-vs-slow trap).

const HUNG_TOOL_NOW = NOW;

/** A running member with a SINGLE in-flight tool call started `startedAt`.
 *  Everything is set so the ONLY variable is what a test toggles. The default
 *  call is an MCP call past its 30-min ceiling (hung). `lastActivityAt` is set
 *  fresh on purpose — the progress bound is PER-CALL (list membership), NOT the
 *  global clock, so a hung call escalates even with a recent activity stamp
 *  (that is exactly the F1 fix: a fast sibling's posttool must not mask it). */
function hungMember(
  over: Partial<MemberLivenessState> = {},
  toolOver: Partial<{ tool: string | null; startedAt: number }> = {},
): MemberLivenessState {
  const startedAt = toolOver.startedAt ?? HUNG_TOOL_NOW - (UNCAPPED_TOOL_CEILING_MS + 60_000);
  return {
    reader: 'ws-worker',
    coordinator: 'ws-ops',
    hasTask: true,
    lastActivityAt: HUNG_TOOL_NOW - 30_000,
    appStartedAt: APP_START,
    running: true,
    waiting: false,
    inFlightTools: [{ tool: toolOver.tool ?? 'mcp__browser__click', startedAt }],
    ...over,
  };
}

test('toolClassCeilingMs: Bash gets the 600s cap, everything else the long floor', () => {
  // MUTANT: swap the two returns → a Bash call would be flagged only after 30m
  //   (missing a genuinely hung 11m Bash) OR an MCP call flagged at 10m (cutting
  //   a legitimate long headless E2E). Assert each class maps to its constant.
  assert.equal(toolClassCeilingMs('Bash'), BASH_TOOL_CEILING_MS, 'Bash → its own 600s cap');
  assert.equal(toolClassCeilingMs('mcp__browser__click'), UNCAPPED_TOOL_CEILING_MS, 'MCP → floor');
  assert.equal(toolClassCeilingMs('WebFetch'), UNCAPPED_TOOL_CEILING_MS, 'web → floor');
  assert.equal(toolClassCeilingMs(null), UNCAPPED_TOOL_CEILING_MS, 'unknown name → floor');
  assert.equal(toolClassCeilingMs(undefined), UNCAPPED_TOOL_CEILING_MS, 'no call → floor');
});

test('T127.1 arm A: a running member with a tool call PAST its ceiling, zero progress → escalate', () => {
  // The HUNG arm. An MCP call in flight for ceiling+1m with no posttool.
  // MUTANT: return `null` from hungCallForMs unconditionally (i.e. keep the old
  //   unconditional `running` skip) → this goes RED (kind is `skip running`, no
  //   escalation for a genuinely hung call — the #90 wedge stays invisible).
  const a = decideEscalation(hungMember(), undefined, HUNG_TOOL_NOW, true);
  assert.equal(a.kind, 'escalate', 'a hung mid-call member must escalate');
  assert.equal(a.kind === 'escalate' && a.coordinator, 'ws-ops');
  // The action carries the hung tool name so the body can name it.
  assert.equal(a.kind === 'escalate' && a.hungTool, 'mcp__browser__click');
});

test('T127.1 arm B: a running Bash build UNDER its ceiling → stays alive (dead-vs-slow trap)', () => {
  // The must-STAY-ALIVE control. A legitimate 8-min build: a Bash call in flight
  // for 8m, under the 600s (10m) Bash ceiling. It MUST NOT escalate.
  // MUTANT: drop the `elapsed < ceiling` continue (flag any in-flight call) →
  //   this goes RED (an 8-min build escalates — the exact trap acceptance 2 forbids).
  const eightMinAgo = HUNG_TOOL_NOW - 8 * 60 * 1000;
  const a = decideEscalation(
    hungMember({}, { tool: 'Bash', startedAt: eightMinAgo }),
    undefined,
    HUNG_TOOL_NOW,
    true,
  );
  assert.equal(a.kind, 'skip', 'a build under its ceiling is alive');
  assert.equal(a.kind === 'skip' && a.why, 'running');
});

test('F1 (review-127): a hung PARALLEL call escalates even beside a FAST sibling', () => {
  // THE regression the fresh reviewer found. Two in-flight calls: a hung MCP call
  // (past its 30-min ceiling) AND a fast Bash call started 1s ago. The OLD
  // single-slot design let the fast call's posttool clear the whole slot and the
  // global-clock progress check mark the hung call alive → never escalated (the
  // #90 wedge re-opened). The per-call list must escalate the hung MCP call and
  // NAME it, regardless of the fresh sibling / fresh activity clock.
  // MUTANT: revert hungCall to read the global lastActivityAt for progress → RED
  //   (the recent clock marks the hung call as progress → skip running).
  const a = decideEscalation(
    hungMember({
      lastActivityAt: HUNG_TOOL_NOW - 1000, // a sibling just posttool'd — recent clock
      inFlightTools: [
        { tool: 'mcp__browser__click', startedAt: HUNG_TOOL_NOW - (UNCAPPED_TOOL_CEILING_MS + 60_000) },
        { tool: 'Bash', startedAt: HUNG_TOOL_NOW - 1000 }, // fast sibling, under ceiling
      ],
    }),
    undefined,
    HUNG_TOOL_NOW,
    true,
  );
  assert.equal(a.kind, 'escalate', 'a hung parallel call escalates despite a fast sibling');
  assert.equal(a.kind === 'escalate' && a.hungTool, 'mcp__browser__click', 'names the HUNG tool, not the fast one');
});

test('F1: TWO hung calls → the MOST-OVERDUE is named (worst offender)', () => {
  // Both past their ceilings; the escalation should name the one most overdue.
  // MCP over by 10m, a null-tool call over by 20m → the null-tool one is worse.
  const a = decideEscalation(
    hungMember({
      inFlightTools: [
        { tool: 'mcp__browser__click', startedAt: HUNG_TOOL_NOW - (UNCAPPED_TOOL_CEILING_MS + 10 * 60_000) },
        { tool: 'WebFetch', startedAt: HUNG_TOOL_NOW - (UNCAPPED_TOOL_CEILING_MS + 20 * 60_000) },
      ],
    }),
    undefined,
    HUNG_TOOL_NOW,
    true,
  );
  assert.equal(a.kind, 'escalate');
  assert.equal(a.kind === 'escalate' && a.hungTool, 'WebFetch', 'the most-overdue call is named');
});

test('T127.1: a running member with NO in-flight tool call is alive (thinking, not hung)', () => {
  // A running member between tool calls (the THINKING label) has an empty list.
  // It must be treated as alive — the progress bound only fires on a stuck CALL.
  // MUTANT: treat an empty list as hung → every thinking member escalates.
  const a = decideEscalation(
    hungMember({ inFlightTools: [], lastActivityAt: 0 }),
    undefined,
    HUNG_TOOL_NOW,
    true,
  );
  assert.equal(a.kind, 'skip');
  assert.equal(a.kind === 'skip' && a.why, 'running');
});

test('T127.1: undefined inFlightTools (never tracked) is alive', () => {
  // A member the tracker has no entry for at all → undefined list → alive.
  const a = decideEscalation(
    hungMember({ inFlightTools: undefined, lastActivityAt: 0 }),
    undefined,
    HUNG_TOOL_NOW,
    true,
  );
  assert.equal(a.kind, 'skip');
  assert.equal(a.kind === 'skip' && a.why, 'running');
});

test('T127.1 boundary: exactly AT the ceiling is hung (>=), one ms under is alive', () => {
  // The `>=` boundary — at the ceiling a capped tool would already have produced
  // a result, so the boundary tick is the first flag.
  // MUTANT: change `>=` to `>` → the exact-ceiling tick stays alive one tick too
  //   long. Assert both sides of the boundary.
  const atCeiling = HUNG_TOOL_NOW - UNCAPPED_TOOL_CEILING_MS;
  const overByAMs = HUNG_TOOL_NOW - UNCAPPED_TOOL_CEILING_MS + 1;
  const at = decideEscalation(
    hungMember({ lastActivityAt: atCeiling }, { startedAt: atCeiling }),
    undefined,
    HUNG_TOOL_NOW,
    true,
  );
  assert.equal(at.kind, 'escalate', 'exactly at the ceiling → hung');
  const under = decideEscalation(
    hungMember({ lastActivityAt: overByAMs }, { startedAt: overByAMs }),
    undefined,
    HUNG_TOOL_NOW,
    true,
  );
  assert.equal(under.kind, 'skip', 'one ms under the ceiling → alive');
});

test('T127.3: a hung call with the switch OFF → count, never escalate (C5)', () => {
  // COVERS T127.3: COUNTED, not FIRED while liveness=OFF. The SHADOW-wave state.
  // MUTANT: return `escalate` regardless of switchOn on the hung path → RED.
  const a = decideEscalation(hungMember(), undefined, HUNG_TOOL_NOW, false);
  assert.equal(a.kind, 'count', 'switch OFF → counted, not fired');
  assert.equal(a.kind === 'count' && a.hungTool, 'mcp__browser__click');
});

test('T127.1: ONE escalation per hung call — a fired hung call is not re-fired', () => {
  // The dedup shared with the staleness path (resolveStall). A member already
  // FIRED this hung call must not fire again on the next sweep.
  // MUTANT: drop the `previous?.fired` guard → a second sweep re-fires.
  const fired: EscalationLedgerEntry = { escalatedAtActivity: undefined, fired: true };
  const a = decideEscalation(hungMember(), fired, HUNG_TOOL_NOW, true);
  assert.equal(a.kind, 'skip');
  assert.equal(a.kind === 'skip' && a.why, 'already-escalated');
});

test('hungCallEscalationBody names the tool and the minutes, distinct from the staleness body', () => {
  // Carry-forward 2: a marker as specific as the claim. The body must name the
  // TOOL (a running member is not "silent" by the activity clock, so the #120
  // body would misdescribe it) and the minutes-hung figure.
  // MUTANT: reuse escalationBody for a hung call → no tool name, "no session
  //   activity" wording — a coordinator can't tell a hung call from a dead one.
  const body = hungCallEscalationBody('ws-worker', 'mcp__browser__click', 31 * 60_000 + 30_000);
  assert.match(body, /ws-worker/);
  assert.match(body, /mcp__browser__click/, 'the tool name is load-bearing');
  assert.match(body, /31m/, 'the minutes-hung figure is load-bearing');
  assert.match(body, /hung/, 'names the hung condition, not generic silence');
  // A null tool name still produces a sensible body (unknown at call start).
  const anon = hungCallEscalationBody('ws-worker', null, 31 * 60_000);
  assert.match(anon, /a tool/, 'null tool name renders a generic phrase, not "null"');
  assert.doesNotMatch(anon, /null/, 'never leaks the literal null');
});
