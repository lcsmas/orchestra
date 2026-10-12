// #374 — the desktop structured view shows ONE line per tool, like the phone: glyph (… running / ✓ ok / red ✗ failed) + the phone's label,
// consecutive lines in one compact block; a click opens the tool's card, a second click closes it; TodoWrite keeps its standalone checklist.
//
// Boots a BUILT Orchestra (argv[2] = app dir) inside the contained rig's own headless sway, with a SCRATCH ORCHESTRA_HOME / HOME /
// CLAUDE_CONFIG_DIR and a stub `claude` (never the API), seeds a transcript holding an ok, a failed and a running tool (plus a TodoWrite)
// through the app's own event path (`__injectAgentEvent` → fold), and asserts BOTH halves:
//   STATE   DOM text / glyph / data-state / computed colours (resolved INSIDE the agent view) / aria-expanded, via TRUSTED clicks
//   PIXELS  the failed line's ✗ is painted red and the ok line's ✓ green in the renderer screenshot, and the compositor frame shows the page
// Clauses `L*` are the feature (must be RED on a master build); `ctl/*` positive controls and `G*` non-regression guards (TodoWrite stays standalone) must be GREEN on both.
//
// Usage (via scripts/e2e-tool-lines.sh): <app-dir> --live-home <real $HOME> [--out dir] [--label name] [--expect-red]
// --expect-red = the must-FAIL arm: exit 0 only if every L clause is RED and every control GREEN.
import { execFileSync, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const APP_DIR = argv[0] && !argv[0].startsWith('--') ? fs.realpathSync(argv[0]) : null;
const LIVE_HOME = flag('--live-home', null);
const LABEL = flag('--label', APP_DIR ? path.basename(APP_DIR) : 'app');
const EXPECT_RED = argv.includes('--expect-red');

const refuse = (m) => { console.log(`REFUSED: ${m}`); process.exit(3); };
if (!APP_DIR) refuse('no <app-dir>');
if (!LIVE_HOME) refuse('--live-home missing (needed to protect the live ~/.claude* and to prove nothing there moved)');
const RIG_DIR = process.env.RIG_DIR;
const RIG_WAYLAND = process.env.RIG_WAYLAND;
if (!RIG_DIR || !RIG_WAYLAND) refuse('RIG_DIR / RIG_WAYLAND unset — run via scripts/e2e-tool-lines.sh (the contained rig)');
if (process.env.DISPLAY) refuse(`X11 DISPLAY=${process.env.DISPLAY} is set — Electron would reach the human's screen`);
if (process.env.WAYLAND_DISPLAY !== RIG_WAYLAND || RIG_WAYLAND === 'wayland-1') refuse(`WAYLAND_DISPLAY=${process.env.WAYLAND_DISPLAY} != marker-verified ${RIG_WAYLAND}`);

const OUT = flag('--out', null) || path.join(RIG_DIR, 'shots'); // default = SCRATCH (inside the rig dir), never the live ~/.orchestra

// ── scratch-containment guard (live dirs are never handed to the app) ─────────────────────────────
const RIG_BASE = fs.realpathSync(path.dirname(RIG_DIR));
const liveReal = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
const LIVE_DIRS = [...fs.readdirSync(LIVE_HOME).filter((n) => n === '.claude' || n.startsWith('.claude-')).map((n) => path.join(LIVE_HOME, n)),
  path.join(LIVE_HOME, '.orchestra'), path.join(LIVE_HOME, '.config')].map(liveReal);
/** -> {ok, clause}. Live check FIRST so a live dir is refused for THAT reason, not merely "outside base". */
function checkScratch(p) {
  const r = liveReal(p);
  for (const l of LIVE_DIRS) if (r === l || r.startsWith(l + path.sep) || l.startsWith(r + path.sep)) return { ok: false, clause: 'live-dir' };
  if (!(r === RIG_BASE || r.startsWith(RIG_BASE + path.sep))) return { ok: false, clause: 'outside-rig-base' };
  return { ok: true, clause: 'scratch' };
}
const mustBeScratch = (what, p) => { const r = checkScratch(p); if (!r.ok) refuse(`${what}=${p} [${r.clause}]`); };
{ // the guard's own must-FAIL / must-PASS arms, each naming the clause that fired
  const a = checkScratch(path.join(LIVE_HOME, '.claude')), b = checkScratch('/tmp/not-in-the-rig'), c = checkScratch(path.join(RIG_DIR, 'x'));
  if (a.clause !== 'live-dir' || b.clause !== 'outside-rig-base' || !c.ok) refuse(`scratch guard self-test failed: ${JSON.stringify({ a, b, c })}`);
  console.log(`[guard] self-test: live ~/.claude -> ${a.clause} · /tmp path -> ${b.clause} · rig path -> ${c.clause}`);
}

// ── small helpers ─────────────────────────────────────────────────────────────────────────────────
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

// ── PNG decode (8-bit RGB/RGBA, non-interlaced — what Page.captureScreenshot emits) ──────────────
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
/** pixels whose RGB differs by > tol on any channel. Same-size images only. */
function diffPx(A, B, tol = 6) {
  if (A.w !== B.w || A.h !== B.h || A.ch !== B.ch) throw new Error(`size mismatch ${A.w}x${A.h} vs ${B.w}x${B.h}`);
  let n = 0;
  for (let p = 0; p < A.w * A.h; p++) { const o = p * A.ch; if (Math.abs(A.data[o] - B.data[o]) > tol || Math.abs(A.data[o + 1] - B.data[o + 1]) > tol || Math.abs(A.data[o + 2] - B.data[o + 2]) > tol) n++; }
  return n;
}
/** sub-image [x,y,w,h] of a decoded PNG */
function crop(I, x, y, w, h) {
  const out = Buffer.alloc(w * h * I.ch);
  for (let r = 0; r < h; r++) I.data.copy(out, r * w * I.ch, ((y + r) * I.w + x) * I.ch, ((y + r) * I.w + x + w) * I.ch);
  return { w, h, ch: I.ch, data: out };
}
/** pixels that are not the clip's dominant colour = painted "ink" (text / borders / pills). */
function inkPx(I, tol = 6) {
  const cnt = new Map();
  for (let p = 0; p < I.w * I.h; p++) { const o = p * I.ch, k = (I.data[o] << 16) | (I.data[o + 1] << 8) | I.data[o + 2]; cnt.set(k, (cnt.get(k) || 0) + 1); }
  let mode = 0, best = -1; for (const [k, v] of cnt) if (v > best) { best = v; mode = k; }
  const mr = mode >> 16, mg = (mode >> 8) & 255, mb = mode & 255; let n = 0;
  for (let p = 0; p < I.w * I.h; p++) { const o = p * I.ch; if (Math.abs(I.data[o] - mr) > tol || Math.abs(I.data[o + 1] - mg) > tol || Math.abs(I.data[o + 2] - mb) > tol) n++; }
  return n;
}

// ── CDP ───────────────────────────────────────────────────────────────────────────────────────────
class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); ws.onmessage = (ev) => { const m = JSON.parse(ev.data); const p = m.id && this.pending.get(m.id); if (p) { this.pending.delete(m.id); m.error ? p.rej(new Error(`${m.error.message}`)) : p.res(m.result); } }; }
  static async connect(url) { const ws = new WebSocket(url); await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws error')); }); return new Cdp(ws); }
  send(method, params = {}, ms = 20000) {
    const id = ++this.id;
    return new Promise((res, rej) => { const t = setTimeout(() => { this.pending.delete(id); rej(new Error(`CDP ${method} timed out after ${ms}ms`)); }, ms); this.pending.set(id, { res: (v) => { clearTimeout(t); res(v); }, rej: (e) => { clearTimeout(t); rej(e); } }); this.ws.send(JSON.stringify({ id, method, params })); });
  }
  async eval(expr) { const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(`eval threw: ${r.exceptionDetails.text} ${r.exceptionDetails.exception?.description ?? ''}`); return r.result.value; }
  async click(x, y) { for (const [type, extra] of [['mouseMoved', {}], ['mousePressed', { button: 'left', clickCount: 1 }], ['mouseReleased', { button: 'left', clickCount: 1 }]]) { await this.send('Input.dispatchMouseEvent', { type, x, y, ...extra }); await sleep(60); } }
  async shot(clip) { const r = await this.send('Page.captureScreenshot', { format: 'png', ...(clip ? { clip: { ...clip, scale: 1 } } : {}) }, 25000); return Buffer.from(r.data, 'base64'); }
  close() { try { this.ws.close(); } catch {} }
}


// ── seeding: a real git repo + registered worktree (prune deletes what it cannot verify), the PINNED scratch account, a stub `claude` ──
const WS = 'ws-tl374-1';
function seedWorld(armDir) {
  const fakeHome = path.join(armDir, 'home'), ohome = path.join(armDir, 'oh'), cfg = path.join(armDir, 'claude-config');
  const repoDir = path.join(armDir, 'repo'), wtDir = path.join(armDir, 'wt', 'tl374-1');
  for (const d of [fakeHome, ohome, cfg, repoDir, path.dirname(wtDir)]) fs.mkdirSync(d, { recursive: true });
  for (const [k, v] of Object.entries({ HOME: fakeHome, ORCHESTRA_HOME: ohome, CLAUDE_CONFIG_DIR: cfg, repo: repoDir, wt: wtDir })) mustBeScratch(k, v);
  git(repoDir, ['init', '-q', '-b', 'main'], fakeHome);
  fs.writeFileSync(path.join(repoDir, 'README.md'), '# tl374 seed repo\n');
  git(repoDir, ['add', '.'], fakeHome); git(repoDir, ['commit', '-q', '-m', 'seed'], fakeHome);
  git(repoDir, ['worktree', 'add', '-q', '-b', 'e2e/tl374-1', wtDir], fakeHome);
  if (!git(repoDir, ['worktree', 'list', '--porcelain'], fakeHome).includes(`worktree ${fs.realpathSync(wtDir)}`)) throw new Error('seed worktree not registered');
  const account = { id: 'rig-tl374', label: 'rig (scratch config dir)', configDir: cfg };
  mustBeScratch('account.configDir', account.configDir);
  const ws = { id: WS, name: 'tl374-1', repoPath: repoDir, worktreePath: wtDir, branch: 'e2e/tl374-1', baseBranch: 'main', createdAt: Date.now(), status: 'idle', agent: 'claude', accountId: account.id };
  const dir = path.join(ohome, 'userData', 'orchestra'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'store.json'), JSON.stringify({ repos: [{ path: repoDir, name: 'tl374-repo', defaultBranch: 'main', accountId: account.id }], workspaces: [ws], accounts: [account], selfTuneRuns: [] }, null, 2));
  const stubDir = path.join(armDir, 'stub-bin'); fs.mkdirSync(stubDir, { recursive: true });
  fs.writeFileSync(path.join(stubDir, 'claude'), '#!/bin/sh\necho TL374-STUB-CLAUDE "$@"\nsleep 3600\n', { mode: 0o755 });
  return { fakeHome, ohome, cfg, account, ws, stubDir };
}

// The seeded transcript (events the app folds exactly as a live session's): text, an OK Bash, a FAILED Bash, a RUNNING Edit (no result yet),
// text, then a TodoWrite (standalone). The Edit carries a big old/new pair so a ±diff count on its line would be visible.
const SEED = {
  okLabel: 'Bash · run the suite', failLabel: 'Bash · grep -r nothing .', runLabel: 'Edit · shared/foo.ts', failOut: 'exit status 1 — nothing matched', okOut: 'all 42 green',
};
function seedEvents() {
  let seq = 1, idx = 0; const ev = [];
  const at = () => 1754300000000 + seq;
  const text = (t) => { const index = idx++; ev.push({ type: 'block-start', seq: seq++, at: at(), index, kind: 'text' }, { type: 'text-delta', seq: seq++, at: at(), index, text: t }, { type: 'block-stop', seq: seq++, at: at(), index }); };
  const tool = (id, name, input, result) => {
    const index = idx++;
    ev.push({ type: 'block-start', seq: seq++, at: at(), index, kind: 'tool_use', toolUseId: id, name }, { type: 'tool-use', seq: seq++, at: at(), index, toolUseId: id, name, input }, { type: 'block-stop', seq: seq++, at: at(), index });
    if (result) ev.push({ type: 'tool-result', seq: seq++, at: at(), toolUseId: id, content: result.content, isError: !!result.isError });
  };
  text('I will run the suite, grep for leftovers, then patch foo.ts.');
  tool('tu-ok', 'Bash', { command: 'pnpm test', description: 'run the suite' }, { content: SEED.okOut });
  tool('tu-fail', 'Bash', { command: 'grep -r nothing .' }, { content: SEED.failOut, isError: true });
  tool('tu-run', 'Edit', { file_path: '/repo/src/shared/foo.ts', old_string: 'a\nb\nc', new_string: 'a\nb\nc\nd\ne\nf\ng' });
  text('Now the plan.');
  tool('tu-todo', 'TodoWrite', { todos: [{ content: 'Patch foo.ts', status: 'in_progress', activeForm: 'Patching foo.ts' }, { content: 'Re-run the suite', status: 'pending', activeForm: 'Re-running the suite' }] }, { content: 'Todos updated' });
  return ev;
}

function listProcsByHome(home) { // identity = /proc/<pid>/environ carrying THIS arm's ORCHESTRA_HOME
  const out = [];
  for (const p of fs.readdirSync('/proc').filter((n) => /^\d+$/.test(n))) {
    try { const env = fs.readFileSync(`/proc/${p}/environ`, 'utf8').split('\0'); if (env.includes(`ORCHESTRA_HOME=${home}`)) out.push(+p); } catch {}
  }
  return out.filter((p) => p !== process.pid);
}

const results = []; // {arm, clause, ok, detail}
const shots = []; // {file, md5}
function clause(arm, name, ok, detail) { results.push({ arm, clause: name, ok: !!ok, detail }); console.log(`  ${ok ? 'PASS' : 'FAIL'}  [${arm}] ${name} — ${detail}`); }
function saveShot(name, buf) { fs.mkdirSync(OUT, { recursive: true }); const f = path.join(OUT, name); fs.writeFileSync(f, buf); shots.push({ file: f, md5: md5(buf) }); return f; }

// What the page shows for the tool block, read in ONE evaluation (null-safe: on a master build the lines simply do not exist).
const PROBE = `(() => {
  const R = (el) => { if (!el) return null; const b = el.getBoundingClientRect(); return { left: b.left, top: b.top, right: b.right, bottom: b.bottom, width: b.width, height: b.height }; };
  const view = document.querySelector('.av-message-list') || document.body;
  // --av-* tokens resolve only INSIDE the agent view: probe from a child of it, never document.body.
  const probe = (cssColor, host) => { const s = document.createElement('span'); s.style.color = cssColor; (host || view).appendChild(s); const c = getComputedStyle(s).color; s.remove(); return c; };
  const runs = [...document.querySelectorAll('.av-tool-run')];
  const lines = [...document.querySelectorAll('.av-tool-line')].map((l) => {
    const g = l.querySelector('.av-tool-line-glyph'), lab = l.querySelector('.av-tool-line-label'), head = l.querySelector('.av-tool-line-head');
    return { state: l.getAttribute('data-state'), toolId: l.getAttribute('data-tool-id'), glyph: g ? g.textContent : null, label: lab ? lab.textContent : null, text: l.querySelector('.av-tool-line-head') ? l.querySelector('.av-tool-line-head').textContent : null,
      glyphColor: g ? getComputedStyle(g).color : null, labelColor: lab ? getComputedStyle(lab).color : null, expanded: head ? head.getAttribute('aria-expanded') : null,
      card: !!l.querySelector('.av-tool-card'), cardText: l.querySelector('.av-tool-card') ? l.querySelector('.av-tool-card').textContent : '', glyphRect: R(g), headRect: R(head),
      sameBlock: runs.length === 1 && runs[0].contains(l) };
  });
  const todo = document.querySelector('.av-tool-todowrite');
  const runText = runs.map((r) => r.textContent).join(' | ');
  return { inner: { w: innerWidth, h: innerHeight }, dpr: devicePixelRatio, runs: runs.length, runRect: R(runs[0]), runText, lines,
    summary: /Used \\d+ tools?|Used a tool|Created |Ran (a|\\d+) |Read \\d+ files/.test(runText), diffCount: runs.some((r) => !!r.querySelector('.av-tool-run-diff, .av-diff-add, .av-diff-del')) || /[+−]\\d/.test(lines.map((l) => l.text || '').join(' ')),
    todo: todo ? { insideRun: !!todo.closest('.av-tool-run'), text: todo.textContent, rect: R(todo) } : null,
    colors: { error: probe('var(--av-error)'), add: probe('var(--av-add)'), active: probe('var(--av-tool-active)'), faint: probe('var(--av-text-faint)') },
    assistantText: document.body.innerText.includes('I will run the suite'), listPresent: !!document.querySelector('.av-message-list') };
})()`;

async function runArm() {
  const arm = LABEL, w = 1400, h = 900;
  console.log(`\n== arm ${arm}: output ${w}x${h} ==`);
  const armDir = path.join(RIG_DIR, `arm-${LABEL}`);
  fs.mkdirSync(armDir, { recursive: true });
  const world = seedWorld(armDir);
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
  const app = spawn(path.join(APP_DIR, 'node_modules/electron/dist/electron'), [APP_DIR, '--ozone-platform=wayland'], { cwd: APP_DIR, env, stdio: ['ignore', fd, fd], detached: true });
  console.log(`  app pid ${app.pid} port ${port} log ${logFile}`);
  let cdp;
  try {
    const target = await waitFor(async () => { const r = await fetch(`http://127.0.0.1:${port}/json`); const t = (await r.json()).find((x) => x.type === 'page' && x.url.includes('dist/index.html')); return t || null; }, 60000, 'the app page target');
    clause(arm, 'ctl/app-identity-path', target.url.includes(APP_DIR) && !target.url.includes('app.asar'), `target url ${target.url} ⊇ ${APP_DIR}`);
    cdp = await Cdp.connect(target.webSocketDebuggerUrl);
    await cdp.send('Page.enable');
    await waitFor(() => cdp.eval(`!!window.__orchestraSetState && !!window.__injectAgentEvent && !!document.querySelector(".toolbar")`), 60000, 'the toolbar + the test seams');
    // identity: the bundle the page executes is byte-identical to the one in APP_DIR/dist
    const src = await cdp.eval(`[...document.querySelectorAll('script[src]')].map((s) => s.src)`);
    const bundle = src.find((s) => /assets\/index-.*\.js/.test(s));
    const onDisk = bundle && path.join(APP_DIR, 'dist', bundle.split('/dist/')[1]);
    const frameId = (await cdp.send('Page.getResourceTree')).frameTree.frame.id;
    const rc_ = await cdp.send('Page.getResourceContent', { frameId, url: bundle });
    const served = Buffer.from(rc_.content, rc_.base64Encoded ? 'base64' : 'utf8');
    const ver = JSON.parse(fs.readFileSync(path.join(APP_DIR, 'package.json'), 'utf8')).version;
    clause(arm, 'ctl/app-identity-bundle', !!onDisk && fs.existsSync(onDisk) && md5(served) === md5(fs.readFileSync(onDisk)), `renderer bundle ${path.basename(bundle || '?')} as served md5 ${md5(served)} == file in app dir md5 ${onDisk && fs.existsSync(onDisk) ? md5(fs.readFileSync(onDisk)) : 'n/a'} (package.json ${ver})`);
    const environ = fs.readFileSync(`/proc/${app.pid}/environ`, 'utf8').split('\0');
    const ev = (k) => (environ.find((e) => e.startsWith(k + '=')) || '').slice(k.length + 1);
    clause(arm, 'ctl/scratch-env', ev('ORCHESTRA_HOME') === world.ohome && ev('CLAUDE_CONFIG_DIR') === world.cfg && ev('HOME') === world.fakeHome && !environ.some((e) => e.startsWith('DISPLAY=')) && ev('WAYLAND_DISPLAY') === RIG_WAYLAND,
      `app environ: ORCHESTRA_HOME=${ev('ORCHESTRA_HOME')} CLAUDE_CONFIG_DIR=${ev('CLAUDE_CONFIG_DIR')} WAYLAND_DISPLAY=${ev('WAYLAND_DISPLAY')} DISPLAY=${ev('DISPLAY') || '<unset>'}`);
    clause(arm, 'ctl/account-pinned', world.ws.accountId === world.account.id && world.account.configDir === world.cfg && world.cfg.startsWith(world.ohome.replace(/\/oh$/, '')), `workspace.accountId=${world.ws.accountId} == account.id=${world.account.id}; configDir=${world.account.configDir} (scratch)`);
    const tree = sh('swaymsg', ['-t', 'get_tree']);
    clause(arm, 'ctl/app-in-my-sway', new RegExp(`"pid":\\s*${app.pid}\\b`).test(tree), `app pid ${app.pid} present in my sway's get_tree`);

    // seed the structured view and the transcript through the app's own path
    const sessionBefore = await cdp.eval(`(window.__readAgentSession(${JSON.stringify(WS)}) || { messages: [] }).messages.length`);
    await cdp.eval(`window.__orchestraSetState(${JSON.stringify({ activeId: WS, view: 'structured' })}); 1`);
    await sleep(500);
    for (const e of seedEvents()) await cdp.eval(`window.__injectAgentEvent(${JSON.stringify(WS)}, ${JSON.stringify(e)}); 1`);
    await waitFor(() => cdp.eval(`document.querySelectorAll('.av-row').length >= 4`), 30000, 'the seeded rows to render');
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: h - 5 }); // park the cursor (no :hover residue)
    await sleep(800);
    await cdp.eval(`document.fonts.ready.then(() => true)`);
    const sess = await cdp.eval(`(() => { const s = window.__readAgentSession(${JSON.stringify(WS)}); return s ? s.messages.filter((m) => m.role === 'tool').map((m) => ({ name: m.toolUse && m.toolUse.name, result: !m.toolResult ? 'none' : m.toolResult.isError ? 'error' : 'ok' })) : null; })()`);
    clause(arm, 'ctl/transcript-seeded', JSON.stringify(sess) === JSON.stringify([{ name: 'Bash', result: 'ok' }, { name: 'Bash', result: 'error' }, { name: 'Edit', result: 'none' }, { name: 'TodoWrite', result: 'ok' }]) && sessionBefore === 0,
      `folded session had ${sessionBefore} messages before; tool messages after: ${JSON.stringify(sess)} (ok / failed / running + TodoWrite)`);

    const P = await cdp.eval(PROBE);
    clause(arm, 'ctl/structured-view-showing-the-seed', P.listPresent && P.assistantText && P.inner.w >= 1300, `.av-message-list present=${P.listPresent}; seeded assistant text in DOM=${P.assistantText}; viewport ${P.inner.w}x${P.inner.h} dpr ${P.dpr}`);
    console.log(`  probe: ${JSON.stringify({ runs: P.runs, lines: P.lines.map((l) => ({ s: l.state, g: l.glyph, l: l.label })), summary: P.summary, todo: P.todo && P.todo.insideRun })}`);
    const full = await cdp.shot();
    const fullFile = saveShot(`${LABEL}-lines-closed-renderer.png`, full);
    const grimFile = path.join(OUT, `${LABEL}-lines-closed-compositor.png`);
    fs.mkdirSync(OUT, { recursive: true });
    sh('grim', ['-o', 'HEADLESS-1', grimFile], { env: { PATH: '/usr/bin:/bin', XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR, WAYLAND_DISPLAY: RIG_WAYLAND } });
    shots.push({ file: grimFile, md5: md5(fs.readFileSync(grimFile)) });
    const grim = decodePng(fs.readFileSync(grimFile)), rend = decodePng(full);
    const region = P.runRect ? { x: Math.max(0, Math.floor(P.runRect.left)), y: Math.max(0, Math.floor(P.runRect.top)), w: Math.floor(Math.min(P.runRect.width, P.inner.w - P.runRect.left)), h: Math.max(8, Math.floor(P.runRect.height)) } : null;
    if (region) {
      const dComp = diffPx(crop(grim, region.x, region.y, region.w, region.h), crop(rend, region.x, region.y, region.w, region.h), 24);
      clause(arm, 'ctl/compositor-frame-is-the-page', grim.w === rend.w && grim.h === rend.h && inkPx(crop(grim, region.x, region.y, region.w, region.h)) > 40 && dComp <= region.w * region.h * 0.02,
        `grim ${grim.w}x${grim.h} vs renderer ${rend.w}x${rend.h}; tool-block crop ${region.w}x${region.h}: ${inkPx(crop(grim, region.x, region.y, region.w, region.h))} ink px, ${dComp} px differ from the renderer's (<= 2%)`);
    } else clause(arm, 'ctl/compositor-frame-is-the-page', false, 'no .av-tool-run block on the page');
    console.log(`  shots: ${fullFile}, ${grimFile}`);

    // ── the feature ──
    const [okL, failL, runL] = P.lines;
    clause(arm, 'L1/three-lines-in-one-compact-block', P.lines.length === 3 && P.runs === 1 && P.lines.every((l) => l.sameBlock), `${P.lines.length} .av-tool-line in ${P.runs} .av-tool-run block(s), all in that block: ${P.lines.map((l) => l.sameBlock)}`);
    const want = [['ok', '✓', SEED.okLabel], ['error', '✗', SEED.failLabel], ['running', '…', SEED.runLabel]];
    clause(arm, 'L2/glyph-and-label-of-each-line', P.lines.length === 3 && want.every(([s, g, lab], i) => P.lines[i].state === s && P.lines[i].glyph === g && P.lines[i].label === lab),
      `lines: ${P.lines.map((l) => `[${l.state}] "${l.glyph}" "${l.label}"`).join(' · ')} — wanted ${want.map(([s, g, lab]) => `[${s}] "${g}" "${lab}"`).join(' · ')}`);
    clause(arm, 'L3/failed-line-is-red-others-are-not', !!failL && failL.glyphColor === P.colors.error && failL.labelColor === P.colors.error && okL.glyphColor === P.colors.add && okL.glyphColor !== P.colors.error && okL.labelColor !== P.colors.error && runL.glyphColor === P.colors.active,
      `failed glyph ${failL?.glyphColor} label ${failL?.labelColor} vs --av-error ${P.colors.error}; ok glyph ${okL?.glyphColor} vs --av-add ${P.colors.add} (label ${okL?.labelColor}); running glyph ${runL?.glyphColor} vs --av-tool-active ${P.colors.active}`);
    clause(arm, 'L4/no-summary-no-diff-count', P.runs >= 1 && !P.summary && !P.diffCount && runL?.text === `…${SEED.runLabel}`, `block text "${P.runText.slice(0, 120)}" — summary verb=${P.summary}, ±diff count=${P.diffCount}; Edit line text "${runL?.text}"`);
    clause(arm, 'G6/todowrite-stays-standalone', !!P.todo && !P.todo.insideRun && /Patching foo\.ts/.test(P.todo.text) && /Re-run the suite/.test(P.todo.text), `TodoWrite card ${P.todo ? `present outside the block (insideRun=${P.todo.insideRun}), checklist text "${P.todo.text.slice(0, 60)}"` : 'ABSENT'}`);
    // pixels: the glyph's own rect, in the renderer screenshot
    const hue = (I, r, test) => { if (!r) return -1; const c = crop(I, Math.max(0, Math.floor(r.left)), Math.max(0, Math.floor(r.top)), Math.max(1, Math.floor(r.width)), Math.max(1, Math.floor(r.height))); let n = 0; for (let p = 0; p < c.w * c.h; p++) { const o = p * c.ch; if (test(c.data[o], c.data[o + 1], c.data[o + 2])) n++; } return n; };
    const isRed = (r, g, b) => r > 150 && r - Math.max(g, b) > 70, isGreen = (r, g, b) => g > 140 && g - r > 50 && g - b > 20;
    const px = { failRed: hue(rend, failL?.glyphRect, isRed), failGreen: hue(rend, failL?.glyphRect, isGreen), okGreen: hue(rend, okL?.glyphRect, isGreen), okRed: hue(rend, okL?.glyphRect, isRed), runRed: hue(rend, runL?.glyphRect, isRed) };
    clause(arm, 'L7/pixels-red-cross-green-tick', px.failRed >= 5 && px.failGreen === 0 && px.okGreen >= 5 && px.okRed === 0 && px.runRed === 0, `renderer pixels in the glyph rects: ✗ red ${px.failRed} / green ${px.failGreen}; ✓ green ${px.okGreen} / red ${px.okRed}; … red ${px.runRed} (need ✗ red ≥5 & no green, ✓ green ≥5 & no red)`);

    // click opens the card, a second click closes it — TRUSTED input. Two lines: the FAILED one (its card defaults open anyway) and the OK
    // Bash one (a card that is closed by default — only `startOpen` shows its output at once).
    const toggle = async (line) => {
      const hr = line.headRect, cx = hr.left + Math.min(hr.width / 2, 120), cy = hr.top + hr.height / 2;
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: cx, y: cy });
      await cdp.click(cx, cy);
      await sleep(500);
    };
    const lineNow = async (i) => (await cdp.eval(PROBE)).lines[i];
    const park = async () => { await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: h - 5 }); await sleep(300); };
    const seq = {};
    for (const [name, i, out] of [['fail', 1, SEED.failOut], ['ok', 0, SEED.okOut]]) {
      const pre = await lineNow(i);
      if (!pre) { seq[name] = null; continue; }
      await toggle(pre);
      const opened = await lineNow(i);
      await park();
      saveShot(`${LABEL}-lines-${name}-opened-renderer.png`, await cdp.shot());
      await toggle(opened || pre);
      const closed = await lineNow(i);
      await park();
      seq[name] = { pre, opened, closed, out };
    }
    const okSeq = (q) => !!q && !q.pre.card && q.pre.expanded === 'false' && !!q.opened && q.opened.card && q.opened.expanded === 'true' && q.opened.cardText.includes(q.out) && !!q.closed && !q.closed.card && q.closed.expanded === 'false';
    const fmtSeq = (n, q) => `${n}: card ${q?.pre?.card}/aria-expanded ${q?.pre?.expanded} -> click -> ${q?.opened?.card}/${q?.opened?.expanded} shows "${q?.out}"=${!!q?.opened && q.opened.cardText.includes(q.out)} -> click -> ${q?.closed?.card}/${q?.closed?.expanded}`;
    clause(arm, 'L5/click-opens-the-card-second-click-closes-it', okSeq(seq.fail) && okSeq(seq.ok), `${fmtSeq('failed line', seq.fail)}; ${fmtSeq('ok line', seq.ok)}`);

    // the LIVE transition: the running Edit's result lands through the app's own event path → the same line flips … → ✓ (ToolGroup's memo must see it)
    const beforeFlip = (await cdp.eval(PROBE)).lines[2];
    await cdp.eval(`window.__injectAgentEvent(${JSON.stringify(WS)}, ${JSON.stringify({ type: 'tool-result', seq: 9000, at: 1754300009000, toolUseId: 'tu-run', content: 'edited', isError: false })}); 1`);
    await sleep(900);
    const afterFlip = await lineNow(2);
    clause(arm, 'L8/running-line-flips-to-ok-when-its-result-lands', !!beforeFlip && !!afterFlip && beforeFlip.state === 'running' && beforeFlip.glyph === '…' && afterFlip.state === 'ok' && afterFlip.glyph === '✓' && afterFlip.label === beforeFlip.label && afterFlip.glyphColor === P.colors.add,
      `Edit line before: [${beforeFlip?.state}] "${beforeFlip?.glyph}" -> after the tool-result event: [${afterFlip?.state}] "${afterFlip?.glyph}" colour ${afterFlip?.glyphColor} (--av-add ${P.colors.add}); label kept "${afterFlip?.label}"`);

    fs.writeFileSync(path.join(OUT, `${LABEL}-probe.json`), JSON.stringify({ P, px, seq }, null, 2));
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

// ── live-dir canary: independent tool (find) + json, before/after ─────────────────────────────────
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
const before = liveCanary();
console.log(`[rig] app ${APP_DIR} label ${LABEL} expect-red=${EXPECT_RED} out=${OUT}`);
await runArm();
const after = liveCanary();
const same = JSON.stringify(before) === JSON.stringify(after);
clause('rig', 'ctl/live-claude-dirs-untouched', same, `${Object.keys(before).length} live ~/.claude* dirs, symlink-set + mcpServers hashes ${same ? 'identical before/after' : 'CHANGED: ' + JSON.stringify({ before, after })}`);

// ── verdict ───────────────────────────────────────────────────────────────────────────────────────
const isFeature = (c) => /^L\d\//.test(c.clause);
const ctlRed = results.filter((c) => !isFeature(c) && !c.ok), featRed = results.filter((c) => isFeature(c) && !c.ok), featAll = results.filter(isFeature);
console.log('\n== shots (md5) ==');
for (const s of shots) console.log(`  ${s.md5}  ${s.file}`);
const dup = shots.length - new Set(shots.map((s) => s.md5)).size;
console.log(`  duplicates among captures: ${dup}`);
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, `${LABEL}-result.json`), JSON.stringify({ app: APP_DIR, label: LABEL, results, shots }, null, 2));
let verdict, rc;
if (EXPECT_RED) {
  const allRed = featAll.length > 0 && featAll.every((c) => !c.ok);
  ({ verdict, rc } = ctlRed.length === 0 && allRed && dup === 0 ? { verdict: `EXPECTED-RED CONFIRMED: ${featAll.length}/${featAll.length} line clauses red (${featAll.map((c) => c.clause).join(', ')}), all controls green`, rc: 0 } : { verdict: `EXPECTED-RED NOT MET: feature red ${featRed.length}/${featAll.length}; controls red: ${ctlRed.map((c) => c.clause).join('; ') || 'none'}; duplicate captures ${dup}`, rc: 1 });
} else {
  ({ verdict, rc } = ctlRed.length === 0 && featRed.length === 0 && featAll.length === 7 && dup === 0 ? { verdict: `ALL GREEN: ${results.length} clauses (${featAll.length} feature, ${results.length - featAll.length} control), ${shots.length} captures all distinct`, rc: 0 } : { verdict: `RED: ${results.filter((c) => !c.ok).map((c) => c.clause).join('; ') || `(${featAll.length} feature clauses, ${dup} duplicate captures)`}`, rc: 1 });
}
console.log(`\nVERDICT: ${verdict}`);
process.exit(rc);
