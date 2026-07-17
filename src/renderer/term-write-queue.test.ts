import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createTermWriteQueue,
  WRITE_BUDGET_BYTES,
  FAST_PATH_BYTES,
  SYNC_HOLD_MS,
} from './term-write-queue.ts';

const OPEN = '\x1b[?2026h';
const CLOSE = '\x1b[?2026l';

/** Deterministic harness: manual frame ticks + manual clock. */
function makeQueue() {
  const writes: string[] = [];
  let time = 0;
  let nextId = 1;
  let callbacks = new Map<number, () => void>();
  const q = createTermWriteQueue((d) => writes.push(d), {
    schedule: (cb) => {
      const id = nextId++;
      callbacks.set(id, cb);
      return id;
    },
    cancel: (id) => {
      callbacks.delete(id);
    },
    now: () => time,
  });
  const tick = () => {
    const batch = callbacks;
    callbacks = new Map();
    for (const cb of batch.values()) cb();
  };
  return {
    q,
    writes,
    tick,
    advance: (ms: number) => {
      time += ms;
    },
    pendingTicks: () => callbacks.size,
  };
}

/** True if `s` contains a ?2026h with no matching ?2026l after it. */
function hasTornFrame(s: string): boolean {
  const open = s.lastIndexOf(OPEN);
  return open !== -1 && s.indexOf(CLOSE, open) === -1;
}

test('small idle chunk is written immediately (fast path)', () => {
  const { q, writes } = makeQueue();
  q.push('hello');
  assert.deepEqual(writes, ['hello']);
});

test('large chunk is frame-paced at the write budget', () => {
  const { q, writes, tick, pendingTicks } = makeQueue();
  const big = 'x'.repeat(WRITE_BUDGET_BYTES * 2 + 10);
  q.push(big);
  assert.equal(writes.length, 0, 'nothing written synchronously');
  tick();
  assert.equal(writes[0].length, WRITE_BUDGET_BYTES);
  tick();
  assert.equal(writes[1].length, WRITE_BUDGET_BYTES);
  tick();
  assert.equal(writes[2].length, 10);
  assert.equal(pendingTicks(), 0, 'drain stops once empty');
  assert.equal(writes.join(''), big, 'no bytes lost or reordered');
});

test('chunks arriving while a drain is scheduled are appended, not interleaved', () => {
  const { q, writes, tick } = makeQueue();
  q.push('a'.repeat(FAST_PATH_BYTES + 1)); // too big for fast path -> scheduled
  q.push('b');
  assert.equal(writes.length, 0);
  tick();
  assert.equal(writes.join(''), 'a'.repeat(FAST_PATH_BYTES + 1) + 'b');
});

test('a complete sync frame passes through untouched', () => {
  const { q, writes } = makeQueue();
  const frame = `${OPEN}redraw${CLOSE}`;
  q.push(`before${frame}after`);
  assert.deepEqual(writes, [`before${frame}after`]);
});

test('an open frame is held until its close arrives, then written atomically', () => {
  const { q, writes, tick } = makeQueue();
  q.push(`prompt>${OPEN}half-a-frame`);
  // Fast path ran: only the text before the open marker may be flushed.
  assert.deepEqual(writes, ['prompt>']);
  tick();
  assert.deepEqual(writes, ['prompt>'], 'frame still held');
  q.push(`rest${CLOSE}tail`);
  tick();
  assert.equal(writes.join(''), `prompt>${OPEN}half-a-frame` + `rest${CLOSE}tail`);
  for (const w of writes) assert.ok(!hasTornFrame(w), `torn frame in ${JSON.stringify(w)}`);
});

test('a held frame is given up after SYNC_HOLD_MS so output cannot stall', () => {
  const { q, writes, tick, advance } = makeQueue();
  q.push(`${OPEN}never-closed`);
  assert.deepEqual(writes, [], 'held');
  tick(); // records heldSince
  advance(SYNC_HOLD_MS + 1);
  tick();
  assert.deepEqual(writes, [`${OPEN}never-closed`]);
});

test('a budget cut inside a frame extends the slice to the close', () => {
  const { q, writes, tick } = makeQueue();
  // Frame straddles the budget boundary: opens just before it, closes after.
  const before = 'x'.repeat(WRITE_BUDGET_BYTES - 4);
  const frame = `${OPEN}${'y'.repeat(100)}${CLOSE}`;
  q.push(before + frame + 'tail');
  tick();
  assert.equal(writes[0], before + frame, 'slice extended past budget to the frame close');
  tick();
  assert.equal(writes[1], 'tail');
});

test('a sync marker split across pushes is never cut through', () => {
  const { q, writes, tick } = makeQueue();
  q.push('log line\x1b[?20'); // marker torn mid-sequence by the IPC boundary
  assert.deepEqual(writes, ['log line'], 'partial marker held back');
  q.push(`26h*erase*${CLOSE}done`);
  tick();
  assert.equal(writes.join(''), `log line${OPEN}*erase*${CLOSE}done`);
  for (const w of writes) assert.ok(!hasTornFrame(w), `torn frame in ${JSON.stringify(w)}`);
});

test('back-to-back frames flush without waiting on each other', () => {
  const { q, writes } = makeQueue();
  const f = (n: number) => `${OPEN}frame${n}${CLOSE}`;
  q.push(f(1) + f(2) + f(3));
  assert.deepEqual(writes, [f(1) + f(2) + f(3)]);
});

test('reset drops buffered output and cancels the drain', () => {
  const { q, writes, tick, pendingTicks } = makeQueue();
  q.push('x'.repeat(WRITE_BUDGET_BYTES * 2));
  q.reset();
  assert.equal(pendingTicks(), 0, 'scheduled drain cancelled');
  tick();
  assert.deepEqual(writes, []);
  q.push('fresh');
  assert.deepEqual(writes, ['fresh'], 'queue usable after reset');
});
