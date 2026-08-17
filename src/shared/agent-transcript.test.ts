import { test } from 'node:test';
import assert from 'node:assert/strict';
import { transcriptToEvents, HISTORY_SEQ_BASE } from './agent-transcript.ts';
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

test('transcript: a pasted image + caption reconstructs on the user bubble', () => {
  // The SDK serializes a user turn with an image as [imageBlock, textBlock].
  const jsonl = lines([
    {
      type: 'user',
      message: {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
          { type: 'text', text: 'what is this' },
        ],
      },
    },
  ]);
  const s = foldEvents(emptySession('ws1'), transcriptToEvents(jsonl, ctx()));
  const user = s.messages.find((m) => m.role === 'user')!;
  assert.equal(user.text, 'what is this');
  assert.equal(user.images?.length, 1);
  assert.equal(user.images![0].mediaType, 'image/png');
  assert.equal(user.images![0].dataBase64, 'AAAA');
});

test('transcript: an image-only turn (no caption) still renders a bubble', () => {
  const jsonl = lines([
    {
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'BBBB' } }],
      },
    },
  ]);
  const s = foldEvents(emptySession('ws1'), transcriptToEvents(jsonl, ctx()));
  const user = s.messages.find((m) => m.role === 'user' && (m.images?.length ?? 0) > 0);
  assert.ok(user, 'an image-only user turn should produce a user message');
  assert.equal(user!.images![0].mediaType, 'image/jpeg');
  assert.equal(user!.images![0].dataBase64, 'BBBB');
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

test('backfill recovers the envelope uuid as the rewind target', () => {
  // Real on-disk shape: the envelope is camelCase (`uuid`) where the live wire
  // is snake_case — and it is the uuid a REOPENED workspace rewinds to, since
  // those turns were never sent by this app run.
  const jsonl = [
    JSON.stringify({
      type: 'user',
      uuid: '7e1cd30a-e77c-466c-b2a8-118726719eb9',
      message: { role: 'user', content: 'plain string turn' },
    }),
    JSON.stringify({
      type: 'user',
      uuid: 'bbbbbbbb-e77c-466c-b2a8-118726719eb9',
      message: { role: 'user', content: [{ type: 'text', text: 'block turn' }] },
    }),
    // A tool_result line shares the `user` type but is not a rewindable turn —
    // it must not mint a user bubble at all.
    JSON.stringify({
      type: 'user',
      uuid: 'cccccccc-e77c-466c-b2a8-118726719eb9',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'ok' }] },
    }),
  ].join('\n');

  const s = foldEvents(emptySession('ws1'), transcriptToEvents(jsonl, ctx()));
  const users = s.messages.filter((m) => m.role === 'user');
  assert.deepEqual(
    users.map((m) => m.rewindId),
    ['7e1cd30a-e77c-466c-b2a8-118726719eb9', 'bbbbbbbb-e77c-466c-b2a8-118726719eb9'],
  );
});

test('backfill: a line with no uuid yields no rewind target (not a crash)', () => {
  // Pre-feature transcripts and synthetic lines simply are not rewindable —
  // the bubble hides its affordance rather than offering a broken target.
  const jsonl = JSON.stringify({
    type: 'user',
    message: { role: 'user', content: 'no envelope uuid' },
  });
  const s = foldEvents(emptySession('ws1'), transcriptToEvents(jsonl, ctx()));
  const users = s.messages.filter((m) => m.role === 'user');
  assert.equal(users.length, 1);
  assert.equal(users[0].rewindId, undefined);
});

test('backfill: slash-command frames render properly, not as raw XML bubbles', () => {
  const jsonl = lines([
    {
      type: 'user',
      uuid: 'u1',
      message: {
        role: 'user',
        content:
          '<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args>opus</command-args>',
      },
    },
    {
      type: 'user',
      message: { role: 'user', content: '<local-command-stdout>Set model to opus</local-command-stdout>' },
    },
    // /clear's empty ack must vanish entirely.
    {
      type: 'user',
      message: { role: 'user', content: '<local-command-stdout></local-command-stdout>' },
    },
  ]);
  const s = foldEvents(emptySession('ws1'), transcriptToEvents(jsonl, ctx()));
  assert.deepEqual(
    s.messages.map((m) => [m.role, m.text]),
    [
      ['user', '/model opus'],
      ['system', 'Set model to opus'],
    ],
  );
  // The invocation keeps its rewind target — it is a real turn the user sent.
  assert.equal(s.messages[0].rewindId, 'u1');
  assert.equal(s.messages[1].noticeKind, 'command-output');
});

test('backfill: the interrupt marker becomes an interrupted notice', () => {
  const jsonl = lines([
    { type: 'user', message: { role: 'user', content: 'do the thing' } },
    {
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] },
    },
  ]);
  const s = foldEvents(emptySession('ws1'), transcriptToEvents(jsonl, ctx()));
  assert.deepEqual(
    s.messages.map((m) => m.role),
    ['user', 'system'],
  );
  assert.equal(s.messages[1].noticeKind, 'interrupted');
});

// ─── message-id uniqueness across the history/live boundary ──────────────────
//
// Every RenderMessage id is derived from `event.seq`, and a backfilled history
// is PREPENDED into the same array as the live messages (store.applyAgentHistory).
// Two rows with one id is not cosmetic: the id is the React key, the
// virtualizer's measured-height cache key and its scroll-anchor key, so a
// collision made scrolling up one notch from the bottom teleport the viewport
// to the top of the transcript (the hibernation-wake bug).

test('backfill ids never collide with a live session that starts at seq 0', () => {
  const jsonl = lines([
    { type: 'user', uuid: 'u1', message: { role: 'user', content: 'first ever turn' } },
    {
      type: 'assistant',
      uuid: 'a1',
      message: { role: 'assistant', content: [{ type: 'text', text: 'answering' }] },
    },
  ]);
  // Exactly how sdkHistory() builds its cursor.
  const history = foldEvents(
    emptySession('ws1'),
    transcriptToEvents(jsonl, { seq: HISTORY_SEQ_BASE, now: () => 1_000 }),
  );

  // A live session ALWAYS starts a fresh workspace cursor at 0 (first launch),
  // and after a hibernation wake it resumes the workspace's monotonic cursor —
  // 0 is the worst case, so assert against it.
  const live = foldEvents(emptySession('ws1'), [
    { type: 'user-message', seq: 0, at: 2_000, text: 'a turn sent after waking' },
  ] as AgentEvent[]);

  const ids = [...history.messages, ...live.messages].map((m) => m.id);
  assert.equal(new Set(ids).size, ids.length, `duplicate message id in ${JSON.stringify(ids)}`);
});

test('a backfill is internally free of duplicate ids', () => {
  const jsonl = lines([
    { type: 'user', uuid: 'u1', message: { role: 'user', content: 'one' } },
    {
      type: 'assistant',
      uuid: 'a1',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'thinking out loud' },
          { type: 'tool_use', id: 'tu_1', name: 'Read', input: { file_path: '/a' } },
        ],
      },
    },
    { type: 'user', uuid: 'u2', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'ok' }] } },
    { type: 'user', uuid: 'u3', message: { role: 'user', content: 'two' } },
  ]);
  const s = foldEvents(
    emptySession('ws1'),
    transcriptToEvents(jsonl, { seq: HISTORY_SEQ_BASE, now: () => 1_000 }),
  );
  const ids = s.messages.map((m) => m.id);
  assert.ok(ids.length >= 4);
  assert.equal(new Set(ids).size, ids.length, `duplicate message id in ${JSON.stringify(ids)}`);
});

test('transcript: envelope timestamps override the clock so backfilled messages carry REAL times', () => {
  const jsonl = lines([
    {
      type: 'user',
      uuid: 'u1',
      timestamp: '2026-08-16T14:32:00.000Z',
      message: { role: 'user', content: 'first turn' },
    },
    {
      type: 'assistant',
      uuid: 'a1',
      timestamp: '2026-08-16T14:32:30.000Z',
      message: { role: 'assistant', content: [{ type: 'text', text: 'reply' }] },
    },
    // Timestamp-less line: inherits the PREVIOUS line's time, never the clock.
    { type: 'user', uuid: 'u2', message: { role: 'user', content: 'second turn' } },
  ]);

  // Clock deliberately far from the envelope times — if any stamped event
  // carries it, the override leaked.
  const evs = transcriptToEvents(jsonl, { seq: 0, now: () => 9_999_999 });
  const s = foldEvents(emptySession('ws1'), evs);

  const [u1, a1, u2] = s.messages;
  assert.equal(u1.at, Date.parse('2026-08-16T14:32:00.000Z'));
  assert.equal(a1.at, Date.parse('2026-08-16T14:32:30.000Z'));
  assert.equal(u2.at, Date.parse('2026-08-16T14:32:30.000Z')); // inherited
  assert.ok(s.messages.every((m) => m.at !== 9_999_999));
});
