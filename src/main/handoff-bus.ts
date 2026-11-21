// #496 — what the fresh context of a handoff is told about the bus, read at DELIVERY time (never baked into the owed marker, which is written
// at acceptance): the real run id + every run holding mail still un-acked for the agent. Pure of the store/Electron: a `BusDb` is passed in.

import type { BusDb } from './bus.ts';
import { readPendingReaders } from './bus-wake.ts';
import { composeBusFrame } from '../shared/handoff.ts';

/** The frame for `reader` (the workspace id) in `runId` (its wave anchor). Pending runs = every related run with mail past the reader's cursor,
 *  an unanswered question, or an open gate addressed to it — the same set a wake order names, so the opening and the wake never disagree. */
export function busFrameFor(db: BusDb, reader: string, runId: string): string {
  const st = readPendingReaders(db, [{ reader, runId }])[0];
  const runs = [...(st?.pendingRunIds ?? []), ...(st?.gateRunIds ?? [])];
  return composeBusFrame({ runId, pendingRunIds: runs });
}
