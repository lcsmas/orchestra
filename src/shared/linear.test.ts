import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLinearIssueCandidate } from './linear.ts';

test('parseLinearIssueCandidate extracts and upper-cases a candidate key', () => {
  assert.equal(parseLinearIssueCandidate('nmc-261-diagnosis-pictures'), 'NMC-261');
  assert.equal(parseLinearIssueCandidate('mc-2227-foo'), 'MC-2227');
  assert.equal(parseLinearIssueCandidate('NMC-8-bar'), 'NMC-8');
  assert.equal(parseLinearIssueCandidate('NMC-8'), 'NMC-8');
});

test('parseLinearIssueCandidate matches a key inside a path-style branch', () => {
  assert.equal(parseLinearIssueCandidate('feature/nmc-12-x'), 'NMC-12');
  assert.equal(parseLinearIssueCandidate('fix/MC-1'), 'MC-1');
});

test('parseLinearIssueCandidate takes the first occurrence', () => {
  assert.equal(parseLinearIssueCandidate('mc-1-then-nmc-2'), 'MC-1');
});

test('parseLinearIssueCandidate requires a ≥2-letter team and a digit run', () => {
  assert.equal(parseLinearIssueCandidate('v1-2-bump'), null); // single-letter team
  assert.equal(parseLinearIssueCandidate('feature/cleanup'), null); // no digit run
  assert.equal(parseLinearIssueCandidate(''), null);
});

test('parseLinearIssueCandidate keys off whole tokens, not mid-word slices', () => {
  // The team is the whole preceding token — `xnmc` is one token, so the
  // candidate is XNMC-12 (which Linear will then reject). What we must NOT do is
  // slice `nmc-12` out of the middle and wrongly surface a real team's key.
  assert.equal(parseLinearIssueCandidate('xnmc-12'), 'XNMC-12');
  assert.equal(parseLinearIssueCandidate('fooNMC-12'), 'FOONMC-12');
});

test('parseLinearIssueCandidate is permissive — it does NOT decide existence', () => {
  // These yield syntactic candidates; the main-process Linear lookup is what
  // rejects them when no such issue exists. The candidate parser must surface
  // them so they CAN be checked.
  assert.equal(parseLinearIssueCandidate('usage-poll-429-backoff-persist'), 'POLL-429');
  assert.equal(parseLinearIssueCandidate('retry-backoff-3'), 'BACKOFF-3');
});
