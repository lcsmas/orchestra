// #328 (D-Q3 option A) — a SCREENSHOT of the Resources page's Agents table with Reliquats: the ⚠ N Reliquats chip on a member's row, the row KEPT for a finished member that has only Reliquats left,
// the expanded row listing them, the dim « Reliquats not tracked » line — rendered by a real browser engine inside a headless sway (ledger #329). Run via scripts/e2e-contained-rig.sh (marker-verified own sway).
//
// Four captures: SEEDED (chip, scope-only row, untracked remainder line), EXPANDED (the chip row opened: ⚠ process lines), UNTRACKED (a report with no scoped member: no chip, no extra row, the dim line)
// and PRE-FEATURE (no report at all). Each is asserted on its rendered text/attributes/colours AND non-blank; a screenshot nobody asserts on is a file, not a gate.
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

const outDir = process.env.SHOT_DIR || path.join(os.homedir(), '.cache', 'reliquats-shots') // outside the repo: a screenshot must never be `git add -A`'d into a branch;
fs.mkdirSync(outDir, { recursive: true });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rlq-shot-328-'));

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
const seedEntry = path.join(cacheDir, 'reliquats-shot-page.tsx');
fs.writeFileSync(
  seedEntry,
  `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { AgentsTable } from ${JSON.stringify(path.join(repoRoot, 'src/renderer/components/ResourcesView.tsx'))};
import { groupSnapshot } from ${JSON.stringify(path.join(repoRoot, 'src/shared/resources.ts'))};
import { buildMemberMemoryReport, memberViewFrom, reliquatsNote } from ${JSON.stringify(path.join(repoRoot, 'src/shared/member-memory.ts'))};

const MB = 1024 * 1024;
const ws = (id, branch, repo) => ({ id, name: branch, branch, repoPath: '/home/agent/repos/' + repo, baseBranch: 'main', worktreePath: '/wt/' + id, status: 'idle', createdAt: Date.now(), kind: 'spawned' });
const WS = { 'ws-x': ws('ws-x', 'feat-x', 'ops'), 'ws-y': ws('ws-y', 'feat-y', 'ops'), 'ws-w6': ws('ws-w6', 'verifier-w6', 'ops'), 'ws-z': ws('ws-z', 'feat-z', 'ops'), 'ws-pty': ws('ws-pty', 'feat-pty', 'ops') };
const sdk = (id, mem, cpu, procs) => ({ ptyId: id + ':sdk', workspaceId: id, kind: 'sdk', remote: false, cpuPct: cpu, memBytes: mem, procCount: procs, processes: [{ pid: 100, comm: 'claude', cpuPct: cpu, memBytes: mem }] });
const pty = (id, mem, cpu, procs) => ({ ptyId: id, workspaceId: id, kind: 'agent', remote: false, cpuPct: cpu, memBytes: mem, procCount: procs, processes: [] });
// feat-x: keeper tree 620 MB (RSS-sum) but a 1.3 GB scope bill holding 3 Reliquats; feat-y: tracked, none; verifier-w6: SESSION GONE, 56 Reliquats left (the 12:51Z shape); feat-z: not tracked (tree figure); feat-pty: a terminal agent (positive control for the stop button)
const SESSIONS = [sdk('ws-x', 620 * MB, 12, 14), sdk('ws-y', 410 * MB, 3, 9), sdk('ws-z', 880 * MB, 5, 11), pty('ws-pty', 800 * MB, 5, 6)];
// UNEQUAL sizes (heaviest-first is asserted): weight n-i, scaled so the total is mb; pids ascend while sizes descend, so an ascending pid sort cannot pass for a size sort
const rel = (n, mb, comm) => { const w = Array.from({ length: n }, (_, i) => n - i); const t = w.reduce((a, b) => a + b, 0); return w.map((x, i) => ({ pid: 5000 + i, startTicks: i, rssBytes: Math.round((mb * x / t) * MB), role: 'reliquat', comm })); };
const relRev = (n, mb, comm) => rel(n, mb, comm).reverse();
const TRACKED = [
  memberViewFrom('ws-x', [{ unit: 'u1', gen: 'a', currentBytes: 1300 * MB, keeperPid: 1, procs: [{ pid: 1, startTicks: 1, rssBytes: 1, role: 'cli', comm: 'claude' }, ...relRev(3, 610, 'chrome')] }]),
  memberViewFrom('ws-y', [{ unit: 'u2', gen: 'a', currentBytes: 300 * MB, keeperPid: 2, procs: [{ pid: 2, startTicks: 2, rssBytes: 1, role: 'cli', comm: 'claude' }] }]),
  memberViewFrom('ws-w6', [{ unit: 'u3', gen: 'a', currentBytes: 14800 * MB, keeperPid: null, procs: rel(56, 15200, 'chrome') }]),
];
const SEEDED = buildMemberMemoryReport(Date.now(), TRACKED, ['ws-z', 'ws-pty'], null, 0);
const UNTRACKED = buildMemberMemoryReport(Date.now(), [], ['ws-x', 'ws-y', 'ws-z'], null, 0);

const state = new URLSearchParams(location.search).get('state');
const members = state === 'seeded' || state === 'expanded' ? SEEDED : state === 'untracked' ? UNTRACKED : undefined;
// the page's OWN grouping call over a snapshot (the one ResourcesView makes): a call site that forgets a source is visible here
const { rows, login } = groupSnapshot({ sessions: SESSIONS, containers: undefined, members });
const trace = [2, 4, 3, 6, 8, 5, 7, 4, 3, 5];
createRoot(document.getElementById('root')).render(
  React.createElement('div', { style: { padding: 18, maxWidth: 1250 } },
    React.createElement(AgentsTable, {
      rows: rows.map((g) => ({ ...g, ws: WS[g.key] ?? null, fallbackName: g.key })),
      loginSessions: login,
      traceOf: () => trace,
      diskOf: () => 120 * MB,
      ctxOf: () => 40000,
      accountLabelFor: () => null,
      warning: null,
      reliquatsLine: reliquatsNote(members),
    })),
);
document.title = 'rlq-' + state;
`,
);

const bundleJs = path.join(cacheDir, 'reliquats-shot-page.js');
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
async function shoot(win, state, file, expand) {
  win.webContents.removeAllListeners('console-message');
  win.webContents.on('console-message', (_e, level, message, line, src) => consoleLines.push(state + ' [' + level + '] ' + message + ' (' + String(src).split('/').pop() + ':' + line + ')'));
  await win.loadFile(path.join(PAGE, 'index.html'), { search: 'state=' + state });
  for (let i = 0; i < 200; i++) {
    const ok = await win.webContents.executeJavaScript(
      "(async () => { const el = document.querySelector('.res-table, .res-empty'); if (!el) return false; await document.fonts.ready; return document.fonts.status === 'loaded' && document.body.innerText.length > 60; })()",
    );
    if (ok) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  for (const name of [].concat(expand || [])) {
    await win.webContents.executeJavaScript("(() => { const r = [...document.querySelectorAll('.res-agent-row')].find((x) => x.innerText.includes('" + name + "')); if (r) r.click(); return !!r; })()");
    await new Promise((r) => setTimeout(r, 250));
  }
  await new Promise((r) => setTimeout(r, 300));
  const img = await win.webContents.capturePage();
  fs.writeFileSync(path.join(OUT, file), img.toPNG());
  const probe = await win.webContents.executeJavaScript(\`(() => {
    const rect = (el) => el ? (({ x, y, width, height }) => ({ x, y, width, height }))(el.getBoundingClientRect()) : null;
    const rows = [...document.querySelectorAll('.res-agent-row')].map((r) => ({
      text: r.innerText.replace(/\\\\s+/g, ' ').trim(),
      stopBtns: r.querySelectorAll('.res-stop-btn').length,
      chips: [...r.querySelectorAll('.res-chip')].map((c) => ({ text: c.innerText.trim(), cls: c.className, title: c.getAttribute('title'), reliquats: c.getAttribute('data-res-reliquats'), color: getComputedStyle(c).color })),
    }));
    const note = document.querySelector('[data-res-reliquats-note]');
    const warn = document.querySelector('[data-res-unattributed]');
    const reliquatProcs = [...document.querySelectorAll('.res-proc.reliquat')].map((p) => p.innerText.replace(/\\\\s+/g, ' ').trim());
    const procNotes = [...document.querySelectorAll('.res-procs-empty')].map((p) => p.innerText.replace(/\\\\s+/g, ' ').trim());
    const dimEl = document.querySelector('.res-table .res-cell.dim');
    const dimColor = dimEl ? getComputedStyle(dimEl).color : null;
    return { rows, reliquatProcs, procNotes, dimColor, note: note ? note.innerText : null, noteRect: rect(note), noteColor: note ? getComputedStyle(note).color : null, warning: warn ? warn.innerText : null, tableRect: rect(document.querySelector('.res-table')), text: document.body.innerText };
  })()\`);
  const size = img.getSize();
  results.push({ state, file, ...probe, width: size.width, height: size.height, console: consoleLines.slice(-8) });
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1320, height: 620, show: true, webPreferences: { offscreen: false } });
  try {
    await shoot(win, 'seeded', 'resources-reliquats-seeded.png', null);
    await shoot(win, 'expanded', 'resources-reliquats-expanded.png', ['feat-x', 'verifier-w6']);
    await shoot(win, 'untracked', 'resources-reliquats-untracked.png', null);
    await shoot(win, 'none', 'resources-reliquats-pre-feature.png', null);
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

console.log('\n#328 D-Q3 option A — the Agents table with Reliquats, under headless sway:');
if (!fs.existsSync(probeOut)) {
  console.log(`  FAIL the capture produced no output (electron rc=${rc})`);
  process.exit(1);
}
const shots = JSON.parse(fs.readFileSync(probeOut, 'utf8'));
if (shots[0]?.error) {
  console.log(`  FAIL capture threw: ${shots[0].error}`);
  process.exit(1);
}
check('four captures were produced', shots.length === 4, `got ${shots.length}`);
for (const s of shots) if (!s.rows?.length && s.console?.length) console.log(`  console (${s.state}): ${s.console.join(' | ').slice(0, 600)}`);
for (const s of shots) {
  const file = path.join(outDir, s.file);
  const bytes = fs.existsSync(file) ? fs.statSync(file).size : 0;
  check(`${s.state}: PNG written`, bytes > 5000, `${bytes} bytes`);
  check(`${s.state}: window had real dimensions`, s.width > 500 && s.height > 300, `${s.width}x${s.height}`);
}
const by = (state) => shots.find((s) => s.state === state);
const seeded = by('seeded'), expanded = by('expanded'), untracked = by('untracked'), none = by('none');
const rowOf = (shot, branch) => shot.rows.find((r) => r.text.includes(branch));
const reliquatChip = (row) => row?.chips.find((c) => /reliquat/.test(c.cls));

// ── seeded ──
const x = rowOf(seeded, 'feat-x'), y = rowOf(seeded, 'feat-y'), w6 = rowOf(seeded, 'verifier-w6'), z = rowOf(seeded, 'feat-z'), ptyRow = rowOf(seeded, 'feat-pty');
check('seeded: feat-x carries the « ⚠ 3 Reliquats » chip with the count in data-res-reliquats and the RSS figure + definition in its tooltip', !!reliquatChip(x) && /3 Reliquats/.test(reliquatChip(x).text) && /⚠/.test(reliquatChip(x).text) && reliquatChip(x).reliquats === '3' && /3 Reliquats · 610 MB RSS — processes this workspace launched that outlived its session/.test(reliquatChip(x).title ?? ''), JSON.stringify(reliquatChip(x)));
check('seeded: the chip is YELLOW (a problem state), not the accent/green of the other chips', !!reliquatChip(x) && reliquatChip(x).color === 'rgb(255, 200, 87)', JSON.stringify(reliquatChip(x)?.color));
check('seeded: feat-x MEM = the scope bill (1.27 GB), NOT the keeper tree (620 MB)', !!x && /1\.27 GB/.test(x.text) && !/620 MB/.test(x.text), x?.text);
check('seeded: feat-y (tracked, no Reliquat) has NO chip and reads its scope bill (300 MB)', !!y && !reliquatChip(y) && /300 MB/.test(y.text), y?.text);
check('seeded: feat-z (not tracked) has NO chip and keeps its tree figure (880 MB)', !!z && !reliquatChip(z) && /880 MB/.test(z.text), z?.text);
check('seeded: the finished member that has only Reliquats left KEEPS a row, with the chip « ⚠ 56 Reliquats » and its scope bill (14.5 GB), cpu / procs « — »', !!w6 && !!reliquatChip(w6) && reliquatChip(w6).reliquats === '56' && /14\.5 GB/.test(w6.text) && (w6.text.match(/—/g) ?? []).length >= 2, w6?.text);
check('seeded: POSITIVE CONTROL — the terminal (PTY) agent row HAS its stop button', !!ptyRow && ptyRow.stopBtns === 1, JSON.stringify({ pty: ptyRow?.stopBtns }));
check('seeded: NO stop button on the keeper-hosted rows nor on the Reliquat-only row', !!x && !!y && !!w6 && x.stopBtns === 0 && y.stopBtns === 0 && w6.stopBtns === 0);
check('seeded: the dim line names the untracked remainder (2 members) and sits BELOW the table', !!seeded.note && /^Reliquats not tracked for 2 members \(no scope\)$/.test(seeded.note) && !!seeded.noteRect && !!seeded.tableRect && seeded.noteRect.y >= seeded.tableRect.y + seeded.tableRect.height - 1, JSON.stringify({ n: seeded.note, r: seeded.noteRect, t: seeded.tableRect }));
check('seeded: the dim line is DIM — exactly the colour of the table\'s other dim cells, not the yellow of a problem state (information, not alarm)', !!seeded.noteColor && seeded.noteColor === seeded.dimColor && seeded.noteColor !== 'rgb(255, 200, 87)', JSON.stringify({ note: seeded.noteColor, dim: seeded.dimColor }));

// ── expanded ──
const mbOf = (l) => Number(/(\d+) MB RSS/.exec(l)?.[1] ?? NaN);
const xLines = expanded.reliquatProcs.filter((l) => l.includes('⚠ chrome')).slice(0, 3);
check('expanded: the opened feat-x row lists its 3 ⚠ Reliquat lines HEAVIEST FIRST (305 > 203 > 102 MB RSS — pids ascend while sizes descend), each labelled RSS', xLines.length === 3 && xLines.every((l) => /MB RSS/.test(l)) && mbOf(xLines[0]) > mbOf(xLines[1]) && mbOf(xLines[1]) > mbOf(xLines[2]), JSON.stringify(xLines));
check('expanded: the 56-Reliquat row lists the 8 heaviest and says « +48 more Reliquats (smallest not shown) »', expanded.reliquatProcs.length === 11 && expanded.procNotes.some((n) => /^\+48 more Reliquats \(smallest not shown\)$/.test(n)), JSON.stringify({ n: expanded.reliquatProcs.length, notes: expanded.procNotes }));
check('expanded: only the two opened rows list Reliquat lines (3 + 8); the collapsed capture lists none', expanded.reliquatProcs.length === 11 && seeded.reliquatProcs.length === 0);

// ── untracked ──
check('untracked: NO chip anywhere, no extra row — the rows are the pre-feature rows', untracked.rows.every((r) => !reliquatChip(r)) && JSON.stringify(untracked.rows.map((r) => r.text)) === JSON.stringify(none.rows.map((r) => r.text)));
check('untracked: ONE dim line says « Reliquats not tracked » with a cause that is not asserted as fact', !!untracked.note && /^Reliquats not tracked — no live member has a scope \(e\.g\. memory_cap OFF/.test(untracked.note), untracked.note);

// ── pre-feature ──
check('pre-feature: no chip, no Reliquat line, no note, the 4 session rows only', none.rows.length === 4 && none.rows.every((r) => !reliquatChip(r)) && none.note === null && seeded.rows.length === 5);
check('seeded differs from the pre-feature capture', seeded.text !== none.text);

const seededBytes = fs.statSync(path.join(outDir, seeded.file)).size;
check('seeded PNG is text-dense (not a glyph-less frame)', seededBytes > 25000, `${seededBytes} bytes — look at the PNG before blaming the threshold`);
check('the PNGs differ in size (different content)', new Set(shots.map((s) => fs.statSync(path.join(outDir, s.file)).size)).size >= 3);

console.log(`\nScreenshots: ${shots.map((s) => path.join(outDir, s.file)).join('\n             ')}`);
fs.rmSync(tmp, { recursive: true, force: true });
if (failures) {
  console.log(`\nreliquats-screenshot: ${failures} FAILURE(S)`);
  process.exit(1);
}
console.log('\nreliquats-screenshot: all checks passed');
