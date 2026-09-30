// UI idle budget (#215, wave C8): the PURE judge for scripts/e2e-ui-idle-budget.mjs. The rig boots the built app,
// mounts N idle agent panes and counts per-frame work over a fixed window; this module decides PASS / FAIL / REFUSED.
//   controls  — prove the instrument could have seen work (a 0 from a blind rig is not a pass): REFUSED, never PASS
//   budgets   — rAF callbacks fired (zero) · recurring short timers (zero) · ResizeObserver / MutationObserver callbacks
//               (measured baseline) · infinite animations (`name@selector` allowlist) · Performance.getMetrics deltas
//               (a catch-all for per-frame work no counter names: a MessageChannel loop, an idle-callback chain, …)
// Never OS process CPU as a verdict (noisy). The metrics leg budgets ThreadTime — the main thread's CPU time, robust to contention — and is
// never voided by host load: a measurement that goes blind under load is exactly when a loop hides.

/** `snippet`: ~140 chars of the shipped bundle around the scheduling frame (the site is minified: `z (index-x.js:338:20904)` alone says nothing). */
export interface RafSite { site: string; scheduled: number; fired: number; snippet?: string }
/** `key` = `name@selector` (the allowlist key). `name` is what the steady intersection is keyed on (class churn cannot evade it). */
export interface InfiniteAnim { key: string; name: string; selector: string; count: number }
export interface TimerSite { site: string; fired: number }
export interface ObserverSite { site: string; kind: 'ro' | 'mo'; fired: number }
/** `ThreadTime` = main-thread CPU seconds (Performance.getMetrics); wall `TaskDuration` is NOT used (preemption inflates it). */
export interface Metrics { RecalcStyleCount: number; LayoutCount: number; ThreadTime: number }

export interface IdleMeasurement {
  windowMs: number;
  /** How many panes the rig asked for. */
  panesWanted: number;
  panes: {
    avViews: number;
    /** Folded message rows per pane (0 = a pane that mounted but holds nothing). */
    rowsPerPane: number[];
    /** Message rows actually RENDERED in the DOM (folded data alone is not a mounted, painted pane). */
    visibleRows: number;
    /** Same read after the window: the fakes must not have been reconciled away mid-window. */
    avViewsAtEnd: number;
    /** Panes whose session still has a turn in flight (`running`), max of window start/end. `user-message` opens one; a pane
     *  with an open turn legitimately animates (spinner/shimmer), so an idle measurement over one is not an idle measurement. */
    openTurns: number;
  };
  /** What the mounted pane really contains: a REAL transcript (markdown, fenced code, Read/Edit/Bash cards, a diff) and the
   *  open background-tasks panel. A loop inside a component that never mounted is invisible to every counter. */
  rich: { distinctAvClasses: number; markers: Record<string, boolean> };
  /** `perSecond`: callbacks fired in each 1 s bucket of the window — a perpetual loop fills every bucket, a stray one-shot sits in one. */
  raf: { fired: number; scheduled: number; bySite: RafSite[]; perSecond: number[] };
  /** setTimeout/setInterval callbacks. `loopSites`: sites whose delay is < 100 ms and that fired >= 2x in the window
   *  (a recurring or self-rescheduling timer is per-frame-class work; a one-shot is not). */
  timers: { totalFired: number; shortFired: number; loopSites: TimerSite[] };
  /** ResizeObserver / MutationObserver callbacks over the window. */
  observers: { resizeFired: number; mutationFired: number; bySite: ObserverSite[] };
  /** `Performance.getMetrics` deltas over the window (null = the read failed). */
  metrics: Metrics | null;
  /** Steady infinite animations: the output of {@link steadyAnimations} over the mid-window samples. */
  infiniteAnimations: InfiniteAnim[];
  controls: {
    /** rAF callbacks the APP's own queue fired while the rig drove an event burst through `__injectAgentEvent`. */
    appBurstRafFired: number;
    /** Steady infinite animations while a pane had an OPEN turn vs after `turn-end` closed it: open > closed proves the
     *  census sees the app's own animations and that the idle reading is idle because the turn is closed. */
    openTurnAnimCount: number;
    closedTurnAnimCount: number;
    /** Rig probes through the WRAPPED constructors/timers (each must be seen: a blind wrapper reads 0 vacuously). */
    probeTimerFired: number;
    probeRoFired: number;
    probeMoFired: number;
    /** A probe rAF chain completed before / after the window, on a visible page. */
    framesBefore: boolean;
    framesAfter: boolean;
    visibility: string;
    /** A rig-injected infinite CSS animation was seen by the census, and gone once removed. */
    animProbeSeen: boolean;
    animProbeCleared: boolean;
    /** The page was not reloaded mid-window (a reload zeroes the counters — a false 0). */
    sameEpoch: boolean;
    /** Wall time the window really lasted. */
    elapsedMs: number;
    /** The instrument ran BEFORE the app's first script (document.readyState 'loading', no script parsed at install). A late
     *  install misses anything the bundle captured at module load (`const raf = requestAnimationFrame`). */
    instrumentFirst: boolean;
    /** The app's fleet bus opened (`bus: opened` in its log; false = `bus: FAILED to open`, null = neither line). A gate run without
     *  the bus is not the shipped app, so a release gate REQUIRES it; a dev run only reports it. */
    busOpen: boolean | null;
    requireBus: boolean;
    /** The renderer ran the on-disk bundle (sha256 of the served script == the file the rig built/mutated). */
    bundleIdentity: boolean;
    /** Whether the page went quiet before the window (info: a page that never settled fails the budget anyway). */
    settled: boolean;
  };
}

export interface Budget {
  /** rAF callbacks the app may fire over the whole window. Zero: an idle pane schedules no frames. */
  rafFired: number;
  /** Short-delay (< 100 ms) timer SITES that recur (>= 2 fires) over the window. Zero. */
  shortTimerLoops: number;
  /** ResizeObserver / MutationObserver callbacks over the window: the measured clean-idle baseline plus a stated margin. */
  resizeObserverFired: number;
  mutationObserverFired: number;
  /** Performance.getMetrics deltas PER 10 s of window (scaled by windowMs/10000): the measured clean idle plus a stated margin. */
  metricsPer10s: Metrics;
  /** The rich subject must mount at least this many distinct `av-*` classes (measured on the clean rich pane, with margin). */
  minDistinctAvClasses: number;
  /** `name@selector` -> max steady infinite animations allowed (an explicit, reviewed allowlist; empty = none). */
  infiniteAnimations: Record<string, number>;
  /** Extra allowance granted ONLY while the named rich marker is present (the ordinary idle state that animates by design: an
   *  in-progress todo's spinner, a running background task's dot). marker -> `name@selector` -> max. Absent marker = no grant. */
  infiniteAnimationsWhen: Record<string, Record<string, number>>;
}

export const DEFAULT_BUDGET: Budget = {
  rafFired: 0, shortTimerLoops: 0, resizeObserverFired: 0, mutationObserverFired: 0,
  metricsPer10s: { RecalcStyleCount: 0, LayoutCount: 0, ThreadTime: 0 }, minDistinctAvClasses: 0, infiniteAnimations: {}, infiniteAnimationsWhen: {},
};

/** Steady infinite animations from per-sample censuses taken across the window: a NAME is steady when it is present in at least
 *  `minSamples` samples (so a name swapped every few seconds is caught where a both-ends intersection would miss it, and class
 *  churn cannot hide it); its entries are those of the LAST sample that held it. */
export function steadyAnimations(samples: InfiniteAnim[][], minSamples = 3): InfiniteAnim[] {
  const seen = new Map<string, { n: number; last: InfiniteAnim[] }>();
  for (const sample of samples) {
    const byName = new Map<string, InfiniteAnim[]>();
    for (const a of sample) (byName.get(a.name) ?? byName.set(a.name, []).get(a.name)!).push(a);
    for (const [name, list] of byName) {
      const e = seen.get(name) ?? seen.set(name, { n: 0, last: [] }).get(name)!;
      e.n += 1; e.last = list;
    }
  }
  return [...seen.values()].filter((e) => e.n >= minSamples).flatMap((e) => e.last);
}

export interface Clause { name: string; kind: 'control' | 'budget'; ok: boolean; detail: string }
export interface Verdict {
  /** 'PASS' | 'FAIL' (a budget was breached) | 'REFUSED' (a control failed: the run proves nothing). */
  verdict: 'PASS' | 'FAIL' | 'REFUSED';
  exitCode: 0 | 1 | 4;
  clauses: Clause[];
}

const fmtSite = (s: RafSite) => `${s.site} ×${s.fired}${s.snippet ? ` «${s.snippet}»` : ''}`;
const topOf = <T extends { fired: number }>(list: T[], fmt: (x: T) => string) =>
  [...list].filter((s) => s.fired > 0).sort((a, b) => b.fired - a.fired).slice(0, 3).map(fmt).join('; ') || '?';

export function judge(m: IdleMeasurement, budget: Budget = DEFAULT_BUDGET): Verdict {
  const c = m.controls;
  const clauses: Clause[] = [];
  const control = (name: string, ok: boolean, detail: string) => clauses.push({ name: `control/${name}`, kind: 'control', ok, detail });
  const bud = (name: string, ok: boolean, detail: string) => clauses.push({ name: `budget/${name}`, kind: 'budget', ok, detail });

  // ── controls: refuse a run that could not have seen the thing it reports on ──
  const rowsOk = m.panes.rowsPerPane.length === m.panesWanted && m.panes.rowsPerPane.every((r) => r > 0) && m.panes.visibleRows > 0;
  control('panes-mounted', m.panesWanted > 0 && m.panes.avViews === m.panesWanted && m.panes.avViewsAtEnd === m.panesWanted && rowsOk,
    `.av-view ${m.panes.avViews} at start / ${m.panes.avViewsAtEnd} at end (wanted ${m.panesWanted}); folded rows per pane [${m.panes.rowsPerPane.join(',')}] each > 0, ${m.panes.visibleRows} rendered row(s) > 0`);
  const missing = Object.entries(m.rich.markers).filter(([, v]) => !v).map(([k]) => k);
  control('rich-subject', m.rich.distinctAvClasses >= budget.minDistinctAvClasses && missing.length === 0 && Object.keys(m.rich.markers).length > 0,
    `${m.rich.distinctAvClasses} distinct av-* classes mounted (min ${budget.minDistinctAvClasses}); rich markers ${Object.keys(m.rich.markers).length - missing.length}/${Object.keys(m.rich.markers).length}${missing.length ? ` — MISSING ${missing.join(',')}` : ''} (a loop in a component that never mounted is invisible)`);
  control('panes-idle', m.panes.openTurns === 0,
    `${m.panes.openTurns} pane(s) with a turn still in flight at window start/end (must be 0: an open turn animates by design)`);
  control('raf-instrument', c.appBurstRafFired > 0,
    `the app's own event queue fired ${c.appBurstRafFired} counted rAF callback(s) when driven (> 0: the counter sits on the rAF the app really uses)`);
  control('observer-instrument', c.probeTimerFired > 0 && c.probeRoFired > 0 && c.probeMoFired > 0,
    `rig probes through the wrapped timer / ResizeObserver / MutationObserver were counted: timer ${c.probeTimerFired}, RO ${c.probeRoFired}, MO ${c.probeMoFired} (each > 0: a blind wrapper reads 0 vacuously)`);
  control('instrument-first', c.instrumentFirst,
    `the instrument ran before the app's first script (${c.instrumentFirst}); a late install misses a requestAnimationFrame the bundle captured at module load`);
  control('frames-delivered', c.framesBefore && c.framesAfter && c.visibility === 'visible',
    `probe rAF chain completed before=${c.framesBefore} after=${c.framesAfter}, visibilityState=${c.visibility} (a hidden page delivers no frames, so its count is vacuously 0)`);
  control('turn-animations', c.openTurnAnimCount > c.closedTurnAnimCount,
    `infinite animations with an OPEN turn ${c.openTurnAnimCount} > ${c.closedTurnAnimCount} after turn-end (the census sees the app's own animations, and closing the turn stops them)`);
  control('animation-census', c.animProbeSeen && c.animProbeCleared,
    `rig-injected infinite CSS animation seen=${c.animProbeSeen}, gone once removed=${c.animProbeCleared}`);
  control('metrics-read', m.metrics !== null && Object.values(m.metrics).every((v) => Number.isFinite(v)),
    `Performance.getMetrics deltas were read (${m.metrics ? JSON.stringify(m.metrics) : 'null'})`);
  control('window-intact', c.sameEpoch && c.elapsedMs >= m.windowMs * 0.98,
    `same page epoch=${c.sameEpoch} (a reload zeroes the counters), window ${c.elapsedMs} ms >= ${m.windowMs} ms`);
  control('bus-open', !c.requireBus || c.busOpen === true,
    `fleet bus ${c.busOpen === true ? 'opened' : c.busOpen === false ? 'FAILED to open (native ABI is not Electron\'s: pnpm run build:bus-abi)' : 'state unknown'}${c.requireBus ? ' — required' : ' — informational (--require-bus off)'}`);
  control('bundle-identity', c.bundleIdentity,
    `the running renderer's script hashes to the on-disk bundle the rig built/mutated (${c.bundleIdentity})`);
  const refused = clauses.some((x) => !x.ok);

  // ── budgets ──
  bud('idle-raf', m.raf.fired <= budget.rafFired,
    `${m.raf.fired} rAF callback(s) fired over ${m.windowMs} ms on ${m.panes.avViews} idle pane(s) (budget ${budget.rafFired})${m.raf.fired ? `; per-second [${m.raf.perSecond.join(',')}]; top schedulers: ${topOf(m.raf.bySite, fmtSite)}` : ''}`);
  bud('short-timer-loops', m.timers.loopSites.length <= budget.shortTimerLoops,
    `${m.timers.loopSites.length} recurring short-delay (< 100 ms) timer site(s) over ${m.windowMs} ms (budget ${budget.shortTimerLoops}); ${m.timers.shortFired} short / ${m.timers.totalFired} total timer callbacks${m.timers.loopSites.length ? `; sites: ${topOf(m.timers.loopSites, (s) => `${s.site} ×${s.fired}`)}` : ''}`);
  bud('resize-observer', m.observers.resizeFired <= budget.resizeObserverFired,
    `${m.observers.resizeFired} ResizeObserver callback(s) (budget ${budget.resizeObserverFired})${m.observers.resizeFired > budget.resizeObserverFired ? `; top: ${topOf(m.observers.bySite.filter((s) => s.kind === 'ro'), (s) => `${s.site} ×${s.fired}`)}` : ''}`);
  bud('mutation-observer', m.observers.mutationFired <= budget.mutationObserverFired,
    `${m.observers.mutationFired} MutationObserver callback(s) (budget ${budget.mutationObserverFired})${m.observers.mutationFired > budget.mutationObserverFired ? `; top: ${topOf(m.observers.bySite.filter((s) => s.kind === 'mo'), (s) => `${s.site} ×${s.fired}`)}` : ''}`);
  // The catch-all: per-frame work no counter names (a MessageChannel loop, an idle-callback chain) still costs style + layout + main-thread CPU.
  if (m.metrics) {
    const scale = m.windowMs / 10000;
    const lim = (k: keyof Metrics) => budget.metricsPer10s[k] * scale;
    const over: string[] = [];
    for (const k of ['RecalcStyleCount', 'LayoutCount'] as const) if (m.metrics[k] > lim(k)) over.push(`${k} ${m.metrics[k]} > ${+lim(k).toFixed(2)}`);
    if (m.metrics.ThreadTime > lim('ThreadTime')) over.push(`ThreadTime ${m.metrics.ThreadTime.toFixed(3)} s > ${+lim('ThreadTime').toFixed(3)} s`);
    bud('metrics', over.length === 0,
      `Performance.getMetrics over ${m.windowMs} ms: RecalcStyleCount ${m.metrics.RecalcStyleCount} (≤ ${+lim('RecalcStyleCount').toFixed(2)}), LayoutCount ${m.metrics.LayoutCount} (≤ ${+lim('LayoutCount').toFixed(2)}), ThreadTime ${m.metrics.ThreadTime.toFixed(3)} s (≤ ${+lim('ThreadTime').toFixed(3)} s)${over.length ? `; OVER: ${over.join(', ')}` : ''}`);
  }
  const byKey = new Map<string, number>();
  for (const a of m.infiniteAnimations) byKey.set(a.key, (byKey.get(a.key) ?? 0) + a.count);
  const over: string[] = [];
  const granted = (key: string) => Object.entries(budget.infiniteAnimationsWhen).reduce((n, [marker, grants]) => n + (m.rich.markers[marker] ? grants[key] ?? 0 : 0), 0);
  for (const [key, total] of byKey) {
    const allowed = (budget.infiniteAnimations[key] ?? 0) + granted(key);
    if (total > allowed) over.push(`${key} ×${total} (allowed ${allowed})`);
  }
  bud('infinite-animations', over.length === 0,
    over.length ? `steady infinite animation(s) over budget: ${over.join(' | ')}` : `${m.infiniteAnimations.reduce((n, a) => n + a.count, 0)} steady infinite animation(s), all within the name@selector allowlist`);

  const failed = clauses.some((x) => !x.ok && x.kind === 'budget');
  if (refused) return { verdict: 'REFUSED', exitCode: 4, clauses };
  return failed ? { verdict: 'FAIL', exitCode: 1, clauses } : { verdict: 'PASS', exitCode: 0, clauses };
}

/** One printable line per clause, `ok`/`FAIL`/`REFUSE` first so a grep for the clause name finds its verdict. */
export function renderClauses(v: Verdict): string[] {
  return v.clauses.map((x) => `${x.ok ? 'ok    ' : x.kind === 'control' ? 'REFUSE' : 'FAIL  '} ${x.name}: ${x.detail}`);
}

const KEYS = new Set(['_comment', 'rafFired', 'shortTimerLoops', 'resizeObserverFired', 'mutationObserverFired', 'metricsPer10s', 'minDistinctAvClasses', 'infiniteAnimations', 'infiniteAnimationsWhen']);
const nonNegInt = (v: unknown, what: string): number => {
  if (!Number.isInteger(v) || (v as number) < 0) throw new Error(`${what} must be a non-negative integer`);
  return v as number;
};
const nonNegNum = (v: unknown, what: string): number => {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) throw new Error(`${what} must be a non-negative number`);
  return v;
};

/** Parse the budget file; unknown keys and non-integer/negative values are REFUSED rather than defaulted (a typo'd key must
 *  not silently widen a budget). An allowlist key must be `name@selector` — a bare animation name is refused. */
export function parseBudget(raw: unknown): Budget {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('budget must be a JSON object');
  const o = raw as Record<string, unknown>;
  for (const k of Object.keys(o)) if (!KEYS.has(k)) throw new Error(`unknown budget key '${k}'`);
  const d = DEFAULT_BUDGET;
  const ia = o.infiniteAnimations ?? {};
  if (typeof ia !== 'object' || Array.isArray(ia) || ia === null) throw new Error('infiniteAnimations must be an object');
  const keyRe = /^[^@\s]+@\S+$/;
  const infiniteAnimations: Record<string, number> = {};
  for (const [k, v] of Object.entries(ia)) {
    if (!keyRe.test(k)) throw new Error(`infiniteAnimations key '${k}' must be name@selector`);
    infiniteAnimations[k] = nonNegInt(v, `infiniteAnimations.${k}`);
  }
  const iw = o.infiniteAnimationsWhen ?? {};
  if (typeof iw !== 'object' || Array.isArray(iw) || iw === null) throw new Error('infiniteAnimationsWhen must be an object');
  const infiniteAnimationsWhen: Record<string, Record<string, number>> = {};
  for (const [marker, grants] of Object.entries(iw)) {
    if (typeof grants !== 'object' || Array.isArray(grants) || grants === null) throw new Error(`infiniteAnimationsWhen.${marker} must be an object`);
    infiniteAnimationsWhen[marker] = {};
    for (const [k, v] of Object.entries(grants)) {
      if (!keyRe.test(k)) throw new Error(`infiniteAnimationsWhen.${marker} key '${k}' must be name@selector`);
      infiniteAnimationsWhen[marker][k] = nonNegInt(v, `infiniteAnimationsWhen.${marker}.${k}`);
    }
  }
  const mp = (o.metricsPer10s ?? d.metricsPer10s) as Record<string, unknown>;
  if (typeof mp !== 'object' || mp === null || Array.isArray(mp)) throw new Error('metricsPer10s must be an object');
  for (const k of Object.keys(mp)) if (k !== 'RecalcStyleCount' && k !== 'LayoutCount' && k !== 'ThreadTime') throw new Error(`unknown metricsPer10s key '${k}'`);
  return {
    rafFired: o.rafFired === undefined ? d.rafFired : nonNegInt(o.rafFired, 'rafFired'),
    shortTimerLoops: o.shortTimerLoops === undefined ? d.shortTimerLoops : nonNegInt(o.shortTimerLoops, 'shortTimerLoops'),
    resizeObserverFired: o.resizeObserverFired === undefined ? d.resizeObserverFired : nonNegInt(o.resizeObserverFired, 'resizeObserverFired'),
    mutationObserverFired: o.mutationObserverFired === undefined ? d.mutationObserverFired : nonNegInt(o.mutationObserverFired, 'mutationObserverFired'),
    metricsPer10s: {
      RecalcStyleCount: mp.RecalcStyleCount === undefined ? d.metricsPer10s.RecalcStyleCount : nonNegNum(mp.RecalcStyleCount, 'metricsPer10s.RecalcStyleCount'),
      LayoutCount: mp.LayoutCount === undefined ? d.metricsPer10s.LayoutCount : nonNegNum(mp.LayoutCount, 'metricsPer10s.LayoutCount'),
      ThreadTime: mp.ThreadTime === undefined ? d.metricsPer10s.ThreadTime : nonNegNum(mp.ThreadTime, 'metricsPer10s.ThreadTime'),
    },
    minDistinctAvClasses: o.minDistinctAvClasses === undefined ? d.minDistinctAvClasses : nonNegInt(o.minDistinctAvClasses, 'minDistinctAvClasses'),
    infiniteAnimations,
    infiniteAnimationsWhen,
  };
}
