// #331 (D-Q4 A', ledger #329) — a SCREENSHOT of the Resources page's Agents table with the grey « 🌐 N arrêtés » chip, rendered by a real browser engine inside a headless sway.
// Run via `bash scripts/e2e-contained-rig.sh node scripts/browser-reliquats/chip-screenshot.mjs` (marker-verified own sway). Three captures: SEEDED (chip on the owning rows), ZERO (every counter at 0)
// and PRE-FEATURE (no view at all) — each asserted on rendered text / attributes / computed style AND non-blank. Prints `PASS chip-screenshot` + `SURVIVORS arm=chip procs=N` (electron processes by env marker).
//
// DISPLAY DISCIPLINE: refuses unless handed a marker-verified headless-sway display in RIG_WAYLAND, and refuses if X11 DISPLAY is set.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const rigWayland = process.env.RIG_WAYLAND;
if (!rigWayland) {
  console.log('REFUSED: RIG_WAYLAND unset — this rig opens a real window. Launch it through scripts/e2e-contained-rig.sh (headless sway, marker-verified).');
  process.exit(3);
}
if (process.env.DISPLAY) {
  console.log(`REFUSED: X11 DISPLAY=${process.env.DISPLAY} is set — Electron would reach the human's screen.`);
  process.exit(3);
}

const outDir = process.env.SHOT_DIR || path.join(repoRoot, 'build', 'browser-chip-shots');
fs.mkdirSync(outDir, { recursive: true });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'br-chip-shot-'));

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
const entry = path.join(cacheDir, `browser-chip-shot-${process.pid}.tsx`);
const LAST_AT = Date.UTC(2026, 9, 8, 16, 32, 0); // 16:32 — the tooltip prints it as HH:MM in the page's zone, pinned to UTC below
fs.writeFileSync(
  entry,
  `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { AgentsTable, browsersChipFor } from ${JSON.stringify(path.join(repoRoot, 'src/renderer/components/ResourcesView.tsx'))};
import { groupSessionsByWorkspace } from ${JSON.stringify(path.join(repoRoot, 'src/shared/resources.ts'))};
import { accountingView, buildAccounting } from ${JSON.stringify(path.join(repoRoot, 'src/shared/container-accounting.ts'))};

const MB = 1024 * 1024;
const ws = (id, branch) => ({ id, name: branch, branch, repoPath: '/home/agent/repos/orchestra', baseBranch: 'main', worktreePath: '/wt/' + id, status: 'idle', createdAt: Date.now(), kind: 'spawned' });
const WS = { 'ws-x': ws('ws-x', 'feat-x'), 'ws-y': ws('ws-y', 'feat-y'), 'ws-pty': ws('ws-pty', 'feat-pty'), 'ws-z': ws('ws-z', 'feat-z'), 'ws-r': ws('ws-r', 'feat-remote'), 'ws-gone': ws('ws-gone', 'feat-finished') };
const sdk = (id, mem, cpu, procs, remote = false) => ({ ptyId: id + ':sdk', workspaceId: id, kind: 'sdk', remote, cpuPct: cpu, memBytes: mem, procCount: procs, processes: [] });
const pty = (id, mem, cpu, procs) => ({ ptyId: id, workspaceId: id, kind: 'agent', remote: false, cpuPct: cpu, memBytes: mem, procCount: procs, processes: [] });
// ws-gone: a FINISHED member — it has a counter but no session and no container, so it must have NO row
const SESSIONS = [sdk('ws-x', 1900 * MB, 12, 14), sdk('ws-y', 900 * MB, 3, 8), pty('ws-pty', 800 * MB, 5, 6), sdk('ws-z', 700 * MB, 2, 5), sdk('ws-r', 0, 0, 0, true)];
const ACC = accountingView(buildAccounting([{ wsId: 'ws-x', bytes: 612 * MB }, { wsId: 'ws-x', bytes: 88 * MB }], [], Date.now()));
const prefix = (id) => '/home/agent/.orchestra/agent-tmp/' + id + '/tmp/';
const counter = (stopped, id) => ({ stopped, lastAt: ${LAST_AT}, lastPrefix: prefix(id) });
const SEEDED = { total: 15, byWorkspace: { 'ws-x': counter(5, 'ws-x'), 'ws-pty': counter(1, 'ws-pty'), 'ws-z': counter(0, 'ws-z'), 'ws-r': counter(3, 'ws-r'), 'ws-gone': counter(6, 'ws-gone') } };
const ZERO = { total: 0, byWorkspace: { 'ws-x': counter(0, 'ws-x'), 'ws-y': counter(0, 'ws-y') } };

const state = new URLSearchParams(location.search).get('state');
const browsers = state === 'seeded' ? SEEDED : state === 'zero' ? ZERO : undefined;
const { rows, login } = groupSessionsByWorkspace(SESSIONS, state === 'none' ? undefined : ACC);
const trace = [2, 4, 3, 6, 8, 5, 7, 4, 3, 5];
// a plain .res-chip next to the table: the GREY reference the browsers chip must match (history tone, no status colour)
createRoot(document.getElementById('root')).render(
  React.createElement('div', { style: { padding: 18, maxWidth: 1250 } },
    React.createElement(AgentsTable, {
      rows: rows.map((g) => ({ ...g, ws: WS[g.key] ?? null, fallbackName: g.key })),
      loginSessions: login,
      traceOf: () => trace,
      diskOf: () => 100 * MB,
      ctxOf: () => undefined,
      accountLabelFor: () => null,
      warning: null,
      browsersOf: (row) => browsersChipFor(browsers, row),
    }),
    React.createElement('span', { id: 'grey-ref', className: 'res-chip' }, 'ref')),
);
document.title = 'chip-' + state;
`,
);
const bundleJs = path.join(cacheDir, `browser-chip-shot-${process.pid}.js`);
await build({ entryPoints: [entry], outfile: bundleJs, bundle: true, format: 'iife', platform: 'browser', jsx: 'automatic', loader: { '.css': 'empty' }, logLevel: 'silent' });
fs.rmSync(entry, { force: true });

fs.writeFileSync(path.join(tmp, 'styles.css'), fs.readFileSync(path.join(repoRoot, 'src/renderer/styles.css'), 'utf8'));
fs.writeFileSync(path.join(tmp, 'page.js'), fs.readFileSync(bundleJs));
fs.rmSync(bundleJs, { force: true });
fs.writeFileSync(
  path.join(tmp, 'index.html'),
  `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="./styles.css">
<style>html,body{margin:0;height:100%;background:#111418;color:#dfe3e8;font-family:ui-sans-serif,system-ui,sans-serif;}
  #root{position:relative;height:100%;}</style>
</head><body><div id="root"></div>
<script>window.orchestra = new Proxy({}, { get: () => () => () => {} });</script>
<script src="./page.js"></script></body></html>`,
);

const electronBin = path.join(repoRoot, 'node_modules', 'electron', 'dist', 'electron');
const shotProbe = path.join(tmp, 'shot.cjs');
fs.writeFileSync(
  shotProbe,
  `
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const OUT = process.env.SHOT_DIR, PAGE = process.env.PAGE_DIR;
const results = [];
async function shoot(win, state, file) {
  await win.loadFile(path.join(PAGE, 'index.html'), { search: 'state=' + state });
  for (let i = 0; i < 200; i++) {
    const ok = await win.webContents.executeJavaScript("(async () => { const el = document.querySelector('.res-table, .res-empty'); if (!el) return false; await document.fonts.ready; return document.fonts.status === 'loaded' && document.body.innerText.length > 60; })()");
    if (ok) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  await new Promise((r) => setTimeout(r, 300));
  const img = await win.webContents.capturePage();
  fs.writeFileSync(path.join(OUT, file), img.toPNG());
  const probe = await win.webContents.executeJavaScript(\`(() => {
    const cs = (el) => { const s = getComputedStyle(el); return { color: s.color, border: s.borderTopColor }; };
    const ref = document.getElementById('grey-ref');
    const rows = [...document.querySelectorAll('.res-agent-row')].map((r) => ({ text: r.innerText.replace(/\\\\s+/g, ' ').trim(), chips: [...r.querySelectorAll('.res-chip')].map((c) => ({ cls: c.className, text: c.innerText.trim(), title: c.getAttribute('title'), browsers: c.getAttribute('data-res-browsers'), style: cs(c), rect: (({ x, y, width, height }) => ({ x, y, width, height }))(c.getBoundingClientRect()) })) }));
    return { rows, ref: ref ? cs(ref) : null, text: document.body.innerText };
  })()\`);
  const size = img.getSize();
  results.push({ state, file, ...probe, width: size.width, height: size.height });
}
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1320, height: 520, show: true, webPreferences: { offscreen: false } });
  try {
    await shoot(win, 'seeded', 'resources-browsers-seeded.png');
    await shoot(win, 'zero', 'resources-browsers-zero.png');
    await shoot(win, 'none', 'resources-browsers-pre-feature.png');
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
    ['-i', `HOME=${tmp}`, 'PATH=/usr/bin:/bin', `XDG_RUNTIME_DIR=${process.env.XDG_RUNTIME_DIR || '/run/user/1000'}`, `WAYLAND_DISPLAY=${rigWayland}`, 'ELECTRON_OZONE_PLATFORM_HINT=wayland', 'ELECTRON_DISABLE_SANDBOX=1', 'TZ=UTC', `SHOT_DIR=${outDir}`, `PAGE_DIR=${tmp}`, `PROBE_OUT=${probeOut}`, electronBin, '--no-sandbox', shotProbe],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 180000 },
  );
} catch (e) {
  rc = e.status ?? 1;
  if (e.stderr) console.log(String(e.stderr).split('\n').slice(0, 15).join('\n'));
}

// Survivors: any process still carrying THIS rig's HOME in its environment (the electron main, its helpers) — read from /proc, selected by marker, never by name.
const survivors = () => {
  let n = 0;
  for (const pid of fs.readdirSync('/proc').filter((p) => /^\d+$/.test(p))) {
    try { if (fs.readFileSync(`/proc/${pid}/environ`, 'latin1').split('\0').includes(`HOME=${tmp}`)) n++; } catch { /* gone / not ours */ }
  }
  return n;
};

let failures = 0;
const check = (label, ok, detail = '') => {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
};

console.log('\n#331 D-Q4 A\' — the Agents table with the « 🌐 N arrêtés » chip, under headless sway:');
if (!fs.existsSync(probeOut)) {
  console.log(`  FAIL the capture produced no output (electron rc=${rc})`);
  console.log(`SURVIVORS arm=chip procs=${survivors()}`);
  process.exit(1);
}
const shots = JSON.parse(fs.readFileSync(probeOut, 'utf8'));
if (shots[0]?.error) {
  console.log(`  FAIL capture threw: ${shots[0].error}`);
  console.log(`SURVIVORS arm=chip procs=${survivors()}`);
  process.exit(1);
}
check('three captures were produced', shots.length === 3, `got ${shots.length}`);
for (const s of shots) {
  const bytes = fs.existsSync(path.join(outDir, s.file)) ? fs.statSync(path.join(outDir, s.file)).size : 0;
  check(`${s.state}: PNG written and text-dense (not a glyph-less frame)`, bytes > 20000, `${bytes} bytes`);
  check(`${s.state}: window had real dimensions`, s.width > 500 && s.height > 300, `${s.width}x${s.height}`);
}
const [seeded, zero, none] = ['seeded', 'zero', 'none'].map((st) => shots.find((s) => s.state === st));
const rowOf = (shot, branch) => shot.rows.find((r) => r.text.includes(branch));
const chipOf = (row) => row?.chips.find((c) => /\bbrowsers\b/.test(c.cls));

const x = rowOf(seeded, 'feat-x');
const xc = chipOf(x);
check('chip_on_owning_row: seeded: feat-x carries the chip, reading « 🌐 5 arrêtés »', !!xc && /^\u{1F310}\s*5 arrêtés$/u.test(xc.text) && xc.browsers === '5', JSON.stringify(xc));
check('chip_tooltip: seeded: its tooltip names the count, the last time (16:32) and the workspace\'s profile prefix', !!xc && /5 navigateurs headless orphelins arrêtés/.test(xc.title ?? '') && /dernier à 16:32/.test(xc.title ?? '') && /agent-tmp\/ws-x\/tmp\//.test(xc.title ?? ''), xc?.title);
const dockerIdx = x?.chips.findIndex((c) => /docker/.test(c.cls)) ?? -1;
const browserIdx = x?.chips.findIndex((c) => /\bbrowsers\b/.test(c.cls)) ?? -1;
check('chip_after_docker: seeded: the 🌐 chip sits AFTER the 🐳 chip on the same row (both present)', dockerIdx >= 0 && browserIdx > dockerIdx, JSON.stringify(x?.chips.map((c) => c.cls)));
check('chip_on_screen: seeded: the chip is on screen (non-zero rect, inside the window)', !!xc && xc.rect.width > 20 && xc.rect.height > 8 && xc.rect.x + xc.rect.width < seeded.width, JSON.stringify(xc?.rect));
check('chip_singular: seeded: a PTY agent row gets its own count (1 → singular tooltip)', chipOf(rowOf(seeded, 'feat-pty'))?.browsers === '1' && /^1 navigateur headless orphelin arrêté /.test(chipOf(rowOf(seeded, 'feat-pty'))?.title ?? ''), JSON.stringify(chipOf(rowOf(seeded, 'feat-pty'))));
check('no_chip_without_counter: seeded: a workspace with NO counter has no chip (feat-y)', !!rowOf(seeded, 'feat-y') && !chipOf(rowOf(seeded, 'feat-y')));
check('no_chip_at_zero: seeded: a counter at 0 draws nothing (feat-z — POSITIVE CONTROL: the row exists, other rows have the chip)', !!rowOf(seeded, 'feat-z') && !chipOf(rowOf(seeded, 'feat-z')) && !!xc);
check('no_chip_on_remote_row: seeded: a REMOTE (sandbox) row never shows a local browser counter, even with one recorded', !!rowOf(seeded, 'feat-remote') && !chipOf(rowOf(seeded, 'feat-remote')));
check('no_row_for_a_finished_member: seeded: a FINISHED member with a counter and nothing alive has NO row (6 stopped, no row kept)', !rowOf(seeded, 'feat-finished') && seeded.rows.length === 5, `${seeded.rows.length} rows: ${seeded.rows.map((r) => r.text.slice(0, 18)).join(' | ')}`);
check('chip_is_grey: seeded: the chip is the GREY default (history tone) — same colour and border as a plain .res-chip, not the accent / status colour', !!xc && !!seeded.ref && xc.style.color === seeded.ref.color && xc.style.border === seeded.ref.border, JSON.stringify({ chip: xc?.style, ref: seeded.ref }));
check('zero_equals_pre_feature: zero: every counter at 0 → no chip anywhere, same rows as the pre-feature shape', zero.rows.every((r) => !chipOf(r)) && JSON.stringify(zero.rows.map((r) => r.text)) === JSON.stringify(none.rows.map((r) => r.text)));
check('pre_feature_no_chip: pre-feature (no view): no chip anywhere', none.rows.length > 0 && none.rows.every((r) => !chipOf(r)));
check('seeded differs from the pre-feature capture', seeded.text !== none.text);

console.log(`\nScreenshots: ${shots.map((s) => path.join(outDir, s.file)).join('\n             ')}`);
fs.rmSync(path.join(cacheDir, `browser-chip-shot-${process.pid}.js`), { force: true });
const left = survivors();
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`SURVIVORS arm=chip procs=${left}`);
if (failures || left) {
  console.log(`\nchip-screenshot: ${failures} FAILURE(S)${left ? `, ${left} surviving process(es)` : ''}`);
  process.exit(1);
}
console.log('\nPASS chip-screenshot');
