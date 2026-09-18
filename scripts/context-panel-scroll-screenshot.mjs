// #33 (task A) — PROVE the context-breakdown panel actually SCROLLS at its 60vh
// cap, in a real browser engine inside a headless sway.
//
// PR #30 shipped the vertical contract (`max-height:60vh; overflow-y:auto` on
// `.av-ctx-panel`) but the overflow behaviour was NEVER observed — the gated
// panel measured 180px, far under any cap. This rig drives the REAL
// ContextBreakdownPanel with a large captured-shape payload (7 categories +
// 3 memory files + 5 MCP servers + 50 skills) and asserts, on the live laid-out
// DOM, that:
//   • the panel is clamped to its 60vh cap (clientHeight ≈ 0.6·innerHeight),
//   • its content OVERFLOWS that cap (scrollHeight > clientHeight),
//   • it actually scrolls (scrollTop moves off 0 when driven to the bottom),
//   • the top and bottom frames DIFFER in pixels (the scroll is visible, not a
//     no-op), proven by DECODING the PNGs — DOM text is not paint.
//
// A single frame is not a measurement, so we capture the panel scrolled to the
// TOP and to the BOTTOM and diff the two decoded bitmaps between the two
// OBSERVED populations. `document.fonts.ready` + a settle frame guard against the
// glyph-less-capture artifact this repo has hit before.
//
// DISPLAY DISCIPLINE: refuses unless handed a marker-verified headless-sway
// display in RIG_WAYLAND, and refuses if X11 DISPLAY is set. No test window may
// reach the user's screen.
//
// Run (inside headless-sway-e2e): RIG_WAYLAND=wayland-N node scripts/context-panel-scroll-screenshot.mjs

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

const outDir = process.env.SHOT_DIR || path.join(repoRoot, 'build', 'ctx-panel-scroll-shots');
fs.mkdirSync(outDir, { recursive: true });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-scroll-shot-33-'));

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
const seedEntry = path.join(cacheDir, 'ctx-scroll-shot-page.tsx');

// The LARGE payload: 7 used categories + 3 memory files + 5 MCP servers (each
// several tools) + 50 skills. This is the shape #33 names, built to the real
// ContextUsage type so buildContextBreakdown() runs the true pipeline.
const buildPayload = `
function makePayload() {
  const cats = [
    { name: 'Messages', tokens: 42000, kind: 'used' },
    { name: 'Memory files', tokens: 38000, kind: 'used' },
    { name: 'System tools', tokens: 21000, kind: 'used' },
    { name: 'MCP tools', tokens: 16000, kind: 'used' },
    { name: 'Skills', tokens: 12000, kind: 'used' },
    { name: 'System prompt', tokens: 6000, kind: 'used' },
    { name: 'Custom agents', tokens: 3000, kind: 'used' },
    { name: 'Deferred MCP schemas', tokens: 51000, kind: 'deferred' },
    { name: 'Free space', tokens: 62000, kind: 'free' },
  ];
  const memoryFiles = [
    { path: '/home/u/proj/CLAUDE.md', type: 'Project', tokens: 18000 },
    { path: '/home/u/.claude/CLAUDE.md', type: 'User', tokens: 12000 },
    { path: '/home/u/proj/docs/CLAUDE.md', type: 'Project', tokens: 8000 },
  ];
  const servers = ['github', 'linear', 'slack', 'datadog', 'browser'];
  const mcpTools = [];
  servers.forEach((s, si) => {
    for (let t = 0; t < 4 + si; t++) mcpTools.push({ name: 'mcp__' + s + '__tool_' + t, serverName: s, tokens: 200 + t * 10 });
  });
  const skills = [];
  for (let i = 0; i < 50; i++) {
    const plugin = i % 3 === 0;
    skills.push({
      name: (plugin ? 'plugin' + i + ':' : '') + 'skill-' + i,
      source: plugin ? 'plugin' : 'userSettings',
      pluginName: plugin ? 'plugin' + i : undefined,
      tokens: 40 + i,
    });
  }
  const agents = [
    { agentType: 'Explore', source: 'builtin', tokens: 300 },
    { agentType: 'Plan', source: 'builtin', tokens: 280 },
    { agentType: 'general-purpose', source: 'builtin', tokens: 260 },
  ];
  return {
    totalTokens: 138000, maxTokens: 200000, percentage: 69, source: 'live', at: 1,
    model: 'claude-opus-4-8', categories: cats, memoryFiles, mcpTools, skills, agents,
  };
}
`;

fs.writeFileSync(
  seedEntry,
  `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { ContextBreakdownPanel } from ${JSON.stringify(path.join(repoRoot, 'src/renderer/components/agent/ContextBreakdownPanel.tsx'))};
${buildPayload}
const usage = makePayload();
// Render the panel inside an anchor at the bottom of the viewport, exactly as
// TurnFooter mounts it (position:absolute off .av-ctx-anchor, opening upward).
createRoot(document.getElementById('root')).render(
  React.createElement('div', { className: 'av-view active', 'data-agent-theme': 'default' },
    React.createElement('div', { className: 'av-ctx-anchor', 'data-shot-anchor': '1',
      style: { position: 'absolute', left: '40px', bottom: '40px' } },
      React.createElement(ContextBreakdownPanel, { usage, onDismiss: () => {} }),
    ),
  ),
);
document.title = 'ctx-panel-scroll';
`,
);

const bundleJs = path.join(cacheDir, 'ctx-scroll-shot-page.js');
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

// The REAL agent-view stylesheets — a capture against default styles would prove
// the component renders, not that the SHIPPED panel scrolls.
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
  #root{position:relative;height:100%;}</style>
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
// A deliberately SHORT window: 60vh scales with the viewport, so a short window
// makes the cap small enough that even a capped panel overflows — this is the
// real small-screen case PR #30 could not reach, and the honest way to exercise
// the cap rather than a giant window where nothing clamps.
const WIN_H = 520;
const result = { measure: null, shots: [] };

async function measure(win) {
  return win.webContents.executeJavaScript(
    "(async () => {" +
    "  await document.fonts.ready;" +
    "  const el = document.querySelector('.av-ctx-panel');" +
    "  if (!el) return { error: 'no panel' };" +
    "  const cs = getComputedStyle(el);" +
    "  return {" +
    "    clientHeight: el.clientHeight, scrollHeight: el.scrollHeight," +
    "    innerHeight: window.innerHeight, maxHeight: cs.maxHeight, overflowY: cs.overflowY," +
    "    scrollTopStart: el.scrollTop" +
    "  };" +
    "})()",
  );
}
async function scrollTo(win, pos) {
  return win.webContents.executeJavaScript(
    "(() => { const el = document.querySelector('.av-ctx-panel');" +
    "  el.scrollTop = " + (pos === 'bottom' ? "el.scrollHeight" : "0") + ";" +
    "  return el.scrollTop; })()",
  );
}
async function shoot(win, file) {
  await new Promise((r) => setTimeout(r, 200));
  const img = await win.webContents.capturePage();
  fs.writeFileSync(path.join(OUT, file), img.toPNG());
  const size = img.getSize();
  return { file, width: size.width, height: size.height };
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 900, height: WIN_H, show: true, webPreferences: { offscreen: false } });
  try {
    await win.loadFile(path.join(PAGE, 'index.html'));
    // Wait for the panel to lay out with real glyphs.
    for (let i = 0; i < 200; i++) {
      const ok = await win.webContents.executeJavaScript(
        "(async () => { const el = document.querySelector('.av-ctx-panel');" +
        " if (!el) return false; await document.fonts.ready;" +
        " return document.fonts.status === 'loaded' && el.innerText.length > 20; })()",
      );
      if (ok) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    result.measure = await measure(win);
    await scrollTo(win, 'top');
    result.shots.push({ pos: 'top', scrollTop: 0, ...(await shoot(win, 'ctx-panel-top.png')) });
    const bottomScroll = await scrollTo(win, 'bottom');
    result.shots.push({ pos: 'bottom', scrollTop: bottomScroll, ...(await shoot(win, 'ctx-panel-bottom.png')) });
    fs.writeFileSync(process.env.PROBE_OUT, JSON.stringify(result));
    app.exit(0);
  } catch (e) {
    fs.writeFileSync(process.env.PROBE_OUT, JSON.stringify({ error: String((e && e.stack) || e) }));
    app.exit(1);
  }
});
`,
);

const probeOut = path.join(tmp, 'result.json');
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

console.log('\n#33 — context breakdown panel SCROLLS at the 60vh cap (headless sway):');
if (!fs.existsSync(probeOut)) {
  console.log(`  FAIL the capture produced no output (electron rc=${rc})`);
  process.exit(1);
}
const result = JSON.parse(fs.readFileSync(probeOut, 'utf8'));
if (result.error) {
  console.log(`  FAIL capture threw: ${result.error}`);
  process.exit(1);
}
const m = result.measure;
if (!m || m.error) {
  console.log(`  FAIL measurement failed: ${m && m.error}`);
  process.exit(1);
}

console.log(
  `  measured: clientHeight=${m.clientHeight} scrollHeight=${m.scrollHeight} ` +
    `innerHeight=${m.innerHeight} maxHeight=${m.maxHeight} overflowY=${m.overflowY}`,
);

// (1) The cap is applied: the computed max-height IS 60vh, and the panel's
// content box is clamped to it. clientHeight = the max-height content box PLUS
// the panel's own vertical padding (12px each side), so compare clientHeight to
// parsed maxHeight within a padding-sized tolerance rather than to raw 60vh.
const vh60 = m.innerHeight * 0.6;
const maxH = parseFloat(m.maxHeight); // px value of the computed 60vh
check(
  'computed max-height equals 60vh',
  Number.isFinite(maxH) && Math.abs(maxH - vh60) <= 2,
  `maxHeight=${m.maxHeight} vs 60vh=${vh60.toFixed(1)}`,
);
check(
  'the panel content box is clamped at the 60vh cap (not full content)',
  // clientHeight = maxH content box + up to ~28px vertical padding; and it must
  // be well UNDER the full content height (scrollHeight), i.e. actually clamped.
  m.clientHeight <= maxH + 30 && m.clientHeight < m.scrollHeight,
  `clientHeight=${m.clientHeight} vs maxHeight=${maxH} content, scrollHeight=${m.scrollHeight}`,
);
check('overflow-y is auto (scrollable)', m.overflowY === 'auto', `overflowY=${m.overflowY}`);

// (2) THE CORE CLAIM PR #30 COULD NOT MAKE: content overflows the cap.
check(
  'content OVERFLOWS the cap (scrollHeight > clientHeight)',
  m.scrollHeight > m.clientHeight + 20,
  `scrollHeight=${m.scrollHeight} clientHeight=${m.clientHeight} (Δ=${m.scrollHeight - m.clientHeight})`,
);

// (3) It actually scrolls — scrollTop moved off 0 when driven to the bottom.
const bottom = result.shots.find((s) => s.pos === 'bottom');
check(
  'the panel actually scrolls (scrollTop > 0 at bottom)',
  bottom && bottom.scrollTop > 0,
  `scrollTop at bottom = ${bottom && bottom.scrollTop}`,
);
check(
  'scrolled to the true bottom (scrollTop ≈ scrollHeight - clientHeight)',
  bottom && Math.abs(bottom.scrollTop - (m.scrollHeight - m.clientHeight)) <= 4,
  `scrollTop=${bottom && bottom.scrollTop} expected≈${m.scrollHeight - m.clientHeight}`,
);

// (4) PIXEL HALF — decode the two PNGs and prove the scroll is VISIBLE.
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
function diffPixels(a, b) {
  if (a.w !== b.w || a.h !== b.h || a.ch !== b.ch) return -1;
  let d = 0;
  for (let k = 0; k < a.px.length; k += a.ch) {
    if (a.px[k] !== b.px[k] || a.px[k + 1] !== b.px[k + 1] || a.px[k + 2] !== b.px[k + 2]) d++;
  }
  return d;
}

const topPng = decodePng(fs.readFileSync(path.join(outDir, 'ctx-panel-top.png')));
const botPng = decodePng(fs.readFileSync(path.join(outDir, 'ctx-panel-bottom.png')));

const topColours = distinctColours(topPng);
check('the TOP frame is not blank/glyph-less (many colours)', topColours > 30, `${topColours} colours — a solid/glyph-less frame has ~1`);

const scrollDiff = diffPixels(topPng, botPng);
console.log(`  top↔bottom differing pixels: ${scrollDiff}`);
// The two frames differ because the panel's content moved under its clip. This
// is the DECODED-PIXEL proof that the scroll is real, not a DOM-only claim. The
// floor (>500) sits well above capture noise and well below the observed diff.
check('TOP and BOTTOM frames DIFFER in pixels (scroll is visible in paint)', scrollDiff > 500, `only ${scrollDiff} px differ`);

const topBytes = fs.statSync(path.join(outDir, 'ctx-panel-top.png')).size;
console.log(`  observed PNG size — top: ${topBytes} bytes`);
check('the TOP PNG is text-dense (not a glyph-less frame)', topBytes > 6000, `${topBytes} bytes — LOOK at the PNG before blaming the threshold`);

console.log(`\nScreenshots in ${outDir}`);
fs.rmSync(tmp, { recursive: true, force: true });
if (failures) {
  console.log(`\ncontext-panel-scroll-screenshot: ${failures} FAILURE(S)`);
  process.exit(1);
}
console.log('\ncontext-panel-scroll-screenshot: all checks passed');
