// Electron ground truth for EVERY sidebar surface in the region, from the DOM.
//
// Policy (agreed with the integration agent): Electron-side colour/geometry
// claims come from the live DOM — computed rgba with alpha explicit, real
// bounding boxes — because inferring them from pixels re-opens the entire
// translucency problem on the reference side. Pixels are reserved for GTK,
// where no such oracle exists.
//
// Emits one record per surface so the GTK side can be compared item by item,
// and reports COUNTS (never "clean"/"none"), because a precise count can
// disagree with a broken probe where a vague claim silently ratifies it.
const port = process.env.ORCHESTRA_DEBUG_PORT || '9430';
const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page = targets.find((t) => t.type === 'page');
console.log('target:', page.url);
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0;
const send = (m, p) =>
  new Promise((res) => {
    const myId = ++id;
    const onMsg = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id === myId) { ws.removeEventListener('message', onMsg); res(msg.result); }
    };
    ws.addEventListener('message', onMsg);
    ws.send(JSON.stringify({ id: myId, method: m, params: p }));
  });
await send('Runtime.enable');

const SELECTORS = [
  // shell / chrome
  '.sidebar', '.sidebar-header', '.sidebar-title', '.ws-list',
  // sections
  '.repo-section', '.repo-header', '.repo-name', '.repo-count', '.repo-add',
  '.orchestrator-section .repo-name', '.scratch-section .repo-name',
  '.repo-sync', '.host-group-header', '.host-dot',
  // rows
  '.ws-item', '.ws-item.active', '.ws-dot', '.ws-tree-connector', '.ws-collapse',
  '.ws-name', '.ws-hidden-count', '.ws-icon-btn', '.ws-context', '.ws-size',
  '.ws-login-badge', '.account-badge',
  // pills
  '.ws-pills', '.repo-tag-pill', '.orchestrator-pill', '.merged-pill',
  '.released-pill', '.unpushed-pill', '.diff-indicator', '.setup-pill',
  '.pr-badge', '.pr-badge.linear',
  // archived / notices / footer / usage / insights
  '.archived-toggle', '.archived-bar', '.archived-row',
  '.env-notice', '.env-notice-body', '.env-notice-link',
  '.sidebar-footer', '.sidebar-footer-link', '.sidebar-footer-version',
  '.usage-bars', '.usage-bar-label', '.usage-bar-track', '.usage-bar-fill',
  '.insights-row', '.insights-step', '.ws-empty-hint',
];

const expr = `(() => {
  const rect = (e) => { const b = e.getBoundingClientRect();
    return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) }; };
  const out = {};
  for (const sel of ${JSON.stringify(SELECTORS)}) {
    const els = [...document.querySelectorAll(sel)];
    if (!els.length) { out[sel] = { count: 0 }; continue; }
    const e = els[0];
    const cs = getComputedStyle(e);
    out[sel] = {
      count: els.length,
      text: e.textContent.trim().slice(0, 40),
      rect: rect(e),
      color: cs.color,
      background: cs.backgroundColor,
      fontSize: cs.fontSize, fontWeight: cs.fontWeight,
      textTransform: cs.textTransform, letterSpacing: cs.letterSpacing,
      padding: cs.padding, borderRadius: cs.borderRadius,
      borderTop: cs.borderTopWidth + ' ' + cs.borderTopColor,
      borderLeft: cs.borderLeftWidth + ' ' + cs.borderLeftColor,
      gap: cs.gap, display: cs.display,
    };
  }
  return out;
})()`;
const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
console.log(JSON.stringify(r.result.value, null, 1));
ws.close();
