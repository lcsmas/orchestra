import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mkHomeScratch } from '../shared/home-scratch.ts';
import { WATCH_BACKOFF_MS } from '../shared/resilient-watch.ts';
import { degradedOf, type WatchersStatus } from '../shared/watcher-status.ts';
import { initPlatform } from './platform/index.ts';
import { __resetWatchersForTests, __setWatchPrimitiveForTests, createWatcher, faultFileFrom, onWatchersChange, pushWatchersToRenderer, stopAllWatchers, watchersStatus } from './watchers.ts';

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
  assert.equal(pushes[0].rev, 1, 'the first pushed change is rev 1 (the host-stamped order the renderer compares, review M1)');
  assert.equal(watchersStatus().rev, 1, 'a PULL carries the same counter as the last push');
  await until(() => degradedOf(watchersStatus()).length === 0, WATCH_BACKOFF_MS[0] + 1500, 'recovery after the first backoff');
  assert.equal(pushes.length, 2, 'one push on recovery');
  assert.equal(degradedOf(pushes[1]).length, 0);
  assert.equal(pushes[1].rev, 2, 'rev counts pushed changes: the recovery is 2');
  assert.equal(watchersStatus().rev, 2);
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

test('the primitive receives the site’s persistent option (the transient login watch must never keep the process alive)', () => {
  const seen: Array<{ persistent?: boolean } | undefined> = [];
  __setWatchPrimitiveForTests((_dir, _onEvent, _onError, opts) => {
    seen.push(opts);
    return { close: () => {} };
  });
  createWatcher({ name: 'p', label: 'P', dir: '/p', fallback: 'poll', onChange: () => {}, persistent: false }).start();
  createWatcher({ name: 'q', label: 'Q', dir: '/q', fallback: 'poll', onChange: () => {} }).start();
  assert.deepEqual(seen, [{ persistent: false }, undefined]);
});

test('start() after stop() does not put a zombie back in the registry', () => {
  __setWatchPrimitiveForTests(() => ({ close: () => {} }));
  const w = createWatcher({ name: 'z', label: 'Z', dir: '/z', fallback: 'poll', onChange: () => {} });
  w.start();
  w.stop();
  w.start();
  assert.deepEqual(watchersStatus().watchers, []);
});

test('pushWatchersToRenderer is idempotent: a second call (darwin `activate` re-runs createMainWindow) never doubles the push', () => {
  const sent: Array<{ channel: string; n: number }> = [];
  initPlatform({
    kind: 'headless-test', broadcast: (channel: string, ...args: unknown[]) => void sent.push({ channel, n: (args[0] as { watchers: unknown[] }).watchers.length }), broadcastPtyData: () => true, canBroadcast: () => true, isFocused: () => false, hasAttachedUi: () => true, notify: () => {},
    openExternal: () => {}, showItemInFolder: () => {}, openPath: () => {}, openAccountLoginUrl: () => {}, closeAccountLogin: () => {},
    getUserDataDir: () => os.tmpdir(), getLogsDir: () => os.tmpdir(), getAppVersion: () => '0', getAppMetrics: () => [],
    isEncryptionAvailable: () => false, encryptString: (s: string) => s, decryptString: (s: string) => s,
  } as never);
  __setWatchPrimitiveForTests(() => emfile());
  const a = pushWatchersToRenderer();
  const b = pushWatchersToRenderer();
  assert.equal(a, b, 'the same subscription');
  createWatcher({ name: 'x', label: 'X', dir: '/n', fallback: 'p', onChange: () => {} }).start();
  assert.deepEqual(sent.filter((e) => e.channel === 'watchers:update'), [{ channel: 'watchers:update', n: 1 }], 'ONE push for one degradation');
  a();
  assert.notEqual(pushWatchersToRenderer(), a, 'after an unsubscribe a new subscription is possible');
});

test('m1 on a REAL directory with the production 30 s health period: deleting the watched directory and recreating it is noticed at once by the kernel\'s own rename event — re-armed in the first backoff step, events flow again (the inode check alone would take 30 s, and never fires where the inode number is reused)', async () => {
  const base = mkHomeScratch('watchers-m1-');
  const dir = path.join(base, 'watched');
  fs.mkdirSync(dir);
  const got: Array<string | null> = [];
  let recovered = 0;
  const w = createWatcher({ name: 'm1', label: 'M1', dir, fallback: 'poll', onChange: (f) => void got.push(f), onRecover: () => void recovered++ });
  w.start();
  try {
    fs.rmSync(dir, { recursive: true });
    fs.mkdirSync(dir);
    await until(() => recovered === 1 && degradedOf(watchersStatus()).length === 0, WATCH_BACKOFF_MS[0] + 1500, 're-armed after the directory was swapped');
    fs.writeFileSync(path.join(dir, 'after.txt'), 'x');
    await until(() => got.includes('after.txt'), 2000, 'an event through the re-armed watch');
  } finally {
    w.stop();
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('m1 on a REAL directory: a chmod / touch of the watched directory (the kernel sends the same `rename <dirname>`) is NOT a removal where the filesystem records a birth time — no degradation, no re-arm, events keep flowing; where it does not, the conservative path degrades and recovers (never a silent miss)', async () => {
  const base = mkHomeScratch('watchers-m1b-');
  const dir = path.join(base, 'watched');
  fs.mkdirSync(dir);
  const born = fs.statSync(dir).birthtimeMs > 0;
  const got: Array<string | null> = [];
  const w = createWatcher({ name: 'm1b', label: 'M1b', dir, fallback: 'poll', onChange: (f) => void got.push(f) });
  w.start();
  try {
    fs.chmodSync(dir, 0o750);
    fs.utimesSync(dir, new Date(), new Date());
    await sleep(700);
    const snap = watchersStatus().watchers[0];
    if (born) {
      assert.equal(snap.state, 'ok', 'a chmod/touch of a live directory must not read as its removal');
      assert.equal(snap.attempts, 0, 'no degradation was ever recorded');
      fs.writeFileSync(path.join(dir, 'still.txt'), 'x');
      await until(() => got.includes('still.txt'), 2000, 'an event through the SAME watch');
    } else {
      await until(() => watchersStatus().watchers[0].recoveries === 1, WATCH_BACKOFF_MS[0] + 1500, 'no birth time on this filesystem: degraded then re-armed (conservative)');
    }
    // and a REAL swap is still caught at once (positive control, same watcher)
    const before = watchersStatus().watchers[0].recoveries;
    fs.rmSync(dir, { recursive: true });
    fs.mkdirSync(dir);
    await until(() => watchersStatus().watchers[0].recoveries === before + 1, WATCH_BACKOFF_MS[0] + 1500, 're-armed after the directory was swapped');
    fs.writeFileSync(path.join(dir, 'after.txt'), 'x');
    await until(() => got.includes('after.txt'), 2000, 'an event through the re-armed watch');
  } finally {
    w.stop();
    fs.rmSync(base, { recursive: true, force: true });
  }
});
