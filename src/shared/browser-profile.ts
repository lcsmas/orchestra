// Profils navigateur (#400, ADR 0010): the PURE rules — id/name validity, which partition a panel uses, what attach /
// detach / delete mean, who may ask. No Electron, no store: `node --test` covers every branch
// (browser-profile.test.ts). The host wiring is main/browser-profiles.ts (service) + browser-profiles-host.ts (IPC).
import type { BrowserProfile, BrowserProfileId } from './types.ts';
import { secretsNotice, type SecretsState } from './secrets-state.ts';

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

/** The warning shown WHILE creating a profile when the machine's secret storage is not encrypted (ADR 0010): the
 *  profile's cookies are protected by the same OS keyring, so "no keyring" means they sit under a fixed key. null =
 *  nothing to say (encryption works, or the state is unknown). Reuses #389's rule, so the two can never disagree. */
export function profileCreateWarning(state: SecretsState | null): string | null {
  return secretsNotice(state)
    ? 'Storage is not encrypted on this machine: this profile’s cookies and sign-ins will sit on disk readable by anything running as you.'
    : null;
}

/** CDP methods an AGENT may not call while its workspace holds a profil navigateur (OPS ruling 2026-10-26, #400; names from #395's seam review).
 *  The profile is SHARED — by other workspaces and across every site it holds a sign-in for — so these reach further than the agent's own page:
 *  - CLEARS of the partition or of a whole origin/storage key (`Network.clearBrowserCookies`, `Storage.clearCookies`, `Storage.clearDataForOrigin`,
 *    `Storage.clearDataForStorageKey` — whatever `storageTypes` says: "all" or "cookies" is a sign-out for every workspace on the profile);
 *  - partition-wide READS of cookie values (`Network.getAllCookies`, `Storage.getCookies`): every origin's session token, not just this page's.
 *  They name what they reach, so they are judged by name. `Network.deleteCookies` / `setCookie(s)` (a named cookie), `Network.getCookies` (the page's own urls) stay allowed.
 *  The proxy ALSO denies `Target.sendMessageToTarget` and raw `get cdp-url` (#395), or none of this could be bypassed by name. */
export const PROFILE_REFUSED_CDP_METHODS: ReadonlyMap<string, 'clear' | 'read'> = new Map([
  ['Network.clearBrowserCookies', 'clear'],
  ['Storage.clearCookies', 'clear'],
  ['Storage.clearDataForOrigin', 'clear'],
  ['Storage.clearDataForStorageKey', 'clear'],
  ['Network.getAllCookies', 'read'],
  ['Storage.getCookies', 'read'],
]);

export type AgentCdpDecision = { ok: true } | { ok: false; message: string };

/** The decision for one CDP method an agent sent for `profileId`'s workspace (`panelProfileId`): refused for a profile workspace when the method is in
 *  {@link PROFILE_REFUSED_CDP_METHODS}; ephemeral workspaces (undefined) are never refused — their jar is their own. */
export function decideAgentCdp(input: { method: string; profileId: BrowserProfileId | undefined }): AgentCdpDecision {
  const kind = input.profileId === undefined ? undefined : PROFILE_REFUSED_CDP_METHODS.get(input.method);
  if (kind === undefined) return { ok: true };
  return {
    ok: false,
    message:
      kind === 'clear'
        ? 'refused: this workspace\'s browser carries a profil navigateur shared with other workspaces and sites — clearing it would sign them all out. ' +
          'Delete the one cookie you mean (by name) or ask the human to delete or detach the profile.'
        : 'refused: this workspace\'s browser carries a profil navigateur — reading every site\'s cookies would expose sign-ins beyond this page. ' +
          'Read the cookies of the page you are on (get cookies for its url) instead.',
  };
}

/** @deprecated name from the first #400 interface note — same function (reads are refused too since the #395 seam review). */
export const decideAgentClear = decideAgentCdp;
