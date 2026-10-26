import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildArms,
  buildFixture,
  evaluate,
  markPhase,
  mountPointsFromMountinfo,
  queryPrivateBus,
  readProc,
  realAccessors,
  realDeps,
  requirePhase,
  selftest,
  type Fixture,
  type HostDeps,
} from './keyring-rig-preflight-host.ts';
import { touchesUserRuntime } from '../shared/keyring-rig-preflight.ts';

// #389 preflight, host half. ONE table of arms (buildArms) drives the self-test, these tests, and the mutants: every clause has a must-FAIL arm over a
// REAL scratch tree (temp dirs + a real unix socket) with a FAKE process table and a FAKE private bus. Nothing here starts a bus, a keyring daemon or a real
// `gdbus`, and nothing opens or stats /run/user/<uid> — that is itself asserted, over the whole table.

const f: Fixture = await buildFixture();
after(() => f.close());
const here = path.dirname(new URL(import.meta.url).pathname);
const repo = path.resolve(here, '..', '..');

const names = (xs: { clause: string }[]) => [...new Set(xs.map((x) => x.clause))];

test('THE TABLE: every arm behaves — the positives pass, each must-FAIL arm aborts with the clause it names', () => {
  const arms = buildArms(f);
  assert.ok(arms.length >= 50, `${arms.length} arms`);
  const bad: string[] = [];
  for (const a of arms) {
    const v = evaluate(a.spec, a.deps);
    const fired = names(v.violations);
    const ok = a.expect === 'pass' ? v.ok : !v.ok && fired.includes(a.expect);
    if (!ok) bad.push(`${a.name}: expected ${a.expect}, got ${v.ok ? 'pass' : fired.join('+')}`);
  }
  assert.deepEqual(bad, []);
  const clauses = new Set(arms.map((a) => a.expect).filter((e) => e !== 'pass'));
  for (const c of ['runtime-dir-scratch', 'rig-dir-no-mounts', 'bus-address-private', 'bus-socket-private', 'child-env-clean', 'bus-daemon-in-scratch', 'secrets-owner-in-scratch', 'owner-expected']) {
    assert.ok(clauses.has(c), `the table has a must-FAIL arm for ${c}`);
  }
});

test('NEVER TOUCHES THE REAL RUNTIME DIR: across the WHOLE table no accessor is called with a path that can name /run/user, and every spawn goes to a private socket', () => {
  const touched: string[] = [];
  const spawned: string[] = [];
  const wrap = (d: HostDeps): HostDeps => ({
    ...d,
    acc: {
      ...d.acc,
      realpath: (p) => (touched.push(p), d.acc.realpath(p)),
      kind: (p) => (touched.push(p), d.acc.kind(p)),
      dirInfo: (p) => (touched.push(p), d.acc.dirInfo(p)),
      readText: (p) => (touched.push(p), d.acc.readText(p)),
    },
    spawn: (c, a, o) => (spawned.push(o.env.DBUS_SESSION_BUS_ADDRESS ?? ''), d.spawn(c, a, o)),
  });
  for (const a of buildArms(f)) evaluate(a.spec, wrap(a.deps));
  assert.deepEqual(touched.filter((p) => touchesUserRuntime(p) || /^\/(?:var\/)?run\/user/.test(path.resolve(p))), [], 'an accessor was asked about the per-user runtime dir');
  assert.ok(touched.length > 100, 'the spy is wired');
  assert.ok(spawned.length > 0 && spawned.every((s) => s.startsWith(`unix:path=${f.rigDir}`) || s.startsWith(`unix:path=${fs.realpathSync(f.rigDir)}`)), `spawns: ${[...new Set(spawned)].join(', ')}`);
  assert.ok(!spawned.some((s) => touchesUserRuntime(s)));
});

test('SELFTEST: all arms behave, through the SAME evaluate', async () => {
  const r = await selftest();
  assert.deepEqual(r.arms.filter((a) => !a.ok), []);
  assert.ok(r.ok && r.arms.length >= 50);
});

test('GUARD: queryPrivateBus REFUSES — throws and spawns nothing — for the real bus, a path outside the scratch dir, a SYMLINK to the private socket, a socket reached through a link, a missing socket', () => {
  buildArms(f); // creates the link fixtures
  const calls: string[] = [];
  const d: HostDeps = { ...realDeps, spawn: (c) => (calls.push(c), { status: 0, stdout: '', stderr: '' }) };
  const run = fs.realpathSync(f.run);
  const elsewhere = path.join(f.root, 'elsewhere');
  for (const p of ['/run/user/1000/bus', '/run//user/1000/bus', path.join(elsewhere, 'bus'), path.join(run, 'linkbus'), path.join(run, 'linkdir', 'bus'), path.join(run, 'ghost'), 'relative/bus', '']) {
    assert.throws(() => queryPrivateBus(d, p, run, 'GetNameOwner', 'org.freedesktop.secrets'), /not the rig's private bus socket/, p);
  }
  assert.equal(calls.length, 0, 'not one process was spawned for a refused path');
});

test('queryPrivateBus asks ONLY the private bus: allowlist env (the address, the scratch runtime dir), a bounded timeout, nothing naming /run/user', () => {
  const calls: Array<{ cmd: string; args: string[]; env: NodeJS.ProcessEnv }> = [];
  const d: HostDeps = { ...realDeps, spawn: (cmd, args, o) => (calls.push({ cmd, args, env: o.env }), { status: 0, stdout: "(':1.1',)", stderr: '' }) };
  queryPrivateBus(d, fs.realpathSync(f.bus), fs.realpathSync(f.run), 'GetNameOwner', 'org.freedesktop.secrets');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, 'gdbus');
  assert.deepEqual(Object.keys(calls[0].env).sort(), ['DBUS_SESSION_BUS_ADDRESS', 'LANG', 'PATH', 'XDG_RUNTIME_DIR']);
  assert.ok(calls[0].args.includes('--timeout') && calls[0].args.includes('org.freedesktop.DBus.GetNameOwner'));
  assert.ok(!JSON.stringify(calls[0]).includes('/run/user/'));
});

test('CONTACT IS BOUNDED: a failed static clause → 0 spawns; phase pre → 0 spawns; a wrong bus daemon → exactly ONE question (no second query)', () => {
  const arms = buildArms(f);
  const counted = (a: (typeof arms)[number]) => { let n = 0; const d: HostDeps = { ...a.deps, spawn: (c, args, o) => (n++, a.deps.spawn(c, args, o)) }; evaluate(a.spec, d); return n; };
  const by = (name: string) => arms.find((x) => x.name === name)!;
  assert.equal(counted(by('the REAL per-user runtime dir')), 0);
  assert.equal(counted(by('a bus path whose final component is a SYMLINK')), 0);
  assert.equal(counted(by('an app env carrying the real bus')), 0);
  assert.equal(counted(by('POSITIVE: phase pre contacts nothing and passes with no bus yet')), 0);
  assert.equal(counted(by('a bus daemon that is not a dbus-daemon (a forwarder)')), 1, 'the bus-daemon answer ends the preflight');
  assert.equal(counted(by('a bus daemon with a config outside the rig dir')), 1);
  assert.equal(counted(by('POSITIVE: a private world with its own daemon')), 3, 'the bus daemon, the owner of the secrets name, that owner\'s pid — and nothing else');
});

test('PHASES: markers are written only by a passing phase; requirePhase refuses a later phase without the earlier ones', () => {
  const dir = path.join(f.root, 'phase-rig');
  fs.mkdirSync(dir);
  assert.throws(() => requirePhase(dir, 'pre'), /phase "pre" has not passed/);
  markPhase(dir, 'pre');
  requirePhase(dir, 'pre');
  assert.throws(() => requirePhase(dir, 'bus'), /phase "bus" has not passed/);
  assert.throws(() => requirePhase(dir, 'daemon'), /phase "bus" has not passed/);
  markPhase(dir, 'bus');
  requirePhase(dir, 'bus');
  assert.throws(() => requirePhase(dir, 'daemon'), /phase "daemon" has not passed/);
  markPhase(dir, 'daemon');
  requirePhase(dir, 'daemon');
});

test('mountPointsFromMountinfo: field 5, octal escapes decoded (a mount inside the rig dir is how a bind mount would alias the runtime dir)', () => {
  const text = '36 35 98:0 /mnt1 /mnt2 rw,noatime master:1 - ext3 /dev/root rw\n40 35 0:30 / /home/x/rig/arm/run\\040dir rw - tmpfs tmpfs rw\n\n';
  assert.deepEqual(mountPointsFromMountinfo(text), ['/mnt2', '/home/x/rig/arm/run dir']);
  assert.ok(realAccessors.mountPoints().length > 0, 'the real /proc/self/mountinfo is readable here');
});

test('readProc reads exe / argv / the ORIGINAL XDG_RUNTIME_DIR of a real process (this one), and null for a pid that is gone', () => {
  const me = readProc(process.pid)!;
  assert.equal(me.exe, fs.realpathSync(process.execPath));
  assert.ok(me.cmdline.length >= 1 && /node/.test(me.cmdline[0]));
  assert.equal(me.runtimeDir, process.env.XDG_RUNTIME_DIR ?? null);
  assert.equal(readProc(2 ** 22 + 12345), null);
});

// ── the CLI: it must ABORT, never silently exit 0 ─────────────────────────────────────────────────────────────────────────────────────────────────────────

const NODE = ['--experimental-strip-types', '--disable-warning=ExperimentalWarning', '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON'];
const cli = (script: string, args: string[]) => spawnSync(process.execPath, [...NODE, script, ...args], { encoding: 'utf8', timeout: 60000, env: { PATH: '/usr/bin:/bin', HOME: os.tmpdir(), TMPDIR: os.tmpdir() } });

test('CLI: usage → 2; selftest → 0; a spec that does not exist → 2; a real-runtime spec → 3 naming the clause — also through a SYMLINKED script path and a path with a SPACE (the old main-module guard exited 0 silently)', () => {
  const script = path.join(repo, 'scripts', 'keyring-rig-preflight.mjs');
  const spaced = path.join(f.root, 'a b');
  fs.mkdirSync(spaced);
  const linkDir = path.join(f.root, 'scripts-link');
  fs.symlinkSync(path.join(repo, 'scripts'), linkDir);
  const spaceLink = path.join(spaced, 'preflight.mjs');
  fs.symlinkSync(script, spaceLink);
  const bad = path.join(f.root, 'bad-spec.json');
  fs.writeFileSync(bad, JSON.stringify({ rigDir: f.rigDir, phase: 'pre', toolEnv: { ...f.tool, XDG_RUNTIME_DIR: '/run/user/1000' }, children: [], expectOwner: true }));
  const good = path.join(f.root, 'good-spec.json');
  fs.writeFileSync(good, JSON.stringify({ rigDir: f.rigDir, phase: 'pre', toolEnv: f.tool, children: [], expectOwner: true }));
  for (const s of [script, path.join(linkDir, 'keyring-rig-preflight.mjs'), spaceLink]) {
    assert.equal(cli(s, []).status, 2, `usage via ${s}`);
    const st = cli(s, ['selftest']);
    assert.equal(st.status, 0, `selftest via ${s}: ${st.stderr.slice(0, 300)}`);
    assert.match(st.stdout, /SELFTEST OK: \d+ arms/);
    assert.equal(cli(s, ['check', '--spec', path.join(f.root, 'no-such.json')]).status, 2, `missing spec via ${s}`);
    const abort = cli(s, ['check', '--spec', bad]);
    assert.equal(abort.status, 3, `real-runtime spec via ${s}: ${abort.stdout}${abort.stderr}`);
    assert.match(abort.stdout, /PREFLIGHT ABORT: \[runtime-dir-scratch\]/);
    const ok = cli(s, ['check', '--spec', good]);
    assert.equal(ok.status, 0, `clean pre spec via ${s}: ${ok.stdout}${ok.stderr}`);
    assert.match(ok.stdout, /PREFLIGHT OK/);
    assert.ok(fs.existsSync(path.join(f.rigDir, '.keyring-preflight-pre.ok')), 'a passing phase writes its marker');
    fs.rmSync(path.join(f.rigDir, '.keyring-preflight-pre.ok'), { force: true });
  }
});
