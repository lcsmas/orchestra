// #374: the desktop render-item builder — one always-visible row per tool (the phone's label + state), no summary, TodoWrite standalone.
// Driven with the REAL captured transcript (the phone's fixture) through the desktop fold, plus literal tool messages for the
// error / running / TodoWrite shapes.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { transcriptToEvents } from './agent-transcript.ts';
import { emptySession, foldEvents } from './agent-events.ts';
import { projectConversation } from './acces-mobile-conversation.ts';
import { buildRenderItems, type RenderItem, type ToolRow } from './agent-render-items.ts';
import type { RenderMessage } from './types.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SAMPLE = fs.readFileSync(path.join(root, 'scripts/fixtures/payloads/acces-mobile-transcript.sample.jsonl'), 'utf8');

const tool = (id: string, name: string, input: Record<string, unknown>, result?: { isError: boolean; content?: string }): RenderMessage => ({
  id,
  role: 'tool',
  toolUse: { toolUseId: id, name, inputJson: '', input },
  ...(result ? { toolResult: { content: result.content ?? 'out', isError: result.isError } } : {}),
  done: true,
});
const text = (id: string, role: 'assistant' | 'user', t: string): RenderMessage => ({ id, role, text: t, done: true });
const groups = (items: RenderItem[]) => items.filter((i): i is Extract<RenderItem, { kind: 'tool-group' }> => i.kind === 'tool-group');
const rowsOf = (rows: ToolRow[]) => rows.map((r) => `${r.state} ${r.label}`);

test('one row per tool: a run of consecutive tools is ONE group with the phone label + state of each', () => {
  const items = buildRenderItems([
    text('a0', 'assistant', 'looking'),
    tool('t1', 'Bash', { description: 'run the suite', command: 'pnpm test' }, { isError: false }),
    tool('t2', 'Bash', { command: 'grep -r nothing .' }, { isError: true, content: 'exit 1' }),
    tool('t3', 'Edit', { file_path: '/repo/src/shared/foo.ts', old_string: 'a', new_string: 'b' }),
    text('a1', 'assistant', 'done'),
  ]);
  assert.deepEqual(items.map((i) => i.kind), ['message', 'tool-group', 'message']);
  const [g] = groups(items);
  assert.equal(g.id, 'tg:t1', 'the group id is its first tool id — stable while the run grows');
  assert.deepEqual(rowsOf(g.rows), ['ok Bash · run the suite', 'error Bash · grep -r nothing .', 'running Edit · shared/foo.ts']);
  assert.deepEqual(g.rows.map((r) => r.id), ['t1', 't2', 't3']);
  assert.equal(g.rows[2].message.toolUse?.name, 'Edit', 'the row keeps its message — the click opens that tool card');
});

test('a lone tool is still one row (no card, no summary)', () => {
  const [g] = groups(buildRenderItems([tool('t1', 'Read', { file_path: '/a/b/c.ts' }, { isError: false })]));
  assert.deepEqual(rowsOf(g.rows), ['ok Read · b/c.ts']);
});

test('no summary: a group carries only its rows — no « Used N tools » verb, no aggregate diff, no ±diff on an Edit/Write row', () => {
  const items = buildRenderItems([
    tool('t1', 'Write', { file_path: '/r/a.ts', content: 'a\nb\nc' }, { isError: false }),
    tool('t2', 'Edit', { file_path: '/r/b.ts', old_string: 'x\ny', new_string: 'x\ny\nz\nw' }, { isError: false }),
    tool('t3', 'Read', { file_path: '/r/c.ts' }, { isError: false }),
  ]);
  const [g] = groups(items);
  assert.deepEqual(Object.keys(g).sort(), ['id', 'kind', 'rows']);
  for (const r of g.rows) {
    assert.deepEqual(Object.keys(r).sort(), ['id', 'label', 'message', 'state']);
    assert.ok(!/[+−-]\d|^(Used|Created|Ran|Read \d)/.test(r.label), `no verb summary / diff count in "${r.label}"`);
  }
  assert.deepEqual(rowsOf(g.rows), ['ok Write · r/a.ts', 'ok Edit · r/b.ts', 'ok Read · r/c.ts']);
});

test('TodoWrite stays standalone: it breaks the run and renders as its own message item', () => {
  const items = buildRenderItems([
    tool('t1', 'Bash', { command: 'ls' }, { isError: false }),
    tool('t2', 'TodoWrite', { todos: [{ content: 'A', status: 'pending', activeForm: 'Doing A' }] }, { isError: false }),
    tool('t3', 'Bash', { command: 'pwd' }),
  ]);
  assert.deepEqual(items.map((i) => i.kind), ['tool-group', 'message', 'tool-group']);
  assert.equal(items[1].kind === 'message' && items[1].message.toolUse?.name, 'TodoWrite');
  assert.deepEqual(groups(items).map((g) => rowsOf(g.rows)), [['ok Bash · ls'], ['running Bash · pwd']]);
});

test('a failed tool is a row in the error state, not a group-level flag; a running one has no result yet', () => {
  const [g] = groups(buildRenderItems([tool('t1', 'Bash', { command: 'false' }, { isError: true }), tool('t2', 'Bash', { command: 'sleep 9' })]));
  assert.deepEqual(g.rows.map((r) => r.state), ['error', 'running']);
});

test('MCP tools read server.tool, as on the phone', () => {
  const [g] = groups(buildRenderItems([tool('t1', 'mcp__linear-server__get_issue', { id: 'NMC-1' }, { isError: false })]));
  assert.deepEqual(rowsOf(g.rows), ['ok linear-server.get_issue · NMC-1']);
});

test('ONE label function: on a real captured transcript the desktop rows equal the phone tool lines, label and state', () => {
  const events = transcriptToEvents(SAMPLE, { seq: 1_000_000, now: () => 1_700_000_000_000 }, 'claude-opus-5-5');
  const session = foldEvents(emptySession('ws-1'), events);
  const phone = projectConversation('ws-1', session, 1).lines.flatMap((l) => (l.kind === 'tool' ? [`${l.state} ${l.label}`] : []));
  const desktop = groups(buildRenderItems(session.messages)).flatMap((g) => rowsOf(g.rows));
  assert.ok(phone.length > 0, 'instrument: the transcript holds at least one tool');
  assert.deepEqual(desktop, phone);
  assert.deepEqual(desktop, ['ok Bash · List repository files']);
});

test('unchanged by the extraction: a peer delivery breaks the run, an `orchestra ack` card folds away', () => {
  const peer: RenderMessage = { id: 'p1', role: 'user', text: 'hi', origin: 'peer: other', done: true };
  const items = buildRenderItems([
    tool('t1', 'Bash', { command: 'ls' }, { isError: false }),
    peer,
    tool('t2', 'Bash', { command: 'orchestra ack 312' }, { isError: false }),
    tool('t3', 'Bash', { command: 'pwd' }, { isError: false }),
  ]);
  assert.deepEqual(items.map((i) => i.kind), ['tool-group', 'peer-group', 'tool-group']);
  assert.deepEqual(groups(items).map((g) => rowsOf(g.rows)), [['ok Bash · ls'], ['ok Bash · pwd']]);
});
