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
