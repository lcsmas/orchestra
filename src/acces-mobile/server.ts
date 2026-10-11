// Accès mobile server (#334, ADR 0006): the ONLY network-facing code of the feature. Plain Node (no Electron) so node --test drives
// it with a stub upstream. Listens on a 0600 Unix socket only (index.ts); HTTPS + tailnet exposure come from `tailscale serve`, which sets
// `Tailscale-User-Login` and strips any client-sent copy (tailscale.com/kb/1312/serve). Every request needs that identity;
// every /api/* request ALSO needs the current token. Main is reached only through `upstream` (the 0600 hooks socket).

import http from 'node:http';
import crypto from 'node:crypto';
import { sameLogin } from '../shared/acces-mobile.ts';
import { APP_JS, INDEX_HTML, MANIFEST_JSON } from './page.ts';
import { PWA_ICONS } from './icons.ts';
import { SW_JS } from './sw.ts';

export type Upstream = (route: string, body: Record<string, unknown>) => Promise<unknown>;

export interface AccesMobileServerOptions {
  /** Read at EVERY request so a regenerated token applies at once. Throw / '' ⇒ every /api request is refused. */
  readToken: () => string;
  /** The single allowed Tailscale login. '' ⇒ every request is refused. */
  allowedLogin: string;
  upstream: Upstream;
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
  ...Object.fromEntries(PWA_ICONS.map((i) => [i.path, { type: 'image/png', body: i.png }])),
};

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
  return http.createServer((req, res) => {
    req.on('error', () => {});
    res.on('error', () => {});
    const method = req.method ?? 'GET';
    const pathOnly = (req.url ?? '/').split('?')[0].split('#')[0];
    const refuse = (code: 401 | 403 | 404 | 405, reason: string): void => {
      log(reason, `refused ${code} ${reason} ${method} ${pathOnly.slice(0, 80)}`);
      res.writeHead(code, { ...SECURITY_HEADERS, 'Content-Length': '0' }).end();
    };

    // 1) Identity — every request, static shell included. A Tailscale-User-Login header can only come from `serve` (it strips
    //    client copies) or from a local process, which the token below still stops.
    const login = req.headers['tailscale-user-login'];
    if (!opts.allowedLogin) return refuse(403, 'no-allowed-login');
    if (typeof login !== 'string' || login === '') return refuse(403, 'no-identity');
    if (!sameLogin(login, opts.allowedLogin)) return refuse(403, 'wrong-identity');

    if (method !== 'GET') return refuse(405, 'method');

    // 2) The static shell: no data in it, identity is enough (a navigation cannot carry a bearer header).
    const asset = STATIC[pathOnly];
    if (asset) {
      res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': asset.type });
      res.end(asset.body);
      return;
    }

    if (!pathOnly.startsWith('/api/')) return refuse(404, 'not-found');

    // 3) Data: identity AND the current token. The token is never read from the query string.
    let expected = '';
    try {
      expected = opts.readToken().trim();
    } catch {
      expected = '';
    }
    const presented = bearer(req);
    if (!presented) return refuse(401, 'no-token');
    if (!tokenMatches(presented, expected)) return refuse(401, 'bad-token');

    const json = (code: number, obj: unknown): void => {
      res.writeHead(code, { ...SECURITY_HEADERS, 'Content-Type': 'application/json' });
      res.end(JSON.stringify(obj));
    };
    if (pathOnly === '/api/workspaces') {
      opts.upstream('/mobile/workspaces', {}).then(
        (out) => json(200, out),
        (e: unknown) => {
          log('upstream', `upstream /mobile/workspaces failed: ${e instanceof Error ? e.message : String(e)}`);
          json(502, { ok: false, error: 'Orchestra unreachable' });
        },
      );
      return;
    }
    return refuse(404, 'not-found');
  });
}

/** POST JSON to main's hooks server over its Unix socket. */
export function socketUpstream(socketPath: string, timeoutMs = 5000): Upstream {
  return (route, body) =>
    new Promise((resolve, reject) => {
      const payload = JSON.stringify(body);
      const req = http.request(
        { socketPath, path: route, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }, timeout: timeoutMs },
        (res) => {
          let data = '';
          res.setEncoding('utf8');
          res.on('data', (c) => (data += c));
          res.on('end', () => {
            try {
              resolve(JSON.parse(data));
            } catch {
              reject(new Error(`bad upstream reply (${res.statusCode})`));
            }
          });
        },
      );
      req.on('timeout', () => req.destroy(new Error('upstream timeout')));
      req.on('error', reject);
      req.end(payload);
    });
}
