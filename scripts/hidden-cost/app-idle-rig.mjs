#!/usr/bin/env node
// C2 #209 — WHOLE-APP idle cost rig: boot the BUILT Orchestra (dist/ + dist-electron/) with N seeded workspaces
// (real git worktrees, no agents) inside a network+pid namespace, an LD_PRELOAD exec/connect/DNS logger and a
// scratch HOME, then measure what it does when NOTHING is happening: process spawns by argv, DNS/connect attempts
// (all refused by the netns), CPU per process class, log volume. Zero tokens (D6): no `claude` API path exists
// here (stub `claude`), and no network exists at all.
//
// Run through the contained rig (own sway, env allowlist, scratch HOME/ORCHESTRA_HOME) — never directly:
//   bash scripts/hidden-cost/app-idle-rig.sh [--ws 8] [--warm 20] [--measure 180] [--label x] [--hidden 0]
// Positive controls (asserted, VOID otherwise): the LD_PRELOAD log received the app's OWN `git` spawns; the
// seeded gh stub was invoked (linked-PR poll reached the real code path); >= N sidebar rows mounted in the DOM;
// document.visibilityState read back over CDP for every window.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { assertScratch } from '../session-budget/scratch-guard.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const N = Number(opt('ws', '8'));
const WARM_S = Number(opt('warm', '20'));
const MEASURE_S = Number(opt('measure', '180'));
const HIDDEN_S = Number(opt('hidden', '0'));
const FAKE_NET = opt('fake-net', '0') === '1';  // seed a FAKE oauth token + FAKE Linear key so the app's network pollers run (and are counted by DNS/connect attempts in the netns)
const RUNNING = Number(opt('running', '0'));   // K sidebar rows driven to status=running through the REAL events spool
const LABEL = opt('label', `ws${N}`);
const CLK = 100; // getconf CLK_TCK, asserted below
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const die = (m) => { console.error(`[hc-rig] ABORT: ${m}`); process.exit(90); };
const log = (m) => console.error(`[hc-rig] ${m}`);

// ── D7 preflight + scratch guard ───────────────────────────────────────────
const load1 = Number(fs.readFileSync('/proc/loadavg', 'utf8').split(' ')[0]);
const memAvailKB = Number(/MemAvailable:\s+(\d+)/.exec(fs.readFileSync('/proc/meminfo', 'utf8'))[1]);
if (load1 > 20) die(`load ${load1} > 20 (D7)`);
if (memAvailKB < 6 * 1024 * 1024) die(`MemAvailable ${Math.round(memAvailKB / 1024)} MB < 6 GB (D7)`);
if (execFileSync('getconf', ['CLK_TCK'], { encoding: 'utf8' }).trim() !== String(CLK)) die('CLK_TCK != 100');
const EXECLOG_SO = opt('so', '');
for (const k of ['ORCHESTRA_HOME', 'HOME', 'RIG_DIR', 'RIG_WAYLAND', 'SWAYSOCK']) if (!process.env[k]) die(`${k} unset — run via scripts/hidden-cost/app-idle-rig.sh`);
if (!EXECLOG_SO || !fs.existsSync(EXECLOG_SO)) die(`--so <execlog.so> missing (${EXECLOG_SO})`);
const RIG_DIR = process.env.RIG_DIR;
const HOME = process.env.HOME;
const OHOME = process.env.ORCHESTRA_HOME;
// `live` is computed by the wrapper from the INVOKER's real env (inside the rig HOME is already scratch, so liveDirs() here would be blind).
const live = JSON.parse(opt('live', 'null') ?? 'null');
if (!Array.isArray(live) || live.length === 0) die('--live <json list of live dirs> missing/empty — run via app-idle-rig.sh');
const cfgDir = path.join(OHOME, 'claude-config');
for (const [l, p] of [['HOME', HOME], ['ORCHESTRA_HOME', OHOME], ['configDir', cfgDir]]) assertScratch(l, p, RIG_DIR, live);
if (process.env.RIG_WAYLAND === 'wayland-1') die('refusing wayland-1');
if (process.env.DISPLAY) die('DISPLAY is set');
fs.mkdirSync(cfgDir, { recursive: true });
if (FAKE_NET) fs.writeFileSync(path.join(cfgDir, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'sk-ant-oat01-FAKE-hidden-cost-not-a-token', refreshToken: 'FAKE', expiresAt: Date.now() + 8 * 3600e3 } }));

const OUT = path.join(RIG_DIR, `out-${LABEL}`);
fs.mkdirSync(OUT, { recursive: true });
const EXECLOG = path.join(OUT, 'execlog.txt');
fs.writeFileSync(EXECLOG, '');

// ── seed: bare origin, a main clone, N real worktrees ──────────────────────
const git = (cwd, ...a) => execFileSync('git', ['-c', 'user.name=fixture', '-c', 'user.email=fixture@invalid', '-c', 'commit.gpgsign=false', ...a], { cwd, stdio: 'pipe', encoding: 'utf8', env: { PATH: '/usr/bin:/bin', HOME, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } });
const repoDir = path.join(OHOME, 'repos', 'fixture');
const originDir = path.join(OHOME, 'repos', 'origin.git');
fs.mkdirSync(originDir, { recursive: true });
git(originDir, 'init', '-q', '--bare', '-b', 'main');
fs.mkdirSync(repoDir, { recursive: true });
git(repoDir, 'init', '-q', '-b', 'main');
for (let d = 0; d < 20; d++) {
  fs.mkdirSync(path.join(repoDir, `pkg${d}`), { recursive: true });
  for (let f = 0; f < 15; f++) fs.writeFileSync(path.join(repoDir, `pkg${d}`, `f${f}.ts`), `export const v${d}_${f} = ${d * 100 + f};\n`.repeat(20));
}
git(repoDir, 'add', '-A'); git(repoDir, 'commit', '-q', '-m', 'base');
git(repoDir, 'remote', 'add', 'origin', originDir);
git(repoDir, 'push', '-q', 'origin', 'main');
git(repoDir, 'fetch', '-q', 'origin');
const workspaces = [];
const account = { id: 'rig-hc', label: 'rig (scratch config dir)', configDir: cfgDir };
for (let i = 0; i < N; i++) {
  const wt = path.join(OHOME, 'wt', `ws-${i}`);
  git(repoDir, 'worktree', 'add', '-q', '-b', `hc/ws-${i}`, wt, 'main');
  fs.writeFileSync(path.join(wt, `change-${i}.txt`), `unpushed ${i}\n`);
  git(wt, 'add', '.'); git(wt, 'commit', '-q', '-m', `hc unpushed ${i}`);
  fs.writeFileSync(path.join(wt, 'pkg0', 'f0.ts'), `// dirty ${i}\n`);
  workspaces.push({
    id: `ws-hc-${i}`, name: `hc-${i}`, repoPath: repoDir, worktreePath: wt, branch: `hc/ws-${i}`, baseBranch: 'main',
    createdAt: Date.now() - (i + 1) * 60_000, status: 'idle', agent: 'claude', accountId: account.id,
    linkedPrs: [{ url: `https://github.com/fixture/repo/pull/${100 + i}`, owner: 'fixture', repo: 'repo', number: 100 + i }],
  });
}
const storeDir = path.join(OHOME, 'userData', 'orchestra');
fs.mkdirSync(storeDir, { recursive: true });
fs.writeFileSync(path.join(storeDir, 'store.json'), JSON.stringify({ repos: [{ path: repoDir, name: 'fixture', defaultBranch: 'main', accountId: account.id }], workspaces, accounts: [account], selfTuneRuns: [] }, null, 2));

// stubs: gh answers the linked-PR poll + repo-wide list calls (logs every argv), claude sleeps (logs argv), xdg-open no-ops.
const stubDir = path.join(OHOME, 'stub-bin');
fs.mkdirSync(stubDir, { recursive: true });
const q = (f) => `'${path.join(OUT, f)}'`;
fs.writeFileSync(path.join(stubDir, 'gh'), `#!/bin/sh\necho "$(date +%s%3N) $*" >> ${q('gh-calls.log')}\ncase "$*" in\n  *pulls/*) echo '{"url":"https://github.com/fixture/repo/pull/1","number":1,"title":"fixture pr","state":"OPEN"}';;\n  *) : ;; # releases/actions use --jq: an empty list prints NOTHING (a literal [] made the app rev-parse a tag named "undefined")\nesac\nexit 0\n`, { mode: 0o755 });
fs.writeFileSync(path.join(stubDir, 'claude'), `#!/bin/sh\necho "$(date +%s%3N) $$ $*" >> ${q('claude-stub.log')}\nsleep 3600\n`, { mode: 0o755 });
fs.writeFileSync(path.join(stubDir, 'xdg-open'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });

// ── launch the built app ────────────────────────────────────────────────────
const electron = path.join(REPO, 'node_modules', 'electron', 'dist', 'electron');
for (const f of ['dist/index.html', 'dist-electron/main.js', 'dist-electron/keeper.js']) if (!fs.existsSync(path.join(REPO, f))) die(`build artifact missing: ${f} (run pnpm run build:bundles)`);
const pkgVersion = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')).version;
const port = 9300 + (process.pid % 500);
const env = {
  PATH: `${stubDir}:/usr/local/bin:/usr/bin:/bin`, HOME, XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR, XDG_CONFIG_HOME: path.join(HOME, '.config'), XDG_CACHE_HOME: path.join(HOME, '.cache'),
  WAYLAND_DISPLAY: process.env.RIG_WAYLAND, SWAYSOCK: process.env.SWAYSOCK, LANG: 'C.UTF-8',
  ELECTRON_OZONE_PLATFORM_HINT: 'wayland', ORCHESTRA_OZONE: 'wayland', ORCHESTRA_OZONE_RELAUNCHED: '1',
  ORCHESTRA_HOME: OHOME, ORCHESTRA_DEBUG_PORT: String(port), ORCHESTRA_SELF_TUNE_CMD: '/bin/true', CLAUDE_CONFIG_DIR: cfgDir,
  LD_PRELOAD: EXECLOG_SO, EXECLOG_FILE: EXECLOG, ...(FAKE_NET ? { LINEAR_API_KEY: 'lin_api_FAKE_hidden_cost_not_a_key' } : {}),
};
if (env.DISPLAY || env.APPIMAGE) die('env carries DISPLAY/APPIMAGE');
for (const k of ['HOME', 'ORCHESTRA_HOME', 'CLAUDE_CONFIG_DIR']) assertScratch(k, env[k], RIG_DIR, live);
const appLog = fs.openSync(path.join(OUT, 'app.stdout.log'), 'w');
const tLaunch = Date.now();
const child = spawn(electron, [REPO, '--ozone-platform=wayland', '--no-sandbox'], { cwd: REPO, env, stdio: ['ignore', appLog, appLog] });
let exited = false;
child.on('exit', (c, s) => { exited = true; log(`electron exited code=${c} sig=${s}`); });
log(`launched electron pid=${child.pid} port=${port} N=${N} version=${pkgVersion}`);

// ── /proc sampler (whole pid namespace) ────────────────────────────────────
function readProc(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const rp = stat.lastIndexOf(')');
    const f = stat.slice(rp + 2).split(' ');
    const cmd = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean);
    let rssKB = 0; try { rssKB = Number(fs.readFileSync(`/proc/${pid}/statm`, 'utf8').split(' ')[1]) * 4; } catch { /* gone */ }
    return { pid, ppid: Number(f[1]), state: f[0], utime: Number(f[11]), stime: Number(f[12]), cutime: Number(f[13]), cstime: Number(f[14]), startTicks: Number(f[19]), cmd, rssKB };
  } catch { return null; }
}
function classify(p) {
  const line = p.cmd.join(' ');
  if (p.pid === child.pid) return 'electron-main';
  const ty = /--type=([a-z-]+)/.exec(line);
  if (ty && /electron|chrome/.test(p.cmd[0] ?? '')) return `electron-${ty[1]}`;
  if (/(^|\/)electron$/.test(p.cmd[0] ?? '')) return 'electron-other';
  if (/keeper\.js/.test(line)) return 'keeper';
  if (/(^|\/)claude$/.test(p.cmd[0] ?? '') || /stub-bin\/claude/.test(line) || /sleep 3600/.test(line)) return 'claude-stub';
  return 'other';
}
const snap = () => { const out = []; for (const d of fs.readdirSync('/proc')) if (/^\d+$/.test(d)) { const p = readProc(Number(d)); if (p) out.push(p); } return out; };
const selfAnc = new Set([process.pid]);
for (let pp = readProc(process.pid); pp && pp.ppid > 0 && !selfAnc.has(pp.ppid); pp = readProc(pp.ppid)) selfAnc.add(pp.ppid);
const inTree = (all) => all.filter((p) => p.pid !== 1 && !selfAnc.has(p.pid));
function cpuTable() {
  const all = inTree(snap());
  const t = {};
  let rss = 0; const seen = {};
  for (const p of all) {
    const c = classify(p);
    t[c] = t[c] ?? { own: 0, kids: 0, n: 0, rssKB: 0 };
    t[c].own += p.utime + p.stime; t[c].kids += p.cutime + p.cstime; t[c].n++; t[c].rssKB += p.rssKB;
    rss += p.rssKB; seen[p.pid] = c;
  }
  return { t, rss, nProcs: all.length };
}

// ── CDP ─────────────────────────────────────────────────────────────────────
async function cdpConnect(url) {
  const ws = new WebSocket(url);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws error')); });
  let id = 0; const pend = new Map();
  ws.onmessage = (m) => { const d = JSON.parse(m.data); const p = pend.get(d.id); if (p) { pend.delete(d.id); d.error ? p.rej(new Error(JSON.stringify(d.error))) : p.res(d.result); } };
  const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pend.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); setTimeout(() => { if (pend.delete(i)) rej(new Error(`cdp timeout ${method}`)); }, 20_000); });
  const evaluate = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 300)); return r.result.value; };
  return { send, evaluate, close: () => ws.close() };
}
async function waitFor(what, fn, ms, every = 250) { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error(`timeout waiting for ${what}`); await sleep(every); } }

let cdp = null;
const result = { label: LABEL, ws: N, fakeNet: FAKE_NET, pkgVersion, warmS: WARM_S, measureS: MEASURE_S, void: [] };
try {
  const target = await waitFor('CDP target', async () => {
    if (exited) throw new Error('electron exited early');
    try { const j = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); return j.find((x) => x.type === 'page' && x.url.includes('dist/index.html')); } catch { return null; }
  }, 45_000, 300);
  if (!target.url.includes(REPO)) die(`CDP target ${target.url} is not this worktree's build`);
  cdp = await cdpConnect(target.webSocketDebuggerUrl);
  try {
    await waitFor('sidebar rows', async () => cdp.evaluate(`!!document.body && document.body.innerText.includes('hc/ws-0')`).catch(() => false), 40_000, 400);
  } catch (e) {
    result.domText = String(await cdp.evaluate('document.body ? document.body.innerText : "no body"').catch(() => 'n/a')).slice(0, 1500);
    fs.writeFileSync(path.join(OUT, 'dom-on-failure.txt'), String(result.domText));
    throw e;
  }
  const tUiReady = Date.now();
  result.bootToUiMs = tUiReady - tLaunch;
  const rowsSeen = await cdp.evaluate(`[...Array(${N}).keys()].filter(i => document.body.innerText.includes('hc/ws-' + i)).length`);
  result.rowsMounted = rowsSeen;
  if (rowsSeen < N) log(`WARNING: only ${rowsSeen}/${N} workspace names present in DOM text`);

  // windows: warm (discarded), steady (visible), optional hidden
  const windows = [];
  async function measure(name, seconds) {
    const vis = await cdp.evaluate('document.visibilityState');
    const t0 = Date.now(); const c0 = cpuTable(); const log0 = fs.statSync(EXECLOG).size;
    const ol = path.join(OHOME, 'logs', 'orchestra.log'); const ol0 = fs.existsSync(ol) ? fs.statSync(ol).size : 0;
    await sleep(seconds * 1000);
    const t1 = Date.now(); const c1 = cpuTable(); const vis1 = await cdp.evaluate('document.visibilityState');
    const ol1 = fs.existsSync(ol) ? fs.statSync(ol).size : 0;
    const anims = await cdp.evaluate('document.getAnimations().length').catch(() => null);
    const w = { name, seconds: (t1 - t0) / 1000, visibilityStart: vis, visibilityEnd: vis1, runningCssAnimations: anims, t0, t1, execlogBytes0: log0, orchestraLogBytes: ol1 - ol0, rssKB: c1.rss, nProcs: c1.nProcs, cpu: {} };
    for (const k of new Set([...Object.keys(c0.t), ...Object.keys(c1.t)])) {
      const a = c0.t[k] ?? { own: 0, kids: 0 }, b = c1.t[k] ?? { own: 0, kids: 0 };
      w.cpu[k] = { ownCpuS: (b.own - a.own) / CLK, waitedKidsCpuS: (b.kids - a.kids) / CLK, n: b.n ?? 0, rssKB: b.rssKB ?? 0 };
    }
    windows.push(w);
    return w;
  }
  log(`UI ready after ${result.bootToUiMs} ms; warm ${WARM_S}s`);
  await measure('warm', WARM_S);
  await measure('steady-visible', MEASURE_S);
  if (RUNNING > 0) {
    // Drive K rows to `running` exactly as the hook does: append {"event":"submit"} to <events>/<wsid>.jsonl (the app's spool reader tails it).
    const evDir = path.join(OHOME, 'events');
    fs.mkdirSync(evDir, { recursive: true });
    for (let i = 0; i < Math.min(RUNNING, N); i++) fs.appendFileSync(path.join(evDir, `ws-hc-${i}.jsonl`), '{"seq":1,"event":"submit","tool":"","toolUseId":"","transcript":"","crons":""}\n');
    const spinning = await waitFor('running rows', async () => { const n = await cdp.evaluate(`document.querySelectorAll('.ws-glyph-spin, .ws-dot.running').length`); return n >= Math.min(RUNNING, N) ? n : 0; }, 25_000, 400).catch(() => 0);
    result.runningRowsRendered = spinning;
    if (spinning) await measure('steady-running', Math.max(60, Math.floor(MEASURE_S / 2)));
    else result.void = [...(result.void ?? []), `${RUNNING} rows were not rendered as running (no .ws-glyph-spin/.ws-dot.running)`];
  }
  if (HIDDEN_S > 0) {
    // Hide the window by MY sway's own socket, then PROVE it: sway's get_tree says visible=false for the window whose pid is the app's.
    const swayEnv = { PATH: '/usr/bin:/bin', SWAYSOCK: process.env.SWAYSOCK, XDG_RUNTIME_DIR: env.XDG_RUNTIME_DIR };
    // MY sway holds exactly one window (the app's). pid criteria cannot be used: sway sees the HOST pid, the rig the namespaced one.
    const treeOf = () => { const t = JSON.parse(execFileSync('swaymsg', ['-t', 'get_tree'], { env: swayEnv, encoding: 'utf8' })); const hits = []; const walk = (n) => { const kids = [...(n.nodes ?? []), ...(n.floating_nodes ?? [])]; if ((n.type === 'con' || n.type === 'floating_con') && kids.length === 0 && n.pid) hits.push(n); for (const c of kids) walk(c); }; walk(t); return hits.map((n) => ({ visible: n.visible, focused: n.focused, app_id: n.app_id, name: n.name })); };
    let before = null, after = null, mv = null;
    try {
      before = treeOf();
      if (before.length !== 1) throw new Error(`expected exactly 1 window in my sway, saw ${before.length}`);
      mv = execFileSync('swaymsg', ['move scratchpad'], { env: swayEnv, encoding: 'utf8' }).trim();
      await sleep(2000);
      after = treeOf();
    } catch (e) { log(`swaymsg hide failed: ${String(e.message).slice(0, 160)}`); }
    result.hideProof = { before, moveResult: mv, after };
    await measure('steady-hidden', HIDDEN_S);
    if (!after || !after.length || after.some((n) => n.visible !== false)) result.void.push(`hidden window: sway did not report the app window visible=false (${JSON.stringify(after)})`);
  }
  result.windows = windows;
  result.timeAt = windows.map((w) => ({ name: w.name, t0: w.t0, t1: w.t1 }));
  result.versionFromApp = await cdp.evaluate(`(window.orchestra && window.orchestra.getAppVersion) ? window.orchestra.getAppVersion() : null`).catch(() => null);
} catch (e) {
  result.error = String(e?.stack ?? e);
} finally {
  try { cdp?.close(); } catch { /* */ }
  // teardown: term, then kill anything left in the namespace (bwrap --die-with-parent also reaps)
  try { process.kill(child.pid, 'SIGTERM'); } catch { /* gone */ }
  await sleep(3000);
  for (const p of inTree(snap())) if (p.pid !== process.pid) { try { process.kill(p.pid, 'SIGKILL'); } catch { /* */ } }
}

// ── post-process the exec/connect log ──────────────────────────────────────
const lines = fs.readFileSync(EXECLOG, 'utf8').split('\n').filter(Boolean);
// The shim's clock is CLOCK_MONOTONIC ms; anchor to wall clock through a line the shim wrote now.
const monoNowMs = Number((fs.readFileSync('/proc/uptime', 'utf8').split(' ')[0])) * 1000; // uptime ≈ CLOCK_MONOTONIC (ms) on Linux
const wallNow = Date.now();
const toWall = (mono) => wallNow - (monoNowMs - mono);
function keyOf(argv0, rest) {
  const base = path.basename(argv0);
  if (base === 'git') {
    const a = [...rest]; const skipVal = new Set(['-C', '-c', '--git-dir', '--work-tree', '--exec-path']);
    for (let i = 0; i < a.length; i++) { if (skipVal.has(a[i])) { i++; continue; } if (a[i].startsWith('-')) continue; return `git ${a[i]}`; }
    return 'git';
  }
  if (base === 'gh') return `gh ${rest.filter((x) => !x.startsWith('-')).slice(0, 2).join(' ').replace(/\d+/g, 'N').replace(/[\w.-]+\/[\w.-]+/, '<o>/<r>')}`;
  if (base === 'electron') { const t = rest.find((x) => x.startsWith('--type=')); return `electron ${t ?? '(main)'}`; }
  if (base === 'sh' || base === 'bash' || base === 'zsh') return `${base} -c ${(rest.find((x, i) => rest[i - 1] === '-c' || rest[i - 1] === '-lc') ?? rest[0] ?? '').slice(0, 60)}`;
  return `${base}${rest[0] && !rest[0].startsWith('-') ? ' ' + rest[0].slice(0, 30) : ''}`;
}
const execs = [], connects = [], dns = [];
// Rig artifacts: the gh/claude stubs' own `date`/`sleep`, and the self-tune seam command (`/bin/true`) — not Orchestra's cost.
const ARTIFACT = /^(date|sleep|true)( |$)/;
for (const l of lines) {
  const p = l.split(' ');
  if (p[0] === 'EXEC') { const t = toWall(Number(p[1])); const key = keyOf(p[5] ?? p[4], p.slice(6)); if (ARTIFACT.test(key)) { result.rigArtifactExecs = (result.rigArtifactExecs ?? 0) + 1; continue; } execs.push({ t, pid: Number(p[2]), ppid: Number(p[3]), path: p[4], argv: p.slice(5), key }); }
  else if (p[0] === 'CONNECT') connects.push({ t: toWall(Number(p[1])), pid: Number(p[2]), fam: p[3], addr: p.slice(4).join(' ') });
  else if (p[0] === 'DNS') dns.push({ t: toWall(Number(p[1])), pid: Number(p[2]), host: p[3] });
}
const tally = (arr, key, w) => { const o = {}; for (const x of arr) if (x.t >= w.t0 && x.t < w.t1) { const k = key(x); o[k] = (o[k] ?? 0) + 1; } return o; };
result.events = {};
for (const w of result.windows ?? []) {
  const perMin = (o) => Object.fromEntries(Object.entries(o).sort((a, b) => b[1] - a[1]).map(([k, n]) => [k, { count: n, perMin: Number((n / (w.seconds / 60)).toFixed(2)) }]));
  const isNet = (c) => c.fam === 'inet' || c.fam === 'inet6';
  result.events[w.name] = {
    execTotal: execs.filter((x) => x.t >= w.t0 && x.t < w.t1).length,
    execByKey: perMin(tally(execs, (x) => x.key, w)),
    dns: perMin(tally(dns, (x) => x.host, w)),
    connectInet: perMin(tally(connects.filter(isNet), (x) => x.addr, w)),
    connectUnixCount: connects.filter((c) => !isNet(c) && c.t >= w.t0 && c.t < w.t1).length,
  };
}
// boot window: everything from launch to UI-ready
const bootW = { t0: tLaunch, t1: tLaunch + (result.bootToUiMs ?? 0), seconds: (result.bootToUiMs ?? 0) / 1000 };
result.events.boot = {
  execTotal: execs.filter((x) => x.t >= bootW.t0 && x.t < bootW.t1).length,
  execByKey: Object.fromEntries(Object.entries(tally(execs, (x) => x.key, bootW)).sort((a, b) => b[1] - a[1])),
  dns: tally(dns, (x) => x.host, bootW),
  connectInet: tally(connects.filter((c) => c.fam !== 'unix'), (x) => x.addr, bootW),
};
// positive controls
const ghCalls = fs.existsSync(path.join(OUT, 'gh-calls.log')) ? fs.readFileSync(path.join(OUT, 'gh-calls.log'), 'utf8').split('\n').filter(Boolean) : [];
result.controls = {
  execlogLines: lines.length,
  appOwnGitSpawns: execs.filter((x) => x.key.startsWith('git ')).length,
  ghStubCalls: ghCalls.length,
  execlogSawGh: execs.filter((x) => x.key.startsWith('gh ')).length,
  visibilities: (result.windows ?? []).map((w) => `${w.name}:${w.visibilityStart}->${w.visibilityEnd}`),
};
result.ghCallsSample = ghCalls.slice(0, 5);
if (result.error) result.void.push(`run error: ${result.error.split('\n')[0]}`);
if (!(result.controls.appOwnGitSpawns > 0)) result.void.push('LD_PRELOAD log holds no git spawns — the logger did not attach to the app');
if (!(result.controls.ghStubCalls > 0)) result.void.push('the gh stub was never invoked — linked-PR poll did not reach the real code path');
if ((result.rowsMounted ?? 0) < N) result.void.push(`only ${result.rowsMounted}/${N} workspace rows mounted`);
if ((result.windows ?? []).some((w) => w.name === 'steady-visible' && w.visibilityStart !== 'visible')) result.void.push('steady-visible window was not document.visibilityState=visible');
fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify(result, null, 1));
console.log(JSON.stringify({ label: LABEL, out: OUT, void: result.void, bootToUiMs: result.bootToUiMs, controls: result.controls }));
process.exit(result.void.length ? 3 : 0);
