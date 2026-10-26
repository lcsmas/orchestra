// Profils navigateur (#400, ADR 0010): the PURE rules — id/name validity, which partition a panel uses, what attach /
// detach / delete mean, who may ask. No Electron, no store: `node --test` covers every branch
// (browser-profile.test.ts). The host wiring is main/browser-profiles.ts (service) + browser-profiles-host.ts (IPC).
import type { BrowserProfile, BrowserProfileId } from './types.ts';

export const BROWSER_PROFILE_NAME_MAX = 40;

/** `bp-` + 12 hex, minted by main. The id is embedded in a session-partition name, so anything else is refused. */
const PROFILE_ID_RE = /^bp-[0-9a-f]{12}$/;

export function isBrowserProfileId(v: unknown): v is BrowserProfileId {
  return typeof v === 'string' && PROFILE_ID_RE.test(v);
}

/** The profiles list from whatever the store holds: malformed entries and repeated ids are dropped, names trimmed,
 *  order kept. A hand-edited store can never put a bad id into a partition name. */
export function normalizeBrowserProfiles(raw: unknown): BrowserProfile[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: BrowserProfile[] = [];
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue;
    const { id, name, createdAt } = r as Record<string, unknown>;
    if (!isBrowserProfileId(id) || seen.has(id)) continue;
    const n = typeof name === 'string' ? cleanName(name) : '';
    if (!n || n.length > BROWSER_PROFILE_NAME_MAX) continue;
    seen.add(id);
    out.push({ id, name: n, createdAt: typeof createdAt === 'number' && Number.isFinite(createdAt) ? createdAt : 0 });
  }
  return out;
}

function cleanName(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
}

export type ProfileNameCheck =
  | { ok: true; name: string }
  | { ok: false; reason: 'empty' | 'too-long' | 'duplicate'; message: string };

/** A profile name: 1..40 characters once cleaned, unique (case-insensitive) among the OTHER profiles — `selfId` is
 *  the profile being renamed, so keeping or re-casing its own name is fine. */
export function checkProfileName(raw: unknown, profiles: readonly BrowserProfile[], selfId?: BrowserProfileId): ProfileNameCheck {
  const name = typeof raw === 'string' ? cleanName(raw) : '';
  if (!name) return { ok: false, reason: 'empty', message: 'Give the profile a name.' };
  if (name.length > BROWSER_PROFILE_NAME_MAX) {
    return { ok: false, reason: 'too-long', message: `A profile name is at most ${BROWSER_PROFILE_NAME_MAX} characters.` };
  }
  const key = name.toLowerCase();
  if (profiles.some((p) => p.id !== selfId && p.name.toLowerCase() === key)) {
    return { ok: false, reason: 'duplicate', message: `A profile named “${name}” already exists.` };
  }
  return { ok: true, name };
}

/** The session partition of navigation éphémère: in-memory, one per workspace, gone at quit (no `persist:`). */
export function ephemeralPartition(wsId: string): string {
  return `orchestra-browser-${wsId}`;
}

/** The session partition of a profil navigateur: `persist:` (on disk under userData), shared by every workspace
 *  that attaches it. Throws on an id that is not a minted one — never builds a partition from free text. */
export function profilePartition(profileId: BrowserProfileId): string {
  if (!isBrowserProfileId(profileId)) throw new Error(`not a browser profile id: ${String(profileId)}`);
  return `persist:orchestra-profile-${profileId}`;
}

/** Which partition ALL of a workspace's tabs use: its profile's, else the ephemeral one of its own. */
export function partitionFor(wsId: string, profileId: BrowserProfileId | undefined): string {
  return profileId === undefined ? ephemeralPartition(wsId) : profilePartition(profileId);
}

/** The profile a workspace really carries: its recorded id when that profile still exists, else none (a dangling id
 *  — profile deleted, store edited — means navigation éphémère, never a persistent partition nobody lists). */
export function effectiveProfileId(
  recorded: BrowserProfileId | undefined,
  profiles: readonly BrowserProfile[],
): BrowserProfileId | undefined {
  return recorded !== undefined && profiles.some((p) => p.id === recorded) ? recorded : undefined;
}

export type AttachDecision =
  | { ok: true; profileId: BrowserProfileId | undefined; changed: boolean }
  | { ok: false; reason: 'unknown-profile'; message: string };

/** Attach `target` to a workspace, or detach (`target === null` → navigation éphémère). Refuses a profile that does
 *  not exist; `changed` is false when the workspace already has that identity (nothing to rebuild). */
export function decideAttach(input: {
  profiles: readonly BrowserProfile[];
  current: BrowserProfileId | undefined;
  target: BrowserProfileId | null;
}): AttachDecision {
  const now = effectiveProfileId(input.current, input.profiles);
  if (input.target === null) return { ok: true, profileId: undefined, changed: now !== undefined };
  if (!input.profiles.some((p) => p.id === input.target)) {
    return { ok: false, reason: 'unknown-profile', message: 'That browser profile no longer exists.' };
  }
  return { ok: true, profileId: input.target, changed: now !== input.target };
}

export type DeleteDecision =
  | { ok: true; detach: string[] }
  | { ok: false; reason: 'unknown-profile'; message: string };

/** Deleting a profile: the workspaces that carry it (recorded id, whatever they are doing) go back to navigation
 *  éphémère first — the host rebuilds their tabs there and only then clears the partition's storage. */
export function decideDelete(input: {
  profiles: readonly BrowserProfile[];
  workspaces: ReadonlyArray<{ id: string; browserProfileId?: BrowserProfileId }>;
  profileId: BrowserProfileId;
}): DeleteDecision {
  if (!input.profiles.some((p) => p.id === input.profileId)) {
    return { ok: false, reason: 'unknown-profile', message: 'That browser profile no longer exists.' };
  }
  return { ok: true, detach: input.workspaces.filter((w) => w.browserProfileId === input.profileId).map((w) => w.id) };
}

/** Who may attach, switch, create, rename or delete a profile: ONLY the app's own main window (its top frame). An
 *  agent has no such path — no CLI verb, no socket route, no MCP tool — so this refuses anything else that reaches the
 *  IPC channel (a panel page, another window, a sub-frame), fail closed on unknown ids. */
export function isHumanProfileCaller(c: {
  senderId: number | null | undefined;
  mainId: number | null | undefined;
  senderIsMainFrame: boolean;
}): boolean {
  return typeof c.senderId === 'number' && typeof c.mainId === 'number' && c.senderId === c.mainId && c.senderIsMainFrame;
}

/** The warning shown WHILE creating a profile, ALWAYS (ADR 0010, review F1 of #400): Chromium encrypts cookies at rest only when Electron's
 *  `EnableCookieEncryption` fuse is on, and it is OFF in the shipped build (the repo flips no fuse; measured: the profile's Cookies DB holds `value` in
 *  clear and an empty `encrypted_value`, whatever the keyring says). So every profile's sign-ins sit readable on disk for anything running as the user,
 *  and the human must create one knowingly — independent of #389's keyring state, which governs `secrets.json`, not the cookie jar. */
export const PROFILE_AT_REST_WARNING =
  'Cookies and sign-ins of a profile are stored UNENCRYPTED on disk on this build (readable by anything running as you). Create profiles only for accounts you accept that for.';

/** CDP methods an AGENT may not call while its workspace holds a profil navigateur (OPS ruling 2026-10-26, #400; names from #395's seam review).
 *  The profile is SHARED — by other workspaces and across every site it holds a sign-in for — so these reach further than the agent's own page:
 *  - CLEARS of the partition or of a whole origin/storage key (`Network.clearBrowserCookies`, `Storage.clearCookies`, `Storage.clearDataForOrigin`,
 *    `Storage.clearDataForStorageKey` — whatever `storageTypes` says: "all" or "cookies" is a sign-out for every workspace on the profile);
 *  - partition-wide READS of cookie values (`Network.getAllCookies`, `Storage.getCookies`): every origin's session token, not just this page's.
 *  They name what they reach, so they are judged by name. */
export const PROFILE_REFUSED_CDP_METHODS: ReadonlyMap<string, 'clear' | 'read'> = new Map([
  ['Network.clearBrowserCookies', 'clear'],
  ['Storage.clearCookies', 'clear'],
  ['Storage.clearDataForOrigin', 'clear'],
  ['Storage.clearDataForStorageKey', 'clear'],
  ['Network.getAllCookies', 'read'],
  ['Storage.getCookies', 'read'],
]);

export type AgentCdpDecision = { ok: true } | { ok: false; message: string };

/** CDP methods that NAME a site (a url / a cookie domain): allowed for a profile workspace only on the PAGE's own HOST. The shared jar also holds the
 *  OTHER sites the profile is signed in to, and `Network.getCookies` returns their HttpOnly session tokens, which the page's own script never sees.
 *  What this does NOT stop (accepted): the agent can still navigate to another site of the profile and use that sign-in there (the point of a profile),
 *  and in-page script / `network requests|har` Cookie headers show what the page itself sends. It bounds what CDP can LIFT from the jar, not what a page can do. */
export const PROFILE_SITE_SCOPED_CDP_METHODS: ReadonlySet<string> = new Set([
  'Network.getCookies', 'Network.deleteCookies', 'Network.setCookie', 'Network.setCookies', 'Storage.setCookies',
]);

/** Every other cookie-carrying CDP method is refused by default for a profile workspace: an unknown one (a newer agent-browser routing `cookies set`
 *  through `Storage.setCookies`, `Network.setCookieControls`, …) must not silently bypass the site scope. */
const COOKIE_CDP_METHOD = /^(?:Network|Storage)\.\w*[Cc]ookie/;

const isHttp = (u: string): boolean => /^https?:\/\//i.test(u);

/** The urls / domains a site-scoped call names (`null` = malformed params, or a frame list that was needed and unknown: refuse).
 *  `Network.getCookies` WITHOUT `urls` (or with an empty list) returns the page URL's cookies AND every SUBFRAME's (CDP): its targets are then the
 *  http(s) frame urls (`frameUrls`, from the live frame tree) — a page embedding another site's iframe is judged on that site too. */
export function cdpSiteTargets(method: string, params: unknown, frameUrls?: readonly string[]): string[] | null {
  const p = (params && typeof params === 'object' ? params : {}) as Record<string, unknown>;
  const one = (v: unknown): string[] | null => (v === undefined ? [] : typeof v === 'string' ? [v] : null);
  const both = (o: Record<string, unknown>): string[] | null => {
    const u = one(o.url), d = one(o.domain);
    return u && d ? [...u, ...d] : null;
  };
  switch (method) {
    case 'Network.getCookies': {
      if (p.urls === undefined || (Array.isArray(p.urls) && p.urls.length === 0)) return frameUrls ? frameUrls.filter(isHttp) : null;
      return Array.isArray(p.urls) && p.urls.every((x) => typeof x === 'string') ? (p.urls as string[]) : null;
    }
    case 'Network.deleteCookies':
    case 'Network.setCookie':
      return both(p);
    case 'Network.setCookies':
    case 'Storage.setCookies': {
      if (!Array.isArray(p.cookies)) return null;
      const out: string[] = [];
      for (const c of p.cookies) {
        if (!c || typeof c !== 'object') return null;
        const t = both(c as Record<string, unknown>);
        if (!t) return null;
        out.push(...t);
      }
      return out;
    }
    default:
      return [];
  }
}

/** Is `target` (a url, or a cookie domain with an optional leading dot) the page's OWN host? EXACT host only — no parent domain, no sibling, no
 *  public suffix: a url on the parent host (`https://example.com/` from `app.example.com`) addresses that host's host-only HttpOnly cookies, which the
 *  page can never see, and a PSL-free parent rule cannot tell `example.com` from `co.uk`. A page with no host (blank tab) owns no site. */
export function isPageSite(pageUrl: string | undefined, target: string): boolean {
  let pageHost: string;
  try {
    pageHost = new URL(pageUrl ?? '').hostname.toLowerCase();
  } catch {
    return false;
  }
  if (!pageHost) return false;
  let h: string;
  try {
    h = (target.includes('://') ? new URL(target).hostname : target).replace(/^\./, '').toLowerCase();
  } catch {
    return false;
  }
  return h !== '' && h === pageHost;
}

const REFUSAL_CLEAR =
  'refused: this workspace\'s browser carries a profil navigateur shared with other workspaces and sites — clearing it would sign them all out. ' +
  'Delete the one cookie you mean (by name) or ask the human to delete or detach the profile.';
const REFUSAL_READ =
  'refused: this workspace\'s browser carries a profil navigateur — reading every site\'s cookies would expose sign-ins beyond this page. ' +
  'Read the cookies of the page you are on instead.';
const REFUSAL_SITE =
  'refused: this workspace\'s browser carries a profil navigateur — cookies of a site other than the page you are on (an embedded frame included) are not yours to read or change from here. ' +
  'Navigate to that site first, or ask the human.';
const REFUSAL_UNKNOWN =
  'refused: this workspace\'s browser carries a profil navigateur — this cookie command is not available here. Use `cookies get` / `cookies set` on the page you are on.';

/** The decision for one CDP call an agent sent for a workspace whose panel runs on `profileId` (`panelProfileId`):
 *  - refused: {@link PROFILE_REFUSED_CDP_METHODS}; the site-scoped methods that name a site other than the targeted tab's host (`pageUrl`) or cannot be judged
 *    (malformed params, an unknown frame tree); any other cookie-carrying Network/Storage method;
 *  - allowed otherwise. Ephemeral workspaces (profileId undefined) are never refused — their jar is their own.
 *  `frameUrls` = the urls of the target tab's frame tree (main frame + subframes), read live by the host. Every refusal is a NON-EMPTY string. */
export function decideAgentCdp(input: { method: string; params?: unknown; profileId: BrowserProfileId | undefined; pageUrl?: string; frameUrls?: readonly string[] }): AgentCdpDecision {
  if (input.profileId === undefined) return { ok: true };
  const kind = PROFILE_REFUSED_CDP_METHODS.get(input.method);
  if (kind !== undefined) return { ok: false, message: kind === 'clear' ? REFUSAL_CLEAR : REFUSAL_READ };
  if (PROFILE_SITE_SCOPED_CDP_METHODS.has(input.method)) {
    const targets = cdpSiteTargets(input.method, input.params, input.frameUrls);
    if (targets === null || targets.some((t) => !isPageSite(input.pageUrl, t))) return { ok: false, message: REFUSAL_SITE };
    return { ok: true };
  }
  if (COOKIE_CDP_METHOD.test(input.method)) return { ok: false, message: REFUSAL_UNKNOWN };
  return { ok: true };
}
