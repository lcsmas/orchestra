// #388 — the WHOLE-FLOW drive (the wave's end gate): one BUILT Orchestra, one Electron, in the contained rig's own headless sway, driven as a story —
// human opens a tab → agent runs `orchestra browser` (open, tab new, snapshot, click, screenshot) → a _blank link → design mode picks `file:line` →
// sign-in cookies per workspace → Resources tab-memory row → Settings keyring notice → legacy tools → app restart → profils navigateur.
// Page assertions read an INDEPENDENT oracle (a 2nd CDP client on the panel page over the app's own debug port) or the renderer's own DOM/IPC; never the
// CLI chain alone. A clause whose ticket is not merged prints `NOT YET MERGED: #nnn …` (never a silent pass; `--require-all` turns each into a FAIL).
//
// Usage (via scripts/e2e-browser-whole-flow.sh): <app-dir> --live-home <real $HOME> [--arm a,b] [--list] [--mutant <name>] [--require-all] [--merged 396,400] [--out dir]
//   --mutant <name>: patch the BUILT chunk in place (byte-exact backup, `cmp`-verified restore); the NAMED clause(s) must go red and every ctl/* stay green.
//   --merged n,n: treat those tickets as merged (to drive a candidate tree whose merge commit is not on HEAD yet). Default: `git log --grep '^Merge #n'` in <app-dir>.
// Helpers are copied from scripts/e2e-browser-cli.mjs / e2e-browser-tabs.mjs (those are scripts with top-level side effects, not importable).
import { execFileSync, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { abLayout } from '../src/main/agent-browser-daemon.ts';
import { privateRuntimeDir } from './lib/rig-runtime.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };

/** `Merge #n` commit on <app>'s HEAD (the wave's integration branch merges one commit per ticket). */
const mergedIn = (app, n) => { try { return execFileSync('git', ['-C', app, 'log', '-E', `--grep=^Merge #${n}([^0-9]|$)`, '-1', '--format=%h'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: process.env.PATH, HOME: process.env.HOME ?? '/nonexistent' } }).trim() !== ''; } catch { return false; } };
const ARMS = ['human', 'agent', 'popup', 'design', 'cookies', 'memory', 'keyring', 'legacy', 'restart', 'profile'];
/** Mutants patch the BUILT chunk; each regex must match EXACTLY once. `clauses` = the NAMED clause(s) that must go red. */
const MUTANTS = {
  'strip-hides-agent-tabs': { edits: [[/([\w$]+)\.broadcast\("browser:event",([\w$]+)\.wsId,\2\.state\)/, '$1.broadcast("browser:event",$2.wsId,{...$2.state,tabs:$2.state.tabs.filter((t)=>t.openedBy!=="agent")})']],
    clauses: ['agent-tab-visible-in-the-human-strip'], why: 'the state pushed to the human\'s tab strip omits agent-opened tabs (the registry and the CLI still have them)' },
  'popup-same-view': { needs: 396, edits: [[/function ([\w$]+)\(([\w$]+),t,([\w$]+),([\w$]+)\)\{const ([\w$]+)=\2\.wsId;if\([\w$]+\.get\(\5\)!==\2\)return\{action:"deny"\}/, '$&'],
    [/case"new-tab":\{const ([\w$]+)=[\w$]+\([\w$]+,\{url:([\w$]+)\.url,openedBy:[\w$]+,activate:[\w$]+\.activate\}\);return [\w$]+\.pageInitiated&&\([\w$]+\.add\(\1\),[\w$]+\([\w$]+,[\w$]+\)\),\{action:"deny"\}\}/, 'case"new-tab":{void t.loadURL($2.url);return{action:"deny"}}']],
    clauses: ['blank-link-becomes-a-tab'], why: 'a _blank link / unnamed popup loads in the SAME tab again (the pre-#396 same-view handler); the first edit pins that the opener variable really is `t`' },
  'agent-closes-any-tab': { needs: 397, edits: [
    ['if (view && !view.closable) {', 'if (false) {', 'cli'],
    [/if\(([\w$]+)&&\1\.openedBy!=="agent"\)(throw new [\w$]+\(`\$\{[\w$]+\} is refused: tab)/, 'if(!1)$2'],
    [/return ([\w$]+)\.actor==="agent"&&([\w$]+)\.openedBy!=="agent"\?\{ok:!1,reason:"not-owner"/, 'return !1&&$2.openedBy!=="agent"?{ok:!1,reason:"not-owner"']],
    clauses: ['agent-cannot-close-the-humans-tab'], why: 'all three close-ownership layers (CLI pre-check, proxy Target.closeTarget guard, panel decideTabClose) let an agent close the human\'s tab' },
  'partition-shared': { edits: [[/function ([\w$]+)\(e\)\{return`orchestra-browser-\$\{e\}`\}/, 'function $1(e){return"orchestra-browser-shared"}']],
    clauses: ['agent-in-another-workspace-sees-anon'], why: 'every workspace shares ONE cookie jar: a sign-in in one reaches the agent of another' },
};
if (argv.includes('--list')) { console.log(`arms: ${ARMS.join(' ')}\nmutants: ${Object.keys(MUTANTS).join(' ')}`); process.exit(0); }
const chunkOf = (app) => path.join(app, 'dist-electron', /\.\/(index-[A-Za-z0-9_-]+\.js)/.exec(fs.readFileSync(path.join(app, 'dist-electron/main.js'), 'utf8'))?.[1] ?? 'MISSING');
const fileOf = (app, kind) => (kind === 'cli' ? path.join(app, 'dist-electron/cli.js') : chunkOf(app));
const hitsOf = (src, from) => (typeof from === 'string' ? src.split(from).length - 1 : (src.match(new RegExp(from.source, 'g')) ?? []).length);
if (argv[0] === '--check-anchors') { // no app, no compositor: every mutant edit still matches exactly once
  const app = fs.realpathSync(argv[1] ?? '.'); let bad = 0;
  for (const [n, m] of Object.entries(MUTANTS)) { if (m.needs && !mergedIn(app, m.needs)) { console.log(`SKIP ${n.padEnd(26)} needs #${m.needs} (not merged in ${app})`); continue; } const c = m.edits.map(([f, , k]) => hitsOf(fs.readFileSync(fileOf(app, k), 'utf8'), f)); if (!c.every((x) => x === 1)) bad++; console.log(`${c.every((x) => x === 1) ? 'OK ' : 'BAD'} ${n.padEnd(26)} matches=${c.join(',')}`); }
  process.exit(bad ? 1 : 0);
}

const APP_DIR = argv[0] && !argv[0].startsWith('--') ? fs.realpathSync(argv[0]) : null;
const LIVE_HOME = flag('--live-home', null);
const ARM_LIST = (flag('--arm', null) ?? ARMS.join(',')).split(',');
const MUTANT = flag('--mutant', null);
const REQUIRE_ALL = argv.includes('--require-all');
const FORCE_MERGED = new Set((flag('--merged', '') || '').split(',').filter(Boolean).map(Number));
const refuse = (m) => { console.log(`REFUSED: ${m}`); process.exit(3); };
if (!APP_DIR) refuse('no <app-dir>');
if (!LIVE_HOME) refuse('--live-home missing (needed to protect the live ~/.claude*, ~/.config, ~/.orchestra)');
for (const a of ARM_LIST) if (!ARMS.includes(a)) refuse(`unknown arm ${a} (have: ${ARMS.join(', ')})`);
if (MUTANT && MUTANTS[MUTANT]?.needs && !(FORCE_MERGED.has(MUTANTS[MUTANT].needs) || mergedIn(APP_DIR, MUTANTS[MUTANT].needs))) refuse(`mutant ${MUTANT} needs #${MUTANTS[MUTANT].needs} merged in ${APP_DIR}`);
if (MUTANT && !MUTANTS[MUTANT]) refuse(`unknown mutant ${MUTANT} (have: ${Object.keys(MUTANTS).join(', ')})`);
const RIG_DIR = process.env.RIG_DIR, RIG_WAYLAND = process.env.RIG_WAYLAND;
if (!RIG_DIR || !RIG_WAYLAND) refuse('RIG_DIR / RIG_WAYLAND unset — run via scripts/e2e-browser-whole-flow.sh (the contained rig)');
if (process.env.DISPLAY) refuse(`X11 DISPLAY=${process.env.DISPLAY} is set — Electron would reach the human's screen`);
if (process.env.WAYLAND_DISPLAY !== RIG_WAYLAND || RIG_WAYLAND === 'wayland-1') refuse(`WAYLAND_DISPLAY=${process.env.WAYLAND_DISPLAY} != marker-verified ${RIG_WAYLAND}`);
const OUT = flag('--out', null) || path.join(RIG_DIR, 'shots');

// ── scratch-containment guard (live dirs are never handed to the app) ───────────────────────────────────────────────────────────
const RIG_BASE = fs.realpathSync(path.dirname(RIG_DIR));
const liveReal = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
const LIVE_DIRS = [...fs.readdirSync(LIVE_HOME).filter((n) => n === '.claude' || n.startsWith('.claude-')).map((n) => path.join(LIVE_HOME, n)), path.join(LIVE_HOME, '.orchestra'), path.join(LIVE_HOME, '.config')].map(liveReal);
function checkScratch(p) {
  const r = liveReal(p);
  for (const l of LIVE_DIRS) if (r === l || r.startsWith(l + path.sep) || l.startsWith(r + path.sep)) return { ok: false, clause: 'live-dir' };
  return r === RIG_BASE || r.startsWith(RIG_BASE + path.sep) ? { ok: true, clause: 'scratch' } : { ok: false, clause: 'outside-rig-base' };
}
const mustBeScratch = (what, p) => { const r = checkScratch(p); if (!r.ok) refuse(`${what}=${p} [${r.clause}]`); };
{ const a = checkScratch(path.join(LIVE_HOME, '.claude')), b = checkScratch('/tmp/not-in-the-rig'), c = checkScratch(path.join(RIG_DIR, 'x'));
  if (a.clause !== 'live-dir' || b.clause !== 'outside-rig-base' || !c.ok) refuse(`scratch guard self-test failed: ${JSON.stringify({ a, b, c })}`);
  console.log(`[guard] self-test: live ~/.claude -> ${a.clause} · /tmp path -> ${b.clause} · rig path -> ${c.clause}`); }

// ── helpers ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const md5 = (b) => crypto.createHash('md5').update(b).digest('hex');
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const sel = (n) => JSON.stringify(n);
async function waitFor(fn, ms, what) {
  const t0 = Date.now(); let last;
  while (Date.now() - t0 < ms) { try { last = await fn(); if (last) return last; } catch (e) { last = e; } await sleep(150); }
  throw new Error(`timeout ${ms}ms waiting for ${what}${last instanceof Error ? `: ${last.message}` : ''}`);
}
const softWait = (fn, ms, what) => waitFor(fn, ms, what).catch(() => null);
const freePort = () => new Promise((res, rej) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); s.on('error', rej); });
const sh = (cmd, args, opt = {}) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opt });
const git = (cwd, args, home) => sh('git', ['-c', 'user.name=rig', '-c', 'user.email=rig@example.invalid', ...args], { cwd, env: { PATH: process.env.PATH, HOME: home, GIT_CONFIG_NOSYSTEM: '1' } });

function decodePng(buf) {
  let pos = 8; const idat = []; let w, h, bd, ct, il;
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos), type = buf.toString('latin1', pos + 4, pos + 8), data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); bd = data[8]; ct = data[9]; il = data[12]; } else if (type === 'IDAT') idat.push(data); else if (type === 'IEND') break;
    pos += 12 + len;
  }
  if (bd !== 8 || il !== 0 || (ct !== 6 && ct !== 2)) throw new Error(`unsupported PNG bd=${bd} ct=${ct} il=${il}`);
  const ch = ct === 6 ? 4 : 3, stride = w * ch, raw = zlib.inflateSync(Buffer.concat(idat)), out = Buffer.alloc(stride * h);
  let prev = Buffer.alloc(stride), i = 0;
  for (let y = 0; y < h; y++) {
    const f = raw[i++], line = Buffer.from(raw.subarray(i, i + stride)); i += stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? line[x - ch] : 0, b = prev[x], c = x >= ch ? prev[x - ch] : 0; let add = 0;
      if (f === 1) add = a; else if (f === 2) add = b; else if (f === 3) add = (a + b) >> 1;
      else if (f === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); add = pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      line[x] = (line[x] + add) & 255;
    }
    line.copy(out, y * stride); prev = line;
  }
  return { w, h, ch, data: out };
}
function inkPx(I, tol = 6) { // pixels that are not the image's dominant colour = painted "ink"
  const cnt = new Map();
  for (let p = 0; p < I.w * I.h; p++) { const o = p * I.ch, k = (I.data[o] << 16) | (I.data[o + 1] << 8) | I.data[o + 2]; cnt.set(k, (cnt.get(k) || 0) + 1); }
  let mode = 0, best = -1; for (const [k, v] of cnt) if (v > best) { best = v; mode = k; }
  const mr = mode >> 16, mg = (mode >> 8) & 255, mb = mode & 255; let n = 0;
  for (let p = 0; p < I.w * I.h; p++) { const o = p * I.ch; if (Math.abs(I.data[o] - mr) > tol || Math.abs(I.data[o + 1] - mg) > tol || Math.abs(I.data[o + 2] - mb) > tol) n++; }
  return n;
}

class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); ws.onmessage = (ev) => { const m = JSON.parse(ev.data); const p = m.id && this.pending.get(m.id); if (p) { this.pending.delete(m.id); m.error ? p.rej(new Error(`${m.error.message}`)) : p.res(m.result); } }; }
  static async connect(url) { const ws = new WebSocket(url); await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws error')); }); return new Cdp(ws); }
  send(method, params = {}, ms = 20000) {
    const id = ++this.id;
    return new Promise((res, rej) => { const t = setTimeout(() => { this.pending.delete(id); rej(new Error(`CDP ${method} timed out after ${ms}ms`)); }, ms); this.pending.set(id, { res: (v) => { clearTimeout(t); res(v); }, rej: (e) => { clearTimeout(t); rej(e); } }); this.ws.send(JSON.stringify({ id, method, params })); });
  }
  async eval(expr) { const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(`eval threw: ${r.exceptionDetails.text} ${r.exceptionDetails.exception?.description ?? ''}`); return r.result.value; }
  async mouse(type, x, y, extra = {}) { await this.send('Input.dispatchMouseEvent', { type, x, y, ...extra }); }
  async click(x, y) { for (const [type, extra] of [['mouseMoved', {}], ['mousePressed', { button: 'left', clickCount: 1 }], ['mouseReleased', { button: 'left', clickCount: 1 }]]) { await this.mouse(type, x, y, extra); await sleep(60); } }
  async enter() { for (const type of ['keyDown', 'keyUp']) await this.send('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, ...(type === 'keyDown' ? { text: '\r' } : {}) }); }
  close() { try { this.ws.close(); } catch { /* already closed */ } }
}

// ── seeding: two workspaces, a pinned session key each (hashes in session-keys.json, ADR 0008), a stub `claude` ───────────────────
const WS_NAMES = ['flow-one', 'flow-two'];
function seedWorld(armDir) {
  const fakeHome = path.join(armDir, 'home'), ohome = path.join(armDir, 'oh'), cfg = path.join(armDir, 'claude-config'), repoDir = path.join(armDir, 'repo');
  for (const d of [fakeHome, ohome, cfg, repoDir]) fs.mkdirSync(d, { recursive: true });
  for (const [k, v] of Object.entries({ HOME: fakeHome, ORCHESTRA_HOME: ohome, CLAUDE_CONFIG_DIR: cfg, repo: repoDir })) mustBeScratch(k, v);
  git(repoDir, ['init', '-q', '-b', 'main'], fakeHome);
  fs.writeFileSync(path.join(repoDir, 'README.md'), '# whole-flow seed repo\n');
  git(repoDir, ['add', '.'], fakeHome); git(repoDir, ['commit', '-q', '-m', 'seed'], fakeHome);
  const account = { id: 'rig-flow', label: 'rig (scratch config dir)', configDir: cfg }; mustBeScratch('account.configDir', cfg);
  const workspaces = WS_NAMES.map((name, i) => {
    const wt = path.join(armDir, 'wt', name); fs.mkdirSync(path.dirname(wt), { recursive: true });
    git(repoDir, ['worktree', 'add', '-q', '-b', `e2e/${name}`, wt], fakeHome);
    return { id: `ws-${name}`, name, repoPath: repoDir, worktreePath: wt, branch: `e2e/${name}`, baseBranch: 'main', createdAt: Date.now() + i, status: 'idle', agent: 'claude', accountId: account.id, key: crypto.randomBytes(24).toString('hex') };
  });
  const dir = path.join(ohome, 'userData', 'orchestra'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'store.json'), JSON.stringify({ repos: [{ path: repoDir, name: 'flow-repo', defaultBranch: 'main', accountId: account.id }], workspaces: workspaces.map(({ key, ...w }) => w), accounts: [account], selfTuneRuns: [] }, null, 2));
  fs.writeFileSync(path.join(ohome, 'session-keys.json'), JSON.stringify({ version: 1, sessions: Object.fromEntries(workspaces.map((w) => [w.id, { hash: sha256(w.key), issuedAt: Date.now() }])) }), { mode: 0o600 });
  const stubDir = path.join(armDir, 'stub-bin'); fs.mkdirSync(stubDir, { recursive: true });
  fs.writeFileSync(path.join(stubDir, 'claude'), '#!/bin/sh\necho FLOW-STUB-CLAUDE "$@"\nsleep 3600\n', { mode: 0o755 });
  return { fakeHome, ohome, cfg, account, workspaces, stubDir, armDir };
}
function listProcsByHome(home) {
  const out = [];
  for (const p of fs.readdirSync('/proc').filter((n) => /^\d+$/.test(n))) {
    try { if (fs.readFileSync(`/proc/${p}/environ`, 'utf8').split('\0').includes(`ORCHESTRA_HOME=${home}`)) { out.push(+p); continue; } } catch { /* gone */ }
    try { if (fs.readFileSync(`/proc/${p}/cmdline`, 'utf8').includes(home)) out.push(+p); } catch { /* gone */ } // Chromium rewrites environ once a bus address is set; children keep --user-data-dir=<home>/userData
  }
  return out.filter((p) => p !== process.pid);
}
const environOf = (pid) => { try { return fs.readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0').filter(Boolean); } catch { return null; } };
const daemonPids = (world) => { const l = abLayout(world.ohome, process.env.XDG_RUNTIME_DIR); const dir = path.join(l.socketDir, 'namespaces', 'orchestra', 'run'); const out = {}; try { for (const f of fs.readdirSync(dir)) if (f.endsWith('.pid')) out[f.slice(0, -4)] = Number(fs.readFileSync(path.join(dir, f), 'utf8').trim()); } catch { /* no daemon */ } return out; };

// ── results, merge detector, NOT-YET-MERGED lines ────────────────────────────────────────────────────────────────────────────────
const results = []; // {arm, clause, ok, detail, nym?}
function clause(arm, name, ok, detail) { results.push({ arm, clause: name, ok: !!ok, detail }); console.log(`  ${ok ? 'PASS' : 'FAIL'}  [${arm}] ${name} — ${detail}`); }
const shots = [];
function saveShot(name, buf) { fs.mkdirSync(OUT, { recursive: true }); const f = path.join(OUT, name); fs.writeFileSync(f, buf); shots.push({ file: f, md5: md5(buf) }); return f; }
/** merged = forced by --merged, or HEAD of <app-dir> carries a `Merge #n` commit. Audited by a ctl clause (a known-merged and a known-open ticket). */
function isMerged(n) { return FORCE_MERGED.has(n) || mergedIn(APP_DIR, n); }
function nym(arm, ticket, what, today, planned) {
  console.log(`  NOT YET MERGED: #${ticket} — ${what}. today: ${today}. When it lands this clause must observe: ${planned}`);
  results.push({ arm, clause: `nym/#${ticket} ${what}`, ok: !REQUIRE_ALL, nym: true, ticket, detail: `NOT YET MERGED (${REQUIRE_ALL ? '--require-all: FAIL' : 'deferred'}); today: ${today}; planned: ${planned}` });
}

// ── mutants: patch the BUILT chunk in place; restore byte-exact and prove it with cmp ─────────────────────────────────────────────
let mutantRestore = null;
const MARKER = path.join(APP_DIR ?? '/nonexistent', 'dist-electron', '.b388-flow-mutant-active');
function applyMutant() {
  if (fs.existsSync(MARKER)) refuse(`${MARKER} exists — an earlier mutant run died without restoring the bundle: ${fs.readFileSync(MARKER, 'utf8').trim()} (restore from those backups or rebuild, then delete the marker)`);
  if (!MUTANT) return;
  const m = MUTANTS[MUTANT], files = new Map();
  for (const [from, to, kind] of m.edits) {
    const file = fileOf(APP_DIR, kind); let src = files.get(file) ?? fs.readFileSync(file, 'utf8');
    const hits = hitsOf(src, from);
    if (hits !== 1) refuse(`mutant ${MUTANT}: ${String(from).slice(0, 70)} occurs ${hits}x in ${path.basename(file)} (must be exactly 1) — the bundle changed, update the mutant`);
    files.set(file, typeof from === 'string' ? src.replace(from, () => to) : src.replace(from, to));
  }
  const backups = [...files.keys()].map((file) => [file, path.join(RIG_DIR, `mutant-backup-${path.basename(file)}`)]);
  for (const [file, backup] of backups) fs.copyFileSync(file, backup);
  fs.writeFileSync(MARKER, backups.map(([f, b]) => `${b} -> ${f}`).join('\n') + '\n');
  for (const [file, src] of files) fs.writeFileSync(file, src);
  console.log(`[mutant] ${MUTANT} applied to ${[...files.keys()].map((f) => path.basename(f)).join(', ')}: ${m.why}`);
  mutantRestore = () => {
    let ok = true;
    for (const [file, backup] of backups) { fs.copyFileSync(backup, file); try { sh('cmp', [backup, file]); } catch { ok = false; } }
    if (ok) { fs.rmSync(MARKER, { force: true }); console.log(`[mutant] ${MUTANT} restored byte-exact (cmp OK, ${backups.length} file(s))`); } else console.log(`[mutant] RESTORE NOT BYTE-EXACT — rebuild ${APP_DIR}/dist-electron (marker kept)`);
  };
}
process.on('uncaughtException', (e) => { clause('rig', 'uncaught-exception', false, String(e?.stack ?? e).slice(0, 400)); });
process.on('exit', () => { try { mutantRestore?.(); } catch { /* reported above */ } });
process.on('SIGINT', () => process.exit(130));
process.on('SIGTERM', () => process.exit(143));

// ── the app: spawned (and re-spawned for the restart arm) with an `env -i` allowlist ─────────────────────────────────────────────
function appEnv(world, port) {
  const env = { PATH: `${world.stubDir}:/usr/local/bin:/usr/bin:/bin`, HOME: world.fakeHome, XDG_RUNTIME_DIR: privateRuntimeDir(), DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS ?? '', XDG_CONFIG_HOME: path.join(world.fakeHome, '.config'), XDG_CACHE_HOME: path.join(world.fakeHome, '.cache'),
    WAYLAND_DISPLAY: RIG_WAYLAND, SWAYSOCK: process.env.SWAYSOCK, ELECTRON_OZONE_PLATFORM_HINT: 'wayland', ORCHESTRA_OZONE: 'wayland', ORCHESTRA_OZONE_RELAUNCHED: '1',
    ORCHESTRA_HOME: world.ohome, ORCHESTRA_DEBUG_PORT: String(port), ORCHESTRA_SELF_TUNE_CMD: '/bin/true', CLAUDE_CONFIG_DIR: world.cfg, LANG: 'C.UTF-8', ORCHESTRA_CDP_RELEASE_GRACE_MS: '1500' };
  for (const k of ['HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'ORCHESTRA_HOME', 'CLAUDE_CONFIG_DIR']) mustBeScratch(`env.${k}`, env[k]);
  if ('DISPLAY' in env || env.WAYLAND_DISPLAY !== RIG_WAYLAND) refuse('child env would reach the human display');
  { const bus = env.DBUS_SESSION_BUS_ADDRESS, busPath = bus.startsWith('unix:path=') ? bus.slice('unix:path='.length) : ''; if (!busPath || !busPath.startsWith(RIG_DIR + path.sep) || fs.existsSync(busPath)) refuse(`child D-Bus address '${bus}' is not the rig's private nonexistent bus`); }
  return env;
}
async function startApp(ctx, tag) {
  const port = await freePort(), env = appEnv(ctx.world, port), logFile = path.join(ctx.world.armDir, `app-${tag}.log`), fd = fs.openSync(logFile, 'w');
  const app = spawn(path.join(APP_DIR, 'node_modules/electron/dist/electron'), [APP_DIR, '--ozone-platform=wayland'], { cwd: APP_DIR, env, stdio: ['ignore', fd, fd], detached: true });
  console.log(`[rig] app(${tag}) pid ${app.pid} debug port ${port} log ${logFile}`);
  Object.assign(ctx, { app, port, env, targets: async () => (await (await fetch(`http://127.0.0.1:${port}/json`)).json()) });
  const target = await waitFor(async () => (await ctx.targets()).find((x) => x.type === 'page' && x.url.includes('dist/index.html')) || null, 60000, 'the app page target');
  ctx.ui = await Cdp.connect(target.webSocketDebuggerUrl); await ctx.ui.send('Page.enable');
  await waitFor(() => ctx.ui.eval(`document.body.innerText.includes(${sel(ctx.W1.branch)})`), 60000, 'the seeded workspaces in the sidebar');
  await sleep(1500);
  return target;
}
async function stopApp(ctx) {
  ctx.ui?.close();
  try { process.kill(-ctx.app.pid, 'SIGTERM'); } catch { /* gone */ }
  await sleep(2000);
  try { process.kill(-ctx.app.pid, 'SIGKILL'); } catch { /* gone */ }
}

// ── driving helpers (trusted CDP input only) ─────────────────────────────────────────────────────────────────────────────────────
async function selectWs(ctx, W) {
  const pos = await ctx.ui.eval(`(() => { const n = [...document.querySelectorAll('.ws-item .ws-name')].find((e) => e.textContent.trim() === ${sel(W.branch)}); if (!n) return null; const b = n.getBoundingClientRect(); return { x: b.left + 20, y: b.top + b.height / 2 }; })()`);
  if (!pos) throw new Error(`sidebar row for ${W.branch} not found`);
  await ctx.ui.mouse('mouseMoved', pos.x, pos.y); await ctx.ui.click(pos.x, pos.y);
  await waitFor(() => ctx.ui.eval(`!![...document.querySelectorAll('.ws-item.active .ws-name')].find((e) => e.textContent.trim() === ${sel(W.branch)})`), 15000, `${W.branch} to become the active workspace`);
}
const rectOf = (ctx, s, nth = 0) => ctx.ui.eval(`(() => { const e = document.querySelectorAll(${sel(s)})[${nth}]; if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
async function clickSel(ctx, s, nth = 0) { const r = await rectOf(ctx, s, nth); if (!r) throw new Error(`no element for ${s}[${nth}]`); await ctx.ui.click(r.x, r.y); return r; }
async function openPane(ctx) {
  const st = await ctx.ui.eval(`(() => { const b = document.querySelector('button[aria-label="Show browser pane"],button[aria-label="Hide browser pane"]'); return b ? { open: b.getAttribute('aria-label') === 'Hide browser pane' } : null; })()`);
  if (!st) throw new Error('browser pane toggle not found');
  if (!st.open) await clickSel(ctx, 'button[aria-label="Show browser pane"]');
  await waitFor(() => ctx.ui.eval(`!!document.querySelector('.browser-tabs') && document.querySelectorAll('.browser-tab').length > 0 && !!document.querySelector('.browser-url-input')`), 20000, 'the Browser pane (tab strip + URL bar)');
  await sleep(500);
}
async function typeUrl(ctx, url) { await clickSel(ctx, '.browser-url-input'); await ctx.ui.eval(`document.querySelector('.browser-url-input').select()`); await ctx.ui.send('Input.insertText', { text: url }); await sleep(80); await ctx.ui.enter(); }
const strip = (ctx) => ctx.ui.eval(`[...document.querySelectorAll('.browser-tab')].map((e) => ({ id: e.dataset.tabId, label: e.querySelector('.browser-tab-label')?.textContent ?? '', active: e.getAttribute('aria-selected') === 'true', openedBy: e.dataset.openedBy }))`);
const reg = async (ctx, W) => (await ctx.ui.eval(`window.orchestra.browserState(${sel(W.id)})`)).tabs;
/** The REAL CLI bundle with an `env -i` allowlist: exactly what an agent's Bash tool hands it. */
function cli(ctx, W, args, { timeoutMs = 60000 } = {}) {
  const env = { PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`, HOME: ctx.world.fakeHome, ORCHESTRA_HOME: ctx.world.ohome, ORCHESTRA_WS_ID: W.id, ORCHESTRA_SESSION_KEY: W.key,
    ORCHESTRA_AGENT_TMPDIR: path.join(ctx.world.fakeHome, 'agent-tmp', W.name), LANG: 'C.UTF-8' };
  fs.mkdirSync(env.ORCHESTRA_AGENT_TMPDIR, { recursive: true });
  const t0 = Date.now();
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(APP_DIR, 'dist-electron/cli.js'), 'browser', ...args], { env, stdio: ['ignore', 'pipe', 'pipe'], cwd: ctx.world.fakeHome, detached: true });
    let stdout = '', stderr = ''; child.stdout.on('data', (d) => (stdout += d)); child.stderr.on('data', (d) => (stderr += d));
    const timer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* gone */ } } }, timeoutMs);
    child.on('close', (code, signal) => { clearTimeout(timer); resolve({ code: code ?? (signal ? 137 : 0), stdout, stderr, ms: Date.now() - t0 }); });
  });
}
const show = (r) => `rc=${r.code} ${r.ms}ms stdout=${JSON.stringify(r.stdout.trim().slice(0, 140))} stderr=${JSON.stringify(r.stderr.trim().slice(0, 160))}`;
const refOf = (snapshot, role, name) => { const m = new RegExp(`${role} "${name}\\s*"[^\\n]*\\[ref=(e\\d+)\\]`).exec(snapshot); return m ? `@${m[1]}` : null; };
const labelOf = (list, re) => (list.stdout.split('\n').find((l) => re.test(l)) ?? '').match(/\[(t\d+)\]/)?.[1];
/** Independent oracle: a 2nd CDP client on a panel page through the APP's own remote-debugging port. */
async function oracle(ctx, urlPrefix, ms = 15000) {
  const t = await waitFor(async () => (await ctx.targets()).find((x) => x.type === 'page' && x.url.startsWith(urlPrefix)) || null, ms, `a panel page at ${urlPrefix}`);
  const c = await Cdp.connect(t.webSocketDebuggerUrl);
  await softWait(() => c.eval(`document.readyState === 'complete'`), 8000, 'the oracle page to finish loading'); // a target exists before its DOM does
  return c;
}
const centreOf = (o, s) => o.eval(`(() => { const e = document.querySelector(${sel(s)}); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
const MB = 1024 * 1024;
const vmRss = (pid) => { try { return Number(/VmRSS:\s+(\d+) kB/.exec(fs.readFileSync(`/proc/${pid}/status`, 'utf8'))?.[1]) * 1024 || null; } catch { return null; } };
function swayWindows(pid) { // the app's native windows in MY sway (a popup child window is one; a tab is not)
  const out = [];
  (function walk(n) { for (const c of [...(n.nodes || []), ...(n.floating_nodes || [])]) { if (c.pid === pid && c.type !== 'workspace' && c.type !== 'output' && !(c.nodes || []).length) out.push({ name: c.name, floating: c.type === 'floating_con' }); walk(c); } })(JSON.parse(sh('swaymsg', ['-t', 'get_tree'])));
  return out;
}

// ── the story ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const ARM_FNS = {
  async human(ctx) {
    const { W1, FIX } = ctx; const A = 'human';
    await selectWs(ctx, W1); await openPane(ctx);
    const t0 = await reg(ctx, W1);
    clause(A, 'ctl/one-human-tab-on-first-open', t0.length === 1 && t0[0].openedBy === 'human', `registry ${JSON.stringify(t0.map((t) => [t.id, t.openedBy]))}`);
    await clickSel(ctx, '.browser-tab-new');
    await softWait(async () => (await reg(ctx, W1)).length === 2, 10000, 'the second tab');
    const t1 = await reg(ctx, W1), s1 = await strip(ctx);
    clause(A, 'human-plus-opens-a-second-tab', t1.length === 2 && t1.every((t) => t.openedBy === 'human') && t1[1].active && s1.length === 2 && s1[1].active, `registry ${JSON.stringify(t1.map((t) => [t.id, t.openedBy, t.active]))} · strip ${JSON.stringify(s1.map((t) => [t.id, t.active]))}`);
    await typeUrl(ctx, `${FIX}/index.html`);
    const o = await oracle(ctx, `${FIX}/index.html`); ctx.humanPage = o;
    const h = await softWait(() => o.eval(`document.querySelector('h1')?.textContent ?? null`), 8000, 'the index page body');
    const bar = await softWait(() => ctx.ui.eval(`document.querySelector('.browser-url-input').value`).then((v) => (v.endsWith('/index.html') ? v : null)), 8000, 'the URL bar to show the page') ?? await ctx.ui.eval(`document.querySelector('.browser-url-input').value`);
    clause(A, 'human-url-bar-navigates-the-active-tab', h === 'Fixture home' && bar.endsWith('/index.html') && (await reg(ctx, W1))[1].url.endsWith('/index.html'), `oracle h1=${JSON.stringify(h)} · URL bar ${JSON.stringify(bar)} · registry t2 url ${JSON.stringify((await reg(ctx, W1))[1].url)}`);
    o.close();
  },

  async agent(ctx) {
    const { W1, FIX, ui } = ctx; const A = 'agent';
    await selectWs(ctx, W1);
    const open = await cli(ctx, W1, ['open', `${FIX}/flow.html`]);
    const afterOpen = await reg(ctx, W1);
    const lab = await softWait(async () => (await strip(ctx)).find((t) => /Flow fixture/.test(t.label)), 10000, 'the strip to show the page title');
    clause(A, 'agent-open-drives-the-shared-surface', open.code === 0 && afterOpen.length === 2 && /\/flow\.html$/.test(afterOpen[1].url) && !!lab, `${show(open)} → registry ${JSON.stringify(afterOpen.map((t) => [t.id, t.openedBy, t.url.slice(-12)]))} · strip label ${JSON.stringify(lab?.label)}`);
    const nw = await cli(ctx, W1, ['tab', 'new', `${FIX}/cli.html`]);
    await softWait(async () => (await reg(ctx, W1)).some((t) => t.openedBy === 'agent' && /\/cli\.html$/.test(t.url)), 10000, 'the agent tab to load cli.html');
    const r = await reg(ctx, W1), mine = r.find((t) => t.openedBy === 'agent');
    clause(A, 'ctl/agent-tab-in-the-registry', nw.code === 0 && r.length === 3 && !!mine && mine.active, `${show(nw)} → registry ${JSON.stringify(r.map((t) => [t.id, t.openedBy, t.active]))}`);
    const seen = await softWait(async () => (await strip(ctx)).find((t) => t.openedBy === 'agent' && /CLI fixture/.test(t.label)), 10000, 'the human strip to show the agent tab');
    const s = await strip(ctx);
    clause(A, 'agent-tab-visible-in-the-human-strip', !!seen && s.length === 3 && seen.active, `human strip ${JSON.stringify(s.map((t) => [t.id, t.openedBy, t.label.slice(0, 14), t.active]))} (registry has ${r.length} tabs)`);
    saveShot('flow-strip.png', Buffer.from((await ui.send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
    const noticeOf = () => ui.eval(`document.querySelector('.browser-agent-switch-text')?.textContent ?? null`), backOf = () => ui.eval(`document.querySelector('.browser-agent-switch-back')?.textContent ?? null`);
    if (isMerged(397)) {
      const marks = await ui.eval(`({ agent: document.querySelectorAll('.browser-tab[data-opened-by="agent"] .browser-tab-agent-mark').length, human: document.querySelectorAll('.browser-tab[data-opened-by="human"] .browser-tab-agent-mark').length })`);
      const note = await softWait(noticeOf, 5000, 'the agent-switch notice'), back = await backOf();
      clause(A, 'strip-marks-the-agent-tab-and-the-human-is-told-it-took-the-screen', marks.agent === 1 && marks.human === 0 && /CLI fixture/.test(note ?? '') && /Flow fixture/.test(back ?? ''), `agent-marked tabs ${marks.agent}, human-marked ${marks.human}; notice ${JSON.stringify(note)}; back button ${JSON.stringify(back)}`);
      await clickSel(ctx, '.browser-agent-switch-back');
      await softWait(async () => (await reg(ctx, W1)).find((t) => t.active)?.openedBy === 'human', 8000, 'Back to give the human their tab');
      const gone = await softWait(async () => (await noticeOf()) === null, 5000, 'the notice to clear');
      clause(A, 'back-gives-the-human-their-tab-and-clears-the-notice', (await reg(ctx, W1)).find((t) => t.active)?.openedBy === 'human' && !!gone, `active tab ${JSON.stringify((await reg(ctx, W1)).find((t) => t.active)?.id)} (human); notice cleared ${!!gone}`);
    } else nym(A, 397, 'an agent tab is marked in the strip, the human is told with a way back, an acting command brings its tab to the front', 'the agent tab shows in the strip (clause above) but no mark, notice or Back control exists', 'one agent-marked tab, a notice naming the agent page and a Back button naming the human page');
    const o = await oracle(ctx, `${FIX}/cli.html`);
    const snap = await cli(ctx, W1, ['snapshot', '-i']); const go = refOf(snap.stdout, 'button', 'Go');
    const pre = await o.eval(`document.getElementById('out').textContent`);
    const click = await cli(ctx, W1, ['click', go]);
    const post = await o.eval(`document.getElementById('out').textContent`);
    clause(A, 'agent-snapshot-click-changes-the-page', pre === 'idle' && !!go && click.code === 0 && post === 'clicked', `#out ${JSON.stringify(pre)} → ${JSON.stringify(post)} (oracle) · ${show(click)}`);
    const dest = path.join(ctx.world.fakeHome, 'flow-shot.png');
    const shot = await cli(ctx, W1, ['screenshot', dest]);
    let img = null; try { img = decodePng(fs.readFileSync(dest)); } catch { /* reported below */ }
    clause(A, 'agent-screenshot-through-the-proxy', shot.code === 0 && !!img && img.w >= 300 && img.h >= 200 && inkPx(img) > 400, `${show(shot)} → ${img ? `${img.w}x${img.h}, ${inkPx(img)} ink px` : 'unreadable'}`);
    if (img) saveShot('flow-cli-screenshot.png', fs.readFileSync(dest));
    if (isMerged(397)) {
      const act = (await reg(ctx, W1)).find((t) => t.active);
      const note2 = await softWait(noticeOf, 5000, 'the notice after an acting command');
      clause(A, 'an-acting-command-brings-its-tab-to-the-front-and-says-so', act?.openedBy === 'agent' && /CLI fixture/.test(note2 ?? ''), `after the agent's click/screenshot the active tab is ${JSON.stringify(act && [act.id, act.openedBy])}; notice ${JSON.stringify(note2)}`);
      const lst = await cli(ctx, W1, ['tab', 'list']), lines = lst.stdout.split('\n').map((l) => l.trim());
      clause(A, 'tab-list-says-who-opened-which', lst.code === 0 && lines.some((l) => /cli\.html/.test(l) && /\(yours\)$/.test(l)) && lines.some((l) => /flow\.html/.test(l) && /\(the user's\)$/.test(l)), show(lst));
      const humanId = labelOf(lst, /\/flow\.html/);
      const closeH = await cli(ctx, W1, ['tab', 'close', humanId ?? 't0']);
      const survives = (await reg(ctx, W1)).some((t) => /\/flow\.html$/.test(t.url) && t.openedBy === 'human'); // CLI labels are strip positions, registry ids are creation order: match by URL
      clause(A, 'agent-cannot-close-the-humans-tab', !!humanId && closeH.code !== 0 && /opened by the user/.test(closeH.stdout + closeH.stderr) && survives, `tab close ${humanId}: ${show(closeH)} → human tab still in the registry: ${survives}`);
      const ids0 = new Set((await reg(ctx, W1)).map((t) => t.id)), cap = Number(/BROWSER_TAB_CAP\s*=\s*(\d+)/.exec(fs.readFileSync(path.join(APP_DIR, 'src/shared/browser-tab-policy.ts'), 'utf8'))?.[1]);
      let refused = null;
      for (let i = 0; i < cap && !refused; i++) { const r = await cli(ctx, W1, ['tab', 'new', `${FIX}/index.html?cap=${i}`]); if (r.code !== 0) refused = r; }
      const full = await reg(ctx, W1), views = (await ctx.targets()).filter((t) => t.type === 'page' && !t.url.includes('dist/index.html')).length;
      clause(A, 'agent-tabs-count-against-the-cap-and-the-refusal-gives-the-reason', full.length === cap && !!refused && /\b8\b|cap|at most/i.test(refused.stdout + refused.stderr) && views === cap, `registry ${full.length} tabs (cap ${cap}); live views ${views}; the ${cap - ids0.size + 1}th agent open → ${refused ? show(refused) : 'NOT REFUSED'}`);
      const lst2 = await cli(ctx, W1, ['tab', 'list']);
      for (const l of lst2.stdout.split('\n').filter((l) => /index\.html\?cap=\d/.test(l) && /\(yours\)$/.test(l.trim()))) await cli(ctx, W1, ['tab', 'close', /\[(t\d+)\]/.exec(l)[1]]);
      const back0 = await softWait(async () => (await reg(ctx, W1)).length === ids0.size, 10000, 'the agent to close its own tabs');
      clause(A, 'agent-closes-the-tabs-it-opened', !!back0, `registry ${(await reg(ctx, W1)).length} tabs, was ${ids0.size} before the cap test`);
    }
    o.close();
  },

  async popup(ctx) {
    const { W1, FIX } = ctx; const A = 'popup';
    const baseIds = new Set((await reg(ctx, W1)).map((t) => t.id));
    const flowRegId = (await reg(ctx, W1)).find((t) => /\/flow\.html$/.test(t.url))?.id; // registry id of the human's flow tab (CLI labels are strip positions)
    const list = await cli(ctx, W1, ['tab', 'list']); const flowLabel = labelOf(list, /\/flow\.html/) ?? 't2';
    await cli(ctx, W1, ['tab', flowLabel]);
    const snap = await cli(ctx, W1, ['snapshot', '-i']); const link = refOf(snap.stdout, 'link', 'Open in new tab');
    const before = await reg(ctx, W1);
    const click = await cli(ctx, W1, ['click', link]);
    await sleep(2000);
    const after = await reg(ctx, W1);
    const popupTab = after.find((t) => /\/index\.html\?from=popup$/.test(t.url) && !before.some((b) => b.id === t.id));
    clause(A, 'ctl/popup-link-found-and-clicked', !!link && click.code === 0, `link ref ${link} · ${show(click)}`);
    const policy = fs.readFileSync(path.join(APP_DIR, 'src/shared/browser-tab-policy.ts'), 'utf8');
    const cap = Number(/BROWSER_TAB_CAP\s*=\s*(\d+)/.exec(policy)?.[1]), budget = Number(/POPUP_BUDGET\s*=\s*(\d+)/.exec(policy)?.[1]);
    if (isMerged(396)) {
      const inStrip = popupTab ? !!(await softWait(async () => (await strip(ctx)).find((t) => t.id === popupTab.id), 5000, 'the strip to show the popup tab')) : false;
      clause(A, 'blank-link-becomes-a-tab', after.length === before.length + 1 && !!popupTab && inStrip && popupTab.active, `tabs ${before.length} → ${after.length}; new tab ${JSON.stringify(popupTab && [popupTab.id, popupTab.openedBy, popupTab.active, popupTab.url.slice(-22)])}; in the human strip: ${inStrip}`);
    } else nym(A, 396, 'a target=_blank link opens a new tab (popup → tab)', `tabs ${before.length} → ${after.length}; the link navigated the SAME tab (${after.find((t) => t.active)?.url.slice(-22)})`, 'tabs +1 with /index.html?from=popup, active, shown in the human strip');
    const tidy = async () => { for (const t of await reg(ctx, W1)) if (!baseIds.has(t.id)) await ctx.ui.eval(`window.orchestra.browserTabClose(${sel(W1.id)}, ${sel(t.id)})`).catch(() => {}); if (flowRegId) await ctx.ui.eval(`window.orchestra.browserTabActivate(${sel(W1.id)}, ${sel(flowRegId)})`).catch(() => {}); await sleep(300); };
    if (isMerged(396)) {
      await tidy(); // page-opened tabs belong to the human's opener: the HUMAN closes them (an agent may not)
      // OAuth-style flow: a NAMED, sized popup keeps window.opener (native child window), posts the token back, closes
      const openOp = await cli(ctx, W1, ['open', `${FIX}/popups-opener.html`]);
      const op = await oracle(ctx, `${FIX}/popups-opener.html`);
      clause(A, 'ctl/opener-fixture-loaded', openOp.code === 0 && await softWait(() => op.eval(`!!document.getElementById('status')`), 8000, 'the opener fixture DOM'), `${show(openOp)} · oracle at ${await op.eval('location.href + " " + document.readyState')}`);
      const tabsBase = (await reg(ctx, W1)).length, winsBase = swayWindows(ctx.app.pid).length;
      const press = async (name) => { const sn = await cli(ctx, W1, ['snapshot', '-i']); const r = refOf(sn.stdout, 'button', name); return r ? cli(ctx, W1, ['click', r]) : null; };
      const hold = await press('Sign in \\(popup stays open\\)');
      const signed = await softWait(async () => (await op.eval(`document.getElementById('status').textContent`)) === 'signed-in tok-hold', 15000, 'the OAuth popup to post its token back');
      clause(A, 'oauth-popup-posts-the-token-back-to-window-opener', !!signed, `opener #status=${JSON.stringify(await op.eval(`document.getElementById('status').textContent`))} after the agent's click (${hold && show(hold)}); a same-view handler makes window.open return null → "no-window"`);
      const child = (await ctx.targets()).filter((t) => t.type === 'page' && /popups-oauth\.html/.test(t.url));
      const tabsNow = (await reg(ctx, W1)).length, winsNow = swayWindows(ctx.app.pid).length;
      clause(A, 'oauth-popup-is-a-native-window-not-a-tab', child.length === 1 && tabsNow === tabsBase && winsNow === winsBase + 1, `popup targets ${child.length}; tabs ${tabsBase} → ${tabsNow}; app windows in my sway ${winsBase} → ${winsNow}`);
      if (child[0]) { const cc = await Cdp.connect(child[0].webSocketDebuggerUrl); await cc.send('Runtime.evaluate', { expression: 'window.close()' }, 3000).catch(() => {}); cc.close(); }
      const closed = await softWait(async () => (await op.eval(`document.getElementById('closed').textContent`)) === 'popup-closed' && swayWindows(ctx.app.pid).length === winsBase, 10000, 'the popup to close and the opener to notice');
      clause(A, 'oauth-popup-closes-and-leaves-no-window', !!closed, `opener #closed=${JSON.stringify(await op.eval(`document.getElementById('closed').textContent`))}; app windows ${winsBase} → ${swayWindows(ctx.app.pid).length}`);
      await op.eval(`document.getElementById('status').textContent = 'idle'; document.getElementById('closed').textContent = ''`);
      await press('Sign in \\(popup closes itself\\)');
      const full = await softWait(async () => (await op.eval(`document.getElementById('status').textContent + '|' + document.getElementById('closed').textContent`)) === 'signed-in tok-auto|popup-closed', 15000, 'the unattended OAuth flow');
      clause(A, 'oauth-unattended-flow-posts-back-and-closes-itself', !!full && swayWindows(ctx.app.pid).length === winsBase, `${await op.eval(`document.getElementById('status').textContent + '|' + document.getElementById('closed').textContent`)}; app windows ${winsBase} → ${swayWindows(ctx.app.pid).length}`);
      op.close();
      // popup storm: 20 window.open calls with NO user gesture on load → capped by the page-initiated budget (and the tab cap), no leaked window
      await cli(ctx, W1, ['open', `${FIX}/popups-storm.html?auto=20&kind=tab`]);
      await sleep(3500);
      const storm = await reg(ctx, W1), added = storm.length - tabsBase;
      clause(A, 'popup-storm-is-capped-by-the-budget-and-the-tab-cap', added === Math.min(budget, cap - tabsBase) && storm.length <= cap && swayWindows(ctx.app.pid).length === winsBase, `page-opened tabs +${added} from 20 gesture-less calls (POPUP_BUDGET ${budget}, cap ${cap}); tabs ${tabsBase} → ${storm.length}; app windows ${winsBase} → ${swayWindows(ctx.app.pid).length}`);
      await tidy();
    } else {
      nym(A, 396, 'a window.opener popup (OAuth-style) completes in a native child window', 'not driven: a same-view handler returns null from window.open', '#status "signed-in tok-hold" in the opener, 1 popup target + 1 native window and no new tab, then no window left');
      nym(A, 396, 'a page-initiated popup storm is capped by the budget and the tab cap', 'not driven', `exactly min(POPUP_BUDGET, cap − tabs) page-opened tabs from 20 gesture-less window.open calls, no leaked window`);
      await cli(ctx, W1, ['tab', flowLabel]);
    }
    await cli(ctx, W1, ['open', `${FIX}/flow.html`]); // leave the shared tab where the next arm expects it
  },

  async design(ctx) {
    const { W1, FIX, ui } = ctx; const A = 'design';
    await cli(ctx, W1, ['open', `${FIX}/design-react18.html`]);
    const p = await oracle(ctx, `${FIX}/design-react18.html`);
    const btn = await rectOf(ctx, '[aria-label="Design mode"]');
    clause(A, 'ctl/design-button-exists', !!btn, `toolbar [aria-label="Design mode"] ${JSON.stringify(btn)}`);
    if (!btn) { p.close(); return; }
    await ui.click(btn.x, btn.y);
    await waitFor(() => ui.eval(`document.querySelector('[aria-label="Design mode"]').getAttribute('aria-pressed') === 'true'`), 10000, 'design mode armed in the UI');
    await sleep(600);
    const c = await centreOf(p, '#inc');
    await p.mouse('mouseMoved', c.x - 3, c.y - 3); await p.mouse('mouseMoved', c.x, c.y); await sleep(250); await p.click(c.x, c.y);
    const draft = await softWait(() => ui.eval(`[...document.querySelectorAll('.cm-content')].map((c) => [...c.querySelectorAll('.cm-line')].map((l) => l.textContent).join('\\n')).find((v) => v.includes('Selected element from the browser pane')) || null`), 20000, 'the composer draft');
    clause(A, 'pick-writes-component-file-line-into-the-composer', typeof draft === 'string' && draft.includes('- component: `Counter` — `/fixture/src/Counter.jsx:5`'), `composer draft: ${JSON.stringify(String(draft).slice(0, 220))}`);
    if (await ui.eval(`document.querySelector('[aria-label="Design mode"]')?.getAttribute('aria-pressed') === 'true'`)) await ui.click(btn.x, btn.y);
    p.close();
  },

  async cookies(ctx) {
    const { W1, W2, FIX } = ctx; const A = 'cookies';
    // the HUMAN signs in on W1 by typing the URL; the agent then reads /whoami in W1 (own jar) and in W2 (another workspace)
    await selectWs(ctx, W1); await typeUrl(ctx, `${FIX}/signin`);
    const o = await oracle(ctx, `${FIX}/signin`);
    const sid = (await softWait(() => o.eval(`/signed-in (\\w+)/.exec(document.body.innerText)?.[1] ?? null`), 8000, 'the signin page'));
    const jar = await o.eval(`document.cookie`);
    clause(A, 'ctl/human-signin-sets-the-session-cookie', !!sid && jar.includes(`sid=${sid}`), `sid ${sid} · document.cookie ${JSON.stringify(jar)}`);
    o.close();
    const own = await cli(ctx, W1, ['open', `${FIX}/whoami?w=1`]); const ownTxt = await cli(ctx, W1, ['get', 'text', 'body']);
    clause(A, 'agent-in-the-same-workspace-sees-the-session', own.code === 0 && ownTxt.stdout.trim() === sid, `${show(ownTxt)} (want the sid the human signed in with: ${sid})`);
    await selectWs(ctx, W2); await openPane(ctx);
    const other = await cli(ctx, W2, ['open', `${FIX}/whoami?w=2`]); const otherTxt = await cli(ctx, W2, ['get', 'text', 'body']);
    const o2 = await oracle(ctx, `${FIX}/whoami?w=2`); const body2 = await o2.eval(`document.body.innerText.trim()`); const jar2 = await o2.eval(`document.cookie`); o2.close();
    clause(A, 'agent-in-another-workspace-sees-anon', other.code === 0 && otherTxt.stdout.trim() === 'anon' && body2 === 'anon' && !jar2.includes('sid='), `W2 agent: ${show(otherTxt)} · oracle body ${JSON.stringify(body2)} · W2 document.cookie ${JSON.stringify(jar2)}`);
    ctx.sid = sid;
    await selectWs(ctx, W1);
  },

  async memory(ctx) {
    const { W1, W2, ui } = ctx; const A = 'memory';
    await clickSel(ctx, 'button[aria-label="Open the Resources page"]');
    await waitFor(() => ui.eval(`!!document.querySelector('.res-page')`), 10000, 'the Resources page');
    const snapOf = () => ui.eval(`window.orchestra.sampleResources()`);
    const s = await waitFor(async () => { const x = await snapOf(); return x.browserTabs?.byWorkspace?.some((w) => w.wsId === W1.id && w.bytes > 0) ? x : null; }, 20000, 'the sampler to bill W1 tabs').catch(async () => snapOf());
    const w1 = s.browserTabs?.byWorkspace?.find((w) => w.wsId === W1.id), w2 = s.browserTabs?.byWorkspace?.find((w) => w.wsId === W2.id);
    const regTabs = (await reg(ctx, W1)).length;
    clause(A, 'resources-bills-the-open-tabs-to-the-workspace', !!w1 && w1.tabs === regTabs && w1.bytes > 20 * MB && !!w2, `W1 ${JSON.stringify(w1)} (registry tabs ${regTabs}) · W2 ${JSON.stringify(w2)}`);
    const sum = (s.browserTabs?.byWorkspace ?? []).reduce((n, w) => n + (w.bytes ?? 0), 0), rss = (s.browserTabs?.attributedPids ?? []).reduce((n, p) => n + (vmRss(p) ?? 0), 0);
    clause(A, 'oracle-proc-vmrss-agrees', rss > 0 && sum / rss > 0.6 && sum / rss < 1.5, `Σ billed ${(sum / MB).toFixed(0)} MB vs Σ /proc VmRSS of the billed renderers ${(rss / MB).toFixed(0)} MB (ratio ${(sum / (rss || 1)).toFixed(2)}, accepted 0.6–1.5; pids ${JSON.stringify(s.browserTabs?.attributedPids)})`);
    const row = await softWait(() => ui.eval(`(() => { const r = document.querySelector('.res-agent-row[data-res-ws=${sel(W1.id)}]'); const c = r && r.querySelector('[data-res-tabs]'); return c ? { tabs: c.getAttribute('data-res-tabs'), bytes: c.getAttribute('data-res-tabs-bytes'), text: c.textContent.trim() } : null; })()`), 12000, 'the rendered W1 row chip');
    clause(A, 'resources-row-chip-shows-the-tabs', !!row && Number(row.tabs) === regTabs && Number(row.bytes) > 20 * MB, `rendered chip ${JSON.stringify(row)}`);
    saveShot('flow-resources.png', Buffer.from((await ui.send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
  },

  async keyring(ctx) {
    const { ui } = ctx; const A = 'keyring';
    const st = await ui.eval(`window.orchestra.getSecretsState()`);
    clause(A, 'ctl/isolated-home-never-probes-the-real-keyring', st.encrypted === false && st.selectionReason === 'isolated-instance', `getSecretsState ${JSON.stringify(st)}`);
    await clickSel(ctx, '[aria-label="Claude accounts settings"]');
    await waitFor(() => ui.eval(`!!document.querySelector('[aria-label="Claude accounts"] .account-card')`), 10000, 'the Accounts dialog rows');
    await sleep(800);
    const n = await ui.eval(`(() => { const x = document.querySelector('[aria-label="Claude accounts"] [data-secrets-notice]'); return x ? { kind: x.getAttribute('data-secrets-notice'), text: x.textContent.trim() } : null; })()`);
    clause(A, 'settings-shows-the-unencrypted-notice', !!n && n.kind === 'unencrypted' && /stored unencrypted on this machine/.test(n.text) && /isolated home \(ORCHESTRA_HOME\)/.test(n.text), `notice ${JSON.stringify(n)}`);
    saveShot('flow-accounts-dialog.png', Buffer.from((await ui.send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
    await ui.click(4, 4);
    await softWait(async () => !(await rectOf(ctx, '[aria-label="Claude accounts"]')), 5000, 'the dialog to close');
  },

  async legacy(ctx) {
    const A = 'legacy', src = fs.readFileSync(chunkOf(APP_DIR), 'utf8'), needle = 'Drive the embedded Browser pane for this workspace';
    const n = src.split(needle).length - 1, ctlN = src.split('Page.captureScreenshot').length - 1;
    clause(A, 'ctl/instrument-finds-strings-in-the-chunk', ctlN > 0, `control string "Page.captureScreenshot" found ${ctlN}x in ${path.basename(chunkOf(APP_DIR))}`);
    if (isMerged(399)) clause(A, 'legacy-mcp-browser-server-is-gone', n === 0, `the in-process "browser" MCP server's instructions string occurs ${n}x in the built chunk (want 0)`);
    else nym(A, 399, 'the mcp__browser__* tools are removed from the agent session', `the in-process browser MCP server is still built in (${n}x)`, 'the server instructions string absent from the built chunk and the browser CLI skill shipped');
  },

  async restart(ctx) {
    const { W1, FIX } = ctx; const A = 'restart';
    await selectWs(ctx, W1);
    const before = await reg(ctx, W1), humanBefore = before.filter((t) => t.openedBy === 'human' && /^https?:/.test(t.url));
    ctx.ui.close(); await stopApp(ctx); await sleep(1500);
    await startApp(ctx, 'restart');
    await selectWs(ctx, W1); await openPane(ctx);
    const after = await softWait(async () => { const r = await reg(ctx, W1); return r.length >= humanBefore.length && r.some((t) => t.url) ? r : null; }, 20000, 'the tabs to be restored');
    const got = after ?? await reg(ctx, W1);
    clause(A, 'human-tabs-restored-after-restart', humanBefore.length > 0 && humanBefore.every((t) => got.some((g) => g.openedBy === 'human' && g.url === t.url)), `before (human, with url) ${JSON.stringify(humanBefore.map((t) => t.url.slice(-22)))} · after ${JSON.stringify(got.map((t) => [t.id, t.openedBy, t.url.slice(-22)]))}`);
    await cli(ctx, W1, ['open', `${FIX}/whoami?w=1`]); const txt = await cli(ctx, W1, ['get', 'text', 'body']);
    clause(A, 'default-ephemeral-is-signed-out-after-restart', ctx.sid && txt.stdout.trim() === 'anon', `before the restart the same workspace read sid ${ctx.sid}; after: ${show(txt)}`);
  },

  async profile(ctx) {
    const A = 'profile';
    const specs = [
      [400, 'a profil navigateur is created in Settings, attached from the URL bar; its workspace stays signed in across a restart, a workspace without it stays signed out; deleting it detaches + clears', 'ephemeral per-workspace partitions only (partitionFor); a workspace signed out after every restart (asserted above)', 'agent in the profile workspace reads the sid on /whoami after restart (own site only), a second workspace reads anon, no CLI verb attaches a profile, creating one while secrets are unencrypted shows the warning'],
      [401, 'orchestra spawn passes a profil navigateur the parent holds (refused otherwise, worker stays ephemeral)', 'no spawn argument', 'the worker panel signed in with the passed profile; a refused pass leaves it ephemeral with a clear message'],
    ];
    for (const [t, what, today, planned] of specs) {
      if (isMerged(t)) clause(A, `#${t} merged — drive clause body`, false, `#${t} is merged but this drive has no clause body for it yet — write it against the merged UI (scripts/e2e-browser-whole-flow.mjs, arm profile)`);
      else nym(A, t, what, today, planned);
    }
  },
};

async function main() {
  const armDir = path.join(RIG_DIR, 'world'); fs.mkdirSync(armDir, { recursive: true });
  const world = seedWorld(armDir), [W1, W2] = world.workspaces;
  const fixture = spawn(process.execPath, [path.join(fs.existsSync(path.join(APP_DIR, 'scripts/fixtures/browser-site/server.mjs')) ? APP_DIR : repoRoot, 'scripts/fixtures/browser-site/server.mjs'), '0'], { env: { PATH: process.env.PATH }, stdio: ['ignore', 'pipe', 'inherit'] });
  const FIX = await new Promise((res, rej) => { let b = ''; fixture.stdout.on('data', (d) => { b += d; const m = /LISTENING (\d+)/.exec(b); if (m) res(`http://127.0.0.1:${m[1]}`); }); fixture.on('exit', () => rej(new Error('fixture exited'))); setTimeout(() => rej(new Error('fixture never listened')), 8000); });
  console.log(`[rig] fixture ${FIX}`);
  sh('swaymsg', ['output', 'HEADLESS-1', 'resolution', '1400x900']); sh('swaymsg', ['default_border', 'none']);
  const ctx = { world, W1, W2, FIX };
  try {
    const target = await startApp(ctx, 'boot');
    clause('ctl', 'app-identity-path', target.url.includes(APP_DIR) && !target.url.includes('app.asar'), `target url ${target.url} ⊇ ${APP_DIR}`);
    clause('ctl', 'scratch-env', ctx.env.ORCHESTRA_HOME === world.ohome && ctx.env.CLAUDE_CONFIG_DIR === world.cfg && ctx.env.HOME === world.fakeHome && !('DISPLAY' in ctx.env) && ctx.env.WAYLAND_DISPLAY === RIG_WAYLAND && ctx.env.XDG_RUNTIME_DIR === privateRuntimeDir() && ctx.env.DBUS_SESSION_BUS_ADDRESS.includes(RIG_DIR),
      `env handed to the app: ORCHESTRA_HOME=${ctx.env.ORCHESTRA_HOME} WAYLAND_DISPLAY=${ctx.env.WAYLAND_DISPLAY} DISPLAY=<unset> XDG_RUNTIME_DIR=${ctx.env.XDG_RUNTIME_DIR} (driver-side: the app's own /proc environ is blind)`);
    clause('ctl', 'app-in-my-sway', new RegExp(`"pid":\\s*${ctx.app.pid}\\b`).test(sh('swaymsg', ['-t', 'get_tree'])), `app pid ${ctx.app.pid} present in my sway's get_tree`);
    { const newest = (d) => fs.readdirSync(d, { withFileTypes: true }).reduce((m, e) => Math.max(m, e.isDirectory() ? newest(path.join(d, e.name)) : /\.test\.ts$/.test(e.name) ? 0 : fs.statSync(path.join(d, e.name)).mtimeMs), 0);
      const built = fs.statSync(chunkOf(APP_DIR)).mtimeMs, src = newest(path.join(APP_DIR, 'src')); let head = '?'; try { head = sh('git', ['-C', APP_DIR, 'rev-parse', '--short', 'HEAD']).trim(); } catch { /* not a git dir */ }
      clause('ctl', 'build-is-newer-than-every-source-file', built > src, `built chunk ${new Date(built).toISOString()} vs newest non-test src file ${new Date(src).toISOString()} (HEAD ${head})`); }
    { const known = [403, 389].map((n) => [n, isMerged(n)]), open = [396, 397, 399, 400, 401].map((n) => [n, isMerged(n)]);
      clause('ctl', 'merge-detector-audited', known.every(([, m]) => m) || FORCE_MERGED.size > 0, `merged per \`git log --grep '^Merge #n'\` in ${APP_DIR}: control-known-merged ${JSON.stringify(known)} (want all true) · wave tickets ${JSON.stringify(open)}`); }
    for (const arm of ARM_LIST) {
      console.log(`\n== arm ${arm} ==`);
      try { await ARM_FNS[arm](ctx); } catch (e) { clause(arm, 'arm-completed', false, `ARM ABORTED: ${e.stack || e}`); }
    }
  } catch (e) {
    clause('rig', 'completed', false, `ABORTED: ${e.stack || e}`);
  } finally {
    try { await stopApp(ctx); } catch { /* nothing started */ }
    try { fixture.kill('SIGKILL'); } catch { /* gone */ }
    { const l = abLayout(world.ohome, process.env.XDG_RUNTIME_DIR); // daemons a refused-then-leaked run may have left, then the scratch socket dir of THIS ORCHESTRA_HOME only
      for (const pid of Object.values(daemonPids(world))) if (environOf(pid)?.includes(`AGENT_BROWSER_SOCKET_DIR=${l.socketDir}`)) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
      if (/\/orch-ab-[0-9a-f]{8}$/.test(l.socketDir) && l.socketDir.startsWith((process.env.XDG_RUNTIME_DIR ?? '/nonexistent') + '/')) fs.rmSync(l.socketDir, { recursive: true, force: true }); }
    for (const p of listProcsByHome(world.ohome)) { try { process.kill(p, 'SIGKILL'); } catch { /* gone */ } }
    let left = listProcsByHome(world.ohome);
    for (let i = 0; i < 20 && left.length > 0; i++) { await sleep(250); left = listProcsByHome(world.ohome); }
    clause('ctl', 'teardown-no-survivors', left.length === 0, `processes still carrying ${world.ohome}: ${left.length ? left.join(',') : 'none'}`);
  }
}

// ── live-dir canary: independent tool (find) + json, before/after ──────────────────────────────────────────────────────────────
function liveCanary() {
  const snap = {};
  for (const d of fs.readdirSync(LIVE_HOME).filter((n) => n === '.claude' || n.startsWith('.claude-')).map((n) => path.join(LIVE_HOME, n))) {
    let links = ''; try { links = sh('find', [d, '-maxdepth', '1', '-type', 'l', '-printf', '%f->%l\\n']).split('\n').sort().join('|'); } catch { /* unreadable */ }
    let mcp = ''; for (const f of [path.join(d, '.claude.json'), path.join(LIVE_HOME, '.claude.json')]) { try { mcp += Object.keys(JSON.parse(fs.readFileSync(f, 'utf8')).mcpServers || {}).sort().join(',') + ';'; } catch { /* absent */ } }
    snap[d] = md5(links) + ':' + md5(mcp);
  }
  snap['agent-browser dot-dir in the real home'] = fs.existsSync(path.join(LIVE_HOME, '.agent' + '-browser')) ? 'exists' : 'absent';
  return snap;
}
const before = liveCanary();
console.log(`[rig] app ${APP_DIR} arms ${ARM_LIST.join(',')} mutant=${MUTANT ?? 'none'} require-all=${REQUIRE_ALL} out=${OUT}`);
applyMutant();
await main();
const after = liveCanary(), same = JSON.stringify(before) === JSON.stringify(after);
clause('ctl', 'live-dirs-untouched', same, `${Object.keys(before).length} live probes ${same ? 'identical before/after' : 'CHANGED: ' + JSON.stringify({ before, after })}`);

// ── verdict ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const isCtl = (c) => c.arm === 'ctl' || c.clause.startsWith('ctl/');
const red = results.filter((c) => !c.ok), nyms = results.filter((c) => c.nym);
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify({ app: APP_DIR, mutant: MUTANT, requireAll: REQUIRE_ALL, results, shots }, null, 2));
let verdict, rc;
if (MUTANT) {
  const want = MUTANTS[MUTANT].clauses, redNames = new Set(red.map((c) => c.clause)), missed = want.filter((n) => !redNames.has(n)), ctlRed = red.filter(isCtl);
  ({ verdict, rc } = ctlRed.length === 0 && missed.length === 0
    ? { verdict: `MUTANT ${MUTANT} KILLED on clause(s) ${want.join(', ')}; every control green; other red clauses: ${red.filter((c) => !want.includes(c.clause)).map((c) => c.clause).join(', ') || 'none'}`, rc: 0 }
    : { verdict: `MUTANT ${MUTANT} SURVIVED/INVALID: named clause(s) not red: ${missed.join(', ') || 'none'}; controls red: ${ctlRed.map((c) => c.clause).join('; ') || 'none'}`, rc: 1 });
} else {
  const note = nyms.length ? ` · ${nyms.length} NOT YET MERGED (${[...new Set(nyms.map((c) => `#${c.ticket}`))].join(' ')}): deferred, NOT passed` : '';
  ({ verdict, rc } = red.length === 0 ? { verdict: `ALL GREEN: ${results.length - nyms.length} clauses (${results.filter(isCtl).length} controls)${note}`, rc: 0 } : { verdict: `RED: ${red.map((c) => `${c.arm}:${c.clause}`).join('; ')}${note}`, rc: 1 });
}
console.log(`\nVERDICT: ${verdict}`);
process.exit(process.exitCode || rc);
