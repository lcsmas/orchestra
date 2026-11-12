// #434 — a plain parent and its child talk over the bus. Drives the BUILT CLI (`send`, `check`, `ack`) against a REAL bus.sqlite and a
// REAL store.json (read by the CLI's own offline reader), plus the REAL run-start code (`ownerToMark` / `computeAnchorInfo` /
// `maybeStartRunAtAnchor` / `startRunsForParentless`) and the REAL wake sweep — no app. "Spawn" is composed exactly as `createWorkspace` does:
// the first spawn records `ownsRun` on the parent (store write), then the child's anchor row is started.
// Mutants: scripts/plain-parent-mutants.mjs (`pnpm run test:plain-parent-mutants`).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openBus, type BusDb } from './bus.ts';
import { busSwitch, getRun, refreezeRun, runFlags, startRun } from './bus-runs.ts';
import {
  computeAnchorInfo,
  maybeStartRunAtAnchor,
  ownerToMark,
  runAnchorProbe,
  startRunsForOwners,
  startRunsForParentless,
  type BusRunAnchorDeps,
} from './bus-run-anchor.ts';
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
import { offlineWaveNodes } from '../cli/index.ts';
import { runIdOf } from '../shared/run-position.ts';
import { DEFAULT_BUS_SWITCHES, type BusSwitches } from '../shared/bus-switches.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(here, '..', '..', 'dist-electron', 'cli.js');
const needsBuild = { skip: fs.existsSync(CLI) ? false : 'dist-electron/cli.js not built — run `pnpm run build:cli`' };

const LIVE: BusSwitches = { ...DEFAULT_BUS_SWITCHES, wake: true, askGate: true, liveness: true, pause: true };
const LIVE_LATER: BusSwitches = { ...LIVE, liveness: false };

const P = 'bbbbbbbb-0000-4000-8000-000000000001'; // a hand-made top-level agent, NEVER promoted
const C = 'bbbbbbbb-0000-4000-8000-000000000002'; // the agent it spawns
const L = 'bbbbbbbb-0000-4000-8000-000000000011'; // a LEAD (orchestrator kind)
const W = 'bbbbbbbb-0000-4000-8000-000000000012'; // a plain worker of L
const G = 'bbbbbbbb-0000-4000-8000-000000000013'; // the first agent W spawns

interface Rec {
  id: string;
  name: string;
  kind: string;
  parentId?: string;
  ownsRun?: boolean;
}
interface World {
  home: string;
  db: BusDb;
  storeFile: string;
  live: { current: BusSwitches };
  deps: BusRunAnchorDeps;
  warns: string[];
  wakes: { reader: string; text: string }[];
}
type After = { after: (fn: () => void) => void };

function world(t: After, recs: Array<Omit<Rec, 'name'>>): World {
  const home = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'orch-434-'));
  const db = openBus(path.join(home, 'bus.sqlite'));
  t.after(() => {
    __resetBusWakeForTests();
    db.close();
    fs.rmSync(home, { recursive: true, force: true });
  });
  const dir = path.join(home, 'userData', 'orchestra');
  fs.mkdirSync(dir, { recursive: true });
  const storeFile = path.join(dir, 'store.json');
  fs.writeFileSync(storeFile, JSON.stringify({ workspaces: recs.map((r) => ({ ...r, name: `ws-${r.id.slice(-2)}` })) }));
  const live = { current: LIVE };
  const warns: string[] = [];
  const deps: BusRunAnchorDeps = { getBus: () => db, startRun, getRun, refreezeRun, getLiveSwitches: () => live.current, warn: (m) => warns.push(m) };
  return { home, db, storeFile, live, deps, warns, wakes: [] };
}

const nodes = (w: World) => offlineWaveNodes(w.storeFile);
const runOf = (w: World, id: string): string => runIdOf(nodes(w).get(id)!, (x) => nodes(w).get(x));
const runs = (w: World) =>
  (w.db.prepare('SELECT id, kind, coordinator, parent_run_id AS parent FROM runs ORDER BY rowid').all() as Array<{ id: string; kind: string; coordinator: string; parent: string | null }>);
const rows = (w: World): number => (w.db.prepare('SELECT COUNT(*) AS c FROM messages').get() as { c: number }).c;

/** The app-start / creation mission of every top-level workspace (#433). */
function birth(w: World): void {
  const n = nodes(w);
  startRunsForParentless(w.deps, [...n.values()], (id) => n.get(id));
}

/** A SPAWN as `createWorkspace` composes it: the parent starts owning a run (store write of `ownsRun`), then the child's anchor row is started. */
function spawnFirstChild(w: World, child: string): void {
  const raw = JSON.parse(fs.readFileSync(w.storeFile, 'utf8')) as { workspaces: Rec[] };
  const n = nodes(w);
  const owner = ownerToMark(n.get(child)!, (id) => n.get(id));
  if (owner) raw.workspaces.find((r) => r.id === owner.id)!.ownsRun = true;
  fs.writeFileSync(w.storeFile, JSON.stringify(raw));
  const n2 = nodes(w);
  maybeStartRunAtAnchor(w.deps, computeAnchorInfo(n2.get(child)!, (id) => n2.get(id), runAnchorProbe(w.deps)));
}

interface Out {
  code: number;
  stdout: string;
  stderr: string;
}
/** The BUILT CLI as `ws` with `$ORCHESTRA_RUN_ID` = what the host exports (`resolveWaveRunId` = `runIdOf`). Allowlist env; the live socket never leaks. */
function cli(w: World, ws: string, args: string[]): Out {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: w.home,
    ORCHESTRA_HOME: w.home,
    ORCHESTRA_SOCK: path.join(w.home, 'dead.sock'),
    ORCHESTRA_WS_ID: ws,
    ORCHESTRA_RUN_ID: runOf(w, ws),
  };
  try {
    const stdout = execFileSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 });
    return { code: 0, stdout, stderr: '' };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? -1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}
const check = (w: World, ws: string, extra: string[] = []) => JSON.parse(cli(w, ws, ['check', ...extra]).stdout || '{"count":-1}') as { count: number; replay: boolean; lot: number | null; messages: Array<{ sender: string; body: string; kind: string }> };

/** The REAL wake sweep over this world's bus, the roster keyed on the same `runIdOf` the host's roster uses. */
function armWake(w: World, readers: string[]): void {
  __resetBusWakeForTests();
  __setBusReaderForTests(() => w.db);
  w.wakes.length = 0;
  setWakeRoster(() => readers.map((r) => ({ reader: r, wakeable: true, runId: runOf(w, r) })));
  setWakeDeliver(async (reader, text) => {
    w.wakes.push({ reader, text });
    return true;
  });
  setWakeSwitchReader((runId) => busSwitch(w.db, runId, 'wake'));
  setAskGateSwitchReader((runId) => busSwitch(w.db, runId, 'ask_gate'));
  __armStartedForTests();
}

const plainPair = (): Array<Omit<Rec, 'name'>> => [
  { id: P, kind: 'worktree' },
  { id: C, kind: 'worktree', parentId: P },
];

test('#434 a child spawned by a NEVER-PROMOTED parent sends a status that the parent receives exactly once and acknowledges', needsBuild, (t) => {
  const w = world(t, plainPair());
  // Failing control (the unfixed state): the parent has no run row — the child's send is refused, nothing written.
  const before = cli(w, C, ['send', '--type', 'status', '--to', P, 'report']);
  assert.equal(before.code, 1, `without the parent's run the send must be refused: ${before.stdout}`);
  assert.equal(rows(w), 0);

  birth(w); // P's mission is born with it (#433)
  spawnFirstChild(w, C); // the first spawn: P owns a run, C is a member of it
  assert.equal(runOf(w, C), P, 'the child is a member of its DIRECT parent\'s run');
  assert.equal(getRun(w.db, C), null, 'the child owns no run of its own yet');

  const sent = cli(w, C, ['send', '--type', 'status', '--to', P, 'tests are green']);
  assert.equal(sent.code, 0, sent.stderr + sent.stdout);
  assert.equal(rows(w), 1, 'exactly one row');
  assert.equal(w.db.prepare('SELECT run_id FROM messages').get().run_id, P, 'filed in the parent\'s run');

  const first = check(w, P);
  assert.equal(first.count, 1, 'the parent receives it');
  assert.equal(first.messages[0].body, 'tests are green');
  assert.equal(first.messages[0].sender, C);
  const replay = check(w, P);
  assert.equal([replay.replay, replay.count, replay.lot].join(), [true, 1, first.lot].join(), 'an un-acked lot is REPLAYED, not delivered anew');
  const acked = cli(w, P, ['ack', String(first.lot)]);
  assert.equal(acked.code, 0, acked.stderr);
  assert.equal(check(w, P).count, 0, 'acknowledged: nothing pending');
  assert.equal(rows(w), 1, 'still exactly one message on the bus');
});

test('#434 an IDLE plain parent is WOKEN by that mail, once, and reads it on the order', needsBuild, async (t) => {
  const w = world(t, plainPair());
  birth(w);
  spawnFirstChild(w, C);
  armWake(w, [P, C]);
  assert.equal(cli(w, C, ['send', '--type', 'status', '--to', P, 'wake me']).code, 0);
  await sweepBusWake();
  const mine = w.wakes.filter((x) => x.reader === P);
  assert.equal(mine.length, 1, 'the parent is woken');
  assert.ok(isWakeOrder(mine[0].text), 'a wake order, not content');
  assert.deepEqual(wakeOrderRuns(mine[0].text), [P], 'naming the run the mail sits in');
  assert.equal(w.wakes.some((x) => x.reader === C), false, 'the sender is not woken');
  const read = check(w, P, ['--run', P]);
  assert.equal(read.messages.map((m) => m.body).join(), 'wake me');
  assert.equal(cli(w, P, ['ack', String(read.lot), '--run', P]).code, 0);
  await sweepBusWake();
  assert.equal(busWakeCounters().fired, 1, 'acknowledged mail never wakes again');
});

test('#434 mail a worker holds in its parent\'s run BEFORE its first spawn stays reachable after the flip: the wake order names that run, `check --run` reads it, the ack clears it (a plain `check` now reads only the new own run)', needsBuild, async (t) => {
  const w = world(t, [
    { id: L, kind: 'orchestrator' },
    { id: W, kind: 'worktree', parentId: L },
    { id: G, kind: 'worktree', parentId: W },
  ]);
  birth(w);
  assert.equal(cli(w, L, ['send', '--type', 'status', '--to', W, 'task for w']).code, 0);
  spawnFirstChild(w, G); // W flips from member of L's run to owner of its own
  assert.equal(check(w, W).count, 0, 'a plain check reads the new own run only');
  armWake(w, [L, W]);
  await sweepBusWake();
  const mine = w.wakes.filter((x) => x.reader === W);
  assert.equal(mine.length, 1, 'the sweep still wakes W for the mail pending in the old run');
  assert.deepEqual(wakeOrderRuns(mine[0].text), [L], 'and the order names THAT run');
  const read = check(w, W, ['--run', L]);
  assert.equal(read.messages.map((m) => m.body).join(), 'task for w');
  assert.equal(cli(w, W, ['ack', String(read.lot), '--run', L]).code, 0);
  assert.equal(check(w, W, ['--run', L]).count, 0);
});

test('#434 a worker that spawns its FIRST agent owns a vague whose parent run is the run it is a member of, frozen at birth', needsBuild, (t) => {
  const w = world(t, [
    { id: L, kind: 'orchestrator' },
    { id: W, kind: 'worktree', parentId: L },
    { id: G, kind: 'worktree', parentId: W },
  ]);
  birth(w);
  assert.deepEqual(runs(w).map((r) => r.id), [L], 'only the LEAD\'s mission so far');
  assert.equal(runOf(w, W), L, 'W is a member of its parent\'s run until it spawns');
  assert.equal(getRun(w.db, W), null);

  w.live.current = LIVE_LATER; // the switches live AT W's FIRST SPAWN are what its vague freezes
  spawnFirstChild(w, G);
  assert.deepEqual(runs(w), [
    { id: L, kind: 'mission', coordinator: L, parent: null },
    { id: W, kind: 'vague', coordinator: W, parent: L },
  ]);
  assert.deepEqual(runFlags(w.db, W), LIVE_LATER, 'frozen from the live switches at birth');
  assert.equal(runOf(w, W), W, 'W now coordinates its own run');
  assert.equal(runOf(w, G), W, 'and G is a member of it');
  // idempotent: a second spawn / a relaunch never re-freezes or adds a row
  w.live.current = LIVE;
  spawnFirstChild(w, G);
  assert.equal(runs(w).length, 2);
  assert.deepEqual(runFlags(w.db, W), LIVE_LATER);
  // the new tiers talk: G → W and W → L both land and are readable
  assert.equal(cli(w, G, ['send', '--type', 'status', '--to', W, 'g done']).code, 0);
  assert.equal(check(w, W, ['--run', W]).messages[0]?.body, 'g done');
  const up = cli(w, W, ['send', '--type', 'status', '--to', L, 'w done']);
  assert.equal(up.code, 0, up.stderr);
  assert.equal(check(w, L, ['--run', W]).messages.some((m) => m.body === 'w done'), true, 'an OPS reaches its parent through the parent run pointer');
});

test('#434 app start: a plain parent that already has children (pre-#434 data) gets its vague, parents first; a promoted OPS keeps its row', needsBuild, (t) => {
  const w = world(t, [
    { id: L, kind: 'worktree' },
    { id: W, kind: 'worktree', parentId: L, ownsRun: true },
    { id: G, kind: 'worktree', parentId: W },
  ]);
  const n = nodes(w);
  const started = startRunsForOwners(w.deps, [...n.values()], (id) => n.get(id));
  assert.deepEqual(started, [W], 'the owner with a parent; the top-level one is the #433 sweep\'s');
  assert.deepEqual(runs(w).map((r) => `${r.id}:${r.kind}:${r.parent}`), [`${L}:mission:null`, `${W}:vague:${L}`], 'the run above it is started first, never a dangling parent_run_id');
});

// ── wiring pins: the host seams the composed arms above stand in for (workspaces.ts cannot load under node --test) ──
const src = (rel: string): string => fs.readFileSync(path.resolve(here, '..', '..', rel), 'utf8');

test('#434 wiring: a spawn records the parent as an owner BEFORE the child\'s anchor resolves; a session start self-heals; the app start migrates owners; the retired flag is migrated, never read', () => {
  const ws = src('src/main/workspaces.ts');
  const create = ws.slice(ws.indexOf('const remote = input.host?.kind'), ws.indexOf('return ws;', ws.indexOf('const remote = input.host?.kind')));
  assert.ok(create.indexOf('await ensureParentOwnsRun(ws)') >= 0 && create.indexOf('await ensureParentOwnsRun(ws)') < create.indexOf('await startBusRunAndWriteNotice(ws, remote)'), 'createWorkspace: ownership first, then the anchor row');
  assert.equal((ws.match(/markOrchestratorWorktree\([^)]*, true\)/g) ?? []).length, 0, 'no sentinel writer hard-codes the dual wording: it comes from coordinatorRoleOf');
  assert.match(ws, /await markOrchestratorWorktree\(updated\.worktreePath, coordinatorRoleOf\(updated\) === 'dual'\);/, 'the first-spawn owner gets the standing-role sentinel, wording from run-position');
  assert.match(ws, /await ensureParentOwnsRun\(updated\); \/\/ #434: the new parent owns a run now/, 'attach marks the new parent as an owner');
  assert.match(ws, /\.\.\.\(ownedByLinkOnly \? \{ ownsRun: undefined \} : \{\}\)/, 'attach clears an ownership that rested on having no parent');
  const sdk = src('src/main/agent-sdk.ts');
  assert.ok(sdk.indexOf('await ensureMemberRun(ws);') > 0 && sdk.indexOf('await ensureMemberRun(ws);') < sdk.indexOf('env.ORCHESTRA_RUN_ID = resolveWaveRunId(ws);'), 'a session start gives its parent a run BEFORE the env names it');
  const idx = src('src/main/index.ts');
  assert.match(idx, /if \(store\.loadedFromDisk\) await startRunsForParentlessWorkspaces\(\)[^\n]*\n[^\n]*\n\s*if \(store\.loadedFromDisk\) await startRunsForOwnerWorkspaces\(\)/, 'app start: top-level missions, then owners with a parent (parents first), both guarded by a loaded store');
  assert.match(src('src/main/store.ts'), /legacy\.canOrchestrate === true \|\| parentsOfSomeone\.has\(ws\.id\)/, 'store load migrates the retired flag / existing parents into ownsRun');
  assert.match(src('src/main/store.ts'), /\(!!ws\.parentId && !knownIds\.has\(ws\.parentId\)\)/, 'store load records a dangling-parent workspace as an owner (one answer with isTopLevel)');
  assert.equal((ws.match(/await recordDanglingOwners\(started\);/g) ?? []).length, 2, 'the app-start sweep AND the launch-time start record a dangling-parent owner');
});
