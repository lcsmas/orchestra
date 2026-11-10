// The phone's bloc HTML route (#421, ADR 0011). A bloc is framed from a dedicated URL because a frame navigation cannot carry the
// bearer header: the URL carries a short-lived, unguessable id minted through the authenticated API (/api/bloc), and the route answers
// on the Tailscale identity + that id under ITS OWN response policy — never the shell's. Plain Node, no Electron (node --test drives it).

import crypto from 'node:crypto';
import { BLOC_HTML_POLICY, buildBlocDocument, type BlocTokens } from '../shared/bloc-html-document.ts';

/** An id is honoured for this long after it was minted (a loaded frame keeps running; only a NEW load needs a live id). */
export const BLOC_ID_TTL_MS = 5 * 60_000;
export const BLOC_MAX_ENTRIES = 64;
export const BLOC_MAX_TOTAL_BYTES = 16 * 1024 * 1024;
export const BLOC_ROUTE_PREFIX = '/bloc/';
/** 24 random bytes, base64url. */
export const BLOC_ID_RE = /^[A-Za-z0-9_-]{32}$/;
// INTERIM: #415's BLOC_HTML_MAX_SOURCE_BYTES replaces it on rebase (FI-1).
export const BLOC_MINT_MAX_SOURCE_BYTES = 256 * 1024;

/** The route's own policy: the frame's content policy (ONE source, `BLOC_HTML_POLICY` — the document's `<meta>` carries the same) + a sandbox with
 *  scripts and NO allow-same-origin (opaque origin) + frameable only by the shell. The shell's headers are NOT these. */
export const BLOC_ROUTE_CSP = `sandbox allow-scripts; ${BLOC_HTML_POLICY}; frame-ancestors 'self'`;

export const BLOC_ROUTE_HEADERS: Record<string, string> = {
  'Content-Type': 'text/html; charset=utf-8',
  'Content-Security-Policy': BLOC_ROUTE_CSP,
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};

export type BlocRead = { ok: true; source: string } | { ok: false; reason: 'unknown' | 'expired' | 'token-changed' };

export interface BlocStore {
  /** `tokenDigest` = digest of the token that authenticated the mint. Returns the id. */
  mint(source: string, tokenDigest: string): string;
  /** The id is valid only while the token that minted it is still THE token (regenerate ⇒ refused and dropped). */
  read(id: string, currentTokenDigest: string): BlocRead;
  size(): number;
}

export const tokenDigest = (token: string): string => crypto.createHash('sha256').update(token).digest('hex');

export function createBlocStore(now: () => number, ttlMs = BLOC_ID_TTL_MS): BlocStore {
  const entries = new Map<string, { source: string; bytes: number; digest: string; expires: number }>();
  let total = 0;
  const drop = (id: string): void => {
    const e = entries.get(id);
    if (!e) return;
    total -= e.bytes;
    entries.delete(id);
  };
  return {
    mint(source, digest) {
      const t = now();
      for (const [id, e] of entries) if (e.expires <= t) drop(id);
      const bytes = Buffer.byteLength(source);
      // Oldest first (Map keeps insertion order): a burst of mints evicts the oldest ids, never grows without bound.
      while (entries.size >= BLOC_MAX_ENTRIES || (entries.size > 0 && total + bytes > BLOC_MAX_TOTAL_BYTES)) drop(entries.keys().next().value as string);
      const id = crypto.randomBytes(24).toString('base64url');
      entries.set(id, { source, bytes, digest, expires: t + ttlMs });
      total += bytes;
      return id;
    },
    read(id, currentDigest) {
      const e = entries.get(id);
      if (!e) return { ok: false, reason: 'unknown' };
      if (e.expires <= now()) {
        drop(id);
        return { ok: false, reason: 'expired' };
      }
      const a = Buffer.from(e.digest, 'hex');
      const b = Buffer.from(currentDigest, 'hex');
      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
        drop(id);
        return { ok: false, reason: 'token-changed' };
      }
      return { ok: true, source: e.source };
    },
    size: () => entries.size,
  };
}

/** The phone's colours for the frame's theme variables (the V1 tokens of conversation.ts) — the frame reads them as `var(--bloc-*)`. */
export const PHONE_BLOC_TOKENS: BlocTokens = {
  fg: '#eef1f5', muted: '#8f99a9', surface: '#1a1f26', border: '#262d37', accent: '#6ea8ff', ok: '#5bd68b', warn: '#ffb62e', err: '#ff6b6b',
  fontSize: '16px', lineHeight: '1.55', fontFamily: '-apple-system,system-ui,sans-serif',
};

/** The route's document: the shared builder (policy meta first, theme, the model's HTML, the height reporter) — the desktop's, with the phone's tokens. */
export const blocDocument = (source: string): string => buildBlocDocument({ source, tokens: PHONE_BLOC_TOKENS });
