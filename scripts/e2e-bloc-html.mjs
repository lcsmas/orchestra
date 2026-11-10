// #415/D5 — Bloc HTML rig (ADR 0011). Boots a BUILT Orchestra (argv[2] = app dir) in the contained rig's own headless sway with a SCRATCH
// ORCHESTRA_HOME / HOME / CLAUDE_CONFIG_DIR and a stub `claude`, replays a conversation through the app's own event path (`__injectAgentEvent`), and
// measures what a Bloc HTML can reach — a local https listener (rig-only trust: the app is launched with an SPKI pin for ITS test cert, nothing else) and a
// local http listener play "the network", the page's `message` seam plays "what the bloc says".
//
// Arms (each = one app boot):
//   real            the build as is — every clause GREEN (P* = what a human sees, N* = what a bloc may/may not fetch, I* = what it cannot reach)
//   policy          a COPY whose frame document lost its policy <meta>        → N2 must go RED (an http: request from the frame reaches the http listener)
//   policy-http     a COPY whose policy also allows http:/ws:                 → N2 must go RED (same clause, loosened instead of removed)
//   policy-nohttps  a COPY whose policy lost https:/wss:                      → N1 must go RED (the https requests no longer succeed)
//   nav             a COPY whose main-process navigation guard never fires    → I2 must go RED (a frame navigation reaches the listener)
//   nav-key       a COPY whose guard keys a bloc on `event.frame` (throws from a frame's 2nd attempt) instead of `event.initiator` → C10 must go RED (one looping bloc silences another) (#416)
//   nav-shim      a COPY whose frame lost the in-frame navigation shim        → C8 must go RED (a target=_blank click is dropped by the sandbox, no confirmation) (#416)
//   nav-bypass    a COPY whose navigation guard opens the URL instead of asking  → C1 must go RED (the URL reaches the listener with no confirmation) (#416)
//   sandbox-api     a COPY whose frame lost its `sandbox` attribute (same-origin) → I3 must go RED (the frame reads the app's API object)
//   sandbox-loop    the same copy, a looping bloc                             → I4 must go RED (the window freezes)
// A mutant arm passes only if its named clause is RED, every control GREEN, and its OTHER evaluated N/I-clauses GREEN (it removes ONE guard).
// The mutation is applied to a disposable COPY (counted == 1 per string); the built app dir is md5-compared before/after.
import { execFileSync, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import path from 'node:path';
import zlib from 'node:zlib';

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const APP_DIR = argv[0] && !argv[0].startsWith('--') ? fs.realpathSync(argv[0]) : null;
const LIVE_HOME = flag('--live-home', null);
const ARMS = (flag('--arms', 'real,policy,policy-http,policy-nohttps,nav,nav-bypass,nav-shim,nav-key,sandbox-api,sandbox-loop')).split(',');
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

// ── the "network": a local http listener (must see NOTHING from a frame) and a local https listener (must see everything a bloc may fetch) ──
const FIX = path.join(path.dirname(new URL(import.meta.url).pathname), 'fixtures');
const TLS = { key: fs.readFileSync(path.join(FIX, 'bloc-html-rig.key.pem')), cert: fs.readFileSync(path.join(FIX, 'bloc-html-rig.cert.pem')) };
const SPKI_PIN = crypto.createHash('sha256').update(new crypto.X509Certificate(TLS.cert).publicKey.export({ type: 'spki', format: 'der' })).digest('base64');
function solidPng(w, h, [r, g, b]) {
  const crcT = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (buf) => { let c = 0xffffffff; for (const x of buf) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (t, d) => { const o = Buffer.alloc(12 + d.length); o.writeUInt32BE(d.length, 0); o.write(t, 4, 'latin1'); d.copy(o, 8); o.writeUInt32BE(crc(o.subarray(4, 8 + d.length)), 8 + d.length); return o; };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.alloc((w * 3 + 1) * h); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const o = y * (w * 3 + 1) + 1 + x * 3; raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const ASSET_RGB = [200, 40, 120], ASSET_PNG = solidPng(160, 80, ASSET_RGB);
const FONT_BYTES = fs.readFileSync(path.join(path.dirname(FIX), '..', 'src/renderer/assets/fonts/orchestra-symbols.woff2')); // a real font: a valid face only loads if its fetch succeeded
const handler = (hits) => (req, res) => {
  hits.push(req.url);
  const cors = { 'access-control-allow-origin': '*' };
  if (/^\/(asset|prose)\.png/.test(req.url)) { res.writeHead(200, { 'content-type': 'image/png', ...cors }); return res.end(ASSET_PNG); }
  if (/^\/font\.woff2/.test(req.url)) { res.writeHead(200, { 'content-type': 'font/woff2', ...cors }); return res.end(FONT_BYTES); }
  if (/^\/lib\.js/.test(req.url)) { res.writeHead(200, { 'content-type': 'text/javascript', ...cors }); return res.end('window.__libLoaded = 42;'); }
  if (/^\/css/.test(req.url)) { res.writeHead(200, { 'content-type': 'text/css', ...cors }); return res.end('#ncss{background:rgb(1,2,3)}'); }
  res.writeHead(200, { 'content-type': 'text/plain', ...cors }); res.end('listener-ok');
};
function wsAccept(srv, hits) {
  srv.on('upgrade', (req, sock) => { hits.push(`UPGRADE ${req.url}`); const key = req.headers['sec-websocket-key'];
    if (!key) return sock.destroy();
    sock.on('error', () => {});
    sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')}\r\n\r\n`); });
}
async function startNetwork() {
  const mk = async (tls) => {
    const hits = []; const srv = (tls ? https.createServer(TLS, handler(hits)) : http.createServer(handler(hits)));
    wsAccept(srv, hits);
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    return { srv, port: srv.address().port, hits, tls };
  };
  const evil = await mk(false), good = await mk(true);
  // the instrument can say YES: one node-side request per listener, then reset
  await new Promise((res) => http.get(`http://127.0.0.1:${evil.port}/selftest`, (r) => { r.resume(); r.on('end', res); }));
  await new Promise((res) => https.get(`https://127.0.0.1:${good.port}/selftest`, { ca: TLS.cert }, (r) => { r.resume(); r.on('end', res); }));
  const selfTest = { http: evil.hits.length, https: good.hits.length };
  if (selfTest.http !== 1 || selfTest.https !== 1) refuse(`listener self-test failed: ${JSON.stringify(selfTest)}`);
  console.log(`[rig] listener self-test: http saw ${selfTest.http}, https saw ${selfTest.https} (instrument alive); SPKI pin ${SPKI_PIN.slice(0, 12)}…`);
  const reset = () => { evil.hits.length = 0; good.hits.length = 0; };
  reset();
  return { evil, good, reset, close: () => { evil.srv.close(); good.srv.close(); } };
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
  // `shell.openExternal` execs `xdg-open` from PATH: this stub makes the URL it is given reach the local listener, so "opened" is a request the listener SEES (#416).
  fs.writeFileSync(path.join(stubDir, 'xdg-open'), `#!/bin/sh\necho "$1" >> ${JSON.stringify(path.join(stubDir, 'xdg-open.log'))}\nexec curl -s -m 5 -o /dev/null "$1"\n`, { mode: 0o755 });
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
// What a bloc can read of the app (I3) — nothing here touches the network.
const isoBloc = () => `<div id="m" style="height:60px;color:var(--bloc-accent)">isolation probe</div>
<script>(function(){var r={};function t(f){try{return f()}catch(e){return 'ERR '+e.name}}
r.parentApi=t(function(){return typeof parent.orchestra});
r.parentDoc=t(function(){return 'readable:'+parent.document.title});
r.ownApi=typeof window.orchestra+'/'+typeof window.require;
r.origin=self.origin; r.cookie=t(function(){return 'readable:'+document.cookie});
setTimeout(function(){parent.postMessage({__probe:'iso',r:r},'*')},900)})()</script>`;
// The same probes against a base URL: over https every one must SUCCEED (N1), over http every one must be REFUSED (N2). Reports after 2.5 s.
const netBloc = (base, wsBase, tag, visible) => `<div id="ncss" style="height:14px;color:var(--bloc-fg)">network probe ${tag}</div>
<style>@font-face{font-family:rigf;src:url(${base}/font.woff2) format("woff2")}</style><link rel="stylesheet" href="${base}/css"><link rel="preconnect" href="${base}"><link rel="prefetch" href="${base}/prefetch">
<img id="ri" src="${base}/asset.png?static" style="${visible ? 'display:block;width:160px;height:80px' : 'display:none'}">
<script>(function(){var r={};function t(f){try{return f()}catch(e){return 'ERR '+e.name}}
var pend=0;function wait(){pend++;return function(){pend--}}
var d1=wait();fetch('${base}/fetch').then(function(x){return x.text().then(function(b){r.fetch='status '+x.status+' '+b})},function(e){r.fetch='ERR '+e.name}).then(d1);
var d2=wait();t(function(){var x=new XMLHttpRequest();x.open('GET','${base}/xhr');x.onload=function(){r.xhr='status '+x.status;d2()};x.onerror=function(){r.xhr='ERR';d2()};x.send()});
var d3=wait();var i=new Image();i.onload=function(){r.img='loaded '+i.naturalWidth+'x'+i.naturalHeight;d3()};i.onerror=function(){r.img='ERR';d3()};i.src='${base}/asset.png?dyn';
var d4=wait();var sc=document.createElement('script');sc.onload=function(){r.script='ran '+window.__libLoaded;d4()};sc.onerror=function(){r.script='ERR';d4()};sc.src='${base}/lib.js';document.head.appendChild(sc);
var d5=wait();t(function(){var w=new WebSocket('${wsBase}/ws');w.onopen=function(){r.ws='open';w.close();d5()};w.onerror=function(){r.ws='ERR';d5()}});
t(function(){navigator.sendBeacon('${base}/beacon','x')});
var d6=wait();var b=new Blob(['blob-ok']);fetch(URL.createObjectURL(b)).then(function(x){return x.text()}).then(function(x){r.blob=x},function(e){r.blob='ERR '+e.name}).then(d6);
var d8=wait();document.fonts.load('16px rigf','x').then(function(f){r.font=f.length?'loaded':'ERR'},function(){r.font='ERR'}).then(d8);
var d7=wait();var di=new Image();di.onload=function(){r.data='loaded';d7()};di.onerror=function(){r.data='ERR';d7()};di.src='data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
setTimeout(function(){var n=document.getElementById('ncss');r.css=getComputedStyle(n).backgroundColor;var ri=document.getElementById('ri').getBoundingClientRect();r.rect={l:ri.left,t:ri.top,w:ri.width,h:ri.height};r.staticImg=document.getElementById('ri').naturalWidth;
parent.postMessage({__probe:'${tag}',r:r},'*')},2500)})()</script>`;
const navBloc = (evil) => `<meta http-equiv="refresh" content="1;url=${evil}/nav-meta"><a id="lnk" href="${evil}/nav-link" target="_top">x</a><div style="height:30px">navigation probe</div>
<script>setTimeout(function(){try{location.href='${evil}/nav-js'}catch(e){}},300);
setTimeout(function(){try{window.open('${evil}/popup')}catch(e){}},300);
setTimeout(function(){try{top.location='${evil}/nav-top'}catch(e){}},300);
setTimeout(function(){document.getElementById('lnk').click()},400);
setTimeout(function(){parent.postMessage({__probe:'nav',r:{done:1}},'*')},1000)</script>`;
const NAV_PAD = 'p='.concat('0123456789abcdef'.repeat(40)); // a 640-char query: the confirmation must show it WHOLE
const linkBloc = (evil) => `<a id="l" href="${evil}/confirm-link?${NAV_PAD}&end=LINK-END" style="display:block;height:40px;line-height:40px;color:var(--bloc-accent)">go to the report</a><a id="b" target="_blank" href="${evil}/confirm-blank" style="display:block;height:30px">blank target</a><div style="height:20px">link probe</div>`;
// a script-driven navigation, hammered every 40 ms for 1.5 s: ONE confirmation, the first url, the rest coalesced
const jsNavBloc = (evil) => `<div style="height:40px">script probe</div><script>setTimeout(function(){var n=0,t=setInterval(function(){n++;location.href='${evil}/confirm-js?'+(n===1?'first':'again'+n);if(n>=37)clearInterval(t)},40)},300);parent.postMessage({__probe:'navjs',r:{ready:1}},'*')</script>`;
const blankBloc = (evil) => `<a id="b" target="_blank" href="${evil}/shim-blank" style="display:block;height:40px;line-height:40px;color:var(--bloc-accent)">blank target</a><div style="height:20px">popup probe</div>`;
const openBloc = (evil) => `<div style="height:40px">window.open probe</div><script>setTimeout(function(){window.open('${evil}/shim-open')},300)</script>`;
const LOOP_BLOC = `<div style="height:30px">loop probe</div><script>parent.postMessage({__probe:'loop',r:{started:1}},'*');setTimeout(function(){for(;;){}},600)</script>`;

const results = []; // {arm, clause, ok, detail}
const shots = [];
function clause(arm, name, ok, detail) { results.push({ arm, clause: name, ok: !!ok, detail }); console.log(`  ${ok ? 'PASS' : 'FAIL'}  [${arm}] ${name} — ${detail}`); }
function saveShot(name, buf) { fs.mkdirSync(OUT, { recursive: true }); const f = path.join(OUT, name); fs.writeFileSync(f, buf); shots.push({ file: f, md5: md5(buf) }); return f; }

// ── the mutants: ONE string in a disposable COPY of the built app ─────────────────────────────────
// Policy string pieces as they sit in the bundle (esbuild keeps the constant verbatim); each must occur exactly once (makeMutantCopy refuses otherwise).
const POL = { script: "script-src 'unsafe-inline' https: blob:", style: "style-src 'unsafe-inline' https:;", img: 'img-src https: data: blob:', font: 'font-src https: data:', conn: 'connect-src https: wss: data: blob:' };
const swap = (from, to) => ({ dir: 'dist/assets', from, to });
const MUTANTS = {
  policy: { clause: 'N2', dir: 'dist/assets', from: '<meta http-equiv="Content-Security-Policy" content="', to: '<meta http-equiv="X-Bloc-Mutant-No-Policy" content="' },
  'policy-http': { clause: 'N2', ...swap(POL.script, "script-src 'unsafe-inline' http: https: blob:"),
    also: [swap(POL.style, "style-src 'unsafe-inline' http: https:;"), swap(POL.img, 'img-src http: https: data: blob:'), swap(POL.font, 'font-src http: https: data:'), swap(POL.conn, 'connect-src http: ws: https: wss: data: blob:')] },
  'policy-nohttps': { clause: 'N1', ...swap(POL.script, "script-src 'unsafe-inline' blob:"),
    also: [swap(POL.style, "style-src 'unsafe-inline';"), swap(POL.img, 'img-src data: blob:'), swap(POL.font, 'font-src data:'), swap(POL.conn, 'connect-src data: blob:')] },
  nav: { clause: 'I2', dir: 'dist-electron', from: '"will-frame-navigate"', to: '"will-frame-navigatX"' },
  'nav-key': { clause: 'C10', dir: 'dist-electron', from: '.initiator', to: '.initiatorX' },
  'nav-shim': { clause: 'C8', dir: 'dist/assets', from: "closest('a[href]')", to: "closest('a[hrefX]')", also: [{ dir: 'dist/assets', from: 'location.href=String(u)', to: 'location.hrefX=String(u)' }] }, // both shim paths off
  'nav-bypass': { clause: 'C1', dir: 'dist-electron', from: '.showConfirmation(', to: '.open(' },
  'sandbox-api': { clause: 'I3', dir: 'dist/assets', from: 'sandbox:"allow-scripts"', to: '"data-x":"allow-scripts"' },
  'sandbox-loop': { clause: 'I4', dir: 'dist/assets', from: 'sandbox:"allow-scripts"', to: '"data-x":"allow-scripts"' },
};
function makeMutantCopy(armDir, m) {
  const copy = path.join(armDir, 'app'); fs.mkdirSync(copy, { recursive: true });
  for (const d of ['dist', 'dist-electron']) fs.cpSync(path.join(APP_DIR, d), path.join(copy, d), { recursive: true });
  fs.copyFileSync(path.join(APP_DIR, 'package.json'), path.join(copy, 'package.json'));
  fs.symlinkSync(path.join(APP_DIR, 'node_modules'), path.join(copy, 'node_modules'));
  for (const extra of ['build']) if (fs.existsSync(path.join(APP_DIR, extra))) fs.symlinkSync(path.join(APP_DIR, extra), path.join(copy, extra));
  const proofs = [];
  for (const mm of [m, ...(m.also ?? [])]) {
    const files = walk(path.join(copy, mm.dir)).filter((f) => f.endsWith('.js'));
    const hit = files.map((f) => ({ f, n: fs.readFileSync(f, 'utf8').split(mm.from).length - 1 })).filter((x) => x.n > 0);
    if (hit.length !== 1 || hit[0].n !== 1) throw new Error(`mutation string ${JSON.stringify(mm.from)} found ${JSON.stringify(hit)} — must be exactly 1 occurrence in 1 file`);
    const before = fs.readFileSync(hit[0].f, 'utf8');
    fs.writeFileSync(hit[0].f, before.replace(mm.from, mm.to));
    const after = fs.readFileSync(hit[0].f, 'utf8');
    proofs.push({ from: mm.from, to: mm.to, file: path.relative(copy, hit[0].f), beforeMd5: md5(before), afterMd5: md5(after), changed: before !== after && after.split(mm.to).length - 1 === before.split(mm.to).length }); // `to` may already occur once elsewhere (nav-bypass: `.open(`): the count must grow by exactly 1
  }
  return { copy, proofs, changed: proofs.every((x) => x.changed) };
}

// ── one arm ───────────────────────────────────────────────────────────────────────────────────────
async function runArm(arm, lan) {
  const { evil, good } = lan;
  const w = 1400, h = 2200;
  console.log(`\n== arm ${arm}: output ${w}x${h} ==`);
  const armDir = path.join(RIG_DIR, `arm-${arm}`);
  fs.mkdirSync(armDir, { recursive: true });
  const E = `http://127.0.0.1:${evil.port}`, G = `https://127.0.0.1:${good.port}`;
  lan.reset();
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
  const app = spawn(path.join(APP_DIR, 'node_modules/electron/dist/electron'), [appDir, '--ozone-platform=wayland', `--ignore-certificate-errors-spki-list=${SPKI_PIN}`], { cwd: appDir, env, stdio: ['ignore', fd, fd], detached: true });
  console.log(`  app pid ${app.pid} port ${port} log ${logFile}`);
  let cdp;
  const inject = async (evs) => { for (const e of [].concat(evs)) await cdp.eval(`window.__injectAgentEvent(${JSON.stringify(WS)}, ${JSON.stringify(e)}); 1`); };
  const probe = (name) => cdp.eval(`window.__probes[${JSON.stringify(name)}] || null`);
  const frames = () => cdp.eval(`[...document.querySelectorAll('iframe.av-bloc-frame')].map((f) => { const b = f.getBoundingClientRect(); return { title: f.title, sandbox: f.getAttribute('sandbox'), h: Math.round(b.height), left: b.left, top: b.top, width: b.width }; })`);
  const hitsOf = (re) => evil.hits.filter((u) => re.test(u));
  let isoNavHits = []; // the listener's /nav* + /popup requests of the I2 probes (a navigation nobody confirmed)

  const appLog = () => fs.readFileSync(logFile, 'utf8') + (fs.existsSync(path.join(world.ohome, 'logs', 'orchestra.log')) ? fs.readFileSync(path.join(world.ohome, 'logs', 'orchestra.log'), 'utf8') : '');
  const dialogs = () => cdp.eval(`[...document.querySelectorAll('.av-bloc-nav-confirm')].map((d) => ({ url: d.querySelector('[data-testid="bloc-nav-url"]')?.textContent ?? null, cancel: d.querySelector('.av-bloc-nav-cancel') === document.activeElement }))`);
  const key = async (k, code, vk) => { for (const type of ['keyDown', 'keyUp']) await cdp.send('Input.dispatchKeyEvent', { type, key: k, code, windowsVirtualKeyCode: vk }); };
  const clickIn = async (title, dx, dy) => { // a real mouse click inside a bloc frame (user activation + the browser's own hit-test into the frame)
    await cdp.eval(`document.querySelector('iframe.av-bloc-frame[title=${JSON.stringify(title)}]').scrollIntoView({ block: 'center' }); 1`); await sleep(400);
    const f = (await frames()).find((x) => x.title === title); await cdp.click(f.left + dx, f.top + dy); return f;
  };
  const clickButton = async (sel) => { const b = await cdp.eval(`(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`); await cdp.click(b.x, b.y); };
  const lines = (re) => appLog().split('\n').filter((l) => re.test(l));
  // #416 (review MAJOR 1): the silence after a dismissal is per BLOC. Bloc A is dismissed twice (escalating silence), then bloc B — dismissed once, silence expired — must
  // surface on its SECOND attempt. Keyed on `event.frame` (throws from a frame's 2nd attempt ⇒ shared UNKNOWN bucket) B stays silenced ⇒ N10 RED.
  async function keyPhase() {
    for (const [t, path_] of [['CleA', 'key-a'], ['CleB', 'key-b']]) {
      await inject(evText(`${t}-MARK\n` + fence(`html-render title="${t}"`, `<a href="${E}/${path_}" style="display:block;height:40px;line-height:40px;color:var(--bloc-accent)">go ${t}</a>`)));
      await waitFor(async () => (await frames()).some((f) => f.title === t && f.h >= 38), 30000, `the ${t} bloc`);
    }
    const surf = async (title) => { lan.reset(); await clickIn(title, 40, 20); return waitFor(async () => { const x = await dialogs(); return x.length ? x : null; }, 5000, `a confirmation from ${title}`).catch(() => []); };
    const esc = async () => { await key('Escape', 'Escape', 27); await sleep(500); };
    const a1 = await surf('CleA'); await esc();
    await sleep(5500);
    const a2 = await surf('CleA'); await esc();
    const b1 = await surf('CleB'); await esc();
    await sleep(5500);
    const b2 = await surf('CleB');
    const ok = [a1, a2, b1, b2].every((x) => x.length === 1) && b2[0]?.url === `${E}/key-b`;
    clause(arm, 'C10/a-dismissed-bloc-does-not-silence-another-bloc', ok, `A dismissed twice (silence 5 s then 10 s), B dismissed once and its 5 s elapsed: confirmations on A#1 ${a1.length}, A#2 ${a2.length}, B#1 ${b1.length}, B#2 (second attempt of B) ${b2.length} url ${JSON.stringify(b2[0]?.url)} (0 = B was silenced by A's dismissals: shared identity bucket); guard log "→ muted" ${lines(/→ muted/).length}x`);
    if (b2.length) await esc();
  }
  // #416: a model-written <a target=_blank> click / window.open(url) must reach the guard (the sandbox drops them otherwise) — the in-frame shim; removed ⇒ N8 RED.
  async function shimPhase() {
    const real = arm === 'real';
    lan.reset();
    await inject(evText('SHIM-MARK\n' + fence('html-render title="Popup"', blankBloc(E))));
    await waitFor(async () => (await frames()).some((f) => f.title === 'Popup' && f.h >= 58), 30000, 'the popup bloc');
    await clickIn('Popup', 40, 20);
    await waitFor(async () => (await dialogs()).length ? true : null, real ? 10000 : 3000, 'a confirmation after the target=_blank click').catch(() => {});
    await sleep(1500);
    const d = await dialogs();
    clause(arm, 'C8/target-blank-link-click-produces-the-confirmation', d.length === 1 && d[0].url === `${E}/shim-blank` && evil.hits.filter((u) => u.startsWith('/shim')).length === 0, `click on <a target=_blank href=${E}/shim-blank> in a bloc: confirmations ${d.length}, url ${JSON.stringify(d[0]?.url)}; listener /shim* requests ${evil.hits.filter((u) => u.startsWith('/shim')).length}`);
    if (d.length) { await key('Escape', 'Escape', 27); await sleep(600); }
    if (!real) return;
    lan.reset();
    await inject(evText('SHIMOPEN-MARK\n' + fence('html-render title="Fenetre"', openBloc(E))));
    const d2 = await waitFor(async () => { const x = await dialogs(); return x.length ? x : null; }, 15000, 'a confirmation after window.open').catch(() => []);
    await sleep(1000);
    clause(arm, 'C9/window-open-produces-the-confirmation', d2.length === 1 && d2[0].url === `${E}/shim-open` && evil.hits.filter((u) => u.startsWith('/shim')).length === 0, `window.open('${E}/shim-open') from a bloc script: confirmations ${d2.length}, url ${JSON.stringify(d2[0]?.url)}; listener /shim* requests ${evil.hits.filter((u) => u.startsWith('/shim')).length}`);
    if (d2.length) { await key('Escape', 'Escape', 27); await sleep(600); }
  }
  // #416: what a navigation from a bloc does. N1 is the headline (the URL reaches the listener ONLY after the human confirms); the rest are real-build only.
  async function navPhase() {
    const real = arm === 'real';
    if (real) { // the instrument first: a link in a REPLY opens through the same path and the listener SEES it (a quiet listener below must mean "not opened")
      lan.reset();
      await inject(evText('REPLY-LINK-MARK [reply link](' + E + '/reply-link)'));
      await waitFor(() => cdp.eval(`!![...document.querySelectorAll('a.av-md-link')].find((a) => a.href.endsWith('/reply-link'))`), 20000, 'the reply link');
      const pos = await cdp.eval(`(() => { const a = [...document.querySelectorAll('a.av-md-link')].find((x) => x.href.endsWith('/reply-link')); a.scrollIntoView({ block: 'center' }); const r = a.getBoundingClientRect(); return { x: r.left + 5, y: r.top + r.height / 2 }; })()`);
      await sleep(300);
      const p2 = await cdp.eval(`(() => { const a = [...document.querySelectorAll('a.av-md-link')].find((x) => x.href.endsWith('/reply-link')); const r = a.getBoundingClientRect(); return { x: r.left + 5, y: r.top + r.height / 2 }; })()`);
      await cdp.click(p2.x, p2.y);
      await waitFor(() => evil.hits.includes('/reply-link'), 15000, 'the listener to see the reply link opened (xdg-open stub)').catch(() => {});
      clause(arm, 'ctl/reply-link-opens-and-the-listener-sees-it', evil.hits.filter((u) => u === '/reply-link').length === 1 && lines(/open external \(window-open\): .*\/reply-link/).length === 1, `a link in a reply: listener saw ${evil.hits.filter((u) => u === '/reply-link').length}x /reply-link; app log "open external (window-open)" ${lines(/open external \(window-open\): .*\/reply-link/).length}x (the path a confirmed bloc link must take)`);
    }
    // ── a link clicked in a bloc ──
    lan.reset();
    const pend0 = lines(/→ surfaced/).length;
    await inject(evText('NAVLINK-MARK\n' + fence('html-render title="Lien"', linkBloc(E))));
    await waitFor(async () => (await frames()).some((f) => f.title === 'Lien' && f.h >= 88), 30000, 'the link bloc');
    await clickIn('Lien', 40, 20);
    const linkUrl = new URL(`${E}/confirm-link?${NAV_PAD}&end=LINK-END`).href;
    if (real) {
      const d = await waitFor(async () => { const x = await dialogs(); return x.length ? x : null; }, 15000, 'the confirmation after the link click');
      await sleep(2000);
      const d2 = await dialogs();
      const unopened = evil.hits.filter((u) => u.startsWith('/confirm')).length;
      clause(arm, 'C1/url-reaches-the-listener-only-after-confirmation', unopened === 0 && isoNavHits.length === 0 && d2.length === 1, `script navigation (I2 bloc) + link click, nobody answered: listener saw ${isoNavHits.length} /nav* and ${unopened} /confirm* request(s) while a confirmation was up (${d2.length} shown)`);
      clause(arm, 'C2/confirmation-shows-the-complete-url', d.length === 1 && d[0].url === linkUrl && linkUrl.length > 640, `shown ${d[0].url?.length} chars, expected ${linkUrl.length} chars (…${linkUrl.slice(-30)}); equal=${d[0].url === linkUrl}; safe button focused=${d[0].cancel}`);
      saveShot('real-nav-confirmation-renderer.png', await cdp.shot());
      // dismiss: nothing opens, the bloc is as it was
      const before = (await frames()).find((f) => f.title === 'Lien');
      await key('Escape', 'Escape', 27); await sleep(800);
      const after = (await frames()).find((f) => f.title === 'Lien');
      const gone = (await dialogs()).length === 0;
      await sleep(1500);
      clause(arm, 'C3/dismiss-opens-nothing-and-leaves-the-bloc', gone && !!after && after.h === before.h && evil.hits.filter((u) => u.startsWith('/confirm')).length === 0, `Escape: confirmation gone=${gone}; bloc still there=${!!after} height ${before?.h}→${after?.h}; listener /confirm* requests ${evil.hits.filter((u) => u.startsWith('/confirm')).length}`);
      // a re-click right after a dismissal is silent (a bloc cannot make the human answer in a loop)
      await clickIn('Lien', 40, 20); await sleep(1500);
      clause(arm, 'C4/repeat-after-dismissal-does-not-reprompt', (await dialogs()).length === 0 && lines(/→ muted/).length >= 1, `re-click 1.5 s after Escape: confirmations ${(await dialogs()).length}; log "→ muted" ${lines(/→ muted/).length}x`);
    } else {
      await sleep(3000);
      const hit = evil.hits.filter((u) => u.startsWith('/confirm-link')).length;
      clause(arm, 'C1/url-reaches-the-listener-only-after-confirmation', hit === 0 && isoNavHits.length === 0, `script navigation (I2 bloc) + link click, nobody confirmed anything: listener saw ${isoNavHits.length} /nav* ${JSON.stringify(isoNavHits)} and ${hit} /confirm-link request(s) (${hit + isoNavHits.length > 0 ? 'a URL left without a confirmation' : 'nothing arrived'})`);
      clause(arm, 'ctl/nav-attempt-made', lines(/refused a frame navigation.*confirm-link/).length >= 1, `the guard saw the link navigation ${lines(/refused a frame navigation.*confirm-link/).length}x (a quiet listener without it would mean the click never navigated)`);
      return;
    }
    // ── a script-driven navigation, repeated ──
    lan.reset();
    const coal0 = lines(/→ coalesced/).length;
    await inject(evText('NAVJS-MARK\n' + fence('html-render title="Script"', jsNavBloc(E))));
    await waitFor(async () => { const x = await dialogs(); return x.length ? x : null; }, 20000, 'the confirmation after the script navigation');
    let maxShown = 0; const urls = new Set();
    for (let i = 0; i < 18; i++) { const x = await dialogs(); maxShown = Math.max(maxShown, x.length); x.forEach((d) => urls.add(d.url)); await sleep(100); }
    const coalesced = lines(/→ coalesced/).length - coal0;
    const early = evil.hits.filter((u) => u.startsWith('/confirm-js')).length;
    clause(arm, 'C5/repeated-attempts-coalesce-into-one-confirmation', maxShown === 1 && urls.size === 1 && [...urls][0] === `${E}/confirm-js?first` && coalesced >= 5 && early === 0, `script navigating every 40 ms: max confirmations on screen ${maxShown}, distinct urls shown ${JSON.stringify([...urls])}, guard log "→ coalesced" ${coalesced}x, listener /confirm-js requests ${early}`);
    // confirm: opens exactly that URL, once, the way a reply link does
    await clickButton('.av-bloc-nav-open');
    await waitFor(() => evil.hits.some((u) => u.startsWith('/confirm-js')), 15000, 'the confirmed URL to reach the listener').catch(() => {});
    await sleep(3500);
    const got = evil.hits.filter((u) => u.startsWith('/confirm-js'));
    clause(arm, 'C6/confirm-opens-exactly-that-url-once', got.length === 1 && got[0] === '/confirm-js?first' && lines(/open external \(bloc-confirm\): .*\/confirm-js\?first/).length === 1 && (await dialogs()).length === 0, `after « Open link »: listener saw ${JSON.stringify(got)}; app log "open external (bloc-confirm)" ${lines(/open external \(bloc-confirm\): .*\/confirm-js\?first/).length}x; confirmation closed=${(await dialogs()).length === 0}`);
    clause(arm, 'C7/guard-listener-never-throws', lines(/uncaughtException/).length === 0 && lines(/Render frame was disposed/).length === 0, `app log: uncaughtException ${lines(/uncaughtException/).length}x, "Render frame was disposed" ${lines(/Render frame was disposed/).length}x (Electron's event.frame getter throws on repeated attempts from one frame: an unguarded read kills the guard after the first attempt)`);
    await shimPhase();
    await keyPhase();
    void pend0;
  }
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
    if (mut) clause(arm, 'ctl/mutation-applied', mutProof.changed, mutProof.proofs.map((x) => `${JSON.stringify(x.from)} -> ${JSON.stringify(x.to)} exactly once in ${x.file} (md5 ${x.beforeMd5} -> ${x.afterMd5})`).join(' + ') + ', applied to a disposable COPY');

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

      // a FINISHED reply that ends inside an open fence (interrupted turn, reload): the source as code, never a placeholder forever
      await inject(evText('OPENDONE-MARK\n```html-render title="Coupé"\n<p>OPENDONE-CODE</p>'));
      await waitFor(() => cdp.eval(`(() => { const m = [...document.querySelectorAll('.av-message')].find((e) => e.textContent.includes('OPENDONE-MARK')); return !!m && !!m.querySelector('.av-code-lang'); })()`), 30000, 'the finished open-fence reply');
      const od = await cdp.eval(`(() => { const m = [...document.querySelectorAll('.av-message')].find((e) => e.textContent.includes('OPENDONE-MARK')); return { langs: [...m.querySelectorAll('.av-code-lang')].map((x) => x.textContent), code: m.textContent.includes('OPENDONE-CODE'), pending: m.querySelectorAll('.av-bloc-pending').length, frames: m.querySelectorAll('iframe').length }; })()`);
      clause(arm, 'P5b/finished-reply-ending-in-an-open-fence-shows-code', od.langs[0] === 'html-render' && od.code && od.pending === 0 && od.frames === 0, `done reply, fence never closed → code ${JSON.stringify(od.langs)} with the source=${od.code}, placeholders ${od.pending}, iframes ${od.frames}`);
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

    // ── PHASE NET (D5): what a bloc may fetch (https: — N1) and may not (http: — N2); what the app window itself fetches (S1) ──
    const I = {}, N = {};
    if (arm !== 'sandbox-loop') {
      if (arm === 'real') {
        lan.reset();
        await inject(evText('IMG-MARK ![prose](' + G + '/prose.png)'));
        await waitFor(() => cdp.eval(`(() => { const i = [...document.querySelectorAll('.av-message img')].find((x) => x.src.includes('prose.png')); return !!i && i.complete; })()`), 20000, 'the prose image to settle');
        const img = await cdp.eval(`(() => { const i = [...document.querySelectorAll('.av-message img')].find((x) => x.src.includes('prose.png')); i.scrollIntoView({ block: 'center' }); const r = i.getBoundingClientRect(); return { complete: i.complete, nat: i.naturalWidth, w: Math.round(r.width), h: Math.round(r.height), left: r.left, top: r.top }; })()`);
        await settle(500);
        const shot = await cdp.shot(); saveShot('real-remote-image-in-reply-renderer.png', shot);
        const Ip = decodePng(shot), pxl = px(Ip, img.left + img.w / 2, img.top + img.h / 2);
        clause(arm, 'S1/remote-image-in-a-reply-loads', good.hits.filter((u) => u.startsWith('/prose.png')).length >= 1 && img.nat === 160 && near(pxl, ASSET_RGB, 4),
          `a remote https markdown image in the app window: https listener saw ${good.hits.filter((u) => u.startsWith('/prose.png')).length} request(s); decoded ${img.nat}px wide; screenshot pixel at its centre rgb(${pxl}) vs the served rgb(${ASSET_RGB}) — a proxied/offline app window fails all three`);
      }
      lan.reset();
      await inject(evText('ISO-MARK\n' + fence('html-render title="Isolation"', isoBloc())));
      const r = await waitFor(() => probe('iso'), 30000, 'the isolation probe report');
      I.I3 = { ok: /^ERR/.test(r.parentApi) && /^ERR/.test(r.parentDoc) && r.ownApi === 'undefined/undefined' && r.origin === 'null' && /^ERR/.test(r.cookie), detail: `from inside the frame: typeof parent.orchestra = ${r.parentApi}; parent.document = ${r.parentDoc}; own orchestra/require = ${r.ownApi}; origin = ${r.origin}; cookie = ${r.cookie}` };

      // N1: every https channel works; the frame says so AND the https listener saw it
      lan.reset();
      await inject(evText('NETH-MARK\n' + fence('html-render title="Réseau https"', netBloc(G, `wss://127.0.0.1:${good.port}`, 'neth', true))));
      const rh = await waitFor(() => probe('neth'), 30000, 'the https network probe report');
      const gh = good.hits.slice();
      const seen = (re) => gh.some((u) => re.test(u));
      const chans = { fetch: /^status 200 listener-ok/.test(rh.fetch ?? ''), xhr: rh.xhr === 'status 200', img: rh.img === 'loaded 160x80', script: rh.script === 'ran 42', css: rh.css === 'rgb(1, 2, 3)', ws: rh.ws === 'open', blob: rh.blob === 'blob-ok', font: rh.font === 'loaded', data: rh.data === 'loaded', staticImg: rh.staticImg === 160 };
      const listener = { fetch: seen(/^\/fetch/), xhr: seen(/^\/xhr/), img: seen(/^\/asset\.png\?dyn/), script: seen(/^\/lib\.js/), css: seen(/^\/css/), ws: seen(/^UPGRADE \/ws/), staticImg: seen(/^\/asset\.png\?static/), font: seen(/^\/font\.woff2/) };
      N.N1 = { ok: Object.values(chans).every(Boolean) && Object.values(listener).every(Boolean), detail: `https bloc, frame says ${JSON.stringify(rh)}; ok per channel ${JSON.stringify(chans)}; https listener saw per channel ${JSON.stringify(listener)} (${gh.length} requests)` };
      if (arm === 'real') {
        const frn = await cdp.eval(`(() => { const f = document.querySelector('iframe.av-bloc-frame[title="Réseau https"]'); f.scrollIntoView({ block: 'center' }); const b = f.getBoundingClientRect(); return { left: b.left, top: b.top }; })()`);
        await settle(700);
        const shot = await cdp.shot(); saveShot('real-bloc-remote-asset-renderer.png', shot);
        const Ib = decodePng(shot), pxb = px(Ib, frn.left + rh.rect.l + rh.rect.w / 2, frn.top + rh.rect.t + rh.rect.h / 2);
        clause(arm, 'N1b/bloc-remote-asset-on-screen', near(pxb, ASSET_RGB, 4) && rh.rect.w === 160 && rh.rect.h === 80, `screenshot pixel at the centre of the bloc's https <img> rgb(${pxb}) vs the served rgb(${ASSET_RGB}); box ${JSON.stringify(rh.rect)}`);
      }

      // N2: nothing over plain http — the frame says every channel failed, the http listener saw NOTHING
      lan.reset();
      await inject(evText('NETP-MARK\n' + fence('html-render title="Réseau http"', netBloc(E, `ws://127.0.0.1:${evil.port}`, 'netp', false))));
      const rp = await waitFor(() => probe('netp'), 30000, 'the http network probe report');
      await sleep(1500);
      const eh = evil.hits.slice();
      const refusedCh = { fetch: /^ERR/.test(rp.fetch ?? ''), xhr: rp.xhr === 'ERR', img: rp.img === 'ERR', script: rp.script === 'ERR', css: rp.css === 'rgba(0, 0, 0, 0)', ws: rp.ws === 'ERR', font: rp.font === 'ERR', staticImg: rp.staticImg === 0 };
      N.N2 = { ok: eh.length === 0 && Object.values(refusedCh).every(Boolean), detail: `http bloc, frame says ${JSON.stringify(rp)}; refused per channel ${JSON.stringify(refusedCh)}; the http listener (instrument seen YES on a node-side GET at boot) saw ${eh.length} request(s): ${JSON.stringify(eh)}` };

      lan.reset();
      await inject(evText('NAV-MARK\n' + fence('html-render title="Navigation"', navBloc(E))));
      await waitFor(async () => (await frames()).some((f) => f.title === 'Navigation'), 30000, 'the navigation bloc frame');
      await sleep(4500); // no probe report: a frame that navigates away takes its script with it
      const navHits = evil.hits.filter((u) => /^\/(nav|popup)/.test(u));
      isoNavHits = navHits.slice();
      const appLog = fs.readFileSync(logFile, 'utf8') + (fs.existsSync(path.join(world.ohome, 'logs', 'orchestra.log')) ? fs.readFileSync(path.join(world.ohome, 'logs', 'orchestra.log'), 'utf8') : '');
      const opened = appLog.split('\n').filter((l) => l.includes('[open-url]') && l.includes(`127.0.0.1:${evil.port}`));
      const refused = appLog.split('\n').filter((l) => l.includes('bloc-html: refused a frame navigation')).length;
      I.I2 = { ok: navHits.length === 0 && opened.length === 0, detail: `http listener saw ${navHits.length} navigation request(s) (location.href / meta refresh / link click / window.open / top.location): ${JSON.stringify(navHits)}; app asked the OS to open the listener's URL ${opened.length}x; guard refusals logged ${refused}` };
      const fr = (await frames()).find((f) => f.title === 'Navigation');
      I.I2.detail += `; frame still in the page: ${!!fr}`;
      if (arm === 'real') clause(arm, 'ctl/navigation-guard-fired', refused >= 1 && !!fr, `the app logged ${refused} refusal(s) of a sub-frame navigation (a green I2 with 0 refusals would mean the bloc never navigated)`);
    }
    if (arm === 'nav-key') { if ((await dialogs()).length) { await key('Escape', 'Escape', 27); await sleep(500); } await keyPhase(); }
    if (arm === 'nav-shim') { if ((await dialogs()).length) { await key('Escape', 'Escape', 27); await sleep(500); } await shimPhase(); } // the I2 probes' confirmation frees the slot first
    if (arm === 'real' || arm === 'nav-bypass') {
      if (arm === 'real') { // the I2 probes made the guard raise ONE confirmation (a nav bloc is a navigation); answer it so the slot is free
        const d = await dialogs();
        clause(arm, 'C0/the-I2-navigation-probes-raised-one-confirmation', d.length === 1 && /^http:\/\/127\.0\.0\.1:\d+\/nav/.test(d[0].url ?? ''), `after the I2 navigation bloc: confirmations on screen ${d.length}, url ${JSON.stringify(d[0]?.url)}`);
        if (d.length) { await key('Escape', 'Escape', 27); await sleep(500); }
      }
      await navPhase();
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
    if (arm === 'real') {
      // a bloc flooding height reports must leave the window responsive (measured, no mutant arm: the guard is "one comparison per report")
      await inject(evText('FLOOD-MARK\n' + fence('html-render title="Flood"', '<div style="height:40px">flood</div><script>setTimeout(function(){for(var i=0;i<300000;i++)parent.postMessage({__blocHtml:1,h:i%2000},"*");parent.postMessage({__probe:"flood",r:{sent:1}},"*")},300)</script>')));
      await waitFor(() => probe('flood'), 60000, 'the flood bloc to finish sending');
      const t1 = Date.now();
      const fa = await Promise.race([cdp.eval('1 + 1', 4000).then((v) => ({ v }), (e) => ({ err: String(e).slice(0, 80) })), sleep(5000).then(() => ({ timeout: true }))]);
      I.I5 = { ok: fa.v === 2 && Date.now() - t1 < 1500, detail: `300000 height reports from one frame; an evaluation in the app window right after: ${JSON.stringify(fa)} in ${Date.now() - t1} ms` };
    }
    if (arm === 'real' || arm === 'sandbox-loop') {
      // the loop runs in its OWN bloc, last: a same-origin frame freezes the whole window (the control must see that)
      await inject(evText('LOOP-MARK\n' + fence('html-render title="Boucle"', LOOP_BLOC)));
      await waitFor(() => probe('loop'), 30000, 'the loop bloc to start'); // a loop that never started would pass I4 vacuously
      await sleep(2000);
      const t0 = Date.now();
      const ans = await Promise.race([cdp.eval('1 + 1', 4000).then((v) => ({ v }), (e) => ({ err: String(e).slice(0, 80) })), sleep(5000).then(() => ({ timeout: true }))]);
      I.I4 = { ok: ans.v === 2, detail: `an evaluation in the app window, 2 s into the frame's infinite loop: ${JSON.stringify(ans)} after ${Date.now() - t0} ms` };
    }

    // ── verdicts of the isolation clauses ──
    const named = { N1: 'N1/an-https-request-from-a-bloc-succeeds (script, style, img, font, fetch, XHR, wss:, blob:, data:)', N2: 'N2/an-http-request-from-a-bloc-is-refused (nothing reaches the http listener)', I5: 'I5/message-flood-leaves-the-window-responsive', I2: 'I2/navigation-guard-removed-reaches-the-listener', I3: 'I3/same-origin-frame-reads-the-api-object', I4: 'I4/same-origin-looping-frame-freezes-the-window' };
    for (const [k, v] of [...Object.entries(N), ...Object.entries(I)]) clause(arm, named[k], v.ok, v.detail);
    fs.writeFileSync(path.join(OUT, `${arm}-hits.json`), JSON.stringify({ httpHits: evil.hits, httpsHits: good.hits, N, I }, null, 2));
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
const lan = await startNetwork();
console.log(`[rig] app ${APP_DIR} arms ${ARMS.join(',')} http 127.0.0.1:${lan.evil.port} https 127.0.0.1:${lan.good.port} out=${OUT}`);
for (const arm of ARMS) { if (arm !== 'real' && !MUTANTS[arm]) refuse(`unknown arm ${arm}`); await runArm(arm, lan); }
lan.close();
const after = liveCanary();
const same = JSON.stringify(before) === JSON.stringify(after);
clause('rig', 'ctl/live-claude-dirs-untouched', same, `${Object.keys(before).length} live ~/.claude* dirs, symlink-set + mcpServers hashes ${same ? 'identical before/after' : 'CHANGED: ' + JSON.stringify({ before, after })}`);

// ── verdict ───────────────────────────────────────────────────────────────────────────────────────
const isI = (c) => /^[IN]\d+\//.test(c.clause);
const isCtl = (c) => /^(ctl|rig)\//.test(c.clause);
const lines = [];
let rc = 0;
for (const arm of ARMS) {
  const mine = results.filter((c) => c.arm === arm);
  const ctlRed = mine.filter((c) => isCtl(c) && !c.ok).map((c) => c.clause);
  if (arm === 'real') {
    const red = mine.filter((c) => !c.ok).map((c) => c.clause);
    lines.push(`real: ${red.length === 0 ? 'ALL GREEN' : 'RED ' + red.join(', ')} (${mine.length} clauses)`);
    if (red.length) rc = 1;
  } else {
    const want = MUTANTS[arm].clause;
    const named = mine.find((c) => c.clause.startsWith(want + '/'));
    // removing the sandbox also re-enables popups and top navigation (that is part of its job), so I2 may follow it
    const allowed = arm === 'sandbox-api' || arm === 'nav-bypass' ? ['I2'] : [];
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
