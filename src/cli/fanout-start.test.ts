// #587 PR B (ledger #591 I6) — `orchestra fanout start`: the implementers of the plan are launched by code, the brief rendered from the state, a hand spawn refused. Production paths: `runStart` (CLI),
// `dispatchFanoutAcceptance` op `start` (host), `startRun`, `handSpawnRefusalFor`. Mutants: scripts/e2e-fanout-start.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runFanout, type FanoutDeps } from './fanout-state.ts';
import { runStart } from './fanout-start.ts';
import { SeatRefusal, readState, stateFile, parseState, type FanoutState } from '../shared/fanout-state.ts';
import { briefHash } from '../shared/fanout-brief-common.ts';
import { IMPLEMENTER_RULES, renderImplementerBrief } from '../shared/fanout-implementer-brief.ts';
import { handSpawnRefusal, handSpawnRefusalFor, implementerName, startRun, type StartDeps } from '../shared/fanout-start.ts';
import { dispatchFanoutAcceptance, type AcceptanceHostDeps } from '../shared/fanout-acceptance-host.ts';

const NOW = '2026-11-25T10:00:00.000Z';
const offline = () => ({ code: 1, stdout: '', stderr: 'offline' });
function mkHome(t: { after: (fn: () => void) => void }): string {
  const d = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'fanout-start-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}
const mkDeps = (home: string, ws = 'r1'): FanoutDeps => ({ env: { ORCHESTRA_HOME: home, ORCHESTRA_WS_ID: ws }, vouchedCaller: ws, cwd: home, runner: offline, now: () => NOW, readStdin: () => '' });
const sh = (d: FanoutDeps, ...a: string[]) => runFanout(['state', ...a], d);
const set = (d: FanoutDeps, ...a: string[]) => sh(d, 'set', '--run', 'r1', ...a);
const load = (d: FanoutDeps): FanoutState => readState(stateFile(d.env.ORCHESTRA_HOME!, 'r1'))!;

/** A run (switch on) with plan A,B,C: B depends on A (A holds an interface), C is independent; one decision; nothing spawned. */
function planned(t: { after: (fn: () => void) => void }, sw = 'seatRecords=on'): FanoutDeps {
  const d = mkDeps(mkHome(t));
  assert.equal(sh(d, 'init', '--run', 'r1', '--switch', sw).code, 0);
  if (sw.includes('seatRecords=on')) {
    set(d, '--plan', 'A,B,C');
    set(d, 'A', '--depends-on', 'none'); set(d, 'B', '--depends-on', 'A'); set(d, 'C', '--depends-on', 'none');
    set(d, 'A', '--interface', 'table t(id, name)');
    set(d, '--run-decision', 'Money is integer cents.');
    for (const id of ['A', 'B', 'C']) set(d, id, '--spec', `ledger #1 §${id}`);
  }
  return d;
}
interface Fake { calls: Array<{ from: string; name: string; task: string; repoPath?: string; baseBranch?: string }>; live: Set<string>; deps: StartDeps; answer: (name: string, n: number) => ReturnType<StartDeps['spawn']> }
function fake(d: FanoutDeps): Fake {
  const f: Fake = { calls: [], live: new Set(), answer: async (name, n) => ({ ok: true, id: `ws-${name}-${n}`, branch: `${name}-${n}` }), deps: undefined as never };
  f.deps = {
    home: d.env.ORCHESTRA_HOME!, now: () => NOW,
    implementerLive: (id) => f.live.has(id),
    repoPath: () => '/repo',
    spawn: async (i) => { f.calls.push(i); let r = await f.answer(i.name, f.calls.length); if (r.ok && i.reuseBranch) r = { ...r, branch: i.name }; /* the host puts the worktree ON the named branch (git-reuse-branch.test.ts) */ if (r.ok && r.id) f.live.add(r.id); return r; },
  };
  return f;
}

// ── the brief ─────────────────────────────────────────────────────────────────────────────────────────────

test('brief: ticket, spec, own interface, the interfaces it builds on WITH versions, base, decisions, switches, rules — deterministic', (t) => {
  const d = planned(t);
  set(d, 'A', '--interface', 'table t(id, name, age)', '--interface-reason', 'age needed');
  const b = renderImplementerBrief({ state: load(d), ticket: 'B' });
  assert.match(b, /implementer of ticket B in run r1/);
  assert.match(b, /Depends on: A\./);
  assert.match(b, /Branch base: origin\/master\./);
  assert.match(b, /### A — interface v2 \(changes: v1→v2: age needed\)\ntable t\(id, name, age\)/);
  assert.match(b, /Interface you provide: none/);
  assert.match(b, /Decisions of the run \(binding, verbatim — recorded by the coordinator\):\n1\. Money is integer cents\./);
  assert.match(b, /Switches of this run: .*seatRecords=on/);
  assert.ok(b.endsWith(IMPLEMENTER_RULES));
  assert.match(IMPLEMENTER_RULES, /never change an interface yourself/);
  assert.match(IMPLEMENTER_RULES, /VERSION of each interface you built on \(e\.g\. `follows A=2`\)/);
  const a = renderImplementerBrief({ state: load(d), ticket: 'A' });
  assert.match(a, /Interface you PROVIDE \(frozen, v2\):\ntable t\(id, name, age\)/);
  assert.match(a, /Spec: ledger #1 §A/);
  assert.equal(renderImplementerBrief({ state: load(d), ticket: 'B' }), b, 'deterministic');
  assert.match(renderImplementerBrief({ state: load(d), ticket: 'B', continueFrom: { branch: 'impl-b', head: 'a'.repeat(40) } }), /Continue the work of the agent that died: you are ON its branch impl-b \(last recorded head aaaaaaaaaaaa\), same name, same PR/);
  assert.throws(() => renderImplementerBrief({ state: load(d), ticket: 'Z' }), /not in the state/);
});

// ── start: refusals ───────────────────────────────────────────────────────────────────────────────────────

test('start must-FAIL: off → [start-off]; not the coordinator → [start-caller]; plan incomplete → [plan-incomplete] naming it; nothing spawned', async (t) => {
  const f0 = fake(planned(t, 'earlyGate=on'));
  const host = async () => { throw new Error('the host must not be asked'); };
  const off = planned(t, 'earlyGate=on');
  let r = await runStart(['--run', 'r1'], off, host);
  assert.equal(r.code, 2); assert.ok(r.stderr.startsWith('[start-off] '), r.stderr);
  const d = planned(t);
  r = await runStart(['--run', 'r1'], { ...d, vouchedCaller: 'impl-x' }, host);
  assert.equal(r.code, 2); assert.ok(r.stderr.startsWith('[start-caller] '), r.stderr);
  r = await runStart(['--run', 'r1'], { ...d, vouchedCaller: null }, host); // ORCHESTRA_WS_ID=r1 is in the env, the host did NOT vouch it
  assert.ok(r.stderr.startsWith('[start-caller] ') && /could not vouch/.test(r.stderr));
  r = await runStart(['--run', 'r1'], { ...d, vouchedCaller: undefined }, host);
  assert.ok(r.stderr.startsWith('[start-caller] '));
  set(d, '--plan-add', 'D');
  r = await runStart(['--run', 'r1'], d, host);
  assert.equal(r.code, 2); assert.ok(r.stderr.startsWith('[plan-incomplete] '), r.stderr);
  assert.match(r.stderr, /D: in the plan but not in the state/);
  await assert.rejects(() => startRun('r1', 'r1', f0.deps), /start-off|\[start-off\]/);
  await assert.rejects(() => startRun('r1', 'nope', fake(d).deps), /\[start-caller\]/);
});

test('start: NO flag takes free text; a positional is refused; --help prints the usage', async (t) => {
  const d = planned(t);
  const host = async () => ({ ok: true, result: { started: [], respawned: [], waiting: [], skipped: [], failed: [] } });
  for (const bad of [['--task', 'do it'], ['--brief', 'x'], ['--name', 'impl-x'], ['A']]) {
    const r = await runStart(bad, d, host);
    assert.equal(r.code, 1, bad.join(' '));
    assert.match(r.stderr, /unknown flag|unexpected argument/);
  }
  assert.match((await runStart(['--help'], d, host)).stdout, /usage: orchestra fanout start/);
});

// ── start: the launch ─────────────────────────────────────────────────────────────────────────────────────

test('start: one implementer per plan ticket (a dependent WITH the others), the brief rendered by code, state records implementer/branch/started/start{hash}', async (t) => {
  const d = planned(t);
  const f = fake(d);
  const r = await startRun('r1', 'r1', f.deps);
  assert.deepEqual(r.started.map((s) => s.ticket), ['A', 'B', 'C']);
  assert.deepEqual(r.respawned, []); assert.deepEqual(r.waiting, []); assert.deepEqual(r.skipped, []); assert.deepEqual(r.failed, []);
  assert.deepEqual(f.calls.map((c) => c.name), ['impl-A', 'impl-B', 'impl-C']);
  assert.ok(f.calls.every((c) => c.from === 'r1' && c.repoPath === '/repo' && c.baseBranch === 'master'), 'the worktree is cut from the run target the brief names');
  const s = load(d);
  for (const [i, id] of ['A', 'B', 'C'].entries()) {
    const tk = s.tickets[id];
    assert.equal(tk.status, 'started');
    assert.equal(tk.implementer, r.started[i].ws);
    assert.equal(tk.branch, r.started[i].branch);
    assert.deepEqual(tk.start, { at: NOW, kind: 'spawn', briefHash: briefHash(f.calls[i].task), briefs: 1 });
  }
  assert.match(f.calls[1].task, /### A — interface v1\ntable t\(id, name\)/, 'B is told the interface it builds on');
  assert.match(f.calls[1].task, /Money is integer cents\./);
  assert.ok(s.switchesFrozen || Object.keys(s.switches ?? {}).length, 'the first spawn froze the switches');
  assert.equal(parseState(JSON.parse(JSON.stringify(s))).tickets.A.start?.briefs, 1, 'the stored start round-trips');
});

test('start must-FAIL: a second call never starts a second agent for a ticket with a live one; concurrent calls spawn one each', async (t) => {
  const d = planned(t);
  const f = fake(d);
  await startRun('r1', 'r1', f.deps);
  const again = await startRun('r1', 'r1', f.deps);
  assert.deepEqual(again.skipped.map((x) => [x.ticket, x.reason]), [['A', 'live'], ['B', 'live'], ['C', 'live']]);
  assert.equal(f.calls.length, 3);
  const d2 = planned(t);
  const f2 = fake(d2);
  await Promise.all([startRun('r1', 'r1', f2.deps), startRun('r1', 'r1', f2.deps)]);
  assert.equal(f2.calls.length, 3, 'two concurrent starts = one agent per ticket');
});

test('start: a dead implementer is respawned FROM ITS BRANCH (kind respawn, briefs 2); merged / nominated tickets are skipped with their status', async (t) => {
  const d = planned(t);
  const f = fake(d);
  await startRun('r1', 'r1', f.deps);
  set(d, 'B', '--pr', '12', '--head', 'a'.repeat(40));
  const before = load(d).tickets.B;
  f.live.delete(before.implementer!);
  set(d, 'C', '--status', 'merged');
  const r = await startRun('r1', 'r1', f.deps);
  assert.deepEqual(r.respawned.map((x) => x.ticket), ['B']);
  assert.deepEqual(r.started, []);
  assert.deepEqual(r.skipped.map((x) => [x.ticket, x.reason]), [['A', 'live'], ['C', 'merged']]);
  const last = f.calls.at(-1)!;
  assert.equal(last.name, before.branch, 'the respawn is asked for the ticket\'s EXISTING branch by name');
  assert.equal(last.reuseBranch, true);
  assert.equal(last.baseBranch, 'master', 'the diff / merge base stays the run target, not the dead branch');
  assert.match(last.task, /you are ON its branch .*, same name, same PR/);
  const b = load(d).tickets.B;
  assert.equal(b.start!.kind, 'respawn'); assert.equal(b.start!.briefs, 2);
  assert.notEqual(b.implementer, before.implementer);
  assert.equal(b.branch, before.branch, 'the branch name is UNCHANGED');
  assert.equal(b.pr, 12); assert.equal(b.head, 'a'.repeat(40), 'pr and head still describe the branch');
});

test('start: a start held by Admission is a WAIT (exit 0, listed, the agent recorded); a failed spawn is listed and retried by the next call; a kept child is recorded, never duplicated', async (t) => {
  const d = planned(t);
  const f = fake(d);
  f.answer = async (name, n) => name === 'impl-A' ? { ok: true, id: 'wsA', branch: 'impl-A', held: { since: 1 } } : name === 'impl-B' ? { ok: false, error: 'no room' } : name === 'impl-C' ? { ok: false, id: 'wsC', branch: 'impl-C', error: 'first turn failed' } : { ok: true, id: `x${n}`, branch: `b${n}` };
  const r = await startRun('r1', 'r1', f.deps);
  assert.deepEqual(r.started, [], 'a held start is a WAIT, listed once: not also in started');
  assert.equal(r.waiting.length, 1); assert.equal(r.waiting[0].ticket, 'A'); assert.match(r.waiting[0].why, /Admission/);
  assert.deepEqual(r.failed.map((x) => x.ticket), ['B', 'C']);
  assert.match(r.failed[1].error, /kept and is recorded as the implementer: restart it/);
  let s = load(d);
  assert.equal(s.tickets.A.implementer, 'wsA');
  assert.equal(s.tickets.B.status, 'todo', 'a failed spawn changes nothing');
  assert.equal(s.tickets.B.implementer, null);
  assert.equal(s.tickets.C.implementer, 'wsC', 'a kept child is recorded');
  f.live.add('wsA'); f.live.add('wsC');
  f.answer = async (name, n) => ({ ok: true, id: `r${n}`, branch: `r-${name}` });
  const again = await startRun('r1', 'r1', f.deps);
  assert.deepEqual(again.started.map((x) => x.ticket), ['B'], 'the second call starts the rest');
  assert.deepEqual(again.skipped.map((x) => x.ticket), ['A', 'C']);
  s = load(d);
  assert.equal(s.tickets.B.implementer, 'r4');
});

test('start via the CLI: prints the result JSON (exit 0), "failed" non-empty exits 2, a host refusal [name] keeps its name and exit 2', async (t) => {
  const d = planned(t);
  const ok = { started: [{ ticket: 'A', ws: 'w', branch: 'b' }], respawned: [], waiting: [], skipped: [], failed: [] };
  let seen: Record<string, unknown> = {};
  let r = await runStart(['--run', 'r1'], d, async (body) => { seen = body; return { ok: true, op: 'start', result: ok }; });
  assert.equal(r.code, 0);
  assert.deepEqual(JSON.parse(r.stdout), ok);
  assert.deepEqual(seen, { op: 'start', run: 'r1', from: 'r1', key: undefined });
  const keyed = await runStart(['--run', 'r1'], { ...d, env: { ...d.env, ORCHESTRA_SESSION_KEY: ' k-1 ' } }, async (body) => { seen = body; return { ok: true, result: ok }; });
  assert.equal(keyed.code, 0);
  assert.equal(seen.key, 'k-1', 'the host verifies the key itself'); 
  r = await runStart(['--run', 'r1'], d, async () => ({ ok: true, result: { ...ok, failed: [{ ticket: 'B', error: 'no room' }] } }));
  assert.equal(r.code, 2); assert.match(r.stderr, /B \(no room\)/); assert.equal(JSON.parse(r.stdout).failed.length, 1);
  r = await runStart(['--run', 'r1'], d, async () => ({ ok: false, error: '[plan-incomplete] the host saw more missing' }));
  assert.equal(r.code, 2); assert.equal(r.stderr, '[plan-incomplete] the host saw more missing\n');
  r = await runStart(['--run', 'r1'], d, async () => ({ ok: false, error: 'host down' }));
  assert.equal(r.code, 1);
});

test('host op `start`: refused when the host has no implementer wiring; with it, the same result as startRun; `start` is not settable by `state set`', async (t) => {
  const d = planned(t);
  const f = fake(d);
  const base = { home: f.deps.home, now: f.deps.now, isWorkspace: () => true, repoPath: () => '/repo', spawn: async () => ({ ok: false }), post: () => {}, vouches: (id: string, key: string | undefined) => id === 'r1' && key === 'k-r1' } as unknown as AcceptanceHostDeps;
  const no = await dispatchFanoutAcceptance({ op: 'start', run: 'r1', from: 'r1', key: 'k-r1' }, base);
  assert.ok(!no.ok && /not wired/.test(no.error));
  const yes = await dispatchFanoutAcceptance({ op: 'start', run: 'r1', from: 'r1', key: 'k-r1' }, { ...base, implementerLive: f.deps.implementerLive, spawnImplementer: f.deps.spawn });
  assert.ok(yes.ok && yes.op === 'start' && yes.result.started.length === 3);
  const wired = { ...base, implementerLive: f.deps.implementerLive, spawnImplementer: f.deps.spawn };
  for (const input of [{ from: 'someone', key: 'k-r1' }, { from: 'r1', key: 'wrong' }, { from: 'r1' }]) { // env-asserted: the id is right, the host does not vouch it
    const refused = await dispatchFanoutAcceptance({ op: 'start', run: 'r1', ...input }, wired);
    assert.ok(!refused.ok && refused.error.startsWith('[start-caller]'), JSON.stringify(input));
  }
  const unwired = await dispatchFanoutAcceptance({ op: 'start', run: 'r1', from: 'r1', key: 'k-r1' }, { ...wired, vouches: undefined });
  assert.ok(!unwired.ok && unwired.error.startsWith('[start-caller]'), 'a host that cannot vouch refuses');
  const bad = set(d, 'A', '--json', JSON.stringify({ start: { at: NOW, kind: 'spawn', briefHash: 'a'.repeat(64), briefs: 1 } }));
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /unknown field "start"/);
});

// ── the hand-spawn refusal ────────────────────────────────────────────────────────────────────────────────

test('hand spawn: an impl- spawn by the coordinator of a seatRecords=on run is refused (names `orchestra fanout start`); other names, the off switch, no state, `start` itself and a non-coordinator are untouched', (t) => {
  const d = planned(t);
  const home = d.env.ORCHESTRA_HOME!;
  const refusal = handSpawnRefusalFor(home, 'r1', 'impl-politique-12', false);
  assert.match(refusal ?? '', /orchestra fanout start/);
  assert.match(refusal ?? '', /Nothing was created/);
  assert.equal(handSpawnRefusalFor(home, 'r1', 'impl-politique-12', true), null, 'fanout start itself');
  for (const n of ['review-x', 'verif-x', 'explo-x', 'scribe-x', 'accept-x', 'ops-x']) assert.equal(handSpawnRefusalFor(home, 'r1', n, false), null, n);
  assert.equal(handSpawnRefusalFor(home, 'someone-else', 'impl-x', false), null, 'a caller that owns no state');
  assert.equal(handSpawnRefusalFor(home, undefined, 'impl-x', false), null, 'a human at a terminal (no from)');
  const off = planned(t, 'earlyGate=on');
  assert.equal(handSpawnRefusalFor(off.env.ORCHESTRA_HOME!, 'r1', 'impl-x', false), null, 'seatRecords=off: byte-identical');
  assert.equal(handSpawnRefusalFor(path.join(home, 'nowhere'), 'r1', 'impl-x', false), null, 'no state');
  assert.equal(handSpawnRefusal({ name: 'impl-x', state: null, viaStart: false }), null);
  fs.writeFileSync(stateFile(home, 'r1'), '{not json');
  assert.equal(handSpawnRefusalFor(home, 'r1', 'impl-x', false), null, 'an unreadable state never refuses a spawn');
  assert.equal(implementerName('NMC 360'), 'impl-NMC-360');
});

test('start: only the PLAN is launched (a ticket in the state but not in the plan is not); a spawn that THROWS is listed; a state write that cannot be recorded is listed, not started', async (t) => {
  const d = planned(t);
  set(d, 'Z', '--depends-on', 'none');
  const f = fake(d);
  const r = await startRun('r1', 'r1', f.deps);
  assert.deepEqual(r.started.map((x) => x.ticket), ['A', 'B', 'C']);
  assert.equal(load(d).tickets.Z.status, 'todo');
  const d2 = planned(t);
  const f2 = fake(d2);
  f2.answer = async (name) => { if (name === 'impl-A') throw new Error('socket closed'); return { ok: true, id: `w-${name}`, branch: name }; };
  const r2 = await startRun('r1', 'r1', f2.deps);
  assert.deepEqual(r2.failed, [{ ticket: 'A', error: 'socket closed' }]);
  assert.deepEqual(r2.started.map((x) => x.ticket), ['B', 'C'], 'one ticket failing does not stop the others');
  const d3 = planned(t);
  const f3 = fake(d3);
  f3.answer = async (name) => { if (name === 'impl-C') fs.rmSync(stateFile(d3.env.ORCHESTRA_HOME!, 'r1')); return { ok: true, id: `w-${name}`, branch: name }; };
  const r3 = await startRun('r1', 'r1', f3.deps);
  assert.deepEqual(r3.started.map((x) => x.ticket), ['A', 'B']);
  assert.equal(r3.failed.length, 1);
  assert.match(r3.failed[0].error, /spawned w-impl-C but could not record it/);
});

test('hand spawn (the pure rule): fanout start is never refused; only the implementer role is', (t) => {
  const state = load(planned(t));
  assert.equal(handSpawnRefusal({ name: 'impl-x', state, viaStart: true }), null);
  assert.notEqual(handSpawnRefusal({ name: 'impl-x', state, viaStart: false }), null);
  for (const n of ['review-x', 'verif-x', 'explo-x', 'scribe-x', 'accept-x', 'ops-x', 'plain']) assert.equal(handSpawnRefusal({ name: n, state, viaStart: false }), null, n);
});

test('a stored start is validated: bad kind, 0 briefs, a non-sha hash, an unknown field are refused', (t) => {
  const d = planned(t);
  const f = fake(d);
  return startRun('r1', 'r1', f.deps).then(() => {
    const good = JSON.parse(JSON.stringify(load(d)));
    const bad = (mut: (s: any) => void): void => { const j = JSON.parse(JSON.stringify(good)); mut(j); assert.throws(() => parseState(j)); };
    bad((j) => { j.tickets.A.start.kind = 'restart'; });
    bad((j) => { j.tickets.A.start.briefs = 0; });
    bad((j) => { j.tickets.A.start.briefHash = 'xyz'; });
    bad((j) => { j.tickets.A.start.extra = 1; });
    bad((j) => { j.tickets.A.start.at = 'yesterday'; });
  });
});

test('start: a live child of the run already named for the ticket but NOT recorded (the state write was lost) is ADOPTED, never duplicated', async (t) => {
  const d = planned(t);
  const f = fake(d);
  const lost = { id: 'ws-lost', branch: 'impl-A-3' };
  f.deps.orphanImplementer = ({ ticket, name, recorded }) => { assert.equal(name, implementerName(ticket)); return ticket === 'A' && !recorded.includes(lost.id) ? lost : null; };
  const r = await startRun('r1', 'r1', f.deps);
  assert.deepEqual(f.calls.map((c) => c.name), ['impl-B', 'impl-C'], 'A is not spawned a second time');
  assert.deepEqual(r.skipped, [{ ticket: 'A', reason: 'live' }]);
  assert.equal(load(d).tickets.A.implementer, 'ws-lost');
  assert.equal(load(d).tickets.A.branch, 'impl-A-3');
  assert.equal(load(d).tickets.A.status, 'started');
  f.live.add('ws-lost');
  f.deps.orphanImplementer = ({ recorded }) => (recorded.includes(lost.id) ? null : lost);
  const again = await startRun('r1', 'r1', f.deps);
  assert.equal(f.calls.length, 2, 'a second call spawns nothing');
  assert.ok(again.skipped.every((x) => x.reason === 'live'));
});

test('start: a ticket set `started` by hand with no implementer is a first SPAWN from the target (not a respawn)', async (t) => {
  const d = planned(t);
  set(d, 'A', '--status', 'started', '--branch', 'feature-x');
  const f = fake(d);
  const r = await startRun('r1', 'r1', f.deps);
  assert.deepEqual(r.started.map((x) => x.ticket), ['A', 'B', 'C']);
  assert.deepEqual(r.respawned, []);
  assert.equal(f.calls[0].baseBranch, 'master');
  assert.equal(load(d).tickets.A.start!.kind, 'spawn');
});

test('start: the orphan scan is told which implementers the state records (a recorded dead one is respawned, never "adopted")', async (t) => {
  const d = planned(t);
  const f = fake(d);
  await startRun('r1', 'r1', f.deps);
  const old = load(d).tickets.A.implementer!;
  f.live.delete(old);
  const seen: string[][] = [];
  f.deps.orphanImplementer = ({ ticket, recorded }) => { seen.push(recorded); return ticket === 'A' && !recorded.includes(old) ? { id: old, branch: 'x' } : null; };
  const r = await startRun('r1', 'r1', f.deps);
  assert.deepEqual(r.respawned.map((x) => x.ticket), ['A']);
  assert.ok(seen[0].includes(old) && seen[0].length === 3, 'every recorded implementer id is passed');
});

test('start must-FAIL: a plan ticket with no spec and no text is REFUSED naming it — nothing spawned, never an empty task; a ticket that already has its agent is not asked', async (t) => {
  const d = planned(t);
  const bare = mkDeps(mkHome(t));
  sh(bare, 'init', '--run', 'r1', '--switch', 'seatRecords=on');
  set(bare, '--plan', 'A,B,C');
  for (const id of ['A', 'B', 'C']) set(bare, id, '--depends-on', 'none');
  set(bare, 'A', '--spec', 'ledger #1');
  const f = fake(bare);
  await assert.rejects(() => startRun('r1', 'r1', f.deps), (e: unknown) => e instanceof SeatRefusal && e.refusal === 'start-no-spec' && /\bB, C\b/.test(e.message) && !/\bA\b/.test(e.message.split('—')[1] ?? ''));
  assert.equal(f.calls.length, 0, 'nothing spawned');
  const r = await runStart(['--run', 'r1'], bare, async () => { throw new Error('the host must not be asked'); });
  assert.equal(r.code, 2); assert.ok(r.stderr.startsWith('[start-no-spec] '), r.stderr); assert.match(r.stderr, /--spec <file\|url\|ledger section>/);
  set(bare, 'B', '--spec', 'ledger #2');
  const r2 = await runStart(['--run', 'r1'], bare, async () => { throw new Error('x'); });
  assert.match(r2.stderr, /\bC\b/); assert.ok(!/\bB\b/.test(r2.stderr.split('—')[1] ?? ''));
  set(bare, 'C', '--spec', 'ledger #3');
  assert.equal((await startRun('r1', 'r1', fake(bare).deps)).started.length, 3);
  // a ticket already running (recorded implementer) without a spec is not what this guards
  const f2 = fake(d);
  await startRun('r1', 'r1', f2.deps);
  const file = stateFile(d.env.ORCHESTRA_HOME!, 'r1');
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  delete raw.tickets.A.spec; delete raw.tickets.A.specText; fs.writeFileSync(file, JSON.stringify(raw));
  assert.equal((await startRun('r1', 'r1', f2.deps)).skipped.length, 3, 'a running ticket whose spec was cleared is skipped, not refused');
});

test('start --help prints the usage (rc 0) and names the empty-task refusal, the branch rule and the human-terminal limit', async (t) => {
  const d = planned(t);
  const r = await runStart(['--help'], { ...d, vouchedCaller: null }, async () => { throw new Error('no host'); });
  assert.equal(r.code, 0);
  assert.match(r.stdout, /no spec and no text is refused \(\[start-no-spec\], listing them\)/);
  assert.match(r.stdout, /A respawn keeps the ticket's branch/);
  assert.match(r.stdout, /Limit: it is the coordinator's door, not a lock — a human at a terminal .* can still hand-spawn/);
});
