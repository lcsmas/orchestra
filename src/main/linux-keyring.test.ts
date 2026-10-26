import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mkHomeScratch } from '../shared/home-scratch.ts';
import type { SecretServiceState } from '../shared/password-store.ts';
import { DBUS_CALL_TIMEOUT_S, PROBE_WAIT_MS, WAIT_ONLY_SH, probeEnv, probeSecretService, selectLinuxPasswordStore, sessionBusKind, sessionBusReachable, usableBusAddress } from './linux-keyring.ts';

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
  assert.equal(probeSecretService({ program: stub('g-answer-then-fail', 'echo "(<false>,)"; exit 1') }), 'unavailable', 'the output of a call that FAILED is not trusted');
  assert.equal(probeSecretService({ program: path.join(scratch, 'no-such-gdbus') }), 'unavailable');
});

/** Is `pid` a live, non-zombie process? */
const alive = (pid: number) => {
  try {
    return !/^State:\s*Z/m.test(fs.readFileSync(`/proc/${pid}/status`, 'utf8'));
  } catch {
    return false;
  }
};
const sleepMs = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(pred: () => boolean, ms: number): Promise<boolean> {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) return false;
    await sleepMs(50);
  }
  return true;
}
/** A stub daemon client that answers `answer` after `delaySec` seconds, records its pid, notes any signal it receives (a trap runs once its `sleep` ends,
 *  so the test waits for `done`), and writes `done` when it has finished its own call. */
function slowStub(name: string, delaySec: number, answer = '(<false>,)', extra = ''): { program: string; pidFile: string; sigFile: string; doneFile: string } {
  const pidFile = path.join(scratch, `${name}.pid`), sigFile = path.join(scratch, `${name}.sig`), doneFile = path.join(scratch, `${name}.done`);
  const program = stub(name, `echo $$ > '${pidFile}'\n${extra}trap 'echo SIGNALLED >> '${sigFile}'' TERM INT HUP\nsleep ${delaySec}\necho "${answer}"\necho finished > '${doneFile}'`);
  return { program, pidFile, sigFile, doneFile };
}

test('probe: a daemon that answers LATE (after the parent stopped waiting) → unavailable at the deadline; the child is NEVER signalled, it finishes its own call and exits by itself', async () => {
  const s = slowStub('g-late', 3);
  const t0 = Date.now();
  const state = probeSecretService({ program: s.program, waitMs: 1000 });
  const ms = Date.now() - t0;
  assert.equal(state, 'unavailable');
  assert.ok(ms >= 900 && ms < 2500, `returned after ${ms} ms (deadline 1000 ms)`);
  const pid = Number(fs.readFileSync(s.pidFile, 'utf8'));
  assert.ok(alive(pid), 'the child is still running when the parent gives up — its call was not abandoned');
  assert.ok(await until(() => fs.existsSync(s.doneFile), 8000), 'the orphaned child ran its call to completion');
  assert.ok(!fs.existsSync(s.sigFile), 'no signal was ever sent to it');
  assert.ok(await until(() => !alive(pid), 3000), 'and it exited by itself (no zombie left)');
});

test('probe: a daemon that NEVER answers → unavailable at the deadline, child untouched (alive, unsignalled); startup block is the deadline, not the daemon', async () => {
  const s = slowStub('g-never', 6);
  const t0 = Date.now();
  assert.equal(probeSecretService({ program: s.program, waitMs: 500 }), 'unavailable');
  const ms = Date.now() - t0;
  assert.ok(ms < 2000, `returned after ${ms} ms`);
  const pid = Number(fs.readFileSync(s.pidFile, 'utf8'));
  await sleepMs(600);
  assert.ok(alive(pid), 'still alive well after the deadline');
  assert.ok(!fs.existsSync(s.sigFile), 'never signalled');
  process.kill(pid, 'SIGKILL'); // test cleanup only
});

test('probe: an answer INSIDE the deadline is used (the common case: a few ms)', () => {
  const s = slowStub('g-quick', 0.3, '(<true>,)');
  assert.equal(probeSecretService({ program: s.program, waitMs: 3000 }), 'locked');
});

test('probe: a child that IGNORES SIGTERM cannot block the main thread — the parent never waits on it past the deadline (and never signals it)', () => {
  const pidFile = path.join(scratch, 'g-deaf.pid');
  const deaf = stub('g-deaf', `echo $$ > '${pidFile}'; trap '' TERM INT HUP; sleep 4`);
  const t0 = Date.now();
  assert.equal(probeSecretService({ program: deaf, waitMs: 400 }), 'unavailable');
  assert.ok(Date.now() - t0 < 1800, `returned after ${Date.now() - t0} ms`);
});

test('the shipped probe NEVER abandons an in-flight call: gdbus gets a LONG timeout (it sends an Introspect first, then the Get), the wrapper never kills, the parent only stops waiting', () => {
  assert.ok(Number(DBUS_CALL_TIMEOUT_S) >= 25, 'a vanished client mid-Properties.Get aborted the human\'s gnome-keyring-daemon twice');
  assert.ok(PROBE_WAIT_MS >= 1000 && PROBE_WAIT_MS <= 6000, `the main thread blocks at most ${PROBE_WAIT_MS} ms`);
  assert.doesNotMatch(WAIT_ONLY_SH, /\bkill\b/, 'the wait-only wrapper contains no kill at all');
  assert.doesNotMatch(WAIT_ONLY_SH, /\btimeout\b/, 'and no `timeout` wrapper (it SIGTERMs)');
  let seen: { args: string[]; opts: Record<string, unknown> } | null = null;
  const fake = ((_cmd: string, args: string[], opts: Record<string, unknown>) => {
    seen = { args, opts };
    const out = args[args.indexOf('probe') + 1];
    fs.writeFileSync(out, '(<false>,)');
    return { status: 0, error: undefined };
  }) as unknown as typeof import('node:child_process').spawnSync;
  assert.equal(probeSecretService({ spawn: fake }), 'unlocked');
  const { args, opts } = seen as unknown as { args: string[]; opts: Record<string, unknown> };
  assert.equal(args[args.indexOf('--timeout') + 1], DBUS_CALL_TIMEOUT_S, 'gdbus is told the long timeout');
  assert.equal(args[args.indexOf('probe') + 2], String(Math.ceil(PROBE_WAIT_MS / 100)), 'the parent waits PROBE_WAIT_MS');
  assert.ok(Number(opts.timeout) > PROBE_WAIT_MS, 'the wrapper backstop sits above the wait');
  assert.deepEqual(opts.stdio, ['ignore', 'ignore', 'ignore'], 'no pipe is shared with the child (spawnSync would wait for its EOF)');
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
