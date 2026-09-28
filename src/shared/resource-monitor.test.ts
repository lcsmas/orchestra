import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ProcSample } from './resources.ts';
import {
  buildResourceLogLine,
  decideReap,
  decideThresholdWarnings,
  shouldRotate,
  summarizeSessionTree,
  MAX_FILE_BYTES,
  SESSION_RSS_WARN_BYTES,
  SESSION_CPU_WARN_PCT,
  ELECTRON_RSS_WARN_BYTES,
  ELECTRON_CPU_WARN_PCT,
  type KeeperRoot,
  type ResourceLogElectronProc,
} from './resource-monitor.ts';

const proc = (
  pid: number,
  ppid: number,
  over: Partial<ProcSample> = {},
): ProcSample => ({
  pid,
  ppid,
  comm: `p${pid}`,
  cpuTicks: 0,
  memBytes: 0,
  cpuPct: null,
  ...over,
});

/** A keeper tree: keeper(kpid) → cli → mcp, all under one workspace. */
function keeperTree(kpid: number, rss: number): ProcSample[] {
  return [
    proc(kpid, 1, { comm: 'keeper.js', memBytes: rss }),
    proc(kpid + 1, kpid, { comm: 'claude', memBytes: rss }),
    proc(kpid + 2, kpid + 1, { comm: 'chrome-devtools-mcp', memBytes: rss }),
  ];
}

// ─── decideReap: the destructive detector (a) ────────────────────────────────

test('decideReap KILLS a tree whose workspace is absent from the store (must-FAIL arm)', () => {
  // ws "gone" was deleted; its keeper tree is still alive. This is exactly the
  // 1.6 GB leak LEAD measured. The reaper MUST target it.
  const roots: KeeperRoot[] = [{ workspaceId: 'gone', keeperPid: 100 }];
  const table = keeperTree(100, 700 * 1024 * 1024);
  const decision = decideReap(roots, table, new Set<string>(), /*storeLoaded*/ true);
  assert.equal(decision.refusedStoreNotLoaded, false);
  assert.equal(decision.targets.length, 1);
  const t = decision.targets[0];
  assert.equal(t.workspaceId, 'gone');
  assert.equal(t.keeperPid, 100);
  // Exactly the three tree members, and ONLY them.
  assert.deepEqual([...t.pids].sort((a, b) => a - b), [100, 101, 102]);
  // Leaf-first: the keeper root is killed LAST.
  assert.equal(t.pids[t.pids.length - 1], 100);
});

test('decideReap NEVER reaps a live workspace tree (must-PASS arm)', () => {
  const roots: KeeperRoot[] = [{ workspaceId: 'alive', keeperPid: 200 }];
  const table = keeperTree(200, 700 * 1024 * 1024);
  const decision = decideReap(roots, table, new Set(['alive']), true);
  assert.deepEqual(decision.targets, []);
});

test('decideReap REFUSES entirely when the store is not loaded from disk', () => {
  // Absence-from-store is only proof-of-deletion once store.json actually
  // parsed. An unloaded store looks empty — reaping then kills the whole fleet.
  const roots: KeeperRoot[] = [{ workspaceId: 'gone', keeperPid: 100 }];
  const table = keeperTree(100, 700 * 1024 * 1024);
  const decision = decideReap(roots, table, new Set<string>(), /*storeLoaded*/ false);
  assert.deepEqual(decision.targets, []);
  assert.equal(decision.refusedStoreNotLoaded, true);
});

test('decideReap skips an orphan whose keeper pid is already gone (nothing to kill)', () => {
  const roots: KeeperRoot[] = [{ workspaceId: 'gone', keeperPid: 100 }];
  // The keeper pid is NOT in the table — collectTree returns [].
  const table = [proc(1, 0), proc(2, 1)];
  const decision = decideReap(roots, table, new Set<string>(), true);
  assert.deepEqual(decision.targets, []);
});

test('decideReap only touches descendants of the keeper root, never siblings', () => {
  const roots: KeeperRoot[] = [{ workspaceId: 'gone', keeperPid: 100 }];
  const table = [
    ...keeperTree(100, 1),
    proc(500, 1, { comm: 'electron' }), // unrelated Electron process
    proc(501, 500, { comm: 'renderer' }),
  ];
  const decision = decideReap(roots, table, new Set<string>(), true);
  assert.equal(decision.targets.length, 1);
  assert.ok(!decision.targets[0].pids.includes(500));
  assert.ok(!decision.targets[0].pids.includes(501));
});

// ─── summarizeSessionTree + buildResourceLogLine: the JSONL line shape ────────

test('summarizeSessionTree rolls the keeper tree up with present/status/reaped', () => {
  const table = keeperTree(300, 100);
  const cpuPcts = new Map([
    [300, 5],
    [301, 40],
    [302, 10],
  ]);
  const s = summarizeSessionTree(
    { workspaceId: 'ws-a', keeperPid: 300 },
    table,
    cpuPcts,
    new Set(['ws-a']),
    'running',
    false,
  );
  assert.equal(s.workspaceId, 'ws-a');
  assert.equal(s.keeperPid, 300);
  assert.equal(s.procCount, 3);
  assert.equal(s.rssBytes, 300);
  assert.equal(s.cpuPct, 55);
  assert.equal(s.present, true);
  assert.equal(s.status, 'running');
  assert.equal(s.reaped, false);
});

test('buildResourceLogLine assembles totals, electron and per-session rows', () => {
  const table = keeperTree(400, 50);
  const electron: ResourceLogElectronProc[] = [
    { type: 'Browser', pid: 10, cpuPct: 3, rssBytes: 111 },
  ];
  const line = buildResourceLogLine(
    {
      at: 1_700_000_000_000,
      cpuCores: 8,
      memTotalBytes: 32 * 1024 * 1024 * 1024,
      memUsedBytes: 18 * 1024 * 1024 * 1024,
      table,
      cpuPcts: new Map([[400, 1], [401, 2], [402, 3]]),
      keeperRoots: [{ workspaceId: 'ws-b', keeperPid: 400 }],
      liveWorkspaceIds: new Set<string>(), // absent → present:false, reaped
      electron,
      reapedWorkspaceIds: new Set(['ws-b']),
    },
    () => null,
  );
  assert.equal(line.at, 1_700_000_000_000);
  assert.equal(line.t, new Date(1_700_000_000_000).toISOString());
  assert.equal(line.totals.cpuCores, 8);
  assert.equal(line.totals.memUsedBytes, 18 * 1024 * 1024 * 1024);
  assert.deepEqual(line.electron, electron);
  assert.equal(line.sessions.length, 1);
  assert.equal(line.sessions[0].present, false);
  assert.equal(line.sessions[0].reaped, true);
  assert.equal(line.sessions[0].status, null);
  assert.equal(line.sessions[0].cpuPct, 6);
  // The line round-trips through JSON (it is what gets appended).
  assert.deepEqual(JSON.parse(JSON.stringify(line)), line);
});

// ─── decideThresholdWarnings: advisory detector (b) ──────────────────────────

test('decideThresholdWarnings flags an over-RSS session and an over-CPU electron proc', () => {
  const sessions = [
    {
      workspaceId: 'hog',
      keeperPid: 5,
      cpuPct: 10,
      rssBytes: SESSION_RSS_WARN_BYTES + 1,
      procCount: 3,
      present: true,
      status: 'running',
      reaped: false,
    },
  ];
  const electron: ResourceLogElectronProc[] = [
    { type: 'Tab', pid: 7, cpuPct: ELECTRON_CPU_WARN_PCT + 1, rssBytes: 1 },
  ];
  const warnings = decideThresholdWarnings(sessions, electron);
  const kinds = warnings.map((w) => w.kind).sort();
  assert.deepEqual(kinds, ['electron-cpu', 'session-rss']);
});

test('decideThresholdWarnings never warns about a reaped tree (its RSS is stale)', () => {
  const sessions = [
    {
      workspaceId: 'gone',
      keeperPid: 5,
      cpuPct: SESSION_CPU_WARN_PCT + 100,
      rssBytes: SESSION_RSS_WARN_BYTES * 2,
      procCount: 3,
      present: false,
      status: null,
      reaped: true,
    },
  ];
  assert.deepEqual(decideThresholdWarnings(sessions, []), []);
});

test('decideThresholdWarnings stays quiet under threshold', () => {
  const sessions = [
    {
      workspaceId: 'ok',
      keeperPid: 5,
      cpuPct: SESSION_CPU_WARN_PCT - 1,
      rssBytes: SESSION_RSS_WARN_BYTES - 1,
      procCount: 3,
      present: true,
      status: 'idle',
      reaped: false,
    },
  ];
  const electron: ResourceLogElectronProc[] = [
    { type: 'GPU', pid: 9, cpuPct: ELECTRON_CPU_WARN_PCT - 1, rssBytes: ELECTRON_RSS_WARN_BYTES - 1 },
  ];
  assert.deepEqual(decideThresholdWarnings(sessions, electron), []);
});

// ─── shouldRotate: bounded log ───────────────────────────────────────────────

test('shouldRotate fires at the size cap, not below', () => {
  assert.equal(shouldRotate(MAX_FILE_BYTES - 1), false);
  assert.equal(shouldRotate(MAX_FILE_BYTES), true);
  assert.equal(shouldRotate(MAX_FILE_BYTES + 1), true);
});
