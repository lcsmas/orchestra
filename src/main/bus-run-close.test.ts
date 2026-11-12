// #437 — a run closes with its coordinator. Drives the REAL close/reopen/reconcile functions over a real SQLite bus, the
// BUILT CLI (`send` / `ask` / `gate` / `check` / `bus-status`) against that bus + a real store.json, and the real enumerators
// (liveFleetRuns, readPendingReaders, sweepBusLiveness, the Pause carrier reads). The Electron-only archive/delete/unarchive
// call sites are pinned at source level (workspaces.ts cannot load under node --test). Mutants: scripts/run-close-mutants.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openBus, send, openGate, getGate, openGatesForRecipientAllRuns, type BusDb } from './bus.ts';
import { startRun, getRun, runFlags, busStatusRunView } from './bus-runs.ts';
import { closeRunsCoordinatedBy, reopenRunsCoordinatedBy, reconcileRunClosure, closedRunIds, isGateRunClosed, reopenRunsById, coordinatorStateOf, reconcileRunClosureFromStore, type CoordinatorState } from './bus-run-close.ts';
import { startRunsForParentless, type BusRunAnchorDeps } from './bus-run-anchor.ts';
import { readPendingReaders } from './bus-wake.ts';
import { liveFleetRuns, memoryPausedRuns } from './pause-memory.ts';
import { autoPausedRuns } from './pause-auto.ts';
import { activePauseCarriers } from './bus-pause-records.ts';
import { softPausingCarriers } from './pause-douce.ts';
import {
  sweepBusLiveness, setLivenessRoster, setLivenessSwitchReader, __setBusReaderForTests, __setNowForTests, __resetBusLivenessForTests, __armForTests,
  type LivenessMember,
} from './bus-liveness.ts';
import { offlineWaveNodes } from '../cli/index.ts';
import { DEFAULT_BUS_SWITCHES, serializeSwitches, type BusSwitches } from '../shared/bus-switches.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const CLI = path.join(repoRoot, 'dist-electron', 'cli.js');
const needsBuild = { skip: fs.existsSync(CLI) ? false : 'dist-electron/cli.js not built — run `pnpm run build:cli`' };

const LIVE: BusSwitches = { ...DEFAULT_BUS_SWITCHES, wake: true, askGate: true, liveness: true, pause: true };
const FROZEN_WAKE_OFF: BusSwitches = { ...LIVE, wake: false };

const LEAD = 'bbbbbbbb-0000-4000-8000-000000000001';
const OPS = 'bbbbbbbb-0000-4000-8000-000000000002';
const W = 'bbbbbbbb-0000-4000-8000-000000000003'; // member of OPS
const W2 = 'bbbbbbbb-0000-4000-8000-000000000004'; // member of OPS
const T1 = 'bbbbbbbb-0000-4000-8000-000000000011'; // lone top-level agent

type Rec = Record<string, unknown>;
interface World { home: string; db: BusDb; storeFile: string }

function writeStore(w: World, patch: Record<string, Rec> = {}, drop: string[] = []): void {
  const rec = (id: string, extra: Rec = {}): Rec => ({ id, name: `ws-${id.slice(-2)}`, kind: 'worktree', ...extra, ...(patch[id] ?? {}) });
  const all = [
    rec(LEAD, { kind: 'orchestrator' }),
    rec(OPS, { parentId: LEAD, canOrchestrate: true }),
    rec(W, { parentId: OPS }),
    rec(W2, { parentId: OPS }),
    rec(T1),
  ].filter((r) => !drop.includes(r.id as string));
  fs.writeFileSync(w.storeFile, JSON.stringify({ workspaces: all }));
}

/** LEAD mission ⊃ OPS vague ⊃ W, W2; plus a lone top-level T1 with its mission. Rows started with the OPS run's frozen wake OFF (a witness for "switches untouched"). */
function world(t: { after: (fn: () => void) => void }): World {
  const home = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'orch-437-'));
  const db = openBus(path.join(home, 'bus.sqlite'));
  t.after(() => {
    db.close();
    fs.rmSync(home, { recursive: true, force: true });
  });
  const dir = path.join(home, 'userData', 'orchestra');
  fs.mkdirSync(dir, { recursive: true });
  const w: World = { home, db, storeFile: path.join(dir, 'store.json') };
  writeStore(w);
  startRun(db, { id: LEAD, kind: 'mission', coordinator: LEAD }, LIVE);
  startRun(db, { id: OPS, kind: 'vague', coordinator: OPS, parentRunId: LEAD }, FROZEN_WAKE_OFF);
  startRun(db, { id: T1, kind: 'mission', coordinator: T1 }, LIVE);
  return w;
}

interface Out { code: number; stdout: string; stderr: string }
function cliEnv(w: World, ws: string, run: string): Record<string, string> {
  return { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: w.home, ORCHESTRA_HOME: w.home, ORCHESTRA_SOCK: path.join(w.home, 'dead.sock'), ORCHESTRA_WS_ID: ws, ORCHESTRA_RUN_ID: run };
}
function cli(w: World, ws: string, run: string, args: string[]): Out {
  try {
    const stdout = execFileSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: cliEnv(w, ws, run), stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 });
    return { code: 0, stdout, stderr: '' };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? -1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}
const count = (w: World, table: string): number => (w.db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c;
const bus = (w: World) => ({ messages: count(w, 'messages'), gates: count(w, 'decision_gates'), deliveries: count(w, 'deliveries'), runs: count(w, 'runs') });
const closedAt = (w: World, id: string): number | null => (w.db.prepare('SELECT closed_at AS c FROM runs WHERE id = ?').get(id) as { c: number | null }).c;

function refused(r: Out, run: string): void {
  assert.equal(r.code, 1, `must be refused (rc 1), got ${r.code}: ${r.stdout}${r.stderr}`);
  assert.ok(r.stderr.includes(`run "${run}" is CLOSED`), `the refusal must NAME the closed run ${run}: ${r.stderr}`);
  assert.match(r.stderr, /Nothing was written/);
}

/** `orchestra bus-status` against a stub app socket whose `/busStatus` reply is built by the REAL `busStatusRunView` over the real bus. */
function busStatus(w: World, ws: string, run: string): Promise<Out> {
  const sock = path.join(fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'orch-437-s-')), 's.sock');
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = JSON.parse(raw || '{}') as { runId?: string };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, busAvailable: true, counters: [], ...busStatusRunView(w.db, body.runId ?? run, serializeSwitches(LIVE)) }));
    });
  });
  return new Promise((resolve) => {
    server.listen(sock, () => {
      execFile(process.execPath, [CLI, 'bus-status'], { env: { ...cliEnv(w, ws, run), ORCHESTRA_SOCK: sock }, timeout: 30_000 }, (err, stdout, stderr) => {
        server.close();
        resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, stdout, stderr });
      });
    });
  });
}

// ─── archive / delete close the run; mail to it is refused, not parked ─────────────────────────────────────────────────────────

test('#437 archive: the run closes; send / ask / gate open / gate resolve into it are REFUSED naming it, nothing inserted; check still reads', needsBuild, async (t) => {
  const w = world(t);
  // Failing control (the unfixed state = a run that is still open): the same calls LAND, so the refusals below prove the close.
  assert.equal(cli(w, W, OPS, ['send', '--type', 'status', 'before']).code, 0);
  const gateOut = cli(w, W, OPS, ['gate', 'open', '--to', LEAD, 'proceed?']);
  assert.equal(gateOut.code, 0, gateOut.stderr);
  const gateId = gateOut.stdout.trim();
  assert.equal(cli(w, W, OPS, ['ask', '--to', LEAD, 'a question?']).code, 0);
  const lot = cli(w, W, OPS, ['check']); // an unread lot sits in the run's history
  assert.equal(lot.code, 0, lot.stderr);

  // ARCHIVE the coordinator (archiveWorkspace closes per workspace of the subtree: OPS coordinates a run, W / W2 coordinate none).
  writeStore(w, { [OPS]: { archived: true } }); // W stays live: a member whose coordinator was archived
  const closed = closeRunsCoordinatedBy(w.db, [OPS, W, W2]);
  assert.deepEqual(closed, [OPS], 'only the run OPS coordinates closes — never LEAD\'s, never a member\'s');
  assert.notEqual(closedAt(w, OPS), null);
  assert.equal(closedAt(w, LEAD), null, 'the parent run stays open');
  assert.equal(closedAt(w, T1), null);
  const before = bus(w);

  // The member's OWN mail (its baked run is the closed one): refused, names the run, nothing inserted.
  refused(cli(w, W, OPS, ['send', '--type', 'status', 'after']), OPS);
  refused(cli(w, W, OPS, ['ask', '--to', LEAD, 'still there?']), OPS);
  refused(cli(w, W, OPS, ['gate', 'open', '--to', LEAD, 'now?']), OPS);
  // Mail from an OPEN run TO a member of the closed one: refused on the recipient's run (W is live; its run is OPS).
  for (const verb of [['send', '--type', 'status', '--to', W, 'hi'], ['ask', '--to', W, 'hi?'], ['gate', 'open', '--to', W, 'hi?']]) {
    refused(cli(w, LEAD, LEAD, verb), OPS);
  }
  // A ruling on a gate that sits in the closed run: refused, the gate stays open, no re-wake message is parked.
  refused(cli(w, LEAD, LEAD, ['gate', 'resolve', gateId, '--resolution', 'yes']), OPS);
  assert.equal((w.db.prepare('SELECT resolution FROM decision_gates WHERE id = ?').get(Number(gateId)) as { resolution: string | null }).resolution, null);
  assert.deepEqual(bus(w), before, 'REFUSED, NOT PARKED: not one row was inserted by any of the 8 refused calls');

  // Reading is never blocked: the member still reads its unread lot of the closed run.
  assert.equal(cli(w, W, OPS, ['check', '--run', OPS]).code, 0);
  // An unrelated open run is untouched (the guard is per run, not global).
  assert.equal(cli(w, T1, T1, ['send', '--type', 'status', 'alive']).code, 0);
  assert.equal(cli(w, LEAD, LEAD, ['send', '--type', 'status', 'lead alive']).code, 0);

  // bus-status says so.
  const st = await busStatus(w, W, OPS);
  assert.equal(st.code, 0, st.stderr);
  assert.match(st.stdout, /^closed: CLOSED since /m);
  const open = await busStatus(w, LEAD, LEAD);
  assert.doesNotMatch(open.stdout, /^closed:/m, 'an open run prints no closed line');
});

test('#437 delete: the run closes; a former member (its coordinator gone) is refused naming the closed run until its own mission starts', needsBuild, (t) => {
  const w = world(t);
  assert.equal(cli(w, W, OPS, ['send', '--type', 'status', 'before']).code, 0);
  writeStore(w, {}, [OPS]); // OPS deleted from the store: W's parent link now dangles
  assert.deepEqual(closeRunsCoordinatedBy(w.db, [OPS]), [OPS]);
  const before = bus(w);
  refused(cli(w, W, OPS, ['send', '--type', 'status', 'orphaned']), OPS);
  assert.deepEqual(bus(w), before);

  // The #433 sweep never re-creates the closed run, and gives the now-top-level W its own mission (a new, open run).
  const nodes = offlineWaveNodes(w.storeFile);
  const deps: BusRunAnchorDeps = { getBus: () => w.db, startRun, getRun, refreezeRun: () => false, getLiveSwitches: () => LIVE, warn: () => {} };
  assert.deepEqual(startRunsForParentless(deps, [...nodes.values()], (id) => nodes.get(id)).sort(), [W, W2].sort());
  assert.equal(count(w, 'runs'), before.runs + 2, 'the closed OPS row is untouched: exactly the two new missions were added');
  assert.notEqual(closedAt(w, OPS), null, 'still closed after the sweep');
  assert.equal(cli(w, W, W, ['send', '--type', 'status', 'new run']).code, 0, 'restarted, W speaks in its OWN mission');
});

// ─── unarchive reopens the SAME run ───────────────────────────────────────────────────────────────────────────────────────────

test('#437 unarchive REOPENS the same run: history, unread mail, frozen switches kept; no new run is minted; the member can send again', needsBuild, (t) => {
  const w = world(t);
  assert.equal(cli(w, LEAD, OPS, ['send', '--type', 'dispatch', '--to', W, 'do the thing']).code, 0, 'unread mail for W sits in the OPS run');
  const created = (w.db.prepare('SELECT created_at AS c FROM runs WHERE id = ?').get(OPS) as { c: number }).c;
  const flags = serializeSwitches(runFlags(w.db, OPS));
  const hist = bus(w);

  closeRunsCoordinatedBy(w.db, [OPS]);
  refused(cli(w, W, OPS, ['send', '--type', 'status', 'closed']), OPS);

  assert.deepEqual(reopenRunsCoordinatedBy(w.db, [OPS, W, W2]), [OPS]);
  assert.equal(closedAt(w, OPS), null);
  assert.equal((w.db.prepare('SELECT created_at AS c FROM runs WHERE id = ?').get(OPS) as { c: number }).c, created, 'same row: birth time kept');
  assert.equal(serializeSwitches(runFlags(w.db, OPS)), flags, 'frozen switches untouched (wake stays OFF as frozen)');
  assert.deepEqual(bus(w), hist, 'no run minted, no message lost');
  const checked = cli(w, W, OPS, ['check']);
  assert.equal(checked.code, 0, checked.stderr);
  assert.match(checked.stdout, /do the thing/, 'the unread mail of before the archive is still there');
  assert.equal(cli(w, W, OPS, ['send', '--type', 'status', 'back']).code, 0, 'the member sends into the reopened run');
  assert.deepEqual(reopenRunsCoordinatedBy(w.db, [OPS]), [], 'reopen is idempotent');
  assert.deepEqual(closeRunsCoordinatedBy(w.db, [OPS]), [OPS]);
  const firstClose = closedAt(w, OPS);
  assert.deepEqual(closeRunsCoordinatedBy(w.db, [OPS]), [], 'close is idempotent and keeps its FIRST closing time');
  assert.equal(closedAt(w, OPS), firstClose);
});

// ─── #433 sweep / ensureTopLevelRun / app-start reconcile interplay ──────────────────────────────────────────────────────────────

test('#437 app start: a run is closed iff its coordinator is archived or gone; the #433 sweep never re-creates or double-creates a closed run', needsBuild, (t) => {
  const w = world(t);
  const GONE = 'bbbbbbbb-0000-4000-8000-0000000000ff';
  startRun(w.db, { id: GONE, kind: 'mission', coordinator: GONE }, LIVE); // a run whose coordinator was deleted before this build existed
  closeRunsCoordinatedBy(w.db, [T1]); // T1 archived + closed...
  const state = new Map<string, CoordinatorState>([[LEAD, 'live'], [OPS, 'archived'], [T1, 'live']]); // ...then unarchived with the reopen dropped; OPS archived but its close dropped
  const stateOf = (id: string): CoordinatorState => state.get(id) ?? 'gone';
  const rowsBefore = count(w, 'runs');

  // The #433 sweep over the live top-level workspaces: it must NOT touch the existing (closed) T1 row, nor create a second one.
  writeStore(w, { [OPS]: { archived: true } });
  const nodes = offlineWaveNodes(w.storeFile);
  const deps: BusRunAnchorDeps = { getBus: () => w.db, startRun, getRun, refreezeRun: () => false, getLiveSwitches: () => LIVE, warn: () => {} };
  const live = [...nodes.values()].filter((n) => n.id !== OPS);
  assert.deepEqual(startRunsForParentless(deps, live, (id) => nodes.get(id)), [], 'every live top-level workspace already has its row (closed or not): nothing created');
  assert.equal(count(w, 'runs'), rowsBefore);
  assert.notEqual(closedAt(w, T1), null, 'the sweep does not reopen it (that is the reconcile\'s job)');

  const r = reconcileRunClosure(w.db, stateOf);
  assert.deepEqual(r.closed.sort(), [GONE, OPS].sort(), 'archived / deleted coordinators close');
  assert.deepEqual(r.reopened, [T1], 'a live coordinator\'s closed run reopens');
  assert.equal(closedAt(w, T1), null);
  assert.equal(closedAt(w, LEAD), null);
  assert.equal(count(w, 'runs'), rowsBefore, 'reconcile never creates a row');
  assert.deepEqual(reconcileRunClosure(w.db, stateOf), { closed: [], reopened: [] }, 'idempotent');
  assert.deepEqual(startRunsForParentless(deps, live, (id) => nodes.get(id)), [], 'and the sweep still creates nothing');
  assert.equal(cli(w, T1, T1, ['send', '--type', 'status', 'hi']).code, 0);
  assert.deepEqual([...closedRunIds(w.db)].sort(), [GONE, OPS].sort());
});

// ─── every enumerator of "live" runs skips a closed run ──────────────────────────────────────────────────────────────────────────

test('#437 liveFleetRuns (memory Pause candidates, memory alert, container window) skips a closed run', (t) => {
  const w = world(t);
  const ws = new Map([[LEAD, { id: LEAD }], [OPS, { id: OPS, parentId: LEAD }], [W, { id: W, parentId: OPS }]]);
  const deps = { getWorkspace: (id: string) => ws.get(id), listWorkspaces: () => [...ws.values()] };
  assert.deepEqual(liveFleetRuns(w.db, deps).map((r) => r.id).sort(), [LEAD, OPS].sort(), 'control: both runs carry a live fleet while open');
  closeRunsCoordinatedBy(w.db, [OPS]);
  assert.deepEqual(liveFleetRuns(w.db, deps).map((r) => r.id), [LEAD], 'the closed run is no longer a live fleet');
});

test('#437 the wake sweep does not wake a reader for mail or a gate sitting in a closed run', (t) => {
  const w = world(t);
  send(w.db, { runId: OPS, sender: LEAD, recipient: W, kind: 'dispatch', body: 'task' });
  openGate(w.db, OPS, W, 'ok?', LEAD);
  const state = () => readPendingReaders(w.db, [{ reader: W, runId: OPS }, { reader: LEAD, runId: LEAD }]);
  const open = state();
  assert.equal(open[0].pending, true, 'control: W is pending for the dispatch while its run is open');
  assert.equal(open[1].gatePending, true, 'control: LEAD is pending for the gate opened in the descendant run');
  closeRunsCoordinatedBy(w.db, [OPS]);
  const closed = state();
  assert.equal(closed[0].pending, false, 'nobody is woken for mail in a closed run');
  assert.equal(closed[1].gatePending, false, 'nor for a gate in it');
  assert.equal(closed[1].pending, false);
});

test('#437 the human Asks tray lists no gate of a closed run (and it returns with the run on unarchive); a closed run takes no ruling', (t) => {
  const w = world(t);
  const g = openGate(w.db, OPS, W, 'need a ruling', 'human');
  const tray = (): number[] => openGatesForRecipientAllRuns(w.db, 'human').map((x) => x.id);
  assert.deepEqual(tray(), [g], 'control: an open run\'s gate is listed');
  assert.equal(isGateRunClosed(w.db, getGate(w.db, g)!), false);
  closeRunsCoordinatedBy(w.db, [OPS]);
  assert.deepEqual(tray(), [], 'a closed run\'s gate is not listed');
  assert.equal(isGateRunClosed(w.db, getGate(w.db, g)!), true, 'and resolveHumanGate refuses it (pinned below)');
  reopenRunsCoordinatedBy(w.db, [OPS]);
  assert.deepEqual(tray(), [g], 'unarchive brings it back');
});

test('#437 the liveness sweep skips a member of a closed run (no escalation to a coordinator that is gone)', (t) => {
  const w = world(t);
  const NOW = 1_700_000_000_000;
  const member: LivenessMember = { reader: W, coordinator: OPS, hasTask: true, lastActivityAt: NOW - 11 * 60 * 1000, running: false, waiting: false, runId: OPS };
  const arm = () => {
    __resetBusLivenessForTests();
    __setBusReaderForTests(() => w.db);
    __setNowForTests(() => NOW);
    setLivenessSwitchReader(() => true);
    setLivenessRoster(() => [member]);
    __armForTests();
  };
  const escalations = (): number => (w.db.prepare("SELECT COUNT(*) AS c FROM messages WHERE kind = 'escalation' AND sender = ?").get(W) as { c: number }).c;
  t.after(() => __resetBusLivenessForTests());
  arm();
  sweepBusLiveness();
  assert.equal(escalations(), 1, 'control: the silent member of an OPEN run escalates once');
  w.db.prepare("DELETE FROM messages WHERE kind = 'escalation'").run();
  closeRunsCoordinatedBy(w.db, [OPS]);
  arm();
  sweepBusLiveness();
  assert.equal(escalations(), 0, 'a closed run\'s member is not escalated');
});

test('#437 the Pause carrier reads (re-arm, soft escalation, usage-limit and memory auto-lift) skip a closed run', (t) => {
  const w = world(t);
  const T = 1_700_000_000_000;
  const setPause = (id: string, cols: Rec): void => {
    for (const [k, v] of Object.entries(cols)) w.db.prepare(`UPDATE runs SET ${k} = ? WHERE id = ?`).run(v as string | number | null, id);
  };
  // OPS: a hard pause; LEAD: a soft pause waiting; T1: a usage-limit auto pause; (memory auto pause on OPS too, second epoch kept apart below)
  setPause(OPS, { paused_at: T, paused_by: LEAD, pause_mode: 'hard' });
  setPause(LEAD, { paused_at: T + 1, paused_by: 'human', pause_mode: 'soft', pause_deadline_at: T + 600_000 });
  setPause(T1, { paused_at: T + 2, pause_mode: 'hard', pause_auto: JSON.stringify({ reason: 'usage_limit', epoch: T + 2, wsIds: [T1], accountIds: [null] }) });
  const W3 = 'bbbbbbbb-0000-4000-8000-000000000021';
  startRun(w.db, { id: W3, kind: 'mission', coordinator: W3 }, LIVE);
  setPause(W3, { paused_at: T + 3, pause_mode: 'hard', pause_auto: JSON.stringify({ reason: 'memory', epoch: T + 3, pauseCycle: 1, episode: 1, availBytes: 1, thresholdBytes: 2 }) });
  const ids = (xs: Array<{ runId: string }>): string[] => xs.map((x) => x.runId).sort();
  const reads = () => ({
    active: ids(activePauseCarriers(w.db)),
    soft: ids(softPausingCarriers(w.db)),
    auto: ids(autoPausedRuns(w.db)),
    memory: ids(memoryPausedRuns(w.db)),
  });
  assert.deepEqual(reads(), { active: [LEAD, OPS, T1, W3].sort(), soft: [LEAD], auto: [T1], memory: [W3] }, 'control: all four reads see their paused runs while open');
  closeRunsCoordinatedBy(w.db, [OPS, LEAD, T1, W3]);
  assert.deepEqual(reads(), { active: [], soft: [], auto: [], memory: [] }, 'a closed run is in none of them');
});

// ─── the app-start reconcile fed by a store (mapping + floor) and the failed-delete rollback ──────────────────────────────────

test('#437 reconcile from the STORE: live coordinators stay open, archived / absent ones close — never the reverse', (t) => {
  const w = world(t);
  const GONE = 'bbbbbbbb-0000-4000-8000-0000000000fe';
  startRun(w.db, { id: GONE, kind: 'mission', coordinator: GONE }, LIVE);
  const recs = JSON.parse(fs.readFileSync(w.storeFile, 'utf8')).workspaces as Array<{ id: string; archived?: boolean }>;
  recs.find((r) => r.id === OPS)!.archived = true;
  const byId = new Map(recs.map((r) => [r.id, r]));
  assert.equal(coordinatorStateOf(undefined), 'gone');
  assert.equal(coordinatorStateOf({ archived: true }), 'archived');
  assert.equal(coordinatorStateOf({}), 'live');
  const r = reconcileRunClosureFromStore(w.db, (id) => byId.get(id), recs.length);
  assert.equal(r.skipped, false);
  assert.deepEqual(r.closed.sort(), [GONE, OPS].sort());
  assert.equal(closedAt(w, LEAD), null, 'a LIVE coordinator\'s run is never closed');
  assert.equal(closedAt(w, T1), null);
  assert.notEqual(closedAt(w, OPS), null);
  byId.get(OPS)!.archived = false; // unarchived in the store, reopen dropped
  assert.deepEqual(reconcileRunClosureFromStore(w.db, (id) => byId.get(id), recs.length).reopened, [OPS]);
});

test('#437 reconcile floor: a store that parsed with 0 workspaces never closes the bus\'s open runs (restored / empty store.json)', (t) => {
  const w = world(t);
  const before = [...closedRunIds(w.db)];
  const r = reconcileRunClosureFromStore(w.db, () => undefined, 0);
  assert.deepEqual({ closed: r.closed, reopened: r.reopened, skipped: r.skipped }, { closed: [], reopened: [], skipped: true });
  assert.deepEqual([...closedRunIds(w.db)], before, 'no run closed');
  // control: the same lookup with a NON-empty store does close (the floor, not the lookup, protected them)
  assert.ok(reconcileRunClosureFromStore(w.db, () => undefined, 1).closed.length > 0);
});

test('#437 failed-delete rollback reopens ONLY the runs this call closed (an archived coordinator\'s run stays closed)', (t) => {
  const w = world(t);
  closeRunsCoordinatedBy(w.db, [OPS]); // archived earlier: OPS's run is already closed
  const thisCall = closeRunsCoordinatedBy(w.db, [OPS, T1]); // the delete's own close: OPS is a no-op, T1 closes
  assert.deepEqual(thisCall, [T1]);
  reopenRunsById(w.db, thisCall); // the rollback (workspaces.ts `reopenRunIds`)
  assert.equal(closedAt(w, T1), null, 'the run THIS call closed is back');
  assert.notEqual(closedAt(w, OPS), null, 'the archived coordinator\'s run stays closed');
});

// ─── wiring of the Electron-only paths (source-level: workspaces.ts cannot load under node --test) ─────────────────────────────

const read = (p: string): string => fs.readFileSync(path.join(repoRoot, p), 'utf8');
function fnBody(src: string, decl: string): string {
  const start = src.indexOf(decl);
  assert.ok(start > 0, `${decl} not found`);
  const after = src.slice(start + decl.length);
  const rel = after.search(/\n(export (async )?function|async function|function) /);
  return after.slice(0, rel > 0 ? rel : 4000);
}
const WS = read('src/main/workspaces.ts');

test('#437 wiring: every archive / delete path closes, unarchive and a session start reopen, app start reconciles', () => {
  // adjacency + order pins (not just presence): the close sits right after the store write in a per-workspace loop, BEFORE the slow teardown of a delete
  assert.match(fnBody(WS, 'export async function archiveWorkspace('), /await store\.upsertWorkspace\(updated\);\n\s+closeRunsOf\(\[ws\.id\]\);/, 'archive (UI, mobile, subtree) closes the run each archived workspace coordinates, after its store write');
  assert.match(fnBody(WS, 'export async function unarchiveWorkspace('), /await store\.upsertWorkspace\(updated\);\n\s+reopenRunsOf\(\[ws\.id\]\);/, 'unarchive reopens');
  const del = fnBody(WS, 'export async function deleteWorkspace(');
  assert.match(del, /const closedRuns = closeRunsOf\(\[id\]\);[^\n]*\n\s+try \{\n\s+await teardownWorkspace\(ws\);\n\s+\} catch \(e\) \{\n\s+reopenRunIds\(closedRuns\);/, 'delete (UI + CLI /deleteWorkspace route through it) closes BEFORE the teardown and reopens if it fails');
  const bulk = fnBody(WS, 'export async function deleteWorkspaces(');
  assert.match(bulk, /for \(const w of targets\) closedByCall\.set\(w\.id, closeRunsOf\(\[w\.id\]\)\);[^\n]*\n\s+try \{/, 'bulk delete closes every target before the first teardown');
  assert.match(bulk, /\} catch \(e\) \{\n\s+reopenRunIds\(targets\.filter\(\(w\) => !removed\.includes\(w\.id\)\)\.flatMap\(\(w\) => closedByCall\.get\(w\.id\) \?\? \[\]\)\);/, 'and reopens only the runs THIS call closed, for those not torn down, when one fails');
  assert.match(fnBody(WS, 'export async function pruneOrphanedWorkspaces('), /closeRunsOf\(\[ws\.id\]\);[^\n]*\n\s+await store\.removeWorkspace\(ws\.id\);/, 'an out-of-band removal is a delete');
  assert.match(fnBody(WS, 'export function ensureRunOpen('), /if \(!\(store\.getWorkspace\(ws\.id\) \?\? ws\)\.archived\) reopenRunsOf\(\[ws\.id\]\);/, 'a session start reopens only for a workspace the STORE says is not archived');
  const hg = fnBody(read('src/main/human-gates.ts'), 'export function resolveHumanGate(');
  assert.ok(hg.indexOf('isGateRunClosed(db, gateBefore)') > 0 && hg.indexOf('isGateRunClosed(db, gateBefore)') < hg.indexOf('resolveGate(db, gateId'), 'the human resolve refuses a closed run\'s gate BEFORE it resolves');
  assert.match(fnBody(WS, 'function closeRunsOf('), /closeRunsCoordinatedBy\(db, ids\)/);
  assert.match(fnBody(WS, 'function reopenRunsOf('), /reopenRunsCoordinatedBy\(db, ids\)/);
  assert.match(fnBody(WS, 'export function reconcileRunClosureAtStart('), /reconcileRunClosureFromStore\(db, \(id\) => store\.getWorkspace\(id\), store\.workspaces\.length\)/, 'app start feeds the pure reconcile the store + its workspace count');
  assert.match(read('src/main/agent-sdk.ts'), /ensureRunOpen\(ws\);/, 'every session start repairs a dropped reopen');
  assert.match(read('src/main/index.ts'), /if \(store\.loadedFromDisk\) try \{ reconcileRunClosureAtStart\(\);/, 'app start reconciles, gated on a store that loaded');
  // negative controls: the instrument can say NO
  assert.doesNotMatch(fnBody(WS, 'export async function createWorkspace('), /closeRunsOf\(/);
  assert.doesNotMatch(fnBody(WS, 'export async function archiveWorkspace('), /reopenRunsOf\(/);
});
