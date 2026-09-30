// TEST-ONLY builder of a session-budget report that the REAL judge (session-budget.ts) accepts — shared by the
// CLI-version re-run tests (#211). Defaults = a healthy production-parity run on CLI 2.1.284: one main model call
// carrying tools, one tool-less haiku side call, 3 refused startup attempts at api.anthropic.com:443, everything mounted.
import type { RequestCounts, SessionBudgetReport } from './session-budget.ts';

export interface ReportOpts {
  version?: string;
  count?: number;
  mainModel?: number;
  other?: number;
  /** Refused attempts at api.anthropic.com:443 before the main request started (budget: 3). */
  startupAttempts?: number;
  /** Main request start minus the first egress attempt (judge: > 2000 ms ⇒ VOID, not comparable). */
  startupSpanMs?: number;
  error?: string;
  firstReply?: number | null;
  mcp?: number;
}

export function healthyReport(o: ReportOpts = {}): SessionBudgetReport & { error?: string } {
  const main = o.mainModel ?? 1;
  const side = { 'claude-haiku-4-5-20251001': 1 };
  const before: RequestCounts = {
    model: main + 1, main, side, count_tokens: o.count ?? 0, other: o.other ?? 0, otherPaths: {},
    egress: { 'api.anthropic.com:443': 5 }, total: main + 1 + (o.count ?? 0) + (o.other ?? 0),
  };
  const empty: RequestCounts = { model: 0, main: 0, side: {}, count_tokens: 0, other: 0, otherPaths: {}, egress: {}, total: 0 };
  const census = { total: 6, zombies: 0, rssKB: 1, byKind: { cli: 1, keeper: 1, mcp: 4, hook: 0, other: 0 } };
  return {
    schema: 1, arm: 't', cli: { version: `${o.version ?? '2.1.290'} (Claude Code)`, path: '/x' },
    fixture: { skills: 60, memoryFiles: 50, mcpServers: 4, toolsPerServer: 15, claudeMdKB: 48 }, containment: 'netns+pidns',
    envParity: { source: '/proc/1/environ at the first reply', trafficKnobsSet: [] },
    startupEgress: { 'api.anthropic.com:443': o.startupAttempts ?? 3 },
    timing: {
      timeToFirstReplyMs: o.firstReply === undefined ? 700 : o.firstReply, fakeModelLatencyMs: 500, setupMs: 1500,
      firstReplyAbsMs: o.firstReply === undefined ? 2200 : o.firstReply === null ? undefined : 1500 + o.firstReply, startupEgressSpanMs: o.startupSpanMs ?? 400,
    },
    requests: { beforeFirstReply: before, afterFirstReply: empty, total: before },
    processes: { atFirstReply: census, atEnd: census, survivorsAfterTeardown: 0 }, egress: [],
    subject: { firstModelRequestTools: 60, firstModelRequestBytes: 1, markersSeen: ['claude_md', 'rule_last', 'skill_last', 'mcp_tool_last'], mcpServersConnected: o.mcp ?? 4, toolsAtInit: 60 },
    ...(o.error ? { error: o.error } : {}),
  };
}
