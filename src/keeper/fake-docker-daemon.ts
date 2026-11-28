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
  setContainer(id: string, c: ScriptedContainer): void;
  /** The NEXT `GET /containers/json` answers 500 (a daemon that cannot list): the relay's budget must fail open. One-shot. */
  failNextList(): void;
  /** Write one line to every open `GET /events?filters=…oom…` stream (the relay keeper's OOM watch). */
  emitEvent(line: string): void;
  /** Drop every open filtered event stream (a daemon restart): the watch must re-open it. */
  dropEventStreams(): void;
  /** Delay every inspect answer by this long (a daemon under swap thrash). */
  setInspectDelay(ms: number): void;
  /** The NEXT create answers with this instead of 201 + `{Id, Warnings}` (a 4xx after a long wait, a gzip / non-JSON body). One-shot. */
  nextCreate(r: { status: number; headers?: Record<string, string>; body: string | Buffer }): void;
  /** Ids of the containers the daemon still holds (#696: what a removal left). */
  containerIds(): string[];
  /** Names of the volumes the daemon still holds, created by a scripted container's mounts or `addVolume`. */
  volumeNames(): string[];
  /** A volume nothing mounts (a named volume left by an earlier container). */
  addVolume(name: string): void;
  /** Release the next chunk of the open `GET /events` stream. */
  releaseEvent(): void;
  /** Connections currently open to this daemon (a leak shows up as a count that never comes back down). */
  openConnections(): number;
  /** Finish the open `GET /wait` response (headers already sent, NO body yet — docker wait / events with nothing to say). */
  releaseWait(): void;
  close(): Promise<void>;
}

/** `memory` = `HostConfig.Memory`, `name` = the inspect `Name`, `state` = the list `State` (default: running ? 'running' : 'exited'). */
export interface ScriptedContainer {
  labels?: Record<string, string> | null;
  running?: boolean;
  memory?: number;
  nanoCpus?: number;
  name?: string;
  state?: string;
  image?: string;
  /** `HostConfig.AutoRemove`. */
  autoRemove?: boolean;
  /** Unix seconds (the list's `Created`). */
  created?: number;
  /** The inspect `Mounts`; a `volume` mount registers its volume. A 64-hex name is ANONYMOUS (what `DELETE …?v=1` takes); any other is named (it stays). */
  mounts?: Array<{ type: 'volume' | 'bind'; name?: string; destination: string }>;
}

/** `trackCreates` (#695): a container create is REMEMBERED (state `created`, its Labels + HostConfig.Memory read from the body) so a later list/inspect — the relay's budget — sees it, like dockerd. */
export async function startFakeDaemon(sockPath: string, o: { trackCreates?: boolean } = {}): Promise<FakeDaemon> {
  const seen: SeenRequest[] = [];
  const eventGates: Array<() => void> = [];
  const waitGates: Array<() => void> = [];
  const sockets = new Set<net.Socket>();
  const containers = new Map<string, ScriptedContainer>();
  const volumes = new Set<string>();
  const json = (res: http.ServerResponse, code: number, o: unknown): void => {
    const out = JSON.stringify(o);
    res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(out) });
    res.end(out);
  };
  let failList = false;
  const oomStreams = new Set<http.ServerResponse>();
  let inspectDelayMs = 0;
  let createOverride: { status: number; headers?: Record<string, string>; body: string | Buffer } | null = null;

  // dockerd accepts ~1 MB of headers; node's default 16 KB would make the fake daemon the thing that refuses
  const server = http.createServer({ maxHeaderSize: 1 << 20 }, (req, res) => {
    // answers a 400 the instant the HEADERS arrive and keeps the connection open (a daemon rejecting a call before its body is in): the relay must not leave its upstream connection behind when the client abandons the body
    if (req.method === 'POST' && (req.url ?? '').endsWith('/early-400')) {
      res.writeHead(400, { 'content-length': 2 });
      res.end('no');
      req.resume();
      return;
    }
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
        if (o.trackCreates) {
          try {
            const b = JSON.parse(body.toString('utf8')) as { Labels?: Record<string, string>; HostConfig?: { Memory?: number; NanoCpus?: number } };
            containers.set(`tracked-${containers.size}`, { labels: b.Labels ?? {}, memory: b.HostConfig?.Memory ?? 0, nanoCpus: b.HostConfig?.NanoCpus ?? 0, state: 'created', name: `tracked-${containers.size}` });
          } catch {
            /* not JSON: nothing to remember */
          }
        }
        const out = JSON.stringify({ Id: 'fake0123456789', Warnings: [] });
        res.writeHead(201, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(out) });
        res.end(out);
      } else if (req.method === 'GET' && /\/containers\/json(\?|$)/.test(url)) {
        // the list the relay's budget reads: honours `filters={"label":["k=v"],"status":[…]}` like dockerd
        const f = JSON.parse(new URL(url, 'http://x').searchParams.get('filters') ?? '{}') as { label?: string[]; status?: string[] };
        const rows = [...containers.entries()]
          .map(([id, c]) => ({ Id: id, Names: [`/${c.name ?? id}`], Image: c.image ?? 'alpine', Created: c.created ?? 0, State: c.state ?? (c.running ? 'running' : 'exited'), Labels: c.labels ?? {} }))
          .filter((r) => (f.label ?? []).every((l) => { const [k, ...v] = l.split('='); return v.length ? r.Labels[k] === v.join('=') : k in r.Labels; }) && (!f.status || f.status.includes(r.State)))
          .filter((r) => !/[?&]all=0/.test(url) || r.State === 'running');
        const out = failList ? JSON.stringify({ message: 'boom' }) : JSON.stringify(rows);
        res.writeHead(failList ? 500 : 200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(out) });
        failList = false;
        res.end(out);
      } else if (req.method === 'GET' && /\/containers\/[^/]+\/json(\?|$)/.test(url)) {
        const id = decodeURIComponent(/\/containers\/([^/]+)\/json/.exec(url)![1]);
        const c = containers.get(id);
        const out = JSON.stringify(c ? { Id: id, Name: `/${c.name ?? id}`, Config: { Image: c.image ?? 'alpine', Labels: c.labels ?? null }, HostConfig: { Memory: c.memory ?? 0, NanoCpus: c.nanoCpus ?? 0, AutoRemove: c.autoRemove === true }, State: { Running: c.running === true }, Mounts: (c.mounts ?? []).map((m) => ({ Type: m.type, Name: m.name, Destination: m.destination })) } : { message: `No such container: ${id}` });
        setTimeout(() => {
          res.writeHead(c ? 200 : 404, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(out) });
          res.end(out);
        }, inspectDelayMs);
      } else if (req.method === 'POST' && /\/containers\/[^/]+\/stop(\?|$)/.test(url) && containers.has(decodeURIComponent(/\/containers\/([^/]+)\/stop/.exec(url)![1]))) {
        const c = containers.get(decodeURIComponent(/\/containers\/([^/]+)\/stop/.exec(url)![1]))!;
        const was = c.running === true;
        c.running = false;
        c.state = 'exited';
        res.writeHead(was ? 204 : 304);
        res.end();
      } else if (req.method === 'DELETE' && /\/containers\/[^/?]+(\?|$)/.test(url)) {
        // dockerd: a running container needs force (409); `v=1` takes its ANONYMOUS volumes (64-hex names), named ones stay
        const id = decodeURIComponent(/\/containers\/([^/?]+)/.exec(url)![1]);
        const q = new URL(url, 'http://x').searchParams;
        const c = containers.get(id);
        if (!c) json(res, 404, { message: `No such container: ${id}` });
        else if (c.running && q.get('force') !== '1') json(res, 409, { message: `You cannot remove a running container ${id}. Stop the container before attempting removal or force remove` });
        else {
          containers.delete(id);
          if (q.get('v') === '1') for (const m of c.mounts ?? []) if (m.type === 'volume' && m.name && /^[0-9a-f]{64}$/.test(m.name)) volumes.delete(m.name);
          res.writeHead(204);
          res.end();
        }
      } else if (req.method === 'DELETE' && /\/volumes\/[^/?]+(\?|$)/.test(url)) {
        const name = decodeURIComponent(/\/volumes\/([^/?]+)/.exec(url)![1]);
        if (!volumes.has(name)) json(res, 404, { message: `get ${name}: no such volume` });
        else if ([...containers.values()].some((c) => (c.mounts ?? []).some((m) => m.name === name))) json(res, 409, { message: `remove ${name}: volume is in use` });
        else {
          volumes.delete(name);
          res.writeHead(204);
          res.end();
        }
      } else if (req.method === 'POST' && /\/containers\/[^/]+\/start(\?|$)/.test(url)) {
        res.writeHead(204);
        res.end();
      } else if (req.method === 'GET' && /^(\/v[\d.]+)?\/events\?/.test(url)) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.flushHeaders();
        oomStreams.add(res);
        res.on('close', () => oomStreams.delete(res));
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
    setContainer: (id, c) => {
      containers.set(id, c);
      for (const m of c.mounts ?? []) if (m.type === 'volume' && m.name) volumes.add(m.name);
    },
    containerIds: () => [...containers.keys()],
    volumeNames: () => [...volumes],
    addVolume: (name) => void volumes.add(name),
    failNextList: () => void (failList = true),
    emitEvent: (line) => void [...oomStreams].forEach((r) => r.write(`${line}\n`)),
    dropEventStreams: () => void [...oomStreams].forEach((r) => r.destroy()),
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
