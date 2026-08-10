// Resolving the virtualized transcript's scroll anchor to a row index.
//
// StructuredView tracks, while follow-mode is released, WHICH item sits under
// the viewport top (`{id, delta}`) and restores it to the same offset after
// every commit — that is what stops row re-measures from making the content
// the user is reading jump around (see the anchoring effect in
// StructuredView.tsx).
//
// Resolving that anchor with a plain `ids.indexOf(id)` assumes ids are unique.
// When they were NOT — a hibernated session waking up restarted the event
// `seq` counter, so a transcript could hold `user:0` at the very top AND at the
// very bottom (fixed at the source in agent-sdk.ts / agent-transcript.ts) —
// `indexOf` resolved the bottom row to the TOP one and the anchoring effect
// dutifully scrolled there. Symptom: scrolling up a hair from the bottom
// teleported the view to the beginning of the transcript, every time.
//
// Uniqueness is now enforced upstream, but the anchoring effect is a bad place
// to be brittle: it writes scrollTop on every commit, so ANY future id
// collision costs the user their reading position instead of a cosmetic glitch.
// So resolve positionally: prefer the occurrence NEAREST the index the anchor
// was captured at. With unique ids this is exactly `indexOf` (and usually O(1),
// since a commit rarely moves a row far); with duplicates it picks the row the
// user is actually looking at rather than the first namesake in the list.

/**
 * Index of `id` in `ids`, preferring the occurrence closest to `hint`.
 * Returns -1 when the id is gone (the anchor row left the list — the caller
 * re-anchors on the next scroll).
 */
export function resolveAnchorIndex(ids: readonly string[], id: string, hint: number): number {
  // Clamp first: a hint can be out of range (rows were removed since it was
  // captured), and the search must still start from a real slot — an
  // unclamped start is skipped by the outward walk below and the row is
  // reported missing even though it is right there.
  const start = Math.max(0, Math.min(hint, ids.length - 1));
  // Fast path: nothing moved (the overwhelmingly common case — a re-measure
  // changes heights, not the item order).
  if (ids[start] === id) return start;
  // Walk outwards from the hint so the FIRST match found is the nearest one.
  for (let d = 1; d < ids.length; d++) {
    const lo = start - d;
    const hi = start + d;
    if (lo < 0 && hi >= ids.length) break;
    if (lo >= 0 && ids[lo] === id) return lo;
    if (hi < ids.length && ids[hi] === id) return hi;
  }
  return -1;
}
