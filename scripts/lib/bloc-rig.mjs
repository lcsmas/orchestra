// #419 — shared plumbing for the Bloc HTML budget rigs (scripts/e2e-bloc-budget.mjs, scripts/measure-bloc-frames.mjs): contained-rig guards, CDP, a scratch world,
// a built-app launcher, event helpers, /proc readers. Same containment contract as scripts/e2e-bloc-html.mjs (RIG_DIR/RIG_WAYLAND from scripts/e2e-contained-rig.sh).
import { execFileSync, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const md5 = (b) => crypto.createHash('md5').update(b).digest('hex');
export const sh = (cmd, args, opt = {}) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opt });
export const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
export const treeHash = (dirs) => md5(dirs.flatMap((d) => walk(d)).sort().map((f) => `${f}:${md5(fs.readFileSync(f))}`).join('\n'));
export const freePort = () => new Promise((res, rej) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); s.on('error', rej); });
export async function waitFor(fn, ms, what) {
  const t0 = Date.now(); let last;
  while (Date.now() - t0 < ms) { try { last = await fn(); if (last) return last; } catch (e) { last = e; } await sleep(150); }
  throw new Error(`timeout ${ms}ms waiting for ${what}${last instanceof Error ? `: ${last.message}` : ''}`);
}

/** Refuse unless run inside the contained rig; returns the containment helpers. `argv` = process.argv.slice(2). */
export function contain(argv) {
  const flag = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
  const refuse = (m) => { console.log(`REFUSED: ${m}`); process.exit(3); };
  const LIVE_HOME = flag('--live-home', null);
  if (!LIVE_HOME) refuse('--live-home missing');
  const { RIG_DIR, RIG_WAYLAND } = process.env;
  if (!RIG_DIR || !RIG_WAYLAND) refuse('RIG_DIR / RIG_WAYLAND unset — run via the contained rig (scripts/e2e-contained-rig.sh)');
  if (process.env.DISPLAY) refuse(`X11 DISPLAY=${process.env.DISPLAY} is set — Electron would reach the human's screen`);
  if (process.env.WAYLAND_DISPLAY !== RIG_WAYLAND || RIG_WAYLAND === 'wayland-1') refuse(`WAYLAND_DISPLAY=${process.env.WAYLAND_DISPLAY} != marker-verified ${RIG_WAYLAND}`);
  const RIG_BASE = fs.realpathSync(path.dirname(RIG_DIR));
  const liveReal = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
  const LIVE_DIRS = [...fs.readdirSync(LIVE_HOME).filter((n) => n === '.claude' || n.startsWith('.claude-')).map((n) => path.join(LIVE_HOME, n)), path.join(LIVE_HOME, '.orchestra'), path.join(LIVE_HOME, '.config')].map(liveReal);
  const checkScratch = (p) => {
    const r = liveReal(p);
    for (const l of LIVE_DIRS) if (r === l || r.startsWith(l + path.sep) || l.startsWith(r + path.sep)) return { ok: false, clause: 'live-dir' };
    if (!(r === RIG_BASE || r.startsWith(RIG_BASE + path.sep))) return { ok: false, clause: 'outside-rig-base' };
    return { ok: true, clause: 'scratch' };
  };
  const mustBeScratch = (what, p) => { const r = checkScratch(p); if (!r.ok) refuse(`${what}=${p} [${r.clause}]`); };
  const a = checkScratch(path.join(LIVE_HOME, '.claude')), b = checkScratch(path.join(path.dirname(RIG_BASE), 'not-in-the-rig')), c = checkScratch(path.join(RIG_DIR, 'x'));
  if (a.clause !== 'live-dir' || b.clause !== 'outside-rig-base' || !c.ok) refuse(`scratch guard self-test failed: ${JSON.stringify({ a, b, c })}`);
  const liveCanary = () => {
    const snap = {};
    for (const d of fs.readdirSync(LIVE_HOME).filter((n) => n === '.claude' || n.startsWith('.claude-')).map((n) => path.join(LIVE_HOME, n))) {
      let links = ''; try { links = sh('find', [d, '-maxdepth', '1', '-type', 'l', '-printf', '%f->%l\\n']).split('\n').sort().join('|'); } catch {}
      let mcp = ''; for (const f of [path.join(d, '.claude.json'), path.join(LIVE_HOME, '.claude.json')]) { try { mcp += Object.keys(JSON.parse(fs.readFileSync(f, 'utf8')).mcpServers || {}).sort().join(',') + ';'; } catch {} }
      snap[d] = md5(links) + ':' + md5(mcp);
    }
    return snap;
  };
  return { flag, refuse, LIVE_HOME, RIG_DIR, RIG_WAYLAND, mustBeScratch, liveCanary, selfTest: `live ~/.claude -> ${a.clause} · outside the rig -> ${b.clause} · rig path -> ${c.clause}` };
}

export class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); ws.onmessage = (ev) => { const m = JSON.parse(ev.data); const p = m.id && this.pending.get(m.id); if (p) { this.pending.delete(m.id); m.error ? p.rej(new Error(`${m.error.message}`)) : p.res(m.result); } }; }
  static async connect(url) { const ws = new WebSocket(url); await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws error')); }); return new Cdp(ws); }
  send(method, params = {}, ms = 20000) {
    const id = ++this.id;
    return new Promise((res, rej) => { const t = setTimeout(() => { this.pending.delete(id); rej(new Error(`CDP ${method} timed out after ${ms}ms`)); }, ms); this.pending.set(id, { res: (v) => { clearTimeout(t); res(v); }, rej: (e) => { clearTimeout(t); rej(e); } }); this.ws.send(JSON.stringify({ id, method, params })); });
  }
  async eval(expr, ms = 20000) { const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, ms); if (r.exceptionDetails) throw new Error(`eval threw: ${r.exceptionDetails.text} ${r.exceptionDetails.exception?.description ?? ''}`); return r.result.value; }
  async shot() { const r = await this.send('Page.captureScreenshot', { format: 'png' }, 25000); return Buffer.from(r.data, 'base64'); }
  close() { try { this.ws.close(); } catch {} }
}

// ── events (folded by the app exactly as a live session's) ──
export function events() {
  let SEQ = 1, IDX = 0;
  const at = () => 1754300000000 + SEQ;
  return {
    text: (t) => { const index = IDX++; return [{ type: 'block-start', seq: SEQ++, at: at(), index, kind: 'text' }, { type: 'text-delta', seq: SEQ++, at: at(), index, text: t }, { type: 'block-stop', seq: SEQ++, at: at(), index }]; },
    user: (text) => ({ type: 'user-message', seq: SEQ++, at: at(), text }),
  };
}
export const fence = (info, body) => '```' + info + '\n' + body + '\n```';

// ── a scratch world: a real git repo + worktree, the pinned scratch account, a stub `claude` ──
export function seedWorld(ctx, armDir, tag) {
  const git = (cwd, args, home) => sh('git', ['-c', 'user.name=rig', '-c', 'user.email=rig@example.invalid', ...args], { cwd, env: { PATH: process.env.PATH, HOME: home, GIT_CONFIG_NOSYSTEM: '1' } });
  const WS = `ws-${tag}-1`;
  const fakeHome = path.join(armDir, 'home'), ohome = path.join(armDir, 'oh'), cfg = path.join(armDir, 'claude-config');
  const repoDir = path.join(armDir, 'repo'), wtDir = path.join(armDir, 'wt', `${tag}-1`);
  for (const d of [fakeHome, ohome, cfg, repoDir, path.dirname(wtDir)]) fs.mkdirSync(d, { recursive: true });
  for (const [k, v] of Object.entries({ HOME: fakeHome, ORCHESTRA_HOME: ohome, CLAUDE_CONFIG_DIR: cfg, repo: repoDir, wt: wtDir })) ctx.mustBeScratch(k, v);
  git(repoDir, ['init', '-q', '-b', 'main'], fakeHome);
  fs.writeFileSync(path.join(repoDir, 'README.md'), `# ${tag} seed repo\n`);
  git(repoDir, ['add', '.'], fakeHome); git(repoDir, ['commit', '-q', '-m', 'seed'], fakeHome);
  git(repoDir, ['worktree', 'add', '-q', '-b', `e2e/${tag}-1`, wtDir], fakeHome);
  const account = { id: `rig-${tag}`, label: 'rig (scratch config dir)', configDir: cfg };
  ctx.mustBeScratch('account.configDir', account.configDir);
  const ws = { id: WS, name: `${tag}-1`, repoPath: repoDir, worktreePath: wtDir, branch: `e2e/${tag}-1`, baseBranch: 'main', createdAt: Date.now(), status: 'idle', agent: 'claude', accountId: account.id };
  const dir = path.join(ohome, 'userData', 'orchestra'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'store.json'), JSON.stringify({ repos: [{ path: repoDir, name: `${tag}-repo`, defaultBranch: 'main', accountId: account.id }], workspaces: [ws], accounts: [account], selfTuneRuns: [] }, null, 2));
  const stubDir = path.join(armDir, 'stub-bin'); fs.mkdirSync(stubDir, { recursive: true });
  fs.writeFileSync(path.join(stubDir, 'claude'), `#!/bin/sh\necho ${tag}-STUB-CLAUDE "$@"\nsleep 3600\n`, { mode: 0o755 });
  return { fakeHome, ohome, cfg, account, ws, WS, stubDir };
}

export function listProcsByHome(home) {
  const out = [];
  for (const p of fs.readdirSync('/proc').filter((n) => /^\d+$/.test(n))) {
    try { const env = fs.readFileSync(`/proc/${p}/environ`, 'utf8').split('\0'); if (env.includes(`ORCHESTRA_HOME=${home}`)) out.push(+p); } catch {}
  }
  return out.filter((p) => p !== process.pid);
}

/** Boot a BUILT app (appDir; the pinned Electron is read from appDir/node_modules) in my own sway at w×h with a scratch world. */
export async function launch(ctx, { appDir, armDir, tag, w, h }) {
  const world = seedWorld(ctx, path.join(armDir, 'world'), tag);
  sh('swaymsg', ['output', 'HEADLESS-1', 'resolution', `${w}x${h}`]);
  sh('swaymsg', ['default_border', 'none']);
  const port = await freePort();
  const env = { PATH: `${world.stubDir}:/usr/local/bin:/usr/bin:/bin`, HOME: world.fakeHome, XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR, XDG_CONFIG_HOME: path.join(world.fakeHome, '.config'), XDG_CACHE_HOME: path.join(world.fakeHome, '.cache'),
    WAYLAND_DISPLAY: ctx.RIG_WAYLAND, SWAYSOCK: process.env.SWAYSOCK, ELECTRON_OZONE_PLATFORM_HINT: 'wayland', ORCHESTRA_OZONE: 'wayland', ORCHESTRA_OZONE_RELAUNCHED: '1',
    ORCHESTRA_HOME: world.ohome, ORCHESTRA_DEBUG_PORT: String(port), ORCHESTRA_SELF_TUNE_CMD: '/bin/true', CLAUDE_CONFIG_DIR: world.cfg, LANG: 'C.UTF-8' };
  for (const k of ['HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'ORCHESTRA_HOME', 'CLAUDE_CONFIG_DIR']) ctx.mustBeScratch(`env.${k}`, env[k]);
  if ('DISPLAY' in env || env.WAYLAND_DISPLAY !== ctx.RIG_WAYLAND) ctx.refuse('child env would reach the human display');
  const logFile = path.join(armDir, 'app.log');
  const fd = fs.openSync(logFile, 'w');
  const app = spawn(path.join(appDir, 'node_modules/electron/dist/electron'), [appDir, '--ozone-platform=wayland'], { cwd: appDir, env, stdio: ['ignore', fd, fd], detached: true });
  let cdp;
  const stop = async () => {
    cdp?.close();
    try { process.kill(-app.pid, 'SIGTERM'); } catch {}
    await sleep(2000);
    try { process.kill(-app.pid, 'SIGKILL'); } catch {}
    for (const p of listProcsByHome(world.ohome)) { try { process.kill(p, 'SIGKILL'); } catch {} }
    await sleep(500);
    return listProcsByHome(world.ohome);
  };
  try {
    const target = await waitFor(async () => { const r = await fetch(`http://127.0.0.1:${port}/json`); const t = (await r.json()).find((x) => x.type === 'page' && x.url.includes('dist/index.html')); return t || null; }, 60000, 'the app page target');
    cdp = await Cdp.connect(target.webSocketDebuggerUrl);
    await cdp.send('Page.enable');
    await waitFor(() => cdp.eval(`!!window.__orchestraSetState && !!window.__injectAgentEvent && !!document.querySelector(".toolbar")`), 60000, 'the toolbar + the test seams');
    await cdp.eval(`window.__orchestraSetState(${JSON.stringify({ activeId: world.WS, view: 'structured' })}); 1`);
  } catch (e) { await stop(); throw e; }
  const inject = async (evs) => { for (const e of [].concat(evs)) await cdp.eval(`window.__injectAgentEvent(${JSON.stringify(world.WS)}, ${JSON.stringify(e)}); 1`); };
  return { app, port, cdp, world, inject, stop, logFile };
}

// ── /proc: the app's process tree, by Chromium process type ──
/** Descendants of rootPid from a full ppid map (renderers hang under NESTED zygotes, which the per-task children file misses). */
export function tree(rootPid) {
  const ppid = new Map();
  for (const n of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(n)) continue;
    try { const st = fs.readFileSync(`/proc/${n}/stat`, 'utf8'); ppid.set(+n, +st.slice(st.lastIndexOf(')') + 2).split(' ')[1]); } catch {}
  }
  const kids = new Map();
  for (const [p, pp] of ppid) (kids.get(pp) ?? kids.set(pp, []).get(pp)).push(p);
  const all = []; const stack = [rootPid];
  while (stack.length) { const p = stack.pop(); all.push(p); stack.push(...(kids.get(p) ?? [])); }
  return all;
}
/** statm counts pages: use the real page size (16 KiB on this asahi host), never an assumed 4. */
export const PAGE_KB = Number(sh('getconf', ['PAGESIZE'])) / 1024;
export const CLK_TCK = Number(sh('getconf', ['CLK_TCK']));
/** [{pid, type, rssKB, ticks}] for every process under rootPid; `type` is Chromium's `--type=` (browser = the main process). */
export function sampleTree(rootPid) {
  return tree(rootPid).map((pid) => {
    try {
      // Chromium rewrites a forked child's title with SPACES (no NULs): match on the joined string
      const type = /--type=(\S+)/.exec(fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' '))?.[1] ?? 'browser';
      const statm = fs.readFileSync(`/proc/${pid}/statm`, 'utf8').trim().split(/\s+/).map(Number);
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8'); const f = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      return { pid, type, rssKB: statm[1] * PAGE_KB, ticks: Number(f[11]) + Number(f[12]) };
    } catch { return null; }
  }).filter(Boolean);
}
export function pssKB(pid) {
  try { const m = /Pss:\s+(\d+) kB/.exec(fs.readFileSync(`/proc/${pid}/smaps_rollup`, 'utf8')); return m ? Number(m[1]) : null; } catch { return null; }
}
