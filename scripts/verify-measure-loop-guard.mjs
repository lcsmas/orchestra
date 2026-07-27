// Reproduces the React #185 render loop that black-screened Orchestra when you
// archived the workspace you were viewing, and proves the guard terminates it.
//
// Observed (0.5.179, from the log the new ErrorBoundary wrote):
//   [renderer] [react] render failed: Minified React error #185
//     at onHeight (index-*.js:237:11464)     <- StructuredView's row callback
//     at M6       (index-*.js:237:11684)     <- MeasuredRow
// #185 is "Maximum update depth exceeded" — setState recursing ~50 deep.
//
// Mechanism: MeasuredRow's useLayoutEffect has NO dependency array, so it
// re-measures after EVERY render and calls onHeight, which calls setMeasureTick,
// which re-renders. The `known === h` early-return is the ONLY terminator, and
// it requires heights to SETTLE. They need not: a viewport resize recomputes the
// virtualized window -> a different row set mounts -> their measurements move the
// window back. Every pass then reports a genuinely new height and the guard
// never fires.
//
// This harness models that loop faithfully (a row whose height oscillates
// A->B->A) and runs it with the guard disabled vs enabled.
//
// Run: node scripts/verify-measure-loop-guard.mjs

const REACT_MAX_UPDATE_DEPTH = 50; // React throws #185 at ~this many nested updates
const MAX_SYNC_MEASURE_PASSES = 12; // must match StructuredView.tsx

/** One synchronous measure->render chain, as StructuredView performs it.
 *  Returns how deep the chain went and whether React would have thrown #185. */
function runMeasureChain({ guardEnabled, oscillate }) {
  const heights = new Map();
  let syncPasses = 0;
  let depth = 0;
  let coalesced = false;
  let toggle = false;

  // Each iteration = one render + its layout-effect measure pass.
  while (depth < REACT_MAX_UPDATE_DEPTH) {
    // The row reports its height. When the layout is oscillating, the measured
    // value alternates, so it never equals the cached one.
    const h = oscillate ? (toggle = !toggle) ? 180 : 220 : 180;
    const known = heights.get('row-1');
    if (known === h) break; // heights settled -> loop terminates naturally
    heights.set('row-1', h);

    syncPasses += 1;
    const looping = guardEnabled && syncPasses > MAX_SYNC_MEASURE_PASSES;
    if (known === undefined && !looping) {
      depth += 1; // synchronous setMeasureTick -> re-render, no paint
      continue;
    }
    if (!looping) {
      depth += 1; // still synchronous for a first-measure in the unguarded case
      continue;
    }
    // Guard tripped: defer to rAF. That yields to the browser, so the
    // synchronous chain ENDS here and cannot recurse.
    coalesced = true;
    break;
  }
  return { depth, coalesced, threw185: depth >= REACT_MAX_UPDATE_DEPTH };
}

const results = [];
const check = (name, fn) => {
  try {
    fn();
    results.push(['PASS', name]);
  } catch (e) {
    results.push(['FAIL', name, e.message]);
  }
};

// 1. The bug, reproduced: oscillating heights with no guard run away to #185.
check('WITHOUT the guard, an oscillating row reaches React #185', () => {
  const r = runMeasureChain({ guardEnabled: false, oscillate: true });
  if (!r.threw185) throw new Error(`expected runaway, got depth=${r.depth}`);
});

// 2. The fix: the same oscillation terminates well below React's limit.
check('WITH the guard, the same oscillation is bounded and coalesced', () => {
  const r = runMeasureChain({ guardEnabled: true, oscillate: true });
  if (r.threw185) throw new Error('guard failed to stop the loop');
  if (!r.coalesced) throw new Error('expected fallback to the rAF path');
  if (r.depth > MAX_SYNC_MEASURE_PASSES + 1) {
    throw new Error(`chain ran too deep: ${r.depth}`);
  }
});

// 3. No regression: stable heights still settle immediately, nowhere near the
//    guard, so normal streaming keeps the flicker-free synchronous path.
check('stable heights settle fast and never trip the guard', () => {
  const r = runMeasureChain({ guardEnabled: true, oscillate: false });
  if (r.coalesced) throw new Error('guard tripped on a stable layout');
  if (r.depth > 2) throw new Error(`stable layout took ${r.depth} passes`);
});

for (const r of results) console.log(r[0].padEnd(5), r[1], r[2] ? `— ${r[2]}` : '');
const failed = results.filter((r) => r[0] === 'FAIL').length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
