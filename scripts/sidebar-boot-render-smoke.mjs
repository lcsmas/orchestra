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
// BLOCKER 2 (#38 review): the repo-less bucket must ship NO interactive repo
// actions. With `repoPath === ''` the "+" ran onAddToRepo -> createWorkspace
// -> createWorktree('') -> simpleGit(''), and simple-git does NOT reject an
// empty baseDir — it falls back to process.cwd() (measured: inside a git repo
// it resolved to a real worktree toplevel), so the click could create a branch
// and worktree in an unrelated repo. The gear was separately DEAD (the modal is
// gated on a truthy repoPath). Assert on the accessible NAME, which is the
// user-facing contract and survives restyling.
check(
  'the repo-less section ships NO "+" new-workspace button',
  !htmlUnseeded.includes('New workspace in No repo'),
  'the phantom section still offers workspace creation',
);
check(
  'the repo-less section ships NO scripts/gear button',
  !htmlUnseeded.includes('Configure scripts for No repo'),
  'the phantom section still offers a dead scripts button',
);
// POSITIVE CONTROL for the two assertions above — they must be able to SEE
// these labels when they legitimately exist, or they pass vacuously on any
// build where the aria-label wording merely changed.
check(
  'CONTROL: a real repo section DOES ship both buttons',
  htmlUnseeded.includes('New workspace in orchestra') &&
    htmlUnseeded.includes('Configure scripts for orchestra'),
  'the control labels are absent — the two assertions above are vacuous',
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

// ── 4. SOURCE-BOUND GUARD ASSERTIONS ─────────────────────────────────────────
//
// WHY THIS REPLACED THE ORIGINAL "can-fail control". That control reconstructed
// the unfixed expression INLINE AS LITERALS (`const dropRepo = null; const
// repoPathUndefined = undefined`) and asserted it threw. It never read
// Sidebar.tsx, so it was a CONSTANT: it emitted the identical `ok` on the fixed
// build, on the unfixed build, and on a build where Sidebar.tsx had been
// deleted. Measured consequence — reverting ONLY the render-site guard left
// this whole file green at RC=0, so the gate was structurally incapable of
// detecting a regression at the exact line the ticket is about.
//
// These assertions instead read the COMPILED bundle that the render above was
// produced from, so they fail if the guard is removed from the real source.
// `outfile` is esbuild's output for the real `Sidebar.tsx`, which is the same
// artifact `renderToString` just executed — not a re-read of the .tsx text, so
// a guard that fails to survive compilation is caught too.
//
// ── THE COVERAGE LIMIT OF THE RENDER ASSERTIONS ABOVE (read this before
// ── trusting a green run to mean "the crash cannot come back")
//
// The fix for #38 is THREE INDEPENDENT LAYERS, and any ONE of them alone
// prevents the crash:
//   1. `repoSectionKeyOf` returns `?? null`      (orchestrator-repo-grouping.ts)
//   2. `groupRootsByRepo` collapses to `?? ''`   (Sidebar.tsx)
//   3. the DnD sites route through `matchesDropTarget` (shared/dnd-drop-target.ts)
//
// So the RENDER assertions in sections 1-3 of this file — the ones that boot the
// component and check it does not throw — can only detect the regression of ALL
// THREE AT ONCE. Reverting any single layer leaves them green, because the
// remaining two still prevent the crash. That is correct behaviour for a
// defence-in-depth fix, not a defect in the rig, but it means a green render
// section is NOT evidence that any individual layer is still present.
//
// Per-layer coverage therefore lives elsewhere, and that is deliberate:
//   - layer 1 → `src/renderer/orchestrator-repo-grouping.test.ts`
//   - layer 3 → `src/shared/dnd-drop-target.test.ts` (imports the real functions)
//   - layer 3 at the call site → the bundle assertions immediately below, which
//     are what make reverting ONLY the render-site guard fail this file
//   - layer 2 → deliberately NOT gated: with layers 1 and 3 in place it is
//     redundant for crash-safety (verified as a surviving mutant) and is kept
//     only so `repoOrder` cannot contain `undefined` for future consumers.
//
// Verified by a one-at-a-time mutant matrix rather than assumed.
console.log('\nSource-bound guard assertions (bundle, not a literal reconstruction):');
const bundle = fs.readFileSync(outfile, 'utf8');

// POSITIVE CONTROL FIRST — prove the instrument can see this bundle at all
// before trusting anything it reports absent. A path typo or an empty file
// would otherwise make every "not present" assertion below pass vacuously.
check(
  'CONTROL: the bundle is readable and contains Sidebar code',
  bundle.length > 10_000 && bundle.includes('repo-section'),
  `bundle length ${bundle.length}`,
);
check(
  'CONTROL: a pattern that must NOT exist is absent',
  !bundle.includes('zzzNoSuchPatternZzz'),
);

// The four DnD sites now route through `shared/dnd-drop-target.ts`, so the
// guarded comparison exists exactly once. Assert the guard SHAPE survived into
// the bundle: an explicit null check before any `.pos` read.
// Patterns are matched against esbuild's ACTUAL emitted text (read out of the
// bundle while writing this, not guessed): it preserves the source shape here,
// emitting `if (target === null) return false;` and `if (key === void 0) return
// false;`. Both alternates cover a minifying build (`return !1`).
const guardNull = /if\s*\(\s*\w+\s*===\s*null\s*\)\s*return\s*(?:false|!1)/;
const guardUndef = /if\s*\(\s*\w+\s*===\s*(?:void 0|undefined)\s*\)\s*return\s*(?:false|!1)/;
check(
  'the compiled drop-target guard rejects a null target',
  guardNull.test(bundle),
  'no explicit null-check survived compilation in the drop-target helper',
);
// And that it rejects an undefined key — the other half of the #38 pair.
check(
  'the compiled drop-target guard rejects an undefined key',
  guardUndef.test(bundle),
  'no explicit undefined-key check survived compilation in the helper',
);
// THE BINDING ASSERTION for BLOCKER 1: the render site must NOT contain the
// optional-chain shorthand. This is what actually fails when the guard at the
// crash site is reverted — the previous literal-reconstruction control did not.
check(
  'no optional-chain equality shorthand remains at a DnD site',
  !/dropRepo\?\.path\s*===/.test(bundle) && !/dropWs\?\.id\s*===/.test(bundle),
  'a DnD site still compares via `?.` — that shape is the #38 crash',
);

// The regression this file exists for, asserted against the REAL module rather
// than a literal: import the shared helper the Sidebar actually calls and drive
// it with the crashing inputs. If a future edit reintroduces the optional-chain
// shorthand at any call site, `dropTargetClass`/`nextDropTarget` stop being the
// single decision point and `src/shared/dnd-drop-target.test.ts` fails.
const dnd = await import(
  `${path.join(repoRoot, 'src/shared/dnd-drop-target.ts')}?t=${Date.now()}`
).catch(() => null);
if (dnd) {
  check(
    'the shared guard returns empty string for null target + undefined key',
    dnd.dropTargetClass(null, undefined, 'repo-drop') === '',
  );
  check(
    'the shared updater does not throw for null prev + undefined key',
    (() => {
      try {
        dnd.nextDropTarget(null, undefined, 'before');
        return true;
      } catch {
        return false;
      }
    })(),
  );
} else {
  // Node cannot import .ts without --experimental-strip-types; the dedicated
  // unit suite covers this. Say so rather than silently skipping.
  console.log('  note  shared-module direct import unavailable here — covered by dnd-drop-target.test.ts');
}

console.log(
  failures === 0
    ? '\nsidebar-boot-render-smoke: PASS'
    : `\nsidebar-boot-render-smoke: FAIL (${failures})`,
);
process.exit(failures === 0 ? 0 : 1);
