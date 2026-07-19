// Minimal ui-rpc backend for E2E (plan §8.6 coexistence / version-mismatch).
//
// Speaks JUST the hello/helloOk handshake (docs/ui-rpc-protocol.md §3) over a
// unix socket, enough to exercise the GTK app's attach-time probe
// (backend::probe_backend) and its refusal/warning dialogs — NOT the full
// method surface (that arrives with the sibling transport workstream).
//
// Wire frame: [u32 BE length][payload]; JSON payload starts with '{' (0x7B).
// The client sends {t:'hello', proto, appVersion, clientKind, focused}; we
// reply {t:'helloOk', proto, appVersion, backendKind}. A proto that differs
// from the client's PROTO_VERSION (1) is what triggers the refusal path.
//
// Usage (as a module):   import { startFakeBackend } from './fake-backend.mjs'
// Usage (standalone):    node fake-backend.mjs <sock> [--proto N] [--app-version V] [--kind electron|daemon]

import net from 'node:net';
import fs from 'node:fs';

function encodeJson(obj) {
  const payload = Buffer.from(JSON.stringify(obj), 'utf8');
  const head = Buffer.alloc(4);
  head.writeUInt32BE(payload.length, 0);
  return Buffer.concat([head, payload]);
}

/** Frame the incoming byte stream: yields decoded JSON objects. */
class FrameDecoder {
  constructor() {
    this.buf = Buffer.alloc(0);
  }
  push(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    const out = [];
    while (this.buf.length >= 4) {
      const len = this.buf.readUInt32BE(0);
      if (this.buf.length < 4 + len) break;
      const payload = this.buf.subarray(4, 4 + len);
      this.buf = this.buf.subarray(4 + len);
      if (payload[0] === 0x7b) out.push(JSON.parse(payload.toString('utf8')));
      // non-JSON (pty) frames are ignored by this minimal backend
    }
    return out;
  }
}

/** Start a fake backend. Returns { sock, close() }. Options:
 *  proto (default 1), appVersion (default '9.9.9'), backendKind
 *  ('electron'|'daemon'), and onHello(frame) for assertions. */
export function startFakeBackend(sockPath, opts = {}) {
  const { proto = 1, appVersion = '9.9.9', backendKind = 'daemon', onHello } = opts;
  try {
    fs.rmSync(sockPath, { force: true });
  } catch {
    /* ignore */
  }
  const server = net.createServer((conn) => {
    const dec = new FrameDecoder();
    conn.on('data', (chunk) => {
      for (const frame of dec.push(chunk)) {
        if (frame.t === 'hello') {
          if (onHello) onHello(frame);
          conn.write(encodeJson({ t: 'helloOk', proto, appVersion, backendKind }));
        }
        // ping → pong keeps a probe-only connection from timing out; the probe
        // closes right after helloOk, so this is belt-and-suspenders.
        if (frame.t === 'ping') conn.write(encodeJson({ t: 'pong' }));
      }
    });
    conn.on('error', () => {});
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(sockPath, () => {
      resolve({
        sock: sockPath,
        close: () =>
          new Promise((res) => {
            server.close(() => res());
          }),
      });
    });
  });
}

// Standalone entrypoint (used by ORCHESTRA_DAEMON_CMD-style launches).
if (import.meta.url === `file://${process.argv[1]}`) {
  const [, , sock, ...rest] = process.argv;
  if (!sock) {
    console.error('usage: node fake-backend.mjs <sock> [--proto N] [--app-version V] [--kind electron|daemon]');
    process.exit(2);
  }
  const opts = {};
  for (let i = 0; i < rest.length; i += 2) {
    if (rest[i] === '--proto') opts.proto = Number(rest[i + 1]);
    else if (rest[i] === '--app-version') opts.appVersion = rest[i + 1];
    else if (rest[i] === '--kind') opts.backendKind = rest[i + 1];
  }
  startFakeBackend(sock, opts).then(() => {
    console.error(`[fake-backend] listening on ${sock} (proto=${opts.proto ?? 1})`);
  });
}
