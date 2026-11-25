// #604 (ledger #613 FROZEN v1) — `orchestra fanout plan`: the coordinator spawns ONE single-use plan agent (host op), the agent submits (checked at once: refused once → one more try; twice → the run does not
// start), the verb returns when a plan is accepted. Production paths: `runPlan` (CLI), `dispatchFanoutAcceptance` op `plan`, `dispatchPlan`, `submitPlan`. Mutants: scripts/e2e-fanout-plan.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runFanout, type FanoutDeps } from './fanout-state.ts';
import { runPlan } from './fanout-plan.ts';
import { blankTicket, readState, stateFile, updateState, type FanoutState } from '../shared/fanout-state.ts';
import { applyPlanText, dispatchPlan, planSidecarFile, readPlanSidecar, submitPlan, type PlanHostDeps } from '../shared/fanout-plan-host.ts';
import { renderPlanBrief } from '../shared/fanout-plan-brief.ts';
import { dispatchFanoutAcceptance, type AcceptanceHostDeps } from '../shared/fanout-acceptance-host.ts';
import type { Plan } from '../shared/fanout-plan.ts';

const NOW = '2026-11-25T10:00:00.000Z';
const RUN = 'c77b2530-198b-4dc9-bc1b-ef387ad5efdf';
const offline = () => ({ code: 1, stdout: '', stderr: 'offline' });
const goodPlan = (): Plan => ({ version: 1, tickets: [{ id: 'A', title: 'table', spec: 'ledger §A', dependsOn: [] }, { id: 'B', title: 'api', spec: 'ledger §B', dependsOn: ['A'] }], interfaces: { A: 'column `orders.status`' } });
const TICKETS = ['A', 'B'];

function mkHome(t: { after: (fn: () => void) => void }): string {
  const d = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'fanout-plan-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}
const depsOf = (home: string, ws = RUN, vouched: string | null = ws): FanoutDeps => ({ env: { ORCHESTRA_HOME: home, ORCHESTRA_WS_ID: ws, ORCHESTRA_SESSION_KEY: 'k' }, vouchedCaller: vouched, cwd: home, runner: offline, now: () => NOW, readStdin: () => '' });
function run(t: { after: (fn: () => void) => void }, sw = 'seatRecords=on'): { home: string; d: FanoutDeps } {
  const home = mkHome(t);
  const d = depsOf(home);
  assert.equal(runFanout(['state', 'init', '--run', RUN, '--switch', sw], d).code, 0);
  return { home, d };
}
const load = (home: string): FanoutState => readState(stateFile(home, RUN))!;

interface FakeHost { spawns: Array<{ from?: string; name: string; task: string; repoPath?: string }>; live: Set<string>; deps: PlanHostDeps; answer: (n: number) => { ok: boolean; id?: string; error?: string } }
function fakeHost(home: string): FakeHost {
  const f: FakeHost = { spawns: [], live: new Set(), answer: (n) => ({ ok: true, id: `plan-ws-${n}` }), deps: undefined as never };
  f.deps = {
    home, now: () => NOW,
    isWorkspace: (id) => id === RUN || f.live.has(id),
    isLive: (id) => f.live.has(id) || id === RUN,
    repoPath: () => '/repo',
    vouches: (id, key) => id === RUN && key === 'k',
    spawn: async (i) => { f.spawns.push(i); const r = f.answer(f.spawns.length); if (r.ok && r.id) f.live.add(r.id); return r; },
  };
  return f;
}
const ask = (f: FakeHost, over: Record<string, unknown> = {}) => dispatchPlan({ op: 'plan', run: RUN, from: RUN, key: 'k', tickets: TICKETS, ...over }, f.deps);

// ── the host op ────────────────────────────────────────────────────────────────────────────────────────────

test('host: spawns ONE explo-plan-<run8> agent under the coordinator, the brief rendered by code, and records who it is', async (t) => {
  const { home } = run(t);
  const f = fakeHost(home);
  const r = await ask(f);
  assert.deepEqual(r, { ok: true, op: 'plan', action: 'spawn', id: 'plan-ws-1', name: 'explo-plan-c77b2530' });
  assert.equal(f.spawns.length, 1);
  assert.equal(f.spawns[0].name, 'explo-plan-c77b2530');
  assert.equal(f.spawns[0].from, RUN);
  assert.equal(f.spawns[0].task, renderPlanBrief(TICKETS, { run: RUN }));
  const sc = readPlanSidecar(home, RUN)!;
  assert.deepEqual([sc.agent?.id, sc.spawns, sc.outcome, sc.tickets], ['plan-ws-1', 1, 'open', TICKETS]);
});

test('host: a second call while the agent lives ADOPTS it (never two); two concurrent calls spawn ONE', async (t) => {
  const { home } = run(t);
  const f = fakeHost(home);
  const [a, b] = await Promise.all([ask(f), ask(f)]);
  assert.equal(f.spawns.length, 1, 'concurrent calls spawned one agent');
  assert.deepEqual([a.ok, b.ok], [true, true]);
  const c = await ask(f);
  assert.equal(c.ok && c.action, 'adopt');
  assert.equal(f.spawns.length, 1);
});

test('host: a dead agent with no plan is replaced ONCE; a second death is [plan-agent-dead]', async (t) => {
  const { home } = run(t);
  const f = fakeHost(home);
  await ask(f);
  f.live.clear();
  const r2 = await ask(f);
  assert.equal(r2.ok && r2.action, 'respawn');
  assert.equal(f.spawns.length, 2);
  f.live.clear();
  const r3 = await ask(f);
  assert.equal(r3.ok, false);
  assert.match((r3 as { error: string }).error, /^\[plan-agent-dead\]/);
  assert.equal(f.spawns.length, 2);
});

test('host: a spawn that fails is reported, nothing stays claimed, a second call retries', async (t) => {
  const { home } = run(t);
  const f = fakeHost(home);
  f.answer = (n) => (n === 1 ? { ok: false, error: 'no display' } : { ok: true, id: 'plan-ws-2' });
  const r = await ask(f);
  assert.equal(r.ok, false);
  assert.match((r as { error: string }).error, /could not spawn the plan agent: no display/);
  assert.equal(readPlanSidecar(home, RUN)!.agent, null);
  assert.equal((await ask(f)).ok, true);
});

test('host: only the run\'s coordinator, vouched by the host, asks (must-fail arms)', async (t) => {
  const { home } = run(t);
  const f = fakeHost(home);
  for (const over of [{ from: 'someone-else' }, { key: 'wrong' }, { key: undefined }, { from: undefined }]) {
    const r = await ask(f, over);
    assert.equal(r.ok, false);
    assert.match((r as { error: string }).error, /^\[plan-caller\]/);
  }
  assert.equal(f.spawns.length, 0);
});

test('host: refused under seatRecords=off, with no tickets, and for another ticket list once asked; a run whose plan is accepted answers `accepted`', async (t) => {
  const off = run(t, 'verifier=off');
  assert.match(String((await ask(fakeHost(off.home)) as { error?: string }).error), /^\[seat-records-off\]/);
  const { home } = run(t);
  const f = fakeHost(home);
  assert.match(String((await ask(f, { tickets: [] }) as { error?: string }).error), /^\[plan-no-tickets\]/);
  await ask(f);
  assert.match(String((await ask(f, { tickets: ['A', 'B', 'C'] }) as { error?: string }).error), /^\[plan-tickets-changed\]/);
  submitPlan({ home, run: RUN, text: JSON.stringify(goodPlan()), caller: 'plan-ws-1', now: NOW });
  f.live.clear(); // the agent ended after its plan: an ended agent is not a dead one to replace
  const r = await ask(f);
  assert.equal(r.ok && r.action, 'accepted');
  assert.equal(f.spawns.length, 1);
});

test('host: a run that already spawned is refused [plan-after-spawn], no agent; a claim taken over meanwhile is [plan-claim-lost]; a corrupt record is a plain error', async (t) => {
  const { home } = run(t);
  updateState(stateFile(home, RUN), (cur) => ({ ...cur!, tickets: { A: { ...blankTicket(NOW), status: 'started' as const, implementer: 'impl-ws' } } })); // a seat is already in use
  const f = fakeHost(home);
  const r = await ask(f);
  assert.equal(r.ok, false);
  assert.match((r as { error: string }).error, /^\[plan-after-spawn\]/);
  assert.equal(f.spawns.length, 0);
  const { home: h2 } = run(t);
  const g = fakeHost(h2);
  const slow = g.deps.spawn;
  g.deps.spawn = async (i) => { // while the spawn is in flight another call takes the claim over
    const sc = readPlanSidecar(h2, RUN)!;
    fs.writeFileSync(planSidecarFile(h2, RUN), JSON.stringify({ ...sc, agent: { ...sc.agent, at: '2026-11-25T09:00:00.000Z' } }));
    return slow(i);
  };
  const lost = await ask(g);
  assert.equal(lost.ok, false);
  assert.match((lost as { error: string }).error, /^\[plan-claim-lost\]/);
  const { home: h3 } = run(t);
  fs.mkdirSync(path.dirname(planSidecarFile(h3, RUN)), { recursive: true });
  fs.writeFileSync(planSidecarFile(h3, RUN), '{ truncated');
  const bad = await ask(fakeHost(h3));
  assert.equal(bad.ok, false);
  assert.match((bad as { error: string }).error, /is not JSON/);
});

test('host route: op `plan` is dispatched by the /fanoutAcceptance route', async (t) => {
  const { home } = run(t);
  const f = fakeHost(home);
  const hostDeps: AcceptanceHostDeps = { ...f.deps, post: () => undefined };
  const r = await dispatchFanoutAcceptance({ op: 'plan', run: RUN, from: RUN, key: 'k', tickets: TICKETS }, hostDeps);
  assert.equal(r.ok && r.op, 'plan');
  assert.equal(f.spawns.length, 1);
});

// ── the submit ─────────────────────────────────────────────────────────────────────────────────────────────

async function requested(t: { after: (fn: () => void) => void }): Promise<{ home: string; f: FakeHost; submit: (text: unknown, caller?: string | null) => ReturnType<typeof runPlan> }> {
  const { home } = run(t);
  const f = fakeHost(home);
  await ask(f);
  const submit = (text: unknown, caller: string | null = 'plan-ws-1') => runPlan(['submit', '-', '--run', RUN], { ...depsOf(home, 'plan-ws-1', caller), readStdin: () => (typeof text === 'string' ? text : JSON.stringify(text)) }, async () => ({ ok: false }));
  return { home, f, submit };
}

test('submit: an accepted plan records loopPlan + the plan + the interfaces, tells the agent it is done', async (t) => {
  const { home, submit } = await requested(t);
  const r = await submit(goodPlan());
  assert.equal(r.code, 0);
  assert.match(r.stdout, /plan accepted \(2 tickets, submission 1/);
  assert.match(r.stdout, /end your session/);
  const st = load(home);
  assert.equal(st.loopPlan?.attempts, 1);
  assert.deepEqual(st.plan?.tickets, TICKETS);
  assert.equal(st.tickets.A.iface?.version, 1);
  assert.equal(readPlanSidecar(home, RUN)!.outcome, 'accepted');
});

test('submit: refused once → the reasons + one more try → accepted with attempts 2', async (t) => {
  const { home, submit } = await requested(t);
  const bad = goodPlan(); bad.interfaces.A = 'the status column';
  const r1 = await submit(bad);
  assert.equal(r1.code, 2);
  assert.match(r1.stderr, /\[plan-interface-no-name\]/);
  assert.match(r1.stderr, /ONCE more/);
  assert.equal(load(home).loopPlan, undefined);
  const r2 = await submit(goodPlan());
  assert.equal(r2.code, 0);
  assert.equal(load(home).loopPlan?.attempts, 2);
});

test('submit: refused twice → [plan-refused-twice], loopPlan NOT set, a third submission is refused too (the run does not start)', async (t) => {
  const { home, submit } = await requested(t);
  const bad = { ...goodPlan(), decisions: 'wait for A' };
  assert.equal((await submit(bad)).code, 2);
  const r2 = await submit(bad);
  assert.equal(r2.code, 2);
  assert.match(r2.stderr, /^\[plan-refused-twice\]/);
  assert.match(r2.stderr, /\[plan-free-text\]/);
  assert.equal(load(home).loopPlan, undefined);
  assert.equal(readPlanSidecar(home, RUN)!.outcome, 'refused-twice');
  const r3 = await submit(goodPlan());
  assert.equal(r3.code, 2);
  assert.match(r3.stderr, /^\[plan-refused-twice\]/);
  assert.equal(load(home).loopPlan, undefined);
});

test('submit: a plan that is not JSON is refused (counted); the reasons list ALL problems at once', async (t) => {
  const { submit } = await requested(t);
  const r = await submit('{ nope');
  assert.equal(r.code, 2);
  assert.match(r.stderr, /\[plan-bad-json\]/);
  const p = { ...goodPlan(), order: ['A', 'B'] } as Record<string, unknown>; (p.tickets as Plan['tickets']).pop(); p.interfaces = {};
  const r2 = await submit(p);
  assert.match(r2.stderr, /\[plan-free-text\][\s\S]*\[plan-ticket-missing\]/);
});

test('submit: nobody else submits — not an unvouched session, not another workspace, not before the request; nothing is counted', async (t) => {
  const { home, submit } = await requested(t);
  for (const caller of [null, 'someone-else', RUN]) {
    const r = await submit(goodPlan(), caller);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /^\[plan-caller\]/);
  }
  assert.equal(readPlanSidecar(home, RUN)!.attempts.length, 0);
  assert.equal(load(home).loopPlan, undefined);
  const sc = readPlanSidecar(home, RUN)!; // the agent's id is not recorded yet (the spawn is in flight): nobody submits
  fs.writeFileSync(planSidecarFile(home, RUN), JSON.stringify({ ...sc, agent: { ...sc.agent, id: null } }));
  const early = await submit(goodPlan());
  assert.match(early.stderr, /^\[plan-caller\]/);
  assert.equal(load(home).loopPlan, undefined);
  const { home: h2 } = run(t);
  assert.throws(() => submitPlan({ home: h2, run: RUN, text: '{}', caller: 'x', now: NOW }), /plan-not-requested/);
});

test('submit: after an accepted plan a second submission is [plan-closed]; and --run is required', async (t) => {
  const { submit, home } = await requested(t);
  await submit(goodPlan());
  const r = await submit(goodPlan());
  assert.equal(r.code, 2);
  assert.match(r.stderr, /^\[plan-closed\]/);
  const noRun = await runPlan(['submit', '-'], depsOf(home, 'plan-ws-1'), async () => ({ ok: false }));
  assert.equal(noRun.code, 1);
  assert.match(noRun.stderr, /--run <id> is required/);
});

test('submit: a plan that passes the check but cannot be recorded ENDS the step — the agent sees why, the coordinator\'s verb exits 2 [plan-apply-failed], nothing is counted as a refusal', async (t) => {
  const { home, d } = run(t);
  assert.equal(runFanout(['state', 'set', '--run', RUN, 'A', '--depends-on', 'none', '--interface', 'a different `orders.kind` column'], d).code, 0); // declared by hand BEFORE the plan, another text
  const f = fakeHost(home);
  const c = clock();
  c.onTick((n) => { if (n === 2) { try { submitPlan({ home, run: RUN, text: JSON.stringify(goodPlan()), caller: 'plan-ws-1', now: NOW }); } catch { /* the agent sees the refusal */ } } });
  const r = await runPlan(['--tickets', 'A,B'], d, hostVia(f), c);
  assert.equal(r.code, 2);
  assert.ok(c.ticks() <= 3, `the verb saw the failure at once (${c.ticks()} polls), it did not wait for a re-ask`);
  assert.match(r.stderr, /\[plan-apply-failed\][\s\S]*interface-reason-missing/);
  assert.equal(load(home).loopPlan, undefined);
  const sc = readPlanSidecar(home, RUN)!;
  assert.equal(sc.outcome, 'failed');
  assert.deepEqual(sc.attempts, []);
  assert.throws(() => submitPlan({ home, run: RUN, text: JSON.stringify(goodPlan()), caller: 'plan-ws-1', now: NOW }), /plan-apply-failed/);
  assert.match(String(((await ask(f)) as { error?: string }).error), /^\[plan-apply-failed\]/);
});

test('applyPlanText (a plan a human hands over): recorded with its own tickets, idempotent, refusals are results, a plan after the spawn is refused', (t) => {
  const { home, d } = run(t);
  const r = applyPlanText({ home, run: RUN, text: JSON.stringify(goodPlan()), now: NOW });
  assert.deepEqual([r.ok, r.ok && r.tickets], [true, 2]);
  assert.equal(load(home).loopPlan?.attempts, 1);
  assert.deepEqual(applyPlanText({ home, run: RUN, text: JSON.stringify(goodPlan()), now: '2026-11-25T11:00:00.000Z' }).ok, true); // the same plan again
  assert.equal(load(home).loopPlan?.at, NOW);
  const bad = run(t);
  const rr = applyPlanText({ home: bad.home, run: RUN, text: JSON.stringify({ ...goodPlan(), notes: 'wait' }), now: NOW });
  assert.equal(rr.ok, false);
  assert.ok(!rr.ok && rr.reasons.some((x) => x.code === 'plan-free-text'));
  assert.equal(applyPlanText({ home: bad.home, run: RUN, text: 'nope', now: NOW }).ok, false);
  assert.equal(readState(stateFile(bad.home, RUN))!.loopPlan, undefined);
  const other = run(t);
  assert.deepEqual(applyPlanText({ home: other.home, run: RUN, text: JSON.stringify(goodPlan()), ticketIds: ['A', 'B', 'C'], now: NOW }).ok, false); // C missing from the plan
  const off = run(t, 'verifier=off');
  assert.throws(() => applyPlanText({ home: off.home, run: RUN, text: JSON.stringify(goodPlan()), now: NOW }), /seat-records-off/);
  void d;
});

test('after the plan, a run decision is refused [decision-after-plan] (state set --run-decision)', async (t) => {
  const { submit, home } = await requested(t);
  await submit(goodPlan());
  const r = runFanout(['state', 'set', '--run', RUN, '--run-decision', 'wait for A to merge before B'], depsOf(home));
  assert.equal(r.code, 2);
  assert.match(r.stderr, /\[decision-after-plan\]/);
  assert.equal(load(home).decisions, undefined);
});

// ── the coordinator's verb ──────────────────────────────────────────────────────────────────────────────────

function clock(): { nowMs: () => number; sleep: (ms: number) => Promise<void>; ticks: () => number; onTick: (fn: (n: number) => void) => void } {
  let ms = 0, n = 0; let cb: (n: number) => void = () => undefined;
  return { nowMs: () => ms, sleep: async (d) => { ms += d; n++; cb(n); }, ticks: () => n, onTick: (fn) => { cb = fn; } };
}
const hostVia = (f: FakeHost) => (body: Record<string, unknown>) => dispatchFanoutAcceptance(body, { ...f.deps, post: () => undefined }) as unknown as Promise<Record<string, unknown>>;

test('plan --tickets: spawns the agent, waits, returns {"plan":"accepted"} when the agent\'s plan is accepted (exit 0)', async (t) => {
  const { home, d } = run(t);
  const f = fakeHost(home);
  const c = clock();
  c.onTick((n) => { if (n === 3) submitPlan({ home, run: RUN, text: JSON.stringify(goodPlan()), caller: 'plan-ws-1', now: NOW }); });
  const r = await runPlan(['--tickets', 'A,B'], d, hostVia(f), c);
  assert.equal(r.code, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.deepEqual([out.plan, out.attempts, out.tickets], ['accepted', 1, 2]);
  assert.equal(f.spawns.length, 1);
  assert.match(r.stderr, /spawned \(plan-ws-1\)/);
});

test('plan --tickets: refused twice → exit 2 [plan-refused-twice], the reasons, loopPlan not set', async (t) => {
  const { home, d } = run(t);
  const f = fakeHost(home);
  const c = clock();
  const bad = { ...goodPlan(), notes: 'x' };
  c.onTick((n) => { if (n === 2 || n === 3) submitPlan({ home, run: RUN, text: JSON.stringify(bad), caller: 'plan-ws-1', now: NOW }); });
  const r = await runPlan(['--tickets', 'A,B'], d, hostVia(f), c);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /\[plan-refused-twice\][\s\S]*\[plan-free-text\]/);
  assert.equal(r.stdout, '');
  assert.equal(load(home).loopPlan, undefined);
});

test('plan --tickets: a dead plan agent is replaced once (re-asked every recheck); then the plan can still land', async (t) => {
  const { home, d } = run(t);
  const f = fakeHost(home);
  const c = clock();
  c.onTick((n) => {
    if (n === 1) f.live.delete('plan-ws-1'); // dies
    if (n === 50) submitPlan({ home, run: RUN, text: JSON.stringify(goodPlan()), caller: 'plan-ws-2', now: NOW });
  });
  const r = await runPlan(['--tickets', 'A,B'], d, hostVia(f), { ...c, pollMs: 2_000, recheckMs: 45_000 });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(f.spawns.length, 2);
  assert.match(r.stderr, /the plan agent died: replaced by plan-ws-2/);
});

test('plan --tickets: a corrupt plan record while waiting is a clear error (exit 1), not a crash', async (t) => {
  const { home, d } = run(t);
  const c = clock();
  c.onTick((n) => { if (n === 1) fs.writeFileSync(planSidecarFile(home, RUN), '{ truncated'); });
  const r = await runPlan(['--tickets', 'A,B'], d, hostVia(fakeHost(home)), c);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /is not JSON/);
});

test('plan --tickets: no plan before --timeout → exit 1, nothing recorded; a live agent is adopted on the next call', async (t) => {
  const { home, d } = run(t);
  const f = fakeHost(home);
  const r = await runPlan(['--tickets', 'A,B', '--timeout', '1'], d, hostVia(f), clock());
  assert.equal(r.code, 1);
  assert.match(r.stderr, /no accepted plan after 1 min/);
  assert.equal(load(home).loopPlan, undefined);
  const again = await runPlan(['--tickets', 'A,B', '--timeout', '1'], d, hostVia(f), clock());
  assert.equal(again.code, 1);
  assert.equal(f.spawns.length, 1, 'the live agent was adopted, not duplicated');
});

test('plan --tickets: an unvouched session, another run\'s workspace, seatRecords=off and a run with a plan already — refusals / idempotence, no host call', async (t) => {
  const { home, d } = run(t);
  const never = async () => { throw new Error('the host must not be asked'); };
  const unv = await runPlan(['--tickets', 'A,B'], { ...d, vouchedCaller: null }, never);
  assert.equal(unv.code, 2);
  assert.match(unv.stderr, /^\[plan-caller\]/);
  const other = await runPlan(['--tickets', 'A,B'], { ...d, vouchedCaller: 'other' }, never);
  assert.match(other.stderr, /^\[plan-caller\]/);
  const off = run(t, 'verifier=off');
  assert.match((await runPlan(['--tickets', 'A,B'], off.d, never)).stderr, /^\[seat-records-off\]/);
  const f = fakeHost(home);
  await ask(f);
  submitPlan({ home, run: RUN, text: JSON.stringify(goodPlan()), caller: 'plan-ws-1', now: NOW });
  const done = await runPlan(['--tickets', 'A,B'], d, never);
  assert.equal(done.code, 0);
  assert.equal(JSON.parse(done.stdout).plan, 'accepted');
});

test('plan --tickets --print renders the brief and spawns nothing; --help; no --tickets', async (t) => {
  const { d } = run(t);
  const never = async () => { throw new Error('the host must not be asked'); };
  const p = await runPlan(['--tickets', 'A,B', '--print'], { ...d, vouchedCaller: null }, never);
  assert.equal(p.code, 0);
  assert.equal(p.stdout, `${renderPlanBrief(TICKETS, { run: RUN })}\n`);
  assert.match((await runPlan(['--help'], d, never)).stdout, /plan-refused-twice/);
  assert.equal((await runPlan([], d, never)).code, 1);
  assert.equal(fs.existsSync(planSidecarFile(d.env.ORCHESTRA_HOME!, RUN)), false);
});
