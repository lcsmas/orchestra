import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { WebSocket } from 'ws';
import { startCdpProxy } from './browser-cdp-proxy.ts';
import type { CdpEventListener, CdpPanelPort, CdpTab, CdpTabChannel } from '../shared/cdp-proxy-core.ts';

/** One tab, a channel that echoes the method it was sent. */
function panel(): CdpPanelPort {
  const tab: CdpTab = { id: 't1', url: 'http://a/', title: 'A', active: true, openedBy: 'human' };
  const listeners = new Set<CdpEventListener>();
  const channel: CdpTabChannel = {
    send: async (method) => ({ echoed: method }),
    subscribe: (l) => { listeners.add(l); return () => listeners.delete(l); },
    onDetach: () => () => undefined,
  };
  return {
    listTabs: () => [tab],
    subscribeTabs: () => () => undefined,
    acquire: async () => channel,
    release: () => undefined,
    activateTab: () => undefined,
    userAgent: () => 'UA/1',
    invalidate: () => undefined,
    captureFallback: async () => 'FB',
    framesError: () => null,
  };
}

function get(port: number, path: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method: 'GET', headers }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: d }));
    });
    req.on('error', reject);
    req.end();
  });
}

function wsOutcome(url: string, headers: Record<string, string> = {}): Promise<{ opened: boolean; status?: number; reply?: any }> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, { headers });
    ws.on('unexpected-response', (_q, res) => resolve({ opened: false, status: res.statusCode ?? 0 }));
    ws.on('error', () => resolve({ opened: false }));
    ws.on('open', () => {
      ws.send(JSON.stringify({ id: 1, method: 'Browser.getVersion' }));
      ws.once('message', (d) => {
        ws.close();
        resolve({ opened: true, reply: JSON.parse(String(d)) });
      });
    });
  });
}

test('a CLI-shaped request is served; every browser-shaped one is refused BEFORE routing (positive control + must-refuse arms)', async () => {
  const srv = await startCdpProxy(panel());
  try {
    const u = new URL(srv.wsUrl);
    const token = u.pathname.split('/')[1]!;
    const ok = await get(srv.port, `/${token}/json/version`, { Host: `127.0.0.1:${srv.port}` });
    assert.equal(ok.status, 200);
    assert.equal(JSON.parse(ok.body).webSocketDebuggerUrl, srv.wsUrl, 'the version document points back at the same token-bearing url');

    const origin = await get(srv.port, `/${token}/json/version`, { Host: `127.0.0.1:${srv.port}`, Origin: 'http://evil.example' });
    assert.equal(origin.status, 403);
    assert.match(origin.body, /origin-present/);

    const rebind = await get(srv.port, `/${token}/json/version`, { Host: `evil.example:${srv.port}` });
    assert.equal(rebind.status, 403);
    assert.match(rebind.body, /host-not-loopback/);

    assert.equal((await get(srv.port, '/json/version', { Host: `127.0.0.1:${srv.port}` })).status, 404, 'no token');
    assert.equal((await get(srv.port, `/${'z'.repeat(token.length)}/json/version`, { Host: `127.0.0.1:${srv.port}` })).status, 404, 'wrong token');
  } finally {
    await srv.close();
  }
});

test('/json/list is active-first and carries no page ws urls', async () => {
  const srv = await startCdpProxy(panel());
  try {
    const token = new URL(srv.wsUrl).pathname.split('/')[1]!;
    const r = await get(srv.port, `/${token}/json/list`, { Host: `127.0.0.1:${srv.port}` });
    const list = JSON.parse(r.body) as Array<{ id: string; type: string }>;
    assert.equal(list.length, 1);
    assert.equal(list[0]!.type, 'page');
    assert.equal('webSocketDebuggerUrl' in list[0]!, false, 'no page-level ws endpoint is served, so none is advertised');
  } finally {
    await srv.close();
  }
});

test('WebSocket: served without Origin; refused (403) with one; refused (404) on a wrong path; a fresh proxy has a different port/token', async () => {
  const a = await startCdpProxy(panel());
  const b = await startCdpProxy(panel());
  try {
    const good = await wsOutcome(a.wsUrl);
    assert.equal(good.opened, true);
    assert.equal(good.reply.result.protocolVersion, '1.3');
    assert.deepEqual(await wsOutcome(a.wsUrl, { Origin: 'http://evil.example' }), { opened: false, status: 403 });
    assert.deepEqual(await wsOutcome(a.wsUrl.replace('/devtools/browser/', '/devtools/nope/')), { opened: false, status: 404 });
    assert.notEqual(a.wsUrl, b.wsUrl);
    assert.notEqual(new URL(a.wsUrl).pathname.split('/')[1], new URL(b.wsUrl).pathname.split('/')[1], 'one workspace\'s token never opens another\'s proxy');
    const crossToken = new URL(a.wsUrl); crossToken.port = String(b.port);
    assert.deepEqual(await wsOutcome(crossToken.toString()), { opened: false, status: 404 });
  } finally {
    await a.close();
    await b.close();
  }
});

test('close() releases the port and drops live sockets', async () => {
  const srv = await startCdpProxy(panel());
  const port = srv.port;
  const live = new WebSocket(srv.wsUrl);
  await new Promise((r) => live.once('open', r));
  const closed = new Promise((r) => live.once('close', r));
  await srv.close();
  await closed;
  const refused = await new Promise<boolean>((resolve) => {
    const s = net.connect(port, '127.0.0.1');
    s.on('connect', () => { s.destroy(); resolve(false); });
    s.on('error', () => resolve(true));
  });
  assert.equal(refused, true);
});

// ── pre-review m2: unauthenticated sockets are reaped and bounded ───────────────────────────────────────────────────────────
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function rawSocket(port: number): Promise<{ s: net.Socket; closed: () => boolean }> {
  return new Promise((resolve, reject) => {
    const s = net.connect(port, '127.0.0.1');
    let closed = false;
    s.on('close', () => { closed = true; });
    s.on('error', () => undefined);
    s.once('connect', () => resolve({ s, closed: () => closed }));
    s.once('error', reject);
  });
}

test('m2: silent and half-sent sockets are destroyed by the pre-auth clock; a slow-header dribble is dropped; a legit request still gets 200', async () => {
  const srv = await startCdpProxy(panel(), { limits: { preAuthTimeoutMs: 300, headersTimeoutMs: 600, requestTimeoutMs: 1000, maxConnections: 64 } });
  try {
    const silent = await Promise.all(Array.from({ length: 30 }, () => rawSocket(srv.port)));
    const partial = await rawSocket(srv.port);
    partial.s.write('GET /x HTTP/1.1\r\nHost: ');
    const dribble = await rawSocket(srv.port);
    const timer = setInterval(() => { try { dribble.s.write('X'); } catch { /* closed */ } }, 80);
    dribble.s.write('GET /y HTTP/1.1\r\nHost: 127.0.0.1\r\nX-Slow: ');
    const token = new URL(srv.wsUrl).pathname.split('/')[1]!;
    assert.equal((await get(srv.port, `/${token}/json/version`, { Host: `127.0.0.1:${srv.port}` })).status, 200, 'legit traffic is served while the junk is open');
    await sleep(1800);
    clearInterval(timer);
    assert.equal(silent.filter((x) => x.closed()).length, 30, 'every silent socket was reaped');
    assert.equal(partial.closed(), true, 'the half-sent request was reaped');
    assert.equal(dribble.closed(), true, 'the slow-header dribble was dropped');
    assert.equal((await get(srv.port, `/${token}/json/version`, { Host: `127.0.0.1:${srv.port}` })).status, 200);
  } finally {
    await srv.close();
  }
});

test('m2: maxConnections bounds the sockets a stranger can hold', async () => {
  const srv = await startCdpProxy(panel(), { limits: { maxConnections: 6, preAuthTimeoutMs: 5000 } });
  try {
    const socks = await Promise.all(Array.from({ length: 20 }, () => rawSocket(srv.port).catch(() => null)));
    await sleep(300);
    const alive = socks.filter((x) => x && !x.closed()).length;
    assert.ok(alive <= 6, `at most 6 held, got ${alive}`);
    assert.ok(alive >= 1);
    for (const x of socks) x?.s.destroy();
  } finally {
    await srv.close();
  }
});

test('m2: the pre-auth clock does NOT kill an admitted websocket that idles (the daemon sits connected for minutes)', async () => {
  const srv = await startCdpProxy(panel(), { limits: { preAuthTimeoutMs: 250, headersTimeoutMs: 500, requestTimeoutMs: 800 } });
  try {
    const ws = new WebSocket(srv.wsUrl);
    await new Promise((r) => ws.once('open', r));
    await sleep(1200); // 4x the pre-auth timeout
    const reply = new Promise<any>((r) => ws.once('message', (d) => r(JSON.parse(String(d)))));
    ws.send(JSON.stringify({ id: 1, method: 'Browser.getVersion' }));
    assert.equal((await reply).result.protocolVersion, '1.3');
    ws.close();
  } finally {
    await srv.close();
  }
});
