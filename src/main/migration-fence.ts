// Per-workspace account-migration fence (#240). Leaf module (no imports) so pty.ts, agent-sdk.ts and workspaces.ts can all
// read it without a cycle. Held from the start of `dispatchMigrateAccountRequest` until the workspace is RE-PINNED: a 2nd
// migration is refused, and no agent PTY / SDK session may START (it would run on the OLD account and write into the
// transcript dir that is being moved).
//
// The holder is identified by a per-call TOKEN: releasing with a stale token is a no-op, so a call's late `finally` can never
// drop the fence a LATER call took after this one's re-pin (review r3 F3).
const holders = new Map<string, string>();
let seq = 0;

/** Take the fence for `id`; returns the holder's token, or null = a migration of it is already in progress. */
export function beginMigration(id: string): string | null {
  if (holders.has(id)) return null;
  const token = `mig-${++seq}`;
  holders.set(id, token);
  return token;
}

/** Release the fence — only if `token` still holds it (omit the token to force-release, tests only). */
export function endMigration(id: string, token?: string): void {
  if (token === undefined || holders.get(id) === token) holders.delete(id);
}

export function isMigrating(id: string): boolean {
  return holders.has(id);
}

/** The message a refused start / second migration carries. */
export const migratingMessage = (id: string): string =>
  `workspace ${id} is being migrated to another account — try again in a moment`;
