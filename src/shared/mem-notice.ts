// #322: the Plafond mémoire's notice row (a command killed / the warning level crossed) — the ONE builder the live emit and the reopened-pane backfill both call, so
// live == backfill by construction (the #57 lesson, same shape as restart-notice.ts / start-errors.ts). Pure: no main, no renderer, no Electron.

import type { AgentEvent, AgentNoticeEvent } from './types.ts';
import { stamp, type NormalizeContext } from './agent-events.ts';
import { isSoftRecord, memNoticeText, type MemNoticeRecord } from './memory-scope.ts';

/** One persisted row (`Workspace.sdkMemNotices`): enough to rebuild the row after an app restart. `(unit, seq)` is the identity — a record delivered twice stores once. */
export interface MemNoticeEntry {
  unit: string;
  seq: number;
  at: number;
  level: 'hard' | 'external' | 'soft';
  text: string;
}

/** Entries kept per workspace (oldest dropped) — a notice row is a log line, not an archive. */
export const MAX_MEM_NOTICES = 50;

export const memNoticeKey = (e: Pick<MemNoticeEntry, 'unit' | 'seq'>): string => `${e.unit}:${e.seq}`;

export function memNoticeEntryOf(rec: MemNoticeRecord): MemNoticeEntry {
  return { unit: rec.unit, seq: rec.seq, at: rec.at, level: isSoftRecord(rec) ? 'soft' : rec.level, text: memNoticeText(rec) };
}

/** `list` + `entry`, oldest dropped past the cap; null when `entry` is already there (a re-delivery adds nothing). */
export function addMemNotice(list: readonly MemNoticeEntry[] | undefined, entry: MemNoticeEntry): MemNoticeEntry[] | null {
  const cur = list ?? [];
  const k = memNoticeKey(entry);
  if (cur.some((e) => memNoticeKey(e) === k)) return null;
  const next = [...cur, entry];
  return next.length > MAX_MEM_NOTICES ? next.slice(-MAX_MEM_NOTICES) : next;
}

/** The row. Until the D4 mockup is chosen it is the existing `warning` notice kind (no renderer change); `at` is the event's own time, so a reopened pane shows it where it happened. */
export function makeMemNotice(ctx: NormalizeContext, e: MemNoticeEntry): AgentNoticeEvent & { seq: number; at: number } {
  const ev = stamp(ctx, { type: 'notice' as const, kind: 'warning' as const, text: e.text });
  return { ...ev, at: e.at };
}

/** Merge persisted rows into a backfill by `at`: each lands before the first event whose `at` is strictly greater (ties keep the existing event first); the events' own order is untouched. */
export function interleaveMemNotices(events: AgentEvent[], entries: readonly MemNoticeEntry[], ctx: NormalizeContext): AgentEvent[] {
  if (entries.length === 0) return events;
  const rows = [...entries].sort((a, b) => a.at - b.at || a.seq - b.seq);
  const out: AgentEvent[] = [];
  let ri = 0;
  for (const ev of events) {
    const evAt = ev.at ?? Number.MAX_SAFE_INTEGER;
    while (ri < rows.length && rows[ri].at < evAt) out.push(makeMemNotice(ctx, rows[ri++]));
    out.push(ev);
  }
  while (ri < rows.length) out.push(makeMemNotice(ctx, rows[ri++]));
  return out;
}
