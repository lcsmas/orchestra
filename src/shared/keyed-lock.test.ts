import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createKeyedLock } from './keyed-lock.ts';

const tick = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

test('same key: FIFO and never overlapping — a check-then-act that would race unlocked is atomic under run()', async () => {
  const lock = createKeyedLock();
  const taken = new Set<string>();
  const results: string[] = [];
  // the exact shape of branch allocation: read the free name, yield (the git call), then claim it
  const allocate = async (): Promise<string> => {
    let name = 'impl-race';
    for (let n = 2; taken.has(name); n++) name = `impl-race-${n}`;
    await tick(5);
    taken.add(name);
    return name;
  };
  results.push(...(await Promise.all([1, 2, 3].map(() => lock.run('repo', allocate)))));
  assert.deepEqual(results, ['impl-race', 'impl-race-2', 'impl-race-3']);
  assert.equal(lock.pending(), 0, 'idle ⇒ no key retained');
});

test('control — WITHOUT the lock the same allocator hands the same name to every caller (the instrument can fail)', async () => {
  const taken = new Set<string>();
  const allocate = async (): Promise<string> => {
    let name = 'impl-race';
    for (let n = 2; taken.has(name); n++) name = `impl-race-${n}`;
    await tick(5);
    taken.add(name);
    return name;
  };
  const got = await Promise.all([1, 2, 3].map(() => allocate()));
  assert.deepEqual(got, ['impl-race', 'impl-race', 'impl-race']);
});

test('different keys run in parallel (one repo never blocks another)', async () => {
  const lock = createKeyedLock();
  const order: string[] = [];
  const slow = lock.run('a', async () => { order.push('a-start'); await tick(40); order.push('a-end'); });
  const fast = lock.run('b', async () => { order.push('b-start'); order.push('b-end'); });
  await Promise.all([slow, fast]);
  assert.deepEqual(order, ['a-start', 'b-start', 'b-end', 'a-end']);
});

test('a rejection is the caller\'s alone: the queue behind it still runs, in order, and the key is released', async () => {
  const lock = createKeyedLock();
  const out: string[] = [];
  const first = lock.run('k', async () => { await tick(5); throw new Error('boom'); });
  const second = lock.run('k', async () => { out.push('second'); return 2; });
  const third = lock.run('k', async () => { out.push('third'); return 3; });
  await assert.rejects(first, /boom/);
  assert.deepEqual(await Promise.all([second, third]), [2, 3]);
  assert.deepEqual(out, ['second', 'third']);
  assert.equal(lock.pending(), 0);
});

test('run() returns the value, and a synchronous throw inside fn rejects (does not wedge)', async () => {
  const lock = createKeyedLock();
  assert.equal(await lock.run('k', async () => 41 + 1), 42);
  await assert.rejects(lock.run('k', () => { throw new Error('sync'); }), /sync/);
  assert.equal(await lock.run('k', async () => 'after'), 'after');
});
