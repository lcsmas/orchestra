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
function host(over: Partial<MemberMemoryDeps> = {}, world: { scopes?: Record<string, MemberScope[]>; mem?: Record<string, number | null | Error>; procs?: Record<string, Array<{ pid: number; startTicks: number; rssBytes: number; role: string; comm?: string }> | null | Error>; cap?: Record<string, { capCurrentBytes?: number | null; maxBytes: number | null; workingSetBytes: number | null; peakBytes: number | null }> } = {}) {
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
      return v == null ? null : { currentBytes: v, ...(world.cap?.[s.unit] ?? {}) };
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

test('P9b (#332 fu, review m1) THROUGH the real FI-1 binding over a fake two-leaf tree: a leaf whose cgroup.procs cannot be READ (EISDIR, a real fs error) leaves procs UNKNOWN — the Reliquat in the other leaf is not reported as « no Reliquats »; readable leaves list it', () => {
  __resetMemberMemoryForTests();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fu-p9b-cg-'));
  const uid = process.getuid!();
  const app = path.join(root, 'user.slice', `user-${uid}.slice`, `user@${uid}.service`, 'app.slice');
  const prefix = 'orchestra-rig-wh-fu-p9b-';
  const saved = { root: process.env.ORCHESTRA_CGROUP_ROOT, prefix: process.env.ORCHESTRA_MEMORY_SCOPE_PREFIX };
  try {
    process.env.ORCHESTRA_CGROUP_ROOT = root;
    process.env.ORCHESTRA_MEMORY_SCOPE_PREFIX = prefix;
    const dir = path.join(app, `${prefix}wsa-abc123.scope`);
    fs.mkdirSync(path.join(dir, 'k'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'w'));
    fs.writeFileSync(path.join(dir, 'memory.current'), `${150 * MB}\n`);
    fs.writeFileSync(path.join(dir, 'memory.events'), 'low 0\nhigh 0\nmax 0\noom 0\noom_kill 0\n');
    fs.writeFileSync(path.join(dir, 'cgroup.procs'), '');
    fs.writeFileSync(path.join(dir, 'k', 'cgroup.procs'), `${process.pid}\n`); // a real live pid in the keeper leaf, no pid file ⇒ a Reliquat
    fs.writeFileSync(path.join(dir, 'w', 'cgroup.procs'), '');
    const real = realMemberMemoryDeps({ workspaceIds: () => ['wsa'], liveMemberIds: () => [] });
    const ok = sampleMemberMemory(real);
    assert.deepEqual(ok.tracked.map((m) => [m.wsId, m.reliquats]), [['wsa', 1]], 'control: both leaves readable ⇒ the Reliquat is listed');
    __resetMemberMemoryForTests();
    fs.rmSync(path.join(dir, 'w', 'cgroup.procs'));
    fs.mkdirSync(path.join(dir, 'w', 'cgroup.procs')); // readFileSync → EISDIR from the real fs
    const bad = sampleMemberMemory(realMemberMemoryDeps({ workspaceIds: () => ['wsa'], liveMemberIds: () => [] }));
    const m = bad.tracked.find((t) => t.wsId === 'wsa');
    assert.ok(m, 'the member is still tracked (its meter reads)');
    assert.equal(m!.reliquats, null, 'UNKNOWN (null), never 0');
  } finally {
    if (saved.root === undefined) delete process.env.ORCHESTRA_CGROUP_ROOT; else process.env.ORCHESTRA_CGROUP_ROOT = saved.root;
    if (saved.prefix === undefined) delete process.env.ORCHESTRA_MEMORY_SCOPE_PREFIX; else process.env.ORCHESTRA_MEMORY_SCOPE_PREFIX = saved.prefix;
    fs.rmSync(root, { recursive: true, force: true });
  }
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

test('P15 (#323) the producer carries the scope\'s own limit, working set and peak into the member view (the keeper\'s scope only)', () => {
  __resetMemberMemoryForTests();
  const a = scope('ws-a'); // keeperPid 100 ⇒ the live generation
  const { deps } = host({}, { scopes: { 'ws-a': [a] }, mem: { [a.unit]: 2100 * MB }, procs: { [a.unit]: [] }, cap: { [a.unit]: { maxBytes: 6144 * MB, workingSetBytes: 1600 * MB, peakBytes: 2400 * MB } } });
  const v = sampleMemberMemory(deps).tracked[0];
  assert.deepEqual(v.cap, { unit: a.unit, hardBytes: 6144 * MB, billBytes: 2100 * MB, workingSetBytes: 1600 * MB, peakBytes: 2400 * MB, scopes: 1 });
  const { deps: d2 } = host({}, { scopes: { 'ws-a': [a] }, mem: { [a.unit]: 2100 * MB }, procs: { [a.unit]: [] } });
  assert.equal(sampleMemberMemory(d2).tracked[0].cap, null, 'a reader that gives no limit (FI-1 v1.10 host) ⇒ no cap, the row stays as today');
  assert.equal(sampleMemberMemory(d2).tracked[0].capNote, null, 'and no « not applied » claim either: an older reader does not say');
});

test('P17 (#323-fu, review m2) the producer carries FI-1 limitApplied into the member view: `max` ⇒ capNote « not-applied » (still no cap), unknown ⇒ no note', () => {
  __resetMemberMemoryForTests();
  const a = scope('ws-a');
  const mk = (limitApplied: boolean | null | undefined) => host({}, { scopes: { 'ws-a': [a] }, mem: { [a.unit]: 900 * MB }, procs: { [a.unit]: [] }, cap: { [a.unit]: { maxBytes: null, limitApplied } } });
  const none = sampleMemberMemory(mk(false).deps).tracked[0];
  assert.equal(none.capNote, 'not-applied');
  assert.equal(none.cap, null);
  assert.equal(sampleMemberMemory(mk(null).deps).tracked[0].capNote, null);
  assert.equal(sampleMemberMemory(mk(undefined).deps).tracked[0].capNote, null);
  assert.equal(sampleMemberMemory(mk(true).deps).tracked[0].capNote, null, 'a limit applied (even one the reader could not size) is not « not applied »');
});

test('P16 (#323) the cap view THROUGH H1\'s real FI-1 functions over a fake cgroup + /proc tree: the keeper\'s scope gives its memory.max, bill and working set; a scope without a keeper (leftover generation) gives none', () => {
  __resetMemberMemoryForTests();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'h2-p16-'));
  try {
    const uid = 1000, ws = 'wscap';
    const app = path.join(root, 'cg', 'user.slice', `user-${uid}.slice`, `user@${uid}.service`, 'app.slice');
    const proc = path.join(root, 'proc');
    const kdir = path.join(root, 'keepers');
    fs.mkdirSync(kdir, { recursive: true });
    const mk = (gen: string, files: Record<string, string>) => {
      const d = path.join(app, `orchestra-ws-${ws}-${gen}.scope`);
      fs.mkdirSync(d, { recursive: true });
      for (const [f, v] of Object.entries({ 'memory.events': 'low 0\nhigh 0\nmax 0\noom 0\noom_kill 0\n', 'memory.swap.max': '0\n', ...files })) fs.writeFileSync(path.join(d, f), v);
      return d;
    };
    const live = mk('live01', { 'memory.current': `${2100 * MB}\n`, 'memory.max': `${6144 * MB}\n`, 'memory.peak': `${2400 * MB}\n`, 'memory.stat': `inactive_file ${500 * MB}\n`, 'cgroup.procs': '700\n' });
    const leftover = mk('old001', { 'memory.current': `${400 * MB}\n`, 'memory.max': `${3072 * MB}\n`, 'memory.stat': '', 'cgroup.procs': '' });
    fs.mkdirSync(path.join(proc, '700'), { recursive: true });
    fs.writeFileSync(path.join(proc, '700', 'stat'), `700 (node) S 1 1 1 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 7000 1000000 100\n`);
    fs.writeFileSync(path.join(proc, '700', 'cmdline'), ['node', 'keeper.js', ws].join('\0') + '\0');
    fs.writeFileSync(path.join(proc, '700', 'cgroup'), `0::${live.slice(path.join(root, 'cg').length)}\n`);
    fs.writeFileSync(path.join(kdir, `${ws}.pid`), JSON.stringify({ pid: 700 }));
    const env = { platform: 'linux', uid, cgroupRoot: path.join(root, 'cg'), procRoot: proc, pageSize: 4096, env: { ORCHESTRA_MEMORY_SCOPE_PREFIX: 'orchestra-ws-' }, readFile: (p: string) => fs.readFileSync(p, 'utf8'), readdir: (p: string) => fs.readdirSync(p), exists: (p: string) => fs.existsSync(p), keeperPidFile: (w: string) => path.join(kdir, `${w}.pid`) };
    const deps: MemberMemoryDeps = {
      now: () => 1, workspaceIds: () => [ws], liveMemberIds: () => [ws],
      scopes: (w) => memberScopes(w, env), readMemory: (s) => readScopeMemory(s, env), listProcs: (s) => listScopeProcs(s, null, env),
      support: () => ({ ok: true }), countScopes: () => 2,
    };
    const v = sampleMemberMemory(deps).tracked[0];
    assert.equal(v.scopes, 2);
    assert.equal(v.keeperInScope, true);
    assert.deepEqual(v.cap, { unit: `orchestra-ws-${ws}-live01.scope`, hardBytes: 6144 * MB, billBytes: 2100 * MB, workingSetBytes: 1600 * MB, peakBytes: 2400 * MB, scopes: 2 }, 'the LIVE generation\'s limit through H1\'s code — not the leftover\'s 3 GB, not a stub');
    assert.ok(leftover.length > 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('P18 (#323-fu × #332) THROUGH the real FI-1 functions over a fake LEAF scope (k keeper leaf + w work leaf, the scope carrying a numeric backstop): a member capped on w has its BAR and NO « not applied » note; the same member with w/memory.max ABSENT shows the note and no bar; an unreadable w/memory.max shows neither (unknown)', () => {
  __resetMemberMemoryForTests();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'h2-p18-'));
  try {
    const uid = 1000, ws = 'wsleaf';
    const app = path.join(root, 'cg', 'user.slice', `user-${uid}.slice`, `user@${uid}.service`, 'app.slice');
    const proc = path.join(root, 'proc');
    const kdir = path.join(root, 'keepers');
    fs.mkdirSync(kdir, { recursive: true });
    const scopeDir = path.join(app, `orchestra-ws-${ws}-live01.scope`);
    const kDir = path.join(scopeDir, 'k');
    const wDir = path.join(scopeDir, 'w');
    fs.mkdirSync(kDir, { recursive: true });
    fs.mkdirSync(wDir, { recursive: true });
    const put = (d: string, files: Record<string, string>) => { for (const [f, v] of Object.entries(files)) fs.writeFileSync(path.join(d, f), v); };
    put(scopeDir, { 'memory.current': `${2100 * MB}\n`, 'memory.max': `${6400 * MB}\n`, 'memory.events': 'low 0\nhigh 0\nmax 0\noom 0\noom_kill 0\n', 'memory.swap.max': '0\n', 'cgroup.procs': '' });
    put(kDir, { 'cgroup.procs': '700\n' });
    put(wDir, { 'memory.current': `${1500 * MB}\n`, 'memory.max': `${6144 * MB}\n`, 'memory.peak': `${1800 * MB}\n`, 'memory.stat': `inactive_file ${400 * MB}\n`, 'memory.events': 'low 0\nhigh 0\nmax 0\noom 0\noom_kill 0\n', 'cgroup.procs': '' });
    fs.mkdirSync(path.join(proc, '700'), { recursive: true });
    fs.writeFileSync(path.join(proc, '700', 'stat'), `700 (node) S 1 1 1 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 7000 1000000 100\n`);
    fs.writeFileSync(path.join(proc, '700', 'cmdline'), ['node', 'keeper.js', ws].join('\0') + '\0');
    fs.writeFileSync(path.join(proc, '700', 'cgroup'), `0::${kDir.slice(path.join(root, 'cg').length)}\n`);
    fs.writeFileSync(path.join(kdir, `${ws}.pid`), JSON.stringify({ pid: 700 }));
    const mkEnv = (readFile: (p: string) => string) => ({ platform: 'linux', uid, cgroupRoot: path.join(root, 'cg'), procRoot: proc, pageSize: 4096, env: { ORCHESTRA_MEMORY_SCOPE_PREFIX: 'orchestra-ws-' }, readFile, readdir: (p: string) => fs.readdirSync(p), exists: (p: string) => fs.existsSync(p), keeperPidFile: (w: string) => path.join(kdir, `${w}.pid`) });
    const view = (readFile: (p: string) => string) => {
      const env = mkEnv(readFile);
      const deps: MemberMemoryDeps = { now: () => 1, workspaceIds: () => [ws], liveMemberIds: () => [ws], scopes: (w) => memberScopes(w, env), readMemory: (sc) => readScopeMemory(sc, env), listProcs: (sc) => listScopeProcs(sc, null, env), support: () => ({ ok: true }), countScopes: () => 1 };
      return sampleMemberMemory(deps).tracked[0];
    };
    const plain = (p: string) => fs.readFileSync(p, 'utf8');
    const capped = view(plain);
    assert.equal(capped.cap?.hardBytes, 6144 * MB, 'the cap is the WORK leaf\'s number, not the scope\'s 6400 MB backstop');
    assert.equal(capped.capNote, null, 'capped on w ⇒ NEVER « No memory cap applied »');
    fs.rmSync(path.join(wDir, 'memory.max'));
    const absent = view(plain);
    assert.equal(absent.cap, null);
    assert.equal(absent.capNote, 'not-applied', 'w/memory.max absent: no limit can apply ⇒ the note, although the scope itself holds a number');
    fs.writeFileSync(path.join(wDir, 'memory.max'), `${6144 * MB}\n`);
    const denied = view((p) => { if (p === path.join(wDir, 'memory.max')) throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); return plain(p); });
    assert.equal(denied.cap, null, 'unreadable limit ⇒ no bar');
    assert.equal(denied.capNote, null, 'unreadable limit ⇒ NOT claimed as « not applied »');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('P16 (#332 × #323) the producer carries the CAP\'s own current (the work leaf\'s) into the cap view while the member\'s MEM figure stays the scope total', () => {
  __resetMemberMemoryForTests();
  const a = scope('ws-a');
  const { deps } = host({}, { scopes: { 'ws-a': [a] }, mem: { [a.unit]: 2100 * MB }, procs: { [a.unit]: [] }, cap: { [a.unit]: { maxBytes: 6144 * MB, capCurrentBytes: 1500 * MB, workingSetBytes: 1100 * MB, peakBytes: 1800 * MB } } });
  const v = sampleMemberMemory(deps).tracked[0];
  assert.equal(v.cap?.billBytes, 1500 * MB, 'the bar: the tools\' memory.current (what the hard level compares)');
  assert.equal(v.bytes, 2100 * MB, 'the MEM figure: the whole scope');
});

// ─── #343 gap 2: the keeper's reported cap state reaches the reading — for the scope that holds the keeper, matched on the UNIT ─────────────

test('#343 P-cap: capState(wsId) lands on the reading of the scope that HOLDS the keeper and whose unit it names — never on an older generation, never on a mismatching unit; a throwing dep is "unknown"', async () => {
  const { sampleMemberMemory } = await import('./member-memory.ts');
  const scopeA = { unit: 'orchestra-ws-wcap-1aaaaa.scope', gen: '1aaaaa', cgroupDir: '/x/a', keeperPid: null };
  const scopeB = { unit: 'orchestra-ws-wcap-1bbbbb.scope', gen: '1bbbbb', cgroupDir: '/x/b', keeperPid: 4242 };
  const mk = (cap: (id: string) => { unit: string; state: string } | null): Parameters<typeof sampleMemberMemory>[0] => ({
    now: () => 1,
    workspaceIds: () => ['wcap'],
    liveMemberIds: () => ['wcap'],
    scopes: () => [scopeA, scopeB],
    readMemory: () => ({ currentBytes: 1000, maxBytes: 6 * 1024 ** 3, capCurrentBytes: 1000, workingSetBytes: 500, limitApplied: true }),
    listProcs: () => [],
    support: () => ({ ok: true }),
    countScopes: () => 2,
    capState: cap,
  });
  const v = (cap: Parameters<typeof mk>[0]) => sampleMemberMemory(mk(cap)).tracked[0];
  assert.equal(v(() => ({ unit: scopeB.unit, state: 'unprotected' })).capNote, 'unprotected');
  assert.equal(v(() => ({ unit: scopeB.unit, state: 'unprotected' })).cap, null);
  assert.ok(v(() => ({ unit: scopeA.unit, state: 'unprotected' })).cap, 'the state names the OLD generation: the live session is not affected');
  assert.ok(v(() => ({ unit: 'orchestra-ws-other-1ccccc.scope', state: 'unprotected' })).cap, 'a state for another unit is ignored');
  assert.ok(v(() => { throw new Error('boom'); }).cap, 'a throwing capState is unknown, the member is judged on the sysfs alone');
  assert.ok(v(() => null).cap);
});
