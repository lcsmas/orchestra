// Shared rig library for the fleet-Pause UI drive (#257, wave F G3): contained headless sway (scripts/e2e-contained-rig.sh), SCRATCH ORCHESTRA_HOME / HOME / CLAUDE_CONFIG_DIR,
// a scratch fleet of REAL git worktrees with dirty work, a bus seeded with the SHIPPED writers, the BUILT app driven over CDP. Nothing live is ever handed to the app.
import { execFileSync, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const md5 = (b) => crypto.createHash('md5').update(b).digest('hex');
export const sh = (cmd, args, opt = {}) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opt });
export const refuse = (m) => { console.log(`REFUSED: ${m}`); process.exit(3); };

export async function waitFor(fn, ms, what, step = 150) {
  const t0 = Date.now(); let last;
  while (Date.now() - t0 < ms) { try { last = await fn(); if (last) return last; } catch (e) { last = e; } await sleep(step); }
  throw new Error(`timeout ${ms}ms waiting for ${what}${last instanceof Error ? `: ${last.message}` : ''}`);
}
const freePort = () => new Promise((res, rej) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); s.on('error', rej); });

// ── containment ────────────────────────────────────────────────────────────────────────────────────
export function makeGuard({ liveHome, rigDir, rigWayland }) {
  if (!liveHome) refuse('--live-home missing (needed to protect the live ~/.claude* and ~/.orchestra and to prove nothing there moved)');
  if (!rigDir || !rigWayland) refuse('RIG_DIR / RIG_WAYLAND unset — run via scripts/pause-ui/e2e-pause-ui.sh (the contained rig)');
  if (process.env.DISPLAY) refuse(`X11 DISPLAY=${process.env.DISPLAY} is set — Electron would reach the human's screen`);
  if (process.env.WAYLAND_DISPLAY !== rigWayland || rigWayland === 'wayland-1') refuse(`WAYLAND_DISPLAY=${process.env.WAYLAND_DISPLAY} != marker-verified ${rigWayland}`);
  const rigBase = fs.realpathSync(path.dirname(rigDir));
  const liveReal = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
  const LIVE = [...fs.readdirSync(liveHome).filter((n) => n === '.claude' || n.startsWith('.claude-')).map((n) => path.join(liveHome, n)), path.join(liveHome, '.orchestra'), path.join(liveHome, '.config')].map(liveReal);
  const check = (p) => {
    const r = liveReal(p);
    for (const l of LIVE) if (r === l || r.startsWith(l + path.sep) || l.startsWith(r + path.sep)) return { ok: false, clause: 'live-dir' };
    if (!(r === rigBase || r.startsWith(rigBase + path.sep))) return { ok: false, clause: 'outside-rig-base' };
    return { ok: true, clause: 'scratch' };
  };
  const mustBeScratch = (what, p) => { const r = check(p); if (!r.ok) refuse(`${what}=${p} [${r.clause}]`); };
  const a = check(path.join(liveHome, '.claude')), b = check('/tmp/not-in-the-rig'), c = check(path.join(rigDir, 'x'));
  if (a.clause !== 'live-dir' || b.clause !== 'outside-rig-base' || !c.ok) refuse(`scratch guard self-test failed: ${JSON.stringify({ a, b, c })}`);
  console.log(`[guard] self-test: live ~/.claude -> ${a.clause} · /tmp path -> ${b.clause} · rig path -> ${c.clause}`);
  return { mustBeScratch, check };
}

// ── PNG ────────────────────────────────────────────────────────────────────────────────────────────
export function decodePng(buf) {
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
export function crop(I, x, y, w, h) {
  x = Math.max(0, Math.floor(x)); y = Math.max(0, Math.floor(y)); w = Math.min(Math.floor(w), I.w - x); h = Math.min(Math.floor(h), I.h - y);
  const out = Buffer.alloc(w * h * I.ch);
  for (let r = 0; r < h; r++) I.data.copy(out, r * w * I.ch, ((y + r) * I.w + x) * I.ch, ((y + r) * I.w + x + w) * I.ch);
  return { w, h, ch: I.ch, data: out };
}
export function diffPx(A, B, tol = 6) {
  if (A.w !== B.w || A.h !== B.h || A.ch !== B.ch) throw new Error(`size mismatch ${A.w}x${A.h} vs ${B.w}x${B.h}`);
  let n = 0;
  for (let p = 0; p < A.w * A.h; p++) { const o = p * A.ch; if (Math.abs(A.data[o] - B.data[o]) > tol || Math.abs(A.data[o + 1] - B.data[o + 1]) > tol || Math.abs(A.data[o + 2] - B.data[o + 2]) > tol) n++; }
  return n;
}
export function distinctColours(I, cap = 5000) {
  const seen = new Set();
  for (let k = 0; k < I.data.length; k += I.ch) { seen.add((I.data[k] << 16) | (I.data[k + 1] << 8) | I.data[k + 2]); if (seen.size >= cap) break; }
  return seen.size;
}
/** pixels in the clip within `tol` of an rgb target (a painted accent surface) — "the paused badge's blue is on screen", not just a DOM node. */
export function pixelsNear(I, [r, g, b], tol = 28) {
  let n = 0;
  for (let k = 0; k < I.data.length; k += I.ch) if (Math.abs(I.data[k] - r) <= tol && Math.abs(I.data[k + 1] - g) <= tol && Math.abs(I.data[k + 2] - b) <= tol) n++;
  return n;
}

// ── CDP ────────────────────────────────────────────────────────────────────────────────────────────
export class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); ws.onmessage = (ev) => { const m = JSON.parse(ev.data); const p = m.id && this.pending.get(m.id); if (p) { this.pending.delete(m.id); m.error ? p.rej(new Error(`${m.error.message}`)) : p.res(m.result); } }; }
  static async connect(url) { const ws = new WebSocket(url); await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws error')); }); return new Cdp(ws); }
  send(method, params = {}, ms = 25000) {
    const id = ++this.id;
    return new Promise((res, rej) => { const t = setTimeout(() => { this.pending.delete(id); rej(new Error(`CDP ${method} timed out after ${ms}ms`)); }, ms); this.pending.set(id, { res: (v) => { clearTimeout(t); res(v); }, rej: (e) => { clearTimeout(t); rej(e); } }); this.ws.send(JSON.stringify({ id, method, params })); });
  }
  async eval(expr) { const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(`eval threw: ${r.exceptionDetails.text} ${r.exceptionDetails.exception?.description ?? ''}`); return r.result.value; }
  async mouse(x, y, type = 'mouseMoved', extra = {}) { await this.send('Input.dispatchMouseEvent', { type, x, y, ...extra }); }
  async click(x, y) { for (const [type, extra] of [['mouseMoved', {}], ['mousePressed', { button: 'left', clickCount: 1 }], ['mouseReleased', { button: 'left', clickCount: 1 }]]) { await this.mouse(x, y, type, extra); await sleep(60); } }
  async shot(clip) { const r = await this.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false, ...(clip ? { clip: { ...clip, scale: 1 } } : {}) }); return Buffer.from(r.data, 'base64'); }
  close() { try { this.ws.close(); } catch { /* gone */ } }
}

// ── the scratch fleet ──────────────────────────────────────────────────────────────────────────────
const UIDS = ['44f27c77-19ff-447b-a94a-b6e3512b1c52', '3610c0f1-860b-4f57-8855-0b5788040149', '012fcdca-d63b-4d43-9dae-7f10031ba33a', 'c34a25ee-8f8f-4b6c-a1f4-5e8a4e1f5a10', 'db40de36-5d1a-4cde-9a3e-0f6b7d2e3c41', '9f9955a2-17c3-4f1d-8e5b-2a9d6c4b7e82', 'f94e2424-3a4b-4c5d-9e6f-7a8b9c0d1e23', '7b1c3d5e-2f4a-4b6c-8d0e-1f2a3b4c5d6e', '5e6f7a8b-9c0d-4e1f-a2b3-c4d5e6f70819', '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d'];
/** [key, name, parentKey, kind, status, note] — the same fleet the mockups (pause-ui-mockups-257) were rendered on. */
export const FLEET = [
  ['lead', 'fleet-lead', null, 'orchestrator', 'running', 'dispatche la vague F'],
  ['ops', 'wave-ops', 'lead', 'orchestrator', 'running', 'gate : G3 en cours'],
  ['w1', 'worker-1', 'ops', 'worktree', 'running', 'couche IPC pause/reprise'],
  ['w2', 'worker-2', 'ops', 'worktree', 'running', 'drill Pause dure ×3'],
  ['w3', 'worker-3', 'ops', 'worktree', 'waiting', 'review du diff'],
  ['w4', 'worker-4', 'ops', 'worktree', 'idle', ''],
  ['docs', 'docs-sweep', 'lead', 'worktree', 'idle', 'carte du code à jour'],
  ['legacy', 'legacy-sweep', null, 'orchestrator', 'running', 'balayage hors vague'],
  ['sa', 'sweep-a', 'legacy', 'worktree', 'running', ''],
  ['sb', 'sweep-b', 'legacy', 'worktree', 'idle', ''],
];
export const IDS = Object.fromEntries(FLEET.map(([k], i) => [k, UIDS[i]]));
export const NAME_OF = Object.fromEntries(FLEET.map(([k, name]) => [IDS[k], name]));
const GIT_ENV = { PATH: '/usr/bin:/bin', GIT_AUTHOR_NAME: 'rig', GIT_AUTHOR_EMAIL: 'rig@x', GIT_COMMITTER_NAME: 'rig', GIT_COMMITTER_EMAIL: 'rig@x', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
export const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', env: { ...GIT_ENV, HOME: '/nonexistent' } }).trim();

/** Fleet of REAL git worktrees (the trap snapshots them) with dirty work in the workers, a stub `claude`, store.json, a seeded bus. */
export function buildWorld(armDir, guard) {
  const home = path.join(armDir, 'home'), ohome = path.join(armDir, 'oh'), cfg = path.join(armDir, 'claude-config'), repo = path.join(armDir, 'repo'), bin = path.join(armDir, 'stub-bin');
  for (const d of [home, ohome, cfg, repo, bin, path.join(ohome, 'userData', 'orchestra')]) fs.mkdirSync(d, { recursive: true });
  for (const [k, v] of Object.entries({ HOME: home, ORCHESTRA_HOME: ohome, CLAUDE_CONFIG_DIR: cfg, repo })) guard.mustBeScratch(k, v);
  fs.writeFileSync(path.join(bin, 'claude'), '#!/bin/sh\necho PAUSE-UI-STUB-CLAUDE "$@"\nsleep 3600\n', { mode: 0o755 });
  fs.writeFileSync(path.join(cfg, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true, numStartups: 5 }));
  git(repo, 'init', '-q', '-b', 'master');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'base\n');
  git(repo, 'add', '-A'); git(repo, 'commit', '-q', '-m', 'init');
  const workspaces = FLEET.map(([k, name, parent, kind, , note], i) => {
    const wt = path.join(armDir, `wt-${k}`);
    const orch = kind === 'orchestrator';
    if (orch) fs.mkdirSync(wt, { recursive: true });
    else {
      git(repo, 'worktree', 'add', '-q', '-b', name, wt);
      fs.writeFileSync(path.join(wt, 'a.txt'), `base\nWIP-${name}\n`); // tracked edit
      fs.writeFileSync(path.join(wt, `wip-${name}.txt`), `UNCOMMITTED-${name}\n`); // untracked work
    }
    return { id: IDS[k], name, repoPath: orch ? '' : repo, worktreePath: wt, branch: name, baseBranch: orch ? '' : 'master', createdAt: Date.now() - (FLEET.length - i) * 600000, status: 'idle', agent: 'claude', sdkSessionId: '', ...(orch ? { kind: 'orchestrator', canOrchestrate: true } : {}), ...(parent ? { parentId: IDS[parent] } : {}), ...(note ? { statusText: note } : {}) };
  });
  fs.writeFileSync(path.join(ohome, 'userData', 'orchestra', 'store.json'), JSON.stringify({ repos: [], workspaces, accounts: [], selfTuneRuns: [] }, null, 2));
  const seeder = (cmd, ...a) => { const out = sh(process.execPath, ['--no-warnings', '--experimental-strip-types', path.join(REPO, 'scripts/pause-ui/seed-bus.mjs'), ohome, cmd, ...a], { env: { PATH: '/usr/bin:/bin', HOME: home } }); return JSON.parse(out.split('\n').filter((l) => l.startsWith('{') || l.startsWith('[')).pop()); };
  seeder('seed');
  return { home, ohome, cfg, repo, bin, workspaces, readBus: () => seeder('read'), sql: (q, ...a) => seeder('sql', q, ...a), hold: (runId) => seeder('hold', runId) };
}

export function listProcsByHome(home) { // identity = /proc/<pid>/environ carrying THIS arm's ORCHESTRA_HOME
  const out = [];
  for (const p of fs.readdirSync('/proc').filter((n) => /^\d+$/.test(n))) {
    try { const env = fs.readFileSync(`/proc/${p}/environ`, 'utf8').split('\0'); if (env.includes(`ORCHESTRA_HOME=${home}`)) out.push(+p); } catch { /* not ours / gone */ }
  }
  return out.filter((p) => p !== process.pid);
}

/** Launch the BUILT app: `appDir` = a built checkout (dist/ + dist-electron/ → `electron <dir>`), or `packaged` = the unpacked `orchestra` binary. */
export async function launchApp({ appDir, packaged, world, guard, rigWayland, size, tag }) {
  const port = await freePort();
  sh('swaymsg', ['output', 'HEADLESS-1', 'resolution', `${size[0]}x${size[1]}`]);
  sh('swaymsg', ['default_border', 'none']);
  const env = { PATH: `${world.bin}:/usr/local/bin:/usr/bin:/bin`, HOME: world.home, XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR, XDG_CONFIG_HOME: path.join(world.home, '.config'), XDG_CACHE_HOME: path.join(world.home, '.cache'),
    WAYLAND_DISPLAY: rigWayland, SWAYSOCK: process.env.SWAYSOCK, ELECTRON_OZONE_PLATFORM_HINT: 'wayland', ORCHESTRA_OZONE: 'wayland', ORCHESTRA_OZONE_RELAUNCHED: '1',
    ORCHESTRA_HOME: world.ohome, ORCHESTRA_DEBUG_PORT: String(port), ORCHESTRA_SELF_TUNE_CMD: '/bin/true', CLAUDE_CONFIG_DIR: world.cfg, LANG: 'C.UTF-8' };
  for (const k of ['HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'ORCHESTRA_HOME', 'CLAUDE_CONFIG_DIR']) guard.mustBeScratch(`env.${k}`, env[k]);
  if ('DISPLAY' in env || env.WAYLAND_DISPLAY !== rigWayland) refuse('child env would reach the human display');
  const logFile = path.join(path.dirname(world.ohome), `app-${tag}.log`);
  const fd = fs.openSync(logFile, 'w');
  const cmd = packaged ?? path.join(appDir, 'node_modules/electron/dist/electron');
  const args = packaged ? ['--ozone-platform=wayland'] : [appDir, '--ozone-platform=wayland'];
  const app = spawn(cmd, args, { cwd: packaged ? world.ohome : appDir, env, stdio: ['ignore', fd, fd], detached: true });
  const target = await waitFor(async () => { const r = await fetch(`http://127.0.0.1:${port}/json`); return (await r.json()).find((x) => x.type === 'page' && x.url.includes('index.html')) || null; }, 90000, 'the app page target');
  const cdp = await Cdp.connect(target.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  return { app, cdp, port, target, logFile, kill: async () => {
    try { process.kill(-app.pid, 'SIGTERM'); } catch { /* gone */ }
    await sleep(2000);
    try { process.kill(-app.pid, 'SIGKILL'); } catch { /* gone */ }
    for (const p of listProcsByHome(world.ohome)) { try { process.kill(p, 'SIGKILL'); } catch { /* gone */ } }
    await sleep(500);
    return listProcsByHome(world.ohome);
  } };
}

export function liveCanary(liveHome) {
  const snap = {};
  for (const d of fs.readdirSync(liveHome).filter((n) => n === '.claude' || n.startsWith('.claude-')).map((n) => path.join(liveHome, n))) {
    let links = ''; try { links = sh('find', [d, '-maxdepth', '1', '-type', 'l', '-printf', '%f->%l\\n']).split('\n').sort().join('|'); } catch { /* none */ }
    let mcp = ''; for (const f of [path.join(d, '.claude.json'), path.join(liveHome, '.claude.json')]) { try { mcp += Object.keys(JSON.parse(fs.readFileSync(f, 'utf8')).mcpServers || {}).sort().join(',') + ';'; } catch { /* none */ } }
    snap[d] = md5(links) + ':' + md5(mcp) + ` (${links.split('|').filter(Boolean).length} symlinks)`;
  }
  // NOT the live bus's size:mtime: ~35 sibling agents write it all day, so it moves for reasons that are not ours. Our own evidence is `liveBusOpenedBy` below (no rig process holds it open).
  return snap;
}

/** Rig processes (identity = environ ORCHESTRA_HOME) that hold the LIVE bus (or its -wal / -shm) open right now — must be none. Also the path the app's own log says it opened. */
export function liveBusOpenedBy(home, liveHome) {
  const live = new Set(['', '-wal', '-shm'].map((x) => path.join(liveHome, '.orchestra', `bus.sqlite${x}`)));
  const holders = [];
  for (const pid of listProcsByHome(home)) {
    try { for (const fd of fs.readdirSync(`/proc/${pid}/fd`)) { try { if (live.has(fs.readlinkSync(`/proc/${pid}/fd/${fd}`))) holders.push(pid); } catch { /* fd closed */ } } } catch { /* gone */ }
  }
  let opened = null;
  try { const log = fs.readFileSync(path.join(home, 'logs', 'orchestra.log'), 'utf8'); opened = [...log.matchAll(/bus: opened (\S+)/g)].map((m) => m[1]).pop() ?? null; } catch { /* no log */ }
  return { holders: [...new Set(holders)], opened };
}

export function makeRecorder(OUT) {
  const results = [], shots = [];
  return {
    results, shots,
    clause(arm, name, ok, detail) { results.push({ arm, clause: name, ok: !!ok, detail }); console.log(`  ${ok ? 'PASS' : 'FAIL'}  [${arm}] ${name} — ${detail}`); return !!ok; },
    saveShot(name, buf) { fs.mkdirSync(OUT, { recursive: true }); const f = path.join(OUT, name); fs.writeFileSync(f, buf); shots.push({ file: f, md5: md5(buf) }); return f; },
  };
}
