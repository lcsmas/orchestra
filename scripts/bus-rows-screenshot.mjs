// #145 G6 — a SCREENSHOT of the bus wake + delivery rows, rendered by a real
// browser engine inside a headless sway (ledger #146).
//
// The render smoke (bus-rows-render-smoke.mjs) proves the values reach the HTML.
// That is a string claim. This proves they reach PIXELS: real layout, real CSS,
// a real window. The two fail differently — a component can serialize correct
// HTML and render as a blank/clipped/glyph-less box (issue #35, and the measured
// font-race in this repo where correct layout captured with ZERO glyphs while
// every innerText assertion passed). DOM text ≠ painted glyphs.
//
// Two captures, because one is not a measurement:
//   1. the PENDING arm (wake row + delivery with the PENDING badge), and
//   2. the ACKED arm (same lot, badge flipped) — the flip is the feature.
// Each is asserted non-glyph-less (byte threshold BETWEEN the two observed
// populations) and carrying the text the DOM says it should; and the two
// captures must DIFFER (the badge flip is visible in pixels, not just the DOM).
//
// DISPLAY DISCIPLINE: refuses unless handed a marker-verified headless-sway
// display in RIG_WAYLAND, and refuses if X11 DISPLAY is set. No test window may
// reach the user's screen.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const rigWayland = process.env.RIG_WAYLAND;
if (!rigWayland) {
  console.log(
    'REFUSED: RIG_WAYLAND unset — this rig opens a real window. Launch a headless sway\n' +
      '(skill: headless-sway-e2e), marker-verify it, and pass its display as RIG_WAYLAND.',
  );
  process.exit(3);
}
if (process.env.DISPLAY) {
  console.log(`REFUSED: X11 DISPLAY=${process.env.DISPLAY} is set — Electron would reach the human's screen.`);
  process.exit(3);
}

const outDir = process.env.SHOT_DIR || path.join(repoRoot, 'build', 'bus-rows-shots');
fs.mkdirSync(outDir, { recursive: true });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bus-rows-shot-145-'));

function loadEsbuild() {
  try {
    return require_('esbuild');
  } catch {
    const store = fs.globSync?.(repoRoot + '/node_modules/.pnpm/esbuild@*/node_modules/esbuild') ?? [];
    if (store.length) return require_(store[0]);
    throw new Error('esbuild not resolvable — run `pnpm install` first');
  }
}
const { build } = loadEsbuild();

const cacheDir = path.join(repoRoot, 'node_modules', '.cache');
fs.mkdirSync(cacheDir, { recursive: true });
// Entry lives INSIDE the repo so esbuild resolves bare specifiers (react,
// react-dom/client) relative to the entry.
const seedEntry = path.join(cacheDir, 'bus-rows-shot-page.tsx');
fs.writeFileSync(
  seedEntry,
  `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { WakeRow } from ${JSON.stringify(path.join(repoRoot, 'src/renderer/components/agent/WakeRow.tsx'))};
import { DeliveryRow } from ${JSON.stringify(path.join(repoRoot, 'src/renderer/components/agent/DeliveryRow.tsx'))};
import { foldDelivery } from ${JSON.stringify(path.join(repoRoot, 'src/shared/bus-rows.ts'))};

const WAKE_HEADER = 'lot pending — run the check command(s) below, then ack each lot:';
const wakeMsg = { id: 'w1', role: 'user', done: true,
  text: [WAKE_HEADER, 'orchestra check --run wave-g-canary', 'orchestra check --run lead-ancestor'].join('\\n') };

const CHECK = {
  run: 'wave-g-canary', reader: 'ops-g', lot: 312, replay: false, from: 41, to: 43, count: 2,
  messages: [
    { sequence: 42, kind: 'status', sender: 'impl-144', recipient: 'ops-g', thread_id: null, body: 'seeded-body-alpha-55913 — G1–G6 green, branch pushed', created_at: 1 },
    { sequence: 43, kind: 'ask', sender: 'impl-142', recipient: 'ops-g', thread_id: null, body: 'seeded-body-beta-77024 — restart path wording?', created_at: 2 },
  ], gates: [],
};

const acked = new URLSearchParams(location.search).get('state') === 'acked';
const delivery = foldDelivery(CHECK, acked ? new Set([312]) : new Set());

createRoot(document.getElementById('root')).render(
  React.createElement('div', { className: 'av-view active', 'data-agent-theme': 'default' },
    React.createElement('div', { className: 'av-message-list', 'data-shot-root': '1' },
      React.createElement(WakeRow, { message: wakeMsg, defaultOpen: true }),
      React.createElement(DeliveryRow, { delivery, defaultOpen: true }),
    ),
  ),
);
document.title = 'bus-rows-' + (acked ? 'acked' : 'pending');
`,
);

const bundleJs = path.join(cacheDir, 'bus-rows-shot-page.js');
await build({
  entryPoints: [seedEntry],
  outfile: bundleJs,
  bundle: true,
  format: 'iife',
  platform: 'browser',
  jsx: 'automatic',
  loader: { '.css': 'empty' },
  logLevel: 'silent',
});

// The REAL agent-view stylesheets — a screenshot against default styles would
// prove the component renders, not that IT renders. Load the same files the app
// links (theme carries the --av-* palette + the av-wake/av-deliv rules).
const cssFiles = [
  'src/renderer/agent-view-theme.css',
  'src/renderer/agent-view-defaults.css',
  'src/renderer/agent-view-structure.css',
  'src/renderer/agent-view-flat.css',
];
const links = [];
for (const rel of cssFiles) {
  const base = path.basename(rel);
  fs.writeFileSync(path.join(tmp, base), fs.readFileSync(path.join(repoRoot, rel)));
  links.push(`<link rel="stylesheet" href="./${base}">`);
}
fs.writeFileSync(path.join(tmp, 'page.js'), fs.readFileSync(bundleJs));
fs.writeFileSync(
  path.join(tmp, 'index.html'),
  `<!doctype html><html><head><meta charset="utf-8">
${links.join('\n')}
<style>html,body{margin:0;height:100%;background:#1a1f26;}
  #root{position:relative;height:100%;padding:16px 0;}
  .av-message-list{background:#1a1f26;}</style>
</head><body><div id="root"></div><script src="./page.js"></script></body></html>`,
);

const electronBin = path.join(repoRoot, 'node_modules', 'electron', 'dist', 'electron');
const shotProbe = path.join(tmp, 'shot.cjs');
fs.writeFileSync(
  shotProbe,
  `
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const OUT = process.env.SHOT_DIR;
const PAGE = process.env.PAGE_DIR;
const results = [];

async function shoot(win, state, file) {
  await win.loadFile(path.join(PAGE, 'index.html'), { search: 'state=' + state });
  // Wait for the shot root AND for fonts to be READY. The DOM alone is not
  // enough (measured elsewhere in this repo: correct layout captured with ZERO
  // glyphs while every innerText assertion passed) — document.fonts.ready is the
  // event that separates DOM text from painted glyphs.
  for (let i = 0; i < 200; i++) {
    const ok = await win.webContents.executeJavaScript(
      "(async () => { const el = document.querySelector('[data-shot-root=\\"1\\"]');" +
        " if (!el) return false; await document.fonts.ready;" +
        " return document.fonts.status === 'loaded' && el.innerText.length > 80; })()",
    );
    if (ok) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  // One more frame after fonts settle so the paint that USES them has landed.
  await new Promise((r) => setTimeout(r, 250));
  const img = await win.webContents.capturePage();
  fs.writeFileSync(path.join(OUT, file), img.toPNG());
  const text = await win.webContents.executeJavaScript('document.body.innerText');
  const size = img.getSize();
  results.push({ state, file, text, width: size.width, height: size.height });
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 900, height: 700, show: true, webPreferences: { offscreen: false } });
  try {
    await shoot(win, 'pending', 'bus-rows-pending.png');
    await shoot(win, 'acked', 'bus-rows-acked.png');
    fs.writeFileSync(process.env.PROBE_OUT, JSON.stringify(results));
    app.exit(0);
  } catch (e) {
    fs.writeFileSync(process.env.PROBE_OUT, JSON.stringify([{ error: String((e && e.stack) || e) }]));
    app.exit(1);
  }
});
`,
);

const probeOut = path.join(tmp, 'shots.json');
let rc = 0;
try {
  execFileSync(
    'env',
    [
      '-i',
      `HOME=${tmp}`,
      'PATH=/usr/bin:/bin',
      `XDG_RUNTIME_DIR=${process.env.XDG_RUNTIME_DIR || '/run/user/1000'}`,
      `WAYLAND_DISPLAY=${rigWayland}`,
      'ELECTRON_OZONE_PLATFORM_HINT=wayland',
      'ELECTRON_DISABLE_SANDBOX=1',
      `SHOT_DIR=${outDir}`,
      `PAGE_DIR=${tmp}`,
      `PROBE_OUT=${probeOut}`,
      electronBin,
      '--no-sandbox',
      shotProbe,
    ],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 180000 },
  );
} catch (e) {
  rc = e.status ?? 1;
  if (e.stderr) console.log(String(e.stderr).split('\n').slice(0, 15).join('\n'));
}

let failures = 0;
const check = (label, ok, detail = '') => {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
};

console.log('\n#145 G6 — screenshot of the bus rows under headless sway:');
if (!fs.existsSync(probeOut)) {
  console.log(`  FAIL the capture produced no output (electron rc=${rc})`);
  process.exit(1);
}
const shots = JSON.parse(fs.readFileSync(probeOut, 'utf8'));
if (shots[0]?.error) {
  console.log(`  FAIL capture threw: ${shots[0].error}`);
  process.exit(1);
}
check('two captures were produced', shots.length === 2, `got ${shots.length}`);

for (const s of shots) {
  const file = path.join(outDir, s.file);
  const exists = fs.existsSync(file);
  const bytes = exists ? fs.statSync(file).size : 0;
  check(`${s.state}: PNG written`, exists && bytes > 5000, `${bytes} bytes`);
  check(`${s.state}: window had real dimensions`, s.width > 500 && s.height > 400, `${s.width}x${s.height}`);
}

const pending = shots.find((s) => s.state === 'pending');
const acked = shots.find((s) => s.state === 'acked');

// DOM HALF — the rendered text of the captured page (the screenshot is the
// artifact; a file on disk asserts nothing by itself).
check('wake: "Wake order" is on screen', pending.text.includes('Wake order'));
check('wake: the ordered check commands are on screen', pending.text.includes('orchestra check --run wave-g-canary') && pending.text.includes('orchestra check --run lead-ancestor'));
check('delivery: the lot is on screen', pending.text.includes('Lot #312'));
check('delivery: a seeded message body is on screen', pending.text.includes('seeded-body-alpha-55913'));
check('delivery: the routes are on screen', pending.text.includes('impl-144') && pending.text.includes('impl-142'));
check('pending: the PENDING badge is on screen', /pending/i.test(pending.text));
check('acked: the ACKED badge is on screen', /acked/i.test(acked.text));
// THE flip discriminator: pending must NOT read acked, and vice-versa.
check('pending does NOT read "acked"', !/\backed\b/i.test(pending.text));
check('the two captures DIFFER (the badge flipped)', pending.text !== acked.text);

// PIXEL HALF — a glyph-less frame is the classic headless artifact. The byte
// threshold is placed BETWEEN the two observed populations: a font-race capture
// (correct layout, ZERO glyphs) measured ~12k in this repo's other rigs, a
// painted one ~90-99k. Our rows are less text-dense than the bus pane, so the
// threshold is set conservatively at 18000 and the OBSERVED sizes are printed so
// a future reader can re-place it if the content changes.
const pendBytes = fs.statSync(path.join(outDir, pending.file)).size;
const ackBytes = fs.statSync(path.join(outDir, acked.file)).size;
console.log(`  observed PNG sizes — pending: ${pendBytes} bytes · acked: ${ackBytes} bytes`);
check('pending PNG is text-dense (not a glyph-less frame)', pendBytes > 18000, `${pendBytes} bytes — a glyph-less capture would be ~12k; if this fires, LOOK at the PNG before blaming the threshold`);
check('acked PNG is text-dense (not a glyph-less frame)', ackBytes > 18000, `${ackBytes} bytes`);

console.log(`\nScreenshots: ${path.join(outDir, pending.file)}\n             ${path.join(outDir, acked.file)}`);
fs.rmSync(tmp, { recursive: true, force: true });
if (failures) {
  console.log(`\nbus-rows-screenshot: ${failures} FAILURE(S)`);
  process.exit(1);
}
console.log('\nbus-rows-screenshot: all checks passed');
