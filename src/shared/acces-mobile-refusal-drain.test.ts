// #408: the post-413 close decision table, one assertion per branch and per boundary.
import test from 'node:test';
import assert from 'node:assert/strict';
import { REFUSED_DRAIN_MAX_BYTES, REFUSED_LINGER_MAX_MS, refusedDrainStep } from './acces-mobile-refusal-drain.ts';
import { MOBILE_SEND_MAX_BODY } from './acces-mobile-conversation.ts';

const S = { discardedBytes: 0, requestEnded: false, lingerExpired: false };

test('bounds: the drain is 8× a plain body (the pre-#408 figure), the deadline is seconds not minutes', () => {
  assert.equal(REFUSED_DRAIN_MAX_BYTES, 8 * MOBILE_SEND_MAX_BODY);
  assert.ok(REFUSED_LINGER_MAX_MS >= 2_000 && REFUSED_LINGER_MAX_MS <= 30_000, 'long enough for a slow phone to read the 413, short enough not to hold a socket');
});

test('drain: below the byte bound a still-pushing sender is read and discarded', () => {
  assert.equal(refusedDrainStep(S), 'drain');
  assert.equal(refusedDrainStep({ ...S, discardedBytes: REFUSED_DRAIN_MAX_BYTES - 1 }), 'drain', 'one byte under the bound');
});

test('hold: AT the byte bound reading stops — and nothing is destroyed (the sender can still read the 413)', () => {
  assert.equal(refusedDrainStep({ ...S, discardedBytes: REFUSED_DRAIN_MAX_BYTES }), 'hold', 'exactly at the bound');
  assert.equal(refusedDrainStep({ ...S, discardedBytes: 50 * REFUSED_DRAIN_MAX_BYTES }), 'hold', 'far past it');
  assert.equal(refusedDrainStep({ ...S, discardedBytes: 100, maxBytes: 100 }), 'hold', 'an injected bound is honoured');
  assert.equal(refusedDrainStep({ ...S, discardedBytes: 99, maxBytes: 100 }), 'drain');
});

test('cut: only the deadline destroys, whatever the byte count', () => {
  assert.equal(refusedDrainStep({ ...S, lingerExpired: true }), 'cut');
  assert.equal(refusedDrainStep({ ...S, lingerExpired: true, discardedBytes: REFUSED_DRAIN_MAX_BYTES }), 'cut', 'a held sender is cut at the deadline');
});

test('done: a sender that finished its body is closed cleanly — even if the deadline also fired, even past the byte bound', () => {
  assert.equal(refusedDrainStep({ ...S, requestEnded: true }), 'done');
  assert.equal(refusedDrainStep({ ...S, requestEnded: true, lingerExpired: true }), 'done', 'finished beats expired (no RST for a sender that is done)');
  assert.equal(refusedDrainStep({ ...S, requestEnded: true, discardedBytes: REFUSED_DRAIN_MAX_BYTES }), 'done');
});
