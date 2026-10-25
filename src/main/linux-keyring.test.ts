import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mkHomeScratch } from '../shared/home-scratch.ts';
import type { SecretServiceState } from '../shared/password-store.ts';
import { PROBE_TIMEOUT_MS, probeEnv, probeSecretService, selectLinuxPasswordStore, sessionBusKind, sessionBusReachable, usableBusAddress } from './linux-keyring.ts';

// #389 — the impure half of the keyring selection: the REAL probe code path (a real child process) against a
// stub `gdbus`, and the switch application against a fake `app.commandLine`.

const scratch = mkHomeScratch('linux-keyring-');
after(() => fs.rmSync(scratch, { recursive: true, force: true }));

/** A stub `gdbus` executable; returns its path. `body` is the shell script after the shebang. */
function stub(name: string, body: string): string {
  const f = path.join(scratch, name);
  fs.writeFileSync(f, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return f;
}

test('probe: the stub answers (<false>,) → unlocked, (<true>,) → locked', () => {
  assert.equal(probeSecretService({ program: stub('g-unlocked', 'echo "(<false>,)"') }), 'unlocked');
  assert.equal(probeSecretService({ program: stub('g-locked', 'echo "(<true>,)"') }), 'locked');
});

test('probe: asks the DEFAULT collection for Locked over the session bus, read-only (Properties.Get)', () => {
  const argvFile = path.join(scratch, 'argv.txt');
  probeSecretService({ program: stub('g-argv', `printf '%s\\n' "$@" > '${argvFile}'; echo "(<false>,)"`) });
  const argv = fs.readFileSync(argvFile, 'utf8').split('\n');
  const after = (flag: string) => argv[argv.indexOf(flag) + 1];
  assert.equal(argv[0], 'call');
  assert.ok(argv.includes('--session'));
  assert.equal(after('--dest'), 'org.freedesktop.secrets');
  assert.equal(after('--object-path'), '/org/freedesktop/secrets/aliases/default');
  assert.equal(after('--method'), 'org.freedesktop.DBus.Properties.Get');
  assert.deepEqual(argv.slice(argv.indexOf('org.freedesktop.Secret.Collection')).slice(0, 2), ['org.freedesktop.Secret.Collection', 'Locked']);
  assert.ok(!argv.some((a) => /GetSecret|CreateItem|Unlock|SearchItems/.test(a)), 'never calls a method that could prompt or write');
});

test('probe: error exit, junk output and a missing gdbus are all unavailable (never throws)', () => {
  assert.equal(probeSecretService({ program: stub('g-fail', 'echo "Error: ServiceUnknown" >&2; exit 1') }), 'unavailable');
  assert.equal(probeSecretService({ program: stub('g-junk', 'echo "something else"') }), 'unavailable');
  assert.equal(probeSecretService({ program: path.join(scratch, 'no-such-gdbus') }), 'unavailable');
});

test('probe: a HUNG gdbus is killed at the timeout and reads unavailable — startup is bounded', () => {
  const pidFile = path.join(scratch, 'hung.pid');
  const hung = stub('g-hang', `echo $$ > '${pidFile}'; exec sleep 30`);
  const t0 = Date.now();
  const state = probeSecretService({ program: hung, timeoutMs: 400 });
  const ms = Date.now() - t0;
  assert.equal(state, 'unavailable');
  assert.ok(ms < 2500, `returned after ${ms} ms (timeout 400 ms; a 30 s hang would have been the stall)`);
  const pid = Number(fs.readFileSync(pidFile, 'utf8'));
  assert.throws(() => process.kill(pid, 0), /ESRCH/, 'the hung child was killed, not left running');
});

test('the shipped probe bound is short (a locked/hung service may never cost startup more than ~1.5 s)', () => {
  assert.ok(PROBE_TIMEOUT_MS <= 2000);
});

// ---- the switch ---------------------------------------------------------------------------------

function fakeDeps(over: Partial<Parameters<typeof selectLinuxPasswordStore>[0]> & { state?: SecretServiceState }) {
  const appended: Array<[string, string]> = [];
  const exportedAddrs: string[] = [];
  let probes = 0;
  const deps = {
    platform: 'linux' as NodeJS.Platform,
    env: { DBUS_SESSION_BUS_ADDRESS: 'unix:path=/x', XDG_CURRENT_DESKTOP: 'sway' } as NodeJS.ProcessEnv,
    argv: ['electron', '.'],
    hasSwitch: () => false,
    appendSwitch: (n: string, v: string) => void appended.push([n, v]),
    exportBusAddress: (a: string) => void exportedAddrs.push(a),
    probe: () => (probes++, over.state ?? 'unlocked'),
    ...over,
  };
  return { deps, appended, exportedAddrs, probes: () => probes };
}

test('select: sway + unlocked → appends --password-store=gnome-libsecret once, and reports the probe cost', () => {
  const f = fakeDeps({ state: 'unlocked' });
  const d = selectLinuxPasswordStore(f.deps);
  assert.deepEqual(f.appended, [['password-store', 'gnome-libsecret']]);
  assert.equal(d?.reason, 'unlocked-service');
  assert.equal(typeof d?.probeMs, 'number');
  assert.equal(d?.facts, 'desktop="sway" session="" bus=env', 'the startup log line can say what the decision saw');
});

test('select: sway + locked / unavailable → appends nothing', () => {
  for (const state of ['locked', 'unavailable'] as const) {
    const f = fakeDeps({ state });
    selectLinuxPasswordStore(f.deps);
    assert.deepEqual(f.appended, [], state);
  }
});

test('select: an explicit switch (commandLine or argv) → nothing appended, probe never runs', () => {
  const a = fakeDeps({ hasSwitch: (n) => n === 'password-store' });
  assert.equal(selectLinuxPasswordStore(a.deps)?.reason, 'explicit-switch');
  const b = fakeDeps({ argv: ['electron', '.', '--password-store=basic'] });
  assert.equal(selectLinuxPasswordStore(b.deps)?.reason, 'explicit-switch');
  for (const f of [a, b]) {
    assert.deepEqual(f.appended, []);
    assert.equal(f.probes(), 0);
  }
});

test('select: not Linux → null, nothing appended, probe never runs', () => {
  const f = fakeDeps({ platform: 'darwin' });
  assert.equal(selectLinuxPasswordStore(f.deps), null);
  assert.deepEqual(f.appended, []);
  assert.equal(f.probes(), 0);
});

test('select: a recognised desktop → nothing appended, probe never runs', () => {
  const f = fakeDeps({ env: { DBUS_SESSION_BUS_ADDRESS: 'unix:path=/x', XDG_CURRENT_DESKTOP: 'KDE' } });
  assert.equal(selectLinuxPasswordStore(f.deps)?.reason, 'recognised-desktop');
  assert.deepEqual(f.appended, []);
  assert.equal(f.probes(), 0);
});

test('sessionBusReachable: the env address, or a real socket at $XDG_RUNTIME_DIR/bus; nothing else', async () => {
  assert.equal(sessionBusReachable({ DBUS_SESSION_BUS_ADDRESS: 'unix:path=/x' }), true);
  assert.equal(sessionBusKind({ DBUS_SESSION_BUS_ADDRESS: 'unix:path=/x' }), 'env');
  assert.equal(sessionBusReachable({ DBUS_SESSION_BUS_ADDRESS: '  ' }), false);
  assert.equal(sessionBusReachable({}), false);
  const run = path.join(scratch, 'run');
  fs.mkdirSync(run, { recursive: true });
  assert.equal(sessionBusReachable({ XDG_RUNTIME_DIR: run }), false, 'no bus file');
  fs.writeFileSync(path.join(run, 'bus'), '');
  assert.equal(sessionBusReachable({ XDG_RUNTIME_DIR: run }), false, 'a regular file named bus is not a socket');
  fs.rmSync(path.join(run, 'bus'));
  const net = await import('node:net');
  const srv = net.createServer().listen(path.join(run, 'bus'));
  await new Promise((r) => srv.once('listening', r));
  try {
    assert.equal(sessionBusReachable({ XDG_RUNTIME_DIR: run }), true, 'a socket at $XDG_RUNTIME_DIR/bus (no address env)');
    assert.equal(sessionBusKind({ XDG_RUNTIME_DIR: run }), 'runtime-dir');
  } finally {
    await new Promise((r) => srv.close(r));
  }
});

test('select: sway session with ONLY the runtime-dir bus socket (this host\'s shape) reaches the probe and selects libsecret', async () => {
  const run = path.join(scratch, 'run2');
  fs.mkdirSync(run, { recursive: true });
  const net = await import('node:net');
  const srv = net.createServer().listen(path.join(run, 'bus'));
  await new Promise((r) => srv.once('listening', r));
  try {
    const f = fakeDeps({ env: { XDG_RUNTIME_DIR: run } as NodeJS.ProcessEnv, state: 'unlocked' });
    const d = selectLinuxPasswordStore(f.deps);
    assert.equal(d?.reason, 'unlocked-service');
    assert.deepEqual(f.appended, [['password-store', 'gnome-libsecret']]);
    assert.deepEqual(f.exportedAddrs, [`unix:path=${run}/bus`], 'libsecret is given the bus it was probed on');
    assert.match(d!.facts, /bus=runtime-dir \(exported\)/);
    // …and an env that already carries a real address is left alone
    const g = fakeDeps({ state: 'unlocked' });
    selectLinuxPasswordStore(g.deps);
    assert.deepEqual(g.exportedAddrs, []);
    // …nothing is exported when libsecret was not selected
    const h = fakeDeps({ env: { XDG_RUNTIME_DIR: run } as NodeJS.ProcessEnv, state: 'locked' });
    selectLinuxPasswordStore(h.deps);
    assert.deepEqual(h.exportedAddrs, []);
  } finally {
    await new Promise((r) => srv.close(r));
  }
});

test('Electron sets DBUS_SESSION_BUS_ADDRESS="disabled:" when the launcher exported none — that is NOT an address', async () => {
  assert.equal(usableBusAddress({ DBUS_SESSION_BUS_ADDRESS: 'disabled:' }), null);
  assert.equal(usableBusAddress({ DBUS_SESSION_BUS_ADDRESS: 'unix:path=/x' }), 'unix:path=/x');
  assert.equal(sessionBusKind({ DBUS_SESSION_BUS_ADDRESS: 'disabled:' }), 'none', 'disabled: and no runtime-dir socket → no bus');
  assert.equal(sessionBusReachable({ DBUS_SESSION_BUS_ADDRESS: 'disabled:' }), false);
  const run = path.join(scratch, 'run3');
  fs.mkdirSync(run, { recursive: true });
  const net = await import('node:net');
  const srv = net.createServer().listen(path.join(run, 'bus'));
  await new Promise((r) => srv.once('listening', r));
  try {
    const env = { DBUS_SESSION_BUS_ADDRESS: 'disabled:', XDG_RUNTIME_DIR: run } as NodeJS.ProcessEnv;
    assert.equal(sessionBusKind(env), 'runtime-dir', 'disabled: + a runtime-dir socket → the runtime-dir bus');
    assert.equal(probeEnv(env).DBUS_SESSION_BUS_ADDRESS, `unix:path=${run}/bus`, 'the probe child is pointed at that socket explicitly');
    assert.equal(env.DBUS_SESSION_BUS_ADDRESS, 'disabled:', 'the process env itself is not touched by the probe');
    const real = { DBUS_SESSION_BUS_ADDRESS: 'unix:path=/elsewhere', XDG_RUNTIME_DIR: run } as NodeJS.ProcessEnv;
    assert.equal(probeEnv(real), real, 'a real address is passed through unchanged');
  } finally {
    await new Promise((r) => srv.close(r));
  }
});

test('select: an ISOLATED instance (ORCHESTRA_HOME) with a reachable runtime-dir bus appends --password-store=basic, never probes, never exports the bus — also on a recognised desktop', async () => {
  const run = path.join(scratch, 'run4');
  fs.mkdirSync(run, { recursive: true });
  const net = await import('node:net');
  const srv = net.createServer().listen(path.join(run, 'bus'));
  await new Promise((r) => srv.once('listening', r));
  try {
    for (const desktop of ['', 'sway', 'GNOME', 'KDE']) {
      const f = fakeDeps({ env: { XDG_RUNTIME_DIR: run, XDG_CURRENT_DESKTOP: desktop, ORCHESTRA_HOME: '/scratch-home', DBUS_SESSION_BUS_ADDRESS: 'disabled:' } as NodeJS.ProcessEnv, state: 'unlocked' });
      const d = selectLinuxPasswordStore(f.deps);
      assert.equal(d?.reason, 'isolated-instance', desktop);
      assert.deepEqual(f.appended, [['password-store', 'basic']], `desktop "${desktop}": Chromium's own choice is overridden, not kept`);
      assert.deepEqual(f.exportedAddrs, [], 'the bus address is not exported for basic');
      assert.equal(f.probes(), 0);
      assert.doesNotMatch(d!.facts, /exported/);
    }
  } finally {
    await new Promise((r) => srv.close(r));
  }
});
