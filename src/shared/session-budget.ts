// Session budgets (#208) — the ONE file the budget NUMBERS live in, plus the pure judge.
//
// Consumers: the session-budget suite (scripts/session-budget/, `pnpm run test:session-budget`),
// and — by import, never by copy — C3 #210 (processes/memory), C4 #211 (CLI-version re-run) and C7
// #214 (field alarms). To add a budget: add its number to SESSION_BUDGETS, one rule to RULES, and make
// the report carry the measured quantity. Nothing else in the repo may restate these numbers.
//
// Pure: no I/O, no Electron. Runs under `node --experimental-strip-types`.

/** Everything the FAKE Anthropic API + its egress proxy saw over one window of the run.
 *  `main` = model calls that carry tools (the user's turn); `side` = tool-less model calls keyed by model
 *  (title/quota-style calls the CLI makes on its own); `other` = any route that is neither a model call nor
 *  count_tokens; `egress` = refused attempts to reach a host OUTSIDE the fake API, keyed `host:port`. */
export interface RequestCounts {
  model: number;
  main: number;
  side: Record<string, number>;
  count_tokens: number;
  other: number;
  otherPaths: Record<string, number>;
  egress: Record<string, number>;
  /** Requests the fake API served (model + count_tokens + other); egress is not in it. */
  total: number;
}

/** One request as recorded by the fake API (fake-anthropic-api.mjs). */
export interface RawRequest { tMs: number; type: string; method?: string; path?: string; model?: string | null; tools?: number }
/** One refused egress attempt as recorded by the fake API's proxy. */
export interface RawEgress { tMs: number; target: string }

/** Summarize the requests/egress with `afterMs < tMs <= upToMs` (pure; the runner and the tests share it). */
export function summarizeWindow(requests: RawRequest[], egress: RawEgress[], afterMs: number, upToMs: number): RequestCounts {
  const c: RequestCounts = { model: 0, main: 0, side: {}, count_tokens: 0, other: 0, otherPaths: {}, egress: {}, total: 0 };
  for (const r of requests) {
    if (!(r.tMs > afterMs && r.tMs <= upToMs)) continue;
    c.total++;
    if (r.type === 'model') {
      c.model++;
      if ((r.tools ?? 0) > 0) c.main++;
      else c.side[r.model ?? 'unknown'] = (c.side[r.model ?? 'unknown'] ?? 0) + 1;
    } else if (r.type === 'count_tokens') {
      c.count_tokens++;
    } else {
      c.other++;
      const k = `${r.method ?? '?'} ${r.path ?? '?'}`;
      c.otherPaths[k] = (c.otherPaths[k] ?? 0) + 1;
    }
  }
  for (const e of egress) if (e.tMs > afterMs && e.tMs <= upToMs) c.egress[e.target] = (c.egress[e.target] ?? 0) + 1;
  return c;
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
  /** True only when the run was started with SESSION_BUDGET_ALLOW_WEAK_CONTAINMENT=1: a weaker containment is then tolerated, and printed. */
  containmentOptOut?: boolean;
  /** Which traffic-suppressing knobs were set in the env the CLI was handed (must be none: production parity). */
  envParity?: { trafficKnobsSet: string[] };
  /** `timeToFirstReplyMs` = first text-delta minus the instant just before `sdkSend` (NOT runner setup). */
  timing: { timeToFirstReplyMs: number | null; fakeModelLatencyMs: number; setupMs?: number };
  requests: { beforeFirstReply: RequestCounts; afterFirstReply: RequestCounts; total: RequestCounts };
  processes: { atFirstReply: ProcessCensus; atEnd: ProcessCensus; survivorsAfterTeardown: number | null };
  /** Every host the CLI tried to reach OUTSIDE the fake API (refused/unreachable), in order, whole run. */
  egress: string[];
  /** Compact per-request log (whole run) so a reader can see WHICH side call / route broke a budget. */
  requestLog?: Array<{ tMs: number; type: string; path: string; model: string | null; tools: number | null; preview?: string }>;
  /** Set when the run itself raised (a setup/teardown/agent error): a run that raised is never a pass. */
  error?: string;
  /** Instrument facts proving the SUBJECT mounted (a vacuous 0 must not pass). */
  subject: { firstModelRequestTools: number; firstModelRequestBytes: number; markersSeen: string[]; mcpServersConnected: number; toolsAtInit: number };
}

/** Sentinels the fixture plants and the fake API greps for in the FIRST model request body — proof the
 *  subject carried the large CLAUDE.md, the skills list and the MCP tools (a vacuous 0 hides in a
 *  session that never loaded them). Names are shared by fixture.mjs, the fake API and the judge. */
export const SUBJECT_MARKERS = Object.freeze(['claude_md', 'rule_last', 'skill_last', 'mcp_tool_last'] as const);

/** The CLI env knobs that SUPPRESS its non-essential startup traffic. Orchestra sets none of them, so the suite must not
 *  either (review F2): a run with any of them set describes a lighter session than production's. */
export const TRAFFIC_KNOBS = Object.freeze(['CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC', 'DISABLE_TELEMETRY', 'DISABLE_AUTOUPDATER', 'DISABLE_ERROR_REPORTING', 'DISABLE_BUG_COMMAND'] as const);

/** Env var that lets a run proceed with a weaker egress containment than net+pid namespaces (echoed in the verdict). */
export const WEAK_CONTAINMENT_ENV = 'SESSION_BUDGET_ALLOW_WEAK_CONTAINMENT';

/** THE budget numbers. Frozen; import, do not copy.
 *
 *  They describe PRODUCTION configuration: the suite sets none of the CLI's traffic-disabling env knobs (Orchestra
 *  sets none either — `git grep NONESSENTIAL src scripts` finds only this suite's docs), against a fake
 *  non-first-party base URL, inside a network namespace. Measured on CLI 2.1.284, 4 identical runs (2026-09-30,
 *  ledger #237 review F2): the user's turn is the model call that carries tools; one tool-less haiku call precedes
 *  it; the CLI then makes 5 refused attempts at api.anthropic.com:443 (hard-coded host, ignores the base URL).
 *  A NEW startup call — a different side model, another route, another host, one more attempt — breaks a number. */
export const SESSION_BUDGETS = Object.freeze({
  /** Before the FIRST REPLY of a fresh session (#208; the #176 class). */
  beforeFirstReply: Object.freeze({
    /** Exactly one model call carrying tools — the opening turn itself. */
    modelRequests: 1,
    /** Tool-less model calls the CLI makes on its own, at most N per model; a model not listed is allowed 0. */
    sideModelRequests: Object.freeze({ 'claude-haiku-4-5-20251001': 1 } as Record<string, number>),
    /** No count_tokens at all: a boot-time context read fans out to one per memory file (#176: ~58). */
    countTokensRequests: 0,
    /** No other route: a new startup call from a CLI upgrade must be looked at, not absorbed. */
    otherRequests: 0,
    /** Refused attempts to reach a host OUTSIDE the fake API, at most N per `host:port`; an unlisted host is allowed 0. */
    egressAttempts: Object.freeze({ 'api.anthropic.com:443': 5 } as Record<string, number>),
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

const fmtMap = (m: Record<string, number> | undefined): string => {
  const e = Object.entries(m ?? {}).sort(([a], [b]) => (a < b ? -1 : 1));
  return e.length ? `{${e.map(([k, v]) => `${k}:${v}`).join(', ')}}` : '{}';
};
const fmtCounts = (c: RequestCounts): string =>
  `model=${c.model} count_tokens=${c.count_tokens} other=${c.other} | main=${c.main} side=${fmtMap(c.side)} egress=${fmtMap(c.egress)}`;

/** One `max` verdict per key in the budget map OR the actual map (a key only the run has is budgeted at 0). */
function mapVerdicts(prefix: string, budget: Record<string, number>, actual: Record<string, number> | undefined, ctx: string): Verdict[] {
  const keys = [...new Set([...Object.keys(budget), ...Object.keys(actual ?? {})])].sort();
  return keys.map((k) => budgetVerdict(`${prefix}.${k}`, 'max', budget[k] ?? 0, actual?.[k] ?? 0, ctx));
}

function flagVerdict(id: string, ok: boolean, okMsg: string, voidMsg: string): Verdict {
  return { id, kind: 'instrument', ok, actual: ok ? 1 : null, limit: 'required', message: ok ? `ok ${id}: ${okMsg}` : `INSTRUMENT VOID ${id}: ${voidMsg}` };
}

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
    verdicts.push(budgetVerdict('session.beforeFirstReply.modelRequests', 'exact', b.modelRequests, pre.main, ctx));
    verdicts.push(...mapVerdicts('session.beforeFirstReply.sideModelRequests', b.sideModelRequests, pre.side, ctx));
    verdicts.push(budgetVerdict('session.beforeFirstReply.countTokensRequests', 'max', b.countTokensRequests, pre.count_tokens, ctx));
    verdicts.push(budgetVerdict('session.beforeFirstReply.otherRequests', 'max', b.otherRequests, pre.other, ctx));
    verdicts.push(...mapVerdicts('session.beforeFirstReply.egressAttempts', b.egressAttempts, pre.egress, ctx));
  }
  // Instrument checks: the subject really was a heavy, mounted session with a first reply.
  const f = report.fixture;
  const s = report.subject;
  // F1: egress containment is part of the measurement; F4: a run that raised is never a pass.
  const weakOk = report.containmentOptOut === true;
  verdicts.push(flagVerdict('instrument.containment', report.containment === 'netns+pidns' || weakOk,
    report.containment === 'netns+pidns' ? 'netns+pidns' : `containment=${report.containment} — WEAK, allowed only by the explicit opt-out ${WEAK_CONTAINMENT_ENV}=1`,
    `containment=${report.containment ?? 'unknown'}, need netns+pidns (or the explicit opt-out ${WEAK_CONTAINMENT_ENV}=1) — egress was not contained, so nothing was measured`));
  const knobs = report.envParity?.trafficKnobsSet;
  verdicts.push(flagVerdict('instrument.productionEnv', Array.isArray(knobs) && knobs.length === 0,
    'no traffic-suppressing env knob set (production parity)',
    `${Array.isArray(knobs) ? `traffic-suppressing env set: ${knobs.join(', ')}` : 'env parity not reported'} — Orchestra sets none, so these budgets would describe a lighter session than production's`));
  const preEgress = Object.values(pre?.egress ?? {}).reduce((a, b) => a + b, 0);
  verdicts.push(instrumentVerdict('instrument.nonessentialTrafficVisible', pre ? preEgress : null, 1,
    'the CLI made no outbound attempt before the first reply — either a traffic-suppressing knob leaked in, or the CLI stopped reaching out (then lower this deliberately)'));
  verdicts.push(instrumentVerdict('instrument.clockStartedAtSend', report.timing?.setupMs ?? null, 1, 'time-to-first-reply must start at sdkSend, after runner setup — setupMs was not measured'));
  verdicts.push(flagVerdict('instrument.runCompleted', !report.error, 'no setup/teardown/agent error', `the run raised: ${String(report.error).slice(0, 300)}`));
  verdicts.push(instrumentVerdict('instrument.keeperProcess', report.processes?.atFirstReply?.byKind?.keeper ?? null, 1, 'no keeper daemon at the first reply — the session did not go through the detached keeper'));
  verdicts.push(instrumentVerdict('instrument.cliProcess', report.processes?.atFirstReply?.byKind?.cli ?? null, 1, 'no claude CLI process at the first reply — the census sees no session'));
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
