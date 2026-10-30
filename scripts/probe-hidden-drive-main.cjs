// #406 phase 2, design iteration 1 — Electron MAIN-process probe: ONE scenario, ONE fresh process, bare Electron (no app code).
// Question: with the A2 policy (hidden view = attached + setVisible(false), throttled while idle, backgroundThrottling:false only around an agent action),
// does an agent action on a hidden view see a FRESH frame, land click/type, and does the view go back to throttled?  Env: PROBE_SCEN PROBE_FLIP PROBE_OUT PROBE_OTHERS.
//   A  loaded while attached+visible (the human looked at it), then hidden; page changes colour while hidden; ACTION = flip + capture ×4 forms + click + type; flip back
//   B  as A, then the HIDDEN view NAVIGATES to a new document (colour C) before the action (agent `open` on a background tab)
//   C  loaded DETACHED (never attached), attached visible for 700 ms (the human opens its pane once), hidden; action
//   D  P6: loaded DETACHED, attached BELOW the opaque visible tab at real size for D_MS, then hidden; action  (PROBE_ATTACH_MS)
//   E  the app-side "is this window being displayed" probe: the MAIN window's renderer rAF with a 300 ms deadline, window shown vs sway workspace switched away
// PROBE_FLIP=flip (A2: setBackgroundThrottling(false) right before the action, true after) | noflip (the must-FAIL arm: capture with throttling ON).
const { app, BrowserWindow, WebContentsView } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, execFile } = require('node:child_process');
const { decodePng, share } = require('./e2e-browser-tabs-png.cjs');

const STRAT = process.env.PROBE_STRAT || 'native', BACK = process.env.PROBE_BACK || 'bt', SCEN = process.env.PROBE_SCEN, FLIP = process.env.PROBE_FLIP !== 'noflip', OUT = process.env.PROBE_OUT, OTHERS = Number(process.env.PROBE_OTHERS ?? 8), ATTACH_MS = Number(process.env.PROBE_ATTACH_MS ?? 800);
const result = { scen: SCEN, flip: FLIP, others: OTHERS, steps: [] };
const emit = () => { try { fs.writeSync(1, 'PROBE_RESULT ' + JSON.stringify(result) + '\n'); } catch {} };
app.setPath('userData', path.join(OUT, 'userData'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const bounded = (p, ms) => Promise.race([Promise.resolve(p).then((v) => ({ ok: true, v }), (e) => ({ ok: false, e: String((e && e.message) || e).slice(0, 140) })), sleep(ms).then(() => ({ ok: false, e: 'timeout ' + ms }))]);
const HEX = (c) => '#' + c.map((n) => n.toString(16).padStart(2, '0')).join('');
const COL = { A: [200, 30, 138], B: [30, 138, 200], C: [30, 200, 100], HUMAN: [26, 31, 38] };
const page = (c, busy) => 'data:text/html;charset=utf-8,' + encodeURIComponent(`<!doctype html><meta charset=utf-8><title>probe</title><style>html,body{margin:0;height:100%;background:${HEX(c)}}</style><input id=in style="position:fixed;left:300px;top:300px;width:200px;height:30px"><div style="height:4000px"></div><script>
const T0=performance.now(),timer=[];let mouse=0;addEventListener('mousedown',()=>mouse++,true);${busy ? 'setInterval(()=>timer.push(performance.now()-T0),50);' : ''}
window.__p={now:()=>performance.now()-T0,setBg(c){document.documentElement.style.background=c;document.body.style.background=c},snap(){return{now:performance.now()-T0,timer:timer.slice(),mouse,value:document.getElementById('in').value}}};</script>`);

function analyze(img) {
  const sz = img.getSize(); if (!sz.width || !sz.height) return { kind: 'empty', w: sz.width, h: sz.height };
  const small = sz.width > 320 ? img.resize({ width: 320 }) : img; const I = decodePng(small.toPNG()); const rect = { x: 0, y: 0, width: I.w, height: I.h };
  const s = Object.fromEntries(Object.entries(COL).map(([k, v]) => [k, share(I, rect, v)]));
  const best = Object.entries(s).sort((a, b) => b[1] - a[1])[0];
  return { kind: best[1] >= 0.5 ? best[0] : 'other', w: sz.width, h: sz.height };
}
function grimShare() {
  return new Promise((resolve) => { const f = path.join(OUT, 'screen.png'); execFile('grim', ['-s', '0.25', '-o', 'HEADLESS-1', f], { env: { PATH: process.env.PATH, WAYLAND_DISPLAY: process.env.WAYLAND_DISPLAY, XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR }, timeout: 15000 }, (err) => {
    if (err) return resolve(null);
    try { const I = decodePng(fs.readFileSync(f)); const rect = { x: 0, y: 0, width: I.w, height: I.h }; resolve(Object.fromEntries(Object.entries(COL).map(([k, v]) => [k, +share(I, rect, v).toFixed(3)]))); } catch { resolve(null); } }); });
}

app.whenReady().then(async () => {
  const watchdog = setTimeout(() => { result.error = 'watchdog'; emit(); process.exit(3); }, 120000);
  const win = new BrowserWindow({ width: 1000, height: 700, frame: false, show: true, backgroundColor: HEX(COL.HUMAN) });
  await win.loadURL('data:text/html,' + encodeURIComponent(`<body style="margin:0;background:${HEX(COL.HUMAN)}">`));
  await sleep(1500);
  const rect = () => { const b = win.getContentBounds(); return { x: 0, y: 0, width: b.width, height: b.height }; };
  const keep = [];
  const mk = (n) => { const v = new WebContentsView({ webPreferences: { partition: 'probe-' + n, nodeIntegration: false, contextIsolation: true, sandbox: true } }); v.setBackgroundColor(HEX(COL.HUMAN)); keep.push(v); return v; };
  const attach = (v, index) => { index === undefined ? win.contentView.addChildView(v) : win.contentView.addChildView(v, index); v.setBounds(rect()); };
  if (SCEN === 'E') {
    const probe = async (label) => { const t = Date.now(); const r = await bounded(win.webContents.executeJavaScript('new Promise((res) => requestAnimationFrame(() => res(true)))'), 300); return { label, fired: r.ok, ms: Date.now() - t }; };
    const sway = (...a) => execFileSync('swaymsg', a, { encoding: 'utf8', timeout: 8000 });
    result.shown = []; for (let i = 0; i < 6; i++) { result.shown.push(await probe('shown')); await sleep(250); }
    const from = JSON.parse(sway('-t', 'get_workspaces')).find((w) => w.focused).name; sway('workspace', 'probe-away'); await sleep(600);
    result.away = []; for (let i = 0; i < 6; i++) { result.away.push(await probe('away')); await sleep(250); }
    sway('workspace', from); await sleep(600);
    result.back = []; for (let i = 0; i < 6; i++) { result.back.push(await probe('back')); await sleep(250); }
    clearTimeout(watchdog); emit(); process.exit(0);
  }
  if (SCEN === 'F') { // the app-side "window displayed" signal from a CHILD view's rAF (the main window's own rAF is no signal: E fired 18/18 while away)
    const vv = mk('sig'); attach(vv); await vv.webContents.loadURL('data:text/html,' + encodeURIComponent('<body style="margin:0;background:#1a1f26"><script>let n=0;(function f(){n++;requestAnimationFrame(f)})();window.__n=()=>n</script>')); await sleep(600);
    const rate = async (label, ms) => { const a = await bounded(vv.webContents.executeJavaScript('__n()'), 2000); const t = Date.now(); await sleep(ms); const b = await bounded(vv.webContents.executeJavaScript('__n()'), 2000); return { label, ms: Date.now() - t, ticks: a.ok && b.ok ? b.v - a.v : null, ok: a.ok && b.ok }; };
    const sway = (...a) => execFileSync('swaymsg', a, { encoding: 'utf8', timeout: 8000 });
    result.shown = []; for (let i = 0; i < 4; i++) result.shown.push(await rate('shown', 300));
    const from = JSON.parse(sway('-t', 'get_workspaces')).find((w) => w.focused).name; sway('workspace', 'probe-away'); await sleep(700);
    result.away = []; for (let i = 0; i < 4; i++) result.away.push(await rate('away', 300));
    sway('workspace', from); await sleep(700);
    result.back = []; for (let i = 0; i < 4; i++) result.back.push(await rate('back', 300));
    clearTimeout(watchdog); emit(); process.exit(0);
  }
  if (SCEN === 'G') { // how long does the view keep ticking after the flip-back, as a function of how long it was held unthrottled?
    const v = mk('g'); attach(v); await v.webContents.loadURL(page(COL.A, true)); await sleep(600); v.setVisible(false); await sleep(3000);
    const hold = Number(process.env.PROBE_HOLD_MS || 1000); const w = v.webContents;
    w.setBackgroundThrottling(false); await sleep(hold); w.setBackgroundThrottling(true);
    const snap = async () => JSON.parse((await bounded(w.executeJavaScript('JSON.stringify(__p.snap())'), 3000)).v || '{}'); let prev = await snap(); const tl = [];
    for (let i = 0; i < 24; i++) { await sleep(500); const q = await snap(); tl.push(prev.timer && q.timer ? +(((q.timer.length - prev.timer.length) / ((q.now - prev.now) / 1000))).toFixed(0) : null); prev = q; }
    result.hold = hold; result.timeline500 = tl; result.reThrottledAtMs = (() => { const i = tl.findIndex((x, j) => x !== null && x <= 2 && tl.slice(j).every((y) => y === null || y <= 3)); return i < 0 ? null : (i + 1) * 500; })();
    clearTimeout(watchdog); emit(); process.exit(0);
  }
  // the human's visible tab (opaque, magenta-free) on top of the window; OTHERS hidden loaded views present
  const v0 = mk('human'); attach(v0); await v0.webContents.loadURL(page(COL.HUMAN, false)); await sleep(400);
  for (let i = 0; i < OTHERS; i++) { const v = mk('o' + i); attach(v); await v.webContents.loadURL(page(COL.C, true)); await sleep(150); v.setVisible(false); }
  const T = mk('target'); const wc = T.webContents; result.steps.push('others+human ready');
  const busy = true;
  if (SCEN === 'A' || SCEN === 'B') { attach(T); await wc.loadURL(page(COL.A, busy)); await sleep(800); T.setVisible(false); }
  else if (SCEN === 'C') { await wc.loadURL(page(COL.A, busy)); await sleep(300); attach(T); await sleep(700); T.setVisible(false); }
  else if (SCEN === 'D') { await wc.loadURL(page(COL.A, busy)); await sleep(300); attach(T, 0); result.leakDuringAttach = []; const t0 = Date.now(); while (Date.now() - t0 < ATTACH_MS) { result.leakDuringAttach.push(await grimShare()); await sleep(40); } T.setVisible(false); }
  result.leakMaxBlue = Math.max(0, ...((result.leakDuringAttach || []).filter(Boolean).map((g) => Math.max(g.A, g.B))));
  await sleep(2500); // idle, hidden, THROTTLED
  const idle0 = await bounded(wc.executeJavaScript('JSON.stringify(__p.snap())'), 5000); result.idleSnapOk = idle0.ok;
  if (SCEN === 'B') { await wc.loadURL(page(COL.C, busy)); await sleep(300); }
  const want = SCEN === 'B' ? 'C' : 'B';
  if (SCEN !== 'B') await bounded(wc.executeJavaScript(`__p.setBg('${HEX(COL.B)}')`), 5000); // the page changes while hidden: a STALE frame is distinguishable
  await sleep(1200);
  // ---------------- the agent ACTION ----------------
  const tAct = Date.now();
  const sway = (...a) => execFileSync('swaymsg', a, { encoding: 'utf8', timeout: 8000 }); let awayFrom = null;
  if (process.env.PROBE_AWAY === '1') { awayFrom = JSON.parse(sway('-t', 'get_workspaces')).find((w) => w.focused).name; sway('workspace', 'probe-away'); await sleep(500); }
  if (FLIP) wc.setBackgroundThrottling(false);
  const dbg = wc.debugger; try { dbg.attach('1.3'); } catch (e) { result.attachError = String(e.message || e).slice(0, 100); }
  const cap = async (name, fn) => { const t = Date.now(); const r = await bounded(fn(), 5000); const o = { name, ms: Date.now() - t, outcome: r.ok ? 'ok' : r.e }; if (r.ok) Object.assign(o, analyze(r.v)); o.fresh = o.kind === want; return o; };
  const cdp = (params) => async () => { const r = await dbg.sendCommand('Page.captureScreenshot', { format: 'png', ...params }); return require('electron').nativeImage.createFromBuffer(Buffer.from(r.data, 'base64')); };
  const forms = [['capturePage', () => wc.capturePage()], ['cdp-default', cdp({})], ['cdp-fromSurfaceFalse', cdp({ fromSurface: false })], ['cdp-beyondViewport', cdp({ captureBeyondViewport: true, clip: { x: 0, y: 0, width: 400, height: 300, scale: 1 } })]];
  if (process.env.PROBE_ORDER === 'rev') forms.reverse();
  result.caps = [];
  if (STRAT === 'fs0') { // every form with fromSurface:false (the renderer paints on demand: no compositor surface needed)
    const fs0 = [['fs0', {}], ['fs0+beyond', { captureBeyondViewport: true }], ['fs0+beyond+clip', { captureBeyondViewport: true, clip: { x: 0, y: 0, width: 400, height: 300, scale: 1 } }], ['fs0+clip', { clip: { x: 0, y: 0, width: 400, height: 300, scale: 1 } }]];
    if (process.env.PROBE_ORDER === 'rev') fs0.reverse();
    for (const [n, p] of fs0) result.caps.push(await cap(n, cdp({ fromSurface: false, ...p })));
  } else if (STRAT === 'sub') { // frame-subscription capture: the first callback is a REFRESH frame of the view's current surface
    const subCap = (onlyDirty) => cap(onlyDirty ? 'sub-dirty' : 'sub-all', () => new Promise((res, rej) => { let done = false; const t = setTimeout(() => rej(new Error('no frame')), 4800); wc.beginFrameSubscription(onlyDirty, (img) => { if (done) return; done = true; clearTimeout(t); try { wc.endFrameSubscription(); } catch {} res(img); }); }));
    result.caps.push(await subCap(false)); result.caps.push(await subCap(true));
  } else for (const [n, f] of forms) result.caps.push(await cap(n, f));
  result.firstFreshMs = (result.caps[0].fresh ? result.caps[0].ms : null);
  // click + type (the app's own input path: CDP Input.*)
  const t1 = Date.now(); const send = (m, p) => bounded(dbg.sendCommand(m, p), 3000);
  const before = JSON.parse((await bounded(wc.executeJavaScript('JSON.stringify(__p.snap())'), 3000)).v || '{}');
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 350, y: 315, button: 'left', clickCount: 1 }); await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 350, y: 315, button: 'left', clickCount: 1 });
  await send('Input.insertText', { text: 'hello' });
  let landed = null; for (let i = 0; i < 40; i++) { const s = await bounded(wc.executeJavaScript('JSON.stringify(__p.snap())'), 2000); const q = s.ok ? JSON.parse(s.v) : null; if (q && q.mouse > (before.mouse || 0) && q.value === 'hello') { landed = Date.now() - t1; break; } await sleep(25); }
  result.inputLandedMs = landed;
  result.actionMs = Date.now() - tAct;
  if (awayFrom) { sway('workspace', awayFrom); await sleep(300); }
  // flip back and measure the throttle: timers/s in consecutive 1 s buckets for 8 s (P3: <= 2/s within 2 s)
  if (FLIP) { wc.setBackgroundThrottling(true); if (BACK === 'bt+rehide') { T.setVisible(true); await sleep(30); T.setVisible(false); } }
  const snap = async () => JSON.parse((await bounded(wc.executeJavaScript('JSON.stringify(__p.snap())'), 3000)).v || '{}');
  let prev = await snap(); result.throttleBack = [];
  for (let i = 0; i < 8; i++) { await sleep(1000); const q = await snap(); result.throttleBack.push(prev.timer && q.timer ? +(((q.timer.length - prev.timer.length) / ((q.now - prev.now) / 1000))).toFixed(1) : null); prev = q; }
  result.timersPerSAfter = result.throttleBack[1];
  try { dbg.detach(); } catch {}
  const g = await grimShare(); result.screenAtEnd = g; // the human's tab must still be the only thing on screen
  clearTimeout(watchdog); emit(); process.exit(0);
}).catch((e) => { result.error = String(e && e.stack || e); emit(); process.exit(4); });
