// Pure-logic tests for the structured-agent-view components (A3).
//
// The `node --test --experimental-strip-types` runner strips types but does NOT
// transform JSX, so React render tests can't live here (they run via a separate
// esbuild harness — see agent-render-smoke.mjs). What IS testable here — and
// where the real bugs would be — is the markdown parser and the tool-input
// helpers that drive every card. These are exercised against the exact shapes
// the A1 contract's RenderMessage carries.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMarkdown } from './markdown-parse.ts';
import {
  resultText,
  inputStr,
  summarizeInput,
  truncate,
  todosFrom,
  describeToolRun,
  aggregateDiff,
  fileBase,
  type ToolLike,
} from './tool-util.ts';

/** Terse ToolLike builder for the run-summary tests. */
function tl(name: string, input: Record<string, unknown> = {}): ToolLike {
  return { name, input };
}

test('parseMarkdown splits fenced code from prose', () => {
  const blocks = parseMarkdown('intro\n\n```ts\nconst x = 1;\n```\n\nafter');
  assert.equal(blocks.length, 3);
  assert.equal(blocks[0].kind, 'html');
  assert.equal(blocks[1].kind, 'code');
  assert.equal(blocks[2].kind, 'html');
  if (blocks[1].kind === 'code') {
    assert.equal(blocks[1].lang, 'ts');
    assert.equal(blocks[1].text, 'const x = 1;');
  }
});

test('parseMarkdown handles a still-streaming (unclosed) fence', () => {
  // Mid-stream the closing fence hasn't arrived yet — must not throw and must
  // capture the partial body as a code block.
  const blocks = parseMarkdown('```js\nconst partial =');
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].kind, 'code');
  if (blocks[0].kind === 'code') {
    assert.equal(blocks[0].lang, 'js');
    assert.equal(blocks[0].text, 'const partial =');
  }
});

test('parseMarkdown tolerates empty / whitespace input', () => {
  assert.deepEqual(parseMarkdown(''), []);
  assert.deepEqual(parseMarkdown('   '), []); // whitespace-only → no blocks
});

test('resultText flattens string and content-block-array results', () => {
  assert.equal(resultText('plain'), 'plain');
  assert.equal(resultText(undefined), '');
  assert.equal(
    resultText([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }]),
    'a\nb'
  );
  // Unknown block shape falls back to JSON, never dropped.
  assert.match(resultText([{ foo: 1 }]), /foo/);
});

test('inputStr reads string fields and guards non-strings', () => {
  assert.equal(inputStr({ file_path: '/a/b.ts' }, 'file_path'), '/a/b.ts');
  assert.equal(inputStr({ n: 5 }, 'n'), '');
  assert.equal(inputStr(undefined, 'x'), '');
});

test('summarizeInput picks the right field per tool', () => {
  assert.equal(summarizeInput('Bash', { command: 'ls -la' }), 'ls -la');
  assert.equal(summarizeInput('Read', { file_path: '/x.ts' }), '/x.ts');
  assert.equal(summarizeInput('Grep', { pattern: 'foo' }), 'foo');
  assert.equal(
    summarizeInput('Task', { subagent_type: 'Explore', description: 'search' }),
    'search'
  );
  // Unknown tool → first string arg.
  assert.equal(summarizeInput('Mystery', { a: 1, b: 'hi' }), 'hi');
});

test('truncate collapses whitespace and caps length', () => {
  assert.equal(truncate('a   b\n c'), 'a b c');
  assert.equal(truncate('x'.repeat(200)).length, 120);
  assert.ok(truncate('x'.repeat(200)).endsWith('…'));
});

test('todosFrom parses and defaults a TodoWrite input', () => {
  const todos = todosFrom({
    todos: [
      { content: 'A', status: 'completed' },
      { content: 'B', status: 'in_progress', activeForm: 'Doing B' },
      { content: 'C', status: 'weird' }, // unknown status → pending
      null, // junk → dropped
    ],
  });
  assert.equal(todos.length, 3);
  assert.equal(todos[0].status, 'completed');
  assert.equal(todos[1].activeForm, 'Doing B');
  assert.equal(todos[2].status, 'pending');
  assert.deepEqual(todosFrom(undefined), []);
  assert.deepEqual(todosFrom({ todos: 'not-array' }), []);
});

test('describeToolRun uses claude.ai verb style', () => {
  // All creates → "Created N files"; single create names the file.
  assert.equal(
    describeToolRun([tl('Write', { file_path: 'a.ts' }), tl('Edit', { file_path: 'b.ts' })]),
    'Created 2 files',
  );
  assert.equal(describeToolRun([tl('Write', { file_path: 'src/types.ts' })]), 'Created types.ts');
  // All reads.
  assert.equal(describeToolRun([tl('Read'), tl('Read'), tl('Read')]), 'Read 3 files');
  assert.equal(describeToolRun([tl('Read', { file_path: 'x/y.ts' })]), 'Read y.ts');
  // Bash-only.
  assert.equal(describeToolRun([tl('Bash')]), 'Ran a command');
  assert.equal(describeToolRun([tl('Bash'), tl('Bash')]), 'Ran 2 commands');
  // Bash + one other → the "Ran a command, used a tool" phrasing.
  assert.equal(describeToolRun([tl('Bash'), tl('Read')]), 'Ran a command, used a tool');
  // Mixed / unknown → plain tool count.
  assert.equal(describeToolRun([tl('Read'), tl('Grep'), tl('Task')]), 'Used 3 tools');
  assert.equal(describeToolRun([tl('Mystery')]), 'Used a tool');
  assert.equal(describeToolRun([]), 'Used a tool');
});

test('aggregateDiff sums added/removed lines across Edit/Write only', () => {
  const run = [
    tl('Write', { content: 'a\nb\nc' }), // +3 -0
    tl('Edit', { old_string: 'x\ny', new_string: 'x\ny\nz\nw' }), // +4 -2
    tl('Bash', { command: 'ls' }), // ignored
  ];
  assert.deepEqual(aggregateDiff(run), { added: 7, removed: 2 });
  assert.deepEqual(aggregateDiff([tl('Read')]), { added: 0, removed: 0 });
});

test('fileBase returns the last path segment', () => {
  assert.equal(fileBase('src/a/b.ts'), 'b.ts');
  assert.equal(fileBase('b.ts'), 'b.ts');
  assert.equal(fileBase(''), '');
  assert.equal(fileBase('trailing/'), 'trailing');
});
