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

/**
 * #116's wrapper around the counters, confirmed at source on
 * `bus-shadow-mirror-116@835eb757:src/shared/bus-mirror.ts:196`.
 *
 * `counters` is the frozen array byte for byte; `busAvailable` is the field
 * #116 added and asked the pane to RENDER, and the ask is right: without it, an
 * all-zero row on a healthy run and an all-zero row taken while nothing could be
 * written are THE SAME OBSERVABLE. D1's consequence per the LEAD has two halves
 * — a bus-down mechanism reads OFF for the run AND the counter records it — and
 * only this flag carries the second half.
 *
 * NOTE the counters deliberately live in main-process MEMORY, not in the bus:
 * that is what lets a bus outage be COUNTED rather than lost with the
 * connection. So `busAvailable: false` arrives WITH a populated array, and the
 * pane must not treat a down bus as "no counters".
 */
export interface BusDivergenceReportView {
  runId: string;
  busAvailable: boolean;
  counters: BusDivergenceCounter[];
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
  /**
   * Did a counter SOURCE answer at all? Distinct from `counters.length === 0`
   * and from the snapshot's own `available`:
   *   null  — no source registered (#116 not present). NOT "zero divergence".
   *   true  — the mirror answered and the bus was up when it did.
   *   false — the mirror answered and reports the bus was DOWN; the counters
   *           are still populated (they live in memory, not in the bus).
   */
  countersBusAvailable: boolean | null;
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
    countersBusAvailable: null,
  };
}
