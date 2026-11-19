// A fake Docker daemon on a unix socket: just the calls the relay and the cleanup make (create / list by label filter / force-delete / ping / an Upgrade echo), recording every request.
// Containers are in memory; `running` containers refuse a non-forced delete (409) like the real daemon.
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';

export type Call = { method: string; url: string; headers: http.IncomingHttpHeaders; body: Buffer };
export type FakeContainer = { id: string; labels: Record<string, string>; running: boolean };

export class FakeDocker {
  readonly sock: string;
  readonly calls: Call[] = [];
  readonly containers = new Map<string, FakeContainer>();
  /** Hooks a test sets to shape the daemon's behaviour. */
  deleteStatus: (id: string) => number | undefined = () => undefined;
  deleteDelayMs = 0;
  /** Called AFTER the n-th list was computed (so what it adds shows up from the next list on: a create that lands between two listings). */
  afterList: (n: number) => void = () => {};
  onDelete: (id: string) => void = () => {};
  listCount = 0;
  private server: http.Server;
  private conns = new Set<net.Socket>();
  private n = 0;

  private constructor(sock: string) {
    this.sock = sock;
    this.server = this.makeServer();
  }

  /**
   * Like dockerd (Go): only a hijacking endpoint (attach, exec start, session, grpc) answers an `Upgrade` request with 101 and a raw stream; on any other path the
   * Upgrade header is IGNORED and the connection stays an ordinary HTTP connection that serves the next request too.
   */
  private makeServer(): http.Server {
    const plain = http.createServer((req, res) => void this.handle(req, res)); // no 'upgrade' listener: node parses an Upgrade request as a normal one
    const server = http.createServer((req, res) => void this.handle(req, res));
    server.on('connection', (s) => {
      this.conns.add(s);
      s.on('close', () => this.conns.delete(s));
    });
    server.on('upgrade', (req, socket, head) => {
      this.calls.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body: Buffer.alloc(0) });
      if (/\/(?:containers\/[^/]+\/attach|exec\/[^/]+\/start|session|grpc)(?:\?|$)/.test(req.url ?? '')) {
        // dockerd's exec start reads its JSON body BEFORE it hijacks: the 101 comes only once Content-Length bytes arrived
        let need = Number(req.headers['content-length'] ?? 0) - head.length;
        const go = (): void => {
          socket.write('HTTP/1.1 101 UPGRADED\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n');
          socket.on('data', (d) => socket.write(Buffer.concat([Buffer.from('echo:'), d])));
        };
        socket.on('error', () => {});
        if (need <= 0) return go();
        const onBody = (d: Buffer): void => {
          need -= d.length;
          if (need <= 0) {
            socket.off('data', onBody);
            go();
          }
        };
        socket.on('data', onBody);
        return;
      }
      this.calls.pop();
      let rawHead = `${req.method} ${req.url} HTTP/${req.httpVersion}\r\n`;
      for (let i = 0; i + 1 < req.rawHeaders.length; i += 2) rawHead += `${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}\r\n`;
      socket.unshift(Buffer.concat([Buffer.from(`${rawHead}\r\n`), head]));
      plain.emit('connection', socket);
    });
    return server;
  }

  static async start(dir: string, name = 'fake-dockerd.sock'): Promise<FakeDocker> {
    const f = new FakeDocker(path.join(dir, name));
    fs.rmSync(f.sock, { force: true });
    await new Promise<void>((resolve) => f.server.listen(f.sock, resolve));
    return f;
  }

  /** Make the socket unreachable (the daemon is down) / reachable again at the same path. */
  async down(): Promise<void> {
    for (const s of this.conns) s.destroy();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
    fs.rmSync(this.sock, { force: true });
  }
  async up(): Promise<void> {
    this.server = this.makeServer();
    await new Promise<void>((resolve) => this.server.listen(this.sock, resolve));
  }
  stop(): Promise<void> {
    return this.down();
  }

  /** A container made straight on the daemon (around any relay). */
  add(labels: Record<string, string>, running = true): FakeContainer {
    const c = { id: `c${++this.n}`.padEnd(64, '0'), labels, running };
    this.containers.set(c.id, c);
    return c;
  }
  withLabel(key: string, value: string): FakeContainer[] {
    return [...this.containers.values()].filter((c) => c.labels[key] === value);
  }
  callsTo(method: string, re: RegExp): Call[] {
    return this.calls.filter((c) => c.method === method && re.test(c.url));
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = Buffer.concat(chunks);
    const url = req.url ?? '';
    this.calls.push({ method: req.method ?? '', url, headers: req.headers, body });
    const json = (code: number, v: unknown): void => {
      const s = JSON.stringify(v);
      res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(s) });
      res.end(s);
    };
    const bare = url.replace(/^\/v\d+(?:\.\d+)*/, '');
    if (req.method === 'POST' && /^\/containers\/create(\?|$)/.test(bare)) {
      let labels: Record<string, string> = {};
      try {
        const j = JSON.parse(body.toString('utf8')) as Record<string, unknown>;
        const key = Object.keys(j).filter((k) => k.toLowerCase() === 'labels').pop();
        labels = ((key && j[key]) as Record<string, string> | null) ?? {};
      } catch {
        return json(400, { message: 'bad json' });
      }
      const c = this.add(labels);
      return json(201, { Id: c.id, Warnings: [] });
    }
    if (req.method === 'GET' && /^\/containers\/json(\?|$)/.test(bare)) {
      this.listCount++;
      const q = new URL(url, 'http://x').searchParams;
      const want: string[] = (JSON.parse(q.get('filters') ?? '{}') as { label?: string[] }).label ?? [];
      const rows = [...this.containers.values()].filter((c) => want.every((w) => (w.includes('=') ? c.labels[w.slice(0, w.indexOf('='))] === w.slice(w.indexOf('=') + 1) : w in c.labels)));
      const out = rows.map((c) => ({ Id: c.id, Labels: c.labels, State: c.running ? 'running' : 'exited' }));
      this.afterList(this.listCount);
      return json(200, out);
    }
    const del = /^\/containers\/([0-9a-z]+)(\?|$)/.exec(bare);
    if (req.method === 'DELETE' && del) {
      if (this.deleteDelayMs) await new Promise((r) => setTimeout(r, this.deleteDelayMs));
      this.onDelete(del[1]);
      const forced = this.deleteStatus(del[1]);
      if (forced !== undefined) return json(forced, { message: `fake: ${forced}` });
      const c = this.containers.get(del[1]);
      if (!c) return json(404, { message: 'no such container' });
      if (c.running && new URL(url, 'http://x').searchParams.get('force') !== '1') return json(409, { message: 'cannot remove a running container' });
      this.containers.delete(c.id);
      res.writeHead(204);
      return void res.end();
    }
    if (/^\/containers\/[^/]+\/logs/.test(bare)) {
      // not a hijack endpoint: a 200 with a raw/multiplexed-stream content type, connection kept for the next request
      const b = Buffer.from('log line\n');
      res.writeHead(200, { 'content-type': 'application/vnd.docker.multiplexed-stream', 'content-length': b.length });
      return void res.end(b);
    }
    if (bare === '/_test/chunked') {
      res.writeHead(200, { 'content-type': 'text/plain', 'transfer-encoding': 'chunked' });
      res.write('one');
      return void res.end('two');
    }
    if (bare === '/_test/204') {
      res.writeHead(204);
      return void res.end();
    }
    if (bare === '/_ping') {
      res.writeHead(200, { 'content-type': 'text/plain', 'content-length': 2 });
      return void res.end('OK');
    }
    json(200, { echo: url, bytes: body.length });
  }
}
