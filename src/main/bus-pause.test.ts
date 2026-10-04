import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as bus from './bus.ts';
import * as busRuns from './bus-runs.ts';
import {
  activePauseFor,
  pausedCarrierForWorkspace,
  getRunPause,
  pauseRefusalWith,
  runSubtreeIds,
  runsOwingPauseTrap,
  setRunPause,
} from './bus-pause.ts';
import { DEFAULT_BUS_SWITCHES, type BusSwitches } from '../shared/bus-switches.ts';
import type { WaveNode } from './wave-run-id.ts';

// #252 fleet PAUSE — schema (MIGRATIONS[9]), the verb's writer, propagation, the frozen switch and the
// gate decision, over a REAL bus.sqlite under the real home (btrfs — never /tmp, never the live bus).
// Expectations are literals. Named arms are what the in-place mutants (ledger #261 nomination) redden.

const ROOT = path.join(os.homedir(), '.cache', `pause-d1a-bus-${process.pid}`);
const ON: BusSwitches = { ...DEFAULT_BUS_SWITCHES, pause: true };
const OFF: BusSwitches = { ...DEFAULT_BUS_SWITCHES };
let n = 0;

function freshDb(): { db: bus.BusDb; file: string } {
  fs.mkdirSync(ROOT, { recursive: true });
  const file = path.join(ROOT, `b${n++}.sqlite`);
  return { db: bus.openBus(file), file };
}

test.after(() => fs.rmSync(ROOT, { recursive: true, force: true }));

/** lead(L) ⊃ ops(O, coordinator ops-ws) ⊃ sub(S, coordinator sub-ws); sibling(X) under lead. */
function tree(db: bus.BusDb, sw: BusSwitches = ON): void {
  busRuns.startRun(db, { id: 'L', kind: 'mission', coordinator: 'lead-ws' }, sw);
  busRuns.startRun(db, { id: 'O', kind: 'vague', coordinator: 'ops-ws', parentRunId: 'L' }, sw);
  busRuns.startRun(db, { id: 'S', kind: 'vague', coordinator: 'sub-ws', parentRunId: 'O' }, sw);
  busRuns.startRun(db, { id: 'X', kind: 'vague', coordinator: 'sib-ws', parentRunId: 'L' }, sw);
}

const cols = (db: bus.BusDb, table: string): string[] =>
  (db.pragma(`table_info(${table})`) as { name: string }[]).map((c) => c.name);

test('SCHEMA: SCHEMA_VERSION is 10 and a fresh DB has exactly the frozen pause columns + pause_records + pause_members', () => {
  const { db } = freshDb();
  assert.equal(bus.SCHEMA_VERSION, 10);
  assert.equal(bus.schemaVersion(db), 10);
  for (const c of ['pause_deadline_at', 'pause_escalated_at', 'resume_started_at', 'pause_auto']) {
    assert.ok(cols(db, 'runs').includes(c), `runs.${c}`);
  }
  assert.deepEqual(cols(db, 'pause_members'), [
    'run_id', 'paused_at', 'ws_id', 'role', 'member_run', 'pause_confirmed_at', 'pause_confirm_via',
    'released_at', 'released_by', 'reprise_confirmed_at',
  ]);
  for (const c of ['paused_at', 'paused_by', 'pause_mode', 'pause_trap_at', 'held_at', 'held_by']) {
    assert.ok(cols(db, 'runs').includes(c), `runs.${c}`);
  }
  assert.deepEqual(cols(db, 'pause_records'), [
    'id', 'run_id', 'ws_id', 'paused_at', 'activity', 'snapshot_ref', 'dirty', 'killed_json', 'error', 'created_at',
  ]);
  db.close();
});

test('SCHEMA: a DB stamped v8 (no pause columns) migrates to HEAD in place and keeps its rows', () => {
  const { db, file } = freshDb();
  tree(db);
  db.exec('DROP TABLE pause_members');
  for (const c of ['pause_deadline_at', 'pause_escalated_at', 'resume_started_at', 'pause_auto']) db.exec(`ALTER TABLE runs DROP COLUMN ${c}`);
  db.exec('DROP TABLE pause_records');
  for (const c of ['paused_at', 'paused_by', 'pause_mode', 'pause_trap_at']) db.exec(`ALTER TABLE runs DROP COLUMN ${c}`);
  db.pragma('user_version = 8');
  assert.equal(cols(db, 'runs').includes('paused_at'), false, 'pre-state: column absent at v8');
  db.close();
  const again = bus.openBus(file); // open() migrates
  assert.equal(bus.schemaVersion(again), 10);
  assert.ok(cols(again, 'runs').includes('pause_trap_at'));
  assert.ok(cols(again, 'runs').includes('resume_started_at'));
  assert.equal(busRuns.getRun(again, 'O')?.coordinator, 'ops-ws', 'existing run rows survive');
  assert.equal(getRunPause(again, 'O'), null, 'and read as not paused');
  again.close();
});

test('SCHEMA: a DB stamped v9 (wave D pause, no lifecycle) migrates to v10 in place, keeps a live pause and its Bilan', () => {
  const { db, file } = freshDb();
  tree(db);
  db.exec('DROP TABLE pause_members');
  for (const c of ['pause_deadline_at', 'pause_escalated_at', 'resume_started_at', 'pause_auto']) db.exec(`ALTER TABLE runs DROP COLUMN ${c}`);
  db.exec(`UPDATE runs SET paused_at = 1000, paused_by = 'lead-ws', pause_mode = 'hard' WHERE id = 'O'`);
  db.exec(`INSERT INTO pause_records (run_id, ws_id, paused_at, created_at) VALUES ('O', 'w1', 1000, 1001)`);
  db.pragma('user_version = 9');
  db.close();
  const again = bus.openBus(file);
  assert.equal(bus.schemaVersion(again), 10);
  assert.equal(getRunPause(again, 'O')?.pausedAt, 1000, 'a v9 pause survives the migration');
  const r = again.prepare(`SELECT resume_started_at, pause_auto, pause_deadline_at FROM runs WHERE id = 'O'`).get() as Record<string, unknown>;
  assert.deepEqual(r, { resume_started_at: null, pause_auto: null, pause_deadline_at: null }, 'new columns read NULL (manual hard pause)');
  assert.equal((again.prepare('SELECT COUNT(*) AS n FROM pause_records').get() as { n: number }).n, 1);
  assert.equal((again.prepare('SELECT COUNT(*) AS n FROM pause_members').get() as { n: number }).n, 0);
  again.close();
});

test('SWITCH: `pause` is a real mechanism — frozen ON for a run started ON, OFF (default) otherwise', () => {
  const { db } = freshDb();
  busRuns.startRun(db, { id: 'on', kind: 'vague', coordinator: 'c' }, ON);
  busRuns.startRun(db, { id: 'off', kind: 'vague', coordinator: 'c' }, OFF);
  assert.equal(busRuns.busSwitch(db, 'on', 'pause'), true);
  assert.equal(busRuns.busSwitch(db, 'off', 'pause'), false);
  assert.equal(DEFAULT_BUS_SWITCHES.pause, false, 'default OFF');
  db.close();
});

test('WRITER: authority is the hold rule — coordinator and ANCESTOR coordinator may pause; a worker / descendant / no identity is refused and nothing changes', () => {
  const { db } = freshDb();
  tree(db);
  for (const who of ['worker-ws', 'sub-ws', 'sib-ws', '', null]) {
    assert.equal(setRunPause(db, 'O', true, who), 'refused', `refused: ${JSON.stringify(who)}`);
  }
  assert.equal(getRunPause(db, 'O'), null, 'no write on a refusal');
  assert.equal(setRunPause(db, 'O', true, 'lead-ws'), 'paused', 'ancestor coordinator');
  assert.equal(setRunPause(db, 'X', true, ' SIB-WS '), 'paused', 'own coordinator, case-folded + trimmed');
  assert.equal(setRunPause(db, 'nope', true, 'lead-ws'), 'no-run');
  db.close();
});

test('WRITER: a pause is REFUSED (never accepted-and-inert) while the run\'s frozen `pause` switch is OFF', () => {
  const { db } = freshDb();
  tree(db, OFF);
  assert.equal(setRunPause(db, 'O', true, 'ops-ws'), 'switch-off');
  assert.equal(getRunPause(db, 'O'), null, 'nothing written');
  // the LIVE switch flipping later changes nothing: the row is frozen
  assert.equal(setRunPause(db, 'O', true, 'ops-ws'), 'switch-off');
  db.close();
});

test('WRITER: pause records time/holder/mode, repeats keep the ORIGINAL, lift clears all four columns', () => {
  const { db } = freshDb();
  tree(db);
  assert.equal(setRunPause(db, 'O', true, 'ops-ws'), 'paused');
  const first = getRunPause(db, 'O')!;
  assert.equal(first.pausedBy, 'ops-ws');
  assert.equal(first.mode, 'hard');
  assert.equal(first.trapAt, null);
  assert.ok(first.pausedAt > 0);
  assert.equal(setRunPause(db, 'O', true, 'lead-ws'), 'already-paused');
  assert.deepEqual(getRunPause(db, 'O'), first, 'original time + holder kept');
  db.prepare('UPDATE runs SET pause_trap_at = 123 WHERE id = ?').run('O'); // D1b stamps this
  assert.equal(setRunPause(db, 'O', false, 'worker-ws'), 'refused', 'a worker cannot lift');
  assert.notEqual(getRunPause(db, 'O'), null);
  assert.equal(setRunPause(db, 'O', false, 'ops-ws'), 'lifted');
  const row = db.prepare('SELECT paused_at a, paused_by b, pause_mode c, pause_trap_at d FROM runs WHERE id = ?').get('O');
  assert.deepEqual({ ...(row as object) }, { a: null, b: null, c: null, d: null }, 'all four cleared — the next pause owes a fresh trap');
  assert.equal(setRunPause(db, 'O', false, 'ops-ws'), 'not-paused');
  db.close();
});

test('WRITER: a LIFT works whatever the switch says (a re-frozen OFF run can still be un-paused)', () => {
  const { db } = freshDb();
  tree(db);
  setRunPause(db, 'O', true, 'ops-ws');
  db.prepare("UPDATE run_flags SET flags = ? WHERE run_id = 'O'").run(JSON.stringify({ pause: false }));
  assert.equal(setRunPause(db, 'O', false, 'ops-ws'), 'lifted');
  db.close();
});

test('PROPAGATION: descendants of a paused run are paused (carrier named), siblings and ancestors are not', () => {
  const { db } = freshDb();
  tree(db);
  setRunPause(db, 'O', true, 'ops-ws');
  assert.equal(activePauseFor(db, 'O')?.runId, 'O');
  assert.equal(activePauseFor(db, 'S')?.runId, 'O', 'grandchild run → carrier O');
  assert.equal(activePauseFor(db, 'L'), null, 'ancestor not paused');
  assert.equal(activePauseFor(db, 'X'), null, 'sibling not paused');
  assert.equal(activePauseFor(db, 'ghost'), null, 'unknown run → not paused');
  assert.deepEqual(runSubtreeIds(db, 'O').sort(), ['O', 'S']);
  assert.deepEqual(runSubtreeIds(db, 'L').sort(), ['L', 'O', 'S', 'X']);
  db.close();
});

test('SWITCH OFF ⇒ INERT: a stale paused_at on a run whose frozen switch is OFF pauses nothing (byte-identical to no pause)', () => {
  const { db } = freshDb();
  tree(db, OFF);
  db.prepare("UPDATE runs SET paused_at = 5, paused_by = 'x', pause_mode = 'hard' WHERE id = 'O'").run();
  assert.equal(activePauseFor(db, 'O'), null);
  assert.equal(activePauseFor(db, 'S'), null);
  assert.deepEqual(runsOwingPauseTrap(db), []);
  // and the CARRIER's own switch decides, not the descendant's
  const { db: d2 } = freshDb();
  busRuns.startRun(d2, { id: 'O', kind: 'vague', coordinator: 'c' }, ON);
  busRuns.startRun(d2, { id: 'S', kind: 'vague', coordinator: 'c2', parentRunId: 'O' }, OFF);
  setRunPause(d2, 'O', true, 'c');
  assert.equal(activePauseFor(d2, 'S')?.runId, 'O', 'child frozen OFF still obeys an ON carrier');
  db.close();
  d2.close();
});

test('D1b SEAM: runsOwingPauseTrap lists carriers with pause_trap_at NULL only', () => {
  const { db } = freshDb();
  tree(db);
  setRunPause(db, 'O', true, 'ops-ws');
  setRunPause(db, 'X', true, 'sib-ws');
  assert.deepEqual(runsOwingPauseTrap(db).map((r) => r.runId).sort(), ['O', 'X']);
  db.prepare('UPDATE runs SET pause_trap_at = 9 WHERE id = ?').run('O');
  assert.deepEqual(runsOwingPauseTrap(db).map((r) => r.runId), ['X']);
  db.close();
});

test('CYCLE: a malformed parent_run_id cycle terminates', () => {
  const { db } = freshDb();
  tree(db);
  db.prepare("UPDATE runs SET parent_run_id = 'S' WHERE id = 'L'").run(); // L → S → O → L
  assert.equal(activePauseFor(db, 'S'), null);
  assert.ok(runSubtreeIds(db, 'L').length <= 4);
  db.close();
});

// ── the gate decision over a fake workspace tree + the real bus ─────────────
function wsMap(nodes: WaveNode[]): (id: string) => WaveNode | undefined {
  const m = new Map(nodes.map((w) => [w.id, w]));
  return (id) => m.get(id);
}
const OPS: WaveNode = { id: 'O', kind: 'orchestrator' };
const MEMBER: WaveNode = { id: 'm1', parentId: 'O' };

test('GATE: AUTO on a member of a paused run → the exact refusal; HUMAN → null; resolved at GATE time', () => {
  const { db } = freshDb();
  busRuns.startRun(db, { id: 'O', kind: 'vague', coordinator: 'O' }, ON);
  busRuns.startRun(db, { id: 'P', kind: 'vague', coordinator: 'P' }, ON);
  setRunPause(db, 'O', true, 'O');
  let nodes: WaveNode[] = [OPS, MEMBER, { id: 'P', kind: 'orchestrator' }];
  const deps = { getWorkspace: (id: string) => wsMap(nodes)(id), getBus: () => db };
  assert.equal(pauseRefusalWith(deps, MEMBER, 'auto'), 'run en pause — orchestra run resume --run O');
  assert.equal(pauseRefusalWith(deps, OPS, 'auto'), 'run en pause — orchestra run resume --run O', "the OPS is a member of its own run");
  assert.equal(pauseRefusalWith(deps, MEMBER, 'human'), null, 'HUMAN allowed, un-pauses nothing');
  assert.notEqual(activePauseFor(db, 'O'), null, '…and the human call did not lift it');
  // re-parent m1 under P: the SAME workspace now resolves to a different run → not paused (no stale env snapshot)
  nodes = [OPS, { id: 'm1', parentId: 'P' }, { id: 'P', kind: 'orchestrator' }];
  assert.equal(pauseRefusalWith(deps, { id: 'm1', parentId: 'P' }, 'auto'), null);
  db.close();
});

test('GATE: unknown ⇒ not paused — no workspace, no bus, no run row (standalone), unreadable bus (warned)', () => {
  const { db } = freshDb();
  busRuns.startRun(db, { id: 'O', kind: 'vague', coordinator: 'O' }, ON);
  setRunPause(db, 'O', true, 'O');
  const getWorkspace = (id: string) => (id === 'O' ? OPS : id === 'm1' ? MEMBER : undefined);
  assert.equal(pauseRefusalWith({ getWorkspace, getBus: () => db }, undefined, 'auto'), null);
  assert.equal(pauseRefusalWith({ getWorkspace, getBus: () => null }, MEMBER, 'auto'), null);
  assert.equal(pauseRefusalWith({ getWorkspace, getBus: () => db }, { id: 'solo' }, 'auto'), null, 'standalone ws anchors no run');
  const warns: string[] = [];
  const broken = { prepare: () => { throw new Error('boom'); } } as unknown as bus.BusDb;
  assert.equal(pauseRefusalWith({ getWorkspace, getBus: () => broken, warn: (m) => warns.push(m) }, MEMBER, 'auto'), null);
  assert.equal(warns.length, 1, 'an unreadable read is logged, not thrown');
  db.close();
});

test('GATE: a paused run whose switch is OFF is byte-identical to no pause (null for AUTO)', () => {
  const { db } = freshDb();
  busRuns.startRun(db, { id: 'O', kind: 'vague', coordinator: 'O' }, OFF);
  assert.equal(setRunPause(db, 'O', true, 'O'), 'switch-off');
  const deps = { getWorkspace: (id: string) => (id === 'O' ? OPS : MEMBER), getBus: () => db };
  assert.equal(pauseRefusalWith(deps, MEMBER, 'auto'), null);
  db.close();
});

// ── F2 (review D1a): the gate walks the LIVE workspace tree, not the write-once runs.parent_run_id ───────────────────────
test('F2 LIVE TREE: an orchestrator attached under a paused run AFTER creation (parent_run_id stays NULL) is paused; detaching un-pauses it', () => {
  const { db } = freshDb();
  busRuns.startRun(db, { id: 'O', kind: 'vague', coordinator: 'O' }, ON);
  busRuns.startRun(db, { id: 'O2', kind: 'vague', coordinator: 'O2' }, ON); // created top-level: parent_run_id NULL forever
  setRunPause(db, 'O', true, 'O');
  let o2: WaveNode = { id: 'O2', kind: 'orchestrator' };
  const nodes = () => new Map<string, WaveNode>([['O', OPS], ['O2', o2], ['m', { id: 'm', parentId: 'O2' }]]);
  const deps = { getWorkspace: (id: string) => nodes().get(id), getBus: () => db };
  assert.equal(pauseRefusalWith(deps, nodes().get('m'), 'auto'), null, 'pre-state: O2 is top-level, not under O');
  o2 = { id: 'O2', kind: 'orchestrator', parentId: 'O' };  // attach under the paused OPS (the store re-parents; the run row does not)
  assert.equal(busRuns.getRun(db, 'O2')?.parent_run_id, null, 'control: parent_run_id is write-once — still NULL');
  assert.equal(pauseRefusalWith(deps, nodes().get('m'), 'auto'), 'run en pause — orchestra run resume --run O', 'member of the re-parented run is paused');
  o2 = { id: 'O2', kind: 'orchestrator' };                 // detach again → not paused (a stale parent_run_id never pauses it)
  assert.equal(pauseRefusalWith(deps, nodes().get('m'), 'auto'), null);
  db.close();
});

test('F2 LIVE TREE: a plain child of a RUN-ANCHORING plain parent (#221 mission row, no orchestrator) is paused with the parent as carrier', () => {
  const { db } = freshDb();
  busRuns.startRun(db, { id: 'P', kind: 'mission', coordinator: 'P' }, ON);
  setRunPause(db, 'P', true, 'P');
  const nodes = new Map<string, WaveNode>([['P', { id: 'P' }], ['c', { id: 'c', parentId: 'P' }]]);
  const deps = { getWorkspace: (id: string) => nodes.get(id), getBus: () => db };
  assert.equal(pauseRefusalWith(deps, nodes.get('c'), 'auto'), 'run en pause — orchestra run resume --run P');
  assert.equal(pauseRefusalWith(deps, { id: 'lone' }, 'auto'), null, 'control: an unrelated standalone workspace');
  db.close();
});

test('F2 FALLBACK: parent_run_id is used ONLY when the live chain reaches a workspace gone from the store', () => {
  const { db } = freshDb();
  tree(db); // L ⊃ O ⊃ S ; X — run tree on the bus
  setRunPause(db, 'O', true, 'ops-ws');
  // S's workspace is present, its parent OPS workspace 'O' is GONE from the store (deleted) while the run row lives on
  const nodes = new Map<string, WaveNode>([['S', { id: 'S', kind: 'orchestrator', parentId: 'O' }], ['m', { id: 'm', parentId: 'S' }]]);
  const deps = { getWorkspace: (id: string) => nodes.get(id), getBus: () => db };
  assert.equal(pauseRefusalWith(deps, nodes.get('m'), 'auto'), 'run en pause — orchestra run resume --run O', 'dangling ancestor → bus run tree fallback finds the carrier');
  // same shape but the chain is fully in the store and S has NO live parent: the stale parent_run_id must NOT pause it
  const live = new Map<string, WaveNode>([['S', { id: 'S', kind: 'orchestrator' }], ['m', { id: 'm', parentId: 'S' }]]);
  assert.equal(pauseRefusalWith({ getWorkspace: (id: string) => live.get(id), getBus: () => db }, live.get('m'), 'auto'), null);
  db.close();
});

test('F6 (review D1a): an UNAVAILABLE bus is fail-open but SAYS SO through onBusUnavailable (and never throws)', () => {
  let said = 0;
  const r = pauseRefusalWith({ getWorkspace: () => undefined, getBus: () => null, onBusUnavailable: () => { said++; } }, MEMBER, 'auto');
  assert.equal(r, null);
  assert.equal(said, 1);
  let humanSaid = 0;
  pauseRefusalWith({ getWorkspace: () => undefined, getBus: () => null, onBusUnavailable: () => { humanSaid++; } }, MEMBER, 'human');
  assert.equal(humanSaid, 0, 'a HUMAN origin never reads the bus');
});
