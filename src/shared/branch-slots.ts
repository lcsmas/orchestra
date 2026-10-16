// The first free branch name for a wanted one. Pure: no Electron, no node:*.
// Extracted from workspaces.ts `freeBranchName` (#382 follow-up) so the suffix rule, the in-flight reservations and the git folder conflict
// can be tested without Electron. With no options it is EXACTLY the previous algorithm (rename and human spawn paths are unchanged).

/** Highest suffix tried: `desired`, then `desired-2` … `desired-99`. */
export const MAX_BRANCH_SUFFIX = 99;

export interface BranchSlotOptions {
  /** Names picked by creations still running (their `git worktree add` has not finished): counted as taken, so parallel spawns of one
   *  name get distinct slots without holding any lock during the checkout. */
  reserved?: ReadonlySet<string>;
  /** Also treat `n` as taken when some branch is `n/<something>` (git cannot hold `impl-z` and `impl-z/sub`): the agent spawn route. */
  avoidFolders?: boolean;
}

/** `desired` when free, else the first free `desired-N` (N = 2 … 99); '' when `desired` is empty or every slot is taken. `current`
 *  (the workspace's own branch, for a rename) is exempt — a rename to the name it already has is a no-op, not a collision. */
export function freeBranchSlot(existing: Iterable<string>, desired: string, current: string, opts: BranchSlotOptions = {}): string {
  if (!desired) return '';
  const taken = new Set(existing);
  taken.delete(current);
  for (const r of opts.reserved ?? []) taken.add(r);
  const isTaken = (name: string): boolean => taken.has(name) || (opts.avoidFolders === true && [...taken].some((b) => b.startsWith(`${name}/`)));
  if (!isTaken(desired)) return desired;
  for (let n = 2; n <= MAX_BRANCH_SUFFIX; n++) {
    const candidate = `${desired}-${n}`;
    if (!isTaken(candidate)) return candidate;
  }
  return '';
}
