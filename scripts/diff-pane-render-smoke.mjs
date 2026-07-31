/**
 * Render-smoke harness for DiffPane.
 *
 * `node --test --experimental-strip-types` strips types but does NOT transform
 * JSX, so the component cannot be rendered from a normal .test.ts. This bundles
 * DiffPane with esbuild and renders it, which proves the component MOUNTS and
 * paints its chrome — strictly more than a bundle grep, which only proves the
 * code shipped.
 *
 * WHAT IT DOES NOT COVER: renderToString does not run effects, so the diff
 * fetch never fires and no diff ROWS are asserted here. See the scope note
 * above the assertions. Verified to be able to fail via a mutation control
 * (break the root className → "pane root rendered" throws).
 *
 * Run: node scripts/diff-pane-render-smoke.mjs
 */
import { mkdtempSync, writeFileSync, rmSync, globSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';

const repoRoot = path.resolve(import.meta.dirname, '..');

// esbuild is a transitive dep of vite here (pnpm, so it is NOT hoisted to
// node_modules/esbuild and a bare `import 'esbuild'` fails). Resolve it out of
// the pnpm store instead of adding a dependency just for this harness.
const esbuildDir =
  globSync('node_modules/.pnpm/esbuild@*/node_modules/esbuild', { cwd: repoRoot })[0] ??
  'node_modules/esbuild';
const { build } = await import(
  new URL(path.join(repoRoot, esbuildDir, 'lib/main.js'), 'file://').href
);

/** Build a real git diff to render, so the harness exercises real git output. */
function realDiff() {
  const dir = mkdtempSync(path.join(tmpdir(), 'diffpane-smoke-'));
  const git = (args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
  git(['init', '-q', '.']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'Test']);
  const base = Array.from({ length: 24 }, (_, i) => `line ${i + 1}`).join('\n') + '\n';
  writeFileSync(path.join(dir, 'app.txt'), base);
  git(['add', '-A']);
  git(['commit', '-qm', 'base']);
  // Two separated edits → two hunks, plus a brand-new untracked file.
  const edited = base
    .replace('line 4\n', 'line 4\nINSERTED-NEAR-TOP\n')
    .replace('line 20\n', 'CHANGED-LINE-20\n');
  writeFileSync(path.join(dir, 'app.txt'), edited);
  writeFileSync(path.join(dir, 'brand-new.txt'), 'fresh1\nfresh2\n');
  const tracked = git(['diff', '-M', '--no-color', 'HEAD']);
  let untracked = '';
  try {
    untracked = execFileSync(
      'git',
      ['diff', '--no-color', '--no-index', '/dev/null', 'brand-new.txt'],
      { cwd: dir, encoding: 'utf8' },
    );
  } catch (e) {
    untracked = e.stdout ?? '';
  }
  rmSync(dir, { recursive: true, force: true });
  return `${tracked.replace(/\n$/, '')}\n${untracked}`;
}

const DIFF = realDiff();
assert.ok(DIFF.includes('INSERTED-NEAR-TOP'), 'fixture diff has the top edit');
assert.ok(DIFF.includes('brand-new.txt'), 'fixture diff has the untracked file');

// Both the entry and the bundle MUST live inside the repo: `packages:
// 'external'` leaves `react`/`react-dom` as bare specifiers, and Node resolves
// those relative to the importing FILE — from /tmp there is no node_modules to
// find, so the import fails. Same trap the renderer-component render-test
// pattern documents.
const outdir = mkdtempSync(path.join(repoRoot, '.diffpane-smoke-'));
const entry = path.join(outdir, 'entry.tsx');

// The component talks to window.orchestra; stub exactly the three methods it
// uses, with the real diff as the payload.
writeFileSync(
  entry,
  `
import React from 'react';
import { renderToString } from 'react-dom/server';
import { DiffPane } from ${JSON.stringify(path.join(repoRoot, 'src/renderer/components/DiffPane.tsx'))};

const DIFF = ${JSON.stringify(DIFF)};
globalThis.window = globalThis.window ?? globalThis;
globalThis.window.orchestra = {
  getReviewDiff: async () => DIFF,
  applyReviewPatch: async () => ({ status: 'applied' }),
  sendReviewToAgent: async () => ({ status: 'requested' }),
};

export function renderEmpty() {
  return renderToString(React.createElement(DiffPane, { workspaceId: 'w1', isActive: true }));
}

export { DIFF };
`,
);

// Cleanup must survive an assertion throw: the outdir lives INSIDE the repo
// (see above), so leaking it on failure leaves an untracked dir in `git status`
// that a later `git add -A` could sweep into a commit.
process.on('exit', () => rmSync(outdir, { recursive: true, force: true }));

const bundle = path.join(outdir, 'bundle.mjs');
await build({
  entryPoints: [entry],
  bundle: true,
  outfile: bundle,
  format: 'esm',
  platform: 'node',
  jsx: 'automatic',
  packages: 'external',
  logLevel: 'error',
});

const mod = await import(bundle);
const emptyHtml = mod.renderEmpty();

// ── Assertions ─────────────────────────────────────────────────────────────
// SCOPE OF THIS HARNESS, stated plainly so nobody reads more into a pass than
// it supports: `renderToString` does not run effects, so the pane's diff fetch
// never fires here and what is asserted below is the pane's CHROME in its
// pre-load state — that DiffPane mounts, paints its header, and applies its
// initial disabled/empty guards without throwing. It does NOT prove that diff
// rows, hunk checkboxes, or annotations render; that needs a real browser and
// is covered by the CDP drive against the built app (see the commit body), not
// by this file. jsdom is not a dependency here, and adding one just to make
// this harness claim more than it should would be the wrong trade.
//
// 1. The pane mounts and paints its chrome without a diff loaded.
assert.ok(emptyHtml.includes('diff-pane'), 'pane root rendered');
assert.ok(emptyHtml.includes('Uncommitted'), 'uncommitted scope tab rendered');
assert.ok(emptyHtml.includes('vs base'), 'vs-base scope tab rendered');
assert.ok(emptyHtml.includes('Send to agent'), 'send-to-agent button rendered');
assert.ok(emptyHtml.includes('diff-empty'), 'empty state rendered before load');

// 2. The Send button is disabled with no annotations — the guard that stops an
//    empty review reaching the agent.
const sendIdx = emptyHtml.indexOf('Send to agent');
const sendTag = emptyHtml.lastIndexOf('<button', sendIdx);
assert.ok(
  emptyHtml.slice(sendTag, sendIdx).includes('disabled'),
  'Send to agent is disabled with zero comments',
);

// 3. Stage/Unstage are present in the uncommitted scope and disabled with an
//    empty selection.
assert.ok(emptyHtml.includes('Stage'), 'Stage button rendered in uncommitted scope');

console.log('DiffPane render smoke: OK');
console.log(`  rendered ${emptyHtml.length} bytes of HTML`);
