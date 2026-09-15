import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  noteToolStart,
  noteToolEnd,
  clearInFlightTools,
  getInFlightTools,
  forgetHibernationActivity,
} from './hibernation-activity.ts';

// The in-flight tool-call TRACKER (liveness v2, issue #127) — the seam that
// PRODUCES the inFlightTools state the pure policy (src/shared/bus-liveness.ts)
// reasons over. review-127 F1 lived HERE, not in the policy: the pure tests all
// fed hungCall a hand-built list, so nothing exercised the tracker turning a real
// pretool/posttool SEQUENCE into that list — and a single-slot Map let a fast
// parallel call's posttool wipe a hung sibling. These arms drive the shipped
// functions with realistic sequences and assert the state that reaches the sweep.
//
// Each test forgets its workspace after, since the tracker is a module-global Map.

const WS = 'ws-tracker-test';

function reset(): void {
  forgetHibernationActivity(WS);
}

test('F1 regression: a fast sibling posttool does NOT clear a hung parallel call', () => {
  // THE seam-level repro. Two overlapping tool calls start (parallel tool_use);
  // the fast one's posttool arrives (keyed by its id); the hung one MUST remain.
  // Pre-fix (single-slot Map, noteToolEnd deletes the whole entry) this left the
  // list empty → the hung call vanished → never escalated (the #90 wedge).
  reset();
  noteToolStart(WS, 'mcp__browser__click', 'toolu_hung');
  noteToolStart(WS, 'Bash', 'toolu_fast');
  assert.equal(getInFlightTools(WS).length, 2, 'both parallel calls are tracked');
  // The FAST call returns — its posttool carries its own id.
  noteToolEnd(WS, 'toolu_fast');
  const left = getInFlightTools(WS);
  assert.equal(left.length, 1, 'the fast posttool removes exactly one call');
  assert.equal(left[0].tool, 'mcp__browser__click', 'the HUNG call survives its sibling posttool');
  assert.equal(left[0].toolUseId, 'toolu_hung');
  reset();
});

test('a posttool for the hung call itself clears it (the healthy path)', () => {
  reset();
  noteToolStart(WS, 'mcp__browser__click', 'toolu_a');
  noteToolEnd(WS, 'toolu_a');
  assert.equal(getInFlightTools(WS).length, 0, 'a matched posttool clears its call');
  reset();
});

test('a posttool whose id matches nothing in flight is a no-op (never clears a sibling)', () => {
  // An id-KEYED posttool must NOT fall back to FIFO — that would strip a call
  // whose own posttool is still coming. Only an id-less posttool uses FIFO.
  reset();
  noteToolStart(WS, 'mcp__browser__click', 'toolu_a');
  noteToolEnd(WS, 'toolu_stranger'); // unrelated id
  assert.equal(getInFlightTools(WS).length, 1, 'an unmatched id-keyed posttool clears nothing');
  assert.equal(getInFlightTools(WS)[0].toolUseId, 'toolu_a');
  reset();
});

test('id-less posttool (legacy hook) removes the OLDEST id-less call of ITS TOOL, FIFO', () => {
  // The legacy spool path carries a tool NAME but no id. An id-less posttool for
  // "Bash" removes the oldest id-less Bash call — NOT an id-keyed call, and NOT a
  // different tool.
  reset();
  noteToolStart(WS, 'Bash', null); // oldest id-less Bash
  noteToolStart(WS, 'mcp__x', 'toolu_keyed'); // keyed — must survive FIFO
  noteToolStart(WS, 'WebFetch', null); // id-less, different tool — must survive
  noteToolEnd(WS, null, 'Bash'); // id-less posttool for Bash → removes the Bash call
  const left = getInFlightTools(WS);
  assert.equal(left.length, 2);
  assert.ok(!left.some((c) => c.tool === 'Bash'), 'the id-less Bash call was removed');
  assert.ok(left.some((c) => c.tool === 'WebFetch'), 'a different-tool id-less call is untouched');
  assert.ok(left.some((c) => c.toolUseId === 'toolu_keyed'), 'an id-keyed call is untouched');
  reset();
});

test('F3 (review-127): a fast id-less posttool does NOT clear a hung id-less call of a DIFFERENT tool', () => {
  // THE remote/sandbox failure mode. The wire carries a tool NAME but no id, so
  // both calls are id-less. A fast Bash returns; its id-less posttool (tool=Bash)
  // must remove the Bash call and leave the hung MCP call — the cross-tool masking
  // F1 fixed for local, now closed for remote via tool-name-scoped FIFO.
  // MUTANT: drop the `c.tool === tool` scope (plain oldest-id-less FIFO) → this
  //   goes RED (the Bash posttool removes the older MCP call → hung call vanishes).
  reset();
  noteToolStart(WS, 'mcp__browser__click', null); // hung, id-less, started FIRST
  noteToolStart(WS, 'Bash', null); // fast sibling, id-less
  noteToolEnd(WS, null, 'Bash'); // the fast Bash returns
  const left = getInFlightTools(WS);
  assert.equal(left.length, 1, 'exactly one call remains');
  assert.equal(
    left[0].tool,
    'mcp__browser__click',
    'the HUNG MCP call survives the fast Bash posttool (cross-tool masking closed)',
  );
  reset();
});

test('F3: an id-less posttool for an unknown tool falls back to oldest-id-less (pre-F3)', () => {
  // When the posttool carries no tool name either (null), we cannot scope by tool,
  // so it degrades to the oldest id-less call of any name — the documented fallback.
  reset();
  noteToolStart(WS, 'mcp__x', null);
  noteToolStart(WS, 'Bash', null);
  noteToolEnd(WS, null, null); // no id, no name → oldest id-less
  const left = getInFlightTools(WS);
  assert.equal(left.length, 1);
  assert.equal(left[0].tool, 'Bash', 'the oldest id-less (mcp__x) went, newest remains');
  reset();
});

test('#132 acceptance (remote same-tool, wire toolUseId): the HUNG (oldest) same-tool call SURVIVES its fast sibling', () => {
  // The #127 residual, now CLOSED by #132 (LEAD ruling D3(a): carry toolUseId on
  // remote tool events). On a REMOTE session two parallel calls of the SAME tool
  // where the OLDER hangs: because the sandbox wire now carries a DISTINCT
  // tool_use id per call (threaded EventFrame → parseSpoolChunk → shim emit →
  // onEvent → applyAgentEvent's 7th slot), ending the FAST call BY ITS ID removes
  // exactly that call — the hung oldest is untouched and still escalates.
  // This is the FLIP of the old F3-residual disclosure: same scenario, distinct
  // ids, opposite (correct) survivor.
  // MUTANT (id-threading clause): strip toolUseId on the wire so both calls are
  //   id-less again → this goes RED, reproducing the old masking (T132.3 asserts
  //   that stripped arm explicitly below).
  reset();
  noteToolStart(WS, 'mcp__browser__click', 'toolu_hung'); // HUNG, started first (oldest)
  noteToolStart(WS, 'mcp__browser__click', 'toolu_fast'); // fast sibling, same tool, newer
  noteToolEnd(WS, 'toolu_fast', 'mcp__browser__click'); // fast one returns, BY ID
  const left = getInFlightTools(WS);
  assert.equal(left.length, 1, 'exactly one same-tool call remains');
  // The SURVIVOR is the HUNG (oldest) call — its own id was never ended. The fast
  // sibling no longer masks it: the id, not the name, decided which call ended.
  assert.equal(left[0].toolUseId, 'toolu_hung', 'the HUNG call survives (id-scoped, not masked)');
  assert.equal(left[0].tool, 'mcp__browser__click');
  reset();
});

test('#132 must-FAIL control (T132.3): id STRIPPED from the wire reproduces the OLD masking', () => {
  // The load-bearing control. If toolUseId were NOT what makes the fix work, this
  // arm — the SAME remote same-tool scenario but with the wire id stripped (both
  // calls id-less, posttool scoped by tool NAME only, exactly what the sandbox
  // path did before #132) — would still attribute correctly. It must NOT: the
  // id-less name-only FIFO removes the OLDEST same-tool call (the hung one), so
  // the fast sibling survives and the hung call's escalation is dropped. This is
  // the OLD behaviour, proving toolUseId is load-bearing (C4 disproof arm).
  reset();
  noteToolStart(WS, 'mcp__browser__click', null); // HUNG, started first (oldest), id STRIPPED
  noteToolStart(WS, 'mcp__browser__click', null); // fast sibling, same tool, id STRIPPED
  noteToolEnd(WS, null, 'mcp__browser__click'); // fast one returns, id-less → name-only FIFO
  const left = getInFlightTools(WS);
  assert.equal(left.length, 1, 'one same-tool call remains (>=1 always survives)');
  // The SURVIVOR is the NEWER (fast) call — the hung oldest was MASKED, the exact
  // defect #132 fixes. Contrast the acceptance arm above (survivor = the hung one).
  assert.equal(left[0].toolUseId, null, 'the survivor is an id-less (fast) call — hung oldest masked');
  assert.equal(left[0].tool, 'mcp__browser__click');
  reset();
});

test('a duplicate pretool for the same id replaces, does not duplicate', () => {
  reset();
  noteToolStart(WS, 'Bash', 'toolu_a');
  noteToolStart(WS, 'Bash', 'toolu_a'); // replay of the same call
  assert.equal(getInFlightTools(WS).length, 1, 'the same id is not tracked twice');
  reset();
});

test('clearInFlightTools drops every call (a turn ended without a posttool per call)', () => {
  // An interrupt/error ends the turn with calls still notionally in flight; the
  // turn-end must clear them all so they do not linger as false hangs.
  reset();
  noteToolStart(WS, 'mcp__browser__click', 'toolu_a');
  noteToolStart(WS, 'Bash', 'toolu_b');
  clearInFlightTools(WS);
  assert.equal(getInFlightTools(WS).length, 0, 'a turn-end clears all in-flight calls');
  reset();
});

test('getInFlightTools for an untracked workspace is an empty array', () => {
  reset();
  assert.deepEqual(getInFlightTools('ws-never-seen'), []);
});

test('noteToolEnd on an empty tracker is a no-op (idempotent)', () => {
  reset();
  assert.doesNotThrow(() => noteToolEnd(WS, 'toolu_x'));
  assert.doesNotThrow(() => noteToolEnd(WS, null));
  assert.equal(getInFlightTools(WS).length, 0);
  reset();
});

test('forgetHibernationActivity clears in-flight tracking (workspace deleted)', () => {
  reset();
  noteToolStart(WS, 'Bash', 'toolu_a');
  forgetHibernationActivity(WS);
  assert.equal(getInFlightTools(WS).length, 0);
});
