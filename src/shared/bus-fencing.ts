// Fencing — the PURE decision half (#128, ledger #131).
//
// A coordinator carries a `coordinator_generation`. An OPS respawn BUMPS it, and
// a write (send / ack / gate-resolve) carrying an OLDER generation is stale —
// the writer is a superseded coordinator. This module holds the one pure
// predicate that decides what happens to such a write, kept free of SQLite and
// Electron so the unit suite drives it directly (the wave pattern: pure decision
// in src/shared, effectful writer in src/main).
//
// COEXISTENCE (inherited ruling, ledger #122/#131): the old channels stay
// AUTHORITATIVE. A switch that is OFF means the mechanism is COUNTED, not FIRED.
// So `decideFence` returns:
//   - 'pass'   : the write proceeds (not stale, OR the caller did not present a
//                generation — the v1 unfenced path).
//   - 'count'  : the write IS stale but `fencing` is OFF — record the shadow
//                event and let the write proceed (old channel authoritative).
//   - 'reject' : the write is stale AND `fencing` is ON — refuse it (a
//                StaleGenerationError at the effectful boundary).
//
// The distinction between 'count' and 'reject' is the entire point of shadow
// mode: a mechanism whose OFF-state is indistinguishable from the feature being
// absent cannot be observed before promotion.

export type FenceDecision = 'pass' | 'count' | 'reject';

export interface FenceInput {
  /** The generation the writer presented, or null/undefined = did not opt in. */
  presented: number | null | undefined;
  /** Is the writer the run's COORDINATOR? Fencing stops a zombie coordinator; a member's
   *  env generation is stale by construction after a restart (#222) and never fenced. */
  writerIsCoordinator: boolean;
  /** The run's current (authoritative) generation. */
  current: number;
  /** The `fencing` switch, frozen on the run row. */
  fencingOn: boolean;
}

/** Is `actor` (a caller-supplied `--as` / ws-id handle) the run's coordinator? Case-folded +
 *  trimmed so `--as <UPPERCASE id>` cannot dodge the fence (#222 review F1); null = no run row. */
export function isCoordinatorHandle(coordinator: string | null, actor: string): boolean {
  return coordinator !== null && coordinator.trim().toLowerCase() === actor.trim().toLowerCase();
}

/**
 * Decide the fate of one write.
 *
 * A caller that presents NO generation is never fenced, in EITHER switch state —
 * that is the old, unfenced channel and it must keep working (coexistence). A
 * writer that is not the run's coordinator is never fenced either (#222). Only a
 * COORDINATOR that opted into fencing by presenting a generation can be fenced, and
 * only when it is STRICTLY BELOW the current one:
 *   - equal  → the live coordinator itself (pass).
 *   - above  → impossible without a bump this caller performed (pass).
 *   - below  → a superseded coordinator: reject if the switch is ON, else count.
 */
export function decideFence(input: FenceInput): FenceDecision {
  if (input.presented === null || input.presented === undefined) return 'pass';
  if (!input.writerIsCoordinator) return 'pass'; // #222: members are never fenced
  if (input.presented >= input.current) return 'pass';
  return input.fencingOn ? 'reject' : 'count';
}

/**
 * Which run's generation + `fencing` switch a `run hold|resume` write is fenced against
 * (delta review R1). `chain` = the TARGET run first, then its ancestors nearest-first,
 * each with its coordinator handle. The actor is fenced as the coordinator of the FIRST
 * run in the chain it coordinates — itself the target (its own generation), or an
 * ancestor (a zombie LEAD presenting a stale generation of ITS OWN run). `null` = the
 * actor coordinates none of them (a member / stranger): A6 never fences those, and the
 * authority check refuses them, so the caller falls back to the target run.
 */
export function fenceRunForHold(
  chain: readonly { runId: string; coordinator: string }[],
  actor: string,
): string | null {
  for (const link of chain) {
    if (isCoordinatorHandle(link.coordinator, actor)) return link.runId;
  }
  return null;
}
