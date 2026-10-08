import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as bus from './bus.ts';
import * as busRuns from './bus-runs.ts';
import {
  activePauseFor,
  beginReprise,
  getRunPause,
  pausedCarrierForWorkspace,
  pauseRefusalWith,
  runSubtreeIds,
  runsOwingPauseTrap,
  setRunPause,
} from './bus-pause.ts';
import { insertBilan, recordPauseOrigin } from './bus-pause-records.ts';
import {
  confirmReprise,
  finishRepriseIfDone,
  releasedWhileResuming,
  REPRISE_TRACKING_TTL_MS,
  readCarrierColumns,
  readRoster,
  releaseMembers,
  repriseStatusView,
  resumingCarrierFor,
  revertResumeToPaused,
  seedRoster,
  setLiveTreeSource,
  sweepReprise,
  upsertRosterMember,
} from './pause-reprise.ts';
import { DEFAULT_BUS_SWITCHES, type BusSwitches } from '../shared/bus-switches.ts';
import { pausePhaseOf } from '../shared/pause-lifecycle.ts';
import type { WaveNode } from './wave-run-id.ts';

// #255 structured Reprise — the bus half over a REAL bus.sqlite under the real home (btrfs, never /tmp, never the live bus). Expectations are
// literals; each arm names the clause an in-place mutant (scripts/pause-trap/mutate-unit.mjs, "reprise-*") breaks.

const ROOT = path.join(os.homedir(), '.cache', `pause-e2-reprise-${process.pid}`);
const ON: BusSwitches = { ...DEFAULT_BUS_SWITCHES, pause: true };
const OFF: BusSwitches = { ...DEFAULT_BUS_SWITCHES };
let n = 0;

function freshDb(): { db: bus.BusDb; file: string } {
  fs.mkdirSync(ROOT, { recursive: true });
  const file = path.join(ROOT, `r${n++}.sqlite`);
  return { db: bus.openBus(file), file };
}
test.after(() => fs.rmSync(ROOT, { recursive: true, force: true }));

/** Run id == its coordinator's workspace id (the app's anchor rule). L mission ⊃ O ⊃ S ; X sibling vague under L. */
function tree(db: bus.BusDb, sw: BusSwitches = ON): void {
  busRuns.startRun(db, { id: 'L', kind: 'mission', coordinator: 'L' }, sw);
  busRuns.startRun(db, { id: 'O', kind: 'vague', coordinator: 'O', parentRunId: 'L' }, sw);
  busRuns.startRun(db, { id: 'S', kind: 'vague', coordinator: 'S', parentRunId: 'O' }, sw);
  busRuns.startRun(db, { id: 'X', kind: 'vague', coordinator: 'X', parentRunId: 'L' }, sw);
}

/** The live workspace tree matching the runs above + workers: o1/o2 under O, s1 under S, x1 under X, l1 plain under L. */
const NODES: WaveNode[] = [
  { id: 'L', kind: 'orchestrator' },
  { id: 'O', kind: 'orchestrator', parentId: 'L' },
  { id: 'S', kind: 'orchestrator', parentId: 'O' },
  { id: 'X', kind: 'orchestrator', parentId: 'L' },
  { id: 'o1', parentId: 'O' },
  { id: 'o2', parentId: 'O' },
  { id: 's1', parentId: 'S' },
  { id: 'x1', parentId: 'X' },
  { id: 'l1', parentId: 'L' },
];
const byId = new Map(NODES.map((w) => [w.id, w]));
const getWorkspace = (id: string): WaveNode | undefined => byId.get(id);

/** Pause L and record a Bilan row per member of the paused subtree (what the host trap writes). */
function pauseAndTrap(db: bus.BusDb, killO1 = true): number {
  assert.equal(setRunPause(db, 'L', true, 'L'), 'paused');
  const pausedAt = getRunPause(db, 'L')!.pausedAt;
  const memberRun: Record<string, string> = { L: 'L', O: 'O', S: 'S', X: 'X', o1: 'O', o2: 'O', s1: 'S', x1: 'X', l1: 'L' };
  for (const [ws, run] of Object.entries(memberRun)) {
    const killed = ws === 'o1' && killO1
      ? [{ pid: 11, comm: 'bash', cmd: 'sleep 600 && make rig', startTicks: 1, cwd: '/w/o1', evidence: 'x', signal: 'SIGTERM', via: 'child', outcome: 'exited' }]
      : ws === 'O'
        ? [{ pid: 12, comm: 'node', cmd: 'node dev-server.js --port 4000', startTicks: 2, cwd: '/w/O', evidence: 'x', signal: 'SIGTERM', via: 'child', outcome: 'exited' }] // the OPS's OWN session had a command killed too
        : [];
    insertBilan(db, {
      runId: 'L',
      wsId: ws,
      pausedAt,
      activity: { surface: 'sdk', memberRun: run, turnRunning: ws === 'o1' || ws === 'o2', ...(ws === 'o1' || ws === 'o2' ? { interrupt: 'interrupted' as const } : {}), branch: `br-${ws}`, head: `head${ws}00000000`, ...(ws === 'o2' ? { notes: ['o2 note'], inFlightTools: [{ tool: 'Bash', toolUseId: 'tu-o2', sinceMs: 5000, input: 'npm test -- --watch' }] } : {}) },
      snapshotRef: `refs/orchestra/pause/L/${ws}/1`,
      dirty: ws !== 'o2',
      killed: { killed, survivors: [], refused: [], spared: [] },
      error: null,
    });
  }
  db.prepare('UPDATE runs SET pause_trap_at = ? WHERE id = ?').run(pausedAt + 5, 'L');
  return pausedAt;
}

/** `--all` is per OWN run (review M1): "release everything" = each coordinator's `--all` (a LEAD's `--all` leaves the OPS's workers to their OPS). */
function releaseAll(db: bus.BusDb): void {
  for (const c of ['L', 'O', 'X', 'S']) releaseMembers(db, 'L', c, 'all');
}

const reprRows = (db: bus.BusDb) =>
  db.prepare("SELECT * FROM messages WHERE kind = 'reprise' ORDER BY sequence").all() as Array<{ sequence: number; run_id: string; sender: string; recipient: string; body: string }>;

// ── beginReprise: outcomes ──────────────────────────────────────────────────

test('beginReprise outcomes: no-run · not-paused · refused (worker / no identity) · host never refused · already-resuming (nothing re-sent)', () => {
  const { db } = freshDb();
  tree(db);
  assert.equal(beginReprise(db, 'nope', 'L'), 'no-run');
  assert.equal(beginReprise(db, 'L', 'L'), 'not-paused');
  pauseAndTrap(db);
  assert.equal(beginReprise(db, 'L', 'o1'), 'refused', 'a worker cannot resume');
  assert.equal(beginReprise(db, 'L', null), 'refused', 'no identity');
  assert.equal(beginReprise(db, 'L', 'O'), 'refused', 'a DESCENDANT run coordinator cannot resume its ancestor');
  assert.equal(readCarrierColumns(db, 'L')!.resumeStartedAt, null, 'refusals wrote nothing');
  assert.equal(reprRows(db).length, 0);
  assert.equal(beginReprise(db, 'L', null, { host: true, reason: 'usage_limit' }), 'resuming', 'a HOST caller (E3) is never refused');
  const rows = reprRows(db).length;
  assert.equal(rows, 4);
  assert.equal(beginReprise(db, 'L', 'L'), 'already-resuming');
  assert.equal(reprRows(db).length, rows, 'a second call re-sends nothing');
  db.close();
});

test('beginReprise by an ANCESTOR run coordinator is allowed (the hold rule): O paused, L resumes it', () => {
  const { db } = freshDb();
  tree(db);
  setRunPause(db, 'O', true, 'O');
  assert.equal(beginReprise(db, 'O', 'L'), 'resuming');
  db.close();
});

// ── beginReprise: what it writes ────────────────────────────────────────────

test('RESUMING: stamps resume_started_at, keeps paused_at, releases ONLY the four coordinators (released_by host), every worker stays unreleased', () => {
  const { db } = freshDb();
  tree(db);
  const pausedAt = pauseAndTrap(db);
  assert.equal(beginReprise(db, 'L', 'L'), 'resuming');
  const cols = readCarrierColumns(db, 'L')!;
  assert.equal(cols.pausedAt, pausedAt, 'the pause is NOT lifted');
  assert.notEqual(cols.resumeStartedAt, null);
  assert.equal(pausePhaseOf(cols), 'resuming');
  const roster = readRoster(db, 'L', pausedAt);
  const by = new Map(roster.map((r) => [r.wsId, r]));
  assert.deepEqual([...by.keys()].sort(), ['L', 'O', 'S', 'X', 'l1', 'o1', 'o2', 's1', 'x1']);
  for (const c of ['L', 'O', 'S', 'X']) {
    assert.equal(by.get(c)!.role, 'coordinator', c);
    assert.notEqual(by.get(c)!.releasedAt, null, `${c} released`);
    assert.equal(by.get(c)!.releasedBy, 'host', c);
  }
  for (const w of ['o1', 'o2', 's1', 'x1', 'l1']) {
    assert.equal(by.get(w)!.role, 'worker', w);
    assert.equal(by.get(w)!.releasedAt, null, `${w} stays BLOCKED`);
  }
  assert.equal(by.get('o1')!.memberRun, 'O');
  assert.equal(by.get('O')!.memberRun, 'O', "a coordinator's `member_run` is the run it coordinates (the Pause douce's convention: its own nearest orchestrator); the host releases it");
  assert.equal(by.get('L')!.memberRun, 'L', 'the top coordinator: the carrier itself');
  assert.deepEqual(runsOwingPauseTrap(db), [], 'a RESUMING carrier owes no host trap');
  db.close();
});

test('REPRISE ROWS: one kind=reprise row per coordinator, sender host, in DEPTH order (L, O, X, then S), each carrying the Bilan of ITS wave and the release commands', () => {
  const { db } = freshDb();
  tree(db);
  pauseAndTrap(db);
  assert.deepEqual(runSubtreeIds(db, 'L'), ['L', 'O', 'X', 'S']);
  beginReprise(db, 'L', 'L');
  const rows = reprRows(db);
  assert.deepEqual(rows.map((r) => [r.run_id, r.recipient, r.sender]), [['L', 'L', 'host'], ['O', 'O', 'host'], ['X', 'X', 'host'], ['S', 'S', 'host']]);
  const o = rows[1].body;
  for (const needle of [
    'coordinator of run O',
    'STILL BLOCKED',
    'orchestra run release --all',
    '• o1 [br-o1] — dirty tree: yes; snapshot ref: refs/orchestra/pause/L/o1/1; 1 killed: sleep 600 && make rig',
    '• o2 [br-o2] — dirty tree: no; snapshot ref: refs/orchestra/pause/L/o2/1; nothing killed',
    '• S [br-S]', // the child-run coordinator is one of O's direct reports
  ]) assert.ok(o.includes(needle), `O's row missing: ${needle}\n${o}`);
  assert.equal(o.includes('x1'), false, "another wave's member is not in O's Bilan");
  const l = rows[0].body;
  for (const needle of ['coordinator of run L', '• l1 [br-l1]', '• O [br-O]', '• X [br-X]']) assert.ok(l.includes(needle), `L's row missing: ${needle}\n${l}`);
  assert.equal(l.includes('o1 ['), false, "the LEAD does not get O's workers (O dispatches them)");
  db.close();
});

// ── the gate (`memberMayStart`) ─────────────────────────────────────────────

test('GATE: while RESUMING a released coordinator may start, every worker is still refused with the exact text, HUMAN stays allowed', () => {
  const { db } = freshDb();
  tree(db);
  pauseAndTrap(db);
  const deps = { getWorkspace, getBus: () => db };
  const refused = 'run en pause — orchestra run resume --run L';
  assert.equal(pauseRefusalWith(deps, byId.get('o1'), 'auto'), refused, 'paused: the worker is refused');
  assert.equal(pauseRefusalWith(deps, byId.get('O'), 'auto'), refused, 'paused: the OPS is refused');
  beginReprise(db, 'L', 'L');
  assert.equal(pauseRefusalWith(deps, byId.get('O'), 'auto'), null, 'RESUMING: the released OPS may start');
  assert.equal(pauseRefusalWith(deps, byId.get('L'), 'auto'), null, 'RESUMING: the released LEAD may start');
  for (const w of ['o1', 'o2', 's1', 'x1', 'l1']) assert.equal(pauseRefusalWith(deps, byId.get(w), 'auto'), refused, `${w} stays BLOCKED (no mass wake)`);
  assert.equal(pauseRefusalWith(deps, byId.get('o1'), 'human'), null, 'a HUMAN prompt is allowed and un-pauses nothing');
  assert.notEqual(pausedCarrierForWorkspace(db, byId.get('O')!, getWorkspace, { includeReleased: true }), null, 'the carrier is still readable for the release verbs');
  db.close();
});

test('GATE: a member released by the nearest carrier is STILL paused by an ANCESTOR carrier that has not resumed', () => {
  const { db } = freshDb();
  tree(db);
  pauseAndTrap(db); // L paused
  assert.equal(setRunPause(db, 'O', true, 'O'), 'paused'); // …and O paused on its own
  const pausedO = getRunPause(db, 'O')!.pausedAt;
  for (const ws of ['o1', 'o2']) insertBilan(db, { runId: 'O', wsId: ws, pausedAt: pausedO, activity: { surface: 'sdk', memberRun: 'O' }, snapshotRef: null, dirty: false, killed: { killed: [] }, error: null });
  beginReprise(db, 'O', 'O'); // O resumes, L does NOT
  assert.equal(readCarrierColumns(db, 'L')!.resumeStartedAt, null);
  const rel = releaseMembers(db, 'O', 'O', ['o1']);
  assert.deepEqual([rel.released, rel.finished], [['o1'], false], 'O is still RESUMING (o2 not released): the carrier O itself is what the release exemption looks at');
  const deps = { getWorkspace, getBus: () => db };
  assert.equal(pauseRefusalWith(deps, byId.get('o1'), 'auto'), 'run en pause — orchestra run resume --run L', 'L still pauses the member O released');
  assert.equal(pauseRefusalWith(deps, byId.get('o2'), 'auto'), 'run en pause — orchestra run resume --run O', 'the unreleased one is held by O itself');
  db.close();
});

// ── release ─────────────────────────────────────────────────────────────────

test('RELEASE authority: the coordinator of the member\'s run (or an ancestor run) may; a sibling OPS, the worker itself and a stranger may not', () => {
  const { db } = freshDb();
  tree(db);
  pauseAndTrap(db);
  beginReprise(db, 'L', 'L');
  const refusedBy = (actor: string) => releaseMembers(db, 'L', actor, ['o1']).refused.map((r) => r.wsId);
  assert.deepEqual(refusedBy('X'), ['o1'], 'a sibling OPS');
  assert.deepEqual(refusedBy('o1'), ['o1'], 'the worker itself');
  assert.deepEqual(refusedBy('o2'), ['o1'], 'a fellow worker');
  assert.deepEqual(refusedBy('nobody'), ['o1']);
  assert.deepEqual(refusedBy('S'), ['o1'], 'a DESCENDANT run coordinator');
  assert.equal(readRoster(db, 'L', getRunPause(db, 'L')!.pausedAt).find((r) => r.wsId === 'o1')!.releasedAt, null, 'refusals released nothing');
  const res = releaseMembers(db, 'L', 'O', ['o1']);
  assert.deepEqual(res.released, ['o1']);
  assert.equal(pauseRefusalWith({ getWorkspace, getBus: () => db }, byId.get('o1'), 'auto'), null, 'o1 may start now');
  assert.equal(pauseRefusalWith({ getWorkspace, getBus: () => db }, byId.get('o2'), 'auto')?.startsWith('run en pause'), true, 'o2 is still blocked (no mass wake)');
  assert.deepEqual(releaseMembers(db, 'L', 'O', ['o1']).already, ['o1'], 'idempotent');
  db.close();
});

test('RELEASE authority over the BUS run tree (no live tree registered): the member\'s run coordinator AND every ancestor run\'s may release it — an ancestor below the carrier too; a sibling OPS may not', () => {
  const { db } = freshDb();
  tree(db);
  pauseAndTrap(db);
  setLiveTreeSource(null);
  beginReprise(db, 'L', 'L');
  assert.deepEqual(releaseMembers(db, 'L', 'X', ['s1']).refused.map((r) => r.wsId), ['s1'], 'a sibling OPS');
  assert.deepEqual(releaseMembers(db, 'L', 'O', ['s1']).released, ['s1'], 'O is the coordinator of S\'s PARENT run: an ancestor below the carrier');
  assert.deepEqual(releaseMembers(db, 'L', 'S', ['s1']).already, ['s1']);
  db.close();
});

test('RELEASE sends the member ITS Consigne: kind reprise, sender = the releasing coordinator, in the member\'s own run, with the literal snapshot ref / killed command / dirty tree', () => {
  const { db } = freshDb();
  tree(db);
  pauseAndTrap(db);
  beginReprise(db, 'L', 'L');
  const before = reprRows(db).length;
  releaseMembers(db, 'L', 'O', ['o1']);
  const row = reprRows(db)[before];
  assert.deepEqual([row.run_id, row.sender, row.recipient], ['O', 'O', 'o1']);
  for (const needle of [
    'CONSIGNE DE REPRISE — workspace o1, run L',
    'O released you',
    'Dirty tree: YES',
    'Snapshot ref: refs/orchestra/pause/L/o1/1',
    'Commands killed by the Pause (1) — LISTED, NOT re-run',
    '  - sleep 600 && make rig   (cwd /w/o1)',
    'Branch: br-o1 @ heado100000000',
    'a turn was running',
    'orchestra run confirm reprise',
  ]) assert.ok(row.body.includes(needle), `missing: ${needle}\n${row.body}`);
  releaseMembers(db, 'L', 'O', ['o2']);
  const o2 = reprRows(db).at(-1)!;
  assert.ok(o2.body.includes('Dirty tree: no — nothing uncommitted'), o2.body);
  // M2: o2 was mid FOREGROUND `npm test` — the interrupt aborted it (the host trap killed nothing): the Consigne names it, never "Commands killed by the Pause: none."
  assert.ok(o2.body.includes('  - Bash: npm test -- --watch'), o2.body);
  assert.ok(o2.body.includes('Commands killed by the host trap: none — the in-flight call(s) above were aborted by the interrupt itself.'), o2.body);
  assert.equal(o2.body.includes('Commands killed by the Pause: none.'), false, o2.body);
  assert.ok(o2.body.includes('o2 note'), 'the Bilan notes travel');
  assert.equal(o2.body.includes('sleep 600'), false, "o2's Consigne never lists o1's killed command");
  db.close();
});

test('RELEASE --all = the members of the caller\'s OWN run (review M1): the LEAD\'s --all does NOT dispatch every OPS\'s workers — those are `below` (their OPS releases them, or the LEAD by explicit id); the last release makes the run ACTIVE (every pause column NULL)', () => {
  const { db } = freshDb();
  tree(db);
  const pausedAt = pauseAndTrap(db);
  beginReprise(db, 'L', 'L');
  // THE recommended path of the host's own message: the LEAD runs `release --all` — it must release only the LEAD's own run, never the OPS waves
  const l = releaseMembers(db, 'L', 'L', 'all');
  assert.deepEqual(l.released, ['l1'], "only the members of the LEAD's OWN run");
  assert.deepEqual(l.below.sort(), ['o1', 'o2', 's1', 'x1'], "the OPS waves are below the LEAD: left to their OPS (or an explicit id)");
  assert.equal(l.finished, false);
  for (const w of ['o1', 'o2', 's1', 'x1']) assert.equal(pauseRefusalWith({ getWorkspace, getBus: () => db }, byId.get(w), 'auto')?.startsWith('run en pause'), true, `${w} stays BLOCKED after the LEAD's --all (AC1: workers wait for THEIR OPS)`);
  const o = releaseMembers(db, 'L', 'O', 'all');
  assert.deepEqual(o.released.sort(), ['o1', 'o2'], "O's own run: its workers");
  assert.deepEqual(o.below, ['s1'], "the worker of O's CHILD run S is S's");
  assert.deepEqual(o.refused.map((r) => r.wsId).sort(), ['x1'], "X's worker belongs to a sibling OPS: refused");
  assert.equal(o.finished, false);
  assert.equal(readCarrierColumns(db, 'L')!.resumeStartedAt !== null, true, 'still RESUMING');
  const byId1 = releaseMembers(db, 'L', 'L', ['x1', 's1']); // the LEAD may release a worker below it — by EXPLICIT id
  assert.deepEqual(byId1.released.sort(), ['s1', 'x1']);
  assert.equal(byId1.finished, true);
  const cols = readCarrierColumns(db, 'L')!;
  assert.deepEqual([cols.pausedAt, cols.mode, cols.trapAt, cols.resumeStartedAt, cols.deadlineAt, cols.escalatedAt], [null, null, null, null, null, null]);
  assert.equal(pausePhaseOf(cols), 'active');
  assert.equal(activePauseFor(db, 'L'), null);
  assert.equal((db.prepare('SELECT pause_auto AS a FROM runs WHERE id = ?').get('L') as { a: string | null }).a, null);
  for (const w of NODES) assert.equal(pauseRefusalWith({ getWorkspace, getBus: () => db }, w, 'auto'), null, `${w.id} runs again`);
  assert.equal(readRoster(db, 'L', pausedAt).length, 9, 'the roster is kept as history');
  db.close();
});

test('RELEASE errors: not resuming / not paused / no run / unknown target / a unique prefix resolves, an ambiguous one does not', () => {
  const { db } = freshDb();
  tree(db);
  assert.equal(releaseMembers(db, 'L', 'L', 'all').error, 'not-paused');
  assert.equal(releaseMembers(db, 'zz', 'L', 'all').error, 'no-run');
  pauseAndTrap(db);
  assert.equal(releaseMembers(db, 'L', 'L', 'all').error, 'not-resuming', 'a paused (not yet resuming) run releases nobody');
  beginReprise(db, 'L', 'L');
  assert.deepEqual(releaseMembers(db, 'L', 'O', ['ghost']).unknown, ['ghost']);
  db.exec("INSERT INTO pause_members (run_id, paused_at, ws_id, role, member_run) SELECT 'L', paused_at, 'worker-aaaa1', 'worker', 'O' FROM runs WHERE id = 'L'");
  db.exec("INSERT INTO pause_members (run_id, paused_at, ws_id, role, member_run) SELECT 'L', paused_at, 'worker-aaaa2', 'worker', 'O' FROM runs WHERE id = 'L'");
  assert.deepEqual(releaseMembers(db, 'L', 'O', ['worker-aaaa']).unknown, ['worker-aaaa'], 'ambiguous prefix refused');
  assert.deepEqual(releaseMembers(db, 'L', 'O', ['worker-aaaa1']).released, ['worker-aaaa1']);
  assert.deepEqual(releaseMembers(db, 'L', 'O', ['o1']).released, ['o1']);
  assert.deepEqual(releaseMembers(db, 'L', 'O', ['o2']).released, ['o2'], 'exact id');
  db.close();
});

// ── reprise accusé + bus-status ─────────────────────────────────────────────

test('CONFIRM: refused before release, recorded after, idempotent, and still works AFTER the run went active', () => {
  const { db } = freshDb();
  tree(db);
  const pausedAt = pauseAndTrap(db);
  beginReprise(db, 'L', 'L');
  assert.deepEqual(confirmReprise(db, 'o1').notReleased, [{ runId: 'L', pausedAt }]);
  assert.equal(confirmReprise(db, 'o1').confirmed.length, 0);
  assert.deepEqual(confirmReprise(db, 'O').confirmed, [{ runId: 'L', pausedAt }], 'a host-released coordinator confirms too');
  releaseMembers(db, 'L', 'O', ['o1']);
  assert.equal(confirmReprise(db, 'o1').confirmed.length, 1);
  assert.equal(confirmReprise(db, 'o1').already.length, 1, 'idempotent');
  releaseAll(db);
  assert.equal(readCarrierColumns(db, 'L')!.pausedAt, null, 'precondition: ACTIVE');
  assert.equal(confirmReprise(db, 'o2').confirmed.length, 1, 'the last worker confirms after the run is active');
  assert.deepEqual(confirmReprise(db, 'stranger'), { confirmed: [], notReleased: [], already: [] });
  db.close();
});

test('BUS-STATUS view: "N/M repris — manquent" while RESUMING (released/blocked named), then active tracking until every accusé is in, then null', () => {
  const { db } = freshDb();
  tree(db);
  pauseAndTrap(db);
  assert.equal(repriseStatusView(db, 'L'), null, 'paused (not resuming): nothing to report');
  beginReprise(db, 'L', 'L');
  let v = repriseStatusView(db, 'L')!;
  assert.deepEqual([v.phase, v.total, v.released, v.done], ['resuming', 9, 4, 0]);
  assert.deepEqual(v.blocked.sort(), ['l1', 'o1', 'o2', 's1', 'x1']);
  assert.equal(repriseStatusView(db, 'O')!.carrier, 'L', 'a DESCENDANT run reads its carrier\'s Reprise');
  for (const ws of ['L', 'O', 'S', 'X']) confirmReprise(db, ws);
  releaseAll(db);
  v = repriseStatusView(db, 'L')!;
  assert.deepEqual([v.phase, v.total, v.released, v.done, v.blocked], ['active', 9, 9, 4, []], 'active again, accusés still being collected');
  assert.deepEqual(v.missing.sort(), ['l1', 'o1', 'o2', 's1', 'x1']);
  for (const ws of ['o1', 'o2', 's1', 'x1', 'l1']) confirmReprise(db, ws);
  assert.equal(repriseStatusView(db, 'L'), null, 'everyone accused: nothing to chase');
  db.close();
});

// ── a Pause while RESUMING ──────────────────────────────────────────────────

test('PAUSE while RESUMING = back to PAUSED in a NEW epoch owned by the re-pauser: the host trap is owed on a fresh epoch (no stale Bilan), nothing stays released, a stale pause_auto is cleared', () => {
  const { db } = freshDb();
  tree(db);
  const pausedAt = pauseAndTrap(db);
  beginReprise(db, 'L', 'L');
  releaseMembers(db, 'L', 'O', ['o1']);
  db.prepare('UPDATE runs SET pause_auto = ? WHERE id = ?').run('{"reason":"usage_limit","wsIds":["o1"],"accountIds":[null]}', 'L'); // an AUTO pause being resumed
  const oldRoster = readRoster(db, 'L', pausedAt);
  const end = Date.now() + 3;
  while (Date.now() < end); // a visibly later epoch
  assert.equal(setRunPause(db, 'L', true, 'L'), 'paused');
  const cols = readCarrierColumns(db, 'L')!;
  assert.ok(cols.pausedAt! > pausedAt, `a NEW epoch (${cols.pausedAt} > ${pausedAt}): the old epoch's Bilan reads "fully trapped" and would make the re-owed trap a no-op`);
  assert.equal(cols.pausedBy, 'L', 'owned by the re-pauser');
  assert.equal(cols.resumeStartedAt, null);
  assert.equal(cols.trapAt, null, 'the trap is owed again');
  assert.equal((db.prepare('SELECT pause_auto AS a FROM runs WHERE id = ?').get('L') as { a: string | null }).a, null, 'a human Pause is never an auto pause (D6)');
  assert.equal(pausePhaseOf(cols), 'paused');
  assert.deepEqual(runsOwingPauseTrap(db).map((r) => r.runId), ['L']);
  assert.equal(readRoster(db, 'L', cols.pausedAt!).length, 0, 'the new epoch starts with an empty roster: nobody stays released');
  assert.deepEqual(readRoster(db, 'L', pausedAt), oldRoster, 'the old epoch is kept as history, untouched');
  assert.equal(pauseRefusalWith({ getWorkspace, getBus: () => db }, byId.get('o1'), 'auto')?.startsWith('run en pause'), true, 'o1 (released in the old epoch) is blocked again');
  assert.equal(pauseRefusalWith({ getWorkspace, getBus: () => db }, byId.get('O'), 'auto')?.startsWith('run en pause'), true, 'and so is the OPS');
  assert.equal(setRunPause(db, 'L', true, 'L'), 'already-paused', 'a second pause on a plainly paused run is still a no-op');
  assert.equal(beginReprise(db, 'L', 'L'), 'resuming', 'and the Reprise can start again');
  db.close();
});

test('GATE: the dangling-chain fallback applies the release exemption along the WHOLE chain — a member released by the nearest carrier is still paused by an ancestor whose workspace left the store', () => {
  const { db } = freshDb();
  tree(db);
  pauseAndTrap(db); // L paused
  assert.equal(setRunPause(db, 'O', true, 'O'), 'paused');
  const pausedO = getRunPause(db, 'O')!.pausedAt;
  for (const ws of ['o1', 'o2']) insertBilan(db, { runId: 'O', wsId: ws, pausedAt: pausedO, activity: { surface: 'sdk', memberRun: 'O' }, snapshotRef: null, dirty: false, killed: { killed: [] }, error: null });
  beginReprise(db, 'O', 'O');
  assert.deepEqual(releaseMembers(db, 'O', 'O', ['o1']).released, ['o1']);
  // L's workspace is gone from the store: the walk dangles at O and falls back to the bus run tree
  const dangling = (id: string): WaveNode | undefined => (id === 'L' ? undefined : byId.get(id));
  const carrier = pausedCarrierForWorkspace(db, byId.get('o1')!, dangling);
  assert.equal(carrier?.runId, 'L', 'o1 was released by O, but L (still paused, workspace gone) pauses it');
  assert.equal(pauseRefusalWith({ getWorkspace: dangling, getBus: () => db }, byId.get('o1'), 'auto'), 'run en pause — orchestra run resume --run L');
  assert.equal(pausedCarrierForWorkspace(db, byId.get('o2')!, dangling)?.runId, 'O', 'the unreleased one is held by O itself (nearest carrier)');
  db.close();
});

test('the raw lift (`setRunPause(false)`) clears EVERY pause column — a stale resume_started_at must not make the NEXT pause read as resuming', () => {
  const { db } = freshDb();
  tree(db);
  pauseAndTrap(db);
  beginReprise(db, 'L', 'L');
  assert.equal(setRunPause(db, 'L', false, 'L'), 'lifted');
  assert.equal(readCarrierColumns(db, 'L')!.resumeStartedAt, null);
  assert.equal(setRunPause(db, 'L', true, 'L'), 'paused');
  assert.equal(pausePhaseOf(readCarrierColumns(db, 'L')!), 'paused');
  db.close();
});

// ── switch OFF ⇒ identical to today ─────────────────────────────────────────

test('SWITCH OFF: pause refused, no resume possible, no roster / reprise row ever written, a stale pause column is lifted PLAIN by the host', () => {
  const { db } = freshDb();
  tree(db, OFF);
  assert.equal(setRunPause(db, 'L', true, 'L'), 'switch-off');
  assert.equal(beginReprise(db, 'L', 'L'), 'not-paused');
  assert.equal(repriseStatusView(db, 'L'), null);
  // a stale column on a re-frozen run (the only way a switch-OFF run has paused_at):
  db.prepare("UPDATE runs SET paused_at = 5, paused_by = 'L', pause_mode = 'hard' WHERE id = 'L'").run();
  assert.equal(beginReprise(db, 'L', 'L'), 'resuming');
  assert.equal(readCarrierColumns(db, 'L')!.pausedAt, null, 'lifted plain, as before wave E');
  assert.equal((db.prepare('SELECT COUNT(*) AS c FROM pause_members').get() as { c: number }).c, 0);
  assert.equal(reprRows(db).length, 0);
  assert.equal(pauseRefusalWith({ getWorkspace, getBus: () => db }, byId.get('o1'), 'auto'), null);
  db.close();
});

// ── the host sweep ──────────────────────────────────────────────────────────

test('SWEEP: a live member the Bilan never saw is added BLOCKED (never leaked); the run closes only when the roster is fully released', () => {
  const { db } = freshDb();
  tree(db);
  const pausedAt = pauseAndTrap(db);
  const extra = { wsId: 'late1', runId: 'O' };
  const deps = { getBus: () => db, members: () => [...NODES.filter((w) => w.parentId).map((w) => ({ wsId: w.id, runId: w.parentId! })), extra], subtree: runSubtreeIds };
  assert.deepEqual(sweepReprise(deps), [], 'not resuming: the sweep does nothing');
  assert.equal(readRoster(db, 'L', pausedAt).length, 0, 'and writes no roster');
  beginReprise(db, 'L', 'L');
  assert.deepEqual(sweepReprise(deps), []);
  const late = readRoster(db, 'L', pausedAt).find((r) => r.wsId === 'late1')!;
  assert.deepEqual([late.role, late.memberRun, late.releasedAt], ['worker', 'O', null]);
  assert.equal(pauseRefusalWith({ getWorkspace: (id) => (id === 'late1' ? { id: 'late1', parentId: 'O' } : byId.get(id)), getBus: () => db }, { id: 'late1', parentId: 'O' }, 'auto')?.startsWith('run en pause'), true, 'blocked until its OPS releases it');
  releaseAll(db);
  assert.equal(readCarrierColumns(db, 'L')!.pausedAt, null, 'the last release closed the Reprise (late1 was in the roster by then)');
  db.close();
});

test('SWEEP closes a Reprise whose roster is already fully released (coordinators only), and an unloaded store never completes a roster', () => {
  const { db } = freshDb();
  busRuns.startRun(db, { id: 'L', kind: 'mission', coordinator: 'L' }, ON);
  setRunPause(db, 'L', true, 'L');
  beginReprise(db, 'L', 'L');
  assert.notEqual(readCarrierColumns(db, 'L')!.pausedAt, null, 'beginReprise itself never closes: the host sweep first completes the roster');
  const members = () => [{ wsId: 'w9', runId: 'L' }];
  assert.deepEqual(sweepReprise({ getBus: () => db, members, subtree: runSubtreeIds, storeReady: () => false }), ['L'], 'store not ready: the roster is NOT completed, the closed-over-nothing roster closes');
  db.close();
  const b = freshDb();
  busRuns.startRun(b.db, { id: 'L', kind: 'mission', coordinator: 'L' }, ON);
  setRunPause(b.db, 'L', true, 'L');
  beginReprise(b.db, 'L', 'L');
  assert.deepEqual(sweepReprise({ getBus: () => b.db, members, subtree: runSubtreeIds }), [], 'store ready: w9 joins the roster blocked — NOT closed');
  assert.equal(readRoster(b.db, 'L', readCarrierColumns(b.db, 'L')!.pausedAt!).some((r) => r.wsId === 'w9' && r.releasedAt === null), true);
  assert.equal(finishRepriseIfDone(b.db, 'L'), false);
  b.db.close();
});

// ── durability: the app is DOWN / restarts ──────────────────────────────────

test('DURABLE: the Reprise is on the bus — a second connection (an app restart) sees RESUMING, the gate honours it, and the rest of the flow completes on the new connection', () => {
  const { db, file } = freshDb();
  tree(db);
  pauseAndTrap(db);
  beginReprise(db, 'L', 'L'); // the CLI, app down
  db.close();
  const again = bus.openBus(file); // the app restarts
  assert.equal(pausePhaseOf(readCarrierColumns(again, 'L')!), 'resuming');
  assert.equal(resumingCarrierFor(again, 'O'), 'L');
  assert.equal(pauseRefusalWith({ getWorkspace, getBus: () => again }, byId.get('O'), 'auto'), null);
  assert.equal(pauseRefusalWith({ getWorkspace, getBus: () => again }, byId.get('o1'), 'auto')?.startsWith('run en pause'), true);
  assert.deepEqual(releaseMembers(again, 'L', 'O', 'all').released.sort(), ['o1', 'o2'], "O's own run (s1 is S's)");
  assert.deepEqual(releaseMembers(again, 'L', 'S', 'all').released, ['s1']);
  assert.equal(resumingCarrierFor(again, 'zz'), null);
  again.close();
});

// ── pins for the guards that look redundant (each is the ONLY thing that fails when its clause goes) ─────────────────────────────────────────────

test('releasedWhileResuming is false unless the carrier is RESUMING AND the member is released (a stale released row of an erased pause, or an unreleased one, never opens the gate)', () => {
  const { db } = freshDb();
  tree(db);
  const pausedAt = pauseAndTrap(db);
  beginReprise(db, 'L', 'L');
  assert.equal(releasedWhileResuming(db, 'L', pausedAt, 'O'), true, 'released coordinator');
  assert.equal(releasedWhileResuming(db, 'L', pausedAt, 'o1'), false, 'unreleased worker');
  assert.equal(releasedWhileResuming(db, 'L', pausedAt, 'nobody'), false, 'no roster row');
  assert.equal(releasedWhileResuming(db, 'L', pausedAt + 1, 'O'), false, 'another epoch');
  db.prepare('UPDATE runs SET resume_started_at = NULL WHERE id = ?').run('L'); // a re-pause that left a released row behind (the revert erases it; this is the DB-level guard)
  assert.equal(releasedWhileResuming(db, 'L', pausedAt, 'O'), false, 'not resuming ⇒ the released row means nothing');
  db.close();
});

test('CONFIRM keys on the NEWEST epoch of each carrier: a second Pause\'s accusé never lands on the first one\'s row', () => {
  const { db } = freshDb();
  tree(db);
  const p1 = pauseAndTrap(db);
  beginReprise(db, 'L', 'L');
  releaseAll(db);
  assert.equal(readCarrierColumns(db, 'L')!.pausedAt, null, 'first Reprise done (no accusé from o1 yet)');
  const end = Date.now() + 5;
  while (Date.now() < end); // a distinct paused_at ms
  const p2 = pauseAndTrap(db);
  assert.notEqual(p1, p2);
  beginReprise(db, 'L', 'L');
  releaseAll(db);
  assert.deepEqual(confirmReprise(db, 'o1').confirmed, [{ runId: 'L', pausedAt: p2 }]);
  assert.equal(readRoster(db, 'L', p1).find((r) => r.wsId === 'o1')!.repriseConfirmedAt, null, 'the older epoch is untouched');
  db.close();
});

test('SWEEP never seeds a roster row into an epoch that closed between its member read and its write (re-read inside the lock)', () => {
  const { db } = freshDb();
  tree(db);
  const pausedAt = pauseAndTrap(db);
  beginReprise(db, 'L', 'L');
  const deps = {
    getBus: () => db,
    // the LAST release lands while the sweep is between "read the live members" and "write the roster"
    members: () => {
      releaseAll(db);
      return [{ wsId: 'straggler', runId: 'O' }];
    },
    subtree: runSubtreeIds,
  };
  sweepReprise(deps);
  assert.equal(readCarrierColumns(db, 'L')!.pausedAt, null, 'precondition: the epoch closed mid-sweep');
  assert.equal(readRoster(db, 'L', pausedAt).some((r) => r.wsId === 'straggler'), false, 'no row written into the finished epoch');
  db.close();
});

test('RELEASE closes the Reprise only when the host trap FINISHED; otherwise the host sweep seeds the live members first and closes it (a member not listed yet is never un-gated by someone else\'s last release)', () => {
  const { db } = freshDb();
  tree(db);
  const pausedAt = pauseAndTrap(db);
  db.prepare('UPDATE runs SET pause_trap_at = NULL WHERE id = ?').run('L'); // the trap had NOT finished when the Reprise began
  beginReprise(db, 'L', 'L');
  const fins = ['L', 'O', 'X', 'S'].map((c) => releaseMembers(db, 'L', c, 'all').finished);
  assert.deepEqual(fins, [false, false, false, false], 'every roster member is released, yet the run is NOT closed from the CLI');
  assert.equal(readRoster(db, 'L', pausedAt).every((r) => r.releasedAt !== null), true, 'precondition: fully released');
  assert.notEqual(readCarrierColumns(db, 'L')!.pausedAt, null, 'still RESUMING');
  // the host sweep: a live member the Bilan never saw joins BLOCKED → the run stays open until it is released too
  const deps = { getBus: () => db, members: () => [...NODES.filter((w) => w.parentId).map((w) => ({ wsId: w.id, runId: w.parentId! })), { wsId: 'late1', runId: 'O' }], subtree: runSubtreeIds };
  assert.deepEqual(sweepReprise(deps), []);
  assert.equal(pauseRefusalWith({ getWorkspace: (id) => (id === 'late1' ? { id: 'late1', parentId: 'O' } : byId.get(id)), getBus: () => db }, { id: 'late1', parentId: 'O' }, 'auto')?.startsWith('run en pause'), true, 'late1 is blocked');
  assert.equal(releaseMembers(db, 'L', 'O', ['late1']).released[0], 'late1');
  assert.notEqual(readCarrierColumns(db, 'L')!.pausedAt, null, 'trap not finished: even the last release does not close it from the CLI…');
  assert.deepEqual(sweepReprise(deps), ['L'], '…the HOST sweep does');
  assert.equal(readCarrierColumns(db, 'L')!.pausedAt, null);
  db.close();
});

test('releasedWhileResuming asks about the CURRENT epoch only: a released row of an OLDER epoch never opens the gate of a newer resuming one', () => {
  const { db } = freshDb();
  tree(db);
  const p1 = pauseAndTrap(db);
  beginReprise(db, 'L', 'L');
  releaseAll(db); // epoch 1 fully released → active
  const end = Date.now() + 3;
  while (Date.now() < end);
  const p2 = pauseAndTrap(db); // epoch 2
  beginReprise(db, 'L', 'L');  // resuming; o1 NOT released in epoch 2
  assert.notEqual(p1, p2);
  assert.equal(releasedWhileResuming(db, 'L', p1, 'o1'), false, 'o1 is released in epoch 1 only');
  assert.equal(releasedWhileResuming(db, 'L', p2, 'o1'), false);
  assert.equal(releasedWhileResuming(db, 'L', p2, 'O'), true);
  db.close();
});

test('BUS-STATUS: a forgotten accusé stops nagging a day after the last release (REPRISE_TRACKING_TTL_MS) — tracking only', () => {
  const { db } = freshDb();
  tree(db);
  const pausedAt = pauseAndTrap(db);
  beginReprise(db, 'L', 'L');
  releaseAll(db);
  assert.notEqual(repriseStatusView(db, 'L'), null, 'fresh: the missing accusés are named');
  db.prepare('UPDATE pause_members SET released_at = released_at - ? WHERE run_id = ? AND paused_at = ?').run(REPRISE_TRACKING_TTL_MS + 60_000, 'L', pausedAt);
  assert.equal(repriseStatusView(db, 'L'), null, 'older than the TTL: no line');
  db.close();
});

test('ROSTER: a Bilan row with NO memberRun (the observer/note path creates them) leaves member_run NULL — never a wrong default — and the host sweep fills it from the live tree; until then the carrier\'s rule and wave read NULL as the carrier run', () => {
  const { db } = freshDb();
  tree(db);
  assert.equal(setRunPause(db, 'L', true, 'L'), 'paused');
  const pausedAt = getRunPause(db, 'L')!.pausedAt;
  insertBilan(db, { runId: 'L', wsId: 'o1', pausedAt, activity: { surface: 'none', notes: ['created by appendBilanNote — no memberRun'] }, snapshotRef: null, dirty: null, killed: null, error: null });
  db.prepare('UPDATE runs SET pause_trap_at = ? WHERE id = ?').run(pausedAt + 1, 'L');
  beginReprise(db, 'L', 'L');
  assert.equal(readRoster(db, 'L', pausedAt).find((r) => r.wsId === 'o1')!.memberRun, null, 'unknown stays unknown');
  const leadRow = reprRows(db).find((r) => r.recipient === 'L')!.body;
  assert.ok(leadRow.includes('• o1 '), `a member with an UNKNOWN run belongs to the CARRIER coordinator's wave (nobody else would be told about it):\n${leadRow}`);
  assert.equal(reprRows(db).find((r) => r.recipient === 'O')!.body.includes('• o1 '), false, "…and not to an inner OPS's");
  assert.deepEqual(releaseMembers(db, 'L', 'O', ['o1']).refused.map((r) => r.wsId), ['o1'], 'with no run known the CARRIER\'s coordinator releases it, not an inner OPS');
  sweepReprise({ getBus: () => db, members: () => [{ wsId: 'o1', runId: 'O' }], subtree: runSubtreeIds });
  assert.equal(readRoster(db, 'L', pausedAt).find((r) => r.wsId === 'o1')!.memberRun, 'O', 'the live tree fills it');
  assert.deepEqual(releaseMembers(db, 'L', 'O', ['o1']).released, ['o1'], 'now its OPS may release it');
  db.close();
});

test('runsOwingPauseTrap reads the REAL soft-pause columns (trapOwed): a soft carrier is owed only once escalated; hard at once; never while resuming', () => {
  const { db } = freshDb();
  tree(db);
  const set = (sql: string) => db.prepare(`UPDATE runs SET ${sql} WHERE id = 'L'`).run();
  set("paused_at = 100, paused_by = 'L', pause_mode = 'soft', pause_deadline_at = 180100");
  assert.deepEqual(runsOwingPauseTrap(db), [], 'soft, still waiting: the trap is not owed yet');
  set('pause_escalated_at = 150');
  assert.deepEqual(runsOwingPauseTrap(db).map((r) => r.runId), ['L'], 'soft + escalated: owed');
  set("pause_mode = 'hard', pause_escalated_at = NULL, pause_deadline_at = NULL");
  assert.deepEqual(runsOwingPauseTrap(db).map((r) => r.runId), ['L'], 'hard: at once');
  set('resume_started_at = 200');
  assert.deepEqual(runsOwingPauseTrap(db), [], 'never while resuming');
  db.close();
});

test('CARRY-FORWARD: a re-Pause during RESUMING must not hide what the FIRST Pause killed — a member never released in epoch 1 is told about epoch 1 (killed commands + ref); one that WAS released then is not told twice', () => {
  const { db } = freshDb();
  tree(db);
  const p1 = pauseAndTrap(db); // o1: killed 'sleep 600 && make rig'
  beginReprise(db, 'L', 'L');
  releaseMembers(db, 'L', 'O', ['o2']); // o2 is released (and told) in epoch 1; o1 is NOT
  const end = Date.now() + 3;
  while (Date.now() < end);
  const p2 = pauseAndTrap(db, false); // epoch 2 (re-Pause): the trap killed NOTHING this time
  assert.ok(p2 > p1);
  beginReprise(db, 'L', 'L');
  const before = reprRows(db).length;
  releaseMembers(db, 'L', 'O', ['o1']);
  const o1 = reprRows(db)[before].body;
  for (const needle of ['Commands killed by the Pause (1)', '  - sleep 600 && make rig   (cwd /w/o1)', 'an EARLIER Pause of this run', 'you were never released from it', 'refs/orchestra/pause/L/o1/1', 'merged into the list of killed commands']) assert.ok(o1.includes(needle), `o1 missing: ${needle}\n${o1}`);
  releaseMembers(db, 'L', 'O', ['o2']);
  const o2 = reprRows(db).at(-1)!.body;
  assert.equal(o2.includes('EARLIER Pause'), false, 'o2 was released (and told) in epoch 1: nothing to carry forward');
  assert.ok(o2.includes('Commands killed by the host trap: none'), o2); // (o2 was mid-command: its in-flight call is what the interrupt aborted)
  db.close();
});

const RQ = (pid: number, cmd: string) => ({ pid, startTicks: 1000 + pid, comm: 'chrome', cmd, cwd: '/w/o1', startedAt: Date.UTC(2026, 9, 8, 12, 51, 0), scope: 'orchestra-ws-o1-abc.scope', evidence: 'e', signal: 'SIGTERM', outcome: 'exited' });
/** #325: epoch `pausedAt`'s trap also killed these Reliquats for `ws` (written on the Bilan row's activity exactly as the trap does). */
function withReliquats(db: bus.BusDb, ws: string, pausedAt: number, killed: ReturnType<typeof RQ>[]): void {
  const row = db.prepare("SELECT id, activity FROM pause_records WHERE run_id = 'L' AND ws_id = ? AND paused_at = ?").get(ws, pausedAt) as { id: number; activity: string };
  const a = JSON.parse(row.activity);
  a.reliquats = { scopes: ['orchestra-ws-o1-abc.scope'], killed, refused: [], spared: [], survivors: [], rounds: 1 };
  db.prepare('UPDATE pause_records SET activity = ? WHERE id = ?').run(JSON.stringify(a), row.id);
}

test('#325 the Consigne de reprise SHOWS the Reliquats the Pause killed (command, pid, start time; listed, never re-run) — and a re-Pause carries the FIRST epoch\'s Reliquats to a member never released from it', () => {
  const { db } = freshDb();
  tree(db);
  const p1 = pauseAndTrap(db);
  withReliquats(db, 'o1', p1, [RQ(500, '/usr/bin/chrome --headless --n=500'), RQ(501, '/usr/bin/chrome --headless --n=501')]);
  beginReprise(db, 'L', 'L');
  releaseMembers(db, 'L', 'O', ['o2']); // o2 (no Reliquat) is released and told in epoch 1; o1 is NOT
  const end = Date.now() + 3;
  while (Date.now() < end);
  const p2 = pauseAndTrap(db, false); // epoch 2 (re-Pause): killed nothing, no Reliquat this time
  assert.ok(p2 > p1);
  beginReprise(db, 'L', 'L');
  const before = reprRows(db).length;
  releaseMembers(db, 'L', 'O', ['o1']);
  const o1 = reprRows(db)[before].body;
  for (const needle of ['Leftover processes (Reliquats) the Pause killed in your scope (2)', '/usr/bin/chrome --headless --n=500', 'pid 500, started 2026-10-08T12:51:00.000Z', 'an EARLIER Pause (', 'also killed 2 leftover process(es) (Reliquats) in your scope', 'LISTED, NOT re-run']) assert.ok(o1.includes(needle), `o1 missing: ${needle}\n${o1}`);
  releaseMembers(db, 'L', 'O', ['o2']);
  assert.equal(reprRows(db).at(-1)!.body.includes('Reliquats'), false, 'a member with no Reliquat reads no Reliquat line');
  // and the plain case: the CURRENT epoch's Reliquats in a first Reprise
  const { db: db2 } = freshDb();
  tree(db2);
  const q1 = pauseAndTrap(db2);
  withReliquats(db2, 'o1', q1, [RQ(600, 'node /tmp/rig/server.js --port 4001')]);
  beginReprise(db2, 'L', 'L');
  const b2 = reprRows(db2).length;
  releaseMembers(db2, 'L', 'O', ['o1']);
  assert.match(reprRows(db2)[b2].body, /Reliquats\) the Pause killed in your scope \(1\)[\s\S]*node \/tmp\/rig\/server\.js --port 4001\s+\(pid 600, started /);
  db.close();
  db2.close();
});

test('CARRY-FORWARD keeps each epoch\'s INTERRUPT OUTCOME: a call epoch 1\'s interrupt ABORTED is still "ABORTED" after a re-Pause that found the member idle (never "no turn was interrupted")', () => {
  const { db } = freshDb();
  tree(db);
  const trapAll = (o1: { turnRunning: boolean; interrupt: string; inFlight: Array<{ tool: string; toolUseId: string; sinceMs: number; input: string }> }): number => {
    assert.equal(setRunPause(db, 'L', true, 'L'), 'paused');
    const at = getRunPause(db, 'L')!.pausedAt;
    const run: Record<string, string> = { L: 'L', O: 'O', S: 'S', X: 'X', o1: 'O', o2: 'O', s1: 'S', x1: 'X', l1: 'L' };
    for (const [ws, r] of Object.entries(run)) {
      insertBilan(db, { runId: 'L', wsId: ws, pausedAt: at, activity: { surface: 'sdk', memberRun: r, branch: `br-${ws}`, head: `h-${ws}`, ...(ws === 'o1' ? { turnRunning: o1.turnRunning, interrupt: o1.interrupt as 'interrupted', inFlightTools: o1.inFlight } : {}) }, snapshotRef: `refs/orchestra/pause/L/${ws}/${at}`, dirty: false, killed: { killed: [], survivors: [], refused: [], spared: [] }, error: null });
    }
    db.prepare('UPDATE runs SET pause_trap_at = ? WHERE id = ?').run(at + 5, 'L');
    return at;
  };
  trapAll({ turnRunning: true, interrupt: 'interrupted', inFlight: [{ tool: 'Bash', toolUseId: 'tu1', sinceMs: 100, input: 'npm test' }] }); // epoch 1: o1 was mid foreground call, the interrupt ABORTED it
  beginReprise(db, 'L', 'L'); // o1 is NOT released
  const end = Date.now() + 3;
  while (Date.now() < end);
  trapAll({ turnRunning: false, interrupt: 'idle', inFlight: [] }); // epoch 2 (re-Pause): o1 idle, nothing in flight, no turn to interrupt
  beginReprise(db, 'L', 'L');
  const before = reprRows(db).length;
  assert.deepEqual(releaseMembers(db, 'L', 'O', ['o1']).released, ['o1']);
  const body = reprRows(db)[before].body;
  assert.match(body, /Calls IN FLIGHT when an EARLIER Pause \(\S+\) interrupted your turn \(1\) — that interrupt ABORTED them/, body);
  assert.ok(body.includes('  - Bash: npm test'), body);
  assert.equal(body.includes('no turn was interrupted for you'), false, body);
  assert.ok(body.includes('Commands killed by the host trap: none — the in-flight call(s) above were aborted by the interrupt itself.'), body);
  db.close();
});

test('PAUSE while RESUMING by ANOTHER coordinator: the new epoch is owned by the RE-pauser (paused_by), not the original one', () => {
  const { db } = freshDb();
  tree(db);
  assert.equal(setRunPause(db, 'O', true, 'O'), 'paused'); // O pauses its own run
  assert.equal(getRunPause(db, 'O')!.pausedBy, 'O');
  assert.equal(beginReprise(db, 'O', 'O'), 'resuming');
  const end = Date.now() + 3;
  while (Date.now() < end);
  assert.equal(setRunPause(db, 'O', true, 'L'), 'paused'); // the LEAD (an ancestor run's coordinator) re-pauses it
  assert.equal(getRunPause(db, 'O')!.pausedBy, 'L', 'owned by the re-pauser');
  db.close();
});

test('a released COORDINATOR is told its OWN Bilan too (snapshot ref, the commands the Pause killed in ITS session) — the host releases it without a separate Consigne', () => {
  const { db } = freshDb();
  tree(db);
  pauseAndTrap(db);
  beginReprise(db, 'L', 'L');
  const o = reprRows(db).find((r) => r.recipient === 'O')!.body;
  for (const needle of ['YOUR OWN Bilan de pause', 'CONSIGNE DE REPRISE — workspace O, run L', 'Snapshot ref: refs/orchestra/pause/L/O/1', '  - node dev-server.js --port 4000   (cwd /w/O)', 'orchestra run confirm reprise']) assert.ok(o.includes(needle), `missing: ${needle}\n${o}`);
  const l = reprRows(db).find((r) => r.recipient === 'L')!.body;
  assert.ok(l.includes('CONSIGNE DE REPRISE — workspace L, run L'), 'the LEAD gets its own too');
  assert.equal(l.split('YOUR OWN Bilan de pause')[1].includes('node dev-server.js'), false, "…its own section never carries another member's commands (the wave lines name its direct reports' kills, above)");
  db.close();
});

test('CARRY-FORWARD only reads an epoch that HAD a Reprise roster and never released the member: an older pause lifted without a Reprise (no roster) is not "never released from"', () => {
  const { db } = freshDb();
  tree(db);
  const p1 = pauseAndTrap(db); // o1 killed 'sleep 600 && make rig' …
  assert.equal(setRunPause(db, 'L', false, 'L'), 'lifted'); // … and the pause is lifted PLAINLY: no roster, no Reprise (a pre-wave-E pause looks exactly like this)
  const end = Date.now() + 3;
  while (Date.now() < end);
  const p2 = pauseAndTrap(db, false);
  assert.ok(p2 > p1);
  beginReprise(db, 'L', 'L');
  const before = reprRows(db).length;
  releaseMembers(db, 'L', 'O', ['o1']);
  const o1 = reprRows(db)[before].body;
  assert.equal(o1.includes('EARLIER Pause'), false, o1);
  assert.equal(o1.includes('sleep 600 && make rig'), false, 'the old, lifted pause\'s kills do not leak into this Reprise');
  db.close();
});

test('revertResumeToPaused: never the old epoch key even if the clock stepped back; the soft (E1) and auto (E3) tracks pass their mode / deadline / epoch-bound pause_auto through the SAME statement', () => {
  const { db } = freshDb();
  tree(db);
  const p1 = pauseAndTrap(db);
  beginReprise(db, 'L', 'L');
  assert.equal(revertResumeToPaused(db, 'L', 'L', p1 - 5000), true);
  assert.equal(readCarrierColumns(db, 'L')!.pausedAt, p1 + 1, 'a clock that stepped back must not reuse the old (run_id, paused_at) roster key');
  assert.equal(beginReprise(db, 'L', 'L'), 'resuming'); // the re-paused run resumes again
  const e = readCarrierColumns(db, 'L')!.pausedAt!;
  assert.equal(revertResumeToPaused(db, 'L', 'auto-host', e + 10, { mode: 'soft', deadlineAt: (ep) => ep + 180_000, auto: (ep) => `{"epoch":${ep}}` }), true);
  const row = db.prepare('SELECT paused_at, paused_by, pause_mode, pause_deadline_at, pause_auto FROM runs WHERE id = ?').get('L') as Record<string, unknown>;
  assert.deepEqual([row.pause_mode, row.paused_by, Number(row.pause_deadline_at) - Number(row.paused_at), row.pause_auto], ['soft', 'auto-host', 180_000, `{"epoch":${row.paused_at}}`]);
  assert.equal(revertResumeToPaused(db, 'L', 'x'), false, 'not resuming any more: nothing to revert');
  db.close();
});

// ── review M3: coordinators / member runs / release authority come from the LIVE tree ─────────────────────────────────────────────────────────────

function withLiveTree<T>(nodes: WaveNode[], fn: () => T): T {
  const m = new Map(nodes.map((w) => [w.id, w]));
  setLiveTreeSource(() => ({ get: (id) => m.get(id), ids: () => nodes.map((w) => w.id) }));
  try {
    return fn();
  } finally {
    setLiveTreeSource(null);
  }
}
const insertBilanRow = (db: bus.BusDb, carrier: string, ws: string, pausedAt: number, memberRun: string | null, extra: { killed?: unknown } = {}) =>
  insertBilan(db, { runId: carrier, wsId: ws, pausedAt, activity: { surface: 'sdk', ...(memberRun ? { memberRun } : {}), branch: `br-${ws}`, head: `h-${ws}` }, snapshotRef: `refs/orchestra/pause/${carrier}/${ws}/1`, dirty: false, killed: extra.killed ?? { killed: [] }, error: null });

test('M3 RE-PARENTED OPS: O\'s run was created top-level (parent_run_id NULL) and the store later put O under L — the LIVE tree makes O a host-released COORDINATOR, o1 its worker, and the LEAD may release o1 (the bus tree would say neither)', () => {
  const { db } = freshDb();
  busRuns.startRun(db, { id: 'L', kind: 'mission', coordinator: 'L' }, ON);
  busRuns.startRun(db, { id: 'O', kind: 'vague', coordinator: 'O' }, ON); // write-once: NO parent_run_id, forever
  assert.equal(setRunPause(db, 'L', true, 'L'), 'paused');
  const pausedAt = getRunPause(db, 'L')!.pausedAt;
  // the Bilan was written when the trap thought o1/o2 belonged to run L (stale `memberRun`): the LIVE tree says their run is O — live wins
  for (const [ws, run] of [['L', 'L'], ['O', 'O'], ['o1', 'L'], ['o2', 'L']] as const) insertBilanRow(db, 'L', ws, pausedAt, run);
  db.prepare('UPDATE runs SET pause_trap_at = ? WHERE id = ?').run(pausedAt + 1, 'L');
  const nodes: WaveNode[] = [{ id: 'L', kind: 'orchestrator' }, { id: 'O', kind: 'orchestrator', parentId: 'L' }, { id: 'o1', parentId: 'O' }, { id: 'o2', parentId: 'O' }];
  withLiveTree(nodes, () => {
    assert.equal(beginReprise(db, 'L', 'L'), 'resuming');
    const roster = new Map(readRoster(db, 'L', pausedAt).map((r) => [r.wsId, r]));
    assert.deepEqual([roster.get('O')!.role, roster.get('O')!.memberRun, roster.get('O')!.releasedBy], ['coordinator', 'O', 'host'], 'O is a COORDINATOR (live tree), released by the host — not a blocked "worker" nobody can release');
    assert.deepEqual([roster.get('o1')!.role, roster.get('o1')!.memberRun], ['worker', 'O']);
    assert.equal(reprRows(db).find((r) => r.recipient === 'O')?.run_id, 'O', 'its reprise row goes in its own run');
    // no live tree (a store-less caller with no store.json): the bus tree alone does not know O is under L — the CARRIER's own authority still lets its coordinator release (no topology leaves a member nobody can release)
    setLiveTreeSource(null);
    assert.deepEqual(releaseMembers(db, 'L', 'L', ['o2']).released, ['o2'], 'bus tree only: the LEAD coordinates the carrier');
    assert.deepEqual(releaseMembers(db, 'L', 'stranger', ['o1']).refused.map((r) => r.wsId), ['o1'], 'a stranger is refused either way');
    withLiveTree(nodes, () => {
      const o = releaseMembers(db, 'L', 'O', 'all');
      assert.deepEqual([o.released, o.refused], [['o1'], []], 'live tree: O (re-parented under L, no bus parent) releases its OWN worker with --all — the chain, not the bus, says O is above o1');
      assert.equal(reprRows(db).find((r) => r.recipient === 'o1')?.run_id, 'O', 'o1\'s Consigne rides its LIVE env run (O) — the Bilan recorded the stale run L at trap time');
    });
  });
  assert.equal(readCarrierColumns(db, 'L')!.pausedAt, null, 'and the Reprise CLOSES (it stayed RESUMING forever before)');
  db.close();
});

test('M3 DEMOTED ex-orchestrator: a `runs` row survives a demotion — the live tree says D is a plain worker, so the host does NOT release it as a coordinator (it waits for its OPS)', () => {
  const { db } = freshDb();
  tree(db);
  busRuns.startRun(db, { id: 'D', kind: 'vague', coordinator: 'D', parentRunId: 'O' }, ON); // D was an orchestrator once
  assert.equal(setRunPause(db, 'L', true, 'L'), 'paused');
  const pausedAt = getRunPause(db, 'L')!.pausedAt;
  for (const [ws, run] of [['L', 'L'], ['O', 'O'], ['D', 'O']] as const) insertBilanRow(db, 'L', ws, pausedAt, run);
  db.prepare('UPDATE runs SET pause_trap_at = ? WHERE id = ?').run(pausedAt + 1, 'L');
  const nodes: WaveNode[] = [{ id: 'L', kind: 'orchestrator' }, { id: 'O', kind: 'orchestrator', parentId: 'L' }, { id: 'D', kind: 'scratch', parentId: 'O' }];
  withLiveTree(nodes, () => {
    beginReprise(db, 'L', 'L');
    const d = readRoster(db, 'L', pausedAt).find((r) => r.wsId === 'D')!;
    assert.deepEqual([d.role, d.releasedAt, d.memberRun], ['worker', null, 'O'], 'a plain worker of O, still BLOCKED');
    assert.equal(reprRows(db).some((r) => r.recipient === 'D'), false, 'no host reprise row for a demoted ws');
    assert.equal(pauseRefusalWith({ getWorkspace: (id) => nodes.find((w) => w.id === id), getBus: () => db }, nodes[2], 'auto')?.startsWith('run en pause'), true);
  });
  db.close();
});

test('M3 RUN-LESS OPS: an orchestrator with NO `runs` row is a coordinator on the live tree — host-released, told in its own run, and its worker is released by it', () => {
  const { db } = freshDb();
  busRuns.startRun(db, { id: 'L', kind: 'mission', coordinator: 'L' }, ON); // R has no row at all
  assert.equal(setRunPause(db, 'L', true, 'L'), 'paused');
  const pausedAt = getRunPause(db, 'L')!.pausedAt;
  for (const [ws, run] of [['L', 'L'], ['R', 'R'], ['rw', 'R']] as const) insertBilanRow(db, 'L', ws, pausedAt, run);
  db.prepare('UPDATE runs SET pause_trap_at = ? WHERE id = ?').run(pausedAt + 1, 'L');
  const nodes: WaveNode[] = [{ id: 'L', kind: 'orchestrator' }, { id: 'R', kind: 'orchestrator', parentId: 'L' }, { id: 'rw', parentId: 'R' }];
  withLiveTree(nodes, () => {
    beginReprise(db, 'L', 'L');
    const row = reprRows(db).find((r) => r.recipient === 'R')!;
    assert.deepEqual([row.run_id, row.sender], ['R', 'host']);
    assert.ok(row.body.includes('• rw [br-rw]'), row.body);
    assert.deepEqual(releaseMembers(db, 'L', 'R', 'all').released, ['rw'], 'R is the orchestrator above rw, with no runs row');
  });
  assert.equal(readCarrierColumns(db, 'L')!.pausedAt, null);
  db.close();
});

// ── the 6 in-place mutants the review found alive ────────────────────────────────────────────────────────────────────────────────────────────────

test('MUTANT-b carrier fallback: a member whose run has NO row and is unknown to the live tree is released by the CARRIER\'s coordinator (the only thing that lets a run-less member be released), never by an inner OPS', () => {
  const { db } = freshDb();
  tree(db);
  assert.equal(setRunPause(db, 'L', true, 'L'), 'paused');
  const pausedAt = getRunPause(db, 'L')!.pausedAt;
  insertBilanRow(db, 'L', 'L', pausedAt, 'L');
  insertBilanRow(db, 'L', 'gw', pausedAt, 'ghost-run'); // a run that has no row on the bus, and gw is not in any tree
  db.prepare('UPDATE runs SET pause_trap_at = ? WHERE id = ?').run(pausedAt + 1, 'L');
  beginReprise(db, 'L', 'L');
  assert.deepEqual(releaseMembers(db, 'L', 'O', ['gw']).refused.map((r) => r.wsId), ['gw'], 'an inner OPS is not its releaser');
  assert.deepEqual(releaseMembers(db, 'L', 'L', ['gw']).released, ['gw'], "the carrier's coordinator is");
  db.close();
});

test('MUTANT-b origin row: the reserved `__pause_origin__` Bilan row (the pausing call\'s process chain) is never a roster member', () => {
  const { db } = freshDb();
  tree(db);
  const pausedAt = pauseAndTrap(db);
  recordPauseOrigin(db, 'L', pausedAt, [{ pid: 1, ppid: 0, startTicks: 1, comm: 'orchestra' }]);
  beginReprise(db, 'L', 'L');
  assert.equal(readRoster(db, 'L', pausedAt).some((r) => r.wsId === '__pause_origin__'), false);
  assert.equal(readRoster(db, 'L', pausedAt).length, 9);
  db.close();
});

test('MUTANT-b EARLIER_EPOCHS cap: at most 5 earlier Pauses are carried into a Consigne', () => {
  const { db } = freshDb();
  tree(db);
  for (let i = 0; i < 7; i++) {
    pauseAndTrap(db); // epoch i+1 (a re-Pause while resuming opens a new epoch each time)
    beginReprise(db, 'L', 'L');
    const end = Date.now() + 2;
    while (Date.now() < end);
  }
  const before = reprRows(db).length;
  releaseMembers(db, 'L', 'O', ['o1']);
  const body = reprRows(db)[before].body;
  assert.equal((body.match(/an EARLIER Pause of this run/g) ?? []).length, 5, body);
  db.close();
});

test('MUTANT-b ONE ws coordinating TWO bus runs (no live tree) is ONE coordinator row, told once, at its shallowest run', () => {
  const { db } = freshDb();
  busRuns.startRun(db, { id: 'L', kind: 'mission', coordinator: 'L' }, ON);
  busRuns.startRun(db, { id: 'O', kind: 'vague', coordinator: 'dual', parentRunId: 'L' }, ON);
  busRuns.startRun(db, { id: 'X', kind: 'vague', coordinator: 'dual', parentRunId: 'L' }, ON);
  assert.equal(setRunPause(db, 'L', true, 'L'), 'paused');
  const pausedAt = getRunPause(db, 'L')!.pausedAt;
  db.prepare('UPDATE runs SET pause_trap_at = ? WHERE id = ?').run(pausedAt + 1, 'L');
  beginReprise(db, 'L', 'L');
  assert.equal(readRoster(db, 'L', pausedAt).filter((r) => r.wsId === 'dual').length, 1);
  const rows = reprRows(db).filter((r) => r.recipient === 'dual');
  assert.deepEqual(rows.map((r) => r.run_id), ['O'], 'told once, in the SHALLOWEST run it coordinates (O before X in BFS)');
  db.close();
});

test('MUTANT-b confirmedVia: the Consigne says how the member\'s Pause was taken (its own pause accusé, the host while idle, the trap) — read from the roster row', () => {
  const { db } = freshDb();
  tree(db);
  const pausedAt = pauseAndTrap(db);
  beginReprise(db, 'L', 'L');
  db.prepare("UPDATE pause_members SET pause_confirm_via = 'member', pause_confirmed_at = 5 WHERE run_id = 'L' AND paused_at = ? AND ws_id = 'o1'").run(pausedAt);
  db.prepare("UPDATE pause_members SET pause_confirm_via = 'host-idle', pause_confirmed_at = 5 WHERE run_id = 'L' AND paused_at = ? AND ws_id = 'o2'").run(pausedAt);
  const before = reprRows(db).length;
  releaseMembers(db, 'L', 'O', ['o1', 'o2']);
  const [o1, o2] = reprRows(db).slice(before).map((r) => r.body);
  assert.ok(o1.includes('Your Pause was taken: you confirmed it yourself.'), o1);
  assert.ok(o2.includes('Your Pause was taken: you were idle, the host confirmed for you.'), o2);
  db.close();
});

test('M3 vs the Pause douce\'s enrolment: rows the douce enrolled from the BUS run tree are overruled by the live tree — a run-less OPS becomes a coordinator, a demoted ex-orchestrator a worker, a re-parented OPS keeps its own run', () => {
  const { db } = freshDb();
  busRuns.startRun(db, { id: 'L', kind: 'mission', coordinator: 'L' }, ON);
  busRuns.startRun(db, { id: 'D', kind: 'vague', coordinator: 'D', parentRunId: 'L' }, ON); // D was an orchestrator once (its runs row stays)
  assert.equal(setRunPause(db, 'L', true, 'L'), 'paused');
  const pausedAt = getRunPause(db, 'L')!.pausedAt;
  // what the Pause douce wrote at pause time: roles from the BUS tree (D = coordinator because runs.coordinator says so; R has no row ⇒ worker)
  const enrol = db.prepare('INSERT INTO pause_members (run_id, paused_at, ws_id, role, member_run) VALUES (?,?,?,?,?)');
  enrol.run('L', pausedAt, 'L', 'coordinator', 'L');
  enrol.run('L', pausedAt, 'D', 'coordinator', 'D');
  enrol.run('L', pausedAt, 'R', 'worker', 'R');
  for (const [ws, run] of [['L', 'L'], ['D', 'D'], ['R', 'R']] as const) insertBilanRow(db, 'L', ws, pausedAt, run);
  db.prepare('UPDATE runs SET pause_trap_at = ? WHERE id = ?').run(pausedAt + 1, 'L');
  const nodes: WaveNode[] = [{ id: 'L', kind: 'orchestrator' }, { id: 'D', kind: 'scratch', parentId: 'L' }, { id: 'R', kind: 'orchestrator', parentId: 'L' }];
  withLiveTree(nodes, () => {
    beginReprise(db, 'L', 'L');
    const roster = new Map(readRoster(db, 'L', pausedAt).map((r) => [r.wsId, r]));
    assert.equal(roster.get('D')!.role, 'worker', 'demoted: the live tree downgrades the douce\'s bus-tree "coordinator"');
    assert.equal(roster.get('D')!.releasedAt, null, '…so it is NOT host-released');
    assert.equal(roster.get('R')!.role, 'coordinator', 'run-less OPS: upgraded');
    assert.notEqual(roster.get('R')!.releasedAt, null);
    assert.ok(reprRows(db).find((r) => r.recipient === 'L')!.body.includes('• R '), "R is one of the LEAD's direct reports (parent run = L)");
  });
  db.close();
});

test('M3 DEMOTED ex-orchestrator with NO Bilan row / not enumerated: the bus-coordinator fallback must not release it as a coordinator either (its `runs` row outlived the demotion)', () => {
  const { db } = freshDb();
  tree(db);
  busRuns.startRun(db, { id: 'D', kind: 'vague', coordinator: 'D', parentRunId: 'O' }, ON);
  assert.equal(setRunPause(db, 'L', true, 'L'), 'paused');
  const pausedAt = getRunPause(db, 'L')!.pausedAt;
  for (const [ws, run] of [['L', 'L'], ['O', 'O']] as const) insertBilanRow(db, 'L', ws, pausedAt, run); // D is in NO Bilan row and no `extra`
  db.prepare('UPDATE runs SET pause_trap_at = ? WHERE id = ?').run(pausedAt + 1, 'L');
  const nodes: WaveNode[] = [{ id: 'L', kind: 'orchestrator' }, { id: 'O', kind: 'orchestrator', parentId: 'L' }, { id: 'D', kind: 'scratch', parentId: 'O' }];
  withLiveTree(nodes, () => {
    beginReprise(db, 'L', 'L');
    assert.equal(readRoster(db, 'L', pausedAt).some((r) => r.wsId === 'D'), false, 'the live tree knows D and says it is a plain workspace: no roster row from the stale `runs` row');
    assert.equal(reprRows(db).some((r) => r.recipient === 'D'), false);
  });
  db.close();
});

test('M3 UNRELATED wave: an orchestrator elsewhere in the live tree (another LEAD\'s OPS, not under the carrier) is NEVER seeded as a coordinator, never host-released, never sent a reprise row', () => {
  const { db } = freshDb();
  tree(db);
  assert.equal(setRunPause(db, 'L', true, 'L'), 'paused');
  const pausedAt = getRunPause(db, 'L')!.pausedAt;
  for (const [ws, run] of [['L', 'L'], ['O', 'O']] as const) insertBilanRow(db, 'L', ws, pausedAt, run);
  db.prepare('UPDATE runs SET pause_trap_at = ? WHERE id = ?').run(pausedAt + 1, 'L');
  const nodes: WaveNode[] = [
    { id: 'L', kind: 'orchestrator' }, { id: 'O', kind: 'orchestrator', parentId: 'L' },
    { id: 'Z', kind: 'orchestrator' }, { id: 'z1', parentId: 'Z' }, // ANOTHER wave, not under L
  ];
  withLiveTree(nodes, () => {
    beginReprise(db, 'L', 'L');
    const ids = readRoster(db, 'L', pausedAt).map((r) => r.wsId).sort();
    assert.deepEqual(ids, ['L', 'O', 'S', 'X'], 'the carrier subtree only (S and X are bus-run coordinators the live tree does not know: the fallback); Z / z1 belong to another wave');
    assert.equal(reprRows(db).some((r) => r.recipient === 'Z'), false, 'no host-released coordinator from an UNRELATED wave');
  });
  db.close();
});

test('M3 NESTED on the live tree: each coordinator\'s row lists the coordinators DIRECTLY under it (S under O, O and X under L) — read from the live parent chain, with the same wave split as the bus tree', () => {
  const { db } = freshDb();
  tree(db);
  const pausedAt = pauseAndTrap(db);
  withLiveTree(NODES, () => {
    beginReprise(db, 'L', 'L');
    const row = (c: string) => reprRows(db).find((r) => r.recipient === c)!.body;
    assert.ok(row('O').includes('• S [br-S]'), "S is under O: one of O's direct reports");
    assert.equal(row('O').includes('• X [br-X]'), false, 'X is a sibling OPS, not under O');
    assert.ok(row('L').includes('• O [br-O]') && row('L').includes('• X [br-X]'), "O and X are the LEAD's direct reports");
    assert.equal(row('L').includes('• S [br-S]'), false, "S is O's, not the LEAD's");
    assert.deepEqual(new Map(readRoster(db, 'L', pausedAt).map((r) => [r.wsId, r.memberRun])).get('S'), 'S', "a coordinator's member_run is the run it coordinates");
  });
  db.close();
});

// ── review (delta 2): no topology may leave a RESUMING run un-closable ────────

test('PLAIN-ANCHOR carrier (#221: a plain workspace anchors the run, no orchestrator): the host releases its coordinator, the members are workers OF THE CARRIER run, and the carrier\'s coordinator releases them with --all', () => {
  const { db } = freshDb();
  busRuns.startRun(db, { id: 'P', kind: 'mission', coordinator: 'P' }, ON);
  assert.equal(setRunPause(db, 'P', true, 'P'), 'paused');
  const pausedAt = getRunPause(db, 'P')!.pausedAt;
  // the trap's own `memberRun` for a member of a plain anchor is ITS OWN id (nearestOrchestratorId: "no orchestrator above ⇒ its own standalone run")
  for (const [ws, run] of [['P', 'P'], ['w1', 'w1'], ['w2', 'w2']] as const) insertBilanRow(db, 'P', ws, pausedAt, run);
  db.prepare('UPDATE runs SET pause_trap_at = ? WHERE id = ?').run(pausedAt + 1, 'P');
  const nodes: WaveNode[] = [{ id: 'P', kind: 'scratch' }, { id: 'w1', parentId: 'P' }, { id: 'w2', parentId: 'P' }];
  withLiveTree(nodes, () => {
    assert.equal(beginReprise(db, 'P', 'P'), 'resuming');
    const roster = new Map(readRoster(db, 'P', pausedAt).map((r) => [r.wsId, r]));
    assert.deepEqual([roster.get('P')!.role, roster.get('P')!.memberRun, roster.get('P')!.releasedBy], ['coordinator', 'P', 'host']);
    assert.deepEqual([roster.get('w1')!.role, roster.get('w1')!.memberRun, roster.get('w1')!.releasedAt], ['worker', 'P', null], 'a member of a plain anchor belongs to the CARRIER run, never to a standalone run of its own');
    assert.deepEqual(releaseMembers(db, 'P', 'w1', ['w2']).refused.map((r) => r.wsId), ['w2'], 'a worker may not release a peer');
    const all = releaseMembers(db, 'P', 'P', 'all');
    assert.deepEqual([all.released.sort(), all.below, all.refused], [['w1', 'w2'], [], []], 'the carrier\'s coordinator --all releases both — the run is NOT left RESUMING forever');
    assert.equal(all.finished, true);
  });
  assert.equal(readCarrierColumns(db, 'P')!.pausedAt, null, 'ACTIVE');
  // DELIVERY: a member reads its mail in `$ORCHESTRA_RUN_ID` = nearestOrchestratorId = its OWN id under a plain anchor — the row must be THERE (the wave grouping run P is not where it looks)
  assert.deepEqual(reprRows(db).filter((r) => r.recipient === 'w1').map((r) => r.run_id), ['w1'], 'the Consigne rides the member\'s own env run, not the grouping run');
  assert.equal(bus.check(db, 'w1', 'w1').messages.filter((m) => m.kind === 'reprise').length, 1, 'w1 `orchestra check` (its own run) READS its Consigne');
  assert.equal(bus.check(db, 'P', 'w1').messages.length, 0, 'nothing waits for it in the carrier run');
  db.close();
});

test('DELIVERY run = the member\'s env run over the WHOLE live chain: a plain carrier P UNDER an orchestrator L reads its mail in L — the host row to P and the Consigne to w1 both land in L, never in P', () => {
  const { db } = freshDb();
  busRuns.startRun(db, { id: 'L', kind: 'mission', coordinator: 'L' }, ON);
  busRuns.startRun(db, { id: 'P', kind: 'vague', coordinator: 'P', parentRunId: 'L' }, ON); // a plain workspace that also anchors a run row
  assert.equal(setRunPause(db, 'P', true, 'P'), 'paused');
  const pausedAt = getRunPause(db, 'P')!.pausedAt;
  for (const [ws, run] of [['P', 'L'], ['w1', 'L']] as const) insertBilanRow(db, 'P', ws, pausedAt, run);
  db.prepare('UPDATE runs SET pause_trap_at = ? WHERE id = ?').run(pausedAt + 1, 'P');
  const nodes: WaveNode[] = [{ id: 'L', kind: 'orchestrator' }, { id: 'P', kind: 'scratch', parentId: 'L' }, { id: 'w1', parentId: 'P' }];
  withLiveTree(nodes, () => {
    assert.equal(beginReprise(db, 'P', 'P'), 'resuming');
    assert.deepEqual(reprRows(db).filter((r) => r.recipient === 'P').map((r) => r.run_id), ['L'], 'P reads its mail in L: the host\'s coordinator row goes THERE');
    const r = releaseMembers(db, 'P', 'P', 'all');
    assert.deepEqual([r.released, r.below, r.finished], [['w1'], [], true], 'P --all: w1 belongs to P\'s wave');
  });
  assert.deepEqual(reprRows(db).filter((r) => r.recipient === 'w1').map((r) => r.run_id), ['L'], 'w1 reads its mail in L');
  assert.equal(bus.check(db, 'L', 'w1').messages.filter((m) => m.kind === 'reprise').length, 1);
  assert.equal(bus.check(db, 'P', 'w1').messages.length, 0);
  db.close();
});

test('DANGLING carrier chain: the carrier workspace is gone from the store — O (parent run L) is STILL seeded a host-released coordinator (bus fallback) and its worker is releasable, by the sweep too', () => {
  const { db } = freshDb();
  busRuns.startRun(db, { id: 'L', kind: 'mission', coordinator: 'L' }, ON);
  busRuns.startRun(db, { id: 'O', kind: 'vague', coordinator: 'O', parentRunId: 'L' }, ON);
  assert.equal(setRunPause(db, 'L', true, 'L'), 'paused');
  const pausedAt = getRunPause(db, 'L')!.pausedAt;
  for (const [ws, run] of [['L', 'L'], ['O', 'O'], ['o1', 'O']] as const) insertBilanRow(db, 'L', ws, pausedAt, run);
  db.prepare('UPDATE runs SET pause_trap_at = ? WHERE id = ?').run(pausedAt + 1, 'L');
  // L's workspace was deleted: the live chain of O stops at a parent the tree no longer has
  // o3 hangs under a plain workspace whose own parent is ALSO gone: its live chain names no orchestrator at all — only the bus run tree (its Bilan run O) can say who releases it
  insertBilanRow(db, 'L', 'o3', pausedAt, 'O');
  const nodes: WaveNode[] = [{ id: 'O', kind: 'orchestrator', parentId: 'L' }, { id: 'o1', parentId: 'O' }, { id: 'o3', parentId: 'xp' }, { id: 'xp', parentId: 'gone' }];
  withLiveTree(nodes, () => {
    assert.equal(beginReprise(db, 'L', 'L'), 'resuming');
    const roster = new Map(readRoster(db, 'L', pausedAt).map((r) => [r.wsId, r]));
    assert.deepEqual([roster.get('O')!.role, roster.get('O')!.memberRun, roster.get('O')!.releasedBy], ['coordinator', 'O', 'host'], 'O is a coordinator by the bus run tree (the live chain dangles: it says nothing)');
    assert.deepEqual(releaseMembers(db, 'L', 'O', ['o3']).released, ['o3'], 'the live chain of o3 dangles and names nobody: the bus run tree (O coordinates its Bilan run) authorises O');
    assert.equal(roster.get('o1')!.role, 'worker');
    assert.deepEqual(releaseMembers(db, 'L', 'stranger', ['o1']).refused.map((r) => r.wsId), ['o1']);
    // the host sweep completes the roster from the live enumeration and the OPS releases its worker
    sweepReprise({ getBus: () => db, members: () => [{ wsId: 'o1', runId: 'O' }, { wsId: 'o9', runId: 'O' }], subtree: runSubtreeIds });
    assert.equal(readRoster(db, 'L', pausedAt).find((r) => r.wsId === 'o9')?.releasedAt, null, 'a live member the Bilan never saw joins BLOCKED');
    const own = releaseMembers(db, 'L', 'O', 'all');
    assert.deepEqual(own.released.sort(), ['o1', 'o9'], 'O --all: its own run');
    sweepReprise({ getBus: () => db, members: () => [{ wsId: 'o1', runId: 'O' }, { wsId: 'o9', runId: 'O' }], subtree: runSubtreeIds });
  });
  assert.equal(readCarrierColumns(db, 'L')!.pausedAt, null, 'closed');
  db.close();
});

test('RE-PARENTED-OUT member: a Bilan\'d worker the store later moved under ANOTHER wave stays releasable by the carrier\'s coordinator (explicit id), never stranded', () => {
  const { db } = freshDb();
  busRuns.startRun(db, { id: 'L', kind: 'mission', coordinator: 'L' }, ON);
  busRuns.startRun(db, { id: 'O', kind: 'vague', coordinator: 'O', parentRunId: 'L' }, ON);
  assert.equal(setRunPause(db, 'L', true, 'L'), 'paused');
  const pausedAt = getRunPause(db, 'L')!.pausedAt;
  for (const [ws, run] of [['L', 'L'], ['O', 'O'], ['m1', 'O']] as const) insertBilanRow(db, 'L', ws, pausedAt, run);
  db.prepare('UPDATE runs SET pause_trap_at = ? WHERE id = ?').run(pausedAt + 1, 'L');
  // m1 now hangs under Z, a top-level orchestrator that is NOT in L's wave (a COMPLETE chain: not dangling)
  const nodes: WaveNode[] = [{ id: 'L', kind: 'orchestrator' }, { id: 'O', kind: 'orchestrator', parentId: 'L' }, { id: 'Z', kind: 'orchestrator' }, { id: 'm1', parentId: 'Z' }];
  withLiveTree(nodes, () => {
    assert.equal(beginReprise(db, 'L', 'L'), 'resuming');
    assert.equal(readRoster(db, 'L', pausedAt).find((r) => r.wsId === 'm1')?.role, 'worker', 'a workspace of ANOTHER wave on a complete chain is a plain worker, never a coordinator');
    assert.deepEqual(releaseMembers(db, 'L', 'O', ['m1']).refused.map((r) => r.wsId), ['m1'], 'O no longer sits above it');
    const r = releaseMembers(db, 'L', 'L', ['m1']);
    assert.deepEqual([r.released, r.refused], [['m1'], []], 'the carrier\'s coordinator may release anyone in its roster');
    assert.equal(r.finished, true);
  });
  assert.equal(readCarrierColumns(db, 'L')!.pausedAt, null);
  db.close();
});

test('`--all` releases a COORDINATOR row of the caller\'s own run too (a sub-OPS whose parent run is the caller\'s) — member_run of a coordinator is the run it COORDINATES, not the run that releases it', () => {
  const { db } = freshDb();
  tree(db);
  const pausedAt = pauseAndTrap(db);
  withLiveTree(NODES, () => {
    // pretend the host had not released S (a coordinator below O): `O --all` must take it, `L --all` must name it BELOW
    beginReprise(db, 'L', 'L');
    db.prepare("UPDATE pause_members SET released_at = NULL, released_by = NULL WHERE run_id = 'L' AND paused_at = ? AND ws_id = 'S'").run(pausedAt);
    const l = releaseMembers(db, 'L', 'L', 'all');
    assert.equal(l.released.includes('S'), false, 'L --all: S is O\'s direct report, not L\'s');
    assert.equal(l.below.includes('S'), true, 'named as below');
    const o = releaseMembers(db, 'L', 'O', 'all');
    assert.equal(o.released.includes('S'), true, 'O --all releases the coordinator of the run BELOW it (its parent run is O)');
  });
  db.close();
});

test('the forced roster upsert is a TRUE no-op on repeat: a second seed changes NO row (a write would re-trigger the bus-dir watcher → sweep → write loop)', () => {
  const { db } = freshDb();
  tree(db);
  const pausedAt = pauseAndTrap(db);
  insertBilanRow(db, 'L', 'ghost', pausedAt, 'O'); // unknown to the live tree: seeded through the NON-forced path
  withLiveTree(NODES, () => {
    beginReprise(db, 'L', 'L');
    const total = () => (db.prepare('SELECT total_changes() AS c').get() as { c: number }).c;
    const members = NODES.filter((w) => !w.kind).map((w) => ({ wsId: w.id, runId: 'L' }));
    seedRoster(db, 'L', pausedAt, runSubtreeIds(db, 'L'), members); // settles whatever the first seed changed
    const before = total();
    seedRoster(db, 'L', pausedAt, runSubtreeIds(db, 'L'), members);
    seedRoster(db, 'L', pausedAt, runSubtreeIds(db, 'L'));
    assert.equal(total(), before, 'no INSERT, no UPDATE: the seed is idempotent at the row level');
  });
  db.close();
});

// ── review r2 (R2r2-m2, R2r2-m3) ──────────────────────────────────────────────

/** A fleet whose O was created top-level and re-parented under L LATER (`parent_run_id` write-once ⇒ no bus parent): the bus tree cannot see O, only the live tree can. */
function reparentedFleet(): { db: bus.BusDb; pausedAt: number; nodes: WaveNode[] } {
  const { db } = freshDb();
  busRuns.startRun(db, { id: 'L', kind: 'mission', coordinator: 'L' }, ON);
  busRuns.startRun(db, { id: 'O', kind: 'vague', coordinator: 'O' }, ON);
  assert.equal(setRunPause(db, 'L', true, 'L'), 'paused');
  const pausedAt = getRunPause(db, 'L')!.pausedAt;
  for (const [ws, run] of [['L', 'L'], ['O', 'O'], ['o1', 'O'], ['o2', 'O']] as const) insertBilanRow(db, 'L', ws, pausedAt, run);
  db.prepare('UPDATE runs SET pause_trap_at = ? WHERE id = ?').run(pausedAt + 1, 'L');
  const nodes: WaveNode[] = [{ id: 'L', kind: 'orchestrator' }, { id: 'O', kind: 'orchestrator', parentId: 'L' }, { id: 'o1', parentId: 'O' }, { id: 'o2', parentId: 'O' }];
  return { db, pausedAt, nodes };
}

test('R2r2-m2a UNREADABLE tree at `run resume`: a re-parented OPS begins as a blocked worker — the host sweep, once the live tree is readable, makes it a COORDINATOR and host-releases it with its wave\'s Bilan (nobody else would)', () => {
  const { db, pausedAt, nodes } = reparentedFleet();
  assert.equal(beginReprise(db, 'L', 'L'), 'resuming'); // no live tree registered: the bus tree sees only L
  const at = () => new Map(readRoster(db, 'L', pausedAt).map((r) => [r.wsId, r]));
  assert.deepEqual([at().get('O')!.role, at().get('O')!.releasedAt], ['worker', null], 'degraded begin: O is a blocked worker');
  assert.equal(reprRows(db).some((r) => r.recipient === 'O'), false);
  withLiveTree(nodes, () => {
    sweepReprise({ getBus: () => db, members: () => [{ wsId: 'o1', runId: 'O' }, { wsId: 'o2', runId: 'O' }], subtree: runSubtreeIds });
    assert.deepEqual([at().get('O')!.role, at().get('O')!.releasedBy], ['coordinator', 'host'], 'the sweep flipped the role AND host-released it');
    const row = reprRows(db).filter((r) => r.recipient === 'O');
    assert.equal(row.length, 1, 'exactly ONE reprise row, in O\'s own run');
    assert.deepEqual([row[0].sender, row[0].run_id], ['host', 'O']);
    assert.ok(row[0].body.includes('REPRISE — you are released first (coordinator of run O') && row[0].body.includes('o1') && row[0].body.includes('o2'), row[0].body);
    assert.equal(at().get('o1')!.releasedAt, null, 'its workers stay BLOCKED until it dispatches them');
    sweepReprise({ getBus: () => db, members: () => [{ wsId: 'o1', runId: 'O' }, { wsId: 'o2', runId: 'O' }], subtree: runSubtreeIds });
    assert.equal(reprRows(db).filter((r) => r.recipient === 'O').length, 1, 'a second sweep sends nothing more');
    const own = releaseMembers(db, 'L', 'O', 'all');
    assert.deepEqual(own.released.sort(), ['o1', 'o2']);
  });
  assert.equal(readCarrierColumns(db, 'L')!.pausedAt, null, 'the Reprise closes');
  db.close();
});

test('R2r2-m2a the LATE host release is for Bilan\'d coordinators ONLY: a sub-OPS that joined during the Reprise (no Bilan row) stays BLOCKED until its own parent releases it; a coordinator the LEAD already released by hand is not released twice', () => {
  const { db, pausedAt, nodes } = reparentedFleet();
  assert.equal(beginReprise(db, 'L', 'L'), 'resuming');
  const withJoiner: WaveNode[] = [...nodes, { id: 'S', kind: 'orchestrator', parentId: 'O' }, { id: 's1', parentId: 'S' }];
  withLiveTree(withJoiner, () => {
    // the LEAD releases O by hand BEFORE the sweep ran
    assert.deepEqual(releaseMembers(db, 'L', 'L', ['O']).released, ['O']);
    sweepReprise({ getBus: () => db, members: () => [{ wsId: 'o1', runId: 'O' }, { wsId: 's1', runId: 'S' }], subtree: runSubtreeIds });
    const roster = new Map(readRoster(db, 'L', pausedAt).map((r) => [r.wsId, r]));
    assert.equal(roster.get('O')!.releasedBy, 'L', 'the hand release stands — the sweep did not overwrite it');
    assert.equal(reprRows(db).filter((r) => r.recipient === 'O').length, 1, 'ONE row for O (the LEAD\'s), none from the host');
    assert.deepEqual([roster.get('S')!.role, roster.get('S')!.releasedAt], ['coordinator', null], 'S joined later: no Bilan row ⇒ NOT host-released');
    assert.equal(reprRows(db).some((r) => r.recipient === 'S'), false);
  });
  db.close();
});

test('R2r2-m2b `repriseStatusView` walks the LIVE chain too: a re-parented OPS (no bus parent) sees the ancestor carrier\'s "N/M repris" from its own run; without a live tree it cannot', () => {
  const { db, nodes } = reparentedFleet();
  withLiveTree(nodes, () => assert.equal(beginReprise(db, 'L', 'L'), 'resuming'));
  assert.equal(repriseStatusView(db, 'O'), null, 'no live tree: O has no bus parent — the walk ends at O');
  withLiveTree(nodes, () => {
    const v = repriseStatusView(db, 'O');
    assert.ok(v, 'the live chain O → L finds the resuming carrier');
    assert.deepEqual([v!.carrier, v!.phase, v!.total, v!.released, v!.blocked.sort()], ['L', 'resuming', 4, 2, ['o1', 'o2']]);
    assert.equal(repriseStatusView(db, 'L')!.carrier, 'L');
  });
  db.close();
});

test('R2r2-m3 `releasers` admits only ORCHESTRATORS above the member, not any live ancestor: a plain workspace between the OPS and its worker may not release it', () => {
  const { db } = freshDb();
  busRuns.startRun(db, { id: 'L', kind: 'mission', coordinator: 'L' }, ON);
  busRuns.startRun(db, { id: 'O', kind: 'vague', coordinator: 'O', parentRunId: 'L' }, ON);
  assert.equal(setRunPause(db, 'L', true, 'L'), 'paused');
  const pausedAt = getRunPause(db, 'L')!.pausedAt;
  for (const [ws, run] of [['L', 'L'], ['O', 'O'], ['p', 'O'], ['m', 'O']] as const) insertBilanRow(db, 'L', ws, pausedAt, run);
  db.prepare('UPDATE runs SET pause_trap_at = ? WHERE id = ?').run(pausedAt + 1, 'L');
  const nodes: WaveNode[] = [{ id: 'L', kind: 'orchestrator' }, { id: 'O', kind: 'orchestrator', parentId: 'L' }, { id: 'p', kind: 'scratch', parentId: 'O' }, { id: 'm', parentId: 'p' }];
  withLiveTree(nodes, () => {
    beginReprise(db, 'L', 'L');
    const r = releaseMembers(db, 'L', 'p', ['m']);
    assert.deepEqual([r.released, r.refused.map((x) => x.wsId)], [[], ['m']], 'a plain workspace above m is no coordinator');
    assert.deepEqual(r.refused[0].mayBe.sort(), ['L', 'O'], 'only the orchestrators (and the carrier\'s own) are named');
    assert.deepEqual(releaseMembers(db, 'L', 'O', ['m']).released, ['m']);
  });
  db.close();
});

test('R2r2-m3 the FORCED upsert corrects `member_run`: members the Pause douce enrolled under their OWN run (a plain-anchor carrier) are re-homed to the carrier run, so its coordinator\'s `--all` releases them', () => {
  const { db } = freshDb();
  busRuns.startRun(db, { id: 'P', kind: 'mission', coordinator: 'P' }, ON);
  assert.equal(setRunPause(db, 'P', true, 'P'), 'paused');
  const pausedAt = getRunPause(db, 'P')!.pausedAt;
  for (const [ws, run] of [['P', 'P'], ['w1', 'w1'], ['w2', 'w2']] as const) insertBilanRow(db, 'P', ws, pausedAt, run);
  db.prepare('UPDATE runs SET pause_trap_at = ? WHERE id = ?').run(pausedAt + 1, 'P');
  // what the douce's enrolment wrote: workers under their own (standalone) run id
  for (const ws of ['w1', 'w2']) upsertRosterMember(db, { runId: 'P', pausedAt, wsId: ws, role: 'worker', memberRun: ws });
  const nodes: WaveNode[] = [{ id: 'P', kind: 'scratch' }, { id: 'w1', parentId: 'P' }, { id: 'w2', parentId: 'P' }];
  withLiveTree(nodes, () => {
    assert.equal(beginReprise(db, 'P', 'P'), 'resuming');
    assert.deepEqual(readRoster(db, 'P', pausedAt).filter((r) => r.role === 'worker').map((r) => r.memberRun), ['P', 'P'], 'the live truth overruled the enrolment');
    const all = releaseMembers(db, 'P', 'P', 'all');
    assert.deepEqual([all.released.sort(), all.below], [['w1', 'w2'], []]);
  });
  db.close();
});

test('R2r2-m3 an UNREADABLE live tree (the source throws, or its enumeration does) is "no tree": the Reprise still begins from the bus run tree', () => {
  for (const mode of ['source', 'ids'] as const) {
    const { db } = freshDb();
    tree(db);
    pauseAndTrap(db);
    setLiveTreeSource(() => {
      if (mode === 'source') throw new Error('store.json unreadable');
      return { get: (id) => byId.get(id), ids: () => { if (mode === 'ids') throw new Error('torn read'); return NODES.map((w) => w.id); } };
    });
    try {
      assert.equal(beginReprise(db, 'L', 'L'), 'resuming', mode);
      assert.deepEqual(readRoster(db, 'L', getRunPause(db, 'L')!.pausedAt).filter((r) => r.role === 'coordinator').map((r) => r.wsId).sort(), ['L', 'O', 'S', 'X'], `${mode}: coordinators from the bus run tree`);
    } finally {
      setLiveTreeSource(null);
    }
    db.close();
  }
});

test('R2r2-m3 a workspace that coordinates TWO runs of the subtree is homed in the SHALLOWEST one (bus fallback, no live tree)', () => {
  const { db } = freshDb();
  busRuns.startRun(db, { id: 'L', kind: 'mission', coordinator: 'L' }, ON);
  busRuns.startRun(db, { id: 'A', kind: 'vague', coordinator: 'X', parentRunId: 'L' }, ON);
  busRuns.startRun(db, { id: 'B', kind: 'vague', coordinator: 'X', parentRunId: 'A' }, ON);
  assert.equal(setRunPause(db, 'L', true, 'L'), 'paused');
  const pausedAt = getRunPause(db, 'L')!.pausedAt;
  for (const [ws, run] of [['L', 'L'], ['X', 'A']] as const) insertBilanRow(db, 'L', ws, pausedAt, run);
  db.prepare('UPDATE runs SET pause_trap_at = ? WHERE id = ?').run(pausedAt + 1, 'L');
  assert.equal(beginReprise(db, 'L', 'L'), 'resuming');
  const x = readRoster(db, 'L', pausedAt).find((r) => r.wsId === 'X')!;
  assert.deepEqual([x.role, x.memberRun], ['coordinator', 'A'], 'shallowest wins: A (depth 1), not B (depth 2)');
  db.close();
});

test('R2r2-m2a the LATE pass\'s coordinator body names only the coordinators released WITH it: a sub-OPS left blocked (no Bilan row) is not announced as released', () => {
  const { db, nodes } = reparentedFleet();
  assert.equal(beginReprise(db, 'L', 'L'), 'resuming'); // degraded begin
  const withJoiner: WaveNode[] = [...nodes, { id: 'S', kind: 'orchestrator', parentId: 'O' }, { id: 's1', parentId: 'S' }];
  withLiveTree(withJoiner, () => {
    sweepReprise({ getBus: () => db, members: () => [{ wsId: 'o1', runId: 'O' }, { wsId: 's1', runId: 'S' }], subtree: runSubtreeIds });
  });
  const body = reprRows(db).find((r) => r.recipient === 'O')!.body;
  assert.equal(body.includes('Other coordinators released at the same time by the host'), false, body);
  assert.equal(reprRows(db).some((r) => r.recipient === 'S'), false, 'S itself is not released');
  db.close();
});

test('R2r2-m2b `repriseStatusView` trusts the LIVE chain over a STALE bus parent: an OPS re-parented from B1 to L1 (both RESUMING) shows L1\'s Reprise, not B1\'s', () => {
  const { db } = freshDb();
  busRuns.startRun(db, { id: 'L1', kind: 'mission', coordinator: 'L1' }, ON);
  busRuns.startRun(db, { id: 'B1', kind: 'mission', coordinator: 'B1' }, ON);
  busRuns.startRun(db, { id: 'O', kind: 'vague', coordinator: 'O', parentRunId: 'B1' }, ON); // created under B1, moved under L1 by the store later
  for (const c of ['L1', 'B1']) assert.equal(setRunPause(db, c, true, c), 'paused');
  const at = (c: string) => getRunPause(db, c)!.pausedAt;
  for (const [ws, run] of [['L1', 'L1'], ['O', 'O'], ['o1', 'O']] as const) insertBilanRow(db, 'L1', ws, at('L1'), run);
  for (const [ws, run] of [['B1', 'B1'], ['b1', 'B1']] as const) insertBilanRow(db, 'B1', ws, at('B1'), run);
  for (const c of ['L1', 'B1']) db.prepare('UPDATE runs SET pause_trap_at = ? WHERE id = ?').run(at(c) + 1, c);
  const nodes: WaveNode[] = [{ id: 'L1', kind: 'orchestrator' }, { id: 'O', kind: 'orchestrator', parentId: 'L1' }, { id: 'o1', parentId: 'O' }, { id: 'B1', kind: 'orchestrator' }, { id: 'b1', parentId: 'B1' }];
  withLiveTree(nodes, () => {
    assert.equal(beginReprise(db, 'L1', 'L1'), 'resuming');
    assert.equal(beginReprise(db, 'B1', 'B1'), 'resuming');
    assert.equal(repriseStatusView(db, 'O')?.carrier, 'L1', 'the live chain O → L1 decides');
  });
  assert.equal(repriseStatusView(db, 'O')?.carrier, 'B1', 'without a live tree only the (stale) bus parent is known — the control that proves the order matters');
  db.close();
});
