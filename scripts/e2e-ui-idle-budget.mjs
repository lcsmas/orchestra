// UI idle budget gate (#215, wave C8): boots the BUILT app under its OWN headless sway, mounts N idle structured
// agent panes, and over a fixed window COUNTS per-frame work deterministically —
//   (1) requestAnimationFrame callbacks fired (a wrapper installed before the app's first script, so a module-load
//       `const raf = requestAnimationFrame` capture cannot dodge it), attributed to their scheduling site;
//   (2) infinite CSS/Web animations still running at BOTH ends of the window (`document.getAnimations()`).
// Never OS CPU (noisy). The verdict is a pure function (src/shared/ui-idle-budget.ts): PASS 0 · FAIL 1 (a budget
// breached, naming the offender) · REFUSED 4 (a positive control failed — the run proves nothing). 90 = isolation.
//
// Run through scripts/e2e-ui-idle-budget.sh (own sway, `env -i` allowlist, scratch HOME + config dir). Never a live ~/.claude*.
//   node --experimental-strip-types scripts/e2e-ui-idle-budget.mjs <app-dir> [--panes N] [--window-ms N] [--budget file.json|none] [--json out.json] [--require-bus]
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { judge, renderClauses, parseBudget } from '../src/shared/ui-idle-budget.ts';
import { normalizeSdkMessage } from '../src/shared/agent-events.ts';
import { richSessionEvents, backgroundTaskLifecycle, FIXTURE_AT } from './fixtures/index.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.error('[uib]', ...a);

// ── args ─────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const APP_DIR = argv.find((a, i) => !a.startsWith('--') && (i === 0 || !argv[i - 1].startsWith('--')));
if (!APP_DIR) { console.error('usage: e2e-ui-idle-budget.mjs <app-dir> [--panes N] [--window-ms N] [--budget f.json] [--json out.json]'); process.exit(2); }
// argv only: e2e-contained-rig.sh runs us under `env -i`, so no UIB_* variable would arrive.
const PANES = Number(flag('panes', 6));
const WINDOW_MS = Number(flag('window-ms', 10000));
// Default budget = the reviewed file next to this script; `--budget none` = strict zero (no animation allowed at all).
const HERE = path.dirname(fileURLToPath(import.meta.url));
const BUDGET_FILE = flag('budget', path.join(HERE, 'ui-idle-budget.json'));
const JSON_OUT = flag('json', '');
const REQUIRE_BUS = argv.includes('--require-bus');   // the release gate: a run without the fleet bus is not the shipped app
if (!(PANES >= 1 && WINDOW_MS >= 1000)) { console.error('ABORT: --panes >= 1 and --window-ms >= 1000'); process.exit(2); }
const APP = fs.realpathSync(APP_DIR);
// Self-test mutants OF THE RIG (argv only): each must make the verdict REFUSED, never PASS (scripts/verify-ui-idle-budget.sh).
const ST = { blindRaf: argv.includes('--selftest-blind-raf'), noSeed: argv.includes('--selftest-no-seed'), openTurns: argv.includes('--selftest-leave-turns-open'), hideWindow: argv.includes('--selftest-hide-window'), breakBus: argv.includes('--selftest-break-bus'),
  lateInstall: argv.includes('--selftest-late-install'), blindObservers: argv.includes('--selftest-blind-observers'), noRich: argv.includes('--selftest-no-rich') };

// ── isolation (pure: the self-test arms drive these same functions) ──────────
const RIG = {
  wayland: process.env.RIG_WAYLAND ?? '',
  swaysock: process.env.SWAYSOCK ?? '',
  rigDir: process.env.RIG_DIR ?? '',
  home: process.env.HOME ?? '',
};
const REAL_HOME = os.userInfo().homedir;
const rp = (x) => { try { return fs.realpathSync(x); } catch { return path.resolve(x); } };

/** `env` = the object the child receives (or read back from /proc/<pid>/environ). ORDER MATTERS: wayland-1 is refused
 *  BEFORE the equality can be reached (it only equals `mine` if the human's compositor painted our marker). */
function checkChildEnv(env, mine) {
  const got = env.WAYLAND_DISPLAY;
  if (!got) return { ok: false, clause: 'no-wayland-display', detail: 'child env carries no WAYLAND_DISPLAY' };
  if (got === 'wayland-1') return { ok: false, clause: 'refuse-wayland-1', detail: "wayland-1 is the human's compositor" };
  if (!mine) return { ok: false, clause: 'no-rig-display', detail: 'RIG_WAYLAND unset — not launched via e2e-contained-rig.sh' };
  if (got !== mine) return { ok: false, clause: 'not-my-compositor', detail: `${got} != my marker-verified ${mine}` };
  if ('DISPLAY' in env) return { ok: false, clause: 'x11-display-set', detail: `DISPLAY=${env.DISPLAY} would reach an X server` };
  return { ok: true, clause: 'display-isolated', detail: `WAYLAND_DISPLAY=${got}, DISPLAY absent` };
}
/** Every config dir a boot must never touch: `~/.claude` and each `~/.claude-*` sibling of the real home. */
function liveDirs() {
  const out = [path.join(REAL_HOME, '.claude')];
  try { for (const n of fs.readdirSync(REAL_HOME)) if (n.startsWith('.claude-')) out.push(path.join(REAL_HOME, n)); } catch { /* */ }
  return out.filter((d) => { try { return fs.existsSync(d); } catch { return false; } });
}
/** A path handed to the app must live inside THIS rig's dir and never be, contain or sit under a live config dir / the real home. */
function checkHandOff(vars, rigDir, live) {
  const base = rp(rigDir);
  for (const [k, v] of Object.entries(vars)) {
    if (!v) return { ok: false, clause: `handoff:${k}:unset`, detail: `${k} is not set — the app would fall back to a default under the real home` };
    const c = rp(v);
    if (c === rp(REAL_HOME)) return { ok: false, clause: `handoff:${k}:is-real-home`, detail: `${v} IS the invoker's real home` };
    for (const l of live) {
      const lr = rp(l);
      if (c === lr) return { ok: false, clause: `handoff:${k}:is-live-config`, detail: `${v} IS the live config dir ${l}` };
      if (c.startsWith(lr + path.sep) || lr.startsWith(c + path.sep)) return { ok: false, clause: `handoff:${k}:overlaps-live-config`, detail: `${v} overlaps live ${l}` };
    }
    if (c !== base && !c.startsWith(base + path.sep)) return { ok: false, clause: `handoff:${k}:outside-rig-dir`, detail: `${v} is not under this rig's dir ${rigDir}` };
  }
  return { ok: true, clause: 'handoff-scratch', detail: `${Object.keys(vars).length} paths all inside ${rigDir}` };
}
function refuse(g, extra = '') { console.error(`REFUSED before launch [${g.clause}]: ${g.detail}${extra}`); process.exit(90); }

// ── /proc helpers ────────────────────────────────────────────────────────────
const procEnv = (pid) => {
  const out = {};
  for (const kv of fs.readFileSync(`/proc/${pid}/environ`, 'latin1').split('\0')) { const i = kv.indexOf('='); if (i > 0) out[kv.slice(0, i)] = kv.slice(i + 1); }
  return out;
};
function descendants(root) {
  const kids = new Map();
  for (const d of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(d)) continue;
    try {
      const s = fs.readFileSync(`/proc/${d}/stat`, 'latin1');
      const ppid = Number(s.slice(s.lastIndexOf(')') + 2).split(' ')[1]);
      (kids.get(ppid) ?? kids.set(ppid, []).get(ppid)).push(Number(d));
    } catch { /* raced exit */ }
  }
  const out = [], stack = [root];
  while (stack.length) { const p = stack.pop(); for (const k of kids.get(p) ?? []) { out.push(k); stack.push(k); } }
  return out;
}
const alive = (pid) => { try { const s = fs.readFileSync(`/proc/${pid}/stat`, 'latin1'); return s.slice(s.lastIndexOf(')') + 2)[0] !== 'Z'; } catch { return false; } };

// ── CDP over raw WebSocket (Node 22 global) ──────────────────────────────────
class Cdp {
  static async connect(url) {
    const ws = new WebSocket(url);
    // bounded: a wedged compositor/renderer must fail the run, never hang a release
    await new Promise((res, rej) => { const t = setTimeout(() => rej(new Error('cdp connect timeout 15000ms')), 15000); ws.onopen = () => { clearTimeout(t); res(); }; ws.onerror = () => { clearTimeout(t); rej(new Error('cdp ws error')); }; });
    return new Cdp(ws);
  }
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map();
    ws.onmessage = (m) => {
      const msg = JSON.parse(m.data);
      const p = msg.id && this.pending.get(msg.id);
      if (p) { this.pending.delete(msg.id); msg.error ? p.rej(new Error(`${p.method}: ${msg.error.message}`)) : p.res(msg.result); }
    };
  }
  send(method, params = {}, ms = 20000) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      const t = setTimeout(() => { this.pending.delete(id); rej(new Error(`cdp timeout ${ms}ms: ${method}`)); }, ms);
      this.pending.set(id, { method, res: (v) => { clearTimeout(t); res(v); }, rej: (e) => { clearTimeout(t); rej(e); } });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval(expression, ms) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, ms);
    if (r.exceptionDetails) throw new Error(`eval: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    return r.result.value;
  }
  close() { try { this.ws.close(); } catch { /* */ } }
}
async function freePort() {
  return await new Promise((res, rej) => { const s = net.createServer(); s.on('error', rej); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
}

// ── the in-page instrument (installed BEFORE the app's first script) ─────────
const INSTRUMENT = `(() => {
  if (window.__uib) return;
  const BLIND = !!window.__uibBlind;   // rig mutant: timers/observers forward without counting
  const orig = window.requestAnimationFrame.bind(window);
  const rst = window.setTimeout.bind(window);   // un-wrapped: the rig's own guard timers are not the app's
  const G = window.__uib = { epoch: Math.random().toString(36).slice(2) + ':' + performance.timeOrigin,
    readyState: document.readyState, scriptsAtInstall: document.scripts.length,
    sched: 0, fired: 0, sites: Object.create(null), orig,
    tFired: 0, tShortFired: 0, tSites: Object.create(null), roFired: 0, moFired: 0, moRecords: 0, oSites: Object.create(null) };
  const site = function __uibSite() {
    const lines = String(new Error().stack || '').split('\\n').slice(1).filter((l) => !/__uib/.test(l));
    const fmt = (l) => {
      const m = /^\\s*at (?:(.*?) \\()?(.*?)(?::(\\d+):(\\d+))?\\)?$/.exec(l);
      if (!m) return l.trim();
      const file = String(m[2] || '').split('/').pop();
      return (m[1] || '<anon>') + ' (' + file + ':' + m[3] + ':' + m[4] + ')';
    };
    return lines.length ? lines.slice(0, 3).map(fmt).join(' <- ') : '<no-stack>';
  };
  window.requestAnimationFrame = function __uibRaf(cb) {
    const k = site();
    const s = G.sites[k] || (G.sites[k] = { scheduled: 0, fired: 0 });
    s.scheduled++; G.sched++;
    return orig(function __uibFrame(t) { s.fired++; G.fired++; return cb(t); });
  };
  // Timers: a recurring or self-rescheduling one with delay < 100 ms is per-frame-class work the rAF counter never sees.
  const timer = (real, kind) => function __uibTimer(cb, delay, ...rest) {
    if (typeof cb !== 'function') return real(cb, delay, ...rest);
    const short = (Number(delay) || 0) < 100;
    const k = kind + ':' + site();
    const s = G.tSites[k] || (G.tSites[k] = { kind, scheduled: 0, fired: 0, shortFired: 0 });
    s.scheduled++;
    return real(function __uibTimerCb(...a) { if (!BLIND) { s.fired++; G.tFired++; if (short) { s.shortFired++; G.tShortFired++; } } return cb.apply(this, a); }, delay, ...rest);
  };
  window.setTimeout = timer(window.setTimeout.bind(window), 'timeout');
  window.setInterval = timer(window.setInterval.bind(window), 'interval');
  // ResizeObserver / MutationObserver: a self-resizing / self-mutating callback loops once per frame. (Internal class names carry
  // __uib so the stack filter drops their frames and the CONSTRUCTING site is what gets named.)
  const OrigRO = window.ResizeObserver, OrigMO = window.MutationObserver;
  const __uibOSite = (kind) => { const k = kind + ':' + site(); return G.oSites[k] || (G.oSites[k] = { kind, fired: 0, records: 0 }); };
  if (OrigRO) {
    class __uibRO extends OrigRO {
      constructor(cb) { const s = __uibOSite('ro'); super(function (entries, obs) { if (!BLIND) { s.fired++; G.roFired++; s.records += entries.length; } return cb.call(this, entries, obs); }); }
    }
    Object.defineProperty(__uibRO, 'name', { value: 'ResizeObserver' });
    window.ResizeObserver = __uibRO;
  }
  if (OrigMO) {
    class __uibMO extends OrigMO {
      constructor(cb) { const s = __uibOSite('mo'); super(function (records, obs) { if (!BLIND) { s.fired++; G.moFired++; G.moRecords += records.length; s.records += records.length; } return cb.call(this, records, obs); }); }
    }
    Object.defineProperty(__uibMO, 'name', { value: 'MutationObserver' });
    window.MutationObserver = __uibMO;
  }
  window.__uibSnap = () => ({ now: performance.now(), epoch: G.epoch, sched: G.sched, fired: G.fired,
    sites: Object.fromEntries(Object.entries(G.sites).map(([k, v]) => [k, { scheduled: v.scheduled, fired: v.fired }])),
    tFired: G.tFired, tShortFired: G.tShortFired,
    tSites: Object.fromEntries(Object.entries(G.tSites).map(([k, v]) => [k, { kind: v.kind, scheduled: v.scheduled, fired: v.fired, shortFired: v.shortFired }])),
    roFired: G.roFired, moFired: G.moFired, moRecords: G.moRecords,
    oSites: Object.fromEntries(Object.entries(G.oSites).map(([k, v]) => [k, { kind: v.kind, fired: v.fired, records: v.records }])) });
  // Census roots: the document plus every OPEN shadow root (document.getAnimations() excludes those). Iframes are an accepted gap (0 in tree).
  const roots = () => {
    const out = [document], seen = new Set();
    const walk = (root) => { for (const el of root.querySelectorAll('*')) { const sr = el.shadowRoot; if (sr && !seen.has(sr)) { seen.add(sr); out.push(sr); walk(sr); } } };
    walk(document);
    return out;
  };
  window.__uibCensus = () => {
    const by = {};
    for (const root of roots()) {
      for (const a of root.getAnimations()) {
        if (a.playState !== 'running') continue;
        let t; try { t = a.effect.getComputedTiming(); } catch { continue; }
        if (!(t.iterations === Infinity || t.iterations > 1000)) continue;   // 1e8 iterations is infinite for every practical purpose
        const el = a.effect.target;
        const cls = el && typeof el.className === 'string' && el.className.trim() ? '.' + el.className.trim().split(/\\s+/).slice(0, 3).join('.') : '';
        const selector = el ? el.tagName.toLowerCase() + cls + (a.effect.pseudoElement || '') : '?';
        const name = a.animationName || ('wapi:' + (a.id || 'anon'));
        const key = name + '@' + selector;
        (by[key] = by[key] || { key, name, selector, count: 0 }).count++;
      }
    }
    return Object.values(by);
  };
  window.__uibFrames = (k) => new Promise((res) => {
    let n = 0; const t0 = performance.now();
    const step = () => { if (++n >= k) return res({ ok: true, ms: performance.now() - t0 }); orig(step); };
    orig(step); rst(() => res({ ok: false, ms: performance.now() - t0 }), 4000);
  });
  // Probes THROUGH the wrapped timer / ResizeObserver / MutationObserver. What is reported is what the WRAPPERS recorded (their own
  // counters' deltas), never what the probe callbacks did: a probe that counted itself passed with a blind wrapper (the self-test caught it).
  window.__uibProbes = () => new Promise((res) => {
    const t0 = G.tFired, r0 = G.roFired, m0 = G.moFired;
    const out = { timer: 0, ro: 0, mo: 0 };
    const d = document.createElement('div'); d.style.cssText = 'position:fixed;left:0;top:0;width:5px;height:5px'; document.body.appendChild(d);
    const iv = window.setInterval(() => { out.timer++; }, 5);
    const ro = new window.ResizeObserver(() => { out.ro++; }); ro.observe(d);
    const mo = new window.MutationObserver(() => { out.mo++; }); mo.observe(d, { attributes: true });
    let fin = false;
    const done = () => { if (fin) return; fin = true; clearInterval(iv); ro.disconnect(); mo.disconnect(); d.remove(); res({ timer: G.tFired - t0, ro: G.roFired - r0, mo: G.moFired - m0 }); };
    rst(done, 3000);   // bounded: a hidden page never delivers the rAF the steps below ride on (the control then refuses naming itself, not a rig fault)
    let n = 0;
    const step = () => { d.style.width = (5 + (n++ % 2)) + 'px'; if (n < 6) orig(step); else rst(done, 150); };
    orig(step);
  });
})();`;

const TURN_END = { type: 'turn-end', isError: false, stopReason: 'end_turn', numTurns: 1, costUsd: null, usage: null, resultText: null, sessionId: 'S', durationMs: null, at: 1 };
const turnEndExpr = (id, seq) => `window.__injectAgentEvent('${id}', ${JSON.stringify({ ...TURN_END, seq })})`;

// ── seed (renderer-only fakes, status idle: nothing here can start a session or spend a token) ─────
const seedWorkspacesExpr = (panes) => `(() => {
  const wss = [...Array(${panes}).keys()].map((i) => ({ id: 'ws-' + i, title: 'ws-' + i, repoPath: '/tmp/uib-repo', worktreePath: '/tmp/uib-repo-ws-' + i,
    branch: 'b-ws-' + i, view: 'structured', status: 'idle', activity: 'idle', createdAt: Date.now() }));
  window.__orchestraSetState({ workspaces: wss, activeId: 'ws-0', view: 'structured' });
  return true;
})()`;
const injectTranscriptExpr = (ids, closeTurns = true) => `(() => {
  const TARGET = 80, pad = (n) => Array(n).fill('lorem ipsum dolor sit amet consectetur').join(' ');
  for (const wsId of ${JSON.stringify(ids)}) {
    if ((window.__readAgentSession(wsId)?.messages.length ?? 0) >= TARGET) continue;
    let seq = 0;
    for (let m = 0; m < TARGET / 2; m++) {
      window.__injectAgentEvent(wsId, { type: 'user-message', text: 'message ' + m + ' ' + pad(1 + (m % 4)), seq: seq++, at: Date.now() });
      window.__injectAgentEvent(wsId, { type: 'notice', kind: 'info', text: 'reply ' + m + ' ' + pad(1 + ((m + 2) % 3)), seq: seq++, at: Date.now() });
    }
    // a user-message opens a turn (running=true: spinner, shimmer, interrupt button): close it, or the pane is mid-turn, not idle
    if (${closeTurns}) window.__injectAgentEvent(wsId, Object.assign(${JSON.stringify(TURN_END)}, { seq: seq++ }));
  }
  return true;
})()`;

// ── main ─────────────────────────────────────────────────────────────────────
const kids = [];
let appPid = 0;
async function killApp() {
  if (!appPid) return;
  const all = [appPid, ...descendants(appPid)];
  for (const p of all) { try { process.kill(p, 'SIGTERM'); } catch { /* gone */ } }
  for (let i = 0; i < 20 && all.some(alive); i++) await sleep(250);
  for (const p of all.filter(alive)) { try { process.kill(p, 'SIGKILL'); } catch { /* gone */ } }
  for (let i = 0; i < 20 && all.some(alive); i++) await sleep(100);
  const left = all.filter(alive);
  if (left.length) log(`WARN: app pids still alive after SIGKILL: ${left.join(',')}`);
  appPid = 0;
}
process.on('SIGINT', async () => { await killApp(); process.exit(130); });
process.on('SIGTERM', async () => { await killApp(); process.exit(143); });

async function main() {
  for (const f of ['package.json', 'dist/index.html', 'dist-electron/main.js', 'dist-electron/keeper.js']) {
    if (!fs.existsSync(path.join(APP, f))) { console.error(`ABORT: ${APP}/${f} missing — build first (pnpm run build:bundles)`); process.exit(2); }
  }
  // `--budget none` = the shipped file with an EMPTY animation allowlist (strict zero animations; every other budget unchanged).
  const budgetPath = BUDGET_FILE === 'none' ? path.join(HERE, 'ui-idle-budget.json') : BUDGET_FILE;
  const budget = parseBudget(JSON.parse(fs.readFileSync(budgetPath, 'utf8')));
  if (BUDGET_FILE === 'none') budget.infiniteAnimations = {};
  log(`budget: ${BUDGET_FILE === 'none' ? 'shipped file, animation allowlist EMPTY (--budget none)' : BUDGET_FILE} = ${JSON.stringify(budget)}`);
  if (!RIG.rigDir || !RIG.wayland) { console.error('ABORT: not launched via scripts/e2e-ui-idle-budget.sh (RIG_DIR / RIG_WAYLAND unset)'); process.exit(2); }

  // ── the child env, built ONCE as an allowlist, then asserted (read back OUT of the object the child gets) ──
  // The scratch config dir is what the WRAPPER pinned (CLAUDE_CONFIG_DIR_PIN → the rig's CLAUDE_CONFIG_DIR): checkHandOff below
  // refuses it unless it is inside RIG_DIR and not a live dir — so a pin at a live dir (the self-test's must-FAIL arm) is refused.
  const cfgDir = process.env.CLAUDE_CONFIG_DIR ?? '';
  const port = await freePort();
  const childEnv = {
    PATH: '/usr/local/bin:/usr/bin:/bin',
    HOME: RIG.home,
    XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR ?? '/run/user/1000',
    XDG_CONFIG_HOME: path.join(RIG.home, '.config'),
    XDG_CACHE_HOME: path.join(RIG.home, '.cache'),
    WAYLAND_DISPLAY: RIG.wayland,
    ELECTRON_OZONE_PLATFORM_HINT: 'wayland',
    ORCHESTRA_OZONE: 'wayland',
    ORCHESTRA_OZONE_RELAUNCHED: '1',
    ORCHESTRA_HOME: path.join(RIG.rigDir, 'oh'),
    ORCHESTRA_DEBUG_PORT: String(port),
    ORCHESTRA_SELF_TUNE_CMD: '/bin/true',   // a fresh home makes the monthly self-tune due: never a real `claude -p /insights` (D6: zero tokens)
    CLAUDE_CONFIG_DIR: cfgDir,
  };
  // Self-test knobs (argv): inject a hostile env and watch the SHIPPED guard refuse, naming its clause.
  if (flag('selftest-force-wayland', '')) childEnv.WAYLAND_DISPLAY = flag('selftest-force-wayland', '');
  if (flag('selftest-add-display', '')) childEnv.DISPLAY = flag('selftest-add-display', '');
  const g1 = checkChildEnv(childEnv, RIG.wayland);
  if (!g1.ok) refuse(g1);
  const g2 = checkHandOff({ HOME: childEnv.HOME, CLAUDE_CONFIG_DIR: childEnv.CLAUDE_CONFIG_DIR, XDG_CONFIG_HOME: childEnv.XDG_CONFIG_HOME, XDG_CACHE_HOME: childEnv.XDG_CACHE_HOME, ORCHESTRA_HOME: childEnv.ORCHESTRA_HOME }, RIG.rigDir, liveDirs());
  if (!g2.ok) refuse(g2);
  log(`isolation ok — ${g1.detail}; ${g2.detail}`);
  for (const d of [cfgDir, childEnv.ORCHESTRA_HOME, childEnv.XDG_CONFIG_HOME, childEnv.XDG_CACHE_HOME]) fs.mkdirSync(d, { recursive: true });
  // rig mutant: bus.sqlite pre-created as a DIRECTORY → the app's real open() fails → `bus: FAILED to open` (no bundle edit needed)
  if (ST.breakBus) fs.mkdirSync(path.join(childEnv.ORCHESTRA_HOME, 'bus.sqlite'));

  // ── boot ──
  const electron = path.join(APP, 'node_modules', 'electron', 'dist', 'electron');
  if (!fs.existsSync(electron)) { console.error(`ABORT: ${electron} missing — pnpm install`); process.exit(2); }
  const app = spawn(electron, ['.', '--ozone-platform=wayland'], { cwd: APP, env: childEnv, stdio: ['ignore', 'ignore', 'pipe'] });
  appPid = app.pid; kids.push(app);
  let stderrTail = '';
  app.stderr.on('data', (d) => { stderrTail = (stderrTail + d).slice(-4000); });
  app.on('exit', (c, s) => log(`app exited code=${c} signal=${s}`));

  let target = null;
  for (let i = 0; i < 200 && !target; i++) {   // 60 s: a slow boot under load must not read as a rig fault
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json`, { signal: AbortSignal.timeout(3000) })).json();
      target = list.find((t) => t.type === 'page' && t.url && !t.url.startsWith('devtools://')) ?? null;
    } catch { /* not up yet */ }
    if (!target) await sleep(300);
  }
  if (!target) { console.error(`ABORT: no CDP target on ${port}\n${stderrTail}`); await killApp(); process.exit(3); }
  if (!target.url.includes(APP) || !target.url.includes('dist/index.html')) { console.error(`ABORT: driving the wrong app — target ${target.url} is not ${APP}/dist/index.html (an app.asar url = the INSTALLED build)`); await killApp(); process.exit(3); }
  log(`target ${target.url}`);

  // The window must be in MY sway, and the live process env must carry no DISPLAY and my display.
  const live = procEnv(appPid);
  const g3 = checkChildEnv(live, RIG.wayland);
  if (!g3.ok) { console.error(`ABORT: live app env failed isolation [${g3.clause}]: ${g3.detail}`); await killApp(); process.exit(90); }
  const swayEnv = { PATH: '/usr/bin:/bin', SWAYSOCK: RIG.swaysock, XDG_RUNTIME_DIR: childEnv.XDG_RUNTIME_DIR };
  let inMySway = false;
  for (let i = 0; i < 30 && !inMySway; i++) {   // the window maps a moment after the CDP target appears (slower under load)
    inMySway = execFileSync('swaymsg', ['-t', 'get_tree'], { env: swayEnv, encoding: 'utf8', timeout: 10000 }).includes(`"pid": ${appPid}`);
    if (!inMySway) await sleep(500);
  }
  log(`app pid ${appPid} in my sway get_tree: ${inMySway}`);
  if (!inMySway) { console.error(`ABORT: app pid ${appPid} is not a window in my sway (${RIG.swaysock})`); await killApp(); process.exit(90); }

  const cdp = await Cdp.connect(target.webSocketDebuggerUrl);
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  // Install the counter BEFORE any app script, then reload so the very first script already sees it.
  let instrument = INSTRUMENT;
  if (ST.blindRaf) {   // rig mutant: the wrapper forwards without counting — a real loop must then read REFUSED, not PASS
    const blind = INSTRUMENT.replace('return orig(function __uibFrame(t) { s.fired++; G.fired++; return cb(t); });', 'return orig(cb);');
    if (blind === INSTRUMENT) throw new Error('selftest-blind-raf: anchor not found in INSTRUMENT');
    instrument = blind;
  }
  if (ST.blindObservers) instrument = `window.__uibBlind = true;${instrument}`;   // rig mutant: timers/observers forward without counting
  const appReady = () => cdp.eval(`typeof window.__orchestraSetState === 'function' && typeof window.__injectAgentEvent === 'function'`).catch(() => false);
  if (ST.lateInstall) {
    // rig mutant: NO evaluate-on-new-document + reload — install after the app booted (the bundle's module-load captures escape it)
    for (let t0 = Date.now(); Date.now() - t0 < 60000 && (await appReady()) !== true;) await sleep(300);
    await cdp.eval(instrument);
  } else {
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: instrument });
    await cdp.send('Page.reload', { ignoreCache: true });
    for (let t0 = Date.now(); Date.now() - t0 < 60000;) {
      const ok = await cdp.eval(`typeof window.__uibSnap === 'function'`).catch(() => false);
      if (ok === true && (await appReady()) === true) break;
      await sleep(300);
    }
  }
  if ((await cdp.eval(`typeof window.__uibSnap`).catch(() => '')) !== 'function') { console.error('ABORT: instrument never installed / app never rendered'); await killApp(); process.exit(3); }

  // Artifact identity: the renderer's executing script bytes == the on-disk bundle (which the self-test may have mutated).
  const bundleIdentity = await (async () => {
    const html = fs.readFileSync(path.join(APP, 'dist', 'index.html'), 'utf8');
    const rel = /src="\.?\/?(assets\/index-[^"]+\.js)"/.exec(html)?.[1];
    if (!rel) return false;
    const tree = await cdp.send('Page.getResourceTree');
    const res = tree.frameTree.resources.find((r) => r.url.endsWith(`/${rel}`));
    if (!res) return false;
    const got = await cdp.send('Page.getResourceContent', { frameId: tree.frameTree.frame.id, url: res.url });
    const body = got.base64Encoded ? Buffer.from(got.content, 'base64') : Buffer.from(got.content, 'utf8');
    const disk = fs.readFileSync(path.join(APP, 'dist', rel));
    log(`bundle ${rel}: page sha256 ${createHash('sha256').update(body).digest('hex').slice(0, 16)} disk ${createHash('sha256').update(disk).digest('hex').slice(0, 16)}`);
    return Buffer.compare(body, disk) === 0;
  })();

  // ── mount PANES idle structured panes; refuse (never pass) if they do not ──
  const ids = [...Array(PANES).keys()].map((i) => 'ws-' + i);
  const avViews = () => cdp.eval(`document.querySelectorAll('.av-view').length`);
  let mounted = false;
  for (let attempt = 0; attempt < (ST.noSeed ? 2 : 20) && !mounted; attempt++) {
    if (!ST.noSeed) await cdp.eval(seedWorkspacesExpr(PANES));
    // StructuredView mounts for every workspace in App's LRU, filled only as `activeId` CHANGES: cycle through all, end on ws-0.
    for (let i = PANES - 1; i >= 0; i--) { await cdp.eval(`window.__orchestraSetState({ activeId: 'ws-${i}', view: 'structured' })`); await sleep(150); }
    await cdp.eval(injectTranscriptExpr(ids, !ST.openTurns));
    await sleep(600);
    mounted = (await avViews()) === PANES;
  }
  if (!mounted) { console.error(`REFUSED: ${PANES} structured panes never all mounted (.av-view=${await avViews()}) — the subject is absent, a 0 would be vacuous`); await killApp(); process.exit(4); }
  await sleep(1500);

  // ── the RICH subject: a REAL transcript slice (assistant markdown + fenced code, Read/Edit/Bash cards, the Edit's diff) and the real
  //    background-task frames, injected into every pane, then the tasks panel opened by a TRUSTED click on the visible pane. A loop inside
  //    a component that never mounts is invisible to every counter, so `rich-subject` refuses a pane that lacks any of it. ──
  const richMarkersExpr = `(() => { const q = (s) => document.querySelector(s), n = (s) => document.querySelectorAll(s).length;
    return { 'md-list': !!q('.av-md-ul, .av-md-ol'), 'code-block': !!q('.av-code-block'), 'tool-runs': n('.av-tool-run') >= 2, 'diff': !!q('.av-tool-run-diff, .av-diff-add'), 'bgtask-panel': !!q('.av-bgtask-panel'),
      'composer-focused': !!document.activeElement?.closest?.('.cm-editor') }; })()`;
  const distinctAvExpr = `new Set(Array.from(document.querySelectorAll('[class]'), (e) => Array.from(e.classList)).flat().filter((c) => c.startsWith('av-'))).size`;
  if (!ST.noRich) {
    const stamp = (evs, base) => evs.map((e, i) => ({ ...e, seq: base + i, at: Date.now() }));
    const bgCtx = { seq: 0, now: () => FIXTURE_AT };
    const payload = stamp(richSessionEvents().events, 5000).concat(stamp(backgroundTaskLifecycle().flatMap((f) => normalizeSdkMessage(f, bgCtx)), 6000));
    await cdp.eval(`window.__uibRich = ${JSON.stringify(payload)}; 0`);
    await cdp.eval(`(() => { for (const id of ${JSON.stringify(ids)}) for (const ev of window.__uibRich) window.__injectAgentEvent(id, ev); return true; })()`);
    await sleep(1000);
    const rect = await cdp.eval(`(() => { const t = [...document.querySelectorAll('.av-bgtask-toggle')].find((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
      if (!t) return null; const r = t.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    if (rect) {
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rect.x, y: rect.y });
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: rect.x, y: rect.y, button: 'left', clickCount: 1 });
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rect.x, y: rect.y, button: 'left', clickCount: 1 });
    }
    await sleep(600);
    // the realistic worst-case idle state: the user's caret sits in the composer (its cursor layers blink); the click above moved focus to the toggle
    await cdp.eval(`document.querySelector('.av-view.active .cm-content')?.focus(); 0`);
    await sleep(800);
    log(`rich subject: ${await cdp.eval(distinctAvExpr)} distinct av-* classes; markers ${JSON.stringify(await cdp.eval(richMarkersExpr))}`);
  }

  // ── quiesce: 3 consecutive 1 s windows with no counted rAF callback (cap 30 s). A page that never goes quiet
  //    simply proceeds — the window below then FAILS the budget, naming the perpetual loop. ──
  let settled = false, quiet = 0;
  for (let i = 0; i < 30 && !settled; i++) {
    const a = await cdp.eval(`__uibSnap().fired`); await sleep(1000); const b = await cdp.eval(`__uibSnap().fired`);
    quiet = b === a ? quiet + 1 : 0; settled = quiet >= 3;
  }
  log(`settled=${settled}`);

  if (ST.hideWindow) {   // rig mutant: the compositor unmaps the window → the page is hidden → it delivers no frames (a vacuous 0)
    execFileSync('swaymsg', [`[pid=${appPid}] move scratchpad`], { env: swayEnv, encoding: 'utf8', timeout: 10000 });
    await sleep(1500);
    log(`hide-window: visibilityState=${await cdp.eval('document.visibilityState')}`);
  }
  // ── controls (each must be able to FAIL) ──
  // (a) the APP's own rAF path is seen by the counter, AND an open turn animates: drive a real prompt burst through the
  //     app's event queue (`user-message` opens a turn: spinner + shimmer + interrupt dot), count rAF + animations, then
  //     close the turn with `turn-end` and require the animations to stop — the pane must be idle before the window.
  const total = (list) => list.reduce((n, a) => n + a.count, 0);
  const s0 = await cdp.eval(`__uibSnap()`);
  await cdp.eval(`(() => { for (let i = 0; i < 4; i++) window.__injectAgentEvent('ws-0', { type: 'user-message', text: 'burst ' + i, seq: 9000 + i, at: Date.now() }); return true; })()`);
  await sleep(700);
  const s1 = await cdp.eval(`__uibSnap()`);
  const appBurstRafFired = s1.fired - s0.fired;
  const openTurnAnimCount = total(await cdp.eval(`__uibCensus()`));
  if (!ST.openTurns) await cdp.eval(turnEndExpr('ws-0', 9100));
  await sleep(1500);
  const closedTurnAnimCount = total(await cdp.eval(`__uibCensus()`));
  // (b) frames are being delivered (a hidden/throttled page reads 0 vacuously).
  const framesBefore = (await cdp.eval(`__uibFrames(5)`)).ok;
  // (b2) the timer / ResizeObserver / MutationObserver wrappers count what goes THROUGH them, and the instrument preceded the app.
  const probes = await cdp.eval(`__uibProbes()`);
  const instrumentFirst = await cdp.eval(`window.__uib.readyState === 'loading' && window.__uib.scriptsAtInstall === 0`);
  // (c) the animation census can see an infinite CSS animation, and stops seeing it once gone.
  const probe = await cdp.eval(`(async () => {
    const st = document.createElement('style'); st.id = 'uib-probe-style';
    st.textContent = '@keyframes uib-probe { from { opacity: 1 } to { opacity: .99 } } .uib-probe { animation: uib-probe 1s linear infinite; width: 4px; height: 4px; position: fixed; left: 0; top: 0 }';
    document.head.appendChild(st);
    const el = document.createElement('div'); el.className = 'uib-probe'; document.body.appendChild(el);
    await window.__uibFrames(3);
    const seen = window.__uibCensus().some((a) => a.name === 'uib-probe');
    el.remove(); st.remove();
    await window.__uibFrames(3);
    const cleared = !window.__uibCensus().some((a) => a.name === 'uib-probe');
    return { seen, cleared };
  })()`);
  await sleep(1000);

  // ── the measurement window ──
  // quiesce again: the burst + turn-end above re-rendered ws-0
  for (let i = 0, q = 0; i < 20 && q < 2; i++) { const a = await cdp.eval(`__uibSnap().fired`); await sleep(1000); q = (await cdp.eval(`__uibSnap().fired`)) === a ? q + 1 : 0; }
  const openTurnsStart = await cdp.eval(`${JSON.stringify(ids)}.filter((id) => window.__readAgentSession(id)?.running).length`);
  const getMetrics = async () => { try { return Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map((x) => [x.name, x.value])); } catch { return null; } };
  await cdp.send('Performance.enable').catch(() => { /* metrics-read control refuses */ });
  const richStart = ST.noRich ? {} : await cdp.eval(richMarkersExpr);
  const c0 = await cdp.eval(`__uibCensus()`);
  const pm0 = await getMetrics();
  const w0 = await cdp.eval(`__uibSnap()`);
  log(`window ${WINDOW_MS} ms over ${PANES} idle panes …`);
  const perSecond = [];   // 1 s buckets: a perpetual loop fills every one, a stray one-shot sits in one
  for (let left = WINDOW_MS, prev = w0.fired; left > 0; left -= 1000) {
    await sleep(Math.min(1000, left));
    const f = await cdp.eval(`__uibSnap().fired`);
    perSecond.push(f - prev); prev = f;
  }
  const w1 = await cdp.eval(`__uibSnap()`);
  const pm1 = await getMetrics();
  const load1 = Number(fs.readFileSync('/proc/loadavg', 'utf8').split(' ')[0]);
  const c1 = await cdp.eval(`__uibCensus()`);
  const richEnd = ST.noRich ? {} : await cdp.eval(richMarkersExpr);
  const distinctAvClasses = await cdp.eval(distinctAvExpr);
  const framesAfter = (await cdp.eval(`__uibFrames(5)`)).ok;
  const visibility = await cdp.eval(`document.visibilityState`);
  const state = await cdp.eval(`(() => ({
    avViewsAtEnd: document.querySelectorAll('.av-view').length,
    rowsPerPane: ${JSON.stringify(ids)}.map((id) => window.__readAgentSession(id)?.messages.length ?? 0),
    visibleRows: document.querySelectorAll('.av-message-list-inner > div > *').length,
    hasFocus: document.hasFocus(),
    openTurnsEnd: ${JSON.stringify(ids)}.filter((id) => window.__readAgentSession(id)?.running).length,
  }))()`);

  // The bus opens at boot and logs one line either way (index.ts): read it back from THIS boot's log.
  const appLog = (() => { try { return fs.readFileSync(path.join(childEnv.ORCHESTRA_HOME, 'logs', 'orchestra.log'), 'utf8'); } catch { return ''; } })();
  const busOpen = appLog.includes('bus: opened') ? true : appLog.includes('bus: FAILED to open') ? false : null;
  log(`bus: ${busOpen === true ? 'open' : busOpen === false ? 'UNAVAILABLE (native ABI is not Electron\'s — pnpm run build:bus-abi)' : 'unknown'}${REQUIRE_BUS ? ' [required]' : ''}`);
  const bySite = Object.keys(w1.sites).map((k) => ({ site: k, scheduled: w1.sites[k].scheduled - (w0.sites[k]?.scheduled ?? 0), fired: w1.sites[k].fired - (w0.sites[k]?.fired ?? 0) }))
    .filter((s) => s.scheduled || s.fired);
  // The scheduling frame is minified (`z (index-x.js:338:20904)`): quote the shipped bundle around it so the FAIL line is readable.
  for (const s of bySite) {
    if (!s.fired) continue;
    const m = /\((index-[^):]+\.js):(\d+):(\d+)\)/.exec(s.site);
    if (!m) continue;
    try {
      const line = fs.readFileSync(path.join(APP, 'dist', 'assets', m[1]), 'utf8').split('\n')[Number(m[2]) - 1] ?? '';
      const col = Number(m[3]) - 1;
      s.snippet = line.slice(Math.max(0, col - 50), col + 90).replace(/\s+/g, ' ');
    } catch { /* bundle unreadable: the site string still names it */ }
  }
  // steady = present at BOTH ends by animation NAME (a churning class cannot evade it); reported at its end-of-window selector
  const names0 = new Set(c0.map((a) => a.name));
  const steady = c1.filter((a) => names0.has(a.name)).map((a) => ({ key: a.key, name: a.name, selector: a.selector, count: a.count }));
  const timerRows = Object.entries(w1.tSites).map(([k, v]) => ({ site: k, short: v.shortFired - (w0.tSites[k]?.shortFired ?? 0) }));
  const observerRows = Object.entries(w1.oSites).map(([k, v]) => ({ site: k.replace(/^(ro|mo):/, ''), kind: v.kind, fired: v.fired - (w0.oSites[k]?.fired ?? 0) })).filter((x) => x.fired > 0);
  const mk = (a, b, k) => (a && b ? b[k] - a[k] : NaN);
  const markers = Object.fromEntries(Object.keys(richEnd).map((k) => [k, !!richStart[k] && !!richEnd[k]]));
  const m = {
    windowMs: WINDOW_MS,
    panesWanted: PANES,
    panes: { avViews: PANES, rowsPerPane: state.rowsPerPane, visibleRows: state.visibleRows, avViewsAtEnd: state.avViewsAtEnd, openTurns: Math.max(openTurnsStart, state.openTurnsEnd) },
    rich: { distinctAvClasses, markers },
    raf: { fired: w1.fired - w0.fired, scheduled: w1.sched - w0.sched, bySite, perSecond },
    timers: { totalFired: w1.tFired - w0.tFired, shortFired: w1.tShortFired - w0.tShortFired, loopSites: timerRows.filter((x) => x.short >= 2).map((x) => ({ site: x.site, fired: x.short })) },
    observers: { resizeFired: w1.roFired - w0.roFired, mutationFired: w1.moFired - w0.moFired, bySite: observerRows },
    metrics: pm0 && pm1 ? { RecalcStyleCount: mk(pm0, pm1, 'RecalcStyleCount'), LayoutCount: mk(pm0, pm1, 'LayoutCount'), TaskDuration: mk(pm0, pm1, 'TaskDuration') } : null,
    load1,
    infiniteAnimations: steady,
    controls: { appBurstRafFired, openTurnAnimCount, closedTurnAnimCount, probeTimerFired: probes.timer, probeRoFired: probes.ro, probeMoFired: probes.mo,
      framesBefore, framesAfter, visibility, animProbeSeen: probe.seen, animProbeCleared: probe.cleared,
      sameEpoch: w0.epoch === w1.epoch && s0.epoch === w0.epoch, elapsedMs: Math.round(w1.now - w0.now), instrumentFirst, bundleIdentity, settled, busOpen, requireBus: REQUIRE_BUS },
  };
  const v = judge(m, budget);
  const richClasses = await cdp.eval(`[...new Set(Array.from(document.querySelectorAll('[class]'), (e) => Array.from(e.classList)).flat().filter((c) => c.startsWith('av-')))].sort()`);
  const out = { verdict: v.verdict, exitCode: v.exitCode, app: APP, appPid, budget, hasFocus: state.hasFocus, visibleRows: state.visibleRows, richClasses, measurement: m, clauses: v.clauses };
  const jsonPath = JSON_OUT || path.join(RIG.rigDir, 'ui-idle-budget.json');
  fs.writeFileSync(jsonPath, JSON.stringify(out, null, 2));
  for (const l of renderClauses(v)) console.log(l);
  console.log(`ui-idle-budget: ${v.verdict} — ${PANES} idle pane(s), ${WINDOW_MS} ms window, rAF fired ${m.raf.fired} (budget ${budget.rafFired}), short-timer loops ${m.timers.loopSites.length}, RO ${m.observers.resizeFired} / MO ${m.observers.mutationFired}, metrics ${m.metrics ? JSON.stringify(m.metrics) : 'n/a'}, steady infinite animations ${steady.reduce((n, a) => n + a.count, 0)} [${steady.map((a) => `${a.key} ×${a.count}`).join('; ')}] (result: ${jsonPath})`);
  cdp.close();
  await killApp();
  process.exit(v.exitCode);
}
main().catch(async (e) => { console.error('FATAL', e); await killApp(); process.exit(3); });
