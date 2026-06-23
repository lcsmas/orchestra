import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLinearIssueKey, linearIssueUrl } from './linear.ts';

test('parseLinearIssueKey extracts and upper-cases the issue key', () => {
  assert.equal(parseLinearIssueKey('nmc-261-diagnosis-pictures'), 'NMC-261');
  assert.equal(parseLinearIssueKey('mc-2227-foo'), 'MC-2227');
  assert.equal(parseLinearIssueKey('NMC-8-bar'), 'NMC-8');
  assert.equal(parseLinearIssueKey('NMC-8'), 'NMC-8');
});

test('parseLinearIssueKey matches the first occurrence', () => {
  assert.equal(parseLinearIssueKey('mc-1-then-nmc-2'), 'MC-1');
});

test('parseLinearIssueKey requires a ≥2-letter alphabetic team and a digit run', () => {
  assert.equal(parseLinearIssueKey('v1-2-bump'), null); // single-letter team
  assert.equal(parseLinearIssueKey('feature/cleanup'), null); // no digit run
  assert.equal(parseLinearIssueKey('release-2024'), 'RELEASE-2024'); // valid team-like
  assert.equal(parseLinearIssueKey(''), null);
});

test('linearIssueUrl builds a mobile-club Linear URL or null', () => {
  assert.equal(
    linearIssueUrl('nmc-261-diagnosis-pictures'),
    'https://linear.app/mobile-club/issue/NMC-261',
  );
  assert.equal(linearIssueUrl('no-issue-here'), null); // no digit run
  assert.equal(linearIssueUrl('feature/cleanup'), null);
});
