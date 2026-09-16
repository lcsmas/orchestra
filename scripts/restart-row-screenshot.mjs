// #148 — a SCREENSHOT of the neutral restart row, rendered by a real browser
// engine inside a headless sway. Authoritative render arm for #148.
//
// The render smoke (restart-row-render-smoke.mjs) proves the values reach the
// HTML. That is a string claim. This proves they reach PIXELS: real layout, real
// CSS, a real window. The two fail differently — a component can serialize
// correct HTML and render as a blank/clipped/GLYPH-LESS box (measured in this
// repo: correct layout captured with ZERO glyphs while every innerText assertion
// passed). DOM text ≠ painted glyphs.
//
// Three captures, because a single frame is not a measurement:
//   1. RESTART collapsed — the neutral row.
//   2. RESTART expanded  — the trigger detail visible (expand = real region
//      change; the two RESTART frames must DIFFER in pixels).
//   3. CRASH control      — the SAME look-alike teardown WITHOUT the marker
//      renders the red ERROR box (a normal `error`-role message). The restart
//      frame and the crash frame MUST differ in pixels (the whole #148 point:
//      the neutral row is visibly NOT the red error box), and the crash frame
//      must carry a RED-dominant region the restart frame does not.
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

const outDir = process.env.SHOT_DIR || path.join(repoRoot, 'build', 'restart-row-shots');
fs.mkdirSync(outDir, { recursive: true });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'restart-row-shot-148-'));

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
const seedEntry = path.join(cacheDir, 'restart-row-shot-page.tsx');
fs.writeFileSync(
  seedEntry,
  `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { RestartRow } from ${JSON.stringify(path.join(repoRoot, 'src/renderer/components/agent/RestartRow.tsx'))};
import { NoticeRow } from ${JSON.stringify(path.join(repoRoot, 'src/renderer/components/agent/NoticeRow.tsx'))};
import { AgentMessage } from ${JSON.stringify(path.join(repoRoot, 'src/renderer/components/agent/AgentMessage.tsx'))};
import { makeRestartNotice } from ${JSON.stringify(path.join(repoRoot, 'src/shared/restart-notice.ts'))};
import { foldEvent, emptySession } from ${JSON.stringify(path.join(repoRoot, 'src/shared/agent-events.ts'))};

// Build the restart RenderMessage exactly as live/backfill do.
const ctx = { seq: 0, now: () => 1700000000000 };
const restartMsg = foldEvent(emptySession('ws'), makeRestartNotice(ctx, 'cli')).messages.at(-1);

// The CRASH control: a real error-role message — the box #148 must NOT render
// for an intentional restart, and the look-alike this arm proves is visibly
// distinct.
const errorMsg = { id: 'e1', role: 'error', done: true, text: 'Claude Code process exited with code -1' };

const state = new URLSearchParams(location.search).get('state');
const body =
  state === 'crash'
    ? React.createElement(AgentMessage, { message: errorMsg })
    : React.createElement(RestartRow, { message: restartMsg, defaultOpen: state === 'expanded' });

createRoot(document.getElementById('root')).render(
  React.createElement('div', { className: 'av-view active', 'data-agent-theme': 'default' },
    React.createElement('div', { className: 'av-message-list', 'data-shot-root': '1' }, body),
  ),
);
document.title = 'restart-row-' + state;
`,
);

const bundleJs = path.join(cacheDir, 'restart-row-shot-page.js');
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
// prove the component renders, not that IT renders.
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
  for (let i = 0; i < 200; i++) {
    const ok = await win.webContents.executeJavaScript(
      "(async () => { const el = document.querySelector('[data-shot-root=\\"1\\"]');" +
        " if (!el) return false; await document.fonts.ready;" +
        " return document.fonts.status === 'loaded' && el.innerText.length > 10; })()",
    );
    if (ok) break;
    await new Promise((r) => setTimeout(r, 50));
  }
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
    await shoot(win, 'collapsed', 'restart-collapsed.png');
    await shoot(win, 'expanded', 'restart-expanded.png');
    await shoot(win, 'crash', 'restart-crash-control.png');
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

console.log('\n#148 — screenshot of the neutral restart row under headless sway:');
if (!fs.existsSync(probeOut)) {
  console.log(`  FAIL the capture produced no output (electron rc=${rc})`);
  process.exit(1);
}
const shots = JSON.parse(fs.readFileSync(probeOut, 'utf8'));
if (shots[0]?.error) {
  console.log(`  FAIL capture threw: ${shots[0].error}`);
  process.exit(1);
}
check('three captures were produced', shots.length === 3, `got ${shots.length}`);

for (const s of shots) {
  const file = path.join(outDir, s.file);
  const exists = fs.existsSync(file);
  const bytes = exists ? fs.statSync(file).size : 0;
  check(`${s.state}: PNG written`, exists && bytes > 3000, `${bytes} bytes`);
  check(`${s.state}: window had real dimensions`, s.width > 500 && s.height > 400, `${s.width}x${s.height}`);
}

const collapsed = shots.find((s) => s.state === 'collapsed');
const expanded = shots.find((s) => s.state === 'expanded');
const crash = shots.find((s) => s.state === 'crash');

// DOM HALF — the rendered text of the captured page.
check('the French restart headline is on screen', collapsed.text.includes('Session redémarrée'));
check('collapsed does NOT show the trigger detail', !collapsed.text.includes('orchestra restart'));
check('expanded shows the trigger detail (orchestra restart)', expanded.text.includes('orchestra restart'));
check('the restart row does NOT show the raw exit-code error', !collapsed.text.includes('exited with code'));
check('the CRASH control DOES show the exit-code error', crash.text.includes('exited with code'));

// PIXEL HALF — decode the actual pixels. A glyph-less/blank frame is the classic
// headless artifact, and DOM text ≠ painted glyphs.
function decodePng(buf) {
  const zlib = require_('node:zlib');
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  let i = 8, w = 0, h = 0, bitd = 8, colt = 6;
  const idat = [];
  while (i < buf.length) {
    const len = buf.readUInt32BE(i);
    const type = buf.toString('ascii', i + 4, i + 8);
    const chunk = buf.subarray(i + 8, i + 8 + len);
    if (type === 'IHDR') { w = chunk.readUInt32BE(0); h = chunk.readUInt32BE(4); bitd = chunk[8]; colt = chunk[9]; }
    else if (type === 'IDAT') idat.push(chunk);
    else if (type === 'IEND') break;
    i += 12 + len;
  }
  if (bitd !== 8 || (colt !== 6 && colt !== 2)) throw new Error(`unsupported PNG bitd=${bitd} colt=${colt}`);
  const ch = colt === 6 ? 4 : 3;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * ch;
  const out = Buffer.alloc(h * stride);
  const paeth = (a, b, c) => { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); return pa <= pb && pa <= pc ? a : pb <= pc ? b : c; };
  let p = 0;
  for (let y = 0; y < h; y++) {
    const f = raw[p++];
    const line = raw.subarray(p, p + stride); p += stride;
    const o = y * stride, po = o - stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? out[o + x - ch] : 0;
      const b = y > 0 ? out[po + x] : 0;
      const c = x >= ch && y > 0 ? out[po + x - ch] : 0;
      let v = line[x];
      if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1; else if (f === 4) v += paeth(a, b, c);
      out[o + x] = v & 255;
    }
  }
  return { w, h, ch, px: out };
}

const colPng = decodePng(fs.readFileSync(path.join(outDir, collapsed.file)));
const expPng = decodePng(fs.readFileSync(path.join(outDir, expanded.file)));
const crashPng = decodePng(fs.readFileSync(path.join(outDir, crash.file)));

function distinctColours(png, cap = 5000) {
  const seen = new Set();
  for (let k = 0; k < png.px.length; k += png.ch) {
    seen.add((png.px[k] << 16) | (png.px[k + 1] << 8) | png.px[k + 2]);
    if (seen.size >= cap) break;
  }
  return seen.size;
}
const colColours = distinctColours(colPng);
check('collapsed frame is not blank (many distinct colours)', colColours > 30, `${colColours} colours — a solid/glyph-less frame has ~1`);

function diffPixels(a, b) {
  if (a.w !== b.w || a.h !== b.h || a.ch !== b.ch) return -1;
  let d = 0;
  for (let k = 0; k < a.px.length; k += a.ch) {
    if (a.px[k] !== b.px[k] || a.px[k + 1] !== b.px[k + 1] || a.px[k + 2] !== b.px[k + 2]) d++;
  }
  return d;
}
// (a) EXPAND is a real region change — collapsed vs expanded differ in pixels.
const expandDiff = diffPixels(colPng, expPng);
console.log(`  collapsed↔expanded differing pixels: ${expandDiff}`);
check('collapsed and expanded DIFFER in pixels (the detail expands)', expandDiff > 200, `only ${expandDiff} px differ`);
// (b) the neutral row is VISIBLY NOT the red error box.
const crashDiff = diffPixels(colPng, crashPng);
console.log(`  restart↔crash differing pixels: ${crashDiff}`);
check('restart row and crash error box DIFFER in pixels', crashDiff > 200 || crashDiff === -1, `only ${crashDiff} px differ`);

// (c) RED-DOMINANCE: the crash box carries a red-dominant region (the error
// accent) that the neutral restart row does not. A red pixel: R clearly > G and
// > B by a margin. The restart row is muted grey → few/no such pixels.
function redPixels(png) {
  let n = 0;
  for (let k = 0; k < png.px.length; k += png.ch) {
    const r = png.px[k], g = png.px[k + 1], b = png.px[k + 2];
    if (r > 120 && r - g > 50 && r - b > 50) n++;
  }
  return n;
}
const colRed = redPixels(colPng);
const crashRed = redPixels(crashPng);
console.log(`  red-dominant pixels — restart: ${colRed} · crash: ${crashRed}`);
check('the crash error box has a red-dominant region', crashRed > 100, `only ${crashRed} red px on the crash box`);
check('the neutral restart row is NOT red-dominant', colRed < crashRed / 2, `restart ${colRed} vs crash ${crashRed}`);

// Non-glyph-less byte floor.
const colBytes = fs.statSync(path.join(outDir, collapsed.file)).size;
console.log(`  observed PNG sizes — collapsed: ${colBytes} bytes`);
check('collapsed PNG is text-dense (not a glyph-less frame)', colBytes > 6000, `${colBytes} bytes — a glyph-less capture would be tiny; LOOK at the PNG before blaming the threshold`);

console.log(`\nScreenshots in ${outDir}`);
fs.rmSync(tmp, { recursive: true, force: true });
if (failures) {
  console.log(`\nrestart-row-screenshot: ${failures} FAILURE(S)`);
  process.exit(1);
}
console.log('\nrestart-row-screenshot: all checks passed');
