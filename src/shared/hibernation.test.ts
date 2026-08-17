import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_HIBERNATE_AFTER_MS,
  DEFAULT_HIBERNATE_SWEEP_MS,
  HIBERNATION_DISABLED,
  formatIdleDuration,
  resolveHibernateAfterMs,
  resolveHibernateSweepMs,
  shouldHibernate,
  type HibernationSignals,
} from './hibernation.ts';
import type { Workspace, WorkspaceStatus } from './types.ts';

let seq = 0;
function ws(over: Partial<Workspace> = {}): Workspace {
  seq += 1;
  return {
    id: over.id ?? `ws-${seq}`,
    name: 'n',
    repoPath: '/repo',
    worktreePath: '/wt',
    branch: over.branch ?? `branch-${seq}`,
    baseBranch: 'main',
    createdAt: seq,
    status: 'idle',
    agent: 'claude',
    ...over,
  } as Workspace;
}

const NOW = 1_000_000_000;
const THRESHOLD = 30 * 60 * 1000;

/** Baseline: every condition satisfied, so each test below flips exactly ONE
 *  field and any `false` it observes is attributable to that field alone. */
function signals(over: Partial<HibernationSignals> = {}): HibernationSignals {
  return {
    now: NOW,
    lastActivityAt: NOW - THRESHOLD - 1000,
    isActive: false,
    hasLivePty: true,
    hasLiveSdk: false,
    hasLiveRunPty: false,
    thresholdMs: THRESHOLD,
    ...over,
  };
}

// --- positive control: the baseline MUST be eligible, else every negative
// assertion below is vacuous (it would pass against a function that always
// returns false).
test('baseline: an idle, inactive, local, long-idle workspace with a live PTY IS eligible', () => {
  assert.equal(shouldHibernate(ws(), signals()), true);
});

test('baseline holds for a live SDK session with no PTY', () => {
  assert.equal(
    shouldHibernate(ws(), signals({ hasLivePty: false, hasLiveSdk: true })),
    true,
  );
});

// --- condition: something must be running
test('nothing live → not eligible (nothing to reclaim)', () => {
  assert.equal(
    shouldHibernate(ws(), signals({ hasLivePty: false, hasLiveSdk: false })),
    false,
  );
});

// --- condition: status must be idle
for (const status of ['running', 'waiting', 'error', 'stopped'] as WorkspaceStatus[]) {
  test(`status "${status}" → not eligible`, () => {
    assert.equal(shouldHibernate(ws({ status }), signals()), false);
  });
}

test('waiting is protected even when idle for days (the human is needed)', () => {
  assert.equal(
    shouldHibernate(
      ws({ status: 'waiting' }),
      signals({ lastActivityAt: NOW - 5 * 24 * 3600_000 }),
    ),
    false,
  );
});

// --- condition: not the active workspace
test('the currently-active workspace is never hibernated', () => {
  assert.equal(shouldHibernate(ws(), signals({ isActive: true })), false);
});

// --- condition: not sandbox-hosted
test('a sandbox-hosted workspace is skipped (remote process, no local RAM)', () => {
  const sandboxed = ws({ host: { kind: 'sandbox', endpoint: 'ws://box:1234' } });
  assert.equal(shouldHibernate(sandboxed, signals()), false);
});

// --- condition: not archived
test('an archived workspace is skipped', () => {
  assert.equal(shouldHibernate(ws({ archived: true }), signals()), false);
});

// --- condition: no live run-script PTY
test('a live run-script PTY blocks hibernation', () => {
  assert.equal(shouldHibernate(ws(), signals({ hasLiveRunPty: true })), false);
});

// --- condition: idle longer than the threshold
test('idle exactly at the threshold IS eligible (>= boundary)', () => {
  assert.equal(
    shouldHibernate(ws(), signals({ lastActivityAt: NOW - THRESHOLD })),
    true,
  );
});

test('idle one ms under the threshold is NOT eligible', () => {
  assert.equal(
    shouldHibernate(ws(), signals({ lastActivityAt: NOW - THRESHOLD + 1 })),
    false,
  );
});

test('recent activity → not eligible', () => {
  assert.equal(shouldHibernate(ws(), signals({ lastActivityAt: NOW - 1000 })), false);
});

test('unknown lastActivityAt declines rather than guessing', () => {
  assert.equal(shouldHibernate(ws(), signals({ lastActivityAt: undefined })), false);
});

// --- condition: threshold sentinel
test('HIBERNATION_DISABLED threshold disables the feature entirely', () => {
  assert.equal(
    shouldHibernate(ws(), signals({ thresholdMs: HIBERNATION_DISABLED })),
    false,
  );
});

test('a nonsensical non-positive threshold never hibernates', () => {
  assert.equal(shouldHibernate(ws(), signals({ thresholdMs: 0 })), false);
  assert.equal(shouldHibernate(ws(), signals({ thresholdMs: -50 })), false);
});

test('a short injected threshold makes a briefly-idle workspace eligible (e2e rig path)', () => {
  assert.equal(
    shouldHibernate(ws(), signals({ thresholdMs: 5000, lastActivityAt: NOW - 6000 })),
    true,
  );
});

// --- resolveHibernateAfterMs
test('unset / empty / garbage / zero env all fall back to the default', () => {
  assert.equal(resolveHibernateAfterMs(undefined), DEFAULT_HIBERNATE_AFTER_MS);
  assert.equal(resolveHibernateAfterMs(''), DEFAULT_HIBERNATE_AFTER_MS);
  assert.equal(resolveHibernateAfterMs('   '), DEFAULT_HIBERNATE_AFTER_MS);
  assert.equal(resolveHibernateAfterMs('soon'), DEFAULT_HIBERNATE_AFTER_MS);
  assert.equal(resolveHibernateAfterMs('0'), DEFAULT_HIBERNATE_AFTER_MS);
  assert.equal(resolveHibernateAfterMs('NaN'), DEFAULT_HIBERNATE_AFTER_MS);
});

test('-1 disables; other negatives are treated as garbage (default)', () => {
  assert.equal(resolveHibernateAfterMs('-1'), HIBERNATION_DISABLED);
  assert.equal(resolveHibernateAfterMs(' -1 '), HIBERNATION_DISABLED);
  assert.equal(resolveHibernateAfterMs('-5000'), DEFAULT_HIBERNATE_AFTER_MS);
});

test('a positive value is used verbatim', () => {
  assert.equal(resolveHibernateAfterMs('5000'), 5000);
  assert.equal(resolveHibernateAfterMs('1'), 1);
});

// --- resolveHibernateSweepMs (the sweep cadence, a SEPARATE knob from the
// idle threshold: a rig needs a short threshold AND a short cadence, or it can
// only observe the sweep by waiting out a real 5-minute timer).
test('sweep cadence: unset / empty / garbage / non-positive fall back to the default', () => {
  assert.equal(resolveHibernateSweepMs(undefined), DEFAULT_HIBERNATE_SWEEP_MS);
  assert.equal(resolveHibernateSweepMs(''), DEFAULT_HIBERNATE_SWEEP_MS);
  assert.equal(resolveHibernateSweepMs('often'), DEFAULT_HIBERNATE_SWEEP_MS);
  assert.equal(resolveHibernateSweepMs('0'), DEFAULT_HIBERNATE_SWEEP_MS);
  assert.equal(resolveHibernateSweepMs('-1'), DEFAULT_HIBERNATE_SWEEP_MS);
});

test('sweep cadence: a positive value is used, floored at 1s so a typo cannot spin', () => {
  assert.equal(resolveHibernateSweepMs('2000'), 2000);
  assert.equal(resolveHibernateSweepMs(' 30000 '), 30000);
  assert.equal(resolveHibernateSweepMs('5'), 1000);
  assert.equal(resolveHibernateSweepMs('1'), 1000);
});

test('sweep cadence has NO disable sentinel — -1 is the threshold knob, not this one', () => {
  // Two kill switches for one feature can disagree; disabling stays the
  // threshold's job. -1 here is just garbage → default.
  assert.equal(resolveHibernateSweepMs('-1'), DEFAULT_HIBERNATE_SWEEP_MS);
  assert.equal(resolveHibernateAfterMs('-1'), HIBERNATION_DISABLED);
});

// --- formatIdleDuration
test('idle duration formats coarsely', () => {
  assert.equal(formatIdleDuration(0), '<1m');
  assert.equal(formatIdleDuration(59_000), '<1m');
  assert.equal(formatIdleDuration(60_000), '1m');
  assert.equal(formatIdleDuration(31 * 60_000), '31m');
  assert.equal(formatIdleDuration(3600_000), '1h');
  assert.equal(formatIdleDuration(3600_000 + 5 * 60_000), '1h 5m');
  assert.equal(formatIdleDuration(-1), '0m');
});

// An unseen finished turn is `idle` (so it passes the status gate) but still
// owes the user a look. Before the three-state split those rows were `waiting`
// and the status check protected them; this asserts the replacement guard, so a
// refactor cannot silently start reaping unread output.
test('an auto-unread workspace is never hibernated', () => {
  assert.equal(shouldHibernate(ws({ autoUnread: true }), signals()), false);
});

test('clearing auto-unread makes it eligible again', () => {
  assert.equal(shouldHibernate(ws({ autoUnread: undefined }), signals()), true);
});

// A /loop's wakeups live inside the session process, so hibernating a looping
// agent silently kills the loop — and its idle phase between wakeups can
// legitimately exceed the threshold (ScheduleWakeup delays reach 60 min).
test('a looping workspace is never hibernated', () => {
  assert.equal(shouldHibernate(ws({ loopingSince: 123 }), signals()), false);
});

test('clearing the loop marker makes it eligible again', () => {
  assert.equal(shouldHibernate(ws({ loopingSince: undefined }), signals()), true);
});
