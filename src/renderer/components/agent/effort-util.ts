// Pure, React-free data/logic for the Effort slider (EffortSlider.tsx), kept
// separate so `node --test` can exercise it without JSX (same pattern as
// model-util.ts). The five levels mirror the SDK's `EffortLevel`; unsupported
// levels are silently downgraded per model by the CLI, so the slider can always
// offer all five (sdk.d.ts).

import type { AgentEffortLevel } from '../../../shared/types';

/** Slider stops, left (fastest) → right (smartest). */
export const EFFORT_LEVELS: readonly AgentEffortLevel[] = [
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
];

/** The model default when the workspace has no explicit choice (sdk.d.ts:
 *  "`'high'` — Deep reasoning (default)"). */
export const DEFAULT_EFFORT: AgentEffortLevel = 'high';

export const EFFORT_LABELS: Record<AgentEffortLevel, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max',
};

/** One quiet line under the slider, from the SDK's own level descriptions. */
export const EFFORT_DESCRIPTIONS: Record<AgentEffortLevel, string> = {
  low: 'Minimal thinking — fastest responses',
  medium: 'Moderate thinking',
  high: 'Deep reasoning — the default',
  xhigh: 'Deeper reasoning than high',
  max: 'Maximum effort on capable models',
};

/** Index of a level on the slider; unknown/absent values land on the default
 *  stop so a corrupt persisted value can't park the thumb off-track. */
export function effortIndex(level: AgentEffortLevel | undefined): number {
  const idx = EFFORT_LEVELS.indexOf(level ?? DEFAULT_EFFORT);
  return idx === -1 ? EFFORT_LEVELS.indexOf(DEFAULT_EFFORT) : idx;
}

/** Fraction (0..1) of the track a level's stop sits at. */
export function effortFraction(level: AgentEffortLevel | undefined): number {
  return effortIndex(level) / (EFFORT_LEVELS.length - 1);
}

/** Nearest stop for a continuous track fraction — the drag-release snap.
 *  Clamps, and tolerates NaN (degenerate 0-width track) as the default. */
export function effortAtFraction(fraction: number): AgentEffortLevel {
  if (!Number.isFinite(fraction)) return DEFAULT_EFFORT;
  const clamped = Math.min(1, Math.max(0, fraction));
  return EFFORT_LEVELS[Math.round(clamped * (EFFORT_LEVELS.length - 1))];
}

/** Step a level by ±1 stop, clamped to the track — the keyboard interaction. */
export function stepEffort(level: AgentEffortLevel | undefined, delta: number): AgentEffortLevel {
  const idx = Math.min(EFFORT_LEVELS.length - 1, Math.max(0, effortIndex(level) + delta));
  return EFFORT_LEVELS[idx];
}
