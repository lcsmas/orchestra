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

// ─── CLI-synthetic frames (isMeta on disk = isSynthetic on the wire) ─────────
//
// The CLI persists `isMeta: msg.isSynthetic`, and the live normalize path drops
// synthetic user TEXT (`msg.isSynthetic !== true`). Without the mirror gate the
// backfill rendered every skill invocation's whole SKILL.md body — plus
// "Continue from where you left off." wake prompts, `[Image: …]` placeholders
// and `<local-command-caveat>` wrappers — as giant USER bubbles after an app
// restart, on frames a live session never showed (the "skills show as messages
// from the user after restart" bug, real bloc2 transcript 2026-08-21).

test('backfill: isMeta frames (skill bodies, continuation prompts) never render as user bubbles', () => {
  const jsonl = lines([
    { type: 'user', uuid: 'u1', message: { role: 'user', content: '/retro' } },
    // The skill-body expansion — string content, isMeta.
    {
      type: 'user',
      uuid: 'u2',
      isMeta: true,
      sourceToolUseID: 'toolu_skill',
      message: { role: 'user', content: 'Base directory for this skill: /home/x/skills/retro\n\n# Post-task retro\n…' },
    },
    // The wake/continuation prompt — text-block content, isMeta.
    {
      type: 'user',
      uuid: 'u3',
      isMeta: true,
      message: { role: 'user', content: [{ type: 'text', text: 'Continue from where you left off.' }] },
    },
    // The pasted-image coordinate placeholder — isMeta.
    {
      type: 'user',
      uuid: 'u4',
      isMeta: true,
      message: { role: 'user', content: '[Image: original 2022x1254, displayed at 2000x1240.]' },
    },
  ]);
  const s = foldEvents(emptySession('ws1'), transcriptToEvents(jsonl, ctx()));
  assert.deepEqual(
    s.messages.map((m) => [m.role, m.text]),
    [['user', '/retro']],
  );
});

test('backfill: tool_result blocks on an isMeta frame still flow (live-path parity)', () => {
  // The live gate covers only the text branch — tool results are consumed
  // before it. A synthetic frame carrying a tool_result must still finalize
  // the tool card, or a backfilled run would show tools stuck running.
  const jsonl = lines([
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu_1', name: 'Bash', input: {} }] } },
    {
      type: 'user',
      isMeta: true,
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'ok', is_error: false }] },
    },
  ]);
  const s = foldEvents(emptySession('ws1'), transcriptToEvents(jsonl, ctx()));
  const tool = s.messages.find((m) => m.role === 'tool')!;
  assert.equal(tool.toolResult!.content, 'ok');
  // And no phantom user bubble from the synthetic frame.
  assert.equal(s.messages.filter((m) => m.role === 'user').length, 0);
});

test('backfill: the compact summary becomes a boundary notice, not a wall-of-text user bubble', () => {
  const jsonl = lines([
    {
      type: 'user',
      isCompactSummary: true,
      isVisibleInTranscriptOnly: true,
      message: { role: 'user', content: 'This session is being continued from a previous conversation that ran out of context…' },
    },
    { type: 'user', uuid: 'u1', message: { role: 'user', content: 'real turn after compact' } },
  ]);
  const s = foldEvents(emptySession('ws1'), transcriptToEvents(jsonl, ctx()));
  assert.deepEqual(
    s.messages.map((m) => [m.role, m.noticeKind ?? m.text]),
    [
      ['system', 'compact-boundary'],
      ['user', 'real turn after compact'],
    ],
  );
});

test('backfill: envelope origin is recovered as the live badge (claude.ai / peer)', () => {
  const jsonl = lines([
    {
      type: 'user',
      uuid: 'u1',
      origin: { kind: 'channel' },
      message: { role: 'user', content: 'typed on claude.ai' },
    },
    {
      type: 'user',
      uuid: 'u2',
      origin: { kind: 'human' }, // live renders no badge for 'human' — parity
      message: { role: 'user', content: 'plain human turn' },
    },
  ]);
  const s = foldEvents(emptySession('ws1'), transcriptToEvents(jsonl, ctx()));
  assert.deepEqual(
    s.messages.map((m) => [m.text, m.origin]),
    [
      ['typed on claude.ai', 'claude.ai'],
      ['plain human turn', undefined],
    ],
  );
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

// ── context gauge seeding (issue #15) ───────────────────────────────────────
//
// A history/detached session has NO live `Query` to ask for context usage, and
// the synthetic terminal turn-end carries `usage: null`. Without a seed here
// the gauge renders nothing at all at pane mount for these sessions — the
// regression these tests pin.

test('transcript: folded session carries a context reading for the gauge', () => {
  const jsonl = lines([
    { type: 'user', uuid: 'u1', message: { role: 'user', content: 'hi' } },
    {
      type: 'assistant',
      uuid: 'a1',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'hello' }],
        usage: { input_tokens: 10, cache_creation_input_tokens: 5, cache_read_input_tokens: 40000 },
      },
    },
  ]);
  const session = foldEvents(emptySession(), transcriptToEvents(jsonl, ctx()));
  assert.ok(session.contextUsage, 'history session must expose a context reading');
  assert.equal(session.contextUsage.totalTokens, 40015);
  assert.equal(session.contextUsage.source, 'transcript');
  // The transcript records no window, so one is derived from the model id —
  // the gauge must show a real percentage at mount, not a bare token count.
  assert.equal(session.contextUsage.maxTokens, 200_000);
  assert.equal(session.contextUsage.percentage, 20);
  // The turn-end it ships alongside carries no usage — proving the reading
  // could only have come from the seed.
  assert.equal(session.lastTurn?.usage, null);
});

test('transcript: the NEWEST assistant turn wins the context reading', () => {
  const jsonl = lines([
    { type: 'assistant', uuid: 'a1', message: { role: 'assistant', content: [{ type: 'text', text: 'one' }], usage: { input_tokens: 100 } } },
    { type: 'assistant', uuid: 'a2', message: { role: 'assistant', content: [{ type: 'text', text: 'two' }], usage: { input_tokens: 900 } } },
  ]);
  const session = foldEvents(emptySession(), transcriptToEvents(jsonl, ctx()));
  assert.equal(session.contextUsage?.totalTokens, 900);
});

test('transcript: sidechain turns do not contribute to the context reading', () => {
  const jsonl = lines([
    { type: 'assistant', uuid: 'a1', message: { role: 'assistant', content: [{ type: 'text', text: 'main' }], usage: { input_tokens: 100 } } },
    // A Task-subagent line: its context is not this session's window.
    { type: 'assistant', uuid: 's1', isSidechain: true, message: { role: 'assistant', content: [{ type: 'text', text: 'sub' }], usage: { input_tokens: 77777 } } },
  ]);
  const session = foldEvents(emptySession(), transcriptToEvents(jsonl, ctx()));
  assert.equal(session.contextUsage?.totalTokens, 100);
});

test('transcript: a compaction boundary discards the stale pre-compact reading', () => {
  const jsonl = lines([
    { type: 'assistant', uuid: 'a1', message: { role: 'assistant', content: [{ type: 'text', text: 'big' }], usage: { input_tokens: 150000 } } },
    { type: 'user', uuid: 'c1', isCompactSummary: true, message: { role: 'user', content: 'summary…' } },
  ]);
  const session = foldEvents(emptySession(), transcriptToEvents(jsonl, ctx()));
  // Everything before the boundary is pre-compact and stale; showing 150k after
  // a compaction would be worse than showing nothing.
  assert.equal(session.contextUsage, undefined);
});

test('transcript: a post-compaction turn re-seeds the reading', () => {
  const jsonl = lines([
    { type: 'assistant', uuid: 'a1', message: { role: 'assistant', content: [{ type: 'text', text: 'big' }], usage: { input_tokens: 150000 } } },
    { type: 'user', uuid: 'c1', isCompactSummary: true, message: { role: 'user', content: 'summary…' } },
    { type: 'assistant', uuid: 'a2', message: { role: 'assistant', content: [{ type: 'text', text: 'after' }], usage: { input_tokens: 8000 } } },
  ]);
  const session = foldEvents(emptySession(), transcriptToEvents(jsonl, ctx()));
  assert.equal(session.contextUsage?.totalTokens, 8000);
});

test('transcript: a transcript with no usage yields no context reading', () => {
  const jsonl = lines([
    { type: 'user', uuid: 'u1', message: { role: 'user', content: 'hi' } },
    { type: 'assistant', uuid: 'a1', message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }] } },
  ]);
  const session = foldEvents(emptySession(), transcriptToEvents(jsonl, ctx()));
  assert.equal(session.contextUsage, undefined);
});

test('transcript: a live reading supersedes the transcript seed on the same session', () => {
  const jsonl = lines([
    { type: 'assistant', uuid: 'a1', message: { role: 'assistant', content: [{ type: 'text', text: 'x' }], usage: { input_tokens: 100 } } },
  ]);
  let session = foldEvents(emptySession(), transcriptToEvents(jsonl, ctx()));
  assert.equal(session.contextUsage?.source, 'transcript');
  // A live session attaching later must win, even though it arrives second.
  const liveEv: AgentEvent = {
    type: 'session/context',
    seq: 1,
    at: 2_000,
    usage: {
      totalTokens: 73191,
      maxTokens: 200000,
      percentage: 37,
      source: 'live',
      at: 2_000,
    },
  };
  session = foldEvents(session, [liveEv]);
  assert.equal(session.contextUsage?.source, 'live');
  assert.equal(session.contextUsage?.percentage, 37);
});

test('transcript: the window is derived from the model on the SAME line as the tokens', () => {
  const jsonl = lines([
    // An older line on a 1M model, superseded by a newer 200k-model line: the
    // window must follow the line the FIGURE came from, not the first seen.
    { type: 'assistant', uuid: 'a1', message: { role: 'assistant', model: 'claude-opus-4-8[1m]', content: [{ type: 'text', text: 'one' }], usage: { input_tokens: 900000 } } },
    { type: 'assistant', uuid: 'a2', message: { role: 'assistant', model: 'claude-opus-5', content: [{ type: 'text', text: 'two' }], usage: { input_tokens: 50000 } } },
  ]);
  const s = foldEvents(emptySession(), transcriptToEvents(jsonl, ctx()));
  assert.equal(s.contextUsage?.totalTokens, 50000);
  assert.equal(s.contextUsage?.maxTokens, 200_000);
  assert.equal(s.contextUsage?.percentage, 25);
});

test('transcript: a [1m] session gets the 1M window', () => {
  const jsonl = lines([
    { type: 'assistant', uuid: 'a1', message: { role: 'assistant', model: 'claude-opus-4-8[1m]', content: [{ type: 'text', text: 'x' }], usage: { input_tokens: 400000 } } },
  ]);
  const s = foldEvents(emptySession(), transcriptToEvents(jsonl, ctx()));
  assert.equal(s.contextUsage?.maxTokens, 1_000_000);
  assert.equal(s.contextUsage?.percentage, 40);
});

// The spec gate: a history/detached pane must be RELIABLY NON-EMPTY at mount,
// i.e. a real percentage, never a bare token count and never nothing.
test('transcript: history gauge is reliably non-empty with a percentage at mount', () => {
  const jsonl = lines([
    { type: 'user', uuid: 'u1', message: { role: 'user', content: 'hi' } },
    { type: 'assistant', uuid: 'a1', message: { role: 'assistant', model: 'claude-opus-5', content: [{ type: 'text', text: 'yo' }], usage: { input_tokens: 12, cache_read_input_tokens: 48000 } } },
  ]);
  const s = foldEvents(emptySession(), transcriptToEvents(jsonl, ctx()));
  const u = s.contextUsage;
  assert.ok(u, 'gauge must have a reading at mount');
  assert.equal(typeof u.percentage, 'number');
  assert.ok(u.percentage! > 0, 'percentage must be renderable, not null');
  // And it must be there BEFORE any real turn-end usage exists.
  assert.equal(s.lastTurn?.usage, null);
});
