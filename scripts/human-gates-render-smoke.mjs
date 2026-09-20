// Render smoke-test for the human-gate ask surfaces (#161): AskRow (surface A,
// inline) + AsksSection (surface B, sidebar). `node --test` strips types but does
// NOT transform JSX, so the unit suite proves the DB lifecycle and the pure
// helpers but says nothing about whether the surfaces reach the DOM. This proves
// the values reach the HTML (a string claim); the SCREENSHOT rig
// (human-gates-screenshot.mjs) proves they reach PIXELS.
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
const outfile = path.join(repoRoot, 'node_modules', '.cache', 'human-gates-smoke.mjs');
const entryFile = path.join(repoRoot, 'node_modules', '.cache', 'human-gates-smoke-entry.tsx');
fs.mkdirSync(path.dirname(entryFile), { recursive: true });
fs.writeFileSync(
  entryFile,
  `
import { AskRow } from ${JSON.stringify(path.join(repoRoot, 'src/renderer/components/agent/AskRow.tsx'))};
import { AsksSection } from ${JSON.stringify(path.join(repoRoot, 'src/renderer/components/AsksSection.tsx'))};
export { AskRow, AsksSection };
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
// AskRow/AsksSection use setInterval in an effect; SSR never runs effects, so a
// stub is enough (never called during renderToString).
globalThis.setInterval ??= () => 0;
globalThis.clearInterval ??= () => {};

const { AskRow, AsksSection } = await import(`${outfile}?t=${Date.now()}`);

const text = (html) => html.replace(/<!-- -->/g, '');
let failures = 0;
const check = (label, cond, detail = '') => {
  if (cond) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
};

const OLD = Date.now() - 22 * 60_000; // aged past the 15-min threshold
const NEW = Date.now() - 60_000;
const gate = (id, askedBy, label, question, openedAt) => ({
  id,
  runId: 'r',
  askedBy,
  askedByWorkspaceId: askedBy,
  askedByLabel: label,
  question,
  openedAt,
});
const g303 = gate(303, 'ws-canary', 'threshold-ruling-158', 'The 303-refusal arm crosses the escalation floor. Nominate it, or hold for the 454 arm first?', OLD);
const g304 = gate(304, 'ws-slimpay', 'slimpay-attach', 'Go / no-go on the V2 attach cohort (4 728 users)?', NEW);

const noop = () => {};

// ── Surface A — the inline ask row ────────────────────────────────────────────
console.log('AskRow (surface A):');
check('renders NOTHING with no gates', renderToString(React.createElement(AskRow, { gates: [], onResolve: noop })) === '');
const aHtml = renderToString(React.createElement(AskRow, { gates: [g303], onResolve: noop }));
check('renders the amber ask row', aHtml.includes('av-ask'));
check('carries the gate id as a data hook', aHtml.includes('data-ask-gate="303"'));
check('shows the "Fleet asks you" eyebrow', aHtml.includes('av-ask-eyebrow'));
check('shows the asker label + gate id', text(aHtml).includes('threshold-ruling-158') && text(aHtml).includes('#303'));
check('shows the question', aHtml.includes('303-refusal arm crosses the escalation floor'));
check('shows an aging badge', /waited\s+22m/.test(text(aHtml)));
check('an aged gate carries the -old class', aHtml.includes('av-ask-old'));
check('a fresh gate does NOT carry -old', !renderToString(React.createElement(AskRow, { gates: [g304], onResolve: noop })).includes('av-ask-old'));
check('offers a free-text reply input', aHtml.includes('av-ask-reply-input'));
check('offers an Answer button', aHtml.includes('av-ask-send') && text(aHtml).includes('Answer'));
check('mentions resolved_by=human in the placeholder (audit cue)', aHtml.includes('resolved_by=human'));

// ── Surface B — the sidebar Asks section ──────────────────────────────────────
console.log('AsksSection (surface B):');
check('renders NOTHING with no gates', renderToString(React.createElement(AsksSection, { gates: [], onOpen: noop })) === '');
const bHtml = renderToString(React.createElement(AsksSection, { gates: [g304, g303], onOpen: noop }));
check('renders the Asks section', bHtml.includes('asks-section'));
check('shows the section title', text(bHtml).includes('Asks'));
check('shows the fleet count', text(bHtml).includes('>2<') || bHtml.includes('asks-count'));
check('aggregates BOTH gates', text(bHtml).includes('threshold-ruling-158') && text(bHtml).includes('slimpay-attach'));
check('orders OLDEST first (303 before 304)', bHtml.indexOf('threshold-ruling-158') < bHtml.indexOf('slimpay-attach'));
check('each row is a deep-link card with its gate id', bHtml.includes('data-ask-gate="303"') && bHtml.includes('data-ask-gate="304"'));
check('the aged gate row carries -old', bHtml.includes('ask-card-old'));

console.log(failures === 0 ? '\nhuman-gates render smoke: PASS' : `\nhuman-gates render smoke: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
