// #254 Pause douce — the writer, the escalation, the accusés, the host sweep, the trap's roster half and the hook delivery, over a REAL
// bus.sqlite (MIGRATIONS[10]) with the session layer faked. Expectations are literals. Each arm names the in-place mutant it kills
// (scripts/pause-trap/mutants-douce-unit.mjs).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as bus from './bus.ts';
import * as busRuns from './bus-runs.ts';
import { activePauseFor, getRunPause, runsOwingPauseTrap, setRunPause } from './bus-pause.ts';
import {
  carrierFromRoster,
  busStatusPausePayload,
  carrierPhase,
  confirmMember,
  confirmPauseFor,
  escalateSoftPause,
  listRoster,
  pauseOrderFiles,
  pauseStatusView,
  sweepSoftPauses,
  __resetPauseDouceForTests,
} from './pause-douce.ts';
import { __resetPauseTrapForTests, armPausedMembers, onTurnStart, runPauseTrap, stopPauseTrap, sweepPauseTrap, type TrapDeps, type TrapMember } from './pause-trap.ts';
import { renderPauseOrder, renderPauseRosterLine, renderPauseStatusLine } from '../shared/pause-douce.ts';
import { pauseRosterSummary, SOFT_PAUSE_DEADLINE_MS } from '../shared/pause-lifecycle.ts';
import { DEFAULT_BUS_SWITCHES, type BusSwitches } from '../shared/bus-switches.ts';

const ROOT = path.join(os.homedir(), '.cache', `pause-douce-${process.pid}`);
const ON: BusSwitches = { ...DEFAULT_BUS_SWITCHES, pause: true };
const OFF: BusSwitches = { ...DEFAULT_BUS_SWITCHES };
let n = 0;
test.after(() => fs.rmSync(ROOT, { recursive: true, force: true }));

interface Rig {
  db: bus.BusDb;
  dir: string;
  clock: number;
  roster: TrapMember[];
  running: Map<string, boolean | 'throw' | 'unknown'>;
  interrupts: string[];
  orders: Map<string, string>;
  removed: string[];
  pruned: Array<string[]>;
  storeReady: boolean;
  deps: TrapDeps;
}

/** lead(M, coordinator lead-ws) ⊃ ops(W, coordinator ops-ws) ⊃ workers w1 w2; X unrelated. */
function rig(t: { after: (fn: () => void) => void }, sw: BusSwitches = ON): Rig {
  fs.mkdirSync(ROOT, { recursive: true });
  const dir = path.join(ROOT, `r${n++}`);
  fs.mkdirSync(dir, { recursive: true });
  const db = bus.openBus(path.join(dir, 'bus.sqlite'));
  t.after(() => {
    try {
      db.close();
    } catch {
      /* closed */
    }
  });
  busRuns.startRun(db, { id: 'M', kind: 'mission', coordinator: 'lead-ws' }, sw);
  busRuns.startRun(db, { id: 'W', kind: 'vague', coordinator: 'ops-ws', parentRunId: 'M' }, sw);
  busRuns.startRun(db, { id: 'X', kind: 'vague', coordinator: 'x-ops' }, sw);
  __resetPauseTrapForTests();
  __resetPauseDouceForTests();
  const r = { db, dir, clock: 1_000_000, roster: [] as TrapMember[], running: new Map(), orders: new Map(), removed: [] as string[], pruned: [] as string[][], storeReady: true, interrupts: [] as string[] } as Rig;
  r.deps = {
    getBus: () => db,
    now: () => r.clock,
    members: (runIds) => r.roster.filter((m) => runIds.includes(m.runId)),
    activityOf: async (m) => {
      const v = r.running.get(m.wsId);
      if (v === 'throw') throw new Error('probe failed');
      if (v === 'unknown') return { surface: 'none', turnRunning: false, unknown: true, inFlightTools: [], bgTasks: [] };
      return { surface: 'sdk', turnRunning: v ?? false, inFlightTools: [], bgTasks: [] };
    },
    storeReady: () => r.storeReady,
    pauseOrders: {
      write: (ws, text) => void r.orders.set(ws, text),
      remove: (ws) => void (r.orders.delete(ws), r.removed.push(ws)),
      prune: (keep) => {
        r.pruned.push([...keep].sort());
        for (const ws of [...r.orders.keys()]) if (!keep.has(ws)) r.orders.delete(ws);
      },
    },
    interrupt: async (m) => (r.interrupts.push(m.wsId), 'interrupted'),
    cliOf: async () => null,
    snapshot: async () => {
      throw new Error('snapshot not faked here');
    },
    killTrees: async () => {
      throw new Error('kill not faked here');
    },
    sleep: async () => {},
    settleMs: 0,
    originWaitMs: 0,
  } as TrapDeps;
  return r;
}

const mem = (r: Rig, wsId: string, runId: string, running: boolean | 'throw' | 'unknown', o: Partial<TrapMember> = {}): TrapMember => {
  const m: TrapMember = { wsId, runId, worktreePath: path.join(r.dir, wsId), remote: false, status: 'running', lastTask: null, ...o };
  r.roster.push(m);
  r.running.set(wsId, running);
  return m;
};

const rows = (r: Rig, kind: string) =>
  r.db.prepare('SELECT run_id, sender, recipient, kind, body FROM messages WHERE kind = ? ORDER BY sequence').all(kind) as Array<{ run_id: string; sender: string; recipient: string; kind: string; body: string }>;
const changes = (r: Rig): number => Number((r.db.prepare('SELECT total_changes() AS c').get() as { c: number }).c);

// ── the writer + the state machine ──────────────────────────────────────────

test('WRITER soft: `run pause` (soft) writes mode=soft + deadline = paused_at + 3 min, nothing escalated; hard writes no deadline', (t) => {
  const r = rig(t);
  assert.equal(setRunPause(r.db, 'W', true, 'ops-ws', 'soft'), 'paused');
  const p = getRunPause(r.db, 'W')!;
  assert.equal(p.mode, 'soft');
  assert.equal(p.deadlineAt, p.pausedAt + 180_000);
  assert.equal(p.deadlineAt, p.pausedAt + SOFT_PAUSE_DEADLINE_MS);
  assert.equal(p.escalatedAt, null);
  assert.equal(carrierPhase(r.db, 'W'), 'pausing');
  assert.equal(setRunPause(r.db, 'M', true, 'lead-ws'), 'paused');
  const h = getRunPause(r.db, 'M')!;
  assert.equal(h.mode, 'hard');
  assert.equal(h.deadlineAt, null);
  assert.equal(carrierPhase(r.db, 'M'), 'paused');
});

test('WRITER switch OFF: a soft pause is REFUSED and writes none of the new columns (identical to hard)', (t) => {
  const r = rig(t, OFF);
  assert.equal(setRunPause(r.db, 'W', true, 'ops-ws', 'soft'), 'switch-off');
  const row = r.db.prepare('SELECT paused_at, pause_mode, pause_deadline_at, pause_escalated_at FROM runs WHERE id = ?').get('W') as Record<string, unknown>;
  assert.deepEqual(row, { paused_at: null, pause_mode: null, pause_deadline_at: null, pause_escalated_at: null });
  assert.equal(r.db.prepare('SELECT COUNT(*) AS c FROM pause_members').get()?.c, 0);
});

test('WRITER: a repeat soft pause keeps the original time/deadline; `--hard` over a douce that is still waiting ESCALATES; over an escalated one it is already-paused', (t) => {
  const r = rig(t);
  assert.equal(setRunPause(r.db, 'W', true, 'ops-ws', 'soft'), 'paused');
  const first = getRunPause(r.db, 'W')!;
  assert.equal(setRunPause(r.db, 'W', true, 'lead-ws', 'soft'), 'already-paused');
  assert.deepEqual([getRunPause(r.db, 'W')!.pausedAt, getRunPause(r.db, 'W')!.deadlineAt], [first.pausedAt, first.deadlineAt]);
  assert.equal(runsOwingPauseTrap(r.db).length, 0, 'a waiting douce owes no trap');
  assert.equal(setRunPause(r.db, 'W', true, 'ops-ws', 'hard'), 'escalated');
  const e = getRunPause(r.db, 'W')!;
  assert.equal(e.mode, 'hard');
  assert.ok(e.escalatedAt !== null && e.escalatedAt !== undefined, 'escalated_at stamped');
  assert.equal(e.pausedAt, first.pausedAt, 'same epoch');
  assert.equal(runsOwingPauseTrap(r.db).length, 1, 'the trap is now owed');
  assert.equal(setRunPause(r.db, 'W', true, 'ops-ws', 'hard'), 'already-paused');
});

test('WRITER lift: `run resume` clears EVERY pause column (a later hard pause must not inherit a stale deadline / escalation)', (t) => {
  const r = rig(t);
  setRunPause(r.db, 'W', true, 'ops-ws', 'soft');
  const p = getRunPause(r.db, 'W')!;
  assert.ok(escalateSoftPause(r.db, 'W', p.pausedAt, p.pausedAt + 5));
  r.db.prepare('UPDATE runs SET resume_started_at = 7, pause_auto = ? WHERE id = ?').run('{"reason":"usage_limit"}', 'W');
  assert.equal(setRunPause(r.db, 'W', false, 'ops-ws'), 'lifted');
  const row = r.db.prepare('SELECT paused_at, pause_mode, pause_trap_at, pause_deadline_at, pause_escalated_at, resume_started_at, pause_auto FROM runs WHERE id = ?').get('W');
  assert.deepEqual(row, { paused_at: null, pause_mode: null, pause_trap_at: null, pause_deadline_at: null, pause_escalated_at: null, resume_started_at: null, pause_auto: null });
  assert.equal(setRunPause(r.db, 'W', true, 'ops-ws', 'hard'), 'paused');
  assert.equal(getRunPause(r.db, 'W')!.escalatedAt, null, 'the new hard pause starts clean');
});

test('TRAP OWED (runsOwingPauseTrap ← trapOwed): hard at once; soft only once escalated; never while resuming; OFF switch never', (t) => {
  const r = rig(t);
  setRunPause(r.db, 'M', true, 'lead-ws', 'hard');
  setRunPause(r.db, 'W', true, 'ops-ws', 'soft');
  assert.deepEqual(runsOwingPauseTrap(r.db).map((c) => c.runId).sort(), ['M'], 'hard owes at once, the waiting douce does not');
  const w = getRunPause(r.db, 'W')!;
  escalateSoftPause(r.db, 'W', w.pausedAt, w.pausedAt + 1);
  assert.deepEqual(runsOwingPauseTrap(r.db).map((c) => c.runId).sort(), ['M', 'W']);
  r.db.prepare('UPDATE runs SET resume_started_at = 9 WHERE id = ?').run('W');
  assert.deepEqual(runsOwingPauseTrap(r.db).map((c) => c.runId).sort(), ['M'], 'resuming owes nothing');
  r.db.prepare('UPDATE run_flags SET flags = ? WHERE run_id = ?').run(JSON.stringify({ ...OFF }), 'M');
  assert.equal(runsOwingPauseTrap(r.db).length, 0, 'a carrier whose frozen pause switch is OFF is inert');
});

test('ESCALATE is guarded: wrong epoch, not soft, already escalated, or resuming ⇒ no write', (t) => {
  const r = rig(t);
  setRunPause(r.db, 'W', true, 'ops-ws', 'soft');
  const p = getRunPause(r.db, 'W')!;
  assert.equal(escalateSoftPause(r.db, 'W', p.pausedAt - 1, 5), false, 'a stale epoch cannot escalate the new pause');
  assert.equal(escalateSoftPause(r.db, 'W', p.pausedAt, 5), true);
  assert.equal(escalateSoftPause(r.db, 'W', p.pausedAt, 6), false, 'once');
  assert.equal(getRunPause(r.db, 'W')!.escalatedAt, 5);
  setRunPause(r.db, 'M', true, 'lead-ws', 'hard');
  assert.equal(escalateSoftPause(r.db, 'M', getRunPause(r.db, 'M')!.pausedAt, 5), false, 'a hard pause has nothing to escalate');
});

// ── the host sweep ──────────────────────────────────────────────────────────

test('SWEEP: a member with a turn RUNNING gets ONE `pause` row from the host (+ its order); an idle member is confirmed `host-idle` with no row; roles come from runs.coordinator', async (t) => {
  const r = rig(t);
  mem(r, 'ops-ws', 'W', true);
  mem(r, 'w1', 'W', true);
  mem(r, 'w2', 'W', false);
  mem(r, 'x1', 'X', true); // unrelated run: never touched
  setRunPause(r.db, 'W', true, 'lead-ws', 'soft');
  const c = getRunPause(r.db, 'W')!;
  const { summaries, dueAt } = await sweepSoftPauses(r.deps);
  assert.equal(summaries.length, 1);
  assert.deepEqual([summaries[0].members, summaries[0].confirmed, summaries[0].notified, summaries[0].escalated], [3, 1, 2, null]);
  assert.equal(dueAt, c.deadlineAt);
  const sent = rows(r, 'pause');
  assert.deepEqual(sent.map((x) => [x.run_id, x.sender, x.recipient]).sort(), [['W', 'host', 'ops-ws'], ['W', 'host', 'w1']]);
  assert.match(sent[0].body, /PAUSE DOUCE — run W/);
  assert.match(sent[0].body, /orchestra run confirm pause/);
  assert.deepEqual([...r.orders.keys()].sort(), ['ops-ws', 'w1']);
  assert.equal(r.orders.get('w1'), renderPauseOrder({ carrierRunId: 'W', deadlineAt: c.deadlineAt! }));
  const roster = listRoster(r.db, 'W', c.pausedAt);
  assert.deepEqual(roster.map((x) => [x.wsId, x.role, x.memberRun, x.pauseConfirmVia]), [['ops-ws', 'coordinator', 'W', null], ['w1', 'worker', 'W', null], ['w2', 'worker', 'W', 'host-idle']]);
  assert.equal(getRunPause(r.db, 'W')!.escalatedAt, null, 'waiting');
  assert.equal(listRoster(r.db, 'W', c.pausedAt).some((x) => x.wsId === 'x1'), false);
});

test('SWEEP is idempotent and WRITE-QUIET: a second pass sends nothing, orders nothing, and changes zero rows (a write would re-trigger the bus-dir watcher forever)', async (t) => {
  const r = rig(t);
  mem(r, 'w1', 'W', true);
  mem(r, 'w2', 'W', false);
  setRunPause(r.db, 'W', true, 'ops-ws', 'soft');
  await sweepSoftPauses(r.deps);
  const sentBefore = rows(r, 'pause').length;
  const before = changes(r);
  r.orders.clear();
  const again = await sweepSoftPauses(r.deps);
  assert.equal(again.summaries[0].notified, 0);
  assert.equal(rows(r, 'pause').length, sentBefore, 'no second pause row');
  assert.equal(r.orders.size, 0, 'no second order');
  assert.equal(changes(r), before, 'zero rows changed by the quiet pass');
});

test('ESCALATION all-confirmed: partial accusés do NOT escalate; the last one does — and the trap becomes owed (accusé COUNT is what gates it)', async (t) => {
  const r = rig(t);
  mem(r, 'w1', 'W', true);
  mem(r, 'w2', 'W', true);
  mem(r, 'w3', 'W', true);
  setRunPause(r.db, 'W', true, 'ops-ws', 'soft');
  const p = getRunPause(r.db, 'W')!;
  await sweepSoftPauses(r.deps);
  confirmMember(r.db, 'W', p.pausedAt, { wsId: 'w1', memberRun: 'W' }, 'member', r.clock);
  confirmMember(r.db, 'W', p.pausedAt, { wsId: 'w2', memberRun: 'W' }, 'member', r.clock);
  let out = await sweepSoftPauses(r.deps);
  assert.equal(out.summaries[0].confirmed, 2);
  assert.equal(out.summaries[0].escalated, null, '2 of 3 confirmed must not escalate');
  assert.equal(runsOwingPauseTrap(r.db).length, 0);
  assert.deepEqual(pauseStatusView(r.db, 'W')!.summary, { phase: 'pausing', total: 3, done: 2, missing: ['w3'] });
  confirmMember(r.db, 'W', p.pausedAt, { wsId: 'w3', memberRun: 'W' }, 'member', r.clock);
  out = await sweepSoftPauses(r.deps);
  assert.equal(out.summaries[0].escalated, 'all-confirmed');
  assert.equal(out.dueAt, null);
  assert.equal(runsOwingPauseTrap(r.db).length, 1, 'the #252 trap is owed once escalated');
  assert.equal(getRunPause(r.db, 'W')!.escalatedAt, r.clock);
  assert.deepEqual(r.orders.size, 0, 'an escalated douce leaves no order behind');
  assert.equal((await sweepSoftPauses(r.deps)).summaries.length, 0, 'an escalated carrier is not swept again');
});

test('ESCALATION deadline: a member that never answers is left unconfirmed, and the escalation lands exactly when the clock reaches paused_at + 3 min', async (t) => {
  const r = rig(t);
  mem(r, 'w1', 'W', true);
  mem(r, 'w2', 'W', false);
  setRunPause(r.db, 'W', true, 'ops-ws', 'soft');
  const p = getRunPause(r.db, 'W')!;
  r.clock = p.pausedAt + 179_999;
  let out = await sweepSoftPauses(r.deps);
  assert.equal(out.summaries[0].escalated, null, '1 ms before the deadline');
  assert.equal(out.dueAt, p.deadlineAt);
  r.clock = p.pausedAt + 180_000;
  out = await sweepSoftPauses(r.deps);
  assert.equal(out.summaries[0].escalated, 'deadline');
  const w1 = listRoster(r.db, 'W', p.pausedAt).find((x) => x.wsId === 'w1')!;
  assert.equal(w1.pauseConfirmedAt, null, 'the straggler is NOT recorded confirmed by the escalation — only the trap does');
  assert.equal(runsOwingPauseTrap(r.db).length, 1);
});

test('UNKNOWN is not NONE: an unreadable activity is treated as RUNNING (order sent, never host-idle); an unloaded store enumerates nobody and never escalates on "all confirmed"', async (t) => {
  const r = rig(t);
  mem(r, 'w1', 'W', 'throw');
  setRunPause(r.db, 'W', true, 'ops-ws', 'soft');
  const p = getRunPause(r.db, 'W')!;
  const out = await sweepSoftPauses(r.deps);
  assert.equal(out.summaries[0].notified, 1, 'order sent despite the failed probe');
  assert.equal(listRoster(r.db, 'W', p.pausedAt)[0].pauseConfirmVia, null, 'not confirmed host-idle on a failed read');
  const q = rig(t);
  mem(q, 'w1', 'W', false);
  q.storeReady = false;
  setRunPause(q.db, 'W', true, 'ops-ws', 'soft');
  const o2 = await sweepSoftPauses(q.deps);
  assert.equal(o2.summaries[0].members, 0);
  assert.equal(o2.summaries[0].escalated, null, 'zero members from an UNLOADED store is not "everyone confirmed"');
  q.clock = getRunPause(q.db, 'W')!.deadlineAt!;
  assert.equal((await sweepSoftPauses(q.deps)).summaries[0].escalated, 'deadline', 'the deadline still escalates (the trap then waits for the store)');
});

test('REMOTE (sandbox) members have no turn the host can reach: confirmed host-idle at once, no order', async (t) => {
  const r = rig(t);
  mem(r, 'sb', 'W', true, { remote: true });
  setRunPause(r.db, 'W', true, 'ops-ws', 'soft');
  const out = await sweepSoftPauses(r.deps);
  assert.equal(out.summaries[0].escalated, 'all-confirmed');
  assert.equal(rows(r, 'pause').length, 0);
});

test('SWITCH OFF: a stale soft pause on a carrier whose frozen switch is OFF is never swept — no rows, no roster, no escalation', async (t) => {
  const r = rig(t);
  mem(r, 'w1', 'W', true);
  setRunPause(r.db, 'W', true, 'ops-ws', 'soft');
  r.db.prepare('UPDATE run_flags SET flags = ? WHERE run_id = ?').run(JSON.stringify({ ...OFF }), 'W');
  const out = await sweepSoftPauses(r.deps);
  assert.deepEqual(out, { summaries: [], dueAt: null });
  assert.equal(rows(r, 'pause').length, 0);
  assert.equal(r.db.prepare('SELECT COUNT(*) AS c FROM pause_members').get()?.c, 0);
  assert.equal(activePauseFor(r.db, 'W'), null);
});

test('PRUNE: only the orders of members still waited on survive a sweep (a lift mid-douce / a confirmed member leaves none)', async (t) => {
  const r = rig(t);
  mem(r, 'w1', 'W', true);
  mem(r, 'w2', 'W', true);
  setRunPause(r.db, 'W', true, 'ops-ws', 'soft');
  const p = getRunPause(r.db, 'W')!;
  await sweepSoftPauses(r.deps);
  assert.deepEqual(r.pruned.at(-1), ['w1', 'w2']);
  confirmMember(r.db, 'W', p.pausedAt, { wsId: 'w1', memberRun: 'W' }, 'member', r.clock);
  await sweepSoftPauses(r.deps);
  assert.deepEqual(r.pruned.at(-1), ['w2']);
  assert.deepEqual([...r.orders.keys()], ['w2']);
  setRunPause(r.db, 'W', false, 'ops-ws');
  await sweepSoftPauses(r.deps);
  assert.deepEqual(r.pruned.at(-1), [], 'lifted: nothing is waited on');
  assert.equal(r.orders.size, 0);
});

test('SWEEP: a SECOND pause of the same run notifies again (the epoch scopes the "already sent" dedupe); a HARD pause is never swept by the douce pass', async (t) => {
  const r = rig(t);
  mem(r, 'w1', 'W', true);
  setRunPause(r.db, 'W', true, 'ops-ws', 'soft');
  await sweepSoftPauses(r.deps);
  assert.equal(rows(r, 'pause').length, 1);
  setRunPause(r.db, 'W', false, 'ops-ws');
  r.clock += 10;
  await new Promise((res) => setTimeout(res, 5)); // a distinct created_at (Date.now) for the second epoch
  setRunPause(r.db, 'W', true, 'ops-ws', 'soft');
  await sweepSoftPauses(r.deps);
  assert.equal(rows(r, 'pause').length, 2, 'the new epoch gets its own order — the first epoch\'s row must not suppress it');
  const h = rig(t);
  mem(h, 'w1', 'W', true);
  setRunPause(h.db, 'W', true, 'ops-ws', 'hard');
  assert.deepEqual(await sweepSoftPauses(h.deps), { summaries: [], dueAt: null });
  assert.equal(rows(h, 'pause').length, 0, 'a hard pause sends no douce order');
  assert.equal(h.db.prepare('SELECT COUNT(*) AS c FROM pause_members').get()?.c, 0, 'and enrols nobody from the douce pass');
});

test('PRUNE is skipped when a carrier was not fully read this pass (a throwing step must not delete the orders of members still being waited on)', async (t) => {
  const r = rig(t);
  mem(r, 'w1', 'W', true);
  setRunPause(r.db, 'W', true, 'ops-ws', 'soft');
  await sweepSoftPauses(r.deps);
  assert.deepEqual([...r.orders.keys()], ['w1']);
  const real = r.deps.members;
  r.deps.members = () => {
    throw new Error('store hiccup');
  };
  const out = await sweepSoftPauses(r.deps);
  assert.equal(out.summaries.length, 0, 'the step threw');
  assert.deepEqual([...r.orders.keys()], ['w1'], 'its order is still there');
  assert.notEqual(out.dueAt, null, 'and the deadline is still pending');
  r.deps.members = real;
});

test('DEADLINE TIMER: sweepPauseTrap arms a one-shot timer at the pending deadline — the escalation lands without any other trigger', async (t) => {
  const r = rig(t);
  r.deps.now = () => Date.now();
  mem(r, 'w1', 'W', true);
  setRunPause(r.db, 'W', true, 'ops-ws', 'soft');
  const p = getRunPause(r.db, 'W')!;
  r.db.prepare('UPDATE runs SET pause_deadline_at = ? WHERE id = ?').run(Date.now() + 250, 'W'); // fixture: a 250 ms deadline
  await sweepPauseTrap(r.deps); // notifies; arms the timer; nothing else will sweep
  assert.equal(getRunPause(r.db, 'W')!.escalatedAt, null, 'waiting');
  const end = Date.now() + 3000;
  while (getRunPause(r.db, 'W')!.escalatedAt === null && Date.now() < end) await new Promise((res) => setTimeout(res, 25));
  assert.notEqual(getRunPause(r.db, 'W')!.escalatedAt, null, 'the timer fired the escalation sweep');
  assert.ok(getRunPause(r.db, 'W')!.escalatedAt! >= p.pausedAt);
  __resetPauseTrapForTests();
});

test('a LIFT landing mid-step (between the activity read and the send) leaves no pause row and no order behind', async (t) => {
  const r = rig(t);
  mem(r, 'w1', 'W', true);
  setRunPause(r.db, 'W', true, 'ops-ws', 'soft');
  const act = r.deps.activityOf;
  r.deps.activityOf = async (m) => {
    const a = await act(m);
    setRunPause(r.db, 'W', false, 'ops-ws'); // `orchestra run resume` lands while the host is mid-step
    return a;
  };
  await sweepSoftPauses(r.deps);
  assert.equal(rows(r, 'pause').length, 0, 'no pause row for a lifted pause');
  assert.equal(r.orders.size, 0, 'no order for a lifted pause');
});

test('POLL: a member whose turn ENDS without any bus write is seen within the poll interval (host-idle) and the douce escalates — no other trigger', async (t) => {
  const r = rig(t);
  r.deps.douceCheckMs = 60;
  r.deps.now = () => Date.now();
  mem(r, 'w1', 'W', true);
  setRunPause(r.db, 'W', true, 'ops-ws', 'soft');
  await sweepPauseTrap(r.deps); // w1 notified, still running
  assert.equal(getRunPause(r.db, 'W')!.escalatedAt, null);
  r.running.set('w1', false); // its turn ended (quota / crash / done) — nothing is written to the bus
  const end = Date.now() + 3000;
  while (getRunPause(r.db, 'W')!.escalatedAt === null && Date.now() < end) await new Promise((res) => setTimeout(res, 20));
  assert.notEqual(getRunPause(r.db, 'W')!.escalatedAt, null, 'the poll timer re-swept and escalated');
  assert.equal(listRoster(r.db, 'W', getRunPause(r.db, 'W')!.pausedAt)[0].pauseConfirmVia, 'host-idle');
  __resetPauseTrapForTests();
});

test('STOP: a sweep still in flight must not re-arm the douce poll after stopPauseTrap (no timer outlives the stop)', async (t) => {
  const r = rig(t);
  r.deps.douceCheckMs = 40;
  r.deps.now = () => Date.now();
  mem(r, 'w1', 'W', true);
  setRunPause(r.db, 'W', true, 'ops-ws', 'soft');
  r.db.prepare('UPDATE runs SET pause_deadline_at = ? WHERE id = ?').run(Date.now() + 200, 'W');
  stopPauseTrap(); // the app is shutting down; a sweep that was already running still finishes…
  await sweepPauseTrap(r.deps);
  await new Promise((res) => setTimeout(res, 600)); // …but nothing re-arms: the deadline passes with no sweep
  assert.equal(getRunPause(r.db, 'W')!.escalatedAt, null, 'no poll/deadline timer fired after the stop');
  __resetPauseTrapForTests();
});

test('BUS-STATUS payload: only while a pause governs the run; labels carry the workspace name + id8; an unpaused run adds nothing', async (t) => {
  const r = rig(t);
  mem(r, 'abcdef0123456789', 'W', true);
  assert.deepEqual(busStatusPausePayload(r.db, 'W', () => 'x'), {}, 'not paused ⇒ the older reply shape is unchanged');
  setRunPause(r.db, 'W', true, 'ops-ws', 'soft');
  await sweepSoftPauses(r.deps);
  const out = busStatusPausePayload(r.db, 'W', (id) => (id === 'abcdef0123456789' ? 'feature-x' : null));
  assert.equal(out.pause?.summary.total, 1);
  assert.deepEqual(out.pauseLabels, { abcdef0123456789: 'feature-x (abcdef01)' });
  assert.deepEqual(busStatusPausePayload(r.db, 'W', () => null).pauseLabels, { abcdef0123456789: 'abcdef0123456789' });
});

test('UNKNOWN is not NONE (production shape): an activity read flagged `unknown` (a live keeper that did not answer) is notified, never confirmed host-idle', async (t) => {
  const r = rig(t);
  mem(r, 'w1', 'W', 'unknown');
  setRunPause(r.db, 'W', true, 'ops-ws', 'soft');
  const p = getRunPause(r.db, 'W')!;
  const out = await sweepSoftPauses(r.deps);
  assert.equal(out.summaries[0].notified, 1);
  assert.equal(listRoster(r.db, 'W', p.pausedAt)[0].pauseConfirmVia, null);
  assert.equal(out.summaries[0].escalated, null);
});

test('OBSERVER: a turn that starts while a Pause douce is still WAITING is not interrupted (a keeper reattach mid-turn reads as a CLI-started turn); once escalated it is', async (t) => {
  const r = rig(t);
  const m = mem(r, 'w1', 'W', true);
  setRunPause(r.db, 'W', true, 'ops-ws', 'soft');
  const p = getRunPause(r.db, 'W')!;
  assert.equal(await onTurnStart(r.deps, m), 'skipped');
  assert.deepEqual(r.interrupts, [], 'the running command is left to finish');
  escalateSoftPause(r.db, 'W', p.pausedAt, p.pausedAt + 1);
  assert.equal(await onTurnStart(r.deps, m), 'interrupted');
  assert.deepEqual(r.interrupts, ['w1'], 'after the escalation it is a hard pause: the new turn is trapped');
  const h = rig(t);
  const hm = mem(h, 'w1', 'W', true);
  setRunPause(h.db, 'W', true, 'ops-ws', 'hard');
  assert.equal(await onTurnStart(h.deps, hm), 'interrupted', 'a HARD pause is unchanged');
});

test('NESTED douces: a member\'s accusé on the inner carrier also confirms it on every outer carrier in an active pause (the outer would otherwise wait for it to its deadline)', async (t) => {
  const r = rig(t);
  setRunPause(r.db, 'M', true, 'lead-ws', 'soft');
  setRunPause(r.db, 'W', true, 'ops-ws', 'soft');
  const inner = getRunPause(r.db, 'W')!;
  const outer = getRunPause(r.db, 'M')!;
  const who = { wsId: 'w1', memberRun: 'W' };
  confirmMember(r.db, 'M', outer.pausedAt, { wsId: 'w9', memberRun: 'W' }, 'member', 1); // an unrelated row stays untouched
  assert.equal(confirmPauseFor(r.db, inner, who, 7).outcome, 'confirmed');
  assert.deepEqual(listRoster(r.db, 'M', outer.pausedAt).filter((x) => x.wsId === 'w1').map((x) => [x.pauseConfirmedAt, x.pauseConfirmVia]), [[7, 'member']]);
  assert.deepEqual(listRoster(r.db, 'W', inner.pausedAt).map((x) => [x.wsId, x.pauseConfirmedAt]), [['w1', 7]]);
  // an outer run that is NOT paused is not touched
  const q = rig(t);
  setRunPause(q.db, 'W', true, 'ops-ws', 'soft');
  confirmPauseFor(q.db, getRunPause(q.db, 'W')!, who, 7);
  assert.equal(q.db.prepare("SELECT COUNT(*) AS c FROM pause_members WHERE run_id = 'M'").get()?.c, 0);
});

test('ROSTER: a member archived/deleted mid-pause that never confirmed is dropped (never "manquent : <id>" for ever); a confirmed row is kept; an unloaded store drops nothing', async (t) => {
  const r = rig(t);
  mem(r, 'w1', 'W', true);
  const gone = mem(r, 'w2', 'W', true);
  mem(r, 'w3', 'W', false);
  setRunPause(r.db, 'W', true, 'ops-ws', 'soft');
  const p = getRunPause(r.db, 'W')!;
  await sweepSoftPauses(r.deps);
  assert.deepEqual(listRoster(r.db, 'W', p.pausedAt).map((x) => x.wsId), ['w1', 'w2', 'w3']);
  r.storeReady = false;
  await sweepSoftPauses(r.deps);
  assert.equal(listRoster(r.db, 'W', p.pausedAt).length, 3, 'an unloaded store enumerates nobody — and must not delete anyone');
  r.storeReady = true;
  r.roster = r.roster.filter((m) => m.wsId !== gone.wsId && m.wsId !== 'w3'); // w2 (unconfirmed) and w3 (confirmed host-idle) leave
  await sweepSoftPauses(r.deps);
  assert.deepEqual(listRoster(r.db, 'W', p.pausedAt).map((x) => x.wsId), ['w1', 'w3'], 'the unconfirmed vanished row is gone, the confirmed one is history');
});

// ── the accusés ─────────────────────────────────────────────────────────────

test('ACCUSÉ: the first writer wins (member vs host-idle vs trap); a late confirm never rewrites time or via; no pause ⇒ not-paused', (t) => {
  const r = rig(t);
  setRunPause(r.db, 'W', true, 'ops-ws', 'soft');
  const carrier = activePauseFor(r.db, 'W')!;
  const who = { wsId: 'w1', memberRun: 'W' };
  const a = confirmPauseFor(r.db, carrier, who, 111);
  assert.equal(a.outcome, 'confirmed');
  assert.deepEqual(a.view?.summary, { phase: 'pausing', total: 1, done: 1, missing: [] });
  const b = confirmPauseFor(r.db, carrier, who, 222);
  assert.equal(b.outcome, 'already-confirmed');
  const row = listRoster(r.db, 'W', carrier.pausedAt)[0];
  assert.deepEqual([row.pauseConfirmedAt, row.pauseConfirmVia], [111, 'member']);
  assert.equal(confirmMember(r.db, 'W', carrier.pausedAt, who, 'trap', 333), false, 'the trap never overwrites a member accusé');
  assert.equal(confirmPauseFor(r.db, null, who).outcome, 'not-paused');
});

test('ACCUSÉ by the CLI before the host enrolled anyone creates the row with the SAME role the host would (coordinator by runs.coordinator)', (t) => {
  const r = rig(t);
  setRunPause(r.db, 'M', true, 'lead-ws', 'soft');
  const c = activePauseFor(r.db, 'M')!;
  confirmPauseFor(r.db, c, { wsId: 'ops-ws', memberRun: 'W' }, 5);
  confirmPauseFor(r.db, c, { wsId: 'w1', memberRun: 'W' }, 6);
  assert.deepEqual(listRoster(r.db, 'M', c.pausedAt).map((x) => [x.wsId, x.role, x.memberRun]), [['ops-ws', 'coordinator', 'W'], ['w1', 'worker', 'W']]);
});

test('ACCUSÉ with an UNKNOWN member run (CLI, store unreadable) never clobbers the role/run the host enrolled; the roster finds the carrier of an ACTIVE pause only', async (t) => {
  const r = rig(t);
  mem(r, 'ops-ws', 'W', true);
  setRunPause(r.db, 'M', true, 'lead-ws', 'soft');
  const c = getRunPause(r.db, 'M')!;
  await sweepSoftPauses(r.deps);
  assert.deepEqual(listRoster(r.db, 'M', c.pausedAt).map((x) => [x.wsId, x.role, x.memberRun]), [['ops-ws', 'coordinator', 'W']]);
  assert.equal(carrierFromRoster(r.db, 'ops-ws')?.runId, 'M');
  confirmPauseFor(r.db, carrierFromRoster(r.db, 'ops-ws'), { wsId: 'ops-ws', memberRun: null }, 9);
  assert.deepEqual(listRoster(r.db, 'M', c.pausedAt).map((x) => [x.wsId, x.role, x.memberRun, x.pauseConfirmVia]), [['ops-ws', 'coordinator', 'W', 'member']]);
  assert.equal(carrierFromRoster(r.db, 'nobody'), null);
  setRunPause(r.db, 'M', false, 'lead-ws');
  assert.equal(carrierFromRoster(r.db, 'ops-ws'), null, 'a lifted pause is no carrier (its roster rows stay as history)');
});

// ── the trap's half of the roster ───────────────────────────────────────────

function worktree(r: Rig, name: string): string {
  const d = path.join(r.dir, name);
  fs.mkdirSync(d, { recursive: true });
  const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
  for (const a of [['init', '-q', '-b', 'main'], ['commit', '-q', '--allow-empty', '-m', 'init']]) execFileSync('git', a, { cwd: d, env });
  fs.writeFileSync(path.join(d, 'new.txt'), 'work\n');
  return d;
}

test('TRAP roster: a hard pause enrols every member and records `trap`; an escalated douce keeps `member` / `host-idle` accusés and records `trap` only for the stragglers', async (t) => {
  const r = rig(t);
  const { snapshotWorktree } = await import('./pause-snapshot.ts');
  r.deps.snapshot = async (i) => snapshotWorktree(i);
  r.deps.cliOf = async () => ({ cli: { pid: 100, startTicks: 1 }, keeperPid: 90 });
  r.deps.killTrees = async () => ({ cliPid: 100, cli: { pid: 100, startTicks: 1 }, killed: [], refused: [], spared: [], survivors: [], rounds: 1 }) as never;
  for (const id of ['w1', 'w2', 'w3']) mem(r, id, 'W', id !== 'w3', { worktreePath: worktree(r, id) });
  setRunPause(r.db, 'W', true, 'ops-ws', 'soft');
  const p = getRunPause(r.db, 'W')!;
  await sweepSoftPauses(r.deps); // w3 host-idle; w1/w2 notified
  confirmMember(r.db, 'W', p.pausedAt, { wsId: 'w1', memberRun: 'W' }, 'member', r.clock);
  r.clock = p.deadlineAt!;
  await sweepPauseTrap(r.deps); // douce sweep escalates by deadline, the trap (owed now) takes everyone
  const trapped = listRoster(r.db, 'W', p.pausedAt).map((x) => [x.wsId, x.pauseConfirmVia]);
  assert.deepEqual(trapped, [['w1', 'member'], ['w2', 'trap'], ['w3', 'host-idle']]);
  assert.ok(getRunPause(r.db, 'W')!.trapAt, 'the trap finished');
  assert.deepEqual(pauseStatusView(r.db, 'W')!.summary, { phase: 'paused', total: 3, done: 3, missing: [] });
  // hard pause: nobody confirmed before the trap ⇒ every member is `trap`
  const h = rig(t);
  h.deps.snapshot = async (i) => snapshotWorktree(i);
  h.deps.cliOf = async () => ({ cli: { pid: 100, startTicks: 1 }, keeperPid: 90 });
  h.deps.killTrees = r.deps.killTrees;
  mem(h, 'h1', 'W', true, { worktreePath: worktree(h, 'h1') });
  setRunPause(h.db, 'W', true, 'ops-ws', 'hard');
  const hc = getRunPause(h.db, 'W')!;
  await runPauseTrap(h.deps, hc);
  assert.deepEqual(listRoster(h.db, 'W', hc.pausedAt).map((x) => [x.wsId, x.pauseConfirmVia]), [['h1', 'trap']]);
  // a member the trap could NOT prove (unresponsive keeper) is still ENROLLED from the start: "1/2 en pause — manquent : h3", never "1/1"
  const u = rig(t);
  u.deps.snapshot = async (i) => snapshotWorktree(i);
  u.deps.cliOf = async (m) => (m.wsId === 'h3' ? { error: 'keeper is alive but did not answer the probe' } : { cli: { pid: 100, startTicks: 1 }, keeperPid: 90 });
  u.deps.killTrees = r.deps.killTrees;
  mem(u, 'h2', 'W', true, { worktreePath: worktree(u, 'h2') });
  mem(u, 'h3', 'W', true, { worktreePath: worktree(u, 'h3') });
  setRunPause(u.db, 'W', true, 'ops-ws', 'hard');
  const uc = getRunPause(u.db, 'W')!;
  const sum = await runPauseTrap(u.deps, uc);
  assert.equal(sum.done, false, 'h3 is incomplete: the trap is not stamped');
  assert.deepEqual(pauseStatusView(u.db, 'W')!.summary, { phase: 'paused', total: 2, done: 1, missing: ['h3'] });
});

test('SWEEP wiring: sweepPauseTrap runs the douce pass (notify) BEFORE reading the owed traps, and arms a deadline timer that fires the escalation sweep', async (t) => {
  const r = rig(t);
  mem(r, 'w1', 'W', true);
  setRunPause(r.db, 'W', true, 'ops-ws', 'soft');
  await sweepPauseTrap(r.deps);
  assert.equal(rows(r, 'pause').length, 1, 'the trap sweep drove the douce pass');
  __resetPauseTrapForTests(); // clears the timer armed above (it would otherwise keep the test process alive past the deadline)
});

test('ARM: a Pause douce still waiting does NOT attach keepers (an attach mid-turn reads as a CLI-started turn the observer would interrupt); an escalated one does', async (t) => {
  const r = rig(t);
  const armed: string[] = [];
  r.deps.arm = async (m) => void armed.push(m.wsId);
  mem(r, 'w1', 'W', true);
  setRunPause(r.db, 'W', true, 'ops-ws', 'soft');
  assert.equal(await armPausedMembers(r.deps), 0);
  assert.deepEqual(armed, []);
  const p = getRunPause(r.db, 'W')!;
  escalateSoftPause(r.db, 'W', p.pausedAt, p.pausedAt + 1);
  assert.equal(await armPausedMembers(r.deps), 1);
  assert.deepEqual(armed, ['w1']);
});

// ── order files + the real hook ─────────────────────────────────────────────

test('ORDER FILES: write is atomic + JSON-string literal, remove/prune/deliveredAt behave, an unsafe workspace id is refused', (t) => {
  fs.mkdirSync(ROOT, { recursive: true });
  const dir = path.join(ROOT, `orders${n++}`);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const o = pauseOrderFiles(dir);
  o.write('w1', 'line1\n"quoted" \\ ünï');
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'w1.json'), 'utf8')), 'line1\n"quoted" \\ ünï');
  assert.deepEqual(fs.readdirSync(dir), ['w1.json'], 'no temp file left behind');
  o.write('w2', 'x');
  o.prune(new Set(['w2']));
  assert.deepEqual(fs.readdirSync(dir).sort(), ['w2.json']);
  o.remove('w2');
  o.remove('w2'); // idempotent
  assert.deepEqual(fs.readdirSync(dir), []);
  assert.equal(o.deliveredAt('w1'), null);
  assert.throws(() => o.write('../evil', 'x'), /unsafe workspace id/);
  assert.throws(() => o.write('.hidden', 'x'), /unsafe workspace id/);
  o.prune(new Set()); // dir exists, empty
  pauseOrderFiles(path.join(dir, 'nope')).prune(new Set()); // missing dir ⇒ no throw
});

const WORKSPACES = path.join(process.cwd(), 'src', 'main', 'workspaces.ts');
function realHookScript(): string {
  const src = fs.readFileSync(WORKSPACES, 'utf8');
  const head = 'const ORCHESTRA_HOOK_SCRIPT = `';
  const start = src.indexOf(head);
  assert.notEqual(start, -1);
  const body = src.slice(start + head.length, src.indexOf('`;\n', start + head.length));
  return new Function(`return \`${body}\`;`)() as string;
}

test('HOOK: the real posttool hook script delivers the pause order ONCE as additionalContext (success AND failure events), is silent without an order, and never touches other events', (t) => {
  fs.mkdirSync(ROOT, { recursive: true });
  const home = path.join(ROOT, `hook${n++}`);
  fs.mkdirSync(path.join(home, 'events'), { recursive: true });
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const script = path.join(home, 'hook.sh');
  fs.writeFileSync(script, realHookScript(), { mode: 0o755 });
  const env = { PATH: '/usr/bin:/bin', HOME: home, ORCHESTRA_WS_ID: 'ws-d', ORCHESTRA_EVENTS_DIR: path.join(home, 'events') };
  const run = (event: string, hook: string): string => execFileSync('bash', [script, event], { input: JSON.stringify({ hook_event_name: hook, tool_name: 'Bash', tool_use_id: 'toolu_1' }), env, encoding: 'utf8' });
  const orders = pauseOrderFiles(path.join(home, 'pause-orders'));
  assert.equal(run('posttool', 'PostToolUse'), '', 'no order ⇒ silent (the spool line is the only effect)');
  const text = renderPauseOrder({ carrierRunId: 'W', deadlineAt: 1_700_000_000_000 });
  orders.write('ws-d', text);
  assert.equal(run('pretool', 'PreToolUse'), '', 'pretool never delivers');
  assert.ok(fs.existsSync(path.join(home, 'pause-orders', 'ws-d.json')), 'still waiting after a non-posttool event');
  const out = JSON.parse(run('posttool', 'PostToolUse'));
  assert.deepEqual(out, { hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: text } });
  assert.equal(run('posttool', 'PostToolUse'), '', 'once only');
  assert.ok(orders.deliveredAt('ws-d') !== null, 'the rename is the delivery receipt');
  orders.write('ws-d', 'second order');
  assert.equal(JSON.parse(run('posttool', 'PostToolUseFailure')).hookSpecificOutput.hookEventName, 'PostToolUseFailure');
  assert.equal(fs.readFileSync(path.join(home, 'events', 'ws-d.jsonl'), 'utf8').split('\n').filter(Boolean).length, 5, 'the spool line is still written for every event (5 hook runs)');
  // a SUBAGENT's tool call (payload carries agent_id) never takes the order; the member's own next boundary does
  orders.write('ws-d', 'third order');
  const sub = execFileSync('bash', [script, 'posttool'], { input: JSON.stringify({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: 'toolu_s', agent_id: 'agent-1', agent_type: 'general-purpose' }), env, encoding: 'utf8' });
  assert.equal(sub, '', 'a subagent call is silent');
  assert.ok(fs.existsSync(path.join(home, 'pause-orders', 'ws-d.json')), 'and leaves the order for the member itself');
  assert.equal(JSON.parse(run('posttool', 'PostToolUse')).hookSpecificOutput.additionalContext, 'third order', "the member's own next boundary delivers it");
  // an unknown event name falls back to PostToolUse (never an invalid hookEventName)
  orders.write('ws-d', 'fourth order');
  assert.equal(JSON.parse(run('posttool', 'SomethingElse; rm -rf /')).hookSpecificOutput.hookEventName, 'PostToolUse');
  // a STALE order (older than the 3-min douce + slack) is dropped, never injected
  orders.write('ws-d', 'stale order');
  const old = new Date(Date.now() - 10 * 60_000);
  fs.utimesSync(path.join(home, 'pause-orders', 'ws-d.json'), old, old);
  assert.equal(run('posttool', 'PostToolUse'), '', 'stale ⇒ silent');
  assert.equal(fs.existsSync(path.join(home, 'pause-orders', 'ws-d.json')), false, 'and removed');
});

test('PIN: the host writes the order where the hook looks (pauseOrdersDir = sibling `pause-orders` of the events dir; the hook derives it from $ORCHESTRA_EVENTS_DIR without a fork)', () => {
  const host = fs.readFileSync(path.join(process.cwd(), 'src', 'main', 'pause-trap-host.ts'), 'utf8');
  assert.match(host, /return path\.join\(path\.dirname\(getEventsDir\(\)\), 'pause-orders'\);/);
  const ws = fs.readFileSync(WORKSPACES, 'utf8');
  assert.match(ws, /po="\\\$\{dir%\/\*\}\/pause-orders\/\\\$ORCHESTRA_WS_ID"/);
  assert.doesNotMatch(ws.slice(ws.indexOf('# #254 Pause douce: deliver'), ws.indexOf('exit 0\n`;', ws.indexOf('# #254 Pause douce: deliver'))), /dirname/, 'no fork on the no-order path');
});

// ── rendering ───────────────────────────────────────────────────────────────

test('RENDER: "N/M en pause — manquent : …" (and "repris" while resuming); the pause line names the phase and the deadline', () => {
  const rowsOf = (...c: Array<number | null>) =>
    c.map((x, i) => ({ runId: 'W', pausedAt: 1, wsId: `w${i + 1}`, role: 'worker' as const, memberRun: 'W', pauseConfirmedAt: x, pauseConfirmVia: x ? ('member' as const) : null, releasedAt: null, releasedBy: null, repriseConfirmedAt: null }));
  const s = pauseRosterSummary('pausing', rowsOf(5, null, 7, null));
  assert.equal(renderPauseRosterLine(s), '2/4 en pause — manquent : w2, w4');
  assert.equal(renderPauseRosterLine(pauseRosterSummary('paused', rowsOf(5, 6))), '2/2 en pause');
  assert.equal(renderPauseRosterLine({ ...s, phase: 'resuming' }), '2/4 repris — manquent : w2, w4');
  const line = renderPauseStatusLine({ carrierRunId: 'W', mode: 'soft', phase: 'pausing', pausedAt: 0, pausedBy: 'x', deadlineAt: 180_000, escalatedAt: null, trapAt: null, summary: s, rows: [] }, { now: 100_000 });
  assert.match(line, /^Pause douce en cours — 2\/4 en pause — manquent : w2, w4 — Pause dure à 1970-01-01T00:03:00\.000Z \(dans 80s\)/);
  assert.match(renderPauseStatusLine({ carrierRunId: 'W', mode: 'soft', phase: 'pausing', pausedAt: 0, pausedBy: 'x', deadlineAt: 1, escalatedAt: null, trapAt: null, summary: { phase: 'pausing', total: 0, done: 0, missing: [] }, rows: [] }), /aucun membre inscrit/);
});
