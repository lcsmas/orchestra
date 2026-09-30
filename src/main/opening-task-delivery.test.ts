import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// #227 fix rounds 1-2 — the retained opening task (F2), the persisted start error (F3), spawn's bounded wait (F1 / D6) and the FIRST-TURN
// outcome (D7: init proves life, not delivery — an errored first turn, the measured real shape, is a failed start).
// The REAL sdkSend / consume / sdkHistory / spawn code + store run in a SUBPROCESS (scripts/e2e-opening-task.mjs: needs the
// resolution hook) over a FAKE CLI. Every ★ arm printed ok:false on the pre-fix tip 220d5d3d; the D7 arms (firstturn_error, init_only_not_delivery, slow_init_note) on 4f8b0488.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const RIG = path.join(REPO, 'scripts', 'e2e-opening-task.mjs');
const REGISTER = path.join(REPO, 'scripts', '.r2-register.mjs');
const E2E_HOME = path.join(os.homedir(), '.cache', `e2e-opening-task-unit-${process.pid}`);

function runArm(arm: string): Record<string, unknown> & { ok: boolean } {
  const out = execFileSync(
    process.execPath,
    ['--experimental-strip-types', '--no-warnings', '--import', REGISTER, RIG, arm],
    { encoding: 'utf8', timeout: 120_000, cwd: REPO, env: { ...process.env, E2E_HOME }, stdio: ['ignore', 'pipe', 'ignore'] },
  );
  const line = out.trim().split('\n').filter(Boolean).pop();
  assert.ok(line, `arm ${arm} produced no output — the rig did not run`);
  const r = JSON.parse(line) as Record<string, unknown> & { ok: boolean; arm: string };
  assert.equal(r.arm, arm, 'the rig ran the arm that was asked for');
  return r;
}

test.after(() => fs.rmSync(E2E_HOME, { recursive: true, force: true }));

test('the rig exists', () => assert.ok(fs.existsSync(RIG), `${RIG} missing`));

test('★ F2 wake: a kept child woken by a peer message receives its brief FIRST, once, then the message; the marker lands at the first output', () => {
  const r = runArm('wake_brief_first');
  assert.deepEqual(r.delivered, ['E2E-BRIEF-4d21 opening task', 'PEER-MSG']);
  assert.equal(r.briefs, 1, 'a later Restart-style retry delivers nothing more');
  assert.equal(r.marked, true);
  assert.equal(r.ok, true);
});

test('★ F2 composer: the first typed send starts the child with its brief ahead of the typed text', () => {
  const r = runArm('composer_brief_first');
  assert.deepEqual(r.all, ['E2E-BRIEF-4d21 opening task', 'TYPED-BY-USER', 'TYPED-AGAIN']);
  assert.equal(r.briefs, 1);
  assert.equal(r.ok, true);
});

test('spawn: the spawn send IS the brief — received once (the chokepoint adds no second copy), marker + hasInput set', () => {
  const r = runArm('spawn_brief_once');
  assert.deepEqual(r.delivered, ['E2E-BRIEF-4d21 opening task']);
  assert.equal(r.marked, true);
  assert.equal(r.ok, true);
});

test('★ F1/D6 + F3: a CLI that dies before its first message → not-ok naming the exit and the model; brief unwound, error persisted + re-rendered, the retry delivers ONCE', () => {
  const r = runArm('preinit_death');
  const res = r.res as { ok: boolean; error?: string };
  assert.equal(res.ok, false);
  assert.match(res.error ?? '', /exited before its first turn produced output.*exited with code 1.*e2e-bad-model/);
  assert.equal(r.pending, 0, 'the queued brief was dropped from the pending-prompt insurance (no duplicate on the next view open)');
  assert.equal(r.owes, true, 'the brief is owed again');
  assert.equal(r.persisted, 1);
  assert.deepEqual(r.historyErrors, ['Claude Code process exited with code 1']);
  assert.deepEqual(r.deliveredAfterRestart, ['E2E-BRIEF-4d21 opening task']);
  assert.equal(r.ok, true);
});

test('★ D7: the measured REAL failure shape (init → assistant error + result is_error → exit 1) is not-ok naming the error; brief still owed, ONE error row; Restart delivers ONCE', () => {
  const r = runArm('firstturn_error');
  const res = r.res as { ok: boolean; error?: string };
  assert.equal(res.ok, false, 'init alone must not read as a successful start');
  assert.match(res.error ?? '', /first turn failed: Not logged in · Please run \/login \(model: e2e-bad-model\)/);
  assert.equal(r.pending, 0, 'the errored turn left no stale pending-prompt copy of the brief');
  assert.equal(r.owes, true, 'the brief is owed again (marker unset, the init-persisted session id cleared)');
  assert.equal(r.persisted, 1);
  assert.deepEqual(r.historyErrors, ['Not logged in · Please run /login'], 'ONE error row — the CLI exit that follows the errored result adds none');
  assert.deepEqual(r.deliveredAfterRestart, ['E2E-BRIEF-4d21 opening task']);
  assert.equal(r.ok, true);
});

test('★ D7: an errored first turn that leaves the CLI ALIVE still fails the start — spawn stops the half-running session (child kept STOPPED); Restart delivers ONCE', () => {
  const r = runArm('firstturn_error_live');
  assert.equal((r.res as { ok: boolean }).ok, false);
  assert.equal(r.stopped, true, 'no live session is left behind a failed spawn');
  assert.equal(r.owes, true);
  assert.deepEqual(r.deliveredAfterRestart, ['E2E-BRIEF-4d21 opening task']);
  assert.equal(r.ok, true);
});

test('★ F2 (r3): a wake whose first turn errors with the CLI ALIVE and no waiter → the session is STOPPED (child kept stopped), the brief stays owed; the next send starts a fresh session that carries it', () => {
  const r = runArm('errored_turn_then_message');
  const s1 = r.s1 as { marked?: boolean; hasInput?: boolean; sid?: string; owes: boolean; errs: number; histErrs: number };
  assert.equal(r.stopped, true, 'no live session is left behind an errored first turn');
  assert.notEqual(s1.marked, true, 'the errored attempt did not deliver');
  assert.equal(s1.owes, true);
  assert.equal(s1.sid, undefined, 'the init-persisted session id was cleared at the failure');
  assert.equal(s1.errs, 1);
  assert.equal(r.marked, true);
  assert.deepEqual(r.d2, ['E2E-BRIEF-4d21 opening task', 'TYPED-AFTER'], 'the fresh session gets the brief FIRST, then the typed text');
  assert.equal(r.ok, true);
});

test('★ F2 (r3): a waiter HOLDS the errored live session (no stop) → Restart still takes the owed route, delivers ONCE on that live session and restores the resume id', () => {
  const r = runArm('held_errored_then_restart');
  assert.equal((r.held as { state: string }).state, 'failed');
  assert.equal(r.live1, true, 'control: the session really is live + errored (a held session is not stopped)');
  assert.equal((r.restarted as { openingTask?: boolean }).openingTask, true);
  assert.equal(r.sid, 'fake-1', 'the resume id is restored when the re-claimed brief delivers');
  assert.equal(r.ok, true);
});

test('★ F2 (r3): a first-turn failure AFTER the bound (ok + note, then the error lands with nobody waiting) stops the session; Restart delivers the brief ONCE', () => {
  const r = runArm('late_error_live_restart');
  assert.equal(r.stopped, true);
  assert.equal(r.owes1, true);
  assert.deepEqual(r.delivered, ['E2E-BRIEF-4d21 opening task']);
  assert.equal(r.ok, true);
});

test('★ F1 (r3, BLOCKING regression): a LIVE silent spawned child (ok + note) then Restart → the brief reaches a healthy CLI exactly ONCE (an intentional end keeps the pending copy)', () => {
  const r = runArm('x_restart_silent_live');
  assert.equal(r.live0, true, 'control: the session is live when Restart runs');
  assert.deepEqual(r.delivered, ['E2E-BRIEF-4d21 opening task']);
  assert.equal(r.ok, true);
});

test('★ F1 (r3, BLOCKING regression): the same through the boot-wedge recycle (`recycleSession`)', () => {
  const r = runArm('x_recycle_wedged_spawn');
  assert.equal(r.live0, true);
  assert.deepEqual(r.delivered, ['E2E-BRIEF-4d21 opening task']);
  assert.equal(r.ok, true);
});

for (const arm of ['x_interrupt_apiretry', 'x_stop_apiretry_live']) {
  test(`★ F3 (r3): ${arm} — an interrupted / stopped first turn (aborted result) is NOT a failed start: no error row, the session id kept, the roster untouched`, () => {
    const r = runArm(arm);
    assert.deepEqual(r.errs, []);
    assert.ok(r.sid0, 'control: init persisted a session id');
    assert.equal(r.sid, r.sid0, 'the session id is not wiped');
    assert.equal(r.keepsFailing, false);
    assert.equal(r.ok, true);
  });
}

test('★ r4 F1: after an intentional stop (pending copy kept) a wake claim and the view-open recovery race → the brief reaches the CLI exactly ONCE', () => {
  const r = runArm('recover_races_claim');
  assert.equal(r.pendingKept, true, 'control: the stopped session left the brief\'s pending copy behind');
  assert.equal((r.d as string[]).filter((t) => t === 'E2E-BRIEF-4d21 opening task').length, 1);
  assert.equal(r.ok, true);
});

test('★ r4 F2: a first start failed, a composer send starts a HUNG second start → Restart replaces it (fresh session with the brief then the composer text)', () => {
  const r = runArm('restart_wedged_second_start');
  assert.equal(r.errs1, 1, 'control: a stale persisted start error is present');
  assert.equal(r.s2live, true, 'control: the hung second start is live when Restart runs');
  assert.deepEqual(r.d, ['E2E-BRIEF-4d21 opening task', 'composer hello']);
  assert.equal(r.ok, true);
});

test('★ F5 (r3): a USER message equal to the in-flight brief is sent (echoed), never swallowed', () => {
  const r = runArm('swallow_same_text');
  assert.equal((r.echoes as string[]).length, 3, 'the brief + the two identical user messages');
  assert.equal(r.ok, true);
});

test('★ F1: silent past the bound (ok + note) and THEN the CLI dies before any output → the brief is STILL owed (the timeout never retired it); Restart delivers ONCE', () => {
  const r = runArm('slow_then_die');
  const at = r.at as { hasInput?: boolean; marked?: boolean; owes: boolean };
  assert.notEqual(at.hasInput, true, 'a start nothing confirmed does not mark the brief delivered');
  assert.equal(at.owes, true);
  assert.equal(r.owesAfterDeath, true);
  assert.deepEqual(r.delivered, ['E2E-BRIEF-4d21 opening task']);
  assert.equal(r.ok, true);
});

test('★ F2: a composer send and Restart in the SAME tick (either order) → the CLI receives the brief exactly ONCE, first', () => {
  const r = runArm('race_restart_vs_composer');
  for (const k of ['dA', 'dB'] as const) {
    const d = r[k] as string[];
    assert.equal(d.filter((t) => t === 'E2E-BRIEF-4d21 opening task').length, 1, `${k}: ${JSON.stringify(d)}`);
    assert.equal(d[0], 'E2E-BRIEF-4d21 opening task', `${k}: the brief is first`);
  }
  assert.equal(r.ok, true);
});

test('★ F5: wake + two composer sends in one tick → the brief is the CLI\'s FIRST message, once', () => {
  const r = runArm('brief_first_under_concurrency');
  const d = r.d as string[];
  assert.equal(d[0], 'E2E-BRIEF-4d21 opening task');
  assert.equal(d.length, 4);
  assert.equal(r.ok, true);
});

test('★ F6: a CLI that speaks before any send (keeper reattach) is owed nothing — the first send is NOT preceded by the brief', () => {
  const r = runArm('attach_then_send');
  assert.deepEqual(r.d, ['USER-TEXT']);
  assert.equal(r.ok, true);
});

test('★ F7: once a healthy session produces output, the transient start error that predates it is gone (store AND history)', () => {
  const r = runArm('preinit_death');
  assert.equal(r.staleErrorsCleared, true);
  assert.equal(r.histErrorsAfter, 0);
  assert.equal(r.ok, true);
});

test('★ F8: Restart of a silent-CLI kept child carries the not-confirmed note', () => {
  const r = runArm('restart_note');
  assert.match((r.restarted as { note?: string }).note ?? '', /^first turn not confirmed within \d+ s — started, not confirmed$/);
  assert.equal(r.ok, true);
});

test('★ F9b: a stopped predecessor\'s LATE death does not overwrite the successor session\'s first-turn outcome', () => {
  const r = runArm('settle_identity');
  assert.equal((r.before as { state: string }).state, 'ok');
  assert.equal((r.after as { state: string }).state, 'ok', 'the late failed settle of the predecessor must be dropped');
  assert.equal(r.ok, true);
});

test('★ verifier2 F-B: persisted start errors interleave into a history that HAS a transcript (before / after its rows, by `at`)', () => {
  const r = runArm('history_with_transcript');
  const ix = r.ix as { before: number; user: number; asst: number; after: number };
  assert.ok(ix.user >= 0 && ix.asst > ix.user, 'control: the transcript rows are present and ordered');
  assert.ok(ix.before >= 0 && ix.before < ix.user, 'the older start error precedes the transcript rows');
  assert.ok(ix.after > ix.asst, 'the newer start error follows them');
  assert.equal(r.ok, true);
});

test('★ F9a: the stale-brief drop runs through the serialized pending-prompt chain — a concurrent append survives', () => {
  const r = runArm('drop_vs_append_race');
  assert.deepEqual(r.left, ['CONCURRENT-APPEND']);
  assert.equal(r.ok, true);
});

test('★ D7: init alone is NOT delivery — the marker lands only when the first non-error output arrives', () => {
  const r = runArm('init_only_not_delivery');
  const before = r.beforeOut as { sid?: string; marked?: boolean; hasInput?: boolean };
  assert.ok(before.sid, 'control: the CLI did init (the session id was persisted)');
  assert.notEqual(before.marked, true, 'no delivered marker at init');
  assert.notEqual(before.hasInput, true);
  assert.equal(r.marked, true, 'the first output delivers it');
  assert.equal(r.ok, true);
});

test('★ F2 × F1: a wake that starts a kept child whose CLI dies before init does NOT retire the brief; the Restart that follows delivers it once', () => {
  const r = runArm('wake_preinit_death');
  assert.equal(r.woke, true);
  assert.notEqual(r.hasInput, true, 'hasInput stays unset while the brief is owed (the wake must not flip it)');
  assert.equal(r.stillOwed, true);
  assert.equal(r.pendingBriefs, 0, 'the unwound brief left no stale pending-prompt entry');
  assert.deepEqual(r.delivered, ['E2E-BRIEF-4d21 opening task']);
  assert.equal(r.ok, true);
});

test('★ F2: a stale pending-prompt copy of the brief is dropped at the claim, so the view-open recovery cannot resend it', () => {
  const r = runArm('stale_pending_brief');
  assert.equal(r.pendingBriefs, 1, 'only the live brief is pending — a surviving stale copy would be re-queued by the recovery (2)');
  assert.equal(r.ok, true);
});

test('★ F1/D6/D7: a silent CLI is ok WITH the not-confirmed note only after the bound (brief NOT marked, marked when the output lands); a CLI that answers returns at once, no note', () => {
  const r = runArm('slow_init_note');
  assert.match((r.slow as { note?: string }).note ?? '', /^first turn not confirmed within 1 s — started, not confirmed$/);
  assert.ok((r.slowMs as number) >= 650, `the wait ran to the bound (${r.slowMs} ms)`);
  assert.equal((r.fast as { note?: string }).note, undefined);
  assert.ok((r.fastMs as number) < 500, `a first output returns at once (${r.fastMs} ms)`);
  assert.equal(r.slowUnmarked, true, 'not confirmed is not delivered');
  assert.equal(r.lateMarked, true, 'the output that finally lands delivers the brief');
  assert.equal(r.ok, true);
});

test('★ F3: an ensureSession failure is persisted (capped at 5) and sdkHistory returns the rows with NO transcript on disk', () => {
  const r = runArm('start_error_persisted');
  assert.equal(r.persisted, 5);
  assert.equal(r.history, 5);
  assert.equal(r.first, "Couldn't start the agent: INJECTED-CONSTRUCT-FAILURE");
  assert.equal(r.ok, true);
});
