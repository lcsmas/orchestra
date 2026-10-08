// #325 — the member-scope adapter of the Reliquat kill (FI-1 v1.3: the trap meets the scope ONLY through memberScopes / listScopeProcs). A FAKE cgroup tree + a FAKE /proc in a scratch dir
// (real files, real fs errors): a scope that vanished is `gone`, one that cannot be read is `unreadable` (never "empty"), the keeper is re-resolved at every listing, another workspace's scope
// is never ours. Each arm names the clause it protects (in-place mutants: scripts/pause-trap/mutants-reliquats.mjs).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { memberScopeDeps } from './pause-reliquats-scope.ts';
import { realScopeEnv, type ScopeEnv } from './memory-scope.ts';

const UID = 4242;
const PREFIX = 'orchestra-rig-wh-h3-';

interface Tree {
  root: string;
  env: ScopeEnv;
  slice: string;
  scope(ws: string, gen: string): { unit: string; dir: string };
  proc(pid: number, ppid: number, comm: string, start: number, cgroupDir: string | null): void;
  members(dir: string, pids: number[]): void;
  keeperPidFile(ws: string, pid: number | null): void;
}

function tree(t: { after: (f: () => void) => void }): Tree {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-scope-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cg = path.join(root, 'cg');
  const slice = path.join(cg, 'user.slice', `user-${UID}.slice`, `user@${UID}.service`, 'app.slice');
  fs.mkdirSync(slice, { recursive: true });
  fs.mkdirSync(path.join(root, 'proc'), { recursive: true });
  fs.mkdirSync(path.join(root, 'home', 'keepers'), { recursive: true });
  const real = realScopeEnv();
  const env: ScopeEnv = { ...real, platform: 'linux', uid: UID, cgroupRoot: cg, procRoot: path.join(root, 'proc'), env: { ORCHESTRA_MEMORY_SCOPE_PREFIX: PREFIX }, keeperPidFile: (ws) => path.join(root, 'home', 'keepers', `${ws}.pid`) };
  return {
    root, env, slice,
    scope: (ws, gen) => {
      const unit = `${PREFIX}${ws}-${gen}.scope`;
      const dir = path.join(slice, unit);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'cgroup.procs'), '');
      return { unit, dir };
    },
    proc: (pid, ppid, comm, start, cgroupDir) => {
      const d = path.join(root, 'proc', String(pid));
      fs.mkdirSync(d, { recursive: true });
      fs.writeFileSync(path.join(d, 'stat'), `${pid} (${comm}) S ${ppid} ${pid} ${pid} 0 -1 4194560 100 0 0 0 1 1 0 0 20 0 1 0 ${start} 1000000 100 18446744073709551615\n`);
      fs.writeFileSync(path.join(d, 'statm'), '1000 250 100 10 0 100 0\n');
      fs.writeFileSync(path.join(d, 'cmdline'), `${comm}\0--arg\0`);
      fs.writeFileSync(path.join(d, 'cgroup'), cgroupDir ? `0::${cgroupDir.slice(cg.length)}\n` : '0::/user.slice\n');
    },
    members: (dir, pids) => fs.writeFileSync(path.join(dir, 'cgroup.procs'), pids.map(String).join('\n') + '\n'),
    keeperPidFile: (ws, pid) => {
      const f = path.join(root, 'home', 'keepers', `${ws}.pid`);
      if (pid === null) fs.rmSync(f, { force: true });
      else fs.writeFileSync(f, JSON.stringify({ pid }));
    },
  };
}

test('no scope directory ⇒ `[]` (NOT TRACKED: the trap keeps today\'s behaviour) — and another workspace\'s scope, even one whose id is a PREFIX of ours, is never ours', (t) => {
  const tr = tree(t);
  assert.deepEqual(memberScopeDeps('m1', tr.env).scopes(), []);
  tr.scope('m1-x', 'abc123'); // "m1" must not match "m1-x"'s scopes
  tr.scope('other', 'abc123');
  assert.deepEqual(memberScopeDeps('m1', tr.env).scopes(), []);
  const mine = tr.scope('m1', 'abc123');
  assert.deepEqual(memberScopeDeps('m1', tr.env).scopes(), [{ unit: mine.unit, cgroupDir: mine.dir }]);
});

test('every GENERATION of the member\'s scope is returned (a restart while Reliquats kept the old one alive)', (t) => {
  const tr = tree(t);
  const a = tr.scope('m1', 'aaaaaa');
  const b = tr.scope('m1', 'bbbbbb');
  assert.deepEqual(memberScopeDeps('m1', tr.env).scopes().map((s) => s.unit), [a.unit, b.unit]);
});

test('the listing carries identity (pid + start-time) and the FI-1 roles: the pid-file keeper (its OWN /proc cgroup = this scope) is `keeper`, its descendants `session`, an orphan `reliquat`', (t) => {
  const tr = tree(t);
  const s = tr.scope('m1', 'abc123');
  tr.proc(90, 1, 'node', 5000, s.dir); // keeper
  tr.proc(100, 90, 'claude', 5001, s.dir); // cli
  tr.proc(101, 100, 'node', 5002, s.dir); // mcp server
  tr.proc(500, 1, 'chrome', 5003, s.dir); // the Reliquat: reparented to init
  tr.members(s.dir, [90, 100, 101, 500]);
  tr.keeperPidFile('m1', 90);
  const d = memberScopeDeps('m1', tr.env);
  const l = d.list(d.scopes()[0]);
  assert.ok(Array.isArray(l));
  const byPid = Object.fromEntries((l as Array<{ pid: number; role: string; startTicks: number }>).map((m) => [m.pid, [m.role, m.startTicks]]));
  assert.deepEqual(byPid, { 90: ['keeper', 5000], 100: ['session', 5001], 101: ['session', 5002], 500: ['reliquat', 5003] });
});

test('a keeper pid file naming a process that is NOT in this scope (another cgroup) is no keeper: every member reads `reliquat` — and the killer\'s second layer is what still protects the live session', (t) => {
  const tr = tree(t);
  const s = tr.scope('m1', 'abc123');
  tr.proc(90, 1, 'node', 5000, null); // the pid file's keeper lives in ANOTHER cgroup
  tr.proc(500, 1, 'chrome', 5003, s.dir);
  tr.members(s.dir, [500]);
  tr.keeperPidFile('m1', 90);
  const d = memberScopeDeps('m1', tr.env);
  assert.equal((d.list(d.scopes()[0]) as Array<{ role: string }>)[0].role, 'reliquat');
});

test('UNKNOWN is not NONE: a scope that vanished is `gone`; a cgroup.procs that cannot be READ is `unreadable` — never an empty listing', (t) => {
  const tr = tree(t);
  const s = tr.scope('m1', 'abc123');
  const d = memberScopeDeps('m1', tr.env);
  const ref = d.scopes()[0];
  assert.deepEqual(d.list(ref), [], 'an existing, readable, empty scope is empty');
  fs.chmodSync(path.join(s.dir, 'cgroup.procs'), 0o000);
  if (process.getuid?.() === 0) return; // root reads anything: the arm needs an unprivileged user
  assert.equal(d.list(ref), 'unreadable');
  fs.chmodSync(path.join(s.dir, 'cgroup.procs'), 0o644);
  fs.rmSync(s.dir, { recursive: true, force: true });
  assert.equal(d.list(ref), 'gone');
});

test('the keeper is RE-RESOLVED at every listing: the pid file now names another keeper ⇒ the roles follow it (a stale keeper pid never makes the live session a Reliquat, nor a Reliquat the session)', (t) => {
  const tr = tree(t);
  const s = tr.scope('m1', 'abc123');
  tr.proc(90, 1, 'node', 5000, s.dir);
  tr.proc(95, 1, 'node', 5010, s.dir);
  tr.proc(96, 95, 'claude', 5011, s.dir);
  tr.members(s.dir, [90, 95, 96]);
  tr.keeperPidFile('m1', 90);
  const d = memberScopeDeps('m1', tr.env);
  const ref = d.scopes()[0];
  const roles = (): Record<number, string> => Object.fromEntries((d.list(ref) as Array<{ pid: number; role: string }>).map((m) => [m.pid, m.role]));
  assert.deepEqual(roles(), { 90: 'keeper', 95: 'reliquat', 96: 'reliquat' });
  tr.keeperPidFile('m1', 95); // the keeper was replaced
  assert.deepEqual(roles(), { 90: 'reliquat', 95: 'keeper', 96: 'session' });
});
