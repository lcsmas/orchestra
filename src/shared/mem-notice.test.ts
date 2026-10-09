import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_MEM_NOTICES, addMemNotice, interleaveMemNotices, makeMemNotice, memNoticeEntryOf, memNoticeKey } from './mem-notice.ts';
import type { MemKillRecord, MemSoftRecord } from './memory-scope.ts';
import type { AgentEvent } from './types.ts';

const kill: MemKillRecord = { kind: 'kill', source: 'kernel', seq: 4, at: 1_000, level: 'hard', command: 'cargo build', pid: 9, rssBytes: 1, candidates: [], unit: 'u.scope', hardBytes: 6 * 1024 ** 3 };
const soft: MemSoftRecord = { kind: 'soft', seq: 5, at: 2_000, unit: 'u.scope', bytes: 3.2 * 1024 ** 3, softBytes: 3 * 1024 ** 3, hardBytes: 6 * 1024 ** 3 };
const ev = (seq: number, at: number): AgentEvent => ({ type: 'notice', kind: 'info', text: `e${seq}`, seq, at });

test('#322: the entry carries the row text, the level and the (unit, seq) identity', () => {
  assert.deepEqual(memNoticeEntryOf(kill), { unit: 'u.scope', seq: 4, at: 1_000, level: 'hard', text: 'Command cargo build killed: Plafond mémoire 6 GB reached' });
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
