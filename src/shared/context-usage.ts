// Context-window usage — one normalized shape from three different sources.
//
// The context gauge answers "how full is this agent's context window?". FOUR
// producers can answer it, in descending order of authority (the tag on each
// reading, `ContextUsage.source`, names which one did — provenance is readable
// rather than inferred from the number):
//
//   1. `Query.getContextUsage()` — the live SDK control request. The CLI's OWN
//      accounting, the same figure its `/context` view renders. Available the
//      moment a session has bootstrapped (before any turn has run), so it seeds
//      the gauge at pane mount rather than waiting for a turn to end.
//   2. The `context_usage` field the CLI stamps on the synthetic assistant
//      message a `/context` slash command produces. Same numbers as (1), but a
//      DIFFERENT wire shape (snake_case, and a `kind` enum where (1) uses a
//      boolean flag) — so it needs its own adapter, not a cast.
//   3. The transcript-JSONL recompute (`activity.ts computeContextTokens`),
//      which sums the input components of the last main-chain assistant turn.
//      An INFERENCE from what the API billed, not the CLI's own figure — but
//      the only source that works with no live `Query` at all (detached keeper
//      sessions, history panes, PTY-driven agents).
//
//   4. `turn-end` — the per-turn inference on `AgentTurnEndEvent`
//      (`contextUsedTokens`/`contextWindow`), derived from what the last API
//      call billed. Never emitted as an event: it is synthesized at read time
//      by `resolveContextUsage` when nothing better is on the session. Weakest,
//      and the reason the others exist — its window is null on many turns.
//
// (1) and (2) are structurally near-identical and trivially convertible; (3)
// and (4) yield only a token count (and, for (4), sometimes a window). So the normalized shape below carries the token
// total as its REQUIRED core and the category breakdown as OPTIONAL — a gauge
// can always render, and a richer breakdown appears when the source had one.
//
// Why this module is pure and lives in src/shared: the adapters are where the
// two wire shapes' divergences get reconciled (the deferred-token rule below is
// a real semantic trap), and that reconciliation is exactly the logic worth
// unit-testing without booting Electron or an SDK subprocess.

/** Where a {@link ContextUsage} came from. Rendered as provenance and used to
 *  decide precedence: a `live` reading always supersedes a `transcript` one for
 *  the same workspace, never the reverse (see {@link isMoreAuthoritative}). */
export type ContextUsageSource = 'live' | 'context-command' | 'transcript' | 'turn-end';

/** One row of the by-category breakdown, normalized across both SDK shapes.
 *
 *  `kind` — NOT the display `name` — is what classifies a row; the CLI's names
 *  are presentation strings that have changed between versions. */
export interface ContextUsageCategory {
  /** Display label as the producer rendered it, e.g. "Memory files". */
  name: string;
  tokens: number;
  /** `used` occupies the window; `free` is what remains; `buffer` is the
   *  compaction reserve; `deferred` rows are out-of-window tool schemas listed
   *  for awareness only — see {@link isDeferredCategory}. */
  kind: 'used' | 'free' | 'buffer' | 'deferred';
}

/** A context-window reading, normalized from any of the three sources. */
export interface ContextUsage {
  /** Tokens in use. Unclamped: MAY exceed {@link maxTokens} when the session is
   *  over its window (the CLI reports the true figure rather than pinning it). */
  totalTokens: number;
  /** The window the usage is measured against — the resolved autocompact
   *  window, which is not always the model's hard limit. `null` when the source
   *  could not report one (the transcript recompute knows tokens, not limits). */
  maxTokens: number | null;
  /** Rounded percentage of the window in use, 0–100+, or `null` when
   *  {@link maxTokens} is unknown. Derived, never trusted from the wire — see
   *  {@link computePercentage} for why. */
  percentage: number | null;
  /** Model the figure was computed for, when the source reported one. */
  model?: string;
  /** By-category breakdown. Absent for the transcript source, which has none. */
  categories?: ContextUsageCategory[];
  source: ContextUsageSource;
  /** Epoch ms this reading was taken, so a stale one can be superseded. */
  at: number;
}

/** Deferred rows are tool schemas held OUT of the context window — listed so a
 *  user can see what would cost them if loaded, but explicitly "excluded from
 *  usage math" (SDK's own words on `SDKContextUsageCategory.kind`).
 *
 *  This is the one trap in normalizing these payloads: summing every category's
 *  tokens overstates usage, sometimes by tens of thousands (a big MCP server's
 *  deferred schemas alone ran ~52K in the verified capture). We never sum
 *  categories to get a total — the producer's own `totalTokens`/`total_tokens`
 *  already excludes them — but a renderer drawing segments MUST skip these, so
 *  the predicate is exported rather than left implicit at each call site. */
export function isDeferredCategory(c: ContextUsageCategory): boolean {
  return c.kind === 'deferred';
}

/** Tokens that actually occupy the window: `used` rows only.
 *
 *  Deliberately excludes `free` (the remainder), `buffer` (compaction reserve)
 *  and `deferred` (out-of-window). Provided for a breakdown renderer that needs
 *  segment widths; the authoritative total remains {@link ContextUsage.totalTokens},
 *  which comes straight from the producer. */
export function usedTokens(categories: readonly ContextUsageCategory[]): number {
  return categories.reduce((sum, c) => (c.kind === 'used' ? sum + c.tokens : sum), 0);
}

/** Percentage of the window in use, rounded, or `null` when the window is
 *  unknown or non-positive.
 *
 *  We recompute rather than trusting the producer's `percentage` field so that
 *  all three sources are consistent: the transcript source has no percentage at
 *  all, and a reading whose percentage disagreed with its own tokens/max would
 *  make the gauge's number and its fill disagree. Not clamped to 100 — an
 *  over-limit session genuinely reads >100% and the gauge should show that
 *  rather than silently pinning to full. */
export function computePercentage(totalTokens: number, maxTokens: number | null): number | null {
  if (maxTokens == null || maxTokens <= 0) return null;
  return Math.round((totalTokens / maxTokens) * 100);
}

/** The camelCase payload returned by `Query.getContextUsage()`.
 *
 *  Structurally typed rather than imported from the SDK: this module is pure
 *  and must stay importable by the renderer and by `node --test` without
 *  pulling the SDK in, and the runtime payload carries fields the .d.ts does
 *  not declare anyway (verified: `autocompactSource`). Only the fields we
 *  actually consume are declared; everything else passes through ignored. */
export interface LiveContextUsagePayload {
  totalTokens?: unknown;
  maxTokens?: unknown;
  rawMaxTokens?: unknown;
  model?: unknown;
  categories?: unknown;
}

/** The snake_case `context_usage` payload the CLI stamps on a `/context`
 *  result's synthetic assistant message. */
export interface ContextCommandUsagePayload {
  total_tokens?: unknown;
  raw_max_tokens?: unknown;
  model?: unknown;
  categories?: unknown;
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v ? v : undefined;
}

/** Map the LIVE payload's category rows, whose classification is a boolean
 *  `isDeferred` plus a `color` — there is no `kind` enum on this shape.
 *
 *  The colors are TUI presentation ('promptBorder' for free space, etc.), so we
 *  classify on the two things that are semantic: `isDeferred`, and the fact
 *  that the free-space row is the one the CLI names "Free space". That name
 *  match is a documented fragility — if it drifts, the row degrades to `used`,
 *  which overstates usage in a BREAKDOWN but never affects the headline number
 *  (that comes from `totalTokens`, not from summing rows). */
function mapLiveCategories(raw: unknown): ContextUsageCategory[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: ContextUsageCategory[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const c = item as { name?: unknown; tokens?: unknown; isDeferred?: unknown };
    const tokens = num(c.tokens);
    const name = str(c.name);
    if (tokens == null || name == null) continue;
    const kind: ContextUsageCategory['kind'] = c.isDeferred === true
      ? 'deferred'
      : name === 'Free space'
        ? 'free'
        : 'used';
    out.push({ name, tokens, kind });
  }
  return out.length ? out : undefined;
}

/** Map the `/context` payload's rows, which already carry the `kind` enum. An
 *  unrecognized kind degrades to `used` rather than dropping the row, so a
 *  future CLI adding a category still contributes to the breakdown. */
function mapCommandCategories(raw: unknown): ContextUsageCategory[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: ContextUsageCategory[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const c = item as { name?: unknown; tokens?: unknown; kind?: unknown };
    const tokens = num(c.tokens);
    const name = str(c.name);
    if (tokens == null || name == null) continue;
    const k = c.kind;
    const kind: ContextUsageCategory['kind'] =
      k === 'free' || k === 'buffer' || k === 'deferred' ? k : 'used';
    out.push({ name, tokens, kind });
  }
  return out.length ? out : undefined;
}

/** Normalize a `Query.getContextUsage()` response.
 *
 *  Returns `null` when the payload carries no usable token total — a wedged or
 *  version-skewed CLI returning a shape we don't understand must fall back to
 *  the transcript source, not render a zeroed gauge (0 is the app's "context
 *  was reset" sentinel and would wrongly clear the badge).
 *
 *  Window preference: `rawMaxTokens` over `maxTokens`. Both are present on the
 *  live shape; `rawMaxTokens` is the resolved autocompact window, which is the
 *  denominator the CLI's own percentage uses and the one `/context` reports as
 *  `raw_max_tokens` — so preferring it keeps sources (1) and (2) numerically
 *  identical instead of drifting by whatever compaction reserve `maxTokens`
 *  has already subtracted. */
export function normalizeLiveContextUsage(
  payload: LiveContextUsagePayload | null | undefined,
  at: number,
): ContextUsage | null {
  if (!payload || typeof payload !== 'object') return null;
  const totalTokens = num(payload.totalTokens);
  if (totalTokens == null) return null;
  const maxTokens = num(payload.rawMaxTokens) ?? num(payload.maxTokens);
  return {
    totalTokens,
    maxTokens,
    percentage: computePercentage(totalTokens, maxTokens),
    model: str(payload.model),
    categories: mapLiveCategories(payload.categories),
    source: 'live',
    at,
  };
}

/** Normalize the `context_usage` field carried on a `/context` result. Same
 *  contract as {@link normalizeLiveContextUsage}, different wire casing. */
export function normalizeContextCommandUsage(
  payload: ContextCommandUsagePayload | null | undefined,
  at: number,
): ContextUsage | null {
  if (!payload || typeof payload !== 'object') return null;
  const totalTokens = num(payload.total_tokens);
  if (totalTokens == null) return null;
  const maxTokens = num(payload.raw_max_tokens);
  return {
    totalTokens,
    maxTokens,
    percentage: computePercentage(totalTokens, maxTokens),
    model: str(payload.model),
    categories: mapCommandCategories(payload.categories),
    source: 'context-command',
    at,
  };
}

/** Wrap a bare transcript-derived token count as a {@link ContextUsage}.
 *
 *  Keeps the fallback path in the same currency as the live path so the gauge
 *  has ONE input type. `maxTokens` is null by design: the transcript says how
 *  many tokens the last turn fed in, never what the window was — inventing a
 *  200K default here would fabricate a percentage the source cannot support. */
export function contextUsageFromTranscript(tokens: number, at: number): ContextUsage {
  return { totalTokens: tokens, maxTokens: null, percentage: null, source: 'transcript', at };
}

/** The three input components that make up a Claude Code turn's context, as
 *  they appear in a transcript line's `usage`. Output tokens are deliberately
 *  absent: they are what the model PRODUCED, not what was fed back in. */
export interface TranscriptUsage {
  input_tokens?: unknown;
  cache_creation_input_tokens?: unknown;
  cache_read_input_tokens?: unknown;
}

/** Context size implied by one transcript assistant line's `usage` — the sum of
 *  fresh input, cache writes and cache reads.
 *
 *  This is the SAME formula as `activity.ts computeContextTokens`, kept here in
 *  pure form so the history-replay path can reach it without file I/O (that one
 *  reads the transcript tail off disk; this one is handed an already-parsed
 *  line). Deliberately NOT deduplicated into one shared call: the two run in
 *  different processes over different inputs, and the note below is the thing
 *  that keeps them honest.
 *
 *  Returns 0 when no component is present, so a caller can treat 0 as "this
 *  line carries no usable usage" — the same three-valued contract the on-disk
 *  recompute uses. */
export function transcriptContextTokens(usage: TranscriptUsage | null | undefined): number {
  if (!usage || typeof usage !== 'object') return 0;
  const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  return (
    n(usage.input_tokens) + n(usage.cache_creation_input_tokens) + n(usage.cache_read_input_tokens)
  );
}

/** The per-turn figures the gauge falls back to when no reading has been
 *  emitted — `AgentTurnEndEvent`'s inferred pair. */
export interface TurnEndContextFields {
  contextUsedTokens?: number | null;
  contextWindow?: number | null;
}

/** Resolve what the context gauge should display, from the two things a folded
 *  session can offer: an emitted {@link ContextUsage} (live / `/context` /
 *  transcript) or the inferred per-turn fields.
 *
 *  Exists so the gauge's sourcing decision is ONE testable function rather than
 *  inline ternaries in a component, and — the reason it returns a tagged
 *  `ContextUsage` rather than a bare pair — so the RESOLVED source is readable
 *  from outside. A verifier driving the app can then assert WHICH producer fed
 *  the gauge instead of inferring it from a rendered number, which a fabricated
 *  turn-end would make indistinguishable from a real live reading.
 *
 *  Returns null when there is nothing to show. */
export function resolveContextUsage(
  usage: ContextUsage | undefined,
  turn: TurnEndContextFields | undefined,
): ContextUsage | null {
  if (usage) return usage;
  const totalTokens = turn?.contextUsedTokens;
  if (typeof totalTokens !== 'number' || !Number.isFinite(totalTokens) || totalTokens <= 0) {
    return null;
  }
  const w = turn?.contextWindow;
  const maxTokens = typeof w === 'number' && Number.isFinite(w) && w > 0 ? w : null;
  return {
    totalTokens,
    maxTokens,
    percentage: computePercentage(totalTokens, maxTokens),
    source: 'turn-end',
    // Synthesized at read time from an already-folded turn, so it carries no
    // independent timestamp of its own.
    at: 0,
  };
}

/** Rank a source's authority. Live SDK readings are the CLI's own accounting;
 *  the transcript recompute is an inference from billing data. */
function sourceRank(source: ContextUsageSource): number {
  switch (source) {
    case 'live':
      return 3;
    case 'context-command':
      return 2;
    case 'transcript':
      return 1;
    // Weakest: inferred from what the last API call billed, and only exists
    // once a turn has closed. Never emitted as an event — it is synthesized by
    // the gauge when nothing better is on the session (see resolveContextUsage).
    case 'turn-end':
      return 0;
  }
}

/** Should `next` replace `prev` as the workspace's current reading?
 *
 *  The rule that matters: a LOWER-authority reading never overwrites a
 *  higher-authority one that is still current. Both producers fire
 *  independently — the transcript recompute runs off shell hooks on every
 *  posttool while the live reading is taken per turn — so without this gate a
 *  posttool's inferred figure would clobber the CLI's exact one moments after
 *  it landed, and the gauge would visibly flip between two numbers.
 *
 *  It is NOT a permanent lock: a stale higher-authority reading yields to a
 *  fresher lower one after {@link STALE_MS}, so a session whose SDK query has
 *  gone away (keeper detach, subprocess death) still updates from the
 *  transcript instead of freezing on its last live figure forever.
 *
 *  Equal authority always takes the newer reading. */
export const STALE_MS = 60_000;

export function isMoreAuthoritative(
  next: ContextUsage,
  prev: ContextUsage | undefined,
  staleMs: number = STALE_MS,
): boolean {
  if (!prev) return true;
  const nextRank = sourceRank(next.source);
  const prevRank = sourceRank(prev.source);
  // Strictly stronger source: always wins, even if its reading is older. The
  // two producers are independent and unsynchronized, so a transcript sample
  // taken after a live one is not thereby better information — it is a weaker
  // instrument that happened to report second. Gating on recency here is what
  // let a posttool suppress the CLI's own figure.
  if (nextRank > prevRank) return true;
  // Same source: newer wins.
  if (nextRank === prevRank) return next.at >= prev.at;
  // next is weaker: accept it only once prev has gone stale.
  return next.at - prev.at > staleMs;
}
