import { test } from 'node:test';
import assert from 'node:assert/strict';
import { attachmentContentBlock, attachmentFromBlock, isAttachableMediaType } from './attachments.ts';

test('attachments: PDFs and images are attachable, other files are not', () => {
  assert.equal(isAttachableMediaType('application/pdf'), true);
  assert.equal(isAttachableMediaType('image/png'), true);
  assert.equal(isAttachableMediaType('text/plain'), false);
  assert.equal(isAttachableMediaType(''), false);
});

test('attachments: a PDF goes out as a document block, an image as an image block', () => {
  assert.deepEqual(attachmentContentBlock({ mediaType: 'application/pdf', dataBase64: 'JVBE' }), {
    type: 'document',
    source: { type: 'base64', media_type: 'application/pdf', data: 'JVBE' },
  });
  assert.equal(attachmentContentBlock({ mediaType: 'image/jpeg', dataBase64: 'x' }).type, 'image');
});

test('attachments: blocks round-trip; unrelated blocks are ignored', () => {
  for (const att of [
    { mediaType: 'application/pdf', dataBase64: 'JVBE' },
    { mediaType: 'image/png', dataBase64: 'AAAA' },
  ]) {
    assert.deepEqual(attachmentFromBlock(attachmentContentBlock(att)), att);
  }
  assert.equal(attachmentFromBlock({ type: 'text', text: 'hi' }), null);
  assert.equal(attachmentFromBlock({ type: 'document', source: { type: 'text', media_type: 'text/plain', data: 'x' } }), null);
  assert.equal(attachmentFromBlock({ type: 'document', source: { type: 'base64', media_type: 'text/plain', data: 'x' } }), null);
  assert.equal(attachmentFromBlock(null), null);
});
