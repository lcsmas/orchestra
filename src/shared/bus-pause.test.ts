import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  activePauseInChain,
  pauseGateDecision,
  pauseRefusalMessage,
  type PauseChainLink,
} from './bus-pause.ts';
import { shouldRedriveInbox } from './session-wedge.ts';

// #252 fleet PAUSE — the pure half. Every expectation is a LITERAL (never the constant under test).

test('refusal text is exactly `run en pause — orchestra run resume --run <id>`', () => {
  assert.equal(pauseRefusalMessage('ops-7'), 'run en pause — orchestra run resume --run ops-7');
});

const link = (runId: string, pausedAt: number | null, on: boolean): PauseChainLink => ({
  runId,
  pausedAt,
  pauseSwitchOn: on,
});

test('activePauseInChain: the NEAREST carrier wins; a descendant carries none of its own', () => {
  assert.deepEqual(activePauseInChain([link('child', null, true), link('ops', 50, true), link('lead', 10, true)]), {
    runId: 'ops',
    pausedAt: 50,
  });
  assert.equal(activePauseInChain([link('child', null, true), link('ops', null, true)]), null);
});

test('activePauseInChain: a carrier whose FROZEN pause switch is OFF is not a pause (switch OFF ⇒ inert)', () => {
  assert.equal(activePauseInChain([link('ops', 50, false)]), null);
  // a nearer OFF carrier does not hide a farther ON one
  assert.deepEqual(activePauseInChain([link('child', 5, false), link('ops', 50, true)]), { runId: 'ops', pausedAt: 50 });
});

test('activePauseInChain: paused_at 0 is a real timestamp, not "unset"', () => {
  assert.deepEqual(activePauseInChain([link('ops', 0, true)]), { runId: 'ops', pausedAt: 0 });
});

test('pauseGateDecision: an active pause is refused with the carrier; none = null', () => {
  assert.equal(pauseGateDecision({ runId: 'ops-7' }), 'run en pause — orchestra run resume --run ops-7');
  assert.equal(pauseGateDecision(null), null);
});

test('shouldRedriveInbox: paused blocks the re-drive; absent/false changes nothing (row 23)', () => {
  const base = { queueLen: 0, cleared: false, parkedCount: 1, inFlightCount: 0 };
  assert.equal(shouldRedriveInbox(base), true, 'control: today\'s decision');
  assert.equal(shouldRedriveInbox({ ...base, paused: false }), true);
  assert.equal(shouldRedriveInbox({ ...base, paused: true }), false);
});
