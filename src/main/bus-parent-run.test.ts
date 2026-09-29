// #221 (A5) — a workspace that anchors NO run gets a MISSION run automatically when
// it promotes a child, and the child's run nests under it (`parent_run_id` = parent).
//
// FIELD (2026-09-29): a hand-made metarepo LEAD (never promoted) promoted its OPS →
// the OPS became a ROOT mission, the LEAD stayed outside the bus hierarchy, so LEAD→OPS
// mail was refused (#155: the LEAD's run has no row) and OPS→LEAD mail landed in a run
// the LEAD never reads.
//
// EVERY arm drives the REAL `computeAnchorInfo` + `maybeStartRunAtAnchor` + `startRun`
// against a REAL SQLite bus (workspaces.ts cannot load under node --test). The mail/wake
// arms then drive the BUILT `dist-electron/cli.js send|check` and the REAL `sweepBusWake`
// in an isolated ORCHESTRA_HOME (never the live bus). `topology:'old'` builds the anchor
// from the untouched master primitives (2-arg `parentOrchestratorId`) — the failing control
// through the SAME measurement, so a rig that cannot fail is caught.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openBus, type BusDb } from './bus.ts';
import { getRun, refreezeRun, startRun, busSwitch, type BusRunRow } from './bus-runs.ts';
import {
  computeAnchorInfo,
  maybeStartRunAtAnchor,
  runAnchorProbe,
  type AnchorInfo,
  type BusRunAnchorDeps,
} from './bus-run-anchor.ts';
import {
  isPlainOwnAnchor,
  nearestOrchestratorId,
  nodeOrchestrates,
  parentOrchestratorId,
  type WaveNode,
} from './wave-run-id.ts';
import {
  sweepBusWake,
  busWakeCounters,
  setWakeRoster,
  setWakeDeliver,
  setWakeSwitchReader,
  setAskGateSwitchReader,
  __setBusReaderForTests,
  __resetBusWakeForTests,
  __armStartedForTests,
} from './bus-wake.ts';
import { isWakeOrder, wakeOrderRuns } from '../shared/bus-wake.ts';
import { DEFAULT_BUS_SWITCHES, type BusSwitches } from '../shared/bus-switches.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(here, '..', '..', 'dist-electron', 'cli.js');
// No skip flag on purpose: `pnpm run test` builds the CLI first (pretest), and a
// missing bundle must be a LOUD failure here, not a silent skip (`# skipped 0`).
const LEAD = '11111111-2221-4000-8000-00000000a501'; // hand-made LEAD, never promoted
const OPS = '22222222-2221-4000-8000-00000000a502'; // its child, promoted
const OPS2 = '33333333-2221-4000-8000-00000000a503'; // a second child promoted later
const GRAND = '44444444-2221-4000-8000-00000000a504'; // an orchestrator ABOVE the parent
const MEMBER = '55555555-2221-4000-8000-00000000a505'; // a plain member under OPS
const WORKER = '66666666-2221-4000-8000-00000000a506'; // a plain direct child of the LEAD, NOT promoted

const ALL_ON: BusSwitches = {
  delivery: true,
  wake: true,
  askGate: true,
  liveness: true,
  fencing: true,
  capability: true,
  receipts: true,
};

type After = { after: (fn: () => void) => void };
type Topology = 'new' | 'old';

/** The store stand-in: immutable nodes, replaced on promote like `{...ws, canOrchestrate:true}`. */
class Tree {
  readonly nodes = new Map<string, WaveNode>();
  add(n: WaveNode): void {
    this.nodes.set(n.id, Object.freeze({ ...n }));
  }
  promote(id: string): WaveNode {
    const n = this.nodes.get(id);
    assert.ok(n, `unknown node ${id}`);
    const p = Object.freeze({ ...n, canOrchestrate: true });
    this.nodes.set(id, p);
    return p;
  }
  readonly lookup = (id: string): WaveNode | undefined => this.nodes.get(id);
  /** What the app puts in `$ORCHESTRA_RUN_ID` (resolveWaveRunId). */
  runOf(id: string): string {
    return nearestOrchestratorId(this.nodes.get(id)!, this.lookup);
  }
}

/** The anchor as MASTER built it: 2-arg `parentOrchestratorId`, no implicit parent. */
function masterAnchor(ws: WaveNode, lookup: (id: string) => WaveNode | undefined): AnchorInfo {
  const anchorId = nearestOrchestratorId(ws, lookup);
  const a = anchorId === ws.id ? ws : lookup(anchorId);
  return {
    wsId: ws.id,
    anchorId,
    anchorIsOrchestrator: !!a && nodeOrchestrates(a),
    parentRunId: a ? parentOrchestratorId(a, lookup) : null,
  };
}

interface World {
  home: string;
  db: BusDb;
  tree: Tree;
  warns: string[];
  live: { current: BusSwitches };
  /** Promote `id` (the /promote → startRunForPromoted → maybeStartRunAtAnchor composition). */
  promote(id: string): AnchorInfo;
  /** A launch (or relaunch) of `id`: same anchor computation + idempotent start. */
  launch(id: string): AnchorInfo;
  runs(): { id: string; kind: string; coordinator: string; parent: string | null }[];
}

function tmpHome(t: After, tag: string): string {
  const dir = fs.mkdtempSync(path.join(os.homedir(), `.orchestra-a5-${tag}-`));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function world(
  t: After,
  topology: Topology,
  opts: {
    db?: BusDb | null;
    startRun?: BusRunAnchorDeps['startRun'];
    getRun?: BusRunAnchorDeps['getRun'];
  } = {},
): World {
  const home = tmpHome(t, 'parent-run');
  const db = opts.db === undefined ? openBus(path.join(home, 'bus.sqlite')) : opts.db;
  t.after(() => {
    try {
      db?.close();
    } catch {
      /* already closed */
    }
    __resetBusWakeForTests();
  });
  const tree = new Tree();
  const warns: string[] = [];
  const live = { current: ALL_ON };
  const deps: BusRunAnchorDeps = {
    getBus: () => db,
    startRun: opts.startRun ?? startRun,
    getRun: opts.getRun ?? getRun,
    refreezeRun,
    getLiveSwitches: () => live.current,
    warn: (m) => warns.push(m),
  };
  const anchorsRun = runAnchorProbe(deps);
  const anchorFor = (n: WaveNode): AnchorInfo =>
    topology === 'new'
      ? computeAnchorInfo(n, tree.lookup, anchorsRun)
      : masterAnchor(n, tree.lookup);
  return {
    home,
    db: db as BusDb,
    tree,
    warns,
    live,
    promote(id) {
      const anchor = anchorFor(tree.promote(id));
      maybeStartRunAtAnchor(deps, anchor);
      return anchor;
    },
    launch(id) {
      const anchor = anchorFor(tree.nodes.get(id)!);
      maybeStartRunAtAnchor(deps, anchor);
      return anchor;
    },
    runs() {
      if (!db) return [];
      return (
        db.prepare('SELECT id, kind, coordinator, parent_run_id FROM runs ORDER BY rowid').all() as {
          id: string;
          kind: string;
          coordinator: string;
          parent_run_id: string | null;
        }[]
      ).map((r) => ({ id: r.id, kind: r.kind, coordinator: r.coordinator, parent: r.parent_run_id }));
    },
  };
}

/** The field topology: a plain LEAD (never promoted) that spawned OPS under it. */
function fieldTree(w: World): void {
  w.tree.add({ id: LEAD, kind: 'worktree' });
  w.tree.add({ id: OPS, kind: 'worktree', parentId: LEAD });
}

// ── 1. MUST-FAIL ON MASTER: promote under a run-less parent ─────────────────────
test('#221 promote under a run-less parent → parent MISSION run + child VAGUE with parent_run_id=parent', (t) => {
  const w = world(t, 'new');
  fieldTree(w);
  w.promote(OPS);
  assert.deepEqual(w.runs(), [
    { id: LEAD, kind: 'mission', coordinator: LEAD, parent: null },
    { id: OPS, kind: 'vague', coordinator: OPS, parent: LEAD },
  ]);
});

test('#221 CONTROL (old topology, master primitives) — the same promote leaves the child a ROOT mission and the LEAD outside the bus', (t) => {
  const w = world(t, 'old');
  fieldTree(w);
  w.promote(OPS);
  // Positive control of the instrument: the rig CAN observe the broken topology.
  assert.deepEqual(w.runs(), [{ id: OPS, kind: 'mission', coordinator: OPS, parent: null }]);
});

// ── 2. The parent does NOT become an orchestrator ───────────────────────────────
test('#221 the parent stays a plain workspace: no orchestrator capability, own anchor, no anchor start of its own', (t) => {
  const w = world(t, 'new');
  fieldTree(w);
  const before = JSON.stringify(w.tree.nodes.get(LEAD));
  w.promote(OPS);
  const lead = w.tree.nodes.get(LEAD)!;
  assert.equal(JSON.stringify(lead), before, 'the LEAD record is byte-identical (frozen: any write would throw)');
  assert.equal(nodeOrchestrates(lead), false, 'the LEAD did not gain the orchestrator capability');
  assert.equal(w.tree.runOf(LEAD), LEAD, "the LEAD's wave run is still its own id (no member-of-OPS drift)");
  const rows = w.runs().length;
  const a = w.launch(LEAD);
  assert.equal(a.anchorIsOrchestrator, false, "the LEAD's own launch is a non-orchestrator anchor");
  assert.equal(w.runs().length, rows, "the LEAD's own launch adds no row");
});

// ── 3. Parent-run resolution accepts "an ancestor that anchors a run" ───────────
test('#221 an ancestor that already ANCHORS a run (not an orchestrator) is accepted as the parent run', (t) => {
  const w = world(t, 'new');
  fieldTree(w);
  const seededAt = 1_700_000_000_000;
  startRun(w.db, { id: LEAD, kind: 'mission', coordinator: LEAD }, ALL_ON);
  w.db.prepare('UPDATE runs SET created_at = ? WHERE id = ?').run(seededAt, LEAD);
  w.promote(OPS);
  assert.deepEqual(w.runs(), [
    { id: LEAD, kind: 'mission', coordinator: LEAD, parent: null },
    { id: OPS, kind: 'vague', coordinator: OPS, parent: LEAD },
  ]);
  const lead = getRun(w.db, LEAD)!;
  assert.equal(lead.created_at, seededAt, 'the pre-existing parent row was NOT re-created');
});

test('#221 a run-anchoring ancestor ABOVE a plain, run-less intermediate wins — the intermediate gets NO row', (t) => {
  const w = world(t, 'new');
  w.tree.add({ id: GRAND, kind: 'worktree' });
  w.tree.add({ id: LEAD, kind: 'worktree', parentId: GRAND });
  w.tree.add({ id: OPS, kind: 'worktree', parentId: LEAD });
  startRun(w.db, { id: GRAND, kind: 'mission', coordinator: GRAND }, ALL_ON);
  w.promote(OPS);
  assert.deepEqual(w.runs(), [
    { id: GRAND, kind: 'mission', coordinator: GRAND, parent: null },
    { id: OPS, kind: 'vague', coordinator: OPS, parent: GRAND },
  ]);
});

test('#221 a LAZY child row (member launch under an OPS with no row yet) also gets its run-less parent, frozen to the LIVE switches', (t) => {
  const w = world(t, 'new');
  fieldTree(w);
  w.tree.add({ id: MEMBER, kind: 'worktree', parentId: OPS });
  w.tree.promote(OPS); // promoted with no run start (pre-#134 legacy): no row yet
  w.live.current = { ...DEFAULT_BUS_SWITCHES, delivery: true, wake: true };
  w.launch(MEMBER);
  assert.deepEqual(w.runs(), [
    { id: LEAD, kind: 'mission', coordinator: LEAD, parent: null },
    { id: OPS, kind: 'vague', coordinator: OPS, parent: LEAD },
  ]);
  // A member spawn is NOT a wave boundary (no D1b refreeze), so this is the parent's INITIAL freeze.
  assert.equal(busSwitch(w.db, LEAD, 'delivery'), true);
  assert.equal(busSwitch(w.db, LEAD, 'fencing'), false);
});

// ── 4. Unchanged arms ───────────────────────────────────────────────────────────
test('#221 UNCHANGED — a parent that is an orchestrator (row present) keeps exactly its two-row nesting', (t) => {
  const w = world(t, 'new');
  w.tree.add({ id: LEAD, kind: 'orchestrator' });
  w.tree.add({ id: OPS, kind: 'worktree', parentId: LEAD });
  w.launch(LEAD);
  w.promote(OPS);
  assert.deepEqual(w.runs(), [
    { id: LEAD, kind: 'mission', coordinator: LEAD, parent: null },
    { id: OPS, kind: 'vague', coordinator: OPS, parent: LEAD },
  ]);
});

test('#221 UNCHANGED — an orchestrator parent whose row is MISSING is NOT given a row by the child (only the child row lands, as on master)', (t) => {
  const w = world(t, 'new');
  w.tree.add({ id: LEAD, kind: 'orchestrator' });
  w.tree.add({ id: OPS, kind: 'worktree', parentId: LEAD });
  w.promote(OPS);
  assert.deepEqual(w.runs(), [{ id: OPS, kind: 'vague', coordinator: OPS, parent: LEAD }]);
});

test('#221 UNCHANGED — a plain member of an OPS promoting a child nests under the OPS run, never a row for the member', (t) => {
  const w = world(t, 'new');
  w.tree.add({ id: GRAND, kind: 'orchestrator' });
  w.tree.add({ id: MEMBER, kind: 'worktree', parentId: GRAND });
  w.tree.add({ id: OPS, kind: 'worktree', parentId: MEMBER });
  w.launch(GRAND);
  w.promote(OPS);
  assert.deepEqual(w.runs(), [
    { id: GRAND, kind: 'mission', coordinator: GRAND, parent: null },
    { id: OPS, kind: 'vague', coordinator: OPS, parent: GRAND },
  ]);
});

test('#221 UNCHANGED — a top-level promote (no parent) and a DANGLING parent stay root missions with no extra row', (t) => {
  const top = world(t, 'new');
  top.tree.add({ id: OPS, kind: 'worktree' });
  top.promote(OPS);
  assert.deepEqual(top.runs(), [{ id: OPS, kind: 'mission', coordinator: OPS, parent: null }]);

  const dangling = world(t, 'new');
  dangling.tree.add({ id: OPS, kind: 'worktree', parentId: LEAD }); // LEAD deleted
  dangling.promote(OPS);
  assert.deepEqual(dangling.runs(), [{ id: OPS, kind: 'mission', coordinator: OPS, parent: null }]);
});

// ── 5. Idempotence ──────────────────────────────────────────────────────────────
test('#221 IDEMPOTENT — re-promote, restart/relaunch, a member launch and a SECOND child never create a second parent run', (t) => {
  const w = world(t, 'new');
  fieldTree(w);
  w.tree.add({ id: OPS2, kind: 'worktree', parentId: LEAD });
  w.tree.add({ id: MEMBER, kind: 'worktree', parentId: OPS });
  w.promote(OPS);
  const snap = (id: string): BusRunRow => getRun(w.db, id)!;
  const lead0 = snap(LEAD);
  const ops0 = snap(OPS);
  w.promote(OPS); // re-promote
  w.launch(OPS); // restart of the OPS
  w.launch(MEMBER); // a member launch under the OPS
  w.launch(LEAD); // the LEAD's own (re)launch
  assert.equal(w.runs().length, 2, 'still exactly two rows after the repeats');
  assert.deepEqual(snap(LEAD), lead0, 'the parent row is byte-identical (never re-created / re-frozen)');
  assert.deepEqual(snap(OPS), ops0, 'the child row is byte-identical');
  // A second child reaches the parent through the "ancestor that anchors a run" arm.
  w.promote(OPS2);
  assert.deepEqual(w.runs(), [
    { id: LEAD, kind: 'mission', coordinator: LEAD, parent: null },
    { id: OPS, kind: 'vague', coordinator: OPS, parent: LEAD },
    { id: OPS2, kind: 'vague', coordinator: OPS2, parent: LEAD },
  ]);
  assert.equal(snap(LEAD).created_at, lead0.created_at, 'still ONE parent row, same creation time');
});

test('#221 the auto-created parent freezes the LIVE switches at promote time (same as every other run start)', (t) => {
  const w = world(t, 'new');
  fieldTree(w);
  w.live.current = { ...DEFAULT_BUS_SWITCHES, delivery: true, wake: true };
  w.promote(OPS);
  assert.equal(busSwitch(w.db, LEAD, 'delivery'), true);
  assert.equal(busSwitch(w.db, LEAD, 'wake'), true);
  assert.equal(busSwitch(w.db, LEAD, 'fencing'), false, 'a switch that was OFF live is frozen OFF');
});

// ── 6. D1: the bus never blocks a promote ───────────────────────────────────────
test('#221 D1 — a down bus and a throwing parent start neither throw nor leave a child row with a dangling parent', (t) => {
  const down = world(t, 'new', { db: null });
  fieldTree(down);
  assert.doesNotThrow(() => down.promote(OPS));

  const w = world(t, 'new', {
    startRun: (db, input, live) => {
      if (input.id === LEAD) throw new Error('parent start boom');
      return startRun(db, input, live);
    },
  });
  fieldTree(w);
  assert.doesNotThrow(() => w.promote(OPS));
  assert.deepEqual(w.runs(), [], 'the parent start failed BEFORE the child row — no dangling parent_run_id');
  assert.ok(w.warns.some((m) => m.includes('could not start run')), `warn logged: ${w.warns.join('|')}`);
});

test('#221 D1 — a THROWING run-row read never throws out of the anchor computation (it runs on every launch)', (t) => {
  const w = world(t, 'new', {
    getRun: () => {
      throw new Error('getRun boom');
    },
  });
  fieldTree(w);
  assert.doesNotThrow(() => w.promote(OPS));
  assert.deepEqual(w.runs(), [], 'nothing started, launch proceeds');
});

test('#221 a plain workspace anchor (no orchestrator anywhere) carries NO parent info, even under a plain parent', (t) => {
  const w = world(t, 'new');
  w.tree.add({ id: LEAD, kind: 'worktree' });
  w.tree.add({ id: MEMBER, kind: 'worktree', parentId: LEAD });
  const a = w.launch(MEMBER);
  assert.equal(a.anchorIsOrchestrator, false);
  assert.equal(a.parentRunId, null);
  assert.equal(a.parentRunImplicit, undefined);
  assert.deepEqual(w.runs(), []);
});

// ── 7. LEAD↔OPS mail and wake, END TO END, both directions ──────────────────────
interface Cli {
  code: number;
  stdout: string;
  stderr: string;
}

/** Drive the BUILT `orchestra <verb>` as `from` (its run = what the app exports). ALLOWLIST
 *  env: the agent's own $ORCHESTRA_SOCK/$ORCHESTRA_RUN_ID must never reach the child. */
function cli(w: World, from: string, args: string[]): Cli {
  assert.ok(fs.existsSync(CLI), 'dist-electron/cli.js missing — run `pnpm run build:cli` (pretest does)');
  const wt = path.join(w.home, 'wt', from);
  fs.mkdirSync(wt, { recursive: true });
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: w.home,
    ORCHESTRA_HOME: w.home,
    ORCHESTRA_WS_ID: from,
    ORCHESTRA_RUN_ID: w.tree.runOf(from),
    ORCHESTRA_WORKSPACE_PATH: wt,
  };
  assert.equal(env.ORCHESTRA_SOCK, undefined, 'the live socket must not leak into the rig');
  try {
    const stdout = execFileSync(process.execPath, [CLI, ...args], {
      encoding: 'utf8',
      env,
      cwd: wt,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    });
    return { code: 0, stdout, stderr: '' };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? -1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

/** The offline handle store the CLI resolves `--to` against (no app in the rig). */
function seedStore(w: World): void {
  const dir = path.join(w.home, 'userData', 'orchestra');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'store.json'),
    JSON.stringify({
      workspaces: [...w.tree.nodes.values()].map((n) => ({ ...n, name: `ws-${n.id.slice(0, 4)}` })),
    }),
  );
}

function messageCount(w: World): number {
  return (w.db.prepare('SELECT COUNT(*) AS c FROM messages').get() as { c: number }).c;
}

/** Arm the REAL sweep with the production accessors over this world's bus. */
function armWake(w: World, readers: string[]): { reader: string; text: string }[] {
  const wakes: { reader: string; text: string }[] = [];
  __resetBusWakeForTests();
  __setBusReaderForTests(() => w.db);
  setWakeRoster(() => readers.map((r) => ({ reader: r, wakeable: true, runId: w.tree.runOf(r) })));
  setWakeDeliver(async (reader, text) => {
    wakes.push({ reader, text });
    return true;
  });
  setWakeSwitchReader((runId) => busSwitch(w.db, runId, 'wake'));
  setAskGateSwitchReader((runId) => busSwitch(w.db, runId, 'ask_gate'));
  __armStartedForTests();
  return wakes;
}

interface Exchange {
  send: Cli;
  /** What the reader saw by following the wake order verbatim (`check --run <r>` per named run). */
  read: string;
  woken: boolean;
  wakeRuns: string[];
  rows: number;
}

/** `from` sends `marker` to `to` through the real CLI; the real sweep runs; then `to` obeys the wake
 *  order (`check --run <r>` per run it names — a plain `check` reads only its OWN run). One observation
 *  per direction, measured identically for BOTH topologies. */
async function exchange(w: World, from: string, to: string, marker: string): Promise<Exchange> {
  const wakes = armWake(w, [LEAD, OPS]);
  const rowsBefore = messageCount(w);
  const send = cli(w, from, ['send', '--type', 'status', '--to', to, marker]);
  const rows = messageCount(w) - rowsBefore;
  await sweepBusWake();
  const mine = wakes.filter((x) => x.reader === to);
  const wakeRuns = mine.length ? wakeOrderRuns(mine[0].text) : [];
  const read = wakeRuns.map((r) => cli(w, to, ['check', '--run', r]).stdout).join('');
  return {
    send,
    read,
    woken: mine.length === 1 && isWakeOrder(mine[0].text) && busWakeCounters().fired === 1,
    wakeRuns,
    rows,
  };
}

async function fieldWorld(t: After, topology: Topology): Promise<World> {
  const w = world(t, topology);
  fieldTree(w);
  w.promote(OPS);
  seedStore(w);
  // Positive control: the CLI opens THIS home's bus (an unreadable bus fails `check`).
  const probe = cli(w, OPS, ['check']);
  assert.equal(probe.code, 0, `check must run in the isolated home: ${probe.stderr}`);
  return w;
}

test('#221 E2E new topology — LEAD→OPS: delivered, the OPS is WOKEN naming the LEAD run and reads it', async (t) => {
  const w = await fieldWorld(t, 'new');
  const x = await exchange(w, LEAD, OPS, 'mail-lead-to-ops');
  assert.equal(x.send.code, 0, `send: ${x.send.stderr}`);
  assert.equal(x.rows, 1, 'exactly one row landed');
  assert.equal(x.woken, true, 'the OPS was woken (fired=1)');
  assert.deepEqual(x.wakeRuns, [LEAD], 'the wake order names the run the mail sits in');
  assert.match(x.read, /mail-lead-to-ops/, 'obeying the wake order, the OPS reads the LEAD mail');
});

test('#221 E2E new topology — OPS→LEAD: delivered, the LEAD is WOKEN naming the OPS run and reads it', async (t) => {
  const w = await fieldWorld(t, 'new');
  const x = await exchange(w, OPS, LEAD, 'mail-ops-to-lead');
  assert.equal(x.send.code, 0, `send: ${x.send.stderr}`);
  assert.equal(x.rows, 1);
  assert.equal(x.woken, true, 'the LEAD was woken (fired=1)');
  assert.deepEqual(x.wakeRuns, [OPS]);
  assert.match(x.read, /mail-ops-to-lead/, 'obeying the wake order, the LEAD reads the OPS mail');
});

test('#221 E2E OLD topology (failing control) — LEAD→OPS is REFUSED: the LEAD run has no row, nothing written, nobody woken', async (t) => {
  const w = await fieldWorld(t, 'old');
  const x = await exchange(w, LEAD, OPS, 'mail-lead-to-ops');
  assert.equal(x.send.code, 1, 'the send is refused');
  assert.match(x.send.stderr, /has no row in the bus 'runs' table/);
  assert.equal(x.rows, 0, 'no row written');
  assert.equal(x.woken, false);
  assert.equal(x.read, '', 'and nothing is read');
});

test('#221 E2E OLD topology (failing control) — OPS→LEAD is refused loudly (unreachable): nothing written, LEAD never woken', async (t) => {
  const w = await fieldWorld(t, 'old');
  const x = await exchange(w, OPS, LEAD, 'mail-ops-to-lead');
  // Pre-F1(b) this send was ACCEPTED into a run the LEAD is never woken for (silent loss).
  assert.equal(x.send.code, 1, 'refused by the store-aware reachability guard');
  assert.match(x.send.stderr, /plain workspace outside run/);
  assert.equal(x.rows, 0);
  assert.equal(x.woken, false, 'the LEAD is never woken');
  assert.equal(x.read, '', 'and reads nothing');
  assert.equal(busWakeCounters().fired, 0);
});

// ── 7b. F1 (OPS ruling): the plain parent LOSES NOTHING ─────────────────────────
test('#221 F1(b) the LEAD → a plain NON-member child `send` fails LOUDLY (never rc 0 + a row nobody can read)', async (t) => {
  const w = world(t, 'new');
  fieldTree(w);
  w.tree.add({ id: WORKER, kind: 'worktree', parentId: LEAD });
  w.tree.add({ id: MEMBER, kind: 'worktree', parentId: OPS });
  w.promote(OPS);
  seedStore(w);
  const wakes = armWake(w, [LEAD, OPS, WORKER, MEMBER]);
  const rows0 = messageCount(w);
  const lost = cli(w, LEAD, ['send', '--type', 'status', '--to', WORKER, 'mail-lead-to-worker']);
  assert.equal(lost.code, 1, `refused, not silently accepted: rc ${lost.code} ${lost.stdout}`);
  assert.match(lost.stderr, /outside this run|anchors no run/, 'names the cause');
  assert.match(lost.stderr, /orchestra message/, 'names the channel that DOES reach a plain workspace');
  assert.equal(messageCount(w) - rows0, 0, 'nothing written');
  await sweepBusWake();
  assert.equal(wakes.length, 0, 'and nobody woken');
  // Controls: a MEMBER of the OPS run (row-less, but related) and the OPS itself stay deliverable.
  const toMember = cli(w, LEAD, ['send', '--type', 'status', '--to', MEMBER, 'mail-lead-to-member']);
  assert.equal(toMember.code, 0, `member of a related run is unchanged: ${toMember.stderr}`);
  const toOps = cli(w, LEAD, ['send', '--type', 'status', '--to', OPS, 'mail-lead-to-ops']);
  assert.equal(toOps.code, 0, `the promoted child is unchanged: ${toOps.stderr}`);
  assert.equal(messageCount(w) - rows0, 2, 'exactly the two deliverable sends landed');
});

test('#221 F1(a) the plain child → LEAD `send` is refused loudly exactly as on master (its own run has no row)', (t) => {
  const w = world(t, 'new');
  fieldTree(w);
  w.tree.add({ id: WORKER, kind: 'worktree', parentId: LEAD });
  w.promote(OPS);
  seedStore(w);
  const rows0 = messageCount(w);
  const r = cli(w, WORKER, ['send', '--type', 'status', '--to', LEAD, 'mail-worker-to-lead']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /has no row in the bus 'runs' table/);
  assert.equal(messageCount(w) - rows0, 0);
});

test('#221 isPlainOwnAnchor — a run-less parent is one; an orchestrator, a member and a promoted child are not', (t) => {
  const w = world(t, 'new');
  fieldTree(w);
  w.tree.add({ id: MEMBER, kind: 'worktree', parentId: OPS });
  w.promote(OPS);
  assert.equal(isPlainOwnAnchor(w.tree.nodes.get(LEAD)!, w.tree.lookup), true, 'the LEAD (plain, own anchor)');
  assert.equal(isPlainOwnAnchor(w.tree.nodes.get(OPS)!, w.tree.lookup), false, 'the promoted OPS orchestrates');
  assert.equal(isPlainOwnAnchor(w.tree.nodes.get(MEMBER)!, w.tree.lookup), false, 'a member anchors on its OPS');
  w.tree.add({ id: GRAND, kind: 'orchestrator' });
  assert.equal(isPlainOwnAnchor(w.tree.nodes.get(GRAND)!, w.tree.lookup), false, 'an orchestrator-kind node');
});

// ── 7b'. Round 2: the PRODUCTION (socket) branch + the sibling verbs `ask` / `gate open` ─────────────
function sibWorld(t: After, topology: Topology): World {
  const w = world(t, topology);
  fieldTree(w);
  w.tree.add({ id: WORKER, kind: 'worktree', parentId: LEAD });
  w.tree.add({ id: MEMBER, kind: 'worktree', parentId: OPS });
  w.promote(OPS);
  seedStore(w);
  return w;
}

/** ASYNC CLI run (spawn): a fake app socket lives in THIS process, so execFileSync would deadlock on it. */
function cliAsync(w: World, from: string, args: string[], sock?: string): Promise<Cli> {
  const wt = path.join(w.home, 'wt', from);
  fs.mkdirSync(wt, { recursive: true });
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: w.home,
    ORCHESTRA_HOME: w.home,
    ORCHESTRA_WS_ID: from,
    ORCHESTRA_RUN_ID: w.tree.runOf(from),
    ORCHESTRA_WORKSPACE_PATH: wt,
  };
  if (sock) env.ORCHESTRA_SOCK = sock; // ONLY the rig's fake app — never the live socket
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [CLI, ...args], { env, cwd: wt });
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', (d) => (stdout += d));
    p.stderr.on('data', (d) => (stderr += d));
    p.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

/** A fake APP answering `/resolveHandle` exactly like the production handler (`runId` present or, for an
 *  OLDER app, absent) — the branch every offline-store arm above cannot reach. */
async function withApp(
  w: World,
  withRunId: boolean,
  fn: (sock: string) => Promise<void>,
): Promise<void> {
  const sock = path.join(w.home, 'app.sock');
  const srv = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (req.url === '/resolveHandle') {
        res.end(
          JSON.stringify({
            ok: true,
            workspaces: [...w.tree.nodes.values()].map((n) => ({
              id: n.id,
              name: `ws-${n.id.slice(0, 4)}`,
              ...(withRunId ? { runId: w.tree.runOf(n.id) } : {}),
            })),
          }),
        );
      } else {
        res.statusCode = 404;
        res.end(JSON.stringify({ ok: false, error: `no route ${req.url}` }));
      }
    });
  });
  await new Promise<void>((r) => srv.listen(sock, r));
  try {
    await fn(sock);
  } finally {
    await new Promise((r) => srv.close(r));
  }
}

test('#221 F4 SOCKET branch (production): LEAD → plain non-member child `send` is refused loudly, 0 rows', async (t) => {
  const w = sibWorld(t, 'new');
  await withApp(w, true, async (sock) => {
    const rows0 = messageCount(w);
    const r = await cliAsync(w, LEAD, ['send', '--type', 'status', '--to', WORKER, 'x'], sock);
    assert.equal(r.code, 1, `rc ${r.code} ${r.stdout}`);
    assert.match(r.stderr, /plain workspace outside run/);
    assert.equal(messageCount(w) - rows0, 0);
    // Positive control: the same socket path still delivers a reachable recipient (the app was really used).
    const ok = await cliAsync(w, LEAD, ['send', '--type', 'status', '--to', OPS, 'y'], sock);
    assert.equal(ok.code, 0, ok.stderr);
  });
});

test('#221 F4 SOCKET branch, OLDER app (no runId): not judged — documented skew, rc 0', async (t) => {
  // MUTANT: `runId: w.runId ?? w.id` (older-app default = self) would refuse here → this arm reddens.
  const w = sibWorld(t, 'new');
  await withApp(w, false, async (sock) => {
    const r = await cliAsync(w, LEAD, ['send', '--type', 'status', '--to', WORKER, 'x'], sock);
    assert.equal(r.code, 0, `older app is permissive: ${r.stderr}`);
  });
});

test('#221 F5 sibling verbs — `ask --to` and `gate open --to` a plain non-member child are refused loudly, 0 rows', async (t) => {
  const w = sibWorld(t, 'new');
  const rows0 = messageCount(w);
  const ask = await cliAsync(w, LEAD, ['ask', '--to', WORKER, 'q?']);
  assert.equal(ask.code, 1, `ask rc ${ask.code} ${ask.stdout}`);
  assert.match(ask.stderr, /plain workspace outside run/);
  const gate = await cliAsync(w, LEAD, ['gate', 'open', '--to', WORKER, 'gq?']);
  assert.equal(gate.code, 1, `gate open rc ${gate.code} ${gate.stdout}`);
  assert.match(gate.stderr, /plain workspace outside run/);
  assert.equal(messageCount(w) - rows0, 0, 'no question row, no gate row');
});

test('#221 F5 sibling verbs — controls: a related OPS / MEMBER, `--to human` and a SHORT handle still work (canonicalized)', async (t) => {
  const w = sibWorld(t, 'new');
  assert.equal((await cliAsync(w, LEAD, ['ask', '--to', OPS, 'q-ops?'])).code, 0, 'ask → OPS');
  assert.equal((await cliAsync(w, LEAD, ['ask', '--to', MEMBER, 'q-member?'])).code, 0, 'ask → member of the OPS');
  assert.equal((await cliAsync(w, LEAD, ['gate', 'open', '--to', 'human', 'ruling?'])).code, 0, 'gate → human');
  const short = await cliAsync(w, OPS, ['ask', '--to', LEAD.slice(0, 8), 'q-short?']);
  assert.equal(short.code, 0, short.stderr);
  const row = w.db.prepare("SELECT recipient FROM messages WHERE body = 'q-short?'").get() as { recipient: string };
  assert.equal(row.recipient, LEAD, 'the short handle was canonicalized to the FULL id before the row was written');
});

test('#221 F5 FIELD topology (root OPS, row-less LEAD): OPS `ask` / `gate open` --to LEAD are refused loudly like `send`', async (t) => {
  const w = sibWorld(t, 'old');
  const rows0 = messageCount(w);
  assert.equal((await cliAsync(w, OPS, ['send', '--type', 'status', '--to', LEAD, 'x'])).code, 1, 'send (control, already loud)');
  const ask = await cliAsync(w, OPS, ['ask', '--to', LEAD, 'q?']);
  assert.equal(ask.code, 1, `ask rc ${ask.code} ${ask.stdout}`);
  const gate = await cliAsync(w, OPS, ['gate', 'open', '--to', LEAD, 'gq?']);
  assert.equal(gate.code, 1, `gate open rc ${gate.code} ${gate.stdout}`);
  assert.equal(messageCount(w) - rows0, 0);
});

// ── 7c. F2 / F3 (review): pin the direct-parent choice and the probe fail-direction ─
test('#221 F2 GRAND(plain) → LEAD(plain) → OPS: the DIRECT parent gets the row, the topmost ancestor none', (t) => {
  const w = world(t, 'new');
  w.tree.add({ id: GRAND, kind: 'worktree' });
  w.tree.add({ id: LEAD, kind: 'worktree', parentId: GRAND });
  w.tree.add({ id: OPS, kind: 'worktree', parentId: LEAD });
  w.promote(OPS);
  assert.deepEqual(w.runs(), [
    { id: LEAD, kind: 'mission', coordinator: LEAD, parent: null },
    { id: OPS, kind: 'vague', coordinator: OPS, parent: LEAD },
  ]);
});

test('#221 F3 a THROWING run-row probe falls to the SAFE direction: implicit parent row created, no dangling pointer', (t) => {
  // getRun throws ONLY for the parent id (the probe's question); the child-row check still works.
  const w = world(t, 'new', {
    getRun: (db, id) => {
      if (id === LEAD) throw new Error('probe boom');
      return getRun(db, id);
    },
  });
  fieldTree(w);
  w.promote(OPS);
  assert.deepEqual(w.runs(), [
    { id: LEAD, kind: 'mission', coordinator: LEAD, parent: null },
    { id: OPS, kind: 'vague', coordinator: OPS, parent: LEAD },
  ]);
});

test('#221 F3 runAnchorProbe answers FALSE for no bus, a throwing bus getter and a throwing read', () => {
  const base: BusRunAnchorDeps = {
    getBus: () => null,
    startRun,
    getRun,
    refreezeRun,
    getLiveSwitches: () => ALL_ON,
    warn: () => {},
  };
  assert.equal(runAnchorProbe(base)('x'), false, 'no bus');
  assert.equal(
    runAnchorProbe({
      ...base,
      getBus: () => {
        throw new Error('bus boom');
      },
    })('x'),
    false,
    'throwing getBus',
  );
  assert.equal(
    runAnchorProbe({
      ...base,
      getBus: () => ({}) as BusDb,
      getRun: () => {
        throw new Error('read boom');
      },
    })('x'),
    false,
    'throwing read',
  );
  // Positive control: a real row reads TRUE, an absent one FALSE.
  const dir = fs.mkdtempSync(path.join(os.homedir(), '.orchestra-a5-probe-'));
  const db = openBus(path.join(dir, 'bus.sqlite'));
  try {
    startRun(db, { id: 'anchored', kind: 'mission', coordinator: 'anchored' }, ALL_ON);
    const p = runAnchorProbe({ ...base, getBus: () => db });
    assert.equal(p('anchored'), true);
    assert.equal(p('absent'), false);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── 8. Wiring: the seam in un-importable workspaces.ts ──────────────────────────
test('#221 wiring — resolveAnchorInfo hands computeAnchorInfo the store lookup AND the run-row probe', () => {
  const src = fs.readFileSync(path.join(here, 'workspaces.ts'), 'utf8');
  const i = src.indexOf('export function resolveAnchorInfo(');
  assert.ok(i > 0, 'resolveAnchorInfo not found');
  const body = src.slice(i, src.indexOf('\n}\n', i));
  assert.match(
    body,
    /computeAnchorInfo\(\s*ws,\s*\(id\) => store\.getWorkspace\(id\),\s*runAnchorProbe\(busRunAnchorDeps\),?\s*\)/,
  );
});

test('#221 wiring — the P4 gate, /resolveHandle and the CLI send carry the F1 fixes', () => {
  const ws = fs.readFileSync(path.join(here, 'workspaces.ts'), 'utf8');
  const cliSrc = fs.readFileSync(path.join(here, '..', 'cli', 'index.ts'), 'utf8');
  const fn = (src: string, decl: string): string => {
    const i = src.indexOf(decl);
    assert.ok(i > 0, `${decl} not found`);
    return src.slice(i, src.indexOf('\n}\n', i));
  };
  assert.match(
    fn(ws, 'export async function dispatchMessageRequest('),
    /isPlainOwnAnchor\(targetForGate,[\s\S]*\(!plainAnchor \|\| senderHasBusRoute\)/,
    'P4 gate exempts a plain own-anchor, but only for a sender WITHOUT a bus route',
  );
  assert.match(
    fn(ws, 'export function dispatchResolveHandleRequest('),
    /runId: resolveWaveRunId\(w\)/,
    '/resolveHandle carries the wave run',
  );
  assert.match(cliSrc, /toRunId: canonTo\?\.runId \?\? null/, 'CLI send passes the recipient wave run');
  assert.match(cliSrc, /askTo\?\.runId \?\? null/, 'CLI ask passes the recipient wave run');
  assert.match(cliSrc, /gateToRunId = c\.runId/, 'CLI gate open passes the recipient wave run');
  assert.match(
    fn(ws, 'export async function dispatchMessageRequest('),
    /const partiesRunId =\s*recipientWs && !plainAnchor/,
    'the mirrored row skips a plain own-anchor (no second delivery by wake)',
  );
});
