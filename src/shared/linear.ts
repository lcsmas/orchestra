// Deriving a Linear issue link from a git branch name. Branches here are often
// named after the Linear issue they implement, e.g. `nmc-261-diagnosis-pictures`
// or `NMC-8-foo`, so we surface a clickable Linear link alongside the GitHub PR.

/** Linear org/workspace slug. Linear redirects `linear.app/<slug>/issue/<KEY>`
 *  to the canonical URL, so the user's org short slug works. The app has no
 *  general settings store to hang this on, so it's a documented const — change
 *  it here if the Linear workspace ever changes. */
export const LINEAR_ORG_SLUG = 'mobile-club';

/**
 * Extract a Linear issue key of the form `<TEAM>-<NUMBER>` from a branch name.
 * TEAM is an alphabetic team prefix (case-insensitive, ≥2 letters — teams here
 * are like `NMC`, `MC`), NUMBER is a run of digits. The first match wins, and
 * the team is upper-cased to match Linear's canonical key form.
 *
 * The ≥2-letter guard avoids mis-matching version-y prefixes such as `v1-2`
 * (single-letter team) as issue keys.
 *
 *   parseLinearIssueKey('nmc-261-diagnosis-pictures') -> 'NMC-261'
 *   parseLinearIssueKey('mc-2227-foo')                -> 'MC-2227'
 *   parseLinearIssueKey('NMC-8-bar')                  -> 'NMC-8'
 *   parseLinearIssueKey('v1-2-bump')                  -> null
 *   parseLinearIssueKey('feature/cleanup')            -> null
 *
 * Returns null when no issue key is present.
 */
export function parseLinearIssueKey(branch: string): string | null {
  // `\b` anchors the team to a word boundary so we don't match the tail of a
  // longer token; `[a-z]{2,}` enforces the ≥2-letter team guard.
  const m = branch.match(/\b([a-z]{2,})-(\d+)\b/i);
  if (!m) return null;
  return `${m[1].toUpperCase()}-${m[2]}`;
}

/** Full Linear issue URL for a branch, or null if the branch encodes no key. */
export function linearIssueUrl(branch: string): string | null {
  const key = parseLinearIssueKey(branch);
  if (!key) return null;
  return `https://linear.app/${LINEAR_ORG_SLUG}/issue/${key}`;
}
