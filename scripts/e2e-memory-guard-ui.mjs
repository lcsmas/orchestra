// #285 — memory guard Settings modal (mockup A / D-pick1), driven in a BUILT Orchestra (argv[2] = app dir) inside the contained rig's
// own headless sway, scratch ORCHESTRA_HOME / HOME / CLAUDE_CONFIG_DIR. The memory source is the REAL /proc/meminfo: the held / critical
// states are reached by moving the THRESHOLDS around the live MemAvailable through the real UI (typing + Enter / blur), which is also
// the "hot" proof — no restart, no timer wait. Every UI state is cross-read from three independent surfaces:
//   DOM (chip tone/text, inputs, error row, gauge)  ·  the REAL built CLI `bus-status` `memory:` line over the app's socket
//   ·  the scratch store.json + orchestra.log on disk  ·  a renderer screenshot (+ compositor capture for the first two states)
// Positive controls: app identity (bundle md5), scratch env read back out of the running app, app present in MY sway, live reading
// agrees with an independent /proc/meminfo read. Nothing here holds a start (this track holds none) — the app's memory Pause is only
// a STATE here, so the scratch app pauses nothing.
//
// Usage (via scripts/e2e-memory-guard-ui.sh): <app-dir> --live-home <real $HOME> [--out dir] [--label name]
import { execFileSync, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import zlib from 'node:zlib';

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const APP_DIR = argv[0] && !argv[0].startsWith('--') ? fs.realpathSync(argv[0]) : null;
const LIVE_HOME = flag('--live-home', null);
const LABEL = flag('--label', APP_DIR ? path.basename(APP_DIR) : 'app');
const refuse = (m) => { console.log(`REFUSED: ${m}`); process.exit(3); };
if (!APP_DIR) refuse('no <app-dir>');
if (!LIVE_HOME) refuse('--live-home missing');
const RIG_DIR = process.env.RIG_DIR;
const RIG_WAYLAND = process.env.RIG_WAYLAND;
if (!RIG_DIR || !RIG_WAYLAND) refuse('RIG_DIR / RIG_WAYLAND unset — run via scripts/e2e-memory-guard-ui.sh (the contained rig)');
if (process.env.DISPLAY) refuse(`X11 DISPLAY=${process.env.DISPLAY} is set — Electron would reach the human's screen`);
if (process.env.WAYLAND_DISPLAY !== RIG_WAYLAND || RIG_WAYLAND === 'wayland-1') refuse(`WAYLAND_DISPLAY=${process.env.WAYLAND_DISPLAY} != marker-verified ${RIG_WAYLAND}`);
const OUT = flag('--out', null) || path.join(RIG_DIR, 'shots');

// ── scratch-containment guard ─────────────────────────────────────────────────────────────────────────────────────────
const RIG_BASE = fs.realpathSync(path.dirname(RIG_DIR));
const liveReal = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
const LIVE_DIRS = [...fs.readdirSync(LIVE_HOME).filter((n) => n === '.claude' || n.startsWith('.claude-')).map((n) => path.join(LIVE_HOME, n)), path.join(LIVE_HOME, '.orchestra'), path.join(LIVE_HOME, '.config')].map(liveReal);
function checkScratch(p) {
  const r = liveReal(p);
  for (const l of LIVE_DIRS) if (r === l || r.startsWith(l + path.sep) || l.startsWith(r + path.sep)) return { ok: false, clause: 'live-dir' };
  if (!(r === RIG_BASE || r.startsWith(RIG_BASE + path.sep))) return { ok: false, clause: 'outside-rig-base' };
  return { ok: true, clause: 'scratch' };
}
const mustBeScratch = (what, p) => { const r = checkScratch(p); if (!r.ok) refuse(`${what}=${p} [${r.clause}]`); };
{
  const a = checkScratch(path.join(LIVE_HOME, '.claude')), b = checkScratch('/tmp/not-in-the-rig'), c = checkScratch(path.join(RIG_DIR, 'x'));
  if (a.clause !== 'live-dir' || b.clause !== 'outside-rig-base' || !c.ok) refuse(`scratch guard self-test failed: ${JSON.stringify({ a, b, c })}`);
  console.log(`[guard] self-test: live ~/.claude -> ${a.clause} · /tmp path -> ${b.clause} · rig path -> ${c.clause}`);
}

// ── helpers ───────────────────────────────────────────────────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const md5 = (b) => crypto.createHash('md5').update(b).digest('hex');
async function waitFor(fn, ms, what) {
  const t0 = Date.now(); let last;
  while (Date.now() - t0 < ms) { try { last = await fn(); if (last) return last; } catch (e) { last = e; } await sleep(120); }
  throw new Error(`timeout ${ms}ms waiting for ${what}${last instanceof Error ? `: ${last.message}` : ''}`);
}
const freePort = () => new Promise((res, rej) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); s.on('error', rej); });
const sh = (cmd, args, opt = {}) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opt });
const git = (cwd, args, home) => sh('git', ['-c', 'user.name=rig', '-c', 'user.email=rig@example.invalid', ...args], { cwd, env: { PATH: process.env.PATH, HOME: home, GIT_CONFIG_NOSYSTEM: '1' } });
const meminfo = (k) => Number(new RegExp(`^${k}:\\s+(\\d+)\\s+kB`, 'm').exec(fs.readFileSync('/proc/meminfo', 'utf8'))?.[1]) / 1048576; // GiB

function decodePng(buf) {
  let pos = 8; const idat = []; let w, h, bd, ct, il;
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos), type = buf.toString('latin1', pos + 4, pos + 8), data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); bd = data[8]; ct = data[9]; il = data[12]; } else if (type === 'IDAT') idat.push(data); else if (type === 'IEND') break;
    pos += 12 + len;
  }
  if (bd !== 8 || il !== 0 || (ct !== 6 && ct !== 2)) throw new Error(`unsupported PNG bd=${bd} ct=${ct} il=${il}`);
  const ch = ct === 6 ? 4 : 3, stride = w * ch, raw = zlib.inflateSync(Buffer.concat(idat)), out = Buffer.alloc(stride * h);
  let prev = Buffer.alloc(stride), i = 0;
  for (let y = 0; y < h; y++) {
    const f = raw[i++], line = Buffer.from(raw.subarray(i, i + stride)); i += stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? line[x - ch] : 0, b = prev[x], c = x >= ch ? prev[x - ch] : 0; let add = 0;
      if (f === 1) add = a; else if (f === 2) add = b; else if (f === 3) add = (a + b) >> 1; else if (f === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); add = pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      line[x] = (line[x] + add) & 255;
    }
    line.copy(out, y * stride); prev = line;
  }
  return { w, h, ch, data: out };
}
function crop(I, x, y, w, h) { const out = Buffer.alloc(w * h * I.ch); for (let r = 0; r < h; r++) I.data.copy(out, r * w * I.ch, ((y + r) * I.w + x) * I.ch, ((y + r) * I.w + x + w) * I.ch); return { w, h, ch: I.ch, data: out }; }
function inkPx(I, tol = 6) {
  const cnt = new Map();
  for (let p = 0; p < I.w * I.h; p++) { const o = p * I.ch, k = (I.data[o] << 16) | (I.data[o + 1] << 8) | I.data[o + 2]; cnt.set(k, (cnt.get(k) || 0) + 1); }
  let mode = 0, best = -1; for (const [k, v] of cnt) if (v > best) { best = v; mode = k; }
  const mr = mode >> 16, mg = (mode >> 8) & 255, mb = mode & 255; let n = 0;
  for (let p = 0; p < I.w * I.h; p++) { const o = p * I.ch; if (Math.abs(I.data[o] - mr) > tol || Math.abs(I.data[o + 1] - mg) > tol || Math.abs(I.data[o + 2] - mb) > tol) n++; }
  return n;
}

class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); ws.onmessage = (ev) => { const m = JSON.parse(ev.data); const p = m.id && this.pending.get(m.id); if (p) { this.pending.delete(m.id); m.error ? p.rej(new Error(`${m.error.message}`)) : p.res(m.result); } }; }
  static async connect(url) { const ws = new WebSocket(url); await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws error')); }); return new Cdp(ws); }
  send(method, params = {}, ms = 20000) { const id = ++this.id; return new Promise((res, rej) => { const t = setTimeout(() => { this.pending.delete(id); rej(new Error(`CDP ${method} timed out after ${ms}ms`)); }, ms); this.pending.set(id, { res: (v) => { clearTimeout(t); res(v); }, rej: (e) => { clearTimeout(t); rej(e); } }); this.ws.send(JSON.stringify({ id, method, params })); }); }
  async eval(expr) { const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(`eval threw: ${r.exceptionDetails.text} ${r.exceptionDetails.exception?.description ?? ''}`); return r.result.value; }
  async click(x, y) { for (const [type, extra] of [['mouseMoved', {}], ['mousePressed', { button: 'left', clickCount: 1 }], ['mouseReleased', { button: 'left', clickCount: 1 }]]) { await this.send('Input.dispatchMouseEvent', { type, x, y, ...extra }); await sleep(60); } }
  async key(key, code, vk) { for (const type of ['rawKeyDown', 'keyUp']) await this.send('Input.dispatchKeyEvent', { type, key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk }); }
  async shot() { const r = await this.send('Page.captureScreenshot', { format: 'png' }, 25000); return Buffer.from(r.data, 'base64'); }
  close() { try { this.ws.close(); } catch {} }
}

const results = [];
const shots = [];
function clause(name, ok, detail) { results.push({ clause: name, ok: !!ok, detail }); console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name} — ${detail}`); }
function saveShot(name, buf) { fs.mkdirSync(OUT, { recursive: true }); const f = path.join(OUT, name); fs.writeFileSync(f, buf); shots.push({ file: f, md5: md5(buf) }); return f; }

// ── world: a registered scratch repo (no workspace needed — the sidebar header always renders), a stub `claude` ─────────
function seedWorld(armDir) {
  const fakeHome = path.join(armDir, 'home'), ohome = path.join(armDir, 'oh'), cfg = path.join(armDir, 'claude-config'), repoDir = path.join(armDir, 'repo');
  for (const d of [fakeHome, ohome, cfg, repoDir]) fs.mkdirSync(d, { recursive: true });
  for (const [k, v] of Object.entries({ HOME: fakeHome, ORCHESTRA_HOME: ohome, CLAUDE_CONFIG_DIR: cfg, repo: repoDir })) mustBeScratch(k, v);
  git(repoDir, ['init', '-q', '-b', 'main'], fakeHome); fs.writeFileSync(path.join(repoDir, 'README.md'), '# mg285 seed repo\n'); git(repoDir, ['add', '.'], fakeHome); git(repoDir, ['commit', '-q', '-m', 'seed'], fakeHome);
  const account = { id: 'rig-mg285', label: 'rig (scratch config dir)', configDir: cfg };
  const dir = path.join(ohome, 'userData', 'orchestra'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'store.json'), JSON.stringify({ repos: [{ path: repoDir, name: 'mg285-repo', defaultBranch: 'main', accountId: account.id }], workspaces: [], accounts: [account], selfTuneRuns: [] }, null, 2));
  const stubDir = path.join(armDir, 'stub-bin'); fs.mkdirSync(stubDir, { recursive: true });
  fs.writeFileSync(path.join(stubDir, 'claude'), '#!/bin/sh\nsleep 3600\n', { mode: 0o755 });
  return { fakeHome, ohome, cfg, stubDir, storeFile: path.join(dir, 'store.json') };
}
function listProcsByHome(home) {
  const out = [];
  for (const p of fs.readdirSync('/proc').filter((n) => /^\d+$/.test(n))) { try { if (fs.readFileSync(`/proc/${p}/environ`, 'utf8').split('\0').includes(`ORCHESTRA_HOME=${home}`)) out.push(+p); } catch {} }
  return out.filter((p) => p !== process.pid);
}
function liveCanary() {
  const snap = {};
  for (const d of fs.readdirSync(LIVE_HOME).filter((n) => n === '.claude' || n.startsWith('.claude-')).map((n) => path.join(LIVE_HOME, n))) {
    let links = ''; try { links = sh('find', [d, '-maxdepth', '1', '-type', 'l', '-printf', '%f->%l\\n']).split('\n').sort().join('|'); } catch {}
    let mcp = ''; for (const f of [path.join(d, '.claude.json'), path.join(LIVE_HOME, '.claude.json')]) { try { mcp += Object.keys(JSON.parse(fs.readFileSync(f, 'utf8')).mcpServers || {}).sort().join(',') + ';'; } catch {} }
    snap[d] = md5(links) + ':' + md5(mcp);
  }
  return snap;
}

const SEL = { open: '[aria-label="Memory guard settings"]', dialog: '[aria-label="Memory guard"]' };
const dom = (cdp) => cdp.eval(`(() => {
  const q = (s) => document.querySelector(s), R = (el) => { if (!el) return null; const b = el.getBoundingClientRect(); return { top: b.top, bottom: b.bottom, left: b.left, right: b.right, width: b.width, height: b.height }; };
  const dlg = q(${JSON.stringify(SEL.dialog)}), chip = q('[data-mg-chip]'), fill = q('.mg-gauge-fill'), gauge = q('.mg-gauge');
  const labels = [...document.querySelectorAll('.mg-tick-label')].map((e) => ({ text: e.textContent, r: R(e) }));
  return { open: !!dlg, dialog: R(dlg), vw: innerWidth, vh: innerHeight, live: q('[data-mg-live]') ? q('[data-mg-live]').textContent : null,
    chipTone: chip ? chip.getAttribute('data-mg-chip') : null, chipText: chip ? chip.textContent.replace(/^●\\s*/, '').trim() : null, chipRect: R(chip),
    admission: q('[data-mg-admission]') ? q('[data-mg-admission]').value : null, critical: q('[data-mg-critical]') ? q('[data-mg-critical]').value : null,
    toggle: q('[data-mg-toggle]') ? q('[data-mg-toggle]').checked : null, error: q('[data-mg-error]') ? q('[data-mg-error]').textContent.trim() : null,
    fillClass: fill ? fill.className : null, fillW: fill ? fill.getBoundingClientRect().width : null, gaugeW: gauge ? gauge.getBoundingClientRect().width : null,
    ticks: document.querySelectorAll('.mg-tick').length, labels };
})()`);

async function main() {
  const before = liveCanary();
  const armDir = path.join(RIG_DIR, `arm-${LABEL}`); fs.mkdirSync(armDir, { recursive: true });
  const world = seedWorld(armDir);
  sh('swaymsg', ['output', 'HEADLESS-1', 'resolution', '1400x900']); sh('swaymsg', ['default_border', 'none']);
  const port = await freePort();
  const env = { PATH: `${world.stubDir}:/usr/local/bin:/usr/bin:/bin`, HOME: world.fakeHome, XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR, XDG_CONFIG_HOME: path.join(world.fakeHome, '.config'), XDG_CACHE_HOME: path.join(world.fakeHome, '.cache'),
    WAYLAND_DISPLAY: RIG_WAYLAND, SWAYSOCK: process.env.SWAYSOCK, ELECTRON_OZONE_PLATFORM_HINT: 'wayland', ORCHESTRA_OZONE: 'wayland', ORCHESTRA_OZONE_RELAUNCHED: '1',
    ORCHESTRA_HOME: world.ohome, ORCHESTRA_DEBUG_PORT: String(port), ORCHESTRA_SELF_TUNE_CMD: '/bin/true', CLAUDE_CONFIG_DIR: world.cfg, LANG: 'C.UTF-8' };
  for (const k of ['HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'ORCHESTRA_HOME', 'CLAUDE_CONFIG_DIR']) mustBeScratch(`env.${k}`, env[k]);
  if ('DISPLAY' in env || env.WAYLAND_DISPLAY !== RIG_WAYLAND) refuse('child env would reach the human display');
  const logFile = path.join(armDir, 'app.log'); const fd = fs.openSync(logFile, 'w');
  const app = spawn(path.join(APP_DIR, 'node_modules/electron/dist/electron'), [APP_DIR, '--ozone-platform=wayland'], { cwd: APP_DIR, env, stdio: ['ignore', fd, fd], detached: true });
  console.log(`  app pid ${app.pid} port ${port} log ${logFile}`);
  let cdp;
  const bus = () => { // the REAL built CLI over the app's own socket (pointer file under the scratch ORCHESTRA_HOME)
    const sock = fs.readFileSync(path.join(world.ohome, 'sock'), 'utf8').trim();
    mustBeScratch('socket pointer home', world.ohome);
    const out = sh(process.execPath, [path.join(APP_DIR, 'dist-electron', 'cli.js'), 'bus-status'], { env: { PATH: process.env.PATH, HOME: world.fakeHome, ORCHESTRA_HOME: world.ohome, ORCHESTRA_SOCK: sock } });
    return out.split('\n').find((l) => l.startsWith('memory:')) ?? `(no memory: line) ${out.slice(0, 200)}`;
  };
  const store = () => JSON.parse(fs.readFileSync(world.storeFile, 'utf8')).memoryGuard ?? null;
  const appLog = () => { try { return fs.readFileSync(path.join(world.ohome, 'logs', 'orchestra.log'), 'utf8'); } catch { return ''; } };
  /** type `text` into an input (trusted click → select all → insertText), then commit with Enter or blur (click the dialog title) */
  async function typeInto(sel, text, how) {
    const r = await cdp.eval(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); e.focus(); e.select(); const b = e.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; })()`);
    await cdp.click(r.x, r.y); await cdp.eval(`document.querySelector(${JSON.stringify(sel)}).select()`);
    await cdp.send('Input.insertText', { text });
    if (how === 'enter') await cdp.key('Enter', 'Enter', 13);
    else { const t = await cdp.eval(`(() => { const b = document.querySelector('${SEL.dialog} h2').getBoundingClientRect(); return { x: b.left + 6, y: b.top + b.height / 2 }; })()`); await cdp.click(t.x, t.y); }
  }
  const settled = (pred, what) => waitFor(async () => { const d = await dom(cdp); return pred(d) ? d : null; }, 8000, what);
  try {
    const target = await waitFor(async () => { const r = await fetch(`http://127.0.0.1:${port}/json`); return (await r.json()).find((x) => x.type === 'page' && x.url.includes('dist/index.html')) || null; }, 60000, 'the app page target');
    clause('ctl/app-identity-path', target.url.includes(APP_DIR) && !target.url.includes('app.asar'), `target url ${target.url} ⊇ ${APP_DIR}`);
    cdp = await Cdp.connect(target.webSocketDebuggerUrl); await cdp.send('Page.enable');
    await waitFor(() => cdp.eval(`!!document.querySelector(${JSON.stringify(SEL.open)})`), 60000, 'the Memory guard header button');
    const srcs = await cdp.eval(`[...document.querySelectorAll('script[src]')].map((s) => s.src)`); const bundle = srcs.find((s) => /assets\/index-.*\.js/.test(s));
    const onDisk = bundle && path.join(APP_DIR, 'dist', bundle.split('/dist/')[1]);
    const frameId = (await cdp.send('Page.getResourceTree')).frameTree.frame.id; const rc_ = await cdp.send('Page.getResourceContent', { frameId, url: bundle });
    const served = Buffer.from(rc_.content, rc_.base64Encoded ? 'base64' : 'utf8');
    clause('ctl/app-identity-bundle', !!onDisk && fs.existsSync(onDisk) && md5(served) === md5(fs.readFileSync(onDisk)) && served.toString('utf8').includes('data-mg-chip'), `renderer bundle ${path.basename(bundle || '?')} served md5 ${md5(served)} == dist file, and contains the modal's marker`);
    const environ = fs.readFileSync(`/proc/${app.pid}/environ`, 'utf8').split('\0'); const ev = (k) => (environ.find((e) => e.startsWith(k + '=')) || '').slice(k.length + 1);
    clause('ctl/scratch-env', ev('ORCHESTRA_HOME') === world.ohome && ev('CLAUDE_CONFIG_DIR') === world.cfg && ev('HOME') === world.fakeHome && !environ.some((e) => e.startsWith('DISPLAY=')) && ev('WAYLAND_DISPLAY') === RIG_WAYLAND, `app environ ORCHESTRA_HOME=${ev('ORCHESTRA_HOME')} WAYLAND_DISPLAY=${ev('WAYLAND_DISPLAY')} DISPLAY=${ev('DISPLAY') || '<unset>'}`);
    clause('ctl/app-in-my-sway', new RegExp(`"pid":\\s*${app.pid}\\b`).test(sh('swaymsg', ['-t', 'get_tree'])), `app pid ${app.pid} in my sway's get_tree`);

    // ── host headroom: the drive moves thresholds around the LIVE reading, so it needs room between it and MemTotal ──
    const L = meminfo('MemAvailable'), T = meminfo('MemTotal');
    if (!(L > 7.5 && T - L > 7)) { clause('ctl/host-headroom', false, `VOID — MemAvailable ${L.toFixed(1)} GB / MemTotal ${T.toFixed(1)} GB leaves no room (need MemAvailable > 7.5 and ≥ 7 GB headroom); nothing was measured`); return; }
    const C = Math.round((L + 2) * 10) / 10, A = Math.round(Math.min(T - 0.5, L + 6) * 10) / 10;
    console.log(`  host: MemAvailable ${L.toFixed(2)} GB, MemTotal ${T.toFixed(2)} GB → drive thresholds: critical ${C}, Admission ${A}`);

    // ── S0: open the dialog with a TRUSTED click ──
    const pre = await dom(cdp);
    const btn = await cdp.eval(`(() => { const b = document.querySelector(${JSON.stringify(SEL.open)}).getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2, inView: b.top >= 0 && b.bottom <= innerHeight && b.left >= 0 && b.right <= innerWidth }; })()`);
    if (!btn.inView) throw new Error(`header button not in the viewport: ${JSON.stringify(btn)}`);
    await cdp.click(btn.x, btn.y);
    const s0 = await settled((d) => d.open && d.live && d.live !== '—' && d.chipTone, 'the dialog with a live reading and a state chip');
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: 895 }); await sleep(600); await cdp.eval('document.fonts.ready.then(() => true)');
    clause('ctl/pre-post-state', !pre.open && s0.open, `dialog ${pre.open} -> ${s0.open} after a trusted click on the header icon`);
    const D = await dom(cdp);
    const liveGb = parseFloat(D.live);
    clause('S0/live-reading-agrees-with-proc', Math.abs(liveGb - meminfo('MemAvailable')) < 2, `modal shows "${D.live}"; independent /proc/meminfo read ${meminfo('MemAvailable').toFixed(2)} GB (|Δ| < 2)`);
    clause('S0/open-state', D.chipTone === 'ok' && D.chipText === 'Admission open' && D.admission === '6' && D.critical === '3' && D.toggle === true, `chip ${D.chipTone} "${D.chipText}", inputs ${D.admission}/${D.critical}, toggle ${D.toggle}`);
    const dr = D.dialog;
    clause('S0/dialog-inside-viewport', dr && dr.left >= 0 && dr.top >= 0 && dr.right <= D.vw && dr.bottom <= D.vh, `dialog ${JSON.stringify(dr && { l: Math.round(dr.left), t: Math.round(dr.top), r: Math.round(dr.right), b: Math.round(dr.bottom) })} within ${D.vw}x${D.vh}`);
    const lb = D.labels.map((l) => l.r), overl = (a, b) => !(a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top);
    const anyOverlap = lb.some((a, i) => lb.slice(i + 1).some((b) => overl(a, b)));
    clause('S0/gauge-ticks-and-labels', D.ticks === 3 && D.labels.length === 3 && !anyOverlap, `${D.ticks} ticks, labels ${D.labels.map((l) => l.text).join(' | ')}, any label overlap ${anyOverlap}, fill class "${D.fillClass}"`);
    const fillFrac = D.fillW / D.gaugeW;
    clause('S0/gauge-fill-matches-reading', fillFrac > 0.02 && Math.abs(fillFrac - liveGb / Math.max(T, (6 + 1) * 1.25, liveGb)) < 0.03, `fill ${(fillFrac * 100).toFixed(1)}% of the gauge vs reading/scale ${(100 * liveGb / Math.max(T, 8.75, liveGb)).toFixed(1)}%`);
    clause('S0/bus-status-open', /admission open/.test(bus()) && /memory Pause none/.test(bus()), bus());
    const shot0 = await cdp.shot(); const f0 = saveShot(`${LABEL}-s0-open-renderer.png`, shot0);
    const grimFile = path.join(OUT, `${LABEL}-s0-open-compositor.png`);
    sh('grim', ['-o', 'HEADLESS-1', grimFile], { env: { PATH: '/usr/bin:/bin', XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR, WAYLAND_DISPLAY: RIG_WAYLAND } }); shots.push({ file: grimFile, md5: md5(fs.readFileSync(grimFile)) });
    const grim = decodePng(fs.readFileSync(grimFile)), rend = decodePng(shot0);
    const cx = Math.floor(dr.left), cy = Math.floor(dr.top), cw = Math.floor(dr.width), ch = Math.floor(dr.height);
    clause('ctl/compositor-frame-shows-the-modal', grim.w === rend.w && grim.h === rend.h && inkPx(crop(grim, cx, cy, cw, ch)) > 400, `grim ${grim.w}x${grim.h} vs renderer ${rend.w}x${rend.h}; modal crop ${cw}x${ch} has ${inkPx(crop(grim, cx, cy, cw, ch))} ink px (>400: not a blank frame)`);
    console.log(`  shots: ${f0}, ${grimFile}`);

    // ── S1: Admission threshold ABOVE the live reading, committed with Enter → HELD, hot (no restart, no timer wait) ──
    await typeInto('[data-mg-admission]', String(A), 'enter');
    const s1 = await settled((d) => d.chipTone === 'warn', 'chip → warn (HELD)');
    clause('S1/chip-held', /^HELD since \d\d:\d\d — [\d.]+ GB$/.test(s1.chipText) && /warn/.test(s1.fillClass), `chip ${s1.chipTone} "${s1.chipText}", gauge fill class "${s1.fillClass}"`);
    clause('S1/bus-status-held', /admission HELD since \S+ \(episode 1; reopens above/.test(bus()), bus());
    clause('S1/persisted-on-disk', store()?.admissionGb === A && store()?.criticalGb === 3, `scratch store.json memoryGuard=${JSON.stringify(store())}`);
    clause('S1/logged-with-memavailable', /\[memory-guard\] admission HELD \(episode 1\) — MemAvailable [\d.]+ GB < [\d.]+ GB/.test(appLog()), (appLog().split('\n').find((l) => l.includes('admission HELD')) ?? '(no line)').slice(0, 200));
    clause('S1/state-changed', s1.chipTone !== D.chipTone, `chip tone ${D.chipTone} -> ${s1.chipTone}`);
    const f1 = saveShot(`${LABEL}-s1-held-renderer.png`, await cdp.shot());

    // ── S2: critical ABOVE the live reading, committed by BLUR → memory Pause state ──
    await typeInto('[data-mg-critical]', String(C), 'blur');
    const s2 = await settled((d) => d.chipTone === 'crit', 'chip → crit (MEMORY PAUSE)');
    clause('S2/chip-memory-pause', /^MEMORY PAUSE since \d\d:\d\d — [\d.]+ GB$/.test(s2.chipText) && /crit/.test(s2.fillClass), `chip ${s2.chipTone} "${s2.chipText}", gauge fill class "${s2.fillClass}"`);
    clause('S2/bus-status-pause', /memory Pause IN EFFECT since \S+ \(lifts above/.test(bus()), bus());
    clause('S2/persisted-on-disk', store()?.criticalGb === C && store()?.admissionGb === A, `scratch store.json memoryGuard=${JSON.stringify(store())}`);
    clause('S2/logged', /\[memory-guard\] memory Pause DUE \(episode 1\) — MemAvailable [\d.]+ GB < critical [\d.]+ GB/.test(appLog()), (appLog().split('\n').find((l) => l.includes('Pause DUE')) ?? '(no line)').slice(0, 200));
    const f2 = saveShot(`${LABEL}-s2-critical-renderer.png`, await cdp.shot());

    // ── S3: an invalid pair (critical above Admission) → inline error, NOTHING written, state unchanged ──
    const storeBefore = JSON.stringify(store());
    await typeInto('[data-mg-critical]', String(A + 1), 'enter');
    const s3 = await settled((d) => d.error, 'the inline error row');
    clause('S3/inline-error', /must be below the Admission threshold/.test(s3.error) && s3.chipTone === 'crit', `error "${s3.error}", chip still ${s3.chipTone}`);
    clause('S3/nothing-written', JSON.stringify(store()) === storeBefore, `store.json memoryGuard before ${storeBefore} == after ${JSON.stringify(store())}`);
    const f3 = saveShot(`${LABEL}-s3-invalid-renderer.png`, await cdp.shot());
    await typeInto('[data-mg-critical]', String(C), 'enter'); // back to the committed value → the error clears
    const s3b = await settled((d) => !d.error, 'the error row to clear');
    clause('S3/error-clears', s3b.critical === String(C), `error cleared, critical input "${s3b.critical}"`);

    // ── S4: the global toggle ──
    const tg = await cdp.eval(`(() => { const b = document.querySelector('[data-mg-toggle]').getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; })()`);
    await cdp.click(tg.x, tg.y);
    await settled((d) => d.toggle === false, 'toggle → off');
    clause('S4/toggle-off', store()?.admissionEnabled === false && /toggle OFF — nothing is held/.test(bus()), `store admissionEnabled=${store()?.admissionEnabled}; ${bus()}`);
    await cdp.click(tg.x, tg.y);
    await settled((d) => d.toggle === true, 'toggle → on');
    clause('S4/toggle-on', store()?.admissionEnabled === true && !/toggle OFF/.test(bus()), `store admissionEnabled=${store()?.admissionEnabled}; ${bus()}`);

    // ── S5: back to the defaults (typed pair) → open again, Pause lifted ──
    await typeInto('[data-mg-admission]', '6', 'blur'); // 6 alone is invalid vs critical C (C ≥ 6): stays a DRAFT, error shown
    await typeInto('[data-mg-critical]', '3', 'blur');  // now the pair 6/3 is valid and commits
    const s5 = await settled((d) => d.chipTone === 'ok', 'chip → ok');
    clause('S5/restored', s5.chipText === 'Admission open' && s5.admission === '6' && s5.critical === '3' && !s5.error, `chip ${s5.chipTone} "${s5.chipText}", inputs ${s5.admission}/${s5.critical}, error ${s5.error}`);
    clause('S5/bus-status-open', /admission open/.test(bus()) && /memory Pause none/.test(bus()), bus());
    clause('S5/logged-lift-and-reopen', /memory Pause LIFTABLE/.test(appLog()) && /admission REOPENED \(episode 1 over\)/.test(appLog()), (appLog().split('\n').filter((l) => /LIFTABLE|REOPENED/.test(l)).join(' || ')).slice(0, 300));
    clause('S5/persisted-defaults', store()?.admissionGb === 6 && store()?.criticalGb === 3, `store.json memoryGuard=${JSON.stringify(store())}`);
    const f5 = saveShot(`${LABEL}-s5-restored-renderer.png`, await cdp.shot());

    // ── S6: close and reopen — the stored values come back ──
    const done = await cdp.eval(`(() => { const b = [...document.querySelectorAll('${SEL.dialog} .btn')].find((x) => x.textContent.trim() === 'Done').getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; })()`);
    await cdp.click(done.x, done.y);
    await waitFor(async () => !(await dom(cdp)).open, 5000, 'the dialog to close');
    await cdp.click(btn.x, btn.y);
    const s6 = await settled((d) => d.open && d.live !== '—', 'the dialog to reopen');
    clause('S6/reopen-shows-stored', s6.admission === '6' && s6.critical === '3' && s6.toggle === true && !s6.error, `reopened: inputs ${s6.admission}/${s6.critical}, toggle ${s6.toggle}`);

    const dup = shots.length - new Set(shots.map((s) => s.md5)).size;
    clause('ctl/no-duplicate-captures', dup === 0, `${shots.length} captures, ${dup} byte-identical duplicate(s): ${shots.map((s) => path.basename(s.file)).join(', ')}`);
    console.log(`  shots: ${[f1, f2, f3, f5].join(', ')}`);
  } catch (e) {
    clause('rig/completed', false, `ABORTED: ${e.stack || e}`);
  } finally {
    cdp?.close();
    try { process.kill(-app.pid, 'SIGTERM'); } catch {}
    await sleep(2000);
    try { process.kill(-app.pid, 'SIGKILL'); } catch {}
    for (const p of listProcsByHome(world.ohome)) { try { process.kill(p, 'SIGKILL'); } catch {} }
    await sleep(500);
    const left = listProcsByHome(world.ohome);
    clause('rig/teardown-no-survivors', left.length === 0, `processes still carrying ${world.ohome}: ${left.length ? left.join(',') : 'none'}`);
  }
  const after = liveCanary();
  clause('ctl/live-claude-dirs-untouched', JSON.stringify(before) === JSON.stringify(after), `${Object.keys(before).length} live ~/.claude* dirs hashed before/after: ${JSON.stringify(before) === JSON.stringify(after) ? 'identical' : 'CHANGED'}`);
}

await main();
console.log('\n== shots (md5) ==');
for (const s of shots) console.log(`  ${s.md5}  ${s.file}`);
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, `${LABEL}-result.json`), JSON.stringify({ app: APP_DIR, label: LABEL, results, shots }, null, 2));
const red = results.filter((r) => !r.ok);
console.log(`\nVERDICT: ${red.length === 0 ? `ALL GREEN: ${results.length} clauses` : `RED: ${red.map((r) => r.clause).join(', ')}`}`);
process.exit(red.length === 0 ? 0 : 1);
