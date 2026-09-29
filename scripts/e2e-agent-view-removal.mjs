#!/usr/bin/env node
// Removal-assertion E2E rig — wave "Agent view only" (#219), ticket #225.
//
// Boots a BUILT Orchestra (path = argv[2]) in an isolated ORCHESTRA_HOME under ~ (btrfs),
// with a seeded store, inside the compositor scripts/e2e-contained-rig.sh started, and
// reports two observables of the RUNNING app:
//   (1) the workspace TAB LABELS actually rendered (DOM of `.toolbar .tabs .tab`),
//   (2) the LIVE PTY SESSIONS by kind agent|run|nvim|login — `window.orchestra.sampleResources()`,
//       the exact IPC the Resources page polls (`resources:sample` -> `listPtySessions()`
//       -> `classifyPtyId`). Already script-readable through the preload bridge, so NO new
//       exposure was added. Keeper-hosted SDK sessions are NOT PTYs and never appear there.
//
// Run through the wrapper (own sway, env -i allowlist, pinned account, btrfs base):
//   scripts/e2e-agent-view-removal.sh <app-dir> [--mode baseline|after] [--arm a,b] [--list] [--broken-control]
//   (`pnpm run test:agent-view-removal`; --broken-control = self-test knob, see below.)
//
// MODES — every arm carries BOTH expectations, picked by --mode:
//   baseline  today's behaviour (Raw tab present, opening Raw creates an agent-kind PTY).
//             Must be GREEN on a pre-change master build; RED on a candidate that removed Raw.
//   after     the removal spec (#219): tabs exactly Agent·Run·Diff, no agent PTY from any tab.
//             Must be RED on master (proves the arm can fail); GREEN once the removal lands.
// EXTENDING (tickets #226-#233): add one object to ARMS, put both expectations in EXPECT,
// print through ctx.clause(name, ok, detail) so each line names the clause that fired.
// Flipping a baseline assertion = edit its `baseline` value in EXPECT, nothing else.
//
// GUARDS: an arm that asserts a PTY is ABSENT is REFUSED unless the Run-tab positive control
// fired in the SAME boot (a listing that cannot see PTYs proves nothing). Every boot prints
// IDENTITY (running version + loaded bundle md5) and proves isolation (own compositor,
// own ORCHESTRA_HOME, never wayland-1) before any arm asserts.

import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';

// ── expectations: the ONE place baseline↔after flips live ────────────────────
const EXPECT = {
  // Ordered labels as rendered (own text; the Run tab's "· setup" hint is a child span).
  tabs: { baseline: ['Raw', 'Run', 'Structured', 'Diff'], after: ['Agent', 'Run', 'Diff'] },
  // The Agent view's tab label, and that a fresh workspace opens on it.
  agentTab: { baseline: 'Structured', after: 'Agent' },
  // Does opening the (Raw) terminal tab create an agent-kind PTY?
  rawCreatesAgentPty: { baseline: true, after: false },
};
const ABSENCE_MS = 2500; // window an "absent" claim is observed for after each tab click
const SENTINEL_USER = 'AVR-USER-4f81c2 render probe';
const SENTINEL_ASSISTANT = 'AVR-ASSISTANT-9d03e7 rendered through the real fold path';

// ── args ─────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const flag = (n) => { const i = argv.indexOf(n); return i < 0 ? null : (argv[i + 1] ?? ''); };
const MODE = flag('--mode') ?? 'baseline';
const ARM_SEL = flag('--arm');
const LIST = argv.includes('--list');
// SELF-TEST knob: seed a repo with NO Run script, so the Run-tab control cannot make a PTY appear
// and every "no agent PTY" assertion must be REFUSED (proves the gate is load-bearing).
const BROKEN_CONTROL = argv.includes('--broken-control');
const positional = argv.filter((a, i) => !a.startsWith('--') && !['--mode', '--arm'].includes(argv[i - 1]));
const APP_DIR = positional[0] ? fs.realpathSync(positional[0]) : null;
if (!['baseline', 'after'].includes(MODE)) { console.error(`bad --mode ${MODE} (baseline|after)`); process.exit(2); }
const pick = (e) => e[MODE];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(what, fn, ms = 15000, step = 150) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`timeout ${ms}ms: ${what}`);
    await sleep(step);
  }
}

// ── result bookkeeping ───────────────────────────────────────────────────────
const RESULTS = [];
function makeCtx(arm) {
  return {
    arm, mode: MODE, controls: { run: false }, app: null,
    clause(name, ok, detail = '') {
      RESULTS.push({ arm, clause: name, ok: !!ok, detail });
      console.log(`${ok ? 'PASS' : 'FAIL'}  ${arm}/${name}${detail ? ' — ' + detail : ''}`);
      return !!ok;
    },
    note(line) { console.log(`      ${arm}: ${line}`); },
  };
}

// ── isolation guard (pure: the self-test arm drives the same function) ───────
/** `env` = the object the child receives (or read back from /proc/<pid>/environ). */
function checkChildEnv(env, mine) {
  const got = env.WAYLAND_DISPLAY;
  if (!got) return { ok: false, clause: 'no-wayland-display', detail: 'child env carries no WAYLAND_DISPLAY' };
  // ORDER MATTERS: wayland-1 (the human's) must be refused BEFORE the equality can be reached.
  if (got === 'wayland-1') return { ok: false, clause: 'refuse-wayland-1', detail: 'wayland-1 is the human\'s compositor' };
  if (!mine) return { ok: false, clause: 'no-rig-display', detail: 'RIG_WAYLAND unset — not launched via e2e-contained-rig.sh' };
  if (got !== mine) return { ok: false, clause: 'not-my-compositor', detail: `${got} != my marker-verified ${mine}` };
  if ('DISPLAY' in env) return { ok: false, clause: 'x11-display-set', detail: `DISPLAY=${env.DISPLAY} would reach an X server` };
  return { ok: true, clause: 'display-isolated', detail: `WAYLAND_DISPLAY=${got}, DISPLAY absent` };
}

// ── PNG decode (8-bit RGB/RGBA) so a gate asserts DECODED PIXELS, never DOM text ─
function decodePng(buf) {
  if (buf.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new Error('not a PNG');
  let pos = 8, w = 0, h = 0, ct = 0, bd = 0; const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos); const type = buf.toString('latin1', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); bd = data[8]; ct = data[9]; }
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  if (bd !== 8 || (ct !== 2 && ct !== 6)) throw new Error(`unsupported PNG bd=${bd} ct=${ct}`);
  const ch = ct === 6 ? 4 : 3, stride = w * ch;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const px = Buffer.alloc(h * stride); let i = 0;
  for (let y = 0; y < h; y++) {
    const f = raw[i++]; const row = y * stride, prev = row - stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? px[row + x - ch] : 0, b = y ? px[prev + x] : 0, c = x >= ch && y ? px[prev + x - ch] : 0;
      let v = raw[i++];
      if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      px[row + x] = v & 255;
    }
  }
  return { w, h, ch, px };
}
/** Pixel statistics that separate a painted pane from an empty one: how much of the
 *  image is NOT the modal (background) colour, and how many distinct colours it holds. */
function pngStats(buf) {
  const { w, h, ch, px } = decodePng(buf);
  const counts = new Map();
  for (let i = 0; i < px.length; i += ch) {
    const k = (px[i] << 16) | (px[i + 1] << 8) | px[i + 2];
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  let modal = 0; for (const c of counts.values()) if (c > modal) modal = c;
  const total = w * h;
  return { w, h, bytes: buf.length, distinct: counts.size, nonBgPct: +(((total - modal) / total) * 100).toFixed(3) };
}

/** The painted-vs-blank rule the content arm gates on (kept pure so pixel_selftest drives the SAME predicate). */
const paintedBeyondBlank = (C, B) => C.nonBgPct > B.nonBgPct + 0.05 && C.distinct > B.distinct + 4;

// ── /proc helpers ────────────────────────────────────────────────────────────
const procEnv = (pid) => {
  const out = {};
  for (const kv of fs.readFileSync(`/proc/${pid}/environ`, 'latin1').split('\0')) {
    const i = kv.indexOf('=');
    if (i > 0) out[kv.slice(0, i)] = kv.slice(i + 1);
  }
  return out;
};
const procCmdline = (pid) => { try { return fs.readFileSync(`/proc/${pid}/cmdline`, 'latin1').split('\0').join(' ').trim(); } catch { return ''; } };
const procStart = (pid) => { try { const s = fs.readFileSync(`/proc/${pid}/stat`, 'latin1'); return s.slice(s.lastIndexOf(')') + 2).split(' ')[19]; } catch { return null; } };
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

// ── CDP over raw WebSocket (Node 22 global; no dependency) ───────────────────
class Cdp {
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('cdp ws error')); });
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
  send(method, params = {}, ms = 15000) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      const t = setTimeout(() => { this.pending.delete(id); rej(new Error(`cdp timeout ${ms}ms: ${method}`)); }, ms);
      this.pending.set(id, { method, res: (v) => { clearTimeout(t); res(v); }, rej: (e) => { clearTimeout(t); rej(e); } });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(`eval: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    return r.result.value;
  }
  close() { try { this.ws.close(); } catch { /* */ } }
}

// ── the app under test ───────────────────────────────────────────────────────
const RIG = {
  wayland: process.env.RIG_WAYLAND ?? '',
  swaysock: process.env.SWAYSOCK ?? '',
  base: process.env.ORCHESTRA_HOME ?? '',          // the rig's `oh`; each boot gets a subdir
  cfg: process.env.CLAUDE_CONFIG_DIR ?? '',        // pinned from the INVOKING agent's login
  rigDir: process.env.RIG_DIR ?? '',
};
const REAL_HOME = os.userInfo().homedir;
const gitEnv = (home) => ({ PATH: '/usr/local/bin:/usr/bin:/bin', HOME: home, GIT_AUTHOR_NAME: 'avr', GIT_AUTHOR_EMAIL: 'avr@example.invalid', GIT_COMMITTER_NAME: 'avr', GIT_COMMITTER_EMAIL: 'avr@example.invalid', GIT_CONFIG_NOSYSTEM: '1' });
const git = (cwd, args, home) => execFileSync('git', args, { cwd, env: gitEnv(home), encoding: 'utf8' });

async function freePort() {
  return await new Promise((res, rej) => {
    const s = net.createServer(); s.on('error', rej);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  });
}

/** Seed: a real git repo + registered worktree (prune deletes what it cannot verify), the
 *  repo's Run script, the PINNED account, and a stub `claude` that never touches the API. */
function seedWorld(home) {
  const fakeHome = path.join(home, 'home');
  const repoDir = path.join(home, 'repo'), wtDir = path.join(home, 'wt', 'avr-1');
  fs.mkdirSync(fakeHome, { recursive: true }); fs.mkdirSync(repoDir, { recursive: true });
  git(repoDir, ['init', '-q', '-b', 'main'], fakeHome);
  fs.writeFileSync(path.join(repoDir, 'README.md'), '# avr seed repo\n');
  git(repoDir, ['add', '.'], fakeHome); git(repoDir, ['commit', '-q', '-m', 'seed'], fakeHome);
  fs.mkdirSync(path.dirname(wtDir), { recursive: true });
  git(repoDir, ['worktree', 'add', '-q', '-b', 'e2e/avr-1', wtDir], fakeHome);
  const listed = git(repoDir, ['worktree', 'list', '--porcelain'], fakeHome);
  if (!listed.includes(`worktree ${fs.realpathSync(wtDir)}`)) throw new Error(`seed worktree not registered:\n${listed}`);

  if (!RIG.cfg || !fs.existsSync(RIG.cfg)) throw new Error(`pinned config dir missing: '${RIG.cfg}'`);
  const account = { id: 'rig-avr', label: `rig (${RIG.cfg})`, configDir: RIG.cfg };
  const ws = {
    id: 'ws-avr-1', name: 'avr-1', repoPath: repoDir, worktreePath: wtDir, branch: 'e2e/avr-1',
    baseBranch: 'main', createdAt: Date.now(), status: 'idle', agent: 'claude', accountId: account.id,
  };
  const repo = { path: repoDir, name: 'avr-repo', defaultBranch: 'main', scripts: BROKEN_CONTROL ? {} : { run: 'sleep 3600' }, accountId: account.id };
  const dir = path.join(home, 'userData', 'orchestra'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'store.json'), JSON.stringify({ repos: [repo], workspaces: [ws], accounts: [account], selfTuneRuns: [] }, null, 2));
  // Stub claude: the legacy agent PTY execs `claude` from PATH; a stub keeps the baseline
  // free of API calls. Stays a shell (not exec) so its cmdline names the stub for identity.
  const stubDir = path.join(home, 'stub-bin'); fs.mkdirSync(stubDir, { recursive: true });
  const stub = path.join(stubDir, 'claude');
  fs.writeFileSync(stub, '#!/bin/sh\necho AVR-STUB-CLAUDE "$@"\nsleep 3600\n', { mode: 0o755 });
  return { fakeHome, repoDir, wtDir, ws, account, stubDir, stub, storeFile: path.join(dir, 'store.json') };
}

async function bootApp(arm) {
  if (!APP_DIR) throw new Error('no <app-dir> given');
  const missing = ['RIG_WAYLAND', 'SWAYSOCK', 'ORCHESTRA_HOME', 'CLAUDE_CONFIG_DIR'].filter((k) => !process.env[k]);
  if (missing.length) throw new Error(`not launched via scripts/e2e-agent-view-removal.sh (missing ${missing.join(', ')})`);
  const home = path.join(RIG.base, `${arm}-${Date.now().toString(36)}`);
  fs.mkdirSync(home, { recursive: true });
  const world = seedWorld(home);
  const port = await freePort();
  const electron = process.env.E2E_ELECTRON
    ?? [path.join(APP_DIR, 'node_modules/electron/dist/electron'), path.join(path.dirname(new URL(import.meta.url).pathname), '../node_modules/electron/dist/electron')].find((p) => fs.existsSync(p));
  if (!electron) throw new Error('no electron binary (set E2E_ELECTRON)');

  // ALLOWLIST env, built as an object so the guard reads the very values the child gets.
  const env = {
    PATH: `${world.stubDir}:/usr/local/bin:/usr/bin:/bin`,
    HOME: world.fakeHome, XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid()}`,
    XDG_CONFIG_HOME: path.join(world.fakeHome, '.config'), XDG_CACHE_HOME: path.join(world.fakeHome, '.cache'),
    WAYLAND_DISPLAY: RIG.wayland, SWAYSOCK: RIG.swaysock, LANG: 'C.UTF-8',
    ELECTRON_OZONE_PLATFORM_HINT: 'wayland', ORCHESTRA_OZONE: 'wayland', ORCHESTRA_OZONE_RELAUNCHED: '1',
    ORCHESTRA_HOME: home, ORCHESTRA_DEBUG_PORT: String(port), ORCHESTRA_SELF_TUNE_CMD: '/bin/true',
    CLAUDE_CONFIG_DIR: RIG.cfg,
  };
  const pre = checkChildEnv(env, RIG.wayland);
  if (!pre.ok) throw new Error(`REFUSED before launch [${pre.clause}]: ${pre.detail}`);

  const log = fs.openSync(path.join(home, 'app.log'), 'w');
  const child = spawn(electron, [APP_DIR, '--ozone-platform=wayland'], { cwd: APP_DIR, env, stdio: ['ignore', log, log] });
  const app = { arm, home, port, child, pid: child.pid, env, world, electron, cdp: null, exited: false };
  child.on('exit', () => { app.exited = true; });

  const targets = await waitFor(`CDP target on :${port}`, async () => {
    if (app.exited) throw new Error(`electron exited early (see ${home}/app.log)`);
    try {
      const j = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      const t = j.filter((x) => x.type === 'page' && x.url.includes('dist/index.html'));
      return t.length ? t : null;
    } catch { return null; }
  }, 30000, 300);
  app.target = targets[0];
  app.cdp = await Cdp.connect(app.target.webSocketDebuggerUrl);
  await app.cdp.send('Page.enable');
  // the renderer must have mounted the toolbar (a workspace is active) before anything asserts
  return Object.assign(app, appApi(app));
}

function appApi(app) {
  const { cdp } = app;
  const api = {
    async tabs() {
      return cdp.eval(`(() => [...document.querySelectorAll('.toolbar .tabs .tab')].map(b => {
        const r = b.getBoundingClientRect();
        const label = [...b.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim();
        return { label, active: b.classList.contains('active'), visible: r.width > 0 && r.height > 0, cx: r.x + r.width / 2, cy: r.y + r.height / 2 };
      }))()`);
    },
    async ptys() {
      return cdp.eval(`window.orchestra.sampleResources().then(s => s.sessions.map(x => ({
        ptyId: x.ptyId, kind: x.kind, workspaceId: x.workspaceId, remote: x.remote,
        procCount: x.procCount, pids: (x.processes || []).map(p => p.pid) })))`);
    },
    async click(cx, cy) {
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: cx, y: cy });
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: cx, y: cy, button: 'left', clickCount: 1 });
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: cx, y: cy, button: 'left', clickCount: 1 });
      await sleep(120);
    },
    /** Trusted click on a rendered tab by label; hit-tests first so a covered button fails loudly. */
    async clickTab(label) {
      const t = (await api.tabs()).find((x) => x.label === label);
      if (!t || !t.visible) throw new Error(`tab '${label}' not rendered`);
      const hit = await cdp.eval(`(() => { const e = document.elementFromPoint(${t.cx}, ${t.cy}); const b = e && e.closest('.tab'); return b ? b.textContent.trim() : null; })()`);
      if (!hit || !hit.startsWith(label)) throw new Error(`hit-test for '${label}' landed on '${hit}'`);
      await api.click(t.cx, t.cy);
      await waitFor(`tab '${label}' active`, async () => (await api.tabs()).find((x) => x.label === label)?.active, 5000, 100);
    },
    async shot(name, clip) {
      const r = await cdp.send('Page.captureScreenshot', { format: 'png', ...(clip ? { clip: { ...clip, scale: 1 } } : {}) }, 15000);
      const file = path.join(app.home, `${name}.png`);
      fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
      return file;
    },
    /** Composed-window oracle: the compositor's own capture (grim on MY display), not the renderer's. */
    grim(name) {
      const file = path.join(app.home, `${name}.png`);
      execFileSync('grim', ['-o', 'HEADLESS-1', file], { env: { PATH: '/usr/bin:/bin', XDG_RUNTIME_DIR: app.env.XDG_RUNTIME_DIR, WAYLAND_DISPLAY: RIG.wayland }, timeout: 15000 });
      return file;
    },
    async close() {
      const pids = descendants(app.pid).map((p) => ({ p, s: procStart(p) }));
      app.cdp?.close();
      try { process.kill(app.pid, 'SIGTERM'); } catch { /* gone */ }
      await waitFor('electron exit', () => app.exited, 8000, 200).catch(() => { try { process.kill(app.pid, 'SIGKILL'); } catch { /* */ } });
      await sleep(500);
      // Survivors, by (pid,start-time) so a recycled pid is never signalled.
      for (const { p, s } of pids) if (procStart(p) === s && s !== null) { try { process.kill(p, 'SIGKILL'); } catch { /* */ } }
      // Anything else still carrying THIS boot's ORCHESTRA_HOME in its env (detached daemons).
      for (const d of fs.readdirSync('/proc')) {
        if (!/^\d+$/.test(d)) continue;
        try { if (procEnv(d).ORCHESTRA_HOME === app.home) process.kill(Number(d), 'SIGKILL'); } catch { /* not ours / gone */ }
      }
    },
  };
  return api;
}

const md5f = (f) => crypto.createHash('md5').update(fs.readFileSync(f)).digest('hex').slice(0, 12);
/** Read off the build on disk — printed before ANY arm, including the no-boot ones. */
function staticIdentity() {
  const pkgVersion = JSON.parse(fs.readFileSync(path.join(APP_DIR, 'package.json'), 'utf8')).version;
  const chunk = (fs.readFileSync(path.join(APP_DIR, 'dist-electron/main.js'), 'utf8').match(/require\(["']\.\/([^"']+)["']\)/) ?? [])[1];
  let gitInfo = 'no-git';
  try {
    const sha = execFileSync('git', ['-C', APP_DIR, 'rev-parse', '--short=8', 'HEAD'], { encoding: 'utf8' }).trim();
    const dirty = execFileSync('git', ['-C', APP_DIR, 'status', '--porcelain', '--untracked-files=no'], { encoding: 'utf8' }).split('\n').filter(Boolean).length;
    gitInfo = `${sha}${dirty ? `+${dirty}dirty` : ''}`;
  } catch { /* not a git checkout */ }
  const assets = path.join(APP_DIR, 'dist/assets');
  const rendererFiles = fs.existsSync(assets) ? fs.readdirSync(assets).filter((f) => /^index-.*\.js$/.test(f)).map((f) => `${f}:${md5f(path.join(assets, f))}`) : [];
  return { pkgVersion, chunk, gitInfo, rendererFiles, mainMd5: chunk ? md5f(path.join(APP_DIR, 'dist-electron', chunk)) : '?' };
}
/** Printed FIRST, before any clause of the arm: what is actually running. */
async function identityAndIsolation(ctx, app) {
  const runningVersion = await app.cdp.eval('window.orchestra.getAppVersion()');
  const sid = staticIdentity(); const pkgVersion = sid.pkgVersion;
  const scripts = await app.cdp.eval(`[...document.scripts].map(s => s.src).filter(Boolean)`);
  const paths = scripts.map((u) => decodeURIComponent(new URL(u).pathname));
  const bundle = paths.find((p) => p.includes('/assets/index-') && p.endsWith('.js')) ?? paths[0] ?? '';
  console.log(`IDENTITY  arm=${ctx.arm} mode=${MODE} app-dir=${APP_DIR} git=${sid.gitInfo} version(running)=${runningVersion} version(package.json)=${pkgVersion}`);
  console.log(`          target-url=${app.target.url}`);
  console.log(`          loaded-renderer-bundle=${path.basename(bundle)} md5=${md5f(bundle)}  main=${sid.chunk ?? '?'} md5=${sid.mainMd5}  electron=${app.electron}`);
  ctx.clause('identity/version', runningVersion === pkgVersion, `running=${runningVersion} package.json=${pkgVersion}`);
  ctx.clause('identity/target-is-this-build', app.target.url.includes(APP_DIR) && !app.target.url.includes('app.asar'), app.target.url);

  // isolation: read back from the RUNNING child, not from the array we built
  const live = procEnv(app.pid);
  const g = checkChildEnv(live, RIG.wayland);
  ctx.clause(`isolation/${g.clause}`, g.ok, `(read back from /proc/${app.pid}/environ) ${g.detail}`);
  ctx.clause('isolation/orchestra-home', live.ORCHESTRA_HOME === app.home && !app.home.startsWith(path.join(REAL_HOME, '.orchestra') + path.sep) && live.ORCHESTRA_HOME !== path.join(REAL_HOME, '.orchestra'),
    `ORCHESTRA_HOME=${live.ORCHESTRA_HOME}`);
  const fstype = execFileSync('findmnt', ['-no', 'FSTYPE', '-T', app.home], { encoding: 'utf8' }).trim();
  ctx.clause('isolation/home-not-tmpfs', fstype !== 'tmpfs' && !app.home.startsWith('/tmp/'), `fstype=${fstype}`);
  const inSway = await waitFor('app window in MY sway tree', () => {
    try {
      const tree = execFileSync('swaymsg', ['-t', 'get_tree'], { env: { PATH: '/usr/bin:/bin', SWAYSOCK: RIG.swaysock }, encoding: 'utf8' });
      const has = (n) => n.pid === app.pid || (n.nodes ?? []).some(has) || (n.floating_nodes ?? []).some(has);
      return has(JSON.parse(tree)) ? true : null;
    } catch { return null; }
  }, 20000, 500).catch(() => false);
  ctx.clause('isolation/window-in-my-sway', inSway, `app pid ${app.pid} in get_tree of SWAYSOCK=${RIG.swaysock}`);
  ctx.clause('isolation/pinned-account', app.world.ws.accountId === app.world.account.id && app.world.account.configDir === RIG.cfg,
    `ws.accountId=${app.world.ws.accountId} account.id=${app.world.account.id} configDir=${app.world.account.configDir}`);
}

/** The seeded workspace is auto-activated at boot; wait until its toolbar tabs are rendered. */
async function ready(app) {
  await waitFor('toolbar tabs rendered', async () => (await app.tabs()).length > 0, 30000, 300).catch(async (e) => {
    throw new Error(`${e.message} — DOM: ${await app.cdp.eval('document.body.innerText.slice(0,300)')}`);
  });
}

// ── arms ─────────────────────────────────────────────────────────────────────
const kindsOf = (ps) => ps.reduce((m, p) => ((m[p.kind] = (m[p.kind] ?? 0) + 1), m), {});
const fmtP = (ps) => (ps.length ? ps.map((p) => `${p.ptyId}[${p.kind}]`).join(',') : '∅');

/** Positive control: the Run tab → ▶ Run must make a run-kind PTY appear. Idempotent per boot. */
async function runControl(ctx) {
  const { app } = ctx; const wsId = app.world.ws.id;
  if (ctx.controls.run) return true;
  const pre = await app.ptys();
  let post = null, why = '';
  try {
    await app.clickTab('Run');
    const btn = await waitFor('▶ Run button', () => app.cdp.eval(`(() => { const b = document.querySelector('.run-action.start'); if (!b) return null; const r = b.getBoundingClientRect(); return { cx: r.x + r.width / 2, cy: r.y + r.height / 2 }; })()`), 10000);
    await app.click(btn.cx, btn.cy);
    post = await waitFor(`run-kind PTY ${wsId}:run`, async () => { const ps = await app.ptys(); return ps.some((p) => p.ptyId === `${wsId}:run` && p.kind === 'run') ? ps : null; }, 15000, 250);
  } catch (e) { why = e.message; }
  const fired = !!post && !pre.some((p) => p.ptyId === `${wsId}:run`);
  ctx.clause('control/run-pty-appears', fired, `pre=${fmtP(pre)} -> post=${post ? fmtP(post) : `NO run PTY appeared (${why})`}`);
  ctx.controls.run = fired;
  return fired;
}
/** A "no agent PTY" claim: REFUSED unless the positive control fired in this boot. */
function noAgentPty(ctx, name, ps) {
  if (!ctx.controls.run) return ctx.clause(name, false, 'REFUSED: Run-tab positive control did not fire in this boot — the listing is unproven');
  const agent = ps.filter((p) => p.kind === 'agent');
  return ctx.clause(name, agent.length === 0, `agent-kind PTYs=${agent.length} (${fmtP(ps)})`);
}

const ARMS = [
  {
    name: 'guard_selftest', boots: false, ticket: '#225',
    doc: 'isolation guard can FAIL: wayland-1 / sibling display / X11 DISPLAY / unset each refused with the NAMED clause; a good env passes',
    async run(ctx) {
      const mine = 'wayland-7';
      const cases = [
        [{ WAYLAND_DISPLAY: 'wayland-1' }, 'refuse-wayland-1', false],
        [{ WAYLAND_DISPLAY: 'wayland-1' }, 'refuse-wayland-1', false, 'wayland-1'], // mine==wayland-1: the refusal must STILL fire first
        [{ WAYLAND_DISPLAY: 'wayland-3' }, 'not-my-compositor', false],
        [{ WAYLAND_DISPLAY: mine, DISPLAY: ':0' }, 'x11-display-set', false],
        [{}, 'no-wayland-display', false],
        [{ WAYLAND_DISPLAY: mine }, 'display-isolated', true],
      ];
      for (const [env, want, ok, m] of cases) {
        const r = checkChildEnv(env, m ?? mine);
        ctx.clause(`${want}${m ? '-even-if-mine' : ''}`, r.ok === ok && r.clause === want, `forced ${JSON.stringify(env)} -> ok=${r.ok} clause=${r.clause}`);
      }
    },
  },
  {
    name: 'pixel_selftest', boots: false, ticket: '#225',
    doc: 'the PNG instrument can tell blank from painted: encode PNGs using every filter type, decode them exactly, and apply the SAME painted-vs-blank predicate the content arm gates on',
    async run(ctx) {
      const paeth = (a, b, c) => { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); return pa <= pb && pa <= pc ? a : pb <= pc ? b : c; };
      const enc = (w, h, pix, filters) => {
        const stride = w * 3, rows = [];
        for (let y = 0; y < h; y++) {
          const f = filters[y % filters.length]; rows.push(Buffer.from([f]));
          const row = Buffer.alloc(stride);
          for (let x = 0; x < stride; x++) {
            const a = x >= 3 ? pix[y * stride + x - 3] : 0, b = y ? pix[(y - 1) * stride + x] : 0, c = x >= 3 && y ? pix[(y - 1) * stride + x - 3] : 0;
            const pred = f === 0 ? 0 : f === 1 ? a : f === 2 ? b : f === 3 ? (a + b) >> 1 : paeth(a, b, c);
            row[x] = (pix[y * stride + x] - pred) & 255;
          }
          rows.push(row);
        }
        const chunk = (t, d) => { const h4 = Buffer.alloc(8); h4.writeUInt32BE(d.length, 0); h4.write(t, 4, 'latin1'); const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(Buffer.concat([h4.subarray(4), d])) >>> 0); return Buffer.concat([h4, d, crc]); };
        const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
        return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))]);
      };
      // (1) exact round-trip over all five filter types on non-trivial pixels
      const w = 9, h = 10, pix = Buffer.alloc(w * h * 3); let seed = 12345;
      for (let i = 0; i < pix.length; i++) { seed = (seed * 1103515245 + 12345) & 0x7fffffff; pix[i] = seed >> 16 & 255; }
      const back = decodePng(enc(w, h, pix, [0, 1, 2, 3, 4]));
      ctx.clause('decode-roundtrip-all-filters', back.w === w && back.h === h && Buffer.compare(back.px, pix) === 0, `${w}x${h} pseudo-random pixels, filters 0-4 cycled: exact=${Buffer.compare(back.px, pix) === 0}`);
      // (2) blank frame reads exactly blank; (3) a frame with 5 painted 2x2 blocks reads exactly 5%
      const flat = (n, fill) => { const b = Buffer.alloc(20 * 20 * 3); for (let i = 0; i < b.length; i += 3) { b[i] = fill[0]; b[i + 1] = fill[1]; b[i + 2] = fill[2]; } return b; };
      const blankPx = flat(20, [26, 31, 38]), paintedPx = Buffer.from(blankPx);
      [[0, 0, [255, 0, 0]], [4, 4, [0, 255, 0]], [8, 8, [0, 0, 255]], [12, 12, [255, 255, 0]], [16, 16, [0, 255, 255]]].forEach(([x0, y0, c]) => { for (let y = y0; y < y0 + 2; y++) for (let x = x0; x < x0 + 2; x++) paintedPx.set(c, (y * 20 + x) * 3); });
      const B = pngStats(enc(20, 20, blankPx, [1, 4])), C = pngStats(enc(20, 20, paintedPx, [2, 3]));
      ctx.clause('blank-reads-blank', B.distinct === 1 && B.nonBgPct === 0, `distinct=${B.distinct} nonBg=${B.nonBgPct}%`);
      ctx.clause('painted-reads-painted', C.distinct === 6 && C.nonBgPct === 5, `distinct=${C.distinct} nonBg=${C.nonBgPct}% (5 blocks of 4px in 400 = 5%)`);
      ctx.clause('predicate-accepts-painted', paintedBeyondBlank(C, B) === true, 'painted vs blank -> true');
      ctx.clause('predicate-rejects-blank', paintedBeyondBlank(B, B) === false && paintedBeyondBlank(B, C) === false, 'blank vs blank -> false, blank vs painted -> false (a no-op frame cannot pass)');
      let threw = ''; try { decodePng(Buffer.from('not a png at all, sorry')); } catch (e) { threw = e.message; }
      ctx.clause('garbage-rejected', threw === 'not a PNG', `decodePng(garbage) threw '${threw}'`);
    },
  },
  {
    name: 'observe', boots: true, ticket: '#225',
    doc: 'record what the app shows on boot: rendered tab labels + live PTY sessions by kind (no assertion beyond identity/isolation)',
    async run(ctx) {
      const tabs = await ctx.app.tabs(); const ps = await ctx.app.ptys();
      console.log(`OBSERVED  tabs=${JSON.stringify(tabs.map((t) => t.label + (t.active ? '*' : '')))} ptys=${fmtP(ps)} kinds=${JSON.stringify(kindsOf(ps))}`);
    },
  },
  {
    name: 'control_run_pty', boots: true, ticket: '#225',
    doc: 'positive control: opening Run (+ ▶ Run) makes a run-kind PTY appear — proves the listing can see PTYs',
    async run(ctx) { await runControl(ctx); },
  },
  {
    name: 'tabs', boots: true, ticket: '#225',
    doc: 'rendered tab labels, in order (baseline Raw·Run·Structured·Diff; after Agent·Run·Diff) + default-active tab',
    async run(ctx) {
      const tabs = await ctx.app.tabs(); const labels = tabs.map((t) => t.label);
      const want = pick(EXPECT.tabs);
      ctx.clause('tab-labels', JSON.stringify(labels) === JSON.stringify(want), `rendered=${JSON.stringify(labels)} expected(${MODE})=${JSON.stringify(want)}`);
      ctx.clause('all-tabs-visible', tabs.length > 0 && tabs.every((t) => t.visible), `visible=${tabs.map((t) => t.visible)}`);
      const active = tabs.find((t) => t.active)?.label;
      ctx.clause('opens-on-agent-view', active === pick(EXPECT.agentTab), `active=${active} expected=${pick(EXPECT.agentTab)}`);
      ctx.clause('raw-tab', labels.includes('Raw') === (MODE === 'baseline'), `Raw present=${labels.includes('Raw')} expected(${MODE})=${MODE === 'baseline'}`);
    },
  },
  {
    name: 'open_tabs_agent_pty', boots: true, ticket: '#225',
    doc: 'opening each tab: baseline Raw creates an agent-kind PTY, every other tab creates none; after — NO tab creates one (gated on the Run-tab control)',
    async run(ctx) {
      const { app } = ctx; const wsId = app.world.ws.id;
      await runControl(ctx);
      const pre = await app.ptys();
      noAgentPty(ctx, 'pre-state-no-agent-pty', pre);
      const labels = (await app.tabs()).map((t) => t.label);
      for (const label of labels.filter((l) => l !== 'Raw')) {
        await app.clickTab(label);
        await sleep(ABSENCE_MS);
        noAgentPty(ctx, `tab:${label}:no-agent-pty`, await app.ptys());
      }
      if (labels.includes('Raw')) {
        await app.clickTab('Raw');
        const post = await waitFor(`agent-kind PTY ${wsId}`, async () => { const ps = await app.ptys(); return ps.some((p) => p.ptyId === wsId && p.kind === 'agent') ? ps : null; }, 20000, 300).catch(() => null);
        ctx.clause('tab:Raw:creates-agent-pty', !!post === pick(EXPECT.rawCreatesAgentPty), `pre=${fmtP(pre)} -> post=${post ? fmtP(post) : 'NO agent PTY appeared'} expected(${MODE})=${pick(EXPECT.rawCreatesAgentPty)}`);
        if (post) {
          const agent = post.find((p) => p.kind === 'agent');
          const cmds = agent.pids.map(procCmdline);
          ctx.clause('tab:Raw:agent-pty-is-the-stub', cmds.some((c) => c.includes(app.world.stub)), `no real claude was started; PTY tree cmdlines=${JSON.stringify(cmds.slice(0, 3))}`);
        }
      } else {
        ctx.clause('tab:Raw:creates-agent-pty', pick(EXPECT.rawCreatesAgentPty) === false, 'no Raw tab rendered, so nothing to open');
      }
      const end = await app.ptys();
      if (MODE === 'baseline') ctx.clause('end-state-agent-pty', end.filter((p) => p.kind === 'agent').length === 1, `baseline: Raw left exactly one agent-kind PTY (${fmtP(end)})`);
      else noAgentPty(ctx, 'end-state-agent-pty', end);
    },
  },
  {
    name: 'agent_view_content', boots: true, ticket: '#225',
    doc: 'the Agent view renders REAL content (injected through the real fold path: user + assistant rows visible) + a screenshot read back off disk and asserted on its decoded pixels',
    async run(ctx) {
      const { app } = ctx; const wsId = app.world.ws.id;
      const want = pick(EXPECT.agentTab);
      const labels = (await app.tabs()).map((t) => t.label);
      ctx.clause('agent-tab-rendered', labels.includes(want), `'${want}' in ${JSON.stringify(labels)}`);
      await app.clickTab(labels.includes(want) ? want : ['Structured', 'Agent'].find((l) => labels.includes(l))); // keep going on a broken build: report, don't abort
      // The message-list region: the pane the content must paint into (crop = not diluted by sidebar/composer).
      const rect = await waitFor('agent message list', () => app.cdp.eval(`(() => { const e = document.querySelector('.av-message-list'); if (!e) return null; const r = e.getBoundingClientRect(); return r.width > 200 && r.height > 200 ? { x: r.x, y: r.y, width: r.width, height: r.height } : null; })()`), 10000);
      const settle = () => app.cdp.eval('document.fonts.ready.then(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))))').then(() => sleep(300));
      await settle();
      const emptyFile = await app.shot('agent-view-empty', rect);
      const now = Date.now();
      const evs = [
        { type: 'user-message', seq: 1, at: now, text: SENTINEL_USER },
        { type: 'block-start', seq: 2, at: now + 1, index: 0, kind: 'text' },
        { type: 'text-delta', seq: 3, at: now + 2, index: 0, text: SENTINEL_ASSISTANT },
        { type: 'block-stop', seq: 4, at: now + 3, index: 0 },
        { type: 'turn-end', seq: 5, at: now + 4, isError: false, stopReason: 'end_turn', numTurns: 1, costUsd: null, usage: null, resultText: SENTINEL_ASSISTANT, sessionId: 'avr-sess', durationMs: 1 },
      ];
      await app.cdp.eval(`(${JSON.stringify(evs)}).forEach(e => window.__injectAgentEvent(${JSON.stringify(wsId)}, e))`);
      const seen = await waitFor('injected rows rendered', () => app.cdp.eval(`(() => {
        const vis = (t) => { const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT); let n; while ((n = w.nextNode())) { if (n.textContent.includes(t)) { const e = n.parentElement, r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < innerHeight && e.checkVisibility(); } } return false; };
        return vis(${JSON.stringify(SENTINEL_USER)}) && vis(${JSON.stringify(SENTINEL_ASSISTANT)});
      })()`), 10000, 200).catch(() => false);
      ctx.clause('rows-rendered-and-visible', seen, 'user + assistant sentinels are in visible elements (DOM oracle — blind to paint, hence the pixels below)');
      ctx.clause('composer-present', await app.cdp.eval(`!!document.querySelector('.cm-editor, .av-composer, textarea')`), 'a composer element is in the DOM');
      await settle();
      const contentFile = await app.shot('agent-view-content', rect);
      // Blank POPULATION for the threshold: same region with the pane's rows hidden (a real "painted nothing" frame).
      await app.cdp.eval(`(() => { const s = document.createElement('style'); s.id = 'avr-blank'; s.textContent = '.av-message-list > * { visibility: hidden !important }'; document.head.appendChild(s); })()`);
      await settle();
      const blankFile = await app.shot('agent-view-blank', rect);
      await app.cdp.eval(`document.getElementById('avr-blank').remove()`);
      // READ BACK off disk: assert on the bytes of the files we report, not the in-memory buffers.
      const rd = (f) => { const b = fs.readFileSync(f); return { f, md5: crypto.createHash('md5').update(b).digest('hex'), ...pngStats(b) }; };
      const [E, C, B] = [rd(emptyFile), rd(contentFile), rd(blankFile)];
      for (const [n, x] of [['empty-state', E], ['content', C], ['blank', B]]) console.log(`SHOT      ${n.padEnd(11)} ${x.f} md5=${x.md5} ${x.w}x${x.h} bytes=${x.bytes} distinct=${x.distinct} nonBg=${x.nonBgPct}%`);
      const distinct3 = new Set([E.md5, C.md5, B.md5]).size === 3;
      ctx.clause('screenshots-distinct', distinct3, `md5 empty=${E.md5.slice(0, 8)} content=${C.md5.slice(0, 8)} blank=${B.md5.slice(0, 8)} (a no-op step would collide)`);
      // Threshold sits BETWEEN the two observed populations: blank (nothing painted) vs content.
      ctx.clause('content-painted-not-blank', paintedBeyondBlank(C, B), `content nonBg=${C.nonBgPct}% distinct=${C.distinct} vs blank nonBg=${B.nonBgPct}% distinct=${B.distinct} (need > +0.05pp and > +4 colours)`);
      // Composed-window oracle: what the compositor actually shows of the whole app.
      const G = rd(app.grim('compositor-grim'));
      console.log(`SHOT      compositor  ${G.f} md5=${G.md5} ${G.w}x${G.h} bytes=${G.bytes} distinct=${G.distinct} nonBg=${G.nonBgPct}%`);
      ctx.clause('compositor-shows-app', G.distinct >= 12 && G.nonBgPct >= 1, `grim on ${RIG.wayland}: distinct=${G.distinct} nonBg=${G.nonBgPct}% (thresholds >=12 colours, >=1%)`);
    },
  },
];

// ── driver ───────────────────────────────────────────────────────────────────
async function main() {
  if (LIST) {
    for (const a of ARMS) console.log(`${a.name.padEnd(22)} ${a.boots ? 'boots ' : 'no-boot'} ${a.ticket}  ${a.doc}`);
    process.exit(0);
  }
  if (!APP_DIR) { console.error('usage: e2e-agent-view-removal.sh <app-dir> [--mode baseline|after] [--arm a,b] [--list] [--broken-control]'); process.exit(2); }
  const sel = ARM_SEL ? ARM_SEL.split(',') : ARMS.map((a) => a.name);
  const unknown = sel.filter((n) => !ARMS.some((a) => a.name === n));
  if (unknown.length) { console.error(`unknown arm(s): ${unknown.join(', ')} — try --list`); process.exit(2); }
  console.log(`RIG agent-view-removal mode=${MODE} arms=${sel.join(',')} app-dir=${APP_DIR}`);
  const sid = staticIdentity();
  console.log(`IDENTITY(static) git=${sid.gitInfo} version(package.json)=${sid.pkgVersion} main=${sid.chunk ?? '?'} md5=${sid.mainMd5} renderer=${sid.rendererFiles.join(',')}`);
  for (const arm of ARMS.filter((a) => sel.includes(a.name))) {
    const ctx = makeCtx(arm.name);
    console.log(`--- arm ${arm.name}: ${arm.doc}`);
    try {
      if (arm.boots) {
        ctx.app = await bootApp(arm.name);
        try {
          await identityAndIsolation(ctx, ctx.app);
          await ready(ctx.app);
          await arm.run(ctx);
        } finally { await ctx.app.close(); }
      } else await arm.run(ctx);
    } catch (e) {
      ctx.clause('arm-completed', false, `HARNESS-ERROR ${e.message}`);
    }
  }
  const fail = RESULTS.filter((r) => !r.ok).length, pass = RESULTS.length - fail;
  const out = path.join(RIG.rigDir || os.tmpdir(), `result-${MODE}.json`);
  fs.writeFileSync(out, JSON.stringify({ mode: MODE, appDir: APP_DIR, results: RESULTS }, null, 2));
  console.log(`RIG-RESULT mode=${MODE} arms=${sel.length} clauses=${RESULTS.length} pass=${pass} fail=${fail} artifact=${out}`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(`RIG-RESULT HARNESS-ERROR ${e.stack ?? e}`); process.exit(2); });
