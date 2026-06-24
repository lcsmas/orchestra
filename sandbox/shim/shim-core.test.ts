import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseSpoolChunk,
  routeFromUrl,
  maxBodyBytesFor,
  isForwarded,
  FORWARDED_ROUTES,
} from './shim-core.ts';

// ─── parseSpoolChunk ─────────────────────────────────────────────────────────

test('parses complete lines into events', () => {
  const chunk =
    '{"event":"submit"}\n{"event":"pretool","tool":"Bash"}\n{"event":"posttool","tool":"Bash"}\n';
  const r = parseSpoolChunk('', chunk);
  assert.deepEqual(r.events, [
    { event: 'submit' },
    { event: 'pretool', tool: 'Bash' },
    { event: 'posttool', tool: 'Bash' },
  ]);
  assert.equal(r.leftover, '');
  assert.equal(r.truncate, false);
});

test('empty tool becomes undefined (no tool key)', () => {
  const r = parseSpoolChunk('', '{"event":"pretool","tool":""}\n');
  assert.deepEqual(r.events, [{ event: 'pretool' }]);
  assert.equal('tool' in r.events[0], false);
});

test('a trailing partial line is carried forward, not emitted', () => {
  const r = parseSpoolChunk('', '{"event":"submit"}\n{"event":"pre');
  assert.deepEqual(r.events, [{ event: 'submit' }]);
  assert.equal(r.leftover, '{"event":"pre');
  assert.equal(r.truncate, false);
});

test('a carried partial line is completed by the next chunk', () => {
  const first = parseSpoolChunk('', '{"event":"pre');
  assert.deepEqual(first.events, []);
  assert.equal(first.leftover, '{"event":"pre');
  const second = parseSpoolChunk(first.leftover, 'tool","tool":"Read"}\n');
  assert.deepEqual(second.events, [{ event: 'pretool', tool: 'Read' }]);
  assert.equal(second.leftover, '');
});

test('corrupt and non-event lines are skipped, not fatal', () => {
  const chunk = 'not json\n{"tool":"Bash"}\n{"event":42}\n{"event":"stop"}\n';
  const r = parseSpoolChunk('', chunk);
  // only the well-formed string-event line survives
  assert.deepEqual(r.events, [{ event: 'stop' }]);
});

test('truncate is signalled at a turn boundary with no buffered partial', () => {
  const r = parseSpoolChunk('', '{"event":"submit"}\n{"event":"stop"}\n');
  assert.equal(r.truncate, true);
});

test('notify also triggers truncate', () => {
  const r = parseSpoolChunk('', '{"event":"notify"}\n');
  assert.equal(r.truncate, true);
});

test('no truncate when a terminal line is followed by more activity', () => {
  const r = parseSpoolChunk('', '{"event":"stop"}\n{"event":"submit"}\n');
  assert.equal(r.truncate, false);
});

test('no truncate when a partial line is still buffered after a terminal', () => {
  const r = parseSpoolChunk('', '{"event":"stop"}\n{"event":"sub');
  assert.equal(r.truncate, false);
  assert.equal(r.leftover, '{"event":"sub');
});

// ─── route helpers ───────────────────────────────────────────────────────────

test('routeFromUrl strips the leading slash', () => {
  assert.equal(routeFromUrl('/spawn'), 'spawn');
  assert.equal(routeFromUrl('/message'), 'message');
  assert.equal(routeFromUrl(undefined), '');
  assert.equal(routeFromUrl('peers'), 'peers');
});

test('the five control-plane routes are forwarded; others are not', () => {
  for (const r of ['rename', 'spawn', 'peers', 'read', 'message']) {
    assert.equal(isForwarded(r), true, `${r} should forward`);
  }
  assert.equal(isForwarded('event'), false);
  assert.equal(isForwarded(''), false);
  assert.equal(FORWARDED_ROUTES.size, 5);
});

test('body caps match hooks-server.ts (1 MiB for spawn/message, 4 KiB otherwise)', () => {
  assert.equal(maxBodyBytesFor('spawn'), 1_048_576);
  assert.equal(maxBodyBytesFor('message'), 1_048_576);
  assert.equal(maxBodyBytesFor('rename'), 4096);
  assert.equal(maxBodyBytesFor('peers'), 4096);
  assert.equal(maxBodyBytesFor('event'), 4096);
});
