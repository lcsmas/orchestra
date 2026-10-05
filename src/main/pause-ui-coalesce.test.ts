import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCoalescer } from './pause-ui-coalesce.ts';

/** A fake clock: timers fire in time order when `advance` passes them. */
function clock() {
  let t = 0;
  let id = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    now: () => t,
    setTimer: (fn: () => void, ms: number) => { timers.set(++id, { at: t + ms, fn }); return id; },
    clearTimer: (h: unknown) => { timers.delete(h as number); },
    advance(ms: number) {
      const end = t + ms;
      for (;;) {
        const next = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0];
        if (!next || next[1].at > end) break;
        t = next[1].at;
        timers.delete(next[0]);
        next[1].fn();
      }
      t = end;
    },
    pending: () => timers.size,
  };
}

test('one event: ONE push after the debounce (not before)', () => {
  const c = clock();
  const fires: number[] = [];
  const co = createCoalescer(() => fires.push(c.now()), { debounceMs: 150, maxWaitMs: 1000 }, c);
  co.poke();
  c.advance(149);
  assert.deepEqual(fires, []);
  c.advance(2);
  assert.deepEqual(fires, [150]);
  c.advance(5000);
  assert.deepEqual(fires, [150], 'no event ⇒ no further push (nothing self-triggers)');
});

test('SUSTAINED writes (one every 50 ms for 3.5 s): a push lands at least every maxWait — the plain trailing debounce would stay silent for the whole burst', () => {
  const c = clock();
  const fires: number[] = [];
  const co = createCoalescer(() => fires.push(c.now()), { debounceMs: 150, maxWaitMs: 1000 }, c);
  for (let i = 0; i < 70; i++) { co.poke(); c.advance(50); }
  assert.ok(fires.length >= 3, `pushes during the burst: ${JSON.stringify(fires)}`);
  for (let i = 1; i < fires.length; i++) assert.ok(fires[i] - fires[i - 1] <= 1000, `gap ${fires[i] - fires[i - 1]} ms > maxWait`);
  assert.ok(fires[0] <= 1000, `first push within maxWait of the first event: ${fires[0]}`);
});

test('a burst that ENDS: one trailing push after the last event; cancel drops a pending one', () => {
  const c = clock();
  const fires: number[] = [];
  const co = createCoalescer(() => fires.push(c.now()), { debounceMs: 150, maxWaitMs: 1000 }, c);
  co.poke(); c.advance(60); co.poke(); c.advance(60); co.poke();
  c.advance(149);
  assert.equal(fires.length, 0);
  c.advance(2);
  assert.equal(fires.length, 1, 'coalesced into one');
  co.poke();
  co.cancel();
  c.advance(1000);
  assert.equal(fires.length, 1, 'cancelled');
  assert.equal(c.pending(), 0);
});

test('maxWait smaller than the debounce still bounds the wait (never later than pendingSince + maxWait)', () => {
  const c = clock();
  const fires: number[] = [];
  const co = createCoalescer(() => fires.push(c.now()), { debounceMs: 500, maxWaitMs: 200 }, c);
  co.poke(); c.advance(100); co.poke(); c.advance(150);
  assert.deepEqual(fires, [200]);
});
