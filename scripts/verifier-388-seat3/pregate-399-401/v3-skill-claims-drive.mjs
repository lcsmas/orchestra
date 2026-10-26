// #399 — PARITY of the REAL `orchestra browser` CLI with the 8 removed `mcp__browser__*` tools (navigate, read_page, screenshot, click, type,
// form_input, evaluate, scroll) + the old server's documented hidden-pane rule + "the user sees what the agent navigates to".
//
// Boots a BUILT Orchestra (argv[2] = app dir) inside the contained rig's own headless sway (scripts/e2e-browser-cli-parity.sh → e2e-contained-rig.sh),
// SCRATCH ORCHESTRA_HOME / HOME / CLAUDE_CONFIG_DIR, TWO seeded workspaces (a pinned session key each) and the shared fixture site
// (scripts/fixtures/browser-site, owned by #395; this rig only adds pages/parity.html). Every page assertion reads an INDEPENDENT oracle: the app's own
// remote-debugging port (a second CDP client on the panel's page) — never the CLI/proxy/agent-browser chain under test.
//
// Harness plumbing mirrors scripts/e2e-browser-cli.mjs (#395, serialized seam): same seeding, same scratch guard, same in-place bundle mutants.
// Usage (via scripts/e2e-browser-cli-parity.sh): <app-dir> --live-home <real $HOME> [--arm a,b] [--list] [--mutant <name>] [--trace] [--out dir]
//   --mutant <name>: patch the BUILT bundle in place (byte-exact backup, `cmp`-verified restore), run, and require the mutant's arms RED
//   (and every ctl/* clause of those arms GREEN). Without it the run must be all green.
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import http from 'node:http';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { abLayout } from '../src/main/agent-browser-daemon.ts';
import { privateRuntimeDir } from './lib/rig-runtime.mjs';
import { BROWSER_SKILL, BROWSER_SKILL_EXAMPLE_HEADING, BROWSER_SKILL_NAME, shellWords } from '../src/shared/browser-skill.ts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };

// ── arms and mutants (single source of truth for --list, the .sh wrapper and the verdict) ───────────────────────────────────────
const ARMS = ['navigate', 'load-wait', 'read-page', 'screenshot', 'click', 'type', 'form-input', 'evaluate', 'scroll', 'reveal', 'hidden-panel', 'focus', 'table', 'skill-tabs', 'skill', 'v3claims', 'v3delta', 'v3f3'];
/** Mutants patch the BUILT bundle in place. `file`: 'chunk' = the main-process chunk main.js requires, 'cli' = dist-electron/cli.js, 'renderer' = dist/assets/index-*.js.
 *  Each edit is a regex/string that must match EXACTLY once (a refactor can never leave a mutant silently inert); `arms` must go RED, every ctl/* of those arms GREEN. */
const DROP_RE = /(\w+)\.channel\.send\((\w+),(\w+),(\w+)\)\.then\(/;
/** Acknowledge-and-ignore: the proxy answers `{}` for a forwarded CDP command (optionally only when `when` — a JS condition over $2=method $3=params — holds). */
const dropCdp = (method, when = 'true') => ({ file: 'chunk', edits: [[DROP_RE, `($2==="${method}"&&${when}?Promise.resolve({}):$1.channel.send($2,$3,$4)).then(`]] });
const MUTANTS = {
  'navigate-dropped': { ...dropCdp('Page.navigate'), arms: ['navigate'], why: 'Page.navigate is acknowledged but never reaches the page: `open` returns and nothing loads' },
  'history-dropped': { ...dropCdp('Runtime.evaluate', '/history\\.(back|forward)\\(/.test($3.expression)'), arms: ['navigate'], why: 'back/forward (history.back()) are acknowledged but the history never moves' },
  'snapshot-dropped': { ...dropCdp('Accessibility.getFullAXTree'), arms: ['read-page'], why: 'the accessibility tree is acknowledged but empty: `snapshot` lists no element and no refs' },
  'screenshot-truncated': { file: 'chunk', edits: [[/primary:async\(\)=>\(await (\w+)\.channel\.send\("Page\.captureScreenshot",(\w+)\)\)\.data/, 'primary:async()=>(await $1.channel.send("Page.captureScreenshot",$2)).data.slice(0,64)']], arms: ['screenshot'], why: 'the screenshot chain returns a truncated image' },
  'click-dropped': { ...dropCdp('Input.dispatchMouseEvent'), arms: ['click', 'table'], why: 'mouse events are acknowledged but never reach the page' },
  'insert-text-dropped': { ...dropCdp('Input.insertText'), arms: ['type', 'form-input'], why: 'text insertion (type / fill) is acknowledged but never reaches the page' },
  'eval-dropped': { ...dropCdp('Runtime.evaluate', '$3.awaitPromise===!0&&$3.expression!=="location.href"&&$3.expression!=="document.title"'), arms: ['evaluate'], why: '`eval` is acknowledged with an empty result and runs nothing' },
  'scroll-dropped': { ...dropCdp('Runtime.evaluate', '/^window\\.scrollBy\\(/.test($3.expression)'), arms: ['scroll'], why: 'window.scrollBy is acknowledged but the page never scrolls' },
  'frames-guard': { file: 'chunk', edits: [[/framesError:(\w+)=>\{/, 'framesError:$1=>{return null;']], arms: ['hidden-panel'], why: 'no up-front refusal: a background workspace\'s screenshot waits for a frame that never comes' },
  'skill-not-installed': { file: 'chunk', edits: [[/([\w$]+)\("orchestra-status",([\w$]+)\),\1\(([\w$]+),([\w$]+)\)\]\);/, '$1("orchestra-status",$2)]);']], arms: ['skill'], why: 'the installer never writes the browser skill: a new worktree has no orchestra-browser skill' },
  'load-events-dropped': { file: 'chunk', edits: [[/emit\(([\w$]+),([\w$]+),([\w$]+),([\w$]+)\)\{if\(!\1\.closed\)try\{/, 'emit($1,$2,$3,$4){if($2==="Page.loadEventFired"||$2==="Page.frameStoppedLoading")return;if(!$1.closed)try{']], arms: ['load-wait'], why: 'the proxy never tells the client the page loaded: `open` no longer returns at the load (it times out or returns early)' },
  'tab-close-preflight-off': { file: 'cli', edits: [['if (!verdict.run) {', 'if (false) {']], arms: ['skill-tabs'], why: 'the CLI hands a forbidden `tab close` of the human\'s tab to agent-browser, which prints "closed" and forgets the tab: no browser_tab_not_owner' },
  'tab-list-unannotated': { file: 'cli', edits: [['if (tab.op === "list" && run.code === 0 && abTabs && hostTabs.length > 0) {', 'if (false) {']], arms: ['skill-tabs'], why: '`tab list` no longer says who opened each tab (the skill tells the agent to read the marks before closing)' },
  'no-auto-open': { file: 'renderer', edits: [[/\.current\.set\((\w+),(\w+)\.next\),\2\.open&&/, '.current.set($1,$2.next),!1&&']], arms: ['reveal'], why: 'the renderer stops opening the pane when the agent navigates it: the user does not see what the agent browses' },
};
if (argv.includes('--list')) {
  console.log(`arms: ${ARMS.join(' ')}`);
  console.log(`mutants: ${Object.keys(MUTANTS).join(' ')}`);
  process.exit(0);
}

// --check-anchors <app-dir>: NO app, NO compositor — prove every mutant's edit still matches EXACTLY once in the built bundle (mutated files: main chunk, renderer chunk)
if (argv[0] === '--check-anchors') {
  const app = fs.realpathSync(argv[1] ?? '.');
  const chunk = /\.\/(index-[A-Za-z0-9_-]+\.js)/.exec(fs.readFileSync(path.join(app, 'dist-electron/main.js'), 'utf8'))?.[1];
  const rdir = path.join(app, 'dist/assets');
  const rchunk = fs.readdirSync(rdir).filter((n) => /^index-.*\.js$/.test(n) && fs.readFileSync(path.join(rdir, n), 'utf8').includes('onBrowserEvent'));
  let bad = 0;
  for (const [name, m] of Object.entries(MUTANTS)) {
    const file = m.file === 'cli' ? path.join(app, 'dist-electron/cli.js') : m.file === 'renderer' ? path.join(rdir, rchunk[0] ?? 'MISSING') : path.join(app, 'dist-electron', chunk);
    const src = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    const counts = m.edits.map(([from]) => (typeof from === 'string' ? src.split(from).length - 1 : (src.match(new RegExp(from.source, 'g')) ?? []).length));
    const ok = counts.every((c) => c === 1) && (m.file !== 'renderer' || rchunk.length === 1);
    if (!ok) bad++;
    console.log(`${ok ? 'OK ' : 'BAD'} ${name.padEnd(26)} ${path.basename(file)} matches=${counts.join(',')}`);
  }
  console.log(bad ? `${bad} mutant anchor(s) stale` : `all ${Object.keys(MUTANTS).length} mutant anchors match exactly once`);
  process.exit(bad ? 1 : 0);
}
const APP_DIR = argv[0] && !argv[0].startsWith('--') ? fs.realpathSync(argv[0]) : null;
const LIVE_HOME = flag('--live-home', null);
const MUTANT = flag('--mutant', null);
// a mutant run drives only the arms the mutant must redden (the unmutated full run is the all-green control)
const ARM_LIST = (flag('--arm', null) ?? (MUTANT && MUTANTS[MUTANT] ? MUTANTS[MUTANT].arms.join(',') : ARMS.join(','))).split(',');
const TRACE = argv.includes('--trace');

const refuse = (m) => { console.log(`REFUSED: ${m}`); process.exit(3); };
if (!APP_DIR) refuse('no <app-dir>');
if (!LIVE_HOME) refuse('--live-home missing (needed to protect the live ~/.claude*, ~/.config, ~/.orchestra and to prove nothing there moved)');
for (const a of ARM_LIST) if (!ARMS.includes(a)) refuse(`unknown arm ${a} (have: ${ARMS.join(', ')})`);
if (MUTANT && !MUTANTS[MUTANT]) refuse(`unknown mutant ${MUTANT} (have: ${Object.keys(MUTANTS).join(', ')})`);
const RIG_DIR = process.env.RIG_DIR;
const RIG_WAYLAND = process.env.RIG_WAYLAND;
if (!RIG_DIR || !RIG_WAYLAND) refuse('RIG_DIR / RIG_WAYLAND unset — run via scripts/e2e-browser-cli-parity.sh (the contained rig)');
if (process.env.DISPLAY) refuse(`X11 DISPLAY=${process.env.DISPLAY} is set — Electron would reach the human's screen`);
if (process.env.WAYLAND_DISPLAY !== RIG_WAYLAND || RIG_WAYLAND === 'wayland-1') refuse(`WAYLAND_DISPLAY=${process.env.WAYLAND_DISPLAY} != marker-verified ${RIG_WAYLAND}`);
const OUT = flag('--out', null) || path.join(RIG_DIR, 'shots');
const XDG = privateRuntimeDir(); // the contained rig's PRIVATE runtime dir (incident Q2) — never the human's real one

// ── scratch-containment guard (live dirs are never handed to the app) ─────────────────────────────────────────────────────────
const RIG_BASE = fs.realpathSync(path.dirname(RIG_DIR));
const liveReal = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
const LIVE_DIRS = [...fs.readdirSync(LIVE_HOME).filter((n) => n === '.claude' || n.startsWith('.claude-')).map((n) => path.join(LIVE_HOME, n)),
  path.join(LIVE_HOME, '.orchestra'), path.join(LIVE_HOME, '.config')].map(liveReal);
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

// ── helpers ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const md5 = (b) => crypto.createHash('md5').update(b).digest('hex');
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
async function waitFor(fn, ms, what) {
  const t0 = Date.now(); let last;
  while (Date.now() - t0 < ms) { try { last = await fn(); if (last) return last; } catch (e) { last = e; } await sleep(150); }
  throw new Error(`timeout ${ms}ms waiting for ${what}${last instanceof Error ? `: ${last.message}` : ''}`);
}
const freePort = () => new Promise((res, rej) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); s.on('error', rej); });
/** A page whose load takes SLOW_MS (one slow image): the oracle's `document.readyState` right after `open` tells whether `open` waited for the load (the removed `navigate` awaited loadURL). */
const SLOW_MS = 1500;
async function startSlowSite() {
  const srv = http.createServer((req, res) => {
    if (req.url?.startsWith('/slow.png')) { setTimeout(() => { res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' }); res.end(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==', 'base64')); }, SLOW_MS); return; }
    if (req.url?.startsWith('/page')) { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); res.end('<!doctype html><title>Slow page</title><h1>Slow page</h1><img src="/slow.png" width="1" height="1"><script>window.addEventListener("load", function () { window.__loadedAt = Date.now(); });</script>'); return; }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { srv, url: `http://127.0.0.1:${srv.address().port}/page` };
}
const sh = (cmd, args, opt = {}) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opt });
const git = (cwd, args, home) => sh('git', ['-c', 'user.name=rig', '-c', 'user.email=rig@example.invalid', ...args], { cwd, env: { PATH: process.env.PATH, HOME: home, GIT_CONFIG_NOSYSTEM: '1' } });

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
/** pixels that are not the image's dominant colour = painted "ink". */
function inkPx(I, tol = 6) {
  const cnt = new Map();
  for (let p = 0; p < I.w * I.h; p++) { const o = p * I.ch, k = (I.data[o] << 16) | (I.data[o + 1] << 8) | I.data[o + 2]; cnt.set(k, (cnt.get(k) || 0) + 1); }
  let mode = 0, best = -1; for (const [k, v] of cnt) if (v > best) { best = v; mode = k; }
  const mr = mode >> 16, mg = (mode >> 8) & 255, mb = mode & 255; let n = 0;
  for (let p = 0; p < I.w * I.h; p++) { const o = p * I.ch; if (Math.abs(I.data[o] - mr) > tol || Math.abs(I.data[o + 1] - mg) > tol || Math.abs(I.data[o + 2] - mb) > tol) n++; }
  return n;
}
/** JPEG dimensions from the first SOFn marker (no decoder needed): { w, h } or null when the bytes are not a JPEG. */
function jpegSize(buf) {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) { i++; continue; }
    const m = buf[i + 1];
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
    i += 2 + buf.readUInt16BE(i + 2);
  }
  return null;
}

class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); ws.onmessage = (ev) => { const m = JSON.parse(ev.data); const p = m.id && this.pending.get(m.id); if (p) { this.pending.delete(m.id); m.error ? p.rej(new Error(`${m.error.message}`)) : p.res(m.result); } }; }
  static async connect(url) { const ws = new WebSocket(url); await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws error')); }); return new Cdp(ws); }
  send(method, params = {}, ms = 20000) {
    const id = ++this.id;
    return new Promise((res, rej) => { const t = setTimeout(() => { this.pending.delete(id); rej(new Error(`CDP ${method} timed out after ${ms}ms`)); }, ms); this.pending.set(id, { res: (v) => { clearTimeout(t); res(v); }, rej: (e) => { clearTimeout(t); rej(e); } }); this.ws.send(JSON.stringify({ id, method, params })); });
  }
  async eval(expr) { const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(`eval threw: ${r.exceptionDetails.text} ${r.exceptionDetails.exception?.description ?? ''}`); return r.result.value; }
  async click(x, y) { for (const [type, extra] of [['mouseMoved', {}], ['mousePressed', { button: 'left', clickCount: 1 }], ['mouseReleased', { button: 'left', clickCount: 1 }]]) { await this.send('Input.dispatchMouseEvent', { type, x, y, ...extra }); await sleep(60); } }
  close() { try { this.ws.close(); } catch {} }
}

// ── seeding ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const WS_NAMES = ['b399-one', 'b399-two'];
function seedWorld(armDir) {
  const fakeHome = path.join(armDir, 'home'), ohome = path.join(armDir, 'oh'), cfg = path.join(armDir, 'claude-config'), repoDir = path.join(armDir, 'repo');
  for (const d of [fakeHome, ohome, cfg, repoDir]) fs.mkdirSync(d, { recursive: true });
  for (const [k, v] of Object.entries({ HOME: fakeHome, ORCHESTRA_HOME: ohome, CLAUDE_CONFIG_DIR: cfg, repo: repoDir })) mustBeScratch(k, v);
  git(repoDir, ['init', '-q', '-b', 'main'], fakeHome);
  fs.writeFileSync(path.join(repoDir, 'README.md'), '# b399 seed repo\n');
  git(repoDir, ['add', '.'], fakeHome); git(repoDir, ['commit', '-q', '-m', 'seed'], fakeHome);
  const account = { id: 'rig-b399', label: 'rig (scratch config dir)', configDir: cfg };
  mustBeScratch('account.configDir', account.configDir);
  const workspaces = WS_NAMES.map((name, i) => {
    const wt = path.join(armDir, 'wt', name);
    fs.mkdirSync(path.dirname(wt), { recursive: true });
    git(repoDir, ['worktree', 'add', '-q', '-b', `e2e/${name}`, wt], fakeHome);
    return { id: `ws-${name}`, name, repoPath: repoDir, worktreePath: wt, branch: `e2e/${name}`, baseBranch: 'main', createdAt: Date.now() + i, status: 'idle', agent: 'claude', accountId: account.id, key: crypto.randomBytes(24).toString('hex') };
  });
  const dir = path.join(ohome, 'userData', 'orchestra'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'store.json'), JSON.stringify({ repos: [{ path: repoDir, name: 'b399-repo', defaultBranch: 'main', accountId: account.id }], workspaces: workspaces.map(({ key, ...w }) => w), accounts: [account], selfTuneRuns: [] }, null, 2));
  // the host vouches for a CLI only through this registry (ADR 0008): hashes, 0600 — exactly what a fresh keeper spawn writes
  fs.writeFileSync(path.join(ohome, 'session-keys.json'), JSON.stringify({ version: 1, sessions: Object.fromEntries(workspaces.map((w) => [w.id, { hash: sha256(w.key), issuedAt: Date.now() }])) }), { mode: 0o600 });
  const stubDir = path.join(armDir, 'stub-bin'); fs.mkdirSync(stubDir, { recursive: true });
  fs.writeFileSync(path.join(stubDir, 'claude'), '#!/bin/sh\necho B399-STUB-CLAUDE "$@"\nsleep 3600\n', { mode: 0o755 });
  return { fakeHome, ohome, cfg, account, workspaces, stubDir, repoDir };
}

function listProcsByHome(home) {
  const out = [];
  for (const p of fs.readdirSync('/proc').filter((n) => /^\d+$/.test(n))) {
    try { const env = fs.readFileSync(`/proc/${p}/environ`, 'utf8').split('\0'); if (env.includes(`ORCHESTRA_HOME=${home}`)) out.push(+p); } catch {}
  }
  return out.filter((p) => p !== process.pid);
}
const environOf = (pid) => { try { return fs.readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0').filter(Boolean); } catch { return null; } };
const daemonPids = (ctx) => { const l = abLayout(ctx.world.ohome, XDG); const dir = path.join(l.socketDir, 'namespaces', 'orchestra', 'run'); const out = {}; try { for (const f of fs.readdirSync(dir)) if (f.endsWith('.pid')) out[f.slice(0, -4)] = Number(fs.readFileSync(path.join(dir, f), 'utf8').trim()); } catch {} return out; };

const results = []; // {arm, clause, ok, detail}
function clause(arm, name, ok, detail) { results.push({ arm, clause: name, ok: !!ok, detail }); console.log(`  ${ok ? 'PASS' : 'FAIL'}  [${arm}] ${name} — ${detail}`); }
/** A divergence from the removed tool that is REPORTED to the #395 member (ledger #405), not asserted green and not hidden: it never gates the verdict, and prints GAP-CLOSED the day it passes. */
const gaps = [];
function knownGap(arm, name, ok, detail, ref) { gaps.push({ arm, clause: name, closed: !!ok, detail, ref }); console.log(`  ${ok ? 'GAP-CLOSED' : 'GAP'}  [${arm}] ${name} — ${detail} (${ref})`); }
const shots = [];
function saveShot(name, buf) { fs.mkdirSync(OUT, { recursive: true }); const f = path.join(OUT, name); fs.writeFileSync(f, buf); shots.push({ file: f, md5: md5(buf) }); return f; }

// ── mutants: patch the BUILT bundle in place; restore byte-exact and prove it with cmp ──────────────────────────────────────────
let mutantRestore = null;
function mutantTarget(kind) {
  if (kind === 'cli') return path.join(APP_DIR, 'dist-electron/cli.js');
  if (kind === 'renderer') {
    const dir = path.join(APP_DIR, 'dist/assets');
    const hits = fs.readdirSync(dir).filter((n) => /^index-.*\.js$/.test(n) && fs.readFileSync(path.join(dir, n), 'utf8').includes('onBrowserEvent'));
    if (hits.length !== 1) refuse(`renderer chunk with onBrowserEvent: ${hits.length} match(es) in ${dir} (need exactly 1)`);
    return path.join(dir, hits[0]);
  }
  const m = /\.\/(index-[A-Za-z0-9_-]+\.js)/.exec(fs.readFileSync(path.join(APP_DIR, 'dist-electron/main.js'), 'utf8'));
  if (!m) refuse('cannot resolve the main-process chunk from dist-electron/main.js');
  return path.join(APP_DIR, 'dist-electron', m[1]);
}
const MARKER = path.join(APP_DIR ?? '/nonexistent', 'dist-electron', '.b399-mutant-active');
function applyMutant() {
  if (fs.existsSync(MARKER)) refuse(`${MARKER} exists — an earlier mutant run died without restoring the bundle: ${fs.readFileSync(MARKER, 'utf8').trim()} (restore it from that backup, or rebuild, then delete the marker)`);
  if (!MUTANT) return;
  const m = MUTANTS[MUTANT], file = mutantTarget(m.file), backup = path.join(RIG_DIR, `mutant-backup-${path.basename(file)}`);
  let src = fs.readFileSync(file, 'utf8');
  for (const [from, to] of m.edits) {
    const hits = typeof from === 'string' ? src.split(from).length - 1 : (src.match(new RegExp(from.source, 'g')) ?? []).length;
    if (hits !== 1) refuse(`mutant ${MUTANT}: ${String(from).slice(0, 70)} occurs ${hits}x in ${path.basename(file)} (must be exactly 1) — the bundle changed, update the mutant`);
    src = typeof from === 'string' ? src.replace(from, () => to) : src.replace(from, to);
  }
  fs.copyFileSync(file, backup);
  fs.writeFileSync(MARKER, `${backup} -> ${file}\n`);
  fs.writeFileSync(file, src);
  console.log(`[mutant] ${MUTANT} applied to ${path.basename(file)} (${m.edits.length} edit(s)): ${m.why}; backup ${backup}`);
  mutantRestore = () => { fs.copyFileSync(backup, file); try { sh('cmp', [backup, file]); fs.rmSync(MARKER, { force: true }); console.log(`[mutant] ${MUTANT} restored byte-exact (cmp OK)`); } catch { console.log(`[mutant] RESTORE NOT BYTE-EXACT — rebuild ${path.basename(file)}`); process.exitCode = 4; } };
}
process.on('exit', () => { try { mutantRestore?.(); } catch {} });
process.on('SIGINT', () => process.exit(130));
process.on('SIGTERM', () => process.exit(143));

// ── one world, all arms ───────────────────────────────────────────────────────────────────────────────────────────────────────
async function main() {
  const armDir = path.join(RIG_DIR, 'world'); fs.mkdirSync(armDir, { recursive: true });
  const world = seedWorld(armDir);
  const [W1, W2] = world.workspaces;
  const fixture = spawn(process.execPath, [path.join(repoRoot, 'scripts/fixtures/browser-site/server.mjs'), '0'], { env: { PATH: process.env.PATH }, stdio: ['ignore', 'pipe', 'inherit'] });
  const FIX = await new Promise((res, rej) => { let b = ''; fixture.stdout.on('data', (d) => { b += d; const m = /LISTENING (\d+)/.exec(b); if (m) res(`http://127.0.0.1:${m[1]}`); }); fixture.on('exit', () => rej(new Error('fixture exited'))); setTimeout(() => rej(new Error('fixture never listened')), 8000); });
  console.log(`[rig] fixture ${FIX}`);

  sh('swaymsg', ['output', 'HEADLESS-1', 'resolution', '1400x900']);
  sh('swaymsg', ['default_border', 'none']);
  const port = await freePort();
  const env = { PATH: `${world.stubDir}:/usr/local/bin:/usr/bin:/bin`, HOME: world.fakeHome, XDG_RUNTIME_DIR: XDG, XDG_CONFIG_HOME: path.join(world.fakeHome, '.config'), XDG_CACHE_HOME: path.join(world.fakeHome, '.cache'),
    WAYLAND_DISPLAY: RIG_WAYLAND, SWAYSOCK: process.env.SWAYSOCK, ELECTRON_OZONE_PLATFORM_HINT: 'wayland', ORCHESTRA_OZONE: 'wayland', ORCHESTRA_OZONE_RELAUNCHED: '1',
    ORCHESTRA_HOME: world.ohome, ORCHESTRA_DEBUG_PORT: String(port), ORCHESTRA_SELF_TUNE_CMD: '/bin/true', CLAUDE_CONFIG_DIR: world.cfg, LANG: 'C.UTF-8', ORCHESTRA_CDP_RELEASE_GRACE_MS: '1500', ...(TRACE ? { ORCHESTRA_CDP_TRACE: '1' } : {}) };
  for (const k of ['HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'ORCHESTRA_HOME', 'CLAUDE_CONFIG_DIR']) mustBeScratch(`env.${k}`, env[k]);
  if ('DISPLAY' in env || env.WAYLAND_DISPLAY !== RIG_WAYLAND) refuse('child env would reach the human display');
  const logFile = path.join(armDir, 'app.log');
  const fd = fs.openSync(logFile, 'w');
  const app = spawn(path.join(APP_DIR, 'node_modules/electron/dist/electron'), [APP_DIR, '--ozone-platform=wayland'], { cwd: APP_DIR, env, stdio: ['ignore', fd, fd], detached: true });
  console.log(`[rig] app pid ${app.pid} debug port ${port} log ${logFile}`);
  let ui;
  const targets = async () => (await (await fetch(`http://127.0.0.1:${port}/json`)).json());
  try {
    const target = await waitFor(async () => (await targets()).find((x) => x.type === 'page' && x.url.includes('dist/index.html')) || null, 60000, 'the app page target');
    clause('ctl', 'app-identity-path', target.url.includes(APP_DIR) && !target.url.includes('app.asar'), `target url ${target.url} ⊇ ${APP_DIR}`);
    ui = await Cdp.connect(target.webSocketDebuggerUrl);
    await ui.send('Page.enable');
    // Assert what the DRIVER handed the app: Chromium may rewrite /proc/<pid>/environ once a bus var is present (seat 2 F2), so the process view is informational only
    clause('ctl', 'scratch-env', env.ORCHESTRA_HOME === world.ohome && env.CLAUDE_CONFIG_DIR === world.cfg && env.HOME === world.fakeHome && env.XDG_RUNTIME_DIR === XDG && !('DISPLAY' in env) && !('DBUS_SESSION_BUS_ADDRESS' in env) && env.WAYLAND_DISPLAY === RIG_WAYLAND,
      `env handed to the app: ORCHESTRA_HOME=${env.ORCHESTRA_HOME} CLAUDE_CONFIG_DIR=${env.CLAUDE_CONFIG_DIR} XDG_RUNTIME_DIR=${env.XDG_RUNTIME_DIR} (the rig's private dir) WAYLAND_DISPLAY=${env.WAYLAND_DISPLAY} DISPLAY=${'DISPLAY' in env ? env.DISPLAY : '<unset>'} DBUS=${'DBUS_SESSION_BUS_ADDRESS' in env ? 'SET' : '<unset>'}`);
    const ctx = { world, W1, W2, FIX, port, app, ui, targets, env, logFile };
    await runArms(ctx);
  } catch (e) {
    clause('rig', 'completed', false, `ABORTED: ${e.stack || e}`);
  } finally {
    ui?.close();
    try { process.kill(-app.pid, 'SIGTERM'); } catch {}
    await sleep(2000);
    try { process.kill(-app.pid, 'SIGKILL'); } catch {}
    try { fixture.kill('SIGKILL'); } catch {}
    { // daemons a refused-then-leaked mutant run may have left (they carry no ORCHESTRA_HOME), then the scratch socket dir — only ever THIS ORCHESTRA_HOME's hashed one
      const l = abLayout(world.ohome, XDG);
      for (const pid of Object.values(daemonPids({ world }))) { if (environOf(pid)?.includes(`AGENT_BROWSER_SOCKET_DIR=${l.socketDir}`)) { try { process.kill(pid, 'SIGKILL'); } catch {} } }
      if (/\/orch-ab-[0-9a-f]{8}$/.test(l.socketDir) && l.socketDir.startsWith((XDG ?? '/nonexistent') + '/')) fs.rmSync(l.socketDir, { recursive: true, force: true });
    }
    for (const p of listProcsByHome(world.ohome)) { try { process.kill(p, 'SIGKILL'); } catch {} }
    let left = listProcsByHome(world.ohome);
    for (let i = 0; i < 20 && left.length > 0; i++) { await sleep(250); left = listProcsByHome(world.ohome); }
    clause('ctl', 'teardown-no-survivors', left.length === 0, `processes still carrying ${world.ohome}: ${left.length ? left.join(',') : 'none'}`);
  }
}

// ── driving helpers ─────────────────────────────────────────────────────────────────────────────────────────────────────────
const sel = (n) => JSON.stringify(n);
async function selectWs(ctx, W) {
  const { ui } = ctx;
  const pos = await ui.eval(`(() => { const n = [...document.querySelectorAll('.ws-item .ws-name')].find((e) => e.textContent.trim() === ${sel(W.branch)}); if (!n) return null; const b = n.getBoundingClientRect(); return { x: b.left + 20, y: b.top + b.height / 2 }; })()`);
  if (!pos) throw new Error(`sidebar row for ${W.branch} not found`);
  await ui.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pos.x, y: pos.y });
  await ui.click(pos.x, pos.y);
  await waitFor(() => ui.eval(`!!([...document.querySelectorAll('.ws-item.active .ws-name')].find((e) => e.textContent.trim() === ${sel(W.branch)}))`), 15000, `${W.branch} to become the active workspace`);
}
const paneToggle = (ctx) => ctx.ui.eval(`(() => { const b = document.querySelector('button[aria-label="Show browser pane"],button[aria-label="Hide browser pane"]'); if (!b) return null; const r = b.getBoundingClientRect(); return { open: b.getAttribute('aria-label') === 'Hide browser pane', x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
const paneVisible = (ctx) => ctx.ui.eval(`!!document.querySelector('.browser-panel:not(.browser-panel-hidden) .browser-url-input')`);
async function clickToggle(ctx) {
  const state = await paneToggle(ctx);
  if (!state) throw new Error('browser pane toggle not found');
  await ctx.ui.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: state.x, y: state.y }); await ctx.ui.click(state.x, state.y);
}
async function openPane(ctx) {
  const state = await paneToggle(ctx);
  if (!state) throw new Error('browser pane toggle not found');
  if (!state.open) await clickToggle(ctx);
  await waitFor(() => paneVisible(ctx), 15000, 'the Browser pane to be open');
}
/** The REAL CLI bundle, with an `env -i` allowlist: exactly what an agent's Bash tool hands it. */
const cliEnv = (ctx, W, { env: extra = {}, key } = {}) => {
  const base = { PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`, HOME: ctx.world.fakeHome, ORCHESTRA_HOME: ctx.world.ohome, ORCHESTRA_WS_ID: W.id, ORCHESTRA_SESSION_KEY: key ?? W.key,
    ORCHESTRA_AGENT_TMPDIR: path.join(ctx.world.fakeHome, 'agent-tmp', W.name), LANG: 'C.UTF-8', ...extra };
  fs.mkdirSync(base.ORCHESTRA_AGENT_TMPDIR, { recursive: true });
  return base;
};
function cli(ctx, W, args, { env: extra = {}, timeoutMs = 60000, key } = {}) {
  const base = cliEnv(ctx, W, { env: extra, key });
  const t0 = Date.now();
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(APP_DIR, 'dist-electron/cli.js'), 'browser', ...args], { env: base, stdio: ['ignore', 'pipe', 'pipe'], cwd: ctx.world.fakeHome, detached: true });
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => (stdout += d)); child.stderr.on('data', (d) => (stderr += d));
    const timer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch {} } }, timeoutMs);
    child.on('close', (code, signal) => { clearTimeout(timer); resolve({ code: code ?? (signal ? 137 : 0), stdout, stderr, ms: Date.now() - t0 }); });
  });
}
const show = (r) => `rc=${r.code} ${r.ms}ms stdout=${JSON.stringify(r.stdout.trim().slice(0, 160))} stderr=${JSON.stringify(r.stderr.trim().slice(0, 200))}`;
/** Independent oracle: a second CDP client on the panel's page through the APP's own remote-debugging port. */
async function oracle(ctx, urlPrefix, ms = 15000) {
  const t = await waitFor(async () => (await ctx.targets()).find((x) => x.type === 'page' && x.url.startsWith(urlPrefix)) || null, ms, `a panel page at ${urlPrefix}`);
  return Cdp.connect(t.webSocketDebuggerUrl);
}
const refOf = (snapshot, role, name) => { const m = new RegExp(`${role} "${name}\\s*"[^\\n]*ref=(e\\d+)`).exec(snapshot); return m ? `@${m[1]}` : null; };
/** Put the human's keyboard focus in the workspace composer (the CodeMirror editor in the renderer DOM) with a TRUSTED click, and report whether it is there. */
const composerFocus = (ctx) => ctx.ui.eval(`(() => { const t = document.querySelector('.av-composer .cm-content'); return t ? { onComposer: document.activeElement === t, windowFocus: document.hasFocus() } : null; })()`);
const focusComposer = async (ctx) => {
  const pos = await ctx.ui.eval(`(() => { const t = document.querySelector('.av-composer .cm-content'); if (!t) return null; const r = t.getBoundingClientRect(); return { x: r.left + Math.min(40, r.width / 2), y: r.top + r.height / 2 }; })()`);
  if (!pos) return null;
  await ctx.ui.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pos.x, y: pos.y });
  await ctx.ui.click(pos.x, pos.y);
  await sleep(250);
  return composerFocus(ctx);
};
const regTabs = async (ctx, W) => (await ctx.ui.eval(`window.orchestra.browserState(${sel(W.id)})`));
/** Open `url` on W through the CLI and hand back a fresh oracle on the loaded page. */
async function openOn(ctx, W, url) {
  const u = `${url}${url.includes('?') ? '&' : '?'}w=${W.name}`; // one page per workspace: two panels on the same url would make the oracle ambiguous
  const r = await cli(ctx, W, ['open', u]);
  const o = await oracle(ctx, u);
  return { r, o };
}

const ARM_FNS = {
  async navigate(ctx) {
    const { W1, FIX } = ctx; const A = 'navigate';
    await selectWs(ctx, W1); await openPane(ctx);
    clause(A, 'ctl/pane-open', true, `${W1.branch} active, Browser pane open`);
    const a = await cli(ctx, W1, ['open', `${FIX}/parity.html`]);
    const o = await oracle(ctx, `${FIX}/parity.html`).catch(() => null);
    const title = o ? await o.eval('document.title') : null;
    clause(A, 'open-url-loads-the-page', a.code === 0 && title === 'Parity fixture', `${show(a)} → oracle title ${JSON.stringify(title)}`);
    o?.close();
    // a scheme-less host gets https:// (old tool: "a bare domain gets https:// prepended"): the plain-http fixture then answers with a TLS error, which names the scheme that was tried
    const bare = FIX.replace(/^http:\/\//, '');
    const b = await cli(ctx, W1, ['open', `${bare}/index.html`]);
    clause(A, 'bare-host-gets-https', b.code !== 0 && /ERR_SSL_PROTOCOL_ERROR/.test(b.stderr), `open ${bare}/index.html → ${show(b)} (https:// was prepended; an explicit ${FIX}/… works, see open-url-loads-the-page)`);
    // file: URLs (the old tool allowed http/https/file)
    const f = path.join(ctx.world.fakeHome, 'local.html'); fs.writeFileSync(f, '<!doctype html><title>Local file</title><p>from disk</p>');
    const fo = await cli(ctx, W1, ['open', `file://${f}`]);
    const ofile = await oracle(ctx, `file://${f}`, 8000).catch(() => null);
    clause(A, 'file-url-opens', fo.code === 0 && !!ofile && (await ofile.eval('document.title')) === 'Local file', `open file://… → ${show(fo)}; oracle title ${ofile ? JSON.stringify(await ofile.eval('document.title')) : 'NO PAGE'}`);
    ofile?.close();
    // back / forward walk the page history
    await cli(ctx, W1, ['open', `${FIX}/parity.html`]);
    await cli(ctx, W1, ['open', `${FIX}/cli.html`]);
    const ob = await oracle(ctx, `${FIX}/cli.html`);
    const bk = await cli(ctx, W1, ['back']);
    const atBack = await waitFor(() => ob.eval('location.pathname').then((p) => p === '/parity.html' ? p : null), 8000, 'back to /parity.html').catch(() => null);
    clause(A, 'back-moves-history', bk.code === 0 && atBack === '/parity.html', `${show(bk)} → oracle path ${JSON.stringify(await ob.eval('location.pathname'))}`);
    const fw = await cli(ctx, W1, ['forward']);
    const atFwd = await waitFor(() => ob.eval('location.pathname').then((p) => p === '/cli.html' ? p : null), 8000, 'forward to /cli.html').catch(() => null);
    clause(A, 'forward-moves-history', fw.code === 0 && atFwd === '/cli.html', `${show(fw)} → oracle path ${JSON.stringify(await ob.eval('location.pathname'))}`);
    ob.close();
    // a failing load is reported, not swallowed (old tool: "Navigated to … (error: …)")
    const dead = await freePort();
    const bad = await cli(ctx, W1, ['open', `http://127.0.0.1:${dead}/nothing`], { timeoutMs: 45000 });
    clause(A, 'unreachable-url-is-reported', bad.code !== 0 && /ERR_|refused|fail|error/i.test(bad.stderr + bad.stdout), `open http://127.0.0.1:${dead}/ (nothing listens) → ${show(bad)}`);
    await cli(ctx, W1, ['open', `${FIX}/parity.html`]);
  },
};


const ARM_FNS2 = {
  async 'read-page'(ctx) {
    const { W1, FIX } = ctx; const A = 'read-page';
    await selectWs(ctx, W1); await openPane(ctx);
    const { o } = await openOn(ctx, W1, `${FIX}/parity.html`);
    try {
      const inter = await cli(ctx, W1, ['snapshot', '-i']);
      console.log(`    [probe] snapshot -i:\n${inter.stdout.split('\n').map((l) => '      ' + l).join('\n')}`);
      const refs = { go: refOf(inter.stdout, 'button', 'Go'), name: refOf(inter.stdout, 'textbox', 'Name'), msg: refOf(inter.stdout, 'textbox', 'Message'), typed: refOf(inter.stdout, 'textbox', 'Typed'), home: refOf(inter.stdout, 'link', 'Home'), coord: refOf(inter.stdout, 'button', 'Coord target') };
      const all = Object.values(refs);
      clause(A, 'interactive-outline-lists-every-control-with-a-ref', inter.code === 0 && all.every(Boolean) && new Set(all).size === all.length, `rc=${inter.code}; refs ${JSON.stringify(refs)} (button Go, textbox Name/Message/Typed, link Home, button Coord target — one distinct @eN each)`);
      const full = await cli(ctx, W1, ['snapshot']);
      clause(A, 'full-outline-carries-the-page-text', full.code === 0 && /heading "Parity fixture"/.test(full.stdout) && /idle/.test(full.stdout) && /Far down the page/.test(full.stdout), `snapshot (no -i) has the heading, the #out text "idle" and the far paragraph: ${/heading "Parity fixture"/.test(full.stdout)}/${/idle/.test(full.stdout)}/${/Far down the page/.test(full.stdout)}`);
      const txt = await cli(ctx, W1, ['get', 'text', refs.go ?? '@e0']);
      clause(A, 'ref-resolves-to-its-own-element', txt.code === 0 && txt.stdout.trim() === 'Go', `get text ${refs.go} → ${JSON.stringify(txt.stdout.trim())} (the Go button's own label)`);
      await o.eval(`document.getElementById('out').textContent = 'changed-by-the-oracle'`);
      const live = await cli(ctx, W1, ['snapshot']);
      clause(A, 'outline-reads-the-live-page', /changed-by-the-oracle/.test(live.stdout) && !/\bidle\b/.test(live.stdout), `after the oracle rewrote #out the next snapshot shows it (and no longer "idle"): ${/changed-by-the-oracle/.test(live.stdout)}/${!/\bidle\b/.test(live.stdout)}`);
    } finally { o.close(); }
  },

  async screenshot(ctx) {
    const { W1, FIX } = ctx; const A = 'screenshot';
    await selectWs(ctx, W1); await openPane(ctx);
    const { o } = await openOn(ctx, W1, `${FIX}/parity.html`);
    try {
      const dir = path.join(ctx.world.fakeHome, 'shots'); fs.mkdirSync(dir, { recursive: true });
      const png = path.join(dir, 'p.png');
      const r = await cli(ctx, W1, ['screenshot', png]);
      let img = null, err = '';
      try { img = decodePng(fs.readFileSync(png)); } catch (e) { err = String(e.message ?? e); }
      const ref = decodePng(Buffer.from((await o.send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
      clause(A, 'png-is-the-painted-page', r.code === 0 && !!img && inkPx(img) > 400 && Math.abs(img.w - ref.w) <= 2 && Math.abs(img.h - ref.h) <= 2, `${show(r)} → ${img ? `${img.w}x${img.h}, ${inkPx(img)} ink px` : `unreadable: ${err}`}; the oracle's own capture of the same view is ${ref.w}x${ref.h}`);
      if (img) saveShot('parity-screenshot.png', fs.readFileSync(png));
      const lo = path.join(dir, 'q20.jpg'), hi = path.join(dir, 'q90.jpg');
      const rl = await cli(ctx, W1, ['screenshot', lo, '--screenshot-format', 'jpeg', '--screenshot-quality', '20']);
      const rh = await cli(ctx, W1, ['screenshot', hi, '--screenshot-format', 'jpeg', '--screenshot-quality', '90']);
      const bl = fs.existsSync(lo) ? fs.readFileSync(lo) : Buffer.alloc(0), bh = fs.existsSync(hi) ? fs.readFileSync(hi) : Buffer.alloc(0);
      const sl = jpegSize(bl), sh2 = jpegSize(bh);
      clause(A, 'jpeg-with-quality', rl.code === 0 && rh.code === 0 && !!sl && !!sh2 && sl.w === sh2.w && Math.abs(sl.w - ref.w) <= 2 && bl.length < bh.length, `q20 ${sl ? `${sl.w}x${sl.h}` : 'NOT A JPEG'} ${bl.length} B < q90 ${sh2 ? `${sh2.w}x${sh2.h}` : 'NOT A JPEG'} ${bh.length} B (old tool: quality 1-100, JPEG)`);
      // the file extension does NOT pick the format, and flags placed BEFORE the path are mangled by absolutizeBrowserArgs (the format VALUE is taken for the path)
      const ext = path.join(dir, 'ext.jpg'); await cli(ctx, W1, ['screenshot', ext]);
      const flagFirst = path.join(dir, 'flagfirst.jpg'); const ff = await cli(ctx, W1, ['screenshot', '--screenshot-format', 'jpeg', flagFirst]);
      const bf = fs.existsSync(flagFirst) ? fs.readFileSync(flagFirst) : Buffer.alloc(0);
      clause(A, 'extension-alone-writes-png-bytes', fs.existsSync(ext) && jpegSize(fs.readFileSync(ext)) === null, `screenshot x.jpg (no format flag) → ${fs.existsSync(ext) ? `${fs.readFileSync(ext).subarray(0, 4).toString('hex')} (PNG magic 89504e47): the extension does not choose the format` : 'no file'}`);
      clause(A, 'format-flag-before-the-path-works', ff.code === 0 && jpegSize(bf) !== null, `screenshot --screenshot-format jpeg x.jpg → ${show(ff)}; magic ${bf.subarray(0, 4).toString('hex')} (#395 e7750089 fixed the flag VALUE being taken for the path)`);
      const eqf = path.join(dir, 'eq.jpg'); const eq = await cli(ctx, W1, ['screenshot', eqf, '--screenshot-format=jpeg', '--screenshot-quality=30']);
      clause(A, 'equals-form-flags-are-honoured', eq.code === 0 && jpegSize(fs.existsSync(eqf) ? fs.readFileSync(eqf) : Buffer.alloc(0)) !== null && !fs.existsSync(path.join(APP_DIR, '--screenshot-quality=30')), `screenshot x.jpg --screenshot-format=jpeg --screenshot-quality=30 → ${show(eq)}; no file named like the flag in the host's cwd`);
      // a bare `screenshot` lands under the agent's own tmp dir and prints where
      const bare = await cli(ctx, W1, ['screenshot']);
      const printed = (/(\/\S+\.png)/.exec(bare.stdout) ?? [])[1];
      clause(A, 'no-path-saves-under-the-agents-tmp-and-prints-it', bare.code === 0 && !!printed && printed.startsWith(path.join(ctx.world.fakeHome, 'agent-tmp', W1.name)) && fs.existsSync(printed), `${show(bare)} → printed ${printed ?? '<none>'} (must be under ORCHESTRA_AGENT_TMPDIR)`);
    } finally { o.close(); }
  },

  async click(ctx) {
    const { W1, FIX } = ctx; const A = 'click';
    await selectWs(ctx, W1); await openPane(ctx);
    const { o } = await openOn(ctx, W1, `${FIX}/parity.html`);
    try {
      const reset = () => o.eval(`document.getElementById('out').textContent = 'idle'`);
      const snap = await cli(ctx, W1, ['snapshot', '-i']); const go = refOf(snap.stdout, 'button', 'Go');
      clause(A, 'ctl/precondition-idle', (await o.eval(`document.getElementById('out').textContent`)) === 'idle' && !!go, `#out idle before any click, Go ref ${go}`);
      const byRef = await cli(ctx, W1, ['click', go ?? '@e0']);
      const afterRef = await o.eval(`document.getElementById('out').textContent`);
      clause(A, 'click-by-ref', byRef.code === 0 && afterRef === 'clicked', `${show(byRef)} → oracle #out ${JSON.stringify(afterRef)}`);
      await reset();
      const rect = await o.eval(`(() => { const r = document.getElementById('coord').getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), right: r.right, top: r.top, h: r.height }; })()`);
      // a miss: the same three-command click one button-width to the right of the target must NOT trigger it (the clause below cannot be satisfied by "any click works")
      const miss = [await cli(ctx, W1, ['mouse', 'move', String(rect.right + 80), String(rect.y)]), await cli(ctx, W1, ['mouse', 'down']), await cli(ctx, W1, ['mouse', 'up'])];
      const afterMiss = await o.eval(`document.getElementById('out').textContent`);
      clause(A, 'ctl/click-beside-the-target-does-nothing', miss.every((m) => m.code === 0) && afterMiss === 'idle', `mouse move/down/up at (${rect.right + 80}, ${rect.y}) → rc ${miss.map((m) => m.code).join(',')}, #out ${JSON.stringify(afterMiss)}`);
      const hit = [await cli(ctx, W1, ['mouse', 'move', String(rect.x), String(rect.y)]), await cli(ctx, W1, ['mouse', 'down']), await cli(ctx, W1, ['mouse', 'up'])];
      const afterHit = await o.eval(`document.getElementById('out').textContent`);
      clause(A, 'click-by-coordinates', hit.every((m) => m.code === 0) && afterHit === `coord:${rect.x},${rect.y}`, `mouse move/down/up at (${rect.x}, ${rect.y}) → rc ${hit.map((m) => m.code).join(',')}, oracle #out ${JSON.stringify(afterHit)} (the page saw the click at exactly those viewport coordinates)`);
    } finally { o.close(); }
  },

  async type(ctx) {
    const { W1, FIX } = ctx; const A = 'type';
    await selectWs(ctx, W1); await openPane(ctx);
    const { o } = await openOn(ctx, W1, `${FIX}/parity.html`);
    try {
      const snap = await cli(ctx, W1, ['snapshot', '-i']); const typed = refOf(snap.stdout, 'textbox', 'Typed');
      clause(A, 'ctl/precondition-empty', (await o.eval(`document.getElementById('typed').value`)) === '' && !!typed, `#typed empty, ref ${typed}`);
      await cli(ctx, W1, ['click', typed ?? '@e0']);
      const focused = await o.eval(`document.activeElement && document.activeElement.id`);
      const kt = await cli(ctx, W1, ['keyboard', 'type', 'abc']);
      const v1 = await o.eval(`({ value: document.getElementById('typed').value, keys: document.getElementById('keys').textContent, inputs: document.getElementById('tin').textContent })`);
      clause(A, 'type-into-the-focused-element', focused === 'typed' && kt.code === 0 && v1.value === 'abc' && v1.inputs === 'in;in;in;', `focus after click: ${focused}; keyboard type abc → ${show(kt)} → oracle value ${JSON.stringify(v1.value)}, input events ${JSON.stringify(v1.inputs)} (one per character, as the old tool's Input.insertText; keydown log ${JSON.stringify(v1.keys)} — neither sends key events: use \`press\` for those)`);
      const ty = await cli(ctx, W1, ['type', typed ?? '@e0', 'def']);
      const v2 = await o.eval(`document.getElementById('typed').value`);
      clause(A, 'type-into-an-element-by-ref', ty.code === 0 && v2 === 'abcdef', `type ${typed} def → ${show(ty)} → oracle value ${JSON.stringify(v2)}`);
    } finally { o.close(); }
  },

  async 'form-input'(ctx) {
    const { W1, FIX } = ctx; const A = 'form-input';
    await selectWs(ctx, W1); await openPane(ctx);
    const { o } = await openOn(ctx, W1, `${FIX}/parity.html`);
    try {
      const snap = await cli(ctx, W1, ['snapshot', '-i']); const name = refOf(snap.stdout, 'textbox', 'Name'), msg = refOf(snap.stdout, 'textbox', 'Message');
      const read = () => o.eval(`({ name: document.getElementById('name').value, msg: document.getElementById('msg').value, log: document.getElementById('evlog').textContent })`);
      const v0 = await read();
      clause(A, 'ctl/precondition-empty', v0.name === '' && v0.msg === '' && v0.log === '' && !!name && !!msg, `fields empty, no events yet; refs ${name} ${msg}`);
      const f1 = await cli(ctx, W1, ['fill', name ?? '@e0', 'hello orchestra']);
      const v1 = await read();
      clause(A, 'fill-sets-value-and-fires-input', f1.code === 0 && v1.name === 'hello orchestra' && /name:input;/.test(v1.log), `${show(f1)} → oracle value ${JSON.stringify(v1.name)}, events ${JSON.stringify(v1.log)}`);
      const f2 = await cli(ctx, W1, ['fill', name ?? '@e0', 'second']);
      const v2 = await read();
      clause(A, 'fill-replaces-it-does-not-append', f2.code === 0 && v2.name === 'second', `second fill → oracle value ${JSON.stringify(v2.name)} (form_input SET the value)`);
      clause(A, 'fill-alone-does-not-fire-change', !/name:change;/.test(v2.log), `events after two fills ${JSON.stringify(v2.log)} — no change yet: it fires when the field is left (old form_input dispatched it itself; the skill says to press Tab)`);
      const tab = await cli(ctx, W1, ['press', 'Tab']);
      const v4 = await read();
      clause(A, 'change-fires-when-the-field-is-left', tab.code === 0 && /name:change;/.test(v4.log), `press Tab → ${show(tab)} → events ${JSON.stringify(v4.log)}`);
      const f3 = await cli(ctx, W1, ['fill', msg ?? '@e0', 'a longer message']);
      const v3 = await read();
      clause(A, 'fill-works-on-a-textarea', f3.code === 0 && v3.msg === 'a longer message' && /msg:input;/.test(v3.log), `${show(f3)} → oracle textarea ${JSON.stringify(v3.msg)}, events ${JSON.stringify(v3.log)}`);
    } finally { o.close(); }
  },

  async evaluate(ctx) {
    const { W1, FIX } = ctx; const A = 'evaluate';
    await selectWs(ctx, W1); await openPane(ctx);
    const { o } = await openOn(ctx, W1, `${FIX}/parity.html`);
    try {
      const t = await cli(ctx, W1, ['eval', 'document.title']);
      clause(A, 'string-result', t.code === 0 && /Parity fixture/.test(t.stdout), show(t));
      const j = await cli(ctx, W1, ['eval', '({a: 1, b: [2, 3], c: "x"})']);
      let parsed = null; try { parsed = JSON.parse(j.stdout.trim()); } catch {}
      clause(A, 'object-result-is-json', j.code === 0 && parsed && parsed.a === 1 && JSON.stringify(parsed.b) === '[2,3]' && parsed.c === 'x', show(j));
      const p = await cli(ctx, W1, ['eval', "fetch('/whoami').then((r) => r.text())"]);
      clause(A, 'promise-is-awaited', p.code === 0 && /anon/.test(p.stdout), show(p));
      const m = await cli(ctx, W1, ['eval', "document.getElementById('out').textContent = 'evaled'; 'ok'"]);
      const after = await o.eval(`document.getElementById('out').textContent`);
      clause(A, 'runs-in-the-page', m.code === 0 && after === 'evaled', `${show(m)} → oracle #out ${JSON.stringify(after)}`);
      const c1 = await cli(ctx, W1, ['eval', 'const zz399 = 1; zz399']);
      const c2 = await cli(ctx, W1, ['eval', 'const zz399 = 2; zz399']);
      const i1 = await cli(ctx, W1, ['eval', '(() => { const yy399 = 1; return yy399; })()']);
      const i2 = await cli(ctx, W1, ['eval', '(() => { const yy399 = 2; return yy399; })()']);
      clause(A, 'repeated-top-level-const-fails-an-iife-does-not', c1.code === 0 && c2.code !== 0 && /already been declared/.test(c2.stderr + c2.stdout) && i1.code === 0 && i2.code === 0 && i2.stdout.trim() === '2', `top-level const twice: ${show(c1)} then ${show(c2)}; the same in an IIFE: ${show(i1)} then ${show(i2)}`);
      const bad = await cli(ctx, W1, ['eval', "throw new Error('boom-399')"]);
      clause(A, 'page-error-is-reported', bad.code !== 0 && /boom-399/.test(bad.stderr + bad.stdout), show(bad));
    } finally { o.close(); }
  },

  async scroll(ctx) {
    const { W1, FIX } = ctx; const A = 'scroll';
    await selectWs(ctx, W1); await openPane(ctx);
    const { o } = await openOn(ctx, W1, `${FIX}/parity.html`);
    try {
      const y = () => o.eval(`Math.round(window.scrollY)`);
      clause(A, 'ctl/starts-at-the-top', (await y()) === 0, `scrollY ${await y()} before any scroll`);
      const d = await cli(ctx, W1, ['scroll', 'down', '600']);
      const y1 = await y();
      clause(A, 'scroll-down-by-pixels', d.code === 0 && Math.abs(y1 - 600) <= 2, `${show(d)} → oracle scrollY ${y1} (old tool: deltaY 600)`);
      const u = await cli(ctx, W1, ['scroll', 'up', '200']);
      const y2 = await y();
      clause(A, 'scroll-up-by-pixels', u.code === 0 && Math.abs(y2 - 400) <= 2, `${show(u)} → oracle scrollY ${y2} (old tool: negative deltaY)`);
      const snap = await cli(ctx, W1, ['snapshot']);
      const si = await cli(ctx, W1, ['scrollintoview', '#far']);
      const y3 = await y();
      clause(A, 'scrollintoview-reaches-far-content', si.code === 0 && y3 > 3000, `${show(si)} → oracle scrollY ${y3}`);
      void snap;
    } finally { o.close(); }
  },

  async reveal(ctx) {
    const { W1, FIX, ui } = ctx; const A = 'reveal';
    await selectWs(ctx, W1); await openPane(ctx);
    await cli(ctx, W1, ['open', `${FIX}/cli.html`]);
    if ((await paneToggle(ctx)).open) await clickToggle(ctx);
    await waitFor(async () => !(await paneVisible(ctx)), 10000, 'the pane to close');
    clause(A, 'ctl/pane-closed-by-the-user', !(await paneVisible(ctx)), `the user closed the Browser pane (toolbar toggle)`);
    const quiet = await cli(ctx, W1, ['snapshot', '-i']);
    await sleep(1200);
    clause(A, 'ctl/a-read-only-command-does-not-open-it', quiet.code === 0 && !(await paneVisible(ctx)), `snapshot ${show(quiet)} → pane visible: ${await paneVisible(ctx)} (only a navigation reveals the pane)`);
    const nav = await cli(ctx, W1, ['open', `${FIX}/index.html`]);
    const opened = await waitFor(() => paneVisible(ctx), 10000, 'the pane to open for the agent').catch(() => false);
    const urlInBar = await ui.eval(`(document.querySelector('.browser-url-input') || {}).value || null`);
    clause(A, 'navigation-opens-the-pane-for-the-user', nav.code === 0 && opened === true && /index\.html$/.test(String(urlInBar)), `${show(nav)} → pane visible ${opened}, URL bar ${JSON.stringify(urlInBar)} (the user sees what the agent opens)`);
    const shot = await ui.send('Page.captureScreenshot', { format: 'png' });
    saveShot('parity-reveal-app.png', Buffer.from(shot.data, 'base64'));
    // the FIRST command ever on a workspace whose panel was never built: the host builds it (about:blank) — that must not open the pane either
    const { W2 } = ctx;
    await selectWs(ctx, W2);
    if ((await paneToggle(ctx)).open) await clickToggle(ctx);
    await waitFor(async () => !(await paneVisible(ctx)), 10000, 'the fresh workspace pane to be closed').catch(() => {});
    clause(A, 'ctl/fresh-workspace-pane-is-closed', !(await paneVisible(ctx)), `${W2.branch} selected, its pane closed, no panel built yet`);
    const first = await cli(ctx, W2, ['snapshot', '-i']);
    const openedBlank = await waitFor(() => paneVisible(ctx), 4000, 'the pane to open for a fresh panel').catch(() => false);
    // MEASUREMENT: building a panel loads about:blank, and decideBrowserAutoOpen (#393-fu) counts a new (tab,url) key as "the agent drove it" — so the very
    // first command of a workspace opens its pane (blank). The skill does not promise otherwise; this clause pins what is true so a change is seen.
    clause(A, 'first-command-on-a-fresh-panel-opens-the-pane-blank', first.code === 0 && openedBlank === true, `snapshot ${show(first)} → pane visible: ${openedBlank} (decideBrowserAutoOpen: key = activeTabId + url, about:blank is a url)`);
    await selectWs(ctx, W1);
  },
};
Object.assign(ARM_FNS, ARM_FNS2);


const ARM_FNS3 = {
  async 'hidden-panel'(ctx) {
    // The removed server's documented rule: a hidden panel produces no frames — screenshot/click/type/scroll fail with a clear error and do
    // not queue; navigate/read_page/evaluate/form_input keep working.
    const { W1, W2, FIX } = ctx; const A = 'hidden-panel';
    await selectWs(ctx, W1); await openPane(ctx);
    await cli(ctx, W1, ['open', `${FIX}/index.html`]);
    const U2 = `${FIX}/parity.html?w=${W2.name}`;
    const w2 = await cli(ctx, W2, ['open', U2]);
    const o2 = await oracle(ctx, U2);
    try {
      clause(A, 'ctl/w2-is-in-the-background', w2.code === 0 && (await ctx.ui.eval(`!!([...document.querySelectorAll('.ws-item.active .ws-name')].find((e) => e.textContent.trim() === ${sel(W1.branch)}))`)), `${W1.branch} is the active workspace; ${W2.branch} has a panel on ${U2} that is not composited`);
      const snap = await cli(ctx, W2, ['snapshot', '-i']); const name = refOf(snap.stdout, 'textbox', 'Name'), go = refOf(snap.stdout, 'button', 'Go');
      clause(A, 'snapshot-keeps-working', snap.code === 0 && !!name && !!go, show(snap));
      const ev = await cli(ctx, W2, ['eval', 'document.title']);
      clause(A, 'eval-keeps-working', ev.code === 0 && /Parity fixture/.test(ev.stdout), show(ev));
      const nav = await cli(ctx, W2, ['open', U2]);
      clause(A, 'open-keeps-working', nav.code === 0, show(nav));
      const snap2 = await cli(ctx, W2, ['snapshot', '-i']); const name2 = refOf(snap2.stdout, 'textbox', 'Name'), go2 = refOf(snap2.stdout, 'button', 'Go');
      const fill = await cli(ctx, W2, ['fill', name2 ?? '@e0', 'typed while hidden'], { timeoutMs: 45000 });
      const val = await o2.eval(`document.getElementById('name').value`);
      knownGap(A, 'fill-keeps-working-while-hidden', fill.code === 0 && val === 'typed while hidden', `${show(fill)} → oracle value ${JSON.stringify(val)} (the removed form_input set the value through the DOM and worked on a hidden pane; fill uses Input.insertText, which the proxy refuses without frames)`, 'ACCEPTED-GAP, OPS disposition; hidden-pane limits tracked in #406');
      clause(A, 'fill-on-a-hidden-pane-fails-fast-and-writes-nothing', fill.code !== 0 && fill.ms < 9000 && /not on screen/.test(fill.stderr) && val === '', `fill refused in ${fill.ms} ms with the reason; oracle value ${JSON.stringify(val)} (nothing was queued)`);
      const evs = await cli(ctx, W2, ['eval', "const el = document.getElementById('name'); el.value = 'set by eval'; el.dispatchEvent(new Event('input', { bubbles: true })); el.value"]);
      const val2 = await o2.eval(`document.getElementById('name').value`);
      clause(A, 'eval-sets-a-field-while-hidden', evs.code === 0 && val2 === 'set by eval', `${show(evs)} → oracle value ${JSON.stringify(val2)} (the documented workaround)`);
      const shot = await cli(ctx, W2, ['screenshot', path.join(ctx.world.fakeHome, 'bg.png')], { timeoutMs: 45000 });
      clause(A, 'screenshot-fails-fast-with-the-reason', shot.code !== 0 && shot.ms < 9000 && /not on screen/.test(shot.stderr), show(shot));
      const click = await cli(ctx, W2, ['click', go2 ?? '@e0'], { timeoutMs: 45000 });
      const out = await o2.eval(`document.getElementById('out').textContent`);
      clause(A, 'click-fails-fast-nothing-dispatched', click.code !== 0 && click.ms < 9000 && /not on screen|outside the viewport/.test(click.stderr) && out === 'idle', `${show(click)}; oracle #out ${JSON.stringify(out)} (the refused click was not dispatched or queued)`);
      const kt = await cli(ctx, W2, ['keyboard', 'type', 'zzz'], { timeoutMs: 45000 });
      clause(A, 'keyboard-type-fails-fast', kt.code !== 0 && kt.ms < 9000 && /not on screen/.test(kt.stderr), show(kt));
      const y0 = await o2.eval(`Math.round(window.scrollY)`);
      const pr = await cli(ctx, W2, ['press', 'Tab'], { timeoutMs: 45000 });
      clause(A, 'press-fails-fast', pr.code !== 0 && pr.ms < 9000 && /not on screen/.test(pr.stderr), show(pr));
      const hv = await cli(ctx, W2, ['hover', go2 ?? '@e0'], { timeoutMs: 45000 });
      const dc = await cli(ctx, W2, ['dblclick', go2 ?? '@e0'], { timeoutMs: 45000 });
      clause(A, 'hover-and-dblclick-fail-fast', hv.code !== 0 && dc.code !== 0 && hv.ms < 9000 && dc.ms < 9000 && /not on screen|outside the viewport/.test(hv.stderr) && /not on screen|outside the viewport/.test(dc.stderr), `hover ${show(hv)} · dblclick ${show(dc)}`);
      // the skill's hidden-pane workaround, extracted from the SKILL TEXT and pointed at a React-style controlled input (its value tracker ignores a plain assignment)
      const line = BROWSER_SKILL.split('\n').find((l) => l.startsWith('orchestra browser eval "(() => { const el = document.querySelector(\'#q\')'));
      const js = line ? shellWords(line.replace(/^orchestra browser /, ''))[1] : null;
      const withSetter = js ? await cli(ctx, W2, ['eval', js.replace('#q', '#ctl').replace("'x'", "'via-skill'")]) : null;
      const st1 = await o2.eval(`({ value: document.getElementById('ctl').value, state: document.getElementById('ctlstate').textContent })`);
      clause(A, 'skill-workaround-updates-a-controlled-input-while-hidden', !!js && withSetter?.code === 0 && st1.value === 'via-skill' && st1.state === 'state:via-skill', `skill snippet found: ${!!js}; ${withSetter ? show(withSetter) : ''} → oracle ${JSON.stringify(st1)}`);
      await o2.eval(`document.getElementById('ctl').value = ''; document.getElementById('ctlstate').textContent = ''`);
      await cli(ctx, W2, ['eval', "(() => { const el = document.querySelector('#ctl'); el.value = 'plain'; el.dispatchEvent(new Event('input', { bubbles: true })); })()"]);
      const st2 = await o2.eval(`({ value: document.getElementById('ctl').value, state: document.getElementById('ctlstate').textContent })`);
      clause(A, 'ctl/a-plain-assignment-leaves-the-controlled-state-stale', st2.value === 'plain' && st2.state === '', `plain value= + input event → oracle ${JSON.stringify(st2)} (the fixture discriminates the two forms, as React does)`);
      const mv = await cli(ctx, W2, ['mouse', 'move', '30', '30'], { timeoutMs: 45000 });
      clause(A, 'mouse-fails-fast', mv.code !== 0 && mv.ms < 9000 && /not on screen/.test(mv.stderr), show(mv));
      const keep = [['wait', ['wait', '#name']], ['wait-ms', ['wait', '100']], ['get', ['get', 'title']], ['cookies', ['cookies', 'get']], ['storage', ['storage', 'local', 'set', 'k399', 'v399']], ['console', ['console']], ['network', ['network', 'requests']]];
      const outs = []; for (const [n, a] of keep) outs.push([n, await cli(ctx, W2, a, { timeoutMs: 45000 })]);
      clause(A, 'wait-get-cookies-storage-console-network-keep-working', outs.every(([, r]) => r.code === 0), outs.map(([n, r]) => `${n}: rc=${r.code}${r.code ? ' ' + JSON.stringify(r.stderr.slice(0, 80)) : ''}`).join(' · '));
      await o2.eval(`window.scrollTo(0, 0)`); await sleep(300); // the hidden attempts above may have scrolled elements into view
      const y0b = await o2.eval(`Math.round(window.scrollY)`);
      const sc = await cli(ctx, W2, ['scroll', 'down', '300'], { timeoutMs: 45000 });
      const y1 = await o2.eval(`Math.round(window.scrollY)`);
      clause(A, 'scroll-works-while-hidden', sc.code === 0 && Math.abs(y1 - y0b - 300) <= 2, `${show(sc)}; oracle scrollY ${y0b} → ${y1} (window.scrollBy needs no frames: better than the removed tool, which refused)`);
    } finally { o2.close(); }
  },
};
Object.assign(ARM_FNS, ARM_FNS3);



const ARM_FNS4 = {
  async skill(ctx) {
    // Spec #388 AC: "the bundled skill exists in new worktrees and an agent following it completes the fixture flow".
    // The skill is read from the file the REAL app wrote into a NEW worktree, and its worked example is run VERBATIM (only $URL is supplied)
    // through the real CLI, as the agent's Bash tool would: an `orchestra` on PATH, the agent's env, the workspace's session key.
    const { W1, FIX, ui, world } = ctx; const A = 'skill';
    await selectWs(ctx, W1); await openPane(ctx);
    const made = await ui.eval(`window.orchestra.createWorkspace({ repoPath: ${sel(world.repoDir)} }).then((w) => ({ id: w.id, worktreePath: w.worktreePath }))`);
    const skillFile = path.join(made.worktreePath, '.claude', 'skills', BROWSER_SKILL_NAME, 'SKILL.md');
    const sibling = path.join(made.worktreePath, '.claude', 'skills', 'orchestra-link', 'SKILL.md');
    await waitFor(() => fs.existsSync(sibling), 30000, 'the app to install the capability skills into the NEW worktree').catch(() => {});
    clause(A, 'ctl/the-app-installed-its-skills-in-the-new-worktree', fs.existsSync(sibling), `${sibling} ${fs.existsSync(sibling) ? 'exists' : 'MISSING'} (the installer ran for the workspace the app just created)`);
    const installed = fs.existsSync(skillFile) ? fs.readFileSync(skillFile, 'utf8') : null;
    clause(A, 'skill-installed-in-a-new-worktree', installed === BROWSER_SKILL, `${skillFile} ${installed === null ? 'MISSING' : installed === BROWSER_SKILL ? `exists, byte-equal to BROWSER_SKILL (${installed.length} chars)` : 'exists but DIFFERS from BROWSER_SKILL'}`);
    if (installed === null) return;

    const at = installed.indexOf(BROWSER_SKILL_EXAMPLE_HEADING);
    const block = (/```bash\n([\s\S]*?)```/.exec(installed.slice(at)) ?? [])[1];
    clause(A, 'ctl/example-extracted-from-the-installed-file', at > 0 && !!block && /b open "\$URL"/.test(block), `worked example under "${BROWSER_SKILL_EXAMPLE_HEADING}": ${block ? block.split('\n').length - 1 : 0} lines`);
    if (!block) return;
    const shim = path.join(world.fakeHome, 'agent-bin'); fs.mkdirSync(shim, { recursive: true });
    fs.writeFileSync(path.join(shim, 'orchestra'), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(path.join(APP_DIR, 'dist-electron/cli.js'))} "$@"\n`, { mode: 0o755 });
    const runFlow = (name, script) => new Promise((resolve) => {
      const f = path.join(world.fakeHome, `${name}.sh`); fs.writeFileSync(f, script);
      const env = cliEnv(ctx, W1, { env: { URL: `${FIX}/skill-flow.html` } }); env.PATH = `${shim}:${env.PATH}`;
      const t0 = Date.now();
      const child = spawn('bash', [f], { env, cwd: world.fakeHome, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
      let stdout = '', stderr = '';
      child.stdout.on('data', (d) => (stdout += d)); child.stderr.on('data', (d) => (stderr += d));
      const timer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 90000);
      child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr, ms: Date.now() - t0 }); });
    });
    const welcome = async () => { const o = await oracle(ctx, `${FIX}/skill-flow.html`, 8000).catch(() => null); if (!o) return null; try { return await o.eval(`(document.getElementById('welcome') || {}).textContent || null`); } finally { o.close(); } };

    // must-FAIL arms FIRST (they leave the page without a welcome line; the green run then sets it): a label that is not on the page, and a flow that does not wait
    const wrongLabel = await runFlow('flow-wrong-label', block.replace(`'textbox "Email'`, `'textbox "Phone'`));
    const w0 = await welcome();
    clause(A, 'ctl/example-with-a-label-not-on-the-page-fails', block.includes(`'textbox "Email'`) && wrongLabel.code !== 0 && w0 === null, `ref lookup for a missing textbox → ${show({ code: wrongLabel.code, stdout: wrongLabel.stdout, stderr: wrongLabel.stderr, ms: wrongLabel.ms })}; oracle #welcome ${JSON.stringify(w0)} (the flow cannot pass by accident)`);
    const oldRegex = await runFlow('flow-old-regex', block.replace("sed -n 's/.*ref=\\(e[0-9]*\\).*/@\\1/p'", "sed -n 's/.*\\[ref=\\(e[0-9]*\\)\\].*/@\\1/p'"));
    const w0b = await welcome();
    clause(A, 'ctl/example-with-the-bracket-only-ref-regex-fails-on-a-required-field', block.includes('ref=\\(e[0-9]*\\)') && oldRegex.code !== 0 && w0b === null, `the helper's old regex (matches only a bare [ref=eN]) on the page's <input required> (snapshot shows [required, ref=eN]) → ${show({ code: oldRegex.code, stdout: oldRegex.stdout, stderr: oldRegex.stderr, ms: oldRegex.ms })}; oracle #welcome ${JSON.stringify(w0b)}`);
    const noClick = await runFlow('flow-no-click', block.replace(/^b click .*\n/m, ''));
    const w1 = await welcome();
    clause(A, 'ctl/example-without-the-click-fails', /^b click /m.test(block) && noClick.code !== 0 && w1 === null, `flow minus its click → ${show({ code: noClick.code, stdout: noClick.stdout, stderr: noClick.stderr, ms: noClick.ms })}; oracle #welcome ${JSON.stringify(w1)}`);

    const run = await runFlow('flow', block);
    const w2 = await welcome();
    const last = run.stdout.trim().split('\n').pop();
    clause(A, 'example-completes-the-fixture-flow-verbatim', run.code === 0 && last === 'Welcome, me@example.com' && w2 === 'Welcome, me@example.com', `bash flow.sh (the skill's block, $URL=${FIX}/skill-flow.html) → ${show({ code: run.code, stdout: run.stdout, stderr: run.stderr, ms: run.ms })}; oracle #welcome ${JSON.stringify(w2)}`);
    const shot = await ui.send('Page.captureScreenshot', { format: 'png' });
    saveShot('parity-skill-flow-app.png', Buffer.from(shot.data, 'base64'));
  },
};
Object.assign(ARM_FNS, ARM_FNS4);


const ARM_FNS5 = {
  async focus(ctx) {
    // Spec #388 story 44 + the skill's "Focus" section: a command the skill documents never moves the human's keyboard focus out of the composer.
    const { W1, FIX } = ctx; const A = 'focus';
    await selectWs(ctx, W1); await openPane(ctx);
    const { o } = await openOn(ctx, W1, `${FIX}/parity.html`);
    try {
      const snap = await cli(ctx, W1, ['snapshot', '-i']);
      const r = { go: refOf(snap.stdout, 'button', 'Go'), name: refOf(snap.stdout, 'textbox', 'Name'), typed: refOf(snap.stdout, 'textbox', 'Typed') };
      // MEASURED (2026-10-26, this rig): NOTHING reachable here moves the renderer's keyboard focus off the composer — a compositor-level click (swaymsg seat cursor), a CDP
      // click / Page.bringToFront / Target.activateTarget on the panel page, and a main-process webContents.focus()+sendInputEvent mutant all left it focused. So these clauses are
      // OBSERVATIONS ("the documented commands did not move it"), not a proof the instrument can say FAIL; there is deliberately no mutant for them (a surviving one would be noise).
      const shotFile = path.join(ctx.world.fakeHome, 'focus-shot.png');
      const cmds = [
        ['snapshot', ['snapshot', '-i']], ['eval', ['eval', 'document.title']], ['get', ['get', 'text', r.go ?? '@e0']], ['click', ['click', r.go ?? '@e0']],
        ['hover', ['hover', r.go ?? '@e0']], ['focus', ['focus', r.name ?? '@e0']], ['fill', ['fill', r.name ?? '@e0', 'fx']], ['type', ['type', r.typed ?? '@e0', 'ty']],
        ['keyboard type', ['keyboard', 'type', 'kt']], ['press', ['press', 'Tab']], ['scroll', ['scroll', 'down', '100']], ['screenshot', ['screenshot', shotFile]],
        ['mouse', ['mouse', 'move', '30', '30']], ['wait', ['wait', '50']], ['open', ['open', `${FIX}/parity.html`]],
      ];
      for (const [label, args] of cmds) {
        if (label === 'open') { const { o: o2 } = await openOn(ctx, W1, `${FIX}/index.html`); o2.close(); }
        const f0 = await focusComposer(ctx);
        clause(A, `ctl/${label}-composer-focused-before`, f0?.onComposer === true && f0?.windowFocus === true, `trusted click into the composer → ${JSON.stringify(f0)}`);
        const rr = await cli(ctx, W1, args);
        const f1 = await composerFocus(ctx);
        clause(A, `ctl/${label}-succeeds`, rr.code === 0, show(rr));
        clause(A, `${label}-keeps-the-composer-focused`, f1?.onComposer === true && f1?.windowFocus === true, `composer focus after: ${JSON.stringify(f1)}`);
      }
    } finally { o.close(); }
  },
};
Object.assign(ARM_FNS, ARM_FNS5);


const ARM_FNS6 = {
  async table(ctx) {
    // Every command of the skill's "Act on the page" table that no other arm exercises, against an oracle.
    const { W1, FIX } = ctx; const A = 'table';
    await selectWs(ctx, W1); await openPane(ctx);
    const { o } = await openOn(ctx, W1, `${FIX}/parity.html`);
    try {
      const snap = await cli(ctx, W1, ['snapshot', '-i']);
      const r = { go: refOf(snap.stdout, 'button', 'Go'), name: refOf(snap.stdout, 'textbox', 'Name'), chk: refOf(snap.stdout, 'checkbox', 'Agree'), sel: refOf(snap.stdout, 'combobox', 'Country'), dbl: refOf(snap.stdout, 'button', 'Double') };
      console.log(`    [probe] table snapshot -i:\n${snap.stdout.split('\n').map((l) => '      ' + l).join('\n')}`);
      clause(A, 'ctl/refs-found', Object.values(r).every(Boolean), `refs ${JSON.stringify(r)}`);
      const read = (expr) => o.eval(expr);
      console.log(`    [probe] before dblclick: ${JSON.stringify(await read(`(() => { const r = document.getElementById('dbl').getBoundingClientRect(); return { scrollY: window.scrollY, innerW: innerWidth, innerH: innerHeight, dbl: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)], url: location.href }; })()`))}`);
      const dc = await cli(ctx, W1, ['dblclick', r.dbl ?? '@e0']);
      console.log(`    [probe] after dblclick: ${JSON.stringify(await read(`({ dblout: document.getElementById('dblout').textContent, scrollY: window.scrollY })`))}`);
      clause(A, 'dblclick', dc.code === 0 && (await read(`document.getElementById('dblout').textContent`)) === 'dbl', show(dc));
      const hv = await cli(ctx, W1, ['hover', r.dbl ?? '@e0']);
      clause(A, 'hover', hv.code === 0 && (await read(`document.getElementById('hovout').textContent`)) === 'hovered', show(hv));
      const ck = await cli(ctx, W1, ['check', r.chk ?? '@e0']);
      const on = await read(`document.getElementById('chk').checked`);
      const uc = await cli(ctx, W1, ['uncheck', r.chk ?? '@e0']);
      clause(A, 'check-and-uncheck', ck.code === 0 && on === true && uc.code === 0 && (await read(`document.getElementById('chk').checked`)) === false, `check → ${show(ck)} (checked=${on}); uncheck → ${show(uc)}`);
      const se = await cli(ctx, W1, ['select', r.sel ?? '@e0', 'Germany']);
      clause(A, 'select-by-label', se.code === 0 && (await read(`document.getElementById('sel').value`)) === 'de', show(se));
      const fo = await cli(ctx, W1, ['focus', r.name ?? '@e0']);
      clause(A, 'focus', fo.code === 0 && (await read(`document.activeElement && document.activeElement.id`)) === 'name', show(fo));
      await cli(ctx, W1, ['fill', r.name ?? '@e0', 'got it']);
      const gv = await cli(ctx, W1, ['get', 'value', r.name ?? '@e0']);
      clause(A, 'get-value', gv.code === 0 && gv.stdout.trim() === 'got it', show(gv));
      const iv = await cli(ctx, W1, ['is', 'visible', r.go ?? '@e0']);
      clause(A, 'is-visible', iv.code === 0 && /true/.test(iv.stdout), show(iv));
      await read(`document.getElementById('out').textContent = 'changed-before-reload'`);
      const rl = await cli(ctx, W1, ['reload']);
      const back = await waitFor(async () => (await read(`document.getElementById('out').textContent`)) === 'idle', 8000, 'the reloaded page').then(() => true, () => false);
      clause(A, 'reload', rl.code === 0 && back, `${show(rl)} → #out reset to idle: ${back}`);
      const full = await cli(ctx, W1, ['snapshot']);
      const compact = await cli(ctx, W1, ['snapshot', '-c']);
      clause(A, 'snapshot-compact', compact.code === 0 && compact.stdout.length <= full.stdout.length && /button "Go"/.test(compact.stdout), `full ${full.stdout.length} chars, -c ${compact.stdout.length} chars`);
      const scoped = await cli(ctx, W1, ['snapshot', '-s', '#more']);
      clause(A, 'snapshot-scoped', scoped.code === 0 && /Controlled|Agree/.test(scoped.stdout) && !/heading "Parity fixture"/.test(scoped.stdout), `-s #more → ${scoped.stdout.length} chars; has the section's controls, not the page heading`);
      const deep = await cli(ctx, W1, ['snapshot', '-d', '1']);
      clause(A, 'snapshot-depth', deep.code === 0 && deep.stdout.length < full.stdout.length, `full ${full.stdout.length} chars, -d 1 ${deep.stdout.length} chars`);
      const ann = await cli(ctx, W1, ['screenshot', '--annotate', path.join(ctx.world.fakeHome, 'ann.png')]);
      clause(A, 'screenshot-annotate', ann.code === 0 && /\[\d+\] @e\d+/.test(ann.stdout) && fs.existsSync(path.join(ctx.world.fakeHome, 'ann.png')), show(ann));
      // MEASUREMENT for the skill (a container that scrolls on its own): --selector
      const box0 = await read(`document.getElementById('box').scrollTop`);
      const sb = await cli(ctx, W1, ['scroll', 'down', '200', '--selector', '#box']);
      const box1 = await read(`document.getElementById('box').scrollTop`);
      clause(A, 'scroll-a-container-with-selector', sb.code === 0 && Math.abs(box1 - box0 - 200) <= 2, `${show(sb)} → #box.scrollTop ${box0} → ${box1}`);
    } finally { o.close(); }
  },
};
Object.assign(ARM_FNS, ARM_FNS6);


const ARM_FNS7 = {
  async 'load-wait'(ctx) {
    // AC1 (ledger #405, early review): the removed `navigate` awaited loadURL. MEASURED on agent-browser 0.39.2: `open` returns only after the page's load event
    // (it waits for Page.loadEventFired, which the proxy forwards from the debugger) — so a page with a slow subresource is `complete` when `open` returns.
    const { W1, FIX } = ctx; const A = 'load-wait';
    await selectWs(ctx, W1); await openPane(ctx);
    const slow = await startSlowSite();
    try {
      const fastUrl = `${FIX}/index.html?lw=1`;
      const f0 = Date.now(); const fast = await cli(ctx, W1, ['open', fastUrl], { timeoutMs: 40000 }); const fastMs = Date.now() - f0;
      clause(A, 'a-fast-page-opens-well-under-the-slow-page-time', fast.code === 0 && fastMs < SLOW_MS, `open ${fastUrl} → ${show(fast)} (${fastMs} ms < ${SLOW_MS} ms: the wait is for the load, not a fixed sleep)`);
      const u = `${slow.url}?lw=1`;
      const t0 = Date.now(); const r = await cli(ctx, W1, ['open', u], { timeoutMs: 40000 }); const took = Date.now() - t0;
      const o = await oracle(ctx, u, 8000).catch(() => null);
      const st = o ? await o.eval(`({ rs: document.readyState, loaded: typeof window.__loadedAt === 'number' })`) : null;
      o?.close();
      clause(A, 'open-returns-after-the-page-loaded', r.code === 0 && took >= SLOW_MS - 300 && st?.rs === 'complete' && st?.loaded === true, `open ${u} (one image that takes ${SLOW_MS} ms) → ${show(r)}; took ${took} ms; the oracle right after: ${JSON.stringify(st)}`);
    } finally { slow.srv.close(); }
  },
};
Object.assign(ARM_FNS, ARM_FNS7);

const ARM_FNS8 = {
  async 'skill-tabs'(ctx) {
    // The skill's "Tabs" section, claim by claim, on the composed build (#393 policy + #395 proxy + #397 agent tabs). The REGISTRY (app state over IPC) is the truth:
    // agent-browser prints "closed" even when the proxy refused.
    const { W1, FIX, ui } = ctx; const A = 'skill-tabs';
    await selectWs(ctx, W1); await openPane(ctx);
    await cli(ctx, W1, ['open', `${FIX}/cli.html?tabs=1`]);
    const reg = async () => (await ui.eval(`window.orchestra.browserState(${sel(W1.id)})`)).tabs;
    const labelOf = (list, re) => (list.stdout.split('\n').find((l) => re.test(l)) ?? '').match(/\[(t\d+)\]/)?.[1];
    const t0 = await reg(); const human = t0.find((t) => t.openedBy === 'human');
    clause(A, 'ctl/one-human-tab-to-start', t0.length === 1 && !!human, `registry ${JSON.stringify(t0.map((t) => [t.id, t.openedBy]))}`);
    const snap = await cli(ctx, W1, ['snapshot', '-i']); const go = refOf(snap.stdout, 'button', 'Go');
    const nw = await cli(ctx, W1, ['tab', 'new', `${FIX}/index.html?tabs=2`]);
    await waitFor(async () => (await reg()).length === 2, 10000, 'the new tab').catch(() => {});
    const list = await cli(ctx, W1, ['tab', 'list']);
    const mine = labelOf(list, /index\.html/), theirs = labelOf(list, /cli\.html/);
    const lines = list.stdout.split('\n');
    clause(A, 'tab-list-marks-who-opened-each-tab', nw.code === 0 && !!mine && !!theirs && /\(yours\)/.test(lines.find((l) => /index\.html/.test(l)) ?? '') && /\(the user's\)/.test(lines.find((l) => /cli\.html/.test(l)) ?? ''), `${show(nw)}; tab list → ${JSON.stringify(list.stdout.trim().slice(0, 260))}`);
    // refs do not survive a tab switch
    const back = await cli(ctx, W1, ['tab', theirs ?? 't1']);
    const stale = await cli(ctx, W1, ['click', go ?? '@e0']);
    clause(A, 'refs-do-not-survive-a-tab-switch', back.code === 0 && stale.code !== 0 && /browser_stale_ref/.test(stale.stderr), `tab ${theirs}: ${show(back)}; click ${go} from before the switch → ${show(stale)}`);
    // the human's tab: refused, still open
    const closeHuman = await cli(ctx, W1, ['tab', 'close', theirs ?? 't1']);
    await sleep(500);
    const afterHuman = await reg();
    clause(A, 'closing-the-humans-tab-fails-with-browser_tab_not_owner-and-it-stays', closeHuman.code !== 0 && /browser_tab_not_owner/.test(closeHuman.stderr) && afterHuman.some((t) => t.id === human.id), `tab close ${theirs} → ${show(closeHuman)}; registry still has the human tab: ${afterHuman.some((t) => t.id === human.id)}`);
    // my own tab: closes
    const closeMine = await cli(ctx, W1, ['tab', 'close', mine ?? 't2']);
    await waitFor(async () => (await reg()).length === 1, 8000, 'my tab to leave the registry').catch(() => {});
    const end = await reg();
    clause(A, 'closing-my-own-tab-works', closeMine.code === 0 && end.length === 1 && end[0].id === human.id, `tab close ${mine} → ${show(closeMine)}; registry ${JSON.stringify(end.map((t) => [t.id, t.openedBy]))}`);
  },
};
Object.assign(ARM_FNS, ARM_FNS8);

// ── seat 3 (#399 F3 delta, 0dbc2b35): which elements does a hidden-pane `wait "<selector>"` pass for; the stale-ref and help sentences ──
ARM_FNS.v3f3 = async function v3f3(ctx) {
  const { W1, W2, FIX } = ctx; const A = 'v3f3';
  const run = (W, args, o2) => cli(ctx, W, args, { timeoutMs: 60000, ...(o2 ?? {}) });
  await selectWs(ctx, W1); await openPane(ctx);
  const u = `${FIX}/v3-kinds.html`;
  const { r: op, o } = await openOn(ctx, W2, u);
  clause(A, 'ctl/w2-is-hidden', op.code === 0 && await ctx.ui.eval(`!!([...document.querySelectorAll('.ws-item.active .ws-name')].find((e) => e.textContent.trim() === ${sel(W1.branch)}))`), show(op));
  const geo = await o.eval(`({ innerWidth, innerHeight, bodyW: Math.round(document.body.getBoundingClientRect().width), kinds: Object.fromEntries([...document.querySelectorAll('[id^=k-]')].map((e) => [e.id, Math.round(e.getBoundingClientRect().width)])) })`);
  console.log(`  INFO  [${A}] hidden page geometry: innerWidth ${geo.innerWidth} innerHeight ${geo.innerHeight} body ${geo.bodyW}; widths ${JSON.stringify(geo.kinds)}`);
  const ids = Object.keys(geo.kinds); const hidden = {};
  for (const id of ids) { const r = await run(W2, ['wait', `#${id}`, '--timeout', '2500']); hidden[id] = { ok: r.code === 0, ms: r.ms }; }
  const passH = ids.filter((i) => hidden[i].ok), failH = ids.filter((i) => !hidden[i].ok);
  console.log(`  INFO  [${A}] hidden pane, wait "#id" --timeout 2500: RETURNS for [${passH.join(', ')}]; TIMES OUT for [${failH.join(', ')}]`);
  const sentenceOnly = passH.every((i) => /^k-(input|btn)$/.test(i)) && ['k-input', 'k-btn'].every((i) => passH.includes(i));
  clause(A, 'skill-says-hidden-wait-selector-returns-ONLY-for-inputs-and-buttons', sentenceOnly, `returns for [${passH.join(', ')}]`);
  const sentenceFail = ['k-h1', 'k-p', 'k-div'].every((i) => failH.includes(i));
  clause(A, 'skill-says-text-blocks-and-divs-time-out', sentenceFail, `h1 ${JSON.stringify(hidden['k-h1'])} p ${JSON.stringify(hidden['k-p'])} div ${JSON.stringify(hidden['k-div'])}`);
  const bodyR = await run(W2, ['wait', 'body', '--timeout', '2500']); clause(A, 'skill-says-the-body-times-out', bodyR.code !== 0, show(bodyR));
  const lateR = await (async () => { await o.eval(`setTimeout(() => { const d = document.createElement('input'); d.id = 'late-input'; document.body.appendChild(d); }, 700); 1`); return run(W2, ['wait', '#late-input', '--timeout', '3000']); })();
  console.log(`  INFO  [${A}] hidden pane, a LATE <input> (skill: "an element that still has to appear" times out): ${show(lateR)}`);
  // visible controls
  await selectWs(ctx, W2); await openPane(ctx);
  const ov = await oracle(ctx, `${u}?w=${W2.name}`);
  const vis = {}; for (const id of ['k-h1', 'k-p', 'k-div', 'k-input']) { const r = await run(W2, ['wait', `#${id}`, '--timeout', '2500']); vis[id] = r.code === 0 && r.ms < 2000; }
  clause(A, 'ctl/visible-pane-every-kind-returns-at-once', Object.values(vis).every(Boolean), JSON.stringify(vis));
  // stale-ref sentence: "after a re-render the old ref may still resolve (by role and name) or may not"
  const sn = await run(W2, ['snapshot', '-i']); const go = (/button "Go" \[ref=(e\d+)\]/.exec(sn.stdout) || [])[1];
  await ov.eval(`document.getElementById('host').innerHTML = '<button id="bgo2" onclick="document.getElementById(\\'out\\').textContent=\\'clicked-new-node\\'">Go</button>'; 1`);
  const c1 = await run(W2, ['click', `@${go}`]); const out1 = await ov.eval(`document.getElementById('out').textContent`);
  console.log(`  INFO  [${A}] re-render with the SAME role+name, old ref @${go}: ${show(c1)} → #out ${JSON.stringify(out1)}`);
  await ov.eval(`document.getElementById('host').innerHTML = '<button id="bgo3">Stop</button>'; 1`);
  const c2 = await run(W2, ['click', `@${go}`]);
  console.log(`  INFO  [${A}] re-render with ANOTHER name, old ref: ${show(c2)}`);
  clause(A, 'skill-says-after-a-rerender-the-old-ref-may-resolve-or-may-not', (c1.code === 0 && /clicked-new-node/.test(out1)) && c2.code !== 0, `same role+name → ${c1.code === 0 ? 'resolved and clicked the NEW node' : 'failed'}; another name → rc ${c2.code}`);
  // help sentence
  const h = await run(W2, ['help'], {}); const hb = await new Promise((res) => { const r = spawnSync(process.execPath, [path.join(APP_DIR, 'dist-electron/cli.js'), 'help', 'browser'], { encoding: 'utf8', env: cliEnv(ctx, W2), cwd: ctx.world.fakeHome }); res(r); });
  console.log(`  INFO  [${A}] orchestra help browser → rc ${hb.status}, ${hb.stdout.split('\n').length} lines, head ${JSON.stringify(hb.stdout.split('\n').slice(0, 4).join(' | ').slice(0, 220))}`);
  clause(A, 'skill-says-help-browser-prints-a-short-reference', hb.status === 0 && hb.stdout.trim().length > 0 && hb.stdout.split('\n').length < 60, `${hb.stdout.split('\n').length} lines`);
  ov.close(); o.close();
};

// ── seat 3 (#399 delta gate a94f4476): each NEW sentence of the skill vs what the page/app does ──
ARM_FNS.v3delta = async function v3delta(ctx) {
  const { W1, W2, FIX } = ctx; const A = 'v3delta';
  const run = (W, args, o2) => cli(ctx, W, args, { timeoutMs: 60000, ...(o2 ?? {}) });
  const late = (o, id) => o.eval(`setTimeout(() => { const d = document.createElement('div'); d.id = ${JSON.stringify(id)}; d.textContent = 'late ' + ${JSON.stringify(id)}; document.body.appendChild(d); }, 700); 1`);
  await selectWs(ctx, W1); await openPane(ctx);
  const u = `${FIX}/v3-claims.html`;
  const hid = async (tag) => { const r = await openOn(ctx, W2, u); return r.o; };            // W2 is a background workspace: its pane is NOT on screen
  const o = await hid();
  clause(A, 'ctl/w2-is-hidden', await ctx.ui.eval(`!!([...document.querySelectorAll('.ws-item.active .ws-name')].find((e) => e.textContent.trim() === ${sel(W1.branch)}))`), `${W1.branch} is the active workspace`);
  const has = await o.eval(`!!document.getElementById('h1')`);
  // 1. the sentence: "wait "<selector>" … returns at once for an element that is already on the page"
  const t1 = await run(W2, ['wait', '#h1', '--timeout', '6000']);                   // right after open
  await run(W2, ['snapshot', '-i']); const t2 = await run(W2, ['wait', '#h1', '--timeout', '6000']);
  await sleep(3000); const t3 = await run(W2, ['wait', '#h1', '--timeout', '6000']);
  const t4 = await run(W2, ['wait', '#h1']);                                        // the default timeout
  clause(A, 'skill-says-wait-selector-for-an-element-already-on-the-page-returns-at-once-on-a-hidden-pane', has && [t1, t2, t3, t4].every((r) => r.code === 0 && r.ms < 3000), `element present: ${has}; right after open ${show(t1)} | after snapshot ${show(t2)} | after 3 s ${show(t3)} | default timeout ${show(t4)}`);
  // 2. late element: selector hangs, --fn/--text/ms work
  await late(o, 'late-sel'); const wsel = await run(W2, ['wait', '#late-sel', '--timeout', '4000']);
  await late(o, 'late-fn'); const wfn = await run(W2, ['wait', '--fn', "document.querySelector('#late-fn') !== null"]);
  await late(o, 'late-txt'); const wtx = await run(W2, ['wait', '--text', 'late late-txt']);
  const wms = await run(W2, ['wait', '500']);
  clause(A, 'skill-says-late-element-selector-wait-times-out-but-fn-text-ms-work-on-a-hidden-pane', wsel.code !== 0 && /timed out/i.test(wsel.stderr) && wfn.code === 0 && wtx.code === 0 && wms.code === 0, `selector ${show(wsel)} | --fn ${show(wfn)} | --text ${show(wtx)} | ms ${show(wms)}`);
  // 3. "--timeout 3000" bounds it (25 s by default)
  const tb = await run(W2, ['wait', '#never-there', '--timeout', '3000']);
  clause(A, 'skill-says---timeout-3000-bounds-the-hung-wait', tb.code !== 0 && tb.ms >= 2500 && tb.ms < 8000, `wait "#never-there" --timeout 3000 on the hidden pane → ${show(tb)}`);
  const td = await run(W2, ['wait', '#never-there']);
  clause(A, 'skill-says-the-default-timeout-is-25-s', td.code !== 0 && td.ms >= 24000 && td.ms <= 27000, `default → ${show(td)}`);
  // 4. the errors workaround, VERBATIM from the skill, on the hidden pane and on a visible one
  const L = BROWSER_SKILL.split('\n').flatMap((l) => l.match(/§?`?eval "(window\.addEventListener\('error'[^"]*)"`?/) ? [l] : []);
  const m1 = /eval "(window\.addEventListener\('error', e => \(window\.__err = e\.message\)\))"/.exec(BROWSER_SKILL); const m2 = /eval "(window\.__err)"/.exec(BROWSER_SKILL);
  clause(A, 'ctl/the-skill-text-carries-both-workaround-commands', !!m1 && !!m2, `listener ${m1?.[1]} | read ${m2?.[1]}`);
  const errCase = async (W, oo, label) => {
    await oo.eval(`window.__err = undefined; 1`);
    const a = await run(W, ['eval', m1[1]]);
    await oo.eval(`setTimeout(() => { throw new Error('workaround-${label}'); }, 80); 1`);
    let b = null; const tt0 = Date.now(); for (let i = 0; i < 12; i++) { await sleep(700); b = await run(W, ['eval', m2[1]]); if (b.stdout.includes(`workaround-${label}`)) break; }
    console.log(`  INFO  [${A}] workaround read (${label}) took ${Date.now() - tt0} ms from the throw`);
    const e = await run(W, ['errors']);
    return { a, b, e, ok: a.code === 0 && b.code === 0 && b.stdout.includes(`workaround-${label}`) };
  };
  const eh = await errCase(W2, o, 'hidden');
  clause(A, 'skill-workaround-captures-an-uncaught-error-message-on-a-hidden-pane', eh.ok, `add ${show(eh.a)} | read ${show(eh.b)} | (errors still: ${JSON.stringify(eh.e.stdout.slice(0, 40))})`);
  // 5. console "may lag on a hidden pane"
  await o.eval(`console.log('lagprobe-hidden-1'); 1`);
  const c0 = await run(W2, ['console']); await sleep(2500); const c1 = await run(W2, ['console']);
  console.log(`  INFO  [${A}] console on the hidden pane: right after the page logged: has it ${c0.stdout.includes('lagprobe-hidden-1')}; 2.5 s later: ${c1.stdout.includes('lagprobe-hidden-1')}`);
  // visible controls
  await selectWs(ctx, W2); await openPane(ctx);
  const ov = await oracle(ctx, `${u}?w=${W2.name}`);
  await late(ov, 'late-vis'); const wvis = await run(W2, ['wait', '#late-vis', '--timeout', '4000']);
  clause(A, 'ctl/the-same-late-selector-wait-succeeds-on-the-visible-pane', wvis.code === 0 && wvis.ms < 3000, show(wvis));
  const ev = await errCase(W2, ov, 'visible');
  clause(A, 'skill-workaround-captures-an-uncaught-error-message-on-a-visible-pane', ev.ok, `add ${show(ev.a)} | read ${show(ev.b)}`);
  await ov.eval(`console.log('lagprobe-visible-1'); 1`);
  const cv = await run(W2, ['console']);
  console.log(`  INFO  [${A}] console on the visible pane, immediately after the page logged: has it ${cv.stdout.includes('lagprobe-visible-1')}`);
  ov.close(); o.close();
};
// ── seat 3 (#399 gate): the SKILL's behavioural claims beyond the member's 15 arms, each against an INDEPENDENT oracle (a 2nd CDP client on the page) ──
ARM_FNS.v3claims = async function v3claims(ctx) {
  const { W1, W2, FIX } = ctx; const A = 'v3claims';
  const refLine = (snap, re, not) => { const l = snap.split('\n').find((x) => re.test(x) && !(not && not.test(x))); const m = l && /ref=(e\d+)/.exec(l); return m ? `@${m[1]}` : null; };
  const run = (W, args, o2) => cli(ctx, W, args, { timeoutMs: 45000, ...(o2 ?? {}) });
  await selectWs(ctx, W1); await openPane(ctx);
  const { r: op, o } = await openOn(ctx, W1, `${FIX}/v3-claims.html`);
  clause(A, 'ctl/page-open', op.code === 0, show(op));
  const sn = await run(W1, ['snapshot', '-i']);
  console.log('  [snapshot of the claims page]\n' + sn.stdout.split('\n').map((l) => '    ' + l).join('\n'));
  const R = {
    sel: refLine(sn.stdout, /Colour/), chk: refLine(sn.stdout, /checkbox "\s*Tick/), chk2: refLine(sn.stdout, /checkbox.*Untick/), file: refLine(sn.stdout, /Attachment|file|Choose/i),
    name: refLine(sn.stdout, /textbox.*Name/), ask: refLine(sn.stdout, /button "ask"/), log: refLine(sn.stdout, /button "log"/), net: refLine(sn.stdout, /button "net"/), bottom: refLine(sn.stdout, /button "bottom"/), h1: refLine(sn.stdout, /heading/),
  };
  clause(A, 'ctl/every-element-got-a-ref', Object.values(R).every(Boolean), JSON.stringify(R));
  const ev = (e) => o.eval(e);
  // 1 select
  const s0 = await ev(`document.getElementById('sel').value`); const sOk = await run(W1, ['select', R.sel ?? '@e0', 'Green']); const s1 = await ev(`document.getElementById('sel').value`);
  clause(A, 'select-picks-an-option-by-its-label', s0 === 'r' && sOk.code === 0 && s1 === 'g', `${show(sOk)} → oracle value ${s0}→${s1}`);
  const sBad = await run(W1, ['select', R.sel ?? '@e0', 'Purple']); const s2 = await ev(`document.getElementById('sel').value`);
  clause(A, 'ctl/select-of-a-label-not-in-the-list-changes-nothing', s2 === 'g', `${show(sBad)} → oracle value ${s2}`);
  // 2 check / uncheck
  const c0 = await ev(`[document.getElementById('chk').checked, document.getElementById('chk2').checked]`);
  const ck = await run(W1, ['check', R.chk ?? '@e0']); const uk = await run(W1, ['uncheck', R.chk2 ?? '@e0']);
  const c1 = await ev(`[document.getElementById('chk').checked, document.getElementById('chk2').checked]`);
  clause(A, 'check-and-uncheck-set-the-box-state', JSON.stringify(c0) === '[false,true]' && JSON.stringify(c1) === '[true,false]' && ck.code === 0 && uk.code === 0, `oracle ${JSON.stringify(c0)} → ${JSON.stringify(c1)}; check ${show(ck)}; uncheck ${show(uk)}`);
  const ck2 = await run(W1, ['check', R.chk ?? '@e0']); const c2 = await ev(`document.getElementById('chk').checked`);
  clause(A, 'ctl/check-on-a-checked-box-leaves-it-checked', c2 === true, `second check → ${show(ck2)}; oracle ${c2} (a toggle would have flipped it)`);
  // 3 upload (relative path resolves against the CLI's cwd = fakeHome)
  fs.writeFileSync(path.join(ctx.world.fakeHome, 'claims-report.pdf'), 'pdf-ish');
  const up = await run(W1, ['upload', R.file ?? '@e0', './claims-report.pdf']); const f1 = await ev(`(document.getElementById('file').files[0] || {}).name || null`);
  clause(A, 'upload-with-a-relative-path-attaches-the-file', up.code === 0 && f1 === 'claims-report.pdf', `${show(up)} → oracle files[0].name ${JSON.stringify(f1)}`);
  const upBad = await run(W1, ['upload', R.file ?? '@e0', './no-such-file.pdf']);
  const f2 = await ev(`(function(){ var f = document.getElementById('file').files; return { n: f.length, name: f[0] ? f[0].name : null, size: f[0] ? f[0].size : null }; })()`);
  console.log(`  INFO  [${A}] upload of a path that does not exist: ${show(upBad)} → the page now holds ${JSON.stringify(f2)} (it held claims-report.pdf before)`);
  // 4 dialogs
  const dNone = await run(W1, ['dialog', 'status']);
  await run(W1, ['click', R.ask ?? '@e0']);
  let dOpen = null; for (let i = 0; i < 20 && !dOpen; i++) { const d = await run(W1, ['dialog', 'status']); if (d.code === 0 && /confirm|claims\?|open/i.test(d.stdout) && !/no dialog|none/i.test(d.stdout)) dOpen = d; else await sleep(250); }
  clause(A, 'dialog-status-reports-an-open-confirm', !!dOpen && !(/confirm|claims\?|open/i.test(dNone.stdout) && !/no dialog|none/i.test(dNone.stdout)), `before the click «${dNone.stdout.trim()}»; while open «${dOpen?.stdout.trim()}»`);
  const blocked = await run(W1, ['eval', '1 + 1'], { timeoutMs: 8000 });
  console.log(`  INFO  [${A}] eval while a confirm() is open (the skill says the page is blocked until answered): ${show(blocked)}`);
  const da = await run(W1, ['dialog', 'accept']); let cv = null; for (let i = 0; i < 20 && cv === null; i++) { cv = await ev(`window.__c === undefined ? null : window.__c`); if (cv === null) await sleep(200); }
  clause(A, 'dialog-accept-answers-true', da.code === 0 && cv === true, `${show(da)} → oracle confirm() returned ${cv}`);
  await ev(`window.__c = undefined`); await run(W1, ['click', R.ask ?? '@e0']); await sleep(600);
  const dd = await run(W1, ['dialog', 'dismiss']); let cv2 = null; for (let i = 0; i < 20 && cv2 === null; i++) { cv2 = await ev(`window.__c === undefined ? null : window.__c`); if (cv2 === null) await sleep(200); }
  clause(A, 'dialog-dismiss-answers-false', dd.code === 0 && cv2 === false, `${show(dd)} → oracle confirm() returned ${cv2}`);
  // 5 console / errors (messages emitted AFTER the CLI first touched the page) + 6 network
  const conPre = await run(W1, ['console']); const errPre = await run(W1, ['errors']); const netPre = await run(W1, ['network', 'requests']);
  await run(W1, ['click', R.log ?? '@e0']); await run(W1, ['click', R.net ?? '@e0']); await sleep(900);
  const conPost = await run(W1, ['console']); const errPost = await run(W1, ['errors']); const netPost = await run(W1, ['network', 'requests']);
  clause(A, 'console-lists-a-message-logged-after-the-first-command', !conPre.stdout.includes('claims-log-click') && conPost.stdout.includes('claims-log-click'), `before «${conPre.stdout.trim().slice(0, 80)}» after «${conPost.stdout.trim().slice(0, 120)}»`);
  clause(A, 'errors-lists-an-uncaught-error-thrown-after-the-first-command', !errPre.stdout.includes('claims-uncaught-click') && errPost.stdout.includes('claims-uncaught-click'), `before ${show(errPre)} after ${show(errPost)}`);
  console.log(`  INFO  [${A}] console RAW after the click: ${JSON.stringify(conPost.stdout)}`);
  console.log(`  INFO  [${A}] errors raw: pre ${JSON.stringify(errPre)} post ${JSON.stringify(errPost)}`);
  { const pe = await ev(`window.__pageErr || null`); const lst = await run(W1, ['console', '--help']); console.log(`  INFO  [${A}] console --help ${show(lst)}`); }
  clause(A, 'network-requests-lists-a-request-made-after-the-first-command', !netPre.stdout.includes('claims-net=click') && netPost.stdout.includes('claims-net=click'), `before has it: ${netPre.stdout.includes('claims-net=click')}; after has it: ${netPost.stdout.includes('claims-net=click')}; «${netPost.stdout.trim().split('\n').slice(-2).join(' | ').slice(0, 140)}»`);
  console.log(`  INFO  [${A}] load-time page output seen by a later command? console has claims-log-load: ${conPost.stdout.includes('claims-log-load')}; errors has claims-uncaught-load: ${errPost.stdout.includes('claims-uncaught-load')}`);
  const wv1 = await run(W1, ['wait', '#h1']); const wv2 = await run(W1, ['wait', '100']); const wv3 = await run(W1, ['wait', '#no-such-element-xyz'], { timeoutMs: 40000 });
  clause(A, 'ctl/wait-on-the-VISIBLE-pane-selector-and-ms-work-and-a-missing-selector-times-out', wv1.code === 0 && wv2.code === 0 && wv3.code !== 0, `wait #h1 ${show(wv1)} | wait 100 ${show(wv2)} | wait #no-such… ${show(wv3)}`);
  // 7 cookies / storage
  const ckg = await run(W1, ['cookies', 'get']); const stg = await run(W1, ['storage', 'local', 'get', 'claimkey']); const stgNo = await run(W1, ['storage', 'local', 'get', 'nosuchkey']);
  clause(A, 'cookies-get-lists-the-pages-cookie', ckg.code === 0 && /claimcookie/.test(ckg.stdout), show(ckg));
  clause(A, 'storage-local-get-reads-a-key', stg.code === 0 && /v1-claim/.test(stg.stdout) && !/v1-claim/.test(stgNo.stdout), `get claimkey ${show(stg)}; ctl get nosuchkey ${show(stgNo)}`);
  // 8 get / is
  const gt = await run(W1, ['get', 'text', R.h1 ?? '@e0']); const gv = await run(W1, ['get', 'value', R.sel ?? '@e0']); const gu = await run(W1, ['get', 'url']); const gti = await run(W1, ['get', 'title']); const iv = await run(W1, ['is', 'visible', R.h1 ?? '@e0']);
  clause(A, 'get-text-value-url-title-and-is-visible-read-the-page', /V3 claims heading/.test(gt.stdout) && /g\b|Green/.test(gv.stdout) && /v3-claims\.html/.test(gu.stdout) && /V3 claims/.test(gti.stdout) && /true/i.test(iv.stdout), `text ${show(gt)} | value ${show(gv)} | url ${show(gu)} | title ${show(gti)} | visible ${show(iv)}`);
  // 9 --json
  const js = await run(W1, ['--json', 'snapshot', '-i']); let parsed = null; try { parsed = JSON.parse(js.stdout); } catch {}
  clause(A, 'json-flag-first-gives-machine-readable-output', js.code === 0 && parsed !== null, `${show(js)} → JSON.parse ${parsed === null ? 'FAILED' : 'ok (' + (Array.isArray(parsed) ? 'array' : typeof parsed) + ')'}`);
  // 10 scroll inside a box, scrollintoview, reload
  const y0 = await ev(`Math.round(window.scrollY)`); const bt0 = await ev(`Math.round(document.getElementById('bottom').getBoundingClientRect().top)`); const vh = await ev(`window.innerHeight`);
  const sc = await run(W1, ['scroll', 'down', '300', '--selector', '#panel']); const pt = await ev(`Math.round(document.getElementById('panel').scrollTop)`); const y1 = await ev(`Math.round(window.scrollY)`);
  clause(A, 'scroll-down-with-selector-scrolls-that-box-not-the-page', sc.code === 0 && pt >= 290 && pt <= 310 && y1 === y0, `${show(sc)} → panel.scrollTop ${pt}, window.scrollY ${y0}→${y1}`);
  const si = await run(W1, ['scrollintoview', R.bottom ?? '@e0']); const bt1 = await ev(`Math.round(document.getElementById('bottom').getBoundingClientRect().top)`);
  clause(A, 'scrollintoview-brings-the-element-into-the-viewport', bt0 > vh && si.code === 0 && bt1 >= 0 && bt1 < vh, `bottom.top ${bt0} (viewport ${vh}) → ${bt1}; ${show(si)}`);
  const l0 = await ev(`window.__loads`); const rl = await run(W1, ['reload']); await sleep(1200); const o2 = await oracle(ctx, `${FIX}/v3-claims.html`); const l1 = await o2.eval(`window.__loads`); o2.close();
  clause(A, 'reload-reloads-the-page', rl.code === 0 && l1 === l0 + 1, `${show(rl)} → page load count ${l0}→${l1} (sessionStorage counter)`);
  // 12 tab cap (8 tabs incl. the human's)
  const nTabs = async () => (await regTabs(ctx, W1)).tabs.length;
  const before = await nTabs(); const made = []; let refused = null;
  for (let i = 0; i < 10; i++) { const r = await run(W1, ['tab', 'new', `${FIX}/index.html?claims-tab=${i}`]); if (r.code === 0) made.push(r); else { refused = r; break; } }
  const after = await nTabs();
  clause(A, 'tab-new-stops-at-8-tabs-with-exit-1-and-says-so', after === 8 && !!refused && refused.code === 1 && /8|limit|too many|cap/i.test(refused.stderr), `tabs ${before} → ${after} after ${made.length} ok tab new; the next: ${refused ? show(refused) : 'NOT REFUSED'}`);
  { const lst = await run(W1, ['tab', 'list']); const mine = [...lst.stdout.matchAll(/\[(t\d+)\][^\n]*\(yours\)/g)].map((m) => m[1]); for (const t of mine) await run(W1, ['tab', 'close', t]); await sleep(600); console.log(`  INFO  [${A}] closed ${mine.length} of my tabs; tabs now ${await nTabs()}`); }
  // 13 refusals through the REAL CLI process
  const refuseCmd = async (cmd, re) => { const r = await run(W1, cmd, { timeoutMs: 20000 }); return { cmd: cmd.join(' '), ok: r.code !== 0 && re.test(r.stderr), r }; };
  const g1 = await Promise.all([['connect', '9222'], ['close'], ['session'], ['install'], ['batch', 'x'], ['plugin'], ['profiles']].map((c) => refuseCmd(c, /not available/i)));
  const g2 = await Promise.all([['get', 'url', '--cdp', '9222'], ['get', 'url', '--session', 'x'], ['get', 'url', '--profile', 'x'], ['get', 'url', '--headed']].map((c) => refuseCmd(c, /not allowed/i)));
  const g3 = await Promise.all([['download', '@e1', 'x'], ['trace', 'start'], ['record', 'start', 'x.webm'], ['profiler', 'start'], ['clipboard', 'read']].map((c) => refuseCmd(c, /./)));
  const gok = await run(W1, ['get', 'url']);
  clause(A, 'ctl/get-url-works', gok.code === 0, show(gok));
  clause(A, 'refused-commands-say-not-available', g1.every((x) => x.ok), g1.map((x) => `${x.cmd}→${x.r.code}«${x.r.stderr.trim().split('\n')[0].slice(0, 50)}»`).join(' | '));
  clause(A, 'refused-flags-say-not-allowed', g2.every((x) => x.ok), g2.map((x) => `${x.cmd}→${x.r.code}«${x.r.stderr.trim().split('\n')[0].slice(0, 50)}»`).join(' | '));
  clause(A, 'not-yet-available-commands-fail-with-a-message', g3.every((x) => x.ok), g3.map((x) => `${x.cmd}→${x.r.code}«${x.r.stderr.trim().split('\n')[0].slice(0, 50)}»`).join(' | '));
  // 14 hidden pane: the skill's two lists, ALL of them (the member's arm covers a subset)
  await selectWs(ctx, W1); await openPane(ctx);
  const o3 = (await openOn(ctx, W2, `${FIX}/v3-claims.html`)).o;
  const snapB = await run(W2, ['snapshot', '-i']); const RB = { name: refLine(snapB.stdout, /textbox.*Name/), ask: refLine(snapB.stdout, /button "ask"/), bottom: refLine(snapB.stdout, /button "bottom"/), h1: refLine(snapB.stdout, /heading/) };
  const hidden = await ctx.ui.eval(`!!([...document.querySelectorAll('.ws-item.active .ws-name')].find((e) => e.textContent.trim() === ${sel(W1.branch)}))`);
  clause(A, 'ctl/w2-is-in-the-background', hidden && Object.values(RB).every(Boolean), `${W1.branch} is the active workspace; refs ${JSON.stringify(RB)}`);
  const keep = [['get', 'title'], ['eval', 'document.title'], ['scroll', 'down', '200'], ['scrollintoview', RB.bottom ?? '@e0'], ['wait', '100'], ['wait', '#h1'], ['console'], ['network', 'requests'], ['cookies', 'get'], ['storage', 'local', 'get', 'claimkey'], ['get', 'text', RB.h1 ?? '@e0']];
  const kres = []; for (const c of keep) kres.push({ c: c.join(' '), r: await run(W2, c) });
  { // alternatives on the SAME hidden pane: which wait forms work?
    const alts = [['wait', '--fn', "!!document.getElementById('h1')"], ['wait', '--text', 'V3 claims heading'], ['eval', "!!document.getElementById('h1')"]];
    for (const c of alts) { const r = await run(W2, c, { timeoutMs: 40000 }); console.log(`  INFO  [${A}] hidden pane, ${c.join(' ')} → ${show(r)}`); }
  }
  for (const x of kres.filter((k) => k.r.code !== 0)) console.log(`  INFO  [${A}] hidden pane, a keep-working command that FAILED: ${x.c} → ${show(x.r)}`);
  const ys = await o3.eval(`Math.round(window.scrollY)`);
  clause(A, 'hidden-pane-the-keep-working-list-works', kres.every((x) => x.r.code === 0) && ys > 0, kres.map((x) => `${x.c.slice(0, 22)}→${x.r.code}`).join(' | ') + `; oracle scrollY ${ys}`);
  await o3.eval(`window.scrollTo(0, 0)`);
  const failList = [['screenshot', path.join(ctx.world.fakeHome, 'v3-hidden.png')], ['click', RB.ask ?? '@e0'], ['dblclick', RB.ask ?? '@e0'], ['hover', RB.ask ?? '@e0'], ['mouse', 'move', '20', '20'], ['press', 'Tab'], ['fill', RB.name ?? '@e0', 'zz'], ['type', RB.name ?? '@e0', 'zz'], ['keyboard', 'type', 'zz']];
  const fres = []; for (const c of failList) fres.push({ c: c.join(' '), r: await run(W2, c) });
  const nameV = await o3.eval(`document.getElementById('name').value`); const asked = await o3.eval(`window.__c === undefined && !document.querySelector('dialog')`);
  clause(A, 'hidden-pane-the-fail-fast-list-fails-fast-with-the-reason', fres.every((x) => x.r.code !== 0 && x.r.ms < 9000 && /not on screen|outside the viewport/.test(x.r.stderr)), fres.map((x) => `${x.c.slice(0, 20)}→${x.r.code}/${x.r.ms}ms`).join(' | '));
  clause(A, 'hidden-pane-the-failed-commands-did-nothing', nameV === '' && asked === true, `oracle name field ${JSON.stringify(nameV)}, no confirm() raised: ${asked}`);
  o3.close(); o.close();
};

async function runArms(ctx) {
  await waitFor(() => ctx.ui.eval(`document.body.innerText.includes(${sel(ctx.W1.branch)})`), 60000, 'the seeded workspaces in the sidebar');
  await sleep(1500);
  clause('ctl', 'app-in-my-sway', new RegExp(`"pid":\\s*${ctx.app.pid}\\b`).test(sh('swaymsg', ['-t', 'get_tree'])), `app pid ${ctx.app.pid} present in my sway's get_tree`);
  for (const arm of ARM_LIST) {
    console.log(`\n== arm ${arm} ==`);
    if (!ARM_FNS[arm]) { clause(arm, 'implemented', false, 'arm not implemented yet'); continue; }
    try { await ARM_FNS[arm](ctx); } catch (e) { clause(arm, 'arm-completed', false, `ARM ABORTED: ${e.stack || e}`); }
  }
}

// ── live-dir canary: independent tool (find) + json, before/after ─────────────────────────────────────────────────────────────
function liveCanary() {
  const snap = {};
  for (const d of fs.readdirSync(LIVE_HOME).filter((n) => n === '.claude' || n.startsWith('.claude-')).map((n) => path.join(LIVE_HOME, n))) {
    let links = ''; try { links = sh('find', [d, '-maxdepth', '1', '-type', 'l', '-printf', '%f->%l\\n']).split('\n').sort().join('|'); } catch {}
    let mcp = ''; for (const f of [path.join(d, '.claude.json'), path.join(LIVE_HOME, '.claude.json')]) { try { mcp += Object.keys(JSON.parse(fs.readFileSync(f, 'utf8')).mcpServers || {}).sort().join(',') + ';'; } catch {} }
    snap[d] = md5(links) + ':' + md5(mcp) + ` (${links.split('|').filter(Boolean).length} symlinks)`;
  }
  const abDot = path.join(LIVE_HOME, '.agent' + '-browser');
  snap['agent-browser dot-dir in the real home'] = fs.existsSync(abDot) ? 'exists' : 'absent';
  return snap;
}

const before = liveCanary();
console.log(`[rig] app ${APP_DIR} arms ${ARM_LIST.join(',')} mutant=${MUTANT ?? 'none'} out=${OUT}`);
applyMutant();
await main();
const after = liveCanary();
const same = JSON.stringify(before) === JSON.stringify(after);
clause('ctl', 'live-dirs-untouched', same, `${Object.keys(before).length} live probes (symlink-set + mcpServers hashes of each ~/.claude*, agent-browser dot-dir existence) ${same ? 'identical before/after' : 'CHANGED: ' + JSON.stringify({ before, after })}`);

// ── verdict ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const isCtl = (c) => c.arm === 'ctl' || c.clause.startsWith('ctl/');
const targetArms = new Set(MUTANT ? MUTANTS[MUTANT].arms : ARM_LIST);
// A mutant may break OTHER arms (collateral): their arm-scoped controls are not the mutant's concern. Global controls (app identity, containment, teardown, live dirs) always are.
const ctlRed = results.filter((c) => isCtl(c) && !c.ok && (c.arm === 'ctl' || targetArms.has(c.arm))), armRed = results.filter((c) => !isCtl(c) && !c.ok);
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify({ app: APP_DIR, mutant: MUTANT, results, gaps, shots }, null, 2));
let verdict, rc;
if (MUTANT) {
  const want = MUTANTS[MUTANT].arms;
  const redArms = new Set(armRed.filter((c) => c.clause !== 'arm-completed').map((c) => c.arm)); // an aborted arm is not a kill: a NAMED clause must go red
  const missed = want.filter((a) => !redArms.has(a));
  ({ verdict, rc } = ctlRed.length === 0 && missed.length === 0
    ? { verdict: `MUTANT ${MUTANT} KILLED: arm(s) ${want.join(', ')} red (${armRed.filter((c) => want.includes(c.arm)).map((c) => c.clause).join(', ')}), every control green; other red arms: ${[...redArms].filter((a) => !want.includes(a)).join(', ') || 'none'}`, rc: 0 }
    : { verdict: `MUTANT ${MUTANT} SURVIVED/INVALID: arms not red: ${missed.join(', ') || 'none'}; controls red: ${ctlRed.map((c) => c.clause).join('; ') || 'none'}`, rc: 1 });
} else {
  ({ verdict, rc } = ctlRed.length === 0 && armRed.length === 0
    ? { verdict: `ALL GREEN: ${results.length} clauses (${results.filter(isCtl).length} controls, ${results.length - results.filter(isCtl).length} arm clauses) over ${ARM_LIST.length} arms`, rc: 0 }
    : { verdict: `RED: ${results.filter((c) => !c.ok).map((c) => `${c.arm}:${c.clause}`).join('; ')}`, rc: 1 });
}
for (const g of gaps) console.log(`[gap] ${g.closed ? 'CLOSED' : 'OPEN  '} ${g.arm}:${g.clause} — ${g.ref}`);
console.log(`\nVERDICT: ${verdict}`);
process.exit(process.exitCode || rc);
