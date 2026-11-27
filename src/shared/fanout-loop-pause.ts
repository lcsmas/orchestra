// The HOST's pause of the run (hard / douce, set by a human or by the host on a usage limit or on memory) as the Boucle sees it. While it lasts every member is frozen — turns interrupted, tool trees killed, messages parked — so
// an order, a wait or an idle reading made in that window says nothing about the agent: the loop acts on NOTHING (no step: no stall clock, no order counted, no fixed-rule decision, no idle rule, no replacement, no spawn),
// says it once, and on the resume restarts every clock it holds (orders sent before the pause do not count toward the 2 of the escalation; the idle marks and the bounded waits start again). A failed read is "unknown": nothing is done either.
import type { LoopCtx } from './fanout-loop.ts';
import { LoopKilled } from './fanout-loop-kill.ts';
import { readLoopState, updateLoopState, withLoop, type LoopState } from './fanout-loop-side.ts';
import { SeatRefusal } from './fanout-state.ts';

export type PauseGate = 'paused' | 'resumed' | 'clear';

/** What the loop's clocks become after a pause: an order already sent counts as ONE (never more), its wait starts at `now`; the idle marks and the bounded waits are forgotten. Pure, tested. */
export function resetAfterPause(s: LoopState, now: string): LoopState {
  const orders = Object.fromEntries(Object.entries(s.loop.orders).map(([id, o]) => [id, { ...o, n: Math.min(o.n, 1), at: now }]));
  const pointOrders = Object.fromEntries(Object.entries(s.loop.pointOrders).map(([id, o]) => [id, { ...o, n: Math.min(o.n, 1), at: now, total: Math.max(1, o.total - Math.max(0, o.n - 1)) }]));
  const { hostPause: _p, ...loop } = s.loop;
  return withLoop(s, { ...loop, orders, pointOrders, idle: {}, busySince: {} });
}

export async function hostPauseGate(ctx: LoopCtx): Promise<PauseGate> {
  const { deps } = ctx;
  if (!deps.fleet.runPause) return 'clear';
  let p: Awaited<ReturnType<NonNullable<typeof deps.fleet.runPause>>>;
  try { p = await deps.fleet.runPause(); } catch (e) {
    if (e instanceof LoopKilled || e instanceof SeatRefusal) throw e;
    ctx.note(`host pause unreadable: ${e instanceof Error ? e.message : String(e)} — nothing is done this pass (unknown is never "not paused")`);
    return 'paused';
  }
  const s = readLoopState(deps.home, deps.run);
  const now = deps.now();
  if (p) {
    if (!s) { ctx.note('the run is paused by the host — the loop waits'); return 'paused'; }
    if (!s.loop.hostPause) {
      updateLoopState(deps.home, deps.run, (cur) => withLoop(cur!, { ...cur!.loop, hostPause: { since: now, by: p.by } }));
      deps.log(`[pass ${ctx.pass}] host pause: the run is paused${p.by ? ` by ${p.by}` : ''}${p.resuming ? ' (Reprise under way)' : ''} — the loop waits: no stall clock, no order counted, no decision, no replacement, no spawn`);
    }
    return 'paused';
  }
  if (!s?.loop.hostPause) return 'clear';
  const since = s.loop.hostPause.since;
  updateLoopState(deps.home, deps.run, (cur) => resetAfterPause(cur!, now));
  deps.log(`[pass ${ctx.pass}] host pause lifted after ${Math.round((Date.parse(now) - Date.parse(since)) / 60_000)} min — orders, waits and idle marks start again`);
  return 'resumed';
}
