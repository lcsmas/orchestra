// #438 (spec #431 NOT-VERIFIED 1, #199 history) — a child idle between turns raises NO false liveness escalation in a run of TWO: one plain parent P
// (top-level, owns its mission run from birth) + one child C (a member of P's run). The REAL roster (`buildLivenessRoster` over `runIdOf` / `coordinatorOf`),
// the REAL tracker (hibernation-activity), the REAL sweep + `decideEscalation` over a REAL SQLite bus with the mission row; time is a fake clock. Each run is
// SEEDED (`LIVENESS_SEED`, default 1): turn count, tool calls, dropped `posttool`s and a lost `stop` differ per seed — `scripts/pause-canary/liveness-small-runs.mjs`
// runs seeds 1..10 in fresh processes (the ticket's « 10 unmutated runs ») and the mutants that must turn it red. Every « zero » below has its positive control
// in the same run: the same roster DOES escalate a genuinely silent child once the staleness window passes, so a zero is not a sweep that cannot escalate.
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openBus, send, type BusDb } from './bus.ts';
import { startRun } from './bus-runs.ts';
import { DEFAULT_BUS_SWITCHES } from '../shared/bus-switches.ts';
import { sweepBusLiveness, setLivenessRoster, setLivenessReleased, setLivenessWaiting, readReleasedReaders, setLivenessSwitchReader, __setBusReaderForTests, __setNowForTests, __resetBusLivenessForTests, __armForTests, STALE_AFTER_MS } from './bus-liveness.ts';
import { buildLivenessRoster, type LivenessRosterStore } from './bus-liveness-roster.ts';
import { readWaitingReaders } from './bus-wake.ts';
import { noteActivity, noteAppStart, noteToolStart, noteToolEnd, clearInFlightTools, forgetHibernationActivity } from './hibernation-activity.ts';
import { runIdOf } from '../shared/run-position.ts';
import { fileURLToPath } from 'node:url';
import { BASH_TOOL_CEILING_MS } from '../shared/bus-liveness.ts';
import type { Workspace } from '../shared/types.ts';

const SEED = Number(process.env.LIVENESS_SEED ?? '1');
const T0 = 1_700_000_000_000;
const MIN = 60_000;
const TICK = 60_000; // the production sweep period (`SWEEP_MS`, bus-liveness.ts)
const P = 'sm-parent';
const C = 'sm-child';

/** mulberry32 — a seeded PRNG so a run is reproducible from its seed alone. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

let clock = T0;
const at = (ms: number): void => {
  clock = ms;
};

function ws(over: Partial<Workspace>): Workspace {
  return { id: 'x', name: 'n', repoPath: '/repo', worktreePath: '/wt', branch: 'b', baseBranch: 'main', createdAt: T0, status: 'idle', agent: 'claude', ...over } as Workspace;
}

interface Rig {
  db: BusDb;
  child: Workspace;
  parent: Workspace;
}

/** P (plain, top-level, no kind, no capability flag, `ownsRun` as its first spawn records it) + C (parentId P, a task). */
function rig(t: TestContext): Rig {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestra-liveness-small-'));
  const db = openBus(path.join(dir, 'bus.sqlite'));
  t.after(() => {
    try {
      db.close();
    } catch {
      /* closed */
    }
    fs.rmSync(dir, { recursive: true, force: true });
    __resetBusLivenessForTests();
    forgetHibernationActivity(C);
    forgetHibernationActivity(P);
  });
  t.mock.method(Date, 'now', () => clock);
  startRun(db, { id: P, kind: 'mission', coordinator: P }, { ...DEFAULT_BUS_SWITCHES, liveness: true });
  const parent = ws({ id: P, ownsRun: true });
  const child = ws({ id: C, parentId: P, lastTask: 'do the thing', createdAt: T0 });
  const all = [parent, child];
  const store: LivenessRosterStore = { workspaces: all, getWorkspace: (id) => all.find((w) => w.id === id) };
  __resetBusLivenessForTests();
  __setBusReaderForTests(() => db);
  __setNowForTests(() => clock);
  setLivenessSwitchReader(() => true);
  setLivenessWaiting(readWaitingReaders); // the two durable seams index.ts wires beside the roster
  setLivenessReleased(readReleasedReaders);
  setLivenessRoster(buildLivenessRoster(store, (w) => runIdOf(w, (id) => store.getWorkspace(id))));
  __armForTests();
  at(T0);
  noteAppStart();
  forgetHibernationActivity(C);
  return { db, child, parent };
}

const escalationsTo = (db: BusDb, recipient: string): Array<{ sender: string; body: string; run_id: string }> =>
  db.prepare(`SELECT sender, body, run_id FROM messages WHERE kind = 'escalation' AND recipient = ? ORDER BY sequence`).all(recipient) as never;

/** One turn of the child, event by event as activity.ts dispatches them (submit → pretool/posttool… → stop). `dropPost` = a `posttool` that never arrives; `lostStop` = the turn's `stop` never arrives. */
function turn(r: Rig, rand: () => number, opts: { lostStop?: boolean } = {}): { dropped: number; tools: number } {
  r.child.status = 'running';
  noteActivity(C);
  clearInFlightTools(C); // `submit`: a new turn clears the list (#199)
  const tools = 1 + Math.floor(rand() * 4);
  let dropped = 0;
  for (let i = 0; i < tools; i++) {
    at(clock + 1000 + Math.floor(rand() * 4000));
    const id = `toolu_${SEED}_${clock}_${i}`;
    const name = rand() < 0.5 ? 'Bash' : 'Read';
    noteToolStart(C, name, id);
    noteActivity(C);
    at(clock + 500 + Math.floor(rand() * 3000));
    if (rand() < 0.35) dropped++; // the posttool is DROPPED: the call stays in the tracker until the turn boundary
    else {
      noteToolEnd(C, id, name);
      noteActivity(C);
    }
    sweepBusLiveness(); // the sweep may tick mid-turn
  }
  at(clock + 500);
  if (!opts.lostStop) {
    clearInFlightTools(C); // `stop`
    noteActivity(C);
    r.child.status = 'idle';
  }
  return { dropped, tools };
}

test(`#438 S1 (seed ${SEED}): a child IDLE between turns — zero escalation inside the window, exactly ONE once genuinely silent past it (positive control)`, (t) => {
  const r = rig(t);
  const rand = rng(SEED);
  at(T0 + 30_000);
  const turns = 1 + Math.floor(rand() * 3);
  let dropped = 0;
  let lastActivity = clock;
  for (let i = 0; i < turns; i++) {
    dropped += turn(r, rand).dropped;
    lastActivity = clock; // the child's last event — the idle clock starts HERE, not at the next sweep
    at(clock + 5_000 + Math.floor(rand() * 60_000));
    sweepBusLiveness();
  }
  // idle between turns: sweep every production tick for the whole window — NOTHING may reach P (no stale-clock, no phantom in-flight 'hung mid-call')
  while (clock < lastActivity + STALE_AFTER_MS - TICK) {
    at(clock + TICK);
    sweepBusLiveness();
  }
  assert.deepEqual(escalationsTo(r.db, P), [], `no escalation while the child has been idle < ${STALE_AFTER_MS / MIN} min (turns ${turns}, dropped posttools ${dropped})`);
  // POSITIVE CONTROL: the same roster escalates the same child once it is silent past the window — one row, to P, in P's run, a STALENESS body (never « hung »)
  at(lastActivity + STALE_AFTER_MS + MIN);
  sweepBusLiveness();
  const rows = escalationsTo(r.db, P);
  assert.equal(rows.length, 1, 'the sweep CAN escalate this roster: one escalation once genuinely silent');
  assert.equal(rows[0].sender, C);
  assert.equal(rows[0].run_id, P, "the escalation lives in the parent's own run");
  assert.match(rows[0].body, /no session activity for \d+m/, 'a between-turns staleness body');
  assert.doesNotMatch(rows[0].body, /hung/i, 'never a hung-mid-call body for a child that is idle between turns');
  // one per silence (dedup) — and a phantom Bash that blew its 600 s ceiling must not add a second, « hung », row
  at(lastActivity + STALE_AFTER_MS + BASH_TOOL_CEILING_MS + 5 * MIN);
  sweepBusLiveness();
  assert.equal(escalationsTo(r.db, P).length, 1, 'still ONE row past the Bash ceiling: no hung-mid-call escalation of an idle child');
});

test(`#438 S2 (seed ${SEED}): a lost \`stop\` then a new turn — the stranded call never becomes a false « hung mid-call » (#199 on a run of two)`, (t) => {
  const r = rig(t);
  const rand = rng(SEED + 1000);
  at(T0 + 30_000);
  turn(r, rand, { lostStop: true }); // turn A: its stop is lost, a call may be stranded
  at(clock + 2_000);
  turn(r, rand); // turn B starts (submit clears), ends cleanly
  const lastActivity = clock;
  while (clock < lastActivity + STALE_AFTER_MS - TICK) {
    at(clock + TICK);
    sweepBusLiveness();
  }
  assert.deepEqual(escalationsTo(r.db, P), [], 'idle after a lost stop + a clean turn: nothing escalates inside the window');
  at(lastActivity + STALE_AFTER_MS + MIN);
  sweepBusLiveness();
  const rows = escalationsTo(r.db, P);
  assert.equal(rows.length, 1, 'positive control: one staleness row');
  assert.doesNotMatch(rows[0].body, /hung/i);
});

/** A phantom call across a turn boundary (#199) on a run of two: turn A starts a Bash whose `posttool` AND `stop` are lost (the member stays `running`), the coalesced-wake turn B STARTS 9 min later
 *  (`submit`) and runs a long fresh Bash. At 11 min the phantom is past its 600 s ceiling unless the `submit` cleared it. `submitClears` = the one clause under test (the SHIPPED arm is pinned in activity.ts below). */
function phantomAcrossTurns(r: Rig, submitClears: boolean): void {
  const t0 = clock;
  r.child.status = 'running';
  noteActivity(C);
  clearInFlightTools(C);
  at(t0 + 1000);
  noteToolStart(C, 'Bash', 'toolu_phantom_A');
  noteActivity(C);
  while (clock < t0 + 9 * MIN) {
    at(clock + TICK);
    noteActivity(C); // the member is chatty on other channels: its clock stays fresh, only the in-flight call ages
    sweepBusLiveness();
  }
  assert.deepEqual(escalationsTo(r.db, P), [], 'a Bash 9 min old is under its 600 s ceiling');
  if (submitClears) clearInFlightTools(C); // `submit` (activity.ts) — the turn boundary clears the prior turn's calls
  noteActivity(C);
  noteToolStart(C, 'Bash', 'toolu_fresh_B');
  while (clock < t0 + 13 * MIN) {
    at(clock + TICK);
    noteActivity(C);
    sweepBusLiveness();
  }
}

test(`#438 S5 (seed ${SEED}): the stranded call of a lost-stop turn never becomes a false « hung mid-call » once the next turn starts — and WITHOUT the submit clear it does (must-FAIL arm)`, (t) => {
  const r = rig(t);
  at(T0 + 30_000);
  phantomAcrossTurns(r, true);
  assert.deepEqual(escalationsTo(r.db, P), [], 'shipped: the submit clear removed the phantom — no hung escalation of a child that is working');
  forgetHibernationActivity(C);
  __resetBusLivenessForTests();
  const r2 = rig(t);
  at(T0 + 30_000);
  phantomAcrossTurns(r2, false);
  const rows = escalationsTo(r2.db, P);
  assert.equal(rows.length, 1, 'the unfixed arm (no clear) FAILS through the same rig: one hung-mid-call escalation');
  assert.match(rows[0].body, /hung|stuck|in.?flight|Bash/i);
});

test('#438 S5 pin: the shipped `submit` arm of activity.ts still clears the in-flight list (the clause the fake clock mirrors)', () => {
  const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'activity.ts'), 'utf8');
  assert.match(src, /clearInFlightTools\(id\);\s*\n\s*\/\/ #252 D1b \(rows 29\/30\): a real turn START/, "activity.ts `submit`: clearInFlightTools(id) right before the pause-trap turn-start notice");
});

test(`#438 S3 (seed ${SEED}): a child that reported worker_done is finished on purpose — never escalated, however long it idles`, (t) => {
  const r = rig(t);
  const rand = rng(SEED + 2000);
  at(T0 + 30_000);
  turn(r, rand);
  // the child reports done to its parent IN P's RUN (its `$ORCHESTRA_RUN_ID` = `runIdOf(C)` = P); the parent never re-tasks it
  assert.equal(runIdOf(r.child, (id) => (id === P ? r.parent : undefined)), P, "the child's bus run is its parent's");
  send(r.db, { runId: P, sender: C, kind: 'worker_done', body: 'shipped', recipient: P });
  const lastActivity = clock;
  while (clock < lastActivity + 3 * 60 * MIN) {
    at(clock + 5 * MIN);
    sweepBusLiveness();
  }
  assert.deepEqual(escalationsTo(r.db, P), [], 'done-and-released child: zero escalations over 3 h of idle');
});

test(`#438 S4 (seed ${SEED}): the plain parent itself is never escalated (top-level: nobody above it), idle for hours`, (t) => {
  const r = rig(t);
  r.parent.lastTask = 'a task the human gave P'; // even WITH a task: no coordinator → nothing to escalate to
  at(T0 + 4 * 60 * MIN);
  sweepBusLiveness();
  const aboutP = (db: BusDb) => (db.prepare(`SELECT sender FROM messages WHERE kind = 'escalation' AND sender = ?`).all(P) as unknown[]);
  assert.deepEqual(aboutP(r.db), [], 'P reads silent for 4 h and is never the subject of an escalation');
  assert.deepEqual(escalationsTo(r.db, C), [], 'nothing is addressed to the child either');
  assert.equal(escalationsTo(r.db, P).length, 1, 'positive control: the CHILD of that silent hour IS escalated, to P — the sweep can escalate this roster');
});
