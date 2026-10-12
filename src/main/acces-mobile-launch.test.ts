// Accès mobile launch (#375/#376) — the main-side guards, driven through the REAL launcher with a fake spawn path:
// registered repo only (nothing created otherwise), a prompt, and ONE workspace per request id.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createMobileLauncher, type MobileSpawnResult } from './acces-mobile-launch.ts';
import { MOBILE_LAUNCH_REPEAT_WINDOW_MS } from '../shared/acces-mobile-launch.ts';

const REPO = '/home/u/orchestra';
const rid = (n: number | string) => `request-id-${String(n).padStart(8, '0')}`;

function rig(spawnImpl?: (n: number, input: { repoPath: string; task: string }) => Promise<MobileSpawnResult>) {
  const spawned: { repoPath: string; task: string }[] = [];
  let t = 1_000_000;
  const launcher = createMobileLauncher({
    repos: () => [{ path: REPO }, { path: '/home/u/other' }],
    spawn: async (input) => {
      spawned.push(input);
      return spawnImpl ? spawnImpl(spawned.length, input) : { ok: true, id: `ws-${spawned.length}`, branch: `b-${spawned.length}` };
    },
    now: () => t,
  });
  return { launcher, spawned, advance: (ms: number) => (t += ms) };
}

test('a registered repo + a prompt ⇒ one workspace through the spawn path, with the TRIMMED prompt as its first task', async () => {
  const r = rig();
  const out = await r.launcher.launch({ repoPath: REPO, prompt: '  do the thing\n', requestId: rid(1) });
  assert.deepEqual(out, { ok: true, id: 'ws-1', branch: 'b-1' });
  assert.deepEqual(r.spawned, [{ repoPath: REPO, task: 'do the thing' }], 'nothing else (no model / branch / Compte / parent) is passed down');
});

test('must-FAIL: an UNREGISTERED repo path is refused and nothing is created (control: a registered one is created)', async () => {
  const r = rig();
  assert.equal((await r.launcher.launch({ repoPath: REPO, prompt: 'x', requestId: rid(1) })).ok, true, 'control');
  for (const [i, repoPath] of ['/etc', REPO + '/', REPO + '/../..', '/home/u/orchestra-evil', '~/orchestra', 'orchestra'].entries()) {
    const out = await r.launcher.launch({ repoPath, prompt: 'x', requestId: rid(10 + i) });
    assert.deepEqual(out, { ok: false, code: 'unknown-repo', error: 'unknown repo' }, repoPath);
  }
  assert.equal(r.spawned.length, 1, 'only the control reached the spawn path');
});

test('must-FAIL: an empty / blank prompt or a missing request id is refused in main too, nothing is created', async () => {
  const r = rig();
  for (const bad of [
    { repoPath: REPO, prompt: '', requestId: rid(1) },
    { repoPath: REPO, prompt: '  \n ', requestId: rid(2) },
    { repoPath: REPO, requestId: rid(3) },
    { repoPath: REPO, prompt: 'x' },
    { prompt: 'x', requestId: rid(4) },
    null,
    'launch',
  ]) {
    const out = await r.launcher.launch(bad);
    assert.equal(out.ok, false);
    assert.equal(out.ok === false && out.code, 'bad-request');
  }
  assert.equal(r.spawned.length, 0);
});

test('#376 must-FAIL: a double submit (same request id, the first still creating) creates ONE workspace and both answers carry its id', async () => {
  let release!: (v: MobileSpawnResult) => void;
  const r = rig(() => new Promise((res) => (release = res)));
  const a = r.launcher.launch({ repoPath: REPO, prompt: 'x', requestId: rid(1) });
  const b = r.launcher.launch({ repoPath: REPO, prompt: 'x', requestId: rid(1) }); // the second tap, the first not settled
  assert.equal(r.spawned.length, 1, 'the second request did not start a second creation');
  release({ ok: true, id: 'ws-one', branch: 'quiet-fox' });
  assert.deepEqual(await Promise.all([a, b]), [
    { ok: true, id: 'ws-one', branch: 'quiet-fox' },
    { ok: true, id: 'ws-one', branch: 'quiet-fox' },
  ]);
  const later = await r.launcher.launch({ repoPath: REPO, prompt: 'x', requestId: rid(1) });
  assert.deepEqual(later, { ok: true, id: 'ws-one', branch: 'quiet-fox' }, 'a repeat after it settled is the same workspace too');
  assert.equal(r.spawned.length, 1);
});

test('#376: distinct request ids are distinct launches (control for the double-submit arm)', async () => {
  const r = rig();
  const [a, b] = await Promise.all([
    r.launcher.launch({ repoPath: REPO, prompt: 'x', requestId: rid(1) }),
    r.launcher.launch({ repoPath: REPO, prompt: 'x', requestId: rid(2) }),
  ]);
  assert.deepEqual([a.ok && a.id, b.ok && b.id], ['ws-1', 'ws-2']);
});

test('#376: the repeat window is bounded — after MOBILE_LAUNCH_REPEAT_WINDOW_MS the same id is a NEW launch', async () => {
  const r = rig();
  await r.launcher.launch({ repoPath: REPO, prompt: 'x', requestId: rid(1) });
  r.advance(MOBILE_LAUNCH_REPEAT_WINDOW_MS - 1);
  assert.equal((await r.launcher.launch({ repoPath: REPO, prompt: 'x', requestId: rid(1) })).ok && r.spawned.length, 1, 'inside the window');
  r.advance(1);
  const again = await r.launcher.launch({ repoPath: REPO, prompt: 'x', requestId: rid(1) });
  assert.deepEqual([again.ok && again.id, r.spawned.length], ['ws-2', 2], 'outside it');
});

test('#376: the same request id carrying ANOTHER launch is refused — never answered with a workspace that is not its own', async () => {
  const r = rig();
  assert.equal((await r.launcher.launch({ repoPath: REPO, prompt: 'first', requestId: rid(1) })).ok, true);
  const other = await r.launcher.launch({ repoPath: REPO, prompt: 'second', requestId: rid(1) });
  assert.equal(other.ok === false && other.code, 'request-reused');
  const otherRepo = await r.launcher.launch({ repoPath: '/home/u/other', prompt: 'first', requestId: rid(1) });
  assert.equal(otherRepo.ok === false && otherRepo.code, 'request-reused');
  assert.equal(r.spawned.length, 1);
});

test('#376: a launch that created NOTHING is retryable under the same id; one that kept a workspace stays answered with it', async () => {
  let n = 0;
  const r = rig(async () => {
    n++;
    if (n === 1) return { ok: false, error: 'fatal: not a git repository' };
    if (n === 2) return { ok: false, id: 'kept-1', branch: 'b', error: 'the agent failed to start: no auth. Workspace b (kept-1) was kept…', startError: 'no auth' };
    return { ok: true, id: 'ws-x' };
  });
  const first = await r.launcher.launch({ repoPath: REPO, prompt: 'x', requestId: rid(1) });
  assert.deepEqual(first, { ok: false, code: 'create-failed', error: 'fatal: not a git repository' });
  const retry = await r.launcher.launch({ repoPath: REPO, prompt: 'x', requestId: rid(1) });
  assert.deepEqual(retry, { ok: false, code: 'start-failed', id: 'kept-1', branch: 'b', error: 'no auth' }, 'the failed creation was NOT remembered: the retry really ran');
  const again = await r.launcher.launch({ repoPath: REPO, prompt: 'x', requestId: rid(1) });
  assert.deepEqual(again, retry, 'a kept workspace is remembered: a third tap does not create a duplicate');
  assert.equal(r.spawned.length, 2);
});

test('a throwing spawn path is a refusal, not a crash; and it is retryable', async () => {
  let n = 0;
  const launcher = createMobileLauncher({
    repos: () => [{ path: REPO }],
    spawn: async () => {
      if (++n === 1) throw new Error('boom');
      return { ok: true, id: 'ws-2' };
    },
  });
  assert.deepEqual(await launcher.launch({ repoPath: REPO, prompt: 'x', requestId: rid(1) }), { ok: false, code: 'create-failed', error: 'boom' });
  assert.deepEqual(await launcher.launch({ repoPath: REPO, prompt: 'x', requestId: rid(1) }), { ok: true, id: 'ws-2' });
});

test('an ok-with-a-caveat spawn (first turn not confirmed) keeps its note', async () => {
  const r = rig(async () => ({ ok: true, id: 'w', note: 'first turn not confirmed within 20 s — started, not confirmed' }));
  assert.deepEqual(await r.launcher.launch({ repoPath: REPO, prompt: 'x', requestId: rid(1) }), { ok: true, id: 'w', note: 'first turn not confirmed within 20 s — started, not confirmed' });
});

test('a spawn answer with ok but no id is NOT a success (the phone would open nothing)', async () => {
  const r = rig(async () => ({ ok: true }));
  const out = await r.launcher.launch({ repoPath: REPO, prompt: 'x', requestId: rid(1) });
  assert.equal(out.ok, false);
});

test('the repeat table is bounded: the oldest settled id is forgotten past 256, the newest is remembered', async () => {
  const r = rig();
  for (let i = 0; i < 300; i++) await r.launcher.launch({ repoPath: REPO, prompt: 'x', requestId: rid(i) });
  assert.equal(r.spawned.length, 300);
  await r.launcher.launch({ repoPath: REPO, prompt: 'x', requestId: rid(299) });
  assert.equal(r.spawned.length, 300, 'the newest is still remembered');
  await r.launcher.launch({ repoPath: REPO, prompt: 'x', requestId: rid(0) });
  assert.equal(r.spawned.length, 301, 'the oldest was evicted (memory is bounded without the server\'s cap)');
});
