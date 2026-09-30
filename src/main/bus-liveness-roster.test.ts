import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openBus, type BusDb } from './bus.ts';
import {
  sweepBusLiveness,
  setLivenessRoster,
  setLivenessSwitchReader,
  __setBusReaderForTests,
  __setNowForTests,
  __resetBusLivenessForTests,
  __armForTests,
  STALE_AFTER_MS,
  type LivenessMember,
} from './bus-liveness.ts';
import { buildLivenessRoster, type LivenessRosterStore } from './bus-liveness-roster.ts';
import { noteActivity, noteAppStart } from './hibernation-activity.ts';
import type { Workspace } from '../shared/types.ts';

// #236 — the liveness roster's silence start is bounded below by `createdAt`. Every
// arm drives the SHIPPED roster builder (`buildLivenessRoster`, the code index.ts
// wires) over the REAL hibernation-activity clock into the real `sweepBusLiveness` on
// a real SQLite bus, and asserts the escalation ROWS. A test on `idleClockStart` alone
// passes on master by construction (shared/hibernation.test.ts already pins it).
//
// Time is faked through `Date.now` (activity stamps + app-start floor) and the sweep's
// own clock, which always move together (`at()`).

const RUN = 'run-c9';
const T0 = 1_700_000_000_000; // the app started here
const HOUR = 3_600_000;
const MIN = 60_000;
const UP_2H = T0 + 2 * HOUR;

let clock = T0;
/** Move the fake wall clock (Date.now AND the sweep's clock). */
function at(ms: number): void {
  clock = ms;
}

let seq = 0;
function ws(over: Partial<Workspace> = {}): Workspace {
  seq += 1;
  return {
    id: over.id ?? `c9-ws-${seq}`,
    name: 'n',
    repoPath: '/repo',
    worktreePath: '/wt',
    branch: `branch-${seq}`,
    baseBranch: 'main',
    createdAt: T0,
    status: 'idle',
    agent: 'claude',
    lastTask: 'do the thing',
    parentId: 'c9-ops',
    ...over,
  } as Workspace;
}

/** A coordinator with no parent of its own (so it is never itself escalated). */
const OPS = ws({ id: 'c9-ops', parentId: undefined, lastTask: undefined });

function storeOf(...members: Workspace[]): LivenessRosterStore {
  const all = [OPS, ...members];
  return { workspaces: all, getWorkspace: (id) => all.find((w) => w.id === id) };
}

function tmpBus(t: TestContext): BusDb {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestra-liveness-roster-test-'));
  const db = openBus(path.join(dir, 'bus.sqlite'));
  t.after(() => {
    try {
      db.close();
    } catch {
      /* already closed */
    }
    fs.rmSync(dir, { recursive: true, force: true });
    __resetBusLivenessForTests();
  });
  // `Date.now` drives noteActivity/noteAppStart; restored automatically at test end.
  t.mock.method(Date, 'now', () => clock);
  return db;
}

/** Wire the REAL roster builder over `store` into the sweep (switch forced ON). */
function arm(db: BusDb, store: LivenessRosterStore): () => LivenessMember[] {
  const roster = buildLivenessRoster(store, () => RUN);
  __resetBusLivenessForTests();
  __setBusReaderForTests(() => db);
  __setNowForTests(() => clock);
  setLivenessSwitchReader(() => true);
  setLivenessRoster(roster);
  __armForTests();
  return roster;
}

function escalations(db: BusDb, coordinator: string, reader: string): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM messages
        WHERE run_id=? AND kind='escalation' AND recipient=? AND sender=?`,
    )
    .get(RUN, coordinator, reader) as { n: number };
  return Number(row.n);
}

/** Boot the fake app at T0, then jump to `now` — the app has been up `now - T0`. */
function bootAppThen(now: number): void {
  at(T0);
  noteAppStart();
  at(now);
}

/** LEAD → OPS (old, no activity) → `child`: the OPS is escalated unless `child` shields it. */
function fleetStore(child: Workspace): LivenessRosterStore {
  const all = [
    ws({ id: 'c9-lead', parentId: undefined, lastTask: undefined }),
    ws({ id: 'c9-ops2', parentId: 'c9-lead', createdAt: T0 - 3 * 24 * HOUR }),
    child,
  ];
  return { workspaces: all, getWorkspace: (id) => all.find((w) => w.id === id) };
}

test('#236 must-FAIL on master: app up 2 h, a FRESH member with no activity → NO escalation in the stale window', (t) => {
  // MUTANT (master's roster): `lastActivityAt: getLastActivity(id) ?? appStartedAt` — the
  //   fresh member reads silent since app start (2 h) and escalates a sweep after spawn.
  const db = tmpBus(t);
  bootAppThen(UP_2H);
  const fresh = ws({ id: 'c9-fresh', createdAt: UP_2H - 30_000 });
  // Same-sweep POSITIVE CONTROL: an old member with no activity IS stale at app start + 2 h,
  // so a zero for the fresh one cannot be a sweep that cannot escalate.
  const old = ws({ id: 'c9-old', createdAt: T0 - 3 * 24 * HOUR });
  const roster = arm(db, storeOf(fresh, old));
  const byId = Object.fromEntries(roster().map((m) => [m.reader, m]));
  assert.equal(byId['c9-fresh'].lastActivityAt, UP_2H - 30_000, 'fresh member idles from its createdAt');
  assert.equal(byId['c9-old'].lastActivityAt, T0, 'old member idles from the app-start floor');

  sweepBusLiveness();
  assert.equal(escalations(db, 'c9-ops', 'c9-fresh'), 0, 'fresh member: no escalation');
  assert.equal(escalations(db, 'c9-ops', 'c9-old'), 1, 'old member (control): escalated once');

  // No permanent immunity: silent for a full stale window FROM ITS CREATION, it escalates.
  at(UP_2H - 30_000 + STALE_AFTER_MS + MIN);
  sweepBusLiveness();
  assert.equal(escalations(db, 'c9-ops', 'c9-fresh'), 1, 'fresh member genuinely silent >10 m escalates');
});

test('#236 no regression: an OLD member with no activity still floors at APP START, not createdAt', (t) => {
  // MUTANT: floor at `createdAt` only (drop the app-start floor) — a 3-day-old workspace
  //   reads silent for days and escalates in the first minutes after every relaunch.
  const db = tmpBus(t);
  bootAppThen(T0 + 5 * MIN);
  const old = ws({ id: 'c9-old-b', createdAt: T0 - 3 * 24 * HOUR });
  const roster = arm(db, storeOf(old));
  assert.equal(roster()[0].lastActivityAt, T0, 'floor is the app start, not createdAt (3 days ago)');

  sweepBusLiveness();
  assert.equal(escalations(db, 'c9-ops', 'c9-old-b'), 0, 'app up 5 m: within the window of the floor');

  at(T0 + STALE_AFTER_MS + MIN);
  sweepBusLiveness();
  assert.equal(escalations(db, 'c9-ops', 'c9-old-b'), 1, 'past the window of the floor: escalated once');
});

test('#236 a member WITH activity idles from that activity (not app start, not createdAt)', (t) => {
  // MUTANT: ignore the activity stamp (`max(appStart, createdAt)` only) — a member active
  //   2 m ago on a 2 h-old app is escalated as silent since app start.
  const db = tmpBus(t);
  bootAppThen(UP_2H);
  const recent = ws({ id: 'c9-recent', createdAt: T0 - 3 * 24 * HOUR });
  const lapsed = ws({ id: 'c9-lapsed', createdAt: T0 - 3 * 24 * HOUR });
  at(UP_2H - 2 * MIN);
  noteActivity('c9-recent');
  at(UP_2H - 11 * MIN);
  noteActivity('c9-lapsed');
  at(UP_2H);
  const roster = arm(db, storeOf(recent, lapsed));
  const byId = Object.fromEntries(roster().map((m) => [m.reader, m]));
  assert.equal(byId['c9-recent'].lastActivityAt, UP_2H - 2 * MIN);
  assert.equal(byId['c9-lapsed'].lastActivityAt, UP_2H - 11 * MIN);

  sweepBusLiveness();
  assert.equal(escalations(db, 'c9-ops', 'c9-recent'), 0, 'active 2 m ago: alive');
  assert.equal(escalations(db, 'c9-ops', 'c9-lapsed'), 1, 'active 11 m ago (control): escalated once');
});

test('#236 fleet-active: a fresh RUNNING child shields its coordinator on an app up 2 h', (t) => {
  // The other reader of `lastActivityAt` (`isMakingProgress`): a just-spawned running
  // child must count as progress. MUTANT (master's floor): child clock = app start (2 h)
  //   → not progress → its idle OPS is escalated to LEAD while its whole fleet works.
  const db = tmpBus(t);
  bootAppThen(UP_2H);
  const store = fleetStore;
  const fresh = ws({ id: 'c9-child-fresh', parentId: 'c9-ops2', status: 'running', createdAt: UP_2H - 30_000 });
  arm(db, store(fresh));
  sweepBusLiveness();
  assert.equal(escalations(db, 'c9-lead', 'c9-ops2'), 0, 'fresh running child → OPS shielded');

  // Control (same rig): a child running with NO clock for 11 m is not progress → OPS escalates.
  const stuck = ws({ id: 'c9-child-stuck', parentId: 'c9-ops2', status: 'running', createdAt: UP_2H - 11 * MIN });
  arm(db, store(stuck));
  sweepBusLiveness();
  assert.equal(escalations(db, 'c9-lead', 'c9-ops2'), 1, 'no-progress running child → OPS escalated');
});

test('#236 F1: a createdAt in the FUTURE (clock stepped back) floors at app start like master — never blinds liveness', (t) => {
  // MUTANTS: raw createdAt, and the literal `Math.min(createdAt, now)` clamp (= now on every
  //   sweep, still blind): a silent member and a wedged running child then read as fresh.
  const db = tmpBus(t);
  bootAppThen(UP_2H);
  const skewed = ws({ id: 'c9-future', createdAt: UP_2H + 2 * HOUR });
  const roster = arm(db, storeOf(skewed));
  assert.equal(roster()[0].lastActivityAt, T0, 'a future createdAt is ignored: app-start floor');
  sweepBusLiveness();
  assert.equal(escalations(db, 'c9-ops', 'c9-future'), 1, 'silent since app start (master parity)');

  // A wedged `running` child with a future createdAt must not shield its OPS either.
  const wedged = ws({ id: 'c9-child-future', parentId: 'c9-ops2', status: 'running', createdAt: UP_2H + 2 * HOUR });
  arm(db, fleetStore(wedged));
  sweepBusLiveness();
  assert.equal(escalations(db, 'c9-lead', 'c9-ops2'), 1, 'wedged future-createdAt child shields nothing');
});

test('#236 F3: a non-finite createdAt or activity stamp is ignored — floors at app start, never NaN-escalates', (t) => {
  // MUTANT: no `Number.isFinite` guard → Math.max(NaN, …) = NaN → `now - NaN <= STALE` is false
  //   → a member is escalated on an app up 1 minute.
  const db = tmpBus(t);
  bootAppThen(T0 + MIN);
  const nanBorn = ws({ id: 'c9-nan-born', createdAt: NaN });
  const infBorn = ws({ id: 'c9-inf-born', createdAt: Infinity });
  const nanSeen = ws({ id: 'c9-nan-seen', createdAt: T0 - 3 * 24 * HOUR });
  at(NaN);
  noteActivity('c9-nan-seen'); // Date.now() = NaN → the stored stamp is NaN
  at(T0 + MIN);
  const roster = arm(db, storeOf(nanBorn, infBorn, nanSeen));
  for (const m of roster()) assert.equal(m.lastActivityAt, T0, `${m.reader}: app-start floor`);
  sweepBusLiveness();
  for (const id of ['c9-nan-born', 'c9-inf-born', 'c9-nan-seen']) {
    assert.equal(escalations(db, 'c9-ops', id), 0, `${id}: app up 1 m → fresh`);
  }
  // Control (same rig): past the window of the floor they DO escalate — not permanent immunity.
  at(T0 + STALE_AFTER_MS + MIN);
  sweepBusLiveness();
  for (const id of ['c9-nan-born', 'c9-inf-born', 'c9-nan-seen']) {
    assert.equal(escalations(db, 'c9-ops', id), 1, `${id}: silent past the floor's window → escalated once`);
  }
});

// ── One chokepoint: the app-start floor has ONE reader ──────────────────────────

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) sourceFiles(p, out);
    else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) out.push(p);
  }
  return out;
}

test('#236 one chokepoint: only idle-clock.ts reads the raw app-start floor; both consumers call idleClockOf', () => {
  const srcDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const files = sourceFiles(srcDir);
  const read = (rel: string): string => fs.readFileSync(path.join(srcDir, rel), 'utf8');
  assert.ok(files.length > 50, `scanner saw ${files.length} files — it must actually read the tree`);

  // Every idle-clock computation goes through `idleClockOf` (main/idle-clock.ts): the raw
  // floor and the raw activity map are read nowhere else (the leaf only DEFINES them).
  const allowed = ['main/hibernation-activity.ts', 'main/idle-clock.ts'];
  const readers = (re: RegExp): string[] =>
    files.filter((f) => re.test(fs.readFileSync(f, 'utf8'))).map((f) => path.relative(srcDir, f)).sort();
  assert.deepEqual(readers(/getAppStartedAt/), allowed, 'a second reader of the app-start floor bypasses the createdAt bound');
  assert.deepEqual(readers(/\bgetLastActivity\(/), allowed, 'a second reader of the raw activity map bypasses the floor');

  // Positive controls: the two consumers really call the chokepoint, and index.ts wires
  // the shipped builder (a hand-rolled roster in index.ts would bypass every arm above).
  assert.match(read('main/hibernation.ts'), /idleClockOf\(ws\)/);
  assert.match(read('main/bus-liveness-roster.ts'), /lastActivityAt: idleClockOf\(ws\)/);
  assert.match(read('main/index.ts'), /setLivenessRoster\(buildLivenessRoster\(store, resolveWaveRunId\)\)/);
});
