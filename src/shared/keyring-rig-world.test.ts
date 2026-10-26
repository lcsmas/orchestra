import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  armWorldChecks, busConfigChecks, driverWorldChecks, envHumanRuntimeRefs, failed, humanRuntimeDir, normPath, parseUnixSockets,
  longestSocket, parseSs, referencesHumanRuntime, rootCensusChecks, secretsOwnerChecks, socketInode, socketPaths, SUN_PATH_MAX, treeChecks,
  type ArmWorld, type DriverWorldFacts, type OwnerEvidence, type TreeEvidence,
} from './keyring-rig-world.ts';

// #389 — the pure world checks of the keyring rig. Each clause has a must-PASS (a good world) and a must-FAIL arm that names it.

const HUMAN = humanRuntimeDir(1000);
const RIG = '/var/tmp/e2e-keyring-389/e2e64c-42';
const ids = (cs: ReturnType<typeof failed>): string[] => cs.map((c) => c.id);

test('the module is pure: no fs / child_process / process access (it only decides what the driver observed)', () => {
  const src = fs.readFileSync(path.join(import.meta.dirname, 'keyring-rig-world.ts'), 'utf8');
  assert.doesNotMatch(src, /from 'node:(fs|child_process|net|os)'|require\(|process\./);
});

test('normPath / referencesHumanRuntime: every spelling of the human runtime dir is caught, in every container shape; look-alikes are not', () => {
  assert.equal(normPath('/run//user/./1000/x/../bus'), '/run/user/1000/bus');
  for (const v of [HUMAN, `${HUMAN}/bus`, `unix:path=${HUMAN}/bus`, `/usr/bin:${HUMAN}/x:/bin`, '/run//user/1000', '/run/./user/1000', '/run/x/../user/1000', `file://${HUMAN}/keyring`, `--socket=${HUMAN}/keyring/pkcs11`, '/run/user', `unix:abstract=x,guid=y;path=${HUMAN}/b`, '/run/user:/usr/bin', 'a,/run/user;b', `XDG_DATA_DIRS=${HUMAN}:/usr/share`]) {
    assert.ok(referencesHumanRuntime(v), `must catch: ${v}`);
  }
  for (const v of ['/var/tmp/e2e/run/userdata', '/var/tmp/rigs/xdg/k-unlocked', 'unix:path=/var/tmp/rig/bus', 'disabled:', '', '/usr/bin:/bin', 'run/users/x']) {
    assert.ok(!referencesHumanRuntime(v), `must NOT flag: ${v}`);
  }
  assert.deepEqual(envHumanRuntimeRefs({ A: '/x', GNOME_KEYRING_CONTROL: `${HUMAN}/keyring`, B: undefined, DBUS_SESSION_BUS_ADDRESS: `unix:path=${HUMAN}/bus` }), ['DBUS_SESSION_BUS_ADDRESS', 'GNOME_KEYRING_CONTROL']);
});

const goodDriver = (): DriverWorldFacts => ({
  rigDir: RIG,
  env: { RIG_DIR: RIG, XDG_RUNTIME_DIR: `${RIG}/xdg`, DBUS_SESSION_BUS_ADDRESS: `unix:path=${RIG}/no-session-bus`, WAYLAND_DISPLAY: 'wayland-rig', PATH: '/usr/bin:/bin', HOME: `${RIG}/home` },
  noBusExists: false,
  hiddenWorld: true,
});

test('driver world: the rig-exported env passes every clause (control)', () => {
  const cs = driverWorldChecks(goodDriver());
  assert.deepEqual(ids(failed(cs)), []);
  assert.equal(cs.length, 6);
});

test('driver world: each forged input fails exactly the clause that names it (must-FAIL arms)', () => {
  const run = (mut: (f: DriverWorldFacts) => void): string[] => { const f = goodDriver(); mut(f); return ids(failed(driverWorldChecks(f))); };
  assert.ok(run((f) => { f.env.XDG_RUNTIME_DIR = HUMAN; }).includes('xdg-is-the-rigs-private-dir'), 'forced real XDG_RUNTIME_DIR');
  assert.ok(run((f) => { f.env.XDG_RUNTIME_DIR = `${HUMAN}/x`; }).includes('xdg-is-the-rigs-private-dir'));
  assert.ok(run((f) => { f.env.XDG_RUNTIME_DIR = `${RIG}/other`; }).includes('xdg-is-the-rigs-private-dir'), 'a foreign dir');
  assert.ok(run((f) => { delete f.env.XDG_RUNTIME_DIR; }).includes('xdg-is-the-rigs-private-dir'), 'unset');
  assert.ok(run((f) => { f.env.DBUS_SESSION_BUS_ADDRESS = `unix:path=${HUMAN}/bus`; }).includes('dbus-is-the-rigs-nonexistent-address'), 'forced real DBUS address');
  assert.ok(run((f) => { delete f.env.DBUS_SESSION_BUS_ADDRESS; }).includes('dbus-is-the-rigs-nonexistent-address'), 'unset DBUS address');
  assert.ok(run((f) => { f.noBusExists = true; }).includes('dbus-is-the-rigs-nonexistent-address'), 'the private no-bus path exists (something could listen)');
  assert.ok(run((f) => { f.env.GNOME_KEYRING_CONTROL = `${HUMAN}/keyring`; }).includes('no-env-value-reaches-the-human-runtime'), 'a stray value');
  assert.ok(run((f) => { f.env.PATH = `/usr/bin:${HUMAN}/bin`; }).includes('no-env-value-reaches-the-human-runtime'), 'inside a PATH list');
  assert.ok(run((f) => { f.env.WAYLAND_DISPLAY = `${HUMAN}/wayland-1`; }).includes('display-is-a-bare-private-name'), 'an absolute display path');
  assert.ok(run((f) => { f.env.DISPLAY = ':0'; }).includes('display-is-a-bare-private-name'), 'X11 reachable');
  assert.ok(run((f) => { f.hiddenWorld = false; }).includes('hidden-world'), 'not inside the hidden world');
  assert.ok(run((f) => { f.rigDir = undefined; }).includes('rig-dir-set'), 'not run through the contained rig');
  assert.ok(run((f) => { f.rigDir = `${HUMAN}/rig`; f.env.XDG_RUNTIME_DIR = `${HUMAN}/rig/xdg`; }).includes('rig-dir-set'), 'a rig dir inside the human runtime dir');
});

const goodArm = (): ArmWorld => {
  const run = `${RIG}/xdg/k-unlocked`;
  const address = `unix:path=${run}/bus`;
  const base = { XDG_RUNTIME_DIR: run, PATH: '/usr/bin:/bin', HOME: `${RIG}/arm-unlocked/home` };
  return {
    rigDir: RIG,
    run,
    dirs: { arm: `${RIG}/arm-unlocked`, home: `${RIG}/arm-unlocked/home`, oh: `${RIG}/arm-unlocked/oh`, data: `${RIG}/arm-unlocked/data`, config: `${RIG}/arm-unlocked/config`, cache: `${RIG}/arm-unlocked/cache`, claude: `${RIG}/arm-unlocked/claude-config` },
    address,
    envs: { bus: { ...base }, tool: { ...base, DBUS_SESSION_BUS_ADDRESS: address }, app: { ...base, ORCHESTRA_HOME: `${RIG}/arm-unlocked/oh` } },
  };
};

test('arm world: a good arm passes; each leak fails the clause that names it', () => {
  assert.deepEqual(ids(failed(armWorldChecks(goodArm()))), [], 'control');
  const run = (mut: (w: ArmWorld) => void): string[] => { const w = goodArm(); mut(w); return ids(failed(armWorldChecks(w))); };
  assert.ok(run((w) => { w.run = `${HUMAN}/k`; w.address = `unix:path=${HUMAN}/k/bus`; }).includes('run-is-a-private-subdir-of-the-rig-runtime'));
  assert.ok(run((w) => { w.run = `${RIG}/xdg`; w.address = `unix:path=${RIG}/xdg/bus`; }).includes('run-is-a-private-subdir-of-the-rig-runtime'), 'the rig root itself is not an arm dir');
  assert.ok(run((w) => { w.dirs.home = '/home/someone/real'; }).includes('every-arm-dir-is-inside-the-rig-dir'));
  assert.ok(run((w) => { w.dirs.data = `${RIG}/../elsewhere/data`; }).includes('every-arm-dir-is-inside-the-rig-dir'), '`..` out of the rig dir');
  assert.ok(run((w) => { w.dirs.data = `${RIG}-evil/data`; }).includes('every-arm-dir-is-inside-the-rig-dir'), 'a sibling that merely shares the rig dir\'s name as a prefix');
  assert.ok(run((w) => { w.address = `unix:path=${RIG}/elsewhere/bus`; }).includes('bus-address-is-inside-the-arm-runtime'));
  assert.ok(run((w) => { w.envs.app.GNOME_KEYRING_CONTROL = `${HUMAN}/keyring`; }).includes('no-process-env-names-the-human-runtime'));
  assert.ok(run((w) => { w.envs.tool.SSH_AUTH_SOCK = `${HUMAN}/keyring/ssh`; }).includes('no-process-env-names-the-human-runtime'));
  assert.ok(run((w) => { w.envs.app.XDG_RUNTIME_DIR = `${RIG}/xdg`; }).includes('every-process-class-has-the-arms-runtime'), 'an app that took the rig root');
  assert.ok(run((w) => { delete w.envs.bus.XDG_RUNTIME_DIR; }).includes('every-process-class-has-the-arms-runtime'), 'unset → libdbus falls back to the human dir');
  assert.ok(run((w) => { w.envs.app.DBUS_SESSION_BUS_ADDRESS = 'unix:path=/tmp/some-other-bus'; }).includes('no-process-class-carries-a-foreign-bus-address'));
  assert.deepEqual(ids(failed(armWorldChecks((() => { const w = goodArm(); w.envs.app.DBUS_SESSION_BUS_ADDRESS = 'disabled:'; return w; })()))), [], '`disabled:` is what Electron puts in its own env — not an address');
});

const goodConf = (svc: string, address: string): string => `<!DOCTYPE busconfig PUBLIC "x" "y">
<busconfig>
  <type>session</type>
  <keep_umask/>
  <listen>${address}</listen>
  <auth>EXTERNAL</auth>
  <servicedir>${svc}</servicedir>
  <policy context="default">
    <allow send_destination="*" eavesdrop="true"/>
    <allow own="*"/>
  </policy>
</busconfig>
`;

test('bus config: only the arm socket and the arm\'s empty service dir; anything that pulls in host services fails', () => {
  const want = { svc: `${RIG}/arm/svc`, address: `unix:path=${RIG}/xdg/k-a/bus` };
  assert.deepEqual(ids(failed(busConfigChecks(goodConf(want.svc, want.address), want))), [], 'control');
  const conf = goodConf(want.svc, want.address);
  const bad = (c: string): string[] => ids(failed(busConfigChecks(c, want)));
  assert.ok(bad(conf.replace('<keep_umask/>', '<keep_umask/>\n  <standard_session_servicedirs/>')).includes('bus-config-pulls-in-nothing-else'), 'the host dbus-1/services dirs');
  assert.ok(bad(conf.replace('<keep_umask/>', '<keep_umask/>\n  <standard_system_servicedirs/>')).includes('bus-config-pulls-in-nothing-else'));
  assert.ok(bad(conf.replace('<keep_umask/>', '<keep_umask/>\n  <include>/usr/share/dbus-1/session.conf</include>')).includes('bus-config-pulls-in-nothing-else'));
  assert.ok(bad(conf.replace('<keep_umask/>', '<keep_umask/>\n  <includedir>/etc/dbus-1/session.d</includedir>')).includes('bus-config-pulls-in-nothing-else'));
  assert.ok(bad(conf.replace(`<servicedir>${want.svc}</servicedir>`, `<servicedir>${want.svc}</servicedir>\n  <servicedir>/usr/share/dbus-1/services</servicedir>`)).includes('bus-service-dir-is-only-the-arms-empty-dir'));
  assert.ok(bad(conf.replace(`<servicedir>${want.svc}</servicedir>`, '')).includes('bus-service-dir-is-only-the-arms-empty-dir'));
  assert.ok(bad(conf.replace(want.address, `unix:path=${HUMAN}/bus`)).includes('bus-listens-only-on-the-arm-socket'), 'a config listening on the real bus');
  assert.ok(bad(conf.replace(`<listen>${want.address}</listen>`, `<listen>${want.address}</listen><listen>tcp:host=localhost</listen>`)).includes('bus-listens-only-on-the-arm-socket'));
  assert.ok(bad(conf.replace('<type>session</type>', '<type>system</type>')).includes('bus-is-a-session-bus'));
});

const RUN = `${RIG}/xdg/k-unlocked`;
const goodOwner = (): OwnerEvidence => ({
  ownerPid: 5555,
  driverPid: 100,
  exeBase: 'gnome-keyring-daemon',
  cmdline: ['/usr/bin/gnome-keyring-daemon', '--start', '--components=secrets'],
  fdTargets: ['socket:[111]', 'socket:[222]', '/dev/null', 'anon_inode:[eventfd]'],
  socketPaths: [`${RUN}/keyring/control`, `${RUN}/bus`],
  envEntries: [`XDG_RUNTIME_DIR=${RUN}`, 'LANG=C.UTF-8'],
  sockets: [{ inode: 111, path: `${RUN}/keyring/control` }, { inode: 333, path: `${RUN}/bus` }, { inode: 999, path: `${HUMAN}/keyring/control` }],
  run: RUN,
});

test('secrets owner: our own daemon passes; a foreign / absent / mis-rooted owner fails the clause that names it', () => {
  assert.deepEqual(ids(failed(secretsOwnerChecks(goodOwner()))), [], 'control');
  const bad = (mut: (e: OwnerEvidence) => void): string[] => { const e = goodOwner(); mut(e); return ids(failed(secretsOwnerChecks(e))); };
  assert.ok(bad((e) => { e.ownerPid = null; }).includes('owner-found-on-the-private-bus'));
  assert.ok(bad((e) => { e.ownerPid = 100; }).includes('owner-found-on-the-private-bus'), 'the driver itself');
  assert.ok(bad((e) => { e.exeBase = 'node'; e.cmdline = ['node', 'fake-secrets.js']; }).includes('owner-is-gnome-keyring-daemon'), 'an impostor on the private bus');
  assert.ok(bad((e) => { e.exeBase = 'node'; }).includes('owner-is-gnome-keyring-daemon'), 'an impostor whose argv CLAIMS to be the daemon: the exe is what counts');
  assert.ok(bad((e) => { e.cmdline = ['/usr/bin/node', 'x.js']; }).includes('owner-is-gnome-keyring-daemon'), 'and the argv must agree with the exe');
  assert.ok(bad((e) => { e.fdTargets = ['socket:[999]', '/dev/null']; }).includes('owner-listens-inside-the-arm-keyring-dir'), 'its only socket is the HUMAN one (inode 999)');
  assert.ok(bad((e) => { e.sockets = e.sockets.filter((s) => s.inode !== 111); }).includes('owner-listens-inside-the-arm-keyring-dir'), 'no arm control socket exists');
  assert.ok(bad((e) => { e.fdTargets = ['socket:[333]']; }).includes('owner-listens-inside-the-arm-keyring-dir'), 'holding the arm BUS socket is not owning a keyring socket');
  assert.ok(bad((e) => { e.fdTargets.push(`${HUMAN}/keyring/pkcs11`); }).includes('owner-env-and-fds-never-name-the-human-runtime'));
  assert.ok(bad((e) => { e.socketPaths.push(`${HUMAN}/keyring/control`); }).includes('owner-env-and-fds-never-name-the-human-runtime'), 'a socket fd connected to the human keyring (fd link reads only `socket:[N]`)');
  assert.ok(bad((e) => { e.envEntries.push(`GNOME_KEYRING_CONTROL=${HUMAN}/keyring`); }).includes('owner-env-and-fds-never-name-the-human-runtime'));
  assert.ok(bad((e) => { e.envEntries = [`XDG_RUNTIME_DIR=${HUMAN}`]; }).includes('owner-runtime-env-is-the-arms'));
  assert.deepEqual(ids(failed(secretsOwnerChecks({ ...goodOwner(), envEntries: [] }))), [], 'an unreadable environ is not a failure (the title rewrite); the fd/socket clauses still bind');
});

test('parseUnixSockets / socketInode: the shapes /proc/net/unix and /proc/<pid>/fd really have', () => {
  const text = `Num       RefCount Protocol Flags    Type St Inode Path
0000000000000000: 00000002 00000000 00010000 0001 01 111 ${RUN}/keyring/control
0000000000000000: 00000003 00000000 00000000 0001 03 222
0000000000000000: 00000002 00000000 00010000 0001 01 333 @abstract
0000000000000000: 00000002 00000000 00010000 0001 01 444 /tmp/with space/sock
`;
  assert.deepEqual(parseUnixSockets(text), [{ inode: 111, path: `${RUN}/keyring/control` }, { inode: 444, path: '/tmp/with space/sock' }]);
  assert.equal(socketInode('socket:[12345]'), 12345);
  assert.equal(socketInode('/dev/null'), null);
  assert.equal(socketInode('anon_inode:[eventfd]'), null);
});

test('app tree: clean tree with a positive control passes; a leaked fd/env, an empty tree, or a blind scan fails', () => {
  const good = (): TreeEvidence => ({ pids: 12, fdTargets: ['socket:[7]', '/dev/null'], socketPaths: [`${RUN}/orchestra-0123456789ab.sock`, `${RUN}/bus`], envEntries: ['LANG=C'], run: RUN });
  assert.deepEqual(ids(failed(treeChecks(good()))), [], 'control');
  const bad = (mut: (t: TreeEvidence) => void): string[] => { const t = good(); mut(t); return ids(failed(treeChecks(t))); };
  assert.ok(bad((t) => { t.fdTargets.push(`${HUMAN}/keyring/pkcs11`); }).includes('tree-fds-and-env-never-name-the-human-runtime'));
  assert.ok(bad((t) => { t.socketPaths.push(`${HUMAN}/keyring/pkcs11`); }).includes('tree-fds-and-env-never-name-the-human-runtime'), 'a connection to the human keyring socket is visible only through the resolved socket paths');
  assert.ok(bad((t) => { t.envEntries.push(`P11_KIT_SERVER_ADDRESS=unix:path=${HUMAN}/p11-kit/pkcs11`); }).includes('tree-fds-and-env-never-name-the-human-runtime'));
  assert.ok(bad((t) => { t.pids = 1; }).includes('tree-has-processes'));
  assert.ok(bad((t) => { t.socketPaths = []; }).includes('tree-scan-sees-the-private-runtime-dir'), 'a scan that cannot see the private dir proves nothing about the human one');
  assert.ok(bad((t) => { t.socketPaths = []; t.fdTargets = [`${RUN}/x`]; }).includes('tree-scan-sees-the-private-runtime-dir'), 'a regular-file fd path is not the control: sockets are what a leak travels over');
});

test('rig root census: wayland sockets and arm dirs only; a keyring/bus/p11-kit/hooks entry at the root means something took the rig root as its runtime dir', () => {
  const arms = ['k-unlocked', 'k-locked'];
  assert.deepEqual(ids(failed(rootCensusChecks(['wayland-1', 'wayland-rig', 'k-unlocked'], arms))), [], 'control');
  for (const stray of ['keyring', 'bus', 'p11-kit', 'pulse', 'orchestra-0123456789ab.sock', 'k-other']) {
    assert.deepEqual(ids(failed(rootCensusChecks(['wayland-1', stray], arms))), ['rig-runtime-root-holds-only-wayland-and-arm-dirs'], stray);
  }
});

test('parseSs / socketPaths: a socket fd is `socket:[N]`; the path it reaches comes from `ss` — own bound path, or the PEER end\'s bound path', () => {
  const ss = `u_str LISTEN 0      511    ${RUN}/orchestra-0123456789ab.sock 500 * 0        <-> ino:1 dev:0/36 peers:
u_str ESTAB  0      0                                        * 600 * 601 <->
u_str ESTAB  0      0                      ${HUMAN}/keyring/control 601 * 600 <->
u_str ESTAB  0      0                                        * 700 * 701 <->
u_str ESTAB  0      0                      ${RUN}/bus 701 * 700 <->
u_dgr UNCONN 0      0                                        * 800 * 0 <->
garbage line
`;
  const rows = parseSs(ss);
  assert.equal(rows.length, 6);
  assert.deepEqual(rows[0], { localPath: `${RUN}/orchestra-0123456789ab.sock`, localIno: 500, peerIno: 0 });
  assert.deepEqual(rows[1], { localPath: null, localIno: 600, peerIno: 601 });
  assert.deepEqual(socketPaths([500], rows), [`${RUN}/orchestra-0123456789ab.sock`], 'the app\'s own listener');
  assert.deepEqual(socketPaths([600], rows), [`${HUMAN}/keyring/control`], 'a client end `*` reaches the path its PEER is bound to — the leak shape');
  assert.deepEqual(socketPaths([700], rows), [`${RUN}/bus`], 'a connection to the arm bus');
  assert.deepEqual(socketPaths([800, 9999], rows), [], 'unnamed / unknown sockets resolve to nothing');
  assert.deepEqual(socketPaths([600, 700, 500], rows), [`${HUMAN}/keyring/control`, `${RUN}/bus`, `${RUN}/orchestra-0123456789ab.sock`].sort());
});

test('arm sockets must fit sun_path: the hooks socket `<run>/orchestra-<12hex>.sock` is 28 chars, not 23', () => {
  assert.equal(`orchestra-xxxxxxxxxxxx.sock`.length + 1, 28);
  const ok = goodArm();
  assert.ok(longestSocket(ok.run) <= SUN_PATH_MAX);
  assert.deepEqual(ids(failed(armWorldChecks(ok))), []);
  const long = goodArm();
  long.run = `${RIG}/xdg/` + 'k'.repeat(SUN_PATH_MAX - 28 - `${RIG}/xdg/`.length + 1);
  long.address = `unix:path=${long.run}/bus`;
  assert.equal(longestSocket(long.run), SUN_PATH_MAX + 1);
  assert.ok(ids(failed(armWorldChecks(long))).includes('arm-socket-paths-fit-sun-path'), 'one char too long → refused');
  const edge = goodArm();
  edge.run = `${RIG}/xdg/` + 'k'.repeat(SUN_PATH_MAX - 28 - `${RIG}/xdg/`.length);
  edge.address = `unix:path=${edge.run}/bus`;
  assert.ok(!ids(failed(armWorldChecks(edge))).includes('arm-socket-paths-fit-sun-path'), 'exactly at the limit passes');
});
