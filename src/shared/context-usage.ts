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

import { contextWindowFromModelId } from './memory-size.ts';

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

/** One CLAUDE.md-family file loaded into the window. Both wire shapes agree on
 *  this row (`memory_files` / `memoryFiles`), field-for-field. */
export interface ContextMemoryFile {
  path: string;
  /** Display label of the source, e.g. "Project" or "User" — the producer's
   *  own wording, not an enum we own. */
  type: string;
  tokens: number;
}

/** One MCP tool schema counted against the window. `serverName` is what makes
 *  the panel groupable: a user reads "which SERVER is costing me", not which of
 *  its forty tools. */
export interface ContextMcpTool {
  name: string;
  serverName: string;
  tokens: number;
}

/** One skill's frontmatter loaded into the window.
 *
 *  NOTE the two producers disagree structurally here, which is why this is
 *  normalized rather than passed through: `/context` sends a FLAT ARRAY of
 *  these rows, while `getContextUsage()` sends an OBJECT
 *  (`{totalSkills, includedSkills, tokens, skillFrontmatter[]}`) with the rows
 *  nested under `skillFrontmatter`. Both adapters emit this flat row. */
export interface ContextSkill {
  name: string;
  /** Raw source identifier as the producer sends it, e.g. 'userSettings',
   *  'plugin', 'syncedSkills'. */
  source: string;
  tokens: number;
  /** Owning plugin, for `source: 'plugin'` rows. UNDECLARED in sdk.d.ts 0.3.241
   *  but genuinely sent by the runtime — verified on a live capture at CLI
   *  2.1.241, where 23 of 50 skill rows carried it
   *  (`{name:'slack:channel-digest', source:'plugin', pluginName:'slack'}`).
   *
   *  Kept because it is the ONLY disambiguator between same-named skills from
   *  different plugins. Today's payloads happen not to collide (plugin skills
   *  carry a `slack:` prefix inside `name`), so dropping it renders nothing
   *  wrong YET — which is exactly why it needs carrying now rather than after a
   *  plugin ships a bare colliding name. Optional: non-plugin rows omit it. */
  pluginName?: string;
}

/** One subagent definition counted against the window. Same structural
 *  divergence as skills: `agent_type` on the command shape, `agentType` on the
 *  live one. */
export interface ContextAgent {
  agentType: string;
  source: string;
  tokens: number;
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
  /** Memory files (CLAUDE.md family) loaded into the window. Absent for the
   *  transcript source, and absent when the producer sent an empty list —
   *  a breakdown renderer treats absent and empty identically (show nothing). */
  memoryFiles?: ContextMemoryFile[];
  /** MCP tool schemas counted against the window. */
  mcpTools?: ContextMcpTool[];
  /** Skill frontmatter loaded into the window. */
  skills?: ContextSkill[];
  /** Subagent definitions loaded into the window. */
  agents?: ContextAgent[];
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
  memoryFiles?: unknown;
  mcpTools?: unknown;
  /** OBJECT on this shape: `{totalSkills, includedSkills, tokens,
   *  skillFrontmatter[]}` — not the flat array `/context` sends. */
  skills?: unknown;
  agents?: unknown;
}

/** The snake_case `context_usage` payload the CLI stamps on a `/context`
 *  result's synthetic assistant message. */
export interface ContextCommandUsagePayload {
  total_tokens?: unknown;
  raw_max_tokens?: unknown;
  model?: unknown;
  categories?: unknown;
  memory_files?: unknown;
  mcp_tools?: unknown;
  /** FLAT ARRAY on this shape — see {@link ContextSkill}. */
  skills?: unknown;
  agents?: unknown;
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

/** Map a detail list from either wire shape via a per-row reader.
 *
 *  Rows that don't produce every required field are DROPPED rather than
 *  defaulted: a memory file with no path or a tool with no token count is not
 *  something the panel can render honestly, and a `0`/`''` placeholder would
 *  read as a measured value.
 *
 *  EMPTY vs ABSENT is preserved (issue #31): a producer that sends `agents: []`
 *  is saying "asked, none configured", which is different from omitting the key
 *  ("this CLI does not report agents at all"). Verified on a live capture at
 *  CLI 2.1.241: `agents` arrives as `[]` while `systemTools`,
 *  `deferredBuiltinTools` and `systemPromptSections` are absent entirely — two
 *  genuinely different facts that this function used to flatten into
 *  `undefined`.
 *
 *  NOTHING CURRENTLY BEHAVES DIFFERENTLY on the distinction, and that is stated
 *  rather than implied: every consumer does `?? []` and `hasBreakdown` tests
 *  `.length`, which is falsy for both. It is preserved because destroying
 *  information at a wire boundary is how a later question ("does this CLI
 *  report agents?") becomes unanswerable, not because a renderer reads it
 *  today. Junk-only input still collapses to `undefined` — that is a parse
 *  failure, not a producer statement. */
function mapRows<T>(raw: unknown, read: (row: Record<string, unknown>) => T | null): T[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: T[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const mapped = read(item as Record<string, unknown>);
    if (mapped) out.push(mapped);
  }
  // An empty INPUT array is a real answer; an array whose every row failed to
  // parse is not.
  if (!out.length) return raw.length === 0 ? ([] as T[]) : undefined;
  return out;
}

function mapMemoryFiles(raw: unknown): ContextMemoryFile[] | undefined {
  return mapRows(raw, (r) => {
    const path = str(r.path);
    const tokens = num(r.tokens);
    if (!path || tokens == null) return null;
    return { path, type: str(r.type) ?? '', tokens };
  });
}

/** Both shapes name the server differently (`server_name` vs `serverName`), so
 *  read both rather than writing two near-identical mappers. */
function mapMcpTools(raw: unknown): ContextMcpTool[] | undefined {
  return mapRows(raw, (r) => {
    const name = str(r.name);
    const tokens = num(r.tokens);
    if (!name || tokens == null) return null;
    return { name, serverName: str(r.serverName) ?? str(r.server_name) ?? '', tokens };
  });
}

/** Skills need a shape sniff, not just a key alias: `/context` sends the flat
 *  array while `getContextUsage()` nests the same rows under an object's
 *  `skillFrontmatter`. Unwrap the object form, then map identically. */
function mapSkills(raw: unknown): ContextSkill[] | undefined {
  const rows = Array.isArray(raw)
    ? raw
    : raw && typeof raw === 'object'
      ? (raw as { skillFrontmatter?: unknown }).skillFrontmatter
      : undefined;
  return mapRows(rows, (r) => {
    const name = str(r.name);
    const tokens = num(r.tokens);
    if (!name || tokens == null) return null;
    // `pluginName` is read off the wire, NOT off the .d.ts — typing this adapter
    // from the declarations is precisely how the field was lost (issue #31).
    const pluginName = str(r.pluginName);
    return pluginName ? { name, source: str(r.source) ?? '', tokens, pluginName }
                      : { name, source: str(r.source) ?? '', tokens };
  });
}

function mapAgents(raw: unknown): ContextAgent[] | undefined {
  return mapRows(raw, (r) => {
    const agentType = str(r.agentType) ?? str(r.agent_type);
    const tokens = num(r.tokens);
    if (!agentType || tokens == null) return null;
    return { agentType, source: str(r.source) ?? '', tokens };
  });
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
    memoryFiles: mapMemoryFiles(payload.memoryFiles),
    mcpTools: mapMcpTools(payload.mcpTools),
    skills: mapSkills(payload.skills),
    agents: mapAgents(payload.agents),
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
    memoryFiles: mapMemoryFiles(payload.memory_files),
    mcpTools: mapMcpTools(payload.mcp_tools),
    skills: mapSkills(payload.skills),
    agents: mapAgents(payload.agents),
    source: 'context-command',
    at,
  };
}

/** Context window for a transcript reading, or `null` when it is genuinely
 *  unknown.
 *
 *  THE RULE (final, audit ruling): never invent a default window. A percentage
 *  computed against a window nobody chose is a fabricated number, and a
 *  confidently wrong percentage is worse than no percentage — nobody re-checks
 *  a figure that looks plausible. When the window is unknown the gauge renders
 *  the ABSOLUTE TOKEN COUNT instead, which is true.
 *
 *  Measured, which is why this is not a judgement call:
 *   - The transcript records NO window: `message.context_management` is ABSENT
 *     on all 1,543 main-chain assistant lines scanned across the largest real
 *     local transcripts.
 *   - `message.model` carries only the BASE id (`claude-opus-4-8`), never the
 *     `[1m]` alias — so a real 1M session read 251% against an assumed 200k
 *     when it was actually 50% full. That is the lie this rule kills.
 *   - 17 of 29 workspaces in the real store have NO model set at all, so a
 *     default would be pure guesswork for the majority of them.
 *
 *  The ONE case that yields a real window is a model id explicitly carrying
 *  `[1m]` (`opus[1m]`, `claude-fable-5[1m]` — live values in the store): that is
 *  a POSITIVE signal about the window, not an assumption, so it is honoured.
 *  Everything else returns null and renders as tokens.
 */
export function transcriptContextWindow(model?: string | null): number | null {
  return contextWindowFromModelId(model);
}

/** Wrap a transcript-derived token count as a {@link ContextUsage}, against the
 *  window implied by the transcript's model id (see
 *  {@link transcriptContextWindow}).
 *
 *  Keeps the fallback path in the same currency as the live path so the gauge
 *  has ONE input type and a detached/history pane renders a real percentage. */
export function contextUsageFromTranscript(
  tokens: number,
  at: number,
  model?: string | null,
): ContextUsage {
  // null unless the model id positively states a 1M window — see above.
  const maxTokens = transcriptContextWindow(model);
  return {
    totalTokens: tokens,
    maxTokens,
    percentage: computePercentage(tokens, maxTokens),
    model: str(model),
    source: 'transcript',
    at,
  };
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

/** Everything the context gauge needs to paint one frame — the WHOLE render
 *  decision, resolved in pure code.
 *
 *  WHY THIS EXISTS (structural fix, not a convenience): the visibility decision
 *  used to live inside the React component, where the unit suite could not
 *  reach it. Re-adding a `if (!window) return null` early return there — which
 *  reverts the behaviour detached sessions depend on — left all 844 unit tests
 *  GREEN while the gauge vanished in the built app, because `node --test` does
 *  not transform JSX and never renders the component. A decision no test can
 *  execute is a decision that regresses silently.
 *
 *  So the component now renders this object and makes no decisions of its own:
 *  whether to show at all (`null`), what to print, the threshold level, and the
 *  bar width are all gated by the existing unit seam.
 *
 *  Returns `null` when there is nothing to show. */
/** Does this reading carry anything a breakdown panel could show?
 *
 *  The transcript source never does (it has a token count and nothing else), so
 *  this is what the gauge gates its "click for detail" affordance on — the
 *  issue's "degrade gracefully: no empty panel" requirement. Checked on
 *  CONTENT, not on `source`: a live reading from a CLI that returned no
 *  categories must also degrade, and a future source that does carry a
 *  breakdown gets the panel for free. */
export function hasBreakdown(usage: ContextUsage | undefined): boolean {
  if (!usage) return false;
  return !!(
    usage.categories?.some((c) => c.tokens > 0) ||
    usage.memoryFiles?.length ||
    usage.mcpTools?.length ||
    usage.skills?.length ||
    usage.agents?.length
  );
}

export interface ContextGaugeView {
  /** What the value reads: a percentage when the window is known, otherwise the
   *  absolute token count — never a percentage against an invented window. */
  label: string;
  /** Threshold styling: quiet below 75%, amber from 75%, red from 90%. Always
   *  `ok` when no percentage exists — an unknown-window reading cannot be
   *  "critical", and colouring it red would imply a measurement we do not have. */
  level: 'ok' | 'low' | 'critical';
  /** Bar fill 0-100. CLAMPED, unlike the label: a fill cannot exceed its track,
   *  but an over-limit session must still READ past 100% (see below). 0 when the
   *  window is unknown — there is no track position to represent. */
  fillPct: number;
  /** Hover text, self-contained so a stale tooltip cannot imply a window we
   *  never measured. */
  title: string;
  /** Which producer fed this frame, mirrored to `data-context-source` so a
   *  driver can assert provenance rather than infer it from the number. */
  source: ContextUsageSource;
  /** Whether this reading carries a by-category/detail breakdown worth opening
   *  a panel for (#16). The renderer turns the gauge into a button only when
   *  this is true; otherwise it stays the static readout it was before #16.
   *
   *  Decided HERE rather than in the component on purpose: this file's own note
   *  says a decision the unit suite cannot execute regresses silently (the
   *  null-window branch did exactly that, green tests and a vanished gauge), and
   *  `node --test` never runs the JSX. So the panel's show/hide lives in the
   *  pure layer where a test can reach it.
   *
   *  Gated on CONTENT, not on `source`: a live reading whose categories all came
   *  back zero has nothing to show and must degrade like the transcript path. */
  expandable: boolean;
}

/** Format a token count the way the gauge prints it (k/M), mirroring the
 *  renderer's own formatter so the pure layer and the component agree. */
function formatTokensShort(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) {
    const k = n / 1000;
    return `${k < 10 ? k.toFixed(1) : Math.round(k)}k`;
  }
  const m = n / 1_000_000;
  return `${m < 10 ? m.toFixed(1) : Math.round(m)}M`;
}

export function describeContextGauge(
  usage: ContextUsage | undefined,
  turn: TurnEndContextFields | undefined,
): ContextGaugeView | null {
  const resolved = resolveContextUsage(usage, turn);
  if (!resolved) return null;
  const used = resolved.totalTokens;
  const window = resolved.maxTokens;
  const pct = resolved.percentage;
  // NOTE the asymmetry, and that it is deliberate: the NUMBER is unclamped so an
  // over-limit session reads e.g. 110% — precisely the state the gauge exists to
  // warn about — while the BAR clamps, because a fill cannot exceed its track.
  const usedPct = pct == null ? null : Math.max(0, pct);
  const fillPct = pct == null ? 0 : Math.max(0, Math.min(100, pct));
  const level: ContextGaugeView['level'] =
    usedPct == null ? 'ok' : usedPct >= 90 ? 'critical' : usedPct >= 75 ? 'low' : 'ok';
  return {
    label: usedPct == null ? formatTokensShort(used) : `${usedPct}%`,
    level,
    fillPct,
    title:
      window != null && window > 0
        ? `Context: ${formatTokensShort(used)} of ${formatTokensShort(window)} tokens in use${
            level !== 'ok' ? ' — consider /compact' : ''
          }`
        : `Context: ${formatTokensShort(used)} tokens in use (window size unknown — no live session to ask)`,
    source: resolved.source,
    // Read off the ORIGINAL `usage`, not `resolved`: the turn-end inference has
    // no categories at all, so a breakdown can only ever come from an emitted
    // reading. `hasBreakdown` is the single definition of "is there anything to
    // show" — see context-breakdown.ts.
    expandable: hasBreakdown(usage),
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
