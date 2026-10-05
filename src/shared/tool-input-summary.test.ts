import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeToolInput } from './tool-input-summary.ts';

test('summarizeToolInput: Bash → its command, other tools → their first descriptive field, bounded, null when there is nothing', () => {
  assert.equal(summarizeToolInput('Bash', { command: '  npm test -- --watch  ', description: 'x' }), 'npm test -- --watch');
  assert.equal(summarizeToolInput('Read', { file_path: '/w/a.ts', offset: 3 }), 'file_path=/w/a.ts');
  assert.equal(summarizeToolInput('Grep', { pattern: 'TODO', path: '/w' }), 'path=/w', 'first key in the fixed order wins');
  assert.equal(summarizeToolInput('Weird', { n: 1, flag: true }), '{"n":1,"flag":true}');
  assert.equal(summarizeToolInput('Bash', { command: 'x'.repeat(400) })!.length, 300, 'bounded');
  assert.ok(summarizeToolInput('Bash', { command: 'x'.repeat(400) })!.endsWith('…'));
  assert.equal(summarizeToolInput('Bash', {}), null);
  assert.equal(summarizeToolInput('Bash', null), null);
  assert.equal(summarizeToolInput(null, 'a string'), null);
});
