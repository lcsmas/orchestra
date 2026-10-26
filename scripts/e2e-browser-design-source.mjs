// #403 — design-mode component file:line + closed-shadow-root overlay, on the BUILT app in the contained rig's own headless sway.
//   react18  arm: React 18.2 dev fixture → a pick carries the owner component + source file:line (self / owner fallback / secret-filtered).
//   react19  arm: React 19 dev fixture (fibers have _debugStack, NO _debugSource) → selector path, no component, no error.
//   hostile  arm: plain-DOM fixture whose CSS attacks any foreign overlay → the overlay is a CLOSED shadow root, visible in the
//                 composited output (grim pixels), survives a late max-z-index cover, and cannot be picked itself.
//   ui       arm: the real toolbar crosshair → click → the composer draft carries the `component:` line.
//   --mutant <name>  runs the SAME arms against a COPY of the built app whose dist-electron chunk has ONE clause broken; the run must
//                    go RED on the named clauses while every ctl/ clause stays green (exit 0 only then). <app-dir> is never written.
// Usage (via scripts/e2e-browser-design-source.sh): <app-dir> --live-cfg <dir> --real-home <dir> [--arm react18,react19,hostile,ui] [--mutant name] [--out dir]
import { execFileSync, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const { decodePng, share } = require_('./e2e-browser-tabs-png.cjs');
import { privateRuntimeDir } from './lib/rig-runtime.mjs';
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const REAL_APP_DIR = argv[0] && !argv[0].startsWith('--') ? fs.realpathSync(argv[0]) : null;
const LIVE_CFG = flag('--live-cfg', null);
const REAL_HOME = flag('--real-home', null);
const ARMS = flag('--arm', 'react18,react19,hostile,ui').split(',');
const MUTANT = flag('--mutant', null);
const refuse = (m) => { console.log(`REFUSED: ${m}`); process.exit(3); };
if (!REAL_APP_DIR) refuse('no <app-dir>');
const RIG_DIR = process.env.RIG_DIR, RIG_WAYLAND = process.env.RIG_WAYLAND;
if (!RIG_DIR || !RIG_WAYLAND) refuse('RIG_DIR / RIG_WAYLAND unset — run via scripts/e2e-browser-design-source.sh (the contained rig)');
if (process.env.DISPLAY) refuse(`X11 DISPLAY=${process.env.DISPLAY} is set`);
if (process.env.WAYLAND_DISPLAY !== RIG_WAYLAND || RIG_WAYLAND === 'wayland-1') refuse(`WAYLAND_DISPLAY=${process.env.WAYLAND_DISPLAY} != marker-verified ${RIG_WAYLAND}`);
const XDG = privateRuntimeDir(); // throws unless this is the contained rig's PRIVATE runtime dir (incident Q2)
const NO_BUS = `unix:path=${RIG_DIR}/no-session-bus`;
if (process.env.DBUS_SESSION_BUS_ADDRESS !== NO_BUS) refuse(`DBUS_SESSION_BUS_ADDRESS=${process.env.DBUS_SESSION_BUS_ADDRESS} is not the rig's private nonexistent bus ${NO_BUS}`);
const OUT = flag('--out', null) || path.join(RIG_DIR, 'shots');
fs.mkdirSync(OUT, { recursive: true });
const RIG_BASE = fs.realpathSync(path.dirname(RIG_DIR));
const mustBeScratch = (what, p) => { const r = fs.existsSync(p) ? fs.realpathSync(p) : path.resolve(p); if (!(r === RIG_BASE || r.startsWith(RIG_BASE + path.sep))) refuse(`${what}=${p} is outside the rig base ${RIG_BASE}`); if (/\/\.claude(-[^/]*)?(\/|$)/.test(r) || r.includes('/.config/orchestra') || /\/\.orchestra(\/|$)/.test(r)) refuse(`${what}=${p} is a live dir`); };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const md5 = (b) => crypto.createHash('md5').update(b).digest('hex');
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
const sh = (cmd, args, opt = {}) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opt });
const git = (cwd, args, home) => sh('git', ['-c', 'user.name=rig', '-c', 'user.email=rig@example.invalid', ...args], { cwd, env: { PATH: process.env.PATH, HOME: home, GIT_CONFIG_NOSYSTEM: '1' } });
const freePort = () => new Promise((res, rej) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); s.on('error', rej); });
async function waitFor(fn, ms, what) { const t0 = Date.now(); let last; while (Date.now() - t0 < ms) { try { last = await fn(); if (last) return last; } catch (e) { last = e; } await sleep(150); } throw new Error(`timeout ${ms}ms waiting for ${what}${last instanceof Error ? `: ${last.message}` : ''}`); }

class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.handlers = {}; ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id) { const p = this.pending.get(m.id); if (p) { this.pending.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); } } else if (m.method) (this.handlers[m.method] ?? []).forEach((h) => h(m.params)); }; }
  static async connect(url) { const ws = new WebSocket(url); await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws error')); }); return new Cdp(ws); }
  on(method, fn) { (this.handlers[method] ??= []).push(fn); }
  send(method, params = {}, ms = 20000) { const id = ++this.id; return new Promise((res, rej) => { const t = setTimeout(() => { this.pending.delete(id); rej(new Error(`CDP ${method} timed out`)); }, ms); this.pending.set(id, { res: (v) => { clearTimeout(t); res(v); }, rej: (e) => { clearTimeout(t); rej(e); } }); this.ws.send(JSON.stringify({ id, method, params })); }); }
  async eval(expr) { const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(`eval threw: ${r.exceptionDetails.text} ${r.exceptionDetails.exception?.description ?? ''}`); return r.result.value; }
  async mouse(type, x, y, extra = {}) { await this.send('Input.dispatchMouseEvent', { type, x, y, ...extra }); }
  async click(x, y) { for (const [type, extra] of [['mouseMoved', {}], ['mousePressed', { button: 'left', clickCount: 1 }], ['mouseReleased', { button: 'left', clickCount: 1 }]]) { await this.mouse(type, x, y, extra); await sleep(60); } }
  async key(key, code, vk) { for (const type of ['keyDown', 'keyUp']) { await this.send('Input.dispatchKeyEvent', { type, key, code, windowsVirtualKeyCode: vk, text: type === 'keyDown' && key === 'Enter' ? '\r' : undefined }); await sleep(40); } }
  close() { try { this.ws.close(); } catch {} }
}

const results = [];
const shots = [];
function clause(arm, name, ok, detail) { results.push({ arm, name, ok: !!ok, detail }); console.log(`  ${ok ? 'PASS' : 'FAIL'}  [${arm}] ${name} — ${detail}`); }
function listProcsByHome(home) { const out = []; for (const p of fs.readdirSync('/proc').filter((n) => /^\d+$/.test(n))) { try { if (fs.readFileSync(`/proc/${p}/environ`, 'utf8').split('\0').includes(`ORCHESTRA_HOME=${home}`)) out.push(+p); } catch {} } return out.filter((p) => p !== process.pid); }
function grim(name) { const f = path.join(OUT, name); sh('grim', ['-o', 'HEADLESS-1', f], { env: { PATH: process.env.PATH, WAYLAND_DISPLAY: RIG_WAYLAND, XDG_RUNTIME_DIR: XDG } }); const b = fs.readFileSync(f); shots.push({ file: f, md5: md5(b) }); return decodePng(b); }

// ── mutants: ONE clause of the BUILT main chunk broken in a COPY; find must match exactly once ──────────────────────
const MUTANTS = {
  'walker-dead': { find: 'component: reactSource(el),', to: () => 'component: null,', arms: ['react18'], red: ['react18/self'], note: 'the pick no longer asks the page walker' },
  'no-owner-fallback': { find: /for\(var (\w+)=(\w+)\((\w+)\._debugOwner\),(\w+)=0;\1&&\4<25;/, to: (m) => `for(var ${m[1]}=${m[2]}(${m[3]}._debugOwner),${m[4]}=0;false&&${m[4]}<25;`, arms: ['react18'], red: ['react18/owner-fallback'], note: 'no walk up _debugOwner for a source' },
  'secret-filter-off': { find: /function (\w+)\((\w+)\)\{if\((\w+)\.some\((\w+)=>\4\.test\(\2\)\)\)return!0;for\(const/, to: (m) => `function ${m[1]}(${m[2]}){return!1;if(${m[3]}.some(${m[4]}=>${m[4]}.test(${m[2]})))return!0;for(const`, arms: ['react18'], red: ['react18/secret-filter'], note: 'looksSecret always false' },
  'slug-rule-off': { find: /if\((\w+)\.length>=4&&Math\.max\(\.\.\.\1\.map\((\w+)=>\2\.length\)\)<=16\)continue;/, to: () => '', arms: ['react18'], red: ['react18/worktree-path'], note: 'the kebab-slug exemption is gone: an Orchestra worktree path reads as a token' },
  'stale-fiber': { find: /=function\((\w+)\)\{if\(!\1\|\|!\1\.alternate\)return \1;try\{/, to: (m) => `=function(${m[1]}){return ${m[1]};try{`, arms: ['react18'], red: ['react18/rerender'], note: 'always the DOM-cached first-mount fiber, never the current alternate' },
  'return-chain-rule': { find: /(\w+)=function\((\w+)\)\{if\(!\2\|\|!\2\.alternate\)return \2;try\{[\s\S]*?\}catch\{return \2\}\};/, to: (m) => `${m[1]}=function(${m[2]}){if(!${m[2]}||!${m[2]}.alternate)return ${m[2]};var f=function(x){var r=x;for(var k=0;r.return&&k<5e3;k++)r=r.return;return!!r.stateNode&&r.stateNode.current===r};if(f(${m[2]}))return ${m[2]};if(f(${m[2]}.alternate))return ${m[2]}.alternate;return ${m[2]}};`, arms: ['react18'], red: ['react18/memo-bailout'], note: 'the pre-F1b rule ("the .return chain ends at root.current") instead of React\'s child-list walk' },
  'shadow-open': { find: "{ mode: 'closed' }", to: () => "{ mode: 'open' }", arms: ['hostile'], red: ['hostile/closed-shadow'], note: 'open shadow root' },
  'style-not-important': { find: "el.style.setProperty(d[0], d[1], 'important')", to: () => "el.style.setProperty(d[0], d[1], '')", arms: ['hostile'], red: ['hostile/survives-css', 'hostile/pixels'], note: 'host styles lose !important' },
  'no-all-initial': { find: "['all', 'initial'], ", to: () => '', arms: ['hostile'], red: ['hostile/survives-css'], note: 'host inherits the page visibility' },
  'no-top-layer': { find: 'host.showPopover();', to: () => '', arms: ['hostile'], red: ['hostile/late-cover', 'hostile/top-layer'], note: 'overlay no longer in the top layer' },
  'bogus-fallback': { find: /if\(!(\w+)\((\w+)\)\)return null;var (\w+)=(\w+)\?/, to: (m) => `if(!${m[1]}(${m[2]}))return{name:"Bogus",file:"/bogus.js",line:1};var ${m[3]}=${m[4]}?`, arms: ['react19'], red: ['react19/fallback'], note: 'no source found -> a bogus component instead of the selector-path fallback' },
  'walker-throws': { find: /if\(!(\w+)\((\w+)\)\)return null;var (\w+)=(\w+)\?/, to: (m) => `if(!${m[1]}(${m[2]})){null.x}var ${m[3]}=${m[4]}?`, also: { find: /\}catch\{return null\}\}const (\w+)=\[\/-----BEGIN/, to: (m) => `}catch(e){throw e}}const ${m[1]}=[/-----BEGIN` }, arms: ['react19'], red: ['react19/no-error', 'react19/fallback'], note: 'the walker throws when there is no React source (and does not catch) -> the click handler dies, no pick' },
  'block-drops-component': { target: 'renderer', anchor: '- component: ', find: /(\w+)\.component&&(\w+)\.push\(`- component: /, to: (m) => `false&&${m[2]}.push(\`- component: `, arms: ['ui'], red: ['ui/composer-has-component-line'], note: 'the composer block no longer prints the component line' },
  'overlay-pickable': { find: /\['pointer-events', 'none'\]\]\);\n  const root/, to: () => "['pointer-events', 'auto']]);\n  const root", also: { find: 'if (all[i] !== host)', to: () => 'if (true)' }, arms: ['hostile'], red: ['hostile/not-self-pickable'], note: 'host is hit-testable AND the host skip is gone (the full-viewport highlight also reddens the pixel clauses — expected collateral, none of them a ctl/)' },
};
function mutate(src, spec) {
  const apply = (code, f, to) => { const re = typeof f === 'string' ? null : f; const n = re ? [...code.matchAll(new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g'))].length : code.split(f).length - 1; if (n !== 1) throw new Error(`mutant find occurs ${n}x (need exactly 1): ${String(f).slice(0, 90)}`); if (re) { const m = re.exec(code); return code.replace(re, to(m)); } return code.replace(f, () => to()); };
  let out = apply(src, spec.find, spec.to);
  if (spec.also) out = apply(out, spec.also.find, spec.also.to);
  return out;
}
function prepareApp() {
  if (!MUTANT) return REAL_APP_DIR;
  const spec = MUTANTS[MUTANT]; if (!spec) throw new Error(`unknown mutant ${MUTANT}; known: ${Object.keys(MUTANTS).join(', ')}`);
  const renderer = spec.target === 'renderer';
  const dir = path.join(RIG_DIR, `mut-app-${MUTANT}`); fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(path.join(REAL_APP_DIR, 'package.json'), path.join(dir, 'package.json'));
  fs.symlinkSync(path.join(REAL_APP_DIR, 'node_modules'), path.join(dir, 'node_modules'));
  if (renderer) fs.cpSync(path.join(REAL_APP_DIR, 'dist'), path.join(dir, 'dist'), { recursive: true }); else fs.symlinkSync(path.join(REAL_APP_DIR, 'dist'), path.join(dir, 'dist'));
  fs.cpSync(path.join(REAL_APP_DIR, 'dist-electron'), path.join(dir, 'dist-electron'), { recursive: true });
  const [sub, anchor] = renderer ? [path.join('dist', 'assets'), spec.anchor] : ['dist-electron', '__orchestra_design_overlay__'];
  const chunks = fs.readdirSync(path.join(dir, sub)).filter((n) => n.endsWith('.js')).map((n) => path.join(dir, sub, n)).filter((f) => fs.readFileSync(f, 'utf8').includes(anchor));
  if (chunks.length !== 1) throw new Error(`expected exactly 1 chunk in ${sub} carrying ${JSON.stringify(anchor)}, found ${chunks.length}`);
  const before = fs.readFileSync(chunks[0], 'utf8'), after = mutate(before, spec);
  fs.writeFileSync(chunks[0], after);
  execFileSync(process.execPath, ['--check', chunks[0]], { stdio: 'pipe' }); // a mutant that does not even parse would 'kill' everything for the wrong reason
  console.log(`MUTANT ${MUTANT} (${spec.note}): applied once in ${path.basename(chunks[0])}; chunk bytes ${before.length} -> ${after.length}; differs=${before !== after}`);
  if (before === after) throw new Error('mutant is a no-op');
  return dir;
}

const COLORS = { border: [106, 169, 255], banner: [255, 200, 0] };

async function startFixture(armDir) {
  const server = path.join(repoRoot, 'scripts/fixtures/browser-site/server.mjs');
  if (!fs.existsSync(server)) throw new Error('shared fixture server missing (#395): scripts/fixtures/browser-site/server.mjs');
  const p = spawn(process.execPath, [server, '0'], { stdio: ['ignore', 'pipe', 'inherit'], env: { PATH: process.env.PATH } });
  const port = await new Promise((res, rej) => { let buf = ''; p.stdout.on('data', (d) => { buf += d; const m = /LISTENING (\d+)/.exec(buf); if (m) res(+m[1]); }); p.on('exit', () => rej(new Error('fixture server exited'))); setTimeout(() => rej(new Error('fixture server start timeout')), 15000); });
  return { proc: p, base: `http://127.0.0.1:${port}` };
}

function baseEnv(armDir, extra = {}) {
  const fakeHome = path.join(armDir, 'home'), ohome = path.join(armDir, 'oh'), cfg = path.join(armDir, 'claude-config');
  for (const d of [fakeHome, ohome, cfg]) fs.mkdirSync(d, { recursive: true });
  const env = { PATH: `/usr/local/bin:/usr/bin:/bin`, HOME: fakeHome, XDG_RUNTIME_DIR: XDG, XDG_CONFIG_HOME: path.join(fakeHome, '.config'), XDG_CACHE_HOME: path.join(fakeHome, '.cache'),
    WAYLAND_DISPLAY: RIG_WAYLAND, SWAYSOCK: process.env.SWAYSOCK, ELECTRON_OZONE_PLATFORM_HINT: 'wayland', ORCHESTRA_OZONE: 'wayland', ORCHESTRA_OZONE_RELAUNCHED: '1',
    ORCHESTRA_HOME: ohome, ORCHESTRA_SELF_TUNE_CMD: '/bin/true', CLAUDE_CONFIG_DIR: cfg, LANG: 'C.UTF-8',
    // the rig's private nonexistent session bus (asserted at startup): the human's bus + keyring are unreachable from every rig Electron.
    DBUS_SESSION_BUS_ADDRESS: NO_BUS, ...extra };
  for (const k of ['HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'ORCHESTRA_HOME', 'CLAUDE_CONFIG_DIR']) mustBeScratch(`env.${k}`, env[k]);
  if ('DISPLAY' in env || env.WAYLAND_DISPLAY !== RIG_WAYLAND) refuse('child env would reach the human display');
  return { env, fakeHome, ohome, cfg };
}

// element centre in PAGE coordinates (viewport CSS px of the panel view)
const centreOf = (pcdp, sel) => pcdp.eval(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, left: r.left, top: r.top, width: r.width, height: r.height }; })()`);

async function main(APP_DIR) {
  const arm = 'app';
  console.log(`\n== app ${APP_DIR}${MUTANT ? ` [mutant ${MUTANT}]` : ''} ==`);
  const armDir = path.join(RIG_DIR, 'arm-app'); fs.mkdirSync(armDir, { recursive: true });
  const port = await freePort();
  const { env, fakeHome, ohome, cfg } = baseEnv(armDir, { ORCHESTRA_DEBUG_PORT: String(port) });
  const repoDir = path.join(armDir, 'repo'), wtDir = path.join(armDir, 'wt', 'design-1'); fs.mkdirSync(repoDir, { recursive: true }); fs.mkdirSync(path.dirname(wtDir), { recursive: true });
  git(repoDir, ['init', '-q', '-b', 'main'], fakeHome); fs.writeFileSync(path.join(repoDir, 'README.md'), '# seed\n'); git(repoDir, ['add', '.'], fakeHome); git(repoDir, ['commit', '-q', '-m', 'seed'], fakeHome);
  git(repoDir, ['worktree', 'add', '-q', '-b', 'e2e/design-1', wtDir], fakeHome);
  const account = { id: 'rig-design', label: 'rig (scratch config dir)', configDir: cfg }; mustBeScratch('account.configDir', cfg);
  const WS = 'ws-design-1';
  const ws = { id: WS, name: 'design-1', repoPath: repoDir, worktreePath: wtDir, branch: 'e2e/design-1', baseBranch: 'main', createdAt: Date.now(), status: 'idle', agent: 'claude', accountId: account.id };
  const sdir = path.join(ohome, 'userData', 'orchestra'); fs.mkdirSync(sdir, { recursive: true });
  fs.writeFileSync(path.join(sdir, 'store.json'), JSON.stringify({ repos: [{ path: repoDir, name: 'design-repo', defaultBranch: 'main', accountId: account.id }], workspaces: [ws], accounts: [account], selfTuneRuns: [] }, null, 2));
  const stub = path.join(armDir, 'stub-bin'); fs.mkdirSync(stub, { recursive: true });
  fs.writeFileSync(path.join(stub, 'claude'), '#!/bin/sh\necho DESIGN-STUB-CLAUDE "$@"\nsleep 3600\n', { mode: 0o755 });
  env.PATH = `${stub}:${env.PATH}`;
  clause(arm, 'ctl/pin', ws.accountId === account.id && account.configDir.startsWith(RIG_DIR), `workspace.accountId=${ws.accountId} account.id=${account.id} configDir=${account.configDir}`);

  const fx = await startFixture(armDir); const FX = fx.base;
  sh('swaymsg', ['output', 'HEADLESS-1', 'resolution', '1400x900']); sh('swaymsg', ['default_border', 'none']);
  const fd = fs.openSync(path.join(armDir, 'app.log'), 'w');
  const app = spawn(path.join(REAL_APP_DIR, 'node_modules/electron/dist/electron'), [APP_DIR, '--ozone-platform=wayland'], { cwd: APP_DIR, env, stdio: ['ignore', fd, fd], detached: true });
  console.log(`  app pid ${app.pid} port ${port} fixture ${FX}`);
  let cdp, pcdp;
  try {
    for (const pg of ['design-react18.html', 'design-react19.html', 'design-hostile.html']) { const r = await fetch(`${FX}/${pg}`); const t = await r.text(); clause(arm, `ctl/fixture-served ${pg}`, r.status === 200 && t.length > 1000, `HTTP ${r.status}, ${t.length} B`); }
    const target = await waitFor(async () => (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((x) => x.type === 'page' && x.url.includes('dist/index.html')) || null, 60000, 'the app page target');
    clause(arm, 'ctl/app-identity-path', target.url.includes(APP_DIR) && !target.url.includes('app.asar'), `target url ${target.url}`);
    cdp = await Cdp.connect(target.webSocketDebuggerUrl); await cdp.send('Page.enable');
    await waitFor(() => cdp.eval(`!!document.querySelector('.toolbar') && !!document.querySelector('[aria-label="Show browser pane"]')`), 60000, 'toolbar + browser toggle');
    const frameId = (await cdp.send('Page.getResourceTree')).frameTree.frame.id;
    const bundle = (await cdp.eval(`[...document.querySelectorAll('script[src]')].map((s) => s.src)`)).find((s) => /assets\/index-.*\.js/.test(s));
    const served = Buffer.from((await cdp.send('Page.getResourceContent', { frameId, url: bundle })).content, 'utf8');
    const onDisk = fs.readFileSync(path.join(APP_DIR, 'dist', bundle.split('/dist/')[1]));
    clause(arm, 'ctl/app-identity-bundle', md5(served) === md5(onDisk), `renderer bundle as served md5 ${md5(served)} == ${path.basename(bundle)} in the app dir md5 ${md5(onDisk)}`);
    // /proc/<pid>/environ is NOT a stable instrument here (Chromium rewrites that stack region once the process title is set) — prove the scratch env from both ends instead.
    const passed = { ORCHESTRA_HOME: env.ORCHESTRA_HOME, CLAUDE_CONFIG_DIR: env.CLAUDE_CONFIG_DIR, DISPLAY: env.DISPLAY, DBUS: env.DBUS_SESSION_BUS_ADDRESS };
    const seen = await cdp.eval(`document.body.innerText.includes('e2e/design-1')`);
    const udir = fs.existsSync(path.join(ohome, 'userData')) ? fs.readdirSync(path.join(ohome, 'userData')) : [];
    clause(arm, 'ctl/scratch-env', passed.ORCHESTRA_HOME === ohome && passed.CLAUDE_CONFIG_DIR === cfg && passed.DISPLAY === undefined && passed.DBUS === NO_BUS && seen && udir.length >= 2, `spawned with ORCHESTRA_HOME=${passed.ORCHESTRA_HOME} CLAUDE_CONFIG_DIR=${passed.CLAUDE_CONFIG_DIR} DISPLAY=${passed.DISPLAY ?? '<unset>'} DBUS_SESSION_BUS_ADDRESS=${passed.DBUS}; the app rendered the workspace seeded in THAT home (${seen}) and wrote ${udir.length} entries under its userData (${udir.slice(0, 5).join(', ')})`);
    // FREEZE (ledger #405, keyring incident): this rig NEVER reads the live session bus. The app is spawned with a dead
    // DBUS_SESSION_BUS_ADDRESS (asserted above); the evidence it could not connect is Chromium's own startup line in app.log.
    {
      const log = fs.readFileSync(path.join(armDir, 'app.log'), 'utf8');
      const dialled = log.split(`Failed to connect to socket ${RIG_DIR}/no-session-bus`).length - 1;
      clause(arm, 'ctl/bus-unreachable', dialled >= 1 && !/libsecret|gnome-keyring|Secret Service|keyring\//i.test(log), `app.log: Chromium dialled the rig's private nonexistent bus ${dialled}x and failed (so that is the address in force), and no line mentions libsecret/keyring/Secret Service`);
    }

    // open the pane (trusted click) so the panel exists and composites
    const tb = await cdp.eval(`(() => { const b = document.querySelector('[aria-label="Show browser pane"]').getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; })()`);
    await cdp.click(tb.x, tb.y);
    await waitFor(() => cdp.eval(`!!document.querySelector('.browser-url-input') && !!document.querySelector('.browser-holder')`), 20000, 'the browser pane');
    const orch = (call) => cdp.eval(`window.orchestra.${call}`);
    const holder = () => cdp.eval(`(() => { const b = document.querySelector('.browser-holder').getBoundingClientRect(); return { x: Math.round(b.left), y: Math.round(b.top), width: Math.round(b.width), height: Math.round(b.height) }; })()`);

    // pointer + pick helpers ------------------------------------------------------------------------------------------
    let pageErrors = [];
    async function openPage(name) {
      await orch(`browserNavigate(${JSON.stringify(WS)}, ${JSON.stringify(`${FX}/${name}`)})`);
      await waitFor(async () => { const s = await orch(`browserState(${JSON.stringify(WS)})`); return s.url === `${FX}/${name}` && !s.loading; }, 30000, `panel at ${name}`);
      pcdp?.close();
      const t = await waitFor(async () => (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((x) => x.type === 'page' && x.url === `${FX}/${name}`) || null, 20000, `the panel's CDP target for ${name}`);
      pcdp = await Cdp.connect(t.webSocketDebuggerUrl);
      pageErrors = [];
      await pcdp.send('Runtime.enable'); await pcdp.send('Log.enable');
      pcdp.on('Runtime.exceptionThrown', (p) => pageErrors.push(p.exceptionDetails?.exception?.description ?? p.exceptionDetails?.text));
      pcdp.on('Log.entryAdded', (p) => { if (p.entry.level === 'error') pageErrors.push(`${p.entry.source}: ${p.entry.text}`); });
      await sleep(400);
      return t;
    }
    const arm_ = () => orch(`browserDesignArm(${JSON.stringify(WS)})`);
    const poll = () => orch(`browserDesignPoll(${JSON.stringify(WS)})`);
    async function pickAt(sel) {
      await arm_();
      const c = await centreOf(pcdp, sel); if (!c) throw new Error(`no element ${sel}`);
      await pcdp.mouse('mouseMoved', c.x - 3, c.y - 3); await pcdp.mouse('mouseMoved', c.x, c.y); await sleep(250);
      await pcdp.click(c.x, c.y);
      return waitFor(async () => { const p = await poll(); return p && !p.cancelled ? p : null; }, 15000, `a pick on ${sel}`);
    }
    const comp = (p) => (p.component ? { name: p.component.name, file: p.component.file, line: p.component.line, column: p.component.column, via: p.component.via } : null);
    const fiberProbe = (sel) => pcdp.eval(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); const k = Object.keys(e).find((x) => x.startsWith('__reactFiber$')); if (!k) return { fiber: false }; const f = e[k]; return { fiber: true, hasDebugSource: !!f._debugSource, debugSourceFile: f._debugSource ? f._debugSource.fileName : null, hasDebugStack: !!f._debugStack, hasOwner: !!f._debugOwner, react: (window.React && window.React.version) || null }; })()`);

    // ── react18 ─────────────────────────────────────────────────────────────────────────────────────────────────────
    if (ARMS.includes('react18')) {
      await openPage('design-react18.html');
      const probe = await fiberProbe('#inc'), leakProbe = await fiberProbe('#leak');
      clause('react18', 'ctl/page-is-react18-dev', probe.fiber && probe.react === '18.2.0' && probe.hasDebugSource && probe.debugSourceFile === '/fixture/src/Counter.jsx', `fiber probe ${JSON.stringify(probe)}`);
      clause('react18', 'ctl/leak-path-is-in-the-page', leakProbe.hasDebugSource && /token=/.test(leakProbe.debugSourceFile || ''), `#leak fiber _debugSource.fileName=${leakProbe.debugSourceFile} (the secret really is on the fiber)`);
      const a = await pickAt('#inc');
      clause('react18', 'react18/self', a.component && a.component.name === 'Counter' && a.component.file === '/fixture/src/Counter.jsx' && a.component.line === 5 && a.component.via === 'self' && /button#inc/.test(a.selector), `pick on #inc: component=${JSON.stringify(comp(a))} selector=${a.selector}`);
      const b = await pickAt('#who');
      clause('react18', 'react18/owner-fallback', b.component && b.component.name === 'Greeting' && b.component.file === '/fixture/src/App.jsx' && b.component.line === 6 && b.component.via === 'owner', `pick on #who (no own JSX source): component=${JSON.stringify(comp(b))} (expected Greeting rendered at App.jsx:6 — the owner's use-site, labelled via=owner)`);
      const c = await pickAt('#title');
      clause('react18', 'react18/header', c.component && c.component.name === 'App' && c.component.file === '/fixture/src/App.jsx' && c.component.line === 4 && c.component.via === 'self', `pick on #title: component=${JSON.stringify(comp(c))}`);
      const d = await pickAt('#leak');
      const dj = JSON.stringify(d);
      clause('react18', 'react18/secret-filter', !d.component && !/Zm9vYmFy|token=|Leaky\.jsx/.test(dj) && /button#leak/.test(d.selector), `pick on #leak: component=${JSON.stringify(comp(d))}; selector=${d.selector}; secret substrings in the serialised pick: ${/Zm9vYmFy|token=|Leaky\.jsx/.test(dj)}`);
      // HMR shape: the element's JSX line CHANGES across re-renders (the file was edited) — every pick must report the CURRENT line
      const dyn = [];
      for (let i = 0; i < 4; i++) { if (i) { await pcdp.eval('window.bumpDyn()'); await sleep(300); } const p = await pickAt('#dyn'); dyn.push(p.component ? p.component.line : null); }
      clause('react18', 'react18/rerender', JSON.stringify(dyn) === '[10,12,14,16]', `4 picks on #dyn, its JSX line moved +2 by a re-render between picks: reported lines ${JSON.stringify(dyn)} (expected [10,12,14,16] — the DOM node caches the first-mount fiber, whose _debugSource goes stale on every other render)`);
      // memo BAILOUT shape (F1b): edits (E: DynMemo re-renders, its JSX line moves) interleaved with B (only an ancestor re-renders, the memo bails out)
      const memo = [];
      const memoPick = async () => { const p = await pickAt('#dynm'); memo.push([p.component ? p.component.line : null, await pcdp.eval('window.__dynmLine')]); };
      await memoPick();
      for (const op of ['E', 'B', 'E', 'B', 'B', 'E']) { await pcdp.eval(op === 'E' ? 'window.bumpEdit()' : 'window.bumpOuter()'); await sleep(300); await memoPick(); }
      clause('react18', 'react18/memo-bailout', memo.length === 7 && memo.every(([got, truth]) => got === truth) && new Set(memo.map((m) => m[1])).size === 4, `7 picks on #dynm across E,B,E,B,B,E (E moves the JSX line, B re-renders only an ancestor so the memo bails out): [reported, truth] = ${JSON.stringify(memo)}`);
      const e = await pickAt('#foot');
      clause('react18', 'react18/worktree-path', e.component && e.component.name === 'Footer' && e.component.file === '/home/dev/.orchestra/worktrees/orchestra-impl-design-mode-source-403-a6a5fb9d/src/Footer.jsx' && e.component.line === 2, `pick on #foot (source path is an Orchestra worktree slug, 47 chars of letters+digits): component=${JSON.stringify(comp(e))} — the secret filter must NOT eat it`);
      clause('react18', 'ctl/no-page-errors', pageErrors.length === 0, `page errors during the arm: ${JSON.stringify(pageErrors)}`);
    }

    // ── react19 ─────────────────────────────────────────────────────────────────────────────────────────────────────
    if (ARMS.includes('react19')) {
      await openPage('design-react19.html');
      const probe = await fiberProbe('#inc');
      clause('react19', 'ctl/page-is-react19-dev', probe.fiber && !probe.hasDebugSource && probe.hasDebugStack && probe.hasOwner, `fiber probe ${JSON.stringify(probe)} (a DEV fiber: _debugStack yes, _debugSource no)`);
      const safePick = async (sel) => { try { return await pickAt(sel); } catch (e) { return { error: String(e.message || e), selector: '', html: '' }; } };
      const a = await safePick('#inc');
      clause('react19', 'react19/fallback', !a.error && !a.component && /button#inc/.test(a.selector) && typeof a.html === 'string' && a.html.includes('id="inc"'), `pick on #inc: ${a.error ? `NO PICK (${a.error})` : `component=${JSON.stringify(comp(a))} selector=${a.selector}`}`);
      const b = await safePick('#who');
      clause('react19', 'react19/fallback-owner-element', !b.error && !b.component && /em#who/.test(b.selector), `pick on #who: ${b.error ? `NO PICK (${b.error})` : `component=${JSON.stringify(comp(b))} selector=${b.selector}`}`);
      clause('react19', 'react19/no-error', pageErrors.length === 0 && !a.error && !b.error, `page errors during the arm: ${JSON.stringify(pageErrors)}; both picks delivered=${!a.error && !b.error}`);
    }

    // ── hostile ─────────────────────────────────────────────────────────────────────────────────────────────────────
    if (ARMS.includes('hostile')) {
      await openPage('design-hostile.html');
      const A = await arm_(); void A;
      const OVERLAY = '__orchestra_design_overlay__';
      const c = await centreOf(pcdp, '#target');
      await pcdp.mouse('mouseMoved', c.x - 4, c.y - 4); await pcdp.mouse('mouseMoved', c.x, c.y); await sleep(450);
      const facts = await pcdp.eval(`(() => { const h = document.getElementById(${JSON.stringify(OVERLAY)}); if (!h) return { present: false }; const cs = getComputedStyle(h), r = h.getBoundingClientRect(); return { present: true, shadowRootVisible: h.shadowRoot !== null, lightChildren: h.childElementCount, display: cs.display, visibility: cs.visibility, opacity: cs.opacity, position: cs.position, w: r.width, h: r.height, vw: innerWidth, vh: innerHeight, z: cs.zIndex, popoverOpen: h.matches(':popover-open'), parent: h.parentElement && h.parentElement.tagName }; })()`);
      clause('hostile', 'ctl/attack-is-live', await pcdp.eval(`(() => { const d = document.createElement('div'); document.documentElement.appendChild(d); const hidden = getComputedStyle(d).display === 'none' && getComputedStyle(document.documentElement).visibility === 'hidden'; d.remove(); return hidden; })()`), 'the page stylesheet DOES hide a fresh <div> (display:none !important) and inherit-hide <html> — the attack is real');
      clause('hostile', 'hostile/closed-shadow', facts.present && facts.shadowRootVisible === false && facts.lightChildren === 0, `overlay host present=${facts.present}; host.shadowRoot visible to the page=${facts.shadowRootVisible} (must be false = closed); host light-DOM children=${facts.lightChildren} (must be 0: box+label live inside the shadow root)`);
      clause('hostile', 'hostile/survives-css', facts.present && facts.display === 'block' && facts.visibility === 'visible' && facts.opacity === '1' && facts.position === 'fixed' && Math.abs(facts.w - facts.vw) <= 1 && Math.abs(facts.h - facts.vh) <= 1 && facts.z === '2147483647', `computed under the attack: ${JSON.stringify(facts)}`);
      clause('hostile', 'hostile/top-layer', facts.present && facts.popoverOpen === true, `the host is in the top layer (:popover-open=${facts.popoverOpen}) — z-index alone cannot beat a later same-z-index element`);
      const h = await holder();
      const hov = grim('hostile-1-armed-hover.png');
      const edge = (I, r) => { let best = 0; for (let dy = -1; dy <= 3; dy++) { const s = share(I, { x: Math.round(h.x + r.left) + 6, y: Math.round(h.y + r.top) + dy, width: Math.max(1, Math.round(r.width) - 12), height: 1 }, COLORS.border, 14); best = Math.max(best, s); } return best; };
      const e1 = edge(hov, c);
      clause('hostile', 'hostile/pixels', e1 > 0.8, `composited pixels: the 2px #6aa9ff highlight border runs along ${(e1 * 100).toFixed(0)}% of #target's top edge (shot ${path.join(OUT, 'hostile-1-armed-hover.png')})`);
      const flat = share(hov, { x: h.x + 2, y: h.y + 2, width: 200, height: 40 }, COLORS.border, 14);
      clause('hostile', 'ctl/no-border-colour-elsewhere', flat < 0.01, `the border colour is absent from a patch away from the target (${(flat * 100).toFixed(2)}%) — the probe distinguishes presence from absence`);
      // a late, opaque, max-z-index cover appended after arming
      await pcdp.eval('window.addLateBanner()'); await sleep(400);
      const cov = grim('hostile-2-late-cover.png');
      const ban = await pcdp.eval(`(() => { const b = document.getElementById('late-banner'); if (!b) return null; const cs = getComputedStyle(b), r = b.getBoundingClientRect(); return { bg: cs.backgroundColor, pos: cs.position, z: cs.zIndex, covers: r.width >= innerWidth - 1 && r.height >= innerHeight - 1, after: !!(document.getElementById(${JSON.stringify(OVERLAY)}).compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) }; })()`);
      clause('hostile', 'ctl/late-cover-is-there', ban && ban.bg === 'rgb(255, 200, 0)' && ban.pos === 'fixed' && ban.z === '2147483647' && ban.covers && ban.after, `late cover (DOM): ${JSON.stringify(ban)} — appended AFTER the overlay host, same z-index, so without the top layer it paints on top`);
      const bannerShare = share(cov, { x: h.x + 10, y: h.y + 150, width: 200, height: 60 }, COLORS.banner, 10);
      const e2 = edge(cov, c);
      clause('hostile', 'hostile/late-cover', e2 > 0.8 && bannerShare > 0.9, `the highlight border is STILL on top of the cover: ${(e2 * 100).toFixed(0)}% of #target's top edge, while the cover paints ${(bannerShare * 100).toFixed(0)}% opaque yellow elsewhere (shot ${path.join(OUT, 'hostile-2-late-cover.png')})`);
      // cannot pick itself: click a spot; the pick must be a page element, never the overlay host
      await pcdp.eval(`(() => { const b = document.getElementById('late-banner'); if (b) b.remove(); return true; })()`);
      const p = await (async () => { await arm_(); const t = await centreOf(pcdp, '#title'); await pcdp.mouse('mouseMoved', t.x - 3, t.y); await pcdp.mouse('mouseMoved', t.x, t.y); await sleep(250); await pcdp.click(t.x, t.y); return waitFor(async () => { const r = await poll(); return r && !r.cancelled ? r : null; }, 15000, 'a pick on #title'); })();
      clause('hostile', 'hostile/not-self-pickable', /h1#title/.test(p.selector) && !p.selector.includes('orchestra') && !p.html.includes(OVERLAY), `pick at #title under the full-viewport overlay: selector=${p.selector}; html mentions the overlay=${p.html.includes(OVERLAY)}`);
      clause('hostile', 'hostile/fallback', !p.component, `plain-DOM page: component=${JSON.stringify(comp(p))} (selector path only)`);
      clause('hostile', 'ctl/no-page-errors', pageErrors.length === 0, `page errors: ${JSON.stringify(pageErrors)}`);
    }

    // ── ui ──────────────────────────────────────────────────────────────────────────────────────────────────────────
    if (ARMS.includes('ui')) {
      await openPage('design-react18.html');
      const btn = await cdp.eval(`(() => { const b = document.querySelector('[aria-label="Design mode"]'); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
      clause('ui', 'ctl/design-button-exists', !!btn, `toolbar [aria-label="Design mode"] ${JSON.stringify(btn)}`);
      if (btn) {
        await cdp.click(btn.x, btn.y);
        await waitFor(() => cdp.eval(`document.querySelector('[aria-label="Design mode"]').getAttribute('aria-pressed') === 'true'`), 10000, 'design mode armed in the UI');
        await sleep(600);
        const c = await centreOf(pcdp, '#inc');
        await pcdp.mouse('mouseMoved', c.x - 3, c.y - 3); await pcdp.mouse('mouseMoved', c.x, c.y); await sleep(250); await pcdp.click(c.x, c.y);
        const readDraft = () => cdp.eval(`[...document.querySelectorAll('.cm-content')].map((c) => [...c.querySelectorAll('.cm-line')].map((l) => l.textContent).join('\\n')).find((v) => v.includes('Selected element from the browser pane')) || null`);
        const draft = await waitFor(readDraft, 20000, 'the composer draft carrying the pick').catch(async (e) => `NO-DRAFT: ${e.message}; .cm-content nodes=${await cdp.eval("document.querySelectorAll('.cm-content').length")}; armed=${await cdp.eval("document.querySelector('[aria-label=\"Design mode\"]')?.getAttribute('aria-pressed')")}`);
        clause('ui', 'ui/composer-has-component-line', typeof draft === 'string' && draft.includes('- component: `Counter` — `/fixture/src/Counter.jsx:5`'), `composer draft: ${JSON.stringify(String(draft).slice(0, 260))}`);
      }
    }
  } catch (e) { clause(arm, 'arm completed without error', false, String(e.stack || e)); }
  finally {
    cdp?.close(); pcdp?.close(); try { fx.proc.kill(); } catch {}
    for (const p of listProcsByHome(ohome)) { try { process.kill(p, 'SIGTERM'); } catch {} }
    await sleep(1500);
    for (const p of listProcsByHome(ohome)) { try { process.kill(p, 'SIGKILL'); } catch {} }
    clause(arm, "ctl/teardown: no process left carrying this run's ORCHESTRA_HOME", listProcsByHome(ohome).length === 0, `survivors ${JSON.stringify(listProcsByHome(ohome))}`);
  }
}

// ── hygiene ───────────────────────────────────────────────────────────────────────────────────────────────────────
const hashes = (files) => Object.fromEntries(files.filter((f) => fs.existsSync(f)).map((f) => [f, sha256(fs.readFileSync(f))]));
const snap = () => {
  const files = [];
  if (LIVE_CFG) for (const n of ['CLAUDE.md', 'settings.json', '.credentials.json', 'LESSONS.md']) files.push(path.join(LIVE_CFG, n));
  if (REAL_HOME) files.push(path.join(REAL_HOME, '.config/orchestra/orchestra/secrets.json'), path.join(REAL_HOME, '.claude/settings.json'));
  return hashes(files);
};
const realChunkHashes = () => hashes([...fs.readdirSync(path.join(REAL_APP_DIR, 'dist-electron')).filter((n) => n.endsWith('.js')).map((n) => path.join(REAL_APP_DIR, 'dist-electron', n)), ...fs.readdirSync(path.join(REAL_APP_DIR, 'dist/assets')).filter((n) => n.endsWith('.js')).map((n) => path.join(REAL_APP_DIR, 'dist/assets', n))]);

const before = snap(), chunksBefore = realChunkHashes();
const appDir = prepareApp();
await main(appDir);
const after = snap(), chunksAfter = realChunkHashes();
clause('hygiene', 'live config files byte-equal around the rig (sha256)', JSON.stringify(before) === JSON.stringify(after) && Object.keys(before).length > 0, `${Object.keys(before).length} files compared`);
clause('hygiene', '<app-dir> dist-electron + dist/assets untouched (mutants patch a COPY)', JSON.stringify(chunksBefore) === JSON.stringify(chunksAfter), `${Object.keys(chunksBefore).length} js files, sha256 equal before/after`);

const appShots = shots.filter((s) => /hostile-/.test(s.file)); const dup = appShots.map((s) => s.md5).filter((m, i, a) => a.indexOf(m) !== i);
console.log('\nSHOTS:'); for (const s of shots) console.log(`  ${s.md5}  ${s.file}`);
if (ARMS.includes('hostile')) clause('shots', 'hostile captures all distinct (md5)', appShots.length >= 2 && !dup.length, `${appShots.length} captures, duplicates ${[...new Set(dup)].join(',') || 'none'}`);

const fails = results.filter((r) => !r.ok);
if (MUTANT) {
  const spec = MUTANTS[MUTANT];
  const redNamed = spec.red.every((n) => fails.some((f) => f.name.startsWith(n)));
  const redControls = fails.filter((f) => f.name.startsWith('ctl/') || f.arm === 'hygiene' || f.arm === 'app');
  console.log(`\nMUTANT ${MUTANT}: red clauses = ${fails.map((f) => f.name).join(' | ') || 'none'}`);
  console.log(redNamed && !redControls.length ? `MUTANT KILLED on the intended clause(s) (${spec.red.join(', ')}), controls green` : `MUTANT NOT KILLED CLEANLY (intended-red=${redNamed}, red controls=${redControls.map((f) => f.name).join('|') || 0})`);
  process.exit(redNamed && !redControls.length ? 0 : 1);
}
console.log(`\n${results.length - fails.length}/${results.length} clauses PASS${fails.length ? `; FAIL: ${fails.map((f) => f.name).join(' | ')}` : ''}`);
process.exit(fails.length ? 1 : 0);
