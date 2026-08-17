// Pure helpers (no electron imports) so they stay testable under `node --test`.

/**
 * Oversized-memory-file detection — an Orchestra-side REPLICA of a warning the
 * Claude Code CLI shows in its startup banner but never puts on the wire.
 *
 * ## Why this is a replica and not a subscription
 *
 * The CLI's notice registry entry `large-memory-files` renders
 *
 *     <path> is over the 150.0k-char limit (187.7k chars) · /memory to free up context
 *
 * into the Ink REPL header. It is terminal-only: verified against the compiled
 * binary at `~/.local/share/claude/versions/2.1.233` (GIT_SHA f8d5756, built
 * 2026-08-14), where the registry is consumed solely by the REPL header
 * renderer and the `/status` doctor panel. Nothing forwards it to the
 * stream-json channel — `subtype:"warning"` does not occur in the binary at
 * all, and the `system/init` payload carries `memory_paths` (bare paths) with
 * no sizes and no over-limit flag. So a structured-view session CANNOT observe
 * this warning; to show it, Orchestra has to recompute it.
 *
 * ## Drift risk — what to re-check when this looks wrong
 *
 * Everything below is derived from that specific CLI build. If Anthropic
 * changes any of it, our banner silently disagrees with the CLI's:
 *   - the 5% fraction ({@link CONTEXT_FRACTION}),
 *   - the chars-per-token estimate ({@link CHARS_PER_TOKEN}, 3 for current
 *     models — the binary still maps a few older ids to 4),
 *   - the 40k floor ({@link MIN_LIMIT_CHARS}),
 *   - which memory TYPES count (User/Project/Local/Managed; AutoMem is exempt).
 * The CLI computes it as `max(40000, round(contextWindow * 0.05 * charsPerToken))`.
 * Re-derive by grepping a current binary for `large-memory-files`.
 */

/** Fraction of the model's context window a memory file may occupy before the
 *  CLI warns. `nsv` in the 2.1.233 binary. */
export const CONTEXT_FRACTION = 0.05;

/** Chars-per-token estimate used to turn the token budget into a char budget.
 *  `YA()` returns 4 for a small set of legacy model ids and 3 for everything
 *  current; we use 3 because every model Orchestra runs is in the latter set. */
export const CHARS_PER_TOKEN = 3;

/** Absolute floor on the limit regardless of context window (`osv`). Below a
 *  ~800k-token window the fraction is smaller than this, so the floor governs. */
export const MIN_LIMIT_CHARS = 40_000;

/** Context window assumed when the session hasn't reported one yet (`pkr`).
 *  The SDK only reports the real window on `result` messages, i.e. after the
 *  first turn — see `contextWindowFrom` in agent-events.ts. */
export const DEFAULT_CONTEXT_WINDOW = 200_000;

/**
 * The char limit for a single memory file, given the model's context window in
 * tokens. Mirrors `$Ln()`. Pass `null`/`undefined` before the window is known
 * and the CLI's own fallback (200k tokens → the 40k floor) applies.
 */
export function memoryCharLimit(contextWindowTokens?: number | null): number {
  const tokens =
    typeof contextWindowTokens === 'number' && Number.isFinite(contextWindowTokens) && contextWindowTokens > 0
      ? contextWindowTokens
      : DEFAULT_CONTEXT_WINDOW;
  return Math.max(MIN_LIMIT_CHARS, Math.round(tokens * CONTEXT_FRACTION * CHARS_PER_TOKEN));
}

/** Context window implied by a model id carrying the `[1m]` long-context marker
 *  (e.g. `claude-opus-4-8[1m]`). The SDK reports a real `contextWindow` only on
 *  `result` messages — i.e. after the first turn — but the banner belongs at
 *  init, and the alias is the one context signal available that early. Returns
 *  null when the id says nothing, so callers fall back to the CLI's default. */
export function contextWindowFromModelId(model?: string | null): number | null {
  if (typeof model !== 'string' || !model) return null;
  return /\[1m\]/i.test(model) ? 1_000_000 : null;
}

/** A memory file measured against the limit. `chars` is the FULLY RESOLVED
 *  size — imports expanded — because that is what the CLI counts. */
export interface MemoryFileSize {
  /** Absolute path to the memory file. */
  path: string;
  /** Resolved content length in characters (imports inlined). */
  chars: number;
}

/** One file that exceeds the limit, ready to render. */
export interface OversizedMemoryFile extends MemoryFileSize {
  /** The limit it exceeded, in chars — carried so the message is self-contained
   *  and a stale banner can't imply a limit that has since changed. */
  limit: number;
}

/** Select the memory files over the limit. Callers pass sizes they measured;
 *  this module never touches the filesystem (it must stay `node --test`-able). */
export function oversizedMemoryFiles(
  files: readonly MemoryFileSize[],
  contextWindowTokens?: number | null,
): OversizedMemoryFile[] {
  const limit = memoryCharLimit(contextWindowTokens);
  return files.filter((f) => f.chars > limit).map((f) => ({ ...f, limit }));
}

/** Compact char count the way the CLI's `zp()` does — `en-US` compact notation,
 *  lowercased: 150000 -> "150k", 187700 -> "188k". Note the CLI renders the
 *  LIMIT as "150.0k" (one fraction digit) and the SIZE as a plain compact
 *  figure; we match that split so the two numbers read like the terminal's. */
export function formatChars(n: number): string {
  return new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 })
    .format(n)
    .toLowerCase();
}

/** Render the limit with a forced fraction digit, matching the CLI's "150.0k". */
export function formatLimit(n: number): string {
  return new Intl.NumberFormat('en-US', {
    notation: 'compact',
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  })
    .format(n)
    .toLowerCase();
}

/**
 * The banner line for one oversized file. `displayPath` lets the caller shorten
 * an absolute path (the CLI relativizes against cwd); we keep that decision out
 * of here so this stays pure.
 */
export function oversizedMemoryText(file: OversizedMemoryFile, displayPath = file.path): string {
  return `${displayPath} is over the ${formatLimit(file.limit)}-char limit (${formatChars(file.chars)} chars)`;
}
