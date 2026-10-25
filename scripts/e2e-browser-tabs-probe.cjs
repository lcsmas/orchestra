// Electron MAIN-process probe for the tabs registry (#391): runs the REAL bundled
// browser-panel.ts over REAL WebContentsViews in a BaseWindow, and reads the
// composited window back with grim. Launched by scripts/e2e-browser-tabs-registry.mjs
// inside the contained rig (own headless sway, scratch HOME). Prints PROBE_RESULT <json>.
const { app, BaseWindow } = require('electron');
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
  await sleep(1200); // let sway map + size the window
  const RECT = { x: 200, y: 150, width: 600, height: 400 };
  const INNER = { x: 260, y: 210, width: 480, height: 280 }; // well inside RECT: tolerant of any CSD offset
  const OUTSIDE = { x: 10, y: 10, width: 60, height: 60 };
  const children = () => win.contentView.children.length;
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
  clause('t1 composites (1 tab): inner region is red, 1 child view', dominant(s.I, INNER) === 'red' && children() === 1, `dominant=${dominant(s.I, INNER)} children=${children()} shot=${s.file}`);
  clause('outside the pane stays the window background', dominant(s.I, OUTSIDE) === 'bg', `dominant=${dominant(s.I, OUTSIDE)}`);

  // t2 (agent) -> green, NOT activated: the window must not change.
  const t2 = bp.createTab('wsP', { openedBy: 'agent' });
  await loaded(t2, `${base}/green`);
  s = await shot('2-t2-created-inactive');
  clause('a created-but-inactive tab never composits (still red, still 1 child)', dominant(s.I, INNER) === 'red' && children() === 1, `dominant=${dominant(s.I, INNER)} children=${children()}`);

  // activate t2 -> green, still exactly one child.
  bp.activateTab('wsP', t2.id);
  s = await shot('3-t2-active');
  clause('activateTab swaps the composited view (green) with exactly 1 child', dominant(s.I, INNER) === 'green' && children() === 1, `dominant=${dominant(s.I, INNER)} children=${children()}`);
  clause('the swapped-in tab is sized to the panel rect (inner region fully covered)', share(s.I, INNER, COLORS.green) > 0.99, `green share=${share(s.I, INNER, COLORS.green).toFixed(3)}`);

  // t3 (human) -> blue activated, then closed: neighbour promoted, window follows.
  const t3 = bp.createTab('wsP', { openedBy: 'human', activate: true });
  await loaded(t3, `${base}/blue`);
  s = await shot('4-t3-blue');
  clause('createTab({activate}) composites the new tab (blue), 1 child', dominant(s.I, INNER) === 'blue' && children() === 1, `dominant=${dominant(s.I, INNER)} children=${children()}`);
  const t3wc = t3.view; // keep the view ref: real Electron nulls view.webContents on close
  bp.closeTab('wsP', t3.id);
  s = await shot('5-t3-closed');
  clause('closeTab(active) promotes the neighbour (t2 green) and detaches the closed view', dominant(s.I, INNER) === 'green' && children() === 1 && bp.getActiveTab('wsP').id === t2.id, `dominant=${dominant(s.I, INNER)} children=${children()} active=${bp.getActiveTab('wsP').id}`);
  clause('closed tab contents really destroyed (real Electron: view.webContents === undefined)', typeof t3wc.webContents === 'undefined', `typeof webContents=${typeof t3wc.webContents}`);

  // external death of a BACKGROUND tab (t1): reaped, active/window untouched.
  const t1view = t1.view;
  t1view.webContents.close();
  // Real Electron closes ASYNCHRONOUSLY (webContents.close() runs unload handlers first): wait for the death.
  for (let i = 0; i < 40 && typeof t1view.webContents !== 'undefined'; i++) await sleep(100);
  const ids = bp.listTabs('wsP').map((t) => t.id).join(',');
  s = await shot('6-t1-died');
  clause('a dead background tab is reaped; active tab + window untouched', ids === t2.id && dominant(s.I, INNER) === 'green' && children() === 1, `tabs=${ids} dominant=${dominant(s.I, INNER)} children=${children()}`);

  // teardown iterates EVERY tab: rebuild 3 live tabs, then destroyPanel.
  const u1 = bp.createTab('wsP', { openedBy: 'agent' });
  const u2 = bp.createTab('wsP', { openedBy: 'human' });
  await bp.evaluate('wsP', '1'); // attaches the debugger on the active tab (t2) so detach is exercised
  const views = [t2, u1, u2].map((t) => t.view);
  clause('setup: 3 live tabs before destroy', bp.listTabs('wsP').length === 3 && views.every((v) => typeof v.webContents !== 'undefined'), `tabs=${bp.listTabs('wsP').map((t) => t.id)}`);
  bp.destroyPanel('wsP');
  s = await shot('7-destroyed');
  const dead = views.map((v) => typeof v.webContents === 'undefined');
  clause('destroyPanel closes EVERY tab (no leaked native view) and detaches the window', dead.every(Boolean) && children() === 0 && dominant(s.I, INNER) === 'bg', `dead=${dead} children=${children()} dominant=${dominant(s.I, INNER)}`);
  clause('panel registry empty after destroy', bp.getPanel('wsP') === undefined && bp.listTabs('wsP').length === 0, `getPanel=${bp.getPanel('wsP')}`);

  console.log('PROBE_RESULT ' + JSON.stringify({ results, electron: process.versions.electron, wayland: process.env.WAYLAND_DISPLAY }));
  srv.close(); app.exit(0);
}).catch((e) => { console.log('PROBE_RESULT ' + JSON.stringify({ error: String(e && e.stack || e), results })); app.exit(1); });
