// #435 (ADR 0012, spec #431 story 11) — the task given to `orchestra spawn` IS the dispatch. Drives the BUILT CLI (`token`, `send`, `check`) against a REAL
// bus.sqlite and a REAL store.json (read by the CLI's own offline reader), plus the SHIPPED `recordSpawnDispatch` / `startAfterDispatch` and the REAL run-start
// code — no app. "Spawn" is composed exactly as `dispatchSpawnRequest` does: createWorkspace's first-spawn ownership + anchor row, then startAfterDispatch
// (record the dispatch → start the agent; a failed write starts nothing and removes the workspace). Mutants: scripts/spawn-dispatch-mutants.mjs (`pnpm run test:spawn-dispatch-mutants`).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openBus, type BusDb } from './bus.ts';
import { getRun, refreezeRun, startRun } from './bus-runs.ts';
import { computeAnchorInfo, maybeStartRunAtAnchor, ownerToMark, runAnchorProbe, startRunsForParentless, type BusRunAnchorDeps } from './bus-run-anchor.ts';
import { recordSpawnDispatch, startAfterDispatch, type SpawnDispatchOutcome } from './spawn-dispatch.ts';
import { offlineWaveNodes } from '../cli/index.ts';
import { runIdOf } from '../shared/run-position.ts';
import { DEFAULT_BUS_SWITCHES, type BusSwitches } from '../shared/bus-switches.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(here, '..', '..', 'dist-electron', 'cli.js');
const needsBuild = { skip: fs.existsSync(CLI) ? false : 'dist-electron/cli.js not built — run `pnpm run build:cli`' };

// capability ON: an untokened / stale worker_done is REJECTED (the arms below need the gate live to mean anything)
const LIVE: BusSwitches = { ...DEFAULT_BUS_SWITCHES, delivery: true, wake: true, askGate: true, liveness: true, pause: true, capability: true };

const P = 'dddddddd-0000-4000-8000-000000000001'; // a hand-made top-level agent, NEVER promoted
const C = 'dddddddd-0000-4000-8000-000000000002'; // the agent it spawns
const C2 = 'dddddddd-0000-4000-8000-000000000003'; // its second child
const L = 'dddddddd-0000-4000-8000-000000000011'; // a LEAD (orchestrator kind)
const W = 'dddddddd-0000-4000-8000-000000000012'; // a plain worker of L
const G = 'dddddddd-0000-4000-8000-000000000013'; // the first agent W spawns
const TASK = 'implement the sidebar fix; report when done';

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
  deps: BusRunAnchorDeps;
  bus: { current: BusDb | null };
  events: string[];
  dispatchRowsAtStart: number[];
}
type After = { after: (fn: () => void) => void };

function world(t: After, recs: Array<Omit<Rec, 'name'>>): World {
  const home = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'orch-435-'));
  const db = openBus(path.join(home, 'bus.sqlite'));
  t.after(() => {
    try { db.close(); } catch { /* already closed */ }
    fs.rmSync(home, { recursive: true, force: true });
  });
  const dir = path.join(home, 'userData', 'orchestra');
  fs.mkdirSync(dir, { recursive: true });
  const storeFile = path.join(dir, 'store.json');
  fs.writeFileSync(storeFile, JSON.stringify({ workspaces: recs.map((r) => ({ ...r, name: `ws-${r.id.slice(-2)}` })) }));
  const bus = { current: db as BusDb | null };
  const deps: BusRunAnchorDeps = { getBus: () => bus.current, startRun, getRun, refreezeRun, getLiveSwitches: () => LIVE, warn: () => {} };
  return { home, db, storeFile, deps, bus, events: [], dispatchRowsAtStart: [] };
}

const nodes = (w: World) => offlineWaveNodes(w.storeFile);
const runOf = (w: World, id: string): string => runIdOf(nodes(w).get(id)!, (x) => nodes(w).get(x));
const msgs = (w: World) => w.db.prepare('SELECT run_id, sender, recipient, kind, body FROM messages ORDER BY sequence').all() as Array<{ run_id: string; sender: string; recipient: string | null; kind: string; body: string }>;
const caps = (w: World) => w.db.prepare('SELECT recipient, state, dispatch_seq FROM dispatch_capabilities ORDER BY dispatch_seq').all() as Array<{ recipient: string; state: string; dispatch_seq: number }>;
const storeIds = (w: World): string[] => (JSON.parse(fs.readFileSync(w.storeFile, 'utf8')) as { workspaces: Rec[] }).workspaces.map((r) => r.id);

function birth(w: World): void {
  const n = nodes(w);
  startRunsForParentless(w.deps, [...n.values()], (id) => n.get(id));
}

/** createWorkspace's run part: the first spawn makes the parent an owner (store write), then the child's anchor row is started. */
function createChild(w: World, child: string): void {
  const raw = JSON.parse(fs.readFileSync(w.storeFile, 'utf8')) as { workspaces: Rec[] };
  const n = nodes(w);
  const owner = ownerToMark(n.get(child)!, (id) => n.get(id));
  if (owner) raw.workspaces.find((r) => r.id === owner.id)!.ownsRun = true;
  fs.writeFileSync(w.storeFile, JSON.stringify(raw));
  const n2 = nodes(w);
  maybeStartRunAtAnchor(w.deps, computeAnchorInfo(n2.get(child)!, (id) => n2.get(id), runAnchorProbe(w.deps)));
}

interface SpawnOpts {
  from?: string;
  detached?: boolean;
  remote?: boolean;
  task?: string;
  teardownFails?: boolean;
  /** Runs after createWorkspace's run part, before the dispatch write (a failure injected where the host would meet it). */
  afterCreate?: () => void;
}
/** `dispatchSpawnRequest`'s sequence with the SHIPPED record + ordering function; start/teardown are recorders. */
async function spawn(w: World, child: string, o: SpawnOpts = {}) {
  createChild(w, child);
  o.afterCreate?.();
  const n = nodes(w);
  return startAfterDispatch<string>({
    record: () =>
      recordSpawnDispatch({ getBus: () => w.bus.current, lookup: (id) => nodes(w).get(id) }, { from: o.from, detached: o.detached, remote: o.remote, child: n.get(child)!, task: o.task ?? TASK }),
    start: async () => {
      w.events.push(`start:${child}`);
      w.dispatchRowsAtStart.push(msgs(w).filter((m) => m.kind === 'dispatch').length);
      return 'started';
    },
    teardown: async () => {
      w.events.push(`teardown:${child}`);
      if (o.teardownFails) throw new Error('worktree busy');
      const raw = JSON.parse(fs.readFileSync(w.storeFile, 'utf8')) as { workspaces: Rec[] };
      raw.workspaces = raw.workspaces.filter((r) => r.id !== child);
      fs.writeFileSync(w.storeFile, JSON.stringify(raw));
    },
  });
}

interface Out { code: number; stdout: string; stderr: string }
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
const token = (w: World, ws: string): string => cli(w, ws, ['token']).stdout.trim();
const plainPair = (): Array<Omit<Rec, 'name'>> => [{ id: P, kind: 'worktree' }, { id: C, kind: 'worktree', parentId: P }];

test('#435 a spawn by a never-promoted parent leaves exactly ONE dispatch to the child carrying the task, written BEFORE the agent starts', needsBuild, async (t) => {
  const w = world(t, plainPair());
  birth(w);
  const r = await spawn(w, C, { from: P });
  assert.equal(r.ran, true);
  assert.deepEqual(msgs(w), [{ run_id: P, sender: P, recipient: C, kind: 'dispatch', body: TASK }], 'one dispatch, spawner → child, the task verbatim, in the spawner\'s own run');
  assert.deepEqual(caps(w).map((c) => `${c.recipient}:${c.state}`), [`${C}:active`], 'its capability is minted and active');
  assert.deepEqual(w.dispatchRowsAtStart, [1], 'the dispatch is on the bus at the instant the agent starts (dispatch first, start second)');
  assert.equal(runOf(w, C), P, 'the child is a member of the run the dispatch sits in');
  if (r.ran) assert.equal(r.dispatch.kind, 'recorded');
});

test('#435 the child\'s end-of-work report (worker_done --cap) is ACCEPTED with no step from the parent; with no / a wrong cap it is REJECTED', needsBuild, async (t) => {
  const w = world(t, plainPair());
  birth(w);
  await spawn(w, C, { from: P });
  const bare = cli(w, C, ['send', '--type', 'worker_done', '--to', P, 'done, untokened']);
  assert.equal(bare.code, 1, `the capability gate must be live: ${bare.stdout}`);
  assert.match(bare.stderr, /rejected/);
  assert.equal(cli(w, C, ['send', '--type', 'worker_done', '--to', P, '--cap', 'dcap_forged', 'done, forged']).code, 1);
  assert.equal(msgs(w).filter((m) => m.kind === 'worker_done').length, 0, 'a rejected completion is not recorded');

  const tok = token(w, C); // the child fetches its own token — the parent relays nothing
  assert.match(tok, /^dcap_/, `orchestra token must hand the child its capability: ${tok}`);
  const done = cli(w, C, ['send', '--type', 'worker_done', '--to', P, '--cap', tok, 'sidebar fixed, tests green']);
  assert.equal(done.code, 0, done.stderr + done.stdout);
  const lot = JSON.parse(cli(w, P, ['check']).stdout) as { messages: Array<{ kind: string; sender: string; body: string }> };
  assert.deepEqual(lot.messages.map((m) => `${m.kind}:${m.sender}`), [`worker_done:${C}`], 'the parent receives the report');
});

for (const [name, setup] of [
  ['the bus is not open', (w: World) => { w.bus.current = null; }],
  ['the spawner\'s run has no row', (w: World) => { w.db.prepare('DELETE FROM run_flags WHERE run_id = ?').run(P); w.db.prepare('DELETE FROM runs WHERE id = ?').run(P); }],
  ['the spawner\'s run is closed', (w: World) => { w.db.prepare('UPDATE runs SET closed_at = ? WHERE id = ?').run(Date.now(), P); }],
  ['the capability cannot be minted (injected failure inside the bus)', (w: World) => { w.db.exec("CREATE TRIGGER inject_mint_fail BEFORE INSERT ON dispatch_capabilities BEGIN SELECT RAISE(ABORT, 'injected mint failure'); END"); }],
] as Array<[string, (w: World) => void]>) {
  test(`#435 a bus write that FAILS (${name}) reports it, starts NO agent, removes the workspace and leaves no dispatch row`, needsBuild, async (t) => {
    const w = world(t, plainPair());
    birth(w);
    const r = await spawn(w, C, { from: P, afterCreate: () => setup(w) });
    assert.equal(r.ran, false, 'the spawn is refused');
    assert.match(r.ran ? '' : r.error, /could not record the task as your dispatch/);
    assert.deepEqual(w.events, [`teardown:${C}`], 'the agent never started; the workspace was torn down');
    assert.equal(storeIds(w).includes(C), false, 'no workspace left behind');
    assert.equal((w.db.prepare("SELECT COUNT(*) AS c FROM messages WHERE kind='dispatch'").get() as { c: number }).c, 0, 'no orphan dispatch row (the send + mint are one transaction)');
    assert.equal(caps(w).length, 0);
  });
}

test('#435 a failed write whose teardown ALSO fails still starts nothing and says the workspace was kept', needsBuild, async (t) => {
  const w = world(t, plainPair());
  birth(w);
  w.bus.current = null;
  const r = await spawn(w, C, { from: P, teardownFails: true });
  assert.equal(r.ran, false);
  assert.deepEqual(w.events, [`teardown:${C}`], 'never started');
  assert.equal(r.ran ? '' : r.kept, 'worktree busy');
  assert.match(r.ran ? '' : r.error, /removing the new workspace failed/);
});

test('#435 a later dispatch by the parent SUPERSEDES the spawn\'s (the existing capability rule): the old token is rejected, a re-fetched one accepted, two dispatch rows, one active capability', needsBuild, async (t) => {
  const w = world(t, plainPair());
  birth(w);
  await spawn(w, C, { from: P });
  const old = token(w, C);
  assert.equal(cli(w, P, ['send', '--type', 'dispatch', '--to', C, 'new scope: also the footer']).code, 0);
  assert.deepEqual(msgs(w).map((m) => `${m.kind}:${m.body.slice(0, 9)}`), ['dispatch:implement', 'dispatch:new scope'], 'both are in the log (history), not merged');
  assert.deepEqual(caps(w).map((c) => c.state), ['superseded', 'active'], 'exactly one ACTIVE capability for the child');
  assert.equal(cli(w, C, ['send', '--type', 'worker_done', '--to', P, '--cap', old, 'done']).code, 1, 'the spawn dispatch\'s token no longer completes');
  const fresh = token(w, C);
  assert.equal(cli(w, C, ['send', '--type', 'worker_done', '--to', P, '--cap', fresh, 'done, both parts']).code, 0, 'the re-fetched token does');
});

test('#435 no task, no spawner (a human click) or --detached = NO dispatch; the agent still starts', needsBuild, async (t) => {
  const w = world(t, [...plainPair(), { id: C2, kind: 'worktree' }]);
  birth(w);
  const human = await spawn(w, C, { from: undefined });
  const blank = await spawn(w, C, { from: P, task: '   ' });
  const detached = await spawn(w, C2, { from: P, detached: true });
  const sandbox = await spawn(w, C, { from: P, remote: true });
  for (const r of [human, blank, detached, sandbox]) assert.equal(r.ran, true);
  assert.deepEqual(sandbox.ran && sandbox.dispatch, { kind: 'none', reason: 'sandbox' } as SpawnDispatchOutcome, 'a sandbox child\'s bus is not the host\'s');
  assert.deepEqual(human.ran && human.dispatch, { kind: 'none', reason: 'no-spawner' } as SpawnDispatchOutcome);
  assert.deepEqual(detached.ran && detached.dispatch, { kind: 'none', reason: 'detached' } as SpawnDispatchOutcome);
  assert.deepEqual(blank.ran && blank.dispatch, { kind: 'none', reason: 'empty-task' } as SpawnDispatchOutcome);
  assert.equal(msgs(w).length, 0, 'the bus holds no dispatch');
  assert.equal(w.events.filter((e) => e.startsWith('start:')).length, 4, 'all four agents started');
});

test('#435 a worker\'s FIRST spawn: the dispatch sits in the worker\'s NEW run (not the LEAD\'s) and the grandchild\'s report is accepted; a second child gets its own dispatch + capability', needsBuild, async (t) => {
  const w = world(t, [
    { id: L, kind: 'orchestrator' },
    { id: W, kind: 'worktree', parentId: L },
    { id: G, kind: 'worktree', parentId: W },
    { id: C2, kind: 'worktree', parentId: W },
  ]);
  birth(w);
  await spawn(w, G, { from: W });
  assert.deepEqual(msgs(w).map((m) => `${m.run_id}:${m.sender}>${m.recipient}`), [`${W}:${W}>${G}`], 'filed in W\'s own vague — the ownership flip came first');
  assert.equal(getRun(w.db, W)?.kind, 'vague');
  assert.equal(cli(w, G, ['send', '--type', 'worker_done', '--to', W, '--cap', token(w, G), 'g done']).code, 0);
  await spawn(w, C2, { from: W, task: 'second job' });
  assert.deepEqual(caps(w).map((c) => `${c.recipient}:${c.state}`), [`${G}:active`, `${C2}:active`], 'one active capability per child');
  assert.equal(msgs(w).filter((m) => m.kind === 'dispatch').length, 2);
});

test('#435 a spawner that does NOT own the run its child joins (the first-spawn ownership write failed) is refused, nothing starts: the dispatch would sit where the spawner never reads', needsBuild, async (t) => {
  const w = world(t, [{ id: L, kind: 'orchestrator' }, { id: W, kind: 'worktree', parentId: L }, { id: G, kind: 'worktree', parentId: W }]);
  birth(w);
  const unmark = () => {
    const raw = JSON.parse(fs.readFileSync(w.storeFile, 'utf8')) as { workspaces: Rec[] };
    delete raw.workspaces.find((r) => r.id === W)!.ownsRun;
    fs.writeFileSync(w.storeFile, JSON.stringify(raw));
  };
  const r = await spawn(w, G, { from: W, afterCreate: unmark });
  assert.equal(r.ran, false);
  assert.match(r.ran ? '' : r.error, /different runs/);
  assert.deepEqual(w.events, [`teardown:${G}`]);
  assert.equal(msgs(w).length, 0);
});

test('#435 a spawner missing from the store is refused, nothing starts', needsBuild, async (t) => {
  const w = world(t, [{ id: C, kind: 'worktree', parentId: 'ghost-spawner' }]);
  const r = await spawn(w, C, { from: 'ghost-spawner' });
  assert.equal(r.ran, false);
  assert.match(r.ran ? '' : r.error, /not in the store/);
  assert.deepEqual(w.events, [`teardown:${C}`]);
});

// ── wiring pins: the host seam the composed arms above stand in for (workspaces.ts cannot load under node --test) ──
const src = (rel: string): string => fs.readFileSync(path.resolve(here, '..', '..', rel), 'utf8');

test('#435 wiring: dispatchSpawnRequest records the dispatch BEFORE the agent start, tears the workspace down on a failed write, and the CLI says so', () => {
  const ws = src('src/main/workspaces.ts');
  const i = ws.indexOf('const after = await startAfterDispatch({');
  assert.ok(i > 0, 'dispatchSpawnRequest goes through startAfterDispatch');
  const block = ws.slice(i, ws.indexOf('if (!after.ran)', i));
  assert.match(block, /record: \(\) => recordSpawnDispatch\(\{ getBus, lookup: \(id\) => store\.getWorkspace\(id\) \}, \{ from: input\.from, detached: input\.detached,/, 'real bus + live store lookup, the spawner, the detach flag');
  assert.match(block, /start: \(\) => startWorkspaceAgentHeadless\(ws\.id,/, 'the agent starts only through the seam');
  assert.match(block, /teardown: \(\) => deleteWorkspace\(ws\.id\)/, 'a failed write removes the workspace');
  assert.equal((ws.match(/startWorkspaceAgentHeadless\(ws\.id, input\.origin/g) ?? []).length, 1, 'no second, unguarded start in the spawn path');
  assert.match(ws, /if \(!after\.ran\) return \{ ok: false, error: `refusing to spawn: \$\{after\.error\}`/, 'a refused write is a refused spawn');
  const cliSrc = src('src/cli/index.ts');
  assert.match(cliSrc, /Task recorded as your dispatch #\$\{dispatched\.seq\} to \$\{res\.id\}/, 'the CLI prints the recorded dispatch');
});
