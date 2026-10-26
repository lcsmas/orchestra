// #402 hidden-view spike — Electron MAIN-process probe: ONE arm, ONE iteration, one fresh process.
// Launched by scripts/spike-hidden-view.mjs inside the contained rig (own headless sway, scratch HOME).
// Env: SPIKE_ARM, SPIKE_OUT, SPIKE_WINDOW_S (hidden idle window, default 12), SPIKE_ORDER (fwd|rev capture order),
// SPIKE_SWITCHES (comma list of Chromium switches). Prints `SPIKE_RESULT <json>` and exits 0.
// Question: does a view that is not composited in the main window still produce frames (capturePage / CDP
// screenshot / screencast / rAF) and un-throttled timers?  Every arm ends with a SHOW-BACK control on the same
// object: if that does not read the page's fresh colour the run is INVALID (not "negative").
const { app, BaseWindow, BrowserWindow, BrowserView, WebContentsView } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { decodePng, share } = require('./e2e-browser-tabs-png.cjs');

const ARM = process.env.SPIKE_ARM || '';
const OUT = process.env.SPIKE_OUT;
const WIN_S = Number(process.env.SPIKE_WINDOW_S || 12);
const MUTANT = process.env.SPIKE_MUTANT || ''; // instrument self-test: 'noflip' = never change the page colour after hiding (a 'fresh' reading must then be impossible)
const P2_MS = Number(process.env.SPIKE_P2_MS ?? 4000); // phase-2 length; 0 = capture immediately after prepare() (the agent's real flow)
const LEAK = process.env.SPIKE_LEAK_SAMPLER === '1'; // sample the compositor all through the hidden phase for a transient flash
const ORDER = process.env.SPIKE_ORDER === 'rev' ? 'rev' : 'fwd';
const SWITCHES = (process.env.SPIKE_SWITCHES || '').split(',').filter(Boolean);
if (!ARM || !OUT) { console.log('SPIKE_RESULT ' + JSON.stringify({ arm: ARM, error: 'SPIKE_ARM / SPIKE_OUT unset' })); process.exit(2); }
app.setPath('userData', path.join(OUT, 'userData'));
for (const s of SWITCHES) { const [k, v] = s.split('='); v === undefined ? app.commandLine.appendSwitch(k) : app.commandLine.appendSwitch(k, v); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SKIP = (process.env.SPIKE_SKIP || '').split(',').filter(Boolean); // steps to bypass (to get past a crashing one)
const skip = (n) => SKIP.includes(n);
const step = (n) => { try { fs.writeSync(1, `SPIKE_STEP ${n}\n`); } catch (e) { /* pipe closed */ } };
const A = [200, 30, 138], B = [30, 138, 200], BLANK = [26, 31, 38];
const HEX = (c) => '#' + c.map((n) => n.toString(16).padStart(2, '0')).join('');
const PAGE = `<!doctype html><meta charset=utf-8><title>spike</title>
<style>html,body{margin:0;height:100%;background:${HEX(A)}}
#sq{position:fixed;left:0;top:60px;width:40px;height:40px;background:#fff;animation:mv 1s linear infinite alternate}
@keyframes mv{from{transform:translateX(0)}to{transform:translateX(200px)}}</style><div id=sq></div><input id=in style="position:fixed;left:300px;top:300px;width:200px;height:30px"><div style="height:4000px"></div>
<script>
const T0=performance.now(),timer=[],raf=[],vis=[];let mouse=0,keys=0,inputs=0;
addEventListener('mousedown',()=>mouse++,true);addEventListener('keydown',()=>keys++,true);addEventListener('input',()=>inputs++,true);
setInterval(()=>timer.push(performance.now()-T0),50);
(function f(){raf.push(performance.now()-T0);requestAnimationFrame(f)})();
document.addEventListener('visibilitychange',()=>vis.push([performance.now()-T0,document.visibilityState]));
window.__spike={now:()=>performance.now()-T0,
  setBg(c){document.documentElement.style.background=c;document.body.style.background=c},
  snap(){return{now:performance.now()-T0,timer:timer.slice(),raf:raf.slice(),vis:vis.slice(),state:document.visibilityState,hidden:document.hidden,mouse,keys,inputs,value:document.getElementById('in').value,scrollY:window.scrollY}}};
</script>`;
const PAGE_URL = 'data:text/html;charset=utf-8,' + encodeURIComponent(PAGE);

// Outcome wrapper: a hung promise is DATA ('timeout'), never a hang of the probe. `late` records a settle after the timeout.
const keep = []; // strong refs: an unreferenced WebContentsView/BrowserWindow is GC'd and its webContents destroyed mid-run
const late = [];
async function bounded(label, p, ms) {
  let done = false, timedOut = false;
  const tp = Promise.resolve(p).then((v) => { done = true; if (timedOut) late.push(label); return { outcome: 'ok', v }; },
    (e) => { done = true; return { outcome: 'error', msg: String(e && e.message || e).slice(0, 200) }; });
  const r = await Promise.race([tp, sleep(ms).then(() => (done ? null : (timedOut = true, { outcome: 'timeout', ms })))]);
  return r;
}
const js = (wc, code, ms = 4000) => bounded('js:' + code.slice(0, 24), wc.executeJavaScript(code), ms);

function analyze(img) {
  const sz = img.getSize();
  if (!sz.width || !sz.height) return { w: sz.width, h: sz.height, kind: 'empty' };
  const small = sz.width > 320 ? img.resize({ width: 320 }) : img;
  const I = decodePng(small.toPNG()); const rect = { x: 0, y: 0, width: I.w, height: I.h };
  const a = share(I, rect, A), b = share(I, rect, B), blank = share(I, rect, BLANK);
  const kind = b >= 0.5 ? 'fresh' : a >= 0.5 ? 'stale' : blank >= 0.5 ? 'blank-appbg' : 'other';
  const rgb = [0, 1, 2].map((c) => { let t = 0, n = 0; for (let i = c; i < I.data.length; i += I.ch) { t += I.data[i]; n++; } return Math.round(t / n); });
  return { w: sz.width, h: sz.height, kind, A: +a.toFixed(3), B: +b.toFixed(3), appbg: +blank.toFixed(3), rgb };
}
const fromBounded = (r, fn) => (r.outcome === 'ok' ? { outcome: 'ok', ...fn(r.v) } : r);
const capPage = (wc, pre) => async () => { if (pre) { try { wc.invalidate(); } catch (e) { /* recorded by caller */ } } return fromBounded(await bounded('capturePage', wc.capturePage(), 4000), (img) => analyze(img)); };
const cdp = (wc, params) => async () => {
  const r = await bounded('cdp:' + JSON.stringify(params), wc.debugger.sendCommand('Page.captureScreenshot', { format: 'png', ...params }), 4000);
  return fromBounded(r, (res) => analyze(require('electron').nativeImage.createFromBuffer(Buffer.from(res.data, 'base64'))));
};

function grimOutput(tag) {
  const f = path.join(OUT, `${tag}.png`);
  execFileSync('grim', ['-o', 'HEADLESS-1', f], { env: { PATH: process.env.PATH, WAYLAND_DISPLAY: process.env.WAYLAND_DISPLAY, XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR }, timeout: 15000 });
  const I = decodePng(fs.readFileSync(f)); const rect = { x: 0, y: 0, width: I.w, height: I.h };
  return { A: +share(I, rect, A).toFixed(3), B: +share(I, rect, B).toFixed(3), appbg: +share(I, rect, BLANK).toFixed(3), file: f };
}
function grimAsync() { // downscaled (-s 0.25) so the sampler stays cheap; flat colours survive scaling
  const f = path.join(OUT, 'sample.png');
  return new Promise((resolve) => require('node:child_process').execFile('grim', ['-s', '0.25', '-o', 'HEADLESS-1', f], { env: { PATH: process.env.PATH, WAYLAND_DISPLAY: process.env.WAYLAND_DISPLAY, XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR }, timeout: 15000 }, (err) => {
    if (err) return resolve(null);
    try { const I = decodePng(fs.readFileSync(f)); const rect = { x: 0, y: 0, width: I.w, height: I.h }; resolve(share(I, rect, A) + share(I, rect, B)); } catch (e) { resolve(null); }
  }));
}
function swayWindows() {
  try {
    const t = JSON.parse(execFileSync('swaymsg', ['-t', 'get_tree'], { encoding: 'utf8', timeout: 8000 }));
    let n = 0; const walk = (x) => { if ((x.pid || x.app_id || x.window_properties) && !(x.nodes || []).length && !(x.floating_nodes || []).length && x.type !== 'output' && x.type !== 'workspace' && x.type !== 'root') n++; for (const c of [...(x.nodes || []), ...(x.floating_nodes || [])]) walk(c); };
    walk(t); return n;
  } catch (e) { return null; }
}

// ---------- arm table ----------------------------------------------------------------------------
// make(c) -> handle { wc, visibleAtStart, hide(), show() }.  c = { main, bt, mkView, full(), hiddenWin(kind) }
const BASES = {
  'ctl-visible': { desc: 'POSITIVE CONTROL: view composited in the main window (never hidden)', async make(c) { const v = c.mkView(); keep.push(v); c.addFull(v); await v.webContents.loadURL(PAGE_URL); return { wc: v.webContents, visibleAtStart: true, hide() {}, show() {} }; } },
  'a1-detached-never': { desc: '(a) WebContentsView never added to a contentView', async make(c) { const v = c.mkView(); keep.push(v); await v.webContents.loadURL(PAGE_URL); return { wc: v.webContents, visibleAtStart: false, hide() {}, show() { c.addFull(v); } }; } },
  'a2-detached-after-shown': { desc: '(a) WebContentsView shown, then removeChildView (the app\'s background-workspace path)', async make(c) { const v = c.mkView(); keep.push(v); c.addFull(v); await v.webContents.loadURL(PAGE_URL); return { wc: v.webContents, visibleAtStart: true, hide() { c.main.contentView.removeChildView(v); }, show() { c.addFull(v); } }; } },
  'b1-hidden-window': { desc: '(b) hidden BrowserWindow(show:false) hosting the page as its own webContents', async make(c) { const w = new BrowserWindow({ show: false, width: 800, height: 600, webPreferences: c.wp() }); keep.push(w); await w.loadURL(PAGE_URL); return { wc: w.webContents, visibleAtStart: false, hide() {}, show() { w.show(); } }; } },
  'b2-hidden-window-view': { desc: '(b) hidden BrowserWindow(show:false) hosting a WebContentsView in its contentView', async make(c) { const w = new BrowserWindow({ show: false, width: 800, height: 600 }); keep.push(w); const v = c.mkView(); keep.push(v); w.contentView.addChildView(v); v.setBounds({ x: 0, y: 0, width: 800, height: 600 }); await v.webContents.loadURL(PAGE_URL); return { wc: v.webContents, visibleAtStart: false, hide() {}, show() { w.show(); } }; } },
  'c1-rehost-moved': { desc: '(c) tab painted in main, then the SAME view re-parented into a hidden BrowserWindow', async make(c) { const v = c.mkView(); keep.push(v); c.addFull(v); await v.webContents.loadURL(PAGE_URL); const hw = new BrowserWindow({ show: false, width: 800, height: 600 }); keep.push(hw); return { wc: v.webContents, visibleAtStart: true, hide() { c.main.contentView.removeChildView(v); hw.contentView.addChildView(v); v.setBounds({ x: 0, y: 0, width: 800, height: 600 }); }, show() { hw.contentView.removeChildView(v); c.addFull(v); } }; } },
  'c2-rehost-wrapped': { desc: '(c) tab painted in main, then its webContents wrapped in a NEW WebContentsView inside a hidden BrowserWindow', async make(c) { const v = c.mkView(); keep.push(v); c.addFull(v); await v.webContents.loadURL(PAGE_URL); const hw = new BrowserWindow({ show: false, width: 800, height: 600 }); keep.push(hw); let v2; return { wc: v.webContents, visibleAtStart: true, hide() { c.main.contentView.removeChildView(v); v2 = new WebContentsView({ webContents: v.webContents }); keep.push(v2); hw.contentView.addChildView(v2); v2.setBounds({ x: 0, y: 0, width: 800, height: 600 }); }, show() { hw.contentView.removeChildView(v2); c.main.contentView.addChildView(v2); v2.setBounds(c.fullRect()); } }; } },
  'c3-rehost-basewindow': { desc: '(c) as c1 but the host is a hidden BaseWindow (no own webContents)', async make(c) { const v = c.mkView(); keep.push(v); c.addFull(v); await v.webContents.loadURL(PAGE_URL); const hw = new BaseWindow({ show: false, width: 800, height: 600 }); keep.push(hw); return { wc: v.webContents, visibleAtStart: true, hide() { c.main.contentView.removeChildView(v); hw.contentView.addChildView(v); v.setBounds({ x: 0, y: 0, width: 800, height: 600 }); }, show() { hw.contentView.removeChildView(v); c.addFull(v); } }; } },
  'c4-rehost-browserview': { desc: '(c) tab painted in main, then its webContents adopted by a legacy BrowserView (BrowserView({webContents})) attached to a hidden BrowserWindow', async make(c) { const v = c.mkView(); keep.push(v); c.addFull(v); await v.webContents.loadURL(PAGE_URL); const hw = new BrowserWindow({ show: false, width: 800, height: 600 }); keep.push(hw); let bv; return { wc: v.webContents, visibleAtStart: true, hide() { c.main.contentView.removeChildView(v); bv = new BrowserView({ webContents: v.webContents }); keep.push(bv); hw.setBrowserView(bv); bv.setBounds({ x: 0, y: 0, width: 800, height: 600 }); }, show() { hw.setBrowserView(null); c.addFull(v); } }; } },
  'd1-setvisible-false': { desc: '(d) view composited, then view.setVisible(false) (stays a child of the main window)', async make(c) { const v = c.mkView(); keep.push(v); c.addFull(v); await v.webContents.loadURL(PAGE_URL); return { wc: v.webContents, visibleAtStart: true, hide() { v.setVisible(false); }, show() { v.setVisible(true); } }; } },
  'd2-setvisible-false-first': { desc: '(d) view setVisible(false) BEFORE it ever paints (tab opened in the background)', async make(c) { const v = c.mkView(); keep.push(v); v.setVisible(false); c.addFull(v); await v.webContents.loadURL(PAGE_URL); return { wc: v.webContents, visibleAtStart: false, hide() {}, show() { v.setVisible(true); } }; } },
  'd3-setvisible-false-bt-on-demand': { desc: '(d) setVisible(false) with throttling ON while idle; wc.setBackgroundThrottling(false) only when the agent acts', async make(c) { const v = c.mkView(); keep.push(v); c.addFull(v); await v.webContents.loadURL(PAGE_URL); return { wc: v.webContents, visibleAtStart: true, hide() { v.setVisible(false); }, prepare() { v.webContents.setBackgroundThrottling(false); }, show() { v.setVisible(true); } }; } },
  'f1-clipped-bounds': { desc: 'INFO view stays visible but its bounds lie outside the window content area', async make(c) { const v = c.mkView(); keep.push(v); c.addFull(v); await v.webContents.loadURL(PAGE_URL); return { wc: v.webContents, visibleAtStart: true, hide() { v.setBounds({ x: -5000, y: -5000, width: 800, height: 600 }); }, show() { v.setBounds(c.fullRect()); } }; } },
  'f2-zero-bounds': { desc: 'INFO view stays visible with 1x1 bounds', async make(c) { const v = c.mkView(); keep.push(v); c.addFull(v); await v.webContents.loadURL(PAGE_URL); return { wc: v.webContents, visibleAtStart: true, hide() { v.setBounds({ x: 0, y: 0, width: 1, height: 1 }); }, show() { v.setBounds(c.fullRect()); } }; } },
  'm1-multi-hidden': { desc: 'phase-2 shape: V0 visible (the human\'s tab); V1 (background tab) + V2 (background workspace) setVisible(false)+bt0; V1 is driven — V0/V2 must be undisturbed', async make(c) {
    const v1 = c.mkView(); const v2 = c.mkView(); const v0 = c.mkView(); keep.push(v0, v1, v2);
    for (const v of [v1, v2]) { v.webContents.setBackgroundThrottling(false); c.addFull(v); await v.webContents.loadURL(PAGE_URL); }
    await sleep(1000); // V1/V2 paint while visible (like tabs the human already looked at) ...
    c.addFull(v0); await v0.webContents.loadURL(PAGE_URL); // ... then V0 is composited on top, occluding them until they are hidden
    let n0 = null;
    return { wc: v1.webContents, visibleAtStart: true,
      hide() { v1.setVisible(false); v2.setVisible(false); },
      async neighborsStart() { const r = await js(v0.webContents, 'JSON.stringify(__spike.snap())', 6000); n0 = r.outcome === 'ok' ? JSON.parse(r.v) : null; },
      async neighborsEnd() {
        const r = await js(v0.webContents, 'JSON.stringify(__spike.snap())', 6000); const q = r.outcome === 'ok' ? JSON.parse(r.v) : null;
        const out = { v0: q && n0 ? { rafPerSec: +((q.raf.filter((t) => t >= n0.now).length) / ((q.now - n0.now) / 1000)).toFixed(1), mouseDelta: q.mouse - n0.mouse, inputEvents: q.inputs - n0.inputs, typed: q.value, scrollY: q.scrollY, state: q.state } : null };
        out.v0.capturePage = await capPage(v0.webContents)(); out.v2 = { capturePage: await capPage(v2.webContents)() };
        return out;
      },
      show() { v1.setVisible(true); v2.setVisible(true); } }; } },
  'd4-tiny-first-paint': { desc: '(d) first paint at 2x2 bounds (visible), then setVisible(false) + resize to full — can a NEW background tab get its first surface without showing it?', async make(c) { const v = c.mkView(); keep.push(v); v.setBounds({ x: 0, y: 0, width: 2, height: 2 }); c.main.contentView.addChildView(v); v.setBounds({ x: 0, y: 0, width: 2, height: 2 }); await v.webContents.loadURL(PAGE_URL); await sleep(800); return { wc: v.webContents, visibleAtStart: true, hide() { v.setVisible(false); v.setBounds(c.fullRect()); }, show() { v.setVisible(true); } }; } },
  'd5-resize-while-hidden': { desc: '(d) painted, setVisible(false), THEN the bounds change (window resized while the tab is in the background)', async make(c) { const v = c.mkView(); keep.push(v); c.addFull(v); await v.webContents.loadURL(PAGE_URL); return { wc: v.webContents, visibleAtStart: true, expectSize: { w: 900, h: 500 }, hide() { v.setVisible(false); v.setBounds({ x: 0, y: 0, width: 900, height: 500 }); }, show() { v.setVisible(true); v.setBounds(c.fullRect()); } }; } },
  'g1-occluded-new': { desc: 'NEW tab loaded UNDER an opaque active tab (addChildView(v, 0)); never hidden — does an occluded sibling paint?', async make(c) { const v0 = c.mkView(); keep.push(v0); c.addFull(v0); await v0.webContents.loadURL('data:text/html,' + encodeURIComponent('<body style="margin:0;background:#101010">')); const v = c.mkView(); keep.push(v); c.main.contentView.addChildView(v, 0); v.setBounds(c.fullRect()); await v.webContents.loadURL(PAGE_URL); return { wc: v.webContents, visibleAtStart: false, hide() {}, show() { c.main.contentView.removeChildView(v0); } }; } },
  'g2-occluded-then-hidden': { desc: 'as g1, then the occluded tab gets setVisible(false) — first surface obtained without ever being on top, then driven hidden', async make(c) { const v0 = c.mkView(); keep.push(v0); c.addFull(v0); await v0.webContents.loadURL('data:text/html,' + encodeURIComponent('<body style="margin:0;background:#101010">')); const v = c.mkView(); keep.push(v); c.main.contentView.addChildView(v, 0); v.setBounds(c.fullRect()); await v.webContents.loadURL(PAGE_URL); await sleep(800); return { wc: v.webContents, visibleAtStart: false, hide() { v.setVisible(false); }, show() { v.setVisible(true); c.main.contentView.removeChildView(v0); } }; } },
  'e1-offscreen-window': { desc: '(e) BrowserWindow(show:false, webPreferences.offscreen) — OSR, `paint` events', offscreen: true, async make(c) { const w = new BrowserWindow({ show: false, width: 800, height: 600, webPreferences: c.wp({ offscreen: true }) }); c.osr(w.webContents); keep.push(w); await w.loadURL(PAGE_URL); return { wc: w.webContents, visibleAtStart: false, hide() {}, show() {} }; } },
  'e2-offscreen-view': { desc: '(e) WebContentsView({offscreen}) never attached', offscreen: true, async make(c) { const v = new WebContentsView({ webPreferences: c.wp({ offscreen: true }) }); keep.push(v); v.setBounds({ x: 0, y: 0, width: 800, height: 600 }); c.osr(v.webContents); await v.webContents.loadURL(PAGE_URL); return { wc: v.webContents, visibleAtStart: false, hide() {}, show() {} }; } },
  'x1-showinactive-opacity0': { desc: 'INFO (not product-viable: maps a window in the user\'s compositor) BrowserWindow showInactive + opacity 0', async make(c) { const w = new BrowserWindow({ show: false, width: 800, height: 600, webPreferences: c.wp() }); keep.push(w); await w.loadURL(PAGE_URL); w.setOpacity(0); return { wc: w.webContents, visibleAtStart: false, hide() { w.showInactive(); }, show() { w.setOpacity(1); } }; } },
};
// Arm name = <base>[-bt0][-fs0][+sw][+away][+retry]. +retry = before the oracles, retry capturePage every 300 ms for up to 8 s (does a first 'surface not available' error WARM the surface?). +away = the MAIN window's sway workspace is switched out of view for the whole hidden phase (the human is in another workspace). -fs0 = do NOT skip the CDP fromSurface:false oracle (it SIGSEGVs the OSR window).  -bt0 = webPreferences.backgroundThrottling:false (+ wc.setBackgroundThrottling(false)); +sw = SPIKE_SWITCHES set (informational).
function parseArm(name) {
  const m = /^(.*?)(-bt0)?(-fs0)?(\+sw)?(\+away)?(\+retry)?$/.exec(name); const base = BASES[m[1]];
  return base ? { base, name, bt: !m[2], sw: !!m[4], away: !!m[5], retry: !!m[6] } : null;
}

const results = { arm: ARM, electron: process.versions.electron, chrome: process.versions.chrome, wayland: process.env.WAYLAND_DISPLAY, switches: SWITCHES, order: ORDER, window_s: WIN_S };
const watchdog = setTimeout(() => { results.error = 'watchdog 150s'; console.log('SPIKE_RESULT ' + JSON.stringify(results)); process.exit(3); }, 150000);

app.whenReady().then(async () => {
  const spec = parseArm(ARM);
  if (!spec) throw new Error('unknown arm ' + ARM);
  results.desc = spec.base.desc; results.bt = spec.bt;
  const main = new BrowserWindow({ width: 1000, height: 700, frame: false, show: true, backgroundColor: HEX(BLANK) });
  await main.loadURL('data:text/html,' + encodeURIComponent(`<body style="margin:0;background:${HEX(BLANK)}">`));
  await sleep(1500); // sway maps + sizes the window
  const fullRect = () => { const b = main.getContentBounds(); return { x: 0, y: 0, width: b.width, height: b.height }; };
  const c = {
    main, bt: spec.bt, fullRect,
    wp: (extra = {}) => ({ nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: spec.bt, ...extra }),
    mkView: () => { const v = new WebContentsView({ webPreferences: { partition: 'spike-' + ARM, nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: spec.bt } }); v.setBackgroundColor(HEX(BLANK)); return v; },
    addFull: (v) => { main.contentView.addChildView(v); v.setBounds(fullRect()); },
    osr: () => {},
  };
  if (!spec.bt) { const mk = c.mkView; c.mkView = () => { const v = mk(); v.webContents.setBackgroundThrottling(false); return v; }; }
  const paints = []; // OSR paint events: { t, kind } ; we analyse the last bitmap only
  let lastPaint = null;
  c.osr = (wc) => { wc.on('paint', (_e, _dirty, image) => { paints.push(Date.now()); lastPaint = image; }); };

  let h;
  try { h = await spec.base.make(c); } catch (e) { results.makeError = String(e && e.message || e); results.error = 'make: ' + (e && e.stack || e); console.log('SPIKE_RESULT ' + JSON.stringify(results)); process.exit(0); }
  const wc = h.wc;
  if (!spec.bt) wc.setBackgroundThrottling(false);
  await sleep(1500);
  results.errors = []; step('made');
  const note = (where, r) => { if (r && r.outcome !== 'ok') results.errors.push(where + ': ' + (r.outcome === 'error' ? r.msg : r.outcome)); return r; };

  // ---- pre-hide positive control (arms that start composited) --------------------------------------
  if (h.visibleAtStart) {
    results.pre = { capturePage: await capPage(wc)(), grim: grimOutput('pre-hide'), sway_windows: swayWindows() };
  }
  const sway = (...a) => execFileSync('swaymsg', a, { encoding: 'utf8', timeout: 8000 });
  let awayFrom = null;
  if (spec.away) {
    try { awayFrom = JSON.parse(sway('-t', 'get_workspaces')).find((w) => w.focused).name; sway('workspace', 'spike-away'); results.away = { from: awayFrom, sway_windows_while_away: null }; } catch (e) { results.away = { error: String(e.message).slice(0, 160) }; }
    await sleep(500);
  }
  // ---- hide + flip the colour so a STALE surface is distinguishable from a fresh frame ----------------
  let sampling = false; const leakSamples = [];
  if (LEAK) { sampling = true; (async () => { while (sampling) { const t0s = Date.now(); const v = await grimAsync(); if (v !== null) leakSamples.push([t0s, +v.toFixed(4)]); await sleep(60); } })(); }
  const tHide = Date.now();
  try { h.hide(); } catch (e) { results.hideError = String(e && e.message || e); }
  const tHideDone = Date.now();
  await sleep(600);
  if (MUTANT !== 'noflip') note('setBg', await js(wc, `__spike.setBg(${JSON.stringify(HEX(B))})`));
  results.hide_ms_before_window = Date.now() - tHide;

  // ---- phase 1: NO instrument attached; in-page counters only (rAF / timers / visibility) -------------
  step('p1');
  const m0 = note('mark', await js(wc, '__spike.now()'));
  const t1 = m0.outcome === 'ok' ? m0.v : null;
  await sleep(WIN_S * 1000);
  const snap = note('snap', await js(wc, 'JSON.stringify(__spike.snap())', 8000));
  if (snap.outcome === 'ok' && t1 !== null) {
    const s = JSON.parse(snap.v);
    const per = (arr) => Array.from({ length: WIN_S }, (_, k) => arr.filter((t) => t >= t1 + k * 1000 && t < t1 + (k + 1) * 1000).length);
    results.phase1 = { rafPerSec: per(s.raf), timerPerSec: per(s.timer), visibilityState: s.state, hidden: s.hidden, visEvents: s.vis.length, pageSpanMs: Math.round(s.now - t1) };
  } else results.phase1 = { unreadable: true, mark: m0, snap: snap.outcome === 'ok' ? 'ok' : snap };
  try { results.grim_hidden = grimOutput('hidden'); } catch (e) { results.grim_hidden = { error: String(e.message).slice(0, 120) }; }
  results.sway_windows_hidden = swayWindows();
  results.isPainting = (() => { try { return wc.isPainting(); } catch (e) { return 'err'; } })();

  try { if (h.prepare) h.prepare(); if (h.neighborsStart) await h.neighborsStart(); } catch (e) { results.prepareError = String(e && e.message || e); }
  // ---- phase 2: frame instruments (screencast / frame subscription / paint events), 4 s ------------
  let screencast = 0, frameSub = 0; const p2 = { errors: [] };
  const paintsBefore = paints.length;
  step('p2-debugger-attach');
  try { // the debugger is ALWAYS attached (phase 3 CDP oracles + input need it); only the screencast itself is skippable
    wc.debugger.attach('1.3');
    wc.debugger.on('message', (_e, method, params) => { if (method === 'Page.screencastFrame') { screencast++; wc.debugger.sendCommand('Page.screencastFrameAck', { sessionId: params.sessionId }).catch(() => {}); } });
    note('Page.enable', await bounded('Page.enable', wc.debugger.sendCommand('Page.enable'), 4000));
    if (!skip('screencast')) note('startScreencast', await bounded('startScreencast', wc.debugger.sendCommand('Page.startScreencast', { format: 'jpeg', quality: 40, maxWidth: 320, maxHeight: 240, everyNthFrame: 1 }), 4000));
  } catch (e) { p2.errors.push('debugger: ' + e.message); }
  step('p2-framesub');
  if (!skip('framesub')) try { wc.beginFrameSubscription(false, () => { frameSub++; }); } catch (e) { p2.errors.push('beginFrameSubscription: ' + e.message); }
  const m2 = await js(wc, '__spike.now()');
  await sleep(P2_MS / 2);
  try { results.grim_during_capture = grimOutput('during-capture'); } catch (e) { results.grim_during_capture = { error: String(e.message).slice(0, 120) }; }
  await sleep(P2_MS / 2);
  const s2 = await js(wc, 'JSON.stringify(__spike.snap())', 8000);
  if (s2.outcome === 'ok' && m2.outcome === 'ok') { const s = JSON.parse(s2.v); const n = (arr) => arr.filter((t) => t >= m2.v).length; p2.raf = n(s.raf); p2.timer = n(s.timer); p2.visibilityState = s.state; }
  p2.screencastFrames = screencast; p2.frameSubscriptionCallbacks = frameSub; p2.paintEvents = paints.length - paintsBefore;
  results.phase2 = p2;
  if (!skip('screencast')) { try { await wc.debugger.sendCommand('Page.stopScreencast'); } catch (e) { /* hung/absent: data above */ } }
  try { wc.endFrameSubscription(); } catch (e) { /* none */ }

  if (spec.retry) { // phase 3a: time-to-first-fresh with retries (the app could retry a capture instead of failing)
    const t0r = Date.now(); const outs = [], outsB = []; let firstFresh = null, firstFreshB = null;
    while (Date.now() - t0r < 8000) {
      const r = await capPage(wc, false)(); const k = r.outcome === 'ok' ? r.kind : r.outcome; outs.push(k); if (k === 'fresh' && firstFresh === null) firstFresh = Date.now() - t0r;
      const b = await cdp(wc, { captureBeyondViewport: true })(); const kb = b.outcome === 'ok' ? b.kind : b.outcome; outsB.push(kb); if (kb === 'fresh' && firstFreshB === null) firstFreshB = Date.now() - t0r;
      if (firstFresh !== null && firstFreshB !== null) break;
      if (firstFresh !== null || firstFreshB !== null) { if (Date.now() - t0r > 3000) break; }
      await sleep(300);
    }
    results.retry = { attempts: outs.length, firstFreshMs: firstFresh, outcomes: outs.slice(0, 12), beyondFirstFreshMs: firstFreshB, beyondOutcomes: outsB.slice(0, 12) };
  }
  // ---- phase 3: active captures (order alternated by the harness: fwd / rev) --------------------------
  const oracles = [
    ['capturePage', capPage(wc, false)],
    ['cdpScreenshot', cdp(wc, {})],
    ['cdpScreenshot_fromSurfaceFalse', cdp(wc, { fromSurface: false })],
    ['cdpScreenshot_captureBeyondViewport', cdp(wc, { captureBeyondViewport: true })],
    ['invalidate_then_capturePage', capPage(wc, true)],
  ];
  if (ORDER === 'rev') oracles.reverse();
  results.captures = {};
  for (const [name, fn] of oracles) { if (skip('cap:' + name)) { results.captures[name] = { outcome: 'skipped' }; continue; } step('cap:' + name); results.captures[name] = await fn(); }
  if (spec.base.offscreen && lastPaint) { try { results.captures.lastPaintBitmap = { outcome: 'ok', ...analyze(lastPaint) }; } catch (e) { results.captures.lastPaintBitmap = { outcome: 'error', msg: e.message }; } }

  try { results.grim_after_captures = grimOutput('after-captures'); } catch (e) { results.grim_after_captures = { error: String(e.message).slice(0, 120) }; }
  // ---- phase 3b: the app's OWN input calls (clickAt / typeText / scrollBy) on the hidden object ----------
  const counters = async () => { const r = await js(wc, 'JSON.stringify(__spike.snap())', 6000); if (r.outcome !== 'ok') return null; const q = JSON.parse(r.v); return { mouse: q.mouse, inputs: q.inputs, value: q.value, scrollY: q.scrollY }; };
  step('p3b-input');
  const c0 = await counters();
  const send = (label, method, params) => bounded(label, wc.debugger.sendCommand(method, params), 3000).then((r) => r.outcome);
  const click = [await send('mp', 'Input.dispatchMouseEvent', { type: 'mousePressed', x: 320, y: 315, button: 'left', clickCount: 1 }), await send('mr', 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: 320, y: 315, button: 'left', clickCount: 1 })];
  const type = [await send('ins', 'Input.insertText', { text: 'hello' })];
  const wheel = [await send('wheel', 'Input.dispatchMouseEvent', { type: 'mouseWheel', x: 100, y: 100, deltaX: 0, deltaY: 400 })];
  await sleep(700);
  const c1 = await counters();
  results.input = { dispatch: { click, type, wheel }, deliveredWhileHidden: c0 && c1 ? { mouse: c1.mouse - c0.mouse, typed: c1.value, inputEvents: c1.inputs - c0.inputs, scrollY: c1.scrollY - c0.scrollY } : null };

  if (h.neighborsEnd) { try { results.neighbors = await h.neighborsEnd(); } catch (e) { results.neighbors = { error: String(e.message || e) }; } }
  if (spec.away && awayFrom) { try { sway('workspace', awayFrom); } catch (e) { results.away.backError = String(e.message).slice(0, 120); } await sleep(500); }
  if (LEAK) { sampling = false; await sleep(400); const post = leakSamples.filter(([t]) => t >= tHideDone + 250).map(([, v]) => v); const pre = leakSamples.filter(([t]) => t < tHideDone + 250).map(([, v]) => v); results.leak_sampler = { samples: leakSamples.length, preHideOrSettling: pre.length, preMaxAB: pre.length ? Math.max(...pre) : null, postHide: post.length, maxAB: post.length ? Math.max(...post) : null, over1pct: post.filter((x) => x > 0.01).length }; }
  step('showback');
  // ---- show-back control on the SAME object: the page must be alive and readable --------------------
  try { h.show(); } catch (e) { results.showError = String(e && e.message || e); }
  await sleep(1800);
  if (h.expectSize) results.expectSize = h.expectSize;
  results.postShow = { capturePage: await capPage(wc)() };
  try { results.postShow.grim = grimOutput('post-show'); } catch (e) { results.postShow.grim = { error: String(e.message).slice(0, 120) }; }
  { const c2 = await counters(); if (c0 && c2) results.input.deliveredByAfterShow = { mouse: c2.mouse - c0.mouse, typed: c2.value, inputEvents: c2.inputs - c0.inputs, scrollY: c2.scrollY - c0.scrollY }; }
  results.late = late.slice();
  const okPost = results.postShow.capturePage.outcome === 'ok' && results.postShow.capturePage.kind === 'fresh';
  const okPre = !h.visibleAtStart || (results.pre.capturePage.outcome === 'ok' && results.pre.capturePage.A >= 0.5);
  const alive = !!(results.phase1 && results.phase1.timerPerSec && results.phase1.timerPerSec.some((n) => n > 0));
  results.valid = spec.base.offscreen ? alive : (okPost && okPre);
  clearTimeout(watchdog);
  console.log('SPIKE_RESULT ' + JSON.stringify(results));
  app.exit(0);
}).catch((e) => { results.error = String(e && e.stack || e); console.log('SPIKE_RESULT ' + JSON.stringify(results)); app.exit(0); });
