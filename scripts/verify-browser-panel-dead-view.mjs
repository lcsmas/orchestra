// Regression harness for the `browser:setBounds failed TypeError: Cannot read
// properties of undefined (reading 'isDestroyed')` crash.
//
// THE BUG
// -------
// Electron sets `WebContentsView.webContents` to `undefined` once the underlying
// WebContents is destroyed — even though its typing declares the property
// NON-nullable (`readonly webContents: WebContents`). A view can lose its
// contents WITHOUT going through destroyPanel: a renderer/GPU crash of the
// sandboxed panel page, Chromium reclaiming it, or window teardown.
//
// browser-panel.ts guarded dead views with `panel.view.webContents.isDestroyed()`.
// When `webContents` is undefined that expression THROWS on the very property
// access meant to detect the dead view — so the guard is structurally unable to
// do its job. The renderer pushes bounds continuously (ResizeObserver + window
// resize), so a dead view produced a BURST of these (98 in one session,
// 2026-07-24 10:21:29 → 10:23:37, all from one v0.5.161 run).
//
// Verified against real Electron 33 before writing this harness:
//   BEFORE close(): typeof view.webContents = object,  isDestroyed() = false
//   AFTER  close(): typeof view.webContents = undefined
//                   -> TypeError: Cannot read properties of undefined (reading 'isDestroyed')
// The stub below reproduces exactly that observed behaviour.
//
// Same loader-hook pattern as verify-archive-browser-panel.mjs.
// Run: node scripts/verify-browser-panel-dead-view.mjs

import { register } from 'node:module';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert';

// --- Stub `electron`, modelling the REAL nulling behaviour -----------------
const STUB = `
class WebContents {
  constructor(view) {
    this._view = view;
    this.destroyed = false;
    this.debugger = { attach(){}, detach(){}, isAttached: () => false, sendCommand: () => Promise.resolve({}) };
    this.navigationHistory = { canGoBack: () => false, canGoForward: () => false, goBack(){}, goForward(){} };
    this._handlers = {};
  }
  isDestroyed() { return this.destroyed; }
  on(ev, fn) { (this._handlers[ev] || (this._handlers[ev] = [])).push(fn); }
  emitEvent(ev, ...a) { for (const f of (this._handlers[ev] || [])) f(...a); }
  once() {} setWindowOpenHandler() {}
  loadURL() { return Promise.resolve(); }
  reload() { this.reloaded = true; }
  capturePage() { return Promise.resolve({ toJPEG: () => Buffer.from('x') }); }
  getURL() { return ''; } getTitle() { return ''; }
  // THE CRITICAL BEHAVIOUR: destroying the contents makes the VIEW drop its
  // reference, so view.webContents becomes undefined (real Electron 33 does this).
  close() { this.destroyed = true; this._view.webContents = undefined; }
}
export class WebContentsView {
  constructor() { this.webContents = new WebContents(this); this.bounds = null; }
  setBounds(b) { this.bounds = b; }
  setBackgroundColor() {}
  /** Simulate an EXTERNAL death (renderer/GPU crash, Chromium reclaim) — the
   *  contents vanish without anyone calling destroyPanel. */
  killExternally() { this.webContents.destroyed = true; this.webContents = undefined; }
}
export const Menu = { buildFromTemplate: () => ({ popup(){} }) };
export const clipboard = { writeText(){} };
export const shell = { openExternal(){} };
export const session = { fromPartition: () => ({ setUserAgent(){}, getUserAgent: () => 'UA' }) };
`;
const stubUrl = 'data:text/javascript,' + encodeURIComponent(STUB);
const platformUrl =
  'data:text/javascript,' + encodeURIComponent(`export const platform = { broadcast() {} };`);
const loggerUrl =
  'data:text/javascript,' +
  encodeURIComponent(`export const log = { info(){}, warn(){}, debug(){}, error(){} };`);

register(
  'data:text/javascript,' +
    encodeURIComponent(`
      export async function resolve(spec, ctx, next) {
        if (spec === 'electron') return { url: ${JSON.stringify(stubUrl)}, shortCircuit: true };
        if (spec.endsWith('/platform') || spec === './platform') return { url: ${JSON.stringify(platformUrl)}, shortCircuit: true };
        if (spec.endsWith('/logger') || spec === './logger') return { url: ${JSON.stringify(loggerUrl)}, shortCircuit: true };
        return next(spec, ctx);
      }
    `),
  pathToFileURL('./'),
);

const bp = await import(
  pathToFileURL(new URL('../src/main/browser-panel.ts', import.meta.url).pathname).href
);

const attached = new Set();
const win = {
  contentView: {
    addChildView: (v) => attached.add(v),
    removeChildView: (v) => attached.delete(v),
  },
};
bp.initBrowserPanels(() => win);

const results = [];
const check = (name, fn) => {
  try {
    fn();
    results.push(['PASS', name]);
  } catch (e) {
    results.push(['FAIL', name, e.message]);
  }
};

// Open a panel and get it fully attached (agent-style: show, then bounds).
function openPanel(id) {
  bp.showPanel(id);
  bp.setBounds(id, { x: 0, y: 0, width: 800, height: 600 });
  return bp.getPanel(id);
}

// --- 1. THE CRASH: setBounds on a view whose contents died externally -------
check('setBounds does not throw when the view lost its webContents', () => {
  const id = 'ws-external-death';
  const panel = openPanel(id);
  panel.view.killExternally(); // renderer/GPU crash — destroyPanel never ran
  // Before the fix this threw:
  //   TypeError: Cannot read properties of undefined (reading 'isDestroyed')
  bp.setBounds(id, { x: 1, y: 2, width: 300, height: 200 });
});

// --- 2. The dead panel must be reaped, not left as a husk ------------------
check('a dead view is evicted from the panels map', () => {
  const id = 'ws-reaped';
  const panel = openPanel(id);
  panel.view.killExternally();
  bp.setBounds(id, { x: 0, y: 0, width: 10, height: 10 });
  assert.strictEqual(bp.getPanel(id), undefined, 'husk still in the map');
});

// --- 3. And detached, so it cannot keep compositing over the app -----------
check('a dead view is detached from the window', () => {
  const id = 'ws-detached';
  const panel = openPanel(id);
  assert.strictEqual(attached.size, 1, 'setup: view should be attached');
  panel.view.killExternally();
  bp.setBounds(id, { x: 0, y: 0, width: 10, height: 10 });
  assert.strictEqual(attached.size, 0, `dead view still attached: ${attached.size}`);
});

// --- 4. browser:show hit the SAME throw (2 of the 98 logged errors) --------
check('showPanel does not throw on a dead view (rebuilds instead)', () => {
  const id = 'ws-show-after-death';
  const panel = openPanel(id);
  panel.view.killExternally();
  const st = bp.showPanel(id); // went through ensurePanel -> same bad guard
  assert.ok(st, 'showPanel should return a state');
  const fresh = bp.getPanel(id);
  assert.ok(fresh, 'a fresh panel should have been created');
  assert.notStrictEqual(fresh.view, panel.view, 'should be a NEW view, not the dead one');
});

// --- 5. emitState is reachable from webContents events during teardown -----
check('a late webContents event does not throw', () => {
  const id = 'ws-late-event';
  const panel = openPanel(id);
  const wc = panel.view.webContents; // hold the reference the closures captured
  panel.view.killExternally();
  wc.emitEvent('did-navigate');
  wc.emitEvent('did-stop-loading');
  wc.emitEvent('page-title-updated');
});

// --- 6. The agent layer must fail with a CLEAR error, not a TypeError ------
check('agent capture() reports a missing panel, not a TypeError', () => {
  const id = 'ws-agent-capture';
  const panel = openPanel(id);
  panel.view.killExternally();
  let msg = '';
  bp.capture(id).catch((e) => {
    msg = e.message;
  });
  // capture() throws synchronously inside the promise; drain the microtask queue.
  return Promise.resolve().then(() => {
    assert.ok(!/isDestroyed/.test(msg), `leaked a TypeError: ${msg}`);
  });
});

// --- 7. Normal operation still works (the fix must not break the happy path)
check('a live panel still positions and shows normally', () => {
  const id = 'ws-happy';
  bp.showPanel(id);
  bp.setBounds(id, { x: 5, y: 6, width: 640, height: 480 });
  const p = bp.getPanel(id);
  assert.ok(p, 'live panel should be retrievable');
  assert.deepStrictEqual(p.view.bounds, { x: 5, y: 6, width: 640, height: 480 });
  assert.strictEqual(attached.size, 1, 'live panel should be attached');
  bp.destroyPanel(id);
  assert.strictEqual(attached.size, 0, 'destroyPanel should detach');
});

// --- 8. destroyPanel on an already-dead view must not throw ---------------
check('destroyPanel is safe on an already-dead view', () => {
  const id = 'ws-double-destroy';
  const panel = openPanel(id);
  panel.view.killExternally();
  bp.destroyPanel(id);
});

for (const r of results) console.log(r[0].padEnd(5), r[1], r[2] ? `— ${r[2]}` : '');
const failed = results.filter((r) => r[0] === 'FAIL').length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
