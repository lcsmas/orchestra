import { test } from 'node:test';
import assert from 'node:assert/strict';
import { accountKeyMissingMessage, secretsNotice, type SecretsState } from './secrets-state.ts';

const st = (over: Partial<SecretsState>): SecretsState => ({
  encrypted: false, backend: 'basic_text', plaintextEntries: 0, encryptedEntries: 0, ...over,
});

test('encryption available → no notice at all (also for a not-yet-loaded state)', () => {
  assert.equal(secretsNotice(st({ encrypted: true, backend: 'gnome_libsecret', plaintextEntries: 3 })), null);
  assert.equal(secretsNotice(null), null);
});

test('encryption unavailable → the "stored unencrypted on this machine" warning', () => {
  const n = secretsNotice(st({ plaintextEntries: 2 }));
  assert.equal(n?.kind, 'unencrypted');
  assert.match(n!.text, /stored unencrypted on this machine/);
  assert.equal(secretsNotice(st({}))?.kind, 'unencrypted', 'also with nothing stored yet: new secrets WILL be plaintext');
});

test('unavailable but ciphertext on disk → says those secrets are unreadable (singular / plural)', () => {
  const one = secretsNotice(st({ encryptedEntries: 1 }));
  assert.equal(one?.kind, 'unreadable');
  assert.match(one!.text, /stored unencrypted on this machine/);
  assert.match(one!.text, /1 stored secret is encrypted and unreadable until a keyring is available again/);
  assert.doesNotMatch(one!.text, /unlocked/, 'no cause is blamed: locked, no bus and no gdbus all land here');
  assert.match(secretsNotice(st({ encryptedEntries: 3 }))!.text, /3 stored secrets are encrypted and unreadable/);
});

test('usage message: nothing stored vs stored-but-unreadable vs withheld for an unreadable base URL — three different truths', () => {
  assert.equal(accountKeyMissingMessage(undefined), 'no API key stored');
  assert.match(accountKeyMissingMessage('key-unreadable'), /stored but unreadable/);
  assert.match(accountKeyMissingMessage('base-url-unreadable'), /withheld: its base URL is stored but unreadable/);
});
