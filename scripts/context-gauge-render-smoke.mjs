// Render smoke-test for the context gauge (issue #15).
//
// WHY THIS EXISTS — it closes a coverage hole the unit suite structurally
// cannot see, found by the verifier: he re-added `if (!window) return null` to
// ContextGauge (reverting the exact behaviour the detached-session spec depends
// on) and all 844 unit tests still PASSED, because the behaviour lives in a
// React component that `node --test` never renders. He then had to build and
// drive the real app to catch it. A regression that only a full E2E can see
// will eventually ship, so the invariant is pinned here instead.
//
// `node --test --experimental-strip-types` strips types but does NOT transform
// JSX, so this bundles the REAL component with esbuild and renders it to static
// HTML — the assertions below are about actual output, not about a reducer that
// happens to hold the right numbers. Those are two different claims.
//
// Scoped to StripStats (the exported, actually-mounted wrapper) rather than the
// private ContextGauge: this tests the real mount path a user sees, and does not
// widen the module's API just to be testable.
//
// Run: node scripts/context-gauge-render-smoke.mjs

import { createRequire } from 'node:module';
const require_ = createRequire(import.meta.url);
// Resolve the esbuild vite already ships rather than adding a dependency just
// for this harness. pnpm's layout means it may live under node_modules/vite OR
// only in the .pnpm store, so try both before giving up.
function loadEsbuild() {
  const roots = [
    process.cwd() + '/node_modules/vite',
    process.cwd() + '/node_modules',
    process.cwd(),
  ];
  for (const paths of roots) {
    try {
      return require_(require_.resolve('esbuild', { paths: [paths] }));
    } catch {
      /* try the next root */
    }
  }
  const store = require_('node:fs')
    .globSync?.(process.cwd() + '/node_modules/.pnpm/esbuild@*/node_modules/esbuild') ?? [];
  if (store.length) return require_(store[0]);
  throw new Error('esbuild not resolvable — run `pnpm install` first');
}
const { build } = process.env.ORCHESTRA_ESBUILD
  ? require_(process.env.ORCHESTRA_ESBUILD)
  : loadEsbuild();
import { renderToString } from 'react-dom/server';
import React from 'react';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outfile = path.join(repoRoot, 'node_modules', '.cache', 'context-gauge-render-smoke.mjs');
const entry = `
import { StripStats } from ${JSON.stringify(path.join(repoRoot, 'src/renderer/components/agent/TurnFooter.tsx'))};
export { StripStats };
`;
const entryFile = path.join(repoRoot, 'node_modules', '.cache', 'context-gauge-entry.tsx');
fs.mkdirSync(path.dirname(entryFile), { recursive: true });
fs.writeFileSync(entryFile, entry);

await build({
  entryPoints: [entryFile],
  outfile,
  bundle: true,
  format: 'esm',
  platform: 'node',
  jsx: 'automatic',
  external: ['react', 'react-dom', 'react/jsx-runtime'],
  loader: { '.css': 'empty' },
  logLevel: 'silent',
});

const noop = () => () => {};
const bridge = new Proxy(
  {},
  {
    get: (_t, prop) =>
      typeof prop === 'string' && prop.startsWith('on') ? noop : async () => undefined,
  },
);
globalThis.self = globalThis;
globalThis.window = { orchestra: bridge, addEventListener: () => {}, removeEventListener: () => {} };
globalThis.document = { addEventListener: () => {}, removeEventListener: () => {} };
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };

const { StripStats } = await import(`${outfile}?t=${Date.now()}`);

let failures = 0;
const check = (label, cond, detail = '') => {
  if (cond) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
};

/** A folded session carrying only what the gauge reads. */
const session = (contextUsage, lastTurn) => ({
  contextUsage,
  lastTurn,
  totalCostUsd: 0,
  messages: [],
  pendingPermissions: [],
});
const render = (s) => renderToString(React.createElement(StripStats, { session: s }));

// ── THE INVARIANT THE VERIFIER'S MUTATION BROKE ─────────────────────────────
// A transcript reading has maxTokens === null BY DESIGN (the transcript records
// no window — measured absent on all 1,543 real assistant lines). The gauge
// must render the TRUE TOKEN COUNT there, never nothing. Re-adding a
// window-required early return makes this the ONLY failing assertion.
console.log('detached/history session (window unknown):');
{
  const html = render(
    session({ totalTokens: 502955, maxTokens: null, percentage: null, source: 'transcript', at: 1 }),
  );
  check('gauge RENDERS with no window (the detached-session bug)', html.includes('av-turn-context'),
    'a windowless reading must not vanish — this is what the E2E caught');
  check('shows the true token count', html.includes('503k'));
  check('shows NO fabricated percentage', !html.includes('%<') && !/>\d+%</.test(html));
  check('provenance is readable', html.includes('data-context-source="transcript"'));
}

console.log('live session (window known):');
{
  const html = render(
    session({ totalTokens: 73191, maxTokens: 200000, percentage: 37, source: 'live', at: 1 }),
  );
  check('renders the percentage', html.includes('37%'));
  check('provenance says live', html.includes('data-context-source="live"'));
  check('quiet at 37% (not amber/red)', html.includes('av-turn-context-ok'));
}

console.log('a [1m] transcript reading still gets a real percentage:');
{
  const html = render(
    session({ totalTokens: 502955, maxTokens: 1000000, percentage: 50, source: 'transcript', at: 1 }),
  );
  check('renders 50%, not a token count', html.includes('50%'));
}

console.log('threshold styling:');
{
  const at = (pct) =>
    render(session({ totalTokens: pct * 2000, maxTokens: 200000, percentage: pct, source: 'live', at: 1 }));
  check('amber at 75%', at(75).includes('av-turn-context-low'));
  check('red at 90%', at(90).includes('av-turn-context-critical'));
  // An over-limit session must READ past 100% while the BAR stays clamped.
  const over = render(
    session({ totalTokens: 220000, maxTokens: 200000, percentage: 110, source: 'live', at: 1 }),
  );
  check('over-limit reads 110%, not pinned to 100', over.includes('110%'));
  check('but the bar fill is clamped to 100%', over.includes('width:100%'));
}

console.log('turn-end fallback (no emitted reading):');
{
  const html = render(session(undefined, {
    type: 'turn-end', isError: false, numTurns: 1, costUsd: 0.01, durationMs: 10,
    usage: null, contextUsedTokens: 50000, contextWindow: 200000,
  }));
  check('renders from turn-end fields', html.includes('25%'));
  check('and is TAGGED turn-end, not live', html.includes('data-context-source="turn-end"'),
    'a fabricated turn-end must be distinguishable from a real live reading');
}

console.log('nothing to show:');
{
  check('no reading and no turn -> renders nothing', render(session(undefined, undefined)) === '');
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
