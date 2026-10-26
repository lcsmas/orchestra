// #323 (D-Q10 = A + A) — a SCREENSHOT of the Plafond mémoire UI: the thin cap bar under MEM on the Resources table (ok / amber / red / uncapped / scope-only rows + the dim summary line) and the « Plafond mémoire » section of
// the Memory guard window (levels, read-only activation line, Reliquat wait, the inline refusal), rendered by a real browser engine inside a headless sway against the REAL stylesheet. Run via scripts/e2e-contained-rig.sh.
// The table is fed through the REAL pipeline: ScopeReading → memberViewFrom/buildMemberMemoryReport → groupSnapshot → AgentsTable (+ capSummaryLine), so a call site that forgets a source is visible here.
// Each capture is asserted on DOM geometry / computed colours AND on decoded pixels; a screenshot nobody asserts on is a file, not a gate.
//
// DISPLAY DISCIPLINE: refuses unless handed a marker-verified headless-sway display in RIG_WAYLAND, and refuses if X11 DISPLAY is set.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { crop, decodePng, distinctColours, pixelsNear } from './pause-ui/lib.mjs';
import { privateRuntimeDir } from './lib/rig-runtime.mjs';

const require_ = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rigWayland = process.env.RIG_WAYLAND;
if (!rigWayland) { console.log('REFUSED: RIG_WAYLAND unset — this rig opens a real window. Launch via scripts/e2e-contained-rig.sh.'); process.exit(3); }
if (process.env.DISPLAY) { console.log(`REFUSED: X11 DISPLAY=${process.env.DISPLAY} is set — Electron would reach the human's screen.`); process.exit(3); }
const outDir = process.env.SHOT_DIR || path.join(os.homedir(), '.cache', 'memcap-shots'); // outside the repo: a screenshot must never be `git add -A`'d into a branch
fs.mkdirSync(outDir, { recursive: true });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'memcap-shot-323-'));

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
const entry = path.join(cacheDir, 'memcap-shot-page.tsx');
const C = (rel) => JSON.stringify(path.join(repoRoot, rel));
fs.writeFileSync(entry, `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { AgentsTable } from ${C('src/renderer/components/ResourcesView.tsx')};
import { MemoryGuardSettings } from ${C('src/renderer/components/MemoryGuardSettings.tsx')};
import { groupSnapshot } from ${C('src/shared/resources.ts')};
import { buildMemberMemoryReport, memberViewFrom } from ${C('src/shared/member-memory.ts')};
import { capSummaryLine } from ${C('src/shared/memory-cap-view.ts')};

const MB = 1024 * 1024, GB = 1024 * MB;
const ws = (id, branch) => ({ id, name: branch, branch, repoPath: '/home/agent/repos/ops', baseBranch: 'main', worktreePath: '/wt/' + id, status: 'idle', createdAt: Date.now(), kind: 'spawned' });
const WS = { 'ws-ok': ws('ws-ok', 'feat-comfortable'), 'ws-warn': ws('ws-warn', 'feat-warming'), 'ws-crit': ws('ws-crit', 'big-job'), 'ws-cache': ws('ws-cache', 'feat-cache'), 'ws-none': ws('ws-none', 'human-ws'), 'ws-nolimit': ws('ws-nolimit', 'feat-nolimit'), 'ws-gone': ws('ws-gone', 'verifier-gone') };
const sdk = (id, mem) => ({ ptyId: id + ':sdk', workspaceId: id, kind: 'sdk', remote: false, cpuPct: 6, memBytes: mem, procCount: 9, processes: [{ pid: 100, comm: 'claude', cpuPct: 6, memBytes: mem }] });
const SESSIONS = [sdk('ws-ok', 600 * MB), sdk('ws-warn', 900 * MB), sdk('ws-crit', 1400 * MB), sdk('ws-cache', 500 * MB), sdk('ws-none', 700 * MB), sdk('ws-nolimit', 650 * MB)];
const reading = (unit, bill, wsB, hard, peak) => ({ unit, gen: 'a', currentBytes: bill * GB, workingSetBytes: wsB === null ? null : wsB * GB, maxBytes: hard === null ? null : hard * GB, peakBytes: peak === null ? null : peak * GB, keeperPid: 1, procs: [{ pid: 1, startTicks: 1, rssBytes: 1, role: 'cli', comm: 'claude' }] });
const TRACKED = [
  memberViewFrom('ws-ok', [reading('u1', 2.1, 1.6, 6, 2.4)]),            // 35 %  — ok
  memberViewFrom('ws-warn', [reading('u2', 3.6, 3.1, 6, 3.8)]),          // 60 %  — working set over the soft level ⇒ amber
  memberViewFrom('ws-crit', [reading('u3', 5.7, 5.5, 6, 5.8)]),          // 95 %  — bill AND working set (92 %) within 10 % of the hard level ⇒ red (#343: red keys on the working set)
  memberViewFrom('ws-cache', [reading('u4', 5.7, 1.2, 6, 5.8)]),         // #343: bill 95 % of the hard level but only 20 % working set (page cache) ⇒ NOT amber, NOT red
  memberViewFrom('ws-none', [reading('u5', 0.7, 0.6, null, null)]),      // tracked, no limit applied ⇒ uncapped (no bar)
  memberViewFrom('ws-nolimit', [{ ...reading('u7', 0.65, 0.5, null, null), limitApplied: false }]), // tracked, the kernel reports max ⇒ « No memory cap applied » (dim tooltip, no bar) — vs ws-none above: limit UNKNOWN ⇒ plain
  memberViewFrom('ws-gone', [reading('u6', 1.1, 0.4, 6, 1.2)]),          // session gone, scope left ⇒ scope-only row never carries a cap
];
const members = buildMemberMemoryReport(Date.now(), TRACKED, [], null, 0);
const { rows, login } = groupSnapshot({ sessions: SESSIONS, containers: undefined, members });
const rowsWs = rows.map((g) => ({ ...g, ws: WS[g.key] ?? null, fallbackName: g.key }));
const trace = [2, 4, 3, 6, 8, 5, 7, 4, 3, 5];
const LV = { softGb: 3, hardGb: 6 };
// ── #343 (D-pick B): the keeper-leaf room — chip from 70 %, tooltip line always, grey line; an unprotected member never gets a bar. SAME pipeline: ScopeReading → memberViewFrom → groupSnapshot → AgentsTable ──
const roomReading = (unit, kGb, extra = {}) => ({ unit, gen: 'a', currentBytes: 2.2 * GB, workingSetBytes: 1.5 * GB, maxBytes: 6 * GB, peakBytes: 2.4 * GB, keeperPid: 1, procs: [{ pid: 1, startTicks: 1, rssBytes: 1, role: 'cli', comm: 'claude' }], backstopBytes: 7 * GB, keeperLeaf: { currentBytes: kGb * GB, workingSetBytes: kGb * GB, oomKills: 0 }, scopeEpisodes: 0, ...extra });
const RWS = { 'ws-calm': ws('ws-calm', 'feat-calm'), 'ws-close': ws('ws-close', 'feat-close'), 'ws-over': ws('ws-over', 'feat-over'), 'ws-unprot': ws('ws-unprot', 'feat-unprotected'), 'ws-flat': ws('ws-flat', 'feat-noroom') };
const RSESS = ['ws-calm', 'ws-close', 'ws-over', 'ws-unprot', 'ws-flat'].map((id) => sdk(id, 700 * MB));
const RTRACKED = [
  memberViewFrom('ws-calm', [roomReading('r1', 0.41)]),                            // 41 % of the room — no chip, the tooltip still says it
  memberViewFrom('ws-close', [roomReading('r2', 0.9)]),                            // 90 % — amber chip
  memberViewFrom('ws-over', [roomReading('r3', 1.3)]),                             // 130 % — red chip (k alone fills the room)
  memberViewFrom('ws-unprot', [roomReading('r4', 0.2, { capState: 'unprotected' })]), // numeric limit, but the keeper says the tools are not in it ⇒ NO bar
  memberViewFrom('ws-flat', [roomReading('r5', 0.2, { backstopBytes: null, keeperLeaf: null })]), // no backstop ⇒ no margin to state
];
const rMembers = buildMemberMemoryReport(Date.now(), RTRACKED, [], null, 0);
const rGroup = groupSnapshot({ sessions: RSESS, containers: undefined, members: rMembers });
const rRows = rGroup.rows.map((g) => ({ ...g, ws: RWS[g.key] ?? null, fallbackName: g.key }));
const view = new URLSearchParams(location.search).get('view');
const root = createRoot(document.getElementById('root'));
if (view === 'room') {
  root.render(React.createElement('div', { style: { padding: 18, maxWidth: 1250 } }, React.createElement(AgentsTable, {
    rows: rRows, loginSessions: rGroup.login, traceOf: () => trace, diskOf: () => 120 * MB, ctxOf: () => 40000, accountLabelFor: () => null, warning: null,
    capLevels: LV, capLine: capSummaryLine(rRows.map((r) => ({ key: r.key, name: r.ws ? r.ws.branch : r.fallbackName, cap: r.cap, room: r.room }))),
  })));
} else if (view === 'table') {
  root.render(React.createElement('div', { style: { padding: 18, maxWidth: 1250 } }, React.createElement(AgentsTable, {
    rows: rowsWs, loginSessions: login, traceOf: () => trace, diskOf: () => 120 * MB, ctxOf: () => 40000, accountLabelFor: () => null, warning: null,
    capLevels: LV, capLine: capSummaryLine(rowsWs.map((r) => ({ key: r.key, name: r.ws ? r.ws.branch : r.fallbackName, cap: r.cap }))),
  })));
} else {
  const settings = { admissionGb: 6, criticalGb: 3, admissionEnabled: true, capSoftGb: 3, capHardGb: 6, reliquatWaitMin: 30 };
  const snapshot = { sampled: true, measured: true, availBytes: 11.4 * GB, readAt: 1, admission: 'open', admissionEnabled: true, pause: 'none', episode: 0, pauseCycle: 0, mayReleaseOneStart: true, heldSince: null, pauseSince: null, admissionBytes: 6 * GB, criticalBytes: 3 * GB, releaseMarginBytes: GB, sampleIntervalMs: 60000 };
  const MG_VIEW = { settings, snapshot, liveAvailBytes: 11.4 * GB, totalBytes: 32 * GB };
  const CAP_SW = { liveOn: false, runsOn: 1, runsOpen: 3, hostOk: true, text: 'Cap is OFF for new runs · ON on 1 of 3 open runs' };
  window.__MG_VIEW = MG_VIEW; window.__CAP_SW = CAP_SW; // what the window's own polling (memoryGuard / busCapSummary) gets back: the stub must answer with the REAL shapes, not []
  root.render(React.createElement(MemoryGuardSettings, { onClose: () => {}, initial: { view: { settings, snapshot, liveAvailBytes: 11.4 * GB, totalBytes: 32 * GB }, capSwitch: { liveOn: false, runsOn: 1, runsOpen: 3, hostOk: true, text: 'Cap is OFF for new runs · ON on 1 of 3 open runs' } } }));
}
document.title = 'memcap-' + view;
`);
const bundleJs = path.join(cacheDir, 'memcap-shot-page.js');
await build({ entryPoints: [entry], outfile: bundleJs, bundle: true, format: 'iife', platform: 'browser', jsx: 'automatic', loader: { '.css': 'empty' }, logLevel: 'silent' });
fs.writeFileSync(path.join(tmp, 'styles.css'), fs.readFileSync(path.join(repoRoot, 'src/renderer/styles.css'), 'utf8'));
fs.writeFileSync(path.join(tmp, 'page.js'), fs.readFileSync(bundleJs));
fs.writeFileSync(path.join(tmp, 'index.html'), `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="./styles.css">
<style>html,body{margin:0;height:100%;}#root{position:relative;min-height:100%;}</style></head><body><div id="root"></div>
<script>window.orchestra = new Proxy({ memoryGuard: async () => window.__MG_VIEW, busCapSummary: async () => window.__CAP_SW, setMemoryGuard: async () => ({ ok: true, view: window.__MG_VIEW }) }, { get: (t, k) => (k in t ? t[k] : String(k).startsWith('on') ? () => () => {} : async () => []) });</script>
<script src="./page.js"></script></body></html>`);

const electronBin = path.join(repoRoot, 'node_modules', 'electron', 'dist', 'electron');
const shotProbe = path.join(tmp, 'shot.cjs');
fs.writeFileSync(shotProbe, `
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const OUT = process.env.SHOT_DIR, PAGE = process.env.PAGE_DIR;
const results = [];
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
// every page script runs inside a try/catch that RETURNS the page's own error (Electron only says « Script failed to execute »): the failing probe is named, not guessed
async function ev(win, code) {
  const r = await win.webContents.executeJavaScript('(async () => { try { return { v: await (' + code + ') }; } catch (e) { return { err: String((e && e.stack) || e) }; } })()');
  if (r && r.err) throw new Error('page script threw: ' + r.err + ' :: ' + code.slice(0, 160));
  return r.v;
}
async function ready(win, sel) {
  for (let i = 0; i < 200; i++) {
    const ok = await ev(win, "(async () => { if (!document.querySelector(" + JSON.stringify(sel) + ")) return false; await document.fonts.ready; return document.fonts.status === 'loaded'; })()");
    if (ok) return;
    await wait(50);
  }
}
async function shoot(win, file, extra) {
  await wait(300);
  const img = await win.webContents.capturePage();
  fs.writeFileSync(path.join(OUT, file), img.toPNG());
  const probe = await ev(win, extra);
  const size = img.getSize();
  results.push({ file, width: size.width, height: size.height, ...probe });
}
const rectOf = "const rect = (el) => el ? (({ x, y, width, height }) => ({ x, y, width, height }))(el.getBoundingClientRect()) : null;";
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1300, height: 640, useContentSize: true, show: true, webPreferences: { offscreen: false } });
  try {
    await win.loadFile(path.join(PAGE, 'index.html'), { search: 'view=table' });
    await ready(win, '[data-res-cap]');
    await shoot(win, 'memcap-resources.png', "(() => { " + rectOf + " const bars = [...document.querySelectorAll('[data-res-cap]')].map((b) => { const q = (c) => b.querySelector(c); const cs = (el) => el ? getComputedStyle(el).backgroundColor : null; let a = b; while (a && !a.querySelector('.res-agent-branch')) a = a.parentElement; return { name: a ? a.querySelector('.res-agent-branch').textContent : '', pct: b.getAttribute('data-res-cap'), tone: b.getAttribute('data-res-cap-tone'), rect: rect(b), fill: cs(q('.res-capbar-fill')), fillOp: q('.res-capbar-fill') ? Number(getComputedStyle(q('.res-capbar-fill')).opacity) : null, wsOp: q('.res-capbar-ws') ? Number(getComputedStyle(q('.res-capbar-ws')).opacity) : null, fillW: rect(q('.res-capbar-fill'))?.width, ws: cs(q('.res-capbar-ws')), wsW: rect(q('.res-capbar-ws'))?.width, softX: rect(q('.res-capbar-soft'))?.x, title: b.getAttribute('title'), inMem: !!b.closest('.res-mem') }; }); const note = document.querySelector('[data-res-cap-note]'); const nocap = [...document.querySelectorAll('[data-res-nocap]')].map((c) => { let a = c; while (a && !a.querySelector('.res-agent-branch')) a = a.parentElement; const cs = getComputedStyle(c); return { name: a ? a.querySelector('.res-agent-branch').textContent : '', text: c.innerText.trim(), title: c.getAttribute('title'), tabIndex: c.tabIndex, role: c.getAttribute('role'), aria: c.getAttribute('aria-label'), decoLine: cs.textDecorationLine, decoStyle: cs.textDecorationStyle, cursor: cs.cursor, hasBar: !!c.querySelector('.res-capbar'), rect: rect(c) }; }); return { kind: 'table', nocap, bars, note: note ? { text: note.innerText, rect: rect(note), color: getComputedStyle(note).color } : null, memCells: document.querySelectorAll('.res-mem').length, scopeOnly: [...document.querySelectorAll('*')].filter((e) => e.children.length === 0 && /verifier-gone/.test(e.textContent)).length, text: document.body.innerText.replace(/\\\\s+/g, ' ') }; })()");
    // ── #343: the keeper-leaf room (D-pick B) + the unprotected cell ──
    await win.loadFile(path.join(PAGE, 'index.html'), { search: 'view=room' });
    await ready(win, '[data-res-room]');
    await shoot(win, 'memcap-room.png', "(() => { " + rectOf + " const rowOf = (el) => { let a = el; while (a && !a.querySelector('.res-agent-branch')) a = a.parentElement; return a; }; const nameOf = (el) => { const r = rowOf(el); return r ? r.querySelector('.res-agent-branch').textContent : ''; }; const chips = [...document.querySelectorAll('[data-res-room]')].map((c) => { const cs = getComputedStyle(c); const memCell = rowOf(c).querySelector('.res-mem, .res-mem-nocap'); return { name: nameOf(c), text: c.innerText.trim(), pct: c.getAttribute('data-res-room'), tone: c.getAttribute('data-res-room-tone'), title: c.getAttribute('title'), color: cs.color, border: cs.borderTopColor, rect: rect(c), memX: memCell ? rect(memCell).x : null }; }); const bars = [...document.querySelectorAll('[data-res-cap]')].map((b) => ({ name: nameOf(b), title: b.getAttribute('title'), tone: b.getAttribute('data-res-cap-tone') })); const unprot = [...document.querySelectorAll('[data-res-unprotected]')].map((c) => { const cs = getComputedStyle(c); return { name: nameOf(c), text: c.innerText.trim(), title: c.getAttribute('title'), tabIndex: c.tabIndex, role: c.getAttribute('role'), aria: c.getAttribute('aria-label'), decoLine: cs.textDecorationLine, decoStyle: cs.textDecorationStyle, decoColor: cs.textDecorationColor, cursor: cs.cursor, hasBar: !!c.querySelector('.res-capbar'), rect: rect(c) }; }); const note = document.querySelector('[data-res-cap-note]'); const rowNames = [...document.querySelectorAll('.res-agent-branch')].map((e) => e.textContent); return { kind: 'room', chips, bars, unprot, rowNames, note: note ? { text: note.innerText, color: getComputedStyle(note).color } : null }; })()");
    win.setContentSize(1440, 900);
    await wait(300);
    await win.loadFile(path.join(PAGE, 'index.html'), { search: 'view=window' });
    await ready(win, '[data-mg-cap-section]');
    await shoot(win, 'memcap-window.png', "(() => { " + rectOf + " const sec = document.querySelector('[data-mg-cap-section]'); const soft = document.querySelector('[data-mg-cap-soft]'), hard = document.querySelector('[data-mg-cap-hard]'), wait = document.querySelector('[data-mg-reliquat-wait]'), adm = document.querySelector('[data-mg-admission]'), crit = document.querySelector('[data-mg-critical]'); return { kind: 'window', sec: rect(sec), secTitleColor: getComputedStyle(sec.querySelector('.mg-section-title')).color, borderTop: getComputedStyle(sec).borderTopColor, soft: { v: soft.value, rect: rect(soft), dis: soft.disabled }, hard: { v: hard.value, rect: rect(hard), dis: hard.disabled }, wait: { v: wait.value, rect: rect(wait), dis: wait.disabled }, admY: rect(adm)?.y, critY: rect(crit)?.y, sw: document.querySelector('[data-mg-cap-switch]')?.getAttribute('data-mg-cap-switch'), swText: document.querySelector('[data-mg-cap-switch]')?.innerText, checkboxes: document.querySelectorAll('input[type=checkbox]').length, err: !!document.querySelector('[data-mg-error]'), text: sec.innerText.replace(/\\\\s+/g, ' ') }; })()");
    // type soft 7 > hard 6 and leave the field: the pair is REFUSED inline, nothing is sent (the stub would answer [] to a write)
    await ev(win, "(() => { const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; const el = document.querySelector('[data-mg-cap-soft]'); el.focus(); set.call(el, '7'); el.dispatchEvent(new Event('input', { bubbles: true })); el.blur(); })()");
    await wait(400);
    await shoot(win, 'memcap-window-refused.png', "(() => { " + rectOf + " const e = document.querySelector('[data-mg-error]'); const soft = document.querySelector('[data-mg-cap-soft]'); return { kind: 'refused', err: e ? { text: e.innerText, role: e.getAttribute('role'), rect: rect(e), color: getComputedStyle(e).color } : null, softV: soft.value, hardV: document.querySelector('[data-mg-cap-hard]').value }; })()");
    // ── the dialog must FIT (gate c/6112245304: at 1440x900 the window grew to 923 px in a 720 px max-height, clipping the Reliquat wait, the refusal and Done) ──
    const FIT = "(() => { const R = (el) => el ? (({ x, y, width, height }) => ({ x, y, width, height }))(el.getBoundingClientRect()) : null; const dlg = document.querySelector('[role=dialog]'), body = document.querySelector('[data-mg-body]'), done = [...document.querySelectorAll('[role=dialog] button')].find((b) => /Done/.test(b.textContent)), err = document.querySelector('[data-mg-error]'), waitEl = document.querySelector('[data-mg-reliquat-wait]'); const cs = body ? getComputedStyle(body) : null; return { kind: 'fit', vw: innerWidth, vh: innerHeight, dlg: R(dlg), body: R(body), bodyScroll: body ? { sh: body.scrollHeight, ch: body.clientHeight, oy: cs.overflowY } : null, done: R(done), doneInDialog: !!(done && dlg && dlg.contains(done)), err: R(err), errInBody: !!(err && body && body.contains(err)), wait: R(waitEl) }; })()";
    // The rig pins its output (HEADLESS-1 1600x1000) and tiles the window: setContentSize cannot make a 1920x1080 viewport. The viewport is IMPOSED through CDP (Emulation.setDeviceMetricsOverride) and the page's own
    // innerWidth/innerHeight are READ BACK and asserted equal to the request for every state — a proof at a size nobody measured would be empty (OPS review m3).
    const dbg = win.webContents.debugger;
    dbg.attach('1.3');
    const png = async () => Buffer.from((await dbg.sendCommand('Page.captureScreenshot', { format: 'png' })).data, 'base64');
    for (const [vw, vh] of [[1440, 900], [1920, 1080], [1280, 640]]) {
      await dbg.sendCommand('Emulation.setDeviceMetricsOverride', { width: vw, height: vh, deviceScaleFactor: 1, mobile: false });
      await wait(300);
      await win.loadFile(path.join(PAGE, 'index.html'), { search: 'view=window' });
      await ready(win, '[data-mg-cap-section]');
      await wait(300);
      fs.writeFileSync(path.join(OUT, 'memcap-window-' + vw + 'x' + vh + '.png'), await png());
      const rest = await ev(win, FIT);
      await ev(win, "document.querySelector('[data-mg-reliquat-wait]').scrollIntoView({ block: 'end' })");
      await wait(250);
      const scrolled = await ev(win, FIT);
      await ev(win, "(() => { const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; const el = document.querySelector('[data-mg-cap-soft]'); el.focus(); set.call(el, '7'); el.dispatchEvent(new Event('input', { bubbles: true })); el.blur(); })()");
      await wait(400);
      await wait(300);
      fs.writeFileSync(path.join(OUT, 'memcap-window-refused-' + vw + 'x' + vh + '.png'), await png());
      const refused = await ev(win, FIT);
      results.push({ kind: 'fits', vw, vh, rest, scrolled, refused, files: ['memcap-window-' + vw + 'x' + vh + '.png', 'memcap-window-refused-' + vw + 'x' + vh + '.png'] });
    }
    dbg.detach();
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
  execFileSync('env', ['-i', `HOME=${tmp}`, 'PATH=/usr/bin:/bin', `XDG_RUNTIME_DIR=${privateRuntimeDir()}`, `WAYLAND_DISPLAY=${rigWayland}`, 'ELECTRON_OZONE_PLATFORM_HINT=wayland', 'ELECTRON_DISABLE_SANDBOX=1', `SHOT_DIR=${outDir}`, `PAGE_DIR=${tmp}`, `PROBE_OUT=${probeOut}`, electronBin, '--no-sandbox', shotProbe], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 180000 });
} catch (e) { rc = e.status ?? 1; if (e.stderr) console.log(String(e.stderr).split('\n').slice(0, 15).join('\n')); }

let failures = 0;
const check = (label, ok, detail = '') => { if (ok) console.log(`  ok   ${label}`); else { failures++; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); } };
console.log('\n#323 D-Q10 A + A — the Plafond mémoire UI, under headless sway:');
if (!fs.existsSync(probeOut)) { console.log(`  FAIL the capture produced no output (electron rc=${rc})`); process.exit(1); }
const shots = JSON.parse(fs.readFileSync(probeOut, 'utf8'));
if (shots[0]?.error) { console.log(`  FAIL capture threw: ${shots[0].error}`); process.exit(1); }
const core = shots.filter((x) => x.kind !== 'fits' && !x.state);
check('four core captures (Resources table, keeper-leaf room, window, window refused)', core.length === 4, `got ${core.length}`);
const png = (s) => { const f = path.join(outDir, s.file); return fs.existsSync(f) ? decodePng(fs.readFileSync(f)) : null; };
for (const s of shots.filter((x) => x.file)) { const p = png(s); check(`${s.file}: PNG written, real dimensions, many colours (not a blank frame)`, !!p && s.width > 600 && s.height > 300 && distinctColours(p) > 30, `${s.width}x${s.height}, ${p ? distinctColours(p) : 0} colours`); }

const t = shots.find((s) => s.kind === 'table');
if (t) {
  const by = (needle) => t.bars.find((b) => (b.name ?? '').includes(needle));
  const ok = by('feat-comfortable'), warn = by('feat-warming'), crit = by('big-job'), cache = by('feat-cache');
  check('exactly FOUR rows carry a bar (comfortable, warming, big-job, cache); the uncapped and the scope-only rows carry none', t.bars.length === 4 && !!ok && !!warn && !!crit && !!cache, JSON.stringify(t.bars.map((b) => [b.name, b.pct, b.tone])));
  check('the bar sits INSIDE the MEM cell of its row', t.bars.every((b) => b.inMem));
  check('percentages are bill / hard: 35, 60, 95 and 95 %', ok?.pct === '35' && warn?.pct === '60' && crit?.pct === '95' && cache?.pct === '95', JSON.stringify(t.bars.map((b) => b.pct)));
  check('tones: comfortable ok, warming AMBER (working set 3.1 ≥ soft 3), big-job RED (working set 92 % ≥ 90 %), cache ok (bill 95 % of the hard level but working set 1.2 GB — page cache is not pressure: #343, was RED on master)', ok?.tone === 'ok' && warn?.tone === 'warn' && crit?.tone === 'crit' && cache?.tone === 'ok', JSON.stringify(t.bars.map((b) => b.tone)));
  check('the three tones are three DIFFERENT painted colours (accent / yellow / red), the working-set part SOLID over a translucent fill of the same colour (opacity tells them apart)', !!ok && !!warn && !!crit && new Set([ok.ws, warn.ws, crit.ws]).size === 3 && ok.fillOp !== null && ok.wsOp !== null && ok.fillOp < ok.wsOp, JSON.stringify([ok?.ws, warn?.ws, crit?.ws]));
  check('geometry: fill width = bill/hard of the track (35 % of the bar), the working-set part narrower than the fill, the soft tick at 50 %', !!ok && Math.abs(ok.fillW / ok.rect.width - 0.35) < 0.03 && ok.wsW < ok.fillW && Math.abs((ok.softX - ok.rect.x) / ok.rect.width - 0.5) < 0.03, JSON.stringify([ok?.fillW, ok?.rect, ok?.wsW, ok?.softX]));
  check('the track is THIN (a bar under the figure, not a second column): ≤ 6 px high, and only the four capped rows have a capped MEM cell', !!ok && ok.rect.height <= 6 && t.memCells === 4, JSON.stringify([ok?.rect, t.memCells]));
  check('the tooltip names both figures and what each compares to', !!ok && /kernel bill \(what the hard level compares\)/.test(ok.title) && /working set \(what the soft level compares\)/.test(ok.title) && /soft 3 GB \(settings now\)/.test(ok.title), ok?.title);
  check('#323-fu (m2): EXACTLY ONE member shows the « No memory cap applied » cell — feat-nolimit (limit read `max`); human-ws (limit unknown) and the capped rows do not', t.nocap.length === 1 && t.nocap[0].name === 'feat-nolimit', JSON.stringify(t.nocap.map((c) => c.name)));
  const nc = t.nocap[0];
  check('#323-fu (m2): that cell keeps its plain figure (650 MB), carries the dim tooltip, and has NO bar', !!nc && /^650 MB$|^0\.6[0-9] GB$|^6[0-9]{2} MB$/.test(nc.text) && /^No memory cap applied — the tool commands of this session run in a leaf with no limit/.test(nc.title) && nc.hasBar === false, JSON.stringify(nc));
  check('#323-fu (m2): the cue is RENDERED — dotted underline, help cursor — and the cell is focusable (tabIndex 0) with a role and an aria-label = figure + tip (a title alone is mouse-only)', !!nc && /underline/.test(nc.decoLine) && nc.decoStyle === 'dotted' && nc.cursor === 'help' && nc.tabIndex === 0 && nc.role === 'note' && /No memory cap applied/.test(nc.aria ?? ''), JSON.stringify(nc));
  check('the dim summary line sits under the table: « 4 capped members · closest: big-job 95 % of 6 GB »', !!t.note && /4 capped members · closest: big-job 95 % of 6(\.0)? GB/.test(t.note.text), JSON.stringify(t.note));
  const p = png(t);
  if (p && warn && crit && ok) {
    const px = (b, rgb, tol) => pixelsNear(crop(p, b.rect.x, b.rect.y, b.rect.width, b.rect.height), rgb, tol);
    const num = (s) => (s.match(/\d+/g) ?? []).slice(0, 3).map(Number);
    check('decoded pixels: the red bar really painted red, the amber one amber, the comfortable one neither', px(crit, num(crit.ws), 12) > 20 && px(warn, num(warn.ws), 12) > 20 && px(ok, num(crit.ws), 40) === 0 && px(ok, num(warn.ws), 40) === 0, JSON.stringify([px(crit, num(crit.ws), 12), px(warn, num(warn.ws), 12), px(ok, num(crit.ws), 40)]));
  }
}
// ── #343 (D-pick B): the keeper-leaf room on the page ──
const rm = shots.find((s) => s.kind === 'room');
if (rm) {
  const chip = (needle) => rm.chips.find((c) => c.name.includes(needle));
  const close = chip('feat-close'), over = chip('feat-over');
  check('the chip shows ONLY from 70 % of the room: feat-close (90 %) AMBER and feat-over (130 %) RED; feat-calm (41 %), feat-unprotected and feat-noroom have none', rm.chips.length === 2 && close?.tone === 'warn' && over?.tone === 'crit', JSON.stringify(rm.chips.map((c) => [c.name, c.pct, c.tone])));
  check('the chips read « k 0.9 GB / 1 GB room » and « k 1.3 GB / 1 GB room »', close?.text === 'k 0.9 GB / 1 GB room' && over?.text === 'k 1.3 GB / 1 GB room', JSON.stringify(rm.chips.map((c) => c.text)));
  check('the chip sits in the chips cell, LEFT of the MEM cell of its row, and is a small chip (≤ 20 px high)', !!close && !!over && close.rect.x + close.rect.width < close.memX && over.rect.x + over.rect.width < over.memX && close.rect.height <= 20 && over.rect.height <= 20, JSON.stringify([close?.rect, close?.memX]));
  check('painted COLOURS: amber chip is yellow, red chip is red, and they differ (computed colour + border)', !!close && !!over && close.color !== over.color && close.border !== over.border && /^rgb\(255, 200, 87\)$/.test(close.color) && /^rgb\(255, 107, 107\)$/.test(over.color), JSON.stringify([close?.color, over?.color, close?.border, over?.border]));
  check('the chip\'s title is the room sentence (red one says what red means)', !!close && !!over && /keeper \+ CLI 0\.9 GB of the 1 GB room above the tool level \(90 %\) — close to the room/.test(close.title) && /\(130 %\) — above the room: a full tool leaf would open a scope-level OOM/.test(over.title), JSON.stringify([close?.title, over?.title]));
  const calmBar = rm.bars.find((b) => b.name.includes('feat-calm'));
  check('the MEM tooltip of the CALM row (no chip) still says the room: 420 MB of the 1 GB room (41 %)', !!calmBar && /keeper \+ CLI 420 MB of the 1 GB room above the tool level \(41 %\)/.test(calmBar.title) && !/close to the room|above the room/.test(calmBar.title), calmBar?.title);
  const flatBar = rm.bars.find((b) => b.name.includes('feat-noroom'));
  check('a member with no margin (no backstop) keeps today\'s tooltip: no room sentence, no chip', !!flatBar && !/room above the tool level/.test(flatBar.title), flatBar?.title);
  check('the grey line under the table names the member with the least room', !!rm.note && /least room: feat-over 130 % of 1 GB/.test(rm.note.text), JSON.stringify(rm.note));
  const un = rm.unprot[0];
  check('#343 gap 2: EXACTLY ONE unprotected cell — feat-unprotected — and NO capped bar on that row (the numeric limit would have drawn one)', rm.unprot.length === 1 && !!un && un.name.includes('feat-unprotected') && !rm.bars.some((b) => b.name.includes('feat-unprotected')) && un.hasBar === false, JSON.stringify([rm.unprot.map((c) => c.name), rm.bars.map((b) => b.name)]));
  check('#343 gap 2: the cell keeps its plain figure (the scope bill, 2.2 GB), says « Memory cap NOT holding », is focusable with a role and an aria-label, and its cue is a dotted AMBER underline with a help cursor', !!un && /^2\.2\d* GB$/.test(un.text) && /^Memory cap NOT holding — /.test(un.title) && un.tabIndex === 0 && un.role === 'note' && /Memory cap NOT holding/.test(un.aria) && /underline/.test(un.decoLine) && un.decoStyle === 'dotted' && un.cursor === 'help' && /^rgb\(255, 200, 87\)$/.test(un.decoColor), JSON.stringify(un));
  const rp = png(rm);
  if (rp && close && over) {
    const num = (s) => (s.match(/\d+/g) ?? []).slice(0, 3).map(Number);
    const near = (c, rgb) => pixelsNear(crop(rp, c.rect.x, c.rect.y, c.rect.width, c.rect.height), rgb, 40);
    check('decoded pixels: the amber chip really painted amber (and no red), the red chip really painted red (and no amber)', near(close, num(close.color)) > 10 && near(over, num(over.color)) > 10 && near(close, num(over.color)) === 0 && near(over, num(close.color)) === 0, JSON.stringify([near(close, num(close.color)), near(over, num(over.color)), near(close, num(over.color)), near(over, num(close.color))]));
  }
  if (rp && un) check('decoded pixels: the unprotected cell\'s dotted underline painted amber', pixelsNear(crop(rp, un.rect.x, un.rect.y, un.rect.width, un.rect.height + 6), [255, 200, 87], 40) > 3, JSON.stringify(un.rect));
}
const w = shots.find((s) => s.kind === 'window');
if (w) {
  check('the section sits UNDER the existing thresholds (admission and critical fields are above it) with a rule above', w.sec.y > w.admY && w.sec.y > w.critY && /\d/.test(w.borderTop), JSON.stringify([w.sec.y, w.admY, w.critY]));
  check('soft 3, hard 6 GB and Reliquat wait 30 min are in their inputs, enabled, one row each below the title', w.soft.v === '3' && w.hard.v === '6' && w.wait.v === '30' && !w.soft.dis && !w.hard.dis && !w.wait.dis && w.soft.rect.y > w.sec.y && w.wait.rect.y > w.hard.rect.y - 4, JSON.stringify([w.soft, w.hard, w.wait]));
  check('the activation is SHOWN, read-only: « Cap is OFF for new runs · ON on 1 of 3 open runs », and the only checkbox in the window is the existing admission toggle', w.sw === 'off' && /Cap is OFF for new runs · ON on 1 of 3 open runs/.test(w.swText) && w.checkboxes === 1, JSON.stringify([w.sw, w.swText, w.checkboxes]));
  check('the section text says what each level does, where the switch is set, and that levels apply from the next member', /Warns the member and its coordinator when its working set crosses it\. No slowdown\./.test(w.text) && /set it in « Fleet bus mechanisms » \(the bus button in the header\), not here/.test(w.text) && /Applies to members started from now on/.test(w.text) && /Applied hot\./.test(w.text), w.text);
  check('nothing is refused at rest', !w.err);
}
const r = shots.find((s) => s.kind === 'refused');
if (r) {
  check('soft 7 > hard 6 is REFUSED inline: an alert line, red, and the stored values are not silently replaced', !!r.err && r.err.role === 'alert' && /soft/i.test(r.err.text) && /^rgb\(2[0-5]\d, [0-9]{2,3}, [0-9]{2,3}\)$/.test(r.err.color), JSON.stringify(r));
}
// ── the dialog FITS at every viewport (the built-app gate found 923 px in a 720 px dialog) ──
const inside = (r, vw, vh, eps = 0.75) => !!r && r.x >= -eps && r.y >= -eps && r.x + r.width <= vw + eps && r.y + r.height <= vh + eps;
const within = (r, o, eps = 0.75) => !!r && !!o && r.x >= o.x - eps && r.y >= o.y - eps && r.x + r.width <= o.x + o.width + eps && r.y + r.height <= o.y + o.height + eps;
const fits = shots.filter((x) => x.kind === 'fits');
check('three viewports probed: 1440x900, 1920x1080 and a SHORT 1280x640', fits.length === 3, `got ${fits.length}`);
for (const f of fits) {
  const tag = `${f.vw}x${f.vh}`;
  for (const [state, m] of [['at rest', f.rest], ['scrolled to the Reliquat wait', f.scrolled], ['refusal shown', f.refused]]) {
    check(`${tag} ${state}: the page's MEASURED viewport is exactly ${f.vw}x${f.vh} (innerWidth x innerHeight read back, not assumed)`, m.vw === f.vw && m.vh === f.vh, `measured ${m.vw}x${m.vh}`);
    check(`${tag} ${state}: the dialog is entirely inside the viewport`, inside(m.dlg, m.vw, m.vh), JSON.stringify([m.dlg, m.vw, m.vh]));
    check(`${tag} ${state}: DONE is inside the viewport and inside the dialog (always reachable)`, inside(m.done, m.vw, m.vh) && m.doneInDialog && within(m.done, m.dlg), JSON.stringify([m.done, m.dlg]));
  }
  check(`${tag}: the fields scroll INSIDE the dialog when they do not fit (overflow-y auto/scroll) — scrollHeight ${f.rest.bodyScroll?.sh} vs ${f.rest.bodyScroll?.ch}`, !!f.rest.bodyScroll && (f.rest.bodyScroll.sh <= f.rest.bodyScroll.ch + 1 || /auto|scroll/.test(f.rest.bodyScroll.oy)), JSON.stringify(f.rest.bodyScroll));
  check(`${tag}: scrolled to the end, the Reliquat wait is visible INSIDE the scrolling part and the viewport`, within(f.scrolled.wait, f.scrolled.body) && inside(f.scrolled.wait, f.scrolled.vw, f.scrolled.vh), JSON.stringify([f.scrolled.wait, f.scrolled.body]));
  check(`${tag}: the refusal line is visible (inside viewport and dialog) and sits OUTSIDE the scrolling part, so it can never scroll away`, !!f.refused.err && inside(f.refused.err, f.refused.vw, f.refused.vh) && within(f.refused.err, f.refused.dlg) && f.refused.errInBody === false, JSON.stringify([f.refused.err, f.refused.errInBody]));
  const refusedFile = path.join(outDir, f.files[1]);
  const pp = fs.existsSync(refusedFile) ? decodePng(fs.readFileSync(refusedFile)) : null;
  check(`${tag}: the refusal capture is a real ${f.vw}x${f.vh} frame (decoded dimensions)`, !!pp && pp.w === f.vw && pp.h === f.vh, pp ? `${pp.w}x${pp.h}` : 'no file');
  if (pp && f.refused.done) check(`${tag}: decoded pixels — the Done button is really painted in the refusal capture`, distinctColours(crop(pp, f.refused.done.x, f.refused.done.y, f.refused.done.width, f.refused.done.height)) > 2, JSON.stringify(f.refused.done));
}
console.log(`\nScreenshots: ${[...shots.filter((s) => s.file).map((s) => s.file), ...fits.flatMap((f) => f.files)].map((f) => path.join(outDir, f)).join('\n             ')}`);
fs.rmSync(tmp, { recursive: true, force: true });
if (failures) { console.log(`\nmemcap-screenshot: ${failures} FAILURE(S)`); process.exit(1); }
console.log('\nmemcap-screenshot: all checks passed');
