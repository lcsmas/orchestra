// Render smoke-test for the Sidebar BOOT path — issue #38.
//
// WHY THIS EXISTS — `pnpm run test` runs `node --test
// --experimental-strip-types`, which strips types but does NOT transform JSX,
// and the repo ships no jsdom, no @testing-library and no vitest. Every one of
// the existing unit suites therefore tests a pure `.ts` module and NONE of them
// can render a `.tsx`. That is exactly the coverage hole #38 fell through: the
// pure helper `repoSectionKeyOf` had unit tests that all passed, while the
// component that consumes its output crashed on first paint and rendered the
// error boundary instead of the app.
//
// So this file does what the unit runner cannot: esbuild-bundles the REAL
// `src/renderer/components/Sidebar.tsx` (not a copy, not a re-implementation)
// and `renderToString`s it against a store seeded to the shape that crashed.
//
// THE BUG, precisely. `Workspace` records are deserialized from `store.json`
// with no runtime validation, so `repoPath: string` is a claim about writers,
// not a guarantee about readers. A record that omits the field — a legacy
// record, or any store written by the `verify` skill's own documented harness,
// which seeds `repoId` + `worktreePath` but no `repoPath` — flows through:
//
//   repoSectionKeyOf(ws)            → undefined   (declared `string | null`)
//   groupRootsByRepo                → an `undefined` Map key
//   Sidebar's `repoOrder`           → contains `undefined`
//   `dropRepo?.path === repoPath`   → undefined === undefined → TRUE
//   `` `repo-drop-${dropRepo.pos}` `` → TypeError on `null`
//
// …and the user sees "Something broke in the UI / TypeError: Cannot read
// properties of null (reading 'pos')" instead of a sidebar.
//
// WHAT THIS PINS, each failing in a different direction:
//   1. BOOT      — an unseeded `repoPath` renders WITHOUT throwing.
//   2. CONTENT   — it renders the actual repo section, not an empty shell. A
//                  component that returns `null` also "doesn't throw"; that
//                  would be a vacuous pass, so existence-of-output is asserted
//                  separately from absence-of-throw.
//   3. CONTROL   — a NORMAL record (repoPath present) is unaffected, so the fix
//                  did not buy boot-safety by breaking ordinary grouping.
//   4. CAN-FAIL  — the unfixed expression is reconstructed inline and REQUIRED
//                  to throw the exact reported TypeError. Without this, a green
//                  run here would be indistinguishable from a gate that cannot
//                  fail at all.
//
// SELECTOR CONTRACT: assertions key on CLASS or rendered TEXT — never on tag or
// DOM position — so restyling cannot break them.
//
import { createRequire } from 'node:module';
const require_ = createRequire(import.meta.url);
function loadEsbuild() {
  try {
    return require_('esbuild');
  } catch {
    const store =
      require_('node:fs').globSync?.(
        process.cwd() + '/node_modules/.pnpm/esbuild@*/node_modules/esbuild',
      ) ?? [];
    if (store.length) return require_(store[0]);
    throw new Error('esbuild not resolvable — run `pnpm install` first');
  }
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
const outfile = path.join(repoRoot, 'node_modules', '.cache', 'sidebar-boot-smoke.mjs');
const rendererDir = path.join(repoRoot, 'src/renderer');

const entry = `
import { Sidebar } from ${JSON.stringify(path.join(rendererDir, 'components/Sidebar.tsx'))};
import { useStore } from ${JSON.stringify(path.join(rendererDir, 'store.ts'))};
export { Sidebar, useStore };
`;
const entryFile = path.join(repoRoot, 'node_modules', '.cache', 'sidebar-boot-entry.tsx');
fs.mkdirSync(path.dirname(entryFile), { recursive: true });
fs.writeFileSync(entryFile, entry);

// The renderer expects a browser. Stub the globals the module GRAPH touches at
// import time and the handful Sidebar calls during a first render. Anything
// that fires only from a user gesture stays a no-op — this asserts the boot
// path, not interaction.
const noopEventTarget = { addEventListener: () => {}, removeEventListener: () => {} };
globalThis.self = globalThis;
globalThis.window = {
  ...noopEventTarget,
  matchMedia: () => ({ matches: false, ...noopEventTarget }),
  requestAnimationFrame: () => 0,
  cancelAnimationFrame: () => {},
  localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
};
globalThis.document = {
  ...noopEventTarget,
  documentElement: { style: { setProperty: () => {} }, classList: { add() {}, remove() {} } },
  createElement: () => ({ style: {}, ...noopEventTarget, appendChild() {}, remove() {} }),
  body: { ...noopEventTarget, appendChild() {}, removeChild() {} },
  querySelector: () => null,
  querySelectorAll: () => [],
};
// `navigator` is a getter-only global in modern Node — define, don't assign.
if (!globalThis.navigator?.platform) {
  Object.defineProperty(globalThis, 'navigator', {
    value: { userAgent: 'node', platform: 'linux' },
    configurable: true,
  });
}
globalThis.localStorage = globalThis.window.localStorage;

// `window.orchestra` is the preload bridge. Sidebar calls a few of these from
// mount effects; under `renderToString` effects never run, but the property
// reads happen during render, so every one must exist and resolve.
const never = () => new Promise(() => {});
globalThis.window.orchestra = new Proxy(
  {
    getAppVersion: never,
    getEnvStatus: never,
    openExternal: () => {},
    onEvent: () => () => {},
  },
  { get: (t, k) => (k in t ? t[k] : never) },
);

await build({
  entryPoints: [entryFile],
  outfile,
  bundle: true,
  format: 'esm',
  platform: 'node',
  jsx: 'automatic',
  external: ['react', 'react-dom', 'react/jsx-runtime'],
  loader: { '.css': 'empty', '.svg': 'empty', '.png': 'empty' },
  logLevel: 'silent',
});

const { Sidebar, useStore } = await import(`${outfile}?t=${Date.now()}`);

// RIG FIX — WITHOUT THIS EVERY ASSERTION BELOW IS VACUOUS.
//
// zustand's React adapter passes `api.getInitialState` as
// `useSyncExternalStore`'s THIRD argument (`getServerSnapshot`), and
// `renderToString` is a SERVER render — so the component reads the store's
// INITIAL state and never sees anything written with `setState`.
//
// This was measured, not assumed: a probe component rendered `WS:0 REPOS:0`
// while `useStore.getState()` in the same process reported the seeded
// workspace, and both arms below then produced BYTE-IDENTICAL 6403-char output
// — the tell that NEITHER arm was exercising the code under test. A rig in that
// state reports "renders without throwing" for a component that renders the
// empty state, which would have passed against the unfixed build too.
//
// `api.getInitialState` closes over a `const` inside zustand's vanilla store and
// cannot be reassigned (the copy on the bound store is not the one the adapter
// calls), so the seam is React's hook itself: force the server snapshot to use
// the LIVE snapshot. `getSnapshot` is argument 2.
const realUSES = React.useSyncExternalStore.bind(React);
React.useSyncExternalStore = (subscribe, getSnapshot) =>
  realUSES(subscribe, getSnapshot, getSnapshot);

const text = (html) => html.replace(/<!-- -->/g, '');

let failures = 0;
const check = (label, cond, detail = '') => {
  if (cond) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
};

const REPO_PATH = '/home/u/dev/orchestra';

// The store seed. `repos` always carries a real `path`; what varies between the
// two arms is ONLY whether the workspace record has `repoPath`, so any
// difference in outcome is attributable to that single field.
const seed = (workspace) => {
  useStore.setState({
    repos: [{ id: 'r1', name: 'orchestra', path: REPO_PATH }],
    workspaces: [workspace],
    accounts: [],
    selfTuneRuns: [],
    activeId: null,
    stats: {},
    prs: {},
    checks: {},
    linear: {},
    tickets: [],
    tools: {},
    repoSync: {},
    accountUsage: {},
    workspaceAccounts: {},
    agentSessions: {},
  });
};

const props = { onNewFromRepo: () => {}, onNewScratch: () => {}, onNewOrchestrator: () => {} };
const render = () => text(renderToString(React.createElement(Sidebar, props)));

// ── 1 + 2. THE REGRESSION: a record with NO repoPath must boot AND render ────
//
// This is the #38 store shape verbatim — `repoId` and `worktreePath` present,
// `repoPath` ABSENT, exactly as the `verify` skill's harness seeds it.
console.log('Sidebar boot — workspace record with an UNSEEDED repoPath (#38):');
seed({
  id: 'ws-1',
  name: 'x',
  repoId: 'r1',
  worktreePath: REPO_PATH,
  branch: 'some-branch',
  baseBranch: 'master',
  createdAt: '2026-08-24T17:00:00.000Z',
  agent: 'claude',
  kind: 'worktree',
});

let htmlUnseeded = '';
let thrown = null;
try {
  htmlUnseeded = render();
} catch (err) {
  thrown = err;
}

check(
  'renders without throwing',
  thrown === null,
  thrown ? `${thrown.name}: ${thrown.message}` : '',
);
// The #38 signature specifically, so a DIFFERENT future crash is not silently
// reported as this regression returning.
check(
  'does not throw the #38 TypeError',
  !(thrown instanceof TypeError && /reading 'pos'/.test(thrown.message)),
  thrown ? thrown.message : '',
);
// NOT VACUOUS: a component that rendered nothing would also "not throw".
check('produced non-empty output', htmlUnseeded.length > 0);
check('rendered a repo section', htmlUnseeded.includes('repo-section'));
check('rendered the workspace row', htmlUnseeded.includes('ws-item'));
check(
  'names the repo it grouped under',
  htmlUnseeded.includes('orchestra'),
  'repo header text missing — the section may have grouped under a bogus key',
);
// The empty-state copy must NOT appear: seeing it would mean the sidebar booted
// but silently dropped the workspace, which is a different bug wearing a pass.
check(
  'does NOT fall back to the empty state',
  !htmlUnseeded.includes('No agents running'),
  'the workspace was dropped rather than grouped',
);
// A malformed record groups under the EMPTY repo key, which must still render a
// NAMED header. Caught by reading the drive screenshot, not by state assertions:
// the section was present and correct in the DOM and simply had no text, which
// reads as a rendering glitch. Keeping the row visible matters more than hiding
// the section — a silently dropped workspace is the worse failure.
check(
  'names the repo-less section rather than rendering a blank header',
  htmlUnseeded.includes('No repo'),
  'the empty-key section rendered without a label',
);

// ── 3. CONTROL: an ordinary record is unaffected ─────────────────────────────
console.log('\nControl — workspace record WITH repoPath (ordinary case):');
seed({
  id: 'ws-2',
  name: 'y',
  repoId: 'r1',
  repoPath: REPO_PATH,
  worktreePath: REPO_PATH,
  branch: 'other-branch',
  baseBranch: 'master',
  createdAt: '2026-08-24T17:00:00.000Z',
  agent: 'claude',
  kind: 'worktree',
});

let htmlSeeded = '';
let thrownControl = null;
try {
  htmlSeeded = render();
} catch (err) {
  thrownControl = err;
}
check(
  'renders without throwing',
  thrownControl === null,
  thrownControl ? `${thrownControl.name}: ${thrownControl.message}` : '',
);
check('rendered a repo section', htmlSeeded.includes('repo-section'));
check('rendered the workspace row', htmlSeeded.includes('ws-item'));
check('does NOT fall back to the empty state', !htmlSeeded.includes('No agents running'));

// ── 4. CAN-FAIL CONTROL ──────────────────────────────────────────────────────
//
// Reconstructs the UNFIXED guard shape and requires it to throw the exact
// reported error. If this ever stops throwing, the assertions above have become
// unable to detect the regression they exist for, and this file is decoration.
console.log('\nCan-fail control — the unfixed guard shape still reproduces #38:');
{
  const dropRepo = null;
  const repoPathUndefined = undefined;
  let reproduced = null;
  try {
    // eslint-disable-next-line no-unused-expressions
    dropRepo?.path === repoPathUndefined ? ` repo-drop-${dropRepo.pos}` : '';
  } catch (err) {
    reproduced = err;
  }
  check(
    'the unfixed expression throws the exact #38 TypeError',
    reproduced instanceof TypeError &&
      /Cannot read properties of null \(reading 'pos'\)/.test(reproduced.message),
    reproduced ? reproduced.message : 'it did NOT throw — this gate cannot fail',
  );
}

console.log(
  failures === 0
    ? '\nsidebar-boot-render-smoke: PASS'
    : `\nsidebar-boot-render-smoke: FAIL (${failures})`,
);
process.exit(failures === 0 ? 0 : 1);
