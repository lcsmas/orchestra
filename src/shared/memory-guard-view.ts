// Memory guard Settings dialog — the PURE view logic (#285, mockup A, D-pick1): what the state chip says, where the gauge ticks sit,
// and whether a typed threshold pair may be committed. The React component (MemoryGuardSettings.tsx) only renders these.

import {
  GIB,
  RELEASE_MARGIN_GB,
  formatGb,
  patchMemoryGuardSettings,
  validateMemoryGuardSettings,
  type MemoryGuardSettings,
  type MemoryGuardSnapshot,
} from './memory-guard.ts';

export type GuardTone = 'ok' | 'warn' | 'crit' | 'unknown';
export interface GuardChip {
  tone: GuardTone;
  text: string;
}

/** Local HH:MM — the chip is read by the human in front of the screen (the log and `bus-status` carry full ISO times). */
export function clock(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** The chip beside the live figure. Status colours are reserved for problems: open = accent, HELD = warn, memory Pause = crit. */
export function guardChip(s: MemoryGuardSnapshot): GuardChip {
  if (!s.measured && s.availBytes === null) return { tone: 'unknown', text: 'Unmeasured' };
  // A dead meter keeps the last GOOD reading in the snapshot, but the chip must not present it as current: it says the meter is unreadable.
  const mem = s.availBytes === null ? '' : s.measured ? ` — ${formatGb(s.availBytes)}` : ' — meter unreadable';
  if (s.pause === 'held') return { tone: 'crit', text: `MEMORY PAUSE${s.pauseSince === null ? '' : ` since ${clock(s.pauseSince)}`}${mem}` };
  if (s.admission === 'held') {
    return { tone: 'warn', text: `${s.admissionEnabled ? 'HELD' : 'Below threshold (toggle OFF)'}${s.heldSince === null ? '' : ` since ${clock(s.heldSince)}`}${mem}` };
  }
  return { tone: 'ok', text: `Admission open${s.measured ? '' : ' — meter unreadable'}` };
}

export interface GaugeModel {
  /** 0..1 of the scale. */
  fill: number;
  critical: number;
  admission: number;
  reopen: number;
  /** Fill colour: accent normally, warn below Admission, crit below critical. */
  tone: 'ok' | 'warn' | 'crit';
  maxBytes: number;
}

/** Scale = the machine's memory when known (else 16 GB), widened so the reopen tick and the reading always fit. */
export function gaugeModel(availBytes: number | null, totalBytes: number | null, s: MemoryGuardSettings): GaugeModel {
  const reopenBytes = (s.admissionGb + RELEASE_MARGIN_GB) * GIB;
  const maxBytes = Math.max(totalBytes ?? 16 * GIB, reopenBytes * 1.25, availBytes ?? 0);
  const frac = (b: number) => Math.min(1, Math.max(0, b / maxBytes));
  const tone = availBytes === null ? 'ok' : availBytes < s.criticalGb * GIB ? 'crit' : availBytes < s.admissionGb * GIB ? 'warn' : 'ok';
  return {
    fill: availBytes === null ? 0 : frac(availBytes),
    critical: frac(s.criticalGb * GIB),
    admission: frac(s.admissionGb * GIB),
    reopen: frac(reopenBytes),
    tone,
    maxBytes,
  };
}

/** A typed GB figure ("6", "6.5", "6,5") → number; null when empty / not a number. */
export function parseGbInput(text: string): number | null {
  const t = text.trim().replace(',', '.');
  if (t === '') return null;
  if (/^\d{1,3}(,\d{3})+$/.test(text.trim())) return null; // « 1,000 » is a thousands group, not 1.000: refuse rather than misread
  if (!/^-?(\d+\.?\d*|\.\d+)$/.test(t)) return null; // plain decimals only (a sign stays so the range sentence names it): no hex (0x10), no exponent (1e3)
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

export type ThresholdCommit =
  | { kind: 'unchanged' }
  | { kind: 'invalid'; error: string }
  | { kind: 'patch'; patch: { admissionGb: number; criticalGb: number } };

/** What committing the two typed fields does. BOTH fields travel together: raising critical above the old Admission, or lowering
 *  Admission under the old critical, is only valid as a pair. Nothing is written until the pair is valid. */
export function planThresholdCommit(admissionText: string, criticalText: string, current: MemoryGuardSettings, totalBytes?: number | null): ThresholdCommit {
  const admissionGb = parseGbInput(admissionText);
  const criticalGb = parseGbInput(criticalText);
  if (admissionGb === null || criticalGb === null) return { kind: 'invalid', error: 'Enter both thresholds as a number of GB.' };
  const error = validateMemoryGuardSettings({ ...current, admissionGb, criticalGb }, totalBytes);
  if (error !== null) return { kind: 'invalid', error: `${error.charAt(0).toUpperCase()}${error.slice(1)}.` };
  if (admissionGb === current.admissionGb && criticalGb === current.criticalGb) return { kind: 'unchanged' };
  return { kind: 'patch', patch: { admissionGb, criticalGb } };
}

export type CapCommit =
  | { kind: 'unchanged' }
  | { kind: 'invalid'; error: string }
  | { kind: 'patch'; patch: { capSoftGb: number; capHardGb: number } };

/** #323: what committing the two typed Plafond mémoire fields does. Like the thresholds, the PAIR travels together — raising the soft level above the old hard level (or lowering the hard level under the old soft one) is only valid as a pair —
 *  and nothing is written until the pair is valid (hard > soft; the same validator the backend runs, so the inline refusal and the write path can never disagree). */
export function planCapCommit(softText: string, hardText: string, current: MemoryGuardSettings, totalBytes?: number | null): CapCommit {
  const capSoftGb = parseGbInput(softText);
  const capHardGb = parseGbInput(hardText);
  if (capSoftGb === null || capHardGb === null) return { kind: 'invalid', error: 'Enter both levels as a number of GB.' };
  // The SAME function the write path runs (patchMemoryGuardSettings): the MemTotal bound judges only a CHANGED Admission pair, so a cap commit is never refused for a stored pair a small host cannot satisfy (review MAJOR 1).
  const res = patchMemoryGuardSettings(current, { capSoftGb, capHardGb }, totalBytes);
  if (!res.ok) return { kind: 'invalid', error: `${res.error.charAt(0).toUpperCase()}${res.error.slice(1)}.` };
  if (capSoftGb === current.capSoftGb && capHardGb === current.capHardGb) return { kind: 'unchanged' };
  return { kind: 'patch', patch: { capSoftGb, capHardGb } };
}

export type WaitCommit =
  | { kind: 'unchanged' }
  | { kind: 'invalid'; error: string }
  | { kind: 'patch'; patch: { reliquatWaitMin: number } };

/** #323 / #326: what committing the typed Reliquat wait (minutes) does — validated by the SAME backend rule (1 … 1440 min), nothing written until it is valid. The field travels alone: it is not part of any other pair. */
export function planReliquatWaitCommit(text: string, current: MemoryGuardSettings, totalBytes?: number | null): WaitCommit {
  const reliquatWaitMin = parseGbInput(text); // a plain number parser ("30", "7,5"); the unit is minutes, not GB
  if (reliquatWaitMin === null) return { kind: 'invalid', error: 'Enter the Reliquat wait as a number of minutes.' };
  const res = patchMemoryGuardSettings(current, { reliquatWaitMin }, totalBytes); // same write-path validator (see planCapCommit)
  if (!res.ok) return { kind: 'invalid', error: `${res.error.charAt(0).toUpperCase()}${res.error.slice(1)}.` };
  if (reliquatWaitMin === current.reliquatWaitMin) return { kind: 'unchanged' };
  return { kind: 'patch', patch: { reliquatWaitMin } };
}
