import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ProcSample } from './resources.ts';
import {
  buildResourceLogLine,
  classifySurvivors,
  bootFallbackKills,
  decideDuplicateReap,
  decideReap,
  decideThresholdWarnings,
  firstSampleAt,
  isKeeperCmdline,
  isSameLiveProcess,
  parseKeeperArgv,
  shouldDropBackup,
  shouldRotate,
  summarizeSessionTree,
  verifyReapIdentity,
  MAX_FILE_BYTES,
  RETENTION_MS,
  ROTATE_AFTER_MS,
  SESSION_RSS_WARN_BYTES,
  SESSION_CPU_WARN_PCT,
  ELECTRON_RSS_WARN_BYTES,
  ELECTRON_CPU_WARN_PCT,
  type KeeperProc,
  type KeeperRoot,
  type ReapTarget,
  type ResourceLogElectronProc,
} from './resource-monitor.ts';

/** startTicks defaults to 1000+pid: a pid's identity = (pid, startTicks). */
const proc = (pid: number, ppid: number, over: Partial<ProcSample> = {}): ProcSample => ({
  pid,
  ppid,
  comm: `p${pid}`,
  cpuTicks: 0,
  memBytes: 0,
  cpuPct: null,
  startTicks: 1000 + pid,
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

const argvFor = (ws: string) => ['/opt/Orchestra/orchestra', '/home/u/.orchestra/bin/keeper.js', ws, 's', 'p', 'l'];

/** Classify the orphan "gone" tree rooted at 100 and return its ReapTarget. */
function target100(): ReapTarget {
  const d = decideReap([{ workspaceId: 'gone', keeperPid: 100 }], keeperTree(100, 1), new Set<string>(), true);
  return d.targets[0];
}
/** Fresh /proc reads for the target's members, optionally overridden per pid. */
function freshOf(t: ReapTarget, over: Record<number, ProcSample | null> = {}): Map<number, ProcSample | null> {
  const m = new Map<number, ProcSample | null>();
  for (const x of t.members) m.set(x.pid, proc(x.pid, x.ppid));
  for (const [k, v] of Object.entries(over)) m.set(Number(k), v);
  return m;
}

// ─── decideReap: classification (detector a) ─────────────────────────────────

test('decideReap CLASSIFIES a tree whose workspace is absent from the store (must-FAIL arm)', () => {
  const roots: KeeperRoot[] = [{ workspaceId: 'gone', keeperPid: 100 }];
  const decision = decideReap(roots, keeperTree(100, 700 * 1024 * 1024), new Set<string>(), true);
  assert.equal(decision.refusedStoreNotLoaded, false);
  assert.equal(decision.targets.length, 1);
  const t = decision.targets[0];
  assert.equal(t.workspaceId, 'gone');
  assert.equal(t.keeperPid, 100);
  assert.deepEqual([...t.pids].sort((a, b) => a - b), [100, 101, 102]);
  assert.equal(t.pids[t.pids.length - 1], 100); // leaf-first: keeper LAST
  // Identity captured AT classification: (pid, ppid, startTicks) literals.
  assert.deepEqual(
    t.members.map((m) => [m.pid, m.ppid, m.startTicks]),
    [[100, 1, 1100], [101, 100, 1101], [102, 101, 1102]],
  );
});

test('decideReap NEVER classifies a live workspace tree (must-PASS arm)', () => {
  const decision = decideReap(
    [{ workspaceId: 'alive', keeperPid: 200 }],
    keeperTree(200, 1),
    new Set(['alive']),
    true,
  );
  assert.deepEqual(decision.targets, []);
});

test('decideReap REFUSES entirely when the store is not loaded from disk', () => {
  const decision = decideReap(
    [{ workspaceId: 'gone', keeperPid: 100 }],
    keeperTree(100, 1),
    new Set<string>(),
    false,
  );
  assert.deepEqual(decision.targets, []);
  assert.equal(decision.refusedStoreNotLoaded, true);
});

test('decideReap skips an orphan whose keeper pid is already gone (nothing to kill)', () => {
  const decision = decideReap(
    [{ workspaceId: 'gone', keeperPid: 100 }],
    [proc(1, 0), proc(2, 1)],
    new Set<string>(),
    true,
  );
  assert.deepEqual(decision.targets, []);
  assert.deepEqual(decision.refused, []);
});

test('decideReap only classifies descendants of the keeper root, never siblings', () => {
  const table = [...keeperTree(100, 1), proc(500, 1, { comm: 'electron' }), proc(501, 500, { comm: 'renderer' })];
  const decision = decideReap([{ workspaceId: 'gone', keeperPid: 100 }], table, new Set<string>(), true);
  assert.equal(decision.targets.length, 1);
  assert.ok(!decision.targets[0].pids.includes(500));
  assert.ok(!decision.targets[0].pids.includes(501));
});

test('decideReap REFUSES an orphan whose members carry no start-time (non-Linux ps fallback)', () => {
  const table = keeperTree(100, 1).map((p) => ({ ...p, startTicks: undefined }));
  const decision = decideReap([{ workspaceId: 'gone', keeperPid: 100 }], table, new Set<string>(), true);
  assert.deepEqual(decision.targets, []);
  assert.equal(decision.refused.length, 1);
  assert.equal(decision.refused[0].workspaceId, 'gone');
  assert.match(decision.refused[0].reason, /identity-unverifiable/);
});

// ─── isKeeperCmdline: the clock-free root anchor ─────────────────────────────

test('isKeeperCmdline accepts a real keeper argv and rejects look-alikes', () => {
  assert.equal(isKeeperCmdline(argvFor('ws-1'), 'ws-1'), true);
  assert.equal(isKeeperCmdline(['node', 'keeper.js', 'ws-1'], 'ws-1'), true);
  assert.equal(isKeeperCmdline(null, 'ws-1'), false);
  assert.equal(isKeeperCmdline([], 'ws-1'), false);
  assert.equal(isKeeperCmdline(['/usr/bin/chromium', '--type=renderer'], 'ws-1'), false);
  assert.equal(isKeeperCmdline(argvFor('ws-2'), 'ws-1'), false); // another workspace's keeper
  assert.equal(isKeeperCmdline(argvFor('ws-10'), 'ws-1'), false); // prefix is not equality
  assert.equal(isKeeperCmdline(['node', '/x/notkeeper.js', 'ws-1'], 'ws-1'), false); // basename must be exact
  assert.equal(isKeeperCmdline(['node', 'keeper.js', 'x', 'ws-1'], 'ws-1'), false); // wsId must FOLLOW keeper.js
  assert.equal(isKeeperCmdline(['ws-1', 'node', 'keeper.js'], 'ws-1'), false);
});

// ─── verifyReapIdentity: kill-time identity (review F1) ──────────────────────

test('verifyReapIdentity: an intact tree is fully signalable, leaf-first, keeper last', () => {
  const t = target100();
  const v = verifyReapIdentity(t, freshOf(t), argvFor('gone'));
  assert.equal(v.treeRefusal, null);
  assert.deepEqual(v.withheld, []);
  assert.deepEqual(v.signalable.map((m) => m.pid), [102, 101, 100]);
});

test('verifyReapIdentity: a member pid REUSED by an unrelated process is withheld (start-time clause)', () => {
  const t = target100();
  // 101 now belongs to a different process: same pid, later start-time.
  const v = verifyReapIdentity(t, freshOf(t, { 101: proc(101, 100, { startTicks: 9_999_999 }) }), argvFor('gone'));
  assert.equal(v.treeRefusal, null);
  assert.deepEqual(v.withheld.map((w) => [w.pid, w.reason]), [
    [101, 'start-time-changed (pid reused)'],
    [102, 'parent-withheld'], // its child hangs off a withheld parent → chain broken
  ]);
  assert.deepEqual(v.signalable.map((m) => m.pid), [100]); // only the keeper itself
});

test('verifyReapIdentity: a keeper pid REUSED (start-time changed) refuses the WHOLE tree', () => {
  const t = target100();
  const v = verifyReapIdentity(t, freshOf(t, { 100: proc(100, 1, { startTicks: 9_999_999 }) }), argvFor('gone'));
  assert.match(v.treeRefusal ?? '', /keeper-start-time-changed/);
  assert.deepEqual(v.signalable, []);
});

test('verifyReapIdentity: a recycled ROOT running an unrelated program refuses the tree (cmdline clause)', () => {
  // The reviewer's F1 scenario: stale <wsId>.pid → pid now an unrelated process with its own children.
  const t = target100();
  const v = verifyReapIdentity(t, freshOf(t), ['/usr/bin/some-daemon', '--serve']);
  assert.match(v.treeRefusal ?? '', /keeper-cmdline-mismatch/);
  assert.deepEqual(v.signalable, []);
  // …and another workspace's keeper is not THIS workspace's keeper.
  const other = verifyReapIdentity(t, freshOf(t), argvFor('someone-else'));
  assert.match(other.treeRefusal ?? '', /keeper-cmdline-mismatch/);
  // …and an unreadable cmdline (process vanished) is not proof.
  assert.match(verifyReapIdentity(t, freshOf(t), null).treeRefusal ?? '', /keeper-cmdline-mismatch/);
});

test('verifyReapIdentity: a vanished keeper refuses the tree (nothing to anchor on)', () => {
  const t = target100();
  const v = verifyReapIdentity(t, freshOf(t, { 100: null }), argvFor('gone'));
  assert.equal(v.treeRefusal, 'keeper-gone');
});

test('verifyReapIdentity: a member that moved out of the tree (ppid changed) is withheld; a gone member is skipped', () => {
  const t = target100();
  const v = verifyReapIdentity(t, freshOf(t, { 101: proc(101, 1) /* reparented */, 102: null /* gone */ }), argvFor('gone'));
  assert.deepEqual(v.withheld.map((w) => [w.pid, w.reason]), [
    [101, 'reparented'],
    [102, 'gone'],
  ]);
  assert.deepEqual(v.signalable.map((m) => m.pid), [100]);
});

// ─── classifySurvivors: the SIGKILL phase after the grace ────────────────────

test('classifySurvivors SIGKILLs only members still the SAME process; a reused pid is left alone', () => {
  const t = target100();
  const fresh = new Map<number, ProcSample | null>([
    [100, proc(100, 1)], // still the same keeper → kill
    [101, null], // exited within grace
    [102, proc(102, 55, { startTicks: 424242 })], // pid reused during the grace → NEVER kill
  ]);
  const s = classifySurvivors(t.members, fresh);
  assert.deepEqual(s.kill.map((m) => m.pid), [100]);
  assert.deepEqual(s.gone, [101]);
  assert.deepEqual(s.reused, [102]);
});

// ─── summarizeSessionTree + buildResourceLogLine: the JSONL line shape ────────

test('summarizeSessionTree rolls the keeper tree up with present/status/reaped', () => {
  const s = summarizeSessionTree(
    { workspaceId: 'ws-a', keeperPid: 300 },
    keeperTree(300, 100),
    new Map([[300, 5], [301, 40], [302, 10]]),
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
  const electron: ResourceLogElectronProc[] = [{ type: 'Browser', pid: 10, cpuPct: 3, rssBytes: 111 }];
  const line = buildResourceLogLine(
    {
      at: 1_700_000_000_000,
      cpuCores: 8,
      memTotalBytes: 32 * 1024 * 1024 * 1024,
      memUsedBytes: 18 * 1024 * 1024 * 1024,
      table: keeperTree(400, 50),
      cpuPcts: new Map([[400, 1], [401, 2], [402, 3]]),
      keeperRoots: [{ workspaceId: 'ws-b', keeperPid: 400 }],
      liveWorkspaceIds: new Set<string>(),
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
  assert.deepEqual(JSON.parse(JSON.stringify(line)), line);
});

// ─── decideThresholdWarnings: advisory detector (b) ──────────────────────────

const session = (over: Partial<Parameters<typeof decideThresholdWarnings>[0][number]> = {}) => ({
  workspaceId: 'ws',
  keeperPid: 5,
  cpuPct: 10,
  rssBytes: 1,
  procCount: 3,
  present: true,
  status: 'running' as string | null,
  reaped: false,
  ...over,
});

test('decideThresholdWarnings flags an over-RSS session and an over-CPU electron proc', () => {
  const warnings = decideThresholdWarnings(
    [session({ workspaceId: 'hog', rssBytes: SESSION_RSS_WARN_BYTES + 1 })],
    [{ type: 'Tab', pid: 7, cpuPct: ELECTRON_CPU_WARN_PCT + 1, rssBytes: 1 }],
  );
  assert.deepEqual(warnings.map((w) => w.kind).sort(), ['electron-cpu', 'session-rss']);
});

test('decideThresholdWarnings never warns about a reaped tree (its RSS is stale)', () => {
  const s = session({
    cpuPct: SESSION_CPU_WARN_PCT + 100,
    rssBytes: SESSION_RSS_WARN_BYTES * 2,
    present: false,
    status: null,
    reaped: true,
  });
  assert.deepEqual(decideThresholdWarnings([s], []), []);
});

test('decideThresholdWarnings stays quiet under threshold', () => {
  const s = session({ cpuPct: SESSION_CPU_WARN_PCT - 1, rssBytes: SESSION_RSS_WARN_BYTES - 1 });
  const e: ResourceLogElectronProc[] = [
    { type: 'GPU', pid: 9, cpuPct: ELECTRON_CPU_WARN_PCT - 1, rssBytes: ELECTRON_RSS_WARN_BYTES - 1 },
  ];
  assert.deepEqual(decideThresholdWarnings([s], e), []);
});

// ─── bounded log: ≤7 days / ≤50 MB (review F4) ───────────────────────────────

const DAY = 24 * 60 * 60 * 1000;

test('the bound constants keep active + .1 within 50 MB and 7 days (literals, not derived)', () => {
  assert.equal(MAX_FILE_BYTES, 25 * 1024 * 1024);
  assert.equal(RETENTION_MS, 7 * DAY);
  assert.equal(ROTATE_AFTER_MS, 3.5 * DAY);
  assert.ok(2 * MAX_FILE_BYTES <= 50 * 1024 * 1024);
  assert.ok(2 * ROTATE_AFTER_MS <= 7 * DAY);
});

test('shouldRotate: size cap, age cap, unknown age; an empty file never rotates', () => {
  const t0 = 1_700_000_000_000;
  assert.equal(shouldRotate(MAX_FILE_BYTES - 1, t0, t0 + DAY), false);
  assert.equal(shouldRotate(MAX_FILE_BYTES, t0, t0 + DAY), true); // size arm
  assert.equal(shouldRotate(1024, t0, t0 + 3.5 * DAY - 1), false);
  assert.equal(shouldRotate(1024, t0, t0 + 3.5 * DAY), true); // age arm — a low-traffic file
  assert.equal(shouldRotate(1024, null, t0), true); // unknown age = expired
  assert.equal(shouldRotate(0, null, t0), false); // nothing to rotate
});

test('shouldDropBackup: drops once the OLDEST sample passes 7 days; unknown age drops', () => {
  const t0 = 1_700_000_000_000;
  assert.equal(shouldDropBackup(t0, t0 + 7 * DAY), false);
  assert.equal(shouldDropBackup(t0, t0 + 7 * DAY + 1), true);
  assert.equal(shouldDropBackup(null, t0), true);
});

test('firstSampleAt reads the first line only and refuses garbage', () => {
  assert.equal(firstSampleAt('{"at":1700000000000,"x":1}\n{"at":5}\n'), 1_700_000_000_000);
  assert.equal(firstSampleAt('{"at":42}'), 42); // no trailing newline
  assert.equal(firstSampleAt('not json\n{"at":1}\n'), null);
  assert.equal(firstSampleAt('{"at":"soon"}\n'), null);
  assert.equal(firstSampleAt(''), null);
});

// ─── decideDuplicateReap (#203): keepers that are not the tracked one ────────

const kp = (pid: number, ws: string): KeeperProc => ({ pid, workspaceId: ws });
/** Two keepers for ONE workspace: 200 = tracked (pid file), 100 = the duplicate. */
const dupTable = [...keeperTree(100, 1), ...keeperTree(200, 1)];

test('decideDuplicateReap CLASSIFIES the untracked keeper of a LIVE workspace, never the tracked one (must-FAIL arm)', () => {
  const d = decideDuplicateReap([{ workspaceId: 'w', keeperPid: 200 }], [kp(100, 'w'), kp(200, 'w')], dupTable, new Set(['w']), true);
  assert.deepEqual(d.targets.map((t) => [t.keeperPid, t.kind, t.trackedPid]), [[100, 'duplicate', 200]]);
  assert.deepEqual(d.targets[0].pids, [102, 101, 100], 'the duplicate tree only, leaf-first, keeper last');
});

test('decideDuplicateReap NEVER touches a live workspace\'s SOLE keeper — incl. a hibernated one with a lingering keeper (must-PASS arm)', () => {
  const d = decideDuplicateReap([{ workspaceId: 'w', keeperPid: 100 }], [kp(100, 'w')], keeperTree(100, 1), new Set(['w']), true);
  assert.deepEqual(d.targets, []);
  assert.deepEqual(d.refused, []);
  // …and an untracked sole keeper of a live workspace is also left alone.
  const u = decideDuplicateReap([], [kp(100, 'w')], keeperTree(100, 1), new Set(['w']), true);
  assert.deepEqual(u.targets, []);
  assert.deepEqual(u.refused, [], 'a sole keeper is not even a refusal (no per-tick WARN noise)');
});

test('decideDuplicateReap REFUSES everything when the store was not loaded from disk', () => {
  const d = decideDuplicateReap([{ workspaceId: 'w', keeperPid: 200 }], [kp(100, 'w'), kp(200, 'w')], dupTable, new Set(['w']), false);
  assert.deepEqual(d, { targets: [], refused: [], refusedStoreNotLoaded: true });
});

test('decideDuplicateReap fails closed: no tracked keeper, or a tracked pid that is not in the scan → refused, nothing classified', () => {
  const none = decideDuplicateReap([], [kp(100, 'w'), kp(200, 'w')], dupTable, new Set(['w']), true);
  assert.deepEqual(none.targets, []);
  assert.match(none.refused[0].reason, /no-tracked-keeper/);
  const off = decideDuplicateReap([{ workspaceId: 'w', keeperPid: 999 }], [kp(100, 'w'), kp(200, 'w')], dupTable, new Set(['w']), true);
  assert.deepEqual(off.targets, []);
  assert.match(off.refused[0].reason, /tracked-keeper-not-in-scan/);
});

test('decideDuplicateReap: an ABSENT workspace loses every keeper except the tracked one (that is decideReap\'s)', () => {
  const d = decideDuplicateReap([{ workspaceId: 'gone', keeperPid: 200 }], [kp(100, 'gone'), kp(200, 'gone')], dupTable, new Set<string>(), true);
  assert.deepEqual(d.targets.map((t) => [t.keeperPid, t.kind]), [[100, 'orphan-untracked']]);
  const untracked = decideDuplicateReap([], [kp(100, 'gone'), kp(200, 'gone')], dupTable, new Set<string>(), true);
  assert.deepEqual(untracked.targets.map((t) => t.keeperPid).sort(), [100, 200]);
});

test('decideDuplicateReap refuses a duplicate tree whose members carry no start-time (identity unverifiable)', () => {
  const blind = dupTable.map((p) => ({ ...p, startTicks: undefined }));
  const d = decideDuplicateReap([{ workspaceId: 'w', keeperPid: 200 }], [kp(100, 'w'), kp(200, 'w')], blind, new Set(['w']), true);
  assert.deepEqual(d.targets, []);
  assert.match(d.refused[0].reason, /identity-unverifiable/);
});

test('parseKeeperArgv matches only THIS home\'s keeper argv (pid path anchors the home)', () => {
  const pidPathFor = (ws: string) => `/home/u/.orchestra/keepers/${ws}.pid`;
  const good = ['node', '/home/u/.orchestra/bin/keeper.js', 'ws1', '/home/u/.orchestra/keepers/ws1.sock', '/home/u/.orchestra/keepers/ws1.pid', '/home/u/.orchestra/keepers/ws1.log'];
  assert.equal(parseKeeperArgv(good, pidPathFor), 'ws1');
  // a dev-home keeper, an editor with a file named keeper.js, and a short argv are all rejected
  const dev = [...good.slice(0, 4), '/home/u/.orchestra-dev/keepers/ws1.pid', 'l'];
  assert.equal(parseKeeperArgv(dev, pidPathFor), null);
  assert.equal(parseKeeperArgv(['nvim', 'keeper.js', 'a', 'b', 'c', 'd'], pidPathFor), null);
  assert.equal(parseKeeperArgv(good.slice(0, 4), pidPathFor), null);
  assert.equal(parseKeeperArgv(null, pidPathFor), null);
});

test('decideDuplicateReap REFUSES a "duplicate" whose tree contains the tracked keeper (fork-style wrapper, review K1)', () => {
  // wrapper 50 (argv matches keeper) → tracked keeper 60 → its CLI 61; sole keeper of a LIVE workspace
  const table = [proc(50, 1, { comm: 'timeout' }), proc(60, 50, { comm: 'node' }), proc(61, 60, { comm: 'claude' })];
  const d = decideDuplicateReap([{ workspaceId: 'w', keeperPid: 60 }], [kp(50, 'w'), kp(60, 'w')], table, new Set(['w']), true);
  assert.deepEqual(d.targets, []);
  assert.match(d.refused[0].reason, /victim-tree-contains-tracked-keeper/);
  // control: a real duplicate (no tracked pid in its tree) is still classified
  const ctl = decideDuplicateReap([{ workspaceId: 'w', keeperPid: 200 }], [kp(100, 'w'), kp(200, 'w')], dupTable, new Set(['w']), true);
  assert.deepEqual(ctl.targets.map((t) => t.keeperPid), [100]);
});

test('bootFallbackKills: only where /proc identity is unavailable (non-Linux), only once the store loaded, only absent ids (review K5)', () => {
  const ids = ['gone', 'live'];
  const live = new Set(['live']);
  assert.deepEqual(bootFallbackKills('darwin', ids, live, true), ['gone']);
  assert.deepEqual(bootFallbackKills('win32', ids, live, true), ['gone']);
  assert.deepEqual(bootFallbackKills('darwin', ids, live, false), [], 'store not loaded → kills nothing');
  assert.deepEqual(bootFallbackKills('linux', ids, live, true), [], 'Linux: the guarded reaper owns it');
  assert.deepEqual(bootFallbackKills('darwin', ['live'], live, true), [], 'a live workspace is never killed');
});

// ─── isSameLiveProcess: the identity guard on the K4 SIGKILL path (review D3) ─────────────────────────────────────

/** A /proc/<pid>/stat line: field 22 (starttime) is rest[19]. */
const statLine = (pid: number, state: string, startTicks: number): string =>
  `${pid} (node) ${state} 1 1 1 0 -1 4194560 0 0 0 0 5 2 0 0 20 0 1 0 ${startTicks} 1000 250 18446744073709551615`;

test('isSameLiveProcess: same pid + same start-time + not a zombie → true (the only accepted shape)', () => {
  assert.equal(isSameLiveProcess(777, statLine(42, 'S', 777)), true);
  assert.equal(isSameLiveProcess(777, statLine(42, 'R', 777)), true);
  assert.equal(isSameLiveProcess(777, statLine(42, 'T', 777)), true, 'a SIGSTOPped process is still the same live process');
});

test('isSameLiveProcess: a RECYCLED pid (different start-time) is refused — K4a reddens this', () => {
  assert.equal(isSameLiveProcess(777, statLine(42, 'S', 778)), false);
});

test('isSameLiveProcess: a zombie is dead — K4b reddens this', () => {
  assert.equal(isSameLiveProcess(777, statLine(42, 'Z', 777)), false);
});

test('isSameLiveProcess: unreadable (null) and malformed stat text are refused', () => {
  assert.equal(isSameLiveProcess(777, null), false);
  assert.equal(isSameLiveProcess(777, 'garbage'), false);
  assert.equal(isSameLiveProcess(777, ''), false);
});
