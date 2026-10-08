import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ESCAPED_TTL_MS, __resetMemberMemoryForTests, memoizeEscaped, realMemberMemoryDeps, sampleMemberMemory, type MemberMemoryDeps } from './member-memory.ts';
import { countMemberScopes, listScopeProcs, memberScopes, readScopeMemory, realScopeEnv, scopeSupport } from './memory-scope.ts';
import { formatReliquatsLine } from '../shared/member-memory.ts';
import { groupSessionsByWorkspace, type SessionResourceStat } from '../shared/resources.ts';
import type { MemberScope } from './memory-scope.ts';

const MB = 1024 * 1024;
const scope = (ws: string, gen = 'k1'): MemberScope => ({ unit: `orchestra-ws-${ws}-${gen}.scope`, gen, cgroupDir: `/fake/${ws}-${gen}`, keeperPid: gen === 'k1' ? 100 : null });

/** A fake host: which scopes exist per workspace, what each reads, who is a live member. Every call recorded. */
function host(over: Partial<MemberMemoryDeps> = {}, world: { scopes?: Record<string, MemberScope[]>; mem?: Record<string, number | null | Error>; procs?: Record<string, Array<{ pid: number; startTicks: number; rssBytes: number; role: string; comm?: string }> | null | Error> } = {}) {
  const calls = { scopes: [] as string[], mem: [] as string[], procs: [] as string[] };
  const deps: MemberMemoryDeps = {
    now: () => 42,
    workspaceIds: () => ['ws-a', 'ws-b', 'ws-c'],
    liveMemberIds: () => ['ws-a', 'ws-b', 'ws-c'],
    scopes: (ws) => (calls.scopes.push(ws), world.scopes?.[ws] ?? []),
    readMemory: (s) => {
      calls.mem.push(s.unit);
      const v = world.mem?.[s.unit];
      if (v instanceof Error) throw v;
      return v == null ? null : { currentBytes: v };
    },
    listProcs: (s) => {
      calls.procs.push(s.unit);
      const v = world.procs?.[s.unit];
      if (v instanceof Error) throw v;
      return v ?? null;
    },
    support: () => ({ ok: true }),
    countScopes: () => Object.values(world.scopes ?? {}).reduce((n, l) => n + l.length, 0),
    ...over,
  };
  return { deps, calls };
}

test('P1 a tracked member reads the scope meter and its Reliquats; untracked live members are listed as such; nobody is "tracked" without a scope', () => {
  __resetMemberMemoryForTests();
  const a = scope('ws-a');
  const { deps } = host({}, {
    scopes: { 'ws-a': [a] },
    mem: { [a.unit]: 900 * MB },
    procs: { [a.unit]: [{ pid: 1, startTicks: 1, rssBytes: 300 * MB, role: 'cli' }, { pid: 7, startTicks: 9, rssBytes: 500 * MB, role: 'reliquat' }] },
  });
  const r = sampleMemberMemory(deps);
  assert.equal(r.at, 42);
  assert.deepEqual(r.tracked.map((m) => [m.wsId, m.bytes, m.reliquats, m.reliquatBytes]), [['ws-a', 900 * MB, 1, 500 * MB]]);
  assert.deepEqual(r.untracked, ['ws-b', 'ws-c']);
  assert.equal(r.unsupported, null);
});

test('P2 several generations of one member are SUMMED (restart while Reliquats keep the old scope alive)', () => {
  __resetMemberMemoryForTests();
  const g1 = scope('ws-a', 'k1');
  const g0 = scope('ws-a', 'j0');
  const { deps } = host({}, {
    scopes: { 'ws-a': [g1, g0] },
    mem: { [g1.unit]: 600 * MB, [g0.unit]: 1500 * MB },
    procs: { [g1.unit]: [{ pid: 1, startTicks: 1, rssBytes: 1, role: 'cli' }], [g0.unit]: [{ pid: 5, startTicks: 5, rssBytes: 1400 * MB, role: 'reliquat' }] },
  });
  const m = sampleMemberMemory(deps).tracked[0];
  assert.deepEqual([m.scopes, m.bytes, m.reliquats], [2, 2100 * MB, 1]);
});

test('P3 no scope anywhere / unsupported host → nothing tracked, every live member is « not tracked », the reason is carried — and the tree figure stays (rows unchanged)', () => {
  __resetMemberMemoryForTests();
  const { deps } = host({ support: () => ({ ok: false, reason: 'platform darwin has no cgroups' }) });
  const r = sampleMemberMemory(deps);
  assert.deepEqual([r.tracked.length, r.untracked, r.unsupported], [0, ['ws-a', 'ws-b', 'ws-c'], 'platform darwin has no cgroups']);
  assert.equal(formatReliquatsLine(r, (id) => id), 'reliquats: Reliquats not tracked — platform darwin has no cgroups');
  const sess: SessionResourceStat = { ptyId: 'ws-a:sdk', workspaceId: 'ws-a', kind: 'sdk', remote: false, cpuPct: 1, memBytes: 640 * MB, procCount: 4, processes: [] };
  const row = groupSessionsByWorkspace([sess], null, r).rows[0];
  assert.equal(row.memBytes, 640 * MB);
  assert.equal(row.reliquats, null);
});

test('P4 FI-1 calls that throw or return null read as UNMEASURED / not tracked — never a throw, never a fake 0', () => {
  __resetMemberMemoryForTests();
  const a = scope('ws-a');
  const b = scope('ws-b');
  const { deps } = host(
    { scopes: (ws) => { if (ws === 'ws-c') throw new Error('EACCES'); return ws === 'ws-a' ? [a] : ws === 'ws-b' ? [b] : []; } },
    { mem: { [a.unit]: new Error('ENOENT: scope vanished'), [b.unit]: null }, procs: { [a.unit]: new Error('gone'), [b.unit]: null } },
  );
  const r = sampleMemberMemory(deps);
  assert.deepEqual(r.tracked.map((m) => [m.wsId, m.bytes, m.reliquats, m.unreadable, m.unlisted]), [['ws-a', null, null, 1, 1], ['ws-b', null, null, 1, 1]]);
  assert.deepEqual(r.untracked, ['ws-c']);
});

test('P5 a support probe that throws is "unsupported" (with a reason), not an exception', () => {
  __resetMemberMemoryForTests();
  const { deps } = host({ support: () => { throw new Error('systemctl missing'); } });
  assert.match(sampleMemberMemory(deps).unsupported ?? '', /systemctl missing/);
});

test('P6 the same workspace id offered twice (store ∪ keeper roots) is asked ONCE; a live member without a scope is not double counted', () => {
  __resetMemberMemoryForTests();
  const { deps, calls } = host({ workspaceIds: () => ['ws-a', 'ws-a', 'ws-b'], liveMemberIds: () => ['ws-a', 'ws-a', 'ws-b'] });
  const r = sampleMemberMemory(deps);
  assert.deepEqual(calls.scopes, ['ws-a', 'ws-b']);
  assert.deepEqual(r.untracked, ['ws-a', 'ws-b']);
});

test('P7 the REAL FI-1 binding over a FAKE cgroup tree (ORCHESTRA_CGROUP_ROOT): scopes, the meter, the member list and the host-wide count all come from H1\'s own functions — a stub in any of the four would turn this red', () => {
  __resetMemberMemoryForTests();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'h2-p7-cg-'));
  const uid = process.getuid!();
  const app = path.join(root, 'user.slice', `user-${uid}.slice`, `user@${uid}.service`, 'app.slice');
  const prefix = 'orchestra-rig-wh-h2-p7-';
  const mkScope = (ws: string, current: number, pids: number[]) => {
    const dir = path.join(app, `${prefix}${ws}-abc123.scope`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'memory.current'), `${current}\n`);
    fs.writeFileSync(path.join(dir, 'memory.events'), 'low 0\nhigh 0\nmax 0\noom 0\noom_kill 0\n');
    fs.writeFileSync(path.join(dir, 'cgroup.procs'), pids.map(String).join('\n') + '\n');
  };
  const saved = { root: process.env.ORCHESTRA_CGROUP_ROOT, prefix: process.env.ORCHESTRA_MEMORY_SCOPE_PREFIX };
  try {
    process.env.ORCHESTRA_CGROUP_ROOT = root;
    process.env.ORCHESTRA_MEMORY_SCOPE_PREFIX = prefix;
    mkScope('wsa', 150 * MB, [process.pid]); // a real live pid: FI-1 reads its /proc stat; no pid file ⇒ no keeper ⇒ it is a Reliquat
    mkScope('wsstray', 9 * MB, [process.pid]); // a scope of a workspace nobody asks about
    const real = realMemberMemoryDeps({ workspaceIds: () => ['wsa'], liveMemberIds: () => [] });
    const r = sampleMemberMemory(real);
    assert.deepEqual(r.tracked.map((m) => [m.wsId, m.scopes, m.bytes, m.reliquats]), [['wsa', 1, 150 * MB, 1]]);
    assert.ok((r.tracked[0].reliquatBytes ?? 0) > 0, 'FI-1 read the RSS of the live pid');
    assert.equal(r.tracked[0].reliquatProcs[0].pid, process.pid);
    assert.equal(r.strayScopes, 1, 'the unasked scope is counted by H1\'s countMemberScopes, not read');
    assert.deepEqual(real.scopes('nobody'), []);
  } finally {
    if (saved.root === undefined) delete process.env.ORCHESTRA_CGROUP_ROOT; else process.env.ORCHESTRA_CGROUP_ROOT = saved.root;
    if (saved.prefix === undefined) delete process.env.ORCHESTRA_MEMORY_SCOPE_PREFIX; else process.env.ORCHESTRA_MEMORY_SCOPE_PREFIX = saved.prefix;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('P8b the non-Linux fallback THROUGH H1\'s real code: on a darwin env FI-1 answers « not linux » and no scope — the member keeps its tree figure and the line says « Reliquats not tracked »', () => {
  __resetMemberMemoryForTests();
  const env = { ...realScopeEnv(), platform: 'darwin', uid: null };
  const deps: MemberMemoryDeps = {
    now: () => 1,
    workspaceIds: () => ['ws-a'],
    liveMemberIds: () => ['ws-a'],
    scopes: (ws) => memberScopes(ws, env),
    readMemory: (s) => readScopeMemory(s, env),
    listProcs: (s) => listScopeProcs(s, null, env),
    support: () => scopeSupport(env),
    countScopes: () => countMemberScopes(env)?.total ?? null,
  };
  const r = sampleMemberMemory(deps);
  assert.deepEqual([r.tracked.length, r.untracked, r.unsupported, r.strayScopes], [0, ['ws-a'], 'not linux (darwin)', null]);
  assert.equal(formatReliquatsLine(r, (id) => id), 'reliquats: Reliquats not tracked — not linux (darwin)');
});

test('P9 a scope of a workspace we never asked about is counted as STRAY (never read); scopes we read are not stray; an uncountable host reports null', () => {
  __resetMemberMemoryForTests();
  const a = scope('ws-a');
  const base = { scopes: { 'ws-a': [a] }, mem: { [a.unit]: 100 * MB }, procs: { [a.unit]: [] } };
  assert.equal(sampleMemberMemory(host({ countScopes: () => 3 }, base).deps).strayScopes, 2);
  assert.equal(sampleMemberMemory(host({ countScopes: () => 1 }, base).deps).strayScopes, 0);
  assert.equal(sampleMemberMemory(host({ countScopes: () => 0 }, base).deps).strayScopes, 0, 'a scope that vanished between the two reads never makes the count negative');
  assert.equal(sampleMemberMemory(host({ countScopes: () => null }, base).deps).strayScopes, null);
  assert.equal(sampleMemberMemory(host({ countScopes: () => { throw new Error('EACCES'); } }, base).deps).strayScopes, null);
});

test('P10 a live member whose keeper runs OUTSIDE every scope it has (an older generation\'s leftovers): tracked for those leftovers AND listed untracked for its live session', () => {
  __resetMemberMemoryForTests();
  const stale = { ...scope('ws-a', 'j0'), keeperPid: null };
  const { deps } = host({ liveMemberIds: () => ['ws-a'] }, { scopes: { 'ws-a': [stale] }, mem: { [stale.unit]: 50 * MB }, procs: { [stale.unit]: [{ pid: 9, startTicks: 9, rssBytes: 40 * MB, role: 'reliquat' }] } });
  const r = sampleMemberMemory(deps);
  assert.deepEqual([r.tracked[0].wsId, r.tracked[0].keeperInScope, r.tracked[0].reliquats], ['ws-a', false, 1]);
  assert.deepEqual(r.untracked, ['ws-a']);
  // with the keeper IN the scope it is plain tracked
  const live = scope('ws-a', 'k1'); // keeperPid 100
  const ok = sampleMemberMemory(host({ liveMemberIds: () => ['ws-a'] }, { scopes: { 'ws-a': [live] }, mem: { [live.unit]: 50 * MB }, procs: { [live.unit]: [] } }).deps);
  assert.deepEqual([ok.tracked[0].keeperInScope, ok.untracked], [true, []]);
});

test('P12 (#328 F1) the keeper tree OUTSIDE the scope is billed per member through FI-1 v1.9: only for a keeper that is IN a scope, with that scope; null / a throw bills nothing; no walk wired = the bill alone', () => {
  __resetMemberMemoryForTests();
  const a = scope('ws-a'); // keeperPid 100
  const b = { ...scope('ws-b'), keeperPid: null }; // keeper not in its scope: nothing to walk
  const calls: string[] = [];
  const mk = (escaped: MemberMemoryDeps['escaped']) =>
    host({ escaped }, { scopes: { 'ws-a': [a], 'ws-b': [b] }, mem: { [a.unit]: 300 * MB, [b.unit]: 20 * MB }, procs: { [a.unit]: [], [b.unit]: [] } }).deps;
  const r = sampleMemberMemory(mk((s) => (calls.push(s?.unit ?? 'NO-SCOPE'), [{ pid: 7, comm: 'chrome', rssBytes: 83 * MB }])));
  assert.deepEqual(calls, [a.unit], 'ws-b has no keeper in its scope: no walk, and the walk gets the scope that HOLDS the keeper');
  const va = r.tracked.find((m) => m.wsId === 'ws-a')!;
  assert.deepEqual([va.outsideBytes, va.outsideCount], [83 * MB, 1]);
  assert.equal(r.tracked.find((m) => m.wsId === 'ws-b')!.outsideBytes, 0);
  // two generations: the walk is asked about the generation that holds the keeper, never the stale one
  const stale = { ...scope('ws-a', 'j0'), keeperPid: null };
  const seen: string[] = [];
  sampleMemberMemory(host({ escaped: (s) => (seen.push(s.unit), []) }, { scopes: { 'ws-a': [stale, a] }, mem: { [a.unit]: 1, [stale.unit]: 1 }, procs: { [a.unit]: [], [stale.unit]: [] } }).deps);
  assert.deepEqual(seen, [a.unit]);
  assert.equal(sampleMemberMemory(mk(() => null)).tracked.find((m) => m.wsId === 'ws-a')!.outsideBytes, 0);
  assert.equal(sampleMemberMemory(mk(() => { throw new Error('EACCES'); })).tracked.find((m) => m.wsId === 'ws-a')!.outsideBytes, 0);
  assert.equal(sampleMemberMemory(host({}, { scopes: { 'ws-a': [a] }, mem: { [a.unit]: 300 * MB }, procs: { [a.unit]: [] } }).deps).tracked[0].outsideBytes, 0, 'no walk wired = the bill alone');
});

test('P14 (#328 F1) the keeper-tree walk costs one stat read per HOST pid (H1): it is memoized per (scope unit, keeper) for ESCAPED_TTL_MS for the pollers, a FRESH read (the monitor\'s record) always walks, a new keeper pid is a new key, and the memo expires', () => {
  __resetMemberMemoryForTests();
  let t = 1_000_000;
  const calls: string[] = [];
  const base: NonNullable<MemberMemoryDeps['escaped']> = (s) => (calls.push(`${s.unit}:${s.keeperPid}`), [{ pid: calls.length, comm: 'chrome', rssBytes: calls.length * MB }]);
  const poll = memoizeEscaped(base, { now: () => t });
  const a = scope('ws-a'); // keeper 100
  assert.equal(poll(a)![0].pid, 1);
  t += 2_000;
  assert.equal(poll(a)![0].pid, 1, 'the page polls every 2 s: served from the memo');
  assert.equal(calls.length, 1);
  assert.equal(poll({ ...a, keeperPid: 101 })![0].pid, 2, 'a new keeper pid is a NEW key (a restart is never served the old tree)');
  t += ESCAPED_TTL_MS;
  assert.equal(poll(a)![0].pid, 3, 'expired');
  const fresh = memoizeEscaped(base, { fresh: true, now: () => t });
  assert.equal(fresh(a)![0].pid, 4, 'fresh always walks (the monitor line is a record)');
  assert.equal(fresh(a)![0].pid, 5);
  t += 1;
  assert.equal(poll(a)![0].pid, 5, 'and what a fresh read walked is what the pollers then share');
  assert.equal(memoizeEscaped(() => null, { now: () => t })(scope('ws-z')), null, 'a failed walk (null) is memoized too: a broken host is not hammered every 2 s');
});
