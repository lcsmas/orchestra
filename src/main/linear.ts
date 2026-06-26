// Verifying a branch's candidate Linear key against Linear itself, so the
// sidebar only ever shows a Linear badge for an issue that actually exists.
//
// We call Linear's official GraphQL API directly (one fetch, no third-party
// dependency). Auth is a personal API key read from the LINEAR_API_KEY env var
// — mirroring how the rest of Orchestra leans on the environment (gh
// credentials, ORCHESTRA_* vars) rather than storing secrets of its own. With
// no key set, verification fails closed and no badge is shown.

import { parseLinearIssueCandidate } from '../shared/linear';
import type { LinearIssue } from '../shared/types';
import { log } from './logger';

const LINEAR_GRAPHQL_ENDPOINT = 'https://api.linear.app/graphql';

/** GraphQL document fetching just the fields the badge needs. `issue(id:)`
 *  accepts the shorthand human identifier (e.g. `NMC-261`) as well as a UUID,
 *  so we can pass the key straight through. */
const ISSUE_QUERY =
  'query Issue($id:String!){issue(id:$id){identifier url title}}';

/** Resolved Linear lookups, keyed by canonical issue key. Whether an issue
 *  *exists* doesn't change over a session, so we cache both hits (the issue)
 *  and misses (null) and never re-query the same key. Keeps the poll from
 *  hitting the API for every workspace on every tick. */
const cache = new Map<string, LinearIssue | null>();

/** Latches true once we've seen there's no API key, so we stop attempting (and
 *  stop logging) on every poll for every workspace. Reset only on app restart —
 *  setting the key then requires a relaunch, which is fine for a dev tool. */
let noApiKey = false;

/** Whether a Linear API key is configured in the environment. Drives the
 *  app's setup-status notice — separate from the internal `noApiKey` latch,
 *  which also flips on an auth rejection. */
export function linearApiKeyPresent(): boolean {
  return !!process.env.LINEAR_API_KEY?.trim();
}

interface GraphQlIssue {
  identifier?: unknown;
  url?: unknown;
  title?: unknown;
}
interface GraphQlResponse {
  data?: { issue?: GraphQlIssue | null } | null;
  errors?: unknown;
}

function coerceIssue(raw: GraphQlIssue | null | undefined): LinearIssue | null {
  if (!raw || typeof raw !== 'object') return null;
  if (typeof raw.identifier !== 'string' || typeof raw.url !== 'string') return null;
  return {
    identifier: raw.identifier,
    url: raw.url,
    title: typeof raw.title === 'string' ? raw.title : raw.identifier,
  };
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

  const apiKey = process.env.LINEAR_API_KEY?.trim();
  if (!apiKey) {
    noApiKey = true;
    log.info('LINEAR_API_KEY not set — Linear badges disabled', {
      hint: 'create a personal API key at linear.app → Settings → Security & access, then export LINEAR_API_KEY',
    });
    return null;
  }

  let result: LinearIssue | null = null;
  try {
    // 10s ceiling so a hung request can't wedge the poll. Linear wants the raw
    // key in Authorization with NO "Bearer " prefix — a prefix makes it 400.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    let res: Response;
    try {
      res = await fetch(LINEAR_GRAPHQL_ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: apiKey },
        body: JSON.stringify({ query: ISSUE_QUERY, variables: { id: key } }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    if (res.ok) {
      const json = (await res.json()) as GraphQlResponse;
      // A non-existent key comes back as `data.issue === null` (sometimes via an
      // `errors` array). Both fall through coerceIssue → null. Guard that the
      // returned identifier matches what we asked for before trusting it.
      const issue = coerceIssue(json.data?.issue);
      if (issue && issue.identifier.toUpperCase() === key) result = issue;
    } else if (res.status === 401 || res.status === 403) {
      // Bad/expired key — no point retrying every poll this session.
      noApiKey = true;
      log.warn('Linear API rejected LINEAR_API_KEY — Linear badges disabled', {
        status: res.status,
      });
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
