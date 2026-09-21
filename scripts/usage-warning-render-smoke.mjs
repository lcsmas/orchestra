// Render smoke-test for the usage-limit warning strip (UsageWarningStrip):
// the "approaching usage limit" surface moved from N spammed transcript rows
// to ONE level-triggered banner above the composer. The fold/normalize logic
// is unit-tested in agent-events.test.ts; this proves the pinned state reaches
// the HTML — and, the negative arms, that a cleared/expired state renders
// NOTHING (the strip must be able to disappear, or it is the same spam pinned).
//
// SELECTOR CONTRACT: assertions key on CLASS, data-*, or rendered TEXT — never
// tag or DOM position — so restyling cannot break them.

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
const { build } = loadEsbuild();

import { renderToString } from 'react-dom/server';
import React from 'react';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outfile = path.join(repoRoot, 'node_modules', '.cache', 'usage-warning-smoke.mjs');
const entryFile = path.join(repoRoot, 'node_modules', '.cache', 'usage-warning-smoke-entry.tsx');
fs.mkdirSync(path.dirname(entryFile), { recursive: true });
fs.writeFileSync(
  entryFile,
  `
import { UsageWarningStrip } from ${JSON.stringify(path.join(repoRoot, 'src/renderer/components/agent/UsageWarningStrip.tsx'))};
export { UsageWarningStrip };
`,
);

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

globalThis.self = globalThis;
globalThis.window = { addEventListener: () => {}, removeEventListener: () => {} };
globalThis.document = { addEventListener: () => {}, removeEventListener: () => {} };
// The strip arms a setTimeout in an effect; SSR never runs effects, so a stub
// is enough (never called during renderToString).
globalThis.setTimeout ??= () => 0;
globalThis.clearTimeout ??= () => {};

const { UsageWarningStrip } = await import(`${outfile}?t=${Date.now()}`);

const text = (html) => html.replace(/<!-- -->/g, '');
let failures = 0;
const check = (label, cond, detail = '') => {
  if (cond) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
};

const FUTURE = Math.floor(Date.now() / 1000) + 3_600; // resets in an hour
const PAST = Math.floor(Date.now() / 1000) - 60; // reset already passed

console.log('UsageWarningStrip:');
// Negative arms first — the surface must be able to render NOTHING.
check('renders NOTHING with no warning', renderToString(React.createElement(UsageWarningStrip, {})) === '');
check(
  'renders NOTHING past resetsAt (self-expiry)',
  renderToString(React.createElement(UsageWarningStrip, { warning: { utilization: 0.8, resetsAt: PAST } })) === '',
);

const full = renderToString(
  React.createElement(UsageWarningStrip, { warning: { utilization: 0.76, resetsAt: FUTURE } }),
);
check('renders the amber strip', full.includes('av-usage-strip'));
check('carries the data hook', full.includes('data-usage-warning'));
check('states the condition', text(full).includes('Approaching usage limit'));
check('shows the rounded percentage', text(full).includes('76%'));
check('shows the reset time', /resets \d/.test(text(full)));
check('is a status region for a11y', full.includes('role="status"'));

// A warning with NO percentage/reset must still render legibly (the SDK may
// omit either field) — text only, no dangling separators.
const bare = renderToString(React.createElement(UsageWarningStrip, { warning: {} }));
check('renders with neither pct nor reset', bare.includes('av-usage-strip'));
check('bare form has no stray % or reset text', !text(bare).includes('%') && !text(bare).includes('resets'));

console.log(failures === 0 ? '\nusage-warning render smoke: PASS' : `\nusage-warning render smoke: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
