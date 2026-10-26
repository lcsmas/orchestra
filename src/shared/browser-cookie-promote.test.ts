import test from 'node:test';
import assert from 'node:assert/strict';
import { promoteSessionCookie, restoreCookie, PROMOTED_COOKIE_TTL_S, type CookieLike } from './browser-cookie-promote.ts';

const NOW = 1_800_000_000;
const base: CookieLike = { name: 'sid', value: 'abc', domain: '127.0.0.1', hostOnly: true, path: '/', secure: false, httpOnly: false, session: true, sameSite: 'unspecified' };

test('a session cookie is promoted: same name/value/flags, expiry = now + 30 days', () => {
  const d = promoteSessionCookie(base, NOW)!;
  assert.equal(PROMOTED_COOKIE_TTL_S, 30 * 24 * 3600);
  assert.deepEqual(d, { url: 'http://127.0.0.1/', name: 'sid', value: 'abc', path: '/', secure: false, httpOnly: false, sameSite: 'unspecified', expirationDate: NOW + 2_592_000 });
});

test('a cookie that already has an expiry is NOT touched (the site\'s own, or our earlier promotion — no set → changed loop)', () => {
  assert.equal(promoteSessionCookie({ ...base, session: false, expirationDate: NOW + 5 }, NOW), null);
  assert.equal(promoteSessionCookie({ ...base, session: true, expirationDate: NOW + 5 }, NOW), null);
  assert.equal(promoteSessionCookie({ ...base, session: undefined }, NOW), null);
});

test('host-only stays host-only (no domain attribute); a domain cookie keeps its domain, leading dot included, the url host has none', () => {
  assert.equal('domain' in promoteSessionCookie(base, NOW)!, false);
  const d = promoteSessionCookie({ ...base, domain: '.example.com', hostOnly: false, path: '/app' }, NOW)!;
  assert.equal(d.domain, '.example.com');
  assert.equal(d.url, 'http://example.com/app');
  assert.equal(d.path, '/app');
});

test('secure → https url + secure flag; httpOnly and sameSite pass through; missing path = /', () => {
  const d = promoteSessionCookie({ ...base, secure: true, httpOnly: true, sameSite: 'strict', path: undefined }, NOW)!;
  assert.deepEqual([d.url, d.secure, d.httpOnly, d.sameSite, d.path], ['https://127.0.0.1/', true, true, 'strict', '/']);
});

test('an unusable cookie (no host / no name) is not promoted rather than set on a guessed url', () => {
  assert.equal(promoteSessionCookie({ ...base, domain: '' }, NOW), null);
  assert.equal(promoteSessionCookie({ ...base, domain: undefined }, NOW), null);
  assert.equal(promoteSessionCookie({ ...base, name: '' }, NOW), null);
});

test('expiry is sliding: promoting the same cookie later gives a later expiry', () => {
  assert.equal(promoteSessionCookie(base, NOW + 100)!.expirationDate - promoteSessionCookie(base, NOW)!.expirationDate, 100);
});

test('restoreCookie puts the SITE\'s last write back: a session cookie in its promoted 30-day form, a persistent one with its OWN expiry, nothing for an expired or nameless one', () => {
  const now = 1_800_000_000;
  const rbase = { name: 'sid', value: 'R2', domain: 'example.com', hostOnly: false, path: '/app', secure: true, httpOnly: true, sameSite: 'lax' as const };
  const sess = restoreCookie({ ...rbase, session: true }, now)!;
  assert.equal(sess.expirationDate, now + PROMOTED_COOKIE_TTL_S);
  assert.deepEqual([sess.value, sess.url, sess.domain, sess.path, sess.secure, sess.httpOnly, sess.sameSite], ['R2', 'https://example.com/app', 'example.com', '/app', true, true, 'lax']);
  const persistent = restoreCookie({ ...rbase, session: false, expirationDate: now + 3600 }, now)!;
  assert.equal(persistent.expirationDate, now + 3600, 'the site\'s own expiry, not 30 days');
  assert.equal(persistent.value, 'R2');
  assert.equal(restoreCookie({ ...rbase, session: false, expirationDate: now - 1 }, now), null, 'an expired cookie is not resurrected');
  assert.equal(restoreCookie({ ...rbase, session: false, expirationDate: now }, now), null);
  assert.equal(restoreCookie({ ...rbase, name: '', session: true }, now), null);
  assert.equal(restoreCookie({ ...rbase, domain: '', session: true }, now), null);
});
