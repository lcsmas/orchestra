// The ONE idle clock (#236): every consumer of "how long has this workspace been
// silent" — the hibernation sweep AND the liveness roster — reads it here, so the
// app-start floor is bounded below by `createdAt` everywhere (`idleClockStart`).
// Separate from the leaf `hibernation-activity.ts`, which must import nothing (it
// breaks the activity↔pty cycle — pinned in hibernation-no-disk.test.ts). A source
// pin in bus-liveness-roster.test.ts fails if a second reader of the raw floor appears.

import { idleClockStart } from '../shared/hibernation.ts';
import { getAppStartedAt, getAppStartedMono, getLastActivity, getLastActivityMono, monotonicNow } from './hibernation-activity.ts';

export function idleClockOf(ws: { id: string; createdAt?: number }): number {
  // A createdAt in the FUTURE (wall clock stepped back after creation) is no birth time:
  // ignore it → app-start floor as before #236. Clamping to now would read "now" every sweep.
  const born = ws.createdAt !== undefined && ws.createdAt <= Date.now() ? ws.createdAt : undefined;
  return idleClockStart(getLastActivity(ws.id), getAppStartedAt(), born);
}

/** Idle time on the MONOTONIC clock (#326-fu m2): since the last activity seen this run, else the app start. Not bounded by `createdAt` — the wall figure is, and the Reliquat wait takes the smaller of the two. */
export function monotonicIdleOf(wsId: string): number {
  return monotonicNow() - (getLastActivityMono(wsId) ?? getAppStartedMono());
}
