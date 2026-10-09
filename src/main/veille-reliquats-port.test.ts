// #326 — the Veille's Reliquat port over a FAKE cgroup tree (scratch dir) and REAL processes: detached orphans listed in a scope's cgroup.procs are counted and stopped through the SAME
// pieces the Pause uses (memberScopeDeps / judgeReliquat / killReliquats — identity re-read at signal time); a bystander outside the scope survives; anything the port cannot look at is
// `unknown`, never « none »; a member with no tracked scope falls through to #331's browsers. The real-keeper-in-a-real-scope proof is the verifier's (heavy). Each arm names the clause it protects.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeVeilleReliquatPort as make, type VeilleReliquatPortDeps } from './veille-reliquats-port.ts';
import { realKillDeps } from './pause-kill.ts';
import { realScopeEnv, type ScopeEnv } from './memory-scope.ts';
import type { ProcIdent } from '../shared/pause-procs.ts';

const UID = 4243;
const PREFIX = 'orchestra-rig-wh-v-';
const real = realKillDeps();
const spawned: Array<{ pid: number; startTicks: number }> = [];
const alive = (r: { pid: number; startTicks: number }): boolean => {
  const f = real.read(r.pid);
  return f !== 'gone' && f !== 'unreadable' && f.startTicks === r.startTicks && f.state !== 'Z';
};
const idOf = (pid: number): { pid: number; startTicks: number } => {
  const id = real.read(pid);
  assert.ok(id !== 'gone' && id !== 'unreadable', `process ${pid} exists`);
  const r = { pid, startTicks: (id as ProcIdent).startTicks };
  spawned.push(r);
  return r;
};
const q = (a: string): string => `'${a.replace(/'/g, `'\\''`)}'`;
/** A REAL orphan like the incident's: started by a shell that exits at once, new session, reparented away from this test. */
function orphan(argv: string[]): { pid: number; startTicks: number } {
  return idOf(Number(execFileSync('sh', ['-c', `setsid ${argv.map(q).join(' ')} </dev/null >/dev/null 2>&1 & echo $!`], { encoding: 'utf8' }).trim()));
}
function child(argv: string[]): { pid: number; startTicks: number } {
  const c = spawn(argv[0], argv.slice(1), { detached: true, stdio: 'ignore' });
  c.unref();
  return idOf(c.pid as number);
}
const settle = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
async function gone(r: { pid: number; startTicks: number }): Promise<boolean> {
  for (let i = 0; i < 60; i++) {
    if (!alive(r)) return true;
    await settle(25);
  }
  return false;
}
test.after(() => {
  for (const r of spawned) if (alive(r)) { try { process.kill(r.pid, 'SIGKILL'); } catch { /* gone */ } }
});

interface Tree { env: ScopeEnv; slice: string; scope(ws: string, gen: string, pids: number[]): string }
function tree(t: { after: (f: () => void) => void }): Tree {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vr-host-'));
  const cg = path.join(root, 'cg');
  const slice = path.join(cg, 'user.slice', `user-${UID}.slice`, `user@${UID}.service`, 'app.slice');
  fs.mkdirSync(slice, { recursive: true });
  t.after(() => {
    try { fs.chmodSync(slice, 0o755); } catch { /* gone */ }
    fs.rmSync(root, { recursive: true, force: true });
  });
  const env: ScopeEnv = { ...realScopeEnv(), platform: 'linux', uid: UID, cgroupRoot: cg, procRoot: '/proc', env: { ORCHESTRA_MEMORY_SCOPE_PREFIX: PREFIX }, keeperPidFile: (ws) => path.join(root, `${ws}.pid`) };
  return {
    env, slice,
    scope: (ws, gen, pids) => {
      const dir = path.join(slice, `${PREFIX}${ws}-${gen}.scope`);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'cgroup.procs'), pids.map(String).join('\n') + '\n');
      return dir;
    },
  };
}
const noSession = async (): Promise<null> => null;
const noBrowsers = { countBrowsers: async (): Promise<number | 'unknown'> => 0, stopBrowsers: async (): Promise<null> => null, tell: async (): Promise<boolean> => true };
/** The port over a scratch tree: the app-side pieces are stand-ins unless a test names them. */
const makeVeilleReliquatPort = (o: Partial<VeilleReliquatPortDeps> & Pick<VeilleReliquatPortDeps, 'cliOf'>) => make({ ...noBrowsers, ...o });

test('positive control: census counts the REAL detached orphans of the member\'s scope; stop signals exactly them (identity re-read) and a bystander OUTSIDE the scope survives', async (t) => {
  const tr = tree(t);
  const a = orphan(['sleep', '600']);
  const b = orphan(['sleep', '601']);
  const bystander = orphan(['sleep', '602']);
  tr.scope('m1', 'aaaaaa', [a.pid, b.pid]);
  const port = makeVeilleReliquatPort({ scopeEnv: tr.env, cliOf: noSession });
  assert.equal(await port.census('m1'), 2);
  const rep = await port.stop('m1');
  assert.ok(rep, 'a report');
  assert.deepEqual(rep!.killed.map((k) => k.pid).sort((x, y) => x - y), [a.pid, b.pid].sort((x, y) => x - y));
  assert.equal(await gone(a) && await gone(b), true, 'both really exited');
  assert.equal(alive(bystander), true, 'a process outside the scope is never touched');
});

test('another workspace\'s scope is never ours (a PREFIX id included): its Reliquats are not counted and not stopped', async (t) => {
  const tr = tree(t);
  const mine = orphan(['sleep', '610']);
  const theirs = orphan(['sleep', '611']);
  tr.scope('m1', 'aaaaaa', [mine.pid]);
  tr.scope('m1-x', 'bbbbbb', [theirs.pid]); // "m1" must not match "m1-x"
  tr.scope('other', 'cccccc', []);
  const port = makeVeilleReliquatPort({ scopeEnv: tr.env, cliOf: noSession });
  assert.equal(await port.census('m1'), 1);
  await port.stop('m1');
  assert.equal(await gone(mine), true);
  assert.equal(alive(theirs), true);
});

test('a member with a scope but NO Reliquat ⇒ census 0 (its session is not a Reliquat); the stop reports nothing killed', async (t) => {
  const tr = tree(t);
  tr.scope('m1', 'aaaaaa', []);
  const port = makeVeilleReliquatPort({ scopeEnv: tr.env, cliOf: noSession });
  assert.equal(await port.census('m1'), 0);
  const rep = await port.stop('m1');
  assert.deepEqual(rep?.killed ?? [], []);
});

test('the member\'s own CLI is never counted nor stopped — the protection is BY PID: the same orphan counts (and dies) when the port is not told it is the CLI', async (t) => {
  const tr = tree(t);
  const cli = orphan(['sleep', '620']); // an orphan like a real CLI under a keeper that is gone from the listing: only cliOf says it is the session
  const orph = orphan(['sleep', '621']);
  tr.scope('m1', 'aaaaaa', [cli.pid, orph.pid]);
  const told = makeVeilleReliquatPort({ scopeEnv: tr.env, cliOf: async () => ({ cli: { pid: cli.pid, startTicks: cli.startTicks }, keeperPid: null }) });
  assert.equal(await told.census('m1'), 1, 'the CLI is protected: only the other orphan counts');
  const untold = makeVeilleReliquatPort({ scopeEnv: tr.env, cliOf: noSession });
  assert.equal(await untold.census('m1'), 2, 'CONTROL: without the pid protection the same process is a Reliquat');
  await told.stop('m1');
  assert.equal(await gone(orph), true);
  assert.equal(alive(cli), true, 'the protected CLI survives the stop');
});

test('UNKNOWN is not NONE: an unreadable app.slice, an unreadable cgroup.procs, a failing keeper/CLI resolution — census `unknown`, and the stop reports `unknown` (the Veille waits)', async (t) => {
  const tr = tree(t);
  const dir = tr.scope('m1', 'aaaaaa', []);
  const port = makeVeilleReliquatPort({ scopeEnv: tr.env, cliOf: noSession });
  // cgroup.procs unreadable (a directory in its place ⇒ EISDIR, neither « gone » nor empty)
  fs.rmSync(path.join(dir, 'cgroup.procs'));
  fs.mkdirSync(path.join(dir, 'cgroup.procs'));
  assert.equal(await port.census('m1'), 'unknown');
  const rep = await port.stop('m1');
  assert.match(rep?.unknown ?? '', /unreadable/);
  // keeper / CLI identity could not be proven
  const tr2 = tree(t);
  tr2.scope('m1', 'aaaaaa', []);
  const bad = makeVeilleReliquatPort({ scopeEnv: tr2.env, cliOf: async () => ({ error: 'keeper identity unverifiable' }) });
  assert.equal(await bad.census('m1'), 'unknown');
  assert.equal((await bad.stop('m1'))?.unknown, 'keeper identity unverifiable');
  const boom = makeVeilleReliquatPort({ scopeEnv: tr2.env, cliOf: async () => { throw new Error('probe threw'); } });
  assert.equal(await boom.census('m1'), 'unknown');
  assert.match((await boom.stop('m1'))?.unknown ?? '', /probe threw/);
});

test('the member\'s OWN keeper listed as a Reliquat (its pid file is not published yet: every role of the scope is unreliable) ⇒ `unknown`, nothing counted, nothing stopped', async (t) => {
  const tr = tree(t);
  const fakeKeeper = child(['node', '-e', 'setInterval(() => {}, 1e6)', 'keeper.js', 'm1', '/x.sock', '/x.pid', '/x.log']);
  const orph = orphan(['sleep', '630']);
  tr.scope('m1', 'aaaaaa', [fakeKeeper.pid, orph.pid]);
  const port = makeVeilleReliquatPort({ scopeEnv: tr.env, cliOf: noSession });
  assert.equal(await port.census('m1'), 'unknown');
  const rep = await port.stop('m1');
  assert.match(rep?.unknown ?? '', /own keeper/);
  assert.equal(alive(orph), true, 'not even the genuine Reliquat: the roles cannot be trusted this round');
});

test('NO tracked scope (memory_cap OFF) ⇒ #331\'s browsers answer: the count comes from the browser census, the stop from the browser pass (the idle window ignored); the scope kill reports null', async (t) => {
  const tr = tree(t); // an app.slice with no scope of m1
  const calls: string[] = [];
  const port = makeVeilleReliquatPort({
    scopeEnv: tr.env,
    cliOf: noSession,
    countBrowsers: async (ws) => { calls.push(`count:${ws}`); return 3; },
    stopBrowsers: async (ws) => { calls.push(`stop:${ws}`); return null; },
  });
  assert.equal(await port.census('m1'), 3);
  assert.equal(await port.stop('m1'), null);
  assert.deepEqual(calls, ['count:m1', 'stop:m1']);
  // and a member WITH a scope never consults the browsers
  tr.scope('m2', 'aaaaaa', []);
  const calls2: string[] = [];
  const p2 = makeVeilleReliquatPort({ scopeEnv: tr.env, cliOf: noSession, countBrowsers: async () => { calls2.push('count'); return 9; }, stopBrowsers: async () => { calls2.push('stop'); return null; } });
  assert.equal(await p2.census('m2'), 0);
  await p2.stop('m2');
  assert.deepEqual(calls2, []);
});

test('an unreadable app.slice (EACCES) is `unknown`, not « no scope » (which would fall through to the browsers and read as none)', async (t) => {
  if (process.getuid?.() === 0) return t.skip('root ignores directory modes');
  const tr = tree(t);
  tr.scope('m1', 'aaaaaa', []);
  fs.chmodSync(tr.slice, 0o000);
  const port = makeVeilleReliquatPort({ scopeEnv: tr.env, cliOf: noSession, countBrowsers: async () => 5 });
  assert.equal(await port.census('m1'), 'unknown');
});

test('a scope lookup that FAILS inside stop() is reported `unknown` (never `null` = « nothing to stop »): the Veille then waits for the next sweep (verifier Q09)', async (t) => {
  if (process.getuid?.() === 0) return t.skip('root ignores directory modes');
  const tr = tree(t);
  tr.scope('m1', 'aaaaaa', []);
  fs.chmodSync(tr.slice, 0o000);
  const port = makeVeilleReliquatPort({ scopeEnv: tr.env, cliOf: noSession, countBrowsers: async () => 5, stopBrowsers: async () => { throw new Error('the browser pass must not be asked'); } });
  const rep = await port.stop('m1');
  assert.ok(rep !== null, 'a lookup failure is not « nothing to stop »');
  assert.match(String(rep?.unknown), /^scope lookup failed: /);
  assert.equal(rep?.killed.length, 0);
});

test('Veille (#326-fu F2, R10): once the TERM is out, the SIGKILL escalation is NOT cancelled by a condition that only held when the stop began (the Admission hold fell because the TERM freed the RAM) — unless the after-signal predicate says the member woke', async (t) => {
  const tr = tree(t);
  const stubborn = orphan(['sh', '-c', 'trap "" TERM; exec sleep 603']);   // ignores SIGTERM: only the escalation can stop it
  const stubborn2 = orphan(['sh', '-c', 'trap "" TERM; exec sleep 604']);
  tr.scope('m1', 'aaaaaa', [stubborn.pid]);
  tr.scope('m2', 'bbbbbb', [stubborn2.pid]);
  const port = makeVeilleReliquatPort({ scopeEnv: tr.env, cliOf: noSession });
  const t0 = Date.now();
  const startOnly = () => Date.now() - t0 < 1500;   // true while the stop is beginning (ms), false by the time the grace wait is over (seconds)
  // the wake/delete predicate says « still wanted » all along; only the first one (start-time condition) lapses
  const rep = await port.stop('m1', { stillWanted: startOnly, stillWantedAfterSignal: () => true });
  assert.equal(rep?.aborted, undefined, 'not lifted');
  assert.equal(rep?.killed.some((k) => k.pid === stubborn.pid && k.signal === 'SIGKILL'), true, 'the escalation went out');
  assert.equal(await gone(stubborn), true, 'and the process is really gone');
  // control: without the after-signal predicate the lapsed condition cancels the escalation (the previous behaviour)
  const t1 = Date.now();
  const rep2 = await port.stop('m2', { stillWanted: () => Date.now() - t1 < 1500 });
  assert.equal(rep2?.aborted, 'lifted');
  assert.equal(alive(stubborn2), true, 'the TERM-ignoring process survived the cancelled escalation');
  // and a member that WOKE during the grace wait still ends it, signalled or not
  const t2 = Date.now();
  const rep3 = await port.stop('m2', { stillWanted: () => Date.now() - t2 < 1500, stillWantedAfterSignal: () => false });
  assert.equal(rep3?.aborted, 'lifted');
  assert.equal(alive(stubborn2), true);
});

test('a scope-less member\'s stop never asks for the keeper / CLI identity: an UNRESPONSIVE keeper must not keep it awake for ever (review 1)', async (t) => {
  const tr = tree(t);
  const calls: string[] = [];
  const port = makeVeilleReliquatPort({
    scopeEnv: tr.env,
    cliOf: async () => { calls.push('cliOf'); return { error: 'keeper 123 is alive but did not answer the probe' }; },
    countBrowsers: async () => 2,
    stopBrowsers: async (ws) => { calls.push(`stop:${ws}`); return null; },
  });
  assert.equal(await port.census('m1'), 2);
  assert.equal(await port.stop('m1'), null);
  assert.deepEqual(calls, ['stop:m1'], 'cliOf never consulted for a member with no scope');
  // CONTROL: a member WITH a scope and the same unresponsive keeper IS unknown (a kill needs the identity to protect)
  tr.scope('m2', 'aaaaaa', []);
  const rep = await port.stop('m2');
  assert.match(rep?.unknown ?? '', /did not answer the probe/);
});

test('what the member started AFTER the stop began is its new work: spared and LISTED, never killed (a wake mid-stop) — and a « no longer wanted » check ends the rounds', async (t) => {
  const tr = tree(t);
  const o1 = orphan(['sleep', '640']);
  tr.scope('m1', 'aaaaaa', [o1.pid]);
  // the clock of the stop says it began BEFORE the process was born: everything in the scope is newer
  const early = makeVeilleReliquatPort({ scopeEnv: tr.env, cliOf: noSession, kill: { ...real, now: () => 0 } });
  const rep = await early.stop('m1');
  assert.deepEqual(rep?.killed ?? [], []);
  assert.equal(rep?.spared.length, 1, 'listed as left alone');
  assert.equal(alive(o1), true);
  // not wanted any more (the member woke): no signal at all
  const port = makeVeilleReliquatPort({ scopeEnv: tr.env, cliOf: noSession });
  const rep2 = await port.stop('m1', { stillWanted: () => false });
  assert.equal(rep2?.aborted, 'lifted');
  assert.equal(alive(o1), true);
  // CONTROL: wanted ⇒ it dies
  await port.stop('m1', { stillWanted: () => true });
  assert.equal(await gone(o1), true);
});

test('a scope that VANISHES between the port\'s lookup and the kill\'s own (the last member exited) falls through to the browsers — the Reliquats of a member whose scope is gone are not forgotten', async (t) => {
  const tr = tree(t);
  tr.scope('m1', 'aaaaaa', []);
  const calls: string[] = [];
  let slices = 0;
  const env = { ...tr.env, readdir: (p: string) => (p === tr.slice && ++slices > 1 ? [] : tr.env.readdir(p)) }; // the first listing sees the scope, every later one does not
  const port = makeVeilleReliquatPort({ scopeEnv: env, cliOf: noSession, countBrowsers: async () => 0, stopBrowsers: async (ws) => { calls.push(`stop:${ws}`); return null; } });
  assert.equal(await port.stop('m1'), null);
  assert.deepEqual(calls, ['stop:m1']);
});
