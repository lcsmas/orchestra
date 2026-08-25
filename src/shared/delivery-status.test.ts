// Unit coverage for the delivery-status decision table (issue #57 fault b).
// The lifecycle reproduction lives in scripts/verify-peer-delivery-honesty.mjs;
// this pins the rule that makes 'Delivered (live)' honest.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { reportedDeliveryFor, requiresInboxFallback } from './delivery-status.ts';

test('ONLY a started turn is reported live', () => {
  assert.equal(reportedDeliveryFor('started'), 'live');
  for (const attempt of ['dropped', 'timeout', 'none'] as const) {
    assert.notEqual(reportedDeliveryFor(attempt), 'live');
  }
});

test('a discarded turn is reported as inbox, never as delivered', () => {
  assert.equal(reportedDeliveryFor('dropped'), 'inbox');
});

test('an unconfirmed (timed-out) turn is NOT claimed as live', () => {
  // We do not KNOW it ran. Saying 'inbox' may duplicate; saying 'live' may lose.
  // The issue is explicit that duplication is the safe direction.
  assert.equal(reportedDeliveryFor('timeout'), 'inbox');
});

test('no live session means the live path does not apply at all', () => {
  assert.equal(reportedDeliveryFor('none'), null);
});

test('every non-live outcome demands a durable inbox write', () => {
  assert.equal(requiresInboxFallback('dropped'), true);
  assert.equal(requiresInboxFallback('timeout'), true);
  // A started turn must NOT be double-written to the inbox — that would be the
  // duplication half of the ticket, reintroduced by the fix for the other half.
  assert.equal(requiresInboxFallback('started'), false);
  assert.equal(requiresInboxFallback('none'), false);
});

test('report and fallback never disagree (no "inbox" without writing one)', () => {
  for (const attempt of ['started', 'dropped', 'timeout', 'none'] as const) {
    if (reportedDeliveryFor(attempt) === 'inbox') {
      assert.equal(requiresInboxFallback(attempt), true, `${attempt} reports inbox but writes none`);
    }
  }
});
