import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_HIBERNATE_AFTER_MS,
  HIBERNATION_DISABLED,
  formatIdleDuration,
  resolveHibernateAfterMs,
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
