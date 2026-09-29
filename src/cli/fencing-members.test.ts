import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as bus from '../main/bus.ts';
import { startRun } from '../main/bus-runs.ts';
import { DEFAULT_BUS_SWITCHES } from '../shared/bus-switches.ts';

// ISSUE #222 (ledger #224, track A6) — fencing must stop a ZOMBIE COORDINATOR,
// never lock out the run's MEMBERS after a coordinator restart.
//
// A coordinator restart bumps `runs.coordinator_generation`; every workspace of the
// run keeps the generation it was SPAWNED with in $ORCHESTRA_COORDINATOR_GENERATION.
// Fenced verbs are send / ack / gate-resolve, and the fence must apply ONLY when the
// writer IS the run's coordinator (handle == runs.coordinator) — a member's stale
// env generation is meaningless. Field: reviewer-t11's `orchestra ack` + status
// `send` were refused ("presented generation 1, but the run is at 2", rc=1).
//
// Drives the BUILT dist-electron/cli.js (bus.ts is bundled into it — REBUILD after
// touching src/main/bus.ts or these arms read a stale bundle) against an isolated
// ORCHESTRA_HOME, never the live bus. The run is seeded with the SHIPPED startRun +
// bumpCoordinatorGeneration; results are read back through the shipped openBus.
//
// MUST-FAIL on unfixed master: the three MEMBER arms (rc 0 expected, master rc 1).
// MUST-PASS both sides: the ZOMBIE COORDINATOR arms — a build that drops fencing
// entirely reddens them (and only them).
const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(here, '..', '..');
const CLI = path.join(REPO, 'dist-electron', 'cli.js');
const needsBuild = {
  skip: existsSync(CLI) ? false : 'dist-electron/cli.js not built — run `pnpm run build:cli`',
};

// Real runs anchor on the coordinator: run id == coordinator ws id == its handle.
const COORD = 'a6a6a6a6-0000-4000-8000-0000000000c0';
const MEMBER = 'a6a6a6a6-0000-4000-8000-0000000000e1';
const RUN = COORD;

interface Cli {
  code: number;
  stdout: string;
  stderr: string;
}

/** Fresh isolated home on btrfs (under node_modules/.cache, never tmpfs /tmp), with
 *  an offline store.json so `send --to` resolves handles without the app socket. */
function freshHome(t: { after: (fn: () => void) => void }): string {
  const parent = path.join(REPO, 'node_modules', '.cache');
  mkdirSync(parent, { recursive: true });
  const home = mkdtempSync(path.join(parent, 'fencing-a6-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const storeDir = path.join(home, 'userData', 'orchestra');
  mkdirSync(storeDir, { recursive: true });
  writeFileSync(
    path.join(storeDir, 'store.json'),
    JSON.stringify({
      workspaces: [
        { id: COORD, name: 'ops' },
        { id: MEMBER, name: 'member' },
      ],
    }),
  );
  return home;
}

/** Run `fn` with a DB opened on the isolated home's bus, then close it. */
function withDb<T>(home: string, fn: (db: bus.BusDb) => T): T {
  const db = bus.openBus(path.join(home, 'bus.sqlite'), {});
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

/** Seed the run: coordinator COORD, `fencing` frozen ON/OFF, bumped to generation 2
 *  (two coordinator restarts — a member spawned at generation 1 is stale, as in the
 *  field message). */
function seedRun(home: string, opts: { fencingOn: boolean } = { fencingOn: true }): void {
  withDb(home, (db) => {
    startRun(
      db,
      { id: RUN, kind: 'vague', coordinator: COORD },
      { ...DEFAULT_BUS_SWITCHES, fencing: opts.fencingOn },
    );
    bus.bumpCoordinatorGeneration(db, RUN);
    bus.bumpCoordinatorGeneration(db, RUN);
    assert.equal(bus.coordinatorGeneration(db, RUN), 2, 'seed: the run sits at generation 2');
  });
}

/** Put one outstanding delivery in `reader`'s lot and return its lot id. */
function seedLot(home: string, reader: string): number {
  return withDb(home, (db) => {
    bus.send(db, { runId: RUN, sender: 'someone-else', kind: 'status', body: `for-${reader}`, recipient: reader });
    const lot = bus.check(db, RUN, reader);
    assert.ok(lot.delivery, `seed: ${reader} has an outstanding lot`);
    return lot.delivery!.id;
  });
}

/** Drive the BUILT `orchestra <args>` as `who`, presenting `gen` as its
 *  $ORCHESTRA_COORDINATOR_GENERATION (null = var absent = the v1 unfenced path).
 *  ALLOWLIST env (never `{...process.env}`): no inherited ORCHESTRA_SOCK / WS id /
 *  run id can leak in, and HOME is the isolated home so no live socket pointer is
 *  found. Never throws on a non-zero exit. */
function orchestra(home: string, who: string, gen: number | null, args: string[]): Cli {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: home,
    ORCHESTRA_HOME: home,
    ORCHESTRA_WS_ID: who,
    ORCHESTRA_RUN_ID: RUN,
  };
  if (gen !== null) env.ORCHESTRA_COORDINATOR_GENERATION = String(gen);
  try {
    const stdout = execFileSync(process.execPath, [CLI, ...args], {
      encoding: 'utf8',
      env,
      cwd: home,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    });
    return { code: 0, stdout, stderr: '' };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? -1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

const ackedAt = (home: string, lotId: number): number | null =>
  withDb(home, (db) =>
    (db.prepare('SELECT acked_at FROM deliveries WHERE id=?').get(lotId) as { acked_at: number | null }).acked_at,
  );
const msgCount = (home: string, body: string): number =>
  withDb(home, (db) =>
    (db.prepare('SELECT COUNT(*) AS n FROM messages WHERE run_id=? AND body=?').get(RUN, body) as { n: number }).n,
  );
const fences = (home: string) => withDb(home, (db) => bus.fenceEvents(db, RUN));

const STALE = /stale coordinator generation/;

// ── MEMBER arms — the ones that FAIL on unfixed master ─────────────────────────

for (const presented of [1, 0]) {
  test(`member ACK with a stale env generation (${presented} < run 2) lands, no fence event`, needsBuild, (t) => {
    const home = freshHome(t);
    seedRun(home);
    const lotId = seedLot(home, MEMBER);
    const r = orchestra(home, MEMBER, presented, ['ack', String(lotId)]);
    assert.equal(r.code, 0, `member ack must not be fenced (master: rc 1 "stale coordinator generation"): ${r.stderr}`);
    assert.notEqual(ackedAt(home, lotId), null, 'the ack landed');
    assert.deepEqual(fences(home), [], 'a member write records NO fence_events row');
  });
}

test('member SEND (status → coordinator) with a stale env generation lands, no fence event', needsBuild, (t) => {
  const home = freshHome(t);
  seedRun(home);
  const r = orchestra(home, MEMBER, 1, ['send', '--type', 'status', '--to', COORD, 'member-status-a6']);
  assert.equal(r.code, 0, `member send must not be fenced (master: rc 1): ${r.stderr}`);
  assert.equal(msgCount(home, 'member-status-a6'), 1, 'the message row landed');
  assert.deepEqual(fences(home), [], 'a member write records NO fence_events row');
});

test('member gate RESOLVE with a stale env generation lands, no fence event', needsBuild, (t) => {
  const home = freshHome(t);
  seedRun(home);
  const gateId = withDb(home, (db) => bus.openGate(db, RUN, COORD, 'ruling?', MEMBER));
  const r = orchestra(home, MEMBER, 1, ['gate', 'resolve', String(gateId), '--resolution', 'member-ruling']);
  assert.equal(r.code, 0, `member gate resolve must not be fenced (master: rc 1): ${r.stderr}`);
  assert.notEqual(withDb(home, (db) => bus.getGate(db, gateId))?.resolved_at, null, 'the gate resolved');
  assert.deepEqual(fences(home), [], 'a member write records NO fence_events row');
});

test('member WORKER_DONE with a stale env generation lands, no fence event', needsBuild, (t) => {
  const home = freshHome(t);
  seedRun(home); // capability switch stays OFF (default) → a completion is counted, not refused
  const r = orchestra(home, MEMBER, 1, ['send', '--type', 'worker_done', '--to', COORD, 'member-done-a6']);
  assert.equal(r.code, 0, `member worker_done must not be fenced (master: rc 1): ${r.stderr}`);
  assert.equal(msgCount(home, 'member-done-a6'), 1, 'the completion landed');
  assert.deepEqual(fences(home), [], 'a member write records NO fence_events row');
});

// ── ZOMBIE COORDINATOR arms — must PASS on master AND after the fix; a mutant that
//    drops fencing entirely reddens exactly these (the #166 guarantee) ────────────

test('ZOMBIE coordinator SEND (handle == coordinator, old generation) is REFUSED, FIRED event', needsBuild, (t) => {
  const home = freshHome(t);
  seedRun(home);
  const r = orchestra(home, COORD, 1, ['send', '--type', 'status', '--to', MEMBER, 'zombie-send-a6']);
  assert.equal(r.code, 1, `the superseded coordinator is fenced (rc 1), got ${r.code}: ${r.stdout}`);
  assert.match(r.stderr, STALE);
  assert.equal(msgCount(home, 'zombie-send-a6'), 0, 'the stale write never landed');
  const ev = fences(home);
  assert.equal(ev.length, 1, 'exactly one fence_events row');
  assert.equal(ev[0].fired, 1);
  assert.equal(ev[0].actor, COORD, 'the event names the coordinator as the fenced writer');
  assert.equal(ev[0].presented, 1);
  assert.equal(ev[0].current, 2);
});

test('ZOMBIE coordinator ACK is REFUSED and its lot stays outstanding', needsBuild, (t) => {
  const home = freshHome(t);
  seedRun(home);
  const lotId = seedLot(home, COORD);
  const r = orchestra(home, COORD, 1, ['ack', String(lotId)]);
  assert.equal(r.code, 1, `stale coordinator ack is fenced: ${r.stdout}`);
  assert.match(r.stderr, STALE);
  assert.equal(ackedAt(home, lotId), null, 'the ack never ran');
  assert.equal(fences(home).filter((e) => e.fired === 1 && e.verb === 'ack').length, 1);
});

test('ZOMBIE coordinator gate RESOLVE is REFUSED and the gate stays open', needsBuild, (t) => {
  const home = freshHome(t);
  seedRun(home);
  const gateId = withDb(home, (db) => bus.openGate(db, RUN, MEMBER, 'ruling?', COORD));
  const r = orchestra(home, COORD, 1, ['gate', 'resolve', String(gateId), '--resolution', 'sneaky']);
  assert.equal(r.code, 1, `stale coordinator resolve is fenced: ${r.stdout}`);
  assert.match(r.stderr, STALE);
  assert.equal(withDb(home, (db) => bus.getGate(db, gateId))?.resolved_at, null, 'the resolve never ran');
});

test('a member spoofing --as <coordinator> with a stale generation is fenced (identity = handle, fail-closed)', needsBuild, (t) => {
  const home = freshHome(t);
  seedRun(home);
  const r = orchestra(home, MEMBER, 1, ['send', '--type', 'status', '--as', COORD, '--to', MEMBER, 'spoof-a6']);
  assert.equal(r.code, 1, `the handle IS the writer identity: ${r.stdout}`);
  assert.match(r.stderr, STALE);
  assert.equal(msgCount(home, 'spoof-a6'), 0);
});

// ── CONTROLS — the live coordinator, v1 callers, and the switch-OFF coexistence ──

test('control: the LIVE coordinator (generation == run) and a v1 no-generation coordinator both write', needsBuild, (t) => {
  const home = freshHome(t);
  seedRun(home);
  assert.equal(orchestra(home, COORD, 2, ['send', '--type', 'status', '--to', MEMBER, 'live-a6']).code, 0);
  assert.equal(orchestra(home, COORD, null, ['send', '--type', 'status', '--to', MEMBER, 'v1-a6']).code, 0);
  assert.equal(msgCount(home, 'live-a6'), 1);
  assert.equal(msgCount(home, 'v1-a6'), 1);
  assert.deepEqual(fences(home), []);
});

test('control: fencing switch OFF — a zombie coordinator is COUNTED (fired=0) and STILL writes', needsBuild, (t) => {
  const home = freshHome(t);
  seedRun(home, { fencingOn: false });
  const r = orchestra(home, COORD, 1, ['send', '--type', 'status', '--to', MEMBER, 'shadow-a6']);
  assert.equal(r.code, 0, `switch OFF never refuses: ${r.stderr}`);
  assert.equal(msgCount(home, 'shadow-a6'), 1, 'old channel authoritative — the write lands');
  const ev = fences(home);
  assert.equal(ev.length, 1);
  assert.equal(ev[0].fired, 0, 'COUNTED, not FIRED');
});
