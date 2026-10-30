// #406 — the go/no-go of lifting the browser-panel refusals via hidden unthrottled views, computed MECHANICALLY from the
// committed per-run measurements (docs/evidence/406-hidden-view-cost.jsonl). Pure: no I/O, no clock. The limits below are
// QUOTED from ledger #409 §Go-no-go (OPS, written 2026-10-30 13:55/14:05 CET, before any run) and are FROZEN: change them
// only by a ledger ruling. Re-derive: `node --experimental-strip-types scripts/measure-hidden-views.mjs --verdict <jsonl>`.

export type CostArm = 'A0' | 'A1' | 'A2' | 'A0b' | 'A1x';
export type CostPage = 'idle' | 'busy' | 'heavy';
export type CostKind = 'cell' | 'control-crash' | 'control-gpu-crash' | 'control-abort';

/** One run = one fresh Electron. Raw facts only; validity and every figure are derived below. KB = 1024 bytes (/proc units). */
export interface CostRun {
  kind: CostKind;
  set: string; // 'main' (the matrix), 'a2' (the on-demand arm), 'dev'/other = never counted
  arm: CostArm;
  page: CostPage;
  n: number; // hidden views (a visible one is always present besides)
  rep: number;
  seq: number; // global schedule order
  t?: string; // ISO start time: the order the runs ACTUALLY happened (seq is the schedule's)
  aborted?: string | null; // 'memavail' = the 1 Hz MemAvailable floor fired (the guard working); anything else (e.g. 'deadline' = a hung run) is a FAILURE
  windowS: number;
  settleS: number;
  distinctRenderers: number | null; // distinct OS pids behind the views: must be n + 1 (real tabs, one renderer each)
  stateOk: boolean | null; // the arm's own state assertion (A0: n views detached; A1/A2: n views attached + hidden)
  treeMissing: number | null; // getAppMetrics() pids absent from the /proc tree the sampler summed
  livenessFail: number | null; // views that did not answer a JS probe after the window
  framesCanary: number | null; // frames the frame instrument read from a VISIBLE busy view (must be > 0: it can say "frames")
  rssKB: number | null; // mean summed RSS of the tree over the window
  gpuRssKB: number | null; // mean RSS of the gpu-process
  cpuPct: number | null; // summed CPU of the tree over the window, % of ONE core
  cpuWindowS?: number | null; // the window the CPU figure was really measured over (from the 1 Hz samples)
  crashes: number | null; // child-process-gone / render-process-gone / main exit by signal
  contextLost: number | null; // stderr lines naming a lost GPU context / channel
  idleFrames: number | null; // frames delivered by the sampled HIDDEN views during the idle probe
  memAvailStartKB?: number | null;
  memAvailMinKB?: number | null;
}

const MB = 1e6; // SI on purpose: 80 MB read as 80e6 B is never laxer than 80 MiB
export const LIMITS = {
  // M1 (P-idle) ΔRSS ≤ 80 MB @8 · ≤ 250 MB @40 · ≤ 1.0 GB @160. M2 (P-heavy) ≤ 2× M1 at each N.
  m1RssBytes: { 8: 80 * MB, 40: 250 * MB, 160: 1000 * MB } as Record<number, number>,
  m2Factor: 2,
  // C1 (P-idle) ΔCPU ≤ 2 % of one core @160. C2 (P-busy) ΔCPU ≤ 10 % of one core @40 and ≤ 25 % @160 under A1.
  c1CpuPct: { 160: 2 } as Record<number, number>,
  c2CpuPct: { 40: 10, 160: 25 } as Record<number, number>,
  // G1 ΔGPU-process RSS ≤ 150 MB @160, zero GPU/renderer crash or context-lost in any run, idle frames from hidden views = A0 (±0).
  g1GpuRssBytes: { 160: 150 * MB } as Record<number, number>,
  g1IdleFramesDelta: 0,
  // Controls: a deliberately costly hidden page (allocates 100 MB) must read ΔRSS ≥ 80 MB; A0-vs-A0 within 25 % of the smallest limit.
  positiveControlMinBytes: 80 * MB,
  nullFraction: 0.25,
  // Method: ≥ 5 runs per (arm, N); 60 s window after a 30 s settle; judged on the MEDIAN, no single run beyond 1.5× the limit.
  minRuns: 5,
  windowS: 60,
  settleS: 30,
  cpuWindowSlackS: 2, // the measured CPU window may be at most this much shorter than the nominal 60 s
  singleRunFactor: 1.5,
  // Memory-safety clause: abort below 8 GB; a projected N=160 row needs a linear fit with R² ≥ 0.98.
  memFloorKB: 8 * 1024 * 1024,
  projectionMinR2: 0.98,
  measuredNs: [1, 8, 40] as number[],
  limitNs: [8, 40, 160] as number[],
  crashNs: [1, 8, 40, 160] as number[], // "zero crash … in ANY run": N=1 runs count too
} as const;

export type CheckId = 'M1' | 'M2' | 'C1' | 'C2' | 'G1-gpu' | 'G1-crash' | 'G1-frames';
export interface Check {
  id: CheckId;
  page: CostPage;
  n: number;
  arm: 'A1' | 'A2';
  limit: number; // bytes | % of a core | count — see unit
  unit: 'B' | '%core' | 'count';
  delta: number | null; // median(arm) − median(A0); null = unverified
  worstRun: number | null; // max over the arm's runs of (run − median(A0)); must be ≤ 1.5× limit
  basis: 'measured' | 'projected' | 'missing';
  r2?: number;
  ok: boolean;
  why?: string;
}
export interface ControlRead {
  id: string;
  ok: boolean;
  detail: string;
}
export interface Verdict {
  verdict: 'GO' | 'PARTIAL' | 'NO-GO';
  policy: 'A1' | 'A2';
  cap: number | null; // PARTIAL: largest N whose limits all hold (a spec choice: the LEAD sets the product cap)
  unverified: boolean; // NO-GO/PARTIAL because something could not be shown, not because a limit was read to fail
  reasons: string[];
  checks: Check[];
  controls: ControlRead[];
  method: ControlRead[];
}

// ---- helpers --------------------------------------------------------------------------------------------------------
export function median(xs: number[]): number | null {
  const s = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!s.length) return null;
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/** A run counts only if its own instrument facts say the arm was really built and the instruments could read. */
export function isValid(r: CostRun): boolean {
  if (r.aborted) return false;
  if (r.windowS < LIMITS.windowS || r.settleS < LIMITS.settleS) return false; // a short dev run never enters a verdict
  if (r.kind !== 'cell') return false;
  return r.distinctRenderers === r.n + 1 && r.stateOk === true && r.treeMissing === 0 && r.livenessFail === 0 && (r.framesCanary ?? 0) > 0 &&
    r.rssKB !== null && r.rssKB > 0 && r.gpuRssKB !== null && r.gpuRssKB > 0 /* a gpu-process was sampled */ && r.cpuPct !== null && Number.isFinite(r.cpuPct) &&
    r.cpuWindowS != null && r.cpuWindowS >= LIMITS.windowS - LIMITS.cpuWindowSlackS && r.idleFrames !== null && r.crashes !== null && r.contextLost !== null; // both counters actually READ
}

const sel = (runs: CostRun[], arm: CostArm, page: CostPage, n: number, set: string): CostRun[] =>
  runs.filter((r) => r.kind === 'cell' && r.arm === arm && r.page === page && r.n === n && r.set === set);
const valid = (rs: CostRun[]): CostRun[] => rs.filter(isValid);

type Metric = 'rss' | 'gpu' | 'cpu' | 'frames';
const val = (r: CostRun, m: Metric): number => (m === 'rss' ? r.rssKB! * 1024 : m === 'gpu' ? r.gpuRssKB! * 1024 : m === 'cpu' ? r.cpuPct! : r.idleFrames!);

interface Delta { delta: number; worst: number; runsA: number; runsB: number }
function delta(runs: CostRun[], arm: CostArm, base: CostArm, page: CostPage, n: number, set: string, m: Metric, baseSet = set): Delta | null {
  const a = valid(sel(runs, arm, page, n, set)), b = valid(sel(runs, base, page, n, baseSet));
  if (a.length < LIMITS.minRuns || b.length < LIMITS.minRuns) return null;
  const mb = median(b.map((r) => val(r, m)))!;
  return { delta: median(a.map((r) => val(r, m)))! - mb, worst: Math.max(...a.map((r) => val(r, m) - mb)), runsA: a.length, runsB: b.length };
}

/** Least-squares line through (n, delta) with its R². */
export function linearFit(pts: Array<[number, number]>): { a: number; b: number; r2: number } | null {
  if (pts.length < 3) return null;
  const k = pts.length, sx = pts.reduce((s, p) => s + p[0], 0), sy = pts.reduce((s, p) => s + p[1], 0);
  const sxx = pts.reduce((s, p) => s + p[0] * p[0], 0), sxy = pts.reduce((s, p) => s + p[0] * p[1], 0);
  const den = k * sxx - sx * sx;
  if (den === 0) return null;
  const b = (k * sxy - sx * sy) / den, a = (sy - b * sx) / k, my = sy / k;
  const ssTot = pts.reduce((s, p) => s + (p[1] - my) ** 2, 0), ssRes = pts.reduce((s, p) => s + (p[1] - (a + b * p[0])) ** 2, 0);
  return { a, b, r2: ssTot === 0 ? (ssRes < 1e-9 ? 1 : 0) : 1 - ssRes / ssTot };
}

// ---- the checks -----------------------------------------------------------------------------------------------------
function limitCheck(runs: CostRun[], id: CheckId, page: CostPage, n: number, arm: 'A1' | 'A2', m: Metric, limit: number, unit: Check['unit'], set: string, baseSet: string): Check {
  const mk = (over: Partial<Check>): Check => ({ id, page, n, arm, limit, unit, delta: null, worstRun: null, basis: 'missing', ok: false, ...over });
  const d = delta(runs, arm, 'A0', page, n, set, m, baseSet);
  if (d) return mk({ delta: d.delta, worstRun: d.worst, basis: 'measured', ok: d.delta <= limit && d.worst <= LIMITS.singleRunFactor * limit, why: d.delta > limit ? 'median over the limit' : d.worst > LIMITS.singleRunFactor * limit ? 'a single run beyond 1.5× the limit' : undefined });
  if (n !== 160) return mk({ why: `fewer than ${LIMITS.minRuns} valid runs per arm at N=${n}` });
  // A row that was ATTEMPTED at N=160 but lacks 5 valid runs per arm is not silently turned into a projection (only a row that did not fit above the floor is).
  if (runs.some((r) => r.kind === 'cell' && r.set === set && r.page === page && r.n === 160 && (r.arm === arm || r.arm === 'A0'))) return mk({ why: 'N=160 was attempted but has fewer than 5 valid runs per arm: not projected' });
  // Memory-safety clause: a row that could not be measured is PROJECTED from the per-view slope over the measured N (R² ≥ 0.98).
  const pts: Array<[number, number]> = [];
  for (const k of LIMITS.measuredNs) { const dk = delta(runs, arm, 'A0', page, k, set, m, baseSet); if (dk) pts.push([k, dk.delta]); }
  const fit = linearFit(pts);
  if (!pts.some((p) => p[0] === 40)) return mk({ why: 'N=40 not measured: a projection may not carry a GO' });
  if (!fit) return mk({ why: 'no linear fit (fewer than 3 measured N)' });
  if (fit.r2 < LIMITS.projectionMinR2) return mk({ r2: fit.r2, why: `projection refused: R²=${fit.r2.toFixed(3)} < ${LIMITS.projectionMinR2}` });
  const proj = fit.a + fit.b * 160;
  return mk({ delta: proj, basis: 'projected', r2: fit.r2, ok: proj <= limit, why: proj > limit ? 'projected median over the limit' : undefined });
}

/** zero crash / context-lost in ANY run of the (page, N) — every set (main + a2), every arm but the injected-cost control, valid or not: a crashed run is a result,
 *  never a dropped run. A floor abort ('memavail') is the guard working; any other abort (a hung run) counts as a failure. */
function crashCheck(runs: CostRun[], page: CostPage, n: number): Check {
  const rs = runs.filter((r) => r.kind === 'cell' && r.page === page && r.n === n && r.set !== 'dev' && r.arm !== 'A1x' && r.aborted !== 'memavail');
  const bad = rs.reduce((s, r) => s + (r.crashes ?? 0) + (r.contextLost ?? 0) + (r.aborted ? 1 : 0), 0);
  return { id: 'G1-crash', page, n, arm: 'A1', limit: 0, unit: 'count', delta: rs.length ? bad : null, worstRun: null, basis: rs.length ? 'measured' : 'missing', ok: rs.length > 0 && bad === 0, why: !rs.length ? 'no run' : bad ? `${bad} crash / context-lost / hung-run event(s)` : undefined };
}

/** idle frames from hidden views = A0 (±0): the median AND every single run (limit 0 × 1.5 = 0). */
function framesCheck(runs: CostRun[], arm: 'A1' | 'A2', page: CostPage, n: number, set: string): Check {
  const fd = delta(runs, arm, 'A0', page, n, set, 'frames');
  const ok = !!fd && fd.delta === 0 && fd.worst <= 0;
  return { id: 'G1-frames', page, n, arm, limit: LIMITS.g1IdleFramesDelta, unit: 'count', delta: fd ? fd.delta : null, worstRun: fd ? fd.worst : null, basis: fd ? 'measured' : 'missing', ok, why: !fd ? 'fewer than 5 valid runs' : !ok ? 'hidden views produced a different number of idle frames than A0' : undefined };
}

const measured = (runs: CostRun[], page: CostPage, n: number): boolean => runs.some((r) => r.kind === 'cell' && r.set !== 'dev' && r.page === page && r.n === n);

export function computeChecks(runs: CostRun[], arm: 'A1' | 'A2' = 'A1', cpuArm: 'A1' | 'A2' = arm): Check[] {
  const out: Check[] = [];
  for (const n of LIMITS.limitNs) {
    const m1 = LIMITS.m1RssBytes[n]!;
    out.push(limitCheck(runs, 'M1', 'idle', n, arm, 'rss', m1, 'B', 'main', 'main'));
    out.push(limitCheck(runs, 'M2', 'heavy', n, arm, 'rss', LIMITS.m2Factor * m1, 'B', 'main', 'main'));
    if (LIMITS.c1CpuPct[n] !== undefined) out.push(limitCheck(runs, 'C1', 'idle', n, cpuArm, 'cpu', LIMITS.c1CpuPct[n]!, '%core', cpuArm === 'A2' ? 'a2' : 'main', cpuArm === 'A2' ? 'a2' : 'main'));
    if (LIMITS.c2CpuPct[n] !== undefined) out.push(limitCheck(runs, 'C2', 'busy', n, cpuArm, 'cpu', LIMITS.c2CpuPct[n]!, '%core', cpuArm === 'A2' ? 'a2' : 'main', cpuArm === 'A2' ? 'a2' : 'main'));
    if (LIMITS.g1GpuRssBytes[n] !== undefined) for (const page of ['idle', 'busy', 'heavy'] as CostPage[]) out.push(limitCheck(runs, 'G1-gpu', page, n, arm, 'gpu', LIMITS.g1GpuRssBytes[n]!, 'B', 'main', 'main'));
    // frames are a COUNT, read on the IDLE page (the one whose content never changes), only where runs exist (an unmeasured N=160 is projected for the continuous metrics only)
    if (n !== 160 || measured(runs, 'idle', 160)) out.push(framesCheck(runs, arm, 'idle', n, 'main'));
  }
  // crash / context-lost: any run, every N including N=1; at N=160 only for the pages that were measured there
  for (const n of LIMITS.crashNs) for (const page of ['idle', 'busy', 'heavy'] as CostPage[]) if (n !== 160 || measured(runs, page, 160)) out.push(crashCheck(runs, page, n));
  return out;
}

// ---- controls + method ----------------------------------------------------------------------------------------------
export function readControls(runs: CostRun[]): ControlRead[] {
  const out: ControlRead[] = [];
  // (i) positive: a hidden view allocating 100 MB (arm A1x at N=8, P-idle) must read ΔRSS ≥ 80 MB AND turn the M1 check at N=8 RED.
  const pos = delta(runs, 'A1x', 'A0', 'idle', 8, 'main', 'rss');
  out.push({ id: 'positive-rss', ok: !!pos && pos.delta >= LIMITS.positiveControlMinBytes && pos.delta > LIMITS.m1RssBytes[8]!, detail: pos ? `ΔRSS(A1x−A0)@8 = ${(pos.delta / MB).toFixed(1)} MB (needs ≥ ${LIMITS.positiveControlMinBytes / MB} MB and > the M1 limit ${LIMITS.m1RssBytes[8]! / MB} MB)` : 'no A1x/A0 pair with ≥ 5 valid runs at P-idle N=8' });
  // (ii) null: the same arm twice (A0b vs A0) reads |Δ| ≤ 25 % of the smallest limit of each metric, at every null cell.
  const nullCells: Array<[CostPage, number]> = [['idle', 8], ['idle', 40]];
  const lim = { rss: Math.min(...Object.values(LIMITS.m1RssBytes)), cpu: Math.min(...Object.values(LIMITS.c1CpuPct), ...Object.values(LIMITS.c2CpuPct)), gpu: Math.min(...Object.values(LIMITS.g1GpuRssBytes)) };
  const bad: string[] = [], seen: string[] = [];
  for (const [page, n] of nullCells) for (const m of ['rss', 'cpu', 'gpu'] as Array<'rss' | 'cpu' | 'gpu'>) {
    const d = delta(runs, 'A0b', 'A0', page, n, 'main', m);
    const max = LIMITS.nullFraction * lim[m];
    if (!d) { bad.push(`${m}@${page}/${n}: no A0b/A0 pair`); continue; }
    seen.push(`${m}@${n}=${m === 'cpu' ? d.delta.toFixed(2) + '%' : (d.delta / MB).toFixed(1) + 'MB'}`);
    if (Math.abs(d.delta) > max) bad.push(`${m}@${page}/${n}: |${m === 'cpu' ? d.delta.toFixed(2) + '%' : (d.delta / MB).toFixed(1) + ' MB'}| > ${m === 'cpu' ? max + '%' : (max / MB).toFixed(1) + ' MB'}`);
  }
  out.push({ id: 'null-A0-vs-A0', ok: !bad.length, detail: bad.length ? bad.join('; ') : `|Δ| within 25 % of the smallest limit (${seen.join(', ')})` });
  // (iii) the crash counter can read a crash; (iv) the memory-floor abort can fire — each seen on a deliberate trigger.
  const cr = runs.filter((r) => r.kind === 'control-crash' && (r.crashes ?? 0) >= 1);
  out.push({ id: 'crash-counter-fires', ok: cr.length >= 1, detail: `${cr.length} control run(s) with a deliberately killed renderer read crashes ≥ 1` });
  const gp = runs.filter((r) => r.kind === 'control-gpu-crash' && (r.crashes ?? 0) >= 1 && (r.contextLost ?? 0) >= 1);
  out.push({ id: 'gpu-crash-and-context-lost-counters-fire', ok: gp.length >= 1, detail: `${gp.length} control run(s) with a deliberately killed GPU process read crashes ≥ 1 AND context-lost ≥ 1` });
  const ab = runs.filter((r) => r.kind === 'control-abort' && r.aborted === 'memavail');
  out.push({ id: 'memory-floor-abort-fires', ok: ab.length >= 1, detail: `${ab.length} self-test run(s) aborted by the 1 Hz MemAvailable floor` });
  return out;
}

export function readMethod(runs: CostRun[]): ControlRead[] {
  const out: ControlRead[] = [];
  const short: string[] = [], lead: string[] = [];
  const when = (r: CostRun): number => (r.t ? Date.parse(r.t) : r.seq); // the order the runs ACTUALLY happened; the schedule's seq only when no clock was recorded
  const pages: CostPage[] = ['idle', 'busy', 'heavy'];
  // required groups: every (page, N ∈ {1,8,40}) of the main set; N=160 of the main set and the a2 set only where runs exist (a2 is measured only where A1 breached)
  const groups: Array<[string, CostPage, number, 'A1' | 'A2']> = [];
  for (const page of pages) for (const n of LIMITS.measuredNs) groups.push(['main', page, n, 'A1']);
  for (const page of pages) if (measured(runs.filter((r) => r.set === 'main'), page, 160)) groups.push(['main', page, 160, 'A1']);
  for (const key of new Set(runs.filter((r) => r.kind === 'cell' && r.set === 'a2').map((r) => `${r.page}|${r.n}`))) { const [pg, n] = key.split('|'); groups.push(['a2', pg as CostPage, Number(n), 'A2']); }
  for (const [set, page, n, arm] of groups) {
    for (const a of ['A0', arm] as CostArm[]) { const k = valid(sel(runs, a, page, n, set)).length; if (k < LIMITS.minRuns) short.push(`${set}/${a}/${page}/${n}=${k}`); }
    // alternating order, read off the wall clock of the VALID runs: in every group each compared arm LEADS its rep in at least ⌊reps/arms-in-cell⌋ reps
    const rs = valid(runs.filter((r) => r.kind === 'cell' && r.set === set && r.page === page && r.n === n));
    const reps = [...new Set(rs.map((r) => r.rep))], inCell = new Set(rs.map((r) => r.arm)).size; // a cell may also carry the control arms (A1x, A0b)
    const leaders = reps.map((rep) => rs.filter((r) => r.rep === rep).sort((x, y) => when(x) - when(y))[0]?.arm);
    for (const a of ['A0', arm] as CostArm[]) if (leaders.filter((x) => x === a).length < Math.floor(reps.length / Math.max(inCell, 1))) lead.push(`${set}/${a}/${page}/${n}`);
  }
  out.push({ id: 'runs-per-cell>=5', ok: !short.length, detail: short.length ? `short cells: ${short.join(', ')}` : `every compared (arm, page, N) cell has ≥ 5 valid runs (${groups.length} groups: N∈{1,8,40}, N=160 and the a2 set where measured)` });
  out.push({ id: 'arms-interleaved-alternating', ok: !lead.length, detail: lead.length ? `an arm never leads enough reps (wall clock) in: ${lead.join(', ')}` : 'every compared arm leads ⌊reps/arms⌋ reps in every group, by start time' });
  return out;
}

// ---- the verdict ----------------------------------------------------------------------------------------------------
export function computeVerdict(runs: CostRun[]): Verdict {
  const controls = readControls(runs), method = readMethod(runs);
  const reasons: string[] = [];
  const base = { cap: null, controls, method };
  for (const c of [...controls, ...method]) if (!c.ok) reasons.push(`UNVERIFIED ${c.id}: ${c.detail}`);
  let checks = computeChecks(runs, 'A1');
  const failing = (cs: Check[]): Check[] => cs.filter((c) => !c.ok);
  // C1/C2 breach under A1 → the policy lifted is A2 (bt0 only around agent actions) IF A2 holds EVERY CPU limit A1 breached; the limits A1 held
  // (and every memory / GPU / frame limit) stay on the A1 rows: A2 is measured only where A1 breached (§Go-no-go).
  let policy: 'A1' | 'A2' = 'A1';
  const isCpu = (c: Check): boolean => c.id === 'C1' || c.id === 'C2';
  const a1Breach = checks.filter((c) => isCpu(c) && c.basis !== 'missing' && !c.ok);
  if (a1Breach.length) {
    const a2 = computeChecks(runs, 'A1', 'A2').filter(isCpu);
    const alt = a1Breach.map((c) => a2.find((x) => x.id === c.id && x.n === c.n && x.page === c.page));
    if (alt.every((x) => x !== undefined && x.ok)) {
      checks = checks.map((c) => alt.find((x) => x && x.id === c.id && x.n === c.n && x.page === c.page) ?? c);
      policy = 'A2';
      reasons.push('A1 breaches a CPU limit and A2 holds it: the policy lifted is A2');
      // the lifted policy must also hold the idle-frames limit wherever A2 was measured (hidden views produce exactly A0's frames)
      for (const key of new Set(runs.filter((r) => r.kind === 'cell' && r.set === 'a2' && r.arm === 'A2').map((r) => `${r.page}|${r.n}`))) { const [pg, n] = key.split('|'); checks.push(framesCheck(runs, 'A2', pg as CostPage, Number(n), 'a2')); }
    }
  }
  const bad = failing(checks);
  const fail40 = bad.filter((c) => c.n <= 40);
  const fail160 = bad.filter((c) => c.n === 160);
  for (const c of bad) reasons.push(`${c.id} ${c.page} N=${c.n} ${c.arm}: ${c.why ?? 'over the limit'}${c.delta !== null ? ` (Δ=${c.unit === 'B' ? (c.delta / MB).toFixed(1) + ' MB' : c.delta.toFixed(2) + (c.unit === '%core' ? '%' : '')}, limit ${c.unit === 'B' ? c.limit / MB + ' MB' : c.limit})` : ''}`);
  const gap = controls.some((c) => !c.ok) || method.some((c) => !c.ok);
  if (gap || fail40.length) return { ...base, verdict: 'NO-GO', policy, unverified: gap, reasons, checks };
  if (!fail160.length) return { ...base, verdict: 'GO', policy, unverified: false, reasons, checks };
  // PARTIAL: everything holds at N=40; the cap is the largest N whose limits all hold (the product value is a spec choice: ask LEAD)
  return { ...base, verdict: 'PARTIAL', policy, cap: 40, unverified: fail160.every((c) => c.basis === 'missing'), reasons, checks };
}
