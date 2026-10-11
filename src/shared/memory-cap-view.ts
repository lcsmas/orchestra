// #323 (wave H, ledger #329; epic #319; ADR 0005) — the PURE view logic of the Plafond mémoire in the UI: how a member's usage reads against its cap (Resources page), and what the Garde mémoire window may SAY about
// the frozen per-run switch `memory_cap` (it can show it, never flip it — D-Q1). Dependency-free so `node --test` covers it; the components only render these.
// The two figures are never mixed up (ledger R1 / R5): the HARD level compares the kernel bill (`memory.current`), the SOFT level compares the WORKING SET (`memory.current − inactive_file`).

import { GIB } from './memory-guard.ts';
import type { MemberCapView } from './member-memory.ts';
import type { BusSwitches } from './bus-switches.ts';

/** The bill is « close to the cap » from this fraction of the hard level (the bar turns red). */
export const CAP_NEAR_FRACTION = 0.9;

export type CapTone = 'ok' | 'warn' | 'crit';

export interface CapUsage {
  /** bill / hard, may exceed 1 for an instant (the kernel has not killed yet) — callers clamp for drawing. */
  billFrac: number;
  /** working set / hard; null = working set unreadable. */
  workingFrac: number | null;
  /** soft / hard; null = no soft level (or one at/above the hard level — nothing to mark). */
  softFrac: number | null;
  /** warn = the WORKING SET is at/over the soft level (the keeper's warning is armed); crit = the BILL is within {@link CAP_NEAR_FRACTION} of the hard level (the kernel kills at the hard level). crit wins. */
  tone: CapTone;
  /** Whole percent of the hard level the bill uses (what a « CAP » column prints). */
  billPct: number;
}

/** `softBytes` = the soft level to mark (null/0 = none). An unreadable working set never raises the warning tone (we cannot tell) — the bill alone can still turn the bar red. */
export function capUsage(cap: MemberCapView, softBytes: number | null): CapUsage {
  const billFrac = cap.billBytes / cap.hardBytes;
  const workingFrac = cap.workingSetBytes === null ? null : cap.workingSetBytes / cap.hardBytes;
  const softOk = softBytes !== null && softBytes > 0 && softBytes < cap.hardBytes;
  const tone: CapTone = billFrac >= CAP_NEAR_FRACTION ? 'crit' : softOk && cap.workingSetBytes !== null && cap.workingSetBytes >= (softBytes as number) ? 'warn' : 'ok';
  return { billFrac, workingFrac, softFrac: softOk ? (softBytes as number) / cap.hardBytes : null, tone, billPct: pctFloor(billFrac) };
}

/** Whole percent, FLOORED: « 90 % » on the page always means at/over the red threshold (89.6 % must not read as 90 while the bar is still green). */
const pctFloor = (frac: number): number => Math.floor(frac * 100 + 1e-9);
const gb = (b: number): string => `${(b / GIB).toFixed(b >= 10 * GIB ? 0 : 1)} GB`;
const gbExact = (b: number): string => `${Math.round((b / GIB) * 100) / 100} GB`;

/**
 * The row's tooltip. Both figures are named with what each is compared to. The hard level is the one the KERNEL holds for this very scope (read from `memory.max`); the soft level is the Garde mémoire setting NOW —
 * a member keeps what it started with, so when the settings moved since its start the line says so instead of letting the bar pretend.
 */
export function capTooltip(cap: MemberCapView, settings: { softGb: number; hardGb: number } | null): string {
  const parts = [`${gb(cap.billBytes)} kernel bill (what the hard level compares)`];
  if (cap.workingSetBytes !== null) parts.push(`${gb(cap.workingSetBytes)} working set (what the soft level compares)`);
  if (cap.peakBytes !== null) parts.push(`peak ${gb(cap.peakBytes)}`);
  const applied = `hard ${gbExact(cap.hardBytes)} (held by the kernel for this session)`;
  if (settings === null) {
    parts.push(applied); // an older main that does not send the levels: only what the kernel holds
    return parts.join(' · ');
  }
  const hardNow = Math.abs(cap.hardBytes - settings.hardGb * GIB) > 0.01 * GIB;
  parts.push(`soft ${settings.softGb} GB (settings now), ${applied}`);
  if ((cap.scopes ?? 1) > 1) parts.push(`the bar is the session's scope only — the member has ${cap.scopes} scopes and the figure beside adds them`);
  if (hardNow) parts.push(`settings now say hard ${settings.hardGb} GB — they apply to sessions started from now on`);
  return parts.join(' · ');
}

export interface CapRowLike {
  key: string;
  name: string;
  cap: MemberCapView | null;
}

/** The dim line under the Agents table: how many members run under a cap and which one is closest to it. null = none capped (the page shows nothing). */
export function capSummaryLine(rows: readonly CapRowLike[]): string | null {
  const capped = rows.filter((r): r is CapRowLike & { cap: MemberCapView } => r.cap !== null);
  if (capped.length === 0) return null;
  const worst = capped.reduce((a, b) => (b.cap.billBytes / b.cap.hardBytes > a.cap.billBytes / a.cap.hardBytes ? b : a));
  const pct = pctFloor(worst.cap.billBytes / worst.cap.hardBytes);
  return `${capped.length} capped member${capped.length === 1 ? '' : 's'} · closest: ${worst.name} ${pct} % of ${gbExact(worst.cap.hardBytes)}`;
}

// ─── The activation, as the Garde mémoire window may SAY it ────────────────────────────────────────────────────────

export interface CapSwitchSummary {
  /** The LIVE default the next run will freeze (Settings/Bus page edit it). */
  liveOn: boolean;
  /** Open (not closed) runs whose FROZEN copy has the switch ON / the open runs counted. null = the fleet bus is not open: UNKNOWN, never counted as zero. */
  runsOn: number | null;
  runsOpen: number | null;
  /** false = this host cannot hold a scope limit (the switch may read ON and nothing be capped); null = not asked. */
  hostOk: boolean | null;
  text: string;
}

/** Read-only: « Cap is OFF for new runs · ON on 0 of 3 open runs ». The window never offers a control for it — the switch is frozen per run at wave start (D-Q1). */
export function capSwitchSummary(
  live: Pick<BusSwitches, 'memoryCap'>,
  runs: ReadonlyArray<{ closedAt: number | null; flags: Pick<BusSwitches, 'memoryCap'> }> | null,
  host: { ok: true } | { ok: false; reason: string } | null = null,
): CapSwitchSummary {
  const liveOn = live.memoryCap === true;
  const head = `Cap is ${liveOn ? 'ON' : 'OFF'} for new runs`;
  const hostNote = host !== null && !host.ok ? ` · no effect on this host: ${host.reason}` : '';
  const hostOk = host === null ? null : host.ok;
  if (runs === null) return { liveOn, runsOn: null, runsOpen: null, hostOk, text: `${head} · open runs unknown (the fleet bus is not open)${hostNote}` };
  const open = runs.filter((r) => r.closedAt === null);
  const runsOn = open.filter((r) => r.flags.memoryCap === true).length;
  const runsOpen = open.length;
  return { liveOn, runsOn, runsOpen, hostOk, text: `${head} · ON on ${runsOn} of ${runsOpen} open run${runsOpen === 1 ? '' : 's'}${hostNote}` };
}
