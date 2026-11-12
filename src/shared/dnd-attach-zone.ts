// #439 — a sidebar row is a valid attach target whatever it is (ADR 0012), so a row that is ALSO a reorder target needs a rule for what
// a drop on it means: the MIDDLE of the row attaches, its top / bottom quarter reorders. A row that cannot be reordered onto (nested rows,
// another repo, the pinned spawn tree) attaches over its whole height; a row that cannot be attached to only reorders (halves).
// Pure — `Sidebar.tsx` feeds it the pointer's vertical fraction.

export type DropIntent = 'attach' | 'before' | 'after' | null;

/** Fraction of the row height, at each edge, that stays a reorder zone when both intents are possible. */
export const REORDER_EDGE = 0.25;

export function dropIntent(input: { canAttach: boolean; canReorder: boolean; yFraction: number }): DropIntent {
  const { canAttach, canReorder, yFraction } = input;
  if (canAttach && !canReorder) return 'attach';
  if (!canAttach && !canReorder) return null;
  if (canAttach && yFraction >= REORDER_EDGE && yFraction <= 1 - REORDER_EDGE) return 'attach';
  return yFraction < 0.5 ? 'before' : 'after';
}
