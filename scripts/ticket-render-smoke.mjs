// Render smoke-test for the Tickets sidebar section.
//
// Why this exists: `node --test --experimental-strip-types` strips types but
// does NOT transform JSX, so a .tsx component cannot be tested by the normal
// suite. Yet "the store holds the right tickets" and "the section renders" are
// two different claims — a passing store test says nothing about whether the
// user sees a row. This bundles the real TicketRow with esbuild and renders it
// to static HTML, so the assertions below are about actual output.
//
// Deliberately scoped to TicketRow rather than the whole Sidebar: Sidebar pulls
// in the Zustand store, Monaco, IPC and the window.orchestra bridge, none of
// which exist under Node. TicketRow is the component this feature adds.
//
// Run: node scripts/ticket-render-smoke.mjs

// esbuild is not a direct dependency — resolve the copy vite already ships
// rather than adding one just for this harness.
import { createRequire } from 'node:module';
const require_ = createRequire(import.meta.url);
const { build } = require_(
  process.env.ORCHESTRA_ESBUILD ??
    require_.resolve('esbuild', { paths: [process.cwd() + '/node_modules/vite'] }),
);
import { renderToString } from 'react-dom/server';
import React from 'react';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// The bundle must live inside the repo so its `react` import resolves to the
// project's own copy (the same instance this harness imports).
const outfile = path.join(repoRoot, 'node_modules', '.cache', 'ticket-render-smoke.mjs');

const entry = `
import { TicketRow } from ${JSON.stringify(path.join(repoRoot, 'src/renderer/components/Sidebar.tsx'))};
export { TicketRow };
`;
const entryFile = path.join(repoRoot, 'node_modules', '.cache', 'ticket-entry.tsx');
fs.mkdirSync(path.dirname(entryFile), { recursive: true });
fs.writeFileSync(entryFile, entry);

await build({
  entryPoints: [entryFile],
  outfile,
  bundle: true,
  format: 'esm',
  platform: 'node',
  jsx: 'automatic',
  // Keep React external so the component uses the SAME react instance as this
  // harness; bundling a second copy breaks renderToString.
  // Bundle everything except React so esbuild resolves the transitive CSS and
  // browser-only imports itself (Node cannot load a .css). React stays external
  // so the component uses the SAME instance this harness renders with.
  external: ['react', 'react-dom', 'react/jsx-runtime'],
  // CSS side-effect imports reached via the component graph become no-ops.
  loader: { '.css': 'empty' },
  logLevel: 'silent',
});

// Sidebar.tsx transitively imports the renderer store, which subscribes to
// `window.orchestra.*` push channels at module scope. Under Node there is no
// window, so stub just enough for import to succeed — this harness renders one
// component, it does not exercise the IPC bridge.
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

const { TicketRow } = await import(`${outfile}?t=${Date.now()}`);

const ticket = {
  identifier: 'NMC-303',
  url: 'https://linear.app/acme/issue/NMC-303/carrier-drift',
  title: 'Carrier shipped-at drift on re-created parcels',
  state: { name: 'In Progress', type: 'started' },
  pinnedAt: 1,
  repoPath: '/repo/vecna-api',
};

let failures = 0;
const check = (label, cond, detail = '') => {
  if (cond) {
    console.log(`  ok   ${label}`);
  } else {
    failures++;
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
};

console.log('TicketRow renders a pinned ticket:');
const html = renderToString(
  React.createElement(TicketRow, {
    ticket,
    repos: [{ path: '/repo/vecna-api', name: 'vecna-api', defaultBranch: 'main' }],
    onOpen: () => {},
    onSpawn: () => {},
    onRemove: () => {},
  }),
);

check('identifier is rendered', html.includes('NMC-303'));
check('title is rendered', html.includes('Carrier shipped-at drift'));
check('state chip shows Linear’s state NAME', html.includes('In Progress'));
// The two design invariants that must not silently regress.
check(
  'leading glyph is the DIAMOND, tinted by state TYPE (never .ws-dot)',
  html.includes('ticket-dot started') && !html.includes('ws-dot'),
  'a ticket must never read as an agent with a status',
);
check('chip tints on state.type, not the free-text name', html.includes('state-chip started'));
check('spawn button is enabled when a repo is known', !/ticket-btn"[^>]*disabled/.test(html));

// Degenerate inputs: a ticket with no state and no repo must still render, with
// the spawn affordance disabled rather than silently spawning into nothing.
console.log('TicketRow degrades safely with no state and no repo:');
const bare = renderToString(
  React.createElement(TicketRow, {
    ticket: { identifier: 'NMC-9', url: 'https://linear.app/a/issue/NMC-9', title: 'Bare', pinnedAt: 1 },
    repos: [],
    onOpen: () => {},
    onSpawn: () => {},
    onRemove: () => {},
  }),
);
check('renders without a state chip', bare.includes('NMC-9') && !bare.includes('state-chip'));
check('falls back to the unstarted diamond', bare.includes('ticket-dot unstarted'));
check('spawn button is DISABLED with no repo', bare.includes('disabled'));

// A single registered repo is unambiguous, so spawning is allowed even when the
// ticket itself carries no repoPath.
const oneRepo = renderToString(
  React.createElement(TicketRow, {
    ticket: { identifier: 'NMC-9', url: 'https://linear.app/a/issue/NMC-9', title: 'Bare', pinnedAt: 1 },
    repos: [{ path: '/only/repo', name: 'only', defaultBranch: 'main' }],
    onOpen: () => {},
    onSpawn: () => {},
    onRemove: () => {},
  }),
);
check('single registered repo enables spawn', !oneRepo.includes('disabled'));

console.log(failures === 0 ? '\nALL RENDER CHECKS PASSED' : `\n${failures} RENDER CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
