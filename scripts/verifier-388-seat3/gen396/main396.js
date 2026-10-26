// ═════════════════════════════════════ seat 3 hostile-page drive for #396 (helpers above are copied from the member's rig; arms + pages + oracles are mine) ═════════════════════════════════════
const J = (x) => JSON.stringify(x);
const info396 = (arm, d) => console.log(`  INFO  [${arm}] ${d}`);
const MY_ARMS = new Set(flag('--arms', 'oauthx,xdg,names,title,resize,storm').split(','));
const before = liveCanary();
// ── my own fixture site: two host names on one server (cross-site = 127.0.0.1 vs localhost), a hostile child, an IdP, redirectors ──
const http = await import('node:http');
const PAGES = {
  '/h-opener.html': () => `<!doctype html><title>H opener</title><body style="margin:0;background:#eee">
<button id="named" style="font-size:30px" onclick="window.open('/h-child.html?w=named','hnamed','width=400,height=300')">named popup</button>
<button id="shared" style="font-size:30px" onclick="window.open('/h-child.html?w=shared','shared','width=400,height=300')">shared name</button>
<button id="bigfeat" style="font-size:30px" onclick="window.open('/h-child.html?w=big','hbig','width=99999,height=99999,left=0,top=0,fullscreen=yes,alwaysOnTop=yes,frame=no,transparent=yes,kiosk=yes')">hostile features</button>
<button id="tinyfeat" style="font-size:30px" onclick="window.open('/h-child.html?w=tiny','htiny','width=10,height=10')">tiny</button>
<button id="idp" style="font-size:30px" onclick="window.open('http://localhost:'+location.port+'/h-idp.html?o='+encodeURIComponent(location.origin),'hidp','width=420,height=520')">sign in (cross-site)</button>
<button id="spoof" style="font-size:30px" onclick="window.open('/h-child.html?w=spoof&spoof=1','hspoof','width=400,height=300')">spoof title</button>
<a id="ssh" href="ssh://evil.example/x">ssh</a> <a id="zoom" href="zoommtg://zoom.us/join?confno=1">zoom</a> <a id="smb" href="smb://evil.example/share">smb</a>
<a id="vscode" href="vscode://file/etc/passwd">vscode</a> <a id="steam" href="steam://run/1">steam</a> <a id="slack" href="slack://open">slack</a> <a id="sms" href="sms:+123">sms</a> <a id="facetime" href="facetime:x@y.z">facetime</a>
<a id="mail" href="mailto:a@b.c">mail</a> <a id="tel" href="tel:+123">tel</a> <a id="blank" href="/h-child.html?w=blank" target="_blank">blank</a>
<button id="loc" onclick="location.href='ssh://evil.example/loc'">location=ssh</button>
<button id="frame" onclick="var f=document.createElement('iframe');f.src='zoommtg://zoom.us/frame';document.body.appendChild(f)">iframe=zoommtg</button>
<button id="form" onclick="document.getElementById('f').submit()">form ssh</button><form id="f" action="ssh://evil.example/form" method="get"></form>
<a id="redir" href="/h-redir?to=ssh://evil.example/redirected">302 to ssh</a>
<button id="armtimer" onclick="setTimeout(function(){location.href='mailto:timer@x.y';},300)">mailto by timer (the click only arms it)</button>
<script>if (location.search.includes('nogesture')) { setTimeout(function(){ location.href = 'mailto:auto-load@x.y'; }, 500); setTimeout(function(){ var a = document.createElement('a'); a.href = 'tel:+999'; document.body.appendChild(a); a.click(); }, 900); setTimeout(function(){ window.open('mailto:auto-open@x.y'); }, 1300); }</script>
<div id="status">idle</div><script>window.addEventListener('message', (e) => { document.getElementById('status').textContent = 'token:' + (e.data && e.data.token) + ' from ' + e.origin; });
if (location.search.includes('cycles')) { var cn = +(new URLSearchParams(location.search).get('n') || 20); window.__handles = 0; window.__refused = 0; setTimeout(function cycle(i) { i = typeof i === 'number' ? i : 0; if (i >= cn) { window.__fired = cn; return; } var w = window.open('/h-child.html?w=c' + i, 'churn' + i, 'width=300,height=200'); if (w) { window.__handles++; setTimeout(function () { try { w.close(); } catch (e) {} setTimeout(function () { cycle(i + 1); }, 250); }, 150); } else { window.__refused++; setTimeout(function () { cycle(i + 1); }, 40); } }, 400); }
if (location.search.includes('storm')) { var n = +(new URLSearchParams(location.search).get('n') || 40); var churn = false; setTimeout(function () { for (var i = 0; i < n; i++) { var w = window.open('/h-child.html?w=s' + i, location.search.includes('named') ? 'storm' + i : '_blank', location.search.includes('named') ? 'width=300,height=200' : ''); if (churn && w) setTimeout(function (w) { try { w.close(); } catch (e) {} }.bind(null, w), 50); } window.__fired = n; }, 400); }
if (location.search.includes('auto')) setTimeout(function () { window.open('/h-child.html?w=auto&loop=1', 'hauto', 'width=400,height=300'); }, 400);
</script>`,
  '/h-child.html': (q) => `<!doctype html><title>Child ${q.get('w') ?? ''}</title><body style="margin:0;background:#ffd"><h1>child ${q.get('w') ?? ''}</h1>
<button id="rz" onclick="window.__rz = 0; window.resizeTo(4000, 4000); window.moveTo(0, 0); window.resizeBy(2000, 2000); window.moveBy(-900, -900); var iv = setInterval(function () { window.resizeTo(4000, 4000); window.moveTo(0, 0); window.resizeBy(2000, 2000); window.moveBy(-900, -900); window.__rz++; }, 40); setTimeout(function () { clearInterval(iv); }, 4200);">resize-loop (needs a click)</button> <a id="ssh" href="ssh://evil.example/popup">ssh</a> <a id="zoom" href="zoommtg://zoom.us/popup">zoom</a> <a id="mail" href="mailto:p@q.r">mail</a> <button id="loc" onclick="location.href='ssh://evil.example/popuploc'">location=ssh</button> <a id="mailtel" href="tel:+9">tel</a>
<script>
if (new URLSearchParams(location.search).get('spoof')) { var t = ['https://accounts.google.com — Sign in', '\\u202eelgoog.moc\\u202c', 'Orchestra — Authorize', 'x'.repeat(5000)]; var i = 0; setInterval(function () { document.title = t[i++ % t.length]; }, 120); }
if (new URLSearchParams(location.search).get('loop')) { window.__loops = 0; setInterval(function () { window.resizeTo(4000, 4000); window.moveTo(0, 0); window.resizeBy(2000, 2000); window.moveBy(-900, -900); window.__loops++; }, 40); }
</script>`,
  '/h-idp.html': (q) => `<!doctype html><title>IdP login</title><body><h1>IdP</h1><script>setTimeout(function () { window.opener.postMessage({ token: 'T-' + Math.random().toString(36).slice(2, 8) }, decodeURIComponent(new URLSearchParams(location.search).get('o') || '*')); window.close(); }, 600);</script>`,
};
const hostSrv = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x'); const p = PAGES[u.pathname];
  if (u.pathname === '/h-redir') { res.writeHead(302, { location: u.searchParams.get('to') }); return res.end(); }
  if (p) { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); return res.end(p(u.searchParams)); }
  res.writeHead(404); res.end('nope');
});
await new Promise((r) => hostSrv.listen(0, '127.0.0.1', r));
const HP = hostSrv.address().port; const HBASE = `http://127.0.0.1:${HP}`;
console.log(`[rig] my hostile site ${HBASE} (+ http://localhost:${HP} as the other site) arms ${[...MY_ARMS].join(',')} out ${OUT}`);
const world = seedWorld(path.join(RIG_DIR, 'world'));
let b = null;
const xdgLines = () => fs.readFileSync(world.xdgLog, 'utf8').split('\n').filter(Boolean);
const xdgCount = () => xdgLines().length;
async function runArm(arm, fn) { try { await fn(); } catch (e) { clause(arm, 'arm-completed', false, `ARM ABORTED: ${String(e.stack || e).split('\n').slice(0, 3).join(' | ')}`); } }
const T = (re) => pageTargets(b).then((l) => l.find((t) => re.test(t.url)));
const TS = (re) => pageTargets(b).then((l) => l.filter((t) => re.test(t.url)));
const refusalsOf = (reason) => refusals(world, reason);
async function loadOpener(qs = '') {
  // closes every popup window, leaves ONE tab on my opener page
  for (const t of await TS(/h-(child|idp)/)) { const tabUrls = new Set((await tabs(b)).map((x) => x.tip)); if (!tabUrls.has(t.url)) { try { await evalIn(t, 'window.close()'); } catch {} } }
  await sleep(500); await closeExtraTabs(b, 1);
  await typeUrl(b, `${HBASE}/h-opener.html${qs}`);
  await waitFor(async () => (await tabs(b))[0]?.label === 'H opener', 20000, 'tab 1 to load my opener');
  await sleep(500);
  return T(/h-opener\.html/);
}
const childWins = () => swayWindows(b.app.pid).filter((w) => typeof w.name === 'string' && /^(https?:\/\/|about:blank|unknown origin)/.test(w.name) && w.rect); // our popup titles lead with the origin; size is NOT a filter (a window that outgrew the app must still be seen)
const mainRect = () => swayWindows(b.app.pid).find((w) => /^Orchestra$/i.test(w.name))?.rect ?? swayWindows(b.app.pid)[0]?.rect;
try {
  b = await boot(world, 'boot1');
  await openBrowserPane(b);
  const base = await loadOpener();
  clause('rig', 'ctl/my-opener-page-is-up', !!base && (await evalIn(base, `document.getElementById('status').textContent`)) === 'idle', `target ${base?.url}`);
  await evalIn(base, `document.addEventListener('click', (e) => { window.__clicks = (window.__clicks || 0) + 1; window.__trusted = e.isTrusted; }, true)`);
  await clickIn(base, '#status');
  clause('rig', 'ctl/cdp-click-is-trusted', (await evalIn(base, `[window.__clicks, window.__trusted].join()`)) === '1,true', 'my pages');
  // positive control of the xdg-open SPY: a mailto click IS recorded (and tel)
  { const n0 = xdgCount(); await clickIn(base, '#mail'); await softWait(async () => xdgCount() > n0, 6000, 'xdg-open to record the mailto'); const l = xdgLines().slice(n0);
    clause('rig', 'ctl/the-xdg-open-spy-records-a-clicked-mailto', l.some((x) => x.startsWith('mailto:')), `recorded ${J(l)}`);
    const n1 = xdgCount(); await clickIn(base, '#tel'); await softWait(async () => xdgCount() > n1, 6000, 'xdg-open to record the tel'); clause('rig', 'ctl/the-xdg-open-spy-records-a-clicked-tel', xdgLines().slice(n1).some((x) => x.startsWith('tel:')), `recorded ${J(xdgLines().slice(n1))}`); }

  // ─────────── oauthx: a cross-site IdP popup completes, its window closes, and the title is origin-first ───────────
  if (MY_ARMS.has('oauthx')) await runArm('oauthx', async () => {
    const op = await loadOpener();
    await clickIn(op, '#idp');
    const up = await softWait(async () => childWins().length >= 1, 10000, 'the IdP child window');
    const names = childWins().map((w) => w.name);
    const done = await softWait(async () => /^token:T-/.test((await val(() => evalIn(op, `document.getElementById('status').textContent`), '')) || ''), 12000, 'the token in the opener');
    const status = await val(() => evalIn(op, `document.getElementById('status').textContent`), '');
    await sleep(800);
    clause('oauthx', 'the-cross-site-popup-is-a-native-window-and-its-title-leads-with-its-origin', up && names.some((n) => /^http:\/\/localhost:\d+/.test(n)), `child window names ${J(names)}`);
    clause('oauthx', 'the-token-reaches-window.opener-with-the-IdP-origin', done && new RegExp(`from http://localhost:${HP}$`).test(status), `opener #status = ${J(status)}`);
    clause('oauthx', 'the-popup-closes-itself-and-leaves-no-window', childWins().length === 0, `windows after: ${J(childWins().map((w) => w.name))}`);
  });

  // ─────────── xdg: no OS hand-off for anything but a clicked mailto/tel — in a TAB and in a POPUP, by every navigation vector ───────────
  if (MY_ARMS.has('xdg')) await runArm('xdg', async () => {
    const schemes = ['ssh', 'zoom', 'smb', 'vscode', 'steam', 'slack', 'sms', 'facetime'];
    const op = await loadOpener();
    const n0 = xdgCount();
    for (const id of schemes) { await clickIn(op, `#${id}`); await sleep(400); }
    for (const id of ['loc', 'frame', 'form', 'redir']) { await clickIn(op, `#${id}`); await sleep(700); if (id !== 'frame') { await softWait(async () => (await tabs(b))[0]?.label === 'H opener', 5000, 'back to the opener'); } }
    await sleep(1500);
    clause('xdg', 'tab: 8 scheme links + location + iframe + form + 302 reach no xdg-open', xdgCount() === n0, `xdg-open log grew by ${xdgCount() - n0}: ${J(xdgLines().slice(n0))}`);
    // the same from a POPUP window
    const op2 = await loadOpener();
    await clickIn(op2, '#named'); await softWait(async () => (await T(/h-child\.html\?w=named/)), 10000, 'the named child page');
    const child = await T(/h-child\.html\?w=named/);
    const n1 = xdgCount();
    if (child) { for (const id of ['ssh', 'zoom', 'loc']) { await clickIn(child, `#${id}`); await sleep(700); } }
    await sleep(1200);
    clause('xdg', 'popup: ssh / zoommtg / location=ssh clicks reach no xdg-open', !!child && xdgCount() === n1, `child ${!!child}; xdg-open log grew by ${xdgCount() - n1}: ${J(xdgLines().slice(n1))}`);
    // positive controls in the same two surfaces
    const n2 = xdgCount(); await clickIn(op2, '#mail'); await softWait(async () => xdgCount() > n2, 6000, 'mailto from the tab');
    clause('xdg', 'ctl/tab: mailto IS recorded', xdgLines().slice(n2).some((x) => x.startsWith('mailto:')), J(xdgLines().slice(n2)));
    const n3 = xdgCount(); if (child) { await clickIn(child, '#mail'); await softWait(async () => xdgCount() > n3, 6000, 'mailto from the popup'); }
    clause('xdg', 'ctl/popup: mailto IS recorded', xdgLines().slice(n3).some((x) => x.startsWith('mailto:')), J(xdgLines().slice(n3)));
    // a page that tries mailto:/tel: WITHOUT a user click (load-time navigation, a programmatic a.click(), window.open) — the ticket says only a user's own click may start an OS hand-off
    { const n4 = xdgCount(); const opN = await loadOpener('?nogesture=1'); await sleep(3500);
      const got = xdgLines().slice(n4);
      clause('xdg', 'no-click-mailto-tel-by-load-time-navigation-a.click()-or-window.open-reach-no-xdg-open', got.length === 0, `xdg-open log grew by ${got.length}: ${J(got)} (location.href=mailto at load, programmatic tel: a.click(), window.open(mailto:) — none had a user click)`);
      const n5 = xdgCount(); await clickIn(opN, '#armtimer'); await sleep(2500);
      const got2 = xdgLines().slice(n5);
      info396('xdg', `mailto: by a timer 300 ms after a click (gesture window 5 s): xdg-open recorded ${J(got2)} — an ordinary browser also honours a navigation within the activation window`); }
    const lg = logLines(world).filter((l) => /external protocol refused/.test(l));
    clause('xdg', 'refusals-are-logged-with-the-scheme-only', lg.length >= 5 && lg.every((l) => !/evil\.example|confno|etc\/passwd/.test(l)), `${lg.length} refusal lines; sample ${J(lg.slice(-2).map((l) => l.slice(-60)))}`);
  });

  // ─────────── names: a live popup name is not retargetable from another tab or another workspace ───────────
  if (MY_ARMS.has('names')) await runArm('names', async () => {
    const op = await loadOpener('?id=ws1t1');
    await clickIn(op, '#shared');
    await softWait(async () => !!(await T(/h-child\.html\?w=shared/)), 10000, 'the shared window');
    const w1 = childWins().length; const first = await T(/h-child\.html\?w=shared/);
    // a second TAB of the same workspace asks for the same name
    await clickSel(b, '.browser-tab-new'); await softWait(async () => (await tabs(b)).length === 2, 8000, 'a 2nd tab');
    await typeUrl(b, `${HBASE}/h-opener.html?id=ws1t2`); await softWait(async () => (await tabs(b))[1]?.label === 'H opener', 15000, 'tab 2 on the opener');
    await sleep(500);
    const op2 = await T(/h-opener\.html\?id=ws1t2/);
    const r0 = refusalsOf('name-in-use');
    await clickIn(op2, '#shared'); await sleep(1500);
    clause('names', 'another-tab-asking-for-a-live-popup-name-is-refused', refusalsOf('name-in-use') === r0 + 1 && childWins().length === w1, `name-in-use refusals ${r0}→${refusalsOf('name-in-use')}; child windows ${w1}→${childWins().length}`);
    clause('names', 'and-the-first-popup-was-not-retargeted', !!first && (await val(() => evalIn(first, 'location.href'), '')).includes('w=shared'), `first popup url ${await val(() => evalIn(first, 'location.href'), '<gone>')}`);
    // ANOTHER WORKSPACE
    await selectWorkspace(b, 'e2e/bp396-2'); await openBrowserPane(b).catch(() => {});
    await softWait(async () => (await tabs(b)).length >= 1, 15000, 'workspace 2 strip');
    await typeUrl(b, `${HBASE}/h-opener.html?id=ws2t1`); await softWait(async () => (await tabs(b))[0]?.label === 'H opener', 20000, 'ws2 on the opener');
    await sleep(500);
    const opW2 = await T(/h-opener\.html\?id=ws2t1/);
    clause('names', 'ctl/the-ws2-opener-page-target-is-the-one-I-click-in', !!opW2 && /id=ws2t1/.test(opW2.url), `target ${opW2?.url}`);
    const r1 = refusalsOf('name-in-use');
    await clickIn(opW2, '#shared'); await sleep(1500);
    clause('names', 'another-WORKSPACE-asking-for-the-name-is-refused-too', refusalsOf('name-in-use') === r1 + 1, `name-in-use refusals ${r1}→${refusalsOf('name-in-use')}`);
    // control: once the holder is gone the name is free again
    await selectWorkspace(b, 'e2e/bp396-1');
    for (const t of await TS(/h-child\.html\?w=shared/)) { try { await evalIn(t, 'window.close()'); } catch {} }
    await sleep(900);
    await selectWorkspace(b, 'e2e/bp396-2'); await sleep(500);
    const r2 = refusalsOf('name-in-use'); await clickIn(opW2, '#shared'); await sleep(1500);
    clause('names', 'ctl/once-the-holder-is-gone-the-name-is-usable-again', refusalsOf('name-in-use') === r2 && !!(await T(/h-child\.html\?w=shared/)), `refusals ${r2}→${refusalsOf('name-in-use')}; popup exists ${!!(await T(/h-child\.html\?w=shared/))}`);
    for (const t of await TS(/h-child/)) { try { await evalIn(t, 'window.close()'); } catch {} }
    await selectWorkspace(b, 'e2e/bp396-1'); await sleep(600);
  });

  // ─────────── title: a page cannot dress its native window up (origin first, bidi/control stripped, length bounded) ───────────
  if (MY_ARMS.has('title')) await runArm('title', async () => {
    const op = await loadOpener();
    await clickIn(op, '#spoof');
    await softWait(async () => childWins().length >= 1, 10000, 'the spoofing window');
    const seen = new Set();
    for (let i = 0; i < 24; i++) { for (const w of childWins()) seen.add(w.name); await sleep(110); }
    const names = [...seen];
    const origin = HBASE;
    clause('title', 'ctl/the-page-really-cycled-through-its-spoof-titles', names.length >= 3, `${names.length} distinct window names seen: ${J(names.map((n) => n.slice(0, 70)))}`);
    clause('title', 'every-window-title-starts-with-the-real-origin', names.length > 0 && names.every((n) => n.startsWith(origin)), `non-conforming: ${J(names.filter((n) => !n.startsWith(origin)).map((n) => n.slice(0, 60)))}`);
    clause('title', 'no-bidi-override-or-control-char-and-length-bounded', names.every((n) => !/[\u0000-\u001f‪-‮⁦-⁩]/.test(n) && n.length <= 140), `max length ${Math.max(...names.map((n) => n.length))}`);
    grim('title-spoof.png');
    for (const t of await TS(/h-child/)) { try { await evalIn(t, 'window.close()'); } catch {} }
  });

  // ─────────── resize: a resizable:false popup keeps its bounds under resizeTo/moveTo/resizeBy/moveBy loops; features are clamped ───────────
  if (MY_ARMS.has('resize')) await runArm('resize', async () => {
    const main0 = mainRect();
    // (a) a PAGE-INITIATED popup (no click) whose own page loops resizeTo(4000,4000)/moveTo(0,0)/resizeBy/moveBy every 40 ms
    const op = await loadOpener('?auto=1');
    await softWait(async () => childWins().length >= 1, 12000, 'the page-initiated popup');
    await sleep(700);
    const child = await T(/h-child\.html\?w=auto/);
    const r0 = childWins()[0]?.rect; const o0 = child ? await val(() => evalIn(child, `[window.outerWidth, window.outerHeight, window.screenX, window.screenY, window.__loops].join()`), '') : '';
    await sleep(3000);
    const r1 = childWins()[0]?.rect; const o1 = child ? await val(() => evalIn(child, `[window.outerWidth, window.outerHeight, window.screenX, window.screenY, window.__loops].join()`), '') : '';
    const loops = +(o1.split(',')[4] ?? 0);
    clause('resize', 'ctl/the-popup-page-really-ran-its-resize-loop', loops >= 30, `page loop iterations ${loops}; compositor rect ${J(r0)} → ${J(r1)}`);
    clause('resize', 'a-resizable:false-popup-keeps-its-compositor-bounds-under-the-loop', !!r0 && !!r1 && r0.width === r1.width && r0.height === r1.height && r0.x === r1.x && r0.y === r1.y, `rect before ${J(r0)} after 3 s of resizeTo(4000)/moveTo(0)/resizeBy/moveBy: ${J(r1)}`);
    clause('resize', 'and-the-page-itself-sees-unchanged-outer-size-and-position', !!o0 && o0.split(',').slice(0, 4).join() === o1.split(',').slice(0, 4).join(), `outerW,outerH,screenX,screenY before ${o0.split(',').slice(0, 4)} after ${o1.split(',').slice(0, 4)}`);
    clause('resize', 'the-app-window-is-untouched', J(mainRect()) === J(main0), `main window rect ${J(main0)} → ${J(mainRect())}`);
    // (a2) a popup the HUMAN opened (trusted click → shown focused), then a TRUSTED CLICK inside it fires resizeTo/moveTo/resizeBy/moveBy (synchronously in the handler, then looping 4 s):
    //      Chromium applies these only with user activation and Electron applies them to the window unless vetoed — THIS is the arm the content-bounds-updated veto must hold
    for (const t of await TS(/h-child/)) { try { await evalIn(t, 'window.close()'); } catch {} }
    await sleep(500);
    const opU = await loadOpener();
    await clickIn(opU, '#named'); await softWait(async () => childWins().length >= 1, 10000, 'the click-opened popup'); await sleep(900);
    const childU = await T(/h-child\.html\?w=named/);
    if (childU) {
      const g0 = childWins()[0]?.rect;
      await clickIn(childU, '#rz'); await sleep(1500);
      const g1 = childWins()[0]?.rect; const og1 = await val(() => evalIn(childU, `[window.outerWidth, window.outerHeight, window.screenX, window.screenY, window.__rz].join()`), '');
      await sleep(3000);
      const g2 = childWins()[0]?.rect; const rzN = +(og1.split(',')[4] ?? 0);
      clause('resize', 'ctl/the-click-armed-loop-really-ran', rzN >= 10, `iterations by +1.5 s: ${rzN}; rect ${J(g0)} → ${J(g1)} → ${J(g2)}`);
      clause('resize', 'a-click-armed-resizeTo/moveTo/resizeBy/moveBy-loop-cannot-move-or-resize-a-click-opened-popup', !!g0 && !!g1 && !!g2 && [g1, g2].every((g) => g.width === g0.width && g.height === g0.height && g.x === g0.x && g.y === g0.y), `rect before ${J(g0)}; during ${J(g1)}; after ${J(g2)}`);
      clause('resize', 'and-the-app-window-is-still-untouched-after-it', J(mainRect()) === J(main0), `main window rect ${J(main0)} → ${J(mainRect())}`);
    } else clause('resize', 'ctl/the-click-armed-loop-really-ran', false, 'no click-opened popup page target');
    // positive control of the bounds INSTRUMENT: change the window through the compositor and see the read move
    const nm = childWins()[0]?.name;
    if (nm) { sh('swaymsg', [`[title="${nm.replace(/"/g, '\\"')}"] resize set width ${r1.width + 120} px height ${r1.height + 80} px`]); await sleep(500); }
    const r2 = childWins()[0]?.rect;
    clause('resize', 'ctl/the-bounds-read-moves-when-the-window-really-changes', !!r2 && (r2.width !== r1.width || r2.height !== r1.height), `after a compositor resize ${J(r1)} → ${J(r2)} (floating non-resizable windows may refuse; INFO if equal)`);
    for (const t of await TS(/h-child/)) { try { await evalIn(t, 'window.close()'); } catch {} }
    await sleep(600);
    // (b) features clamping on a USER click: huge + fullscreen/alwaysOnTop/frame=no/transparent/kiosk, and a 10x10 request
    const op2 = await loadOpener();
    await clickIn(op2, '#bigfeat'); await softWait(async () => childWins().length >= 1, 10000, 'the hostile-features window');
    await sleep(700);
    const big = childWins()[0]; const mr = mainRect();
    clause('resize', 'hostile-features-window-is-not-fullscreen-and-fits-inside-the-app-window', !!big && big.fullscreen !== 1 && big.rect.width <= mr.width && big.rect.height <= mr.height && big.rect.width <= Math.floor(VIEWPORT.w * 0.95), `window ${J(big)} app ${J(mr)}`);
    grim('hostile-features.png');
    for (const t of await TS(/h-child/)) { try { await evalIn(t, 'window.close()'); } catch {} }
    await sleep(600);
    await clickIn(op2, '#tinyfeat'); await softWait(async () => childWins().length >= 1, 10000, 'the tiny window'); await sleep(500);
    const tiny = childWins()[0];
    clause('resize', 'a-10x10-request-becomes-a-usable-window-not-a-clickjacking-pixel', !!tiny && tiny.rect.width >= 200 && tiny.rect.height >= 150, `window ${J(tiny)}`);
    for (const t of await TS(/h-child/)) { try { await evalIn(t, 'window.close()'); } catch {} }
  });

  // ─────────── storm: 40 popups (no click): budget/cap/rate; churn defeats the concurrent budget but not the rate cap ───────────
  if (MY_ARMS.has('storm')) await runArm('storm', async () => {
    await sleep(500);
    const r0 = { budget: refusalsOf('budget'), rate: refusalsOf('rate'), cap: refusalsOf('cap') };
    const op = await loadOpener('?storm=1&n=40&named=1');
    await softWait(async () => (await val(() => evalIn(op, 'window.__fired'), 0)) === 40, 15000, 'the page to fire 40 popups');
    await sleep(2500);
    const wins = childWins().length; const tb = (await tabs(b)).length; const tg = (await viewTargets(b)).length;
    clause('storm', 'ctl/the-page-really-fired-40', (await val(() => evalIn(op, 'window.__fired'), 0)) === 40, 'named window.open ×40 from a timer, no click');
    clause('storm', '40-named-popups-without-a-click-open-at-most-3', wins <= 3 && wins >= 1, `child windows ${wins}, tabs ${tb}, page targets ${tg}; refusals budget +${refusalsOf('budget') - r0.budget} rate +${refusalsOf('rate') - r0.rate} cap +${refusalsOf('cap') - r0.cap}`);
    clause('storm', 'the-rest-were-refused-and-counted', (refusalsOf('budget') - r0.budget) + (refusalsOf('rate') - r0.rate) + (refusalsOf('cap') - r0.cap) >= 30, `total refusals ${(refusalsOf('budget') - r0.budget) + (refusalsOf('rate') - r0.rate) + (refusalsOf('cap') - r0.cap)}`);
    await loadOpener(); await sleep(800);
    // churn: SEQUENTIAL open→close cycles (each popup is closed before the next opens), so the CONCURRENT budget never binds — only the per-minute rate cap can stop it.
    // The first storm above opened up to 3 page-initiated popups: let that minute roll off, so the cap starts from zero.
    console.log('  (waiting 62 s for the rate window of the first storm to roll off)'); await sleep(62000);
    const r1 = { rate: refusalsOf('rate'), budget: refusalsOf('budget') };
    const op2 = await loadOpener('?cycles=1&n=20');
    await softWait(async () => (await val(() => evalIn(op2, 'window.__fired'), 0)) === 20, 40000, 'the 20 open+close cycles');
    const handles = await val(() => evalIn(op2, 'window.__handles'), -1); const refusedByPage = await val(() => evalIn(op2, 'window.__refused'), -1);
    await sleep(800);
    clause('storm', 'ctl/the-page-ran-20-sequential-open-close-cycles', (await val(() => evalIn(op2, 'window.__fired'), 0)) === 20, `window.open returned a handle ${handles}× and null ${refusedByPage}×`);
    clause('storm', 'churn-(sequential-open+close)-opens-exactly-6-per-minute', handles === 6, `${handles} windows really opened of 20 attempts without a click (cap 6/min; the budget of 3 never binds: each window is closed before the next)`);
    clause('storm', 'the-rest-were-refused-by-RATE-not-budget', refusalsOf('rate') - r1.rate >= 13 && refusalsOf('budget') === r1.budget, `rate refusals +${refusalsOf('rate') - r1.rate}, budget refusals +${refusalsOf('budget') - r1.budget}`);
    clause('storm', 'no-window-left-behind', childWins().length === 0, `child windows after the churn: ${childWins().length}`);
    // cap 8 with USER clicks: 12 clicks on the named button (distinct names) → never more than 8 tabs+windows
    await loadOpener();
  });

  await teardown(b, 'term'); b = null;
} catch (e) {
  clause('rig', 'harness-completed', false, `ABORTED: ${String(e.stack || e).split('\n').slice(0, 4).join(' | ')}`);
  if (b) { try { await teardown(b, 'term'); } catch {} }
} finally {
  try { hostSrv.close(); } catch {}
}
