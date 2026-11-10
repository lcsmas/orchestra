// #417 — Bloc HTML chrome rig (ADR 0011, variant A): clip + fade + « Afficher tout », source toggle, enlarge overlay, keyboard / screen reader.
// Boots a BUILT Orchestra (argv[2] = app dir) in the contained rig's own headless sway (scratch ORCHESTRA_HOME / HOME / CLAUDE_CONFIG_DIR, stub `claude`),
// replays a reply with a short and a tall bloc through the app's own event path, drives it with TRUSTED input (CDP mouse/keys) and reads the accessibility tree.
// Infrastructure (guard, Cdp, seed, events, mutant copy) mirrors scripts/e2e-bloc-html.mjs (#415); the isolation arms stay there.
//
// Arms (each = one app boot): `real` = the build as is, every clause GREEN; each other arm boots a COPY with ONE guard removed and must turn exactly its
// own clause RED (plus the clauses it legitimately feeds, listed in MUTANTS[arm].also), every control and every other clause GREEN.
//   clip C1 · hover S0 · ghost S0 · source S1 · overlap S1 · tab A2 · perm P1 · popover P4 · ask P2 · askpre P5 · pane P3 · srccap S3 · label A1 · esc E1 · leak E5 · escframe E2 · focus E4 · trap E7 · single L1
import net from 'node:net';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFileSync, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const APP_DIR = argv[0] && !argv[0].startsWith('--') ? fs.realpathSync(argv[0]) : null;
const LIVE_HOME = flag('--live-home', null);
const ARMS = (flag('--arms', 'real,clip,hover,ghost,source,overlap,label,esc,leak,escframe,focus,trap,tab,single,perm,popover,ask,askpre,pane,srccap')).split(',');
const refuse = (m) => { console.log(`REFUSED: ${m}`); process.exit(3); };
if (!APP_DIR) refuse('no <app-dir>');
if (!LIVE_HOME) refuse('--live-home missing (needed to protect the live ~/.claude* and to prove nothing there moved)');
const RIG_DIR = process.env.RIG_DIR;
const RIG_WAYLAND = process.env.RIG_WAYLAND;
if (!RIG_DIR || !RIG_WAYLAND) refuse('RIG_DIR / RIG_WAYLAND unset — run via scripts/e2e-bloc-html-chrome.sh (the contained rig)');
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

// ── seeding: a real git repo + registered worktree, the PINNED scratch account, a stub `claude` ────
const WS = 'ws-bh417-1';
function seedWorld(armDir) {
  const fakeHome = path.join(armDir, 'home'), ohome = path.join(armDir, 'oh'), cfg = path.join(armDir, 'claude-config');
  const repoDir = path.join(armDir, 'repo'), wtDir = path.join(armDir, 'wt', 'bh417-1');
  for (const d of [fakeHome, ohome, cfg, repoDir, path.dirname(wtDir)]) fs.mkdirSync(d, { recursive: true });
  for (const [k, v] of Object.entries({ HOME: fakeHome, ORCHESTRA_HOME: ohome, CLAUDE_CONFIG_DIR: cfg, repo: repoDir, wt: wtDir })) mustBeScratch(k, v);
  git(repoDir, ['init', '-q', '-b', 'main'], fakeHome);
  fs.writeFileSync(path.join(repoDir, 'README.md'), '# bh417 seed repo\n');
  git(repoDir, ['add', '.'], fakeHome); git(repoDir, ['commit', '-q', '-m', 'seed'], fakeHome);
  git(repoDir, ['worktree', 'add', '-q', '-b', 'e2e/bh417-1', wtDir], fakeHome);
  const account = { id: 'rig-bh417', label: 'rig (scratch config dir)', configDir: cfg };
  mustBeScratch('account.configDir', account.configDir);
  const ws = { id: WS, name: 'bh417-1', repoPath: repoDir, worktreePath: wtDir, branch: 'e2e/bh417-1', baseBranch: 'main', createdAt: Date.now(), status: 'idle', agent: 'claude', accountId: account.id };
  const dir = path.join(ohome, 'userData', 'orchestra'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'store.json'), JSON.stringify({ repos: [{ path: repoDir, name: 'bh417-repo', defaultBranch: 'main', accountId: account.id }], workspaces: [ws], accounts: [account], selfTuneRuns: [] }, null, 2));
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
const TALL_H = 1300, SHORT_H = 120, CAP = 420;
const TALL = `<div id="t" style="height:${TALL_H}px;background:var(--bloc-accent);color:var(--bloc-surface);padding:12px;box-sizing:border-box"><button id="inner" style="font:inherit;padding:6px 14px">inner</button> TALL <b>&amp;</b> source</div>`;
const SHORT = `<div style="height:${SHORT_H}px;background:var(--bloc-accent)">short</div>`;
const TALL_TITLE = 'Tableau long', SHORT_TITLE = 'Court';

const results = []; // {arm, clause, ok, detail}
const shots = [];
function clause(arm, name, ok, detail) { results.push({ arm, clause: name, ok: !!ok, detail }); console.log(`  ${ok ? 'PASS' : 'FAIL'}  [${arm}] ${name} — ${detail}`); }
function saveShot(name, buf) { fs.mkdirSync(OUT, { recursive: true }); const f = path.join(OUT, name); fs.writeFileSync(f, buf); shots.push({ file: f, md5: md5(buf) }); return f; }

// ── the mutants: ONE regex-matched string in a disposable COPY of the built app (minified names move: match by shape, count must be 1) ──
// `also` = clauses that legitimately go red as a consequence (the removed guard feeds them); every OTHER clause must stay green.
const MUTANTS = {
  clip: { clause: 'C1', dir: 'dist/assets', re: /const (\w+)=(\w+)>(\w+),(\w+)=\1&&!(\w+)&&!(\w+);/g, to: 'const $1=$2>$3,$4=!1&&!$5&&!$6;', also: ['C3', 'C3b'], only: ['C'] },
  source: { clause: 'S1', dir: 'dist/assets', re: /(\w+)\?h\.jsx\((\w+),\{source:(\w+)\}\):h\.jsxs\(h\.Fragment/g, to: '$1?null:h.jsxs(h.Fragment', also: ['S2', 'S3'] },
  label: { clause: 'A1', dir: 'dist/assets', re: /"aria-label":`Agrandir : \$\{(\w+)\}`/g, to: '"data-x":`Agrandir : ${$1}`', also: [] },
  esc: { clause: 'E1', dir: 'dist/assets', re: /(\w+)\.key==="Escape"&&\((\w+)\.preventDefault\(\),\2\.stopPropagation\(\),(\w+)\(\)\)/g, to: '$1.key==="EscapeX"&&($2.preventDefault(),$2.stopPropagation(),$3())', also: ['E5'] },
  leak: { clause: 'E5', dir: 'dist/assets', re: /(\w+)\.key==="Escape"&&\((\w+)\.preventDefault\(\),\2\.stopPropagation\(\),(\w+)\(\)\)/g, to: '$1.key==="Escape"&&($2.preventDefault(),$3())', also: [] },
  escframe: { clause: 'E2', dir: 'dist/assets', re: /if\(e\.key==='Escape'\)parent\.postMessage/g, to: "if(e.key==='EscapeX')parent.postMessage", also: [] },
  focus: { clause: 'E4', dir: 'dist/assets', re: /(\w+)\.current&&!(\w+)&&\(\((\w+)=(\w+)\.current\)==null\|\|\3\.focus\(\)\),\1\.current=\2/g, to: '$1.current&&!$2&&0,$1.current=$2', also: [] },
  hover: { clause: 'S0', dir: 'dist/assets', re: /addEventListener\('mouseenter',/g, to: "addEventListener('mouseenterX',", also: ['S1', 'S2'] },
  overlap: { clause: 'S1', dir: 'dist/assets', css: true, re: /\.av-bloc\.is-source>\.av-bloc-tools\{position:static;justify-content:flex-end;margin-bottom:4px\}/g, to: '.av-bloc.is-source>.av-bloc-tools{opacity:1}', also: [] },
  ghost: { clause: 'S0', dir: 'dist/assets', css: true, re: /\.av-bloc-tools\{position:absolute;top:-6px;right:0;z-index:2;display:flex;gap:2px;opacity:0;pointer-events:none;/g, to: '.av-bloc-tools{position:absolute;top:-6px;right:0;z-index:2;display:flex;gap:2px;opacity:0;', also: [] },
  tab: { clause: 'A2', dir: 'dist/assets', re: /scrolling:"no",tabIndex:\w+\?void 0:-1,/g, to: 'scrolling:"no",', also: [] },
  perm: { clause: 'P1', dir: 'dist/assets', css: true, re: /(\.av-permission-backdrop\{[^}]*?)z-index:60;/g, to: '$1z-index:40;', also: [] },
  popover: { clause: 'P4', dir: 'dist/assets', css: true, re: /(\.av-bloc-overlay\{[^}]*?)z-index:50;/g, to: '$1z-index:10;', also: [] },
  askpre: { clause: 'P5', dir: 'dist/assets', re: /\|\|(\w+)&&\1!==(\w+)\)&&/g, to: '||$1)&&', also: [] },
  ask: { clause: 'P2', dir: 'dist/assets', re: /\|\|(\w+)&&\1!==(\w+)\)&&/g, to: ')&&', also: ['P1', 'E5', 'P5'] },
  pane: { clause: 'P3', dir: 'dist/assets', re: /\(!(\w+)\.classList\.contains\("active"\)\|\|/g, to: '(', also: [] },
  srccap: { clause: 'S3', dir: 'dist/assets', re: /done:(\w+)\.length<=(\w+)\}\)/g, to: 'done:!0})', also: [] },
  trap: { clause: 'E7', dir: 'dist/assets', re: /onFocus:(\w+)\("close"\)/g, to: 'onFocus:void 0', also: [] },
  single: { clause: 'L1', dir: 'dist/assets', re: /(\w+)\?h\.jsx\("div",\{style:\{height:(\w+)\},"aria-hidden":!0\}\):h\.jsx\((\w+),\{title:(\w+),source:(\w+),mode:"inline"/g, to: '$1?h.jsx($3,{title:$4,source:$5,mode:"inline",onHeight:()=>{}}):h.jsx($3,{title:$4,source:$5,mode:"inline"', also: [] },
};
function makeMutantCopy(armDir, m) {
  const copy = path.join(armDir, 'app'); fs.mkdirSync(copy, { recursive: true });
  for (const d of ['dist', 'dist-electron']) fs.cpSync(path.join(APP_DIR, d), path.join(copy, d), { recursive: true });
  fs.copyFileSync(path.join(APP_DIR, 'package.json'), path.join(copy, 'package.json'));
  fs.symlinkSync(path.join(APP_DIR, 'node_modules'), path.join(copy, 'node_modules'));
  for (const extra of ['build']) if (fs.existsSync(path.join(APP_DIR, extra))) fs.symlinkSync(path.join(APP_DIR, extra), path.join(copy, extra));
  const files = walk(path.join(copy, m.dir)).filter((f) => f.endsWith('.js') || (m.css && f.endsWith('.css')));
  const hit = files.map((f) => ({ f, n: [...fs.readFileSync(f, 'utf8').matchAll(m.re)].length })).filter((x) => x.n > 0);
  if (hit.length !== 1 || hit[0].n !== 1) throw new Error(`mutation ${m.re} found ${JSON.stringify(hit)} — must be exactly 1 match in 1 file (REFUSED: stale mutant)`);
  const before = fs.readFileSync(hit[0].f, 'utf8'); const after = before.replace(m.re, m.to);
  fs.writeFileSync(hit[0].f, after);
  return { copy, changed: before !== after, detail: `${m.re} -> ${m.to} (1 match in ${path.relative(copy, hit[0].f)}, md5 ${md5(before)} -> ${md5(after)})` };
}

// ── one arm ───────────────────────────────────────────────────────────────────────────────────────
async function runArm(arm) {
  const w = 1400, h = 1000;
  console.log(`\n== arm ${arm}: output ${w}x${h} ==`);
  const armDir = path.join(RIG_DIR, `arm-${arm}`);
  fs.mkdirSync(armDir, { recursive: true });
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
  const key = async (k, code, extra = {}, ms = 20000) => { await cdp.send('Input.dispatchKeyEvent', { type: k === 'Enter' ? 'keyDown' : 'rawKeyDown', key: k, code, ...(k === 'Enter' ? { text: '\r' } : {}), windowsVirtualKeyCode: { Escape: 27, Tab: 9, Enter: 13, ' ': 32 }[k], ...extra }, ms); await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: { Escape: 27, Tab: 9, Enter: 13, ' ': 32 }[k], ...extra }, ms); await sleep(250); };
  const A = (name) => `[aria-label^="${name}"]`;
  // the bloc by its frame/overlay title, as the rig sees it
  const blocState = (title) => cdp.eval(`(() => {
    const t = ${JSON.stringify(title)};
    const bloc = document.querySelectorAll('.av-bloc')[t === ${JSON.stringify(SHORT_TITLE)} ? 0 : 1];
    if (!bloc) return null;
    const r = (e) => { if (!e) return null; const b = e.getBoundingClientRect(); return { left: b.left, top: b.top, width: b.width, height: b.height }; };
    const clip = bloc.querySelector('.av-bloc-clip'), more = bloc.querySelector('.av-bloc-more'), fr = bloc.querySelector('iframe.av-bloc-frame');
    const tools = bloc.querySelector('.av-bloc-tools');
    return { clip: r(clip), clipped: !!clip && clip.classList.contains('is-clipped'), more: more ? { text: more.textContent, expanded: more.getAttribute('aria-expanded'), rect: r(more) } : null,
      frame: r(fr), frames: bloc.querySelectorAll('iframe').length, toolsOpacity: tools ? getComputedStyle(tools).opacity : null,
      code: bloc.querySelector('.av-code-block') ? { text: bloc.querySelector('.av-code-block pre')?.textContent ?? null, shiki: bloc.querySelectorAll('.av-code-shiki span[style*="color"]').length } : null,
      src: bloc.classList.contains('is-source') ? 'true' : 'false',
      srcBtn: r(bloc.querySelector('.av-bloc-tools button:nth-child(1)')), bigBtn: r(bloc.querySelector('.av-bloc-tools button:nth-child(2)')) };
  })()`);
  const active = () => cdp.eval(`(() => { const a = document.activeElement; if (!a) return null; const blocs = [...document.querySelectorAll('.av-bloc')];
    const which = a.tagName === 'IFRAME' ? 'frame' : a.matches('.av-bloc-more') ? 'more' : a.matches('.av-bloc-overlay-head button') ? 'close' : a.matches('.av-bloc-tools button:nth-child(1)') ? 'source' : a.matches('.av-bloc-tools button:nth-child(2)') ? 'enlarge' : 'other';
    return { tag: a.tagName, label: a.getAttribute('aria-label'), which, bloc: blocs.findIndex((b) => b.contains(a)), cls: a.className }; })()`);
  const closeIfOpen = async () => { if (await dialog()) { await cdp.eval(`document.querySelector('.av-bloc-overlay-head button').click(); 1`); await sleep(300); } };
  const dialog = () => cdp.eval(`(() => { const d = document.querySelector('[role="dialog"].av-bloc-overlay-box'); if (!d) return null; const o = d.closest('.av-bloc-overlay'), v = o.closest('.av-view'); const r = (e) => { const b = e.getBoundingClientRect(); return { left: b.left, top: b.top, width: b.width, height: b.height }; };
    const body = d.querySelector('.av-bloc-overlay-body'); const fr = d.querySelector('iframe');
    return { label: d.getAttribute('aria-label'), modal: d.getAttribute('aria-modal'), overlay: r(o), view: v ? r(v) : null, box: r(d), frames: d.querySelectorAll('iframe').length, frameH: fr ? Math.round(fr.getBoundingClientRect().height) : null, scrolls: body.scrollHeight > body.clientHeight, closeLabel: d.querySelector('button')?.getAttribute('aria-label') }; })()`);
  const totalFrames = () => cdp.eval(`document.querySelectorAll('iframe.av-bloc-frame').length`);
  const centre = (r) => ({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
  const step = async (name, fn) => { if (mut?.only && !mut.only.some((p) => name.startsWith(p))) return; /* a mutant that reshapes the page (no clip) only owns its own group: later steps click coordinates it moved */ try { const r = await fn(); clause(arm, name, r.ok, r.detail); } catch (e) { clause(arm, name, false, `STEP THREW: ${String(e.message || e).slice(0, 300)}`); } };
  try {
    const target = await waitFor(async () => { const r = await fetch(`http://127.0.0.1:${port}/json`); const t = (await r.json()).find((x) => x.type === 'page' && x.url.includes('dist/index.html')); return t || null; }, 60000, 'the app page target');
    clause(arm, 'ctl/app-identity-path', target.url.includes(appDir) && !target.url.includes('app.asar'), `target url ${target.url} ⊇ ${appDir}`);
    cdp = await Cdp.connect(target.webSocketDebuggerUrl);
    await cdp.send('Page.enable'); await cdp.send('Accessibility.enable');
    await waitFor(() => cdp.eval(`!!window.__orchestraSetState && !!window.__injectAgentEvent && !!document.querySelector(".toolbar")`), 60000, 'the toolbar + the test seams');
    const environ = fs.readFileSync(`/proc/${app.pid}/environ`, 'utf8').split('\0');
    const ev = (k) => (environ.find((e) => e.startsWith(k + '=')) || '').slice(k.length + 1);
    clause(arm, 'ctl/scratch-env', ev('ORCHESTRA_HOME') === world.ohome && ev('CLAUDE_CONFIG_DIR') === world.cfg && ev('HOME') === world.fakeHome && !environ.some((e) => e.startsWith('DISPLAY=')) && ev('WAYLAND_DISPLAY') === RIG_WAYLAND,
      `app environ: ORCHESTRA_HOME=${ev('ORCHESTRA_HOME')} CLAUDE_CONFIG_DIR=${ev('CLAUDE_CONFIG_DIR')} WAYLAND_DISPLAY=${ev('WAYLAND_DISPLAY')} DISPLAY=${ev('DISPLAY') || '<unset>'}`);
    clause(arm, 'ctl/app-in-my-sway', new RegExp(`"pid":\\s*${app.pid}\\b`).test(sh('swaymsg', ['-t', 'get_tree'])), `app pid ${app.pid} present in my sway's get_tree`);
    const bundle = (await cdp.eval(`[...document.querySelectorAll('script[src]')].map((s) => s.src)`)).find((s) => /assets\/index-.*\.js/.test(s));
    const onDisk = path.join(appDir, 'dist', bundle.split('/dist/')[1]);
    const frameId = (await cdp.send('Page.getResourceTree')).frameTree.frame.id;
    const rc_ = await cdp.send('Page.getResourceContent', { frameId, url: bundle });
    const served = Buffer.from(rc_.content, rc_.base64Encoded ? 'base64' : 'utf8');
    clause(arm, 'ctl/app-identity-bundle', md5(served) === md5(fs.readFileSync(onDisk)), `renderer bundle ${path.basename(bundle)} as served md5 ${md5(served)} == the file in ${appDir}/dist`);
    if (mut) clause(arm, 'ctl/mutation-applied', mutProof.changed, `${mutProof.detail}, applied to a disposable COPY`);

    await cdp.eval(`window.__orchestraSetState(${JSON.stringify({ activeId: WS, view: 'structured' })}); 1`);
    await sleep(500);
    await inject(evText('PROSE-BEFORE\n' + fence(`html-render title="${SHORT_TITLE}"`, SHORT) + '\nPROSE-MIDDLE\n' + fence(`html-render title="${TALL_TITLE}"`, TALL) + '\nPROSE-AFTER\n' + fence('html-render title="Source 50k"', '<p>SMALL</p><!-- ' + 'a'.repeat(50 * 1024) + ' -->') + '\n' + fence('html-render title="Source 70k"', '<p>BIG</p><!-- ' + 'a'.repeat(70 * 1024) + ' -->') + '\nEND'));
    await waitFor(async () => { const t = await blocState(TALL_TITLE), s = await blocState(SHORT_TITLE); return t?.frame && s?.frame && t.frame.height >= TALL_H - 2 && s.frame.height >= SHORT_H - 2 && (await cdp.eval(`document.querySelectorAll('iframe.av-bloc-frame').length`)) === 4; }, 40000, 'all four blocs to have a live frame');
    await cdp.eval(`document.fonts.ready.then(() => true)`);
    const view = await cdp.eval(`(() => { const v = document.querySelector('.av-view.active'); const b = v.getBoundingClientRect(); const s = document.createElement('span'); s.style.color = 'var(--av-assistant)'; v.appendChild(s); const c = getComputedStyle(s).color; s.remove(); const bg = getComputedStyle(v).backgroundColor; return { accent: c, bg, rect: { left: b.left, top: b.top, width: b.width, height: b.height } }; })()`);
    const accent = rgbOf(view.accent);
    // the bloc's TOP (where its actions are) scrolled into view, even when the bloc is taller than the pane
    // the transcript may scroll after our request (smooth / re-anchoring): wait until its scrollTop stops moving before reading any rect
    const scrollSettled = async () => { let prev = -1; for (let i = 0; i < 30; i++) { await sleep(150); const t = await cdp.eval(`(document.querySelector('.av-message-list') || {}).scrollTop ?? -1`); if (t === prev) return; prev = t; } };
    const reveal = async () => { await cdp.eval(`(() => { const b = document.querySelectorAll('.av-bloc')[1]; b.scrollIntoView({ block: 'start' }); const l = b.closest('.av-message-list'); if (l) l.scrollTop -= 60; return 1; })()`); await scrollSettled(); };
    // the transcript may re-follow after a frame reports a new height: retry until the actions are on screen
    const reveal2 = async () => { for (let i = 0; i < 6; i++) { await reveal(); const t = (await blocState(TALL_TITLE))?.srcBtn; if (t && t.top >= 0 && t.top < h - 60) return; } };
    await reveal2(); await sleep(300);
    const mouseAway = () => cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: h - 5 });
    await mouseAway(); await sleep(400);

    // ── C: clip + fade + « Afficher tout » ──
    await step('C2/short-bloc-is-not-clipped-and-has-no-control', async () => {
      const s = await blocState(SHORT_TITLE);
      return { ok: !s.clipped && !s.more && Math.abs(s.frame.height - SHORT_H) <= 2, detail: `${SHORT_H}px bloc: clipped=${s.clipped}, « Afficher tout » present=${!!s.more}, iframe ${s.frame.height}px` };
    });
    let tall;
    await step('C1/tall-bloc-is-clipped-with-fade-and-afficher-tout', async () => {
      tall = await blocState(TALL_TITLE);
      const buf = await cdp.shot(); saveShot('1-clipped.png', buf);
      const I = decodePng(buf), c = tall.clip;
      const top = px(I, c.left + c.width * 0.5, c.top + 120), bottom = px(I, c.left + c.width * 0.85, c.top + c.height - 3);
      const ok = !!tall.clip && Math.abs(tall.clip.height - CAP) <= 2 && tall.frame.height >= TALL_H - 2 && tall.clipped && tall.more?.text === 'Afficher tout' && tall.more.expanded === 'false' && near(top, accent, 5) && !near(bottom, accent, 40);
      return { ok, detail: `content ${tall.frame.height}px clipped to ${Math.round(tall.clip.height)}px, control "${tall.more?.text}" aria-expanded=${tall.more?.expanded}; pixels: body rgb(${top}) = accent rgb(${accent}), clip bottom edge rgb(${bottom}) faded away from it` };
    });
    await step('C3/afficher-tout-expands-in-place', async () => {
      const m = tall.more.rect; await cdp.click(m.left + m.width / 2, m.top + m.height / 2); await sleep(500);
      const s = await blocState(TALL_TITLE), a = await active();
      const buf = await cdp.shot(); saveShot('2-expanded.png', buf);
      const ok = !s.clipped && Math.abs(s.clip.height - TALL_H) <= 2 && s.more?.text === 'Réduire' && s.more.expanded === 'true' && a.which === 'more';
      return { ok, detail: `after click: clip ${Math.round(s.clip.height)}px (content ${TALL_H}px), clipped=${s.clipped}, control "${s.more?.text}" aria-expanded=${s.more?.expanded}, focus stays on the control (${a.cls})` };
    });
    await step('C3b/reduire-clips-again', async () => {
      // « Réduire » sits BELOW the 1300px frame: scroll it into view before a trusted click (a click at off-screen coordinates hits nothing)
      await cdp.eval(`document.querySelectorAll('.av-bloc')[1].querySelector('.av-bloc-more').scrollIntoView({ block: 'center' }); 1`); await scrollSettled();
      const s0 = await blocState(TALL_TITLE); const m = s0.more.rect; await cdp.click(m.left + m.width / 2, m.top + m.height / 2); await sleep(400);
      const s = await blocState(TALL_TITLE);
      return { ok: s.clipped && Math.abs(s.clip.height - CAP) <= 2 && s.more?.text === 'Afficher tout', detail: `after « Réduire »: clipped=${s.clipped}, ${Math.round(s.clip.height)}px, control "${s.more?.text}"` };
    });
    await mouseAway();

    // ── S: source ──
    await step('S0/actions-are-hover-revealed', async () => {
      await reveal2(); await cdp.eval(`document.activeElement && document.activeElement.blur(); 1`);
      const t0 = await blocState(TALL_TITLE); await mouseAway(); await sleep(300); const off = (await blocState(TALL_TITLE)).toolsOpacity;
      // hidden actions must not steal a click meant for the bloc: the element under the (invisible) source button is NOT the button
      const ghost = await cdp.eval(`(() => { const b = document.querySelectorAll('.av-bloc')[1].querySelector('.av-bloc-tools button'); const r = b.getBoundingClientRect(); const e = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return !!e && !e.closest('.av-bloc-tools'); })()`);
      const c = centre(t0.clip); await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: c.x, y: c.y }); await sleep(400);
      const on = (await blocState(TALL_TITLE)).toolsOpacity;
      const sb = centre(t0.srcBtn); await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: sb.x, y: sb.y }); await sleep(400);
      const onTools = (await blocState(TALL_TITLE)).toolsOpacity;
      const hit = await cdp.eval(`(() => { const e = document.elementFromPoint(${sb.x}, ${sb.y}); return e ? e.tagName + '.' + e.className : null; })()`);
      const hov = await cdp.eval(`(() => { const b = document.querySelectorAll('.av-bloc')[1]; return b.matches(':hover'); })()`);
      await mouseAway(); await sleep(300);
      return { ok: off === '0' && on === '1' && ghost === true, detail: `hidden actions let clicks through to the bloc: ${ghost}; tools opacity: pointer away ${off}, pointer over the frame ${on}, over the source button ${onTools} (.av-bloc:hover=${hov}, element at the button ${hit}, button rect ${JSON.stringify(t0.srcBtn)})` };
    });
    await step('S1/source-toggle-shows-the-model-html-highlighted', async () => {
      await reveal2();
      const s0 = await blocState(TALL_TITLE); const b = centre(s0.srcBtn); await cdp.click(b.x, b.y); await sleep(500);
      let s = await blocState(TALL_TITLE);
      await waitFor(async () => (await blocState(TALL_TITLE)).code?.shiki > 0, 10000, 'the highlighter to colour the source').catch(() => {});
      s = await blocState(TALL_TITLE);
      saveShot('3-source.png', await cdp.shot());
      const copy = await cdp.eval(`(() => { const c = document.querySelectorAll('.av-bloc')[1].querySelector('.av-code-copy'); if (!c) return null; const r = c.getBoundingClientRect(); const e = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return e === c; })()`);
      return { ok: !!s.code && s.code.text === TALL && s.code.shiki > 0 && s.frames === 0 && s.src === 'true' && copy === true, detail: `(code block's Copy button reachable, not covered by the actions: ${copy}) source view: code block text === the model's HTML (${s.code?.text === TALL}), ${s.code?.shiki} colour-styled token spans (highlighted), iframes in the bloc ${s.frames}, aria-pressed=${s.src}` };
    });
    await step('S2/source-toggles-back-to-the-render', async () => {
      await reveal2();
      const s0 = await blocState(TALL_TITLE); const b = centre(s0.srcBtn); await cdp.click(b.x, b.y);
      await waitFor(async () => { const s = await blocState(TALL_TITLE); return s?.frame && s.frame.height >= TALL_H - 2; }, 20000, 'the frame back');
      const s = await blocState(TALL_TITLE);
      return { ok: !s.code && s.frames === 1 && s.src === 'false', detail: `back: code block ${!!s.code}, iframes ${s.frames}, aria-pressed=${s.src}` };
    });

    // ── A: keyboard + screen reader ──
    await step('A1/actions-have-screen-reader-names', async () => {
      const { nodes } = await cdp.send('Accessibility.getFullAXTree');
      const named = (role) => nodes.filter((n) => n.role?.value === role && !n.ignored).map((n) => n.name?.value).filter(Boolean);
      const buttons = named('button');
      const want = [`Afficher le source : ${TALL_TITLE}`, `Agrandir : ${TALL_TITLE}`, `Afficher le source : ${SHORT_TITLE}`, `Agrandir : ${SHORT_TITLE}`, `Afficher tout : ${TALL_TITLE}`];
      const missing = want.filter((x) => !buttons.includes(x));
      const frames = nodes.filter((n) => (n.role?.value === 'Iframe' || n.role?.value === 'iframe') && !n.ignored).map((n) => n.name?.value);
      return { ok: missing.length === 0, detail: `accessibility tree buttons ⊇ ${JSON.stringify(want)} (missing: ${JSON.stringify(missing)}); frames named ${JSON.stringify(frames.filter((x) => x === TALL_TITLE || x === SHORT_TITLE))}` };
    });
    await step('A2/actions-reachable-and-operable-by-keyboard-alone', async () => {
      await cdp.eval(`document.activeElement && document.activeElement.blur(); 1`); await reveal2();
      const seen = []; let reached = null, n = 0;
      // from the document start, Tab until the first action of the tall bloc is focused (the page is a real app: other controls come first)
      await cdp.eval(`window.getSelection().removeAllRanges(); document.body.focus(); 1`);
      const startEl = await cdp.eval(`(() => { const b = document.querySelectorAll('.av-bloc')[1].querySelector('.av-bloc-tools button'); const prev = [...document.querySelectorAll('button, a[href], input, textarea, [tabindex="0"]')].filter((e) => e.getClientRects().length && (b.compareDocumentPosition(e) & Node.DOCUMENT_POSITION_PRECEDING)); const p = prev[prev.length - 1]; if (!p) return null; p.focus(); return p.tagName + '.' + p.className; })()`);
      for (n = 0; n < 8; n++) { await key('Tab', 'Tab'); const a = await active(); seen.push(`${a.which}@${a.bloc}`); if (a.which === 'source' && a.bloc === 1) { reached = a; break; } }
      const shown = (await blocState(TALL_TITLE)).toolsOpacity; // focus-within reveals the quiet actions
      await key('Tab', 'Tab'); const second = await active();
      await key('Tab', 'Tab'); const third = await active();
      await key('Tab', 'Tab', { modifiers: 8 }); const back = await active(); // Shift+Tab
      // Enter on the focused « Agrandir » operates it
      await cdp.eval(`document.querySelectorAll('.av-bloc')[1].querySelector('.av-bloc-tools button:nth-child(2)').focus(); 1`);
      await key('Enter', 'Enter'); await sleep(400);
      const opened = !!(await dialog());
      await closeIfOpen();
      return { ok: !!reached && shown === '1' && second.which === 'enlarge' && third.which === 'more' && back.which === 'enlarge' && opened, detail: `Tab from ${startEl}: ${JSON.stringify(seen)} → the source action reached by Tab (tools opacity ${shown} on focus); next Tab → ${second.which}, then ${third.which} (a clipped bloc's frame is skipped: « Afficher tout » is next); Shift+Tab → ${back.which}; Enter on the enlarge action opened the dialog=${opened}` };
    });

    // ── L / E: enlarge ──
    const beforeFrames = await totalFrames();
    let bigBtn;
    await step('L1/enlarged-bloc-keeps-ONE-live-frame', async () => {
      await closeIfOpen();
      await reveal2(); const s0 = await blocState(TALL_TITLE); bigBtn = centre(s0.bigBtn); await cdp.click(bigBtn.x, bigBtn.y);
      await waitFor(async () => (await dialog())?.frames === 1 && (await dialog()).frameH > 100, 20000, 'the overlay frame to render');
      await sleep(600);
      const d = await dialog(), s = await blocState(TALL_TITLE), total = await totalFrames(), a = await active();
      saveShot('4-enlarged.png', await cdp.shot());
      return { ok: total === beforeFrames && d.frames === 1 && s.frames === 0, detail: `live iframes in the page: ${beforeFrames} before → ${total} while enlarged (overlay ${d.frames}, inline copy ${s.frames}) — the inline frame is unmounted, not doubled` };
    });
    await step('E0/overlay-covers-the-conversation-as-a-named-modal-dialog', async () => {
      const d = await dialog(), a = await active();
      const cover = d && d.view && Math.abs(d.overlay.left - d.view.left) < 2 && Math.abs(d.overlay.top - d.view.top) < 2 && Math.abs(d.overlay.width - d.view.width) < 2 && Math.abs(d.overlay.height - d.view.height) < 2;
      const { nodes } = await cdp.send('Accessibility.getFullAXTree');
      const dlg = nodes.find((n) => n.role?.value === 'dialog' && !n.ignored && n.name?.value === TALL_TITLE);
      return { ok: !!d && d.modal === 'true' && d.label === TALL_TITLE && cover && !!dlg && d.frameH >= TALL_H - 2 && d.scrolls && a.which === 'close' && d.closeLabel === `Fermer (Échap) : ${TALL_TITLE}`, detail: `close control named "${d?.closeLabel}", dialog aria-modal=${d?.modal}, AX dialog named "${dlg?.name?.value}", overlay rect = the conversation pane rect (${cover}), enlarged frame ${d?.frameH}px of ${TALL_H}px and the body scrolls (${d?.scrolls}), focus moved to the ${a.which} control` };
    });
    await step('E1/escape-in-the-page-closes-the-overlay', async () => {
      await key('Escape', 'Escape'); const d = await dialog(); const stuck = !!d; await closeIfOpen();
      return { ok: !stuck, detail: `Escape with focus on the close control → dialog ${stuck ? 'STILL OPEN' : 'gone'}` };
    });
    const returned = [];
    const focusReturn = async (how) => { await sleep(300); const a = await active(); returned.push(`${how}: ${a.which}@${a.bloc}`); return a.which === 'enlarge' && a.bloc === 1; };
    let ok1 = await focusReturn('Escape'); let ok2 = false, ok3 = false;
    await step('E2/escape-with-focus-INSIDE-the-frame-closes-the-overlay', async () => {
      await closeIfOpen();
      await reveal2(); const s0 = await blocState(TALL_TITLE); const c = centre(s0.bigBtn); await cdp.click(c.x, c.y);
      await waitFor(async () => (await dialog())?.frames === 1, 20000, 'the overlay'); await sleep(600);
      const inner = await cdp.eval(`(() => { const f = document.querySelector('[role="dialog"] iframe'); const b = f.getBoundingClientRect(); return { x: b.left + 40, y: b.top + 20 }; })()`);
      await cdp.click(inner.x, inner.y); await sleep(300);
      const inFrame = await cdp.eval(`document.activeElement && document.activeElement.tagName === 'IFRAME'`);
      let ack = 'acked'; await key('Escape', 'Escape', {}, 4000).catch((e) => { ack = String(e.message).slice(0, 60); });
      await sleep(500); const d = await dialog(); const stuck = !!d; await closeIfOpen();
      ok2 = await focusReturn('Escape in the frame');
      return { ok: inFrame === true && !stuck, detail: `a trusted click inside the frame made it the active element (${inFrame}); Escape pressed there (CDP ${ack}) → dialog ${stuck ? 'STILL OPEN' : 'gone'}` };
    });
    await step('E3/close-control-closes-the-overlay', async () => {
      await closeIfOpen();
      await reveal2(); const s0 = await blocState(TALL_TITLE); const c = centre(s0.bigBtn); await cdp.click(c.x, c.y);
      await waitFor(async () => (await dialog())?.frames === 1, 20000, 'the overlay'); await sleep(400);
      const cb = await cdp.eval(`(() => { const b = document.querySelector('[role="dialog"] .av-bloc-overlay-head button').getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; })()`);
      await cdp.click(cb.x, cb.y); const d = await dialog(); ok3 = await focusReturn('close control');
      return { ok: d === null, detail: `click on « Fermer » → dialog ${d ? 'STILL OPEN' : 'gone'}` };
    });
    await step('E4/focus-returns-to-the-bloc-after-every-way-of-closing', async () => {
      const f = await blocState(TALL_TITLE);
      return { ok: ok1 && ok2 && ok3 && f.frames === 1 && f.frame.height >= TALL_H - 2, detail: `focused element after closing — ${returned.join(' · ')} (want the bloc's own enlarge action: enlarge@1); inline frame back (${f.frames}) at ${Math.round(f.frame.height)}px` };
    });
    await step('E7/tab-stays-inside-the-open-dialog', async () => {
      await closeIfOpen();
      await reveal2(); const s0 = await blocState(TALL_TITLE); const c = centre(s0.bigBtn); await cdp.click(c.x, c.y);
      await waitFor(async () => (await dialog())?.frames === 1, 20000, 'the overlay'); await sleep(400);
      const seen = [];
      for (let i = 0; i < 6; i++) { await key('Tab', 'Tab'); seen.push(await cdp.eval(`(() => { const a = document.activeElement; return a && a.closest('.av-bloc-overlay') ? 'in' : 'OUT:' + (a ? a.tagName + '.' + a.className : 'null'); })()`)); }
      await key('Tab', 'Tab', { modifiers: 8 }); await key('Tab', 'Tab', { modifiers: 8 });
      const back = await cdp.eval(`(() => { const a = document.activeElement; return a && a.closest('.av-bloc-overlay') ? 'in' : 'OUT:' + (a ? a.tagName : 'null'); })()`);
      await closeIfOpen();
      return { ok: seen.every((x) => x === 'in') && back === 'in', detail: `6 Tab presses then 2 Shift+Tab inside the open dialog → focus locations ${JSON.stringify(seen)} / ${back}` };
    });
    const openBloc1 = async () => { await closeIfOpen(); await cdp.eval(`document.querySelectorAll('.av-bloc')[1].querySelector('.av-bloc-tools button:nth-child(2)').click(); 1`); await waitFor(async () => (await dialog())?.frames === 1, 20000, 'the overlay'); await sleep(300); };
    await step('P4/composer-popover-does-not-paint-over-the-overlay', async () => {
      await closeIfOpen(); await sleep(300);
      await openBloc1();
      await cdp.eval(`document.querySelector('.cm-content').focus(); 1`);
      await cdp.send('Input.insertText', { text: '/' }); await sleep(800);
      const pop = await cdp.eval(`(() => { const p = document.querySelector('.av-ac'); if (!p) return null; const r = p.getBoundingClientRect(); const e = document.elementFromPoint(r.left + Math.min(40, r.width / 2), r.top + r.height / 2); return { shown: r.width > 0 && r.height > 0, over: !!e && !!e.closest('.av-bloc-overlay'), z: getComputedStyle(p).zIndex, el: e ? e.tagName + '.' + e.className : null, perm: !!document.querySelector('.av-permission-backdrop') }; })()`);
      return { ok: !!pop && pop.shown && pop.over, detail: `slash popover (z-index ${pop?.z}) is open (control: ${pop?.shown}); the element under its centre belongs to the overlay (the popover is NOT painted over it)=${pop?.over} [element there: ${pop?.el}; permission backdrop still up: ${pop?.perm}]` };
    });
    await step('S3/long-source-is-plain-above-the-cap-and-highlighted-below', async () => {
      await closeIfOpen();
      const view = (i) => cdp.eval(`(() => { const b = document.querySelectorAll('.av-bloc')[${i}]; b.scrollIntoView({ block: 'center' }); b.querySelector('.av-bloc-tools button:nth-child(1)').click(); return 1; })()`);
      const read = (i) => cdp.eval(`(() => { const b = document.querySelectorAll('.av-bloc')[${i}]; return { plain: !!b.querySelector('.av-code-plain'), shiki: b.querySelectorAll('.av-code-shiki span[style*="color"]').length, len: (b.querySelector('.av-code-block pre')?.textContent ?? '').length }; })()`);
      await view(2); await sleep(1500); const small = await read(2); await view(2); await sleep(300);
      await view(3); await sleep(1500); const big = await read(3); await view(3); await sleep(300);
      return { ok: small.shiki > 0 && !small.plain && big.plain && big.shiki === 0 && big.len > 70 * 1024, detail: `50 KiB source: ${small.shiki} highlighted spans (plain=${small.plain}); 70 KiB source: plain mono=${big.plain}, ${big.shiki} spans, ${big.len} chars shown in full` };
    });
    await step('P3/overlay-closes-when-its-pane-stops-being-active', async () => {
      await openBloc1();
      await cdp.eval(`window.__orchestraSetState(${JSON.stringify({ view: 'diff' })}); 1`); await sleep(600);
      const inactive = await cdp.eval(`!document.querySelector('.av-view.active')`);
      const open = !!(await dialog());
      await cdp.eval(`window.__orchestraSetState(${JSON.stringify({ activeId: WS, view: 'structured' })}); 1`); await sleep(600);
      const back = await cdp.eval(`!!document.querySelector('.av-view.active')`);
      return { ok: inactive && back && !open, detail: `view switched away: the pane inactive=${inactive} (control), overlay still open=${open}; pane back=${back}` };
    });
    await step('P2/overlay-closes-when-an-AskUserQuestion-arrives', async () => {
      await openBloc1();
      await inject({ type: 'permission-request', seq: SEQ++, at: at(), requestId: 'rq-ask', toolUseId: null, name: 'AskUserQuestion', input: { questions: [{ question: 'Which?', header: 'Pick', options: [{ label: 'A', description: 'a' }, { label: 'B', description: 'b' }], multiSelect: false }] } });
      await waitFor(() => cdp.eval(`!!document.querySelector('.av-q')`), 20000, 'the AskUserQuestion card'); await sleep(600);
      const open = !!(await dialog());
      const hit = await cdp.eval(`(() => { const q = document.querySelector('.av-q'); const b = q.querySelector('button'); const r = b.getBoundingClientRect(); const e = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return !!e && !!e.closest('.av-q'); })()`);
      await key('Escape', 'Escape'); await waitFor(() => cdp.eval(`!document.querySelector('.av-q')`), 10000, 'the question to be dismissed');
      return { ok: !open && hit, detail: `AskUserQuestion card up: overlay still open=${open}, its first button reachable (element under it is inside the card)=${hit}` };
    });
    await step('P5/a-pending-AskUserQuestion-does-not-block-enlarging', async () => {
      await closeIfOpen();
      await inject({ type: 'permission-request', seq: SEQ++, at: at(), requestId: 'rq-ask2', toolUseId: null, name: 'AskUserQuestion', input: { questions: [{ question: 'Which again?', header: 'Pick', options: [{ label: 'A', description: 'a' }, { label: 'B', description: 'b' }], multiSelect: false }] } });
      await waitFor(() => cdp.eval(`!!document.querySelector('.av-q')`), 20000, 'the pending question'); await sleep(400);
      await cdp.eval(`document.querySelectorAll('.av-bloc')[1].querySelector('.av-bloc-tools button:nth-child(2)').click(); 1`);
      await sleep(900);
      const open = !!(await dialog());
      await closeIfOpen();
      await key('Escape', 'Escape'); await waitFor(() => cdp.eval(`!document.querySelector('.av-q')`), 10000, 'the question to be dismissed');
      return { ok: open, detail: `AskUserQuestion already pending, « Agrandir » → overlay open=${open} (a question that was there first must not make the action a silent no-op); then closed and the question dismissed` };
    });
    await step('P1/permission-dialog-stays-reachable-above-an-enlarged-bloc', async () => {
      await openBloc1();
      await inject({ type: 'permission-request', seq: SEQ++, at: at(), requestId: 'rq-esc', toolUseId: null, name: 'Bash', input: { command: 'ls' } });
      await waitFor(() => cdp.eval(`!!document.querySelector('.av-permission-dialog')`), 20000, 'the permission dialog'); await sleep(500);
      const r = await cdp.eval(`(() => { const d = document.querySelector('.av-permission-dialog'); const pts = [d, ...d.querySelectorAll('button')].map((b) => { const r = b.getBoundingClientRect(); const e = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return !!e && !!e.closest('.av-permission-dialog'); }); return { n: pts.length, ok: pts.every(Boolean) }; })()`);
      saveShot('5-permission-over-enlarged.png', await cdp.shot());
      return { ok: r.ok && r.n >= 3 && !!(await dialog()), detail: `overlay open + permission pending: the dialog and its ${r.n - 1} buttons are the elements under their own centres=${r.ok}` };
    });
    await step('E5/escape-does-not-reach-a-pending-permission-dialog', async () => {
      const d0 = await dialog(), perm0 = await cdp.eval(`!!document.querySelector('.av-permission-dialog')`);
      await key('Escape', 'Escape');
      const d = await dialog(), perm = await cdp.eval(`!!document.querySelector('.av-permission-dialog')`);
      return { ok: !!d0 && perm0 && d === null && perm === true, detail: `permission pending (${perm0}) + overlay open (${!!d0}), Escape → overlay ${d ? 'STILL OPEN' : 'gone'}, permission still pending=${perm} (Escape there means DENY: it must not leak)` };
    });
    await step('E6/the-overlay-never-doubles-live-frames-and-the-page-is-back-to-its-count', async () => {
      const total = await totalFrames();
      return { ok: total === beforeFrames, detail: `live iframes after all open/close cycles: ${total} (start ${beforeFrames})` };
    });

    await closeIfOpen();
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
console.log(`[rig] app ${APP_DIR} arms ${ARMS.join(',')} out=${OUT}`);
for (const arm of ARMS) { if (arm !== 'real' && !MUTANTS[arm]) refuse(`unknown arm ${arm}`); await runArm(arm); }
const after = liveCanary();
const same = JSON.stringify(before) === JSON.stringify(after);
clause('rig', 'ctl/live-claude-dirs-untouched', same, `${Object.keys(before).length} live ~/.claude* dirs, symlink-set + mcpServers hashes ${same ? 'identical before/after' : 'CHANGED: ' + JSON.stringify({ before, after })}`);

const lines = []; let rc = 0;
const isCtl = (c) => /^(ctl|rig)\//.test(c.clause);
for (const arm of ARMS) {
  const mine = results.filter((c) => c.arm === arm);
  const ctlRed = mine.filter((c) => isCtl(c) && !c.ok).map((c) => c.clause);
  if (arm === 'real') {
    const red = mine.filter((c) => !c.ok).map((c) => c.clause);
    lines.push(`real: ${red.length === 0 ? 'ALL GREEN' : 'RED ' + red.join(', ')} (${mine.length} clauses)`);
    if (red.length) rc = 1;
  } else {
    const want = MUTANTS[arm].clause, also = MUTANTS[arm].also;
    const named = mine.find((c) => c.clause.startsWith(want + '/'));
    const others = mine.filter((c) => !isCtl(c) && !c.clause.startsWith(want + '/') && !also.some((a) => c.clause.startsWith(a + '/')) && !c.ok).map((c) => c.clause);
    const ok = !!named && !named.ok && ctlRed.length === 0 && others.length === 0 && mine.length > 0;
    lines.push(`${arm}: ${ok ? 'MUST-FAIL CONFIRMED' : 'NOT CONFIRMED'} — ${want} ${named ? (named.ok ? 'stayed GREEN' : 'RED') : 'not evaluated'}; other clauses red: ${others.join(',') || 'none'} (allowed: ${also.join(',') || 'none'}); controls red: ${ctlRed.join(',') || 'none'}`);
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
