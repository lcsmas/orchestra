// Render model for the context-gauge breakdown panel (issue #16).
//
// The panel answers "what is filling my context window?" — a per-category token
// split plus the three detail lists the CLI reports (memory files, MCP tools,
// skills). This module turns a {@link ContextUsage} into exactly what the panel
// draws and nothing more: ordered rows, percentages, grouped MCP servers, and
// truncated lists. It is pure and lives in src/shared so the decisions that are
// actually easy to get wrong — which rows count toward the bar, what a
// percentage is measured AGAINST, how a list truncates — are unit-testable
// without mounting React or booting the SDK.
//
// The one rule inherited from context-usage.ts and re-asserted here: NEVER sum
// categories to get a total. `deferred` rows are out-of-window tool schemas the
// producer explicitly excludes from usage math (they ran ~52K in the verified
// capture, against a 200K window). The headline number is always the
// producer's own `totalTokens`; this module's percentages are shares OF that
// window, computed per row, never a normalized share of a summed denominator.

import {
  hasBreakdown,
  isDeferredCategory,
  type ContextUsage,
  type ContextUsageCategory,
  type ContextMcpTool,
  type ContextMemoryFile,
  type ContextSkill,
  type ContextAgent,
} from './context-usage.ts';

// NOTE FOR ANYONE DRIVING THIS WITH HAND-BUILT FIXTURES: a
// `ContextUsageCategory` REQUIRES its `kind` ('used' | 'free' | 'buffer' |
// 'deferred'). Rows missing it are dropped as malformed, so an injected payload
// of `{name, tokens}` rows renders an EMPTY panel — 0 segments, 0 legend rows —
// which reads exactly like "the breakdown UI is broken" and is not. The
// verifier's first E2E run hit precisely this and nearly filed a defect against
// working code; the cost is a wasted investigation, so it is cheaper to say so
// here than to re-derive it. Real producer payloads always carry `kind` (the
// `/context` wire shape sends it directly; the live shape's `isDeferred`
// boolean is mapped to it in context-usage.ts).

/** One row of the panel's category bar/legend. */
export interface BreakdownRow {
  name: string;
  tokens: number;
  kind: ContextUsageCategory['kind'];
  /** Share of the WINDOW (`maxTokens`), rounded to one decimal, or `null` when
   *  the window is unknown. Not a share of the summed rows — see the module
   *  note. A row can therefore legitimately read 0.0% and still be listed. */
  percentOfWindow: number | null;
}

/** One MCP server's aggregated cost, the grouping the panel actually shows.
 *  A user reads "which server is costing me", not which of its forty tools. */
export interface McpServerGroup {
  serverName: string;
  toolCount: number;
  tokens: number;
}

/** Everything the panel renders, or `null` when there is nothing to render. */
export interface ContextBreakdown {
  /** `used` rows only, largest first — what fills the window. */
  used: BreakdownRow[];
  /** `deferred` rows, largest first. Rendered in their own section with an
   *  explicit "not counted" note: they are listed for awareness, and folding
   *  them in with `used` is precisely the mistake this shape prevents. */
  deferred: BreakdownRow[];
  /** The `free` row, when the producer sent one. */
  free: BreakdownRow | null;
  /** Sum of the `used` rows. May differ slightly from the producer's
   *  `totalTokens` (which is authoritative and is what the gauge shows); this
   *  is only the legend's own arithmetic. */
  usedTotal: number;
  /** Detail lists, REUSING the normalized row types rather than re-declaring
   *  them inline. They were hand-duplicated here originally, which is the shape
   *  of issue #31: a structurally-identical copy silently drops whatever the
   *  source type gains (there, `ContextSkill.pluginName`), and the loss is
   *  invisible until a renderer reaches for the missing field. Referencing the
   *  interfaces makes that class of drift a compile error instead. */
  memoryFiles: ContextMemoryFile[];
  mcpServers: McpServerGroup[];
  skills: ContextSkill[];
  agents: ContextAgent[];
}

/** Rows carrying zero tokens are dropped: the CLI emits them (the SDK's own
 *  docs say "rows may carry zero tokens; renderers typically hide those") and a
 *  legend of 0-token entries is noise that pushes the real ones off-screen. */
function toRow(c: ContextUsageCategory, maxTokens: number | null): BreakdownRow {
  return {
    name: c.name,
    tokens: c.tokens,
    kind: c.kind,
    percentOfWindow:
      maxTokens != null && maxTokens > 0 ? Math.round((c.tokens / maxTokens) * 1000) / 10 : null,
  };
}

function byTokensDesc<T extends { tokens: number }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => b.tokens - a.tokens);
}

/** Aggregate MCP tool rows into per-server totals, largest server first.
 *
 *  Tools whose producer sent no `serverName` are grouped under a single
 *  "unknown" bucket rather than each becoming its own nameless server — an
 *  empty-string group renders as a blank row, which reads as a UI bug. */
export function groupMcpToolsByServer(tools: readonly ContextMcpTool[]): McpServerGroup[] {
  const byServer = new Map<string, McpServerGroup>();
  for (const t of tools) {
    const serverName = t.serverName || 'unknown';
    const existing = byServer.get(serverName);
    if (existing) {
      existing.toolCount += 1;
      existing.tokens += t.tokens;
    } else {
      byServer.set(serverName, { serverName, toolCount: 1, tokens: t.tokens });
    }
  }
  return byTokensDesc([...byServer.values()]);
}

/** Re-exported from `context-usage.ts`, where it now lives: `describeContextGauge`
 *  needs it to decide `expandable`, and importing this module from there would
 *  be circular (this module imports the ContextUsage types). It inspects only
 *  ContextUsage fields, so that is its natural home; it stays exported here so
 *  breakdown callers have one import site. */
export { hasBreakdown };

/** Build the panel's render model, or `null` when there is nothing to show.
 *
 *  Returning `null` rather than an empty shape is deliberate: it gives the
 *  renderer ONE thing to test (`if (!breakdown) return null`) instead of five
 *  empty-list checks, which is how an empty panel ships. */
export function buildContextBreakdown(usage: ContextUsage | undefined): ContextBreakdown | null {
  if (!hasBreakdown(usage) || !usage) return null;
  const max = usage.maxTokens;
  const cats = usage.categories ?? [];
  // Zero-token rows are dropped here (see toRow's note) — before sorting, so
  // they cannot occupy the head of a list when every row is zero.
  const nonZero = cats.filter((c) => c.tokens > 0);
  const used = byTokensDesc(nonZero.filter((c) => c.kind === 'used')).map((c) => toRow(c, max));
  const deferred = byTokensDesc(nonZero.filter(isDeferredCategory)).map((c) => toRow(c, max));
  const freeCat = nonZero.find((c) => c.kind === 'free');
  return {
    used,
    deferred,
    free: freeCat ? toRow(freeCat, max) : null,
    usedTotal: used.reduce((s, r) => s + r.tokens, 0),
    memoryFiles: byTokensDesc(usage.memoryFiles ?? []),
    mcpServers: groupMcpToolsByServer(usage.mcpTools ?? []),
    skills: byTokensDesc(usage.skills ?? []),
    agents: byTokensDesc(usage.agents ?? []),
  };
}

/** Split a list into the first `limit` items plus a count of the rest, for the
 *  panel's "+N more" tail. A session can load dozens of memory files and
 *  hundreds of MCP tools; rendering them all would make the popover taller than
 *  the window and bury the categories that answer the actual question. */
export function truncateList<T>(rows: readonly T[], limit: number): { shown: T[]; more: number } {
  if (limit < 0) return { shown: [], more: rows.length };
  return { shown: rows.slice(0, limit), more: Math.max(0, rows.length - limit) };
}

/** Shorten a memory-file path for display: keep the last two segments, which is
 *  what distinguishes `~/.claude/CLAUDE.md` from a worktree's own — the leading
 *  path is long, identical across rows, and carries no information. The full
 *  path rides on the row's `title` attribute, so nothing is lost. */
export function shortenMemoryPath(p: string): string {
  const parts = p.split('/').filter(Boolean);
  if (parts.length <= 2) return p;
  return `…/${parts.slice(-2).join('/')}`;
}
