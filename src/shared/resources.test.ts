import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  aggregateSession,
  classifyPtyId,
  collectTree,
  computeCpuPcts,
  parseProcIdentity,
  parseProcStatLine,
  parsePsOutput,
  type ProcSample,
} from './resources.ts';

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

test('classifyPtyId maps the pty id scheme', () => {
  assert.deepEqual(classifyPtyId('ws-1'), { kind: 'agent', workspaceId: 'ws-1' });
  assert.deepEqual(classifyPtyId('ws-1:run'), { kind: 'run', workspaceId: 'ws-1' });
  assert.deepEqual(classifyPtyId('ws-1:nvim'), { kind: 'nvim', workspaceId: 'ws-1' });
  assert.deepEqual(classifyPtyId('account-login:acc'), { kind: 'login', workspaceId: null });
});

test('parseProcStatLine parses a normal stat line', () => {
  // pid=1234 comm=claude state=S ppid=42 ... utime=500 stime=250 ... rss=2048 pages
  const line =
    '1234 (claude) S 42 1234 1234 0 -1 4194304 9000 0 12 0 500 250 3 1 20 0 8 0 12345 999999 2048 18446744073709551615 1 1 0 0 0 0 0 4096 0 0 0 0 17 3 0 0 0 0 0';
  const p = parseProcStatLine(line, 4096);
  assert.ok(p);
  assert.equal(p.pid, 1234);
  assert.equal(p.ppid, 42);
  assert.equal(p.comm, 'claude');
  assert.equal(p.cpuTicks, 750);
  assert.equal(p.memBytes, 2048 * 4096);
  assert.equal(p.cpuPct, null);
  assert.equal(p.startTicks, 12345); // stat field 22 (#198 T8 reaper identity)
});

test('parseProcStatLine startTicks is the REAL start time on a live /proc, and absent when malformed', () => {
  const malformed = '7 (x) S 1 7 7 0 -1 0 0 0 0 0 1 1 0 0 20 0 1 0 notanumber 1 1';
  assert.equal(parseProcStatLine(malformed, 4096)?.startTicks, undefined);
  if (process.platform !== 'linux') return;
  // Independent oracle: this test process started within the last 10 min, so its start-time
  // must sit within 10 min (in 100 Hz ticks) of machine uptime — utime/rss/etc. cannot.
  const self = parseProcIdentity(fs.readFileSync('/proc/self/stat', 'utf8'));
  const uptimeTicks = Number(fs.readFileSync('/proc/uptime', 'utf8').split(' ')[0]) * 100;
  assert.ok(self && typeof self.startTicks === 'number');
  const ageTicks = uptimeTicks - self.startTicks;
  assert.ok(ageTicks >= 0 && ageTicks < 10 * 60 * 100, `implausible process age: ${ageTicks} ticks`);
});

test('parseProcStatLine survives spaces and parens in comm', () => {
  const line =
    '99 (tmux: server (1)) S 1 99 99 0 -1 4194304 0 0 0 0 10 5 0 0 20 0 1 0 1 1 100 0 1 1 0 0 0 0 0 4096 0 0 0 0 17 0 0 0 0 0 0';
  const p = parseProcStatLine(line, 4096);
  assert.ok(p);
  assert.equal(p.pid, 99);
  assert.equal(p.comm, 'tmux: server (1)');
  assert.equal(p.ppid, 1);
  assert.equal(p.cpuTicks, 15);
});

test('parseProcStatLine rejects malformed input', () => {
  assert.equal(parseProcStatLine('', 4096), null);
  assert.equal(parseProcStatLine('no parens here', 4096), null);
  assert.equal(parseProcStatLine('x (comm) S', 4096), null);
});

test('parsePsOutput parses the non-Linux fallback, comm with spaces', () => {
  const out = [
    '  501   1  10240  1.5 claude',
    '  502 501   2048  0.0 git status helper',
    'garbage line',
    '',
  ].join('\n');
  const samples = parsePsOutput(out);
  assert.equal(samples.length, 2);
  assert.deepEqual(samples[0], {
    pid: 501,
    ppid: 1,
    comm: 'claude',
    cpuTicks: 0,
    memBytes: 10240 * 1024,
    cpuPct: 1.5,
  });
  assert.equal(samples[1].comm, 'git status helper');
});

test('collectTree gathers root + descendants only', () => {
  const table = [
    proc(1, 0),
    proc(10, 1), // root
    proc(11, 10),
    proc(12, 11),
    proc(20, 1), // unrelated sibling
  ];
  const tree = collectTree(10, table);
  assert.deepEqual(tree.map((p) => p.pid).sort((a, b) => a - b), [10, 11, 12]);
});

test('collectTree returns [] for a vanished root and never loops on cycles', () => {
  assert.deepEqual(collectTree(999, [proc(1, 0)]), []);
  // Degenerate ppid cycle (can transiently appear from a racy /proc read).
  const cyclic = [proc(5, 6), proc(6, 5)];
  const tree = collectTree(5, cyclic);
  assert.deepEqual(tree.map((p) => p.pid).sort((a, b) => a - b), [5, 6]);
});

test('computeCpuPcts derives percent-of-one-core from tick deltas', () => {
  // 100 ticks over 1000ms at HZ=100 → a full core (100%).
  const table = [proc(1, 0, { cpuTicks: 300 }), proc(2, 0, { cpuTicks: 550 })];
  const prev = new Map([
    [1, 200], // +100 ticks
    [2, 525], // +25 ticks → 25%
  ]);
  const pcts = computeCpuPcts(table, prev, 1000);
  assert.equal(pcts.get(1), 100);
  assert.equal(pcts.get(2), 25);
});

test('computeCpuPcts: unseen pid reads 0, pid reuse clamps at 0, ps pcpu passes through', () => {
  const table = [
    proc(1, 0, { cpuTicks: 50 }), // no previous reading
    proc(2, 0, { cpuTicks: 10 }), // counter went "backwards" (pid reuse)
    proc(3, 0, { cpuPct: 12.5 }), // ps fallback: already a percentage
  ];
  const pcts = computeCpuPcts(table, new Map([[2, 400]]), 1000);
  assert.equal(pcts.get(1), 0);
  assert.equal(pcts.get(2), 0);
  assert.equal(pcts.get(3), 12.5);
});

test('aggregateSession rolls a tree up and caps the process list', () => {
  const table = [
    proc(10, 1, { cpuTicks: 100, memBytes: 500, comm: 'claude' }),
    proc(11, 10, { cpuTicks: 100, memBytes: 900, comm: 'git' }),
    proc(12, 10, { cpuTicks: 0, memBytes: 100, comm: 'sh' }),
  ];
  const pcts = computeCpuPcts(
    table,
    new Map([
      [10, 0],
      [11, 50],
      [12, 0],
    ]),
    1000,
  );
  const stat = aggregateSession({ ptyId: 'ws-1', remote: false, pid: 10 }, table, pcts, 2);
  assert.equal(stat.kind, 'agent');
  assert.equal(stat.workspaceId, 'ws-1');
  assert.equal(stat.procCount, 3);
  assert.equal(stat.memBytes, 1500);
  assert.equal(stat.cpuPct, 150); // 100% + 50% + 0%
  // Capped at 2, heaviest by memory first.
  assert.deepEqual(stat.processes.map((p) => p.comm), ['git', 'claude']);
});

test('aggregateSession: remote and pid-less sessions report empty local figures', () => {
  const table = [proc(10, 1, { memBytes: 500 })];
  for (const root of [
    { ptyId: 'ws-2', remote: true, pid: 10 },
    { ptyId: 'ws-2', remote: false, pid: undefined },
  ]) {
    const stat = aggregateSession(root, table, new Map());
    assert.equal(stat.procCount, 0);
    assert.equal(stat.memBytes, 0);
    assert.equal(stat.cpuPct, 0);
    assert.equal(stat.remote, root.remote);
  }
});

test('parseProcStatLine: RSS = stat pages × the PAGE SIZE it is given (a 16 KB host reads 4x low with a hardcoded 4096)', () => {
  const stat = '4242 (claude) S 1 4242 4242 0 -1 4194560 100 0 0 0 30 12 0 0 20 0 5 0 987654 500000000 15000 18446744073709551615 0 0 0 0 0 0 0 0 0 0 0 0 17 3 0 0 0 0 0';
  assert.equal(parseProcStatLine(stat, 16384)?.memBytes, 15000 * 16384);
  assert.equal(parseProcStatLine(stat, 4096)?.memBytes, 15000 * 4096);
});

// ─── #293: the page's per-workspace rows fold the attributed containers into the EXISTING memory figure ───

import { groupSessionsByWorkspace, groupSnapshot, type SessionResourceStat } from './resources.ts';
import { accountingView as cAccountingView, buildAccounting as cBuildAccounting, emptyAccounting as cEmptyAccounting } from './container-accounting.ts';

const MBg = 1024 * 1024;
const sess = (over: Partial<SessionResourceStat>): SessionResourceStat => ({ ptyId: 'ws-a', workspaceId: 'ws-a', kind: 'agent', remote: false, cpuPct: 1, memBytes: 100 * MBg, procCount: 3, processes: [], ...over });

test('G1 groupSessionsByWorkspace: a workspace row\'s memory = its sessions\' process memory PLUS its attributed containers (ONE existing figure); other workspaces untouched; the process figure itself is not inflated', () => {
  const view = cAccountingView(cBuildAccounting([{ wsId: 'ws-a', bytes: 700 * MBg }, { wsId: 'ws-elsewhere', bytes: 5 * MBg }], [], 1));
  const { rows } = groupSessionsByWorkspace([sess({}), sess({ ptyId: 'ws-a:run', kind: 'run', memBytes: 20 * MBg }), sess({ ptyId: 'ws-b', workspaceId: 'ws-b', memBytes: 50 * MBg })], view);
  const a = rows.find((r) => r.key === 'ws-a');
  const b = rows.find((r) => r.key === 'ws-b');
  assert.equal(a?.memBytes, 820 * MBg, '100 + 20 process + 700 containers');
  assert.equal(b?.memBytes, 50 * MBg);
  assert.equal(a?.sessions.reduce((n, s) => n + s.memBytes, 0), 120 * MBg, 'the sessions\' own figures are unchanged');
});

test('G2 groupSessionsByWorkspace: no accounting / Docker down / the workspace has no container → the pre-#293 figure; a REMOTE (sandbox) row never gets local container bytes; login PTYs are kept apart', () => {
  const view = cAccountingView(cBuildAccounting([{ wsId: 'ws-a', bytes: 700 * MBg }], [], 1));
  assert.equal(groupSessionsByWorkspace([sess({})], undefined).rows[0].memBytes, 100 * MBg);
  assert.equal(groupSessionsByWorkspace([sess({})], null).rows[0].memBytes, 100 * MBg);
  assert.equal(groupSessionsByWorkspace([sess({})], cAccountingView(cEmptyAccounting('unavailable', 3))).rows[0].memBytes, 100 * MBg);
  assert.equal(groupSessionsByWorkspace([sess({ workspaceId: 'ws-z', ptyId: 'ws-z' })], view).rows[0].memBytes, 100 * MBg);
  const remote = groupSessionsByWorkspace([sess({ remote: true, memBytes: 0 })], view).rows[0];
  assert.equal(remote.memBytes, 0, 'a sandbox row has no local footprint — and no local containers either');
  const g = groupSessionsByWorkspace([sess({}), sess({ ptyId: 'account-login:x', workspaceId: null, kind: 'login' })], view);
  assert.deepEqual([g.rows.length, g.login.length], [1, 1]);
});

test('G3 (D-pick4 A) groupSessionsByWorkspace: the row carries its container CHIP data; a workspace whose only footprint is a container gets a container-only row (no sessions, cpu/procs 0, memory = its containers) — and only when Docker answered', () => {
  const view = cAccountingView(cBuildAccounting([{ wsId: 'ws-a', bytes: 640 * MBg }, { wsId: 'ws-a', bytes: null }, { wsId: 'ws-infra', bytes: 90 * MBg }], [], 1));
  const { rows } = groupSessionsByWorkspace([sess({})], view);
  const a = rows.find((r) => r.key === 'ws-a');
  assert.deepEqual([a?.containers, a?.containerOnly], [{ count: 2, bytes: 640 * MBg, unmeasured: 1 }, false]);
  const infra = rows.find((r) => r.key === 'ws-infra');
  assert.deepEqual([infra?.containerOnly, infra?.sessions.length, infra?.memBytes, infra?.cpuPct, infra?.procCount, infra?.containers], [true, 0, 90 * MBg, 0, 0, { count: 1, bytes: 90 * MBg, unmeasured: 0 }]);
  const none = groupSessionsByWorkspace([sess({})], cAccountingView(cEmptyAccounting('unavailable', 3)));
  assert.deepEqual([none.rows.length, none.rows[0].containers], [1, null], 'Docker down: no chip, no container-only row');
  // the guard itself: a view that is NOT 'ok' is never read for figures, even carrying data (production views of those states are empty — only a hand-built one proves the guard)
  for (const docker of ['unavailable', 'error', 'not-sampled', 'stale'] as const) {
    const g = groupSessionsByWorkspace([sess({})], { ...view, docker });
    assert.deepEqual([g.rows.length, g.rows[0].containers, g.rows[0].memBytes], [1, null, sess({}).memBytes], `${docker}: no chip, no container-only row, no container bytes in the figure`);
  }
  const blind = groupSessionsByWorkspace([], cAccountingView(cBuildAccounting([{ wsId: 'ws-x', bytes: null }], [], 1))).rows[0];
  assert.deepEqual([blind.containerOnly, blind.memBytes, blind.containers?.unmeasured], [true, 0, 1], 'a container nobody could measure still gets its row (unmeasured, not hidden)');
});

test('G4 (D-pick4 A) a keeper-hosted structured agent is sampled as `<wsId>:sdk`: classifyPtyId maps it to kind sdk + its workspace and it GROUPS with the workspace\'s other sessions into ONE row', () => {
  assert.deepEqual(classifyPtyId('ws-1:sdk'), { kind: 'sdk', workspaceId: 'ws-1' });
  assert.deepEqual(classifyPtyId('ws-1'), { kind: 'agent', workspaceId: 'ws-1' }, 'the PTY agent id is unchanged');
  const sdk = sess({ ptyId: 'ws-a:sdk', kind: 'sdk', memBytes: 1900 * MBg });
  const { rows } = groupSessionsByWorkspace([sdk, sess({ ptyId: 'ws-a:run', kind: 'run', memBytes: 20 * MBg })], undefined);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].sessions.map((x) => x.kind).sort(), ['run', 'sdk']);
  assert.equal(rows[0].memBytes, 1920 * MBg);
});

import { aggregateKeeperSessions } from './resources.ts';

test('G5 (D-pick4 A) aggregateKeeperSessions: one `<wsId>:sdk` session per LIVE keeper tree (keeper + CLI + MCP children, memory summed); a keeper INSIDE a PTY root\'s tree is not counted twice, but a workspace with BOTH a terminal agent and a keeper shows both (disjoint trees); a keeper whose pid left the table yields no row', () => {
  const proc = (pid: number, ppid: number, mem: number): ProcSample => ({ pid, ppid, comm: `p${pid}`, memBytes: mem, cpuPct: null, cpuTicks: 0, startTicks: 1 } as ProcSample);
  const table = [proc(10, 1, 50 * MBg), proc(11, 10, 900 * MBg), proc(12, 11, 100 * MBg), proc(20, 1, 40 * MBg), proc(21, 20, 300 * MBg), proc(99, 1, 1 * MBg)];
  const cpu = new Map([[10, 2], [11, 30], [12, 1]]);
  const roots = [{ workspaceId: 'ws-sdk', keeperPid: 10 }, { workspaceId: 'ws-pty', keeperPid: 20 }, { workspaceId: 'ws-dead', keeperPid: 777 }];
  // a PTY root (pid 20) whose tree CONTAINS the ws-pty keeper (pid 20 itself here): already counted by that row → skipped; ws-sdk's disjoint tree is sampled
  const out = aggregateKeeperSessions(roots, [20], table, cpu);
  assert.equal(out.length, 1);
  assert.deepEqual([out[0].ptyId, out[0].kind, out[0].workspaceId, out[0].procCount, out[0].memBytes, out[0].cpuPct], ['ws-sdk:sdk', 'sdk', 'ws-sdk', 3, 1050 * MBg, 33]);
  // pre-review #2: a workspace that has a PTY agent in a DISJOINT tree (pid 99) still shows its keeper's CLI + MCP memory — it is real, not the PTY's
  const both = aggregateKeeperSessions([roots[1]], [99], table, cpu);
  assert.deepEqual([both.length, both[0]?.ptyId, both[0]?.memBytes], [1, 'ws-pty:sdk', 340 * MBg]);
  assert.equal(aggregateKeeperSessions([roots[1]], [], table, cpu).length, 1);
});

// ─── #328: a scope-tracked member's row reads the SCOPE (sees a detached process); an untracked one keeps the tree figure ───

import { buildMemberMemoryReport, memberViewFrom } from './member-memory.ts';

const rd = (currentMb: number | null, procs: Array<{ pid: number; startTicks: number; rssBytes: number; role: string }> | null, keeperPid: number | null = 1) => ({ unit: 'u', gen: 'k', currentBytes: currentMb === null ? null : currentMb * MBg, procs, keeperPid });
const rep = (...views: ReturnType<typeof memberViewFrom>[]) => buildMemberMemoryReport(1, views, [], null);

test('G6 (#328) a tracked member\'s row memory = the scope meter (which holds the keeper tree AND a detached Reliquat) + the PTY sessions outside the scope; the `sdk` tree is not added twice; the Reliquat count rides on the row', () => {
  const members = rep(memberViewFrom('ws-a', [rd(1100, [{ pid: 1, startTicks: 1, rssBytes: 1, role: 'cli' }, { pid: 9, startTicks: 9, rssBytes: 400 * MBg, role: 'reliquat', comm: 'chrome' }])]));
  const sdk = sess({ ptyId: 'ws-a:sdk', kind: 'sdk', memBytes: 600 * MBg });
  const run = sess({ ptyId: 'ws-a:run', kind: 'run', memBytes: 20 * MBg });
  const withScope = groupSessionsByWorkspace([sdk, run], null, members).rows[0];
  const master = groupSessionsByWorkspace([sdk, run], null).rows[0]; // the unfixed arm: no members → the tree walk
  assert.equal(master.memBytes, 620 * MBg);
  assert.equal(withScope.memBytes, 1120 * MBg);
  assert.deepEqual(withScope.reliquats, { count: 1, bytes: 400 * MBg, partial: false, procs: [{ pid: 9, comm: 'chrome', rssBytes: 400 * MBg }] });
  assert.equal(master.reliquats, null);
});

test('G7 (#328) the scope figure and the container fold compose (scope + containers); a member NOT in the report, a remote row and a meter-unreadable member keep the pre-#328 figure', () => {
  const view = cAccountingView(cBuildAccounting([{ wsId: 'ws-a', bytes: 700 * MBg }], [], 1));
  const members = rep(memberViewFrom('ws-a', [rd(1000, [])]), memberViewFrom('ws-u', [rd(null, null)]));
  assert.equal(groupSessionsByWorkspace([sess({ kind: 'sdk', ptyId: 'ws-a:sdk' })], view, members).rows[0].memBytes, 1700 * MBg);
  assert.equal(groupSessionsByWorkspace([sess({ workspaceId: 'ws-z', ptyId: 'ws-z' })], null, members).rows[0].memBytes, 100 * MBg);
  assert.equal(groupSessionsByWorkspace([sess({ workspaceId: 'ws-u', ptyId: 'ws-u:sdk', kind: 'sdk' })], null, members).rows[0].memBytes, 100 * MBg);
  const remote = groupSessionsByWorkspace([sess({ remote: true, memBytes: 0, kind: 'sdk', ptyId: 'ws-a:sdk' })], null, members).rows[0];
  assert.deepEqual([remote.memBytes, remote.reliquats], [0, null]);
});

test('G8 (#328) a member whose SESSION is gone but whose scope still holds a Reliquat gets a scope-only row (scope memory + Reliquat count, no cpu/procs); its containers fold into the SAME row, never a second container-only row; an empty scope adds nothing', () => {
  const view = cAccountingView(cBuildAccounting([{ wsId: 'ws-gone', bytes: 300 * MBg }], [], 1));
  const members = rep(
    memberViewFrom('ws-gone', [rd(1500, [{ pid: 9, startTicks: 9, rssBytes: 1400 * MBg, role: 'reliquat', comm: 'chrome' }])]),
    memberViewFrom('ws-empty', [rd(0, [])]),
  );
  const { rows } = groupSessionsByWorkspace([sess({ workspaceId: 'ws-live', ptyId: 'ws-live:sdk', kind: 'sdk' })], view, members);
  const gone = rows.filter((r) => r.key === 'ws-gone');
  assert.equal(gone.length, 1, 'ONE row for the member (the container-only row is not added next to it)');
  assert.deepEqual([gone[0].scopeOnly, gone[0].containerOnly, gone[0].sessions.length, gone[0].cpuPct, gone[0].procCount], [true, false, 0, 0, 0]);
  assert.equal(gone[0].memBytes, 1800 * MBg); // scope 1500 + containers 300
  assert.deepEqual(gone[0].reliquats, { count: 1, bytes: 1400 * MBg, partial: false, procs: [{ pid: 9, comm: 'chrome', rssBytes: 1400 * MBg }] });
  assert.equal(gone[0].containers?.bytes, 300 * MBg); // the 🐳 chip data rides on the same row
  assert.equal(rows.some((r) => r.key === 'ws-empty'), false);
  assert.equal(rows.find((r) => r.key === 'ws-live')?.scopeOnly, false);
  // without the report: master's rows (no scope-only row at all)
  assert.equal(groupSessionsByWorkspace([sess({ workspaceId: 'ws-live', ptyId: 'ws-live:sdk', kind: 'sdk' })], view).rows.some((r) => r.scopeOnly), false);
});

test('G9 (#328) groupSnapshot: the page\'s ONE call over a snapshot reads sessions + containers + members (a snapshot without members = master\'s rows; null = no rows)', () => {
  const members = rep(memberViewFrom('ws-a', [rd(1100, [{ pid: 9, startTicks: 9, rssBytes: 400 * MBg, role: 'reliquat', comm: 'chrome' }])]));
  const containers = cAccountingView(cBuildAccounting([{ wsId: 'ws-a', bytes: 100 * MBg }], [], 1));
  const snap = { sessions: [sess({ kind: 'sdk', ptyId: 'ws-a:sdk', memBytes: 600 * MBg })], containers, members };
  assert.equal(groupSnapshot(snap).rows[0].memBytes, 1200 * MBg); // scope 1100 + containers 100
  assert.equal(groupSnapshot(snap).rows[0].reliquats?.count, 1);
  assert.equal(groupSnapshot({ ...snap, members: undefined }).rows[0].memBytes, 700 * MBg); // master: tree 600 + containers 100
  assert.equal(groupSnapshot({ ...snap, containers: undefined }).rows[0].memBytes, 1100 * MBg);
  assert.deepEqual(groupSnapshot(null), { rows: [], login: [] });
});

test('G10 (#328) a live keeper OUTSIDE every scope of the member (an older generation\'s leftovers): the row adds the tree and the stale scope — it never shows the stale scope alone', () => {
  const members = rep(memberViewFrom('ws-a', [rd(50, [{ pid: 9, startTicks: 9, rssBytes: 40 * MBg, role: 'reliquat', comm: 'chrome' }], null)]));
  const row = groupSessionsByWorkspace([sess({ kind: 'sdk', ptyId: 'ws-a:sdk', memBytes: 600 * MBg })], null, members).rows[0];
  assert.equal(row.memBytes, 650 * MBg);
  assert.equal(row.reliquats?.count, 1);
});
