import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// #252 fleet PAUSE (wave D ledger #261 D5) — every GATE / SILENCE row, driven through the REAL modules (workspaces, restart-workspace,
// prompt-queue, agent-sdk, session-watchdog, bus-wake + wake-roster) over a REAL bus.sqlite + store, one rig arm per SUBPROCESS
// (scripts/e2e-pause-gates.mjs — needs the resolution hook). Scratch HOME/ORCHESTRA_HOME/CLAUDE_CONFIG_DIR under ~/.cache (D8). Each arm
// carries its own controls (the lift, an unrelated run, the HUMAN origin), so a dead instrument reads red. Arm titles are the names the
// in-place mutants redden (ledger #261 nomination).

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const RIG = path.join(REPO, 'scripts', 'e2e-pause-gates.mjs');
const REGISTER = path.join(REPO, 'scripts', '.r2-register.mjs');
const PAUSE_HOME = path.join(os.homedir(), '.cache', `e2e-pause-gates-unit-${process.pid}`);
const PAUSED = 'run en pause — orchestra run resume --run ws-ops';

type R = Record<string, any> & { ok: boolean; arm: string };

function runArm(arm: string): R {
  let stdout = '';
  try {
    stdout = execFileSync(process.execPath, ['--experimental-strip-types', '--no-warnings', '--import', REGISTER, RIG, arm], {
      encoding: 'utf8', timeout: 170_000, cwd: REPO, env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: os.homedir(), PAUSE_RIG_HOME: PAUSE_HOME }, stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch (e) {
    stdout = (e as { stdout?: string }).stdout ?? ''; // a red arm exits 1 but still printed its verdict line
  }
  const line = stdout.trim().split('\n').filter(Boolean).pop();
  assert.ok(line, `arm ${arm} produced no output — the rig did not run`); // a crashed rig must read as a failure, never a pass
  const r = JSON.parse(line) as R;
  assert.equal(r.arm, arm, 'the rig ran the arm that was asked for');
  return r;
}

test.after(() => fs.rmSync(PAUSE_HOME, { recursive: true, force: true }));

test('the rig + its register hook exist', () => {
  assert.ok(fs.existsSync(RIG) && fs.existsSync(REGISTER));
});

test('GATE row 20/21 spawn: a spawn from inside a paused run (or under a paused ancestor run) is refused BEFORE any worktree; human click + other run + the lift spawn', () => {
  const r = runArm('spawn');
  for (const k of ['memberRes', 'descendantRes', 'opsRes']) assert.deepEqual(r[k], { ok: false, error: PAUSED }, k);
  assert.equal(r.countsUnchanged, true, 'no workspace row and no worktree dir created by a refused spawn');
  assert.equal(r.startsWhilePaused, 0);
  assert.equal(r.humanClickRes.ok, true, 'a human click (no `from`) is HUMAN: allowed');
  assert.equal(r.otherRunRes.ok, true, 'an unrelated run is never gated');
  assert.equal(r.stillPaused, true, 'and none of that un-paused anything');
  assert.equal(r.afterLiftRes.ok, true);
  assert.equal(r.ok, true);
});

test('GATE row 18 message: a message (incl. broadcast/--emergency) to a paused member is PARKED in the inbox, never delivered or woken', () => {
  const r = runArm('message');
  assert.deepEqual(r.toMember, { ok: true, delivery: 'inbox' });
  assert.deepEqual(r.toDescendant, { ok: true, delivery: 'inbox' });
  assert.deepEqual([r.inboxM1, r.inboxM3], [true, true], 'the text is durable in the inbox file');
  assert.equal(r.deliveredWhilePaused, 0, 'no live turn, no wake start');
  assert.equal(r.broadcast.results[0].delivery, 'inbox');
  assert.equal(r.toOtherRun.delivery, 'started', 'control: an unrelated run is delivered');
  assert.equal(r.afterLift.delivery, 'started', 'control: the lift restores delivery');
  assert.equal(r.ok, true);
});

test('GATE WAWP (rows 13/16/17/18 share it): AUTO wake refused; HUMAN wake allowed and its origin reaches the start seam; the pause stays', () => {
  const r = runArm('wake');
  assert.equal(r.autoPaused, false);
  assert.equal(r.startsAfterAuto, 0);
  assert.equal(r.humanPaused, true);
  assert.deepEqual(r.humanStart, [{ text: 'HUMAN-WAKE', origin: 'human' }]);
  assert.equal(r.stillPaused, true, 'a human prompt un-pauses nothing');
  assert.equal(r.otherRun, true);
  assert.equal(r.afterLift, true);
  assert.equal(r.ok, true);
});

test('GATE row 5/6/7 restart: `orchestra restart` + re-parent restart refused BEFORE any stop/spawn; the toolbar Restart (HUMAN) proceeds', () => {
  const r = runArm('restart');
  assert.deepEqual(r.cli, { ok: false, error: PAUSED });
  assert.deepEqual(r.reparent, { ok: false, error: PAUSED });
  assert.equal(r.spawnedByRefused, 0, 'a refusal never (re)starts a session');
  assert.equal(r.stopsByRefused, 0, 'never stop-then-refuse');
  assert.equal(r.toolbar.ok, true);
  assert.ok(r.spawnedByToolbar >= 1, 'the toolbar restart reached sdkRestart');
  assert.equal(r.stillPaused, true);
  assert.equal(r.otherRun.ok, true);
  assert.deepEqual(r.owedCli, { ok: false, error: PAUSED }, 'a kept child owing its brief: `orchestra restart` is refused too');
  assert.equal(r.owedStartsAfterCli, 0);
  assert.equal(r.owedToolbar.ok, true);
  assert.deepEqual(r.owedToolbarStart, [{ origin: 'human', openingBrief: true, text: 'OWED-BRIEF' }], 'the toolbar retry delivers the brief WITH origin human');
  assert.equal(r.ok, true);
});

test('GATE row 17 flush: the TIMER flush is refused BEFORE the queue is cleared; "Send now" (HUMAN) delivers with origin human', () => {
  const r = runArm('flush');
  assert.deepEqual(r.autoFlush, { ok: false, delivered: 0, error: PAUSED });
  assert.equal(r.queueRetained, true, 'the parked prompt is still queued');
  assert.equal(r.startsAfterAuto, 0);
  assert.deepEqual(r.autoFlushOtherRun, { ok: true, delivered: 1 }, 'control: the same flush delivers for an unrelated run');
  assert.deepEqual(r.afterTick, { xmQueue: 0, m1Queue: 1 });
  assert.deepEqual(r.sendNow, { ok: true, delivered: 1 });
  assert.deepEqual(r.sendNowStart, ['human']);
  assert.equal(r.stillPaused, true);
  assert.equal(r.ok, true);
});

test('GATE row 16 usage-limit auto-resume: a limit-killed member of a paused run is NOT resumed and its marker stays (no retry every tick); the lift resumes it', () => {
  const r = runArm('usage_resume');
  assert.equal(r.opsMarker, 'usage_limit');
  assert.deepEqual(r.startsByWs, ['ws-xops'], 'only the unrelated run was resumed (control)');
  assert.equal(r.opsMarkerAfterLift, null);
  assert.deepEqual(r.startsAfterLift, ['ws-xops', 'ws-ops']);
  assert.equal(r.ok, true);
});

test('GATE row 13 migrate: account migration stops/moves/re-pins but does NOT auto-resume a running agent of a paused run', () => {
  const r = runArm('migrate');
  assert.equal(r.pausedMember.resumed, false);
  assert.equal(r.otherRun.resumed, true, 'control: the unrelated run resumes');
  assert.equal(r.launchesAdded, 1, 'exactly one relaunch (the control), none for the paused member');
  assert.deepEqual(r.running, { m1: false, xm: true });
  assert.equal(r.repinned, 'acct-b', 'the migration itself still happened');
  assert.equal(r.ok, true);
});

test('GATE rows 1/2 sdkSend funnel: every AUTO start is refused with NO side effect; HUMAN composer send allowed and un-pauses nothing; a live session does not exempt AUTO', () => {
  const r = runArm('send_funnel');
  assert.equal(r.autoSend, PAUSED);
  assert.equal(r.autoWake, PAUSED);
  assert.equal(r.peerDelivery, 'dropped');
  assert.deepEqual(r.noSideEffects, { factoryCalls: 0, sessionLive: false, turns: 0, errorRows: 0, pending: 0 });
  assert.equal(r.humanSend, true);
  assert.equal(r.humanTurns, 1);
  assert.equal(r.stillPaused, true);
  assert.equal(r.autoSendLive, PAUSED);
  assert.equal(r.briefFollowsHumanCaller, true, 'row 2: the claimed opening brief follows its HUMAN caller (runs first, then the human text)');
  assert.equal(r.otherRun, null);
  assert.equal(r.afterLift, null);
  assert.equal(r.ok, true);
});

test('GATE row 24 drain: a turn queued BEFORE the pause does not drain; a HUMAN turn goes first; the lift drains the rest', () => {
  const r = runArm('drain');
  assert.equal(r.queuedBeforePause, 1);
  assert.equal(r.autoDrainedWhilePaused, false);
  assert.equal(r.queueHeld, 1);
  assert.equal(r.humanYielded, true);
  assert.equal(r.autoStillHeldAfterHuman, true);
  assert.equal(r.autoHeldAfterHumanTurn, true);
  assert.equal(r.stillPaused, true);
  assert.equal(r.drainedAfterLift, true);
  assert.equal(r.ok, true);
});

test('GATE row 4 recover: pending-prompt recovery is HELD and the entries stay durable (not dropped by the recover path); the lift recovers them', () => {
  const r = runArm('recover');
  assert.equal(r.pendingAfterPausedRecover, 1);
  assert.equal(r.spawns, 0);
  assert.equal(r.turns, 0);
  assert.equal(r.recoveredAfterLift, true);
  assert.equal(r.ok, true);
});

test('GATE row 23 redrive: parked inbox mail is NOT re-driven at a turn boundary while paused; the lift re-drives it exactly once', () => {
  const r = runArm('redrive');
  assert.equal(r.parkedWhilePaused, 1);
  assert.equal(r.blockTurnsWhilePaused, 0);
  assert.equal(r.redrivenAfterLift, true);
  assert.equal(r.parkedAfterLift, 0);
  assert.equal(r.ok, true);
});

test('HUMAN row 22 tray (REAL seam): the tray release click delivers into a LIVE session of a paused run; the AUTO release of the same function is dropped', () => {
  const r = runArm('tray');
  assert.equal(r.autoRelease.ok, false);
  assert.equal(r.autoRelease.reason, 'not-delivered');
  assert.equal(r.autoTurns, 0);
  assert.equal(r.humanRelease.ok, true);
  assert.equal(r.humanTurns, 1);
  assert.deepEqual(r.remaining, ['TRAY-AUTO'], 'the refused block stays parked');
  assert.equal(r.stillPaused, true);
  assert.equal(r.ok, true);
});

test('HUMAN rows 17/28 Send now / Fix checks (REAL seam): a human wake reaches a LIVE paused session; the AUTO wake is refused', () => {
  const r = runArm('wake_live');
  assert.equal(r.autoWake, false);
  assert.equal(r.humanWake, true);
  assert.equal(r.humanYielded, true);
  assert.equal(r.autoYielded, false);
  assert.equal(r.stillPaused, true);
  assert.equal(r.ok, true);
});

test('HUMAN row 5 toolbar Restart (REAL seam): a kept child owing its brief starts with origin human the whole way down; `orchestra restart` is refused', () => {
  const r = runArm('restart_real');
  assert.deepEqual(r.cli, { ok: false, error: PAUSED });
  assert.equal(r.spawnsAfterCli, 0);
  assert.equal(r.toolbar.ok, true);
  assert.equal(r.briefYielded, true);
  assert.equal(r.stillPaused, true);
  assert.equal(r.ok, true);
});

test('GATE row 14 roster: the REAL wake sweep over the REAL roster entry never delivers to a paused run (nor its descendants); the lift does', () => {
  const r = runArm('roster');
  assert.deepEqual(r.deliveredWhilePaused, ['ws-xm']);
  assert.deepEqual(r.rosterWakeable, { 'ws-m1': false, 'ws-m3': false, 'ws-xm': true });
  assert.deepEqual(r.deliveredAfterLift, ['ws-m1', 'ws-m3', 'ws-xm']);
  assert.equal(r.ok, true);
});

test('GATE row 26 watchdog recycle/boot-wedge restart: a paused member is never recycled (no stop-then-refuse); the lift lets the same ticks recycle', () => {
  const r = runArm('watchdog_boot');
  assert.equal(r.restartsWhilePaused, 0);
  assert.equal(r.escalationsWhilePaused, 0);
  assert.equal(r.wedgedMarkWhilePaused, null);
  assert.equal(r.sessionStillLive, true);
  assert.ok(r.restartsAfterLift >= 1, 'control: after the lift the watchdog recycles');
  assert.equal(r.ok, true);
});

test('SILENCE row 27 watchdog boot-wedge give-up escalation: none while paused (after the bound is reached); exactly ONE after the lift', () => {
  const r = runArm('watchdog_escalate');
  assert.equal(r.restartsBeforePause, 3);
  assert.equal(r.escalationsBeforePause, 0);
  assert.equal(r.escalationsWhilePaused, 0);
  assert.equal(r.wedgedMarkWhilePaused, null);
  assert.equal(r.escalationsAfterLift, 1);
  assert.equal(r.ok, true);
});

test('GATE row 25 watchdog stranded-gate release: the gate of a paused member is NOT released (parked turn does not start); the lift releases it', () => {
  const r = runArm('watchdog_gate');
  assert.equal(r.gateHeldWhilePaused, true);
  assert.equal(r.sameTurnWhilePaused, true);
  assert.equal(r.queuedStarted, false);
  assert.equal(r.queuedStartedAfterLift, true);
  assert.equal(r.ok, true);
});

test('SWITCH OFF ⇒ byte-identical: with the frozen `pause` switch OFF nothing is gated (even with a forced paused_at column) — spawn/message/wake/restart/roster/effective set', () => {
  const r = runArm('off_identity');
  assert.equal(r.pauseResult, 'switch-off');
  assert.deepEqual(r.results, { spawn: true, msg: 'started', wake: true, restartRefusal: false, wakeable: true, effectivePaused: [] });
  assert.equal(r.ok, true);
});
