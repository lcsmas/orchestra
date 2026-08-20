// Verifies the "background agent steals the screen" + "hidden-panel ops hang"
// fixes without launching Electron.
//
// BUG 1 (focus steal): the agent's `navigate` tool called showPanel(wsId)
// unconditionally. showPanel hides every OTHER visible panel and attaches this
// one — so a BACKGROUND workspace's agent hid the panel the user was looking at
// and composited its own view, at stale bounds, over the active workspace's UI.
// Fix: agents go through revealForAgent(), which only attaches when the
// workspace is the renderer-focused one (the one whose BrowserPanel called
// showPanel and hasn't hidden it since).
//
// BUG 2 (hidden-panel ops): on a non-composited view, capturePage() returns an
// empty 0x0 image (never attached) or HANGS FOREVER (detached after showing) —
// measured on real Electron 33 (see also CDP Page.captureScreenshot and mouse
// input, which hang/queue). capture()/clickAt()/typeText()/scrollBy() now fail
// fast with a clear error instead of hanging the agent's tool call or handing
// it a blank image.
//
// Same loader-hook pattern as verify-archive-browser-panel.mjs.
// Run: node scripts/verify-browser-panel-focus-steal.mjs

import { register } from 'node:module';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert';

const STUB = `
class WebContents {
  constructor() {
    this.destroyed = false;
    this.debugger = { attach(){}, detach(){}, isAttached: () => false, sendCommand: () => Promise.resolve({}) };
    this.navigationHistory = { canGoBack: () => false, canGoForward: () => false };
  }
  isDestroyed() { return this.destroyed; }
  on() {} once() {} setWindowOpenHandler() {}
  loadURL() { return Promise.resolve(); }
  reload() {} close() { this.destroyed = true; }
  getURL() { return ''; } getTitle() { return ''; }
  capturePage() { return Promise.resolve({ toJPEG: () => Buffer.from('jpeg-bytes') }); }
}
export class WebContentsView {
  constructor() { this.webContents = new WebContents(); this.bounds = null; }
  setBounds(b) { this.bounds = b; }
  setBackgroundColor() {}
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
const check = async (name, fn) => {
  try {
    await fn();
    results.push(['PASS', name]);
  } catch (e) {
    results.push(['FAIL', name, e.message]);
  }
};

const ACTIVE = 'ws-active'; // the workspace the user is looking at
const BACKGROUND = 'ws-background'; // a background agent's workspace

// Renderer puts ACTIVE's panel on screen (mount: browserShow + setBounds).
bp.showPanel(ACTIVE);
bp.setBounds(ACTIVE, { x: 10, y: 20, width: 800, height: 600 });
const activeView = [...attached][0];

await check('baseline: the active workspace panel is composited', () => {
  assert.strictEqual(attached.size, 1, `expected 1 attached view, got ${attached.size}`);
});

// Give the BACKGROUND panel bounds history too (the user had its pane open
// earlier) — the precondition that made the steal reachable.
bp.showPanel(BACKGROUND);
bp.setBounds(BACKGROUND, { x: 10, y: 20, width: 700, height: 500 });
// …and the renderer switches back to ACTIVE:
bp.hidePanel(BACKGROUND);
bp.showPanel(ACTIVE);

// THE REGRESSION: a background agent "opening" its panel must not steal the
// composite from the active workspace.
await check('revealForAgent for a BACKGROUND workspace does not attach its view', () => {
  bp.revealForAgent(BACKGROUND);
  assert.strictEqual(attached.size, 1, `expected 1 attached view, got ${attached.size}`);
  assert.ok(attached.has(activeView), 'the ACTIVE workspace view was replaced/hidden');
});

await check('revealForAgent for the FOCUSED workspace is a no-op re-show (still composited)', () => {
  bp.revealForAgent(ACTIVE);
  assert.strictEqual(attached.size, 1, `expected 1 attached view, got ${attached.size}`);
  assert.ok(attached.has(activeView), 'the ACTIVE workspace view went away');
});

// Hidden-panel ops fail FAST with guidance (they used to hang / return blanks).
await check('capture() on a hidden (background) panel rejects with a clear error', async () => {
  await assert.rejects(
    () => bp.capture(BACKGROUND),
    (e) => /not currently composited/.test(e.message),
    'expected a fast, explanatory rejection',
  );
});

await check('clickAt() on a hidden panel rejects instead of dispatching', async () => {
  await assert.rejects(() => bp.clickAt(BACKGROUND, 5, 5), (e) => /not currently composited/.test(e.message));
});

await check('typeText() on a hidden panel rejects instead of dispatching', async () => {
  await assert.rejects(() => bp.typeText(BACKGROUND, 'hi'), (e) => /not currently composited/.test(e.message));
});

await check('scrollBy() on a hidden panel rejects instead of dispatching', async () => {
  await assert.rejects(() => bp.scrollBy(BACKGROUND, 100), (e) => /not currently composited/.test(e.message));
});

// The composited panel keeps full capability.
await check('capture() on the composited panel still works', async () => {
  const b64 = await bp.capture(ACTIVE);
  assert.strictEqual(Buffer.from(b64, 'base64').toString(), 'jpeg-bytes');
});

// When the user SWITCHES to the background workspace (renderer shows it),
// the agent-side reveal becomes effective.
await check('after the renderer focuses the background workspace, its view composites', () => {
  bp.hidePanel(ACTIVE);
  bp.showPanel(BACKGROUND);
  assert.strictEqual(attached.size, 1, `expected 1 attached view, got ${attached.size}`);
  assert.ok(!attached.has(activeView), 'the previous view is still attached');
});

bp.destroyPanel(ACTIVE);
bp.destroyPanel(BACKGROUND);

for (const r of results) console.log(r[0].padEnd(5), r[1], r[2] ? `— ${r[2]}` : '');
const failed = results.filter((r) => r[0] === 'FAIL').length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
