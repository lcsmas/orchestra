// #614 (review 614 BLOCKING-1 / MAJOR-2) — the COMPOSED arm: the REAL `runLoop` on the live FLEET (over the fake `orchestra` CLI on the dummy world) and the live FORGE (over the fake `gh`), the merge through the shipped `deliver`
// (the real recorded-verdict reader, the real upstream-order rule). The ports in isolation passed while the composition could never merge (a green job without its step count is refused `zero-steps`): this is the arm that sees it.
// The git port stays the dummy's (the agents' commits live in the dummy world; the live git port has its own arms in the contract test).
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildDummy, type Scenario } from '../shared/fanout-loop-dummy.ts';
import { DEFAULT_OPTIONS, runLoop, type LoopDeps } from '../shared/fanout-loop.ts';
import { createLiveFleet } from '../shared/fanout-loop-live-fleet.ts';
import { createLiveForge } from '../shared/fanout-loop-live-forge.ts';
import { FakeForge } from '../shared/fanout-loop-live-fake-gh.ts';
import { fakeBus } from '../shared/fanout-loop-live-fake-bus.ts';
import { readState, stateFile } from '../shared/fanout-state.ts';
import { mergeThroughDeliver } from './fanout-run-live.ts';
import type { ForgePort } from '../shared/fanout-loop-ports.ts';

const made: string[] = [];
const tmp = (): string => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'fanout-composed-')); made.push(d); return d; };
after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });

const ONE: Scenario = { version: 1, run: 'cm1', repo: { tickets: [{ id: 'T1', dependsOn: [], spec: 'spec/T1.md' }] } };
const TWO: Scenario = { version: 1, run: 'cm2', repo: { tickets: [{ id: 'T1', dependsOn: [], spec: 'spec/T1.md' }, { id: 'T2', dependsOn: ['T1'], spec: 'spec/T2.md' }] } };

async function compose(sc: Scenario, o: { wrapForge?: (f: ForgePort) => ForgePort; ci?: Record<string, string[]> } = {}) {
  const home = tmp();
  const run = sc.run!;
  const d = buildDummy({ home, run, scenario: sc });
  const w = d.world;
  const fake = new FakeForge({
    heads: w.branches,
    onMerge: ({ base, head, branch }) => { const c = w.commit([w.branches.get(base)!, head], `merge:${branch}`, `merge:${branch}`); w.branches.set(base, c); return c; },
    contains: (base, head) => w.contains(base, head),
  });
  for (const [b, r] of Object.entries(o.ci ?? {})) fake.script.set(b, r);
  const bus = fakeBus(d, run, home);
  const readNow = () => readState(stateFile(home, run));
  const fleet = await createLiveFleet({ run, caller: run, cli: bus.cli, host: bus.host, readState: readNow, costOf: d.fleet.costOf });
  const sleep = async (ms: number): Promise<void> => { await d.sleep(ms); fake.advance(ms); };
  const logs: string[] = [];
  const deliver = mergeThroughDeliver({ home, run, log: (l) => logs.push(`deliver: ${l}`), deps: { gh: fake.gh, sleep, now: () => fake.clock } });
  let forge: ForgePort = createLiveForge({ gh: fake.gh, deliver, sleep, branchHead: d.git.head });
  if (o.wrapForge) forge = o.wrapForge(forge);
  const deps: LoopDeps = { home, run, caller: run, fleet, forge, git: d.git, now: d.now, sleep, log: (l) => logs.push(l), options: { ...DEFAULT_OPTIONS, plan: d.plan, tickets: sc.repo.tickets.map((t) => t.id), maxPasses: 4000, stallMs: 3 * 3_600_000 } };
  const result = await runLoop(deps);
  return { result, fake, logs, home, run, world: w };
}
const merges = (fake: FakeForge): number => fake.calls.filter((c) => c[0] === 'pr' && c[1] === 'merge').length;

test('composed: ONE ticket is delivered by the real loop on the live fleet + live forge, through deliver, as a MERGE COMMIT (exit 0)', async () => {
  const r = await compose(ONE);
  assert.equal(r.result.exit, 0, r.logs.slice(-8).join('\n'));
  assert.deepEqual(r.result.report.merged, ['T1']);
  assert.equal(merges(r.fake), 1);
  const call = r.fake.calls.find((c) => c[0] === 'pr' && c[1] === 'merge')!;
  assert.ok(call.includes('--merge') && call.includes('--match-head-commit'), call.join(' '));
  assert.equal([...r.fake.prs.values()][0].mergeParents, 2);
  assert.equal(r.fake.calls.filter((c) => c[0] === 'pr' && c[1] === 'create').length, 1, 'one PR per ticket');
});

test('composed: two tickets — the dependent is connected to its approved upstream, merged AFTER it, both by merge commit (deliver\'s upstream-order rule on the fake host)', async () => {
  const r = await compose(TWO);
  assert.equal(r.result.exit, 0, r.logs.slice(-10).join('\n'));
  assert.deepEqual([...r.result.report.merged].sort(), ['T1', 'T2']);
  const ticketOfPr = (n: number): string => { const br = [...r.fake.prs.values()].find((p) => p.n === n)!.branch; return /t1/i.test(br) ? 'T1' : 'T2'; };
  const order = r.fake.calls.filter((c) => c[0] === 'pr' && c[1] === 'merge').map((c) => ticketOfPr(Number(c[2])));
  assert.deepEqual(order, ['T1', 'T2'], `merge order (branches: ${[...r.fake.prs.values()].map((p) => p.branch).join(', ')})`);
  assert.ok(r.world.events.filter((e) => e.ev === 'connect-ask').length >= 1, 'T2 was asked to connect');
});

test('composed MUST-FAIL (the review\'s measured failure): a forge that reports no step count never merges — the loop ends parked, nothing was merged', async () => {
  const r = await compose(ONE, { wrapForge: (f) => ({ ...f, checks: async (n, h) => (await f.checks(n, h)).map(({ steps: _s, ...c }) => c) }) });
  assert.notEqual(r.result.exit, 0);
  assert.equal(merges(r.fake), 0);
  assert.deepEqual(r.result.report.merged, []);
});

test('composed MUST-FAIL: a CI that stays red on the head is never merged (the loop parks the ticket, exit 3, nothing merged)', async () => {
  const r = await compose(ONE, { ci: { 'impl-T1': ['red:test', 'red:test', 'red:test', 'red:test'] } });
  assert.equal(r.result.exit, 3, r.logs.slice(-6).join('\n'));
  assert.equal(merges(r.fake), 0);
  assert.deepEqual(r.result.report.merged, []);
});
