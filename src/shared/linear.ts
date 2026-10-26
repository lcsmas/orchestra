// Linear ticket references and ticket branch names (pinned tickets).

/**
 * Parse a user-supplied reference to a Linear issue into its canonical key.
 *
 * Reads an argument the user typed at the CLI (`orchestra linear add …`).
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
 * Derive a git branch name for a ticket, e.g. `NMC-305` + "Grade sync misses
 * squash-merged branches" -> `nmc-305-grade-sync-misses-squash-merged`.
 *
 * The key leads so the branch names the ticket it implements.
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
