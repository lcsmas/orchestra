// Recency-aware fallback selection for the active workspace.
//
// When the workspace the user currently has open disappears — archived,
// deleted, or removed out from under us — the store must pick a different
// workspace to show. The naive choice (first non-archived row in sidebar
// order) is jarring: archiving the thing you're viewing snaps you to the top
// of the list. Instead we walk a most-recently-opened-first history and reopen
// the *previous* workspace you were on.
//
// Pure + dependency-free (only reads `id`/`archived`) so it's unit-testable
// without Electron or the Zustand store — same split as host-grouping.ts.

/** Minimal shape this module needs off a workspace. */
export interface Selectable {
  id: string;
  archived?: boolean;
}

/** Pick which workspace to open after `removedId` (the currently-active one)
 *  disappears. Prefers the most-recently-opened still-selectable workspace in
 *  `openHistory`; falls back to the first non-archived workspace when history
 *  has nothing usable left (fresh session, or every prior pick is now gone).
 *  Returns null when no non-archived workspace remains. */
export function pickFallbackActive<T extends Selectable>(
  workspaces: T[],
  openHistory: string[],
  removedId: string,
): string | null {
  const selectable = new Set(
    workspaces.filter((w) => !w.archived && w.id !== removedId).map((w) => w.id),
  );
  for (const id of openHistory) {
    if (selectable.has(id)) return id;
  }
  return workspaces.find((w) => !w.archived && w.id !== removedId)?.id ?? null;
}

/** Max ids retained in the recency stack; bounds growth over a long session. */
export const HISTORY_CAP = 50;

/** Push `id` to the front of the recency stack, de-duplicated so re-opening a
 *  workspace moves it to the front rather than adding a duplicate, and capped
 *  at {@link HISTORY_CAP}. Returns a new array (never mutates the input). */
export function pushHistory(history: string[], id: string): string[] {
  const next = [id, ...history.filter((h) => h !== id)];
  return next.length > HISTORY_CAP ? next.slice(0, HISTORY_CAP) : next;
}
