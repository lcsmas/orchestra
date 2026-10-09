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
  /** Epoch ms the daemon saw the request (the hold tests space releases by it). */
  at: number;
}

export interface FakeDaemon {
  readonly sockPath: string;
  readonly seen: SeenRequest[];
  /** Scripted containers for `GET …/containers/<id>/json` (the labels + running flag the relay inspects before it holds a START); an unknown id answers 404 like dockerd. */
  setContainer(id: string, c: { labels?: Record<string, string> | null; running?: boolean }): void;
  /** Delay every inspect answer by this long (a daemon under swap thrash). */
  setInspectDelay(ms: number): void;
  /** The NEXT create answers with this instead of 201 + `{Id, Warnings}` (a 4xx after a long wait, a gzip / non-JSON body). One-shot. */
  nextCreate(r: { status: number; headers?: Record<string, string>; body: string | Buffer }): void;
  /** Release the next chunk of the open `GET /events` stream. */
  releaseEvent(): void;
  /** Connections currently open to this daemon (a leak shows up as a count that never comes back down). */
  openConnections(): number;
  /** Finish the open `GET /wait` response (headers already sent, NO body yet — docker wait / events with nothing to say). */
  releaseWait(): void;
  close(): Promise<void>;
}

export async function startFakeDaemon(sockPath: string): Promise<FakeDaemon> {
  const seen: SeenRequest[] = [];
  const eventGates: Array<() => void> = [];
  const waitGates: Array<() => void> = [];
  const sockets = new Set<net.Socket>();
  const containers = new Map<string, { labels?: Record<string, string> | null; running?: boolean }>();
  let inspectDelayMs = 0;
  let createOverride: { status: number; headers?: Record<string, string>; body: string | Buffer } | null = null;

  // dockerd accepts ~1 MB of headers; node's default 16 KB would make the fake daemon the thing that refuses
  const server = http.createServer({ maxHeaderSize: 1 << 20 }, (req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const url = req.url ?? '';
      seen.push({ method: req.method ?? '', url, headers: req.headers, body, at: Date.now() });
      if (req.method === 'GET' && url.endsWith('/_ping')) {
        res.writeHead(200, { 'content-type': 'text/plain', 'content-length': 2, 'api-version': '1.47' });
        res.end('OK');
      } else if (req.method === 'POST' && /\/containers\/create/.test(url) && createOverride) {
        const o = createOverride;
        createOverride = null;
        const buf = typeof o.body === 'string' ? Buffer.from(o.body) : o.body;
        res.writeHead(o.status, { 'content-length': buf.length, ...(o.headers ?? {}) });
        res.end(buf);
      } else if (req.method === 'POST' && /\/containers\/create/.test(url)) {
        const out = JSON.stringify({ Id: 'fake0123456789', Warnings: [] });
        res.writeHead(201, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(out) });
        res.end(out);
      } else if (req.method === 'GET' && /\/containers\/[^/]+\/json(\?|$)/.test(url)) {
        const id = decodeURIComponent(/\/containers\/([^/]+)\/json/.exec(url)![1]);
        const c = containers.get(id);
        const out = JSON.stringify(c ? { Id: id, Config: { Labels: c.labels ?? null }, State: { Running: c.running === true } } : { message: `No such container: ${id}` });
        setTimeout(() => {
          res.writeHead(c ? 200 : 404, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(out) });
          res.end(out);
        }, inspectDelayMs);
      } else if (req.method === 'POST' && /\/containers\/[^/]+\/start(\?|$)/.test(url)) {
        res.writeHead(204);
        res.end();
      } else if (req.method === 'GET' && url.endsWith('/events')) {
        // Chunked stream: first chunk now, the next only when the test releases it — a proxy that buffers fails.
        res.writeHead(200, { 'content-type': 'application/json' });
        res.write('{"n":1}\n');
        eventGates.push(() => {
          res.write('{"n":2}\n');
          res.end();
        });
      } else if (req.method === 'GET' && url.endsWith('/abort')) {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.write('part');
        setTimeout(() => res.destroy(), 50); // the daemon dies mid-response
      } else if (req.method === 'GET' && url.endsWith('/wait')) {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.flushHeaders();
        waitGates.push(() => res.end('late'));
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
      seen.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body: body.subarray(0, want), at: Date.now() });
      sock.write('HTTP/1.1 101 UPGRADED\r\nContent-Type: application/vnd.docker.raw-stream\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n');
      if ((req.url ?? '').includes('/eof/')) {
        // answers ONLY after the client's EOF (a CloseWrite): proves a half-close does not kill the hijack
        sock.on('data', () => {});
        sock.on('end', () => sock.end('DONE'));
        return;
      }
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
    setContainer: (id, c) => void containers.set(id, c),
    setInspectDelay: (ms) => void (inspectDelayMs = ms),
    nextCreate: (r) => void (createOverride = r),
    releaseEvent: () => eventGates.shift()?.(),
    releaseWait: () => waitGates.shift()?.(),
    openConnections: () => sockets.size,
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
}
