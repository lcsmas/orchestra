import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// #227 — a failed SDK start is REPORTED, never masked by a PTY. The REAL spawn/wake/message/restart code + store run in a
// SUBPROCESS (scripts/e2e-spawn-failure.mjs: needs the resolution hook) over a fake SDK seam; a stub `claude` on PATH records any
// PTY launch. Every ★ arm printed ok:false on the pre-change tree (ledger #234).

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const RIG = path.join(REPO, 'scripts', 'e2e-spawn-failure.mjs');
const REGISTER = path.join(REPO, 'scripts', '.r2-register.mjs');
// btrfs under the real home, not /tmp; per-process so concurrent suites never share an arm dir.
const E2E_HOME = path.join(os.homedir(), '.cache', `e2e-spawn-failure-unit-${process.pid}`);

function runArm(arm: string): Record<string, unknown> & { ok: boolean } {
  const out = execFileSync(
    process.execPath,
    ['--experimental-strip-types', '--no-warnings', '--import', REGISTER, RIG, arm],
    { encoding: 'utf8', timeout: 120_000, cwd: REPO, env: { ...process.env, E2E_HOME }, stdio: ['ignore', 'pipe', 'ignore'] },
  );
  const line = out.trim().split('\n').filter(Boolean).pop();
  // A rig that crashed prints nothing — that must fail loudly, never read as a pass.
  assert.ok(line, `arm ${arm} produced no output — the rig did not run`);
  const r = JSON.parse(line) as Record<string, unknown> & { ok: boolean; arm: string };
  assert.equal(r.arm, arm, 'the rig ran the arm that was asked for');
  return r;
}

test.after(() => fs.rmSync(E2E_HOME, { recursive: true, force: true }));

test('the rig and its register hook exist', () => {
  assert.ok(fs.existsSync(RIG), `${RIG} missing`);
  assert.ok(fs.existsSync(REGISTER), `${REGISTER} missing`);
});

test('★ spawn: a start that fails returns not-ok naming the reason + the child, KEEPS the child with its task, and runs no PTY', () => {
  const r = runArm('spawn_start_fails');
  const res = r.res as { ok: boolean; id?: string; error?: string };
  assert.equal(res.ok, false, 'spawn must not answer ok for a child that never started');
  assert.match(res.error ?? '', /INJECTED-SDK-START-FAILURE-91c4/, "the SDK start failure's own message is surfaced");
  assert.match(res.error ?? '', /failed to start/);
  assert.ok(res.id && (res.error ?? '').includes(res.id), 'the error names the kept child so its caller can restart it');
  assert.equal(r.kept, true, 'no rollback: the workspace stays');
  assert.equal(r.lastTask, 'E2E-TASK-0b7e opening brief', 'the task is retained');
  assert.notEqual(r.hasInput, true, 'hasInput stays unset: the task is still owed');
  assert.equal(r.starts, 1, 'exactly one SDK start attempt');
  assert.equal(r.noPty, true, 'no PTY agent and the stub claude was never launched');
  assert.equal(r.ok, true);
});

test('must-PASS control: a start that works answers ok, delivers the task once, flips hasInput, runs no PTY', () => {
  const r = runArm('spawn_start_ok');
  assert.equal((r.res as { ok: boolean }).ok, true);
  assert.equal(r.starts, 1);
  assert.equal(r.hasInput, true);
  assert.equal(r.noPty, true);
  assert.equal(r.ok, true);
});

test('★ wake: an unstartable stopped workspace → wakeAgentWithPrompt false (no PTY); a message lands in the inbox', () => {
  const r = runArm('wake_start_fails');
  assert.equal(r.woke, false, 'wake reports it could not start — callers fall back (inbox / re-queue)');
  assert.deepEqual({ ok: (r.msg as { ok: boolean }).ok, delivery: (r.msg as { delivery: string }).delivery }, { ok: true, delivery: 'inbox' });
  assert.equal(r.inboxHasText, true, 'the message text is on disk in the target\'s inbox file');
  assert.equal(r.starts, 2, 'the wake and the message wake each tried the SDK once');
  assert.equal(r.noPty, true);
  assert.equal(r.ok, true);
});

test('★ restart: still failing → reported not-ok (task still owed); cause removed → ok, the task delivered ONCE, hasInput set', () => {
  const r = runArm('restart_retries');
  const still = r.still as { ok: boolean; error?: string };
  assert.equal(still.ok, false);
  assert.match(still.error ?? '', /^restart failed: .*INJECTED-SDK-START-FAILURE-91c4/);
  assert.equal(r.hasInputAfterFail === true, false, 'a failed retry does not mark the task delivered');
  assert.deepEqual(r.fixed, { ok: true, mode: 'structured', fresh: false, openingTask: true });
  assert.equal(r.delivered, 1, 'exactly one start took the brief');
  assert.equal(r.hasInputAfterOk, true);
  assert.equal(r.noPty, true);
  assert.equal(r.ok, true);
});

test('★ restart is single-flight and exactly-once: two concurrent Restarts → one delivery; a later call delivers nothing', () => {
  const r = runArm('restart_single_flight');
  assert.equal(r.afterConcurrent, 1, 'both Restarts landed during one in-flight start — the brief is queued once');
  assert.equal(r.afterThird, 1, 'once delivered (hasInput), a further retry starts nothing');
  assert.equal(r.hasInput, true);
  assert.equal(r.ok, true);
});

test('★ F4: a ticket whose spawn fails to start is graduated to the kept child (error reported); a retry finds it — no duplicate child', () => {
  const r = runArm('ticket_spawn_failure');
  const first = r.first as { ok: boolean; error?: string; workspaceId?: string };
  assert.equal(first.ok, false);
  assert.match(first.error ?? '', /failed to start/);
  assert.equal(r.graduatedTo, first.workspaceId, 'the ticket leaves the queue for the kept workspace');
  assert.equal(r.workspaces, 1, 'the retry did not create a second child');
  assert.match((r.retry as { error?: string }).error ?? '', /already has a workspace/);
  assert.equal(r.ok, true);
});
