import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyTurnMessage, isIntentionalEnd } from './first-turn.ts';

// The bad-model / no-auth shape is REPLAYED from a real capture (claude 2.1.284, scratch HOME, no credentials), never hand-written:
// scripts/fixtures/real-cli-badmodel-2.1.284.jsonl = system/init, assistant(error), result(is_error).
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REAL = fs.readFileSync(path.join(HERE, '..', '..', 'scripts', 'fixtures', 'real-cli-badmodel-2.1.284.jsonl'), 'utf8')
  .split('\n').filter(Boolean).map((l) => JSON.parse(l));

test('the capture is the shape D7 was written for: init, assistant error, result is_error (the fixture itself is asserted)', () => {
  assert.deepEqual(REAL.map((m) => m.type), ['system', 'assistant', 'result']);
  assert.equal(REAL[0].subtype, 'init');
  assert.equal(REAL[1].error, 'authentication_failed');
  assert.equal(REAL[1].is_api_error_message, true);
  assert.equal(REAL[1].message.model, '<synthetic>');
  assert.equal(REAL[2].is_error, true);
});

test('REAL failed first turn: init says nothing; the assistant error is an ERROR that is not the end; the result is the terminal ERROR', () => {
  assert.deepEqual(classifyTurnMessage(REAL[0]), { kind: 'none' }, 'init is NOT proof the brief was received');
  assert.deepEqual(classifyTurnMessage(REAL[1]), { kind: 'error', text: 'Not logged in · Please run /login', terminal: false });
  assert.deepEqual(classifyTurnMessage(REAL[2]), { kind: 'error', text: 'Not logged in · Please run /login', terminal: true });
});

test('each error flag alone is enough (the CLI may flag differently across versions)', () => {
  const content = [{ type: 'text', text: 'boom' }];
  assert.equal(classifyTurnMessage({ type: 'assistant', error: 'invalid_request', message: { model: 'claude-x', content } }).kind, 'error');
  assert.equal(classifyTurnMessage({ type: 'assistant', is_api_error_message: true, message: { model: 'claude-x', content } }).kind, 'error');
  assert.equal(classifyTurnMessage({ type: 'assistant', message: { model: '<synthetic>', content } }).kind, 'error');
});

test('real output is OUTPUT: a plain assistant message, a tool_use, a streamed block, a non-error result', () => {
  const ok = { model: 'claude-opus-4-8', content: [{ type: 'text', text: 'hello' }] };
  assert.deepEqual(classifyTurnMessage({ type: 'assistant', message: ok }), { kind: 'output' });
  assert.deepEqual(classifyTurnMessage({ type: 'assistant', message: { model: 'claude-opus-4-8', content: [{ type: 'tool_use', id: 't', name: 'Bash', input: {} }] } }), { kind: 'output' });
  assert.deepEqual(classifyTurnMessage({ type: 'stream_event', event: { type: 'content_block_delta' } }), { kind: 'output' });
  assert.deepEqual(classifyTurnMessage({ type: 'result', subtype: 'success', is_error: false, result: 'done' }), { kind: 'output' });
});

test('noise says nothing about the turn: hook events, rate-limit notices, message_start, unknown types', () => {
  assert.deepEqual(classifyTurnMessage({ type: 'system', subtype: 'hook_started' }), { kind: 'none' });
  assert.deepEqual(classifyTurnMessage({ type: 'rate_limit_event' }), { kind: 'none' });
  assert.deepEqual(classifyTurnMessage({ type: 'stream_event', event: { type: 'message_start' } }), { kind: 'none' });
  assert.deepEqual(classifyTurnMessage({}), { kind: 'none' });
});

test('a result error with no text still names the failure; an error assistant with no text names its flag', () => {
  assert.deepEqual(classifyTurnMessage({ type: 'result', is_error: true }), { kind: 'error', text: 'the first turn ended in an error', terminal: true });
  assert.deepEqual(classifyTurnMessage({ type: 'assistant', error: 'rate_limit', message: { content: [] } }), { kind: 'error', text: 'rate_limit', terminal: false });
});

test('isIntentionalEnd (F3): each on-purpose flag alone counts; a plain session and undefined flags do not', () => {
  assert.equal(isIntentionalEnd({}), false);
  assert.equal(isIntentionalEnd({ stopping: false, cleared: false, hibernating: false, interruptRequested: false }), false);
  assert.equal(isIntentionalEnd({ stopping: true }), true, 'a stop (branch switch, migration, recycle)');
  assert.equal(isIntentionalEnd({ cleared: true }), true, '/clear');
  assert.equal(isIntentionalEnd({ hibernating: true }), true, 'idle hibernate');
  assert.equal(isIntentionalEnd({ restartRequested: 'cli' }), true, 'Restart');
  assert.equal(isIntentionalEnd({ interruptRequested: true }), true, 'a user interrupt');
  assert.equal(isIntentionalEnd({}, true), true, 'the stream ended because of an interrupt');
});
