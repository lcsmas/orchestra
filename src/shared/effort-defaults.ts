// The two user-chosen default reasoning efforts (see CONTEXT.md "Default
// effort"), the sibling of model-defaults.ts: one for workspaces a human
// creates, one for agents spawned by an agent. Pure, so the rules are testable
// without Electron.

import type { AgentEffortLevel } from './types.ts';
import type { ModelDefaultKind } from './model-defaults.ts';

/** Every effort level, lowest → highest. The single source for the deck bar's
 *  Effort slider and the defaults dropdown. */
export const EFFORT_LEVELS: readonly AgentEffortLevel[] = [
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
];

/** A default that pins nothing: the workspace's `sdkEffort` stays unset and the
 *  model uses its own default effort. Also the initial value, so shipping the
 *  setting changes nothing. */
export const MODEL_DEFAULT_EFFORT = 'default';

export type EffortDefault = AgentEffortLevel | typeof MODEL_DEFAULT_EFFORT;

/** Same two kinds as the default models — decided by WHO creates the workspace. */
export type EffortDefaults = Record<ModelDefaultKind, EffortDefault>;

function isEffortDefault(v: unknown): v is EffortDefault {
  return v === MODEL_DEFAULT_EFFORT || EFFORT_LEVELS.includes(v as AgentEffortLevel);
}

/** Complete, validated defaults from whatever the store holds (absent on
 *  stores predating the setting → both at {@link MODEL_DEFAULT_EFFORT}). */
export function normalizeEffortDefaults(raw: Partial<EffortDefaults> | undefined): EffortDefaults {
  const pick = (v: unknown): EffortDefault => (isEffortDefault(v) ? v : MODEL_DEFAULT_EFFORT);
  return { workspace: pick(raw?.workspace), spawned: pick(raw?.spawned) };
}

/** The value to record in a NEW workspace's `sdkEffort`: the default of its
 *  kind, or undefined for {@link MODEL_DEFAULT_EFFORT} (no pin). Frozen at
 *  creation, so a later settings change never moves an existing workspace —
 *  and a legacy workspace with no `sdkEffort` keeps the model's own default
 *  (unlike `ws.model`, it never follows the default live). */
export function effortForNewWorkspace(
  defaults: EffortDefaults,
  kind: ModelDefaultKind,
): AgentEffortLevel | undefined {
  const d = defaults[kind];
  return d === MODEL_DEFAULT_EFFORT ? undefined : d;
}
