// FI-1 (ledger #329): resolving and reading a member's scope, against a FAKE cgroup tree + /proc in a temp dir (the real scope is scripts/e2e-memory-cap.mjs).

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appSliceDir, countMemberScopes, listKeeperTreeOutsideScope, listScopeProcs, memberScopes, readScopeMemory, scopePrefix, scopeSupport, userManagerDir, type ScopeEnv } from './memory-scope.ts';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mscope-'));
const cg = path.join(root, 'cgroup');
const procRoot = path.join(root, 'proc');
const keepers = path.join(root, 'keepers');
fs.mkdirSync(keepers, { recursive: true });
const UM = path.join(cg, 'user.slice', 'user-1000.slice', 'user@1000.service');
const APP = path.join(UM, 'app.slice');
const WS = '198c38e4-5529-4d47-b9cd-738dfb4eb971';

const env = (over: Partial<ScopeEnv> = {}): ScopeEnv => ({
  platform: 'linux', uid: 1000, cgroupRoot: cg, procRoot, pageSize: 16384,
  env: { PATH: '/fakebin', XDG_RUNTIME_DIR: path.join(root, 'run'), ...(over.env ?? {}) },
  readFile: (p) => fs.readFileSync(p, 'utf8'), readdir: (p) => fs.readdirSync(p), exists: (p) => fs.existsSync(p),
  keeperPidFile: (ws) => path.join(keepers, `${ws}.pid`),
  ...over,
});

function mkScope(unit: string, files: Record<string, string> = {}): string {
  const d = path.join(APP, unit);
  fs.mkdirSync(d, { recursive: true });
  const defaults: Record<string, string> = { 'memory.current': '1000000\n', 'memory.max': '268435456\n', 'memory.high': 'max\n', 'memory.swap.max': '0\n', 'memory.swap.current': '0\n', 'memory.peak': '2000000\n', 'memory.events': 'low 0\nhigh 0\nmax 3\noom 1\noom_kill 1\noom_group_kill 0\n', 'cgroup.procs': '' };
  for (const [f, v] of Object.entries({ ...defaults, ...files })) fs.writeFileSync(path.join(d, f), v);
  return d;
}
function mkProc(pid: number, ppid: number, comm: string, cgroupPath: string, rssPages = 100, cmdline = comm): void {
  const d = path.join(procRoot, String(pid));
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'stat'), `${pid} (${comm}) S ${ppid} 1 1 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 ${pid * 10} 1000000 ${rssPages}\n`);
  fs.writeFileSync(path.join(d, 'statm'), `1000 ${rssPages} 10 1 0 1 0\n`);
  fs.writeFileSync(path.join(d, 'cmdline'), cmdline.split(' ').join('\0') + '\0');
  fs.writeFileSync(path.join(d, 'cgroup'), `0::${cgroupPath}\n`);
}
const cgPathOf = (dir: string) => dir.slice(cg.length);

test.after(() => fs.rmSync(root, { recursive: true, force: true }));

test('scopeSupport: Linux + systemd-run + a user-manager socket + the memory controller delegated — each missing piece says why', () => {
  fs.mkdirSync(path.join(root, 'fakebin'), { recursive: true });
  fs.mkdirSync(path.join(root, 'run'), { recursive: true });
  fs.mkdirSync(UM, { recursive: true });
  fs.writeFileSync(path.join(UM, 'cgroup.controllers'), 'cpu memory pids\n');
  const ok = env({ env: { PATH: path.join(root, 'fakebin'), XDG_RUNTIME_DIR: path.join(root, 'run') } });
  assert.deepEqual(scopeSupport(ok), { ok: false, reason: 'systemd-run not found on PATH' });
  fs.writeFileSync(path.join(root, 'fakebin', 'systemd-run'), '#!/bin/sh\n', { mode: 0o755 });
  assert.match((scopeSupport(ok) as { reason: string }).reason, /no user manager socket/);
  fs.writeFileSync(path.join(root, 'run', 'bus'), '');
  assert.deepEqual(scopeSupport(ok), { ok: true });
  assert.match((scopeSupport({ ...ok, platform: 'darwin' }) as { reason: string }).reason, /not linux/);
  assert.match((scopeSupport({ ...ok, uid: null }) as { reason: string }).reason, /user@<uid>/);
  assert.match((scopeSupport({ ...ok, env: { PATH: ok.env.PATH } }) as { reason: string }).reason, /XDG_RUNTIME_DIR unset/);
  fs.writeFileSync(path.join(UM, 'cgroup.controllers'), 'cpu pids\n');
  assert.match((scopeSupport(ok) as { reason: string }).reason, /memory controller is not delegated/);
  fs.writeFileSync(path.join(UM, 'cgroup.controllers'), 'cpu memory pids\n');
});

test('layout: the user manager dir and its app.slice are derived from the uid, not from the app\'s own cgroup', () => {
  assert.equal(userManagerDir(env()), UM);
  assert.equal(appSliceDir(env()), APP);
  assert.equal(appSliceDir(env({ uid: null })), null);
});

test('memberScopes: ONLY this workspace\'s scopes, with the rig prefix honoured; several generations coexist, oldest first', () => {
  const e = env({ env: { PATH: '', ORCHESTRA_MEMORY_SCOPE_PREFIX: 'orchestra-rig-wh-h1-' } });
  mkScope(`orchestra-rig-wh-h1-${WS}-aaaaaa.scope`);
  mkScope(`orchestra-rig-wh-h1-${WS}-bbbbbb.scope`);
  mkScope(`orchestra-rig-wh-h1-${WS}x-cccccc.scope`); // another workspace whose id starts with ours
  mkScope(`orchestra-ws-${WS}-dddddd.scope`); // the production prefix: invisible to a rig
  mkScope('app-orchestra-123.scope'); // not ours at all
  const found = memberScopes(WS, e);
  assert.deepEqual(found.map((s) => s.gen), ['aaaaaa', 'bbbbbb']);
  assert.ok(found.every((s) => s.cgroupDir.startsWith(APP) && s.keeperPid === null));
  assert.equal(scopePrefix(e), 'orchestra-rig-wh-h1-');
  assert.deepEqual(memberScopes('nobody', e), []);
  assert.deepEqual(countMemberScopes(e), { total: 3, unlimited: 0 }, 'every scope of the rig prefix, any workspace (the production-prefixed one is not ours); all three have memory.max set');
  assert.deepEqual(memberScopes(WS, env({ env: { PATH: '' } })).map((s) => s.gen), ['dddddd'], 'the production prefix sees only its own');
});

test('FI-1 (c): the CLI is guessed ONLY when the keeper has exactly one direct child — two children (or none) stay `session`/unknown, never a guess', () => {
  const ws = 'ws-twokids';
  const dir = mkScope(`orchestra-ws-${ws}-iiiiii.scope`, { 'cgroup.procs': '800\n801\n802\n' });
  const c = cgPathOf(dir);
  mkProc(800, 1, 'node', c, 10, 'node keeper.js');
  mkProc(801, 800, 'claude', c, 20, 'claude --x');
  mkProc(802, 800, 'bash', c, 5, 'bash');
  const two = listScopeProcs({ cgroupDir: dir, keeperPid: 800 }, null, env());
  assert.deepEqual(Object.fromEntries(two.map((p) => [p.pid, p.role])), { 800: 'keeper', 801: 'session', 802: 'session' }, 'two direct children: nobody is called the CLI');
  fs.writeFileSync(path.join(dir, 'cgroup.procs'), '800\n801\n');
  assert.equal(listScopeProcs({ cgroupDir: dir, keeperPid: 800 }, null, env()).find((p) => p.pid === 801)?.role, 'cli', 'one direct child: it is the CLI');
  fs.writeFileSync(path.join(dir, 'cgroup.procs'), '800\n');
  assert.deepEqual(listScopeProcs({ cgroupDir: dir, keeperPid: 800 }, null, env()).map((p) => p.role), ['keeper'], 'no child: no CLI');
});

test('countMemberScopes: a scope that is NOT a cap — no memory.max, OR the swap escape open — is counted as unlimited', () => {
  const e = env({ env: { PATH: '', ORCHESTRA_MEMORY_SCOPE_PREFIX: 'orchestra-rig-wh-cnt-' } });
  fs.mkdirSync(procRoot, { recursive: true });
  fs.writeFileSync(path.join(procRoot, 'meminfo'), 'MemTotal: 1000 kB\nSwapTotal: 8000000 kB\n');
  mkScope('orchestra-rig-wh-cnt-wsa-aaaaaa.scope');
  assert.deepEqual(countMemberScopes(e), { total: 1, unlimited: 0 }, 'max set + swap 0 = a cap');
  mkScope('orchestra-rig-wh-cnt-wsb-bbbbbb.scope', { 'memory.max': 'max\n' });
  assert.deepEqual(countMemberScopes(e), { total: 2, unlimited: 1 }, 'no memory.max');
  mkScope('orchestra-rig-wh-cnt-wsc-cccccc.scope', { 'memory.swap.max': 'max\n' });
  assert.deepEqual(countMemberScopes(e), { total: 3, unlimited: 2 }, 'swap escape open (host HAS swap) — the keeper says not-applied, so does bus-status');
  fs.writeFileSync(path.join(procRoot, 'meminfo'), 'MemTotal: 1000 kB\nSwapTotal: 0 kB\n');
  assert.deepEqual(countMemberScopes(e), { total: 3, unlimited: 2 }, 'we always ASK for swap 0: a file reading max is not what was asked, whatever the host');
  fs.rmSync(path.join(APP, 'orchestra-rig-wh-cnt-wsc-cccccc.scope', 'memory.swap.max'));
  assert.deepEqual(countMemberScopes(e), { total: 3, unlimited: 1 }, 'no swap accounting AND no swap on the host: nothing to escape into, still a cap');
});

test('countMemberScopes (pre-review m3): a scope listed but GONE is not counted; a scope that EXISTS without the memory controller IS a leak, whatever the host swap', () => {
  const e = env({ env: { PATH: '', ORCHESTRA_MEMORY_SCOPE_PREFIX: 'orchestra-rig-wh-cnt2-' } });
  fs.mkdirSync(procRoot, { recursive: true });
  fs.writeFileSync(path.join(procRoot, 'meminfo'), 'MemTotal: 1000 kB\nSwapTotal: 8000000 kB\n');
  const real = APP;
  mkScope('orchestra-rig-wh-cnt2-wsa-aaaaaa.scope');
  const ghost = env({ env: e.env, readdir: (p) => (p === real ? [...fs.readdirSync(p), 'orchestra-rig-wh-cnt2-wsg-gggggg.scope'] : fs.readdirSync(p)) });
  assert.deepEqual(countMemberScopes(ghost), { total: 1, unlimited: 0 }, 'the ghost (listed, not on disk) is neither a scope nor an unlimited one — base 2eb13727 said {2, 0}, the first -fu said {2, 1}');
  const nc = path.join(APP, 'orchestra-rig-wh-cnt2-wsn-nnnnnn.scope');
  fs.mkdirSync(nc, { recursive: true }); // exists, no memory.* files at all
  fs.writeFileSync(path.join(procRoot, 'meminfo'), 'MemTotal: 1000 kB\nSwapTotal: 0 kB\n');
  assert.deepEqual(countMemberScopes(ghost), { total: 2, unlimited: 1 }, 'a scope without the memory controller is not a cap even on a swapless host');
});

test('memberScopes: no app.slice / unsupported platform ⇒ [] ("not tracked"), never a throw', () => {
  assert.deepEqual(memberScopes(WS, env({ cgroupRoot: path.join(root, 'nope') })), []);
  assert.deepEqual(memberScopes(WS, env({ uid: null })), []);
});

test('keeperPid is the pid-file keeper ONLY when /proc says it is a member of THIS scope (identity re-read; a recycled pid is UNKNOWN, not the keeper)', () => {
  const ws = 'ws-keeperid';
  const unit = `orchestra-ws-${ws}-eeeeee.scope`;
  const dir = mkScope(unit);
  const e = env();
  fs.writeFileSync(path.join(keepers, `${ws}.pid`), JSON.stringify({ pid: 4242, wsId: ws }));
  assert.equal(memberScopes(ws, e)[0].keeperPid, null, 'no /proc entry ⇒ unknown');
  mkProc(4242, 1, 'node', '/user.slice/other.scope');
  assert.equal(memberScopes(ws, e)[0].keeperPid, null, 'the pid lives in ANOTHER cgroup (a recycled pid)');
  mkProc(4242, 1, 'node', cgPathOf(dir));
  assert.equal(memberScopes(ws, e)[0].keeperPid, 4242);
  fs.writeFileSync(path.join(keepers, `${ws}.pid`), 'not json');
  assert.equal(memberScopes(ws, e)[0].keeperPid, null, 'an unreadable pid file is unknown, not a crash');
});

test('keeperPid before the keeper wrote its pid file (it listens first): the scope member whose argv is `keeper.js <wsId>` is the keeper — its CLI is not misread as a Reliquat', () => {
  const ws = 'ws-nopidfile';
  const unit = `orchestra-ws-${ws}-hhhhhh.scope`;
  const dir = mkScope(unit, { 'cgroup.procs': '700\n701\n' });
  const c = cgPathOf(dir);
  mkProc(700, 1, 'node', c, 10, `node /h/bin/keeper.js ${ws} /h/k.sock ${path.join(keepers, `${ws}.pid`)} /h/k.log`);
  mkProc(701, 700, 'claude', c, 20, 'claude --x');
  assert.ok(!fs.existsSync(path.join(keepers, `${ws}.pid`)), 'precondition: no pid file yet');
  const scope = memberScopes(ws, env())[0];
  assert.equal(scope.keeperPid, 700);
  const roles = Object.fromEntries(listScopeProcs(scope, 701, env()).map((p) => [p.pid, p.role]));
  assert.deepEqual(roles, { 700: 'keeper', 701: 'cli' });
  // a keeper of ANOTHER workspace, or of another HOME (pid-file argument differs), is not this one
  mkProc(702, 701, 'node', c, 5, `node /h/bin/keeper.js some-other-ws /x ${path.join(keepers, 'some-other-ws.pid')} /l`);
  mkProc(703, 701, 'node', c, 5, `node /other-home/bin/keeper.js ${ws} /o/k.sock /other-home/keepers/${ws}.pid /o/k.log`); // a DEV-home keeper of the same ws id
  fs.writeFileSync(path.join(dir, 'cgroup.procs'), '702\n703\n701\n');
  assert.equal(memberScopes(ws, env())[0].keeperPid, null, 'no member is this workspace\'s keeper ⇒ unknown stays unknown');
});

test('readScopeMemory: sysfs numbers, limits as numbers or null, the kill counter; a vanished scope is null', () => {
  const dir = mkScope('orchestra-ws-wsmem-ffffff.scope');
  const m = readScopeMemory({ cgroupDir: dir }, env());
  assert.deepEqual(m, { currentBytes: 1000000, peakBytes: 2000000, maxBytes: 268435456, highBytes: null, swapMaxBytes: 0, swapCurrentBytes: 0, events: { high: 0, max: 3, oom: 1, oomKill: 1, oomGroupKill: 0 } });
  assert.equal(readScopeMemory({ cgroupDir: path.join(APP, 'gone.scope') }, env()), null);
  fs.writeFileSync(path.join(dir, 'memory.max'), 'max\n');
  assert.equal(readScopeMemory({ cgroupDir: dir }, env())?.maxBytes, null, 'no limit reads as null — "tracked, uncapped"');
});

test('listScopeProcs: keeper / cli / session by ancestry, Reliquats by orphaning; rss in pages × the kernel page size; a vanished pid is skipped', () => {
  const ws = 'ws-procs';
  const unit = `orchestra-ws-${ws}-gggggg.scope`;
  const dir = mkScope(unit, { 'cgroup.procs': '500\n501\n502\n600\n601\n999\n' });
  const c = cgPathOf(dir);
  mkProc(500, 1, 'node', c, 10, 'node keeper.js');
  mkProc(501, 500, 'claude', c, 20, 'claude --x');
  mkProc(502, 501, 'bash', c, 5, 'bash -c sleep');
  mkProc(600, 1, 'chromium', c, 300, 'chromium --headless'); // orphaned: a Reliquat
  mkProc(601, 600, 'chromium', c, 200, 'chromium --type=gpu');
  // 999 listed in cgroup.procs but already gone from /proc
  // FI-1 (c): without the caller naming it, the CLI is the keeper's ONLY direct child (here 501; 600 is orphaned to init)
  assert.equal(listScopeProcs({ cgroupDir: dir, keeperPid: 500 }, null, env()).find((p) => p.pid === 501)?.role, 'cli');
  const procs = listScopeProcs({ cgroupDir: dir, keeperPid: 500 }, 501, env());
  assert.deepEqual(Object.fromEntries(procs.map((p) => [p.pid, p.role])), { 500: 'keeper', 501: 'cli', 502: 'session', 600: 'reliquat', 601: 'reliquat' });
  assert.equal(procs.find((p) => p.pid === 600)?.rssBytes, 300 * 16384);
  assert.equal(procs.find((p) => p.pid === 600)?.cmdline, 'chromium --headless');
  assert.ok(listScopeProcs({ cgroupDir: dir, keeperPid: null }, null, env()).every((p) => p.role === 'reliquat'), 'keeper dead ⇒ everything left is a Reliquat');
  assert.deepEqual(listScopeProcs({ cgroupDir: path.join(APP, 'gone.scope'), keeperPid: null }, null, env()), []);
});

test('FI-1 v1.9 — a browser main process that moved into its OWN scope: its helpers (still in the member scope) stay the session\'s, and the main process is listed OUTSIDE the scope with its cgroup and rss', () => {
  const ws = 'ws-chromium';
  const dir = mkScope(`orchestra-ws-${ws}-jjjjjj.scope`, { 'cgroup.procs': '1100\n1101\n1102\n1104\n' }); // 1103, the browser main, is NOT in this scope's cgroup.procs
  const c = cgPathOf(dir);
  const chromiumScope = '/user.slice/user-1000.slice/user@1000.service/app.slice/app-org.chromium.Chromium-1103.scope';
  mkProc(1100, 1, 'node', c, 10, 'node keeper.js');
  mkProc(1101, 1100, 'claude', c, 20, 'claude --x');
  mkProc(1102, 1101, 'bash', c, 5, 'bash -c chromium');
  mkProc(1103, 1102, 'chromium', chromiumScope, 5000, 'chromium --headless=new about:blank');
  mkProc(1104, 1103, 'chromium', c, 3000, 'chromium --type=renderer'); // a helper: in the member scope, parent in the browser's own scope
  mkProc(1200, 1, 'chromium', '/user.slice/user-1000.slice/user@1000.service/app.slice/app-someone-else.scope', 9000, 'chromium (the human\'s own browser)');
  const scope = { cgroupDir: dir, keeperPid: 1100 };
  const roles = Object.fromEntries(listScopeProcs(scope, 1101, env()).map((p) => [p.pid, p.role]));
  assert.deepEqual(roles, { 1100: 'keeper', 1101: 'cli', 1102: 'session', 1104: 'session' }, 'the helper is the session\'s although its parent left the scope');
  const out = listKeeperTreeOutsideScope(scope, env());
  assert.deepEqual(out.map((p) => [p.pid, p.cgroup, p.rssBytes]), [[1103, chromiumScope, 5000 * 16384]], 'only the keeper\'s own escapee — not the human\'s browser, not the in-scope members');
  assert.deepEqual(listKeeperTreeOutsideScope({ cgroupDir: dir, keeperPid: null }, env()), [], 'no known keeper ⇒ nothing is claimed');
});

test('FI-1 v1.9 (pre-review m1/m2): a stale keeper pid claims nothing; a pid recycled between the ppid snapshot and its read is not billed', () => {
  const ws = 'ws-stale';
  const dir = mkScope(`orchestra-ws-${ws}-kkkkkk.scope`, { 'cgroup.procs': '1300\n' });
  const c = cgPathOf(dir);
  const other = '/user.slice/user-1000.slice/user@1000.service/app.slice/session-2.scope';
  mkProc(1300, 1, 'node', c, 10, 'node keeper.js');
  mkProc(1301, 1300, 'chromium', other, 4000, 'chromium --headless'); // really escaped
  // a keeper pid that is NOT in the scope any more (recycled by an unrelated process): its whole tree must not be listed
  mkProc(1400, 1, 'firefox', other, 7000, 'firefox');
  mkProc(1401, 1400, 'firefox', other, 7000, 'firefox --type=content');
  assert.deepEqual(listKeeperTreeOutsideScope({ cgroupDir: dir, keeperPid: 1400 }, env()), [], 'stale/recycled keeper pid ⇒ []');
  assert.deepEqual(listKeeperTreeOutsideScope({ cgroupDir: dir, keeperPid: 99999 }, env()), [], 'gone keeper ⇒ []');
  assert.deepEqual(listKeeperTreeOutsideScope({ cgroupDir: dir, keeperPid: 1300 }, env()).map((p) => p.pid), [1301], 'control: the real keeper still lists its escapee');
  // 1302 is a child of the keeper in the snapshot, but by the time its own files are read the pid belongs to an unrelated process (ppid 1)
  mkProc(1302, 1300, 'stranger', other, 100, 'stranger');
  const stat1302 = path.join(procRoot, '1302', 'stat');
  let reads = 0;
  const flip = env({ readFile: (p) => {
    if (p === stat1302 && ++reads === 2) return `1302 (stranger) S 1 1 1 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 13020 1000000 100\n`;
    return fs.readFileSync(p, 'utf8');
  } });
  const listed = listKeeperTreeOutsideScope({ cgroupDir: dir, keeperPid: 1300 }, flip).map((p) => p.pid);
  assert.equal(reads >= 2, true, 'the probe really intercepted the second read');
  assert.deepEqual(listed, [1301], 'the recycled pid is dropped, the genuine escapee stays');
});

// ─── #332: a scope with its two leaves (`k` keeper, `w` CLI + tools) ─────────────────────────────────────────────────

function mkLeafScope(unit: string, keeperPid: number, cliPid: number, daemonPid: number): { scopeDir: string; kDir: string; wDir: string } {
  const scopeDir = mkScope(unit, { 'memory.max': `${268435456 + 134217728}\n`, 'memory.current': '90000000\n', 'cgroup.procs': '' });
  const kDir = path.join(scopeDir, 'k');
  const wDir = path.join(scopeDir, 'w');
  fs.mkdirSync(kDir);
  fs.mkdirSync(wDir);
  fs.writeFileSync(path.join(kDir, 'cgroup.procs'), `${keeperPid}\n`);
  fs.writeFileSync(path.join(wDir, 'cgroup.procs'), `${cliPid}\n${daemonPid}\n`);
  fs.writeFileSync(path.join(wDir, 'memory.max'), '268435456\n');
  fs.writeFileSync(path.join(wDir, 'memory.swap.max'), '0\n');
  fs.writeFileSync(path.join(wDir, 'memory.high'), 'max\n');
  fs.writeFileSync(path.join(wDir, 'memory.events'), 'low 0\nhigh 0\nmax 12\noom 3\noom_kill 3\noom_group_kill 0\n');
  fs.writeFileSync(path.join(scopeDir, 'memory.events'), 'low 0\nhigh 0\nmax 0\noom 0\noom_kill 0\noom_group_kill 0\n');
  return { scopeDir, kDir, wDir };
}

test('#332 leaves: the scope\'s members are the union of its two leaves (its own cgroup.procs is empty); the keeper is found in k, the CLI and a detached job in w', () => {
  const unit = 'orchestra-ws-leafy-1aaaaa.scope';
  const { scopeDir, kDir, wDir } = mkLeafScope(unit, 7001, 7002, 7003);
  mkProc(7001, 1, 'node-22', cgPathOf(kDir), 100, `node /x/keeper.js leafy /s ${keepers}/leafy.pid /l`);
  mkProc(7002, 7001, 'node-22', cgPathOf(wDir));
  mkProc(7003, 1, 'python3', cgPathOf(wDir));
  const e = env();
  const [scope] = memberScopes('leafy', e);
  assert.equal(scope.unit, unit);
  assert.equal(scope.cgroupDir, scopeDir);
  assert.equal(scope.keeperPid, 7001, 'found by argv in the keeper leaf (no pid file yet)');
  fs.writeFileSync(path.join(keepers, 'leafy.pid'), JSON.stringify({ pid: 7001 }));
  assert.equal(memberScopes('leafy', e)[0].keeperPid, 7001, 'and by the pid file + the pid\'s own cgroup (k maps to its scope)');
  const procs = listScopeProcs(memberScopes('leafy', e)[0], 7002, e);
  assert.deepEqual(procs.map((p) => [p.pid, p.role]).sort(), [[7001, 'keeper'], [7002, 'cli'], [7003, 'reliquat']]);
});

test('#332 leaves: a leaf that EXISTS but cannot be read is an error (no quiet undercount that would hide the keeper); a scope without leaves reads as before', () => {
  const { scopeDir } = mkLeafScope('orchestra-ws-leafy2-1bbbbb.scope', 7011, 7012, 7013);
  mkProc(7011, 1, 'node-22', cgPathOf(path.join(scopeDir, 'k')));
  mkProc(7012, 7011, 'node-22', cgPathOf(path.join(scopeDir, 'w')));
  mkProc(7013, 1, 'python3', cgPathOf(path.join(scopeDir, 'w')));
  const e = env({ readFile: (p) => { if (p === path.join(scopeDir, 'k', 'cgroup.procs')) throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); return fs.readFileSync(p, 'utf8'); } });
  assert.deepEqual(listScopeProcs({ cgroupDir: scopeDir, keeperPid: null }, null, e), [], 'unreadable ⇒ [] as for any unreadable scope (the Reliquat killer reads the file first and calls it UNKNOWN)');
  assert.deepEqual(listScopeProcs({ cgroupDir: scopeDir, keeperPid: null }, null, env()).map((p) => p.pid).sort(), [7011, 7012, 7013], 'control: readable, the same scope lists all three');
  const flat = mkScope('orchestra-ws-flat-1ccccc.scope', { 'cgroup.procs': '7021\n' });
  mkProc(7021, 1, 'python3', cgPathOf(flat));
  assert.deepEqual(listScopeProcs({ cgroupDir: flat, keeperPid: null }, null, env()).map((p) => p.pid), [7021]);
});

test('#332 leaves: readScopeMemory — the cap (max, swap, events) is the WORK leaf\'s, the bill (current) is the scope\'s', () => {
  const { scopeDir } = mkLeafScope('orchestra-ws-leafy3-1ddddd.scope', 7031, 7032, 7033);
  const m = readScopeMemory({ cgroupDir: scopeDir }, env());
  assert.ok(m);
  assert.equal(m!.currentBytes, 90000000);
  assert.equal(m!.maxBytes, 268435456, 'the hard level, not the scope\'s backstop (hard + keeper reserve)');
  assert.equal(m!.swapMaxBytes, 0);
  assert.equal(m!.events.oomKill, 3, 'the kernel kills happen on the work leaf');
  const flat = readScopeMemory({ cgroupDir: mkScope('orchestra-ws-flat2-1eeeee.scope') }, env());
  assert.equal(flat!.maxBytes, 268435456, 'a scope without leaves: its own limit, as before');
});

test('#332 leaves: the keeper in leaf k is resolved by the pid file alone (its own cgroup `<scope>/k` maps to the scope) — no keeper argv to fall back on', () => {
  const { kDir, wDir } = mkLeafScope('orchestra-ws-leafy4-1fffff.scope', 7041, 7042, 7043);
  mkProc(7041, 1, 'node-22', cgPathOf(kDir), 100, 'node something-else');
  mkProc(7042, 7041, 'node-22', cgPathOf(wDir));
  mkProc(7043, 1, 'python3', cgPathOf(wDir));
  assert.equal(memberScopes('leafy4', env())[0].keeperPid, null, 'no pid file yet, and the argv is not a keeper\'s');
  fs.writeFileSync(path.join(keepers, 'leafy4.pid'), JSON.stringify({ pid: 7041 }));
  assert.equal(memberScopes('leafy4', env())[0].keeperPid, 7041);
});
