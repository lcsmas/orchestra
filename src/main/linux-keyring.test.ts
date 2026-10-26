import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mkHomeScratch } from '../shared/home-scratch.ts';
import type { SecretServiceState } from '../shared/password-store.ts';
import { DBUS_CALL_TIMEOUT_S, PROBE_WAIT_MS, QUICK_FAIL_MS, WAIT_ONLY_SH, classifyProbeAttempt, makeProbeDir, probeEnv, probeSecretService, selectLinuxPasswordStore, sessionBusKind, sessionBusReachable, usableBusAddress } from './linux-keyring.ts';

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
  assert.equal(probeSecretService({ program: stub('g-fail', 'echo "Error: GDBus.Error:org.freedesktop.DBus.Error.ServiceUnknown: The name is not activatable" >&2; exit 1') }), 'unavailable');
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
  assert.match(WAIT_ONLY_SH, /sleep 0\.01\b/, 'polls every 10 ms (a real answer costs its round trip, not a 100 ms tick)');
  assert.doesNotMatch(WAIT_ONLY_SH, /sleep 0\.1\b/);
  assert.match(WAIT_ONLY_SH, /\/proc\/uptime/, 'the deadline is wall-clock (read with the `read` builtin: no fork to fail under process pressure)');
  assert.doesNotMatch(WAIT_ONLY_SH, /\bgrep\b/, 'and `alive` forks nothing');
  assert.match(WAIT_ONLY_SH, /2>"\$err"/, 'gdbus stderr goes to a file (its first line is reported), not /dev/null');
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
  assert.equal(args[args.indexOf('probe') + 3], String(Math.ceil(PROBE_WAIT_MS / 10)), 'the parent waits PROBE_WAIT_MS (centiseconds, a wall-clock deadline)');
  assert.ok(Number(opts.timeout) > PROBE_WAIT_MS, 'the wrapper backstop sits above the wait');
  assert.deepEqual(opts.stdio, ['ignore', 'ignore', 'ignore'], 'no pipe is shared with the child (spawnSync would wait for its EOF)');
});

// A scratch parent that cannot take a mkdtemp: a regular FILE (ENOTDIR) — a real error, no permissions trick needed.
function unusableBase(name: string): string {
  const f = path.join(scratch, name);
  fs.writeFileSync(f, 'not a dir');
  return path.join(f, 'tmp');
}

test('probe scratch dir: an unusable TMPDIR falls back to the next base, each failure is NOTED, and the first usable base wins (#389 round-4 MINOR)', () => {
  const bad = unusableBase('tmpdir-is-a-file');
  const good = { dir: path.join(scratch, 'fallback-base'), create: true as const }; // missing: a `create` base is made
  const notes: string[] = [];
  const dir = makeProbeDir([bad, good], (m) => notes.push(m));
  assert.ok(dir && dir.startsWith(good.dir + path.sep) && fs.statSync(dir).isDirectory(), `got ${dir}`);
  assert.equal(fs.statSync(good.dir).mode & 0o777, 0o700, 'a base we create is private');
  assert.equal(notes.length, 1);
  assert.match(notes[0], /^mkdtemp .*tmpdir-is-a-file\/tmp: ENOTDIR$/);
  assert.equal(makeProbeDir([bad, unusableBase('also-a-file')], (m) => notes.push(m)), null, 'every base unusable → null, not a throw');
  assert.equal(notes.length, 3);
});

test('probe: a healthy keyring is still READ when TMPDIR is unusable (fallback base), and the failure is reported; no base at all → unavailable', () => {
  const notes: string[] = [];
  const bad = unusableBase('tmp-bad-2');
  const good = { dir: path.join(scratch, 'fallback-2'), create: true as const };
  assert.equal(probeSecretService({ program: stub('g-fb', 'echo "(<false>,)"'), scratchDirs: [bad, good], note: (m) => notes.push(m) }), 'unlocked');
  assert.equal(notes.length, 1, 'the unusable TMPDIR is logged, never swallowed');
  const left = fs.readdirSync(good.dir).filter((n) => n.startsWith('orch-secret-probe-'));
  assert.deepEqual(left, [], 'the fallback scratch dir is cleaned up');
  assert.equal(probeSecretService({ program: stub('g-fb2', 'echo "(<false>,)"'), scratchDirs: [bad] }), 'unavailable', 'nowhere to write → unavailable (documented), never a throw');
});

test('probe scratch dir: a MISSING plain base (e.g. $XDG_RUNTIME_DIR) is never created — only a `create` base is', () => {
  const missingRuntime = path.join(scratch, 'no-such-xdg-runtime');
  const notes: string[] = [];
  assert.equal(makeProbeDir([missingRuntime], (m) => notes.push(m)), null);
  assert.equal(fs.existsSync(missingRuntime), false, 'the session\'s runtime dir is not ours to create');
  assert.match(notes[0], /ENOENT/);
  const userData = path.join(scratch, 'userdata-create');
  const dir = makeProbeDir([missingRuntime, { dir: userData, create: true }]);
  assert.ok(dir && dir.startsWith(userData + path.sep), `fell through to the create base: ${dir}`);
});

test('select: probe scratch failures reach the startup-log facts (real default probe, stub gdbus on PATH); a healthy TMPDIR adds nothing', () => {
  const binDir = path.join(scratch, 'bin-sel');
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(path.join(binDir, 'gdbus'), '#!/bin/sh\necho "(<false>,)"\n', { mode: 0o755 });
  const env = { DBUS_SESSION_BUS_ADDRESS: 'unix:path=/x', XDG_CURRENT_DESKTOP: 'sway', PATH: `${binDir}:/usr/bin:/bin` } as NodeJS.ProcessEnv;
  const select = (extra: string[]) => {
    const f = fakeDeps({ env, extraScratchDirs: extra });
    return selectLinuxPasswordStore({ ...f.deps, probe: undefined });
  };
  const savedTmp = process.env.TMPDIR;
  try {
    process.env.TMPDIR = unusableBase('tmp-bad-3');
    const broken = select([path.join(scratch, 'userdata-fb')]);
    assert.equal(broken?.store, 'gnome-libsecret', 'the healthy keyring is still selected');
    assert.match(broken?.facts ?? '', /probe-notes="mkdtemp .*tmp-bad-3\/tmp: ENOTDIR"/);
    process.env.TMPDIR = scratch;
    assert.doesNotMatch(select([])?.facts ?? '', /probe-notes/);
  } finally {
    if (savedTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = savedTmp;
  }
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

// ── round-6 PRODUCT: a transient spawn/connect failure must not silently pick the plaintext backend ──────────────────────
/** A stub gdbus that counts its invocations in `<name>.count`. `body` runs with `$n` = the 1-based invocation number. */
function countingStub(name: string, body: string): { program: string; count: () => number } {
  const cnt = path.join(scratch, `${name}.count`);
  const program = stub(name, `n=$(cat '${cnt}' 2>/dev/null || echo 0); n=$((n+1)); echo $n > '${cnt}'\n${body}`);
  return { program, count: () => Number(fs.existsSync(cnt) ? fs.readFileSync(cnt, 'utf8') : 0) };
}

test('classifyProbeAttempt: retry ONLY an immediate failure that is not a reply — never a real answer, never a bus reply error, never the deadline', () => {
  const at = (over: Partial<Parameters<typeof classifyProbeAttempt>[0]>) => classifyProbeAttempt({ status: 1, elapsedMs: 6, stdout: '', stderrLine: '', ...over });
  // retried
  assert.equal(at({ spawnError: 'EAGAIN' }).retry, true, 'sh could not even be spawned');
  assert.equal(at({ stderrLine: 'Error connecting: Could not connect: Connection refused' }).retry, true, 'a connect failure');
  assert.equal(at({ status: 127, stderrLine: 'gdbus: not found' }).retry, true, 'a fork/exec failure inside the wrapper');
  assert.equal(at({ status: 3, elapsedMs: 5 }).retry, true, 'the wait-only deadline firing after 5 ms is not the deadline');
  assert.equal(at({ status: 1, elapsedMs: QUICK_FAIL_MS - 1 }).retry, true, 'just under the quick bound');
  // not retried
  assert.equal(at({ status: 0, stdout: '(<true>,)', elapsedMs: 3 }).retry, false, 'a real answer, however fast');
  assert.equal(at({ status: 0, stdout: '(<true>,)' }).state, 'locked');
  assert.equal(at({ stderrLine: 'Error: GDBus.Error:org.freedesktop.DBus.Error.ServiceUnknown: x' }).retry, false, 'the bus ANSWERED: a real "no service"');
  assert.equal(at({ stderrLine: 'Error: GDBus.Error:org.freedesktop.DBus.Error.ServiceUnknown: x' }).note, null, 'and that is not an abnormal outcome (no probe-notes on a normal no-service)');
  assert.equal(at({ status: 3, elapsedMs: 5000 }).retry, false, 'the real wait-only deadline');
  assert.equal(at({ status: 1, elapsedMs: QUICK_FAIL_MS }).retry, false, 'not quick any more');
  assert.equal(at({ status: 0, stdout: 'junk', elapsedMs: 3 }).retry, false, 'an unparseable reply is a reply');
  assert.match(at({ status: 0, stdout: 'junk' }).note ?? '', /unparseable reply "junk"/);
  // what is reported
  assert.match(at({ spawnError: 'ENOMEM' }).note ?? '', /^spawn ENOMEM \(6 ms\)$/);
  assert.match(at({ stderrLine: 'Could not connect: x' }).note ?? '', /^exit 1 \(6 ms\): Could not connect: x$/);
  assert.match(at({ status: 3, elapsedMs: 5000 }).note ?? '', /^wait deadline \(5000 ms\)$/);
});

test('probe: a transient connect failure then a real answer → the answer is used after ONE retry, and both attempts are reported', () => {
  const s = countingStub('g-flaky', 'if [ "$n" = 1 ]; then echo "Error connecting: Could not connect: Connection refused" >&2; exit 1; fi; echo "(<false>,)"');
  const notes: string[] = [];
  const t0 = Date.now();
  assert.equal(probeSecretService({ program: s.program, note: (m) => notes.push(m) }), 'unlocked');
  assert.equal(s.count(), 2, 'exactly one retry');
  assert.ok(Date.now() - t0 >= 100, 'after the retry delay');
  assert.equal(notes.length, 1);
  assert.match(notes[0], /^probe#1 exit 1 \(\d+ ms\): Error connecting: Could not connect: Connection refused — retrying once$/, 'the first attempt\'s status AND its first stderr line are reported');
});

test('probe: a failure that persists is retried ONCE, never more (bounded) → unavailable', () => {
  const s = countingStub('g-down', 'echo "Error connecting: Could not connect: No such file" >&2; exit 1');
  const notes: string[] = [];
  assert.equal(probeSecretService({ program: s.program, note: (m) => notes.push(m) }), 'unavailable');
  assert.equal(s.count(), 2, 'one attempt + one retry, no loop');
  assert.equal(notes.length, 2);
  assert.match(notes[1], /^probe#2 exit 1/);
  assert.doesNotMatch(notes[1], /retrying/);
});

test('probe: NO retry on a real answer (locked / unlocked), a bus reply error, or the wait deadline — exactly one attempt each', async () => {
  const locked = countingStub('g-once-locked', 'echo "(<true>,)"');
  assert.equal(probeSecretService({ program: locked.program }), 'locked');
  assert.equal(locked.count(), 1, 'a real "locked" answer is final');
  const reply = countingStub('g-once-reply', 'echo "Error: GDBus.Error:org.freedesktop.DBus.Error.ServiceUnknown: no" >&2; exit 1');
  const notes: string[] = [];
  assert.equal(probeSecretService({ program: reply.program, note: (m) => notes.push(m) }), 'unavailable');
  assert.equal(reply.count(), 1, 'the bus answered "no such service": final');
  assert.deepEqual(notes, [], 'a normal no-service writes nothing to probe-notes');
  const hang = countingStub('g-once-hang', 'exec /usr/bin/sleep 3');
  assert.equal(probeSecretService({ program: hang.program, waitMs: 600 }), 'unavailable');
  assert.equal(hang.count(), 1, 'the wait deadline is not retried');
  await sleepMs(50);
});

test('probe: the retry spends the SAME overall wait — its wrapper gets the REMAINING budget, not a fresh one', () => {
  const limits: number[] = [];
  let calls = 0;
  const fake = ((_cmd: string, args: string[]) => {
    calls++;
    limits.push(Number(args[args.indexOf('probe') + 3]));
    if (calls === 1) return { status: 1, error: undefined };
    fs.writeFileSync(args[args.indexOf('probe') + 1], '(<false>,)');
    return { status: 0, error: undefined };
  }) as unknown as typeof import('node:child_process').spawnSync;
  assert.equal(probeSecretService({ spawn: fake, waitMs: 2000 }), 'unlocked');
  assert.equal(calls, 2);
  assert.equal(limits[0], 200);
  assert.ok(limits[1] < limits[0] && limits[1] >= 150, `the retry waits at most what is left (${limits[1]} cs of ${limits[0]})`);
  // and a retry that cannot fit is not attempted at all
  calls = 0;
  const fail = (() => { calls++; return { status: 1, error: undefined }; }) as unknown as typeof import('node:child_process').spawnSync;
  assert.equal(probeSecretService({ spawn: fail, waitMs: 300 }), 'unavailable');
  assert.equal(calls, 1, '< 500 ms left: no retry');
});

test('probe: a spawn error of `sh` itself is retried once and reported (EAGAIN under process pressure)', () => {
  let calls = 0;
  const fake = (() => {
    calls++;
    if (calls === 1) return { status: null, error: Object.assign(new Error('spawnSync sh EAGAIN'), { code: 'EAGAIN' }) };
    return { status: 0, error: undefined };
  }) as unknown as typeof import('node:child_process').spawnSync;
  const notes: string[] = [];
  // second attempt reports status 0 but wrote no output → unparseable → unavailable; the point is the retry + the note
  assert.equal(probeSecretService({ spawn: fake, note: (m) => notes.push(m) }), 'unavailable');
  assert.equal(calls, 2);
  assert.match(notes[0], /^probe#1 spawn EAGAIN \(\d+ ms\) — retrying once$/);
});

test('probe: the wait is WALL-CLOCK — a failing `sleep` (fork pressure) cannot end it early (the old iteration-counted loop returned in a few ms)', () => {
  const shim = path.join(scratch, 'shim-bin');
  fs.mkdirSync(shim, { recursive: true });
  fs.writeFileSync(path.join(shim, 'sleep'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  const hang = stub('g-shim-hang', 'exec /usr/bin/sleep 4');
  const t0 = Date.now();
  const state = probeSecretService({ program: hang, waitMs: 600, env: { ...process.env, PATH: `${shim}:${process.env.PATH}` } });
  const ms = Date.now() - t0;
  assert.equal(state, 'unavailable');
  assert.ok(ms >= 550 && ms < 2500, `waited the real 600 ms even though every sleep failed (returned after ${ms} ms)`);
});
