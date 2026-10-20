// Accès mobile #334 — end to end on a BUILT Orchestra inside the contained rig's own headless sway.
//
// Seeds a scratch world (two repos on two scratch accounts, three workspaces incl. one archived) with Accès mobile ON, boots the
// app, then proves on the REAL process tree:
//   ctl/*        app identity (target url + served bundle md5), scratch containment, the server process exists with an
//                ALLOWLISTED environ, the token file is 0600 in a 0700 dir
//   sec/*        must-FAIL arms against the live port, each beside a passing control: no identity, colleague identity,
//                no token, bad token, token in the query string, non-loopback interface
//   phone/*      a headless Chromium in iPhone emulation (serve's identity header injected) pairs via #t=, the fragment is
//                stripped, the list shows every non-archived workspace across both accounts, en attente first — DOM + screenshot
//   settings/*   the Settings dialog shows "Listening", the serve command; a TRUSTED click turns it off ⇒ port refused,
//                process gone; on again ⇒ listening — DOM + screenshots
//   supervise/*  SIGKILL the server ⇒ main restarts it (new pid); SIGKILL the app ⇒ the server exits (no orphan listening)
//   qr/*         (#336) the Settings dialog: no tailnet host ⇒ no QR + a prompt; a TRUSTED-typed host ⇒ the QR whose RENDERED PIXELS
//                (screenshot → jsQR, an independent decoder) decode to exactly the URL printed beside it, token in the fragment
//   regen/*      a TRUSTED click on « Regenerate token »: new token on disk, old token 401 / new 200, the phone paired with the old one
//                shows « Jeton refusé » and re-pairs from the NEW displayed URL
//   pwa/*        manifest + icons + apple-touch-icon load behind the identity check, the service worker registers and caches ONLY the
//                shell, and with the server off (502) or the stand-in gone (connection refused) the phone page is served from that
//                cache and says « Orchestra injoignable » — then recovers by itself
//   leak/*       no token in any request line the server saw, none in any log / file under ORCHESTRA_HOME
//   launch/*     (#375/#376) a workspace launched from the phone: the repos list, every auth refusal (no identity / colleague / forged header /
//                no or bad or query token) beside a passing launch, an UNREGISTERED real git repo refused with nothing created, an empty
//                prompt refused, the REAL create (repo's Compte, the WORKSPACE default model + effort — not the spawned one —, top-level, a
//                generated branch) whose first prompt reaches the REAL claude CLI (fake API), a double submit = one workspace, the 11th launch
//                in a minute = 429 with nothing created, the hooks socket has no launch route
//   skills/*     the composer's `/` menu: project + user skills and the CLI's built-ins from the REAL route, trusted typing filters,
//                a trusted tap fills « /<name> », no match ⇒ hidden; the desktop-only clear / mcp / status are not offered
//   relaunch/*   « Relancer Orchestra » from the phone: the ↻ asks first (« Annuler » relaunches nothing), « Relancer » = a REAL quit + exec
//                of the installed app with no newer install; the open phone page says « relancé » once a NEW app answers
//   control/*    interrupt + rewind from the phone: a trusted « ■ Arrêter » ends a REAL turn the slow fake model holds; a trusted « ↺ Revenir
//                ici » undoes it (prompt back in the field, gone from both surfaces) and the next model request no longer carries it
//   archive/*    a trusted « Archiver » + confirm on the phone archives a coordinator AND its subtree like the sidebar (worktrees kept),
//                the phone is back on its list without them, the desktop leaves the archived pane; an archived / unknown id is refused
//                swipe: TRUSTED touches — a vertical drag scrolls, a left swipe reveals « Archiver » (no sideways scroll), its tap archives
// Usage: scripts/e2e-acces-mobile.sh <app-dir> [--out <dir>]
import { execFileSync, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import { startFakeApi } from './session-budget/fake-anthropic-api.mjs';
import { createRequire } from 'node:module';
import path from 'node:path';
import jsQR from 'jsqr';
import { PNG } from 'pngjs';
import QRCode from 'qrcode';

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const refuse = (m) => { console.log(`REFUSED: ${m}`); process.exit(3); };
const APP_DIR = argv[0] && !argv[0].startsWith('--') ? fs.realpathSync(argv[0]) : refuse('no <app-dir>');
const LIVE_HOME = flag('--live-home', null) ?? refuse('--live-home missing');
const RIG_DIR = process.env.RIG_DIR, RIG_WAYLAND = process.env.RIG_WAYLAND;
if (!RIG_DIR || !RIG_WAYLAND) refuse('run via scripts/e2e-acces-mobile.sh (the contained rig)');
if (process.env.DISPLAY) refuse('X11 DISPLAY set — would reach the human screen');
if (process.env.WAYLAND_DISPLAY !== RIG_WAYLAND || RIG_WAYLAND === 'wayland-1') refuse(`WAYLAND_DISPLAY=${process.env.WAYLAND_DISPLAY} is not the rig's`);
const OUT = flag('--out', path.join(RIG_DIR, 'shots'));
const CHROMIUM = flag('--chromium', '/usr/bin/chromium-browser');

const RIG_BASE = fs.realpathSync(path.dirname(RIG_DIR));
const real = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
const LIVE = [...fs.readdirSync(LIVE_HOME).filter((n) => n === '.claude' || n.startsWith('.claude-')).map((n) => path.join(LIVE_HOME, n)), path.join(LIVE_HOME, '.orchestra'), path.join(LIVE_HOME, '.config')].map(real);
const mustBeScratch = (what, p) => {
  const r = real(p);
  if (LIVE.some((l) => r === l || r.startsWith(l + path.sep))) refuse(`${what}=${p} is a live dir`);
  if (!(r === RIG_BASE || r.startsWith(RIG_BASE + path.sep))) refuse(`${what}=${p} is outside the rig base`);
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const md5 = (b) => crypto.createHash('md5').update(b).digest('hex');
/** Width × height of a baseline/progressive JPEG (its SOF segment), null if it is not one. */
function jpegSize(b) {
  if (b[0] !== 0xff || b[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) return null;
    const m = b[i + 1];
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(m)) return { w: b.readUInt16BE(i + 7), h: b.readUInt16BE(i + 5) };
    i += 2 + b.readUInt16BE(i + 2);
  }
  return null;
}

/** A Y4M video (Chromium's fake camera input) of `text` as a QR code, black on white, 640×480. */
function qrY4m(text) {
  const W = 640, H = 480;
  const { size, data } = QRCode.create(text, { errorCorrectionLevel: 'M' }).modules;
  const px = Math.floor(Math.min(W, H) / (size + 8)), ox = Math.floor((W - size * px) / 2), oy = Math.floor((H - size * px) / 2);
  const y = Buffer.alloc(W * H, 255);
  for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) if (data[r * size + c]) for (let dy = 0; dy < px; dy++) y.fill(0, (oy + r * px + dy) * W + ox + c * px, (oy + r * px + dy) * W + ox + (c + 1) * px);
  const uv = Buffer.alloc((W / 2) * (H / 2), 128);
  const frame = Buffer.concat([Buffer.from('FRAME\n'), y, uv, uv]);
  return Buffer.concat([Buffer.from(`YUV4MPEG2 W${W} H${H} F10:1 Ip A1:1 C420jpeg\n`), ...Array.from({ length: 10 }, () => frame)]);
}

async function waitFor(fn, ms, what) {
  const t0 = Date.now(); let last;
  while (Date.now() - t0 < ms) { try { last = await fn(); if (last) return last; } catch (e) { last = e; } await sleep(200); }
  throw new Error(`timeout ${ms}ms waiting for ${what}${last instanceof Error ? `: ${last.message}` : ''}`);
}
const freePort = () => new Promise((res, rej) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); s.on('error', rej); });
const sh = (cmd, args, opt = {}) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opt });
const git = (cwd, args, home) => sh('git', ['-c', 'user.name=rig', '-c', 'user.email=rig@example.invalid', ...args], { cwd, env: { PATH: process.env.PATH, HOME: home, GIT_CONFIG_NOSYSTEM: '1' } });
const connects = (host, port) => new Promise((resolve) => { const s = net.connect({ host, port }); s.setTimeout(1500, () => { s.destroy(); resolve(false); }); s.on('connect', () => { s.destroy(); resolve(true); }); s.on('error', () => resolve(false)); });
function req(socketPath, p, headers = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ socketPath, path: p, headers }, (res) => { let body = ''; res.on('data', (c) => (body += c)); res.on('end', () => resolve({ status: res.statusCode, body })); });
    r.on('error', reject); r.end();
  });
}
const sockConnects = (socketPath) => new Promise((resolve) => { const s = net.connect({ path: socketPath }); s.setTimeout(1500, () => { s.destroy(); resolve(false); }); s.on('connect', () => { s.destroy(); resolve(true); }); s.on('error', () => resolve(false)); });
/** A stand-in for `tailscale serve … unix:<sock>`: TCP on loopback for the browser, strips every client-sent Tailscale-User-*
 *  header and sets the tailnet identity of the device it represents (kb/1312/serve) — 502 when the socket is not there. */
function serveProxy(getSock, login, seen = [], who = '?') {
  const srv = http.createServer((inReq, inRes) => {
    const headers = Object.fromEntries(Object.entries(inReq.headers).filter(([k]) => !k.toLowerCase().startsWith('tailscale-user-')));
    if (login) headers['tailscale-user-login'] = login;
    const line = { who, method: inReq.method, url: inReq.url, ua: String(inReq.headers['user-agent'] ?? ''), status: null, at: Date.now() }; seen.push(line); // the REQUEST LINE the server would see
    // an upstream that dies mid-response (the server killed / turned off) cuts the device's connection too, as tailscale serve does —
    // a bare pipe would leave the phone's stream hanging open forever
    const out = http.request({ socketPath: getSock(), path: inReq.url, method: inReq.method, headers }, (r) => { line.status = r.statusCode; inRes.writeHead(r.statusCode, r.headers); r.pipe(inRes); r.on('close', () => { if (!r.complete) inRes.destroy(); }); });
    out.on('error', () => { line.status = 502; inRes.writeHead(502); inRes.end(); });
    inReq.pipe(out);
  });
  return new Promise((res) => srv.listen(0, '127.0.0.1', () => res({ srv, port: srv.address().port })));
}
/** Stop a stand-in so its port REFUSES connections (keep-alive sockets included), and bring it back on the same port. */
const stopProxy = (p) => new Promise((res) => { p.srv.closeAllConnections?.(); p.srv.close(() => res()); });
const startProxy = (p) => new Promise((res, rej) => { p.srv.once('error', rej); p.srv.listen(p.port, '127.0.0.1', () => res()); });
function proxyGetBin(port, p, headers = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, path: p, headers }, (res) => { const c = []; res.on('data', (d) => c.push(d)); res.on('end', () => resolve({ status: res.statusCode, type: String(res.headers['content-type'] ?? ''), body: Buffer.concat(c) })); });
    r.on('error', reject); r.end();
  });
}
/** Decode a QR from PNG bytes with an INDEPENDENT decoder (jsQR); null when none is found. */
function decodeQr(pngBuf) {
  const png = PNG.sync.read(pngBuf);
  return jsQR(new Uint8ClampedArray(png.data.buffer, png.data.byteOffset, png.data.length), png.width, png.height)?.data ?? null;
}
/** Every file under `dir` (except `skip`) that contains one of `secrets` — the leak scan. */
function filesContaining(dir, secrets, skip = new Set()) {
  const hits = []; let scanned = 0;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) { walk(f); continue; }
      if (!e.isFile() || skip.has(f)) continue;
      try { if (fs.statSync(f).size > 64 * 1024 * 1024) continue; const b = fs.readFileSync(f); scanned++; if (secrets.some((x) => b.includes(x))) hits.push(f); } catch {}
    }
  };
  walk(dir);
  return { hits, scanned };
}
function proxyPost(port, p, headers, body) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, path: p, method: 'POST', headers }, (res) => { let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve({ status: res.statusCode, body: b })); });
    r.on('error', reject); r.end(body);
  });
}
function reqPost(socketPath, p, headers, body) {
  return new Promise((resolve, reject) => {
    const r = http.request({ socketPath, path: p, method: 'POST', headers }, (res) => { let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve({ status: res.statusCode, body: b })); });
    r.on('error', reject); r.end(body);
  });
}
function proxyGet(port, p, headers = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, path: p, headers }, (res) => { let body = ''; res.on('data', (c) => (body += c)); res.on('end', () => resolve({ status: res.statusCode, body })); });
    r.on('error', reject); r.end();
  });
}
/** TCP listening sockets owned by pid (its fd table vs /proc/net/tcp{,6}). */
function tcpListenersOf(pid) {
  const inodes = new Map();
  for (const fd of fs.readdirSync(`/proc/${pid}/fd`)) { try { const m = /^socket:\[(\d+)\]$/.exec(fs.readlinkSync(`/proc/${pid}/fd/${fd}`)); if (m) inodes.set(m[1], fd); } catch {} }
  const out = [];
  for (const f of ['/proc/net/tcp', '/proc/net/tcp6']) for (const line of fs.readFileSync(f, 'utf8').split('\n').slice(1)) {
    const c = line.trim().split(/\s+/);
    if (c[3] === '0A' && inodes.has(c[9])) out.push(`fd${inodes.get(c[9])}=${c[1]}(port ${parseInt(c[1].split(':')[1], 16)})`);
  }
  return out;
}

class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.method && this.tap) { try { this.tap(m); } catch {} } const p = m.id && this.pending.get(m.id); if (p) { this.pending.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); } }; }
  static async connect(url) { const ws = new WebSocket(url); await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws error')); }); return new Cdp(ws); }
  send(method, params = {}, ms = 20000) { const id = ++this.id; return new Promise((res, rej) => { const t = setTimeout(() => { this.pending.delete(id); rej(new Error(`CDP ${method} timed out`)); }, ms); this.pending.set(id, { res: (v) => { clearTimeout(t); res(v); }, rej: (e) => { clearTimeout(t); rej(e); } }); this.ws.send(JSON.stringify({ id, method, params })); }); }
  async eval(expr) { const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(`eval threw: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`); return r.result.value; }
  async click(x, y) { for (const [type, extra] of [['mouseMoved', {}], ['mousePressed', { button: 'left', clickCount: 1 }], ['mouseReleased', { button: 'left', clickCount: 1 }]]) { await this.send('Input.dispatchMouseEvent', { type, x, y, ...extra }); await sleep(60); } }
  async clickSel(sel) { const b = await this.eval(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`); if (!b) throw new Error(`no ${sel}`); await this.click(b.x, b.y); }
  async shot() { const r = await this.send('Page.captureScreenshot', { format: 'png' }, 25000); return Buffer.from(r.data, 'base64'); }
  close() { try { this.ws.close(); } catch {} }
}

const results = [], shots = [];
function clause(name, ok, detail) { results.push({ name, ok: !!ok }); console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name} — ${detail}`); }
function saveShot(name, buf) { fs.mkdirSync(OUT, { recursive: true }); const f = path.join(OUT, name); fs.writeFileSync(f, buf); shots.push({ file: f, md5: md5(buf) }); console.log(`  shot ${f} md5 ${md5(buf)}`); return f; }
const environOf = (pid) => fs.readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0').filter(Boolean);
const cmdlineOf = (pid) => fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean);
/** The Accès mobile server of THIS rig: identity = its environ names this rig's token file. */
function serverPids(tokenFile) {
  const out = [];
  for (const p of fs.readdirSync('/proc').filter((n) => /^\d+$/.test(n))) {
    try { if (environOf(p).includes(`ACCES_MOBILE_TOKEN_FILE=${tokenFile}`) && fs.readFileSync(`/proc/${p}/stat`, 'utf8').split(') ')[1][0] !== 'Z') out.push(+p); } catch {}
  }
  return out;
}

// ── seed ──
const SAMPLE_TRANSCRIPT = path.join(path.dirname(new URL(import.meta.url).pathname), 'fixtures/payloads/acces-mobile-transcript.sample.jsonl');
const HISTORY_COPIES = 40;
const HISTORY_SESSION = JSON.parse(fs.readFileSync(SAMPLE_TRANSCRIPT, 'utf8').split('\n')[0]).sessionId;
// The fake model answers in Markdown: the phone must RENDER it (« faux modèle » in <strong>), so the visible text is FAKE_REPLY.
const FAKE_REPLY_MD = 'Réponse du **faux modèle** pour le téléphone';
const FAKE_REPLY = 'Réponse du faux modèle pour le téléphone';
// #339: the rig ASKS for a question (wantAsk++) and the next main (tool-carrying) model request answers with a real AskUserQuestion
// tool call; everything else gets the canned text.
const ASK_INPUT = { questions: [{ question: 'Quelle option pour le rig ?', header: 'Choix', multiSelect: false, options: [{ label: 'Réponse-rig-A', description: 'la première' }, { label: 'Réponse-rig-B', description: 'la seconde' }] }] };
let wantAsk = 0;
// #375: a sentinel in every phone-launched prompt — `marks` on a model request says the prompt REACHED the session.
const LAUNCH_SENTINEL = 'LANCEMENT-TEL-SENTINELLE-7f3a';
const fakeOpts = { keepAttachmentData: true, markers: { launch: LAUNCH_SENTINEL }, reply: (rec) => {
  if (rec.tools > 0 && wantAsk > 0) { wantAsk--; return { toolUse: { name: 'AskUserQuestion', input: ASK_INPUT } }; }
  return { text: FAKE_REPLY_MD };
} };
const fakeApi = await startFakeApi(fakeOpts); // fakeOpts.replyDelayMs is read per request: the slow-first-turn arm sets it
const LOGIN = 'rig.owner@example.invalid';
const world = (() => {
  const d = path.join(RIG_DIR, 'world');
  const fakeHome = path.join(d, 'home'), ohome = path.join(d, 'oh'), cfgA = path.join(d, 'cfg-mc'), cfgB = path.join(d, 'cfg-perso');
  const repoA = path.join(d, 'repo-orchestra'), repoB = path.join(d, 'repo-perso');
  for (const x of [fakeHome, ohome, cfgA, cfgB, repoA, repoB, path.join(d, 'wt')]) { fs.mkdirSync(x, { recursive: true }); mustBeScratch('seed', x); }
  const wts = [];
  const coordDir = path.join(d, 'coord'); fs.mkdirSync(coordDir, { recursive: true });
  const plainDir = (n) => { const x = path.join(d, `plain-${n}`); fs.mkdirSync(x, { recursive: true }); return x; };
  for (const [repo, name] of [[repoA, 'am-waiting'], [repoA, 'am-idle'], [repoB, 'am-unread'], [repoB, 'am-archived']]) {
    if (!fs.existsSync(path.join(repo, '.git'))) { git(repo, ['init', '-q', '-b', 'main'], fakeHome); fs.writeFileSync(path.join(repo, 'README.md'), '#\n'); git(repo, ['add', '.'], fakeHome); git(repo, ['commit', '-q', '-m', 'seed'], fakeHome); }
    const wt = path.join(d, 'wt', name); git(repo, ['worktree', 'add', '-q', '-b', `e2e/${name}`, wt], fakeHome); wts.push(wt);
  }
  // skills/*: a PROJECT skill in am-idle's worktree and a USER skill in its account (mc)'s config dir — the phone's `/` menu lists both.
  const seedSkill = (dir, name, desc) => { fs.mkdirSync(path.join(dir, name), { recursive: true }); fs.writeFileSync(path.join(dir, name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${desc}\n---\n# ${name}\n`); };
  seedSkill(path.join(wts[1], '.claude', 'skills'), 'rig-project-skill', 'A project skill seeded by the rig. Second sentence.');
  seedSkill(path.join(cfgA, 'skills'), 'rig-user-skill', 'A user skill seeded by the rig.');
  // A pinned account DROPS the inherited ANTHROPIC_* (workspaces.ts accountAgentEnv) unless its own env sets them: point mc at the
  // fake API through ${...} templates expanded from the app's env.
  const fakeEnv = { ANTHROPIC_API_KEY: '${ANTHROPIC_API_KEY}', ANTHROPIC_BASE_URL: '${ANTHROPIC_BASE_URL}' };
  const accounts = [{ id: 'acc-mc', label: 'mc', configDir: cfgA, env: fakeEnv }, { id: 'acc-perso', label: 'perso', configDir: cfgB }];
  // #337: a transcript captured from the real CLI (texts replaced) as am-unread's history, in ITS account's project dir.
  const histDir = path.join(cfgB, 'projects', fs.realpathSync(wts[2]).replace(/[^A-Za-z0-9]/g, '-'));
  fs.mkdirSync(histDir, { recursive: true });
  const sampleLines = fs.readFileSync(SAMPLE_TRANSCRIPT, 'utf8').trim().split('\n');
  const copies = [];
  for (let k = 0; k < HISTORY_COPIES; k++) {
    for (const l of sampleLines) {
      // re-mint every id per copy (uuid, message id, tool ids) so 40 copies are 40 distinct exchanges, structure untouched
      // the fixture writes `"key": "value"` (a space): without `\s*` nothing was re-minted, the 40 copies shared one uuid and the history read lost every user line
      copies.push(l.replace(/("uuid":\s*"|"parentUuid":\s*"|"id":\s*"|"tool_use_id":\s*"|"sourceToolAssistantUUID":\s*")([^"]+)"/g, (_m, key, id) => `${key}${id}-c${k}"`).replace(/"toolu_[^"]+":/g, (m) => m.replace('":', `-c${k}":`)));
    }
  }
  fs.writeFileSync(path.join(histDir, `${HISTORY_SESSION}.jsonl`), copies.join('\n') + '\n');
  const base = { baseBranch: 'main', createdAt: Date.now(), agent: 'claude' };
  const workspaces = [
    { ...base, id: 'ws-am-waiting', name: 'repo-orchestra · am-waiting', repoPath: repoA, worktreePath: wts[0], branch: 'e2e/am-waiting', status: 'waiting', accountId: 'acc-mc' },
    { ...base, id: 'ws-am-idle', name: 'repo-orchestra · am-idle', repoPath: repoA, worktreePath: wts[1], branch: 'e2e/am-idle', status: 'idle', accountId: 'acc-mc', parentId: 'ws-am-coord' },
    // #338: am-idle is a FLEET MEMBER of this coordinator's run, whose bus `delivery` switch is ON — the agent `/message` path refuses it.
    { ...base, id: 'ws-am-coord', name: 'orchestrator · am-coord', kind: 'orchestrator', repoPath: '', baseBranch: '', worktreePath: coordDir, branch: 'am-coord', status: 'idle' },
    // #373: the whole tree — am-coord › am-sub › am-deep › am-deeper; am-kid under am-idle (a waiting ancestor later); am-hung under an ARCHIVED middle parent
    ...[['sub', 'ws-am-coord'], ['deep', 'ws-am-sub'], ['deeper', 'ws-am-deep'], ['kid', 'ws-am-idle'], ['hung', 'ws-am-arch2']].map(([n, parentId]) => ({ ...base, id: `ws-am-${n}`, name: `orchestrator · am-${n}`, kind: 'orchestrator', repoPath: '', baseBranch: '', worktreePath: plainDir(n), branch: `am-${n}`, status: 'idle', parentId })),
    { ...base, id: 'ws-am-arch2', name: 'orchestrator · am-arch2', kind: 'orchestrator', repoPath: '', baseBranch: '', worktreePath: plainDir('arch2'), branch: 'am-arch2', status: 'idle', archived: true, archivedAt: Date.now(), parentId: 'ws-am-coord' },
    { ...base, id: 'ws-am-unread', name: 'am-unread', repoPath: repoB, worktreePath: wts[2], branch: 'e2e/am-unread', status: 'idle', autoUnread: true, accountId: 'acc-perso', sdkSessionId: HISTORY_SESSION },
    { ...base, id: 'ws-am-archived', name: 'am-archived', repoPath: repoB, worktreePath: wts[3], branch: 'e2e/am-archived', status: 'idle', archived: true, archivedAt: Date.now(), accountId: 'acc-perso' },
  ];
  return { d, fakeHome, ohome, accounts, workspaces, repos: [{ path: repoA, name: 'orchestra-rig', defaultBranch: 'main', accountId: 'acc-mc' }, { path: repoB, name: 'perso-rig', defaultBranch: 'main', accountId: 'acc-perso' }] };
})();

const SERVE_PORT = 8445;
const storeDir = path.join(world.ohome, 'userData', 'orchestra'); fs.mkdirSync(storeDir, { recursive: true });
fs.writeFileSync(path.join(storeDir, 'store.json'), JSON.stringify({ repos: world.repos, workspaces: world.workspaces, accounts: world.accounts, selfTuneRuns: [], accesMobile: { enabled: true, port: 47823 /* a pre-review store: must be ignored */, servePort: SERVE_PORT, allowedLogin: LOGIN } }, null, 2));
// #337: the REAL claude CLI (structured sessions resolve `claude` on PATH) against the LOCAL FAKE Anthropic API — zero tokens;
// every other egress goes to the fake's refusing proxy.
const stubDir = path.join(world.d, 'bin'); fs.mkdirSync(stubDir, { recursive: true });
const REAL_CLAUDE = fs.realpathSync(path.join(LIVE_HOME, '.local/bin/claude'));
fs.symlinkSync(REAL_CLAUDE, path.join(stubDir, 'claude'));
const TOKEN_FILE = path.join(world.ohome, 'acces-mobile', 'token');

// #338: the coordinator's run with the bus `delivery` switch ON, written by the REAL bus module (bundled, run under Electron-as-node
// for the better-sqlite3 ABI), exactly as the bus-page rig does.
{
  const require_ = createRequire(import.meta.url);
  const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
  const { build } = (() => { try { return require_('esbuild'); } catch { const g = fs.globSync?.(repoRoot + '/node_modules/.pnpm/esbuild@*/node_modules/esbuild') ?? []; if (!g.length) throw new Error('esbuild not resolvable'); return require_(g[0]); } })();
  const entry = path.join(world.d, 'bus-seed-entry.ts');
  fs.writeFileSync(entry, `export { openBus, busPath } from ${JSON.stringify(path.join(repoRoot, 'src/main/bus.ts'))};\nexport { startRun } from ${JSON.stringify(path.join(repoRoot, 'src/main/bus-runs.ts'))};\nexport { DEFAULT_BUS_SWITCHES } from ${JSON.stringify(path.join(repoRoot, 'src/shared/bus-switches.ts'))};\n`);
  const bundle = path.join(world.d, 'bus-seed.cjs');
  await build({ entryPoints: [entry], outfile: bundle, bundle: true, format: 'cjs', platform: 'node', external: ['electron', 'better-sqlite3', 'node-pty'], logLevel: 'silent', nodePaths: [path.join(repoRoot, 'node_modules')] });
  const runner = path.join(world.d, 'bus-seed-run.cjs');
  fs.writeFileSync(runner, `const m = require(${JSON.stringify(bundle)}); const db = m.openBus(m.busPath()); m.startRun(db, { id: 'ws-am-coord', kind: 'mission', coordinator: 'ws-am-coord', title: 'am rig fleet' }, { ...m.DEFAULT_BUS_SWITCHES, delivery: true }); db.close(); console.log('SEEDED ' + m.busPath());`);
  const out = sh(path.join(APP_DIR, 'node_modules/electron/dist/electron'), [runner], { env: { PATH: process.env.PATH, HOME: world.fakeHome, ORCHESTRA_HOME: world.ohome, ELECTRON_RUN_AS_NODE: '1', NODE_PATH: path.join(repoRoot, 'node_modules') } });
  if (!out.includes(`SEEDED ${path.join(world.ohome, 'bus.sqlite')}`)) throw new Error(`bus seeding did not report the scratch path: ${out}`);
}

// ── boot ──
const cdpPort = await freePort();
const env = { PATH: `${stubDir}:/usr/local/bin:/usr/bin:/bin`, HOME: world.fakeHome, XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR, XDG_CONFIG_HOME: path.join(world.fakeHome, '.config'), XDG_CACHE_HOME: path.join(world.fakeHome, '.cache'),
  WAYLAND_DISPLAY: RIG_WAYLAND, SWAYSOCK: process.env.SWAYSOCK, ELECTRON_OZONE_PLATFORM_HINT: 'wayland', ORCHESTRA_OZONE: 'wayland', ORCHESTRA_OZONE_RELAUNCHED: '1',
  ORCHESTRA_HOME: world.ohome, ORCHESTRA_DEBUG_PORT: String(cdpPort), ORCHESTRA_SELF_TUNE_CMD: '/bin/true', CLAUDE_CONFIG_DIR: world.accounts[0].configDir, LANG: 'C.UTF-8',
  SECRET_CANARY_FROM_MAIN: 'must-not-reach-the-server',
  ANTHROPIC_BASE_URL: fakeApi.url, ANTHROPIC_API_KEY: 'sk-ant-fake-rig-key', HTTPS_PROXY: fakeApi.proxyUrl, HTTP_PROXY: fakeApi.proxyUrl, NO_PROXY: '127.0.0.1,localhost',
  // « Nouvelle version installée »: an unpackaged app has no AppImage — this stands for the installed one (update/* swaps it)
  ORCHESTRA_INSTALLED_APP: path.join(world.d, 'installed', 'Orchestra.AppImage') };
fs.mkdirSync(path.dirname(env.ORCHESTRA_INSTALLED_APP), { recursive: true });
fs.writeFileSync(env.ORCHESTRA_INSTALLED_APP, '#!/bin/sh\necho the build this app started from\n', { mode: 0o755 });
for (const k of ['HOME', 'ORCHESTRA_HOME', 'CLAUDE_CONFIG_DIR']) mustBeScratch(`env.${k}`, env[k]);
sh('swaymsg', ['output', 'HEADLESS-1', 'resolution', '1400x900']);
const logFile = path.join(world.d, 'app.log'); const fd = fs.openSync(logFile, 'w');
const app = spawn(path.join(APP_DIR, 'node_modules/electron/dist/electron'), [APP_DIR, '--ozone-platform=wayland'], { cwd: APP_DIR, env, stdio: ['ignore', fd, fd], detached: true });
console.log(`app pid ${app.pid}, cdp ${cdpPort}, log ${logFile}`);
let appPid = app.pid; // update/relaunch replaces the app
fs.writeFileSync(path.join(world.d, 'app.pid'), String(app.pid));
let SOCK = null;
const seenLines = []; // every request line any stand-in forwarded (leak/* reads it)
const ownerProxy = await serveProxy(() => SOCK, LOGIN, seenLines, 'owner');
const colleagueProxy = await serveProxy(() => SOCK, 'colleague@example.invalid', seenLines, 'colleague');
const taggedProxy = await serveProxy(() => SOCK, null, seenLines, 'tagged'); // a tagged device: serve sets no identity
let cdp, chrome, phone, exitCode = 1;
try {
  const target = await waitFor(async () => (await (await fetch(`http://127.0.0.1:${cdpPort}/json`)).json()).find((x) => x.type === 'page' && x.url.includes('dist/index.html')) || null, 60000, 'app page target');
  clause('ctl/app-identity-path', target.url.includes(APP_DIR) && !target.url.includes('app.asar'), `target url ${target.url}`);
  cdp = await Cdp.connect(target.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await waitFor(() => cdp.eval(`!!document.querySelector('[data-am-open]')`), 60000, 'the Accès mobile header button');
  const bundle = (await cdp.eval(`[...document.querySelectorAll('script[src]')].map((s) => s.src)`)).find((s) => /assets\/index-.*\.js/.test(s));
  const frameId = (await cdp.send('Page.getResourceTree')).frameTree.frame.id;
  const rc = await cdp.send('Page.getResourceContent', { frameId, url: bundle });
  const served = Buffer.from(rc.content, rc.base64Encoded ? 'base64' : 'utf8');
  const onDisk = path.join(APP_DIR, 'dist', bundle.split('/dist/')[1]);
  const ver = JSON.parse(fs.readFileSync(path.join(APP_DIR, 'package.json'), 'utf8')).version;
  const runningVer = await cdp.eval(`(window.orchestra && window.orchestra.appVersion) ? window.orchestra.appVersion() : null`).catch(() => null);
  clause('ctl/app-identity-bundle', md5(served) === md5(fs.readFileSync(onDisk)), `served ${path.basename(bundle)} md5 ${md5(served)} == ${onDisk}; package.json ${ver}; running reports ${runningVer ?? 'n/a'}`);
  const appEnv = environOf(app.pid);
  clause('ctl/scratch-env', appEnv.includes(`ORCHESTRA_HOME=${world.ohome}`) && !appEnv.some((e) => e.startsWith('DISPLAY=')), `app ORCHESTRA_HOME=${world.ohome}, no DISPLAY`);

  // server process + token file
  const pids = await waitFor(() => { const p = serverPids(TOKEN_FILE); return p.length ? p : null; }, 30000, 'the Accès mobile server process');
  const view = await cdp.eval(`window.orchestra.accesMobile()`);
  SOCK = view.socketPath;
  await waitFor(() => sockConnects(SOCK), 30000, 'the server socket');
  const sst = fs.statSync(SOCK);
  clause('ctl/socket-0600', sst.isSocket() && (sst.mode & 0o777) === 0o600 && (fs.statSync(path.dirname(SOCK)).mode & 0o077) === 0, `${SOCK} mode ${(sst.mode & 0o777).toString(8)}, dir ${(fs.statSync(path.dirname(SOCK)).mode & 0o777).toString(8)}`);
  clause('ctl/settings-port-ignored', !('port' in view.settings) && view.serveCommand === `sudo tailscale serve --bg --https=${SERVE_PORT} unix:${SOCK}`, `settings ${JSON.stringify(view.settings)}; "${view.serveCommand}"`);
  const srvEnv = environOf(pids[0]).map((e) => e.split('=')[0]).sort();
  clause('ctl/server-one-process', pids.length === 1, `pids ${pids.join(',')} argv ${cmdlineOf(pids[0]).join(' ')}`);
  clause('ctl/server-env-allowlisted', !srvEnv.includes('SECRET_CANARY_FROM_MAIN') && !srvEnv.includes('HOME') && !srvEnv.includes('CLAUDE_CONFIG_DIR') && srvEnv.includes('ACCES_MOBILE_SOCKET') && !srvEnv.includes('ACCES_MOBILE_PORT') && !srvEnv.includes('ORCHESTRA_SOCK'), `server environ keys: ${srvEnv.join(' ')}`);
  const tokStat = fs.statSync(TOKEN_FILE), dirStat = fs.statSync(path.dirname(TOKEN_FILE));
  clause('ctl/token-file-mode', (tokStat.mode & 0o777) === 0o600 && (dirStat.mode & 0o777) === 0o700, `token ${(tokStat.mode & 0o777).toString(8)}, dir ${(dirStat.mode & 0o777).toString(8)}`);
  const TOKEN = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
  const ID = { 'Tailscale-User-Login': LOGIN }, AUTH = { ...ID, Authorization: `Bearer ${TOKEN}` };

  // security arms against the live port
  const ctl = await req(SOCK, '/api/workspaces', AUTH);
  const rows = ctl.status === 200 ? JSON.parse(ctl.body).workspaces : [];
  clause('sec/control-200', ctl.status === 200 && rows.length === 9 && rows.some((r) => r.name === 'orchestrator · am-coord' && r.displayName === 'am-coord' && r.group === 'Orchestrators') && rows.some((r) => r.name === 'repo-orchestra · am-idle' && r.displayName === 'am-idle') && rows.some((r) => r.name === 'am-unread' && r.displayName === 'am-unread'), `status ${ctl.status}; rows ${rows.map((r) => `${r.name}[${r.status}${r.unread ? ',unread' : ''}/${r.account}/${r.group}]`).join(' ')}`);
  // A seeded `waiting` is resolved to idle + non lu at store load (store.ts: no live process can still be asking), so a real
  // en attente needs a live AskUserQuestion (#339). Here: attention rank never decreases, both accounts, archived dropped.
  const rank = (r) => (r.status === 'waiting' ? 0 : r.unread ? 1 : 2);
  const sorted = rows.every((r, i) => i === 0 || rank(rows[i - 1]) <= rank(r));
  clause('phone-api/order-and-accounts', sorted && rows.filter((r) => r.unread).length === 2 && rank(rows[2]) === 2 && rows.some((r) => r.account === 'mc') && rows.some((r) => r.account === 'perso') && !rows.some((r) => r.name === 'am-archived'), `ranks ${rows.map(rank).join(',')}; non lu first; both accounts; archived dropped`);
  const BEARER = { Authorization: `Bearer ${TOKEN}` };
  const viaOwner = await proxyGet(ownerProxy.port, '/api/workspaces', BEARER);
  clause('sec/control-through-serve', viaOwner.status === 200, `owner device through the serve stand-in: ${viaOwner.status}`);
  for (const [name, fn, want] of [
    ['sec/no-identity', () => req(SOCK, '/api/workspaces', BEARER), 403],
    ['sec/colleague-through-serve', () => proxyGet(colleagueProxy.port, '/api/workspaces', BEARER), 403],
    ['sec/colleague-forges-owner-header', () => proxyGet(colleagueProxy.port, '/api/workspaces', { ...BEARER, 'Tailscale-User-Login': LOGIN }), 403],
    ['sec/tagged-device-forges-owner-header', () => proxyGet(taggedProxy.port, '/api/workspaces', { ...BEARER, 'Tailscale-User-Login': LOGIN }), 403],
    ['sec/no-token', () => proxyGet(ownerProxy.port, '/api/workspaces'), 401],
    ['sec/bad-token', () => proxyGet(ownerProxy.port, '/api/workspaces', { Authorization: `Bearer ${'x'.repeat(43)}` }), 401],
    ['sec/query-token', () => proxyGet(ownerProxy.port, `/api/workspaces?t=${TOKEN}`), 401],
    ['sec/shell-no-identity', () => req(SOCK, '/'), 403],
  ]) {
    const r = await fn();
    clause(name, r.status === want && !r.body.includes('am-'), `status ${r.status} (want ${want}), body ${r.body.length} bytes`);
  }
  const tcp = tcpListenersOf(pids[0]);
  // #336: every static asset of the PWA (worker, manifest, icons) is behind the identity check like the shell
  const ASSET_PATHS = ['/', '/app.js', '/sw.js', '/manifest.webmanifest', '/apple-touch-icon.png', '/icon-192.png', '/icon-512.png', '/launch.js', '/launch.css'];
  const assetsOwner = await Promise.all(ASSET_PATHS.map((p) => proxyGetBin(ownerProxy.port, p, {})));
  clause('sec/assets-control-owner', assetsOwner.every((r) => r.status === 200 && r.body.length > 0) && assetsOwner.filter((r) => r.type === 'image/png').length === 3, `owner device through serve: ${ASSET_PATHS.map((p, i) => `${p}=${assetsOwner[i].status}`).join(' ')}`);
  const assetsAnon = await Promise.all(ASSET_PATHS.map((p) => req(SOCK, p)));
  const assetsColleague = await Promise.all(ASSET_PATHS.map((p) => proxyGetBin(colleagueProxy.port, p, {})));
  const assetsForged = await Promise.all(ASSET_PATHS.map((p) => proxyGetBin(taggedProxy.port, p, { 'Tailscale-User-Login': LOGIN })));
  clause('sec/assets-need-identity', [...assetsAnon, ...assetsColleague, ...assetsForged].every((r) => r.status === 403 && (r.body.length === 0)), `no identity / colleague / tagged device forging the owner header: ${[...assetsAnon, ...assetsColleague, ...assetsForged].map((r) => r.status).join(',')} (all 403, empty bodies) over ${ASSET_PATHS.length} assets`);
  clause('sec/no-tcp-listener', tcp.length === 0, `server pid ${pids[0]} TCP listening sockets: [${tcp.join(', ')}] (app CDP port ${cdpPort})`);

  // phone: headless chromium, iPhone metrics, serve's identity header injected
  const chromeDir = path.join(world.d, 'chromium'); fs.mkdirSync(chromeDir, { recursive: true });
  const chromePort = await freePort();
  // the phone's CAMERA is a file (in-app QR pairing): rewritten before each scan, reopened by every getUserMedia
  const cameraFile = path.join(world.d, 'camera.y4m'); fs.writeFileSync(cameraFile, qrY4m('nothing yet'));
  chrome = spawn(CHROMIUM, ['--headless=new', `--remote-debugging-port=${chromePort}`, `--user-data-dir=${chromeDir}`, '--no-first-run', '--no-default-browser-check', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${cameraFile}`, 'about:blank'], { env: { PATH: process.env.PATH, HOME: world.fakeHome }, stdio: 'ignore', detached: true });
  const ptarget = await waitFor(async () => (await (await fetch(`http://127.0.0.1:${chromePort}/json`)).json()).find((x) => x.type === 'page') || null, 30000, 'chromium page');
  phone = await Cdp.connect(ptarget.webSocketDebuggerUrl);
  await phone.send('Page.enable'); await phone.send('Network.enable');
  await phone.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
  // an iPhone's notch / home bar: env(safe-area-inset-*) as on the device (the header once slid under the status bar — Lucas 2026-10-12)
  await phone.send('Emulation.setSafeAreaInsetsOverride', { insets: { top: 47, bottom: 34 } });
  await phone.send('Emulation.setUserAgentOverride', { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1' });
  const prePhone = await phone.eval(`location.href`);
  await phone.send('Page.navigate', { url: `http://127.0.0.1:${ownerProxy.port}/#t=${TOKEN}` });
  await waitFor(() => phone.eval(`document.querySelectorAll('li[data-id]').length >= 3`), 20000, "three rows on the phone (am-idle folded under am-coord)");
  const P = await phone.eval(`({ href: location.href, stored: localStorage.getItem('orchestra.accesMobile.token') === ${JSON.stringify(TOKEN)}, ids: [...document.querySelectorAll('li[data-id]')].map((l) => l.dataset.id), groups: [...document.querySelectorAll('h2')].map((h) => h.dataset.group), unreadRows: document.querySelectorAll('li[data-unread="1"]').length, unreadRow: (() => { const r = document.querySelector('li[data-id="ws-am-unread"]'); return r ? { repo: (r.querySelector('.repo') || {}).textContent, br: (r.querySelector('.br') || {}).textContent, acct: (r.querySelector('.acct') || {}).textContent } : null; })(), unreadStl: (document.querySelector('li[data-id="ws-am-unread"] .stl') || {}).textContent, unreadIn: (() => { const r = document.querySelector('li[data-id="ws-am-unread"]'); const h = r && r.closest('ul') && r.closest('ul').previousElementSibling; return h ? h.dataset.group : null; })(), idleHidden: !document.querySelector('li[data-id="ws-am-idle"]'), fold: (document.querySelector('li.fold[data-fold="ws-am-coord"] .fold-n') || {}).textContent || null, counts: [document.getElementById('cntAll').textContent, document.getElementById('cntMe').textContent], live: document.getElementById('live').dataset.live })`);
  clause('phone/paired-fragment-stripped', P.stored && !P.href.includes('#') && !P.href.includes(TOKEN), `${prePhone} -> ${P.href}; token stored=${P.stored}`);
  const apiOrder = rows.map((r) => r.id);
  // Lucas 2026-10-12 (the app boots every row idle ⇒ nothing en attente yet): a non lu row stays IN its repo (bold, « non lu »), no separate section;
  // a coordinator's workers are folded under it (« 6 agents » once the tree is whole); « À traiter » counts the en attente only.
  const visibleApi = apiOrder.filter((id) => !rows.find((r) => r.id === id).parentId); // roots: every worker (any depth) is folded
  clause('phone/list', JSON.stringify(P.ids) === JSON.stringify(visibleApi) && !P.ids.includes('ws-am-archived') && JSON.stringify(P.groups) === JSON.stringify(['orchestra-rig', 'perso-rig', 'Orchestrators']) && P.unreadRows === 2 && P.unreadIn === 'perso-rig' && P.unreadStl === 'non lu' && JSON.stringify(P.unreadRow) === JSON.stringify({ br: 'e2e/am-unread', acct: 'perso' }) && P.idleHidden && P.fold === '6 agents' && JSON.stringify(P.counts) === JSON.stringify(['9', '0']), `phone rows ${P.ids.join(',')} == api order minus the folded worker; groups ${P.groups.join(' | ')}; non lu row in ${P.unreadIn} ${JSON.stringify(P.unreadRow)} stl ${P.unreadStl}; am-idle hidden ${P.idleHidden}, fold « ${P.fold} »; counts Tout/À traiter ${P.counts.join('/')}; live ${P.live}`);
  // the fold opens on a TRUSTED tap (the worker row appears under it, indented) and closes on a second one
  const tapSel = async (sel) => { const c = await phone.eval(`(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`); for (const [type, extra] of [['mousePressed', { button: 'left', clickCount: 1 }], ['mouseReleased', { button: 'left', clickCount: 1 }]]) await phone.send('Input.dispatchMouseEvent', { type, x: c.x, y: c.y, ...extra }); await sleep(200); };
  await tapSel('li.fold[data-fold="ws-am-coord"]');
  const F1 = await phone.eval(`(() => { const r = document.querySelector('li[data-id="ws-am-idle"]'); return r ? { child: r.classList.contains('child'), afterFold: r.previousElementSibling?.dataset.fold === 'ws-am-coord', br: (r.querySelector('.br') || {}).textContent, acct: (r.querySelector('.acct') || {}).textContent, stl: (r.querySelector('.stl') || {}).textContent } : null; })()`);
  // #372: no repo prefix on the phone — the VISIBLE text (innerText) of every row, the fold open so the worker is there too. The seeded desktop
  // names carry `repo-orchestra · ` (the repo DIR's basename, ≠ the chip « orchestra-rig »), `orchestrator · `, and one hand-renamed name (whole).
  const T = await phone.eval(`Object.fromEntries([...document.querySelectorAll('li[data-id]')].map((l) => [l.dataset.id, { title: (l.querySelector('.r1 b') || {}).textContent, text: l.innerText }]))`);
  const wantTitles = { 'ws-am-idle': 'am-idle', 'ws-am-coord': 'am-coord', 'ws-am-unread': 'am-unread' };
  clause('phone/no-repo-prefix', Object.keys(wantTitles).every((id) => T[id]?.title === wantTitles[id]) && Object.values(T).every((r) => !/repo-orchestra\s*·|orchestrator\s*·|scratch\s*·/.test(r.text)), `row titles ${JSON.stringify(Object.fromEntries(Object.entries(T).map(([id, r]) => [id, r.title])))}; no « repo · » / « orchestrator · » in any row's visible text`);
  saveShot('phone-list-fold-open.png', await phone.shot());
  await tapSel('li.fold[data-fold="ws-am-coord"]');
  const F2 = await phone.eval(`!document.querySelector('li[data-id="ws-am-idle"]')`);
  clause('phone/fold-workers', F1?.child && F1.afterFold && F1.br === 'e2e/am-idle' && F1.acct === 'mc' && F1.stl === 'inactif' && F2, `tap ⇒ ${JSON.stringify(F1)}; tap again ⇒ folded ${F2}`);
  // #373: the WHOLE tree. TRUSTED taps open am-coord › am-sub › am-deep (+ am-idle's own fold): every row is reachable, one indentation step per level
  // (the glyph's x), each fold counts its whole subtree; an open fold survives a list refresh; the page never scrolls sideways.
  const tapMaybe = async (sel) => { if (!(await phone.eval(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return false; e.scrollIntoView({ block: 'center', behavior: 'instant' }); return true; })()`))) return false; await sleep(150); await tapSel(sel); return true; };
  const tapped = [];
  for (const f of ['ws-am-coord', 'ws-am-sub', 'ws-am-deep', 'ws-am-idle']) tapped.push(await tapMaybe(`li.fold[data-fold="${f}"]`));
  const treeSnap = () => phone.eval(`(() => { const rs = [...document.querySelectorAll('li[data-id]')]; return { ids: rs.map((l) => l.dataset.id).sort(), depth: Object.fromEntries(rs.map((l) => [l.dataset.id, l.dataset.depth])), x: Object.fromEntries(rs.map((l) => [l.dataset.id, Math.round(l.querySelector('.g').getBoundingClientRect().left)])), folds: Object.fromEntries([...document.querySelectorAll('li.fold')].map((f) => [f.dataset.fold, f.textContent])), noSideScroll: document.documentElement.scrollWidth <= window.innerWidth }; })()`);
  const TR1 = await treeSnap();
  const treeAllIds = rows.map((r) => r.id).sort();
  const dx = (a, b) => Math.abs(TR1.x[a] - TR1.x[b]);
  clause('phone/tree-every-row-reachable', JSON.stringify(TR1.ids) === JSON.stringify(treeAllIds) && new Set(TR1.ids).size === treeAllIds.length, `${TR1.ids.length}/${treeAllIds.length} rows on the phone after opening the folds (taps ${tapped.join(',')}); ids ${TR1.ids.join(',')}`);
  clause('phone/tree-indent-one-step-per-level', TR1.depth['ws-am-coord'] === '0' && TR1.depth['ws-am-sub'] === '1' && TR1.depth['ws-am-hung'] === '1' && TR1.depth['ws-am-deep'] === '2' && TR1.depth['ws-am-kid'] === '2' && TR1.depth['ws-am-deeper'] === '3' && TR1.x['ws-am-sub'] > TR1.x['ws-am-coord'] && Math.abs(dx('ws-am-sub', 'ws-am-coord') - 16) <= 1 && Math.abs(dx('ws-am-deep', 'ws-am-sub') - 16) <= 1 && Math.abs(dx('ws-am-deeper', 'ws-am-deep') - 16) <= 1 && TR1.noSideScroll, `depth ${JSON.stringify(TR1.depth)}; glyph x ${JSON.stringify(TR1.x)}; no sideways scroll ${TR1.noSideScroll}`);
  clause('phone/tree-fold-counts-whole-subtree', TR1.folds['ws-am-coord'] === '▾6 agents' && TR1.folds['ws-am-sub'] === '▾2 agents' && TR1.folds['ws-am-deep'] === '▾1 agent' && TR1.folds['ws-am-idle'] === '▾1 agent', `folds ${JSON.stringify(TR1.folds)}`);
  saveShot('phone-tree-open.png', await phone.shot());
  // a list refresh (the live stream does this): a hash that is no conversation, then back ⇒ route() reloads the list (never open a REAL conversation here: it would mark it seen and spoil conv/seen-clears-bell); the folds opened above must stay open
  await phone.eval(`document.querySelectorAll('li[data-id]').forEach((l) => { l.__before = true; }); location.hash = 'away'; true`); await sleep(400); await phone.eval(`location.hash = ''; true`);
  await waitFor(() => phone.eval(`(() => { const rs = [...document.querySelectorAll('li[data-id]')]; return rs.length > 0 && rs.every((l) => !l.__before) && !document.getElementById('home').hidden; })()`), 15000, 'the list re-rendered (every row is a NEW element) and shown');
  const TR3 = await treeSnap();
  clause('phone/tree-open-state-survives-refresh', JSON.stringify(TR3.ids) === JSON.stringify(TR1.ids) && JSON.stringify(TR3.folds) === JSON.stringify(TR1.folds), `${TR1.ids.length} rows before, ${TR3.ids.length} after leaving the list and coming back (${Object.keys(TR3.folds).length} folds)`);
  // #373-fu (review R373-1): the layout CONTRACT in the REAL stylesheet on real Chromium — synthetic nested row / fold / stand-in at depth 1, 2 and 12
  // appended to the list, computed styles read, then removed. One 16 px step per level, the fold text under its coordinator's title (+34), a rail
  // one period per level, and nothing moves past the 8-level clamp (depth 12 = depth 8).
  const GEO = await phone.eval(`(() => {
    const ul = document.querySelector('#list ul.repo-g'); if (!ul) return null;
    const mk = (cls, depth) => { const li = document.createElement('li'); li.className = cls; li.dataset.depth = String(depth); li.style.setProperty('--depth', String(depth)); ul.appendChild(li); return li; };
    const rail = (li) => getComputedStyle(li).backgroundImage.startsWith('repeating-linear-gradient');
    const probe = (d) => { const r = mk('row small child', d), f = mk('fold', d), s = mk('fold-owner stand', d); const c = (e) => getComputedStyle(e); const o = { row: c(r).paddingLeft, fold: c(f).paddingLeft, stand: c(s).paddingLeft, railW: c(r).backgroundSize.split(' ')[0], railX: c(r).backgroundPositionX, rails: [rail(r), rail(f), rail(s)] }; [r, f, s].forEach((e) => e.remove()); return o; };
    return { d1: probe(1), d2: probe(2), d12: probe(12) };
  })()`);
  const geoWant = (d) => ({ row: `${20 + 16 * d}px`, fold: `${54 + 16 * d}px`, stand: `${20 + 16 * d}px`, railW: `${16 * d}px`, railX: '16px', rails: [true, true, true] });
  const geoOk = GEO && JSON.stringify(GEO.d1) === JSON.stringify(geoWant(1)) && JSON.stringify(GEO.d2) === JSON.stringify(geoWant(2)) && JSON.stringify(GEO.d12) === JSON.stringify(geoWant(8));
  clause('phone/tree-css-geometry', geoOk, `computed styles d1 ${JSON.stringify(GEO?.d1)} · d2 ${JSON.stringify(GEO?.d2)} · d12 ${JSON.stringify(GEO?.d12)} (want 16 px/level, fold +34, rail 16 px/level, clamp at 8 ⇒ d12 = ${JSON.stringify(geoWant(8))})`);
  for (const f of ['ws-am-deep', 'ws-am-sub', 'ws-am-idle', 'ws-am-coord']) await tapMaybe(`li.fold[data-fold="${f}"]`); // close them again: the arms below start from the closed list
  saveShot('phone-list.png', await phone.shot());
  await phone.send('Page.reload');
  await waitFor(() => phone.eval(`document.querySelectorAll('li[data-id]').length >= 3`), 20000, 'rows after reload without the fragment');
  clause('phone/reload-still-paired', true, 'reload without #t= still lists the 3 visible rows (token from localStorage)');

  // Lucas 2026-10-12: the app added to the iOS home screen opened « Pas appairé » — it has ITS OWN storage (Safari's pairing does
  // not follow) and starts at `/` without the fragment. An ISOLATED browser context (empty storage) stands in for it: the page
  // offers in-app pairing — a trusted tap on « Scanner le QR code » reads the QR through the (fake) camera; or a pasted link.
  const browserWs = (await (await fetch(`http://127.0.0.1:${chromePort}/json/version`)).json()).webSocketDebuggerUrl;
  const browserCdp = await Cdp.connect(browserWs);
  const isolatedPhone = async () => {
    const { browserContextId } = await browserCdp.send('Target.createBrowserContext');
    const { targetId } = await browserCdp.send('Target.createTarget', { url: 'about:blank', browserContextId });
    const t = await waitFor(async () => (await (await fetch(`http://127.0.0.1:${chromePort}/json`)).json()).find((x) => x.id === targetId) || null, 15000, 'isolated phone page');
    const p = await Cdp.connect(t.webSocketDebuggerUrl);
    await p.send('Page.enable');
    await p.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
    await p.send('Page.navigate', { url: `http://127.0.0.1:${ownerProxy.port}/` });
    await waitFor(() => p.eval(`!!document.getElementById('pair') && !document.getElementById('pair').hidden && document.getElementById('state').textContent === 'Pas appairé.'`), 20000, 'the pairing panel on an unpaired page');
    const tap = async (sel) => { const c = await p.eval(`(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`); for (const [type, extra] of [['mousePressed', { button: 'left', clickCount: 1 }], ['mouseReleased', { button: 'left', clickCount: 1 }]]) await p.send('Input.dispatchMouseEvent', { type, x: c.x, y: c.y, ...extra }); await sleep(200); };
    return { p, tap, close: async () => { p.close?.(); await browserCdp.send('Target.disposeBrowserContext', { browserContextId }).catch(() => {}); } };
  };
  const liveToken = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
  const tracksLive = `(() => { const v = document.getElementById('scanVideo'); return !!(v.srcObject && v.srcObject.getTracks().some((t) => t.readyState === 'live')); })()`;
  // must-FAIL first: a QR that is not a pairing link is read and REFUSED (nothing stored), and « Annuler » stops the camera
  fs.writeFileSync(cameraFile, qrY4m('https://example.com/menu'));
  const foreign = await isolatedPhone();
  saveShot('phone-pair-panel.png', await foreign.p.shot());
  await foreign.tap('#pairScan');
  await waitFor(() => foreign.p.eval(`/pas un lien d’appairage/.test(document.getElementById('scanHint').textContent)`), 20000, 'the foreign QR refused');
  const FQ = await foreign.p.eval(`({ stored: localStorage.getItem('orchestra.accesMobile.token'), scanShown: !document.getElementById('scan').hidden, live: ${tracksLive} })`);
  saveShot('phone-pair-scanning.png', await foreign.p.shot());
  await foreign.tap('#scanClose');
  const FQ2 = await foreign.p.eval(`({ scanShown: !document.getElementById('scan').hidden, live: ${tracksLive} })`);
  clause('pair/scan-refuses-a-foreign-qr', FQ.stored === null && FQ.scanShown && FQ.live && !FQ2.scanShown && !FQ2.live, `a QR of https://example.com/menu: « pas un lien d’appairage », stored ${FQ.stored}, camera live ${FQ.live}; Annuler ⇒ overlay ${FQ2.scanShown ? 'still shown' : 'gone'}, camera live ${FQ2.live}`);
  await foreign.close();
  // the scan pairs: the QR Orchestra shows (the pairing URL, this token)
  fs.writeFileSync(cameraFile, qrY4m(`https://rig-box.tail0000.ts.net:${SERVE_PORT}/#t=${liveToken}`));
  const scanner = await isolatedPhone();
  await scanner.tap('#pairScan');
  await waitFor(() => scanner.p.eval(`document.querySelectorAll('li[data-id]').length >= 3`), 30000, 'the list after the in-app scan');
  const SQ = await scanner.p.eval(`({ stored: localStorage.getItem('orchestra.accesMobile.token'), pairShown: !document.getElementById('pair').hidden, scanShown: !document.getElementById('scan').hidden, live: ${tracksLive}, href: location.href })`);
  clause('pair/in-app-scan', SQ.stored === liveToken && !SQ.pairShown && !SQ.scanShown && !SQ.live && !SQ.href.includes(liveToken), `trusted tap « Scanner le QR code » ⇒ token stored ${SQ.stored === liveToken}, list of 3, panel ${SQ.pairShown ? 'still shown' : 'gone'}, camera stopped ${!SQ.live}, address ${SQ.href}`);
  await scanner.close();
  // the paste: the same link pasted (trusted typing) pairs too
  const paster = await isolatedPhone();
  await paster.p.eval(`document.getElementById('pairInput').focus(); true`);
  await paster.p.send('Input.insertText', { text: `https://rig-box.tail0000.ts.net:${SERVE_PORT}/#t=${liveToken}` });
  await paster.tap('#pairForm .btn2');
  await waitFor(() => paster.p.eval(`document.querySelectorAll('li[data-id]').length >= 3`), 20000, 'the list after the pasted link');
  const PQ = await paster.p.eval(`({ stored: localStorage.getItem('orchestra.accesMobile.token'), input: document.getElementById('pairInput').value })`);
  clause('pair/in-app-paste', PQ.stored === liveToken && PQ.input === '', `pasted link ⇒ token stored ${PQ.stored === liveToken}, field cleared ${PQ.input === ''}, list of 3`);
  await paster.close();
  browserCdp.close?.();
  // V1: the segmented « À traiter » button (a TRUSTED tap), not the hidden checkbox it drives
  const segMe = await phone.eval(`(() => { const r = document.getElementById('segMe').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  for (const [type, extra] of [['mousePressed', { button: 'left', clickCount: 1 }], ['mouseReleased', { button: 'left', clickCount: 1 }]]) await phone.send('Input.dispatchMouseEvent', { type, x: segMe.x, y: segMe.y, ...extra });
  await sleep(200);
  const filtered = await phone.eval(`({ ids: [...document.querySelectorAll('li[data-id]')].map((l) => l.dataset.id), state: document.getElementById('state').textContent })`);
  clause('phone/filter-needs-me', filtered.ids.length === 0 && filtered.state === 'Rien ne t’attend.', `3 -> ${filtered.ids.length} rows, « ${filtered.state} » (en attente only; the 2 non lus are not « à traiter »)`);
  saveShot('phone-list-needs-me.png', await phone.shot());
  await phone.eval(`(() => { if (document.getElementById('needsMe').checked) document.getElementById('segAll').click(); return true; })()`);

  // #337 history: open am-unread on the phone ⇒ its transcript (other account) reads as user / tool / assistant, and the desktop's
  // bell clears (the phone's « seen » is the desktop's).
  const unreadBefore = JSON.parse(fs.readFileSync(path.join(storeDir, 'store.json'), 'utf8')).workspaces.find((w) => w.id === 'ws-am-unread').autoUnread;
  await phone.eval(`window.__noReload = 1; document.querySelector('li[data-id="ws-am-unread"]').click(); true`);
  await waitFor(() => phone.eval(`document.querySelectorAll('#conv .conv-lines [data-kind]').length === ${3 * HISTORY_COPIES}`), 20000, 'the history on the phone').catch(async (e) => {
    const d = await phone.eval(`fetch('/api/conversation?id=ws-am-unread', { headers: { Authorization: 'Bearer ' + localStorage.getItem('orchestra.accesMobile.token') } }).then((r) => r.json()).then((c) => ({ dom: document.querySelectorAll('#conv .conv-lines [data-kind]').length, state: (document.querySelector('#conv .conv-state') || {}).textContent, hash: location.hash, convId: document.querySelector('#conv')?.dataset.id, api: { ok: c.ok, n: (c.lines || []).length, kinds: [...new Set((c.lines || []).map((l) => l.kind))], err: c.error, firstUser: (c.lines || []).find((l) => l.kind === 'user') } }))`).catch((x) => String(x));
    console.log(`  diag conv/history: ${JSON.stringify(d)}`);
    throw e;
  });
  await sleep(300);
  const SC = await phone.eval(`(() => { const se = document.scrollingElement; const last = [...document.querySelectorAll('#conv .conv-lines [data-kind]')].at(-1).getBoundingClientRect(); return { top: se.scrollTop, h: se.scrollHeight, vh: innerHeight, lastBottom: Math.round(last.bottom) }; })()`);
  const H = await phone.eval(`[...document.querySelectorAll('#conv .conv-lines [data-kind]')].map((e) => e.dataset.kind + ':' + e.textContent)`);
  clause('conv/history', H.length === 3 * HISTORY_COPIES && H[0] === 'user:Liste les fichiers du dépôt, s’il te plaît.' && /^tool:✓ Bash · List repository files$/.test(H[1]) && H[2] === 'assistant:Voici les fichiers : README.md et src/.' && H.at(-1) === H[2], `${H.length} phone lines, first 3 ${JSON.stringify(H.slice(0, 3))}`);
  // Lucas 2026-10-12: « le header clash avec le haut de l’écran » — scrolled (it opens at the end), the sticky header must sit BELOW
  // the status bar (47 px inset) and the strip above it must be covered; control: the inset is really in effect.
  const SA = await phone.eval(`(() => { const h = document.querySelector('#conv .ch').getBoundingClientRect(); const b = getComputedStyle(document.body, '::before'); return { pad: getComputedStyle(document.querySelector('#conv')).paddingTop, headerTop: Math.round(h.top), cover: b.height, coverPos: b.position, coverBg: b.backgroundColor, scrolled: document.scrollingElement.scrollTop }; })()`);
  clause('conv/header-below-status-bar', SA.pad === '47px' && SA.scrolled > 0 && SA.headerTop >= 47 && SA.cover === '47px' && SA.coverPos === 'fixed' && SA.coverBg !== 'rgba(0, 0, 0, 0)', `inset 47 in effect (padding ${SA.pad}); scrolled ${SA.scrolled}px ⇒ header top ${SA.headerTop}px; status-bar strip ${SA.cover} ${SA.coverPos} ${SA.coverBg}`);
  // Lucas 2026-10-12: « ce qui nous intéresse c'est la fin » — a long conversation opens scrolled to its last line
  clause('conv/opens-at-end', SC.h > 3 * SC.vh && SC.top > 0 && SC.top + SC.vh >= SC.h - 4 && SC.lastBottom <= SC.vh, `scrollTop ${SC.top} + viewport ${SC.vh} vs scrollHeight ${SC.h}; last line bottom ${SC.lastBottom}`);
  saveShot('phone-conversation-history.png', await phone.shot());
  await waitFor(() => !JSON.parse(fs.readFileSync(path.join(storeDir, 'store.json'), 'utf8')).workspaces.find((w) => w.id === 'ws-am-unread').autoUnread, 10000, 'the bell cleared in the store').catch(() => null);
  const unreadAfter = JSON.parse(fs.readFileSync(path.join(storeDir, 'store.json'), 'utf8')).workspaces.find((w) => w.id === 'ws-am-unread').autoUnread;
  const deskBell = await cdp.eval(`(() => { const s = window.__orchestraGetState ? window.__orchestraGetState() : null; return s ? (s.workspaces || []).find((w) => w.id === 'ws-am-unread')?.autoUnread ?? null : 'n/a'; })()`).catch(() => 'n/a');
  clause('conv/seen-clears-bell', unreadBefore === true && !unreadAfter, `store autoUnread ${unreadBefore} -> ${unreadAfter} (desktop state: ${deskBell})`);

  // #337 live: open am-idle, drive a REAL turn from the desktop IPC (real CLI, fake API) ⇒ the phone shows it without a reload.
  await phone.eval(`location.hash = 'w=ws-am-idle'; true`);
  await waitFor(() => phone.eval(`document.querySelector('#conv')?.dataset.id === 'ws-am-idle' && !!document.querySelector('#conv')?.dataset.version`), 15000, 'am-idle conversation open');
  const convTitle = await phone.eval(`(document.querySelector('#conv .conv-title') || {}).textContent`);
  clause('conv/title-no-repo-prefix', convTitle === 'am-idle', `the conversation header of « repo-orchestra · am-idle » reads « ${convTitle} »`);
  const pre = await phone.eval(`document.querySelectorAll('#conv .conv-lines [data-kind]').length`);
  const modelBefore = fakeApi.requests.filter((r) => r.type === 'model').length;
  const trace = [];
  const tracer = (async () => {
    for (let i = 0; i < 40; i++) {
      const c = await phone.eval(`fetch('/api/conversation?id=ws-am-idle', { headers: { Authorization: 'Bearer ' + localStorage.getItem('orchestra.accesMobile.token') } }).then((r) => r.json()).then((c) => 'v' + c.version + (c.running ? 'R' : '') + '[' + c.lines.map((l) => l.kind[0]).join('') + ']')`).catch((e) => 'err');
      if (trace.at(-1) !== c) trace.push(c);
      await sleep(200);
    }
  })();
  await cdp.eval(`window.orchestra.agentSdkSend('ws-am-idle', 'Bonjour depuis le rig').then(() => true)`);
  await waitFor(() => phone.eval(`[...document.querySelectorAll('#conv .conv-lines [data-kind="assistant"]')].some((e) => e.textContent.includes(${JSON.stringify(FAKE_REPLY)}))`), 90000, 'the fake reply on the phone');
  const L = await phone.eval(`({ lines: [...document.querySelectorAll('#conv .conv-lines [data-kind]')].map((e) => e.dataset.kind + ':' + e.textContent.slice(0, 60)), noReload: window.__noReload === 1, strong: [...document.querySelectorAll('#conv .conv-lines [data-kind="assistant"] strong')].map((e) => e.textContent), stars: [...document.querySelectorAll('#conv .conv-lines [data-kind="assistant"]')].some((e) => e.textContent.includes('**')) })`);
  clause('conv/markdown', L.strong.includes('faux modèle') && !L.stars, `reply ${JSON.stringify(FAKE_REPLY_MD)} ⇒ <strong> ${JSON.stringify(L.strong)}, raw ** shown ${L.stars}`);
  const modelAfter = fakeApi.requests.filter((r) => r.type === 'model').length;
  const apiConv = await phone.eval(`fetch('/api/conversation?id=ws-am-idle', { headers: { Authorization: 'Bearer ' + localStorage.getItem('orchestra.accesMobile.token') } }).then((r) => r.json()).then((c) => ({ v: c.version, running: c.running, lines: c.lines.map((l) => l.kind + ':' + (l.text || l.label || '').slice(0, 40)) }))`);
  const deskConv = await cdp.eval(`(window.__readAgentSession('ws-am-idle')?.messages ?? []).map((m) => m.role + ':' + String(m.text ?? '').slice(0, 40) + (m.queued ? '(queued)' : ''))`);
  await tracer;
  console.log(`  diag conv/live-turn trace: ${trace.join(' ')}`);
  console.log(`  diag conv/live-turn: api ${JSON.stringify(apiConv)} | desktop fold ${JSON.stringify(deskConv)}`);
  clause('conv/live-turn', L.noReload && pre === 0 && L.lines.some((l) => l === 'user:Bonjour depuis le rig') && modelAfter > modelBefore, `${pre} -> ${L.lines.length} lines without reload: ${JSON.stringify(L.lines)}; fake API model requests ${modelBefore} -> ${modelAfter}; refused egress ${fakeApi.egress.length}`);
  saveShot('phone-conversation-live.png', await phone.shot());

  // #338 must-FAIL control: the AGENT path (`/message` on the hooks socket) refuses am-idle — its run has bus delivery ON …
  // The hooks socket every local agent can reach (its path from the app's pointer file — the phone server is NOT told it).
  const mainSock = fs.readFileSync(path.join(world.ohome, 'sock'), 'utf8').trim();
  const viaAgentPath = await new Promise((resolve, reject) => {
    const r = http.request({ socketPath: mainSock, path: '/message', method: 'POST', headers: { 'Content-Type': 'application/json' } }, (res) => { let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve(JSON.parse(b))); });
    r.on('error', reject); r.end(JSON.stringify({ to: 'ws-am-idle', text: 'coordination via the agent path' }));
  });
  // #338 review M1 must-FAIL: an agent-like local process calling /mobile/send on the HOOKS socket gets nothing — no such route there
  // (the default route answers {}), and no turn starts; only the phone server's private fd-3 channel carries it.
  const modelsBeforeForge = fakeApi.requests.filter((r) => r.type === 'model').length;
  const forged = await new Promise((resolve, reject) => {
    const r = http.request({ socketPath: mainSock, path: '/mobile/send', method: 'POST', headers: { 'Content-Type': 'application/json' } }, (res) => { let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve(b)); });
    r.on('error', reject); r.end(JSON.stringify({ id: 'ws-am-idle', text: 'forged human message from a local agent' }));
  });
  await sleep(4000);
  const forgedLines = await phone.eval(`[...document.querySelectorAll('#conv .conv-lines [data-kind="user"]')].filter((e) => e.textContent.includes('forged human message')).length`);
  clause('send/hooks-socket-has-no-mobile-route', forged === '{}' && forgedLines === 0 && fakeApi.requests.filter((r) => r.type === 'model').length === modelsBeforeForge, `hooks /mobile/send answered ${forged}; no line, no model request in 4 s`);
  clause('send/agent-path-refused', viaAgentPath.ok === false && /delivery switch ON/.test(viaAgentPath.error ?? ''), `hooks /message to the fleet member: ${JSON.stringify(viaAgentPath).slice(0, 160)}`);
  // … while the SAME member takes the human's message from the phone composer (trusted typing + click), and the turn runs.
  const beforeSend = fakeApi.requests.filter((r) => r.type === 'model').length;
  await phone.eval(`document.querySelector('.conv-input').focus(); true`);
  await phone.send('Input.insertText', { text: 'Message tapé sur le téléphone' });
  const sendBtn = await phone.eval(`(() => { const r = document.querySelector('.conv-send').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  await phone.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: sendBtn.x, y: sendBtn.y }] }).catch(() => {});
  await phone.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }).catch(() => {});
  await sleep(300);
  if ((await phone.eval(`document.querySelector('.conv-compose').dataset.state || ''`)) === '') {
    for (const [type, extra] of [['mousePressed', { button: 'left', clickCount: 1 }], ['mouseReleased', { button: 'left', clickCount: 1 }]]) await phone.send('Input.dispatchMouseEvent', { type, x: sendBtn.x, y: sendBtn.y, ...extra });
  }
  await waitFor(() => phone.eval(`[...document.querySelectorAll('#conv .conv-lines [data-kind="user"]')].some((e) => e.textContent === 'Message tapé sur le téléphone')`), 60000, 'the phone message in the conversation');
  await waitFor(() => fakeApi.requests.filter((r) => r.type === 'model').length > beforeSend, 60000, 'a model request for the phone message');
  await waitFor(() => phone.eval(`[...document.querySelectorAll('#conv .conv-lines [data-kind="assistant"]')].filter((e) => e.textContent.includes(${JSON.stringify(FAKE_REPLY)})).length >= 2`), 60000, 'the reply to the phone message');
  const S = await phone.eval(`({ state: document.querySelector('.conv-compose').dataset.state, input: document.querySelector('.conv-input').value, err: document.querySelector('.conv-send-error').textContent })`);
  clause('send/phone-to-fleet-member', S.state === 'sent' && S.input === '' && !S.err, `composer state ${S.state}, input cleared ${S.input === ''}; model requests ${beforeSend} -> ${fakeApi.requests.filter((r) => r.type === 'model').length}; reply shown`);
  saveShot('phone-conversation-sent.png', await phone.shot());

  // skills/*: the `/` menu on the phone — TRUSTED typing, the REAL /api/skills (on-disk skills of THIS workspace + the CLI's built-ins
  // latched from the live session's init), a trusted tap fills the field. The desktop-only intercepts (clear / mcp / status) are absent.
  await phone.eval(`document.querySelector('.conv-input').focus(); true`);
  await phone.send('Input.insertText', { text: '/' });
  await waitFor(() => phone.eval(`!document.querySelector('#conv .conv-ac').hidden && document.querySelectorAll('#conv .conv-ac .ac-row').length > 0`), 15000, 'the skills menu');
  const skApi = await phone.eval(`fetch('/api/skills?id=ws-am-idle', { headers: { Authorization: 'Bearer ' + localStorage.getItem('orchestra.accesMobile.token') } }).then((r) => r.json())`);
  const skNames = (skApi.items ?? []).map((i) => i.name);
  const cliBuiltins = (skApi.items ?? []).filter((i) => i.source === 'builtin' && i.name !== 'compact').map((i) => i.name);
  const skSrc = (n) => (skApi.items ?? []).find((i) => i.name === n)?.source;
  clause('skills/list', skApi.ok && skSrc('rig-project-skill') === 'project' && skSrc('rig-user-skill') === 'user' && skNames.includes('compact') && cliBuiltins.length > 0 && !['clear', 'mcp', 'status'].some((n) => skNames.includes(n)),
    `${skNames.length} items; rig-project-skill source ${skSrc('rig-project-skill')}, rig-user-skill source ${skSrc('rig-user-skill')}, CLI built-ins ${JSON.stringify(cliBuiltins.slice(0, 6))}; desktop-only present ${JSON.stringify(['clear', 'mcp', 'status'].filter((n) => skNames.includes(n)))}`);
  await phone.send('Input.insertText', { text: 'rig-p' });
  await waitFor(() => phone.eval(`[...document.querySelectorAll('#conv .conv-ac .ac-row')].map((r) => r.dataset.name).join(',') === 'rig-project-skill'`), 10000, 'the filtered menu');
  const skMenu = await phone.eval(`({ rows: [...document.querySelectorAll('#conv .conv-ac .ac-row')].map((r) => r.textContent), box: (() => { const a = document.querySelector('#conv .conv-ac').getBoundingClientRect(), f = document.querySelector('#conv .fld').getBoundingClientRect(); return { acBottom: Math.round(a.bottom), fldTop: Math.round(f.top), h: Math.round(a.height) }; })() })`);
  saveShot('phone-skills-menu.png', await phone.shot());
  await tapSel('#conv .conv-ac .ac-row');
  const skPick = await phone.eval(`({ input: document.querySelector('.conv-input').value, hidden: document.querySelector('#conv .conv-ac').hidden, focused: document.activeElement === document.querySelector('.conv-input') })`);
  clause('skills/filter-and-pick', skMenu.rows.length === 1 && skMenu.rows[0] === '/rig-project-skillA project skill seeded by the rig.' && skMenu.box.acBottom <= skMenu.box.fldTop && skMenu.box.h > 0 && skPick.input === '/rig-project-skill ' && skPick.hidden && skPick.focused,
    `typed « /rig-p » ⇒ ${JSON.stringify(skMenu.rows)} above the field ${JSON.stringify(skMenu.box)}; trusted tap ⇒ field ${JSON.stringify(skPick.input)}, menu hidden ${skPick.hidden}, focus kept ${skPick.focused}`);
  await phone.eval(`(() => { const t = document.querySelector('.conv-input'); t.value = ''; t.dispatchEvent(new Event('input')); t.focus(); return true; })()`);
  await phone.send('Input.insertText', { text: '/zz-no-such-skill' });
  await sleep(500);
  const skNone = await phone.eval(`({ hidden: document.querySelector('#conv .conv-ac').hidden, msg: document.querySelector('#conv .conv-lines').textContent.includes('zz-no-such-skill') })`);
  clause('skills/no-match-hidden', skNone.hidden && !skNone.msg, `« /zz-no-such-skill » ⇒ menu hidden ${skNone.hidden}, nothing sent ${!skNone.msg}`);
  await phone.eval(`(() => { const t = document.querySelector('.conv-input'); t.value = ''; t.dispatchEvent(new Event('input')); return true; })()`);
  // errors are never a false « sent »: an archived workspace is refused with a reason
  const arch = await phone.eval(`fetch('/api/send?id=ws-am-archived', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + localStorage.getItem('orchestra.accesMobile.token') }, body: JSON.stringify({ text: 'x' }) }).then((r) => r.json())`);
  clause('send/archived-refused', arch.ok === false && /archived/.test(arch.error), JSON.stringify(arch));

  // skills/desktop-*: the DESKTOP composer's `/` menu now reads the same shared merge/filter (src/shared/slash-menu.ts) — trusted typing
  // into the visible CodeMirror composer of am-idle (selected through the store hook; the selection is not under test).
  // the prior selection is restored after the arm: an ACTIVE am-idle is « seen » the moment it waits, voiding the later En attente arms
  const deskPrev = await cdp.eval(`(() => { let p = null; window.__orchestraSetState((s) => { p = s.activeId; return {}; }); return p; })()`);
  await cdp.eval(`window.__orchestraSetState({ activeId: 'ws-am-idle', page: 'workspaces', insightsOpen: false, helpOpen: false }); true`);
  const cmBox = await waitFor(() => cdp.eval(`(() => { for (const e of document.querySelectorAll('.cm-content')) { const r = e.getBoundingClientRect(); if (r.width > 50 && r.height > 5) return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; } return null; })()`), 20000, 'the desktop composer');
  await cdp.click(cmBox.x, cmBox.y);
  const deskAc = () => cdp.eval(`(() => { const a = document.querySelector('.av-ac'); if (!a) return null; const r = a.getBoundingClientRect(); return { rows: [...a.querySelectorAll('.av-ac-item')].map((i) => i.querySelector('.av-ac-name').textContent + '|' + i.querySelector('.av-ac-source').textContent), inView: r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight && r.height > 0 }; })()`);
  const deskPre = await deskAc();
  await cdp.send('Input.insertText', { text: '/rig-' });
  // the menu first draws from the CLI's list, then the on-disk scan lands (sources project / user) — wait for the scan
  const deskRig = await waitFor(async () => { const a = await deskAc(); return a && a.rows.some((r) => r.endsWith('|project')) ? a : false; }, 15000, 'the desktop skills menu with the on-disk scan').catch(() => deskAc());
  saveShot('desktop-skills-menu.png', await cdp.shot());
  await cdp.eval(`(() => { const v = window.__cmComposerView; v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: '' } }); return true; })()`);
  await cdp.send('Input.insertText', { text: '/c' });
  await sleep(400);
  const deskC = await deskAc();
  await cdp.eval(`(() => { const v = window.__cmComposerView; v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: '' } }); return true; })()`);
  await sleep(300);
  const deskAfter = await deskAc();
  await cdp.eval(`window.__orchestraSetState({ activeId: ${JSON.stringify(deskPrev)} }); true`);
  clause('skills/desktop-menu', deskPre === null && JSON.stringify(deskRig?.rows) === JSON.stringify(['/rig-project-skill|project', '/rig-user-skill|user']) && deskRig.inView && deskC?.rows.includes('/clear|builtin') && deskC.rows.includes('/compact|builtin') && deskAfter === null,
    `menu absent -> « /rig- » ${JSON.stringify(deskRig)}; « /c » ${JSON.stringify(deskC?.rows)}; cleared -> ${JSON.stringify(deskAfter)}; selection restored to ${deskPrev}`);

  // Lucas 2026-10-12 « je ne peux pas coller des fichiers »: a photo (3000×2000) and a PDF PICKED on the phone (the file input the
  // + button opens), plus a PASTED screenshot removed again with a trusted tap, reach the MODEL as image / document blocks — the
  // photo redrawn to ≤ 1568 px, the PDF byte-exact — and show on the phone AND the desktop.
  const filesDir = path.join(RIG_DIR, 'files'); fs.mkdirSync(filesDir, { recursive: true });
  const photo = new PNG({ width: 3000, height: 2000 });
  for (let y = 0; y < 2000; y++) for (let x = 0; x < 3000; x++) { const i = (y * 3000 + x) * 4; photo.data[i] = x % 256; photo.data[i + 1] = y % 256; photo.data[i + 2] = (x + y) % 256; photo.data[i + 3] = 255; }
  const photoPath = path.join(filesDir, 'photo.png'); fs.writeFileSync(photoPath, PNG.sync.write(photo));
  const pdfBytes = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj 3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n');
  const pdfPath = path.join(filesDir, 'note.pdf'); fs.writeFileSync(pdfPath, pdfBytes);
  const { root: docRoot } = await phone.send('DOM.getDocument', { depth: -1 });
  const { nodeId: fileNode } = await phone.send('DOM.querySelector', { nodeId: docRoot.nodeId, selector: '#conv .conv-file' });
  await phone.send('DOM.setFileInputFiles', { nodeId: fileNode, files: [photoPath, pdfPath] });
  await waitFor(() => phone.eval(`document.querySelectorAll('#conv .conv-att').length === 2 && !document.querySelector('.conv-compose').dataset.attaching`), 30000, 'two attachments in the tray');
  const T1 = await phone.eval(`[...document.querySelectorAll('#conv .conv-att')].map((a) => a.dataset.kind + (a.querySelector('img') ? ':img' : ':' + a.querySelector('.att-pdf').textContent))`);
  const tiny = new PNG({ width: 4, height: 4 }); tiny.data.fill(200);
  await phone.eval(`(() => { const b = atob(${JSON.stringify(PNG.sync.write(tiny).toString('base64'))}); const u = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); const dt = new DataTransfer(); dt.items.add(new File([u], 'capture.png', { type: 'image/png' })); const ta = document.querySelector('.conv-input'); ta.focus(); ta.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })); return true; })()`);
  await waitFor(() => phone.eval(`document.querySelectorAll('#conv .conv-att').length === 3`), 10000, 'the pasted screenshot in the tray');
  saveShot('phone-attachments.png', await phone.shot());
  await tapSel('#conv .conv-att:nth-child(3) .conv-att-x');
  const T2 = await phone.eval(`document.querySelectorAll('#conv .conv-att').length`);
  clause('attach/pick-paste-remove', JSON.stringify(T1) === JSON.stringify(['image:img', 'pdf:PDF · note.pdf']) && T2 === 2, `picked ${JSON.stringify(T1)}; a pasted screenshot ⇒ 3 in the tray; trusted × ⇒ ${T2}`);
  const beforeAttach = fakeApi.requests.length;
  await phone.eval(`document.querySelector('.conv-input').focus(); true`);
  await phone.send('Input.insertText', { text: 'Voici une photo et un PDF' });
  await tapSel('.conv-send');
  const R = await waitFor(() => fakeApi.requests.slice(beforeAttach).find((r) => r.type === 'model' && (r.attachments ?? []).length >= 2) || false, 60000, 'a model request carrying the attachments');
  const aImg = R.attachments.find((a) => a.type === 'image'), aDoc = R.attachments.find((a) => a.type === 'document');
  const dims = aImg ? jpegSize(Buffer.from(aImg.data, 'base64')) : null;
  clause('attach/reach-the-model', R.attachments.length === 2 && aImg?.media_type === 'image/jpeg' && dims?.w === 1568 && dims?.h === 1045 && aDoc?.media_type === 'application/pdf' && aDoc.data === pdfBytes.toString('base64'), `model request #${R.seq}: ${JSON.stringify(R.attachments.map((a) => ({ type: a.type, media_type: a.media_type, bytes: a.bytes })))}; photo 3000×2000 ⇒ jpeg ${JSON.stringify(dims)}; pdf byte-exact ${aDoc?.data === pdfBytes.toString('base64')}`);
  await waitFor(() => phone.eval(`[...document.querySelectorAll('#conv .conv-lines [data-kind="user"]')].some((e) => e.textContent.startsWith('Voici une photo et un PDF'))`), 30000, 'the attached message in the conversation');
  await waitFor(() => phone.eval(`[...document.querySelectorAll('#conv .conv-lines [data-kind="assistant"]')].filter((e) => e.textContent.includes(${JSON.stringify(FAKE_REPLY)})).length >= 3`), 60000, 'the reply to the attached message');
  const B = await phone.eval(`(() => { const u = [...document.querySelectorAll('#conv .conv-lines [data-kind="user"]')].filter((e) => e.textContent.startsWith('Voici une photo')).at(-1); return { chip: (u.querySelector('.msg-atts') || {}).textContent, tray: document.querySelectorAll('#conv .conv-att').length, state: document.querySelector('.conv-compose').dataset.state }; })()`);
  const deskImgs = await cdp.eval(`(() => { const m = (window.__readAgentSession('ws-am-idle')?.messages ?? []).filter((x) => x.role === 'user' && String(x.text ?? '').startsWith('Voici une photo')).at(-1); return m ? (m.images || []).map((i) => i.mediaType) : null; })()`);
  clause('attach/shown-on-both-surfaces', B.chip === '🖼 1 image · 📄 1 PDF' && B.tray === 0 && B.state === 'sent' && JSON.stringify(deskImgs) === JSON.stringify(['image/jpeg', 'application/pdf']), `phone bubble « ${B.chip} », tray ${B.tray}, state ${B.state}; desktop user message attachments ${JSON.stringify(deskImgs)}`);
  saveShot('phone-attachments-sent.png', await phone.shot());

  // Interrupt + rewind from the phone (Lucas 2026-10-20 « je veux pouvoir rewind et interrupt sur mon téléphone »): a REAL turn held by a
  // slow fake model is stopped by a TRUSTED tap on « ■ Arrêter »; then a TRUSTED « ↺ Revenir ici » on that turn undoes it — the prompt is back
  // in the field, both surfaces drop it, and the NEXT model request no longer carries it while the turn before it is still there.
  const LONG = 'Tour long à arrêter REWIND-SENTINELLE-91c2';
  fakeOpts.markers.undone = 'REWIND-SENTINELLE-91c2'; fakeOpts.markers.kept = 'Voici une photo et un PDF';
  const tapIn = async (sel) => { await phone.eval(`document.querySelector(${JSON.stringify(sel)}).scrollIntoView({ block: 'center' }); true`); await sleep(150); await tapSel(sel); };
  fakeOpts.replyDelayMs = 45000;
  const beforeLong = fakeApi.requests.length;
  await cdp.eval(`window.orchestra.agentSdkSend('ws-am-idle', ${JSON.stringify(LONG)}).then(() => true)`);
  await waitFor(() => fakeApi.requests.slice(beforeLong).some((r) => r.type === 'model' && (r.marks ?? []).includes('undone')) || false, 60000, 'the long turn reached the model');
  await waitFor(() => phone.eval(`!document.querySelector('#conv .conv-running').hidden`), 20000, 'the phone shows the turn running');
  await sleep(2000);
  const stillRunning = await phone.eval(`({ bar: !document.querySelector('#conv .conv-running').hidden, rw: document.querySelectorAll('#conv .msg-rw').length })`);
  saveShot('phone-interrupt-running.png', await phone.shot());
  const tStop = Date.now();
  await tapIn('#conv .conv-stop');
  const stopped = await waitFor(() => phone.eval(`document.querySelector('#conv .conv-running').hidden`), 20000, 'the bar gone after the stop').then(() => Date.now() - tStop, () => null);
  if (stopped === null) {
    const d = await phone.eval(`({ btn: document.querySelector('#conv .conv-stop').textContent, disabled: document.querySelector('#conv .conv-stop').disabled, msg: document.querySelector('#conv .conv-stop-msg').textContent })`);
    const desk = await cdp.eval(`(() => { const s = window.__readAgentSession('ws-am-idle'); return s ? { running: s.running, last: s.messages.slice(-3).map((m) => m.role + ':' + String(m.text ?? '').slice(0, 30)) } : null; })()`).catch((e) => String(e));
    console.log(`  diag control/interrupt: phone ${JSON.stringify(d)}; stand-in lines ${JSON.stringify(seenLines.filter((l) => String(l).includes('interrupt')))}; desktop ${JSON.stringify(desk)}; store ${JSON.parse(fs.readFileSync(path.join(storeDir, 'store.json'), 'utf8')).workspaces.find((w) => w.id === 'ws-am-idle').status}`);
    await waitFor(() => phone.eval(`document.querySelector('#conv .conv-running').hidden`), 60000, 'the slow turn over by itself').catch(() => null);
  }
  fakeOpts.replyDelayMs = 0;
  const deskStatus = await cdp.eval(`(window.__orchestraGetState?.().workspaces || []).find((w) => w.id === 'ws-am-idle')?.status ?? 'n/a'`).catch(() => 'n/a');
  const longReply = await phone.eval(`[...document.querySelectorAll('#conv .conv-lines [data-kind="assistant"]')].filter((e) => e.textContent.includes(${JSON.stringify(FAKE_REPLY)})).length`);
  clause('control/interrupt-from-phone', stillRunning.bar && stillRunning.rw === 0 && stopped !== null && stopped < 15000 && deskStatus !== 'running' && longReply === 3, `running 2 s with the bar shown (no ↺ mid-turn: ${stillRunning.rw}); trusted ■ ⇒ turn over in ${stopped} ms (the fake model holds its answer 45 s); desktop status ${deskStatus}; replies still 3 (${longReply})`);
  // rewind the stopped turn
  const longRw = await phone.eval(`(() => { const u = [...document.querySelectorAll('#conv .conv-lines [data-kind="user"]')].find((e) => e.textContent === ${JSON.stringify(LONG)}); let n = u && u.nextElementSibling; return n && n.classList.contains('msg-rw') ? n.dataset.rewind : null; })()`);
  await tapIn(`#conv .msg-rw[data-rewind="${longRw}"]`);
  await waitFor(() => phone.eval(`!!document.querySelector('#conv .rw-pop') && document.querySelector('#conv .rw-files').textContent !== 'Vérification des fichiers…'`), 30000, 'the rewind confirmation with its files preview');
  const pop = await phone.eval(`({ files: document.querySelector('#conv .rw-files').textContent, err: (document.querySelector('#conv .rw-err') || {}).textContent || '' })`);
  saveShot('phone-rewind-confirm.png', await phone.shot());
  await tapIn('#conv .rw-go');
  await waitFor(() => phone.eval(`!document.querySelector('#conv .rw-pop') && document.querySelector('#conv .rw-note').textContent !== ''`), 60000, 'the rewind done on the phone');
  await waitFor(() => phone.eval(`![...document.querySelectorAll('#conv .conv-lines [data-kind="user"]')].some((e) => e.textContent === ${JSON.stringify(LONG)})`), 20000, 'the undone turn gone from the phone').catch(() => null);
  const RW = await phone.eval(`({ input: document.querySelector('.conv-input').value, note: document.querySelector('#conv .rw-note').textContent, users: [...document.querySelectorAll('#conv .conv-lines [data-kind="user"]')].map((e) => e.textContent.slice(0, 40)) })`);
  const deskUsers = await cdp.eval(`(window.__readAgentSession('ws-am-idle')?.messages ?? []).filter((m) => m.role === 'user').map((m) => String(m.text ?? '').slice(0, 40))`);
  saveShot('phone-rewind-done.png', await phone.shot());
  clause('control/rewind-from-phone', !!longRw && RW.input === LONG && !RW.users.some((u) => u.startsWith('Tour long')) && RW.users.at(-1)?.startsWith('Voici une photo') && !deskUsers.some((u) => u.startsWith('Tour long')) && deskUsers.at(-1)?.startsWith('Voici une photo'), `↺ on « ${LONG.slice(0, 20)}… » (${longRw}); preview « ${pop.files} »${pop.err ? ' err ' + pop.err : ''}; field ⇒ « ${RW.input.slice(0, 30)} »; note « ${RW.note} »; phone users ${JSON.stringify(RW.users)}; desktop users ${JSON.stringify(deskUsers)}`);
  // the model's side: the next turn is resumed at the cut — the undone prompt is NOT in it, the turn before it IS
  await phone.eval(`(() => { const t = document.querySelector('.conv-input'); t.value = ''; t.dispatchEvent(new Event('input')); t.focus(); return true; })()`);
  await phone.send('Input.insertText', { text: 'Après le retour en arrière' });
  const beforeAfter = fakeApi.requests.length;
  await tapIn('.conv-send');
  const RA = await waitFor(() => fakeApi.requests.slice(beforeAfter).find((r) => r.type === 'model' && r.tools > 0) || false, 60000, 'the model request after the rewind');
  await waitFor(() => phone.eval(`[...document.querySelectorAll('#conv .conv-lines [data-kind="assistant"]')].filter((e) => e.textContent.includes(${JSON.stringify(FAKE_REPLY)})).length >= 4`), 60000, 'the reply after the rewind');
  clause('control/rewind-reaches-the-model', !RA.marks.includes('undone') && RA.marks.includes('kept'), `model request #${RA.seq} after the rewind: marks ${JSON.stringify(RA.marks)} (undone sentinel absent, the previous turn present), ${RA.messages} messages`);
  delete fakeOpts.markers.undone; delete fakeOpts.markers.kept;

  // #339 round 1 — the real CLI parks an AskUserQuestion; the PHONE answers it; the card leaves both surfaces; a 2nd answer is refused.
  wantAsk = 1;
  await cdp.eval(`window.orchestra.agentSdkSend('ws-am-idle', 'Pose-moi une question').then(() => true)`);
  await waitFor(() => phone.eval(`document.querySelectorAll('#conv .ask[data-kind="askUser"] .ask-opt').length === 2`), 90000, 'the question on the phone');
  const deskPending1 = await cdp.eval(`(window.__readAgentSession('ws-am-idle')?.pendingAnswerables ?? []).map((a) => a.requestId)`);
  const reqId1 = deskPending1[0];
  // a folded worker that waits on the human is NOT hidden by its fold: it surfaces in « En attente » (the list behind the open conv)
  const W = await waitFor(() => phone.eval(`(() => { const r = document.querySelector('#list li.waiting[data-id="ws-am-idle"]'); const h = r && r.closest('ul') && r.closest('ul').previousElementSibling; return r && h && h.dataset.group === 'En attente' ? { pv: (r.querySelector('.pv') || {}).textContent, me: document.getElementById('cntMe').textContent, title: (r.querySelector('.r1 b') || {}).textContent, repo: (r.querySelector('.r2 .repo') || {}).textContent } : false; })()`), 20000, 'am-idle in En attente').catch(() => null);
  clause('phone/folded-worker-waiting-surfaces', W && /Quelle option pour le rig/.test(W.pv || '') && W.me === '1', `am-idle (folded under am-coord) ⇒ En attente ${JSON.stringify(W)}`);
  // #373: am-idle is now en attente AND an ancestor (am-kid): lifted to En attente (once), a stand-in at its place keeps am-kid reachable.
  // Its conversation is open (the list underneath is hidden): drive the list's folds with JS clicks and read the DOM, not pixels.
  const jsTap = (sel) => phone.eval(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return false; e.click(); return true; })()`);
  await jsTap('li.fold[data-fold="ws-am-coord"]');
  const ST = await phone.eval(`(() => { const st = document.querySelector('li.fold-owner.stand'); return { stand: st ? st.textContent : null, idleRows: document.querySelectorAll('li[data-id="ws-am-idle"]').length, kidFold: !!document.querySelector('li.fold[data-fold="ws-am-idle"]'), coordFold: (document.querySelector('li.fold[data-fold="ws-am-coord"] .fold-n') || {}).textContent }; })()`);
  await jsTap('li.fold[data-fold="ws-am-idle"]');
  const ST2 = await phone.eval(`(() => { const k = document.querySelector('li[data-id="ws-am-kid"]'); return k ? { depth: k.dataset.depth } : null; })()`);
  clause('phone/tree-waiting-ancestor-stand-in', ST.stand === 'am-idle (en attente, plus haut)' && ST.idleRows === 1 && ST.kidFold && ST.coordFold === '5 agents' && ST2?.depth === '2', `stand-in « ${ST.stand} », am-idle rows ${ST.idleRows} (En attente only), its fold ${ST.kidFold}, am-coord fold « ${ST.coordFold} » (am-idle not counted), am-kid ${JSON.stringify(ST2)}`);
  await jsTap('li.fold[data-fold="ws-am-idle"]'); await jsTap('li.fold[data-fold="ws-am-coord"]');
  clause('phone/waiting-row-keeps-repo-chip', W && W.title === 'am-idle' && W.repo === 'orchestra-rig', `En attente row: title « ${W?.title} » (no prefix), repo chip « ${W?.repo} » (the registered repo name, kept)`);
  const optB = await phone.eval(`(() => { const b = [...document.querySelectorAll('#conv .ask-opt')].find((x) => x.dataset.label === 'Réponse-rig-B'); const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  for (const [type, extra] of [['mousePressed', { button: 'left', clickCount: 1 }], ['mouseReleased', { button: 'left', clickCount: 1 }]]) await phone.send('Input.dispatchMouseEvent', { type, x: optB.x, y: optB.y, ...extra });
  await waitFor(() => phone.eval(`!!document.querySelector('#conv .ask-opt.picked') && !document.querySelector('#conv .ask-submit').disabled`), 5000, 'option picked, submit enabled');
  saveShot('phone-ask-picked.png', await phone.shot());
  const sub = await phone.eval(`(() => { const r = document.querySelector('#conv .ask-submit').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  for (const [type, extra] of [['mousePressed', { button: 'left', clickCount: 1 }], ['mouseReleased', { button: 'left', clickCount: 1 }]]) await phone.send('Input.dispatchMouseEvent', { type, x: sub.x, y: sub.y, ...extra });
  await waitFor(() => phone.eval(`document.querySelectorAll('#conv .ask[data-kind="askUser"]').length === 0`), 30000, 'the question gone from the phone');
  await waitFor(() => cdp.eval(`(window.__readAgentSession('ws-am-idle')?.pendingAnswerables ?? []).length === 0`), 15000, 'the card gone from the desktop');
  const toolRes = await waitFor(() => cdp.eval(`(() => { const m = (window.__readAgentSession('ws-am-idle')?.messages ?? []).filter((x) => x.toolUse?.name === 'AskUserQuestion').at(-1); const c = m?.toolResult?.content; return c ? (typeof c === 'string' ? c : JSON.stringify(c)) : null; })()`), 30000, 'the AskUserQuestion tool result');
  clause('ask/phone-answers', deskPending1.length === 1 && /Réponse-rig-B/.test(toolRes) && !/Réponse-rig-A"/.test(toolRes), `desktop card ${deskPending1.length} -> 0; phone card gone; the CLI's tool result: ${toolRes.slice(0, 140)}`);
  const again = await phone.eval(`fetch('/api/answer?id=ws-am-idle&request=' + encodeURIComponent(${JSON.stringify(reqId1)}), { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + localStorage.getItem('orchestra.accesMobile.token') }, body: JSON.stringify({ answers: { 'Quelle option pour le rig ?': ['Réponse-rig-A'] } }) }).then((r) => r.json())`);
  clause('ask/second-answer-refused', again.ok === false && /already answered/.test(again.error), JSON.stringify(again));
  saveShot('phone-ask-answered.png', await phone.shot());

  // #339 round 2 — the DESKTOP answers (its real IPC); the phone's card goes away without a reload.
  wantAsk = 1;
  await cdp.eval(`window.orchestra.agentSdkSend('ws-am-idle', 'Encore une question').then(() => true)`);
  await waitFor(() => phone.eval(`document.querySelectorAll('#conv .ask[data-kind="askUser"]').length === 1`), 90000, 'the second question on the phone');
  const p2 = await cdp.eval(`(window.__readAgentSession('ws-am-idle')?.pendingAnswerables ?? []).map((a) => ({ requestId: a.requestId, input: a.input }))`);
  await cdp.eval(`window.orchestra.agentSdkPermissionReply('ws-am-idle', ${JSON.stringify(p2[0].requestId)}, { behavior: 'allow', updatedInput: { ...${JSON.stringify(p2[0].input)}, answers: { 'Quelle option pour le rig ?': 'Réponse-rig-A' } } }).then(() => true)`);
  await waitFor(() => phone.eval(`document.querySelectorAll('#conv .ask[data-kind="askUser"]').length === 0`), 30000, 'the second question gone from the phone');
  clause('ask/desktop-answers', p2.length === 1 && (await phone.eval(`window.__noReload === 1`)), `desktop answered ${p2[0]?.requestId}; phone card 1 -> 0 without reload`);
  await phone.eval(`location.hash = ''; true`);

  // ───────────── wave I #375/#376: launch a workspace from the phone ─────────────
  // The two default kinds must DIFFER, or a launch that took the spawned-agent kind could not be told apart from the right one.
  await cdp.eval(`window.orchestra.setModelDefaults({ workspace: 'claude-sonnet-4-5', spawned: 'claude-haiku-4-5' }).then(() => window.orchestra.setEffortDefaults({ workspace: 'high', spawned: 'low' })).then(() => true)`);
  const JSONB = { ...BEARER, 'Content-Type': 'application/json' };
  const repoPathA = world.repos[0].path, repoPathB = world.repos[1].path;
  const wsList = () => cdp.eval(`window.orchestra.listWorkspaces().then((l) => l.map((w) => ({ id: w.id, name: w.name, repoPath: w.repoPath, branch: w.branch, accountId: w.accountId, model: w.model, sdkEffort: w.sdkEffort, parentId: w.parentId, kind: w.kind, archived: !!w.archived, lastTask: w.lastTask, status: w.status })))`);
  const worktreesOf = (repo) => sh('git', ['-C', repo, 'worktree', 'list', '--porcelain'], { env: { PATH: process.env.PATH, HOME: world.fakeHome } }).split('\n').filter((l) => l.startsWith('worktree ')).length;
  const lbody = (extra = {}) => JSON.stringify({ repoPath: repoPathA, prompt: `${LAUNCH_SENTINEL} fais le travail`, requestId: crypto.randomUUID(), ...extra });
  const wsBefore = await wsList(), wtBeforeA = worktreesOf(repoPathA), wtBeforeB = worktreesOf(repoPathB);
  const unchanged = async () => { const l = await wsList(); return l.length === wsBefore.length && worktreesOf(repoPathA) === wtBeforeA && worktreesOf(repoPathB) === wtBeforeB; };

  const reposRes = await proxyGet(ownerProxy.port, '/api/repos', BEARER);
  const reposJ = reposRes.status === 200 ? JSON.parse(reposRes.body) : { repos: [] };
  clause('launch/repos-list', reposJ.ok === true && reposJ.repos.length === 2 && reposJ.repos.some((r) => r.path === repoPathA && r.name === 'orchestra-rig' && r.account === 'mc') && reposJ.repos.some((r) => r.path === repoPathB && r.name === 'perso-rig' && r.account === 'perso'), `/api/repos through serve: ${JSON.stringify(reposJ.repos)}`);
  for (const [name, fn, want] of [
    ['launch/sec/no-identity', () => reqPost(SOCK, '/api/launch', { ...BEARER, 'Content-Type': 'application/json' }, lbody()), 403],
    ['launch/sec/colleague-with-token', () => proxyPost(colleagueProxy.port, '/api/launch', JSONB, lbody()), 403],
    ['launch/sec/colleague-forges-owner-header', () => proxyPost(colleagueProxy.port, '/api/launch', { ...JSONB, 'Tailscale-User-Login': LOGIN }, lbody()), 403],
    ['launch/sec/tagged-device-forges-owner-header', () => proxyPost(taggedProxy.port, '/api/launch', { ...JSONB, 'Tailscale-User-Login': LOGIN }, lbody()), 403],
    ['launch/sec/no-token', () => proxyPost(ownerProxy.port, '/api/launch', { 'Content-Type': 'application/json' }, lbody()), 401],
    ['launch/sec/bad-token', () => proxyPost(ownerProxy.port, '/api/launch', { Authorization: `Bearer ${'x'.repeat(43)}`, 'Content-Type': 'application/json' }, lbody()), 401],
    ['launch/sec/query-token', () => proxyPost(ownerProxy.port, `/api/launch?t=${TOKEN}`, { 'Content-Type': 'application/json' }, lbody()), 401],
    ['launch/sec/get-is-not-a-launch', () => proxyGet(ownerProxy.port, '/api/launch', BEARER), 404],
    ['launch/empty-prompt-refused', () => proxyPost(ownerProxy.port, '/api/launch', JSONB, lbody({ prompt: '   ' })), 400],
    ['launch/no-request-id-refused', () => proxyPost(ownerProxy.port, '/api/launch', JSONB, JSON.stringify({ repoPath: repoPathA, prompt: 'x' })), 400],
  ]) {
    const r = await fn();
    clause(name, r.status === want && !/"ok":true/.test(r.body), `status ${r.status} (want ${want}), body ${r.body.length} bytes`);
  }
  // #376: the 11th launch inside a minute ⇒ 429 and NOTHING is created. Run FIRST, in a burst, so ten launches really fall in ONE minute: launches
  // main refuses (/etc is no registered repo) still count — they are launches — and cost nothing. The window is then waited out (61 s) so the
  // real launches below are never capped by it: `launchRoom(n)` waits until the server's rolling minute has room for n more (a launch that was
  // answered 200 took a slot, a 429 / 400 did not), so the 10/min budget never depends on how fast the arms run. A 429 reads « bare »: no body.
  const okLaunches = () => seenLines.filter((l) => l.url.startsWith('/api/launch') && l.status === 200).length;
  const launchRoom = async (n) => { while (seenLines.filter((l) => l.url.startsWith('/api/launch') && l.method === 'POST' && l.status === 200 && Date.now() - l.at < 60_000).length + n > 10) await sleep(1000); };
  const burst = async () => {
    const n0 = okLaunches(); let cap = null, tries = 0;
    while (cap === null && tries++ < 15) {
      const r = await proxyPost(ownerProxy.port, '/api/launch', JSONB, lbody({ repoPath: '/etc' }));
      if (r.status === 429) cap = r; else if (r.status !== 200) throw new Error(`cap burst: unexpected ${r.status}`);
    }
    return { cap, admitted: okLaunches() - n0 };
  };
  const tBurst = Date.now();
  const b1 = await burst();
  const validAfterCap = await proxyPost(ownerProxy.port, '/api/launch', JSONB, lbody());
  clause('launch/eleventh-in-a-minute-429', b1.admitted === 10 && b1.cap?.status === 429 && b1.cap.body === '' && validAfterCap.status === 429 && (await unchanged()), `${b1.admitted} launches answered before the 429 (cap 10/min), 429 body ${b1.cap?.body.length} bytes; a VALID launch right after ⇒ ${validAfterCap.status}; workspaces ${wsBefore.length} -> ${(await wsList()).length}`);
  const readsStillOk = (await proxyGet(ownerProxy.port, '/api/workspaces', BEARER)).status;
  clause('launch/cap-does-not-block-reads', readsStillOk === 200, `/api/workspaces while launches are capped: ${readsStillOk}`);
  await sleep(Math.max(0, 61_000 - (Date.now() - tBurst)));
  clause('launch/cap-window-rolls', (await proxyPost(ownerProxy.port, '/api/launch', JSONB, lbody({ repoPath: '/etc' }))).status === 200, 'a minute later the next launch is admitted again (a rolling window, not a lock)');

  // must-FAIL: a REAL git repo that is NOT registered, and a system path — refused by main, nothing created anywhere
  const unreg = path.join(world.d, 'repo-unregistered'); fs.mkdirSync(unreg, { recursive: true }); mustBeScratch('seed', unreg);
  git(unreg, ['init', '-q', '-b', 'main'], world.fakeHome); fs.writeFileSync(path.join(unreg, 'README.md'), '#\n'); git(unreg, ['add', '.'], world.fakeHome); git(unreg, ['commit', '-q', '-m', 'seed'], world.fakeHome);
  const wtUnreg = worktreesOf(unreg);
  const refusedRepos = [];
  await launchRoom(2);
  for (const rp of [unreg, '/etc']) refusedRepos.push(JSON.parse((await proxyPost(ownerProxy.port, '/api/launch', JSONB, lbody({ repoPath: rp }))).body));
  clause('launch/unregistered-repo-refused', refusedRepos.every((r) => r.ok === false && r.code === 'unknown-repo') && worktreesOf(unreg) === wtUnreg && (await unchanged()), `real unregistered git repo + /etc ⇒ ${JSON.stringify(refusedRepos)}; worktrees of the unregistered repo ${wtUnreg} -> ${worktreesOf(unreg)}; store ${wsBefore.length} -> ${(await wsList()).length}`);
  clause('launch/refusals-create-nothing', await unchanged(), `${wsBefore.length} workspaces and ${wtBeforeA}+${wtBeforeB} worktrees before every refusal above, the same after`);

  // the REAL launch: the repo's Compte, the WORKSPACE default model + effort, top-level, a generated branch; the prompt reaches the CLI
  const R1 = crypto.randomUUID(), PROMPT1 = `${LAUNCH_SENTINEL} corrige la faute dans le titre`;
  const modelsBeforeLaunch = fakeApi.requests.filter((r) => r.type === 'model').length;
  await launchRoom(1);
  const launched = await proxyPost(ownerProxy.port, '/api/launch', JSONB, JSON.stringify({ repoPath: repoPathA, prompt: PROMPT1, requestId: R1 }));
  const L1 = launched.status === 200 ? JSON.parse(launched.body) : { ok: false };
  const wsAfter = await wsList();
  const created = wsAfter.find((w) => w.id === L1.id);
  clause('launch/creates-workspace', launched.status === 200 && L1.ok === true && !!created && wsAfter.length === wsBefore.length + 1 && created.repoPath === repoPathA && !created.archived && created.parentId === undefined && created.kind === undefined && /^[a-z]+-[a-z]+$/.test(created.branch) && created.lastTask === PROMPT1, `status ${launched.status} ${launched.body.slice(0, 120)}; desktop store ${wsBefore.length} -> ${wsAfter.length}; ${JSON.stringify(created)}`);
  clause('launch/repos-compte-and-workspace-defaults', created?.accountId === 'acc-mc' && created?.model === 'claude-sonnet-4-5' && created?.sdkEffort === 'high', `accountId ${created?.accountId} (repo's: acc-mc), model ${created?.model} (workspace default claude-sonnet-4-5, spawned default claude-haiku-4-5), effort ${created?.sdkEffort} (workspace high, spawned low)`);
  const promptReq = fakeApi.requests.filter((r) => r.type === 'model').slice(modelsBeforeLaunch).find((r) => (r.marks || []).includes('launch'));
  const deskSeen = await waitFor(() => cdp.eval(`(() => { const m = (window.__readAgentSession(${JSON.stringify(L1.id)})?.messages ?? []).find((x) => x.role === 'user' && String(x.text ?? '').includes(${JSON.stringify(LAUNCH_SENTINEL)})); return m ? m.text : null; })()`), 30000, 'the first prompt in the desktop conversation').catch(() => null);
  clause('launch/first-prompt-reaches-the-session', !!promptReq && promptReq.model === 'claude-sonnet-4-5' && !!deskSeen && deskSeen.includes('corrige la faute'), `fake API model request #${promptReq?.seq} carries the prompt, model ${promptReq?.model}; desktop user message « ${String(deskSeen).slice(0, 60)} »`);
  const phoneRows = JSON.parse((await proxyGet(ownerProxy.port, '/api/workspaces', BEARER)).body).workspaces;
  clause('launch/shown-on-the-phone-list', phoneRows.some((r) => r.id === L1.id && r.group === 'orchestra-rig' && r.account === 'mc' && !r.parentId), `phone list row ${JSON.stringify(phoneRows.find((r) => r.id === L1.id))}`);

  // #376: a double submit (two POSTs, the same request id, sent together) = ONE workspace, both answers carry its id
  const R2 = crypto.randomUUID(), PROMPT2 = `${LAUNCH_SENTINEL} double tap`;
  await launchRoom(2);
  const dbl = await Promise.all([1, 2].map(() => proxyPost(ownerProxy.port, '/api/launch', JSONB, JSON.stringify({ repoPath: repoPathA, prompt: PROMPT2, requestId: R2 }))));
  const [DB1, DB2] = dbl.map((r) => (r.status === 200 ? JSON.parse(r.body) : { ok: false, status: r.status }));
  const dupes = (await wsList()).filter((w) => w.lastTask === PROMPT2);
  clause('launch/double-submit-one-workspace', DB1.ok === true && DB2.ok === true && DB1.id === DB2.id && dupes.length === 1 && dupes[0].id === DB1.id && dupes[0].accountId === 'acc-mc', `two POSTs, one request id ⇒ ${JSON.stringify([DB1, DB2])}; workspaces with that prompt: ${dupes.length}`);
  const R3 = crypto.randomUUID(), PROMPT3 = `${LAUNCH_SENTINEL} second request id`;
  await launchRoom(2);
  const two = [await proxyPost(ownerProxy.port, '/api/launch', JSONB, JSON.stringify({ repoPath: repoPathA, prompt: PROMPT3, requestId: R3 })), await proxyPost(ownerProxy.port, '/api/launch', JSONB, JSON.stringify({ repoPath: repoPathA, prompt: PROMPT3, requestId: crypto.randomUUID() }))].map((r) => JSON.parse(r.body));
  clause('launch/distinct-request-ids-distinct-workspaces', two[0].ok && two[1].ok && two[0].id !== two[1].id && (await wsList()).filter((w) => w.lastTask === PROMPT3).length === 2, `control for the double-submit arm: two request ids ⇒ ${JSON.stringify(two.map((t) => t.id))}`);

  // the hooks socket (every local agent can reach it) has NO launch / repos route: forged calls create nothing
  {
    const mainSock2 = fs.readFileSync(path.join(world.ohome, 'sock'), 'utf8').trim();
    const nWs = (await wsList()).length;
    const forgedOnHooks = [];
    for (const route of ['/mobile/launch', '/mobile/repos']) forgedOnHooks.push(await reqPost(mainSock2, route, { 'Content-Type': 'application/json' }, JSON.stringify({ repoPath: repoPathA, prompt: 'forged launch from a local agent', requestId: crypto.randomUUID() })));
    await sleep(1500);
    clause('launch/hooks-socket-has-no-launch-route', forgedOnHooks.every((r) => r.body === '{}') && (await wsList()).length === nWs && !(await wsList()).some((w) => w.lastTask === 'forged launch from a local agent'), `hooks /mobile/launch + /mobile/repos answered ${forgedOnHooks.map((r) => r.body)}; workspaces ${nWs} -> ${(await wsList()).length}`);
  }

  // A SLOW first turn (verifier MAJOR on 7377c71e, 0/3): the launch returns at the session's first output, so the answer is over when the phone opens
  // and the CLI has flushed the user line only. The phone must still end on user + answer — no event follows to tell the feed.
  {
    fakeOpts.replyDelayMs = 8000;
    const SLOW_PROMPT = `${LAUNCH_SENTINEL} première réponse lente (8 s)`;
    let slowLaunch;
    await launchRoom(1);
    try { slowLaunch = await proxyPost(ownerProxy.port, '/api/launch', JSONB, JSON.stringify({ repoPath: repoPathA, prompt: SLOW_PROMPT, requestId: crypto.randomUUID() })); } finally { fakeOpts.replyDelayMs = 0; }
    const SL = slowLaunch.status === 200 ? JSON.parse(slowLaunch.body) : { ok: false };
    await phone.eval(`location.hash = 'w=' + ${JSON.stringify(SL.id)}; true`);
    const convKinds = () => phone.eval(`[...document.querySelectorAll('#conv .conv-lines [data-kind]')].map((e) => e.dataset.kind)`);
    let kinds = [], shownAfter = null;
    const tSlow = Date.now();
    while (Date.now() - tSlow < 25000) { kinds = await convKinds(); if (kinds.includes('user') && kinds.includes('assistant')) { shownAfter = Date.now() - tSlow; break; } await sleep(500); }
    const apiKinds = await (async () => { try { return JSON.parse((await proxyGet(ownerProxy.port, '/api/conversation?id=' + encodeURIComponent(SL.id), BEARER)).body).lines.map((l) => l.kind); } catch { return ['?']; } })();
    clause('launch/slow-first-turn-shows-the-prompt-and-the-answer', SL.ok === true && shownAfter !== null && apiKinds.includes('assistant'), `launch ok ${SL.ok}; the phone showed [${kinds}] ${shownAfter === null ? 'NEVER (25 s)' : shownAfter + ' ms after opening'}; /api/conversation lines [${apiKinds}]`);
    await phone.eval(`location.hash = ''; true`);
    await sleep(500);
  }

  // ── the phone's own screen (design A, ledger #377 D-Q1): « + » → #new → repo cards + prompt + « Lancer » → the conversation ──
  const phoneLaunchLines = () => seenLines.filter((l) => l.who === 'owner' && l.url === '/api/launch' && l.ua.includes('iPhone'));
  const PAGE_PROMPT = `${LAUNCH_SENTINEL} lancé depuis l’écran du téléphone`;
  await phone.eval(`location.hash = ''; true`);
  await waitFor(() => phone.eval(`!document.getElementById('home').hidden && !!document.getElementById('newBtn')`), 10000, 'the list with its « + »');
  const plus = await phone.eval(`(() => { const r = document.getElementById('newBtn').getBoundingClientRect(); return { w: r.width, h: r.height, right: r.right, top: r.top, vw: innerWidth, label: document.getElementById('newBtn').getAttribute('aria-label') }; })()`);
  clause('launch/phone-plus-in-the-header', plus.w >= 36 && plus.h >= 36 && plus.right <= plus.vw - 16 && plus.top >= 47 && plus.label === 'Nouveau workspace', `« + » ${plus.w}×${plus.h}px, right edge ${plus.right} of ${plus.vw}, below the status bar (top ${plus.top} ≥ 47), aria-label « ${plus.label} »`);
  saveShot('phone-launch-list-with-plus.png', await phone.shot());
  await phone.clickSel('#newBtn');
  await waitFor(() => phone.eval(`location.hash === '#new' && !document.getElementById('launch').hidden && document.querySelectorAll('#launch .nf-repo').length === 2`), 15000, 'the launch screen with its two repo cards');
  const F0 = await phone.eval(`({ listHidden: document.getElementById('home').hidden, go: document.querySelector('#launch .nf-go').disabled, cards: [...document.querySelectorAll('#launch .nf-repo')].map((b) => ({ path: b.dataset.path, text: b.textContent, acct: (b.querySelector('.acct') || {}).textContent })) })`);
  clause('launch/phone-form-lists-repos-with-compte', F0.listHidden === true && F0.go === true && F0.cards.some((c) => c.path === repoPathA && /orchestra-rig/.test(c.text) && c.acct === 'mc') && F0.cards.some((c) => c.path === repoPathB && /perso-rig/.test(c.text) && c.acct === 'perso'), `list hidden ${F0.listHidden}, « Lancer » disabled ${F0.go}; cards ${JSON.stringify(F0.cards.map((c) => [c.path.split('/').pop(), c.acct]))}`);
  saveShot('phone-launch-empty.png', await phone.shot());
  const typeIn = async (text) => { await phone.eval(`(() => { const t = document.querySelector('#launch .nf-task'); t.focus(); return true; })()`); await phone.send('Input.insertText', { text }); };
  const goState = () => phone.eval(`document.querySelector('#launch .nf-go').disabled`);
  const clearTask = (v = '') => phone.eval(`(() => { const t = document.querySelector('#launch .nf-task'); t.value = ${JSON.stringify(v)}; t.dispatchEvent(new Event('input')); return true; })()`);
  await typeIn('x');
  const dNoRepo = await goState();
  await clearTask('');
  await phone.clickSel(`#launch .nf-repo[data-path="${repoPathA}"]`);
  const dNoPrompt = await goState();
  await clearTask('   \n  ');
  const dBlank = await goState();
  await clearTask('');
  await typeIn(PAGE_PROMPT);
  const dReady = await goState();
  clause('launch/phone-prompt-and-repo-required', dNoRepo === true && dNoPrompt === true && dBlank === true && dReady === false, `« Lancer » disabled: prompt without repo ${dNoRepo}, repo without prompt ${dNoPrompt}, repo + blank prompt ${dBlank}; enabled with repo + prompt: ${!dReady}`);
  saveShot('phone-launch-filled.png', await phone.shot());
  // armed BEFORE « Lancer »: whatever the page throws or fails to fetch on the way to the conversation is kept for the dump below
  const pageEvents = [];
  phone.tap = (m) => {
    if (m.method === 'Runtime.exceptionThrown') pageEvents.push('exception ' + String(m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text).slice(0, 200));
    else if (m.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(m.params.type)) pageEvents.push(`console.${m.params.type} ` + m.params.args.map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 200));
    else if (m.method === 'Network.loadingFailed') pageEvents.push(`net-failed ${m.params.errorText} ${m.params.requestId}`);
  };
  await phone.send('Runtime.enable').catch(() => {}); await phone.send('Network.enable').catch(() => {});
  const modelsBeforePage = fakeApi.requests.filter((r) => r.type === 'model').length;
  const wsBeforePage = (await wsList()).length;
  await launchRoom(1);
  await phone.clickSel('#launch .nf-go');
  await waitFor(() => phone.eval(`/^#w=/.test(location.hash) && !document.getElementById('conv').hidden && document.getElementById('launch').hidden`), 90000, 'the conversation of the launched workspace');
  const pageId = (await phone.eval(`location.hash`)).slice(3);
  // a timeout here must say WHAT the phone, the server projection and the desktop fold each held — never a bare « timeout »
  const convDiag = async () => {
    const phoneLines = await phone.eval(`[...document.querySelectorAll('#conv .conv-lines [data-kind]')].map((e) => e.dataset.kind + ':' + e.textContent.slice(0, 50))`).catch((e) => `eval failed: ${e.message}`);
    const api = await proxyGet(ownerProxy.port, `/api/conversation?id=${pageId}`, BEARER).catch((e) => ({ status: 'fetch failed', body: String(e) }));
    let proj = api.body.slice(0, 200);
    try { const j = JSON.parse(api.body); proj = `v${j.version} running=${j.running} lines=${JSON.stringify((j.lines || []).map((l) => `${l.kind}:${String(l.text ?? l.label ?? '').slice(0, 40)}`))}`; } catch {}
    const desk = await cdp.eval(`(window.__readAgentSession(${JSON.stringify(pageId)})?.messages ?? []).map((m) => m.role + ':' + String(m.text ?? '').slice(0, 40))`).catch((e) => `eval failed: ${e.message}`);
    const wsNow = (await wsList()).find((w) => w.id === pageId);
    const res = await phone.eval(`performance.getEntriesByType('resource').filter((r) => /\\/api\\/(conversation|launch|seen|repos)/.test(r.name)).map((r) => r.name.replace(/^https?:\\/\\/[^/]+/, '') + ' ' + r.responseStatus + ' ' + Math.round(r.duration) + 'ms')`).catch((e) => `eval failed: ${e.message}`);
    const scr = await phone.eval(`({ hash: location.hash, conv: !document.getElementById('conv').hidden, state: (document.querySelector('#conv .conv-state') || {}).textContent, html: document.getElementById('conv').innerHTML.slice(0, 260) })`).catch((e) => `eval failed: ${e.message}`);
    return `phone resources ${JSON.stringify(res)}; phone screen ${JSON.stringify(scr)}; page events ${JSON.stringify(pageEvents.slice(-8))}; phone DOM ${JSON.stringify(phoneLines)}; /api/conversation ${api.status} ${proj}; desktop fold ${JSON.stringify(desk)}; store status ${wsNow?.status}`;
  };
  const waitOrDiag = (fn, ms, what) => waitFor(fn, ms, what).catch(async (e) => { throw new Error(`${e.message} — ${await convDiag()}`); });
  await waitOrDiag(() => phone.eval(`[...document.querySelectorAll('#conv .conv-lines [data-kind="user"]')].some((e) => e.textContent.includes(${JSON.stringify(LAUNCH_SENTINEL)}))`), 60000, 'the launch prompt as the first user line');
  await waitOrDiag(() => phone.eval(`[...document.querySelectorAll('#conv .conv-lines [data-kind="assistant"]')].some((e) => e.textContent.includes(${JSON.stringify(FAKE_REPLY)}))`), 60000, 'the agent\'s reply');
  const C0 = await phone.eval(`({ title: document.querySelector('#conv .conv-title').textContent, sub: document.querySelector('#conv .cs').textContent, user: [...document.querySelectorAll('#conv .conv-lines [data-kind="user"]')].map((e) => e.textContent)[0] })`);
  const wsPage = (await wsList()).find((w) => w.id === pageId);
  clause('launch/phone-launch-opens-the-conversation', !!wsPage && (await wsList()).length === wsBeforePage + 1 && wsPage.lastTask === PAGE_PROMPT && wsPage.accountId === 'acc-mc' && C0.user.includes('lancé depuis l’écran du téléphone') && C0.title === wsPage.branch && /orchestra-rig/.test(C0.sub) && fakeApi.requests.filter((r) => r.type === 'model').slice(modelsBeforePage).some((r) => (r.marks || []).includes('launch')), `tapped « Lancer » ⇒ #w=${pageId.slice(0, 8)}…, header « ${C0.title} » / « ${C0.sub} », first user line « ${String(C0.user).slice(0, 50)} », desktop store +1 (${wsPage?.branch}), the fake API saw the prompt`);
  saveShot('phone-launch-conversation.png', await phone.shot());

  // a double tap on « Lancer » (two trusted taps in the same breath) = ONE request, ONE workspace
  const DBL_PROMPT = `${LAUNCH_SENTINEL} double tap sur le téléphone`;
  await phone.eval(`location.hash = 'new'; true`);
  await waitFor(() => phone.eval(`!document.getElementById('launch').hidden && document.querySelectorAll('#launch .nf-repo').length === 2`), 15000, 'the launch screen again');
  const afterLaunchState = await phone.eval(`({ task: document.querySelector('#launch .nf-task').value, sel: document.querySelectorAll('#launch .nf-repo.sel').length })`);
  await phone.clickSel(`#launch .nf-repo[data-path="${repoPathA}"]`);
  await typeIn(DBL_PROMPT);
  const reqsBeforeDbl = phoneLaunchLines().length;
  await launchRoom(1);
  const goPos = await phone.eval(`(() => { const r = document.querySelector('#launch .nf-go').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  for (let k = 0; k < 2; k++) for (const [type, extra] of [['mousePressed', { button: 'left', clickCount: 1 }], ['mouseReleased', { button: 'left', clickCount: 1 }]]) await phone.send('Input.dispatchMouseEvent', { type, x: goPos.x, y: goPos.y, ...extra });
  await waitFor(() => phone.eval(`/^#w=/.test(location.hash) && !document.getElementById('conv').hidden`), 90000, 'the conversation after the double tap');
  const dblWs = (await wsList()).filter((w) => w.lastTask === DBL_PROMPT);
  clause('launch/phone-double-tap-one-workspace', afterLaunchState.task === '' && afterLaunchState.sel === 1 && phoneLaunchLines().length === reqsBeforeDbl + 1 && dblWs.length === 1 && dblWs[0].accountId === 'acc-mc', `two taps ⇒ ${phoneLaunchLines().length - reqsBeforeDbl} request(s) from the phone, ${dblWs.length} workspace(s) with that prompt; a fresh form after the first launch (draft « ${afterLaunchState.task} », ${afterLaunchState.sel} repo picked)`);
  await phone.eval(`location.hash = ''; true`);


  // the phone says it plainly when the cap is hit: fill the minute (fast refused launches), then tap « Lancer » for real
  await sleep(62_000); // verifier: an EMPTY window first, so the ten admitted launches are all < 2 s old when « Lancer » is tapped (no slot can age out in between)
  const b2 = await burst();
  const wsBeforeCap2 = (await wsList()).length;
  await phone.eval(`location.hash = 'new'; true`);
  await waitFor(() => phone.eval(`!document.getElementById('launch').hidden && document.querySelectorAll('#launch .nf-repo').length === 2`), 15000, 'the launch screen for the 429 arm');
  await phone.clickSel(`#launch .nf-repo[data-path="${repoPathA}"]`);
  await typeIn('un lancement de trop');
  await phone.clickSel('#launch .nf-go');
  const E429 = await waitFor(() => phone.eval(`(() => { const e = document.querySelector('#launch .nf-err'); return e && !e.hidden ? { text: e.textContent, hash: location.hash, draft: document.querySelector('#launch .nf-task').value, state: document.getElementById('launch').dataset.state, goDisabled: document.querySelector('#launch .nf-go').disabled } : null; })()`), 30000, 'the 429 message on the launch screen');
  clause('launch/phone-429-says-so', b2.cap?.status === 429 && /10 par minute.*Aucun workspace n’a été créé/.test(E429.text) && E429.hash === '#new' && E429.draft === 'un lancement de trop' && E429.state === 'error' && E429.goDisabled === false && (await wsList()).length === wsBeforeCap2, `cap reached after ${b2.admitted} more launches; the phone shows « ${E429.text} »; still on #new with the draft kept, the button back; workspaces ${wsBeforeCap2} -> ${(await wsList()).length}`);
  saveShot('phone-launch-429.png', await phone.shot());
  await phone.eval(`location.hash = ''; true`);
  await cdp.eval(`window.orchestra.setModelDefaults({ workspace: 'claude-opus-4-8', spawned: 'claude-opus-4-8' }).then(() => window.orchestra.setEffortDefaults({ workspace: 'default', spawned: 'default' })).then(() => true)`);

  // settings dialog in the app: health, serve command; TRUSTED toggle off/on
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: 895 });
  const preDlg = await cdp.eval(`!!document.querySelector('.acces-mobile-settings')`);
  await cdp.clickSel('[data-am-open]');
  await waitFor(() => cdp.eval(`(document.querySelector('[data-am-health]')||{}).dataset?.amHealth === 'listening'`), 15000, 'dialog health listening');
  const D = await cdp.eval(`(() => { const d = document.querySelector('.acces-mobile-settings'); const r = d.getBoundingClientRect(); return { health: d.querySelector('[data-am-health]').textContent, cmd: d.querySelector('[data-am-serve-cmd]').textContent, login: d.querySelector('[data-am-login]').value, inView: r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight }; })()`);
  clause('settings/dialog', !preDlg && D.inView && /private local socket/.test(D.health) && D.cmd === `sudo tailscale serve --bg --https=${SERVE_PORT} unix:${SOCK}` && D.login === LOGIN, `dialog false->true, in viewport ${D.inView}; "${D.health}"; "${D.cmd}"`);
  saveShot('settings-on.png', await cdp.shot());
  const pidOn = serverPids(TOKEN_FILE)[0];
  await cdp.clickSel('[data-am-toggle]');
  await waitFor(() => cdp.eval(`document.querySelector('[data-am-health]').dataset.amHealth === 'off'`), 15000, 'health off');
  await waitFor(async () => !fs.existsSync(SOCK) && serverPids(TOKEN_FILE).length === 0, 15000, 'socket removed + process gone');
  const storedOff = JSON.parse(fs.readFileSync(path.join(storeDir, 'store.json'), 'utf8')).accesMobile;
  clause('settings/toggle-off', storedOff.enabled === false, `listening(pid ${pidOn}) -> off: socket removed, no server process, store.accesMobile.enabled=${storedOff.enabled}`);
  saveShot('settings-off.png', await cdp.shot());
  const phoneOff = await phone.eval(`fetch('/api/workspaces', { headers: { Authorization: 'Bearer ' + localStorage.getItem('orchestra.accesMobile.token') } }).then((r) => 'status ' + r.status, () => 'network error')`);
  clause('settings/phone-sees-off', phoneOff === 'status 502', `phone fetch while off (serve stand-in, nothing behind it): ${phoneOff}`);
  await cdp.clickSel('[data-am-toggle]');
  await waitFor(() => cdp.eval(`document.querySelector('[data-am-health]').dataset.amHealth === 'listening'`), 20000, 'health listening again');
  const pidOn2 = serverPids(TOKEN_FILE)[0];
  await waitFor(() => sockConnects(SOCK), 15000, 'socket back');
  clause('settings/toggle-on-again', pidOn2 && pidOn2 !== pidOn && (await req(SOCK, '/api/workspaces', AUTH)).status === 200, `off -> listening, new pid ${pidOn2}`);

  // perf: Accès mobile ON, the phone polling every 5 s, dialog closed — main and server CPU over 30 s (/proc utime+stime delta)
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape' }).catch(() => {});
  const ticks = (pid) => { const f = fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' '); return Number(f[11]) + Number(f[12]); };
  const HZ = 100;
  const t0 = { main: ticks(app.pid), srv: ticks(pidOn2), at: Date.now() };
  await sleep(30000);
  const secs = (Date.now() - t0.at) / 1000;
  const mainPct = ((ticks(app.pid) - t0.main) / HZ / secs) * 100, srvPct = ((ticks(pidOn2) - t0.srv) / HZ / secs) * 100;
  const polled = await phone.eval(`document.querySelectorAll('li[data-id]').length`);
  const launchedRows = (await wsList()).length - wsBefore.length; // the launch/* arms above made these workspaces: the phone lists them too
  clause('perf/idle-cpu', mainPct < 10 && srvPct < 5 && polled === 3 + launchedRows, `over ${secs.toFixed(0)} s with the phone streaming + polling: main ${mainPct.toFixed(1)}% CPU, server ${srvPct.toFixed(2)}% CPU (phone lists ${polled}: 3 seeded + ${launchedRows} launched)`);

  // Archive from the phone (Lucas 2026-10-20 « archiver un workspace depuis mon iPhone »): am-sub (am-deep › am-deeper under it) is SHOWN
  // on the desktop; a TRUSTED « Archiver » then « Archiver » on the phone archives the three like the sidebar does, the phone is back on
  // its list without them, the desktop moves off the archived pane, the worktree dirs stay. Must-FAIL: an already archived id is refused.
  {
    // Lucas 2026-10-21: the confirmation must show where the human IS — a long conversation opens scrolled to its end, and the
    // panel drawn in the page flow under the header was off-screen at the top. am-unread = the 120-line history; then « Annuler ».
    await phone.eval(`location.hash = 'w=ws-am-unread'; true`);
    await waitFor(() => phone.eval(`document.querySelectorAll('#conv .conv-lines [data-kind]').length > 100`), 20000, 'the long conversation');
    await sleep(600);
    const atEnd = await phone.eval(`(() => { const se = document.scrollingElement; return se.scrollTop > 0 && se.scrollTop + innerHeight >= se.scrollHeight - 4; })()`);
    await tapSel('#conv .conv-archive');
    await waitFor(() => phone.eval(`!!document.querySelector('#conv .ar-pop')`), 5000, 'the archive confirmation');
    await sleep(300);
    const VP = await phone.eval(`(() => { const r = document.querySelector('#conv .ar-pop').getBoundingClientRect(), g = document.querySelector('#conv .ar-go').getBoundingClientRect(); const hit = document.elementFromPoint(g.left + g.width / 2, g.top + g.height / 2); return { top: Math.round(r.top), bottom: Math.round(r.bottom), vh: innerHeight, goHit: !!hit && hit.closest('.ar-go') !== null }; })()`);
    saveShot('phone-archive-confirm-long.png', await phone.shot());
    await tapSel('#conv .ar-cancel');
    const closed = await waitFor(() => phone.eval(`!document.querySelector('#conv .ar-pop')`), 5000, 'closed').then(() => true, () => false);
    const stillLive = (await wsList()).find((w) => w.id === 'ws-am-unread')?.archived === false;
    clause('archive/confirm-visible-in-a-long-conversation', atEnd && VP.top >= 0 && VP.bottom <= VP.vh && VP.goHit && closed && stillLive, `opened at the end ${atEnd}; tap « Archiver » ⇒ panel y ${VP.top}…${VP.bottom} in a ${VP.vh} px viewport, its « Archiver » hittable ${VP.goHit}; « Annuler » closed it ${closed}, am-unread still live ${stillLive}`);

    const SUB = ['ws-am-sub', 'ws-am-deep', 'ws-am-deeper'];
    const subDir = (await wsList()).find((w) => w.id === 'ws-am-sub') && JSON.parse(fs.readFileSync(path.join(storeDir, 'store.json'), 'utf8')).workspaces.find((w) => w.id === 'ws-am-sub').worktreePath;
    // the desktop's pane, read from what it RENDERS (the build exposes no store getter): the header's branch chip, or the Welcome screen
    const deskPane = `(() => { const t = document.querySelector('.main .toolbar .title'); return { title: t ? t.textContent : null, welcome: !!document.querySelector('.main > .empty h2') }; })()`;
    const sideRows = `[...document.querySelectorAll('aside.sidebar .ws-name')].filter((e) => /\\bam-(sub|deep|deeper)$/.test(e.textContent.trim())).length`;
    await cdp.eval(`window.__orchestraSetState({ activeId: 'ws-am-sub' }); true`);
    const deskBefore = await waitFor(async () => { const d = await cdp.eval(deskPane); return d.title === 'am-sub' ? d : null; }, 10000, 'the desktop showing am-sub').catch(() => null);
    const sideBefore = await cdp.eval(sideRows);
    await phone.eval(`location.hash = 'w=ws-am-sub'; true`);
    await waitFor(() => phone.eval(`!!document.querySelector('#conv .conv-archive') && !document.getElementById('conv').hidden`), 15000, 'am-sub conversation on the phone');
    await tapSel('#conv .conv-archive');
    await waitFor(() => phone.eval(`!!document.querySelector('#conv .ar-pop')`), 5000, 'the archive confirmation');
    const AC = await phone.eval(`({ state: document.querySelector('#conv .ar-pop').dataset.state, t: document.querySelector('#conv .ar-t').textContent, below: (document.querySelector('#conv .ar-below') || {}).textContent || '' })`);
    saveShot('phone-archive-confirm.png', await phone.shot());
    const storeAfterTap = JSON.parse(fs.readFileSync(path.join(storeDir, 'store.json'), 'utf8')).workspaces.filter((w) => SUB.includes(w.id) && w.archived).length;
    await tapSel('#conv .ar-go');
    await waitFor(() => phone.eval(`location.hash === '' && !document.getElementById('home').hidden`), 30000, 'back on the list after the archive');
    await waitFor(async () => (await wsList()).filter((w) => SUB.includes(w.id) && w.archived).length === 3, 15000, 'the three archived in main').catch(() => null);
    const main = (await wsList()).filter((w) => SUB.includes(w.id)).map((w) => `${w.id}:${w.archived}`);
    const listApi = JSON.parse((await req(SOCK, '/api/workspaces', AUTH)).body || '{}');
    const apiIds = (listApi.workspaces || []).map((w) => w.id);
    await waitFor(() => phone.eval(`document.querySelectorAll('li[data-id]').length >= 3`), 15000, 'the list redrawn').catch(() => null);
    for (const f of ['ws-am-coord']) await phone.eval(`(() => { const f = document.querySelector('li.fold[data-fold="${f}"]'); if (f && !f.textContent.startsWith('▾')) f.click(); return true; })()`);
    const PL = await phone.eval(`({ ids: [...document.querySelectorAll('li[data-id]')].map((l) => l.dataset.id), fold: (document.querySelector('li.fold[data-fold="ws-am-coord"]') || {}).textContent || '' })`);
    const deskAfter = await waitFor(async () => { const d = await cdp.eval(deskPane); return d.title !== 'am-sub' ? d : null; }, 10000, 'the desktop off am-sub').catch(() => null);
    const liveBranches = (await wsList()).filter((w) => !w.archived).map((w) => w.branch);
    const deskRowsLeft = await cdp.eval(sideRows);
    saveShot('phone-archive-done.png', await phone.shot());
    clause('archive/from-phone', !!deskBefore && AC.state === 'confirm' && AC.below === 'Les 2 agents sous lui sont archivés aussi.' && storeAfterTap === 0 && main.every((m) => m.endsWith(':true')) && main.length === 3 && !SUB.some((id) => apiIds.includes(id)) && !SUB.some((id) => PL.ids.includes(id)) && PL.ids.includes('ws-am-coord') && !!subDir && fs.existsSync(subDir), `confirm « ${AC.t} » / « ${AC.below} » (nothing archived before « Archiver »: ${storeAfterTap}); main ${main.join(' ')}; phone api lists none of them ${!SUB.some((id) => apiIds.includes(id))}; phone list ${PL.ids.join(',')} (coord fold « ${PL.fold} »); worktree kept ${!!subDir && fs.existsSync(subDir)}`);
    clause('archive/desktop-leaves-archived-pane', !!deskAfter && !deskAfter.welcome && !!deskAfter.title && liveBranches.some((b) => deskAfter.title.includes(b)) && !/am-(sub|deep)/.test(deskAfter.title) && sideBefore > 0 && deskRowsLeft === 0, `desktop pane ${JSON.stringify(deskBefore)} -> ${JSON.stringify(deskAfter)} (a live workspace's branch: ${liveBranches.find((b) => deskAfter?.title?.includes(b))}); sidebar rows named am-sub/am-deep/am-deeper ${sideBefore} -> ${deskRowsLeft}`);
    const again = JSON.parse((await reqPost(SOCK, '/api/archive?id=ws-am-sub', AUTH, '')).body || '{}');
    const unknown = JSON.parse((await reqPost(SOCK, '/api/archive?id=ws-nope', AUTH, '')).body || '{}');
    const noTok = (await reqPost(SOCK, '/api/archive?id=ws-am-coord', ID, '')).status;
    const coordLive = (await wsList()).find((w) => w.id === 'ws-am-coord')?.archived === false;
    clause('archive/refusals', again.ok === false && /archived/.test(again.error) && unknown.ok === false && noTok === 401 && coordLive, `already archived ⇒ ${JSON.stringify(again)}; unknown ⇒ ${JSON.stringify(unknown)}; no token ⇒ ${noTok}; am-coord still live ${coordLive}`);
  }

  // Swipe left to archive (Lucas 2026-10-20): TRUSTED touches (Input.dispatchTouchEvent, touch emulation on) on a workspace the
  // launch arms made — a real session behind it. A vertical drag on the row is a scroll (must-FAIL: nothing opens, nothing archived);
  // a left swipe reveals « Archiver » inside the viewport with no sideways scroll; a touch tap on it archives in main, the row leaves
  // the list, no conversation opens.
  {
    await phone.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    const seeded = new Set(world.workspaces.map((w) => w.id));
    const target = (await wsList()).find((w) => !seeded.has(w.id) && !w.archived && !w.parentId);
    await phone.eval(`location.hash = ''; true`);
    await waitFor(() => phone.eval(`!!document.querySelector('li.row[data-id=${JSON.stringify(target?.id ?? 'none')}]')`), 15000, 'the launched row on the phone list');
    const rowSel = `li.row[data-id="${target.id}"]`;
    const rectOf = (sel) => phone.eval(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); e.scrollIntoView({ block: 'center' }); const r = e.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height, r: r.right }; })()`);
    const drag = async (from, steps) => {
      await phone.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: from.x, y: from.y }] });
      for (const [x, y] of steps) { await phone.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y }] }); await sleep(16); }
      await phone.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await sleep(400); // the snap transition (.2 s)
    };
    let R = await rectOf(rowSel);
    const cy = R.y + R.h / 2;
    const scrolled = `(document.scrollingElement.scrollTop + document.getElementById('list').scrollTop)`;
    const top0 = await phone.eval(scrolled);
    await drag({ x: 300, y: cy }, [[299, cy - 15], [298, cy - 40], [297, cy - 70], [296, cy - 110]]);
    const V = await phone.eval(`({ swiped: !!document.querySelector(${JSON.stringify(rowSel + '.swiped')}), hash: location.hash, scrolled: ${scrolled} - ${top0} })`);
    R = await rectOf(rowSel);
    const cy2 = R.y + R.h / 2;
    await drag({ x: 330, y: cy2 }, [[318, cy2 + 1], [290, cy2 + 2], [250, cy2 + 2], [215, cy2 + 3]]);
    const S = await phone.eval(`(() => { const li = document.querySelector(${JSON.stringify(rowSel)}); const b = li.querySelector('.sw-archive').getBoundingClientRect(); const se = document.scrollingElement; return { swiped: li.classList.contains('swiped'), rowLeft: li.getBoundingClientRect().left, btn: { l: Math.round(b.left), r: Math.round(b.right), w: Math.round(b.width) }, vw: innerWidth, sideScroll: se.scrollWidth > se.clientWidth || document.getElementById('list').scrollLeft !== 0, text: li.querySelector('.sw-archive').textContent, hash: location.hash }; })()`);
    saveShot('phone-swipe-open.png', await phone.shot());
    const b = await phone.eval(`(() => { const r = document.querySelector(${JSON.stringify(rowSel + ' .sw-archive')}).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    await phone.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: b.x, y: b.y }] });
    await phone.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    const gone = await waitFor(() => phone.eval(`!document.querySelector(${JSON.stringify(rowSel)})`), 30000, 'the swiped row gone').then(() => true, () => false);
    const archived = await waitFor(async () => (await wsList()).find((w) => w.id === target.id)?.archived === true, 15000, 'archived in main').then(() => true, () => false);
    const after = await phone.eval(`({ hash: location.hash, rows: document.querySelectorAll('li.row').length })`);
    saveShot('phone-swipe-archived.png', await phone.shot());
    await phone.send('Emulation.setTouchEmulationEnabled', { enabled: false });
    clause('archive/swipe-vertical-is-a-scroll', !V.swiped && V.hash === '' && V.scrolled > 30 && (await wsList()).some((w) => w.id === target.id), `a 110 px upward drag on ${target.branch}: the page scrolled ${V.scrolled} px, swiped ${V.swiped}, hash « ${V.hash} », still listed`);
    clause('archive/swipe-reveals-archiver', S.swiped && Math.round(S.rowLeft) === -92 && S.btn.w === 92 && S.btn.r <= S.vw && S.btn.l >= S.vw - 93 && !S.sideScroll && S.text === 'Archiver' && S.hash === '', `left swipe ⇒ row at x ${Math.round(S.rowLeft)}, button ${JSON.stringify(S.btn)} in a ${S.vw} px viewport, sideways scroll ${S.sideScroll}, « ${S.text} », hash « ${S.hash} »`);
    clause('archive/swipe-tap-archives', gone && archived && after.hash === '', `touch tap on « Archiver » ⇒ row gone ${gone}, ${target.branch} archived in main ${archived}, conversation opened: ${after.hash !== ''} (${after.rows} rows left)`);
  }

  // ───────────── #336: pairing QR, regenerate, PWA install, unreachable ─────────────
  const KEY = 'orchestra.accesMobile.token';
  const HOST = 'rig-box.tail0000.ts.net';
  const urlFor = (tok) => `https://${HOST}:${SERVE_PORT}/#t=${tok}`;
  const storeHost = () => JSON.parse(fs.readFileSync(path.join(storeDir, 'store.json'), 'utf8')).accesMobile?.tailnetHost;
  const ensureDialog = async () => {
    if (await cdp.eval(`!!document.querySelector('.acces-mobile-settings')`)) return;
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: 895 });
    await cdp.clickSel('[data-am-open]');
    await waitFor(() => cdp.eval(`!!document.querySelector('.acces-mobile-settings [data-am-host]')`), 15000, 'the Accès mobile dialog');
  };
  const typeInto = async (sel, text) => {
    await cdp.clickSel(sel);
    await cdp.eval(`document.querySelector(${JSON.stringify(sel)}).select()`);
    await cdp.send('Input.insertText', { text });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: '\r' });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
  };
  /** Screenshot the REAL rendered QR element (2× clip) and the whole window — the decoder reads pixels, never the generator's data. */
  const qrShot = async () => {
    await cdp.eval(`document.querySelector('[data-am-qr]').scrollIntoView({ block: 'center' })`);
    await sleep(400);
    const r = await cdp.eval(`(() => { const b = document.querySelector('[data-am-qr]').getBoundingClientRect(); return { x: b.left, y: b.top, width: b.width, height: b.height, inView: b.left >= 0 && b.top >= 0 && b.right <= innerWidth && b.bottom <= innerHeight }; })()`);
    const clip = Buffer.from((await cdp.send('Page.captureScreenshot', { format: 'png', clip: { x: r.x, y: r.y, width: r.width, height: r.height, scale: 2 } }, 25000)).data, 'base64');
    return { r, clip, full: await cdp.shot() };
  };
  await ensureDialog();
  await cdp.eval(`document.querySelector('.acces-mobile-settings').scrollTo(0, 0)`);

  // qr/* — no host ⇒ no QR (control for the next arms)
  const noHost = await cdp.eval(`({ qr: !!document.querySelector('[data-am-qr]'), url: !!document.querySelector('[data-am-url]'), prompt: (document.querySelector('[data-am-qr-prompt]') || {}).textContent || '', host: document.querySelector('[data-am-host]').value })`);
  const view0 = await cdp.eval(`window.orchestra.accesMobile()`);
  const preQrShot = shots.find((x) => path.basename(x.file) === 'settings-on.png');
  clause('qr/no-host-no-qr', view0.settings.tailnetHost === '' && view0.pairingUrl === null && !noHost.qr && !noHost.url && /tailnet host/i.test(noHost.prompt) && noHost.host === '' && decodeQr(fs.readFileSync(preQrShot.file)) === null, `no host set: pairingUrl ${view0.pairingUrl}, no QR / URL element, prompt "${noHost.prompt}"; the decoder finds no QR in the earlier real dialog screenshot (it can say no)`);

  // an invalid host is refused with a message, nothing stored, still no QR
  await typeInto('[data-am-host]', 'https://rig-box.tail0000.ts.net/');
  await waitFor(() => cdp.eval(`!!document.querySelector('[data-am-error]')`), 10000, 'the host error');
  const badHost = await cdp.eval(`({ err: document.querySelector('[data-am-error]').textContent, qr: !!document.querySelector('[data-am-qr]') })`);
  clause('qr/bad-host-refused', /tailnet host/i.test(badHost.err) && !badHost.qr && !storeHost(), `typed "https://rig-box.tail0000.ts.net/": "${badHost.err.trim()}"; no QR, store.tailnetHost=${JSON.stringify(storeHost() ?? null)}`);

  // a valid host as pasted from Self.DNSName (upper case, trailing dot) ⇒ canonical host, QR + URL appear
  await typeInto('[data-am-host]', HOST.toUpperCase() + '.');
  await waitFor(() => cdp.eval(`!!document.querySelector('[data-am-qr]') && !!document.querySelector('[data-am-url]')`), 15000, 'the QR code');
  await waitFor(() => storeHost() === HOST, 10000, 'the host persisted');
  const hostUi = await cdp.eval(`({ host: document.querySelector('[data-am-host]').value, err: !!document.querySelector('[data-am-error]'), prompt: !!document.querySelector('[data-am-qr-prompt]') })`);
  const url1 = await cdp.eval(`document.querySelector('[data-am-url]').textContent`);
  const view1 = await cdp.eval(`window.orchestra.accesMobile()`);
  clause('qr/url-text', url1 === urlFor(TOKEN) && view1.pairingUrl === url1 && hostUi.host === HOST && !hostUi.err && !hostUi.prompt && !url1.split('#')[0].includes(TOKEN) && new URL(url1).search === '', `host typed "${HOST.toUpperCase()}." ⇒ stored "${storeHost()}"; dialog shows ${url1.replace(TOKEN, '<token>')} — token only after '#', main's view agrees`);
  const q1 = await qrShot();
  const dec1 = decodeQr(q1.clip), dec1Full = decodeQr(q1.full);
  saveShot('settings-qr.png', q1.full);
  clause('qr/rendered-pixels-decode-to-url', q1.r.inView && dec1 === url1 && dec1Full === url1, `QR element ${Math.round(q1.r.width)}×${Math.round(q1.r.height)} css px in view=${q1.r.inView}; jsQR on the 2× clip ⇒ ${dec1 === url1 ? 'EXACTLY the URL printed beside it' : JSON.stringify(dec1)}; jsQR on the whole window screenshot ⇒ ${dec1Full === url1 ? 'same' : JSON.stringify(dec1Full)}`);

  // regen/* — the phone is paired with TOKEN
  const phoneKey = () => phone.eval(`localStorage.getItem(${JSON.stringify(KEY)})`);
  const phoneStatus = () => phone.eval(`fetch('/api/workspaces', { headers: { Authorization: 'Bearer ' + localStorage.getItem(${JSON.stringify(KEY)}) } }).then((r) => r.status)`);
  const beforeRegen = { stored: await phoneKey(), status: await phoneStatus(), direct: (await req(SOCK, '/api/workspaces', { ...ID, Authorization: `Bearer ${TOKEN}` })).status };
  const seenAtRegen = seenLines.length;
  await cdp.clickSel('[data-am-regenerate]');
  await waitFor(() => fs.readFileSync(TOKEN_FILE, 'utf8').trim() !== TOKEN, 10000, 'a new token on disk');
  const NEW = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
  await waitFor(async () => (await cdp.eval(`document.querySelector('[data-am-url]').textContent`)) === urlFor(NEW), 10000, 'the new URL in the dialog');
  const regenUi = await cdp.eval(`!!document.querySelector('[data-am-regenerated]')`);
  const tokStat2 = fs.statSync(TOKEN_FILE), tokDir2 = fs.statSync(path.dirname(TOKEN_FILE));
  clause('regen/new-token-on-disk-and-in-dialog', beforeRegen.stored === TOKEN && beforeRegen.status === 200 && beforeRegen.direct === 200 && NEW !== TOKEN && /^[A-Za-z0-9_-]{43}$/.test(NEW) && (tokStat2.mode & 0o777) === 0o600 && (tokDir2.mode & 0o777) === 0o700 && regenUi && fs.readdirSync(path.dirname(TOKEN_FILE)).join() === 'token', `trusted click: before — phone stored the old token and got ${beforeRegen.status}; after — token file changed (0600, dir 0700, no tmp left), dialog URL follows, confirmation note shown`);
  const oldDirect = await req(SOCK, '/api/workspaces', { ...ID, Authorization: `Bearer ${TOKEN}` });
  const oldViaServe = await proxyGet(ownerProxy.port, '/api/workspaces', { Authorization: `Bearer ${TOKEN}` });
  const newViaServe = await proxyGet(ownerProxy.port, '/api/workspaces', { Authorization: `Bearer ${NEW}` });
  clause('regen/old-token-refused-new-accepted', oldDirect.status === 401 && oldViaServe.status === 401 && newViaServe.status === 200 && !oldViaServe.body.includes('am-') && (await phoneStatus()) === 401, `OLD token: direct ${oldDirect.status}, through serve ${oldViaServe.status}, from the paired phone ${await phoneStatus()} (must-FAIL arms); NEW token through serve ${newViaServe.status} (control)`);
  const q2 = await qrShot();
  const dec2 = decodeQr(q2.clip);
  saveShot('settings-qr-regenerated.png', q2.full);
  clause('regen/qr-follows-the-new-token', dec2 === urlFor(NEW) && dec2 !== dec1 && q2.r.inView, `after regeneration jsQR on the rendered QR ⇒ ${dec2 === urlFor(NEW) ? 'the NEW url' : JSON.stringify(dec2)}; differs from the first QR's content: ${dec2 !== dec1}`);
  await waitFor(async () => /Jeton refusé/.test(await phone.eval(`document.getElementById('state').textContent`)), 15000, 'the phone to notice the refused token').catch(async (e) => {
    const dbg = await phone.eval(`({ href: location.href, state: document.getElementById('state').textContent, homeHidden: document.getElementById('home').hidden, rows: document.querySelectorAll('li[data-id]').length, live: document.getElementById('live').dataset.live, upd: !!document.getElementById('appUpdate') })`).catch((x) => String(x));
    const lines = seenLines.slice(seenAtRegen).map((l) => `${l.who} ${l.method} ${l.url.split('?')[0]} ${l.status}`);
    throw new Error(`${e.message} — phone: ${JSON.stringify(dbg)}; stand-in lines since regen: ${JSON.stringify(lines)}`);
  });
  const refusedText = await phone.eval(`document.getElementById('state').textContent`);
  saveShot('phone-token-refused.png', await phone.shot());
  const shown = await cdp.eval(`document.querySelector('[data-am-url]').textContent`);
  await phone.send('Page.navigate', { url: `http://127.0.0.1:${ownerProxy.port}/${new URL(shown).hash}` }); // the displayed URL, its origin swapped for the stand-in (no real tailnet here)
  // Same URL, new fragment ⇒ a same-document navigation (hashchange): the open page keeps its state (its filter
  // is on Tout ⇒ 3 visible rows) and must adopt the new token by itself — the « Jeton refusé » text is replaced by the list.
  await waitFor(() => phone.eval(`document.getElementById('state').textContent === '' && document.querySelectorAll('li[data-id]').length >= 3`), 20000, 'rows after re-pairing with the new URL').catch(async (e) => {
    const dbg = await phone.eval(`({ href: location.href, stored: localStorage.getItem(${JSON.stringify(KEY)}), state: (document.getElementById('state') || {}).textContent, rows: document.querySelectorAll('li[data-id]').length })`).catch((x) => String(x));
    throw new Error(`${e.message} — phone: ${JSON.stringify(dbg)}; wanted token ${NEW}; navigated to ${shown.replace(NEW, '<NEW>')}`);
  });
  const rp = await phone.eval(`({ href: location.href, stored: localStorage.getItem(${JSON.stringify(KEY)}) })`);
  clause('regen/repair-with-new-url', /Jeton refusé/.test(refusedText) && rp.stored === NEW && !rp.href.includes('#') && !rp.href.includes(NEW), `phone showed "${refusedText.trim()}"; opening the NEW displayed URL over the open page ⇒ its list is back (3 rows), token stored=${rp.stored === NEW}, address now ${rp.href}`);

  // pwa/* — manifest, icons, apple-touch-icon, service worker, shell-only cache
  const pm = await phone.send('Page.getAppManifest');
  const inst = await phone.send('Page.getInstallabilityErrors').catch((e) => ({ installabilityErrors: [{ errorId: `cdp: ${e.message}` }] }));
  const manifest = JSON.parse(pm.data || '{}');
  const iconFetch = await Promise.all((manifest.icons || []).map(async (ic) => { const r = await proxyGetBin(ownerProxy.port, new URL(ic.src, `http://127.0.0.1:${ownerProxy.port}/`).pathname, {}); const png = PNG.sync.read(r.body); return { src: ic.src, sizes: ic.sizes, status: r.status, dims: `${png.width}x${png.height}` }; }));
  const touch = await phone.eval(`(() => { const l = document.querySelector('link[rel="apple-touch-icon"]'); const m = (n) => (document.querySelector('meta[name="' + n + '"]') || {}).content; return { href: l && new URL(l.href).pathname, capable: m('apple-mobile-web-app-capable'), title: m('apple-mobile-web-app-title'), status: m('apple-mobile-web-app-status-bar-style'), manifest: (document.querySelector('link[rel=manifest]') || {}).href }; })()`);
  const touchPng = await proxyGetBin(ownerProxy.port, touch.href, {});
  const touchDims = PNG.sync.read(touchPng.body);
  saveShot('apple-touch-icon.png', touchPng.body);
  clause('pwa/manifest-icons-touch-icon', pm.errors?.length === 0 && manifest.name === 'Orchestra' && manifest.display === 'standalone' && iconFetch.length === 2 && iconFetch.every((i) => i.status === 200 && i.dims === i.sizes) && touch.href === '/apple-touch-icon.png' && touchDims.width === 180 && touchDims.height === 180 && touch.capable === 'yes' && touch.title === 'Orchestra' && !!touch.status, `Chromium parsed the manifest (errors ${JSON.stringify(pm.errors)}): ${manifest.name}, ${manifest.display}, icons ${iconFetch.map((i) => `${i.src} ${i.dims} ${i.status}`).join(', ')}; apple-touch-icon ${touchDims.width}x${touchDims.height}; apple-mobile-web-app metas ${touch.capable}/${touch.title}/${touch.status}`);
  clause('pwa/installable', (inst.installabilityErrors || []).length === 0, `Page.getInstallabilityErrors ⇒ ${JSON.stringify(inst.installabilityErrors)}`);
  const swInfo = await phone.eval(`(async () => { const reg = await navigator.serviceWorker.ready; return { scope: reg.scope, state: reg.active && reg.active.state, script: reg.active && new URL(reg.active.scriptURL).pathname, controlled: !!navigator.serviceWorker.controller }; })()`);
  const cacheDump = await phone.eval(`(async () => { const secrets = ${JSON.stringify([TOKEN, NEW])}; const out = {}; for (const k of await caches.keys()) { out[k] = []; const c = await caches.open(k); for (const r of await c.keys()) { const res = await c.match(r); const txt = new TextDecoder('latin1').decode(await res.arrayBuffer()); const u = new URL(r.url); out[k].push({ path: u.pathname + u.search + u.hash, status: res.status, leaks: secrets.some((t) => txt.includes(t)) }); } } return out; })()`);
  const cacheKeys = Object.keys(cacheDump);
  const cachedPaths = (cacheDump[cacheKeys[0]] || []).map((e) => e.path).sort();
  clause('pwa/service-worker-shell-only-cache', swInfo.state === 'activated' && swInfo.script === '/sw.js' && swInfo.controlled && cacheKeys.length === 1 && JSON.stringify(cachedPaths) === JSON.stringify(['/', '/app.js', '/apple-touch-icon.png', '/conversation.css', '/conversation.js', '/icon-192.png', '/icon-512.png', '/launch.css', '/launch.js', '/manifest.webmanifest']) && cacheDump[cacheKeys[0]].every((e) => e.status === 200 && !e.leaks), `worker ${swInfo.script} ${swInfo.state}, controlling the page=${swInfo.controlled}; Cache Storage ${JSON.stringify(cacheKeys)} holds exactly [${cachedPaths.join(' ')}] — no /api entry (control: the shell IS cached), no token in any body, all 200`);

  // unreachable: Orchestra off (serve ⇒ 502), then the stand-in gone (connection refused) — the page comes from the worker's cache
  /** Run `act` (a reload / navigation), then wait for a NEW page load (timeOrigin changed) that says « Orchestra injoignable » — the
   *  old page polls too and would say it before the reload even lands. */
  const injoignable = async (what, act) => {
    const t0 = await phone.eval(`performance.timeOrigin`);
    await act();
    await waitFor(async () => (await phone.eval(`performance.timeOrigin`)) !== t0 && (await phone.eval(`(document.getElementById('state') || {}).textContent`)) === 'Orchestra injoignable.', 25000, `« Orchestra injoignable » on a fresh load (${what})`);
  };
  const shellFromWorker = () => phone.eval(`(() => { const n = performance.getEntriesByType('navigation')[0]; return { shell: !!document.querySelector('h1') && document.querySelector('h1').textContent === 'Workspaces' && !!document.getElementById('needsMe'), workerStart: n ? n.workerStart : -1, controlled: !!navigator.serviceWorker.controller, text: document.body.innerText.trim().replace(/\\s+/g, ' ') }; })()`); // (\\s: this is a template literal — a bare \s would silently become "s")
  await ensureDialog();
  await cdp.clickSel('[data-am-toggle]');
  await waitFor(() => cdp.eval(`document.querySelector('[data-am-health]').dataset.amHealth === 'off'`), 15000, 'health off');
  await waitFor(async () => !fs.existsSync(SOCK) && serverPids(TOKEN_FILE).length === 0, 15000, 'socket removed + process gone');
  const nSeen = seenLines.length;
  await injoignable('server off', () => phone.send('Page.reload'));
  const off = await shellFromWorker();
  const sawBadGateway = seenLines.slice(nSeen).filter((l) => l.who === 'owner' && l.ua !== '' && l.url === '/' && l.status === 502); // ua !== '' = the browser (the worker's own fetch carries Chromium's UA, not the emulated iPhone's)
  saveShot('phone-unreachable.png', await phone.shot());
  // control: a fresh origin (no worker, no cache) behind the same dead server shows NO app shell — so the shell above can only come from the cache
  const fresh = await serveProxy(() => SOCK, LOGIN, seenLines, 'fresh-origin');
  await phone.send('Page.navigate', { url: `http://127.0.0.1:${fresh.port}/` });
  await sleep(1500);
  const noWorker = await phone.eval(`({ h1: ((document.querySelector('h1') || {}).textContent || '') === 'Workspaces' && !!document.getElementById('needsMe'), text: ((document.body || {}).innerText || '').trim(), controlled: !!(navigator.serviceWorker && navigator.serviceWorker.controller) })`);
  fresh.srv.closeAllConnections?.(); fresh.srv.close();
  clause('pwa/unreachable-server-off-served-from-cache', off.shell && off.workerStart > 0 && off.controlled && off.text.includes('Orchestra injoignable') && sawBadGateway.length > 0 && !noWorker.h1 && !noWorker.controlled, `Accès mobile off: reload ⇒ the page still renders (h1 Orchestra, filter box) and says « injoignable »; navigation workerStart=${Math.round(off.workerStart)} ms (served by the worker) while the stand-in answered ${sawBadGateway.length}× 502 for "/"; control — a never-visited origin behind the same dead server renders no shell (app shell=${noWorker.h1}, worker=${noWorker.controlled}, text "${noWorker.text.replace(/\s+/g, ' ').slice(0, 80)}")`);
  await injoignable('back on the paired origin', () => phone.send('Page.navigate', { url: `http://127.0.0.1:${ownerProxy.port}/` }));
  await stopProxy(ownerProxy);
  await injoignable('stand-in down: connection refused', () => phone.send('Page.reload'));
  const down = await shellFromWorker();
  const refusedConn = !(await connects('127.0.0.1', ownerProxy.port));
  clause('pwa/unreachable-network-down-served-from-cache', refusedConn && down.shell && down.workerStart > 0 && down.text.includes('Orchestra injoignable'), `connection refused on port ${ownerProxy.port}=${refusedConn}: reload ⇒ shell from the worker's cache (workerStart ${Math.round(down.workerStart)} ms) + « Orchestra injoignable » — ${JSON.stringify(down)}`);
  // recovery without any reload: stand-in back + Orchestra on ⇒ the open page's own poll fills the list
  await startProxy(ownerProxy);
  await cdp.clickSel('[data-am-toggle]');
  await waitFor(() => cdp.eval(`document.querySelector('[data-am-health]').dataset.amHealth === 'listening'`), 20000, 'health listening again');
  await waitFor(() => sockConnects(SOCK), 15000, 'socket back');
  await waitFor(() => phone.eval(`document.querySelectorAll('li[data-id]').length >= 3`), 25000, 'rows back without a reload');
  clause('pwa/recovers-by-itself', true, 'stand-in + Orchestra back ⇒ the page that said « injoignable » lists 3 workspaces again with no reload (its own 5 s poll)');

  // leak/* — the token never travels in a request line (phone traffic) nor lands in a log / any file under ORCHESTRA_HOME
  const phoneLines = seenLines.filter((l) => l.ua !== ''); // every browser request (page: iPhone UA; service worker: Chromium UA); the rig's own node requests carry none
  const tokenInLine = phoneLines.filter((l) => l.url.includes(TOKEN) || l.url.includes(NEW) || /[?&#]t=/.test(l.url));
  clause('leak/phone-request-lines', phoneLines.length > 20 && phoneLines.some((l) => l.url === '/') && tokenInLine.length === 0, `${phoneLines.length} request lines from the phone's browser + worker (incl. ${phoneLines.filter((l) => l.url === '/').length}× "GET /" — the pairing navigations carried the fragment, the line never did): ${tokenInLine.length} contain a token or t=`);
  const secrets = [Buffer.from(TOKEN), Buffer.from(NEW)];
  const scan = filesContaining(world.ohome, secrets, new Set([TOKEN_FILE]));
  const appLogLeak = secrets.some((x) => fs.readFileSync(logFile).includes(x));
  const queryArm = seenLines.some((l) => l.url.includes(`?t=${TOKEN}`));
  clause('leak/no-token-in-logs-or-files', scan.hits.length === 0 && !appLogLeak && scan.scanned > 5 && queryArm, `scanned ${scan.scanned} files under ORCHESTRA_HOME + the app's stdout log for the old and the new token: ${scan.hits.length} hits${scan.hits.length ? ' (' + scan.hits.join(', ') + ')' : ''}; control: the sec/query-token arm DID put the old token in a request line the server refused, and it is still in no log`);

  // supervision: SIGKILL the server ⇒ restarted
  const pidNow = serverPids(TOKEN_FILE)[0];
  process.kill(pidNow, 'SIGKILL');
  const pidOn3 = await waitFor(() => { const p = serverPids(TOKEN_FILE); return p.length && p[0] !== pidNow ? p[0] : null; }, 20000, 'a restarted server');
  await waitFor(() => sockConnects(SOCK), 15000, 'socket back');
  clause('supervise/restart-after-kill', (await req(SOCK, '/api/workspaces', { ...ID, Authorization: `Bearer ${NEW}` })).status === 200, `SIGKILL pid ${pidNow} -> restarted as pid ${pidOn3} (stale socket replaced; the regenerated token still the one it accepts)`);

  // « Nouvelle version installée » (Lucas 2026-10-12): a release replaces the installed app on disk; the running one keeps its old code.
  // Swap it the way release.sh --install does (sidecar from the tmp file's inode, then rename) ⇒ the desktop banner + the phone say so;
  // « Plus tard » hides it until the NEXT install; « Relancer » quits, then the installed app starts once the old one is gone — here
  // that « installed app » re-launches this very build, so the relaunch is a REAL one (same CDP port, same ORCHESTRA_HOME).
  const INSTALLED = env.ORCHESTRA_INSTALLED_APP;
  const relaunchRecord = path.join(world.d, 'relaunch.record'), app2PidFile = path.join(world.d, 'app2.pid');
  // the relaunched app gets its OWN debug port: right after the old app exits its port can still be held (Chromium: « bind() failed:
  // Address already in use » — rig-only, production opens no debug port)
  const cdpPort2 = await freePort();
  // the port and the old pid are read from files when the fake runs: the phone's relaunch (relaunch/*) reuses the same installed file
  const portFile = path.join(world.d, 'next-cdp.port');
  fs.writeFileSync(portFile, String(cdpPort2));
  const installFake = (version) => {
    const tmp = `${INSTALLED}.tmp`;
    fs.writeFileSync(tmp, `#!/bin/sh\n# fake installed Orchestra ${version}\nOLD=$(cat '${path.join(world.d, 'app.pid')}')\nif kill -0 "$OLD" 2>/dev/null; then echo "old-alive $#" > '${relaunchRecord}'; else echo "old-gone $#" > '${relaunchRecord}'; fi\necho $$ > '${app2PidFile}'\nexport ORCHESTRA_DEBUG_PORT=$(cat '${portFile}')\nexec '${path.join(APP_DIR, 'node_modules/electron/dist/electron')}' '${APP_DIR}' --ozone-platform=wayland >> '${path.join(world.d, 'app2.log')}' 2>&1\n`, { mode: 0o755 });
    const st = fs.statSync(tmp);
    fs.writeFileSync(`${INSTALLED}.version.tmp`, `${version} ${st.ino} ${st.size}\n`); fs.renameSync(`${INSTALLED}.version.tmp`, `${INSTALLED}.version`);
    fs.renameSync(tmp, INSTALLED);
  };
  const deskBanner = `(() => { const b = document.querySelector('[data-app-update]'); return b ? { v: b.dataset.appUpdate, text: b.textContent } : null; })()`;
  if (await cdp.eval(`!!document.querySelector('.acces-mobile-settings .modal-actions .btn')`)) await cdp.clickSel('.acces-mobile-settings .modal-actions .btn'); // « Done »
  await waitFor(() => cdp.eval(`!document.querySelector('.modal-backdrop')`), 5000, 'the settings dialog closed');
  const before = await cdp.eval(deskBanner);
  const phoneBefore = await phone.eval(`(() => { const u = document.getElementById('appUpdate'); return u ? !u.hidden : 'absent'; })()`);
  installFake('0.5.999');
  const D1 = await waitFor(() => cdp.eval(deskBanner), 15000, 'the desktop banner after an install').catch(() => null);
  saveShot('desktop-app-update.png', await cdp.shot());
  clause('update/desktop-banner', before === null && D1?.v === '0.5.999' && /Nouvelle version installée \(v0\.5\.999\)/.test(D1.text) && /Relancer/.test(D1.text), `before the install: ${JSON.stringify(before)}; after: ${JSON.stringify(D1)}`);
  await phone.send('Page.reload');
  const P1 = await waitFor(() => phone.eval(`(() => { const u = document.getElementById('appUpdate'); return u && !u.hidden ? u.textContent : null; })()`), 20000, 'the phone banner').catch(() => null);
  saveShot('phone-app-update.png', await phone.shot());
  const phoneGo = await phone.eval(`(() => { const b = document.querySelector('#appUpdate button.upd-go'); return b ? b.textContent : null; })()`);
  clause('update/phone-banner', phoneBefore === false && /Nouvelle version d’Orchestra installée \(v0\.5\.999\)/.test(P1 ?? '') && phoneGo === 'Relancer', `phone before: shown=${phoneBefore}; after: « ${P1} », its button « ${phoneGo} »`);
  // a trusted click that must land ON the control: the Accès mobile dialog left open by regen/* would swallow it (« Done » closes it)
  const clickDesk = async (sel) => {
    const c = await cdp.eval(`(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); const x = r.left + r.width / 2, y = r.top + r.height / 2; const hit = document.elementFromPoint(x, y); return { x, y, on: !!(hit && hit.closest(${JSON.stringify(sel)})) }; })()`);
    if (!c.on) throw new Error(`the click on ${sel} would not land on it (covered)`);
    await cdp.click(c.x, c.y); await sleep(300);
  };
  await clickDesk('[data-app-update-later]');
  const afterLater = await cdp.eval(deskBanner);
  installFake('0.5.1000');
  const D2 = await waitFor(() => cdp.eval(`(() => { const b = document.querySelector('[data-app-update]'); return b && b.dataset.appUpdate === '0.5.1000' ? b.dataset.appUpdate : null; })()`), 15000, 'the banner after the next install').catch(() => null);
  clause('update/later-until-next-install', afterLater === null && D2 === '0.5.1000', `« Plus tard » ⇒ ${afterLater === null ? 'hidden' : 'STILL SHOWN'}; the next install (0.5.1000) ⇒ ${D2 ? 'shown again' : 'not shown'}`);
  // « Relancer » (trusted click): the old app exits, its phone server with it, then the installed app starts — the record says the
  // old one was already gone — and boots: same page, same phone server path, no banner (it started FROM the current file).
  const oldPid = appPid;
  try { fs.unlinkSync(relaunchRecord); } catch {}
  await clickDesk('[data-app-update-relaunch]');
  cdp.close(); cdp = null;
  await waitFor(() => { try { process.kill(oldPid, 0); return false; } catch { return true; } }, 30000, 'the old app gone');
  const rec = await waitFor(() => (fs.existsSync(relaunchRecord) ? fs.readFileSync(relaunchRecord, 'utf8').trim() : null), 30000, 'the installed app started');
  appPid = Number(await waitFor(() => (fs.existsSync(app2PidFile) ? fs.readFileSync(app2PidFile, 'utf8').trim() : null), 10000, 'the new app pid'));
  const target2 = await waitFor(async () => (await (await fetch(`http://127.0.0.1:${cdpPort2}/json`)).json()).find((x) => x.type === 'page' && x.url.includes('dist/index.html')) || null, 60000, 'the relaunched app page').catch(() => null);
  if (target2) { cdp = await Cdp.connect(target2.webSocketDebuggerUrl); await cdp.send('Page.enable'); }
  const booted = target2 ? await waitFor(() => cdp.eval(`!!document.querySelector('[data-am-open]')`), 60000, 'the relaunched app UI').catch(() => false) : false;
  const bannerAfter = booted ? await cdp.eval(deskBanner) : 'n/a';
  const serverBack = await waitFor(() => serverPids(TOKEN_FILE).length > 0 && sockConnects(SOCK), 30000, 'the phone server back').catch(() => false);
  clause('update/relaunch', rec === 'old-gone 0' && appPid !== oldPid && booted && bannerAfter === null && !!serverBack, `trusted « Relancer » ⇒ old app ${oldPid} exited, the installed app started after it (« ${rec} »), new app ${appPid} booted=${booted}, banner after boot ${JSON.stringify(bannerAfter)}, phone server back=${!!serverBack}`);
  try { process.kill(appPid, 0); } catch { throw new Error('the relaunched app is not running'); }

  // « Relancer Orchestra » FROM THE PHONE (Lucas 2026-10-20): the header's ↻ ⇒ a confirmation (« Annuler » relaunches nothing), then
  // « Relancer » ⇒ the same quit + exec as the desktop — here with NO newer install (the phone relaunches whatever the version) —; the
  // phone page, never reloaded, says « relancé » once a NEW app (another startedAt) answers it through serve.
  const tapOn = async (sel) => {
    const c = await phone.eval(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; e.scrollIntoView({ block: 'center', behavior: 'instant' }); const r = e.getBoundingClientRect(); const x = r.left + r.width / 2, y = r.top + r.height / 2; const hit = document.elementFromPoint(x, y); return { x, y, on: !!(hit && hit.closest(${JSON.stringify(sel)})) }; })()`);
    if (!c?.on) throw new Error(`the tap on ${sel} would not land on it (${JSON.stringify(c)})`);
    for (const [type, extra] of [['mousePressed', { button: 'left', clickCount: 1 }], ['mouseReleased', { button: 'left', clickCount: 1 }]]) await phone.send('Input.dispatchMouseEvent', { type, x: c.x, y: c.y, ...extra });
    await sleep(250);
  };
  const appInfo = async () => { const r = await req(SOCK, '/api/workspaces', { ...ID, Authorization: `Bearer ${NEW}` }); try { return JSON.parse(r.body).app ?? null; } catch { return null; } };
  const rlPanel = `(() => { const p = document.getElementById('relaunch'); return { state: p.dataset.state, hidden: p.hidden, msg: document.getElementById('rlMsg').textContent }; })()`;
  const cdpPort3 = await freePort();
  fs.writeFileSync(portFile, String(cdpPort3));
  fs.writeFileSync(path.join(world.d, 'app.pid'), String(appPid));
  for (const f of [relaunchRecord, app2PidFile]) { try { fs.unlinkSync(f); } catch {} }
  await phone.eval(`location.hash = ''; true`);
  await waitFor(() => phone.eval(`document.getElementById('live').dataset.live === 'on' && !document.getElementById('home').hidden`), 30000, 'the phone back online after the desktop relaunch');
  const info1 = await appInfo();
  const noBanner = await phone.eval(`document.getElementById('appUpdate').hidden`);
  const loadedAt = await phone.eval(`performance.timeOrigin`);
  const pidA = appPid;
  await tapOn('#relaunchBtn');
  const confirm = await phone.eval(rlPanel);
  saveShot('phone-relaunch-confirm.png', await phone.shot());
  await tapOn('#rlCancel');
  await sleep(3000);
  const afterCancel = await phone.eval(rlPanel);
  let aliveAfterCancel = true; try { process.kill(pidA, 0); } catch { aliveAfterCancel = false; }
  clause('relaunch/confirm-first', noBanner === true && confirm.state === 'confirm' && !confirm.hidden && /les agents continuent/.test(confirm.msg) && afterCancel.hidden && aliveAfterCancel && !fs.existsSync(relaunchRecord) && (await appInfo())?.startedAt === info1?.startedAt,
    `no newer install (banner hidden=${noBanner}); trusted ↻ ⇒ « ${confirm.state} » « ${confirm.msg.slice(0, 60)}… »; « Annuler » ⇒ hidden=${afterCancel.hidden}, 3 s later app ${pidA} alive=${aliveAfterCancel}, fake installed app ran=${fs.existsSync(relaunchRecord)}`);
  await tapOn('#relaunchBtn');
  await tapOn('#rlGo');
  const waiting = await phone.eval(rlPanel);
  cdp?.close(); cdp = null;
  await waitFor(() => { try { process.kill(pidA, 0); return false; } catch { return true; } }, 30000, 'the old app gone (phone relaunch)');
  const rec3 = await waitFor(() => (fs.existsSync(relaunchRecord) ? fs.readFileSync(relaunchRecord, 'utf8').trim() : null), 30000, 'the installed app started (phone relaunch)');
  appPid = Number(await waitFor(() => (fs.existsSync(app2PidFile) ? fs.readFileSync(app2PidFile, 'utf8').trim() : null), 10000, 'the new app pid (phone relaunch)'));
  const target3 = await waitFor(async () => (await (await fetch(`http://127.0.0.1:${cdpPort3}/json`)).json()).find((x) => x.type === 'page' && x.url.includes('dist/index.html')) || null, 60000, 'the phone-relaunched app page').catch(() => null);
  if (target3) { cdp = await Cdp.connect(target3.webSocketDebuggerUrl); await cdp.send('Page.enable'); }
  const booted3 = target3 ? await waitFor(() => cdp.eval(`!!document.querySelector('[data-am-open]')`), 60000, 'the phone-relaunched app UI').catch(() => false) : false;
  const done = await waitFor(async () => { const p = await phone.eval(rlPanel); return p.state === 'done' ? p : null; }, 90000, 'the phone says « relancé »').catch(async () => phone.eval(rlPanel));
  saveShot('phone-relaunch-done.png', await phone.shot());
  const info2 = await appInfo();
  const sameDoc = (await phone.eval(`performance.timeOrigin`)) === loadedAt;
  clause('relaunch/from-phone', waiting.state === 'wait' && rec3 === 'old-gone 0' && appPid !== pidA && booted3 && done.state === 'done' && done.msg === `Orchestra relancé (v${info2?.version}).` && !!info2 && info2.startedAt !== info1?.startedAt && sameDoc,
    `trusted ↻ then « Relancer » ⇒ « ${waiting.state} »; old app ${pidA} exited, the installed app started after it (« ${rec3} »), new app ${appPid} booted=${booted3}; the open phone page (not reloaded: ${sameDoc}) says « ${done.msg} »; startedAt ${info1?.startedAt} → ${info2?.startedAt}`);
  try { process.kill(appPid, 0); } catch { throw new Error('the phone-relaunched app is not running'); }

  // app crash ⇒ the server exits (no orphan listening)
  cdp?.close(); cdp = null;
  process.kill(appPid, 'SIGKILL');
  await waitFor(() => serverPids(TOKEN_FILE).length === 0, 15000, 'server gone after app SIGKILL').catch(() => null);
  const left = serverPids(TOKEN_FILE);
  const stillServing = await sockConnects(SOCK);
  clause('supervise/dies-with-app', left.length === 0 && !stillServing, `after app SIGKILL: server pids [${left.join(',')}], socket ${stillServing ? 'STILL ANSWERS' : 'dead'} (${fs.existsSync(SOCK) ? 'file left' : 'file removed'})`);

  const dup = shots.length !== new Set(shots.map((s) => s.md5)).size;
  clause('ctl/screenshots-distinct', !dup, shots.map((s) => `${path.basename(s.file)}=${s.md5.slice(0, 8)}`).join(' '));
  exitCode = results.every((r) => r.ok) ? 0 : 1;
} catch (e) {
  console.log(`ERROR: ${e.stack || e}`);
  exitCode = 2;
} finally {
  try { cdp?.close(); phone?.close(); } catch {}
  for (const p of [ownerProxy, colleagueProxy, taggedProxy]) p.srv.close();
  if (SOCK && fs.existsSync(SOCK)) { try { fs.unlinkSync(SOCK); } catch {} }
  for (const p of [chrome, app]) { if (p?.pid) { try { process.kill(-p.pid, 'SIGKILL'); } catch {} } }
  if (appPid !== app.pid) { try { process.kill(-appPid, 'SIGKILL'); } catch {} try { process.kill(appPid, 'SIGKILL'); } catch {} }
  // keepers + CLIs are detached from the app: select them by identity (this rig's ORCHESTRA_HOME in their environ)
  for (const pid of fs.readdirSync('/proc').filter((n) => /^\d+$/.test(n))) {
    try { if (environOf(pid).includes(`ORCHESTRA_HOME=${world.ohome}`) && +pid !== process.pid) process.kill(+pid, 'SIGKILL'); } catch {}
  }
  try { await fakeApi.stop(); } catch {}
  for (const p of serverPids(TOKEN_FILE)) { try { process.kill(p, 'SIGKILL'); } catch {} }
}
const fails = results.filter((r) => !r.ok).map((r) => r.name);
console.log(`\n${results.length} clauses, ${fails.length} failed${fails.length ? ': ' + fails.join(', ') : ''}`);
console.log(exitCode === 0 ? 'CLEAN' : 'DIRTY');
process.exit(exitCode);
