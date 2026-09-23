// Network-trouble visibility (2026-09-23) — SCREENSHOTS of the new surfaces,
// rendered by a real Electron window with the REAL stylesheets under a
// marker-verified headless sway (RIG_WAYLAND). Modeled on restart-row-screenshot.mjs.
//
// States: stall-row (live "la CLI ne répond pas" row), badge (sidebar badge),
// auto-restart (watchdog RestartRow, expanded), api-retry (persistent notice),
// none (control: no stall → nothing amber). DOM half + pixel half per state.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rigWayland = process.env.RIG_WAYLAND;
if (!rigWayland || rigWayland === 'wayland-1') {
  console.log(`REFUSED: RIG_WAYLAND=${rigWayland ?? '<unset>'} — needs a marker-verified headless sway display (never wayland-1).`);
  process.exit(3);
}
if (process.env.DISPLAY) {
  console.log(`REFUSED: X11 DISPLAY=${process.env.DISPLAY} is set — Electron would reach the human's screen.`);
  process.exit(3);
}
const outDir = process.env.SHOT_DIR || path.join(repoRoot, 'build', 'network-visibility-shots');
fs.mkdirSync(outDir, { recursive: true });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'netvis-shot-'));

function loadEsbuild() {
  try { return require_('esbuild'); } catch {
    const store = fs.globSync?.(repoRoot + '/node_modules/.pnpm/esbuild@*/node_modules/esbuild') ?? [];
    if (store.length) return require_(store[0]);
    throw new Error('esbuild not resolvable — run `pnpm install` first');
  }
}
const { build } = loadEsbuild();
const cacheDir = path.join(repoRoot, 'node_modules', '.cache');
fs.mkdirSync(cacheDir, { recursive: true });
const J = (p) => JSON.stringify(path.join(repoRoot, p));
const entry = path.join(cacheDir, 'netvis-shot-page.tsx');
fs.writeFileSync(entry, `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { BootStallRowView, BootStallBadgeView } from ${J('src/renderer/components/BootStallView.tsx')};
import { RestartRow } from ${J('src/renderer/components/agent/RestartRow.tsx')};
import { NoticeRow } from ${J('src/renderer/components/agent/NoticeRow.tsx')};
import { makeRestartNotice } from ${J('src/shared/restart-notice.ts')};
import { foldEvents, emptySession, normalizeSdkMessage } from ${J('src/shared/agent-events.ts')};

const NOW = 1790000000000;
const ctx = { seq: 0, now: () => NOW };
const autoMsg = foldEvents(emptySession('ws'), [makeRestartNotice(ctx, 'watchdog-boot')]).messages.at(-1);
const retryEvents = normalizeSdkMessage({ type: 'system', subtype: 'api_retry', attempt: 1, max_retries: 1,
  retry_delay_ms: 557, error_status: null, no_response: { waited_ms: 188000, retry_wait_ms: 599000 } }, ctx);
const retryMsg = foldEvents(emptySession('ws'), retryEvents).messages.filter((m) => m.noticeKind).at(-1);

const state = new URLSearchParams(location.search).get('state');
let body = null;
if (state === 'stall-row') body = React.createElement(BootStallRowView, { since: NOW - 72000, now: NOW, busy: false, onRestart: () => {} });
else if (state === 'auto-restart') body = React.createElement(RestartRow, { message: autoMsg, defaultOpen: true });
else if (state === 'api-retry') body = React.createElement(NoticeRow, { message: retryMsg });
else if (state === 'badge') body = React.createElement('div', { className: 'ws-item' },
  React.createElement('div', { className: 'ws-row-top', style: { display: 'flex', alignItems: 'center', gap: 6, padding: '8px 12px', color: '#ddd', fontSize: 13 } },
    React.createElement('span', null, 'bloc2-mc-next-migration-poc'),
    React.createElement(BootStallBadgeView, { since: NOW - 72000, now: NOW })));
else body = React.createElement('div', { style: { color: '#888', padding: 12 } }, 'control: no stall');
createRoot(document.getElementById('root')).render(
  React.createElement('div', { className: 'av-view active', 'data-agent-theme': 'default' },
    React.createElement('div', { className: 'av-message-list', 'data-shot-root': '1', style: { padding: '16px' } }, body)));
document.title = 'netvis-' + state;
`);
const bundleJs = path.join(cacheDir, 'netvis-shot-page.js');
await build({ entryPoints: [entry], outfile: bundleJs, bundle: true, format: 'iife', platform: 'browser',
  jsx: 'automatic', loader: { '.css': 'empty' }, logLevel: 'silent' });

const cssFiles = ['src/renderer/styles.css', 'src/renderer/agent-view-theme.css', 'src/renderer/agent-view-defaults.css',
  'src/renderer/agent-view-structure.css', 'src/renderer/agent-view-flat.css'];
const links = cssFiles.map((rel) => {
  fs.writeFileSync(path.join(tmp, path.basename(rel)), fs.readFileSync(path.join(repoRoot, rel)));
  return `<link rel="stylesheet" href="./${path.basename(rel)}">`;
});
fs.writeFileSync(path.join(tmp, 'page.js'), fs.readFileSync(bundleJs));
fs.writeFileSync(path.join(tmp, 'index.html'), `<!doctype html><html><head><meta charset="utf-8">
${links.join('\n')}
<style>html,body{margin:0;height:100%;background:#1a1f26;}#root{position:relative;height:100%;}</style>
</head><body><div id="root"></div><script src="./page.js"></script></body></html>`);

const STATES = [['stall-row', 'boot-stall-row.png'], ['badge', 'boot-stall-sidebar-badge.png'],
  ['auto-restart', 'auto-restart-row-expanded.png'], ['api-retry', 'api-retry-notice.png'], ['none', 'control-no-stall.png']];
const probe = path.join(tmp, 'shot.cjs');
fs.writeFileSync(probe, `
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs'); const path = require('node:path');
const STATES = ${JSON.stringify(STATES)}; const results = [];
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 900, height: 360, show: true });
  try {
    for (const [state, file] of STATES) {
      await win.loadFile(path.join(process.env.PAGE_DIR, 'index.html'), { search: 'state=' + state });
      for (let i = 0; i < 200; i++) {
        const ok = await win.webContents.executeJavaScript("(async()=>{const el=document.querySelector('[data-shot-root=\\"1\\"]');if(!el)return false;await document.fonts.ready;return el.innerText.length>5;})()");
        if (ok) break; await new Promise((r) => setTimeout(r, 50));
      }
      await new Promise((r) => setTimeout(r, 250));
      const img = await win.webContents.capturePage();
      fs.writeFileSync(path.join(process.env.SHOT_DIR, file), img.toPNG());
      const info = await win.webContents.executeJavaScript("(()=>{const el=document.querySelector('[data-boot-stall]');const r=el&&el.getBoundingClientRect();return {text:document.body.innerText, stall: !!el, rect: r?{l:r.left,r:r.right,t:r.top,b:r.bottom,w:innerWidth,h:innerHeight}:null};})()");
      results.push({ state, file, ...info });
    }
    fs.writeFileSync(process.env.PROBE_OUT, JSON.stringify(results)); app.exit(0);
  } catch (e) { fs.writeFileSync(process.env.PROBE_OUT, JSON.stringify([{ error: String(e && e.stack || e) }])); app.exit(1); }
});
`);
const probeOut = path.join(tmp, 'shots.json');
const childEnv = ['-i', `HOME=${tmp}`, 'PATH=/usr/bin:/bin', `XDG_RUNTIME_DIR=${process.env.XDG_RUNTIME_DIR || '/run/user/1000'}`,
  `WAYLAND_DISPLAY=${rigWayland}`, 'ELECTRON_OZONE_PLATFORM_HINT=wayland', 'ELECTRON_DISABLE_SANDBOX=1',
  `SHOT_DIR=${outDir}`, `PAGE_DIR=${tmp}`, `PROBE_OUT=${probeOut}`];
const wd = childEnv.find((e) => e.startsWith('WAYLAND_DISPLAY='));
if (wd !== `WAYLAND_DISPLAY=${rigWayland}` || childEnv.some((e) => e.startsWith('DISPLAY='))) { console.log('REFUSED: child env display mismatch'); process.exit(3); }
try {
  execFileSync('env', [...childEnv, path.join(repoRoot, 'node_modules', 'electron', 'dist', 'electron'), '--no-sandbox', probe],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 180000 });
} catch (e) { if (e.stderr) console.log(String(e.stderr).split('\n').slice(0, 10).join('\n')); }

let failures = 0;
const check = (label, ok, detail = '') => { if (ok) console.log(`  ok   ${label}`); else { failures++; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); } };
if (!fs.existsSync(probeOut)) { console.log('  FAIL no capture output'); process.exit(1); }
const shots = JSON.parse(fs.readFileSync(probeOut, 'utf8'));
if (shots[0]?.error) { console.log(`  FAIL capture threw: ${shots[0].error}`); process.exit(1); }
const by = Object.fromEntries(shots.map((s) => [s.state, s]));
console.log('\nNetwork-trouble visibility — captures under headless sway:');
check('five captures', shots.length === 5, `got ${shots.length}`);
// DOM half
check('stall row: headline with elapsed time', by['stall-row'].text.includes('La CLI ne répond pas depuis 1 min 12'));
check('stall row: auto-heal ETA + Relancer button', /Relance automatique vers 3 min 00/.test(by['stall-row'].text) && by['stall-row'].text.includes('Relancer'));
check('badge: elapsed label beside the workspace', by['badge'].text.includes('1 min 12'));
check('auto-restart: automatic headline', by['auto-restart'].text.includes('Session relancée automatiquement'));
check('auto-restart: reason in the expanded detail', by['auto-restart'].text.includes("pas démarré en 3 min"));
check('api-retry: persistent notice names the wait', by['api-retry'].text.includes('API sans réponse depuis 3 min 08'));
check('control: rendered (page alive) with no stall element', by['none'].text.includes('control: no stall') && by['none'].stall === false);
for (const st of ['stall-row', 'badge']) {
  const r = by[st].rect;
  check(`${st}: element fully inside the viewport`, !!r && r.l >= 0 && r.r <= r.w && r.t >= 0 && r.b <= r.h, JSON.stringify(r));
}
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


const png = Object.fromEntries(shots.map((s) => [s.state, decodePng(fs.readFileSync(path.join(outDir, s.file)))]));
function amber(p) { let n = 0; for (let k = 0; k < p.px.length; k += p.ch) { const r = p.px[k], g = p.px[k + 1], b = p.px[k + 2]; if (r > 150 && g > 90 && b < 90 && r - b > 90) n++; } return n; }
function colours(p) { const s = new Set(); for (let k = 0; k < p.px.length; k += p.ch) { s.add((p.px[k] << 16) | (p.px[k + 1] << 8) | p.px[k + 2]); if (s.size > 5000) break; } return s.size; }
function diff(a, b) { if (a.w !== b.w || a.h !== b.h) return -1; let d = 0; for (let k = 0; k < a.px.length; k += a.ch) if (a.px[k] !== b.px[k] || a.px[k + 1] !== b.px[k + 1] || a.px[k + 2] !== b.px[k + 2]) d++; return d; }
for (const s of shots) console.log(`  ${s.state}: ${colours(png[s.state])} colours, ${amber(png[s.state])} amber px, ${fs.statSync(path.join(outDir, s.file)).size} bytes`);
check('stall row paints an amber region', amber(png['stall-row']) > 200, `${amber(png['stall-row'])} px`);
check('badge paints amber', amber(png['badge']) > 10, `${amber(png['badge'])} px`);
check('control paints no amber', amber(png['none']) < 10, `${amber(png['none'])} px`);
for (const st of ['stall-row', 'badge', 'auto-restart', 'api-retry']) {
  check(`${st}: not blank (>30 colours)`, colours(png[st]) > 30);
  check(`${st}: differs from control`, diff(png[st], png['none']) > 500, `${diff(png[st], png['none'])} px`);
}
console.log(`\nScreenshots in ${outDir}`);
fs.rmSync(tmp, { recursive: true, force: true });
if (failures) { console.log(`\nnetwork-visibility-screenshot: ${failures} FAILURE(S)`); process.exit(1); }
console.log('\nnetwork-visibility-screenshot: all checks passed');
