// A scripted stand-in for dockerd on a unix socket, used by the relay's tests: records every request the relay
// forwards (method, url, headers, raw body) and serves the call shapes that stress a proxy — buffered and chunked
// bodies, a stream that must be flushed while still open, and a hijacked (Upgrade) connection that echoes.

import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';

export interface SeenRequest {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

export interface FakeDaemon {
  readonly sockPath: string;
  readonly seen: SeenRequest[];
  /** Release the next chunk of the open `GET /events` stream. */
  releaseEvent(): void;
  close(): Promise<void>;
}

export async function startFakeDaemon(sockPath: string): Promise<FakeDaemon> {
  const seen: SeenRequest[] = [];
  const eventGates: Array<() => void> = [];
  const sockets = new Set<net.Socket>();

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const url = req.url ?? '';
      seen.push({ method: req.method ?? '', url, headers: req.headers, body });
      if (req.method === 'GET' && url.endsWith('/_ping')) {
        res.writeHead(200, { 'content-type': 'text/plain', 'content-length': 2, 'api-version': '1.47' });
        res.end('OK');
      } else if (req.method === 'POST' && /\/containers\/create/.test(url)) {
        const out = JSON.stringify({ Id: 'fake0123456789', Warnings: [] });
        res.writeHead(201, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(out) });
        res.end(out);
      } else if (req.method === 'GET' && url.endsWith('/events')) {
        // Chunked stream: first chunk now, the next only when the test releases it — a proxy that buffers fails.
        res.writeHead(200, { 'content-type': 'application/json' });
        res.write('{"n":1}\n');
        eventGates.push(() => {
          res.write('{"n":2}\n');
          res.end();
        });
      } else if (req.method === 'POST' && url.endsWith('/build')) {
        // Reports how the body arrived; consumed it fully above, so a chunked upload is proven reassembled.
        const out = JSON.stringify({ bytes: body.length, te: req.headers['transfer-encoding'] ?? null, cl: req.headers['content-length'] ?? null });
        res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(out) });
        res.end(out);
      } else if (req.method === 'GET' && url.endsWith('/big')) {
        const big = Buffer.alloc(4 * 1024 * 1024, 0x61);
        res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': big.length });
        res.end(big);
      } else if (req.method === 'GET' && url.endsWith('/missing')) {
        const out = JSON.stringify({ message: 'No such container: missing' });
        res.writeHead(404, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(out) });
        res.end(out);
      } else {
        res.writeHead(200, { 'content-length': 0 });
        res.end();
      }
    });
  });
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  // Hijack: wait for the request's body (exec start posts JSON before the 101), answer 101, then echo upper-cased.
  server.on('upgrade', (req, sock: net.Socket, head: Buffer) => {
    const want = Number(req.headers['content-length'] ?? 0);
    let body = Buffer.from(head);
    const go = (): void => {
      seen.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body: body.subarray(0, want) });
      sock.write('HTTP/1.1 101 UPGRADED\r\nContent-Type: application/vnd.docker.raw-stream\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n');
      const rest = body.subarray(want);
      if (rest.length) sock.write(rest.toString('latin1').toUpperCase());
      sock.on('data', (d: Buffer) => sock.write(d.toString('latin1').toUpperCase()));
      sock.on('end', () => sock.end());
    };
    if (body.length >= want) go();
    else {
      const onData = (d: Buffer): void => {
        body = Buffer.concat([body, d]);
        if (body.length >= want) {
          sock.off('data', onData);
          go();
        }
      };
      sock.on('data', onData);
    }
  });

  try {
    fs.unlinkSync(sockPath);
  } catch {
    /* none */
  }
  await new Promise<void>((resolve) => server.listen(sockPath, resolve));
  return {
    sockPath,
    seen,
    releaseEvent: () => eventGates.shift()?.(),
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
}
