// idle-rule — the idle rule: an agent that is ALIVE but IDLE while the loop waits on something it owes (a review record on a head, an order's new head, a CONNECT) is woken once with the same brief, then replaced.
// NO fixed delay: the loop acts at its next pass when the agent's session is idle, it owes the action, and nothing is queued or in dispatch for it (`idleReading` says so — a transient idle between turns, or a message
// still waiting, reads null: never a double send). An agent that is running (`idleFor` null) is never touched. Pure decisions here; the loop's steps do the waking / replacing through the FleetPort and say it in the log.
import type { LoopCtx } from './fanout-loop.ts';
import { withLoop } from './fanout-loop-side.ts';

export type IdleAction = 'none' | 'wake' | 'replace';

/** `idle` = what `FleetPort.idleFor` says (null = running / queued / unknown). First act: wake again with the same brief; the next one, the agent idle again with nothing queued: replace. */
export function idleDecision(i: { idle: number | null; woken: boolean }): IdleAction {
  if (i.idle === null) return 'none';
  return i.woken ? 'replace' : 'wake';
}

/** The host's reading of ONE session (production: `fanout-acceptance-wiring.ts`; pure so the clause list is tested): ms since it went idle, or null when it is not idle OR something is queued / in dispatch for it —
 *  a turn in flight (`gateHeld`), a turn queued on the session, an opening prompt still owed, a prompt on the banner queue, a message parked in its inbox. Bus mail it has not acked is NOT a clause: an agent that read a
 *  message and never acted on it is exactly the one this rule exists for. */
export function idleReading(i: { status: string; archived?: boolean; gateHeld?: boolean; queuedCount?: number; pendingPromptCount?: number; queuedPrompts?: number; parkedInboxCount?: number; idleSince: number; now: number }): number | null {
  if (i.archived || i.status !== 'idle' || i.gateHeld) return null;
  if ((i.queuedCount ?? 0) + (i.pendingPromptCount ?? 0) + (i.queuedPrompts ?? 0) + (i.parkedInboxCount ?? 0) > 0) return null;
  return Math.max(0, i.now - i.idleSince);
}
export const idleNow = (ctx: LoopCtx, ws: string): number | null => (ctx.deps.options.idleRule === false ? null : ctx.deps.fleet.idleFor?.(ws) ?? null);
export const idleNote = (ticket: string, ws: string, idle: number, what: string, did: 'woken again' | 'replaced'): string => `${ticket}: ${ws} idle ${Math.round(idle / 60_000)} min owing ${what} — ${did}`;

/** A thing owed by `ws`, tracked under `key` in the loop's side file. Wakes (once) then replaces; returns what it did. `stalled` = released earlier and still there idle: the caller must NOT count the wait as progress. */
export async function owedAgent(ctx: LoopCtx, o: { key: string; ws: string; ticket: string; what: string; wake: () => Promise<void>; replace: () => Promise<void> }): Promise<'active' | 'woken' | 'replaced' | 'stalled'> {
  const { deps } = ctx;
  const idle = idleNow(ctx, o.ws);
  const e = ctx.st().loop.idle[o.key];
  if (e?.replacedAt) { // released, and the agent is still there idle: try again, the wait is no progress
    if (idle !== null) { await o.replace(); return 'stalled'; }
    return 'active';
  }
  const act = idleDecision({ idle, woken: !!e?.wokenAt });
  if (act === 'none') return 'active';
  const at = deps.now();
  if (act === 'wake') {
    await o.wake();
    ctx.update((x) => withLoop(x, { ...x.loop, idle: { ...x.loop.idle, [o.key]: { wokenAt: at } } }));
    ctx.did(idleNote(o.ticket, o.ws, idle!, o.what, 'woken again'));
    return 'woken';
  }
  await o.replace();
  ctx.update((x) => withLoop(x, { ...x.loop, idle: { ...x.loop.idle, [o.key]: { ...x.loop.idle[o.key], replacedAt: at } } }));
  ctx.did(idleNote(o.ticket, o.ws, idle!, o.what, 'replaced'));
  return 'replaced';
}
