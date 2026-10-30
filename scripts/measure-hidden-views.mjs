// #406 hidden-view COST harness. Runs INSIDE the contained rig (scripts/measure-hidden-views.sh): own headless sway, scratch HOME, private
// runtime. For every scheduled run it launches ONE fresh Electron (scripts/measure-hidden-views-main.cjs), samples the rig process tree
// from /proc at 1 Hz (RSS, GPU-process RSS, CPU ticks, host MemAvailable — ABORTING below 8 GB), takes PSS at the window edges, and
// writes one raw record per run. The verdict is NEVER computed here: it is src/shared/hidden-view-cost.ts over the committed JSONL.
//   measure-hidden-views.sh <repo-dir> --stage main|n160|a2 [--batch-min 40] [--out dir] [--ns 1,8,40] [--pages idle,busy,heavy] [--reps 5]
//   knobs: --dev (short settle/window, set "dev", never counted) · --only <id-substring>
//   no rig needed:  --summarize-only [--out dir] · --export-jsonl <file> · --verdict <jsonl>   (run with node --experimental-strip-types)
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { LIMITS, computeVerdict, computeChecks, isValid, median } from '../src/shared/hidden-view-cost.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const has = (n) => argv.includes(n);
const refuse = (m) => { console.error('ABORT: ' + m); process.exit(2); };
const VERDICT_FILE = flag('--verdict', null), SUMMARIZE = has('--summarize-only'), EXPORT = flag('--export-jsonl', null);
const NO_RIG = !!VERDICT_FILE || SUMMARIZE || (!!EXPORT && !has('--stage'));
const DEV = has('--dev');
const REPO = path.resolve(NO_RIG ? '.' : argv[0] || '');
const OUT = path.resolve(flag('--out', path.join(process.env.TMPDIR || '/var/tmp', DEV ? 'measure-406-dev' : 'measure-406')));
const SETTLE = Number(flag('--settle', DEV ? 5 : LIMITS.settleS)), WINDOW = Number(flag('--window', DEV ? 10 : LIMITS.windowS)), FRAME = Number(flag('--frame', DEV ? 3 : 8));
const SET = DEV ? 'dev' : (flag('--stage', 'main') === 'a2' ? 'a2' : 'main');
const MB = 1e6, GB_KB = 1024 * 1024;

// ---------------- records -> table + verdict (shared by the run modes and the no-rig modes) ----------------
const loadDir = () => { const out = []; const root = path.join(OUT, 'runs'); if (!fs.existsSync(root)) return out; for (const d of fs.readdirSync(root).sort()) for (const f of fs.readdirSync(path.join(root, d)).filter((x) => /^attempt-\d+\.json$/.test(x)).sort()) out.push(JSON.parse(fs.readFileSync(path.join(root, d, f), 'utf8'))); return out; };
const loadJsonl = (f) => fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
function report(recs) {
  const runs = recs.filter((r) => r.kind);
  const f1 = (x) => (x === null || x === undefined || !Number.isFinite(x) ? 'n/a' : (+x).toFixed(1));
  console.log('\nper (set,page,N,arm): valid/attempts · median RSS MB · GPU RSS MB · CPU %core · idle frames · crashes+ctxlost');
  const keys = [...new Set(runs.filter((r) => r.kind === 'cell').map((r) => `${r.set}|${r.page}|${String(r.n).padStart(3)}|${r.arm}`))].sort();
  for (const k of keys) {
    const [set, page, n, arm] = k.split('|'); const rs = runs.filter((r) => r.kind === 'cell' && r.set === set && r.page === page && r.n === +n && r.arm === arm), v = rs.filter(isValid);
    const m = (g) => median(v.map(g));
    console.log(`  ${set} ${page.padEnd(5)} N=${n} ${arm.padEnd(3)}: ${v.length}/${rs.length} · ${f1(m((r) => r.rssKB * 1024 / MB))} · ${f1(m((r) => r.gpuRssKB * 1024 / MB))} · ${f1(m((r) => r.cpuPct))} · ${f1(m((r) => r.idleFrames))} · ${rs.reduce((s, r) => s + (r.crashes ?? 0) + (r.contextLost ?? 0), 0)}${rs.some((r) => r.aborted) ? ` · aborted ${rs.filter((r) => r.aborted).length}` : ''}`);
  }
  const v = computeVerdict(runs);
  console.log('\nlimit checks (Δ = arm − A0, same page, same N):');
  for (const c of v.checks) console.log(`  ${c.ok ? 'PASS' : 'FAIL'} ${c.id.padEnd(9)} ${c.page.padEnd(5)} N=${String(c.n).padEnd(3)} ${c.arm} ${c.basis.padEnd(9)} Δ=${c.delta === null ? 'n/a' : c.unit === 'B' ? f1(c.delta / MB) + ' MB' : f1(c.delta) + (c.unit === '%core' ? '%' : '')} limit=${c.unit === 'B' ? c.limit / MB + ' MB' : c.limit + (c.unit === '%core' ? '%' : '')}${c.worstRun !== null ? ` worst-run=${c.unit === 'B' ? f1(c.worstRun / MB) + ' MB' : f1(c.worstRun)}` : ''}${c.r2 !== undefined ? ` R²=${c.r2.toFixed(3)}` : ''}${c.why ? ' — ' + c.why : ''}`);
  console.log('\ncontrols + method:'); for (const c of [...v.controls, ...v.method]) console.log(`  ${c.ok ? 'PASS' : 'FAIL'} ${c.id}: ${c.detail}`);
  console.log(`\nVERDICT: ${v.verdict}${v.cap ? ` (cap ${v.cap})` : ''} · policy ${v.policy}${v.unverified ? ' · UNVERIFIED' : ''}\n${v.reasons.map((r) => '  - ' + r).join('\n')}`);
  return v;
}
if (VERDICT_FILE) { report(loadJsonl(VERDICT_FILE)); process.exit(0); }
if (SUMMARIZE) { report(loadDir()); process.exit(0); }
const exportJsonl = (file) => { const recs = loadDir().sort((a, b) => a.seq - b.seq || a.attempt - b.attempt); fs.writeFileSync(file, recs.map((r) => JSON.stringify(r)).join('\n') + '\n'); console.error(`[measure] exported ${recs.length} run records to ${file}`); };
if (EXPORT && NO_RIG) { exportJsonl(EXPORT); process.exit(0); }

// ---------------- rig contract (same checks as the #402 harness) ----------------
const { privateRuntimeDir, handedEnvProblems } = await import('./lib/rig-runtime.mjs');
const RIG_DIR = process.env.RIG_DIR, RIG_WAYLAND = process.env.RIG_WAYLAND;
if (!RIG_DIR || !RIG_WAYLAND) refuse('RIG_DIR / RIG_WAYLAND unset — run via scripts/measure-hidden-views.sh (the contained rig)');
if (process.env.DISPLAY) refuse('DISPLAY set — X11 would reach the human');
if (process.env.WAYLAND_DISPLAY !== RIG_WAYLAND || RIG_WAYLAND === 'wayland-1') refuse(`WAYLAND_DISPLAY=${process.env.WAYLAND_DISPLAY} != marker-verified ${RIG_WAYLAND}`);
const BUS = process.env.DBUS_SESSION_BUS_ADDRESS ?? '';
if (!BUS.startsWith(`unix:path=${RIG_DIR}/`)) refuse(`DBUS_SESSION_BUS_ADDRESS=${BUS || '<unset>'} is not the rig's nonexistent session bus under ${RIG_DIR}`);
let XDG; try { XDG = privateRuntimeDir(); } catch (e) { refuse(e.message); }
const ELECTRON = path.join(REPO, 'node_modules/electron/dist/electron');
if (!fs.existsSync(ELECTRON)) refuse(`${ELECTRON} missing — pnpm install first`);
fs.mkdirSync(path.join(OUT, 'runs'), { recursive: true });
const sh = (cmd, args, opt = {}) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opt });
try { sh('swaymsg', ['output', 'HEADLESS-1', 'resolution', '1400x900']); sh('swaymsg', ['default_border', 'none']); } catch (e) { refuse('swaymsg on the rig sway failed: ' + e.message); }
const PAGE_KB = Number(sh('getconf', ['PAGESIZE']).trim()) / 1024, CLK = Number(sh('getconf', ['CLK_TCK']).trim()); // 16 KB pages on this host: never assume 4
const REAL_HOME = os.userInfo().homedir;
const liveHashes = () => { const out = {}; const dirs = fs.readdirSync(REAL_HOME).filter((n) => /^\.claude(-[\w-]+)?$/.test(n)).map((n) => path.join(REAL_HOME, n)); dirs.push(path.join(REAL_HOME, '.config/orchestra'));
  for (const d of dirs) for (const f of ['settings.json', '.credentials.json', '.claude.json', 'CLAUDE.md', 'config.json', 'settings.local.json']) { const fp = path.join(d, f); try { if (fs.statSync(fp).isFile()) out[fp] = crypto.createHash('sha256').update(fs.readFileSync(fp)).digest('hex').slice(0, 16); } catch {} } return out; };
const HASH_BEFORE = liveHashes();

// ---------------- the page server (outside the measured tree): N+1 distinct origins h<i>.localhost on one loopback port ----------------
const T0 = Date.now(); const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SPIKE_PAGE = `<!doctype html><meta charset=utf-8><title>busy</title>
<style>html,body{margin:0;height:100%;background:#c81e8a}
#sq{position:fixed;left:0;top:60px;width:40px;height:40px;background:#fff;animation:mv 1s linear infinite alternate}
@keyframes mv{from{transform:translateX(0)}to{transform:translateX(200px)}}</style><div id=sq></div><input id=in style="position:fixed;left:300px;top:300px;width:200px;height:30px"><div style="height:4000px"></div>
<script>
const T0=performance.now(),timer=[],raf=[];let mouse=0;
addEventListener('mousedown',()=>mouse++,true);
setInterval(()=>timer.push(performance.now()-T0),50);
(function f(){raf.push(performance.now()-T0);requestAnimationFrame(f)})();
window.__spike={now:()=>performance.now()-T0,snap(){return{now:performance.now()-T0,timer:timer.slice(),raf:raf.slice(),state:document.visibilityState}}};
</script>`;
const IDLE_PAGE = `<!doctype html><meta charset=utf-8><title>idle</title><body style="margin:0;background:#c81e8a"><input id=in style="position:fixed;left:300px;top:300px;width:200px;height:30px"><p style="margin:12px;font:16px sans-serif;color:#fff">static page</p>`;
const HEAVY_PAGE = (() => { let rows = ''; for (let i = 0; i < 14000; i++) rows += `<div class="row" id="r${i}"><span class="a">row ${i} lorem ipsum dolor sit amet consectetur</span><b class="b">${(i * 2654435761 >>> 0).toString(36)}</b></div>\n`; return `<!doctype html><meta charset=utf-8><title>heavy</title><body style="margin:0;background:#c81e8a;font:12px sans-serif;color:#fff">${rows}<input id=in></body>`; })();
const pages = { idle: IDLE_PAGE, busy: SPIKE_PAGE, heavy: HEAVY_PAGE };
let hostsSeen = new Set();
const server = http.createServer((req, res) => {
  const host = (req.headers.host || '').split(':')[0]; const p = (req.url || '').split('?')[0].slice(1);
  if (!pages[p]) { res.writeHead(404); res.end(); return; }
  hostsSeen.add(host); res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); res.end(pages[p]);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r)); const PORT = server.address().port;
console.error(`[measure] page server 127.0.0.1:${PORT} (idle ${IDLE_PAGE.length} B, busy ${SPIKE_PAGE.length} B, heavy ${(HEAVY_PAGE.length / 1e6).toFixed(2)} MB); page ${PAGE_KB} KB, CLK_TCK ${CLK}`);

// ---------------- /proc sampling ----------------
const memAvail = () => { const m = /MemAvailable:\s+(\d+)/.exec(fs.readFileSync('/proc/meminfo', 'utf8')); return m ? Number(m[1]) : NaN; };
function parseStat(pid) { try { const s = fs.readFileSync(`/proc/${pid}/stat`, 'utf8'); const i = s.lastIndexOf(')'); const f = s.slice(i + 2).split(' '); return { pid: Number(pid), ppid: +f[1], pgrp: +f[2], ticks: +f[11] + +f[12], start: f[19] }; } catch { return null; } } // f[0]=state(3rd field)
const cmdCache = new Map();
function typeOf(id, pid) { if (cmdCache.has(id)) return cmdCache.get(id); let t = 'unknown'; try { const c = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8'); const m = /--type=([\w-]+)/.exec(c); t = m ? m[1] : 'browser'; } catch {} cmdCache.set(id, t); return t; }
function scanTree(root, rootStart) {
  const all = new Map(); const kids = new Map();
  for (const d of fs.readdirSync('/proc')) { if (!/^\d+$/.test(d)) continue; const s = parseStat(d); if (!s) continue; all.set(s.pid, s); (kids.get(s.ppid) ?? kids.set(s.ppid, []).get(s.ppid)).push(s.pid); }
  const r = all.get(root); if (!r || r.start !== rootStart) return null; // identity: the pid AND its start time
  const tree = []; const q = [root]; while (q.length) { const p = q.pop(); const s = all.get(p); if (s) tree.push(s); for (const c of kids.get(p) ?? []) q.push(c); }
  return tree.map((s) => ({ ...s, id: `${s.pid}:${s.start}`, type: typeOf(`${s.pid}:${s.start}`, s.pid) }));
}
const rssKB = (pid) => { try { return Number(fs.readFileSync(`/proc/${pid}/statm`, 'utf8').split(' ')[1]) * PAGE_KB; } catch { return null; } };
const statusRssKB = (pid) => { try { const m = /VmRSS:\s+(\d+)/.exec(fs.readFileSync(`/proc/${pid}/status`, 'utf8')); return m ? Number(m[1]) : null; } catch { return null; } };
function pssPass(tree) { let pss = 0, rss = 0, gpuPss = 0, ok = 0, fail = 0; for (const p of tree) { try { const t = fs.readFileSync(`/proc/${p.pid}/smaps_rollup`, 'utf8'); const a = /Pss:\s+(\d+)/.exec(t), b = /Rss:\s+(\d+)/.exec(t); if (a && b) { pss += +a[1]; rss += +b[1]; ok++; if (p.type === 'gpu-process') gpuPss += +a[1]; } else fail++; } catch { fail++; } } return { pssKB: ok ? pss : null, rssKB: rss, gpuPssKB: ok ? gpuPss : null, ok, fail }; }

const CTX_RE = /context[ _-]?lost|lost ui shared context|gpu process (?:exited|crashed|isn't usable)|gpu channel (?:lost|host)|GpuChannelHost.*lost/i;
const median_ = median;
async function runOne(spec) {
  const dir = path.join(OUT, 'runs', spec.id); fs.mkdirSync(dir, { recursive: true });
  const attempt = fs.readdirSync(dir).filter((f) => /^attempt-\d+\.json$/.test(f)).length + 1;
  const floorKB = spec.kind === 'control-abort' ? 1e12 : LIMITS.memFloorKB; // the abort CONTROL forces the floor above any MemAvailable: it must fire
  const fakeHome = path.join(dir, `home-${attempt}`); fs.mkdirSync(fakeHome, { recursive: true });
  const env = { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: fakeHome, XDG_RUNTIME_DIR: XDG, DBUS_SESSION_BUS_ADDRESS: BUS, XDG_CONFIG_HOME: path.join(fakeHome, '.config'), XDG_CACHE_HOME: path.join(fakeHome, '.cache'),
    WAYLAND_DISPLAY: RIG_WAYLAND, SWAYSOCK: process.env.SWAYSOCK, ELECTRON_OZONE_PLATFORM_HINT: 'wayland',
    MEASURE_ARM: spec.arm, MEASURE_PAGE: spec.page, MEASURE_N: String(spec.n), MEASURE_PORT: String(PORT), MEASURE_OUT: dir, MEASURE_SETTLE_S: String(SETTLE), MEASURE_WINDOW_S: String(WINDOW), MEASURE_FRAME_S: String(FRAME),
    MEASURE_KILL: spec.kind === 'control-crash' ? '1' : '0', MEASURE_COST_MB: spec.arm === 'A1x' ? '100' : '0' };
  const handed = handedEnvProblems(env, { ohome: env.ORCHESTRA_HOME, cfg: env.CLAUDE_CONFIG_DIR, home: fakeHome, wayland: RIG_WAYLAND, xdg: XDG, noBusPath: BUS.replace(/^unix:path=/, '') });
  if (handed.length) refuse(`child env violates the rig runtime contract: ${handed.join('; ')}`);
  hostsSeen = new Set();
  const rec = { id: spec.id, kind: spec.kind, set: spec.set, arm: spec.arm, page: spec.page, n: spec.n, rep: spec.rep, seq: spec.seq, attempt, cellOrder: spec.cellOrder, windowS: WINDOW, settleS: SETTLE, t: new Date().toISOString(), aborted: null };
  rec.memAvailStartKB = memAvail(); rec.load1 = os.loadavg()[0];
  const child = spawn(ELECTRON, [path.join(HERE, 'measure-hidden-views-main.cjs'), '--ozone-platform=wayland'], { cwd: REPO, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  const rootStart = parseStat(child.pid)?.start; let ownKill = false;
  let buf = ''; const lines = []; const phases = {}; let mainResult = null; const ctxLines = [];
  const onData = (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); lines.push(l);
    const pm = /^MEASURE_PHASE (\S+) (\d+)/.exec(l); if (pm) { phases[pm[1]] = Number(pm[2]); onPhase(pm[1]); } else if (l.startsWith('MEASURE_RESULT ')) { try { mainResult = JSON.parse(l.slice(15)); } catch {} } else if (CTX_RE.test(l)) ctxLines.push(l.slice(0, 200)); } };
  child.stdout.on('data', onData); child.stderr.on('data', onData);
  const exited = new Promise((res) => child.on('exit', (code, sig) => res({ code, sig })));
  const kill = () => { ownKill = true; try { process.kill(-child.pid, 'SIGKILL'); } catch {} };
  const samples = []; const cpuAt = []; let lastTree = [], pssStart = null, pssEnd = null, unitCheck = null, sampleMs = [];
  function onPhase(name) { if (name === 'window-start' && lastTree.length) pssStart = pssPass(lastTree); if (name === 'window-end' && lastTree.length) pssEnd = pssPass(lastTree); }
  const deadline = Date.now() + (SETTLE + WINDOW + FRAME + 150 + spec.n * 5) * 1000;
  let done = false; exited.then(() => { done = true; });
  while (!done) {
    const ts = Date.now(); const avail = memAvail();
    if (!(avail >= floorKB)) { rec.aborted = 'memavail'; rec.abortInfo = { memAvailKB: avail, floorKB, atS: +((ts - T0) / 1000).toFixed(0) }; kill(); break; } // the memory-safety clause: never trip the fleet's guard
    if (ts > deadline) { rec.aborted = 'deadline'; kill(); break; }
    const tree = scanTree(child.pid, rootStart);
    if (tree) {
      lastTree = tree; let rss = 0, gpu = 0, ticks = 0; const m = new Map();
      for (const p of tree) { const r = rssKB(p.pid); if (r === null) continue; rss += r; if (p.type === 'gpu-process') gpu += r; ticks += p.ticks; m.set(p.id, p.ticks); }
      if (!unitCheck) { const root = tree.find((p) => p.pid === child.pid); const a = rssKB(root.pid), b = statusRssKB(root.pid); unitCheck = { statmKB: a, statusKB: b, ratio: a && b ? +(a / b).toFixed(3) : null }; }
      samples.push({ ts, avail, rss, gpu, ticks, n: tree.length }); cpuAt.push(m);
    } else samples.push({ ts, avail, rss: 0, gpu: 0, ticks: 0, n: 0 }), cpuAt.push(new Map());
    sampleMs.push(Date.now() - ts);
    await Promise.race([sleep(Math.max(50, 1000 - (Date.now() - ts))), exited.then(() => {})]);
  }
  const ex = await exited;
  try { process.kill(-child.pid, 'SIGKILL'); } catch {} // GPU/zygote stragglers
  await sleep(500); const left = scanTree(child.pid, rootStart); if (left) rec.leftoverProcs = left.length;
  fs.rmSync(fakeHome, { recursive: true, force: true }); fs.rmSync(path.join(dir, 'userData'), { recursive: true, force: true });
  rec.exit = { code: ex.code, signal: ex.sig }; rec.contextLost = ctxLines.length; rec.contextLostLines = ctxLines.slice(0, 3);
  rec.memAvailMinKB = Math.min(...samples.map((s) => s.avail), rec.memAvailStartKB); rec.sampler = { medianMs: median_(sampleMs), maxMs: Math.max(0, ...sampleMs), samples: samples.length };
  if (rec.aborted) { rec.crashes = null; rec.contextLost = null; return finish(rec, dir, attempt); }
  // ---- window math from main's own phase marks (same host clock) ----
  const ws = phases['window-start'], we = phases['window-end'];
  if (!mainResult || !ws || !we) { rec.error = `no complete result: exit=${ex.code}/${ex.sig}; phases=${Object.keys(phases)}; tail: ${lines.filter((l) => !/bus\.cc/.test(l)).slice(-4).join(' | ').slice(0, 300)}`; rec.crashes = ex.sig ? 1 : 0; return finish(rec, dir, attempt); }
  const idx = (t) => { let k = 0; for (let i = 0; i < samples.length; i++) if (samples[i].ts <= t) k = i; return k; };
  const s0 = idx(ws), s1 = idx(we);
  const inWin = samples.filter((s) => s.ts >= ws && s.ts <= we);
  rec.rssKB = Math.round(inWin.reduce((a, s) => a + s.rss, 0) / Math.max(inWin.length, 1)); rec.gpuRssKB = Math.round(inWin.reduce((a, s) => a + s.gpu, 0) / Math.max(inWin.length, 1));
  const ids = new Set([...cpuAt[s1].keys()]); for (let i = s0; i <= s1; i++) for (const k of cpuAt[i].keys()) ids.add(k);
  let dTicks = 0, gpuTicks = 0; const lastSeen = (id, i) => { for (let j = i; j >= 0; j--) if (cpuAt[j].has(id)) return cpuAt[j].get(id); return null; };
  for (const id of ids) { const a = cpuAt[s0].has(id) ? cpuAt[s0].get(id) : 0, b = lastSeen(id, s1) ?? a; dTicks += Math.max(0, b - a); if (cmdCache.get(id) === 'gpu-process') gpuTicks += Math.max(0, b - a); }
  const dt = (samples[s1].ts - samples[s0].ts) / 1000; rec.cpuPct = dt > 0 ? +((dTicks / CLK / dt) * 100).toFixed(3) : null; rec.gpuCpuPct = dt > 0 ? +((gpuTicks / CLK / dt) * 100).toFixed(3) : null; rec.cpuWindowS = +dt.toFixed(2);
  rec.pssKB = pssStart?.pssKB != null && pssEnd?.pssKB != null ? Math.round((pssStart.pssKB + pssEnd.pssKB) / 2) : null; rec.gpuPssKB = pssStart?.gpuPssKB != null && pssEnd?.gpuPssKB != null ? Math.round((pssStart.gpuPssKB + pssEnd.gpuPssKB) / 2) : null;
  rec.pss = { start: pssStart, end: pssEnd };
  const byType = {}; for (const p of lastTree) { const r = rssKB(p.pid); byType[p.type] = byType[p.type] ?? { n: 0 }; byType[p.type].n++; } rec.treeTypesAtEnd = Object.fromEntries(Object.entries(byType).map(([k, v]) => [k, v.n])); rec.rssUnitCheck = unitCheck;
  rec.memAvailEndKB = samples[s1].avail; rec.memAvailWindowMinKB = Math.min(...inWin.map((s) => s.avail));
  // tree cross-check: every pid Electron itself reports must be in the sampled tree (the selection did not miss a process)
  const treePids = new Set(); for (const m of cpuAt) for (const k of m.keys()) treePids.add(Number(k.split(':')[0])); // every sample, not only the window
  rec.treeMissing = (mainResult.metricsPids ?? []).filter((m) => !treePids.has(m.pid)).length; rec.treePidsMax = Math.max(...samples.map((s) => s.n));
  rec.distinctRenderers = mainResult.distinctRenderers; rec.originsSeen = hostsSeen.size;
  rec.stateOk = !!mainResult.stateOk && hostsSeen.size >= spec.n + 1 && unitCheck?.ratio !== null && Math.abs(unitCheck.ratio - 1) < 0.05;
  rec.state = mainResult.state; rec.livenessFail = mainResult.livenessFail; rec.framesCanary = mainResult.framesCanary; rec.frames = mainResult.frames; rec.idleFrames = mainResult.frames?.hiddenFrames ?? null;
  rec.pageRates = mainResult.pageRates; rec.loadMs = mainResult.loadMs; rec.gpuFeatures = mainResult.gpuFeatures; rec.errors = mainResult.errors; rec.crashEvents = mainResult.crashEvents; rec.costAlloc = mainResult.costAlloc;
  rec.crashes = (mainResult.crashes ?? 0) + (ex.sig && !ownKill ? 1 : 0) + (ex.code && ex.code !== 0 && !ownKill ? 1 : 0);
  rec.series = samples.filter((_s, i) => i >= s0 - 1 && i <= s1 + 1).map((s) => [+((s.ts - ws) / 1000).toFixed(1), s.rss, s.gpu, s.ticks, s.avail, s.n]);
  return finish(rec, dir, attempt);
}
const ELECTRON_VERSION = (() => { try { return JSON.parse(fs.readFileSync(path.join(REPO, 'node_modules/electron/package.json'), 'utf8')).version; } catch { return null; } })();
function finish(rec, dir, attempt) { rec.electron = ELECTRON_VERSION; fs.writeFileSync(path.join(dir, `attempt-${attempt}.json`), JSON.stringify(rec)); return rec; }

// ---------------- the schedule (deterministic; rep-major so drift hits every cell alike; arms rotate their lead each rep) ----------------
const csv = (s) => String(s).split(',').filter(Boolean);
const NS = csv(flag('--ns', '1,8,40')).map(Number), PAGES = csv(flag('--pages', 'idle,busy,heavy')), REPS = Number(flag('--reps', '5'));
const rot = (a, k) => [...a.slice(k % a.length), ...a.slice(0, k % a.length)];
function buildSchedule(stage) {
  const sch = []; let seq = 0; const mk = (o) => sch.push({ ...o, seq: seq++, set: SET, id: `${SET}-${o.kind}-${o.arm}-${o.page}-${o.n}-r${o.rep}` });
  if (stage === 'main') {
    // controls that must fire come FIRST (cheap, and a dead instrument stops the campaign before 3 hours are spent)
    mk({ kind: 'control-abort', arm: 'A1', page: 'idle', n: 8, rep: 0 });
    for (let r = 0; r < 2; r++) mk({ kind: 'control-crash', arm: 'A1', page: 'idle', n: 8, rep: r });
  }
  const ns = stage === 'n160' ? [160] : stage === 'a2' ? NS : NS;
  for (let rep = 0; rep < REPS; rep++) for (const n of ns) for (const page of PAGES) {
    let arms = stage === 'a2' ? ['A0', 'A2'] : ['A0', 'A1'];
    if (stage === 'main' && page === 'idle' && n === 8) arms = [...arms, 'A1x', 'A0b'];
    if (stage === 'main' && page === 'idle' && n === 40) arms = [...arms, 'A0b'];
    const order = rot(arms, rep); order.forEach((arm) => mk({ kind: 'cell', arm, page, n, rep, cellOrder: order.join('>') }));
  }
  return sch;
}
const STAGE = flag('--stage', 'main');
if (!['main', 'n160', 'a2'].includes(STAGE)) refuse('--stage main|n160|a2');
let schedule = buildSchedule(STAGE);
const only = flag('--only', null); if (only) schedule = schedule.filter((s) => s.id.includes(only));
const isDone = (s) => { const d = path.join(OUT, 'runs', s.id); if (!fs.existsSync(d)) return false; const as = fs.readdirSync(d).filter((f) => /^attempt-\d+\.json$/.test(f)).sort(); if (!as.length) return false; const last = JSON.parse(fs.readFileSync(path.join(d, as[as.length - 1]), 'utf8')); if (as.length >= 3) return true; return last.kind === 'cell' ? isValid(last) : (last.kind === 'control-abort' ? last.aborted === 'memavail' : (last.crashes ?? 0) >= 1); };
// N=160 (memory-safety clause): measured directly only if the N=40 rows show the peak fits above 8 GB; else it stays PROJECTED.
if (STAGE === 'n160') {
  const prior = loadDir().filter((r) => r.kind === 'cell' && r.set === 'main' && r.n === 40 && !r.aborted && r.memAvailStartKB && r.memAvailMinKB);
  const avail = memAvail(); const keep = [];
  for (const page of PAGES) {
    const drops = prior.filter((r) => r.page === page).map((r) => (r.memAvailStartKB - r.memAvailMinKB) / 40);
    const slope = drops.length ? Math.max(...drops) : null; const proj = slope === null ? null : avail - slope * 160 * 1.15;
    const fits = proj !== null && proj >= LIMITS.memFloorKB;
    console.error(`[measure] N=160 ${page}: per-view MemAvailable drop (max over N=40 runs) ${slope === null ? 'n/a' : (slope / 1024).toFixed(1) + ' MB'} → projected MemAvailable at peak ${proj === null ? 'n/a' : (proj / GB_KB).toFixed(1) + ' GB'} (now ${(avail / GB_KB).toFixed(1)} GB, floor ${LIMITS.memFloorKB / GB_KB} GB) → ${fits ? 'MEASURE directly' : 'PROJECT (not measured)'}`);
    fs.appendFileSync(path.join(OUT, 'decisions.jsonl'), JSON.stringify({ t: new Date().toISOString(), decision: 'n160', page, perViewDropKB: slope, projectedPeakAvailKB: proj, nowAvailKB: avail, direct: fits }) + '\n');
    if (fits) keep.push(page);
  }
  schedule = schedule.filter((s) => keep.includes(s.page));
}

// ---------------- the batch loop ----------------
const BATCH_MIN = Number(flag('--batch-min', '40'));
const estimateNeedKB = (spec) => { const prior = loadDir().filter((r) => r.kind === 'cell' && r.page === spec.page && r.n === spec.n && r.memAvailStartKB && r.memAvailMinKB && !r.aborted); const d = prior.length ? Math.max(...prior.map((r) => r.memAvailStartKB - r.memAvailMinKB)) * 1.2 : spec.n * 100 * 1024; return LIMITS.memFloorKB + d; };
async function waitForMemory(spec) {
  if (spec.kind === 'control-abort') return true;
  const need = estimateNeedKB(spec), t0 = Date.now(); let last = 0;
  while (memAvail() < need) { if (Date.now() - t0 > 25 * 60000) return false; if (Date.now() - last > 60000) { console.error(`[measure] waiting for MemAvailable ≥ ${(need / GB_KB).toFixed(1)} GB (now ${(memAvail() / GB_KB).toFixed(1)} GB) before ${spec.id}`); last = Date.now(); } await sleep(10000); }
  return true;
}
const todo = schedule.filter((s) => !isDone(s));
console.error(`[measure] stage ${STAGE}${DEV ? ' (DEV: short, never counted)' : ''}: ${schedule.length} scheduled, ${schedule.length - todo.length} done, ${todo.length} to run; settle ${SETTLE}s window ${WINDOW}s; out ${OUT}`);
let ran = 0;
for (const spec of todo) {
  const est = SETTLE + WINDOW + FRAME + 40 + spec.n * 1.2;
  if ((Date.now() - T0) / 1000 + est + 30 > BATCH_MIN * 60) { console.error(`[measure] batch budget ${BATCH_MIN} min reached — ${todo.length - ran} left (resume with the same command)`); break; }
  if (!(await waitForMemory(spec))) { console.error(`[measure] MemAvailable never reached the floor for ${spec.id}; stopping (exit 75)`); process.exitCode = 75; break; }
  const r = await runOne(spec); ran++;
  const ok = r.kind === 'cell' ? isValid(r) : r.kind === 'control-abort' ? r.aborted === 'memavail' : (r.crashes ?? 0) >= 1;
  console.error(`[measure] #${spec.seq} ${spec.id} attempt ${r.attempt} → ${ok ? 'ok' : 'NOT OK'}${r.aborted ? ` aborted=${r.aborted}` : ''} rss=${r.rssKB ? (r.rssKB / 1024).toFixed(0) + 'MB' : 'n/a'} gpu=${r.gpuRssKB ? (r.gpuRssKB / 1024).toFixed(0) + 'MB' : 'n/a'} cpu=${r.cpuPct ?? 'n/a'}% frames=${r.idleFrames} canary=${r.framesCanary} crashes=${r.crashes} ctx=${r.contextLost} procs=${r.treePidsMax ?? 'n/a'} avail-min=${r.memAvailMinKB ? (r.memAvailMinKB / GB_KB).toFixed(1) : 'n/a'}GB${r.error ? ' ERR ' + r.error.slice(0, 200) : ''}${r.errors?.length ? ' errs=' + r.errors.slice(0, 2).join(';').slice(0, 160) : ''}`);
}
server.close();
const HASH_AFTER = liveHashes(); const diff = Object.keys({ ...HASH_BEFORE, ...HASH_AFTER }).filter((k) => HASH_BEFORE[k] !== HASH_AFTER[k]);
console.error(`[measure] HYGIENE: ${Object.keys(HASH_BEFORE).length} live config files hashed before/after → ${diff.length ? 'DIFFERENT: ' + diff.join(', ') + " (the invoking session's own churn on .credentials.json/.claude.json is expected)" : 'byte-equal'}`);
if (EXPORT) exportJsonl(EXPORT);
report(loadDir());
