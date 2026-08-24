// Session discovery — choosing WHICH on-disk Claude Code session a workspace's
// structured view should resume/backfill from.
//
// The I/O (the SDK's `listSessions`, the `CLAUDE_CONFIG_DIR` pin, the existence
// checks) lives in `main/agent-sdk.ts`; the DECISIONS live here so they are
// testable without Electron. Each rule below is one that has previously been
// got wrong, or that the SDK's defaults get wrong for Orchestra's topology.

/** The subset of the SDK's `SDKSessionInfo` discovery depends on. Verified
 *  against the RUNTIME payload (SDK 0.3.241), whose measured key set is
 *  `{sessionId, summary, lastModified, fileSize, customTitle, firstPrompt,
 *    gitBranch, cwd, tag, createdAt}`.
 *
 *  Note there is **no `mtime`** — recency is `lastModified` (measured equal to
 *  the file's on-disk mtime to within a millisecond). Sorting on a `mtime` that
 *  is `undefined` on every row is a no-op that still "passes" whenever the
 *  input already happens to be ordered, which is exactly how it hides. */
export interface SessionCandidate {
  sessionId: string;
  lastModified?: number;
  /** The session's own record of the directory it ran in. Authoritative for
   *  scoping — `listSessions({dir})` alone can widen (see `includeWorktrees`). */
  cwd?: string;
}

/** What a workspace should back its history/resume with. */
export type SessionChoice =
  /** `sdkClear`'s explicit "conversation cleared" marker: render nothing, and
   *  do NOT fall back to the newest session (that would resurrect the very
   *  conversation the user just cleared). */
  | { kind: 'cleared' }
  /** Resume the id persisted on the workspace. */
  | { kind: 'persisted'; sessionId: string }
  /** No persisted id (a workspace that has only ever run the TERMINAL agent):
   *  adopt the newest session for this worktree — the same one
   *  `claude --continue` would resume. */
  | { kind: 'newest'; sessionId: string }
  /** Nothing to show. */
  | { kind: 'none' };

/** Order a `listSessions` result newest-first.
 *
 *  ## Scoping is the CALLER's job, and `cwd` must NOT be used for it
 *
 *  Sibling-worktree contamination is real: `listSessions`'s `includeWorktrees`
 *  option DEFAULTS TO TRUE and walks every git worktree of the same repository.
 *  Orchestra routinely runs ~24 agents in sibling worktrees of ONE repo, so the
 *  default returned 24 sessions for a workspace owning 8 (measured). The caller
 *  therefore passes `dir: worktreePath, includeWorktrees: false`, which scopes
 *  the query exactly.
 *
 *  Adding a `cwd === worktreePath` filter on top of that looks like harmless
 *  defence and is not: a session's `cwd` is where it ORIGINALLY ran, and a
 *  workspace PROMOTED from a scratch dir to a git worktree keeps transcripts
 *  whose `cwd` is the old scratch path while they live in the new worktree's
 *  transcript dir. Measured on the real home: one such workspace
 *  (`orchestrator · bloc2-mc-next-migration-poc`) has `cwd`
 *  `…/scratch/orchestrator-clever-spark-36773f53` against a worktreePath of
 *  `…/worktrees/orchestrator-metarepo-…-36773f53`, and the filter silently
 *  discarded its ONLY session — i.e. that workspace's whole history. Parity
 *  caught it as `onlyScan=1`.
 *
 *  So: no `cwd` filter. Ordering only. */
export function scopeSessionsToWorktree(
  sessions: readonly SessionCandidate[],
  _worktreePath: string,
): SessionCandidate[] {
  return sessions.slice().sort((a, b) => (b.lastModified ?? 0) - (a.lastModified ?? 0));
}

/** Decide which session backs a workspace's history.
 *
 *  `persistedSessionId` carries THREE distinct states and they are not
 *  interchangeable:
 *    • `undefined` — never ran a structured session; fall back to the newest
 *      on-disk session so a terminal-only workspace still shows its history.
 *    • `''`        — explicitly CLEARED (`sdkClear`); show nothing, and take
 *      the fallback OFF, or a remount re-materializes the cleared conversation.
 *    • a uuid      — resume exactly that.
 *  Collapsing `''` and `undefined` into one falsy check is the specific bug
 *  this signature exists to prevent.
 *
 *  `isResumable` lets the caller require that the transcript actually exists on
 *  disk (a persisted id whose file is gone should still fall back). */
export function chooseSession(
  persistedSessionId: string | undefined,
  candidates: readonly SessionCandidate[],
  isResumable: (sessionId: string) => boolean = () => true,
): SessionChoice {
  if (persistedSessionId === '') return { kind: 'cleared' };
  if (persistedSessionId !== undefined && isResumable(persistedSessionId)) {
    return { kind: 'persisted', sessionId: persistedSessionId };
  }
  const newest = candidates.find((c) => isResumable(c.sessionId));
  return newest ? { kind: 'newest', sessionId: newest.sessionId } : { kind: 'none' };
}
