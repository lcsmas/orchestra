import test from 'node:test';
import assert from 'node:assert/strict';
import { owesOpeningTask, startKeepsFailing, restartOwesOpeningTask, START_FAIL_STREAK, START_FAIL_WINDOW_MS } from './opening-task.ts';

// #227 — "is this workspace still owed its opening task?" decides whether Restart RETRIES a child whose SDK start failed
// (deliver the retained task) or resumes normally. Every clause is asserted alone against literals, never the constant.

test('a kept child whose SDK start failed owes its task (task retained, nothing delivered, no session ever ran)', () => {
  assert.equal(owesOpeningTask({ lastTask: 'implement X' }), true);
  assert.equal(owesOpeningTask({ lastTask: 'implement X', hasInput: false }), true);
});

test('a task an agent already received is NOT owed again — this is what makes Restart deliver the brief exactly once', () => {
  assert.equal(owesOpeningTask({ lastTask: 'implement X', hasInput: true }), false);
});

test('a brief the CLI already received (openingTaskDelivered) is not owed even with no session id and no hasInput — the marker alone retires it', () => {
  assert.equal(owesOpeningTask({ lastTask: 'implement X', openingTaskDelivered: true }), false);
  assert.equal(owesOpeningTask({ lastTask: 'implement X', openingTaskDelivered: false }), true);
});

test('a workspace an SDK session ever ran for is not owed (a real session id, or the cleared marker)', () => {
  assert.equal(owesOpeningTask({ lastTask: 'implement X', sdkSessionId: 'sess-1' }), false);
  assert.equal(owesOpeningTask({ lastTask: 'implement X', sdkSessionId: '' }), false, "'' is sdkClear's marker: a session existed");
});

test('no task, a blank task, or an archived workspace owes nothing', () => {
  assert.equal(owesOpeningTask({}), false);
  assert.equal(owesOpeningTask({ lastTask: '' }), false);
  assert.equal(owesOpeningTask({ lastTask: '   \n' }), false);
  assert.equal(owesOpeningTask({ lastTask: 'implement X', archived: true }), false);
});

test('startKeepsFailing (F7): a kept child that owes its brief AND already failed a start is not passively re-woken; each half alone is not enough', () => {
  const err = [{ at: 1, message: 'boom' }];
  assert.equal(startKeepsFailing({ lastTask: 'implement X', sdkStartErrors: err }), true);
  assert.equal(startKeepsFailing({ lastTask: 'implement X' }), false, 'owed but never failed: an ordinary kept child stays wakeable');
  assert.equal(startKeepsFailing({ lastTask: 'implement X', sdkStartErrors: [] }), false);
  assert.equal(startKeepsFailing({ lastTask: 'implement X', sdkStartErrors: err, hasInput: true }), false, 'nothing owed (the brief landed): wakeable again');
  assert.equal(startKeepsFailing({ lastTask: 'implement X', sdkStartErrors: err, openingTaskDelivered: true }), false);
  assert.equal(startKeepsFailing({ sdkStartErrors: err }), false, 'no task, nothing owed');
});

const NOW = 1_800_000_000_000;
const MIN = 60_000;

test('startKeepsFailing (F4): the same start error START_FAIL_STREAK times in a row blocks passive wakes EVEN for a child that ran once (owes nothing)', () => {
  const ran = { lastTask: 'implement X', sdkSessionId: 'sess-1' };   // owes nothing: it ran
  const same = (n: number) => Array.from({ length: n }, (_, i) => ({ at: NOW - (n - i) * MIN, message: "Couldn't start the agent: worktree gone" }));
  assert.equal(START_FAIL_STREAK, 3);
  assert.equal(startKeepsFailing({ ...ran, sdkStartErrors: same(2) }, false, NOW), false, 'two is not a streak');
  assert.equal(startKeepsFailing({ ...ran, sdkStartErrors: same(3) }, false, NOW), true);
  assert.equal(startKeepsFailing({ ...ran, sdkStartErrors: same(5) }, false, NOW), true);
  const mixed = [{ at: NOW - 3 * MIN, message: 'A' }, { at: NOW - 2 * MIN, message: 'B' }, { at: NOW - MIN, message: 'A' }];
  assert.equal(startKeepsFailing({ ...ran, sdkStartErrors: mixed }, false, NOW), false, 'three DIFFERENT errors are not the same failure');
  assert.equal(startKeepsFailing({ ...ran, sdkStartErrors: [...mixed, { at: NOW - 30_000, message: 'A' }, { at: NOW - 10_000, message: 'A' }] }, false, NOW), true, 'the LAST three decide');
});

test('startKeepsFailing (r4 F3): the streak decays — failures older than START_FAIL_WINDOW_MS no longer count, so a transient cause stops blocking wakes', () => {
  const ran = { lastTask: 'implement X', sdkSessionId: 'sess-1' };
  assert.equal(START_FAIL_WINDOW_MS, 10 * MIN);
  const at = (agoMin: number) => NOW - agoMin * MIN;
  const three = (a: number, b: number, c: number) => [a, b, c].map((m) => ({ at: at(m), message: 'EMFILE' }));
  assert.equal(startKeepsFailing({ ...ran, sdkStartErrors: three(3, 2, 1) }, false, NOW), true, 'fresh ×3 blocks');
  assert.equal(startKeepsFailing({ ...ran, sdkStartErrors: three(30, 20, 11) }, false, NOW), false, 'the same ×3, all older than the window: wakeable again');
  assert.equal(startKeepsFailing({ ...ran, sdkStartErrors: three(30, 2, 1) }, false, NOW), false, 'only 2 inside the window: not a streak');
  assert.equal(startKeepsFailing({ ...ran, sdkStartErrors: three(10, 5, 1) }, false, NOW), true, 'the window edge (10 min) still counts');
  const owed = { lastTask: 'implement X', sdkStartErrors: [{ at: at(120), message: 'old' }] };
  assert.equal(startKeepsFailing(owed, false, NOW), true, 'the owed-brief rule does not decay: a kept child whose FIRST start failed waits for Restart / a direct message');
});

test('startKeepsFailing (F2): a LIVE session is never blocked, whatever its error history says', () => {
  const err = [{ at: NOW - MIN, message: 'boom' }];
  assert.equal(startKeepsFailing({ lastTask: 'implement X', sdkStartErrors: err }, false, NOW), true);
  assert.equal(startKeepsFailing({ lastTask: 'implement X', sdkStartErrors: err }, true, NOW), false);
  const ran = { lastTask: 'x', sdkSessionId: 's', sdkStartErrors: [3, 2, 1].map((m) => ({ at: NOW - m * MIN, message: 'same' })) };
  assert.equal(startKeepsFailing(ran, false, NOW), true);
  assert.equal(startKeepsFailing(ran, true, NOW), false);
});

test('restartOwesOpeningTask (r4 F2): stopped+owed retries; a LIVE session only when ITS OWN first turn failed — a hung/slow second start restarts normally', () => {
  const err = [{ at: 1, message: 'stale first failure' }];   // a STALE persisted error must not disarm a Restart of a live hung start
  const idle = { ptyLive: false, sdkLive: false }, live = { ptyLive: false, sdkLive: true };
  assert.equal(restartOwesOpeningTask({ lastTask: 'x' }, idle), true, 'a stopped kept child');
  assert.equal(restartOwesOpeningTask({ lastTask: 'x' }, live), false, 'a live session still on its first turn restarts normally');
  assert.equal(restartOwesOpeningTask({ lastTask: 'x', sdkStartErrors: err }, live), false, 'live + a stale persisted error is NOT the owed route (r4 F2)');
  assert.equal(restartOwesOpeningTask({ lastTask: 'x', sdkStartErrors: err }, { ...live, sdkFailed: true }), true, 'live but ITS first turn errored: retry, deliver once');
  assert.equal(restartOwesOpeningTask({ lastTask: 'x' }, { ptyLive: true, sdkLive: true, sdkFailed: true }), false, 'a live PTY is never the owed route');
  assert.equal(restartOwesOpeningTask({ lastTask: 'x', hasInput: true }, { ...live, sdkFailed: true }), false, 'nothing owed');
  assert.equal(restartOwesOpeningTask({}, idle), false, 'no task');
});
