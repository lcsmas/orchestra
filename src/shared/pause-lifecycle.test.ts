import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  pausePhaseOf,
  trapOwed,
  memberMayStart,
  pauseRosterSummary,
  type CarrierPauseColumns,
  type PauseMemberRow,
} from './pause-lifecycle.ts';

const none: CarrierPauseColumns = {
  pausedAt: null, mode: null, deadlineAt: null, escalatedAt: null, trapAt: null, resumeStartedAt: null,
};

test('phase: active → pausing (soft, waiting) → paused (escalated or trapped) → resuming', () => {
  assert.equal(pausePhaseOf(none), 'active');
  const soft = { ...none, pausedAt: 1, mode: 'soft' as const, deadlineAt: 180_001 };
  assert.equal(pausePhaseOf(soft), 'pausing');
  assert.equal(pausePhaseOf({ ...soft, escalatedAt: 5 }), 'paused');
  assert.equal(pausePhaseOf({ ...soft, trapAt: 5 }), 'paused');
  assert.equal(pausePhaseOf({ ...none, pausedAt: 1, mode: 'hard' }), 'paused', 'hard never passes through pausing');
  assert.equal(pausePhaseOf({ ...soft, resumeStartedAt: 9 }), 'resuming', 'resume wins over pausing');
});

test('trap owed: hard at once; soft only once escalated; never while resuming or after the stamp', () => {
  assert.equal(trapOwed(none), false);
  assert.equal(trapOwed({ ...none, pausedAt: 1, mode: 'hard' }), true);
  assert.equal(trapOwed({ ...none, pausedAt: 1, mode: null }), true, 'a v9 row (mode NULL) is a hard pause');
  assert.equal(trapOwed({ ...none, pausedAt: 1, mode: 'soft' }), false);
  assert.equal(trapOwed({ ...none, pausedAt: 1, mode: 'soft', escalatedAt: 2 }), true);
  assert.equal(trapOwed({ ...none, pausedAt: 1, mode: 'hard', trapAt: 2 }), false);
  assert.equal(trapOwed({ ...none, pausedAt: 1, mode: 'hard', resumeStartedAt: 2 }), false);
});

test('memberMayStart: only active, or resuming AND released', () => {
  assert.equal(memberMayStart('active', null), true);
  for (const p of ['pausing', 'paused'] as const) assert.equal(memberMayStart(p, { releasedAt: 5 }), false);
  assert.equal(memberMayStart('resuming', { releasedAt: null }), false);
  assert.equal(memberMayStart('resuming', null), false, 'no roster row while resuming = not released');
  assert.equal(memberMayStart('resuming', { releasedAt: 5 }), true);
});

test('roster summary counts pause accusés while pausing/paused and reprise accusés while resuming, naming the missing', () => {
  const row = (ws: string, p: number | null, r: number | null): PauseMemberRow => ({
    runId: 'R', pausedAt: 1, wsId: ws, role: 'worker', memberRun: 'R', pauseConfirmedAt: p,
    pauseConfirmVia: p ? 'member' : null, releasedAt: null, releasedBy: null, repriseConfirmedAt: r,
  });
  const rows = [row('a', 2, null), row('b', null, null), row('c', 3, 4)];
  assert.deepEqual(pauseRosterSummary('pausing', rows), { phase: 'pausing', total: 3, done: 2, missing: ['b'] });
  assert.deepEqual(pauseRosterSummary('resuming', rows), { phase: 'resuming', total: 3, done: 1, missing: ['a', 'b'] });
});
