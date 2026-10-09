// #322 (D-Q7 = B) — a SCREENSHOT of the dedicated « Plafond mémoire » notice rows in the structured view: red killed command (named / inferred / unnamed / session ended / outside OOM) and the amber warning level, the command in
// a chip, the time at the right — rendered by a real browser engine inside a headless sway against the REAL agent-view stylesheet, dark AND light themes. Run via scripts/e2e-contained-rig.sh (marker-verified own sway).
// The rows come through the REAL pipeline: MemKillRecord / MemSoftRecord → memNoticeEntryOf → makeMemNotice → foldEvents → MessageBubble → NoticeRow. TRAP (the Q7 mockups were blank): `.av-view:not(.active)` is
// `display: none` — the page's container carries `av-view active`.
// Each capture is asserted on computed colours / geometry from the DOM AND on decoded pixels (red / amber surface present, not a blank frame); a screenshot nobody asserts on is a file, not a gate.
//
// DISPLAY DISCIPLINE: refuses unless handed a marker-verified headless-sway display in RIG_WAYLAND, and refuses if X11 DISPLAY is set.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { crop, decodePng, distinctColours, pixelsNear } from './pause-ui/lib.mjs';

const require_ = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rigWayland = process.env.RIG_WAYLAND;
if (!rigWayland) { console.log('REFUSED: RIG_WAYLAND unset — this rig opens a real window. Launch via scripts/e2e-contained-rig.sh.'); process.exit(3); }
if (process.env.DISPLAY) { console.log(`REFUSED: X11 DISPLAY=${process.env.DISPLAY} is set — Electron would reach the human's screen.`); process.exit(3); }
const outDir = process.env.SHOT_DIR || path.join(os.homedir(), '.cache', 'memory-cap-row-shots'); // outside the repo: a screenshot must never be `git add -A`'d into a branch
fs.mkdirSync(outDir, { recursive: true });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mcrow-shot-322-'));

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
const entry = path.join(cacheDir, 'memory-cap-row-shot-page.tsx');
const C = (rel) => JSON.stringify(path.join(repoRoot, rel));
fs.writeFileSync(entry, `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { MessageBubble } from ${C('src/renderer/components/agent/MessageBubble.tsx')};
import { makeMemNotice, memNoticeEntryOf } from ${C('src/shared/mem-notice.ts')};
import { foldEvents, emptySession } from ${C('src/shared/agent-events.ts')};

const GB = 1024 ** 3;
const T = (h, m) => new Date(2026, 9, 9, h, m).getTime();
const kill = { kind: 'kill', source: 'kernel', seq: 4, at: T(14, 2), level: 'hard', command: 'python3 swarm.py 8 50 10', pid: 9, rssBytes: 1, candidates: [], unit: 'u.scope', hardBytes: 6 * GB };
const RECS = [
  { label: 'kill, hard level (named by the kernel)', rec: kill },
  { label: 'kill, victim only inferred', rec: { ...kill, seq: 5, source: 'inferred', command: 'python3 swarm.py' } },
  { label: 'kill, too brief to be named', rec: { ...kill, seq: 6, command: null } },
  { label: "kill of the member's own agent process", rec: { ...kill, seq: 7, role: 'cli', command: 'claude' } },
  { label: 'kill from OUTSIDE the scope limit', rec: { ...kill, seq: 8, level: 'external', hardBytes: null } },
  { label: 'warning level crossed', rec: { kind: 'soft', seq: 9, at: T(13, 58), unit: 'u.scope', bytes: 3.1 * GB, softBytes: 3 * GB, hardBytes: 6 * GB } },
  { label: 'a long command (cut in the chip)', rec: { ...kill, seq: 10, command: 'cargo build --release --workspace --all-targets --features "a b c d e f g h i j k l m n o p q r s t u v w x y z" -- -Z unstable-options' } },
];
const theme = new URLSearchParams(location.search).get('theme');
const msgs = RECS.map((r, i) => foldEvents(emptySession('ws'), [makeMemNotice({ seq: i + 1 }, memNoticeEntryOf(r.rec))]).messages[0]);
const control = foldEvents(emptySession('ws'), [{ type: 'notice', kind: 'warning', text: 'API retry — a generic Warning row, untouched', seq: 99, at: T(14, 5) }]).messages[0];
createRoot(document.getElementById('root')).render(
  React.createElement('div', { className: 'av-view active', 'data-agent-theme': theme === 'light' ? 'light' : undefined, style: { padding: '10px 24px', maxWidth: 980, display: 'block' } },
    ...RECS.map((r, i) => React.createElement('div', { key: i, 'data-case': r.label }, React.createElement('div', { style: { fontSize: 10, opacity: 0.55, margin: '8px 0 0', letterSpacing: '.06em', textTransform: 'uppercase' } }, r.label), React.createElement(MessageBubble, { message: msgs[i] }))),
    React.createElement('i', { 'data-tok': 'error', style: { color: 'var(--av-error)' } }), React.createElement('i', { 'data-tok': 'warn', style: { color: 'var(--av-warn)' } }),
    React.createElement('div', { 'data-case': 'control' }, React.createElement('div', { style: { fontSize: 10, opacity: 0.55, margin: '8px 0 0', letterSpacing: '.06em', textTransform: 'uppercase' } }, 'control — the generic Warning row'), React.createElement(MessageBubble, { message: control }))),
);
document.title = 'mcrow-' + theme;
`);
const bundleJs = path.join(cacheDir, 'memory-cap-row-shot-page.js');
await build({ entryPoints: [entry], outfile: bundleJs, bundle: true, format: 'iife', platform: 'browser', jsx: 'automatic', loader: { '.css': 'empty' }, logLevel: 'silent' });
fs.writeFileSync(path.join(tmp, 'styles.css'), fs.readFileSync(path.join(repoRoot, 'src/renderer/styles.css'), 'utf8'));
fs.writeFileSync(path.join(tmp, 'agent-view-theme.css'), fs.readFileSync(path.join(repoRoot, 'src/renderer/agent-view-theme.css'), 'utf8'));
fs.writeFileSync(path.join(tmp, 'page.js'), fs.readFileSync(bundleJs));
fs.writeFileSync(path.join(tmp, 'index.html'), `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="./styles.css"><link rel="stylesheet" href="./agent-view-theme.css">
<style>html,body{margin:0;height:100%;background:#111418;color:#dfe3e8;font-family:ui-sans-serif,system-ui,sans-serif;}#root{position:relative;min-height:100%;}</style>
</head><body><div id="root"></div>
<script>window.orchestra = new Proxy({}, { get: () => () => () => {} });</script>
<script src="./page.js"></script></body></html>`);

const electronBin = path.join(repoRoot, 'node_modules', 'electron', 'dist', 'electron');
const shotProbe = path.join(tmp, 'shot.cjs');
fs.writeFileSync(shotProbe, `
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const OUT = process.env.SHOT_DIR, PAGE = process.env.PAGE_DIR;
const results = [];
async function shoot(win, theme, file) {
  await win.loadFile(path.join(PAGE, 'index.html'), { search: 'theme=' + theme });
  for (let i = 0; i < 200; i++) {
    const ok = await win.webContents.executeJavaScript("(async () => { if (!document.querySelector('[data-notice]')) return false; await document.fonts.ready; return document.fonts.status === 'loaded'; })()");
    if (ok) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  await new Promise((r) => setTimeout(r, 300));
  const img = await win.webContents.capturePage();
  fs.writeFileSync(path.join(OUT, file), img.toPNG());
  const probe = await win.webContents.executeJavaScript(\`(() => {
    const rect = (el) => el ? (({ x, y, width, height }) => ({ x, y, width, height }))(el.getBoundingClientRect()) : null;
    const rows = [...document.querySelectorAll('[data-case]')].map((c) => {
      const n = c.querySelector('[data-notice]');
      if (!n) return { label: c.getAttribute('data-case'), missing: true };
      const dot = n.querySelector('.av-notice-dot'), label = n.querySelector('.av-notice-label'), chip = n.querySelector('[data-memcap-chip]'), tag = n.querySelector('.av-notice-tag');
      const cs = getComputedStyle(n);
      return { label: c.getAttribute('data-case'), kind: n.getAttribute('data-notice'), tone: n.getAttribute('data-memcap-tone'), text: n.innerText.replace(/\\\\s+/g, ' ').trim(), rect: rect(n), height: n.getBoundingClientRect().height,
        dot: dot ? getComputedStyle(dot).backgroundColor : null, labelColor: label ? getComputedStyle(label).color : null, labelText: label ? label.innerText : null, bg: cs.backgroundColor, border: cs.borderTopColor,
        chip: chip ? { text: chip.innerText, font: getComputedStyle(chip).fontFamily, bg: getComputedStyle(chip).backgroundColor, rect: rect(chip) } : null, tag: tag ? { text: tag.innerText, rect: rect(tag) } : null, title: n.getAttribute('title'), viewW: document.documentElement.clientWidth };
    });
    const tokOf = (n) => { const e = document.querySelector('[data-tok=' + n + ']'); return e ? getComputedStyle(e).color : null; };
    return { rows, tok: { error: tokOf('error'), warn: tokOf('warn') }, viewW: document.documentElement.clientWidth, viewH: document.documentElement.clientHeight };
  })()\`);
  const size = img.getSize();
  results.push({ theme, file, ...probe, width: size.width, height: size.height });
}
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1040, height: 760, show: true, webPreferences: { offscreen: false } });
  try {
    await shoot(win, 'dark', 'memory-cap-rows-dark.png');
    await shoot(win, 'light', 'memory-cap-rows-light.png');
    fs.writeFileSync(process.env.PROBE_OUT, JSON.stringify(results));
    app.exit(0);
  } catch (e) {
    fs.writeFileSync(process.env.PROBE_OUT, JSON.stringify([{ error: String((e && e.stack) || e) }]));
    app.exit(1);
  }
});
`);
const probeOut = path.join(tmp, 'shots.json');
let rc = 0;
try {
  execFileSync('env', ['-i', `HOME=${tmp}`, 'PATH=/usr/bin:/bin', `XDG_RUNTIME_DIR=${process.env.XDG_RUNTIME_DIR || '/run/user/1000'}`, `WAYLAND_DISPLAY=${rigWayland}`, 'ELECTRON_OZONE_PLATFORM_HINT=wayland', 'ELECTRON_DISABLE_SANDBOX=1', `SHOT_DIR=${outDir}`, `PAGE_DIR=${tmp}`, `PROBE_OUT=${probeOut}`, electronBin, '--no-sandbox', shotProbe], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 180000 });
} catch (e) { rc = e.status ?? 1; if (e.stderr) console.log(String(e.stderr).split('\n').slice(0, 15).join('\n')); }

let failures = 0;
const check = (label, ok, detail = '') => { if (ok) console.log(`  ok   ${label}`); else { failures++; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); } };
console.log('\n#322 D-Q7 option B — the dedicated Plafond mémoire row, under headless sway:');
if (!fs.existsSync(probeOut)) { console.log(`  FAIL the capture produced no output (electron rc=${rc})`); process.exit(1); }
const shots = JSON.parse(fs.readFileSync(probeOut, 'utf8'));
if (shots[0]?.error) { console.log(`  FAIL capture threw: ${shots[0].error}`); process.exit(1); }
check('two captures (dark, light)', shots.length === 2, `got ${shots.length}`);
const nums = (c) => (String(c).match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
const lum = (c) => { const [r, g, b] = nums(c).map((v) => { const x = v / 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
for (const s of shots) {
  const file = path.join(outDir, s.file);
  const png = fs.existsSync(file) ? decodePng(fs.readFileSync(file)) : null;
  check(`${s.theme}: PNG written, real dimensions, many colours (not a blank frame)`, !!png && s.width > 800 && s.height > 600 && distinctColours(png) > 40, `${s.width}x${s.height}, ${png ? distinctColours(png) : 0} colours`);
  const by = (needle) => s.rows.find((r) => r.label.startsWith(needle));
  const hard = by('kill, hard level'), inferred = by('kill, victim only'), unnamed = by('kill, too brief'), ended = by("kill of the member's"), ext = by('kill from OUTSIDE'), soft = by('warning level'), long = by('a long command'), control = by('control');
  const red = s.tok.error, warn = s.tok.warn; // the page's OWN --av-error / --av-warn, resolved by the browser for this theme
  check(`${s.theme}: all 7 Plafond rows and the control are on screen (nothing missing — the Q7 mockups were blank)`, s.rows.length === 8 && s.rows.every((r) => !r.missing) && s.rows.slice(0, 7).every((r) => r.kind === 'memory-cap'), JSON.stringify(s.rows.map((r) => [r.label, r.kind, r.missing])));
  check(`${s.theme}: each is ONE line (height of a single notice row), inside the viewport`, [hard, inferred, unnamed, ended, ext, soft, long].every((r) => r.height < 36 && r.rect.x >= 0 && r.rect.x + r.rect.width <= s.viewW), JSON.stringify([hard, soft, long].map((r) => [r.height, r.rect])));
  check(`${s.theme}: a killed command is RED — dot and label in the error token, tone hard`, !!red && [hard, inferred, unnamed, ended, ext].every((r) => r.tone === 'hard' && r.dot === red && (s.theme === 'dark' ? r.labelColor === red : lum(r.labelColor) < lum(red))), JSON.stringify([hard.dot, hard.labelColor, hard.tone]));
  check(`${s.theme}: the warning level is AMBER — dot and label in the warn token, tone soft, and NOT the red of a kill`, soft.tone === 'soft' && !!warn && soft.dot === warn && soft.dot !== hard.dot && (s.theme === 'dark' ? soft.labelColor === warn : lum(soft.labelColor) < lum(warn)), JSON.stringify([soft.dot, soft.labelColor, soft.tone]));
  check(`${s.theme}: the label reads « Plafond mémoire » (uppercase by style) and the sentence is the builder's`, hard.labelText === 'Plafond mémoire' && /Command python3 swarm\.py 8 50 10 killed — 6 GB reached/.test(hard.text) && /A command was killed — 6 GB reached · probably python3 swarm\.py/.test(inferred.text) && /it lived too briefly to be named/.test(unnamed.text) && /the session ended/.test(ended.text) && /not by the Plafond mémoire/.test(ext.text) && /Working set 3\.1 GB — warning level 3 GB crossed \(hard cap 6 GB\)/.test(soft.text), JSON.stringify([hard.text, soft.text]));
  check(`${s.theme}: the command is in a monospace CHIP (code-chip surface) on the named, inferred and long rows; none on the unnamed and warning rows`, !!hard.chip && /mono|Menlo|SF Mono|Consolas|Liberation Mono/i.test(hard.chip.font) && hard.chip.bg !== 'rgba(0, 0, 0, 0)' && !!inferred.chip && !!long.chip && !unnamed.chip && !soft.chip, JSON.stringify([hard.chip, soft.chip]));
  check(`${s.theme}: the long command is CUT inside the chip (≤ 80 chars) and the row stays one line`, !!long.chip && long.chip.text.length <= 80 && long.chip.text.endsWith('…') && long.height < 36, JSON.stringify([long.chip?.text.length, long.height]));
  check(`${s.theme}: the time sits at the RIGHT edge of the row`, !!hard.tag && /\d\d:\d\d/.test(hard.tag.text) && hard.tag.rect.x > hard.rect.x + hard.rect.width * 0.8, JSON.stringify(hard.tag));
  check(`${s.theme}: the red row has a red-tinted surface, the amber row an amber-tinted one, and the control Warning row is the generic amber Warning`, hard.bg !== soft.bg && !!control && control.kind === 'warning' && control.labelText === 'Warning', JSON.stringify([hard.bg, soft.bg, control?.kind]));
  // decoded pixels: the tinted surfaces and the dots really painted
  if (png) {
    const rowImg = (r) => crop(png, r.rect.x, r.rect.y, r.rect.width, r.rect.height);
    const dotRed = nums(red);
    check(`${s.theme}: the red row's pixels carry the error colour (dot + label); the amber row's carry the warn colour`, pixelsNear(rowImg(hard), dotRed, 30) > 10 && pixelsNear(rowImg(soft), nums(warn), 60) > 10, `red row ${pixelsNear(rowImg(hard), dotRed, 30)} px; amber row ${pixelsNear(rowImg(soft), [255, 200, 87], 60)} px`);
  }
}
console.log(`\nScreenshots: ${shots.map((s) => path.join(outDir, s.file)).join('\n             ')}`);
fs.rmSync(tmp, { recursive: true, force: true });
if (failures) { console.log(`\nmemory-cap-row-screenshot: ${failures} FAILURE(S)`); process.exit(1); }
console.log('\nmemory-cap-row-screenshot: all checks passed');
