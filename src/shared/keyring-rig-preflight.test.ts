import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkWorld,
  combine,
  formatVerdict,
  isInside,
  parseUnixPathAddress,
  touchesUserRuntime,
  type Accessors,
} from './keyring-rig-preflight.ts';

// #389 preflight — the pure string rules and the "never touch the real runtime dir" property, over a FAKE filesystem (a tiny in-memory table, no real
// fs). The per-clause must-FAIL arms run through the real accessors in src/main/keyring-rig-preflight-host.test.ts (the same table the self-test runs).

test('touchesUserRuntime: every spelling that can name /run/user — slashes collapsed, .. normalised, /proc re-rooting, percent escapes, lists — and nothing innocent', () => {
  const hits = [
    '/run/user/1000', '/run/user', '/var/run/user/1000/bus', '//run/user/1000', '/run//user/1000', '/usr/../run/user/1000', '/run/./user/1000',
    '/proc/self/root/run/user/1000', '/proc/12/root/etc', '/proc/thread-self/cwd/x', 'unix:path=/run/user/1000/bus', 'unix:path=/a/b;unix:path=/run//user/1000/bus',
    'x:/run/user/1000/keyring/control', 'unix:path=%2Frun%2Fuser%2F1000%2Fbus', 'disabled:;unix:path=/run/user/1000/bus', '/run/user/self/bus',
  ];
  for (const s of hits) assert.ok(touchesUserRuntime(s), s);
  const clean = ['/run/userspace/x', '/home/u/run/user_x', '/rigs/x/run', '/home/lmas/.cache/e2e/arm/run/bus', 'unix:path=/home/x/run/bus', '', undefined, '/runner/user/1'];
  for (const s of clean) assert.ok(!touchesUserRuntime(s), String(s));
});

test('parseUnixPathAddress: exactly ONE absolute unix:path= (optional guid); lists, abstract, tcp, escapes, relative, disabled:, autolaunch: are all null', () => {
  assert.equal(parseUnixPathAddress('unix:path=/a/b/bus'), '/a/b/bus');
  assert.equal(parseUnixPathAddress('unix:path=/a/b/bus,guid=0123abcd'), '/a/b/bus');
  for (const s of ['unix:path=/a/bus;unix:path=/b/bus', 'unix:path=/a/bus,unix:path=/b/bus', 'unix:abstract=/x', 'tcp:host=x,port=1', 'disabled:', 'autolaunch:', 'unix:path=rel/bus', 'unix:path=%2Fa%2Fbus', 'unix:path=/a b/bus', 'unix:path=/a/bus,guid=XYZ', '', undefined, 'systemd:', 'unix:dir=/a']) {
    assert.equal(parseUnixPathAddress(s), null, String(s));
  }
});

test('isInside: the path itself, children — and not siblings, parents or look-alikes', () => {
  assert.ok(isInside('/a/b', '/a/b') && isInside('/a/b', '/a/b/c') && !isInside('/a/b', '/a/bc') && !isInside('/a/b', '/a') && !isInside('/a/b', '/x'));
});

/** A fake world where `realpath` / `kind` / … record every path asked about; nothing exists unless listed. */
function fakeAcc(log: string[], tree: Record<string, 'dir' | 'socket' | 'symlink'> = {}): Accessors {
  const rec = (p: string) => (log.push(p), p);
  return {
    realpath: (p) => (rec(p) in tree ? p : null),
    kind: (p) => tree[rec(p)] ?? null,
    dirInfo: (p) => (tree[rec(p)] === 'dir' ? { mode: 0o700, uid: 1 } : null),
    readText: (p) => (rec(p), null),
    mountPoints: () => [],
    uid: 1,
  };
}

test('NEVER TOUCHES THE REAL RUNTIME DIR: for every negative input naming it (any spelling), no accessor is called with a path that can name it', () => {
  const tree = { '/rigs/r': 'dir' as const, '/rigs/r/run': 'dir' as const };
  const goodEnv = { XDG_RUNTIME_DIR: '/rigs/r/run', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/rigs/r/run/bus' };
  const cases: Array<[string, string, Record<string, string | undefined>]> = [
    ['runtime dir', '/rigs/r', { ...goodEnv, XDG_RUNTIME_DIR: '/run/user/1000' }],
    ['runtime dir //', '/rigs/r', { ...goodEnv, XDG_RUNTIME_DIR: '/run//user/1000' }],
    ['runtime dir /proc', '/rigs/r', { ...goodEnv, XDG_RUNTIME_DIR: '/proc/self/root/run/user/1000' }],
    ['runtime dir ..', '/rigs/r', { ...goodEnv, XDG_RUNTIME_DIR: '/usr/../run/user/1000' }],
    ['bus address', '/rigs/r', { ...goodEnv, DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus' }],
    ['bus address list', '/rigs/r', { ...goodEnv, DBUS_SESSION_BUS_ADDRESS: 'unix:path=/rigs/r/run/bus;unix:path=/run//user/1000/bus' }],
    ['rig dir', '/run/user/1000/rig', goodEnv],
    ['rig dir //', '//run/user/1000/rig', goodEnv],
  ];
  for (const [name, rigDir, env] of cases) {
    const log: string[] = [];
    const v = checkWorld({ rigDir, env, requireBusSocket: true, acc: fakeAcc(log, tree) });
    assert.equal(v.ok, false, name);
    assert.deepEqual(log.filter((p) => touchesUserRuntime(p) || /^\/(?:var\/)?run\/user/.test(p)), [], `${name}: accessors were called with ${log.join(', ')}`);
  }
});

test('a clean fake world passes with every clause evaluated; a verdict with nothing evaluated is NOT a pass', () => {
  const log: string[] = [];
  const tree = { '/rigs/r': 'dir' as const, '/rigs/r/run': 'dir' as const, '/rigs/r/run/bus': 'socket' as const };
  const v = checkWorld({ rigDir: '/rigs/r', env: { XDG_RUNTIME_DIR: '/rigs/r/run', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/rigs/r/run/bus' }, requireBusSocket: true, acc: fakeAcc(log, tree) });
  assert.deepEqual(v.violations, []);
  assert.deepEqual(v.passed, ['rig-dir-no-mounts', 'runtime-dir-scratch', 'bus-address-private', 'bus-socket-private']);
  assert.ok(v.ok && v.facts?.busPath === '/rigs/r/run/bus');
  assert.equal(combine().ok, false, 'no clause evaluated ⇒ not ok');
});

test('formatVerdict names every clause that fired', () => {
  const v = combine(checkWorld({ rigDir: '/rigs/nope', env: {}, requireBusSocket: true, acc: fakeAcc([]) }));
  assert.equal(v.ok, false);
  assert.match(formatVerdict(v), /^PREFLIGHT ABORT: \[runtime-dir-scratch\]/);
  assert.match(formatVerdict({ ok: true, violations: [], passed: ['a', 'b'] }), /^PREFLIGHT OK: a, b$/);
});
