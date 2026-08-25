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

/** Which delivery shape a `/message` request body is asking for.
 *
 * Extracted here, away from the route, because the route lives in
 * `src/main/hooks-server.ts` — which imports Electron transitively and is
 * therefore unreachable by the test runner. The discrimination itself is pure,
 * and getting it wrong is the one change in issue #86 that could break EXISTING
 * callers: `/message` grew two new shapes on the SAME route, and a single-target
 * request must keep taking the original path and receiving the original
 * `{ok, delivery, branch}` response, or every already-installed CLI and hook
 * starts getting a reply shape it does not understand.
 */
export type MessageRouteShape =
  | { kind: 'single'; to: string }
  | { kind: 'broadcast'; to?: string[]; children: boolean }
  | { kind: 'invalid' };

/** Classify a raw `/message` body. `to: string` wins over everything: it is the
 * original contract and must never be re-routed. */
export function classifyMessageRoute(msg: {
  to?: unknown;
  children?: unknown;
  text?: unknown;
}): MessageRouteShape {
  if (typeof msg.text !== 'string') return { kind: 'invalid' };
  // Checked FIRST and deliberately: an older CLI sends a bare string and must
  // keep the legacy path and the legacy response shape.
  if (typeof msg.to === 'string') return { kind: 'single', to: msg.to };
  if (Array.isArray(msg.to)) {
    return {
      kind: 'broadcast',
      to: msg.to.filter((t): t is string => typeof t === 'string'),
      children: false,
    };
  }
  if (msg.children === true) return { kind: 'broadcast', children: true };
  return { kind: 'invalid' };
}
