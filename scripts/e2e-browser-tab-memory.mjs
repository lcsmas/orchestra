// #394 — browser tab memory attributed to the owning workspace, driven in a BUILT Orchestra (argv[2] = app dir) inside the contained rig's own headless sway, scratch ORCHESTRA_HOME / HOME / CLAUDE_CONFIG_DIR.
// Two scratch workspaces A and B, each with a browser tab on the #395 fixture site. A navigates to a HEAVY page (?mb=N, touched memory): A's Resources figure must rise by ~N MB and B's must not. Read FOUR ways:
//   the page's snapshot (`sampleResources().browserTabs`)  ·  the rendered Resources row (chip + memory cell) of EACH workspace  ·  the REAL built CLI `bus-status` `browser tabs:` line  ·  the 60 s monitor line (`resources.jsonl`)
// against two independent oracles: /proc/<pid>/status VmRSS of the billed renderer and Electron's own `app.getAppMetrics()` (the snapshot's `app`). Positive controls: app identity (bundle md5), scratch env read back out of the
// running app, app present in MY sway, the billed pid is `--type=renderer`, the fixture page really holds the memory. MUST-FAIL: run this same driver on a build WITHOUT #394 — the attribution clauses go RED.
//
// Usage (via scripts/e2e-browser-tab-memory.sh): <app-dir> --live-home <real $HOME> --fixture-dir <dir> [--out dir] [--label name] [--heavy-mb N] [--no-monitor]
import { execFileSync, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const APP_DIR = argv[0] && !argv[0].startsWith('--') ? fs.realpathSync(argv[0]) : null;
const LIVE_HOME = flag('--live-home', null);
const FIXTURE_DIR = flag('--fixture-dir', null);
const LABEL = flag('--label', APP_DIR ? path.basename(APP_DIR) : 'app');
const HEAVY_MB = Number(flag('--heavy-mb', '400'));
const WITH_MONITOR = !argv.includes('--no-monitor');
const refuse = (m) => { console.log(`REFUSED: ${m}`); process.exit(3); };
if (!APP_DIR) refuse('no <app-dir>');
if (!LIVE_HOME) refuse('--live-home missing');
if (!FIXTURE_DIR || !fs.existsSync(path.join(FIXTURE_DIR, 'server.mjs'))) refuse('--fixture-dir missing or has no server.mjs');
const RIG_DIR = process.env.RIG_DIR;
const RIG_WAYLAND = process.env.RIG_WAYLAND;
if (!RIG_DIR || !RIG_WAYLAND) refuse('RIG_DIR / RIG_WAYLAND unset — run via scripts/e2e-browser-tab-memory.sh (the contained rig)');
if (process.env.DISPLAY) refuse(`X11 DISPLAY=${process.env.DISPLAY} is set — Electron would reach the human's screen`);
if (process.env.WAYLAND_DISPLAY !== RIG_WAYLAND || RIG_WAYLAND === 'wayland-1') refuse(`WAYLAND_DISPLAY=${process.env.WAYLAND_DISPLAY} != marker-verified ${RIG_WAYLAND}`);
const OUT = flag('--out', null) || path.join(RIG_DIR, 'shots');
const MB = 1024 * 1024;

// ── scratch-containment guard (same as the other contained rigs) ──────────────────────────────────────────────────────
const RIG_BASE = fs.realpathSync(path.dirname(RIG_DIR));
const liveReal = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
const LIVE_DIRS = [...fs.readdirSync(LIVE_HOME).filter((n) => n === '.claude' || n.startsWith('.claude-')).map((n) => path.join(LIVE_HOME, n)), path.join(LIVE_HOME, '.orchestra'), path.join(LIVE_HOME, '.config')].map(liveReal);
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

// ── helpers ───────────────────────────────────────────────────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const md5 = (b) => crypto.createHash('md5').update(b).digest('hex');
async function waitFor(fn, ms, what) {
  const t0 = Date.now(); let last;
  while (Date.now() - t0 < ms) { try { last = await fn(); if (last) return last; } catch (e) { last = e; } await sleep(250); }
  throw new Error(`timeout ${ms}ms waiting for ${what}${last instanceof Error ? `: ${last.message}` : ''}`);
}
const freePort = () => new Promise((res, rej) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); s.on('error', rej); });
const sh = (cmd, args, opt = {}) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opt });
const mbOf = (n) => (n / MB).toFixed(0);
/** « 345 MB » / « 1.20 GB » / « 4.2 MB » (the page's formatBytes) → bytes; null for « — » */
function parseBytes(t) { const m = /^([\d.]+)\s*(B|KB|MB|GB)$/.exec((t || '').trim()); return m ? Number(m[1]) * { B: 1, KB: 1024, MB: MB, GB: 1024 * MB }[m[2]] : null; }

class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); ws.onmessage = (ev) => { const m = JSON.parse(ev.data); const p = m.id && this.pending.get(m.id); if (p) { this.pending.delete(m.id); m.error ? p.rej(new Error(`${m.error.message}`)) : p.res(m.result); } }; }
  static async connect(url) { const ws = new WebSocket(url); await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws error')); }); return new Cdp(ws); }
  send(method, params = {}, ms = 30000) { const id = ++this.id; return new Promise((res, rej) => { const t = setTimeout(() => { this.pending.delete(id); rej(new Error(`CDP ${method} timed out after ${ms}ms`)); }, ms); this.pending.set(id, { res: (v) => { clearTimeout(t); res(v); }, rej: (e) => { clearTimeout(t); rej(e); } }); this.ws.send(JSON.stringify({ id, method, params })); }); }
  async eval(expr) { const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(`eval threw: ${r.exceptionDetails.text} ${r.exceptionDetails.exception?.description ?? ''}`); return r.result.value; }
  async click(x, y) { for (const [type, extra] of [['mouseMoved', {}], ['mousePressed', { button: 'left', clickCount: 1 }], ['mouseReleased', { button: 'left', clickCount: 1 }]]) { await this.send('Input.dispatchMouseEvent', { type, x, y, ...extra }); await sleep(60); } }
  async shot() { const r = await this.send('Page.captureScreenshot', { format: 'png' }, 25000); return Buffer.from(r.data, 'base64'); }
  close() { try { this.ws.close(); } catch {} }
}

const results = [];
const shots = [];
function clause(name, ok, detail) { results.push({ clause: name, ok: !!ok, detail }); console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name} — ${detail}`); }
function saveShot(name, buf) { fs.mkdirSync(OUT, { recursive: true }); const f = path.join(OUT, name); fs.writeFileSync(f, buf); shots.push({ file: f, md5: md5(buf) }); return f; }

function seedWorld(armDir) {
  const fakeHome = path.join(armDir, 'home'), ohome = path.join(armDir, 'oh'), cfg = path.join(armDir, 'claude-config'), repoDir = path.join(armDir, 'repo');
  for (const d of [fakeHome, ohome, cfg, repoDir]) fs.mkdirSync(d, { recursive: true });
  for (const [k, v] of Object.entries({ HOME: fakeHome, ORCHESTRA_HOME: ohome, CLAUDE_CONFIG_DIR: cfg, repo: repoDir })) mustBeScratch(k, v);
  const git = (args) => sh('git', ['-c', 'user.name=rig', '-c', 'user.email=rig@example.invalid', ...args], { cwd: repoDir, env: { PATH: process.env.PATH, HOME: fakeHome, GIT_CONFIG_NOSYSTEM: '1' } });
  git(['init', '-q', '-b', 'main']); fs.writeFileSync(path.join(repoDir, 'README.md'), '# btm394 seed repo\n'); git(['add', '.']); git(['commit', '-q', '-m', 'seed']);
  const account = { id: 'rig-btm394', label: 'rig (scratch config dir)', configDir: cfg };
  const dir = path.join(ohome, 'userData', 'orchestra'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'store.json'), JSON.stringify({ repos: [{ path: repoDir, name: 'btm394-repo', defaultBranch: 'main', accountId: account.id }], workspaces: [], accounts: [account], selfTuneRuns: [] }, null, 2));
  const stubDir = path.join(armDir, 'stub-bin'); fs.mkdirSync(stubDir, { recursive: true });
  fs.writeFileSync(path.join(stubDir, 'claude'), '#!/bin/sh\nsleep 3600\n', { mode: 0o755 });
  return { fakeHome, ohome, cfg, stubDir, account };
}
function listProcsByHome(home) {
  const out = [];
  for (const p of fs.readdirSync('/proc').filter((n) => /^\d+$/.test(n))) { try { if (fs.readFileSync(`/proc/${p}/environ`, 'utf8').split('\0').includes(`ORCHESTRA_HOME=${home}`)) out.push(+p); } catch {} }
  return out.filter((p) => p !== process.pid);
}
function liveCanary() {
  const snap = {};
  for (const d of fs.readdirSync(LIVE_HOME).filter((n) => n === '.claude' || n.startsWith('.claude-')).map((n) => path.join(LIVE_HOME, n))) {
    let links = ''; try { links = sh('find', [d, '-maxdepth', '1', '-type', 'l', '-printf', '%f->%l\\n']).split('\n').sort().join('|'); } catch {}
    let mcp = ''; for (const f of [path.join(d, '.claude.json'), path.join(LIVE_HOME, '.claude.json')]) { try { mcp += Object.keys(JSON.parse(fs.readFileSync(f, 'utf8')).mcpServers || {}).sort().join(',') + ';'; } catch {} }
    snap[d] = md5(links) + ':' + md5(mcp);
  }
  return snap;
}
const vmRss = (pid) => { try { return Number(/VmRSS:\s+(\d+) kB/.exec(fs.readFileSync(`/proc/${pid}/status`, 'utf8'))?.[1]) * 1024; } catch { return null; } };
const cmdline = (pid) => { try { return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' '); } catch { return ''; } };

async function main() {
  const before = liveCanary();
  const armDir = path.join(RIG_DIR, `arm-${LABEL}`); fs.mkdirSync(armDir, { recursive: true });
  const world = seedWorld(armDir);
  sh('swaymsg', ['output', 'HEADLESS-1', 'resolution', '1400x900']); sh('swaymsg', ['default_border', 'none']);
  const port = await freePort();
  const env = { PATH: `${world.stubDir}:/usr/local/bin:/usr/bin:/bin`, HOME: world.fakeHome, XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR, XDG_CONFIG_HOME: path.join(world.fakeHome, '.config'), XDG_CACHE_HOME: path.join(world.fakeHome, '.cache'),
    WAYLAND_DISPLAY: RIG_WAYLAND, SWAYSOCK: process.env.SWAYSOCK, ELECTRON_OZONE_PLATFORM_HINT: 'wayland', ORCHESTRA_OZONE: 'wayland', ORCHESTRA_OZONE_RELAUNCHED: '1',
    ORCHESTRA_HOME: world.ohome, ORCHESTRA_DEBUG_PORT: String(port), ORCHESTRA_SELF_TUNE_CMD: '/bin/true', CLAUDE_CONFIG_DIR: world.cfg, LANG: 'C.UTF-8' };
  for (const k of ['HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'ORCHESTRA_HOME', 'CLAUDE_CONFIG_DIR']) mustBeScratch(`env.${k}`, env[k]);
  if ('DISPLAY' in env || env.WAYLAND_DISPLAY !== RIG_WAYLAND) refuse('child env would reach the human display');

  // the #395 fixture site (dependency-free node:http) on a port of its own
  const fixture = spawn(process.execPath, [path.join(FIXTURE_DIR, 'server.mjs'), '0'], { env: { PATH: process.env.PATH }, stdio: ['ignore', 'pipe', 'inherit'] });
  const fxPort = await new Promise((res, rej) => { let buf = ''; const t = setTimeout(() => rej(new Error('fixture never printed LISTENING')), 10000); fixture.stdout.on('data', (d) => { buf += d; const m = /LISTENING (\d+)/.exec(buf); if (m) { clearTimeout(t); res(Number(m[1])); } }); fixture.on('exit', (c) => rej(new Error(`fixture exited ${c}`))); });
  const FX = `http://127.0.0.1:${fxPort}`;

  const logFile = path.join(armDir, 'app.log'); const fd = fs.openSync(logFile, 'w');
  const app = spawn(path.join(APP_DIR, 'node_modules/electron/dist/electron'), [APP_DIR, '--ozone-platform=wayland'], { cwd: APP_DIR, env, stdio: ['ignore', fd, fd], detached: true });
  console.log(`  app pid ${app.pid} port ${port} fixture ${FX} log ${logFile}`);
  let cdp;
  const busLines = () => { // the REAL built CLI over the app's own socket (pointer file under the scratch ORCHESTRA_HOME)
    const sock = fs.readFileSync(path.join(world.ohome, 'sock'), 'utf8').trim();
    mustBeScratch('socket pointer home', world.ohome);
    return sh(process.execPath, [path.join(APP_DIR, 'dist-electron', 'cli.js'), 'bus-status'], { env: { PATH: process.env.PATH, HOME: world.fakeHome, ORCHESTRA_HOME: world.ohome, ORCHESTRA_SOCK: sock } }).split('\n');
  };
  const snap = () => cdp.eval(`window.orchestra.sampleResources()`);
  const tabsOf = (s, ws) => (s.browserTabs?.byWorkspace ?? []).find((w) => w.wsId === ws) ?? null;
  const domRows = () => cdp.eval(`(() => [...document.querySelectorAll('.res-agent-row[data-res-ws]')].map((r) => {
    const chip = r.querySelector('[data-res-tabs]'), mem = r.querySelector(':scope > .res-cell:not(.dim)');
    return { ws: r.getAttribute('data-res-ws'), name: (r.querySelector('.res-agent-branch') || {}).textContent || null, mem: mem ? mem.textContent.trim() : null,
      chip: chip ? { tabs: chip.getAttribute('data-res-tabs'), bytes: chip.getAttribute('data-res-tabs-bytes'), text: chip.textContent.trim(), title: chip.getAttribute('title') } : null };
  }))()`);
  const tile = (label) => cdp.eval(`(() => { const t = [...document.querySelectorAll('.res-tile')].find((x) => x.querySelector('.res-tile-label') && x.querySelector('.res-tile-label').textContent.trim() === ${JSON.stringify(label)}); return t ? t.querySelector('.res-tile-value').textContent.trim() : null; })()`);
  try {
    const target = await waitFor(async () => { const r = await fetch(`http://127.0.0.1:${port}/json`); return (await r.json()).find((x) => x.type === 'page' && x.url.includes('dist/index.html')) || null; }, 60000, 'the app page target');
    clause('ctl/app-identity-path', target.url.includes(APP_DIR) && !target.url.includes('app.asar'), `target url ${target.url} ⊇ ${APP_DIR}`);
    cdp = await Cdp.connect(target.webSocketDebuggerUrl); await cdp.send('Page.enable');
    await waitFor(() => cdp.eval(`!!document.querySelector('button[aria-label="Open the Resources page"]')`), 60000, 'the Resources footer button');
    const srcs = await cdp.eval(`[...document.querySelectorAll('script[src]')].map((s) => s.src)`); const bundle = srcs.find((s) => /assets\/index-.*\.js/.test(s));
    const onDisk = bundle && path.join(APP_DIR, 'dist', bundle.split('/dist/')[1]);
    const frameId = (await cdp.send('Page.getResourceTree')).frameTree.frame.id; const rc_ = await cdp.send('Page.getResourceContent', { frameId, url: bundle });
    const served = Buffer.from(rc_.content, rc_.base64Encoded ? 'base64' : 'utf8');
    clause('ctl/app-identity-bundle', !!onDisk && fs.existsSync(onDisk) && md5(served) === md5(fs.readFileSync(onDisk)) && served.toString('utf8').includes('res-agent-row'), `renderer bundle ${path.basename(bundle || '?')} served md5 ${md5(served)} == dist file`);
    clause('ctl/build-has-the-feature', served.toString('utf8').includes('data-res-tabs'), `the served renderer bundle ${served.toString('utf8').includes('data-res-tabs') ? 'contains' : 'LACKS'} the tabs chip (a build without #394 lacks it — the must-FAIL arm)`);
    const environ = fs.readFileSync(`/proc/${app.pid}/environ`, 'utf8').split('\0'); const ev = (k) => (environ.find((e) => e.startsWith(k + '=')) || '').slice(k.length + 1);
    clause('ctl/scratch-env', ev('ORCHESTRA_HOME') === world.ohome && ev('CLAUDE_CONFIG_DIR') === world.cfg && ev('HOME') === world.fakeHome && !environ.some((e) => e.startsWith('DISPLAY=')) && ev('WAYLAND_DISPLAY') === RIG_WAYLAND, `app environ ORCHESTRA_HOME=${ev('ORCHESTRA_HOME')} CLAUDE_CONFIG_DIR=${ev('CLAUDE_CONFIG_DIR')} (pinned account ${world.account.id}, configDir ${world.account.configDir}) WAYLAND_DISPLAY=${ev('WAYLAND_DISPLAY')} DISPLAY=${ev('DISPLAY') || '<unset>'}`);
    clause('ctl/app-in-my-sway', new RegExp(`"pid":\\s*${app.pid}\\b`).test(sh('swaymsg', ['-t', 'get_tree'])), `app pid ${app.pid} in my sway's get_tree`);
    const ver = await cdp.eval(`(window.orchestra.appVersion ? window.orchestra.appVersion() : null)`).catch(() => null);
    console.log(`  built version (package.json): ${JSON.parse(fs.readFileSync(path.join(APP_DIR, 'package.json'), 'utf8')).version}; app reports: ${ver}`);
    const f1 = await fetch(`${FX}/memory-light.html`), f2 = await fetch(`${FX}/memory-heavy.html?mb=${HEAVY_MB}`);
    clause('ctl/fixture-site-up', f1.status === 200 && f2.status === 200 && (await f2.text()).includes('window.__hog'), `GET /memory-light.html ${f1.status}, /memory-heavy.html ${f2.status} (holds window.__hog)`);

    // ── S0: two workspaces, each with a (stub-claude) session so their Resources rows are the ordinary ones ──
    const wsA = await cdp.eval(`window.orchestra.createScratchWorkspace()`), wsB = await cdp.eval(`window.orchestra.createScratchWorkspace()`);
    const A = wsA.id, B = wsB.id;
    clause('S0/two-workspaces', !!A && !!B && A !== B, `A=${A} (${wsA.branch}) B=${B} (${wsB.branch})`);
    const s0 = await waitFor(async () => { const s = await snap(); return s.sessions.some((x) => x.workspaceId === A) && s.sessions.some((x) => x.workspaceId === B) ? s : null; }, 60000, 'a session row for each workspace').catch(() => null);
    clause('S0/ordinary-session-rows', !!s0, s0 ? `sessions: ${s0.sessions.map((x) => `${x.ptyId}(${x.kind}, ${mbOf(x.memBytes)} MB)`).join(' ')}` : 'no keeper session appeared for both (the stub claude) — rows will be browser-only');

    // ── S1: both tabs on the LIGHT page; baseline ──
    await cdp.eval(`window.orchestra.browserNavigate(${JSON.stringify(A)}, ${JSON.stringify(`${FX}/memory-light.html`)})`);
    await cdp.eval(`window.orchestra.browserNavigate(${JSON.stringify(B)}, ${JSON.stringify(`${FX}/memory-light.html`)})`);
    const s1 = await waitFor(async () => { const s = await snap(); const a = tabsOf(s, A), b = tabsOf(s, B); return a && b && a.bytes > 5 * MB && b.bytes > 5 * MB ? s : null; }, 40000, 'both light tabs measured').catch(() => snap());
    const a1 = tabsOf(s1, A), b1 = tabsOf(s1, B);
    clause('S1/both-tabs-measured', !!a1 && !!b1 && a1.tabs === 1 && b1.tabs === 1 && a1.bytes > 5 * MB && b1.bytes > 5 * MB && a1.unmeasured === 0 && b1.unmeasured === 0 && a1.shared === 0 && b1.shared === 0, `A ${JSON.stringify(a1)} · B ${JSON.stringify(b1)} · billed pids ${JSON.stringify(s1.browserTabs?.attributedPids)}`);
    await cdp.click(...(await cdp.eval(`(() => { const r = document.querySelector('button[aria-label="Open the Resources page"]').getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`)));
    await waitFor(() => cdp.eval(`!!document.querySelector('.res-page')`), 10000, 'the Resources page');
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: 895 });
    const r1 = await waitFor(async () => { const rows = await domRows(); const a = rows.find((r) => r.ws === A), b = rows.find((r) => r.ws === B); return a && b && a.chip && b.chip && a.mem && b.mem ? { a, b } : null; }, 20000, 'both rows with a tabs chip').catch(() => null);
    const rowsNow = await domRows();
    clause('S1/rows-carry-the-tabs-chip', !!r1 && r1.a.chip.tabs === '1' && r1.b.chip.tabs === '1' && /^1 tab · \d+(\.\d+)? (MB|GB)$/.test(r1.a.chip.text), r1 ? `A row mem ${r1.a.mem} chip "${r1.a.chip.text}" · B row mem ${r1.b.mem} chip "${r1.b.chip.text}"` : `rows: ${JSON.stringify(rowsNow)}`);
    const shotLight = saveShot(`${LABEL}-s1-light-renderer.png`, await cdp.shot());
    const aMem0 = parseBytes(r1?.a.mem), bMem0 = parseBytes(r1?.b.mem);

    // ── S2: A navigates to the HEAVY page ──
    await cdp.eval(`window.orchestra.browserNavigate(${JSON.stringify(A)}, ${JSON.stringify(`${FX}/memory-heavy.html?mb=${HEAVY_MB}`)})`);
    const want = a1 ? a1.bytes + 0.75 * HEAVY_MB * MB : Infinity;
    const s2 = await waitFor(async () => { const s = await snap(); const a = tabsOf(s, A); return a && a.bytes >= want ? s : null; }, 45000, `A's figure to rise by ~${HEAVY_MB} MB`).catch(() => snap());
    const a2 = tabsOf(s2, A), b2 = tabsOf(s2, B);
    clause('S2/A-figure-rises', !!a1 && !!a2 && a2.bytes - a1.bytes >= 0.75 * HEAVY_MB * MB && a2.bytes - a1.bytes <= 1.6 * HEAVY_MB * MB, `A browser bytes ${a1 ? mbOf(a1.bytes) : '?'} MB -> ${a2 ? mbOf(a2.bytes) : '?'} MB (page holds ${HEAVY_MB} MB)`);
    clause('S2/B-figure-flat', !!b1 && !!b2 && Math.abs(b2.bytes - b1.bytes) < 60 * MB, `B browser bytes ${b1 ? mbOf(b1.bytes) : '?'} MB -> ${b2 ? mbOf(b2.bytes) : '?'} MB (|Δ| < 60 MB)`);
    // independent oracles: /proc VmRSS of the billed renderer + Electron's own getAppMetrics (the snapshot's `app`)
    const billed = s2.browserTabs?.attributedPids ?? [];
    const rss = billed.map((p) => ({ pid: p, rss: vmRss(p), cmd: cmdline(p) }));
    const heavy = [...rss].sort((x, y) => (y.rss ?? 0) - (x.rss ?? 0))[0];
    const metric = heavy ? s2.app.find((p) => p.pid === heavy.pid) : null;
    clause('S2/oracle-proc-vmrss', !!heavy && !!a2 && heavy.rss > 0 && Math.abs(heavy.rss - a2.bytes) / heavy.rss < 0.15, heavy ? `billed pids ${billed.join(',')}; heaviest ${heavy.pid} VmRSS ${mbOf(heavy.rss)} MB vs A's figure ${a2 ? mbOf(a2.bytes) : '?'} MB (±15%)` : 'no billed pid');
    clause('S2/oracle-electron-app-metrics', !!metric && !!a2 && Math.abs(metric.memBytes - a2.bytes) / metric.memBytes < 0.2, metric ? `app.getAppMetrics() pid ${metric.pid} type ${metric.type} working set ${mbOf(metric.memBytes)} MB vs A's figure ${mbOf(a2.bytes)} MB (±20%)` : 'the billed pid is not in the snapshot app list');
    clause('ctl/billed-pid-is-a-renderer', !!heavy && /--type=renderer/.test(heavy.cmd), `pid ${heavy?.pid} cmdline: ${(heavy?.cmd || '').slice(0, 120)}`);
    clause('ctl/page-really-holds-the-memory', !!heavy && heavy.rss > HEAVY_MB * MB * 0.9, `the heavy renderer's own VmRSS ${heavy ? mbOf(heavy.rss) : '?'} MB ≥ 90% of the ${HEAVY_MB} MB the fixture page touches`);
    // the rendered Resources rows (the page re-polls every 2 s)
    const r2 = await waitFor(async () => { const rows = await domRows(); const a = rows.find((r) => r.ws === A), b = rows.find((r) => r.ws === B); return a && b && parseBytes(a.mem) >= (aMem0 ?? 0) + 0.7 * HEAVY_MB * MB ? { a, b } : null; }, 20000, "A's row memory to rise").catch(async () => { const rows = await domRows(); return { a: rows.find((r) => r.ws === A), b: rows.find((r) => r.ws === B) }; });
    const aMem2 = parseBytes(r2.a?.mem), bMem2 = parseBytes(r2.b?.mem);
    clause('S2/rendered-A-row-rises', aMem0 !== null && aMem2 !== null && aMem2 - aMem0 >= 0.7 * HEAVY_MB * MB, `A's rendered row memory ${r1?.a.mem} -> ${r2.a?.mem}; chip "${r2.a?.chip?.text}"`);
    clause('S2/rendered-B-row-flat', bMem0 !== null && bMem2 !== null && Math.abs(bMem2 - bMem0) < 60 * MB, `B's rendered row memory ${r1?.b.mem} -> ${r2.b?.mem}; chip "${r2.b?.chip?.text}"`);
    clause('S2/chip-follows-the-figure', !!r2.a?.chip && Number(r2.a.chip.bytes) >= (a1?.bytes ?? 0) + 0.7 * HEAVY_MB * MB, `A chip bytes attr ${r2.a?.chip?.bytes} (text "${r2.a?.chip?.text}")`);
    const rowsAfter = await domRows();
    clause('S2/no-other-row-moved', rowsAfter.filter((r) => r.ws !== A && r.ws !== B).every((r) => !r.chip), `${rowsAfter.length} rows; rows other than A/B carrying a tabs chip: ${rowsAfter.filter((r) => r.ws !== A && r.ws !== B && r.chip).length}`);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: 895 });
    const shotHeavy = saveShot(`${LABEL}-s2-heavy-renderer.png`, await cdp.shot());
    const grim = path.join(OUT, `${LABEL}-s2-heavy-compositor.png`);
    sh('grim', ['-o', 'HEADLESS-1', grim], { env: { PATH: '/usr/bin:/bin', XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR, WAYLAND_DISPLAY: RIG_WAYLAND } }); shots.push({ file: grim, md5: md5(fs.readFileSync(grim)) });

    // ── S3: the App tile does not count a billed renderer twice ──
    const appRaw = s2.app.reduce((n, p) => n + p.memBytes, 0);
    const billedApp = s2.app.filter((p) => billed.includes(p.pid)).reduce((n, p) => n + p.memBytes, 0);
    const appTile = parseBytes(await tile('App memory'));
    const tagged = await cdp.eval(`document.querySelectorAll('[data-res-app-tab]').length`);
    clause('S3/app-tile-leaves-billed-renderers-out', appTile !== null && billedApp > 0.75 * HEAVY_MB * MB && appTile < appRaw - 0.6 * HEAVY_MB * MB, `App memory tile ${appTile === null ? '—' : mbOf(appTile)} MB vs Σ app.getAppMetrics ${mbOf(appRaw)} MB, of which ${mbOf(billedApp)} MB are billed tab renderers (tile must sit ≥ ${(0.6 * HEAVY_MB).toFixed(0)} MB under the raw sum)`);
    clause('S3/billed-renderers-tagged-in-the-app-list', tagged === billed.length && billed.length >= 2, `${tagged} « · tab » tags in the App processes list for ${billed.length} billed pids`);

    // ── S4: bus-status over the app's socket, through the REAL built CLI ──
    const bl = busLines().find((l) => l.startsWith('browser tabs:')) ?? '(no browser tabs: line)';
    const figs = [...bl.matchAll(/×1 · (\d+) MB/g)].map((m) => Number(m[1]));
    clause('S4/bus-status-line', /^browser tabs: 2 in 2 workspaces \(/.test(bl) && figs.length === 2 && figs[0] >= figs[1] + 0.6 * HEAVY_MB && /counted in each workspace's memory/.test(bl), bl);

    // ── S5: the 60 s monitor line carries the same attribution ──
    if (WITH_MONITOR) {
      const jl = path.join(world.ohome, 'logs', 'resources.jsonl');
      const t0 = Date.now() - 1000;
      const line = await waitFor(() => { try { const ls = fs.readFileSync(jl, 'utf8').trim().split('\n').map((x) => JSON.parse(x)).filter((x) => x.at >= t0 && x.browserTabs); const l = ls[ls.length - 1]; const a = l?.browserTabs.byWorkspace.find((w) => w.wsId === A); return a && a.bytes >= (a1?.bytes ?? 0) + 0.7 * HEAVY_MB * MB ? l : null; } catch { return null; } }, 100000, 'a monitor line with the heavy tab').catch(() => null);
      const la = line?.browserTabs.byWorkspace.find((w) => w.wsId === A), lb = line?.browserTabs.byWorkspace.find((w) => w.wsId === B);
      clause('S5/monitor-line-carries-the-tabs', !!la && !!lb && la.bytes >= lb.bytes + 0.6 * HEAVY_MB * MB, line ? `resources.jsonl ${line.t}: A ${mbOf(la.bytes)} MB, B ${mbOf(lb.bytes)} MB, billed pids ${JSON.stringify(line.browserTabs.attributedPids)}` : `no resources.jsonl line with browserTabs within 100 s (file ${fs.existsSync(jl) ? 'exists' : 'absent'})`);
    }
    const dup = shots.length - new Set(shots.map((s) => s.md5)).size;
    clause('ctl/no-duplicate-captures', dup === 0, `${shots.length} captures, ${dup} byte-identical duplicate(s): ${shots.map((s) => path.basename(s.file)).join(', ')}`);
    console.log(`  shots: ${shotLight}, ${shotHeavy}, ${grim}`);
  } catch (e) {
    clause('rig/completed', false, `ABORTED: ${e.stack || e}`);
  } finally {
    cdp?.close();
    try { process.kill(-app.pid, 'SIGTERM'); } catch {}
    try { fixture.kill('SIGTERM'); } catch {}
    await sleep(2000);
    try { process.kill(-app.pid, 'SIGKILL'); } catch {}
    for (const p of listProcsByHome(world.ohome)) { try { process.kill(p, 'SIGKILL'); } catch {} }
    await sleep(500);
    const left = listProcsByHome(world.ohome);
    clause('rig/teardown-no-survivors', left.length === 0, `processes still carrying ${world.ohome}: ${left.length ? left.join(',') : 'none'}`);
  }
  const after = liveCanary();
  clause('ctl/live-claude-dirs-untouched', JSON.stringify(before) === JSON.stringify(after), `${Object.keys(before).length} live ~/.claude* dirs hashed before/after: ${JSON.stringify(before) === JSON.stringify(after) ? 'identical' : 'CHANGED'}`);
}

await main();
console.log('\n== shots (md5) ==');
for (const s of shots) console.log(`  ${s.md5}  ${s.file}`);
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, `${LABEL}-result.json`), JSON.stringify({ app: APP_DIR, label: LABEL, results, shots }, null, 2));
const red = results.filter((r) => !r.ok);
console.log(`\nVERDICT: ${red.length === 0 ? `ALL GREEN: ${results.length} clauses` : `RED: ${red.map((r) => r.clause).join(', ')}`}`);
process.exit(red.length === 0 ? 0 : 1);
