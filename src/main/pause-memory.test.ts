import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as bus from './bus.ts';
import * as busRuns from './bus-runs.ts';
import {
  applyMemoryPause,
  imposeMemoryPause,
  liftMemoryPause,
  memoryPauseCandidates,
  memoryPausedRuns,
  newMemoryPauseLedger,
  type MemoryGuardView,
  type MemoryPauseDeps,
} from './pause-memory.ts';
import type { AutoWorkspace } from './pause-auto.ts';
import { autoPauseOnLimit, autoPausedRuns, evaluateAutoPaused, type PauseAutoDeps } from './pause-auto.ts';
import { readPauseOrigin, insertBilan } from './bus-pause-records.ts';
import { beginReprise as realBeginReprise, setRunPause } from './bus-pause.ts';
import { readCarrierColumns, releaseMembers, setLiveTreeSource } from './pause-reprise.ts';
import { DEFAULT_BUS_SWITCHES, type BusSwitches } from '../shared/bus-switches.ts';
import { GIB } from '../shared/memory-guard.ts';
import { PAUSE_AUTO_BY, encodePauseAuto, parseAutoHeld, parsePauseAuto } from '../shared/pause-auto.ts';
import { MEMORY_PAUSE_BY, encodeMemoryPause, parseMemoryPause } from '../shared/pause-memory.ts';
import type { RepriseEntry } from '../shared/pause-lifecycle.ts';

// #290 (wave G, ledger #295 FI-2 + FI-1.8) — the memory Pause over a REAL bus.sqlite under the real home (btrfs — never /tmp, never the live bus) with a fake workspace tree. The guard is a VIEW
// (`MemoryGuardView`): what the host reads from `getMemoryGuardSnapshot()` / an edge. Named arms are what scripts/pause-memory/mutate-unit.mjs reddens.

const ROOT = path.join(os.homedir(), '.cache', `pause-memory-bus-${process.pid}`);
const ON: BusSwitches = { ...DEFAULT_BUS_SWITCHES, pause: true, wake: true };
const OFF: BusSwitches = { ...DEFAULT_BUS_SWITCHES, wake: true }; // pause switch OFF, wake ON
const T0 = 1_800_000_000_000;
let n = 0;
test.after(() => fs.rmSync(ROOT, { recursive: true, force: true }));

const CRITICAL = 3 * GIB;
const ADMISSION = 6 * GIB;
/** The guard as the host reads it. Defaults = critical memory, the Pause held (cycle 1, episode 1). */
const view = (o: Partial<MemoryGuardView> = {}): MemoryGuardView => ({ measured: true, availBytes: 2 * GIB, pause: 'held', pauseCycle: 1, episode: 1, admissionBytes: ADMISSION, criticalBytes: CRITICAL, ...o });
const recovered = (o: Partial<MemoryGuardView> = {}): MemoryGuardView => view({ availBytes: 7 * GIB, pause: 'none', ...o });

interface Rig {
  db: bus.BusDb;
  ws: Map<string, AutoWorkspace & { host?: { kind: string } }>;
  clock: { now: number };
  calls: { reprise: Array<{ run: string; actor: string | null; opts: unknown }>; logs: string[] };
  deps: MemoryPauseDeps;
  ledger: ReturnType<typeof newMemoryPauseLedger>;
  storeReady: boolean;
}

/** L (mission) ⊃ O (vague, own run) ⊃ w1 w2 ; L ⊃ X (vague) ⊃ x1 ; R (an unrelated root run) ⊃ r1. Workspace id == run id for orchestrators (the gates' walk). `sw` = the frozen switches per run. */
function rig(sw: { L?: BusSwitches; O?: BusSwitches; X?: BusSwitches; R?: BusSwitches } = {}, o: { childFirst?: boolean } = {}): Rig {
  fs.mkdirSync(ROOT, { recursive: true });
  const db = bus.openBus(path.join(ROOT, `b${n++}.sqlite`));
  const startL = () => busRuns.startRun(db, { id: 'L', kind: 'mission', coordinator: 'L' }, sw.L ?? ON);
  const startO = () => busRuns.startRun(db, { id: 'O', kind: 'vague', coordinator: 'O', parentRunId: 'L' }, sw.O ?? ON);
  // `childFirst`: the child's row precedes its parent's in the table, so a SELECT without ORDER BY returns the child first
  if (o.childFirst) {
    startO();
    startL();
  } else {
    startL();
    startO();
  }
  busRuns.startRun(db, { id: 'X', kind: 'vague', coordinator: 'X', parentRunId: 'L' }, sw.X ?? ON);
  busRuns.startRun(db, { id: 'R', kind: 'mission', coordinator: 'R' }, sw.R ?? OFF);
  const ws = new Map<string, AutoWorkspace & { host?: { kind: string } }>([
    ['L', { id: 'L', kind: 'orchestrator' }],
    ['O', { id: 'O', parentId: 'L', canOrchestrate: true }],
    ['X', { id: 'X', parentId: 'L', canOrchestrate: true }],
    ['w1', { id: 'w1', parentId: 'O' }],
    ['w2', { id: 'w2', parentId: 'O' }],
    ['x1', { id: 'x1', parentId: 'X' }],
    ['R', { id: 'R', kind: 'orchestrator' }],
    ['r1', { id: 'r1', parentId: 'R' }],
  ]);
  const r: Rig = { db, ws, clock: { now: T0 }, calls: { reprise: [], logs: [] }, deps: undefined as unknown as MemoryPauseDeps, ledger: newMemoryPauseLedger(), storeReady: true };
  const beginReprise: RepriseEntry = (d, run, actor, opts) => {
    r.calls.reprise.push({ run, actor, opts });
    return realBeginReprise(d, run, actor, opts);
  };
  const liveTree = { get: (id: string) => ws.get(id), ids: () => [...ws.values()].filter((w) => !w.archived).map((w) => w.id) };
  setLiveTreeSource(() => liveTree);
  r.deps = {
    getBus: () => {
      setLiveTreeSource(() => liveTree);
      return db;
    },
    getWorkspace: (id) => ws.get(id),
    listWorkspaces: () => [...ws.values()],
    beginReprise,
    now: () => r.clock.now,
    storeReady: () => r.storeReady,
    log: { info: (m) => void r.calls.logs.push(m), warn: (m) => void r.calls.logs.push(`WARN ${m}`) },
  };
  return r;
}

const runRow = (db: bus.BusDb, id: string): Record<string, unknown> => db.prepare('SELECT * FROM runs WHERE id = ?').get(id) as Record<string, unknown>;
const allRuns = (db: bus.BusDb): string => JSON.stringify(db.prepare('SELECT * FROM runs ORDER BY id').all());
const repriseRows = (db: bus.BusDb) => db.prepare("SELECT run_id, recipient, sender FROM messages WHERE kind = 'reprise' ORDER BY sequence").all() as Array<{ run_id: string; recipient: string; sender: string }>;
/** The trap finished for `run` (its Bilan rows exist and `pause_trap_at` is stamped): what a Reprise needs. */
function trapDone(r: Rig, run: string, members: string[], at = T0 + 1_000): void {
  const pausedAt = Number(runRow(r.db, run).paused_at);
  for (const wsId of members) insertBilan(r.db, { runId: run, wsId, pausedAt, activity: { surface: 'none' }, snapshotRef: null, dirty: false, killed: [], error: null });
  r.db.prepare('UPDATE runs SET pause_trap_at = ? WHERE id = ?').run(at, run);
}
const edge = (r: Rig, v: MemoryGuardView) => applyMemoryPause(r.deps, v, r.ledger, 'due');
const level = (r: Rig, v: MemoryGuardView) => applyMemoryPause(r.deps, v, r.ledger, 'level');
const lift = (r: Rig, v: MemoryGuardView = recovered()) => applyMemoryPause(r.deps, v, r.ledger, 'liftable');

// ─── IMPOSE ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

test('IMPOSE: critical memory ⇒ a Pause DURE with the motive memory on the TOPMOST pause-ON run (its Pause covers the runs below); the trap is owed; the origin chain is empty (nobody to spare)', () => {
  const r = rig();
  const res = edge(r, view({ availBytes: 2.5 * GIB, pauseCycle: 4, episode: 2 }));
  assert.equal(res.want, 'impose');
  assert.deepEqual(res.imposed, [{ runId: 'L', outcome: 'paused' }]);
  const l = runRow(r.db, 'L');
  assert.equal(l.paused_at, T0);
  assert.equal(l.paused_by, MEMORY_PAUSE_BY);
  assert.equal(l.pause_mode, 'hard');
  assert.equal(l.pause_deadline_at, null);
  assert.equal(l.pause_trap_at, null, 'the existing host trap is owed');
  assert.equal(l.resume_started_at, null);
  assert.deepEqual(parseMemoryPause(l.pause_auto as string, T0), { reason: 'memory', pauseCycle: 4, episode: 2, availBytes: 2.5 * GIB, thresholdBytes: CRITICAL });
  assert.deepEqual(readPauseOrigin(r.db, 'L', T0), [], 'a host-written pause records an EMPTY origin chain (the trap does not wait for a `run pause` process)');
  assert.equal(runRow(r.db, 'O').paused_at, null, 'the child run is covered by the parent, not written');
  assert.equal(runRow(r.db, 'X').paused_at, null);
  assert.ok(r.calls.logs.some((m) => /memory-pause: MemAvailable 2\.50.*run L is now PAUSED.*motive memory/.test(m)), `every action is logged with MemAvailable: ${r.calls.logs.join(' | ')}`);
});

test('IMPOSE switch OFF: a run whose frozen `pause` switch is OFF is NEVER written to — its row is byte-identical — whatever sits above or below it', () => {
  const r = rig();
  const before = JSON.stringify(runRow(r.db, 'R'));
  edge(r, view());
  assert.equal(JSON.stringify(runRow(r.db, 'R')), before, 'the pause-OFF root run is untouched');
  assert.deepEqual(memoryPauseCandidates(r.db, r.deps), ['L']);
  const all = rig({ L: OFF, O: OFF, X: OFF });
  const snapshot = allRuns(all.db);
  assert.deepEqual(edge(all, view()).imposed, []);
  assert.equal(allRuns(all.db), snapshot, 'no switch ON anywhere ⇒ not a single write');
});

test('IMPOSE topmost: a pause-OFF root over a pause-ON child — the child run is the topmost candidate (an OFF run is never paused, its ON subtree still is)', () => {
  const r = rig({ L: OFF });
  assert.deepEqual(memoryPauseCandidates(r.db, r.deps), ['O', 'X']);
  edge(r, view());
  assert.equal(runRow(r.db, 'L').paused_at, null, 'the OFF run');
  assert.equal(runRow(r.db, 'O').paused_by, MEMORY_PAUSE_BY);
  assert.equal(runRow(r.db, 'X').paused_by, MEMORY_PAUSE_BY);
});

test('IMPOSE fleet: a run with no live anchor workspace (deleted / archived) or a sandbox-hosted one is not a fleet to pause — nothing written', () => {
  const r = rig();
  r.ws.get('L')!.archived = true;
  assert.deepEqual(memoryPauseCandidates(r.db, r.deps), ['O', 'X'], 'an archived topmost run: the live ON runs below become the topmost');
  r.ws.get('O')!.host = { kind: 'sandbox' };
  r.ws.delete('X');
  assert.deepEqual(memoryPauseCandidates(r.db, r.deps), [], 'sandbox-hosted and vanished anchors are skipped');
  const snapshot = allRuns(r.db);
  assert.deepEqual(edge(r, view()).imposed, []);
  assert.equal(allRuns(r.db), snapshot);
});

test('IMPOSE manual: a MANUAL pause in effect is left EXACTLY as it is (row byte-identical), and the guard\'s lift never touches it after recovery', () => {
  const r = rig();
  assert.equal(setRunPause(r.db, 'L', true, null, 'hard', { human: true }), 'paused');
  const before = JSON.stringify(runRow(r.db, 'L'));
  assert.deepEqual(edge(r, view()).imposed, [{ runId: 'L', outcome: 'other-pause' }]);
  assert.equal(JSON.stringify(runRow(r.db, 'L')), before);
  trapDone(r, 'L', ['L']);
  const done = JSON.stringify(runRow(r.db, 'L'));
  assert.deepEqual(lift(r).lifted, [], 'a manual pause is not a memory pause: nothing to lift');
  assert.deepEqual(level(r, recovered()).lifted, []);
  assert.equal(JSON.stringify(runRow(r.db, 'L')), done, 'still paused after recovery');
  assert.equal(r.calls.reprise.length, 0, 'beginReprise was never called');
});

test('IMPOSE manual ENDED inside the cycle (review M1): a MANUAL pause is not ledgered as handled — once it ends (the coordinator resumed it) while memory is STILL critical, the run is memory-paused at the next read', () => {
  const r = rig();
  assert.equal(setRunPause(r.db, 'L', true, 'L'), 'paused'); // a coordinator's manual pause
  trapDone(r, 'L', ['L', 'O', 'w1']);
  assert.deepEqual(edge(r, view()).imposed, [{ runId: 'L', outcome: 'other-pause' }]);
  assert.equal(r.ledger.imposed.has('L'), false, 'only the guard\'s OWN Pause is ledgered');
  assert.deepEqual(level(r, view()).imposed, [{ runId: 'L', outcome: 'other-pause' }], 'still manual: left alone at every read');
  // the manual pause ends: Reprise + every member released ⇒ ACTIVE again (inside the same pauseCycle)
  assert.equal(realBeginReprise(r.db, 'L', 'L'), 'resuming');
  releaseMembers(r.db, 'L', 'human', 'all', T0 + 5_000, { human: true, ownRuns: ['L', 'O', 'X'] });
  assert.equal(readCarrierColumns(r.db, 'L')!.pausedAt, null, 'ACTIVE again');
  r.clock.now = T0 + 20_000;
  assert.deepEqual(level(r, view()).imposed, [{ runId: 'L', outcome: 'paused' }], 'critical memory: the fleet is not left running un-Paused for the rest of the cycle');
  assert.equal(runRow(r.db, 'L').paused_by, MEMORY_PAUSE_BY);
});

test('IMPOSE usage-limit: a pause the usage-limit motive wrote is left as it is and never lifted by memory', () => {
  const r = rig();
  const at = T0 - 5_000;
  r.db.prepare('UPDATE runs SET paused_at = ?, paused_by = ?, pause_mode = ?, pause_trap_at = ?, pause_auto = ? WHERE id = ?').run(at, PAUSE_AUTO_BY, 'hard', at + 1, encodePauseAuto({ reason: 'usage_limit', wsIds: ['w1'], accountIds: ['A'] }, at), 'L');
  const before = JSON.stringify(runRow(r.db, 'L'));
  assert.deepEqual(edge(r, view()).imposed, [{ runId: 'L', outcome: 'usage-pause' }]);
  assert.deepEqual(lift(r).lifted, []);
  assert.equal(JSON.stringify(runRow(r.db, 'L')), before);
});

test('IMPOSE usage-limit Reprise (review #2): the usage-limit evaluator Reprised the run (quota back) while memory is CRITICAL ⇒ back to PAUSED in a new epoch with the memory motive; and a usage-limit pause is re-looked-at every read (never ledgered as handled)', () => {
  const r = rig();
  const at = T0 - 5_000;
  r.db.prepare('UPDATE runs SET paused_at = ?, paused_by = ?, pause_mode = ?, pause_trap_at = ?, pause_auto = ? WHERE id = ?').run(at, PAUSE_AUTO_BY, 'hard', at + 1, encodePauseAuto({ reason: 'usage_limit', wsIds: ['w1'], accountIds: ['A'] }, at), 'L');
  insertBilan(r.db, { runId: 'L', wsId: 'L', pausedAt: at, activity: { surface: 'none' }, snapshotRef: null, dirty: false, killed: [], error: null });
  insertBilan(r.db, { runId: 'L', wsId: 'w1', pausedAt: at, activity: { surface: 'none' }, snapshotRef: null, dirty: false, killed: [], error: null });
  assert.deepEqual(edge(r, view()).imposed, [{ runId: 'L', outcome: 'usage-pause' }], 'in effect: left as it is');
  assert.equal(r.ledger.imposed.has('L'), false, 'not ledgered: its state moves without a human');
  // quota is back: the usage-limit evaluator begins its Reprise
  assert.equal(realBeginReprise(r.db, 'L', 'host', { host: true, reason: 'usage_limit' }), 'resuming');
  assert.notEqual(runRow(r.db, 'L').resume_started_at, null);
  r.clock.now += 20_000;
  assert.deepEqual(level(r, view()).imposed, [{ runId: 'L', outcome: 'repaused' }], 'the next read re-pauses it');
  const l = runRow(r.db, 'L');
  assert.equal(l.resume_started_at, null);
  assert.equal(l.paused_by, MEMORY_PAUSE_BY);
  assert.ok(Number(l.paused_at) > at, 'a new epoch');
  assert.equal(parseMemoryPause(l.pause_auto as string, Number(l.paused_at))?.pauseCycle, 1);
  assert.equal(parsePauseAuto(l.pause_auto as string, Number(l.paused_at)), null, 'no longer a usage-limit auto pause: the quota evaluator does not own it');
  assert.ok(r.calls.logs.some((m) => /RESUMING \(usage-limit Reprise\): PAUSED again/.test(m)), r.calls.logs.join(' | '));
});

test('IMPOSE already: a second pause_due on a run already under a memory Pause writes nothing (no second epoch, the first motive stays)', () => {
  const r = rig();
  edge(r, view({ pauseCycle: 1 }));
  const before = JSON.stringify(runRow(r.db, 'L'));
  r.clock.now += 60_000;
  assert.deepEqual(edge(r, view({ pauseCycle: 2 })).imposed, [{ runId: 'L', outcome: 'already' }]);
  assert.equal(JSON.stringify(runRow(r.db, 'L')), before);
});

test('IMPOSE wake OFF: an addressee run with its frozen `wake` switch OFF does NOT keep the host from freezing a critical fleet (a frozen host is worse than a stalled Reprise) — the lift holds + escalates instead', () => {
  const r = rig({ O: { ...ON, wake: false } });
  assert.deepEqual(edge(r, view()).imposed, [{ runId: 'L', outcome: 'paused' }]);
  assert.equal(runRow(r.db, 'L').paused_by, MEMORY_PAUSE_BY);
  assert.ok(!r.calls.logs.some((m) => /NOT paused/.test(m)));
  trapDone(r, 'L', ['L', 'O', 'w1']);
  assert.deepEqual(lift(r).lifted, [{ runId: 'L', action: 'wait', why: 'no-wake-addressee' }], 'at recovery the Reprise is HELD (told once), not started blind');
  assert.equal(runRow(r.db, 'L').resume_started_at, null);
});

test('IMPOSE fleet: a run whose anchor has NO live workspace below it (a lone idle coordinator) is not a fleet — nothing to free, nobody to wake at the Reprise', () => {
  const r = rig();
  for (const id of ['w1', 'w2', 'x1', 'O', 'X']) r.ws.get(id)!.archived = true;
  assert.deepEqual(memoryPauseCandidates(r.db, r.deps), [], 'L has only archived workspaces below it');
  const snapshot = allRuns(r.db);
  assert.deepEqual(edge(r, view()).imposed, []);
  assert.equal(allRuns(r.db), snapshot);
  r.ws.get('O')!.archived = false;
  assert.deepEqual(memoryPauseCandidates(r.db, r.deps), ['L'], 'one live workspace below makes it a fleet again');
  r.ws.get('O')!.host = { kind: 'sandbox' };
  assert.deepEqual(memoryPauseCandidates(r.db, r.deps), [], 'a sandbox-hosted member is not a local fleet member');
});

test('IMPOSE unknown ≠ none: an unmeasured snapshot does nothing; neither does an unloaded store', () => {
  const r = rig();
  const before = allRuns(r.db);
  assert.deepEqual(edge(r, view({ measured: false })), { want: 'none', imposed: [], lifted: [] });
  assert.deepEqual(edge(r, view({ availBytes: null })), { want: 'none', imposed: [], lifted: [] });
  r.storeReady = false;
  assert.deepEqual(edge(r, view()).imposed, []);
  assert.deepEqual(imposeMemoryPause(r.deps, { availBytes: 1, pauseCycle: 1, episode: 1, criticalBytes: CRITICAL }, r.ledger), []);
  assert.equal(allRuns(r.db), before);
});

test('IMPOSE a run whose evaluation throws is retried at the next read and never starves the other runs', () => {
  const r = rig({ L: OFF });
  let boom = true;
  const deps: MemoryPauseDeps = {
    ...r.deps,
    now: () => {
      if (boom) {
        boom = false;
        throw new Error('clock hiccup');
      }
      return r.clock.now;
    },
  };
  const first = applyMemoryPause(deps, view(), r.ledger, 'due').imposed;
  assert.deepEqual(first.map((e) => [e.runId, e.outcome]), [['X', 'paused']], 'O threw, X was still paused');
  assert.equal(runRow(r.db, 'O').paused_at, null);
  assert.deepEqual(applyMemoryPause(deps, view(), r.ledger, 'level').imposed.map((e) => [e.runId, e.outcome]), [['O', 'paused']], 'the failed run is evaluated again at the next read');
});

test('IMPOSE level read (the tick / the boot reconcile): the Pause is imposed from the snapshot alone, and a run it already handled in this cycle is NOT fought after a human lifted it', () => {
  const r = rig();
  assert.deepEqual(level(r, view()).imposed, [{ runId: 'L', outcome: 'paused' }]);
  // the human lifts by hand while memory stays critical
  r.db.prepare('UPDATE runs SET paused_at = NULL, paused_by = NULL, pause_mode = NULL, pause_trap_at = NULL, resume_started_at = NULL, pause_auto = NULL WHERE id = ?').run('L');
  r.clock.now += 20_000;
  assert.deepEqual(level(r, view()).imposed, [], 'same cycle: not re-imposed every tick');
  assert.equal(runRow(r.db, 'L').paused_at, null);
  assert.deepEqual(edge(r, view({ pauseCycle: 2 })).imposed, [{ runId: 'L', outcome: 'paused' }], 'a NEW pause_due edge always evaluates');
});

test('IMPOSE level read after an app restart: the ledger is empty, the snapshot says held ⇒ imposed; a run created during the crisis is paused at the next read', () => {
  const r = rig();
  level(r, view());
  const fresh = newMemoryPauseLedger(); // a restarted host
  assert.deepEqual(applyMemoryPause(r.deps, view(), fresh, 'level').imposed, [{ runId: 'L', outcome: 'already' }], 'the persisted memory Pause is recognised, not duplicated');
  busRuns.startRun(r.db, { id: 'N', kind: 'mission', coordinator: 'N' }, ON);
  r.ws.set('N', { id: 'N', kind: 'orchestrator' });
  r.ws.set('n1', { id: 'n1', parentId: 'N' }); // a fleet: a worker below it
  assert.deepEqual(applyMemoryPause(r.deps, view(), fresh, 'level').imposed.map((e) => [e.runId, e.outcome]), [['N', 'paused']]);
});

test('IMPOSE re-pause: memory falls again while the memory Pause is RESUMING ⇒ back to PAUSED in a NEW epoch (the trap runs again), the new cycle recorded', () => {
  const r = rig();
  edge(r, view({ pauseCycle: 1 }));
  trapDone(r, 'L', ['L', 'O', 'w1']);
  assert.equal(lift(r).lifted[0].outcome, 'resuming');
  assert.notEqual(runRow(r.db, 'L').resume_started_at, null);
  r.clock.now += 120_000;
  assert.deepEqual(edge(r, view({ pauseCycle: 2, episode: 1 })).imposed, [{ runId: 'L', outcome: 'repaused' }]);
  const l = runRow(r.db, 'L');
  assert.equal(l.resume_started_at, null);
  assert.equal(l.pause_trap_at, null, 'the trap is owed again');
  assert.ok(Number(l.paused_at) > T0, 'a new epoch');
  assert.equal(l.paused_by, MEMORY_PAUSE_BY);
  assert.equal(parseMemoryPause(l.pause_auto as string, Number(l.paused_at))?.pauseCycle, 2);
  assert.deepEqual(readPauseOrigin(r.db, 'L', Number(l.paused_at)), [], 'the new epoch records an EMPTY origin chain too (nobody to spare, no 3 s wait for a `run pause` process)');
});

test('IMPOSE re-pause: a takeover landing between the classification and the re-pause (inside its transaction) wins — the Pause is not re-written over the human\'s', () => {
  const r = rig();
  edge(r, view({ pauseCycle: 1 }));
  trapDone(r, 'L', ['L', 'O', 'w1']);
  assert.equal(lift(r).lifted[0].outcome, 'resuming');
  const raw = r.db;
  let hooked = false;
  // the first transaction the re-pause opens is preceded by a coordinator re-asserting the pause (pause_auto cleared: a MANUAL Reprise in progress now)
  const proxied = new Proxy(raw, {
    get(t, k) {
      const v = Reflect.get(t, k) as unknown;
      if (k === 'transaction' && typeof v === 'function') {
        return (fn: never) => {
          if (!hooked) {
            hooked = true;
            raw.prepare('UPDATE runs SET pause_auto = NULL WHERE id = ?').run('L');
          }
          return (v as (f: never) => unknown).call(t, fn);
        };
      }
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(t) : v;
    },
  }) as unknown as bus.BusDb;
  const deps: MemoryPauseDeps = { ...r.deps, getBus: () => { setLiveTreeSource(() => ({ get: (id: string) => r.ws.get(id), ids: () => [...r.ws.keys()] })); return proxied; } };
  const before = JSON.stringify({ ...runRow(raw, 'L'), pause_auto: null });
  assert.deepEqual(imposeMemoryPause(deps, { availBytes: 2 * GIB, pauseCycle: 2, episode: 1, criticalBytes: CRITICAL }, newMemoryPauseLedger()), [{ runId: 'L', outcome: 'other-pause' }]);
  assert.equal(JSON.stringify(runRow(raw, 'L')), before, 'the human\'s Reprise is untouched: no new epoch, still RESUMING');
});

test('IMPOSE re-pause (review m2): a MANUAL Reprise of a memory Pause takes the motive away — the next pause_due never re-pauses it; the HOST\'s own Reprise keeps it', () => {
  const r = rig();
  edge(r, view({ pauseCycle: 1 }));
  trapDone(r, 'L', ['L', 'O', 'w1']);
  assert.equal(realBeginReprise(r.db, 'L', 'L'), 'resuming'); // a coordinator resumes the memory Pause by hand
  const l = runRow(r.db, 'L');
  assert.equal(l.pause_auto, null, 'the memory motive did not survive a manual Reprise');
  assert.notEqual(l.resume_started_at, null);
  const before = JSON.stringify(l);
  assert.deepEqual(edge(r, view({ pauseCycle: 2 })).imposed, [{ runId: 'L', outcome: 'other-pause' }]);
  assert.equal(JSON.stringify(runRow(r.db, 'L')), before, 'the human\'s Reprise is not re-paused mid-way');
  // …whereas the guard\'s own Reprise keeps its motive (it is the guard\'s to re-pause)
  const h = rig();
  edge(h, view({ pauseCycle: 1 }));
  trapDone(h, 'L', ['L', 'O', 'w1']);
  assert.equal(lift(h).lifted[0].outcome, 'resuming');
  const hr = runRow(h.db, 'L');
  assert.notEqual(parseMemoryPause(hr.pause_auto as string, Number(hr.paused_at)), null, 'a host Reprise keeps the memory motive');
});

test('IMPOSE re-pause: a MANUAL (human) Reprise in progress is not ours — a memory pause_due leaves it alone', () => {
  const r = rig();
  assert.equal(setRunPause(r.db, 'L', true, 'L'), 'paused'); // a coordinator's own (manual) pause
  trapDone(r, 'L', ['L', 'O', 'w1']);
  assert.equal(realBeginReprise(r.db, 'L', 'L'), 'resuming'); // a manual Reprise: only the coordinators are released, the run stays RESUMING
  assert.notEqual(runRow(r.db, 'L').resume_started_at, null);
  const before = JSON.stringify(runRow(r.db, 'L'));
  assert.deepEqual(edge(r, view()).imposed, [{ runId: 'L', outcome: 'other-pause' }]);
  assert.equal(JSON.stringify(runRow(r.db, 'L')), before);
});

// ─── LIFT ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

test('LIFT: memory back above the Admission threshold ⇒ the automatic Reprise (host, motive memory) — coordinators first: every coordinator gets its `reprise` row, workers stay blocked until their OPS releases them', () => {
  const r = rig();
  edge(r, view());
  trapDone(r, 'L', ['L', 'O', 'w1']);
  assert.deepEqual(memoryPausedRuns(r.db).map((p) => p.runId), ['L']);
  const res = lift(r, recovered({ availBytes: 7 * GIB }));
  assert.deepEqual(res.lifted, [{ runId: 'L', action: 'reprise', outcome: 'resuming' }]);
  assert.deepEqual(r.calls.reprise, [{ run: 'L', actor: 'host', opts: { host: true, reason: 'memory' } }]);
  assert.notEqual(runRow(r.db, 'L').resume_started_at, null, 'RESUMING');
  const rows = repriseRows(r.db);
  assert.ok(rows.some((x) => x.recipient === 'L') && rows.some((x) => x.recipient === 'O'), `the coordinators got their reprise row: ${JSON.stringify(rows)}`);
  assert.ok(!rows.some((x) => x.recipient === 'w1'), 'a worker is NOT released by the host (only by its coordinator)');
  assert.ok(r.calls.logs.some((m) => /memory-pause: MemAvailable 7\.00.*Reprise started/.test(m)), r.calls.logs.join(' | '));
  assert.deepEqual(memoryPausedRuns(r.db), [], 'a resuming run is no longer "memory-paused"');
});

test('LIFT level: only strictly ABOVE the Admission threshold — between critical and Admission, and exactly AT it, the Pause stays', () => {
  const r = rig();
  edge(r, view());
  trapDone(r, 'L', ['L']);
  assert.deepEqual(level(r, recovered({ availBytes: 4 * GIB })).lifted, [], 'between the thresholds');
  assert.deepEqual(level(r, recovered({ availBytes: ADMISSION })).lifted, [], 'exactly at the Admission threshold');
  assert.equal(runRow(r.db, 'L').resume_started_at, null);
  assert.equal(level(r, recovered({ availBytes: ADMISSION + 1 })).lifted[0].action, 'reprise');
});

test('LIFT after an app restart: the guard state is gone (pause none) but the persisted memory Pause is not — the LEVEL read lifts it above Admission, and keeps it below', () => {
  const r = rig();
  edge(r, view());
  trapDone(r, 'L', ['L']);
  const fresh = newMemoryPauseLedger();
  assert.deepEqual(applyMemoryPause(r.deps, recovered({ availBytes: 4 * GIB, pauseCycle: 0, episode: 1 }), fresh, 'level').lifted, [], 'a restart in the middle of an episode does not lift early');
  assert.equal(applyMemoryPause(r.deps, recovered({ availBytes: 8 * GIB, pauseCycle: 0 }), fresh, 'level').lifted[0].outcome, 'resuming');
});

test('LIFT waits for the TRAP (the Bilans are the Consigne\'s only source) — until it is overdue (never frozen for ever)', () => {
  const r = rig();
  edge(r, view());
  assert.deepEqual(lift(r).lifted, [{ runId: 'L', action: 'wait', why: 'trap-pending' }]);
  assert.equal(runRow(r.db, 'L').resume_started_at, null);
  r.clock.now = T0 + 10 * 60_000 - 1;
  assert.equal(lift(r).lifted[0].action, 'wait', 'one ms before the bound');
  r.clock.now = T0 + 10 * 60_000;
  assert.equal(lift(r).lifted[0].action, 'reprise');
});

test('LIFT waits for an ANCESTOR Pause that still stands (a child waits for every ancestor), then goes', () => {
  const r = rig({ L: ON, O: ON });
  // O is memory-paused on its own (its ancestor L carries pause OFF at that moment), then L is paused by hand
  r.db.prepare('UPDATE run_flags SET flags = ? WHERE run_id = ?').run(JSON.stringify({ ...DEFAULT_BUS_SWITCHES, wake: true }), 'L');
  edge(r, view());
  assert.equal(runRow(r.db, 'O').paused_by, MEMORY_PAUSE_BY);
  trapDone(r, 'O', ['O', 'w1']);
  r.db.prepare('UPDATE run_flags SET flags = ? WHERE run_id = ?').run(JSON.stringify({ ...DEFAULT_BUS_SWITCHES, pause: true, wake: true }), 'L');
  assert.equal(setRunPause(r.db, 'L', true, null, 'hard', { human: true }), 'paused');
  assert.deepEqual(lift(r).lifted.filter((x) => x.runId === 'O'), [{ runId: 'O', action: 'wait', why: 'ancestor-paused' }]);
  trapDone(r, 'L', ['L']);
  assert.equal(realBeginReprise(r.db, 'L', null, { human: true }), 'resuming');
  assert.equal(lift(r).lifted.find((x) => x.runId === 'O')?.action, 'reprise');
});

test('LIFT human takeover: a human (or a coordinator) re-asserting the Pause during the episode makes it MANUAL (`pause_auto` cleared) — never lifted by the guard after recovery', () => {
  const r = rig();
  edge(r, view());
  trapDone(r, 'L', ['L']);
  setRunPause(r.db, 'L', true, 'L'); // the pause is already in force: whoever re-asserts it takes it over
  assert.equal(runRow(r.db, 'L').pause_auto, null, 'now manual');
  assert.deepEqual(lift(r).lifted, []);
  assert.equal(runRow(r.db, 'L').resume_started_at, null, 'still paused after recovery');
  assert.equal(r.calls.reprise.length, 0);
});

test('LIFT stale motive: a memory column left over from an OLDER epoch, a switch turned OFF, and a corrupt value all read as "not ours" — nothing lifted', () => {
  const r = rig();
  r.db.prepare('UPDATE runs SET paused_at = ?, paused_by = ?, pause_mode = ?, pause_trap_at = ?, pause_auto = ? WHERE id = ?').run(T0, 'human', 'hard', T0 + 1, encodeMemoryPause({ reason: 'memory', pauseCycle: 1, episode: 1, availBytes: 1, thresholdBytes: CRITICAL }, T0 - 99), 'L');
  assert.deepEqual(memoryPausedRuns(r.db), [], 'another epoch');
  r.db.prepare('UPDATE runs SET pause_auto = ? WHERE id = ?').run('{corrupt', 'L');
  assert.deepEqual(memoryPausedRuns(r.db), []);
  r.db.prepare('UPDATE runs SET pause_auto = ? WHERE id = ?').run(encodeMemoryPause({ reason: 'memory', pauseCycle: 1, episode: 1, availBytes: 1, thresholdBytes: CRITICAL }, T0), 'L');
  assert.equal(memoryPausedRuns(r.db).length, 1);
  r.db.prepare('UPDATE run_flags SET flags = ? WHERE run_id = ?').run(JSON.stringify({ ...DEFAULT_BUS_SWITCHES, wake: true }), 'L');
  assert.deepEqual(memoryPausedRuns(r.db), [], 'the frozen switch is OFF: a stale column is inert');
});

test('LIFT held: a Reprise that could not wake an addressee (wake OFF) is HELD — the run stays PAUSED, the LEAD is told ONCE, the hold is recorded with the memory motive — and ends when the run is gone', () => {
  const r = rig();
  edge(r, view());
  trapDone(r, 'L', ['L', 'O', 'w1']); // a worker is in the roster: the run stays RESUMING after the Reprise (the hold must be gone while it does)
  // a wake-OFF run appears below after the pause (unknown at pause time)
  busRuns.startRun(r.db, { id: 'Z', kind: 'vague', coordinator: 'Z', parentRunId: 'L' }, { ...DEFAULT_BUS_SWITCHES, pause: true });
  r.ws.set('Z', { id: 'Z', parentId: 'L', canOrchestrate: true });
  const res = lift(r);
  assert.deepEqual(res.lifted, [{ runId: 'L', action: 'wait', why: 'no-wake-addressee' }]);
  const l = runRow(r.db, 'L');
  assert.equal(l.resume_started_at, null, 'stays PAUSED');
  const held = parseAutoHeld(l.pause_auto as string, Number(l.paused_at));
  assert.equal(held?.motive, 'memory');
  assert.deepEqual(held?.addressees, ['Z@Z']);
  assert.equal(r.calls.reprise.length, 0);
  const escalations = r.db.prepare("SELECT body FROM messages WHERE kind = 'escalation'").all() as Array<{ body: string }>;
  const gates = r.db.prepare('SELECT COUNT(*) AS c FROM decision_gates').get() as { c: number };
  assert.equal(escalations.length + gates.c, 1, 'told exactly once');
  if (escalations.length) assert.match(escalations[0].body, /Memory-Pause Reprise HELD.*memory is back \(MemAvailable 7\.00/);
  lift(r);
  const told = () => (r.db.prepare("SELECT COUNT(*) AS c FROM messages WHERE kind = 'escalation'").get() as { c: number }).c + (r.db.prepare('SELECT COUNT(*) AS c FROM decision_gates').get() as { c: number }).c;
  assert.equal(told(), 1, 'the next read does not tell again');
  // ANOTHER wake-OFF run joins: a different addressee set is told again (and the record follows it)
  busRuns.startRun(r.db, { id: 'Y', kind: 'vague', coordinator: 'Y', parentRunId: 'L' }, { ...DEFAULT_BUS_SWITCHES, pause: true });
  r.ws.set('Y', { id: 'Y', parentId: 'L', canOrchestrate: true });
  lift(r);
  assert.equal(told(), 2, 'a changed addressee set escalates again');
  const l2 = runRow(r.db, 'L');
  assert.deepEqual(parseAutoHeld(l2.pause_auto as string, Number(l2.paused_at))?.addressees, ['Y@Y', 'Z@Z']);
  r.ws.delete('Y');
  // the offending run is detached: the next read Reprises (and the hold ends with it)
  r.ws.delete('Z');
  assert.equal(lift(r).lifted[0].action, 'reprise');
  const after = runRow(r.db, 'L');
  assert.notEqual(after.resume_started_at, null, 'RESUMING (a worker is still blocked)');
  assert.equal(parseAutoHeld(after.pause_auto as string, Number(after.paused_at)), null, 'the hold ends with the Reprise (`run status` must not say HELD while RESUMING)');
});

test('LIFT order: nested memory Pauses are lifted ANCESTOR-first in one read (the child would otherwise wait a whole read for its parent) — whatever the table order', () => {
  const r = rig({ L: OFF }, { childFirst: true });
  edge(r, view({ pauseCycle: 1 })); // L carries pause OFF: O and X are the topmost candidates and are memory-paused
  assert.deepEqual(memoryPausedRuns(r.db).map((p) => p.runId).sort(), ['O', 'X']);
  r.db.prepare('UPDATE run_flags SET flags = ? WHERE run_id = ?').run(JSON.stringify({ ...DEFAULT_BUS_SWITCHES, pause: true, wake: true }), 'L'); // L later opts in (frozen at ITS creation in real life; here: a second tree shape)
  r.clock.now += 30_000;
  edge(r, view({ pauseCycle: 2 }));
  assert.equal(runRow(r.db, 'L').paused_by, MEMORY_PAUSE_BY);
  for (const run of ['L', 'O', 'X']) trapDone(r, run, [run], T0 + 90_000);
  const out = lift(r).lifted;
  assert.deepEqual(out.map((e) => [e.runId, e.action]), [['L', 'reprise'], ['O', 'reprise'], ['X', 'reprise']], 'L first; its Reprise has begun when O and X are looked at');
});

test('LIFT changed meanwhile: a pause that a human took over between the SELECT and the Reprise is not Reprised', () => {
  const r = rig();
  edge(r, view());
  trapDone(r, 'L', ['L']);
  let first = true;
  const deps: MemoryPauseDeps = {
    ...r.deps,
    getWorkspace: (id) => {
      if (first && id === 'L') {
        first = false;
        r.db.prepare('UPDATE runs SET pause_auto = NULL WHERE id = ?').run('L'); // a human took it over while the host was deciding
      }
      return r.ws.get(id);
    },
  };
  const out = liftMemoryPause(deps, 7 * GIB);
  assert.deepEqual(out, [{ runId: 'L', action: 'wait', why: 'changed-meanwhile' }]);
  assert.equal(r.calls.reprise.length, 0);
});

test('LIFT unknown ≠ none: an unloaded store (the live tree is unknown) Reprises nothing, even above the Admission threshold', () => {
  const r = rig();
  edge(r, view());
  trapDone(r, 'L', ['L']);
  r.storeReady = false;
  assert.deepEqual(lift(r).lifted, []);
  assert.deepEqual(level(r, recovered()).lifted, []);
  assert.equal(r.calls.reprise.length, 0);
  r.storeReady = true;
  assert.equal(lift(r).lifted[0].action, 'reprise');
});

test('LIFT changed between the check and the Reprise: the re-read inside the Reprise\'s own transaction wins — a takeover landing in that window is not Reprised', () => {
  const r = rig();
  edge(r, view());
  trapDone(r, 'L', ['L']);
  let calls = 0;
  const deps: MemoryPauseDeps = {
    ...r.deps,
    getWorkspace: (id) => {
      // the 2nd lookup of L is the wake-addressee read — AFTER the pre-check, BEFORE the Reprise
      if (id === 'L' && ++calls === 2) r.db.prepare('UPDATE runs SET pause_auto = NULL WHERE id = ?').run('L');
      return r.ws.get(id);
    },
  };
  assert.deepEqual(liftMemoryPause(deps, 7 * GIB), [{ runId: 'L', action: 'wait', why: 'changed-meanwhile' }]);
  assert.equal(r.calls.reprise.length, 0, 'beginReprise was never called');
});

test('LIFT a throwing Reprise is retried at the next read and never starves the other runs', () => {
  const r = rig({ L: OFF });
  edge(r, view());
  trapDone(r, 'O', ['O', 'w1']);
  trapDone(r, 'X', ['X', 'x1']);
  let boom = true;
  const deps: MemoryPauseDeps = {
    ...r.deps,
    beginReprise: (db, run, actor, opts) => {
      if (boom && run === 'O') throw new Error('bus hiccup');
      return r.deps.beginReprise(db, run, actor, opts);
    },
  };
  const out = liftMemoryPause(deps, 7 * GIB);
  assert.deepEqual(out.map((e) => [e.runId, e.action, e.why ?? e.outcome]), [['O', 'wait', 'reprise-threw'], ['X', 'reprise', 'resuming']]);
  boom = false;
  assert.equal(liftMemoryPause(deps, 7 * GIB).find((e) => e.runId === 'O')?.outcome, 'resuming');
});

// ─── interplay with the usage-limit motive ─────────────────────────────────────────────────────────────────────────────────────────────

/** The usage-limit evaluator's deps over this rig: quota is back (a fresh usable reading), nothing else moves. */
function usageDepsOf(r: Rig, over: Partial<PauseAutoDeps> = {}): PauseAutoDeps {
  return {
    getBus: r.deps.getBus,
    getWorkspace: r.deps.getWorkspace,
    knownAccountIds: () => new Set<string>(),
    readingFor: () => ({ fetchedAt: T0 + 10, data: { fiveHour: { utilization: 1, resetsAt: new Date(T0 + 3_600_000).toISOString() }, sevenDay: { utilization: 1, resetsAt: new Date(T0 + 86_400_000).toISOString() } } }),
    accountChangedAt: () => null,
    noteAccountChanged: () => {},
    forceRefresh: async () => {},
    requestRefresh: () => {},
    beginReprise: r.deps.beginReprise,
    repriseStreak: () => 0,
    noteReprise: () => {},
    resetStreak: () => {},
    limitMarkedWorkspaces: () => [],
    clearLimitMarker: async () => {},
    repriseCursor: { get: () => 0, set: () => {} },
    once: () => true,
    now: () => T0 + 100_000,
    log: r.deps.log,
    ...over,
  } as unknown as PauseAutoDeps;
}

test('USAGE motive: the quota evaluator never selects (nor Reprises) a memory Pause, and a usage-limit stop under a memory Pause leaves it exactly as it is', async () => {
  const r = rig();
  edge(r, view());
  trapDone(r, 'L', ['L']);
  assert.deepEqual(autoPausedRuns(r.db), [], 'a memory pause is not a usage-limit auto pause');
  const usageDeps = usageDepsOf(r);
  assert.deepEqual(await evaluateAutoPaused(usageDeps), []);
  const before = JSON.stringify(runRow(r.db, 'L'));
  r.ws.get('w1')!.lastStopReason = 'usage_limit';
  assert.equal(autoPauseOnLimit(usageDeps, 'w1'), 'manual-pause', 'untouched: the usage motive does not adopt a memory pause');
  assert.equal(JSON.stringify(runRow(r.db, 'L')), before);
  assert.equal(parsePauseAuto(runRow(r.db, 'L').pause_auto as string, T0), null);
});

test('RELEASE: after the automatic Reprise the run goes back to ACTIVE once every member is released — the memory motive leaves nothing behind', () => {
  const r = rig();
  edge(r, view());
  trapDone(r, 'L', ['L', 'O', 'w1']);
  lift(r);
  releaseMembers(r.db, 'L', 'human', 'all', T0 + 5_000, { human: true, ownRuns: ['L', 'O', 'X'] });
  const l = runRow(r.db, 'L');
  assert.equal(l.paused_at, null);
  assert.equal(l.pause_auto, null);
  assert.deepEqual(memoryPauseCandidates(r.db, r.deps), ['L'], 'the run is a candidate for the NEXT cycle');
});

test('USAGE Reprise defers while the memory Pause is in effect (review #2): the quota is back but the host is critical — the coordinators are not woken into a host about to be re-paused; it goes once the guard lets go', async () => {
  const r = rig();
  const at = T0 - 5_000;
  r.db.prepare('UPDATE runs SET paused_at = ?, paused_by = ?, pause_mode = ?, pause_trap_at = ?, pause_auto = ? WHERE id = ?').run(at, PAUSE_AUTO_BY, 'hard', at + 1, encodePauseAuto({ reason: 'usage_limit', wsIds: ['w1'], accountIds: [null] }, at), 'L');
  for (const wsId of ['L', 'O', 'w1']) insertBilan(r.db, { runId: 'L', wsId, pausedAt: at, activity: { surface: 'none' }, snapshotRef: null, dirty: false, killed: [], error: null });
  let held = true;
  const deps = usageDepsOf(r, { memoryPauseHeld: () => held });
  assert.deepEqual(await evaluateAutoPaused(deps), [{ runId: 'L', action: 'wait', why: 'memory-pause-held' }]);
  assert.equal(runRow(r.db, 'L').resume_started_at, null);
  assert.equal(r.calls.reprise.length, 0);
  held = false;
  assert.equal((await evaluateAutoPaused(deps))[0].action, 'reprise', 'without the guard\'s memory Pause the quota Reprise goes as before');
});
