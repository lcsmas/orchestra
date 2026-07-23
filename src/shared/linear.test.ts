import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseLinearIssueCandidate,
  parseLinearTicketRef,
  ticketBranchName,
} from './linear.ts';

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

test('parseLinearTicketRef is STRICT where the branch parser is permissive', () => {
  // This is the whole point of a second parser: a branch name is a guess, a
  // typed CLI argument is an assertion. Pinning the wrong issue silently is
  // worse than failing with a usage error.
  assert.equal(parseLinearTicketRef('nmc-261-diagnosis-pictures'), null);
  assert.equal(parseLinearTicketRef('feature/nmc-12-x'), null);
  assert.equal(parseLinearTicketRef('usage-poll-429-backoff'), null);
  // ...whereas the permissive parser happily yields candidates for those.
  assert.equal(parseLinearIssueCandidate('nmc-261-diagnosis-pictures'), 'NMC-261');
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
// ticketBranchName — key-first so the existing badge pipeline recognises it
// ---------------------------------------------------------------------------

test('ticketBranchName leads with the key so the branch badge resolves', () => {
  const branch = ticketBranchName('NMC-305', 'Grade sync misses squash-merged branches');
  // `squash-merged` slugifies to two words, so the 6-word cap lands on
  // "...squash merged branches" exactly.
  assert.equal(branch, 'nmc-305-grade-sync-misses-squash-merged-branches');
  // The round-trip that makes graduation work with zero extra bookkeeping.
  assert.equal(parseLinearIssueCandidate(branch), 'NMC-305');
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
  // Still a valid candidate for the badge pipeline in the degenerate case.
  assert.equal(parseLinearIssueCandidate(ticketBranchName('NMC-7', '')), 'NMC-7');
});

test('ticketBranchName caps the slug length', () => {
  const long = 'one two three four five six seven eight nine ten';
  assert.equal(ticketBranchName('NMC-2', long), 'nmc-2-one-two-three-four-five-six');
  assert.equal(ticketBranchName('NMC-2', long, 2), 'nmc-2-one-two');
});
