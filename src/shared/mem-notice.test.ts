import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_CHIP_CHARS, MAX_MEM_NOTICES, addMemNotice, interleaveMemNotices, makeMemNotice, memCapRowOf, memNoticeEntryOf, memNoticeKey, rowOfEntry } from './mem-notice.ts';
import type { MemKillRecord, MemSoftRecord } from './memory-scope.ts';
import type { AgentEvent } from './types.ts';

const kill: MemKillRecord = { kind: 'kill', source: 'kernel', seq: 4, at: 1_000, level: 'hard', command: 'cargo build', pid: 9, rssBytes: 1, candidates: [], unit: 'u.scope', hardBytes: 6 * 1024 ** 3 };
const soft: MemSoftRecord = { kind: 'soft', seq: 5, at: 2_000, unit: 'u.scope', bytes: 3.2 * 1024 ** 3, softBytes: 3 * 1024 ** 3, hardBytes: 6 * 1024 ** 3 };
const ev = (seq: number, at: number): AgentEvent => ({ type: 'notice', kind: 'info', text: `e${seq}`, seq, at });

test('#322: the entry carries the row text, the level and the (unit, seq) identity', () => {
  const entry = memNoticeEntryOf(kill);
  assert.deepEqual({ ...entry, row: undefined }, { unit: 'u.scope', seq: 4, at: 1_000, level: 'hard', text: 'Command cargo build killed: Plafond mémoire 6 GB reached', row: undefined });
  assert.deepEqual(entry.row, memCapRowOf(kill), 'the structured row is built ONCE, with the entry');
  assert.equal(memNoticeEntryOf(soft).level, 'soft');
  assert.equal(memNoticeKey(memNoticeEntryOf(soft)), 'u.scope:5');
});

test('#322: a record delivered twice is stored ONCE; the list is capped, oldest dropped', () => {
  const a = memNoticeEntryOf(kill);
  const one = addMemNotice(undefined, a)!;
  assert.equal(addMemNotice(one, { ...a })?.length ?? null, null, 're-delivery ⇒ null (nothing to persist)');
  let list = one;
  for (let i = 0; i < MAX_MEM_NOTICES + 5; i++) list = addMemNotice(list, { ...a, seq: 100 + i })!;
  assert.equal(list.length, MAX_MEM_NOTICES);
  assert.equal(list[list.length - 1].seq, 100 + MAX_MEM_NOTICES + 4, 'newest last');
  assert.ok(!list.some((e) => e.seq === 4), 'oldest dropped');
});

test('#322: live == backfill — the same entry builds the same row (text, kind, at) whichever path asks', () => {
  const e = memNoticeEntryOf(kill);
  const live = makeMemNotice({ seq: 10 }, e);
  const back = interleaveMemNotices([], [e], { seq: 1_000_000 })[0];
  assert.deepEqual({ type: live.type, kind: live.kind, text: live.text, at: live.at }, { type: back.type, kind: (back as typeof live).kind, text: (back as typeof live).text, at: back.at });
  assert.equal(live.at, 1_000, 'the row sits at the instant of the kill, not at reload time');
});

test('#322: backfill interleave — rows land between the events they happened between; others keep their order; late rows go last', () => {
  const events = [ev(1, 500), ev(2, 1_500), ev(3, 3_000)];
  const out = interleaveMemNotices(events, [memNoticeEntryOf(soft), memNoticeEntryOf(kill)], { seq: 900 });
  assert.deepEqual(out.map((o) => (o as { text?: string }).text?.slice(0, 7)), ['e1', 'Command', 'e2', 'Working', 'e3']);
  assert.deepEqual(events.map((e) => e.seq), [1, 2, 3], 'the input is not mutated');
  const tail = interleaveMemNotices([ev(1, 10)], [memNoticeEntryOf(kill)], { seq: 900 });
  assert.equal((tail[1] as { text?: string }).text?.startsWith('Command'), true, 'after the last event');
  assert.equal(interleaveMemNotices(events, [], { seq: 900 }), events, 'no rows ⇒ the same array');
});

// ── #322 (D-Q7 B): the dedicated Plafond mémoire row as data ──
const txt = (r: ReturnType<typeof memCapRowOf>): string => r.segments.map((x) => (x.kind === 'chip' ? `[${x.text}]` : x.text)).join(' ');

test('R1 (#322 B) a command NAMED by the kernel: red, « Command [cmd] killed — 6 GB reached », the command in a chip', () => {
  const r = memCapRowOf(kill);
  assert.equal(r.tone, 'hard');
  assert.equal(txt(r), 'Command [cargo build] killed — 6 GB reached');
  assert.deepEqual(r.segments.map((x) => x.kind), ['text', 'chip', 'text']);
});

test('R2 (#322 B) an INFERRED victim says so (« probably »), never as certain; one too brief to be named has no chip', () => {
  assert.equal(txt(memCapRowOf({ ...kill, source: 'inferred' })), 'A command was killed — 6 GB reached · probably [cargo build]');
  assert.equal(txt(memCapRowOf({ ...kill, source: undefined })), 'A command was killed — 6 GB reached · probably [cargo build]', 'an older keeper (no source) = inferred');
  const none = memCapRowOf({ ...kill, command: null });
  assert.equal(txt(none), 'A command was killed — 6 GB reached (it lived too briefly to be named)');
  assert.ok(!none.segments.some((x) => x.kind === 'chip'));
});

test('R3 (#322 B) an OOM from OUTSIDE the scope limit is not blamed on the Plafond; the member\'s own agent process / keeper adds that the SESSION ended', () => {
  assert.equal(txt(memCapRowOf({ ...kill, level: 'external' })), 'Command [cargo build] killed by the system under memory pressure (not by the Plafond mémoire)');
  assert.match(txt(memCapRowOf({ ...kill, role: 'cli' })), /— the member's own agent process: the session ended$/);
  assert.match(txt(memCapRowOf({ ...kill, role: 'keeper' })), /— the member's own keeper: the session ended$/);
  assert.equal(memCapRowOf({ ...kill, level: 'external' }).tone, 'hard', 'a killed command is red whatever killed it');
});

test('R4 (#322 B) the warning level: amber, working set + level + hard cap, no command chip, nothing killed', () => {
  const r = memCapRowOf(soft);
  assert.equal(r.tone, 'soft');
  assert.equal(txt(r), 'Working set 3.2 GB — warning level 3 GB crossed (hard cap 6 GB)');
  assert.equal(txt(memCapRowOf({ ...soft, hardBytes: null })), 'Working set 3.2 GB — warning level 3 GB crossed');
  assert.ok(!r.segments.some((x) => x.kind === 'chip'));
});

test('R5 (#322 B) a long command is cut for the chip (the full text stays in the tooltip text); a short one is untouched', () => {
  const long = 'x'.repeat(MAX_CHIP_CHARS + 30);
  const chip = memCapRowOf({ ...kill, command: long }).segments.find((x) => x.kind === 'chip')!;
  assert.equal(chip.text.length, MAX_CHIP_CHARS);
  assert.ok(chip.text.endsWith('…'));
  assert.equal(memCapRowOf(kill).segments.find((x) => x.kind === 'chip')!.text, 'cargo build');
});

test('R6 (#322 B) the notice is the dedicated kind, carries the structured row, and live == backfill (same kind, row, text, at)', () => {
  const e = memNoticeEntryOf(kill);
  const live = makeMemNotice({ seq: 10 }, e);
  const back = interleaveMemNotices([], [e], { seq: 1_000_000 })[0] as typeof live;
  assert.equal(live.kind, 'memory-cap', 'no longer the generic Warning row');
  assert.deepEqual(live.memCap, memCapRowOf(kill));
  assert.deepEqual({ kind: back.kind, memCap: back.memCap, text: back.text, at: back.at }, { kind: live.kind, memCap: live.memCap, text: live.text, at: live.at });
});

test('R7 (#322 B) an entry persisted BEFORE the dedicated row (no `row`) still renders: one text segment, tone by level', () => {
  const legacy = { unit: 'u.scope', seq: 1, at: 5, level: 'hard' as const, text: 'Command cargo build killed: Plafond mémoire 6 GB reached' };
  assert.deepEqual(rowOfEntry(legacy), { tone: 'hard', segments: [{ kind: 'text', text: legacy.text }] });
  assert.equal(rowOfEntry({ ...legacy, level: 'soft', text: 'Working set 3.2 GB' }).tone, 'soft');
  assert.equal(rowOfEntry({ ...legacy, level: 'external' }).tone, 'hard');
  assert.equal(makeMemNotice({ seq: 1 }, legacy).kind, 'memory-cap');
});

test('R8 (#322 B) the row is JSON-safe (it is persisted in the store with the entry)', () => {
  const e = memNoticeEntryOf({ ...kill, source: 'inferred' });
  assert.deepEqual(JSON.parse(JSON.stringify(e)), e);
});
