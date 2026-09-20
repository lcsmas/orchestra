// Human-directed decision gates (#161).
//
// A `decision_gates` row (src/main/bus.ts, #119) whose `recipient` is the HUMAN
// is a fleet question routed to the app's user rather than to another agent. It
// surfaces in the app UI as a first-class ask — an inline row in the asking
// workspace (surface A) and an aggregated "Asks" section in the sidebar (surface
// B) — both reading the SAME row, both resolving it through one IPC. The gate
// lifecycle (open → nudge → resolved, resolved_by=human, re-wake the asker) is
// the EXISTING agent-gate machinery (#119/#158); this module only names the
// recipient handle and the wire shape the renderer renders, so CLI, main and
// renderer agree on ONE definition instead of a bare string in N places.

/**
 * The reserved recipient handle a gate carries to address the human.
 *
 * `orchestra gate open --to human "<question>"` writes `recipient='human'`;
 * every "gates addressed to the human" read keys on this exact value. It is a
 * normal recipient string to the bus (no schema change) — the only thing special
 * about it is that no agent workspace id can collide with it (ids are uuids).
 */
export const HUMAN_GATE_RECIPIENT = 'human';

/** True iff a gate's recipient is the human (surface A/B render it; agents ignore it). */
export function isHumanGateRecipient(recipient: string | null | undefined): boolean {
  return recipient === HUMAN_GATE_RECIPIENT;
}

/**
 * The wire shape the renderer renders for one open human gate. A projection of
 * a `BusDecisionGate` (src/main/bus.ts) plus the two things the DB row cannot
 * carry but the UI needs: the workspace the asker maps to (for surface A
 * placement + surface B deep-link) and a human-readable asker label.
 *
 * DELIBERATELY carries only OPEN gates — a resolved gate leaves the list, so the
 * renderer never has to reason about resolution state. Answering removes the row
 * from the next pushed snapshot (backfill==live, #57: the snapshot is rebuilt
 * from the DB each push, so live and reconstructed are byte-identical).
 */
export interface HumanGateView {
  /** `decision_gates.id` — the immutable address for resolve (never an index). */
  id: number;
  /** The gate's run (`decision_gates.run_id`). */
  runId: string;
  /** The asker's handle (`decision_gates.asked_by`) — usually a workspace id. */
  askedBy: string;
  /** The workspace the asker resolves to, if it is a live workspace Orchestra
   *  knows about — else null (a gate from a run with no live workspace still
   *  renders in the sidebar tray, just without a deep-link / inline surface). */
  askedByWorkspaceId: string | null;
  /** A short label for the asker (branch name if resolvable, else the handle). */
  askedByLabel: string;
  /** The question text (`decision_gates.question`). */
  question: string;
  /** When the gate opened (`decision_gates.opened_at`, epoch ms) — the age clock. */
  openedAt: number;
}

/** Sort key: oldest gate first (it has waited longest, so it nudges hardest). */
export function byOpenedAtAsc(a: HumanGateView, b: HumanGateView): number {
  return a.openedAt - b.openedAt || a.id - b.id;
}

/**
 * The result of a UI resolve — enough for the renderer to report success or a
 * PRECISE refusal, never a silent no-op. `not-open` is the idempotent-by-refusal
 * case (another window already answered, or the id is unknown): the first ruling
 * stands. Shared (not main-only) so the IPC contract in `ipc.ts` can name it.
 */
export type HumanGateResolveResult =
  | { ok: true; gateId: number }
  | { ok: false; reason: 'no-bus' | 'not-open' | 'empty'; gateId: number };

/**
 * A compact, human-readable "waited N" label from an age in ms. Pure so the
 * badge text is unit-testable without a clock. Buckets: <1m → "just now",
 * minutes, then hours+minutes. The age is a NUDGE, not a precise timer, so it
 * stays coarse (no seconds) and never implies more precision than it has.
 */
export function formatGateAge(ageMs: number): string {
  if (ageMs < 0) ageMs = 0;
  const totalMin = Math.floor(ageMs / 60_000);
  if (totalMin < 1) return 'just now';
  if (totalMin < 60) return `${totalMin}m`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

/**
 * Whether a gate has aged enough to nudge harder (a stronger badge tint). Kept
 * pure + centralized so surface A's inline row and surface B's tray agree on the
 * threshold. 15 min matches the fleet's own ~15-min liveness cadence.
 */
export const GATE_OLD_AFTER_MS = 15 * 60_000;

export function isGateOld(ageMs: number): boolean {
  return ageMs >= GATE_OLD_AFTER_MS;
}
