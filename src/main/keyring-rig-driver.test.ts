import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { mkHomeScratch } from '../shared/home-scratch.ts';
import { humanRuntimeDir } from '../shared/keyring-rig-world.ts';

// #389 — the keyring rig's DRIVER, without a compositor, a bus or a daemon: (1) `--preflight-only` black-box (the same entry the rig's `forged`
// arm runs under a hostile env) and (2) source pins for the properties the pure checks cannot see — what the driver is allowed to read.

const repo = path.resolve(import.meta.dirname, '../..');
const read = (p: string): string => fs.readFileSync(path.join(repo, p), 'utf8');
const codeOnly = (src: string): string => src.split('\n').filter((l) => !/^\s*(\/\/|#)/.test(l)).join('\n');
const driver = (): string => codeOnly(read('scripts/e2e-keyring.mjs'));
const launcher = (): string => codeOnly(read('scripts/e2e-keyring.sh'));

const scratch = mkHomeScratch('keyring-rig-driver-');
after(() => fs.rmSync(scratch, { recursive: true, force: true }));

const HUMAN = humanRuntimeDir(1000);

function fakeRig(name: string): { rig: string; env: Record<string, string> } {
  const rig = path.join(scratch, name);
  fs.mkdirSync(path.join(rig, 'xdg'), { recursive: true, mode: 0o700 });
  return {
    rig,
    env: {
      PATH: '/usr/bin:/bin', RIG_DIR: rig, XDG_RUNTIME_DIR: `${rig}/xdg`, DBUS_SESSION_BUS_ADDRESS: `unix:path=${rig}/no-session-bus`,
      WAYLAND_DISPLAY: 'wayland-rig', RIG_WAYLAND: 'wayland-rig', RIG_HIDDEN_WORLD: '1',
    },
  };
}
function preflight(env: Record<string, string | undefined>): { rc: number | null; out: string } {
  const clean: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined) clean[k] = v;
  const r = spawnSync(process.execPath, ['--no-warnings', '--experimental-strip-types', path.join(repo, 'scripts/e2e-keyring.mjs'), '--preflight-only'], { env: clean, encoding: 'utf8', timeout: 30000 });
  return { rc: r.status, out: `${r.stdout}${r.stderr}` };
}

test('driver --preflight-only: the rig-shaped env is accepted (control) and creates / starts nothing', () => {
  const { rig, env } = fakeRig('ok');
  const r = preflight(env);
  assert.equal(r.rc, 0, r.out);
  assert.match(r.out, /\[preflight\] keyring rig world: 6\/6 clauses ok/);
  assert.match(r.out, /PREFLIGHT-OK/);
  assert.deepEqual(fs.readdirSync(rig).sort(), ['xdg'], 'no arm dir, no bus, no daemon state');
  assert.deepEqual(fs.readdirSync(path.join(rig, 'xdg')), [], 'the private runtime dir stays empty');
});

test('hand-off through `env -i` (the rig\'s real shape): RIG_HIDDEN_WORLD lives in the rig bash, NOT in the child env — the driver asks its parent (round-4 rewire BLOCKING 1)', () => {
  const { rig, env } = fakeRig('handoff');
  const { RIG_HIDDEN_WORLD: _drop, ...childEnv } = env; // CHILD_ENV of the contained rig: no RIG_HIDDEN_WORLD (env -i would strip it anyway)
  const kv = Object.entries(childEnv).map(([k, v]) => `${k}=${v}`);
  const run = (parentEnv: Record<string, string>): { rc: number | null; out: string } => {
    // two statements, so bash stays the PARENT of `env … node` (a lone last command would be exec'd); mirrors the rig's `env -i "${CHILD_ENV[@]}" "$@"`
    const r = spawnSync('bash', ['-c', 'env -i "$@"; echo "child-rc=$?"', '_', ...kv, process.execPath, '--no-warnings', '--experimental-strip-types', path.join(repo, 'scripts/e2e-keyring.mjs'), '--preflight-only'], { env: parentEnv, encoding: 'utf8', timeout: 30000 });
    return { rc: Number(/child-rc=(\d+)/.exec(r.stdout)?.[1] ?? NaN), out: `${r.stdout}${r.stderr}` };
  };
  const hidden = run({ PATH: '/usr/bin:/bin', RIG_HIDDEN_WORLD: '1' });
  assert.equal(hidden.rc, 0, hidden.out);
  assert.match(hidden.out, /PREFLIGHT-OK/);
  const plain = run({ PATH: '/usr/bin:/bin' });
  assert.equal(plain.rc, 3, plain.out);
  assert.match(plain.out, /hidden-world/, 'a parent that never ran the hidden-world rig is refused');
  assert.deepEqual(fs.readdirSync(rig).sort(), ['xdg']);
});

test('driver --preflight-only: every forged world is REFUSED (rc 3, naming the clause) before anything is created — forced real XDG_RUNTIME_DIR / DBUS / values', () => {
  const cases: Array<[string, (e: Record<string, string | undefined>, rig: string) => void, RegExp]> = [
    ['real XDG_RUNTIME_DIR', (e) => { e.XDG_RUNTIME_DIR = HUMAN; }, /human's runtime dir/],
    ['XDG under the real dir', (e) => { e.XDG_RUNTIME_DIR = `${HUMAN}/x`; }, /human's runtime dir/],
    ['unset XDG_RUNTIME_DIR', (e) => { delete e.XDG_RUNTIME_DIR; }, /XDG_RUNTIME_DIR unset/],
    ['XDG not the rig\'s', (e, rig) => { e.XDG_RUNTIME_DIR = `${rig}/other`; }, /not the rig's private dir/],
    ['real DBUS address', (e) => { e.DBUS_SESSION_BUS_ADDRESS = `unix:path=${HUMAN}/bus`; }, /dbus-is-the-rigs-nonexistent-address/],
    ['unset DBUS address', (e) => { delete e.DBUS_SESSION_BUS_ADDRESS; }, /dbus-is-the-rigs-nonexistent-address/],
    ['stray value naming the real dir', (e) => { e.GNOME_KEYRING_CONTROL = `${HUMAN}/keyring`; }, /no-env-value-reaches-the-human-runtime \(env keys naming it: GNOME_KEYRING_CONTROL\)/],
    ['real dir inside a PATH list', (e) => { e.PATH = `/usr/bin:${HUMAN}/bin`; }, /no-env-value-reaches-the-human-runtime/],
    ['absolute display path', (e) => { e.WAYLAND_DISPLAY = `${HUMAN}/wayland-1`; }, /display-is-a-bare-private-name/],
    ['X11 reachable', (e) => { e.DISPLAY = ':0'; }, /display-is-a-bare-private-name/],
    ['not in the hidden world', (e) => { delete e.RIG_HIDDEN_WORLD; }, /hidden-world/],
    ['hidden world flag not 1', (e) => { e.RIG_HIDDEN_WORLD = '0'; }, /hidden-world/],
    ['not run through the rig', (e) => { delete e.RIG_DIR; }, /RIG_DIR unset/],
    ['the no-bus path exists', (e, rig) => { fs.writeFileSync(`${rig}/no-session-bus`, ''); }, /dbus-is-the-rigs-nonexistent-address/],
  ];
  for (const [name, mut, expect] of cases) {
    const { rig, env } = fakeRig(`forged-${name.replace(/\W+/g, '-')}`);
    const e: Record<string, string | undefined> = { ...env };
    mut(e, rig);
    const before = fs.readdirSync(rig).sort().join(',');
    const r = preflight(e);
    assert.equal(r.rc, 3, `${name}: rc ${r.rc}\n${r.out}`);
    assert.match(r.out, /^REFUSED: /m, name);
    assert.match(r.out, expect, name);
    assert.doesNotMatch(r.out, /PREFLIGHT-OK/, name);
    assert.equal(fs.readdirSync(rig).sort().join(','), before, `${name}: the refusal created nothing in the rig dir`);
  }
});

test('driver source: the world preflight is the FIRST thing — before the app dir, any arm dir, any bus, any daemon, any /proc read', () => {
  const d = driver();
  const pos = (re: RegExp): number => { const i = d.search(re); assert.ok(i >= 0, String(re)); return i; };
  const pre = pos(/driverWorldChecks\(\{/);
  assert.ok(pos(/import \{ privateRuntimeDir \} from '\.\/lib\/rig-runtime\.mjs';/) < pre, 'the helper is a TOP-LEVEL import');
  assert.ok(pos(/privateRuntimeDir\(\)/) < pre);
  for (const later of [/const APP_DIR =/, /seedWorld\(/, /function seedWorld/, /spawn\('dbus-run-session'/, /gnome-keyring-daemon/, /readFileSync\('\/proc/, /liveHash\(\)/, /async function main/]) {
    assert.ok(pre < pos(later), `preflight precedes ${later}`);
  }
  assert.ok(pos(/if \(PREFLIGHT_ONLY\) \{ console\.log\('PREFLIGHT-OK'\); process\.exit\(0\); \}/) > pre && pos(/if \(PREFLIGHT_ONLY\)/) < pos(/const APP_DIR =/), 'preflight-only exits right after the checks');
  assert.doesNotMatch(d, /REFUSED[^\n]*\|\| /, 'a refusal is never softened');
});

test('driver source: it reads nothing of the human\'s — no real bus, no real daemon, no keyring file, no host-wide /proc scan, no literal runtime dir', () => {
  const d = driver();
  assert.doesNotMatch(d, /HUMAN_RUNTIME|realItems|realLoginCollectionLocked|selectionUnder|fleetPreflight|realRuntime|\bfleet\b/, 'the old real-runtime plumbing is gone');
  assert.doesNotMatch(d, /local\/share\/keyrings/, 'no keyring file is read or hashed');
  assert.doesNotMatch(d, /'--session'|"--session"/, 'gdbus is never asked for "the session bus"');
  assert.match(d, /spawnSync\('gdbus', \['call', '--address', w\.address,/, 'the oracle names the arm bus explicitly');
  assert.doesNotMatch(d, /readdirSync\(['"`]\/proc['"`]\)/, 'no scan of /proc/*: processes are tracked by (pid, start time) from the private bus peers and the app tree');
  for (const f of ['scripts/e2e-keyring.mjs', 'scripts/lib/rig-procs.mjs']) {
    const reads = codeOnly(read(f)).match(/\/proc\/[^'"`\s)]*/g) ?? [];
    const stray = reads.filter((r) => !/^\/proc\/(\$\{(pid|p|hp|process\.ppid|a\.app\.pid|t)\}\/(fd|environ|cmdline|exe|stat|task)|\$\{p\}\/task\/\$\{t\}\/children|net\/unix)/.test(r));
    assert.deepEqual(stray, [], `${f}: every /proc read is per-pid (a pid obtained from the driver's own children / the private bus) or /proc/net/unix`);
    assert.doesNotMatch(codeOnly(read(f)), /readdirSync\(['"`]\/proc['"`]/, f);
  }
  assert.doesNotMatch(d, /\/run\/user/, 'the path is named only in src/shared/keyring-rig-world.ts (to refuse it)');
  for (const f of ['scripts/e2e-keyring.mjs', 'scripts/e2e-keyring.sh', 'scripts/keyring-mutants.mjs', 'scripts/e2e-keyring-mutants.mjs']) {
    assert.doesNotMatch(codeOnly(read(f)), /secret-tool|busctl/, `${f} never calls secret-tool / busctl`);
  }
  assert.ok(!fs.existsSync(path.join(repo, 'scripts/keyring-host-probe.mjs')), 'the real-bus host probe is deleted');
});

test('driver source: sockets are resolved to PATHS through ss (a fd link is only `socket:[N]`); bus peers are tracked only if they hold an arm socket; the oracle waits long', () => {
  const d = driver();
  assert.match(d, /spawnSync\('ss', \['-xnaeH'\]/);
  assert.match(d, /socketPaths\(inodesOf\(t\.fdTargets\), ssRows\(\)\)/, 'the tree\'s sockets');
  assert.match(d, /ev\.socketPaths = socketPaths\(inodesOf\(ev\.fdTargets\), ssRows\(\)\)/, 'the secrets owner\'s sockets');
  assert.match(d, /if \(holdsArmSocket\(w, p, rows\)\) track\(w, p\)/, 'a pid the bus reports is signalled only if it holds a socket of THIS arm');
  assert.match(d, /'--timeout', '30', \.\.\.args\]/, 'gdbus gets the shipped probe\'s long timeout: a client vanishing mid-call aborts a gnome-keyring-daemon');
  assert.doesNotMatch(d, /'--timeout', '2'/);
});

test('driver source: teardown is robust — the app/bus group leaders are recorded BEFORE any wait, a world violation THROWS (reaped) instead of exiting, signals reap the arm', () => {
  const d = driver();
  assert.match(d, /w\.busProc = \{ pid: child\.pid, start: procStat\(child\.pid\)\?\.start \};[^\n]*\n  track\(w, child\.pid\);\n  await waitFor\(/, 'bus recorded before waiting for its socket');
  assert.match(d, /w\.appProc = \{ pid: app\.pid, start: procStat\(app\.pid\)\?\.start \};[^\n]*\n  track\(w, app\.pid\);/, 'app recorded at spawn');
  const boot = d.slice(d.indexOf('async function bootApp'), d.indexOf('async function stopApp'));
  assert.doesNotMatch(boot, /\brefuse\(/, 'a violation inside an arm must reach the finally (reap), not process.exit');
  assert.match(d, /for \(const sig of \['SIGINT', 'SIGTERM', 'SIGHUP'\]\) process\.on\(sig, \(\) => \{/);
  assert.match(d, /function killGroup\(g, sig\) \{ if \(g && isAlive\(g\.pid, g\.start\)\)/, 'a group is killed only while its recorded leader is the same process');
  assert.match(d, /groups\.length === 0/, 'teardown also counts populated process groups');
});

test('driver source: every arm lives in its own runtime dir INSIDE the rig\'s private one, with a bare display alias leading to the rig\'s verified socket', () => {
  const d = driver();
  assert.match(d, /w\.run = path\.join\(RIG_XDG, `k-\$\{name\}`\);/);
  assert.match(d, /fs\.symlinkSync\(path\.join\(RIG_XDG, RIG_WAYLAND\), path\.join\(w\.run, RIG_WAYLAND\)\);/);
  assert.match(d, /WAYLAND_DISPLAY: RIG_WAYLAND/);
  assert.match(d, /XDG_RUNTIME_DIR: w\.run/);
  assert.match(d, /sh\('grim', \['-o', 'HEADLESS-1', f\], \{ env: \{ PATH: '\/usr\/bin:\/bin', XDG_RUNTIME_DIR: RIG_XDG, WAYLAND_DISPLAY: RIG_WAYLAND \} \}\)/);
  assert.match(d, /const ARMS = \(flag\('--arms', 'forged,unlocked,/, 'the must-FAIL preflight arm runs first by default');
});

test('driver source: the arm world is proved private BEFORE its first process; the keyring-specific clauses are wired', () => {
  const d = driver();
  const run = d.slice(d.indexOf('async function runArm'));
  const worldIdx = run.search(/armWorldChecks\(\{ rigDir: RIG_DIR/);
  assert.ok(worldIdx > 0);
  for (const later of [/startBus\(w\)/, /keyringStart\(w/, /bootApp\(w, spec\)/]) assert.ok(worldIdx < run.search(later), `arm world proved before ${later}`);
  assert.match(run, /busConfigChecks\(fs\.readFileSync\(path\.join\(w\.armDir, 'session\.conf'\)/);
  assert.match(run, /if \(failed\(worldCs\)\.length\) throw new Error\('the arm world is not private — nothing was started'\);/);
  assert.match(run, /secretsOwnerChecks\(ownerEvidence\(w\)\)/);
  assert.match(run, /no-secrets-owner-on-the-private-bus/);
  assert.match(d, /for \(const c of treeChecks\(te\)\) clause\(/);
  assert.match(d, /rootCensusChecks\(fs\.readdirSync\(RIG_XDG\), ARM_DIR_NAMES\(\)\)/);
  assert.match(d, /clause\('ctl\/hidden-runtime-dir-stayed-empty', hiddenEntries\.length === 0,/);
  assert.match(d, /clause\(`forged\/\$\{name\}-is-refused`, r\.rc === 3 && \/\^REFUSED: \/m\.test\(r\.out\) && why\.test\(r\.out\) && !\/PREFLIGHT-OK\/\.test\(r\.out\),/, 'a forged world is caught only when the refusal names the forged clause');
  assert.match(d, /clause\('forged\/nothing-was-started', rootAfter === rootBefore && unixListenersUnder\(\[RIG_XDG\]\)\.length === listenersBefore && !fs\.existsSync\(path\.join\(RIG_DIR, 'arm-forged'\)\),/, 'every start-evidence term is in the clause');
  assert.match(run, /ownerCs\('\/after-relock'\)/, 'the relocked daemon is a NEW process — its ownership is proved again');
});

test('driver source: teardown reaps by identity (pid + start time re-read at signal time via rig-procs), never by environ', () => {
  const d = driver();
  assert.match(d, /import \{ descendantsOf, isAlive, procStat, signalIfSame \} from '\.\/lib\/rig-procs\.mjs';/);
  assert.match(d, /function signalTracked\(w, pid, sig\) \{ const st = w\.tracked\.get\(pid\); if \(st\) signalIfSame\(pid, st, sig\); \}/);
  assert.match(d, /await stopApp\(a, w\);/);
  assert.doesNotMatch(d, /procsOfWorld|killWorld/);
  assert.match(d, /teardown-no-survivors/);
});

test('launcher: the real runtime dir is hidden on EVERY run (bwrap), set before the contained rig execs; no fleet arm, no secret-tool', () => {
  const l = launcher();
  const hide = l.search(/export RIG_HIDE_REAL_RUNTIME=1/);
  const exec = l.search(/exec nice -n 10 "\$\{HERE\}\/e2e-contained-rig\.sh"/);
  assert.ok(hide > 0 && exec > hide, 'RIG_HIDE_REAL_RUNTIME=1 is exported before the exec');
  assert.match(l, /for t in dbus-run-session gnome-keyring-daemon gdbus sway grim swaymsg bwrap; do/, 'bwrap is a required tool');
  assert.match(l, /node --no-warnings --experimental-strip-types "\$\{HERE\}\/e2e-keyring\.mjs"/);
  assert.doesNotMatch(read('scripts/e2e-keyring.sh'), /\bfleet\b/);
});
