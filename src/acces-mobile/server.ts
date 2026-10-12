// Accès mobile server (#334, ADR 0006): the ONLY network-facing code of the feature. Plain Node (no Electron) so node --test drives
// it with a stub upstream. Listens on a 0600 Unix socket only (index.ts); HTTPS + tailnet exposure come from `tailscale serve`, which sets
// `Tailscale-User-Login` and strips any client-sent copy (tailscale.com/kb/1312/serve). Every request needs that identity;
// every /api/* request ALSO needs the current token. Main is reached only through `upstream` (the 0600 hooks socket).

import { jsqrSource } from './jsqr-src.ts';
import http from 'node:http';
import crypto from 'node:crypto';
import { sameLogin } from '../shared/acces-mobile.ts';
import { MOBILE_LAUNCH_TIMEOUT_MS, parseMobileLaunch } from '../shared/acces-mobile-launch.ts';
import { MOBILE_ATTACH_MAX_BODY, MOBILE_SEND_MAX_BODY, MOBILE_SEND_MAX_CHARS, parseMobileAttachments } from '../shared/acces-mobile-conversation.ts';
import { APP_JS, INDEX_HTML, MANIFEST_JSON } from './page.ts';
import { CONVERSATION_CSS, CONVERSATION_JS } from './conversation.ts';
import { LAUNCH_CSS, LAUNCH_JS } from './launch.ts';
import { PWA_ICONS } from './icons.ts';
import { SW_JS } from './sw.ts';

export type Upstream = (route: string, body: Record<string, unknown>, timeoutMs?: number) => Promise<unknown>;
/** A long-lived upstream (main's `/mobile/stream`): one parsed JSON value per line; returns the abort. */
export type UpstreamStream = (route: string, onMessage: (m: unknown) => void, onEnd: () => void) => () => void;

export interface AccesMobileServerOptions {
  /** Read at EVERY request so a regenerated token applies at once. Throw / '' ⇒ every /api request is refused. */
  readToken: () => string;
  /** The single allowed Tailscale login. '' ⇒ every request is refused. */
  allowedLogin: string;
  upstream: Upstream;
  upstreamStream?: UpstreamStream;
  /** How often an open stream re-checks that its token is still THE token (regenerate / turn-off cut it). */
  streamRecheckMs?: number;
  /** One line per refusal — reason + method + path, never a header value. Rate-limited (see REFUSAL_LOG_BURST). */
  log?: (line: string) => void;
  /** Monotonic clock (ms) for the refusal-log windows; tests inject one. */
  now?: () => number;
}

/** A colleague on the tailnet can make the server refuse requests as fast as serve forwards them; each refusal used to be one line
 *  in main's synchronous log (#334 review: 190k lines / 5 s evicted orchestra.log). At most this many lines per window, then ONE
 *  summary line when the window rolls over. */
export const REFUSAL_LOG_BURST = 20;
export const REFUSAL_LOG_WINDOW_MS = 60_000;

/** One budget PER REASON: a colleague's wrong-identity flood must never hide a bad-token attempt carrying the owner's identity
 *  (#334 re-review). Clock = monotonic by default, so a wall-clock step back cannot freeze the window. */
function rateLimitedLog(log: (l: string) => void, now: () => number): (reason: string, line: string) => void {
  const budgets = new Map<string, { windowStart: number; count: number; suppressed: number }>();
  return (reason, line) => {
    const t = now();
    let b = budgets.get(reason);
    if (!b) budgets.set(reason, (b = { windowStart: t, count: 0, suppressed: 0 }));
    if (t - b.windowStart >= REFUSAL_LOG_WINDOW_MS) {
      if (b.suppressed > 0) log(`refusals: ${b.suppressed} more ${reason} suppressed in the last ${Math.round((t - b.windowStart) / 1000)} s`);
      b.windowStart = t;
      b.count = 0;
      b.suppressed = 0;
    }
    if (b.count < REFUSAL_LOG_BURST) {
      b.count++;
      log(line);
    } else {
      b.suppressed++;
    }
  };
}

const SECURITY_HEADERS: Record<string, string> = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
};

const STATIC: Record<string, { type: string; body: string | Buffer }> = {
  '/': { type: 'text/html; charset=utf-8', body: INDEX_HTML },
  '/app.js': { type: 'text/javascript; charset=utf-8', body: APP_JS },
  '/sw.js': { type: 'text/javascript; charset=utf-8', body: SW_JS },
  '/manifest.webmanifest': { type: 'application/manifest+json', body: MANIFEST_JSON },
  '/conversation.js': { type: 'text/javascript; charset=utf-8', body: CONVERSATION_JS },
  '/conversation.css': { type: 'text/css; charset=utf-8', body: CONVERSATION_CSS },
  '/launch.js': { type: 'text/javascript; charset=utf-8', body: LAUNCH_JS },
  '/launch.css': { type: 'text/css; charset=utf-8', body: LAUNCH_CSS },
  // loaded on demand by an UNPAIRED page (in-app QR pairing); not in the service worker's shell
  '/jsqr.js': { type: 'text/javascript; charset=utf-8', body: jsqrSource() },
  ...Object.fromEntries(PWA_ICONS.map((i) => [i.path, { type: 'image/png', body: i.png }])),
};

/** At most this many live streams at once (one per open phone page is the normal case). */
export const MAX_STREAMS = 8;
/** At most this many sends / answers / launches waiting on main at once (each may wait 45 s on a cold session start) — #338 review m1, #375. */
export const MAX_WRITES_IN_FLIGHT = 4;

/** Constant-time compare on fixed-length digests (lengths never leak, unequal lengths never throw). */
export function tokenMatches(presented: string, expected: string): boolean {
  if (!presented || !expected) return false;
  const a = crypto.createHash('sha256').update(presented).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

function bearer(req: http.IncomingMessage): string {
  const h = req.headers.authorization;
  if (typeof h !== 'string') return '';
  const m = /^Bearer ([A-Za-z0-9_-]{16,256})$/.exec(h.trim());
  return m ? m[1] : '';
}

export function createAccesMobileServer(opts: AccesMobileServerOptions): http.Server {
  const log = rateLimitedLog(opts.log ?? (() => {}), opts.now ?? (() => performance.now()));
  const readTokenSafe = (): string => {
    try {
      return opts.readToken().trim();
    } catch {
      return '';
    }
  };
  let openStreams = 0;
  let writesInFlight = 0;
  return http.createServer((req, res) => {
    req.on('error', () => {});
    res.on('error', () => {});
    const method = req.method ?? 'GET';
    const pathOnly = (req.url ?? '/').split('?')[0].split('#')[0];
    const refuse = (code: 400 | 401 | 403 | 404 | 405 | 413 | 415 | 429, reason: string): void => {
      log(reason, `refused ${code} ${reason} ${method} ${pathOnly.slice(0, 80)}`);
      res.writeHead(code, { ...SECURITY_HEADERS, 'Content-Length': '0' }).end();
    };

    // 1) Identity — every request, static shell included. A Tailscale-User-Login header can only come from `serve` (it strips
    //    client copies) or from a local process, which the token below still stops.
    const login = req.headers['tailscale-user-login'];
    if (!opts.allowedLogin) return refuse(403, 'no-allowed-login');
    if (typeof login !== 'string' || login === '') return refuse(403, 'no-identity');
    if (!sameLogin(login, opts.allowedLogin)) return refuse(403, 'wrong-identity');

    // GET everywhere; POST only for the state changes (« seen », send, answer, launch). Ids travel in the query string; send / answer / launch have a body.
    if (method !== 'GET' && !(method === 'POST' && (pathOnly === '/api/seen' || pathOnly === '/api/send' || pathOnly === '/api/answer' || pathOnly === '/api/launch'))) return refuse(405, 'method');

    // 2) The static shell: no data in it, identity is enough (a navigation cannot carry a bearer header).
    const asset = STATIC[pathOnly];
    if (asset) {
      res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': asset.type });
      res.end(asset.body);
      return;
    }

    if (!pathOnly.startsWith('/api/')) return refuse(404, 'not-found');

    // 3) Data: identity AND the current token. The token is never read from the query string.
    const expected = readTokenSafe();
    const presented = bearer(req);
    if (!presented) return refuse(401, 'no-token');
    if (!tokenMatches(presented, expected)) return refuse(401, 'bad-token');

    const json = (code: number, obj: unknown): void => {
      res.writeHead(code, { ...SECURITY_HEADERS, 'Content-Type': 'application/json' });
      res.end(JSON.stringify(obj));
    };
    const relay = (route: string, body: Record<string, unknown>, timeoutMs?: number): void => {
      const isWrite = route === '/mobile/send' || route === '/mobile/answer' || route === '/mobile/launch';
      if (isWrite) {
        if (writesInFlight >= MAX_WRITES_IN_FLIGHT) return refuse(429, 'too-many-writes');
        writesInFlight++;
      }
      const done = (): void => {
        if (isWrite) writesInFlight--;
      };
      opts.upstream(route, body, timeoutMs).finally(done).then(
        (out) => json(200, out),
        (e: unknown) => {
          log('upstream', `upstream ${route} failed: ${e instanceof Error ? e.message : String(e)}`);
          json(502, { ok: false, error: 'Orchestra unreachable' });
        },
      );
    };
    const query = new URLSearchParams((req.url ?? '').split('?')[1]?.split('#')[0] ?? '');
    const wsId = (): string | null => {
      const id = query.get('id');
      return id && /^[A-Za-z0-9-]{1,64}$/.test(id) ? id : null;
    };
    if (pathOnly === '/api/workspaces') return relay('/mobile/workspaces', {});
    if (pathOnly === '/api/repos') return relay('/mobile/repos', {});
    if (pathOnly === '/api/conversation') {
      const id = wsId();
      return id ? relay('/mobile/conversation', { id }) : refuse(400, 'bad-id');
    }
    if (pathOnly === '/api/seen' && method === 'POST') {
      const id = wsId();
      return id ? relay('/mobile/seen', { id }) : refuse(400, 'bad-id');
    }
    /** The body is read ONLY after identity + token passed: JSON, capped at `maxBytes` (a readable 413, then a short drain).
     *  Bytes are counted per chunk (a 20 MB send must not rescan its whole prefix on every chunk). */
    const readJson = (then: (body: Record<string, unknown>) => void, maxBytes = MOBILE_SEND_MAX_BODY): void => {
      if (!/^application\/json\b/i.test(String(req.headers['content-type'] ?? ''))) return refuse(415, 'not-json');
      let chunks: Buffer[] = [];
      let size = 0;
      let tooBig = false;
      let discarded = 0;
      req.on('data', (c: Buffer) => {
        if (tooBig) {
          // Answer 413 once, drain a little so the client can read it, then cut a sender that keeps pushing.
          discarded += c.length;
          if (discarded > 8 * MOBILE_SEND_MAX_BODY) req.destroy();
          return;
        }
        size += c.length;
        if (size > maxBytes) {
          tooBig = true;
          chunks = [];
          res.setHeader('Connection', 'close');
          refuse(413, 'too-large');
          return;
        }
        chunks.push(c);
      });
      req.on('end', () => {
        if (tooBig) return;
        let body: unknown;
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          return refuse(400, 'bad-json');
        }
        if (!body || typeof body !== 'object' || Array.isArray(body)) return refuse(400, 'bad-json');
        then(body as Record<string, unknown>);
      });
    };
    if (pathOnly === '/api/send' && method === 'POST') {
      // #338: the human's message — the desktop composer's path in main.
      const id = wsId();
      if (!id) return refuse(400, 'bad-id');
      return readJson((body) => {
        const text = body.text;
        // Files attached on the phone (images / PDFs): shape-checked here, re-validated in main; a send may be files alone.
        const atts = parseMobileAttachments(body.attachments);
        if (!atts.ok) return refuse(400, 'bad-attachments');
        if (typeof text !== 'string' || (!text.trim() && !atts.images.length) || text.length > MOBILE_SEND_MAX_CHARS) return refuse(400, 'bad-text');
        // A cold session start (CLI boot) can take seconds: give main time to say whether the message was taken.
        relay('/mobile/send', atts.images.length ? { id, text, attachments: atts.images } : { id, text }, 45_000);
      }, MOBILE_ATTACH_MAX_BODY);
    }
    if (pathOnly === '/api/answer' && method === 'POST') {
      // #339: answer a parked AskUserQuestion. Shape-checked here, validated against the real question in main.
      const id = wsId();
      const requestId = query.get('request');
      if (!id) return refuse(400, 'bad-id');
      if (!requestId || !/^[A-Za-z0-9_-]{1,200}$/.test(requestId)) return refuse(400, 'bad-request-id');
      return readJson((body) => {
        const answers = body.answers;
        const okShape =
          !!answers && typeof answers === 'object' && !Array.isArray(answers) &&
          Object.values(answers).every((v) => Array.isArray(v) && v.length <= 50 && v.every((l) => typeof l === 'string' && l.length <= 2000));
        if (!okShape) return refuse(400, 'bad-answers');
        relay('/mobile/answer', { id, requestId, answers }, 15_000);
      });
    }
    if (pathOnly === '/api/launch' && method === 'POST') {
      // #375: start a workspace from the phone. Body read after identity + token; shape-checked here (a prompt is required), the registered
      // repo is decided in main. Nothing but {repoPath, prompt} is relayed.
      return readJson((body) => {
        const parsed = parseMobileLaunch(body);
        if (!parsed.ok) return refuse(400, 'bad-launch');
        relay('/mobile/launch', { ...parsed.launch }, MOBILE_LAUNCH_TIMEOUT_MS);
      });
    }
    if (pathOnly === '/api/stream') {
      if (!opts.upstreamStream) return refuse(404, 'not-found');
      if (openStreams >= MAX_STREAMS) return refuse(429, 'too-many-streams');
      openStreams++;
      res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': 'text/event-stream', 'X-Accel-Buffering': 'no' });
      res.write(': open\n\n');
      let closed = false;
      const close = (): void => {
        if (closed) return;
        closed = true;
        openStreams--;
        clearInterval(recheck);
        abort();
        if (!res.writableEnded) res.end();
      };
      // A stream outlives the request that authenticated it: re-check the token so Regenerate / turning Accès mobile off
      // cuts it within streamRecheckMs, instead of streaming to a revoked phone until it reconnects.
      const recheck = setInterval(() => {
        if (!tokenMatches(presented, readTokenSafe())) close();
      }, opts.streamRecheckMs ?? 5000);
      const abort = opts.upstreamStream(
        '/mobile/stream',
        (m) => {
          if (closed || !m || typeof m !== 'object') return;
          const t = (m as { t?: unknown }).t;
          if (t === 'ping') res.write(': ping\n\n');
          else if (t === 'conv' || t === 'workspaces') res.write(`data: ${JSON.stringify(m)}\n\n`);
        },
        close,
      );
      res.on('close', close);
      return;
    }
    return refuse(404, 'not-found');
  });
}
