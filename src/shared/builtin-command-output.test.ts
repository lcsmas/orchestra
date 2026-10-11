// #341 — a built-in slash command's OUTPUT (`/recap`, `/model`, `/help` …) renders as a
// `command-output` row, LIVE and after reopen, never as raw XML, and an empty output renders nothing.
//
// Fixture = a REAL capture (scripts/fixtures/payloads/local-command.capture.json: CLI 2.1.291 +
// SDK 0.3.241, fake API): `stream` is what consume() iterates for a local command (a SYNTHETIC
// `assistant` message tagged `local_command_source`, no stream_event deltas), `transcript` the
// on-disk JSONL of the same session (`system/local_command` lines). Same uuids on both sides.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  normalizeSdkMessage,
  foldEvents,
  emptySession,
  makeUserMessage,
  type NormalizeContext,
  type SdkMessage,
} from './agent-events.ts';
// Namespace import so the SAME file also loads against master (no such export there): that arm
// fails by itself instead of the whole file dying at link time — the must-FAIL runs need per-arm verdicts.
import * as events from './agent-events.ts';
import { transcriptToEvents } from './agent-transcript.ts';
import type { AgentEvent } from './types.ts';

const FIXTURE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..', '..', 'scripts', 'fixtures', 'payloads', 'local-command.capture.json',
);
interface Capture { cli: string; stream: SdkMessage[]; transcript: Record<string, unknown>[] }
const capture = (): Capture => JSON.parse(fs.readFileSync(FIXTURE, 'utf8')) as Capture;
const RECAP_TEXT =
  'Goal: ship the fix for the checkout bug.\nDone: reproduced it, wrote the failing test.\nNext: patch the rounding in totals.ts and rerun the suite.';

const ctx = (): NormalizeContext => ({ seq: 0, now: () => 1_000 });
type Notice = Extract<AgentEvent, { type: 'notice' }>;
const notices = (evs: AgentEvent[]): Notice[] => evs.filter((e): e is Notice => e.type === 'notice');
const recapMsg = (): SdkMessage => capture().stream[0];
const jsonl = (objs: unknown[]) => objs.map((o) => JSON.stringify(o)).join('\n');

// ─── live: normalize ─────────────────────────────────────────────────────────

test('live: the REAL /recap stream message renders ONE command-output notice with the unwrapped text', () => {
  const m = recapMsg();
  // Positive control on the fixture itself: it IS the shape under test (synthetic, tagged, wrapped).
  assert.equal((m.message as { model?: string }).model, '<synthetic>');
  assert.match(m.local_command_source!, /^<local-command-stdout>/);
  const evs = normalizeSdkMessage(m, ctx());
  assert.deepEqual(evs, [{ type: 'notice', seq: 0, at: 1000, kind: 'command-output', text: RECAP_TEXT }]);
});

test('live: every captured local command (/recap, /model, /help) yields exactly one clean notice', () => {
  const c = capture();
  assert.equal(c.stream.length, 3);
  const shared = ctx();
  const texts = c.stream.map((m) => {
    const ns = notices(normalizeSdkMessage(m, shared));
    assert.equal(ns.length, 1, `one notice for ${m.local_command_source!.slice(0, 40)}`);
    assert.equal(ns[0].kind, 'command-output');
    assert.doesNotMatch(ns[0].text, /<\/?local-command/, 'never raw XML');
    return ns[0].text;
  });
  assert.equal(texts[0], RECAP_TEXT);
  assert.match(texts[1], /^Current model: `Opus 5\.5 \(default\)`\nUsage: \/model <name>\./);
  assert.equal(texts[2], "/help isn't available in this environment.");
});

test('live: folded, the /recap bubble is followed by a command-output row (what the pane renders)', () => {
  const bubble = makeUserMessage(ctx(), '/recap');
  const c = ctx();
  c.seq = 1;
  const s = foldEvents(emptySession('ws1'), [bubble, ...normalizeSdkMessage(recapMsg(), c)]);
  assert.deepEqual(
    s.messages.map((m) => [m.role, m.noticeKind ?? null, m.text]),
    [['user', null, '/recap'], ['system', 'command-output', RECAP_TEXT]],
  );
});

test('live: an EMPTY output renders nothing (empty wrapper, blank text, whitespace wrapper)', () => {
  const base = recapMsg();
  const withSource = (src: string, text: string): SdkMessage => ({
    ...base,
    uuid: `empty-${src.length}-${text.length}`,
    local_command_source: src,
    message: { role: 'assistant', content: [{ type: 'text', text }] },
  });
  assert.deepEqual(normalizeSdkMessage(withSource('<local-command-stdout></local-command-stdout>', ''), ctx()), []);
  assert.deepEqual(normalizeSdkMessage(withSource('<local-command-stdout>  \n </local-command-stdout>', ' '), ctx()), []);
  assert.deepEqual(normalizeSdkMessage(withSource('', ''), ctx()), []);
});

test('live: a <local-command-stderr> wrapper is unwrapped too, and both streams join', () => {
  const base = recapMsg();
  const mk = (src: string): SdkMessage => ({ ...base, uuid: src, local_command_source: src });
  assert.equal(notices(normalizeSdkMessage(mk('<local-command-stderr>boom</local-command-stderr>'), ctx()))[0].text, 'boom');
  assert.equal(
    notices(normalizeSdkMessage(mk('<local-command-stdout>a</local-command-stdout><local-command-stderr>b</local-command-stderr>'), ctx()))[0].text,
    'a\nb',
  );
});

test('live: an UNWRAPPED local_command_source falls back to the message text blocks (still no XML)', () => {
  const m: SdkMessage = { ...recapMsg(), uuid: 'bare', local_command_source: 'not wrapped at all' };
  const ns = notices(normalizeSdkMessage(m, ctx()));
  assert.equal(ns.length, 1);
  assert.equal(ns[0].text, RECAP_TEXT, 'the CLI text blocks, never the raw source');
});

test('live: the REAL /compact re-emit (same uuid, new message.id) is dropped — rendered ONCE', () => {
  const { original, reemitted } = (capture() as Capture & { compactReemit: { original: SdkMessage; reemitted: SdkMessage } }).compactReemit;
  assert.equal(original.uuid, reemitted.uuid);
  assert.notEqual((original.message as { id?: string }).id, (reemitted.message as { id?: string }).id);
  const c = ctx();
  assert.equal(notices(normalizeSdkMessage(original, c)).length, 1);
  assert.deepEqual(normalizeSdkMessage(reemitted, c), [], 'the re-emit adds nothing');
  // Positive control: the same re-emit through a FRESH context (a session restart forgets) does render — the drop is the dedupe, not the shape.
  assert.equal(notices(normalizeSdkMessage(reemitted, ctx())).length, 1);
});

test('live: the CLI re-emits the same local-command message (same uuid) after /compact — rendered ONCE', () => {
  const c = ctx();
  const m = recapMsg();
  const first = normalizeSdkMessage(m, c);
  // The re-emit carries a different message.id but the SAME top-level uuid (measured at CLI 2.1.291).
  const again = normalizeSdkMessage({ ...m, message: { ...(m.message as object), id: 'other-id' } as SdkMessage['message'] }, c);
  assert.equal(notices(first).length, 1);
  assert.deepEqual(again, [], 'a replay of an already-rendered output adds nothing');
  // Distinct commands (distinct uuids) and uuid-less messages are never collapsed.
  assert.equal(notices(normalizeSdkMessage({ ...m, uuid: 'another' }, c)).length, 1);
  const noUuid = { ...m, uuid: undefined };
  assert.equal(notices(normalizeSdkMessage(noUuid, c)).length, 1);
  assert.equal(notices(normalizeSdkMessage(noUuid, c)).length, 1);
});

test('live: a dropped duplicate does not clobber the post-compact usage the gauge reads', () => {
  const c = ctx();
  const m = recapMsg();
  normalizeSdkMessage(m, c);
  c.lastApiCallUsage = { input_tokens: 878 }; // what compact_boundary records as post_tokens
  normalizeSdkMessage(m, c);
  assert.deepEqual(c.lastApiCallUsage, { input_tokens: 878 });
});

test('live: the uuid memory is bounded (oldest forgotten) and per-context', () => {
  const c = ctx();
  const m = recapMsg();
  for (let i = 0; i < 300; i++) normalizeSdkMessage({ ...m, uuid: `u${i}` }, c);
  assert.ok(c.localCommandUuids!.size <= 256, `cap holds (${c.localCommandUuids!.size})`);
  assert.equal(notices(normalizeSdkMessage({ ...m, uuid: 'u299' }, c)).length, 0, 'recent uuid still deduped');
  assert.equal(notices(normalizeSdkMessage({ ...m, uuid: 'u0' }, c)).length, 1, 'oldest uuid forgotten');
  assert.equal(notices(normalizeSdkMessage({ ...m, uuid: 'u299' }, ctx())).length, 1, 'another context has its own memory');
});

test('live: /context keeps lifting the gauge AND now shows its output as a row', () => {
  const ctxUsage = JSON.parse(
    fs.readFileSync(path.join(path.dirname(FIXTURE), 'context-command.usage.json'), 'utf8'),
  ) as SdkMessage['context_usage'];
  const m: SdkMessage = {
    ...recapMsg(),
    uuid: 'ctx-cmd',
    context_usage: ctxUsage,
    local_command_source: '<local-command-stdout>## Context Usage\n\n**Tokens:** 68k</local-command-stdout>',
    message: { role: 'assistant', content: [{ type: 'text', text: '## Context Usage\n\n**Tokens:** 68k' }] },
  };
  const evs = normalizeSdkMessage(m, ctx());
  assert.deepEqual(evs.map((e) => e.type), ['session/context', 'notice']);
  assert.equal((evs[1] as Notice).text, '## Context Usage\n\n**Tokens:** 68k');
});

test('live: an ordinary assistant message (and a synthetic one WITHOUT local_command_source) is unchanged', () => {
  const plain: SdkMessage = { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] } };
  assert.deepEqual(normalizeSdkMessage(plain, ctx()), [], 'text already streamed via stream_event: not lifted again');
  const synthetic: SdkMessage = { type: 'assistant', uuid: 'x', message: { role: 'assistant', content: [{ type: 'text', text: 'No response requested.' }] } };
  assert.deepEqual(normalizeSdkMessage(synthetic, ctx()), []);
  // A tool_use block in an ordinary assistant message is still lifted.
  const tool: SdkMessage = { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: {} } as never] } };
  assert.deepEqual(normalizeSdkMessage(tool, ctx()).map((e) => e.type), ['tool-use']);
});

test('wrappedCommandOutput: wrapper → text, empty wrapper → "", anything else → null', () => {
  const wrappedCommandOutput = events.wrappedCommandOutput;
  assert.equal(typeof wrappedCommandOutput, 'function');
  assert.equal(wrappedCommandOutput('<local-command-stdout>x</local-command-stdout>'), 'x');
  assert.equal(wrappedCommandOutput('<local-command-stdout></local-command-stdout>'), '');
  assert.equal(wrappedCommandOutput('/help'), null);
  assert.equal(wrappedCommandOutput(undefined), null);
  assert.equal(wrappedCommandOutput(42), null);
});

// ─── backfill: transcriptToEvents ────────────────────────────────────────────

test('backfill: the REAL transcript renders each command bubble followed by its output row', () => {
  const c = capture();
  const evs = transcriptToEvents(jsonl(c.transcript), ctx());
  const s = foldEvents(emptySession('ws1'), evs);
  assert.deepEqual(
    s.messages.map((m) => [m.role, m.noticeKind ?? null, m.text]),
    [
      ['user', null, 'hello'],
      ['assistant', null, 'Fake assistant reply for the probe.'],
      ['user', null, '/recap'],
      ['system', 'command-output', RECAP_TEXT],
      ['user', null, '/model'],
      ['system', 'command-output', (notices(evs)[1] as Notice).text],
      ['system', 'command-output', "/help isn't available in this environment."],
    ],
  );
  for (const m of s.messages) assert.doesNotMatch(m.text ?? '', /<\/?(local-command|command-)/, 'no raw XML anywhere');
});

test('backfill: the bare "/help" invocation echo is NOT rendered as output', () => {
  const evs = transcriptToEvents(jsonl(capture().transcript), ctx());
  assert.equal(notices(evs).some((n) => n.text === '/help'), false);
  assert.equal(notices(evs).length, 3, '/recap, /model and the /help refusal — nothing else');
});

test('backfill: empty / wrong-subtype / sidechain / non-string system lines render nothing', () => {
  const sys = (over: Record<string, unknown>) => ({ type: 'system', subtype: 'local_command', uuid: 's', isSidechain: false, ...over });
  const run = (lines: unknown[]) => notices(transcriptToEvents(jsonl(lines), ctx()));
  assert.deepEqual(run([sys({ content: '<local-command-stdout></local-command-stdout>' })]), [], 'empty wrapper (/clear ack)');
  assert.deepEqual(run([sys({ content: '<local-command-stdout>  </local-command-stdout>' })]), [], 'whitespace wrapper');
  assert.deepEqual(run([sys({ content: '/help' })]), [], 'bare invocation echo');
  assert.deepEqual(run([sys({ content: 42 })]), [], 'non-string content');
  assert.deepEqual(run([sys({})]), [], 'no content');
  assert.deepEqual(run([sys({ subtype: 'compact_boundary', content: '<local-command-stdout>x</local-command-stdout>' })]), [], 'only local_command lines are output');
  assert.deepEqual(run([sys({ isSidechain: true, content: '<local-command-stdout>sub</local-command-stdout>' })]), [], 'subagent transcript lines stay out');
  // Positive control: the same shape, wrapped + non-empty + main chain, DOES render.
  assert.equal(run([sys({ content: '<local-command-stdout>ok</local-command-stdout>' })])[0]?.text, 'ok');
});

test('backfill: the output row carries the line\'s real timestamp (not the reopen time)', () => {
  const line = { type: 'system', subtype: 'local_command', uuid: 's', timestamp: '2026-10-11T20:42:46.204Z', content: '<local-command-stdout>ok</local-command-stdout>' };
  const [n] = notices(transcriptToEvents(jsonl([line]), ctx()));
  assert.equal(n.at, Date.parse('2026-10-11T20:42:46.204Z'));
});

test('parity: for the same command the live row and the reopened row carry the SAME text', () => {
  const c = capture();
  const live = c.stream.map((m) => notices(normalizeSdkMessage(m, ctx()))[0].text);
  const back = notices(transcriptToEvents(jsonl(c.transcript), ctx())).map((n) => n.text);
  assert.deepEqual(back, live);
  // The pairing is by uuid in the capture: each stream message has its transcript twin.
  for (const m of c.stream) assert.ok(c.transcript.some((t) => t.uuid === m.uuid), `twin for ${m.uuid}`);
});
