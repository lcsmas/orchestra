import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  UiRpcFrameDecoder,
  encodeJsonFrame,
  encodePtyWriteFrame,
  type UiRpcFrame,
  type UiRpcJsonFrame,
} from '../shared/ui-rpc-protocol.ts';
import { startUiRpcServer, type UiRpcServer } from './ui-rpc.ts';
import { anyUiClientFocused, uiClientCount } from './platform/index.ts';

// Server tests over a real (temp) unix socket with a scripted fake client.
// The handler table is injected, so no Electron and no app state is involved.

function tmpSock(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestra-uirpc-'));
  return path.join(dir, 'ui.sock');
}

/** Minimal test client: connects, decodes every inbound frame, and exposes a
 *  promise-based "wait for the next frame matching pred". */
class FakeClient {
  private socket: net.Socket;
  private decoder = new UiRpcFrameDecoder();
  private frames: UiRpcFrame[] = [];
  private waiters: Array<{ pred: (f: UiRpcFrame) => boolean; resolve: (f: UiRpcFrame) => void }> =
    [];

  constructor(socketPath: string, onConnect: () => void) {
    this.socket = net.createConnection(socketPath, onConnect);
    this.socket.on('data', (chunk) => {
      for (const f of this.decoder.push(chunk)) {
        const i = this.waiters.findIndex((w) => w.pred(f));
        if (i >= 0) {
          const [w] = this.waiters.splice(i, 1);
          w.resolve(f);
        } else {
          this.frames.push(f);
        }
      }
    });
  }

  send(frame: UiRpcJsonFrame): void {
    this.socket.write(encodeJsonFrame(frame));
  }

  sendRaw(buf: Buffer): void {
    this.socket.write(buf);
  }

  next(pred: (f: UiRpcFrame) => boolean, timeoutMs = 3000): Promise<UiRpcFrame> {
    const buffered = this.frames.findIndex(pred);
    if (buffered >= 0) return Promise.resolve(this.frames.splice(buffered, 1)[0]);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out waiting for frame')), timeoutMs);
      this.waiters.push({
        pred,
        resolve: (f) => {
          clearTimeout(timer);
          resolve(f);
        },
      });
    });
  }

  end(): void {
    this.socket.destroy();
  }
}

function connect(socketPath: string): Promise<FakeClient> {
  return new Promise((resolve, reject) => {
    const client: FakeClient = new FakeClient(socketPath, () => resolve(client));
    setTimeout(() => reject(new Error('connect timeout')), 3000).unref();
  });
}

async function hello(client: FakeClient, focused = false): Promise<UiRpcFrame> {
  client.send({ t: 'hello', proto: 1, appVersion: '0.0.0-test', clientKind: 'test', focused });
  return client.next((f) => f.t === 'helloOk');
}

interface Ctx {
  server: UiRpcServer;
  socketPath: string;
}

async function withServer(
  handlers: Record<string, (...args: never[]) => unknown>,
  fn: (ctx: Ctx) => Promise<void>,
): Promise<void> {
  const socketPath = tmpSock();
  const server = await startUiRpcServer({
    handlers,
    appVersion: '9.9.9',
    backendKind: 'daemon',
    socketPath,
    pointerFile: null,
  });
  try {
    await fn({ server, socketPath });
  } finally {
    await server.close();
  }
}

test('hello → helloOk handshake carries proto/version/backendKind', async () => {
  await withServer({}, async ({ socketPath }) => {
    const c = await connect(socketPath);
    const ok = await hello(c);
    assert.deepEqual(ok, { t: 'helloOk', proto: 1, appVersion: '9.9.9', backendKind: 'daemon' });
    c.end();
  });
});

test('socket file is created mode 0600', async () => {
  await withServer({}, async ({ socketPath }) => {
    const mode = fs.statSync(socketPath).mode & 0o777;
    assert.equal(mode, 0o600);
  });
});

test('pointer file is written and cleaned up on close', async () => {
  const socketPath = tmpSock();
  const pointerFile = path.join(path.dirname(socketPath), 'ui-sock');
  const server = await startUiRpcServer({
    handlers: {},
    appVersion: '1',
    backendKind: 'electron',
    socketPath,
    pointerFile,
  });
  assert.equal(fs.readFileSync(pointerFile, 'utf8'), socketPath);
  await server.close();
  assert.equal(fs.existsSync(pointerFile), false);
  assert.equal(fs.existsSync(socketPath), false);
});

test('req dispatches into the handler table and answers res', async () => {
  const handlers = {
    listWorkspaces: async () => [{ id: 'ws1', branch: 'main' }],
    'app:info': async () => ({ version: '9.9.9', backendKind: 'daemon' }),
  };
  await withServer(handlers, async ({ socketPath }) => {
    const c = await connect(socketPath);
    await hello(c);
    c.send({ t: 'req', id: 1, method: 'listWorkspaces', params: [] });
    const res1 = await c.next((f) => f.t === 'res' && f.id === 1);
    assert.deepEqual(res1, {
      t: 'res',
      id: 1,
      ok: true,
      result: [{ id: 'ws1', branch: 'main' }],
    });
    c.send({ t: 'req', id: 2, method: 'app:info', params: [] });
    const res2 = await c.next((f) => f.t === 'res' && f.id === 2);
    assert.equal(res2.t === 'res' && res2.ok, true);
    c.end();
  });
});

test('a rejecting handler maps to ok:false with the error message', async () => {
  const handlers = {
    deleteWorkspace: async () => {
      throw new Error('workspace not found');
    },
  };
  await withServer(handlers, async ({ socketPath }) => {
    const c = await connect(socketPath);
    await hello(c);
    c.send({ t: 'req', id: 5, method: 'deleteWorkspace', params: ['nope'] });
    const res = await c.next((f) => f.t === 'res' && f.id === 5);
    assert.deepEqual(res, {
      t: 'res',
      id: 5,
      ok: false,
      error: { message: 'workspace not found', name: 'Error' },
    });
    c.end();
  });
});

test('an unknown method answers ok:false without killing the connection', async () => {
  await withServer({}, async ({ socketPath }) => {
    const c = await connect(socketPath);
    await hello(c);
    c.send({ t: 'req', id: 9, method: 'noSuchMethod', params: [] });
    const res = await c.next((f) => f.t === 'res' && f.id === 9);
    assert.equal(res.t === 'res' && res.ok, false);
    // Connection still alive: ping → pong.
    c.send({ t: 'ping' });
    await c.next((f) => f.t === 'pong');
    c.end();
  });
});

test('positional params reach the handler verbatim', async () => {
  let got: unknown[] = [];
  const handlers = {
    renameBranch: async (...args: unknown[]) => {
      got = args;
      return { id: args[0], branch: args[1] };
    },
  };
  await withServer(handlers, async ({ socketPath }) => {
    const c = await connect(socketPath);
    await hello(c);
    c.send({ t: 'req', id: 3, method: 'renameBranch', params: ['ws1', 'new-name'] });
    await c.next((f) => f.t === 'res' && f.id === 3);
    assert.deepEqual(got, ['ws1', 'new-name']);
    c.end();
  });
});

test('saveClipboardImage base64 param is decoded to bytes', async () => {
  let got: unknown;
  const handlers = {
    saveClipboardImage: async (_mime: string, bytes: Uint8Array) => {
      got = bytes;
      return '/tmp/x.png';
    },
  };
  await withServer(handlers, async ({ socketPath }) => {
    const c = await connect(socketPath);
    await hello(c);
    const b64 = Buffer.from([1, 2, 3, 250]).toString('base64');
    c.send({ t: 'req', id: 4, method: 'saveClipboardImage', params: ['image/png', b64] });
    await c.next((f) => f.t === 'res' && f.id === 4);
    assert.ok(got instanceof Uint8Array);
    assert.deepEqual([...(got as Uint8Array)], [1, 2, 3, 250]);
    c.end();
  });
});

test('events broadcast to every handshaken client with wire channel names', async () => {
  await withServer({}, async ({ server, socketPath }) => {
    const a = await connect(socketPath);
    const b = await connect(socketPath);
    await hello(a);
    await hello(b);
    // A third connection that never says hello must NOT receive events.
    const mute = await connect(socketPath);
    server.broadcastEvent('workspace:update', [{ id: 'ws1', status: 'running' }]);
    const evA = await a.next((f) => f.t === 'event');
    const evB = await b.next((f) => f.t === 'event');
    assert.deepEqual(evA, {
      t: 'event',
      channel: 'workspaceUpdate',
      args: [{ id: 'ws1', status: 'running' }],
    });
    assert.deepEqual(evB, evA);
    // Non-contract channels are dropped silently.
    server.broadcastEvent('pty:data', ['ws1', 'x']);
    server.broadcastEvent('some:unknown', []);
    // The next real event proves nothing else arrived in between (ordering).
    server.broadcastEvent('agent:tool', ['ws1', 'Bash']);
    const next = await a.next((f) => f.t === 'event');
    assert.equal(next.t === 'event' && next.channel, 'agentTool');
    a.end();
    b.end();
    mute.end();
  });
});

test('ptyData broadcasts as binary frames; ptyWrite routes into the handler', async () => {
  const writes: Array<[string, string]> = [];
  const handlers = {
    ptyWrite: async (id: string, data: string) => {
      writes.push([id, data]);
    },
  };
  await withServer(handlers, async ({ server, socketPath }) => {
    const c = await connect(socketPath);
    await hello(c);
    server.broadcastPtyData('ws1:run', 'hello \x1b[31mred\x1b[0m');
    const f = await c.next((f) => f.t === 'ptyData');
    assert.equal(f.t === 'ptyData' && f.id, 'ws1:run');
    assert.equal(f.t === 'ptyData' && f.data.toString('utf8'), 'hello \x1b[31mred\x1b[0m');

    // Client → server binary input goes through the ptyWrite handler (the
    // heavy-resume/hasInput gate lives there, so it must not be bypassed).
    c.sendRaw(encodePtyWriteFrame('ws1', 'ls\r'));
    // Round-trip a req to guarantee the write was processed first (FIFO).
    c.send({ t: 'ping' });
    await c.next((f) => f.t === 'pong');
    assert.deepEqual(writes, [['ws1', 'ls\r']]);
    c.end();
  });
});

test('focus frames OR into anyFocused and feed the platform sink', async () => {
  await withServer({}, async ({ server, socketPath }) => {
    const a = await connect(socketPath);
    const b = await connect(socketPath);
    await hello(a, false);
    await hello(b, false);
    assert.equal(server.anyFocused(), false);
    assert.equal(anyUiClientFocused(), false); // via the registered sink
    assert.equal(uiClientCount(), 2);
    b.send({ t: 'focus', focused: true });
    // Round-trip to let the focus frame land.
    b.send({ t: 'ping' });
    await b.next((f) => f.t === 'pong');
    assert.equal(server.anyFocused(), true);
    assert.equal(anyUiClientFocused(), true);
    b.send({ t: 'focus', focused: false });
    b.send({ t: 'ping' });
    await b.next((f) => f.t === 'pong');
    assert.equal(server.anyFocused(), false);
    a.end();
    b.end();
  });
});

test('client disconnect drops it from the count', async () => {
  await withServer({}, async ({ server, socketPath }) => {
    const c = await connect(socketPath);
    await hello(c);
    assert.equal(server.clientCount(), 1);
    c.end();
    // Wait for the server side to observe the close.
    const deadline = Date.now() + 2000;
    while (server.clientCount() > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.equal(server.clientCount(), 0);
  });
});

test('a framing error tears down only the offending client', async () => {
  await withServer({}, async ({ server, socketPath }) => {
    const good = await connect(socketPath);
    await hello(good);
    const bad = await connect(socketPath);
    await hello(bad);
    // Declared length over the cap → server drops `bad`.
    const evil = Buffer.alloc(4);
    evil.writeUInt32BE(0x7fffffff, 0);
    bad.sendRaw(evil);
    const deadline = Date.now() + 2000;
    while (server.clientCount() > 1 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.equal(server.clientCount(), 1);
    // The good client still works.
    good.send({ t: 'ping' });
    await good.next((f) => f.t === 'pong');
    good.end();
    bad.end();
  });
});

test('server pings an idle client and drops it when no pong returns', async () => {
  const socketPath = tmpSock();
  const server = await startUiRpcServer({
    handlers: {},
    appVersion: '1',
    backendKind: 'daemon',
    socketPath,
    pointerFile: null,
    pingIntervalMs: 80,
    pongTimeoutMs: 60,
  });
  try {
    const c = await connect(socketPath);
    await hello(c);
    // Stay silent: the server pings at ~80ms...
    await c.next((f) => f.t === 'ping', 2000);
    // ...and with no pong the client is dropped within the grace window.
    const deadline = Date.now() + 2000;
    while (server.clientCount() > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.equal(server.clientCount(), 0);
    c.end();
  } finally {
    await server.close();
  }
});

test('a client that answers pong survives the idle ladder', async () => {
  const socketPath = tmpSock();
  const server = await startUiRpcServer({
    handlers: {},
    appVersion: '1',
    backendKind: 'daemon',
    socketPath,
    pointerFile: null,
    pingIntervalMs: 60,
    pongTimeoutMs: 200,
  });
  try {
    const c = await connect(socketPath);
    await hello(c);
    for (let i = 0; i < 3; i++) {
      await c.next((f) => f.t === 'ping', 2000);
      c.send({ t: 'pong' });
    }
    assert.equal(server.clientCount(), 1);
    c.end();
  } finally {
    await server.close();
  }
});
