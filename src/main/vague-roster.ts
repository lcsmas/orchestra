// Vague endormie (#428) — the roster: which runs are vagues and what the decision reads off each workspace of one. Lifted out of the host wiring (which needs the store / platform seam) so the REAL mapping
// is driven by node --test with injected deps: the facts behind « a member active / waiting / a Pause / every task finished ⇒ not asleep » are asserted here, not pinned by source.

import type { Workspace } from '../shared/types.ts';
import type { VagueFacts, VagueMember, VagueParticipant } from '../shared/vague-endormie.ts';

export interface VagueRosterDeps {
  workspaces(): readonly Workspace[];
  getWorkspace(id: string): Workspace | undefined;
  /** The run a workspace belongs to (its nearest orchestrator; itself when it has none). */
  runIdOf(ws: Workspace): string;
  /** Members whose task is done AND released (`readReleasedReaders`, durable bus state). May throw (bus unreadable). */
  released(readers: ReadonlyArray<{ reader: string; runId: string }>): ReadonlySet<string>;
  /** Readers parked as the opener of an unanswered ask / gate (`readWaitingReaders`). May throw. */
  busWaiting(readers: ReadonlyArray<{ reader: string; runId: string }>): ReadonlySet<string>;
  /** `pauseRefusal(ws, 'auto') !== null`. */
  paused(ws: Workspace): boolean;
  /** Admission holds this workspace's start (`livenessSilencedByAdmission`). */
  heldStart(ws: Workspace): boolean;
  /** Runs on HOLD (`heldRunIds`). May throw. */
  heldRuns(): ReadonlySet<string>;
  /** The idle clock (`idleClockOf`). */
  lastActivityAt(ws: Workspace): number;
  /** Activity of this workspace was observed since the app started (`getLastActivity` is defined). */
  seenThisRun(ws: Workspace): boolean;
}

const labelOf = (ws: Workspace): string => ws.name || ws.branch || ws.id;

function participantOf(d: VagueRosterDeps, ws: Workspace, waiting: ReadonlySet<string>): VagueParticipant {
  return {
    wsId: ws.id,
    label: labelOf(ws),
    // a running turn, or a prompt already queued behind one
    active: ws.status === 'running' || (ws.sdkPendingPrompts?.length ?? 0) > 0,
    // an app-level needs-input (permission / question / the human), or the opener of an unanswered ask / gate on the bus
    waiting: ws.status === 'waiting' || waiting.has(ws.id),
    heldStart: d.heldStart(ws),
    lastActivityAt: d.lastActivityAt(ws),
    seenThisRun: d.seenThisRun(ws),
  };
}

/** The runs with a LIVE coordinator and at least one member that was dispatched a task, grouped. An archived workspace is gone (nobody can be woken in it). */
function groups(d: VagueRosterDeps): Map<string, { coordinator: Workspace; members: Workspace[] }> {
  const out = new Map<string, { coordinator: Workspace; members: Workspace[] }>();
  for (const ws of d.workspaces()) {
    if (ws.archived) continue;
    const rid = d.runIdOf(ws);
    if (rid === ws.id) continue; // a coordinator (or a workspace that is its own run): not a member of anything
    let g = out.get(rid);
    if (!g) {
      const coordinator = d.getWorkspace(rid);
      if (!coordinator || coordinator.archived) continue; // a dangling anchor: nobody to tell
      g = { coordinator, members: [] };
      out.set(rid, g);
    }
    g.members.push(ws);
  }
  for (const [rid, g] of out) if (!g.members.some((m) => !!m.lastTask)) out.delete(rid);
  return out;
}

function factsOf(d: VagueRosterDeps, rid: string, g: { coordinator: Workspace; members: Workspace[] }, released: ReadonlySet<string>, waiting: ReadonlySet<string>, held: ReadonlySet<string>): VagueFacts {
  const members: VagueMember[] = g.members.map((ws) => ({
    ...participantOf(d, ws, waiting),
    task: ws.lastTask ?? '',
    // dispatched and not (reported done and released)
    unfinished: !!ws.lastTask && !released.has(ws.id),
  }));
  return {
    runId: rid,
    coordinator: participantOf(d, g.coordinator, waiting),
    members,
    paused: [g.coordinator, ...g.members].some((w) => d.paused(w)),
    runHeld: held.has(rid),
  };
}

/** The bus reads of one pass. A bus that cannot be read THROWS (the sweep logs it and judges nobody): a guess would either hide a stalled vague or tell a finished one it is asleep. */
function busReads(d: VagueRosterDeps, gs: Map<string, { coordinator: Workspace; members: Workspace[] }>): { released: ReadonlySet<string>; waiting: ReadonlySet<string>; held: ReadonlySet<string> } {
  const everyone = [...gs].flatMap(([rid, g]) => [g.coordinator, ...g.members].map((w) => ({ reader: w.id, runId: rid })));
  const taskKeys = [...gs].flatMap(([rid, g]) => g.members.filter((m) => !!m.lastTask).map((m) => ({ reader: m.id, runId: rid })));
  return {
    released: taskKeys.length === 0 ? new Set() : d.released(taskKeys),
    waiting: everyone.length === 0 ? new Set() : d.busWaiting(everyone),
    held: d.heldRuns(),
  };
}

export function vagueFacts(d: VagueRosterDeps): VagueFacts[] {
  const gs = groups(d);
  const reads = busReads(d, gs);
  return [...gs].map(([rid, g]) => factsOf(d, rid, g, reads.released, reads.waiting, reads.held));
}

/** ONE vague, read fresh (throws like `vagueFacts`). */
export function vagueFactsOf(d: VagueRosterDeps, runId: string): VagueFacts | undefined {
  const g = groups(d).get(runId);
  if (!g) return undefined;
  const reads = busReads(d, new Map([[runId, g]]));
  return factsOf(d, runId, g, reads.released, reads.waiting, reads.held);
}
