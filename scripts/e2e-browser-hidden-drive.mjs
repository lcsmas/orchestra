// #406 phase 2 (policy A2, ledger #409 §Decisions Q2 + §Go-no-go "PHASE 2 — action-time pass criteria" P1–P8): driving a tab the human cannot see, END TO END on a
// BUILT Orchestra inside the contained rig's own headless sway. The REAL proxy (a raw CDP client = what agent-browser is) → host → panel → hidden WebContentsViews,
// six seeded workspaces (W1 focused with its pane open; the others background), up to 40 loaded views. Every reading is an INDEPENDENT oracle: the page's own
// counters through the app's debug port, grim on the rig's compositor, the app's registry IPC, /proc for CPU — never the chain under test.
//
//   act       P1 (first screenshot FRESH in all 3 Page.captureScreenshot forms, ≤ 2 s), P2 (click + type land ≤ 700 ms), P3 (throttled again ≤ 2 s after the last action),
//             P4 (the human's tab, focus and pixels never change), P5 (no crash), P8 latency — ≥ 20 runs per target kind (background TAB / background WORKSPACE), alternating order
//   cpu       P3 CPU (a 40-view population after a burst of actions vs a never-acted window ≤ 10 % of a core) + P8 report (K = 1/4/16 views flipped at once for 10 s)
//   never     P6 (a tab that never loaded while attached answers under the cover; with nothing on screen to cover it, a fast clear refusal)
//   orphan    P7 (an action killed mid-flight leaves no view unthrottled longer than linger + 5 s)
//
// Usage (via scripts/e2e-browser-hidden-drive.sh): <app-dir> --live-home <real $HOME> [--arm a,b] [--list] [--mutant <name>] [--runs8 48] [--runs40 24] [--out dir]
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
const ARMS = ['diag', 'stale', 'act', 'cpu', 'never', 'orphan', 'navigate', 'offscreen', 'cover'];
// Each edit is a regex over the MINIFIED main chunk (names captured, not hard-coded) and must match EXACTLY once. `arms` = the arms that must go RED.
const ID = '[\\w$]+';
const ACTIVATE_TAB = /function ([\w$]+)\(e,t\)\{const n=[\w$]+\(e\),r=n==null\?void 0:n\.tabs\.find\(s=>s\.id===t\);if\(!n\|\|!r\)throw new Error\(`browser tab \$\{t\} not found in workspace \$\{e\}`\);return [\w$]+\(n,r\),n\.state\}/;
const MUTANTS = {
  'no-flip': { file: 'main', arms: ['act'], why: 'a lease never turns backgroundThrottling off (the flip-less build): the ledger\'s must-FAIL for "the flip is what keeps the agent\'s action live"',
    edits: [[new RegExp(`${ID}&&(${ID})\\.setBackgroundThrottling\\(!1\\),(${ID}\\(\\)),`), '$2,']] },
  'no-flip-back': { file: 'main', arms: ['act', 'orphan'], why: 'the lease end / sweep never turns backgroundThrottling back ON (P3 + P7 must-FAIL)',
    edits: [[new RegExp(`(forcing the flip-back\`\\);const ${ID}=${ID}\\(${ID}\\);if\\(${ID}\\)\\{)try\\{${ID}\\.setBackgroundThrottling\\(!0\\)\\}catch\\{\\}`), '$1']] },
  'no-unpin': { file: 'main', arms: ['act'], why: 'the lease end flips back but takes no unpin capture: the page a capture pinned unthrottled stays unthrottled (P3)',
    edits: [[new RegExp(`(${ID}\\.delete\\(${ID}\\))&&\\(${ID}==null\\?void 0:${ID}\\.surface\\)==="hidden"&&${ID}\\(\\)\\.then\\(async ${ID}=>\\{${ID}&&\\(await ${ID}\\(${ID}\\),${ID}\\.isHeld\\(${ID}\\)&&${ID}\\.add\\(${ID}\\)\\)\\}\\)\\}else`), '$1}else']] },
  'no-lease-end-no-watchdog': { file: 'main', arms: ['orphan'], why: 'a lease is never released by its end() and the watchdog never force-releases an orphan: a killed action leaves the view unthrottled (P7 must-FAIL)',
    edits: [[new RegExp(`end:\\(\\)=>\\{${ID}\\|\\|\\(${ID}=!0,${ID}\\.release\\(${ID},Date\\.now\\(\\)\\),${ID}\\(\\)\\)\\}`), 'end:()=>{}'],
      [new RegExp(`(${ID})\\.holders>0&&(${ID})-\\1\\.touchedAt>=${ID}\\?`), '!1?']] },
  'switch-to-front': { file: 'main', arms: ['act'], why: 'the pre-#406 fallback: an action on a hidden tab makes it the active tab first — the human\'s view changes (P4 must-FAIL)',
    edits: [[new RegExp(`async function ${ID}\\((${ID}),${ID},${ID}\\)\\{var ${ID};const (${ID})=${ID}\\(\\1,${ID}\\),${ID}=${ID}\\(\\2\\);[^]{0,900}?if\\(${ID}\\.act==="direct"\\)return ${ID};`),
      (m, ws, tab, ...rest) => { const whole = rest[rest.length - 1]; const act = ACTIVATE_TAB.exec(whole)?.[1]; if (!act) throw new Error('activateTab not found in the chunk'); return `${m}try{${act}(${ws},${tab}.id)}catch{}`; }]] },
  'no-nav-lease-end': { file: 'main', arms: ['navigate'], why: 'removing a hidden view (a navigation under a lease) forgets the lease without flipping throttling back ON: the new document stays unthrottled (P7n must-FAIL)',
    edits: [[new RegExp(`if\\((${ID})\\.isHeld\\((${ID})\\)\\)try\\{\\((${ID})=${ID}\\(${ID}\\)\\)==null\\|\\|\\3\\.setBackgroundThrottling\\(!0\\)\\}catch\\{\\}`), '']] },
  'no-load-settle': { file: 'main', arms: ['navigate'], why: 'a surfaced tab does not wait for its still-loading document: it is hidden / removed while loading and the screenshot finds no frame (F3 must-FAIL)',
    edits: [[new RegExp(`for\\(;!${ID}\\.aborted&&Date\\.now\\(\\)-${ID}<${ID}&&${ID}\\(e\\)&&\\(\\(${ID}=${ID}\\.isLoading\\)!=null&&${ID}\\.call\\(${ID}\\)\\|\\|Date\\.now\\(\\)-e\\.stoppedAt<${ID}\\);\\)await`), 'for(;!1;)await']] },
  'no-still-loading-refusal': { file: 'main', arms: ['navigate'], why: 'a page that never finishes loading is not refused with the true cause: the capture falls through to a misleading "no frame" (F3 must-FAIL)',
    edits: [[new RegExp(`(new Error\\(${ID}\\);)if\\(${ID}\\)throw ${ID}\\(e\\),new Error\\(${ID}\\);(e\\.surface==="visible")`), '$1$2']] },
  'no-offscreen-gate': { file: 'main', arms: ['offscreen'], why: 'the window-paints gate is gone: a click / wheel / screenshot on an undisplayed desktop runs, hangs, and leaves the page unthrottled (F1 must-FAIL = the old behaviour)',
    edits: [[new RegExp(`if\\(${ID}!=="other"&&!await ${ID}\\(\\)\\)throw new Error\\(${ID}\\);`), '']] },
  'no-cover-abort': { file: 'main', arms: ['cover'], why: 'a pulse is not aborted when its cover leaves the screen: the pulsing page shows in the vacated pane (F2 must-FAIL)',
    edits: [[new RegExp(`if\\(!\\((${ID})\\.cover!==e\\|\\|\\1\\.aborted\\)\\)\\{`), 'if(!1){']] },
  'no-surface': { file: 'main', arms: ['never'], why: 'a never-composited tab is not surfaced under the cover: it has no frame and takes no input (P6 must-FAIL)',
    edits: [[new RegExp(`${ID}\\.act==="surface-then-lease"&&await ${ID}\\(${ID},${ID}\\);`), '']] },
  'no-cover-refusal': { file: 'main', arms: ['never'], why: 'a never-composited tab with nothing to cover it is not refused fast: the capture waits for a frame that never comes (P6 refusal must-FAIL)',
    edits: [[/:\{act:"refuse",reason:"needs-first-paint",message:[\w$]+\}/, ':{act:"lease"}']] },
};
const NAV_GAP = Number(flag('--nav-gap', '0')), RUNS_NAV = Number(flag('--runs-nav', '24')), KINDS_ONLY = flag('--kinds', null), LOAD_K = Number(flag('--load', '0')), RUNS_STALE = Number(flag('--runs-stale', '120')), STALE_GAP = Number(flag('--gap', '600'));
const RUNS8 = Number(flag('--runs8', '48')), RUNS40 = Number(flag('--runs40', '40')), RUNS_NEVER = Number(flag('--runs-never', '20'));
if (argv.includes('--list')) {
  console.log(`arms: ${ARMS.join(' ')}`);
  console.log(`mutants: ${Object.keys(MUTANTS).join(' ')}`);
  process.exit(0);
}

const APP_DIR = argv[0] && !argv[0].startsWith('--') ? fs.realpathSync(argv[0]) : null;
const LIVE_HOME = flag('--live-home', null);
const ARM_LIST = (flag('--arm', null) ?? ARMS.filter((a) => a !== 'diag' && a !== 'stale').join(',')).split(',').sort((a, b) => ARMS.indexOf(a) - ARMS.indexOf(b)); // canonical order whatever --arm lists: `restart` needs the daemon's FIRST ids
const MUTANT = flag('--mutant', null);

// Memory floor (the fleet guard): a 1 Hz MemAvailable read; < 6.5 GB kills the app (teardown still runs) and turns the verdict red. Scope shmem before/after: a leaked rig process once killed #407's scope.
let CURCTX = null, memMinKb = Infinity, memAborted = false;
const memAvailKb = () => Number(/MemAvailable:\s+(\d+)/.exec(fs.readFileSync('/proc/meminfo', 'utf8'))?.[1] ?? NaN);
const memTimer = setInterval(() => {
  try {
    const kb = memAvailKb(); memMinKb = Math.min(memMinKb, kb);
    if (kb < 6500000 && !memAborted) { memAborted = true; console.log(`ABORT: MemAvailable ${kb} kB < 6.5 GB — the fleet memory guard floor; killing the app`); const pid = CURCTX?.app?.pid; if (pid) { try { process.kill(-pid, 'SIGTERM'); } catch {} } }
  } catch { /* meminfo unreadable: the clause below reports min=Infinity */ }
}, 1000);
memTimer.unref();
function scopeShmem() {
  try {
    const rel = fs.readFileSync('/proc/self/cgroup', 'utf8').trim().split('\n').map((l) => l.split(':').slice(2).join(':'))[0];
    const rd = (r) => { try { return Number(/^shmem (\d+)/m.exec(fs.readFileSync(`/sys/fs/cgroup${r}/memory.stat`, 'utf8'))?.[1]); } catch { return null; } };
    return { leaf: rd(rel), parent: rd(rel.replace(/\/[^/]+$/, '')) };
  } catch { return { leaf: null, parent: null }; }
}
const SHMEM0 = scopeShmem();
console.log(`[rig] scope shmem before: leaf ${SHMEM0.leaf} B, parent ${SHMEM0.parent} B; MemAvailable ${memAvailKb()} kB`);

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
const WS_NAMES = ['b406-one', 'b406-two', 'b406-three', 'b406-four', 'b406-five', 'b406-six'];
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
const MARKER = path.join(APP_DIR ?? '/nonexistent', 'dist-electron', '.b406-mutant-active');
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
  const inspectPort = argv.includes('--inspect-main') ? await freePort() : 0; // DIAGNOSTIC ONLY: the main process's node inspector (run experiments inside the app)
  const app = spawn(path.join(APP_DIR, 'node_modules/electron/dist/electron'), [...(inspectPort ? [`--inspect=127.0.0.1:${inspectPort}`] : []), APP_DIR, '--ozone-platform=wayland'], { cwd: APP_DIR, env, stdio: ['ignore', fd, fd], detached: true });
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
  return { app, port, ui, targets, env, inspectPort };
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
  CURCTX = ctx;
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
  const send = (method, params, sessionId, ms = 6000) => new Promise((res) => { const n = ++id; const t = setTimeout(() => { pending.delete(n); res({ error: { message: `timed out after ${ms}ms (${method})` } }); }, ms); pending.set(n, (m) => { clearTimeout(t); res(m); }); ws.send(JSON.stringify({ id: n, method, params, ...(sessionId ? { sessionId } : {}) })); });
  return { call: (method, params = {}) => send(method, params), callOn: (sessionId, method, params = {}, ms = 6000) => send(method, params, sessionId, ms), onEvent: (l) => listeners.push(l), close: () => ws.close() };
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

// ── #406 phase 2 arms ───────────────────────────────────────────────────────────────────────────────────────────────────────────
// Targets: a background TAB of the focused workspace (kind `tab`) and a tab of a background WORKSPACE (kind `workspace`), with N other loaded views
// present, driven through the REAL proxy (a raw CDP client = what agent-browser is) while every oracle is independent: the app's debug port for the page's own
// counters, grim for the compositor, the app's registry IPC for the tab state, /proc for CPU.
const PALETTE = ['1f77b4', 'ff7f0e', '2ca02c', '9467bd', '8c564b', 'e377c2', '17becf', 'bcbd22', '393b79', '637939', 'a55194', '843c39'].map((h) => [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)));
const HUMAN = [0xd6, 0x27, 0x28]; // tabs-a.html: the human's visible tab (and the cover of every pulse)
const hdUrl = (ctx, id, c = 'd62728') => `${ctx.FIX}/hidden-drive.html?id=${id}&c=${c}`;
const idOf = (url) => Number(/[?&]id=(\d+)/.exec(url || '')?.[1] ?? NaN);
const median = (a) => { const s = a.filter((x) => Number.isFinite(x)).sort((x, y) => x - y); return s.length ? s[s.length >> 1] : null; };
const pct = (a, p) => { const s = a.filter((x) => Number.isFinite(x)).sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : null; };
const CLK = Number(sh('getconf', ['CLK_TCK']).trim());

/** ticks of the app's whole process tree (by ppid from the app pid) — CPU of what the rig launched, nothing else */
function treeTicks(rootPid) {
  const all = new Map(), kids = new Map();
  for (const d of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(d)) continue;
    try { const s = fs.readFileSync(`/proc/${d}/stat`, 'utf8'); const f = s.slice(s.lastIndexOf(')') + 2).split(' '); const pid = Number(d); all.set(pid, { ppid: +f[1], ticks: +f[11] + +f[12] }); (kids.get(+f[1]) ?? kids.set(+f[1], []).get(+f[1])).push(pid); } catch {}
  }
  let t = 0; const q = [rootPid]; while (q.length) { const p = q.pop(); t += all.get(p)?.ticks ?? 0; for (const c of kids.get(p) ?? []) q.push(c); }
  return t;
}
async function cpuWindow(ctx, ms) { const a = treeTicks(ctx.app.pid), t0 = Date.now(); await sleep(ms); const b = treeTicks(ctx.app.pid); return +(((b - a) / CLK / ((Date.now() - t0) / 1000)) * 100).toFixed(2); }

/** the app's own state of the human's side: the focused workspace's registry + the renderer's focused element — must not change during an agent action */
async function humanState(ctx) {
  const r = await reg(ctx, ctx.W1);
  const focus = await ctx.ui.eval(`(() => { const e = document.activeElement; return e ? e.tagName + '#' + (e.id || '') + '.' + String(e.className || '').slice(0, 40) : null; })()`);
  return { active: r.activeTabId, notice: !!r.agentSwitch, tabs: r.tabs.map((t) => `${t.id}${t.active ? '*' : ''}`).join(','), focus };
}
/** compositor sampler: share of the pane rect that is NOT the human's colour, sampled until stopped */
function startLeakSampler(ctx, rect) {
  const out = []; let stop = false;
  const loop = (async () => {
    while (!stop) {
      try {
        const f = path.join(ctx.armDir, 'leak.png'); sh('grim', ['-s', '0.5', '-o', 'HEADLESS-1', f], { env: { PATH: '/usr/bin:/bin', XDG_RUNTIME_DIR: XDG, WAYLAND_DISPLAY: RIG_WAYLAND } });
        const I = decodePng(fs.readFileSync(f)); const x0 = Math.round(rect.left / 2) + 4, x1 = Math.round((rect.left + rect.width) / 2) - 4, y0 = Math.round(rect.top / 2) + 4, y1 = Math.round((rect.top + rect.height) / 2) - 4;
        let n = 0, bad = 0; for (let y = y0; y < y1; y += 3) for (let x = x0; x < x1; x += 3) { const o = (y * I.w + x) * I.ch; n++; if (!near([I.data[o], I.data[o + 1], I.data[o + 2]], HUMAN, 14)) bad++; }
        out.push([Date.now(), n ? bad / n : 0]);
      } catch { /* a missed sample is a missed sample */ }
      await sleep(30); // YIELD: the loop is synchronous otherwise and `stop` could never be seen
    }
  })();
  return { stop: async (tAction) => { stop = true; await loop; const base = Math.max(0, ...out.filter((x) => x[0] < tAction).map((x) => x[1])), during = Math.max(0, ...out.filter((x) => x[0] >= tAction).map((x) => x[1])); return { samples: out.length, base, during, max: Math.max(0, during - base) }; } }; // leak = what the action ADDS to the pane's baseline (a constant 0.2 % of scrollbar / edge pixels is not a leak)
}
/** grim samples of `rect` (CSS px, scale 2): the fraction of pixels near `want`; `stop(tMark)` → the max fraction BEFORE and AT/AFTER tMark. */
function startColorSampler(ctx, rect, want) {
  const out = []; let stop = false;
  const loop = (async () => {
    while (!stop) {
      try {
        const f = path.join(ctx.armDir, 'color.png'); sh('grim', ['-s', '0.5', '-o', 'HEADLESS-1', f], { env: { PATH: '/usr/bin:/bin', XDG_RUNTIME_DIR: XDG, WAYLAND_DISPLAY: RIG_WAYLAND } });
        const I = decodePng(fs.readFileSync(f)); const x0 = Math.round(rect.left / 2) + 4, x1 = Math.round((rect.left + rect.width) / 2) - 4, y0 = Math.round(rect.top / 2) + 4, y1 = Math.round((rect.top + rect.height) / 2) - 4;
        let n = 0, hit = 0; for (let y = y0; y < y1; y += 3) for (let x = x0; x < x1; x += 3) { const o = (y * I.w + x) * I.ch; n++; if (near([I.data[o], I.data[o + 1], I.data[o + 2]], want, 14)) hit++; }
        out.push([Date.now(), n ? hit / n : 0]);
      } catch { /* a missed sample is a missed sample */ }
      await sleep(30);
    }
  })();
  return { stop: async (tMark) => { stop = true; await loop; return { before: Math.max(0, ...out.filter((x) => x[0] < tMark).map((x) => x[1])), after: Math.max(0, ...out.filter((x) => x[0] >= tMark).map((x) => x[1])), samples: out.length }; } };
}
const targetOf = async (ctx, id, ms = 15000) => waitFor(async () => (await ctx.targets()).find((x) => x.type === 'page' && idOf(x.url) === id) || null, ms, `the page target of hidden-drive id ${id}`);

/** Build the world: W1 = the human's red tab + 7 hidden-drive tabs; each other workspace = 8 hidden-drive tabs (visited once, then hidden). */
async function populate(ctx, which, idBase) {
  const ids = {}; let id = idBase;
  for (const W of which) {
    await selectWs(ctx, W); await openPane(ctx);
    const r0 = await reg(ctx, W);
    ids[W.id] = [];
    const loaded = async (title) => waitFor(async () => (await reg(ctx, W)).tabs.some((t) => t.title === title), 20000, `${title} to load in ${W.branch}`);
    if (W === ctx.W1) { await ctx.ui.eval(`window.orchestra.browserNavigate(${sel(W.id)}, ${sel(ctx.URL.a)}).then(() => true)`); await loaded('Tabs fixture A'); }
    else { id++; await ctx.ui.eval(`window.orchestra.browserNavigate(${sel(W.id)}, ${sel(hdUrl(ctx, id))}).then(() => true)`); ids[W.id].push(id); await loaded('hd-' + id); await sleep(1000); }
    for (let i = (W === ctx.W1 ? 1 : 1); i < 8; i++) {
      id++; const res = await ctx.ui.eval(`window.orchestra.browserTabNew(${sel(W.id)}, ${sel(hdUrl(ctx, id, PALETTE[id % PALETTE.length].map((v) => v.toString(16).padStart(2, '0')).join('')))}).then((r) => ({ ok: r.ok, tabId: r.tabId }))`);
      if (!res.ok) throw new Error(`tab ${i} of ${W.branch} refused`); ids[W.id].push(id);
      await loaded('hd-' + id); await sleep(1000); // the human looked at it: its page has painted before the next tab takes the screen
    }
    await waitFor(async () => (await reg(ctx, W)).tabs.length === 8, 20000, `${W.branch} to hold 8 tabs`);
    if (W === ctx.W1) { await ctx.ui.eval(`window.orchestra.browserTabActivate(${sel(W.id)}, ${sel(r0.tabs[0].id)}).then(() => true)`); }
    await sleep(1200);
  }
  await selectWs(ctx, ctx.W1); await openPane(ctx); await sleep(800);
  return ids;
}
/** a run that has not finished in 120 s is a FAILURE that names the step it is stuck in (never a silent hang) */
const guarded = (ctx, p) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`run stuck > 120 s at ${ctx.step}`)), 120000))]);

/** ONE agent action on a hidden tab, through the proxy: 3 screenshot forms, a click, typed text; every P1–P4 reading. */
async function oneRun(ctx, kind, W, id, runNo, ep, fast = false) {
  const S = (name) => { ctx.step = `${kind}#${runNo}/id${id}:${name}`; if (argv.includes('--trace')) console.log(`    [step] ${ctx.step}`); };
  S('connect-oracle');
  const o = await Cdp.connect((await targetOf(ctx, id)).webSocketDebuggerUrl);
  const want = PALETTE[runNo % PALETTE.length], wantHex = want.map((v) => v.toString(16).padStart(2, '0')).join('');
  S('set-colour');
  await o.eval(`document.getElementById('in').value = ''; __hd.set('#${wantHex}')`); // the page changes while the tab is hidden + throttled: a stale frame cannot read `want`
  await sleep(1500);
  S('human-state');
  const before = fast ? null : await humanState(ctx); const rect = fast ? null : await rectOf(ctx, '.browser-panel:not(.browser-panel-hidden) .browser-holder');
  S('leak-sampler');
  const leak = fast ? null : startLeakSampler(ctx, rect);
  S('proxy-attach');
  const raw = await rawProxyClient(ep.wsUrl);
  const tid = await waitFor(async () => { const t = await raw.call('Target.getTargets'); return t.result?.targetInfos?.find((x) => idOf(x.url) === id)?.targetId ?? null; }, 8000, `proxy target for id ${id}`);
  const sid = (await raw.call('Target.attachToTarget', { targetId: tid, flatten: true })).result.sessionId;
  const forms = [['default', { format: 'png' }], ['fromSurface:false', { format: 'png', fromSurface: false }], ['captureBeyondViewport', { format: 'png', captureBeyondViewport: true }]];
  const rot = runNo % 3; const order = [...forms.slice(rot), ...forms.slice(0, rot)];
  const t0 = Date.now(); const shots = [];
  for (const [name, params] of fast ? order.slice(0, 1) : order) {
    S(`shot-${name}`);
    const r = await raw.callOn(sid, 'Page.captureScreenshot', params); const ms = Date.now() - t0;
    let color = null, fresh = false;
    if (r.result?.data) { try { const I = decodePng(Buffer.from(r.result.data, 'base64')); color = blockColor(I, I.w >> 1, I.h >> 1, 8); fresh = near(color, want, 14); } catch { /* not a png */ } }
    shots.push({ name, fresh, ms, color, error: r.error?.message, at: new Date(t0).toISOString(), want: wantHex });
  }
  if (fast) { raw.close(); o.close(); return { kind, id, runNo, t: Date.now(), shots }; }
  // click + type (CDP Input.* through the proxy)
  S('click-type');
  const m0 = await o.eval('__hd.mouse()'); const tIn = Date.now();
  await raw.callOn(sid, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: 320, y: 218, button: 'left', clickCount: 1 });
  await raw.callOn(sid, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: 320, y: 218, button: 'left', clickCount: 1 });
  await raw.callOn(sid, 'Input.insertText', { text: 'hello' });
  let landed = null; for (let i = 0; i < 60 && landed === null; i++) { const [m, v] = await o.eval('[__hd.mouse(), __hd.value()]'); if (m > m0 && v === 'hello') landed = Date.now() - tIn; else await sleep(20); }
  const miss = landed === null || landed > 700 ? await o.eval('[__hd.mouse() - ' + m0 + ', __hd.value(), document.activeElement && document.activeElement.id, document.visibilityState, __hd.ticks()]').catch((e) => String(e)) : null; // evidence for a P2 miss: did the click land, was the text typed, who had focus
  // P2b: a page effect that needs a TIMER (150 ms) must be on screen 450 ms later — the lease keeps the page unthrottled for the action; a throttled page fires it up to 1 s late
  S('timer-effect');
  const want2 = PALETTE[(runNo + 5) % PALETTE.length], want2Hex = want2.map((v) => v.toString(16).padStart(2, '0')).join('');
  await o.eval(`__hd.later('#${want2Hex}', 150)`); await sleep(450);
  const r2 = await raw.callOn(sid, 'Page.captureScreenshot', { format: 'png' }); let c2 = null, fresh2 = false;
  if (r2.result?.data) { try { const I2 = decodePng(Buffer.from(r2.result.data, 'base64')); c2 = blockColor(I2, I2.w >> 1, I2.h >> 1, 8); fresh2 = near(c2, want2, 14); } catch { /* not a png */ } }
  const timerEffect = { fresh: fresh2, color: c2, want: want2Hex };
  S('leak-stop');
  const lk = await leak.stop(t0); const after = await humanState(ctx);
  raw.close(); const tEnd = Date.now();
  S('p3-rate');
  // P3: the view is throttled again 2 s after the last action: tick rate over the next second
  await sleep(Math.max(0, tEnd + 2000 - Date.now())); const a = await o.eval('__hd.ticks()'), ta = Date.now(); await sleep(1000); const b = await o.eval('__hd.ticks()'); const rate = +(((b - a) / ((Date.now() - ta) / 1000))).toFixed(1);
  o.close();
  return { kind, id, runNo, t: Date.now(), shots, landed, leak: lk, human: before.active === after.active && before.tabs === after.tabs && !after.notice && before.focus === after.focus, humanDetail: `${JSON.stringify(before)} -> ${JSON.stringify(after)}`, timersPerS: rate, miss, timerEffect };
}

function judgeRuns(arm, label, runs) {
  const by = (k) => runs.filter((r) => r.kind === k);
  for (const kind of ['tab', 'workspace']) {
    const rs = by(kind); if (!rs.length) continue;
    const forms = ['default', 'fromSurface:false', 'captureBeyondViewport'];
    const stale = rs.flatMap((r) => r.shots.map((s, idx) => ({ ...s, run: r.runNo, id: r.id, idx }))).filter((s) => !s.fresh);
    const first = rs.map((r) => r.shots[0].ms), allMs = rs.flatMap((r) => r.shots.map((s) => s.ms));
    clause(arm, `${label}/${kind}/P1-first-screenshot-fresh-all-forms`, rs.length >= 20 && stale.length === 0, `${rs.length} runs × 3 forms (${forms.join(', ')}): ${stale.length} stale/failed ${stale.slice(0, 6).map((s) => `${s.name}:${s.error ?? JSON.stringify(s.color)}@run#${s.run}/id${s.id}/shot${s.idx}/${s.ms}ms/${s.at}`).join(' ')}; every form fresh in every run`);
    clause(arm, `${label}/${kind}/P1-within-2s`, Math.max(...allMs) <= 2000, `slowest screenshot ${Math.max(...allMs)} ms after the action began (first form: median ${median(first)} / p95 ${pct(first, 0.95)} ms)`);
    clause(arm, `${label}/${kind}/P2-click-and-type-land-700ms`, rs.length >= 20 && rs.every((r) => r.landed !== null && r.landed <= 700), `${rs.filter((r) => r.landed !== null && r.landed <= 700).length}/${rs.length} landed ≤ 700 ms (median ${median(rs.map((r) => r.landed))} ms)${rs.filter((r) => r.landed === null || r.landed > 700).map((r) => ` · MISS run#${r.runNo} id${r.id} landed=${r.landed} shots=${r.shots.map((x) => `${x.name}:${x.ms}ms`).join(',')} state(clicks,value,focus,vis,ticks)=${JSON.stringify(r.miss)}`).join('')}`);
    clause(arm, `${label}/${kind}/P2b-timer-driven-page-effect-visible-during-the-action`, rs.length >= 20 && rs.every((r) => r.timerEffect?.fresh), `${rs.filter((r) => r.timerEffect?.fresh).length}/${rs.length} runs: a 150 ms page timer's colour change is in a screenshot 450 ms later (a throttled page fires it up to 1 s late)${rs.filter((r) => !r.timerEffect?.fresh).slice(0, 3).map((r) => ` · run#${r.runNo} got ${JSON.stringify(r.timerEffect?.color)} want ${r.timerEffect?.want}`).join('')}`);
    clause(arm, `${label}/${kind}/P3-throttled-again-within-2s`, rs.every((r) => r.timersPerS <= 2), `timers/s in the second after +2 s: max ${Math.max(...rs.map((r) => r.timersPerS))} over ${rs.length} runs (limit 2)`);
    clause(arm, `${label}/${kind}/P4-the-humans-view-never-changes`, rs.every((r) => r.human) && Math.max(...rs.map((r) => r.leak.max)) <= 0.002, `${rs.filter((r) => r.human).length}/${rs.length} runs: same active tab, no notice, same focus; compositor leak (excess over the pane's own baseline ${(Math.max(...rs.map((r) => r.leak.base)) * 100).toFixed(2)} %) max ${(Math.max(...rs.map((r) => r.leak.max)) * 100).toFixed(2)} % of the pane over ${rs.reduce((s, r) => s + r.leak.samples, 0)} samples${rs.find((r) => !r.human) ? ' — ' + rs.find((r) => !r.human).humanDetail : ''}`);
  }
  // alternating order, read off the wall clock
  const ts = runs.slice().sort((x, y) => x.t - y.t).map((r) => r.kind); const alt = ts.every((k, i) => i === 0 || k !== ts[i - 1]);
  clause(arm, `${label}/ctl/alternating-order-by-wall-clock`, alt, `kinds in time order: ${ts.slice(0, 8).join(',')}…`);
  console.log(`  [P8] ${label}: flip → first fresh frame (ms, first screenshot): tab p50 ${median(by('tab').map((r) => r.shots[0].ms))} p95 ${pct(by('tab').map((r) => r.shots[0].ms), 0.95)} · workspace p50 ${median(by('workspace').map((r) => r.shots[0].ms))} p95 ${pct(by('workspace').map((r) => r.shots[0].ms), 0.95)}`);
}

const ARM_FNS = {
  /** DIAGNOSTIC (needs --inspect-main): experiments inside the real app's main process on a hidden, composited tab */
  async diag(ctx) {
    const A = 'diag';
    ctx.ep = {}; for (const W of ctx.world.workspaces) ctx.ep[W.id] = await hostCall(ctx, '/browser', { id: W.id, key: W.key });
    ctx.ids = await populate(ctx, [ctx.W1], 100);
    await sleep(5000);
    const list = await (await fetch(`http://127.0.0.1:${ctx.inspectPort}/json`)).json();
    const main = await Cdp.connect(list[0].webSocketDebuggerUrl);
    await main.send('Runtime.enable');
    const ex = async (code) => { try { return await main.eval(`(async () => { ${code} })()`); } catch (e) { return `ERR ${e.message}`.slice(0, 300); } };
    const pre = `const __req = process.getBuiltinModule('node:module').createRequire(${JSON.stringify(path.join(APP_DIR, 'package.json'))}); const { webContents, BaseWindow } = __req('electron'); const all = webContents.getAllWebContents(); const find = (id) => all.find((w) => !w.isDestroyed() && new RegExp('[?&]id=' + id + '&').test(w.getURL())); const win = (BaseWindow.getAllWindows())[0]; const viewOf = (wc) => win.contentView.children.find((v) => v.webContents === wc); const frame = (wc, ms) => new Promise((res) => { const t0 = Date.now(); let done = false; const fin = (v) => { if (done) return; done = true; try { wc.endFrameSubscription(); } catch {} res(v); }; wc.beginFrameSubscription(true, (img) => fin({ frameMs: Date.now() - t0, size: img.getSize() })); setTimeout(() => fin('NO FRAME'), ms); });`;
    const id = ctx.ids[ctx.W1.id][2];
    const out = {};
    const px = `const centre = (img) => { const b = img.toBitmap(); const sz = img.getSize(); const o = ((sz.height >> 1) * sz.width + (sz.width >> 1)) * 4; return [b[o + 2], b[o + 1], b[o]]; };`;
    const inp = `const input = async (wc) => { const m0 = await wc.executeJavaScript('__hd.mouse()'); const t0 = Date.now(); wc.sendInputEvent({ type: 'mouseDown', x: 320, y: 218, button: 'left', clickCount: 1 }); wc.sendInputEvent({ type: 'mouseUp', x: 320, y: 218, button: 'left', clickCount: 1 }); await wc.insertText('hello'); for (let i = 0; i < 40; i++) { const [m, v] = await wc.executeJavaScript('[__hd.mouse(), __hd.value()]'); if (m > m0 && v === 'hello') return { landedMs: Date.now() - t0 }; await new Promise((r) => setTimeout(r, 20)); } return 'NOT LANDED'; };`;
    const T = (n) => ctx.ids[ctx.W1.id][n];
    // ORDERINGS of flip / capturePage that avoid pinning the page unthrottled (Electron's setBackgroundThrottling(false) disables WasHidden(): a capture's temporary show is never undone while it is set).
    // Each runs on a DEAD tab whose colour changed while hidden: fresh? (rgb == want) · alive after? (input) · throttle timeline after (10 × 0.5 s).
    const tl = `const tl = []; let prev = await ticks(), tp = Date.now(); for (let i = 0; i < 10; i++) { await new Promise((r) => setTimeout(r, 500)); const c = await ticks(), t = Date.now(); tl.push(Math.round((c - prev) / ((t - tp) / 1000))); prev = c; tp = t; }`;
    const order = (n, color, body) => ex(`${pre} ${px} ${inp} const wc = find(${ctx.ids[ctx.W1.id][n]}); const v = viewOf(wc); const ticks = () => wc.executeJavaScript('__hd.ticks()'); const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      await wc.executeJavaScript("__hd.set('#${color}')"); await sleep(1500);
      let rgb, t0 = Date.now(); const cap = async () => { const img = await Promise.race([wc.capturePage(), new Promise((r) => setTimeout(() => r(null), 2000))]); rgb = img && !img.isEmpty() ? centre(img) : 'EMPTY/TIMEOUT'; };
      ${body}
      const capMs = Date.now() - t0; const inputR = await input(wc); wc.setBackgroundThrottling(true); ${tl} return { want: '${color}', rgb, capMs, input: inputR, timeline: tl.join(',') };`);
    out.V1_capture_without_any_flip = await order(0, '2ca02c', `await cap();`);
    out.V2_flip_settle_flipback_capture = await order(1, '9467bd', `wc.setBackgroundThrottling(false); await sleep(150); wc.setBackgroundThrottling(true); await cap();`);
    out.V3_flip_capture_flipback_realpulse = await order(2, 'ff7f0e', `wc.setBackgroundThrottling(false); await cap(); wc.setBackgroundThrottling(true); v.setVisible(true); await sleep(200); v.setVisible(false);`);
    out.V4_capture_twice_no_flip = await order(3, 'e377c2', `await cap(); await sleep(100); await cap();`);
    for (const [k, v] of Object.entries(out)) console.log(`  [diag] ${k}: ${JSON.stringify(v)}`);
    main.close();
    clause(A, 'diag-ran', true, 'see [diag] lines');
  },
  /** P1, P2, P3, P4, P8 latency: ≥ 20 runs per target kind at N≈8 hidden views, then again at N≈40 */
  async act(ctx) {
    const A = 'act';
    const ep = {}; for (const W of ctx.world.workspaces) ep[W.id] = await hostCall(ctx, '/browser', { id: W.id, key: W.key });
    ctx.ep = ep;
    // phase 1 — N = 8 hidden loaded views: W1 holds its red tab + 7 hidden ones, W2 one hidden tab
    ctx.ids = await populate(ctx, [ctx.W1], 100); const w2 = await populate(ctx, [ctx.world.workspaces[1]], 200); Object.assign(ctx.ids, w2);
    ctx.ids[ctx.world.workspaces[1].id] = ctx.ids[ctx.world.workspaces[1].id].slice(0, 1);
    const hid8 = (await reg(ctx, ctx.W1)).tabs.length - 1 + 1;
    clause(A, 'ctl/population-N8', hid8 >= 8 - 1, `W1: 7 hidden tabs + the red one; W2: 1 hidden tab → ${7 + 1} hidden loaded views besides the visible one`);
    const runs8 = [];
    for (let i = 0; i < RUNS8; i++) {
      const kind = i % 2 ? 'workspace' : 'tab';
      const W = kind === 'tab' ? ctx.W1 : ctx.world.workspaces[1];
      const pool = kind === 'tab' ? ctx.ids[ctx.W1.id].slice(0, 7) : ctx.ids[W.id];
      runs8.push(await guarded(ctx, oneRun(ctx, kind, W, pool[Math.floor(i / 2) % pool.length], i, ep[W.id])));
    }
    judgeRuns(A, 'N8', runs8);
    // phase 2 — N ≈ 40: the other workspaces filled to 8 tabs each
    const rest = ctx.world.workspaces.slice(2, 5);
    Object.assign(ctx.ids, await populate(ctx, rest, 300));
    const wsTabs = (await Promise.all(ctx.world.workspaces.slice(0, 5).map((W) => reg(ctx, W)))).map((r) => r.tabs.length);
    clause(A, 'ctl/population-N40', wsTabs.reduce((s, n) => s + n, 0) >= 36, `tabs per workspace ${wsTabs.join('+')} = ${wsTabs.reduce((s, n) => s + n, 0)} loaded views (one composited)`);
    const runs40 = [];
    for (let i = 0; i < RUNS40; i++) {
      const kind = i % 2 ? 'tab' : 'workspace'; // the other parity first: order alternates between the two phases too
      const W = kind === 'tab' ? ctx.W1 : rest[Math.floor(i / 2) % rest.length];
      const pool = kind === 'tab' ? ctx.ids[ctx.W1.id].slice(0, 7) : ctx.ids[W.id];
      runs40.push(await guarded(ctx, oneRun(ctx, kind, W, pool[Math.floor(i / 2) % pool.length], i + 1, ep[W.id])));
    }
    judgeRuns(A, 'N40', runs40.map((r) => ({ ...r, shots: r.shots })));
    // P5: no renderer / GPU crash in any run, hidden views counted
    const log = fs.readFileSync(path.join(ctx.armDir, 'app-boot1.log'), 'utf8');
    const crashes = (log.match(/render-process-gone|child-process-gone|GPU process exited unexpectedly|Lost UI shared context/g) ?? []).length;
    clause(A, 'P5-no-renderer-or-gpu-crash', crashes === 0, `${crashes} crash / context-lost lines in the app log over ${runs8.length + runs40.length} runs`);
    for (const l of log.split('\n').filter((x) => /browser-panel: drive/.test(x)).slice(0, 14)) console.log(`  [app-log] ${l.slice(l.indexOf('browser-panel')).slice(0, 170)}`);
    try { fs.copyFileSync(path.join(ctx.armDir, 'app-boot1.log'), path.join(OUT, 'act-app-boot1.log')); } catch { /* the log is evidence for a miss, not a clause */ }
    { const slow = [...runs8, ...runs40].filter((r) => r.landed === null || r.landed > 700); if (slow.length) console.log(`  [evidence] ${slow.length} P2 miss(es): app log kept at ${path.join(OUT, 'act-app-boot1.log')}; wall-clock ${slow.map((r) => new Date(r.t).toISOString()).join(' ')}`); }
    ctx.actRuns = { runs8, runs40 };
  },

  /** P1 hunt (NOT a pass criterion): ONLY the first screenshot after a colour change on a throttled hidden tab, optionally under CPU load (--load K busy workers at nice 5) — a stale-frame reproducer and an A/B for a fix */
  async stale(ctx) {
    const A = 'stale';
    const ep = {}; for (const W of ctx.world.workspaces) ep[W.id] = await hostCall(ctx, '/browser', { id: W.id, key: W.key });
    ctx.ep = ep;
    ctx.ids = await populate(ctx, [ctx.W1], 100); const w2 = await populate(ctx, [ctx.world.workspaces[1]], 200); Object.assign(ctx.ids, w2);
    ctx.ids[ctx.world.workspaces[1].id] = ctx.ids[ctx.world.workspaces[1].id].slice(0, 1);
    const kids = []; for (let i = 0; i < LOAD_K; i++) kids.push(spawn('/usr/bin/nice', ['-n', '5', process.execPath, '-e', 'for(;;){}'], { stdio: 'ignore' }));
    const stopLoad = () => { for (const k of kids) { try { k.kill('SIGKILL'); } catch { /* gone */ } } };
    process.on('exit', stopLoad);
    const load0 = fs.readFileSync('/proc/loadavg', 'utf8').split(' ').slice(0, 3).join(' ');
    const runs = [];
    try {
      for (let i = 0; i < RUNS_STALE; i++) {
        const kind = KINDS_ONLY ?? (i % 2 ? 'workspace' : 'tab');
        const W = kind === 'tab' ? ctx.W1 : ctx.world.workspaces[1];
        const pool = kind === 'tab' ? ctx.ids[ctx.W1.id].slice(0, 7) : ctx.ids[W.id];
        runs.push(await guarded(ctx, oneRun(ctx, kind, W, pool[Math.floor(i / (KINDS_ONLY ? 1 : 2)) % pool.length], i, ep[W.id], true)));
        await sleep(STALE_GAP);
      }
    } finally { stopLoad(); }
    const load1 = fs.readFileSync('/proc/loadavg', 'utf8').split(' ').slice(0, 3).join(' ');
    await sleep(300);
    const alive = kids.filter((k) => { try { process.kill(k.pid, 0); return true; } catch { return false; } }).length;
    clause('ctl', 'load-workers-gone', alive === 0, `${kids.length} busy workers started, ${alive} still alive after the stop`);
    const shots = runs.flatMap((r) => r.shots.map((s) => ({ ...s, run: r.runNo, kind: r.kind, id: r.id })));
    const bad = shots.filter((s) => !s.fresh);
    const by = (k) => shots.filter((s) => s.kind === k);
    clause(A, 'first-shot-fresh', bad.length === 0, `${shots.length} first shots under load K=${LOAD_K} (loadavg ${load0} → ${load1}): ${bad.length} stale/failed (tab ${by('tab').filter((s) => !s.fresh).length}/${by('tab').length}, workspace ${by('workspace').filter((s) => !s.fresh).length}/${by('workspace').length}) ${bad.slice(0, 8).map((s) => `${s.name}:${s.error ?? JSON.stringify(s.color)}@run#${s.run}/${s.kind}/id${s.id}/${s.ms}ms/${s.at}`).join(' ')}; shot ms median ${median(shots.map((s) => s.ms))} p95 ${pct(shots.map((s) => s.ms), 0.95)} max ${Math.max(...shots.map((s) => s.ms))}`);
    try { fs.copyFileSync(path.join(ctx.armDir, 'app-boot1.log'), path.join(OUT, 'stale-app-boot1.log')); fs.copyFileSync(path.join(ctx.world.ohome, 'logs', 'orchestra.log'), path.join(OUT, 'stale-orchestra.log')); } catch { /* evidence only */ }
  },

  /** P3 (CPU): a 40-view population after a burst of agent actions costs no more than a never-acted control (≤ 10 % of a core) */
  async cpu(ctx) {
    const A = 'cpu';
    if (!ctx.ids) throw new Error('the cpu arm needs the act arm\'s population');
    const pool = ctx.world.workspaces.slice(0, 5).flatMap((W) => (W === ctx.W1 ? ctx.ids[W.id].slice(0, 7) : ctx.ids[W.id]));
    const acts = async (n) => { for (let i = 0; i < n; i++) { const id = pool[(i * 3) % pool.length]; const W = ctx.world.workspaces.find((w) => ctx.ids[w.id]?.includes(id)); const raw = await rawProxyClient(ctx.ep[W.id].wsUrl); const tid = (await raw.call('Target.getTargets')).result.targetInfos.find((x) => idOf(x.url) === id).targetId; const sid = (await raw.call('Target.attachToTarget', { targetId: tid, flatten: true })).result.sessionId; await raw.callOn(sid, 'Page.captureScreenshot', { format: 'png' }); await raw.callOn(sid, 'Input.insertText', { text: 'x' }); raw.close(); } };
    const reps = [];
    for (const order of ['control-first', 'actions-first']) {
      let control, after;
      if (order === 'control-first') { control = await cpuWindow(ctx, 60000); await acts(10); await sleep(3000); after = await cpuWindow(ctx, 60000); }
      else { await acts(10); await sleep(3000); after = await cpuWindow(ctx, 60000); control = await cpuWindow(ctx, 60000); }
      reps.push({ order, control, after, delta: +(after - control).toFixed(2) });
    }
    clause(A, 'P3-cpu-after-actions-vs-never-acted', reps.every((r) => r.delta <= 10), `Δ CPU of the 40-view tree, 60 s window after 10 actions − a never-acted window: ${reps.map((r) => `${r.order} ${r.control}% → ${r.after}% (Δ ${r.delta})`).join('; ')} (limit 10 % of a core)`);
    // P8 (report): K views flipped at once for 10 s
    const rows = [];
    for (const K of [1, 4, 16]) {
      const picks = pool.slice(0, K); const raws = [];
      const base = await cpuWindow(ctx, 10000);
      for (const id of picks) { const W = ctx.world.workspaces.find((w) => ctx.ids[w.id]?.includes(id)); const raw = await rawProxyClient(ctx.ep[W.id].wsUrl); const tid = (await raw.call('Target.getTargets')).result.targetInfos.find((x) => idOf(x.url) === id).targetId; const sid = (await raw.call('Target.attachToTarget', { targetId: tid, flatten: true })).result.sessionId; void raw.callOn(sid, 'Runtime.evaluate', { expression: 'new Promise((r) => setTimeout(r, 10000))', awaitPromise: true }); raws.push(raw); }
      await sleep(600); const held = await cpuWindow(ctx, 10000);
      for (const raw of raws) raw.close(); await sleep(3000);
      rows.push({ K, base, held, delta: +(held - base).toFixed(2) });
    }
    console.log(`  [P8] ΔCPU with K views flipped at once for 10 s at N=40 (vs a 10 s window before): ${rows.map((r) => `K=${r.K}: ${r.base}% → ${r.held}% (Δ ${r.delta})`).join(' · ')}  [A1's measured cost: ≈ +0.25 % of a core per busy view]`);
    ctx.p8 = rows;
  },

  /** P6: a tab that never loaded while attached (created through the proxy in a workspace nobody opened) answers when something covers its first frame, and is refused FAST and clearly when nothing does */
  async never(ctx) {
    const A = 'never', W6 = ctx.world.workspaces[5];
    await selectWs(ctx, ctx.W1); await openPane(ctx); // standalone (`--arm never`) the pane starts closed: the refusal half toggles it
    const ep = ctx.ep ?? (ctx.ep = {}); ep[W6.id] = ep[W6.id] ?? await hostCall(ctx, '/browser', { id: W6.id, key: W6.key });
    const results = [];
    for (let i = 0; i < RUNS_NEVER; i++) {
      const raw = await rawProxyClient(ep[W6.id].wsUrl);
      const want = PALETTE[i % PALETTE.length], wantHex = want.map((v) => v.toString(16).padStart(2, '0')).join(''); const id = 900 + i;
      const created = await raw.call('Target.createTarget', { url: hdUrl(ctx, id, wantHex) });
      if (!created.result?.targetId) { results.push({ ok: false, why: `createTarget: ${created.error?.message}` }); raw.close(); continue; }
      await targetOf(ctx, id); await sleep(1200); // loaded DETACHED: it never was on screen
      const sid = (await raw.call('Target.attachToTarget', { targetId: created.result.targetId, flatten: true })).result.sessionId;
      const before = await humanState(ctx); const t0 = Date.now();
      const shot = await raw.callOn(sid, 'Page.captureScreenshot', { format: 'png' }); const ms = Date.now() - t0;
      let fresh = false; if (shot.result?.data) { const I = decodePng(Buffer.from(shot.result.data, 'base64')); fresh = near(blockColor(I, I.w >> 1, I.h >> 1, 8), want, 14); }
      const o = await Cdp.connect((await targetOf(ctx, id)).webSocketDebuggerUrl); const m0 = await o.eval('__hd.mouse()');
      const tIn = Date.now(); await raw.callOn(sid, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: 320, y: 218, button: 'left', clickCount: 1 }); await raw.callOn(sid, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: 320, y: 218, button: 'left', clickCount: 1 }); await raw.callOn(sid, 'Input.insertText', { text: 'hello' });
      let landed = null; for (let k = 0; k < 40 && landed === null; k++) { const [m, v] = await o.eval('[__hd.mouse(), __hd.value()]'); if (m > m0 && v === 'hello') landed = Date.now() - tIn; else await sleep(20); }
      const after = await humanState(ctx); o.close();
      await raw.call('Target.closeTarget', { targetId: created.result.targetId }); raw.close();
      results.push({ ok: fresh && ms <= 2000 && landed !== null && landed <= 700 && before.active === after.active && before.focus === after.focus, fresh, ms, landed, human: before.active === after.active && before.focus === after.focus });
    }
    clause(A, 'P6-never-composited-tab-answers-under-the-cover', results.every((r) => r.ok), `${results.filter((r) => r.ok).length}/${results.length} runs: first screenshot fresh ≤ 2 s (median ${median(results.map((r) => r.ms))} ms), click+type landed ≤ 700 ms (median ${median(results.map((r) => r.landed))} ms), the human's tab and focus unchanged`);
    // nothing on screen to cover a first frame: the pane is closed → a fast, clear refusal
    const refused = [];
    for (let i = 0; i < 5; i++) {
      await clickSel(ctx, 'button[aria-label="Hide browser pane"]'); await sleep(900);
      const raw = await rawProxyClient(ep[W6.id].wsUrl); const created = await raw.call('Target.createTarget', { url: hdUrl(ctx, 950 + i) }); await targetOf(ctx, 950 + i); await sleep(800);
      const sid = (await raw.call('Target.attachToTarget', { targetId: created.result.targetId, flatten: true })).result.sessionId; const t0 = Date.now();
      const shot = await raw.callOn(sid, 'Page.captureScreenshot', { format: 'png' }); refused.push({ ms: Date.now() - t0, msg: shot.error?.message ?? '' });
      await raw.call('Target.closeTarget', { targetId: created.result.targetId }); raw.close();
      await clickSel(ctx, 'button[aria-label="Show browser pane"]'); await sleep(900);
    }
    clause(A, 'P6-no-cover-refused-fast-and-clearly', refused.every((r) => r.ms <= 500 && /has not been on screen since its page loaded/.test(r.msg)), `${refused.filter((r) => r.ms <= 500 && /has not been on screen/.test(r.msg)).length}/5 refused ≤ 500 ms (max ${Math.max(...refused.map((r) => r.ms))} ms): ${JSON.stringify(refused[0]?.msg.slice(0, 80))}`);
    await openPane(ctx);
  },

  /** The Orchestra window on a sway workspace that is NOT displayed (the human is on another desktop): does the main renderer's rAF stall (the cheap "nothing paints" signal), and what does an agent action do? Needs the act arm's population. */
  async offscreen(ctx) {
    const A = 'offscreen';
    if (!ctx.ids) throw new Error('the offscreen arm needs the act arm\'s population');
    const rafProbe = () => ctx.ui.eval(`new Promise((res) => { const t0 = performance.now(); const to = setTimeout(() => res({ ok: false, ms: Math.round(performance.now() - t0) }), 600); requestAnimationFrame(() => { clearTimeout(to); res({ ok: true, ms: Math.round(performance.now() - t0) }); }); })`);
    const focusedWs = () => (JSON.parse(sh('swaymsg', ['-t', 'get_workspaces'])).find((w) => w.focused) ?? {}).name;
    const home = focusedWs();
    const series = async (n) => { const out = []; for (let i = 0; i < n; i++) { out.push(await rafProbe()); await sleep(120); } return out; };
    const show = (a) => a.map((x) => (x.ok ? `ok ${x.ms}ms` : 'STALL')).join(', ');
    const d1 = await series(6);
    clause(A, 'ctl/displayed-window-paints-rAF-answers', d1.every((x) => x.ok && x.ms < 150), `${show(d1)} (workspace ${JSON.stringify(home)})`);
    sh('swaymsg', ['workspace', 'number', '2']); const tSwitch = Date.now();
    const early = await series(8); // the stall takes ≈ 1-1.5 s to show: print when it does
    const firstStall = early.findIndex((x) => !x.ok);
    await sleep(Math.max(0, tSwitch + 2500 - Date.now()));
    const off = await series(6);
    clause(A, 'undisplayed-window-rAF-stalls', off.every((x) => !x.ok), `workspace ${JSON.stringify(focusedWs())} displayed, the app's is not — the first ${early.length} probes after the switch (≈ ${Math.round(early.reduce((t, x) => t + x.ms + 120, 0))} ms) ${firstStall >= 0 ? `stall from #${firstStall + 1}` : 'all still answered (the stall needs ≈ 1-2 s to show)'}; 2.5 s on: ${show(off)}`);
    sh('swaymsg', ['workspace', home]); await sleep(700);
    const d2 = await series(6);
    clause(A, 'ctl/displayed-again-rAF-answers', d2.every((x) => x.ok && x.ms < 150), show(d2));
    // ── what an agent action does while the window is on an undisplayed desktop (P3/P7 + the refusal the ruling keeps) ──
    const W = ctx.W1, id = ctx.ids[W.id][3];
    const raw = await rawProxyClient(ctx.ep[W.id].wsUrl);
    const tid = await waitFor(async () => (await raw.call('Target.getTargets')).result?.targetInfos?.find((x) => idOf(x.url) === id)?.targetId ?? null, 8000, `proxy target for id ${id}`);
    const sid = (await raw.call('Target.attachToTarget', { targetId: tid, flatten: true })).result.sessionId;
    const timed = async (method, params) => { const t0 = Date.now(); const r = await Promise.race([raw.callOn(sid, method, params), sleep(6000).then(() => ({ error: { message: 'NO ANSWER in 6 s' } }))]); return { ms: Date.now() - t0, err: r.error?.message ?? null }; };
    const wheel = { type: 'mouseWheel', x: 320, y: 218, deltaX: 0, deltaY: 100 };
    const okC = [await timed('Input.dispatchMouseEvent', wheel), await timed('Page.captureScreenshot', { format: 'png' })];
    clause(A, 'ctl/displayed-window-wheel-and-screenshot-work', okC.every((r) => !r.err && r.ms < 3000), `wheel ${okC[0].ms} ms ${okC[0].err ?? 'ok'} · screenshot ${okC[1].ms} ms ${okC[1].err ?? 'ok'}`);
    await sleep(1500); // the displayed series' lease lingers out
    sh('swaymsg', ['workspace', 'number', '2']); await sleep(2500); // past the ≈ 1 s the stall needs to show
    const offR = [await timed('Input.dispatchMouseEvent', wheel), await timed('Input.dispatchMouseEvent', { type: 'mousePressed', x: 320, y: 218, button: 'left', clickCount: 1 }), await timed('Page.captureScreenshot', { format: 'png' })];
    clause(A, 'undisplayed-window-wheel-click-screenshot-refused-fast-with-the-reason', offR.every((r) => r.err && /not displayed/.test(r.err) && r.ms <= 800), `wheel ${offR[0].ms} ms · click ${offR[1].ms} ms · screenshot ${offR[2].ms} ms: ${offR.map((r) => JSON.stringify((r.err ?? 'no error').slice(0, 60))).join(' · ')}`);
    const ev = await timed('Runtime.evaluate', { expression: '1 + 1', returnByValue: true });
    clause(A, 'undisplayed-window-evaluate-still-works', !ev.err, `Runtime.evaluate → ${ev.err ?? 'ok'} in ${ev.ms} ms`);
    raw.close();
    const o = await Cdp.connect((await targetOf(ctx, id)).webSocketDebuggerUrl);
    await sleep(8000); // P3/P7: the page must be throttled again although the client acted on an undisplayed window
    const a = await o.eval('__hd.ticks()'), ta = Date.now(); await sleep(1000); const rate = +(((await o.eval('__hd.ticks()')) - a) / ((Date.now() - ta) / 1000)).toFixed(1); o.close();
    clause(A, 'undisplayed-window-no-view-left-unthrottled-8s-after-the-client-left', rate <= 2, `timers/s of the driven hidden page 8 s after the client closed: ${rate} (limit 2)`);
    sh('swaymsg', ['workspace', home]); await sleep(1200);
    const back = await rawProxyClient(ctx.ep[W.id].wsUrl);
    const tid3 = (await back.call('Target.getTargets')).result.targetInfos.find((x) => idOf(x.url) === id).targetId;
    const sid3 = (await back.call('Target.attachToTarget', { targetId: tid3, flatten: true })).result.sessionId;
    const again = await back.callOn(sid3, 'Page.captureScreenshot', { format: 'png' });
    clause(A, 'ctl/displayed-again-screenshot-works', !!again.result?.data, `screenshot after returning to workspace ${JSON.stringify(home)}: ${again.result?.data ? 'an image' : again.error?.message}`);
    back.close();
  },

  /** F2: the cover (the human's visible tab) leaves the screen while a never-composited tab is being painted under it: the pulse must not show in the vacated pane. */
  async cover(ctx) {
    const A = 'cover', W6 = ctx.world.workspaces[5];
    const ep = ctx.ep ?? (ctx.ep = {}); ep[W6.id] = ep[W6.id] ?? await hostCall(ctx, '/browser', { id: W6.id, key: W6.key });
    // control: the colour oracle really sees a page when one IS in the pane (W6's own visible tab)
    const ctlHex = PALETTE[2].map((v) => v.toString(16).padStart(2, '0')).join('');
    await selectWs(ctx, W6); await openPane(ctx);
    await ctx.ui.eval(`window.orchestra.browserNavigate(${sel(W6.id)}, ${sel(hdUrl(ctx, 890, ctlHex))}).then(() => true)`);
    await targetOf(ctx, 890); await sleep(1200);
    const rect = await rectOf(ctx, '.browser-panel:not(.browser-panel-hidden) .browser-holder');
    const sc = startColorSampler(ctx, rect, PALETTE[2]); await sleep(400); const cs = await sc.stop(Date.now() + 10_000);
    clause(A, 'ctl/the-colour-oracle-sees-a-page-in-the-pane', cs.before >= 0.5, `a page of colour ${ctlHex} on screen: ${(cs.before * 100).toFixed(0)} % of the pane rect (${cs.samples} grim samples)`);
    const runs = [];
    for (let i = 0; i < 6; i++) {
      const d = [60, 100, 140][i % 3];
      await selectWs(ctx, ctx.W1); await openPane(ctx); await ctx.ui.eval(`window.orchestra.browserShow(${sel(ctx.W1.id)}).then(() => true)`); await sleep(700);
      const r0 = await rectOf(ctx, '.browser-panel:not(.browser-panel-hidden) .browser-holder');
      const want = PALETTE[(i + 7) % PALETTE.length], hex = want.map((v) => v.toString(16).padStart(2, '0')).join(''), id = 800 + i;
      const raw = await rawProxyClient(ep[W6.id].wsUrl);
      const created = await raw.call('Target.createTarget', { url: hdUrl(ctx, id, hex) });
      await targetOf(ctx, id); await sleep(1200); // loaded DETACHED: never composited
      const sid = (await raw.call('Target.attachToTarget', { targetId: created.result.targetId, flatten: true })).result.sessionId;
      const sampler = startColorSampler(ctx, r0, want);
      const shot = raw.callOn(sid, 'Page.captureScreenshot', { format: 'png' });
      await sleep(d);
      await ctx.ui.eval(`window.orchestra.browserHide(${sel(ctx.W1.id)}).then(() => true)`); // the human closes the pane: the cover leaves
      const tHide = Date.now();
      const res = await Promise.race([shot, sleep(8000).then(() => ({ error: { message: 'NO ANSWER' } }))]);
      await sleep(700);
      const sm = await sampler.stop(tHide);
      await raw.call('Target.closeTarget', { targetId: created.result.targetId }); raw.close();
      runs.push({ d, before: sm.before, flash: sm.after, err: res.error?.message ?? null });
    }
    clause(A, 'P4-no-flash-when-the-cover-vanishes-mid-pulse', runs.every((r) => r.flash <= 0.02), `the pulse page's colour in the vacated pane after the pane closed 60/100/140 ms into the pulse: ${runs.map((r) => `${r.d}ms→${(r.flash * 100).toFixed(1)} %`).join(', ')} (limit 2 %; under the cover before: ${runs.map((r) => (r.before * 100).toFixed(1)).join(', ')} %)`);
    clause(A, 'the-cancelled-action-says-why', runs.every((r) => r.err && /Browser pane was closed/.test(r.err)), `errors: ${runs.map((r) => JSON.stringify((r.err ?? 'none').slice(0, 50))).join(' · ')}`);
    await ctx.ui.eval(`window.orchestra.browserShow(${sel(ctx.W1.id)}).then(() => true)`); await selectWs(ctx, ctx.W1); await openPane(ctx);
  },

  /** A navigation under a lease (an agent clicks through / `Page.navigate`s a tab nobody looks at): the screenshot right after it is fresh, the page is throttled again afterwards (the lease dies with the view's place in the window), and a hidden FULL-PAGE capture is refused honestly. Needs the act arm's population. */
  async navigate(ctx) {
    const A = 'navigate';
    if (!ctx.ids) throw new Error('the navigate arm needs the act arm\'s population');
    const runs = [];
    for (let i = 0; i < RUNS_NAV; i++) {
      const kind = i % 2 ? 'workspace' : 'tab';
      const W = kind === 'tab' ? ctx.W1 : ctx.world.workspaces[1];
      const pool = kind === 'tab' ? ctx.ids[ctx.W1.id].slice(0, 7) : ctx.ids[W.id];
      const id = pool[Math.floor(i / 2) % pool.length];
      const mode = ['shot', 'bare', 'slow', 'bare'][Math.floor(i / 2) % 4]; // bare = navigate ONLY (a screenshot afterwards takes a second lease whose flip-back would hide a forgotten first one); slow = the new page's load is held 1.2 s
      const bare = mode === 'bare';
      const want = PALETTE[(i + 3) % PALETTE.length], hex = want.map((v) => v.toString(16).padStart(2, '0')).join('');
      const raw = await rawProxyClient(ctx.ep[W.id].wsUrl);
      const tid = await waitFor(async () => (await raw.call('Target.getTargets')).result?.targetInfos?.find((x) => idOf(x.url) === id)?.targetId ?? null, 8000, `proxy target for id ${id}`);
      const sid = (await raw.call('Target.attachToTarget', { targetId: tid, flatten: true })).result.sessionId;
      const t0 = Date.now();
      const nav = await raw.callOn(sid, 'Page.navigate', { url: hdUrl(ctx, id, hex) + (mode === 'slow' ? '&slow=1200' : '') });
      if (NAV_GAP) await sleep(NAV_GAP); // diagnostic: let the new document finish loading before the screenshot
      const shot = bare ? { result: null, error: null } : await raw.callOn(sid, 'Page.captureScreenshot', { format: 'png' }); const ms = Date.now() - t0;
      let fresh = false, color = null;
      if (shot.result?.data) { try { const I = decodePng(Buffer.from(shot.result.data, 'base64')); color = blockColor(I, I.w >> 1, I.h >> 1, 8); fresh = near(color, want, 14); } catch { /* not a png */ } }
      let big = null;
      if (i === 1) big = await raw.callOn(sid, 'Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: 0, y: 0, width: 800, height: 9000, scale: 1 } });
      const tEnd = Date.now(); raw.close();
      await sleep(Math.max(0, tEnd + 3200 - Date.now())); // linger + the sweep + the unpin capture, then measure
      const o = await Cdp.connect((await targetOf(ctx, id)).webSocketDebuggerUrl);
      const a = await o.eval('__hd.ticks()'), ta = Date.now(); await sleep(1000); const rate = +(((await o.eval('__hd.ticks()')) - a) / ((Date.now() - ta) / 1000)).toFixed(1); o.close();
      runs.push({ kind, id, bare, mode, fresh, color, want: hex, ms, rate, navErr: nav.error?.message ?? null, shotErr: shot.error?.message ?? null, big });
    }
    const shots = runs.filter((r) => r.mode === 'shot'), slows = runs.filter((r) => r.mode === 'slow'), bares = runs.filter((r) => r.bare);
    const detail = (rs) => `${rs.filter((r) => r.fresh).length}/${rs.length} fresh (slowest ${Math.max(...rs.map((r) => r.ms))} ms, median ${median(rs.map((r) => r.ms))} ms)${rs.filter((r) => !r.fresh).slice(0, 3).map((r) => ` · ${r.kind} id${r.id} got ${JSON.stringify(r.color)} want ${r.want} ${r.shotErr ?? r.navErr ?? ''}`).join('')}`;
    clause(A, 'P1n-screenshot-right-after-a-navigation-is-fresh', shots.length >= 5 && shots.every((r) => r.fresh && r.ms <= 4000), `Page.navigate then Page.captureScreenshot on a hidden tab shows the NEW page: ${detail(shots)}`);
    clause(A, 'P1n-screenshot-of-a-page-still-loading-is-fresh', slows.length >= 5 && slows.every((r) => r.fresh && r.ms <= 4000), `the new page's load is held 1.2 s (an image that loads late): ${detail(slows)}`);
    clause(A, 'P7n-throttled-again-after-a-BARE-navigation-under-a-lease', bares.length >= 10 && bares.every((r) => r.rate <= 2), `${bares.length} runs of \`Page.navigate\` and nothing else (no second lease to hide a forgotten first one): timers/s of the new document 3.2 s later: ${bares.map((r) => r.rate).join(', ')} (limit 2)`);
    clause(A, 'P7n-throttled-again-after-navigate-and-screenshot', shots.length + slows.length >= 10 && [...shots, ...slows].every((r) => r.rate <= 2), `timers/s 3.2 s after the screenshot: ${[...shots, ...slows].map((r) => r.rate).join(', ')} (limit 2)`);
    // F3: a load LONGER than the old 1.5 s bound answers; a load that NEVER finishes is refused with the true cause
    const longRuns = [], hangRuns = [];
    for (let i = 0; i < 6; i++) {
      const hang = i >= 3; const W = ctx.W1, id = ctx.ids[W.id][i % 7];
      const want = PALETTE[(i + 1) % PALETTE.length], hex = want.map((v) => v.toString(16).padStart(2, '0')).join('');
      const raw = await rawProxyClient(ctx.ep[W.id].wsUrl);
      const tid = await waitFor(async () => (await raw.call('Target.getTargets')).result?.targetInfos?.find((x) => idOf(x.url) === id)?.targetId ?? null, 8000, `proxy target for id ${id}`);
      const sid = (await raw.call('Target.attachToTarget', { targetId: tid, flatten: true })).result.sessionId;
      const t0 = Date.now();
      await raw.callOn(sid, 'Page.navigate', { url: `${hdUrl(ctx, id, hex)}&slow=${hang ? 'hang' : 4000}` });
      const shot = await raw.callOn(sid, 'Page.captureScreenshot', { format: 'png' }, 15000); const ms = Date.now() - t0;
      let fresh = false;
      if (shot.result?.data) { try { const I = decodePng(Buffer.from(shot.result.data, 'base64')); fresh = near(blockColor(I, I.w >> 1, I.h >> 1, 8), want, 14); } catch { /* not a png */ } }
      raw.close();
      (hang ? hangRuns : longRuns).push({ id, ms, fresh, err: shot.error?.message ?? null });
      if (hang) { const o = await Cdp.connect((await targetOf(ctx, id)).webSocketDebuggerUrl); await o.send('Page.navigate', { url: hdUrl(ctx, id, hex) }); o.close(); await sleep(1500); }
    }
    clause(A, 'P1n-a-4s-load-is-waited-for-and-the-screenshot-answers', longRuns.length >= 3 && longRuns.every((r) => r.fresh && r.ms <= 9000), `${longRuns.filter((r) => r.fresh).length}/${longRuns.length} fresh after a 4 s page load (slowest ${Math.max(...longRuns.map((r) => r.ms))} ms)${longRuns.filter((r) => !r.fresh).slice(0, 2).map((r) => ` · id${r.id}: ${(r.err ?? 'stale').slice(0, 90)}`).join('')}`);
    clause(A, 'a-never-finishing-load-is-refused-with-the-true-cause', hangRuns.length >= 3 && hangRuns.every((r) => r.err && /still loading/.test(r.err) && r.ms <= 9000), `${hangRuns.length} runs: ${hangRuns.map((r) => `${r.ms} ms ${JSON.stringify((r.err ?? 'an image').slice(0, 56))}`).join(' · ')}`);
    const big = runs.find((r) => r.big)?.big;
    clause(A, 'full-page-capture-of-a-hidden-tab-refused-honestly', !!big?.error && /not supported/.test(big.error.message) && /tab <ref>/.test(big.error.message), `captureBeyondViewport + a 9000 px clip → ${big?.error ? JSON.stringify(big.error.message.slice(0, 140)) : 'an image (silently cropped to the viewport)'}`);
  },

  /** P7: an action killed mid-flight leaves no view unthrottled longer than linger + 5 s */
  async orphan(ctx) {
    const A = 'orphan';
    if (!ctx.ids) throw new Error('the orphan arm needs the act arm\'s population');
    const rates = [];
    for (let i = 0; i < 10; i++) {
      const id = ctx.ids[ctx.W1.id][i % 7]; const o = await Cdp.connect((await targetOf(ctx, id)).webSocketDebuggerUrl);
      const raw = await rawProxyClient(ctx.ep[ctx.W1.id].wsUrl);
      const tid = (await raw.call('Target.getTargets')).result.targetInfos.find((x) => idOf(x.url) === id).targetId; const sid = (await raw.call('Target.attachToTarget', { targetId: tid, flatten: true })).result.sessionId;
      void raw.callOn(sid, 'Runtime.evaluate', { expression: 'new Promise((r) => setTimeout(r, 15000))', awaitPromise: true }); // a long action …
      await sleep(1500); const live = await (async () => { const a = await o.eval('__hd.ticks()'), t = Date.now(); await sleep(500); return ((await o.eval('__hd.ticks()')) - a) / ((Date.now() - t) / 1000); })();
      const tKill = Date.now(); raw.close(); // … killed mid-flight
      await sleep(Math.max(0, tKill + 5600 - Date.now())); // linger 0.6 s + 5 s
      const a = await o.eval('__hd.ticks()'), ta = Date.now(); await sleep(1000); const rate = ((await o.eval('__hd.ticks()')) - a) / ((Date.now() - ta) / 1000);
      rates.push({ live: +live.toFixed(1), after: +rate.toFixed(1) }); o.close();
    }
    clause(A, 'ctl/the-long-action-really-unthrottled-the-view', rates.every((r) => r.live >= 8), `timers/s while the action ran: ${rates.map((r) => r.live).join(', ')} (≥ 8 = the flip is real)`);
    clause(A, 'P7-flip-back-guaranteed-after-a-killed-action', rates.every((r) => r.after <= 2), `timers/s 5.6 s after the client was killed mid-action: ${rates.map((r) => r.after).join(', ')} (limit 2)`);
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
{ const sh1 = scopeShmem(), grew = (a, b) => (a === null || b === null ? 0 : b - a);
  console.log(`[rig] scope shmem after: leaf ${sh1.leaf} B, parent ${sh1.parent} B (before ${SHMEM0.leaf} / ${SHMEM0.parent}); MemAvailable min ${memMinKb} kB`);
  clause('ctl', 'memavail-floor-held', !memAborted && memMinKb >= 6500000, `MemAvailable min over the run ${memMinKb} kB (abort floor 6500000)`);
  clause('ctl', 'scope-shmem-not-leaked', Math.max(grew(SHMEM0.leaf, sh1.leaf), grew(SHMEM0.parent, sh1.parent)) <= 64 << 20, `scope shmem leaf ${SHMEM0.leaf} → ${sh1.leaf} B, parent ${SHMEM0.parent} → ${sh1.parent} B (limit +64 MiB: a leaked rig process kills the member's scope)`); }
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
  const aborted = armRed.filter((c) => c.clause === 'arm-completed' && want.includes(c.arm)); // an ABORTED arm is not a kill: its clauses after the abort never ran
  const redArms = new Set(armRed.filter((c) => c.clause !== 'arm-completed').map((c) => c.arm));
  const missed = want.filter((a) => !redArms.has(a));
  ({ verdict, rc } = aborted.length ? { verdict: `MUTANT ${MUTANT} INVALID: arm(s) ${aborted.map((c) => c.arm).join(', ')} ABORTED (${aborted.map((c) => c.detail).join('; ').slice(0, 200)}) — fix the arm, a kill by abort proves nothing`, rc: 1 }
    : ctlRed.length === 0 && missed.length === 0
    ? { verdict: `MUTANT ${MUTANT} KILLED: arm(s) ${want.join(', ')} red (${armRed.filter((c) => want.includes(c.arm)).map((c) => c.clause).join(', ')}), every control green; other red arms: ${[...redArms].filter((a) => !want.includes(a)).join(', ') || 'none'}`, rc: 0 }
    : { verdict: `MUTANT ${MUTANT} SURVIVED/INVALID: arms not red: ${missed.join(', ') || 'none'}; controls red: ${ctlRed.map((c) => c.clause).join('; ') || 'none'}`, rc: 1 });
} else {
  ({ verdict, rc } = ctlRed.length === 0 && armRed.length === 0
    ? { verdict: `ALL GREEN: ${results.length} clauses (${results.filter(isCtl).length} controls, ${results.length - results.filter(isCtl).length} arm clauses) over ${ARM_LIST.length} arms`, rc: 0 }
    : { verdict: `RED: ${results.filter((c) => !c.ok).map((c) => `${c.arm}:${c.clause}`).join('; ')}`, rc: 1 });
}
console.log(`\nVERDICT: ${verdict}`);
process.exit(process.exitCode || rc);
