// Issue #199 (T6, ledger #198): the #127 "hung mid-call" escalation
// FALSE-POSITIVES when a `posttool` is DROPPED and the tool's `pretool` is left
// stranded in `inFlightTools` across a turn boundary. In wave 198 it fired 7×
// against healthy members (seq 1711: escalated as "hung 10m" 5s before the same
// member reported #187 DONE).
//
// ── The root cause, and why the fix is a TURN-START clear ─────────────────────
//
// A call leaves `inFlightTools` only via its own `posttool` (noteToolEnd keyed on
// toolUseId) or a turn-end `stop` (clearInFlightTools). If the `posttool` is
// dropped AND the turn's `stop` is also lost/delayed (the coalesced-wake amplifier
// keeps the member `running` across turns without a clean per-turn stop), the
// stranded Bash ages past its 600s ceiling and `hungCall` false-escalates.
//
// The fix (activity.ts `submit` arm): a NEW turn start clears the in-flight list.
// A tool call cannot span a turn boundary — the model must receive every
// tool_result before it can end a turn, and a fresh `submit`/user-message only
// arrives once the last turn ended — so any call surviving into a new turn is a
// phantom. A GENUINELY hung mid-call turn never reaches a new `submit` (it is
// stuck), so the ceiling still catches it (#108 Q16 preserved).
//
// ── G3: the real event path, not a pure helper ───────────────────────────────
//
// `applyAgentEvent` (activity.ts) cannot execute under the strip-types test runner
// (`import { platform } from './platform'` is an extensionless DIR import — see
// turn-start-stamp.test.ts). So this file drives the SHIPPED tracker functions
// (hibernation-activity.ts, a dependency-free leaf that DOES execute) through the
// EXACT per-event dispatch each activity.ts arm performs, then feeds the resulting
// list into the SHIPPED pure policy (decideEscalation). The dispatch table is
// pinned to the real source by the SOURCE-CHECK tests at the bottom, so it cannot
// silently drift from what activity.ts does. The must-FAIL arm runs the SAME
// spool through the PRE-FIX dispatch (submit does NOT clear) and shows the
// end-to-end escalation the fix removes.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  noteToolStart,
  noteToolEnd,
  clearInFlightTools,
  getInFlightTools,
  forgetHibernationActivity,
} from './hibernation-activity.ts';
import {
  decideEscalation,
  BASH_TOOL_CEILING_MS,
  type MemberLivenessState,
} from '../shared/bus-liveness.ts';

const WS = 'ws-199-dropped-posttool';

/** One spool line, in the shape activity.ts's `applyAgentEvent` consumes. */
interface SpoolEvent {
  event: 'submit' | 'pretool' | 'posttool' | 'stop';
  tool?: string | null;
  toolUseId?: string | null;
}

/** Faithful model of the ONLY tracker calls each activity.ts switch arm makes
 *  (mirrors src/main/activity.ts lines behind each `case`). `submitClears` is the
 *  ONE clause under test: the FIX makes `submit` clear the list; PRE-FIX it did
 *  not. Everything else is identical in both arms, so the arms differ only in the
 *  fix clause — the must-FAIL comparison is exact. */
function applySpool(ws: string, events: readonly SpoolEvent[], submitClears: boolean): void {
  for (const ev of events) {
    switch (ev.event) {
      case 'submit':
        // activity.ts `case 'submit'`: emitTool(THINKING) + setStatus(running) +
        // [FIX #199] clearInFlightTools(id).
        if (submitClears) clearInFlightTools(ws);
        break;
      case 'pretool':
        // activity.ts `case 'pretool'`: noteToolStart(id, tool, toolUseId).
        noteToolStart(ws, ev.tool ?? null, ev.toolUseId ?? null);
        break;
      case 'posttool':
        // activity.ts `case 'posttool'`: noteToolEnd(id, toolUseId, tool).
        noteToolEnd(ws, ev.toolUseId ?? null, ev.tool ?? null);
        break;
      case 'stop':
        // activity.ts `case 'stop'`: clearInFlightTools(id).
        clearInFlightTools(ws);
        break;
    }
  }
}

/** A running member whose in-flight list is whatever the tracker holds NOW, with
 *  the stranded call started far enough back to be past the Bash ceiling. Only the
 *  in-flight list varies between arms; every other field keeps the member alive so
 *  the ceiling bound is the ONLY thing that could escalate it. */
function memberFrom(ws: string, now: number): MemberLivenessState {
  return {
    reader: ws,
    coordinator: 'ws-ops',
    hasTask: true,
    lastActivityAt: now - 30_000, // recent — a fast sibling's posttool advanced it
    appStartedAt: now - 60 * 60_000,
    running: true,
    waiting: false,
    doneAndReleased: false,
    inFlightTools: getInFlightTools(ws),
  };
}

function reset(): void {
  forgetHibernationActivity(WS);
}

// A Bash pretool started well past its 600s ceiling, whose posttool never arrives.
const CEILING_AGO = BASH_TOOL_CEILING_MS + 60_000;

test('#199 must-FAIL then FIX: a dropped posttool + a new turn — the phantom Bash', () => {
  // Real spool: turn A runs a Bash (pretool), the Bash RETURNS but its posttool is
  // DROPPED, turn A's stop is also lost (the coalesced-wake amplifier keeps the
  // member running), then turn B STARTS (submit). Only the fix clause differs.
  const now = Date.now();
  const spool: SpoolEvent[] = [
    { event: 'submit' }, // turn A begins
    { event: 'pretool', tool: 'Bash', toolUseId: 'toolu_bash_A' }, // Bash starts
    // <-- Bash returns here, but its `posttool` is DROPPED (never delivered)
    // <-- turn A's `stop` is also lost (coalesced-wake amplifier: still `running`)
    { event: 'submit' }, // turn B begins — the coalesced wake turn
  ];

  // Backdate the pretool so the stranded Bash is past its ceiling. noteToolStart
  // stamps Date.now(), so drive it and then rewrite startedAt on the entry via a
  // fresh member snapshot with the aged start time.
  reset();
  applySpool(WS, spool, /* submitClears */ false); // PRE-FIX arm
  const preFixList = getInFlightTools(WS);
  // PRE-FIX BUG (must-FAIL): the Bash pretool is STILL in flight after turn B's
  // submit — nothing cleared it (posttool dropped, stop lost, old submit no-op).
  assert.equal(preFixList.length, 1, 'PRE-FIX: the dropped-posttool Bash strands past the new turn');
  assert.equal(preFixList[0].tool, 'Bash');
  // Feed it through the SHIPPED policy with the start backdated past the ceiling:
  // this is the end-to-end false escalation the bug produced.
  const preFixMember: MemberLivenessState = {
    ...memberFrom(WS, now),
    inFlightTools: [{ tool: 'Bash', startedAt: now - CEILING_AGO }],
  };
  const preFixAction = decideEscalation(preFixMember, undefined, now, true);
  assert.equal(
    preFixAction.kind,
    'escalate',
    'PRE-FIX: the phantom Bash escalates as "hung mid-call" — THE #199 false-positive',
  );
  assert.equal(preFixAction.kind === 'escalate' && preFixAction.hungTool, 'Bash');

  // FIX arm: the SAME spool, submit-clears ON.
  reset();
  applySpool(WS, spool, /* submitClears */ true);
  const fixedList = getInFlightTools(WS);
  // FIX: turn B's submit cleared the prior turn's stranded Bash.
  assert.equal(fixedList.length, 0, 'FIX: the new turn cleared the phantom Bash');
  const fixedMember = memberFrom(WS, now); // empty in-flight list now
  const fixedAction = decideEscalation(fixedMember, undefined, now, true);
  assert.equal(fixedAction.kind, 'skip', 'FIX: no phantom → no escalation');
  assert.equal(fixedAction.kind === 'skip' && fixedAction.why, 'running', 'alive, running, no stuck call');
  reset();
});

test('#199 the fix does NOT break a GENUINELY hung mid-call (the #108 Q16 case)', () => {
  // A turn starts a Bash and the tool NEVER returns and the turn NEVER ends — no
  // posttool, no stop, and crucially NO new submit (the session is stuck). Under
  // BOTH dispatch arms the Bash must stay in flight and escalate: the fix touches
  // only the turn-BOUNDARY, which a hung turn never crosses.
  const now = Date.now();
  const hungSpool: SpoolEvent[] = [
    { event: 'submit' }, // turn begins
    { event: 'pretool', tool: 'Bash', toolUseId: 'toolu_bash_hung' }, // Bash starts and hangs
    // <-- nothing follows: no posttool, no stop, no new submit
  ];

  for (const submitClears of [false, true]) {
    reset();
    applySpool(WS, hungSpool, submitClears);
    const list = getInFlightTools(WS);
    assert.equal(list.length, 1, `hung call stays in flight (submitClears=${submitClears})`);
    assert.equal(list[0].tool, 'Bash');
    // Past the ceiling → the policy escalates. The fix must not have removed this.
    const member: MemberLivenessState = {
      ...memberFrom(WS, now),
      inFlightTools: [{ tool: 'Bash', startedAt: now - CEILING_AGO }],
    };
    const action = decideEscalation(member, undefined, now, true);
    assert.equal(
      action.kind,
      'escalate',
      `a genuinely hung Bash STILL escalates (submitClears=${submitClears}) — #108 Q16 preserved`,
    );
    assert.equal(action.kind === 'escalate' && action.hungTool, 'Bash');
  }
  reset();
});

test('#199 a healthy turn (posttool arrives) never strands — the negative control', () => {
  // Proves the must-FAIL arm above is not vacuous: when the posttool DOES arrive,
  // the Bash clears WITHOUT needing the turn-start clause, so this passes even on
  // PRE-FIX. If this ever went red, the strand in the must-FAIL test would be an
  // artefact of the tracker, not the dropped posttool.
  const now = Date.now();
  const healthy: SpoolEvent[] = [
    { event: 'submit' },
    { event: 'pretool', tool: 'Bash', toolUseId: 'toolu_ok' },
    { event: 'posttool', tool: 'Bash', toolUseId: 'toolu_ok' }, // posttool DELIVERED
    { event: 'submit' },
  ];
  for (const submitClears of [false, true]) {
    reset();
    applySpool(WS, healthy, submitClears);
    assert.equal(getInFlightTools(WS).length, 0, `healthy turn leaves nothing (submitClears=${submitClears})`);
    const action = decideEscalation(memberFrom(WS, now), undefined, now, true);
    assert.equal(action.kind, 'skip', 'a healthy member never escalates');
  }
  reset();
});

// ── SOURCE CHECK: the executable dispatch above matches shipped activity.ts ────
//
// The rig models activity.ts's per-arm tracker calls; these tests pin that model
// to the real source so it cannot drift. They are the must-FAIL arm's anchor: on
// master the `submit` arm does NOT call clearInFlightTools, so the first assertion
// below reddens — proving the fix's site, not just its effect.

const ACTIVITY = path.join(process.cwd(), 'src', 'main', 'activity.ts');

/** Source with comment lines stripped (prose about the design must not satisfy a
 *  check about the code) — the turn-start-stamp.test.ts convention. */
function codeOf(file: string): string {
  const stripped = fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => {
      const t = l.trim();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    })
    .join('\n');
  assert.ok(stripped.length > 5_000, `comment-stripping ${path.basename(file)} returned too little`);
  return stripped;
}

/** The body of one `case '<name>':` arm up to its `break;` — isolating the arm so
 *  a file-wide grep for `clearInFlightTools` (present in stop/notify/session) can't
 *  satisfy a check about the `submit` arm. */
function caseArm(code: string, name: string): string {
  const marker = `case '${name}':`;
  const start = code.indexOf(marker);
  assert.notEqual(start, -1, `case '${name}' not found in activity.ts — was it renamed?`);
  const rest = code.slice(start + marker.length);
  const end = rest.indexOf('break;');
  assert.notEqual(end, -1, `case '${name}' has no break — slice would run past the arm`);
  const body = rest.slice(0, end);
  // Positive control: the arm must look like a real arm (a status/tool call).
  assert.match(body, /setStatus\(|emitTool\(|fireFinished\(/, `isolated '${name}' arm does not look real`);
  return body;
}

test('#199 source: the submit arm CLEARS in-flight tools (must-FAIL on master)', () => {
  const code = codeOf(ACTIVITY);
  const submitArm = caseArm(code, 'submit');
  assert.match(
    submitArm,
    /clearInFlightTools\(\s*id\s*\)/,
    'the submit arm must call clearInFlightTools(id) — a new turn clears prior ' +
      "phantoms (#199). On master this arm has no such call, so the dropped-" +
      "posttool Bash strands across the turn and false-escalates as 'hung mid-call'.",
  );
});

test('#199 source: turn-END arms still clear too (regression guard, not replaced)', () => {
  // The turn-start clear is ADDITIVE — the end-of-turn clears must remain, or an
  // interrupt/error that ends a turn with no following submit would strand.
  const code = codeOf(ACTIVITY);
  for (const arm of ['stop', 'notify']) {
    assert.match(
      caseArm(code, arm),
      /clearInFlightTools\(\s*id\s*\)/,
      `case '${arm}' must still clear in-flight tools at turn end`,
    );
  }
});
