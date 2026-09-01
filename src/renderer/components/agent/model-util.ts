// Pure model-switcher helpers for the structured agent view. Kept dependency-free
// (no React) so `node --test` can exercise them — AgentControls.tsx imports these
// and pairs each id with an icon/tint for the AvMenu cards.

import type { AgentModelInfo } from '../../../shared/types';

/** A model the switcher offers as a card, minus the React icon. AgentControls
 *  zips these with icons/tints when building the AvMenu items. */
export interface ModelChoice {
  value: string;
  label: string;
  description: string;
  /** Canonical wire id `value` resolves to, when the choice came from the LIVE
   *  runtime list (e.g. alias `opus` → `claude-opus-5`). Lets the switcher
   *  match a persisted/live full id against the alias card covering it. */
  resolvedModel?: string;
}

/** Model choices offered in the switcher, newest/most-capable first. The live
 *  model is shown even when it's not in this list (see {@link describeLiveModel}) —
 *  e.g. the account default resolves to a context-suffixed variant like
 *  `claude-opus-5[1m]`. Ids are the canonical aliases (never date-suffixed). */
export const MODEL_CHOICES: ModelChoice[] = [
  { value: 'claude-fable-5-1', label: 'Fable 5.1', description: 'Most capable — hardest work' },
  { value: 'claude-fable-5', label: 'Fable 5', description: 'Previous Fable release' },
  { value: 'claude-opus-5', label: 'Opus 5', description: 'Highly capable — deep work' },
  { value: 'claude-sonnet-5', label: 'Sonnet 5', description: 'Balanced speed and depth' },
  { value: 'claude-haiku-4-5', label: 'Haiku 4.5', description: 'Fastest — light tasks' },
];

/** Claude Code's short model aliases → the canonical id we hold a card for.
 *  The account default is stored in `settings.json` as an alias (e.g. `opus[1m]`,
 *  `sonnet`), so a base of `opus` must resolve to `claude-opus-5` to reuse its
 *  card. Kept deliberately small — the mapping the CLI ships today (opus → Opus 5 since
 *  2026-07-24; fable → claude-fable-5-1, measured on CLI 2.1.257, 2026-09-01). */
const MODEL_ALIASES: Record<string, string> = {
  opus: 'claude-opus-5',
  sonnet: 'claude-sonnet-5',
  haiku: 'claude-haiku-4-5',
  fable: 'claude-fable-5-1',
};

/** Turn a live row into the label we render: the VERSIONED family name, with no
 *  context-size noise — "Opus 5", not "Opus" and not "Opus (1M context)".
 *
 *  The runtime's `displayName` is the bare family ("Opus", "Fable") or carries a
 *  context parenthetical ("Opus (1M context)"), and the version lives elsewhere.
 *  Two sources, in order:
 *    1. `description`, whose first `·`-segment is exactly the versioned name
 *       ("Opus 5 with 1M context · …" → "Opus 5"; "Haiku 4.5 · …" → "Haiku 4.5");
 *    2. `resolvedModel` as the fallback (`claude-opus-5[1m]` → "Opus 5"), for
 *       rows whose description ever stops leading with the name.
 *  Falls back to the suffix/parenthetical-stripped `displayName` so an
 *  unrecognized row still renders something sane rather than empty. */
export function versionedLabel(m: AgentModelInfo): string {
  // 1. Leading segment of the description, minus any "with 1M context" tail.
  const lead = (m.description ?? '').split('·')[0].trim();
  const fromDesc = lead.replace(/\s+with\s+.*$/i, '').trim();
  if (/^[A-Z][A-Za-z]*\s+\d/.test(fromDesc)) return fromDesc;

  // 2. Canonical id → "Family Version" (claude-opus-5[1m] → Opus 5,
  //    claude-haiku-4-5-20251001 → Haiku 4.5; a date snapshot is dropped).
  const id = splitContextSuffix(m.resolvedModel ?? '').base.replace(/-\d{8}$/, '');
  const parsed = /^claude-([a-z]+)-(\d+(?:-\d+)?)$/.exec(id);
  if (parsed) {
    const family = parsed[1][0].toUpperCase() + parsed[1].slice(1);
    return `${family} ${parsed[2].replace(/-/g, '.')}`;
  }

  // 3. Last resort: the runtime's own name, minus the context parenthetical.
  return (m.displayName ?? '').replace(/\s*\([^)]*context[^)]*\)/i, '').trim();
}

/** The switcher's choices: the LIVE runtime list when available (fetched from
 *  the Agent SDK's `supportedModels()` over IPC — same source as Claude Code's
 *  /model picker, so new models appear without an Orchestra release), else the
 *  static {@link MODEL_CHOICES} fallback (fresh app run, no session yet).
 *  Labels are re-derived via {@link versionedLabel} so cards read "Opus 5"
 *  rather than the runtime's "Opus" / "Opus (1M context)". The one row we keep
 *  verbatim is `default` ("Default (recommended)"), whose whole meaning is that
 *  it is the account default rather than a specific model. */
export function modelChoicesFrom(models: AgentModelInfo[] | undefined): ModelChoice[] {
  if (!models?.length) return MODEL_CHOICES;
  return models.map((m) => ({
    value: m.value,
    label: m.value === 'default' ? m.displayName : versionedLabel(m),
    description: m.description,
    resolvedModel: m.resolvedModel,
  }));
}

/** Split a model string into its base id and bracketed context suffix
 *  (`claude-opus-5[1m]` → base `claude-opus-5`, suffix `1m`). */
function splitContextSuffix(model: string): { base: string; suffix: string } {
  const m = /^(.*?)\[([^\]]+)\]$/.exec(model);
  return { base: (m ? m[1] : model).trim(), suffix: m ? m[2].trim() : '' };
}

/** Normalize a model string for comparison: strip the bracketed context suffix
 *  and map a short alias to its canonical id, so `opus`, `opus[1m]`,
 *  `claude-opus-5` and `claude-opus-5[1m]` all reduce to one key.
 *
 *  BOTH sides of a comparison must go through this. Normalizing only the model
 *  being matched (and not the card's own `value`/`resolvedModel`) was the
 *  0.5.165 bug: an explicit `claude-opus-5` never matched the live rows, whose
 *  `resolvedModel` is `claude-opus-5[1m]`, so the switcher prepended a
 *  redundant "Account default model" card and checkmarked THAT instead of the
 *  real "Opus (1M context)" row. */
function modelKey(model: string): string {
  const { base } = splitContextSuffix(model);
  const lower = base.toLowerCase();
  return MODEL_ALIASES[lower] ?? lower;
}

/** Whether a card covers a concrete model string — directly, via its resolved
 *  canonical id (live-list alias rows), via the static alias map, or with a
 *  context suffix stripped on EITHER side (`claude-opus-5` is covered by a row
 *  resolving to `claude-opus-5[1m]`, and vice versa). */
export function choiceCovers(choice: ModelChoice, model: string): boolean {
  if (!model) return false;
  const want = modelKey(model);
  if (modelKey(choice.value) === want) return true;
  return !!choice.resolvedModel && modelKey(choice.resolvedModel) === want;
}

/** The model the switcher should display, given the three candidate sources.
 *
 *  Precedence: live session (only once it has actually INITED) → persisted
 *  workspace choice → account default. The `inited` gate is the load-bearing
 *  part: a history-backfilled session (reopened workspace, no live subprocess)
 *  folds from `emptySession` with `model: ''` and NO `session/init` ever fires,
 *  and `session?.model ?? wsModel` does not fall through an empty string — so
 *  the placeholder masked a freshly-picked `ws.model` and selecting a model on
 *  a reopened workspace appeared to do nothing (the 0.5.153 bug). Only a live
 *  `session/init` sets `session.sessionId`, so that is the discriminator for
 *  "this session actually knows its model". */
export function effectiveModel(
  session: { sessionId: string; model: string } | undefined,
  wsModel: string | undefined,
  accountDefault: string,
): string {
  const live = session?.sessionId ? session.model : '';
  return live || wsModel || accountDefault || '';
}

/** Turn a raw model id/alias the switcher has no card for into a friendly label +
 *  description. Covers the common case where the account's default model is a
 *  context-suffixed alias or full id (e.g. `opus[1m]` or `claude-opus-5[1m]`):
 *  resolve the base (mapping short aliases like `opus`→`claude-opus-5`), reuse
 *  the matching {@link MODEL_CHOICES} label, and surface the suffix as a "1M
 *  context" note. The LABEL stays context-free by design — it names the model
 *  ("Opus 5"), and the context size rides in the DESCRIPTION line instead, where
 *  it informs without cluttering the trigger. Falls back to the raw value for
 *  anything unrecognized. */
export function describeLiveModel(
  model: string,
  choices: ModelChoice[] = MODEL_CHOICES,
): { label: string; description: string } {
  // Split off a bracketed context suffix like `[1m]` / `[200k]`.
  const { base: rawBase, suffix } = splitContextSuffix(model);
  const base = MODEL_ALIASES[rawBase.toLowerCase()] ?? rawBase;
  const ctx = suffix ? `${suffix.replace(/m$/i, 'M').replace(/k$/i, 'K')} context` : '';

  // Same both-sides normalization as choiceCovers — a card whose resolvedModel
  // carries a `[1m]` suffix must still match a suffix-free base, or the label
  // falls through to the raw id.
  const known = choices.find((i) => choiceCovers(i, base));
  if (known) {
    // Label is the model name ONLY — never "Opus 5 · 1M context".
    return { label: known.label, description: known.description };
  }
  return { label: model, description: ctx || 'Account default model' };
}
