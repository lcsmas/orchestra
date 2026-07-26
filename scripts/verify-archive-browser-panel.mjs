// Verifies the archive/browser-panel compositing fix without launching Electron.
//
// The bug: archiving a workspace left its native WebContentsView attached to the
// window (it is composited ABOVE the renderer, so it paints an opaque black
// rectangle over the app). The renderer's BrowserPanel hides the view on
// unmount, but an AGENT can open a panel via its MCP browser tools with NO
// renderer component ever mounted, so nothing tore it down.
//
// We stub `electron` and load the REAL browser-panel module, then assert on the
// observable that matters: how many child views are attached to the window.
//
// Run: node scripts/verify-archive-browser-panel.mjs

import { register } from 'node:module';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert';

// --- Stub `electron` via a tiny loader hook -------------------------------
const STUB = `
export const attached = [];
class WebContents {
  constructor() { this.destroyed = false; this.debugger = { attach(){}, detach(){} }; this.navigationHistory = { canGoBack: () => false, canGoForward: () => false }; }
  isDestroyed() { return this.destroyed; }
  on() {} once() {} setWindowOpenHandler() {}
  loadURL() { return Promise.resolve(); }
  reload() {} close() { this.destroyed = true; }
  getURL() { return ''; } getTitle() { return ''; }
}
export class WebContentsView {
  constructor() { this.webContents = new WebContents(); this.bounds = null; this.bg = null; }
  setBounds(b) { this.bounds = b; }
  setBackgroundColor(c) { this.bg = c; }
}
export const Menu = { buildFromTemplate: () => ({ popup(){} }) };
export const clipboard = { writeText(){} };
export const shell = { openExternal(){} };
export const session = { fromPartition: () => ({ setUserAgent(){}, getUserAgent: () => 'UA' }) };
`;
const stubUrl = 'data:text/javascript,' + encodeURIComponent(STUB);

// browser-panel also pulls in ./platform (a directory module) and ./logger,
// neither of which matters here — stub them so plain Node can resolve the graph.
const PLATFORM_STUB = `export const platform = { broadcast() {} };`;
const platformUrl = 'data:text/javascript,' + encodeURIComponent(PLATFORM_STUB);
const LOGGER_STUB = `export const log = { info(){}, warn(){}, debug(){}, error(){} };`;
const loggerUrl = 'data:text/javascript,' + encodeURIComponent(LOGGER_STUB);

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

// --- Fake window recording attach/detach ----------------------------------
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

const WS = 'ws-agent-opened';

// 1. The agent path: showPanel with NO bounds ever set must NOT composite.
check('agent showPanel without bounds does not attach a view', () => {
  bp.showPanel(WS);
  assert.strictEqual(attached.size, 0, `expected 0 attached views, got ${attached.size}`);
});

// 2. Once the renderer measures the placeholder, the deferred show lands.
check('first setBounds performs the deferred attach', () => {
  bp.setBounds(WS, { x: 10, y: 20, width: 800, height: 600 });
  assert.strictEqual(attached.size, 1, `expected 1 attached view, got ${attached.size}`);
});

// 3. THE REGRESSION: destroying the panel (what archive now does) detaches it.
check('destroyPanel detaches the view (archive path)', () => {
  bp.destroyPanel(WS);
  assert.strictEqual(attached.size, 0, `orphaned view still attached: ${attached.size}`);
});

// 4. A late setBounds must not resurrect a destroyed panel.
check('setBounds after destroy does not re-attach', () => {
  bp.setBounds(WS, { x: 0, y: 0, width: 100, height: 100 });
  assert.strictEqual(attached.size, 0, `destroyed panel was resurrected: ${attached.size}`);
});

// 5. hidePanel cancels a pending (deferred) show.
check('hidePanel cancels a deferred show', () => {
  const id = 'ws-pending';
  bp.showPanel(id); // deferred, no bounds
  bp.hidePanel(id); // cancel
  bp.setBounds(id, { x: 0, y: 0, width: 10, height: 10 });
  assert.strictEqual(attached.size, 0, `hidden panel attached anyway: ${attached.size}`);
  bp.destroyPanel(id);
});

for (const r of results) console.log(r[0].padEnd(5), r[1], r[2] ? `— ${r[2]}` : '');
const failed = results.filter((r) => r[0] === 'FAIL').length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
