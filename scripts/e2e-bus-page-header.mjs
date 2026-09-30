// #253 — the fleet Bus page (and the Insights / Help overlays, same cause) must render fully BELOW the top toolbar.
//
// Boots a BUILT Orchestra (argv[2] = app dir) inside the contained rig's own headless sway, with
// a SCRATCH ORCHESTRA_HOME / HOME / CLAUDE_CONFIG_DIR, a seeded bus DB and one active workspace
// (the `.toolbar` only exists when a workspace is active), opens each page (bus | insights | help) with a
// TRUSTED click on its sidebar control, and asserts — at the enforced minimum window size and a typical one:
//   DOM     pane / first row rects vs the toolbar's bottom edge
//   HIT     elementFromPoint at the first row's centre lands in the row, not the toolbar
//   PIXELS  the first row's clip is identical with the toolbar painted and with it `visibility:hidden`
//           (a translucent toolbar over a row changes its pixels; rects alone cannot see a stacking cover)
// Positive controls (app identity, scratch containment, bus available, toolbar present, row painted)
// are separate clauses so a RED layout clause can only be blamed on layout.
//
// Usage (via scripts/e2e-bus-page-header.sh): <app-dir> --live-home <real $HOME> [--out dir]
//   [--label name] [--sizes min,typical,noworkspace] [--pages bus,insights,help] [--expect-red]
// Arms per page: min / typical (active workspace => a toolbar) and `noworkspace` (NO toolbar: the fix must not leave a dead strip).
// --out defaults to <rig dir>/shots (scratch); pass it explicitly to keep captures.
// --expect-red = the must-FAIL arm: exit 0 only if every layout clause is RED and every control GREEN.
import { execFileSync, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const APP_DIR = argv[0] && !argv[0].startsWith('--') ? fs.realpathSync(argv[0]) : null;
const LIVE_HOME = flag('--live-home', null);
const LABEL = flag('--label', APP_DIR ? path.basename(APP_DIR) : 'app');
const SIZES = flag('--sizes', 'min,typical,noworkspace').split(',');
const EXPECT_RED = argv.includes('--expect-red');
const PAGE_LIST = flag('--pages', 'bus,insights,help').split(',');

const refuse = (m) => { console.log(`REFUSED: ${m}`); process.exit(3); };
if (!APP_DIR) refuse('no <app-dir>');
if (!LIVE_HOME) refuse('--live-home missing (needed to protect the live ~/.claude* and to prove nothing there moved)');
const RIG_DIR = process.env.RIG_DIR;
const RIG_WAYLAND = process.env.RIG_WAYLAND;
if (!RIG_DIR || !RIG_WAYLAND) refuse('RIG_DIR / RIG_WAYLAND unset — run via scripts/e2e-bus-page-header.sh (the contained rig)');
if (process.env.DISPLAY) refuse(`X11 DISPLAY=${process.env.DISPLAY} is set — Electron would reach the human's screen`);
if (process.env.WAYLAND_DISPLAY !== RIG_WAYLAND || RIG_WAYLAND === 'wayland-1') refuse(`WAYLAND_DISPLAY=${process.env.WAYLAND_DISPLAY} != marker-verified ${RIG_WAYLAND}`);

const OUT = flag('--out', null) || path.join(RIG_DIR, 'shots'); // default = SCRATCH (inside the rig dir), never the live ~/.orchestra

// ── scratch-containment guard (live dirs are never handed to the app) ─────────────────────────────
const RIG_BASE = fs.realpathSync(path.dirname(RIG_DIR));
const liveReal = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
const LIVE_DIRS = [...fs.readdirSync(LIVE_HOME).filter((n) => n === '.claude' || n.startsWith('.claude-')).map((n) => path.join(LIVE_HOME, n)),
  path.join(LIVE_HOME, '.orchestra'), path.join(LIVE_HOME, '.config')].map(liveReal);
/** -> {ok, clause}. Live check FIRST so a live dir is refused for THAT reason, not merely "outside base". */
function checkScratch(p) {
  const r = liveReal(p);
  for (const l of LIVE_DIRS) if (r === l || r.startsWith(l + path.sep) || l.startsWith(r + path.sep)) return { ok: false, clause: 'live-dir' };
  if (!(r === RIG_BASE || r.startsWith(RIG_BASE + path.sep))) return { ok: false, clause: 'outside-rig-base' };
  return { ok: true, clause: 'scratch' };
}
const mustBeScratch = (what, p) => { const r = checkScratch(p); if (!r.ok) refuse(`${what}=${p} [${r.clause}]`); };
{ // the guard's own must-FAIL / must-PASS arms, each naming the clause that fired
  const a = checkScratch(path.join(LIVE_HOME, '.claude')), b = checkScratch('/tmp/not-in-the-rig'), c = checkScratch(path.join(RIG_DIR, 'x'));
  if (a.clause !== 'live-dir' || b.clause !== 'outside-rig-base' || !c.ok) refuse(`scratch guard self-test failed: ${JSON.stringify({ a, b, c })}`);
  console.log(`[guard] self-test: live ~/.claude -> ${a.clause} · /tmp path -> ${b.clause} · rig path -> ${c.clause}`);
}

// ── small helpers ─────────────────────────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const md5 = (b) => crypto.createHash('md5').update(b).digest('hex');
async function waitFor(fn, ms, what) {
  const t0 = Date.now(); let last;
  while (Date.now() - t0 < ms) { try { last = await fn(); if (last) return last; } catch (e) { last = e; } await sleep(150); }
  throw new Error(`timeout ${ms}ms waiting for ${what}${last instanceof Error ? `: ${last.message}` : ''}`);
}
const freePort = () => new Promise((res, rej) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); s.on('error', rej); });
const sh = (cmd, args, opt = {}) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opt });
const git = (cwd, args, home) => sh('git', ['-c', 'user.name=rig', '-c', 'user.email=rig@example.invalid', ...args], { cwd, env: { PATH: process.env.PATH, HOME: home, GIT_CONFIG_NOSYSTEM: '1' } });

// ── PNG decode (8-bit RGB/RGBA, non-interlaced — what Page.captureScreenshot emits) ──────────────
function decodePng(buf) {
  let pos = 8; const idat = []; let w, h, bd, ct, il;
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos), type = buf.toString('latin1', pos + 4, pos + 8), data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); bd = data[8]; ct = data[9]; il = data[12]; }
    else if (type === 'IDAT') idat.push(data); else if (type === 'IEND') break;
    pos += 12 + len;
  }
  if (bd !== 8 || il !== 0 || (ct !== 6 && ct !== 2)) throw new Error(`unsupported PNG bd=${bd} ct=${ct} il=${il}`);
  const ch = ct === 6 ? 4 : 3, stride = w * ch, raw = zlib.inflateSync(Buffer.concat(idat)), out = Buffer.alloc(stride * h);
  let prev = Buffer.alloc(stride), i = 0;
  for (let y = 0; y < h; y++) {
    const f = raw[i++], line = Buffer.from(raw.subarray(i, i + stride)); i += stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? line[x - ch] : 0, b = prev[x], c = x >= ch ? prev[x - ch] : 0;
      let add = 0;
      if (f === 1) add = a; else if (f === 2) add = b; else if (f === 3) add = (a + b) >> 1;
      else if (f === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); add = pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      line[x] = (line[x] + add) & 255;
    }
    line.copy(out, y * stride); prev = line;
  }
  return { w, h, ch, data: out };
}
/** pixels whose RGB differs by > tol on any channel. Same-size images only. */
function diffPx(A, B, tol = 6) {
  if (A.w !== B.w || A.h !== B.h || A.ch !== B.ch) throw new Error(`size mismatch ${A.w}x${A.h} vs ${B.w}x${B.h}`);
  let n = 0;
  for (let p = 0; p < A.w * A.h; p++) { const o = p * A.ch; if (Math.abs(A.data[o] - B.data[o]) > tol || Math.abs(A.data[o + 1] - B.data[o + 1]) > tol || Math.abs(A.data[o + 2] - B.data[o + 2]) > tol) n++; }
  return n;
}
/** sub-image [x,y,w,h] of a decoded PNG */
function crop(I, x, y, w, h) {
  const out = Buffer.alloc(w * h * I.ch);
  for (let r = 0; r < h; r++) I.data.copy(out, r * w * I.ch, ((y + r) * I.w + x) * I.ch, ((y + r) * I.w + x + w) * I.ch);
  return { w, h, ch: I.ch, data: out };
}
/** pixels that are not the clip's dominant colour = painted "ink" (text / borders / pills). */
function inkPx(I, tol = 6) {
  const cnt = new Map();
  for (let p = 0; p < I.w * I.h; p++) { const o = p * I.ch, k = (I.data[o] << 16) | (I.data[o + 1] << 8) | I.data[o + 2]; cnt.set(k, (cnt.get(k) || 0) + 1); }
  let mode = 0, best = -1; for (const [k, v] of cnt) if (v > best) { best = v; mode = k; }
  const mr = mode >> 16, mg = (mode >> 8) & 255, mb = mode & 255; let n = 0;
  for (let p = 0; p < I.w * I.h; p++) { const o = p * I.ch; if (Math.abs(I.data[o] - mr) > tol || Math.abs(I.data[o + 1] - mg) > tol || Math.abs(I.data[o + 2] - mb) > tol) n++; }
  return n;
}

// ── CDP ───────────────────────────────────────────────────────────────────────────────────────────
class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); ws.onmessage = (ev) => { const m = JSON.parse(ev.data); const p = m.id && this.pending.get(m.id); if (p) { this.pending.delete(m.id); m.error ? p.rej(new Error(`${m.error.message}`)) : p.res(m.result); } }; }
  static async connect(url) { const ws = new WebSocket(url); await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws error')); }); return new Cdp(ws); }
  send(method, params = {}, ms = 20000) {
    const id = ++this.id;
    return new Promise((res, rej) => { const t = setTimeout(() => { this.pending.delete(id); rej(new Error(`CDP ${method} timed out after ${ms}ms`)); }, ms); this.pending.set(id, { res: (v) => { clearTimeout(t); res(v); }, rej: (e) => { clearTimeout(t); rej(e); } }); this.ws.send(JSON.stringify({ id, method, params })); });
  }
  async eval(expr) { const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(`eval threw: ${r.exceptionDetails.text} ${r.exceptionDetails.exception?.description ?? ''}`); return r.result.value; }
  async click(x, y) { for (const [type, extra] of [['mouseMoved', {}], ['mousePressed', { button: 'left', clickCount: 1 }], ['mouseReleased', { button: 'left', clickCount: 1 }]]) { await this.send('Input.dispatchMouseEvent', { type, x, y, ...extra }); await sleep(60); } }
  async shot(clip) { const r = await this.send('Page.captureScreenshot', { format: 'png', ...(clip ? { clip: { ...clip, scale: 1 } } : {}) }, 25000); return Buffer.from(r.data, 'base64'); }
  close() { try { this.ws.close(); } catch {} }
}

// ── seeding: a real git repo + registered worktree (prune deletes what it cannot verify), the PINNED
//    scratch account, a stub `claude` (never the API), and a bus DB written by the real bus module ──
const TITLE = 'BUS253 first run — row must be visible';
function seedWorld(armDir, opt = {}) {
  const fakeHome = path.join(armDir, 'home'), ohome = path.join(armDir, 'oh'), cfg = path.join(armDir, 'claude-config');
  const repoDir = path.join(armDir, 'repo'), wtDir = path.join(armDir, 'wt', 'b253-1');
  for (const d of [fakeHome, ohome, cfg, repoDir, path.dirname(wtDir)]) fs.mkdirSync(d, { recursive: true });
  for (const [k, v] of Object.entries({ HOME: fakeHome, ORCHESTRA_HOME: ohome, CLAUDE_CONFIG_DIR: cfg, repo: repoDir, wt: wtDir })) mustBeScratch(k, v);
  git(repoDir, ['init', '-q', '-b', 'main'], fakeHome);
  fs.writeFileSync(path.join(repoDir, 'README.md'), '# b253 seed repo\n');
  git(repoDir, ['add', '.'], fakeHome); git(repoDir, ['commit', '-q', '-m', 'seed'], fakeHome);
  git(repoDir, ['worktree', 'add', '-q', '-b', 'e2e/b253-1', wtDir], fakeHome);
  if (!git(repoDir, ['worktree', 'list', '--porcelain'], fakeHome).includes(`worktree ${fs.realpathSync(wtDir)}`)) throw new Error('seed worktree not registered');
  const account = { id: 'rig-b253', label: 'rig (scratch config dir)', configDir: cfg };
  mustBeScratch('account.configDir', account.configDir);
  const ws = { id: 'ws-b253-1', name: 'b253-1', repoPath: repoDir, worktreePath: wtDir, branch: 'e2e/b253-1', baseBranch: 'main', createdAt: Date.now(), status: 'idle', agent: 'claude', accountId: account.id };
  const dir = path.join(ohome, 'userData', 'orchestra'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'store.json'), JSON.stringify({ repos: [{ path: repoDir, name: 'b253-repo', defaultBranch: 'main', accountId: account.id }], workspaces: opt.noWs ? [] : [ws], accounts: [account], selfTuneRuns: [] }, null, 2));
  const stubDir = path.join(armDir, 'stub-bin'); fs.mkdirSync(stubDir, { recursive: true });
  fs.writeFileSync(path.join(stubDir, 'claude'), '#!/bin/sh\necho B253-STUB-CLAUDE "$@"\nsleep 3600\n', { mode: 0o755 });
  return { fakeHome, ohome, cfg, account, ws, stubDir };
}

let seedBundle = null;
async function seedBus(ohome) {
  if (!seedBundle) {
    const { build } = (() => { try { return require_('esbuild'); } catch { const g = fs.globSync?.(repoRoot + '/node_modules/.pnpm/esbuild@*/node_modules/esbuild') ?? []; if (!g.length) throw new Error('esbuild not resolvable'); return require_(g[0]); } })();
    const cache = path.join(repoRoot, 'node_modules', '.cache'); fs.mkdirSync(cache, { recursive: true });
    const entry = path.join(cache, 'bus253-seed-entry.ts');
    fs.writeFileSync(entry, `export { openBus, busPath, send, openGate } from ${JSON.stringify(path.join(repoRoot, 'src/main/bus.ts'))};\nexport { startRun } from ${JSON.stringify(path.join(repoRoot, 'src/main/bus-runs.ts'))};\nexport { DEFAULT_BUS_SWITCHES } from ${JSON.stringify(path.join(repoRoot, 'src/shared/bus-switches.ts'))};\n`);
    seedBundle = path.join(cache, 'bus253-seed.cjs');
    await build({ entryPoints: [entry], outfile: seedBundle, bundle: true, format: 'cjs', platform: 'node', external: ['electron', 'better-sqlite3', 'node-pty'], logLevel: 'silent' });
  }
  const runner = path.join(path.dirname(seedBundle), 'bus253-seed-run.cjs');
  fs.writeFileSync(runner, `
const m = require(${JSON.stringify(seedBundle)});
const db = m.openBus(m.busPath());
const sw = { ...m.DEFAULT_BUS_SWITCHES };
m.startRun(db, { id: 'mission-b253', kind: 'mission', coordinator: 'lead-b253', title: ${JSON.stringify(TITLE)} }, sw);
m.startRun(db, { id: 'vague-b253', kind: 'vague', coordinator: 'ops-b253', parentRunId: 'mission-b253', title: 'Wave D — pause + bus page' }, sw);
const kinds = ['dispatch', 'status', 'status', 'escalation', 'status', 'dispatch'];
for (let i = 0; i < 14; i++) m.send(db, { runId: 'vague-b253', sender: i % 2 ? 'impl-b253' : 'ops-b253', recipient: i % 3 ? null : 'ops-b253', kind: kinds[i % kinds.length], body: 'b253 message ' + (i + 1) + ' — seeded row so the page overflows at the minimum window size' });
m.openGate(db, 'vague-b253', 'impl-b253', 'b253 gate — who owns the header offset?');
db.close();
console.log('SEEDED ' + m.busPath());
`);
  const out = sh(path.join(APP_DIR, 'node_modules/electron/dist/electron'), [runner], { env: { PATH: process.env.PATH, HOME: path.dirname(ohome), ORCHESTRA_HOME: ohome, ELECTRON_RUN_AS_NODE: '1' } });
  if (!out.includes(`SEEDED ${path.join(ohome, 'bus.sqlite')}`)) throw new Error(`bus seeding did not report the scratch path: ${out}`);
  return out.trim();
}

// ── one arm: boot → click the Bus button → measure → capture → tear down ─────────────────────────
function readMin() {
  const f = fs.readdirSync(path.join(APP_DIR, 'dist-electron')).filter((n) => n.endsWith('.js'));
  for (const n of f) { const s = fs.readFileSync(path.join(APP_DIR, 'dist-electron', n), 'utf8'); const m = s.match(/minWidth:\s*(\d+),\s*minHeight:\s*(\d+)/); if (m) return { w: +m[1], h: +m[2], file: n }; }
  throw new Error('minWidth/minHeight not found in the built main bundle');
}
const MIN = readMin();
const SIZE = { min: { w: MIN.w, h: MIN.h }, typical: { w: 1400, h: 900 }, noworkspace: { w: 1400, h: 900, noWs: true } };

const PAGES = {
  bus: { root: '.bus-pane', open: '[aria-label="Open the fleet bus page"]', ready: '.bus-pane[data-bus-state="available"] .bus-run-row', close: null, seed: true },
  insights: { root: '.insights-view', open: '.insights-row', ready: '.insights-view', close: '[aria-label="Close Insights"]', seed: false },
  help: { root: '.help-view', open: '[aria-label="Help — feature guide"]', ready: '.help-view', close: '[aria-label="Close help"]', seed: false },
};
for (const pg of PAGE_LIST) if (!PAGES[pg]) { console.log(`REFUSED: unknown page ${pg}`); process.exit(3); }

const measureExpr = (P) => `(() => {
  const R = (el) => { if (!el) return null; const b = el.getBoundingClientRect(); return { top: b.top, bottom: b.bottom, left: b.left, right: b.right, width: b.width, height: b.height }; };
  const tb = document.querySelector('.toolbar'), pane = document.querySelector(${JSON.stringify(P.root)});
  const first = pane && pane.firstElementChild, runRow = pane && pane.querySelector('.bus-run-row'), closeEl = ${P.close ? `document.querySelector(${JSON.stringify(P.close)})` : 'null'};
  const hit = (el, edge) => { if (!el) return null; const b = el.getBoundingClientRect(); const x = edge ? b.left + 12 : b.left + Math.min(b.width / 2, 200), y = edge ? b.top + 3 : b.top + b.height / 2; const h = document.elementFromPoint(x, y);
    return { x, y, tag: h ? h.tagName.toLowerCase() + (h.className && typeof h.className === 'string' ? '.' + h.className.trim().split(/\\s+/)[0] : '') : null, inside: !!(h && el.contains(h)), inToolbar: !!(h && h.closest('.toolbar')) }; };
  return { inner: { w: innerWidth, h: innerHeight }, dpr: devicePixelRatio, toolbar: R(tb), pane: R(pane), paneZ: pane ? getComputedStyle(pane).zIndex : null, toolbarZ: tb ? getComputedStyle(tb).zIndex : null,
    first: R(first), firstClass: first ? first.className : null, runRow: R(runRow), runRowText: runRow ? runRow.textContent.trim().slice(0, 80) : null, close: R(closeEl), closeHit: hit(closeEl, false),
    main: R(document.querySelector('main.main')), firstHit: hit(first, true), firstHitMid: hit(first, false), runRowHit: hit(runRow, false), titleInDom: document.body.innerText.includes(${JSON.stringify(TITLE)}), busState: pane ? pane.getAttribute('data-bus-state') : null, scrollTop: pane ? pane.scrollTop : null };
})()`;

function listProcsByHome(home) { // identity = /proc/<pid>/environ carrying THIS arm's ORCHESTRA_HOME
  const out = [];
  for (const p of fs.readdirSync('/proc').filter((n) => /^\d+$/.test(n))) {
    try { const env = fs.readFileSync(`/proc/${p}/environ`, 'utf8').split('\0'); if (env.includes(`ORCHESTRA_HOME=${home}`)) out.push(+p); } catch {}
  }
  return out.filter((p) => p !== process.pid);
}

const results = []; // {arm, clause, ok, detail}
const shots = []; // {file, md5}
function clause(arm, name, ok, detail) { results.push({ arm, clause: name, ok: !!ok, detail }); console.log(`  ${ok ? 'PASS' : 'FAIL'}  [${arm}] ${name} — ${detail}`); }
function saveShot(name, buf) { fs.mkdirSync(OUT, { recursive: true }); const f = path.join(OUT, name); fs.writeFileSync(f, buf); shots.push({ file: f, md5: md5(buf) }); return f; }

async function runArm(page, sizeName) {
  const P = PAGES[page], key = page === 'bus' ? sizeName : `${page}-${sizeName}`; // bus keeps its original arm/file names
  const { w, h } = SIZE[sizeName]; const arm = `${LABEL}/${key}`;
  console.log(`\n== arm ${arm}: output ${w}x${h} ==`);
  const armDir = path.join(RIG_DIR, `arm-${LABEL}-${key}`);
  fs.mkdirSync(armDir, { recursive: true });
  const noWs = !!SIZE[sizeName].noWs;
  const world = seedWorld(armDir, { noWs });
  if (P.seed) console.log(`  seeded: ${await seedBus(world.ohome)}`);
  sh('swaymsg', ['output', 'HEADLESS-1', 'resolution', `${w}x${h}`]);
  sh('swaymsg', ['default_border', 'none']);
  const port = await freePort();
  const env = { PATH: `${world.stubDir}:/usr/local/bin:/usr/bin:/bin`, HOME: world.fakeHome, XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR, XDG_CONFIG_HOME: path.join(world.fakeHome, '.config'), XDG_CACHE_HOME: path.join(world.fakeHome, '.cache'),
    WAYLAND_DISPLAY: RIG_WAYLAND, SWAYSOCK: process.env.SWAYSOCK, ELECTRON_OZONE_PLATFORM_HINT: 'wayland', ORCHESTRA_OZONE: 'wayland', ORCHESTRA_OZONE_RELAUNCHED: '1',
    ORCHESTRA_HOME: world.ohome, ORCHESTRA_DEBUG_PORT: String(port), ORCHESTRA_SELF_TUNE_CMD: '/bin/true', CLAUDE_CONFIG_DIR: world.cfg, LANG: 'C.UTF-8' };
  for (const k of ['HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'ORCHESTRA_HOME', 'CLAUDE_CONFIG_DIR']) mustBeScratch(`env.${k}`, env[k]);
  if ('DISPLAY' in env || env.WAYLAND_DISPLAY !== RIG_WAYLAND) refuse('child env would reach the human display');
  const logFile = path.join(armDir, 'app.log');
  const fd = fs.openSync(logFile, 'w');
  const app = spawn(path.join(APP_DIR, 'node_modules/electron/dist/electron'), [APP_DIR, '--ozone-platform=wayland'], { cwd: APP_DIR, env, stdio: ['ignore', fd, fd], detached: true });
  console.log(`  app pid ${app.pid} port ${port} log ${logFile}`);
  let cdp;
  try {
    const target = await waitFor(async () => { const r = await fetch(`http://127.0.0.1:${port}/json`); const t = (await r.json()).find((x) => x.type === 'page' && x.url.includes('dist/index.html')); return t || null; }, 60000, 'the app page target');
    clause(arm, 'ctl/app-identity-path', target.url.includes(APP_DIR) && !target.url.includes('app.asar'), `target url ${target.url} ⊇ ${APP_DIR}`);
    cdp = await Cdp.connect(target.webSocketDebuggerUrl);
    await cdp.send('Page.enable');
    await waitFor(() => cdp.eval(`${noWs ? 'true' : '!!document.querySelector(".toolbar")'} && !!document.querySelector(${JSON.stringify(P.open)})`), 60000, noWs ? `the ${page} control (no workspace)` : `toolbar + the ${page} control (an ACTIVE workspace)`);
    // identity: the bundle the page executes is byte-identical to the one in APP_DIR/dist
    const src = await cdp.eval(`[...document.querySelectorAll('script[src]')].map((s) => s.src)`);
    const bundle = src.find((s) => /assets\/index-.*\.js/.test(s));
    const onDisk = bundle && path.join(APP_DIR, 'dist', bundle.split('/dist/')[1]);
    const frameId = (await cdp.send('Page.getResourceTree')).frameTree.frame.id;
    const rc_ = await cdp.send('Page.getResourceContent', { frameId, url: bundle });
    const served = Buffer.from(rc_.content, rc_.base64Encoded ? 'base64' : 'utf8');
    const ver = JSON.parse(fs.readFileSync(path.join(APP_DIR, 'package.json'), 'utf8')).version;
    clause(arm, 'ctl/app-identity-bundle', !!onDisk && fs.existsSync(onDisk) && md5(served) === md5(fs.readFileSync(onDisk)), `renderer bundle ${path.basename(bundle || '?')} as served md5 ${md5(served)} == file in app dir md5 ${onDisk && fs.existsSync(onDisk) ? md5(fs.readFileSync(onDisk)) : 'n/a'} (package.json ${ver})`);
    // containment read back OUT of the running app's environ
    const environ = fs.readFileSync(`/proc/${app.pid}/environ`, 'utf8').split('\0');
    const ev = (k) => (environ.find((e) => e.startsWith(k + '=')) || '').slice(k.length + 1);
    clause(arm, 'ctl/scratch-env', ev('ORCHESTRA_HOME') === world.ohome && ev('CLAUDE_CONFIG_DIR') === world.cfg && ev('HOME') === world.fakeHome && !environ.some((e) => e.startsWith('DISPLAY=')) && ev('WAYLAND_DISPLAY') === RIG_WAYLAND,
      `app environ: ORCHESTRA_HOME=${ev('ORCHESTRA_HOME')} CLAUDE_CONFIG_DIR=${ev('CLAUDE_CONFIG_DIR')} WAYLAND_DISPLAY=${ev('WAYLAND_DISPLAY')} DISPLAY=${ev('DISPLAY') || '<unset>'}`);
    const tree = sh('swaymsg', ['-t', 'get_tree']);
    clause(arm, 'ctl/app-in-my-sway', new RegExp(`"pid":\\s*${app.pid}\\b`).test(tree), `app pid ${app.pid} present in my sway's get_tree`);

    // pre-state, trusted click, post-state
    const OPEN = JSON.stringify(P.open), ROOT = JSON.stringify(P.root);
    const pre = await cdp.eval(`({ pane: !!document.querySelector(${ROOT}), pressed: document.querySelector(${OPEN}).getAttribute('aria-pressed') })`);
    const btn = await cdp.eval(`(() => { const b = document.querySelector(${OPEN}).getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2, inView: b.top >= 0 && b.bottom <= innerHeight && b.left >= 0 && b.right <= innerWidth }; })()`);
    if (!btn.inView) throw new Error(`${page} control not inside the viewport at ${w}x${h}: ${JSON.stringify(btn)}`);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: btn.x, y: btn.y });
    await cdp.click(btn.x, btn.y);
    await waitFor(() => cdp.eval(`!!document.querySelector(${JSON.stringify(P.ready)})`), 30000, `the ${page} page`);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: h - 5 }); // park the cursor (no :hover residue)
    await sleep(800); // settle: 2 s poll has fired at least the first snapshot; fonts
    await cdp.eval(`document.fonts.ready.then(() => true)`);
    const post = await cdp.eval(`({ pane: !!document.querySelector(${ROOT}), pressed: document.querySelector(${OPEN}).getAttribute('aria-pressed') })`);
    clause(arm, 'ctl/pre-post-state', !pre.pane && post.pane && (pre.pressed === null || (pre.pressed === 'false' && post.pressed === 'true')), `${page} page ${pre.pane}->${post.pane}, aria-pressed ${pre.pressed}->${post.pressed} (null = control has none)`);

    const M = await cdp.eval(measureExpr(P));
    console.log(`  measured: ${JSON.stringify({ inner: M.inner, dpr: M.dpr, toolbar: M.toolbar, pane: M.pane, paneZ: M.paneZ, toolbarZ: M.toolbarZ, first: M.first, firstClass: M.firstClass, runRow: M.runRow, main: M.main })}`);
    const minish = sizeName === 'min' ? (M.inner.w <= w + 4 && M.inner.h <= h + 4) : (M.inner.w >= 1300 && M.inner.h >= 800);
    clause(arm, 'ctl/window-size', minish, `viewport ${M.inner.w}x${M.inner.h} for target ${w}x${h} (${sizeName}; min enforced by the build = ${MIN.w}x${MIN.h} in ${MIN.file})`);
    if (page === 'bus') clause(arm, 'ctl/bus-available', M.busState === 'available' && M.titleInDom && !!M.runRow, `data-bus-state=${M.busState}; seeded run title in DOM=${M.titleInDom}; first run row="${M.runRowText}"`);
    else clause(arm, 'ctl/page-rendered', !!M.pane && !!M.first && M.first.height > 20 && (!P.close || !!M.close), `${P.root} present, first child .${M.firstClass} ${M.first?.width}x${M.first?.height}, close control ${P.close ? (M.close ? 'present' : 'ABSENT') : 'n/a'}`);
    const fmtHit = (x) => `elementFromPoint(${x?.x},${x?.y}) = ${x?.tag} (inside row=${x?.inside}, inside toolbar=${x?.inToolbar})`;
    let dFirst = null, dRun = null, rows = null;
    const full = await cdp.shot();
    const fullFile = saveShot(`${LABEL}-${key}-renderer.png`, full);
    // composed-window oracle: compositor capture, taken BEFORE any clipped Page.captureScreenshot (a clipped capture
    // leaves the compositor on a stale clip-sized frame for a moment — measured: a "typical" grim showed one run row at 0,0).
    const grimFile = path.join(OUT, `${LABEL}-${key}-compositor.png`);
    fs.mkdirSync(OUT, { recursive: true });
    sh('grim', ['-o', 'HEADLESS-1', grimFile], { env: { PATH: '/usr/bin:/bin', XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR, WAYLAND_DISPLAY: RIG_WAYLAND } });
    shots.push({ file: grimFile, md5: md5(fs.readFileSync(grimFile)) });
    const grim = decodePng(fs.readFileSync(grimFile)), rend = decodePng(full);
    // cross-instrument control: the composed window must show what the renderer painted (same size, same first-row pixels),
    // else the compositor frame is stale/blank and every "screenshot" claim below it is void.
    const fr = M.first, cr = { x: Math.max(0, Math.floor(fr.left)), y: Math.max(0, Math.floor(fr.top)), w: Math.floor(Math.min(fr.width, M.inner.w - fr.left)), h: Math.floor(fr.height) };
    const dComp = diffPx(crop(grim, cr.x, cr.y, cr.w, cr.h), crop(rend, cr.x, cr.y, cr.w, cr.h), 24);
    clause(arm, 'ctl/compositor-frame-is-the-page', grim.w === rend.w && grim.h === rend.h && inkPx(crop(grim, cr.x, cr.y, cr.w, cr.h)) > 40 && dComp <= cr.w * cr.h * 0.02,
      `grim ${grim.w}x${grim.h} vs renderer ${rend.w}x${rend.h}; first-row crop ${cr.w}x${cr.h}: ${inkPx(crop(grim, cr.x, cr.y, cr.w, cr.h))} ink px, ${dComp} px differ from the renderer's (<= 2%)`);
    console.log(`  shots: ${fullFile}, ${grimFile}`);
    if (noWs) {
      // GUARD arm (must be green on every build): with NO active workspace there is no toolbar, so the page must
      // still fill <main> — an unconditional `top: 48px` would leave a dead strip showing the welcome screen.
      clause(arm, 'ctl/toolbar-absent', M.toolbar === null, `.toolbar element: ${M.toolbar === null ? 'absent' : JSON.stringify(M.toolbar)} (this arm is the no-workspace case)`);
      clause(arm, 'G1/pane-fills-main-without-toolbar', !!M.pane && !!M.main && Math.abs(M.pane.top - M.main.top) < 0.5 && Math.abs(M.pane.bottom - M.main.bottom) < 0.5, `${P.root} ${M.pane?.top}..${M.pane?.bottom} vs main ${M.main?.top}..${M.main?.bottom}`);
      clause(arm, 'G2/first-row-visible-without-toolbar', !!M.firstHit && M.firstHit.inside, fmtHit(M.firstHit));
      if (P.close) clause(arm, 'G3/close-button-reachable-without-toolbar', !!M.closeHit && M.closeHit.inside, `close control ${fmtHit(M.closeHit)}`);
    } else {
      clause(arm, 'ctl/toolbar-present', !!M.toolbar && M.toolbar.height >= 40, `.toolbar ${JSON.stringify(M.toolbar)} (an active workspace shows the header the page must clear)`);
      // ── layout clauses (the ones that must be RED on a pre-fix build) ──
      const tbB = M.toolbar ? M.toolbar.bottom : NaN;
      clause(arm, 'L1/pane-starts-below-toolbar', M.pane && M.pane.top >= tbB - 0.5, `${P.root}.top=${M.pane?.top} >= toolbar.bottom=${tbB}`);
      clause(arm, 'L2/first-row-below-toolbar', M.first && M.first.top >= tbB - 0.5, `first row (.${M.firstClass}) top=${M.first?.top} >= toolbar.bottom=${tbB}; first run row top=${M.runRow?.top}`);
      clause(arm, 'L3/first-row-not-covered-hit-test', !!M.firstHit && M.firstHit.inside && !M.firstHit.inToolbar, `top-edge probe ${fmtHit(M.firstHit)}; mid-row probe ${fmtHit(M.firstHitMid)}`);
      clause(arm, 'L5/first-row-inside-viewport', M.first && M.first.top >= 0 && M.first.bottom <= M.inner.h, `first row ${M.first?.top}..${M.first?.bottom} within 0..${M.inner.h}`);
      if (P.close) clause(arm, 'L6/close-button-reachable', !!M.closeHit && M.closeHit.inside && !M.closeHit.inToolbar, `close control ${fmtHit(M.closeHit)}`);
      // ── pixels ──
      const clipOf = (R) => ({ x: Math.max(0, Math.floor(R.left)), y: Math.max(0, Math.floor(R.top)), width: Math.ceil(Math.min(R.width, M.inner.w - Math.max(0, R.left))), height: Math.ceil(R.height) });
      rows = { first: clipOf(M.first), ...(M.runRow ? { runRow: clipOf(M.runRow) } : {}) };
      const withTb = {}; for (const [k, c] of Object.entries(rows)) withTb[k] = decodePng(await cdp.shot(c));
      await cdp.eval(`(() => { const s = document.createElement('style'); s.id = 'b253-hide-toolbar'; s.textContent = '.toolbar { visibility: hidden !important; }'; document.head.appendChild(s); return true; })()`);
      await sleep(400);
      const hiddenFull = await cdp.shot(); saveShot(`${LABEL}-${key}-renderer-toolbar-hidden.png`, hiddenFull);
      const noTb = {}; for (const [k, c] of Object.entries(rows)) noTb[k] = decodePng(await cdp.shot(c));
      await cdp.eval(`document.getElementById('b253-hide-toolbar').remove()`);
      dFirst = diffPx(withTb.first, noTb.first); dRun = rows.runRow ? diffPx(withTb.runRow, noTb.runRow) : null;
      clause(arm, 'ctl/pixels-first-row-painted', inkPx(noTb.first) > 40, `${inkPx(noTb.first)} ink pixels in the first row's ${rows.first.width}x${rows.first.height} clip (must be >40: a zero diff over a blank clip proves nothing)`);
      if (rows.runRow) clause(arm, 'ctl/pixels-run-row-painted', inkPx(noTb.runRow) > 40, `${inkPx(noTb.runRow)} ink pixels in the first run row's clip`);
      clause(arm, 'L4/first-row-pixels-unoccluded', dFirst === 0, `${dFirst} px of the first row's ${rows.first.width}x${rows.first.height} clip change when the toolbar is hidden (0 = nothing paints over it); run row: ${dRun} px`);
    }

    fs.writeFileSync(path.join(OUT, `${LABEL}-${key}-measure.json`), JSON.stringify({ M, dFirst, dRun, rows }, null, 2));
  } catch (e) {
    clause(arm, 'rig/arm-completed', false, `ARM ABORTED: ${e.stack || e}`);
  } finally {
    cdp?.close();
    // tear down: the app's process group, then anything still carrying THIS arm's ORCHESTRA_HOME (keeper + stub claude outlive the app by design)
    try { process.kill(-app.pid, 'SIGTERM'); } catch {}
    await sleep(2000);
    try { process.kill(-app.pid, 'SIGKILL'); } catch {}
    for (const p of listProcsByHome(world.ohome)) { try { process.kill(p, 'SIGKILL'); } catch {} }
    await sleep(500);
    const left = listProcsByHome(world.ohome);
    clause(arm, 'rig/teardown-no-survivors', left.length === 0, `processes still carrying ${world.ohome}: ${left.length ? left.join(',') : 'none'}`);
  }
}

// ── live-dir canary: independent tool (find) + json, before/after ─────────────────────────────────
function liveCanary() {
  const snap = {};
  for (const d of fs.readdirSync(LIVE_HOME).filter((n) => n === '.claude' || n.startsWith('.claude-')).map((n) => path.join(LIVE_HOME, n))) {
    let links = ''; try { links = sh('find', [d, '-maxdepth', '1', '-type', 'l', '-printf', '%f->%l\\n']).split('\n').sort().join('|'); } catch {}
    let mcp = ''; for (const f of [path.join(d, '.claude.json'), path.join(LIVE_HOME, '.claude.json')]) { try { mcp += Object.keys(JSON.parse(fs.readFileSync(f, 'utf8')).mcpServers || {}).sort().join(',') + ';'; } catch {} }
    snap[d] = md5(links) + ':' + md5(mcp) + ` (${links.split('|').filter(Boolean).length} symlinks)`;
  }
  return snap;
}

// ── main ──────────────────────────────────────────────────────────────────────────────────────────
const before = liveCanary();
console.log(`[rig] app ${APP_DIR} label ${LABEL} pages ${PAGE_LIST.join(',')} sizes ${SIZES.join(',')} expect-red=${EXPECT_RED} out=${OUT}`);
console.log(`[rig] min window enforced by THIS build: ${MIN.w}x${MIN.h} (${MIN.file})`);
for (const pg of PAGE_LIST) for (const s of SIZES) await runArm(pg, s);
const after = liveCanary();
const same = JSON.stringify(before) === JSON.stringify(after);
clause('rig', 'ctl/live-claude-dirs-untouched', same, `${Object.keys(before).length} live ~/.claude* dirs, symlink-set + mcpServers hashes ${same ? 'identical before/after' : 'CHANGED: ' + JSON.stringify({ before, after })}`);

// ── verdict ───────────────────────────────────────────────────────────────────────────────────────
const isLayout = (c) => /^L\d\//.test(c.clause), isControl = (c) => !isLayout(c);
const ctlRed = results.filter((c) => isControl(c) && !c.ok), layoutRed = results.filter((c) => isLayout(c) && !c.ok), layoutAll = results.filter(isLayout);
console.log('\n== shots (md5) ==');
for (const s of shots) console.log(`  ${s.md5}  ${s.file}`);
const dup = shots.length - new Set(shots.map((s) => s.md5)).size;
console.log(`  duplicates among captures: ${dup}`);
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, `${LABEL}-result.json`), JSON.stringify({ app: APP_DIR, label: LABEL, results, shots }, null, 2));
let verdict, rc;
if (EXPECT_RED) {
  // must-FAIL arm: the layout clauses L1-L4 are all red at every size AND no control is red
  const needRed = layoutAll.filter((c) => /^L[1-46]\//.test(c.clause));
  const allRed = needRed.length > 0 && needRed.every((c) => !c.ok);
  ({ verdict, rc } = ctlRed.length === 0 && allRed ? { verdict: `EXPECTED-RED CONFIRMED: ${needRed.length}/${needRed.length} layout clauses red (${[...new Set(needRed.map((c) => c.clause))].join(', ')}), all controls green`, rc: 0 } : { verdict: `EXPECTED-RED NOT MET: layout red ${layoutRed.length}/${needRed.length}; controls red: ${ctlRed.map((c) => `${c.arm} ${c.clause}`).join('; ') || 'none'}`, rc: 1 });
} else {
  ({ verdict, rc } = ctlRed.length === 0 && layoutRed.length === 0 ? { verdict: `ALL GREEN: ${results.length} clauses (${layoutAll.length} layout, ${results.length - layoutAll.length} control)`, rc: 0 } : { verdict: `RED: ${results.filter((c) => !c.ok).map((c) => `${c.arm} ${c.clause}`).join('; ')}`, rc: 1 });
}
console.log(`\nVERDICT: ${verdict}`);
process.exit(rc);
