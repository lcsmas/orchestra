// Unit coverage for the pending-prompt identity that replaced text matching
// (issue #57 fault a). The end-to-end reproduction — real captured envelope
// through the REAL backfill — lives in scripts/verify-peer-redelivery.mjs;
// these pin the pure contract that fix rests on.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  countConsumedKeys,
  filterUnconsumedPrompts,
  normalizePendingPrompts,
  pendingPromptKey,
} from './pending-prompts.ts';

const envelope = (from: string, id: string, body: string) =>
  `[message from agent '${from}' (${id})]\n${body}\n\nReply with: orchestra message ${id} "<reply>"`;

test('the key survives the backfill stripping the peer envelope (the whole bug)', () => {
  const body = 'stand down and wait for the re-brief';
  // What sdkSend persists vs what the transcript backfill renders.
  const stored = envelope('triage', 'ws-1', body);
  assert.equal(pendingPromptKey({ text: stored }), pendingPromptKey({ text: body }));
});

test('the legacy socket-curl footer is stripped too', () => {
  const body = 'ping';
  const legacy = `[message from agent 'a' (id1)]\n${body}\n\nReply via the orchestra socket: curl -s --unix-socket "$X" http://x/message`;
  assert.equal(pendingPromptKey({ text: legacy }), pendingPromptKey({ text: body }));
});

test('trailing whitespace does not mint a different identity', () => {
  assert.equal(pendingPromptKey({ text: 'hello  ' }), pendingPromptKey({ text: 'hello' }));
  assert.equal(pendingPromptKey({ text: 'a\nb' }), pendingPromptKey({ text: 'a b' }));
});

test('DIFFERENT bodies get different keys (the key discriminates)', () => {
  assert.notEqual(pendingPromptKey({ text: 'do X' }), pendingPromptKey({ text: 'do Y' }));
  // Two senders posting the same body DO share a key — the key matches the
  // TRANSCRIPT, it is not an identity. That is why entries also carry a
  // per-send `id` and why consumption is counted as a MULTISET: the earlier
  // claim here, that a shared key "can only cause an under-delivery if BOTH
  // were lost", was FALSE and was measured to drop a message (review finding
  // F2 — 2 pending, 1 consumed occurrence, 0 recovered). Recorded rather than
  // deleted so the disproved reasoning is not re-derived.
  assert.equal(
    pendingPromptKey({ text: envelope('alpha', 'w1', 'ok') }),
    pendingPromptKey({ text: envelope('beta', 'w2', 'ok') }),
  );
});

test('an empty / missing text keys without throwing', () => {
  assert.equal(typeof pendingPromptKey({}), 'string');
  assert.equal(pendingPromptKey({ text: null }), pendingPromptKey({ text: '' }));
});

test('filterUnconsumedPrompts keeps only what the transcript lacks', () => {
  const a = { id: 'i1', key: pendingPromptKey({ text: 'ran' }), text: 'ran' };
  const b = { id: 'i2', key: pendingPromptKey({ text: 'lost' }), text: 'lost' };
  const consumed = new Set([a.key]);
  assert.deepEqual(filterUnconsumedPrompts([a, b], consumed), [b]);
});

test('a genuinely lost prompt is ALWAYS still recoverable (the anti-drop control)', () => {
  const p = { id: 'i1', key: pendingPromptKey({ text: 'never ran' }), text: 'never ran' };
  assert.deepEqual(filterUnconsumedPrompts([p], new Set()), [p]);
});

// ── MULTIPLICITY (review finding F2) ────────────────────────────────────────
// The suite used to test only SINGLE entries, so it was structurally incapable
// of catching the drop below: N entries sharing a body were all suppressed by
// ONE consumed occurrence. Every case here uses N>1 deliberately.

test('two senders, same body, ONE ran -> the other is still recovered', () => {
  const body = 'ledger updated: re-read the artifact';
  const key = pendingPromptKey({ text: body });
  const two = [
    { id: 'send-ops', key, text: body },
    { id: 'send-lead', key, text: body },
  ];
  const recovered = filterUnconsumedPrompts(two, countConsumedKeys([{ text: body }]));
  assert.equal(recovered.length, 1, 'one consumed occurrence must cancel exactly one entry');
});

test('two senders, same body, BOTH ran -> nothing recovered', () => {
  const body = 'same text';
  const key = pendingPromptKey({ text: body });
  const two = [
    { id: 'a', key, text: body },
    { id: 'b', key, text: body },
  ];
  const consumed = countConsumedKeys([{ text: body }, { text: body }]);
  assert.deepEqual(filterUnconsumedPrompts(two, consumed), []);
});

test('two senders, same body, NEITHER ran -> both recovered', () => {
  const body = 'same text';
  const key = pendingPromptKey({ text: body });
  const two = [
    { id: 'a', key, text: body },
    { id: 'b', key, text: body },
  ];
  assert.equal(filterUnconsumedPrompts(two, countConsumedKeys([])).length, 2);
});

test('the multiset never over-cancels: 3 consumed, 2 pending -> 0 recovered, no throw', () => {
  const body = 'x';
  const key = pendingPromptKey({ text: body });
  const two = [
    { id: 'a', key, text: body },
    { id: 'b', key, text: body },
  ];
  const consumed = countConsumedKeys([{ text: body }, { text: body }, { text: body }]);
  assert.deepEqual(filterUnconsumedPrompts(two, consumed), []);
});

test('a bare Set still means "one occurrence" (back-compat with existing callers)', () => {
  const body = 'y';
  const key = pendingPromptKey({ text: body });
  const two = [
    { id: 'a', key, text: body },
    { id: 'b', key, text: body },
  ];
  assert.equal(filterUnconsumedPrompts(two, new Set([key])).length, 1);
});

test('countConsumedKeys tallies occurrences, and a peer envelope counts as its body', () => {
  const body = 'ping';
  const counts = countConsumedKeys([
    { text: body },
    { text: `[message from agent 'a' (w1)]\n${body}\n\nReply with: orchestra message w1 "<reply>"` },
  ]);
  assert.equal(counts.get(pendingPromptKey({ text: body })), 2);
});

test('entries with DIFFERENT bodies are unaffected by each other counts', () => {
  const a = { id: 'a', key: pendingPromptKey({ text: 'alpha' }), text: 'alpha' };
  const b = { id: 'b', key: pendingPromptKey({ text: 'beta' }), text: 'beta' };
  const recovered = filterUnconsumedPrompts([a, b], countConsumedKeys([{ text: 'alpha' }]));
  assert.deepEqual(recovered.map((p) => p.id), ['b']);
});

test('legacy string[] entries migrate rather than being dropped', () => {
  const got = normalizePendingPrompts(['old prompt']);
  assert.equal(got.length, 1);
  assert.equal(got[0].text, 'old prompt');
  assert.equal(got[0].key, pendingPromptKey({ text: 'old prompt' }));
  assert.ok(got[0].id, 'a migrated entry must still get a per-send id');
});

test('two legacy entries with the SAME body stay distinguishable', () => {
  // They are two real prompts; collapsing them is the F2 drop in another guise.
  const got = normalizePendingPrompts(['dup', 'dup']);
  assert.equal(got.length, 2);
  assert.notEqual(got[0].id, got[1].id, 'ids must be unique per entry');
  assert.equal(got[0].key, got[1].key, 'but the transcript key is shared, by design');
});

test('normalizePendingPrompts is total: junk in, empty out', () => {
  assert.deepEqual(normalizePendingPrompts(undefined), []);
  assert.deepEqual(normalizePendingPrompts(null), []);
  assert.deepEqual(normalizePendingPrompts('nope'), []);
  assert.deepEqual(normalizePendingPrompts([null, 42, {}, '   ']), []);
});

test('normalizePendingPrompts preserves the peer origin so a resend stays tagged', () => {
  const got = normalizePendingPrompts([
    { key: 'k', text: 'hi', peer: { from: 'w1', name: 'alpha' } },
  ]);
  assert.deepEqual(got[0].peer, { from: 'w1', name: 'alpha' });
});

test('a malformed peer field is dropped, not half-carried', () => {
  const got = normalizePendingPrompts([{ key: 'k', text: 'hi', peer: { from: 'w1' } }]);
  assert.equal(got[0].peer, undefined);
});
