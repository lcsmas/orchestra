// FI-1 (ledger #329): resolving and reading a member's scope, against a FAKE cgroup tree + /proc in a temp dir (the real scope is scripts/e2e-memory-cap.mjs).

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appSliceDir, countMemberScopes, listScopeProcs, memberScopes, readScopeMemory, scopePrefix, scopeSupport, userManagerDir, type ScopeEnv } from './memory-scope.ts';

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
  assert.equal(countMemberScopes(e), 3, 'every scope of the rig prefix, any workspace (the production-prefixed one is not ours)');
  assert.deepEqual(memberScopes(WS, env({ env: { PATH: '' } })).map((s) => s.gen), ['dddddd'], 'the production prefix sees only its own');
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
  const procs = listScopeProcs({ cgroupDir: dir, keeperPid: 500 }, 501, env());
  assert.deepEqual(Object.fromEntries(procs.map((p) => [p.pid, p.role])), { 500: 'keeper', 501: 'cli', 502: 'session', 600: 'reliquat', 601: 'reliquat' });
  assert.equal(procs.find((p) => p.pid === 600)?.rssBytes, 300 * 16384);
  assert.equal(procs.find((p) => p.pid === 600)?.cmdline, 'chromium --headless');
  assert.ok(listScopeProcs({ cgroupDir: dir, keeperPid: null }, null, env()).every((p) => p.role === 'reliquat'), 'keeper dead ⇒ everything left is a Reliquat');
  assert.deepEqual(listScopeProcs({ cgroupDir: path.join(APP, 'gone.scope'), keeperPid: null }, null, env()), []);
});
