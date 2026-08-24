import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  dialogTextFromPayload,
  dialogOptionsFromPayload,
  humanizeDialogKind,
} from './userDialog.ts';

test('humanizeDialogKind turns a snake_case kind into a heading', () => {
  assert.equal(humanizeDialogKind('refusal_fallback_prompt'), 'Refusal fallback prompt');
  assert.equal(humanizeDialogKind('trust-folder'), 'Trust folder');
  assert.equal(humanizeDialogKind(''), 'Dialog');
});

test('dialogTextFromPayload probes conventional keys, falls back to the kind', () => {
  assert.deepEqual(dialogTextFromPayload('k', { title: 'T', message: 'M' }), {
    title: 'T',
    message: 'M',
  });
  // Alternate spellings the payload might use (the shape is per-kind + opaque).
  assert.equal(dialogTextFromPayload('k', { header: 'H' }).title, 'H');
  assert.equal(dialogTextFromPayload('k', { body: 'B' }).message, 'B');
  // No recognized key ⇒ the card still gets a heading rather than a blank one.
  assert.deepEqual(dialogTextFromPayload('refusal_fallback_prompt', {}), {
    title: 'Refusal fallback prompt',
  });
  // Whitespace-only is not a title.
  assert.equal(dialogTextFromPayload('k', { title: '  ' }).title, 'K');
});

test('dialogOptionsFromPayload accepts both string and object encodings', () => {
  assert.deepEqual(dialogOptionsFromPayload({ options: ['yes', 'no'] }), [
    { value: 'yes', label: 'yes' },
    { value: 'no', label: 'no' },
  ]);
  assert.deepEqual(dialogOptionsFromPayload({ choices: [{ value: 'a', label: 'Allow' }] }), [
    { value: 'a', label: 'Allow' },
  ]);
  // Label alone can serve as the value — a button needs SOMETHING to send back.
  assert.deepEqual(dialogOptionsFromPayload({ buttons: [{ label: 'OK' }] }), [
    { value: 'OK', label: 'OK' },
  ]);
});

test('dialogOptionsFromPayload yields [] on anything unusable', () => {
  // [] makes the card render a single Continue button rather than a dead end.
  for (const bad of [{}, { options: 'yes' }, { options: 7 }]) {
    assert.deepEqual(dialogOptionsFromPayload(bad as Record<string, unknown>), []);
  }
  // Entries with neither value nor label are skipped, not rendered blank.
  assert.deepEqual(dialogOptionsFromPayload({ options: [{}, '', { value: 'ok' }] }), [
    { value: 'ok', label: 'ok' },
  ]);
});
