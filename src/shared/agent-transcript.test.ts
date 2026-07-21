import { test } from 'node:test';
import assert from 'node:assert/strict';
import { transcriptToEvents } from './agent-transcript.ts';
import { foldEvents, emptySession, type NormalizeContext } from './agent-events.ts';
import type { AgentEvent } from './types.ts';

function ctx(): NormalizeContext {
  return { seq: 0, now: () => 1_000 };
}

const lines = (objs: unknown[]) => objs.map((o) => JSON.stringify(o)).join('\n');

test('transcript: user + assistant text + tool round-trip folds into a full session', () => {
  const jsonl = lines([
    { type: 'last-prompt', prompt: 'noise' },
    { type: 'user', uuid: 'u1', isSidechain: false, message: { role: 'user', content: 'Fix the bug' } },
    {
      type: 'assistant',
      uuid: 'a1',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'On it — reading the file.' },
          { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: '/x.ts' }, caller: { type: 'direct' } },
        ],
      },
    },
    {
      type: 'user',
      uuid: 'u2',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'file body', is_error: false }],
      },
    },
    { type: 'file-history-snapshot', whatever: true },
  ]);

  const evs = transcriptToEvents(jsonl, ctx());
  const s = foldEvents(emptySession('ws1'), evs);

  assert.deepEqual(
    s.messages.map((m) => m.role),
    ['user', 'assistant', 'tool'],
  );
  assert.equal(s.messages[0].text, 'Fix the bug');
  assert.equal(s.messages[1].text, 'On it — reading the file.');
  assert.equal(s.messages[1].done, true);
  assert.equal(s.messages[2].toolUse!.name, 'Read');
  assert.equal(s.messages[2].toolResult!.content, 'file body');
  // The synthetic terminal turn-end settles the session.
  assert.equal(s.running, false);
});

test('transcript: sidechain (subagent) lines are excluded', () => {
  const jsonl = lines([
    { type: 'user', isSidechain: true, message: { role: 'user', content: 'subagent brief' } },
    {
      type: 'assistant',
      isSidechain: true,
      message: { role: 'assistant', content: [{ type: 'text', text: 'subagent reply' }] },
    },
    { type: 'user', isSidechain: false, message: { role: 'user', content: 'main chain' } },
  ]);
  const s = foldEvents(emptySession('ws1'), transcriptToEvents(jsonl, ctx()));
  assert.deepEqual(s.messages.map((m) => m.text), ['main chain']);
});

test('transcript: string "true" is_error is treated as an error', () => {
  const jsonl = lines([
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }] } },
    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'boom', is_error: 'true' }] } },
  ]);
  const s = foldEvents(emptySession('ws1'), transcriptToEvents(jsonl, ctx()));
  const tool = s.messages.find((m) => m.role === 'tool')!;
  assert.equal(tool.toolResult!.isError, true);
});

test('transcript: garbage lines and empty input yield no events', () => {
  assert.deepEqual(transcriptToEvents('', ctx()), []);
  assert.deepEqual(transcriptToEvents('not json\n{broken', ctx()), []);
});

test('transcript: history block ids never collide with a live session at low indexes', () => {
  const jsonl = lines([
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'old history' }] } },
  ]);
  const c = ctx();
  const history = transcriptToEvents(jsonl, c);
  // Live events after backfill: same fold, low indexes, own seq space.
  const live: AgentEvent[] = [
    { seq: 0, at: 2000, type: 'block-start', index: 0, kind: 'text' },
    { seq: 1, at: 2000, type: 'text-delta', index: 0, text: 'fresh reply' },
  ];
  const s = foldEvents(emptySession('ws1'), [...history, ...live]);
  const texts = s.messages.map((m) => m.text);
  assert.deepEqual(texts, ['old history', 'fresh reply']);
  // Distinct React keys for every message.
  assert.equal(new Set(s.messages.map((m) => m.id)).size, s.messages.length);
});
