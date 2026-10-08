// #331 — the PURE half of the browser-Reliquat bridge (ledger #329 track H10): what is a browser Reliquat, and when is it stopped. Each arm names the clause it protects
// (in-place mutants: scripts/pause-trap/mutants-browser-reliquats.mjs).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BROWSER_IDLE_WINDOW_MS,
  clientConnected,
  commonProfilePrefix,
  decideBrowserReliquat,
  descendantsOf,
  isBrowserComm,
  launcherDead,
  listeningPortsOf,
  nextTrack,
  parseBrowserArgv,
  parseProcNetTcp,
  profileOwner,
  type BrowserFacts,
  type BrowserTrack,
} from './browser-reliquats.ts';

const ROOT = '/home/u/.orchestra/agent-tmp';
const PW = ['/home/u/.cache/ms-playwright/chromium-1200/chrome-linux/chrome', '--headless=new', '--remote-debugging-pipe', `--user-data-dir=${ROOT}/ws-1/tmp/pw-profile-abc`, '--no-sandbox'];

test('parseBrowserArgv: a Playwright-style MAIN browser is pipe mode with its profile; --remote-debugging-port is port mode (both spellings, 0 = the browser picks); --headless alone is headless', () => {
  assert.deepEqual(parseBrowserArgv(PW), { mode: 'pipe', port: null, userDataDir: `${ROOT}/ws-1/tmp/pw-profile-abc` });
  assert.deepEqual(parseBrowserArgv(['/usr/bin/chromium-browser', '--headless', '--remote-debugging-port=9222', '--user-data-dir', '/x/p']), { mode: 'port', port: 9222, userDataDir: '/x/p' });
  assert.deepEqual(parseBrowserArgv(['chrome', '--remote-debugging-port', '0']), { mode: 'port', port: 0, userDataDir: null });
  assert.deepEqual(parseBrowserArgv(['/opt/headless_shell', '--headless', '--user-data-dir=/x/p']), { mode: 'headless', port: null, userDataDir: '/x/p' });
  assert.equal(parseBrowserArgv(['chrome', '--headless', '--remote-debugging-pipe', '--remote-debugging-port=9222'])?.mode, 'port', 'a browser with BOTH can still be driven through its port: a live client must protect it');
});

test('parseBrowserArgv: NOT a browser we handle — a child process (any --type=), the human\'s window (no headless / remote-debugging flag), another executable, a malformed port', () => {
  for (const type of ['renderer', 'gpu-process', 'zygote', 'utility', 'crashpad-handler']) assert.equal(parseBrowserArgv([...PW, `--type=${type}`]), null, type);
  assert.equal(parseBrowserArgv(['/usr/bin/chromium-browser', '--user-data-dir=/home/u/.config/chromium']), null, 'the human\'s own browser: no headless, no remote control');
  assert.equal(parseBrowserArgv(['/usr/bin/node', '--headless', '--remote-debugging-pipe']), null);
  assert.equal(parseBrowserArgv(['chrome', '--remote-debugging-port=notaport']), null);
  assert.equal(parseBrowserArgv(['chrome', '--remote-debugging-port=70000']), null);
  assert.equal(parseBrowserArgv([]), null);
});

test('isBrowserComm: the cheap pre-filter on the kernel comm (15 chars) — Chromium family only', () => {
  for (const c of ['chrome', 'chromium', 'chromium-browse', 'headless_shell', 'google-chrome', 'chrome-headless']) assert.equal(isBrowserComm(c), true, c);
  for (const c of ['node', 'bash', 'firefox', 'electron', 'sleep', 'python3']) assert.equal(isBrowserComm(c), false, c);
});

test('profileOwner: attribution is the profile\'s place under <agent-tmp>/<ws-id>/ — outside the root, the root itself, a relative path, a `..` climb, an odd id → nobody', () => {
  assert.deepEqual(profileOwner(`${ROOT}/ws-1/tmp/pw`, ROOT), { wsId: 'ws-1', prefix: `${ROOT}/ws-1/` });
  assert.deepEqual(profileOwner(`${ROOT}/ws-1`, ROOT), { wsId: 'ws-1', prefix: `${ROOT}/ws-1/` }, 'the workspace dir itself');
  assert.deepEqual(profileOwner(`${ROOT}/ws-1/a/../b/`, ROOT)?.wsId, 'ws-1', 'normalised first');
  assert.equal(profileOwner('/home/u/.config/chromium', ROOT), null, 'a default profile');
  assert.equal(profileOwner('/home/u/.orchestra/agent-tmpx/ws-1/p', ROOT), null, 'a sibling dir that merely starts with the root\'s name');
  // outside paths LONGER than the root (a short one slices to an empty id by luck, which hid a missing prefix check), a look-alike sibling with a longer suffix, and a RELATIVE root with a relative dir
  assert.equal(profileOwner('/var/lib/some/other/place/that/is/longer/than/the/root/ws-9/p', ROOT), null, 'a long path outside the root');
  assert.equal(profileOwner('/home/u/.orchestra/agent-tmp-old/ws-1/p', ROOT), null, 'a sibling dir whose name merely starts with the root\'s');
  assert.equal(profileOwner('agent-tmp/ws-1/p', 'agent-tmp'), null, 'relative root + relative dir');
  assert.equal(profileOwner(ROOT, ROOT), null);
  assert.equal(profileOwner(`${ROOT}/`, ROOT), null);
  assert.equal(profileOwner('relative/ws-1/p', ROOT), null);
  assert.equal(profileOwner(`${ROOT}/ws-1/../../etc`, ROOT), null, 'climbs out');
  assert.equal(profileOwner(`${ROOT}/../ws-1/p`, ROOT), null);
  assert.equal(profileOwner(`${ROOT}/ws 1/p`, ROOT), null);
  assert.equal(profileOwner(null, ROOT), null);
});

test('launcherDead: parent init (or none) or the USER MANAGER that adopts orphans; any other parent is a live launcher', () => {
  assert.equal(launcherDead(1, null), true);
  assert.equal(launcherDead(0, null), true);
  assert.equal(launcherDead(2000, { comm: 'systemd', ppid: 1 }), true, 'systemd --user');
  assert.equal(launcherDead(2000, { comm: 'node', ppid: 1900 }), false, 'a node launcher script');
  assert.equal(launcherDead(2000, { comm: 'systemd', ppid: 1900 }), false, 'a systemd that is not the manager');
  assert.equal(launcherDead(2000, null), false, 'a parent we cannot see is not "dead"');
});

const base: BrowserFacts = { parsed: { mode: 'port', port: 9222, userDataDir: `${ROOT}/ws-1/p` }, owner: { wsId: 'ws-1', prefix: `${ROOT}/ws-1/` }, ownerKnown: true, launcherDead: true, client: 'no' };
const W = BROWSER_IDLE_WINDOW_MS;
const T0 = 1_000_000;
const track = (firstOrphanAt: number, lastClientAt: number | null = null): BrowserTrack => ({ firstOrphanAt, lastClientAt });

test('decide — NEVER stop: not attributable, an unknown workspace, a live launcher (each beats every stop reason, pipe mode included)', () => {
  for (const mode of ['pipe', 'port', 'headless'] as const) {
    const f = { ...base, parsed: { ...base.parsed, mode } };
    assert.deepEqual(decideBrowserReliquat({ ...f, owner: null }, track(0), T0 + 5 * W, W), { stop: false, why: 'not-attributable' }, mode);
    assert.deepEqual(decideBrowserReliquat({ ...f, ownerKnown: false }, track(0), T0 + 5 * W, W), { stop: false, why: 'unknown-workspace' }, mode);
    assert.deepEqual(decideBrowserReliquat({ ...f, launcherDead: false }, track(0), T0 + 5 * W, W), { stop: false, why: 'launcher-alive' }, mode);
  }
});

test('decide — PIPE mode: stopped AT ONCE (first sight, no window, even with nothing known about clients)', () => {
  const v = decideBrowserReliquat({ ...base, parsed: { ...base.parsed, mode: 'pipe' }, client: 'unknown' }, track(T0), T0, W);
  assert.equal(v.stop, true);
});

test('decide — PORT mode: a live client protects, an unreadable client state protects (UNKNOWN is not NONE), and no client is stopped only after the idle window', () => {
  assert.deepEqual(decideBrowserReliquat({ ...base, client: 'yes' }, track(0, T0), T0 + 5 * W, W), { stop: false, why: 'client-connected' });
  assert.deepEqual(decideBrowserReliquat({ ...base, client: 'unknown' }, track(0), T0 + 5 * W, W), { stop: false, why: 'client-unknown' });
  const young = decideBrowserReliquat(base, track(T0), T0 + W - 1, W);
  assert.deepEqual([young.stop, young.why], [false, 'idle-window']);
  assert.equal(decideBrowserReliquat(base, track(T0), T0 + W, W).stop, true, 'exactly N minutes: stopped');
  // the window restarts at the last client seen
  assert.equal(decideBrowserReliquat(base, track(T0, T0 + 8 * 60_000), T0 + 12 * 60_000, W).stop, false, 'a client 4 min ago: still inside the window');
  assert.equal(decideBrowserReliquat(base, track(T0, T0 + 8 * 60_000), T0 + 18 * 60_000, W).stop, true, 'a client 10 min ago: outside');
  // headless without any debugging interface follows the same window (no client can ever exist)
  assert.equal(decideBrowserReliquat({ ...base, parsed: { ...base.parsed, mode: 'headless', port: null } }, track(T0), T0 + W - 1, W).stop, false);
  assert.equal(decideBrowserReliquat({ ...base, parsed: { ...base.parsed, mode: 'headless', port: null } }, track(T0), T0 + W, W).stop, true);
});

test('decide — a Pause dure ignores the idle window (the member is frozen) but a live client or an unreadable one still protects', () => {
  assert.equal(decideBrowserReliquat(base, track(T0), T0, W, true).stop, true);
  assert.equal(decideBrowserReliquat({ ...base, client: 'yes' }, track(T0), T0, W, true).stop, false);
  assert.equal(decideBrowserReliquat({ ...base, client: 'unknown' }, track(T0), T0, W, true).stop, false);
  assert.equal(decideBrowserReliquat({ ...base, launcherDead: false }, track(T0), T0, W, true).stop, false);
});

test('nextTrack: first sight starts the clock, a client stamps lastClientAt, no client keeps the last stamp', () => {
  const a = nextTrack(undefined, 100, 'no');
  assert.deepEqual(a, { firstOrphanAt: 100, lastClientAt: null });
  const b = nextTrack(a, 200, 'yes');
  assert.deepEqual(b, { firstOrphanAt: 100, lastClientAt: 200 });
  assert.deepEqual(nextTrack(b, 300, 'no'), { firstOrphanAt: 100, lastClientAt: 200 });
  assert.deepEqual(nextTrack(b, 300, 'unknown'), { firstOrphanAt: 100, lastClientAt: 300 }, 'time spent UNKNOWN is not time without a client: it restarts the window');
});

const TCP = `  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 0100007F:2382 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 5550001 1 0000000000000000 100 0 0 10 0
   1: 0100007F:2382 0100007F:B1F4 01 00000000:00000000 00:00000000 00000000  1000        0 5550002 1 0000000000000000 20 4 30 10 -1
   2: 0100007F:B1F4 0100007F:2382 01 00000000:00000000 00:00000000 00000000  1000        0 5550003 1 0000000000000000 20 4 30 10 -1
   3: 00000000:0016 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 5550004 1 0000000000000000 100 0 0 10 0
garbage line
`;

test('/proc/net/tcp: LISTEN ports are the process\' own (by socket inode); a client is an ESTABLISHED socket whose LOCAL port is one of them — never another process\' listener', () => {
  const rows = parseProcNetTcp(TCP);
  assert.equal(rows.length, 4);
  assert.deepEqual(rows[0], { localPort: 0x2382, remotePort: 0, state: '0A', inode: 5550001 });
  assert.deepEqual(listeningPortsOf(rows, new Set([5550001, 5550002])), [0x2382], 'inode 5550002 is an ESTABLISHED socket, not a listener');
  assert.deepEqual(listeningPortsOf(rows, new Set([5550004])), [22], 'sshd\'s port is not ours unless we own the inode');
  assert.deepEqual(listeningPortsOf(rows, new Set([999])), []);
  assert.equal(clientConnected(rows, [0x2382]), true);
  assert.equal(clientConnected(rows, [22]), false, 'LISTEN only, no ESTABLISHED on port 22');
  assert.equal(clientConnected(rows, []), false);
  assert.equal(clientConnected(rows.filter((r) => r.inode !== 5550002), [0x2382]), false, 'without the accepted socket there is no client');
});

test('descendantsOf: the root first, then its children breadth-first; a cycle ends; a missing root is empty', () => {
  const t = [{ pid: 1, ppid: 0 }, { pid: 10, ppid: 1 }, { pid: 11, ppid: 10 }, { pid: 12, ppid: 10 }, { pid: 13, ppid: 11 }, { pid: 99, ppid: 98 }];
  assert.deepEqual(descendantsOf(t, 10).map((p) => p.pid), [10, 11, 12, 13]);
  assert.deepEqual(descendantsOf([{ pid: 5, ppid: 6 }, { pid: 6, ppid: 5 }], 5).map((p) => p.pid), [5, 6]);
  assert.deepEqual(descendantsOf(t, 777), []);
});

test('commonProfilePrefix: the deepest shared directory of the stopped profiles, never shorter than the workspace\'s agent-tmp root', () => {
  const fb = `${ROOT}/ws-1/`;
  assert.equal(commonProfilePrefix([`${ROOT}/ws-1/tmp/a`, `${ROOT}/ws-1/tmp/b`], fb), `${ROOT}/ws-1/tmp/`);
  assert.equal(commonProfilePrefix([`${ROOT}/ws-1/tmp/a`, `${ROOT}/ws-1/rig/b`], fb), fb);
  assert.equal(commonProfilePrefix([`${ROOT}/ws-1/tmp/a`], fb), `${ROOT}/ws-1/tmp/a/`);
  assert.equal(commonProfilePrefix([], fb), fb);
});
