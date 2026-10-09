// #322: the Plafond mémoire's notice row (a command killed / the warning level crossed) — the ONE builder the live emit and the reopened-pane backfill both call, so
// live == backfill by construction (the #57 lesson, same shape as restart-notice.ts / start-errors.ts). Pure: no main, no renderer, no Electron.

import type { AgentEvent, AgentNoticeEvent, MemCapRow } from './types.ts';
import { stamp, type NormalizeContext } from './agent-events.ts';
import { fmtGb, isSoftRecord, memNoticeText, type MemNoticeRecord } from './memory-scope.ts';

/** One persisted row (`Workspace.sdkMemNotices`): enough to rebuild the row after an app restart. `(unit, seq)` is the identity — a record delivered twice stores once. */
export interface MemNoticeEntry {
  unit: string;
  seq: number;
  at: number;
  level: 'hard' | 'external' | 'soft';
  text: string;
  /** #322 (D-Q7 B): the structured row (tone + text/command-chip segments), built ONCE from the record. Absent on an entry persisted before the dedicated row — {@link rowOfEntry} then derives a plain one from `text`. */
  row?: MemCapRow;
}

/** Entries kept per workspace (oldest dropped) — a notice row is a log line, not an archive. */
export const MAX_MEM_NOTICES = 50;

export const memNoticeKey = (e: Pick<MemNoticeEntry, 'unit' | 'seq'>): string => `${e.unit}:${e.seq}`;

export function memNoticeEntryOf(rec: MemNoticeRecord): MemNoticeEntry {
  return { unit: rec.unit, seq: rec.seq, at: rec.at, level: isSoftRecord(rec) ? 'soft' : rec.level, text: memNoticeText(rec), row: memCapRowOf(rec) };
}

/** The longest command shown in a chip (the full text stays in `text`, the tooltip and the bus message). */
export const MAX_CHIP_CHARS = 80;
const chipOf = (command: string): { kind: 'chip'; text: string } => ({ kind: 'chip', text: command.length > MAX_CHIP_CHARS ? `${command.slice(0, MAX_CHIP_CHARS - 1)}…` : command });

/**
 * The dedicated row of D-Q7 option B, as data: ONE line, red = a command was killed (`hard`), amber = the warning level crossed (`soft`), the command in a chip.
 *   · named by the kernel   → « Command [cmd] killed — 6 GB reached »
 *   · only inferred          → « A command was killed — 6 GB reached · probably [cmd] »  (an inference is SAID, never presented as certain)
 *   · too brief to be named  → « A command was killed — 6 GB reached (it lived too briefly to be named) »
 *   · an OOM from outside the scope's own limit → « … killed by the system under memory pressure (not by the Plafond mémoire) »
 *   · the member's own agent process / keeper → « — the member's own agent process: the session ended » appended (the cap's last resort)
 *   · warning level          → « Working set 3.1 GB — warning level 3 GB crossed (hard cap 6 GB) »
 */
export function memCapRowOf(rec: MemNoticeRecord): MemCapRow {
  if (isSoftRecord(rec)) {
    return { tone: 'soft', segments: [{ kind: 'text', text: `Working set ${fmtGb(rec.bytes)} — warning level ${fmtGb(rec.softBytes)} crossed${rec.hardBytes !== null ? ` (hard cap ${fmtGb(rec.hardBytes)})` : ''}` }] };
  }
  const reason = rec.level === 'hard' ? `${rec.hardBytes !== null ? `${fmtGb(rec.hardBytes)} reached` : 'Plafond mémoire reached'}` : 'by the system under memory pressure (not by the Plafond mémoire)';
  const ended = rec.role ? ` — the member's own ${rec.role === 'cli' ? 'agent process' : 'keeper'}: the session ended` : '';
  if (rec.command === null) return { tone: 'hard', segments: [{ kind: 'text', text: `A command was killed ${rec.level === 'hard' ? '— ' : ''}${reason} (it lived too briefly to be named)${ended}` }] };
  if (rec.source === 'kernel') return { tone: 'hard', segments: [{ kind: 'text', text: 'Command' }, chipOf(rec.command), { kind: 'text', text: `killed ${rec.level === 'hard' ? '— ' : ''}${reason}${ended}` }] };
  return { tone: 'hard', segments: [{ kind: 'text', text: `A command was killed ${rec.level === 'hard' ? '— ' : ''}${reason}${ended} · probably` }, chipOf(rec.command)] };
}

/** The row to render for an entry: the stored one, or — for an entry persisted before the dedicated row — a plain one-text row from its own `text`, tone by level. */
export const rowOfEntry = (e: MemNoticeEntry): MemCapRow => e.row ?? { tone: e.level === 'soft' ? 'soft' : 'hard', segments: [{ kind: 'text', text: e.text }] };

/** `list` + `entry`, oldest dropped past the cap; null when `entry` is already there (a re-delivery adds nothing). */
export function addMemNotice(list: readonly MemNoticeEntry[] | undefined, entry: MemNoticeEntry): MemNoticeEntry[] | null {
  const cur = list ?? [];
  const k = memNoticeKey(entry);
  if (cur.some((e) => memNoticeKey(e) === k)) return null;
  const next = [...cur, entry];
  return next.length > MAX_MEM_NOTICES ? next.slice(-MAX_MEM_NOTICES) : next;
}

/** The row: the dedicated `memory-cap` notice (D-Q7 B) — plain `text` for the a11y label / echo identity, the structured `memCap` for the renderer. ONE builder for the live emit and the reopened-pane backfill; `at` is the event's own time, so a reopened pane shows it where it happened. */
export function makeMemNotice(ctx: NormalizeContext, e: MemNoticeEntry): AgentNoticeEvent & { seq: number; at: number } {
  const ev = stamp(ctx, { type: 'notice' as const, kind: 'memory-cap' as const, text: e.text, memCap: rowOfEntry(e) });
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
