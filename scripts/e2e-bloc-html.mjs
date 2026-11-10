// #415 — Bloc HTML isolation rig (ADR 0011). Boots a BUILT Orchestra (argv[2] = app dir) in the contained rig's own headless sway with a SCRATCH
// ORCHESTRA_HOME / HOME / CLAUDE_CONFIG_DIR and a stub `claude`, replays a conversation through the app's own event path (`__injectAgentEvent`), and
// measures what a Bloc HTML can reach — a local listener plays "the network", the page's `message` seam plays "what the bloc says".
//
// Arms (each = one app boot):
//   real          the build as is — every clause GREEN (P* = what a human sees, I* = what a bloc can reach)
//   policy        a COPY whose frame document lost its policy <meta>         → I1 must go RED (frame reaches the local listener)
//   nav           a COPY whose main-process navigation guard never fires      → I2 must go RED (a frame navigation reaches the listener)
//   sandbox-api   a COPY whose frame lost its `sandbox` attribute (same-origin) → I3 must go RED (the frame reads the app's API object)
//   sandbox-loop  the same copy, a looping bloc                               → I4 must go RED (the window freezes)
// A mutant arm passes only if its named clause is RED, every control GREEN, and its OTHER evaluated I-clauses GREEN (it removes ONE guard).
// The mutation is applied to a disposable COPY (one string, counted == 1); the built app dir is md5-compared before/after.
import { execFileSync, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import zlib from 'node:zlib';

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const APP_DIR = argv[0] && !argv[0].startsWith('--') ? fs.realpathSync(argv[0]) : null;
const LIVE_HOME = flag('--live-home', null);
const ARMS = (flag('--arms', 'real,policy,nav,sandbox-api,sandbox-loop')).split(',');
const refuse = (m) => { console.log(`REFUSED: ${m}`); process.exit(3); };
if (!APP_DIR) refuse('no <app-dir>');
if (!LIVE_HOME) refuse('--live-home missing (needed to protect the live ~/.claude* and to prove nothing there moved)');
const RIG_DIR = process.env.RIG_DIR;
const RIG_WAYLAND = process.env.RIG_WAYLAND;
if (!RIG_DIR || !RIG_WAYLAND) refuse('RIG_DIR / RIG_WAYLAND unset — run via scripts/e2e-bloc-html.sh (the contained rig)');
if (process.env.DISPLAY) refuse(`X11 DISPLAY=${process.env.DISPLAY} is set — Electron would reach the human's screen`);
if (process.env.WAYLAND_DISPLAY !== RIG_WAYLAND || RIG_WAYLAND === 'wayland-1') refuse(`WAYLAND_DISPLAY=${process.env.WAYLAND_DISPLAY} != marker-verified ${RIG_WAYLAND}`);
const OUT = flag('--out', null) || path.join(RIG_DIR, 'shots');

// ── scratch-containment guard (live dirs are never handed to the app) ─────────────────────────────
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

// ── helpers ───────────────────────────────────────────────────────────────────────────────────────
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
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
const treeHash = (dirs) => md5(dirs.flatMap((d) => walk(d)).sort().map((f) => `${f}:${md5(fs.readFileSync(f))}`).join('\n'));

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
const px = (I, x, y) => { const o = (Math.round(y) * I.w + Math.round(x)) * I.ch; return [I.data[o], I.data[o + 1], I.data[o + 2]]; };
const near = (a, b, tol = 6) => a.every((v, i) => Math.abs(v - b[i]) <= tol);
const rgbOf = (s) => (/rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(s) || []).slice(1, 4).map(Number);

class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); ws.onmessage = (ev) => { const m = JSON.parse(ev.data); const p = m.id && this.pending.get(m.id); if (p) { this.pending.delete(m.id); m.error ? p.rej(new Error(`${m.error.message}`)) : p.res(m.result); } }; }
  static async connect(url) { const ws = new WebSocket(url); await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws error')); }); return new Cdp(ws); }
  send(method, params = {}, ms = 20000) {
    const id = ++this.id;
    return new Promise((res, rej) => { const t = setTimeout(() => { this.pending.delete(id); rej(new Error(`CDP ${method} timed out after ${ms}ms`)); }, ms); this.pending.set(id, { res: (v) => { clearTimeout(t); res(v); }, rej: (e) => { clearTimeout(t); rej(e); } }); this.ws.send(JSON.stringify({ id, method, params })); });
  }
  async eval(expr, ms = 20000) { const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, ms); if (r.exceptionDetails) throw new Error(`eval threw: ${r.exceptionDetails.text} ${r.exceptionDetails.exception?.description ?? ''}`); return r.result.value; }
  async click(x, y) { for (const [type, extra] of [['mouseMoved', {}], ['mousePressed', { button: 'left', clickCount: 1 }], ['mouseReleased', { button: 'left', clickCount: 1 }]]) { await this.send('Input.dispatchMouseEvent', { type, x, y, ...extra }); await sleep(60); } }
  async shot() { const r = await this.send('Page.captureScreenshot', { format: 'png' }, 25000); return Buffer.from(r.data, 'base64'); }
  close() { try { this.ws.close(); } catch {} }
}

// ── the "network": a local listener that records every request, upgrade and raw connection ─────────
function startEvil() {
  const hits = []; let conns = 0;
  const srv = http.createServer((req, res) => { hits.push(req.url); res.writeHead(200, { 'content-type': 'text/plain', 'access-control-allow-origin': '*' }); res.end('evil'); });
  srv.on('connection', () => { conns++; });
  srv.on('upgrade', (req, sock) => { hits.push(`UPGRADE ${req.url}`); sock.destroy(); });
  return new Promise((res) => srv.listen(0, '127.0.0.1', () => res({ srv, port: srv.address().port, hits, conns: () => conns, reset: () => { hits.length = 0; conns = 0; } })));
}

// ── seeding: a real git repo + registered worktree, the PINNED scratch account, a stub `claude` ────
const WS = 'ws-bh415-1';
function seedWorld(armDir) {
  const fakeHome = path.join(armDir, 'home'), ohome = path.join(armDir, 'oh'), cfg = path.join(armDir, 'claude-config');
  const repoDir = path.join(armDir, 'repo'), wtDir = path.join(armDir, 'wt', 'bh415-1');
  for (const d of [fakeHome, ohome, cfg, repoDir, path.dirname(wtDir)]) fs.mkdirSync(d, { recursive: true });
  for (const [k, v] of Object.entries({ HOME: fakeHome, ORCHESTRA_HOME: ohome, CLAUDE_CONFIG_DIR: cfg, repo: repoDir, wt: wtDir })) mustBeScratch(k, v);
  git(repoDir, ['init', '-q', '-b', 'main'], fakeHome);
  fs.writeFileSync(path.join(repoDir, 'README.md'), '# bh415 seed repo\n');
  git(repoDir, ['add', '.'], fakeHome); git(repoDir, ['commit', '-q', '-m', 'seed'], fakeHome);
  git(repoDir, ['worktree', 'add', '-q', '-b', 'e2e/bh415-1', wtDir], fakeHome);
  const account = { id: 'rig-bh415', label: 'rig (scratch config dir)', configDir: cfg };
  mustBeScratch('account.configDir', account.configDir);
  const ws = { id: WS, name: 'bh415-1', repoPath: repoDir, worktreePath: wtDir, branch: 'e2e/bh415-1', baseBranch: 'main', createdAt: Date.now(), status: 'idle', agent: 'claude', accountId: account.id };
  const dir = path.join(ohome, 'userData', 'orchestra'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'store.json'), JSON.stringify({ repos: [{ path: repoDir, name: 'bh415-repo', defaultBranch: 'main', accountId: account.id }], workspaces: [ws], accounts: [account], selfTuneRuns: [] }, null, 2));
  const stubDir = path.join(armDir, 'stub-bin'); fs.mkdirSync(stubDir, { recursive: true });
  fs.writeFileSync(path.join(stubDir, 'claude'), '#!/bin/sh\necho BH415-STUB-CLAUDE "$@"\nsleep 3600\n', { mode: 0o755 });
  return { fakeHome, ohome, cfg, account, ws, stubDir };
}

// ── event helpers (the events the app folds exactly as a live session's) ──────────────────────────
let SEQ = 1, IDX = 0;
const at = () => 1754300000000 + SEQ;
const evText = (t) => { const index = IDX++; return [{ type: 'block-start', seq: SEQ++, at: at(), index, kind: 'text' }, { type: 'text-delta', seq: SEQ++, at: at(), index, text: t }, { type: 'block-stop', seq: SEQ++, at: at(), index }]; };
const evOpen = (t) => { const index = IDX++; return { index, events: [{ type: 'block-start', seq: SEQ++, at: at(), index, kind: 'text' }, { type: 'text-delta', seq: SEQ++, at: at(), index, text: t }] }; };
const evMore = (index, t, stop) => [{ type: 'text-delta', seq: SEQ++, at: at(), index, text: t }, ...(stop ? [{ type: 'block-stop', seq: SEQ++, at: at(), index }] : [])];
const evUser = (text, extra = {}) => ({ type: 'user-message', seq: SEQ++, at: at(), text, ...extra });
const evTool = (id, name, input, result) => { const index = IDX++; return [{ type: 'block-start', seq: SEQ++, at: at(), index, kind: 'tool_use', toolUseId: id, name }, { type: 'tool-use', seq: SEQ++, at: at(), index, toolUseId: id, name, input }, { type: 'block-stop', seq: SEQ++, at: at(), index }, { type: 'tool-result', seq: SEQ++, at: at(), toolUseId: id, content: result, isError: false }]; };

const fence = (info, body) => '```' + info + '\n' + body + '\n```';

// ── the blocs ─────────────────────────────────────────────────────────────────────────────────────
const THEME_BLOC = `<div id="card" style="width:50%;height:200px;background:var(--bloc-accent);color:var(--bloc-surface)">card</div>
<script>parent.postMessage({__probe:'theme',r:{accent:getComputedStyle(document.getElementById('card')).backgroundColor,fg:getComputedStyle(document.body).color,fs:getComputedStyle(document.body).fontSize,bg:getComputedStyle(document.body).backgroundColor,fgVar:getComputedStyle(document.documentElement).getPropertyValue('--bloc-fg').trim()}},'*')</script>`;
const isoBloc = (evil, port) => `<div id="m" style="height:60px;color:var(--bloc-accent)">isolation probe</div>
<link rel="preconnect" href="${evil}"><link rel="prefetch" href="${evil}/prefetch"><link rel="stylesheet" href="${evil}/css">
<style>#m{background:url(${evil}/cssimg)}</style><img src="${evil}/img">
<script>(function(){var r={};function t(f){try{return f()}catch(e){return 'ERR '+e.name}}
r.parentApi=t(function(){return typeof parent.orchestra});
r.parentDoc=t(function(){return 'readable:'+parent.document.title});
r.ownApi=typeof window.orchestra+'/'+typeof window.require;
r.origin=self.origin; r.cookie=t(function(){return 'readable:'+document.cookie});
fetch('${evil}/fetch').then(function(x){r.fetch='status '+x.status},function(e){r.fetch='ERR '+e.name});
new Image().src='${evil}/img2';
t(function(){var x=new XMLHttpRequest();x.open('GET','${evil}/xhr');x.send()});
t(function(){new WebSocket('ws://127.0.0.1:${port}/ws')});
t(function(){navigator.sendBeacon('${evil}/beacon','x')});
setTimeout(function(){parent.postMessage({__probe:'iso',r:r},'*')},900)})()</script>`;
const navBloc = (evil) => `<meta http-equiv="refresh" content="1;url=${evil}/nav-meta"><a id="lnk" href="${evil}/nav-link" target="_top">x</a><div style="height:30px">navigation probe</div>
<script>setTimeout(function(){try{location.href='${evil}/nav-js'}catch(e){}},300);
setTimeout(function(){try{window.open('${evil}/popup')}catch(e){}},300);
setTimeout(function(){try{top.location='${evil}/nav-top'}catch(e){}},300);
setTimeout(function(){document.getElementById('lnk').click()},400);
setTimeout(function(){parent.postMessage({__probe:'nav',r:{done:1}},'*')},1000)</script>`;
const LOOP_BLOC = `<div style="height:30px">loop probe</div><script>parent.postMessage({__probe:'loop',r:{started:1}},'*');setTimeout(function(){for(;;){}},600)</script>`;

const results = []; // {arm, clause, ok, detail}
const shots = [];
function clause(arm, name, ok, detail) { results.push({ arm, clause: name, ok: !!ok, detail }); console.log(`  ${ok ? 'PASS' : 'FAIL'}  [${arm}] ${name} — ${detail}`); }
function saveShot(name, buf) { fs.mkdirSync(OUT, { recursive: true }); const f = path.join(OUT, name); fs.writeFileSync(f, buf); shots.push({ file: f, md5: md5(buf) }); return f; }

// ── the mutants: ONE string in a disposable COPY of the built app ─────────────────────────────────
const MUTANTS = {
  policy: { clause: 'I1', dir: 'dist/assets', from: '<meta http-equiv="Content-Security-Policy" content="', to: '<meta http-equiv="X-Bloc-Mutant-No-Policy" content="' },
  nav: { clause: 'I2', dir: 'dist-electron', from: '"will-frame-navigate"', to: '"will-frame-navigatX"' },
  'sandbox-api': { clause: 'I3', dir: 'dist/assets', from: 'sandbox:"allow-scripts"', to: '"data-x":"allow-scripts"' },
  'sandbox-loop': { clause: 'I4', dir: 'dist/assets', from: 'sandbox:"allow-scripts"', to: '"data-x":"allow-scripts"' },
};
function makeMutantCopy(armDir, m) {
  const copy = path.join(armDir, 'app'); fs.mkdirSync(copy, { recursive: true });
  for (const d of ['dist', 'dist-electron']) fs.cpSync(path.join(APP_DIR, d), path.join(copy, d), { recursive: true });
  fs.copyFileSync(path.join(APP_DIR, 'package.json'), path.join(copy, 'package.json'));
  fs.symlinkSync(path.join(APP_DIR, 'node_modules'), path.join(copy, 'node_modules'));
  for (const extra of ['build']) if (fs.existsSync(path.join(APP_DIR, extra))) fs.symlinkSync(path.join(APP_DIR, extra), path.join(copy, extra));
  const files = walk(path.join(copy, m.dir)).filter((f) => f.endsWith('.js'));
  const hit = files.map((f) => ({ f, n: fs.readFileSync(f, 'utf8').split(m.from).length - 1 })).filter((x) => x.n > 0);
  if (hit.length !== 1 || hit[0].n !== 1) throw new Error(`mutation string ${JSON.stringify(m.from)} found ${JSON.stringify(hit)} — must be exactly 1 occurrence in 1 file`);
  const before = fs.readFileSync(hit[0].f, 'utf8');
  fs.writeFileSync(hit[0].f, before.replace(m.from, m.to));
  const after = fs.readFileSync(hit[0].f, 'utf8');
  return { copy, file: path.relative(copy, hit[0].f), beforeMd5: md5(before), afterMd5: md5(after), changed: before !== after && after.split(m.to).length - 1 === 1 };
}

// ── one arm ───────────────────────────────────────────────────────────────────────────────────────
async function runArm(arm, evil) {
  const w = 1400, h = 2200;
  console.log(`\n== arm ${arm}: output ${w}x${h} ==`);
  const armDir = path.join(RIG_DIR, `arm-${arm}`);
  fs.mkdirSync(armDir, { recursive: true });
  const E = `http://127.0.0.1:${evil.port}`;
  evil.reset();
  let appDir = APP_DIR, mutProof = null;
  const mut = MUTANTS[arm];
  const origHash = treeHash([path.join(APP_DIR, 'dist'), path.join(APP_DIR, 'dist-electron')]);
  if (mut) { mutProof = makeMutantCopy(armDir, mut); appDir = mutProof.copy; }
  const world = seedWorld(path.join(armDir, 'world'));
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
  const app = spawn(path.join(APP_DIR, 'node_modules/electron/dist/electron'), [appDir, '--ozone-platform=wayland'], { cwd: appDir, env, stdio: ['ignore', fd, fd], detached: true });
  console.log(`  app pid ${app.pid} port ${port} log ${logFile}`);
  let cdp;
  const inject = async (evs) => { for (const e of [].concat(evs)) await cdp.eval(`window.__injectAgentEvent(${JSON.stringify(WS)}, ${JSON.stringify(e)}); 1`); };
  const probe = (name) => cdp.eval(`window.__probes[${JSON.stringify(name)}] || null`);
  const frames = () => cdp.eval(`[...document.querySelectorAll('iframe.av-bloc-frame')].map((f) => { const b = f.getBoundingClientRect(); return { title: f.title, sandbox: f.getAttribute('sandbox'), h: Math.round(b.height), left: b.left, top: b.top, width: b.width }; })`);
  const hitsOf = (re) => evil.hits.filter((u) => re.test(u));
  try {
    const target = await waitFor(async () => { const r = await fetch(`http://127.0.0.1:${port}/json`); const t = (await r.json()).find((x) => x.type === 'page' && x.url.includes('dist/index.html')); return t || null; }, 60000, 'the app page target');
    clause(arm, 'ctl/app-identity-path', target.url.includes(appDir) && !target.url.includes('app.asar'), `target url ${target.url} ⊇ ${appDir}`);
    cdp = await Cdp.connect(target.webSocketDebuggerUrl);
    await cdp.send('Page.enable');
    await waitFor(() => cdp.eval(`!!window.__orchestraSetState && !!window.__injectAgentEvent && !!document.querySelector(".toolbar")`), 60000, 'the toolbar + the test seams');
    const environ = fs.readFileSync(`/proc/${app.pid}/environ`, 'utf8').split('\0');
    const ev = (k) => (environ.find((e) => e.startsWith(k + '=')) || '').slice(k.length + 1);
    clause(arm, 'ctl/scratch-env', ev('ORCHESTRA_HOME') === world.ohome && ev('CLAUDE_CONFIG_DIR') === world.cfg && ev('HOME') === world.fakeHome && !environ.some((e) => e.startsWith('DISPLAY=')) && ev('WAYLAND_DISPLAY') === RIG_WAYLAND,
      `app environ: ORCHESTRA_HOME=${ev('ORCHESTRA_HOME')} CLAUDE_CONFIG_DIR=${ev('CLAUDE_CONFIG_DIR')} WAYLAND_DISPLAY=${ev('WAYLAND_DISPLAY')} DISPLAY=${ev('DISPLAY') || '<unset>'}`);
    clause(arm, 'ctl/app-in-my-sway', new RegExp(`"pid":\\s*${app.pid}\\b`).test(sh('swaymsg', ['-t', 'get_tree'])), `app pid ${app.pid} present in my sway's get_tree`);
    // identity: the renderer bundle the page runs is byte-identical to the one in the app dir we named (a mutant's COPY carries its mutation)
    const bundle = (await cdp.eval(`[...document.querySelectorAll('script[src]')].map((s) => s.src)`)).find((s) => /assets\/index-.*\.js/.test(s));
    const onDisk = path.join(appDir, 'dist', bundle.split('/dist/')[1]);
    const frameId = (await cdp.send('Page.getResourceTree')).frameTree.frame.id;
    const rc_ = await cdp.send('Page.getResourceContent', { frameId, url: bundle });
    const served = Buffer.from(rc_.content, rc_.base64Encoded ? 'base64' : 'utf8');
    clause(arm, 'ctl/app-identity-bundle', md5(served) === md5(fs.readFileSync(onDisk)), `renderer bundle ${path.basename(bundle)} as served md5 ${md5(served)} == the file in ${appDir}/dist (${md5(fs.readFileSync(onDisk))})`);
    if (mut) clause(arm, 'ctl/mutation-applied', mutProof.changed && mutProof.beforeMd5 !== mutProof.afterMd5, `${JSON.stringify(mut.from)} -> ${JSON.stringify(mut.to)} exactly once in ${mutProof.file} (md5 ${mutProof.beforeMd5} -> ${mutProof.afterMd5}), applied to a disposable COPY`);

    // the page's seams: what a bloc says (probes) + a switch that drops height reports (the failure-fallback arm)
    await cdp.eval(`window.__probes = {}; window.__dropHeights = false;
      window.addEventListener('message', (e) => { const d = e.data; if (d && d.__probe) window.__probes[d.__probe] = d.r; if (window.__dropHeights && d && d.__blocHtml) e.stopImmediatePropagation(); }); 1`);
    await cdp.eval(`window.__orchestraSetState(${JSON.stringify({ activeId: WS, view: 'structured' })}); 1`);
    await sleep(500);
    const settle = async (ms = 700) => { await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: h - 5 }); await sleep(ms); await cdp.eval(`document.fonts.ready.then(() => true)`); };

    // ── PHASE G3 (the real build only): what a human sees ──
    if (arm === 'real') {
      await inject(evText('PROSE-BEFORE-1\n' + fence('html-render title="Comparatif"', THEME_BLOC) + '\nPROSE-AFTER-1'));
      await waitFor(async () => (await frames()).some((f) => f.title === 'Comparatif') && (await probe('theme')), 30000, 'the themed bloc to render and report');
      await waitFor(async () => (await frames()).find((f) => f.title === 'Comparatif').h >= 195, 10000, 'the frame to take its content height');
      await settle(1200);
      const th = await probe('theme');
      const info = await cdp.eval(`(() => {
        const f = document.querySelector('iframe.av-bloc-frame[title="Comparatif"]'); f.scrollIntoView({ block: 'center' });
        const md = f.closest('.av-md'); const seq = [...md.children].map((c) => c.className || c.tagName);
        const view = document.querySelector('.av-view.active') || document.querySelector('.av-view');
        const col = (css) => { const s = document.createElement('span'); s.style.color = css; view.appendChild(s); const c = getComputedStyle(s).color; s.remove(); return c; };
        const mdEl = document.querySelector('.av-md'); const b = f.getBoundingClientRect();
        return { seq, accent: col('var(--av-assistant)'), fg: col('var(--av-text)'), fs: getComputedStyle(mdEl).fontSize, rect: { left: b.left, top: b.top, width: b.width, height: b.height }, title: f.title, sandbox: f.getAttribute('sandbox'), bodyText: md.textContent };
      })()`);
      clause(arm, 'P1/bloc-sits-between-its-prose', info.seq.length === 3 && info.seq[0] === 'av-md-p' && info.seq[1] === 'av-bloc' && info.seq[2] === 'av-md-p' && info.bodyText.includes('PROSE-BEFORE-1') && info.bodyText.includes('PROSE-AFTER-1'), `children of the reply's .av-md: ${JSON.stringify(info.seq)}`);
      clause(arm, 'P2/themed-with-app-tokens', th && th.accent === info.accent && th.fg === info.fg && th.fs === info.fs, `frame: accent ${th?.accent} fg ${th?.fg} font ${th?.fs} · app: accent ${info.accent} fg ${info.fg} font ${info.fs}`);
      clause(arm, 'P3/sized-to-content-and-titled', Math.abs(info.rect.height - 200) <= 2 && info.title === 'Comparatif' && info.sandbox === 'allow-scripts', `iframe height ${info.rect.height}px (content 200px) · title "${info.title}" · sandbox="${info.sandbox}"`);
      const full = await cdp.shot();
      saveShot('real-bloc-rendered-renderer.png', full);
      const I = decodePng(full);
      const R = info.rect, accent = rgbOf(info.accent);
      const card = px(I, R.left + R.width * 0.25, R.top + 100), empty = px(I, R.left + R.width * 0.9, R.top + 100), above = px(I, R.left + R.width * 0.9, R.top - 3);
      clause(arm, 'P4/pixels-accent-card-on-transparent-frame', near(card, accent, 4) && near(empty, above, 4), `screenshot: card centre rgb(${card}) vs app accent rgb(${accent}); empty frame area rgb(${empty}) vs the surface just above the frame rgb(${above}) (opaque frame = they differ)`);

      // open fence → placeholder with the title, no frame; renders ONCE when the fence closes
      const before = (await frames()).length;
      const open = evOpen('STREAM-MARK\n```html-render title="En cours"\n<div style="height:50px">partial');
      await inject(open.events);
      await waitFor(() => cdp.eval(`!!document.querySelector('.av-bloc-pending')`), 20000, 'the placeholder');
      await settle(600);
      const pend = await cdp.eval(`({ text: document.querySelector('.av-bloc-pending').textContent, frames: document.querySelectorAll('iframe.av-bloc-frame').length })`);
      saveShot('real-bloc-pending-renderer.png', await cdp.shot());
      await inject(evMore(open.index, '</div>\n```\nSTREAM-END', true));
      await waitFor(async () => (await frames()).some((f) => f.title === 'En cours'), 20000, 'the bloc to render on close');
      const after = await cdp.eval(`({ pending: document.querySelectorAll('.av-bloc-pending').length, frames: document.querySelectorAll('iframe.av-bloc-frame').length })`);
      clause(arm, 'P5/open-fence-is-a-placeholder-then-renders-once-on-close', pend.text.includes('En cours') && pend.frames === before && after.pending === 0 && after.frames === before + 1, `while open: placeholder "${pend.text}", frames ${before} -> ${pend.frames}; after close: placeholders ${after.pending}, frames ${after.frames}`);

      // everything that must stay CODE
      const f0 = (await frames()).length;
      await inject(evText('HTMLFENCE-MARK\n' + fence('html', '<p>HTMLCODE-MARK</p>')));
      await inject(evText('QUOTED-MARK\n' + '````md\n' + fence('html-render title="Quoted"', '<p>QUOTED-MARK</p>') + '\n````'));
      await inject(evUser('USERFENCE-MARK\n' + fence('html-render title="User"', '<p>USERCODE-MARK</p>')));
      await inject(evTool('tu-fence', 'Bash', { command: 'cat page.txt', description: 'show the page' }, 'TOOLFENCE-MARK\n' + fence('html-render title="Tool"', '<p>TOOLCODE-MARK</p>')));
      await inject(evText('OVERCAP-MARK\n' + fence('html-render title="Big"', '<!-- ' + 'x'.repeat(300 * 1024) + ' -->')));
      // the typewriter drains a 300 KiB reply gradually: wait for the refused fence's code block itself
      await waitFor(() => cdp.eval(`(() => { const m = [...document.querySelectorAll('.av-message')].find((e) => e.textContent.includes('OVERCAP-MARK')); return !!m && !!m.querySelector('.av-code-lang'); })()`), 120000, 'the code-block cases to render');
      await settle(800);
      const code = await cdp.eval(`(() => {
        const mark = (m) => [...document.querySelectorAll('.av-message')].find((e) => e.textContent.includes(m));
        const lang = (el) => el ? [...el.querySelectorAll('.av-code-lang')].map((x) => x.textContent) : null;
        return { html: lang(mark('HTMLFENCE-MARK')), htmlText: mark('HTMLFENCE-MARK')?.textContent.includes('HTMLCODE-MARK'), quoted: lang(mark('QUOTED-MARK')), quotedText: mark('QUOTED-MARK')?.textContent.includes('QUOTED-MARK'),
          user: lang(mark('USERFENCE-MARK')), userText: mark('USERFENCE-MARK')?.textContent.includes('USERCODE-MARK'), over: lang(mark('OVERCAP-MARK')), overFrames: mark('OVERCAP-MARK')?.querySelectorAll('iframe').length,
          frames: document.querySelectorAll('iframe.av-bloc-frame').length };
      })()`);
      clause(arm, 'P6/html-fence-quoted-fence-user-message-stay-code', code.html?.[0] === 'html' && code.htmlText && code.quoted?.length >= 1 && code.quotedText && code.user?.[0] === 'html-render' && code.userText && code.frames === f0, `html fence → code ${JSON.stringify(code.html)}; quoted html-render → code ${JSON.stringify(code.quoted)}; user message fence → code ${JSON.stringify(code.user)}; frames ${f0} -> ${code.frames} (must not grow)`);
      clause(arm, 'P7/over-cap-bloc-is-a-code-block', code.over?.[0] === 'html-render' && code.overFrames === 0, `300 KiB html-render fence → code ${JSON.stringify(code.over)}, iframes in that reply ${code.overFrames}`);
      // the tool card: open it by a TRUSTED click and read its output
      const head = await cdp.eval(`(() => { const l = document.querySelector('.av-tool-line[data-tool-id="tu-fence"] .av-tool-line-head'); if (!l) return null; l.scrollIntoView({ block: 'center' }); const b = l.getBoundingClientRect(); return { x: b.left + Math.min(b.width / 2, 120), y: b.top + b.height / 2 }; })()`);
      if (head) { await cdp.click(head.x, head.y); await sleep(600); }
      const tool = await cdp.eval(`(() => { const c = document.querySelector('.av-tool-line[data-tool-id="tu-fence"] .av-tool-card'); return { card: !!c, text: c ? c.textContent : '', frames: document.querySelectorAll('iframe.av-bloc-frame').length }; })()`);
      clause(arm, 'P8/tool-output-fence-stays-code', !!head && tool.card && tool.text.includes('TOOLFENCE-MARK') && tool.text.includes('TOOLCODE-MARK') && tool.frames === f0, `tool card opened=${tool.card}, shows the fence text=${tool.text.includes('TOOLCODE-MARK')}, frames ${tool.frames} (was ${f0})`);
      // the sub-agent card (a task notice's result) stays code
      await inject(evUser('<task-notification><task-id>t1</task-id><status>completed</status><summary>Agent "bh415" completed</summary><result>' + 'TASKFENCE-MARK\n' + fence('html-render title="Task"', '<p>TASKCODE-MARK</p>') + '</result></task-notification>', { origin: 'task notification' }));
      await waitFor(() => cdp.eval(`!!document.querySelector('.av-tnotice-header')`), 20000, 'the task notice row');
      const th2 = await cdp.eval(`(() => { const b = document.querySelector('.av-tnotice-header'); b.scrollIntoView({ block: 'center' }); const r = b.getBoundingClientRect(); return { x: r.left + 40, y: r.top + r.height / 2 }; })()`);
      await cdp.click(th2.x, th2.y); await sleep(600);
      const task = await cdp.eval(`(() => { const r = document.querySelector('.av-tnotice-result'); return { shown: !!r, text: r ? r.textContent : '', langs: r ? [...r.querySelectorAll('.av-code-lang')].map((x) => x.textContent) : [], frames: document.querySelectorAll('iframe.av-bloc-frame').length }; })()`);
      clause(arm, 'P9/sub-agent-card-fence-stays-code', task.shown && task.text.includes('TASKCODE-MARK') && task.langs[0] === 'html-render' && task.frames === f0, `task-notice result shown=${task.shown}, code ${JSON.stringify(task.langs)}, frames ${task.frames} (was ${f0})`);
      // failure ⇒ code: the frame never reports a height (the page drops the reports) → the source falls back to a code block
      await cdp.eval(`window.__dropHeights = true; 1`);
      await inject(evText('FAILMARK\n' + fence('html-render title="Fails"', '<p id="f">FAILCODE-MARK</p>')));
      await waitFor(() => cdp.eval(`!!document.body.innerText.includes('FAILMARK')`), 20000, 'the failing bloc row');
      await sleep(8000);
      await cdp.eval(`window.__dropHeights = false; 1`);
      const fail = await cdp.eval(`(() => { const m = [...document.querySelectorAll('.av-message')].find((e) => e.textContent.includes('FAILMARK')); return { langs: [...m.querySelectorAll('.av-code-lang')].map((x) => x.textContent), code: m.textContent.includes('FAILCODE-MARK'), frames: m.querySelectorAll('iframe').length }; })()`);
      clause(arm, 'P10/failed-render-falls-back-to-code', fail.langs[0] === 'html' && fail.code && fail.frames === 0, `no height report in 6 s → code ${JSON.stringify(fail.langs)} with the source=${fail.code}, iframes ${fail.frames}`);
    } else {
      // a mutant arm's control: a bloc renders and reports its height (so a RED isolation clause is not "nothing rendered")
      await inject(evText('CTL-MARK\n' + fence('html-render title="Contrôle"', '<div style="height:90px">control</div>')));
      await waitFor(async () => (await frames()).some((f) => f.title === 'Contrôle' && f.h >= 88), 30000, 'the control bloc to render at its content height');
      const fr = (await frames()).find((f) => f.title === 'Contrôle');
      clause(arm, 'ctl/bloc-renders-and-reports-height', !!fr && Math.abs(fr.h - 90) <= 2, `control bloc: iframe height ${fr?.h}px (content 90px), sandbox=${JSON.stringify(fr?.sandbox)}`);
    }

    // ── PHASE ISO: what a bloc can reach ──
    const I = {};
    if (arm !== 'sandbox-loop') {
      evil.reset();
      await inject(evText('ISO-MARK\n' + fence('html-render title="Isolation"', isoBloc(E, evil.port))));
      const r = await waitFor(() => probe('iso'), 30000, 'the isolation probe report');
      await sleep(2500);
      const net = evil.hits.filter((u) => !/^\/nav/.test(u) && !/^\/popup/.test(u));
      I.I1 = { ok: net.length === 0, detail: `listener ${E} saw ${net.length} request(s) from the frame's fetch/xhr/img/css/prefetch/beacon/websocket: ${JSON.stringify(net)}; frame says fetch=${r.fetch}` };
      clause(arm, 'X1/preconnect-opens-no-connection', evil.conns() === 0, `raw TCP connections to the listener after <link rel=preconnect>: ${evil.conns()} (requests ${evil.hits.length})`);
      I.I3 = { ok: /^ERR/.test(r.parentApi) && /^ERR/.test(r.parentDoc) && r.ownApi === 'undefined/undefined' && r.origin === 'null' && /^ERR/.test(r.cookie), detail: `from inside the frame: typeof parent.orchestra = ${r.parentApi}; parent.document = ${r.parentDoc}; own orchestra/require = ${r.ownApi}; origin = ${r.origin}; cookie = ${r.cookie}` };
      evil.reset();
      await inject(evText('NAV-MARK\n' + fence('html-render title="Navigation"', navBloc(E))));
      await sleep(4500); // no probe report: a frame that navigates away takes its script with it
      const navHits = evil.hits.filter((u) => /^\/(nav|popup)/.test(u));
      const appLog = fs.readFileSync(logFile, 'utf8') + (fs.existsSync(path.join(world.ohome, 'logs', 'orchestra.log')) ? fs.readFileSync(path.join(world.ohome, 'logs', 'orchestra.log'), 'utf8') : '');
      const opened = appLog.split('\n').filter((l) => l.includes('[open-url]') && l.includes(`127.0.0.1:${evil.port}`));
      const refused = appLog.split('\n').filter((l) => l.includes('bloc-html: refused a frame navigation')).length;
      I.I2 = { ok: navHits.length === 0 && opened.length === 0, detail: `listener saw ${navHits.length} navigation request(s) (location.href / meta refresh / link click / window.open / top.location): ${JSON.stringify(navHits)}; app asked the OS to open the listener's URL ${opened.length}x; guard refusals logged ${refused}` };
      const fr = (await frames()).find((f) => f.title === 'Navigation');
      I.I2.detail += `; frame still in the page: ${!!fr}`;
    }
    if (arm === 'real') {
      // plan-review card (modal): its fence stays code — BEFORE the loop, which must leave the window answering
      const nF = (await frames()).length;
      await inject({ type: 'permission-request', seq: SEQ++, at: at(), requestId: 'rq-plan', toolUseId: null, name: 'ExitPlanMode', input: { plan: 'PLANFENCE-MARK\n' + fence('html-render title="Plan"', '<p>PLANCODE-MARK</p>') } });
      await waitFor(() => cdp.eval(`!!document.querySelector('.av-plan-body')`), 20000, 'the plan-review card');
      await sleep(600);
      const plan = await cdp.eval(`(() => { const b = document.querySelector('.av-plan-body'); return { text: b.textContent, langs: [...b.querySelectorAll('.av-code-lang')].map((x) => x.textContent), frames: b.querySelectorAll('iframe').length, all: document.querySelectorAll('iframe.av-bloc-frame').length }; })()`);
      clause(arm, 'P11/plan-review-card-fence-stays-code', plan.text.includes('PLANCODE-MARK') && plan.langs[0] === 'html-render' && plan.frames === 0 && plan.all === nF, `plan card shows the fence as code ${JSON.stringify(plan.langs)}, iframes in the card ${plan.frames}, in the page ${plan.all} (was ${nF})`);
      saveShot('real-plan-review-renderer.png', await cdp.shot());
    }
    if (arm === 'real' || arm === 'sandbox-loop') {
      // the loop runs in its OWN bloc, last: a same-origin frame freezes the whole window (the control must see that)
      await inject(evText('LOOP-MARK\n' + fence('html-render title="Boucle"', LOOP_BLOC)));
      await waitFor(() => probe('loop'), 30000, 'the loop bloc to start').catch(() => null);
      await sleep(2000);
      const t0 = Date.now();
      const ans = await Promise.race([cdp.eval('1 + 1', 4000).then((v) => ({ v }), (e) => ({ err: String(e).slice(0, 80) })), sleep(5000).then(() => ({ timeout: true }))]);
      I.I4 = { ok: ans.v === 2, detail: `an evaluation in the app window, 2 s into the frame's infinite loop: ${JSON.stringify(ans)} after ${Date.now() - t0} ms` };
    }

    // ── verdicts of the isolation clauses ──
    const names = { I1: 'I1/frame-without-policy-reaches-a-local-listener', I2: 'I2/navigation-guard-removed-reaches-the-listener', I3: 'I3/same-origin-frame-reads-the-api-object', I4: 'I4/same-origin-looping-frame-freezes-the-window' };
    const named = { I1: 'policy blocks every network path', I2: 'a frame navigation goes nowhere', I3: 'parent + app API unreachable from the frame', I4: 'a looping frame leaves the window responsive' };
    for (const k of Object.keys(I)) clause(arm, `${k}/${named[k]}`, I[k].ok, `${names[k].split('/')[1]} :: ${I[k].detail}`);
    fs.writeFileSync(path.join(OUT, `${arm}-hits.json`), JSON.stringify({ hits: evil.hits, conns: evil.conns(), I }, null, 2));
    if (arm !== 'sandbox-loop') {
      const f = await cdp.eval(`1 + 1`, 4000).catch(() => null);
      if (arm !== 'sandbox-loop' && f === 2) saveShot(`${arm}-after-probes-renderer.png`, await cdp.shot());
    }
    const unchanged = treeHash([path.join(APP_DIR, 'dist'), path.join(APP_DIR, 'dist-electron')]) === origHash;
    clause(arm, 'ctl/built-app-dir-untouched', unchanged, `md5 over ${APP_DIR}/{dist,dist-electron} identical before/after the arm`);
  } catch (e) {
    clause(arm, 'rig/arm-completed', false, `ARM ABORTED: ${e.stack || e}`);
  } finally {
    cdp?.close();
    try { process.kill(-app.pid, 'SIGTERM'); } catch {}
    await sleep(2000);
    try { process.kill(-app.pid, 'SIGKILL'); } catch {}
    for (const p of listProcsByHome(world.ohome)) { try { process.kill(p, 'SIGKILL'); } catch {} }
    await sleep(500);
    const left = listProcsByHome(world.ohome);
    clause(arm, 'rig/teardown-no-survivors', left.length === 0, `processes still carrying ${world.ohome}: ${left.length ? left.join(',') : 'none'}`);
  }
}
function listProcsByHome(home) {
  const out = [];
  for (const p of fs.readdirSync('/proc').filter((n) => /^\d+$/.test(n))) {
    try { const env = fs.readFileSync(`/proc/${p}/environ`, 'utf8').split('\0'); if (env.includes(`ORCHESTRA_HOME=${home}`)) out.push(+p); } catch {}
  }
  return out.filter((p) => p !== process.pid);
}
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
fs.mkdirSync(OUT, { recursive: true });
const before = liveCanary();
const evil = await startEvil();
console.log(`[rig] app ${APP_DIR} arms ${ARMS.join(',')} listener 127.0.0.1:${evil.port} out=${OUT}`);
for (const arm of ARMS) { if (arm !== 'real' && !MUTANTS[arm]) refuse(`unknown arm ${arm}`); await runArm(arm, evil); }
evil.srv.close();
const after = liveCanary();
const same = JSON.stringify(before) === JSON.stringify(after);
clause('rig', 'ctl/live-claude-dirs-untouched', same, `${Object.keys(before).length} live ~/.claude* dirs, symlink-set + mcpServers hashes ${same ? 'identical before/after' : 'CHANGED: ' + JSON.stringify({ before, after })}`);

// ── verdict ───────────────────────────────────────────────────────────────────────────────────────
const isI = (c) => /^I\d\//.test(c.clause);
const isCtl = (c) => /^(ctl|rig)\//.test(c.clause);
const lines = [];
let rc = 0;
for (const arm of ARMS) {
  const mine = results.filter((c) => c.arm === arm);
  const ctlRed = mine.filter((c) => isCtl(c) && !c.ok).map((c) => c.clause);
  if (arm === 'real') {
    const red = mine.filter((c) => !c.ok && !c.clause.startsWith('X')).map((c) => c.clause);
    const x = mine.filter((c) => c.clause.startsWith('X') && !c.ok).map((c) => c.clause);
    lines.push(`real: ${red.length === 0 ? 'ALL GREEN' : 'RED ' + red.join(', ')} (${mine.length} clauses)${x.length ? `; MEASURED LEAK ${x.join(', ')}` : ''}`);
    if (red.length) rc = 1;
  } else {
    const want = MUTANTS[arm].clause;
    const named = mine.find((c) => c.clause.startsWith(want + '/'));
    // removing the sandbox also re-enables popups and top navigation (that is part of its job), so I2 may follow it
    const allowed = arm === 'sandbox-api' ? ['I2'] : [];
    const others = mine.filter((c) => isI(c) && !c.clause.startsWith(want + '/') && !allowed.some((a) => c.clause.startsWith(a + '/')) && !c.ok).map((c) => c.clause);
    const ok = !!named && !named.ok && ctlRed.length === 0 && others.length === 0;
    lines.push(`${arm}: ${ok ? 'MUST-FAIL CONFIRMED' : 'NOT CONFIRMED'} — ${want} ${named ? (named.ok ? 'stayed GREEN' : 'RED') : 'not evaluated'}; other I-clauses red: ${others.join(',') || 'none'}; controls red: ${ctlRed.join(',') || 'none'}`);
    if (!ok) rc = 1;
  }
}
const rigRed = results.filter((c) => c.arm === 'rig' && !c.ok);
if (rigRed.length) rc = 1;
console.log('\n== shots (md5) ==');
for (const s of shots) console.log(`  ${s.md5}  ${s.file}`);
const dup = shots.length - new Set(shots.map((s) => s.md5)).size;
console.log(`  duplicates among captures: ${dup}`);
fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify({ app: APP_DIR, arms: ARMS, results, shots }, null, 2));
console.log('\n== verdict ==');
for (const l of lines) console.log('  ' + l);
console.log(`\nVERDICT: ${rc === 0 ? 'OK' : 'RED'} (${results.filter((c) => c.ok).length}/${results.length} clauses green; ${rigRed.length} rig-level red)`);
process.exit(rc);
