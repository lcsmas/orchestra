// Relance (#427) — the roster: what the decision reads off each workspace, and the kill switch. Lifted out of relance-host.ts (which needs the store / platform seam) so the REAL mapping
// is driven by node --test with injected deps — the facts behind « no Relance for a released member / a workspace without a coordinator » are asserted here, not pinned by source.

import type { Workspace } from '../shared/types.ts';
import type { RelanceMember } from '../shared/relance.ts';
import { coordinatorOf } from '../shared/run-position.ts';

export interface RelanceRosterDeps {
  workspaces(): readonly Workspace[];
  getWorkspace(id: string): Workspace | undefined;
  /** Members whose task is done AND released (`readReleasedReaders`, durable bus state). May throw (bus unreadable). */
  released(readers: ReadonlyArray<{ reader: string; runId: string }>): ReadonlySet<string>;
  runIdOf(ws: Workspace): string;
  /** `pauseRefusal(ws, 'auto') !== null`. */
  paused(ws: Workspace): boolean;
  /** `wakeRosterEntry(ws).wakeable`. */
  wakeable(ws: Workspace): boolean;
  warn(msg: string, e: unknown): void;
}

/** A coordinator = the parent resolved to a LIVE workspace; a dangling / archived parent is nobody (same rule as the liveness roster). */
function hasCoordinator(d: RelanceRosterDeps, ws: Workspace): boolean {
  const parent = coordinatorOf(ws, d.getWorkspace);
  return !!parent && !parent.archived;
}

function memberOf(d: RelanceRosterDeps, ws: Workspace, released: ReadonlySet<string>): RelanceMember {
  return {
    wsId: ws.id,
    hasCoordinator: hasCoordinator(d, ws),
    hasTask: !!ws.lastTask,
    released: released.has(ws.id),
    paused: d.paused(ws),
    wakeable: d.wakeable(ws),
    // a running turn, a turn parked on an answer / permission, or a prompt already queued: a Relance now would only pile behind it
    active: ws.status === 'running' || ws.status === 'waiting' || (ws.sdkPendingPrompts?.length ?? 0) > 0,
  };
}

/** Released = reported done and not re-tasked (durable bus state, never mail), asked only for the members the sweep follows. An unreadable bus reads « nobody released »: a finished member may get one needless turn, a stalled one is never silenced. */
function releasedOf(d: RelanceRosterDeps, list: readonly Workspace[]): ReadonlySet<string> {
  try {
    const keys = list.filter((w) => hasCoordinator(d, w) && !!w.lastTask).map((w) => ({ reader: w.id, runId: d.runIdOf(w) }));
    return keys.length === 0 ? new Set() : d.released(keys);
  } catch (e) {
    d.warn('relance: released read failed — treating as none released', e);
    return new Set();
  }
}

export function relanceMembers(d: RelanceRosterDeps): RelanceMember[] {
  const all = d.workspaces();
  const released = releasedOf(d, all);
  return all.map((ws) => memberOf(d, ws, released));
}

export function relanceMember(d: RelanceRosterDeps, wsId: string): RelanceMember | undefined {
  const ws = d.getWorkspace(wsId);
  return ws ? memberOf(d, ws, releasedOf(d, [ws])) : undefined;
}

/** `ORCHESTRA_RELANCE=0` turns the mechanism off (it is never started). */
export function relanceEnabled(env: Record<string, string | undefined>): boolean {
  return env.ORCHESTRA_RELANCE !== '0';
}
