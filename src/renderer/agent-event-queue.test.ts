import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAgentEventQueue, type AgentEventBatch } from './agent-event-queue.ts';
import type { AgentEvent } from '../shared/types.ts';
import { emptySession, foldEvents } from '../shared/agent-events.ts';

/** Deterministic harness: manual frame ticks (no real requestAnimationFrame). */
function makeQueue() {
  const flushes: AgentEventBatch[][] = [];
  let nextId = 1;
  let callbacks = new Map<number, () => void>();
  const q = createAgentEventQueue((batches) => flushes.push(batches), {
    schedule: (cb) => {
      const id = nextId++;
      callbacks.set(id, cb);
      return id;
    },
    cancel: (id) => {
      callbacks.delete(id);
    },
  });
  const tick = () => {
    const batch = callbacks;
    callbacks = new Map();
    for (const cb of batch.values()) cb();
  };
  return { q, flushes, tick, pendingTicks: () => callbacks.size };
}

/** A minimal text-delta event; seq/at just need to be present + ordered. */
function delta(index: number, text: string, seq: number): AgentEvent {
  return { type: 'text-delta', index, text, seq, at: seq };
}

test('nothing is flushed until a frame ticks', () => {
  const { q, flushes } = makeQueue();
  q.push('ws1', delta(0, 'a', 0));
  q.push('ws1', delta(0, 'b', 1));
  assert.equal(flushes.length, 0, 'no synchronous flush');
});

test('a burst within one frame coalesces into a single flush', () => {
  const { q, flushes, tick } = makeQueue();
  q.push('ws1', delta(0, 'a', 0));
  q.push('ws1', delta(0, 'b', 1));
  q.push('ws1', delta(0, 'c', 2));
  tick();
  assert.equal(flushes.length, 1, 'one flush for the frame');
  assert.equal(flushes[0].length, 1, 'one workspace batch');
  assert.equal(flushes[0][0].workspaceId, 'ws1');
  assert.deepEqual(
    flushes[0][0].events.map((e) => (e as { text: string }).text),
    ['a', 'b', 'c'],
    'events preserved in arrival order',
  );
});

test('only one frame is scheduled per idle→busy transition', () => {
  const { q, tick, pendingTicks } = makeQueue();
  q.push('ws1', delta(0, 'a', 0));
  assert.equal(pendingTicks(), 1, 'first push schedules a frame');
  q.push('ws1', delta(0, 'b', 1));
  assert.equal(pendingTicks(), 1, 'second push in same frame does not re-schedule');
  tick();
  assert.equal(pendingTicks(), 0, 'frame consumed, nothing rescheduled while idle');
});

test('events for different workspaces flush in separate ordered batches', () => {
  const { q, flushes, tick } = makeQueue();
  q.push('ws1', delta(0, 'a', 0));
  q.push('ws2', delta(0, 'x', 1));
  q.push('ws1', delta(0, 'b', 2));
  tick();
  assert.equal(flushes.length, 1);
  const batches = flushes[0];
  assert.equal(batches.length, 2, 'two workspace batches');
  // First-seen workspace order is preserved.
  assert.equal(batches[0].workspaceId, 'ws1');
  assert.equal(batches[1].workspaceId, 'ws2');
  assert.deepEqual(
    batches[0].events.map((e) => (e as { text: string }).text),
    ['a', 'b'],
    'ws1 events contiguous and in order',
  );
  assert.deepEqual(
    batches[1].events.map((e) => (e as { text: string }).text),
    ['x'],
  );
});

test('a fresh push after a flush schedules a new frame', () => {
  const { q, flushes, tick, pendingTicks } = makeQueue();
  q.push('ws1', delta(0, 'a', 0));
  tick();
  assert.equal(flushes.length, 1);
  q.push('ws1', delta(0, 'b', 1));
  assert.equal(pendingTicks(), 1, 'new burst re-arms a frame');
  tick();
  assert.equal(flushes.length, 2);
  assert.deepEqual(
    flushes[1][0].events.map((e) => (e as { text: string }).text),
    ['b'],
  );
});

test('flushNow drains synchronously and cancels the scheduled frame', () => {
  const { q, flushes, tick, pendingTicks } = makeQueue();
  q.push('ws1', delta(0, 'a', 0));
  q.flushNow();
  assert.equal(flushes.length, 1, 'flushed immediately');
  assert.equal(pendingTicks(), 0, 'scheduled frame cancelled');
  tick(); // a stray tick must not double-flush
  assert.equal(flushes.length, 1);
});

test('reset drops pending events and cancels the frame', () => {
  const { q, flushes, tick, pendingTicks } = makeQueue();
  q.push('ws1', delta(0, 'a', 0));
  q.reset();
  assert.equal(pendingTicks(), 0, 'frame cancelled');
  tick();
  assert.equal(flushes.length, 0, 'nothing flushed after reset');
});

test('coalesced batch folds identically to per-event folding', () => {
  // The whole point: folding the frame's batch in one foldEvents call must
  // produce the same session as folding each event individually.
  const events: AgentEvent[] = [
    { type: 'session/init', sessionId: 's1', model: 'claude-opus-4-8', cwd: '/w', permissionMode: 'default', tools: ['Bash'], seq: 0, at: 0 },
    { type: 'block-start', index: 0, kind: 'text', seq: 1, at: 1 },
    delta(0, 'Hel', 2),
    delta(0, 'lo', 3),
    { type: 'block-stop', index: 0, seq: 4, at: 4 },
  ];

  const { q, flushes, tick } = makeQueue();
  for (const e of events) q.push('ws1', e);
  tick();

  const batched = foldEvents(emptySession('ws1'), flushes[0][0].events);

  let oneByOne = emptySession('ws1');
  oneByOne = foldEvents(oneByOne, events);

  assert.deepEqual(batched, oneByOne, 'batched fold == sequential fold');
  assert.equal(batched.sessionId, 's1');
  assert.equal(batched.model, 'claude-opus-4-8');
  const text = batched.messages.find((m) => m.role === 'assistant')?.text;
  assert.equal(text, 'Hello', 'text deltas coalesced');
});
