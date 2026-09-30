// Load/soak campaign (C5 #212) — the PURE half: slope math, the D7 abort/preflight decisions, the raw-lines → report builder, the judge
// and the formatters. No I/O, no Electron; runs under `node --experimental-strip-types`. The numbers live in session-budget.ts
// (`SOAK_BUDGETS`); the collector is scripts/session-budget/soak-runner.mjs (emits `{"soak":…}` lines), the driver soak-lib.mjs.
// Design + traps: docs/codebase-map/session-budget.md §Load/soak campaign.
import { SOAK_BUDGETS, type Judgement, type Verdict } from './session-budget.ts';

// ── D7: resource caps ───────────────────────────────────────────────────────────────────────────────────────────────────────────
export interface SoakCaps { minMemAvailKB: number; maxLoad1: number }

/** The abort decision, taken before the start (`preflight`) AND at every sample. Fails CLOSED: an unreadable reading aborts (never run blind). */
export function decideAbort(now: { memAvailKB: number; load1: number }, caps: SoakCaps): { reason: 'low-ram' | 'high-load' | 'unreadable-resources'; detail: string } | null {
  if (!Number.isFinite(now.memAvailKB) || !Number.isFinite(now.load1)) return { reason: 'unreadable-resources', detail: `MemAvailable=${now.memAvailKB} load1=${now.load1} — cannot judge the machine, so not running` };
  if (now.memAvailKB < caps.minMemAvailKB) return { reason: 'low-ram', detail: `free RAM ${(now.memAvailKB / 1048576).toFixed(1)} GB < ${(caps.minMemAvailKB / 1048576).toFixed(1)} GB` };
  if (now.load1 > caps.maxLoad1) return { reason: 'high-load', detail: `load ${now.load1.toFixed(1)} > ${caps.maxLoad1}` };
  return null;
}

/** A per-run cap override can only TIGHTEN the D7 caps (more free RAM required, lower load allowed) — never loosen them. */
export function tightenCaps(base: SoakCaps, override?: Partial<SoakCaps> | null): SoakCaps {
  return {
    minMemAvailKB: Math.max(base.minMemAvailKB, override?.minMemAvailKB ?? 0),
    maxLoad1: Math.min(base.maxLoad1, override?.maxLoad1 ?? Infinity),
  };
}

export interface SoakParams {
  sessions: number; durationSec: number; turnIntervalSec: number; sampleSec: number; turnDeadlineSec: number; replyDelayMs: number;
}

/** Refusals (empty = go) BEFORE anything is spawned: the session cap, sane timings, and the projected footprint against the RAM floor. */
export function preflight(o: { params: SoakParams; memAvailKB: number; load1: number }, b = SOAK_BUDGETS): string[] {
  const { params: p } = o;
  const out: string[] = [];
  if (!Number.isInteger(p.sessions) || p.sessions < 1) out.push(`sessions must be an integer ≥ 1 (got ${p.sessions})`);
  if (p.sessions > b.maxSessions) out.push(`sessions=${p.sessions} exceeds the D7 cap of ${b.maxSessions} concurrent sessions (ledger #237 D7; raise SOAK_BUDGETS.maxSessions deliberately, never per run)`);
  if (!(p.durationSec >= 60)) out.push(`duration must be ≥ 60 s (got ${p.durationSec}) — a shorter run has no post-warm-up window to slope over`);
  if (!(p.sampleSec >= 1) || !(p.turnIntervalSec >= 1) || !(p.turnDeadlineSec >= 5)) out.push(`sample/turn-interval must be ≥ 1 s and the turn deadline ≥ 5 s`);
  const why = decideAbort({ memAvailKB: o.memAvailKB, load1: o.load1 }, { minMemAvailKB: b.minMemAvailKB, maxLoad1: b.maxLoad1 });
  if (why) out.push(`machine not fit to start: ${why.detail}`);
  else {
    const needKB = (b.projected.baseMB + Math.max(0, p.sessions) * b.projected.perSessionMB) * 1024;
    if (o.memAvailKB - needKB < b.minMemAvailKB) {
      out.push(`projected footprint of ${p.sessions} session(s) ≈ ${(needKB / 1048576).toFixed(1)} GB would leave ${((o.memAvailKB - needKB) / 1048576).toFixed(1)} GB free (< the ${(b.minMemAvailKB / 1048576).toFixed(1)} GB floor); available ${(o.memAvailKB / 1048576).toFixed(1)} GB — use fewer sessions or wait`);
    }
  }
  return out;
}

// ── statistics ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────
export const median = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
/** Nearest-rank percentile of an ascending-sorted array (p in 0..100). */
export const percentile = (sortedAsc: number[], p: number): number | null => (sortedAsc.length ? sortedAsc[Math.min(sortedAsc.length - 1, Math.max(0, Math.ceil((p / 100) * sortedAsc.length) - 1))] : null);

/** Ordinary least-squares slope of y over x (y-units per x-unit); null with < 2 points or no x spread. */
export function olsSlope(pts: Array<[number, number]>): number | null {
  const n = pts.length;
  if (n < 2) return null;
  const mx = pts.reduce((a, p) => a + p[0], 0) / n;
  const my = pts.reduce((a, p) => a + p[1], 0) / n;
  let num = 0, den = 0;
  for (const [x, y] of pts) { num += (x - mx) * (y - my); den += (x - mx) ** 2; }
  return den === 0 ? null : num / den;
}

/** Theil–Sen slope: the MEDIAN of all pairwise slopes — robust to a GC/compaction spike that drags an OLS fit. Evenly thinned to ≤ 400 points. */
export function theilSenSlope(pts: Array<[number, number]>): number | null {
  if (pts.length < 2) return null;
  const P = pts.length > 400 ? pts.filter((_, i) => i % Math.ceil(pts.length / 400) === 0) : pts;
  const slopes: number[] = [];
  for (let i = 0; i < P.length; i++) for (let j = i + 1; j < P.length; j++) if (P[j][0] !== P[i][0]) slopes.push((P[j][1] - P[i][1]) / (P[j][0] - P[i][0]));
  return median(slopes);
}

// ── the raw lines the runner emits ──────────────────────────────────────────────────────────────────────────────────────────────
export interface SoakKinds { cli: number; keeper: number; mcp: number; hook: number; other: number }
export interface SoakSampleSession { i: number; rssKB: number | null; swapKB: number; procs: number; k: SoakKinds; apiMain: number | null; apiHeld: number }
export interface SoakSample {
  tSec: number; phase: 'boot' | 'run' | 'end'; memAvailKB: number; load1: number;
  runnerRssKB: number | null; runnerSwapKB?: number; apiRssKB: number | null; apiSwapKB?: number; strays: number; strayKinds: string[]; s: SoakSampleSession[];
}
export interface SoakTurn { i: number; n: number; tSec: number; ms: number; outcome: 'ok' | 'error' | 'wedged' | 'unfinished'; phase: 'startup' | 'steady'; err?: string | null }
export interface SoakEvent { tSec: number; kind: string; i?: number; detail?: string }
export interface SoakStart {
  at: string; sessions: number; durationMs: number; turnIntervalMs: number; sampleMs: number; turnDeadlineMs: number; replyDelayMs: number; containment: string; pidns: boolean;
  cli: { version: string; path: string }; fixture: { skills: number; memoryFiles: number; mcpServers: number; toolsPerServer: number; claudeMdKB: number };
  seedLeak: { session: number; mbPerMin: number } | null; faultPlan: unknown; caps: SoakCaps; pageKB: number; nproc: number;
}
export interface SoakSurvivor { pid: number; kind: string; session: number | null; rssKB: number; cmd: string }
export interface SoakFinal {
  cli: { version: string; path: string }; containment: string; aborted: { reason: string; detail: string; tSec: number } | null; tSec: number;
  init: Array<{ i: number; mcpConnected: number | null; tools: number | null }>;
  sessions: Array<{ i: number; sent: number; turnEnds: number; errors: number; lastError: string | null; wedged: boolean }>;
  survivors: { total: number; zombies: number; list: SoakSurvivor[]; teardownErrors: Array<{ i: number; error: string }> };
  api: { totals: Record<string, number>; sessions: Record<string, { model: number; main: number; side: number; count_tokens: number; other: number; held: number }>; rssKB: number } | null;
  endTree: Array<{ i: number; procs: number; k: SoakKinds }>;
}
export interface SoakRaw {
  start: SoakStart | null; samples: SoakSample[]; turns: SoakTurn[]; events: SoakEvent[];
  abort: { reason: string; detail: string; tSec: number } | null; final: SoakFinal | null;
  /** The harness-level failure text when the runner produced no `final` (crash, kill, timeout). */
  harnessError?: string | null;
}

/** Parse one runner stdout line into `raw` (ignores anything that is not a `{"soak":…}` line). Returns true when it was one. */
export function ingestSoakLine(raw: SoakRaw, line: string): boolean {
  if (!line.startsWith('{"soak":')) return false;
  let o: any;
  try { o = JSON.parse(line); } catch { return false; }
  switch (o.soak) {
    case 'start': raw.start = o; break;
    case 'sample': raw.samples.push(o); break;
    case 'turn': raw.turns.push(o); break;
    case 'event': raw.events.push(o); break;
    case 'abort': raw.abort = { reason: o.reason, detail: o.detail, tSec: o.tSec }; break;
    case 'final': raw.final = o; break;
    default: return false;
  }
  return true;
}
export const emptyRaw = (): SoakRaw => ({ start: null, samples: [], turns: [], events: [], abort: null, final: null, harnessError: null });

// ── the report ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────
export interface SeriesSummary {
  /** Samples in the whole run / inside the post-warm-up window. */
  n: number; windowN: number; startMB: number | null; endMB: number | null; peakMB: number | null;
  /** Theil–Sen (judged) and OLS slope over the window, MB/min; growth = median of the last 3 window samples − median of the first 3. */
  slopeMBPerMin: number | null; olsMBPerMin: number | null; growthMB: number | null;
}
export interface SoakReport {
  schema: 1; kind: 'soak'; status: 'COMPLETE' | 'ABORTED' | 'BROKE';
  aborted?: { reason: string; detail: string; tSec: number };
  error?: string;
  startedAt: string | null; endedAt: string;
  subject: { cli: { version: string; path: string } | null; containment: string | null; meta: Record<string, unknown> };
  params: { sessions: number; durationSec: number; turnIntervalSec: number; sampleSec: number; turnDeadlineSec: number; replyDelayMs: number; seedLeak: SoakStart['seedLeak']; faultPlan: unknown; fixture: SoakStart['fixture'] | null };
  conditions: { memAvailKB: { start: number | null; min: number | null; end: number | null }; load1: { start: number | null; max: number | null; end: number | null }; nproc: number | null; pageKB: number | null };
  wedge: {
    turns: number; ok: number; errors: number; wedged: number; unfinished: number; wedgedTurnRate: number | null; errorTurnRate: number | null; wedgedSessions: number[];
    bySession: Array<{ i: number; turns: number; ok: number; errors: number; wedged: number; firstWedgeAtSec: number | null }>;
    byPhase: Record<'startup' | 'steady', { turns: number; errors: number; wedged: number }>;
    byThird: Array<{ fromSec: number; toSec: number; turns: number; errors: number; wedged: number }>;
  };
  latency: { n: number; p50: number | null; p95: number | null; p99: number | null; max: number | null };
  memory: {
    warmupSec: number; window: { fromSec: number; toSec: number; samples: number };
    sessions: Array<SeriesSummary & { i: number }>; runner: SeriesSummary; api: SeriesSummary; total: SeriesSummary;
    worstSession: { i: number; slopeMBPerMin: number } | null; medianSessionSlopeMBPerMin: number | null;
  };
  processes: {
    peakPerSession: Array<{ i: number; procs: number; k: SoakKinds }>; peakTotal: number; strayMax: number; strayAtEnd: number | null;
    survivorsAfterDelete: { total: number | null; zombies: number | null; byKind: Record<string, number>; bySession: Record<string, number>; list: SoakSurvivor[]; teardownErrors: Array<{ i: number; error: string }> };
  };
  api: SoakFinal['api'];
  /** Per session, from its first `session/init`: how many fixture MCP servers were connected. */
  init: SoakFinal['init'];
  errors: { byMessage: Record<string, number> };
  /** tSec/MB pairs for every sample (decimated to ≤ 720 points): one array per session, then the runner and the API process. */
  series: { sessions: Array<Array<[number, number]>>; runner: Array<[number, number]>; api: Array<[number, number]>; memAvailGB: Array<[number, number]> };
  verdicts?: Verdict[];
  judgement?: { ok: boolean; void: boolean; aborted: boolean };
}

const MB = (kb: number | null | undefined): number | null => (kb == null ? null : Math.round((kb / 1024) * 10) / 10);
const r2 = (x: number | null): number | null => (x == null ? null : Math.round(x * 100) / 100);
function thin<T>(a: T[], max: number): T[] {
  return a.length <= max ? a : a.filter((_, i) => i % Math.ceil(a.length / max) === 0);
}

function summarizeSeries(pts: Array<[number, number]>, fromSec: number): SeriesSummary {
  const win = pts.filter((p) => p[0] >= fromSec);
  const first = median(win.slice(0, 3).map((p) => p[1]));
  const last = median(win.slice(-3).map((p) => p[1]));
  const perMin = (s: number | null): number | null => (s == null ? null : r2(s * 60));
  return {
    n: pts.length, windowN: win.length, startMB: pts.length ? r2(pts[0][1]) : null, endMB: pts.length ? r2(pts[pts.length - 1][1]) : null,
    peakMB: pts.length ? r2(Math.max(...pts.map((p) => p[1]))) : null,
    slopeMBPerMin: perMin(theilSenSlope(win)), olsMBPerMin: perMin(olsSlope(win)), growthMB: first != null && last != null && win.length >= 2 ? r2(last - first) : null,
  };
}

/** Everything the campaign measured, as rates and their split. `meta` = facts only the driver knows (code id, git sha, node, keeper bundle…). */
export function buildSoakReport(raw: SoakRaw, meta: Record<string, unknown> = {}, budgets = SOAK_BUDGETS, endedAt = new Date().toISOString()): SoakReport {
  const st = raw.start;
  const samples = raw.samples;
  const N = st?.sessions ?? raw.final?.sessions.length ?? 0;
  const aborted = raw.abort ?? raw.final?.aborted ?? null;
  const status: SoakReport['status'] = aborted ? 'ABORTED' : raw.final ? 'COMPLETE' : 'BROKE';

  // conditions
  const memAv = samples.map((s) => s.memAvailKB).filter(Number.isFinite);
  const loads = samples.map((s) => s.load1).filter(Number.isFinite);
  const conditions = {
    memAvailKB: { start: memAv[0] ?? null, min: memAv.length ? Math.min(...memAv) : null, end: memAv.length ? memAv[memAv.length - 1] : null },
    load1: { start: loads[0] ?? null, max: loads.length ? Math.max(...loads) : null, end: loads.length ? loads[loads.length - 1] : null },
    nproc: st?.nproc ?? null, pageKB: st?.pageKB ?? null,
  };

  // wedge rates and their split
  const turns = raw.turns.filter((t) => t.outcome !== 'unfinished');
  const cnt = (xs: SoakTurn[]) => ({ turns: xs.length, ok: xs.filter((t) => t.outcome === 'ok').length, errors: xs.filter((t) => t.outcome === 'error').length, wedged: xs.filter((t) => t.outcome === 'wedged').length });
  const all = cnt(turns);
  const bySession = Array.from({ length: N }, (_, i) => {
    const mine = turns.filter((t) => t.i === i);
    const w = mine.filter((t) => t.outcome === 'wedged');
    return { i, ...cnt(mine), firstWedgeAtSec: w.length ? Math.min(...w.map((t) => t.tSec)) : null };
  });
  const span = Math.max(1, ...raw.turns.map((t) => t.tSec + t.ms / 1000), st ? st.durationMs / 1000 : 0);
  const byThird = [0, 1, 2].map((k) => {
    const from = (span * k) / 3, to = (span * (k + 1)) / 3;
    const xs = turns.filter((t) => t.tSec >= from && (t.tSec < to || (k === 2 && t.tSec <= span)));
    const c = cnt(xs);
    return { fromSec: Math.round(from), toSec: Math.round(to), turns: c.turns, errors: c.errors, wedged: c.wedged };
  });
  const phase = (p: 'startup' | 'steady') => { const c = cnt(turns.filter((t) => t.phase === p)); return { turns: c.turns, errors: c.errors, wedged: c.wedged }; };
  const okMs = turns.filter((t) => t.outcome === 'ok').map((t) => t.ms).sort((a, b) => a - b);
  const errorsByMessage: Record<string, number> = {};
  for (const t of turns) if (t.outcome === 'error') { const k = String(t.err ?? 'unknown').slice(0, 120); errorsByMessage[k] = (errorsByMessage[k] ?? 0) + 1; }

  // memory: rss + swapped-out per tree (paging cannot hide a leak), tSec on the runner's clock
  const durationSec = st ? st.durationMs / 1000 : (samples[samples.length - 1]?.tSec ?? 0);
  const warmupSec = Math.max(budgets.memory.minWarmupSec, budgets.memory.warmupFraction * durationSec);
  const perSession: Array<Array<[number, number]>> = Array.from({ length: N }, () => []);
  const runner: Array<[number, number]> = [], apiPts: Array<[number, number]> = [], total: Array<[number, number]> = [], avail: Array<[number, number]> = [];
  for (const s of samples) {
    let tot = 0, any = false;
    for (const ps of s.s) {
      if (ps.rssKB != null && perSession[ps.i]) { const kb = ps.rssKB + (ps.swapKB ?? 0); perSession[ps.i].push([s.tSec, kb / 1024]); tot += kb; any = true; }
    }
    if (s.runnerRssKB != null) { const kb = s.runnerRssKB + (s.runnerSwapKB ?? 0); runner.push([s.tSec, kb / 1024]); tot += kb; any = true; }
    if (s.apiRssKB != null) { const kb = s.apiRssKB + (s.apiSwapKB ?? 0); apiPts.push([s.tSec, kb / 1024]); tot += kb; any = true; }
    if (any) total.push([s.tSec, tot / 1024]);
    if (Number.isFinite(s.memAvailKB)) avail.push([s.tSec, s.memAvailKB / 1048576]);
  }
  const sessSummaries = perSession.map((pts, i) => ({ i, ...summarizeSeries(pts, warmupSec) }));
  const slopes = sessSummaries.filter((s) => s.slopeMBPerMin != null);
  const worst = slopes.length ? slopes.reduce((a, b) => ((b.slopeMBPerMin as number) > (a.slopeMBPerMin as number) ? b : a)) : null;
  const winSamples = samples.filter((s) => s.tSec >= warmupSec);

  // processes
  const peakPerSession = Array.from({ length: N }, (_, i) => {
    let best = { i, procs: 0, k: { cli: 0, keeper: 0, mcp: 0, hook: 0, other: 0 } as SoakKinds };
    for (const s of samples) { const ps = s.s.find((x) => x.i === i); if (ps && ps.procs > best.procs) best = { i, procs: ps.procs, k: ps.k }; }
    return best;
  });
  let peakTotal = 0;
  for (const s of samples) peakTotal = Math.max(peakTotal, s.s.reduce((a, x) => a + x.procs, 0));
  const endSample = [...samples].reverse().find((s) => s.phase === 'end') ?? null;
  const surv = raw.final?.survivors ?? null;
  const byKind: Record<string, number> = {}, bySess: Record<string, number> = {};
  for (const p of surv?.list ?? []) { byKind[p.kind] = (byKind[p.kind] ?? 0) + 1; const k = p.session == null ? 'unattributed' : `s${p.session}`; bySess[k] = (bySess[k] ?? 0) + 1; }

  return {
    schema: 1, kind: 'soak', status,
    ...(aborted ? { aborted } : {}),
    ...(status === 'BROKE' ? { error: raw.harnessError ?? 'the runner produced no final line (crash, kill or timeout)' } : {}),
    startedAt: st?.at ?? null, endedAt,
    subject: { cli: raw.final?.cli ?? st?.cli ?? null, containment: raw.final?.containment ?? st?.containment ?? null, meta },
    params: { sessions: N, durationSec, turnIntervalSec: (st?.turnIntervalMs ?? 0) / 1000, sampleSec: (st?.sampleMs ?? 0) / 1000, turnDeadlineSec: (st?.turnDeadlineMs ?? 0) / 1000, replyDelayMs: st?.replyDelayMs ?? 0, seedLeak: st?.seedLeak ?? null, faultPlan: st?.faultPlan ?? null, fixture: st?.fixture ?? null },
    conditions,
    wedge: {
      ...all, unfinished: raw.turns.length - turns.length,
      wedgedTurnRate: all.turns ? all.wedged / all.turns : null, errorTurnRate: all.turns ? all.errors / all.turns : null,
      wedgedSessions: bySession.filter((s) => s.wedged > 0).map((s) => s.i), bySession, byPhase: { startup: phase('startup'), steady: phase('steady') }, byThird,
    },
    latency: { n: okMs.length, p50: percentile(okMs, 50), p95: percentile(okMs, 95), p99: percentile(okMs, 99), max: okMs.length ? okMs[okMs.length - 1] : null },
    memory: {
      warmupSec: Math.round(warmupSec), window: { fromSec: Math.round(warmupSec), toSec: samples.length ? Math.round(samples[samples.length - 1].tSec) : 0, samples: winSamples.length },
      sessions: sessSummaries, runner: summarizeSeries(runner, warmupSec), api: summarizeSeries(apiPts, warmupSec), total: summarizeSeries(total, warmupSec),
      worstSession: worst ? { i: worst.i, slopeMBPerMin: worst.slopeMBPerMin as number } : null, medianSessionSlopeMBPerMin: r2(median(slopes.map((s) => s.slopeMBPerMin as number))),
    },
    processes: {
      peakPerSession, peakTotal, strayMax: samples.reduce((a, s) => Math.max(a, s.strays), 0), strayAtEnd: endSample ? endSample.strays : null,
      survivorsAfterDelete: { total: surv ? surv.total : null, zombies: surv ? surv.zombies : null, byKind, bySession: bySess, list: surv?.list ?? [], teardownErrors: surv?.teardownErrors ?? [] },
    },
    api: raw.final?.api ?? null,
    init: raw.final?.init ?? [],
    errors: { byMessage: errorsByMessage },
    series: { sessions: perSession.map((p) => thin(p.map(([t, v]) => [t, r2(v) as number] as [number, number]), 720)), runner: thin(runner.map(([t, v]) => [t, r2(v) as number] as [number, number]), 720), api: thin(apiPts.map(([t, v]) => [t, r2(v) as number] as [number, number]), 720), memAvailGB: thin(avail.map(([t, v]) => [t, r2(v) as number] as [number, number]), 720) },
  };
}

// ── the judge ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const maxV = (id: string, limit: number, actual: number, ctx: string): Verdict => ({
  id, kind: 'budget', ok: actual <= limit, actual, limit: `at most ${limit}`,
  message: actual <= limit ? `ok ${id}: ${actual} (at most ${limit})` : `BUDGET BROKEN ${id}: allowed at most ${limit}, saw ${actual} — ${ctx}`,
});
const need = (id: string, ok: boolean, okMsg: string, voidMsg: string): Verdict => ({ id, kind: 'instrument', ok, actual: ok ? 1 : null, limit: 'required', message: ok ? `ok ${id}: ${okMsg}` : `INSTRUMENT VOID ${id}: ${voidMsg}` });

/** Judge a campaign report. An ABORTED run is judged nothing (its rates are printed, not verdicts); a BROKE run is VOID; otherwise one
 *  verdict per rate/slope/leftover named by session, plus instrument checks proving the subject mounted (a vacuous 0 must not pass). */
export function judgeSoak(report: SoakReport, budgets = SOAK_BUDGETS): Judgement & { aborted: boolean } {
  const v: Verdict[] = [];
  if (report.status === 'ABORTED') return { ok: false, void: false, aborted: true, verdicts: [] };
  const fx = report.params.fixture;
  const N = report.params.sessions;
  v.push(need('soak.instrument.runCompleted', report.status === 'COMPLETE', 'the runner ran to its final line', `the runner did not finish: ${report.error ?? report.status}`));
  v.push(need('soak.instrument.containment', report.subject.containment === 'netns+pidns', 'netns+pidns', `containment=${report.subject.containment ?? 'unknown'}, need netns+pidns — egress was not contained, so nothing was measured`));
  v.push(need('soak.instrument.sessionsMounted', N >= 1 && report.processes.peakPerSession.length === N && report.processes.peakPerSession.every((p) => p.k.cli >= 1 && p.k.keeper >= 1 && p.k.mcp >= (fx?.mcpServers ?? 1)),
    `every session showed keeper + CLI + ${fx?.mcpServers ?? '?'} MCP children`, `a session never showed keeper + CLI + ${fx?.mcpServers ?? '?'} MCP children (peak per session: ${report.processes.peakPerSession.map((p) => `s${p.i}=${p.k.keeper}/${p.k.cli}/${p.k.mcp}`).join(' ')}) — the subject never mounted`));
  const apiSess = report.api?.sessions ?? {};
  v.push(need('soak.instrument.trafficAttributed', N >= 1 && Array.from({ length: N }, (_, i) => (apiSess[`s${i}`]?.main ?? 0) >= 1).every(Boolean) && !apiSess.unknown,
    'the fake API saw main requests from every session, all under a soak key', `the fake API must see ≥ 1 main request from each of s0..s${N - 1} and nothing under an unknown key (saw: ${Object.entries(apiSess).map(([k, x]) => `${k}=${x.main}`).join(' ') || 'nothing'}) — session/key wiring or the API is broken`));
  const init = report.init;
  v.push(need('soak.instrument.mcpConnected', !!fx && N >= 1 && init.length === N && init.every((x) => x.mcpConnected === fx.mcpServers),
    `every session connected all ${fx?.mcpServers ?? '?'} fixture MCP servers`, `each session must report ${fx?.mcpServers ?? '?'} connected fixture MCP servers at init (saw ${init.map((x) => `s${x.i}=${x.mcpConnected ?? '?'}`).join(' ') || 'nothing'}) — the subject is lighter than the fixture claims`));
  const minWin = budgets.memory.minWindowSec;
  const winSec = report.memory.window.toSec - report.memory.window.fromSec;
  v.push(need('soak.instrument.memoryWindow', winSec >= minWin && report.memory.window.samples >= budgets.memory.minSamples,
    `${report.memory.window.samples} samples over ${winSec} s after the ${report.memory.warmupSec} s warm-up`,
    `the post-warm-up window has ${report.memory.window.samples} sample(s) over ${winSec} s — need ≥ ${budgets.memory.minSamples} samples and ≥ ${minWin} s to fit a slope; run longer or sample faster`));
  v.push(need('soak.instrument.turnsRan', report.wedge.ok >= N, `${report.wedge.ok} turns completed`, `only ${report.wedge.ok} turn(s) completed across ${N} session(s) — the sessions never worked`));

  // wedge rate and its split
  v.push(maxV('soak.wedge.wedgedTurns', budgets.wedge.wedgedTurns, report.wedge.wedged, `${report.wedge.wedged} of ${report.wedge.turns} turns did not finish within ${report.params.turnDeadlineSec} s (rate ${report.wedge.wedgedTurnRate == null ? 'n/a' : (report.wedge.wedgedTurnRate * 100).toFixed(2)}%; startup ${report.wedge.byPhase.startup.wedged}, steady ${report.wedge.byPhase.steady.wedged})`));
  v.push(maxV('soak.wedge.wedgedSessions', budgets.wedge.wedgedSessions, report.wedge.wedgedSessions.length, `sessions wedged: ${report.wedge.wedgedSessions.map((i) => `s${i}`).join(', ') || 'none'}`));
  for (const s of report.wedge.bySession) v.push(maxV(`soak.wedge.session.s${s.i}`, 0, s.wedged, `s${s.i} wedged at ${s.firstWedgeAtSec ?? '?'} s (${s.ok} ok / ${s.errors} error / ${s.wedged} wedged of ${s.turns} turns)`));
  v.push(maxV('soak.errors.turns', budgets.wedge.errorTurns, report.wedge.errors, `${report.wedge.errors} turn(s) ended in an error event: ${JSON.stringify(report.errors.byMessage)}`));

  // memory slope per session + the app process
  for (const s of report.memory.sessions) {
    const slope = s.slopeMBPerMin;
    v.push(slope == null
      ? need(`soak.instrument.memorySeries.s${s.i}`, false, '', `s${s.i} has no usable RSS series (${s.windowN} window samples)`)
      : maxV(`soak.memory.slopeMBPerMin.s${s.i}`, budgets.memory.maxSessionSlopeMBPerMin, slope, `s${s.i} tree RSS ${s.startMB}→${s.endMB} MB (peak ${s.peakMB}), Theil–Sen ${slope} MB/min, OLS ${s.olsMBPerMin} MB/min, +${s.growthMB} MB over the ${report.memory.window.samples}-sample window`));
  }
  const rs = report.memory.runner.slopeMBPerMin;
  v.push(rs == null ? need('soak.instrument.memorySeries.runner', false, '', 'the app process has no usable RSS series')
    : maxV('soak.memory.slopeMBPerMin.runner', budgets.memory.maxRunnerSlopeMBPerMin, rs, `the app process RSS ${report.memory.runner.startMB}→${report.memory.runner.endMB} MB, Theil–Sen ${rs} MB/min, OLS ${report.memory.runner.olsMBPerMin} MB/min`));

  // processes
  const sv = report.processes.survivorsAfterDelete;
  v.push(sv.total == null ? need('soak.instrument.survivorsCounted', false, '', 'no census after the delete') : maxV('soak.processes.survivorsAfterDelete', budgets.processes.survivorsAfterDelete, sv.total,
    `after deleting all ${N} workspaces ${sv.total} process(es) remain: by kind ${JSON.stringify(sv.byKind)}, by session ${JSON.stringify(sv.bySession)}; ${sv.list.slice(0, 6).map((p) => `${p.pid} ${p.kind} ${p.cmd.slice(0, 60)}`).join(' | ')}`));
  v.push(report.processes.strayAtEnd == null ? need('soak.instrument.strayCounted', false, '', 'no end-of-run sample') : maxV('soak.processes.strayAtEnd', budgets.processes.strayAtEnd, report.processes.strayAtEnd, `${report.processes.strayAtEnd} process(es) outside every session tree at the end of the run (orphans)`));

  const voided = v.some((x) => x.kind === 'instrument' && !x.ok);
  return { ok: !voided && v.every((x) => x.ok), void: voided, aborted: false, verdicts: v };
}

/** The last line of a campaign. PARTIAL never exists: a run either measured (PASS/FAIL), was VOID, was ABORTED by a cap, or BROKE. */
export function soakTerminator(report: SoakReport, j: Judgement & { aborted: boolean }): 'PASS' | 'FAIL' | 'VOID' | 'ABORTED' | 'BROKE' {
  if (report.status === 'ABORTED') return 'ABORTED';
  if (report.status === 'BROKE') return 'BROKE';
  if (j.void) return 'VOID';
  return j.ok ? 'PASS' : 'FAIL';
}
export const soakExitCode = (t: ReturnType<typeof soakTerminator>): number => (t === 'PASS' ? 0 : t === 'FAIL' || t === 'BROKE' ? 1 : t === 'VOID' ? 3 : 4);

// ── formatters ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const pct = (x: number | null): string => (x == null ? 'n/a' : `${(x * 100).toFixed(2)}%`);
const gb = (kb: number | null): string => (kb == null ? 'n/a' : `${(kb / 1048576).toFixed(1)} GB`);

/** Human report (also the body of the .md file): rates first, each with its split. */
export function formatSoakText(r: SoakReport): string[] {
  const p = r.params;
  const L: string[] = [];
  L.push(`SOAK CAMPAIGN ${r.startedAt ?? '(never started)'} → ${r.endedAt} — status ${r.status}${r.aborted ? ` (${r.aborted.reason}: ${r.aborted.detail} at ${r.aborted.tSec} s)` : ''}${r.error ? ` — ${r.error}` : ''}`);
  L.push(`subject: claude ${r.subject.cli?.version ?? '?'} · containment ${r.subject.containment ?? '?'} · ${Object.entries(r.subject.meta).map(([k, x]) => `${k}=${typeof x === 'string' ? x : JSON.stringify(x)}`).join(' · ')}`);
  L.push(`params: ${p.sessions} sessions × ${p.durationSec} s, a turn every ~${p.turnIntervalSec} s (deadline ${p.turnDeadlineSec} s), sample every ${p.sampleSec} s, fake model latency ${p.replyDelayMs} ms${p.fixture ? `, fixture ${p.fixture.skills} skills / ${p.fixture.memoryFiles} rules / ${p.fixture.mcpServers}×${p.fixture.toolsPerServer} MCP` : ''}${p.seedLeak ? ` · SEEDED LEAK s${p.seedLeak.session} ${p.seedLeak.mbPerMin} MB/min` : ''}${p.faultPlan ? ` · FAULT PLAN ${JSON.stringify(p.faultPlan)}` : ''}`);
  L.push(`conditions: free RAM start ${gb(r.conditions.memAvailKB.start)} / min ${gb(r.conditions.memAvailKB.min)} / end ${gb(r.conditions.memAvailKB.end)} · load1 start ${r.conditions.load1.start ?? 'n/a'} / max ${r.conditions.load1.max ?? 'n/a'} / end ${r.conditions.load1.end ?? 'n/a'} · ${r.conditions.nproc ?? '?'} cpus · ${r.conditions.pageKB ?? '?'} KB pages`);
  const w = r.wedge;
  L.push(`WEDGE RATE: ${w.wedged}/${w.turns} turns = ${pct(w.wedgedTurnRate)} · sessions wedged ${w.wedgedSessions.length}/${p.sessions}${w.wedgedSessions.length ? ` (${w.wedgedSessions.map((i) => `s${i}`).join(', ')})` : ''} · errors ${w.errors} = ${pct(w.errorTurnRate)} · unfinished at abort ${w.unfinished}`);
  L.push(`  by phase: startup ${w.byPhase.startup.wedged}/${w.byPhase.startup.turns} wedged, steady ${w.byPhase.steady.wedged}/${w.byPhase.steady.turns} · by third: ${w.byThird.map((t) => `${t.fromSec}-${t.toSec}s ${t.wedged}/${t.turns}`).join(' | ')}`);
  L.push(`  by session: ${w.bySession.map((s) => `s${s.i} ${s.wedged}/${s.turns}${s.firstWedgeAtSec != null ? `@${s.firstWedgeAtSec}s` : ''}`).join(' ')}`);
  L.push(`  turn latency (ok): n=${r.latency.n} p50 ${r.latency.p50 ?? 'n/a'} ms p95 ${r.latency.p95 ?? 'n/a'} p99 ${r.latency.p99 ?? 'n/a'} max ${r.latency.max ?? 'n/a'}`);
  const m = r.memory;
  L.push(`MEMORY SLOPE (rss+swap per tree, Theil–Sen MB/min over ${m.window.fromSec}-${m.window.toSec} s after a ${m.warmupSec} s warm-up, ${m.window.samples} samples): median ${m.medianSessionSlopeMBPerMin ?? 'n/a'}, worst ${m.worstSession ? `s${m.worstSession.i} ${m.worstSession.slopeMBPerMin}` : 'n/a'}`);
  for (const s of m.sessions) L.push(`  s${s.i}: ${s.startMB ?? 'n/a'} → ${s.endMB ?? 'n/a'} MB (peak ${s.peakMB ?? 'n/a'}) · slope ${s.slopeMBPerMin ?? 'n/a'} MB/min (OLS ${s.olsMBPerMin ?? 'n/a'}) · +${s.growthMB ?? 'n/a'} MB in window`);
  L.push(`  app process: ${m.runner.startMB ?? 'n/a'} → ${m.runner.endMB ?? 'n/a'} MB · slope ${m.runner.slopeMBPerMin ?? 'n/a'} MB/min (OLS ${m.runner.olsMBPerMin ?? 'n/a'}) · fake API process (instrument): ${m.api.startMB ?? 'n/a'} → ${m.api.endMB ?? 'n/a'} MB, ${m.api.slopeMBPerMin ?? 'n/a'} MB/min · all trees ${m.total.startMB ?? 'n/a'} → ${m.total.endMB ?? 'n/a'} MB`);
  const pr = r.processes;
  const sv = pr.survivorsAfterDelete;
  L.push(`PROCESSES: peak ${pr.peakTotal} in session trees (${pr.peakPerSession.map((x) => `s${x.i}=${x.procs}`).join(' ')}) · strays outside any tree: max ${pr.strayMax}, at end ${pr.strayAtEnd ?? 'n/a'} · LEFT AFTER DELETING ALL ${p.sessions} WORKSPACES: ${sv.total ?? 'n/a'}${sv.total ? ` by kind ${JSON.stringify(sv.byKind)} by session ${JSON.stringify(sv.bySession)}` : ''}${sv.teardownErrors.length ? ` · teardown errors ${JSON.stringify(sv.teardownErrors)}` : ''}`);
  for (const x of sv.list.slice(0, 10)) L.push(`  left: pid ${x.pid} ${x.kind} ${x.session == null ? 'unattributed' : `s${x.session}`} ${Math.round(x.rssKB / 1024)} MB ${x.cmd}`);
  if (r.api) L.push(`fake API: main ${r.api.totals.main} side ${r.api.totals.side} count_tokens ${r.api.totals.count_tokens} other ${r.api.totals.other} held ${r.api.totals.held} egress(refused) ${r.api.totals.egress}`);
  if (r.verdicts) { L.push('VERDICTS:'); for (const x of r.verdicts) L.push(`  ${x.ok ? 'ok  ' : x.kind === 'instrument' ? 'VOID' : 'FAIL'} ${x.message}`); }
  return L;
}

export function formatSoakMarkdown(r: SoakReport, terminator: string): string {
  const fence = '```';
  return [`# Soak campaign ${r.startedAt ?? r.endedAt}`, '', `**${terminator}** — status ${r.status}`, '', fence, ...formatSoakText(r), fence, '', '_Series (tSec, MB per session / app process / API process) are in the sibling `.json`._', ''].join('\n');
}
