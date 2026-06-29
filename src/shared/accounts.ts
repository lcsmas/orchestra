// Pure, dependency-free logic for the per-account usage feature. Accounts are
// identified by a Claude Code CONFIG DIRECTORY (`CLAUDE_CONFIG_DIR`): each
// account is a separate config dir with its own `.credentials.json`, so Claude
// Code logs in as that account when spawned with `CLAUDE_CONFIG_DIR=<dir>`, and
// the OAuth token in that dir auto-refreshes (Claude Code manages it) — no
// long-lived token to inject or expire. Orchestra never reads or moves the
// token except transiently to query the usage endpoint.
//
// Kept free of electron and of any `store`/`fs` import so it can be unit-tested
// in isolation (see accounts.test.ts) and imported cheaply by both processes.

/** One configured Claude account: a label plus the Claude Code config
 *  directory it logs in through. `configDir` is a path template — it may
 *  contain a leading `~` (home) and/or `${VAR}` references, expanded against the
 *  home dir + environment at use time, so the stored value stays portable and
 *  holds no secret (the secret lives in `<configDir>/.credentials.json`, which
 *  Orchestra never copies into store.json). */
export interface Account {
  id: string;
  label: string;
  /** Path to this account's Claude config dir (the `CLAUDE_CONFIG_DIR` value).
   *  May use `~` and `${VAR}`. */
  configDir: string;
  /** Which pieces of the GLOBAL `~/.claude` config this account's dir inherits.
   *  A login dir holds only `.credentials.json` by default, so an agent running
   *  as this account would otherwise lose the user's settings/skills/MCP. The
   *  selected items are materialized into the login dir on agent spawn (symlinks
   *  for files/skills, a selective merge for MCP servers — see
   *  src/main/account-inherit.ts). Absent → nothing inherited. */
  inherit?: AccountInherit;
}

/** Per-account selection of what to inherit from the global `~/.claude`.
 *  All fields optional; an omitted/false field inherits nothing for that item.
 *  `skills` / `mcpServers` are names (skill dir names under `~/.claude/skills`,
 *  mcpServer keys in `~/.claude.json`). The list is intentionally narrow — add
 *  fields here as more of `~/.claude` becomes inheritable. */
export interface AccountInherit {
  /** Symlink `~/.claude/settings.json` (model, hooks, statusline, editor mode). */
  settings?: boolean;
  /** Symlink `~/.claude/statusline-command.sh`. */
  statusline?: boolean;
  /** Skill dir names to symlink from `~/.claude/skills/<name>`. */
  skills?: string[];
  /** mcpServer keys to merge from `~/.claude.json` into the login dir's. */
  mcpServers?: string[];
}

/** Normalize an untrusted `inherit` value (e.g. from store.json or IPC) into a
 *  clean {@link AccountInherit}, or `undefined` when nothing is selected. Drops
 *  non-string / empty / duplicate names and coerces the booleans. Pure — no fs,
 *  so both processes can call it. */
export function sanitizeAccountInherit(v: unknown): AccountInherit | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const src = v as Record<string, unknown>;
  const names = (x: unknown): string[] => {
    if (!Array.isArray(x)) return [];
    const out: string[] = [];
    for (const item of x) {
      if (typeof item !== 'string') continue;
      const name = item.trim();
      if (name && !out.includes(name)) out.push(name);
    }
    return out;
  };
  const out: AccountInherit = {};
  if (src.settings === true) out.settings = true;
  if (src.statusline === true) out.statusline = true;
  const skills = names(src.skills);
  if (skills.length) out.skills = skills;
  const mcpServers = names(src.mcpServers);
  if (mcpServers.length) out.mcpServers = mcpServers;
  return Object.keys(out).length ? out : undefined;
}

/** A rolling usage window (5-hour session or 7-day weekly). Mirrors the
 *  `five_hour` / `seven_day` objects from `/api/oauth/usage`. */
export interface UsageWindowDetail {
  /** Percent of the window's quota consumed, 0–100. */
  utilization: number;
  /** ISO-8601 timestamp at which this window resets, or '' if unknown/null. */
  resetsAt: string;
}

/** Parsed, renderer-safe usage for one account at one instant. */
export interface UsageData {
  fiveHour: UsageWindowDetail;
  sevenDay: UsageWindowDetail;
  /** Extra-usage (pay-as-you-go) utilization 0–100 if the account has it
   *  enabled and the endpoint reported a number; otherwise null. */
  extraUtilization: number | null;
}

/** Why an account has no usable usage right now — surfaced on the badge instead
 *  of crashing.
 *  `no-dir`        = the account's config dir doesn't exist / isn't readable;
 *  `not-logged-in` = the dir has no `.credentials.json` with an OAuth token
 *                    (run the account's Login flow);
 *  `no-scope`      = the token lacks the `user:profile` OAuth scope (HTTP 403);
 *  `rate-limited`  = HTTP 429;
 *  `error`         = network/other failure. */
export type UsageErrorKind = 'no-dir' | 'not-logged-in' | 'no-scope' | 'rate-limited' | 'error';

/** The IPC-facing status for one account. Carries `fetchedAt` (epoch ms) for
 *  staleness display. */
export interface AccountUsageStatus {
  accountId: string;
  ok: boolean;
  data: UsageData | null;
  errorKind: UsageErrorKind | null;
  /** Short human reason when `!ok` (never contains a token). */
  errorMessage: string | null;
  fetchedAt: number;
}

// ---- config-dir expansion ----------------------------------------------------

/** Expand a config-dir path template: a leading `~` (or `~/`) becomes `home`,
 *  and `${VAR}` / `$VAR` references resolve from `source`. Returns '' for an
 *  empty template or one whose references all resolve to nothing AND yields an
 *  empty string, so callers treat the account as having no usable dir rather
 *  than pointing Claude at the filesystem root. Trailing whitespace is trimmed.
 *  No secret is involved — this is just a path. */
export function expandConfigDir(
  template: string | undefined,
  home: string,
  source: Record<string, string | undefined>,
): string {
  if (!template) return '';
  let out = template.trim();
  if (!out) return '';
  // Leading ~ → home (only as a path segment: `~` or `~/...`, not `~foo`).
  if (out === '~') out = home;
  else if (out.startsWith('~/')) out = home + out.slice(1);
  out = out.replace(
    /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g,
    (_m, braced, bare) => source[braced ?? bare] ?? '',
  );
  return out;
}

// ---- credentials parsing -----------------------------------------------------

/** The OAuth credentials we read out of an account's `.credentials.json`. */
export interface OAuthCreds {
  accessToken: string;
  expiresAt?: number;
}

/** Parse the JSON text of a Claude Code `.credentials.json` into the OAuth
 *  access token, or null when the file isn't OAuth-shaped (e.g. an API-key
 *  login, or a malformed/empty file). Mirrors what src/main/usage.ts reads. */
export function parseCredentials(raw: string | null | undefined): OAuthCreds | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as {
      claudeAiOauth?: { accessToken?: string; expiresAt?: number };
    };
    const oauth = parsed.claudeAiOauth;
    if (!oauth?.accessToken) return null;
    return { accessToken: oauth.accessToken, expiresAt: oauth.expiresAt };
  } catch {
    return null;
  }
}

/** True when a token with this `expiresAt` (epoch ms, optional) is clearly
 *  expired as of `now` — used to skip a guaranteed-401 round-trip. A 60s grace
 *  matches usage.ts: the server is the real authority, we only skip the
 *  obviously-dead. */
export function isExpired(expiresAt: number | undefined, now: number): boolean {
  return typeof expiresAt === 'number' && expiresAt < now - 60_000;
}

// ---- usage-response parsing --------------------------------------------------

interface RawWindow {
  utilization?: number | null;
  resets_at?: string | null;
}
interface RawExtra {
  is_enabled?: boolean | null;
  utilization?: number | null;
}
/** The subset of `/api/oauth/usage` we read. Unknown keys are tolerated. */
export interface RawUsageResponse {
  five_hour?: RawWindow | null;
  seven_day?: RawWindow | null;
  extra_usage?: RawExtra | null;
}

function num(v: number | null | undefined): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function parseWindow(w: RawWindow | null | undefined): UsageWindowDetail {
  return { utilization: num(w?.utilization), resetsAt: w?.resets_at ?? '' };
}

/** Parse a raw `/api/oauth/usage` body into renderer-safe {@link UsageData}.
 *  Tolerates null windows (a window simply reads 0% with no reset). Returns
 *  null only when the body has neither window at all — i.e. it isn't a usage
 *  payload (e.g. an error object slipped through). */
export function parseUsageResponse(raw: RawUsageResponse | null | undefined): UsageData | null {
  if (!raw || typeof raw !== 'object') return null;
  if (raw.five_hour == null && raw.seven_day == null) return null;
  const extra = raw.extra_usage;
  const extraUtilization =
    extra && extra.is_enabled && typeof extra.utilization === 'number' && Number.isFinite(extra.utilization)
      ? extra.utilization
      : null;
  return {
    fiveHour: parseWindow(raw.five_hour),
    sevenDay: parseWindow(raw.seven_day),
    extraUtilization,
  };
}

/** Classify a non-OK HTTP status from the usage endpoint into a typed error.
 *  403 → `no-scope` (the only 403 this endpoint returns is the scope error);
 *  429 → `rate-limited`; everything else → `error`. */
export function classifyHttpError(status: number, _body?: string): { kind: UsageErrorKind; message: string } {
  if (status === 403) return { kind: 'no-scope', message: 'token lacks user:profile scope' };
  if (status === 429) return { kind: 'rate-limited', message: 'rate limited' };
  // Don't echo arbitrary bodies (could be large/HTML); keep it to the status.
  return { kind: 'error', message: `HTTP ${status}` };
}

// ---- workspace → account matching --------------------------------------------

/** The account id a workspace logs in as: its PINNED `accountId` (snapshotted
 *  at creation) if that names a still-configured account, else null (→ default
 *  login). Driven solely by the pin, never the repo's current account — Claude
 *  Code keeps a workspace's conversation inside the account's config dir, so an
 *  existing workspace must keep using the account it started under (reassigning
 *  the repo's account only affects NEW workspaces). A null/empty pin, or a pin
 *  to a deleted account, both resolve to null. `knownAccountIds` guards the
 *  dangling case. */
export function resolveWorkspaceAccountId(
  pinnedAccountId: string | undefined,
  knownAccountIds: ReadonlySet<string>,
): string | null {
  if (!pinnedAccountId) return null;
  return knownAccountIds.has(pinnedAccountId) ? pinnedAccountId : null;
}
