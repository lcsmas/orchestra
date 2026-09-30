// Per-workspace account-migration fence (#240). Leaf module (no imports) so pty.ts, agent-sdk.ts and workspaces.ts can all
// read it without a cycle. Held from the start of `dispatchMigrateAccountRequest` until the workspace is RE-PINNED: a 2nd
// migration is refused, and no agent PTY / SDK session may START (it would run on the OLD account and write into the
// transcript dir that is being moved).
const migrating = new Set<string>();

/** Take the fence for `id`; false = a migration of it is already in progress. */
export function beginMigration(id: string): boolean {
  if (migrating.has(id)) return false;
  migrating.add(id);
  return true;
}

export function endMigration(id: string): void {
  migrating.delete(id);
}

export function isMigrating(id: string): boolean {
  return migrating.has(id);
}

/** The message a refused start / second migration carries. */
export const migratingMessage = (id: string): string =>
  `workspace ${id} is being migrated to another account — try again in a moment`;
