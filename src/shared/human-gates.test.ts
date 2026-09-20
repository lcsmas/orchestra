// Unit coverage for the pure human-gate helpers (#161). The lifecycle
// (open → render → resolve → re-wake) is driven end-to-end by the bus + E2E
// gates; this pins the recipient handle and the badge math.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  HUMAN_GATE_RECIPIENT,
  isHumanGateRecipient,
  byOpenedAtAsc,
  formatGateAge,
  isGateOld,
  GATE_OLD_AFTER_MS,
  type HumanGateView,
} from './human-gates.ts';

test('the human recipient handle is the literal "human"', () => {
  // The CLI writes `--to human`; the read keys on this. If they drift, every
  // human gate is invisible. Pinned as a literal so a rename fails loudly.
  assert.equal(HUMAN_GATE_RECIPIENT, 'human');
});

test('isHumanGateRecipient matches ONLY the human handle', () => {
  assert.equal(isHumanGateRecipient('human'), true);
  // A workspace id (uuid) or any other handle is not the human.
  assert.equal(isHumanGateRecipient('2fa8413c-c4a9-400b-b242-62e28281f4e2'), false);
  assert.equal(isHumanGateRecipient('LEAD'), false);
  assert.equal(isHumanGateRecipient(null), false);
  assert.equal(isHumanGateRecipient(undefined), false);
  assert.equal(isHumanGateRecipient(''), false);
});

function gate(id: number, openedAt: number): HumanGateView {
  return {
    id,
    runId: 'r',
    askedBy: 'a',
    askedByWorkspaceId: null,
    askedByLabel: 'a',
    question: 'q',
    openedAt,
  };
}

test('byOpenedAtAsc orders oldest first, breaking ties by id', () => {
  const sorted = [gate(3, 300), gate(1, 100), gate(2, 100)].sort(byOpenedAtAsc);
  assert.deepEqual(sorted.map((g) => g.id), [1, 2, 3]); // 100/id1, 100/id2, 300
});

test('formatGateAge buckets coarsely, never negative, never sub-minute precision', () => {
  assert.equal(formatGateAge(-5000), 'just now'); // clamped, never "-1m"
  assert.equal(formatGateAge(0), 'just now');
  assert.equal(formatGateAge(59_000), 'just now'); // <1min
  assert.equal(formatGateAge(60_000), '1m');
  assert.equal(formatGateAge(22 * 60_000), '22m');
  assert.equal(formatGateAge(60 * 60_000), '1h');
  assert.equal(formatGateAge(90 * 60_000), '1h 30m');
  assert.equal(formatGateAge(120 * 60_000), '2h');
});

test('isGateOld flips exactly at the 15-min threshold', () => {
  assert.equal(GATE_OLD_AFTER_MS, 15 * 60_000);
  assert.equal(isGateOld(GATE_OLD_AFTER_MS - 1), false);
  assert.equal(isGateOld(GATE_OLD_AFTER_MS), true);
  assert.equal(isGateOld(60 * 60_000), true);
});
