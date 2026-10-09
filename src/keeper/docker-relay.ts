// The keeper's Docker relay (#291, epic #284, ADR 0004): a unix-socket HTTP proxy the member's `DOCKER_HOST` points
// at. It forwards every Docker API call to the REAL socket and stamps `orchestra.ws` / `orchestra.run` on every
// `POST /containers/create` — docker run, compose and client libraries all create through that one call.
//
// IN-PROCESS on purpose: a keeper is ~60 MB RSS, a child relay process would add the same again per member.
// Isolation is per-connection (a failing connection is destroyed, never the keeper) and a supervisor restarts the
// listener when it dies, so "a broken relay never breaks a rig".
//
// Streams, chunked bodies and hijacked connections all work: normal calls ride node's http parser both ways (headers
// flushed at once, bodies piped), while an `Upgrade` call (attach, exec start, buildkit /grpc + /session) turns into
// a raw byte pipe to the daemon after its request head — never reframed.

import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import { isContainerCreate, stampCreateBodyBytes, MAX_CREATE_BODY_BYTES, maxSocketPathBytes } from '../shared/docker-relay.ts';
import { DOCKER_LABEL_RUN, DOCKER_LABEL_WS } from '../shared/docker-labels.ts';

export interface DockerRelayOptions {
  /** Where the relay listens. */
  sockPath: string;
  /** The real Docker socket it forwards to. */
  upstream: string;
  ws: string;
  run: string;
  log: (msg: string) => void;
}

export interface DockerRelay {
  readonly sockPath: string;
  /** Bind the socket; resolves true once listening, false (logged) when it cannot. Safe to call again to rebind. */
  start(): Promise<boolean>;
  /** Listening AND our socket file is still the one on disk. */
  healthy(): boolean;
  /** Simulate a crash: destroy every connection, close the listener, unlink the socket. The supervisor restarts it. */
  kill(): void;
  /** Final teardown (keeper exit): like kill, and the supervisor is not consulted. */
  stop(): void;
}

// Hop-by-hop headers belong to ONE connection; node re-derives them for the other side of the proxy.
const HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'upgrade', 'te', 'trailer', 'expect']);

function requestHeaders(req: http.IncomingMessage): http.OutgoingHttpHeaders {
  const out: http.OutgoingHttpHeaders = {};
  for (const [k, v] of Object.entries(req.headers)) if (!HOP.has(k) && v !== undefined) out[k] = v;
  return out;
}

function flatResponseHeaders(raw: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i + 1 < raw.length; i += 2) {
    const name = raw[i].toLowerCase();
    if (name === 'connection' || name === 'keep-alive' || name === 'proxy-connection' || name === 'upgrade') continue;
    out.push(raw[i], raw[i + 1]);
  }
  return out;
}

export function createDockerRelay(opts: DockerRelayOptions): DockerRelay {
  const { sockPath, upstream, log } = opts;
  const labels = { [DOCKER_LABEL_WS]: opts.ws, [DOCKER_LABEL_RUN]: opts.run };
  let server: http.Server | null = null;
  let boundIno: number | null = null;
  let stopped = false;
  const live = new Set<net.Socket>();

  /** 502 for a daemon that cannot be reached. `Connection: close` + dropping the request socket once the answer is out: a client that writes its (possibly huge) body FIRST
   *  (docker-py, python http.client) would otherwise sit on a kept-alive connection the relay never reads again, until its own timeout. */
  function badGateway(req: http.IncomingMessage, res: http.ServerResponse, e: Error): void {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    const body = JSON.stringify({ message: `orchestra docker relay: cannot reach the Docker daemon (${e.message})` });
    res.writeHead(502, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), connection: 'close' });
    res.end(body, () => req.destroy()); // belt: `Connection: close` already makes node end the socket; this drops it even with an unread body (no mutant: equivalent)
  }

  /** One request through to the daemon; `body` is a fully buffered replacement body, else the client's is piped. */
  function forward(req: http.IncomingMessage, res: http.ServerResponse, headers: http.OutgoingHttpHeaders, body?: Buffer): void {
    const hasFraming = headers['content-length'] !== undefined || headers['transfer-encoding'] !== undefined;
    if (!hasFraming && !['GET', 'HEAD', 'DELETE', 'OPTIONS'].includes(req.method ?? 'GET')) headers['content-length'] = '0';
    // keep-alive upstream: with agent:false's default `close` dockerd replies and closes the instant the body is complete, node's trailing empty write then fails EPIPE -> a false 502 for a call dockerd RAN (R13, ledger #329).
    const up = http.request({ socketPath: upstream, method: req.method, path: req.url, headers: { ...headers, connection: 'keep-alive' }, agent: false });
    up.on('response', (ur) => {
      const code = ur.statusCode ?? 502;
      // The reason phrase must be a STRING: node reads writeHead(code, headers) as "no phrase" and drops a 3rd arg.
      res.writeHead(code, ur.statusMessage || http.STATUS_CODES[code] || 'unknown', flatResponseHeaders(ur.rawHeaders));
      res.flushHeaders();
      ur.on('error', () => res.destroy());
      ur.pipe(res);
    });
    up.on('error', (e) => badGateway(req, res, e));
    res.on('close', () => {
      if (!res.writableFinished) up.destroy();
    });
    if (body) up.end(body);
    else req.pipe(up);
  }

  function handleCreate(req: http.IncomingMessage, res: http.ServerResponse): void {
    const headers = requestHeaders(req);
    const chunks: Buffer[] = [];
    let size = 0;
    let overflow = false;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_CREATE_BODY_BYTES) overflow = true;
      else chunks.push(c);
    });
    req.on('error', () => res.destroy());
    req.on('end', () => {
      if (overflow) {
        // Practically unreachable (a create body is a few KB); refuse loudly rather than forward a truncated body.
        const body = JSON.stringify({ message: 'orchestra docker relay: container create body too large' });
        res.writeHead(413, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
        res.end(body);
        return;
      }
      const original = Buffer.concat(chunks);
      let body: Buffer = original;
      try {
        const stamped = stampCreateBodyBytes(original, labels);
        if (stamped) body = stamped;
        else log(`docker relay: create body not stampable (${original.length} bytes) — forwarded unlabelled`);
      } catch (e) {
        log(`docker relay: stamping failed (${(e as Error).message}) — forwarded unlabelled`);
      }
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
      log(`docker relay: request handler threw: ${(e as Error).message}`);
      res.destroy();
    }
  }

  /** `Upgrade` (hijack): replay the request head to the daemon and pipe raw bytes both ways. */
  function onUpgrade(req: http.IncomingMessage, client: net.Socket, head: Buffer): void {
    client.setTimeout(0);
    client.setNoDelay(true);
    const up = net.connect(upstream);
    const end = (): void => {
      client.destroy();
      up.destroy();
    };
    up.once('connect', () => {
      let rawHead = `${req.method} ${req.url} HTTP/${req.httpVersion}\r\n`;
      for (let i = 0; i + 1 < req.rawHeaders.length; i += 2) rawHead += `${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}\r\n`;
      up.write(`${rawHead}\r\n`);
      if (head.length) up.write(head);
      client.pipe(up);
      up.pipe(client);
    });
    up.on('error', end);
    client.on('error', end);
    up.on('close', () => client.destroy());
    client.on('close', () => up.destroy());
  }

  function bind(): Promise<boolean> {
    return new Promise((resolve) => {
      // libuv silently TRUNCATES an over-long unix path and binds that: refuse here instead of listening elsewhere.
      if (Buffer.byteLength(sockPath) > maxSocketPathBytes()) {
        log(`docker relay: socket path too long (${Buffer.byteLength(sockPath)} bytes): ${sockPath}`);
        resolve(false);
        return;
      }
      try {
        fs.unlinkSync(sockPath); // ours by construction: one keeper per workspace owns this name
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
          log(`docker relay: cannot clear ${sockPath}: ${(e as Error).message}`);
          resolve(false);
          return;
        }
      }
      // node caps request line + headers at 16 KB; dockerd accepts ~1 MB (X-Registry-Config carries every ~/.docker/config.json
      // auth, `filters=`/`buildargs=` queries grow too) — a lower cap here fails calls that work without the relay.
      const srv = http.createServer({ maxHeaderSize: 1 << 20 }, onRequest);
      srv.requestTimeout = 0; // an image load / build context upload legitimately runs for minutes
      srv.keepAliveTimeout = 0; // never close an idle connection first: dockerd does not, and a client reusing one at the boundary would see ECONNRESET on a POST
      srv.on('upgrade', onUpgrade);
      srv.on('clientError', (_e, sock) => sock.destroy());
      srv.on('connection', (s) => {
        live.add(s);
        s.on('close', () => live.delete(s));
      });
      const onBindError = (e: Error): void => {
        log(`docker relay: cannot listen on ${sockPath}: ${e.message}`);
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
            log(`docker relay: bound socket unreadable: ${(e as Error).message}`);
          }
          server = srv;
          srv.on('error', (e) => log(`docker relay: server error: ${e.message}`));
          resolve(true);
        });
      } catch (e) {
        onBindError(e as Error); // e.g. a path over sun_path
      } finally {
        process.umask(prevMask);
      }
    });
  }

  function teardown(): void {
    const srv = server;
    server = null;
    boundIno = null;
    for (const s of live) s.destroy();
    live.clear();
    if (srv) srv.close();
    try {
      fs.unlinkSync(sockPath);
    } catch {
      /* already gone */
    }
  }

  return {
    sockPath,
    async start(): Promise<boolean> {
      if (stopped) return false;
      if (server) {
        server.close(); // a rebind: let in-flight streams on the old listener finish, accept no more
        server = null;
      }
      return bind();
    },
    healthy(): boolean {
      if (!server || !server.listening) return false;
      try {
        return boundIno !== null && fs.statSync(sockPath).ino === boundIno;
      } catch {
        return false;
      }
    },
    kill(): void {
      log('docker relay: killed');
      teardown();
    },
    stop(): void {
      stopped = true;
      teardown();
    },
  };
}

export interface RelaySupervisor {
  stop(): void;
}

/**
 * Keep `relay` listening: a restart whenever it is found unhealthy (listener closed, socket file removed), with a
 * widening delay between FAILED rebinds (1 s → 30 s) so a persistent cause cannot spin the keeper. Never gives up —
 * the cause may clear (a directory in the way is removed, the disk frees) and the member's DOCKER_HOST is frozen.
 */
export function superviseDockerRelay(relay: DockerRelay, o: { checkMs: number; log: (m: string) => void }): RelaySupervisor {
  let failures = 0;
  let nextTryAt = 0;
  let busy = false;
  let stopped = false;
  const tick = (): void => {
    if (stopped || busy || relay.healthy() || Date.now() < nextTryAt) return;
    busy = true;
    o.log('docker relay: unhealthy — restarting');
    void relay.start().then((ok) => {
      busy = false;
      if (ok) {
        failures = 0;
        o.log('docker relay: restarted');
      } else {
        failures += 1;
        nextTryAt = Date.now() + Math.min(30_000, 1000 * 2 ** Math.min(failures - 1, 5));
      }
    });
  };
  const timer = setInterval(tick, o.checkMs);
  timer.unref();
  return {
    stop(): void {
      stopped = true;
      clearInterval(timer);
    },
  };
}
