// #142 — re-parenting a RUNNING workspace must re-derive its bus run id.
//
// THE GAP #142 CLOSES (ledger #135 review-F2 finding R2, carved out by ruling
// D3): the run id (nearest orchestrator, #134 D1) is derived at createWorkspace
// and baked into the member's env (`ORCHESTRA_RUN_ID`) + its
// `.orchestra/bus-switches` notice. `orchestra attach/detach`, adopt and demote
// change the TREE but not the RUNNING session: its sends keep landing in the OLD
// run and it reads the OLD frozen flags until the session restarts (self-heals
// only at relaunch). D1a-bis: a message is governed by the flags of the INNERMOST
// run of its two parties, so a member re-parented under a second OPS whose run
// froze a DIFFERENT flag must, after the op, name the NEW run's flags.
//
// This module is the PURE half — deciding, from a workspace's OLD vs NEW anchor
// and its liveness, whether it needs a run reconcile and what action to take —
// so it is unit-testable without the Electron/store chain `workspaces.ts` drags
// in. The effectful half (`reconcileRunAfterReparent`, workspaces.ts) injects the
// live probes (anchor resolver, `isRunning`/`sdkSessionLive`), the notice writer,
// the restart, and the store write.

/** What one candidate workspace needs after a re-parent moved the tree. */
export type ReparentAction =
  /** Its anchor did not change → nothing to do (the run it belongs to is the
   *  same; the notice and env are already correct). */
  | { kind: 'noop' }
  /** Anchor changed but no live session holds the old run in memory → just
   *  rewrite the notice for the new run. The next launch reads the new
   *  `$ORCHESTRA_RUN_ID` anyway, so no restart / stale marker is needed. */
  | { kind: 'notice-only' }
  /** Anchor changed AND a live session holds the old run → rewrite the notice
   *  and RESTART conversation-preserving so the env is re-read. */
  | { kind: 'restart' }
  /** Anchor changed, a live session holds the old run, and the caller passed
   *  `--no-restart` → rewrite the notice, mark the workspace 'stale run', and
   *  refuse its bus sends until it restarts. */
  | { kind: 'mark-stale' };

/** The inputs the pure decision needs about ONE candidate. */
export interface ReparentCandidate {
  /** The run id the workspace belonged to BEFORE the tree changed. */
  oldAnchorId: string;
  /** The run id the workspace belongs to AFTER the tree changed. */
  newAnchorId: string;
  /** Does a live session (PTY or structured) hold this workspace right now? A
   *  cold workspace re-reads the env at its next launch, so it never needs a
   *  restart or a stale marker. */
  live: boolean;
}

/**
 * Decide what a single re-parented workspace needs. The anchor CHANGING is the
 * necessary condition for any action — an attach/detach that leaves the nearest
 * orchestrator the same (e.g. re-parenting under a coordinator that resolves to
 * the SAME run) is a genuine no-op, and issuing a restart there would be a
 * gratuitous conversation interruption.
 *
 * `noRestart` only matters when a restart would otherwise fire (anchor changed +
 * live): it downgrades the restart to a stale marker + send refusal. A cold
 * workspace is `notice-only` regardless of `noRestart`, because there is no live
 * session to leave holding the stale run.
 */
export function decideReparentAction(
  candidate: ReparentCandidate,
  noRestart: boolean,
): ReparentAction {
  if (candidate.oldAnchorId === candidate.newAnchorId) return { kind: 'noop' };
  if (!candidate.live) return { kind: 'notice-only' };
  return noRestart ? { kind: 'mark-stale' } : { kind: 'restart' };
}

/** The marker file body written into `.orchestra/bus-run-stale` when a live
 *  workspace is re-parented with `--no-restart`. The store-less CLI reads THIS
 *  file (it cannot reach the store) to refuse a send that would land in the
 *  stale run, and prints its first line as the refusal reason. The NEW run id is
 *  named so a human sees which run the send WOULD land in once restarted. */
export function staleRunMarkerBody(newRunId: string): string {
  return (
    `stale run: this workspace was re-parented but its live session still holds the ` +
    `OLD run id, so bus sends are refused until it restarts.\n` +
    `new run: ${newRunId}\n` +
    `fix: orchestra restart ${'${ORCHESTRA_WS_ID}'} (conversation-preserving)\n`
  );
}

/** The one-line refusal the CLI `send` prints when the stale marker is present.
 *  Keyed on the marker's FIRST line so the message the human sees and the file
 *  the guard reads are the same string. */
export function staleRunRefusalMessage(markerFirstLine: string): string {
  return (
    `refused: ${markerFirstLine.trim()}\n` +
    `  run \`orchestra restart\` to re-derive this workspace's run and clear the block.`
  );
}
