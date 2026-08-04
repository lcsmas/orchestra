import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLinkArgs } from './index.ts';

// Regression: `orchestra link`'s two modes parse the SAME flags differently,
// and getting that wrong fails in the quietest possible way. In CLEAR mode
// `--linear` is a valueless SELECTOR, so parsing it as a value-flag swallows
// the token after it — which is the positional workspace id. The command then
// reports "unknown workspace" and exits 1 while looking perfectly well-formed,
// and only the explicit-id form (a coordinator fixing up a child) is affected,
// so an agent clearing its own links via $ORCHESTRA_WS_ID never sees it.
//
// This shipped once: a refactor hoisted the `--linear` parse out of the
// mode branch, directly under a comment explaining why it must not be. Caught
// by driving the built CLI against a live instance, not by any test — hence
// this file.

test('clear mode: --pr --linear does not swallow the workspace id', () => {
  const r = parseLinkArgs(['--clear', '--pr', '--linear', 'WS-ID']);
  assert.equal(r.error, undefined);
  assert.deepEqual(r.prUrls, [], 'bare --pr means drop ALL PRs');
  assert.equal(r.linearKey, '', 'named-with-no-value marks the field for unset');
  assert.deepEqual(r.rest, ['WS-ID'], 'the id must survive as a positional');
});

test('clear mode: --pr <id-shaped token> is not mistaken for a URL', () => {
  // `link --clear --pr <ID>` is ambiguous by construction: --pr takes an
  // optional value. The id lands in prUrls, which the dispatcher then rejects
  // as a malformed URL rather than silently clearing the wrong thing.
  const r = parseLinkArgs(['--clear', '--pr', 'WS-ID']);
  assert.equal(r.error, undefined);
  assert.deepEqual(r.prUrls, ['WS-ID']);
});

test('clear mode: an explicit URL drops one PR and keeps the id', () => {
  const r = parseLinkArgs(['--clear', '--pr', 'https://github.com/a/b/pull/1', 'WS-ID']);
  assert.deepEqual(r.prUrls, ['https://github.com/a/b/pull/1']);
  assert.deepEqual(r.rest, ['WS-ID']);
});

test('clear mode: --linear alone keeps the id and leaves PRs untouched', () => {
  const r = parseLinkArgs(['--clear', '--linear', 'WS-ID']);
  assert.equal(r.prUrls, undefined, 'PRs must not be cleared when only --linear is named');
  assert.equal(r.linearKey, '');
  assert.deepEqual(r.rest, ['WS-ID']);
});

test('clear mode requires at least one selector', () => {
  assert.match(parseLinkArgs(['--clear']).error ?? '', /--pr and\/or --linear/);
});

test('link mode: --pr repeats and keeps the id positional', () => {
  const r = parseLinkArgs([
    '--pr',
    'https://github.com/a/b/pull/1',
    '--pr',
    'https://github.com/c/d/pull/2',
    'WS-ID',
  ]);
  assert.deepEqual(r.prUrls, ['https://github.com/a/b/pull/1', 'https://github.com/c/d/pull/2']);
  assert.deepEqual(r.rest, ['WS-ID']);
});

test('link mode: --linear takes its value, id still survives', () => {
  const r = parseLinkArgs(['--pr', 'https://github.com/a/b/pull/1', '--linear', 'NMC-1', 'WS-ID']);
  assert.deepEqual(r.prUrls, ['https://github.com/a/b/pull/1']);
  assert.equal(r.linearKey, 'NMC-1');
  assert.deepEqual(r.rest, ['WS-ID']);
});

test('link mode: a valueless --pr is an error, not a silent clear-all', () => {
  // Without --clear, `--pr` with no URL cannot mean "drop all" — treating it as
  // an empty list would send a clear-shaped payload on a link call.
  assert.match(parseLinkArgs(['--pr']).error ?? '', /needs a pull-request URL/);
  assert.match(parseLinkArgs(['--pr', '--linear', 'NMC-1']).error ?? '', /needs a pull-request URL/);
});

test('link mode with nothing to link is an error', () => {
  assert.match(parseLinkArgs([]).error ?? '', /nothing to link/);
  assert.match(parseLinkArgs(['WS-ID']).error ?? '', /nothing to link/);
});
