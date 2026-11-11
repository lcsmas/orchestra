// #427 — the Relance census over a FAKE cgroup tree (scratch dir) and REAL processes: detached orphans listed in a scope's cgroup.procs are the member's Reliquats, with their parent links;
// what is outside the scope, another workspace's scope, a dead pid and an unreadable scope are each handled the way a false « end » would otherwise appear. Each arm names its clause.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { censusReliquatsOf } from './relance-census.ts';
import { realKillDeps } from './pause-kill.ts';
import { realScopeEnv, type ScopeEnv } from './memory-scope.ts';
import { RELANCE_MIN_AGE_MS, observeReliquats, rootsOf } from '../shared/relance.ts';
import { makeVeilleReliquatPort } from './veille-reliquats-port.ts';
import { __resetHostStoppedForTests, wasStoppedByHost } from './relance-stopped.ts';

const UID = 4244;
const PREFIX = 'orchestra-rig-rel-';
const real = realKillDeps();
const spawned: number[] = [];
const q = (a: string): string => `'${a.replace(/'/g, `'\\''`)}'`;
/** A REAL orphan like the incident's: started by a shell that exits at once, new session, reparented away from this test. */
function orphan(argv: string[]): number {
  const pid = Number(execFileSync('sh', ['-c', `setsid ${argv.map(q).join(' ')} </dev/null >/dev/null 2>&1 & echo $!`], { encoding: 'utf8' }).trim());
  spawned.push(pid);
  return pid;
}
const settle = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
/** The orphan's argv is what the census reads: wait for the exec (the shell's `$!` is the pid BEFORE `setsid` exec'd node — under load the first read can still say `sh`). */
async function execed(pid: number, needle: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    try { if (fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes(needle)) return; } catch { /* not yet */ }
    await settle(25);
  }
  assert.fail(`pid ${pid} never showed ${needle} in its cmdline`);
}

const isAlive = (pid: number): boolean => {
  const f = real.read(pid);
  return f !== 'gone' && f !== 'unreadable' && f.state !== 'Z';
};
test.after(() => {
  for (const pid of spawned) try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
});

function tree(t: { after: (f: () => void) => void }): { env: ScopeEnv; scope(ws: string, gen: string, pids: number[]): string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rel-census-'));
  const cg = path.join(root, 'cg');
  const slice = path.join(cg, 'user.slice', `user-${UID}.slice`, `user@${UID}.service`, 'app.slice');
  fs.mkdirSync(slice, { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env: ScopeEnv = { ...realScopeEnv(), platform: 'linux', uid: UID, cgroupRoot: cg, procRoot: '/proc', env: { ORCHESTRA_MEMORY_SCOPE_PREFIX: PREFIX }, keeperPidFile: (ws) => path.join(root, `${ws}.pid`) };
  return {
    env,
    scope: (ws, gen, pids) => {
      const dir = path.join(slice, `${PREFIX}${ws}-${gen}.scope`);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'cgroup.procs'), pids.map(String).join('\n') + '\n');
      return dir;
    },
  };
}

test('positive control: the REAL detached orphans of the member\'s scope are its census, with command lines; a bystander outside the scope is not', async (t) => {
  const tr = tree(t);
  const a = orphan(['sleep', '700']);
  const b = orphan(['sleep', '701']);
  const bystander = orphan(['sleep', '702']);
  await execed(a, 'sleep');
  await execed(b, 'sleep');
  tr.scope('m1', 'aaaaaa', [a, b]);
  const c = censusReliquatsOf('m1', tr.env);
  assert.notEqual(c, 'unknown');
  const procs = c as Exclude<typeof c, 'unknown'>;
  assert.deepEqual(procs.map((p) => p.pid).sort((x, y) => x - y), [a, b].sort((x, y) => x - y));
  assert.ok(procs.every((p) => /^sleep 70[01]$/.test(p.cmd)), `command lines read from /proc: ${procs.map((p) => p.cmd)}`);
  assert.ok(!procs.some((p) => p.pid === bystander));
});

test('another workspace\'s scope is never this member\'s (a PREFIX id included)', async (t) => {
  const tr = tree(t);
  const mine = orphan(['sleep', '710']);
  const theirs = orphan(['sleep', '711']);
  tr.scope('m1', 'aaaaaa', [mine]);
  tr.scope('m1-x', 'bbbbbb', [theirs]);
  const c = censusReliquatsOf('m1', tr.env) as Array<{ pid: number }>;
  assert.deepEqual(c.map((p) => p.pid), [mine]);
});

test('no tracked scope ⇒ an EMPTY census (nothing to follow), not unknown', (t) => {
  const tr = tree(t);
  assert.deepEqual(censusReliquatsOf('nobody', tr.env), []);
});

test('an unreadable app.slice is UNKNOWN, never « no Reliquat » — so its vanishing can not read as an end', (t) => {
  const tr = tree(t);
  const broken: ScopeEnv = { ...tr.env, readdir: () => { throw Object.assign(new Error('EMFILE'), { code: 'EMFILE' }); } };
  assert.equal(censusReliquatsOf('m1', broken), 'unknown');
});

test('end to end with the pure half: a REAL script ending is an end; its still-running sibling is listed; the same step with the process alive is not', async (t) => {
  const tr = tree(t);
  const script = orphan(['sleep', '720']);
  const server = orphan(['sleep', '721']);
  const dir = tr.scope('m1', 'aaaaaa', [script, server]);
  let track = observeReliquats(undefined, censusReliquatsOf('m1', tr.env), 1000, () => false);
  track = observeReliquats(track, censusReliquatsOf('m1', tr.env), 2000, () => false);
  assert.equal(track.pending.length, 0, 'control: both alive ⇒ no end');
  process.kill(script, 'SIGKILL');
  for (let i = 0; i < 80 && isAlive(script); i++) await settle(25);
  // the kernel drops the dead pid from cgroup.procs; the fake tree does it by hand
  fs.writeFileSync(path.join(dir, 'cgroup.procs'), `${server}\n`);
  track = observeReliquats(track, censusReliquatsOf('m1', tr.env), 1000 + RELANCE_MIN_AGE_MS, () => false);
  assert.deepEqual(track.pending.map((e) => e.proc.pid), [script]);
  assert.deepEqual([...track.roots.values()].map((p) => p.pid), [server]);
  assert.deepEqual(rootsOf([...track.roots.values()]).map((p) => p.pid), [server]);
});

test('a pid listed in the scope but already dead is not a Reliquat (never an end that was never seen alive)', async (t) => {
  const tr = tree(t);
  const p = orphan(['sleep', '730']);
  process.kill(p, 'SIGKILL');
  for (let i = 0; i < 80 && isAlive(p); i++) await settle(25);
  tr.scope('m1', 'aaaaaa', [p]);
  assert.deepEqual(censusReliquatsOf('m1', tr.env), []);
});

test('the HOST stopping a Reliquat (the Veille\'s stop, through killReliquats) is registered before the signal: its end is not an event; the same death WITHOUT the stop is', async (t) => {
  __resetHostStoppedForTests();
  const tr = tree(t);
  const stopped = orphan(['sleep', '740']);
  const natural = orphan(['sleep', '741']);
  const dir = tr.scope('m1', 'aaaaaa', [stopped, natural]);
  let track = observeReliquats(undefined, censusReliquatsOf('m1', tr.env), 1000, wasStoppedByHost);
  // the Veille's Reliquat port stops exactly the member's Reliquats… but only `stopped` is in its listing at that instant
  fs.writeFileSync(path.join(dir, 'cgroup.procs'), `${stopped}\n`);
  const port = makeVeilleReliquatPort({ scopeEnv: tr.env, cliOf: async () => null, countBrowsers: async () => 0, stopBrowsers: async () => null, tell: async () => true });
  const rep = await port.stop('m1');
  assert.deepEqual(rep?.killed.map((k) => k.pid), [stopped]);
  for (let i = 0; i < 80 && isAlive(stopped); i++) await settle(25);
  fs.writeFileSync(path.join(dir, 'cgroup.procs'), '\n');
  track = observeReliquats(track, censusReliquatsOf('m1', tr.env), 1000 + RELANCE_MIN_AGE_MS, wasStoppedByHost);
  // `natural` also left the listing (by hand): it is the only end that counts
  assert.deepEqual(track.pending.map((e) => e.proc.pid), [natural]);
});

test('a scope whose cgroup.procs cannot be READ is UNKNOWN (never « no Reliquat »): the listing failure must not make every process look ended', (t) => {
  const tr = tree(t);
  const dir = tr.scope('m1', 'aaaaaa', []);
  fs.chmodSync(path.join(dir, 'cgroup.procs'), 0o000);
  t.after(() => { try { fs.chmodSync(path.join(dir, 'cgroup.procs'), 0o644); } catch { /* the tree is already removed */ } });
  if (process.getuid?.() === 0) return t.skip('root reads a mode-000 file');
  assert.equal(censusReliquatsOf('m1', tr.env), 'unknown');
});

test('a listed process the verdict REFUSES (here: the host process itself, a protected pid) makes the census UNKNOWN — its vanishing must not read as an end', (t) => {
  const tr = tree(t);
  tr.scope('m1', 'aaaaaa', [process.pid]);
  assert.equal(censusReliquatsOf('m1', tr.env), 'unknown');
});

test('the member\'s OWN keeper listed as a Reliquat (its pid file is not published yet: its CLI and MCP servers read `reliquat` too) makes the census UNKNOWN; another workspace\'s keeper does not', async (t) => {
  const tr = tree(t);
  const own = orphan(['node', '-e', 'setTimeout(() => {}, 600000)', '/x/keeper.js', 'm1', '/x/sock']);
  await execed(own, 'keeper.js');
  tr.scope('m1', 'aaaaaa', [own]);
  assert.equal(censusReliquatsOf('m1', tr.env), 'unknown');
  const tr2 = tree(t);
  const other = orphan(['node', '-e', 'setTimeout(() => {}, 600000)', '/x/keeper.js', 'someone-else', '/x/sock']);
  await execed(other, 'keeper.js');
  tr2.scope('m1', 'aaaaaa', [other]);
  assert.notEqual(censusReliquatsOf('m1', tr2.env), 'unknown', 'a nested rig app\'s keeper (a supervisor) is spared, not an unknown');
});
