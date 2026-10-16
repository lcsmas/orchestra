import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// #382 follow-up (review m3 + verifier F2) — an agent's spawn NAME under concurrency and exhaustion, driven through the REAL
// workspaces.ts / store / git (scripts/e2e-spawn-name-race.mjs, one arm per SUBPROCESS, same pattern as pause-gates.test.ts).
//  · race: N parallel spawns of ONE name all succeed with distinct names (story 11: a collision must never fail the spawn).
//    Unfixed (integration tip 4036a475) the same arm reads: 1 ok + 4 raw `fatal: a branch named … already exists`.
//  · exhausted: the name AND -2…-99 taken ⇒ the agent route REFUSES (nothing created) instead of silently spawning on a random branch
//    with `namedByParent` set; `-99` still free ⇒ ok; a HUMAN path (no exactName) keeps today's random fallback.
//  · alias: one repo registered under two spellings (symlink) is still ONE repo for the lock (keyed on the real path).
//  · folder: a branch `impl-z/sub` makes `impl-z` impossible for git ⇒ the agent route suffixes (`impl-z-2`) instead of failing.
//  · released: a spawn whose checkout FAILS releases its reserved name (the next spawn gets the bare name, not `-2`).
// The must-FAIL arm of each clause is the in-place mutant in scripts/spawn-name-mutants.mjs (lock removed / exactName dropped).

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const RIG = path.join(REPO, 'scripts', 'e2e-spawn-name-race.mjs');
const REGISTER = path.join(REPO, 'scripts', '.r2-register.mjs');
const RIG_HOME = path.join(os.homedir(), '.cache', `e2e-spawn-name-race-unit-${process.pid}`);

type R = Record<string, any> & { ok: boolean; arm: string };

function runArm(arm: string): R {
  let stdout = '';
  try {
    stdout = execFileSync(process.execPath, ['--experimental-strip-types', '--no-warnings', '--import', REGISTER, RIG, arm], {
      encoding: 'utf8', timeout: 170_000, cwd: REPO, env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: os.homedir(), SPAWN_RACE_HOME: RIG_HOME }, stdio: ['ignore', 'pipe', 'ignore'],
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

test.after(() => fs.rmSync(RIG_HOME, { recursive: true, force: true }));

test('the rig + its register hook exist', () => {
  assert.ok(fs.existsSync(RIG) && fs.existsSync(REGISTER));
});

test('race: 5 PARALLEL spawns of one name all succeed with distinct suffixed names; the git branches and records exist, nothing half-created', () => {
  const r = runArm('race');
  assert.deepEqual(r.results.map((x: { ok: boolean }) => x.ok), [true, true, true, true, true], JSON.stringify(r.results));
  assert.equal(r.allOk, true);
  assert.deepEqual(r.got, ['impl-race', 'impl-race-2', 'impl-race-3', 'impl-race-4', 'impl-race-5']);
  assert.equal(r.distinct, true);
  assert.equal(r.gitHasThem, true, 'every name is a real git branch');
  assert.equal(r.recordsMatch, true, 'five children, each carrying its spawner as namer');
  assert.equal(r.wsDelta, 0, 'exactly N workspaces: no failed spawn left a record behind');
  assert.equal(r.sequentialOk, true, 'control: one-by-one spawns give the same suffix contract (what changed is only that parallel ones agree)');
  assert.equal(r.ok, true);
});

test('exhausted: name + -2…-99 all taken ⇒ the AGENT route refuses and creates nothing; `-99` still free ⇒ ok; the human path keeps its random fallback', () => {
  const r = runArm('exhausted');
  assert.deepEqual(r.lastSlot, { ok: true, branch: 'impl-y-99' }, 'control: the last free slot is used');
  assert.equal(r.refused.ok, false);
  assert.match(r.refused.error, /the name "impl-x" and all its suffixes \(-2 … -99\) are taken/);
  assert.match(r.refused.error, /Nothing was created/);
  assert.equal(r.refused.id, null, 'no workspace id: nothing was kept');
  assert.equal(r.nothingCreated, true, 'no record, no branch, no worktree dir');
  assert.equal(r.human.ok, true, 'control: a human path (pinned-Linear / accès mobile shape) is NOT refused');
  assert.equal(r.human.randomShape, true, '…and still lands on a generated adjective-noun branch (byte-identical to before)');
  assert.equal(r.ok, true);
});

test('alias: the same repo registered under a symlink — 4 parallel same-name spawns split across both spellings all succeed, distinct', () => {
  const r = runArm('alias');
  assert.deepEqual(r.results.map((x: { ok: boolean }) => x.ok), [true, true, true, true], JSON.stringify(r.results));
  assert.deepEqual(r.got, ['impl-al', 'impl-al-2', 'impl-al-3', 'impl-al-4']);
  assert.equal(r.ok, true);
});

test('folder: a branch `impl-z/sub` exists ⇒ the agent route lands on `impl-z-2` (never a raw git "cannot lock ref"); a free name stays bare', () => {
  const r = runArm('folder');
  assert.deepEqual(r.folder, { ok: true, branch: 'impl-z-2', error: null });
  assert.deepEqual(r.plain, { ok: true, branch: 'impl-w' });
  assert.equal(r.ok, true);
});

test('released: a spawn whose `git worktree add` fails frees its reserved name — the next spawn gets the BARE name, one record, one branch', () => {
  const r = runArm('released');
  assert.equal(r.failed.ok, false, 'control: the first spawn really failed');
  assert.deepEqual(r.after, { ok: true, branch: 'impl-r' });
  assert.equal(r.records, 1);
  assert.deepEqual(r.branchesNow, ['impl-r']);
  assert.equal(r.ok, true);
});
