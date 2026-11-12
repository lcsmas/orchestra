// #433 — every top-level workspace has its mission from birth. Drives the REAL run-start code
// (computeAnchorInfo / maybeStartRunAtAnchor / startRunsForParentless over a real SQLite bus, nodes read by the
// CLI's own store reader from a real store.json) and the BUILT CLI (`send`, `bus-status`, `run hold`) — never an
// internal helper's return. Mutants: scripts/top-level-run-mutants.mjs (`pnpm run test:top-level-run-mutants`).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openBus, type BusDb } from './bus.ts';
import { startRun, getRun, refreezeRun, runFlags, busStatusRunView } from './bus-runs.ts';
import {
  computeAnchorInfo,
  maybeStartRunAtAnchor,
  startRunsForParentless,
  type BusRunAnchorDeps,
} from './bus-run-anchor.ts';
import { offlineWaveNodes } from '../cli/index.ts';
import { DEFAULT_BUS_SWITCHES, serializeSwitches, type BusSwitches } from '../shared/bus-switches.ts';
import type { WaveNode } from './wave-run-id.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(here, '..', '..', 'dist-electron', 'cli.js');
const needsBuild = { skip: fs.existsSync(CLI) ? false : 'dist-electron/cli.js not built — run `pnpm run build:cli`' };

const LIVE: BusSwitches = { ...DEFAULT_BUS_SWITCHES, delivery: true, wake: true, askGate: true, liveness: true, pause: true };

const LEAD = 'aaaaaaaa-0000-4000-8000-000000000001';
const OPS = 'aaaaaaaa-0000-4000-8000-000000000002';
const WORKER = 'aaaaaaaa-0000-4000-8000-000000000003';
const T1 = 'aaaaaaaa-0000-4000-8000-000000000011'; // top-level plain worktree
const T2 = 'aaaaaaaa-0000-4000-8000-000000000012'; // top-level scratch
const KID = 'aaaaaaaa-0000-4000-8000-000000000013'; // plain child of T1
const ORPHAN = 'aaaaaaaa-0000-4000-8000-000000000014'; // parent deleted
const ARCHIVED = 'aaaaaaaa-0000-4000-8000-000000000015';

interface World {
  home: string;
  db: BusDb;
  warns: string[];
  deps: BusRunAnchorDeps;
  storeFile: string;
}

function world(t: { after: (fn: () => void) => void }): World {
  const home = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'orch-433-'));
  const db = openBus(path.join(home, 'bus.sqlite'));
  t.after(() => {
    db.close();
    fs.rmSync(home, { recursive: true, force: true });
  });
  const dir = path.join(home, 'userData', 'orchestra');
  fs.mkdirSync(dir, { recursive: true });
  const storeFile = path.join(dir, 'store.json');
  const rec = (id: string, extra: Record<string, unknown> = {}) => ({ id, name: `ws-${id.slice(-2)}`, kind: 'worktree', ...extra });
  fs.writeFileSync(
    storeFile,
    JSON.stringify({
      workspaces: [
        rec(LEAD, { kind: 'orchestrator' }),
        rec(OPS, { parentId: LEAD, canOrchestrate: true }),
        rec(WORKER, { parentId: OPS }),
        rec(T1),
        rec(T2, { kind: 'scratch' }),
        rec(KID, { parentId: T1 }),
        rec(ORPHAN, { parentId: 'deleted-parent' }),
        rec(ARCHIVED, { archived: true }),
      ],
    }),
  );
  const warns: string[] = [];
  const deps: BusRunAnchorDeps = {
    getBus: () => db,
    startRun,
    getRun,
    refreezeRun,
    getLiveSwitches: () => LIVE,
    warn: (m) => warns.push(m),
  };
  return { home, db, warns, deps, storeFile };
}

/** What the app's boot does: archived are filtered out, the rest go through the sweep. */
function sweep(w: World): string[] {
  const archived = new Set(
    (JSON.parse(fs.readFileSync(w.storeFile, 'utf8')).workspaces as { id: string; archived?: boolean }[]).filter((r) => r.archived).map((r) => r.id),
  );
  const nodes = offlineWaveNodes(w.storeFile);
  const live = [...nodes.values()].filter((n) => !archived.has(n.id));
  return startRunsForParentless(w.deps, live, (id) => nodes.get(id));
}

interface Out {
  code: number;
  stdout: string;
  stderr: string;
}
function cliEnv(w: World, ws: string | null, run: string | null): Record<string, string> {
  const env: Record<string, string> = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: w.home, ORCHESTRA_HOME: w.home, ORCHESTRA_SOCK: path.join(w.home, 'dead.sock') };
  if (ws) env.ORCHESTRA_WS_ID = ws;
  if (run) env.ORCHESTRA_RUN_ID = run;
  return env;
}
function cli(w: World, ws: string | null, run: string | null, args: string[]): Out {
  try {
    const stdout = execFileSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: cliEnv(w, ws, run), stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 });
    return { code: 0, stdout, stderr: '' };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? -1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}
const rows = (w: World): number => (w.db.prepare('SELECT COUNT(*) AS c FROM messages').get() as { c: number }).c;
const runIds = (w: World): string[] => (w.db.prepare('SELECT id FROM runs ORDER BY id').all() as { id: string }[]).map((r) => r.id);

test('#433 app start: every live top-level workspace without a run gets its mission; nothing else changes', needsBuild, (t) => {
  const w = world(t);
  const storeBefore = fs.readFileSync(w.storeFile);
  // Failing control (the unfixed state): a lone top-level agent cannot send — its run has no row.
  const before = cli(w, T1, T1, ['send', '--type', 'status', 'hi']);
  assert.equal(before.code, 1, `run-less top-level must be refused before the sweep: ${before.stdout}`);
  assert.match(before.stderr, /has no row in the bus 'runs' table/);
  assert.equal(rows(w), 0);

  const started = sweep(w).sort();
  assert.deepEqual(started, [LEAD, ORPHAN, T1, T2].sort(), 'parentless live workspaces only (a dangling parent counts; archived, children and the OPS do not)');
  assert.deepEqual(runIds(w), [LEAD, ORPHAN, T1, T2].sort());
  for (const id of [T1, T2, ORPHAN, LEAD]) {
    const row = getRun(w.db, id)!;
    assert.equal(row.kind, 'mission', id);
    assert.equal(row.coordinator, id);
    assert.deepEqual(runFlags(w.db, id), LIVE, `${id}: the live switches are frozen on the row`);
  }
  for (const id of [KID, OPS, WORKER, ARCHIVED]) assert.equal(getRun(w.db, id), null, `${id} gets no row from the sweep`);
  assert.ok(storeBefore.equals(fs.readFileSync(w.storeFile)), 'the sweep never touches the workspace store (no session is restarted)');

  // The SAME baked env as before (a session that started before the update) now reaches the bus.
  const after = cli(w, T1, T1, ['send', '--type', 'status', 'hi']);
  assert.equal(after.code, 0, after.stderr);
  assert.equal(rows(w), 1);
  assert.deepEqual(w.warns, []);
});

test('#433 the sweep is idempotent and never re-freezes a run that already exists', needsBuild, (t) => {
  const w = world(t);
  startRun(w.db, { id: T1, kind: 'mission', coordinator: T1 }, { ...DEFAULT_BUS_SWITCHES, wake: false });
  assert.deepEqual(sweep(w).sort(), [LEAD, ORPHAN, T2].sort());
  assert.equal(runFlags(w.db, T1).wake, false, 'T1 keeps what it froze');
  assert.deepEqual(sweep(w), [], 'a second start finds nothing to do');
});

test('#433 a new top-level workspace has its run + frozen switches BEFORE its first turn; a plain child has none yet', needsBuild, (t) => {
  const w = world(t);
  const nodes = offlineWaveNodes(w.storeFile);
  const lookup = (id: string): WaveNode | undefined => nodes.get(id);
  // creation = computeAnchorInfo + maybeStartRunAtAnchor (what startBusRunAndWriteNotice runs); no session exists yet.
  const row = maybeStartRunAtAnchor(w.deps, computeAnchorInfo(nodes.get(T2)!, lookup));
  assert.equal(row?.id, T2);
  assert.deepEqual(runFlags(w.db, T2), LIVE);
  const first = cli(w, T2, T2, ['send', '--type', 'status', 'first turn']);
  assert.equal(first.code, 0, first.stderr);
  // A plain child of a plain parent still has no run of its own (#434): nothing started for it.
  assert.equal(maybeStartRunAtAnchor(w.deps, computeAnchorInfo(nodes.get(KID)!, lookup)), null);
  assert.equal(getRun(w.db, KID), null);
});

test('#433 no verb falls back to a run id without a row: no env + no --run is refused, `default` is just an unknown run', needsBuild, (t) => {
  const w = world(t);
  sweep(w);
  const noRun = cli(w, T1, null, ['send', '--type', 'status', 'x']);
  assert.equal(noRun.code, 1);
  assert.match(noRun.stderr, /no run to act on/);
  const dflt = cli(w, T1, null, ['send', '--type', 'status', '--run', 'default', 'x']);
  assert.equal(dflt.code, 1);
  assert.match(dflt.stderr, /has no row in the bus 'runs' table/);
  assert.equal(rows(w), 0, 'nothing written under a made-up run');
  // The admin verbs refuse the same way (run hold names no run → no fallback target).
  const hold = cli(w, T1, null, ['run', 'hold']);
  assert.equal(hold.code, 1);
  assert.match(hold.stderr, /no run to act on/);
  const st = cli(w, T1, null, ['bus-status']);
  assert.equal(st.code, 1);
  assert.match(st.stderr, /no run to act on/);
  assert.equal(getRun(w.db, 'default'), null, 'no `default` run is ever created');
});

/** `orchestra bus-status` against a stub app socket whose `/busStatus` reply is built by the REAL `busStatusRunView` over the real bus. */
function busStatus(w: World, ws: string, run: string): Promise<Out> {
  const sock = path.join(fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'orch-433-s-')), 's.sock');
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
      const env = { ...cliEnv(w, ws, run), ORCHESTRA_SOCK: sock };
      execFile(process.execPath, [CLI, 'bus-status'], { env, timeout: 30_000 }, (err, stdout, stderr) => {
        server.close();
        resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, stdout, stderr });
      });
    });
  });
}

test('#433 `orchestra bus-status` on a lone workspace shows its run with the frozen switches — never "standalone"', needsBuild, async (t) => {
  const w = world(t);
  sweep(w);
  const r = await busStatus(w, T1, T1);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, new RegExp(`^run: ${T1}\\n`, 'm'));
  assert.doesNotMatch(r.stdout, /no such run|standalone/);
  assert.match(r.stdout, /delivery\s+ON\s+ON/, 'frozen ON beside live ON');
  // Control: the same lone workspace BEFORE the sweep prints no such run, with no frozen column.
  const w2 = world(t);
  const r2 = await busStatus(w2, T1, T1);
  assert.match(r2.stdout, /no such run/);
});
