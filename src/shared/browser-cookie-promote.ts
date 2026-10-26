// Profils navigateur (#400, OPS ruling 2026-10-26): a profile keeps SESSION cookies (no expiry) across restarts. Electron 33 drops them at
// quit (`persist_session_cookies` is false), and most admin/staging sites sign in with exactly that kind — so in a PROFILE partition (never an
// ephemeral one) a session cookie is re-set with an expiry. Pure: the Electron `Cookie` in, the `cookies.set` details out.

/** Sliding: every change of a cookie re-promotes it, so the expiry is 30 days from its LAST change. */
export const PROMOTED_COOKIE_TTL_S = 30 * 24 * 3600;

/** The slice of `Electron.Cookie` the rule reads. */
export interface CookieLike {
  name: string;
  value: string;
  domain?: string;
  hostOnly?: boolean;
  path?: string;
  secure?: boolean;
  httpOnly?: boolean;
  session?: boolean;
  expirationDate?: number;
  sameSite?: 'unspecified' | 'no_restriction' | 'lax' | 'strict';
}

/** `Electron.CookiesSetDetails` for the promoted copy. */
export interface CookieSetDetails {
  url: string;
  name: string;
  value: string;
  /** Only for a DOMAIN cookie (`hostOnly === false`): a host-only cookie must stay host-only. */
  domain?: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  sameSite?: CookieLike['sameSite'];
  expirationDate: number;
}

/** The persistent copy of a session cookie, or null when there is nothing to promote (a cookie that already has an expiry — the site's own, or
 *  our earlier promotion — is left alone, which is also what stops `cookies.set` → `changed` from looping). */
export function promoteSessionCookie(c: CookieLike, nowSec: number): CookieSetDetails | null {
  if (c.session !== true || c.expirationDate !== undefined) return null;
  const host = (c.domain ?? '').replace(/^\./, '');
  if (!host || !c.name) return null;
  const path = c.path || '/';
  const secure = c.secure === true;
  const out: CookieSetDetails = {
    url: `${secure ? 'https' : 'http'}://${host}${path}`,
    name: c.name,
    value: c.value,
    path,
    secure,
    httpOnly: c.httpOnly === true,
    expirationDate: Math.floor(nowSec) + PROMOTED_COOKIE_TTL_S,
  };
  if (c.hostOnly === false && c.domain) out.domain = c.domain;
  if (c.sameSite) out.sameSite = c.sameSite;
  return out;
}
