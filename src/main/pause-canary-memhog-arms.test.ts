// Pause canary 1b (#324) — every proof arm that names an `expectDetail` is checked against the text the REAL bars print for the scenario that arm creates (review 2, finding 3: control:chain-cap-off's regex
// no longer matched its bar's detail, so the arm read UNEXPECTED on every run and the full proof could never PASS). A new arm with an `expectDetail` and no scenario here fails the coverage test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error — plain .mjs harness module, no declaration file
import { PROOF_ARMS } from '../../scripts/pause-canary/memhog-arms.mjs';
// @ts-expect-error — plain .mjs harness module, no declaration file
import { evaluateMemhogCycle, evaluateChainRun, evaluateSurvivors } from '../../scripts/pause-canary/memhog-bars.mjs';

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
  'control:sabotage-session': () => evaluateMemhogCycle(cycle({ session: { keeperSame: true, cliSame: false, keeperAlive: true, cliAlive: false, answered: false, scopeActive: true, capState: 'active' } })),
  'control:sabotage-member-sink': () => evaluateMemhogCycle(cycle({ memberKillRows: [] })),
  'control:sabotage-coord-sink': () => evaluateMemhogCycle(cycle({ coordMsgs: [], coordRead: 0 })),
  'control:sabotage-stray-lead': () => evaluateMemhogCycle(cycle({}, { leadSeen: 3 })),
  'control:sabotage-leak': () => [evaluateSurvivors({ procs: 1, units: 0 })],
  'control:sabotage-leak-unit': () => [evaluateSurvivors({ procs: 0, units: 1 })],
  'control:sabotage-no-worker': () => evaluateMemhogCycle(cycle({ up: false })),
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
