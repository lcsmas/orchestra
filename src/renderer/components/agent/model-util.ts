// Pure model-switcher helpers for the structured agent view. Kept dependency-free
// (no React) so `node --test` can exercise them — AgentControls.tsx imports these
// and pairs each id with an icon/tint for the AvMenu cards.

/** A model the switcher offers as a card, minus the React icon. AgentControls
 *  zips these with icons/tints when building the AvMenu items. */
export interface ModelChoice {
  value: string;
  label: string;
  description: string;
}

/** Model choices offered in the switcher, newest/most-capable first. The live
 *  model is shown even when it's not in this list (see {@link describeLiveModel}) —
 *  e.g. the account default resolves to a context-suffixed variant like
 *  `claude-opus-4-8[1m]`. Ids are the canonical aliases (never date-suffixed). */
export const MODEL_CHOICES: ModelChoice[] = [
  { value: 'claude-fable-5', label: 'Fable 5', description: 'Most capable — hardest work' },
  { value: 'claude-opus-4-8', label: 'Opus 4.8', description: 'Highly capable — deep work' },
  { value: 'claude-sonnet-5', label: 'Sonnet 5', description: 'Balanced speed and depth' },
  { value: 'claude-haiku-4-5', label: 'Haiku 4.5', description: 'Fastest — light tasks' },
];

/** Claude Code's short model aliases → the canonical id we hold a card for.
 *  The account default is stored in `settings.json` as an alias (e.g. `opus[1m]`,
 *  `sonnet`), so a base of `opus` must resolve to `claude-opus-4-8` to reuse its
 *  card. Kept deliberately small — the exact 4.x mapping the CLI ships today. */
const MODEL_ALIASES: Record<string, string> = {
  opus: 'claude-opus-4-8',
  sonnet: 'claude-sonnet-5',
  haiku: 'claude-haiku-4-5',
  fable: 'claude-fable-5',
};

/** Turn a raw model id/alias the switcher has no card for into a friendly label +
 *  description. Covers the common case where the account's default model is a
 *  context-suffixed alias or full id (e.g. `opus[1m]` or `claude-opus-4-8[1m]`):
 *  resolve the base (mapping short aliases like `opus`→`claude-opus-4-8`), reuse
 *  the matching {@link MODEL_CHOICES} label, and surface the suffix as a "1M
 *  context" note — so the trigger reads "Opus 4.8 · 1M context" rather than the
 *  bare string. Falls back to the raw value for anything unrecognized. */
export function describeLiveModel(model: string): { label: string; description: string } {
  // Split off a bracketed context suffix like `[1m]` / `[200k]`.
  const m = /^(.*?)\[([^\]]+)\]$/.exec(model);
  const rawBase = (m ? m[1] : model).trim();
  const base = MODEL_ALIASES[rawBase.toLowerCase()] ?? rawBase;
  const suffix = m ? m[2].trim() : '';
  const ctx = suffix ? `${suffix.replace(/m$/i, 'M').replace(/k$/i, 'K')} context` : '';

  const known = MODEL_CHOICES.find((i) => i.value === base);
  if (known) {
    return { label: ctx ? `${known.label} · ${ctx}` : known.label, description: known.description };
  }
  return { label: model, description: ctx || 'Account default model' };
}
