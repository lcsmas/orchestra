import { test } from 'node:test';
import assert from 'node:assert/strict';
import { highlightComposer } from './composer-highlight.ts';

/** The mirror layer is painted BEHIND the textarea, so every part's text
 *  concatenated must reproduce the input exactly — otherwise the highlight
 *  drifts off the real glyphs. Asserted on every case below. */
function assertLossless(input: string) {
  const joined = highlightComposer(input)
    .map((p) => p.text)
    .join('');
  assert.equal(joined, input, `lossless for ${JSON.stringify(input)}`);
}

test('highlights a leading slash-command', () => {
  const parts = highlightComposer('/ship');
  assert.deepEqual(parts, [{ text: '/ship', token: 'skill' }]);
  assertLossless('/ship');
});

test('highlights only the command, not the argument text', () => {
  const parts = highlightComposer('/ship patch and install');
  assert.deepEqual(parts, [
    { text: '/ship', token: 'skill' },
    { text: ' patch and install', token: null },
  ]);
  assertLossless('/ship patch and install');
});

test('handles hyphenated skill names', () => {
  const parts = highlightComposer('/orchestra-spawn a task');
  assert.equal(parts[0].text, '/orchestra-spawn');
  assert.equal(parts[0].token, 'skill');
  assertLossless('/orchestra-spawn a task');
});

test('highlights the bash marker only', () => {
  const parts = highlightComposer('!ls -la');
  assert.deepEqual(parts, [
    { text: '!', token: 'bash' },
    { text: 'ls -la', token: null },
  ]);
  assertLossless('!ls -la');
});

test('a bare "/" is not a command yet', () => {
  // The autocomplete popover is open here, but there is no name to highlight.
  assert.deepEqual(highlightComposer('/'), [{ text: '/', token: null }]);
  assertLossless('/');
});

test('does not highlight a slash mid-sentence', () => {
  assert.deepEqual(highlightComposer('read and/or write'), [
    { text: 'read and/or write', token: null },
  ]);
  assertLossless('read and/or write');
});

test('does not highlight an absolute path', () => {
  // `/etc/hosts` — the second slash means it is a path, not a command.
  const parts = highlightComposer('/etc/hosts is the file');
  assert.equal(parts[0].token, null, 'a path must not be styled as a skill');
  assertLossless('/etc/hosts is the file');
});

test('does not highlight a leading space before the slash', () => {
  // Mirrors SLASH_PREFIX in the composer: the CLI only treats a command at
  // position 0 as a command, so the highlight must agree.
  assert.deepEqual(highlightComposer(' /ship'), [{ text: ' /ship', token: null }]);
  assertLossless(' /ship');
});

test('empty input yields no parts', () => {
  assert.deepEqual(highlightComposer(''), []);
});

test('multiline text is preserved exactly', () => {
  const input = '/ship the thing\nthen tell me\n';
  assertLossless(input);
  assert.equal(highlightComposer(input)[0].token, 'skill');
});
