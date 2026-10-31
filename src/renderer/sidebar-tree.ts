// Pure logic behind the sidebar's spawn trees (Orca-style layout, docs/research/orca-sidebar-ui.md):
// selection-driven folding, the coordinator rollup glyph, the hidden-children dots and the repo colour.
// Kept free of React/DOM so `node --test` covers it.
import type { Workspace, WorkspaceStatus } from '../shared/types.ts';

/** child id → parent id, ONLY for children whose parent is in the same live list (the spawn forest's rule). */
export type ParentOf = ReadonlyMap<string, string>;

export function buildParentOf(list: readonly Pick<Workspace, 'id' | 'parentId'>[]): Map<string, string> {
  const ids = new Set(list.map((w) => w.id));
  const out = new Map<string, string>();
  for (const w of list) if (w.parentId && ids.has(w.parentId) && w.parentId !== w.id) out.set(w.id, w.parentId);
  return out;
}

/** Walks id → parent → … (cycle-safe). Includes `id` itself first. */
function* ancestry(id: string, parentOf: ParentOf): Generator<string> {
  const seen = new Set<string>();
  for (let cur: string | undefined = id; cur && !seen.has(cur); cur = parentOf.get(cur)) {
    seen.add(cur);
    yield cur;
  }
}

/** A row is UNFOLDED when it is on the path root → selected row, or inside the selected row's subtree; every
 *  other subtree folds. A manual chevron click (`toggled`) flips one row until the selection changes. */
export function isFolded(id: string, activeId: string | null, parentOf: ParentOf, toggled: ReadonlySet<string>): boolean {
  let open = false;
  if (activeId) {
    for (const a of ancestry(id, parentOf)) if (a === activeId) open = true; // id is the selection or below it
    if (!open) for (const a of ancestry(activeId, parentOf)) if (a === id) open = true; // id is an ancestor of it
  }
  return toggled.has(id) ? open : !open;
}

/** Orca's card precedence: question > error > working. Anything else does not roll up. */
const ROLLUP_RANK: Partial<Record<WorkspaceStatus, number>> = { waiting: 3, error: 2, running: 1 };
export type RollupStatus = 'waiting' | 'error' | 'running';

/** What a row with descendants shows when its subtree is more urgent than itself: Orca gets this for free when
 *  workers share the coordinator's worktree; ours are separate workspaces, so it is explicit. The row's OWN
 *  unseen-done bell still wins (as in Orca). null = show the row's own status. */
export function rollupStatus(
  self: Pick<Workspace, 'status' | 'autoUnread'>,
  descendants: readonly Pick<Workspace, 'status'>[],
): { status: RollupStatus; count: number } | null {
  if (descendants.length === 0 || self.autoUnread) return null;
  const rank = (s: WorkspaceStatus) => ROLLUP_RANK[s] ?? 0;
  let top: WorkspaceStatus | null = null;
  for (const d of descendants) if (rank(d.status) > (top ? rank(top) : 0)) top = d.status;
  if (!top || rank(top) <= rank(self.status)) return null;
  return { status: top as RollupStatus, count: descendants.filter((d) => d.status === top).length };
}

const ROLLUP_WORDS: Record<RollupStatus, string> = { waiting: 'waiting for your answer', error: 'in error', running: 'running' };
export function rollupTitle(base: string, r: { status: RollupStatus; count: number }): string {
  return `${base} — ${r.count} spawned agent${r.count === 1 ? '' : 's'} ${ROLLUP_WORDS[r.status]}`;
}

/** One dot per hidden child in a folded group. A child's unseen-done bell is NOT a notification (root-only),
 *  so autoUnread does not colour it; the manual unread tag does. */
export function hiddenDotKind(w: Pick<Workspace, 'status' | 'markedUnread'>): 'waiting' | 'error' | 'running' | 'idle' | 'off' {
  if (w.status === 'waiting' || w.markedUnread) return 'waiting';
  if (w.status === 'error') return 'error';
  if (w.status === 'running') return 'running';
  if (w.status === 'idle') return 'idle';
  return 'off';
}

/** Orca's 8-colour repo palette (shared/repo-badge-color.ts), minus its neutral grey. Assigned by the repo's
 *  position in the registered list, so the first 7 repos are guaranteed distinct (a hash put 2 of 3 real repos
 *  on the same colour, measured); an unregistered path falls back to a stable hash. */
const REPO_COLORS = ['#22c55e', '#8b5cf6', '#f97316', '#14b8a6', '#ec4899', '#eab308', '#ef4444'];
export function repoColor(repoPath: string, registered: readonly string[]): string {
  const i = registered.indexOf(repoPath);
  if (i >= 0) return REPO_COLORS[i % REPO_COLORS.length];
  let h = 2166136261;
  for (let k = 0; k < repoPath.length; k++) h = Math.imul(h ^ repoPath.charCodeAt(k), 16777619);
  return REPO_COLORS[(h >>> 0) % REPO_COLORS.length];
}
