// The two user-chosen default models (see CONTEXT.md "Default model"): one for
// workspaces a human creates, one for agents spawned by an agent. Pure, so the
// resolution rules are testable without Electron.

/** Stored in `ws.model` (and as a default) to mean "let Claude Code use the
 *  account's own default". Explicit, because an ABSENT `ws.model` means
 *  something else: a legacy workspace that follows the workspace default live.
 *  Never passed to the CLI — {@link resolveLaunchModel} turns it into "no pin". */
export const ACCOUNT_DEFAULT_MODEL = 'default';

/** The value both defaults start at, so shipping the setting changes nothing
 *  (Opus 4.8, the hardcoded default since 2026-09-10). Full wire id: the short
 *  alias `opus-4-8` is rejected with `unrecognized_model`. */
export const INITIAL_DEFAULT_MODEL = 'claude-opus-4-8';

export interface ModelDefaults {
  /** Pinned onto every workspace a human creates (sidebar, ticket click, fork). */
  workspace: string;
  /** Pinned onto every workspace an agent creates with `orchestra spawn`. */
  spawned: string;
}

/** Which default a new workspace takes — decided by WHO creates it, not by
 *  which code path the creation goes through. */
export type ModelDefaultKind = keyof ModelDefaults;

const MODEL_RE = /^[A-Za-z0-9._:/[\]-]{1,64}$/;

/** A model arg is passed verbatim to `claude --model` (args array, no shell):
 *  a charset/length sanity guard is all that's needed. */
export function isValidModelArg(model: string): boolean {
  return MODEL_RE.test(model);
}

/** Complete, validated defaults from whatever the store holds (absent on
 *  stores predating the setting → both at {@link INITIAL_DEFAULT_MODEL}). */
export function normalizeModelDefaults(raw: Partial<ModelDefaults> | undefined): ModelDefaults {
  const pick = (v: unknown): string => {
    const s = typeof v === 'string' ? v.trim() : '';
    return s && isValidModelArg(s) ? s : INITIAL_DEFAULT_MODEL;
  };
  return { workspace: pick(raw?.workspace), spawned: pick(raw?.spawned) };
}

/** The value to record in a NEW workspace's `ws.model`: the explicit pick if
 *  any, else the default of its kind. Always non-empty, so the default is
 *  frozen at creation and a later settings change never moves the workspace. */
export function modelForNewWorkspace(
  explicit: string | undefined,
  defaults: ModelDefaults,
  kind: ModelDefaultKind,
): string {
  return explicit?.trim() || defaults[kind];
}

/** The model to launch a workspace's agent on (`claude --model` /
 *  `options.model`), or undefined for "no pin" (the account default).
 *  `ws.model` wins; an absent one (legacy workspace) follows the workspace
 *  default live; the {@link ACCOUNT_DEFAULT_MODEL} marker means no pin. */
export function resolveLaunchModel(
  wsModel: string | undefined,
  defaults: ModelDefaults,
): string | undefined {
  const m = wsModel?.trim() || defaults.workspace;
  return m === ACCOUNT_DEFAULT_MODEL ? undefined : m;
}
