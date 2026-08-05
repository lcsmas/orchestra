import test from 'node:test';
import assert from 'node:assert/strict';
import { statusGlyphTitle } from './status-glyph-title.ts';
import { THINKING_TOOL_LABEL } from '../shared/types.ts';

// ─── the between-tools "thinking" gap ────────────────────────────────────────
//
// Measured on a live session: consecutive pretool/posttool PAIRS were 40–130ms
// apart, but consecutive PAIRS were 2.5–6.5s apart — the model generating, with
// no lifecycle event in the window. The dot was correctly `running` the whole
// time; what went blank was the tool label, so the row read as frozen. Main now
// sets THINKING_TOOL_LABEL on submit/posttool instead of clearing it.

const ws = (over: Record<string, unknown> = {}) =>
  ({ status: 'running', markedUnread: false, ...over }) as Parameters<typeof statusGlyphTitle>[0];

test('statusGlyphTitle: the thinking sentinel renders as its own phrase, not a tool name', () => {
  // "(thinking)" would read as a tool literally called "thinking".
  const title = statusGlyphTitle(ws(), THINKING_TOOL_LABEL);
  assert.equal(title, 'Agent is thinking…');
  assert.ok(!title.includes('('), 'must not use the parenthesised tool form');
});

test('statusGlyphTitle: a REAL tool name still uses the parenthesised form', () => {
  // The discriminator must be the sentinel, not "any label" — otherwise the
  // active-tool display (the channel's original job) is destroyed.
  assert.equal(statusGlyphTitle(ws(), 'Bash'), 'Agent is working… (Bash)');
  assert.equal(statusGlyphTitle(ws(), 'Edit'), 'Agent is working… (Edit)');
});

test('statusGlyphTitle: no label falls back to the bare running phrase', () => {
  // Still reachable: the SDK path and any hook Orchestra does not label.
  assert.equal(statusGlyphTitle(ws()), 'Agent is working…');
  assert.equal(statusGlyphTitle(ws(), undefined), 'Agent is working…');
});

test('statusGlyphTitle: thinking only applies while RUNNING, never to a rest state', () => {
  // A stale label must not survive into idle/waiting/error — those are terminal
  // or at-rest states where "thinking" would be an outright lie. Guards against
  // the sentinel check being hoisted above the status checks.
  assert.equal(statusGlyphTitle(ws({ status: 'idle' }), THINKING_TOOL_LABEL), 'Agent is idle');
  assert.equal(
    statusGlyphTitle(ws({ status: 'waiting' }), THINKING_TOOL_LABEL),
    'Agent is blocked on your answer',
  );
  assert.equal(statusGlyphTitle(ws({ status: 'error' }), THINKING_TOOL_LABEL), 'Agent hit an error');
});

// The three attention states must each read differently — `waiting` (blocked on
// you) and `autoUnread` (finished, never opened) used to be the same `waiting`
// status and so the same sentence.
test('statusGlyphTitle: blocked, finished-unseen and seen are three distinct phrases', () => {
  assert.equal(statusGlyphTitle(ws({ status: 'waiting' })), 'Agent is blocked on your answer');
  assert.equal(
    statusGlyphTitle(ws({ status: 'idle', autoUnread: true })),
    'Agent finished — you have not opened this yet',
  );
  assert.equal(statusGlyphTitle(ws({ status: 'idle' })), 'Agent is idle');
});

test('statusGlyphTitle: a blocked agent outranks the unread bell when both apply', () => {
  // Answering is what unblocks it, so the stronger claim wins — matching the
  // glyph, where `waiting` keeps its question mark rather than showing a bell.
  assert.equal(
    statusGlyphTitle(ws({ status: 'waiting', autoUnread: true })),
    'Agent is blocked on your answer',
  );
});

test('statusGlyphTitle: unread and hibernated still outrank a thinking label', () => {
  // Both are user-facing states that must win over any in-flight activity label.
  assert.equal(
    statusGlyphTitle(ws({ markedUnread: true }), THINKING_TOOL_LABEL),
    'Tagged unread — come back to this workspace',
  );
  assert.equal(
    statusGlyphTitle(ws({ hibernatedAt: 1 }), THINKING_TOOL_LABEL),
    'Agent is hibernated — process stopped to free memory, resumes on input',
  );
});
