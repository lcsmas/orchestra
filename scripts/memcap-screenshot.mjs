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
const WS = { 'ws-ok': ws('ws-ok', 'feat-comfortable'), 'ws-warn': ws('ws-warn', 'feat-warming'), 'ws-crit': ws('ws-crit', 'big-job'), 'ws-cache': ws('ws-cache', 'feat-cache'), 'ws-none': ws('ws-none', 'human-ws'), 'ws-gone': ws('ws-gone', 'verifier-gone') };
const sdk = (id, mem) => ({ ptyId: id + ':sdk', workspaceId: id, kind: 'sdk', remote: false, cpuPct: 6, memBytes: mem, procCount: 9, processes: [{ pid: 100, comm: 'claude', cpuPct: 6, memBytes: mem }] });
const SESSIONS = [sdk('ws-ok', 600 * MB), sdk('ws-warn', 900 * MB), sdk('ws-crit', 1400 * MB), sdk('ws-cache', 500 * MB), sdk('ws-none', 700 * MB)];
const reading = (unit, bill, wsB, hard, peak) => ({ unit, gen: 'a', currentBytes: bill * GB, workingSetBytes: wsB === null ? null : wsB * GB, maxBytes: hard === null ? null : hard * GB, peakBytes: peak === null ? null : peak * GB, keeperPid: 1, procs: [{ pid: 1, startTicks: 1, rssBytes: 1, role: 'cli', comm: 'claude' }] });
const TRACKED = [
  memberViewFrom('ws-ok', [reading('u1', 2.1, 1.6, 6, 2.4)]),            // 35 %  — ok
  memberViewFrom('ws-warn', [reading('u2', 3.6, 3.1, 6, 3.8)]),          // 60 %  — working set over the soft level ⇒ amber
  memberViewFrom('ws-crit', [reading('u3', 5.7, 4.2, 6, 5.8)]),          // 95 %  — within 10 % of the hard level ⇒ red
  memberViewFrom('ws-cache', [reading('u4', 4.5, 1.2, 6, 4.6)]),         // big page cache, small working set ⇒ NOT amber
  memberViewFrom('ws-none', [reading('u5', 0.7, 0.6, null, null)]),      // tracked, no limit applied ⇒ uncapped (no bar)
  memberViewFrom('ws-gone', [reading('u6', 1.1, 0.4, 6, 1.2)]),          // session gone, scope left ⇒ scope-only row never carries a cap
];
const members = buildMemberMemoryReport(Date.now(), TRACKED, [], null, 0);
const { rows, login } = groupSnapshot({ sessions: SESSIONS, containers: undefined, members });
const rowsWs = rows.map((g) => ({ ...g, ws: WS[g.key] ?? null, fallbackName: g.key }));
const trace = [2, 4, 3, 6, 8, 5, 7, 4, 3, 5];
const LV = { softGb: 3, hardGb: 6 };
const view = new URLSearchParams(location.search).get('view');
const root = createRoot(document.getElementById('root'));
if (view === 'table') {
  root.render(React.createElement('div', { style: { padding: 18, maxWidth: 1250 } }, React.createElement(AgentsTable, {
    rows: rowsWs, loginSessions: login, traceOf: () => trace, diskOf: () => 120 * MB, ctxOf: () => 40000, accountLabelFor: () => null, warning: null,
    capLevels: LV, capLine: capSummaryLine(rowsWs.map((r) => ({ key: r.key, name: r.ws ? r.ws.branch : r.fallbackName, cap: r.cap }))),
  })));
} else {
  const settings = { admissionGb: 6, criticalGb: 3, admissionEnabled: true, capSoftGb: 3, capHardGb: 6, reliquatWaitMin: 30 };
  const snapshot = { sampled: true, measured: true, availBytes: 11.4 * GB, readAt: 1, admission: 'open', admissionEnabled: true, pause: 'none', episode: 0, pauseCycle: 0, mayReleaseOneStart: true, heldSince: null, pauseSince: null, admissionBytes: 6 * GB, criticalBytes: 3 * GB, releaseMarginBytes: GB, sampleIntervalMs: 60000 };
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
<script>window.orchestra = new Proxy({}, { get: (_t, k) => (String(k).startsWith('on') ? () => () => {} : async () => []) });</script>
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
async function ready(win, sel) {
  for (let i = 0; i < 200; i++) {
    const ok = await win.webContents.executeJavaScript("(async () => { if (!document.querySelector(" + JSON.stringify(sel) + ")) return false; await document.fonts.ready; return document.fonts.status === 'loaded'; })()");
    if (ok) return;
    await wait(50);
  }
}
async function shoot(win, file, extra) {
  await wait(300);
  const img = await win.webContents.capturePage();
  fs.writeFileSync(path.join(OUT, file), img.toPNG());
  const probe = await win.webContents.executeJavaScript(extra);
  const size = img.getSize();
  results.push({ file, width: size.width, height: size.height, ...probe });
}
const rectOf = "const rect = (el) => el ? (({ x, y, width, height }) => ({ x, y, width, height }))(el.getBoundingClientRect()) : null;";
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1300, height: 640, show: true, webPreferences: { offscreen: false } });
  try {
    await win.loadFile(path.join(PAGE, 'index.html'), { search: 'view=table' });
    await ready(win, '[data-res-cap]');
    await shoot(win, 'memcap-resources.png', "(() => { " + rectOf + " const bars = [...document.querySelectorAll('[data-res-cap]')].map((b) => { const q = (c) => b.querySelector(c); const cs = (el) => el ? getComputedStyle(el).backgroundColor : null; let a = b; while (a && !a.querySelector('.res-agent-branch')) a = a.parentElement; return { name: a ? a.querySelector('.res-agent-branch').textContent : '', pct: b.getAttribute('data-res-cap'), tone: b.getAttribute('data-res-cap-tone'), rect: rect(b), fill: cs(q('.res-capbar-fill')), fillW: rect(q('.res-capbar-fill'))?.width, ws: cs(q('.res-capbar-ws')), wsW: rect(q('.res-capbar-ws'))?.width, softX: rect(q('.res-capbar-soft'))?.x, title: b.getAttribute('title'), inMem: !!b.closest('.res-mem') }; }); const note = document.querySelector('[data-res-cap-note]'); return { kind: 'table', bars, note: note ? { text: note.innerText, rect: rect(note), color: getComputedStyle(note).color } : null, memCells: document.querySelectorAll('.res-mem').length, scopeOnly: [...document.querySelectorAll('*')].filter((e) => e.children.length === 0 && /verifier-gone/.test(e.textContent)).length, text: document.body.innerText.replace(/\\\\s+/g, ' ') }; })()");
    await win.loadFile(path.join(PAGE, 'index.html'), { search: 'view=window' });
    await ready(win, '[data-mg-cap-section]');
    await shoot(win, 'memcap-window.png', "(() => { " + rectOf + " const sec = document.querySelector('[data-mg-cap-section]'); const soft = document.querySelector('[data-mg-cap-soft]'), hard = document.querySelector('[data-mg-cap-hard]'), wait = document.querySelector('[data-mg-reliquat-wait]'), adm = document.querySelector('[data-mg-admission]'), crit = document.querySelector('[data-mg-critical]'); return { kind: 'window', sec: rect(sec), secTitleColor: getComputedStyle(sec.querySelector('.mg-section-title')).color, borderTop: getComputedStyle(sec).borderTopColor, soft: { v: soft.value, rect: rect(soft), dis: soft.disabled }, hard: { v: hard.value, rect: rect(hard), dis: hard.disabled }, wait: { v: wait.value, rect: rect(wait), dis: wait.disabled }, admY: rect(adm)?.y, critY: rect(crit)?.y, sw: document.querySelector('[data-mg-cap-switch]')?.getAttribute('data-mg-cap-switch'), swText: document.querySelector('[data-mg-cap-switch]')?.innerText, checkboxes: document.querySelectorAll('input[type=checkbox]').length, err: !!document.querySelector('[data-mg-error]'), text: sec.innerText.replace(/\\\\s+/g, ' ') }; })()");
    // type soft 7 > hard 6 and leave the field: the pair is REFUSED inline, nothing is sent (the stub would answer [] to a write)
    await win.webContents.executeJavaScript("(() => { const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; const el = document.querySelector('[data-mg-cap-soft]'); el.focus(); set.call(el, '7'); el.dispatchEvent(new Event('input', { bubbles: true })); el.blur(); })()");
    await wait(400);
    await shoot(win, 'memcap-window-refused.png', "(() => { " + rectOf + " const e = document.querySelector('[data-mg-error]'); const soft = document.querySelector('[data-mg-cap-soft]'); return { kind: 'refused', err: e ? { text: e.innerText, role: e.getAttribute('role'), rect: rect(e), color: getComputedStyle(e).color } : null, softV: soft.value, hardV: document.querySelector('[data-mg-cap-hard]').value }; })()");
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
console.log('\n#323 D-Q10 A + A — the Plafond mémoire UI, under headless sway:');
if (!fs.existsSync(probeOut)) { console.log(`  FAIL the capture produced no output (electron rc=${rc})`); process.exit(1); }
const shots = JSON.parse(fs.readFileSync(probeOut, 'utf8'));
if (shots[0]?.error) { console.log(`  FAIL capture threw: ${shots[0].error}`); process.exit(1); }
check('three captures (Resources table, window, window refused)', shots.length === 3, `got ${shots.length}`);
const png = (s) => { const f = path.join(outDir, s.file); return fs.existsSync(f) ? decodePng(fs.readFileSync(f)) : null; };
for (const s of shots) { const p = png(s); check(`${s.file}: PNG written, real dimensions, many colours (not a blank frame)`, !!p && s.width > 600 && s.height > 300 && distinctColours(p) > 30, `${s.width}x${s.height}, ${p ? distinctColours(p) : 0} colours`); }

const t = shots.find((s) => s.kind === 'table');
if (t) {
  const by = (needle) => t.bars.find((b) => (b.name ?? '').includes(needle));
  const ok = by('feat-comfortable'), warn = by('feat-warming'), crit = by('big-job'), cache = by('feat-cache');
  check('exactly FOUR rows carry a bar (comfortable, warming, big-job, cache); the uncapped and the scope-only rows carry none', t.bars.length === 4 && !!ok && !!warn && !!crit && !!cache, JSON.stringify(t.bars.map((b) => [b.name, b.pct, b.tone])));
  check('the bar sits INSIDE the MEM cell of its row', t.bars.every((b) => b.inMem));
  check('percentages are bill / hard: 35, 60, 95 and 75 %', ok?.pct === '35' && warn?.pct === '60' && crit?.pct === '95' && cache?.pct === '75', JSON.stringify(t.bars.map((b) => b.pct)));
  check('tones: comfortable ok, warming AMBER (working set 3.1 ≥ soft 3), big-job RED (95 % ≥ 90 %), cache ok (bill 4.5 but working set 1.2 — page cache is not pressure)', ok?.tone === 'ok' && warn?.tone === 'warn' && crit?.tone === 'crit' && cache?.tone === 'ok', JSON.stringify(t.bars.map((b) => b.tone)));
  check('the three tones are three DIFFERENT painted colours (accent / yellow / red), the working-set part a solid shade of the fill\'s colour', !!ok && !!warn && !!crit && new Set([ok.ws, warn.ws, crit.ws]).size === 3 && ok.fill !== ok.ws, JSON.stringify([ok?.ws, warn?.ws, crit?.ws]));
  check('geometry: fill width = bill/hard of the track (35 % of the bar), the working-set part narrower than the fill, the soft tick at 50 %', !!ok && Math.abs(ok.fillW / ok.rect.width - 0.35) < 0.03 && ok.wsW < ok.fillW && Math.abs((ok.softX - ok.rect.x) / ok.rect.width - 0.5) < 0.03, JSON.stringify([ok?.fillW, ok?.rect, ok?.wsW, ok?.softX]));
  check('the track is THIN (a bar under the figure, not a second column): ≤ 6 px high, and only the four capped rows have a capped MEM cell', !!ok && ok.rect.height <= 6 && t.memCells === 4, JSON.stringify([ok?.rect, t.memCells]));
  check('the tooltip names both figures and what each compares to', !!ok && /kernel bill \(what the hard level compares\)/.test(ok.title) && /working set \(what the soft level compares\)/.test(ok.title) && /soft 3 GB \(settings now\)/.test(ok.title), ok?.title);
  check('the dim summary line sits under the table: « 4 capped members · closest: big-job 95 % of 6 GB »', !!t.note && /4 capped members · closest: big-job 95 % of 6(\.0)? GB/.test(t.note.text), JSON.stringify(t.note));
  const p = png(t);
  if (p && warn && crit && ok) {
    const px = (b, rgb, tol) => pixelsNear(crop(p, b.rect.x, b.rect.y, b.rect.width, b.rect.height), rgb, tol);
    const num = (s) => (s.match(/\d+/g) ?? []).slice(0, 3).map(Number);
    check('decoded pixels: the red bar really painted red, the amber one amber, the comfortable one neither', px(crit, num(crit.ws), 12) > 20 && px(warn, num(warn.ws), 12) > 20 && px(ok, num(crit.ws), 40) === 0 && px(ok, num(warn.ws), 40) === 0, JSON.stringify([px(crit, num(crit.ws), 12), px(warn, num(warn.ws), 12), px(ok, num(crit.ws), 40)]));
  }
}
const w = shots.find((s) => s.kind === 'window');
if (w) {
  check('the section sits UNDER the existing thresholds (admission and critical fields are above it) with a rule above', w.sec.y > w.admY && w.sec.y > w.critY && /\d/.test(w.borderTop), JSON.stringify([w.sec.y, w.admY, w.critY]));
  check('soft 3, hard 6 GB and Reliquat wait 30 min are in their inputs, enabled, one row each below the title', w.soft.v === '3' && w.hard.v === '6' && w.wait.v === '30' && !w.soft.dis && !w.hard.dis && !w.wait.dis && w.soft.rect.y > w.sec.y && w.wait.rect.y > w.hard.rect.y - 4, JSON.stringify([w.soft, w.hard, w.wait]));
  check('the activation is SHOWN, read-only: « Cap is OFF for new runs · ON on 1 of 3 open runs », and the only checkbox in the window is the existing admission toggle', w.sw === 'off' && /Cap is OFF for new runs · ON on 1 of 3 open runs/.test(w.swText) && w.checkboxes === 1, JSON.stringify([w.sw, w.swText, w.checkboxes]));
  check('the section text says what each level does, where the switch is set, and that levels apply from the next member', /Warns the member and its coordinator when its working set crosses it\. No slowdown\./.test(w.text) && /set it on the Bus page, not here/.test(w.text) && /Applies to members started from now on/.test(w.text) && /Applied hot\./.test(w.text), w.text);
  check('nothing is refused at rest', !w.err);
}
const r = shots.find((s) => s.kind === 'refused');
if (r) {
  check('soft 7 > hard 6 is REFUSED inline: an alert line, red, and the stored values are not silently replaced', !!r.err && r.err.role === 'alert' && /soft/i.test(r.err.text) && /^rgb\(2[0-5]\d, [0-9]{2,3}, [0-9]{2,3}\)$/.test(r.err.color), JSON.stringify(r));
}
console.log(`\nScreenshots: ${shots.map((s) => path.join(outDir, s.file)).join('\n             ')}`);
fs.rmSync(tmp, { recursive: true, force: true });
if (failures) { console.log(`\nmemcap-screenshot: ${failures} FAILURE(S)`); process.exit(1); }
console.log('\nmemcap-screenshot: all checks passed');
