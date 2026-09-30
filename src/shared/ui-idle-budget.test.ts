import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { judge, parseBudget, renderClauses, DEFAULT_BUDGET, type Budget, type IdleMeasurement } from './ui-idle-budget.ts';

const CM1 = 'cm-blink@div.cm-cursorLayer.cm-vimCursorLayer';
const CM2 = 'cm-blink@div.cm-layer.cm-layer-above.cm-cursorLayer';
// The shipped shape of scripts/ui-idle-budget.json (parsed for real in the last tests).
const budget: Budget = {
  rafFired: 0, shortTimerLoops: 0, resizeObserverFired: 10, mutationObserverFired: 10,
  metricsPer10s: { RecalcStyleCount: 300, LayoutCount: 10, TaskDuration: 0.5 }, minDistinctAvClasses: 80,
  infiniteAnimations: { [CM1]: 1, [CM2]: 1 }, loadVoidAbove: 20,
};

// A clean, healthy measurement: 6 idle panes with a rich subject, 0 per-frame work, only the allowlisted caret blink, every control satisfied.
const good = (): IdleMeasurement => ({
  windowMs: 10000,
  panesWanted: 6,
  panes: { avViews: 6, rowsPerPane: [90, 90, 90, 90, 90, 90], visibleRows: 51, avViewsAtEnd: 6, openTurns: 0 },
  rich: { distinctAvClasses: 89, markers: { 'md-list': true, 'code-block': true, 'tool-runs': true, diff: true, 'bgtask-panel': true, 'composer-focused': true } },
  raf: { fired: 0, scheduled: 0, bySite: [], perSecond: [0, 0, 0] },
  timers: { totalFired: 2, shortFired: 0, loopSites: [] },
  observers: { resizeFired: 0, mutationFired: 0, bySite: [] },
  metrics: { RecalcStyleCount: 89, LayoutCount: 0, TaskDuration: 0.045 },
  load1: 8,
  infiniteAnimations: [
    { key: CM1, name: 'cm-blink', selector: 'div.cm-cursorLayer.cm-vimCursorLayer', count: 1 },
    { key: CM2, name: 'cm-blink', selector: 'div.cm-layer.cm-layer-above.cm-cursorLayer', count: 1 },
  ],
  controls: { appBurstRafFired: 2, openTurnAnimCount: 5, closedTurnAnimCount: 2, probeTimerFired: 50, probeRoFired: 6, probeMoFired: 5,
    framesBefore: true, framesAfter: true, visibility: 'visible', animProbeSeen: true, animProbeCleared: true, sameEpoch: true, elapsedMs: 10004,
    instrumentFirst: true, busOpen: true, requireBus: true, bundleIdentity: true, settled: true },
});
const clause = (v: ReturnType<typeof judge>, name: string) => v.clauses.find((c) => c.name === name)!;

test('a healthy idle measurement PASSES (rc 0) and every clause is ok', () => {
  const v = judge(good(), budget);
  assert.equal(v.verdict, 'PASS');
  assert.equal(v.exitCode, 0);
  assert.ok(v.clauses.every((c) => c.ok), renderClauses(v).join('\n'));
  assert.equal(v.clauses.length, 19); // 13 controls + 6 budgets: a dropped clause would read as a smaller, still-green set
});

test('a perpetual rAF loop FAILS budget/idle-raf and NAMES the scheduler, its bucket series and the bundle snippet', () => {
  const m = good();
  m.raf = { fired: 372, scheduled: 372, perSecond: [62, 62, 62], bySite: [{ site: 'tick (index-x.js:10:5)', scheduled: 372, fired: 372, snippet: 'const tick=()=>{n=0,raf=requestAnimationFrame(tick)}' }, { site: 'other (a.js:1:1)', scheduled: 1, fired: 0 }] };
  const v = judge(m, budget);
  assert.equal(v.verdict, 'FAIL');
  assert.equal(v.exitCode, 1);
  const c = clause(v, 'budget/idle-raf');
  assert.equal(c.ok, false);
  assert.match(c.detail, /372 rAF callback\(s\)/);
  assert.match(c.detail, /tick \(index-x\.js:10:5\) ×372 «const tick=\(\)=>\{n=0,raf=requestAnimationFrame\(tick\)\}»/);
  assert.match(c.detail, /per-second \[62,62,62\]/);
  assert.doesNotMatch(c.detail, /other \(a\.js/, 'a site that scheduled but never fired is not an offender');
});

test('one stray rAF callback breaches a zero budget; a raised budget admits exactly that many', () => {
  const m = good(); m.raf = { fired: 1, scheduled: 1, perSecond: [1, 0, 0], bySite: [{ site: 's', scheduled: 1, fired: 1 }] };
  assert.equal(judge(m, budget).verdict, 'FAIL');
  assert.equal(judge(m, { ...budget, rafFired: 1 }).verdict, 'PASS');
});

test('a recurring short timer FAILS budget/short-timer-loops naming the site; a one-shot short timer and long timers do not', () => {
  const m = good();
  m.timers = { totalFired: 3765, shortFired: 3765, loopSites: [{ site: 'interval:__c8MutantTimer16 (index-x.js:1:2)', fired: 3765 }] };
  const v = judge(m, budget);
  assert.equal(v.verdict, 'FAIL');
  assert.match(clause(v, 'budget/short-timer-loops').detail, /1 recurring short-delay \(< 100 ms\) timer site\(s\).*interval:__c8MutantTimer16 \(index-x\.js:1:2\) ×3765/);
  const oneShot = good(); oneShot.timers = { totalFired: 40, shortFired: 1, loopSites: [] };
  assert.equal(judge(oneShot, budget).verdict, 'PASS', 'a single short one-shot is not per-frame work (loopSites is empty)');
  assert.equal(judge(m, { ...budget, shortTimerLoops: 1 }).verdict, 'PASS');
});

test('ResizeObserver / MutationObserver callbacks over the measured baseline FAIL naming the constructing site; at the budget they pass', () => {
  const m = good();
  m.observers = { resizeFired: 3612, mutationFired: 0, bySite: [{ site: '__c8MutantRoInit (index-x.js:3:4)', kind: 'ro', fired: 3612 }, { site: 'noise (a.js:1:1)', kind: 'mo', fired: 0 }] };
  let v = judge(m, budget);
  assert.equal(v.verdict, 'FAIL');
  assert.match(clause(v, 'budget/resize-observer').detail, /3612 ResizeObserver callback\(s\) \(budget 10\); top: __c8MutantRoInit \(index-x\.js:3:4\) ×3612/);
  assert.equal(clause(v, 'budget/mutation-observer').ok, true);
  m.observers = { resizeFired: 0, mutationFired: 50, bySite: [{ site: '__c8MutantMoInit (index-x.js:5:6)', kind: 'mo', fired: 50 }] };
  v = judge(m, budget);
  assert.match(clause(v, 'budget/mutation-observer').detail, /50 MutationObserver callback\(s\).*__c8MutantMoInit/);
  assert.equal(clause(v, 'budget/resize-observer').ok, true);
  m.observers = { resizeFired: 10, mutationFired: 10, bySite: [] };
  assert.equal(judge(m, budget).verdict, 'PASS', 'exactly at the budget passes');
  m.observers = { resizeFired: 11, mutationFired: 0, bySite: [] };
  assert.equal(judge(m, budget).verdict, 'FAIL', 'one over fails');
  m.observers = { resizeFired: 0, mutationFired: 11, bySite: [] };
  assert.equal(judge(m, budget).verdict, 'FAIL', 'one MutationObserver callback over fails too (its own boundary)');
});

test('the metrics catch-all: style / layout / task-time over budget FAIL naming the metric; scaled by window; TaskDuration is VOID under load', () => {
  const m = good();
  m.metrics = { RecalcStyleCount: 1231, LayoutCount: 2, TaskDuration: 1.07 };
  let v = judge(m, budget);
  assert.equal(v.verdict, 'FAIL');
  assert.match(clause(v, 'budget/metrics').detail, /OVER: RecalcStyleCount 1231 > 300, TaskDuration 1\.070 s > 0\.5 s/);
  m.metrics = { RecalcStyleCount: 89, LayoutCount: 604, TaskDuration: 0.045 };
  assert.match(clause(judge(m, budget), 'budget/metrics').detail, /OVER: LayoutCount 604 > 10/);
  // at the limit passes, one over fails
  m.metrics = { RecalcStyleCount: 300, LayoutCount: 10, TaskDuration: 0.5 };
  assert.equal(judge(m, budget).verdict, 'PASS');
  m.metrics = { RecalcStyleCount: 301, LayoutCount: 10, TaskDuration: 0.5 };
  assert.equal(judge(m, budget).verdict, 'FAIL');
  // a 20 s window doubles the allowance; a 5 s window halves it
  m.metrics = { RecalcStyleCount: 500, LayoutCount: 0, TaskDuration: 0.1 };
  assert.equal(judge({ ...m, windowMs: 20000, controls: { ...m.controls, elapsedMs: 20004 } }, budget).verdict, 'PASS');
  assert.equal(judge({ ...m, windowMs: 5000 }, budget).verdict, 'FAIL');
  // load > ceiling: TaskDuration is not judged (reported VOID); the deterministic counts still are
  m.windowMs = 10000;
  m.metrics = { RecalcStyleCount: 89, LayoutCount: 0, TaskDuration: 9 }; m.load1 = 25;
  v = judge(m, budget);
  assert.equal(v.verdict, 'PASS');
  assert.match(clause(v, 'budget/metrics').detail, /VOID — load 25 > 20, not judged/);
  m.metrics = { RecalcStyleCount: 5000, LayoutCount: 0, TaskDuration: 9 };
  assert.equal(judge(m, budget).verdict, 'FAIL', 'a VOID TaskDuration never voids the deterministic style count');
});

test('the animation allowlist is keyed name@selector: another selector, a 2nd instance, or an unlisted name FAIL; exact keys pass', () => {
  const m = good();
  m.infiniteAnimations = [{ key: 'cm-blink@div.elsewhere', name: 'cm-blink', selector: 'div.elsewhere', count: 2 }];
  let v = judge(m, budget);
  assert.equal(v.verdict, 'FAIL');
  assert.match(clause(v, 'budget/infinite-animations').detail, /cm-blink@div\.elsewhere ×2 \(allowed 0\)/, 'cm-blink on an UNRELATED element is not the composer cursor layer');
  m.infiniteAnimations = [{ key: CM1, name: 'cm-blink', selector: 'div.cm-cursorLayer.cm-vimCursorLayer', count: 2 }];
  v = judge(m, budget);
  assert.ok(clause(v, 'budget/infinite-animations').detail.includes(`${CM1} ×2 (allowed 1)`), 'a 2nd instance on the allowlisted selector is over');
  m.infiniteAnimations = [{ key: 'av-shimmer@span.av-turn-running-label', name: 'av-shimmer', selector: 'span.av-turn-running-label', count: 1 }];
  assert.match(clause(judge(m, budget), 'budget/infinite-animations').detail, /av-shimmer@span\.av-turn-running-label ×1 \(allowed 0\)/);
  m.infiniteAnimations = [];
  assert.equal(judge(m, budget).verdict, 'PASS', 'an unfocused composer (no blink at all) is within the allowlist');
  assert.equal(judge(good(), DEFAULT_BUDGET).verdict, 'FAIL', 'strict default: even the allowlisted caret blink breaches it');
});

// Each control must REFUSE (rc 4) on its own — a run that could not have seen the work must never read PASS, even with 0 of everything.
const controlMutants: Array<[string, (m: IdleMeasurement) => void]> = [
  ['control/panes-mounted', (m) => { m.panes.avViews = 3; }],
  ['control/panes-mounted', (m) => { m.panes.avViewsAtEnd = 0; }],
  ['control/panes-mounted', (m) => { m.panes.rowsPerPane = [90, 90, 0, 90, 90, 90]; }],
  ['control/panes-mounted', (m) => { m.panes.rowsPerPane = [90, 90, 90]; }],
  ['control/panes-mounted', (m) => { m.panes.visibleRows = 0; }],
  ['control/rich-subject', (m) => { m.rich.distinctAvClasses = 46; }],
  ['control/rich-subject', (m) => { m.rich.markers['tool-runs'] = false; }],
  ['control/rich-subject', (m) => { m.rich.markers['bgtask-panel'] = false; }],
  ['control/rich-subject', (m) => { m.rich.markers = {}; }],
  ['control/panes-idle', (m) => { m.panes.openTurns = 1; }],
  ['control/raf-instrument', (m) => { m.controls.appBurstRafFired = 0; }],
  ['control/observer-instrument', (m) => { m.controls.probeTimerFired = 0; }],
  ['control/observer-instrument', (m) => { m.controls.probeRoFired = 0; }],
  ['control/observer-instrument', (m) => { m.controls.probeMoFired = 0; }],
  ['control/instrument-first', (m) => { m.controls.instrumentFirst = false; }],
  ['control/frames-delivered', (m) => { m.controls.framesBefore = false; }],
  ['control/frames-delivered', (m) => { m.controls.framesAfter = false; }],
  ['control/frames-delivered', (m) => { m.controls.visibility = 'hidden'; }],
  ['control/turn-animations', (m) => { m.controls.closedTurnAnimCount = 5; }],
  ['control/animation-census', (m) => { m.controls.animProbeSeen = false; }],
  ['control/animation-census', (m) => { m.controls.animProbeCleared = false; }],
  ['control/metrics-read', (m) => { m.metrics = null; }],
  ['control/metrics-read', (m) => { m.metrics = { RecalcStyleCount: NaN, LayoutCount: 0, TaskDuration: 0 }; }],
  ['control/window-intact', (m) => { m.controls.sameEpoch = false; }],
  ['control/window-intact', (m) => { m.controls.elapsedMs = 4000; }],
  ['control/bus-open', (m) => { m.controls.busOpen = false; }],
  ['control/bus-open', (m) => { m.controls.busOpen = null; }],
  ['control/bundle-identity', (m) => { m.controls.bundleIdentity = false; }],
];
for (const [name, mutate] of controlMutants) {
  test(`${name} failing REFUSES the run (rc 4) even with nothing over budget — variant: ${mutate.toString().slice(0, 70)}`, () => {
    const m = good();
    mutate(m);
    const v = judge(m, budget);
    assert.equal(v.verdict, 'REFUSED');
    assert.equal(v.exitCode, 4);
    assert.equal(clause(v, name).ok, false, `${name} must be the clause that fired`);
    // exactly the mutated control fired: the other controls stay ok (a mutant caught by an unrelated clause proves nothing)
    assert.deepEqual(v.clauses.filter((c) => c.kind === 'control' && !c.ok).map((c) => c.name), [name]);
  });
}

test('a REFUSED run never reports PASS even when a budget is also breached (refusal wins: the counts are untrustworthy)', () => {
  const m = good(); m.controls.appBurstRafFired = 0; m.raf = { fired: 99, scheduled: 99, bySite: [], perSecond: [99] };
  assert.equal(judge(m, budget).verdict, 'REFUSED');
});

test('the elapsed-window control tolerates 2% timer slack and no more', () => {
  const m = good(); m.controls.elapsedMs = 9800;
  assert.equal(judge(m, budget).verdict, 'PASS');
  m.controls.elapsedMs = 9799;
  assert.equal(judge(m, budget).verdict, 'REFUSED');
});

test('the bus is only REQUIRED when asked: a dev run (requireBus off) passes with the bus down, a release run refuses', () => {
  const m = good(); m.controls.busOpen = false; m.controls.requireBus = false;
  const v = judge(m, budget);
  assert.equal(v.verdict, 'PASS');
  assert.match(clause(v, 'control/bus-open').detail, /FAILED to open.*informational/);
  m.controls.requireBus = true;
  assert.equal(judge(m, budget).verdict, 'REFUSED');
});

test('parseBudget: defaults, the shipped shape, and refusal of typos / bad values / a bare animation name', () => {
  assert.deepEqual(parseBudget({}), DEFAULT_BUDGET);
  assert.deepEqual(parseBudget({ _comment: 'x', rafFired: 2, infiniteAnimations: { 'cm-blink@div.x': 2 }, metricsPer10s: { RecalcStyleCount: 1.5 } }),
    { ...DEFAULT_BUDGET, rafFired: 2, infiniteAnimations: { 'cm-blink@div.x': 2 }, metricsPer10s: { ...DEFAULT_BUDGET.metricsPer10s, RecalcStyleCount: 1.5 } });
  for (const bad of [null, [], 'x', { rafFired: -1 }, { rafFired: 1.5 }, { rafFired: '0' }, { rafFired: 0, infiniteAnimation: {} }, { infiniteAnimations: [] },
    { infiniteAnimations: { 'cm-blink': 1 } }, { infiniteAnimations: { 'cm-blink@': 1 } }, { infiniteAnimations: { 'a@b': -1 } }, { infiniteAnimations: { 'a@b': 'x' } },
    { shortTimerLoops: -1 }, { resizeObserverFired: 1.5 }, { mutationObserverFired: '1' }, { minDistinctAvClasses: -1 },
    { metricsPer10s: { Recalc: 1 } }, { metricsPer10s: { TaskDuration: -1 } }, { metricsPer10s: { LayoutCount: 'x' } }, { metricsPer10s: [] }, { loadVoidAbove: -1 }]) {
    assert.throws(() => parseBudget(bad), undefined, JSON.stringify(bad));
  }
});

test('the shipped scripts/ui-idle-budget.json parses under the shipped parser and pins the calibrated baseline', () => {
  const raw = JSON.parse(readFileSync(new URL('../../scripts/ui-idle-budget.json', import.meta.url), 'utf8'));
  assert.deepEqual(parseBudget(raw), { ...budget });
});

test('renderClauses prefixes ok / REFUSE / FAIL so a grep for a clause name finds its verdict', () => {
  const m = good(); m.raf = { fired: 3, scheduled: 3, perSecond: [3], bySite: [{ site: 'x', scheduled: 3, fired: 3 }] };
  const lines = renderClauses(judge(m, budget));
  assert.ok(lines.some((l) => l.startsWith('FAIL   budget/idle-raf:')));
  assert.ok(lines.some((l) => l.startsWith('ok     control/panes-mounted:')));
  const r = renderClauses(judge({ ...good(), controls: { ...good().controls, sameEpoch: false } }, budget));
  assert.ok(r.some((l) => l.startsWith('REFUSE control/window-intact:')));
});
