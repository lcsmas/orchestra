import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkLoopbackRequest, splitTokenPath, tokenMatches } from './cdp-loopback-guard.ts';

const P = 43210;

test('a CLI-shaped request (loopback Host, no Origin) passes', () => {
  assert.deepEqual(checkLoopbackRequest({ host: `127.0.0.1:${P}` }, P), { ok: true });
  assert.deepEqual(checkLoopbackRequest({ host: `localhost:${P}` }, P), { ok: true });
  assert.deepEqual(checkLoopbackRequest({ host: `LocalHost:${P}` }, P), { ok: true });
});

test('ANY Origin header is refused — a web page, even a same-origin or `null` one', () => {
  for (const origin of ['http://evil.example', `http://127.0.0.1:${P}`, 'null', '']) {
    assert.deepEqual(checkLoopbackRequest({ host: `127.0.0.1:${P}`, origin }, P), {
      ok: false,
      reason: 'origin-present',
    });
  }
});

test('a non-loopback Host is refused (DNS rebinding)', () => {
  for (const host of ['evil.example', `evil.example:${P}`, `127.0.0.1.evil.example:${P}`, `10.0.0.5:${P}`, `[::1]:${P}`]) {
    assert.deepEqual(checkLoopbackRequest({ host }, P), { ok: false, reason: 'host-not-loopback' }, host);
  }
});

test('a missing Host, and a loopback Host on another port, are refused', () => {
  assert.deepEqual(checkLoopbackRequest({}, P), { ok: false, reason: 'host-missing' });
  assert.deepEqual(checkLoopbackRequest({ host: '  ' }, P), { ok: false, reason: 'host-missing' });
  assert.deepEqual(checkLoopbackRequest({ host: '127.0.0.1' }, P), { ok: false, reason: 'host-not-loopback' });
  assert.deepEqual(checkLoopbackRequest({ host: `127.0.0.1:${P + 1}` }, P), {
    ok: false,
    reason: 'host-port-mismatch',
  });
});

test('tokenMatches: equal passes, different / prefix / empty do not', () => {
  assert.equal(tokenMatches('abcDEF123', 'abcDEF123'), true);
  assert.equal(tokenMatches('abcDEF12', 'abcDEF123'), false);
  assert.equal(tokenMatches('abcDEF124', 'abcDEF123'), false);
  assert.equal(tokenMatches('', ''), false);
});

test('splitTokenPath peels the first segment', () => {
  assert.deepEqual(splitTokenPath('/tok_1-A/json/list'), { token: 'tok_1-A', rest: '/json/list' });
  assert.deepEqual(splitTokenPath('/tok'), { token: 'tok', rest: '/' });
  assert.equal(splitTokenPath('/'), null);
  assert.equal(splitTokenPath('/to k/x'), null);
});
