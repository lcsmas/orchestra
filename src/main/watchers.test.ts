import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mkHomeScratch } from '../shared/home-scratch.ts';
import { WATCH_BACKOFF_MS } from '../shared/resilient-watch.ts';
import { degradedOf, type WatchersStatus } from '../shared/watcher-status.ts';
import { __resetWatchersForTests, __setWatchPrimitiveForTests, createWatcher, faultFileFrom, onWatchersChange, stopAllWatchers, watchersStatus } from './watchers.ts';

// #330 — the REGISTRY and the production wiring, over the real timers and (for the fault-file arm) a real directory watch. The state machine's own arms (backoff, mid-life error, stop) are in
// src/shared/resilient-watch.test.ts with a fake clock; here: what `bus-status` and the renderer push OBSERVE.

const emfile = (): never => {
  throw Object.assign(new Error("EMFILE: too many open files, watch '/x'"), { code: 'EMFILE' });
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(pred: () => boolean, ms: number, what: string): Promise<void> {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) assert.fail(`timed out waiting for: ${what}`);
    await sleep(20);
  }
}

afterEach(() => {
  stopAllWatchers();
  __resetWatchersForTests();
  delete process.env.ORCHESTRA_WATCH_FAULT_FILE;
});

test('healthy watcher: listed as ok, no push on start or stop (edge-triggered), gone from the registry after stop()', () => {
  const dir = mkHomeScratch('watchers-ok-');
  const pushes: WatchersStatus[] = [];
  onWatchersChange((s) => pushes.push(s));
  const w = createWatcher({ name: 'a', label: 'A', dir, fallback: 'poll', onChange: () => {} });
  assert.deepEqual(watchersStatus().watchers, [], 'not registered before start()');
  w.start();
  assert.deepEqual(
    watchersStatus().watchers.map((x) => [x.name, x.state]),
    [['a', 'ok']],
  );
  w.stop();
  assert.deepEqual(watchersStatus().watchers, []);
  assert.equal(pushes.length, 0, 'a healthy start/stop is not a transition');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('EMFILE at arm: bus-status data lists it degraded at once; ONE push; after the first backoff it is back, ONE push, status clean', async () => {
  let arms = 0;
  __setWatchPrimitiveForTests((dir, onEvent) => {
    arms++;
    if (arms <= 1) emfile();
    return { close: () => {} };
  });
  const pushes: WatchersStatus[] = [];
  onWatchersChange((s) => pushes.push(s));
  let recovered = 0;
  const w = createWatcher({ name: 'bus-wake', label: 'Réveils', dir: '/nowhere', fallback: '60 s sweep', onChange: () => {}, onRecover: () => void recovered++ });
  w.start();
  const d = degradedOf(watchersStatus());
  assert.equal(d.length, 1);
  assert.equal(d[0].name, 'bus-wake');
  assert.equal(d[0].lastError?.code, 'EMFILE');
  assert.equal(pushes.length, 1, 'one push on degrade');
  assert.equal(degradedOf(pushes[0]).length, 1);
  await until(() => degradedOf(watchersStatus()).length === 0, WATCH_BACKOFF_MS[0] + 1500, 'recovery after the first backoff');
  assert.equal(pushes.length, 2, 'one push on recovery');
  assert.equal(degradedOf(pushes[1]).length, 0);
  assert.equal(recovered, 1, 'catch-up ran once');
  assert.equal(watchersStatus().watchers[0].state, 'ok');
});

test('stop() of a DEGRADED watcher clears it from the registry and pushes the all-clear (no retry survives)', async () => {
  let arms = 0;
  __setWatchPrimitiveForTests(() => {
    arms++;
    return emfile();
  });
  const pushes: WatchersStatus[] = [];
  onWatchersChange((s) => pushes.push(s));
  const w = createWatcher({ name: 'x', label: 'X', dir: '/nowhere', fallback: 'poll', onChange: () => {} });
  w.start();
  assert.equal(degradedOf(watchersStatus()).length, 1);
  w.stop();
  assert.deepEqual(watchersStatus().watchers, []);
  assert.equal(pushes.length, 2);
  assert.equal(degradedOf(pushes[1]).length, 0);
  const before = arms;
  await sleep(WATCH_BACKOFF_MS[0] + 400);
  assert.equal(arms, before, 'the pending retry was cancelled');
});

test('stopAllWatchers() stops every armed watcher and its retries (shutdown)', async () => {
  let arms = 0;
  __setWatchPrimitiveForTests(() => {
    arms++;
    return emfile();
  });
  createWatcher({ name: 'a', label: 'A', dir: '/n1', fallback: 'p', onChange: () => {} }).start();
  createWatcher({ name: 'b', label: 'B', dir: '/n2', fallback: 'p', onChange: () => {} }).start();
  assert.equal(watchersStatus().watchers.length, 2);
  stopAllWatchers();
  assert.deepEqual(watchersStatus().watchers, []);
  const before = arms;
  await sleep(WATCH_BACKOFF_MS[0] + 400);
  assert.equal(arms, before);
});

test('the status is sorted by name and carries each watcher’s directory + fallback', () => {
  __setWatchPrimitiveForTests(() => ({ close: () => {} }));
  createWatcher({ name: 'zz', label: 'Z', dir: '/z', fallback: 'fz', onChange: () => {} }).start();
  createWatcher({ name: 'aa', label: 'A', dir: '/a', fallback: 'fa', onChange: () => {} }).start();
  assert.deepEqual(
    watchersStatus().watchers.map((w) => [w.name, w.dir, w.fallback]),
    [
      ['aa', '/a', 'fa'],
      ['zz', '/z', 'fz'],
    ],
  );
});

test('a throwing push listener cannot break the registry or the other listeners', () => {
  __setWatchPrimitiveForTests(() => emfile());
  const seen: number[] = [];
  onWatchersChange(() => {
    throw new Error('listener blew up');
  });
  onWatchersChange((s) => seen.push(s.watchers.length));
  createWatcher({ name: 'x', label: 'X', dir: '/n', fallback: 'p', onChange: () => {} }).start();
  assert.deepEqual(seen, [1]);
});

test('ORCHESTRA_WATCH_FAULT_FILE: while the file exists every arm fails EMFILE (injected, real directory); delete it → re-armed, and the REAL watch delivers events', async () => {
  const dir = mkHomeScratch('watchers-fault-');
  const fault = path.join(os.tmpdir(), `watch-fault-${process.pid}-${Date.now()}`);
  fs.writeFileSync(fault, 'inject');
  process.env.ORCHESTRA_WATCH_FAULT_FILE = fault;
  const got: Array<string | null> = [];
  let recovered = 0;
  const w = createWatcher({ name: 'real', label: 'Real', dir, fallback: 'poll', onChange: (f) => void got.push(f), onRecover: () => void recovered++ });
  w.start();
  try {
    const d = degradedOf(watchersStatus());
    assert.equal(d.length, 1, 'degraded while the fault file exists');
    assert.equal(d[0].lastError?.code, 'EMFILE');
    assert.match(d[0].lastError!.message, /injected/);
    await sleep(WATCH_BACKOFF_MS[0] + 600);
    assert.equal(degradedOf(watchersStatus()).length, 1, 'a retry while the fault persists stays degraded');
    fs.rmSync(fault);
    await until(() => degradedOf(watchersStatus()).length === 0, WATCH_BACKOFF_MS[1] + 2500, 'recovery after the fault file is removed');
    assert.equal(recovered, 1);
    fs.writeFileSync(path.join(dir, 'hello.txt'), 'x');
    await until(() => got.includes('hello.txt'), 2000, 'a real fs event through the recovered watch');
  } finally {
    w.stop();
    fs.rmSync(fault, { force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('no fault file env → no injection (positive control: the real primitive arms a real directory)', () => {
  const dir = mkHomeScratch('watchers-noinject-');
  const w = createWatcher({ name: 'real', label: 'Real', dir, fallback: 'poll', onChange: () => {} });
  w.start();
  assert.equal(watchersStatus().watchers[0].state, 'ok');
  w.stop();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('faultFileFrom: unset / blank → null', () => {
  assert.equal(faultFileFrom({}), null);
  assert.equal(faultFileFrom({ ORCHESTRA_WATCH_FAULT_FILE: '  ' }), null);
  assert.equal(faultFileFrom({ ORCHESTRA_WATCH_FAULT_FILE: ' /a/b ' }), '/a/b');
});

test('ensureDir creates a missing directory on arm (the sites that used to mkdir before watching)', () => {
  const base = mkHomeScratch('watchers-mkdir-');
  const dir = path.join(base, 'not', 'yet');
  const w = createWatcher({ name: 'mk', label: 'Mk', dir, fallback: 'poll', onChange: () => {}, ensureDir: true });
  w.start();
  assert.ok(fs.existsSync(dir));
  assert.equal(watchersStatus().watchers[0].state, 'ok');
  w.stop();
  fs.rmSync(base, { recursive: true, force: true });
});

test('a missing directory without ensureDir is DEGRADED (ENOENT), not a throw — and recovers once the directory exists (the bus-dir sites)', async () => {
  const base = mkHomeScratch('watchers-enoent-');
  const dir = path.join(base, 'later');
  const w = createWatcher({ name: 'late', label: 'Late', dir, fallback: 'sweep', onChange: () => {} });
  w.start();
  try {
    const d = degradedOf(watchersStatus());
    assert.equal(d.length, 1);
    assert.equal(d[0].lastError?.code, 'ENOENT');
    fs.mkdirSync(dir);
    await until(() => degradedOf(watchersStatus()).length === 0, WATCH_BACKOFF_MS[0] + 1500, 'recovery once the directory exists');
  } finally {
    w.stop();
    fs.rmSync(base, { recursive: true, force: true });
  }
});
