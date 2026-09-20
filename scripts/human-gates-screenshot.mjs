// #161 — a SCREENSHOT of the human-gate ask surfaces (A: inline ask row,
// B: sidebar "Asks" section), rendered by a real browser engine inside a
// headless sway. The pixel half of the acceptance: a gate opened to the human
// RENDERS in the app (pixel-asserted, not DOM-only — DOM text ≠ painted glyphs,
// measured font-race in this repo), and resolving it RETRACTS the row from BOTH
// surfaces (the cross-surface flip, visible in pixels).
//
// The DB lifecycle (resolved_by=human, re-wake, durable, backfill==live) is
// proven deterministically in src/main/human-gates.test.ts; this proves the two
// surfaces reach the SCREEN and that both read one gate set (open→resolved is a
// visible retract in each). Two captures per surface:
//   • OPEN   — the gate present (AskRow row + AsksSection card visible), and
//   • RESOLVED — the SAME set with the gate answered/removed (both empty).
// Each open frame is asserted non-glyph-less (distinct colours + text-dense PNG)
// and carrying its text; open vs resolved must DIFFER in pixels (the retract is
// visible, not just a DOM change).
//
// DISPLAY DISCIPLINE: refuses unless handed a marker-verified headless-sway
// display in RIG_WAYLAND, and refuses if X11 DISPLAY is set. No test window may
// reach the user's screen (headless-sway-e2e skill).

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

const outDir = process.env.SHOT_DIR || path.join(repoRoot, 'build', 'human-gates-shots');
fs.mkdirSync(outDir, { recursive: true });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'human-gates-shot-161-'));

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
const seedEntry = path.join(cacheDir, 'human-gates-shot-page.tsx');
// Fixed opened_at so "waited" is deterministic (~22m ago at render time).
fs.writeFileSync(
  seedEntry,
  `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { AskRow } from ${JSON.stringify(path.join(repoRoot, 'src/renderer/components/agent/AskRow.tsx'))};
import { AsksSection } from ${JSON.stringify(path.join(repoRoot, 'src/renderer/components/AsksSection.tsx'))};

const OPENED_AT = Date.now() - 22 * 60_000; // aged 22m → the "old" tint
const GATES = [
  { id: 303, runId: 'run-a', askedBy: 'ws-canary', askedByWorkspaceId: 'ws-canary',
    askedByLabel: 'threshold-ruling-158', question: 'The 303-refusal arm crosses the escalation floor. Nominate it, or hold for the 454 arm first?', openedAt: OPENED_AT },
  { id: 304, runId: 'run-b', askedBy: 'ws-slimpay', askedByWorkspaceId: 'ws-slimpay',
    askedByLabel: 'slimpay-attach', question: 'Go / no-go on the V2 attach cohort (4 728 users)?', openedAt: Date.now() - 60_000 },
];
const resolved = new URLSearchParams(location.search).get('state') === 'resolved';
// RESOLVED state = the gate answered → it leaves the open set (surfaces retract),
// exactly as store.humanGates drops it after a resolve. Surface A here shows the
// asking workspace's own gate (id 303); the empty state renders nothing.
const gatesNow = resolved ? [] : GATES;
const surfaceAGates = gatesNow.filter((g) => g.askedBy === 'ws-canary');

createRoot(document.getElementById('root')).render(
  React.createElement('div', { 'data-shot-root': '1' },
    // Surface B — the sidebar "Asks" section (fleet-wide aggregate).
    React.createElement('div', { className: 'asks-harness-col' },
      React.createElement(AsksSection, { gates: gatesNow, onOpen: () => {} }),
    ),
    // Surface A — the inline ask row, inside a real .av-view composer frame.
    React.createElement('div', { className: 'av-view active' },
      React.createElement('div', { className: 'av-composer', style: { padding: 12 } },
        React.createElement(AskRow, { gates: surfaceAGates, onResolve: () => {} }),
      ),
    ),
  ),
);
document.title = 'human-gates-' + (resolved ? 'resolved' : 'open');
`,
);

const bundleJs = path.join(cacheDir, 'human-gates-shot-page.js');
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

// The REAL stylesheets: styles.css carries the global tokens + the sidebar
// .ask-card* rules (surface B); the agent-view sheets carry --av-* + the av-ask*
// rules (surface A). A screenshot against default styles would prove the DOM, not
// the design.
const cssFiles = [
  'src/renderer/styles.css',
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
<style>html,body{margin:0;background:#0a0b0d;}
  #root{display:flex;gap:20px;align-items:flex-start;padding:16px;background:#0a0b0d;}
  /* Surface B (the Asks section) on the left at the sidebar's real width; surface
     A (av-view) on the right. The harness col supplies the sidebar background so
     the .repo-section/.ask-card rules render in context, WITHOUT pulling in the
     app's global .sidebar grid-positioning rules (which are for the real App grid,
     not this standalone harness). */
  #root > .asks-harness-col{flex:none;width:260px;background:var(--bg-2);border:1px solid var(--border);border-radius:10px;padding-top:8px;min-height:220px;}
  /* The app's global .av-view is position:absolute;inset:0 (it fills its pane in
     the real App). In this standalone two-column harness that would overlay the
     whole page, so pin it back into flow. */
  #root > .av-view{flex:none;position:relative!important;inset:auto!important;width:580px;background:var(--av-surface);border-radius:10px;}</style>
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

async function shoot(win, state, file, needText) {
  await win.loadFile(path.join(PAGE, 'index.html'), { search: 'state=' + state });
  for (let i = 0; i < 200; i++) {
    const ok = await win.webContents.executeJavaScript(
      "(async () => { const el = document.querySelector('[data-shot-root=\\"1\\"]');" +
        " if (!el) return false; await document.fonts.ready;" +
        " return document.fonts.status === 'loaded' && el.innerText.length >= " + needText + "; })()",
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
  const win = new BrowserWindow({ width: 900, height: 640, show: true, webPreferences: { offscreen: false } });
  try {
    // OPEN needs real text (both surfaces populated); RESOLVED is intentionally
    // near-empty (both retracted), so it must NOT gate on text length.
    await shoot(win, 'open', 'human-gates-open.png', 80);
    await shoot(win, 'resolved', 'human-gates-resolved.png', 0);
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

console.log('\n#161 — screenshot of the human-gate ask surfaces under headless sway:');
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

const open = shots.find((s) => s.state === 'open');
const resolved = shots.find((s) => s.state === 'resolved');

// DOM half — both surfaces present their text in the OPEN capture.
// The eyebrow is CSS text-transform:uppercase, and Chromium innerText reflects
// the rendered case — so match case-insensitively ("FLEET ASKS YOU").
check('surface A: "Fleet asks you" is on screen', /fleet asks you/i.test(open.text));
check('surface A: the question is on screen', open.text.includes('303-refusal arm crosses the escalation floor'));
check('surface A: the asker + gate id are on screen', open.text.includes('threshold-ruling-158') && open.text.includes('#303'));
check('surface A: the aging badge is on screen', /waited\s+\d+m/.test(open.text));
check('surface B: the "Asks" section is on screen', /asks/i.test(open.text));
check('surface B: aggregates BOTH fleet gates', open.text.includes('threshold-ruling-158') && open.text.includes('slimpay-attach'));
// The cross-surface retract, DOM half: RESOLVED drops the gate text from both.
check('resolved: surface A retracted (no "Fleet asks you")', !/fleet asks you/i.test(resolved.text));
check('resolved: surface B retracted (no gate question)', !resolved.text.includes('303-refusal arm crosses'));
check('open and resolved DIFFER in DOM text (the retract)', open.text !== resolved.text);

// PIXEL half — decode the pixels. A glyph-less/blank frame is the classic
// headless artifact and DOM text ≠ painted glyphs.
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
function distinctColours(png, cap = 5000) {
  const seen = new Set();
  for (let k = 0; k < png.px.length; k += png.ch) {
    seen.add((png.px[k] << 16) | (png.px[k + 1] << 8) | png.px[k + 2]);
    if (seen.size >= cap) break;
  }
  return seen.size;
}
const openPng = decodePng(fs.readFileSync(path.join(outDir, open.file)));
const resPng = decodePng(fs.readFileSync(path.join(outDir, resolved.file)));
const openColours = distinctColours(openPng);
check('open frame is not blank (many distinct colours)', openColours > 50, `${openColours} colours — a glyph-less frame has ~1`);

let diffPx = 0;
const sameDims = openPng.w === resPng.w && openPng.h === resPng.h && openPng.ch === resPng.ch;
if (sameDims) {
  for (let k = 0; k < openPng.px.length; k += openPng.ch) {
    if (openPng.px[k] !== resPng.px[k] || openPng.px[k + 1] !== resPng.px[k + 1] || openPng.px[k + 2] !== resPng.px[k + 2]) diffPx++;
  }
}
const openBytes = fs.statSync(path.join(outDir, open.file)).size;
console.log(`  decoded ${openPng.w}x${openPng.h} · open colours ${openColours} · differing pixels ${diffPx} · open PNG ${openBytes} bytes`);
check('the two frames have identical dimensions (comparable)', sameDims, `${openPng.w}x${openPng.h} vs ${resPng.w}x${resPng.h}`);
// Both surfaces' rows fill a large area; resolving retracts all of it, so the
// pixel diff is large. 2000 is well above AA noise and well below the real delta.
check('open vs resolved DIFFER in PIXELS (the ask surfaces visibly retract)', diffPx > 2000, `only ${diffPx} pixels differ — the retract is not visible in pixels (DOM≠pixels)`);
check('open PNG is text-dense (not a glyph-less frame)', openBytes > 18000, `${openBytes} bytes — a glyph-less capture would be ~12k; LOOK at the PNG before blaming the threshold`);

console.log(`\nScreenshots: ${path.join(outDir, open.file)}\n             ${path.join(outDir, resolved.file)}`);
fs.rmSync(tmp, { recursive: true, force: true });
if (failures) {
  console.log(`\nhuman-gates-screenshot: ${failures} FAILURE(S)`);
  process.exit(1);
}
console.log('\nhuman-gates-screenshot: all checks passed');
