import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// #384 — the REAL renameWorkspaceBranch (real git worktrees, real store.json) records `formerBranch`; a FRESH process
// reloads it. The rig runs in a subprocess (module-resolution hook, see e2e-delete-resurrect.mjs / store-delete-resurrect.test.ts).
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const RIG = path.join(REPO, 'scripts', 'e2e-former-branch.mjs');
const REGISTER = path.join(REPO, 'scripts', '.r2-register.mjs');
// btrfs under the real home, not /tmp; per-process so concurrent suites never share a dir.
const E2E_HOME = path.join(os.homedir(), '.cache', `e2e-former-branch-unit-${process.pid}`);

type Case = { formerBranch?: string; branch: string; disk?: string; live?: string; broadcastFormer?: string; pinned?: boolean };
function runArm(arm: string): { arm: string; ok: boolean; cases?: Record<string, Case>; peers?: Record<string, { formerBranch?: string; hasKey: boolean }> } & Record<string, unknown> {
  let out = '';
  try {
    out = execFileSync(process.execPath, ['--experimental-strip-types', '--no-warnings', '--import', REGISTER, RIG, arm], {
      encoding: 'utf8', timeout: 120_000, cwd: REPO, env: { ...process.env, E2E_HOME }, stdio: ['ignore', 'pipe', 'inherit'],
    });
  } catch (e) {
    out = (e as { stdout?: string }).stdout ?? '';
  }
  const line = out.trim().split('\n').filter(Boolean).pop();
  assert.ok(line, `arm ${arm} produced no output — the rig did not run`);
  const r = JSON.parse(line) as { arm: string; ok: boolean };
  assert.equal(r.arm, arm, 'the rig ran the arm that was asked for');
  return r as ReturnType<typeof runArm>;
}

test.after(() => fs.rmSync(E2E_HOME, { recursive: true, force: true }));

test('the rig and its register hook exist', () => {
  assert.ok(fs.existsSync(RIG), `${RIG} missing`);
  assert.ok(fs.existsSync(REGISTER), `${REGISTER} missing`);
});

test('rename-records-former table (real renameWorkspaceBranch, real worktrees)', () => {
  const r = runArm('table');
  const c = r.cases!;
  // positive controls: the renames really happened (git HEAD moved) — a table of undefined == undefined would pass vacuously
  assert.equal(c.first.live, 'impl-x-1', 'control: git HEAD was really renamed');
  assert.equal(c.drifted.live, 'impl-d-1');
  // parent-named: first rename records the previous name; the broadcast and store.json carry it
  assert.equal(c.first.formerBranch, 'lucky-willow');
  assert.equal(c.first.broadcastFormer, 'lucky-willow', 'workspace:update carries the field');
  assert.equal(c.first.disk, 'lucky-willow', 'store.json carries the field');
  // a later rename REPLACES it with the latest previous name
  assert.equal(c.second.formerBranch, 'impl-x-1');
  assert.equal(c.second.disk, 'impl-x-1');
  // a same-name no-op (auto or human) does not touch it
  assert.equal(c.same_name.formerBranch, 'impl-x-1');
  assert.equal(c.same_name_human.formerBranch, 'impl-x-1');
  // a human rename of a parent-named workspace records too
  assert.equal(c.human_rename.formerBranch, 'impl-x-2');
  // a human-created workspace's provisional self-renames (and a UI rename) record NOTHING
  for (const k of ['human_created_1', 'human_created_2', 'human_created_ui']) {
    assert.equal(c[k].formerBranch, undefined, `${k}: no ex- noise on a human-created workspace`);
    assert.equal(c[k].disk, undefined);
  }
  // unnamed before, parent-named AFTER (the rename pins it) records
  assert.equal(c.pin_on_rename.formerBranch, 'calm-otter');
  // scratch-like relabel path
  assert.equal(c.scratch_named.formerBranch, 'lab-S1');
  assert.equal(c.scratch_human.formerBranch, undefined);
  assert.equal(c.scratch_same.formerBranch, 'lab-S1', 'scratch same-name no-op leaves it');
  // the stored branch had drifted: the recorded former is the LIVE branch the rename started from
  assert.equal(c.drifted.formerBranch, 'really-live');
  // drift ADOPTION (requested == live, stored stale): the record's name changed stored→live and is recorded
  assert.equal(c.drift_adopt.live, 'e-live', 'control: the out-of-band rename really happened');
  assert.equal(c.drift_adopt.branch, 'e-live');
  assert.equal(c.drift_adopt.formerBranch, 'e-old');
  // the out-of-band reconciler (detectAndUpdateBranchName): parent-named records, human-created does not; both really adopted the new name + pinned
  assert.equal(c.oob_named.branch, 'f-new', 'control: the reconciler adopted the out-of-band name');
  assert.equal(c.oob_human.branch, 'g-new');
  assert.equal(c.oob_named.formerBranch, 'f-old');
  assert.equal(c.oob_named.disk, 'f-old');
  assert.equal(c.oob_human.formerBranch, undefined, 'no ex- noise on a human-created workspace');
  // the real /peers payload (dispatchPeersRequest): renamed ⇒ carries the former name; never renamed ⇒ no key at all
  const p = r.peers!;
  assert.equal(p.A.formerBranch, 'impl-x-2', 'control: A was renamed three times — the payload carries the LATEST previous name');
  assert.equal(p.D.formerBranch, 'really-live');
  assert.equal(p.H.hasKey, false, 'a human-created workspace has no formerBranch key in /peers');
  assert.equal(p.U.formerBranch, 'calm-otter');
  assert.equal(r.ok, true);
});

test('formerBranch survives a restart: written by one process, store.load() in a FRESH one reads it back', () => {
  const w = runArm('persist_write');
  assert.equal(w.formerBranch, 'lucky-willow');
  assert.equal(w.onDisk, 'lucky-willow');
  const r = runArm('persist_read');
  assert.equal(r.loadedFromDisk, true, 'control: the second process loaded an existing store.json, not an empty default');
  assert.equal(r.found, true);
  assert.equal(r.branch, 'impl-persist-1');
  assert.equal(r.formerBranch, 'lucky-willow');
  assert.equal(r.ok, true);
});
