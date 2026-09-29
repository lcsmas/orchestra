// The persisted start-failure rows (#227 F3) as backfill events — pure, so the merge is unit-tested.
import type { AgentEvent } from './types.ts';
import type { NormalizeContext } from './agent-events.ts';

/** Merge `errors` (`Workspace.sdkStartErrors`) into a backfill by `at`: each row lands before the first event whose `at` is strictly
 *  greater (ties keep the existing event first); the events' own relative order is untouched, and rows past the last event go last. */
export function interleaveStartErrors(
  events: AgentEvent[],
  errors: Array<{ at: number; message: string }>,
  ctx: NormalizeContext,
): AgentEvent[] {
  if (errors.length === 0) return events;
  const rows = [...errors].sort((a, b) => a.at - b.at);
  const mk = (r: { at: number; message: string }): AgentEvent => ({
    type: 'error',
    seq: ctx.seq++,
    at: r.at,
    message: r.message,
    apiErrorStatus: null,
    willRetry: false,
  });
  const out: AgentEvent[] = [];
  let ri = 0;
  for (const ev of events) {
    const evAt = ev.at ?? Number.MAX_SAFE_INTEGER;
    while (ri < rows.length && rows[ri].at < evAt) out.push(mk(rows[ri++]));
    out.push(ev);
  }
  while (ri < rows.length) out.push(mk(rows[ri++]));
  return out;
}
