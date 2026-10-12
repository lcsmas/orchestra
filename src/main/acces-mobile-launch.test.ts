// Accès mobile launch (#375) — the main-side guards, driven through the REAL launcher with a fake spawn path:
// registered repo only (nothing created otherwise), a prompt, and what each outcome carries back.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createMobileLauncher, type MobileSpawnResult } from './acces-mobile-launch.ts';

const REPO = '/home/u/orchestra';

function rig(spawnImpl?: (n: number, input: { repoPath: string; task: string }) => Promise<MobileSpawnResult>) {
  const spawned: { repoPath: string; task: string }[] = [];
  const launcher = createMobileLauncher({
    repos: () => [{ path: REPO }, { path: '/home/u/other' }],
    spawn: async (input) => {
      spawned.push(input);
      return spawnImpl ? spawnImpl(spawned.length, input) : { ok: true, id: `ws-${spawned.length}`, branch: `b-${spawned.length}` };
    },
  });
  return { launcher, spawned };
}

test('a registered repo + a prompt ⇒ one workspace through the spawn path, with the TRIMMED prompt as its first task', async () => {
  const r = rig();
  const out = await r.launcher.launch({ repoPath: REPO, prompt: '  do the thing\n' });
  assert.deepEqual(out, { ok: true, id: 'ws-1', branch: 'b-1' });
  assert.deepEqual(r.spawned, [{ repoPath: REPO, task: 'do the thing' }], 'nothing else (no model / branch / Compte / parent) is passed down');
});

test('must-FAIL: an UNREGISTERED repo path is refused and nothing is created (control: a registered one is created)', async () => {
  const r = rig();
  assert.equal((await r.launcher.launch({ repoPath: REPO, prompt: 'x' })).ok, true, 'control');
  for (const repoPath of ['/etc', REPO + '/', REPO + '/../..', '/home/u/orchestra-evil', '~/repo', 'orchestra']) {
    const out = await r.launcher.launch({ repoPath, prompt: 'x' });
    assert.deepEqual(out, { ok: false, code: 'unknown-repo', error: 'unknown repo' }, repoPath);
  }
  assert.equal(r.spawned.length, 1, 'only the control reached the spawn path');
});

test('must-FAIL: an empty / blank / missing prompt or repo is refused in main too (main never trusts the server), nothing is created', async () => {
  const r = rig();
  for (const bad of [{ repoPath: REPO, prompt: '' }, { repoPath: REPO, prompt: '  \n ' }, { repoPath: REPO }, { prompt: 'x' }, null, 'launch']) {
    const out = await r.launcher.launch(bad);
    assert.equal(out.ok, false);
    assert.equal(out.ok === false && out.code, 'bad-request');
  }
  assert.equal(r.spawned.length, 0);
});

test('a launch that created NOTHING is a refusal carrying the cause; one that kept a workspace carries its id', async () => {
  let n = 0;
  const r = rig(async () => {
    n++;
    if (n === 1) return { ok: false, error: 'fatal: not a git repository' };
    return { ok: false, id: 'kept-1', branch: 'b', error: 'the agent failed to start: no auth. Workspace b (kept-1) was kept…', startError: 'no auth' };
  });
  assert.deepEqual(await r.launcher.launch({ repoPath: REPO, prompt: 'x' }), { ok: false, code: 'create-failed', error: 'fatal: not a git repository' });
  assert.deepEqual(await r.launcher.launch({ repoPath: REPO, prompt: 'x' }), { ok: false, code: 'start-failed', id: 'kept-1', branch: 'b', error: 'no auth' }, 'the CLI advice is not what the phone gets: startError is; the branch rides along (the conversation header)');
});

test('a throwing spawn path is a refusal, not a crash', async () => {
  const launcher = createMobileLauncher({ repos: () => [{ path: REPO }], spawn: async () => { throw new Error('boom'); } });
  assert.deepEqual(await launcher.launch({ repoPath: REPO, prompt: 'x' }), { ok: false, code: 'create-failed', error: 'boom' });
});

test('an ok-with-a-caveat spawn (first turn not confirmed) keeps its note', async () => {
  const r = rig(async () => ({ ok: true, id: 'w', note: 'first turn not confirmed within 20 s — started, not confirmed' }));
  assert.deepEqual(await r.launcher.launch({ repoPath: REPO, prompt: 'x' }), { ok: true, id: 'w', note: 'first turn not confirmed within 20 s — started, not confirmed' });
});

test('a spawn answer with ok but no id is NOT a success (the phone would open nothing)', async () => {
  const r = rig(async () => ({ ok: true }));
  const out = await r.launcher.launch({ repoPath: REPO, prompt: 'x' });
  assert.equal(out.ok, false);
});
