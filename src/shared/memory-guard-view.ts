// Memory guard Settings dialog — the PURE view logic (#285, mockup A, D-pick1): what the state chip says, where the gauge ticks sit,
// and whether a typed threshold pair may be committed. The React component (MemoryGuardSettings.tsx) only renders these.

import {
  GIB,
  RELEASE_MARGIN_GB,
  formatGb,
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
  const mem = s.availBytes === null ? '' : ` — ${formatGb(s.availBytes)}`;
  if (s.pause === 'held') return { tone: 'crit', text: `MEMORY PAUSE${s.pauseSince === null ? '' : ` since ${clock(s.pauseSince)}`}${mem}` };
  if (s.admission === 'held') {
    return { tone: 'warn', text: `${s.admissionEnabled ? 'HELD' : 'Below threshold (toggle OFF)'}${s.heldSince === null ? '' : ` since ${clock(s.heldSince)}`}${mem}` };
  }
  return { tone: 'ok', text: 'Admission open' };
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
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

export type ThresholdCommit =
  | { kind: 'unchanged' }
  | { kind: 'invalid'; error: string }
  | { kind: 'patch'; patch: { admissionGb: number; criticalGb: number } };

/** What committing the two typed fields does. BOTH fields travel together: raising critical above the old Admission, or lowering
 *  Admission under the old critical, is only valid as a pair. Nothing is written until the pair is valid. */
export function planThresholdCommit(admissionText: string, criticalText: string, current: MemoryGuardSettings): ThresholdCommit {
  const admissionGb = parseGbInput(admissionText);
  const criticalGb = parseGbInput(criticalText);
  if (admissionGb === null || criticalGb === null) return { kind: 'invalid', error: 'Enter both thresholds as a number of GB.' };
  const error = validateMemoryGuardSettings({ ...current, admissionGb, criticalGb });
  if (error !== null) return { kind: 'invalid', error: `${error.charAt(0).toUpperCase()}${error.slice(1)}.` };
  if (admissionGb === current.admissionGb && criticalGb === current.criticalGb) return { kind: 'unchanged' };
  return { kind: 'patch', patch: { admissionGb, criticalGb } };
}
