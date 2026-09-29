// Ids main has told this renderer are removed (#205). A late stale `workspace:update` from a
// racing read-modify-write must not re-add the row — the update handler upserts unknown ids.
const removed = new Set<string>();

export function noteWorkspacesRemoved(ids: Iterable<string>): void {
  for (const id of ids) removed.add(id);
}

export function isWorkspaceRemoved(id: string): boolean {
  return removed.has(id);
}
