// Session budgets (#208) — the ONE file the budget NUMBERS live in, plus the pure judge.
//
// Consumers: the session-budget suite (scripts/session-budget/, `pnpm run test:session-budget`),
// and — by import, never by copy — C3 #210 (processes/memory), C4 #211 (CLI-version re-run) and C7
// #214 (field alarms). To add a budget: add its number to SESSION_BUDGETS, one rule to RULES, and make
// the report carry the measured quantity. Nothing else in the repo may restate these numbers.
//
// Pure: no I/O, no Electron. Runs under `node --experimental-strip-types`.

/** Request counts the FAKE Anthropic API saw over some window. `other` = every route that is
 *  neither a model call nor a count_tokens call (models list, bootstrap, anything unexpected). */
export interface RequestCounts {
  model: number;
  count_tokens: number;
  other: number;
  total: number;
}

/** A census of the session's process tree at one instant. */
export interface ProcessCensus {
  total: number;
  /** Zombies are listed apart and NOT in `total` (a zombie is not a running program). */
  zombies: number;
  rssKB: number;
  /** cli = the `claude` binary, keeper = the detached daemon, mcp = a fixture MCP server,
   *  hook = an Orchestra hook shell, other = anything else in the tree. */
  byKind: { cli: number; keeper: number; mcp: number; hook: number; other: number };
}

/** What one session-budget run measured. Everything the judge and the printed report read. */
export interface SessionBudgetReport {
  schema: 1;
  arm: string;
  cli: { version: string; path: string };
  fixture: { skills: number; memoryFiles: number; mcpServers: number; toolsPerServer: number; claudeMdKB: number };
  /** How egress was contained: a network namespace (+ pid namespace), or only the refusing proxy. */
  containment: 'netns+pidns' | 'netns' | 'proxy-only';
  timing: { timeToFirstReplyMs: number | null; fakeModelLatencyMs: number };
  requests: { beforeFirstReply: RequestCounts; afterFirstReply: RequestCounts; total: RequestCounts };
  processes: { atFirstReply: ProcessCensus; atEnd: ProcessCensus; survivorsAfterTeardown: number | null };
  /** Hosts the CLI tried to reach OUTSIDE the fake API (all refused/unreachable). */
  egress: string[];
  /** Instrument facts proving the SUBJECT mounted (a vacuous 0 must not pass). */
  subject: { firstModelRequestTools: number; firstModelRequestBytes: number; markersSeen: string[]; mcpServersConnected: number; toolsAtInit: number };
}

/** Sentinels the fixture plants and the fake API greps for in the FIRST model request body — proof the
 *  subject carried the large CLAUDE.md, the skills list and the MCP tools (a vacuous 0 hides in a
 *  session that never loaded them). Names are shared by fixture.mjs, the fake API and the judge. */
export const SUBJECT_MARKERS = Object.freeze(['claude_md', 'rule_last', 'skill_last', 'mcp_tool_last'] as const);

/** THE budget numbers. Frozen; import, do not copy. */
export const SESSION_BUDGETS = Object.freeze({
  /** Before the FIRST REPLY of a fresh session (#208; the #176 class). */
  beforeFirstReply: Object.freeze({
    /** Exactly one model call — the opening turn itself. */
    modelRequests: 1,
    /** No count_tokens at all: a boot-time context read fans out to one per memory file (#176: ~58). */
    countTokensRequests: 0,
    /** No other route: a new startup call from a CLI upgrade must be looked at, not absorbed. */
    otherRequests: 0,
  }),
});

export type SessionBudgets = typeof SESSION_BUDGETS;

export interface Verdict {
  /** Stable id, e.g. `session.beforeFirstReply.countTokensRequests`. */
  id: string;
  /** `budget` = a cost limit; `instrument` = proof the run measured a real, heavy session. */
  kind: 'budget' | 'instrument';
  ok: boolean;
  actual: number | null;
  /** Human limit text: `exactly 1`, `at most 0`, `at least 4`. */
  limit: string;
  /** One line, names the rule and the counts. */
  message: string;
}

export interface Judgement {
  /** True only when every budget passes AND the instrument checks prove the subject mounted. */
  ok: boolean;
  /** True when an instrument check failed: the run measured nothing and its verdict is VOID. */
  void: boolean;
  verdicts: Verdict[];
}

const fmtCounts = (c: RequestCounts): string => `model=${c.model} count_tokens=${c.count_tokens} other=${c.other}`;

function budgetVerdict(id: string, kind: 'exact' | 'max', limit: number, actual: number, ctx: string): Verdict {
  const ok = kind === 'exact' ? actual === limit : actual <= limit;
  const lim = kind === 'exact' ? `exactly ${limit}` : `at most ${limit}`;
  return {
    id, kind: 'budget', ok, actual, limit: lim,
    message: ok ? `ok ${id}: ${actual} (${lim})` : `BUDGET BROKEN ${id}: allowed ${lim}, saw ${actual} — ${ctx}`,
  };
}

function instrumentVerdict(id: string, actual: number | null, min: number, why: string): Verdict {
  const ok = actual !== null && actual >= min;
  return {
    id, kind: 'instrument', ok, actual, limit: `at least ${min}`,
    message: ok ? `ok ${id}: ${actual} (at least ${min})` : `INSTRUMENT VOID ${id}: need at least ${min}, saw ${actual ?? 'nothing'} — ${why}`,
  };
}

/** Judge one report against the budgets. Never throws on a malformed report: a missing measurement
 *  is a failed instrument check (VOID), not a pass. */
export function judgeSessionBudget(report: SessionBudgetReport, budgets: SessionBudgets = SESSION_BUDGETS): Judgement {
  const b = budgets.beforeFirstReply;
  const pre = report.requests?.beforeFirstReply;
  const ctx = pre ? `before the first reply the session sent ${fmtCounts(pre)}` : 'no first reply was observed';
  const verdicts: Verdict[] = [];
  if (pre) {
    verdicts.push(budgetVerdict('session.beforeFirstReply.modelRequests', 'exact', b.modelRequests, pre.model, ctx));
    verdicts.push(budgetVerdict('session.beforeFirstReply.countTokensRequests', 'max', b.countTokensRequests, pre.count_tokens, ctx));
    verdicts.push(budgetVerdict('session.beforeFirstReply.otherRequests', 'max', b.otherRequests, pre.other, ctx));
  }
  // Instrument checks: the subject really was a heavy, mounted session with a first reply.
  const f = report.fixture;
  const s = report.subject;
  verdicts.push(instrumentVerdict('instrument.firstReplyObserved', report.timing?.timeToFirstReplyMs == null ? null : 1, 1, 'the session never produced a first reply, so the counts above measure nothing'));
  verdicts.push(instrumentVerdict('instrument.mcpServersConnected', s?.mcpServersConnected ?? null, f?.mcpServers ?? 1, 'the fixture MCP servers did not all connect — the subject is lighter than the fixture claims'));
  verdicts.push(instrumentVerdict('instrument.mcpChildProcesses', report.processes?.atFirstReply?.byKind?.mcp ?? null, f?.mcpServers ?? 1, 'the fixture MCP servers were not running as real child processes at the first reply'));
  verdicts.push(instrumentVerdict('instrument.modelRequestCarriesTools', s?.firstModelRequestTools ?? null, (f?.mcpServers ?? 1) * (f?.toolsPerServer ?? 1), 'the model request did not carry the fixture tools'));
  for (const m of SUBJECT_MARKERS) {
    verdicts.push(instrumentVerdict(`instrument.modelRequestCarries.${m}`, s?.markersSeen?.includes(m) ? 1 : null, 1, `the first model request did not contain the fixture's ${m} sentinel — the subject is lighter than the fixture claims`));
  }
  const voided = verdicts.some((v) => v.kind === 'instrument' && !v.ok);
  return { ok: !voided && verdicts.every((v) => v.ok), void: voided, verdicts };
}

/** The report's requests-by-type block, one line per window, for the printed summary. */
export function formatRequestSummary(report: SessionBudgetReport): string[] {
  const r = report.requests;
  return [
    `requests before first reply: ${fmtCounts(r.beforeFirstReply)}`,
    `requests after first reply:  ${fmtCounts(r.afterFirstReply)}`,
    `requests total:              ${fmtCounts(r.total)}`,
  ];
}
