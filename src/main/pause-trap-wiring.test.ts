// #252 D1b — the production WIRING of the pause trap, pinned structurally (index.ts imports Electron, so the boot
// order cannot run under `node --test`; the behaviour is proven by pause-trap.test.ts over injected deps and by
// scripts/pause-trap/run.mjs over the real modules). Each assertion is a STRUCTURAL relationship over comment-stripped
// source with its own positive control — a bare identifier grep would pass on a comment or a moved call.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
function codeOf(rel: string): string {
  const raw = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  const code = raw.split('\n').filter((l) => { const t = l.trim(); return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*'); }).join('\n');
  assert.ok(code.length > 1_000, `comment-stripping ${rel} returned too little`);
  return code;
}
const at = (code: string, needle: string): number => {
  const i = code.indexOf(needle);
  assert.notEqual(i, -1, `not found: ${needle}`);
  return i;
};

test('index.ts starts the trap AFTER the bus liveness sweep, registers BOTH observers first, and stops it before the bus closes', () => {
  const code = codeOf('src/main/index.ts');
  const live = at(code, 'startBusLiveness();');
  const buildDeps = at(code, 'buildPauseTrapDeps()');
  const turn = at(code, 'setTurnStartObserver(makeTurnStartObserver(');
  const human = at(code, 'setPauseHumanTurnObserver(markPauseHumanTurn)');
  const start = at(code, 'startPauseTrap(pauseTrapDeps)');
  assert.ok(live < buildDeps && buildDeps < turn && turn < human && human < start, 'order: liveness → deps → turn observer → human observer → startPauseTrap (a boot drain must never run before its observers exist)');
  const shut = code.slice(at(code, 'function shutdownSubsystems()'));
  assert.ok(at(shut, 'stopPauseTrap();') < at(shut, 'closeBus();'), 'stopPauseTrap() before closeBus() (its sweep reads the bus handle)');
});

test('agent-sdk consume(): a CLI-started turn (no app turn in flight) notifies the observer BEFORE the event is emitted, once per turn, reset at `result`', () => {
  const code = codeOf('src/main/agent-sdk.ts');
  const guard = at(code, "session.turnGate === null && !session.unexplainedTurnSeen && !session.stopping && (msg.type === 'assistant' || msg.type === 'stream_event')");
  const notify = at(code, 'notifyTurnStart(session.wsId);');
  const emit = at(code, 'const emitted = emitFrom(session, msg);');
  assert.ok(guard < notify && notify < emit, 'guard → notify → emitFrom');
  assert.ok(code.slice(guard, notify).includes('session.unexplainedTurnSeen = true;'), 'latched before notifying (once per turn)');
  const resultArm = code.slice(at(code, "if (msg.type === 'result') {"));
  assert.ok(resultArm.indexOf('session.unexplainedTurnSeen = false;') !== -1 && resultArm.indexOf('session.unexplainedTurnSeen = false;') < 600, 'the latch resets in the `result` branch');
});

test('sdkInterruptForPause never touches an idle session and NEVER drops the queue (plain interrupt, no cancel_queued)', () => {
  const code = codeOf('src/main/agent-sdk.ts');
  const fn = code.slice(at(code, 'export async function sdkInterruptForPause('));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  assert.ok(body.includes("if (!attached && session.turnGate === null && session.unexplainedTurnSeen !== true) return 'idle';"));
  assert.ok(body.indexOf("return 'idle'") < body.indexOf('session.interruptRequested = true;'), 'the idle exit precedes the interruptRequested latch (a stale latch would relabel a later crash)');
  assert.ok(body.includes('await session.q.interrupt();'), 'plain interrupt');
  assert.ok(!body.includes('interruptCancellingQueued') && !body.includes('settleQueuedAsDropped') && !/queue\.length\s*=\s*0/.test(body), 'the queue is left intact (D5 row 24: queued BEFORE the pause must not be lost or drained)');
  assert.ok(!body.includes('emit('), 'never fabricates an event for a missing session (unlike sdkInterrupt)');
});

test('activity.ts: the `submit` chokepoint notifies only a REAL turn boundary (not a parked prompt or a reattach)', () => {
  const code = codeOf('src/main/activity.ts');
  const submit = code.slice(at(code, "case 'submit':"));
  const arm = submit.slice(0, submit.indexOf('break;'));
  assert.ok(arm.includes('if (!queuedSubmit) notifyTurnStart(id);'));
});

test('the host observer stands down for anything without a live structured session (PTY keystrokes also fire `submit`)', () => {
  const code = codeOf('src/main/pause-trap-host.ts');
  const obs = code.slice(at(code, 'export function makeTurnStartObserver('));
  assert.ok(at(obs, 'if (sdkPauseActivity(wsId) === null) return;') < at(obs, 'void onTurnStart('));
});

test('pause-trap-host snapshots through the no-touch snapshotWorktree and kills through killToolTrees only (never a raw kill)', () => {
  const code = codeOf('src/main/pause-trap-host.ts');
  assert.ok(code.includes('snapshot: snapshotWorktree,'));
  assert.ok(code.includes('killTrees: (cli, keeperPid) => killToolTrees(cli, keeperPid, kill),'));
  assert.ok(!/process\.kill\(|\.kill\(/.test(code), 'the host binding contains no direct kill call');
});

test('pause-trap-host membership is the UNION of the run closure and the live parent chain (parent_run_id is write-once)', () => {
  const code = codeOf('src/main/pause-trap-host.ts');
  assert.ok(code.includes('return c.includes || (c.dangling && set.has(m.runId));'));
  assert.ok(code.includes('pausedCarrierForWorkspace(db, ws, (id) => store.getWorkspace(id))'), 'the observer asks the gate\'s own live-tree decision');
  assert.ok(code.includes('chain: liveChain(ws),'), 'toMember carries the live chain the turn-start observer reads');
});

test('CONTROL: codeOf really strips comments (a needle that only appears in a comment is NOT found)', () => {
  const code = codeOf('src/main/pause-trap-host.ts');
  assert.equal(code.includes('Claude Code\'s interrupt key'), false);
  assert.throws(() => at(code, 'Production wiring of the fleet-Pause host trap'));
});
