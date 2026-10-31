// Electron MAIN-process probe for the tabs registry (#391): runs the REAL bundled
// browser-panel.ts over REAL WebContentsViews in a BaseWindow, and reads the
// composited window back with grim. Launched by scripts/e2e-browser-tabs-registry.mjs
// inside the contained rig (own headless sway, scratch HOME). Prints PROBE_RESULT <json>.
const { app, BaseWindow, View, WebContentsView } = require('electron');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const OUT = process.env.PROBE_OUT;
const BUNDLE = process.env.BP_BUNDLE;
app.setPath('userData', path.join(OUT, 'userData'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const COLORS = { red: [220, 30, 30], green: [20, 200, 80], blue: [40, 90, 240], bg: [26, 31, 38] };

const { decodePng, share } = require('./e2e-browser-tabs-png.cjs');

// #406: an inactive tab stays attached + hidden, so "children" no longer means "composited". Electron 33 has no View.getVisible(): record every setVisible (same notion as `attached` in verify-browser-panel-dead-view.mjs).
const origSetVisible = View.prototype.setVisible;
View.prototype.setVisible = function (v) { this.__visible = !!v; return origSetVisible.call(this, v); };

const results = [];
const clause = (name, ok, detail) => { results.push({ name, ok: !!ok, detail }); };

app.whenReady().then(async () => {
  const srv = http.createServer((req, res) => {
    const c = COLORS[req.url.slice(1)] ?? COLORS.bg;
    res.setHeader('content-type', 'text/html');
    res.end(`<!doctype html><title>${req.url.slice(1)} page</title><body style="margin:0;background:rgb(${c.join(',')})"><h1 style="color:rgb(${c.join(',')})">${req.url}</h1>`);
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;

  const win = new BaseWindow({ width: 1000, height: 700, frame: false, show: true, backgroundColor: '#1a1f26' });
  const bp = require(BUNDLE);
  bp.initBrowserPanels(() => win);
  // #398: the registry holds no debugger of its own — its CDP commands ride the proxy host's seat (browser-cdp-host.ts, Electron + the proxy).
  // The probe bundles browser-panel.ts ALONE, so it stands in with a minimal seat over the REAL webContents.debugger (attach on first use) and the
  // teardown hook the host installs (detach before the contents close), keeping the "destroyPanel detaches every tab's debugger" clause honest.
  bp.setCdpSeat({
    async send(ws, tabId, method, params) { const wc = bp.tabContents(ws, tabId); if (!wc) throw new Error('no live view'); if (!wc.debugger.isAttached()) wc.debugger.attach('1.3'); return wc.debugger.sendCommand(method, params ?? {}); },
    async hold() { return () => undefined; },
  });
  bp.setTabTeardownHook((wc) => { try { if (wc.debugger.isAttached()) wc.debugger.detach(); } catch { /* already detached */ } });
  await sleep(1200); // let sway map + size the window
  const RECT = { x: 200, y: 150, width: 600, height: 400 };
  const INNER = { x: 260, y: 210, width: 480, height: 280 }; // well inside RECT: tolerant of any CSD offset
  const OUTSIDE = { x: 10, y: 10, width: 60, height: 60 };
  const kids = () => { const all = win.contentView.children; return { vis: all.filter((v) => v.__visible !== false).length, total: all.length }; };
  const kd = (k) => `visible=${k.vis} total=${k.total}`;
  { // ctl: the hook reaches a real WebContentsView (a throwaway, never added to the window) and reads both states back
    const hv = new WebContentsView(); const a = hv.__visible; hv.setVisible(false); const b = hv.__visible; hv.setVisible(true); const c = hv.__visible; hv.webContents.close();
    clause('ctl/visibility-hook', a === undefined && b === false && c === true, `fresh=${a} after setVisible(false)=${b} after setVisible(true)=${c}`);
  }
  const shot = async (label) => {
    await sleep(500); // composite settle
    const f = path.join(OUT, `${label}.png`);
    execFileSync('grim', ['-o', 'HEADLESS-1', f], { env: { PATH: process.env.PATH, WAYLAND_DISPLAY: process.env.WAYLAND_DISPLAY, XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR } });
    return { file: f, I: decodePng(fs.readFileSync(f)) };
  };
  const dominant = (I, rect) => Object.keys(COLORS).find((k) => share(I, rect, COLORS[k]) > 0.9) ?? 'none';
  const loaded = async (tab, url) => { await tab.view.webContents.loadURL(url); await sleep(150); };

  // t1 (human, initial) -> red; shown + positioned like the renderer does.
  bp.showPanel('wsP');
  bp.setBounds('wsP', RECT);
  const t1 = bp.getActiveTab('wsP');
  await loaded(t1, `${base}/red`);
  let s = await shot('1-t1-red');
  let k = kids();
  clause('t1 composites (1 tab): inner region is red, 1 visible child view', dominant(s.I, INNER) === 'red' && k.vis === 1, `dominant=${dominant(s.I, INNER)} ${kd(k)} shot=${s.file}`);
  clause('outside the pane stays the window background', dominant(s.I, OUTSIDE) === 'bg', `dominant=${dominant(s.I, OUTSIDE)}`);

  // t2 (agent) -> green, NOT activated: the window must not change.
  const t2 = bp.createTab('wsP', { openedBy: 'agent' });
  await loaded(t2, `${base}/green`);
  s = await shot('2-t2-created-inactive');
  k = kids();
  clause('a created-but-inactive tab never composits (still red, still 1 visible child)', dominant(s.I, INNER) === 'red' && k.vis === 1, `dominant=${dominant(s.I, INNER)} ${kd(k)}`);

  // activate t2 -> green, exactly one VISIBLE child (the old tab may stay attached, hidden).
  bp.activateTab('wsP', t2.id);
  s = await shot('3-t2-active');
  k = kids();
  clause('activateTab swaps the composited view (green) with exactly 1 visible child', dominant(s.I, INNER) === 'green' && k.vis === 1, `dominant=${dominant(s.I, INNER)} ${kd(k)}`);
  clause('the swapped-in tab is sized to the panel rect (inner region fully covered)', share(s.I, INNER, COLORS.green) > 0.99, `green share=${share(s.I, INNER, COLORS.green).toFixed(3)}`);

  // t3 (human) -> blue activated, then closed: neighbour promoted, window follows.
  const t3 = bp.createTab('wsP', { openedBy: 'human', activate: true });
  await loaded(t3, `${base}/blue`);
  s = await shot('4-t3-blue');
  k = kids();
  clause('createTab({activate}) composites the new tab (blue), 1 visible child', dominant(s.I, INNER) === 'blue' && k.vis === 1, `dominant=${dominant(s.I, INNER)} ${kd(k)}`);
  const t3wc = t3.view; // keep the view ref: real Electron nulls view.webContents on close
  bp.closeTab('wsP', t3.id);
  s = await shot('5-t3-closed');
  k = kids();
  clause('closeTab(active) promotes the neighbour (t2 green) and detaches the closed view (1 visible child)', dominant(s.I, INNER) === 'green' && k.vis === 1 && bp.getActiveTab('wsP').id === t2.id, `dominant=${dominant(s.I, INNER)} ${kd(k)} active=${bp.getActiveTab('wsP').id}`);
  clause('closed tab contents really destroyed (real Electron: view.webContents === undefined)', typeof t3wc.webContents === 'undefined', `typeof webContents=${typeof t3wc.webContents}`);

  // external death of a BACKGROUND tab (t1): reaped, active/window untouched.
  const t1view = t1.view;
  t1view.webContents.close();
  // Real Electron closes ASYNCHRONOUSLY (webContents.close() runs unload handlers first): wait for the death.
  for (let i = 0; i < 40 && typeof t1view.webContents !== 'undefined'; i++) await sleep(100);
  const ids = bp.listTabs('wsP').map((t) => t.id).join(',');
  s = await shot('6-t1-died');
  k = kids();
  clause('a dead background tab is reaped; active tab + window untouched (1 visible child)', ids === t2.id && dominant(s.I, INNER) === 'green' && k.vis === 1, `tabs=${ids} dominant=${dominant(s.I, INNER)} ${kd(k)}`);

  // teardown iterates EVERY tab: rebuild 3 live tabs, then destroyPanel.
  const u1 = bp.createTab('wsP', { openedBy: 'agent' });
  const u2 = bp.createTab('wsP', { openedBy: 'human' });
  await bp.evaluate('wsP', '1'); // attaches the debugger on the active tab (t2) so detach is exercised
  const views = [t2, u1, u2].map((t) => t.view);
  clause('setup: 3 live tabs before destroy', bp.listTabs('wsP').length === 3 && views.every((v) => typeof v.webContents !== 'undefined'), `tabs=${bp.listTabs('wsP').map((t) => t.id)}`);
  bp.destroyPanel('wsP');
  s = await shot('7-destroyed');
  const dead = views.map((v) => typeof v.webContents === 'undefined');
  clause('destroyPanel closes EVERY tab (no leaked native view) and detaches the window', dead.every(Boolean) && kids().total === 0 && dominant(s.I, INNER) === 'bg', `dead=${dead} ${kd(kids())} dominant=${dominant(s.I, INNER)}`);
  clause('panel registry empty after destroy', bp.getPanel('wsP') === undefined && bp.listTabs('wsP').length === 0, `getPanel=${bp.getPanel('wsP')}`);

  console.log('PROBE_RESULT ' + JSON.stringify({ results, electron: process.versions.electron, wayland: process.env.WAYLAND_DISPLAY }));
  srv.close(); app.exit(0);
}).catch((e) => { console.log('PROBE_RESULT ' + JSON.stringify({ error: String(e && e.stack || e), results })); app.exit(1); });
