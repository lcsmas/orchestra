// #421 — the phone's bloc HTML route: id minting through the authenticated API, the refusals, its own policy, the shell's untouched.
// Every must-FAIL arm sits beside a passing control in the same test, so a dead instrument cannot read as a pass.

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { spawn } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import { createAccesMobileServer, type Upstream } from './server.ts';
import { BLOC_ID_TTL_MS, BLOC_MAX_ENTRIES, BLOC_ROUTE_CSP, createBlocStore, tokenDigest } from './bloc-route.ts';
import { SHELL_PATHS, SW_JS } from './sw.ts';
import { BLOC_HTML_MAX_SOURCE_BYTES, splitReply } from '../shared/reply-segments.ts';
import { BLOC_HEIGHT_TAG, BLOC_HTML_POLICY } from '../shared/bloc-html-document.ts';
import { serveRpc, type RpcWire } from '../shared/acces-mobile-rpc.ts';

const LOGIN = 'lucas.mas@mobile.club';
const TOKEN = 'tok_' + 'a'.repeat(40);
const ID = { 'Tailscale-User-Login': LOGIN };
const AUTH = { ...ID, Authorization: `Bearer ${TOKEN}` };
const SOURCE = '<div id="b">bloc ok</div><script>document.getElementById("b").textContent="ran"</script>';
// The shell's policy as it was BEFORE #421 (git show 4f6762e1:src/acces-mobile/server.ts) — a literal, so loosening it fails here.
const SHELL_CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

interface Rig {
  port: number;
  calls: string[];
  logs: string[];
  setToken: (t: string) => void;
  setEnabled: (v: boolean | 'throw') => void;
  tick: (ms: number) => void;
  close: () => Promise<void>;
}

async function rig(): Promise<Rig> {
  let token = TOKEN;
  let enabled: boolean | 'throw' = true;
  let clock = 1_000;
  const calls: string[] = [];
  const logs: string[] = [];
  const upstream: Upstream = async (route) => {
    calls.push(route);
    if (route === '/mobile/bloc-enabled') {
      if (enabled === 'throw') throw new Error('main down');
      return { ok: true, enabled };
    }
    return { ok: true };
  };
  const server = createAccesMobileServer({ allowedLogin: LOGIN, readToken: () => token, upstream, log: (l) => logs.push(l), now: () => clock });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return {
    port: (server.address() as AddressInfo).port,
    calls,
    logs,
    setToken: (t) => (token = t),
    setEnabled: (v) => (enabled = v),
    tick: (ms) => (clock += ms),
    close: () => new Promise((r) => server.close(() => r())),
  };
}

interface Res { status: number; body: string; headers: http.IncomingHttpHeaders }
function call(opt: { port?: number; socketPath?: string }, method: string, p: string, headers: Record<string, string> = {}, body?: string): Promise<Res> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: opt.socketPath ? undefined : '127.0.0.1', port: opt.port, socketPath: opt.socketPath, path: p, method, headers: body ? { 'Content-Type': 'application/json', ...headers } : headers }, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: b, headers: res.headers }));
    });
    req.on('error', reject);
    req.end(body);
  });
}
const mint = async (r: { port: number }, source = SOURCE, headers = AUTH): Promise<Res & { id: string }> => {
  const res = await call(r, 'POST', '/api/bloc', headers, JSON.stringify({ source }));
  let id = '';
  try { id = JSON.parse(res.body).id ?? ''; } catch { /* a refusal has no body */ }
  return { ...res, id };
};
const frame = (r: { port: number }, id: string, headers: Record<string, string> = ID): Promise<Res> => call(r, 'GET', `/bloc/${id}`, headers);

test('control: an id minted through the authenticated API frames the bloc on identity alone (no bearer), under its OWN headers', async () => {
  const r = await rig();
  try {
    const m = await mint(r);
    assert.equal(m.status, 200);
    assert.match(m.id, /^[A-Za-z0-9_-]{32}$/, 'a 192-bit base64url id');
    assert.equal(JSON.parse(m.body).path, `/bloc/${m.id}`);
    const res = await frame(r, m.id); // ID only: NO Authorization header
    assert.equal(res.status, 200);
    assert.ok(res.body.includes(SOURCE), 'the model\'s HTML is in the document');
    assert.ok(res.body.startsWith(`<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${BLOC_HTML_POLICY}">`), 'the shared builder: the policy <meta> FIRST in <head>');
    assert.ok(res.body.indexOf('--bloc-fg:#eef1f5') > 0 && res.body.indexOf('--bloc-fg:#eef1f5') < res.body.indexOf(SOURCE), 'then the phone\'s theme, then the model\'s HTML');
    assert.ok(!/color-scheme/.test(res.body), 'no color-scheme (Chromium would paint the frame opaque)');
    assert.ok(res.body.includes(BLOC_HEIGHT_TAG), 'the height reporter');
    assert.equal(res.headers['content-security-policy'], BLOC_ROUTE_CSP);
    assert.equal(BLOC_ROUTE_CSP, `sandbox allow-scripts; ${BLOC_HTML_POLICY}; frame-ancestors 'self'`, 'the frame\'s ONE content policy + sandbox + frameable only by the shell');
    assert.match(BLOC_ROUTE_CSP, /^sandbox allow-scripts;/, 'sandboxed with scripts, and NO allow-same-origin');
    assert.ok(!/allow-same-origin|allow-top-navigation|allow-popups|allow-forms/.test(BLOC_ROUTE_CSP));
    assert.match(BLOC_ROUTE_CSP, /frame-ancestors 'self'/, 'frameable only by the shell (same origin)');
    assert.equal(res.headers['cache-control'], 'no-store');
    assert.equal(res.headers['x-frame-options'], undefined, 'the shell\'s X-Frame-Options DENY is NOT carried (it would forbid the shell to frame it)');
    assert.match(String(res.headers['content-type']), /^text\/html/);
    assert.deepEqual(r.calls, ['/mobile/bloc-enabled'], 'main is consulted once per load, for the setting only');
  } finally {
    await r.close();
  }
});

test('the shell\'s headers are byte-for-byte what they were (CSP literal, no frame-src / child-src loosening), beside the route\'s own', async () => {
  const r = await rig();
  try {
    const shell = await call(r, 'GET', '/', ID);
    assert.equal(shell.status, 200);
    assert.equal(shell.headers['content-security-policy'], SHELL_CSP);
    assert.equal(shell.headers['x-frame-options'], 'DENY');
    const m = await mint(r);
    const route = await frame(r, m.id);
    assert.notEqual(route.headers['content-security-policy'], shell.headers['content-security-policy'], 'the route has its own policy');
    for (const p of ['/app.js', '/conversation.js', '/api/workspaces']) {
      const x = await call(r, 'GET', p, AUTH);
      assert.equal(x.headers['content-security-policy'], SHELL_CSP, `${p} keeps the shell policy`);
    }
  } finally {
    await r.close();
  }
});

test('must-FAIL: no identity / wrong identity ⇒ 403 even for a LIVE id (control: the right identity gets 200)', async () => {
  const r = await rig();
  try {
    const m = await mint(r);
    assert.equal((await frame(r, m.id, ID)).status, 200, 'control');
    assert.equal((await frame(r, m.id, {})).status, 403);
    assert.equal((await frame(r, m.id, { 'Tailscale-User-Login': '' })).status, 403);
    assert.equal((await frame(r, m.id, { 'Tailscale-User-Login': 'colleague@mobile.club' })).status, 403);
    assert.equal((await frame(r, m.id, { 'Tailscale-User-Login': 'colleague@mobile.club', Authorization: `Bearer ${TOKEN}` })).status, 403, 'a valid bearer does not buy another identity');
    assert.ok(r.logs.some((l) => l.includes('refused 403 no-identity GET /bloc/')), r.logs.join('\n'));
  } finally {
    await r.close();
  }
});

test('must-FAIL: an unknown / malformed id ⇒ 404, main never consulted (control: a minted id answers)', async () => {
  const r = await rig();
  try {
    const m = await mint(r);
    assert.equal((await frame(r, m.id)).status, 200, 'control');
    const calls0 = r.calls.length;
    const other = m.id.slice(0, -1) + (m.id.endsWith('A') ? 'B' : 'A');
    for (const id of [other, 'x'.repeat(32), '', 'short', m.id + 'x', '../api/workspaces', '%2e%2e', m.id.toLowerCase() === m.id ? m.id.toUpperCase() : m.id.toLowerCase()]) {
      const res = await frame(r, id);
      assert.equal(res.status, 404, `id "${id}"`);
      assert.equal(res.body, '', 'nothing about why');
    }
    assert.equal(r.calls.length, calls0, 'a refused id never reached main');
    assert.equal((await call(r, 'GET', '/bloc', ID)).status, 404);
    assert.equal((await call(r, 'POST', `/bloc/${m.id}`, AUTH, '{}')).status, 405, 'GET only');
  } finally {
    await r.close();
  }
});

test('must-FAIL: an id expires after BLOC_ID_TTL_MS (control: one ms before, it still answers)', async () => {
  const r = await rig();
  try {
    const m = await mint(r);
    r.tick(BLOC_ID_TTL_MS - 1);
    assert.equal((await frame(r, m.id)).status, 200, 'control: not yet expired');
    r.tick(1);
    assert.equal((await frame(r, m.id)).status, 404);
    assert.ok(r.logs.some((l) => l.includes('refused 404 bloc-expired')));
    r.tick(-1000); // a clock step back must not resurrect a dropped id
    assert.equal((await frame(r, m.id)).status, 404, 'dropped, not merely hidden');
  } finally {
    await r.close();
  }
});

test('must-FAIL: regenerating the token kills every id it minted (control: before, 200; a fresh mint under the new token works)', async () => {
  const r = await rig();
  try {
    const a = await mint(r);
    const b = await mint(r, '<p>second</p>');
    assert.equal((await frame(r, a.id)).status, 200, 'control');
    r.setToken('tok_' + 'n'.repeat(40));
    assert.equal((await frame(r, a.id)).status, 404);
    assert.equal((await frame(r, b.id)).status, 404);
    assert.ok(r.logs.some((l) => l.includes('refused 404 bloc-token-changed')));
    r.setToken(TOKEN); // restoring the old token does NOT bring a dropped id back
    assert.equal((await frame(r, a.id)).status, 404, 'dropped for good');
    r.setToken('tok_' + 'n'.repeat(40));
    assert.equal((await mint(r, SOURCE, { ...ID, Authorization: `Bearer tok_${'n'.repeat(40)}` })).status, 200, 'the new token mints');
    assert.equal((await mint(r, SOURCE, AUTH)).status, 401, 'the old token mints nothing');
  } finally {
    await r.close();
  }
});

test('must-FAIL: an unreadable / empty token file serves no bloc (fail closed)', async () => {
  const r = await rig();
  try {
    const m = await mint(r);
    assert.equal((await frame(r, m.id)).status, 200, 'control');
    r.setToken('');
    assert.equal((await frame(r, m.id)).status, 404);
  } finally {
    await r.close();
  }
});

test('the route never needs the bearer and never accepts one in its place (control: the same id answers with and without it)', async () => {
  const r = await rig();
  try {
    const m = await mint(r);
    assert.equal((await frame(r, m.id, ID)).status, 200, 'no bearer');
    assert.equal((await frame(r, m.id, AUTH)).status, 200, 'with a bearer: the same');
    const other = 'Z'.repeat(32);
    assert.equal((await frame(r, other, AUTH)).status, 404, 'a valid bearer does not make an unknown id valid');
    assert.equal((await call(r, 'GET', `/bloc/${other}?token=${TOKEN}`, ID)).status, 404, 'a token in the query is nothing');
    assert.equal((await call(r, 'GET', `/api/bloc`, AUTH)).status, 404, 'minting is POST only');
  } finally {
    await r.close();
  }
});

test('must-FAIL: setting off ⇒ a LIVE id serves nothing (control: on ⇒ 200); an unreachable main serves nothing either', async () => {
  const r = await rig();
  try {
    const m = await mint(r);
    assert.equal((await frame(r, m.id)).status, 200, 'control: setting on');
    r.setEnabled(false);
    const off = await frame(r, m.id);
    assert.equal(off.status, 404);
    assert.ok(!off.body.includes('bloc ok'));
    r.setEnabled('throw');
    const down = await frame(r, m.id);
    assert.equal(down.status, 502);
    assert.ok(!down.body.includes('bloc ok'), 'fail closed');
    r.setEnabled(true);
    assert.equal((await frame(r, m.id)).status, 200, 'the same id answers again once the setting is back (it is main\'s switch, not the id\'s)');
    assert.ok(r.logs.some((l) => l.includes('refused 404 bloc-off GET /bloc/…')) && !r.logs.some((l) => l.includes(m.id)), 'a live id is a credential: the log names the route, never the id');
  } finally {
    await r.close();
  }
});

test('mint: identity + token required, a source required and bounded, POST JSON only (control: a good mint)', async () => {
  const r = await rig();
  try {
    assert.equal((await mint(r)).status, 200, 'control');
    assert.equal((await mint(r, SOURCE, ID)).status, 401, 'no token');
    assert.equal((await mint(r, SOURCE, { Authorization: `Bearer ${TOKEN}` })).status, 403, 'no identity');
    assert.equal((await mint(r, '')).status, 400);
    assert.equal((await mint(r, '   \n')).status, 400);
    assert.equal((await call(r, 'POST', '/api/bloc', AUTH, JSON.stringify({ source: 42 }))).status, 400);
    assert.equal((await call(r, 'POST', '/api/bloc', AUTH, JSON.stringify({}))).status, 400);
    assert.equal((await call(r, 'POST', '/api/bloc', AUTH, '{nope')).status, 400);
    assert.equal((await call(r, 'POST', '/api/bloc', { ...AUTH, 'Content-Type': 'text/plain' }, '{"source":"x"}')).status, 415);
    assert.equal((await mint(r, 'x'.repeat(BLOC_HTML_MAX_SOURCE_BYTES))).status, 200, 'control: at the cap');
    assert.equal((await mint(r, 'x'.repeat(BLOC_HTML_MAX_SOURCE_BYTES + 1))).status, 400, 'one byte over');
    assert.equal((await mint(r, 'é'.repeat(BLOC_HTML_MAX_SOURCE_BYTES / 2 + 1))).status, 400, 'the cap is in BYTES, not characters');
    assert.deepEqual(r.calls, [], 'minting never reaches main');
  } finally {
    await r.close();
  }
});

test('the store is bounded: BLOC_MAX_ENTRIES live ids, the oldest evicted first (control: the newest survive)', () => {
  let t = 0;
  const s = createBlocStore(() => t);
  const d = tokenDigest(TOKEN);
  const ids = Array.from({ length: BLOC_MAX_ENTRIES + 5 }, (_, i) => s.mint(`<p>${i}</p>`, d));
  assert.equal(s.size(), BLOC_MAX_ENTRIES);
  assert.equal(s.read(ids[0], d).ok, false, 'the oldest is gone');
  assert.equal(s.read(ids[4], d).ok, false);
  assert.deepEqual(s.read(ids[5], d), { ok: true, source: '<p>5</p>' }, 'control');
  assert.deepEqual(s.read(ids[ids.length - 1], d), { ok: true, source: `<p>${ids.length - 1}</p>` });
  assert.equal(new Set(ids).size, ids.length, 'ids are distinct');
});

test('the service worker never intercepts the bloc route, nor caches it (control: it does intercept a shell asset)', async () => {
  assert.ok(!SHELL_PATHS.some((p) => p.startsWith('/bloc')), 'not in the cached shell');
  const listeners: Record<string, (e: unknown) => void> = {};
  let cacheOpens = 0;
  const cache = { match: async () => undefined, put: async () => {}, addAll: async () => {} };
  const sandbox = {
    self: { addEventListener: (n: string, f: (e: unknown) => void) => (listeners[n] = f), location: { origin: 'https://phone.ts.net' }, skipWaiting: () => Promise.resolve(), clients: { claim: () => Promise.resolve() } },
    caches: { open: async () => (cacheOpens++, cache), keys: async () => [] },
    fetch: async () => new Response('x', { status: 200 }),
    URL, Response, AbortController, setTimeout, clearTimeout, Promise,
  };
  vm.runInNewContext(SW_JS, sandbox);
  const pending: unknown[] = [];
  const intercepts = (url: string, mode: string): boolean => {
    let answered = false;
    listeners.fetch({ request: { method: 'GET', url, mode }, respondWith: (p: unknown) => ((answered = true), pending.push(p)), waitUntil: (p: unknown) => pending.push(p) });
    return answered;
  };
  assert.equal(intercepts('https://phone.ts.net/app.js', 'no-cors'), true, 'control: a shell asset goes through the worker');
  await Promise.allSettled(pending);
  assert.equal(cacheOpens, 1, 'control: and the worker cached it');
  assert.equal(intercepts('https://phone.ts.net/bloc/' + 'A'.repeat(32), 'navigate'), false, 'a frame navigation to the bloc route');
  assert.equal(intercepts('https://phone.ts.net/bloc/' + 'A'.repeat(32), 'no-cors'), false);
  await Promise.allSettled(pending);
  assert.equal(cacheOpens, 1, 'nothing of the route reached the cache');
});

/** The REAL entry, the way main spawns it (fd 3 = the private channel, here played by the test). */
const live = new Set<ReturnType<typeof spawn>>();
test.afterEach(() => { for (const c of live) c.kill('SIGKILL'); });
function startEntry(env: Record<string, string>, enabled = true) {
  const child = spawn(process.execPath, ['--experimental-strip-types', '--no-warnings', path.join(import.meta.dirname, 'index.ts')], { env: { PATH: process.env.PATH ?? '', ...env }, stdio: ['pipe', 'pipe', 'pipe', 'pipe'] });
  const ch = child.stdio[3] as unknown as RpcWire & { on(e: 'error', cb: () => void): unknown };
  ch.on('error', () => {});
  serveRpc(ch, { call: async (route) => (route === '/mobile/bloc-enabled' ? { ok: true, enabled } : { ok: true }), stream: () => null });
  let out = '';
  let err = '';
  child.stdout!.on('data', (c) => (out += c));
  child.stderr!.on('data', (c) => (err += c));
  const ready = new Promise<void>((resolve, reject) => {
    const to = setTimeout(() => reject(new Error(`no listening line: ${out} ${err}`)), 10_000);
    child.stdout!.on('data', () => out.includes('listening ') && (clearTimeout(to), resolve()));
    child.on('exit', (code) => (clearTimeout(to), reject(new Error(`exited ${code}: ${err}`))));
  });
  ready.catch(() => {});
  const exited = new Promise<void>((r) => child.on('exit', () => r()));
  live.add(child);
  return { child, ready, exited };
}

test('Accès mobile OFF: the process is gone and its ids with it — a successor on the same socket and token knows none (control: the id answered before)', { timeout: 30_000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bloc-route-'));
  fs.chmodSync(dir, 0o700);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const sock = path.join(dir, 'am.sock');
  const tokenFile = path.join(dir, 'token');
  fs.writeFileSync(tokenFile, TOKEN + '\n', { mode: 0o600 });
  const env = { ACCES_MOBILE_SOCKET: sock, ACCES_MOBILE_LOGIN: LOGIN, ACCES_MOBILE_TOKEN_FILE: tokenFile };
  const a = startEntry(env);
  await a.ready;
  const m = JSON.parse((await call({ socketPath: sock }, 'POST', '/api/bloc', AUTH, JSON.stringify({ source: SOURCE }))).body);
  assert.equal((await call({ socketPath: sock }, 'GET', `/bloc/${m.id}`, ID)).status, 200, 'control: live in the first process');
  a.child.kill('SIGKILL'); // main stops the child when Accès mobile is turned off
  await a.exited;
  const b = startEntry(env);
  await b.ready;
  assert.equal((await call({ socketPath: sock }, 'GET', `/bloc/${m.id}`, ID)).status, 404, 'unknown to the successor');
  assert.equal((await call({ socketPath: sock }, 'GET', '/', ID)).status, 200, 'control: the successor itself is alive');
  // and through the REAL entry, rotating the token file kills a live id
  const m2 = JSON.parse((await call({ socketPath: sock }, 'POST', '/api/bloc', AUTH, JSON.stringify({ source: SOURCE }))).body);
  assert.equal((await call({ socketPath: sock }, 'GET', `/bloc/${m2.id}`, ID)).status, 200, 'control');
  fs.writeFileSync(tokenFile, 'tok_' + 'z'.repeat(40) + '\n');
  assert.equal((await call({ socketPath: sock }, 'GET', `/bloc/${m2.id}`, ID)).status, 404, 'token file rotated');
});

test('the mint limit IS the shared cap: a bloc splitReply renders is a bloc the mint accepts, one byte over is refused by BOTH (a retune of the constant moves them together)', async () => {
  const fence = (n: number): string => '```html-render title="T"\n' + 'x'.repeat(n) + '\n```';
  assert.equal(splitReply(fence(BLOC_HTML_MAX_SOURCE_BYTES))[0].kind, 'bloc', 'control: at the cap the reader renders it');
  assert.equal(splitReply(fence(BLOC_HTML_MAX_SOURCE_BYTES + 1))[0].kind, 'bloc-refused', 'one byte over the reader refuses it');
  const r = await rig();
  try {
    const seg = splitReply(fence(BLOC_HTML_MAX_SOURCE_BYTES))[0];
    assert.equal((await mint(r, seg.kind === 'bloc' ? seg.source : '')).status, 200, 'the very source the reader hands the page is minted');
    assert.equal((await mint(r, 'x'.repeat(BLOC_HTML_MAX_SOURCE_BYTES + 1))).status, 400, 'one byte over: refused by the mint too');
  } finally {
    await r.close();
  }
});
