// #289 (D5 D-pick3, option B) — the memory BANNER, driven in a BUILT Orchestra (argv[2] = app dir) inside the contained rig's own headless sway, scratch ORCHESTRA_HOME / HOME / CLAUDE_CONFIG_DIR. The memory source is the REAL
// /proc/meminfo: the held / critical states are reached by moving the THRESHOLDS around the live MemAvailable through the real Settings UI (the existing #285 modal), then the dialog is closed and the BANNER is read:
//   DOM (kind, tone, French copy, position inside the viewport and the main column)  ·  the REAL built CLI `bus-status` `memory:` line over the app's socket  ·  a renderer screenshot per state (+ one compositor capture)
// The scratch store has no workspace: the banner must show on the WELCOME screen too (D-pick3: global). States: none → HELD (amber) → « Masquer » hides it → escalation to the memory Pause shows it AGAIN (red) →
// « Masquer » → recovery clears it → the next episode shows again. Positive controls: app identity (bundle md5 + the banner string in the served bundle), scratch env read back out of the running app, app present in MY sway.
//
// Usage (via scripts/e2e-memory-banner.sh): <app-dir> --live-home <real $HOME> [--out dir] [--label name]
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
    inputW: q('[data-mg-admission]') ? q('[data-mg-admission]').getBoundingClientRect().width : null, fieldTop: R(q('.memory-guard-settings .field')) ? R(q('.memory-guard-settings .field')).top : null,
    liveTop: R(q('.mg-live-value')) ? R(q('.mg-live-value')).top : null, liveBottom: R(q('.mg-live-value')) ? R(q('.mg-live-value')).bottom : null,
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
  // A run UNDER THE MEMORY PAUSE, written to the app's own bus exactly as the host writes it (G7's rig covers the impose path; this world has no fleet to impose on). The banner is RED only while such a run exists.
  const PAUSE_RUN = 'mg289-lead';
  const seedMemoryPause = (on) => {
    mustBeScratch('bus db home', world.ohome);
    sh('python3', ['-I', '-c', [
      'import sqlite3, sys, json, time',
      'db = sqlite3.connect(sys.argv[1], timeout=20); db.execute("PRAGMA busy_timeout=20000")',
      'now = int(time.time() * 1000); run = sys.argv[3]',
      'if sys.argv[2] == "on":',
      '    db.execute("INSERT OR IGNORE INTO runs (id, kind, coordinator, parent_run_id, title, created_at) VALUES (?,?,?,?,?,?)", (run, "mission", run, None, "banner drive", now))',
      '    db.execute("INSERT OR IGNORE INTO run_flags (run_id, flags, frozen_at) VALUES (?,?,?)", (run, json.dumps({"delivery": True, "pause": True}), now))',
      '    reason = {"reason": "memory", "pauseCycle": 1, "episode": 1, "availBytes": 2 * 1024 ** 3, "thresholdBytes": 3 * 1024 ** 3, "epoch": now}',
      '    db.execute("UPDATE runs SET paused_at=?, paused_by=\'host:memory\', pause_mode=\'hard\', pause_auto=? WHERE id=?", (now, json.dumps(reason, separators=(",", ":")), run))',
      'else:',
      '    db.execute("UPDATE runs SET paused_at=NULL, paused_by=NULL, pause_mode=NULL, pause_auto=NULL WHERE id=?", (run,))',
      'db.commit()',
    ].join('\n'), path.join(world.ohome, 'bus.sqlite'), on ? 'on' : 'off', PAUSE_RUN]);
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
    clause('ctl/app-identity-bundle', !!onDisk && fs.existsSync(onDisk) && md5(served) === md5(fs.readFileSync(onDisk)) && served.toString('utf8').includes('memory-banner'), `renderer bundle ${path.basename(bundle || '?')} served md5 ${md5(served)} == dist file, and contains the modal's marker`);
    const environ = fs.readFileSync(`/proc/${app.pid}/environ`, 'utf8').split('\0'); const ev = (k) => (environ.find((e) => e.startsWith(k + '=')) || '').slice(k.length + 1);
    clause('ctl/scratch-env', ev('ORCHESTRA_HOME') === world.ohome && ev('CLAUDE_CONFIG_DIR') === world.cfg && ev('HOME') === world.fakeHome && !environ.some((e) => e.startsWith('DISPLAY=')) && ev('WAYLAND_DISPLAY') === RIG_WAYLAND, `app environ ORCHESTRA_HOME=${ev('ORCHESTRA_HOME')} WAYLAND_DISPLAY=${ev('WAYLAND_DISPLAY')} DISPLAY=${ev('DISPLAY') || '<unset>'}`);
    clause('ctl/app-in-my-sway', new RegExp(`"pid":\\s*${app.pid}\\b`).test(sh('swaymsg', ['-t', 'get_tree'])), `app pid ${app.pid} in my sway's get_tree`);

    // ── host headroom: the drive moves thresholds around the LIVE reading, so it needs room between it and MemTotal ──
    const L = meminfo('MemAvailable'), T = meminfo('MemTotal');
    if (!(L > 7.5 && T - L > 7)) { clause('ctl/host-headroom', false, `VOID — MemAvailable ${L.toFixed(1)} GB / MemTotal ${T.toFixed(1)} GB leaves no room (need MemAvailable > 7.5 and ≥ 7 GB headroom); nothing was measured`); return; }
    const C = Math.round((L + 2) * 10) / 10, A = Math.round(Math.min(T - 0.5, L + 6) * 10) / 10;
    console.log(`  host: MemAvailable ${L.toFixed(2)} GB, MemTotal ${T.toFixed(2)} GB → drive thresholds: critical ${C}, Admission ${A}`);

    // ── helpers on top of the #285 modal: open / close it with TRUSTED clicks, read the banner ──
    const btn = await cdp.eval(`(() => { const b = document.querySelector(${JSON.stringify(SEL.open)}).getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2, inView: b.top >= 0 && b.bottom <= innerHeight && b.left >= 0 && b.right <= innerWidth }; })()`);
    if (!btn.inView) throw new Error(`header button not in the viewport: ${JSON.stringify(btn)}`);
    const openDialog = async () => { await cdp.click(btn.x, btn.y); await settled((d) => d.open && d.live && d.live !== '—' && d.chipTone, 'the dialog with a live reading'); };
    const closeDialog = async () => {
      const done = await cdp.eval(`(() => { const b = [...document.querySelectorAll('${SEL.dialog} .btn')].find((x) => x.textContent.trim() === 'Done').getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; })()`);
      await cdp.click(done.x, done.y); await waitFor(async () => !(await dom(cdp)).open, 5000, 'the dialog to close');
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: 895 });
    };
    const banner = () => cdp.eval(`(() => {
      const q = (s) => document.querySelector(s), R = (el) => { if (!el) return null; const b = el.getBoundingClientRect(); return { top: b.top, bottom: b.bottom, left: b.left, right: b.right, width: b.width, height: b.height }; };
      const bn = q('.memory-banner'), main = q('main.main');
      return { present: !!bn, kind: bn ? bn.getAttribute('data-kind') : null, tone: bn ? bn.getAttribute('data-tone') : null, role: bn ? bn.getAttribute('role') : null,
        title: bn ? q('.memory-banner-title').textContent : null, lead: bn ? q('.memory-banner-title strong').textContent : null, sub: bn ? q('.memory-banner-sub').textContent : null,
        bg: bn ? getComputedStyle(bn).backgroundColor : null, rect: R(bn), main: R(main), dismiss: R(q('.memory-banner-dismiss')), dismissText: q('.memory-banner-dismiss') ? q('.memory-banner-dismiss').textContent.trim() : null,
        welcome: !!q('.empty h2'), vw: innerWidth, vh: innerHeight, count: document.querySelectorAll('.memory-banner').length };
    })()`);
    const bannerSettled = (pred, what) => waitFor(async () => { const b = await banner(); return pred(b) ? b : null; }, 12000, what);
    const inside = (b) => b.rect && b.rect.left >= 0 && b.rect.top >= 0 && b.rect.right <= b.vw && b.rect.bottom <= b.vh && b.main && b.rect.left >= b.main.left - 1 && b.rect.right <= b.main.right + 1;
    const frGo = (gb) => `${Number.isInteger(gb) ? gb : gb.toFixed(1).replace('.', ',')} Go`;

    // ── B0: open memory — NO banner, on the Welcome screen ──
    await openDialog();
    const D0 = await dom(cdp);
    clause('B0/guard-open-control', D0.chipTone === 'ok' && D0.chipText === 'Admission open', `modal chip ${D0.chipTone} "${D0.chipText}" (the live reading ${D0.live})`);
    await closeDialog();
    const b0 = await banner();
    clause('B0/no-banner-when-memory-is-fine', !b0.present && b0.welcome && /admission open/.test(bus()), `banner present=${b0.present}; Welcome screen=${b0.welcome}; ${bus()}`);
    const f0 = saveShot(`${LABEL}-b0-none-renderer.png`, await cdp.shot());

    // ── B1: Admission threshold ABOVE the live reading → HELD → the amber banner ──
    await openDialog(); await typeInto('[data-mg-admission]', String(A), 'enter'); await settled((d) => d.chipTone === 'warn', 'chip → warn (HELD)'); await closeDialog();
    const b1 = await bannerSettled((b) => b.present && b.kind === 'held', 'the HELD banner').catch(() => banner()); // a build WITHOUT the banner reads absent here: the clauses below go RED (the must-FAIL), they do not abort
    clause('B1/state-changed', !b0.present && b1.present, `banner present ${b0.present} -> ${b1.present}; kind ${b0.kind} -> ${b1.kind}`);
    clause('B1/bus-status-held', /admission HELD since \S+ \(episode 1; reopens above/.test(bus()), bus());
    clause('B1/amber-copy-as-approved', b1.tone === 'warn' && b1.role === 'status' && b1.lead === 'Mémoire basse' && new RegExp(`^Mémoire basse — [\\d,]+ Go disponibles \\(seuil ${frGo(A).replace('.', '\\.')}\\)\\. Les démarrages automatiques d'agents sont retenus ; les agents inactifs passent en Veille\\.$`).test(b1.title) && /^(Aucun démarrage retenu pour l'instant|\d+ démarrages? retenus?) · relâchés dès [\d,]+ Go, coordinateurs d'abord, un par un\.$/.test(b1.sub), `lead "${b1.lead}" · title "${b1.title}" · sub "${b1.sub}"`);
    clause('B1/two-lines-and-a-dismiss-button', b1.dismissText === 'Masquer' && b1.count === 1 && (b1.rect?.height ?? 0) > 36, `banner ${Math.round(b1.rect?.height ?? 0)}px high, ${b1.count} banner(s), button "${b1.dismissText}"`);
    clause('B1/inside-viewport-and-main-column', inside(b1), `banner ${JSON.stringify({ l: Math.round(b1.rect?.left ?? 0), t: Math.round(b1.rect?.top ?? 0), r: Math.round(b1.rect?.right ?? 0), b: Math.round(b1.rect?.bottom ?? 0) })} within main ${JSON.stringify({ l: Math.round(b1.main?.left ?? 0), r: Math.round(b1.main?.right ?? 0) })} and the ${b1.vw}x${b1.vh} viewport`);
    clause('B1/amber-paint', /^rgba\(255, 200, 87, /.test(b1.bg), `computed background ${b1.bg} (the --yellow tint)`);
    const f1 = saveShot(`${LABEL}-b1-held-renderer.png`, await cdp.shot());
    const grimFile = path.join(OUT, `${LABEL}-b1-held-compositor.png`);
    sh('grim', ['-o', 'HEADLESS-1', grimFile], { env: { PATH: '/usr/bin:/bin', XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR, WAYLAND_DISPLAY: RIG_WAYLAND } }); shots.push({ file: grimFile, md5: md5(fs.readFileSync(grimFile)) });
    if (b1.present) { const grim = decodePng(fs.readFileSync(grimFile)), rend = decodePng(await cdp.shot()); const cx = Math.floor(b1.rect?.left), cy = Math.floor(b1.rect?.top), cw = Math.floor(b1.rect?.width), ch = Math.floor(b1.rect?.height);
      clause('ctl/compositor-frame-shows-the-banner', grim.w === rend.w && grim.h === rend.h && inkPx(crop(grim, cx, cy, cw, ch)) > 300, `grim ${grim.w}x${grim.h} vs renderer ${rend.w}x${rend.h}; banner crop ${cw}x${ch} has ${inkPx(crop(grim, cx, cy, cw, ch))} ink px`); }

    if (!b1.present) throw new Error('no banner appeared while HELD — nothing further can be driven (the clauses above are the verdict)');
    // ── B2: « Masquer » hides exactly this banner (the guard is still HELD) ──
    await cdp.click(b1.dismiss.left + b1.dismiss.width / 2, b1.dismiss.top + b1.dismiss.height / 2);
    const b2 = await bannerSettled((b) => !b.present, 'the banner to hide');
    clause('B2/dismissed', !b2.present && /admission HELD/.test(bus()), `banner present ${b1.present} -> ${b2.present} after a trusted click on « Masquer »; the guard is still: ${bus()}`);
    // the dismissed screen is VISUALLY the no-banner screen: a byte-identical frame to B0 is the paint evidence that the banner is really gone (so it is not saved as a capture of its own — the duplicate-capture control would flag it)
    const shotB2 = await cdp.shot();
    clause('B2/dismissed-frame-equals-the-no-banner-frame', md5(shotB2) === shots.find((x) => x.file.includes('-b0-none-'))?.md5, `md5(dismissed) ${md5(shotB2)} vs md5(B0 none) ${shots.find((x) => x.file.includes('-b0-none-'))?.md5}`);

    // ── B3: escalation: critical ABOVE the live reading → the memory Pause → the red banner shows AGAIN ──
    await openDialog(); await typeInto('[data-mg-critical]', String(C), 'blur'); await settled((d) => d.chipTone === 'crit', 'chip → crit (MEMORY PAUSE)'); await closeDialog();
    await sleep(1500); // the edge's push has long reached the renderer: an absent banner below is the state, not a race
    const b2b = await banner(); // the guard is below critical but NO run is under the memory Pause yet: nothing red to announce
    clause('B3/no-red-banner-while-no-run-is-paused', !b2b.present && /memory Pause IN EFFECT/.test(bus()), `banner present=${b2b.present} kind=${b2b.kind} while ${bus()} (the guard says Pause, the bus has no paused run; the amber banner of this episode is dismissed)`);
    seedMemoryPause(true);
    const b3 = await bannerSettled((b) => b.present && b.kind === 'pause', 'the PAUSE banner');
    clause('B3/escalation-shows-it-again', !b2.present && b3.present && b3.kind === 'pause', `banner present ${b2.present} -> ${b3.present}; kind ${b2.kind} -> ${b3.kind} (held → Pause is an escalation: the dismissal does not apply)`);
    clause('B3/bus-status-pause', /memory Pause IN EFFECT since \S+ \(lifts above/.test(bus()), bus());
    clause('B3/red-copy-as-approved', b3.tone === 'crit' && b3.lead === 'Pause mémoire' && new RegExp(`^Pause mémoire — [\\d,]+ Go disponibles \\(seuil critique ${frGo(C).replace('.', '\\.')}\\)\\. 1 run en pause : ${PAUSE_RUN}\\.$`).test(b3.title) && b3.sub === "Reprise automatique dès " + frGo(A) + " · une pause manuelle n'est jamais levée par la garde.", `lead "${b3.lead}" · title "${b3.title}" · sub "${b3.sub}"`);
    clause('B3/inside-viewport-and-main-column', inside(b3) && /^rgba\(255, 107, 107, /.test(b3.bg), `banner inside main/viewport: ${inside(b3)}; computed background ${b3.bg} (the --red tint)`);
    const f3 = saveShot(`${LABEL}-b3-pause-renderer.png`, await cdp.shot());

    // ── B4: dismiss the Pause banner; recovery clears; the NEXT episode shows again ──
    await cdp.click(b3.dismiss.left + b3.dismiss.width / 2, b3.dismiss.top + b3.dismiss.height / 2);
    const b4 = await bannerSettled((b) => !b.present, 'the Pause banner to hide');
    clause('B4/pause-banner-dismissed', !b4.present && /memory Pause IN EFFECT/.test(bus()), `banner present ${b3.present} -> ${b4.present}; ${bus()}`);
    seedMemoryPause(false); // the Reprise finished: the Pause lifts while Admission is STILL held (memory has not recovered)
    await sleep(6500); // > one banner tick
    const b4b = await banner();
    clause('B4/de-escalation-stays-dismissed', !b4b.present && /admission HELD/.test(bus()), `banner present=${b4b.present} after the Pause lifted back to held (episode 1: both banners were dismissed); ${bus()}`);
    await openDialog(); await typeInto('[data-mg-admission]', '6', 'blur'); await typeInto('[data-mg-critical]', '3', 'blur'); await settled((d) => d.chipTone === 'ok', 'chip → ok'); await closeDialog();
    const b5 = await banner();
    clause('B5/recovery-leaves-no-banner', !b5.present && /admission open/.test(bus()) && /memory Pause none/.test(bus()), `banner present=${b5.present}; ${bus()}`);
    await openDialog(); await typeInto('[data-mg-admission]', String(A), 'enter'); await settled((d) => d.chipTone === 'warn', 'chip → warn (HELD, next episode)'); await closeDialog();
    const b6 = await bannerSettled((b) => b.present && b.kind === 'held', 'the banner of the NEXT episode');
    clause('B6/next-episode-shows-again', b6.present && b6.kind === 'held' && /episode 2/.test(bus()), `banner present ${b5.present} -> ${b6.present} (the dismissal of episode 1 is forgotten); ${bus()}`);
    const f6 = saveShot(`${LABEL}-b6-next-episode-renderer.png`, await cdp.shot());
    // ── B8: with a WORKSPACE active (a Scratch session from the Welcome screen) the banner sits between the toolbar and the pane row — the approved placement (D-pick3) — and there is still exactly ONE ──
    try {
      const sc = await cdp.eval(`(() => { const b = [...document.querySelectorAll('.empty button')].find((x) => /Scratch session/.test(x.textContent)); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
      if (!sc) throw new Error('no « Scratch session » button on the Welcome screen');
      await cdp.click(sc.x, sc.y);
      const place = () => cdp.eval(`(() => { const q = (s) => document.querySelector(s), R = (e) => { const b = e.getBoundingClientRect(); return { top: b.top, bottom: b.bottom, left: b.left, right: b.right }; }; const bn = q('.memory-banner'), tb = q('.toolbar'), pr = q('.pane-row'); if (!bn || !tb || !pr) return null; return { banner: R(bn), toolbar: R(tb), pane: R(pr), count: document.querySelectorAll('.memory-banner').length, welcome: !!q('.empty h2') }; })()`);
      const b8 = await waitFor(place, 25000, 'a workspace pane with the banner');
      clause('B8/with-a-workspace-the-banner-sits-between-toolbar-and-pane', b8.count === 1 && !b8.welcome && b8.banner.top >= b8.toolbar.bottom - 1 && b8.banner.bottom <= b8.pane.top + 1, `toolbar bottom ${Math.round(b8.toolbar.bottom)} ≤ banner ${Math.round(b8.banner.top)}..${Math.round(b8.banner.bottom)} ≤ pane top ${Math.round(b8.pane.top)}; ${b8.count} banner(s); Welcome screen ${b8.welcome}`);
      saveShot(`${LABEL}-b8-with-workspace-renderer.png`, await cdp.shot());
      // ── B9: a full-page overlay (Help) opens over the main column: it starts BELOW the banner, which stays visible and un-covered ──
      const hb = await cdp.eval(`(() => { const b = document.querySelector('button[aria-label="Help — feature guide"]'); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
      if (!hb) throw new Error('no Help button in the sidebar header');
      await cdp.click(hb.x, hb.y);
      const overlay = () => cdp.eval(`(() => { const q = (s) => document.querySelector(s), bn = q('.memory-banner'), hv = q('.help-view'); if (!bn || !hv) return null; const b = bn.getBoundingClientRect(), h = hv.getBoundingClientRect(), tb = q('.toolbar'), top = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2); return { bannerTop: b.top, bannerBottom: b.bottom, helpTop: h.top, toolbarBottom: tb ? tb.getBoundingClientRect().bottom : null, covered: !bn.contains(top), var: getComputedStyle(q('main.main')).getPropertyValue('--memory-banner-h').trim(), height: b.height }; })()`);
      const h9 = await waitFor(overlay, 8000, 'the Help overlay with the banner');
      clause('B9/help-overlay-starts-below-the-banner', h9.helpTop >= h9.bannerBottom - 1 && h9.covered === false && Math.abs(parseFloat(h9.var) - h9.height) < 1, `help-view top ${Math.round(h9.helpTop)} ≥ banner bottom ${Math.round(h9.bannerBottom)} (banner ${Math.round(h9.bannerTop)}..${Math.round(h9.bannerBottom)}, toolbar bottom ${Math.round(h9.toolbarBottom)}); the banner's centre is not covered: ${h9.covered === false}; --memory-banner-h ${h9.var} vs banner height ${h9.height}px`);
      saveShot(`${LABEL}-b9-help-over-banner-renderer.png`, await cdp.shot());
      const hc = await cdp.eval(`(() => { const b = document.querySelector('.help-close'); const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
      await cdp.click(hc.x, hc.y);
      await waitFor(async () => !(await cdp.eval(`!!document.querySelector('.help-view')`)), 5000, 'the Help overlay to close');
    } catch (e) {
      clause('B8/with-a-workspace-the-banner-sits-between-toolbar-and-pane', false, `could not drive a workspace: ${e.message}`);
    }
    // ── B10 (G6 review F2): episode 2 is still HELD and its amber banner was NEVER hidden. Escalate to red, hide the RED one with « Masquer », let the Pause lift back to held: the amber banner must NOT come back (D-pick3: hidden until the episode ends) ──
    {
      const amber = await banner();
      await openDialog(); await typeInto('[data-mg-critical]', String(C), 'blur'); await settled((d) => d.chipTone === 'crit', 'chip → crit (MEMORY PAUSE, episode 2)'); await closeDialog();
      seedMemoryPause(true);
      const red = await bannerSettled((b) => b.present && b.kind === 'pause', 'the PAUSE banner of episode 2');
      clause('B10/red-after-a-never-hidden-amber', amber.present && amber.kind === 'held' && red.kind === 'pause', `banner kind ${amber.kind} (amber, never hidden) -> ${red.kind}`);
      saveShot(`${LABEL}-b10-red-with-workspace-renderer.png`, await cdp.shot());
      await cdp.click(red.dismiss.left + red.dismiss.width / 2, red.dismiss.top + red.dismiss.height / 2);
      const hidden = await bannerSettled((b) => !b.present, 'the red banner to hide');
      seedMemoryPause(false); // the Reprise finished: the Pause lifts while Admission is STILL held
      await sleep(6500); // > one banner tick
      const after = await banner();
      clause('B10/masquer-on-red-survives-the-de-escalation', !hidden.present && !after.present && /admission HELD/.test(bus()), `banner present ${red.present} -> ${hidden.present} (Masquer on RED) -> ${after.present} after the Pause lifted back to held; ${bus()}`);
    }
    await openDialog(); await typeInto('[data-mg-admission]', '6', 'blur'); await settled((d) => d.chipTone === 'ok' || d.error, 'back to the defaults'); await typeInto('[data-mg-critical]', '3', 'blur'); await settled((d) => d.chipTone === 'ok', 'chip → ok'); await closeDialog();
    const b7 = await banner();
    clause('B7/restored-no-banner', !b7.present && store()?.admissionGb === 6 && store()?.criticalGb === 3, `banner present=${b7.present}; store.json memoryGuard=${JSON.stringify(store())}`);
    console.log(`  shots: ${[f0, f1, f3, f6].join(', ')}`);

    const dup = shots.length - new Set(shots.map((s) => s.md5)).size;
    clause('ctl/no-duplicate-captures', dup === 0, `${shots.length} captures, ${dup} byte-identical duplicate(s): ${shots.map((s) => path.basename(s.file)).join(', ')}`);
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
