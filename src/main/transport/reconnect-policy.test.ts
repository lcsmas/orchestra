import { test } from 'node:test';
import assert from 'node:assert/strict';
import { backoffDelayMs, shouldGiveUp, DEFAULT_BACKOFF } from './reconnect-policy.ts';

test('delays grow exponentially from the base', () => {
  assert.equal(backoffDelayMs(0), 1_000);
  assert.equal(backoffDelayMs(1), 2_000);
  assert.equal(backoffDelayMs(2), 4_000);
  assert.equal(backoffDelayMs(4), 16_000);
});

test('delays are capped at maxDelayMs', () => {
  assert.equal(backoffDelayMs(5), 30_000); // 32s raw → capped
  assert.equal(backoffDelayMs(20), 30_000);
});

test('negative attempts clamp to the base delay', () => {
  assert.equal(backoffDelayMs(-3), 1_000);
});

test('custom policies are honored', () => {
  const p = { baseMs: 100, factor: 3, maxDelayMs: 1_000, maxElapsedMs: 5_000 };
  assert.equal(backoffDelayMs(0, p), 100);
  assert.equal(backoffDelayMs(1, p), 300);
  assert.equal(backoffDelayMs(2, p), 900);
  assert.equal(backoffDelayMs(3, p), 1_000); // capped
});

test('gives up only past the elapsed window', () => {
  assert.equal(shouldGiveUp(0), false);
  assert.equal(shouldGiveUp(DEFAULT_BACKOFF.maxElapsedMs), false); // inclusive boundary
  assert.equal(shouldGiveUp(DEFAULT_BACKOFF.maxElapsedMs + 1), true);
});

test('the default ladder retries for the whole window (sanity walk)', () => {
  // Walk the loop's own arithmetic: sum of delays until give-up must land
  // close to (not wildly under) the window, i.e. we keep retrying throughout.
  let elapsed = 0;
  let attempts = 0;
  for (;;) {
    const d = backoffDelayMs(attempts);
    if (shouldGiveUp(elapsed + d)) break;
    elapsed += d;
    attempts++;
  }
  assert.ok(attempts >= 8, `expected sustained retries, got ${attempts}`);
  assert.ok(elapsed <= DEFAULT_BACKOFF.maxElapsedMs, 'never sleeps past the window');
  assert.ok(elapsed >= DEFAULT_BACKOFF.maxElapsedMs - 30_000, 'covers most of the window');
});
