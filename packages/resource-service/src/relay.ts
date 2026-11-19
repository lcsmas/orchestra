// The per-run Docker relay: a unix-socket HTTP proxy that forwards every Docker API call to the REAL daemon and stamps `resctl.run=<id>` on every
// `POST /containers/create` — docker run, compose and client libraries all create through that one call. Prior art: the keeper relay (ADR 0004),
// read not imported; no hold gate here. FAIL CLOSED where the keeper fails open: a create body that cannot be labelled with certainty is refused,
// because forwarding it would leave a container the run's cleanup cannot see.
// Streams, chunked bodies and hijacked connections (attach, exec start) work: normal calls ride node's http parser both ways, an `Upgrade` call is a raw byte pipe after its head.
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { RUN_LABEL, TOKEN_LABEL } from './docker-api.ts';
import { isContainerCreate, MAX_CREATE_BODY_BYTES, stampCreateBodyBytes } from './relay-stamp.ts';

export type RelayOptions = { sockPath: string; upstream: string; runId: string; token: string; log: (m: string) => void };
export type Relay = { sockPath: string; start(): Promise<boolean>; stop(): void };

// Hop-by-hop headers belong to ONE connection; node re-derives them for the other side of the proxy.
const HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'upgrade', 'te', 'trailer', 'expect']);

function requestHeaders(req: http.IncomingMessage): http.OutgoingHttpHeaders {
  const out: http.OutgoingHttpHeaders = {};
  for (const [k, v] of Object.entries(req.headers)) if (!HOP.has(k) && v !== undefined) out[k] = v;
  return out;
}

function responseHeaders(raw: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i + 1 < raw.length; i += 2) {
    const name = raw[i].toLowerCase();
    if (name === 'connection' || name === 'keep-alive' || name === 'proxy-connection' || name === 'upgrade') continue;
    out.push(raw[i], raw[i + 1]);
  }
  return out;
}

function refuse(res: http.ServerResponse, code: number, message: string, req?: http.IncomingMessage): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  const body = JSON.stringify({ message: `resctl docker relay: ${message}` });
  res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), connection: 'close' });
  res.end(body, () => req?.destroy());
}

/**
 * How a PLAIN (non-101) answer to an Upgrade request ends, from its head: no body (HEAD, 1xx/204/304), Content-Length bytes, chunked framing, else only when the daemon closes.
 * `done(chunk)` is fed the body bytes as they arrive and says whether the answer is complete.
 */
export function plainAnswerEnd(headText: string, method: string, firstBody: Buffer): { done: (chunk: Buffer) => boolean } {
  const status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(headText)?.[1] ?? 0);
  if (method === 'HEAD' || status < 200 || status === 204 || status === 304) return { done: () => true };
  const len = /^content-length:\s*(\d+)/im.exec(headText);
  let pending: Buffer = firstBody;
  let seen = 0;
  if (len) {
    const want = Number(len[1]);
    let first = true;
    return {
      done: (chunk) => {
        seen += first ? pending.length + chunk.length : chunk.length;
        first = false;
        return seen >= want;
      },
    };
  }
  if (/^transfer-encoding:\s*chunked/im.test(headText)) {
    let first = true;
    return {
      done: (chunk) => {
        pending = Buffer.concat([first ? pending : Buffer.alloc(0), chunk]);
        first = false;
        for (;;) {
          const eol = pending.indexOf('\r\n');
          if (eol < 0) return false;
          const size = parseInt(pending.subarray(0, eol).toString('latin1').split(';')[0], 16);
          if (!Number.isFinite(size)) return true; // garbage framing: stop here
          if (size === 0) return pending.length >= eol + 4; // "0\r\n" + final "\r\n" (trailers are not supported by dockerd)
          if (pending.length < eol + 2 + size + 2) return false;
          pending = pending.subarray(eol + 2 + size + 2);
        }
      },
    };
  }
  return { done: () => false };
}

export function createRelay(opts: RelayOptions): Relay {
  const { sockPath, upstream, log } = opts;
  const labels = { [RUN_LABEL]: opts.runId, [TOKEN_LABEL]: opts.token };
  let server: http.Server | null = null;
  let boundIno: number | null = null;
  const live = new Set<net.Socket>();

  /** One request through to the daemon; `body` is a fully buffered replacement body, else the client's is piped. */
  function forward(req: http.IncomingMessage, res: http.ServerResponse, headers: http.OutgoingHttpHeaders, body?: Buffer): void {
    const hasFraming = headers['content-length'] !== undefined || headers['transfer-encoding'] !== undefined;
    if (!hasFraming && !['GET', 'HEAD', 'DELETE', 'OPTIONS'].includes(req.method ?? 'GET')) headers['content-length'] = '0';
    // keep-alive upstream: with agent:false's default `close` dockerd replies and closes the instant the body is complete, and node's trailing empty write fails EPIPE -> a false 502 for a call dockerd RAN.
    const up = http.request({ socketPath: upstream, method: req.method, path: req.url, headers: { ...headers, connection: 'keep-alive' }, agent: false });
    up.on('response', (ur) => {
      const code = ur.statusCode ?? 502;
      res.writeHead(code, ur.statusMessage || http.STATUS_CODES[code] || 'unknown', responseHeaders(ur.rawHeaders));
      res.flushHeaders();
      ur.on('error', () => res.destroy());
      ur.pipe(res);
    });
    up.on('error', (e) => refuse(res, 502, `cannot reach the Docker daemon (${e.message})`, req));
    res.on('close', () => {
      if (!res.writableFinished) up.destroy();
    });
    res.on('finish', () => {
      if (!up.writableFinished) up.destroy(); // an early answer: drop the daemon connection
    });
    if (body) up.end(body);
    else req.pipe(up);
  }

  function handleCreate(req: http.IncomingMessage, res: http.ServerResponse): void {
    const chunks: Buffer[] = [];
    let size = 0;
    let overflow = false;
    let ended = false;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_CREATE_BODY_BYTES) overflow = true;
      else chunks.push(c);
    });
    req.on('error', () => res.destroy());
    req.on('close', () => {
      if (!ended) res.destroy(); // the client left mid-body
    });
    req.on('end', () => {
      ended = true;
      if (overflow) return refuse(res, 413, 'container create body too large');
      const original = Buffer.concat(chunks);
      let body: Buffer | null = null;
      try {
        body = stampCreateBodyBytes(original, labels);
      } catch (e) {
        log(`stamping threw: ${(e as Error).message}`);
      }
      if (!body) {
        log(`create body not labellable (${original.length} bytes): refused`);
        return refuse(res, 400, `cannot label this container create (${RUN_LABEL}=${opts.runId}); refused`);
      }
      const headers = requestHeaders(req);
      delete headers['transfer-encoding'];
      headers['content-length'] = String(body.length);
      forward(req, res, headers, body);
    });
  }

  function onRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    try {
      if (isContainerCreate(req.method, req.url)) handleCreate(req, res);
      else forward(req, res, requestHeaders(req));
    } catch (e) {
      log(`request handler threw: ${(e as Error).message}`);
      res.destroy();
    }
  }

  /**
   * `Upgrade` (hijack: attach, exec start, buildkit /session + /grpc). The connection becomes a raw byte pipe ONLY once the daemon answers `101`: dockerd ignores an Upgrade header on every other
   * endpoint (a 200 with a raw/multiplexed-stream content type on `logs` is NOT a hijack) and keeps serving plain HTTP on that connection, so a pipe opened on the request alone would carry a later
   * create past the stamping (A2 review M2). The request's OWN body (Content-Length bytes: `docker exec` sends its JSON, and dockerd reads it before it answers 101) is forwarded at once; every
   * byte beyond it is held until the daemon decides. Any other answer is relayed and the connection closed.
   */
  function onUpgrade(req: http.IncomingMessage, client: net.Socket, head: Buffer): void {
    const refuse400 = (message: string): void => {
      const body = JSON.stringify({ message: `resctl docker relay: ${message}` });
      client.end(`HTTP/1.1 400 Bad Request\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);
    };
    // node hands an `Upgrade` request over as a raw socket and never reaches the create handler: forwarding a create that way would create an unlabelled container
    if (isContainerCreate(req.method, req.url)) return refuse400('a container create cannot be an Upgrade request; refused');
    const bodyLen = req.headers['content-length'] === undefined ? 0 : Number(req.headers['content-length']);
    if (req.headers['transfer-encoding'] !== undefined || !Number.isSafeInteger(bodyLen) || bodyLen < 0) return refuse400('an Upgrade request must have a Content-Length body or none; refused');
    client.setTimeout(0);
    client.setNoDelay(true);
    client.pause();
    const up = net.connect(upstream);
    let finished = false;
    const end = (): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      client.destroy();
      up.destroy();
    };
    const timer = setTimeout(end, 30_000); // a daemon that never decides
    let left = bodyLen; // request body bytes still to forward
    let held: Buffer = Buffer.alloc(0); // client bytes beyond the request body: NOT forwarded before the daemon's 101
    const feed = (chunk: Buffer): void => {
      const take = chunk.subarray(0, left);
      if (take.length) up.write(take);
      left -= take.length;
      const rest = chunk.subarray(take.length);
      if (rest.length) held = Buffer.concat([held, rest]);
    };
    let rawHead = `${req.method} ${req.url} HTTP/${req.httpVersion}\r\n`;
    for (let i = 0; i + 1 < req.rawHeaders.length; i += 2) rawHead += `${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}\r\n`;
    up.write(`${rawHead}\r\n`); // queued until the socket connects
    feed(head);
    const onBody = (d: Buffer): void => {
      feed(d);
      if (left === 0) {
        client.off('data', onBody);
        client.pause();
      }
    };
    if (left > 0) {
      client.on('data', onBody);
      client.resume();
    }

    let buf: Buffer = Buffer.alloc(0);
    let decided = false;
    let hijacked = false;
    let plain: { done: (chunk: Buffer) => boolean } | null = null;
    const onReply = (d: Buffer): void => {
      if (!decided) {
        buf = Buffer.concat([buf, d]);
        const i = buf.indexOf('\r\n\r\n');
        if (i < 0) {
          if (buf.length > 1 << 20) end();
          return;
        }
        decided = true;
        const headText = buf.subarray(0, i).toString('latin1');
        const rest = buf.subarray(i + 4);
        if (/^HTTP\/1\.[01] 101 /.test(headText)) {
          hijacked = true;
          clearTimeout(timer);
          up.off('data', onReply);
          client.write(buf);
          if (held.length) up.write(held);
          client.off('data', onBody);
          client.pipe(up);
          up.pipe(client);
          client.resume();
          return;
        }
        plain = plainAnswerEnd(headText, req.method ?? 'GET', rest);
        client.write(buf);
        if (plain.done(Buffer.alloc(0))) end2();
        return;
      }
      client.write(d);
      if (plain?.done(d)) end2();
    };
    // a plain answer is complete: let it flush, then close (the connection is never handed over)
    const end2 = (): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      client.end();
      up.destroy();
    };
    up.on('data', onReply);
    up.on('error', end);
    client.on('error', end);
    up.on('close', () => {
      if (hijacked) return void client.destroy();
      end2(); // a plain answer without framing ends when the daemon closes
    });
    client.on('close', () => {
      finished = true;
      clearTimeout(timer);
      up.destroy();
    });
  }

  function bind(): Promise<boolean> {
    return new Promise((resolve) => {
      try {
        fs.unlinkSync(sockPath); // ours by construction: one relay per run id owns this name (docker-env holds the run's relay lock)
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
          log(`cannot clear ${sockPath}: ${(e as Error).message}`);
          return resolve(false);
        }
      }
      // node caps request line + headers at 16 KB; dockerd accepts ~1 MB (X-Registry-Config carries every auth of ~/.docker/config.json)
      const srv = http.createServer({ maxHeaderSize: 1 << 20 }, onRequest);
      srv.requestTimeout = 0; // an image load / build context upload legitimately runs for minutes
      srv.keepAliveTimeout = 0; // never close an idle connection first: dockerd does not
      srv.on('upgrade', onUpgrade);
      srv.on('clientError', (_e, sock) => sock.destroy());
      srv.on('connection', (s) => {
        live.add(s);
        s.on('close', () => live.delete(s));
      });
      const onBindError = (e: Error): void => {
        log(`cannot listen on ${sockPath}: ${e.message}`);
        resolve(false);
      };
      srv.once('error', onBindError);
      const prevMask = process.umask(0o177); // the socket is full docker access: owner only, from the first instant
      try {
        srv.listen(sockPath, () => {
          srv.off('error', onBindError);
          try {
            fs.chmodSync(sockPath, 0o600);
            boundIno = fs.statSync(sockPath).ino;
          } catch (e) {
            log(`bound socket unreadable: ${(e as Error).message}`);
          }
          server = srv;
          srv.on('error', (e) => log(`server error: ${e.message}`));
          resolve(true);
        });
      } catch (e) {
        onBindError(e as Error);
      } finally {
        process.umask(prevMask);
      }
    });
  }

  return {
    sockPath,
    start: bind,
    stop(): void {
      const srv = server;
      server = null;
      for (const s of live) s.destroy();
      live.clear();
      srv?.close();
      try {
        if (fs.statSync(sockPath).ino === boundIno) fs.unlinkSync(sockPath); // only OUR socket file, never a successor's
      } catch {
        /* already gone */
      }
    },
  };
}
