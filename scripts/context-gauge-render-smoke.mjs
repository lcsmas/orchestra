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
// SELECTOR CONTRACT (composition with #16, the breakdown UI): every assertion
// below keys on a CLASS, `data-context-source`, or rendered TEXT — never on the
// element's TAG. #16 turns this node into a <button class=av-turn-context-btn>
// inside .av-ctx-anchor whenever the reading carries a breakdown, so a
// `div.av-turn-context` assertion would pass here and break legitimately there.
// Stable across both branches: `.av-turn-context`, `[data-context-source]`.
// NOR on POSITION: these assertions substring-match the rendered HTML and do no
// DOM walking (no nth-child, no direct-child paths, no parentElement), so extra
// nesting cannot break them — #16 wraps the node in <div class=av-ctx-anchor>,
// one level deeper.
// Verified by simulation, not assumed: patching the component to render #16's
// exact structure — a <button class=av-turn-context-btn aria-label=...> inside
// <div class=av-ctx-anchor> — leaves this harness ALL PASS, unchanged.
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
// The panel BODY, exported so its interior can be rendered without a click:
// the popover is closed in the initial DOM by design, so a StripStats render
// can never reach the detail lists (issue #31's render assertion failed this
// way first). ContextBreakdownBody was written standalone-renderable for
// exactly this.
import { ContextBreakdownBody } from ${JSON.stringify(path.join(repoRoot, 'src/renderer/components/agent/ContextBreakdownPanel.tsx'))};
import { buildContextBreakdown } from ${JSON.stringify(path.join(repoRoot, 'src/shared/context-breakdown.ts'))};
// #26 item 1: the tool card's STRUCTURAL denied/interrupted/cancelled state.
// Rendered here for the same reason the gauge is: the classification lives in a
// React component, so the unit suite can prove the normalizer emits the kind
// but never that the card SHOWS it.
import { ToolCard } from ${JSON.stringify(path.join(repoRoot, 'src/renderer/components/agent/ToolCard.tsx'))};
export { StripStats, ContextBreakdownBody, buildContextBreakdown, ToolCard };
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

const { StripStats, ContextBreakdownBody, buildContextBreakdown, ToolCard } = await import(`${outfile}?t=${Date.now()}`);

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

// ── #16: the breakdown panel's SHOW/HIDE, rendered ──────────────────────────
// Same coverage argument as everything above, one level up: `expandable` is
// decided in describeContextGauge (pure, unit-tested), but whether the gauge
// becomes a BUTTON with a panel is a fact about the rendered DOM, and the unit
// suite cannot see it. Note every fixture above carries NO categories, so all of
// them exercise the plain-div path only — without these two cases the button
// path had zero render coverage and a regression there would have been silent.
console.log('#16 breakdown panel:');
{
  const withBreakdown = {
    totalTokens: 73191, maxTokens: 200000, percentage: 37, source: 'live', at: 1,
    categories: [
      { name: 'Memory files', tokens: 52060, kind: 'used' },
      { name: 'System tools', tokens: 14144, kind: 'used' },
      { name: 'MCP tools (deferred)', tokens: 52191, kind: 'deferred' },
      { name: 'Free space', tokens: 126809, kind: 'free' },
    ],
    memoryFiles: [{ path: '/home/u/proj/CLAUDE.md', type: 'Project', tokens: 50815 }],
    mcpTools: [{ name: 'mcp__github__create_issue', serverName: 'github', tokens: 890 }],
  };
  const html = render(session(withBreakdown));
  check('a reading WITH categories renders a button', html.includes('av-turn-context-btn'));
  check('the button is wrapped in the popover anchor', html.includes('av-ctx-anchor'));
  check('it advertises the dialog', html.includes('aria-haspopup="dialog"'));
  check('closed by default — no panel in the initial DOM', !html.includes('av-ctx-panel'));
  check('provenance still readable on the button', html.includes('data-context-source="live"'));
  check('the gauge still reads 37%', html.includes('37%'));

  // The degradation half. A transcript reading can look "complete" (it carries a
  // window and a percentage on the [1m] path) yet has no breakdown — it must
  // stay a plain div, or every history pane offers a click that opens nothing.
  const noBreakdown = render(
    session({ totalTokens: 502955, maxTokens: 1000000, percentage: 50, source: 'transcript', at: 1 }),
  );
  check('a reading WITHOUT a breakdown stays a plain div', !noBreakdown.includes('av-turn-context-btn'));
  check('...and offers no popover anchor', !noBreakdown.includes('av-ctx-anchor'));
  check('...but still renders the gauge', noBreakdown.includes('av-turn-context'));

  // #31: a plugin-sourced skill must render its PLUGIN as the meta, not the
  // bare source 'plugin'. Rendered via ContextBreakdownBody rather than
  // StripStats: the popover is CLOSED in the initial DOM, so a StripStats
  // render structurally cannot reach the skills list — my first version of
  // this assertion failed for exactly that reason, against correct code.
  // This is also the FIRST render coverage of the detail-list markup
  // (.av-ctx-section / .av-ctx-list), which no harness had ever exercised.
  {
    const usage = {
      totalTokens: 5000, maxTokens: 200000, percentage: 3, source: 'live', at: 1,
      categories: [{ name: 'Skills', tokens: 28, kind: 'used' }],
      skills: [
        { name: 'channel-digest', source: 'plugin', pluginName: 'slack', tokens: 22 },
        { name: 'retro', source: 'userSettings', tokens: 6 },
      ],
      memoryFiles: [{ path: '/home/u/proj/CLAUDE.md', type: 'Project', tokens: 50815 }],
      mcpTools: [
        { name: 'mcp__github__a', serverName: 'github', tokens: 10 },
        { name: 'mcp__github__b', serverName: 'github', tokens: 20 },
      ],
    };
    const breakdown = buildContextBreakdown(usage);
    const html = renderToString(
      React.createElement(ContextBreakdownBody, { usage, breakdown }),
    );
    check('#31 plugin skill renders its plugin name', html.includes('slack'));
    check('#31 non-plugin skill still renders its source', html.includes('userSettings'));
    check('detail sections render at all (first coverage)', html.includes('av-ctx-section'));
    check('memory file path is shortened', html.includes('CLAUDE.md'));
    check('mcp tools group by server', html.includes('github') && html.includes('2 tools'));
  }

  // The null-window arm INSIDE the button. `label` is computed in the pure layer
  // ('503k' when there is no percentage), and the aria-label interpolates it —
  // so a live reading that carries a breakdown but no window must announce the
  // token count, never a fabricated percentage. Every other button fixture has a
  // window, so without this case that arm is unexercised.
  const noWindowExpandable = render(session({
    totalTokens: 502955, maxTokens: null, percentage: null, source: 'live', at: 1,
    categories: [{ name: 'Memory files', tokens: 52060, kind: 'used' }],
  }));
  check('windowless + breakdown still renders a button', noWindowExpandable.includes('av-turn-context-btn'));
  check('...and its aria-label reads the token count', noWindowExpandable.includes('Context 503k used'));
  // Scoped to the READOUT, not the raw HTML: the bar legitimately carries
  // `width:0%` (a clamped fill for an unknown window), so a bare /\d+%/ over the
  // markup fails against correct code — my first version of this assertion did
  // exactly that. Assert on the displayed value and the aria-label instead.
  check('...with no fabricated percentage in the readout',
    !/>\s*\d+%\s*</.test(noWindowExpandable) && !/aria-label="[^"]*\d+%/.test(noWindowExpandable));

  // Content-gated, not source-gated: a LIVE reading whose categories all came
  // back zero has nothing to show and must degrade identically.
  const zeroCats = render(session({
    totalTokens: 100, maxTokens: 200000, percentage: 0, source: 'live', at: 1,
    categories: [{ name: 'Messages', tokens: 0, kind: 'used' }],
  }));
  check('a LIVE reading with only zero-token categories degrades too', !zeroCats.includes('av-turn-context-btn'),
    'this is the case a source-gate would wrongly let through into an empty panel');
}

console.log('nothing to show:');
{
  check('no reading and no turn -> renders nothing', render(session(undefined, undefined)) === '');
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
// ─── #26 item 1: tool card renders the structural classification ────────────
// SELECTOR CONTRACT: assertions key on rendered TEXT and on `data-nonexec`,
// never on tags or positions, so restyling cannot silently break them.
console.log('tool card classification (#26):');
const toolMsg = (toolResult) => ({
  id: 'tc1',
  role: 'tool',
  at: 0,
  toolUse: { toolUseId: 'tc1', name: 'Bash', inputJson: '{}', input: { command: 'rm -rf /' } },
  toolResult,
  done: true,
});
const renderTool = (toolResult) =>
  renderToString(React.createElement(ToolCard, { message: toolMsg(toolResult) }));

{
  // A denial classified from the sidecar reads "denied", NOT "failed".
  const html = renderTool({
    content: 'The operation could not be completed.',
    isError: true,
    nonExecutionKind: 'user-rejected',
    userFeedback: 'use the other path',
  });
  check('a denied tool call renders "denied"', html.includes('denied'), html.slice(0, 200));
  check('...and is not mislabelled "failed"', !html.includes('failed'));
  check('...carrying the kind on data-nonexec', html.includes('data-nonexec="user-rejected"'));
  check('...and quotes the human deny comment', html.includes('use the other path'));
}
{
  const html = renderTool({ content: 'x', isError: true, nonExecutionKind: 'interrupted' });
  check('an interrupted tool call renders "interrupted"', html.includes('interrupted'));
  check('...and is not mislabelled "failed"', !html.includes('failed'));
}
{
  const html = renderTool({ content: 'x', isError: true, nonExecutionKind: 'cancelled' });
  check('a cancelled tool call renders "cancelled"', html.includes('cancelled'));
}
{
  // FALSIFIABILITY: the same errored card WITHOUT a sidecar must still read
  // "failed" — this is the arm that fails if classification were faked from
  // prose or defaulted on.
  const html = renderTool({
    content: 'The user doesn\u2019t want to proceed with this tool use.',
    isError: true,
    nonExecutionKind: null,
    userFeedback: null,
  });
  check('an unclassified error still reads "failed"', html.includes('failed'));
  check('...and carries no data-nonexec', !html.includes('data-nonexec'));
  check('...and shows no deny-comment block', !html.includes('av-tool-deny-feedback'));
}
{
  // A SUCCESSFUL call is never given an error/classification state.
  const html = renderTool({ content: 'ok', isError: false, nonExecutionKind: null });
  check('a successful tool call renders no failure word', !html.includes('failed'));
  check('...and no data-nonexec', !html.includes('data-nonexec'));
}

process.exit(failures === 0 ? 0 : 1);
