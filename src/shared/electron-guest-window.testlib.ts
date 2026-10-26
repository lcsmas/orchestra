// Test support (not a test: the runner only picks up *.test.ts) — a replica of Electron 33.4.11's `parseFeatures` and of the options merge in `openGuestWindow`
// (both read from the shipped binary), so the popup tests feed the window factory exactly what Electron hands a `createWindow` factory.

const NUMERIC = new Set(['top', 'left', 'x', 'y', 'width', 'height', 'minWidth', 'maxWidth', 'minHeight', 'maxHeight', 'opacity']);
const WEBPREF_KEYS = ['zoomFactor', 'nodeIntegration', 'javascript', 'contextIsolation', 'webviewTag'];

function coerce(k: string, v: string | undefined): unknown {
  if (NUMERIC.has(k)) return parseInt(v as string, 10);
  switch (v) {
    case 'true': case '1': case 'yes': case undefined: return true;
    case 'false': case '0': case 'no': return false;
    default: return v;
  }
}

/** Electron's parse of a `window.open` features string: comma-separated, key before the first `=`, trimmed, case-sensitive; the web-preference keys are split off (and dropped by `openGuestWindow`). */
export function parseFeatures(features: string): Record<string, unknown> {
  const t: Record<string, unknown> = {};
  for (const item of features.split(',')) {
    const [k, v] = item.split('=').map((x) => x.trim());
    if (k) t[k] = coerce(k, v);
  }
  for (const k of WEBPREF_KEYS) if (t[k] !== undefined) delete t[k];
  if (t.left !== undefined) t.x = t.left;
  if (t.top !== undefined) t.y = t.top;
  return t;
}

/** What `createWindow` receives: `{ webContents: guest, ...{ show:true, width:800, height:600, ...parsed(features), ...overrideBrowserWindowOptions } }`. */
export function electronMerge(guest: unknown, features: string, override: object = {}): Record<string, unknown> {
  return { webContents: guest, ...{ show: true, width: 800, height: 600, ...parseFeatures(features), ...override } };
}
