import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isPeerMessage,
  peerSender,
  peerPreview,
  describePeerRun,
  peerOriginLabel,
  recognizeFormattedPeerMessage,
} from './peer-messages.ts';

// The EXACT envelope src/main/workspaces.ts `formatPeerMessage` emits. Kept
// byte-identical here on purpose: if the formatter's wording ever changes, this
// fixture stops matching and the backfill test below fails loudly — which is the
// only warning the scoped textual recognizer can get.
const formatted = (branch: string, id: string, body: string) =>
  `[message from agent '${branch}' (${id})]\n${body}\n\nReply with: orchestra message ${id} "<reply>"`;

test('isPeerMessage: keys on the origin badge, not the text', () => {
  assert.equal(isPeerMessage({ role: 'user', origin: 'peer: alpha' }), true);
  // CONTROL — the human's own turn is UNAFFECTED, even when its text looks
  // exactly like a peer envelope. This is the invariant the feature must not break.
  assert.equal(isPeerMessage({ role: 'user' }), false);
  assert.equal(
    isPeerMessage({ role: 'user', origin: undefined }),
    false,
    'a turn with no origin is the human',
  );
  // Other origins keep their full bubble — only peer traffic collapses.
  assert.equal(isPeerMessage({ role: 'user', origin: 'claude.ai' }), false);
  assert.equal(isPeerMessage({ role: 'user', origin: 'task notification' }), false);
  // Role matters: an assistant reply is never a peer row.
  assert.equal(isPeerMessage({ role: 'assistant', origin: 'peer: alpha' }), false);
});

test('peerOriginLabel / peerSender round-trip', () => {
  assert.equal(peerOriginLabel({ kind: 'peer', from: 'ws1', name: 'fix-login' }), 'peer: fix-login');
  // Falls back to the id when the branch is missing, so a row is never nameless.
  assert.equal(peerOriginLabel({ kind: 'peer', from: 'ws1', name: '' }), 'peer: ws1');
  assert.equal(peerSender({ origin: 'peer: fix-login' }), 'fix-login');
  assert.equal(peerSender({ origin: 'peer: ' }), 'agent');
  assert.equal(peerSender({}), 'agent');
});

test('peerPreview: first non-empty line, capped', () => {
  assert.equal(peerPreview('\n\nSTATUS: done\nmore detail here'), 'STATUS: done');
  assert.equal(peerPreview('   '), '');
  assert.equal(peerPreview(undefined), '');
  const long = 'x'.repeat(200);
  const p = peerPreview(long, 40);
  assert.equal(p.length, 40, 'capped to max');
  assert.ok(p.endsWith('…'), 'ellipsis marks truncation');
  // A short line is passed through untouched — no gratuitous ellipsis.
  assert.equal(peerPreview('short', 40), 'short');
});

test('describePeerRun: counts and distinct senders', () => {
  const a = { origin: 'peer: alpha' };
  const b = { origin: 'peer: beta' };
  assert.equal(describePeerRun([a]), 'Message from alpha');
  assert.equal(describePeerRun([a, a]), '2 messages from alpha');
  assert.equal(describePeerRun([a, b]), '2 messages from 2 agents');
  assert.equal(describePeerRun([a, b, a, b]), '4 messages from 2 agents');
});

test('recognizeFormattedPeerMessage: parses Orchestra\'s own envelope', () => {
  const text = formatted('fix-login-race', 'ws-abc', 'STATUS: gates green\nsecond line');
  const got = recognizeFormattedPeerMessage(text);
  assert.ok(got, 'the real formatter output must be recognized');
  assert.deepEqual(got.origin, { kind: 'peer', from: 'ws-abc', name: 'fix-login-race' });
  assert.equal(got.body, 'STATUS: gates green\nsecond line', 'header AND reply footer stripped');
});

test('recognizeFormattedPeerMessage: does NOT match ordinary prose (the control)', () => {
  // The whole risk of a textual rule is over-matching. These must all be null,
  // or a human turn would silently collapse into a peer row.
  assert.equal(recognizeFormattedPeerMessage('just a normal prompt'), null);
  // ANCHORING. This fixture carries the header VERBATIM — including the
  // trailing newline the pattern needs — but preceded by prose. Only the `^`
  // anchor rejects it, so this is what pins the anchor (an earlier version of
  // this test omitted the newline and therefore passed even with `^` deleted —
  // caught by mutation-testing the un-anchored variant).
  assert.equal(
    recognizeFormattedPeerMessage("I saw this in the log:\n[message from agent 'x' (y)]\nbody"),
    null,
    'not anchored at the start → not a delivery',
  );
  assert.equal(
    recognizeFormattedPeerMessage("[message from agent 'x']\nbody"),
    null,
    'missing the (id) group → not our envelope',
  );
  assert.equal(
    recognizeFormattedPeerMessage("[message from agent 'x' (y)] inline, no newline"),
    null,
    'header must terminate the line',
  );
});

test('recognizeFormattedPeerMessage: body with no reply footer still parses', () => {
  // The inbox path and a truncated delivery can drop the footer; the header alone
  // is what identifies the envelope.
  const got = recognizeFormattedPeerMessage("[message from agent 'a' (id1)]\nbare body");
  assert.ok(got);
  assert.equal(got.body, 'bare body');
});

test('end-to-end: a formatted delivery becomes a collapsible row, a human turn does not', () => {
  const rec = recognizeFormattedPeerMessage(formatted('alpha', 'ws1', 'ping'));
  assert.ok(rec);
  const msg = { role: 'user', origin: peerOriginLabel(rec.origin), text: rec.body };
  assert.equal(isPeerMessage(msg), true);
  assert.equal(peerSender(msg), 'alpha');
  assert.equal(peerPreview(msg.text), 'ping');
  // CONTROL, same assertions, on a human turn.
  const human = { role: 'user', text: 'ping' };
  assert.equal(isPeerMessage(human), false);
});
