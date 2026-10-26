/**
 * Loopback HTTP+WebSocket server in front of {@link CdpProxyCore} (#395, ADR 0009): one per
 * workspace, `127.0.0.1:0`, refuses any request carrying an `Origin` header or a non-loopback
 * `Host` (and any path without the proxy's token) BEFORE reading a byte of the request.
 * Electron-free on purpose: the rig and the unit tests drive it with a fake panel port.
 */
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import { CdpProxyCore, type CdpPanelPort, type CdpTrace } from '../shared/cdp-proxy-core.ts';
import { checkLoopbackRequest, splitTokenPath, tokenMatches } from '../shared/cdp-loopback-guard.ts';

export interface CdpProxyServer {
  readonly core: CdpProxyCore;
  readonly port: number;
  /** `ws://127.0.0.1:<port>/<token>/devtools/browser/<id>` — what `agent-browser --cdp` takes. */
  readonly wsUrl: string;
  /** Resolves once the listener and every socket are closed. */
  close(): Promise<void>;
}

function refuse(res: http.ServerResponse, code: number, why: string): void {
  res.writeHead(code, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
  res.end(why);
}
function refuseUpgrade(socket: Duplex, code: number, why: string): void {
  socket.write(`HTTP/1.1 ${code} ${http.STATUS_CODES[code] ?? 'Error'}\r\nConnection: close\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(why)}\r\n\r\n${why}`);
  socket.destroy();
}

/** Pre-auth limits: any local process can open sockets on a loopback port, and an unauthenticated socket must not be able to hold an fd of the MAIN process forever. */
export interface CdpProxyLimits {
  /** Concurrent sockets (HTTP + websockets); one workspace needs a handful. */
  maxConnections: number;
  /** A socket that has not sent a complete request (and been admitted) within this is destroyed. Lifted once admitted: an upgraded websocket may idle for the daemon's 10 minutes. */
  preAuthTimeoutMs: number;
  /** Slow-header (slowloris) bound: a request whose headers are not complete by then is dropped. */
  headersTimeoutMs: number;
  requestTimeoutMs: number;
}
export const DEFAULT_CDP_PROXY_LIMITS: CdpProxyLimits = { maxConnections: 64, preAuthTimeoutMs: 10_000, headersTimeoutMs: 10_000, requestTimeoutMs: 30_000 };

export async function startCdpProxy(panel: CdpPanelPort, opts: { trace?: CdpTrace; limits?: Partial<CdpProxyLimits> } = {}): Promise<CdpProxyServer> {
  const limits: CdpProxyLimits = { ...DEFAULT_CDP_PROXY_LIMITS, ...opts.limits };
  const token = randomBytes(18).toString('base64url');
  const core = new CdpProxyCore(panel, opts.trace ? { trace: opts.trace } : {});
  const wss = new WebSocketServer({ noServer: true });
  const sockets = new Set<WebSocket>();
  let boundPort = 0;
  const browserPath = `/devtools/browser/${core.browserTargetId}`;

  /** Guard + token: returns the path below the token, or null after answering the refusal. */
  const admit = (req: http.IncomingMessage, answer: (code: number, why: string) => void): string | null => {
    const verdict = checkLoopbackRequest({ host: req.headers.host, origin: req.headers.origin }, boundPort);
    if (!verdict.ok) {
      answer(403, `refused: ${verdict.reason}`);
      return null;
    }
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const parts = splitTokenPath(url.pathname);
    if (!parts || !tokenMatches(parts.token, token)) {
      answer(404, 'not found');
      return null;
    }
    return parts.rest + url.search;
  };

  const base = (): string => `127.0.0.1:${boundPort}`;
  const server = http.createServer({ headersTimeout: limits.headersTimeoutMs, requestTimeout: limits.requestTimeoutMs, connectionsCheckingInterval: Math.min(2000, limits.headersTimeoutMs) }, (req, res) => {
    const rest = admit(req, (c, w) => refuse(res, c, w));
    if (rest === null) return;
    const path = rest.split('?')[0]!;
    const json = (v: unknown): void => {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify(v, null, 2));
    };
    const wsBase = `ws://${base()}/${token}`;
    (async () => {
      if (path === '/json/version') return json(core.jsonVersion(`${wsBase}${browserPath}`));
      if (path === '/json' || path === '/json/list') return json(core.jsonList(wsBase));
      if (path === '/json/new') {
        const q = new URL(rest, 'http://x').searchParams;
        const t = await core.jsonNew(q.get('url') ?? undefined);
        return json(core.jsonList(wsBase).find((e) => e.id === core.targetIdFor(t.id)) ?? {});
      }
      const act = /^\/json\/activate\/([A-F0-9]+)$/.exec(path);
      if (act) return core.jsonActivate(act[1]!) ? refuse(res, 200, 'Target activated') : refuse(res, 404, 'No such target id');
      const cls = /^\/json\/close\/([A-F0-9]+)$/.exec(path);
      if (cls) return (await core.jsonClose(cls[1]!)) ? refuse(res, 200, 'Target is closing') : refuse(res, 404, 'No such target id');
      refuse(res, 404, 'not found');
    })().catch((e) => refuse(res, 500, e instanceof Error ? e.message : String(e)));
  });

  server.maxConnections = limits.maxConnections;
  // Every accepted socket starts on the pre-auth clock (silent sockets, partial requests); `ws`'s handleUpgrade lifts it for an ADMITTED upgrade (the idle-websocket test pins that).
  server.on('connection', (socket) => socket.setTimeout(limits.preAuthTimeoutMs, () => socket.destroy()));

  server.on('upgrade', (req, socket, head) => {
    const rest = admit(req, (c, w) => refuseUpgrade(socket, c, w));
    if (rest === null) return;
    if (rest.split('?')[0] !== browserPath) return refuseUpgrade(socket, 404, 'not found');
    wss.handleUpgrade(req, socket, head, (ws) => {
      sockets.add(ws);
      const client = core.connect({ send: (m) => ws.send(JSON.stringify(m)) });
      ws.on('message', (data) => void client.message(data.toString()));
      ws.on('close', () => {
        sockets.delete(ws);
        client.close();
      });
      ws.on('error', () => ws.terminate());
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  boundPort = (server.address() as { port: number }).port;

  return {
    core,
    port: boundPort,
    wsUrl: `ws://127.0.0.1:${boundPort}/${token}${browserPath}`,
    close: () =>
      new Promise<void>((resolve) => {
        core.dispose();
        for (const ws of sockets) ws.terminate();
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
