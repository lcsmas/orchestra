// The liveness roster: which workspaces the sweep considers and what it reads off
// each — extracted from index.ts (#236) so the REAL mapping (incl. the silence
// start) is driven by tests through `sweepBusLiveness`, not just by a pure helper.
// INJECTED into the sweep via `setLivenessRoster` (see bus-liveness.ts for why).

import type { Workspace } from '../shared/types.ts';
import type { LivenessMember } from './bus-liveness.ts';
import { getInFlightTools } from './hibernation-activity.ts';
import { idleClockOf } from './idle-clock.ts';

/** The slice of the store the roster reads (`store` satisfies it; tests pass a fake). */
export interface LivenessRosterStore {
  readonly workspaces: readonly Workspace[];
  getWorkspace(id: string): Workspace | undefined;
}

export function buildLivenessRoster(
  store: LivenessRosterStore,
  waveRunId: (ws: Workspace) => string,
): () => LivenessMember[] {
  return () =>
    store.workspaces.map((ws) => {
      // Coordinator = the parent resolved to a LIVE workspace; a dangling/archived
      // parent → null → never escalated (nobody to escalate to).
      const parent = ws.parentId ? store.getWorkspace(ws.parentId) : undefined;
      return {
        reader: ws.id,
        coordinator: parent && !parent.archived ? parent.id : null,
        // A DISPATCHED member carries a `lastTask` (set at spawn); a hand-made UI
        // workspace has none and is not a fleet member.
        hasTask: !!ws.lastTask,
        // Silence start = the SAME idle clock hibernation uses: last activity, else
        // the app-start floor, never before the workspace existed (#236 — a spawn
        // 2 h after launch was escalated as "silent 86m" a minute in).
        lastActivityAt: idleClockOf(ws),
        // A turn IN FLIGHT is alive regardless of the discrete clock (acceptance 2).
        running: ws.status === 'running',
        // App-level parked signal; #119's bus `waiting` ORs in on top in the sweep.
        waiting: ws.status === 'waiting',
        // Liveness v2 (#127): every in-flight call, for the per-call progress bound.
        inFlightTools: getInFlightTools(ws.id),
        runId: waveRunId(ws),
      };
    });
}
