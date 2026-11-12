// #432 — the ONE module that decides which run an agent is in and who coordinates it (ADR 0012).
// Platform-free (no Electron, no store): main, the CLI and the renderer import it. Only this file may
// read `ownsRun` / `kind === 'orchestrator'` to decide run membership or coordination — the
// grep gate `scripts/check-run-position-single-reader.mjs` enforces it. #434 changed the BODIES (a plain parent owns a
// run; membership = the DIRECT parent), never the four frozen signatures (ledger #443 §Frozen interface).
// "Who coordinates ws" is `coordinatorOf` — the five parentId-only picks (liveness roster, watchdog, vague roster,
// admission-wake, naming-migration) read it; the gate pins their files to it.

/** The minimal workspace shape the walks need: id, optional parent, and the two ownership fields. */
export interface RunNode {
  id: string;
  parentId?: string;
  kind?: string;
  /** #434 — this workspace OWNS a run (persisted: set at its first spawn, at a promote, at the app-start migration). */
  ownsRun?: boolean;
}
export type RunLookup = (id: string) => RunNode | undefined;

/** The KIND route to coordination only (the repo-less orchestrator session kind) — it stays a kind (ADR 0012): a LEAD like
 *  any other. Used where today's behaviour is kind-specific (the opening brief of a fresh coordinator session, the hook gate). */
export function isCoordinatorKind(ws: Pick<RunNode, 'kind'>): boolean {
  return ws.kind === 'orchestrator';
}

/** #434 — does `ws` OWN a run, i.e. coordinate it? A top-level workspace owns its mission from birth (#433); a workspace
 *  with a parent owns a vague from its first spawn (`ownsRun`, persisted); the orchestrator KIND always. The capability flag
 *  (`canOrchestrate`) no longer decides: promote writes `ownsRun` beside it, and a pre-#434 store is migrated at app start. */
export function coordinates(ws: Pick<RunNode, 'kind' | 'parentId' | 'ownsRun'>): boolean {
  return isCoordinatorKind(ws) || ws.ownsRun === true || !ws.parentId;
}

/** The run id `ws`'s bus address belongs to: the run it OWNS (its own id), else its DIRECT parent's run (= the parent's id —
 *  a parent always owns the run its child is a member of). A workspace with no resolvable parent is its own run. Never throws. */
export function runIdOf(ws: RunNode, lookup: RunLookup): string {
  if (coordinates(ws)) return ws.id;
  const parent = ws.parentId ? lookup(ws.parentId) : undefined;
  return parent && parent.id !== ws.id ? parent.id : ws.id;
}

/** #434 — WHO coordinates `ws`: the owner of the run `ws` is a MEMBER of = its resolved direct parent; undefined for a
 *  top-level workspace (it answers to the human) or a dangling parent link. The ONE answer to "who do I escalate to /
 *  report to" — liveness, watchdog, vague roster, admission, naming hold all read it. */
export function coordinatorOf<T extends RunNode>(ws: RunNode, lookup: (id: string) => T | undefined): T | undefined {
  const parent = ws.parentId ? lookup(ws.parentId) : undefined;
  return parent && parent.id !== ws.id ? parent : undefined;
}

/** #434 — the run `ws` is a MEMBER of (the run it reports into), distinct from the one it owns: its direct parent's run. */
export function memberRunOf(ws: RunNode, lookup: RunLookup): string | null {
  return coordinatorOf(ws, lookup)?.id ?? null;
}

/** Parent-run pointer for a run owned by `ws` = the run `ws` is a member of (its direct parent's). `implicit` = that parent
 *  neither coordinates nor anchors a row yet (a pre-#434 plain parent): the caller gives it a mission row (#221). */
export function parentRunOf(
  ws: RunNode,
  lookup: RunLookup,
  anchorsRun?: (id: string) => boolean,
): { id: string | null; implicit: boolean } {
  const parent = coordinatorOf(ws, lookup);
  return parent ? { id: parent.id, implicit: !(coordinates(parent) || anchorsRun?.(parent.id)) } : { id: null, implicit: false };
}

/** #433 — top-level = no resolvable parent (none set, or a dangling link after a delete): it owns a mission from birth. */
export function isTopLevel(ws: Pick<RunNode, 'parentId'>, lookup: RunLookup): boolean {
  return !ws.parentId || !lookup(ws.parentId);
}

/** #221 — `ws` is a plain TOP-LEVEL workspace: no parent to coordinate it (none set, or a dangling link) and not the orchestrator KIND. It owns a
 *  mission (#433) but stays reachable by `orchestra message` for a sender with NO bus route until #441/#436 close the old channel; whether it
 *  has already spawned (`ownsRun`) does not matter — the same answer as before #434. */
export function isPlainOwnAnchor(ws: RunNode, lookup: RunLookup): boolean {
  return !isCoordinatorKind(ws) && isTopLevel(ws, lookup);
}

/** The nearest coordinating (or run-anchoring) ancestor id strictly above `ws`, or null — `parentRunOf` WITHOUT the implicit
 *  fallback: since #434 only the DIRECT parent counts. */
export function ancestorCoordinatorId(ws: RunNode, lookup: RunLookup, anchorsRun?: (id: string) => boolean): string | null {
  const p = parentRunOf(ws, lookup, anchorsRun);
  return p.implicit ? null : p.id;
}

/** #434 — which wording the standing-role reminder takes: a repo-less coordinator ('pure': never implements) or one that owns a
 *  repo checkout and so carries its own commits ('dual', the sentinel content). Every sentinel writer reads it here. */
export function coordinatorRoleOf(ws: { repoPath?: string }): 'pure' | 'dual' {
  return ws.repoPath ? 'dual' : 'pure';
}

/** The standing-role hook gate (shell): SessionStart reminder + PreToolUse edit guard run only for a
 *  coordinator — the kind (env, set per session) or the sentinel file (a promote before a restart). */
export const COORDINATOR_SENTINEL_FILE = '.orchestrator';
export const COORDINATOR_HOOK_GATE =
  `sentinel="\${ORCHESTRA_WORKTREE:-.}/.orchestra/${COORDINATOR_SENTINEL_FILE}"\n` +
  `[ "\${ORCHESTRA_KIND:-}" = "orchestrator" ] || [ -f "\$sentinel" ] || exit 0`;
