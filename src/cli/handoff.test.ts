import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveHandoffSummary } from './handoff.ts';

const GOOD = 'STATE: coded\nNEXT STEPS: nominate\nREFS: https://github.com/lcsmas/orchestra/issues/466\nNOT VERIFIED: the packaged app';
const read = (p: string) => {
  if (p === 'good.md') return GOOD;
  if (p === 'bad.md') return 'STATE: only';
  throw new Error('ENOENT');
};

test('--summary-file with a well-formed file resolves to its text', () => {
  assert.deepEqual(resolveHandoffSummary({ args: ['--summary-file', 'good.md'], readFile: read }), { summary: GOOD });
});
test('--summary inline resolves too', () => {
  assert.deepEqual(resolveHandoffSummary({ args: ['--summary', GOOD], readFile: read }), { summary: GOOD });
});
test('must-FAIL: a summary missing sections is refused with the named error, nothing resolved', () => {
  const r = resolveHandoffSummary({ args: ['--summary-file', 'bad.md'], readFile: read });
  assert.ok('error' in r);
  if ('error' in r) assert.match(r.error, /^handoff-summary-invalid: .*missing section NEXT STEPS/);
});
test('must-FAIL: neither / both / unreadable / unknown flag are refused, each saying nothing was ended', () => {
  for (const args of [[], ['--summary-file', 'good.md', '--summary', GOOD], ['--summary-file', 'nope.md'], ['--summary-file'], ['--bogus'], ['--summary-file', '--summary']]) {
    const r = resolveHandoffSummary({ args, readFile: read });
    assert.ok('error' in r, JSON.stringify(args));
    if ('error' in r) assert.match(r.error, /nothing was ended/i);
  }
});
