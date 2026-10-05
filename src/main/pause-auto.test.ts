import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as bus from './bus.ts';
import * as busRuns from './bus-runs.ts';
import {
  afterAccountChange,
  autoPauseOnLimit,
  autoPausedRuns,
  clearRepriseDeliveredMarkers,
  wakeOffAddressees,
  evaluateAutoPaused,
  type AutoWorkspace,
  type PauseAutoDeps,
} from './pause-auto.ts';
import { readPauseOrigin, insertBilan } from './bus-pause-records.ts';
import { beginReprise as realBeginReprise, setRunPause } from './bus-pause.ts';
import { releaseMembers, repriseAddressees, setLiveTreeSource } from './pause-reprise.ts';
import { DEFAULT_BUS_SWITCHES, type BusSwitches } from '../shared/bus-switches.ts';
import { PAUSE_AUTO_BY, REPRISE_STREAK_WINDOW_MS, RESET_GRACE_MS, TRAP_WAIT_MAX_MS, encodePauseAuto, parsePauseAuto, repriseBackoffMs, type UsageReading } from '../shared/pause-auto.ts';
import type { RepriseEntry } from '../shared/pause-lifecycle.ts';
import type { UsageWindows } from '../shared/accounts.ts';

// #256 (ledger #276 D6) — auto Pause on a usage-limit stop + auto Reprise when the quota is back, over a REAL bus.sqlite under the real
// home (btrfs — never /tmp, never the live bus), fake store/usage seams. Named arms are what scripts/pause-auto/mutate-unit.mjs reddens.

const ROOT = path.join(os.homedir(), '.cache', `pause-auto-bus-${process.pid}`);
const ON: BusSwitches = { ...DEFAULT_BUS_SWITCHES, pause: true, wake: true }; // the auto Pause needs BOTH frozen opt-ins (a Reprise must be able to wake someone)
const OFF: BusSwitches = { ...DEFAULT_BUS_SWITCHES, wake: true }; // pause switch OFF, wake ON (a run of the subtree with wake OFF would stop the auto Pause: N1)
const T0 = 1_800_000_000_000;
let n = 0;
test.after(() => fs.rmSync(ROOT, { recursive: true, force: true }));

const iso = (ms: number): string => new Date(ms).toISOString();
const usable: UsageWindows = { fiveHour: { utilization: 10, resetsAt: iso(T0 + 3_600_000) }, sevenDay: { utilization: 20, resetsAt: iso(T0 + 86_400_000) } };
const limited = (until: number): UsageWindows => ({ fiveHour: { utilization: 100, resetsAt: iso(until) }, sevenDay: { utilization: 20, resetsAt: iso(T0 + 86_400_000) } });

interface Rig {
  db: bus.BusDb;
  ws: Map<string, AutoWorkspace>;
  accounts: Set<string>;
  readings: Map<string, UsageReading>; // key: account id or 'default'
  changed: Map<string, number>;
  clock: { now: number };
  calls: { reprise: Array<{ run: string; actor: string | null; opts: unknown }>; force: Array<Array<string | null>>; refresh: Array<Array<string | null>>; logs: string[] };
  reprises: Map<string, number[]>; // the flap guard's streak store (the host keeps the same shape)
  deps: PauseAutoDeps;
  /** what `forceRefresh` installs for an account: a reading fetched "now" */
  onForce: (ids: Array<string | null>) => void;
  storeReady: boolean;
  markerCleared: string[];
  cursor: number;
}

/** L (lead) ⊃ O (ops, own run) ⊃ w1 w2 ; L ⊃ X (ops, own run) ⊃ x1. Workspace id == run id for orchestrators (the gates' walk). */
function rig(sw: { L?: BusSwitches; O?: BusSwitches; X?: BusSwitches } = {}, o: { childFirst?: boolean } = {}): Rig {
  fs.mkdirSync(ROOT, { recursive: true });
  const db = bus.openBus(path.join(ROOT, `b${n++}.sqlite`));
  const startL = () => busRuns.startRun(db, { id: 'L', kind: 'mission', coordinator: 'L' }, sw.L ?? ON);
  const startO = () => busRuns.startRun(db, { id: 'O', kind: 'vague', coordinator: 'O', parentRunId: 'L' }, sw.O ?? ON);
  // `childFirst`: the child's row precedes its parent's in the table, so a SELECT without ORDER BY returns the child first
  if (o.childFirst) { startO(); startL(); } else { startL(); startO(); }
  busRuns.startRun(db, { id: 'X', kind: 'vague', coordinator: 'X', parentRunId: 'L' }, sw.X ?? ON);
  const ws = new Map<string, AutoWorkspace>([
    ['L', { id: 'L', kind: 'orchestrator' }],
    ['O', { id: 'O', parentId: 'L', canOrchestrate: true }],
    ['X', { id: 'X', parentId: 'L', canOrchestrate: true }],
    ['w1', { id: 'w1', parentId: 'O' }],
    ['w2', { id: 'w2', parentId: 'O' }],
    ['x1', { id: 'x1', parentId: 'X' }],
  ]);
  const r: Rig = {
    db, ws, accounts: new Set(['A', 'B']), readings: new Map(), changed: new Map(), clock: { now: T0 },
    calls: { reprise: [], force: [], refresh: [], logs: [] },
    reprises: new Map(),
    deps: undefined as unknown as PauseAutoDeps,
    onForce: () => {},
    storeReady: true,
    markerCleared: [],
    cursor: 0,
  };
  const beginReprise: RepriseEntry = (d, run, actor, opts) => {
    r.calls.reprise.push({ run, actor, opts });
    return realBeginReprise(d, run, actor, opts);
  };
  // the host registers the LIVE workspace tree for #255 (pause-trap-host.ts): the Reprise's coordinators — and #256's wake guard — read it. One module-global ⇒ re-registered at every bus read of THIS rig.
  const liveTree = { get: (id: string) => ws.get(id), ids: () => [...ws.values()].filter((w) => !w.archived).map((w) => w.id) };
  setLiveTreeSource(() => liveTree);
  const onceKeys = new Set<string>();
  r.deps = {
    getBus: () => { setLiveTreeSource(() => liveTree); return db; },
    once: (k) => (onceKeys.has(k) ? false : (onceKeys.add(k), true)),
    getWorkspace: (id) => ws.get(id),
    knownAccountIds: () => r.accounts,
    readingFor: (a) => r.readings.get(a ?? 'default') ?? null,
    accountChangedAt: (id) => r.changed.get(id) ?? null,
    noteAccountChanged: (id, at) => void r.changed.set(id, at),
    forceRefresh: async (ids) => {
      r.calls.force.push(ids);
      r.onForce(ids);
    },
    requestRefresh: (ids) => void r.calls.refresh.push(ids),
    beginReprise,
    repriseStreak: (run, now) => (r.reprises.get(run) ?? []).filter((t) => now - t < REPRISE_STREAK_WINDOW_MS).length,
    noteReprise: (run, now) => void r.reprises.set(run, [...(r.reprises.get(run) ?? []), now]),
    resetStreak: (run) => void r.reprises.delete(run),
    now: () => r.clock.now,
    storeReady: () => r.storeReady,
    limitMarkedWorkspaces: () => [...ws.values()].filter((w) => !w.archived && w.lastStopReason === 'usage_limit').map((w) => ({ id: w.id, markedAt: w.lastStopReasonAt ?? 0 })),
    clearLimitMarker: async (id) => {
      r.markerCleared.push(id);
      const w = ws.get(id);
      if (w) { w.lastStopReason = undefined; w.lastStopReasonAt = undefined; w.usageLimitResetsAt = undefined; }
    },
    repriseCursor: { get: () => r.cursor, set: (n) => void (r.cursor = n) },
    log: { info: (m) => void r.calls.logs.push(m), warn: (m) => void r.calls.logs.push(`WARN ${m}`) },
  };
  return r;
}

function runRow(db: bus.BusDb, id: string): Record<string, unknown> {
  return db.prepare('SELECT * FROM runs WHERE id = ?').get(id) as Record<string, unknown>;
}
const allRuns = (db: bus.BusDb): string => JSON.stringify(db.prepare('SELECT * FROM runs ORDER BY id').all());

/** A limit stop on `id` as the activity observer reports it: marker on the ws (account + reset) then the pause. */
function limitStop(r: Rig, id: string, o: { account?: string; resetsAtMs?: number | null; at?: number } = {}): ReturnType<typeof autoPauseOnLimit> {
  const w = r.ws.get(id)!;
  if (o.account !== undefined) w.accountId = o.account;
  w.lastStopReason = 'usage_limit';
  w.lastStopReasonAt = o.at ?? r.clock.now;
  if (o.resetsAtMs !== undefined && o.resetsAtMs !== null) w.usageLimitResetsAt = o.resetsAtMs;
  return autoPauseOnLimit(r.deps, id);
}

// ─── Pause on a usage-limit stop ────────────────────────────────────────────────────────────────────────────────────────────────────────
test('PAUSE: a worker\'s limit stop ⇒ Pause DURE of ITS run (the nearest run with the switch ON), tagged auto with the member and its PINNED account', () => {
  const r = rig();
  assert.equal(limitStop(r, 'w1', { account: 'A', resetsAtMs: T0 + 3_600_000 }), 'paused');
  const o = runRow(r.db, 'O');
  assert.equal(o.paused_at, T0);
  assert.equal(o.paused_by, PAUSE_AUTO_BY);
  assert.equal(o.pause_mode, 'hard');
  assert.equal(o.pause_trap_at, null, 'the trap is owed');
  assert.equal(o.pause_deadline_at, null);
  assert.equal(o.resume_started_at, null);
  assert.deepEqual(parsePauseAuto(o.pause_auto as string, T0), { reason: 'usage_limit', wsIds: ['w1'], accountIds: ['A'] });
  assert.equal(runRow(r.db, 'L').paused_at, null, 'the parent run is untouched');
  assert.equal(runRow(r.db, 'X').paused_at, null, 'a sibling run is untouched');
});

test('PAUSE origin: a host-written pause records an EMPTY origin chain — the trap neither waits its 3 s origin grace nor spares anybody', () => {
  const r = rig();
  limitStop(r, 'w1');
  assert.deepEqual(readPauseOrigin(r.db, 'O', T0), []);
});

test('PAUSE: a pin to a deleted account (or none) is recorded as the default login (null)', () => {
  const r = rig();
  assert.equal(limitStop(r, 'w1', { account: 'GONE' }), 'paused');
  assert.deepEqual(parsePauseAuto(runRow(r.db, 'O').pause_auto as string, T0)?.accountIds, [null]);
});

test('PAUSE carrier: the FIRST run walking up whose frozen switch is ON — a run with the switch OFF is skipped, not paused', () => {
  const r = rig({ O: OFF });
  assert.equal(limitStop(r, 'w1'), 'paused');
  assert.equal(runRow(r.db, 'O').paused_at, null, 'O has the switch OFF: never written');
  assert.equal(runRow(r.db, 'L').paused_at, T0, 'L (switch ON) is the carrier');
});

test('PAUSE dangling: a workspace gone from the live chain ⇒ the bus run tree (parent_run_id) finds the carrier — the nearest ON run, not "nothing"', () => {
  const r = rig({ O: OFF });
  r.ws.delete('L'); // O's parent left the store: the live walk dangles at O
  assert.equal(limitStop(r, 'w1'), 'paused');
  assert.equal(runRow(r.db, 'L').paused_at, T0, 'L (switch ON) is reached through O.parent_run_id');
  assert.equal(runRow(r.db, 'O').paused_at, null);
});

test('PAUSE OFF identity: no run above the member has the switch ON ⇒ NOTHING is written (runs table byte-identical)', () => {
  const r = rig({ L: OFF, O: OFF, X: OFF });
  const before = allRuns(r.db);
  assert.equal(limitStop(r, 'w1'), 'no-carrier');
  assert.equal(allRuns(r.db), before);
  assert.deepEqual(autoPausedRuns(r.db), []);
});

test('PAUSE coordinator: an OPS that itself hits the limit pauses ITS OWN run (coordinators are runs)', () => {
  const r = rig();
  assert.equal(limitStop(r, 'O'), 'paused');
  assert.equal(runRow(r.db, 'O').paused_at, T0);
  assert.equal(runRow(r.db, 'L').paused_at, null);
});

test('PAUSE merge: a second limited member of an auto-paused run joins the reason; the pause keeps its time and holder', () => {
  const r = rig();
  limitStop(r, 'w1', { account: 'A' });
  r.clock.now = T0 + 5_000;
  assert.equal(limitStop(r, 'w2', { account: 'B' }), 'merged');
  const o = runRow(r.db, 'O');
  assert.equal(o.paused_at, T0);
  assert.equal(o.paused_by, PAUSE_AUTO_BY);
  assert.deepEqual(parsePauseAuto(o.pause_auto as string, T0), { reason: 'usage_limit', wsIds: ['w1', 'w2'], accountIds: ['A', 'B'] });
});

test('PAUSE manual: a run already under a MANUAL pause is left EXACTLY as it is — never turned into an auto pause', () => {
  const r = rig();
  r.db.prepare("UPDATE runs SET paused_at = ?, paused_by = 'O', pause_mode = 'hard' WHERE id = 'O'").run(T0 - 1000);
  const before = allRuns(r.db);
  assert.equal(limitStop(r, 'w1', { account: 'A' }), 'manual-pause');
  assert.equal(allRuns(r.db), before);
  assert.deepEqual(autoPausedRuns(r.db), []);
});

test('PAUSE ancestor: a member whose ANCESTOR run is paused is governed by it — manual stays manual, auto absorbs the member (no nested pause)', () => {
  const r = rig();
  r.db.prepare("UPDATE runs SET paused_at = ?, paused_by = 'L', pause_mode = 'hard' WHERE id = 'L'").run(T0 - 1000);
  assert.equal(limitStop(r, 'w1'), 'manual-pause');
  assert.equal(runRow(r.db, 'O').paused_at, null, 'no nested pause under a manual ancestor pause');
  const r2 = rig();
  limitStop(r2, 'x1', { account: 'A' }); // X auto-paused… make L the carrier instead:
  r2.db.prepare('UPDATE runs SET paused_at = NULL, paused_by = NULL, pause_mode = NULL, pause_auto = NULL WHERE id = ?').run('X');
  r2.db.prepare('UPDATE runs SET paused_at = ?, paused_by = ?, pause_mode = ?, pause_auto = ? WHERE id = ?').run(T0, PAUSE_AUTO_BY, 'hard', encodePauseAuto({ reason: 'usage_limit', wsIds: ['x1'], accountIds: ['A'] }, T0), 'L');
  assert.equal(limitStop(r2, 'w1', { account: 'B' }), 'merged');
  assert.equal(runRow(r2.db, 'O').paused_at, null);
  assert.deepEqual(parsePauseAuto(runRow(r2.db, 'L').pause_auto as string, T0)?.wsIds, ['x1', 'w1']);
});

test('PAUSE while RESUMING: an auto run whose Reprise started and whose member hits the limit again goes back to PAUSED in a NEW epoch (trap owed, reason carried, the old epoch\'s rows kept as history)', () => {
  const r = rig();
  limitStop(r, 'w1', { account: 'A' });
  r.db.prepare('UPDATE runs SET pause_trap_at = ?, resume_started_at = ? WHERE id = ?').run(T0 + 1, T0 + 2, 'O');
  r.db.prepare("INSERT INTO pause_members (run_id, paused_at, ws_id, role, member_run, released_at, released_by, reprise_confirmed_at) VALUES ('O', ?, 'w1', 'worker', 'O', ?, 'host', ?)").run(T0, T0 + 3, T0 + 4);
  r.clock.now = T0 + 10_000;
  assert.equal(limitStop(r, 'w2', { account: 'A' }), 'repaused');
  const o = runRow(r.db, 'O');
  assert.equal(o.paused_at, T0 + 10_000, 'a NEW epoch: the old epoch\'s Bilan rows read "fully trapped", a re-owed trap on the same epoch would skip every member');
  assert.equal(o.resume_started_at, null);
  assert.equal(o.pause_trap_at, null, 'the trap is owed again');
  assert.equal(o.paused_by, PAUSE_AUTO_BY);
  assert.deepEqual(parsePauseAuto(o.pause_auto as string, T0 + 10_000), { reason: 'usage_limit', wsIds: ['w1', 'w2'], accountIds: ['A', 'A'] });
  assert.equal(parsePauseAuto(o.pause_auto as string, T0), null, 'bound to the NEW epoch');
  const old = r.db.prepare("SELECT released_at, released_by, reprise_confirmed_at FROM pause_members WHERE ws_id = 'w1'").get() as Record<string, unknown>;
  assert.deepEqual(old, { released_at: T0 + 3, released_by: 'host', reprise_confirmed_at: T0 + 4 }, 'the old epoch\'s roster is history, never rewritten');
  assert.deepEqual(readPauseOrigin(r.db, 'O', T0 + 10_000), [], 'an empty origin for the new epoch too');
  // the epoch is strictly greater even when the clock did not move
  const r2 = rig();
  limitStop(r2, 'w1', { account: 'A' });
  r2.db.prepare('UPDATE runs SET pause_trap_at = ?, resume_started_at = ? WHERE id = ?').run(T0 + 1, T0 + 2, 'O');
  assert.equal(limitStop(r2, 'w2', { account: 'A' }), 'repaused');
  assert.equal(runRow(r2.db, 'O').paused_at, T0 + 1);
});

test('PAUSE guards: an unknown / archived workspace and a missing bus pause nothing', () => {
  const r = rig();
  assert.equal(autoPauseOnLimit(r.deps, 'nope'), 'no-workspace');
  r.ws.get('w1')!.archived = true;
  assert.equal(autoPauseOnLimit(r.deps, 'w1'), 'no-workspace');
  assert.equal(autoPauseOnLimit({ ...r.deps, getBus: () => null }, 'w2'), 'no-bus');
  assert.equal(runRow(r.db, 'O').paused_at, null);
});

// ─── Reprise when the quota is back ─────────────────────────────────────────────────────────────────────────────────────────────────────
/** O auto-paused by w1 on account A (reset an hour away), trap done 1 s later. */
function pausedByLimit(r: Rig, o: { trapDone?: boolean; account?: string } = {}): void {
  limitStop(r, 'w1', { account: o.account ?? 'A', resetsAtMs: T0 + 3_600_000 });
  if (o.trapDone !== false) {
    // the host trap finishing: a Bilan row per member (the worker stays BLOCKED until its OPS releases it ⇒ the run stays RESUMING), then the stamp
    insertBilan(r.db, { runId: 'O', wsId: 'w1', pausedAt: T0, activity: { surface: 'none' }, snapshotRef: null, dirty: false, killed: [], error: null });
    r.db.prepare('UPDATE runs SET pause_trap_at = ? WHERE id = ?').run(T0 + 1_000, 'O');
  }
}
const fresh = (r: Rig, account: string, data: UsageWindows, ageMs = 0): void => void r.readings.set(account, { fetchedAt: r.clock.now - ageMs, data });

test('REPRISE quota override: a fresh reading showing quota on the member\'s account starts the Reprise (host, usage_limit) although the stored reset is an hour away', async () => {
  const r = rig();
  pausedByLimit(r);
  r.clock.now = T0 + 60_000;
  fresh(r, 'A', usable);
  const out = await evaluateAutoPaused(r.deps);
  assert.deepEqual(out, [{ runId: 'O', action: 'reprise', outcome: 'resuming' }]);
  assert.deepEqual(r.calls.reprise, [{ run: 'O', actor: 'host', opts: { host: true, reason: 'usage_limit' } }]);
  assert.equal(runRow(r.db, 'O').resume_started_at !== null, true);
  assert.equal(r.ws.get('w1')!.lastStopReason, 'usage_limit', 'the trigger\'s marker is LEFT: #74 stays the safety net that restarts a limit-killed member once it may start');
  assert.deepEqual(r.reprises.get('O'), [T0 + 60_000], 'the Reprise is recorded for the flap guard');
});

test('REPRISE waits while the account is still limited (fresh reading limited until a reset ahead) — and while only a PRE-BLOCK reading exists', async () => {
  const r = rig();
  pausedByLimit(r);
  r.clock.now = T0 + 60_000;
  fresh(r, 'A', limited(T0 + 3_600_000));
  assert.deepEqual(await evaluateAutoPaused(r.deps), [{ runId: 'O', action: 'wait', why: 'quota-not-back' }]);
  r.readings.set('A', { fetchedAt: T0 - 5_000, data: usable }); // taken BEFORE the limit stop
  assert.deepEqual(await evaluateAutoPaused(r.deps), [{ runId: 'O', action: 'wait', why: 'quota-not-back' }]);
  assert.equal(r.calls.reprise.length, 0);
  assert.equal(runRow(r.db, 'O').resume_started_at, null);
});

test('REPRISE manual: a MANUAL pause is never selected, whatever the usage says — and neither is one carrying another pause\'s stale reason', async () => {
  const r = rig();
  r.db.prepare("UPDATE runs SET paused_at = ?, paused_by = 'O', pause_mode = 'hard', pause_trap_at = ? WHERE id = 'O'").run(T0, T0 + 1);
  r.ws.get('w1')!.accountId = 'A';
  r.clock.now = T0 + 60_000; // evidence that WOULD Reprise an auto pause is in place: a mis-selected manual pause would go
  fresh(r, 'A', usable);
  fresh(r, 'B', usable);
  assert.deepEqual(await evaluateAutoPaused(r.deps), []);
  // a pause_auto that survived a lift, then a LATER manual pause (other paused_at)
  r.db.prepare('UPDATE runs SET pause_auto = ? WHERE id = ?').run(encodePauseAuto({ reason: 'usage_limit', wsIds: ['w1'], accountIds: ['A'] }, T0 - 99), 'O');
  assert.deepEqual(await evaluateAutoPaused(r.deps), []);
  r.db.prepare("UPDATE runs SET pause_auto = '{broken' WHERE id = 'O'").run();
  assert.deepEqual(await evaluateAutoPaused(r.deps), []);
  assert.equal(r.calls.reprise.length, 0);
});

test('REPRISE frozen switch: a run whose `pause` switch is OFF is never evaluated', async () => {
  const r = rig({ O: OFF });
  r.db.prepare('UPDATE runs SET paused_at = ?, paused_by = ?, pause_mode = ?, pause_trap_at = ?, pause_auto = ? WHERE id = ?').run(T0, PAUSE_AUTO_BY, 'hard', T0 + 1, encodePauseAuto({ reason: 'usage_limit', wsIds: ['w1'], accountIds: ['A'] }, T0), 'O');
  fresh(r, 'A', usable);
  assert.deepEqual(await evaluateAutoPaused(r.deps), []);
  assert.equal(r.calls.reprise.length, 0);
});

test('REPRISE trigger set: EVERY triggering member\'s account needs quota (one limited keeps the run paused)', async () => {
  const r = rig();
  pausedByLimit(r);
  limitStop(r, 'w2', { account: 'B', resetsAtMs: T0 + 3_600_000 });
  r.clock.now = T0 + 60_000;
  fresh(r, 'A', usable);
  fresh(r, 'B', limited(T0 + 3_600_000));
  assert.equal((await evaluateAutoPaused(r.deps))[0].action, 'wait');
  fresh(r, 'B', usable);
  assert.equal((await evaluateAutoPaused(r.deps))[0].action, 'reprise');
});

test('REPRISE trap: waits for the host trap (the Bilans) — but an overdue trap does not freeze the fleet forever', async () => {
  const r = rig();
  pausedByLimit(r, { trapDone: false });
  r.clock.now = T0 + 60_000;
  fresh(r, 'A', usable);
  assert.deepEqual(await evaluateAutoPaused(r.deps), [{ runId: 'O', action: 'wait', why: 'trap-pending' }]);
  r.clock.now = T0 + TRAP_WAIT_MAX_MS;
  fresh(r, 'A', usable);
  assert.equal((await evaluateAutoPaused(r.deps))[0].action, 'reprise');
});

test('REPRISE current pin: a MIGRATED trigger is judged on its NEW account (the stored one is display only)', async () => {
  const r = rig();
  pausedByLimit(r, { account: 'A' }); // paused while on A
  r.ws.get('w1')!.accountId = 'B'; // migrated to B
  r.clock.now = T0 + 60_000;
  fresh(r, 'A', limited(T0 + 3_600_000)); // A is still limited…
  fresh(r, 'B', usable); // …B has quota
  assert.equal((await evaluateAutoPaused(r.deps))[0].action, 'reprise');
  const r2 = rig();
  pausedByLimit(r2, { account: 'A' });
  r2.ws.get('w1')!.accountId = 'B';
  r2.clock.now = T0 + 60_000;
  fresh(r2, 'A', usable); // the OLD account has quota, the new one is limited
  fresh(r2, 'B', limited(T0 + 3_600_000));
  assert.equal((await evaluateAutoPaused(r2.deps))[0].action, 'wait');
});

test('REPRISE gone trigger: a deleted member cannot be waited for — the stored account decides; a pin to a deleted account falls back to the default login', async () => {
  const r = rig();
  pausedByLimit(r, { account: 'A' });
  r.ws.delete('w1');
  r.clock.now = T0 + 60_000;
  fresh(r, 'A', limited(T0 + 3_600_000));
  assert.equal((await evaluateAutoPaused(r.deps))[0].action, 'wait');
  fresh(r, 'A', usable);
  assert.equal((await evaluateAutoPaused(r.deps))[0].action, 'reprise');
});

test('REPRISE order: nested auto-paused runs are Reprised ANCESTOR first (coordinators first)', async () => {
  const r = rig({}, { childFirst: true });
  const reason = (ws: string) => encodePauseAuto({ reason: 'usage_limit', wsIds: [ws], accountIds: ['A'] }, T0);
  r.db.prepare('UPDATE runs SET paused_at = ?, paused_by = ?, pause_mode = ?, pause_trap_at = ?, pause_auto = ? WHERE id = ?').run(T0, PAUSE_AUTO_BY, 'hard', T0 + 1, reason('w1'), 'O'); // child first on purpose
  r.db.prepare('UPDATE runs SET paused_at = ?, paused_by = ?, pause_mode = ?, pause_trap_at = ?, pause_auto = ? WHERE id = ?').run(T0, PAUSE_AUTO_BY, 'hard', T0 + 1, reason('x1'), 'L');
  r.ws.get('w1')!.accountId = 'A';
  r.ws.get('x1')!.accountId = 'A';
  r.clock.now = T0 + 60_000;
  fresh(r, 'A', usable);
  await evaluateAutoPaused(r.deps);
  assert.deepEqual(r.calls.reprise.map((c) => c.run), ['L', 'O']);
});

test('REPRISE once: a run already RESUMING is not evaluated again; a throwing / refusing beginReprise records nothing and retries next tick', async () => {
  const r = rig();
  pausedByLimit(r);
  r.clock.now = T0 + 60_000;
  fresh(r, 'A', usable);
  r.deps = { ...r.deps, repriseStreak: () => 0 }; // isolate the selection filter from the flap guard (which would also hold a second Reprise)
  await evaluateAutoPaused(r.deps);
  await evaluateAutoPaused(r.deps);
  assert.equal(r.calls.reprise.length, 1, 'resume_started_at set ⇒ not selected again');
  const r2 = rig();
  pausedByLimit(r2);
  r2.clock.now = T0 + 60_000;
  fresh(r2, 'A', usable);
  r2.deps = { ...r2.deps, beginReprise: () => { throw new Error('boom'); } };
  assert.deepEqual(await evaluateAutoPaused(r2.deps), [{ runId: 'O', action: 'wait', why: 'reprise-threw' }]);
  r2.deps = { ...r2.deps, beginReprise: () => 'not-paused' };
  await evaluateAutoPaused(r2.deps);
  assert.deepEqual([...r2.reprises.keys()], [], 'a Reprise that did not start is not recorded for the flap guard');
});

test('REPRISE refresh: a passed / unknown reset with no usable reading asks the poller for one; a reset still ahead does not', async () => {
  const r = rig();
  pausedByLimit(r, { account: 'A' });
  r.clock.now = T0 + 60_000;
  await evaluateAutoPaused(r.deps);
  assert.deepEqual(r.calls.refresh, [], 'reset an hour ahead: nothing to ask yet');
  r.clock.now = T0 + 3_600_000 + 1;
  await evaluateAutoPaused(r.deps);
  assert.deepEqual(r.calls.refresh, [['A']]);
  // grace: reset + 5 min with still no reading ⇒ the stored reset is the last resort
  r.clock.now = T0 + 3_600_000 + RESET_GRACE_MS;
  assert.equal((await evaluateAutoPaused(r.deps))[0].action, 'reprise');
});

test('REPRISE ancestor: a child run waits for EVERY ancestor run still paused (top-down) — a manual parent pause holds it; the lift (or a resuming parent) frees it', async () => {
  const r = rig();
  pausedByLimit(r, { account: 'A' }); // O auto-paused, quota back below
  r.db.prepare("UPDATE runs SET paused_at = ?, paused_by = 'L', pause_mode = 'hard' WHERE id = 'L'").run(T0 - 1000); // L manually paused
  r.ws.get('w1')!.accountId = 'A';
  r.clock.now = T0 + 60_000;
  fresh(r, 'A', usable);
  assert.deepEqual(await evaluateAutoPaused(r.deps), [{ runId: 'O', action: 'wait', why: 'ancestor-paused' }]);
  assert.equal(r.calls.reprise.length, 0);
  r.db.prepare('UPDATE runs SET paused_at = NULL, paused_by = NULL, pause_mode = NULL WHERE id = ?').run('L'); // the human lifts L
  assert.equal((await evaluateAutoPaused(r.deps))[0].action, 'reprise');
  // an ancestor that is itself RESUMING no longer blocks (it released its coordinators top-down)
  const r2 = rig();
  pausedByLimit(r2, { account: 'A' });
  r2.ws.get('w1')!.accountId = 'A';
  r2.db.prepare("UPDATE runs SET paused_at = ?, paused_by = 'L', pause_mode = 'hard', resume_started_at = ? WHERE id = 'L'").run(T0 - 1000, T0 - 500);
  r2.clock.now = T0 + 60_000;
  fresh(r2, 'A', usable);
  assert.equal((await evaluateAutoPaused(r2.deps))[0].action, 'reprise');
});

test('REPRISE backoff: a run Reprised before and limited AGAIN waits 5, 10, 20… min after the latest limit stop (the fleet-wide trap must not flap), and the streak expires after 2 h', async () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5, 9].map(repriseBackoffMs), [0, 300_000, 600_000, 1_200_000, 2_400_000, 3_600_000, 3_600_000]);
  const r = rig();
  limitStop(r, 'w1', { account: 'A', resetsAtMs: T0 + 3_600_000 });
  r.db.prepare('UPDATE runs SET pause_trap_at = ? WHERE id = ?').run(T0 + 1_000, 'O');
  r.reprises.set('O', [T0 - 600_000]); // Reprised 10 min before this pause: streak 1 ⇒ 5 min
  r.clock.now = T0 + 60_000;
  fresh(r, 'A', usable);
  assert.deepEqual(await evaluateAutoPaused(r.deps), [{ runId: 'O', action: 'wait', why: 'backoff' }], 'quota is back but the run flapped');
  r.clock.now = T0 + 300_000 - 1;
  fresh(r, 'A', usable);
  assert.equal((await evaluateAutoPaused(r.deps))[0].why, 'backoff');
  r.clock.now = T0 + 300_000;
  fresh(r, 'A', usable);
  assert.equal((await evaluateAutoPaused(r.deps))[0].action, 'reprise');
  assert.deepEqual(r.reprises.get('O')?.length, 2, 'the new Reprise extends the streak');
  // a streak older than the window is forgotten
  const r2 = rig();
  limitStop(r2, 'w1', { account: 'A' });
  r2.db.prepare('UPDATE runs SET pause_trap_at = ? WHERE id = ?').run(T0 + 1_000, 'O');
  r2.reprises.set('O', [T0 - REPRISE_STREAK_WINDOW_MS - 1]);
  r2.clock.now = T0 + 60_000;
  fresh(r2, 'A', usable);
  assert.equal((await evaluateAutoPaused(r2.deps))[0].action, 'reprise');
});

test('REPRISE backoff is measured from the LATEST limit stop — a member limited again long after the epoch began is not Reprised on the epoch\'s clock', async () => {
  const r = rig();
  limitStop(r, 'w1', { account: 'A', resetsAtMs: T0 + 3_600_000 }); // the epoch begins at T0
  r.db.prepare('UPDATE runs SET pause_trap_at = ? WHERE id = ?').run(T0 + 1_000, 'O');
  r.reprises.set('O', [T0 + 2_000]); // Reprised once already (streak 1 ⇒ 5 min)
  r.clock.now = T0 + 20 * 60_000;
  limitStop(r, 'w2', { account: 'A', resetsAtMs: T0 + 3_600_000 }); // limited AGAIN 20 min later (merged into the same epoch)
  r.clock.now = T0 + 22 * 60_000;
  fresh(r, 'A', usable);
  assert.equal((await evaluateAutoPaused(r.deps))[0].why, 'backoff', '22 min after the epoch began, but only 2 min after the latest limit stop');
  r.clock.now = T0 + 25 * 60_000;
  fresh(r, 'A', usable);
  assert.equal((await evaluateAutoPaused(r.deps))[0].action, 'reprise');
});

test('REPRISE changed meanwhile: a human lift (or manual re-pause) landing between the SELECT and the call is never Reprised', async () => {
  const r = rig();
  pausedByLimit(r, { account: 'A' });
  r.ws.get('w1')!.accountId = 'A';
  r.clock.now = T0 + 60_000;
  fresh(r, 'A', usable);
  const real = r.deps.readingFor;
  r.deps = { ...r.deps, readingFor: (a) => { r.db.prepare('UPDATE runs SET paused_at = NULL, paused_by = NULL, pause_mode = NULL WHERE id = ?').run('O'); return real(a); } };
  assert.deepEqual(await evaluateAutoPaused(r.deps), [{ runId: 'O', action: 'wait', why: 'changed-meanwhile' }]);
  assert.equal(r.calls.reprise.length, 0);
});

test('REPRISE isolation: one run whose evaluation throws never starves the others', async () => {
  const r = rig();
  pausedByLimit(r, { account: 'A' }); // O on A
  limitStop(r, 'x1', { account: 'B', resetsAtMs: T0 + 3_600_000 }); // X on B
  r.db.prepare('UPDATE runs SET pause_trap_at = ? WHERE id = ?').run(T0 + 1_000, 'X');
  r.ws.get('w1')!.accountId = 'A';
  r.clock.now = T0 + 60_000;
  fresh(r, 'A', usable);
  fresh(r, 'B', usable);
  const real = r.deps.readingFor;
  r.deps = { ...r.deps, readingFor: (a) => { if (a === 'A') throw new Error('corrupt reading'); return real(a); } };
  const out = await evaluateAutoPaused(r.deps);
  assert.deepEqual(out.map((e) => `${e.runId}:${e.action}:${e.why ?? e.outcome}`).sort(), ['O:wait:evaluate-threw', 'X:reprise:resuming']);
});

// ─── migration / re-login ───────────────────────────────────────────────────────────────────────────────────────────────────────────────
test('ACCOUNT CHANGE migrate: forces a fresh reading of the NEW account, re-evaluates AT ONCE and Reprises — a cached pre-migration reading is not enough', async () => {
  const r = rig();
  pausedByLimit(r, { account: 'A' });
  r.clock.now = T0 + 30_000;
  fresh(r, 'B', usable, 20_000); // B was read 20 s ago (<180 s cache) — taken BEFORE the migration
  r.ws.get('w1')!.accountId = 'B'; // the migration re-pinned it
  r.clock.now = T0 + 40_000;
  r.onForce = (ids) => {
    assert.deepEqual(ids, ['B']);
    fresh(r, 'B', usable); // the forced read lands "now"
  };
  const res = await afterAccountChange(r.deps, { kind: 'migrate', wsId: 'w1' });
  assert.deepEqual(res.runs, ['O']);
  assert.deepEqual(res.forced, ['B']);
  assert.deepEqual(res.evaluated, [{ runId: 'O', action: 'reprise', outcome: 'resuming' }]);
  assert.equal(r.calls.force.length, 1);
  assert.deepEqual(parsePauseAuto(runRow(r.db, 'O').pause_auto as string, T0)?.accountIds, ['B'], 'the stored (display) account follows the pin');
});

test('ACCOUNT CHANGE migrate: WITHOUT the forced read the same cached reading must not Reprise (the cache is the thing being bypassed)', async () => {
  const r = rig();
  pausedByLimit(r, { account: 'A' });
  r.clock.now = T0 + 30_000;
  fresh(r, 'B', usable, 20_000); // taken at T0+10 s: AFTER the block, BEFORE the migration — only the account-change floor can reject it
  r.ws.get('w1')!.accountId = 'B';
  r.clock.now = T0 + 40_000;
  r.onForce = () => {}; // the force installs nothing (e.g. the fetch failed)
  const res = await afterAccountChange(r.deps, { kind: 'migrate', wsId: 'w1' });
  assert.deepEqual(res.evaluated, [{ runId: 'O', action: 'wait', why: 'quota-not-back' }]);
  assert.equal(r.calls.reprise.length, 0);
});

test('ACCOUNT CHANGE reset: after a migration the OLD account\'s stored reset time must not Reprise the member onto an unread new account', async () => {
  const r = rig();
  pausedByLimit(r, { account: 'A' }); // stored reset = T0 + 1 h
  r.ws.get('w1')!.accountId = 'B';
  r.ws.get('w1')!.usageLimitResetsAt = T0 + 3_600_000;
  r.changed.set('w1', T0 + 120_000); // migrated
  r.clock.now = T0 + 3_600_000 + RESET_GRACE_MS + 1; // A's reset + grace long passed; B has NO reading (its endpoint is down)
  const out = await evaluateAutoPaused(r.deps);
  assert.deepEqual(out, [{ runId: 'O', action: 'wait', why: 'quota-not-back' }]);
  assert.equal(r.calls.reprise.length, 0);
});

test('ACCOUNT CHANGE login: re-logging an account forces ITS fresh reading for the runs waiting on it only', async () => {
  const r = rig();
  pausedByLimit(r, { account: 'A' });
  limitStop(r, 'x1', { account: 'B', resetsAtMs: T0 + 3_600_000 });
  r.db.prepare('UPDATE runs SET pause_trap_at = ? WHERE id = ?').run(T0 + 1_000, 'X');
  r.clock.now = T0 + 50_000;
  r.onForce = (ids) => {
    assert.deepEqual(ids, ['A']);
    fresh(r, 'A', usable);
  };
  const res = await afterAccountChange(r.deps, { kind: 'login', accountId: 'A' });
  assert.deepEqual(res.runs, ['O']);
  assert.deepEqual(res.evaluated.map((e) => `${e.runId}:${e.action}`).sort(), ['O:reprise', 'X:wait']);
});

test('ACCOUNT CHANGE nothing waiting: no auto-paused run touched ⇒ NOTHING is forced or evaluated (switch OFF / manual pause / unrelated member — identical to today)', async () => {
  const r = rig();
  assert.deepEqual(await afterAccountChange(r.deps, { kind: 'migrate', wsId: 'w1' }), { runs: [], forced: [], evaluated: [] });
  r.db.prepare("UPDATE runs SET paused_at = ?, paused_by = 'O', pause_mode = 'hard' WHERE id = 'O'").run(T0);
  assert.deepEqual(await afterAccountChange(r.deps, { kind: 'login', accountId: 'A' }), { runs: [], forced: [], evaluated: [] });
  const r2 = rig();
  pausedByLimit(r2, { account: 'A' });
  assert.deepEqual((await afterAccountChange(r2.deps, { kind: 'migrate', wsId: 'w2' })).runs, [], 'w2 is not a trigger');
  assert.deepEqual((await afterAccountChange(r2.deps, { kind: 'login', accountId: 'B' })).runs, [], 'nobody waits on B');
  assert.equal(r.calls.force.length + r2.calls.force.length, 0);
});

test('ACCOUNT CHANGE: a failed forced read still re-evaluates on what is cached (never throws)', async () => {
  const r = rig();
  pausedByLimit(r, { account: 'A' });
  fresh(r, 'A', usable);
  r.clock.now = T0 + 60_000;
  fresh(r, 'A', usable);
  r.deps = { ...r.deps, forceRefresh: async () => { throw new Error('network down'); } };
  const res = await afterAccountChange(r.deps, { kind: 'login', accountId: 'A' });
  assert.equal(res.evaluated[0].action, 'reprise');
  assert.ok(r.calls.logs.some((l) => l.startsWith('WARN pause-auto: forced usage refresh failed')));
});

// ─── integration with #255 (the REAL beginReprise / revertResumeToPaused / setRunPause) ──────────────────────────────────────────────────
test('INTEGRATION Reprise: the REAL beginReprise (host, usage_limit) releases the coordinators and sends each its `reprise` row; the blocked worker keeps the run RESUMING', async () => {
  const r = rig();
  pausedByLimit(r, { account: 'A' });
  r.ws.get('w1')!.accountId = 'A';
  r.clock.now = T0 + 60_000;
  fresh(r, 'A', usable);
  assert.deepEqual(await evaluateAutoPaused(r.deps), [{ runId: 'O', action: 'reprise', outcome: 'resuming' }]);
  const o = runRow(r.db, 'O');
  assert.equal(o.resume_started_at !== null, true, 'RESUMING (the worker w1 is blocked until its OPS releases it)');
  assert.equal(o.paused_at, T0);
  assert.deepEqual(parsePauseAuto(o.pause_auto as string, T0)?.wsIds, ['w1'], 'pause_auto stays until the run closes');
  const rows = r.db.prepare("SELECT ws_id, role, released_by FROM pause_members WHERE run_id = 'O' ORDER BY ws_id").all() as Array<Record<string, unknown>>;
  assert.deepEqual(rows.map((x) => [x.ws_id, x.role, x.released_by]), [['O', 'coordinator', 'host'], ['w1', 'worker', null]]);
  assert.equal((r.db.prepare("SELECT COUNT(*) AS c FROM messages WHERE kind = 'reprise' AND recipient = 'O'").get() as { c: number }).c, 1, 'the coordinator got its Bilan row');
  assert.deepEqual(await evaluateAutoPaused(r.deps), [], 'a RESUMING run is not evaluated again');
});

test('INTEGRATION Reprise closes: with no worker to wait for the run goes ACTIVE at once — every pause column, pause_auto included, is NULL', async () => {
  const r = rig();
  limitStop(r, 'w1', { account: 'A', resetsAtMs: T0 + 3_600_000 });
  r.db.prepare('UPDATE runs SET pause_trap_at = ? WHERE id = ?').run(T0 + 1_000, 'O'); // trap stamped, no Bilan row: nothing to wait for
  r.clock.now = T0 + 60_000;
  r.ws.get('w1')!.accountId = 'A';
  fresh(r, 'A', usable);
  assert.equal((await evaluateAutoPaused(r.deps))[0].outcome, 'resuming');
  const o = runRow(r.db, 'O');
  assert.deepEqual([o.paused_at, o.paused_by, o.pause_mode, o.pause_trap_at, o.resume_started_at, o.pause_auto], [null, null, null, null, null, null]);
});

test('INTEGRATION released member: a worker RELEASED during the Reprise that hits the limit again re-pauses the RESUMING run (the gate no longer governs it, the carrier lookup includes the released)', () => {
  const r = rig();
  pausedByLimit(r, { account: 'A' });
  r.db.prepare('UPDATE runs SET resume_started_at = ? WHERE id = ?').run(T0 + 2_000, 'O');
  r.db.prepare("INSERT OR REPLACE INTO pause_members (run_id, paused_at, ws_id, role, member_run, released_at, released_by) VALUES ('O', ?, 'w1', 'worker', 'O', ?, 'O')").run(T0, T0 + 3_000);
  r.clock.now = T0 + 20_000;
  assert.equal(limitStop(r, 'w1', { account: 'A' }), 'repaused');
  const o = runRow(r.db, 'O');
  assert.deepEqual([o.paused_at, o.resume_started_at, o.pause_trap_at], [T0 + 20_000, null, null]);
});

test('INTEGRATION human re-assert: a human `run pause` over an AUTO pause TAKES IT OVER — pause_auto NULL, so the host never lifts it (D6)', async () => {
  const r = rig();
  pausedByLimit(r, { account: 'A' });
  r.ws.get('w1')!.accountId = 'A';
  r.clock.now = T0 + 60_000;
  fresh(r, 'A', usable);
  assert.equal(setRunPause(r.db, 'O', true, 'O'), 'already-paused');
  assert.equal(runRow(r.db, 'O').pause_auto, null);
  assert.equal(runRow(r.db, 'O').paused_by, PAUSE_AUTO_BY, 'the pause itself is untouched');
  assert.deepEqual(await evaluateAutoPaused(r.deps), []);
  assert.equal(r.calls.reprise.length, 0);
});

// ─── round-2 review fixes ───────────────────────────────────────────────────────────────────────────────────────────────────────────────
/** A `db` whose FIRST `prepare` of a statement matching `re` first runs `before` (a concurrent writer landing between a read and the write). */
function racing(db: bus.BusDb, re: RegExp, before: () => void): bus.BusDb {
  let fired = false;
  return new Proxy(db, {
    get(t, k) {
      const v = (t as unknown as Record<PropertyKey, unknown>)[k];
      if (k === 'prepare') return (sql: string) => { if (!fired && re.test(sql)) { fired = true; before(); } return t.prepare(sql); };
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(t) : v;
    },
  });
}

test('PAUSE race: a MANUAL pause landing between the host\'s read and its write is never overwritten', () => {
  const r = rig();
  const real = r.db;
  r.deps = { ...r.deps, getBus: () => racing(real, /UPDATE runs SET paused_at = \?, paused_by = \?, pause_mode = 'hard'/, () => { real.prepare("UPDATE runs SET paused_at = ?, paused_by = 'O', pause_mode = 'hard' WHERE id = 'O'").run(T0 - 5); }) };
  assert.equal(limitStop(r, 'w1', { account: 'A' }), 'manual-pause');
  const o = runRow(real, 'O');
  assert.deepEqual([o.paused_at, o.paused_by, o.pause_auto], [T0 - 5, 'O', null]);
});

test('INTEGRATION human race: a human `run pause` that loses the race to the host\'s auto pause ADOPTS it (pause_auto NULL) instead of reporting a manual pause that is not', () => {
  const r = rig();
  const real = r.db;
  const racy = racing(real, /UPDATE runs SET paused_at = \?, paused_by = \?, pause_mode = \?, pause_deadline_at/, () => { limitStop(r, 'w1', { account: 'A' }); });
  assert.equal(setRunPause(racy, 'O', true, 'O'), 'already-paused');
  const o = runRow(real, 'O');
  assert.equal(o.paused_by, PAUSE_AUTO_BY, 'the host\'s pause stands…');
  assert.equal(o.pause_auto, null, '…but it is now a human\'s: never auto-resumed');
});

test('PAUSE manual Reprise: a member RELEASED by a human-led Reprise that hits the limit gets a NEW (auto) pause — a released member is no longer governed', () => {
  const r = rig();
  r.db.prepare("UPDATE runs SET paused_at = ?, paused_by = 'O', pause_mode = 'hard', pause_trap_at = ?, resume_started_at = ? WHERE id = 'O'").run(T0 - 1000, T0 - 900, T0 - 800);
  r.db.prepare("INSERT INTO pause_members (run_id, paused_at, ws_id, role, member_run, released_at, released_by) VALUES ('O', ?, 'w1', 'worker', 'O', ?, 'O')").run(T0 - 1000, T0 - 700);
  assert.equal(limitStop(r, 'w1', { account: 'A' }), 'repaused');
  const o = runRow(r.db, 'O');
  assert.deepEqual([o.resume_started_at, o.paused_by], [null, PAUSE_AUTO_BY]);
  assert.deepEqual(parsePauseAuto(o.pause_auto as string, o.paused_at as number)?.wsIds, ['w1']);
});

test('PAUSE nearest run: a member released by a FARTHER resuming run belongs to the NEAREST switch-ON run for its new pause — the farther run is not re-paused', () => {
  const r = rig();
  // L (auto, RESUMING) released w1, which lives under O (switch ON, not paused)
  r.db.prepare('UPDATE runs SET paused_at = ?, paused_by = ?, pause_mode = ?, pause_trap_at = ?, resume_started_at = ?, pause_auto = ? WHERE id = ?').run(T0 - 1000, PAUSE_AUTO_BY, 'hard', T0 - 900, T0 - 800, encodePauseAuto({ reason: 'usage_limit', wsIds: ['x1'], accountIds: ['B'] }, T0 - 1000), 'L');
  r.db.prepare("INSERT INTO pause_members (run_id, paused_at, ws_id, role, member_run, released_at, released_by) VALUES ('L', ?, 'w1', 'worker', 'O', ?, 'host')").run(T0 - 1000, T0 - 700);
  assert.equal(limitStop(r, 'w1', { account: 'A' }), 'paused');
  assert.equal(runRow(r.db, 'O').paused_at, T0);
  assert.equal(runRow(r.db, 'L').resume_started_at, T0 - 800, 'L keeps resuming');
});

test('ACCOUNT CHANGE streak: an explicit switch / re-login ends the flap guard — the Reprise is prompt, not held 5+ min behind a limit that preceded the switch', async () => {
  const r = rig();
  pausedByLimit(r, { account: 'A' });
  r.reprises.set('O', [T0 - 600_000, T0 - 300_000]); // streak 2 ⇒ 10 min
  r.clock.now = T0 + 30_000;
  r.ws.get('w1')!.accountId = 'B';
  r.clock.now = T0 + 40_000;
  r.onForce = () => fresh(r, 'B', usable);
  assert.equal((await afterAccountChange(r.deps, { kind: 'migrate', wsId: 'w1' })).evaluated[0]?.action, 'reprise');
  const r2 = rig();
  pausedByLimit(r2, { account: 'A' });
  r2.reprises.set('O', [T0 - 600_000, T0 - 300_000]);
  r2.ws.get('w1')!.accountId = 'A';
  r2.clock.now = T0 + 40_000;
  fresh(r2, 'A', usable);
  assert.equal((await evaluateAutoPaused(r2.deps))[0].why, 'backoff', 'control: WITHOUT a switch the same run is held');
});

test('REPRISE stale account change: a change OLDER than the member\'s latest limit stop is history — the grace fallback applies to the new stop', async () => {
  const r = rig();
  pausedByLimit(r, { account: 'A' });
  r.ws.get('w1')!.accountId = 'B';
  r.changed.set('w1', T0 - 500); // migrated during an EARLIER pause
  r.clock.now = T0 + 3_600_000 + RESET_GRACE_MS; // the new stop's reset + grace; no reading obtainable
  assert.equal((await evaluateAutoPaused(r.deps))[0].action, 'reprise');
});

test('REPRISE ancestor: the LIVE tree decides — an OPS detached from its old parent run is not held by that parent\'s pause; a dangling live chain falls back to the bus run tree; a switch-OFF ancestor\'s stale pause is inert', async () => {
  const r = rig();
  pausedByLimit(r, { account: 'A' });
  r.ws.get('w1')!.accountId = 'A';
  r.db.prepare("UPDATE runs SET paused_at = ?, paused_by = 'L', pause_mode = 'hard' WHERE id = 'L'").run(T0 - 1000); // L manually paused
  r.ws.get('O')!.parentId = undefined; // …but O was detached live (parent_run_id is write-once)
  r.clock.now = T0 + 60_000;
  fresh(r, 'A', usable);
  assert.equal((await evaluateAutoPaused(r.deps))[0].action, 'reprise');
  const r2 = rig();
  pausedByLimit(r2, { account: 'A' });
  r2.ws.get('w1')!.accountId = 'A';
  r2.db.prepare("UPDATE runs SET paused_at = ?, paused_by = 'L', pause_mode = 'hard' WHERE id = 'L'").run(T0 - 1000);
  r2.ws.delete('L'); // O's live parent is GONE: the chain dangles ⇒ the bus tree (parent_run_id = L) is the evidence
  r2.clock.now = T0 + 60_000;
  fresh(r2, 'A', usable);
  assert.equal((await evaluateAutoPaused(r2.deps))[0].why, 'ancestor-paused');
  const r3 = rig({ L: OFF });
  pausedByLimit(r3, { account: 'A' });
  r3.ws.get('w1')!.accountId = 'A';
  r3.db.prepare("UPDATE runs SET paused_at = ?, paused_by = 'L', pause_mode = 'hard' WHERE id = 'L'").run(T0 - 1000); // a STALE column on a switch-OFF run
  r3.clock.now = T0 + 60_000;
  fresh(r3, 'A', usable);
  assert.equal((await evaluateAutoPaused(r3.deps))[0].action, 'reprise');
});

test('REPRISE store not ready: with the workspace store unloaded every trigger would read as deleted — nothing is evaluated', async () => {
  const r = rig();
  pausedByLimit(r, { account: 'A' });
  r.ws.get('w1')!.accountId = 'A';
  r.clock.now = T0 + 60_000;
  fresh(r, 'A', usable);
  r.storeReady = false;
  assert.deepEqual(await evaluateAutoPaused(r.deps), []);
  assert.equal(r.calls.reprise.length, 0);
  r.storeReady = true;
  assert.equal((await evaluateAutoPaused(r.deps))[0].action, 'reprise');
});

// ─── reviewer-e3 fix round ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
test('PAUSE wake guard (M1): a carrier whose frozen `wake` switch is OFF gets NO auto Pause — nothing is written (= master), and no farther run is paused instead', () => {
  const r = rig({ O: { ...DEFAULT_BUS_SWITCHES, pause: true, wake: false } });
  const before = allRuns(r.db);
  assert.equal(limitStop(r, 'w1', { account: 'A' }), 'no-wake');
  assert.equal(allRuns(r.db), before, 'runs table byte-identical');
  assert.equal(runRow(r.db, 'L').paused_at, null, 'L (pause+wake ON) is NOT used as a stand-in: the nearest switch-ON run decides');
  assert.deepEqual(autoPausedRuns(r.db), []);
  // control: the same fleet with wake ON pauses (the instrument can see a pause)
  const r2 = rig();
  assert.equal(limitStop(r2, 'w1', { account: 'A' }), 'paused');
});

/** a `reprise` row as E2 sends it (host → coordinator at beginReprise, coordinator → worker at release) */
function repriseRow(r: Rig, to: string, at: number, runId = 'O', kind: 'reprise' | 'status' = 'reprise'): void {
  const seq = bus.send(r.db, { runId, sender: 'host', kind, recipient: to, body: 'Reprise' });
  r.db.prepare('UPDATE messages SET created_at = ? WHERE sequence = ?').run(at, seq);
}

test('MARKERS (m1): a member sent its `reprise` row loses its #74 marker (no second wake); an OLDER row, another recipient or no marker clears nothing; the cursor advances', async () => {
  const r = rig();
  limitStop(r, 'w1', { account: 'A' }); // marker at T0
  limitStop(r, 'w2', { account: 'A' });
  repriseRow(r, 'w1', T0 + 500);
  assert.deepEqual((await clearRepriseDeliveredMarkers(r.deps)).map((e) => e.wsId), ['w1']);
  assert.equal(r.ws.get('w1')!.lastStopReason, undefined);
  assert.equal(r.ws.get('w2')!.lastStopReason, 'usage_limit', 'w2 has not been sent its row');
  const seq = (r.db.prepare('SELECT MAX(sequence) AS m FROM messages').get() as { m: number }).m;
  assert.equal(r.cursor, seq, 'incremental: the cursor is the highest sequence scanned');
  assert.deepEqual(await clearRepriseDeliveredMarkers(r.deps), [], 'nothing new');
  // a row OLDER than the marker says nothing about this limit stop
  const r2 = rig();
  repriseRow(r2, 'w1', T0 - 1000);
  limitStop(r2, 'w1', { account: 'A' }); // marker at T0, after the row
  assert.deepEqual(await clearRepriseDeliveredMarkers(r2.deps), []);
  assert.equal(r2.ws.get('w1')!.lastStopReason, 'usage_limit');
  // recipient matching is case-insensitive (E2 keys on lower-cased ids); a stop recorded in the same ms counts
  const r3 = rig();
  limitStop(r3, 'w1', { account: 'A' });
  repriseRow(r3, 'W1', T0);
  assert.deepEqual((await clearRepriseDeliveredMarkers(r3.deps)).map((e) => e.wsId), ['w1']);
});

test('MARKERS (m1) real flow: beginReprise sends the coordinator its row (its marker goes), the blocked worker keeps its marker until `run release` sends ITS Consigne', async () => {
  const r = rig();
  r.db.prepare("UPDATE runs SET coordinator = 'O' WHERE id = 'O'").run(); // the run's coordinator handle IS its workspace id (real fleets)
  limitStop(r, 'w1', { account: 'A', resetsAtMs: null });
  r.ws.get('O')!.accountId = 'A';
  limitStop(r, 'O', { account: 'A', resetsAtMs: null }); // the OPS itself is limited too (merged into the same pause)
  assert.deepEqual(parsePauseAuto(runRow(r.db, 'O').pause_auto as string, T0)?.wsIds, ['w1', 'O']);
  insertBilan(r.db, { runId: 'O', wsId: 'w1', pausedAt: T0, activity: { surface: 'none' }, snapshotRef: null, dirty: false, killed: [], error: null }); // the host trap finished
  r.db.prepare('UPDATE runs SET pause_trap_at = ? WHERE id = ?').run(T0 + 1_000, 'O');
  r.ws.get('w1')!.accountId = 'A';
  r.clock.now = T0 + 60_000;
  fresh(r, 'A', usable);
  assert.equal((await evaluateAutoPaused(r.deps))[0].outcome, 'resuming');
  const stamp = (at: number) => r.db.prepare("UPDATE messages SET created_at = ? WHERE kind = 'reprise' AND created_at < ?").run(at, at); // the bus stamps real time; the fixture's clock is synthetic
  stamp(T0 + 60_000);
  assert.deepEqual((await clearRepriseDeliveredMarkers(r.deps)).map((e) => e.wsId), ['O'], 'the coordinator was sent its Bilan row at beginReprise: its marker goes in the same tick');
  assert.equal(r.ws.get('w1')!.lastStopReason, 'usage_limit', 'the blocked worker keeps its marker');
  assert.deepEqual(releaseMembers(r.db, 'O', 'O', ['w1'], T0 + 70_000).released, ['w1']);
  stamp(T0 + 70_000);
  assert.deepEqual((await clearRepriseDeliveredMarkers(r.deps)).map((e) => e.wsId), ['w1'], 'its Consigne was sent: the marker goes');
});

test('REPRISE stored reset (m2): the stored reset time only counts WITH the marker that carries it — a restarted trigger (marker cleared, reset left) is not resumed on its old reset + grace', async () => {
  const r = rig();
  pausedByLimit(r, { account: 'A' });
  r.ws.get('w1')!.accountId = 'A';
  r.ws.get('w1')!.lastStopReason = undefined; // setStatus(_, null) cleared the marker…
  r.ws.get('w1')!.usageLimitResetsAt = T0 + 600_000; // …but not the reset time
  r.clock.now = T0 + 600_000 + RESET_GRACE_MS + 1;
  assert.deepEqual(await evaluateAutoPaused(r.deps), [{ runId: 'O', action: 'wait', why: 'quota-not-back' }]);
});

test('REPRISE archived trigger (m2): an archived workspace is GONE — the stored account decides, not the archived one\'s pin', async () => {
  const r = rig();
  pausedByLimit(r, { account: 'B' }); // paused while on B (quota back below)
  r.ws.get('w1')!.accountId = 'A'; // the archived record is pinned to A, which is still limited
  r.ws.get('w1')!.archived = true;
  r.clock.now = T0 + 60_000;
  fresh(r, 'A', limited(T0 + 3_600_000));
  fresh(r, 'B', usable);
  assert.equal((await evaluateAutoPaused(r.deps))[0].action, 'reprise');
});

// ─── reviewer-e3-r2 fix round ───────────────────────────────────────────────────────────────────────────────────────────────────────────
test('PAUSE wake guard (N1): EVERY run of the carrier\'s subtree needs wake ON — a deeper run with pause OFF / wake OFF stops the auto Pause (its coordinator could not be woken), a sibling run too', () => {
  const nested = rig({ O: { ...DEFAULT_BUS_SWITCHES, pause: false, wake: false } }); // L pause+wake ON (the carrier), child OPS run O pause OFF / wake OFF
  const before = allRuns(nested.db);
  assert.equal(limitStop(nested, 'w1', { account: 'A' }), 'no-wake');
  assert.equal(allRuns(nested.db), before, 'runs table byte-identical');
  const sibling = rig({ X: { ...DEFAULT_BUS_SWITCHES, pause: false, wake: false } }); // O is the carrier of w1 (subtree [O]); X is not below it ⇒ allowed
  assert.equal(limitStop(sibling, 'w1', { account: 'A' }), 'paused');
  const above = rig({ X: { ...DEFAULT_BUS_SWITCHES, pause: false, wake: false }, O: OFF }); // carrier L (O pause OFF): the subtree is L, O, X ⇒ X wake OFF stops it
  assert.equal(limitStop(above, 'w1', { account: 'A' }), 'no-wake');
  const allOn = rig({ O: { ...DEFAULT_BUS_SWITCHES, pause: false, wake: true } }); // control: every wake ON ⇒ L pauses
  assert.equal(limitStop(allOn, 'w1', { account: 'A' }), 'paused');
  assert.equal(runRow(allOn.db, 'L').paused_at, T0);
});

test('MARKERS wake (N2): a `reprise` row only clears the marker when ITS run has wake ON (else nothing would deliver it — #74\'s nudge stays the only restart); a wake-ON row still clears after a wake-OFF one', async () => {
  const off = rig({ O: { ...DEFAULT_BUS_SWITCHES, pause: true, wake: false } });
  off.ws.get('w1')!.lastStopReason = 'usage_limit';
  off.ws.get('w1')!.lastStopReasonAt = T0;
  repriseRow(off, 'w1', T0 + 500, 'O'); // run O: wake OFF
  assert.deepEqual(await clearRepriseDeliveredMarkers(off.deps), []);
  assert.equal(off.ws.get('w1')!.lastStopReason, 'usage_limit');
  const on = rig();
  on.ws.get('w1')!.lastStopReason = 'usage_limit';
  on.ws.get('w1')!.lastStopReasonAt = T0;
  on.ws.set('x2', { id: 'x2', parentId: 'X' });
  on.ws.get('x2')!.lastStopReason = 'usage_limit';
  on.ws.get('x2')!.lastStopReasonAt = T0;
  repriseRow(on, 'x2', T0 + 400, 'X');
  assert.deepEqual((await clearRepriseDeliveredMarkers(on.deps)).map((e) => e.wsId), ['x2']);
  // a wake-OFF row first, a wake-ON row later for the same member: the later one clears (the skipped one did not consume the marker)
  const two = rig({ O: { ...DEFAULT_BUS_SWITCHES, pause: true, wake: false } });
  two.ws.get('w1')!.lastStopReason = 'usage_limit';
  two.ws.get('w1')!.lastStopReasonAt = T0;
  repriseRow(two, 'w1', T0 + 500, 'O');
  repriseRow(two, 'w1', T0 + 600, 'X');
  assert.deepEqual((await clearRepriseDeliveredMarkers(two.deps)).map((e) => e.wsId), ['w1']);
});

test('MARKERS kind (N4): only a `reprise` row clears a marker — any other mail to a limit-stopped member does not', async () => {
  const r = rig();
  limitStop(r, 'w1', { account: 'A' });
  repriseRow(r, 'w1', T0 + 500, 'O', 'status');
  assert.deepEqual(await clearRepriseDeliveredMarkers(r.deps), []);
  assert.equal(r.ws.get('w1')!.lastStopReason, 'usage_limit');
});

// ─── reviewer-e3-r3 fix round: the wake guard follows the Reprise's OWN addressees ──────────────────────────────────────────────────────
const WAKE_OFF: BusSwitches = { ...DEFAULT_BUS_SWITCHES, pause: false, wake: false };
const wakeOffRun = (r: Rig, id: string, parentRun: string | null = null): void => void busRuns.startRun(r.db, { id, kind: 'vague', coordinator: id, ...(parentRun ? { parentRunId: parentRun } : {}) }, WAKE_OFF);

test('PAUSE wake guard (R3-1): an OPS created top-level (bus parent_run_id NULL, wake OFF) and ATTACHED under the carrier in the LIVE tree is an addressee — no auto Pause; wake ON ⇒ paused', () => {
  const r = rig();
  wakeOffRun(r, 'Z'); // bus run with NO parent: the bus subtree of L does not contain it
  r.ws.set('Z', { id: 'Z', parentId: 'L', canOrchestrate: true }); // …but the live tree attached it under L
  r.ws.set('wz', { id: 'wz', parentId: 'Z' });
  assert.deepEqual(busSubtree(r), ['L', 'O', 'X'], 'the bus subtree misses Z (write-once parent_run_id)');
  const before = allRuns(r.db);
  assert.equal(limitStop(r, 'wz', { account: 'A' }), 'no-wake');
  assert.equal(allRuns(r.db), before, 'runs table byte-identical');
  assert.deepEqual(wakeOffAddressees(r.db, r.deps, 'L'), [{ wsId: 'Z', runId: 'Z' }]);
  // control: the same re-attached OPS with wake ON ⇒ the auto Pause lands
  const ok = rig();
  busRuns.startRun(ok.db, { id: 'Z', kind: 'vague', coordinator: 'Z' }, { ...DEFAULT_BUS_SWITCHES, pause: false, wake: true });
  ok.ws.set('Z', { id: 'Z', parentId: 'L', canOrchestrate: true });
  ok.ws.set('wz', { id: 'wz', parentId: 'Z' });
  assert.equal(limitStop(ok, 'wz', { account: 'A' }), 'paused');
});

function busSubtree(r: Rig): string[] {
  return (r.db.prepare("WITH RECURSIVE t(id) AS (SELECT 'L' UNION ALL SELECT r.id FROM runs r JOIN t ON r.parent_run_id = t.id) SELECT id FROM t").all() as Array<{ id: string }>).map((x) => x.id).sort();
}

test('PAUSE wake guard (R3-2): historical / deleted / archived runs are not addressees — a wake-OFF bus run of a workspace that no longer exists does not stop the auto Pause', () => {
  const r = rig();
  wakeOffRun(r, 'H', 'O'); // a run row of a DELETED OPS workspace (not in the store): wake OFF, under the carrier O
  assert.equal(limitStop(r, 'w1', { account: 'A' }), 'paused', 'nobody to wake there');
  const arch = rig();
  wakeOffRun(arch, 'Y', 'O'); // an ARCHIVED OPS under the carrier
  arch.ws.set('Y', { id: 'Y', parentId: 'O', canOrchestrate: true, archived: true });
  assert.equal(limitStop(arch, 'w1', { account: 'A' }), 'paused');
  const live = rig();
  wakeOffRun(live, 'Y', 'O'); // control: the same OPS, alive ⇒ addressed ⇒ blocks
  live.ws.set('Y', { id: 'Y', parentId: 'O', canOrchestrate: true });
  assert.equal(limitStop(live, 'w1', { account: 'A' }), 'no-wake');
});

test('PAUSE wake guard: `no-wake` is WARNED once per carrier naming the addressee and its run — repeated limit stops do not repeat the line', () => {
  const r = rig();
  wakeOffRun(r, 'Zc', 'O');
  r.ws.set('Zc', { id: 'Zc', parentId: 'O', canOrchestrate: true });
  assert.equal(limitStop(r, 'w1', { account: 'A' }), 'no-wake');
  assert.equal(limitStop(r, 'w2', { account: 'A' }), 'no-wake');
  const warns = r.calls.logs.filter((l) => l.startsWith('WARN pause-auto:') && l.includes('NOT auto-paused'));
  assert.equal(warns.length, 1);
  assert.ok(warns[0].includes('Zc (run Zc, wake OFF)') && warns[0].includes('run O'), warns[0]);
});

test('INTEGRATION addressees: `repriseAddressees` = exactly the recipients (and runs) of the `reprise` rows beginReprise sends the coordinators — one enumeration', async () => {
  const r = rig();
  busRuns.startRun(r.db, { id: 'Zc', kind: 'vague', coordinator: 'Zc', parentRunId: 'O' }, { ...DEFAULT_BUS_SWITCHES, pause: false, wake: true });
  r.ws.set('Zc', { id: 'Zc', parentId: 'O', canOrchestrate: true });
  r.ws.set('wc', { id: 'wc', parentId: 'Zc' });
  pausedByLimit(r, { account: 'A' });
  r.ws.get('w1')!.accountId = 'A';
  const planned = repriseAddressees(r.db, 'O', ['O', 'Zc']).map((a) => `${a.wsId}@${a.runId}`).sort();
  assert.deepEqual(planned, ['O@O', 'Zc@Zc']);
  r.clock.now = T0 + 60_000;
  fresh(r, 'A', usable);
  assert.equal((await evaluateAutoPaused(r.deps))[0].outcome, 'resuming');
  const sent = (r.db.prepare("SELECT recipient, run_id FROM messages WHERE kind = 'reprise' ORDER BY sequence").all() as Array<{ recipient: string; run_id: string }>).map((m) => `${m.recipient}@${m.run_id}`).sort();
  assert.deepEqual(sent, planned);
});

test('REPRISE no-wake addressee (re-check): a wake-OFF run created/attached AFTER the pause HOLDS the Reprise — warned + ONE escalation to the carrier\'s coordinator — and releases it once the run is gone', async () => {
  const r = rig();
  pausedByLimit(r, { account: 'A' }); // paused with every addressee wake ON
  r.ws.get('w1')!.accountId = 'A';
  wakeOffRun(r, 'Zc', 'O'); // a wake-OFF OPS appears under O afterwards
  r.ws.set('Zc', { id: 'Zc', parentId: 'O', canOrchestrate: true });
  r.clock.now = T0 + 60_000;
  fresh(r, 'A', usable);
  assert.deepEqual(await evaluateAutoPaused(r.deps), [{ runId: 'O', action: 'wait', why: 'no-wake-addressee' }]);
  assert.equal(r.calls.reprise.length, 0, 'no Reprise nobody would receive');
  const esc = () => r.db.prepare("SELECT sender, recipient, run_id, body FROM messages WHERE kind = 'escalation'").all() as Array<{ sender: string; recipient: string; run_id: string; body: string }>;
  assert.equal(esc().length, 1);
  assert.deepEqual([esc()[0].sender, esc()[0].recipient, esc()[0].run_id], ['host', 'O', 'O']);
  assert.ok(esc()[0].body.includes('Zc (run Zc)') && esc()[0].body.includes('orchestra run resume --run O'));
  assert.equal(r.calls.logs.filter((l) => l.startsWith('WARN pause-auto:') && l.includes('Reprise HELD')).length, 1);
  await evaluateAutoPaused(r.deps);
  assert.equal(esc().length, 1, 'ONE escalation per carrier + epoch');
  assert.equal(runRow(r.db, 'O').resume_started_at, null, 'the run stays PAUSED');
  r.ws.delete('Zc'); // the offending OPS is removed ⇒ the next tick Reprises
  assert.equal((await evaluateAutoPaused(r.deps))[0].action, 'reprise');
});

test('PAUSE wake guard (bus fallback): an OPS whose live chain DANGLES (its parent workspace was deleted) is known only through the bus subtree — still an addressee (wake OFF ⇒ no-wake), unless archived or wake ON', () => {
  const mk = (q: 'off' | 'on' | 'archived'): Rig => {
    const r = rig();
    r.ws.delete('O'); // the OPS workspace between L and Q was deleted (its run row stays)
    busRuns.startRun(r.db, { id: 'Q', kind: 'vague', coordinator: 'Q', parentRunId: 'O' }, { ...DEFAULT_BUS_SWITCHES, pause: false, wake: q === 'on' }); // the archived variant is wake OFF too: only the archived filter can save it
    r.ws.set('Q', { id: 'Q', parentId: 'O', canOrchestrate: true, ...(q === 'archived' ? { archived: true } : {}) }); // chain Q → O (gone) dangles
    r.ws.set('wl', { id: 'wl', parentId: 'L' });
    return r;
  };
  const off = mk('off');
  assert.equal(limitStop(off, 'wl', { account: 'A' }), 'no-wake');
  assert.deepEqual(wakeOffAddressees(off.db, off.deps, 'L'), [{ wsId: 'Q', runId: 'Q' }]);
  assert.equal(limitStop(mk('on'), 'wl', { account: 'A' }), 'paused');
  assert.equal(limitStop(mk('archived'), 'wl', { account: 'A' }), 'paused', 'an archived workspace is nobody to wake');
});
