// Field alarms on REAL sessions (#214) — PURE half. I/O + timer: src/main/session-budget-alarms.ts, run from the
// resource monitor's 60 s tick (src/main/resource-monitor.ts). Design + gates: docs/codebase-map/resources.md.
//
// Two derived quantities, each judged against src/shared/session-budget.ts (the ONE budget file — a number
// restated here is a defect, pinned by session-budget-alarms.test.ts):
//   1. requests per SESSION START, read off the per-session CLI debug log (#177): `[API REQUEST]` lines up to the
//      first reply — the same window the suite (#208) counts at its fake API.
//   2. child processes / RSS slope per session TREE, read off the resource monitor's samples (#198).
// One alarm per BREACH, not per sample: `AlarmLedger` fires on the false→true edge and re-arms on true→false.

import {
  SESSION_BUDGETS,
  budgetVerdict,
  mapVerdicts,
  type RequestCounts,
  type SessionBudgets,
  type Verdict,
} from './session-budget.ts';

/** The ONE prefix every field alarm line starts with (grep target). Never change it without the docs. */
export const SESSION_BUDGET_ALARM_PREFIX = 'session-budget-alarm:';

// ─── 1. Session-start window, from the CLI debug log ─────────────────────────

interface Dispatch {
  id: string;
  tsMs: number;
  main: boolean;
  model: string;
}

/** Incremental state for ONE debug log, from spawn to the session's first reply. `counts` has the suite's shape
 *  (#208): `main` = the user's turn (`source=sdk`), `side` = every other `/v1/messages` call keyed by model. */
export interface StartWindow {
  counts: RequestCounts;
  /** True once the first main request's first byte arrived — the window is shut, nothing more is counted. */
  closed: boolean;
  firstMainId: string | null;
  /** `/v1/messages` dispatches still awaiting a first byte (pairing pool). Bounded. */
  pending: Dispatch[];
  /** Models of `dispatching to firstParty model=…` lines not yet matched to their `[API REQUEST]` line (same order). */
  models: string[];
  seenIds: Set<string>;
  /** Synthetic ids for request lines that carry none (API-key auth against a custom base URL logs no
   *  `x-client-request-id=` — the suite's fake-API runs). Such requests can't be de-duplicated or error-linked. */
  seq: number;
}

export function newStartWindow(): StartWindow {
  return {
    counts: { model: 0, main: 0, side: {}, count_tokens: 0, other: 0, otherPaths: {}, egress: {}, total: 0 },
    closed: false, firstMainId: null, pending: [], models: [], seenIds: new Set(), seq: 0,
  };
}

const REQ_RE = /^(\S+Z) \[DEBUG\] \[API REQUEST\] (\S+)(?: x-client-request-id=(\S+))? source=(\S+)/;
const DISPATCH_RE = /\[API:timing\] dispatching to \S+ model=(\S+)/;
const FIRST_BYTE_RE = /^(\S+Z) \[DEBUG\] \[API:timing\] first byte after (\d+)ms/;
const API_ERROR_RE = /^\S+Z \[ERROR\] API error x-client-request-id=(\S+)/;
const PENDING_MAX = 64;
/** A first byte belongs to the dispatch at (its timestamp − its elapsed ms); the log clock skews a few ms. */
const PAIR_TOLERANCE_MS = 250;
/** The log's `source` of the user's turn (measured: 13403 of 13403 main turns in 169 real captures). */
const MAIN_SOURCE = 'sdk';

function uncount(w: StartWindow, d: Dispatch): void {
  w.counts.model--;
  w.counts.total--;
  if (d.main) w.counts.main--;
  else if (--w.counts.side[d.model] <= 0) delete w.counts.side[d.model];
}

/** Feed COMPLETE log lines (the caller cuts at the last newline). Lines after the window closed are ignored. */
export function feedStartWindow(w: StartWindow, text: string): void {
  for (const line of text.split('\n')) {
    if (w.closed) return;
    if (!line.includes('[API') && !line.includes('API error')) continue;
    const disp = DISPATCH_RE.exec(line);
    if (disp) {
      w.models.push(disp[1]);
      if (w.models.length > PENDING_MAX) w.models.shift();
      continue;
    }
    const req = REQ_RE.exec(line);
    if (req) {
      const [, ts, path, realId, source] = req;
      const id = realId ?? `#${w.seq++}`;
      if (realId !== undefined) {
        if (w.seenIds.has(id)) continue; // one id = one request (a retry/duplicate line is not a second one)
        w.seenIds.add(id);
      }
      const c = w.counts;
      c.total++;
      if (path.endsWith('/count_tokens')) {
        c.count_tokens++;
      } else if (path === '/v1/messages') {
        const model = w.models.shift() ?? 'unknown';
        const main = source === MAIN_SOURCE;
        c.model++;
        if (main) c.main++;
        else c.side[model] = (c.side[model] ?? 0) + 1;
        w.pending.push({ id, tsMs: Date.parse(ts), main, model });
        if (w.pending.length > PENDING_MAX) w.pending.shift();
        if (main && w.firstMainId === null) w.firstMainId = id;
      } else {
        c.other++;
        c.otherPaths[`? ${path}`] = (c.otherPaths[`? ${path}`] ?? 0) + 1;
      }
      continue;
    }
    const err = API_ERROR_RE.exec(line);
    if (err) {
      // A model call that errored is an availability event (429/529…), not budget drift: un-count it.
      const i = w.pending.findIndex((p) => p.id === err[1]);
      if (i >= 0) {
        uncount(w, w.pending[i]);
        if (w.firstMainId === err[1]) w.firstMainId = null;
        w.pending.splice(i, 1);
      }
      continue;
    }
    const fb = FIRST_BYTE_RE.exec(line);
    if (fb && w.pending.length > 0) {
      const dispatchedAt = Date.parse(fb[1]) - Number(fb[2]);
      // One-to-one, nearest dispatch time (two requests can leave within the same ms: title + opening turn).
      let best = 0;
      for (let i = 1; i < w.pending.length; i++) {
        if (Math.abs(w.pending[i].tsMs - dispatchedAt) < Math.abs(w.pending[best].tsMs - dispatchedAt)) best = i;
      }
      if (Math.abs(w.pending[best].tsMs - dispatchedAt) > PAIR_TOLERANCE_MS) best = 0; // clock trouble: FIFO
      const [d] = w.pending.splice(best, 1);
      if (d.id === w.firstMainId) w.closed = true;
    }
  }
}

const fmtSide = (m: Record<string, number>): string => {
  const e = Object.entries(m).sort(([a], [b]) => (a < b ? -1 : 1));
  return e.length ? `{${e.map(([k, v]) => `${k}:${v}`).join(', ')}}` : '{}';
};

/** The request budgets this window has BROKEN so far (verdicts with ok=false), by the suite's own verdict builders. A
 *  window only grows, so an over-limit count is a definite breach even before the first reply; "exactly N" main calls is
 *  judged as an upper bound (a shortfall is the suite's instrument, not a cost) — hence `max`. NOT judged: the startup
 *  egress attempts (`startupEgressAttempts`) — a debug log records no refused connections. */
export function startWindowBreaches(w: StartWindow, budgets: SessionBudgets = SESSION_BUDGETS): Verdict[] {
  const b = budgets.beforeFirstReply;
  const c = w.counts;
  const ctx = `before the first reply${w.closed ? '' : ' (window still open — count is a lower bound)'} the session sent model=${c.model} count_tokens=${c.count_tokens} other=${c.other} | main=${c.main} side=${fmtSide(c.side)}`;
  return [
    budgetVerdict('session.beforeFirstReply.modelRequests', 'max', b.modelRequests, c.main, ctx),
    ...mapVerdicts('session.beforeFirstReply.sideModelRequests', b.sideModelRequests, c.side, ctx),
    budgetVerdict('session.beforeFirstReply.countTokensRequests', 'max', b.countTokensRequests, c.count_tokens, ctx),
    budgetVerdict('session.beforeFirstReply.otherRequests', 'max', b.otherRequests, c.other, ctx),
  ].filter((v) => !v.ok);
}

// ─── 2. Session tree, from the resource monitor's samples ────────────────────

export interface TreeSample {
  at: number;
  procCount: number;
  rssBytes: number;
  /** The workspace's store status at the sample. Only `idle` samples are judged. */
  status: string | null;
  /** True while the session owns live background work (a running background task, an armed cron/loop): its
   *  children are the work, not a leak (OPS ruling 2026-09-30). */
  background: boolean;
}

/** A SETTLED sample: the turn is over and nothing was left running on purpose — what `processes` (#210) budgets. */
export const isSettled = (s: TreeSample): boolean => s.status === 'idle' && !s.background;

/** Append a sample and trim to what the budgets can still look at (the slope window + a little slack). */
export function pushTreeSample(history: TreeSample[], s: TreeSample, budgets: SessionBudgets = SESSION_BUDGETS): TreeSample[] {
  const f = budgets.field;
  const keepFrom = s.at - Math.max(f.slopeWindowMs, f.settledSamples * 90_000) - 120_000;
  const next = [...history, s].filter((x) => x.at >= keepFrom);
  return next.length > 0 ? next : [s];
}

const MIB = 1024 * 1024;
const mb = (bytes: number): string => `${(bytes / MIB).toFixed(0)} MB`;

/** How many processes `SESSION_BUDGETS.processes` allows a settled tree with `mcpStdio` stdio MCP servers — DERIVED by
 *  import, no number of its own (#210: keeper + cli + one per configured server + hook + other).
 *  Tree MEMORY is deliberately not judged in the field: `processes.memoryMB` is calibrated on the fixture's first-reply /
 *  settled window, and real settled skeleton trees (no child beyond the limit) sit at p50 0.82 / p90 1.01 / p99 1.10 /
 *  max 1.15 × it (3271 idle samples, 69 sessions, 6.8 h, real units) — 12.6 % of them over. Growth is judged by slope. */
export function maxTreeProcesses(mcpStdio: number, budgets: SessionBudgets = SESSION_BUDGETS): number {
  const p = budgets.processes;
  return p.keeper + p.cli + p.mcpPerConfiguredServer * mcpStdio + p.hook + p.other;
}

/** Distinct MCP servers a CLI debug log shows connected over STDIO (each is a child process; an HTTP server has none). */
export function countStdioMcpServers(text: string): number {
  const names = new Set<string>();
  for (const m of text.matchAll(/MCP server "([^"]+)": Successfully connected \(transport: stdio\)/g)) names.add(m[1]);
  return names.size;
}

/** Least-squares slope in bytes/min over `pts` (≥2 points, non-degenerate time span), else null. */
export function rssSlopeBytesPerMin(pts: Array<{ at: number; rssBytes: number }>): number | null {
  const n = pts.length;
  if (n < 2) return null;
  const t0 = pts[0].at;
  const xs = pts.map((p) => (p.at - t0) / 60_000);
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = pts.reduce((a, p) => a + p.rssBytes, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i] - mx) * (pts[i].rssBytes - my);
    den += (xs[i] - mx) ** 2;
  }
  return den > 0 ? num / den : null;
}

/** The trailing run of consecutive SETTLED samples (a running or background-busy sample ends the run). */
export function settledRun(history: TreeSample[]): TreeSample[] {
  let i = history.length;
  while (i > 0 && isSettled(history[i - 1])) i--;
  return history.slice(i);
}

/**
 * The tree budgets this history has BROKEN right now (ok=false verdicts). Sustained and settled, never instantaneous:
 *  - `session.processes.atEnd.total` (the #210 budget, at its "settled end" window): the last `settledSamples`
 *    samples are ALL settled and ALL over the limit derived from `processes` for `mcpStdio` servers.
 *    `mcpStdio === null` (server count unknown) ⇒ not judged — a limit is never guessed.
 *  - `session.field.settledRssSlopeBytesPerMin`: RSS growth of the settled run over the trailing window.
 */
export function treeBreaches(history: TreeSample[], mcpStdio: number | null, budgets: SessionBudgets = SESSION_BUDGETS): Verdict[] {
  const f = budgets.field;
  const out: Verdict[] = [];
  const run = settledRun(history);
  const tail = run.slice(-f.settledSamples);
  if (mcpStdio !== null && tail.length === f.settledSamples) {
    const limit = maxTreeProcesses(mcpStdio, budgets);
    if (tail.every((s) => s.procCount > limit)) {
      const held = `settled (idle, no background work) for ${f.settledSamples} consecutive samples (~${f.settledSamples} min) with ${mcpStdio} stdio MCP server(s)`;
      out.push(budgetVerdict('session.processes.atEnd.total', 'max', limit, tail[tail.length - 1].procCount, `${held}; peak ${Math.max(...tail.map((s) => s.procCount))} processes`));
    }
  }
  if (run.length > 0) {
    const latest = run[run.length - 1].at;
    const win = run.filter((s) => s.at >= latest - f.slopeWindowMs);
    const span = win.length > 1 ? win[win.length - 1].at - win[0].at : 0;
    if (win.length >= f.slopeMinSamples && span >= 0.8 * f.slopeWindowMs) {
      const slope = rssSlopeBytesPerMin(win);
      if (slope !== null) {
        out.push(budgetVerdict('session.field.settledRssSlopeBytesPerMin', 'max', f.maxIdleRssSlopeBytesPerMin, Math.round(slope),
          `settled RSS grew ${mb(slope)}/min over ${(span / 60_000).toFixed(0)} min (${win.length} samples), now ${mb(win[win.length - 1].rssBytes)}`));
      }
    }
  }
  return out.filter((v) => !v.ok);
}

// ─── One alarm per breach ────────────────────────────────────────────────────

/** Edge detector: `transition(owner, breachedNow)` returns the ids that BEGAN breaching this call; an id that is
 *  no longer breached is re-armed (a later breach alarms again). Owners are independent (one per session). */
export class AlarmLedger {
  private readonly active = new Map<string, Set<string>>();

  transition(owner: string, breachedNow: readonly string[]): string[] {
    const prev = this.active.get(owner) ?? new Set<string>();
    const now = new Set(breachedNow);
    const began = [...now].filter((id) => !prev.has(id));
    if (now.size === 0) this.active.delete(owner);
    else this.active.set(owner, now);
    return began;
  }

  forget(owner: string): void {
    this.active.delete(owner);
  }

  owners(): string[] {
    return [...this.active.keys()];
  }
}

export interface BudgetAlarm {
  session: string;
  /** Human label (workspace name/branch) when known. */
  label: string | null;
  verdict: Verdict;
  /** What the measurement was read from, e.g. `debug log <file>` / `resource sample <iso>`. */
  source: string;
}

/** `session-budget-alarm: session <id> (<label>) — BUDGET BROKEN <budget>: allowed <limit>, saw <n> — <detail> [<source>]`. */
export function formatBudgetAlarm(a: BudgetAlarm): string {
  const who = a.label ? `${a.session} (${a.label})` : a.session;
  return `${SESSION_BUDGET_ALARM_PREFIX} session ${who} — ${a.verdict.message} [${a.source}]`;
}
