// #515 — the acceptance flow FORCED by code: register (--spec) → the HOST spawns the `accept-` writer → it freezes (published to acceptance/<run>, status to implementer+verifier)
// → the candidate passes the gate with ZERO refusals; a candidate nominated BEFORE the freeze WAITS (never refused); deliver of an unfrozen ticket = acceptance-pending.
// REAL git (bare origin + writer + candidate clones), the production state reader/writer and gate/deliver wiring; only gh is faked and the host's spawn/bus are recorded.
// Rig + mutants through the BUILT CLI: scripts/e2e-fanout-acceptance-forced.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runFanout, type FanoutDeps, type HostCall, type Runner, defaultRunner } from './fanout-state.ts';
import { runAcceptance } from './fanout-acceptance.ts';
import { deliver, realDeps, type DeliverDeps, type DeliverOpts, type GhResult } from './fanout-deliver.ts';
import { gatePr, parseGateArgs, realGateDeps, type GateOpts } from './fanout-gate.ts';
import { dispatchFanoutAcceptance, type AcceptanceHostDeps } from '../shared/fanout-acceptance-host.ts';
import { acceptorName, acceptancePhase } from '../shared/fanout-acceptance.ts';
import { resolveSpawnRoleDefaults } from '../shared/fleet-roles.ts';
import { checkSpawnName } from '../shared/naming-policy.ts';
import { readState, stateFile } from '../shared/fanout-state.ts';

const NOW = '2026-11-22T10:00:00.000Z';
const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
const SPEC = "const test = require('node:test');\nconst assert = require('node:assert');\nconst { f } = require('../src/impl.js');\ntest('f is what the spec says', () => { assert.equal(f(), 1); });\n";
const CMD = 'node --test t/spec.test.js';
const pause = (ms: number): void => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }; // commit times have 1 s granularity: a head "before" the freeze is cut a full second earlier
const git = (cwd: string) => (...a: string[]): string => execFileSync('git', a, { cwd, env: GIT_ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

interface World {
  root: string; home: string; origin: string; writer: string; cand: string;
  env: (id: string) => NodeJS.ProcessEnv;
  deps: (id: string, cwd?: string) => FanoutDeps;
  spawned: Array<{ from?: string; name: string; task: string; repoPath?: string }>;
  posts: Array<{ to: string; sender: string; body: string }>;
  host: (call: HostCall, o?: { spawnFails?: string; postFails?: string[] }) => ReturnType<typeof dispatchFanoutAcceptance>;
  state: () => ReturnType<typeof readState>;
  /** register T1 with its spec: returns the hostCalls `state set` left for the app. */
  register: (extra?: string[]) => HostCall[];
  /** the writer commits its tests (never pushed) and freezes them as `w1` */
  freeze: (id?: string, ticket?: string) => ReturnType<typeof runAcceptance>;
  /** the candidate: copies the frozen files from the shared branch, commits impl code */
  candidate: (opts?: { copy?: boolean; code?: string }) => string;
}

function world(t: { after: (fn: () => void) => void }): World {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'accept-515-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  const origin = path.join(root, 'origin.git');
  const writer = path.join(root, 'writer');
  const cand = path.join(root, 'cand');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'master', origin], { env: GIT_ENV });
  execFileSync('git', ['clone', '-q', origin, writer], { env: GIT_ENV, stdio: 'ignore' });
  const w = git(writer);
  w('checkout', '-q', '-b', 'master');
  fs.mkdirSync(path.join(writer, 'src'));
  fs.writeFileSync(path.join(writer, 'src/impl.js'), 'exports.f = () => 0;\n');
  w('add', '.'); w('commit', '-q', '-m', 'root'); w('push', '-q', 'origin', 'master');
  w('checkout', '-q', '-b', 'accept-T1');
  fs.mkdirSync(path.join(writer, 't'));
  fs.writeFileSync(path.join(writer, 't/spec.test.js'), SPEC);
  w('add', '.'); w('commit', '-q', '-m', 'writer: acceptance tests'); // committed, NOT pushed: the freeze verb publishes
  execFileSync('git', ['clone', '-q', origin, cand], { env: GIT_ENV, stdio: 'ignore' });
  fs.mkdirSync(home, { recursive: true });
  const env = (id: string): NodeJS.ProcessEnv => ({ ORCHESTRA_HOME: home, ORCHESTRA_WS_ID: id });
  const ghFake: Runner = (cmd, args, cwd, e) => (cmd === 'git' ? defaultRunner(cmd, args, cwd, e) : { code: 1, stdout: '', stderr: 'gh: Not Found (HTTP 404)' });
  const deps = (id: string, cwd = writer): FanoutDeps => ({ env: env(id), cwd, runner: ghFake, now: () => new Date().toISOString(), readStdin: () => '' });
  const spawned: World['spawned'] = [];
  const posts: World['posts'] = [];
  const host: World['host'] = (call, o = {}) => {
    const hd: AcceptanceHostDeps = {
      home, now: () => new Date().toISOString(), isWorkspace: (id) => id === 'r1', repoPath: () => '/scratch/repo',
      spawn: async (i) => { spawned.push(i); return o.spawnFails ? { ok: false, error: o.spawnFails } : { ok: true, id: 'w1' }; },
      post: (i) => { if (o.postFails?.includes(i.to)) throw new Error('unknown workspace'); posts.push(i); },
    };
    return dispatchFanoutAcceptance(call.body, hd);
  };
  runFanout(['state', 'init', '--run', 'r1', '--repo', 'o/r'], deps('r1'));
  const wd: World = {
    root, home, origin, writer, cand, env, deps, spawned, posts, host,
    state: () => readState(stateFile(home, 'r1')),
    register: (extra = []) => {
      const r = runFanout(['state', 'set', 'T1', '--branch', 'impl-t1', '--spec', 'docs/spec.md#T1', '--implementer', 'impl-1', '--verifier', 'verif-1', ...extra], deps('r1'));
      assert.equal(r.code, 0, r.stderr);
      return r.hostCalls ?? [];
    },
    freeze: (id = 'w1', ticket = 'T1') => runAcceptance(['freeze', ticket, '--run', 'r1', '--files', 't/spec.test.js', '--run-cmd', CMD], deps(id)),
    candidate: (o = {}) => {
      const g = git(cand);
      g('fetch', '-q', 'origin');
      g('checkout', '-q', '-B', 'impl-t1', 'origin/master');
      if (o.copy !== false) { g('fetch', '-q', 'origin', 'acceptance/r1'); g('checkout', 'FETCH_HEAD', '--', 't/spec.test.js'); } // the documented copy step
      fs.writeFileSync(path.join(cand, 'src/impl.js'), o.code ?? 'exports.f = () => 1;\n');
      g('add', '-A'); g('commit', '-q', '-m', 'impl');
      return g('rev-parse', 'HEAD');
    },
  };
  return wd;
}

/** register → host spawn: the writer w1 exists, recorded on the ticket */
async function registered(t: { after: (fn: () => void) => void }): Promise<World> {
  const w = world(t);
  const calls = w.register();
  assert.equal(calls.length, 1);
  const res = await w.host(calls[0]);
  assert.equal(res.ok, true, JSON.stringify(res));
  return w;
}

// ── registration → auto-spawn ────────────────────────────────────────────────────────────────────────────

test('register: `state set --spec` leaves ONE spawn request for the host; the host spawns the accept- writer (role table pins Opus 5.5), brief = spec + ticket only, never a branch', async (t) => {
  const w = world(t);
  const calls = w.register();
  assert.deepEqual(calls, [{ route: '/fanoutAcceptance', body: { op: 'spawn', run: 'r1', ticket: 'T1', from: 'r1' } }]);
  const res = await w.host(calls[0]);
  assert.deepEqual(res, { ok: true, op: 'spawn', id: 'w1', name: 'accept-T1' });
  assert.equal(w.spawned.length, 1);
  assert.equal(w.spawned[0].from, 'r1', 'the writer is the run coordinator\'s child');
  assert.equal(w.spawned[0].name, 'accept-T1');
  assert.match(w.spawned[0].task, /docs\/spec\.md#T1/);
  assert.match(w.spawned[0].task, /orchestra fanout acceptance freeze T1 --run r1/);
  assert.match(w.spawned[0].task, /do NOT read any implementer branch/);
  assert.doesNotMatch(w.spawned[0].task, /impl-t1/, 'the implementer branch is not in the brief');
  // the spawn name resolves to the typed role: Opus 5.5 pinned in the table, the name passes the naming policy
  assert.equal(checkSpawnName(w.spawned[0].name).ok, true);
  assert.equal(resolveSpawnRoleDefaults(w.spawned[0].name, {}).model, 'claude-opus-5-5');
  assert.equal(w.state()!.tickets.T1.accept?.acceptor?.id, 'w1');
});

test('register must-PASS (no flow): a ticket WITHOUT --spec owes no writer — no host call, state unchanged in shape', () => {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'accept-515-nospec-'));
  try {
    const d: FanoutDeps = { env: { ORCHESTRA_HOME: root, ORCHESTRA_WS_ID: 'r1' }, cwd: root, runner: defaultRunner, now: () => NOW, readStdin: () => '' };
    runFanout(['state', 'init', '--run', 'r1'], d);
    const r = runFanout(['state', 'set', 'T9', '--status', 'started'], d);
    assert.equal(r.code, 0);
    assert.equal(r.hostCalls, undefined);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('register: a second request while the writer exists spawns NOTHING (one writer per ticket); a failed spawn is recorded and retried', async (t) => {
  const w = world(t);
  const c1 = w.register()[0];
  const fail = await w.host(c1, { spawnFails: 'worktree add collided' });
  assert.equal(fail.ok, false);
  assert.match(String((fail as { error: string }).error), /worktree add collided/);
  assert.equal(w.state()!.tickets.T1.accept?.acceptor?.error, 'worktree add collided');
  const again = w.register()[0]; // any later `state set` retries a failed spawn
  assert.equal((await w.host(again)).ok, true);
  assert.equal(w.spawned.length, 2);
  assert.equal(w.register().length, 0, 'a live writer owes no new request');
  const dup = await w.host(again);
  assert.equal(dup.ok, false);
  assert.match(String((dup as { error: string }).error), /already spawned/);
  assert.equal(w.spawned.length, 2, 'the duplicate request spawned nothing');
});

test('register: the writer is NOT spawned for a frozen or waived ticket', async (t) => {
  const w = await registered(t);
  assert.equal(w.freeze().code, 0);
  assert.equal(w.register().length, 0);
  assert.equal(acceptancePhase(w.state()!.tickets.T1), 'frozen');
});

test('naming: acceptorName makes an `accept-` spawn name the policy accepts for any ticket id', () => {
  for (const id of ['T1', '#515', 'NMC-360', 'a b/c', 'é.1', '..x..']) { const n = acceptorName(id); assert.equal(checkSpawnName(n).ok, true, `${id} → ${n}`); assert.equal(checkSpawnName(n).ok && (checkSpawnName(n) as { name: string }).name, n); }
});

// ── freeze: own ticket, shared branch, bus status ───────────────────────────────────────────────────────

test('freeze must-PASS: the writer publishes to ONE shared branch acceptance/<run> (bytes = what it committed), the state records path + command, the host tells implementer AND verifier', async (t) => {
  const w = await registered(t);
  const r = w.freeze();
  assert.equal(r.code, 0, r.stderr);
  const a = w.state()!.tickets.T1.acceptance!;
  assert.equal(a.source.branch, 'acceptance/r1');
  assert.equal(a.run, CMD);
  assert.equal(git(w.origin)('show', `acceptance/r1:t/spec.test.js`), SPEC.trimEnd());
  assert.equal(git(w.origin)('rev-parse', 'acceptance/r1'), a.source.head);
  assert.deepEqual(r.hostCalls, [{ route: '/fanoutAcceptance', body: { op: 'frozen', run: 'r1', ticket: 'T1', from: 'w1' } }]);
  const res = await w.host(r.hostCalls![0]);
  assert.deepEqual(res.ok && res.op === 'frozen' ? res.notified.sort() : null, ['impl-1', 'verif-1']);
  assert.equal(w.posts.length, 2);
  for (const p of w.posts) {
    assert.equal(p.sender, 'w1');
    assert.match(p.body, /t\/spec\.test\.js/);
    assert.match(p.body, /Run: node --test t\/spec\.test\.js/);
    assert.match(p.body, /acceptance\/r1/);
  }
  assert.match(w.deps('r1').env.ORCHESTRA_HOME!, /home$/);
  const brief = runAcceptance(['show', 'T1', '--run', 'r1', '--brief'], w.deps('impl-1'));
  assert.match(brief.stdout, /acceptance\/r1@[0-9a-f]{12}.*t\/spec\.test\.js.*run: node --test t\/spec\.test\.js/);
  const show = runFanout(['state', 'show'], w.deps('r1'));
  assert.match(show.stdout, /acceptance \(#515\):\n\s+T1\s+frozen\s+acceptance\/r1@[0-9a-f]{12}.*run: node --test/);
});

test('freeze must-FAIL: a writer may freeze ONLY its own ticket (exit 2), and nothing is published or recorded', async (t) => {
  const w = await registered(t);
  runFanout(['state', 'set', 'T2', '--spec', 'docs/spec.md#T2'], w.deps('r1'));
  const r = w.freeze('w1', 'T2');
  assert.equal(r.code, 2);
  assert.match(r.stderr, /writer of ticket T1; you may freeze only that ticket, not T2/);
  assert.equal(w.state()!.tickets.T2.acceptance, null);
  assert.throws(() => git(w.origin)('rev-parse', '--verify', 'acceptance/r1'), 'nothing was published');
});

test('freeze must-FAIL: a path another ticket already froze with OTHER bytes on the shared branch ⇒ exit 2, branch untouched', async (t) => {
  const w = await registered(t);
  assert.equal(w.freeze().code, 0);
  const tip = git(w.origin)('rev-parse', 'acceptance/r1');
  runFanout(['state', 'set', 'T2', '--spec', 'docs/spec.md#T2'], w.deps('r1'));
  const hd: AcceptanceHostDeps = { home: w.home, now: () => NOW, isWorkspace: (x) => x === 'r1', repoPath: () => undefined, spawn: async () => ({ ok: true, id: 'w2' }), post: () => {} };
  await dispatchFanoutAcceptance({ op: 'spawn', run: 'r1', ticket: 'T2', from: 'r1' }, hd);
  const g = git(w.writer);
  g('checkout', '-q', '-b', 'accept-T2', 'master');
  fs.mkdirSync(path.join(w.writer, 't'), { recursive: true });
  fs.writeFileSync(path.join(w.writer, 't/spec.test.js'), SPEC.replace('1', '2'));
  g('add', '-A'); g('commit', '-q', '-m', 'other tests, same path');
  const r = runAcceptance(['freeze', 'T2', '--run', 'r1', '--files', 't/spec.test.js', '--run-cmd', CMD], w.deps('w2'));
  assert.equal(r.code, 2, r.stderr);
  assert.match(r.stderr, /already on acceptance\/r1 with other bytes/);
  assert.equal(w.state()!.tickets.T2.acceptance, null);
  assert.equal(git(w.origin)('rev-parse', 'acceptance/r1'), tip);
});

test('freeze: two tickets with DISJOINT paths accumulate on the one branch (the second commit builds on the first)', async (t) => {
  const w = await registered(t);
  assert.equal(w.freeze().code, 0);
  const first = git(w.origin)('rev-parse', 'acceptance/r1');
  runFanout(['state', 'set', 'T2', '--spec', 'docs/spec.md#T2'], w.deps('r1'));
  // T2's writer: the host records a second writer id by a spawn that answers w2
  const hd = (id: string): AcceptanceHostDeps => ({ home: w.home, now: () => NOW, isWorkspace: (x) => x === 'r1', repoPath: () => undefined, spawn: async () => ({ ok: true, id }), post: () => {} });
  await dispatchFanoutAcceptance({ op: 'spawn', run: 'r1', ticket: 'T2', from: 'r1' }, hd('w2'));
  const g = git(w.writer);
  g('checkout', '-q', '-b', 'accept-T2', 'master');
  fs.mkdirSync(path.join(w.writer, 't'), { recursive: true });
  fs.writeFileSync(path.join(w.writer, 't/other.test.js'), SPEC.replace('1', '2'));
  g('add', '-A'); g('commit', '-q', '-m', 'T2 tests');
  const r = runAcceptance(['freeze', 'T2', '--run', 'r1', '--files', 't/other.test.js', '--run-cmd', 'node --test t/other.test.js'], w.deps('w2'));
  assert.equal(r.code, 0, r.stderr);
  const second = git(w.origin)('rev-parse', 'acceptance/r1');
  assert.notEqual(second, first);
  assert.equal(git(w.origin)('rev-parse', `${second}^`), first);
  assert.deepEqual(git(w.origin)('ls-tree', '-r', '--name-only', second).split('\n').sort(), ['t/other.test.js', 't/spec.test.js']);
});

test('freeze status: a recipient that cannot be told is reported (failed), the others still are; no implementer/verifier recorded ⇒ a note, not silence', async (t) => {
  const w = await registered(t);
  const r = w.freeze();
  const res = await w.host(r.hostCalls![0], { postFails: ['verif-1'] });
  assert.equal(res.ok && res.op === 'frozen' && res.notified.join(), 'impl-1');
  assert.deepEqual(res.ok && res.op === 'frozen' ? res.failed.map((f) => f.id) : null, ['verif-1']);
  const w2 = world(t);
  runFanout(['state', 'set', 'T1', '--spec', 's'], w2.deps('r1'));
  await w2.host({ route: '/fanoutAcceptance', body: { op: 'spawn', run: 'r1', ticket: 'T1', from: 'r1' } });
  const r2 = w2.freeze();
  const res2 = await w2.host(r2.hostCalls![0]);
  assert.equal(res2.ok && res2.op === 'frozen' && res2.notified.length, 0);
  assert.match(String(res2.ok && res2.op === 'frozen' && res2.note), /nobody was told/);
});

test('freeze status must-FAIL: the host posts nothing on the word of a stranger (neither the writer nor the run coordinator)', async (t) => {
  const w = await registered(t);
  w.freeze();
  const res = await w.host({ route: '/fanoutAcceptance', body: { op: 'frozen', run: 'r1', ticket: 'T1', from: 'someone-else' } });
  assert.equal(res.ok, false);
  assert.equal(w.posts.length, 0);
});

// ── gate: pending never refuses; the normal path costs ZERO refusals ─────────────────────────────────────

const gateGh = async (args: string[]): Promise<GhResult> => {
  if (args[0] === 'api') return { code: 1, stdout: '', stderr: 'gh: Not Found (HTTP 404)' }; // the target has no workflows
  if (args[0] === 'pr' && args[1] === 'list') return { code: 0, stdout: '[]', stderr: '' };
  return { code: 1, stdout: '', stderr: `unexpected gh ${args.join(' ')}` };
};
async function gate(w: World, head: string, o: { cwd?: string | null; waitSec?: number; onSleep?: (n: number) => void } = {}) {
  Object.assign(process.env, w.env('v1'));
  let clock = Date.parse(NOW);
  let n = 0;
  const opts: GateOpts = { branch: 'impl-t1', into: 'master', head, requireChecks: [], ticket: 'T1', run: 'r1', cwd: o.cwd === null ? undefined : (o.cwd ?? w.cand), settleMs: 0, ...(o.waitSec !== undefined ? { acceptWaitSec: o.waitSec } : {}), pollMs: 1000 };
  const logs: string[] = [];
  const res = await gatePr(opts, { ...realGateDeps(), gh: gateGh, log: (s) => logs.push(s), now: () => clock, sleep: async (ms) => { clock += ms; o.onSleep?.(++n); } });
  return { ...res, logs, polls: n };
}

test('NORMAL PATH: register → auto-spawn → freeze → the candidate passes the gate with ZERO refusals and no `pending`', async (t) => {
  const w = await registered(t);
  assert.equal(w.freeze().code, 0);
  const head = w.candidate();
  const { exit, result, polls } = await gate(w, head);
  assert.equal(exit, 0, JSON.stringify(result));
  assert.equal(result.verdict, 'gate');
  assert.equal((result as { acceptance?: { ok?: boolean } }).acceptance?.ok, true);
  assert.equal(polls, 0, 'frozen before the nomination: nothing to wait for');
  assert.equal(result.reason, undefined);
});

test('EARLY NOMINATION: nominated BEFORE the freeze ⇒ the gate WAITS (bound + deadline in the state), the freeze lands, the answer is `pending` (exit 3, ZERO refusals); after the implementer copies the tests the new head passes', async (t) => {
  const w = await registered(t);
  const h1 = w.candidate({ copy: false }); // nominated with its code only: the blind writer's tests are not frozen yet
  pause(1100);
  let seenWait: { since: string; deadline: string; boundSec: number } | null = null;
  const g1 = await gate(w, h1, {
    waitSec: 60,
    onSleep: (n) => {
      if (n === 1) seenWait = w.state()!.tickets.T1.accept?.wait ?? null; // the window is in the state WHILE the gate waits
      if (n === 3) assert.equal(w.freeze().code, 0); // the writer's freeze lands during the wait
    },
  });
  assert.ok(seenWait, 'the wait window was recorded while waiting');
  assert.equal((seenWait as unknown as { boundSec: number }).boundSec, 60);
  assert.equal((seenWait as unknown as { deadline: string }).deadline, new Date(Date.parse(NOW) + 60_000).toISOString());
  assert.equal(g1.polls, 3, 'it stopped waiting as soon as the freeze landed');
  assert.equal(g1.exit, 3, JSON.stringify(g1.result));
  assert.equal(g1.result.verdict, 'pending');
  assert.match(String(g1.result.detail), /does not carry them.*no round consumed/);
  assert.equal(w.state()!.tickets.T1.accept?.wait, null, 'the freeze closes the wait window');
  // the implementer (told by the bus status) copies the frozen files UNCHANGED from the shared branch and pushes the new head
  const gc = git(w.cand);
  gc('fetch', '-q', 'origin', 'acceptance/r1'); gc('checkout', 'FETCH_HEAD', '--', 't/spec.test.js'); gc('commit', '-q', '-m', 'copy frozen tests');
  const g2 = await gate(w, gc('rev-parse', 'HEAD'));
  assert.equal(g2.exit, 0, JSON.stringify(g2.result));
  assert.equal(g2.result.verdict, 'gate');
  assert.equal((g2.result as { acceptance?: { ok?: boolean } }).acceptance?.ok, true);
  assert.equal([g1, g2].filter((g) => g.result.verdict === 'refused').length, 0, 'zero refusals across the whole early-nomination path');
});

test('EARLY NOMINATION must-FAIL: a candidate that carries a DIFFERENT file at the frozen path is still refused once the freeze lands (only an ABSENT file is a copy-pending answer)', async (t) => {
  const w = await registered(t);
  const g0 = git(w.cand);
  g0('fetch', '-q', 'origin'); g0('checkout', '-q', '-B', 'impl-t1', 'origin/master');
  fs.mkdirSync(path.join(w.cand, 't'), { recursive: true });
  fs.writeFileSync(path.join(w.cand, 't/spec.test.js'), SPEC.replace('assert.equal(f(), 1)', 'assert.ok(true)')); // its own, weaker version of the test
  fs.writeFileSync(path.join(w.cand, 'src/impl.js'), 'exports.f = () => 1;\n');
  g0('add', '-A'); g0('commit', '-q', '-m', 'impl with its own test');
  const g = await gate(w, g0('rev-parse', 'HEAD'), { waitSec: 60, onSleep: (n) => { if (n === 1) assert.equal(w.freeze().code, 0); } });
  assert.equal(g.exit, 2);
  assert.equal(g.result.reason, 'frozen-test-changed');
});

test('EARLY NOMINATION, tests copied by the implementer from the shared branch before the writer finished is impossible — and a candidate that already holds the right bytes passes when the freeze lands', async (t) => {
  const w = await registered(t);
  // the implementer wrote the SAME bytes itself (never the case for a blind writer, but the bytes decide): gate waits, freeze lands, bytes equal ⇒ pass
  const g0 = git(w.cand);
  g0('fetch', '-q', 'origin'); g0('checkout', '-q', '-B', 'impl-t1', 'origin/master');
  fs.mkdirSync(path.join(w.cand, 't'), { recursive: true });
  fs.writeFileSync(path.join(w.cand, 't/spec.test.js'), SPEC);
  fs.writeFileSync(path.join(w.cand, 'src/impl.js'), 'exports.f = () => 1;\n');
  g0('add', '-A'); g0('commit', '-q', '-m', 'impl + same bytes');
  const head = g0('rev-parse', 'HEAD');
  const g = await gate(w, head, { waitSec: 60, onSleep: (n) => { if (n === 2) assert.equal(w.freeze().code, 0); } });
  assert.equal(g.exit, 0, JSON.stringify(g.result));
  assert.equal(g.result.verdict, 'gate');
  assert.equal((g.result as { acceptance?: { ok?: boolean } }).acceptance?.ok, true);
});

test('gate PENDING: unfrozen at the bound ⇒ verdict pending, exit 3 (not a refusal), the rest of the gate answered, bound + deadline in the state', async (t) => {
  const w = await registered(t);
  const head = w.candidate({ copy: false });
  const { exit, result } = await gate(w, head, { waitSec: 5 });
  assert.equal(exit, 3);
  assert.equal(result.verdict, 'pending');
  assert.equal(result.reason, 'acceptance-pending');
  assert.equal('fullSuite' in result, true, 'the CI half of the gate is in the same answer');
  const wait = w.state()!.tickets.T1.accept!.wait!;
  assert.equal(wait.boundSec, 5);
  assert.equal(wait.deadline, new Date(Date.parse(NOW) + 5_000).toISOString());
  assert.match(runFanout(['state', 'show'], w.deps('r1')).stdout, /pending\s+writer: accept-T1 \(w1\)\s+gate waits until .* \(bound 5s\)/);
});

test('gate --accept-wait 0: answers pending at once and records NO wait window (the state only holds a real bound)', async (t) => {
  const w = await registered(t);
  const g = await gate(w, w.candidate({ copy: false }), { waitSec: 0 });
  assert.equal(g.exit, 3);
  assert.equal(g.result.verdict, 'pending');
  assert.equal(g.polls, 0);
  assert.equal(w.state()!.tickets.T1.accept?.wait, null);
});

test('gate must-FAIL (hard refusals stay): an EDITED frozen test and a RED one are refused (exit 2), frozen or not', async (t) => {
  const w = await registered(t);
  assert.equal(w.freeze().code, 0);
  const head = w.candidate({ code: 'exports.f = () => 2;\n' });
  const red = await gate(w, head);
  assert.equal(red.exit, 2);
  assert.equal(red.result.reason, 'frozen-test-failed');
  fs.writeFileSync(path.join(w.cand, 't/spec.test.js'), SPEC.replace('assert.equal(f(), 1)', 'assert.ok(true)'));
  const g = git(w.cand); g('add', '-A'); g('commit', '-q', '-m', 'weaken');
  const edited = await gate(w, g('rev-parse', 'HEAD'));
  assert.equal(edited.exit, 2);
  assert.equal(edited.result.reason, 'frozen-test-changed');
});

test('gate: --accept-wait parses (0..3600 whole seconds, only with --ticket)', () => {
  const base = ['--branch', 'b', '--into', 'master', '--head', 'a'.repeat(40)];
  assert.equal(parseGateArgs([...base, '--ticket', 'T', '--accept-wait', '30']).ok, true);
  for (const bad of [['--accept-wait', '30'], ['--ticket', 'T', '--accept-wait', '-1'], ['--ticket', 'T', '--accept-wait', '3601'], ['--ticket', 'T', '--accept-wait', 'x']]) assert.equal(parseGateArgs([...base, ...bad]).ok, false, bad.join(' '));
});

// ── deliver: acceptance-pending, the recorded escapes ───────────────────────────────────────────────────

function deliverRig(w: World, head: string) {
  let merged = false;
  const gh = async (args: string[]): Promise<GhResult> => {
    const [a, b] = args;
    const ok = (s: string): GhResult => ({ code: 0, stdout: s, stderr: '' });
    if (a === 'api') {
      if (/\/commits\/[0-9a-f]{40}$/.test(args[args.length - 1])) return ok('{}');
      const m = /\/contents\/(.+)\?ref=([0-9a-f]{40})$/.exec(args[args.length - 1]);
      if (m) { try { return ok(execFileSync('git', ['show', `${m[2]}:${decodeURIComponent(m[1])}`], { cwd: w.cand, env: GIT_ENV, encoding: 'utf8' })); } catch { return { code: 1, stdout: '', stderr: 'gh: Not Found (HTTP 404)' }; } }
      return { code: 1, stdout: '', stderr: 'HTTP 404' };
    }
    if (a === 'pr' && b === 'list') return ok(JSON.stringify([{ number: 7, url: 'https://github.com/o/r/pull/7', state: merged ? 'MERGED' : 'OPEN', headRefOid: head }]));
    if (a === 'pr' && b === 'create') return ok('https://github.com/o/r/pull/7\n');
    if (a === 'pr' && b === 'view') {
      if (args.includes('state,mergeCommit')) return ok(JSON.stringify({ state: merged ? 'MERGED' : 'OPEN', mergeCommit: { oid: 'c'.repeat(40) } }));
      return ok(JSON.stringify({ state: merged ? 'MERGED' : 'OPEN', baseRefName: 'master', headRefOid: head, mergeable: 'MERGEABLE', statusCheckRollup: [{ __typename: 'CheckRun', name: 'ci', status: 'COMPLETED', conclusion: 'SUCCESS', detailsUrl: 'https://github.com/o/r/actions/runs/900/job/901' }] }));
    }
    if (a === 'run' && b === 'view') return ok(JSON.stringify({ jobs: [{ databaseId: 901, steps: [{ name: 'Set up job', conclusion: 'success' }, { name: 'Run tests', conclusion: 'success' }] }] }));
    if (a === 'pr' && b === 'merge') { merged = true; return ok(''); }
    return { code: 1, stdout: '', stderr: `unexpected gh ${args.join(' ')}` };
  };
  const logs: string[] = [];
  const deps: DeliverDeps = { ...realDeps(), gh, sleep: async () => {}, now: () => 0, log: (s) => logs.push(s) };
  return { deps, logs, merged: () => merged };
}
const dopts = (head: string, o: Partial<DeliverOpts> = {}): DeliverOpts => ({
  branch: 'impl-t1', into: 'master', ticket: 'T1', verifiedHead: head, noReviewGate: true, strategy: 'merge', timeoutMs: 600_000, intervalMs: 10_000, noChecksGraceMs: 30_000, requireChecks: [], run: 'r1', ...o,
});

test('deliver must-FAIL: a ticket with a registered spec and NO frozen tests ⇒ exit 2 acceptance-pending, nothing merged, no PR opened', async (t) => {
  const w = await registered(t);
  Object.assign(process.env, w.env('r1'));
  const head = w.candidate({ copy: false });
  const x = deliverRig(w, head);
  const { exit, result } = await deliver(dopts(head), x.deps);
  assert.equal(exit, 2);
  assert.equal(result.verdict, 'refused');
  assert.equal(result.reason, 'acceptance-pending');
  assert.match(String(result.detail), /accept-T1/);
  assert.equal(x.merged(), false);
});

test('deliver must-PASS: the frozen, gated candidate merges (acceptanceChecked) — zero refusals on the normal path', async (t) => {
  const w = await registered(t);
  assert.equal(w.freeze().code, 0);
  Object.assign(process.env, w.env('r1'));
  const head = w.candidate();
  const g = await gate(w, head);
  assert.equal(g.exit, 0);
  const rf = path.join(w.root, 'receipt.json');
  fs.writeFileSync(rf, JSON.stringify(g.result));
  const x = deliverRig(w, head);
  const { exit, result } = await deliver(dopts(head, { acceptance: rf }), x.deps);
  assert.equal(exit, 0, JSON.stringify(result));
  assert.equal(result.acceptanceChecked, true);
  assert.equal(x.merged(), true);
});

test('deliver --no-acceptance-gate: merges an unfrozen ticket, says so in the result AND leaves the record in the state; it does NOT lift a refusal for an edited frozen test', async (t) => {
  const w = await registered(t);
  Object.assign(process.env, w.env('r1'));
  const head = w.candidate({ copy: false });
  const x = deliverRig(w, head);
  const { exit, result } = await deliver(dopts(head, { noAcceptanceGate: true }), x.deps);
  assert.equal(exit, 0, JSON.stringify(result));
  assert.equal(result.acceptanceGate, 'bypassed');
  assert.equal(x.merged(), true);
  assert.equal(w.state()!.tickets.T1.accept?.waived?.decision, 'deliver --no-acceptance-gate');
  // frozen + edited: the flag changes nothing
  const w2 = await registered(t);
  assert.equal(w2.freeze().code, 0);
  Object.assign(process.env, w2.env('r1'));
  fs.writeFileSync(path.join(w2.cand, 't'), '');
  const h2 = w2.candidate({ copy: false });
  const x2 = deliverRig(w2, h2);
  const r2 = await deliver(dopts(h2, { noAcceptanceGate: true }), x2.deps);
  assert.equal(r2.exit, 2);
  assert.equal(r2.result.reason, 'acceptance-unproven');
  assert.equal(x2.merged(), false);
});

// ── waive ───────────────────────────────────────────────────────────────────────────────────────────────

const DECISION = 'https://github.com/o/r/issues/511#issuecomment-900';
const waiveDeps = (w: World, body: string | null): FanoutDeps => ({
  ...w.deps('r1'),
  runner: (cmd, args, cwd, e) => (cmd === 'git' ? defaultRunner(cmd, args, cwd, e) : body === null ? { code: 1, stdout: '', stderr: 'gh: Not Found (HTTP 404)' } : { code: 0, stdout: JSON.stringify({ body }), stderr: '' }),
});

test('waive must-PASS: a ledger decision naming the ticket + a reason ⇒ recorded; deliver proceeds (acceptanceGate:waived); the gate says so; no writer is owed any more', async (t) => {
  const w = world(t);
  w.register();
  const r = runAcceptance(['waive', 'T1', '--decision', DECISION, '--reason', 'docs only'], waiveDeps(w, 'Decision: T1 is docs only, no tests.'));
  assert.equal(r.code, 0, r.stderr);
  assert.equal(w.state()!.tickets.T1.accept?.waived?.reason, 'docs only');
  assert.equal(w.register().length, 0, 'waived: nothing to spawn');
  Object.assign(process.env, w.env('r1'));
  const head = w.candidate({ copy: false });
  const x = deliverRig(w, head);
  const d = await deliver(dopts(head), x.deps);
  assert.equal(d.exit, 0, JSON.stringify(d.result));
  assert.equal(d.result.acceptanceGate, 'waived');
  const g = await gate(w, head, { cwd: null });
  assert.equal(g.exit, 0);
  assert.deepEqual((g.result as { acceptance?: unknown }).acceptance, { waived: { decision: DECISION, reason: 'docs only' } });
});

test('waive must-FAIL: no decision / no reason / a decision that does not name the ticket / an unreadable decision ⇒ nothing recorded', async (t) => {
  const w = world(t);
  w.register();
  const cases: Array<[string[], string | null, number, RegExp]> = [
    [['--reason', 'x'], 'T1', 2, /needs --decision/],
    [['--decision', DECISION], 'T1', 2, /needs --reason/],
    [['--decision', DECISION, '--reason', 'x'], 'a decision about another ticket', 2, /does not name ticket T1/],
    [['--decision', DECISION, '--reason', 'x'], null, 1, /could not read the decision/],
  ];
  for (const [args, body, code, msg] of cases) {
    const r = runAcceptance(['waive', 'T1', ...args], waiveDeps(w, body));
    assert.equal(r.code, code, r.stderr);
    assert.match(r.stderr, msg);
  }
  assert.equal(w.state()!.tickets.T1.accept?.waived ?? null, null);
});

test('waive/spawn/freeze: `state set` cannot write the code-owned fields (accept, acceptance)', async (t) => {
  const w = await registered(t);
  for (const patch of [{ accept: { waived: { decision: 'x', reason: 'y', at: NOW } } }, { acceptance: null }]) {
    const r = runFanout(['state', 'set', 'T1', '--json', JSON.stringify(patch)], w.deps('r1'));
    assert.equal(r.code, 1);
    assert.match(r.stderr, /unknown field/);
  }
});

test('spawn verb: re-requests a missing writer; refuses when one exists', async (t) => {
  const w = await registered(t);
  assert.equal(runAcceptance(['spawn', 'T1'], w.deps('r1')).code, 2);
  const w2 = world(t);
  const calls = w2.register();
  await w2.host(calls[0], { spawnFails: 'boom' });
  const r = runAcceptance(['spawn', 'T1'], w2.deps('r1'));
  assert.equal(r.code, 0);
  assert.equal(r.hostCalls?.[0].body.op, 'spawn');
});

// ── pre-review fixes (MAJOR 1-4) ───────────────────────────────────────────────────────────────────────────

test('gate: a freeze that landed BEFORE the gate started, on a candidate nominated before it (every file absent, head not newer than the freeze) is `pending` exit 3 — never a refusal round', async (t) => {
  const w = await registered(t);
  const head = w.candidate({ copy: false }); // committed first …
  pause(1100);
  assert.equal(w.freeze().code, 0); // … the freeze lands after (same second at worst)
  const g = await gate(w, head);
  assert.equal(g.exit, 3, JSON.stringify(g.result));
  assert.equal(g.result.verdict, 'pending');
  assert.equal('fullSuite' in g.result, true, 'the CI half is answered in the same line');
  assert.match(String(g.result.detail), /no round consumed/);
});

test('gate must-FAIL (A\'s arms stay): a frozen file DELETED by a head committed AFTER the freeze is still a hard refusal', async (t) => {
  const w = await registered(t);
  assert.equal(w.freeze().code, 0);
  const head = w.candidate(); // copies the tests …
  const gc = git(w.cand);
  fs.rmSync(path.join(w.cand, 't/spec.test.js'));
  gc('add', '-A');
  execFileSync('git', ['commit', '-q', '-m', 'delete the frozen test'], { cwd: w.cand, env: { ...GIT_ENV, GIT_COMMITTER_DATE: new Date(Date.now() + 120_000).toISOString(), GIT_AUTHOR_DATE: new Date(Date.now() + 120_000).toISOString() } });
  const g = await gate(w, gc('rev-parse', 'HEAD'));
  assert.equal(g.exit, 2);
  assert.equal(g.result.reason, 'frozen-test-changed');
  assert.notEqual(head, gc('rev-parse', 'HEAD'));
});

test('deliver --no-acceptance-gate: the bypass is recorded only once the merge LANDED — a refused / failed merge leaves the ticket pending, not waived', async (t) => {
  const w = await registered(t);
  Object.assign(process.env, w.env('r1'));
  const head = w.candidate({ copy: false });
  const x = deliverRig(w, head);
  const failing: DeliverDeps = { ...x.deps, gh: async (a) => (a[0] === 'pr' && a[1] === 'merge' ? { code: 1, stdout: '', stderr: 'merge conflict' } : x.deps.gh(a)) };
  const bad = await deliver(dopts(head, { noAcceptanceGate: true }), failing);
  assert.notEqual(bad.exit, 0);
  assert.equal(w.state()!.tickets.T1.accept?.waived ?? null, null, 'nothing merged ⇒ no waiver on the ticket');
  assert.equal(acceptancePhase(w.state()!.tickets.T1), 'pending');
  const ok = await deliver(dopts(head, { noAcceptanceGate: true }), x.deps);
  assert.equal(ok.exit, 0, JSON.stringify(ok.result));
  assert.equal(w.state()!.tickets.T1.accept?.waived?.decision, 'deliver --no-acceptance-gate');
});

test('freeze must-FAIL: on a forced ticket only its recorded writer (or the run coordinator) may freeze — a stranger, even with no ticket of its own, is refused (exit 2)', async (t) => {
  const w = await registered(t);
  const r = w.freeze('stranger-9');
  assert.equal(r.code, 2);
  assert.match(r.stderr, /only its test writer \(w1\) or the run's coordinator \(r1\) may freeze it/);
  assert.equal(w.state()!.tickets.T1.acceptance, null);
  assert.equal(w.freeze('r1').code, 0, 'the coordinator may');
});

test('stuck ticket: a claim that never settled (app died mid-spawn) is retaken after CLAIM_STALE_SEC; a fresh one is not; `spawn --replace` respawns a recorded writer, plain `spawn` refuses', async (t) => {
  const w = world(t);
  const call = w.register()[0];
  const hd = (id: string): AcceptanceHostDeps => ({ home: w.home, now: () => new Date().toISOString(), isWorkspace: (x) => x === 'r1', repoPath: () => undefined, spawn: async () => ({ ok: true, id }), post: () => {} });
  // a fresh in-flight claim: nothing owed, a second request is refused
  const stateFile1 = path.join(w.home, 'fanout', 'r1', 'state.json');
  const claimed = JSON.parse(fs.readFileSync(stateFile1, 'utf8'));
  claimed.tickets.T1.accept = { acceptor: { id: null, name: 'accept-T1', at: new Date().toISOString() }, wait: null, waived: null };
  fs.writeFileSync(stateFile1, JSON.stringify(claimed));
  assert.equal(w.register().length, 0, 'fresh claim: not owed');
  assert.equal((await dispatchFanoutAcceptance(call.body, hd('w2'))).ok, false);
  // the same claim, an hour old
  claimed.tickets.T1.accept.acceptor.at = new Date(Date.now() - 3_600_000).toISOString();
  fs.writeFileSync(stateFile1, JSON.stringify(claimed));
  assert.equal(w.register().length, 1, 'stale claim: owed again');
  assert.deepEqual(await dispatchFanoutAcceptance(call.body, hd('w2')), { ok: true, op: 'spawn', id: 'w2', name: 'accept-T1' });
  // a settled writer: plain spawn refused, --replace respawns (its session died)
  assert.equal(runAcceptance(['spawn', 'T1', '--run', 'r1'], w.deps('r1')).code, 2);
  const rep = runAcceptance(['spawn', 'T1', '--run', 'r1', '--replace'], w.deps('r1'));
  assert.equal(rep.code, 0);
  assert.equal(rep.hostCalls?.[0].body.replace, true);
  assert.equal((await dispatchFanoutAcceptance(rep.hostCalls![0].body, hd('w3'))).ok, true);
  assert.equal(w.state()!.tickets.T1.accept?.acceptor?.id, 'w3');
  assert.equal((await dispatchFanoutAcceptance(call.body, hd('w4'))).ok, false, 'without replace the live writer is kept');
});

// ── review c/7080072759 fix round: M1, M3, m4, m7 ───────────────────────────────────────────────────────────

test('M1 must-FAIL (reviewer input A): a writer cannot freeze a ticket of ANOTHER run — not even a no-spec one, not even creating a new ticket there', async (t) => {
  const w = await registered(t);
  runFanout(['state', 'init', '--run', 'r2'], w.deps('r2'));
  runFanout(['state', 'set', 'TX', '--status', 'started'], w.deps('r2'));
  const before = readState(stateFile(w.home, 'r2'))!;
  for (const ticket of ['TX', 'ZZ']) {
    const r = runAcceptance(['freeze', ticket, '--run', 'r2', '--files', 't/spec.test.js', '--run-cmd', CMD], w.deps('w1'));
    assert.equal(r.code, 2, `${ticket}: ${r.stderr}`);
    assert.match(r.stderr, /only its test writer \(none recorded in this run\) or the run's coordinator \(r2\) may freeze it, not w1/);
  }
  assert.deepEqual(readState(stateFile(w.home, 'r2')), before, 'run r2 was not touched (no ticket created, nothing frozen)');
  assert.throws(() => git(w.origin)('rev-parse', '--verify', 'acceptance/r2'), 'nothing was published for r2');
});

test('M1 must-FAIL (reviewer input B): a freeze with NO workspace identity is refused (not read as the coordinator), on a forced and on a no-spec ticket', async (t) => {
  const w = await registered(t);
  for (const ticket of ['T1', 'T9']) {
    const r = runAcceptance(['freeze', ticket, '--run', 'r1', '--files', 't/spec.test.js', '--run-cmd', CMD], { ...w.deps('w1'), env: { ORCHESTRA_HOME: w.home, ORCHESTRA_WS_ID: '' } });
    assert.equal(r.code, 2, r.stderr);
    assert.match(r.stderr, /no workspace identity/);
  }
  assert.equal(w.state()!.tickets.T1.acceptance, null);
  assert.equal(w.state()!.tickets.T9, undefined);
});

test('M1 must-PASS: the run coordinator (its own run) and the ticket\'s recorded writer still freeze — a no-spec ticket by the coordinator only', async (t) => {
  const w = await registered(t);
  assert.equal(w.freeze('w1').code, 0);
  runFanout(['state', 'set', 'T3', '--status', 'started'], w.deps('r1'));
  assert.equal(runAcceptance(['freeze', 'T3', '--run', 'r1', '--files', 't/spec.test.js', '--run-cmd', CMD], w.deps('w1')).code, 2, 'the writer of T1 is not T3\'s');
  assert.equal(runAcceptance(['freeze', 'T3', '--run', 'r1', '--files', 't/spec.test.js', '--run-cmd', CMD], w.deps('r1')).code, 0, 'the coordinator may (the #510 manual path)');
});

test('M3: no spec + nothing frozen + no waiver ⇒ deliver exit 2 acceptance-pending naming the 3 ways out; `state set` says so up front; waive works without a spec; --no-acceptance-gate merges it (recorded)', async (t) => {
  const w = world(t);
  const set = runFanout(['state', 'set', 'T1', '--branch', 'impl-t1'], w.deps('r1'));
  assert.equal(set.hostCalls, undefined, 'no spec ⇒ no writer');
  assert.match(set.stderr, /T1 has no --spec, nothing frozen and no waiver: `fanout deliver` will refuse it \(acceptance-pending\)/);
  assert.match(runFanout(['state', 'show'], w.deps('r1')).stdout, /T1\s+unspecified\s+no --spec/);
  Object.assign(process.env, w.env('r1'));
  const head = w.candidate({ copy: false });
  const x = deliverRig(w, head);
  const d = await deliver(dopts(head), x.deps);
  assert.equal(d.exit, 2);
  assert.equal(d.result.reason, 'acceptance-pending');
  assert.match(String(d.result.detail), /register --spec[\s\S]*acceptance waive T1[\s\S]*--no-acceptance-gate/);
  assert.equal(x.merged(), false);
  // waive without a spec
  const wv = runAcceptance(['waive', 'T1', '--decision', DECISION, '--reason', 'docs only'], waiveDeps(w, 'Decision: T1 is docs only.'));
  assert.equal(wv.code, 0, wv.stderr);
  const ok = await deliver(dopts(head), deliverRig(w, head).deps);
  assert.equal(ok.exit, 0, JSON.stringify(ok.result));
  assert.equal(ok.result.acceptanceGate, 'waived');
  // the explicit escape, on another unspecced ticket
  runFanout(['state', 'set', 'T2', '--branch', 'impl-t1'], w.deps('r1'));
  const x2 = deliverRig(w, head);
  const e = await deliver(dopts(head, { ticket: 'T2', noAcceptanceGate: true }), x2.deps);
  assert.equal(e.exit, 0, JSON.stringify(e.result));
  assert.equal(e.result.acceptanceGate, 'bypassed');
  assert.equal(w.state()!.tickets.T2.accept?.waived?.decision, 'deliver --no-acceptance-gate');
});

test('M3 must-PASS: a merged / dropped ticket and a ticket the state does not know draw no notice and no refusal (store-less deliver unchanged)', async (t) => {
  const w = world(t);
  const r = runFanout(['state', 'set', 'T1', '--status', 'dropped'], w.deps('r1'));
  assert.equal(r.stderr, '');
  assert.equal(acceptancePhase(undefined), 'none');
});

test('m4: a gate on an unfrozen ticket WITHOUT --cwd does not wait and then refuse — it answers pending at once and says to pass --cwd', async (t) => {
  const w = await registered(t);
  const head = w.candidate({ copy: false });
  const g = await gate(w, head, { cwd: null, waitSec: 60 });
  assert.equal(g.exit, 3, JSON.stringify(g.result));
  assert.equal(g.result.verdict, 'pending');
  assert.match(String(g.result.detail), /no --cwd/);
  assert.equal(g.polls, 0, 'did not wait');
  assert.equal(w.state()!.tickets.T1.accept?.wait, null);
});

test('m7: an implementer / verifier recorded AFTER the freeze gets the frozen status (path + command) retroactively, once, and only that recipient', async (t) => {
  const w = world(t);
  const call = runFanout(['state', 'set', 'T1', '--branch', 'impl-t1', '--spec', 'docs/spec.md#T1'], w.deps('r1')).hostCalls![0]; // no implementer / verifier yet
  await w.host(call);
  const fz = w.freeze();
  const told = await w.host(fz.hostCalls![0]);
  assert.equal(told.ok && told.op === 'frozen' && told.notified.length, 0);
  assert.equal(w.posts.length, 0);
  const late = runFanout(['state', 'set', 'T1', '--implementer', 'impl-1'], w.deps('r1'));
  assert.equal(late.hostCalls?.length, 1);
  assert.deepEqual(late.hostCalls![0].body, { op: 'frozen', run: 'r1', ticket: 'T1', to: ['impl-1'], from: 'r1' });
  const res = await w.host(late.hostCalls![0]);
  assert.equal(res.ok && res.op === 'frozen' && res.notified.join(), 'impl-1');
  assert.equal(w.posts.length, 1);
  assert.match(w.posts[0].body, /Run: node --test t\/spec\.test\.js/);
  // re-setting the same value posts nothing; a second recipient posts to that one only
  assert.equal(runFanout(['state', 'set', 'T1', '--implementer', 'impl-1'], w.deps('r1')).hostCalls, undefined);
  const v = runFanout(['state', 'set', 'T1', '--verifier', 'verif-1'], w.deps('r1'));
  await w.host(v.hostCalls![0]);
  assert.deepEqual(w.posts.map((p) => p.to), ['impl-1', 'verif-1']);
});
