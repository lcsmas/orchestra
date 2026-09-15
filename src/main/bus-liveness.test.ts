import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openBus, send, openGate, type BusDb } from './bus.ts';
import { readWaitingReaders } from './bus-wake.ts';
import {
  sweepBusLiveness,
  recordPhaseChange,
  setLivenessRoster,
  setLivenessWaiting,
  setLivenessSwitchReader,
  busLivenessCounters,
  __setBusReaderForTests,
  __setNowForTests,
  __resetBusLivenessForTests,
  __armForTests,
  type LivenessMember,
} from './bus-liveness.ts';
import { phaseChanged } from '../shared/bus-liveness.ts';

// The EFFECTFUL liveness + phase half against a REAL SQLite bus (#120, ledger
// #125). Drives the shipped `sweepBusLiveness`/`recordPhaseChange` end to end and
// asserts the ROWS that land — the observable a coordinator's `orchestra check`
// would render — not a bookkeeping counter the bug also moves. Each acceptance
// arm names the mutant it kills and pairs the escalate assertion with a
// same-command zero control.
//
// Runtime note (inherited from bus.test.ts): `pnpm run test` is system node (ABI
// 127) and bus-binding.ts loads the ABI-127 build from build/bus-abi/, so these
// construct a genuine database.

const RUN = 'run-L';
const NOW = 1_700_000_000_000;
const TEN_MIN = 10 * 60 * 1000;

function tmpBus(t: { after: (fn: () => void) => void }): BusDb {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestra-busliveness-test-'));
  const db = openBus(path.join(dir, 'bus.sqlite'));
  t.after(() => {
    try {
      db.close();
    } catch {
      /* already closed */
    }
    fs.rmSync(dir, { recursive: true, force: true });
    __resetBusLivenessForTests();
  });
  return db;
}

/** Count `escalation` rows addressed to `coordinator` about `reader` (the sender
 *  is the silent member). Unbounded COUNT(*), the number printed with its
 *  predicate (carry-forward 5). */
function escalationCount(db: BusDb, coordinator: string, reader: string): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM messages
        WHERE run_id=? AND kind='escalation' AND recipient=? AND sender=?`,
    )
    .get(RUN, coordinator, reader) as { n: number };
  return Number(row.n);
}

/** Count `status` rows for a member (sender), the phase-half observable. */
function statusCount(db: BusDb, reader: string): number {
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM messages WHERE run_id=? AND kind='status' AND sender=?`)
    .get(RUN, reader) as { n: number };
  return Number(row.n);
}

/** A default-stale member (tasked, coordinated, silent 11m, not running/waiting). */
function member(over: Partial<LivenessMember> = {}): LivenessMember {
  return {
    reader: 'ws-worker',
    coordinator: 'ws-ops',
    hasTask: true,
    lastActivityAt: NOW - 11 * 60 * 1000,
    running: false,
    waiting: false,
    runId: RUN,
    ...over,
  };
}

/** Wire the sweep at `db` with a fixed clock, the `liveness` switch forced ON,
 *  and the given member roster. Returns nothing — assert on the bus rows. */
function armSweep(db: BusDb, members: LivenessMember[], switchOn = true): void {
  __resetBusLivenessForTests();
  __setBusReaderForTests(() => db);
  __setNowForTests(() => NOW);
  setLivenessSwitchReader(() => switchOn);
  setLivenessRoster(() => members);
  __armForTests();
}

// ── The zero arm FIRST: the instrument can report NO escalation ──────────────

test('a fresh member produces NO escalation — the instrument can return zero', (t) => {
  // Carry-forward 4, first deliberately: every "exactly 1" below is only evidence
  // if the sweep can write zero. A member active 1m ago is alive.
  const db = tmpBus(t);
  armSweep(db, [member({ lastActivityAt: NOW - 60 * 1000 })]);
  sweepBusLiveness();
  assert.equal(escalationCount(db, 'ws-ops', 'ws-worker'), 0);
});

// ── T120.1 — ONE escalation per silence, re-arm after activity ───────────────

test('T120.1: silent 11m → exactly ONE escalation; re-sweep → still one', (t) => {
  // MUTANT: drop the ledger dedup (`if (previous) skip`) → the second sweep
  //   writes a SECOND row. Asserts one per silence across TWO sweeps.
  const db = tmpBus(t);
  armSweep(db, [member()]);
  sweepBusLiveness();
  assert.equal(escalationCount(db, 'ws-ops', 'ws-worker'), 1, 'first sweep escalates once');
  sweepBusLiveness();
  assert.equal(
    escalationCount(db, 'ws-ops', 'ws-worker'),
    1,
    'a second sweep with the same silence must NOT re-escalate',
  );
});

test('T120.1: activity resumes → no second row; silence again → a NEW one', (t) => {
  // The re-arm. Sweep stale (1 row); then the member is active (fresh) so the
  // ledger prunes; then it goes silent again → a NEW (2nd) escalation.
  const db = tmpBus(t);
  const stale = member();
  const fresh = member({ lastActivityAt: NOW - 60 * 1000 });
  // 1) stale → escalate
  armSweep(db, [stale]);
  sweepBusLiveness();
  assert.equal(escalationCount(db, 'ws-ops', 'ws-worker'), 1);
  // 2) active again — same wiring, swap the roster to the fresh member (prunes
  //    the ledger entry). No new row.
  setLivenessRoster(() => [fresh]);
  sweepBusLiveness();
  assert.equal(escalationCount(db, 'ws-ops', 'ws-worker'), 1, 'no escalation while active');
  // 3) silent again → a NEW escalation (2 total).
  setLivenessRoster(() => [stale]);
  sweepBusLiveness();
  assert.equal(
    escalationCount(db, 'ws-ops', 'ws-worker'),
    2,
    'a fresh silence after activity must produce a new escalation',
  );
});

// ── T120.2 — a long tool call counts as ALIVE (the anti-trap) ────────────────

test('T120.2: a running member silent 11m is ALIVE — no escalation', (t) => {
  // COVERS acceptance 2: a simulated 8-min build. The member is `running` (turn
  //   in flight) with an 11m-old discrete clock. A naive wall-clock timer would
  //   escalate; the running guard must not.
  // MUTANT: remove the `running` guard in decideEscalation → this goes RED (a
  //   row appears for a live long call — the dead-vs-slow-reader trap).
  const db = tmpBus(t);
  armSweep(db, [member({ running: true, lastActivityAt: NOW - 11 * 60 * 1000 })]);
  sweepBusLiveness();
  assert.equal(
    escalationCount(db, 'ws-ops', 'ws-worker'),
    0,
    'a running member must never be escalated, however old its discrete clock',
  );
});

// ── T120.4 — waiting members excluded (app-level AND #119 bus-waiting) ────────

test('T120.4: an app-level WAITING member is not escalated', (t) => {
  // MUTANT: remove the app-level `waiting` OR → an agent parked on needs-input
  //   escalates.
  const db = tmpBus(t);
  armSweep(db, [member({ waiting: true, lastActivityAt: 0 })]);
  sweepBusLiveness();
  assert.equal(escalationCount(db, 'ws-ops', 'ws-worker'), 0);
});

test('T120.4: a #119 bus-WAITING member is not escalated (consumed, not reimplemented)', (t) => {
  // The waiting set comes from #119's injected accessor. A member NOT app-waiting
  // but in the bus-waiting set must be excluded — proving #120 consumes #119's
  // surface. NEGATIVE control in the SAME command: a second member NOT in the set
  // IS escalated, so the exclusion is not blanket.
  const db = tmpBus(t);
  armSweep(db, [
    member({ reader: 'ws-asker', waiting: false }),
    member({ reader: 'ws-silent', waiting: false }),
  ]);
  setLivenessWaiting(() => new Set(['ws-asker']));
  sweepBusLiveness();
  assert.equal(escalationCount(db, 'ws-ops', 'ws-asker'), 0, 'the bus-waiting asker is excluded');
  assert.equal(
    escalationCount(db, 'ws-ops', 'ws-silent'),
    1,
    'a member NOT waiting IS escalated — the exclusion is scoped, not blanket',
  );
});

test('the waiting accessor receives {reader, runId} pairs (run-scoped, #119 shape)', (t) => {
  // Locks the call-site shape against #119's readWaitingReaders(db, {reader,
  // runId}[]) signature: a bare-handle list would collapse a handle present in
  // two runs. Capture what the sweep passes and assert the pairs carry runId.
  const db = tmpBus(t);
  armSweep(db, [member({ reader: 'ws-a', runId: 'run-X' })]);
  let seen: readonly { reader: string; runId: string }[] = [];
  setLivenessWaiting((_db, readers) => {
    seen = readers;
    return new Set<string>();
  });
  sweepBusLiveness();
  assert.deepEqual(seen, [{ reader: 'ws-a', runId: 'run-X' }]);
});

test('T120.4 INTEGRATION: the REAL #119 readWaitingReaders excludes a genuine asker', (t) => {
  // The strongest waiting arm: NOT a stub — wire #119's SHIPPED readWaitingReaders
  // and seed a REAL open ask (a `question` the asker SENT, unanswered) and a REAL
  // open gate. Both openers must be excluded from staleness; a third member with
  // no open ask/gate IS escalated (same-command negative control). This proves
  // the two modules meet through the actual export, not a hand-built agreement.
  const db = tmpBus(t);
  // ws-asker opened an ask (a question with no threaded reply) → waiting.
  send(db, { runId: RUN, sender: 'ws-asker', kind: 'question', body: 'may I?', recipient: 'ws-ops' });
  // ws-gater opened a decision gate, unresolved → waiting.
  openGate(db, RUN, 'ws-gater', 'ship it?');
  // ws-silent did neither → NOT waiting.
  armSweep(db, [
    member({ reader: 'ws-asker' }),
    member({ reader: 'ws-gater' }),
    member({ reader: 'ws-silent' }),
  ]);
  setLivenessWaiting(readWaitingReaders); // the SHIPPED #119 export
  sweepBusLiveness();
  assert.equal(escalationCount(db, 'ws-ops', 'ws-asker'), 0, 'the real ask-opener is excluded');
  assert.equal(escalationCount(db, 'ws-ops', 'ws-gater'), 0, 'the real gate-opener is excluded');
  assert.equal(
    escalationCount(db, 'ws-ops', 'ws-silent'),
    1,
    'a member with no open ask/gate IS escalated — the real exclusion is scoped',
  );
});

test('a failing #119 waiting accessor does not suppress a real stall', (t) => {
  // D1-shaped: #119's accessor throwing must be treated as "nobody bus-waiting"
  // (the safe direction), NOT as an excuse to skip the sweep. The stale member
  // still escalates.
  const db = tmpBus(t);
  armSweep(db, [member()]);
  setLivenessWaiting(() => {
    throw new Error('boom');
  });
  sweepBusLiveness();
  assert.equal(escalationCount(db, 'ws-ops', 'ws-worker'), 1);
});

// ── C5 — switch OFF: COUNTED, not FIRED ──────────────────────────────────────

test('C5: switch OFF → zero escalation rows, but the shadow counter increments', (t) => {
  // COVERS coexistence. MUTANT: ignore switchOn and always fire → a row appears
  //   with the switch off. Assert BOTH: no row AND counted > 0 (a mechanism whose
  //   off-state is silent is unobservable in shadow).
  const db = tmpBus(t);
  armSweep(db, [member()], /* switchOn */ false);
  sweepBusLiveness();
  assert.equal(escalationCount(db, 'ws-ops', 'ws-worker'), 0, 'no row while OFF');
  assert.ok(busLivenessCounters().counted >= 1, 'the would-have-escalated is COUNTED');
});

// ── F1 (review-120): a switch OFF→ON flip fires the FIRST escalation ──────────

test('F1: a member stale while OFF escalates EXACTLY ONCE when the switch flips ON', (t) => {
  // The bug the reviewer found: while OFF the member is counted and ledger-marked;
  // a naive presence-dedup then treats it as already-escalated when the switch
  // turns ON, so the first real escalation is silently lost. Drive it: OFF sweep
  // (0 rows, counted), then flip the switch reader to ON and sweep → exactly 1
  // row; a further ON sweep → still 1 (no double-fire).
  const db = tmpBus(t);
  armSweep(db, [member()], /* switchOn */ false);
  sweepBusLiveness();
  assert.equal(escalationCount(db, 'ws-ops', 'ws-worker'), 0, 'OFF → no row (counted)');
  const countedWhileOff = busLivenessCounters().counted;
  assert.ok(countedWhileOff >= 1, 'OFF → the shadow COUNT is recorded');
  // Flip the switch ON (same member, still continuously silent).
  setLivenessSwitchReader(() => true);
  sweepBusLiveness();
  assert.equal(
    escalationCount(db, 'ws-ops', 'ws-worker'),
    1,
    'the switch flipping ON must escalate the already-stale member exactly once',
  );
  // The shadow COUNT from the OFF phase is NOT lost by the flip (OPS-C refinement:
  // counted-while-OFF must survive AND the member must escalate once on ON).
  assert.equal(
    busLivenessCounters().counted,
    countedWhileOff,
    'the OFF-phase shadow count is preserved across the flip, not reset',
  );
  assert.equal(busLivenessCounters().fired, 1, 'exactly one real escalation fired on the flip');
  sweepBusLiveness();
  assert.equal(escalationCount(db, 'ws-ops', 'ws-worker'), 1, 'no double-fire on the next ON sweep');
});

// ── F3 (review-120): a member with an undefined clock is floored SAFE ────────

test('F3: a member whose lastActivityAt is undefined is NOT escalated (safe floor)', (t) => {
  // The dangerous-floor bug: with appStartedAt hardcoded 0, an undefined clock
  // gives silentForMs = now → escalate every clockless member. The sweep now
  // floors at `now`, so a clockless member reads as just-active. MUTANT: restore
  //   appStartedAt: 0 in the sweep → this member escalates.
  const db = tmpBus(t);
  armSweep(db, [member({ lastActivityAt: undefined })]);
  sweepBusLiveness();
  assert.equal(
    escalationCount(db, 'ws-ops', 'ws-worker'),
    0,
    'a member with no observed activity this run must not be escalated on an epoch floor',
  );
});

// ── C4 — getBus() === null tolerance (D1) ────────────────────────────────────

test('C4: a null bus makes the sweep a CLEAN no-op — no throw, no error log', (t) => {
  // MUTANT: remove the `if (!db) return` D1 guard → the sweep reaches `.prepare`
  //   on a null connection. It does not THROW OUT (the sweep's outer try/catch
  //   eats it), so `doesNotThrow` ALONE is vacuous — it cannot tell the clean D1
  //   return from a swallowed crash. The discriminator per the map's D1 rule is:
  //   "a silent no-op with NO log line" is the CORRECT behaviour; the mutant
  //   instead logs `bus-liveness: sweep failed`. So assert BOTH: no throw AND no
  //   sweep-failure warning. With the guard removed this arm goes RED on the log.
  tmpBus(t);
  __resetBusLivenessForTests();
  __setBusReaderForTests(() => null);
  __setNowForTests(() => NOW);
  // DELIBERATELY do NOT override the switch reader or the waiting accessor: the
  // production `busSwitch(db,…)`/`send(db,…)` must be the ones reached, so a
  // removed D1 guard actually hits a null-db `.prepare`/`send` (caught downstream
  // → a warning), which is what discriminates the guard from its absence. An
  // override here would hide the mutant (the stubs ignore db).
  setLivenessRoster(() => [member()]);
  __armForTests();
  const warnings: string[] = [];
  const orig = console.warn;
  console.warn = (msg?: unknown, ..._rest: unknown[]) => {
    warnings.push(String(msg));
  };
  try {
    assert.doesNotThrow(() => sweepBusLiveness());
  } finally {
    console.warn = orig;
  }
  // The D1 guard's contract is a CLEAN return BEFORE any member is processed.
  // Without it the sweep falls through and processes the (stale) member: the
  // null-db `busSwitch` degrades to false, so the member is COUNTED — `counted`
  // rises to 1. WITH the guard the sweep returns before the loop, so `counted`
  // stays 0. That difference is the discriminator (`fired` is 0 either way, so
  // asserting only `fired` or only `doesNotThrow` is vacuous — the map's D1
  // "silent no-op" disproof). Assert BOTH counters are untouched.
  assert.equal(busLivenessCounters().fired, 0);
  assert.equal(
    busLivenessCounters().counted,
    0,
    'a null bus must return BEFORE processing any member — 0 counted, not a degraded sweep',
  );
  assert.equal(
    warnings.length,
    0,
    `D1 null-bus must be a clean silent return — saw: ${warnings.join(' | ')}`,
  );
});

test('C4: recordPhaseChange with a null bus is a quiet no-op', (t) => {
  tmpBus(t);
  __resetBusLivenessForTests();
  __setBusReaderForTests(() => null);
  setLivenessSwitchReader(() => true);
  assert.doesNotThrow(() => recordPhaseChange(RUN, 'ws-worker', 'phase A'));
  assert.equal(busLivenessCounters().phaseRows, 0);
});

// ── T120.3 — phase: a change writes ONE status row, unchanged writes ZERO ─────

test('T120.3: recordPhaseChange (switch ON) writes exactly one status row', (t) => {
  // The phase half's write, driven directly (the change-guard lives at the
  // workspaces.ts call site; this proves the row lands when reached).
  const db = tmpBus(t);
  __resetBusLivenessForTests();
  __setBusReaderForTests(() => db);
  setLivenessSwitchReader(() => true);
  recordPhaseChange(RUN, 'ws-worker', 'implementing');
  assert.equal(statusCount(db, 'ws-worker'), 1);
});

test('T120.3: phase is switch-gated — OFF writes zero rows but counts', (t) => {
  // MUTANT: drop the switch gate in recordPhaseChange → a row appears while OFF.
  const db = tmpBus(t);
  __resetBusLivenessForTests();
  __setBusReaderForTests(() => db);
  setLivenessSwitchReader(() => false);
  recordPhaseChange(RUN, 'ws-worker', 'implementing');
  assert.equal(statusCount(db, 'ws-worker'), 0, 'no status row while the switch is OFF');
  assert.ok(busLivenessCounters().countedPhase >= 1, 'the phase change is COUNTED');
});

test('T120.3: the guard+write composed — change writes ONE, unchanged re-set writes ZERO', (t) => {
  // This drives the SAME sequence dispatchStatusRequest runs (guard then write),
  // so the "0 rows on an unchanged re-set" positive control is exercised against
  // the real bus, not only the pure phaseChanged. `workspaces.ts` cannot import
  // under the strip-types runner, so the guard is replayed here verbatim.
  const db = tmpBus(t);
  __resetBusLivenessForTests();
  __setBusReaderForTests(() => db);
  setLivenessSwitchReader(() => true);
  const apply = (prev: string, next: string): void => {
    if (phaseChanged(prev, next)) recordPhaseChange(RUN, 'ws-worker', next);
  };
  apply('', 'implementing'); // a change → 1
  assert.equal(statusCount(db, 'ws-worker'), 1);
  apply('implementing', 'implementing'); // UNCHANGED re-set → still 1
  assert.equal(statusCount(db, 'ws-worker'), 1, 'an unchanged re-set writes zero rows');
  apply('implementing', 'testing'); // a change → 2
  assert.equal(statusCount(db, 'ws-worker'), 2);
});

// ═══ #127 — liveness v2 progress bound, END-TO-END through the real bus ═══════
//
// These drive the SHIPPED sweep and assert the escalation ROW that lands (the
// observable a coordinator's `orchestra check` renders) for a HUNG mid-tool-call
// member — the #90 wedge class the staleness bound alone cannot see. BOTH arms of
// T127.1 (hung → exactly one row; a live 8-min build → zero) plus T127.3
// (COUNTED-not-FIRED while OFF), each with a same-command control.

const CEIL_OVER = 30 * 60 * 1000 + 60_000; // past the uncapped (MCP/browser) ceiling

/** The body of the single escalation row for a member, or undefined when none. */
function escalationBodyOf(db: BusDb, coordinator: string, reader: string): string | undefined {
  const row = db
    .prepare(
      `SELECT body FROM messages
        WHERE run_id=? AND kind='escalation' AND recipient=? AND sender=? LIMIT 1`,
    )
    .get(RUN, coordinator, reader) as { body: string } | undefined;
  return row?.body;
}

/** A member HUNG mid-tool-call: running, an MCP call in flight past its 30-min
 *  ceiling. `lastActivityAt` is deliberately RECENT — the progress bound is
 *  per-call (list membership), not the global clock, so a hung call escalates
 *  regardless of a fresh stamp (the F1 fix). */
function hungMember(over: Partial<LivenessMember> = {}): LivenessMember {
  const startedAt = NOW - CEIL_OVER;
  return member({
    running: true,
    lastActivityAt: NOW - 30_000,
    inFlightTools: [{ tool: 'mcp__browser__click', startedAt }],
    ...over,
  });
}

test('T127.1 arm A: a HUNG mid-tool-call member escalates exactly ONCE (the #90 wedge)', (t) => {
  // COVERS T127.1 hung arm. MUTANT: restore the unconditional `running` skip
  //   (drop the progress bound) → this goes RED (0 rows: a hung call is invisible,
  //   which is the exact gap #127 exists to close). Same-command control: the row
  //   NAMES the stuck tool (a hung-call body, not the staleness one).
  const db = tmpBus(t);
  armSweep(db, [hungMember()]);
  sweepBusLiveness();
  assert.equal(escalationCount(db, 'ws-ops', 'ws-worker'), 1, 'a hung mid-call member escalates');
  const body = escalationBodyOf(db, 'ws-ops', 'ws-worker');
  assert.match(body ?? '', /mcp__browser__click/, 'the row names the hung tool');
  assert.match(body ?? '', /hung/, 'the row says hung, not generic silence');
  // ONE per hung call: a second sweep with the same stuck call does not re-fire.
  sweepBusLiveness();
  assert.equal(escalationCount(db, 'ws-ops', 'ws-worker'), 1, 'no re-fire on the same stuck call');
});

test('T127.1 arm B: a legitimate 8-min Bash build → ZERO escalations (dead-vs-slow trap)', (t) => {
  // COVERS T127.1 build arm / acceptance 2. A Bash call in flight 8m, UNDER its
  //   600s (10m) ceiling. MUTANT: flag any in-flight call regardless of ceiling →
  //   this goes RED (the build escalates). Same-command POSITIVE control: a second
  //   member whose Bash call IS past the 600s ceiling DOES escalate — proving the
  //   zero is a real distinction, not a dead instrument.
  const db = tmpBus(t);
  const eightMinAgo = NOW - 8 * 60 * 1000;
  const overBash = NOW - (10 * 60 * 1000 + 60_000);
  armSweep(db, [
    member({
      reader: 'ws-build',
      running: true,
      lastActivityAt: eightMinAgo,
      inFlightTools: [{ tool: 'Bash', startedAt: eightMinAgo }],
    }),
    member({
      reader: 'ws-hungbash',
      running: true,
      lastActivityAt: overBash,
      inFlightTools: [{ tool: 'Bash', startedAt: overBash }],
    }),
  ]);
  sweepBusLiveness();
  assert.equal(
    escalationCount(db, 'ws-ops', 'ws-build'),
    0,
    'an 8-min build under the Bash ceiling must NOT escalate',
  );
  assert.equal(
    escalationCount(db, 'ws-ops', 'ws-hungbash'),
    1,
    'a Bash call PAST the 600s ceiling DOES escalate — the zero above is a real distinction',
  );
});

test('F1 (review-127): a hung PARALLEL call escalates beside a FAST sibling — end to end', (t) => {
  // THE regression, through the real bus. One member, TWO in-flight calls: a hung
  // MCP call past its 30-min ceiling AND a fast Bash call started 1s ago, with a
  // RECENT global activity clock (the fast sibling just posttool'd). The old
  // single-slot design escalated 0 here (the fast call masked the hung one). Now
  // exactly ONE escalation lands, naming the HUNG tool.
  // MUTANT: read the global lastActivityAt for progress → RED (0 rows: the recent
  //   clock masks the hung call, re-opening the #90 wedge).
  const db = tmpBus(t);
  const overMcp = NOW - CEIL_OVER;
  armSweep(db, [
    hungMember({
      lastActivityAt: NOW - 1000, // a sibling just returned — fresh clock
      inFlightTools: [
        { tool: 'mcp__browser__click', startedAt: overMcp },
        { tool: 'Bash', startedAt: NOW - 1000 }, // fast sibling under ceiling
      ],
    }),
  ]);
  sweepBusLiveness();
  assert.equal(
    escalationCount(db, 'ws-ops', 'ws-worker'),
    1,
    'a hung parallel call escalates despite a fast sibling + fresh clock',
  );
  const body = escalationBodyOf(db, 'ws-ops', 'ws-worker');
  assert.match(body ?? '', /mcp__browser__click/, 'the row names the HUNG tool, not the fast Bash');
});

test('T127.3: a hung call with liveness=OFF is COUNTED, never emitted to the coordinator', (t) => {
  // COVERS T127.3 (the SHADOW-wave state). MUTANT: emit regardless of switch on
  //   the hung path → a row reaches the coordinator while OFF. Assert BOTH: zero
  //   rows AND the shadow counter incremented (an off-state that is silent is
  //   unobservable in shadow).
  const db = tmpBus(t);
  armSweep(db, [hungMember()], /* switchOn */ false);
  sweepBusLiveness();
  assert.equal(
    escalationCount(db, 'ws-ops', 'ws-worker'),
    0,
    'no escalation row reaches the coordinator while liveness=OFF',
  );
  assert.ok(
    busLivenessCounters().counted >= 1,
    'the would-have-escalated hung call is COUNTED, not fired',
  );
});
