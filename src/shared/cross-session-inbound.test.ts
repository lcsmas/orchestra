import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ORCHESTRA_CROSS_SESSION_INBOUND,
  withCrossSessionInboundPolicy,
} from './cross-session-inbound.ts';

test('the pinned policy is a non-acting one — never accept', () => {
  // The requirement is "must NOT auto-run a paid turn". 'accept' was MEASURED
  // to auto-run (1 assistant turn, $0.1317, re-emitted init) exactly like the
  // unset default, so pinning it would be a silent no-op that reads as a fix.
  assert.notEqual(ORCHESTRA_CROSS_SESSION_INBOUND, 'accept');
  assert.ok(['hold', 'refuse'].includes(ORCHESTRA_CROSS_SESSION_INBOUND));
});

test('the pinned policy is the least-destructive one that holds', () => {
  // Both hold and refuse suppress the turn; hold preserves the message for
  // review, refuse discards it. The spec prefers hold.
  assert.equal(ORCHESTRA_CROSS_SESSION_INBOUND, 'hold');
});

test('withCrossSessionInboundPolicy stamps the policy onto an empty settings object', () => {
  assert.deepEqual(withCrossSessionInboundPolicy(), { crossSessionInbound: 'hold' });
  assert.deepEqual(withCrossSessionInboundPolicy({}), { crossSessionInbound: 'hold' });
});

test('withCrossSessionInboundPolicy preserves sibling settings', () => {
  // A future caller adding another flag-layer setting must not drop the policy.
  const out = withCrossSessionInboundPolicy({ model: 'claude-sonnet-5' });
  assert.equal(out.model, 'claude-sonnet-5');
  assert.equal(out.crossSessionInbound, 'hold');
});

test('withCrossSessionInboundPolicy wins over a conflicting inbound value in the base', () => {
  // Defence in depth: if anything upstream ever passes its own (stale) policy,
  // Orchestra's pinned one must still be the value that ships.
  const out = withCrossSessionInboundPolicy({ crossSessionInbound: 'accept' });
  assert.equal(out.crossSessionInbound, 'hold');
});

test('withCrossSessionInboundPolicy does not mutate its input', () => {
  const base = { model: 'haiku' };
  withCrossSessionInboundPolicy(base);
  assert.deepEqual(base, { model: 'haiku' }, 'base object was mutated');
});
