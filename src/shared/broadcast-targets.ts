/** Target resolution for broadcast messaging (issue #86).
 *
 * Lives in `src/shared/` deliberately: `src/main/workspaces.ts` imports Electron
 * transitively (platform, pty), so anything defined there cannot be exercised by
 * the `node --test` runner at all. The rules below — which ids a broadcast
 * actually addresses — are exactly the part worth pinning, and they are pure, so
 * they belong on this side of the seam.
 */

/** The subset of a Workspace this module needs. Deliberately structural rather
 * than importing `Workspace`: it keeps the unit tests free of the full domain
 * type and makes the dependency (three fields) obvious. */
export interface BroadcastCandidate {
  id: string;
  parentId?: string | null;
  archived?: boolean;
}

/** DIRECT children of `parentId` — NOT the whole descendant subtree.
 *
 * Direct-only is a safety choice, not an implementation shortcut: mid-wave, a
 * coordinator's `--children` would otherwise also hit every reviewer and
 * verifier nested under its implementers, so the dangerous form must not be one
 * typo away from the safe one. A subtree broadcast, if ever wanted, gets its own
 * explicit flag.
 *
 * Archived workspaces are excluded — they have no agent to receive anything, so
 * including them would manufacture guaranteed per-target failures and turn every
 * broadcast from a parent with old children into a non-zero exit.
 */
export function resolveDirectChildTargets(
  workspaces: readonly BroadcastCandidate[],
  parentId: string,
): string[] {
  // GUARD THE UNDEFINED-EQUALS-UNDEFINED TRAP. A top-level workspace has no
  // `parentId`, so with a falsy `parentId` argument the comparison below is
  // `undefined === undefined` for EVERY top-level row — a `--children`
  // broadcast from an unidentified caller would silently address the entire
  // fleet instead of nobody. The dispatcher refuses a missing caller id before
  // reaching here, but a resolver that is only safe because of its caller is
  // one refactor away from being unsafe, so it refuses on its own terms.
  // (Caught by `broadcast-targets.test.ts`, not by review.)
  if (!parentId) return [];
  return workspaces.filter((w) => w.parentId === parentId && !w.archived).map((w) => w.id);
}

/** Normalize an explicit `--to` list: trim, drop blanks, collapse duplicates,
 * preserve first-seen order.
 *
 * Duplicates matter: delivering the same halt twice is NOT idempotent — each
 * delivery becomes a separate turn for the target agent. Blanks matter because
 * a trailing comma (`--to a,b,`) is a typo, and resolving it to an empty target
 * id would produce a confusing per-target failure instead of being ignored. */
export function normalizeExplicitTargets(ids: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of ids) {
    const id = raw.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}
