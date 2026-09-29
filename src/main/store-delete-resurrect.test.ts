import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// #205 — a deleted workspace must never be re-inserted by a stale read-modify-write.
// The real store + real callers run in a SUBPROCESS (scripts/e2e-delete-resurrect.mjs) because
// they need the module-resolution hook (`./platform` directory import, extensionless specifiers).
// Every ★ arm below reddened on unfixed master (rig output in ledger #224).

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const RIG = path.join(REPO, 'scripts', 'e2e-delete-resurrect.mjs');
const REGISTER = path.join(REPO, 'scripts', '.r2-register.mjs');
// btrfs under the real home, not /tmp; per-process so concurrent suites never share an arm dir.
const E2E_HOME = path.join(os.homedir(), '.cache', `e2e-delete-resurrect-unit-${process.pid}`);

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

test('★ a stale upsert after removeWorkspace does not re-insert (memory AND store.json)', () => {
  const r = runArm('store_stale_upsert');
  assert.equal(r.preAbsent, true, 'control: the delete itself removed A from memory and disk');
  assert.equal(r.presentAfter, false, 'A must stay absent in memory');
  assert.equal(r.onDiskAfter, false, 'A must stay absent on disk');
  assert.equal(r.ok, true);
});

test('★ the bulk delete path (removeWorkspaces) tombstones every id', () => {
  const r = runArm('bulk_remove');
  assert.equal(r.preAbsent, true);
  assert.deepEqual([r.presentA, r.presentB, r.onDiskA, r.onDiskB], [false, false, false, false]);
  assert.equal(r.ok, true);
});

test('★ clearBusRunStale (get → await rm → upsert stale) cannot resurrect a workspace deleted mid-await', () => {
  const r = runArm('stale_marker');
  assert.equal(r.presentAfter, false);
  assert.equal(r.onDiskAfter, false);
  assert.equal(r.ok, true);
});

test('★ syncWorkspaceGateCounts (loop of awaited upserts over an array snapshot) skips a workspace deleted mid-loop, still updates the rest', () => {
  const r = runArm('gate_counts');
  assert.equal(r.presentB, false, 'B was deleted mid-loop and must stay gone');
  assert.equal(r.onDiskB, false);
  assert.equal(r.countA, 1, 'A (before the delete) still updated');
  assert.equal(r.countC, 1, 'C (after the delete) still updated — the fix must not abort the loop');
  assert.equal(r.ok, true);
});

test('★ the hibernation sweep skips a workspace whose delete has begun (no stop, no hibernatedAt)', () => {
  const r = runArm('sweep_serial');
  assert.deepEqual(r.stops, [], 'the session stop must not fire for a workspace being deleted');
  assert.deepEqual(r.hibernated, []);
  assert.equal(r.hibernatedAt, null);
  assert.equal(r.ok, true);
});

test('★ delete beginning DURING the sweep\'s stop: no hibernatedAt is stamped on the record being torn down', () => {
  const r = runArm('sweep_delete_begins_midstop');
  assert.deepEqual(r.stops, ['A'], 'control: the stop had already started when the delete began');
  assert.deepEqual(r.hibernated, []);
  assert.equal(r.hibernatedAt, null);
  assert.equal(r.present, true, 'the record is still present — only the stamp is refused');
  assert.equal(r.ok, true);
});

test('★ wakeAgentWithPrompt (get → await sdkStartAndDeliver → upsert stale) cannot resurrect a workspace deleted mid-start', () => {
  const r = runArm('wake_stale');
  assert.equal(r.woke, true, 'control: the wake itself completed');
  assert.equal(r.presentAfter, false);
  assert.equal(r.onDiskAfter, false);
  assert.equal(r.ok, true);
});

test('★ the REAL deleteWorkspace teardown marks the id so a concurrent REAL sweep does not stop it (pins forgetHibernationActivity in teardownWorkspace)', () => {
  const r = runArm('real_delete_vs_sweep');
  assert.deepEqual(r.pre, { present: true, dirExists: true }, 'control: a real scratch workspace with a real dir');
  assert.deepEqual(r.stops, [], 'the sweep must not stop a workspace whose delete is in flight');
  assert.deepEqual(r.swept, []);
  assert.equal(r.presentAfter, false);
  assert.equal(r.onDiskAfter, false);
  assert.equal(r.dirGone, true, 'the delete really ran to completion');
  assert.equal(r.ok, true);
});

test('★ a stale upsert issued DURING removeWorkspace(s)\'s save await is dropped (tombstone is set before the save, both paths)', () => {
  const r = runArm('stale_during_save') as { bulk: Record<string, boolean>; single: Record<string, boolean>; ok: boolean };
  assert.equal(r.bulk.bulkSyncRan, true, 'control: the bulk removal\'s sync part ran before the stale upsert');
  assert.equal(r.single.singleSyncRan, true, 'control: same for the single removal');
  assert.deepEqual([r.bulk.presentAfter, r.bulk.onDisk], [false, false], 'bulk path');
  assert.deepEqual([r.single.presentAfter, r.single.onDisk], [false, false], 'single path');
  assert.equal(r.ok, true);
});

test('MUST-PASS: a never-removed id still inserts and updates in place; a removed id does not block another', () => {
  const r = runArm('fresh_insert');
  assert.equal(r.insertedMem, true);
  assert.equal(r.insertedDisk, true);
  assert.equal(r.updated, true);
  assert.equal(r.copies, 1);
  assert.equal(r.aStillGone, true);
  assert.equal(r.ok, true);
});

test('MUST-PASS: the real createScratchWorkspace insert still lands (spawn path)', () => {
  const r = runArm('spawn_insert');
  assert.equal(r.presentAfter, true);
  assert.equal(r.onDiskAfter, true);
  assert.equal(r.ok, true);
});

test('CONTROL: persistWorkspacePatch (sdkSetModel) is not a racer — get→upsert has no await between (ticket hypothesis refuted)', () => {
  const r = runArm('patch_control');
  assert.equal(r.patched, true, 'control: the patch path really writes on a live workspace');
  assert.equal(r.afterMid, false, 'delete right behind a patch: workspace stays gone');
  assert.equal(r.afterLate, false, 'patch after the delete: workspace stays gone');
  assert.equal(r.ok, true);
});

test('CONTROL: the sweep\'s own post-stop write is guarded — a delete landing mid-stop leaves the workspace gone', () => {
  const r = runArm('sweep_delete_midstop');
  assert.deepEqual(r.control, ['A'], 'control: with no delete the rig hibernates the record');
  assert.equal(r.controlStamped, true);
  assert.deepEqual(r.stops, ['A'], 'the stop really ran (the delete landed DURING it)');
  assert.equal(r.presentAfter, false);
  assert.equal(r.onDiskAfter, false);
  assert.equal(r.ok, true);
});
