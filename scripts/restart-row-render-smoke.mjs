// Render smoke-test for the intentional-restart neutral row (issue #148).
//
// WHY THIS EXISTS — `node --test --experimental-strip-types` strips types but
// does NOT transform JSX, so the unit suite (src/shared/restart-notice.test.ts)
// proves the DETECTION/CLASSIFICATION/FOLD logic yet says nothing about whether
// a restart ever reaches the SCREEN as its neutral, expandable row (and NOT the
// red error box). Those are two claims; the feature is the second.
//
// It pins, each failing in a different direction:
//   1. RESTART collapsed — the neutral row, French headline, NO error/red class,
//      trigger detail NOT leaked while collapsed.
//   2. RESTART expanded  — the trigger detail is shown; expanded ≠ collapsed.
//   3. Each of the three producers renders its OWN detail label.
//   4. CONTROL — the row is neutral: it carries no `av-notice-error`/error role.
//
// SELECTOR CONTRACT: assertions key on CLASS, `data-*`, or rendered TEXT — never
// on tag or DOM position — so restyling cannot break them.

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
const outfile = path.join(repoRoot, 'node_modules', '.cache', 'restart-row-smoke.mjs');
const agentDir = path.join(repoRoot, 'src/renderer/components/agent');
const sharedDir = path.join(repoRoot, 'src/shared');

const entry = `
import { RestartRow } from ${JSON.stringify(path.join(agentDir, 'RestartRow.tsx'))};
import { makeRestartNotice, RESTART_NOTICE_TEXT } from ${JSON.stringify(path.join(sharedDir, 'restart-notice.ts'))};
import { foldEvent, emptySession } from ${JSON.stringify(path.join(sharedDir, 'agent-events.ts'))};
export { RestartRow, makeRestartNotice, RESTART_NOTICE_TEXT, foldEvent, emptySession };
`;
const entryFile = path.join(repoRoot, 'node_modules', '.cache', 'restart-row-entry.tsx');
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

globalThis.self = globalThis;
globalThis.window = { addEventListener: () => {}, removeEventListener: () => {} };
globalThis.document = { addEventListener: () => {}, removeEventListener: () => {} };

const { RestartRow, makeRestartNotice, RESTART_NOTICE_TEXT, foldEvent, emptySession } =
  await import(`${outfile}?t=${Date.now()}`);

const text = (html) => html.replace(/<!-- -->/g, '');

let failures = 0;
const check = (label, cond, detail = '') => {
  if (cond) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
};

// Build a folded restart RenderMessage exactly as live/backfill do: the shared
// builder → the shared fold → the RenderMessage the row keys on.
const ctx = () => ({ seq: 0, now: () => 1_700_000_000_000 });
const restartMsg = (trigger) => {
  const s = foldEvent(emptySession('ws'), makeRestartNotice(ctx(), trigger));
  return s.messages.at(-1);
};

// ── 1. RESTART collapsed ──────────────────────────────────────────────────────
console.log('Restart row — collapsed by default:');
const rCollapsed = text(renderToString(React.createElement(RestartRow, { message: restartMsg('cli') })));
check('renders a restart container', rCollapsed.includes('data-restart="1"'));
check('is CLOSED by default', rCollapsed.includes('av-closed') && !rCollapsed.includes('av-open'));
check('header reports aria-expanded="false"', rCollapsed.includes('aria-expanded="false"'));
check('shows the French restart headline', rCollapsed.includes(RESTART_NOTICE_TEXT));
check('headline is the pinned literal', RESTART_NOTICE_TEXT === 'Session redémarrée — conversation préservée');
check('does NOT leak the trigger detail while collapsed', !rCollapsed.includes('data-restart-detail="1"'));
// NEUTRAL, never the error box — the whole point of #148.
check('is NOT an error row (no error/red class)', !/av-notice-error|av-message-error|role="alert"/.test(rCollapsed), 'restart row rendered as an error');
check('does NOT contain the raw exit-code error string', !rCollapsed.includes('exited with code'));

// ── 2. RESTART expanded ───────────────────────────────────────────────────────
console.log('\nRestart row — expanded (SSR open branch):');
const rOpen = text(renderToString(React.createElement(RestartRow, { message: restartMsg('cli'), defaultOpen: true })));
check('is marked OPEN', rOpen.includes('av-open') && !rOpen.includes('av-closed'));
check('renders the trigger detail', rOpen.includes('data-restart-detail="1"'));
check('collapsed and expanded genuinely differ', rOpen !== rCollapsed && rOpen.length > rCollapsed.length, 'defaultOpen had no effect');

// ── 3. Each producer renders its OWN detail ───────────────────────────────────
console.log('\nEach of the three producers names its own trigger:');
const detailCli = text(renderToString(React.createElement(RestartRow, { message: restartMsg('cli'), defaultOpen: true })));
const detailToolbar = text(renderToString(React.createElement(RestartRow, { message: restartMsg('toolbar'), defaultOpen: true })));
const detailReparent = text(renderToString(React.createElement(RestartRow, { message: restartMsg('reparent'), defaultOpen: true })));
check('cli detail mentions `orchestra restart`', detailCli.includes('orchestra restart'));
check('toolbar detail mentions the button', /bouton/i.test(detailToolbar));
check('reparent detail mentions #142', detailReparent.includes('#142'));
check('the three details genuinely differ', new Set([detailCli, detailToolbar, detailReparent]).size === 3, 'the trigger detail does not distinguish producers');

console.log(`\n${failures === 0 ? 'PASS' : `FAIL (${failures})`}`);
process.exit(failures === 0 ? 0 : 1);
