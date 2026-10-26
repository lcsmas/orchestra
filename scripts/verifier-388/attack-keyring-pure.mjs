// Verifier adversarial table for src/shared/keyring-rig-world.ts (seat 1, #389 gate). PURE: forged inputs only — no fs, no process, no network, no daemon.
// usage: node --experimental-strip-types attack-keyring-pure.mjs <repo-root>   -> one line per case; exit 1 on any UNEXPECTED outcome. "GAP" rows are declared (pass when they should not).
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const root = path.resolve(process.argv[2] ?? '.');
const W = await import(pathToFileURL(path.join(root, 'src/shared/keyring-rig-world.ts')).href);
const UID = 1000, RT = `/run/user/${UID}`, RIG = '/var/tmp/v/e2e64c-1', RUN = `${RIG}/xdg/k-unlocked`, ADDR = `unix:path=${RUN}/bus`;
let bad = 0, gaps = 0, ok = 0;
const row = (id, expect, got, label, extra = '') => {
  // expect: 'FAIL' (the check must refuse) | 'PASS' (control must accept) | 'GAP' (known: passes though hostile)
  const verdict = expect === 'GAP' ? (got === 'PASS' ? 'GAP' : 'OK') : expect === got ? 'OK' : 'BYPASS';
  if (verdict === 'OK') ok++; else if (verdict === 'GAP') gaps++; else bad++;
  console.log(`${id.padEnd(5)} ${verdict.padEnd(7)} exp=${expect.padEnd(4)} got=${got.padEnd(4)} ${label}${extra ? ` | ${extra}` : ''}`);
};
const verdictOf = (checks) => (W.failed(checks).length ? 'FAIL' : 'PASS');
const which = (checks) => W.failed(checks).map((c) => c.id).join(',');

// ── A. referencesHumanRuntime: every spelling of the human's runtime dir ───────────────────────────────────────────────────
const ref = (id, expect, v, label) => row(id, expect, W.referencesHumanRuntime(v) ? 'FAIL' : 'PASS', `${label}: ${JSON.stringify(v)}`);
ref('A1', 'FAIL', `${RT}`, 'exact'); ref('A2', 'FAIL', `${RT}/bus`, 'bus'); ref('A3', 'FAIL', `/run//user/${UID}/x`, 'double slash'); ref('A4', 'FAIL', `/run/./user/${UID}`, 'dot');
ref('A5', 'FAIL', `/run/x/../user/${UID}`, 'dotdot'); ref('A6', 'FAIL', `../../../run/user/${UID}`, 'relative climb'); ref('A7', 'FAIL', `run/user/${UID}/k`, 'relative no leading slash');
ref('A8', 'FAIL', `unix:path=${RT}/bus`, 'dbus address'); ref('A9', 'FAIL', `unix:path=${RT}/bus;unix:abstract=x`, 'address list'); ref('A10', 'FAIL', `unix:path=/nonexistent,guid=1,x=${RT}/bus`, 'comma-separated');
ref('A11', 'FAIL', `a:b:${RT}/z`, 'colon list'); ref('A12', 'FAIL', `file://${RT}/x`, 'file URL'); ref('A13', 'FAIL', `/proc/self/root${RT}/bus`, '/proc/self/root view'); ref('A14', 'FAIL', `/var${RT}/x`, '/var/run alias');
ref('A15', 'FAIL', `--address=${RT}/bus`, 'argv flag'); ref('A16', 'FAIL', `x ${RT}/y z`, 'inside a longer string'); ref('A17', 'FAIL', '/run/user', 'parent dir exact'); ref('A18', 'FAIL', '/run/user/', 'parent dir trailing slash');
ref('A19', 'FAIL', `/tmp/a:b/../../${RT.slice(1)}`, 'colon inside a dir name then climb'); ref('A20', 'FAIL', `/../../${RT.slice(1)}`, 'climb above root'); ref('A21', 'FAIL', `@${RT}/bus`, 'abstract-looking prefix');
ref('A22', 'FAIL', `/run/user/9999/x`, 'another uid'); ref('A23', 'FAIL', `/run///user////${UID}`, 'many slashes'); ref('A24', 'FAIL', `${RT}/../${UID}/bus`, 'self-climb');
ref('A25', 'PASS', `${RIG}/xdg/k-a/bus`, 'CONTROL: the rig path'); ref('A26', 'PASS', '/run/userfoo/x', 'CONTROL: prefix-only name'); ref('A27', 'PASS', '/var/run/dbus/system_bus_socket', 'CONTROL: system bus socket');
ref('A28', 'GAP', '/RUN/USER/1000', 'upper case (not a Linux path)'); ref('A29', 'GAP', '%2Frun%2Fuser%2F1000', 'percent-encoded'); ref('A30', 'GAP', '\\x2frun\\x2fuser\\x2f1000', 'backslash-hex');
ref('A31', 'GAP', '/run/user1000/x', 'no separator (not a real path)'); ref('A32', 'GAP', '$XDG_RUNTIME_DIR/bus', 'unexpanded variable'); ref('A33', 'GAP', '/run/​user/1000', 'zero-width space');
ref('A34', 'GAP', Buffer.from(`${RT}/bus`).toString('base64'), 'base64');

// ── B. driverWorldChecks ─────────────────────────────────────────────────────────────────────────────────────────────────
const goodEnv = () => ({ XDG_RUNTIME_DIR: `${RIG}/xdg`, DBUS_SESSION_BUS_ADDRESS: `unix:path=${RIG}/no-session-bus`, WAYLAND_DISPLAY: 'wayland-rig', HOME: `${RIG}/home`, PATH: '/usr/bin:/bin' });
const HIDDEN_MI = `100 50 0:30 / ${RT} rw,nosuid,nodev,relatime shared:223 - tmpfs tmpfs rw,size=3241904k,mode=700\n200 100 0:99 / ${RT} rw,nosuid,nodev,relatime - tmpfs tmpfs rw,size=1024k\n`;
const dw = (id, expect, label, mut = {}, facts = {}) => { const env = { ...goodEnv(), ...mut }; for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k]; const c = W.driverWorldChecks({ rigDir: RIG, env, noBusExists: false, hiddenWorld: true, mountinfo: HIDDEN_MI, uid: UID, ...facts }); row(id, expect, verdictOf(c), label, which(c)); };
dw('B1', 'PASS', 'CONTROL: the shipped env'); dw('B2', 'FAIL', 'XDG = real dir', { XDG_RUNTIME_DIR: RT }); dw('B3', 'FAIL', 'XDG = private + trailing slash', { XDG_RUNTIME_DIR: `${RIG}/xdg/` });
dw('B4', 'FAIL', 'XDG = private/../xdg', { XDG_RUNTIME_DIR: `${RIG}/xdg/../xdg` }); dw('B5', 'FAIL', 'XDG unset', { XDG_RUNTIME_DIR: undefined }); dw('B6', 'FAIL', 'DBUS = real bus', { DBUS_SESSION_BUS_ADDRESS: `unix:path=${RT}/bus` });
dw('B7', 'FAIL', 'DBUS unset', { DBUS_SESSION_BUS_ADDRESS: undefined }); dw('B8', 'FAIL', 'DBUS = private;real list', { DBUS_SESSION_BUS_ADDRESS: `unix:path=${RIG}/no-session-bus;unix:path=${RT}/bus` });
dw('B9', 'FAIL', 'DBUS = disabled:', { DBUS_SESSION_BUS_ADDRESS: 'disabled:' }); dw('B10', 'FAIL', 'DBUS = tcp', { DBUS_SESSION_BUS_ADDRESS: 'tcp:host=127.0.0.1,port=1' });
dw('B11', 'FAIL', 'DBUS ok but the no-bus path EXISTS', {}, { noBusExists: true }); dw('B12', 'FAIL', 'not hidden', {}, { hiddenWorld: false });
dw('B13', 'FAIL', 'X11 DISPLAY set', { DISPLAY: ':0' }); dw('B14', 'FAIL', 'WAYLAND_DISPLAY = absolute path into the real dir', { WAYLAND_DISPLAY: `${RT}/wayland-1` }); dw('B15', 'FAIL', 'WAYLAND_DISPLAY = relative path', { WAYLAND_DISPLAY: '../wayland-1' });
dw('B16', 'FAIL', 'unrelated key carries the real dir', { FOO: `${RT}/x` }); dw('B17', 'FAIL', 'GNOME_KEYRING_CONTROL', { GNOME_KEYRING_CONTROL: `${RT}/keyring` }); dw('B18', 'FAIL', 'P11_KIT_SERVER_ADDRESS', { P11_KIT_SERVER_ADDRESS: `unix:path=${RT}/p11-kit/pkcs11` });
dw('B19', 'FAIL', 'SSH_AUTH_SOCK', { SSH_AUTH_SOCK: `${RT}/keyring/ssh` }); dw('B20', 'FAIL', 'XDG_DATA_DIRS list', { XDG_DATA_DIRS: `${RT}/share:/usr/share` }); dw('B21', 'FAIL', 'HOME under the real dir', { HOME: `${RT}/h` });
dw('B22', 'FAIL', 'PATH entry', { PATH: `/usr/bin:${RT}/bin` }); dw('B23', 'FAIL', 'RIG_DIR itself under the real dir (rigDir fact)', {}, { rigDir: `${RT}/rig` });
dw('B24', 'FAIL', 'RIG_DIR unset', {}, { rigDir: undefined }); dw('B25', 'FAIL', 'RIG_DIR relative', {}, { rigDir: 'rig/e2e64c-1' }); dw('B26', 'GAP', 'DBUS_SYSTEM_BUS_ADDRESS = the real system bus', { DBUS_SYSTEM_BUS_ADDRESS: 'unix:path=/run/dbus/system_bus_socket' });
dw('B27', 'GAP', 'forged hidden-world fact (the pure fn trusts the boolean the driver gathers)', {}, { hiddenWorld: true });
dw('B28', 'GAP', 'value %2F-encoded', { FOO: '%2Frun%2Fuser%2F1000%2Fbus' });

// ── C. armWorldChecks ────────────────────────────────────────────────────────────────────────────────────────────────────
const armEnv = (over = {}) => ({ PATH: '/usr/bin:/bin', HOME: `${RIG}/arm-x/home`, XDG_RUNTIME_DIR: RUN, DBUS_SESSION_BUS_ADDRESS: ADDR, ...over });
const goodArm = () => ({ rigDir: RIG, run: RUN, dirs: { arm: `${RIG}/arm-x`, home: `${RIG}/arm-x/home`, oh: `${RIG}/arm-x/oh` }, address: ADDR, envs: { bus: armEnv({ DBUS_SESSION_BUS_ADDRESS: undefined }), tool: armEnv(), app: armEnv() } });
const aw = (id, expect, label, f) => { const w = goodArm(); f(w); const c = W.armWorldChecks(w); row(id, expect, verdictOf(c), label, which(c)); };
aw('C1', 'PASS', 'CONTROL', () => {}); aw('C2', 'FAIL', 'run = the real dir', (w) => { w.run = RT; }); aw('C3', 'FAIL', 'run escapes by ..', (w) => { w.run = `${RIG}/xdg/../../../run/user/${UID}`; });
aw('C4', 'FAIL', 'run is a sibling of the rig runtime', (w) => { w.run = `${RIG}/other/k-x`; }); aw('C5', 'FAIL', 'a dir outside the rig', (w) => { w.dirs.home = '/home/lmas/x'; });
aw('C6', 'FAIL', 'address not under the arm run', (w) => { w.address = `unix:path=${RT}/bus`; }); aw('C7', 'FAIL', 'app env leaks the real dir', (w) => { w.envs.app.FOO = `${RT}/keyring`; });
aw('C8', 'FAIL', 'tool class has another XDG', (w) => { w.envs.tool.XDG_RUNTIME_DIR = `${RIG}/xdg`; }); aw('C9', 'FAIL', 'a class carries tcp bus', (w) => { w.envs.app.DBUS_SESSION_BUS_ADDRESS = 'tcp:host=1.2.3.4,port=1'; });
aw('C10', 'FAIL', 'a class carries the abstract bus', (w) => { w.envs.app.DBUS_SESSION_BUS_ADDRESS = 'unix:abstract=/tmp/dbus-X'; }); aw('C11', 'FAIL', 'address + trailing space', (w) => { w.envs.app.DBUS_SESSION_BUS_ADDRESS = `${ADDR} `; });
aw('C12', 'FAIL', 'run path so long the hooks socket overflows sun_path', (w) => { w.run = `${RIG}/xdg/k-${'x'.repeat(60)}`; w.address = `unix:path=${w.run}/bus`; for (const e of Object.values(w.envs)) { e.XDG_RUNTIME_DIR = w.run; if (e.DBUS_SESSION_BUS_ADDRESS) e.DBUS_SESSION_BUS_ADDRESS = w.address; } });
aw('C13', 'PASS', 'CONTROL: a class with `disabled:` (Electron rewrite) is accepted', (w) => { w.envs.app.DBUS_SESSION_BUS_ADDRESS = 'disabled:'; }); aw('C14', 'GAP', 'a class carries the REAL SYSTEM bus address', (w) => { w.envs.app.DBUS_SYSTEM_BUS_ADDRESS = 'unix:path=/run/dbus/system_bus_socket'; });
aw('C15', 'FAIL', 'a class has no XDG at all', (w) => { delete w.envs.tool.XDG_RUNTIME_DIR; });

// ── D. bus config ─────────────────────────────────────────────────────────────────────────────────────────────────────────
const conf = (extra = '', over = {}) => `<busconfig><type>${over.type ?? 'session'}</type><listen>${over.listen ?? ADDR}</listen><servicedir>${over.svc ?? RUN + '/svc'}</servicedir>${extra}</busconfig>`;
const bc = (id, expect, label, text) => { const c = W.busConfigChecks(text, { svc: `${RUN}/svc`, address: ADDR }); row(id, expect, verdictOf(c), label, which(c)); };
bc('D1', 'PASS', 'CONTROL', conf()); bc('D2', 'FAIL', 'standard session dirs', conf('<standard_session_servicedirs/>')); bc('D3', 'FAIL', 'standard session dirs with a space', conf('<standard_session_servicedirs />'));
bc('D4', 'FAIL', 'include', conf('<include ignore_missing="yes">/usr/share/dbus-1/session.conf</include>')); bc('D5', 'FAIL', 'includedir', conf('<includedir>/etc/dbus-1/session.d</includedir>'));
bc('D6', 'FAIL', 'servicehelper', conf('<servicehelper>/usr/libexec/x</servicehelper>')); bc('D7', 'FAIL', 'second listen on the real bus', conf(`<listen>unix:path=${RT}/bus</listen>`));
bc('D8', 'FAIL', 'listen = real bus only', conf('', { listen: `unix:path=${RT}/bus` })); bc('D9', 'FAIL', 'second servicedir (host dir)', conf('<servicedir>/usr/share/dbus-1/services</servicedir>'));
bc('D10', 'FAIL', 'servicedir = host dir only', conf('', { svc: '/usr/share/dbus-1/services' })); bc('D11', 'FAIL', 'system bus type', conf('', { type: 'system' }));
bc('D12', 'FAIL', 'tcp listen (second)', conf('<listen>tcp:host=127.0.0.1,port=0</listen>')); bc('D13', 'GAP', 'a `<type>session</type>` hidden in a comment while the real type is system', `<busconfig><!-- <type>session</type> --><type>system</type><listen>${ADDR}</listen><servicedir>${RUN}/svc</servicedir></busconfig>`);

// ── E. secrets owner ─────────────────────────────────────────────────────────────────────────────────────────────────────
const goodOwner = () => ({ ownerPid: 4242, driverPid: 100, exeBase: 'gnome-keyring-daemon', cmdline: ['/usr/bin/gnome-keyring-daemon', '--start', '--components=secrets'], fdTargets: ['socket:[11]', 'socket:[12]', '/dev/null'], envEntries: [`XDG_RUNTIME_DIR=${RUN}`], sockets: [{ inode: 11, path: `${RUN}/keyring/control` }, { inode: 12, path: `${RUN}/bus` }], socketPaths: [`${RUN}/keyring/control`, `${RUN}/bus`], run: RUN });
const ow = (id, expect, label, f) => { const e = goodOwner(); f(e); const c = W.secretsOwnerChecks(e); row(id, expect, verdictOf(c), label, which(c)); };
ow('E1', 'PASS', 'CONTROL: the arm\'s own daemon', () => {});
ow('E2', 'FAIL', 'no owner', (e) => { e.ownerPid = null; }); ow('E3', 'FAIL', 'owner = the driver itself', (e) => { e.ownerPid = e.driverPid; }); ow('E4', 'FAIL', 'owner pid 1', (e) => { e.ownerPid = 1; });
ow('E5', 'FAIL', 'owner is a different program', (e) => { e.exeBase = 'sleep'; e.cmdline = ['sleep', '30']; });
ow('E6', 'FAIL', 'THE HUMAN\'S DAEMON as the owner (same exe + argv, sockets/env under /run/user)', (e) => { e.ownerPid = 3876821; e.cmdline = ['/usr/bin/gnome-keyring-daemon', '--start', '--foreground', '--components=secrets']; e.fdTargets = ['socket:[91]', 'socket:[92]']; e.sockets = [{ inode: 91, path: `${RT}/keyring/control` }, { inode: 92, path: `${RT}/bus` }]; e.socketPaths = [`${RT}/keyring/control`, `${RT}/bus`]; e.envEntries = [`XDG_RUNTIME_DIR=${RT}`]; });
ow('E7', 'FAIL', 'human daemon + environ UNREADABLE + fds named only by inode', (e) => { e.fdTargets = ['socket:[91]']; e.sockets = [{ inode: 91, path: `${RT}/keyring/control` }]; e.socketPaths = []; e.envEntries = []; });
ow('E8', 'FAIL', 'a daemon-shaped process holding NO socket under the arm keyring dir', (e) => { e.fdTargets = ['/dev/null']; });
ow('E9', 'FAIL', 'arm daemon that ALSO holds a path to the human\'s runtime (leak)', (e) => { e.socketPaths.push(`${RT}/keyring/pkcs11`); });
ow('E10', 'FAIL', 'arm daemon whose environ names the human runtime', (e) => { e.envEntries.push(`GNOME_KEYRING_CONTROL=${RT}/keyring`); }); ow('E11', 'FAIL', 'arm daemon whose argv names it', (e) => { e.cmdline.push(`--control-directory=${RT}/keyring`); });
ow('E12', 'FAIL', 'owner XDG_RUNTIME_DIR differs from the arm\'s', (e) => { e.envEntries = [`XDG_RUNTIME_DIR=${RIG}/xdg`]; });
ow('E13', 'PASS', 'CONTROL: environ unreadable is accepted when the sockets prove the arm', (e) => { e.envEntries = []; });
ow('E15', 'GAP', 'ss RETURNED NOTHING (blind scan): a foreign socket held only by inode is invisible, and the owner scan has NO positive control of its own', (e) => { e.fdTargets = ['socket:[11]', 'socket:[777]']; e.socketPaths = []; });
ow('E16', 'GAP', 'a binary COPIED to another path named gnome-keyring-daemon that binds an arm keyring socket (identity is exe basename + argv suffix, not /usr/bin path)', (e) => { e.cmdline = ['/var/tmp/evil/gnome-keyring-daemon']; });

// ── F. app tree + rig root ───────────────────────────────────────────────────────────────────────────────────────────────
const goodTree = () => ({ pids: 9, fdTargets: ['socket:[1]', '/dev/null'], socketPaths: [`${RUN}/orchestra-abcdef123456.sock`], envEntries: [`XDG_RUNTIME_DIR=${RUN}`], run: RUN });
const tr = (id, expect, label, f) => { const t = goodTree(); f(t); const c = W.treeChecks(t); row(id, expect, verdictOf(c), label, which(c)); };
tr('F1', 'PASS', 'CONTROL', () => {}); tr('F2', 'FAIL', 'a socket connected to the human\'s bus', (t) => { t.socketPaths.push(`${RT}/bus`); }); tr('F3', 'FAIL', 'an fd link naming the human dir', (t) => { t.fdTargets.push(`${RT}/keyring/control`); });
tr('F4', 'FAIL', 'env names it', (t) => { t.envEntries.push(`DBUS_SESSION_BUS_ADDRESS=unix:path=${RT}/bus`); }); tr('F5', 'FAIL', 'BLIND scan (ss empty): the positive control must refuse', (t) => { t.socketPaths = []; });
tr('F6', 'FAIL', 'too few processes (tree not found)', (t) => { t.pids = 1; }); tr('F7', 'FAIL', 'abstract-looking socket naming the human dir', (t) => { t.socketPaths.push(`@${RT}/bus`); });
tr('F8', 'GAP', 'connection to a human ABSTRACT socket (@/tmp/dbus-…): a path scan cannot attribute it (bwrap does not unshare the network namespace)', (t) => { t.socketPaths.push('@/tmp/dbus-HUMANSESSION'); });
const rc = (id, expect, label, entries, arms = ['k-a']) => { const c = W.rootCensusChecks(entries, arms); row(id, expect, verdictOf(c), label, which(c)); };
rc('G1', 'PASS', 'CONTROL', ['wayland-1', 'wayland-rig', 'k-a']); rc('G2', 'FAIL', 'keyring dir at the rig root', ['wayland-1', 'k-a', 'keyring']); rc('G3', 'FAIL', 'bus socket at the rig root', ['wayland-1', 'bus']);
rc('G4', 'FAIL', 'p11-kit at the rig root', ['wayland-1', 'p11-kit']); rc('G5', 'FAIL', 'an app hooks socket at the rig root', ['wayland-1', 'orchestra-abcdef123456.sock']); rc('G6', 'FAIL', 'an arm dir not announced', ['wayland-1', 'k-evil']);
rc('G7', 'FAIL', 'a hidden entry', ['wayland-1', '.p11-kit']); rc('G8', 'GAP', 'a `wayland-*` named keyring-shaped entry (prefix is all the census checks)', ['wayland-1', 'wayland-keyring']);

// ── H. NEW in 26c44bcb: %hh decoding ──────────────────────────────────────────────────────────────────────────────────────
const pct = (s2, n = 1) => { let x = s2; for (let i = 0; i < n; i++) x = encodeURIComponent(x); return x; };
ref('H1', 'FAIL', `unix:path=${pct(`${RT}/bus`)}`, 'dbus address, %-encoded once (the shipped D-Bus escape form)'); ref('H2', 'FAIL', pct(`${RT}/bus`, 2), 'double-encoded'); ref('H3', 'FAIL', pct(`${RT}/bus`, 3), 'triple-encoded');
ref('H4', 'FAIL', `/run%2fuser%2f${UID}/bus`, 'mixed-case lowercase %2f'); ref('H5', 'FAIL', `/tmp/x/%2e%2e/%2e%2e${RT}`, '%2e%2e climb'); ref('H6', 'FAIL', `${RT.replace('/run', '%2Frun')}`, 'partly encoded');
ref('H7', 'FAIL', `50%`, 'malformed trailing % (fails closed)'); ref('H8', 'FAIL', `%zz/run/x`, 'malformed %zz (fails closed)'); ref('H9', 'FAIL', `%E0%A4%A`, 'malformed UTF-8 (fails closed)'); ref('H10', 'FAIL', '%u002Frun%u002Fuser', 'JS-style %u escape (malformed, fails closed)');
ref('H11', 'GAP', pct(`${RT}/bus`, 4), 'QUADRUPLE-encoded (only 3 rounds decoded)'); ref('H12', 'GAP', pct(`${RT}/bus`, 6), 'sextuple-encoded');
ref('H13', 'PASS', '100%25', 'CONTROL: a well-formed literal percent'); ref('H14', 'PASS', `${RIG}/xdg/k-a/bus`, 'CONTROL: private path');
ref('H15', 'GAP', `/run/user%00/${UID}`, 'NUL byte split (kernel path ends at the NUL; env values cannot carry one)');
ref('H16', 'FAIL', `%2Frun%2Fuser`, 'encoded parent dir');
// ── I. NEW: hiddenRuntimeMountProof (pure; forged mountinfo texts) ────────────────────────────────────────────────────────
const mi = (id, expect, label, text) => { const r = W.hiddenRuntimeMountProof(text, UID); row(id, expect, r.ok ? 'PASS' : 'FAIL', label, r.detail.slice(0, 110)); };
const L = (id, par, fstype, tags = '') => `${id} ${par} 0:${id} / ${RT} rw,nosuid,nodev,relatime${tags ? ' ' + tags : ''} - ${fstype} ${fstype} rw,size=1k`;
mi('I1', 'PASS', 'CONTROL: stacked private tmpfs over the shared host mount', `${L(100, 50, 'tmpfs', 'shared:223')}\n${L(200, 100, 'tmpfs')}\n`);
mi('I2', 'FAIL', 'host: ONE mount at the runtime dir', `${L(100, 50, 'tmpfs', 'shared:223')}\n`); mi('I3', 'FAIL', 'no mount at the dir', '1 0 0:1 / / rw - ext4 /dev/x rw\n'); mi('I4', 'FAIL', 'empty text', ''); mi('I5', 'FAIL', 'garbage text', 'not a mountinfo\n\u0000\n');
mi('I6', 'FAIL', 'top is not tmpfs (overlay)', `${L(100, 50, 'tmpfs', 'shared:223')}\n${L(200, 100, 'overlay')}\n`); mi('I7', 'FAIL', 'top carries propagation tags (shared)', `${L(100, 50, 'tmpfs', 'shared:223')}\n${L(200, 100, 'tmpfs', 'shared:300')}\n`);
mi('I8', 'FAIL', 'top carries master: tag', `${L(100, 50, 'tmpfs', 'shared:223')}\n${L(200, 100, 'tmpfs', 'master:12')}\n`);
mi('I9', 'FAIL', 'something mounted ON the hiding tmpfs (re-exposing bind)', `${L(100, 50, 'tmpfs', 'shared:223')}\n${L(200, 100, 'tmpfs')}\n300 200 0:77 / ${RT}/x rw - tmpfs tmpfs rw\n`);
mi('I10', 'FAIL', 'a different dir hidden (uid 9999) while the real one is not', `${L(100, 50, 'tmpfs', 'shared:223')}\n200 100 0:99 / /run/user/9999 rw - tmpfs tmpfs rw\n`);
mi('I11', 'FAIL', 'mount point spelled with an escape (\\040) is NOT the dir', `100 50 0:30 / ${RT}\\040 rw - tmpfs tmpfs rw\n200 100 0:99 / ${RT}\\040 rw - tmpfs tmpfs rw\n`);
mi('I12', 'FAIL', 'point differs by a trailing slash', `100 50 0:30 / ${RT}/ rw shared:1 - tmpfs tmpfs rw\n200 100 0:99 / ${RT}/ rw - tmpfs tmpfs rw\n`);
mi('I13', 'FAIL', 'cycle: ids point at each other (no top)', `100 200 0:30 / ${RT} rw shared:1 - tmpfs tmpfs rw\n200 100 0:99 / ${RT} rw - tmpfs tmpfs rw\n`);
mi('I14', 'GAP', 'TWO unrelated roots at the dir (not a stack): verdict depends on LINE ORDER (private tmpfs listed first)', `${L(200, 5, 'tmpfs')}\n${L(100, 5, 'tmpfs', 'shared:223')}\n`);
mi('I15', 'FAIL', 'same two unrelated roots, host mount listed first', `${L(100, 5, 'tmpfs', 'shared:223')}\n${L(200, 5, 'tmpfs')}\n`);
mi('I16', 'GAP', 'a hiding tmpfs that is NOT empty (the proof looks at mounts, not contents; the rig script lists it separately)', `${L(100, 50, 'tmpfs', 'shared:223')}\n${L(200, 100, 'tmpfs')}\n`);
mi('I17', 'FAIL', 'a mount source containing " - " (parser sees the FIRST separator), plus a mount on top', `100 50 0:30 / ${RT} rw shared:1 - tmpfs tmpfs rw\n200 100 0:99 / ${RT} rw - tmpfs a - b rw\n300 200 0:5 / ${RT}/z rw - tmpfs x rw\n`);
// ── J. NEW: physicalWorldChecks (pure) ────────────────────────────────────────────────────────────────────────────────────
const phy = (id, expect, label, f) => { const facts = { rigDir: RIG, rigReal: RIG, xdgReal: `${RIG}/xdg`, envPhysical: {}, ...f }; const c = W.physicalWorldChecks(facts); row(id, expect, verdictOf(c), label, which(c)); };
phy('J1', 'PASS', 'CONTROL'); phy('J2', 'FAIL', 'xdg resolves into the human runtime', { xdgReal: RT }); phy('J3', 'FAIL', 'xdg resolves elsewhere', { xdgReal: '/var/other/xdg' }); phy('J4', 'FAIL', 'rig dir does not resolve', { rigReal: null });
phy('J5', 'FAIL', 'rig dir resolves into the human runtime', { rigReal: `${RT}/rig`, xdgReal: `${RT}/rig/xdg` }); phy('J6', 'FAIL', 'an env path value is a link into it', { envPhysical: { FOO: [`${RT}/x`] } });
phy('J7', 'FAIL', 'a link to exactly /run/user (parent dir)', { envPhysical: { FOO: ['/run/user'] } }); phy('J8', 'FAIL', 'a dangling link whose TARGET text is /run/user/1000/x', { envPhysical: { FOO: [`${RT}/x`] } });
phy('J9', 'PASS', 'CONTROL: path values that resolve inside the rig', { envPhysical: { HOME: [`${RIG}/home`] } });
// ── K. (rewritten for 39243f07) /proc/net/unix + ss pairing: parseProcNetUnix / parseSsPairs / buildSocketScan / socketPaths ───────────────────────────────
const PNU_HEAD = 'Num       RefCount Protocol Flags    Type St Inode Path\n';
const pn = (rows) => PNU_HEAD + rows.map(([ino, p]) => `0000000000000000: 00000002 00000000 00010000 0001 01 ${ino}${p === undefined ? '' : ' ' + p}`).join('\n') + '\n';
const REALTAIL = (ss) => ss.split('\n').map((l) => (/^u_(str|dgr|seq)\s/.test(l) && !/(<->|-->|<--|---)/.test(l) ? `${l} <-> ino:5 dev:0/36 sk:1` : l)).join('\n'); // fixtures carry what the real producer prints
const scanT = (id, expect, label, procnet, ss, inodes, check) => { let r, paths = null; try { r = W.buildSocketScan(procnet, REALTAIL(ss)); paths = W.socketPaths(inodes, r.scan); } catch (e) { r = { scan: null, unparsed: ['THROW ' + e.message] }; } const okv = check(paths, r.unparsed); row(id, expect, okv ? 'PASS' : 'FAIL', label, `paths=${JSON.stringify(paths)} unparsed=${r.unparsed.length}`); };
const one = (id, expect, label, procnet, ss, inodes, want, wantUnparsed = 0) => scanT(id, expect, label, procnet, ss, inodes, (paths, un) => paths !== null && JSON.stringify(paths) === JSON.stringify(want) && un.length === wantUnparsed);
// controls
one('K1', 'PASS', 'CONTROL: client (unnamed) → listener path via the peer inode; accepted end carries the listener path', pn([[111, '/run/x/k-a/bus'], [222], [333, '/run/x/k-a/bus']]),
  `u_str LISTEN 0 4096 /run/x/k-a/bus 111 * 0\nu_str ESTAB 0 0 * 222 * 333 <->\nu_str ESTAB 0 0 /run/x/k-a/bus 333 * 222 <->\n`, [222], ['/run/x/k-a/bus']);
one('K2', 'PASS', 'spaced path on the listener', pn([[444, '/run/x/my sock'], [445]]), 'u_str LISTEN 0 4096 /run/x/my sock 444 * 0\nu_str ESTAB 0 0 * 445 /run/x/my sock 444 <->\n', [445, 444], ['/run/x/my sock']);
one('K3', 'PASS', 'unicode path', pn([[446, '/run/x/ソケット']]), 'u_str LISTEN 0 4096 /run/x/ソケット 446 * 0\n', [446], ['/run/x/ソケット']);
one('K4', 'PASS', 'abstract @ socket is parsed but has no path (declared: abstract sockets are not placed)', pn([[447, '@/var/dbus-abc']]), 'u_str LISTEN 0 4096 @/var/dbus-abc 447 * 0\n', [447], []);
one('K5', 'PASS', 'every shutdown marker', pn([[500, '/a/b0'], [501, '/a/b1'], [502, '/a/b2'], [503, '/a/b3']]), ['<->', '-->', '<--', '---'].map((m, i) => `u_str ESTAB 0 0 /a/b${i} ${500 + i} * ${600 + i} ${m} ino:1 sk:2\n`).join(''), [500, 501, 502, 503], ['/a/b0', '/a/b1', '/a/b2', '/a/b3']);
// path with number tokens / address-looking tokens
one('K6', 'PASS', 'path "/run/x/my 123 sock" (number token) on the listener', pn([[555, '/run/x/my 123 sock']]), 'u_str LISTEN 0 4096 /run/x/my 123 sock 555 * 0\n', [555], ['/run/x/my 123 sock']);
one('K7', 'PASS', 'FORGED shape: path "/run/x/a 123 /b" — 123 is NOT a real socket inode → resolved by /proc/net/unix', pn([[555, '/run/x/a 123 /b']]), 'u_str LISTEN 0 4096 /run/x/a 123 /b 555 * 0\n', [555], ['/run/x/a 123 /b']);
one('K8', 'FAIL', 'FORGED shape where the embedded number IS another real socket inode → must NOT be silently placed (fail closed = unparsed)', pn([[555, '/run/x/a 123 /b'], [123, '/run/y/other']]), 'u_str LISTEN 0 4096 /run/x/a 123 /b 555 * 0\n', [555], ['/run/x/a 123 /b'], 0);
one('K9', 'PASS', 'same forged row, both inodes real → UNPARSED (fail closed), nothing mis-attributed', pn([[555, '/run/x/a 123 /b'], [123, '/run/y/other']]), 'u_str LISTEN 0 4096 /run/x/a 123 /b 555 * 0\n', [], [], 1);
one('K10', 'PASS', 'client whose PEER path has spaces + a number token', pn([[700], [701, '/run/x/p 9 q']]), 'u_str ESTAB 0 0 * 700 /run/x/p 9 q 701 <->\nu_str ESTAB 0 0 /run/x/p 9 q 701 * 700 <->\n', [700], ['/run/x/p 9 q']);
one('K11', 'GAP', 'ss path ending with a marker lookalike ("…/x <->") on a listener is now PLACED', pn([[800, '/run/x/y <->']]), 'u_str LISTEN 0 4096 /run/x/y <-> 800 * 0\n', [800], ['/run/x/y <->']);
one('K12', 'FAIL', 'garbage line must be REPORTED (unparsed), not dropped', pn([[900, '/a']]), 'this is not an ss row\nu_str LISTEN 0 4096 /a 900 * 0\n', [900], ['/a'], 0);
one('K13', 'PASS', 'garbage line reported', pn([[900, '/a']]), 'this is not an ss row\nu_str LISTEN 0 4096 /a 900 * 0\n', [900], ['/a'], 1);
one('K14', 'PASS', 'truncated row reported', pn([[901, '/a']]), 'u_str ESTAB 0 0 /run/x/y 33', [901], ['/a'], 1);
one('K15', 'PASS', 'tab-separated ss columns', pn([[902, '/run/x/c']]), 'u_str\tLISTEN\t0\t4096\t/run/x/c\t902\t*\t0\n', [902], ['/run/x/c']);
one('K16', 'PASS', 'empty ss output parses to nothing (the CALLER must refuse empty)', pn([[903, '/a']]), '', [903], ['/a']);
one('K17', 'PASS', '/proc/net/unix path with a TRAILING space is kept byte-exact', pn([[904, '/run/x/trail ']]), '', [904], ['/run/x/trail ']);
one('K18', 'PASS', 'a socket closed between the two snapshots (ss row names an inode absent from /proc/net/unix) with a UNIQUE shape does not abort the scan', pn([[905, '/a']]), 'u_str ESTAB 0 0 * 999 /a 905 <->\n', [905], ['/a']);
one('K19', 'PASS', 'unnamed socket (no path) in /proc/net/unix counts as a known inode, has no path', pn([[906]]), 'u_str ESTAB 0 0 * 906 * 0\n', [906], []);
one('K20', 'GAP', 'a RELATIVE-bound listener name ("bus" bound with cwd=/run/user/1000) is not a path in /proc/net/unix → not attributed', pn([[907, 'bus']]), 'u_str LISTEN 0 4096 bus 907 * 0\n', [907], [], 0);
// parseProcNetUnix itself
const pnT = (id, expect, label, text, check) => { let r; try { r = W.parseProcNetUnix(text); } catch (e) { r = null; } row(id, expect, r && check(r) ? 'PASS' : 'FAIL', label, r ? `sockets=${r.sockets.length} inodes=${r.inodes.size}` : 'THROW'); };
pnT('K21', 'PASS', 'header line is skipped, never counted as a socket', PNU_HEAD, (r) => r.sockets.length === 0 && r.inodes.size === 0);
pnT('K22', 'PASS', 'two spaces inside the name survive byte-exact', pn([[1000, '/run/x/a  b']]), (r) => r.sockets[0]?.path === '/run/x/a  b');
pnT('K23', 'PASS', 'a name with a newline-free quote/backslash', pn([[1001, '/run/x/a"b\\c']]), (r) => r.sockets[0]?.path === '/run/x/a"b\\c');
pnT('K24', 'PASS', 'inode 0 (embryonic: ignored by design since 6456bd28) / huge inode', pn([[0, '/a'], [4294967295, '/b']]), (r) => r.sockets.length === 1 && r.sockets[0].inode === 4294967295);
pnT('K25', 'PASS', 'garbage rows ignored, valid kept', 'junk\n' + pn([[1002, '/ok']]), (r) => r.sockets.length === 1);

// K28+ (FINDING, real-kernel confirmed by ss-real.mjs): the unanchored SS_TAIL strips from the FIRST marker lookalike INSIDE the path, so a bound+connected socket named
// "<dir>/p 1 /q 2 --- zz" is read as a fabricated pair (1,2) and its REAL link to the human socket is lost SILENTLY (no unparsed). exp GAP = hostile passes unnoticed.
{
  const HUMAN = '/run/user/1000/bus', R = '/scratch/rig';
  for (const [id, name] of [['K28', `${R}/p 1 /q 2 --- zz`], ['K29', `${R}/p 1 /q 2 <-> zz`], ['K30', `${R}/q 1 /r 2 --> zz`], ['K31', `${R}/d 5 /e 6 <-- w 7 * 8`]]) {
    const ss = `u_str ESTAB  0      0      ${name} 700 * 701 <-> ino:201225872 dev:0/36 sk:1\nu_str ESTAB  0      0      ${HUMAN} 701 * 700 <-> ino:5 dev:0/36 sk:2\n`;
    const { scan, unparsed } = W.buildSocketScan(pn([[700, name], [701, HUMAN]]), ss); const sees = W.socketPaths([700], scan).includes(HUMAN);
    row(id, 'FAIL', sees || unparsed.length ? 'FAIL' : 'PASS', `F1 FIXED in 6456bd28: hostile socket name with marker lookalike keeps its link to the human socket (or is reported): ${JSON.stringify(name)}`, `sees=${sees} unparsed=${unparsed.length}`);
  }
  const ssc = `u_str ESTAB  0      0      ${R}/hostile 700 * 701 <-> ino:201225872 dev:0/36 sk:1\nu_str ESTAB  0      0      ${HUMAN} 701 * 700 <-> ino:5 dev:0/36 sk:2\n`;
  const c = W.buildSocketScan(pn([[700, `${R}/hostile`], [701, HUMAN]]), ssc); row('K32', 'PASS', W.socketPaths([700], c.scan).includes(HUMAN) ? 'PASS' : 'FAIL', 'CONTROL: the same row with a plain name sees the human socket');
}

// K40+ (6456bd28 delta, "can a STRANGER's row hide a connection of OURS?"): real-shaped ss rows (marker + ino:/dev: tail). exp GAP = hostile passes unnoticed.
{
  const TAIL = '<-> ino:5 dev:0/36 sk:1';
  const HB = '/run/user/9999/bus'; // stand-in for the human's bus (never stat'd: pure strings)
  const base = [[500], [502, HB], [801, '/stranger peer'], [803, '/stranger b']];
  const ours = `u_str ESTAB 0 0 * 500 * 502 ${TAIL}\nu_str ESTAB 0 0 ${HB} 502 * 500 ${TAIL}\n`;
  const see = (pnRows, ss, label, id, expect, extra = '') => { const { scan, unparsed } = W.buildSocketScan(pn(pnRows), ss); const got = W.socketPaths([500], scan); const about = W.unparsedAbout(unparsed, new Set([500])); const sees = got.includes(HB); row(id, expect, (sees || about.length) ? 'FAIL' : 'PASS', label, `sees=${sees} paths=${JSON.stringify(got)} unparsedAboutOurs=${about.length}${extra}`); };
  see(base, ours, 'CONTROL: our client → the human bus, no stranger row', 'K40', 'FAIL');
  // the stranger names a socket "/x 500 /y" (500 = OUR inode); its own local inode 800 is already CLOSED when /proc/net/unix is read (closed between the two snapshots)
  const strangerRow = `u_str ESTAB 0 0 /x 500 /y 800 * 801 ${TAIL}\n`;
  see(base, ours + strangerRow, 'stranger row AFTER ours, its real local inode (800) closed between the snapshots → fabricated pair (500→801) overwrites ours', 'K41', 'GAP');
  see(base, strangerRow + ours, 'same stranger row BEFORE ours (ours wins the Map — order-dependent)', 'K42', 'FAIL');
  see([...base, [800, '/x 500 /y']], ours + strangerRow, 'the stranger socket 800 still alive at the /proc/net/unix read → ambiguity → UNPARSED about our inode → abort (fail closed)', 'K43', 'FAIL');
  // duplicate pairs for one local inode: the scan keeps the LAST silently
  { const { scan } = W.buildSocketScan(pn(base), ours + `u_str ESTAB 0 0 * 500 * 803 ${TAIL}\n`); const peer = scan.peerOf.get(500); row('K44', 'GAP', peer === 502 ? 'FAIL' : 'PASS', 'two ss rows with the SAME local inode (500) and different peers: the later silently replaces the earlier (no conflict detection)', `peerOf(500)=${peer}`); }
}

{ const rows = `u_str ESTAB 0 0 /x 500 garbage ${'<-> ino:5 dev:0/36'}\n`; const { unparsed } = W.buildSocketScan(pn([[500]]), rows); const about = W.unparsedAbout(unparsed, new Set([500])); const aboutOther = W.unparsedAbout(unparsed, new Set([999])); row('K45', 'FAIL', about.length === 1 && aboutOther.length === 0 ? 'FAIL' : 'PASS', 'an unplaceable row mentioning OUR inode (500) is reported as about-us; one mentioning none of ours is not (the stranger rule, both directions)', `about=${about.length} aboutOther=${aboutOther.length}`); }
// pathological input: time-boxed
{
  const t0 = Date.now(); const big = pn(Array.from({ length: 200000 }, (_, i) => [i + 1, `/run/x/s${i}`])); const ssBig = Array.from({ length: 200000 }, (_, i) => `u_str LISTEN 0 4096 /run/x/s${i} ${i + 1} * 0 <-> ino:5 dev:0/36`).join('\n');
  const r = W.buildSocketScan(big, ssBig); const ms = Date.now() - t0; row('K26', 'PASS', ms < 8000 && r.unparsed.length === 0 ? 'PASS' : 'FAIL', '200k-socket host: parse time + 0 unparsed', `${ms} ms`);
  const w = ' '.repeat(40000); const t1 = Date.now(); const r2 = W.parseSsPairs('u_str LISTEN 0 4096 /a' + w + 'b 5 * 0', new Set([5])); const ms2 = Date.now() - t1; row('K27', 'GAP', ms2 < 2000 ? 'PASS' : 'FAIL', 'whitespace-run line (quadratic SS_TAIL; moot: sun_path <= 108 bytes)', `${ms2} ms pairs=${r2.pairs.length} unparsed=${r2.unparsed.length}`);
}
// I. addendum — same-device (self-bind / re-bind) fixtures for hiddenRuntimeMountProof (mountinfo: id parent major:minor root point opts [tags] - fstype source super)
const mi2 = (id, parent, dev, point, fstype, tags = '') => `${id} ${parent} ${dev} / ${point} rw,nosuid${tags ? ' ' + tags : ''} - ${fstype} tmpfs rw`;
const hid2 = (id, expect, label, lines) => row(id, expect, W.hiddenRuntimeMountProof(lines.join('\n') + '\n', UID).ok ? 'PASS' : 'FAIL', label, W.hiddenRuntimeMountProof(lines.join('\n') + '\n', UID).detail);
hid2('I18', 'PASS', 'CONTROL: host tmpfs (0:50, shared) then a fresh private tmpfs with its OWN device (0:90)', [mi2(100, 20, '0:50', RT, 'tmpfs', 'shared:223'), mi2(200, 100, '0:90', RT, 'tmpfs')]);
hid2('I19', 'FAIL', 'SELF-BIND: topmost private tmpfs shares the device of the host mount (0:50)', [mi2(100, 20, '0:50', RT, 'tmpfs', 'shared:223'), mi2(200, 100, '0:50', RT, 'tmpfs')]);
hid2('I20', 'FAIL', 'host + hide + RE-BIND of the host dir on top (rebind shares 0:50, the hide has 0:90)', [mi2(100, 20, '0:50', RT, 'tmpfs', 'shared:223'), mi2(200, 100, '0:90', RT, 'tmpfs'), mi2(300, 200, '0:50', RT, 'tmpfs')]);
hid2('I21', 'FAIL', 'top shares the device of a NON-adjacent lower mount (3-deep stack)', [mi2(100, 20, '0:50', RT, 'tmpfs', 'shared:1'), mi2(150, 100, '0:60', RT, 'tmpfs'), mi2(200, 150, '0:50', RT, 'tmpfs')]);
hid2('I22', 'FAIL', 'both stacked mounts report the SAME device (fresh tmpfs impossible)', [mi2(100, 20, '0:50', RT, 'tmpfs', 'shared:1'), mi2(200, 100, '0:50', RT, 'tmpfs')]);
hid2('I23', 'PASS', 'a DIFFERENT tmpfs (e.g. /dev/shm instance 0:70) bind-mounted over the dir: own device → accepted (declared: contents not proven empty)', [mi2(100, 20, '0:50', RT, 'tmpfs', 'shared:1'), mi2(200, 100, '0:70', RT, 'tmpfs')]);
hid2('I24', 'FAIL', 'device field missing/garbled on the top line (parser must not treat undefined === undefined as "own device")', [mi2(100, 20, '0:50', RT, 'tmpfs', 'shared:1'), '200 100 - / ' + RT + ' rw - tmpfs tmpfs rw']);

console.log(`SUMMARY: ok=${ok} declared-gaps=${gaps} bypass=${bad}`);
process.exit(bad ? 1 : 0);
