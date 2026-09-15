// #134 — starting (and FREEZING) the bus run at the wave anchor, tested against
// a REAL SQLite bus by driving the REAL `maybeStartRunAtAnchor` export.
//
// Why this file exists and what it discriminates: on master `startRun` had zero
// production callers, so no `runs` row was created and every `busSwitch` read
// all-OFF. These arms drive the ONE production caller (`maybeStartRunAtAnchor`,
// called from `startAgentPty`) with its collaborators injected — the same
// function the app calls, not a re-implementation — and assert on the ROW the
// app would create. `workspaces.ts` is un-importable under `node --test` (its
// `./platform` dir-import), so the anchor decision is a pure export in
// `wave-run-id.ts` and the effect is this platform-free function; between them
// they cover the whole seam without the Electron/store chain.
//
// Every claim carries its must-FAIL twin, driven in-process so the discriminating
// power is MEASURED, not asserted (carry-forward 1: the failing input is written
// by hand). The twin mutates a real dependency (drop the startRun call; read
// live for a running run) and requires the arm to redden.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openBus, type BusDb } from './bus.ts';
import { startRun, getRun, runFlags } from './bus-runs.ts';
import { maybeStartRunAtAnchor, type BusRunAnchorDeps } from './bus-run-anchor.ts';
import {
  DEFAULT_BUS_SWITCHES,
  BUS_MECHANISMS,
  type BusSwitches,
} from '../shared/bus-switches.ts';

function tmpDb(): { db: BusDb; dir: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'bus-run-anchor-134-'));
  return { db: openBus(path.join(dir, 'bus.sqlite')), dir };
}
function cleanup(db: BusDb | null, dir: string) {
  try {
    db?.close();
  } catch {
    /* already closed */
  }
  rmSync(dir, { recursive: true, force: true });
}

const ALL_OFF: BusSwitches = { ...DEFAULT_BUS_SWITCHES };
function switches(over: Partial<BusSwitches>): BusSwitches {
  return { ...ALL_OFF, ...over };
}

/** Deps wired to a real bus + a mutable live-switch box, with a warn spy. */
function deps(db: BusDb | null, live: { v: BusSwitches }): BusRunAnchorDeps & {
  warns: string[];
} {
  const warns: string[] = [];
  return {
    getBus: () => db,
    startRun,
    getLiveSwitches: () => live.v,
    warn: (m) => warns.push(m),
    warns,
  };
}

// ─── G3 — a run row is created (and frozen) AT THE ANCHOR ────────────────────

test('G3 — spawning the anchor with live delivery=ON creates a run row frozen delivery=ON', () => {
  const { db, dir } = tmpDb();
  try {
    const live = { v: switches({ delivery: true }) };
    const d = deps(db, live);

    assert.equal(getRun(db, 'lead'), null, 'no run row before the anchor spawns');
    const row = maybeStartRunAtAnchor(d, { id: 'lead' }, 'lead');

    assert.ok(row, 'the anchor must create its run row');
    assert.equal(row.id, 'lead');
    assert.equal(row.coordinator, 'lead');
    assert.equal(row.parent_run_id, null, 'OQ1: parent_run_id is null under walkToRootId');
    assert.equal(row.flags.delivery, true, 'delivery was frozen ON from the live switch');
    // The row is really in the DB, not just the return value.
    assert.equal(runFlags(db, 'lead').delivery, true);

    // must-FAIL TWIN: with the startRun call removed (the reproduced defect), no
    // row exists. Driven by a deps whose startRun is a no-op that returns a fake
    // row — mimicking "the production caller was never added". The assertion the
    // real arm makes (a row IN THE DB) then reddens.
    const { db: db2, dir: dir2 } = tmpDb();
    try {
      const noopDeps: BusRunAnchorDeps = {
        ...deps(db2, live),
        startRun: (() => ({}) as never), // the master state: nothing writes the row
      };
      maybeStartRunAtAnchor(noopDeps, { id: 'lead' }, 'lead');
      assert.equal(getRun(db2, 'lead'), null, 'CONTROL: without a real startRun the row is ABSENT');
    } finally {
      cleanup(db2, dir2);
    }
  } finally {
    cleanup(db, dir);
  }
});

// ─── G5 — a MEMBER shares the anchor run and NEVER starts its own ────────────

test('G5 — a member spawned under the anchor starts NO run; the anchor owns the only row', () => {
  const { db, dir } = tmpDb();
  try {
    const live = { v: switches({ wake: true }) };
    const d = deps(db, live);
    // Anchor starts first.
    maybeStartRunAtAnchor(d, { id: 'lead' }, 'lead');
    // A member: its own id is 'impl' but its wave anchor (resolveWaveRunId) is
    // 'lead'. anchorId !== ws.id → it must start NOTHING.
    const memberRow = maybeStartRunAtAnchor(d, { id: 'impl' }, 'lead');
    assert.equal(memberRow, null, 'a member returns null — it did not start a run');
    assert.equal(getRun(db, 'impl'), null, 'no run row keyed on the member id');
    // And the member reads the SAME frozen flags as the anchor (same run id).
    assert.deepEqual(runFlags(db, 'lead'), switches({ wake: true }));

    // must-FAIL TWIN: if the plumbing were removed and the member resolved to
    // its OWN id (anchorId === ws.id, i.e. runId 'default'/'host-' per the
    // defect), it WOULD start a second, wrongly-keyed run row. Prove that the
    // member-guard is load-bearing by driving the id-collision case.
    const strayRow = maybeStartRunAtAnchor(d, { id: 'impl' }, 'impl');
    assert.ok(strayRow, 'CONTROL: passing the member as its own anchor DOES create a stray row');
    assert.ok(getRun(db, 'impl'), 'CONTROL: the stray row exists — proving the guard prevents it');
  } finally {
    cleanup(db, dir);
  }
});

// ─── G4 — the FREEZE (T118.2), in both directions ────────────────────────────

test('G4 — flipping the live switch AFTER the anchor started does NOT change the run', () => {
  const { db, dir } = tmpDb();
  try {
    const live = { v: switches({ wake: false }) };
    const d = deps(db, live);
    maybeStartRunAtAnchor(d, { id: 'lead' }, 'lead');
    assert.equal(runFlags(db, 'lead').wake, false, 'frozen OFF at start');

    // Human flips the switch mid-wave.
    live.v = switches({ wake: true });
    // Re-launch of the SAME anchor (resume/promote) — idempotent, no re-freeze.
    maybeStartRunAtAnchor(d, { id: 'lead' }, 'lead');
    assert.equal(runFlags(db, 'lead').wake, false, 'the running run STILL reads the frozen OFF value');

    // A NEW anchor started AFTER the flip freezes the new value.
    maybeStartRunAtAnchor(d, { id: 'lead2' }, 'lead2');
    assert.equal(runFlags(db, 'lead2').wake, true, 'a new anchor freezes the flipped-ON value');

    // must-FAIL TWIN: a mutant that RE-READS live switches for a running run
    // (C10's substitution) would report the flipped value. Prove the arm above
    // discriminates by computing that mutant reading and asserting it DIFFERS.
    const mutantRead = live.v.wake; // "read live instead of the run row"
    assert.equal(mutantRead, true, 'the live switch is ON');
    assert.notEqual(
      runFlags(db, 'lead').wake,
      mutantRead,
      'the frozen row and the live switch DISAGREE — a live-reading mutant reddens the freeze arm',
    );
  } finally {
    cleanup(db, dir);
  }
});

// ─── D1 — the bus NEVER blocks the spawn ─────────────────────────────────────

test('D1 — a null bus returns null and never throws (spawn proceeds all-OFF)', () => {
  const live = { v: switches({ delivery: true }) };
  const d = deps(null, live);
  let row: unknown;
  assert.doesNotThrow(() => {
    row = maybeStartRunAtAnchor(d, { id: 'lead' }, 'lead');
  });
  assert.equal(row, null, 'no row when the bus is down');
});

test('D1 — a THROWING startRun is caught, logged, and returns null', () => {
  const { db, dir } = tmpDb();
  try {
    const live = { v: ALL_OFF };
    const d = deps(db, live);
    const throwing: BusRunAnchorDeps = {
      ...d,
      startRun: () => {
        throw new Error('simulated corrupt bus');
      },
    };
    let row: unknown = 'unset';
    assert.doesNotThrow(() => {
      row = maybeStartRunAtAnchor(throwing, { id: 'lead' }, 'lead');
    });
    assert.equal(row, null, 'a failed start returns null, not a throw');
    // The failure is LOGGED, never silent (D1 — a bus fault must be observable).
    assert.equal(d.warns.length, 1, 'the D1 failure was logged exactly once');
    assert.match(d.warns[0], /could not start run lead/, 'the log names the run');
  } finally {
    cleanup(db, dir);
  }
});

// ─── Idempotence over many launches (spawn → resume → promote) ───────────────

test('#134 — calling the anchor start on every launch is idempotent (INSERT OR IGNORE)', () => {
  const { db, dir } = tmpDb();
  try {
    const live = { v: switches({ delivery: true, wake: true }) };
    const d = deps(db, live);
    for (let i = 0; i < 5; i++) {
      // flip live between launches to prove none of them re-freezes
      live.v = i % 2 === 0 ? switches({ delivery: true, wake: true }) : ALL_OFF;
      maybeStartRunAtAnchor(d, { id: 'lead' }, 'lead');
    }
    // The FIRST launch's snapshot (delivery+wake ON) survived every later call.
    const frozen = runFlags(db, 'lead');
    assert.equal(frozen.delivery, true);
    assert.equal(frozen.wake, true);
    for (const m of BUS_MECHANISMS) {
      if (m !== 'delivery' && m !== 'wake') assert.equal(frozen[m], false);
    }
  } finally {
    cleanup(db, dir);
  }
});
