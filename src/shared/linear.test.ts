import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLinearTicketRef, ticketBranchName } from './linear.ts';

// ---------------------------------------------------------------------------
// parseLinearTicketRef — the CLI's strict parser (`orchestra linear add <ref>`)
// ---------------------------------------------------------------------------

test('parseLinearTicketRef accepts a bare identifier, case-insensitively', () => {
  assert.equal(parseLinearTicketRef('NMC-261'), 'NMC-261');
  assert.equal(parseLinearTicketRef('nmc-261'), 'NMC-261');
  assert.equal(parseLinearTicketRef('  nmc-261  '), 'NMC-261');
  assert.equal(parseLinearTicketRef('MC-1'), 'MC-1');
});

test('parseLinearTicketRef accepts a Linear issue URL', () => {
  assert.equal(
    parseLinearTicketRef('https://linear.app/acme/issue/NMC-261/diagnosis-pictures'),
    'NMC-261',
  );
  // No slug, trailing slash, http, and query/fragment all resolve the same.
  assert.equal(parseLinearTicketRef('https://linear.app/acme/issue/NMC-261'), 'NMC-261');
  assert.equal(parseLinearTicketRef('https://linear.app/acme/issue/NMC-261/'), 'NMC-261');
  assert.equal(parseLinearTicketRef('http://linear.app/acme/issue/nmc-261/x'), 'NMC-261');
  assert.equal(parseLinearTicketRef('https://linear.app/acme/issue/NMC-261?foo=1'), 'NMC-261');
});

test('parseLinearTicketRef is STRICT: a branch name is not a ref', () => {
  // A typed CLI argument is an assertion: pinning the wrong issue silently is
  // worse than failing with a usage error.
  assert.equal(parseLinearTicketRef('nmc-261-diagnosis-pictures'), null);
  assert.equal(parseLinearTicketRef('feature/nmc-12-x'), null);
  assert.equal(parseLinearTicketRef('usage-poll-429-backoff'), null);
});

test('parseLinearTicketRef rejects non-Linear hosts and malformed refs', () => {
  assert.equal(parseLinearTicketRef('https://example.com/acme/issue/NMC-261'), null);
  // A lookalike host must not pass — the match is anchored to linear.app.
  assert.equal(parseLinearTicketRef('https://notlinear.app/a/issue/NMC-261'), null);
  assert.equal(parseLinearTicketRef('https://linear.app.evil.com/a/issue/NMC-261'), null);
  assert.equal(parseLinearTicketRef('NMC-'), null);
  assert.equal(parseLinearTicketRef('-261'), null);
  assert.equal(parseLinearTicketRef('N-261'), null); // single-letter team
  assert.equal(parseLinearTicketRef(''), null);
  assert.equal(parseLinearTicketRef('   '), null);
});

test('parseLinearTicketRef accepts a Linear subdomain', () => {
  assert.equal(parseLinearTicketRef('https://www.linear.app/acme/issue/NMC-9/x'), 'NMC-9');
});

// ---------------------------------------------------------------------------
// ticketBranchName — key-first branch names for spawned tickets
// ---------------------------------------------------------------------------

test('ticketBranchName leads with the key', () => {
  const branch = ticketBranchName('NMC-305', 'Grade sync misses squash-merged branches');
  // `squash-merged` slugifies to two words, so the 6-word cap lands on
  // "...squash merged branches" exactly.
  assert.equal(branch, 'nmc-305-grade-sync-misses-squash-merged-branches');
});

test('ticketBranchName slugifies punctuation, case and runs of separators', () => {
  assert.equal(ticketBranchName('MC-1', 'Fix: the "widget" (again)!'), 'mc-1-fix-the-widget-again');
  assert.equal(ticketBranchName('MC-1', '  Spaced   out  '), 'mc-1-spaced-out');
});

test('ticketBranchName is total — any title still yields a usable branch', () => {
  // The caller has no fallback, so these must never return '' or throw.
  assert.equal(ticketBranchName('NMC-7', ''), 'nmc-7');
  assert.equal(ticketBranchName('NMC-7', '   '), 'nmc-7');
  assert.equal(ticketBranchName('NMC-7', '🎉 ✨'), 'nmc-7');
  assert.equal(ticketBranchName('NMC-7', '---'), 'nmc-7');
});

test('ticketBranchName caps the slug length', () => {
  const long = 'one two three four five six seven eight nine ten';
  assert.equal(ticketBranchName('NMC-2', long), 'nmc-2-one-two-three-four-five-six');
  assert.equal(ticketBranchName('NMC-2', long, 2), 'nmc-2-one-two');
});
