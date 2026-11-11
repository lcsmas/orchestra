// #428 — the asleep-vague sweep, observed the way the fleet observes it: a Relance delivered to the COORDINATOR or not, and what `bus-status` would show. Fakes for the roster, the census, the
// clock and the delivery; the decision itself is pinned in shared/vague-endormie.test.ts. Every exclusion has a must-FAIL arm over the SAME fixture that fires when the exclusion is removed.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  VAGUE_SWEEP_MS,
  __resetVagueEndormieForTests,
  asleepVagues,
  relanceVagueNow,
  sweepVagues,
  sweepVaguesNow,
  vagueCounters,
  VAGUE_MAX_BACKOFF_MS,
  type PersistedVagues,
  type VagueDeps,
  type VagueStore,
} from './vague-endormie.ts';
import { RELANCE_RETRY_MS, type RelanceDelivery } from './relance.ts';
import { VAGUE_PROCESS_BOUND_MS, VAGUE_QUIET_MS, formatAsleepVaguesLines, type VagueFacts, type VagueMember, type VagueParticipant } from '../shared/vague-endormie.ts';
import { isRelance, type RelanceCensus, type RelanceProc } from '../shared/relance.ts';
import type { VagueMark } from '../shared/vague-human.ts';

const MIN = 60_000;
const T0 = Date.UTC(2026, 10, 10, 22, 48);
const P = (pid: number, ppid = 1, cmd = `proc-${pid}`): RelanceProc => ({ pid, ppid, startTicks: pid * 10, comm: cmd.split(' ')[0], cmd });

const person = (wsId: string, over: Partial<VagueParticipant> = {}): VagueParticipant => ({ wsId, label: wsId, active: false, waiting: false, heldStart: false, lastActivityAt: T0, seenThisRun: true, backgroundTask: false, ...over });
const member = (wsId: string, over: Partial<VagueMember> = {}): VagueMember => ({ ...person(wsId), task: `do ${wsId}`, unfinished: true, ...over });
const baseFacts = (over: Partial<VagueFacts> = {}): VagueFacts => ({
  runId: 'ops',
  coordinator: person('ops'),
  members: [member('impl'), member('verifier', { unfinished: false })],
  coordinatorHasParent: true,
  coordinatorWakeable: true,
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
  assert.equal(asleepVagues()[0].relance, 'owed');
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
  assert.equal(vagueCounters().failed, 2, 'tried at 10:00 and 10:30 (back-off 30 s, then 60 s) — one try per back-off, not one per tick');
  r.outcome.next = 'sent';
  await advance(r, 2 * RELANCE_RETRY_MS + VAGUE_SWEEP_MS);
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
  assert.equal(vagueCounters().failed, 2);
  throws = false;
  await advance(r, 2 * RELANCE_RETRY_MS + VAGUE_SWEEP_MS);
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

// ── a coordinator without a parent / that cannot be started / that cannot be reached ─────────────────────────────

test('a coordinator WITHOUT a parent (LEAD, promoted top-level workspace) never gets the Relance — 17 hours — but the vague IS declared and shown (bus-status / #429)', async () => {
  const r = rig();
  set(r, baseFacts({ coordinatorHasParent: false }));
  await advance(r, 17 * 60 * MIN);
  assert.equal(r.turns.length, 0);
  assert.equal(vagueCounters().declared, 1);
  assert.equal(vagueCounters().nudged, 0);
  const [v] = asleepVagues();
  assert.equal(v.relance, 'no-parent');
  assert.equal(v.nudgedAt, null);
  assert.match(formatAsleepVaguesLines([v], r.clock.t)[0], /no parent \(human-facing\): no Relance sent/);
  // the control: the same vague WITH a parent is told
  const c = rig();
  await advance(c, 11 * MIN);
  assert.equal(c.turns.length, 1);
});

test('an unwakeable coordinator is not retried at all (no delivery, no warn spam); it is told once it can be started', async () => {
  const r = rig();
  let calls = 0;
  const good = r.deps.deliver;
  r.deps.deliver = (id, t) => { calls++; return good(id, t); };
  set(r, baseFacts({ coordinatorWakeable: false }));
  await advance(r, 17 * 60 * MIN);
  assert.equal(calls, 0);
  assert.equal(asleepVagues()[0].relance, 'not-wakeable');
  set(r, baseFacts());
  await advance(r, MIN);
  assert.equal(r.turns.length, 1);
});

test('NO terminal state: delivery fails for the first 20 minutes after the declaration, then works ⇒ the Relance IS delivered (a short outage must not silence the alarm)', async () => {
  const r = rig();
  r.outcome.next = 'failed';
  await advance(r, 10 * MIN + 20 * MIN);
  assert.equal(r.turns.length, 0);
  assert.ok(vagueCounters().failed >= 5);
  r.outcome.next = 'sent';
  await advance(r, VAGUE_MAX_BACKOFF_MS + VAGUE_SWEEP_MS);
  assert.equal(r.turns.length, 1, 'delivered within one capped back-off of the recovery');
  await advance(r, 3 * 60 * MIN);
  assert.equal(r.turns.length, 1);
});

test('a coordinator whose delivery ALWAYS fails is tried for 17 hours with a capped back-off: bounded per hour (≤ 7), never zero', async () => {
  const r = rig();
  r.outcome.next = 'failed';
  await advance(r, 10 * MIN);
  await advance(r, 16 * 60 * MIN);
  const before = vagueCounters().failed;
  await advance(r, 60 * MIN);
  const lastHour = vagueCounters().failed - before;
  assert.ok(lastHour >= 5 && lastHour <= 7, `attempts in the last hour: ${lastHour}`);
  assert.equal(asleepVagues()[0].relance, 'owed');
  assert.equal(r.turns.length, 0);
});

test('wakeability coming back re-arms the delivery AT ONCE, however long the back-off had grown', async () => {
  const r = rig();
  r.outcome.next = 'failed';
  await advance(r, 3 * 60 * MIN); // back-off at its 10-minute cap
  set(r, baseFacts({ coordinatorWakeable: false }));
  await advance(r, MIN);
  r.outcome.next = 'sent';
  set(r, baseFacts());
  await advance(r, VAGUE_SWEEP_MS);
  assert.equal(r.turns.length, 1, 'told within one sweep of becoming wakeable');
});

// ── a restart: what survives, per run ────────────────────────────────────────────────────────────────────────────

/** A store in memory shared between « app runs »; `restart` = what a relaunch does (module state gone, the store kept, idle clocks floored at the new app start). */
function memStore(initial: PersistedVagues = {}): VagueStore & { disk: PersistedVagues; saves: number } {
  const st = { disk: initial, saves: 0, load: () => JSON.parse(JSON.stringify(st.disk)) as PersistedVagues, save: (a: PersistedVagues) => { st.disk = JSON.parse(JSON.stringify(a)); st.saves++; } };
  return st;
}
function restart(r: Rig, clockAdvance = 0): void {
  __resetVagueEndormieForTests();
  r.clock.t += clockAdvance;
  const t = r.clock.t;
  // after a relaunch every idle clock reads the app-start floor and nothing has been seen yet
  const f = r.vagues.get('ops')!;
  set(r, { ...f, coordinator: { ...f.coordinator, lastActivityAt: t, seenThisRun: false }, members: f.members.map((m) => ({ ...m, lastActivityAt: t, seenThisRun: false })) });
}

test('RESTART 1 — an episode already nudged is NOT nudged again after a relaunch, even with a click on a member (idle clock moved, no turn)', async () => {
  const r = rig();
  r.deps.persist = memStore();
  await advance(r, 11 * MIN);
  assert.equal(r.turns.length, 1);
  restart(r, 5 * MIN);
  const f = r.vagues.get('ops')!;
  set(r, { ...f, members: f.members.map((m) => ({ ...m, lastActivityAt: r.clock.t + 5 * MIN, seenThisRun: true })) }); // a pane selected: noteActivity, no turn
  await advance(r, 17 * 60 * MIN);
  assert.equal(r.turns.length, 1, 'still the one Relance of the episode');
  assert.equal(asleepVagues().length, 1, 'and the episode is still shown');
});

test('RESTART 2 — a vague that was asleep before / during the downtime IS declared after the relaunch (nothing seen this run, but seen on an earlier watch) and told once', async () => {
  const r = rig();
  const store = memStore();
  r.deps.persist = store;
  r.census.set('impl', []);
  // it was observed active, then went quiet; the app quit before the 10 minutes elapsed
  set(r, baseFacts({ members: [member('impl', { active: true }), member('verifier', { unfinished: false })] }));
  await advance(r, MIN);
  assert.deepEqual(store.disk.ops, { everSeen: true });
  set(r, baseFacts());
  restart(r, 3 * 60 * MIN); // down for hours
  await advance(r, 9 * MIN);
  assert.equal(r.turns.length, 0);
  await advance(r, 2 * MIN);
  assert.equal(r.turns.length, 1);
  await advance(r, 5 * 60 * MIN);
  assert.equal(r.turns.length, 1);
});

test('RESTART 3 — first sight after an upgrade (no record) of a wave nobody touches: baseline, NO nudge — not on this launch, not on the next ones (no storm for stale waves)', async () => {
  const r = rig();
  const store = memStore();
  r.deps.persist = store;
  restart(r);
  for (let launch = 0; launch < 3; launch++) {
    await advance(r, 3 * 60 * MIN);
    restart(r, 60 * MIN);
  }
  assert.equal(r.turns.length, 0);
  assert.deepEqual(store.disk, {}, 'nothing recorded for a wave nobody ever touched');
});

test('RESTART 4 — a vague that the person opened once (a click) is brought into play: it is then judged — and its episode persisted once nudged', async () => {
  const r = rig();
  const store = memStore();
  r.deps.persist = store;
  restart(r);
  const f = r.vagues.get('ops')!;
  set(r, { ...f, members: f.members.map((m) => ({ ...m, seenThisRun: true, lastActivityAt: r.clock.t })) });
  await advance(r, 11 * MIN);
  assert.equal(r.turns.length, 1);
  assert.equal(store.disk.ops.everSeen, true);
  assert.equal(typeof store.disk.ops.episode?.nudgedAt, 'number');
});

test('a corrupt / unreadable store starts from nothing and never crashes the sweep', async () => {
  const r = rig();
  r.deps.persist = { load: () => { throw new Error('torn'); }, save: () => { throw new Error('disk full'); } };
  await advance(r, 11 * MIN);
  assert.equal(r.turns.length, 1, 'still works in memory');
  __resetVagueEndormieForTests();
  const r2 = rig();
  r2.deps.persist = { load: () => ({ ops: { episode: { since: 'x' } }, junk: 3 } as unknown as PersistedVagues), save: () => {} };
  await advance(r2, 11 * MIN);
  assert.equal(r2.turns.length, 1, 'a malformed record is ignored, not trusted');
});

test('the nudge is persisted BEFORE the delivery (at most once across a crash)', async () => {
  const r = rig();
  const store = memStore();
  r.deps.persist = store;
  let seenOnDisk: number | undefined;
  const good = r.deps.deliver;
  r.deps.deliver = async (id, t) => { seenOnDisk = store.disk.ops?.episode?.nudgedAt; return good(id, t); };
  await advance(r, 11 * MIN);
  assert.equal(typeof seenOnDisk, 'number');
});

test('an unreadable store costs nothing: the FIRST pass already judges and tells (the load failure is caught, not propagated into the pass)', async () => {
  const r = rig();
  r.deps.persist = { load: () => { throw new Error('torn'); }, save: () => {} };
  r.clock.t = T0 + 11 * MIN;
  await sweepVagues(r.deps);
  assert.equal(r.turns.length, 1);
});

// ── an untrusted roster touches nothing ─────────────────────────────────────────────────────────────────────────

test('an UNTRUSTED roster (store.json absent / corrupt ⇒ empty fallback) judges nobody and prunes / saves nothing: the persisted state survives, and the episode is not re-nudged once the real roster is back', async () => {
  const r = rig();
  const store = memStore();
  r.deps.persist = store;
  await advance(r, 11 * MIN);
  assert.equal(r.turns.length, 1);
  const disk = JSON.stringify(store.disk);
  restart(r, MIN);
  const real = r.deps.vagues;
  let trusted = false;
  r.deps.rosterTrusted = () => trusted;
  r.deps.vagues = () => [];
  await advance(r, 3 * 60 * MIN);
  assert.equal(JSON.stringify(store.disk), disk, 'the file is untouched');
  assert.equal(r.turns.length, 1);
  trusted = true;
  r.deps.vagues = real;
  await advance(r, 3 * 60 * MIN);
  assert.equal(r.turns.length, 1, 'the persisted episode came back: no second Relance');
});

test('control: a TRUSTED empty roster does prune (a vague that is really gone leaves no record)', async () => {
  const r = rig();
  const store = memStore();
  r.deps.persist = store;
  await advance(r, 11 * MIN);
  assert.ok(store.disk.ops);
  r.deps.vagues = () => [];
  await sweepVagues(r.deps);
  assert.deepEqual(store.disk, {});
});

// ── the true « since » across a restart ─────────────────────────────────────────────────────────────────────────

test('RESTART 5 — a vague that fell asleep before the downtime keeps its TRUE « since » (persisted hint), is declared after the launch has settled for one delay, and the Relance says when it really fell asleep', async () => {
  const r = rig();
  const store = memStore();
  r.deps.persist = store;
  await advance(r, 5 * MIN); // quiet since T0, not yet declared: the hint is recorded
  assert.equal(store.disk.ops?.quietHint, T0);
  restart(r, 8 * 60 * MIN); // down for 8 hours
  const launch = r.clock.t;
  await advance(r, 9 * MIN);
  assert.equal(r.turns.length, 0, 'not at launch: the roster settles first');
  await advance(r, 2 * MIN);
  assert.equal(r.turns.length, 1);
  assert.equal(asleepVagues()[0].since, T0, 'since = when it really fell quiet, not the launch');
  assert.match(r.turns[0].text, /asleep since 22:48:00 UTC/);
  assert.ok(r.clock.t >= launch + 10 * MIN);
});

test('a hint never outlives activity: a member that works after the restart moves the quiet start to its real clock', async () => {
  const r = rig();
  const store = memStore();
  r.deps.persist = store;
  await advance(r, 5 * MIN);
  restart(r, 8 * 60 * MIN);
  const f = r.vagues.get('ops')!;
  const t = r.clock.t;
  set(r, { ...f, members: f.members.map((m) => ({ ...m, seenThisRun: true, lastActivityAt: t })) });
  await advance(r, 11 * MIN);
  assert.equal(asleepVagues()[0].since, t);
});

// ── #429: the human step — one notification, the mark on the coordinator's row, its end, its survival ─────────────────

type Told = { coordinatorId: string; coordinator: string; since: number; pending: number };
/** The rig + what the human OBSERVES: the notifications fired and the last set of marks pushed. */
function humanRig(): Rig & { told: Told[]; pushes: VagueMark[][]; marks: () => VagueMark[] } {
  const r = rig();
  const told: Told[] = [];
  const pushes: VagueMark[][] = [];
  r.deps.notifyHuman = (n) => void told.push(n);
  r.deps.onMarks = (m) => void pushes.push(m);
  return Object.assign(r, { told, pushes, marks: () => pushes[pushes.length - 1] ?? [] });
}

test('#429 — 15 minutes after the coordinator\'s Relance with no member resumed: ONE notification and the mark, with the right time and pending count; not a minute before', async () => {
  const r = humanRig();
  await advance(r, 10 * MIN); // declared + Relanced at the 10-minute sweep
  assert.equal(r.turns.length, 1);
  const relancedAt = asleepVagues()[0].nudgedAt!;
  r.clock.t = relancedAt;
  await advance(r, 15 * MIN - VAGUE_SWEEP_MS);
  assert.equal(r.told.length, 0, 'inside the 15 minutes: nobody is told');
  assert.deepEqual(r.marks(), [], 'and no mark is up');
  await advance(r, VAGUE_SWEEP_MS);
  assert.equal(r.told.length, 1, 'at the delay: exactly one notification');
  assert.deepEqual(r.told[0], { coordinatorId: 'ops', coordinator: 'ops', since: T0, pending: 1 });
  assert.deepEqual(r.marks(), [{ runId: 'ops', coordinatorId: 'ops', since: T0, pending: 1, memberIds: ['impl', 'verifier'], canRelance: true, relancing: false, coordinator: 'ops' }]);
  assert.equal(vagueCounters().humanTold, 1);
});

test('#429 — ONE notification per episode however long it lasts (17 hours of sweeps), the mark stays, and nothing more is sent to anyone', async () => {
  const r = humanRig();
  await advance(r, 17 * 60 * MIN);
  assert.equal(r.told.length, 1);
  assert.equal(r.marks().length, 1);
  assert.equal(r.turns.length, 1, 'the coordinator got its ONE Relance and the human step added no turn');
  assert.deepEqual(r.turns.map((t) => t.wsId), ['ops'], 'no delivery ever targets anyone else');
});

test('#429 — a member resuming ends the episode: the mark goes (an empty set is pushed), no second notification; the next sleep is a new episode with its own 15 minutes', async () => {
  const r = humanRig();
  await advance(r, 30 * MIN);
  assert.equal(r.told.length, 1);
  assert.equal(r.marks().length, 1);
  set(r, baseFacts({ members: [member('impl', { active: true }), member('verifier', { unfinished: false })] }));
  await advance(r, VAGUE_SWEEP_MS);
  assert.deepEqual(r.marks(), [], 'the mark disappears as soon as a member resumes');
  assert.equal(r.told.length, 1, 'resuming does not notify');
  // it ends its turn; asleep again; its OWN delays
  const t1 = r.clock.t;
  set(r, baseFacts({ members: [member('impl', { lastActivityAt: t1 }), member('verifier', { unfinished: false })], coordinator: person('ops', { lastActivityAt: t1 }) }));
  await advance(r, 20 * MIN);
  assert.equal(r.told.length, 1, 'the new episode has not waited its 15 minutes after its Relance yet');
  await advance(r, 10 * MIN);
  assert.equal(r.told.length, 2);
  assert.equal(r.marks()[0].since, t1);
});

test('#429 — a click on the sleeping workspace (idle clock moves, no turn) does NOT take the mark down', async () => {
  const r = humanRig();
  await advance(r, 30 * MIN);
  assert.equal(r.marks().length, 1);
  const f = r.vagues.get('ops')!;
  set(r, { ...f, members: f.members.map((m) => ({ ...m, lastActivityAt: r.clock.t })) });
  await advance(r, 5 * MIN);
  assert.equal(r.marks().length, 1);
  assert.equal(r.told.length, 1, 'and the click re-notified nobody');
});

test('#429 — the work finishing / a Pause also ends the mark (the episode ended)', async () => {
  for (const over of [{ paused: true }, { members: [member('impl', { unfinished: false }), member('verifier', { unfinished: false })] }]) {
    __resetVagueEndormieForTests();
    const r = humanRig();
    await advance(r, 30 * MIN);
    assert.equal(r.marks().length, 1);
    set(r, baseFacts(over));
    await advance(r, VAGUE_SWEEP_MS);
    assert.deepEqual(r.marks(), [], JSON.stringify(Object.keys(over)));
  }
});

test('#429 — a coordinator WITHOUT a parent: the human is told AT THE DECLARATION (no 15 minutes to wait for a Relance that is never sent), there is no Relancer, and nothing is ever delivered', async () => {
  const r = humanRig();
  set(r, baseFacts({ coordinatorHasParent: false }));
  await advance(r, 9 * MIN);
  assert.equal(r.told.length, 0, 'not before the asleep delay');
  await advance(r, MIN + VAGUE_SWEEP_MS);
  assert.equal(r.told.length, 1, 'told at the declaration');
  assert.equal(asleepVagues()[0].nudgedAt, null, 'nothing was sent to the coordinator');
  assert.deepEqual(r.marks().map((m) => m.canRelance), [false], 'no Relancer on the LEAD\'s own row');
  await advance(r, 17 * 60 * MIN);
  assert.equal(r.turns.length, 0, 'in 17 hours nothing reached the LEAD\'s conversation');
  assert.equal(r.told.length, 1);
});

test('#429 — a Relance that cannot go out (delivery failing) leaves the vague asleep: the human is told 15 minutes after the declaration, the Relancer stays offered', async () => {
  const r = humanRig();
  r.outcome.next = 'failed';
  await advance(r, 10 * MIN);
  assert.equal(r.told.length, 0);
  await advance(r, 15 * MIN + VAGUE_SWEEP_MS);
  assert.equal(r.told.length, 1);
  assert.equal(r.marks()[0].canRelance, true, 'owed, retried: the button can still nudge');
  // an unwakeable coordinator: told too, but no button (it cannot be started)
  __resetVagueEndormieForTests();
  const u = humanRig();
  set(u, baseFacts({ coordinatorWakeable: false }));
  await advance(u, 30 * MIN);
  assert.equal(u.told.length, 1);
  assert.equal(u.marks()[0].canRelance, false);
});

test('#429 — both delays are read per pass (settings applied without a restart): 1 min + 2 min; and lengthening the human delay later does not take a mark down', async () => {
  const r = humanRig();
  let cfg: { quietMs: number; humanMs: number } = { quietMs: 1 * MIN, humanMs: 2 * MIN };
  r.deps.bounds = () => cfg;
  await advance(r, 90_000);
  assert.equal(r.turns.length, 1, 'asleep after 1 minute');
  assert.equal(r.told.length, 0);
  await advance(r, 3 * MIN);
  assert.equal(r.told.length, 1, 'told 2 minutes after the Relance');
  cfg = { quietMs: 60 * MIN, humanMs: 24 * 60 * MIN };
  await advance(r, 10 * MIN);
  assert.equal(r.marks().length, 1, 'still marked: once told, the mark stays until a member resumes');
  assert.equal(r.told.length, 1);
  // the other way: a delay LENGTHENED before it was reached holds the notification back
  __resetVagueEndormieForTests();
  const q = humanRig();
  let humanMs = 15 * MIN;
  q.deps.bounds = () => ({ humanMs });
  await advance(q, 14 * MIN);
  humanMs = 60 * MIN;
  await advance(q, 20 * MIN);
  assert.equal(q.told.length, 0, 'a delay raised in Settings applies to the episode in flight');
  humanMs = 1 * MIN;
  await advance(q, VAGUE_SWEEP_MS);
  assert.equal(q.told.length, 1, 'and a delay lowered applies at the next pass');
});

test('#429 — the mark SURVIVES an app restart while the vague is still asleep, and the human is NOT notified a second time', async () => {
  const r = humanRig();
  const store = memStore();
  r.deps.persist = store;
  await advance(r, 30 * MIN);
  assert.equal(r.told.length, 1);
  assert.equal(typeof store.disk.ops.episode?.humanAt, 'number', 'persisted with the episode');
  // relaunch: module state gone, the store kept, every clock re-floored
  restart(r, 3 * MIN);
  r.pushes.length = 0;
  await advance(r, 5 * MIN);
  assert.equal(r.marks().length, 1, 'the mark is back on the first pass after the relaunch');
  assert.equal(r.marks()[0].since, T0, 'with its TRUE time');
  assert.equal(r.told.length, 1, 'no second notification');
  // and a member resuming after the relaunch ends it
  set(r, baseFacts({ members: [member('impl', { active: true }), member('verifier', { unfinished: false })] }));
  await advance(r, VAGUE_SWEEP_MS);
  assert.deepEqual(r.marks(), []);
});

test('#429 — due while the app was closed (never told): the first pass after the relaunch notifies ONCE and draws the mark', async () => {
  const r = humanRig();
  const store = memStore();
  r.deps.persist = store;
  await advance(r, 11 * MIN); // declared + Relanced; the human is not due yet
  assert.equal(r.told.length, 0);
  restart(r, 60 * MIN); // closed for an hour
  await advance(r, VAGUE_SWEEP_MS);
  assert.equal(r.told.length, 1, 'told on the first pass');
  assert.equal(r.marks().length, 1);
  restart(r, 0);
  await advance(r, 10 * MIN);
  assert.equal(r.told.length, 1, 'and not again on the next launch');
});

test('#429 — the notification is persisted BEFORE it fires (at most once across a crash), and a throwing notification does not lose the mark', async () => {
  const r = humanRig();
  const store = memStore();
  r.deps.persist = store;
  let persistedWhenFired: unknown = 'unset';
  r.deps.notifyHuman = () => {
    persistedWhenFired = store.disk.ops?.episode?.humanAt;
    throw new Error('no notification daemon');
  };
  await advance(r, 30 * MIN);
  assert.equal(typeof persistedWhenFired, 'number', 'humanAt was on disk when the notification fired');
  assert.equal(r.marks().length, 1, 'the mark is up although the toast failed');
  assert.equal(vagueCounters().humanTold, 1);
});

test('#429 — the marks are pushed only when they CHANGE (a steady asleep vague is not re-pushed every 30 s)', async () => {
  const r = humanRig();
  await advance(r, 30 * MIN);
  const n = r.pushes.length;
  await advance(r, 3 * 60 * MIN);
  assert.equal(r.pushes.length, n, 'no push while nothing moved');
});

test('#429 Relancer — nudges the coordinator AGAIN with the same kind of text; the episode and the mark stay (only a member resuming ends it); never anyone else', async () => {
  const r = humanRig();
  await advance(r, 30 * MIN);
  assert.equal(r.turns.length, 1);
  const res = await relanceVagueNow(r.deps, 'ops');
  assert.equal(res, 'sent');
  assert.equal(r.turns.length, 2, 'a second Relance');
  assert.equal(r.turns[1].wsId, 'ops');
  assert.ok(isRelance(r.turns[1].text));
  assert.match(r.turns[1].text, /asleep since 22:48:00 UTC/);
  assert.equal(r.marks().length, 1, 'the mark stays');
  assert.equal(asleepVagues().length, 1);
  await advance(r, 3 * 60 * MIN);
  assert.equal(r.turns.length, 2, 'and the automatic sweep does not add another');
});

test('#429 Relancer — a coordinator WITHOUT a parent is refused: NOTHING is sent to the LEAD\'s conversation (control: the same vague with a parent is sent)', async () => {
  const r = humanRig();
  set(r, baseFacts({ coordinatorHasParent: false }));
  await advance(r, 30 * MIN);
  assert.equal(await relanceVagueNow(r.deps, 'ops'), 'no-parent');
  assert.equal(r.turns.length, 0);
  const c = humanRig();
  await advance(c, 30 * MIN);
  assert.equal(await relanceVagueNow(c.deps, 'ops'), 'sent');
});

test('#429 Relancer — refused when the vague is not asleep (ended meanwhile / unknown run), when the coordinator cannot be started, and an outcome that is not `sent` is reported as it is', async () => {
  const r = humanRig();
  assert.equal(await relanceVagueNow(r.deps, 'ops'), 'not-asleep', 'before any episode');
  await advance(r, 30 * MIN);
  assert.equal(await relanceVagueNow(r.deps, 'nope'), 'not-asleep');
  r.outcome.next = 'held';
  assert.equal(await relanceVagueNow(r.deps, 'ops'), 'held');
  r.outcome.next = 'failed';
  assert.equal(await relanceVagueNow(r.deps, 'ops'), 'failed');
  r.outcome.next = 'sent';
  set(r, baseFacts({ coordinatorWakeable: false }));
  assert.equal(await relanceVagueNow(r.deps, 'ops'), 'not-wakeable');
  set(r, baseFacts({ members: [member('impl', { active: true }), member('verifier', { unfinished: false })] }));
  await advance(r, VAGUE_SWEEP_MS);
  assert.equal(await relanceVagueNow(r.deps, 'ops'), 'not-asleep', 'a member resumed: nothing to nudge');
});

test('#429 Relancer — while the automatic Relance is still OWED, a successful manual one settles it (no duplicate afterwards)', async () => {
  const r = humanRig();
  r.outcome.next = 'failed';
  await advance(r, 20 * MIN);
  assert.equal(r.turns.length, 0);
  r.outcome.next = 'sent';
  assert.equal(await relanceVagueNow(r.deps, 'ops'), 'sent');
  assert.equal(r.turns.length, 1);
  await advance(r, 60 * MIN);
  assert.equal(r.turns.length, 1, 'the sweep does not send the owed one on top');
});

test('#429 — several vagues: each has its own mark, its own members, its own notification', async () => {
  const r = humanRig();
  set(r, baseFacts({ runId: 'ops2', coordinator: person('ops2'), members: [member('b1'), member('b2'), member('b3', { unfinished: false })] }));
  await advance(r, 30 * MIN);
  assert.equal(r.told.length, 2);
  const ms = r.marks();
  assert.deepEqual(ms.map((m) => [m.coordinatorId, m.pending, m.memberIds.length]).sort(), [['ops', 1, 2], ['ops2', 2, 3]].sort());
});

test('#429 — a Relance whose delivery HANGS (a start that never lands) leaves the vague asleep: the human is still told, once, and the mark goes up — the frozen vague is not a silent one', async () => {
  const r = humanRig();
  r.deps.deliverWaitMs = 1;
  r.deps.deliver = () => new Promise<RelanceDelivery>(() => {}); // never settles
  await advance(r, 10 * MIN + VAGUE_SWEEP_MS);
  assert.equal(r.told.length, 0, 'not before the human delay');
  await advance(r, 15 * MIN + VAGUE_SWEEP_MS);
  assert.equal(r.told.length, 1);
  assert.equal(r.marks().length, 1);
  await advance(r, 5 * 60 * MIN);
  assert.equal(r.told.length, 1, 'once');
  assert.equal(r.turns.length, 0, 'and nothing was delivered by the human step');
});

test('#429 — the Relance that lands AFTER the human step fired does not drop the persisted `humanAt` (the nudge mark must not overwrite it)', async () => {
  const r = humanRig();
  const store = memStore();
  r.deps.persist = store;
  r.outcome.next = 'failed'; // the Relance cannot go out for 20 minutes: the human step fires from the declaration
  await advance(r, 26 * MIN);
  assert.equal(r.told.length, 1);
  r.outcome.next = 'sent';
  await advance(r, 20 * MIN); // back-off elapses, the Relance finally goes out
  assert.equal(r.turns.length, 1);
  assert.equal(typeof store.disk.ops.episode?.humanAt, 'number', 'humanAt still persisted');
  assert.equal(typeof store.disk.ops.episode?.nudgedAt, 'number');
  assert.equal(r.told.length, 1);
});

test('#429 Relancer — a start that hangs answers `pending` after the wait (the button is not stuck), and the late `sent` still settles the owed Relance', async () => {
  const r = humanRig();
  r.outcome.next = 'failed';
  await advance(r, 20 * MIN); // owed, retried
  let release: (v: RelanceDelivery) => void = () => {};
  r.deps.deliver = () => new Promise<RelanceDelivery>((res) => { release = res; });
  r.deps.deliverWaitMs = 1;
  assert.equal(await relanceVagueNow(r.deps, 'ops'), 'pending');
  release('sent');
  await new Promise((res) => setImmediate(res));
  assert.equal(asleepVagues()[0].relance, 'sent', 'the late result landed on the episode');
});

// ── #429 review round: the irreversible effect re-reads the world; the Relancer's own retry, guards and episode identity ──

test('#429 review — the notification re-reads the vague right before it fires: a member that resumed since the pass\'s snapshot means the human is NOT told (and nothing is persisted as told)', async () => {
  const r = humanRig();
  const store = memStore();
  r.deps.persist = store;
  await advance(r, 10 * MIN); // declared + Relanced
  const snapshot = r.vagues.get('ops')!;
  // the pass's snapshot still says « asleep », but the fresh read (taken later, right before the toast) says a member is working
  r.deps.vague = () => baseFacts({ members: [member('impl', { active: true }), member('verifier', { unfinished: false })] });
  await advance(r, 15 * MIN + VAGUE_SWEEP_MS);
  assert.equal(r.told.length, 0, 'no notification for a sleep that is already over');
  assert.equal(store.disk.ops.episode?.humanAt, undefined, 'and humanAt is not recorded');
  assert.ok(snapshot);
  // control: the same vague with a fresh read that agrees it is asleep IS told
  __resetVagueEndormieForTests();
  const c = humanRig();
  await advance(c, 30 * MIN);
  assert.equal(c.told.length, 1);
});

test('#429 review — a Relance delivered in the SAME pass the human step fires does not wipe `humanAt` (unwakeable until the due pass, then wakeable)', async () => {
  const r = humanRig();
  const store = memStore();
  r.deps.persist = store;
  set(r, baseFacts({ coordinatorWakeable: false }));
  await advance(r, 10 * MIN + VAGUE_SWEEP_MS); // declared; the coordinator cannot be started
  const due = asleepVagues()[0].declaredAt + 15 * MIN;
  r.clock.t = due - VAGUE_SWEEP_MS;
  await sweepVagues(r.deps);
  assert.equal(r.told.length, 0);
  set(r, baseFacts()); // wakeable again exactly as the human delay lapses
  r.clock.t = due;
  await sweepVagues(r.deps);
  assert.equal(r.told.length, 1);
  assert.equal(r.turns.length, 1, 'the Relance went out in the same pass');
  assert.equal(typeof store.disk.ops.episode?.humanAt, 'number', 'humanAt survived the nudge mark');
  assert.equal(typeof store.disk.ops.episode?.nudgedAt, 'number');
});

test('#429 review Relancer — `held` registers ITS OWN retry (a sweep pass would see the Relance already sent and drop the click); it goes out when memory recovers', async () => {
  const r = humanRig();
  await advance(r, 30 * MIN);
  assert.equal(r.turns.length, 1);
  let retry: (() => Promise<unknown>) | undefined;
  r.deps.deliver = async (wsId, text, rt) => {
    if (!retry) { retry = rt; return 'held'; }
    r.turns.push({ wsId, text });
    return 'sent';
  };
  assert.equal(await relanceVagueNow(r.deps, 'ops'), 'held');
  assert.equal(typeof retry, 'function', 'a retry was handed to the delivery');
  await advance(r, 60 * MIN);
  assert.equal(r.turns.length, 1, 'the automatic sweep does NOT deliver it (Relance already sent)');
  await retry!();
  assert.equal(r.turns.length, 2, 'the Relancer\'s retry did');
});

test('#429 review Relancer — a Pause / a held run is not a sleep: refused, no turn pushed into a parked fleet', async () => {
  for (const over of [{ paused: true }, { runHeld: true }]) {
    __resetVagueEndormieForTests();
    const r = humanRig();
    await advance(r, 30 * MIN);
    set(r, baseFacts(over));
    assert.equal(await relanceVagueNow(r.deps, 'ops'), 'not-asleep', JSON.stringify(over));
    assert.equal(r.turns.length, 1, 'only the automatic Relance');
  }
});

test('#429 review Relancer — while the automatic Relance of the episode is still IN FLIGHT the click answers `pending` and sends nothing (no duplicate turn)', async () => {
  const r = humanRig();
  let calls = 0;
  r.deps.deliver = () => { calls++; return new Promise<RelanceDelivery>(() => {}); };
  r.deps.deliverWaitMs = 1;
  await advance(r, 11 * MIN); // the automatic delivery hangs
  assert.equal(calls, 1);
  assert.equal(await relanceVagueNow(r.deps, 'ops'), 'pending');
  assert.equal(calls, 1, 'the click delivered nothing of its own');
});

test('#429 review Relancer — a LATE result of an old episode cannot stamp a newer one (its own Relance and human delay stay its own)', async () => {
  const r = humanRig();
  r.outcome.next = 'failed';
  await advance(r, 20 * MIN); // owed
  let release: (v: RelanceDelivery) => void = () => {};
  r.deps.deliver = () => new Promise<RelanceDelivery>((res) => { release = res; });
  r.deps.deliverWaitMs = 1;
  assert.equal(await relanceVagueNow(r.deps, 'ops'), 'pending');
  // the episode ends (a member resumes) and a NEW one is declared, still owed
  set(r, baseFacts({ members: [member('impl', { active: true }), member('verifier', { unfinished: false })] }));
  await advance(r, VAGUE_SWEEP_MS);
  const t1 = r.clock.t;
  r.deps.deliver = async () => 'failed';
  set(r, baseFacts({ members: [member('impl', { lastActivityAt: t1 }), member('verifier', { unfinished: false })], coordinator: person('ops', { lastActivityAt: t1 }) }));
  await advance(r, 12 * MIN);
  const second = asleepVagues()[0];
  assert.ok(second && second.since === t1, 'a second episode is open');
  release('sent'); // the OLD click finally lands
  await new Promise((res) => setImmediate(res));
  assert.equal(asleepVagues()[0].nudgedAt, null, 'the new episode is still owed');
  assert.equal(asleepVagues()[0].relance, 'owed');
});

test('#429 review — `canRelance` reads this pass\'s facts: a coordinator relanced earlier that has since lost its parent (or cannot be started) offers no button', async () => {
  const r = humanRig();
  await advance(r, 30 * MIN);
  assert.equal(r.marks()[0].canRelance, true);
  set(r, baseFacts({ coordinatorHasParent: false }));
  await advance(r, VAGUE_SWEEP_MS);
  assert.equal(asleepVagues()[0].relance, 'sent', 'it WAS sent');
  assert.equal(r.marks()[0].canRelance, false, 'but the button would be refused: not offered');
  set(r, baseFacts({ coordinatorWakeable: false }));
  await advance(r, VAGUE_SWEEP_MS);
  assert.equal(r.marks()[0].canRelance, false);
});

// ── #429 round 2: a hung delivery freezes the DECLARATION, never the episode's end; one delivery in flight per vague ──

test('#429 M1 — while a Relance start HANGS, a member that resumes still takes the mark and the episode down within one pass (nothing waits for the start to settle)', async () => {
  const r = humanRig();
  r.deps.deliverWaitMs = 1;
  r.deps.deliver = () => new Promise<RelanceDelivery>(() => {}); // never settles
  await advance(r, 30 * MIN);
  assert.equal(r.marks().length, 1, 'mark up while the start hangs');
  set(r, baseFacts({ members: [member('impl', { active: true }), member('verifier', { unfinished: false })] }));
  await advance(r, VAGUE_SWEEP_MS);
  assert.deepEqual(r.marks(), [], 'the mark goes');
  assert.equal(asleepVagues().length, 0, 'and so does the episode');
  assert.equal(vagueCounters().ended, 1);
});

test('#429 M1 — a member whose turn STARTED since the declaration (not active any more) ends it too; so do finished tasks and a Pause — all while the start hangs', async () => {
  const cases: Array<[string, Partial<VagueFacts>]> = [
    ['turn started', { members: [member('impl', { lastTurnStartAt: T0 + 20 * MIN }), member('verifier', { unfinished: false })] }],
    ['work finished', { members: [member('impl', { unfinished: false }), member('verifier', { unfinished: false })] }],
    ['pause', { paused: true }],
  ];
  for (const [name, over] of cases) {
    __resetVagueEndormieForTests();
    const r = humanRig();
    r.deps.deliverWaitMs = 1;
    r.deps.deliver = () => new Promise<RelanceDelivery>(() => {});
    await advance(r, 15 * MIN);
    await advance(r, 15 * MIN); // human step fired
    assert.equal(r.marks().length, 1, name);
    set(r, baseFacts(over));
    await advance(r, VAGUE_SWEEP_MS);
    assert.deepEqual(r.marks(), [], name);
  }
});

test('#429 M1 — control: a hung start with nobody resuming keeps the mark (the end is judged, not assumed)', async () => {
  const r = humanRig();
  r.deps.deliverWaitMs = 1;
  r.deps.deliver = () => new Promise<RelanceDelivery>(() => {});
  await advance(r, 60 * MIN);
  assert.equal(r.marks().length, 1);
});

test('#429 m1 — ONE delivery in flight per vague, whoever started it: a click while the automatic one is in flight (inside the 20 s wait) delivers nothing, and the mark says a Relance is under way', async () => {
  const r = humanRig();
  let calls = 0;
  let release: (v: RelanceDelivery) => void = () => {};
  r.deps.deliver = () => { calls++; return new Promise<RelanceDelivery>((res) => { release = res; }); };
  r.deps.deliverWaitMs = 5_000;
  await advance(r, 10 * MIN - VAGUE_SWEEP_MS); // not declared yet
  r.clock.t += VAGUE_SWEEP_MS;
  const pass = sweepVagues(r.deps); // declared; the automatic delivery is now in flight
  await new Promise((res) => setImmediate(res));
  assert.equal(calls, 1);
  assert.equal(await relanceVagueNow(r.deps, 'ops'), 'pending');
  assert.equal(calls, 1, 'the click delivered nothing');
  release('sent');
  await pass;
  assert.notEqual(asleepVagues()[0].nudgedAt, null, 'the automatic Relance landed');
});

test('#429 m1 — a click while a PREVIOUS click is still pending (hung start) answers `pending` and delivers nothing; `relancing` is on the mark meanwhile and off once it settles', async () => {
  const r = humanRig();
  await advance(r, 30 * MIN);
  let calls = 0;
  let release: (v: RelanceDelivery) => void = () => {};
  r.deps.deliver = () => { calls++; return new Promise<RelanceDelivery>((res) => { release = res; }); };
  r.deps.deliverWaitMs = 1;
  assert.equal(await relanceVagueNow(r.deps, 'ops'), 'pending');
  assert.equal(r.marks()[0].relancing, true, 'the button is disabled while it is in flight');
  assert.equal(await relanceVagueNow(r.deps, 'ops'), 'pending');
  assert.equal(calls, 1, 'one delivery, not two');
  release('sent');
  await new Promise((res) => setImmediate(res));
  assert.equal(r.marks()[0].relancing, false);
  assert.equal(await relanceVagueNow(r.deps, 'ops'), 'pending', 'a later click is delivered again (it hangs again here)');
  assert.equal(calls, 2);
});

test('#429 m1 — the sweep does not send its automatic Relance while a click\'s delivery is in flight', async () => {
  const r = humanRig();
  r.outcome.next = 'failed';
  await advance(r, 12 * MIN); // owed, retried
  let calls = 0;
  r.deps.deliver = () => { calls++; return new Promise<RelanceDelivery>(() => {}); };
  r.deps.deliverWaitMs = 1;
  assert.equal(await relanceVagueNow(r.deps, 'ops'), 'pending');
  await advance(r, 60 * MIN);
  assert.equal(calls, 1, 'only the click\'s delivery');
});
