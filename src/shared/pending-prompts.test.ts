// Unit coverage for the pending-prompt identity that replaced text matching
// (issue #57 fault a). The end-to-end reproduction — real captured envelope
// through the REAL backfill — lives in scripts/verify-peer-redelivery.mjs;
// these pin the pure contract that fix rests on.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
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
  // Same body from two different senders is the SAME prompt text — and both
  // were genuinely delivered, so sharing a key is correct: whichever ran first
  // marks it consumed. The asymmetry the issue wants is duplicate-over-drop,
  // and a shared key can only cause an under-delivery if BOTH were lost, which
  // the transcript would then show neither of.
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
  const a = { key: pendingPromptKey({ text: 'ran' }), text: 'ran' };
  const b = { key: pendingPromptKey({ text: 'lost' }), text: 'lost' };
  const consumed = new Set([a.key]);
  assert.deepEqual(filterUnconsumedPrompts([a, b], consumed), [b]);
});

test('a genuinely lost prompt is ALWAYS still recoverable (the anti-drop control)', () => {
  const p = { key: pendingPromptKey({ text: 'never ran' }), text: 'never ran' };
  assert.deepEqual(filterUnconsumedPrompts([p], new Set()), [p]);
});

test('legacy string[] entries migrate rather than being dropped', () => {
  const got = normalizePendingPrompts(['old prompt']);
  assert.equal(got.length, 1);
  assert.equal(got[0].text, 'old prompt');
  assert.equal(got[0].key, pendingPromptKey({ text: 'old prompt' }));
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
