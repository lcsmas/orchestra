import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeStatusText, STATUS_TEXT_MAX_CHARS } from './status-text.ts';

test('trims and passes through a plain note', () => {
  assert.equal(sanitizeStatusText('  wiring the socket route  '), 'wiring the socket route');
});

test('collapses newlines/tabs/multi-space runs to single spaces', () => {
  assert.equal(sanitizeStatusText('phase 2:\n\trunning\n\n  tests'), 'phase 2: running tests');
});

test('strips control characters (BEL, ESC) without eating the visible text', () => {
  assert.equal(sanitizeStatusText('ok\u0007 done\u001b[31m'), 'ok done[31m');
});

test('empty and whitespace-only input sanitize to the empty string', () => {
  assert.equal(sanitizeStatusText(''), '');
  assert.equal(sanitizeStatusText('   \n\t '), '');
});

test('caps over-long notes at STATUS_TEXT_MAX_CHARS with a visible ellipsis', () => {
  const out = sanitizeStatusText('x'.repeat(500));
  assert.equal(out.length, STATUS_TEXT_MAX_CHARS);
  assert.ok(out.endsWith('…'));
});

test('a note exactly at the cap is untouched', () => {
  const exact = 'y'.repeat(STATUS_TEXT_MAX_CHARS);
  assert.equal(sanitizeStatusText(exact), exact);
});
