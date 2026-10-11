// Accès mobile server (#334): the security arms. Every must-FAIL arm sits beside a passing control in the same test, so a dead
// instrument (server not answering, stub not called) cannot read as a pass.

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import { createAccesMobileServer, tokenMatches, type Upstream } from './server.ts';

const LOGIN = 'lucas.mas@mobile.club';
const TOKEN = 'tok_' + 'a'.repeat(40);
const ROWS = { ok: true, workspaces: [{ id: 'w1', name: 'secret-workspace-name', branch: 'b', group: 'g', account: 'perso', status: 'waiting', unread: false }] };

interface Rig {
  port: number;
  calls: string[];
  logs: string[];
  setToken: (t: string) => void;
  close: () => Promise<void>;
}

async function rig(opts: { allowedLogin?: string; upstream?: Upstream } = {}): Promise<Rig> {
  let token = TOKEN;
  const calls: string[] = [];
  const logs: string[] = [];
  const server = createAccesMobileServer({
    allowedLogin: opts.allowedLogin ?? LOGIN,
    readToken: () => token,
    upstream:
      opts.upstream ??
      (async (route) => {
        calls.push(route);
        return ROWS;
      }),
    log: (l) => logs.push(l),
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return {
    port: (server.address() as AddressInfo).port,
    calls,
    logs,
    setToken: (t) => (token = t),
    close: () => new Promise((r) => server.close(() => r())),
  };
}

function get(port: number, p: string, headers: Record<string, string> = {}, method = 'GET'): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method, headers }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

const ID = { 'Tailscale-User-Login': LOGIN };
const AUTH = { ...ID, Authorization: `Bearer ${TOKEN}` };

test('control: identity + token reach the workspace list through the upstream', async () => {
  const r = await rig();
  try {
    const res = await get(r.port, '/api/workspaces', AUTH);
    assert.equal(res.status, 200);
    assert.deepEqual(JSON.parse(res.body), ROWS);
    assert.deepEqual(r.calls, ['/mobile/workspaces']);
  } finally {
    await r.close();
  }
});

test('must-FAIL: no token / wrong token / malformed bearer ⇒ 401, upstream never called', async () => {
  const r = await rig();
  try {
    assert.equal((await get(r.port, '/api/workspaces', AUTH)).status, 200, 'control');
    assert.equal((await get(r.port, '/api/workspaces', ID)).status, 401);
    assert.equal((await get(r.port, '/api/workspaces', { ...ID, Authorization: `Bearer ${'b'.repeat(44)}` })).status, 401);
    assert.equal((await get(r.port, '/api/workspaces', { ...ID, Authorization: TOKEN })).status, 401, 'no Bearer scheme');
    assert.equal((await get(r.port, '/api/workspaces', { ...ID, Authorization: `Bearer ${TOKEN}x` })).status, 401, 'prefix match is not a match');
    assert.deepEqual(r.calls, ['/mobile/workspaces'], 'only the control reached main');
  } finally {
    await r.close();
  }
});

test('must-FAIL: the token in a query string is ignored', async () => {
  const r = await rig();
  try {
    assert.equal((await get(r.port, '/api/workspaces', AUTH)).status, 200, 'control');
    assert.equal((await get(r.port, `/api/workspaces?t=${TOKEN}`, ID)).status, 401);
    assert.equal((await get(r.port, `/api/workspaces?token=${TOKEN}&access_token=${TOKEN}`, ID)).status, 401);
  } finally {
    await r.close();
  }
});

test('must-FAIL: an old token stops working the moment the token file changes', async () => {
  const r = await rig();
  try {
    assert.equal((await get(r.port, '/api/workspaces', AUTH)).status, 200, 'control before regeneration');
    const fresh = 'tok_' + 'z'.repeat(40);
    r.setToken(fresh);
    assert.equal((await get(r.port, '/api/workspaces', AUTH)).status, 401, 'old token refused');
    assert.equal((await get(r.port, '/api/workspaces', { ...ID, Authorization: `Bearer ${fresh}` })).status, 200, 'new token accepted');
  } finally {
    await r.close();
  }
});

test('must-FAIL: an unreadable or empty token file refuses everything (fail closed)', async () => {
  const empty = await rig();
  empty.setToken('');
  const throwing = createAccesMobileServer({ allowedLogin: LOGIN, readToken: () => { throw new Error('ENOENT'); }, upstream: async () => ROWS });
  await new Promise<void>((r) => throwing.listen(0, '127.0.0.1', r));
  try {
    assert.equal((await get(empty.port, '/api/workspaces', AUTH)).status, 401);
    assert.equal((await get(empty.port, '/api/workspaces', { ...ID, Authorization: 'Bearer ' })).status, 401);
    assert.equal((await get((throwing.address() as AddressInfo).port, '/api/workspaces', AUTH)).status, 401);
  } finally {
    await empty.close();
    await new Promise((r) => throwing.close(() => r(null)));
  }
});

test('must-FAIL: wrong / missing Tailscale identity ⇒ 403 even with the right token, shell included', async () => {
  const r = await rig();
  try {
    assert.equal((await get(r.port, '/api/workspaces', AUTH)).status, 200, 'control');
    assert.equal((await get(r.port, '/', ID)).status, 200, 'control: shell with identity');
    const colleague = { 'Tailscale-User-Login': 'gaetan.cathelain@mobile.club', Authorization: `Bearer ${TOKEN}` };
    assert.equal((await get(r.port, '/api/workspaces', colleague)).status, 403);
    assert.equal((await get(r.port, '/api/workspaces', { Authorization: `Bearer ${TOKEN}` })).status, 403, 'direct 127.0.0.1, no identity');
    assert.equal((await get(r.port, '/api/workspaces', { 'Tailscale-User-Login': '', Authorization: `Bearer ${TOKEN}` })).status, 403);
    assert.equal((await get(r.port, '/', {})).status, 403, 'shell without identity');
    assert.equal((await get(r.port, '/app.js', colleague)).status, 403, 'shell for a colleague');
    assert.equal((await get(r.port, '/api/workspaces', { 'Tailscale-User-Login': `${LOGIN}.evil.com`, Authorization: `Bearer ${TOKEN}` })).status, 403, 'suffix is not the login');
    assert.equal((await get(r.port, '/api/workspaces', { 'Tailscale-User-Login': LOGIN.toUpperCase(), Authorization: `Bearer ${TOKEN}` })).status, 200, 'case never distinguishes two people');
  } finally {
    await r.close();
  }
});

test('must-FAIL: no allowed login configured ⇒ every request refused', async () => {
  const ok = await rig();
  const r = await rig({ allowedLogin: '' });
  try {
    assert.equal((await get(ok.port, '/api/workspaces', AUTH)).status, 200, 'control');
    assert.equal((await get(r.port, '/api/workspaces', AUTH)).status, 403);
    assert.equal((await get(r.port, '/', ID)).status, 403);
  } finally {
    await ok.close();
    await r.close();
  }
});

test('refusals reveal nothing and log no secret', async () => {
  const r = await rig();
  try {
    const refused = await get(r.port, '/api/workspaces', { 'Tailscale-User-Login': 'x@y', Authorization: `Bearer ${TOKEN}` });
    const badTok = await get(r.port, '/api/workspaces', { ...ID, Authorization: `Bearer ${'q'.repeat(40)}` });
    assert.equal(refused.body, '');
    assert.equal(badTok.body, '');
    assert.equal(r.logs.length, 2, 'one line per refusal');
    for (const l of r.logs) {
      assert.ok(!l.includes(TOKEN) && !l.includes('q'.repeat(40)) && !l.includes('x@y'), `no header value in: ${l}`);
    }
    assert.match(r.logs[0], /^refused 403 wrong-identity GET \/api\/workspaces$/);
    assert.match(r.logs[1], /^refused 401 bad-token GET \/api\/workspaces$/);
  } finally {
    await r.close();
  }
});

test('each refusal names its own reason (every guard is live, none hidden behind another)', async () => {
  const r = await rig();
  const none = await rig({ allowedLogin: '' });
  try {
    assert.equal((await get(r.port, '/api/workspaces', AUTH)).status, 200, 'control');
    await get(none.port, '/api/workspaces', AUTH);
    await get(r.port, '/api/workspaces', { Authorization: `Bearer ${TOKEN}` });
    await get(r.port, '/api/workspaces', { 'Tailscale-User-Login': 'x@y', Authorization: `Bearer ${TOKEN}` });
    await get(r.port, '/api/workspaces', ID);
    await get(r.port, '/api/workspaces', { ...ID, Authorization: `Bearer ${'q'.repeat(40)}` });
    assert.deepEqual(none.logs.map((l) => l.split(' ')[2]), ['no-allowed-login']);
    assert.deepEqual(r.logs.map((l) => l.split(' ')[2]), ['no-identity', 'wrong-identity', 'no-token', 'bad-token']);
  } finally {
    await r.close();
    await none.close();
  }
});

test('only GET; unknown paths 404 after auth; upstream failure is a 502 with no detail', async () => {
  const failing = await rig({ upstream: async () => { throw new Error('ECONNREFUSED /run/user/1000/orchestra-x.sock'); } });
  const r = await rig();
  try {
    assert.equal((await get(r.port, '/api/workspaces', AUTH, 'POST')).status, 405);
    assert.equal((await get(r.port, '/api/nope', AUTH)).status, 404);
    assert.equal((await get(r.port, '/etc/passwd', ID)).status, 404);
    const res = await get(failing.port, '/api/workspaces', AUTH);
    assert.equal(res.status, 502);
    assert.ok(!res.body.includes('.sock'), 'no socket path leaked');
  } finally {
    await failing.close();
    await r.close();
  }
});

test('tokenMatches: equal only on exact equality, never on empty', () => {
  assert.equal(tokenMatches(TOKEN, TOKEN), true);
  assert.equal(tokenMatches(TOKEN, TOKEN + 'x'), false);
  assert.equal(tokenMatches('', ''), false);
  assert.equal(tokenMatches(TOKEN, ''), false);
});

// ---- the real entry point: binds 127.0.0.1 only, talks to main over a Unix socket, dies with its parent ----

function nonLoopbackIPv4(): string | null {
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs ?? []) if (a.family === 'IPv4' && !a.internal) return a.address;
  }
  return null;
}

function connects(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect({ host, port });
    s.setTimeout(1500, () => { s.destroy(); resolve(false); });
    s.on('connect', () => { s.destroy(); resolve(true); });
    s.on('error', () => resolve(false));
  });
}

test('entry: listens on 127.0.0.1 only, reaches main over the socket, exits when its parent pipe closes', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acces-mobile-'));
  const sock = path.join(dir, 'main.sock');
  const tokenFile = path.join(dir, 'token');
  fs.writeFileSync(tokenFile, TOKEN + '\n', { mode: 0o600 });
  const seen: string[] = [];
  const fakeMain = http.createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    res.end(JSON.stringify(ROWS));
  });
  await new Promise<void>((r) => fakeMain.listen(sock, r));
  const port = 20000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, ['--experimental-strip-types', '--no-warnings', path.join(import.meta.dirname, 'index.ts')], {
    env: { PATH: process.env.PATH ?? '', ACCES_MOBILE_PORT: String(port), ACCES_MOBILE_LOGIN: LOGIN, ACCES_MOBILE_TOKEN_FILE: tokenFile, ORCHESTRA_SOCK: sock },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  t.after(() => {
    child.kill('SIGKILL');
    fakeMain.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  let out = '';
  await new Promise<void>((resolve, reject) => {
    const to = setTimeout(() => reject(new Error(`no listening line; stdout=${out}`)), 10_000);
    child.stdout.on('data', (c) => {
      out += c;
      if (out.includes(`listening ${port}`)) {
        clearTimeout(to);
        resolve();
      }
    });
    child.on('exit', (code) => reject(new Error(`exited ${code}`)));
  });
  const res = await get(port, '/api/workspaces', AUTH);
  assert.equal(res.status, 200, 'control through the real entry');
  assert.deepEqual(JSON.parse(res.body), ROWS);
  assert.deepEqual(seen, ['POST /mobile/workspaces']);
  assert.equal(await connects('127.0.0.1', port), true, 'control: loopback connects');
  const lan = nonLoopbackIPv4();
  if (lan) assert.equal(await connects(lan, port), false, `not reachable on ${lan}`);
  const exited = new Promise<number | null>((r) => child.on('exit', (code) => r(code)));
  child.stdin.end();
  assert.equal(await exited, 0, 'parent pipe closed ⇒ clean exit');
  assert.equal(await connects('127.0.0.1', port), false, 'nothing listens after exit');
});
