// #156 — the LIVE-CHILD predicate for `orchestra run refreeze`, extracted as a platform-free pure
// function so a test can drive it (`workspaces.ts` is un-importable under the strip-types test runner).
// Since #233 a child is live only as an SDK session (`sdkSessionLive`, sdk-delivery.ts): no agent PTY exists.

/**
 * True iff ANY of `childIds` has a live SDK session. The probe is injected so this is pure and
 * unit-drivable; production wires it to the real `sdkSessionLive`. The freeze invariant refuses a
 * refreeze while this is true, so a MISS here lets a mid-turn child's wave be re-frozen under it.
 */
export function anyChildLive(childIds: readonly string[], isSdkLive: (id: string) => boolean): boolean {
  return childIds.some((id) => isSdkLive(id));
}
