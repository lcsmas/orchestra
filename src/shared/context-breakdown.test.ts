import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildContextBreakdown,
  groupMcpToolsByServer,
  hasBreakdown,
  truncateList,
  shortenMemoryPath,
} from './context-breakdown.ts';
import {
  normalizeLiveContextUsage,
  normalizeContextCommandUsage,
  contextUsageFromTranscript,
  type ContextUsage,
} from './context-usage.ts';

// Fixtures mirror the payloads VERIFIED against CLI 2.1.234 in
// docs/research/sdk-runtime-payloads.md, extended with the detail lists the SDK
// .d.ts declares (SDKContextUsage / SDKControlGetContextUsageResponse). Using
// the real wire shapes is what makes these tests evidence about the contract
// rather than a second implementation of my own assumptions.

/** `Query.getContextUsage()` — camelCase; note `skills` is an OBJECT here. */
const LIVE_PAYLOAD = {
  categories: [
    { name: 'System tools', tokens: 14144, color: 'inactive' },
    { name: 'MCP tools (deferred)', tokens: 52191, color: 'inactive', isDeferred: true },
    { name: 'System tools (deferred)', tokens: 15618, color: 'inactive', isDeferred: true },
    { name: 'Memory files', tokens: 52060, color: 'claude' },
    { name: 'Skills', tokens: 1993, color: 'warning' },
    { name: 'Messages', tokens: 4994, color: 'purple_FOR_SUBAGENTS_ONLY' },
    { name: 'Free space', tokens: 126809, color: 'promptBorder' },
  ],
  totalTokens: 73191,
  maxTokens: 200000,
  rawMaxTokens: 200000,
  percentage: 37,
  model: 'claude-haiku-4-5-20251001',
  memoryFiles: [
    { path: '/home/u/.claude/CLAUDE.md', type: 'User', tokens: 1245 },
    { path: '/home/u/proj/CLAUDE.md', type: 'Project', tokens: 50815 },
  ],
  mcpTools: [
    { name: 'mcp__github__create_issue', serverName: 'github', tokens: 890 },
    { name: 'mcp__github__list_issues', serverName: 'github', tokens: 610 },
    { name: 'mcp__linear__save_issue', serverName: 'linear', tokens: 400 },
  ],
  // The live shape nests the rows under an object — the divergence mapSkills
  // exists to absorb.
  skills: {
    totalSkills: 9,
    includedSkills: 2,
    tokens: 1993,
    skillFrontmatter: [
      { name: 'ship', source: 'projectSettings', tokens: 1200 },
      { name: 'verify', source: 'userSettings', tokens: 793 },
    ],
  },
  agents: [{ agentType: 'Explore', source: 'userSettings', tokens: 320 }],
};

/** The `context_usage` field on a `/context` result — snake_case; `skills` is
 *  a FLAT ARRAY here. */
const COMMAND_PAYLOAD = {
  model: 'claude-haiku-4-5-20251001',
  total_tokens: 68205,
  raw_max_tokens: 200000,
  percentage: 34,
  categories: [
    { name: 'System tools', tokens: 14144, kind: 'used' },
    { name: 'MCP tools (deferred)', tokens: 24056, kind: 'deferred' },
    { name: 'Memory files', tokens: 52060, kind: 'used' },
    { name: 'Messages', tokens: 8, kind: 'used' },
    { name: 'Free space', tokens: 131795, kind: 'free' },
  ],
  memory_files: [{ path: '/home/u/.claude/CLAUDE.md', type: 'User', tokens: 1245 }],
  mcp_tools: [{ name: 'mcp__github__create_issue', server_name: 'github', tokens: 890 }],
  skills: [{ name: 'ship', source: 'userSettings', tokens: 6 }],
  agents: [{ agent_type: 'Explore', source: 'userSettings', tokens: 320 }],
};

// ── Normalization of the detail lists (the two wire shapes) ─────────────────

test('live payload: detail lists normalize, including the nested skills object', () => {
  const u = normalizeLiveContextUsage(LIVE_PAYLOAD, 0)!;
  assert.equal(u.memoryFiles?.length, 2);
  assert.equal(u.mcpTools?.length, 3);
  assert.deepEqual(u.skills, [
    { name: 'ship', source: 'projectSettings', tokens: 1200 },
    { name: 'verify', source: 'userSettings', tokens: 793 },
  ]);
  assert.deepEqual(u.agents, [{ agentType: 'Explore', source: 'userSettings', tokens: 320 }]);
});

test('command payload: snake_case detail lists normalize to the same camelCase rows', () => {
  const u = normalizeContextCommandUsage(COMMAND_PAYLOAD, 0)!;
  assert.deepEqual(u.mcpTools, [
    { name: 'mcp__github__create_issue', serverName: 'github', tokens: 890 },
  ]);
  assert.deepEqual(u.agents, [{ agentType: 'Explore', source: 'userSettings', tokens: 320 }]);
  assert.deepEqual(u.skills, [{ name: 'ship', source: 'userSettings', tokens: 6 }]);
});

test('both wire shapes converge on the same normalized keys', () => {
  const live = normalizeLiveContextUsage(LIVE_PAYLOAD, 0)!;
  const cmd = normalizeContextCommandUsage(COMMAND_PAYLOAD, 0)!;
  assert.deepEqual(Object.keys(live).sort(), Object.keys(cmd).sort());
});

test('malformed detail rows are dropped, not defaulted to zero/empty', () => {
  const u = normalizeLiveContextUsage(
    {
      totalTokens: 10,
      rawMaxTokens: 100,
      memoryFiles: [{ path: '/a/b.md', tokens: 5 }, { path: '/c.md' }, { tokens: 7 }, null, 'x'],
      mcpTools: [{ name: 'ok', serverName: 's', tokens: 1 }, { name: 'no-tokens' }],
    },
    0,
  )!;
  // Only the fully-formed rows survive; a token-less row would otherwise render
  // a measured-looking "0".
  assert.deepEqual(u.memoryFiles, [{ path: '/a/b.md', type: '', tokens: 5 }]);
  assert.equal(u.mcpTools?.length, 1);
});

test('a list that yields no usable rows becomes undefined, not an empty array', () => {
  const u = normalizeLiveContextUsage(
    { totalTokens: 10, rawMaxTokens: 100, memoryFiles: [{ bogus: true }], skills: {} },
    0,
  )!;
  assert.equal(u.memoryFiles, undefined);
  assert.equal(u.skills, undefined);
});

// ── hasBreakdown: the graceful-degradation gate ─────────────────────────────

test('hasBreakdown is false for the transcript source and for undefined', () => {
  assert.equal(hasBreakdown(undefined), false);
  assert.equal(hasBreakdown(contextUsageFromTranscript(5000, 0)), false);
});

test('hasBreakdown is true for both live and /context readings', () => {
  assert.equal(hasBreakdown(normalizeLiveContextUsage(LIVE_PAYLOAD, 0)!), true);
  assert.equal(hasBreakdown(normalizeContextCommandUsage(COMMAND_PAYLOAD, 0)!), true);
});

// Gated on CONTENT, not on `source`: a live reading whose categories all came
// back zero has nothing to show and must degrade exactly like the transcript.
test('hasBreakdown is false for a live reading with only zero-token categories', () => {
  const empty: ContextUsage = {
    totalTokens: 100,
    maxTokens: 200000,
    percentage: 0,
    source: 'live',
    at: 0,
    categories: [{ name: 'Messages', tokens: 0, kind: 'used' }],
  };
  assert.equal(hasBreakdown(empty), false);
  assert.equal(buildContextBreakdown(empty), null);
});

test('hasBreakdown is true when only a detail list is present (no categories)', () => {
  const u: ContextUsage = {
    totalTokens: 100,
    maxTokens: 200000,
    percentage: 0,
    source: 'live',
    at: 0,
    memoryFiles: [{ path: '/a.md', type: 'User', tokens: 12 }],
  };
  assert.equal(hasBreakdown(u), true);
});

// ── buildContextBreakdown ───────────────────────────────────────────────────

test('buildContextBreakdown returns null when there is nothing to render', () => {
  assert.equal(buildContextBreakdown(undefined), null);
  assert.equal(buildContextBreakdown(contextUsageFromTranscript(5000, 0)), null);
});

test('used rows are sorted largest first and exclude deferred/free', () => {
  const b = buildContextBreakdown(normalizeLiveContextUsage(LIVE_PAYLOAD, 0)!)!;
  assert.deepEqual(
    b.used.map((r) => r.name),
    ['Memory files', 'System tools', 'Messages', 'Skills'],
  );
  assert.ok(b.used.every((r) => r.kind === 'used'));
});

// The trap the whole module exists to prevent: deferred rows are listed for
// awareness but are NOT part of usage math. Summing every row here would report
// 267,809 against a 200K window — a >100% panel on a 37%-full session.
test('deferred rows are segregated and never folded into usedTotal', () => {
  const u = normalizeLiveContextUsage(LIVE_PAYLOAD, 0)!;
  const b = buildContextBreakdown(u)!;
  assert.deepEqual(
    b.deferred.map((r) => r.name),
    ['MCP tools (deferred)', 'System tools (deferred)'],
  );
  assert.equal(b.usedTotal, 14144 + 52060 + 1993 + 4994);
  assert.ok(b.usedTotal < u.maxTokens!, 'usedTotal must stay inside the window');
  const naiveSum = u.categories!.reduce((s, c) => s + c.tokens, 0);
  assert.equal(naiveSum, 267809);
  assert.ok(naiveSum > u.maxTokens!, 'fixture must exercise the overflow case');
});

test('the free row is lifted out separately', () => {
  const b = buildContextBreakdown(normalizeLiveContextUsage(LIVE_PAYLOAD, 0)!)!;
  assert.equal(b.free?.name, 'Free space');
  assert.equal(b.free?.kind, 'free');
  assert.ok(!b.used.some((r) => r.kind === 'free'));
});

// Percentages are shares of the WINDOW, not of a summed denominator — so the
// used rows do NOT add to 100 and must not be made to.
test('percentOfWindow is measured against maxTokens, to one decimal', () => {
  const b = buildContextBreakdown(normalizeLiveContextUsage(LIVE_PAYLOAD, 0)!)!;
  const memory = b.used.find((r) => r.name === 'Memory files')!;
  assert.equal(memory.percentOfWindow, 26); // 52060/200000 = 26.03 -> 26
  const skills = b.used.find((r) => r.name === 'Skills')!;
  assert.equal(skills.percentOfWindow, 1); // 1993/200000 = 0.9965 -> 1.0
  const sum = b.used.reduce((s, r) => s + (r.percentOfWindow ?? 0), 0);
  assert.ok(sum < 100, 'used shares are of the window, so they must not total 100');
});

test('percentOfWindow is null when the window is unknown', () => {
  const u: ContextUsage = {
    totalTokens: 100,
    maxTokens: null,
    percentage: null,
    source: 'live',
    at: 0,
    categories: [{ name: 'Messages', tokens: 100, kind: 'used' }],
  };
  const b = buildContextBreakdown(u)!;
  assert.equal(b.used[0].percentOfWindow, null);
});

test('zero-token category rows are hidden', () => {
  const u: ContextUsage = {
    totalTokens: 10,
    maxTokens: 200000,
    percentage: 0,
    source: 'live',
    at: 0,
    categories: [
      { name: 'Messages', tokens: 10, kind: 'used' },
      { name: 'Skills', tokens: 0, kind: 'used' },
    ],
  };
  const b = buildContextBreakdown(u)!;
  assert.deepEqual(b.used.map((r) => r.name), ['Messages']);
});

test('detail lists come back sorted largest first', () => {
  const b = buildContextBreakdown(normalizeLiveContextUsage(LIVE_PAYLOAD, 0)!)!;
  assert.deepEqual(
    b.memoryFiles.map((f) => f.tokens),
    [50815, 1245],
  );
  assert.deepEqual(b.skills.map((s) => s.name), ['ship', 'verify']);
});

// ── MCP grouping ────────────────────────────────────────────────────────────

test('mcp tools group by server, summing tokens and counting tools', () => {
  const b = buildContextBreakdown(normalizeLiveContextUsage(LIVE_PAYLOAD, 0)!)!;
  assert.deepEqual(b.mcpServers, [
    { serverName: 'github', toolCount: 2, tokens: 1500 },
    { serverName: 'linear', toolCount: 1, tokens: 400 },
  ]);
});

test('mcp tools with no server name collapse into one "unknown" group', () => {
  const groups = groupMcpToolsByServer([
    { name: 'a', serverName: '', tokens: 10 },
    { name: 'b', serverName: '', tokens: 5 },
  ]);
  assert.deepEqual(groups, [{ serverName: 'unknown', toolCount: 2, tokens: 15 }]);
});

test('groupMcpToolsByServer on an empty list yields no groups', () => {
  assert.deepEqual(groupMcpToolsByServer([]), []);
});

// ── Truncation + path display ───────────────────────────────────────────────

test('truncateList splits into shown + a remainder count', () => {
  assert.deepEqual(truncateList([1, 2, 3, 4, 5], 3), { shown: [1, 2, 3], more: 2 });
});

test('truncateList never reports a negative remainder when under the limit', () => {
  assert.deepEqual(truncateList([1, 2], 5), { shown: [1, 2], more: 0 });
  assert.deepEqual(truncateList([], 5), { shown: [], more: 0 });
});

test('truncateList with a zero/negative limit shows nothing and counts all', () => {
  assert.deepEqual(truncateList([1, 2, 3], 0), { shown: [], more: 3 });
  assert.deepEqual(truncateList([1, 2, 3], -1), { shown: [], more: 3 });
});

test('shortenMemoryPath keeps the last two segments', () => {
  assert.equal(shortenMemoryPath('/home/u/proj/docs/CLAUDE.md'), '…/docs/CLAUDE.md');
});

test('shortenMemoryPath leaves already-short paths alone', () => {
  assert.equal(shortenMemoryPath('CLAUDE.md'), 'CLAUDE.md');
  assert.equal(shortenMemoryPath('a/CLAUDE.md'), 'a/CLAUDE.md');
});
