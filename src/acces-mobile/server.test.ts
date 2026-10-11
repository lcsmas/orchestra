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
import { createAccesMobileServer, tokenMatches, MAX_STREAMS, MAX_WRITES_IN_FLIGHT, REFUSAL_LOG_BURST, REFUSAL_LOG_WINDOW_MS, type Upstream } from './server.ts';
import { CLOSE_INHERITED_FDS, pickSocketDir } from '../shared/acces-mobile.ts';
import { serveRpc, type RpcWire } from '../shared/acces-mobile-rpc.ts';
import { MOBILE_SEND_MAX_BODY, MOBILE_SEND_MAX_CHARS } from '../shared/acces-mobile-conversation.ts';

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
    assert.match(logs[REFUSAL_LOG_BURST], /^refusals: 80 more wrong-identity suppressed/);
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

/** Spawn the REAL entry the way main does: fd 3 = the private channel, on which THIS test plays main (serveRpc). */
function startEntry(env: Record<string, string>, opts: { noChannel?: boolean } = {}) {
  const child = spawn(process.execPath, ['--experimental-strip-types', '--no-warnings', path.join(import.meta.dirname, 'index.ts')], {
    env: { PATH: process.env.PATH ?? '', ...env },
    stdio: opts.noChannel ? ['pipe', 'pipe', 'pipe'] : ['pipe', 'pipe', 'pipe', 'pipe'],
  }) as ReturnType<typeof spawn> & { stdout: NodeJS.ReadableStream; stderr: NodeJS.ReadableStream; stdin: NodeJS.WritableStream };
  const seen: { route: string; body: Record<string, unknown> }[] = [];
  if (!opts.noChannel) {
    const ch = child.stdio[3] as unknown as RpcWire & { on(e: 'error', cb: () => void): unknown };
    ch.on('error', () => {});
    serveRpc(ch, {
      call: async (route, body) => {
        seen.push({ route, body });
        return route === '/mobile/workspaces' ? ROWS : { ok: true };
      },
      stream: () => null,
    });
  }
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
  return { child, ready, exited, stderr: () => err, seen };
}

test('entry: 0600 socket in a 0700 dir, no TCP listener, reaches main, rotates, exits with its parent', { timeout: 30_000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acces-mobile-'));
  fs.chmodSync(dir, 0o700);
  const amSock = path.join(dir, 'am.sock');
  const tokenFile = path.join(dir, 'token');
  fs.writeFileSync(tokenFile, TOKEN + '\n', { mode: 0o600 });
  fs.mkdirSync(path.dirname(amSock), { recursive: true });
  // a stale socket from a SIGKILLed predecessor must not block the bind
  execFileSync('python3', ['-I', '-c', 'import socket,sys; socket.socket(socket.AF_UNIX).bind(sys.argv[1])', amSock]); // bound, never unlinked
  assert.ok(fs.lstatSync(amSock).isSocket(), 'control: a stale socket file is really there before the start');
  const e = startEntry({ ACCES_MOBILE_SOCKET: amSock, ACCES_MOBILE_LOGIN: LOGIN, ACCES_MOBILE_TOKEN_FILE: tokenFile });
  t.after(() => {
    e.child.kill('SIGKILL');
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
  assert.deepEqual(e.seen.map((x) => x.route), ['/mobile/workspaces'], 'reached main over the fd-3 channel');
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
  const base = { ACCES_MOBILE_LOGIN: LOGIN, ACCES_MOBILE_TOKEN_FILE: tokenFile };
  const ok = startEntry({ ...base, ACCES_MOBILE_SOCKET: path.join(closed, 'am.sock') });
  await ok.ready;
  ok.child.stdin.end();
  assert.equal(await Promise.race([ok.exited, sleepMs(5000).then(() => 'still running')]), 0, 'control: 0700 dir starts and exits cleanly');
  const bad = startEntry({ ...base, ACCES_MOBILE_SOCKET: path.join(open, 'am.sock') });
  await assert.rejects(bad.ready, /must be owned by this user and mode 0700/);
  assert.equal(await Promise.race([bad.exited, sleepMs(5000).then(() => 'still running')]), 2);
  assert.equal(fs.existsSync(path.join(open, 'am.sock')), false, 'nothing bound in the open dir');
});

test('entry must-FAIL: a late-exiting predecessor never deletes its successor\'s socket (control: the successor answers)', { timeout: 30_000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acces-mobile-'));
  fs.chmodSync(dir, 0o700);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const tokenFile = path.join(dir, 'token');
  fs.writeFileSync(tokenFile, TOKEN, { mode: 0o600 });
  const env = { ACCES_MOBILE_SOCKET: path.join(dir, 'am.sock'), ACCES_MOBILE_LOGIN: LOGIN, ACCES_MOBILE_TOKEN_FILE: tokenFile };
  const oldSrv = startEntry(env);
  await oldSrv.ready;
  const newSrv = startEntry(env); // replaces the path while the old one is still alive (restart without waiting)
  await newSrv.ready;
  assert.equal((await sockGet(env.ACCES_MOBILE_SOCKET, '/api/workspaces', AUTH)).status, 200, 'control: the successor answers');
  oldSrv.child.stdin.end(); // the predecessor exits LATE
  assert.equal(await Promise.race([oldSrv.exited, sleepMs(5000).then(() => 'still running')]), 0);
  assert.ok(fs.existsSync(env.ACCES_MOBILE_SOCKET), 'the successor\'s socket file survives the predecessor\'s exit');
  assert.equal((await sockGet(env.ACCES_MOBILE_SOCKET, '/api/workspaces', AUTH)).status, 200, 'and still answers');
  newSrv.child.stdin.end();
  assert.equal(await Promise.race([newSrv.exited, sleepMs(5000).then(() => 'still running')]), 0);
  assert.equal(fs.existsSync(env.ACCES_MOBILE_SOCKET), false, 'the last one out removes its own socket');
});

test('entry must-FAIL: a non-socket at the socket path is refused and left intact; a dir owned by someone else is refused', { timeout: 30_000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acces-mobile-'));
  fs.chmodSync(dir, 0o700);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const tokenFile = path.join(dir, 'token');
  fs.writeFileSync(tokenFile, TOKEN, { mode: 0o600 });
  const base = { ACCES_MOBILE_LOGIN: LOGIN, ACCES_MOBILE_TOKEN_FILE: tokenFile };
  const victim = path.join(dir, 'am.sock');
  fs.writeFileSync(victim, 'precious');
  const a = startEntry({ ...base, ACCES_MOBILE_SOCKET: victim });
  await assert.rejects(a.ready, /exists and is not a socket/);
  assert.equal(fs.readFileSync(victim, 'utf8'), 'precious', 'never unlinked');
  // a 0700 directory owned by root: passes the mode clause, so only the OWNER clause can refuse it
  const rootDir = ['/root', '/etc/nftables', '/boot/grub2', '/etc/grub.d', '/etc/sudoers.d', '/var/lib/private'].find((d) => {
    try {
      const st = fs.statSync(d);
      return st.isDirectory() && st.uid === 0 && (st.mode & 0o077) === 0;
    } catch {
      return false;
    }
  });
  assert.ok(rootDir, 'instrument: found a root-owned 0700 directory to aim at');
  assert.notEqual(process.getuid?.(), 0, 'instrument: not running as root');
  const b = startEntry({ ...base, ACCES_MOBILE_SOCKET: path.join(rootDir!, 'am.sock') });
  await assert.rejects(b.ready, /must be owned by this user and mode 0700/);
});

test('the exec wrapper keeps ONLY fd 3 (the private channel) and closes every other inherited fd (control: without it the target inherits them)', async () => {
  // fds 3 and 4 are inheritable pipes, 5 a TCP LISTEN socket — what a Chromium fd without CLOEXEC looks like to the child.
  const listener = net.createServer();
  await new Promise<void>((r) => listener.listen(0, '127.0.0.1', r));
  const listenFd = (listener as unknown as { _handle: { fd: number } })._handle.fd;
  assert.ok(listenFd > 2, 'instrument: got the LISTEN socket fd');
  const run = (args: string[]) =>
    new Promise<string>((resolve, reject) => {
      const c = spawn('/bin/bash', args, { stdio: ['ignore', 'pipe', 'inherit', 'pipe', 'pipe', listenFd] });
      let out = '';
      c.stdout!.on('data', (d) => (out += d));
      c.on('close', () => resolve(out)); // 'close', not 'exit': stdout may still be in flight at exit
      c.on('error', reject);
    });
  try {
    // The target lists its OWN fds with their objects, with no fork and no pipe of its own (a shell pipeline's pipes are fds too —
    // a first version of this instrument measured them, 7/10 false FAILs).
    const lister = ['import os', 'out = []', "for n in sorted(os.listdir('/proc/self/fd'), key=int):", "    try: out.append(n + '=' + os.readlink('/proc/self/fd/' + n))", '    except OSError: pass  # the listing\'s own, already-closed dir fd', "print(' '.join(out))"].join('\n');
    const target = ['-c', 'exec python3 -I -c "$0"', lister];
    const listenObj = fs.readlinkSync(`/proc/self/fd/${listenFd}`);
    const above2 = (out: string) => out.trim().split(/\s+/).filter((kv) => Number(kv.split('=')[0]) > 2);
    const above3 = (out: string) => above2(out).filter((kv) => Number(kv.split('=')[0]) > 3);
    const bare = await run(target);
    const wrapped = await run(['-c', CLOSE_INHERITED_FDS, 'label', '/bin/bash', ...target]);
    assert.ok(above2(bare).some((kv) => kv.endsWith(listenObj)) && above2(bare).length >= 3, `control: the bare target inherits the listener + 2 pipes (got "${bare}")`);
    assert.deepEqual(above3(wrapped), [], `wrapped target fds: "${wrapped}"`);
    assert.ok(above2(wrapped).some((kv) => kv.startsWith('3=pipe:') || kv.startsWith('3=socket:')), `fd 3 (the channel) survives: "${wrapped}"`);
  } finally {
    listener.close();
  }
});

test('pickSocketDir: the runtime dir only when it is ours and 0700, else our own dir', () => {
  const st = (uid: number, mode: number, dir = true) => () => ({ isDirectory: () => dir, uid, mode });
  assert.equal(pickSocketDir('/run/user/1000', st(1000, 0o40700), 1000, '/fb'), '/run/user/1000', 'control');
  assert.equal(pickSocketDir('/run/user/1000', st(0, 0o40700), 1000, '/fb'), '/fb', 'not ours');
  assert.equal(pickSocketDir('/run/user/1000', st(1000, 0o40755), 1000, '/fb'), '/fb', 'open to others');
  assert.equal(pickSocketDir('/run/user/1000', st(1000, 0o100700, false), 1000, '/fb'), '/fb', 'not a dir');
  assert.equal(pickSocketDir(undefined, st(1000, 0o40700), 1000, '/fb'), '/fb');
  assert.equal(pickSocketDir('relative', st(1000, 0o40700), 1000, '/fb'), '/fb');
  assert.equal(pickSocketDir('/gone', () => { throw new Error('ENOENT'); }, 1000, '/fb'), '/fb');
});

test('refusal budgets are PER REASON: a colleague flood never hides a bad token from the owner\'s identity', async () => {
  let t = 0;
  const logs: string[] = [];
  const server = createAccesMobileServer({ allowedLogin: LOGIN, readToken: () => TOKEN, upstream: async () => ROWS, log: (l) => logs.push(l), now: () => t });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  try {
    for (let i = 0; i < 25; i++) await get(port, '/api/workspaces', { 'Tailscale-User-Login': 'colleague@x' });
    assert.equal(logs.length, REFUSAL_LOG_BURST, 'control: the colleague flood is capped');
    await get(port, '/api/workspaces', { ...ID, Authorization: `Bearer ${'q'.repeat(40)}` });
    assert.match(logs.at(-1)!, /^refused 401 bad-token/, 'the owner-identity bad token is still logged');
  } finally {
    await new Promise((r) => server.close(() => r(null)));
  }
});

// ---- #337: conversation, seen, live stream ----

function streamRig(opts: { recheckMs?: number } = {}) {
  let token = TOKEN;
  const calls: { route: string; body: Record<string, unknown> }[] = [];
  const subscribers = new Set<(m: unknown) => void>();
  let aborted = 0;
  const server = createAccesMobileServer({
    allowedLogin: LOGIN,
    readToken: () => token,
    upstream: async (route, body) => {
      calls.push({ route, body });
      return { ok: true, route, body };
    },
    upstreamStream: (_route, onMessage, _onEnd) => {
      subscribers.add(onMessage);
      return () => {
        aborted++;
        subscribers.delete(onMessage);
      };
    },
    streamRecheckMs: opts.recheckMs ?? 50,
  });
  return {
    server,
    calls,
    push: (m: unknown) => subscribers.forEach((s) => s(m)),
    subscribers,
    aborted: () => aborted,
    setToken: (t: string) => (token = t),
    listen: () => new Promise<number>((r) => server.listen(0, '127.0.0.1', () => r((server.address() as AddressInfo).port))),
    close: () =>
      new Promise((r) => {
        server.closeAllConnections(); // a failed arm leaves streams open: close must never wait on them
        server.close(() => r(null));
      }),
  };
}

function openStream(port: number, headers: Record<string, string>): Promise<{ status: number; chunks: string[]; ended: Promise<void>; destroy: () => void }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/api/stream', headers }, (res) => {
      const chunks: string[] = [];
      res.setEncoding('utf8');
      res.on('data', (c) => chunks.push(c));
      const ended = new Promise<void>((r) => res.on('close', () => r()));
      resolve({ status: res.statusCode ?? 0, chunks, ended, destroy: () => req.destroy() });
    });
    req.on('error', reject);
    req.end();
  });
}

test('conversation + seen relay to main with a validated id; seen is the only POST', { timeout: 15_000 }, async () => {
  const r = streamRig();
  const port = await r.listen();
  try {
    const ok = await get(port, '/api/conversation?id=4a6ad23b-ebee', AUTH);
    assert.equal(ok.status, 200, 'control');
    assert.deepEqual(r.calls.at(-1), { route: '/mobile/conversation', body: { id: '4a6ad23b-ebee' } });
    assert.equal((await get(port, '/api/conversation?id=../etc', AUTH)).status, 400);
    assert.equal((await get(port, '/api/conversation', AUTH)).status, 400);
    assert.equal((await get(port, '/api/seen?id=abc', AUTH, 'POST')).status, 200, 'control: POST seen');
    assert.deepEqual(r.calls.at(-1), { route: '/mobile/seen', body: { id: 'abc' } });
    assert.equal((await get(port, '/api/seen?id=abc', AUTH)).status, 404, 'seen via GET is not a route (no side effect on GET)');
    assert.equal((await get(port, '/api/conversation?id=abc', AUTH, 'POST')).status, 405, 'POST elsewhere refused');
    assert.equal((await get(port, '/api/seen?id=abc', ID, 'POST')).status, 401, 'seen needs the token');
    assert.equal(r.calls.length, 2, 'no refused request reached main');
  } finally {
    await r.close();
  }
});

test('stream relays change announcements as SSE, pings as comments, nothing else', { timeout: 15_000 }, async () => {
  const r = streamRig({ recheckMs: 10_000 });
  const port = await r.listen();
  try {
    const s = await openStream(port, AUTH);
    assert.equal(s.status, 200);
    await waitUntil(() => r.subscribers.size === 1);
    r.push({ t: 'conv', id: 'w1', v: 3 });
    r.push({ t: 'ping' });
    r.push({ t: 'workspaces' });
    r.push({ t: 'secret', token: TOKEN });
    await waitUntil(() => s.chunks.join('').includes('workspaces'));
    const text = s.chunks.join('');
    assert.match(text, /data: \{"t":"conv","id":"w1","v":3\}\n\n/);
    assert.match(text, /: ping\n\n/);
    assert.ok(!text.includes('secret') && !text.includes(TOKEN), 'unknown message kinds are never relayed');
    s.destroy();
    await waitUntil(() => r.aborted() === 1);
  } finally {
    await r.close();
  }
});

test('stream must-FAIL: regenerating the token cuts an open stream (control: an unchanged token keeps it open)', { timeout: 15_000 }, async () => {
  const r = streamRig({ recheckMs: 50 });
  const port = await r.listen();
  try {
    const s = await openStream(port, AUTH);
    await sleepMs(300);
    assert.equal(r.aborted(), 0, 'control: the stream stays open while the token is unchanged');
    r.setToken('tok_' + 'n'.repeat(40));
    await Promise.race([s.ended, sleepMs(2000).then(() => assert.fail('stream not cut after rotation'))]);
    assert.equal(r.aborted(), 1, 'the upstream subscription is released too');
  } finally {
    await r.close();
  }
});

test('stream: token + identity required, and at most MAX_STREAMS at once', { timeout: 15_000 }, async () => {
  const r = streamRig({ recheckMs: 10_000 });
  const port = await r.listen();
  const open: { destroy: () => void }[] = [];
  try {
    assert.equal((await openStream(port, ID)).status, 401);
    assert.equal((await openStream(port, { Authorization: `Bearer ${TOKEN}` })).status, 403);
    for (let i = 0; i < MAX_STREAMS; i++) {
      const s = await openStream(port, AUTH);
      assert.equal(s.status, 200, `stream ${i}`);
      open.push(s);
    }
    assert.equal((await openStream(port, AUTH)).status, 429, 'one more is refused');
    open.pop()!.destroy();
    await waitUntil(() => r.subscribers.size === MAX_STREAMS - 1);
    const again = await openStream(port, AUTH);
    assert.equal(again.status, 200, 'a slot frees when a stream closes');
    open.push(again);
  } finally {
    open.forEach((s) => s.destroy());
    await r.close();
  }
});

async function waitUntil(fn: () => boolean, ms = 3000): Promise<void> {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error('waitUntil timed out');
    await sleepMs(10);
  }
}

// ---- #338: send ----

function post(port: number, p: string, headers: Record<string, string>, body: string | Buffer): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method: 'POST', headers }, (res) => {
      res.on('error', () => resolve({ status: res.statusCode ?? -1, body: '' }));
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: b }));
    });
    req.on('error', (e) => ((e as NodeJS.ErrnoException).code === 'EPIPE' || (e as NodeJS.ErrnoException).code === 'ECONNRESET' ? resolve({ status: -1, body: '' }) : reject(e)));
    req.end(body);
  });
}

test('send: relayed to main with the text, only as POST JSON with identity + token, a long timeout', { timeout: 15_000 }, async () => {
  const seen: { route: string; body: Record<string, unknown>; timeoutMs?: number }[] = [];
  const server = createAccesMobileServer({ allowedLogin: LOGIN, readToken: () => TOKEN, upstream: async (route, body, timeoutMs) => (seen.push({ route, body, timeoutMs }), { ok: true }) });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  const JSONH = { ...AUTH, 'Content-Type': 'application/json' };
  try {
    const ok = await post(port, '/api/send?id=w1', JSONH, JSON.stringify({ text: 'Bonjour  ' }));
    assert.equal(ok.status, 200, 'control');
    assert.deepEqual(seen, [{ route: '/mobile/send', body: { id: 'w1', text: 'Bonjour  ' }, timeoutMs: 45_000 }]);
    assert.equal((await post(port, '/api/send?id=w1', { ...ID, 'Content-Type': 'application/json' }, '{"text":"x"}')).status, 401, 'no token');
    assert.equal((await post(port, '/api/send?id=w1', { 'Tailscale-User-Login': 'colleague@x', Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }, '{"text":"x"}')).status, 403, 'colleague');
    assert.equal((await post(port, '/api/send?id=../x', JSONH, '{"text":"x"}')).status, 400, 'bad id');
    assert.equal((await post(port, '/api/send?id=w1', { ...AUTH, 'Content-Type': 'text/plain' }, '{"text":"x"}')).status, 415, 'not JSON');
    assert.equal((await post(port, '/api/send?id=w1', JSONH, 'not json')).status, 400);
    assert.equal((await post(port, '/api/send?id=w1', JSONH, '{"text":"   "}')).status, 400, 'blank');
    assert.equal((await post(port, '/api/send?id=w1', JSONH, JSON.stringify({ text: 'x'.repeat(MOBILE_SEND_MAX_CHARS + 1) }))).status, 400, 'too many chars');
    const big = await post(port, '/api/send?id=w1', JSONH, JSON.stringify({ text: 'é'.repeat(MOBILE_SEND_MAX_BODY) }));
    assert.equal(big.status, 413, 'oversized body refused with a readable 413');
    assert.equal((await get(port, '/api/send?id=w1', AUTH)).status, 404, 'GET is not a send');
    assert.equal(seen.length, 1, 'no refused request reached main');
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(() => r(null)));
  }
});

test('entry must-FAIL: without the private fd-3 channel the server refuses to start (control: with it, it starts)', { timeout: 30_000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acces-mobile-'));
  fs.chmodSync(dir, 0o700);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const tokenFile = path.join(dir, 'token');
  fs.writeFileSync(tokenFile, TOKEN, { mode: 0o600 });
  const env = { ACCES_MOBILE_SOCKET: path.join(dir, 'am.sock'), ACCES_MOBILE_LOGIN: LOGIN, ACCES_MOBILE_TOKEN_FILE: tokenFile };
  const ok = startEntry(env);
  await ok.ready;
  ok.child.stdin.end();
  assert.equal(await Promise.race([ok.exited, sleepMs(5000).then(() => 'still running')]), 0, 'control');
  const bad = startEntry(env, { noChannel: true });
  await assert.rejects(bad.ready, /main channel/);
  assert.equal(await Promise.race([bad.exited, sleepMs(5000).then(() => 'still running')]), 2);
});

test('#338 review m1: at most MAX_WRITES_IN_FLIGHT sends/answers wait on main at once; a slot frees when one returns', { timeout: 15_000 }, async () => {
  const releases: (() => void)[] = [];
  let reached = 0;
  const server = createAccesMobileServer({
    allowedLogin: LOGIN,
    readToken: () => TOKEN,
    upstream: (route) => (route === '/mobile/send' ? (reached++, new Promise((r) => releases.push(() => r({ ok: true })))) : Promise.resolve({ ok: true })),
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  const JSONH = { ...AUTH, 'Content-Type': 'application/json' };
  try {
    const held = Array.from({ length: MAX_WRITES_IN_FLIGHT }, () => post(port, '/api/send?id=w1', JSONH, '{"text":"x"}'));
    while (reached < MAX_WRITES_IN_FLIGHT) await sleepMs(5);
    assert.equal((await post(port, '/api/send?id=w1', JSONH, '{"text":"one too many"}')).status, 429);
    assert.equal(reached, MAX_WRITES_IN_FLIGHT, 'the refused one never reached main');
    assert.equal((await get(port, '/api/workspaces', AUTH)).status, 200, 'reads are not capped by writes');
    releases.shift()!();
    assert.equal((await held[0]).status, 200);
    const again = post(port, '/api/send?id=w1', JSONH, '{"text":"now fits"}');
    while (reached < MAX_WRITES_IN_FLIGHT + 1) await sleepMs(5);
    releases.forEach((r) => r());
    assert.equal((await again).status, 200, 'a freed slot is reused');
    await Promise.all(held);
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(() => r(null)));
  }
});
