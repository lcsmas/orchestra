import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// ─── Issue #69: a turn dies on the turn limit and nothing tells the human ───
//
// This file guards ONE defect, and the history of getting here matters more
// than the fix, because two earlier versions of it guarded defects that DO NOT
// EXIST. Both were rig artifacts that flattered a fix already written:
//
//   1. "maxTurns is a session-lifetime budget and the queue drains into a
//      black hole." Derived by READING sdk.d.ts. Refuted by driving the SDK:
//      the cap is PER-TURN.
//   2. "The SECOND exhaustion throws and kills the queue." Derived from probes
//      whose async generators TERMINATE. Orchestra's `promptStream` is
//      `for(;;)` and returns only on `session.stopping`. Re-probed with a
//      never-ending generator: five consecutive `error_max_turns`, ZERO throws.
//      The throw needs the GENERATOR to exhaust, not the budget.
//
// MEASURED behaviour of the real thing (docs/research/issue-69-maxturns-findings.md):
//
//   • `maxTurns` is a PER-TURN cap. An exhausted turn fails; the session is
//     fine.
//   • The queue is NOT starved. With a never-ending generator and alternating
//     hard/easy prompts under `maxTurns:1`: exhaust, succeed, exhaust, succeed
//     — 4 of 4 consumed. There is nothing to recover.
//   • What IS broken: NOTHING TELLS THE HUMAN. Measured in the app, 8
//     consecutive exhaustions in the no-PTY configuration wrote no reason
//     anywhere. The `[WARN]` in the app log is the only record — verbatim what
//     issue #69 reports.
//
// So the fix is a SURFACING fix, not a recovery fix. An earlier draft shipped
// ~250 lines of resume/runaway-guard machinery hanging off a `catch` that
// cannot fire; it was deleted rather than shipped unreachable.

const ROOT = process.cwd(); // pnpm test runs from the repo root
const AGENT_SDK = path.join(ROOT, 'src', 'main', 'agent-sdk.ts');
const ACTIVITY = path.join(ROOT, 'src', 'main', 'activity.ts');

/** Source with line comments stripped, so prose ABOUT a design cannot satisfy
 *  a structural code check. */
function codeOf(file: string): string {
  const raw = fs.readFileSync(file, 'utf8');
  const stripped = raw
    .split('\n')
    .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
    .join('\n');
  assert.ok(stripped.length > 5_000, `comment-stripping ${path.basename(file)} returned too little`);
  return stripped;
}

/** `emitFrom`'s body — where the per-event work happens. */
function emitFromBody(code: string): string {
  const start = code.indexOf('function emitFrom(');
  assert.notEqual(start, -1, 'emitFrom() not found in agent-sdk.ts — was it renamed?');
  const rest = code.slice(start);
  const end = rest.indexOf('\nfunction ', 1);
  const body = end === -1 ? rest : rest.slice(0, end);
  // Positive control: the slice really is emitFrom, not an empty string that
  // would make every assertion below pass for free.
  assert.ok(body.length > 500, 'the emitFrom slice came back suspiciously short');
  assert.match(body, /driveStatusFromEvent\(session, ev\)/, 'the emitFrom slice looks wrong');
  return body;
}

// ─── The defect, executed ───────────────────────────────────────────────────

/** Model the ONE thing that decides whether the human learns a turn hit the
 *  limit. `driveStatus` is captured at spawn and is TRUE only when a terminal
 *  PTY coexists; the SDK's shell hooks (which own the spool otherwise) carry no
 *  reason field at all. */
function reasonReachesTheHuman(opts: {
  driveStatus: boolean;
  /** Does the code write the reason outside the single-writer gate? */
  writesOutsideGate: boolean;
}): boolean {
  let written = false;
  // The fix: an unconditional write, guarded only by the event being a
  // max_turns turn-end.
  if (opts.writesOutsideGate) written = true;
  // The pre-existing path, gated. Carries the reason only when driveStatus.
  if (opts.driveStatus) written = true;
  return written;
}

test('#69 UNFIXED: with no coexisting PTY the reason reaches nobody', () => {
  // The plain structured-view configuration — how most sessions run.
  assert.equal(
    reasonReachesTheHuman({ driveStatus: false, writesOutsideGate: false }),
    false,
    'unfixed + no PTY: nothing writes the reason (the measured bug: 8 exhaustions, 0 reasons)',
  );
  // CONTROL: with a PTY the old code DID surface it. This is why the bug was
  // easy to miss — and why a rig that happens to run with a PTY sees nothing
  // wrong.
  assert.equal(
    reasonReachesTheHuman({ driveStatus: true, writesOutsideGate: false }),
    true,
    'control: the gated path works when a PTY coexists, so the defect is configuration-dependent',
  );
});

test('#69 FIXED: the reason reaches the human in BOTH configurations', () => {
  for (const driveStatus of [false, true]) {
    assert.equal(
      reasonReachesTheHuman({ driveStatus, writesOutsideGate: true }),
      true,
      `fixed: the reason is written regardless of driveStatus (driveStatus=${driveStatus})`,
    );
  }
});

// ─── Source-binding guards ──────────────────────────────────────────────────

test('GUARD: the max_turns reason is written OUTSIDE the driveStatus gate', () => {
  const body = emitFromBody(codeOf(AGENT_SDK));

  const markAt = body.indexOf('markStoppedOnMaxTurns(');
  const gateAt = body.indexOf('driveStatusFromEvent(session, ev)');
  assert.notEqual(markAt, -1, 'emitFrom must write the max_turns reason');
  assert.notEqual(gateAt, -1, 'emitFrom should still call driveStatusFromEvent');
  // Outside the gate = not inside driveStatusFromEvent, and reached on its own
  // condition. Ordering is the observable proxy: the write precedes the gated
  // call and is guarded by its own `if`.
  assert.ok(
    markAt < gateAt,
    'the reason write must not depend on driveStatusFromEvent — that helper is gated on ' +
      'session.driveStatus, TRUE only when a terminal PTY coexists, so in the plain ' +
      'structured-view configuration the reason would reach nobody (the measured bug)',
  );
  assert.match(
    body,
    /ev\.type === 'turn-end' && ev\.stopReason === 'max_turns'/,
    'the write must be keyed on a max_turns turn-end specifically',
  );
});

test('GUARD: markStoppedOnMaxTurns writes the reason without changing the status', () => {
  const code = codeOf(ACTIVITY);
  const start = code.indexOf('export async function markStoppedOnMaxTurns(');
  assert.notEqual(start, -1, 'markStoppedOnMaxTurns() not found in activity.ts');
  const body = code.slice(start, start + 400);
  assert.match(
    body,
    /setStatus\(id, 'idle', 'max_turns'\)/,
    "markStoppedOnMaxTurns must record 'max_turns' — a stopped session is idle, and the " +
      'REASON is the orthogonal axis (never a sixth WorkspaceStatus)',
  );
});

test('GUARD: no unreachable turn-limit RECOVERY machinery came back', () => {
  const code = codeOf(AGENT_SDK);
  // An earlier draft hung ~250 lines of resume/runaway-guard code off a `catch`
  // that cannot fire: `promptStream` is `for(;;)` and returns only on
  // `session.stopping`, and every path there calls `q.interrupt()` first — which
  // sets `interruptRequested`, so `interrupted` wins in the catch anyway. Dead
  // code whose success and no-op are indistinguishable is worse than no code.
  for (const dead of ['budgetDeath', 'runBudgetRescue', 'planBudgetRescue', 'shouldRecycleForBudget']) {
    assert.doesNotMatch(
      code,
      new RegExp(`\\b${dead}\\b`),
      `${dead} is unreachable in production (promptStream never returns except via ` +
        'interrupt) — do not reintroduce a recovery for a control-flow path the app cannot take',
    );
  }
});

test('GUARD: the queue-loss reporting path is untouched (master parity)', () => {
  const code = codeOf(AGENT_SDK);
  const start = code.indexOf('async function consume(');
  assert.notEqual(start, -1, 'consume() not found');
  const rest = code.slice(start);
  const end = rest.indexOf('\nasync function ');
  const body = end === -1 ? rest : rest.slice(0, end);
  assert.ok(body.length > 1000, 'the consume() slice came back suspiciously short');
  // A previous draft spliced the queue empty before `undelivered` was computed,
  // so settleQueuedAsDropped never ran and senders kept a delivery receipt
  // forever — strictly WORSE than master. #69 needs no queue surgery at all
  // (the queue is not starved), so this path must remain exactly as master has it.
  assert.match(body, /settleQueuedAsDropped\(session\)/, 'the settle-and-report path must survive');
  const undeliveredAt = body.indexOf('const undelivered =');
  const settleAt = body.indexOf('settleQueuedAsDropped(session)');
  assert.ok(undeliveredAt < settleAt, 'undelivered is computed before the settle');
  assert.doesNotMatch(
    body.slice(0, undeliveredAt),
    /session\.queue\.splice\(/,
    'nothing may empty the queue before `undelivered` is read — that makes it 0, so the ' +
      'settle-and-report never runs and senders keep a delivery receipt forever',
  );
});

test('GUARD: the terminal stop reason is persisted for the sidebar to render', () => {
  const types = fs.readFileSync(path.join(ROOT, 'src', 'shared', 'types.ts'), 'utf8');
  assert.match(
    types,
    /lastStopReason\?:/,
    'Workspace must carry lastStopReason so the sidebar can show WHY a session stopped',
  );
});
