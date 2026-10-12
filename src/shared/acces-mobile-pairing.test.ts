// Accès mobile pairing (#336): the tailnet host setting and the one URL the QR code carries — token in the FRAGMENT only.

import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_ACCES_MOBILE_SETTINGS, normalizeAccesMobileSettings, normalizeTailnetHost, pairingUrl, patchAccesMobileSettings } from './acces-mobile.ts';

const TOKEN = 'k3Zt9' + 'Q_-'.repeat(6) + 'AbCdEfGhIjKlMnOpQrStUvWx'.slice(0, 20); // 43 chars of base64url
const HOST = 'lmas.tail6e788b.ts.net';

test('tailnet host: the MagicDNS name as pasted from Self.DNSName (trailing dot, any case) is canonicalised', () => {
  assert.equal(normalizeTailnetHost('lmas.tail6e788b.ts.net'), HOST, 'control');
  assert.equal(normalizeTailnetHost('  LMAS.Tail6E788B.ts.net. '), HOST);
  assert.equal(normalizeTailnetHost('a.b'), 'a.b');
});

test('tailnet host must-FAIL: anything that is not a bare DNS name is refused (scheme, port, path, fragment, space, userinfo, IP, one label, empty)', () => {
  for (const bad of ['https://lmas.tail6e788b.ts.net', 'lmas.tail6e788b.ts.net:8445', 'lmas.tail6e788b.ts.net/', 'lmas.tail6e788b.ts.net/#t=x', 'lmas .ts.net', 'me@lmas.ts.net', '100.101.102.103', 'lmas', '', '.', '-a.ts.net', 'a..ts.net', `${'x'.repeat(64)}.ts.net`, 'lmas.tail6e788b.ts.net\n.evil.com']) {
    assert.equal(normalizeTailnetHost(bad), null, JSON.stringify(bad));
  }
});

test('settings: tailnetHost defaults empty; a stored value is normalised; a malformed stored value falls back to empty', () => {
  assert.equal(DEFAULT_ACCES_MOBILE_SETTINGS.tailnetHost, '');
  assert.equal(normalizeAccesMobileSettings({ tailnetHost: 'LMAS.tail6e788b.ts.net.' }).tailnetHost, HOST);
  assert.equal(normalizeAccesMobileSettings({ tailnetHost: 'https://evil/' }).tailnetHost, '');
  assert.equal(normalizeAccesMobileSettings({ tailnetHost: 42 as unknown as string }).tailnetHost, '');
  assert.equal(normalizeAccesMobileSettings(undefined).tailnetHost, '');
});

test('settings patch: a valid host is stored canonical, an invalid one writes nothing, empty clears it', () => {
  const cur = normalizeAccesMobileSettings({ allowedLogin: 'me@example.invalid' });
  const ok = patchAccesMobileSettings(cur, { tailnetHost: 'LMAS.tail6e788b.ts.net.' });
  assert.ok(ok.ok && ok.settings.tailnetHost === HOST, 'control');
  const bad = patchAccesMobileSettings(cur, { tailnetHost: 'https://x.ts.net/path', servePort: 9000 });
  assert.ok(!bad.ok && /tailnet host/i.test(bad.error), 'refused with a message that names the field');
  const cleared = patchAccesMobileSettings(ok.ok ? ok.settings : cur, { tailnetHost: '' });
  assert.ok(cleared.ok && cleared.settings.tailnetHost === '');
  const untouched = patchAccesMobileSettings(ok.ok ? ok.settings : cur, { servePort: 9000 });
  assert.ok(untouched.ok && untouched.settings.tailnetHost === HOST, 'a patch that does not mention the host keeps it');
});

test('pairingUrl: https://<host>:<port>/#t=<token> — the token is in the fragment and NOWHERE else', () => {
  assert.equal(TOKEN.length, 43, 'control: fixture token shape');
  const u = pairingUrl(HOST, 8445, TOKEN)!;
  assert.equal(u, `https://${HOST}:8445/#t=${TOKEN}`);
  const parsed = new URL(u);
  assert.equal(parsed.protocol, 'https:');
  assert.equal(parsed.host, `${HOST}:8445`);
  assert.equal(parsed.pathname, '/');
  assert.equal(parsed.search, '', 'no query string');
  assert.equal(parsed.hash, `#t=${TOKEN}`);
  assert.ok(!u.split('#')[0].includes(TOKEN), 'everything a request line / log could carry is token-free');
  assert.equal(pairingUrl(HOST, 9000, TOKEN), `https://${HOST}:9000/#t=${TOKEN}`, 'the serve port is the configured one');
});

test('pairingUrl must-FAIL: no host, no token or a malformed token ⇒ null (never a half URL)', () => {
  assert.ok(pairingUrl(HOST, 8445, TOKEN), 'control');
  assert.equal(pairingUrl('', 8445, TOKEN), null);
  assert.equal(pairingUrl(HOST, 8445, null), null);
  assert.equal(pairingUrl(HOST, 8445, ''), null);
  for (const bad of ['short', 'has space ' + 'a'.repeat(30), 'a'.repeat(20) + '?x=1', 'a'.repeat(20) + '#y', 'a'.repeat(300)]) assert.equal(pairingUrl(HOST, 8445, bad), null, bad);
});
