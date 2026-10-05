import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as bus from './bus.ts';
import * as busRuns from './bus-runs.ts';
import { getRunPause, setRunPause } from './bus-pause.ts';
import { getRunHold, setRunHold } from './bus-runs.ts';
import { appendBilanNote, insertBilan, readPauseOrigin } from './bus-pause-records.ts';
import { confirmMember, enrollMember } from './pause-douce.ts';
import { confirmReprise, readCarrierColumns, setLiveTreeSource } from './pause-reprise.ts';
import { pauseOverviewFingerprint, readPauseOverview, toBilanLine, uiPause, uiRelease, uiResume, type PauseUiDeps } from './pause-ui.ts';
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

/** What the host trap really stores in `pause_records.killed_json` (src/main/pause-kill.ts `KillReport`), NOT a bare array. */
const killReport = (killed: unknown[], extra: Record<string, unknown> = {}) => ({ cliPid: 100, cli: { pid: 100, startTicks: 1 }, killed, refused: [], spared: [], survivors: [], rounds: 1, ...extra });
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
      killed: killReport(ws === 'o1' ? [{ pid: 7, cmd: 'tsc --noEmit', cwd: '/w/o1', signal: 'SIGTERM', outcome: 'exited' }] : []),
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
  assert.equal(r.explain!.fix.length, 2);
  assert.match(r.explain!.fix[0], /mettre en pause sa vague wave-ops/);
  assert.match(r.explain!.fix[1], /suspend TOUTE sa vague/);
  assert.equal(r.explain!.actions, undefined, 'a refusal NAMES the run, it does not offer to pause it (Q5)');
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
  assert.equal(o1.bilan!.killedCount, 1);
  assert.equal(o1.bilan!.trap, 'done');
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

test('toBilanLine reads the REAL killed_json (a KillReport: killed + survivors + refused) ∪ earlier attempts ∪ the observer, like the Consigne; null = trap pending; {skipped} = remote', () => {
  const k = (i: number) => ({ pid: i, cmd: `c${i}`, cwd: `/w${i}`, signal: 'SIGTERM', outcome: i === 2 ? 'survived' : 'exited' });
  const report = killReport([k(1), k(2), k(3)], { survivors: [{ pid: 2, comm: 'sleep', cmd: 'sleep 600', reason: 'same identity after SIGKILL' }], refused: [{ pid: 9, comm: 'x', cmd: 'x', reason: 'unreadable' }] });
  const line = toBilanLine({ id: 1, runId: 'L', wsId: 'x', pausedAt: 1, activity: { surface: 'sdk', earlierKilled: [{ pid: 50, cmd: 'earlier', cwd: null, signal: 'SIGTERM', outcome: 'exited' }], observerKilled: [{ pid: 60, cmd: 'observer', cwd: '/o', signal: 'SIGTERM', outcome: 'exited' }, { pid: 1, cmd: 'c1', cwd: '/w1', signal: 'SIGTERM', outcome: 'exited' }], snapshotWarnings: ['unreadable.bin'], notes: Array.from({ length: 20 }, (_, i) => `n${i}`) }, snapshotRef: 'refs/orchestra/pause/L/x/1', dirty: true, killed: report, error: 'kill: 1 still alive', createdAt: 1 });
  assert.deepEqual(line.killed.map((x) => x.cmd), ['c1', 'c2', 'c3', 'earlier', 'observer'], 'the Consigne\'s merge: trap kills ∪ earlier ∪ observer, de-duplicated (c1 appears twice)');
  assert.equal(line.killedCount, 5);
  assert.equal(line.killed.find((x) => x.cmd === 'c2')!.outcome, 'survived', 'the trap\'s own per-process outcome is kept');
  assert.equal(line.trap, 'done');
  assert.deepEqual(line.survivors, [{ cmd: 'sleep 600', pid: 2, reason: 'same identity after SIGKILL' }]);
  assert.deepEqual(line.refused, [{ cmd: 'x', pid: 9, reason: 'unreadable' }]);
  assert.deepEqual(line.warnings, ['unreadable.bin']);
  assert.equal(line.notes.length, 8);
  assert.equal(line.error, 'kill: 1 still alive');
  const many = toBilanLine({ id: 1, runId: 'L', wsId: 'x', pausedAt: 1, activity: null, snapshotRef: null, dirty: null, killed: killReport(Array.from({ length: 30 }, (_, i) => k(i + 10))), error: null, createdAt: 1 });
  assert.equal(many.killed.length, 12, 'newest 12');
  assert.equal(many.killed[11].cmd, 'c39');
  assert.equal(many.killedCount, 30);
  const pending = toBilanLine({ id: 2, runId: 'L', wsId: 'y', pausedAt: 1, activity: null, snapshotRef: null, dirty: null, killed: null, error: null, createdAt: 1 });
  assert.deepEqual([pending.trap, pending.killedCount, pending.skipped], ['pending', 0, null], 'NULL killed_json = the trap has not finished for this member — never "no tool killed"');
  const remote = toBilanLine({ id: 3, runId: 'L', wsId: 'z', pausedAt: 1, activity: { surface: 'remote' }, snapshotRef: null, dirty: null, killed: { skipped: 'sandbox member: not applicable' }, error: null, createdAt: 1 });
  assert.deepEqual([remote.trap, remote.skipped, remote.killedCount], ['skipped', 'sandbox member: not applicable', 0]);
  assert.equal(toBilanLine({ id: 4, runId: 'L', wsId: 'w', pausedAt: 1, activity: { surface: 'sdk', interrupt: 'exempt' }, snapshotRef: null, dirty: null, killed: killReport([]), error: null, createdAt: 1 }).exempt, true);
});

test('a UI pause records an EMPTY origin (the shipped writer): the trap does not wait for a CLI chain, and nobody is spared', () => {
  const db = freshDb();
  tree(db);
  const r = uiPause(db, deps, { wsId: 'L', mode: 'hard' });
  assert.equal(r.outcome, 'paused');
  assert.deepEqual(readPauseOrigin(db, 'L', getRunPause(db, 'L')!.pausedAt), [], 'an empty chain is "recorded, no pauser" (readPauseOrigin returns [] not null)');
  assert.equal(uiPause(db, deps, { wsId: 'L', mode: 'hard' }).outcome, 'already-paused', 'a repeat does not write a second origin');
  assert.equal(readPauseOverview(db, deps).runs[0].members.length, 0, 'and the origin row is never listed as a member');
  db.close();
});

test('a writer that THROWS is a typed write-failed with the reason — never a rejected invoke, never a silent panel', () => {
  const db = freshDb();
  tree(db);
  const bad = new Proxy(db, { get: (t, k) => (k === 'prepare' ? () => { throw new Error('SQLITE_BUSY: database is locked'); } : (t as never)[k]) }) as unknown as bus.BusDb;
  const p = uiPause(bad, deps, { wsId: 'L', mode: 'soft' });
  assert.equal(p.outcome, 'write-failed');
  assert.match(p.explain!.why, /SQLITE_BUSY: database is locked/);
  assert.match(p.explain!.why, /rien n'est garanti écrit/);
  const rs = uiResume(bad, deps, { wsId: 'L' });
  assert.equal(rs.outcome, 'write-failed');
  const rl = uiRelease(bad, deps, { wsId: 'L', targets: ['O'] });
  assert.equal(rl.result, null);
  assert.equal(rl.explain[0].title, 'Écriture refusée par le bus');
  db.close();
});

test('uiPause over a RESUMING run = back to PAUSED in a NEW epoch owned by this row (the UI "Re-pause"), nothing stays released', () => {
  const db = freshDb();
  tree(db);
  uiPause(db, deps, { wsId: 'L', mode: 'hard' });
  const first = trap(db);
  uiResume(db, deps, { wsId: 'L' });
  uiRelease(db, deps, { wsId: 'O', targets: ['o1'] });
  const again = uiPause(db, deps, { wsId: 'L', mode: 'soft' });
  assert.equal(again.outcome, 'paused');
  const p = getRunPause(db, 'L')!;
  assert.ok(p.pausedAt > first, 'a NEW epoch');
  assert.equal(p.mode, 'soft');
  assert.equal(readCarrierColumns(db, 'L')!.resumeStartedAt, null);
  const run = again.overview.runs.find((r) => r.carrierRunId === 'L')!;
  assert.equal(run.phase, 'pausing');
  assert.equal(run.progress.done, 0, 'the new epoch starts with an empty roster — o1 is held again');
  assert.equal(again.overview.byWorkspace.o1.ui, 'pausing');
  db.close();
});

test('pauseOverviewFingerprint: EVERY column the overview reads moves it; a message / ack does not', () => {
  const db = freshDb();
  tree(db);
  uiPause(db, deps, { wsId: 'L', mode: 'hard' });
  const pausedAt = getRunPause(db, 'L')!.pausedAt;
  const moved = (label: string, change: () => void): void => {
    const before = pauseOverviewFingerprint(db);
    change();
    assert.notEqual(pauseOverviewFingerprint(db), before, `${label} must move the fingerprint`);
  };
  const still = (label: string, change: () => void): void => {
    const before = pauseOverviewFingerprint(db);
    change();
    assert.equal(pauseOverviewFingerprint(db), before, `${label} must NOT move it`);
  };
  trap(db);
  still('a bus message', () => bus.send(db, { runId: 'L', sender: 'L', recipient: 'O', kind: 'status', body: 'hi' }));
  moved('a Bilan note appended after the trap', () => appendBilanNote(db, 'L', 'o1', pausedAt, 'late note'));
  moved('pause_auto cleared (a human takes over a host pause)', () => { db.prepare("UPDATE runs SET pause_auto = '{}' WHERE id = 'L'").run(); void 0; });
  moved('pause_auto set', () => db.prepare('UPDATE runs SET pause_auto = NULL WHERE id = ?').run('L'));
  moved('a roster role flip', () => db.prepare("UPDATE pause_members SET role = 'worker' WHERE ws_id = 'O'").run());
  moved('a member_run filled', () => db.prepare("UPDATE pause_members SET member_run = 'LL' WHERE ws_id = 'l1'").run());
  moved('a Bilan error set', () => db.prepare("UPDATE pause_records SET error = 'boom' WHERE ws_id = 'o2'").run());
  moved('a kill recorded', () => db.prepare("UPDATE pause_records SET killed_json = ? WHERE ws_id = 'o2'").run(JSON.stringify(killReport([{ pid: 1, cmd: 'x', cwd: null, signal: 'SIGTERM', outcome: 'exited' }]))));
  moved('a coordinator swap on a run (same length id)', () => db.prepare("UPDATE runs SET coordinator = 'Q' WHERE id = 'S'").run());
  moved('the Reprise starts', () => uiResume(db, deps, { wsId: 'L' }));
  moved('a release', () => uiRelease(db, deps, { wsId: 'O', targets: ['o1'] }));
  moved('a frozen flag changed', () => db.prepare("UPDATE run_flags SET flags = flags || ' ' WHERE run_id = 'Z'").run());
  db.close();
});

test('a pause on a run whose FROZEN switch is OFF is not a pause for the UI (a stale column never paints a badge)', () => {
  const db = freshDb();
  tree(db);
  db.prepare('UPDATE runs SET paused_at = ?, paused_by = ?, pause_mode = ? WHERE id = ?').run(Date.now(), 'Z', 'hard', 'Z');
  const o = readPauseOverview(db, deps);
  assert.deepEqual(o.runs, []);
  assert.deepEqual(o.byWorkspace, {});
  assert.equal(o.controls.Z.phase, 'active', 'the control agrees: an unenforced column is not a paused run');
  db.close();
});

test('toBilanLine carries what the snapshot did NOT capture (skippedLarge, submodules, snapshotNotes) — the facts `orchestra run status` prints', () => {
  const line = toBilanLine({ id: 1, runId: 'L', wsId: 'x', pausedAt: 1, activity: { surface: 'sdk', skippedLarge: [{ path: 'a.bin', bytes: 100 }, { path: 'data/huge.bin', bytes: 3 * 1024 ** 3, reason: 'file-cap' }, { path: 'out/m.ckpt', bytes: 800 * 1048576, reason: 'total-cap', files: 4 }], skippedLargeCount: 9, snapshotNotes: ['captured anyway'], submodules: [{ path: 'vendor/lib', ref: null, dirty: true, error: 'git add failed' }, { path: 'vendor/ok', ref: 'refs/x', dirty: false }] }, snapshotRef: 'refs/orchestra/pause/L/x/1', dirty: true, killed: killReport([]), error: null, createdAt: 1 });
  assert.deepEqual(line.notCaptured.map((f) => [f.path, f.bytes, f.files, f.reason]), [['data/huge.bin', 3 * 1024 ** 3, null, 'file-cap'], ['out/m.ckpt', 800 * 1048576, 4, 'total-cap'], ['a.bin', 100, null, null]], 'the LARGEST first');
  assert.equal(line.notCapturedCount, 9, 'the total, even though the list keeps 6');
  assert.deepEqual(line.snapshotNotes, ['captured anyway']);
  assert.deepEqual(line.submodules, [{ path: 'vendor/lib', ref: null, dirty: true, error: 'git add failed' }, { path: 'vendor/ok', ref: 'refs/x', dirty: false, error: null }]);
  const none = toBilanLine({ id: 2, runId: 'L', wsId: 'y', pausedAt: 1, activity: null, snapshotRef: null, dirty: null, killed: null, error: null, createdAt: 1 });
  assert.deepEqual([none.notCaptured, none.notCapturedCount, none.snapshotNotes, none.submodules], [[], 0, [], []]);
});

test('toBilanLine strips control / invisible / bidi characters from EVERY recorded string (agent- and filesystem-chosen text), like `run status` and the Consigne', () => {
  const evil = 'make test\u202E gnirts \u202C\x1b[2J\u2028forged line\u200b\u206a\u206f\u2065';
  const line = toBilanLine({ id: 1, runId: 'L', wsId: 'x', pausedAt: 1, activity: { surface: 'sdk', branch: 'b\u202Ec', notes: [evil], snapshotWarnings: [evil], snapshotNotes: [evil], inFlightTools: [{ tool: 'Bash', toolUseId: 't', sinceMs: 1, input: evil }], bgTasks: [{ id: 'b', description: evil, status: 'running' }], skippedLarge: [{ path: evil, bytes: 5 }], submodules: [{ path: evil, ref: evil, dirty: false, error: evil }], observerKilled: [{ pid: 3, cmd: evil, cwd: evil, signal: 'SIGTERM', outcome: 'exited' }] }, snapshotRef: 'refs/x\u202E', dirty: true, killed: killReport([{ pid: 1, cmd: evil, cwd: evil, signal: 'SIGTERM', outcome: 'exited' }], { survivors: [{ pid: 2, cmd: evil, reason: evil }], refused: [{ pid: 3, cmd: evil, reason: evil }] }), error: evil, createdAt: 1 });
  const bad = /[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u206f\ufeff]/u; // U+206A-206F (deprecated format controls) + the unassigned U+2065 included
  const all: string[] = [];
  const walk = (v: unknown): void => { if (typeof v === 'string') all.push(v); else if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v === 'object') Object.values(v).forEach(walk); };
  walk(line);
  assert.ok(all.length > 20, `walked ${all.length} strings`);
  assert.deepEqual(all.filter((x) => bad.test(x)), [], 'no control / bidi / invisible character survives in ANY field of the Bilan line');
  assert.ok(line.killed[0].cmd.startsWith('make test'), 'the text itself is kept');
});

test('a PLAIN run-anchoring parent (#221: a non-orchestrator whose run the host created) gets a CONTROL (chooser + ▶), and its pause is the writer\'s own — not a worker refusal', () => {
  const db = freshDb();
  tree(db);
  busRuns.startRun(db, { id: 'P', kind: 'mission', coordinator: 'P' }, ON); // the host's mission run for a plain parent
  const P: WaveNode = { id: 'P', parentId: 'O' }; // UNDER an orchestrator's wave: the nearest orchestrator is O, but the row ANCHORS its own run P — the control acts on P
  const pc: WaveNode = { id: 'pc', parentId: 'P' };
  NODES.push(P, pc);
  byId.set('P', P);
  byId.set('pc', pc);
  try {
    const o = readPauseOverview(db, deps);
    assert.ok(o.controls.P, 'a control exists for the row that anchors a run');
    assert.equal(o.controls.P.runId, 'P');
    assert.equal(o.controls.P.anchored, true);
    assert.deepEqual(o.controls.P.can.pauseSoft, { ok: true });
    assert.equal(o.controls.pc, undefined, 'its child is a worker: no control');
    assert.equal(o.controls.plain, undefined, 'a plain workspace with NO run is still a worker row (no-run at click time)');
    const r = uiPause(db, deps, { wsId: 'P', mode: 'soft' });
    assert.equal(r.outcome, 'paused');
    assert.equal(r.runId, 'P');
    assert.equal(r.overview.controls.P.phase, 'pausing', 'and its row keeps its control while paused (▶ / ■ available)');
    assert.equal(r.overview.byWorkspace.pc.ui, 'pausing');
  } finally {
    NODES.pop(); NODES.pop();
    byId.delete('P'); byId.delete('pc');
  }
  db.close();
});

test('uiResume = `orchestra run resume`: the Reprise THEN the liveness hold lifted (same verb, same authority); a refused caller lifts nothing', () => {
  const db = freshDb();
  tree(db);
  uiPause(db, deps, { wsId: 'L', mode: 'hard' });
  trap(db);
  setRunHold(db, 'L', true, 'L');
  setRunHold(db, 'O', true, 'O');
  assert.notEqual(getRunHold(db, 'L'), null, 'held before');
  const worker = uiResume(db, deps, { wsId: 'o1' });
  assert.equal(worker.outcome, 'refused');
  assert.equal(worker.holdLifted, false);
  assert.notEqual(getRunHold(db, 'O'), null, 'a refused resume (a worker row) lifts NOTHING — the hold of ITS run stays (the lift is the CALLER\'s authority, never the coordinator\'s)');
  assert.notEqual(getRunHold(db, 'L'), null, 'nor the ancestor\'s hold');
  const go = uiResume(db, deps, { wsId: 'L' });
  assert.equal(go.outcome, 'resuming');
  assert.equal(go.holdLifted, true);
  assert.equal(getRunHold(db, 'L'), null, 'the hold is lifted with the Reprise, as the CLI verb does');
  uiRelease(db, deps, { wsId: 'L', targets: 'all' });
  uiRelease(db, deps, { wsId: 'O', targets: 'all' });
  uiRelease(db, deps, { wsId: 'S', targets: 'all' });
  assert.equal(readCarrierColumns(db, 'L')!.pausedAt, null, 'a COMPLETE Reprise leaves the run neither paused nor held');
  assert.equal(getRunHold(db, 'L'), null);
  db.close();
});

test('« Libérer tout » = `release --all`: the acting row\'s OWN run only; the workers of a nested wave come back `below` with a second explicit gesture (one click never dispatches another OPS\'s workers)', () => {
  const db = freshDb();
  tree(db);
  uiPause(db, deps, { wsId: 'L', mode: 'hard' });
  trap(db);
  uiResume(db, deps, { wsId: 'L' });
  const first = uiRelease(db, deps, { wsId: 'L', targets: 'all' });
  assert.deepEqual(first.result!.released, ['l1'], 'only the lead\'s own worker');
  assert.deepEqual(first.result!.below.slice().sort(), ['o1', 'o2', 's1'], 'O\'s and S\'s workers are left to their coordinators');
  assert.equal(first.result!.finished, false);
  const warn = first.explain.find((e) => e.tone === 'warn')!;
  assert.equal(warn.actions?.length, 1);
  assert.deepEqual(warn.actions![0], { kind: 'release', wsId: 'L', carrierRunId: 'L', ids: first.result!.below, label: warn.actions![0].label });
  const stillBlocked = readPauseOverview(db, deps).runs[0].members.filter((m) => m.ui === 'blocked').map((m) => m.wsId).sort();
  assert.deepEqual(stillBlocked, ['o1', 'o2', 's1'], 'nothing below was released by the first gesture');
  // the SECOND, explicit gesture: the ids the explanation carried
  const second = uiRelease(db, deps, { wsId: 'L', targets: warn.actions![0].ids, carrierRunId: 'L' });
  assert.deepEqual(second.result!.released.slice().sort(), ['o1', 'o2', 's1']);
  assert.equal(second.result!.finished, true);
  db.close();
});

test('LABELS are sanitized like every other recorded string: a workspace name / branch with bidi + deprecated-format chars never reaches the overview raw (R1b-4)', () => {
  const db = freshDb();
  tree(db);
  const hostile: PauseUiDeps = { ...deps, labelOf: (id) => (id === 'L' ? 'fleet\u202Elead\u206A\u2065x' : id === 'o1' ? 'wor\u200Bker\x1b[2J-1' : deps.labelOf(id)) };
  uiPause(db, deps, { wsId: 'L', mode: 'hard' });
  trap(db);
  const o = readPauseOverview(db, hostile);
  const bad = /[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u206f\ufeff]/u;
  const all: string[] = [];
  const walk = (v: unknown): void => { if (typeof v === 'string') all.push(v); else if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v === 'object') Object.values(v).forEach(walk); };
  walk(o);
  assert.deepEqual(all.filter((x) => bad.test(x)), [], 'no control / bidi / format character survives in ANY string of the overview (labels included)');
  assert.equal(o.runs[0].carrierLabel, 'fleet lead  x', 'the label text itself is kept, each bad char becomes a space');
  assert.equal(o.runs[0].pausedByLabel, 'fleet lead  x', 'pausedByLabel goes through the same labeler');
  assert.ok(o.runs[0].members.some((m) => m.label === 'wor ker [2J-1'), 'a member label too');
  db.close();
});

test('an UNKNOWN pause mode is refused (typed write-failed, nothing written) — never defaulted to the destructive Pause dure (R1b)', () => {
  const db = freshDb();
  tree(db);
  for (const bogus of ['bogus', '', undefined, 'HARD']) {
    const r = uiPause(db, deps, { wsId: 'L', mode: bogus as never });
    assert.equal(r.outcome, 'write-failed', String(bogus));
    assert.equal(r.explain?.tone, 'error');
    assert.match(r.explain!.why, /unknown pause mode/);
  }
  assert.equal(getRunPause(db, 'L'), null, 'nothing was written by any of them');
  assert.equal(uiPause(db, deps, { wsId: 'L', mode: 'soft' }).outcome, 'paused', 'a valid mode still works');
  db.close();
});
