import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitMarkdownBlocks, partitionStreamingMarkdown } from './markdown-blocks.ts';

// The load-bearing invariant: joining the blocks reproduces the input byte-for-
// byte. If this holds, a stable block's text is IDENTICAL to its slice of the
// full document, so rendering it in isolation can't drift from the whole-doc
// render. Every case below also asserts round-trip.
function roundtrip(text: string) {
  assert.equal(splitMarkdownBlocks(text).join(''), text, `round-trip failed for: ${JSON.stringify(text)}`);
}

test('empty string → no blocks', () => {
  assert.deepEqual(splitMarkdownBlocks(''), []);
  roundtrip('');
});

test('single block, no blank lines', () => {
  const t = 'hello world';
  assert.deepEqual(splitMarkdownBlocks(t), ['hello world']);
  roundtrip(t);
});

test('two paragraphs split on blank line', () => {
  const t = 'first para\n\nsecond para';
  assert.deepEqual(splitMarkdownBlocks(t), ['first para\n\n', 'second para']);
  roundtrip(t);
});

test('trailing separator stays with the preceding block', () => {
  const t = 'a\n\nb\n\n';
  const blocks = splitMarkdownBlocks(t);
  assert.deepEqual(blocks, ['a\n\n', 'b\n\n']);
  roundtrip(t);
});

test('multiple consecutive blank lines collapse into one boundary', () => {
  const t = 'a\n\n\n\nb';
  assert.deepEqual(splitMarkdownBlocks(t), ['a\n\n\n\n', 'b']);
  roundtrip(t);
});

test('does NOT split inside a fenced code block (blank lines within a fence)', () => {
  const t = 'intro\n\n```js\nconst a = 1;\n\nconst b = 2;\n```\n\nafter';
  const blocks = splitMarkdownBlocks(t);
  // The fence with its internal blank line must be ONE block.
  assert.equal(blocks.length, 3);
  assert.equal(blocks[0], 'intro\n\n');
  assert.equal(blocks[1], '```js\nconst a = 1;\n\nconst b = 2;\n```\n\n');
  assert.equal(blocks[2], 'after');
  roundtrip(t);
});

test('tilde fences are fence-aware too', () => {
  const t = '~~~\nx\n\ny\n~~~\n\ntail';
  const blocks = splitMarkdownBlocks(t);
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0], '~~~\nx\n\ny\n~~~\n\n');
  roundtrip(t);
});

test('an UNCLOSED fence (mid-stream) keeps the rest in one block', () => {
  // While streaming a code block, the closing ``` hasn\'t arrived yet. Its blank
  // lines must not split, or the half-written block would flicker apart.
  const t = 'before\n\n```py\nline1\n\nline2\n';
  const blocks = splitMarkdownBlocks(t);
  assert.equal(blocks.length, 2);
  assert.equal(blocks[1], '```py\nline1\n\nline2\n');
  roundtrip(t);
});

test('closing fence must be at least as long as the opening run', () => {
  // ```` (4) opened; ``` (3) inside is NOT a close, so no split there.
  const t = '````\na\n\n```\nb\n\n````\n\nend';
  const blocks = splitMarkdownBlocks(t);
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0], '````\na\n\n```\nb\n\n````\n\n');
  assert.equal(blocks[1], 'end');
  roundtrip(t);
});

test('leading blank lines do not emit an empty first block', () => {
  const t = '\n\nreal content';
  const blocks = splitMarkdownBlocks(t);
  assert.equal(blocks[0], '\n\nreal content');
  roundtrip(t);
});

test('table + list + code, realistic multi-block message', () => {
  const t =
    'Here is the plan.\n\n' +
    '- one\n- two\n\n' +
    '| A | B |\n|---|---|\n| 1 | 2 |\n\n' +
    '```ts\nconst x = 1;\n```\n';
  const blocks = splitMarkdownBlocks(t);
  assert.equal(blocks.length, 4);
  roundtrip(t);
});

test('partition: done → all stable, no active tail', () => {
  const t = 'a\n\nb\n\nc';
  const { stable, active } = partitionStreamingMarkdown(t, true);
  assert.deepEqual(stable, ['a\n\n', 'b\n\n', 'c']);
  assert.equal(active, '');
  assert.equal(stable.join('') + active, t);
});

test('partition: streaming → last block is the active tail', () => {
  const t = 'a\n\nb\n\nc still writ';
  const { stable, active } = partitionStreamingMarkdown(t, false);
  assert.deepEqual(stable, ['a\n\n', 'b\n\n']);
  assert.equal(active, 'c still writ');
  assert.equal(stable.join('') + active, t);
});

test('partition: streaming single block → nothing stable yet', () => {
  const { stable, active } = partitionStreamingMarkdown('typing', false);
  assert.deepEqual(stable, []);
  assert.equal(active, 'typing');
});

test('partition: empty streaming text', () => {
  const { stable, active } = partitionStreamingMarkdown('', false);
  assert.deepEqual(stable, []);
  assert.equal(active, '');
});

test('partition: streaming inside an open fence → whole fence is the active tail', () => {
  // A blank line inside the still-open fence must not become stable — otherwise
  // half the code block would freeze while the rest streams.
  const t = 'intro\n\n```js\nconst a = 1;\n\nconst b';
  const { stable, active } = partitionStreamingMarkdown(t, false);
  assert.deepEqual(stable, ['intro\n\n']);
  assert.equal(active, '```js\nconst a = 1;\n\nconst b');
  assert.equal(stable.join('') + active, t);
});

// Property-ish check: for a spread of random-ish inputs, round-trip must hold.
test('round-trip holds across assorted inputs', () => {
  const samples = [
    '',
    'x',
    '\n',
    '\n\n\n',
    'a\nb\nc',
    'a\n\nb',
    '```\n\n\n```',
    '# h\n\ntext\n\n- l1\n- l2\n\n> quote\n',
    'no trailing newline\n\nlast',
    'trailing\n',
  ];
  for (const s of samples) roundtrip(s);
});
