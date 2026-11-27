// #676 — the loop's share of an OPEN POINT (`orchestra fanout open-point`): the point goes to the `about` ticket's implementer as an ORDER (like SYNC, #628); when `about` is already merged the loop opens a follow-up ticket
// (`followUpOf` set) that carries it; a point nobody addresses is closed by the loop's FIXED RULE, recorded as a decision the report lists — the loop never waits for a person (decision 11).
// Orders are spaced by `orderWaitMs`; the same head after 2 orders, or `MAX_POINT_ORDERS` orders over new heads that approve without addressing it, decides the point.
import type { LoopCtx } from './fanout-loop.ts';
import { withLoop } from './fanout-loop-side.ts';
import { OPEN_POINT_FIXED_RULE, decideOpenPoint, openFollowUp, openPointsOf, openPointsOpen, renderPointOrder } from './fanout-open-point.ts';
import { reviewOn } from './fanout-record.ts';

/** Orders for ONE point over every head (a new head that approves without addressing it earns a new order): past this the fixed rule decides. */
export const MAX_POINT_ORDERS = 4;
const pointSameSha = (a: string, b: string): boolean => !!a && !!b && (a.startsWith(b) || b.startsWith(a));
const pointMs = (iso: string): number => Date.parse(iso);

export async function stepOpenPoints(ctx: LoopCtx): Promise<void> {
  const { deps } = ctx;
  for (const p0 of openPointsOpen(ctx.st())) await ctx.guard(`open point ${p0.id}`, async () => {
    const s = ctx.st();
    const p = openPointsOf(s).find((x) => x.id === p0.id);
    if (!p || p.status !== 'open') return;
    const now = deps.now();
    const decide = (why: string): void => {
      ctx.update((x) => withLoop(decideOpenPoint(x, p.id, { by: 'loop', text: `${OPEN_POINT_FIXED_RULE} — ${why}`, now }), x.loop));
      ctx.did(`open point ${p.id} (${p.from} → ${p.about}) decided by the fixed rule: ${why}`);
    };
    const about = s.tickets[p.about];
    if (!p.followUp && about?.status === 'merged') { // the ticket it is about is already in the target: a follow-up ticket carries the point (the normal steps start, review and merge it)
      ctx.update((x) => withLoop(openFollowUp(x, p.id, now), x.loop));
      ctx.did(`open point ${p.id}: ${p.about} is merged — follow-up ticket ${openPointsOf(ctx.st()).find((x) => x.id === p.id)?.followUp} opened (followUpOf ${p.about})`);
      return;
    }
    const target = p.followUp ?? p.about;
    const tt = s.tickets[target];
    if (!tt || tt.status === 'dropped' || tt.status === 'parked' || tt.parked) { decide(`${target} is ${tt ? (tt.status === 'parked' || tt.parked ? 'parked' : tt.status) : 'gone'} — nothing can address the point`); return; }
    if (p.followUp) { ctx.waitOn(`point:${p.id}:${target}`, deps.options.stallMs); return; } // the follow-up flows through the ordinary steps; its reviewer settles the point
    const impl = tt.implementer;
    const o = s.loop.pointOrders[String(p.id)];
    if (!impl || !deps.fleet.live(impl)) { ctx.waitOn(`point:${p.id}:start`, deps.options.stallMs); return; } // `start` puts a fresh implementer on the ticket; the order follows next pass
    const head = tt.head ?? '';
    const send = async (n: number, total: number): Promise<void> => {
      await deps.fleet.wake(impl, renderPointOrder(s, p, n));
      ctx.update((x) => ({ ...x, loop: { ...x.loop, pointOrders: { ...x.loop.pointOrders, [String(p.id)]: { head, n, at: now, total } } } }));
      ctx.did(`open point ${p.id}: order ${n} sent to ${impl} (${p.about})`);
    };
    if (!o) return send(1, 1);
    if (!pointSameSha(o.head, head) && (o.head || head)) { // the implementer pushed since the order: the reviewer reads it (it was briefed with the point)
      const rv = head ? reviewOn(tt, head, tt.tree) : null;
      if (!rv || rv.verdict !== 'approve') { ctx.waitOn(`point:${p.id}:${head}`, deps.options.stallMs); return; } // not read yet / changes requested: the review and corrections steps are on it
      if (o.total >= MAX_POINT_ORDERS) return decide(`${o.total} orders and the approved head ${head.slice(0, 12)} still does not address it`);
      return send(1, o.total + 1); // approved without addressing it: a new order on this head
    }
    if (pointMs(now) - pointMs(o.at) < (deps.options.orderWaitMs ?? 15 * 60_000)) { ctx.busy = true; return; } // the implementer is on it
    if (o.n < 2) return send(o.n + 1, o.total + 1);
    decide(`${o.n} orders to ${impl} and ${p.about} has no new head`);
  });
}
