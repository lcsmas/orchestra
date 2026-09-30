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

/** Refused egress attempts by `host:port` with `tMs <= upToMs` (pure). Used for the STARTUP egress budget: the cut is
 *  `STARTUP_CUT_MARGIN_MS` before the main model request's START — causal, independent of when the reply is observed. */
export function egressUpTo(egress: RawEgress[], upToMs: number): Record<string, number> {
  const out: Record<string, number> = {};
  for (const e of egress) if (e.tMs <= upToMs) out[e.target] = (out[e.target] ?? 0) + 1;
  return out;
}

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

/** One live process of a session tree (proc-census.mjs). `cmd` is truncated to 300 chars. */
export interface ProcEntry {
  pid: number;
  ppid?: number;
  kind: 'cli' | 'keeper' | 'mcp' | 'hook' | 'other';
  /** Resident set, kB (`VmRSS`). */
  rssKB?: number;
  /** Swapped-out anonymous memory, kB (`VmSwap`) — counted in the memory budget so paging cannot hide a leak. */
  swapKB?: number;
  cmd: string;
}

/** What the REAL workspace-delete path left behind (#210; scripts/session-budget/delete-teardown.mjs). */
export interface DeleteReport {
  /** Which real route was driven: `cli` = the socket `/deleteWorkspace` route, `ui` = the renderer IPC handler. */
  via: 'cli' | 'ui';
  /** How long the run polled for the tree to disappear. */
  boundMs: number;
  /** Delete call start → the call returned. */
  returnedMs: number;
  /** Delete call start → zero processes left; null when some were still alive at `boundMs`. */
  elapsedMs: number | null;
  treeBefore: ProcEntry[];
  /** Pre-delete tree members still alive BY IDENTITY, plus (pid namespace) anything still in the namespace. */
  survivors: ProcEntry[];
  /** The store record is gone — proof the delete really ran to its end. */
  storeRecordGone: boolean;
  error?: string;
}

/** A census of the session's process tree at one instant. */
export interface ProcessCensus {
  total: number;
  /** Zombies are listed apart and NOT in `total` (a zombie is not a running program). */
  zombies: number;
  rssKB: number;
  swapKB?: number;
  /** cli = the `claude` binary, keeper = the detached daemon, mcp = a fixture MCP server,
   *  hook = an Orchestra hook shell, other = anything else in the tree. */
  byKind: { cli: number; keeper: number; mcp: number; hook: number; other: number };
  /** The tree itself (#210) — what a process/memory verdict names when it fails. */
  procs?: ProcEntry[];
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
  envParity?: { source?: string; trafficKnobsSet: string[] | null; error?: string };
  /** `timeToFirstReplyMs` = first text-delta minus the instant just before `sdkSend` (NOT runner setup). */
  timing: {
    timeToFirstReplyMs: number | null; fakeModelLatencyMs: number; setupMs?: number;
    /** Absolute stamps on the fake API's clock: first text-delta, first turn's turn-end, main request start. */
    firstReplyAbsMs?: number; turnEndAbsMs?: number; mainRequestStartAbsMs?: number;
    /** Main request start minus the FIRST egress attempt: how long the startup burst took. */
    startupEgressSpanMs?: number;
  };
  /** Refused egress attempts made BEFORE the main model request started (the budgeted window), by `host:port`. */
  startupEgress?: Record<string, number>;
  requests: { beforeFirstReply: RequestCounts; afterFirstReply: RequestCounts; total: RequestCounts };
  processes: { atFirstReply: ProcessCensus; atEnd: ProcessCensus; survivorsAfterTeardown: number | null };
  /** Present only on the delete arms (#210): the session was torn down through the real delete path. */
  delete?: DeleteReport;
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

/** The startup-egress cut sits this far BEFORE the main request's start: attempts the CLI fires together with the request landed at
 *  -2…+56 ms around it (a coin flip at the cut, measured), so they are excluded from the startup window instead of raced. */
export const STARTUP_CUT_MARGIN_MS = 150;

/** A refused startup call is RETRIED by the CLI: one extra attempt per this many ms of startup (generous — measured: a startup slowed
 *  to 2.2–2.7 s by a slow MCP server made ONE extra attempt, ~1.1 s after the first burst; 3 of 3 runs). Only KNOWN hosts get the
 *  allowance — a retry always goes to a host already attempted, so a NEW host is never explained by it. */
export const STARTUP_RETRY_MS = 1000;
/** Beyond this first-attempt→main-request gap something is broken (the CLI gives up on MCP at ~3 s): the run is not comparable — VOID. */
export const STARTUP_SPAN_MAX_MS = 8000;

/** Extra same-host startup attempts a startup of `spanMs` may legitimately show (retries of refused calls). Pure. */
export function startupRetryAllowance(spanMs: number | undefined): number {
  return spanMs == null || !(spanMs > 0) ? 0 : Math.floor(spanMs / STARTUP_RETRY_MS);
}

/** Env var that lets a run proceed with a weaker egress containment than net+pid namespaces (echoed in the verdict). */
export const WEAK_CONTAINMENT_ENV = 'SESSION_BUDGET_ALLOW_WEAK_CONTAINMENT';

/** THE budget numbers. Frozen; import, do not copy.
 *
 *  They describe PRODUCTION configuration: the suite sets none of the CLI's traffic-disabling env knobs (Orchestra sets none
 *  either — `git grep NONESSENTIAL src scripts` finds only this suite), against a fake non-first-party base URL, inside a
 *  network namespace, with the app process's own fetch()/http(s) routed through the recording proxy too. Measured on CLI
 *  2.1.284 (2026-09-30, ledger #237 reviews): the user's turn is the model call that carries tools; one tool-less haiku call
 *  (the CLI's session-title generator) precedes it; exactly 3 refused attempts at api.anthropic.com:443 precede the main
 *  request (9/9 runs at reply latency 500/2000/5000 ms; later attempts grow with session duration and are printed, not
 *  budgeted). A NEW startup call — a different side model, another route, another host, one more attempt — breaks a number.
 *
 *  WINDOWS: `beforeFirstReply` requests = everything up to the first turn's `turn-end` (the reply is complete; the legitimate
 *  gauge refresh is triggered BY that event, so it can never land inside the window); `startupEgressAttempts` = attempts
 *  before the main request STARTS (causal, immune to reply latency). */
export const SESSION_BUDGETS = Object.freeze({
  beforeFirstReply: Object.freeze({
    /** Exactly one model call carrying tools — the opening turn itself. */
    modelRequests: 1,
    /** Tool-less model calls the CLI makes on its own, at most N per model; a model not listed is allowed 0. */
    sideModelRequests: Object.freeze({ 'claude-haiku-4-5-20251001': 1 } as Record<string, number>),
    /** No count_tokens at all: a boot-time context read fans out to one per memory file (#176: ~58). */
    countTokensRequests: 0,
    /** No other route: a new startup call from a CLI upgrade must be looked at, not absorbed. */
    otherRequests: 0,
    /** Refused attempts to reach a host OUTSIDE the fake API BEFORE the main request starts, at most N per `host:port`
     *  (the CLI's AND the app process's); an unlisted host is allowed 0. */
    startupEgressAttempts: Object.freeze({ 'api.anthropic.com:443': 3 } as Record<string, number>),
  }),
  /** #210 — the session's process tree, at the first reply AND settled (+2.5 s). A session is exactly one
   *  keeper, one CLI, one process per CONFIGURED MCP server, and nothing else: a hook shell, a helper, a second
   *  keeper or a stray build is a leak. MEASURED 2026-09-30 (claude 2.1.284, node 22, aarch64 16 KB pages, the
   *  4-server heavy fixture, fake API, n=32 sessions incl. 8 on the final production-env harness): 6 processes
   *  in every run at both windows; tree memory 498-530 MB (keeper 52, CLI 275, each MCP server 51; swap 0);
   *  delete-to-zero 33-633 ms (n=28). Re-measure with
   *  `node scripts/session-budget/measure-procs.mjs --runs 8` before moving a number. */
  processes: Object.freeze({
    keeper: 1,
    cli: 1,
    /** Per configured MCP server (the report's `fixture.mcpServers`). */
    mcpPerConfiguredServer: 1,
    hook: 0,
    other: 0,
    /** Tree memory, MB (RSS + swapped-out, summed): base (keeper + CLI, measured 327) + per configured MCP server
     *  (measured 51). ~1.25× the measured max: the heavy fixture allows 660 (measured ≤ 530) — a CLI upgrade or
     *  keeper leak that grows the tree by a quarter must be looked at. Host-dependent (page size, node build). */
    memoryMB: Object.freeze({ base: 400, perMcpServer: 65 }),
  }),
  /** #210 — deleting the workspace through the real delete path. */
  afterDelete: Object.freeze({
    /** Nothing from the session tree may be alive once the delete has finished. */
    survivors: 0,
    /** …and it must be gone within this long of the delete call. */
    zeroWithinMs: 5000,
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
  /** The named process tree (#210), one line per process, present on a broken process/memory/delete verdict. */
  tree?: string[];
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

const mbOf = (kb: number): number => Math.round(kb / 1024);
/** Memory a process owns = resident + swapped-out (a paged-out leak is still a leak). */
const footprintKB = (p: { rssKB?: number; swapKB?: number }): number => (p.rssKB ?? 0) + (p.swapKB ?? 0);

/** `/path/node-22 /path/keeper.js ws-sb …` → `node-22 keeper.js ws-sb …` (a tree line must be readable, not a scratch path). */
function shortCmd(cmd: string): string {
  const t = cmd.split(' ');
  const base = (x: string | undefined) => (x ? x.slice(x.lastIndexOf('/') + 1) : '');
  const head = t[0]?.includes('/') ? [base(t[0]), t[1]?.includes('/') ? base(t[1]) : t[1], ...t.slice(2)] : t;
  const out = head.filter((x) => x !== undefined && x !== '').join(' ');
  return out.length > 90 ? `${out.slice(0, 89)}…` : out;
}

/** The session tree as indented text (children under their parent inside the given set), one line per process:
 *  `[pid] kind  12 MB  node-22 keeper.js ws-sb …`. Pure. What a broken process/memory/delete verdict names. */
export function formatProcessTree(procs: readonly ProcEntry[] | undefined): string[] {
  const list = procs ?? [];
  const pids = new Set(list.map((p) => p.pid));
  const kids = new Map<number, ProcEntry[]>();
  const roots: ProcEntry[] = [];
  for (const p of list) {
    if (p.ppid !== undefined && pids.has(p.ppid) && p.ppid !== p.pid) (kids.get(p.ppid) ?? kids.set(p.ppid, []).get(p.ppid)!).push(p);
    else roots.push(p);
  }
  const lines: string[] = [];
  const walk = (p: ProcEntry, depth: number): void => {
    const rss = p.rssKB === undefined ? '' : `${String(mbOf(footprintKB(p))).padStart(4)} MB  `;
    lines.push(`${'  '.repeat(depth)}[${p.pid}] ${p.kind.padEnd(6)} ${rss}${shortCmd(p.cmd)}`);
    for (const c of kids.get(p.pid) ?? []) walk(c, depth + 1);
  };
  for (const r of roots) walk(r, 0);
  return lines;
}

const withTree = (v: Verdict, tree: string[]): Verdict => (v.ok ? v : { ...v, tree });

/** #210 — process-count and memory verdicts at one census window. */
function processVerdicts(report: SessionBudgetReport, b: SessionBudgets['processes'], out: Verdict[]): void {
  const nMcp = report.fixture?.mcpServers ?? 0;
  const windows: Array<['atFirstReply' | 'atEnd', ProcessCensus | undefined, string]> = [
    ['atFirstReply', report.processes?.atFirstReply, 'the first reply'],
    ['atEnd', report.processes?.atEnd, 'the settled end'],
  ];
  for (const [when, c, label] of windows) {
    // A census that never saw the tree (lost pid-namespace view, wrong subtree) reads 0 and would pass every max.
    out.push(instrumentVerdict(`instrument.processCensus.${when}`, c?.total ?? null, 2 + nMcp, `the census at ${label} did not see the keeper + CLI + ${nMcp} MCP servers — a max-budget on it would pass vacuously`));
    if (!c?.byKind) continue;
    const tree = formatProcessTree(c.procs);
    const ctx = `${c.total} processes, ${mbOf(footprintKB(c))} MB (RSS+swap) at ${label}`;
    const limits: Array<[string, number]> = [
      ['keeper', b.keeper], ['cli', b.cli], ['mcp', b.mcpPerConfiguredServer * nMcp], ['hook', b.hook], ['other', b.other],
    ];
    for (const [kind, limit] of limits) {
      out.push(withTree(budgetVerdict(`session.processes.${when}.${kind}`, 'max', limit, c.byKind[kind as keyof typeof c.byKind], `${kind} processes — ${ctx}`), tree));
    }
    const totalLimit = limits.reduce((a, [, l]) => a + l, 0);
    out.push(withTree(budgetVerdict(`session.processes.${when}.total`, 'max', totalLimit, c.total, ctx), tree));
    const memLimit = b.memoryMB.base + b.memoryMB.perMcpServer * nMcp;
    out.push(withTree(budgetVerdict(`session.processes.${when}.memoryMB`, 'max', memLimit, mbOf(footprintKB(c)), `MB (RSS+swap) summed over the tree — ${ctx}`), tree));
  }
}

/** #210 — what survived deleting the workspace through the real delete path. */
function deleteVerdicts(report: SessionBudgetReport, b: SessionBudgets['afterDelete'], out: Verdict[]): void {
  const d = report.delete;
  if (!d) return;
  const nMcp = report.fixture?.mcpServers ?? 0;
  out.push(instrumentVerdict('instrument.delete.treeExistedBefore', d.treeBefore?.length ?? null, 2 + nMcp, `the tree was not there before the delete (${d.treeBefore?.length ?? 0} processes) — a zero after it proves nothing`));
  out.push(instrumentVerdict('instrument.delete.recordRemoved', d.storeRecordGone ? 1 : null, 1, `the delete (${d.via}) did not run to its end — the workspace record is still in the store`));
  out.push(instrumentVerdict('instrument.delete.ran', d.error ? null : 1, 1, `the delete (${d.via}) threw: ${(d.error ?? '').split('\n')[0]}`));
  const survivors = d.survivors ?? [];
  const before = new Set((d.treeBefore ?? []).map((p) => p.pid));
  const kinds = [...new Set(survivors.map((p) => p.kind))].join('+');
  out.push(withTree(
    budgetVerdict('session.delete.survivors', 'max', b.survivors, survivors.length, `after deleting the workspace via ${d.via} ${survivors.length} process(es) (${kinds || 'none'}) of its session tree were still alive ${d.boundMs} ms later`),
    survivorLines(survivors, before),
  ));
  const okT = d.elapsedMs !== null && d.elapsedMs <= b.zeroWithinMs;
  out.push({
    id: 'session.delete.zeroWithinMs', kind: 'budget', ok: okT, actual: d.elapsedMs, limit: `at most ${b.zeroWithinMs}`,
    message: okT ? `ok session.delete.zeroWithinMs: ${d.elapsedMs} (at most ${b.zeroWithinMs})` : `BUDGET BROKEN session.delete.zeroWithinMs: allowed at most ${b.zeroWithinMs} ms until zero processes, ${d.elapsedMs === null ? `never reached zero in ${d.boundMs} ms` : `took ${d.elapsedMs} ms`} (delete call returned after ${d.returnedMs} ms, via ${d.via})`,
    ...(okT ? {} : { tree: survivorLines(survivors, before) }),
  });
}

function survivorLines(survivors: readonly ProcEntry[], before: ReadonlySet<number>): string[] {
  return survivors.map((p) => `[${p.pid}] ${p.kind.padEnd(6)} ${p.rssKB === undefined ? '' : `${String(mbOf(footprintKB(p))).padStart(4)} MB  `}${shortCmd(p.cmd)}  (${before.has(p.pid) ? 'from the pre-delete tree' : 'NEW since the delete'})`);
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
    // Listed hosts get base + a retry allowance scaled by how long startup took (a slow-but-healthy run must PASS); an UNLISTED host is 0.
    const extra = startupRetryAllowance(report.timing?.startupEgressSpanMs);
    const egressBudget: Record<string, number> = {};
    for (const [h, n] of Object.entries(b.startupEgressAttempts)) egressBudget[h] = n + extra;
    verdicts.push(...mapVerdicts('session.beforeFirstReply.startupEgressAttempts', egressBudget, report.startupEgress ?? {},
      `${ctx}; before the main model request started (startup ${report.timing?.startupEgressSpanMs ?? '?'} ms, so +${extra} retry allowance on a listed host) it made egress attempts ${fmtMap(report.startupEgress)}`));
  }
  processVerdicts(report, budgets.processes, verdicts);
  deleteVerdicts(report, budgets.afterDelete, verdicts);
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
  const preEgress = Object.values(report.startupEgress ?? {}).reduce((a, b) => a + b, 0);
  verdicts.push(instrumentVerdict('instrument.nonessentialTrafficVisible', report.startupEgress ? preEgress : null, 1,
    'no outbound attempt was seen before the main request — either a traffic-suppressing knob leaked in, or the CLI stopped reaching out (then lower this deliberately)'));
  // A refused call is RETRIED by the CLI, so the pre-main attempt count of a KNOWN host grows with how long startup took: it is allowed
  // `startupRetryAllowance(span)` extra attempts (above) — a slow-but-healthy run PASSES. Only an absurd startup is not comparable: VOID.
  verdicts.push(flagVerdict('instrument.startupNotStalled', report.timing?.startupEgressSpanMs == null || report.timing.startupEgressSpanMs <= STARTUP_SPAN_MAX_MS,
    `startup egress burst took ${report.timing?.startupEgressSpanMs ?? 'n/a'} ms (≤ ${STARTUP_SPAN_MAX_MS})`,
    `the startup egress burst took ${report.timing?.startupEgressSpanMs} ms (> ${STARTUP_SPAN_MAX_MS}): startup was broken or stalled far beyond the CLI's own timeouts, so the attempt count is not comparable — re-run`));
  // F4 (round 2): the reported time-to-first-reply must be measured FROM sdkSend: ttfr + setup == the first-reply stamp (±2 ms of rounding).
  const tm = report.timing;
  const drift = tm && tm.timeToFirstReplyMs != null && tm.setupMs != null && tm.firstReplyAbsMs != null ? Math.abs(tm.timeToFirstReplyMs + tm.setupMs - tm.firstReplyAbsMs) : null;
  verdicts.push(flagVerdict('instrument.clockStartedAtSend', drift !== null && drift <= 2 && (tm?.setupMs ?? 0) >= 1,
    `timeToFirstReplyMs ${tm?.timeToFirstReplyMs} + setupMs ${tm?.setupMs} = firstReplyAbsMs ${tm?.firstReplyAbsMs} (±2 ms rounding)`,
    `timeToFirstReplyMs + setupMs must equal the first-reply stamp within 2 ms (${drift === null ? 'no timing' : `off by ${drift} ms`}) — the clock did not start at sdkSend`));
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
    `startup egress (before the main request started): ${fmtMap(report.startupEgress)}`,
  ];
}

/** The suite's last line. PASS only for a FULL run under full containment; a partial `--arm` run is PARTIAL and a run that needed
 *  the weak-containment opt-out is PASS-WEAK — the release gate accepts nothing but the exact `PASS` line. */
export function sessionBudgetTerminator(o: { voided: boolean; bad: boolean; partial: boolean; strongContainment: boolean }): 'VOID' | 'FAIL' | 'PARTIAL' | 'PASS-WEAK' | 'PASS' {
  if (o.voided) return 'VOID';
  if (o.bad) return 'FAIL';
  if (o.partial) return 'PARTIAL';
  return o.strongContainment ? 'PASS' : 'PASS-WEAK';
}
