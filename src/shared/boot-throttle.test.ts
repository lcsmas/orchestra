import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BootThrottle,
  resolveBootThrottleK,
  DEFAULT_BOOT_THROTTLE_K,
} from './boot-throttle.ts';

// A microtask flush: acquire() resolves on the microtask queue, so awaiting this
// lets any synchronously-resolvable acquire settle before we assert.
const flush = () => Promise.resolve();

// ─── resolveBootThrottleK ────────────────────────────────────────────────────

test('resolveBootThrottleK: absent/empty → default', () => {
  assert.equal(resolveBootThrottleK({}), DEFAULT_BOOT_THROTTLE_K);
  assert.equal(resolveBootThrottleK({ ORCHESTRA_BOOT_THROTTLE_K: '' }), DEFAULT_BOOT_THROTTLE_K);
});

test('resolveBootThrottleK: a valid override wins', () => {
  assert.equal(resolveBootThrottleK({ ORCHESTRA_BOOT_THROTTLE_K: '5' }), 5);
  assert.equal(resolveBootThrottleK({ ORCHESTRA_BOOT_THROTTLE_K: '1' }), 1);
});

test('resolveBootThrottleK: garbage / non-positive → default (never 0, which would deadlock)', () => {
  assert.equal(resolveBootThrottleK({ ORCHESTRA_BOOT_THROTTLE_K: 'abc' }), DEFAULT_BOOT_THROTTLE_K);
  assert.equal(resolveBootThrottleK({ ORCHESTRA_BOOT_THROTTLE_K: '0' }), DEFAULT_BOOT_THROTTLE_K);
  assert.equal(resolveBootThrottleK({ ORCHESTRA_BOOT_THROTTLE_K: '-2' }), DEFAULT_BOOT_THROTTLE_K);
});

// ─── single spawn is NEVER delayed (frozen spec) ─────────────────────────────

test('a lone boot acquires synchronously (no other boot in flight)', async () => {
  const t = new BootThrottle(3);
  let acquired = false;
  void t.acquire().then(() => {
    acquired = true;
  });
  await flush();
  // must have resolved on the microtask queue — not parked
  assert.equal(acquired, true, 'a single spawn must not be delayed');
  assert.equal(t.held, 1);
  assert.equal(t.queued, 0);
});

// ─── at most K opening-turn boots in flight; the (K+1)th QUEUES ──────────────
//
// MUST-FAIL arm: on an unthrottled build (or a mutant that lets the K+1th
// through) all K+1 boots are in flight at once and none is queued. This asserts
// the throttle's whole reason to exist.

test('K+1 simultaneous boots: exactly K in flight, the last QUEUES (must-FAIL on no throttle)', async () => {
  const K = 3;
  const t = new BootThrottle(K);
  const slots: Array<{ release(): void } | null> = [];
  for (let i = 0; i < K + 1; i++) {
    void t.acquire().then((s) => {
      slots[i] = s;
    });
    slots[i] = null;
  }
  await flush();
  assert.equal(t.held, K, `exactly K=${K} boots may be in flight at once`);
  assert.equal(t.queued, 1, 'the (K+1)th boot must be parked, not in flight');
  // the 4th slot has NOT resolved yet
  assert.equal(slots[K], null, 'the queued boot has no slot until one releases');
});

// ─── a queued boot starts as soon as one in-flight boot RELEASES (FIFO) ──────

test('releasing a slot admits the oldest waiter, in FIFO order', async () => {
  const K = 2;
  const t = new BootThrottle(K);
  const order: number[] = [];
  const got: Array<{ release(): void }> = [];
  for (let i = 0; i < 5; i++) {
    void t.acquire().then((s) => {
      order.push(i);
      got[i] = s;
    });
  }
  await flush();
  // first K admitted immediately
  assert.deepEqual(order, [0, 1]);
  assert.equal(t.queued, 3);

  // release boot 0 → boot 2 (oldest waiter) admitted
  got[0].release();
  await flush();
  assert.deepEqual(order, [0, 1, 2], 'FIFO: the oldest waiter goes next');
  assert.equal(t.held, K);
  assert.equal(t.queued, 2);

  // release the remaining in-flight ones → 3 then 4
  got[1].release();
  await flush();
  got[2].release();
  await flush();
  assert.deepEqual(order, [0, 1, 2, 3, 4]);
  assert.equal(t.queued, 0);
});

// ─── release is idempotent (first-message AND teardown both fire) ────────────

test('double release frees only ONE slot (first-message + teardown safety)', async () => {
  const K = 1;
  const t = new BootThrottle(K);
  const a = await t.acquire();
  // two more queue behind the single slot
  let bGot = false;
  let cGot = false;
  void t.acquire().then(() => (bGot = true));
  void t.acquire().then(() => (cGot = true));
  await flush();
  assert.equal(t.queued, 2);

  a.release();
  a.release(); // idempotent — must NOT free a second slot
  await flush();
  assert.equal(bGot, true, 'exactly the next waiter is admitted');
  assert.equal(cGot, false, 'a double release must not admit two waiters');
  assert.equal(t.held, 1);
  assert.equal(t.queued, 1);
});

// ─── K=1 fully serializes (the extreme the mutant on the < comparison breaks) ─

test('K=1 serializes boots one at a time', async () => {
  const t = new BootThrottle(1);
  const admitted: number[] = [];
  const got: Array<{ release(): void }> = [];
  for (let i = 0; i < 3; i++) void t.acquire().then((s) => (got[admitted.push(i) - 1] = s));
  await flush();
  assert.deepEqual(admitted, [0], 'only one boot at a time under K=1');
  got[0].release();
  await flush();
  assert.deepEqual(admitted, [0, 1]);
});

// ─── capacity < 1 is refused (would wedge every boot) ────────────────────────

test('capacity below 1 is clamped to 1, never 0 (no self-deadlock)', async () => {
  const t = new BootThrottle(0);
  assert.equal(t.k, 1);
  let acquired = false;
  void t.acquire().then(() => (acquired = true));
  await flush();
  assert.equal(acquired, true, 'a clamped-to-1 throttle still admits the first boot');
});
