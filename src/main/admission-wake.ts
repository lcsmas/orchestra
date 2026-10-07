// Admission for WAKES (#287, wave G ledger #295, epic #284) — the thin, platform-aware wrapper the wake sites call. The queue, the permit and the release order
// live in admission.ts (`holdWake`); this file only answers "is this member a SLEEPING FLEET member?" from the real probes (no live SDK session, no PTY, a parent).
//
// A site calls `wakeHeldForMemory(ws, retry, {site})` BEFORE it starts anything: `true` = HELD — skip it and leave the durable pending state exactly as it is
// (the bus lot, the parked prompts, the usage-limit marker, the inbox block, the pending prompts); the queue re-runs `retry` — the site's own normal path —
// when this member's turn comes (coordinators first, one at a time, a fresh reading each). `false` = go ahead (memory is fine, the member is running, or
// the release just granted this member's one-shot permit and this call consumed it).

import type { Workspace } from '../shared/types';
import { canOrchestrate } from '../shared/types';
import { isRunning } from './pty';
import { sdkAwaitFirstTurn, sdkSessionLive } from './sdk-delivery';
import { probeKeeper } from './keeper-client';
import { store } from './store';
import { ADMISSION_WAKE_SETTLE_MS, holdWake, setAdmissionWakeSettle, wakeWouldBeHeld } from './admission';

// A wake release waits (bounded) for the started member's first turn so the next fresh reading includes its memory — wired HERE because admission.ts is platform-free.
setAdmissionWakeSettle((id) => sdkAwaitFirstTurn(id, ADMISSION_WAKE_SETTLE_MS));

/** No live SDK session and no PTY: a wake would START a process. */
export function isSleeping(id: string): boolean {
  return !isRunning(id) && !sdkSessionLive(id);
}

/** F1: the member's CLI is ALIVE in a detached keeper (an app relaunch leaves the in-memory session absent until its view opens): a wake only REATTACHES it — no new process,
 *  so it is never held. A never-started (init-wedged) or shutting-down keeper is killed + respawned fresh by the attach path — that IS a start. */
export async function keeperResident(id: string): Promise<boolean> {
  const probe = await probeKeeper(id).catch(() => null);
  return !!probe?.running && probe.everStarted !== false && probe.shuttingDown !== true;
}

export async function wakeHeldForMemory(
  ws: Workspace,
  retry: () => Promise<unknown>,
  opts: {
    /** 'flush' | 'resume' | 'message' | 'recovery' — one retry per site per member is kept (the bus sweep registers as 'sweep' itself). */
    site: string;
    stillOwed?: () => boolean;
    /** The retry re-enters `wakeHeldForMemory` (consumes the permit): default true. false for a retry that starts the member directly. */
    reenters?: boolean;
  },
): Promise<boolean> {
  const id = ws.id;
  if (!ws.parentId || !isSleeping(id)) return false; // a running member / non-fleet workspace: never a held start (same answer as holdWake, without the probe)
  if (wakeWouldBeHeld() && (await keeperResident(id))) return false;
  return holdWake({
    wsId: id,
    fleetMember: !!ws.parentId,
    sleeping: isSleeping(id),
    coordinator: canOrchestrate(ws),
    site: opts.site,
    retry,
    reenters: opts.reenters,
    // Still wanted at release time: the workspace exists, is not archived and is STILL asleep (a person starting it meanwhile makes the wake a plain turn).
    stillOwed: opts.stillOwed ?? (() => {
      const w = store.getWorkspace(id);
      return !!w && !w.archived && isSleeping(id);
    }),
  }).held;
}
