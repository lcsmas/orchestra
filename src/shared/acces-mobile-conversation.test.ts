// Accès mobile #337: the phone projection, driven through the REAL backfill path — a transcript captured from the Claude Code CLI
// (structure untouched, texts replaced) → transcriptToEvents → foldEvents (the desktop's fold) → projectConversation.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { transcriptToEvents } from './agent-transcript.ts';
import { emptySession, foldEvent, foldEvents } from './agent-events.ts';
import { MAX_PHONE_CHARS, MAX_PHONE_LINES, MAX_PHONE_TEXT, MOBILE_ATTACH_MAX_COUNT, parseMobileAttachments, projectConversation, toolLabel, validWorkspaceId } from './acces-mobile-conversation.ts';
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
    d.parentUuid = i ? `u-${i - 1}` : null; // chained like a real transcript (siblings of one parent = a rewind fork)
    d.message.content = `message ${i}`;
    return JSON.stringify(d);
  }).join('\n');
  const c = projectConversation('ws-1', folded(many), 1);
  assert.equal(c.lines.length, MAX_PHONE_LINES);
  assert.equal(c.truncated, 30);
  const last = c.lines.at(-1);
  assert.equal(last?.kind === 'user' && last.text, `message ${MAX_PHONE_LINES + 29}`, 'the newest line is kept');
});

test('a long answer travels WHOLE (4000 cut it mid-sentence on the iPhone); the projection keeps the newest within MAX_PHONE_CHARS', () => {
  const one = SAMPLE.split('\n')[0];
  const mk = (n: number, len: number) =>
    Array.from({ length: n }, (_, i) => {
      const d = JSON.parse(one);
      d.uuid = `u-${i}`;
      d.parentUuid = i ? `u-${i - 1}` : null;
      d.message.content = `${i}:` + 'x'.repeat(len);
      return JSON.stringify(d);
    }).join('\n');
  const long = projectConversation('ws-1', folded(mk(1, 12_000)), 1);
  assert.equal(long.lines[0].kind === 'user' && long.lines[0].text.length, 12_002, 'a 12 000-char message is not clipped');
  assert.ok(MAX_PHONE_TEXT * 2 <= MAX_PHONE_CHARS);
  const per = 60_000;
  const big = projectConversation('ws-1', folded(mk(40, per)), 1);
  const kept = Math.floor(MAX_PHONE_CHARS / (per + 3));
  assert.equal(big.lines.length, kept, 'only what fits in the budget');
  assert.equal(big.truncated, 40 - kept, 'the cut is counted');
  const last = big.lines.at(-1);
  assert.ok(last?.kind === 'user' && last.text.startsWith('39:'), 'the newest line is kept');
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

test('#339: an answerable-resolved event (from ANY surface) removes the ask from the fold', () => {
  const ask = { type: 'permission-request', seq: 2_000_000, at: 1, requestId: 'req-9', toolUseId: null, name: 'AskUserQuestion', input: { questions: [{ question: 'Q', options: [{ label: 'a' }] }] } } as unknown as AgentEvent;
  const resolved = { type: 'answerable-resolved', seq: 2_000_001, at: 2, kind: 'permission', requestId: 'req-9' } as AgentEvent;
  const withAsk = foldEvent(folded(), ask);
  assert.equal(projectConversation('w', withAsk, 1).asks.length, 1, 'control');
  assert.equal(projectConversation('w', foldEvent(withAsk, resolved), 2).asks.length, 0);
  const other = { ...resolved, kind: 'elicitation' } as AgentEvent;
  assert.equal(projectConversation('w', foldEvent(withAsk, other), 2).asks.length, 1, 'kind + id must both match');
});

test('final review m4: an AskUserQuestion travels with its FULL question and option texts (main matches them exactly)', () => {
  const longQ = 'Q'.repeat(1500) + ' ?';
  const longLabel = 'option   with  spaces ' + 'L'.repeat(300);
  const ask = { type: 'permission-request', seq: 2_000_000, at: 1, requestId: 'r', toolUseId: null, name: 'AskUserQuestion', input: { questions: [{ question: longQ, options: [{ label: longLabel }] }] } } as unknown as AgentEvent;
  const a = projectConversation('w', foldEvent(folded(), ask), 1).asks[0];
  assert.ok(a.kind === 'askUser');
  if (a.kind === 'askUser') {
    assert.equal(a.questions[0].question, longQ);
    assert.equal(a.questions[0].options[0].label, longLabel);
  }
});

test('phone attachments: images + PDFs of an API type with canonical base64, at most MOBILE_ATTACH_MAX_COUNT', () => {
  const png = { mediaType: 'image/png', dataBase64: 'iVBORw0KGgo=' };
  const pdf = { mediaType: 'application/pdf', dataBase64: 'JVBERi0xLjQK' };
  assert.deepEqual(parseMobileAttachments(undefined), { ok: true, images: [] });
  assert.deepEqual(parseMobileAttachments([png, pdf]), { ok: true, images: [png, pdf] });
  assert.deepEqual(parseMobileAttachments([{ ...png, extra: 1 }]), { ok: true, images: [png] }, 'only the two fields travel');
  const refused = (x: unknown) => parseMobileAttachments(x).ok === false;
  assert.ok(refused('x'), 'not a list');
  assert.ok(refused(Array.from({ length: MOBILE_ATTACH_MAX_COUNT + 1 }, () => png)), 'too many');
  assert.ok(!refused(Array.from({ length: MOBILE_ATTACH_MAX_COUNT }, () => png)), 'the cap itself is allowed');
  assert.ok(refused([{ mediaType: 'image/heic', dataBase64: 'AAAA' }]), 'a type the API does not take');
  assert.ok(refused([{ mediaType: 'text/html', dataBase64: 'AAAA' }]));
  assert.ok(refused([{ mediaType: 'image/png', dataBase64: '' }]), 'empty');
  assert.ok(refused([{ mediaType: 'image/png', dataBase64: 'data:image/png;base64,AAAA' }]), 'a data URL is not base64');
  assert.ok(refused([{ mediaType: 'image/png', dataBase64: 'AAA' }]), 'length not a multiple of 4');
  assert.ok(refused([{ mediaType: 'image/png', dataBase64: 'AA\nAA==' }]), 'whitespace');
  assert.ok(refused([null]));
});

test('a user turn with attachments reads on the phone with them counted (even without text)', () => {
  const ev = (seq: number, text: string, images?: { mediaType: string; dataBase64: string }[]) =>
    ({ type: 'user-message', seq, at: seq, text, ...(images ? { images } : {}) }) as unknown as AgentEvent;
  let s = foldEvent(emptySession(), ev(1, 'Regarde', [{ mediaType: 'image/jpeg', dataBase64: 'AAAA' }, { mediaType: 'application/pdf', dataBase64: 'AAAA' }]));
  s = foldEvent(s, ev(2, '', [{ mediaType: 'image/png', dataBase64: 'AAAA' }]));
  s = foldEvent(s, ev(3, 'texte seul'));
  const lines = projectConversation('w', s, 1).lines.map((l) => (l.kind === 'user' ? { text: l.text, attachments: l.attachments } : null));
  assert.deepEqual(lines, [
    { text: 'Regarde', attachments: ['image', 'pdf'] },
    { text: '', attachments: ['image'] },
    { text: 'texte seul', attachments: undefined },
  ]);
});
