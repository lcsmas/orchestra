import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as bus from './bus.ts';
import * as busRuns from './bus-runs.ts';
import { getRunPause, setRunPause } from './bus-pause.ts';
import { insertBilan } from './bus-pause-records.ts';
import { confirmMember, enrollMember } from './pause-douce.ts';
import { confirmReprise, readCarrierColumns, setLiveTreeSource } from './pause-reprise.ts';
import { readPauseOverview, toBilanLine, uiPause, uiRelease, uiResume, type PauseUiDeps } from './pause-ui.ts';
import { DEFAULT_BUS_SWITCHES, type BusSwitches } from '../shared/bus-switches.ts';
import type { WaveNode } from './wave-run-id.ts';

// #257 — the UI's DATA LAYER over a REAL bus.sqlite (btrfs under the real home, never /tmp, never the live bus). Every write goes through the SHIPPED writers; the
// expectations are literals. Each test names the clause an in-place mutant (scripts/pause-ui/mutate-unit.mjs) breaks.

const ROOT = path.join(os.homedir(), '.cache', `pause-ui-${process.pid}`);
const ON: BusSwitches = { ...DEFAULT_BUS_SWITCHES, pause: true };
const OFF: BusSwitches = { ...DEFAULT_BUS_SWITCHES };
let n = 0;
function freshDb(): bus.BusDb {
  fs.mkdirSync(ROOT, { recursive: true });
  return bus.openBus(path.join(ROOT, `u${n++}.sqlite`));
}
test.after(() => fs.rmSync(ROOT, { recursive: true, force: true }));

/** L mission ⊃ O ⊃ S ; legacy Z (pause switch OFF) with its worker z1. Run id == its coordinator's workspace id. */
function tree(db: bus.BusDb): void {
  busRuns.startRun(db, { id: 'L', kind: 'mission', coordinator: 'L', title: 'Vague F' }, ON);
  busRuns.startRun(db, { id: 'O', kind: 'vague', coordinator: 'O', parentRunId: 'L' }, ON);
  busRuns.startRun(db, { id: 'S', kind: 'vague', coordinator: 'S', parentRunId: 'O' }, ON);
  busRuns.startRun(db, { id: 'Z', kind: 'mission', coordinator: 'Z' }, OFF);
}
const NODES: Array<WaveNode & { archived?: boolean }> = [
  { id: 'L', kind: 'orchestrator' },
  { id: 'O', kind: 'orchestrator', parentId: 'L' },
  { id: 'S', kind: 'orchestrator', parentId: 'O' },
  { id: 'o1', parentId: 'O' },
  { id: 'o2', parentId: 'O' },
  { id: 's1', parentId: 'S' },
  { id: 'l1', parentId: 'L' },
  { id: 'Z', kind: 'orchestrator' },
  { id: 'z1', parentId: 'Z' },
  { id: 'plain' }, // a workspace with no orchestrator above and no run row
  { id: 'gone', parentId: 'O', archived: true },
];
const byId = new Map(NODES.map((w) => [w.id, w]));
const deps: PauseUiDeps = {
  getWorkspace: (id) => byId.get(id),
  listWorkspaces: () => NODES.filter((w) => !w.archived),
  labelOf: (id) => ({ L: 'fleet-lead', O: 'wave-ops', S: 'sub-ops', o1: 'worker-1', o2: 'worker-2', s1: 'sub-worker', l1: 'lead-worker', Z: 'legacy', z1: 'legacy-w' } as Record<string, string>)[id] ?? null,
};
setLiveTreeSource(() => ({ get: (id) => byId.get(id), ids: () => NODES.filter((w) => !w.archived).map((w) => w.id) }));

const memberRun = (ws: string): string => (['L', 'l1'].includes(ws) ? 'L' : ['S', 's1'].includes(ws) ? 'S' : 'O');
/** What the host does after a hard pause of L: enrol every member, trap each (Bilan row + confirm via 'trap'), stamp the trap. */
function trap(db: bus.BusDb, carrier = 'L'): number {
  const pausedAt = getRunPause(db, carrier)!.pausedAt;
  for (const ws of ['L', 'O', 'S', 'o1', 'o2', 's1', 'l1']) {
    enrollMember(db, carrier, pausedAt, { wsId: ws, memberRun: ws === 'S' ? 'O' : memberRun(ws) });
    insertBilan(db, {
      runId: carrier,
      wsId: ws,
      pausedAt,
      activity: { surface: 'sdk', memberRun: memberRun(ws), turnRunning: ws === 'o1', branch: `br-${ws}`, head: 'abc1234', changed: { modified: ws === 'o1' ? 3 : 0, added: 1, deleted: 0 }, ...(ws === 'o1' ? { interrupt: 'interrupted' as const, inFlightTools: [{ tool: 'Bash', toolUseId: 't', sinceMs: 9, input: 'npx tsc --noEmit' }] } : {}) },
      snapshotRef: `refs/orchestra/pause/${carrier}/${ws}/1`,
      dirty: ws === 'o1',
      killed: ws === 'o1' ? [{ pid: 7, cmd: 'tsc --noEmit', cwd: '/w/o1', signal: 'SIGTERM', outcome: 'exited' }] : [],
      error: null,
    });
    confirmMember(db, carrier, pausedAt, { wsId: ws, memberRun: memberRun(ws) }, 'trap', pausedAt + 5);
  }
  db.prepare('UPDATE runs SET pause_trap_at = ? WHERE id = ?').run(pausedAt + 9, carrier);
  return pausedAt;
}

// ── reads ───────────────────────────────────────────────────────────────────────────────────────────────

test('overview, nothing paused: no run, no badge; a control per ORCHESTRATOR row (anchored, switch read from the FROZEN flags), none for a worker', () => {
  const db = freshDb();
  tree(db);
  const o = readPauseOverview(db, deps);
  assert.equal(o.available, true);
  assert.deepEqual(o.runs, []);
  assert.deepEqual(o.byWorkspace, {});
  assert.deepEqual(Object.keys(o.controls).sort(), ['L', 'O', 'S', 'Z'], 'orchestrators only; `gone` is archived, workers have no control entry');
  assert.equal(o.controls.L.anchored, true);
  assert.equal(o.controls.L.runId, 'L');
  assert.equal(o.controls.L.switchOn, true);
  assert.deepEqual(o.controls.L.can.pauseSoft, { ok: true });
  assert.deepEqual(o.controls.L.can.resume, { ok: false, code: 'not-paused' });
  assert.equal(o.controls.Z.switchOn, false);
  assert.deepEqual(o.controls.Z.can.pauseHard, { ok: false, code: 'switch-off' }, 'a switch-OFF run is explained BEFORE the click');
  db.close();
});

test('overview with no bus: available=false + the reason (an empty overview must never read as "nothing is paused")', () => {
  const o = readPauseOverview(null, deps);
  assert.equal(o.available, false);
  assert.match(o.error ?? '', /bus is not open/);
  assert.deepEqual(o.runs, []);
});

test('overview survives a read that throws: available=false carrying the error, never a throw', () => {
  const db = freshDb();
  tree(db);
  db.close(); // every read now throws
  const o = readPauseOverview(db, deps);
  assert.equal(o.available, false);
  assert.match(o.error ?? '', /pause overview failed/);
});

// ── writes: the shipped writers, typed outcomes untouched ───────────────────────────────────────────────

test('uiPause as an ORCHESTRATOR row = setRunPause as its own coordinator: paused_by is the row, mode/deadline are the douce\'s, the members read "pausing" (UNKNOWN is not NONE)', () => {
  const db = freshDb();
  tree(db);
  const r = uiPause(db, deps, { wsId: 'L', mode: 'soft' });
  assert.equal(r.outcome, 'paused');
  assert.equal(r.runId, 'L');
  assert.equal(r.actor, 'L');
  assert.equal(r.explain, null, 'a success has nothing to explain');
  const p = getRunPause(db, 'L')!;
  assert.equal(p.pausedBy, 'L');
  assert.equal(p.mode, 'soft');
  assert.equal(p.deadlineAt, p.pausedAt + 180_000);
  const run = r.overview.runs[0];
  assert.equal(run.phase, 'pausing');
  assert.equal(run.mode, 'soft');
  assert.equal(run.carrierLabel, 'fleet-lead');
  assert.equal(run.pausedByLabel, 'fleet-lead');
  assert.deepEqual(run.progress, { kind: 'en-pause', done: 0, total: 0, missing: [] }, 'the roster is empty until the host enrols (no phantom members)');
  // the sidebar badges come from the GATE'S OWN walk, so a member the host has not enrolled yet is "pausing", never absent
  for (const ws of ['L', 'O', 'S', 'o1', 'o2', 's1', 'l1']) assert.equal(r.overview.byWorkspace[ws]?.ui, 'pausing', ws);
  assert.equal(r.overview.byWorkspace.Z, undefined, 'another wave is untouched');
  assert.equal(r.overview.byWorkspace.plain, undefined);
  db.close();
});

test('uiPause dure over a douce still waiting escalates it (the writer\'s own `escalated`); a repeat is `already-paused`', () => {
  const db = freshDb();
  tree(db);
  assert.equal(uiPause(db, deps, { wsId: 'L', mode: 'soft' }).outcome, 'paused');
  assert.equal(uiPause(db, deps, { wsId: 'L', mode: 'hard' }).outcome, 'escalated');
  const again = uiPause(db, deps, { wsId: 'L', mode: 'hard' });
  assert.equal(again.outcome, 'already-paused');
  assert.equal(again.explain?.tone, 'info');
  db.close();
});

test('REFUSAL — a WORKER row: the writer\'s own `refused` (nothing written), explained with who MAY (the coordinator, then the ancestors)', () => {
  const db = freshDb();
  tree(db);
  const r = uiPause(db, deps, { wsId: 'o1', mode: 'hard' });
  assert.equal(r.outcome, 'refused');
  assert.equal(r.runId, 'O', 'a worker\'s control targets ITS orchestrator\'s run');
  assert.equal(r.actor, 'o1');
  assert.equal(r.explain?.tone, 'error');
  assert.match(r.explain!.title, /worker-1 n'est pas coordinateur de wave-ops/);
  assert.match(r.explain!.why, /wave-ops/);
  assert.match(r.explain!.why, /fleet-lead/, 'the ancestor coordinator who may too');
  assert.deepEqual(r.explain!.fix, ['Mettre wave-ops en pause', 'Mettre fleet-lead en pause']);
  assert.equal(getRunPause(db, 'O'), null, 'NOTHING was written');
  assert.deepEqual(r.overview.runs, []);
  db.close();
});

test('REFUSAL — switch OFF: `switch-off`, nothing written, no run column touched', () => {
  const db = freshDb();
  tree(db);
  const r = uiPause(db, deps, { wsId: 'Z', mode: 'soft' });
  assert.equal(r.outcome, 'switch-off');
  assert.equal(r.explain?.tone, 'error');
  assert.match(r.explain!.title, /désactivée/);
  assert.match(r.explain!.why, /rien n'a été écrit/);
  assert.equal(readCarrierColumns(db, 'Z')!.pausedAt, null);
  db.close();
});

test('REFUSAL — no run row (a workspace that anchors nothing), unknown workspace, bus unavailable: typed, explained, nothing written', () => {
  const db = freshDb();
  tree(db);
  const noRun = uiPause(db, deps, { wsId: 'plain', mode: 'soft' });
  assert.equal(noRun.outcome, 'no-run');
  assert.match(noRun.explain!.title, /Pas de run/);
  const unknown = uiPause(db, deps, { wsId: 'ghost', mode: 'soft' });
  assert.equal(unknown.outcome, 'unknown-workspace');
  assert.equal(unknown.runId, null);
  assert.equal(unknown.explain?.tone, 'error');
  const down = uiPause(null, deps, { wsId: 'L', mode: 'soft' });
  assert.equal(down.outcome, 'bus-unavailable');
  assert.match(down.explain!.why, /ni lu ni écrit/);
  assert.equal(down.overview.available, false);
  db.close();
});

test('uiResume: not-paused · refused as a worker · a COVERED run names the ancestor that holds it · resuming (the shipped Reprise: coordinators released, workers blocked)', () => {
  const db = freshDb();
  tree(db);
  assert.equal(uiResume(db, deps, { wsId: 'L' }).outcome, 'not-paused');
  uiPause(db, deps, { wsId: 'L', mode: 'hard' });
  trap(db);
  const covered = uiResume(db, deps, { wsId: 'O' });
  assert.equal(covered.outcome, 'not-paused', "O has no pause of its own: L's covers it");
  assert.deepEqual(covered.cover, { runId: 'L', label: 'fleet-lead' });
  assert.match(covered.explain!.title, /fleet-lead tient déjà wave-ops en pause/);
  const worker = uiResume(db, deps, { wsId: 'o1' });
  assert.equal(worker.outcome, 'refused');
  assert.match(worker.explain!.title, /Reprise refusée/);
  assert.equal(readCarrierColumns(db, 'L')!.resumeStartedAt, null, 'refusals wrote nothing');
  const go = uiResume(db, deps, { wsId: 'L' });
  assert.equal(go.outcome, 'resuming');
  assert.equal(go.explain, null);
  const run = go.overview.runs[0];
  assert.equal(run.phase, 'resuming');
  assert.deepEqual(run.progress.kind, 'repris');
  assert.deepEqual(run.blocked.slice().sort(), ['l1', 'o1', 'o2', 's1'], 'every worker is BLOCKED until its coordinator releases it');
  assert.equal(uiResume(db, deps, { wsId: 'L' }).outcome, 'already-resuming');
  db.close();
});

// ── the full cycle, read back ───────────────────────────────────────────────────────────────────────────

test('FULL CYCLE: pause → Bilan → progress "N/M en pause" → Reprise → "N/M repris" with the BLOCKED list → release (own wave / below / refused) → active + tracked accusés', () => {
  const db = freshDb();
  tree(db);
  uiPause(db, deps, { wsId: 'L', mode: 'hard' });
  const pausedAt = trap(db);
  let o = readPauseOverview(db, deps);
  const run = o.runs[0];
  assert.equal(run.phase, 'paused');
  assert.equal(run.trapAt, pausedAt + 9);
  assert.deepEqual(run.progress, { kind: 'en-pause', done: 7, total: 7, missing: [] });
  const o1 = run.members.find((m) => m.wsId === 'o1')!;
  assert.equal(o1.ui, 'paused');
  assert.equal(o1.confirmVia, 'trap');
  assert.equal(o1.role, 'worker');
  assert.equal(o1.bilan!.snapshotRef, `refs/orchestra/pause/L/o1/1`);
  assert.equal(o1.bilan!.dirty, true);
  assert.deepEqual(o1.bilan!.changed, { modified: 3, added: 1, deleted: 0 });
  assert.deepEqual(o1.bilan!.wasDoing.inFlight, ['npx tsc --noEmit']);
  assert.deepEqual(o1.bilan!.killed, [{ cmd: 'tsc --noEmit', cwd: '/w/o1', outcome: 'exited' }]);
  assert.equal(o1.bilan!.exempt, false, 'a UI pause has no CLI chain: nobody is the pauser');
  assert.equal(run.members.find((m) => m.wsId === 'O')!.role, 'coordinator');
  assert.equal(o.byWorkspace.o1.ui, 'paused');
  assert.equal(o.controls.L.phase, 'paused');
  assert.deepEqual(o.controls.L.can.resume, { ok: true });
  assert.deepEqual(o.controls.L.can.pauseHard, { ok: false, code: 'already-paused' });
  assert.deepEqual(o.controls.O.coveredBy, { runId: 'L', label: 'fleet-lead' }, "O's own control says whose pause covers it");
  assert.deepEqual(o.controls.O.can.resume, { ok: false, code: 'covered' });

  // Reprise: the host released the coordinators; workers stay blocked
  assert.equal(uiResume(db, deps, { wsId: 'L' }).outcome, 'resuming');
  o = readPauseOverview(db, deps);
  assert.equal(o.runs[0].phase, 'resuming');
  assert.equal(o.byWorkspace.L.ui, 'released');
  assert.equal(o.byWorkspace.o1.ui, 'blocked');
  assert.equal(o.controls.L.can.release.ok, true);

  // "Libérer tout" as the LEAD: its OWN run only (L, l1) — O's workers come back `below`, nothing written for them
  const lead = uiRelease(db, deps, { wsId: 'L', targets: 'all' });
  assert.deepEqual(lead.result!.released, ['l1']);
  assert.deepEqual(lead.result!.below.slice().sort(), ['o1', 'o2', 's1'], "every worker of a run BELOW the lead's own is left to its coordinator");
  assert.ok(lead.explain.some((e) => e.tone === 'warn' && /laissé/.test(e.title)), 'below is explained, not silent');
  // a WORKER row cannot release (typed `refused` + who may)
  const w = uiRelease(db, deps, { wsId: 'o1', targets: ['o2'] });
  assert.equal(w.result!.refused[0].wsId, 'o2');
  assert.ok(w.result!.refused[0].mayBe.includes('O'));
  assert.equal(w.result!.released.length, 0);
  assert.ok(w.explain.some((e) => e.tone === 'error'));
  // the OPS releases its own wave one by one, then the sub-OPS its worker
  assert.deepEqual(uiRelease(db, deps, { wsId: 'O', targets: ['o1'] }).result!.released, ['o1']);
  assert.deepEqual(uiRelease(db, deps, { wsId: 'O', targets: ['o2'] }).result!.released, ['o2']);
  const last = uiRelease(db, deps, { wsId: 'S', targets: 'all' });
  assert.deepEqual(last.result!.released, ['s1']);
  assert.equal(last.result!.finished, true, 'the last release closes the Reprise');
  o = last.overview;
  assert.equal(readCarrierColumns(db, 'L')!.pausedAt, null, 'the pause is lifted');
  assert.deepEqual(o.byWorkspace, {}, 'no badge once everyone is released');
  // the accusés are still tracked ("N/M repris — manquent")
  const tracked = o.runs.find((r) => r.carrierRunId === 'L')!;
  assert.equal(tracked.phase, 'active');
  assert.equal(tracked.progress.kind, 'repris');
  assert.equal(tracked.progress.done, 0);
  assert.equal(tracked.progress.total, 7);
  for (const ws of ['L', 'O', 'S', 'o1', 'o2', 's1', 'l1']) confirmReprise(db, ws);
  assert.deepEqual(readPauseOverview(db, deps).runs, [], 'every accusé in: nothing left to chase');
  db.close();
});

test("a member RELEASED by an inner carrier but still blocked by an outer one reads BLOCKED by the OUTER (the gate's own answer, not the nearest carrier)", () => {
  const db = freshDb();
  tree(db);
  uiPause(db, deps, { wsId: 'L', mode: 'hard' });
  trap(db);
  setRunPause(db, 'O', true, 'O'); // a second, nested carrier
  trap(db, 'O');
  let o = readPauseOverview(db, deps);
  assert.deepEqual([o.byWorkspace.o1.carrierRunId, o.byWorkspace.o1.ui], ['O', 'paused'], "the NEAREST blocking carrier answers while both pause it");
  assert.equal(uiResume(db, deps, { wsId: 'L' }).outcome, 'resuming');
  assert.equal(uiResume(db, deps, { wsId: 'O' }).outcome, 'resuming');
  assert.equal(uiRelease(db, deps, { wsId: 'O', targets: ['o1'] }).result!.released[0], 'o1');
  o = readPauseOverview(db, deps);
  assert.deepEqual([o.byWorkspace.o1.carrierRunId, o.byWorkspace.o1.ui], ['L', 'blocked'], 'O released o1, L still blocks it: the badge must NOT say "libéré"');
  db.close();
});

test("a member that JOINS the tree during the Reprise (not in the roster yet) reads BLOCKED — fail closed, never 'libéré'", () => {
  const db = freshDb();
  tree(db);
  uiPause(db, deps, { wsId: 'L', mode: 'hard' });
  trap(db);
  uiResume(db, deps, { wsId: 'L' });
  const late: WaveNode = { id: 'late', parentId: 'O' };
  NODES.push(late);
  byId.set('late', late);
  try {
    const o = readPauseOverview(db, deps);
    assert.deepEqual([o.byWorkspace.late.ui, o.byWorkspace.late.role], ['blocked', null], 'seeded BLOCKED by the host sweep; until then the UI says blocked too');
  } finally {
    NODES.pop();
    byId.delete('late');
  }
  db.close();
});

test('an orchestrator row whose run names ANOTHER coordinator is not anchored: its control is refused by the hold rule, explained before the click', () => {
  const db = freshDb();
  tree(db);
  busRuns.startRun(db, { id: 'R', kind: 'vague', coordinator: 'R2' }, ON); // the run id is R's workspace id, but its coordinator is a successor
  const r: WaveNode = { id: 'R', kind: 'orchestrator' };
  NODES.push(r);
  byId.set('R', r);
  try {
    const o = readPauseOverview(db, deps);
    assert.equal(o.controls.R.anchored, false);
    assert.deepEqual(o.controls.R.can.pauseSoft, { ok: false, code: 'refused' });
    const click = uiPause(db, deps, { wsId: 'R', mode: 'soft' });
    assert.equal(click.outcome, 'refused', 'and the writer agrees: nothing written');
    assert.equal(getRunPause(db, 'R'), null);
  } finally {
    NODES.pop();
    byId.delete('R');
  }
  db.close();
});

test("a stale pause column on a switch-OFF CHILD run under a live pause is not a second run (the carrier view must be its OWN)", () => {
  const db = freshDb();
  tree(db);
  busRuns.startRun(db, { id: 'Y', kind: 'vague', coordinator: 'Y', parentRunId: 'L' }, OFF);
  db.prepare('UPDATE runs SET paused_at = ?, paused_by = ?, pause_mode = ? WHERE id = ?').run(Date.now(), 'Y', 'hard', 'Y');
  uiPause(db, deps, { wsId: 'L', mode: 'hard' });
  const o = readPauseOverview(db, deps);
  assert.deepEqual(o.runs.map((r) => r.carrierRunId), ['L'], 'only the live carrier; Y\'s column is stale (its frozen switch is OFF) and must not echo L\'s pause under its own id');
  db.close();
});

test('toBilanLine caps the killed list (newest 12, total kept) and the notes, and never throws on a sparse row', () => {
  const killed = Array.from({ length: 30 }, (_, i) => ({ pid: i, cmd: `c${i}`, cwd: null, signal: 'SIGTERM', outcome: 'exited' }));
  const line = toBilanLine({ id: 1, runId: 'L', wsId: 'x', pausedAt: 1, activity: { surface: 'sdk', notes: Array.from({ length: 20 }, (_, i) => `n${i}`) }, snapshotRef: null, dirty: null, killed, error: 'boom', createdAt: 1 });
  assert.equal(line.killed.length, 12);
  assert.equal(line.killed[11].cmd, 'c29');
  assert.equal(line.killedCount, 30);
  assert.equal(line.notes.length, 8);
  assert.equal(line.error, 'boom');
  const sparse = toBilanLine({ id: 2, runId: 'L', wsId: 'y', pausedAt: 1, activity: null, snapshotRef: null, dirty: null, killed: null, error: null, createdAt: 1 });
  assert.deepEqual(sparse.killed, []);
  assert.equal(sparse.wasDoing.turnRunning, false);
});

test('a pause on a run whose FROZEN switch is OFF is not a pause for the UI (a stale column never paints a badge)', () => {
  const db = freshDb();
  tree(db);
  db.prepare('UPDATE runs SET paused_at = ?, paused_by = ?, pause_mode = ? WHERE id = ?').run(Date.now(), 'Z', 'hard', 'Z');
  const o = readPauseOverview(db, deps);
  assert.deepEqual(o.runs, []);
  assert.deepEqual(o.byWorkspace, {});
  db.close();
});
