// #293 (D-pick4 option A) — a SCREENSHOT of the Resources page's Agents table with container memory: structured agents joined the table, the 🐳 chip on the owning row, a container-only row,
// the unattributed-containers line — rendered by a real browser engine inside a headless sway (ledger #295). Run via scripts/e2e-contained-rig.sh (marker-verified own sway).
//
// Three captures: the SEEDED page (chip, container-only row, unattributed line), the same page with Docker DOWN (no chip, no line, no container-only row — never a fake 0) and the
// PRE-FEATURE shape (no accounting at all). Each is asserted on its rendered text/attributes AND non-blank; a screenshot nobody asserts on is a file, not a gate.
//
// DISPLAY DISCIPLINE: refuses unless handed a marker-verified headless-sway
// display in RIG_WAYLAND, and refuses if X11 DISPLAY is set. No test window may
// ever reach the user's screen (ledger #123 §Briefing).

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

const outDir = process.env.SHOT_DIR || path.join(repoRoot, 'build', 'container-memory-shots');
fs.mkdirSync(outDir, { recursive: true });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-shot-293-'));

function loadEsbuild() {
  try {
    return require_('esbuild');
  } catch {
    const store =
      fs.globSync?.(repoRoot + '/node_modules/.pnpm/esbuild@*/node_modules/esbuild') ?? [];
    if (store.length) return require_(store[0]);
    throw new Error('esbuild not resolvable — run `pnpm install` first');
  }
}
const { build } = loadEsbuild();

// Build a standalone bundle of the Agents table + a seeded snapshot (NOT the whole app: this gate is about the table's own layout) rendered into a plain HTML page with the REAL stylesheet.
const cacheDir = path.join(repoRoot, 'node_modules', '.cache');
fs.mkdirSync(cacheDir, { recursive: true });
const seedEntry = path.join(cacheDir, 'container-memory-shot-page.tsx');
fs.writeFileSync(
  seedEntry,
  `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { AgentsTable } from ${JSON.stringify(path.join(repoRoot, 'src/renderer/components/ResourcesView.tsx'))};
import { groupSessionsByWorkspace } from ${JSON.stringify(path.join(repoRoot, 'src/shared/resources.ts'))};
import { accountingView, buildAccounting, emptyAccounting, unattributedWarning } from ${JSON.stringify(path.join(repoRoot, 'src/shared/container-accounting.ts'))};

const MB = 1024 * 1024;
const ws = (id, branch, repo) => ({ id, name: branch, branch, repoPath: '/home/agent/repos/' + repo, baseBranch: 'main', worktreePath: '/wt/' + id, status: 'idle', createdAt: Date.now(), kind: 'spawned' });
const WS = { 'ws-login': ws('ws-login', 'feat-login', 'ops'), 'ws-db': ws('ws-db', 'feat-db', 'ops'), 'ws-infra': ws('ws-infra', 'infra', 'ops'), 'ws-pty': ws('ws-pty', 'feat-pty', 'ops') };
// keeper-hosted structured agents: sampled as <wsId>:sdk (D-pick4 A) — the process tree only; containers come from the accounting
const sdk = (id, mem, cpu, procs) => ({ ptyId: id + ':sdk', workspaceId: id, kind: 'sdk', remote: false, cpuPct: cpu, memBytes: mem, procCount: procs, processes: [] });
// a TERMINAL agent (PTY, kind 'agent') — the POSITIVE CONTROL for the stop-button assertion: this row (and only this one) must have the button
const pty = (id, mem, cpu, procs) => ({ ptyId: id, workspaceId: id, kind: 'agent', remote: false, cpuPct: cpu, memBytes: mem, procCount: procs, processes: [] });
const SESSIONS = [sdk('ws-login', 1900 * MB, 12, 14), sdk('ws-db', 1900 * MB, 3, 11), pty('ws-pty', 800 * MB, 5, 6)];
const ACC = accountingView(buildAccounting(
  [{ wsId: 'ws-db', bytes: 612 * MB }, { wsId: 'ws-db', bytes: 88 * MB }, { wsId: 'ws-infra', bytes: 640 * MB }],
  [{ id: 'abcdef0123456789abcdef', name: 'web-1', created: 1 }, { id: 'ffff00001111aaaa22223333', name: 'g9-old', created: 1, orphanOf: 'ws-deleted-77' }],
  Date.now(),
));
const DOWN = accountingView(emptyAccounting('unavailable', Date.now()));

const state = new URLSearchParams(location.search).get('state');
const view = state === 'seeded' ? ACC : state === 'down' ? DOWN : undefined;
const { rows, login } = groupSessionsByWorkspace(SESSIONS, view);
const trace = [2, 4, 3, 6, 8, 5, 7, 4, 3, 5];
createRoot(document.getElementById('root')).render(
  React.createElement('div', { style: { padding: 18, maxWidth: 1250 } },
    React.createElement(AgentsTable, {
      rows: rows.map((g) => ({ ...g, ws: WS[g.key] ?? null, fallbackName: g.key })),
      loginSessions: login,
      traceOf: () => trace,
      diskOf: (r) => (r.key === 'ws-db' ? 1100 * MB : r.key === 'ws-login' ? 312 * MB : 90 * MB),
      ctxOf: (r) => (r.key === 'ws-db' ? 41000 : r.key === 'ws-login' ? 84000 : undefined),
      accountLabelFor: () => null,
      warning: unattributedWarning(view),
    })),
);
document.title = 'cm-' + state;
`,
);

const bundleJs = path.join(cacheDir, 'container-memory-shot-page.js');
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

// The REAL stylesheet — a screenshot against default styles would prove the component renders, not that IT renders.
const css = fs.readFileSync(path.join(repoRoot, 'src/renderer/styles.css'), 'utf8');
fs.writeFileSync(path.join(tmp, 'styles.css'), css);
fs.writeFileSync(path.join(tmp, 'page.js'), fs.readFileSync(bundleJs));
fs.writeFileSync(
  path.join(tmp, 'index.html'),
  `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="./styles.css">
<style>html,body{margin:0;height:100%;background:#111418;color:#dfe3e8;
  font-family:ui-sans-serif,system-ui,sans-serif;}
  :root{--bg:#111418;--fg:#dfe3e8;--border:#2a3038;--accent:#6ea8ff;--hover:rgba(127,127,127,.12);}
  #root{position:relative;height:100%;}</style>
</head><body><div id="root"></div>
<script>/* the store module subscribes to the preload bridge at import time; this gate renders one table, so every bridge call is a no-op (returning a no-op unsubscribe) */ window.orchestra = new Proxy({}, { get: () => () => () => {} });</script>
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
const OUT = process.env.SHOT_DIR;
const PAGE = process.env.PAGE_DIR;
const results = [];

const consoleLines = [];
async function shoot(win, state, file) {
  win.webContents.removeAllListeners('console-message');
  win.webContents.on('console-message', (_e, level, message, line, src) => consoleLines.push(state + ' [' + level + '] ' + message + ' (' + String(src).split('/').pop() + ':' + line + ')'));
  await win.loadFile(path.join(PAGE, 'index.html'), { search: 'state=' + state });
  // wait for the table root AND for fonts to be READY (measured on the bus-pane gate: correct layout with EVERY GLYPH MISSING while every innerText assertion passed)
  for (let i = 0; i < 200; i++) {
    const ok = await win.webContents.executeJavaScript(
      "(async () => { const el = document.querySelector('.res-table, .res-empty'); if (!el) return false; await document.fonts.ready; return document.fonts.status === 'loaded' && document.body.innerText.length > 60; })()",
    );
    if (ok) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  await new Promise((r) => setTimeout(r, 300));
  const img = await win.webContents.capturePage();
  fs.writeFileSync(path.join(OUT, file), img.toPNG());
  const probe = await win.webContents.executeJavaScript(\`(() => {
    const rows = [...document.querySelectorAll('.res-agent-row')].map((r) => ({ text: r.innerText.replace(/\\\\s+/g, ' ').trim(), stopBtns: r.querySelectorAll('.res-stop-btn').length, chips: [...r.querySelectorAll('.res-chip')].map((c) => ({ cls: c.className, text: c.innerText.trim(), title: c.getAttribute('title'), containers: c.getAttribute('data-res-containers') })) }));
    const warn = document.querySelector('[data-res-unattributed]');
    const rect = (el) => el ? (({ x, y, width, height }) => ({ x, y, width, height }))(el.getBoundingClientRect()) : null;
    return { rows, warning: warn ? warn.innerText : null, warningRect: rect(warn), tableRect: rect(document.querySelector('.res-table')), text: document.body.innerText };
  })()\`);
  const size = img.getSize();
  results.push({ state, file, ...probe, width: size.width, height: size.height, console: consoleLines.slice(-8) });
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1320, height: 560, show: true, webPreferences: { offscreen: false } });
  try {
    await shoot(win, 'seeded', 'resources-containers-seeded.png');
    await shoot(win, 'down', 'resources-containers-docker-down.png');
    await shoot(win, 'none', 'resources-containers-pre-feature.png');
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

console.log('\n#293 D-pick4 A — the Agents table with container memory, under headless sway:');
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
for (const s of shots) if (!s.rows?.length && s.console?.length) console.log(`  console (${s.state}): ${s.console.join(' | ').slice(0, 600)}`);
for (const s of shots) {
  const file = path.join(outDir, s.file);
  const bytes = fs.existsSync(file) ? fs.statSync(file).size : 0;
  check(`${s.state}: PNG written`, bytes > 5000, `${bytes} bytes`);
  check(`${s.state}: window had real dimensions`, s.width > 500 && s.height > 300, `${s.width}x${s.height}`);
}
const seeded = shots.find((s) => s.state === 'seeded');
const down = shots.find((s) => s.state === 'down');
const none = shots.find((s) => s.state === 'none');
const rowOf = (shot, branch) => shot.rows.find((r) => r.text.includes(branch));

// ── seeded: structured agents are IN the table, the chip is on the owning row, the container-only workspace has a row, the warning is there ──
const login = rowOf(seeded, 'feat-login');
const db = rowOf(seeded, 'feat-db');
const infra = rowOf(seeded, 'infra');
check('seeded: a keeper-hosted structured agent has a row with an « agent » chip', !!login && login.chips.some((c) => c.text.toLowerCase() === 'agent' && /agent/.test(c.cls)), JSON.stringify(login?.chips));
check('seeded: a workspace WITHOUT containers has no 🐳 chip', !!login && !login.chips.some((c) => /docker/.test(c.cls)));
const dbChip = db?.chips.find((c) => /docker/.test(c.cls));
check('seeded: feat-db carries the 🐳 2 chip with the measured figure in its tooltip', !!dbChip && dbChip.containers === '2' && /2 containers · 700 MB/.test(dbChip.title ?? ''), JSON.stringify(dbChip));
check('seeded: feat-db memory = process tree + containers (1.9 GB + 700 MB = 2.54 GB)', !!db && /2\.54 GB/.test(db.text), db?.text);
check('seeded: the process-only workspace shows only its tree (1.86 GB)', !!login && /1\.86 GB/.test(login.text), login?.text);
check('seeded: a container-only workspace has its OWN row with the chip and its figure (640 MB), cpu/procs « — »', !!infra && /640 MB/.test(infra.text) && infra.chips.some((c) => /docker/.test(c.cls) && c.containers === '1') && (infra.text.match(/—/g) ?? []).length >= 2, infra?.text);
const ptyRow = rowOf(seeded, 'feat-pty');
check('seeded: POSITIVE CONTROL — the terminal (PTY) agent row HAS its stop button (so a count of 0 elsewhere means something)', !!ptyRow && ptyRow.stopBtns === 1, JSON.stringify({ pty: ptyRow?.stopBtns }));
check('seeded: NO stop button on a keeper-hosted / container-only row (the page stops PTYs only)', !!login && !!db && !!infra && login.stopBtns === 0 && db.stopBtns === 0 && infra.stopBtns === 0, JSON.stringify({ login: login?.stopBtns, db: db?.stopBtns, infra: infra?.stopBtns }));
check('seeded: the unattributed line is on screen, names both containers, says never touched', !!seeded.warning && /2 unattributed containers \(web-1, g9-old \(orphan of ws-deleted-77\)\)/.test(seeded.warning) && /never touched/.test(seeded.warning), seeded.warning ?? 'none');
check('seeded: the warning sits BELOW the table', !!seeded.warningRect && !!seeded.tableRect && seeded.warningRect.y >= seeded.tableRect.y + seeded.tableRect.height - 1, JSON.stringify({ w: seeded.warningRect, t: seeded.tableRect }));

// ── Docker down: nothing about containers is claimed — never a fake 0, never a chip ──
check('docker down: no 🐳 chip anywhere', down.rows.every((r) => !r.chips.some((c) => /docker/.test(c.cls))));
check('docker down: no container-only row, no unattributed line', !rowOf(down, 'infra') && down.warning === null);
check('docker down: feat-db shows ONLY its process tree (1.86 GB)', /1\.86 GB/.test(rowOf(down, 'feat-db')?.text ?? ''), rowOf(down, 'feat-db')?.text);

// ── pre-feature shape: identical to « no accounting at all » ──
check('pre-feature: no chips, no extra rows, no warning', none.rows.length === 3 && none.rows.every((r) => !r.chips.some((c) => /docker/.test(c.cls))) && none.warning === null);
check('docker-down capture == pre-feature capture (same rows)', JSON.stringify(down.rows.map((r) => r.text)) === JSON.stringify(none.rows.map((r) => r.text)));
check('seeded differs from the pre-feature capture', seeded.text !== none.text);

// A blank / glyph-less window is the classic headless artifact: the byte size is the only assertion that can see it
const seededBytes = fs.statSync(path.join(outDir, seeded.file)).size;
check('seeded PNG is text-dense (not a glyph-less frame)', seededBytes > 25000, `${seededBytes} bytes — look at the PNG before blaming the threshold`);
check('the PNGs differ in size (different content)', new Set(shots.map((s) => fs.statSync(path.join(outDir, s.file)).size)).size >= 2);

console.log(`\nScreenshots: ${shots.map((s) => path.join(outDir, s.file)).join('\n             ')}`);
fs.rmSync(tmp, { recursive: true, force: true });
if (failures) {
  console.log(`\ncontainer-memory-screenshot: ${failures} FAILURE(S)`);
  process.exit(1);
}
console.log('\ncontainer-memory-screenshot: all checks passed');
