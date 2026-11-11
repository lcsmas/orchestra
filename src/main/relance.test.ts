// #427 — the Relance sweep, observed the way the fleet observes it: a turn delivered to a member or not. Fakes for the roster, the census, the clock and the delivery;
// the decision itself is pinned in shared/relance.test.ts. Every exclusion has a must-FAIL arm over the SAME fixture that fires when the exclusion is removed.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  RELANCE_RETRY_MS,
  __resetRelanceForTests,
  relanceCounters,
  sweepRelance,
  sweepRelanceNow,
  type RelanceDelivery,
  type RelanceDeps,
} from './relance.ts';
import { __resetHostStoppedForTests, noteHostStopped } from './relance-stopped.ts';
import { RELANCE_GROUP_MS, RELANCE_MIN_AGE_MS, isRelance, type RelanceCensus, type RelanceMember, type RelanceProc } from '../shared/relance.ts';

const P = (pid: number, ppid = 1, cmd = `proc-${pid}`): RelanceProc => ({ pid, ppid, startTicks: pid * 10, comm: cmd.split(' ')[0], cmd });
const SCRIPT = P(10, 1, 'bash /work/run-chain.sh');
const SERVER = P(30, 1, 'node dev-server.js');

interface Rig {
  deps: RelanceDeps;
  clock: { t: number };
  members: Map<string, RelanceMember>;
  census: Map<string, RelanceCensus>;
  turns: Array<{ wsId: string; text: string }>;
  outcome: { next: RelanceDelivery };
}
function rig(): Rig {
  const clock = { t: 1_000_000 };
  const members = new Map<string, RelanceMember>();
  const census = new Map<string, RelanceCensus>();
  const turns: Rig['turns'] = [];
  const outcome = { next: 'sent' as RelanceDelivery };
  const deps: RelanceDeps = {
    now: () => clock.t,
    members: () => [...members.values()],
    census: (id) => census.get(id) ?? [],
    deliver: async (wsId, text) => {
      if (outcome.next === 'sent') turns.push({ wsId, text });
      return outcome.next;
    },
  };
  return { deps, clock, members, census, turns, outcome };
}
const member = (wsId: string, over: Partial<RelanceMember> = {}): RelanceMember => ({
  wsId, hasCoordinator: true, hasTask: true, released: false, paused: false, wakeable: true, active: false, ...over,
});
/** Baseline (the script lives), then it ends; returns after the grouping window has passed and one more sweep ran. */
async function endAndWait(r: Rig, wsId = 'm1', surviving: RelanceProc[] = []): Promise<void> {
  r.census.set(wsId, [SCRIPT, ...surviving]);
  await sweepRelance(r.deps);
  r.clock.t += RELANCE_MIN_AGE_MS;
  r.census.set(wsId, surviving);
  await sweepRelance(r.deps); // the end is seen here
  r.clock.t += RELANCE_GROUP_MS;
  await sweepRelance(r.deps);
}

beforeEach(() => {
  __resetRelanceForTests();
  __resetHostStoppedForTests();
});

test('positive control: a member idle with a task whose detached script ends gets ONE turn naming the script', async () => {
  const r = rig();
  r.members.set('m1', member('m1'));
  await endAndWait(r);
  assert.equal(r.turns.length, 1);
  assert.equal(r.turns[0].wsId, 'm1');
  assert.ok(isRelance(r.turns[0].text));
  assert.match(r.turns[0].text, /bash \/work\/run-chain\.sh/);
  assert.equal(relanceCounters().fired, 1);
});

test('control arm: while the script is still alive nobody gets anything, however long it runs', async () => {
  const r = rig();
  r.members.set('m1', member('m1'));
  r.census.set('m1', [SCRIPT]);
  for (let i = 0; i < 20; i++) {
    await sweepRelance(r.deps);
    r.clock.t += 60_000;
  }
  assert.equal(r.turns.length, 0);
});

test('the turn comes AFTER the grouping window, not at the end itself', async () => {
  const r = rig();
  r.members.set('m1', member('m1'));
  r.census.set('m1', [SCRIPT]);
  await sweepRelance(r.deps);
  r.clock.t += RELANCE_MIN_AGE_MS;
  r.census.set('m1', []);
  await sweepRelance(r.deps);
  assert.equal(r.turns.length, 0, 'seen, but the window has not passed');
  r.clock.t += RELANCE_GROUP_MS - 1;
  await sweepRelance(r.deps);
  assert.equal(r.turns.length, 0);
  r.clock.t += 1;
  await sweepRelance(r.deps);
  assert.equal(r.turns.length, 1);
});

test('the end of ONE process triggers it while another keeps running: the survivor is listed as still running', async () => {
  const r = rig();
  r.members.set('m1', member('m1'));
  await endAndWait(r, 'm1', [SERVER]);
  assert.equal(r.turns.length, 1);
  assert.match(r.turns[0].text, /still running/i);
  assert.match(r.turns[0].text, /node dev-server\.js/);
});

test('several ends close together produce ONE turn listing all of them, not one per process', async () => {
  const r = rig();
  r.members.set('m1', member('m1'));
  const B = P(11, 1, 'node rig-browser.js');
  const C = P(12, 1, 'sh watcher.sh');
  r.census.set('m1', [SCRIPT, B, C, SERVER]);
  await sweepRelance(r.deps);
  r.clock.t += RELANCE_MIN_AGE_MS;
  r.census.set('m1', [B, C, SERVER]);
  await sweepRelance(r.deps);
  r.clock.t += 4_000;
  r.census.set('m1', [C, SERVER]);
  await sweepRelance(r.deps);
  r.clock.t += 4_000;
  r.census.set('m1', [SERVER]);
  await sweepRelance(r.deps);
  r.clock.t += RELANCE_GROUP_MS;
  await sweepRelance(r.deps);
  r.clock.t += 120_000;
  await sweepRelance(r.deps);
  assert.equal(r.turns.length, 1, 'exactly one');
  for (const s of ['run-chain.sh', 'rig-browser.js', 'watcher.sh']) assert.match(r.turns[0].text, new RegExp(s.replace('.', '\\.')));
  assert.match(r.turns[0].text, /node dev-server\.js/, 'the one that still runs');
});

test('a chain\'s own children coming and going never trigger a turn (only a root ending does)', async () => {
  const r = rig();
  r.members.set('m1', member('m1'));
  const kid = (pid: number) => P(pid, 10, `pnpm test-${pid}`);
  r.census.set('m1', [SCRIPT, kid(11)]);
  await sweepRelance(r.deps);
  for (let pid = 12; pid < 20; pid++) {
    r.clock.t += RELANCE_MIN_AGE_MS + 1_000; // each child outlives the minimum age: only « being a child of a live root » spares it
    r.census.set('m1', [SCRIPT, kid(pid)]);
    await sweepRelance(r.deps);
  }
  r.clock.t += 120_000;
  await sweepRelance(r.deps);
  assert.equal(r.turns.length, 0);
});

const EXCLUSIONS: Array<[string, Partial<RelanceMember>]> = [
  ['a member whose task is finished and released', { released: true }],
  ['a member with no dispatched task', { hasTask: false }],
  ['a workspace without a coordinator', { hasCoordinator: false }],
  ['a member of a paused run', { paused: true }],
  ['a member that cannot be woken', { wakeable: false }],
];
for (const [label, over] of EXCLUSIONS) {
  test(`must-FAIL arm — no turn for ${label}; the same fixture WITHOUT the exclusion gets one`, async () => {
    const off = rig();
    off.members.set('m1', member('m1', over));
    await endAndWait(off);
    assert.equal(off.turns.length, 0);
    const on = rig();
    __resetRelanceForTests();
    on.members.set('m1', member('m1'));
    await endAndWait(on);
    assert.equal(on.turns.length, 1);
  });
}

test('must-FAIL arm — an ACTIVE member gets no turn while active; the same end fires once it is idle', async () => {
  const r = rig();
  r.members.set('m1', member('m1', { active: true }));
  await endAndWait(r);
  assert.equal(r.turns.length, 0);
  r.members.set('m1', member('m1', { active: false }));
  r.clock.t += 5_000;
  await sweepRelance(r.deps);
  assert.equal(r.turns.length, 1);
});

test('an end during the member\'s own turn is announced once it is idle (the turn may have ended « waiting for the rig »)', async () => {
  const r = rig();
  r.members.set('m1', member('m1', { active: true }));
  r.census.set('m1', [SCRIPT]);
  await sweepRelance(r.deps);
  r.clock.t += RELANCE_MIN_AGE_MS;
  r.census.set('m1', []);
  await sweepRelance(r.deps); // seen while active: kept
  r.clock.t += 60_000; // the turn ends much later
  await sweepRelance(r.deps);
  assert.equal(r.turns.length, 0, 'still active');
  r.members.set('m1', member('m1', { active: false }));
  r.clock.t += 5_000;
  await sweepRelance(r.deps);
  assert.equal(r.turns.length, 1);
});

test('a Reliquat the HOST stopped (Veille / Pause) is not an end: no turn', async () => {
  const r = rig();
  r.members.set('m1', member('m1'));
  r.census.set('m1', [SCRIPT]);
  await sweepRelance(r.deps);
  noteHostStopped([SCRIPT], r.clock.t);
  r.clock.t += RELANCE_MIN_AGE_MS;
  r.census.set('m1', []);
  await sweepRelance(r.deps);
  r.clock.t += RELANCE_GROUP_MS * 3;
  await sweepRelance(r.deps);
  assert.equal(r.turns.length, 0);
});

test('an unreadable census is not an end, and does not forget the script that was running', async () => {
  const r = rig();
  r.members.set('m1', member('m1'));
  r.census.set('m1', [SCRIPT]);
  await sweepRelance(r.deps);
  r.census.set('m1', 'unknown');
  for (let i = 0; i < 6; i++) {
    r.clock.t += 5_000;
    await sweepRelance(r.deps);
  }
  assert.equal(r.turns.length, 0);
  r.census.set('m1', []);
  r.clock.t += 5_000;
  await sweepRelance(r.deps);
  r.clock.t += RELANCE_GROUP_MS;
  await sweepRelance(r.deps);
  assert.equal(r.turns.length, 1, 'the real end is still seen afterwards');
});

test('one Relance per group: later sweeps with nothing new send nothing', async () => {
  const r = rig();
  r.members.set('m1', member('m1'));
  await endAndWait(r);
  for (let i = 0; i < 10; i++) {
    r.clock.t += 60_000;
    await sweepRelance(r.deps);
  }
  assert.equal(r.turns.length, 1);
});

test('a delivery that FAILED keeps the ends and is retried after the back-off — not every sweep', async () => {
  const r = rig();
  r.members.set('m1', member('m1'));
  r.outcome.next = 'failed';
  await endAndWait(r);
  assert.equal(relanceCounters().failed, 1);
  r.outcome.next = 'sent';
  r.clock.t += RELANCE_RETRY_MS - 1_000;
  await sweepRelance(r.deps);
  assert.equal(r.turns.length, 0, 'still backing off');
  r.clock.t += 1_000;
  await sweepRelance(r.deps);
  assert.equal(r.turns.length, 1);
  assert.match(r.turns[0].text, /run-chain\.sh/, 'the original end, not lost');
});

test('a delivery HELD by Admission keeps the ends and is retried on the very next sweep (no failure back-off)', async () => {
  const r = rig();
  r.members.set('m1', member('m1'));
  r.outcome.next = 'held';
  await endAndWait(r);
  assert.equal(relanceCounters().held, 1);
  assert.equal(relanceCounters().failed, 0);
  r.outcome.next = 'sent';
  r.clock.t += 5_000;
  await sweepRelance(r.deps);
  assert.equal(r.turns.length, 1);
});

test('a member that vanishes from the roster loses its state (a re-created id starts from a fresh baseline)', async () => {
  const r = rig();
  r.members.set('m1', member('m1'));
  r.census.set('m1', [SCRIPT]);
  await sweepRelance(r.deps);
  r.members.clear();
  await sweepRelance(r.deps);
  r.members.set('m1', member('m1'));
  r.census.set('m1', []);
  r.clock.t += RELANCE_MIN_AGE_MS + 5_000;
  await sweepRelance(r.deps);
  r.clock.t += RELANCE_GROUP_MS;
  await sweepRelance(r.deps);
  assert.equal(r.turns.length, 0, 'no stale baseline: the script of the old life is not an end of the new one');
});

test('one member\'s throwing census does not stop the others', async () => {
  const r = rig();
  r.members.set('bad', member('bad'));
  r.members.set('m1', member('m1'));
  const base = r.deps.census;
  r.deps.census = (id) => {
    if (id === 'bad') throw new Error('boom');
    return base(id);
  };
  await endAndWait(r, 'm1');
  assert.equal(r.turns.length, 1);
  assert.equal(r.turns[0].wsId, 'm1');
});

test('must-FAIL arm — the orphans of a session that was just stopped (an MCP server, a tool child: alive a few seconds, then gone) never produce a turn', async () => {
  const r = rig();
  r.members.set('m1', member('m1'));
  r.census.set('m1', []);
  await sweepRelance(r.deps); // baseline: nothing
  for (const i of [1, 2, 3]) {
    r.clock.t += 5_000;
    r.census.set('m1', [P(500 + i, 1, `node mcp-server-${i}`)]); // alive for ONE look
    await sweepRelance(r.deps);
    r.clock.t += 5_000;
    r.census.set('m1', []);
    await sweepRelance(r.deps);
  }
  r.clock.t += RELANCE_GROUP_MS * 3;
  await sweepRelance(r.deps);
  assert.equal(r.turns.length, 0);
});

test('a delivery that HANGS does not stall the other members, is not repeated while pending, and its late result is applied', async () => {
  const r = rig();
  r.deps.deliverWaitMs = 30;
  r.members.set('hung', member('hung'));
  r.members.set('m1', member('m1'));
  let release: (v: RelanceDelivery) => void = () => {};
  const calls: string[] = [];
  const base = r.deps.deliver;
  r.deps.deliver = (id, text) => {
    calls.push(id);
    return id === 'hung' ? new Promise<RelanceDelivery>((res) => { release = res; }) : base(id, text);
  };
  const LATE = P(11, 1, 'sh late-job.sh');
  r.census.set('hung', [SCRIPT, LATE]);
  r.census.set('m1', [SCRIPT]);
  await sweepRelance(r.deps);
  r.clock.t += RELANCE_MIN_AGE_MS;
  r.census.set('hung', [LATE]);
  r.census.set('m1', []);
  await sweepRelance(r.deps);
  r.clock.t += RELANCE_GROUP_MS;
  await sweepRelance(r.deps); // hung is tried first and waits 30 ms; m1 still gets its turn in the SAME pass
  assert.deepEqual(r.turns.map((t) => t.wsId), ['m1']);
  r.census.set('hung', []); // ANOTHER end lands while the first delivery is still pending
  r.clock.t += 5_000;
  await sweepRelance(r.deps);
  r.clock.t += RELANCE_GROUP_MS * 2;
  await sweepRelance(r.deps);
  assert.deepEqual(calls.filter((c) => c === 'hung'), ['hung'], 'not delivered a second time while the first is pending');
  release('failed'); // it finally fails: the ends are put back and the failure back-off applies
  await new Promise((res) => setImmediate(res));
  assert.equal(relanceCounters().failed, 1);
  r.clock.t += RELANCE_RETRY_MS;
  r.deps.deliver = base;
  await sweepRelance(r.deps);
  assert.deepEqual(r.turns.map((t) => t.wsId), ['m1', 'hung'], 'retried once');
  assert.match(r.turns[1].text, /run-chain\.sh/, 'with the original end');
  assert.match(r.turns[1].text, /late-job\.sh/, 'and the one that landed meanwhile — one turn, nothing lost');
});

test('sweepRelanceNow (the Admission release) waits for a pass in flight and then runs its own — it is never swallowed', async () => {
  const r = rig();
  r.members.set('m1', member('m1'));
  let gate: () => void = () => {};
  const base = r.deps.census;
  let first = true;
  r.deps.census = async (id) => {
    if (first) { first = false; await new Promise<void>((res) => { gate = res; }); }
    return base(id);
  };
  r.census.set('m1', [SCRIPT]);
  const running = sweepRelance(r.deps); // blocked inside the census
  const now = sweepRelanceNow(r.deps);
  let done = false;
  void now.then(() => { done = true; });
  await new Promise((res) => setTimeout(res, 30));
  assert.equal(done, false, 'waits for the pass in flight');
  gate();
  await running;
  await now;
  assert.equal(done, true);
});
