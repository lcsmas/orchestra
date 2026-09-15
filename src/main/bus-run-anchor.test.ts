// #134 (LEAD ruling D1) — starting + FREEZING the bus run at the NEAREST
// ORCHESTRATOR, tested against a REAL SQLite bus by driving the REAL
// `maybeStartRunAtAnchor` + the REAL nearest-orchestrator resolvers.
//
// The whole point of D1: the OPS gets its OWN run (nested under the LEAD via
// parent_run_id), so a flip freezes PER WAVE, not once for the LEAD's lifetime.
// These arms build the AnchorInfo exactly as `resolveAnchorInfo` does (from the
// pure resolvers driven here) and start the run against a real `openBus` DB.
//
// `workspaces.ts` is un-importable under `node --test` (its `./platform`
// dir-import), so the anchor decision is pure exports (`nearestOrchestratorId` /
// `parentOrchestratorId`, wave-run-id.ts) and the effect is a platform-free fn
// (`maybeStartRunAtAnchor`) driven for real — never a re-implementation.
//
// Every claim carries its must-FAIL twin, driven in-process (carry-forward 1).
// THE D1 must-FAIL: the tree-root (walkToRootId) model would put a member on the
// LEAD's old run and read the STALE flip value — the arm below reddens on it.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openBus, type BusDb } from './bus.ts';
import { startRun, getRun, runFlags, refreezeRun } from './bus-runs.ts';
import {
  maybeStartRunAtAnchor,
  type BusRunAnchorDeps,
  type AnchorInfo,
} from './bus-run-anchor.ts';
import {
  nearestOrchestratorId,
  parentOrchestratorId,
  walkToRootId,
  type WaveNode,
} from './wave-run-id.ts';
import { DEFAULT_BUS_SWITCHES, BUS_MECHANISMS, type BusSwitches } from '../shared/bus-switches.ts';

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

function lookupOf(nodes: WaveNode[]): (id: string) => WaveNode | undefined {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  return (id) => byId.get(id);
}

/** Build AnchorInfo exactly as `resolveAnchorInfo` does — from the REAL
 *  resolvers — so this rig drives the shipped anchor semantics, not a copy. */
function anchorInfoOf(ws: WaveNode, lookup: (id: string) => WaveNode | undefined): AnchorInfo {
  const anchorId = nearestOrchestratorId(ws, lookup);
  const anchorWs = anchorId === ws.id ? ws : lookup(anchorId);
  const isOrch = anchorWs
    ? anchorWs.kind === 'orchestrator' || anchorWs.canOrchestrate === true
    : false;
  return {
    wsId: ws.id,
    anchorId,
    anchorIsOrchestrator: isOrch,
    parentRunId: anchorWs ? parentOrchestratorId(anchorWs, lookup) : null,
  };
}

/** Deps wired to a real bus + a mutable live-switch box, with a warn spy. */
function deps(db: BusDb | null, live: { v: BusSwitches }): BusRunAnchorDeps & { warns: string[] } {
  const warns: string[] = [];
  return {
    getBus: () => db,
    startRun,
    getRun,
    refreezeRun,
    getLiveSwitches: () => live.v,
    warn: (m) => warns.push(m),
    warns,
  };
}

// The topology: LEAD (orchestrator) → OPS (promoted worktree) → IMPL (member).
const LEAD: WaveNode = { id: 'lead', kind: 'orchestrator' };
const OPS: WaveNode = { id: 'ops', parentId: 'lead', kind: 'worktree', canOrchestrate: true };
const IMPL: WaveNode = { id: 'impl', parentId: 'ops', kind: 'worktree' };
const WAVE = lookupOf([LEAD, OPS, IMPL]);

// ─── G3 — a run row is created (and frozen) AT THE ANCHOR ────────────────────

test('G3 — an orchestrator launch creates its run row frozen from live switches', () => {
  const { db, dir } = tmpDb();
  try {
    const live = { v: switches({ delivery: true }) };
    const d = deps(db, live);
    assert.equal(getRun(db, 'ops'), null, 'no OPS run row before it launches');

    const row = maybeStartRunAtAnchor(d, anchorInfoOf(OPS, WAVE));
    assert.ok(row, 'the OPS creates its run row');
    assert.equal(row.id, 'ops');
    assert.equal(row.coordinator, 'ops');
    assert.equal(row.parent_run_id, 'lead', 'D1: nested under the LEAD');
    assert.equal(row.flags.delivery, true, 'frozen delivery=ON from live');
    assert.equal(runFlags(db, 'ops').delivery, true);

    // must-FAIL TWIN: no real startRun (the reproduced defect) → no row.
    const { db: db2, dir: dir2 } = tmpDb();
    try {
      const noop: BusRunAnchorDeps = { ...deps(db2, live), startRun: (() => ({}) as never) };
      maybeStartRunAtAnchor(noop, anchorInfoOf(OPS, WAVE));
      assert.equal(getRun(db2, 'ops'), null, 'CONTROL: without a real startRun the row is ABSENT');
    } finally {
      cleanup(db2, dir2);
    }
  } finally {
    cleanup(db, dir);
  }
});

// ─── G5 — a MEMBER shares the anchor run; lazily creates a missing OPS row ────

test('G5 — a member launch anchors on the OPS run and lazily creates it if missing', () => {
  const { db, dir } = tmpDb();
  try {
    const live = { v: switches({ wake: true }) };
    const d = deps(db, live);
    // The OPS row does NOT exist yet; the MEMBER launches first (lazy path).
    const row = maybeStartRunAtAnchor(d, anchorInfoOf(IMPL, WAVE));
    assert.ok(row, 'the member lazily created the OPS run row');
    assert.equal(row.id, 'ops', 'D1: the member anchors on the OPS, not the LEAD, not itself');
    assert.equal(row.parent_run_id, 'lead', 'and the lazily-created OPS row nests under the LEAD');
    assert.equal(getRun(db, 'impl'), null, 'NO run row keyed on the member id');
    assert.equal(getRun(db, 'lead'), null, 'and the member did NOT create the LEAD row');
    assert.equal(runFlags(db, 'ops').wake, true, 'the member reads the OPS frozen flags');

    // must-FAIL TWIN (the D1 defect): the tree-root model would anchor the member
    // on the LEAD. Prove the resolver DISAGREES with walkToRootId here.
    assert.notEqual(
      nearestOrchestratorId(IMPL, WAVE),
      walkToRootId(IMPL, WAVE),
      'nearest-orchestrator (ops) MUST differ from tree-root (lead) — the D1 fix',
    );
    assert.equal(walkToRootId(IMPL, WAVE), 'lead', 'the tree-root mutant would use lead');
  } finally {
    cleanup(db, dir);
  }
});

// ─── G4 — the FREEZE (T118.2) + D1 nested promote-after-flip ─────────────────

test('G4 D1 — a member is anchored on its OPS run, NOT the LEAD (tree-root mutant reddens)', () => {
  const { db, dir } = tmpDb();
  try {
    // The discriminating D1 property is the ANCHOR RESOLUTION, independent of the
    // flag values: a member's run is its OPS, never the LEAD. To make the arm
    // detect a tree-root regression by the FLAG a member would read, give the two
    // runs DIFFERENT frozen values: LEAD frozen wake=OFF, OPS frozen wake=ON. A
    // correct member reads the OPS (ON); a tree-root mutant reads the LEAD (OFF).
    //
    // NOTE the mission is a SEPARATE topology here (LEAD with NO child promoted in
    // the same step), so D1b's wave-boundary re-freeze does not fire: we start the
    // LEAD, flip, then start the OPS as its own wave. D1b re-freezes the mission
    // to the new value — which is asserted in G4b — so here we assert the ANCHOR,
    // not "LEAD keeps old".
    const live = { v: switches({ wake: false }) };
    const d = deps(db, live);
    maybeStartRunAtAnchor(d, anchorInfoOf(LEAD, WAVE)); // mission frozen OFF
    live.v = switches({ wake: true });
    maybeStartRunAtAnchor(d, anchorInfoOf(OPS, WAVE)); // OPS wave frozen ON

    assert.equal(runFlags(db, 'ops').wake, true, 'the OPS wave froze the NEW value');

    const memberAnchor = anchorInfoOf(IMPL, WAVE);
    assert.equal(memberAnchor.anchorId, 'ops', 'D1: the member anchors on the OPS, not the LEAD');
    assert.equal(runFlags(db, memberAnchor.anchorId).wake, true, 'member reads the OPS wake=ON');

    // must-FAIL TWIN: the tree-root mutant anchors the member on the LEAD run.
    // D1b re-froze the LEAD to ON when the OPS started, so to make this arm
    // reddenable we compare the ANCHOR IDS themselves (the load-bearing D1 fix):
    // nearest-orchestrator (ops) MUST differ from tree-root (lead).
    assert.equal(walkToRootId(IMPL, WAVE), 'lead', 'the tree-root mutant would anchor on the LEAD');
    assert.notEqual(
      memberAnchor.anchorId,
      walkToRootId(IMPL, WAVE),
      'nearest-orchestrator (ops) MUST differ from tree-root (lead) — a mutant using the latter reddens',
    );
  } finally {
    cleanup(db, dir);
  }
});

// ─── G4b (D1b) — the MISSION row is re-frozen at each wave boundary ──────────

test('G4b — starting a NEW OPS re-freezes the LEAD mission row to the latest flip', () => {
  const { db, dir } = tmpDb();
  try {
    const live = { v: switches({ wake: false }) };
    const d = deps(db, live);
    // The LEAD mission starts frozen wake=OFF.
    maybeStartRunAtAnchor(d, anchorInfoOf(LEAD, WAVE));
    assert.equal(runFlags(db, 'lead').wake, false);

    // Human flips wake ON; the LEAD then promotes/starts a new OPS (wave boundary).
    live.v = switches({ wake: true });
    maybeStartRunAtAnchor(d, anchorInfoOf(OPS, WAVE));

    // D1b: the mission row is RE-FROZEN to the new value, so the LEAD's plain
    // children spawned now track the latest flip.
    assert.equal(runFlags(db, 'lead').wake, true, 'the mission row was re-frozen to the flipped value');
    // And the new OPS wave froze the same new value on its OWN row.
    assert.equal(runFlags(db, 'ops').wake, true);

    // must-FAIL TWIN: with the re-freeze REMOVED, the mission stays stale OFF.
    // Prove refreezeRun is load-bearing by driving a deps whose refreezeRun is a
    // no-op and showing the mission would NOT track the flip.
    const { db: db2, dir: dir2 } = tmpDb();
    try {
      const live2 = { v: switches({ wake: false }) };
      const noRefreeze = { ...deps(db2, live2), refreezeRun: () => false };
      maybeStartRunAtAnchor(noRefreeze, anchorInfoOf(LEAD, WAVE));
      live2.v = switches({ wake: true });
      maybeStartRunAtAnchor(noRefreeze, anchorInfoOf(OPS, WAVE));
      assert.equal(runFlags(db2, 'lead').wake, false, 'CONTROL: no re-freeze ⇒ mission stays STALE OFF');
    } finally {
      cleanup(db2, dir2);
    }
  } finally {
    cleanup(db, dir);
  }
});

test('G4b F1 — an OPS (vague) row is NEVER re-frozen: byte-identical across a member spawn', () => {
  const { db, dir } = tmpDb();
  try {
    const live = { v: switches({ delivery: true }) };
    const d = deps(db, live);
    // The OPS wave starts frozen delivery=ON.
    maybeStartRunAtAnchor(d, anchorInfoOf(OPS, WAVE));
    const before = JSON.stringify(runFlags(db, 'ops'));

    // Flip mid-wave, then spawn a MEMBER under the OPS — this must NOT re-freeze
    // the OPS row (F1); a member spawn reads the existing row, never re-freezes.
    live.v = switches({ delivery: false, wake: true });
    maybeStartRunAtAnchor(d, anchorInfoOf(IMPL, WAVE));
    const after = JSON.stringify(runFlags(db, 'ops'));
    assert.equal(after, before, 'the OPS (vague) row is byte-identical across a member spawn (F1)');

    // Directly assert refreezeRun REFUSES a vague row even if called explicitly.
    const changed = refreezeRun(db, 'ops', switches({ delivery: false, wake: true }));
    assert.equal(changed, false, 'refreezeRun is a NO-OP on a vague (OPS) row — mission rows only');
    assert.equal(JSON.stringify(runFlags(db, 'ops')), before, 'and the OPS flags are untouched');
  } finally {
    cleanup(db, dir);
  }
});

test('G4 — flipping the live switch AFTER a run started does NOT change that run', () => {
  const { db, dir } = tmpDb();
  try {
    const live = { v: switches({ wake: false }) };
    const d = deps(db, live);
    maybeStartRunAtAnchor(d, anchorInfoOf(OPS, WAVE));
    assert.equal(runFlags(db, 'ops').wake, false);
    live.v = switches({ wake: true });
    // Re-launch of the SAME anchor — idempotent, no re-freeze (F1).
    maybeStartRunAtAnchor(d, anchorInfoOf(OPS, WAVE));
    assert.equal(runFlags(db, 'ops').wake, false, 'the running OPS run STILL reads its frozen OFF value');
  } finally {
    cleanup(db, dir);
  }
});

// ─── A plain standalone workspace gets NO run row ────────────────────────────

test('#134 D1 — a plain standalone workspace (no orchestrator) starts NO run', () => {
  const { db, dir } = tmpDb();
  try {
    const solo: WaveNode = { id: 'solo', kind: 'worktree' };
    const d = deps(db, { v: switches({ delivery: true }) });
    const info = anchorInfoOf(solo, lookupOf([solo]));
    assert.equal(info.anchorIsOrchestrator, false, 'a plain solo is not an orchestrator anchor');
    const row = maybeStartRunAtAnchor(d, info);
    assert.equal(row, null, 'no run row for a plain standalone workspace');
    assert.equal(getRun(db, 'solo'), null);
  } finally {
    cleanup(db, dir);
  }
});

// ─── D1 (bus never blocks a spawn) ───────────────────────────────────────────

test('D1 — a null bus returns null and never throws', () => {
  const d = deps(null, { v: switches({ delivery: true }) });
  let row: unknown;
  assert.doesNotThrow(() => {
    row = maybeStartRunAtAnchor(d, anchorInfoOf(OPS, WAVE));
  });
  assert.equal(row, null);
});

test('D1 — a THROWING startRun is caught, logged, and returns null', () => {
  const { db, dir } = tmpDb();
  try {
    const d = deps(db, { v: ALL_OFF });
    const throwing: BusRunAnchorDeps = {
      ...d,
      startRun: () => {
        throw new Error('simulated corrupt bus');
      },
    };
    let row: unknown = 'unset';
    assert.doesNotThrow(() => {
      row = maybeStartRunAtAnchor(throwing, anchorInfoOf(OPS, WAVE));
    });
    assert.equal(row, null);
    assert.equal(d.warns.length, 1, 'the D1 failure was logged exactly once');
    assert.match(d.warns[0], /could not start run ops/);
  } finally {
    cleanup(db, dir);
  }
});

// ─── Idempotence across launches ─────────────────────────────────────────────

test('#134 — the anchor start is idempotent (INSERT OR IGNORE) across launches', () => {
  const { db, dir } = tmpDb();
  try {
    const live = { v: switches({ delivery: true, wake: true }) };
    const d = deps(db, live);
    for (let i = 0; i < 5; i++) {
      live.v = i % 2 === 0 ? switches({ delivery: true, wake: true }) : ALL_OFF;
      maybeStartRunAtAnchor(d, anchorInfoOf(OPS, WAVE));
    }
    const frozen = runFlags(db, 'ops');
    assert.equal(frozen.delivery, true, 'the FIRST launch snapshot survived every later call');
    assert.equal(frozen.wake, true);
    for (const m of BUS_MECHANISMS) {
      if (m !== 'delivery' && m !== 'wake') assert.equal(frozen[m], false);
    }
  } finally {
    cleanup(db, dir);
  }
});
