import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ROOM_WARN_FRACTION, keeperRoomOf, netKillKey, netKillsForUnit, netRecordOf, type NetKill } from './scope-net.ts';
import { formatMemKillLine, memBusBody, memNoticeText, type KernelOomKill, type MemKillRecord } from './memory-scope.ts';
import { memCapRowOf, memNoticeEntryOf } from './mem-notice.ts';

const SLICE = '/user.slice/user-1000.slice/user@1000.service/app.slice';
const U = 'orchestra-ws-ab12-mv0s5wm6.scope';
const GIB = 1024 ** 3;
const line = (over: Partial<KernelOomKill> & { oom?: string; task?: string }): KernelOomKill => ({
  atMs: 1_000_000,
  pid: 100,
  comm: 'node-22',
  oomMemcg: over.oom ?? `${SLICE}/${U}`,
  taskMemcg: over.task ?? `${SLICE}/${U}/k`,
  ...over,
});

test('#343 N1: a kill whose scope hit its own limit and whose victim lived in the keeper leaf is a BACKSTOP kill', () => {
  const k = netKillsForUnit([line({})], U, 0);
  assert.deepEqual(k, [{ atMs: 1_000_000, pid: 100, comm: 'node-22', leaf: 'k', oomLevel: 'scope' }]);
});

test('#343 N1b: a TOOL killed by the scope-level episode is NOT a net record — the keeper owns every tool-leaf victim (its watch counts `w`) and tags it `scopeLevel`; listing it here too would tell it twice (review M2)', () => {
  assert.deepEqual(netKillsForUnit([line({ comm: 'cargo', task: `${SLICE}/${U}/w` })], U, 0), []);
  const mixed = netKillsForUnit([line({ comm: 'cargo', task: `${SLICE}/${U}/w`, atMs: 10 }), line({ comm: 'claude', atMs: 20, pid: 7 })], U, 0);
  assert.deepEqual(mixed.map((k) => k.comm), ['claude'], 'the tool died first (adj 1000), then the CLI: only the CLI is the session-side victim');
});

test('#343 N1c: the TOOL leaf reaching its own limit is the Plafond doing its job — never a backstop kill (must-FAIL for a classifier that keys on the victim alone)', () => {
  assert.deepEqual(netKillsForUnit([line({ oom: `${SLICE}/${U}/w`, task: `${SLICE}/${U}/w` })], U, 0), []);
});

test('#343 N1d: a keeper leaf that someone limited counts (oom_memcg = <unit>/k)', () => {
  const k = netKillsForUnit([line({ oom: `${SLICE}/${U}/k`, task: `${SLICE}/${U}/k` })], U, 0);
  assert.equal(k.length, 1);
  assert.equal(k[0].oomLevel, 'k');
});

test('#343 N1e: a victim in the scope ROOT is the old flat shape (or the keeper before it moved into k) — NOT the backstop', () => {
  assert.deepEqual(netKillsForUnit([line({ oom: `${SLICE}/${U}`, task: `${SLICE}/${U}` })], U, 0), []);
});

test('#343 N1f: another member\'s scope, a longer unit sharing the prefix, a host-slice OOM and an old line never match', () => {
  const other = 'orchestra-ws-ab12-mv0s5wm7.scope';
  const longer = 'orchestra-ws-ab12-mv0s5wm6.scope.bak';
  assert.deepEqual(netKillsForUnit([line({ oom: `${SLICE}/${other}`, task: `${SLICE}/${other}/k` })], U, 0), []);
  assert.deepEqual(netKillsForUnit([line({ oom: `${SLICE}/${longer}`, task: `${SLICE}/${longer}/k` })], U, 0), []);
  assert.deepEqual(netKillsForUnit([line({ oom: `${SLICE}/${longer}`, task: `${SLICE}/${U}/k` })], U, 0), [], 'the cgroup that hit its limit is compared WHOLE (a unit that merely starts with ours is not ours), whatever the victim\'s path says');
  assert.deepEqual(netKillsForUnit([line({ oom: `${SLICE}`, task: `${SLICE}/${U}/k` })], U, 0), [], 'the slice hit its limit, not our scope');
  assert.deepEqual(netKillsForUnit([line({ atMs: 5 })], U, 10), [], 'older than the scope');
});

test('#343 N1g: oldest first, ties by pid', () => {
  const k = netKillsForUnit([line({ atMs: 30, pid: 3 }), line({ atMs: 10, pid: 9 }), line({ atMs: 10, pid: 2 })], U, 0);
  assert.deepEqual(k.map((x) => `${x.atMs}:${x.pid}`), ['10:2', '10:9', '30:3']);
  assert.equal(netKillKey(k[0]), '10:2');
});

const facts = { unit: U, hardBytes: 6 * GIB, backstopBytes: 7 * GIB };
const nk = (over: Partial<NetKill>): NetKill => ({ atMs: 1000, pid: 7, comm: 'claude', leaf: 'k', oomLevel: 'scope', ...over });

test('#343 N2: ONE record per check — seq/at are the first kernel time, the other victims ride along, the session flag is the reporter\'s', () => {
  assert.equal(netRecordOf([], facts, true), null);
  const r = netRecordOf([nk({ atMs: 2000, pid: 9, comm: 'node-22' }), nk({ atMs: 1000, pid: 7, comm: 'claude' })], facts, true)!;
  assert.equal(r.level, 'net');
  assert.equal(r.seq, 1000);
  assert.equal(r.at, 1000);
  assert.equal(r.source, 'kernel');
  assert.equal(r.command, 'claude');
  assert.deepEqual(r.candidates, ['node-22 (pid 9)']);
  assert.deepEqual(r.net, { backstopBytes: 7 * GIB, sessionEnded: true, victims: [{ pid: 7, comm: 'claude', leaf: 'k' }, { pid: 9, comm: 'node-22', leaf: 'k' }] });
  assert.equal(netRecordOf([nk({})], facts, false)!.net!.sessionEnded, false);
});

test('#343 N3: the words are DISTINCT from a tool kill, name the backstop and the room, and say whether the session ended', () => {
  const ended = netRecordOf([nk({})], facts, true)!;
  const text = memNoticeText(ended);
  assert.match(text, /Scope backstop 7 GB \(tool cap 6 GB \+ 1 GB room\) reached/);
  assert.match(text, /the session ended/);
  assert.match(text, /not a tool kill/);
  assert.match(text, /claude \(pid 7\)/);
  const tool: MemKillRecord = { kind: 'kill', source: 'kernel', seq: 1, at: 1, level: 'hard', command: 'cargo build', pid: 9, rssBytes: 1, candidates: [], unit: U, hardBytes: 6 * GIB };
  assert.notEqual(text, memNoticeText(tool));
  assert.doesNotMatch(memNoticeText(tool), /backstop/i, 'a tool kill never speaks of the backstop');
  const survived = memNoticeText(netRecordOf([nk({ comm: 'rg' })], facts, false)!);
  assert.match(survived, /a process was killed/);
  assert.doesNotMatch(survived, /session ended/);
});

test('#343 N3b: the coordinator\'s message and the app-log line carry workspace, victims, the limit and the session verdict', () => {
  const r = netRecordOf([nk({ pid: 7, comm: 'claude' }), nk({ atMs: 1001, pid: 5, comm: 'node-22' })], facts, true)!;
  const bus = memBusBody('feat-x (ab12)', r);
  assert.match(bus, /workspace feat-x \(ab12\)/);
  assert.match(bus, /SCOPE BACKSTOP kill \(NOT a tool kill\)/);
  assert.match(bus, /7 GB \(tool cap 6 GB \+ 1 GB room\)/);
  assert.match(bus, /claude \(pid 7\), node-22 \(pid 5\)/);
  assert.match(bus, /SESSION ENDED/);
  assert.ok(bus.endsWith(`Scope ${U}.`));
  const logLine = formatMemKillLine('ab12', r);
  assert.match(logLine, /SCOPE BACKSTOP kill/);
  assert.match(logLine, /session ENDED/);
  assert.match(logLine, new RegExp(U.replace(/\./g, '\\.')));
  assert.match(formatMemKillLine('ab12', netRecordOf([nk({})], facts, false)!), /session survived/);
});

test('#343 N3c: a comm is attacker-influenced — bidi controls never reach the sentence, a long one is cut, more than 3 victims fold', () => {
  const r = netRecordOf([nk({ comm: 'a‮b' + 'x'.repeat(100) }), nk({ pid: 8 }), nk({ pid: 9 }), nk({ pid: 10 }), nk({ pid: 11 })], facts, true)!;
  const text = memNoticeText(r);
  assert.doesNotMatch(text, /‮/);
  assert.match(text, /\+2 more/);
  assert.ok(text.length < 400, `bounded: ${text.length}`);
});

test('#343 N3d: the member\'s row is the red « kill » tone with the victims in ONE chip; the persisted entry carries level net and the (unit, seq) identity', () => {
  const r = netRecordOf([nk({})], facts, true)!;
  const row = memCapRowOf(r);
  assert.equal(row.tone, 'hard');
  assert.equal(row.segments[0].kind, 'text');
  assert.equal(row.segments[1].kind, 'chip');
  assert.equal(row.segments[1].text, 'claude (pid 7)');
  const entry = memNoticeEntryOf(r);
  assert.equal(entry.level, 'net');
  assert.equal(`${entry.unit}:${entry.seq}`, `${U}:1000`);
  assert.equal(entry.text, memNoticeText(r), 'the plain text and the row are the same sentence');
});

test('#343 N3e: an unknown backstop is said as « the scope backstop », never as a made-up number', () => {
  const r = netRecordOf([nk({})], { unit: U, hardBytes: null, backstopBytes: null }, true)!;
  assert.match(memNoticeText(r), /^Scope backstop the scope backstop reached/);
  assert.doesNotMatch(memNoticeText(r), /\d GB/);
});

const base = { backstopBytes: 7 * GIB, hardBytes: 6 * GIB, kWorkingSetBytes: 0.4 * GIB, kCurrentBytes: 0.5 * GIB, scopeCurrentBytes: 2 * GIB, kOomKills: 0, scopeEpisodes: 0 };

test('#343 N4: the margin is k\'s WORKING SET against the room a FULL tool leaf leaves (backstop − hard)', () => {
  const m = keeperRoomOf(base)!;
  assert.equal(m.roomBytes, 1 * GIB);
  assert.equal(m.kBytes, 0.4 * GIB);
  assert.equal(m.approx, false);
  assert.equal(m.pct, 40);
  assert.equal(m.tone, 'ok');
  assert.equal(m.freeBytes, 5 * GIB);
  assert.equal(m.netEvents, 0);
});

test('#343 N4b: amber from 70 % of the room, red when k ALONE fills it; the percent is floored', () => {
  assert.equal(ROOM_WARN_FRACTION, 0.7);
  assert.equal(keeperRoomOf({ ...base, kWorkingSetBytes: 0.7 * GIB })!.tone, 'warn');
  assert.equal(keeperRoomOf({ ...base, kWorkingSetBytes: 0.699 * GIB })!.tone, 'ok');
  assert.equal(keeperRoomOf({ ...base, kWorkingSetBytes: 1 * GIB })!.tone, 'crit');
  assert.equal(keeperRoomOf({ ...base, kWorkingSetBytes: 1.3 * GIB })!.tone, 'crit');
  assert.equal(keeperRoomOf({ ...base, kWorkingSetBytes: 0.899 * GIB })!.pct, 89);
});

test('#343 N4c: page cache in k is not counted — the working set wins; without it the raw figure is used and labelled approximate', () => {
  const ws = keeperRoomOf({ ...base, kWorkingSetBytes: 0.2 * GIB, kCurrentBytes: 0.95 * GIB })!;
  assert.equal(ws.kBytes, 0.2 * GIB);
  const raw = keeperRoomOf({ ...base, kWorkingSetBytes: null, kCurrentBytes: 0.95 * GIB })!;
  assert.equal(raw.kBytes, 0.95 * GIB);
  assert.equal(raw.approx, true);
});

test('#343 N4d: no margin is stated without a backstop, without a tool cap, without a k reading, or when the cap is not below the backstop', () => {
  assert.equal(keeperRoomOf({ ...base, backstopBytes: null }), null);
  assert.equal(keeperRoomOf({ ...base, hardBytes: null }), null);
  assert.equal(keeperRoomOf({ ...base, kWorkingSetBytes: null, kCurrentBytes: null }), null);
  assert.equal(keeperRoomOf({ ...base, backstopBytes: 6 * GIB }), null);
  assert.equal(keeperRoomOf({ ...base, scopeCurrentBytes: null })!.freeBytes, null);
});

test('#343 N4e: a kill charged to k or an episode the scope opened is surfaced as net events (the backstop already acted)', () => {
  assert.equal(keeperRoomOf({ ...base, kOomKills: 1 })!.netEvents, 1);
  assert.equal(keeperRoomOf({ ...base, kOomKills: 1, scopeEpisodes: 1 })!.netEvents, 1, 'ONE episode that killed a `k` victim bumps both counters: it is one event, not two');
  assert.equal(keeperRoomOf({ ...base, scopeEpisodes: 3, kOomKills: 2 })!.netEvents, 3, 'three episodes, two of them killed a k victim');
  assert.equal(keeperRoomOf({ ...base, scopeEpisodes: 2, kOomKills: 0 })!.netEvents, 2, 'an episode that killed only a tool still counts');
});
