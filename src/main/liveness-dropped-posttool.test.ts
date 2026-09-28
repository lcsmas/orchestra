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

/** One spool line, in the shape activity.ts's `applyAgentEvent` consumes.
 *  `queued` (a submit only) mirrors `queuedSubmit`: TRUE for a PARKED prompt /
 *  keeper reattach (a mid-turn submit, NOT a boundary). */
interface SpoolEvent {
  event: 'submit' | 'pretool' | 'posttool' | 'stop';
  tool?: string | null;
  toolUseId?: string | null;
  queued?: boolean;
}

/** Faithful model of the ONLY tracker calls each activity.ts switch arm makes
 *  (mirrors src/main/activity.ts lines behind each `case`). `submitClears` is the
 *  ONE clause under test: the FIX makes a REAL-boundary `submit` clear the list;
 *  PRE-FIX (master) it did not. The `submit` arm mirrors the shipped guard
 *  `if (!queuedSubmit) clearInFlightTools(id)` — a QUEUED submit (parked / reattach)
 *  never clears, even under the fix (review-199 F1). Everything else is identical
 *  in both arms, so the arms differ only in the fix clause. */
function applySpool(ws: string, events: readonly SpoolEvent[], submitClears: boolean): void {
  for (const ev of events) {
    switch (ev.event) {
      case 'submit':
        // activity.ts `case 'submit'`: emitTool(THINKING) + setStatus(running) +
        // [FIX #199] `if (!queuedSubmit) clearInFlightTools(id)`.
        if (submitClears && ev.queued !== true) clearInFlightTools(ws);
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

test('#199 review-199 F1: a MID-TURN (queued) submit must NOT clear a live tool', () => {
  // THE blocking finding. Turn A is running a Bash that HANGS; then a PARKED prompt
  // (SDK send queued behind the running turn) or a keeper REATTACH drives a submit
  // MID-turn (queuedSubmit=true). The blanket clear (the first #199 cut) wiped the
  // live Bash here → decideEscalation returned skip → the genuine hang the ceiling
  // SHOULD catch never escalated. The fix gates the clear on `!queuedSubmit`, so a
  // queued submit leaves the running turn's tool in place and it STILL escalates.
  const now = Date.now();
  const midTurnSpool: SpoolEvent[] = [
    { event: 'submit' }, // turn A begins (a real boundary)
    { event: 'pretool', tool: 'Bash', toolUseId: 'toolu_bash_live' }, // Bash starts and HANGS
    { event: 'submit', queued: true }, // a PARKED prompt / reattach — mid-turn, NOT a boundary
    // <-- turn A still running; its Bash is live, not a phantom
  ];

  // The FIX arm (submitClears=true): the queued submit must NOT clear the live Bash.
  reset();
  applySpool(WS, midTurnSpool, /* submitClears */ true);
  const list = getInFlightTools(WS);
  assert.equal(list.length, 1, 'FIX: a queued (mid-turn) submit leaves the running turn\'s tool in flight');
  assert.equal(list[0].tool, 'Bash');
  const member: MemberLivenessState = {
    ...memberFrom(WS, now),
    inFlightTools: [{ tool: 'Bash', startedAt: now - CEILING_AGO }],
  };
  const action = decideEscalation(member, undefined, now, true);
  assert.equal(
    action.kind,
    'escalate',
    'FIX must-PASS: a genuinely hung Bash STILL escalates through a mid-turn submit (#108 Q16)',
  );
  assert.equal(action.kind === 'escalate' && action.hungTool, 'Bash');

  // CONTRAST — the BROKEN (blanket-clear) behaviour: had the queued submit cleared,
  // the live Bash would vanish and the genuine hang go undetected. Model the blanket
  // clear (ignore `queued`) and show it masks the escalation — this is what the fix
  // prevents (asserts the guard is load-bearing, not decorative).
  reset();
  for (const ev of midTurnSpool) {
    if (ev.event === 'submit') clearInFlightTools(WS); // BLANKET clear (ignores queued)
    else if (ev.event === 'pretool') noteToolStart(WS, ev.tool ?? null, ev.toolUseId ?? null);
  }
  assert.equal(getInFlightTools(WS).length, 0, 'BLANKET clear wipes the live Bash — the review-199 F1 bug');
  const maskedAction = decideEscalation(memberFrom(WS, now), undefined, now, true);
  assert.equal(maskedAction.kind, 'skip', 'BLANKET clear masks the genuine hang — the defect the fix removes');
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

test('#199 source: the submit arm clears in-flight tools GATED on !queuedSubmit (must-FAIL on master)', () => {
  const code = codeOf(ACTIVITY);
  const submitArm = caseArm(code, 'submit');
  // The clear must be present (master has none → reddens there) …
  assert.match(
    submitArm,
    /clearInFlightTools\(\s*id\s*\)/,
    'the submit arm must call clearInFlightTools(id) — a new turn clears prior ' +
      "phantoms (#199). On master this arm has no such call, so the dropped-" +
      "posttool Bash strands across the turn and false-escalates as 'hung mid-call'.",
  );
  // … AND it must be GUARDED by `!queuedSubmit` (review-199 F1): a blanket clear
  // wipes a live tool of a still-running turn on a PARKED/reattach mid-turn submit
  // and masks a genuine hang. Pin the guard so the blanket form cannot return.
  assert.match(
    submitArm,
    /if\s*\(\s*!queuedSubmit\s*\)\s*clearInFlightTools\(\s*id\s*\)/,
    'the submit-arm clear must be gated on !queuedSubmit (review-199 F1) — a ' +
      'queued (parked/reattach) submit is mid-turn and must not wipe a live tool.',
  );
});

test('#199 source: applyAgentEvent declares the queuedSubmit parameter', () => {
  const code = codeOf(ACTIVITY);
  const start = code.indexOf('export function applyAgentEvent(');
  assert.notEqual(start, -1, 'applyAgentEvent() not found — was it renamed?');
  const end = code.indexOf('): void {', start);
  assert.notEqual(end, -1, 'applyAgentEvent signature has no `): void {` — slice would be wrong');
  const sig = code.slice(start, end);
  assert.match(sig, /toolUseId\?:\s*string\s*\|\s*null/, 'positive control: the sliced text is applyAgentEvent\'s params');
  assert.match(sig, /queuedSubmit\?:\s*boolean/, 'applyAgentEvent must take the #199 queuedSubmit flag');
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

test('#199 source: driveStatusFromEvent computes queuedSubmit and PASSES it to applyAgentEvent', () => {
  // The producer wiring: without this the parameter exists but is fed `undefined`
  // for every SDK submit — a parked/reattach submit would fall through to the
  // real-boundary branch and wipe a live tool (review-199 F1 re-opened). Pin that
  // driveStatusFromEvent both DERIVES queuedSubmit (from ev.queued / session-attach)
  // and passes it as applyAgentEvent's last argument (the turn-start-stamp R3
  // lesson: a value can be computed and then dropped on the way through).
  const SDK = path.join(process.cwd(), 'src', 'main', 'agent-sdk.ts');
  const code = codeOf(SDK);
  const fnIdx = code.indexOf('function driveStatusFromEvent(');
  assert.notEqual(fnIdx, -1, 'driveStatusFromEvent not found — was it renamed?');
  // Slice from the fn to the applyAgentEvent call it makes.
  const applyIdx = code.indexOf('applyAgentEvent(', fnIdx);
  assert.notEqual(applyIdx, -1, 'driveStatusFromEvent no longer calls applyAgentEvent');
  const body = code.slice(fnIdx, code.indexOf(');', applyIdx) + 2);
  assert.match(body, /const\s+queuedSubmit\s*=/, 'driveStatusFromEvent must derive queuedSubmit');
  assert.match(body, /ev\.queued/, 'queuedSubmit must read ev.queued (the parked-prompt marker)');
  // The call must pass queuedSubmit as an argument (not silently drop it).
  const call = code.slice(applyIdx, code.indexOf(');', applyIdx));
  assert.match(call, /queuedSubmit/, 'applyAgentEvent call must pass queuedSubmit through');
});
