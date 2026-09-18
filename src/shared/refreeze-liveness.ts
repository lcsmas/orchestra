// #156 — the LIVE-CHILD predicate for `orchestra run refreeze`, extracted here as
// a platform-free pure function so a test can drive the REAL disjunction.
//
// WHY THIS IS A SEPARATE MODULE, not an inline `.some()` in workspaces.ts: the
// live-child gate refuses a refreeze while a mission's child is mid-turn, and a
// child is live on EITHER of two launch surfaces — a PTY session (`isRunning`,
// pty.ts) OR a structured/SDK session (`sdkSessionLive`, sdk-delivery.ts). The
// DEFAULT spawn is a STRUCTURED session with no PTY, so `isRunning` alone is the
// #111 PTY-only blind spot: a live structured child reads NOT running and the
// refreeze wrongly proceeds (REVIEW-156 HIGH finding). The disjunction is the
// load-bearing logic, and `workspaces.ts` is un-importable under the strip-types
// test runner (its `./platform` dir-import). So the disjunction lives HERE, both
// prod and the test call it, and a test drives it with a PTY-dead / SDK-live child
// — the arm reddens the moment the `isSdkLive` disjunct is dropped (the mutation
// the wiring gate proves). Injecting the two probes keeps this Electron-free.

/**
 * True iff ANY of `childIds` is live on EITHER surface — a PTY session
 * (`isPtyRunning`) or a structured/SDK session (`isSdkLive`). Both probes are
 * injected so this is pure and unit-drivable; production wires them to the real
 * `isRunning` / `sdkSessionLive`.
 *
 * The freeze invariant refuses a refreeze while this is true, so a MISS here
 * (dropping the SDK disjunct) is the exact defect that lets a mid-turn structured
 * child's wave be re-frozen out from under it.
 */
export function anyChildLive(
  childIds: readonly string[],
  isPtyRunning: (id: string) => boolean,
  isSdkLive: (id: string) => boolean,
): boolean {
  return childIds.some((id) => isPtyRunning(id) || isSdkLive(id));
}
