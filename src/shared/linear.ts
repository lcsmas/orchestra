// Deriving a Linear issue link from a git branch name. Branches here are often
// named after the Linear issue they implement, e.g. `nmc-261-diagnosis-pictures`
// or `NMC-8-foo`. We pull a *candidate* key out of the branch name syntactically
// here, but a candidate is never trusted on its own — the main process verifies
// it against Linear (see src/main/linear.ts) and only a confirmed issue is ever
// shown. That makes the link robust: `usage-poll-429-backoff` yields a candidate
// `POLL-429`, Linear reports no such issue, and no badge appears.

/**
 * Extract a *candidate* Linear issue key of the form `<TEAM>-<NUMBER>` from a
 * branch name. TEAM is an alphabetic run (≥2 letters), NUMBER a digit run; the
 * match is case-insensitive and normalized to Linear's upper-case key form.
 * The first candidate wins. The token must sit on segment boundaries (start/end
 * or one of `-_/.`) so a key is recognized as a standalone segment and not
 * spliced out of a longer word.
 *
 * This is intentionally permissive — it is NOT the source of truth for whether
 * an issue exists. It only narrows a branch name to at most one thing worth
 * asking Linear about. {@link import('../main/linear').verifyLinearIssue} does
 * the actual existence check.
 *
 *   parseLinearIssueCandidate('nmc-261-diagnosis-pictures') -> 'NMC-261'
 *   parseLinearIssueCandidate('feature/mc-12-x')            -> 'MC-12'
 *   parseLinearIssueCandidate('usage-poll-429-backoff')     -> 'POLL-429'  (candidate only)
 *   parseLinearIssueCandidate('v1-2-bump')                  -> null        (single-letter team)
 *   parseLinearIssueCandidate('feature/cleanup')            -> null        (no digit run)
 */
export function parseLinearIssueCandidate(branch: string): string | null {
  const m = branch.match(/(?:^|[-_/.])([a-z]{2,})-(\d+)(?=$|[-_/.])/i);
  if (!m) return null;
  return `${m[1].toUpperCase()}-${m[2]}`;
}

/**
 * Parse a user-supplied reference to a Linear issue into its canonical key.
 *
 * Unlike {@link parseLinearIssueCandidate} — which mines a *branch name* and is
 * deliberately permissive because a wrong guess merely costs one API lookup —
 * this reads an argument the user typed at the CLI (`orchestra linear add …`).
 * That argument is an assertion, not a guess, so this is strict: the whole
 * string must BE a reference, not merely contain something that looks like one.
 * A typo therefore fails loudly with a usage error instead of silently pinning
 * the wrong issue.
 *
 * Two accepted forms:
 *   - a bare identifier: `NMC-261`, `nmc-261` (case-insensitive)
 *   - a Linear issue URL: `https://linear.app/<org>/issue/NMC-261/<slug>`
 *     (the slug and query/fragment are ignored; `http`, a trailing slash, and
 *     an absent slug all work)
 *
 *   parseLinearTicketRef('NMC-261')                                  -> 'NMC-261'
 *   parseLinearTicketRef('  nmc-261 ')                               -> 'NMC-261'
 *   parseLinearTicketRef('https://linear.app/acme/issue/NMC-261/x')  -> 'NMC-261'
 *   parseLinearTicketRef('nmc-261-diagnosis-pictures')               -> null (branch, not a ref)
 *   parseLinearTicketRef('https://example.com/issue/NMC-261')        -> null (not Linear)
 */
export function parseLinearTicketRef(input: string): string | null {
  const raw = input.trim();
  if (!raw) return null;

  // URL form. Anchored to linear.app (optionally a subdomain) so a lookalike
  // host can't smuggle in a key, and to the `/issue/<KEY>` path segment Linear
  // actually uses.
  const url = raw.match(
    /^https?:\/\/(?:[a-z0-9-]+\.)*linear\.app\/[^/]+\/issue\/([a-z]{2,})-(\d+)(?:[/?#]|$)/i,
  );
  if (url) return `${url[1].toUpperCase()}-${url[2]}`;

  // Bare-identifier form — anchored at both ends, so `nmc-261-some-branch`
  // (a branch name) is correctly rejected rather than silently truncated.
  const bare = raw.match(/^([a-z]{2,})-(\d+)$/i);
  if (bare) return `${bare[1].toUpperCase()}-${bare[2]}`;

  return null;
}

/**
 * Normalize an agent-supplied GitHub pull-request URL, or null if it isn't one.
 *
 * Strict for the same reason {@link parseLinearTicketRef} is: this reads an
 * argument the agent typed at `orchestra link --pr`, which is an assertion
 * about its own work rather than a guess mined from a branch. A branch URL, a
 * `/compare/` URL, an `/issues/` URL or a bare repo URL are all things a
 * confused caller might paste, and each would store a badge that opens
 * somewhere unhelpful — so they are rejected loudly instead of normalized into
 * something plausible.
 *
 * Returns the canonical `https://github.com/<owner>/<repo>/pull/<n>` form with
 * any trailing slug, query or fragment stripped (`/files`, `?diff=split`,
 * `#discussion_r1`), so the stored value compares equal to the `html_url`
 * GitHub's API returns and the two can be matched directly.
 *
 *   normalizePrUrl('https://github.com/a/b/pull/12')        -> 'https://github.com/a/b/pull/12'
 *   normalizePrUrl('https://github.com/a/b/pull/12/files')  -> 'https://github.com/a/b/pull/12'
 *   normalizePrUrl('http://www.github.com/a/b/pull/12')     -> 'https://github.com/a/b/pull/12'
 *   normalizePrUrl('https://github.com/a/b/issues/12')      -> null
 *   normalizePrUrl('https://github.com/a/b/compare/x')      -> null
 *   normalizePrUrl('https://gitlab.com/a/b/pull/12')        -> null
 */
export function normalizePrUrl(input: string): string | null {
  return parsePrUrl(input)?.url ?? null;
}

/** A pull request an agent reported, resolved into everything needed to both
 * link to it and poll it.
 *
 * All four fields come from ONE parse of ONE URL, so they cannot disagree —
 * `owner`/`repo`/`number` are not independent inputs, they are the URL's own
 * components. They are stored rather than re-derived at poll time so a
 * malformed URL fails once, loudly, at `orchestra link` — where an agent is
 * present to see the error and retry — instead of silently yielding no badge on
 * every poll forever after. */
export interface PrLink {
  /** Canonical `https://github.com/<owner>/<repo>/pull/<n>` — the click target,
   * and equal to the `html_url` GitHub's API returns for the same PR. */
  url: string;
  owner: string;
  repo: string;
  number: number;
}

/**
 * Parse a GitHub pull-request URL into its canonical form plus its components,
 * or null if it isn't one.
 *
 * This is {@link normalizePrUrl} with the pieces kept rather than thrown away.
 * The regex always captured owner/repo/number — canonicalising the URL requires
 * them — so surfacing them costs nothing and removes the need for a second
 * parse at poll time.
 *
 * Why the components matter: polling a linked PR is a direct
 * `gh api repos/<owner>/<repo>/pulls/<number>` call, which needs no local
 * checkout and no `cwd`. That frees a workspace's PRs from its own `repoPath` —
 * a metarepo workspace can link PRs living in its submodules' separate GitHub
 * repos, which a repo-wide fetch rooted at one path structurally cannot see.
 *
 *   parsePrUrl('https://github.com/a/b/pull/12/files')
 *     -> { url: 'https://github.com/a/b/pull/12', owner: 'a', repo: 'b', number: 12 }
 *   parsePrUrl('https://github.com/a/b/issues/12') -> null
 */
export function parsePrUrl(input: string): PrLink | null {
  const raw = input.trim();
  if (!raw) return null;
  const m = raw.match(
    /^https?:\/\/(?:www\.)?github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)(?:[/?#]|$)/i,
  );
  if (!m) return null;
  // Canonical form: always https, never www, no trailing slug/query/fragment.
  return {
    url: `https://github.com/${m[1]}/${m[2]}/pull/${m[3]}`,
    owner: m[1],
    repo: m[2],
    number: Number(m[3]),
  };
}

/** Identity for a linked PR: two links naming the same pull request are the
 * same link regardless of how they were typed. Used to dedupe on append, since
 * the canonical `url` already collapses casing/slug/query variants. */
export function prLinkKey(pr: PrLink): string {
  return `${pr.owner.toLowerCase()}/${pr.repo.toLowerCase()}#${pr.number}`;
}

/**
 * Derive a git branch name for a ticket, e.g. `NMC-305` + "Grade sync misses
 * squash-merged branches" -> `nmc-305-grade-sync-misses-squash-merged`.
 *
 * The key leads so the existing branch-derived badge pipeline
 * ({@link parseLinearIssueCandidate} -> verifyLinearIssue) recognises the issue
 * with no extra bookkeeping — which is exactly what makes a spawned ticket
 * "graduate" into an ordinary workspace row whose badge just works.
 *
 * Kept pure and total: any title (empty, emoji-only, punctuation-only) yields a
 * usable branch, because the caller has no fallback if this returns nothing.
 */
export function ticketBranchName(identifier: string, title: string, maxWords = 6): string {
  const key = identifier.trim().toLowerCase();
  const words = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, maxWords);
  return words.length ? `${key}-${words.join('-')}` : key;
}
