// #432 — the ONE module that decides which run an agent is in and who coordinates it (ADR 0012).
// Platform-free (no Electron, no store): main, the CLI and the renderer import it. Only this file may
// read `canOrchestrate` / `kind === 'orchestrator'` to decide run membership or coordination — the
// grep gate `scripts/check-run-position-single-reader.mjs` enforces it. #433/#434 change the BODIES
// below, never the four frozen signatures (ledger #443 §Frozen interface).
// OUT OF SCOPE here (behaviour-neutral, owned by #433/#434): sites that pick a coordinator from `parentId` alone —
// bus-liveness-roster.ts, session-watchdog.ts, vague-roster.ts, admission-wake.ts `fleetMember`, naming-migration.ts `!parentId`.

/** The minimal workspace shape the walks need: id, optional parent, and the two coordination fields. */
export interface RunNode {
  id: string;
  parentId?: string;
  kind?: string;
  canOrchestrate?: boolean;
}
export type RunLookup = (id: string) => RunNode | undefined;

/** Does `ws` coordinate a run? Today = the orchestrator capability: the KIND `'orchestrator'` OR the
 *  flag (a PROMOTED worktree) — never the kind alone. */
export function coordinates(ws: Pick<RunNode, 'kind' | 'canOrchestrate'>): boolean {
  return ws.kind === 'orchestrator' || ws.canOrchestrate === true;
}

/** The KIND route to coordination only (the repo-less orchestrator session kind) — NOT `coordinates`: a
 *  promoted worktree carries the flag, not the kind. Used where today's behaviour is kind-specific
 *  (the opening brief of a fresh coordinator session, the hook gate). */
export function isCoordinatorKind(ws: Pick<RunNode, 'kind'>): boolean {
  return ws.kind === 'orchestrator';
}

/** The run id `ws`'s bus address belongs to. Today = the nearest coordinator at or above `ws` (itself if
 *  it coordinates), else `ws.id` (a plain workspace with none above is its own run). A broken link or a
 *  cycle stops the walk; never throws. */
export function runIdOf(ws: RunNode, lookup: RunLookup): string {
  let cur: RunNode = ws;
  const seen = new Set<string>([cur.id]);
  for (;;) {
    if (coordinates(cur)) return cur.id;
    if (!cur.parentId) break;
    const parent = lookup(cur.parentId);
    if (!parent || seen.has(parent.id)) break;
    seen.add(parent.id);
    cur = parent;
  }
  return ws.id; // NOT the deepest ancestor: a chain of non-coordinators is a standalone run
}

/** First coordinating (or, with `anchorsRun`, run-anchoring) ancestor of `ws` — the walk starts at
 *  `ws.parentId`, never `ws`. */
function ancestorRunId(ws: RunNode, lookup: RunLookup, anchorsRun?: (id: string) => boolean): string | null {
  if (!ws.parentId) return null;
  const seen = new Set<string>([ws.id]);
  let cur = lookup(ws.parentId);
  while (cur && !seen.has(cur.id)) {
    if (coordinates(cur) || anchorsRun?.(cur.id)) return cur.id;
    seen.add(cur.id);
    if (!cur.parentId) break;
    cur = lookup(cur.parentId);
  }
  return null;
}

/** Parent-run pointer for a run anchored at `ws`. Today (#221) = the first coordinating / run-anchoring
 *  ancestor, else the DIRECT parent when it resolves but anchors no run (`implicit`: the caller gives it
 *  a mission row), else null. */
export function parentRunOf(
  ws: RunNode,
  lookup: RunLookup,
  anchorsRun?: (id: string) => boolean,
): { id: string | null; implicit: boolean } {
  const found = ancestorRunId(ws, lookup, anchorsRun);
  if (found) return { id: found, implicit: false };
  const parent = ws.parentId ? lookup(ws.parentId) : undefined;
  return parent ? { id: parent.id, implicit: true } : { id: null, implicit: false };
}

/** #433 — top-level = no resolvable parent (none set, or a dangling link after a delete): it owns a mission from birth. */
export function isTopLevel(ws: Pick<RunNode, 'parentId'>, lookup: RunLookup): boolean {
  return !ws.parentId || !lookup(ws.parentId);
}

/** #221 — `ws` is its OWN run anchor without coordinating (a run-less parent that gained a mission run). */
export function isPlainOwnAnchor(ws: RunNode, lookup: RunLookup): boolean {
  return !coordinates(ws) && runIdOf(ws, lookup) === ws.id;
}

/** The nearest coordinating (or run-anchoring) ancestor id strictly above `ws`, or null — the
 *  `parent_run_id` walk WITHOUT the implicit-direct-parent fallback. */
export function ancestorCoordinatorId(ws: RunNode, lookup: RunLookup, anchorsRun?: (id: string) => boolean): string | null {
  return ancestorRunId(ws, lookup, anchorsRun);
}

/** The standing-role hook gate (shell): SessionStart reminder + PreToolUse edit guard run only for a
 *  coordinator — the kind (env, set per session) or the sentinel file (a promote before a restart). */
export const COORDINATOR_SENTINEL_FILE = '.orchestrator';
export const COORDINATOR_HOOK_GATE =
  `sentinel="\${ORCHESTRA_WORKTREE:-.}/.orchestra/${COORDINATOR_SENTINEL_FILE}"\n` +
  `[ "\${ORCHESTRA_KIND:-}" = "orchestrator" ] || [ -f "\$sentinel" ] || exit 0`;
