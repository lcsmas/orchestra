// #406 hidden-view COST probe — Electron MAIN process: ONE run (arm × page × N) in one fresh process. Launched by
// scripts/measure-hidden-views.mjs inside the contained rig (own headless sway, scratch HOME). It builds the views, hides them
// per arm, then SLEEPS through the settle + window (no polling: the outer process samples /proc, this one must not perturb it).
// Env: MEASURE_ARM (A0|A0b|A1|A1x|A2) MEASURE_PAGE (idle|busy|heavy) MEASURE_N MEASURE_PORT MEASURE_OUT MEASURE_SETTLE_S MEASURE_WINDOW_S
//      MEASURE_FRAME_S MEASURE_KILL=1 (crash-counter control) MEASURE_COST_MB (A1x: one hidden page allocates this much).
// Prints `MEASURE_PHASE <name> <epochMs>` lines and one `MEASURE_RESULT <json>`; exits 0.
//   A0 = today: attached at real size, loaded, then removeChildView; throttling default.   A0b = A0 again (the null control).
//   A1 = proposed: attached, loaded, setVisible(false); backgroundThrottling:false.        A1x = A1 + one page allocating COST MB (the positive control).
//   A2 = on-demand: attached + setVisible(false) with throttling ON while idle (the bt0 flip happens only at an agent action).
const { app, BrowserWindow, WebContentsView } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { decodePng, share } = require('./e2e-browser-tabs-png.cjs');

const ARM = process.env.MEASURE_ARM, PAGE = process.env.MEASURE_PAGE, N = Number(process.env.MEASURE_N), PORT = Number(process.env.MEASURE_PORT), OUT = process.env.MEASURE_OUT;
const SETTLE_S = Number(process.env.MEASURE_SETTLE_S ?? 30), WINDOW_S = Number(process.env.MEASURE_WINDOW_S ?? 60), FRAME_S = Number(process.env.MEASURE_FRAME_S ?? 8);
const MUTANT = process.env.MEASURE_MUTANT || ''; // dev self-test: 'nohide' = never hide a view — the state assertion must then read stateOk=false
const KILL = process.env.MEASURE_KILL === '1' || process.env.MEASURE_KILL === 'gpu', KILL_GPU = process.env.MEASURE_KILL === 'gpu', COST_MB = Number(process.env.MEASURE_COST_MB ?? 0);
const result = { arm: ARM, page: PAGE, n: N, errors: [] };
const emit = (obj) => { try { fs.writeSync(1, 'MEASURE_RESULT ' + JSON.stringify(obj) + '\n'); } catch {} };
if (!ARM || !PAGE || !(N >= 0) || !PORT || !OUT) { emit({ ...result, fatal: 'MEASURE_* env unset' }); process.exit(2); }
app.setPath('userData', path.join(OUT, 'userData'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const phase = (name) => { try { fs.writeSync(1, `MEASURE_PHASE ${name} ${Date.now()}\n`); } catch {} };
const bounded = (p, ms) => Promise.race([Promise.resolve(p).then((v) => ({ ok: true, v }), (e) => ({ ok: false, e: String((e && e.message) || e).slice(0, 160) })), sleep(ms).then(() => ({ ok: false, e: 'timeout ' + ms }))]);

const THROTTLE_OFF = ARM === 'A1' || ARM === 'A1x'; // webPreferences.backgroundThrottling:false (A0/A0b/A2 keep the default)
const DETACH = ARM === 'A0' || ARM === 'A0b'; // removeChildView vs setVisible(false)
const crashes = [], watchers = [];
app.on('child-process-gone', (_e, d) => crashes.push({ src: 'child-process-gone', type: d.type, reason: d.reason, exitCode: d.exitCode }));
const watchdog = setTimeout(() => { result.errors.push('watchdog'); emit(result); process.exit(3); }, (SETTLE_S + WINDOW_S + FRAME_S + 60 + N * 4) * 1000);

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1000, height: 700, frame: false, show: true, backgroundColor: '#1a1f26' });
  await win.loadURL('data:text/html,' + encodeURIComponent('<body style="margin:0;background:#1a1f26">'));
  await sleep(1500); // sway maps + sizes the window
  const fullRect = () => { const b = win.getContentBounds(); return { x: 0, y: 0, width: b.width, height: b.height }; };
  const mk = (partition) => {
    const webPreferences = { partition, nodeIntegration: false, contextIsolation: true, sandbox: true, ...(THROTTLE_OFF ? { backgroundThrottling: false } : {}) };
    const v = new WebContentsView({ webPreferences }); v.setBackgroundColor('#1a1f26');
    if (THROTTLE_OFF) v.webContents.setBackgroundThrottling(false);
    v.webContents.on('render-process-gone', (_e, d) => crashes.push({ src: 'render-process-gone', reason: d.reason, exitCode: d.exitCode }));
    return v;
  };
  const keep = []; // strong refs: an unreferenced WebContentsView is GC'd and its webContents destroyed mid-run
  const url = (host) => `http://${host}.localhost:${PORT}/${PAGE}`;
  // the human's visible tab: one static page on its own origin, attached + composited in EVERY arm (it cancels in the A1−A0 delta)
  const v0 = mk('m406-vis'); keep.push(v0); win.contentView.addChildView(v0); v0.setBounds(fullRect());
  const l0 = await bounded(v0.webContents.loadURL(`http://vis.localhost:${PORT}/vis`), 30000); if (!l0.ok) result.errors.push('visible load: ' + l0.e);
  await sleep(500);
  // N loaded views, each attached at real size and LOADED while visible (spike condition 1), then hidden per arm. 8 views per partition, as the app's workspaces.
  const views = []; const t0 = Date.now(); let loadFail = 0;
  for (let i = 0; i < N; i++) {
    const v = mk(`m406-ws${Math.floor(i / 8)}`); keep.push(v); views.push(v);
    win.contentView.addChildView(v); v.setBounds(fullRect());
    const l = await bounded(v.webContents.loadURL(url('h' + i)), 30000);
    if (!l.ok) { loadFail++; result.errors.push(`load ${i}: ${l.e}`); }
    if (COST_MB > 0 && ARM === 'A1x' && i === 0) { const r = await bounded(v.webContents.executeJavaScript(`window.__cost = new Uint8Array(${COST_MB} * 1024 * 1024).fill(7); window.__cost.length`), 20000); result.costAlloc = r.ok ? r.v : r.e; }
    await sleep(200); // let the first surface commit before hiding
    if (MUTANT === 'nohide') { /* mutant: leave the view painting on top */ } else if (DETACH) win.contentView.removeChildView(v); else v.setVisible(false);
  }
  result.loadMs = Date.now() - t0; result.loadFail = loadFail;
  // ---- the arm's own state assertion (a run whose arm was not really built is invalid, never a "result") ----
  // Electron 33 has no View.getVisible(), and with backgroundThrottling:false document.visibilityState stays 'visible' on a hidden view (#402 finding 8),
  // so the proof of "hidden" is the SCREEN: the compositor output must show the human's tab (magenta) and none of the hidden pages (blue) —
  // a hide that did not take would leave the last-added view painting on top. A0 additionally reads the pages' own 'hidden' state.
  const kids = win.contentView.children.length;
  await sleep(1200);
  const screen = await new Promise((resolve) => { const f = path.join(OUT, 'screen.png'); execFile('grim', ['-s', '0.25', '-o', 'HEADLESS-1', f], { env: { PATH: process.env.PATH, WAYLAND_DISPLAY: process.env.WAYLAND_DISPLAY, XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR }, timeout: 15000 }, (err) => {
    if (err) return resolve({ error: String(err.message).slice(0, 120) });
    try { const I = decodePng(fs.readFileSync(f)); const rect = { x: 0, y: 0, width: I.w, height: I.h }; resolve({ visibleTab: +share(I, rect, [200, 30, 138]).toFixed(3), hiddenPages: +share(I, rect, [30, 138, 200]).toFixed(3) }); } catch (e) { resolve({ error: String(e.message).slice(0, 120) }); } }); });
  const vis = [];
  for (let i = 0; i < views.length; i += 20) vis.push(...(await Promise.all(views.slice(i, i + 20).map((v) => bounded(v.webContents.executeJavaScript('document.visibilityState'), 10000)))));
  const v0vis = await bounded(v0.webContents.executeJavaScript('document.visibilityState'), 10000);
  const hiddenN = vis.filter((r) => r.ok && r.v === 'hidden').length;
  result.state = { children: kids, wantChildren: DETACH ? 1 : N + 1, pagesReadingHidden: hiddenN, visibleTabState: v0vis.ok ? v0vis.v : v0vis.e, screen };
  result.stateOk = loadFail === 0 && kids === result.state.wantChildren && v0vis.ok && v0vis.v === 'visible' && screen.visibleTab >= 0.9 && screen.hiddenPages <= 0.02 && (!DETACH || hiddenN === N);
  const pids = views.map((v) => v.webContents.getOSProcessId());
  result.distinctRenderers = new Set([...pids, v0.webContents.getOSProcessId()]).size;
  result.gpuFeatures = (() => { try { const f = app.getGPUFeatureStatus(); return { gpu_compositing: f.gpu_compositing, rasterization: f.rasterization, webgl: f.webgl, skia_graphite: f.skia_graphite }; } catch (e) { return String(e); } })();
  phase('loaded-all');
  await sleep(SETTLE_S * 1000);
  const tWinStart = Date.now(); phase('window-start');
  if (KILL && views[0]) { await sleep((WINDOW_S * 1000) / 2); const target = KILL_GPU ? app.getAppMetrics().find((m) => m.type === 'GPU')?.pid : pids[0]; result.killed = { what: KILL_GPU ? 'gpu-process' : 'renderer', pid: target ?? null }; try { process.kill(target, 'SIGKILL'); } catch (e) { result.errors.push('kill: ' + e.message); } await sleep((WINDOW_S * 1000) / 2); }
  else await sleep(WINDOW_S * 1000);
  const tWinEnd = Date.now(); phase('window-end');

  // ---- after the window (nothing below perturbs the measured window) ----
  result.metricsPids = app.getAppMetrics().map((m) => ({ pid: m.pid, type: m.type }));
  const alive = views.filter((v) => v.webContents && !v.webContents.isDestroyed());
  const probes = [];
  for (let i = 0; i < alive.length; i += 20) probes.push(...(await Promise.all(alive.slice(i, i + 20).map((v) => bounded(v.webContents.executeJavaScript(PAGE === 'busy' ? 'JSON.stringify(window.__spike.snap())' : 'document.readyState'), 10000)))));
  result.livenessFail = (N - alive.length) + probes.filter((p) => !p.ok).length;
  if (PAGE === 'busy') {
    const tSnap = Date.now(); const rates = { timer: [], raf: [] };
    for (const p of probes) if (p.ok) { try { const s = JSON.parse(p.v); const wStart = s.now - (tSnap - tWinStart), wEnd = s.now - (tSnap - tWinEnd); rates.timer.push(s.timer.filter((t) => t >= wStart && t <= wEnd).length / WINDOW_S); rates.raf.push(s.raf.filter((t) => t >= wStart && t <= wEnd).length / WINDOW_S); } catch {} }
    const med = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[s.length >> 1] : null; };
    result.pageRates = { timerPerS: { min: Math.min(...rates.timer), med: med(rates.timer), max: Math.max(...rates.timer) }, rafPerS: { min: Math.min(...rates.raf), med: med(rates.raf), max: Math.max(...rates.raf) }, views: rates.timer.length };
  }
  // frames: beginFrameSubscription on up to 8 evenly spaced hidden views (+ the visible static tab) over FRAME_S seconds; counts callbacks only
  const K = Math.min(N, 8), sample = Array.from({ length: K }, (_, j) => alive[Math.floor((j * alive.length) / Math.max(K, 1))]).filter(Boolean);
  // each callback is timestamped from its own subscription: a subscription delivers ONE refresh frame when it starts (measured: 1 per view on a static hidden page),
  // so only frames after SETTLE_MS count as "idle frames"; the start-up frames are recorded apart and never judged.
  const SETTLE_MS = 2000; const stamps = new Map();
  const sub = (wc, key) => { stamps.set(key, []); const t = Date.now(); try { wc.beginFrameSubscription(true, () => stamps.get(key).push(Date.now() - t)); } catch (e) { result.errors.push('beginFrameSubscription: ' + e.message); } };
  const steady = (key) => stamps.get(key).filter((x) => x >= SETTLE_MS).length, initial = (key) => stamps.get(key).filter((x) => x < SETTLE_MS).length;
  sample.forEach((v, j) => sub(v.webContents, 'h' + j)); sub(v0.webContents, 'visible-static');
  await sleep(FRAME_S * 1000);
  const keys = sample.map((_v, j) => 'h' + j);
  result.frames = { sampledHidden: sample.length, seconds: FRAME_S, settleMs: SETTLE_MS, hiddenFrames: keys.reduce((s, k) => s + steady(k), 0), initialFrames: keys.reduce((s, k) => s + initial(k), 0), perViewSteady: keys.map(steady), perViewInitial: keys.map(initial), visibleStaticSteady: steady('visible-static'), visibleStaticInitial: initial('visible-static') };
  for (const v of [...sample, v0]) { try { v.webContents.endFrameSubscription(); } catch {} }
  // positive control of the frame instrument: the VISIBLE tab navigates to the busy page and must deliver frames
  let canary = 0; try { v0.webContents.beginFrameSubscription(true, () => { canary++; }); } catch {}
  const nv = await bounded(v0.webContents.loadURL(`http://vis.localhost:${PORT}/busy`), 20000); if (!nv.ok) result.errors.push('canary load: ' + nv.e);
  await sleep(4000); try { v0.webContents.endFrameSubscription(); } catch {}
  result.framesCanary = canary;
  result.crashEvents = crashes;
  result.crashes = crashes.filter((c) => c.reason !== 'clean-exit' && c.reason !== 'normal-termination').length;
  emit(result);
  clearTimeout(watchdog);
  process.exit(0);
}).catch((e) => { result.errors.push('fatal: ' + (e && e.stack || e)); emit(result); process.exit(4); });
