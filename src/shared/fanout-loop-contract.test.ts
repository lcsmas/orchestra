// #614 (spec #601, ledger #613) — the CONTRACT of the three ports of the Boucle, run against BOTH implementations: the dummy world (fanout-loop-dummy.ts) and the live ports (fanout-loop-live-*.ts) over a world they can be driven on
// (real git in a temp repo + a bare remote; a fake `gh` speaking the real binary's shapes; the dummy fleet behind a fake `orchestra` CLI + host). The arms are written ONCE against a small harness; each harness runs the same list.
// Every arm that matters also has its MUST-FAIL twin: the same arm run on a deliberately broken port must throw (an arm that cannot fail proves nothing). Differences that are real (the dummy drains its mailbox, the live bus replays an
// unacked lot; only the live forge refuses through `deliver`) are asserted in the live-only block at the end, named as such.
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
import { FIXED_ANSWER } from './fanout-loop.ts';
import { SeatRefusal, applyTicketPatch, newState, readState, setPlan, stateFile, updateState } from './fanout-state.ts';

const made: string[] = [];
const tmp = (): string => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'fanout-contract-')); made.push(d); return d; };
after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });
const NOW = '2026-01-01T00:00:00.000Z';
const sha40 = (): string => crypto.randomBytes(20).toString('hex');
/** The arm must fail on a broken port: a thrown assertion is the PASS of a must-fail arm. */
async function mustFail<T>(name: string, h: T, arm: (h: T) => Promise<void>): Promise<void> {
  let failed = false;
  try { await arm(h); } catch { failed = true; }
  assert.ok(failed, `${name}: the arm did NOT fail on the broken port — it cannot tell a broken port from a good one`);
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
    assert.equal(await h.port.head('b1'), c2);
    assert.equal(await h.port.head('no-such-branch'), null);
  }],
  ['tree: a hex tree for a known commit, different for a different content, null for an unknown sha', async (h) => {
    const a = h.commit('t1'), b = h.commit('t1');
    const ta = await h.port.tree(a), tb = await h.port.tree(b);
    assert.match(String(ta), /^[0-9a-f]{40}$/);
    assert.notEqual(ta, tb);
    assert.equal(await h.port.tree(sha40()), null);
  }],
  ['isMerged: an ancestor is merged, a sibling is not, an unknown sha is not, a commit contains itself', async (h) => {
    const up = h.commit('up');
    h.commit('dep');
    assert.equal(await h.port.isMerged(up, 'dep'), false, 'not yet connected');
    h.merge('dep', 'up');
    assert.equal(await h.port.isMerged(up, 'dep'), true, 'connected by a merge commit');
    assert.equal(await h.port.isMerged('dep', 'up'), false, 'the other way round is not');
    assert.equal(await h.port.isMerged(sha40(), 'dep'), false);
    assert.equal(await h.port.isMerged(up, up), true);
  }],
  ['emptyBranch: a branch holding nothing over its base, idempotent; deleteBranch removes it and a missing one is fine', async (h) => {
    const mainHead = (await h.port.head('main'))!;
    const e = await h.port.emptyBranch('probe-1', 'main');
    assert.equal(await h.port.tree(e.head), await h.port.tree(mainHead), 'no content of its own');
    assert.equal(await h.port.head('probe-1'), e.head);
    assert.equal((await h.port.emptyBranch('probe-1', 'main')).head, e.head, 'a second call adopts the branch');
    await h.port.deleteBranch('probe-1');
    assert.equal(await h.port.head('probe-1'), null);
    await h.port.deleteBranch('probe-1');
  }],
];
const brokenGit = (p: GitPort): GitPort => ({ ...p, head: async (b) => (await p.head(b)) ?? (await p.head('main')), isMerged: async () => true, tree: async (s) => s });

for (const [label, mk] of [['dummy', dummyGit], ['live', liveGit]] as const) {
  for (const [name, arm] of gitArms) test(`GitPort [${label}] ${name}`, async () => { await arm(mk()); });
}
test('GitPort MUST-FAIL: the arms fail on a port that answers main for an unknown branch / says everything is merged / echoes the sha as its tree', async () => {
  for (const mk of [dummyGit, liveGit]) for (const [name, arm] of gitArms.slice(0, 3)) { const h = mk(); await mustFail(name, { ...h, port: brokenGit(h.port) }, arm); }
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
    name: 'live', fake, port: createLiveForge({ gh: fake.gh, deliver }),
    branch: (b) => { const c = sha40(); fake.heads.set(b, c); return c; },
    commit: (b) => { const c = sha40(); fake.heads.set(b, c); return c; },
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
    assert.equal((await open(h, 'T1')).n, a.n);
    assert.notEqual((await open(h, 'T2')).n, a.n);
  }],
  ['prState: open at the branch head, follows a new commit', async (h) => {
    const c1 = h.branch('T1');
    const { n } = await open(h, 'T1');
    assert.deepEqual(await h.port.prState(n), { state: 'open', head: c1 });
    const c2 = h.commit('T1');
    assert.equal((await h.port.prState(n)).head, c2);
  }],
  ['checks: pending while the CI runs, green with a job id once it is done', async (h) => {
    const head = h.branch('T1');
    const { n } = await open(h, 'T1');
    const before = await h.port.checks(n, head);
    assert.ok(before.length > 0 && before.every((c) => c.status === 'pending'), JSON.stringify(before));
    await h.settle();
    const after = await h.port.checks(n, head);
    assert.deepEqual(after.map((c) => c.status), after.map(() => 'green'));
    assert.ok(after.every((c) => typeof c.jobId === 'string' && c.jobId), 'a job id on every check');
    assert.ok(after.every((c) => c.at), 'the time each check finished (readiness order)');
  }],
  ['checks: ONE red check is named, carries a log extract, the others stay green', async (h) => {
    h.ci('T1', ['red:test', 'green']);
    const head = h.branch('T1');
    const { n } = await open(h, 'T1');
    await h.settle();
    const cs = await h.port.checks(n, head);
    const red = cs.filter((c) => c.status === 'red');
    assert.deepEqual(red.map((c) => c.name), ['test']);
    assert.match(String(red[0].logExtract), /FAIL/);
    assert.ok(cs.filter((c) => c.name !== 'test').every((c) => c.status === 'green'));
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
    assert.equal(after.status, 'green');
    assert.ok(after.jobId && after.jobId !== red.jobId, `job id ${red.jobId} → ${after.jobId}`);
  }],
  ['merge: a MERGE COMMIT bound to the head; the PR reads merged', async (h) => {
    const head = h.branch('T1');
    const { n } = await open(h, 'T1');
    await h.settle();
    assert.deepEqual(await h.port.merge(n, head), { ok: true });
    assert.equal((await h.port.prState(n)).state, 'merged');
    assert.equal(h.mergeParents(), 2, 'two parents: a merge commit, not a squash');
  }],
  ['merge: refused when the head moved ("head-moved"), the PR stays open', async (h) => {
    const old = h.branch('T1');
    const { n } = await open(h, 'T1');
    h.commit('T1');
    await h.settle();
    const r = await h.port.merge(n, old);
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'head-moved');
    assert.equal((await h.port.prState(n)).state, 'open');
  }],
  ['close: the PR reads closed; closing twice is fine', async (h) => {
    h.branch('T1');
    const { n } = await open(h, 'T1');
    await h.port.close(n);
    assert.equal((await h.port.prState(n)).state, 'closed');
    await h.port.close(n);
  }],
];
for (const [label, mk] of [['dummy', dummyForge], ['live', () => liveForge()]] as const) {
  for (const [name, arm] of forgeArms) test(`ForgePort [${label}] ${name}`, async () => { await arm(mk()); });
}
test('ForgePort MUST-FAIL: the arms fail on a port whose openPr always opens, whose rerun does nothing, whose merge ignores the head, whose checks are always green', async () => {
  const breakers: Array<[string, (p: ForgePort) => ForgePort]> = [
    ['openPr: idempotent', (p) => ({ ...p, openPr: async (i) => p.openPr({ ...i, branch: i.branch }).then(async (r) => { await p.close(r.n); return { n: r.n + 100 }; }) })],
    ['rerun', (p) => ({ ...p, rerun: async () => undefined })],
    ['merge: refused when the head moved', (p) => ({ ...p, merge: async (n) => p.merge(n, (await p.prState(n)).head) })],
    ['checks: ONE red', (p) => ({ ...p, checks: async (n, h) => (await p.checks(n, h)).map((c) => ({ ...c, status: 'green' as const })) })],
  ];
  for (const mk of [dummyForge, () => liveForge()]) for (const [key, brk] of breakers) {
    const arm = forgeArms.find(([n]) => n.includes(key))![1];
    const h = mk();
    await mustFail(`${h.name}/${key}`, { ...h, port: brk(h.port) }, arm);
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

/** A fake `orchestra` CLI + host on the dummy world: it answers in the shapes of the real verbs (a bus whose plain `check` never acks, `question` for an ask, the `[name]` refusal text). */
function fakeBus(d: Dummy, run: string, home: string): { cli: Cli; host: Host; lots: number[]; calls: string[][]; fail: { start?: ExecResult } } {
  const mailbox = (d.world as unknown as { mailbox: Array<{ seq: number; kind: string; sender: string; body: string }> }).mailbox;
  const state = { cursor: 0, lot: 0, held: null as null | { id: number; from: number; to: number } };
  const calls: string[][] = [];
  const lots: number[] = [];
  const fail: { start?: ExecResult } = {};
  const out = (stdout: string, code = 0, stderr = ''): Promise<ExecResult> => Promise.resolve({ code, stdout, stderr });
  const cli: Cli = async (args) => {
    calls.push(args);
    const [a, b] = args;
    if (a === 'fanout' && b === 'start') { if (fail.start) return fail.start; const r = await d.fleet.start(); return out(`${JSON.stringify(r)}\n`, r.failed.length ? 2 : 0); }
    if (a === 'fanout' && b === 'review') { const t = readState(stateFile(home, run))!.tickets[args[2]]; await d.fleet.spawnReviewer(args[2], t.head!); return out(`${args[2]}: asking Orchestra for its reviewer\n`); }
    if (a === 'check') {
      const limit = Number(args[args.indexOf('--limit') + 1]) || 100;
      if (!state.held) {
        const next = mailbox.filter((m) => m.seq > state.cursor).slice(0, limit);
        if (next.length) state.held = { id: ++state.lot, from: next[0].seq - 1, to: next[next.length - 1].seq };
      }
      const msgs = state.held ? mailbox.filter((m) => m.seq > state.held!.from && m.seq <= state.held!.to) : [];
      if (state.held) lots.push(state.held.id);
      return out(`${JSON.stringify({ run, reader: run, lot: state.held?.id ?? null, replay: false, from: state.held?.from ?? 0, to: state.held?.to ?? 0, count: msgs.length, messages: msgs.map((m) => ({ sequence: m.seq, kind: m.kind === 'ask' ? 'question' : m.kind, sender: m.sender, recipient: run, thread_id: null, body: m.body, created_at: 0 })), gates: [] })}\n`);
    }
    if (a === 'ack') {
      if (!state.held || String(state.held.id) !== b) return out('', 1, `orchestra ack: lot ${b} is not an outstanding lot for ${run} in run ${run} (already acked, unknown id, or another reader's lot)\n`);
      state.cursor = state.held.to; state.held = null; return out(`acked ${b}\n`);
    }
    if (a === 'send') {
      const to = args[args.indexOf('--to') + 1];
      const text = args.slice(args.indexOf('--') + 1).join(' ');
      if (!d.world.impls.has(to) && !d.world.revs.has(to)) return out('', 1, `orchestra send: ${to} is not a live workspace\n`);
      if (/^CONNECT /.test(text)) d.world.wakeImpl(to, text); else d.world.answerImpl(to, text);
      return out('');
    }
    return out('', 1, `fake cli: unsupported: ${args.join(' ')}`);
  };
  const host: Host = async (body) => body.op === 'live' ? { ok: true, op: 'live', live: (body.ids as string[]).filter((id) => d.world.impls.has(id) || d.world.revs.has(id)) } : { ok: false, error: 'unsupported' };
  return { cli, host, lots, calls, fail };
}
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
    assert.deepEqual(r1.started.map((x) => x.ticket).sort(), ['T1', 'T2']);
    const r2 = await h.fleet.start();
    assert.deepEqual(r2.started, [], 'nothing started twice');
    assert.equal(h.world.events.filter((e) => e.ev === 'spawn').length, 2);
    assert.ok(h.fleet.live(wsOf(h, 'T1')) && h.fleet.live(wsOf(h, 'T2')));
    assert.equal(h.fleet.live('ws-not-ours'), false);
  }],
  ['mail: the run\'s messages once, in order, `ask` as `ask`; a second read brings nothing', async (h) => {
    await h.fleet.start();
    const w1 = wsOf(h, 'T1'), w2 = wsOf(h, 'T2');
    h.world.post('ask', w1, 'T1', 'Which name?');
    h.world.post('status', w2, 'T2', 'nominated');
    h.world.post('worker_done', w1, 'T1', 'done');
    const m = await h.fleet.mail();
    assert.deepEqual(m.map((x) => [x.seq, x.kind, x.sender]), [[1, 'ask', w1], [2, 'status', w2], [3, 'worker_done', w1]]);
    assert.deepEqual(m.map((x) => x.body), ['Which name?', 'nominated', 'done']);
    assert.deepEqual(await h.fleet.mail(), []);
    h.world.post('status', w1, 'T1', 'later');
    assert.deepEqual((await h.fleet.mail()).map((x) => x.body), ['later']);
  }],
  ['wake / send: the ask to connect and the fixed answer REACH the agent', async (h) => {
    await h.fleet.start();
    const w1 = wsOf(h, 'T1'), w2 = wsOf(h, 'T2');
    const head = sha40();
    await h.fleet.wake(w2, `CONNECT T1 ${head}\nT2: connect once`);
    assert.ok(h.world.events.some((e) => e.ev === 'connect-ask' && e.ticket === 'T2' && e.head === head), 'the agent got the ask');
    await h.fleet.send(w1, FIXED_ANSWER, 'answer');
    assert.ok(h.world.events.some((e) => e.ev === 'send' && e.kind === 'answer' && e.text === FIXED_ANSWER && e.to === w1), 'the agent got the answer');
  }],
  ['spawnReviewer: one reviewer per head — the same head answers the same id and spawns nothing; a new head wakes the same reviewer', async (h) => {
    await h.fleet.start();
    const head = h.world.commit([h.world.branches.get('main')!], 'T1:c', 'T1:c');
    updateState(stateFile(h.home, h.run), (s) => applyTicketPatch(s!, 'T1', { head, status: 'nominated', pr: 1 }, NOW, { tree: 'tree-1' }));
    const r1 = await h.fleet.spawnReviewer('T1', head);
    assert.ok(r1.id);
    assert.deepEqual(await h.fleet.spawnReviewer('T1', head), r1, 'the same head: the same reviewer');
    assert.equal(h.world.events.filter((e) => e.ev === 'review-spawn').length, 1, 'ONE reviewer spawned');
    const head2 = h.world.commit([head], 'T1:d', 'T1:d');
    updateState(stateFile(h.home, h.run), (s) => applyTicketPatch(s!, 'T1', { head: head2 }, NOW, { tree: 'tree-2' }));
    assert.deepEqual(await h.fleet.spawnReviewer('T1', head2), r1, 'a new head wakes the SAME reviewer');
    assert.equal(h.world.events.filter((e) => e.ev === 'review-spawn').length, 1);
    assert.ok(h.world.events.some((e) => e.ev === 'review-wake'));
  }],
  ['costOf: a count of tokens for a ticket that worked, never a throw', async (h) => {
    await h.fleet.start();
    const c = await h.fleet.costOf('T1');
    assert.ok(c === null || (Number.isFinite(c.tokens) && c.tokens >= 0));
  }],
];
for (const kind of ['dummy', 'live'] as const) for (const [name, arm] of fleetArms) test(`FleetPort [${kind}] ${name}`, async () => { await arm(await fleetHarness(kind)); });

test('FleetPort MUST-FAIL: the arms fail on a fleet that starts twice, re-reads the same mail, drops the answer, or spawns a reviewer per call', async () => {
  const breakers: Array<[string, (f: FleetPort) => FleetPort]> = [
    ['start', (f) => ({ ...f, start: async () => { await f.start(); return f.start().then((r) => ({ ...r, started: [{ ticket: 'T1', ws: 'x', branch: 'x' }] })); } })],
    ['mail', (f) => { let all: Awaited<ReturnType<FleetPort['mail']>> = []; return { ...f, mail: async () => { all = [...all, ...(await f.mail())]; return all; } }; }],
    ['wake / send', (f) => ({ ...f, send: async () => undefined })],
    ['spawnReviewer', (f) => ({ ...f, spawnReviewer: async (t, h) => { const a = await f.spawnReviewer(t, h); return { id: `${a.id}-${Math.random()}` }; } })],
  ];
  for (const kind of ['dummy', 'live'] as const) for (const [key, brk] of breakers) {
    const arm = fleetArms.find(([n]) => n.startsWith(key))![1];
    const h = await fleetHarness(kind);
    await mustFail(`${kind}/${key}`, { ...h, fleet: brk(h.fleet) }, arm);
  }
});

// ════════════════════════════════════════ what only the LIVE ports do ════════════════════════════════════════
test('live fleet: an unacked lot is READ AGAIN after a kill (at-least-once), acked only once the next pass starts; `question` reads as `ask`', async () => {
  const h = await fleetHarness('live');
  await h.fleet.start();
  h.world.post('ask', wsOf(h, 'T1'), 'T1', 'Q?');
  assert.equal((await h.fleet.mail()).length, 1);
  assert.equal(h.bus.calls.filter((c) => c[0] === 'ack').length, 0, 'not acked while the pass is running');
  const again = await createLiveFleet({ run: 'fl', caller: 'fl', cli: h.bus.cli, host: (await fleetHarness('live')).bus.host, readState: () => readState(stateFile(h.home, h.run)) }); // a restarted loop = a new port on the same bus
  assert.deepEqual((await again.mail()).map((m) => m.body), ['Q?'], 'the killed loop never acked it: the next one reads it');
  assert.deepEqual(await again.mail(), [], 'and acks it when ITS next pass starts');
  assert.equal(h.bus.calls.filter((c) => c[0] === 'ack').length, 1);
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
  const seen: Array<{ n: number; head: string }> = [];
  const h = liveForge(async (i) => { seen.push(i); return { ok: false, reason: 'ci-red', detail: 'check "test" is red' }; });
  const head = h.branch('T1');
  const { n } = await open(h, 'T1');
  await h.settle();
  assert.deepEqual(await h.port.merge(n, head), { ok: false, reason: 'ci-red', detail: 'check "test" is red' });
  assert.deepEqual(seen, [{ n, head }]);
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
