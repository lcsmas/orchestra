import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  memoryCharLimit,
  oversizedMemoryFiles,
  oversizedMemoryText,
  formatChars,
  formatLimit,
  MIN_LIMIT_CHARS,
  DEFAULT_CONTEXT_WINDOW,
  contextWindowFromModelId,
} from './memory-size.ts';

// The anchor case: the user's own 1M-context session, whose CLI banner read
//   /home/lmas/.claude/LESSONS.md is over the 150.0k-char limit (187.7k chars)
// If this test ever fails, our replica has drifted from the CLI (or the CLI
// changed) — see the drift-risk note in memory-size.ts.
test('1M context window reproduces the CLI 150.0k limit', () => {
  assert.equal(memoryCharLimit(1_000_000), 150_000);
  assert.equal(formatLimit(150_000), '150.0k');
});

test('the observed banner line is reproduced verbatim', () => {
  const [file] = oversizedMemoryFiles([{ path: '/home/lmas/.claude/LESSONS.md', chars: 187_700 }], 1_000_000);
  assert.ok(file);
  assert.equal(
    oversizedMemoryText(file),
    '/home/lmas/.claude/LESSONS.md is over the 150.0k-char limit (187.7k chars)',
  );
});

test('the 40k floor governs small context windows', () => {
  // 200k tokens * 0.05 * 3 = 30_000, below the floor.
  assert.equal(memoryCharLimit(200_000), MIN_LIMIT_CHARS);
  // The floor stops governing above ~266_667 tokens.
  assert.equal(memoryCharLimit(400_000), 60_000);
});

test('an unknown context window falls back to the CLI default', () => {
  assert.equal(memoryCharLimit(null), memoryCharLimit(DEFAULT_CONTEXT_WINDOW));
  assert.equal(memoryCharLimit(undefined), MIN_LIMIT_CHARS);
  // Garbage must not produce a NaN limit that flags every file.
  assert.equal(memoryCharLimit(Number.NaN), MIN_LIMIT_CHARS);
  assert.equal(memoryCharLimit(-1), MIN_LIMIT_CHARS);
  assert.equal(memoryCharLimit(0), MIN_LIMIT_CHARS);
});

test('only files strictly over the limit are flagged', () => {
  const files = [
    { path: '/a.md', chars: 150_000 }, // exactly at the limit — CLI uses `>`
    { path: '/b.md', chars: 150_001 },
    { path: '/c.md', chars: 10 },
  ];
  const over = oversizedMemoryFiles(files, 1_000_000);
  assert.deepEqual(
    over.map((f) => f.path),
    ['/b.md'],
  );
  // The limit rides along so the rendered text can't imply a stale threshold.
  assert.equal(over[0].limit, 150_000);
});

test('an empty file list yields no warnings', () => {
  assert.deepEqual(oversizedMemoryFiles([], 1_000_000), []);
});

test('formatChars matches the CLI compact notation', () => {
  assert.equal(formatChars(187_700), '187.7k');
  assert.equal(formatChars(1_200_000), '1.2m');
  assert.equal(formatChars(950), '950');
});

test('the [1m] model marker implies the 1M context window', () => {
  assert.equal(contextWindowFromModelId('claude-opus-4-8[1m]'), 1_000_000);
  assert.equal(contextWindowFromModelId('opus[1m]'), 1_000_000);
  // No marker: unknowable this early, so the caller keeps the CLI fallback.
  assert.equal(contextWindowFromModelId('claude-opus-4-8'), null);
  assert.equal(contextWindowFromModelId(''), null);
  assert.equal(contextWindowFromModelId(undefined), null);
  // End-to-end: a [1m] session gets the 150k limit the CLI banner showed.
  assert.equal(memoryCharLimit(contextWindowFromModelId('claude-opus-4-8[1m]')), 150_000);
});

test('a display path may be substituted without touching the numbers', () => {
  const [file] = oversizedMemoryFiles([{ path: '/very/long/abs/CLAUDE.md', chars: 200_000 }], 1_000_000);
  assert.equal(
    oversizedMemoryText(file, 'CLAUDE.md'),
    'CLAUDE.md is over the 150.0k-char limit (200k chars)',
  );
});
