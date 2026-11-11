// #428 — the asleep-vague sweep, observed the way the fleet observes it: a Relance delivered to the COORDINATOR or not, and what `bus-status` would show. Fakes for the roster, the census, the
// clock and the delivery; the decision itself is pinned in shared/vague-endormie.test.ts. Every exclusion has a must-FAIL arm over the SAME fixture that fires when the exclusion is removed.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  VAGUE_SWEEP_MS,
  __resetVagueEndormieForTests,
  asleepVagues,
  sweepVagues,
  sweepVaguesNow,
  vagueCounters,
  type VagueDeps,
} from './vague-endormie.ts';
import { RELANCE_RETRY_MS, type RelanceDelivery } from './relance.ts';
import { VAGUE_PROCESS_BOUND_MS, VAGUE_QUIET_MS, formatAsleepVaguesLines, type VagueFacts, type VagueMember, type VagueParticipant } from '../shared/vague-endormie.ts';
import { isRelance, type RelanceCensus, type RelanceProc } from '../shared/relance.ts';

const MIN = 60_000;
const T0 = Date.UTC(2026, 10, 10, 22, 48);
const P = (pid: number, ppid = 1, cmd = `proc-${pid}`): RelanceProc => ({ pid, ppid, startTicks: pid * 10, comm: cmd.split(' ')[0], cmd });

const person = (wsId: string, over: Partial<VagueParticipant> = {}): VagueParticipant => ({ wsId, label: wsId, active: false, waiting: false, heldStart: false, lastActivityAt: T0, seenThisRun: true, ...over });
const member = (wsId: string, over: Partial<VagueMember> = {}): VagueMember => ({ ...person(wsId), task: `do ${wsId}`, unfinished: true, ...over });
const baseFacts = (over: Partial<VagueFacts> = {}): VagueFacts => ({
  runId: 'ops',
  coordinator: person('ops'),
  members: [member('impl'), member('verifier', { unfinished: false })],
  paused: false,
  runHeld: false,
  ...over,
});

interface Rig {
  deps: VagueDeps;
  clock: { t: number };
  vagues: Map<string, VagueFacts>;
  census: Map<string, RelanceCensus>;
  turns: Array<{ wsId: string; text: string }>;
  outcome: { next: RelanceDelivery };
  censusReads: string[];
}
function rig(): Rig {
  const clock = { t: T0 };
  const vagues = new Map<string, VagueFacts>([['ops', baseFacts()]]);
  const census = new Map<string, RelanceCensus>();
  const turns: Rig['turns'] = [];
  const outcome = { next: 'sent' as RelanceDelivery };
  const censusReads: string[] = [];
  const deps: VagueDeps = {
    now: () => clock.t,
    vagues: () => [...vagues.values()],
    vague: (id) => vagues.get(id),
    census: (id) => {
      censusReads.push(id);
      return census.get(id) ?? [];
    },
    deliver: async (wsId, text) => {
      if (outcome.next === 'sent') turns.push({ wsId, text });
      return outcome.next;
    },
  };
  return { deps, clock, vagues, census, turns, outcome, censusReads };
}
/** Sweep every `VAGUE_SWEEP_MS` for `ms` of clock. */
async function advance(r: Rig, ms: number): Promise<void> {
  const end = r.clock.t + ms;
  while (r.clock.t < end) {
    await sweepVagues(r.deps);
    r.clock.t += VAGUE_SWEEP_MS;
  }
  r.clock.t = end;
  await sweepVagues(r.deps);
}
const set = (r: Rig, f: VagueFacts): void => void r.vagues.set(f.runId, f);

beforeEach(() => __resetVagueEndormieForTests());

test('REPLAY 2026-11-10: members idle, a fix uncommitted, no process alive — nobody is told at 9 min; at 10 min the COORDINATOR gets ONE Relance with the remaining task and the times', async () => {
  const r = rig();
  set(r, baseFacts({ members: [member('impl', { task: 'push and re-nominate the bloc-html fix', lastActivityAt: T0 }), member('verifier', { unfinished: false, lastActivityAt: T0 - 3 * MIN })] }));
  await advance(r, 9 * MIN);
  assert.equal(r.turns.length, 0);
  await advance(r, MIN);
  assert.equal(r.turns.length, 1);
  assert.equal(r.turns[0].wsId, 'ops', 'the coordinator, nobody else');
  assert.ok(isRelance(r.turns[0].text));
  assert.match(r.turns[0].text, /push and re-nominate the bloc-html fix/);
  assert.match(r.turns[0].text, /asleep since 22:48:00 UTC/);
  assert.match(r.turns[0].text, /impl — .* — last activity 22:48:00 UTC/);
  assert.equal(vagueCounters().declared, 1);
  assert.equal(vagueCounters().nudged, 1);
});

test('ONE Relance per asleep episode: 17 hours of sweeps later the coordinator was told exactly once', async () => {
  const r = rig();
  await advance(r, 17 * 60 * MIN);
  assert.equal(r.turns.length, 1);
  assert.equal(asleepVagues().length, 1);
});

test('the episode ends as soon as a MEMBER resumes; the next sleep is a new episode and the coordinator is told again', async () => {
  const r = rig();
  await advance(r, 11 * MIN);
  assert.equal(r.turns.length, 1);
  assert.equal(asleepVagues().length, 1);
  // a member resumes (a turn is running now)
  set(r, baseFacts({ members: [member('impl', { active: true }), member('verifier', { unfinished: false })] }));
  await advance(r, MIN);
  assert.equal(asleepVagues().length, 0, 'the episode is over');
  assert.equal(vagueCounters().ended, 1);
  // it ends its turn and nothing wakes it again
  const t1 = r.clock.t;
  set(r, baseFacts({ members: [member('impl', { lastActivityAt: t1 }), member('verifier', { unfinished: false })], coordinator: person('ops', { lastActivityAt: t1 }) }));
  await advance(r, 9 * MIN);
  assert.equal(r.turns.length, 1, 'not before a fresh full delay');
  await advance(r, 2 * MIN);
  assert.equal(r.turns.length, 2);
});

test('the coordinator\'s own turn (its Relance) does not end the episode: it is not nudged again when that turn ends', async () => {
  const r = rig();
  await advance(r, 11 * MIN);
  assert.equal(r.turns.length, 1);
  set(r, baseFacts({ coordinator: person('ops', { active: true, lastActivityAt: r.clock.t }) }));
  await advance(r, 2 * MIN);
  set(r, baseFacts({ coordinator: person('ops', { lastActivityAt: r.clock.t }) }));
  await advance(r, 5 * 60 * MIN);
  assert.equal(r.turns.length, 1);
});

// ── NOT asleep: each exclusion, observed as « nobody gets a turn », over the same fixture that DOES fire ──────────

const EXCLUSIONS: [string, VagueFacts][] = [
  ['a member is active', baseFacts({ members: [member('impl', { active: true })] })],
  ['a member waits for an ask, a gate or human input', baseFacts({ members: [member('impl', { waiting: true })] })],
  ['the coordinator waits for the human', baseFacts({ coordinator: person('ops', { waiting: true }) })],
  ['a start is held for memory', baseFacts({ members: [member('impl', { heldStart: true })] })],
  ['the run is paused', baseFacts({ paused: true })],
  ['the run is on hold', baseFacts({ runHeld: true })],
  ['every task is finished', baseFacts({ members: [member('impl', { unfinished: false })] })],
];
for (const [name, f] of EXCLUSIONS) {
  test(`NOT asleep — ${name}: no Relance in 3 hours, no census cost, not shown asleep`, async () => {
    const r = rig();
    set(r, f);
    await advance(r, 3 * 60 * MIN);
    assert.equal(r.turns.length, 0);
    assert.equal(asleepVagues().length, 0);
    assert.equal(r.censusReads.length, 0, 'the census is read only for a candidate');
  });
}
test('the control of the exclusions: the same vague without the blocker is told', async () => {
  const r = rig();
  await advance(r, 11 * MIN);
  assert.equal(r.turns.length, 1);
});

test('NOT asleep — a live process younger than one hour of inactivity: nobody is told for 59 minutes', async () => {
  const r = rig();
  r.census.set('impl', [P(10, 1, 'sh run-chain.sh')]);
  await advance(r, 59 * MIN);
  assert.equal(r.turns.length, 0);
  assert.equal(asleepVagues().length, 0);
});

test('a process alive for more than one hour without agent activity no longer protects: at the hour the coordinator is told, and the Relance names it', async () => {
  const r = rig();
  r.census.set('impl', [P(10, 1, 'sh run-chain.sh')]);
  await advance(r, VAGUE_PROCESS_BOUND_MS + MIN);
  assert.equal(r.turns.length, 1);
  assert.match(r.turns[0].text, /Processes still alive:/);
  assert.match(r.turns[0].text, /sh run-chain\.sh/);
  assert.equal(asleepVagues()[0].since, T0 + VAGUE_PROCESS_BOUND_MS);
});

test('a census that throws reads as UNKNOWN (never « none »): it protects for the hour, not forever', async () => {
  const r = rig();
  const real = r.deps.census;
  r.deps.census = (id) => {
    if (id === 'impl') throw new Error('cgroup gone');
    return real(id);
  };
  await advance(r, 59 * MIN);
  assert.equal(r.turns.length, 0);
  await advance(r, 2 * MIN);
  assert.equal(r.turns.length, 1);
  assert.match(r.turns[0].text, /could not be read/);
});

// ── bus-status ───────────────────────────────────────────────────────────────────────────────────────────────────

test('bus-status view: the asleep state and since when, the remaining tasks, whether the coordinator was told; gone when the episode ends', async () => {
  const r = rig();
  await advance(r, 5 * MIN);
  assert.deepEqual(asleepVagues(), [], 'not before the delay');
  await advance(r, 6 * MIN);
  const [v] = asleepVagues();
  assert.equal(v.runId, 'ops');
  assert.equal(v.coordinatorId, 'ops');
  assert.equal(v.since, T0);
  assert.equal(v.declaredAt, T0 + VAGUE_QUIET_MS);
  assert.equal(typeof v.nudgedAt, 'number');
  assert.deepEqual(v.unfinished, [{ wsId: 'impl', label: 'impl' }]);
  const [line] = formatAsleepVaguesLines(asleepVagues(), r.clock.t, 'ops');
  assert.match(line, /^vague endormie: ops \(this run\) — asleep since 2026-11-10T22:48:00Z \(11m ago\), 1 unfinished task \(impl\); coordinator relanced at 22:5\d:\d\d UTC$/);
  set(r, baseFacts({ members: [member('impl', { active: true })] }));
  await advance(r, MIN);
  assert.deepEqual(asleepVagues(), []);
});

test('bus-status says so when the Relance has not gone out yet (a failing delivery): « NOT told yet »', async () => {
  const r = rig();
  r.outcome.next = 'failed';
  await advance(r, 11 * MIN);
  assert.equal(asleepVagues()[0].nudgedAt, null);
  assert.match(formatAsleepVaguesLines(asleepVagues(), r.clock.t)[0], /coordinator NOT told yet/);
});

test('a healthy fleet prints nothing', () => {
  assert.deepEqual(formatAsleepVaguesLines([], Date.now()), []);
});

// ── delivery: failed / held / slow / fresh ───────────────────────────────────────────────────────────────────────

test('a FAILED delivery is retried after the back-off and goes out once the coordinator can be started', async () => {
  const r = rig();
  r.outcome.next = 'failed';
  await advance(r, 11 * MIN);
  assert.equal(r.turns.length, 0);
  assert.equal(vagueCounters().failed, 3, 'tried at 10:00, 10:30 and 11:00 — one try per back-off, not one per tick');
  r.outcome.next = 'sent';
  await advance(r, RELANCE_RETRY_MS + VAGUE_SWEEP_MS);
  assert.equal(r.turns.length, 1);
  assert.equal(vagueCounters().declared, 1, 'still ONE episode');
  await advance(r, 60 * MIN);
  assert.equal(r.turns.length, 1);
});

test('a HELD delivery (Admission, low memory) keeps the Relance owed: nothing is lost, it goes out when memory recovers', async () => {
  const r = rig();
  r.outcome.next = 'held';
  await advance(r, 15 * MIN);
  assert.equal(r.turns.length, 0);
  assert.ok(vagueCounters().held >= 1);
  r.outcome.next = 'sent';
  await sweepVaguesNow(r.deps);
  assert.equal(r.turns.length, 1);
  await advance(r, 30 * MIN);
  assert.equal(r.turns.length, 1);
});

test('a delivery that throws is a failed delivery (back-off), never a crash of the sweep', async () => {
  const r = rig();
  let throws = true;
  const good = r.deps.deliver;
  r.deps.deliver = async (id, t) => {
    if (throws) throw new Error('boom');
    return good(id, t);
  };
  await advance(r, 11 * MIN);
  assert.equal(vagueCounters().failed, 3);
  throws = false;
  await advance(r, RELANCE_RETRY_MS + VAGUE_SWEEP_MS);
  assert.equal(r.turns.length, 1);
});

test('a start that hangs does not stall the other vagues, and is not repeated while it hangs; its late result is applied', async () => {
  const r = rig();
  set(r, baseFacts({ runId: 'ops2', coordinator: person('ops2'), members: [member('impl2')] }));
  let release!: (v: RelanceDelivery) => void;
  const good = r.deps.deliver;
  let calls = 0;
  r.deps.deliver = (id, t) => {
    if (id === 'ops') {
      calls++;
      return new Promise<RelanceDelivery>((res) => { release = res; });
    }
    return good(id, t);
  };
  r.deps.deliverWaitMs = 20;
  await advance(r, 11 * MIN);
  assert.equal(r.turns.map((t) => t.wsId).join(), 'ops2', 'the other vague was told while ops hangs');
  await advance(r, 5 * MIN);
  assert.equal(calls, 1, 'not started a second time while the first hangs');
  release('sent');
  await new Promise((res) => setTimeout(res, 10));
  await advance(r, 5 * MIN);
  assert.equal(calls, 1);
  assert.equal(typeof asleepVagues().find((v) => v.runId === 'ops')?.nudgedAt, 'number');
});

test('the coordinator is judged on FRESH state right before it is told: a turn it started since the snapshot holds the Relance back until it is idle', async () => {
  const r = rig();
  let fresh: VagueFacts | undefined = baseFacts({ coordinator: person('ops', { active: true }) });
  r.deps.vague = () => fresh;
  await advance(r, 11 * MIN);
  assert.equal(r.turns.length, 0, 'the coordinator is running: reading the world already');
  assert.equal(asleepVagues()[0].nudgedAt, null);
  fresh = undefined; // idle again (falls back to the snapshot)
  await advance(r, MIN);
  assert.equal(r.turns.length, 1);
});

test('a vague that disappears (run archived) leaves no state: a new one with the same id starts from nothing', async () => {
  const r = rig();
  await advance(r, 11 * MIN);
  assert.equal(r.turns.length, 1);
  r.vagues.delete('ops');
  await sweepVagues(r.deps);
  assert.deepEqual(asleepVagues(), []);
});

test('the delays are read per pass (#429 makes the quiet delay a setting): a 2-minute delay declares at 2 minutes', async () => {
  const r = rig();
  r.deps.bounds = () => ({ quietMs: 2 * MIN });
  await advance(r, MIN);
  assert.equal(r.turns.length, 0);
  await advance(r, 2 * MIN);
  assert.equal(r.turns.length, 1);
});

test('an overlapping pass returns at once (one writer)', async () => {
  const r = rig();
  const a = sweepVagues(r.deps);
  const b = await sweepVagues(r.deps);
  assert.deepEqual(b, []);
  await a;
});

test('a failing delivery is retried once per back-off, not once per sweep (sweeps every 5 s for 2 minutes ⇒ at most one try per 30 s)', async () => {
  const r = rig();
  await advance(r, 10 * MIN - 1000); // just before the declaration
  r.outcome.next = 'failed';
  for (let i = 0; i < 24; i++) {
    r.clock.t += 5_000;
    await sweepVagues(r.deps);
  }
  const f = vagueCounters().failed;
  assert.ok(f >= 3 && f <= 5, `tries: ${f}`);
});

test('an unreadable roster (bus down) judges nobody, forgets nothing: after the outage the same episode goes on — no second Relance, no crash', async () => {
  const r = rig();
  await advance(r, 11 * MIN);
  assert.equal(r.turns.length, 1);
  const good = r.deps.vagues;
  r.deps.vagues = () => { throw new Error('bus down'); };
  await advance(r, 2 * 60 * MIN);
  assert.equal(asleepVagues().length, 1, 'the open episode is still shown');
  r.deps.vagues = good;
  await advance(r, 10 * MIN);
  assert.equal(r.turns.length, 1);
});

test('while a delivery is still in flight the vague is FROZEN: a member resuming and a whole new episode behind it cannot start a second Relance, and the late result lands on the episode it belongs to', async () => {
  const r = rig();
  let release!: (v: RelanceDelivery) => void;
  let calls = 0;
  r.deps.deliver = () => { calls++; return new Promise<RelanceDelivery>((res) => { release = res; }); };
  r.deps.deliverWaitMs = 20;
  await advance(r, 11 * MIN);
  assert.equal(calls, 1);
  set(r, baseFacts({ members: [member('impl', { active: true })] }));
  await advance(r, MIN);
  set(r, baseFacts({ members: [member('impl', { lastActivityAt: r.clock.t })], coordinator: person('ops', { lastActivityAt: r.clock.t }) }));
  await advance(r, 15 * MIN); // a new sleep would be declared and told here, if the pass were not frozen
  assert.equal(calls, 1, 'nobody else is started while the first start hangs');
  release('failed');
  await new Promise((res) => setTimeout(res, 10));
  assert.equal(vagueCounters().failed, 1);
});

test('sweepVaguesNow waits for the pass in flight and then RUNS (the Admission release must not be dropped): a held Relance goes out on it', async () => {
  const r = rig();
  let resolveFirst!: (v: RelanceDelivery) => void;
  let first = true;
  r.deps.deliver = async (wsId, text) => {
    if (first) { first = false; return new Promise<RelanceDelivery>((res) => { resolveFirst = res; }); }
    r.turns.push({ wsId, text });
    return 'sent';
  };
  r.clock.t = T0 + 11 * MIN;
  const a = sweepVagues(r.deps); // pass A: declares, delivery pending
  await new Promise((res) => setTimeout(res, 5));
  const b = sweepVaguesNow(r.deps); // the Admission release re-enters while A is in flight
  resolveFirst('held');
  await a;
  const told = await b;
  assert.equal(r.turns.length, 1, 'the re-entered pass ran and delivered');
  assert.deepEqual(told, ['ops']);
});
