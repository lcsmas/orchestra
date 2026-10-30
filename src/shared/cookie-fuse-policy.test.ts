import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import { PROFILE_AT_REST_WARNING } from './browser-profile.ts';
import { PROFILE_AT_REST_OBFUSCATED_WARNING, profileAtRestWarning } from './cookie-fuse-policy.ts';

const require = createRequire(import.meta.url);
const { COOKIE_ENCRYPTION_FUSE_SHIPPED } = require('../../scripts/lib/cookie-fuse-policy.cjs') as { COOKIE_ENCRYPTION_FUSE_SHIPPED: boolean };

test('fuse OFF, unknown, or state not loaded yet → the always-on warning, whatever the keyring says', () => {
  for (const backendEncrypted of [true, false, null]) assert.equal(profileAtRestWarning({ fuse: 'disabled', backendEncrypted }), PROFILE_AT_REST_WARNING);
  assert.equal(profileAtRestWarning({ fuse: 'unknown', backendEncrypted: true }), PROFILE_AT_REST_WARNING);
  assert.equal(profileAtRestWarning(null), PROFILE_AT_REST_WARNING);
});

test('fuse ON and a keyring-backed backend → no warning; fuse ON but basic_text / locked / unknown backend → the "scrambled, not secret" warning', () => {
  assert.equal(profileAtRestWarning({ fuse: 'enabled', backendEncrypted: true }), null);
  assert.equal(profileAtRestWarning({ fuse: 'enabled', backendEncrypted: false }), PROFILE_AT_REST_OBFUSCATED_WARNING);
  assert.equal(profileAtRestWarning({ fuse: 'enabled', backendEncrypted: null }), PROFILE_AT_REST_OBFUSCATED_WARNING);
  assert.notEqual(PROFILE_AT_REST_OBFUSCATED_WARNING, PROFILE_AT_REST_WARNING);
});

test('the shipped policy and the warning agree: with the policy the release ships, the real state the binary will report yields exactly the documented warning', () => {
  // afterPack (scripts/after-pack-check.cjs) makes the binary's fuse equal COOKIE_ENCRYPTION_FUSE_SHIPPED; this is what that state shows the human
  const shippedFuse = COOKIE_ENCRYPTION_FUSE_SHIPPED ? 'enabled' : 'disabled';
  if (!COOKIE_ENCRYPTION_FUSE_SHIPPED) {
    assert.equal(profileAtRestWarning({ fuse: shippedFuse, backendEncrypted: true }), PROFILE_AT_REST_WARNING, 'fuse OFF ships ⇒ the warning is unconditional, even with a working keyring');
  } else {
    assert.equal(profileAtRestWarning({ fuse: shippedFuse, backendEncrypted: true }), null, 'fuse ON ships ⇒ a working keyring clears the warning');
    assert.equal(profileAtRestWarning({ fuse: shippedFuse, backendEncrypted: false }), PROFILE_AT_REST_OBFUSCATED_WARNING);
  }
});
