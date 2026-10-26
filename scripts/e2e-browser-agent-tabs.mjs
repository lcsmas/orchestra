// #397 — agent tabs through the CDP proxy, END TO END on a BUILT Orchestra inside the contained rig's own headless sway:
// the REAL `orchestra browser tab ...` CLI → host `/browser` route (ADR 0008 identity) → per-workspace loopback proxy → the pinned agent-browser
// daemon → the REAL panel tabs (WebContentsViews). TWO seeded workspaces (W1 focused with its Browser pane open, W2 in the background) and the
// shared fixture site (tabs-a/b/c: red/green/blue pages with distinct titles; cli.html / index.html for the ref arm).
// Every page/registry assertion reads an INDEPENDENT oracle: the app's own state IPC (the tab registry), a second CDP client on the page through
// the app's debug port, and COMPOSITOR PIXELS (grim on the rig's own sway) — never the CLI/proxy chain under test.
//
//   restart     SIGKILL the app, boot it again: restored tabs keep their opener; a stale agent-browser id (session-local, renumbered) that now names the user's tab cannot close it
//   open        `tab new` → an AGENT tab, shown (pixels), marked in the strip, the human is told; `tab list` says who opened which
//   switch      `tab <ref>` to the user's tab: shown, announced, no keyboard-focus steal; « Back » (a human op) restores and clears the notice
//   front       ANY acting command (get url — not frame-bound) on a non-active tab brings it to the front, visibly; `tab list` / idle do not
//   children    the close verbs are refused on a CHILD (worker / frame) session of the user's tab (raw client, auto-attach, then navigate)
//   attach      a PAGE of an agent tab spawns a worker + cross-site iframe while the human is on ANOTHER tab: the daemon's attach-time commands on the new child sessions must not flip the human's tab
//   strip       8 tabs x {agent early, agent last, mixed} x two pane widths: every tab / x / + is the control at its own centre, no x leaves its tab, a REAL click on + at the cap shows the cap notice and closes nothing
//   cap         the 8-tab cap is shared with the human and applies to agent-opened tabs; a refusal leaks no view
//   ownership   `tab close <user's tab>` is refused BEFORE agent-browser (it would print "closed" and drop the tab from its own list), the
//               tab stays loaded, the next `tab list` still has it, the agent's own tab still closes; the PROXY refuses a raw Target.closeTarget too
//   background  W2 (not on screen): tab new / switch / open never activate, attach or show anything, W1's pane is untouched; on arrival W2 shows the user's tab
//   refs        a ref from a tab the user switched away from still clicks THAT tab (brought to the front); after an explicit switch it is a stale ref
//
// Usage (via scripts/e2e-browser-agent-tabs.sh): <app-dir> --live-home <real $HOME> [--arm a,b] [--list] [--mutant <name>] [--out dir]
//   --mutant <name>: patch the BUILT bundle in place (byte-exact backup, `cmp`-verified restore), run, and require the mutant's arms RED and every ctl/* clause GREEN.
import { execFileSync, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import zlib from 'node:zlib';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { WebSocket as WS } from 'ws';
import { abLayout } from '../src/main/agent-browser-daemon.ts';
import { privateRuntimeDir } from './lib/rig-runtime.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };

// ── arms and mutants (single source of truth for --list, the .sh wrapper and the verdict) ───────────────────────────────────────
// `restart` runs FIRST: the agent-browser daemon still numbers its tabs t1..t3 (ids are never reused within a session), so the stale-id collision is engineered; it kills and re-boots the app, every later arm runs on boot 2.
const ARMS = ['restart', 'open', 'switch', 'front', 'cap', 'strip', 'ownership', 'children', 'attach', 'background', 'refs'];
/** Mutants patch the BUILT bundle in place. `file`: 'chunk' = the main-process chunk main.js requires, 'cli' = dist-electron/cli.js.
 *  Each edit is a regex/string that must match EXACTLY once; `arms` must go RED, every ctl/* clause of those arms must stay GREEN. */
const MUTANTS = {
  'cap-bypass': { file: 'chunk', edits: [[/return (\w+)\.openCount<(\w+)\?\{ok:!0\}:\{ok:!1,reason:"cap"/, 'return $1.openCount<$2||$1.opener==="agent"?{ok:!0}:{ok:!1,reason:"cap"']], arms: ['cap'], why: 'the cap no longer applies to agent-opened tabs' },
  'close-any-tab': { file: 'chunk', edits: [[/,(\w+)=(\w+)\((\w+),(\w+),(\w+)\)(?=,\w+=\1\.ok&&\w+&&\w+===\3\?)/, ',$1=$2($3,$4,"human")']], arms: ['ownership'], why: 'the proxy closes a tab the user opened (agent closes as the human)' },
  'preflight-off': { file: 'cli', edits: [['if (!verdict.run) {', 'if (false) {']], arms: ['ownership', 'restart'], why: 'the CLI hands a forbidden `tab close` to agent-browser, which prints "closed" and forgets the tab' },
  'list-unannotated': { file: 'cli', edits: [['if (tab.op === "list" && run.code === 0 && abTabs && hostTabs.length > 0) {', 'if (false) {']], arms: ['open'], why: '`tab list` no longer says who opened each tab' },
  'no-front-on-acting': { file: 'chunk', edits: [[/(\w+)\((\w+)\)&&this\.bringToFrontIfBackground\((\w+)\),(?=\w+\.has\(\2\))/, '']], arms: ['front', 'refs'], why: 'only frame-bound commands bring a tab to the front: a get/eval/snapshot on a tab the user is not looking at runs invisibly' },
  'no-front-at-all': { file: 'chunk', edits: [[/(\w+)\((\w+)\)&&this\.bringToFrontIfBackground\((\w+)\),(?=\w+\.has\(\2\))/, ''], [/(async screenshot\(\w+,\w+,\w+\)\{)this\.bringToFrontIfBackground\(\w+\);/, '$1']], arms: ['front', 'refs'], why: 'not even a screenshot brings its tab to the front: the capture of a tab the user left is refused as "not on screen"' },
  'switch-unannotated': { file: 'cli', edits: [['(tab.op === "list" || tab.op === "close" || tab.op === "switch")', '(tab.op === "list" || tab.op === "close")']], arms: ['restart'], why: 'a `tab <ref>` switch no longer says whose tab it landed on: a stale tN silently drives the user\'s tab' },
  'child-close-allowed': { file: 'chunk', edits: [[/return ([\w$]+)\(n\)\?n==="Page\.close"\?this\.browserCommand\(t,"Target\.closeTarget",\{targetId:this\.targetIdFor\(i\)\}\):this\.browserCommand\(t,n,r\):this\.tabCommand\(i,n,r,a\)/, 'return $1(n)&&!a?n==="Page.close"?this.browserCommand(t,"Target.closeTarget",{targetId:this.targetIdFor(i)}):this.browserCommand(t,n,r):this.tabCommand(i,n,r,a)']], arms: ['children'], why: '#395\'s shared browser-level predicate is skipped for a CHILD (worker / frame) session: its Page.close / Browser.* / Target.* reach the page debugger' },
  'attach-is-acting': { file: 'chunk', edits: [[/function ([\w$]+)\((\w+)\)\{return\/\\\.\(enable\|disable\)\$\/\.test\(\2\)\?!1:![\w$]+\.has\(\2\)\}/, 'function $1($2){return!0}']], arms: ['attach'], why: 'attach-time commands on a child session count as agent ACTIONS: a page that spawns an iframe / worker flips the human\'s tab with no agent command' },
  'agent-badge-wide': { file: 'css', edits: [[/\.browser-tab-agent-mark\{[^}]*\}/, '.browser-tab-agent-mark{flex:0 0 auto;padding:0 4px;font-size:9.5px;line-height:14px;letter-spacing:.04em;text-transform:uppercase;color:var(--accent);border:1px solid color-mix(in srgb,var(--accent) 45%,transparent);border-radius:3px}']], arms: ['strip'], why: 'the agent mark is a ~38 px text badge again: at 6-8 tabs every agent tab\'s × overflows its tab (and a click on the + closes a tab)' },
  'notice-over-strip': { file: 'css', edits: [['.browser-agent-switch{display:flex;', '.browser-agent-switch{position:fixed;left:0;top:50px;width:100%;height:34px;z-index:5;box-sizing:border-box;display:flex;']], arms: ['open'], why: 'the swap notice is an overlay over the tab strip: it covers tabs / × / + (a click aimed at « Back » can close a human tab)' },
  'notice-over-toolbar': { file: 'css', edits: [['.browser-agent-switch{display:flex;', '.browser-agent-switch{position:fixed;left:0;top:88px;width:100%;height:38px;z-index:5;box-sizing:border-box;display:flex;']], arms: ['open'], why: 'the swap notice is an overlay over the toolbar row: it covers the URL input and the design button' },
  'ref-spelling-exact': { file: 'cli', edits: [['const normRef = (r) => r.trim().toLowerCase();', 'const normRef = (r) => r;']], arms: ['ownership'], why: 'the CLI gate matches refs exactly: `tab close T1` / ` t1 ` slip past it, agent-browser normalises and prints "closed" (the lie + desync the pre-flight exists to stop)' },
  'destroyers-allowed': { file: 'chunk', edits: [[/if\((\w+)\.has\((\w+)\)\)\{const (\w+)=this\.port\.listTabs\(\)\.find\((\w+)=>\4\.id===(\w+)\);if\(\3&&\3\.openedBy!=="agent"\)throw new/, 'if(!1){const $3=this.port.listTabs().find($4=>$4.id===$5);if($3&&$3.openedBy!=="agent")throw new']], arms: ['ownership'], why: 'Page.crash / Runtime.terminateExecution reach the USER\'s tab renderer through the proxy' },
  'silent-swap': { file: 'chunk', edits: [[/(\w+)\.agentSwitch=\{from:(\w+)===(\w+)\.id\?(\w+):\2,to:\3\.id,at:Date\.now\(\)\}/, 'void 0']], arms: ['open', 'front'], why: 'an agent swap of the tab on screen is not announced to the human' },
  'background-activates': { file: 'chunk', edits: [[/(\.\.\.\w+\.url\?\{url:\w+\.url\}:\{\},openedBy:\w+,)activate:\w+===\w+\}/, '$1activate:!0}'], [/\.wsFocused\?\{act:"activate"\}:\{act:"none",reason:"background-workspace"\}/, '.wsFocused||!0?{act:"activate"}:{act:"none",reason:"background-workspace"}']], arms: ['background'], why: 'a background workspace\'s agent activates tabs (the focus rule is gone)' },
  'stale-map': { file: 'cli', edits: [['const STALE_PATTERNS = [/Could not locate element with role=/i, /Unknown ref:/i, /stale ref/i, /no longer (?:attached|exists)/i];', 'const STALE_PATTERNS = [];']], arms: ['refs'], why: 'a ref from another tab is reported as agent-browser\'s raw error, not browser_stale_ref' },
};
if (argv.includes('--list')) {
  console.log(`arms: ${ARMS.join(' ')}`);
  console.log(`mutants: ${Object.keys(MUTANTS).join(' ')}`);
  process.exit(0);
}

const APP_DIR = argv[0] && !argv[0].startsWith('--') ? fs.realpathSync(argv[0]) : null;
const LIVE_HOME = flag('--live-home', null);
const ARM_LIST = (flag('--arm', null) ?? ARMS.join(',')).split(',').sort((a, b) => ARMS.indexOf(a) - ARMS.indexOf(b)); // canonical order whatever --arm lists: `restart` needs the daemon's FIRST ids
const MUTANT = flag('--mutant', null);

const refuse = (m) => { console.log(`REFUSED: ${m}`); process.exit(3); };
if (!APP_DIR) refuse('no <app-dir>');
if (!LIVE_HOME) refuse('--live-home missing (needed to protect the live ~/.claude*, ~/.config, ~/.orchestra and to prove nothing there moved)');
for (const a of ARM_LIST) if (!ARMS.includes(a)) refuse(`unknown arm ${a} (have: ${ARMS.join(', ')})`);
if (MUTANT && !MUTANTS[MUTANT]) refuse(`unknown mutant ${MUTANT} (have: ${Object.keys(MUTANTS).join(', ')})`);
const RIG_DIR = process.env.RIG_DIR;
const RIG_WAYLAND = process.env.RIG_WAYLAND;
if (!RIG_DIR || !RIG_WAYLAND) refuse('RIG_DIR / RIG_WAYLAND unset — run via scripts/e2e-browser-agent-tabs.sh (the contained rig)');
if (process.env.DISPLAY) refuse(`X11 DISPLAY=${process.env.DISPLAY} is set — Electron would reach the human's screen`);
if (process.env.WAYLAND_DISPLAY !== RIG_WAYLAND || RIG_WAYLAND === 'wayland-1') refuse(`WAYLAND_DISPLAY=${process.env.WAYLAND_DISPLAY} != marker-verified ${RIG_WAYLAND}`);
const OUT = flag('--out', null) || path.join(RIG_DIR, 'shots');
// The contained rig's PRIVATE runtime dir (incident Q2): privateRuntimeDir() refuses anything else (a bare run, the human's own runtime dir).
const XDG = privateRuntimeDir();

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
  const a = checkScratch(path.join(LIVE_HOME, '.claude')), b = checkScratch('/var/empty/not-in-the-rig'), c = checkScratch(path.join(RIG_DIR, 'x'));
  if (a.clause !== 'live-dir' || b.clause !== 'outside-rig-base' || !c.ok) refuse(`scratch guard self-test failed: ${JSON.stringify({ a, b, c })}`);
  console.log(`[guard] self-test: live ~/.claude -> ${a.clause} · outside path -> ${b.clause} · rig path -> ${c.clause}`);
}

// ── helpers ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const md5 = (b) => crypto.createHash('md5').update(b).digest('hex');
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
async function waitFor(fn, ms, what, step = 150) {
  const t0 = Date.now(); let last;
  while (Date.now() - t0 < ms) { try { last = await fn(); if (last) return last; } catch (e) { last = e; } await sleep(step); }
  throw new Error(`timeout ${ms}ms waiting for ${what}${last instanceof Error ? `: ${last.message}` : ''}`);
}
/** Wait without aborting the arm on timeout: true/false (the clause that follows reports it). */
const softWait = async (fn, ms, what) => { try { await waitFor(fn, ms, what); return true; } catch { console.log(`  (soft wait timed out: ${what})`); return false; } };
const freePort = () => new Promise((res, rej) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); s.on('error', rej); });
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
/** mean RGB of a (2r+1)^2 block centred on (cx, cy). */
function blockColor(I, cx, cy, r = 6) {
  let R = 0, G = 0, B = 0, n = 0;
  for (let y = Math.max(0, cy - r); y <= Math.min(I.h - 1, cy + r); y++) for (let x = Math.max(0, cx - r); x <= Math.min(I.w - 1, cx + r); x++) { const o = (y * I.w + x) * I.ch; R += I.data[o]; G += I.data[o + 1]; B += I.data[o + 2]; n++; }
  return [Math.round(R / n), Math.round(G / n), Math.round(B / n)];
}
const near = (a, b, tol = 10) => Math.abs(a[0] - b[0]) <= tol && Math.abs(a[1] - b[1]) <= tol && Math.abs(a[2] - b[2]) <= tol;
const hex = (c) => '#' + c.map((v) => v.toString(16).padStart(2, '0')).join('');
const COLORS = { a: [0xd6, 0x27, 0x28], b: [0x2c, 0xa0, 0x2c], c: [0x1f, 0x77, 0xb4] };

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
const WS_NAMES = ['b397-one', 'b397-two'];
function seedWorld(armDir) {
  const fakeHome = path.join(armDir, 'home'), ohome = path.join(armDir, 'oh'), cfg = path.join(armDir, 'claude-config'), repoDir = path.join(armDir, 'repo');
  for (const d of [fakeHome, ohome, cfg, repoDir]) fs.mkdirSync(d, { recursive: true });
  for (const [k, v] of Object.entries({ HOME: fakeHome, ORCHESTRA_HOME: ohome, CLAUDE_CONFIG_DIR: cfg, repo: repoDir })) mustBeScratch(k, v);
  git(repoDir, ['init', '-q', '-b', 'main'], fakeHome);
  fs.writeFileSync(path.join(repoDir, 'README.md'), '# b397 seed repo\n');
  git(repoDir, ['add', '.'], fakeHome); git(repoDir, ['commit', '-q', '-m', 'seed'], fakeHome);
  const account = { id: 'rig-b397', label: 'rig (scratch config dir)', configDir: cfg };
  mustBeScratch('account.configDir', account.configDir);
  const workspaces = WS_NAMES.map((name, i) => {
    const wt = path.join(armDir, 'wt', name);
    fs.mkdirSync(path.dirname(wt), { recursive: true });
    git(repoDir, ['worktree', 'add', '-q', '-b', `e2e/${name}`, wt], fakeHome);
    return { id: `ws-${name}`, name, repoPath: repoDir, worktreePath: wt, branch: `e2e/${name}`, baseBranch: 'main', createdAt: Date.now() + i, status: 'idle', agent: 'claude', accountId: account.id, key: crypto.randomBytes(24).toString('hex') };
  });
  const dir = path.join(ohome, 'userData', 'orchestra'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'store.json'), JSON.stringify({ repos: [{ path: repoDir, name: 'b397-repo', defaultBranch: 'main', accountId: account.id }], workspaces: workspaces.map(({ key, ...w }) => w), accounts: [account], selfTuneRuns: [] }, null, 2));
  // the host vouches for a CLI only through this registry (ADR 0008): hashes, 0600 — exactly what a fresh keeper spawn writes
  fs.writeFileSync(path.join(ohome, 'session-keys.json'), JSON.stringify({ version: 1, sessions: Object.fromEntries(workspaces.map((w) => [w.id, { hash: sha256(w.key), issuedAt: Date.now() }])) }), { mode: 0o600 });
  const stubDir = path.join(armDir, 'stub-bin'); fs.mkdirSync(stubDir, { recursive: true });
  fs.writeFileSync(path.join(stubDir, 'claude'), '#!/bin/sh\necho B397-STUB-CLAUDE "$@"\nsleep 3600\n', { mode: 0o755 });
  return { fakeHome, ohome, cfg, account, workspaces, stubDir };
}

function listProcsByHome(home) {
  const out = [];
  for (const p of fs.readdirSync('/proc').filter((n) => /^\d+$/.test(n))) {
    try { const env = fs.readFileSync(`/proc/${p}/environ`, 'utf8').split('\0'); if (env.includes(`ORCHESTRA_HOME=${home}`)) out.push(+p); } catch {}
  }
  return out.filter((p) => p !== process.pid);
}
const daemonPids = (ctx) => { const l = abLayout(ctx.world.ohome, XDG); const dir = path.join(l.socketDir, 'namespaces', 'orchestra', 'run'); const out = {}; try { for (const f of fs.readdirSync(dir)) if (f.endsWith('.pid')) out[f.slice(0, -4)] = Number(fs.readFileSync(path.join(dir, f), 'utf8').trim()); } catch {} return out; };
const environOf = (pid) => { try { return fs.readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0').filter(Boolean); } catch { return null; } };

const results = []; // {arm, clause, ok, detail}
function clause(arm, name, ok, detail) { results.push({ arm, clause: name, ok: !!ok, detail }); console.log(`  ${ok ? 'PASS' : 'FAIL'}  [${arm}] ${name} — ${detail}`); }
const shots = [];
fs.mkdirSync(OUT, { recursive: true });
function grim(name) {
  const f = path.join(OUT, name);
  sh('grim', ['-o', 'HEADLESS-1', f], { env: { PATH: '/usr/bin:/bin', XDG_RUNTIME_DIR: XDG, WAYLAND_DISPLAY: RIG_WAYLAND } });
  const buf = fs.readFileSync(f); shots.push({ file: f, md5: md5(buf) }); return decodePng(buf);
}

// ── mutants: patch the BUILT bundle in place; restore byte-exact and prove it with cmp ──────────────────────────────────────────
let mutantRestore = null;
function mutantTarget(kind) {
  if (kind === 'cli') return path.join(APP_DIR, 'dist-electron/cli.js');
  if (kind === 'css') {
    const dir = path.join(APP_DIR, 'dist/assets');
    const f = fs.readdirSync(dir).filter((n) => n.endsWith('.css')).find((n) => fs.readFileSync(path.join(dir, n), 'utf8').includes('.browser-agent-switch{'));
    if (!f) refuse('cannot find the renderer stylesheet holding .browser-agent-switch in dist/assets');
    return path.join(dir, f);
  }
  const m = /\.\/(index-[A-Za-z0-9_-]+\.js)/.exec(fs.readFileSync(path.join(APP_DIR, 'dist-electron/main.js'), 'utf8'));
  if (!m) refuse('cannot resolve the main-process chunk from dist-electron/main.js');
  return path.join(APP_DIR, 'dist-electron', m[1]);
}
const MARKER = path.join(APP_DIR ?? '/nonexistent', 'dist-electron', '.b397-mutant-active');
function applyMutant() {
  if (fs.existsSync(MARKER)) refuse(`${MARKER} exists — an earlier mutant run died without restoring the bundle: ${fs.readFileSync(MARKER, 'utf8').trim()} (restore it from that backup, or rebuild, then delete the marker)`);
  if (!MUTANT) return;
  const m = MUTANTS[MUTANT], file = mutantTarget(m.file), backup = path.join(RIG_DIR, `mutant-backup-${path.basename(file)}`);
  let src = fs.readFileSync(file, 'utf8');
  for (const [from, to] of m.edits) {
    const hits = typeof from === 'string' ? src.split(from).length - 1 : (src.match(new RegExp(from.source, 'g')) ?? []).length;
    if (hits !== 1) refuse(`mutant ${MUTANT}: ${String(from).slice(0, 80)} occurs ${hits}x in ${path.basename(file)} (must be exactly 1) — the bundle changed, update the mutant`);
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

// ── the fixture site (shared, owned by #395) ─────────────────────────────────────────────────────────────────────────────────
let fixture = null;
async function startSite() {
  fixture = spawn(process.execPath, [path.join(repoRoot, 'scripts/fixtures/browser-site/server.mjs'), '0'], { env: { PATH: process.env.PATH }, stdio: ['ignore', 'pipe', 'inherit'] });
  return new Promise((res, rej) => { let b = ''; fixture.stdout.on('data', (d) => { b += d; const m = /LISTENING (\d+)/.exec(b); if (m) res(`http://127.0.0.1:${m[1]}`); }); fixture.on('exit', () => rej(new Error('fixture exited'))); setTimeout(() => rej(new Error('fixture never listened')), 8000); });
}

// ── one world, all arms ───────────────────────────────────────────────────────────────────────────────────────────────────────
/** One boot of the app on the world (the restart arm boots it a second time on the SAME world). */
async function bootApp(world, armDir, tag) {
  const port = await freePort();
  const env = { PATH: `${world.stubDir}:/usr/local/bin:/usr/bin:/bin`, HOME: world.fakeHome, XDG_RUNTIME_DIR: XDG, XDG_CONFIG_HOME: path.join(world.fakeHome, '.config'), XDG_CACHE_HOME: path.join(world.fakeHome, '.cache'),
    WAYLAND_DISPLAY: RIG_WAYLAND, SWAYSOCK: process.env.SWAYSOCK, ELECTRON_OZONE_PLATFORM_HINT: 'wayland', ORCHESTRA_OZONE: 'wayland', ORCHESTRA_OZONE_RELAUNCHED: '1',
    ORCHESTRA_HOME: world.ohome, ORCHESTRA_DEBUG_PORT: String(port), ORCHESTRA_SELF_TUNE_CMD: '/bin/true', CLAUDE_CONFIG_DIR: world.cfg, LANG: 'C.UTF-8',
    ...(ARM_LIST.includes('attach') ? { ORCHESTRA_CDP_TRACE: '1' } : {}), // the attach arm MEASURES what agent-browser sends (proxy trace in <ORCHESTRA_HOME>/logs/orchestra.log)
    // OPS freeze (ledger #405 incident Q2): the app must never reach the human's session bus / keyring. `disabled:` stops GLib/GDBus falling back to $XDG_RUNTIME_DIR/bus (libdbus already fails to parse it).
    DBUS_SESSION_BUS_ADDRESS: 'disabled:' };
  for (const k of ['HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'ORCHESTRA_HOME', 'CLAUDE_CONFIG_DIR']) mustBeScratch(`env.${k}`, env[k]);
  if ('DISPLAY' in env || env.WAYLAND_DISPLAY !== RIG_WAYLAND) refuse('child env would reach the human display');
  const logFile = path.join(armDir, `app-${tag}.log`);
  const fd = fs.openSync(logFile, 'w');
  const app = spawn(path.join(APP_DIR, 'node_modules/electron/dist/electron'), [APP_DIR, '--ozone-platform=wayland'], { cwd: APP_DIR, env, stdio: ['ignore', fd, fd], detached: true });
  console.log(`[rig] app (${tag}) pid ${app.pid} debug port ${port} log ${logFile}`);
  const targets = async () => (await (await fetch(`http://127.0.0.1:${port}/json`)).json());
  const target = await waitFor(async () => (await targets()).find((x) => x.type === 'page' && x.url.includes('dist/index.html')) || null, 60000, 'the app page target');
  clause('ctl', `app-identity-path${tag === 'boot1' ? '' : '-' + tag}`, target.url.includes(APP_DIR) && !target.url.includes('app.asar'), `target url ${target.url} ⊇ ${APP_DIR}`);
  const ui = await Cdp.connect(target.webSocketDebuggerUrl);
  await ui.send('Page.enable');
  // /proc/<pid>/environ can be BLANKED by the app itself (diag run 2026-10-26 00:37: 660 empty entries, no ORCHESTRA_HOME) — then the control judges by what the
  // app DID: its hooks socket and userData live under the scratch ORCHESTRA_HOME, and `app-in-my-sway` (arms) proves the display.
  let environ = [];
  const haveEnv = await softWait(() => { environ = fs.readFileSync(`/proc/${app.pid}/environ`, 'utf8').split('\0'); return environ.some((e) => e.startsWith('ORCHESTRA_HOME=')); }, 8000, 'the app environ to be readable');
  const ev = (k) => (environ.find((e) => e.startsWith(k + '=')) || '').slice(k.length + 1);
  const sockUp = haveEnv || (await softWait(() => fs.existsSync(path.join(world.ohome, 'sock')), 20000, 'the app hooks socket under the scratch ORCHESTRA_HOME'));
  const envOk = haveEnv
    ? ev('ORCHESTRA_HOME') === world.ohome && ev('CLAUDE_CONFIG_DIR') === world.cfg && ev('HOME') === world.fakeHome && !environ.some((e) => e.startsWith('DISPLAY=')) && ev('WAYLAND_DISPLAY') === RIG_WAYLAND
    : sockUp && fs.existsSync(path.join(world.ohome, 'userData')) && !('DISPLAY' in env) && env.WAYLAND_DISPLAY === RIG_WAYLAND;
  clause('ctl', `scratch-env${tag === 'boot1' ? '' : '-' + tag}`, envOk,
    haveEnv
      ? `app environ: ORCHESTRA_HOME=${ev('ORCHESTRA_HOME')} CLAUDE_CONFIG_DIR=${ev('CLAUDE_CONFIG_DIR')} WAYLAND_DISPLAY=${ev('WAYLAND_DISPLAY')} DISPLAY=${ev('DISPLAY') || '<unset>'}`
      : `app environ blanked by the app (${environ.length} empty entries); judged by behaviour: hooks socket ${path.join(world.ohome, 'sock')} present=${sockUp}, userData under the scratch home, child env passed with WAYLAND_DISPLAY=${env.WAYLAND_DISPLAY} and no DISPLAY`);
  return { app, port, ui, targets, env };
}

async function main() {
  const armDir = path.join(RIG_DIR, 'world'); fs.mkdirSync(armDir, { recursive: true });
  const world = seedWorld(armDir);
  const [W1, W2] = world.workspaces;
  const FIX = await startSite();
  console.log(`[rig] fixture ${FIX}`);
  sh('swaymsg', ['output', 'HEADLESS-1', 'resolution', '1500x950']);
  sh('swaymsg', ['default_border', 'none']);
  const ctx = { world, armDir, W1, W2, FIX, app: null, ui: null, port: 0, targets: null, env: null, URL: { a: `${FIX}/tabs-a.html`, b: `${FIX}/tabs-b.html`, c: `${FIX}/tabs-c.html`, hitA: `${FIX}/agent-tabs-hit-a.html`, hitB: `${FIX}/agent-tabs-hit-b.html`, spawn: `${FIX}/agent-tabs-spawn.html`, frame: `${FIX}/agent-tabs-frame.html` } };
  try {
    Object.assign(ctx, await bootApp(world, armDir, 'boot1'));
    await runArms(ctx);
  } catch (e) {
    clause('rig', 'completed', false, `ABORTED: ${e.stack || e}`);
  } finally {
    ctx.ui?.close();
    if (ctx.app) { try { process.kill(-ctx.app.pid, 'SIGTERM'); } catch {} }
    await sleep(2000);
    if (ctx.app) { try { process.kill(-ctx.app.pid, 'SIGKILL'); } catch {} }
    try { fixture?.kill('SIGKILL'); } catch {}
    { // daemons a leaked mutant run may have left (they carry no ORCHESTRA_HOME), then the scratch socket dir — only ever THIS ORCHESTRA_HOME's hashed one
      const l = abLayout(world.ohome, XDG);
      for (const pid of Object.values(daemonPids({ world }))) { if (environOf(pid)?.includes(`AGENT_BROWSER_SOCKET_DIR=${l.socketDir}`)) { try { process.kill(pid, 'SIGKILL'); } catch {} } }
      if (/\/orch-ab-[0-9a-f]{8}$/.test(l.socketDir) && l.socketDir.startsWith(XDG + '/')) fs.rmSync(l.socketDir, { recursive: true, force: true });
    }
    for (const p of listProcsByHome(world.ohome)) { try { process.kill(p, 'SIGKILL'); } catch {} }
    await sleep(500);
    const left = listProcsByHome(world.ohome);
    clause('ctl', 'teardown-no-survivors', left.length === 0, `processes still carrying ${world.ohome}: ${left.length ? left.join(',') : 'none'}`);
  }
}

// ── driving helpers ─────────────────────────────────────────────────────────────────────────────────────────────────────────
const sel = (n) => JSON.stringify(n);
const rectOf = (ctx, s, nth = 0) => ctx.ui.eval(`(() => { const e = document.querySelectorAll(${sel(s)})[${nth}]; if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, left: r.left, top: r.top, width: r.width, height: r.height }; })()`);
async function clickSel(ctx, s, nth = 0) {
  const r = await rectOf(ctx, s, nth);
  if (!r) throw new Error(`no element for ${s}[${nth}]`);
  await ctx.ui.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: r.x, y: r.y });
  await ctx.ui.click(r.x, r.y);
  return r;
}
async function selectWs(ctx, W) {
  const idx = await ctx.ui.eval(`[...document.querySelectorAll('.ws-item')].findIndex((e) => e.textContent.includes(${sel(W.branch)}))`);
  if (idx < 0) throw new Error(`no sidebar row for ${W.branch}`);
  await clickSel(ctx, '.ws-item', idx);
  await waitFor(() => ctx.ui.eval(`[...document.querySelectorAll('.ws-item.active')].some((e) => e.textContent.includes(${sel(W.branch)}))`), 15000, `${W.branch} to be the active workspace`);
  await sleep(500);
}
async function openPane(ctx) {
  const state = await ctx.ui.eval(`(() => { const b = document.querySelector('button[aria-label="Show browser pane"],button[aria-label="Hide browser pane"]'); if (!b) return null; return { open: b.getAttribute('aria-label') === 'Hide browser pane' }; })()`);
  if (!state) throw new Error('browser pane toggle not found');
  if (!state.open) await clickSel(ctx, 'button[aria-label="Show browser pane"]');
  await waitFor(() => ctx.ui.eval(`!!document.querySelector('.browser-panel:not(.browser-panel-hidden) .browser-tab')`), 20000, 'the Browser pane (tab strip) to be open');
  await waitFor(() => ctx.ui.eval(`(() => { const h = document.querySelector('.browser-panel:not(.browser-panel-hidden) .browser-holder'); if (!h) return false; const r = h.getBoundingClientRect(); return r.width > 100 && r.height > 100; })()`), 15000, 'the browser holder to be laid out');
  await sleep(500);
}
/** The REAL CLI bundle, with an `env -i` allowlist: exactly what an agent's Bash tool hands it. */
function cli(ctx, W, args, { timeoutMs = 60000, key } = {}) {
  const base = { PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`, HOME: ctx.world.fakeHome, ORCHESTRA_HOME: ctx.world.ohome, ORCHESTRA_WS_ID: W.id, ORCHESTRA_SESSION_KEY: key ?? W.key,
    ORCHESTRA_AGENT_TMPDIR: path.join(ctx.world.fakeHome, 'agent-tmp', W.name), LANG: 'C.UTF-8' };
  fs.mkdirSync(base.ORCHESTRA_AGENT_TMPDIR, { recursive: true });
  const t0 = Date.now();
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(APP_DIR, 'dist-electron/cli.js'), 'browser', ...args], { env: base, stdio: ['ignore', 'pipe', 'pipe'], cwd: ctx.world.fakeHome });
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => (stdout += d)); child.stderr.on('data', (d) => (stderr += d));
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, timeoutMs);
    child.on('close', (code, signal) => { clearTimeout(timer); resolve({ code: code ?? (signal ? 137 : 0), stdout, stderr, ms: Date.now() - t0 }); });
  });
}
const show = (r) => `rc=${r.code} ${r.ms}ms stdout=${JSON.stringify(r.stdout.trim().slice(0, 200))} stderr=${JSON.stringify(r.stderr.trim().slice(0, 240))}`;
/** The panel's registry as the app itself publishes it to the renderer (an independent oracle of the tab layer). */
const reg = (ctx, W) => ctx.ui.eval(`window.orchestra.browserState(${sel(W.id)}).then((s) => ({ tabs: s.tabs.map((t) => ({ id: t.id, url: t.url, title: t.title, active: t.active, openedBy: t.openedBy })), activeTabId: s.activeTabId, agentSwitch: s.agentSwitch ?? null }))`);
const brief = (r) => JSON.stringify(r.tabs.map((t) => `${t.id}:${t.openedBy[0]}${t.active ? '*' : ''}:${(t.title || t.url).slice(-14)}`));
const titled = (r, re) => r.tabs.find((t) => re.test(t.title) || re.test(t.url));
/** page targets of the app's debug port that are not the renderer = one per live tab view (any workspace). */
const viewTargets = async (ctx) => (await ctx.targets()).filter((x) => x.type === 'page' && !x.url.includes('dist/index.html'));
async function oracle(ctx, urlPrefix, ms = 15000) {
  const t = await waitFor(async () => (await ctx.targets()).find((x) => x.type === 'page' && x.url.startsWith(urlPrefix)) || null, ms, `a page at ${urlPrefix}`);
  return Cdp.connect(t.webSocketDebuggerUrl);
}
/** compositor pixel at the centre of the page area (.browser-holder); retried until it matches `want` or the deadline. */
async function holderColor(ctx, name, want, ms = 6000) {
  const r = await rectOf(ctx, '.browser-panel:not(.browser-panel-hidden) .browser-holder');
  if (!r) return { color: null, tries: 0, note: 'no visible .browser-holder' };
  const t0 = Date.now(); let c, tries = 0;
  do {
    const img = grim(`${name}.png`); tries++;
    c = blockColor(img, Math.round(r.x), Math.round(r.y));
    if (!want || near(c, want)) break;
    await sleep(350);
  } while (Date.now() - t0 < ms);
  return { color: c, tries };
}
const colorOk = (h, want) => !!h.color && near(h.color, want);
const colorTxt = (h, want) => `holder pixel ${h.color ? hex(h.color) : 'n/a'} (want ${hex(want)}, ${h.tries} grim tries)`;
const noticeText = (ctx) => ctx.ui.eval(`document.querySelector('.browser-agent-switch .browser-agent-switch-text')?.textContent ?? null`);
const backText = (ctx) => ctx.ui.eval(`document.querySelector('.browser-agent-switch .browser-agent-switch-back')?.textContent ?? null`);
/** agent-browser's own tab list (the daemon's view): [{tabId, title, url, active, targetId}]. */
async function abTabs(ctx, W) {
  const r = await cli(ctx, W, ['--json', 'tab', 'list']);
  try { return JSON.parse(r.stdout.trim()).data.tabs; } catch { return []; }
}
const abLabel = async (ctx, W, re) => (await abTabs(ctx, W)).find((t) => re.test(t.title) || re.test(t.url))?.tabId;
/** Back to a known shape between arms: only the first (human) tab of W1 left, showing page B, W1 focused with its pane open. */
async function reset(ctx) {
  const { ui, W1 } = ctx;
  await selectWs(ctx, W1);
  await openPane(ctx);
  let r = await reg(ctx, W1);
  for (const t of r.tabs.slice(1)) await ui.eval(`window.orchestra.browserTabClose(${sel(W1.id)}, ${sel(t.id)}).then(() => true)`);
  await waitFor(async () => (await reg(ctx, W1)).tabs.length === 1, 15000, 'W1 to be down to one tab');
  r = await reg(ctx, W1);
  await ui.eval(`window.orchestra.browserNavigate(${sel(W1.id)}, ${sel(ctx.URL.b)}).then(() => true)`);
  await waitFor(async () => /Tabs fixture B/.test((await reg(ctx, W1)).tabs[0]?.title ?? ''), 15000, 'W1 tab 1 to show page B');
  await sleep(300);
  return reg(ctx, W1);
}
/** Put the human's keyboard focus in the workspace composer and report whether it is there. */
const composerFocus = (ctx) => ctx.ui.eval(`(() => { const t = document.querySelector('.av-composer .cm-content'); return t ? { onComposer: document.activeElement === t, windowFocus: document.hasFocus() } : null; })()`);
const focusComposer = async (ctx) => {
  const pos = await ctx.ui.eval(`(() => { const t = document.querySelector('.av-composer .cm-content'); if (!t) return null; const r = t.getBoundingClientRect(); return { x: r.left + Math.min(40, r.width / 2), y: r.top + r.height / 2 }; })()`);
  if (!pos) return null;
  await ctx.ui.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pos.x, y: pos.y });
  await ctx.ui.click(pos.x, pos.y);
  await sleep(250);
  return composerFocus(ctx);
};
const hooksSock = (ctx) => fs.readFileSync(path.join(ctx.world.ohome, 'sock'), 'utf8').trim();
function hostCall(ctx, route, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request({ socketPath: hooksSock(ctx), method: 'POST', path: route, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } }, (res) => { let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } }); });
    req.on('error', reject); req.end(payload);
  });
}
/** A raw CDP client of the PROXY (what agent-browser is, minus its own tab bookkeeping). */
async function rawProxyClient(url) {
  const ws = new WS(url);
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  let id = 0; const pending = new Map();
  const listeners = [];
  ws.on('message', (d) => { const m = JSON.parse(String(d)); const p = m.id && pending.get(m.id); if (p) { pending.delete(m.id); p(m); } else if (m.method) for (const l of listeners) l(m); });
  // a command whose target died (a mutant that lets Page.crash through) never answers: every call is bounded, a timeout is a plain `error` the clause reads as a failure
  const send = (method, params, sessionId) => new Promise((res) => { const n = ++id; const t = setTimeout(() => { pending.delete(n); res({ error: { message: `timed out after 6000ms (${method})` } }); }, 6000); pending.set(n, (m) => { clearTimeout(t); res(m); }); ws.send(JSON.stringify({ id: n, method, params, ...(sessionId ? { sessionId } : {}) })); });
  return { call: (method, params = {}) => send(method, params), callOn: (sessionId, method, params = {}) => send(method, params, sessionId), onEvent: (l) => listeners.push(l), close: () => ws.close() };
}


/** An agent tab on a page that SPAWNS children 4 s after load (a worker and/or a cross-site iframe), the daemon attached (snapshot), the HUMAN on their own tab (unless `background:false`). Measures the proxy trace around the spawn. */
async function spawnChildrenInBackgroundTab(ctx, { worker, frame, background = true }) {
  const { W1, URL: U } = ctx;
  await reset(ctx);
  await cli(ctx, W1, ['tab', 'new', `${U.spawn}?worker=${worker ? 1 : 0}&frame=${frame ? 1 : 0}`]);
  await softWait(async () => !!titled(await reg(ctx, W1), /Spawn fixture/), 15000, 'the agent tab to show the spawn page');
  const snap = await cli(ctx, W1, ['snapshot', '-i']); // the daemon is attached to the agent tab, auto-attach on
  if (background) {
    const idxH = await ctx.ui.eval(`[...document.querySelectorAll('.browser-tab')].findIndex((e) => e.dataset.openedBy === 'human')`);
    await clickSel(ctx, '.browser-tab', idxH);
    await softWait(async () => (await reg(ctx, W1)).tabs.find((t) => t.active)?.openedBy === 'human', 10000, 'the human tab to be active');
  }
  const before = await reg(ctx, W1);
  const logFile = path.join(ctx.world.ohome, 'logs', 'orchestra.log');
  // The log rotates at 5 MB with ONE backup: a command storm would rotate its own beginning away. A 40 ms follower copies every new byte (capped) so the FIRST requests survive.
  let copied = ''; let last = (() => { try { return fs.statSync(logFile).size; } catch { return 0; } })();
  const follow = setInterval(() => {
    if (copied.length > 6e6) return;
    try {
      const size = fs.statSync(logFile).size;
      if (size < last) last = 0; // rotated: the old bytes are in .1, read what the new file has
      if (size > last) { const fd = fs.openSync(logFile, 'r'); const buf = Buffer.alloc(Math.min(size - last, 2e6)); fs.readSync(fd, buf, 0, buf.length, last); fs.closeSync(fd); copied += buf.toString('utf8'); last += buf.length; }
    } catch {}
  }, 40);
  await sleep(7000); // the page spawns its children (4 s after load), the daemon answers them, and any (wrongful) bring-to-front lands
  clearInterval(follow);
  const after = await reg(ctx, W1); // BEFORE the probe below: `get title` is a real agent action and (correctly) brings its tab to the front
  const probe = await cli(ctx, W1, ['get', 'title'], { timeoutMs: 8000 }); // does the daemon still answer a plain command?
  const reqs = [...copied.matchAll(/client->proxy \{[^\n]*?"method":"([A-Za-z.]+)"/g)].map((m) => m[1]);
  const hist = Object.entries(reqs.reduce((h, m) => ((h[m] = (h[m] ?? 0) + 1), h), {})).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, v]) => `${k}×${v}`).join(' ');
  fs.writeFileSync(path.join(OUT, `children-trace-${frame ? 'frame' : 'worker'}-${background ? 'bg' : 'fg'}.txt`), copied.split('\n').slice(0, 400).join('\n'));
  const spawnRuns = new Set((copied.match(/SPAWN-RUN/g) ?? []).length ? ['x'] : []).size; // the page logs once; replays of buffered console messages are not runs
  const attached = (copied.match(/Target\.attachedToTarget/g) ?? []).length;
  return { snap, before, after, probe, spawnErr: probe.code !== 0 ? `get title rc=${probe.code} ${probe.ms}ms` : null, spawnRuns, requests: reqs.length, methods: [...new Set(reqs)].sort(), hist, attached, kb: copied.length / 1024 };
}

const ARM_FNS = {
  async open(ctx) {
    const { W1, URL: U } = ctx; const A = 'open';
    const r0 = await reset(ctx);
    const h0 = await holderColor(ctx, 'open-0-human', COLORS.b);
    clause(A, 'ctl/precondition-one-human-tab-showing-B', r0.tabs.length === 1 && r0.tabs[0].openedBy === 'human' && r0.tabs[0].active && colorOk(h0, COLORS.b), `registry ${brief(r0)}; ${colorTxt(h0, COLORS.b)}`);
    const nw = await cli(ctx, W1, ['tab', 'new', U.a]);
    await softWait(async () => /Tabs fixture A/.test(titled(await reg(ctx, W1), /Tabs fixture A/)?.title ?? ''), 15000, 'the new tab to load page A');
    const r1 = await reg(ctx, W1);
    const mine = titled(r1, /Tabs fixture A/);
    clause(A, 'tab-new-opens-an-agent-tab-and-activates-it', nw.code === 0 && r1.tabs.length === 2 && mine?.openedBy === 'agent' && mine.active === true && r1.tabs[0].openedBy === 'human' && !r1.tabs[0].active, `${show(nw)} → registry ${brief(r1)}`);
    const h1 = await holderColor(ctx, 'open-1-agent-tab', COLORS.a);
    clause(A, 'the-agent-tab-is-what-the-human-sees', colorOk(h1, COLORS.a), colorTxt(h1, COLORS.a) + ' (compositor pixels on the rig\'s sway)');
    const marks = await ctx.ui.eval(`({ agent: document.querySelectorAll('.browser-tab[data-opened-by="agent"] .browser-tab-agent-mark').length, human: document.querySelectorAll('.browser-tab[data-opened-by="human"] .browser-tab-agent-mark').length })`);
    clause(A, 'strip-marks-the-agent-tab-only', marks.agent === 1 && marks.human === 0, `agent-marked tabs ${marks.agent}, human-marked ${marks.human}`);
    const note = await noticeText(ctx); const back = await backText(ctx);
    clause(A, 'the-human-is-told-the-agent-took-the-screen', !!note && /Tabs fixture A/.test(note) && !!back && /Tabs fixture B/.test(back) && r1.agentSwitch?.to === mine?.id, `notice ${JSON.stringify(note)} · back ${JSON.stringify(back)} · agentSwitch ${JSON.stringify(r1.agentSwitch)}`);
    grim('open-notice.png');
    const list = await cli(ctx, W1, ['tab', 'list']);
    const lines = list.stdout.split('\n');
    const lA = lines.find((l) => /Tabs fixture A/.test(l)) ?? '', lB = lines.find((l) => /Tabs fixture B/.test(l)) ?? '';
    clause(A, 'tab-list-says-who-opened-which', list.code === 0 && /\(yours\)$/.test(lA.trim()) && /\(the user's\)$/.test(lB.trim()), `${show(list)}`);
    const js = await cli(ctx, W1, ['--json', 'tab', 'list']);
    let tabsJson = []; try { tabsJson = JSON.parse(js.stdout.trim()).data.tabs; } catch {}
    const jA = tabsJson.find((t) => /Tabs fixture A/.test(t.title)), jB = tabsJson.find((t) => /Tabs fixture B/.test(t.title));
    clause(A, 'tab-list-json-carries-openedBy-and-closable', jA?.openedBy === 'agent' && jA?.closable === true && jB?.openedBy === 'human' && jB?.closable === false, `A ${JSON.stringify({ o: jA?.openedBy, c: jA?.closable })} B ${JSON.stringify({ o: jB?.openedBy, c: jB?.closable })}`);
    // F2/F6/F3: while the notice is up it must not MOVE a tab or its x, and must not COVER any control — every tab, every x, the +, the nav buttons, the URL input and the design button are what
    // elementFromPoint finds at their centre; a row below the toolbar takes space only from the page area (like the cap notice and the design hint). Geometry is read with the notice up and again after it lapses.
    const geom = () => ctx.ui.eval(`({ notice: !!document.querySelector('.browser-agent-switch'), pos: getComputedStyle(document.querySelector('.browser-agent-switch') ?? document.body).position, tabs: [...document.querySelectorAll('.browser-tab')].map((e) => { const r = e.getBoundingClientRect(), x = e.querySelector('.browser-tab-close').getBoundingClientRect(); return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(x.left)].join(':'); }), toolbar: Math.round(document.querySelector('.browser-toolbar').getBoundingClientRect().top) })`);
    const up = await geom();
    const occl = await ctx.ui.eval(`(() => { const bad = []; const hit = (el, name) => { if (!el) { bad.push(name + '->missing'); return; } const r = el.getBoundingClientRect(); const e = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); if (!(e && el.contains(e))) bad.push(name + '->' + (e?.className || e?.tagName)); }; document.querySelectorAll('.browser-tab').forEach((t, i) => { hit(t, 'tab' + i); hit(t.querySelector('.browser-tab-close'), 'x' + i); }); hit(document.querySelector('.browser-tab-new'), '+'); document.querySelectorAll('.browser-nav-btn').forEach((b, i) => hit(b, 'btn' + i)); hit(document.querySelector('.browser-url-input'), 'url'); hit(document.querySelector('.browser-design-btn'), 'design'); return { bad, noticeUp: !!document.querySelector('.browser-agent-switch'), tabs: document.querySelectorAll('.browser-tab').length }; })()`);
    const lapsed = await softWait(async () => !(await geom()).notice, 14000, 'the notice to lapse');
    const down = await geom();
    clause(A, 'the-notice-never-moves-or-covers-a-tab-a-close-button-the-plus-the-url-bar-or-the-design-button', up.notice && lapsed && occl.noticeUp && occl.bad.length === 0 && ['static', 'relative'].includes(up.pos) && JSON.stringify(up.tabs) === JSON.stringify(down.tabs) && up.toolbar === down.toolbar,
      `notice up (position ${up.pos}) over ${occl.tabs} tabs: elementFromPoint at the centre of every tab / x / + / nav button / URL input / design button ${occl.bad.length ? 'COVERED ' + occl.bad.join(', ') : 'is the control itself'}; tabs (left:top:width:xleft) ${JSON.stringify(up.tabs)} up vs ${JSON.stringify(down.tabs)} after the lapse; toolbar top ${up.toolbar} vs ${down.toolbar}`);
  },

  async switch(ctx) {
    const { W1, URL: U } = ctx; const A = 'switch';
    const r0 = await reset(ctx);
    await cli(ctx, W1, ['tab', 'new', U.a]);
    await softWait(async () => !!titled(await reg(ctx, W1), /Tabs fixture A/), 15000, 'page A tab');
    const f0 = await focusComposer(ctx);
    clause(A, 'ctl/composer-focusable', f0?.onComposer === true && f0?.windowFocus === true, `composer focus before: ${JSON.stringify(f0)}`);
    const labB = await abLabel(ctx, W1, /Tabs fixture B/);
    const sw = await cli(ctx, W1, ['tab', labB ?? 't0']);
    await softWait(async () => (await reg(ctx, W1)).tabs.find((t) => t.active)?.openedBy === 'human', 10000, 'the human tab to become active');
    const r1 = await reg(ctx, W1);
    const h = await holderColor(ctx, 'switch-to-user-tab', COLORS.b);
    clause(A, 'switch-shows-the-requested-tab', sw.code === 0 && r1.tabs.find((t) => t.active)?.openedBy === 'human' && colorOk(h, COLORS.b), `tab ${labB}: ${show(sw)} → registry ${brief(r1)}; ${colorTxt(h, COLORS.b)}`);
    const f1 = await composerFocus(ctx);
    clause(A, 'switch-does-not-steal-keyboard-focus', f1?.onComposer === true && f1?.windowFocus === true, `composer focus after: ${JSON.stringify(f1)} (Page.bringToFront / Target.activateTarget never take OS focus)`);
    const note = await noticeText(ctx); const back = await backText(ctx);
    clause(A, 'the-switch-is-announced-with-a-way-back', !!note && /Tabs fixture B/.test(note) && !!back && /Tabs fixture A/.test(back), `notice ${JSON.stringify(note)} · back ${JSON.stringify(back)}`);
    await clickSel(ctx, '.browser-agent-switch-back');
    await softWait(async () => (await reg(ctx, W1)).tabs.find((t) => t.active)?.openedBy === 'agent', 10000, 'Back to restore the agent tab');
    const r2 = await reg(ctx, W1);
    const gone = await softWait(async () => (await noticeText(ctx)) === null, 5000, 'the notice to clear');
    clause(A, 'back-restores-and-clears-the-notice', r2.tabs.find((t) => t.active)?.openedBy === 'agent' && gone && r2.agentSwitch === null, `registry ${brief(r2)}; notice cleared ${gone}; agentSwitch ${JSON.stringify(r2.agentSwitch)}`);
  },

  async front(ctx) {
    const { W1, URL: U } = ctx; const A = 'front';
    await reset(ctx);
    await cli(ctx, W1, ['tab', 'new', U.a]);
    await softWait(async () => !!titled(await reg(ctx, W1), /Tabs fixture A/), 15000, 'page A tab');
    // agent-browser's pointer is on A now. The human clicks their own tab in the strip.
    const idxB = await ctx.ui.eval(`[...document.querySelectorAll('.browser-tab')].findIndex((e) => e.dataset.openedBy === 'human')`);
    await clickSel(ctx, '.browser-tab', idxB);
    await softWait(async () => (await reg(ctx, W1)).tabs.find((t) => t.active)?.openedBy === 'human', 10000, 'the human tab to be active');
    const r0 = await reg(ctx, W1);
    const h0 = await holderColor(ctx, 'front-0-human-on-B', COLORS.b);
    const n0 = await noticeText(ctx);
    clause(A, 'ctl/human-is-on-B-agent-pointer-on-A', r0.tabs.find((t) => t.active)?.openedBy === 'human' && colorOk(h0, COLORS.b) && n0 === null && r0.agentSwitch === null, `registry ${brief(r0)}; ${colorTxt(h0, COLORS.b)}; notice ${JSON.stringify(n0)} (a human tab click cleared it)`);
    const ls = await cli(ctx, W1, ['tab', 'list']);
    await sleep(1500);
    const r1 = await reg(ctx, W1); const h1 = await holderColor(ctx, 'front-1-after-list', COLORS.b, 1500);
    clause(A, 'tab-list-and-idle-do-not-swap-the-humans-tab', ls.code === 0 && r1.tabs.find((t) => t.active)?.openedBy === 'human' && colorOk(h1, COLORS.b), `${show(ls)} → registry ${brief(r1)}; ${colorTxt(h1, COLORS.b)}`);
    const gu = await cli(ctx, W1, ['get', 'url']);
    await softWait(async () => (await reg(ctx, W1)).tabs.find((t) => t.active)?.openedBy === 'agent', 10000, 'the agent tab to come to the front');
    const r2 = await reg(ctx, W1); const h2 = await holderColor(ctx, 'front-2-brought-to-front', COLORS.a);
    clause(A, 'an-acting-command-brings-its-tab-to-the-front', gu.code === 0 && gu.stdout.trim() === U.a && r2.tabs.find((t) => t.active)?.openedBy === 'agent' && colorOk(h2, COLORS.a), `get url: ${show(gu)} → registry ${brief(r2)}; ${colorTxt(h2, COLORS.a)} (a Runtime.evaluate — not frame-bound — ran on A, the tab the human was NOT looking at)`);
    const note = await noticeText(ctx); const back = await backText(ctx);
    clause(A, 'it-is-announced-never-silent', !!note && /Tabs fixture A/.test(note) && !!back && /Tabs fixture B/.test(back) && r2.agentSwitch?.to === titled(r2, /Tabs fixture A/)?.id, `notice ${JSON.stringify(note)} · back ${JSON.stringify(back)}`);
    grim('front-2-notice.png');
    await clickSel(ctx, '.browser-agent-switch-back');
    await softWait(async () => (await reg(ctx, W1)).tabs.find((t) => t.active)?.openedBy === 'human', 10000, 'Back to restore the human tab');
    const h3 = await holderColor(ctx, 'front-3-back', COLORS.b);
    const r3 = await reg(ctx, W1);
    clause(A, 'back-gives-the-human-their-tab-and-clears-the-notice', r3.tabs.find((t) => t.active)?.openedBy === 'human' && colorOk(h3, COLORS.b) && (await noticeText(ctx)) === null, `registry ${brief(r3)}; ${colorTxt(h3, COLORS.b)}`);
    await sleep(3000);
    const r4 = await reg(ctx, W1);
    clause(A, 'an-idle-daemon-does-not-take-the-screen-back', r4.tabs.find((t) => t.active)?.openedBy === 'human', `3 s later: registry ${brief(r4)}`);
    // a SCREENSHOT of the tab the user left: it comes to the front, a frame is painted, and the image is THAT tab's (not the user's, not blank)
    const shotPath = path.join(ctx.world.fakeHome, 'front-shot.png');
    const shot = await cli(ctx, W1, ['screenshot', shotPath], { timeoutMs: 45000 });
    let img = null; try { img = decodePng(fs.readFileSync(shotPath)); } catch {}
    const c = img ? blockColor(img, Math.floor(img.w / 2), Math.floor(img.h / 2), 8) : null;
    const r5 = await reg(ctx, W1);
    clause(A, 'a-screenshot-of-the-tab-the-user-left-brings-it-to-the-front-and-shows-it', shot.code === 0 && !!c && near(c, COLORS.a, 14) && r5.tabs.find((t) => t.active)?.openedBy === 'agent', `screenshot: ${show(shot)} → image centre ${c ? hex(c) : 'unreadable'} (want ${hex(COLORS.a)}); registry ${brief(r5)}`);
  },

  async cap(ctx) {
    const { W1, ui, URL: U } = ctx; const A = 'cap';
    await reset(ctx);
    const humanOpen = await ui.eval(`window.orchestra.browserTabNew(${sel(W1.id)}).then((r) => ({ ok: r.ok }))`); // the human's 2nd tab: the cap is SHARED
    const outs = [];
    for (let i = 1; i <= 6; i++) outs.push(await cli(ctx, W1, ['tab', 'new', U.c], { timeoutMs: 60000 }));
    const r1 = await reg(ctx, W1);
    const targets1 = (await viewTargets(ctx)).length;
    clause(A, 'ctl/eight-tabs-one-view-each', humanOpen.ok && outs.every((o) => o.code === 0) && r1.tabs.length === 8 && r1.tabs.filter((t) => t.openedBy === 'agent').length === 6 && targets1 === 8, `human opened a 2nd tab: ${humanOpen.ok}; 6 agent opens rc ${outs.map((o) => o.code).join('')} → registry ${r1.tabs.length} tabs (${r1.tabs.filter((t) => t.openedBy === 'agent').length} agent) · live page targets ${targets1}`);
    const over = await cli(ctx, W1, ['tab', 'new', U.a]);
    await sleep(800);
    const r2 = await reg(ctx, W1);
    const targets2 = (await viewTargets(ctx)).length;
    clause(A, 'the-ninth-tab-is-refused-with-the-reason', over.code !== 0 && /Tab limit reached: a workspace holds at most 8 browser tabs/.test(over.stderr), show(over));
    clause(A, 'a-refusal-opens-nothing-and-leaks-no-view', r2.tabs.length === 8 && targets2 === 8, `registry ${r2.tabs.length} tabs · live page targets ${targets2} (a leaked WebContentsView would be a 9th)`);
    const humanOver = await ui.eval(`window.orchestra.browserTabNew(${sel(W1.id)}).then((r) => ({ ok: r.ok, reason: r.reason ?? null }))`);
    clause(A, 'ctl/the-human-hits-the-same-cap', humanOver.ok === false && humanOver.reason === 'cap', `human tab-new at 8 → ${JSON.stringify(humanOver)}`);
  },

  async strip(ctx) {
    // Round-2 F2 (seat 3): with agent badges the strip broke at 6-8 tabs (an agent tab's x overflowed onto the next tab / the +; a real click on + at the cap CLOSED a tab, no cap notice).
    // 8 tabs in three arrangements (H = human, A = agent; the first H is the tab the workspace starts with), each at two pane widths (the default ~640 px and 480 px, dragged with real mouse input).
    const { W1, ui, URL: U } = ctx; const A = 'strip';
    const paneWidth = () => ui.eval(`Math.round(document.querySelector('.browser-pane').getBoundingClientRect().width)`);
    const setPaneWidth = async (target) => {
      const cur = await paneWidth(); const r = await rectOf(ctx, '.pane-resizer');
      const x1 = r.x + (cur - target);
      await ui.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: r.x, y: r.y });
      await ui.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: r.x, y: r.y, button: 'left', buttons: 1, clickCount: 1 });
      for (const f of [0.25, 0.5, 0.75, 1]) { await ui.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: r.x + (x1 - r.x) * f, y: r.y, buttons: 1 }); await sleep(40); }
      await ui.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x1, y: r.y, button: 'left', buttons: 0, clickCount: 1 });
      await softWait(async () => Math.abs((await paneWidth()) - target) <= 3, 8000, `the pane to be ~${target} px wide`);
      await sleep(400);
      return paneWidth();
    };
    const measure = (scrollEnd) => ui.eval(`(() => { const sc = document.querySelector('.browser-tabs'); sc.scrollLeft = ${scrollEnd ? 'sc.scrollWidth' : '0'}; const bad = []; const hit = (el, name) => { const r = el.getBoundingClientRect(); const e = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); if (!(e && el.contains(e))) bad.push(name + '->' + (e?.className || e?.tagName)); }; const tabs = [...document.querySelectorAll('.browser-tab')]; tabs.forEach((t, i) => { const x = t.querySelector('.browser-tab-close'); const tr = t.getBoundingClientRect(), xr = x.getBoundingClientRect(); if (xr.left < tr.left - 0.5 || xr.right > tr.right + 0.5) bad.push('x' + i + '-leaves-its-tab'); if (${scrollEnd ? 'false' : 'true'}) { hit(t, 'tab' + i); hit(x, 'x' + i); } }); if (${scrollEnd ? 'true' : 'false'}) hit(document.querySelector('.browser-tab-new'), '+'); return { bad, n: tabs.length, agent: tabs.filter((t) => t.dataset.openedBy === 'agent').length, paneW: Math.round(document.querySelector('.browser-pane').getBoundingClientRect().width) }; })()`);
    const arrangements = { 'agent-early': 'HAAAHHHH', 'agent-last': 'HHHHHAAA', 'mixed': 'HAHAHAHH' };
    for (const [name, pattern] of Object.entries(arrangements)) {
      await reset(ctx);
      for (const ch of pattern.slice(1)) {
        if (ch === 'H') await ui.eval(`window.orchestra.browserTabNew(${sel(W1.id)}).then((r) => r.ok)`);
        else await cli(ctx, W1, ['tab', 'new', U.c]);
      }
      await softWait(async () => (await reg(ctx, W1)).tabs.length === 8, 15000, 'eight tabs');
      const r8 = await reg(ctx, W1);
      const order = r8.tabs.map((t) => t.openedBy[0].toUpperCase()).join('');
      clause(A, `ctl/${name}-eight-tabs-in-the-requested-order`, order === pattern, `registry order ${order} (want ${pattern})`);
      const results = [];
      for (const width of [640, 480]) {
        const w = await setPaneWidth(width);
        const head = await measure(false);
        const tail = await measure(true);
        // a REAL click on the + at the cap: the cap notice, nothing closed
        const plus = await rectOf(ctx, '.browser-tab-new');
        await ctx.ui.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: plus.x, y: plus.y });
        await ctx.ui.click(plus.x, plus.y);
        await sleep(500);
        const after = await reg(ctx, W1);
        const notice = await ctx.ui.eval(`document.querySelector('.browser-tab-notice')?.textContent ?? null`);
        results.push({ width, w, head, tail, tabsAfter: after.tabs.length, notice });
      }
      const ok = results.every((r) => r.head.bad.length === 0 && r.tail.bad.length === 0 && r.tabsAfter === 8 && /Tab limit reached/.test(r.notice ?? ''));
      clause(A, `${name}-every-tab-x-and-plus-is-itself-no-x-leaves-its-tab-and-a-click-on-plus-at-the-cap-closes-nothing`, ok, results.map((r) => `${r.w}px: ${r.head.agent} agent tabs, ${r.head.bad.concat(r.tail.bad).join(',') || 'no overlap / no x outside its tab'}; click on + → ${r.tabsAfter} tabs, notice ${JSON.stringify((r.notice ?? '').slice(0, 40))}`).join(' | '));
      await setPaneWidth(640);
      grim(`strip-${name}.png`);
    }
  },

  async ownership(ctx) {
    const { W1, URL: U } = ctx; const A = 'ownership';
    await reset(ctx);
    // positive control FIRST (same command, same code path, allowed): the agent closes a tab it opened
    await cli(ctx, W1, ['tab', 'new', U.c]);
    await softWait(async () => !!titled(await reg(ctx, W1), /Tabs fixture C/), 15000, 'page C tab');
    const labC = await abLabel(ctx, W1, /Tabs fixture C/);
    const closeC = await cli(ctx, W1, ['tab', 'close', labC ?? 't0']);
    await softWait(async () => (await reg(ctx, W1)).tabs.length === 1, 10000, 'the agent tab C to close');
    const rC = await reg(ctx, W1);
    clause(A, 'ctl/the-agent-closes-a-tab-it-opened', closeC.code === 0 && rC.tabs.length === 1 && rC.tabs[0].openedBy === 'human', `tab close ${labC}: ${show(closeC)} → registry ${brief(rC)}`);
    await cli(ctx, W1, ['tab', 'new', U.a]);
    await softWait(async () => !!titled(await reg(ctx, W1), /Tabs fixture A/), 15000, 'page A tab');
    const r0 = await reg(ctx, W1);
    const humanTab = r0.tabs.find((t) => t.openedBy === 'human'); const labB = await abLabel(ctx, W1, /Tabs fixture B/); const labA = await abLabel(ctx, W1, /Tabs fixture A/);
    clause(A, 'ctl/two-tabs-agent-browser-knows-both', !!humanTab && !!labA && !!labB && r0.tabs.length === 2, `registry ${brief(r0)}; agent-browser labels A=${labA} B=${labB}`);
    const vt0 = (await viewTargets(ctx)).length;
    const close = await cli(ctx, W1, ['tab', 'close', labB ?? 't0']);
    await sleep(800);
    const r1 = await reg(ctx, W1);
    clause(A, 'closing-the-users-tab-is-refused-visibly', close.code !== 0 && /^browser_tab_not_owner: /.test(close.stderr) && /opened by the user/.test(close.stderr), `tab close ${labB}: ${show(close)}`);
    clause(A, 'the-users-tab-is-still-open-and-loaded', r1.tabs.length === 2 && r1.tabs.some((t) => t.id === humanTab?.id) && (await viewTargets(ctx)).length === vt0 && /Tabs fixture B/.test(titled(r1, /Tabs fixture B/)?.title ?? ''), `registry ${brief(r1)} · live page targets ${vt0} → ${(await viewTargets(ctx)).length}`);
    // round-2 F1: the gate reads the spellings agent-browser accepts (it trims and case-folds): `T1` / ` t1 ` named the user's tab but resolved to nothing, fell back to the CURRENT (agent's) tab and RAN.
    const upper = await cli(ctx, W1, ['tab', 'close', (labB ?? 't0').toUpperCase()]);
    const padded = await cli(ctx, W1, ['tab', 'close', ` ${labB ?? 't0'} `]);
    await sleep(500);
    const rSp = await reg(ctx, W1);
    const listSp = await cli(ctx, W1, ['tab', 'list']);
    clause(A, 'cli-uppercase-and-padded-ids-of-the-users-tab-are-refused-too', upper.code !== 0 && padded.code !== 0 && /^browser_tab_not_owner: /.test(upper.stderr) && /^browser_tab_not_owner: /.test(padded.stderr) && rSp.tabs.some((t) => t.id === humanTab?.id) && /Tabs fixture B/.test(listSp.stdout), `tab close ${(labB ?? 't0').toUpperCase()} → ${show(upper)}; tab close " ${labB} " → ${show(padded)}; registry ${brief(rSp)}; agent-browser still lists B: ${/Tabs fixture B/.test(listSp.stdout)} (a slipped close prints "closed" and DROPS the tab from its own list)`);
    const list = await cli(ctx, W1, ['tab', 'list']);
    clause(A, 'agent-browser-still-lists-it-no-desync', list.code === 0 && /Tabs fixture B/.test(list.stdout) && /Tabs fixture A/.test(list.stdout), `tab list after the refusal: ${show(list)} (agent-browser alone prints "closed" and DROPS the tab from its list)`);
    const js = await cli(ctx, W1, ['--json', 'tab', 'close', labB ?? 't0']);
    let doc = null; try { doc = JSON.parse(js.stdout.trim()); } catch {}
    clause(A, 'refusal-has-a-json-form', js.code !== 0 && doc?.success === false && doc?.code === 'browser_tab_not_owner', `--json: ${show(js)}`);
    // the CURRENT tab (no ref) is the user's: switch the pointer there, then `tab close`
    await cli(ctx, W1, ['tab', labB ?? 't0']);
    const cur = await cli(ctx, W1, ['tab', 'close']);
    await sleep(500);
    const r1b = await reg(ctx, W1);
    clause(A, 'closing-the-current-tab-obeys-the-same-rule', cur.code !== 0 && /^browser_tab_not_owner: /.test(cur.stderr) && r1b.tabs.some((t) => t.id === humanTab?.id), `tab close (no ref, current = the user's): ${show(cur)} → registry ${brief(r1b)}`);
    // after all those refusals the agent's OWN tab still closes (the desync made it "the last tab" for agent-browser)
    await cli(ctx, W1, ['tab', labA ?? 't0']);
    const own = await cli(ctx, W1, ['tab', 'close', labA ?? 't0']);
    await softWait(async () => (await reg(ctx, W1)).tabs.length === 1, 10000, 'the agent tab to close');
    const r3 = await reg(ctx, W1);
    clause(A, 'the-agents-own-tab-still-closes-after-the-refusals', own.code === 0 && r3.tabs.length === 1 && r3.tabs[0].id === humanTab?.id && r3.tabs[0].active, `tab close ${labA}: ${show(own)} → registry ${brief(r3)}`);
    // LAST: the proxy itself refuses a raw Target.closeTarget (an agent that bypasses the CLI). A mutant here really closes the user's tab, so nothing may depend on it afterwards.
    await cli(ctx, W1, ['tab', 'new', U.a]); // an agent tab again, so the raw client has something it may close and something it may not
    const ep = await hostCall(ctx, '/browser', { id: W1.id, key: W1.key });
    const raw = await rawProxyClient(ep.wsUrl);
    let rawClose = null, targetId = null;
    try {
      const gt = await raw.call('Target.getTargets');
      targetId = gt.result?.targetInfos?.find((t) => /Tabs fixture B/.test(t.title))?.targetId;
      rawClose = targetId ? await raw.call('Target.closeTarget', { targetId }) : null;
    } finally { raw.close(); }
    await sleep(600);
    const r4 = await reg(ctx, W1);
    clause(A, 'the-proxy-refuses-a-raw-closeTarget-of-the-users-tab', !!targetId && !!rawClose?.error && /opened by the user/.test(rawClose.error.message) && r4.tabs.some((t) => t.id === humanTab?.id), `Target.closeTarget(${targetId?.slice(0, 8)}…) → ${JSON.stringify(rawClose).slice(0, 200)} · registry ${brief(r4)}`);
    // round-2 INFO (seat 3): a renderer-destroying CDP method reaches the user's tab like any command — refused unless the agent opened the tab.
    const raw3 = await rawProxyClient(ep.wsUrl);
    let crash = null, term = null;
    try {
      const gt3 = await raw3.call('Target.getTargets');
      const tid3 = gt3.result?.targetInfos?.find((t) => /Tabs fixture B/.test(t.title))?.targetId;
      const att3 = tid3 ? await raw3.call('Target.attachToTarget', { targetId: tid3, flatten: true }) : null;
      const sid3 = att3?.result?.sessionId;
      if (sid3) { crash = await raw3.callOn(sid3, 'Page.crash', {}); term = await raw3.callOn(sid3, 'Runtime.terminateExecution', {}); }
    } finally { raw3.close(); }
    await sleep(800);
    // A mutant that lets the crash through leaves a dead renderer: nothing here may wait on it for ever (a hung eval / websocket would hold the rig and its mutated bundle).
    const within = (pr, ms) => Promise.race([pr, new Promise((_, rej) => setTimeout(() => rej(new Error(`timeout ${ms}ms`)), ms))]);
    const oB = await within(oracle(ctx, U.b, 8000), 12000).catch(() => null);
    const alive = oB ? await within(oB.eval('document.title'), 6000).catch(() => null) : null;
    try { oB?.close(); } catch {}
    clause(A, 'a-renderer-destroying-method-on-the-users-tab-is-refused', /opened by the user — an agent may only destroy the tabs it opened/.test(crash?.error?.message ?? '') && /opened by the user — an agent may only destroy the tabs it opened/.test(term?.error?.message ?? '') && alive === 'Tabs fixture B', `Page.crash → ${JSON.stringify(crash?.error?.message ?? crash).slice(0, 120)}; Runtime.terminateExecution → ${JSON.stringify(term?.error?.message ?? term).slice(0, 120)}; the user's page still answers: ${JSON.stringify(alive)}`);
  },

  async children(ctx) {
    // F1 of the early review, in its own arm so an ownership mutant (which really closes the user's tab) cannot poison its controls.
    const { W1, URL: U } = ctx; const A = 'children';
    await reset(ctx);
    const humanTab = (await reg(ctx, W1)).tabs[0];
    const ep = await hostCall(ctx, '/browser', { id: W1.id, key: W1.key });
    // F1 of the early review: the close verbs are gated on EVERY session of the user's tab — a cross-site iframe is an auto-attachable CHILD session, and Chromium's
    // Page.close closes the whole WebContents. Navigate the user's tab to a page with a worker + a cross-site frame, attach a raw client, auto-attach, and send Page.close on the CHILD.
    // The debugger of a tab is SHARED, so auto-attach may already be on from an earlier agent-browser attach and a late client is not re-announced the existing children:
    // attach the raw client FIRST, enable auto-attach, THEN navigate the user's tab to the page — the new frame/worker targets are announced to every session of the tab.
    await ctx.ui.eval(`window.orchestra.browserTabActivate(${sel(W1.id)}, ${sel(humanTab?.id ?? '')}).then(() => true)`); // the USER's tab, not the agent tab `tab new` left active
    const raw2 = await rawProxyClient(ep.wsUrl);
    let child = null, parentGone = null, children = [];
    const closes = [];
    try {
      const ev = []; raw2.onEvent((m) => ev.push(m));
      const gt2 = await raw2.call('Target.getTargets');
      const tid = gt2.result?.targetInfos?.find((t) => /Tabs fixture B/.test(t.title))?.targetId;
      const att = tid ? await raw2.call('Target.attachToTarget', { targetId: tid, flatten: true }) : null;
      const rootSid = att?.result?.sessionId;
      if (rootSid) await raw2.callOn(rootSid, 'Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
      await ctx.ui.eval(`window.orchestra.browserNavigate(${sel(W1.id)}, ${sel(U.frame)}).then(() => true)`);
      await softWait(async () => ev.some((m) => m.method === 'Target.attachedToTarget' && m.sessionId === rootSid), 15000, 'a child (worker / frame) session to auto-attach');
      await sleep(600); // let the sibling children (worker + frame) announce too
      children = ev.filter((m) => m.method === 'Target.attachedToTarget' && m.sessionId === rootSid).map((m) => ({ sid: m.params?.sessionId, type: m.params?.targetInfo?.type }));
      child = children[0]?.sid ?? null;
      for (const c of children) closes.push({ type: c.type, reply: await raw2.callOn(c.sid, 'Page.close', {}) }); // every child, at once: none may reach the page debugger
    } finally { raw2.close(); }
    await sleep(800);
    const r5 = await reg(ctx, W1);
    parentGone = !r5.tabs.some((t) => t.id === humanTab?.id);
    clause(A, 'ctl/a-child-frame-session-exists', !!child, `auto-attach on the user's page (a worker + a cross-site iframe) produced ${children.length} child session(s): ${children.map((c) => c.type).join(', ') || 'NONE'}`);
    const refused = closes.filter((c) => /opened by the user: an agent may close only the tabs it opened/.test(c.reply?.error?.message ?? '')); // #395's shared predicate: a child answers like the root — close ownership
    clause(A, 'a-child-session-cannot-close-the-users-tab', closes.length > 0 && refused.length >= 1 && closes.every((c) => refused.includes(c) || /^Session with given id not found\.$/.test(c.reply?.error?.message ?? '')) && !parentGone, `(a navigation leaves a stale first iframe the proxy no longer knows: 'not found' is fine, anything else than the refusal is not) Page.close on each child session → ${closes.map((c) => `${c.type}: ${JSON.stringify(c.reply?.error?.message ?? c.reply?.result ?? null).slice(0, 90)}`).join(' | ')}; the user's tab ${parentGone ? 'WAS CLOSED' : 'is still open'} · registry ${brief(r5)}`);
  },

  async attach(ctx) {
    // Review round 2 (unmeasured risk): when a PAGE of an agent tab spawns children (a worker and a cross-site iframe, 4 s after load — the realistic shape) while the HUMAN is on another tab, the
    // agent-browser daemon auto-attaches them and answers on the new child sessions. Any method outside the PASSIVE set counts as an ACTION and would flip the human's tab with no agent command at all.
    // Measured from the proxy trace (recorded in browser-panel.md); the registry is read BEFORE any further agent command.
    const A = 'attach';
    const m = await spawnChildrenInBackgroundTab(ctx, { worker: true, frame: true });
    clause(A, 'ctl/the-page-spawned-children-and-the-daemon-answered-them', m.snap.code === 0 && m.methods.includes('Runtime.runIfWaitingForDebugger') && m.attached >= 2 && !m.spawnErr, `snapshot ${m.snap.code}; ${m.attached} Target.attachedToTarget (worker + cross-site iframe); ${m.requests} client->proxy requests (${m.hist}); a plain get-title afterwards ${m.spawnErr ?? 'answered'}`);
    clause(A, 'a-background-tabs-new-children-do-not-flip-the-humans-tab', m.before.tabs.find((t) => t.active)?.openedBy === 'human' && m.after.tabs.find((t) => t.active)?.openedBy === 'human' && m.after.agentSwitch === null, `human tab active before ${brief(m.before)} and after ${brief(m.after)}; agentSwitch ${JSON.stringify(m.after.agentSwitch)}. MEASURED client->proxy methods after the spawn: ${m.methods.join(' ')}`);
  },

  async background(ctx) {
    const { W1, W2, URL: U, ui } = ctx; const A = 'background';
    await reset(ctx); // W1 focused, pane open, page B (green)
    const h0 = await holderColor(ctx, 'bg-0-w1', COLORS.b);
    const w1r0 = await reg(ctx, W1);
    clause(A, 'ctl/w1-is-on-screen', colorOk(h0, COLORS.b), `${colorTxt(h0, COLORS.b)}; W1 registry ${brief(w1r0)}`);
    const open = await cli(ctx, W2, ['open', U.c]);
    const nw = await cli(ctx, W2, ['tab', 'new', U.a]);
    await softWait(async () => (await reg(ctx, W2)).tabs.length === 2 && !!titled(await reg(ctx, W2), /Tabs fixture A/), 15000, 'W2 to hold its two tabs');
    const labA = await abLabel(ctx, W2, /Tabs fixture A/); const labC = await abLabel(ctx, W2, /Tabs fixture C/);
    const swA = await cli(ctx, W2, ['tab', labA ?? 't0']);
    const gu = await cli(ctx, W2, ['get', 'url']);
    const swC = await cli(ctx, W2, ['tab', labC ?? 't0']);
    const swA2 = await cli(ctx, W2, ['tab', labA ?? 't0']);
    const w2r = await reg(ctx, W2);
    const agentTab = w2r.tabs.find((t) => t.openedBy === 'agent'), humanTab = w2r.tabs.find((t) => t.openedBy === 'human');
    clause(A, 'ctl/the-background-agent-really-worked', open.code === 0 && nw.code === 0 && swA.code === 0 && gu.code === 0 && gu.stdout.trim() === U.a && swC.code === 0 && swA2.code === 0 && w2r.tabs.length === 2, `open ${open.code} · tab new ${nw.code} · switch→A ${swA.code} · get url ${gu.stdout.trim()} · switch→C ${swC.code} · switch→A ${swA2.code} → W2 registry ${brief(w2r)}`);
    clause(A, 'background-agent-activates-nothing-the-users-tab-stays-active', !!humanTab?.active && !agentTab?.active && w2r.agentSwitch === null, `W2 registry ${brief(w2r)}; agentSwitch ${JSON.stringify(w2r.agentSwitch)} (opening / switching / acting in a workspace nobody looks at must not change what the human finds there)`);
    const h1 = await holderColor(ctx, 'bg-1-w1-after', COLORS.b, 1500);
    const w1r1 = await reg(ctx, W1);
    clause(A, 'the-focused-workspace-is-untouched-no-focus-steal', colorOk(h1, COLORS.b) && JSON.stringify(w1r1) === JSON.stringify(w1r0) && (await noticeText(ctx)) === null, `${colorTxt(h1, COLORS.b)}; W1 registry unchanged: ${JSON.stringify(w1r1) === JSON.stringify(w1r0)}; W1 notice ${JSON.stringify(await noticeText(ctx))}`);
    // the human arrives in W2: they find their OWN tab on screen, the agent's tab in the strip with its mark
    await selectWs(ctx, W2); await openPane(ctx);
    const h2 = await holderColor(ctx, 'bg-2-w2-arrival', COLORS.c);
    const marks = await ctx.ui.eval(`document.querySelectorAll('.browser-tab[data-opened-by="agent"] .browser-tab-agent-mark').length`);
    clause(A, 'on-arrival-the-user-finds-their-own-tab-and-the-agents-in-the-strip', colorOk(h2, COLORS.c) && marks === 1 && (await noticeText(ctx)) === null, `${colorTxt(h2, COLORS.c)}; agent-marked tabs in W2's strip ${marks}; notice ${JSON.stringify(await noticeText(ctx))}`);
    grim('bg-w2-arrival.png');
    await selectWs(ctx, W1);
  },

  async refs(ctx) {
    const { W1, URL: U, ui } = ctx; const A = 'refs';
    await reset(ctx);
    // Two pages that are ONE full-viewport button each (its text = clicks received): a click dispatched ANYWHERE in a tab is counted by that tab, so a click
    // routed to the wrong tab cannot hide behind "nothing lived at those coordinates".
    await ui.eval(`window.orchestra.browserNavigate(${sel(W1.id)}, ${sel(U.hitB)}).then(() => true)`); // the user's tab
    await softWait(async () => /Hit fixture B/.test((await reg(ctx, W1)).tabs[0]?.title ?? ''), 15000, 'the user tab to show hit-b');
    await cli(ctx, W1, ['tab', 'new', U.hitA]);
    await softWait(async () => !!titled(await reg(ctx, W1), /Hit fixture A/), 15000, 'the agent tab to show hit-a');
    const snap = await cli(ctx, W1, ['snapshot', '-i']);
    const hitA = (/button "Hit A"[^\n]*\[ref=(e\d+)\]/.exec(snap.stdout) ?? [])[1];
    clause(A, 'ctl/agent-has-a-ref-from-its-tab', snap.code === 0 && !!hitA, `snapshot on the agent tab: ${show(snap)}`);
    // the user clicks THEIR tab in the strip; the agent's daemon pointer stays on its own tab
    const idxH = await ui.eval(`[...document.querySelectorAll('.browser-tab')].findIndex((e) => e.dataset.openedBy === 'human')`);
    await clickSel(ctx, '.browser-tab', idxH);
    await softWait(async () => (await reg(ctx, W1)).tabs.find((t) => t.active)?.openedBy === 'human', 10000, 'the user tab to be active');
    const oUser = await oracle(ctx, U.hitB); const oAgent = await oracle(ctx, U.hitA);
    const hits = async () => ({ agent: await oAgent.eval(`document.getElementById('hit').textContent`), user: await oUser.eval(`document.getElementById('hit').textContent`) });
    const h0 = await hits();
    clause(A, 'ctl/both-pages-count-zero-clicks-and-the-user-is-on-B', h0.agent === '0' && h0.user === '0', `clicks received: agent tab ${h0.agent}, user tab ${h0.user}`);
    const click = await cli(ctx, W1, ['click', `@${hitA}`]);
    await softWait(async () => (await hits()).agent === '1', 10000, 'the agent tab to receive the click');
    const h1 = await hits(); const r1 = await reg(ctx, W1);
    clause(A, 'a-ref-clicks-the-tab-it-came-from-never-the-tab-the-user-is-on', click.code === 0 && h1.agent === '1' && h1.user === '0', `click @${hitA}: ${show(click)} → clicks received: agent tab ${h1.agent}, user tab ${h1.user}`);
    clause(A, 'and-that-tab-came-to-the-front-visibly', r1.tabs.find((t) => t.active)?.openedBy === 'agent' && /Hit fixture A/.test((await noticeText(ctx)) ?? ''), `registry ${brief(r1)}; notice ${JSON.stringify(await noticeText(ctx))} (the click needs its tab on screen)`);
    // an explicit switch drops the refs: the OTHER tab's refs are not this tab's — a stale ref, loudly, and nothing clicked
    const snapA = await cli(ctx, W1, ['snapshot', '-i']); const hitA2 = (/button "Hit A"[^\n]*\[ref=(e\d+)\]/.exec(snapA.stdout) ?? [])[1];
    const userTab = (await abTabs(ctx, W1)).find((t) => /Hit fixture B/.test(t.title));
    await cli(ctx, W1, ['tab', userTab?.tabId ?? 't0']);
    const stale = await cli(ctx, W1, ['click', `@${hitA2}`]);
    const h2 = await hits();
    clause(A, 'a-ref-after-an-explicit-switch-is-a-loud-stale-ref', !!hitA2 && stale.code !== 0 && /^browser_stale_ref: /.test(stale.stderr) && h2.agent === '1' && h2.user === '0', `A's ref @${hitA2} after \`tab ${userTab?.tabId}\`: click → ${show(stale)} · clicks received: agent tab ${h2.agent}, user tab ${h2.user} (no wrong click)`);
    oUser.close(); oAgent.close();
  },

  async restart(ctx) {
    // F3 of the #393 review: restored tabs are renumbered per process and agent-browser's `tN` ids are session-local, so an id the agent remembers from BEFORE a restart can name
    // ANOTHER tab afterwards. Engineered collision: the agent's remembered `tA` is made to be, after the restart, the id of the USER's tab. The user's tab must survive `tab close <stale id>`.
    const { W1, URL: U, ui } = ctx; const A = 'restart';
    await reset(ctx);
    await cli(ctx, W1, ['tab', 'new', U.a]);
    await softWait(async () => !!titled(await reg(ctx, W1), /Tabs fixture A/), 15000, 'page A tab');
    await cli(ctx, W1, ['tab', 'new', U.c]);
    await softWait(async () => !!titled(await reg(ctx, W1), /Tabs fixture C/), 15000, 'page C tab');
    const before = await abTabs(ctx, W1); // agent-browser's ids as the agent saw them: B (user), A, C — C is active
    const oldA = before.find((t) => /Tabs fixture A/.test(t.title))?.tabId;
    const r0 = await reg(ctx, W1);
    const tabsFile = path.join(ctx.world.ohome, 'userData', 'orchestra', 'browser-tabs.json');
    await waitFor(() => { try { return JSON.parse(fs.readFileSync(tabsFile, 'utf8')).workspaces?.[W1.id]?.tabs?.length === 3; } catch { return false; } }, 10000, 'the 3 tabs to reach browser-tabs.json');
    clause(A, 'ctl/three-tabs-before-the-restart', r0.tabs.length === 3 && r0.tabs.filter((t) => t.openedBy === 'agent').length === 2 && !!oldA, `registry ${brief(r0)}; the agent remembers A as ${oldA} (agent-browser ids ${JSON.stringify(before.map((t) => [t.tabId, t.title.slice(-1)]))})`);
    // SIGKILL (the harsh case: the host-owned daemon outlives the app), then boot the SAME world again
    ui.close();
    try { process.kill(-ctx.app.pid, 'SIGKILL'); } catch {}
    await waitFor(() => { try { process.kill(ctx.app.pid, 0); return false; } catch { return true; } }, 15000, 'the SIGKILLed app to be gone');
    for (const p of listProcsByHome(ctx.world.ohome)) { try { process.kill(p, 'SIGKILL'); } catch {} } // keeper + stub claude outlive the app by design
    await sleep(800);
    const layout = abLayout(ctx.world.ohome, XDG);
    if (/\/orch-ab-[0-9a-f]{8}$/.test(layout.socketDir)) fs.rmSync(layout.socketDir, { recursive: true, force: true }); // the old daemon died with the app's process group; its socket dir is this world's own
    Object.assign(ctx, await bootApp(ctx.world, ctx.armDir, 'boot2'));
    await waitFor(() => ctx.ui.eval(`document.body.innerText.includes(${sel(W1.branch)})`), 60000, 'the seeded workspaces in the sidebar (boot 2)');
    await sleep(1500);
    await selectWs(ctx, W1); await openPane(ctx); // first panel open after boot = lazy restore
    await softWait(async () => (await reg(ctx, W1)).tabs.length === 3, 20000, 'the 3 tabs to be restored');
    const r1 = await reg(ctx, W1);
    clause(A, 'restored-tabs-keep-who-opened-them', r1.tabs.length === 3 && r1.tabs.filter((t) => t.openedBy === 'agent').length === 2 && r1.tabs.filter((t) => t.openedBy === 'human').length === 1, `after the restart: registry ${brief(r1)}`);
    const after = await abTabs(ctx, W1); // a NEW daemon: agent-browser numbers the tabs again, in the order it now sees them
    const nowOldA = after.find((t) => t.tabId === oldA);
    clause(A, 'ctl/the-remembered-id-now-names-the-users-tab', /Tabs fixture B/.test(nowOldA?.title ?? ''), `the agent remembers A as ${oldA}; after the restart ${oldA} = ${JSON.stringify(nowOldA?.title)} (agent-browser ids now ${JSON.stringify(after.map((t) => [t.tabId, t.title.slice(-1)]))})`);
    const vt0 = (await viewTargets(ctx)).length;
    const stale = await cli(ctx, W1, ['tab', 'close', oldA ?? 't0']);
    await sleep(800);
    const r2 = await reg(ctx, W1);
    clause(A, 'a-stale-id-that-now-names-the-users-tab-cannot-close-it', stale.code !== 0 && /^browser_tab_not_owner: /.test(stale.stderr) && !!titled(r2, /Tabs fixture B/) && (await viewTargets(ctx)).length === vt0, `tab close ${oldA}: ${show(stale)} → registry ${brief(r2)} · live page targets ${vt0} → ${(await viewTargets(ctx)).length}`);
    const sw = await cli(ctx, W1, ['tab', oldA ?? 't0']);
    clause(A, 'a-stale-id-switch-says-whose-tab-it-landed-on', sw.code === 0 && /Tabs fixture B[^\n]*\(the user's\)/.test(sw.stdout.split('\n')[0] ?? ''), `tab ${oldA} (now the user's B): ${show(sw)} — the first line carries (the user's), so a remembered id that drifted onto the user's tab is not silent`);
    const list = await cli(ctx, W1, ['tab', 'list']);
    clause(A, 'tab-list-after-the-restart-still-says-who-opened-which', list.code === 0 && /Tabs fixture B[^\n]*\(the user's\)/.test(list.stdout) && /Tabs fixture A[^\n]*\(yours\)/.test(list.stdout) && /Tabs fixture C[^\n]*\(yours\)/.test(list.stdout), show(list));
  },
};

async function runArms(ctx) {
  await waitFor(() => ctx.ui.eval(`document.body.innerText.includes(${sel(ctx.W1.branch)})`), 60000, 'the seeded workspaces in the sidebar');
  await sleep(1500);
  clause('ctl', 'app-in-my-sway', new RegExp(`"pid":\\s*${ctx.app.pid}\\b`).test(sh('swaymsg', ['-t', 'get_tree'])), `app pid ${ctx.app.pid} present in my sway's get_tree`);
  for (const arm of ARM_LIST) {
    console.log(`\n== arm ${arm} ==`);
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
// A mutant may break OTHER arms (collateral): their arm-scoped controls are not the mutant's concern. Global controls always are.
const ctlRed = results.filter((c) => isCtl(c) && !c.ok && (c.arm === 'ctl' || targetArms.has(c.arm))), armRed = results.filter((c) => !isCtl(c) && !c.ok);
fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify({ app: APP_DIR, mutant: MUTANT, results, shots }, null, 2));
let verdict, rc;
if (MUTANT) {
  const want = MUTANTS[MUTANT].arms;
  const redArms = new Set(armRed.map((c) => c.arm));
  const missed = want.filter((a) => !redArms.has(a));
  ({ verdict, rc } = ctlRed.length === 0 && missed.length === 0
    ? { verdict: `MUTANT ${MUTANT} KILLED: arm(s) ${want.join(', ')} red (${armRed.filter((c) => want.includes(c.arm)).map((c) => c.clause).join(', ')}), every control green; other red arms: ${[...redArms].filter((a) => !want.includes(a)).join(', ') || 'none'}`, rc: 0 }
    : { verdict: `MUTANT ${MUTANT} SURVIVED/INVALID: arms not red: ${missed.join(', ') || 'none'}; controls red: ${ctlRed.map((c) => c.clause).join('; ') || 'none'}`, rc: 1 });
} else {
  ({ verdict, rc } = ctlRed.length === 0 && armRed.length === 0
    ? { verdict: `ALL GREEN: ${results.length} clauses (${results.filter(isCtl).length} controls, ${results.length - results.filter(isCtl).length} arm clauses) over ${ARM_LIST.length} arms`, rc: 0 }
    : { verdict: `RED: ${results.filter((c) => !c.ok).map((c) => `${c.arm}:${c.clause}`).join('; ')}`, rc: 1 });
}
console.log(`\nVERDICT: ${verdict}`);
process.exit(process.exitCode || rc);
