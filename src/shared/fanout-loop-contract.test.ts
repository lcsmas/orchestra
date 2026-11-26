// #614 (spec #601, ledger #613) — the CONTRACT of the three ports of the Boucle, run against BOTH implementations: the dummy world (fanout-loop-dummy.ts) and the live ports (fanout-loop-live-*.ts) over a world they can be driven on
// (real git in a temp repo + a bare remote; a fake `gh` speaking the real binary's shapes; the dummy fleet behind a fake `orchestra` CLI + host). The arms are written ONCE against a small harness; each harness runs the same list.
// Every arm that matters also has its MUST-FAIL twin: the same arm run on a deliberately broken port must throw (an arm that cannot fail proves nothing). Differences that are real (the dummy drains its mailbox, the live bus replays an
// unacked lot; only the live forge refuses through `deliver`) are asserted in the live-only block at the end, named as such.
// LIMIT, stated: the live FleetPort arms run behind a FAKE `orchestra` CLI that delegates `fanout start` / `fanout review` to the dummy's real `startRun` / reviewer host path — they prove the port's parsing, argv and ack protocol, not that the shipped
// verbs hold "never two implementers" (the dummy and the verbs share `startRun`; the mail protocol is run on the REAL bus in src/cli/fanout-loop-live-bus.test.ts).
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FleetPort, ForgePort, GitPort } from './fanout-loop-ports.ts';
import { buildDummy, planOf, type Dummy, type Scenario } from './fanout-loop-dummy.ts';
import { createLiveGit, type ExecResult } from './fanout-loop-live-git.ts';
import { createLiveForge } from './fanout-loop-live-forge.ts';
import { createLiveFleet, verbError, type Cli, type Host } from './fanout-loop-live-fleet.ts';
import { CHECKS, FakeForge } from './fanout-loop-live-fake-gh.ts';
import { fakeBus } from './fanout-loop-live-fake-bus.ts';
import { FIXED_ANSWER } from './fanout-loop.ts';
import { SeatRefusal, applyTicketPatch, newState, readState, setPlan, stateFile, updateState } from './fanout-state.ts';

const made: string[] = [];
const tmp = (): string => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'fanout-contract-')); made.push(d); return d; };
after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });
const NOW = '2026-01-01T00:00:00.000Z';
const sha40 = (): string => crypto.randomBytes(20).toString('hex');
/** The arm must fail on a port broken in ONE rule, and by the assertion that names THAT rule (`[rule]` in its message): a twin that fails for any other reason proves nothing about this rule. */
async function mustFail<T>(rule: string, h: T, arm: (h: T) => Promise<void>): Promise<void> {
  let msg: string | null = null;
  try { await arm(h); } catch (e) { msg = e instanceof Error ? e.message : String(e); }
  assert.ok(msg !== null, `[${rule}] the arm did NOT fail on the port broken in that rule — it cannot tell a broken port from a good one`);
  assert.ok(msg!.includes(`[${rule}]`), `[${rule}] the arm failed, but not on this rule: ${msg!.slice(0, 200)}`);
}

// ════════════════════════════════════════ GitPort ════════════════════════════════════════
interface GitH { name: string; port: GitPort; /** a commit on `branch` (created from main when new) */ commit(branch: string): string; /** a merge commit on `into` that contains `other` */ merge(into: string, other: string): string }

function dummyGit(): GitH {
  const d = buildDummy({ home: tmp(), run: 'g', scenario: { version: 1, repo: { tickets: [{ id: 'T1', dependsOn: [], spec: 's' }] } } });
  const w = d.world;
  let n = 0;
  return {
    name: 'dummy', port: d.git,
    commit: (b) => { const c = w.commit([w.branches.get(b) ?? w.branches.get('main')!], `c${n++}`, `t${n}`); w.branches.set(b, c); return c; },
    merge: (into, other) => { const c = w.commit([w.branches.get(into)!, w.branches.get(other)!], `m${n++}`, `m${n}`); w.branches.set(into, c); return c; },
  };
}
function liveGit(): GitH {
  const root = tmp();
  const bare = path.join(root, 'remote.git');
  const work = path.join(root, 'work');
  const sh = (cwd: string, ...args: string[]): string => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'init.defaultBranch=main', ...args], { cwd, encoding: 'utf8' }).trim();
  fs.mkdirSync(bare); sh(bare, 'init', '--bare', '--quiet');
  fs.mkdirSync(work); sh(work, 'init', '--quiet'); sh(work, 'remote', 'add', 'origin', bare);
  fs.writeFileSync(path.join(work, 'f0'), 'root\n'); sh(work, 'add', '.'); sh(work, 'commit', '--quiet', '-m', 'root'); sh(work, 'push', '--quiet', 'origin', 'main');
  let n = 0;
  const run = (args: string[]): Promise<ExecResult> => { const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: work, encoding: 'utf8' }); return Promise.resolve({ code: r.status ?? 1, stdout: r.stdout, stderr: r.stderr }); };
  return {
    name: 'live', port: createLiveGit({ git: run }),
    commit: (b) => { const exists = sh(work, 'branch', '--list', b); sh(work, 'switch', '--quiet', ...(exists ? [b] : ['-c', b, 'main'])); fs.writeFileSync(path.join(work, `f${++n}`), `${n}\n`); sh(work, 'add', '.'); sh(work, 'commit', '--quiet', '-m', `c${n}`); return sh(work, 'rev-parse', 'HEAD'); },
    merge: (into, other) => { sh(work, 'switch', '--quiet', into); sh(work, 'merge', '--quiet', '--no-ff', '-m', `m${++n}`, other); return sh(work, 'rev-parse', 'HEAD'); },
  };
}

const gitArms: Array<[string, (h: GitH) => Promise<void>]> = [
  ['head: the branch\'s newest commit; moves with a commit; an unknown branch is null (never main\'s head)', async (h) => {
    const c1 = h.commit('b1');
    assert.equal(await h.port.head('b1'), c1);
    const c2 = h.commit('b1');
    assert.equal(await h.port.head('b1'), c2, '[head.moves]');
    assert.equal(await h.port.head('no-such-branch'), null, '[head.unknown]');
  }],
  ['tree: a hex tree for a known commit, different for a different content, null for an unknown sha', async (h) => {
    const a = h.commit('t1'), b = h.commit('t1');
    const ta = await h.port.tree(a), tb = await h.port.tree(b);
    assert.match(String(ta), /^[0-9a-f]{40}$/, '[tree.hex]');
    assert.notEqual(ta, tb, '[tree.differs]');
    assert.equal(await h.port.tree(sha40()), null, '[tree.unknown]');
  }],
  ['isMerged: an ancestor is merged, a sibling is not, an unknown sha is not, a commit contains itself', async (h) => {
    const up = h.commit('up');
    h.commit('dep');
    assert.equal(await h.port.isMerged(up, 'dep'), false, '[merged.unconnected] not yet connected');
    h.merge('dep', 'up');
    assert.equal(await h.port.isMerged(up, 'dep'), true, '[merged.connected] connected by a merge commit');
    assert.equal(await h.port.isMerged('dep', 'up'), false, '[merged.reverse] the other way round is not');
    assert.equal(await h.port.isMerged(sha40(), 'dep'), false, '[merged.unknown]');
    assert.equal(await h.port.isMerged(up, up), true, '[merged.self]');
  }],
  ['emptyBranch: a branch holding nothing over its base, idempotent; deleteBranch removes it and a missing one is fine', async (h) => {
    const mainHead = (await h.port.head('main'))!;
    const e = await h.port.emptyBranch('orchestra-start-check-1', 'main');
    assert.equal(await h.port.tree(e.head), await h.port.tree(mainHead), '[empty.tree] no content of its own');
    assert.equal(await h.port.head('orchestra-start-check-1'), e.head, '[empty.exists]');
    assert.equal((await h.port.emptyBranch('orchestra-start-check-1', 'main')).head, e.head, '[empty.idempotent] a second call adopts the branch');
    await h.port.deleteBranch('orchestra-start-check-1');
    assert.equal(await h.port.head('orchestra-start-check-1'), null, '[empty.deleted]');
    await h.port.deleteBranch('orchestra-start-check-1');
  }],
];
for (const [label, mk] of [['dummy', dummyGit], ['live', liveGit]] as const) {
  for (const [name, arm] of gitArms) test(`GitPort [${label}] ${name}`, async () => { await arm(mk()); });
}
/** ONE rule broken per port: [rule that must name the failure, the arm, the breaker]. */
const gitBreakers: Array<[string, string, (p: GitPort) => GitPort]> = [
  ['head.unknown', 'head', (p) => ({ ...p, head: async (b) => (await p.head(b)) ?? (await p.head('main')) })],
  ['tree.unknown', 'tree', (p) => ({ ...p, tree: async (s) => (await p.tree(s)) ?? s })],
  ['merged.unconnected', 'isMerged', (p) => ({ ...p, isMerged: async () => true })],
  ['empty.exists', 'emptyBranch', (p) => ({ ...p, emptyBranch: async (_b, base) => ({ head: (await p.head(base))! }) })],
];
test('GitPort MUST-FAIL: one rule broken per port, and the arm fails on THAT rule\'s assertion (dummy and live)', async () => {
  for (const mk of [dummyGit, liveGit]) for (const [rule, arm, brk] of gitBreakers) { const h = mk(); await mustFail(rule, { ...h, port: brk(h.port) }, gitArms.find(([n]) => n.startsWith(arm))![1]); }
});

// ════════════════════════════════════════ ForgePort ════════════════════════════════════════
interface ForgeH {
  name: string; port: ForgePort;
  branch(name: string): string; commit(name: string): string; ci(branch: string, results: string[]): void; settle(): Promise<void>;
  mergeParents(): number | undefined; title(branch: string): string;
}
function dummyForge(): ForgeH {
  const sc: Scenario = { version: 1, repo: { tickets: ['T1', 'T2'].map((id) => ({ id, dependsOn: [], spec: 's' })) }, ci: {} };
  const d: Dummy = buildDummy({ home: tmp(), run: 'f', scenario: sc });
  const w = d.world;
  let n = 0;
  return {
    name: 'dummy', port: d.forge,
    branch: (b) => { const c = w.commit([w.branches.get('main')!], b, b); w.branches.set(b, c); return c; },
    commit: (b) => { const c = w.commit([w.branches.get(b)!], `${b}${n++}`, `${b}${n}`); w.branches.set(b, c); return c; },
    ci: (b, r) => { sc.ci![b] = r; },
    settle: () => d.sleep(300_000),
    mergeParents: () => w.commits.get(w.branches.get('main')!)!.parents.length,
    title: (b) => `${b}: x`, // the dummy reads the ticket off the title
  };
}
function liveForge(deliver?: Parameters<typeof createLiveForge>[0]['deliver']): ForgeH & { fake: FakeForge } {
  const fake = new FakeForge();
  return {
    name: 'live', fake, port: createLiveForge({ gh: fake.gh, deliver, bareMerge: deliver ? undefined : true, sleep: async (ms) => { fake.advance(ms); }, branchHead: async (b) => fake.heads.get(b) ?? null }),
    branch: (b) => fake.push(b, sha40()),
    commit: (b) => fake.push(b, sha40()),
    ci: (b, r) => { fake.script.set(b, r); },
    settle: async () => { fake.advance(300_000); },
    mergeParents: () => [...fake.prs.values()].find((p) => p.state === 'MERGED')?.mergeParents,
    title: (b) => `${b}: x`,
  };
}
const open = (h: ForgeH, b: string): Promise<{ n: number }> => h.port.openPr({ branch: b, base: 'main', title: h.title(b) });

const forgeArms: Array<[string, (h: ForgeH) => Promise<void>]> = [
  ['openPr: idempotent per branch (the same number), a different branch gets its own', async (h) => {
    h.branch('T1'); h.branch('T2');
    const a = await open(h, 'T1');
    assert.equal((await open(h, 'T1')).n, a.n, '[open.same]');
    assert.notEqual((await open(h, 'T2')).n, a.n, '[open.other]');
  }],
  ['prState: open at the branch head, follows a new commit', async (h) => {
    const c1 = h.branch('T1');
    const { n } = await open(h, 'T1');
    assert.deepEqual(await h.port.prState(n), { state: 'open', head: c1 }, '[state.open]');
    const c2 = h.commit('T1');
    assert.equal((await h.port.prState(n)).head, c2, '[state.head]');
  }],
  ['checks: pending while the CI runs, green with a job id, the steps that ran and a finish time once it is done', async (h) => {
    const head = h.branch('T1');
    const { n } = await open(h, 'T1');
    const before = await h.port.checks(n, head);
    assert.ok(before.some((c) => c.status === 'pending') && before.every((c) => c.status !== 'red'), `[checks.pending] while the CI runs at least one check is pending, none red: ${JSON.stringify(before)}`);
    await h.settle();
    const after = await h.port.checks(n, head);
    assert.deepEqual(after.map((c) => c.status), after.map(() => 'green'), '[checks.green]');
    assert.ok(after.every((c) => typeof c.jobId === 'string' && c.jobId), '[checks.jobid] a job id on every check');
    assert.ok(after.every((c) => typeof c.steps === 'number' && c.steps >= 1), '[checks.steps] a green job carries the count of steps that ran (decideDelivery refuses a green that proves nothing ran)');
    assert.ok(after.every((c) => c.at), '[checks.at] the time each check finished (readiness order)');
  }],
  ['checks: ONE red check is named, carries a log extract, the others stay green', async (h) => {
    h.ci('T1', ['red:test', 'green']);
    const head = h.branch('T1');
    const { n } = await open(h, 'T1');
    await h.settle();
    const cs = await h.port.checks(n, head);
    const red = cs.filter((c) => c.status === 'red');
    assert.deepEqual(red.map((c) => c.name), ['test'], '[checks.red]');
    assert.match(String(red[0].logExtract), /FAIL/, '[checks.extract]');
    assert.ok(cs.filter((c) => c.name !== 'test').every((c) => c.status === 'green'), '[checks.others]');
  }],
  ['rerun: the red check comes back green AND its job id CHANGED (the loop tells a re-run from the old run by it)', async (h) => {
    h.ci('T1', ['red:test', 'green']);
    const head = h.branch('T1');
    const { n } = await open(h, 'T1');
    await h.settle();
    const red = (await h.port.checks(n, head)).find((c) => c.status === 'red')!;
    await h.port.rerun(n, [red.name]);
    await h.settle();
    const after = (await h.port.checks(n, head)).find((c) => c.name === red.name)!;
    assert.equal(after.status, 'green', '[rerun.green]');
    assert.ok(after.jobId && after.jobId !== red.jobId, `[rerun.jobid] job id ${red.jobId} → ${after.jobId}`);
  }],
  ['merge: a MERGE COMMIT bound to the head; the PR reads merged', async (h) => {
    const head = h.branch('T1');
    const { n } = await open(h, 'T1');
    await h.settle();
    assert.deepEqual(await h.port.merge(n, head, 'merge'), { ok: true }, '[merge.ok]');
    assert.equal((await h.port.prState(n)).state, 'merged', '[merge.state]');
    assert.equal(h.mergeParents(), 2, '[merge.commit] two parents: a merge commit, not a squash');
  }],
  ['merge: refused when the head moved ("head-moved"), the PR stays open', async (h) => {
    const old = h.branch('T1');
    const { n } = await open(h, 'T1');
    h.commit('T1');
    await h.settle();
    const r = await h.port.merge(n, old, 'merge');
    assert.equal(r.ok, false, '[merge.moved]');
    assert.equal(r.reason, 'head-moved', '[merge.moved.reason]');
    assert.equal((await h.port.prState(n)).state, 'open', '[merge.moved.open]');
  }],
  ['close: the PR reads closed; closing twice is fine', async (h) => {
    h.branch('T1');
    const { n } = await open(h, 'T1');
    await h.port.close(n);
    assert.equal((await h.port.prState(n)).state, 'closed', '[close.closed]');
    await h.port.close(n);
  }],
];
for (const [label, mk] of [['dummy', dummyForge], ['live', () => liveForge()]] as const) {
  for (const [name, arm] of forgeArms) test(`ForgePort [${label}] ${name}`, async () => { await arm(mk()); });
}
const forgeBreakers: Array<[string, string, (p: ForgePort) => ForgePort]> = [
  ['open.same', 'openPr', (p) => { let k = 0; return { ...p, openPr: async (i) => ({ n: (await p.openPr(i)).n + k++ }) }; }],
  ['checks.steps', 'checks: pending', (p) => ({ ...p, checks: async (n, h) => (await p.checks(n, h)).map(({ steps: _s, ...c }) => c) })],
  ['checks.red', 'checks: ONE red', (p) => ({ ...p, checks: async (n, h) => (await p.checks(n, h)).map((c) => ({ ...c, status: 'green' as const })) })],
  ['rerun.green', 'rerun', (p) => ({ ...p, rerun: async () => undefined })],
  ['rerun.jobid', 'rerun', (p) => { const old = new Map<string, string>(); return { ...p, checks: async (n, h) => (await p.checks(n, h)).map((c) => { if (c.status === 'red' && c.jobId) old.set(c.name, c.jobId); return { ...c, ...(old.has(c.name) ? { jobId: old.get(c.name) } : {}) }; }) }; }],
  ['merge.moved', 'merge: refused', (p) => ({ ...p, merge: async (n, _h, m) => p.merge(n, (await p.prState(n)).head, m) })],
  ['merge.ok', 'merge: a MERGE', (p) => ({ ...p, merge: async (n, h) => p.merge(n, h, 'squash') })],
];
test('ForgePort MUST-FAIL: one rule broken per port, and the arm fails on THAT rule\'s assertion (dummy and live)', async () => {
  for (const mk of [dummyForge, () => liveForge()]) for (const [rule, arm, brk] of forgeBreakers) {
    const h = mk();
    await mustFail(rule, { ...h, port: brk(h.port) }, forgeArms.find(([n]) => n.startsWith(arm))![1]);
  }
});

// ════════════════════════════════════════ FleetPort ════════════════════════════════════════
type World = Dummy['world'];
interface FleetH { name: string; fleet: FleetPort; world: World; home: string; run: string; refresh?: () => Promise<void> }

function seedState(home: string, run: string, sc: Scenario): void {
  const plan = planOf(sc);
  updateState(stateFile(home, run), () => {
    let s = newState(run, { target: 'main', repo: null, switches: { seatRecords: 'on', minorPolicy: 'demonstrated', verifier: 'off' }, now: NOW });
    s = setPlan(s, plan.tickets.map((t) => t.id), 'declare', NOW);
    for (const t of plan.tickets) {
      const patch: Record<string, unknown> = { dependsOn: t.dependsOn, spec: t.spec };
      if (plan.interfaces[t.id]) patch.interface = plan.interfaces[t.id];
      s = applyTicketPatch(s, t.id, patch, NOW);
    }
    return s;
  });
}
const SC: Scenario = { version: 1, run: 'fl', repo: { tickets: [{ id: 'T1', dependsOn: [], spec: 'spec/T1.md' }, { id: 'T2', dependsOn: ['T1'], spec: 'spec/T2.md' }] } };

async function fleetHarness(kind: 'dummy' | 'live'): Promise<FleetH & { bus: ReturnType<typeof fakeBus>; d: Dummy }> {
  const home = tmp();
  seedState(home, 'fl', SC);
  const d = buildDummy({ home, run: 'fl', scenario: SC });
  const bus = fakeBus(d, 'fl', home);
  const fleet = kind === 'dummy' ? d.fleet : await createLiveFleet({ run: 'fl', caller: 'fl', cli: bus.cli, host: bus.host, readState: () => readState(stateFile(home, 'fl')), costOf: d.fleet.costOf });
  return { name: kind, fleet, world: d.world, home, run: 'fl', bus, d };
}
const wsOf = (h: FleetH, t: string): string => readState(stateFile(h.home, h.run))!.tickets[t].implementer!;

const fleetArms: Array<[string, (h: FleetH) => Promise<void>]> = [
  ['start: one implementer per ticket, a second start launches none (never two for a ticket); live() tells them apart from strangers', async (h) => {
    const r1 = await h.fleet.start();
    assert.deepEqual(r1.started.map((x) => x.ticket).sort(), ['T1', 'T2'], '[start.each]');
    const r2 = await h.fleet.start();
    assert.deepEqual(r2.started, [], '[start.once] nothing started twice');
    assert.equal(h.world.events.filter((e) => e.ev === 'spawn').length, 2, '[start.once.spawns]');
    assert.ok(h.fleet.live(wsOf(h, 'T1')) && h.fleet.live(wsOf(h, 'T2')), '[live.started]');
    assert.equal(h.fleet.live('ws-not-ours'), false, '[live.stranger]');
  }],
  ['replace (#628): the ticket\'s implementer ends on purpose — live() says so at once, its branch stays, and the next start() puts a fresh one on the SAME branch (respawned, never a second `started`)', async (h) => {
    await h.fleet.start();
    const w1 = wsOf(h, 'T1');
    const branch = readState(stateFile(h.home, h.run))!.tickets.T1.branch;
    await h.fleet.replace('T1');
    assert.equal(h.fleet.live(w1), false, '[replace.gone]');
    assert.ok(h.fleet.live(wsOf(h, 'T2')), '[replace.only-that-ticket]');
    const r = await h.fleet.start();
    assert.deepEqual(r.respawned.map((x) => [x.ticket, x.branch]), [['T1', branch]], '[replace.respawn.same-branch]');
    assert.deepEqual(r.started, [], '[replace.not-a-first-start]');
    assert.ok(h.fleet.live(wsOf(h, 'T1')), '[replace.fresh-live]');
  }],
  ['mail: the run\'s messages in order, `ask` as `ask`; unread until `ack`; an ack below the last message loses nothing after it; acked ones never come back', async (h) => {
    await h.fleet.start();
    const w1 = wsOf(h, 'T1'), w2 = wsOf(h, 'T2');
    h.world.post('ask', w1, 'T1', 'Which name?');
    h.world.post('status', w2, 'T2', 'nominated');
    h.world.post('worker_done', w1, 'T1', 'done');
    const m = await h.fleet.mail();
    assert.deepEqual(m.map((x) => [x.seq, x.kind, x.sender]), [[1, 'ask', w1], [2, 'status', w2], [3, 'worker_done', w1]], '[mail.order]');
    assert.deepEqual(m.map((x) => x.body), ['Which name?', 'nominated', 'done'], '[mail.bodies]');
    assert.deepEqual((await h.fleet.mail()).map((x) => x.seq), [1, 2, 3], '[mail.unacked] mail() alone never consumes: a loop that failed on a message reads it again');
    await h.fleet.ack(1);
    const rest = (await h.fleet.mail()).map((x) => x.seq);
    assert.deepEqual(rest, [2, 3], `[mail.ack.partial] an ack of seq 1 loses neither 2 nor 3 and never hands 1 out again (read ${JSON.stringify(rest)})`);
    await h.fleet.ack(3);
    assert.deepEqual(await h.fleet.mail(), [], '[mail.acked] acked: gone');
    h.world.post('status', w1, 'T1', 'later');
    assert.deepEqual((await h.fleet.mail()).map((x) => x.body), ['later'], '[mail.later]');
  }],
  ['wake / send: the ask to connect and the fixed answer REACH the agent', async (h) => {
    await h.fleet.start();
    const w1 = wsOf(h, 'T1'), w2 = wsOf(h, 'T2');
    const head = sha40();
    await h.fleet.wake(w2, `CONNECT T1 ${head}\nT2: connect once`);
    assert.ok(h.world.events.some((e) => e.ev === 'connect-ask' && e.ticket === 'T2' && e.head === head), '[wake.reaches] the agent got the ask');
    await h.fleet.send(w1, FIXED_ANSWER, 'answer');
    assert.ok(h.world.events.some((e) => e.ev === 'send' && e.kind === 'answer' && e.text === FIXED_ANSWER && e.to === w1), '[send.reaches] the agent got the answer');
  }],
  ['spawnReviewer: one reviewer per head — the same head answers the same id and spawns nothing; a new head wakes the same reviewer', async (h) => {
    await h.fleet.start();
    const head = h.world.commit([h.world.branches.get('main')!], 'T1:c', 'T1:c');
    updateState(stateFile(h.home, h.run), (s) => applyTicketPatch(s!, 'T1', { head, status: 'nominated', pr: 1 }, NOW, { tree: sha40() }));
    const r1 = await h.fleet.spawnReviewer('T1', head);
    assert.ok(r1.id, '[review.id]');
    assert.deepEqual(await h.fleet.spawnReviewer('T1', head), r1, '[review.same] the same head: the same reviewer');
    assert.equal(h.world.events.filter((e) => e.ev === 'review-spawn').length, 1, '[review.once] ONE reviewer spawned');
    const head2 = h.world.commit([head], 'T1:d', 'T1:d');
    updateState(stateFile(h.home, h.run), (s) => applyTicketPatch(s!, 'T1', { head: head2 }, NOW, { tree: sha40() }));
    assert.deepEqual(await h.fleet.spawnReviewer('T1', head2), r1, '[review.wake] a new head wakes the SAME reviewer');
    assert.equal(h.world.events.filter((e) => e.ev === 'review-spawn').length, 1, '[review.wake.once]');
    assert.ok(h.world.events.some((e) => e.ev === 'review-wake'), '[review.wake.event]');
  }],
  ['costOf: a count of tokens for a ticket that worked, never a throw', async (h) => {
    await h.fleet.start();
    const c = await h.fleet.costOf('T1');
    assert.ok(c === null || (Number.isFinite(c.tokens) && c.tokens >= 0));
  }],
];
for (const kind of ['dummy', 'live'] as const) for (const [name, arm] of fleetArms) test(`FleetPort [${kind}] ${name}`, async () => { await arm(await fleetHarness(kind)); });

const fleetBreakers: Array<[string, string, (f: FleetPort) => FleetPort]> = [
  ['start.once', 'start:', (f) => { let n = 0; return { ...f, start: async () => { const r = await f.start(); return n++ ? { ...r, started: [{ ticket: 'T1', ws: 'x', branch: 'x' }] } : r; } }; }],
  ['mail.unacked', 'mail:', (f) => ({ ...f, mail: async () => { const m = await f.mail(); if (m.length) await f.ack(Math.max(...m.map((x) => x.seq))); return m; } })], // acks on read: a message whose handling failed is gone
  ['mail.ack.partial', 'mail:', (f) => ({ ...f, ack: async (n) => { await f.ack(n + 1000); } })], // an ack of one acks everything
  ['wake.reaches', 'wake / send', (f) => ({ ...f, wake: async () => undefined })],
  ['send.reaches', 'wake / send', (f) => ({ ...f, send: async () => undefined })],
  ['review.same', 'spawnReviewer', (f) => ({ ...f, spawnReviewer: async (t, h) => { const a = await f.spawnReviewer(t, h); return { id: `${a.id}-${Math.random()}` }; } })],
];
test('FleetPort MUST-FAIL: one rule broken per port, and the arm fails on THAT rule\'s assertion (dummy and live)', async () => {
  for (const kind of ['dummy', 'live'] as const) for (const [rule, arm, brk] of fleetBreakers) {
    const h = await fleetHarness(kind);
    await mustFail(rule, { ...h, fleet: brk(h.fleet) }, fleetArms.find(([n]) => n.startsWith(arm))![1]);
  }
});

// ════════════════════════════════════════ what only the LIVE ports do ════════════════════════════════════════
test('live fleet: a lot not acked (a kill, a failed message) is READ AGAIN by the next loop; `ack` of its last message closes it; `question` reads as `ask`', async () => {
  const h = await fleetHarness('live');
  await h.fleet.start();
  h.world.post('ask', wsOf(h, 'T1'), 'T1', 'Q?');
  assert.equal((await h.fleet.mail()).length, 1);
  assert.equal(h.bus.calls.filter((c) => c[0] === 'ack').length, 0, 'mail() never acks');
  const again = await createLiveFleet({ run: 'fl', caller: 'fl', cli: h.bus.cli, host: (await fleetHarness('live')).bus.host, readState: () => readState(stateFile(h.home, h.run)) }); // a restarted loop = a new port on the same bus
  const m = await again.mail();
  assert.deepEqual(m.map((x) => [x.kind, x.body]), [['ask', 'Q?']], 'the killed loop never acked it: the next one reads it');
  await again.ack(m[0].seq - 1);
  assert.equal(h.bus.calls.filter((c) => c[0] === 'ack').length, 0, 'an ack below the lot\'s last message acks nothing');
  await again.ack(m[0].seq);
  assert.equal(h.bus.calls.filter((c) => c[0] === 'ack').length, 1);
  assert.deepEqual(await again.mail(), []);
});
test('live fleet: a refusal of the shipped verb ([start-caller]) is a SeatRefusal the loop ends on (exit 2), a crash of the verb is not', async () => {
  const h = await fleetHarness('live');
  h.bus.fail.start = { code: 2, stdout: '', stderr: '[start-caller] only the run\'s coordinator (fl) starts its implementers\n' };
  await assert.rejects(h.fleet.start(), (e: unknown) => e instanceof SeatRefusal && e.refusal === 'start-caller');
  h.bus.fail.start = { code: 1, stdout: '', stderr: 'boom' };
  await assert.rejects(h.fleet.start(), (e: unknown) => !(e instanceof SeatRefusal) && /failed \(exit 1\)/.test(String(e)));
  assert.ok(verbError('x', { code: 2, stdout: '', stderr: 'refused: [review-caller] nope' }) instanceof SeatRefusal);
});
test('live fleet: a host that cannot say who is alive stops the loop (never "everybody is dead" and a second implementer per ticket)', async () => {
  const h = await fleetHarness('live');
  await h.fleet.start();
  const broken = await createLiveFleet({ run: 'fl', caller: 'fl', cli: h.bus.cli, host: async () => ({ ok: false, error: 'host down' }), readState: () => readState(stateFile(h.home, h.run)) }).catch((e: Error) => e);
  assert.match(String(broken), /could not tell which workspaces are alive/);
});
test('live forge: a merge goes THROUGH the injected deliver — its refusal is the loop\'s (no bare `gh pr merge` when deliver is wired)', async () => {
  const seen: Array<{ n: number; head: string; method: string }> = [];
  const h = liveForge(async (i) => { seen.push(i); return { ok: false, reason: 'ci-red', detail: 'check "test" is red' }; });
  const head = h.branch('T1');
  const { n } = await open(h, 'T1');
  await h.settle();
  assert.deepEqual(await h.port.merge(n, head, 'merge'), { ok: false, reason: 'ci-red', detail: 'check "test" is red' });
  assert.deepEqual(seen, [{ n, head, method: 'merge' }]);
  await h.port.merge(n, head, 'squash');
  assert.equal(seen[1].method, 'squash', 'the method the loop asked for is the one deliver is handed');
  assert.equal(h.fake.calls.filter((c) => c[0] === 'pr' && c[1] === 'merge').length, 0, 'gh never merged around deliver');
  assert.equal((await h.port.prState(n)).state, 'open');
});
test('live forge: checks of another head are not this head\'s checks; a re-run of an external status (no Actions job) is refused, never looped', async () => {
  const h = liveForge();
  const head = h.branch('T1');
  const { n } = await open(h, 'T1');
  await h.settle();
  assert.deepEqual(await h.port.checks(n, sha40()), []);
  assert.ok((await h.port.checks(n, head)).length > 0);
  await assert.rejects(h.port.rerun(n, ['build']), /no re-runnable Actions job/, 'a green check has nothing to re-run');
  assert.equal(h.fake.calls.filter((c) => c[0] === 'run' && c[1] === 'rerun').length, 0);
});
test('live forge: an unsupported gh answer is an error, never a quiet "no checks" (fail closed)', async () => {
  const p = createLiveForge({ gh: async () => ({ code: 1, stdout: '', stderr: 'HTTP 502' }) });
  await assert.rejects(p.checks(1, sha40()), /gh pr view failed/);
  await assert.rejects(p.prState(1), /HTTP 502/);
});
test('the fake gh knows exactly the verbs the port uses (an unknown call fails loudly)', async () => {
  const f = new FakeForge();
  assert.equal((await f.gh(['api', 'x'])).code, 1);
  assert.deepEqual(CHECKS, ['build', 'test', 'lint']);
});

// ── live git: the local-vs-origin rule, the probe's safety ──
function pushedRepo(): { port: GitPort; commitLocal(b: string): string; commitRemoteOnly(b: string): string; push(b: string): void; sh: (...a: string[]) => string; broken: GitPort } {
  const root = tmp(); const bare = path.join(root, 'r.git'); const work = path.join(root, 'w'); const other = path.join(root, 'o');
  const sh = (cwd: string) => (...args: string[]): string => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'init.defaultBranch=main', ...args], { cwd, encoding: 'utf8' }).trim();
  fs.mkdirSync(bare); sh(bare)('init', '--bare', '--quiet'); fs.mkdirSync(work); const w = sh(work); w('init', '--quiet'); w('remote', 'add', 'origin', bare);
  fs.writeFileSync(path.join(work, 'f'), '0\n'); w('add', '.'); w('commit', '--quiet', '-m', 'root'); w('push', '--quiet', 'origin', 'main');
  w('remote', 'set-head', 'origin', 'main');
  let n = 0;
  const git = (hideLocal: boolean) => (args: string[]): Promise<ExecResult> => { const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...(hideLocal ? args.map((a) => a.replace(/^refs\/heads\//, 'refs/hidden/')) : args)], { cwd: work, encoding: 'utf8' }); return Promise.resolve({ code: r.status ?? 1, stdout: r.stdout, stderr: r.stderr }); };
  const commit = (cwd: string, b: string): string => { const x = sh(cwd); const has = x('branch', '--list', b); x('switch', '--quiet', ...(has ? [b] : ['-c', b, 'main'])); fs.writeFileSync(path.join(cwd, `g${++n}`), `${n}\n`); x('add', '.'); x('commit', '--quiet', '-m', `c${n}`); return x('rev-parse', 'HEAD'); };
  return {
    port: createLiveGit({ git: git(false) }), broken: createLiveGit({ git: git(true) }), sh: w,
    commitLocal: (b) => commit(work, b),
    push: (b) => { w('push', '--quiet', 'origin', `${b}:${b}`); },
    commitRemoteOnly: (b) => { sh(root)('clone', '--quiet', bare, 'o'); const x = sh(other); x('switch', '--quiet', b); fs.writeFileSync(path.join(other, `h${++n}`), 'r\n'); x('add', '.'); x('commit', '--quiet', '-m', 'remote'); x('push', '--quiet', 'origin', b); return x('rev-parse', 'HEAD'); },
  };
}
const localOriginArm = async (r: ReturnType<typeof pushedRepo>): Promise<void> => {
  const c1 = r.commitLocal('b1'); r.push('b1');
  assert.equal(await r.port.head('b1'), c1, 'pushed, same on both sides');
  const c2 = r.commitLocal('b1');
  assert.equal(await r.port.head('b1'), c2, '[head.local-ahead] a local commit not pushed yet: LOCAL wins (nothing is pushed)');
  r.push('b1');
  const c3 = r.commitRemoteOnly('b1');
  assert.equal(await r.port.head('b1'), c3, '[head.origin-ahead] the remote is ahead of the local branch: ORIGIN wins');
};
test('live git: local refs win while nothing is pushed, origin once it is ahead', async () => { await localOriginArm(pushedRepo()); });
test('live git MUST-FAIL: a port that cannot see local branches fails the arm (the rule is exercised, not assumed)', async () => { const r = pushedRepo(); await mustFail('head.local-ahead', { ...r, port: r.broken }, localOriginArm); });
test('live git: a stale probe (the base moved since a killed start check) is REPLACED, a still-empty one adopted; only probe names are created / deleted', async () => {
  const r = pushedRepo();
  const probe = 'orchestra-start-check-abc';
  const e1 = await r.port.emptyBranch(probe, 'main');
  assert.equal((await r.port.emptyBranch(probe, 'main')).head, e1.head, 'still empty over the base: adopted');
  r.commitLocal('main'); r.sh('push', '--quiet', 'origin', 'main'); // main moves on the remote
  const e2 = await r.port.emptyBranch(probe, 'main');
  assert.notEqual(e2.head, e1.head, 'stale probe replaced');
  assert.equal(await r.port.tree(e2.head), await r.port.tree((await r.port.head('main'))!), 'empty over the CURRENT main');
  await assert.rejects(r.port.emptyBranch('feature-x', 'main'), /refusing a probe branch/);
  await assert.rejects(r.port.deleteBranch('main'), /only the start check's probe/);
  r.commitLocal('main'); // an UNPUSHED local commit must not travel with the probe
  const e3 = await r.port.emptyBranch('orchestra-start-check-def', 'main');
  assert.equal(await r.port.tree(e3.head), await r.port.tree(r.sh('rev-parse', 'origin/main')), 'cut from origin/main, not from local main');
});

// ── live forge: the reused branch name, a re-run into a running run, the missing deliver ──
test('live forge: an old MERGED pull request of a reused branch name is not adopted for the new head; the same head is', async () => {
  const h = liveForge();
  const old = h.branch('T1');
  const first = await open(h, 'T1');
  await h.settle();
  await h.port.merge(first.n, old, 'merge');
  assert.equal((await open(h, 'T1')).n, first.n, 'the branch still sits on the merged head: the merged PR is the answer');
  h.commit('T1'); // the branch is reused: new commits
  const second = await open(h, 'T1');
  assert.notEqual(second.n, first.n, 'a new PR for the new head');
});
test('live forge: a re-run waits for the OTHER jobs of the run to finish (gh refuses a re-run of a running run) instead of ending the loop', async () => {
  const h = liveForge();
  h.ci('T1', ['red:test', 'green']);
  const head = h.branch('T1');
  const { n } = await open(h, 'T1');
  h.fake.advance(240_000 + 1); // done
  const red = (await h.port.checks(n, head)).find((c) => c.status === 'red')!;
  h.fake.runs[0].sibling = { name: 'lint', until: h.fake.clock + 30_000 }; // `test` is red but a sibling job is still running: the run is not completed
  await h.port.rerun(n, [red.name]); // waits (its injected sleep advances the fake clock) then re-runs
  assert.equal(h.fake.calls.filter((c) => c[0] === 'run' && c[1] === 'rerun').length, 1);
});
test('live forge (review 614 MINOR-2): a re-run waits only for the red RUN\'s own jobs — a required external status stuck pending is not a sibling', async () => {
  const h = liveForge();
  h.fake.externalPending = 'required/external';
  h.ci('T1', ['red:test', 'green']);
  const head = h.branch('T1');
  const { n } = await open(h, 'T1');
  h.fake.advance(240_000 + 1);
  const red = (await h.port.checks(n, head)).find((c) => c.status === 'red')!;
  const t0 = h.fake.clock;
  await h.port.rerun(n, [red.name]);
  assert.equal(h.fake.calls.filter((c) => c[0] === 'run' && c[1] === 'rerun').length, 1, 're-ran');
  assert.equal(h.fake.clock, t0, 'without waiting for the external status');
});
test('live forge (review 614 MAJOR): a SKIPPED job is neither green nor red — left out, as `deliver` ignores it (a 0-step green would be refused `zero-steps` forever)', async () => {
  const h = liveForge();
  h.fake.skipped = 'lint';
  const head = h.branch('T1');
  const { n } = await open(h, 'T1');
  await h.settle();
  const cs = await h.port.checks(n, head);
  assert.deepEqual(cs.map((c) => c.name).sort(), ['build', 'test']);
  assert.ok(cs.every((c) => c.status === 'green' && (c.steps ?? 0) >= 1));
});
test('live forge (review 614 r2 MINOR-1): a green job counts only the USER steps that SUCCEEDED — setup/complete alone, a failed or skipped user step: not counted; a job id `run view` does not hold throws', async () => {
  const stepsOf = async (steps: Array<{ name: string; conclusion: string }>, hide = false): Promise<number | undefined> => {
    const h = liveForge();
    h.fake.jobSteps.set('build', steps);
    if (hide) h.fake.hiddenJobs.add('build');
    const head = h.branch('T1');
    const { n } = await open(h, 'T1');
    await h.settle();
    return (await h.port.checks(n, head)).find((c) => c.name === 'build')!.steps;
  };
  const S = (name: string, conclusion = 'success') => ({ name, conclusion });
  assert.equal(await stepsOf([S('Set up job'), S('Complete job')]), 0, 'a job that ran only its setup and completion proves nothing ran');
  assert.equal(await stepsOf([S('Set up job'), S('Post Run actions/checkout'), S('Complete job')]), 0, 'Post … steps are not user steps either');
  assert.equal(await stepsOf([S('Set up job'), S('Run it', 'failure'), S('Complete job')]), 0, 'a failed user step is not counted');
  assert.equal(await stepsOf([S('Set up job'), S('Run it', 'skipped'), S('Complete job')]), 0, 'a skipped user step is not counted');
  assert.equal(await stepsOf([S('Set up job'), S('One'), S('Two'), S('Three', 'failure'), S('Complete job')]), 2, 'two that succeeded, one that did not');
  await assert.rejects(stepsOf([], true), /job \d+ not found/, 'an unknown job id fails closed (never "no steps to worry about")');
});
test('live forge: a check linked to a whole run (no job id) has no step count — refused, never the sum of the run\'s jobs; N jobs of a run cost ONE `gh run view`', async () => {
  const noJob = createLiveForge({ gh: async (a) => a[0] === 'pr' ? { code: 0, stdout: JSON.stringify({ state: 'OPEN', headRefOid: 'abc1234', statusCheckRollup: [{ __typename: 'CheckRun', name: 'ci', status: 'COMPLETED', conclusion: 'SUCCESS', detailsUrl: 'https://github.com/o/r/actions/runs/77', completedAt: '2026-01-01T00:00:00Z' }] }), stderr: '' } : { code: 1, stdout: '', stderr: 'unexpected' } });
  assert.equal((await noJob.checks(1, 'abc1234'))[0].steps, undefined);
  const h = liveForge();
  const head = h.branch('T1');
  const { n } = await open(h, 'T1');
  await h.settle();
  await h.port.checks(n, head);
  assert.equal(h.fake.calls.filter((c) => c[0] === 'run' && c[1] === 'view' && c.includes('jobs')).length, 1, 'one gh run view for the three jobs of the run');
});
test('live fleet: a transient CLI failure (exit 1) is retried, a refusal (exit 2) is not', async () => {
  const h = await fleetHarness('live');
  let fails = 1;
  const flaky: Cli = async (a) => (a[0] === 'check' && fails-- > 0 ? { code: 1, stdout: '', stderr: 'busy' } : h.bus.cli(a));
  const waits: number[] = [];
  const f = await createLiveFleet({ run: 'fl', caller: 'fl', cli: flaky, host: h.bus.host, readState: () => readState(stateFile(h.home, h.run)), sleep: async (ms) => { waits.push(ms); } });
  assert.deepEqual(await f.mail(), []);
  assert.deepEqual(waits, [1000], 'retried once');
  h.bus.fail.start = { code: 2, stdout: '', stderr: '[start-caller] no' };
  waits.length = 0;
  await assert.rejects(f.start(), SeatRefusal);
  assert.deepEqual(waits, [], 'a refusal is final');
});
test('live forge: with neither `deliver` nor the rigs\' bareMerge, merge REFUSES to run (no default path around deliver)', async () => {
  const p = createLiveForge({ gh: new FakeForge().gh });
  await assert.rejects(p.merge(1, sha40(), 'merge'), /no `deliver` wired/);
});
test('live fleet: a reviewer is never spawned on a head the state does not hold (the head moved under the loop)', async () => {
  const h = await fleetHarness('live');
  await h.fleet.start();
  const head = sha40();
  updateState(stateFile(h.home, h.run), (s) => applyTicketPatch(s!, 'T1', { head, status: 'nominated', pr: 1 }, NOW, { tree: sha40() }));
  await assert.rejects(h.fleet.spawnReviewer('T1', sha40()), /the head moved/);
  assert.equal(h.world.events.filter((e) => e.ev === 'review-spawn').length, 0, 'nothing was spawned');
});
