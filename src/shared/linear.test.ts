import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseLinearIssueCandidate,
  parseLinearTicketRef,
  ticketBranchName,
  normalizePrUrl,
  parsePrUrl,
  prLinkKey,
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

test('normalizePrUrl accepts a canonical GitHub PR URL', () => {
  assert.equal(
    normalizePrUrl('https://github.com/acme/app/pull/12'),
    'https://github.com/acme/app/pull/12',
  );
  assert.equal(normalizePrUrl('  https://github.com/acme/app/pull/12  '),
    'https://github.com/acme/app/pull/12');
});

test('normalizePrUrl strips slug, query and fragment so it matches gh html_url', () => {
  // gh returns the bare .../pull/<n> form; a link copied from the browser
  // usually carries a tab suffix. They must compare equal or the linked PR
  // would never be found in the fetch.
  const want = 'https://github.com/acme/app/pull/12';
  assert.equal(normalizePrUrl('https://github.com/acme/app/pull/12/files'), want);
  assert.equal(normalizePrUrl('https://github.com/acme/app/pull/12/commits'), want);
  assert.equal(normalizePrUrl('https://github.com/acme/app/pull/12?diff=split'), want);
  assert.equal(normalizePrUrl('https://github.com/acme/app/pull/12#discussion_r1'), want);
  assert.equal(normalizePrUrl('https://github.com/acme/app/pull/12/'), want);
});

test('normalizePrUrl canonicalises scheme and www', () => {
  const want = 'https://github.com/acme/app/pull/12';
  assert.equal(normalizePrUrl('http://github.com/acme/app/pull/12'), want);
  assert.equal(normalizePrUrl('https://www.github.com/acme/app/pull/12'), want);
});

test('normalizePrUrl rejects non-PR GitHub URLs', () => {
  // Each of these is something a confused caller might paste; storing any of
  // them would produce a badge that opens the wrong page.
  assert.equal(normalizePrUrl('https://github.com/acme/app/issues/12'), null);
  assert.equal(normalizePrUrl('https://github.com/acme/app/compare/main...x'), null);
  assert.equal(normalizePrUrl('https://github.com/acme/app/tree/some-branch'), null);
  assert.equal(normalizePrUrl('https://github.com/acme/app'), null);
  assert.equal(normalizePrUrl('https://github.com/acme/app/pull/'), null);
  assert.equal(normalizePrUrl('https://github.com/acme/app/pull/abc'), null);
});

test('normalizePrUrl rejects non-GitHub and lookalike hosts', () => {
  assert.equal(normalizePrUrl('https://gitlab.com/acme/app/pull/12'), null);
  assert.equal(normalizePrUrl('https://github.com.evil.test/acme/app/pull/12'), null);
  assert.equal(normalizePrUrl('https://notgithub.com/acme/app/pull/12'), null);
  assert.equal(normalizePrUrl(''), null);
  assert.equal(normalizePrUrl('   '), null);
  assert.equal(normalizePrUrl('nmc-261-some-branch'), null);
});

test('normalizePrUrl requires the URL to BE a PR link, not merely contain one', () => {
  // This is what the leading `^` anchor buys, and nothing else in this file
  // exercises it: the lookalike-host cases above fail on their host shape and
  // pass even with the anchor removed (verified by mutation). A PR URL
  // embedded in another URL — a redirect wrapper, a notification link — is the
  // case that genuinely needs anchoring, since matching it would store a badge
  // pointing at whatever the outer link decides to do.
  assert.equal(normalizePrUrl('https://evil.test/r?to=https://github.com/a/b/pull/9'), null);
  assert.equal(normalizePrUrl('see https://github.com/a/b/pull/9 for details'), null);
});

test('parsePrUrl returns the URL components, not just the canonical URL', () => {
  // The whole point of storing components: polling is a direct
  // `gh api repos/<owner>/<repo>/pulls/<number>` call, so these three must come
  // out of the same parse that canonicalises the URL.
  assert.deepEqual(parsePrUrl('https://github.com/acme/app/pull/12/files'), {
    url: 'https://github.com/acme/app/pull/12',
    owner: 'acme',
    repo: 'app',
    number: 12,
  });
});

test('parsePrUrl yields a numeric number, not a string', () => {
  // Stored in the workspace record and interpolated into a REST path; a string
  // would survive JSON round-tripping and typecheck under `unknown` casts, so
  // assert the conversion explicitly.
  const pr = parsePrUrl('https://github.com/acme/app/pull/7');
  assert.equal(typeof pr?.number, 'number');
  assert.equal(pr?.number, 7);
});

test('parsePrUrl and normalizePrUrl agree on every rejection', () => {
  // normalizePrUrl now delegates to parsePrUrl, so its existing suite covers
  // the parser's accept/reject surface. This pins the delegation itself: if
  // they ever diverge, one of the two callers silently gets a different answer.
  for (const bad of [
    'https://github.com/acme/app/issues/12',
    'https://gitlab.com/acme/app/pull/12',
    'https://evil.test/r?to=https://github.com/a/b/pull/9',
    '',
    '   ',
  ]) {
    assert.equal(parsePrUrl(bad), null, bad);
    assert.equal(normalizePrUrl(bad), null, bad);
  }
});

test('prLinkKey identifies a PR case-insensitively across owner/repo spelling', () => {
  // GitHub owner/repo are case-insensitive, so two agents linking the same PR
  // with different casing must dedupe to one badge rather than two.
  const a = parsePrUrl('https://github.com/Acme/App/pull/12');
  const b = parsePrUrl('https://github.com/acme/app/pull/12');
  assert.equal(prLinkKey(a!), prLinkKey(b!));
  const other = parsePrUrl('https://github.com/acme/app/pull/13');
  assert.notEqual(prLinkKey(a!), prLinkKey(other!));
});

test('prLinkKey separates same-numbered PRs in different repos', () => {
  // The metarepo case: one branch, several submodule repos, each with its own
  // PR #1. Keying on number alone would collapse them into one badge.
  const loop = parsePrUrl('https://github.com/mobile-club/workspace/pull/1');
  const api = parsePrUrl('https://github.com/Next-Mobiles/api/pull/1');
  assert.notEqual(prLinkKey(loop!), prLinkKey(api!));
});
