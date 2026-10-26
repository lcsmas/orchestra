/**
 * Request guard for the per-workspace loopback CDP proxy (#395, ADR 0009).
 *
 * A web page can reach `127.0.0.1:<port>` (fetch / WebSocket) and a DNS-rebinding page can even
 * present a foreign `Host`. Browsers always attach `Origin` to such requests and CLI clients never
 * do, so: ANY `Origin` header is refused, and `Host` must be exactly `127.0.0.1:<port>` or
 * `localhost:<port>` (Orca's `cdp-loopback-request-guard.ts`, research §2.2).
 *
 * On top of it the proxy URL carries an unguessable path token the host only hands to the
 * workspace's own session (`tokenMatches`): other agents run as the same uid and can read
 * `127.0.0.1` ports, so the loopback checks alone would let one workspace drive another's panel.
 */
import { timingSafeEqual } from 'node:crypto';

export type LoopbackRefusal =
  | 'origin-present'
  | 'host-missing'
  | 'host-not-loopback'
  | 'host-port-mismatch';

export type LoopbackVerdict = { ok: true } | { ok: false; reason: LoopbackRefusal };

export interface LoopbackHeaders {
  host?: string | undefined;
  origin?: string | undefined;
}

/** Decide whether a request may reach the proxy. `port` is the port the proxy listens on. */
export function checkLoopbackRequest(headers: LoopbackHeaders, port: number): LoopbackVerdict {
  // `Origin: null` and an empty value are still an Origin header: only an ABSENT one passes.
  if (headers.origin !== undefined) return { ok: false, reason: 'origin-present' };
  const host = headers.host?.trim().toLowerCase();
  if (!host) return { ok: false, reason: 'host-missing' };
  const m = /^(127\.0\.0\.1|localhost):(\d{1,5})$/.exec(host);
  if (!m) return { ok: false, reason: 'host-not-loopback' };
  if (Number(m[2]) !== port) return { ok: false, reason: 'host-port-mismatch' };
  return { ok: true };
}

/** Constant-time comparison of the URL's token segment with the proxy's token. */
export function tokenMatches(candidate: string, token: string): boolean {
  const a = Buffer.from(candidate);
  const b = Buffer.from(token);
  return a.length === b.length && b.length > 0 && timingSafeEqual(a, b);
}

/** Split `/<token>/rest...` into its token and the remaining path (`/rest...`). */
export function splitTokenPath(pathname: string): { token: string; rest: string } | null {
  const m = /^\/([A-Za-z0-9_-]+)(\/.*)?$/.exec(pathname);
  return m ? { token: m[1]!, rest: m[2] ?? '/' } : null;
}
