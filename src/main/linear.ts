// Verifying a branch's candidate Linear key against Linear itself, so the
// sidebar only ever shows a Linear badge for an issue that actually exists.
//
// We call Linear's official GraphQL API directly (one fetch, no third-party
// dependency). Auth is a personal API key, resolved from (in order) the key the
// user saved in Orchestra's settings, then the LINEAR_API_KEY env var. With no
// key from either source, verification fails closed and no badge is shown.

import { parseLinearIssueCandidate } from '../shared/linear';
import type { LinearIssue, LinearKeyCheck, LinearKeySource } from '../shared/types';
import { getLinearApiKey } from './secrets';
import { log } from './logger';

const LINEAR_GRAPHQL_ENDPOINT = 'https://api.linear.app/graphql';

/** GraphQL document fetching just the fields the badge needs. `issue(id:)`
 *  accepts the shorthand human identifier (e.g. `NMC-261`) as well as a UUID,
 *  so we can pass the key straight through. */
const ISSUE_QUERY =
  'query Issue($id:String!){issue(id:$id){identifier url title state{name type} assignee{name}}}';

/** Batched lookup for the pinned-ticket refresh: ONE request for every pinned
 *  key, rather than N single-issue queries. Linear's `issues` connection can't
 *  filter on the human identifier directly, so we filter on the parsed
 *  team-key + number pairs the caller supplies (see {@link fetchLinearIssues}). */
const ISSUES_QUERY =
  'query Issues($filter:IssueFilter!,$first:Int!){issues(filter:$filter,first:$first)' +
  '{nodes{identifier url title state{name type} assignee{name}}}}';

/** The viewer's own open issues — backs `orchestra linear list --mine`. */
const MY_ISSUES_QUERY =
  'query MyIssues($first:Int!){viewer{assignedIssues(first:$first,' +
  'filter:{state:{type:{nin:["completed","canceled"]}}})' +
  '{nodes{identifier url title state{name type} assignee{name}}}}}';

/** Resolved Linear lookups, keyed by canonical issue key. Whether an issue
 *  *exists* doesn't change over a session, so we cache both hits (the issue)
 *  and misses (null) and never re-query the same key. Keeps the poll from
 *  hitting the API for every workspace on every tick. */
const cache = new Map<string, LinearIssue | null>();

/** Latches true once we've seen there's no usable API key (absent, or rejected
 *  with 401/403), so we stop attempting on every poll for every workspace.
 *  Cleared by `resetLinearAuthState()` when the user changes the key in-app, so
 *  a freshly-saved key takes effect without an app restart. */
let noApiKey = false;

/** Resolve the active API key and its source. Stored (in-app) key wins over the
 *  env var, so the settings UI is authoritative once used; env stays as a
 *  zero-config / CI fallback. */
async function resolveApiKey(): Promise<{ key: string | null; source: LinearKeySource }> {
  const stored = (await getLinearApiKey())?.trim();
  if (stored) return { key: stored, source: 'stored' };
  const env = process.env.LINEAR_API_KEY?.trim();
  if (env) return { key: env, source: 'env' };
  return { key: null, source: 'none' };
}

/** Source of the configured Linear key (or 'none'). Drives the setup notice. */
export async function getLinearKeySource(): Promise<LinearKeySource> {
  return (await resolveApiKey()).source;
}

/** Forget cached lookups and the no-key latch. Call after the user saves or
 *  clears the key so the next poll re-resolves auth and re-verifies branches. */
export function resetLinearAuthState(): void {
  cache.clear();
  noApiKey = false;
}

interface GraphQlIssue {
  identifier?: unknown;
  url?: unknown;
  title?: unknown;
  state?: unknown;
  assignee?: unknown;
}
interface GraphQlResponse {
  data?: { issue?: GraphQlIssue | null } | null;
  errors?: unknown;
}

function coerceIssue(raw: GraphQlIssue | null | undefined): LinearIssue | null {
  if (!raw || typeof raw !== 'object') return null;
  if (typeof raw.identifier !== 'string' || typeof raw.url !== 'string') return null;
  const issue: LinearIssue = {
    identifier: raw.identifier,
    url: raw.url,
    title: typeof raw.title === 'string' ? raw.title : raw.identifier,
  };
  // State/assignee are only present when the query asked for them, and Linear
  // may legitimately return null for either — so each is attached only when it
  // actually carries data. Never fabricate a state: a ticket chip showing a
  // made-up state is worse than a ticket chip showing none.
  const state = raw.state as { name?: unknown; type?: unknown } | null | undefined;
  if (state && typeof state.name === 'string' && typeof state.type === 'string') {
    issue.state = { name: state.name, type: state.type };
  }
  const assignee = raw.assignee as { name?: unknown } | null | undefined;
  if (assignee === null) issue.assignee = null;
  else if (assignee && typeof assignee.name === 'string') issue.assignee = { name: assignee.name };
  return issue;
}

/** POST a GraphQL query to Linear with the given key. Returns the parsed JSON,
 *  or throws on transport/timeout/non-OK. Shared by issue verification and the
 *  settings "test this key" check. */
async function linearGraphql(
  apiKey: string,
  query: string,
  variables: Record<string, unknown>,
): Promise<{ status: number; ok: boolean; json: unknown }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    // Linear wants the raw key in Authorization with NO "Bearer " prefix.
    const res = await fetch(LINEAR_GRAPHQL_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: apiKey },
      body: JSON.stringify({ query, variables }),
      signal: controller.signal,
    });
    const json = res.ok ? await res.json() : undefined;
    return { status: res.status, ok: res.ok, json };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Resolve the Linear issue a branch refers to, or null if it refers to none.
 *
 * Pulls a candidate key from the branch name, then asks Linear's GraphQL API
 * for that issue. The issue is "real" only if the API returns an object whose
 * `identifier` matches the key we asked for. Every other outcome — no candidate,
 * no API key, network error, `issue: null`, a GraphQL `errors` payload, garbage
 * — resolves to null, so a bogus key (e.g. `POLL-429` from `usage-poll-429-…`)
 * never produces a badge.
 */
export async function verifyLinearIssue(branch: string): Promise<LinearIssue | null> {
  const key = parseLinearIssueCandidate(branch);
  if (!key) return null;
  if (cache.has(key)) return cache.get(key)!;
  if (noApiKey) return null;

  const { key: apiKey } = await resolveApiKey();
  if (!apiKey) {
    noApiKey = true;
    log.info('No Linear API key configured — Linear badges disabled', {
      hint: 'set one in Orchestra (Linear settings) or via the LINEAR_API_KEY env var',
    });
    return null;
  }

  let result: LinearIssue | null = null;
  try {
    const { ok, status, json } = await linearGraphql(apiKey, ISSUE_QUERY, { id: key });
    if (ok) {
      // A non-existent key comes back as `data.issue === null` (sometimes via an
      // `errors` array). Both fall through coerceIssue → null. Guard that the
      // returned identifier matches what we asked for before trusting it.
      const issue = coerceIssue((json as GraphQlResponse)?.data?.issue);
      if (issue && issue.identifier.toUpperCase() === key) result = issue;
    } else if (status === 401 || status === 403) {
      // Bad/expired key — no point retrying every poll this session.
      noApiKey = true;
      log.warn('Linear API rejected the API key — Linear badges disabled', { status });
    }
    // Other non-OK statuses (429/5xx) → fail closed for this key but don't
    // latch: a later poll can retry.
  } catch {
    // Network error / abort / malformed JSON → fail closed, retry later.
    result = null;
  }

  cache.set(key, result);
  return result;
}

// ---------------------------------------------------------------------------
// Explicit (ticket) lookups — deliberately NOT the badge path
//
// The badge path above is a background poll over every workspace: it caches by
// key FOR THE WHOLE SESSION and latches `noApiKey` after one failure, both of
// which are right for a 60s poll answering "does this issue exist?" (an answer
// that never changes) and WRONG for pinned tickets, where the mutable workflow
// STATE is the entire point — a cached hit would freeze a ticket at "Todo"
// forever. These functions therefore share only the transport.
//
// They also fail LOUD: an explicit `orchestra linear add` must say "no API key"
// rather than silently resolving to nothing the way a background badge does.
// ---------------------------------------------------------------------------

/** Thrown by the explicit ticket lookups so callers can surface a real reason
 *  to the user instead of an indistinguishable `null`. */
export class LinearRequestError extends Error {}

/** Resolve the API key for an explicit, user-initiated request. Ignores the
 *  `noApiKey` latch (a latch set by a background poll must not permanently
 *  disable a command the user just typed) and throws with an actionable
 *  message when there is no key at all. */
async function requireApiKey(): Promise<string> {
  const { key } = await resolveApiKey();
  if (!key) {
    throw new LinearRequestError(
      'No Linear API key configured. Set one in Orchestra (Linear settings), or export LINEAR_API_KEY.',
    );
  }
  return key;
}

/** Map a non-OK GraphQL HTTP status onto an actionable error. */
function statusError(status: number): LinearRequestError {
  if (status === 401 || status === 403) {
    return new LinearRequestError('Linear rejected the API key (check Linear settings).');
  }
  if (status === 429) return new LinearRequestError('Linear rate-limited the request; try again.');
  return new LinearRequestError(`Linear returned HTTP ${status}.`);
}

/** Fetch ONE issue by its canonical key, uncached. Returns null only when
 *  Linear says the issue does not exist; every other failure throws, so the CLI
 *  can tell "no such ticket" from "your key is invalid". */
export async function fetchLinearIssue(identifier: string): Promise<LinearIssue | null> {
  const key = identifier.trim().toUpperCase();
  if (!key) return null;
  const apiKey = await requireApiKey();
  let res: { status: number; ok: boolean; json: unknown };
  try {
    res = await linearGraphql(apiKey, ISSUE_QUERY, { id: key });
  } catch {
    throw new LinearRequestError('Could not reach Linear (network error).');
  }
  if (!res.ok) throw statusError(res.status);
  const issue = coerceIssue((res.json as GraphQlResponse)?.data?.issue);
  // Same identity guard as the badge path: only trust a reply that is actually
  // about the issue we asked for.
  if (!issue || issue.identifier.toUpperCase() !== key) return null;
  return issue;
}

/**
 * Fetch MANY issues in ONE request — the pinned-ticket refresh.
 *
 * Linear's `issues` connection cannot filter on the human identifier, so the
 * keys are decomposed into (team key, number) pairs and OR-ed. Keys that don't
 * split are skipped rather than silently widening the filter.
 *
 * Returns a map keyed by canonical identifier. A pinned key absent from the map
 * means Linear did not return it (deleted, moved, or out of scope for this API
 * key) — the caller keeps the stale copy rather than dropping the row, since a
 * ticket vanishing from the sidebar on a transient blip is worse than one
 * showing a slightly old state.
 */
export async function fetchLinearIssues(
  identifiers: string[],
): Promise<Map<string, LinearIssue>> {
  const out = new Map<string, LinearIssue>();
  const pairs = identifiers
    .map((id) => id.trim().toUpperCase())
    .filter(Boolean)
    .map((id) => {
      const m = id.match(/^([A-Z][A-Z0-9]*)-(\d+)$/);
      return m ? { team: m[1], number: Number(m[2]) } : null;
    })
    .filter((p): p is { team: string; number: number } => p !== null);
  if (pairs.length === 0) return out;

  const apiKey = await requireApiKey();
  const filter = {
    or: pairs.map((p) => ({
      team: { key: { eq: p.team } },
      number: { eq: p.number },
    })),
  };
  let res: { status: number; ok: boolean; json: unknown };
  try {
    // `first` is bounded by the request size; pinned-ticket counts are small.
    res = await linearGraphql(apiKey, ISSUES_QUERY, { filter, first: Math.min(pairs.length, 100) });
  } catch {
    throw new LinearRequestError('Could not reach Linear (network error).');
  }
  if (!res.ok) throw statusError(res.status);
  const nodes = (res.json as { data?: { issues?: { nodes?: unknown } } })?.data?.issues?.nodes;
  if (!Array.isArray(nodes)) return out;
  for (const node of nodes) {
    const issue = coerceIssue(node as GraphQlIssue);
    if (issue) out.set(issue.identifier.toUpperCase(), issue);
  }
  return out;
}

/** The viewer's own open (not completed/canceled) issues — `linear list --mine`. */
export async function fetchMyLinearIssues(limit = 50): Promise<LinearIssue[]> {
  const apiKey = await requireApiKey();
  let res: { status: number; ok: boolean; json: unknown };
  try {
    res = await linearGraphql(apiKey, MY_ISSUES_QUERY, { first: Math.min(Math.max(limit, 1), 100) });
  } catch {
    throw new LinearRequestError('Could not reach Linear (network error).');
  }
  if (!res.ok) throw statusError(res.status);
  const nodes = (res.json as { data?: { viewer?: { assignedIssues?: { nodes?: unknown } } } })?.data
    ?.viewer?.assignedIssues?.nodes;
  if (!Array.isArray(nodes)) return [];
  return nodes
    .map((n) => coerceIssue(n as GraphQlIssue))
    .filter((i): i is LinearIssue => i !== null);
}

interface ViewerResponse {
  data?: { viewer?: { name?: unknown } | null } | null;
}

/** Validate an API key by querying the current viewer. Used by the settings
 *  modal to give immediate "✓ connected as <name>" / "✗ invalid key" feedback.
 *  Does NOT touch stored state — purely a probe of the passed-in key. */
export async function verifyLinearApiKey(key: string): Promise<LinearKeyCheck> {
  const trimmed = key.trim();
  if (!trimmed) return { ok: false, error: 'Enter an API key.' };
  try {
    const { ok, status, json } = await linearGraphql(trimmed, '{ viewer { name } }', {});
    if (ok) {
      const name = (json as ViewerResponse)?.data?.viewer?.name;
      if (typeof name === 'string') return { ok: true, name };
      return { ok: false, error: 'Unexpected response from Linear.' };
    }
    if (status === 401 || status === 403) return { ok: false, error: 'Invalid API key.' };
    return { ok: false, error: `Linear returned HTTP ${status}.` };
  } catch {
    return { ok: false, error: 'Could not reach Linear (network error).' };
  }
}
