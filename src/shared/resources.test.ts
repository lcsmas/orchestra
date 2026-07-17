import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  aggregateSession,
  classifyPtyId,
  collectTree,
  computeCpuPcts,
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
  const p = parseProcStatLine(line);
  assert.ok(p);
  assert.equal(p.pid, 1234);
  assert.equal(p.ppid, 42);
  assert.equal(p.comm, 'claude');
  assert.equal(p.cpuTicks, 750);
  assert.equal(p.memBytes, 2048 * 4096);
  assert.equal(p.cpuPct, null);
});

test('parseProcStatLine survives spaces and parens in comm', () => {
  const line =
    '99 (tmux: server (1)) S 1 99 99 0 -1 4194304 0 0 0 0 10 5 0 0 20 0 1 0 1 1 100 0 1 1 0 0 0 0 0 4096 0 0 0 0 17 0 0 0 0 0 0';
  const p = parseProcStatLine(line);
  assert.ok(p);
  assert.equal(p.pid, 99);
  assert.equal(p.comm, 'tmux: server (1)');
  assert.equal(p.ppid, 1);
  assert.equal(p.cpuTicks, 15);
});

test('parseProcStatLine rejects malformed input', () => {
  assert.equal(parseProcStatLine(''), null);
  assert.equal(parseProcStatLine('no parens here'), null);
  assert.equal(parseProcStatLine('x (comm) S'), null);
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
