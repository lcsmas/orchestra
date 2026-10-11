// Accès mobile #337: the phone projection, driven through the REAL backfill path — a transcript captured from the Claude Code CLI
// (structure untouched, texts replaced) → transcriptToEvents → foldEvents (the desktop's fold) → projectConversation.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { transcriptToEvents } from './agent-transcript.ts';
import { emptySession, foldEvent, foldEvents } from './agent-events.ts';
import { MAX_PHONE_LINES, projectConversation, toolLabel, validWorkspaceId } from './acces-mobile-conversation.ts';
import type { AgentEvent, AgentSession } from './types.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SAMPLE = fs.readFileSync(path.join(root, 'scripts/fixtures/payloads/acces-mobile-transcript.sample.jsonl'), 'utf8');

function folded(jsonl = SAMPLE): AgentSession {
  const events = transcriptToEvents(jsonl, { seq: 1_000_000, now: () => 1_700_000_000_000 }, 'claude-opus-5-5');
  assert.ok(events.length > 0, 'instrument: the captured transcript produced events');
  return foldEvents(emptySession('ws-1'), events);
}

test('a real transcript reads on the phone: user, one line per tool, assistant', () => {
  const c = projectConversation('ws-1', folded(), 7);
  assert.equal(c.ok, true);
  assert.equal(c.version, 7);
  assert.deepEqual(
    c.lines.map((l) => l.kind),
    ['user', 'tool', 'assistant'],
  );
  const [u, t, a] = c.lines;
  assert.equal(u.kind === 'user' && u.text, 'Liste les fichiers du dépôt, s’il te plaît.');
  assert.equal(t.kind === 'tool' && t.label, 'Bash · List repository files');
  assert.equal(t.kind === 'tool' && t.state, 'ok', 'the tool_result in the transcript closes the call');
  assert.equal(a.kind === 'assistant' && a.text, 'Voici les fichiers : README.md et src/.');
  assert.equal(c.asks.length, 0);
  assert.equal(c.truncated, 0);
});

test('a pending AskUserQuestion becomes an askUser block with its options; anything else is « desktop »', () => {
  const s = folded();
  const ask: AgentEvent = {
    type: 'permission-request',
    seq: 2_000_000,
    at: 1_700_000_000_500,
    requestId: 'req-1',
    toolUseId: 'toolu_x',
    name: 'AskUserQuestion',
    input: { questions: [{ question: 'Quelle base ?', header: 'Base', multiSelect: false, options: [{ label: 'master', description: 'la branche par défaut' }, { label: 'main' }] }] },
  } as AgentEvent;
  const elicit: AgentEvent = { type: 'elicitation-request', seq: 2_000_001, at: 1_700_000_000_600, requestId: 'req-2', serverName: 'linear', message: 'Autoriser ?', mode: 'form' } as AgentEvent;
  const c = projectConversation('ws-1', foldEvent(foldEvent(s, ask), elicit), 1);
  assert.equal(c.asks.length, 2, `asks: ${JSON.stringify(c.asks)}`);
  const a = c.asks.find((x) => x.requestId === 'req-1');
  assert.ok(a && a.kind === 'askUser');
  if (a && a.kind === 'askUser') {
    assert.equal(a.questions[0].question, 'Quelle base ?');
    assert.deepEqual(a.questions[0].options.map((o) => o.label), ['master', 'main']);
  }
  const d = c.asks.find((x) => x.requestId === 'req-2');
  assert.ok(d && d.kind === 'desktop' && /linear/.test(d.title));
});

test('only the last MAX_PHONE_LINES lines travel, and the cut is counted', () => {
  const one = SAMPLE.split('\n')[0];
  const many = Array.from({ length: MAX_PHONE_LINES + 30 }, (_, i) => {
    const d = JSON.parse(one);
    d.uuid = `u-${i}`;
    d.message.content = `message ${i}`;
    return JSON.stringify(d);
  }).join('\n');
  const c = projectConversation('ws-1', folded(many), 1);
  assert.equal(c.lines.length, MAX_PHONE_LINES);
  assert.equal(c.truncated, 30);
  const last = c.lines.at(-1);
  assert.equal(last?.kind === 'user' && last.text, `message ${MAX_PHONE_LINES + 29}`, 'the newest line is kept');
});

test('toolLabel: the one useful detail per tool, MCP names shortened', () => {
  assert.equal(toolLabel('Read', { file_path: '/a/b/c/d.ts' }), 'Read · c/d.ts');
  assert.equal(toolLabel('Grep', { pattern: 'foo' }), 'Grep · foo');
  assert.equal(toolLabel('mcp__linear-server__get_issue', { id: 'NMC-1' }), 'linear-server.get_issue · NMC-1');
  assert.equal(toolLabel('TodoWrite', {}), 'TodoWrite');
});

test('workspace ids: uuid-like only', () => {
  assert.equal(validWorkspaceId('4a6ad23b-ebee-497c-b67a-80ff69edf6f5'), true);
  for (const bad of ['', '../x', 'a b', 'x'.repeat(65), 42, null]) assert.equal(validWorkspaceId(bad), false, String(bad));
});
