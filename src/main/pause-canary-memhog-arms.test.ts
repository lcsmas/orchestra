// Pause canary 1b (#324) — every proof arm that names an `expectDetail` is checked against the text the REAL bars print for the scenario that arm creates (review 2, finding 3: control:chain-cap-off's regex
// no longer matched its bar's detail, so the arm read UNEXPECTED on every run and the full proof could never PASS). A new arm with an `expectDetail` and no scenario here fails the coverage test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error — plain .mjs harness module, no declaration file
import { PROOF_ARMS } from '../../scripts/pause-canary/memhog-arms.mjs';
// @ts-expect-error — plain .mjs harness module, no declaration file
import { evaluateMemhogCycle, evaluateChainRun, evaluateSurvivors, REQUIRED_CYCLE_CHECKS } from '../../scripts/pause-canary/memhog-bars.mjs';

type Check = { id: string; ok: boolean; detail: string };
type W = Record<string, any>;
const OPS = 'aaaaaaaa-0000-4000-8000-000000000002';
const CAP = 0.25;
const capBytes = Math.round(CAP * 1024 ** 3);
const worker = (i: number, over: W = {}): W => {
  const id = `aaaaaaaa-0000-4000-8000-0000000000${10 + i}`;
  const marker = `memhog-w${i}-c1`;
  return {
    k: `w${i}`, id, up: true, marker,
    scope: { inRig: true, unit: `orchestra-rig-wh-h3-${id}-x.scope`, memoryMax: capBytes, swapMax: '0', high: 'max', policy: 'continue' },
    swarm: { children: 1, killed: 1, survived: 0 },
    oomKillDelta: 1,
    records: [{ level: 'hard', command: `python3 swarm.py 1 400 5 ${marker}`, source: 'kernel' }],
    session: { keeperSame: true, cliSame: true, keeperAlive: true, cliAlive: true, answered: true, scopeActive: true, capState: 'active' },
    memberKillRows: [`Command "python3 swarm.py 1 400 5 ${marker}" killed: Plafond mémoire 0.25 GB reached`],
    coordMsgs: [{ kind: 'escalation', recipient: OPS, body: `w${i} (${id}): python3 swarm.py killed at the hard level (0.25 GB)` }],
    coordRead: 1,
    backstop: { kLeafKills: 0, beyondWorkKills: 0 },
    ...over,
  };
};
/** A 3-worker cycle in which worker 1 carries `w1Over` and the cycle itself `over`. */
const cycle = (w1Over: W = {}, over: W = {}) => ({
  exercise: 'memhog', cycle: 1, expectWorkers: 3, capGb: CAP, opsId: OPS, leadSeen: 0, tMemberToldS: 1.2, tCoordToldS: 1.4,
  workers: [worker(1, w1Over), worker(2), worker(3)], ...over,
});

/** arm name → the checks the REAL bars print for the scenario that arm creates. */
const SCENARIOS: Record<string, () => Check[]> = {
  'control:hog-small': () => evaluateMemhogCycle(cycle({ swarm: { children: 1, killed: 0, survived: 1 }, oomKillDelta: 0, records: [], memberKillRows: [], coordMsgs: [], coordRead: 0 })),
  // measured on the real keeper: SIGTERM of the CLI takes the keeper with it, so the real detail reads « keeper GONE, CLI GONE »
  'control:sabotage-session': () => evaluateMemhogCycle(cycle({ session: { keeperSame: false, cliSame: false, keeperAlive: false, cliAlive: false, answered: false, scopeActive: false, capState: 'active' } })),
  'control:sabotage-member-sink': () => evaluateMemhogCycle(cycle({ memberKillRows: [] })),
  'control:sabotage-coord-sink': () => evaluateMemhogCycle(cycle({ coordMsgs: [], coordRead: 0 })),
  'control:sabotage-stray-lead': () => evaluateMemhogCycle(cycle({}, { leadSeen: 3 })),
  'control:sabotage-leak': () => [evaluateSurvivors({ procs: 1, units: 0 })],
  'control:sabotage-leak-unit': () => [evaluateSurvivors({ procs: 0, units: 1 })],
  'control:sabotage-no-worker': () => evaluateMemhogCycle(cycle({ up: false })),
  // #343 witness: the keeper leaf squeezed, the kernel kills inside k (a k-leaf oom_kill) — and the session dies with it
  'control:sabotage-backstop': () => evaluateMemhogCycle(cycle({ backstop: { kLeafKills: 1, beyondWorkKills: 1 }, session: { keeperSame: true, cliSame: false, keeperAlive: true, cliAlive: false, answered: false, scopeActive: true, capState: 'active' } })),
  // the same witness mid-chain: counters unreadable is not what the arm wants, a measured episode is
  'control:chain-backstop': () => evaluateChainRun({ planned: 30, done: 4, killsTotal: 3, lostAfter: 3, backstop: { kLeafKills: 1, beyondWorkKills: 1 }, keeperAlive: true, cliAlive: false, answered: false, inScope: true, cliSeen: true }),
  // the Q9 instrument with the cap OFF: no capped scope, no kill, the keeper and the CLI alive and answering
  'control:chain-cap-off': () => evaluateChainRun({ planned: 5, done: 5, killsTotal: 0, lostAfter: null, keeperAlive: true, cliAlive: true, answered: true, inScope: false, cliSeen: true }),
};

test('every proof arm with an expectDetail has a scenario here, and its regex matches the detail the REAL bar prints for it (on a RED check the arm names)', () => {
  const withDetail = PROOF_ARMS.filter((a: W) => a.expectDetail);
  assert.deepEqual(withDetail.map((a: W) => a.name).sort(), Object.keys(SCENARIOS).sort(), 'a new expectDetail arm needs a scenario (or an arm lost its regex)');
  for (const arm of withDetail) {
    const checks = SCENARIOS[arm.name]();
    // stricter than the runner (which accepts ONE hit): EVERY instrument the arm names must read RED with a detail its regex matches, so an alternation cannot hide a branch that stopped matching
    for (const id of arm.redden ?? []) {
      const named = checks.filter((c) => !c.ok && c.id === id);
      assert.ok(named.length > 0, `${arm.name}: ${id} is not RED in its scenario (RED: ${checks.filter((c) => !c.ok).map((c) => c.id).join(', ') || 'none'})`);
      assert.ok(named.some((c) => !/NOT MEASURED/.test(c.detail) && arm.expectDetail.test(c.detail)), `${arm.name}: ${arm.expectDetail} matches none of ${id}: ${named.map((c) => JSON.stringify(c.detail)).join(' ; ')}`);
    }
  }
});

test('POSITIVE CONTROL: the match is not vacuous — an arm\'s regex does NOT match another arm\'s detail', () => {
  const chain = SCENARIOS['control:chain-cap-off']().find((c) => c.id === 'premise_chain_killed_tools')!;
  const small = PROOF_ARMS.find((a: W) => a.name === 'control:hog-small');
  assert.equal(small.expectDetail.test(chain.detail), false);
  assert.equal(/^0 kernel kill/.test(chain.detail), false, 'the OLD chain regex (review 2) does not match the premise detail: the test can say no');
});

test('control:chain-cap-off\'s regex is anchored: a BROKEN rig (the CLI never initialised, or the chain cut short) does not read as the expected cap-off VOID', () => {
  const arm = PROOF_ARMS.find((a: W) => a.name === 'control:chain-cap-off');
  const detail = (o: W) => evaluateChainRun({ planned: 30, done: 30, killsTotal: 0, lostAfter: null, keeperAlive: true, cliAlive: true, answered: true, inScope: false, cliSeen: true, ...o }).find((c: Check) => c.id === 'premise_chain_killed_tools')!.detail;
  assert.match(detail({}), arm.expectDetail, 'the real cap-OFF chain: 30 of 30 tools, nothing killed');
  assert.doesNotMatch(detail({ cliSeen: false, done: 1, cliAlive: false, answered: false, lostAfter: 0 }), arm.expectDetail, 'CLI never initialised');
  assert.doesNotMatch(detail({ done: 12 }), arm.expectDetail, 'chain cut short (12 of 30)');
  assert.doesNotMatch(detail({ done: 30, lostAfter: 0, keeperAlive: false, cliAlive: false, answered: false }), arm.expectDetail, 'session lost');
});

test('every proof arm is internally consistent: must-FAIL arms name something to redden, redden and stayGreen are disjoint, and every named id is one the bars really produce', () => {
  const m = cycle();
  const known = new Set<string>([...evaluateMemhogCycle(m).map((c: Check) => c.id), ...REQUIRED_CYCLE_CHECKS, 'bar:no_survivors', 'bar:live_config_untouched', 'premise_chain_killed_tools', 'q9:session_survives_chain']);
  for (const a of PROOF_ARMS as W[]) {
    if (a.internal) continue;
    if (a.sabotage || a.switch === 'off') assert.ok((a.redden ?? []).length > 0, `${a.name}: a must-FAIL arm names no instrument to redden`);
    for (const id of a.redden ?? []) assert.ok(known.has(id), `${a.name}: redden names an id the bars never produce: ${id}`);
    for (const id of a.stayGreen ?? []) assert.ok(known.has(id), `${a.name}: stayGreen names an id the bars never produce: ${id}`);
    assert.deepEqual((a.redden ?? []).filter((id: string) => (a.stayGreen ?? []).includes(id)), [], `${a.name}: an id cannot be both RED and GREEN`);
    for (const id of a.reddenAny ?? []) assert.ok(known.has(id) || id.startsWith('published:'), `${a.name}: reddenAny names ${id}`);
  }
  // control: a clean arm has nothing to redden, and the table does carry the must-FAIL arms this test is about
  assert.equal((PROOF_ARMS as W[]).filter((a) => a.sabotage || a.switch === 'off').length >= 8, true);
});

test('chain arms: every one states the verdict it expects — a sabotage never expects PASS, the clean chain does, the cap-OFF chain is a VOID', () => {
  const chain = (PROOF_ARMS as W[]).filter((a) => a.exercise === 'chain');
  assert.deepEqual(chain.map((a) => a.name).sort(), ['chain:q9', 'control:chain-backstop', 'control:chain-cap-off']);
  for (const a of chain) assert.ok(['PASS', 'FAIL', 'VOID'].includes(a.expectVerdict), `${a.name}: expectVerdict ${a.expectVerdict}`);
  assert.equal(chain.find((a) => a.name === 'chain:q9')!.expectVerdict, 'PASS');
  assert.equal(chain.find((a) => a.name === 'control:chain-backstop')!.expectVerdict, 'FAIL');
  assert.equal(chain.find((a) => a.name === 'control:chain-cap-off')!.expectVerdict, 'VOID');
  assert.equal(chain.find((a) => a.name === 'control:chain-backstop')!.sabotage, 'backstop');
  assert.ok((PROOF_ARMS as W[]).some((a) => a.name === 'control:sabotage-backstop' && a.sabotage === 'backstop' && a.redden.includes('bar:no_backstop_kill')), 'the memhog-cycle witness of #343 exists');
  assert.ok(!(PROOF_ARMS as W[]).some((a) => /known-red/.test(a.name)), 'no KNOWN-RED arm is left: Q9 is a bar');
});

test('control:sabotage-session\'s regex matches BOTH shapes of the measured detail (keeper gone with the CLI, or the CLI alone) and nothing else', () => {
  const arm = (PROOF_ARMS as W[]).find((a) => a.name === 'control:sabotage-session')!;
  assert.match('w1: keeper GONE, CLI GONE, the CLI no longer answers a tool command', arm.expectDetail);
  assert.match('w1: CLI GONE, the CLI no longer answers a tool command', arm.expectDetail);
  assert.match('w1: keeper REPLACED, CLI REPLACED', arm.expectDetail);
  assert.doesNotMatch('w1: keeper GONE', arm.expectDetail, 'a keeper loss without the CLI is not this sabotage');
  assert.doesNotMatch('w2: CLI GONE', arm.expectDetail, 'the sabotage targets the first worker');
});

test('the #343 witness arm does not demand cap_scope_applied green: the squeezed keeper leaf takes the whole session and the scope vanishes (measured)', () => {
  const arm = (PROOF_ARMS as W[]).find((a) => a.name === 'control:sabotage-backstop')!;
  assert.ok(!arm.stayGreen.includes('bar:cap_scope_applied'));
  assert.deepEqual(arm.redden, ['bar:no_backstop_kill']);
});
