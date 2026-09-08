// The wire shape the read-only bus pane renders (#118, ledger #123).
//
// One snapshot object, assembled in main and handed to the renderer whole.
// Deliberately a SNAPSHOT rather than N chatty getters: the pane shows a run's
// state at an instant, and stitching six independent reads together in the
// renderer would render a tree whose messages, lots and gates came from
// different moments — a projection that never existed in the DB.

import type { BusSwitches } from './bus-switches.ts';

/**
 * Divergence counters per mechanism — THE FROZEN INTER-TICKET CONTRACT with
 * #116 (ledger #123 §Seams, quoted verbatim there):
 *
 *   { mechanism: string, missed: number, duplicate: number, lostWake: number }[]
 *   scoped to a run, over IPC.
 *
 * `mechanism` is typed `string`, not `BusMechanism`, ON PURPOSE — that is what
 * the frozen contract says, and narrowing it here would make #116's output fail
 * to typecheck the day it counts something outside my enum. The pane renders
 * whatever mechanisms it is handed. Any change to this shape is a
 * §Open-questions entry on #123, not a unilateral edit (either side).
 */
export interface BusDivergenceCounter {
  mechanism: string;
  missed: number;
  duplicate: number;
  lostWake: number;
}

/** A member's liveness + phase, as the pane shows it. */
export interface BusMemberLiveness {
  handle: string;
  phase: string | null;
  lastSeenAt: number | null;
  /** Outstanding (unacked) lot id for this reader, or null. */
  pendingLotId: number | null;
  /** How many messages are sitting in that outstanding lot. */
  pendingCount: number;
}

/** One run in the mission → wave tree, with its FROZEN flags. */
export interface BusRunSummary {
  id: string;
  kind: string;
  coordinator: string;
  parentRunId: string | null;
  title: string | null;
  createdAt: number;
  closedAt: number | null;
  /** Frozen at wave start. NOT the live switch values — see bus-switches.ts. */
  flags: BusSwitches;
}

/** A message row, in total order. */
export interface BusMessageView {
  sequence: number;
  runId: string;
  threadId: string | null;
  sender: string;
  recipient: string | null;
  kind: string;
  body: string;
  createdAt: number;
}

/** An open ask / decision gate awaiting a Ruling. */
export interface BusGateView {
  id: number;
  runId: string;
  askedBy: string;
  question: string;
  openedAt: number;
  resolution: string | null;
  resolvedBy: string | null;
  resolvedAt: number | null;
}

/**
 * What `bus:snapshot` returns.
 *
 * `available: false` is a FIRST-CLASS state, not an error and not an empty
 * snapshot. D1 (LEAD ruling, ledger #122) says the bus never blocks boot and
 * the app surfaces a visible "bus unavailable" state; T118.5 requires the pane
 * to render THAT state rather than a blank pane indistinguishable from "no
 * messages yet". Modelling it as `available: false` + `error` is what makes the
 * two distinguishable in the renderer at all — an empty array cannot carry the
 * difference, which is exactly how a down bus would come to look like a quiet
 * one.
 */
export interface BusSnapshot {
  available: boolean;
  /** Why the bus is unavailable — surfaced in the pane, not just the log. */
  error: string | null;
  /** Path of the DB, shown in the unavailable state so it is diagnosable. */
  path: string;
  /** LIVE switch values (what the settings UI edits). Distinct from run.flags. */
  liveSwitches: BusSwitches;
  runs: BusRunSummary[];
  /** The run currently selected/most recent — the one the detail lists describe. */
  selectedRunId: string | null;
  messages: BusMessageView[];
  gates: BusGateView[];
  members: BusMemberLiveness[];
  counters: BusDivergenceCounter[];
}

/** The all-empty, bus-down snapshot. */
export function unavailableSnapshot(
  path: string,
  error: string,
  liveSwitches: BusSwitches,
): BusSnapshot {
  return {
    available: false,
    error,
    path,
    liveSwitches,
    runs: [],
    selectedRunId: null,
    messages: [],
    gates: [],
    members: [],
    counters: [],
  };
}
