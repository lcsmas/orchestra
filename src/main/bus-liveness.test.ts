import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openBus, type BusDb } from './bus.ts';
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
