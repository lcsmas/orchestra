// CDP driver for the #88 stall rig. Prints the PRECONDITION (elapsed minutes,
// parked count) BESIDE every measurement — a stall rig whose clock drifts
// between arms passes vacuously, so the verdict is never reported alone.
const PORT = process.env.PORT || '9388';
const LABEL = process.env.LABEL || 'arm';
const SHOT = process.env.SHOT || '';
// The worktree this rig must be driving. Passed in by the rig script; the
// target URL is asserted against it so a CDP port collision with a sibling
// agent cannot make us gate THEIR build.
const REPO = process.env.REPO || process.cwd();

const res = await fetch(`http://127.0.0.1:${PORT}/json`);
const targets = await res.json();
// Filter by URL on EVERY connection — the browser panel becomes a second
// type:"page" target on the same port and find(t=>t.type==='page') grabs it.
const page = targets.find((t) => t.type === 'page' && t.url.includes('dist/index.html'));
if (!page) { console.log('NO_TARGET', JSON.stringify(targets.map(t=>({type:t.type,url:t.url})))); process.exit(2); }
if (page.url.includes('app.asar')) { console.log('VOID: driving the INSTALLED build', page.url); process.exit(3); }
console.log(`TARGET_URL=${page.url}`);
if (!page.url.includes(REPO)) { console.log(`VOID: target url is not my worktree`); process.exit(4); }

const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0; const pend = new Map();
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
});
await new Promise((r) => ws.addEventListener('open', r));
const send = (method, params={}) => new Promise((resolve) => {
  const i = ++id; pend.set(i, resolve); ws.send(JSON.stringify({id:i, method, params}));
});
const evaluate = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) return { __err: JSON.stringify(r.result.exceptionDetails) };
  return r.result?.result?.value;
};

// Optional: force the sidebar to its NARROWEST setting before measuring, to
// close the #35-lineage gap (a `flex-shrink: 0` pill inside `ws-pills` is the
// exact shape that overflowed there). SIDEBAR_WIDTH_MIN is 240 (App.tsx:55).
// NARROW: resize the sidebar WITHOUT reloading. The first version of this
// reloaded to apply the localStorage width — which resets OBSERVABLE_SINCE
// (module-eval time), restarting the 15-minute clock and guaranteeing NO badge
// to measure. The arm went green having measured nothing. Drive the app's own
// resize state instead, so the badge that is already on screen stays there.
if (process.env.NARROW === '1') {
  await evaluate(`
    (() => {
      localStorage.setItem('orchestra.sidebarWidthPx','240');
      // The width lives in App.tsx useState; the grid column is what actually
      // sizes the sidebar, so set it directly and let layout settle.
      const app = document.querySelector('.app') || document.body.firstElementChild;
      if (app) app.style.gridTemplateColumns = '240px 1fr';
      const sb = document.querySelector('.sidebar');
      if (sb) { sb.style.width = '240px'; sb.style.maxWidth = '240px'; }
      return true;
    })()
  `);
  await new Promise(r => setTimeout(r, 1500));
}

// Wait for the sidebar to actually render rows (SPAs render after load).
for (let i = 0; i < 60; i++) {
  const n = await evaluate(`document.querySelectorAll('.ws-item').length`);
  if (typeof n === 'number' && n > 0) break;
  await new Promise(r => setTimeout(r, 500));
}

// ARTIFACT IDENTITY. The renderer exposes no version handle, so read it from
// the MAIN process over the app's own IPC bridge — that is the running
// instance answering about itself, not a path I trust.
let runningVersion = await evaluate(`
  (async () => {
    try { return await window.orchestra.getAppVersion(); } catch (e) { return null; }
  })()
`);
if (!runningVersion) {
  // Fallback that is still an identity claim about the RUNNING process, not a
  // path: the renderer bundle it actually loaded. Reported as such.
  const loaded = await evaluate(`[...document.scripts].map(s=>s.src).join(',')`);
  runningVersion = 'no-version-handle; loaded-bundle=' + loaded;
}

// Per-workspace readout. Reports the badge AND the preconditions that should
// have produced it, in the SAME object, so a verdict can never be read without
// its inputs.
const rows = await evaluate(`
(() => {
  const out = [];
  for (const el of document.querySelectorAll('.ws-item')) {
    const name = el.querySelector('.ws-name')?.textContent?.trim() || '?';
    const badge = el.querySelector('.ws-stall-badge');
    out.push({
      name,
      badge: !!badge,
      badgeText: badge ? badge.textContent.trim() : null,
      stallMinutes: badge ? badge.getAttribute('data-stall-minutes') : null,
      stallParked: badge ? badge.getAttribute('data-stall-parked') : null,
      title: badge ? badge.getAttribute('title') : null,
      rect: badge ? (r => ({left:Math.round(r.left),right:Math.round(r.right),top:Math.round(r.top),w:Math.round(r.width),h:Math.round(r.height)}))(badge.getBoundingClientRect()) : null,
      // #35 lineage: a pill can be present in the DOM and painting OUTSIDE its
      // container. Assert containment against the SIDEBAR, not the window.
      overflowsSidebar: badge ? (() => {
        const sb = el.closest('.sidebar') || el.parentElement;
        if (!sb) return 'no-container';
        const b = badge.getBoundingClientRect(), s = sb.getBoundingClientRect();
        return b.right > s.right + 0.5 || b.left < s.left - 0.5;
      })() : null,
      color: badge ? getComputedStyle(badge).color : null,
    });
  }
  const sb = document.querySelector('.sidebar');
  return { innerWidth: window.innerWidth, sidebarWidth: sb ? Math.round(sb.getBoundingClientRect().width) : null, rows: out };
})()
`);

// The store's own view of the preconditions, so the DOM verdict is reported
// beside the data that produced it rather than on its own.
// PRECONDITIONS. The renderer has no store-reading E2E seam for workspaces, so
// read them back over the app's own IPC (listWorkspaces) — main's live record,
// which is what the badge is computed from. Reporting the verdict WITHOUT these
// is exactly the vacuous-stall-rig failure: a clock that drifted between arms
// passes silently.
const state = await evaluate(`
(async () => {
  let list = null;
  try { list = await window.orchestra.listWorkspaces(); } catch (e) { return 'IPC_ERR ' + e.message; }
  if (!Array.isArray(list)) return 'NO_STORE';
  const now = Date.now();
  return list.map(w => ({
    branch: w.branch, status: w.status,
    parkedInboxCount: w.parkedInboxCount ?? 0,
    queued: (w.queuedPrompts||[]).length,
    lastStopReason: w.lastStopReason ?? null,
    minutesSinceTurnStart: w.lastTurnStartAt ? Math.round((now - w.lastTurnStartAt)/60000) : null,
  }));
})()
`);

console.log(`\n===== ${LABEL} =====`);
console.log('RUNNING_VERSION=' + runningVersion);
console.log('PRECONDITIONS (from the store):');
console.log(JSON.stringify(state, null, 1));
console.log('VERDICT (from the DOM):');
console.log(JSON.stringify(rows, null, 1));

// QUEUEDPROMPTS over the REAL app wire (env QUEUE=<wsId>). Closes the gap I
// have carried since the design comment: every arm so far exercised the inbox
// half, so the badge's OTHER source had only ever been unit-tested. This calls
// window.orchestra.queuePrompt -> IPC 'queue:add' -> addQueuedPrompt ->
// upsertWorkspace -> broadcast, i.e. the production path, and then re-reads the
// badge to see the count MOVE.
if (process.env.QUEUE) {
  const wsId = process.env.QUEUE;
  const before = await evaluate(`
    (() => { const el = [...document.querySelectorAll('.ws-item')]
      .find(e => e.querySelector('.ws-name')?.textContent?.trim() === ${JSON.stringify(process.env.QUEUE_BRANCH || '')});
      const b = el?.querySelector('.ws-stall-badge');
      return b ? { text: b.textContent.trim(), parked: b.getAttribute('data-stall-parked') } : null; })()
  `);
  const res = await evaluate(`
    window.orchestra.queuePrompt(${JSON.stringify(wsId)}, 'rig: a real queued prompt')
      .then(w => ({ ok: true, queued: (w.queuedPrompts||[]).length }))
      .catch(e => ({ ok: false, error: String(e && e.message || e) }))
  `);
  await new Promise(r => setTimeout(r, 1500));
  const after = await evaluate(`
    (() => { const el = [...document.querySelectorAll('.ws-item')]
      .find(e => e.querySelector('.ws-name')?.textContent?.trim() === ${JSON.stringify(process.env.QUEUE_BRANCH || '')});
      const b = el?.querySelector('.ws-stall-badge');
      return b ? { text: b.textContent.trim(), parked: b.getAttribute('data-stall-parked'), title: b.getAttribute('title') } : null; })()
  `);
  console.log('\nQUEUEDPROMPTS over the real wire:');
  console.log('  queuePrompt() ->', JSON.stringify(res));
  console.log('  badge BEFORE  ->', JSON.stringify(before));
  console.log('  badge AFTER   ->', JSON.stringify(after));
}

if (SHOT) {
  const shot = await Promise.race([
    send('Page.captureScreenshot', { format: 'png' }),
    new Promise(r => setTimeout(() => r(null), 15000)),
  ]);
  if (shot?.result?.data) {
    const fs = await import('node:fs');
    fs.writeFileSync(SHOT, Buffer.from(shot.result.data, 'base64'));
    console.log('SHOT=' + SHOT);
  } else console.log('SHOT_FAILED (timed out)');
}
ws.close();
