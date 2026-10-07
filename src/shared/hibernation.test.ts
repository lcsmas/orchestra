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
  idleClockStart,
  fastVeilleLogSuffix,
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
    hasLiveBackgroundTask: false,
    thresholdMs: THRESHOLD,
    admissionHeld: false,
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

// --- the default threshold VALUE (issue #198 D14: 30 min → 5 min). Pinned to
// the literal rather than the constant so a change to the number is caught here
// AND cannot pass silently through the value-agnostic env fallback tests below
// (those compare against DEFAULT_HIBERNATE_AFTER_MS, so both sides move together).
test('the default idle threshold is 5 minutes (D14 resource lever, was 30)', () => {
  assert.equal(DEFAULT_HIBERNATE_AFTER_MS, 5 * 60 * 1000);
});

// A session idle for just over 5 minutes IS now eligible where under the old
// 30-min default it was not — the must-FAIL arm of D14. Uses the resolved
// default (env unset), not the local THRESHOLD constant, so it exercises the
// shipped value end to end through resolveHibernateAfterMs → shouldHibernate.
test('a session idle >5 min hibernates at the default threshold (was: only at 30 min)', () => {
  const thresholdMs = resolveHibernateAfterMs(undefined);
  const sixMinIdle = signals({ thresholdMs, lastActivityAt: NOW - 6 * 60 * 1000 });
  assert.equal(shouldHibernate(ws(), sixMinIdle), true);
  // must-PASS mirror: activity within the 5-min window does NOT hibernate.
  const fourMinIdle = signals({ thresholdMs, lastActivityAt: NOW - 4 * 60 * 1000 });
  assert.equal(shouldHibernate(ws(), fourMinIdle), false);
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
  assert.equal(shouldHibernate(ws({ autoUnread: true, parentId: undefined }), signals()), false);
  assert.equal(shouldHibernate(ws({ autoUnread: undefined }), signals()), true);
});

// A fleet member's bell never clears (its coordinator reads it over the bus), so
// the auto-unread guard must not pin its process (2026-10-07: 27/29 idle members).
test('an auto-unread FLEET MEMBER (parentId set) IS hibernated', () => {
  assert.equal(shouldHibernate(ws({ autoUnread: true, parentId: 'coord-1' }), signals()), true);
});

test('the fleet exemption lifts only the bell: a fleet member is still spared by every other guard', () => {
  const member = { autoUnread: true, parentId: 'coord-1' } as const;
  assert.equal(shouldHibernate(ws({ ...member, status: 'running' }), signals()), false);
  assert.equal(shouldHibernate(ws({ ...member, status: 'waiting' }), signals()), false);
  assert.equal(shouldHibernate(ws({ ...member, loopingSince: 1 }), signals()), false);
  const pending = [{ id: 'p1', text: 'the brief', createdAt: NOW - 3_600_000 }] as never;
  assert.equal(shouldHibernate(ws({ ...member, sdkPendingPrompts: pending }), signals()), false);
  assert.equal(shouldHibernate(ws(member), signals({ isActive: true })), false);
  assert.equal(shouldHibernate(ws(member), signals({ hasLiveBackgroundTask: true })), false);
  assert.equal(shouldHibernate(ws(member), signals({ lastActivityAt: NOW - 1000 })), false);
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

// A `run_in_background` Bash / background Agent keeps working after the turn ends and emits no
// lifecycle event, so idleness alone would reap it at 5 min (#198 D14 F1).
test('a live background task blocks hibernation even when idle for days', () => {
  assert.equal(
    shouldHibernate(ws(), signals({ hasLiveBackgroundTask: true, lastActivityAt: NOW - 5 * 24 * 3600_000 })),
    false,
  );
});

test('clearing the background task makes it eligible again', () => {
  assert.equal(shouldHibernate(ws(), signals({ hasLiveBackgroundTask: false })), true);
});

// --- 2026-09-30: fresh spawns hibernated 1 s after spawn --------------------
// The sweep floored an unseen workspace's idle clock at APP START, so a child spawned
// 2 h after launch read "idle 2h" and slept before its brief was delivered.

test('idleClockStart: an unseen workspace created AFTER app start idles from its creation', () => {
  const appStart = NOW - 2 * 60 * 60 * 1000; // app up for 2 h
  const created = NOW - 1000; // spawned 1 s ago
  assert.equal(idleClockStart(undefined, appStart, created), created);
  // and therefore the rule does NOT fire for it
  assert.equal(
    shouldHibernate(ws({ createdAt: created }), signals({ lastActivityAt: idleClockStart(undefined, appStart, created) })),
    false,
  );
});

test('idleClockStart: an old unseen workspace still floors at app start (no regression)', () => {
  const appStart = NOW - 2 * 60 * 60 * 1000;
  assert.equal(idleClockStart(undefined, appStart, appStart - 10_000), appStart);
});

test('idleClockStart: a seen workspace idles from its last activity', () => {
  assert.equal(idleClockStart(NOW - 5000, NOW - 99_999, NOW - 50_000), NOW - 5000);
});

test('a workspace with a prompt still waiting to be delivered is never hibernated', () => {
  const pending = [{ id: 'p1', text: 'the brief', createdAt: NOW - 3_600_000 }] as never;
  assert.equal(shouldHibernate(ws({ sdkPendingPrompts: pending }), signals({ hasLiveSdk: true })), false);
  // control: same workspace without the pending prompt IS eligible
  assert.equal(shouldHibernate(ws(), signals({ hasLiveSdk: true })), true);
});

test('idleClockStart: a non-finite createdAt or lastSeen is ignored (floors at app start), never NaN', () => {
  const appStart = NOW - 100_000;
  assert.equal(idleClockStart(undefined, appStart, NaN), appStart);
  assert.equal(idleClockStart(undefined, appStart, Infinity), appStart);
  assert.equal(idleClockStart(NaN, appStart, undefined), appStart);
  assert.equal(idleClockStart(NaN, appStart, NOW - 50_000), NOW - 50_000);
  assert.equal(idleClockStart(NOW - 5000, appStart, NaN), NOW - 5000);
});

// --- fast Veille (#288): while Admission is held an idle FLEET member is past its threshold; every other guard still applies.
const FLEET = { parentId: 'coord-1' } as const;
const RECENT = { lastActivityAt: NOW - 60_000, hasLiveSdk: true, hasLivePty: false }; // idle 1 min, far under the 30-min threshold
const HELD = { admissionHeld: true } as const;

test('fast Veille: baseline pair — a fleet member idle 1 min waits with Admission open, goes with it held', () => {
  assert.equal(shouldHibernate(ws(FLEET), signals({ ...RECENT })), false, 'control: open ⇒ still waiting out the threshold');
  assert.equal(shouldHibernate(ws(FLEET), signals({ ...RECENT, ...HELD })), true);
});

test('fast Veille: a workspace without a coordinator is never affected by the hold', () => {
  assert.equal(shouldHibernate(ws(), signals({ ...RECENT, ...HELD })), false);
  assert.equal(shouldHibernate(ws({ parentId: '' }), signals({ ...RECENT, ...HELD })), false);
});

test('fast Veille: the hold changes nothing for an already-eligible workspace, fleet or not (open == held)', () => {
  for (const w of [ws(), ws(FLEET)]) assert.equal(shouldHibernate(w, signals(HELD)), shouldHibernate(w, signals()));
});

test('fast Veille: a just-active fleet member (idle 0 ms) goes too — the idle clock is waived, not shortened', () => {
  assert.equal(shouldHibernate(ws(FLEET), signals({ ...HELD, lastActivityAt: NOW, hasLiveSdk: true, hasLivePty: false })), true);
});

// One test per OTHER guard, each with the positive control that the hold alone makes the fleet member eligible.
const GUARDS: Array<[string, Partial<Workspace>, Partial<HibernationSignals>]> = [
  ['running turn (status running)', { status: 'running' }, {}],
  ['waiting on the human', { status: 'waiting' }, {}],
  ['error status', { status: 'error' }, {}],
  ['stopped', { status: 'stopped' }, {}],
  ['pending prompt (undelivered brief)', { sdkPendingPrompts: [{ id: 'p1', text: 'the brief', createdAt: NOW - 3_600_000 }] as never }, {}],
  ['/loop', { loopingSince: 1 }, {}],
  ['background task', {}, { hasLiveBackgroundTask: true }],
  ['active pane', {}, { isActive: true }],
  ['run-script PTY', {}, { hasLiveRunPty: true }],
  ['sandbox-hosted', { host: { kind: 'sandbox', endpoint: 'ws://box:1234' } }, {}],
  ['archived', { archived: true }, {}],
  ['no live process', {}, { hasLivePty: false, hasLiveSdk: false }],
  ['unknown activity (no opinion)', {}, { lastActivityAt: undefined }],
];
for (const [name, wsOver, sigOver] of GUARDS) {
  test(`fast Veille: the ${name} guard still spares a fleet member while held`, () => {
    assert.equal(shouldHibernate(ws(FLEET), signals({ ...RECENT, ...HELD })), true, 'control: nothing but the hold makes it eligible');
    assert.equal(shouldHibernate(ws({ ...FLEET, ...wsOver }), signals({ ...RECENT, ...HELD, ...sigOver })), false);
  });
}

test('fast Veille: the disabled sentinel stays a kill switch under the hold', () => {
  assert.equal(shouldHibernate(ws(FLEET), signals({ ...RECENT, ...HELD, thresholdMs: HIBERNATION_DISABLED })), false);
  assert.equal(shouldHibernate(ws(FLEET), signals({ ...RECENT, ...HELD, thresholdMs: 0 })), false);
});

test('fast Veille: an auto-unread fleet member goes under the hold (bell kept), an auto-unread top-level never', () => {
  assert.equal(shouldHibernate(ws({ ...FLEET, autoUnread: true }), signals({ ...RECENT, ...HELD })), true);
  assert.equal(shouldHibernate(ws({ autoUnread: true }), signals({ ...RECENT, ...HELD })), false);
});

test('fast Veille log tail: empty with Admission open (byte-identical line), whatever the snapshot says', () => {
  assert.equal(fastVeilleLogSuffix(false, { availBytes: 4 * 1024 ** 3, measured: true }, true, THRESHOLD), '');
  assert.equal(fastVeilleLogSuffix(false, { availBytes: null, measured: false }, false, THRESHOLD), '');
});

test('fast Veille log tail: under the hold it names MemAvailable (2 decimals) and marks an EARLY Veille only when the hold made the difference', () => {
  const gb = (n: number) => Math.round(n * 1024 ** 3);
  assert.equal(
    fastVeilleLogSuffix(true, { availBytes: gb(4.123), measured: true }, true, 5 * 60 * 1000),
    ' — Admission HELD, MemAvailable 4.12 GB, fast Veille (idle below the 5m threshold)',
  );
  assert.equal(fastVeilleLogSuffix(true, { availBytes: gb(4), measured: true }, false, 5 * 60 * 1000), ' — Admission HELD, MemAvailable 4.00 GB');
});

test('fast Veille log tail: an unreadable meter is said so — never a fabricated figure', () => {
  assert.equal(fastVeilleLogSuffix(true, { availBytes: null, measured: false }, false, THRESHOLD), ' — Admission HELD, MemAvailable unknown');
  assert.equal(
    fastVeilleLogSuffix(true, { availBytes: 3 * 1024 ** 3, measured: false }, false, THRESHOLD),
    ' — Admission HELD, MemAvailable 3.00 GB (last good reading)',
  );
});
