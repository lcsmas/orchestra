// Accès mobile server (#334): the security arms. Every must-FAIL arm sits beside a passing control in the same test, so a dead
// instrument (server not answering, stub not called) cannot read as a pass.

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import { createAccesMobileServer, tokenMatches, REFUSAL_LOG_BURST, REFUSAL_LOG_WINDOW_MS, type Upstream } from './server.ts';

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
const sleepMs = (ms: number) => new Promise((r) => setTimeout(r, ms));
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

test('refusal logging is rate-limited: a flood costs at most REFUSAL_LOG_BURST lines per window, then one summary', async () => {
  let t = 1_000_000;
  const logs: string[] = [];
  const server = createAccesMobileServer({ allowedLogin: LOGIN, readToken: () => TOKEN, upstream: async () => ROWS, log: (l) => logs.push(l), now: () => t });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  try {
    assert.equal((await get(port, '/api/workspaces', AUTH)).status, 200, 'control');
    for (let i = 0; i < 100; i++) assert.equal((await get(port, '/api/workspaces', { 'Tailscale-User-Login': 'colleague@x' })).status, 403);
    assert.equal(logs.length, REFUSAL_LOG_BURST, `100 refusals ⇒ ${logs.length} lines`);
    t += REFUSAL_LOG_WINDOW_MS;
    await get(port, '/api/workspaces', { 'Tailscale-User-Login': 'colleague@x' });
    assert.match(logs[REFUSAL_LOG_BURST], /^refusals: 80 more suppressed/);
    assert.match(logs[REFUSAL_LOG_BURST + 1], /^refused 403 wrong-identity/);
  } finally {
    await new Promise((r) => server.close(() => r(null)));
  }
});

test('the shell carries the browser hardening headers (CSP, no framing, no referrer, no store)', async () => {
  const r = await rig();
  try {
    const res = await new Promise<http.IncomingMessage>((resolve, reject) => {
      const q = http.request({ host: '127.0.0.1', port: r.port, path: '/', headers: ID }, resolve);
      q.on('error', reject);
      q.end();
    });
    res.resume();
    assert.equal(res.statusCode, 200);
    assert.match(String(res.headers['content-security-policy']), /default-src 'self'.*frame-ancestors 'none'/);
    assert.equal(res.headers['x-frame-options'], 'DENY');
    assert.equal(res.headers['referrer-policy'], 'no-referrer');
    assert.equal(res.headers['cache-control'], 'no-store');
    assert.equal(res.headers['access-control-allow-origin'], undefined, 'no CORS: another origin can never read a reply');
  } finally {
    await r.close();
  }
});

// ---- the real entry point: a 0600 Unix socket (no TCP at all), talks to main over a Unix socket, dies with its parent ----

function sockGet(socketPath: string, p: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const r = http.request({ socketPath, path: p, headers }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    r.on('error', reject);
    r.end();
  });
}

/** TCP listening sockets owned by `pid`, read from its own fd table vs /proc/net/tcp{,6} (no external tool). */
function tcpListenersOf(pid: number): number {
  const inodes = new Set<string>();
  for (const fd of fs.readdirSync(`/proc/${pid}/fd`)) {
    try {
      const m = /^socket:\[(\d+)\]$/.exec(fs.readlinkSync(`/proc/${pid}/fd/${fd}`));
      if (m) inodes.add(m[1]);
    } catch {}
  }
  let n = 0;
  for (const f of ['/proc/net/tcp', '/proc/net/tcp6']) {
    for (const line of fs.readFileSync(f, 'utf8').split('\n').slice(1)) {
      const cols = line.trim().split(/\s+/);
      if (cols[3] === '0A' && inodes.has(cols[9])) n++; // 0A = LISTEN
    }
  }
  return n;
}

/** Every entry process a test started — killed after each test, so a mutant that keeps one alive fails instead of hanging the run. */
const live = new Set<ReturnType<typeof spawn>>();
test.afterEach(() => {
  for (const c of live) c.kill('SIGKILL');
});

function startEntry(env: Record<string, string>) {
  const child = spawn(process.execPath, ['--experimental-strip-types', '--no-warnings', path.join(import.meta.dirname, 'index.ts')], {
    env: { PATH: process.env.PATH ?? '', ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let out = '';
  let err = '';
  child.stdout.on('data', (c) => (out += c));
  child.stderr.on('data', (c) => (err += c));
  const ready = new Promise<void>((resolve, reject) => {
    const to = setTimeout(() => reject(new Error(`no listening line; stdout=${out} stderr=${err}`)), 10_000);
    child.stdout.on('data', () => {
      if (out.includes('listening ')) {
        clearTimeout(to);
        resolve();
      }
    });
    child.on('exit', (code) => {
      clearTimeout(to);
      reject(new Error(`exited ${code}: ${err}`));
    });
  });
  ready.catch(() => {}); // a test that expects a rejection awaits it itself; never an unhandled rejection
  const exited = new Promise<number | null>((r) => child.on('exit', (code) => r(code)));
  live.add(child);
  child.on('exit', () => live.delete(child));
  return { child, ready, exited, stderr: () => err };
}

test('entry: 0600 socket in a 0700 dir, no TCP listener, reaches main, rotates, exits with its parent', { timeout: 30_000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acces-mobile-'));
  fs.chmodSync(dir, 0o700);
  const mainSock = path.join(dir, 'main.sock');
  const amSock = path.join(dir, 'am.sock');
  const tokenFile = path.join(dir, 'token');
  fs.writeFileSync(tokenFile, TOKEN + '\n', { mode: 0o600 });
  fs.mkdirSync(path.dirname(amSock), { recursive: true });
  // a stale socket from a SIGKILLed predecessor must not block the bind
  execFileSync('python3', ['-I', '-c', 'import socket,sys; socket.socket(socket.AF_UNIX).bind(sys.argv[1])', amSock]); // bound, never unlinked
  assert.ok(fs.lstatSync(amSock).isSocket(), 'control: a stale socket file is really there before the start');
  const seen: string[] = [];
  const fakeMain = http.createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    res.end(JSON.stringify(ROWS));
  });
  await new Promise<void>((r) => fakeMain.listen(mainSock, r));
  const e = startEntry({ ACCES_MOBILE_SOCKET: amSock, ACCES_MOBILE_LOGIN: LOGIN, ACCES_MOBILE_TOKEN_FILE: tokenFile, ORCHESTRA_SOCK: mainSock });
  t.after(() => {
    e.child.kill('SIGKILL');
    fakeMain.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await e.ready;
  const st = fs.statSync(amSock);
  assert.ok(st.isSocket(), 'control: the path is a socket');
  assert.equal(st.mode & 0o777, 0o600, `socket mode ${(st.mode & 0o777).toString(8)}`);
  assert.equal(tcpListenersOf(e.child.pid!), 0, 'no TCP listening socket at all');
  const res = await sockGet(amSock, '/api/workspaces', AUTH);
  assert.equal(res.status, 200, 'control through the real entry');
  assert.deepEqual(JSON.parse(res.body), ROWS);
  assert.deepEqual(seen, ['POST /mobile/workspaces']);
  assert.equal((await sockGet(amSock, '/api/workspaces', ID)).status, 401, 'no token through the real entry');
  // rotation: the entry reads the token file at every request
  const fresh = 'tok_' + 'r'.repeat(40);
  fs.writeFileSync(tokenFile, fresh + '\n');
  assert.equal((await sockGet(amSock, '/api/workspaces', AUTH)).status, 401, 'old token refused after rotation');
  assert.equal((await sockGet(amSock, '/api/workspaces', { ...ID, Authorization: `Bearer ${fresh}` })).status, 200, 'new token accepted');
  e.child.stdin.end();
  assert.equal(await Promise.race([e.exited, sleepMs(5000).then(() => 'still running')]), 0, 'parent pipe closed ⇒ clean exit');
  assert.equal(fs.existsSync(amSock), false, 'socket removed on exit');
});

test('entry must-FAIL: a socket directory open to others is refused (control: the same layout at 0700 starts)', { timeout: 30_000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acces-mobile-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const tokenFile = path.join(dir, 'token');
  fs.writeFileSync(tokenFile, TOKEN, { mode: 0o600 });
  const open = path.join(dir, 'open');
  const closed = path.join(dir, 'closed');
  fs.mkdirSync(open, { mode: 0o755 });
  fs.chmodSync(open, 0o755);
  fs.mkdirSync(closed, { mode: 0o700 });
  const base = { ACCES_MOBILE_LOGIN: LOGIN, ACCES_MOBILE_TOKEN_FILE: tokenFile, ORCHESTRA_SOCK: path.join(dir, 'main.sock') };
  const ok = startEntry({ ...base, ACCES_MOBILE_SOCKET: path.join(closed, 'am.sock') });
  await ok.ready;
  ok.child.stdin.end();
  assert.equal(await Promise.race([ok.exited, sleepMs(5000).then(() => 'still running')]), 0, 'control: 0700 dir starts and exits cleanly');
  const bad = startEntry({ ...base, ACCES_MOBILE_SOCKET: path.join(open, 'am.sock') });
  await assert.rejects(bad.ready, /must be owned by this user and mode 0700/);
  assert.equal(await Promise.race([bad.exited, sleepMs(5000).then(() => 'still running')]), 2);
  assert.equal(fs.existsSync(path.join(open, 'am.sock')), false, 'nothing bound in the open dir');
});
