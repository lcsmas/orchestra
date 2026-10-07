import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GIB } from './memory-guard.ts';
import { encodePauseAuto, parseAutoHeld, parsePauseAuto } from './pause-auto.ts';
import {
  MEMORY_PAUSE_BY,
  MEMORY_TRAP_WAIT_MAX_MS,
  decideMemoryLift,
  encodeMemoryPause,
  memoryPauseWant,
  parseMemoryPause,
  type MemoryPauseReason,
} from './pause-memory.ts';

// #290 — the pure half of the memory Pause: the stored motive (epoch-bound, no migration) and the LEVEL read of what the guard wants. Named arms are what scripts/pause-memory/mutate-unit.mjs reddens.

const REASON: MemoryPauseReason = { reason: 'memory', pauseCycle: 2, episode: 3, availBytes: 2.5 * GIB, thresholdBytes: 3 * GIB };
const T = 1_800_000_000_000;

test('the host-written marker is its own display string and never the usage-limit one', () => {
  assert.equal(MEMORY_PAUSE_BY, 'host:memory');
});

test('STORED MOTIVE round-trips and is epoch-bound: another epoch, a malformed value, an unknown reason and the usage-limit shape all read as NOT a memory pause', () => {
  const json = encodeMemoryPause(REASON, T);
  assert.deepEqual(parseMemoryPause(json, T), REASON);
  assert.equal(parseMemoryPause(json, T + 1), null, 'a stale column that survived a lift never turns a LATER pause into a memory one');
  assert.equal(parseMemoryPause(json, null), null);
  assert.equal(parseMemoryPause(null, T), null);
  assert.equal(parseMemoryPause('{not json', T), null);
  assert.equal(parseMemoryPause(JSON.stringify({ reason: 'memory', epoch: T }), T), null, 'missing fields ⇒ fail safe: never lift what we cannot prove we paused');
  assert.equal(parseMemoryPause(JSON.stringify({ ...JSON.parse(json), reason: 'oom' }), T), null);
  assert.equal(parseMemoryPause(JSON.stringify({ ...JSON.parse(json), availBytes: 'lots' }), T), null);
  assert.equal(parseMemoryPause(encodePauseAuto({ reason: 'usage_limit', wsIds: ['w1'], accountIds: ['A'] }, T), T), null, 'a usage-limit pause is not a memory pause');
});

test('the usage-limit parser never accepts a memory pause (the quota evaluator must not Reprise it)', () => {
  assert.equal(parsePauseAuto(encodeMemoryPause(REASON, T), T), null);
});

test('HELD: a memory hold round-trips with its motive; a usage-limit hold keeps its original shape (no motive key)', () => {
  const held = { at: T + 5, addressees: ['w1@O'], to: 'L' };
  const json = encodeMemoryPause(REASON, T, held);
  assert.deepEqual(parseAutoHeld(json, T), { ...held, motive: 'memory' });
  assert.equal(parseAutoHeld(json, T + 1), null, 'another epoch');
  const usage = encodePauseAuto({ reason: 'usage_limit', wsIds: ['w1'], accountIds: ['A'] }, T, held);
  assert.deepEqual(parseAutoHeld(usage, T), held);
  assert.equal('motive' in (parseAutoHeld(usage, T) ?? {}), false);
  assert.equal(parseAutoHeld(encodeMemoryPause(REASON, T), T), null, 'no hold recorded');
});

const WANT = (o: Partial<Parameters<typeof memoryPauseWant>[0]>) => memoryPauseWant({ measured: true, availBytes: 4 * GIB, pause: 'none', admissionBytes: 6 * GIB, ...o });

test('WANT (a LEVEL read): held ⇒ impose; none ⇒ lift only strictly ABOVE the Admission threshold; unmeasured ⇒ nothing (unknown ≠ plenty ≠ critical)', () => {
  assert.equal(WANT({ pause: 'held', availBytes: 2 * GIB }), 'impose');
  assert.equal(WANT({ pause: 'none', availBytes: 6 * GIB + 1 }), 'lift');
  assert.equal(WANT({ pause: 'none', availBytes: 6 * GIB }), 'none', 'exactly AT the threshold is not above it');
  assert.equal(WANT({ pause: 'none', availBytes: 4 * GIB }), 'none', 'between critical and Admission: the Pause stays (hysteresis)');
  assert.equal(WANT({ measured: false, pause: 'held' }), 'none');
  assert.equal(WANT({ measured: false, pause: 'none', availBytes: 20 * GIB }), 'none', 'a dead meter never lifts');
  assert.equal(WANT({ availBytes: null, pause: 'held' }), 'none');
  assert.equal(WANT({ pause: 'held', availBytes: 20 * GIB }), 'impose', 'the guard decides the edge: a stale snapshot never lifts by level while it still says held');
});

test('the trap-wait bound is 10 minutes (the usage-limit motive\'s own bound): a frozen fleet is Reprised anyway after it', () => {
  assert.equal(MEMORY_TRAP_WAIT_MAX_MS, 10 * 60_000);
});

test('LIFT decision: waits for an ancestor Pause and for the trap (until it is overdue), otherwise Reprises', () => {
  const base = { pausedAt: T, trapAt: T + 1, ancestorPaused: false, now: T + 60_000 };
  assert.deepEqual(decideMemoryLift(base), { action: 'reprise' });
  assert.deepEqual(decideMemoryLift({ ...base, ancestorPaused: true }), { action: 'wait', why: 'ancestor-paused' });
  assert.deepEqual(decideMemoryLift({ ...base, trapAt: null }), { action: 'wait', why: 'trap-pending' });
  assert.deepEqual(decideMemoryLift({ ...base, trapAt: null, now: T + 10 * 60_000 }), { action: 'reprise' }, 'a trap that never stamps must not freeze the fleet for ever');
  assert.deepEqual(decideMemoryLift({ ...base, trapAt: null, now: T + 10 * 60_000 - 1 }), { action: 'wait', why: 'trap-pending' });
});
