// Admission for WAKES (#287, wave G ledger #295, epic #284) — the thin, platform-aware wrapper the wake sites call. The queue, the permit and the release order
// live in admission.ts (`holdWake`); this file only answers "is this member a SLEEPING FLEET member?" from the real probes (no live SDK session, no PTY, a parent).
//
// A site calls `wakeHeldForMemory(ws, retry)` BEFORE it starts anything: `true` = HELD — skip it and leave the durable pending state exactly as it is
// (the bus lot, the parked prompts, the usage-limit marker, the inbox block, the pending prompts); the queue re-runs `retry` — the site's own normal path —
// when this member's turn comes (coordinators first, one at a time, a fresh reading each). `false` = go ahead (memory is fine, the member is running, or
// the release just granted this member's one-shot permit and this call consumed it).

import type { Workspace } from '../shared/types';
import { canOrchestrate } from '../shared/types';
import { isRunning } from './pty';
import { sdkSessionLive } from './sdk-delivery';
import { store } from './store';
import { holdWake } from './admission';

/** No live SDK session and no PTY: a wake would START a process. */
export function isSleeping(id: string): boolean {
  return !isRunning(id) && !sdkSessionLive(id);
}

export function wakeHeldForMemory(ws: Workspace, retry: () => Promise<unknown>, opts: { stillOwed?: () => boolean } = {}): boolean {
  const id = ws.id;
  return holdWake({
    wsId: id,
    fleetMember: !!ws.parentId,
    sleeping: isSleeping(id),
    coordinator: canOrchestrate(ws),
    retry,
    // Still wanted at release time: the workspace exists, is not archived and is STILL asleep (a person starting it meanwhile makes the wake a plain turn).
    stillOwed: opts.stillOwed ?? (() => {
      const w = store.getWorkspace(id);
      return !!w && !w.archived && isSleeping(id);
    }),
  }).held;
}
