import { test } from 'node:test';
import assert from 'node:assert/strict';
import { endpointToHttpUrl, parseZList, overlayPaths, HOOK_DIRS } from './import-core.ts';

// ─── endpointToHttpUrl ───────────────────────────────────────────────────────

test('maps ws:// to http:// keeping host and port', () => {
  assert.equal(endpointToHttpUrl('ws://box:8787', '/import'), 'http://box:8787/import');
});

test('maps wss:// to https://', () => {
  assert.equal(endpointToHttpUrl('wss://box.example.com:8787', '/healthz'), 'https://box.example.com:8787/healthz');
});

test('passes http(s) endpoints through unchanged', () => {
  assert.equal(endpointToHttpUrl('http://box:8787', '/import'), 'http://box:8787/import');
});

test('discards any path/query on the endpoint and normalizes the route', () => {
  assert.equal(endpointToHttpUrl('ws://box:8787/some/path?x=1', 'import'), 'http://box:8787/import');
});

test('rejects unsupported schemes', () => {
  assert.throws(() => endpointToHttpUrl('ftp://box:21', '/import'), /unsupported/);
});

// ─── parseZList ──────────────────────────────────────────────────────────────

test('splits NUL-delimited git output and drops empties', () => {
  assert.deepEqual(parseZList('a.txt\0dir/b.txt\0'), ['a.txt', 'dir/b.txt']);
  assert.deepEqual(parseZList(''), []);
  assert.deepEqual(parseZList('\0\0'), []);
});

test('keeps paths with spaces and newlines intact (the point of -z)', () => {
  assert.deepEqual(parseZList('with space.txt\0with\nnewline.txt\0'), [
    'with space.txt',
    'with\nnewline.txt',
  ]);
});

// ─── overlayPaths ────────────────────────────────────────────────────────────

test('unions untracked + modified + hook dirs, deduplicated, order-stable', () => {
  assert.deepEqual(
    overlayPaths(['new.txt', 'shared.txt'], ['shared.txt', 'edited.txt'], ['.orchestra']),
    ['new.txt', 'shared.txt', 'edited.txt', '.orchestra'],
  );
});

test('empty inputs yield an empty overlay', () => {
  assert.deepEqual(overlayPaths([], [], []), []);
});

test('HOOK_DIRS names the dirs the shim spawn path depends on', () => {
  assert.deepEqual([...HOOK_DIRS], ['.orchestra', '.claude']);
});
