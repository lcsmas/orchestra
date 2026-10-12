// #374: the ONE tool line (label + state + glyph) both surfaces call. The phone's projection and the desktop's render-item builder
// must agree row for row — see agent-render-items.test.ts for the desktop side.
import test from 'node:test';
import assert from 'node:assert/strict';
import { TOOL_GLYPH, toolLabel, toolLine, toolState } from './tool-line.ts';
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
