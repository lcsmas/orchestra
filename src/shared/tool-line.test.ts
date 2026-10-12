// #374: the ONE tool line (label + state + glyph) both surfaces call. The phone's projection and the desktop's render-item builder
// must agree row for row — see agent-render-items.test.ts for the desktop side.
import test from 'node:test';
import assert from 'node:assert/strict';
import { TOOL_GLYPH, oneLine, oneLineScan, toolLabel, toolLine, toolState } from './tool-line.ts';
import { CONVERSATION_JS } from '../acces-mobile/conversation.ts';
import type { RenderMessage } from './types.ts';

test('toolLabel: the one useful detail per tool, MCP names shortened, detail clipped to one line', () => {
  assert.equal(toolLabel('Bash', { description: 'run the suite', command: 'pnpm test' }), 'Bash · run the suite');
  assert.equal(toolLabel('Bash', { command: 'pnpm test' }), 'Bash · pnpm test');
  assert.equal(toolLabel('Edit', { file_path: '/a/b/shared/foo.ts' }), 'Edit · shared/foo.ts');
  assert.equal(toolLabel('Grep', { pattern: 'foo' }), 'Grep · foo');
  assert.equal(toolLabel('mcp__linear-server__get_issue', { id: 'NMC-1' }), 'linear-server.get_issue · NMC-1');
  assert.equal(toolLabel('TodoWrite', {}), 'TodoWrite');
  const long = toolLabel('Bash', { command: `echo ${'x'.repeat(300)}\nsecond line` });
  assert.equal(long.length, 'Bash · '.length + 100 + 1, 'detail clipped to 100 chars + an ellipsis');
  assert.ok(long.endsWith('…'));
  assert.ok(!toolLabel('Bash', { command: 'a\nb' }).includes('\n'), 'one line');
});

test('toolLabel: every known tool names its useful detail (Glob/WebFetch/WebSearch/Task/Agent/Skill/MultiEdit/NotebookEdit/default)', () => {
  assert.equal(toolLabel('Glob', { pattern: '**/*.ts' }), 'Glob · **/*.ts');
  assert.equal(toolLabel('WebFetch', { url: 'https://example.com/a', prompt: 'x' }), 'WebFetch · https://example.com/a');
  assert.equal(toolLabel('WebSearch', { query: 'node test runner' }), 'WebSearch · node test runner');
  assert.equal(toolLabel('Task', { description: 'review the diff', prompt: 'long brief' }), 'Task · review the diff');
  assert.equal(toolLabel('Agent', { description: 'lens 2', prompt: 'long brief' }), 'Agent · lens 2');
  assert.equal(toolLabel('Skill', { skill: 'ship', args: 'x' }), 'Skill · ship');
  assert.equal(toolLabel('MultiEdit', { file_path: '/a/b/c/d.ts', edits: [] }), 'MultiEdit · c/d.ts');
  assert.equal(toolLabel('NotebookEdit', { notebook_path: '/a/b/n.ipynb' }), 'NotebookEdit · b/n.ipynb');
  assert.equal(toolLabel('Mystery', { n: 1, first: 'alpha', second: 'beta' }), 'Mystery · alpha', 'unknown tool: the first string input');
  assert.equal(toolLabel('Mystery', { n: 1 }), 'Mystery');
  assert.equal(toolLabel('Mystery', undefined), 'Mystery', 'input still streaming');
});

const naiveOneLine = (s: string, n: number): string => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
};

test('oneLine: byte-identical to the whole-string collapse on whitespace-heavy / multi-byte / boundary inputs (the windowed scan is exact)', () => {
  let seed = 0x9e3779b9;
  const rnd = () => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const alphabet = ['a', 'b', 'é', '😀', ' ', ' ', '\n', '\t', '\u00a0'];
  let checked = 0;
  for (let i = 0; i < 400; i++) {
    const len = Math.floor(rnd() * (i % 4 === 0 ? 6000 : 400));
    let s = '';
    for (let k = 0; k < len; k++) {
      // long whitespace gaps so the collapsed head stays short past the first windows
      s += rnd() < 0.002 ? ' '.repeat(Math.floor(rnd() * 5000)) : alphabet[Math.floor(rnd() * alphabet.length)];
    }
    for (const n of [0, 1, 40, 100, 120]) { assert.equal(oneLine(s, n), naiveOneLine(s, n), `len ${s.length} n ${n}`); checked++; }
  }
  assert.ok(checked >= 2000, 'instrument: the property ran');
  for (const [s, n] of [['a' + ' '.repeat(9000) + 'tail', 100], [' '.repeat(9000) + 'tail', 100], ['x'.repeat(799) + ' '.repeat(2000) + 'y', 100], ['é'.repeat(5000), 100]] as [string, number][]) assert.equal(oneLine(s, n), naiveOneLine(s, n));
});

test('oneLine: the work is bounded — a 1 MB command is examined over a small window, a whitespace-heavy one still reads far enough', () => {
  const big = 'x '.repeat(500_000);
  const { scanned, text } = oneLineScan(big, 100);
  assert.ok(scanned <= 1000, `scanned ${scanned} of ${big.length} chars (a bounded window)`);
  assert.equal(text, naiveOneLine(big, 100));
  assert.equal(oneLineScan('a' + ' '.repeat(9000) + 'tail', 100).text, 'a tail', 'whitespace-heavy: the window grows until the head is long enough');
  assert.equal(oneLineScan('short', 100).scanned, 5);
});

test('toolLine: an empty tool name still gets a label', () => {
  assert.equal(toolLine({ toolUse: { toolUseId: 'x', name: '', inputJson: '' } }).label, 'tool');
});

const tool = (result?: { isError: boolean }): RenderMessage => ({
  id: 't1',
  role: 'tool',
  toolUse: { toolUseId: 't1', name: 'Bash', inputJson: '', input: { description: 'ls' } },
  ...(result ? { toolResult: { content: 'x', isError: result.isError } } : {}),
});

test('toolState: running until the result lands, then error (isError) or ok', () => {
  assert.equal(toolState(tool()), 'running');
  assert.equal(toolState(tool({ isError: false })), 'ok');
  assert.equal(toolState(tool({ isError: true })), 'error');
});

test('toolLine: label + state of a tool message; a message without toolUse still has a label', () => {
  assert.deepEqual(toolLine(tool({ isError: true })), { label: 'Bash · ls', state: 'error' });
  assert.deepEqual(toolLine({}), { label: 'tool', state: 'running' });
});

test('the glyphs: … running, ✓ ok, ✗ error — and the phone page carries the same map', () => {
  assert.deepEqual(TOOL_GLYPH, { running: '…', ok: '✓', error: '✗' });
  assert.ok(CONVERSATION_JS.includes(`var STATE = ${JSON.stringify(TOOL_GLYPH)};`), 'the phone page injects the shared glyph map');
});
