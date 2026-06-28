// Pure, dependency-free logic for the per-account usage feature: the account
// list shape, token expansion, parsing Anthropic's `/api/oauth/usage` response,
// and matching a workspace to the account it logs in as. Kept free of electron
// and of any `store`/`fs` import so it can be unit-tested in isolation (see
// accounts.test.ts) and imported cheaply by both processes.
//
// SECURITY: nothing here ever stores an expanded token. An `Account.token` is
// the *template* the user typed (a literal label or a `${VAR}` reference);
// expansion against a source env happens only transiently at use time, and the
// expanded value never leaves the main process — the renderer only ever sees an
// account's `id`/`label` and its usage numbers.

/** One configured Claude account. `token` is a template — either a literal
 *  token or, preferably, a `${VAR}` reference resolved from Orchestra's own
 *  environment at use time (so the secret stays out of store.json, exactly like
 *  a repo's `env`). `label` is the human name shown on the badge. */
export interface Account {
  id: string;
  label: string;
  /** Token template: a literal, or `${VAR}` / `$VAR` resolved from process.env
   *  at use time. NEVER persisted in expanded form. */
  token: string;
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
 *  of crashing. `no-scope` = the token lacks the `user:profile` OAuth scope
 *  (HTTP 403); `rate-limited` = HTTP 429; `no-token` = the account's `${VAR}`
 *  expanded to nothing; `error` = network/other failure. */
export type UsageErrorKind = 'no-token' | 'no-scope' | 'rate-limited' | 'error';

/** The IPC-facing status for one account. Exactly one of `data` / `error` is
 *  meaningful per `ok`. Carries `fetchedAt` (epoch ms) for staleness display. */
export interface AccountUsageStatus {
  accountId: string;
  ok: boolean;
  data: UsageData | null;
  errorKind: UsageErrorKind | null;
  /** Short human reason when `!ok` (never contains a token). */
  errorMessage: string | null;
  fetchedAt: number;
}

// ---- token expansion ---------------------------------------------------------

/** Expand a token template against a source environment, mirroring
 *  {@link import('../main/repo-env').expandRepoEnv} for a single value. A
 *  `${VAR}` / `$VAR` reference pulls from `source`; an unset/blank reference (or
 *  a template that expands to nothing) yields '' so the caller treats the
 *  account as having no usable token rather than sending an empty bearer. A
 *  literal (no reference) passes through unchanged. */
export function expandToken(template: string | undefined, source: Record<string, string | undefined>): string {
  if (!template) return '';
  return template.replace(
    /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g,
    (_m, braced, bare) => source[braced ?? bare] ?? '',
  );
}

// ---- usage-response parsing ---------------------------------------------------

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
 *  403 with the scope message → `no-scope`; any 403 → `no-scope` (the only 403
 *  this endpoint returns is the scope error); 429 → `rate-limited`; everything
 *  else → `error`. */
export function classifyHttpError(status: number, body?: string): { kind: UsageErrorKind; message: string } {
  if (status === 403) {
    return { kind: 'no-scope', message: 'token lacks user:profile scope' };
  }
  if (status === 429) {
    return { kind: 'rate-limited', message: 'rate limited' };
  }
  // Don't echo arbitrary bodies (could be large/HTML); keep it to the status.
  return { kind: 'error', message: `HTTP ${status}` };
}

// ---- workspace → account matching ---------------------------------------------

/** The OAuth-token env var Claude Code reads to pick which account to log in
 *  as. A workspace's resolved value of this var is what we match against the
 *  configured accounts' tokens. */
export const OAUTH_TOKEN_ENV = 'CLAUDE_CODE_OAUTH_TOKEN';

/** Match a workspace to the account it uses, by comparing the workspace's
 *  resolved `CLAUDE_CODE_OAUTH_TOKEN` (already expanded against process.env by
 *  the caller — never pass a raw `${VAR}` here) against each account's resolved
 *  token. Returns the matching account's id, or null when the workspace has no
 *  token override (it uses the default/stored login) or no account matches.
 *
 *  `resolvedAccountTokens` maps accountId → its expanded token; accounts whose
 *  token expanded to '' are simply absent / never match. Comparison is exact:
 *  these are opaque secrets, so any normalization would risk a false match. */
export function matchWorkspaceAccount(
  workspaceToken: string | undefined,
  resolvedAccountTokens: ReadonlyMap<string, string>,
): string | null {
  if (!workspaceToken) return null;
  for (const [accountId, token] of resolvedAccountTokens) {
    if (token && token === workspaceToken) return accountId;
  }
  return null;
}
