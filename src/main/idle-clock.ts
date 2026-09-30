// The ONE idle clock (#236): every consumer of "how long has this workspace been
// silent" — the hibernation sweep AND the liveness roster — reads it here, so the
// app-start floor is bounded below by `createdAt` everywhere (`idleClockStart`).
// Separate from the leaf `hibernation-activity.ts`, which must import nothing (it
// breaks the activity↔pty cycle — pinned in hibernation-no-disk.test.ts). A source
// pin in bus-liveness-roster.test.ts fails if a second reader of the raw floor appears.

import { idleClockStart } from '../shared/hibernation.ts';
import { getAppStartedAt, getLastActivity } from './hibernation-activity.ts';

export function idleClockOf(ws: { id: string; createdAt?: number }): number {
  return idleClockStart(getLastActivity(ws.id), getAppStartedAt(), ws.createdAt);
}
