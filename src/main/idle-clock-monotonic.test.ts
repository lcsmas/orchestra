// #326-fu m2 — the MONOTONIC idle clock the Reliquat wait is also judged on: stamped beside the wall-clock activity map, immune to a wall-clock jump, floored at the app start, dropped with the workspace.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { noteActivity, noteAppStart, forgetHibernationActivity, getLastActivityMono, monotonicNow, __setMonotonicClockForTests } from './hibernation-activity.ts';
import { idleClockOf, monotonicIdleOf } from './idle-clock.ts';

const WS = 'ws-mono-test';
const MIN = 60_000;

function withClocks(fn: (clock: { mono: number }) => void): void {
  const clock = { mono: 1_000_000 };
  const realNow = Date.now;
  __setMonotonicClockForTests(() => clock.mono);
  try {
    noteAppStart();
    fn(clock);
  } finally {
    Date.now = realNow;
    __setMonotonicClockForTests(null);
    forgetHibernationActivity(WS);
  }
}

test('a stamp is taken on BOTH clocks; the idle time on the monotonic one is the distance from the stamp', () => {
  withClocks((c) => {
    noteActivity(WS);
    assert.equal(getLastActivityMono(WS), 1_000_000);
    assert.equal(monotonicIdleOf(WS), 0);
    c.mono += 5 * MIN;
    assert.equal(monotonicIdleOf(WS), 5 * MIN);
    noteActivity(WS);
    assert.equal(monotonicIdleOf(WS), 0, 'activity resets it');
  });
});

test('a WALL-clock jump (NTP step, resume) moves the wall idle time and leaves the monotonic one alone — the very gap the Reliquat wait must not be fooled by', () => {
  withClocks((c) => {
    noteActivity(WS);
    const wallStamp = idleClockOf({ id: WS });
    const realNow = Date.now;
    c.mono += 20_000;
    Date.now = () => realNow() + 3 * 60 * MIN;
    assert.ok(Date.now() - wallStamp >= 3 * 60 * MIN, 'control: the wall clock says idle 3 h');
    assert.equal(monotonicIdleOf(WS), 20_000, 'the monotonic clock says 20 s');
  });
});

test('never seen this run ⇒ the idle time runs from the app start (the floor), like the wall clock\'s', () => {
  withClocks((c) => {
    c.mono += 7 * MIN;
    assert.equal(monotonicIdleOf('never-seen'), 7 * MIN);
    noteAppStart();
    assert.equal(monotonicIdleOf('never-seen'), 0, 'noteAppStart re-floors it');
  });
});

test('a deleted workspace\'s monotonic stamp is dropped with the rest of its tracking', () => {
  withClocks((c) => {
    noteActivity(WS);
    c.mono += MIN;
    forgetHibernationActivity(WS);
    assert.equal(getLastActivityMono(WS), undefined);
  });
});

test('the default source is the process monotonic clock (performance.now), restored after the seam', () => {
  const a = monotonicNow();
  const b = performance.now();
  assert.ok(Math.abs(b - a) < 1000, `monotonicNow ${a} vs performance.now ${b}`);
});
