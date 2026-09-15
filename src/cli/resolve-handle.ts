// Canonicalize a `send --to` handle to a FULL workspace id (#144).
//
// The canary (#143) sent member mail by the 8-char handle the fleet uses
// everywhere (`orchestra send --to 0a5c25bb …`). The bus stored `recipient =
// '0a5c25bb'`, and the wake predicate compares against the reader's FULL uuid,
// so the row never matched and the OPS was never woken. The fix: `send`
// canonicalizes the handle to the full id BEFORE the row is written. The bus
// NEVER stores a short handle.
//
// This file is the PURE half — the matching rules over a candidate list, with
// no socket, no filesystem, no Electron. `index.ts` fetches the candidates
// (socket when the app is up, else the offline store) and calls `resolveHandle`.
// Splitting it out is what makes the ambiguity/unknown branches unit-testable
// without a running app.

/** A resolvable workspace: its full id and its display name. */
export interface HandleCandidate {
  id: string;
  name: string;
}

export type ResolveHandleResult =
  | { ok: true; id: string }
  | { ok: false; error: string };

/** How many leading chars of an id count as a "short handle". The fleet uses
 *  the first 8 (`b3f55639`), and workspace worktree dirs are named with the same
 *  8. A prefix match is length-agnostic below this only in that a shorter unique
 *  prefix still resolves; 8 is the documented convention, not a hard floor. */
export const SHORT_HANDLE_LEN = 8;

/**
 * Resolve `raw` (a full id, an id prefix, or a workspace name) to the FULL id.
 *
 * Precedence, most specific first — a longer/exact match always wins over a
 * looser one, so an id that happens to be a prefix of another is never
 * ambiguous with itself:
 *   1. EXACT id  — `raw` equals a candidate id. One winner by construction (ids
 *      are unique), returned even if `raw` is also a prefix of a longer id.
 *   2. EXACT name — `raw` equals a candidate name. Refused as ambiguous if two
 *      candidates share the name (names are not unique).
 *   3. id PREFIX — a candidate id starts with `raw`. Exactly one → that id;
 *      more than one → ambiguous, refused with the candidates named.
 * Unknown (no match on any tier) → refused.
 *
 * REFUSALS carry the candidates so the human can retry with a disambiguating
 * value, per #144 ("refuse with a clear error when ambiguous or unknown").
 */
export function resolveHandle(
  raw: string,
  candidates: readonly HandleCandidate[],
): ResolveHandleResult {
  const to = raw.trim();
  if (!to) return { ok: false, error: 'orchestra send: --to is empty' };

  // Tier 1: exact id. Unique, so at most one — return immediately.
  const exactId = candidates.find((c) => c.id === to);
  if (exactId) return { ok: true, id: exactId.id };

  // Tier 2: exact name. Names are NOT unique (two worktrees can share a display
  // name), so collect all and refuse if more than one.
  const byName = candidates.filter((c) => c.name === to);
  if (byName.length === 1) return { ok: true, id: byName[0].id };
  if (byName.length > 1) {
    return {
      ok: false,
      error: ambiguous(to, byName, 'name'),
    };
  }

  // Tier 3: id prefix (the 8-char handle case). Exactly one → resolve; more →
  // ambiguous.
  const byPrefix = candidates.filter((c) => c.id.startsWith(to));
  if (byPrefix.length === 1) return { ok: true, id: byPrefix[0].id };
  if (byPrefix.length > 1) {
    return {
      ok: false,
      error: ambiguous(to, byPrefix, 'prefix'),
    };
  }

  return {
    ok: false,
    error:
      `orchestra send: --to ${JSON.stringify(to)} matches no workspace ` +
      `(tried exact id, exact name, then id prefix). ` +
      `Use 'orchestra peers' to list ids, or pass the full workspace id.`,
  };
}

function ambiguous(
  to: string,
  matches: readonly HandleCandidate[],
  kind: 'name' | 'prefix',
): string {
  const named = matches
    .map((c) => `${c.id}${c.name ? ` (${c.name})` : ''}`)
    .join(', ');
  const how = kind === 'name' ? 'workspace name' : 'id prefix';
  return (
    `orchestra send: --to ${JSON.stringify(to)} is ambiguous — it matches ${matches.length} ` +
    `workspaces by ${how}: ${named}. Pass the full id of the one you mean.`
  );
}
