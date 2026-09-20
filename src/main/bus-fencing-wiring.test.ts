// #166 — WIRING the coordinator-generation BUMP (the producer side of fencing).
//
// #128 shipped the fencing PRIMITIVES (bumpCoordinatorGeneration / fencedWrite /
// assertCoordinatorGeneration, tested in bus-fencing.test.ts) but NOTHING called
// `bumpCoordinatorGeneration` in production, so every run sat at generation 0
// forever and fencing=ON was a field no-op (the #134 class: mechanism shipped,
// trigger unwired). This suite covers the wiring #166 adds:
//
//   1. The PURE gate `shouldBumpCoordinatorGeneration` — the sole discriminator
//      that a launch is a coordinator REPLACEMENT (not a first start, not a
//      member relaunch). It is exercised directly (the effect
//      `maybeBumpCoordinatorOnReplacement` in workspaces.ts — un-importable under
//      node --test via its `./platform` dir-import — calls THIS same function, so
//      the gate is not re-implemented here, #132).
//   2. The END-TO-END replacement flow against a REAL SQLite bus, driving the
//      REAL resolvers (nearestOrchestratorId / parentOrchestratorId, exactly as
//      resolveAnchorInfo does) + the REAL bumpCoordinatorGeneration + the REAL
//      fencedWrite — proving acceptance arms 1–3 fire on the shipped primitives.
//
// Every claim carries its must-FAIL twin, driven in-process.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  openBus,
  type BusDb,
  bumpCoordinatorGeneration,
  coordinatorGeneration,
  fencedWrite,
  fenceEvents,
  StaleGenerationError,
} from './bus.ts';
import { startRun, getRun } from './bus-runs.ts';
import { shouldBumpCoordinatorGeneration, type AnchorInfo } from './bus-run-anchor.ts';
import { nearestOrchestratorId, parentOrchestratorId, type WaveNode } from './wave-run-id.ts';
import { DEFAULT_BUS_SWITCHES, type BusSwitches } from '../shared/bus-switches.ts';

// Print the resolved module path of the module under test, so a future reader
// can confirm the rig drives the SHIPPED symbol and not a stray copy (#132).
console.log('bus-fencing-wiring drives:', fileURLToPath(new URL('./bus-run-anchor.ts', import.meta.url)));

function tmpDb(t: { after: (fn: () => void) => void }): BusDb {
  const dir = mkdtempSync(path.join(tmpdir(), 'bus-fencing-wiring-166-'));
  const db = openBus(path.join(dir, 'bus.sqlite'));
  t.after(() => {
    try {
      db.close();
    } catch {
      /* already closed */
    }
    rmSync(dir, { recursive: true, force: true });
  });
  return db;
}

const FENCING_ON: BusSwitches = { ...DEFAULT_BUS_SWITCHES, fencing: true };

/** Build AnchorInfo exactly as `resolveAnchorInfo` (workspaces.ts) does — from
 *  the REAL resolvers — so the rig drives shipped anchor semantics, never a copy. */
function anchorInfoOf(ws: WaveNode, lookup: (id: string) => WaveNode | undefined): AnchorInfo {
  const anchorId = nearestOrchestratorId(ws, lookup);
  const anchorWs = anchorId === ws.id ? ws : lookup(anchorId);
  const anchorIsOrchestrator = anchorWs
    ? anchorWs.kind === 'orchestrator' || anchorWs.canOrchestrate === true
    : false;
  return {
    wsId: ws.id,
    anchorId,
    anchorIsOrchestrator,
    parentRunId: anchorWs ? parentOrchestratorId(anchorWs, lookup) : null,
  };
}
function lookupOf(nodes: WaveNode[]): (id: string) => WaveNode | undefined {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  return (id) => byId.get(id);
}

// LEAD (orchestrator) → OPS (promoted worktree, its OWN run) → IMPL (member of OPS).
const LEAD: WaveNode = { id: 'lead', kind: 'orchestrator' };
const OPS: WaveNode = { id: 'ops', parentId: 'lead', kind: 'worktree', canOrchestrate: true };
const IMPL: WaveNode = { id: 'impl', parentId: 'ops', kind: 'worktree' };
const WAVE = lookupOf([LEAD, OPS, IMPL]);

// ─── 1. The PURE gate ────────────────────────────────────────────────────────

test('#166 gate — a coordinator relaunch WITH an existing run row bumps', () => {
  const anchor = anchorInfoOf(OPS, WAVE); // ops is its OWN anchor + orchestrator
  assert.equal(anchor.wsId, anchor.anchorId, 'sanity: the OPS is its own anchor');
  assert.equal(shouldBumpCoordinatorGeneration(anchor, true), true, 'row exists → bump');
});

test('#166 gate — a FIRST start (no run row yet) does NOT bump', () => {
  const anchor = anchorInfoOf(OPS, WAVE);
  // must-FAIL twin: a build that dropped the row-exists guard would bump the
  // first start (arm 1 requires first-start to stay 0).
  assert.equal(shouldBumpCoordinatorGeneration(anchor, false), false, 'no row → no bump');
});

test('#166 gate — a MEMBER relaunch does NOT bump (never fence the live anchor)', () => {
  const anchor = anchorInfoOf(IMPL, WAVE); // impl's anchor is OPS's run
  assert.equal(anchor.wsId, 'impl');
  assert.equal(anchor.anchorId, 'ops', 'a member anchors on its OPS run');
  assert.notEqual(anchor.wsId, anchor.anchorId, 'wsId !== anchorId for a member');
  // Even with the OPS run row present (the common case), a member relaunch must
  // NOT bump — that would fence the LIVE OPS. must-FAIL twin: a gate keyed only
  // on row-exists (dropping the wsId===anchorId clause) returns true here.
  assert.equal(shouldBumpCoordinatorGeneration(anchor, true), false, 'member → no bump');
});

test('#166 gate — a non-orchestrator self-anchor (plain standalone) does NOT bump', () => {
  const STAND: WaveNode = { id: 'stand', kind: 'worktree' }; // NOT canOrchestrate
  const anchor = anchorInfoOf(STAND, lookupOf([STAND]));
  assert.equal(anchor.wsId, anchor.anchorId, 'standalone anchors on itself');
  assert.equal(anchor.anchorIsOrchestrator, false, 'but is not an orchestrator');
  assert.equal(shouldBumpCoordinatorGeneration(anchor, true), false, 'not a coordinator → no bump');
});

// ─── 2. END-TO-END against a real bus (the effect's composition) ──────────────

/** Re-implements ONLY the effect's compose order (gate → real bump), driving the
 *  REAL pure gate + REAL bumpCoordinatorGeneration against a REAL bus — the same
 *  two calls `maybeBumpCoordinatorOnReplacement` (workspaces.ts) makes, minus the
 *  getBus()/try-catch the un-importable module wraps them in. */
function replacementLaunch(db: BusDb, ws: WaveNode): void {
  const anchor = anchorInfoOf(ws, WAVE);
  const runRowExists = getRun(db, anchor.anchorId) != null;
  if (shouldBumpCoordinatorGeneration(anchor, runRowExists)) {
    bumpCoordinatorGeneration(db, anchor.anchorId);
  }
}

test('#166 arm 1 — a coordinator RESPAWN bumps the run 0→1 (first start stays 0)', (t) => {
  const db = tmpDb(t);
  // First start: the OPS's run row is created at generation 0 (as startRun does).
  startRun(db, { id: 'ops', kind: 'vague', coordinator: 'ops' }, FENCING_ON);
  assert.equal(coordinatorGeneration(db, 'ops'), 0, 'first start: generation 0 (no old coordinator)');

  // A replacement launch of the SAME coordinator (row now pre-exists) → bump.
  replacementLaunch(db, OPS);
  assert.equal(coordinatorGeneration(db, 'ops'), 1, 'respawn bumps 0→1');

  // A SECOND respawn keeps it monotone.
  replacementLaunch(db, OPS);
  assert.equal(coordinatorGeneration(db, 'ops'), 2, 'a further respawn bumps 1→2');

  // must-FAIL twin (the shipped defect this ticket fixes): NO replacement launch
  // ever bumps → the run sits at 0 forever, fencing is a no-op.
  const db2 = tmpDb(t);
  startRun(db2, { id: 'ops', kind: 'vague', coordinator: 'ops' }, FENCING_ON);
  assert.equal(coordinatorGeneration(db2, 'ops'), 0, 'CONTROL: unwired producer never bumps');
});

test('#166 arm 1 control — a MEMBER respawn never bumps the OPS run', (t) => {
  const db = tmpDb(t);
  startRun(db, { id: 'ops', kind: 'vague', coordinator: 'ops' }, FENCING_ON);
  replacementLaunch(db, OPS); // OPS respawn: 0→1
  assert.equal(coordinatorGeneration(db, 'ops'), 1);
  // The member (IMPL) relaunches many times — the live OPS must stay at gen 1.
  replacementLaunch(db, IMPL);
  replacementLaunch(db, IMPL);
  assert.equal(coordinatorGeneration(db, 'ops'), 1, 'a member relaunch never fences the live OPS');
});

test('#166 arm 2 — after a respawn, a stale-generation send is FENCED (StaleGenerationError + event)', (t) => {
  const db = tmpDb(t);
  startRun(db, { id: 'ops', kind: 'vague', coordinator: 'ops' }, FENCING_ON);
  // The successor coordinator respawns: gen 0→1. The OLD process still presents 0.
  replacementLaunch(db, OPS);
  assert.equal(coordinatorGeneration(db, 'ops'), 1);

  // The OLD coordinator's in-flight send presents the pre-bump generation (0).
  assert.throws(
    () =>
      fencedWrite(db, {
        runId: 'ops',
        verb: 'send',
        presented: 0,
        fencingOn: true,
        actor: 'ops-old',
      }),
    (e: unknown) => e instanceof StaleGenerationError,
    'a stale-generation write is refused',
  );
  const evs = fenceEvents(db, 'ops');
  assert.equal(evs.length, 1, 'exactly one fence_events row');
  assert.equal(evs[0].fired, 1, 'the switch is ON → the event FIRED');
  assert.equal(evs[0].presented, 0);
  assert.equal(evs[0].current, 1);

  // Control: the SUCCESSOR (presenting the bumped generation 1) writes fine.
  assert.doesNotThrow(() =>
    fencedWrite(db, { runId: 'ops', verb: 'send', presented: 1, fencingOn: true, actor: 'ops-new' }),
  );
});

test('#166 arm 3 — current-generation and absent-generation (v1) writes are unchanged', (t) => {
  const db = tmpDb(t);
  startRun(db, { id: 'ops', kind: 'vague', coordinator: 'ops' }, FENCING_ON);
  replacementLaunch(db, OPS); // gen 1

  // Current generation: passes, records NO fence event.
  fencedWrite(db, { runId: 'ops', verb: 'send', presented: 1, fencingOn: true, actor: 'ops-new' });
  // Absent generation (the unfenced v1 path — every write before fencing carried
  // none): passes, records nothing, EVEN with the switch ON.
  fencedWrite(db, { runId: 'ops', verb: 'send', presented: null, fencingOn: true, actor: 'legacy' });
  assert.equal(fenceEvents(db, 'ops').length, 0, 'neither a current nor an absent-gen write is a fence event');
});
