// PROTOTYPE — throwaway. Probes for the Bloc HTML design (grilling 2026-11-10).
// Run: pnpm run proto:bloc-html:probes   (bare Electron, ozone headless, scratch dirs — never the Orchestra app)
// Answers: (P1) is a sandboxed srcdoc frame cut off from the app + the network on the desktop (file:// parent)?
//          (P2) what renders under the phone page's real CSP — srcdoc static / srcdoc scripts / a dedicated route?
//          (P3) does an infinite loop inside a Bloc HTML freeze the window that hosts it?
const { app, BrowserWindow } = require('electron');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const SCRATCH = (process.argv.find((a) => a.startsWith('--scratch=')) || '').slice('--scratch='.length);
if (!SCRATCH || !/\/bloc-html-probes\.[A-Za-z0-9]+$/.test(SCRATCH)) { console.error('PROBE_SCRATCH must be the scratch dir run.sh made'); process.exit(2); }
app.setPath('userData', path.join(SCRATCH, 'ud'));
app.disableHardwareAcceleration();
app.on('window-all-closed', () => {}); // each arm destroys its window — the default would quit the app mid-probe

// Copied verbatim from src/acces-mobile/server.ts:75.
const MOBILE_CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";
// The candidate policy of the dedicated route (Q6 b).
const BLOC_CSP = "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; frame-ancestors 'self'; base-uri 'none'; form-action 'none'";
// The candidate policy written INSIDE a desktop srcdoc frame (Q5).
const META_CSP = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:">`;

const hits = { evil: [], secret: [] };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const withTimeout = (p, ms) => Promise.race([p.then((v) => ({ ok: true, v }), (e) => ({ ok: false, err: String(e) })), sleep(ms).then(() => ({ ok: false, timeout: true }))]);
const listen = (handler) => new Promise((res) => { const s = http.createServer(handler); s.listen(0, '127.0.0.1', () => res({ s, port: s.address().port })); });

/** What a Bloc HTML's own script can reach. `tag` names the arm in the leak counters. */
const blocScript = (evil, tag) => `<script>
window.__ran = true;
const r = { origin: self.origin };
try { r.cookie = 'readable:' + document.cookie } catch (e) { r.cookie = 'ERR ' + e.name }
try { localStorage.setItem('x', '1'); r.localStorage = 'writable' } catch (e) { r.localStorage = 'ERR ' + e.name }
try { r.parentDoc = 'readable:' + parent.document.title } catch (e) { r.parentDoc = 'ERR ' + e.name }
try { r.parentApi = typeof parent.api } catch (e) { r.parentApi = 'ERR ' + e.name }
r.ownApi = typeof window.api; r.ownRequire = typeof window.require;
fetch('${evil}/fetch-${tag}').then((x) => { r.fetchEvil = 'status ' + x.status }, (e) => { r.fetchEvil = 'ERR ' + e.name });
fetch('/api/secret?from=${tag}').then((x) => { r.fetchSecret = 'status ' + x.status }, (e) => { r.fetchSecret = 'ERR ' + e.name });
new Image().src = '${evil}/img-${tag}';
window.__r = r;
</script>`;
const blocDoc = (evil, tag, csp) => `<!doctype html><html><head>${csp}<style>body{color:rgb(1,2,3);margin:0}</style></head><body><p id="p">bloc ${tag}</p>${blocScript(evil, tag)}</body></html>`;
const attr = (s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
const frameNamed = (win, name) => win.webContents.mainFrame.frames.find((f) => f.name === name);
const readFrame = async (win, name) => {
  const f = frameNamed(win, name);
  if (!f) return { missing: true };
  const r = await withTimeout(f.executeJavaScript('JSON.stringify({ ran: !!window.__ran, r: window.__r || null, color: getComputedStyle(document.body).color, text: (document.getElementById("p") || {}).textContent || null, url: location.href })'), 3000);
  return r.ok ? { processId: f.processId, ...JSON.parse(r.v) } : { processId: f.processId, execFailed: r };
};
const loadFailures = [];
const newWin = (preload) => { const w = new BrowserWindow({ show: false, width: 900, height: 700, webPreferences: { contextIsolation: true, nodeIntegration: false, ...(preload ? { preload } : {}) } }); w.webContents.on('did-fail-load', (_e, code, desc, url, isMain) => loadFailures.push({ code, desc, url, isMain })); return w; };
/** loadURL rejects when ANY frame navigation fails in some shapes — a probe must keep going and record it. */
const load = async (label, p) => { try { await p; } catch (e) { loadFailures.push({ label, rejected: String(e).slice(0, 160) }); } };

async function main() {
  const out = {};
  const evil = await listen((req, res) => { hits.evil.push(req.url); res.writeHead(200, { 'content-type': 'text/plain', 'access-control-allow-origin': '*' }); res.end('evil'); });
  const EVIL = `http://127.0.0.1:${evil.port}`;
  let MOBILE = '';
  const mobile = await listen((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/api/secret') { hits.secret.push(req.url); res.writeHead(200, { 'content-type': 'text/plain' }); return res.end('SECRET'); }
    if (u.pathname === '/parent.js') { res.writeHead(200, { 'content-type': 'text/javascript' }); return res.end('window.__parentRan = true; setInterval(() => { window.__beat = (window.__beat || 0) + 1 }, 50);'); }
    if (u.pathname === '/bloc/ok') { res.writeHead(200, { 'content-type': 'text/html', 'content-security-policy': BLOC_CSP }); return res.end(blocDoc(EVIL, 'route', '')); }
    if (u.pathname === '/bloc/loop') { res.writeHead(200, { 'content-type': 'text/html', 'content-security-policy': BLOC_CSP }); return res.end('<!doctype html><body>loop<script>setTimeout(() => { for (;;) {} }, 600)</script></body>'); }
    if (u.pathname === '/shell') {
      // The phone page as it is today: the real CSP, a same-origin script, and the three candidate frames.
      res.writeHead(200, { 'content-type': 'text/html', 'content-security-policy': MOBILE_CSP });
      return res.end(`<!doctype html><html><head><title>shell</title><script src="/parent.js"></script></head><body>
        <iframe name="static" sandbox="allow-same-origin" srcdoc="${attr(blocDoc(EVIL, 'srcdoc-static', ''))}"></iframe>
        <iframe name="scripted" sandbox="allow-scripts" srcdoc="${attr(blocDoc(EVIL, 'srcdoc-scripted', ''))}"></iframe>
        <iframe name="route" sandbox="allow-scripts" src="/bloc/ok"></iframe>
      </body></html>`);
    }
    if (u.pathname === '/shell-loop') { res.writeHead(200, { 'content-type': 'text/html', 'content-security-policy': MOBILE_CSP }); return res.end('<!doctype html><title>shell</title><script src="/parent.js"></script><iframe name="loop" sandbox="allow-scripts" src="/bloc/loop"></iframe>'); }
    res.writeHead(404); res.end();
  });
  MOBILE = `http://127.0.0.1:${mobile.port}`;

  // ---------- P1: desktop, file:// parent with a preload (the app's shape) ----------
  const preload = path.join(SCRATCH, 'preload.cjs');
  fs.writeFileSync(preload, "const { contextBridge } = require('electron'); contextBridge.exposeInMainWorld('api', { ping: () => 'pong' });");
  const desktop = path.join(SCRATCH, 'desktop.html');
  fs.writeFileSync(desktop, `<!doctype html><html><head><title>desktop-parent</title></head><body>
    <iframe name="iso" sandbox="allow-scripts" srcdoc="${attr(blocDoc(EVIL, 'desktop-iso', META_CSP))}"></iframe>
    <iframe name="nocsp" sandbox="allow-scripts" srcdoc="${attr(blocDoc(EVIL, 'desktop-nocsp', ''))}"></iframe>
  </body></html>`);
  {
    const win = newWin(preload);
    await load('p1', win.loadFile(desktop));
    await sleep(1500);
    const parentApi = await win.webContents.executeJavaScript('typeof window.api');
    out.p1 = { parentProcessId: win.webContents.mainFrame.processId, parentSeesApi: parentApi, iso: await readFrame(win, 'iso'), nocsp: await readFrame(win, 'nocsp') };
    // Navigation as a leak channel: unguarded first, then with the main-process guard.
    await withTimeout(frameNamed(win, 'iso').executeJavaScript(`location.href = '${EVIL}/nav-unguarded'; 0`), 2000);
    await sleep(800);
    win.webContents.on('will-frame-navigate', (e) => { if (!e.isMainFrame) e.preventDefault(); });
    const f2 = frameNamed(win, 'nocsp');
    if (f2) await withTimeout(f2.executeJavaScript(`location.href = '${EVIL}/nav-guarded'; 0`), 2000);
    await sleep(800);
    win.destroy();
  }

  fs.writeFileSync(path.join(SCRATCH, 'result.json'), JSON.stringify(out, null, 2)); console.log('PROBE_STAGE p1 done');
  // ---------- P2: the phone page under its real CSP ----------
  {
    const win = newWin();
    const consoleLines = [];
    win.webContents.on('console-message', (_e, _lvl, msg) => consoleLines.push(msg.slice(0, 160)));
    await load('p2', win.loadURL(`${MOBILE}/shell`));
    await sleep(1500);
    const parentRan = await win.webContents.executeJavaScript('!!window.__parentRan');
    // The scripts-off frame keeps the parent's origin, so the PARENT can read its height (auto-size without a script inside).
    const staticHeight = await win.webContents.executeJavaScript('(() => { try { return document.querySelector(\'iframe[name="static"]\').contentDocument.documentElement.scrollHeight } catch (e) { return "ERR " + e.name } })()');
    out.p2 = { parentRan, staticHeightReadByParent: staticHeight, static: await readFrame(win, 'static'), scripted: await readFrame(win, 'scripted'), route: await readFrame(win, 'route'), cspConsole: consoleLines.filter((l) => /Content Security Policy|Refused|sandbox/i.test(l)) };
    const rf = frameNamed(win, 'route');
    if (rf) await withTimeout(rf.executeJavaScript(`location.href = '${EVIL}/nav-route'; 0`), 2000);
    await sleep(800);
    out.p2.routeUrlAfterNav = (await readFrame(win, 'route')).url ?? null;
    win.destroy();
  }

  fs.writeFileSync(path.join(SCRATCH, 'result.json'), JSON.stringify(out, null, 2)); console.log('PROBE_STAGE p2 done');
  // ---------- P3: infinite loop inside a frame — does the host window still answer? ----------
  const freezeArm = async (label, load) => {
    const win = newWin();
    await load(win);
    const before = await withTimeout(win.webContents.executeJavaScript('1 + 1'), 3000);
    const parentPid = win.webContents.mainFrame.processId;
    const framePid = win.webContents.mainFrame.frames[0]?.processId;
    await sleep(1500); // the frame's loop starts at 600 ms
    const after = await withTimeout(win.webContents.executeJavaScript('1 + 1'), 3000);
    out.p3[label] = { answeredBeforeLoop: before.ok, answeredDuringLoop: after.ok, parentPid, framePid, sameProcess: parentPid === framePid };
    try { win.webContents.forcefullyCrashRenderer(); } catch {}
    win.destroy();
    await sleep(300);
  };
  out.p3 = {};
  const loopSrcdoc = attr('<!doctype html><body>loop<script>setTimeout(() => { for (;;) {} }, 600)</script></body>');
  const fileArm = (name, sandbox) => async (win) => { const p = path.join(SCRATCH, `${name}.html`); fs.writeFileSync(p, `<!doctype html><title>${name}</title><iframe ${sandbox} srcdoc="${loopSrcdoc}"></iframe>`); await load(name, win.loadFile(p)); };
  await freezeArm('control_sameOrigin_file', fileArm('freeze-same', ''));               // must FREEZE: proves the probe can see a freeze
  await freezeArm('desktop_sandboxedSrcdoc_file', fileArm('freeze-iso', 'sandbox="allow-scripts"'));
  await freezeArm('mobile_route_http', (win) => load('p3-http', win.loadURL(`${MOBILE}/shell-loop`)));

  out.leaks = { evil: hits.evil, secret: hits.secret };
  out.loadFailures = loadFailures;
  out.versions = { electron: process.versions.electron, chrome: process.versions.chrome, ozone: app.commandLine.getSwitchValue('ozone-platform') };
  fs.writeFileSync(path.join(SCRATCH, 'result.json'), JSON.stringify(out, null, 2));
  console.log('PROBE_RESULT ' + JSON.stringify(out));
  evil.s.close(); mobile.s.close();
  app.exit(0);
}

app.whenReady().then(main).catch((e) => { console.error('PROBE_CRASH', e); app.exit(1); });
setTimeout(() => { console.error('PROBE_TIMEOUT'); app.exit(3); }, 90_000);
