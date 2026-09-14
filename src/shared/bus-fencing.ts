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
  /** The run's current (authoritative) generation. */
  current: number;
  /** The `fencing` switch, frozen on the run row. */
  fencingOn: boolean;
}

/**
 * Decide the fate of one write.
 *
 * A caller that presents NO generation is never fenced, in EITHER switch state —
 * that is the old, unfenced channel and it must keep working (coexistence). Only
 * a caller that opted into fencing by presenting a generation can be fenced, and
 * only when it is STRICTLY BELOW the current one:
 *   - equal  → the live coordinator itself (pass).
 *   - above  → impossible without a bump this caller performed (pass).
 *   - below  → a superseded coordinator: reject if the switch is ON, else count.
 */
export function decideFence(input: FenceInput): FenceDecision {
  if (input.presented === null || input.presented === undefined) return 'pass';
  if (input.presented >= input.current) return 'pass';
  return input.fencingOn ? 'reject' : 'count';
}
