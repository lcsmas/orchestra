// The native child window of an opener-dependent popup (#396 fix round, ledger #405 F1/F2) — PURE: no Electron, no fs.
//
// Electron builds a popup's window options as `{ show:true, width:800, height:600, ...parseFeatures(<the PAGE's features string>), ...ours }`, so every
// option we do not name comes from the page: `alwaysOnTop,frame=no,transparent,fullscreen,kiosk,modal,closable=no,focusable=no,width=4000` would give a
// hostile page a screen-covering, frameless, un-closable window. `routePopup` therefore answers the window-open handler with `createWindow`, and the factory
// builds the window from THIS allowlist: nothing the page said survives except a clamped size (and the real guest `webContents` Electron hands over).

/** Size of a popup that asked for none (or for junk). */
export const POPUP_WINDOW_DEFAULT = { width: 480, height: 520 } as const;
/** Smallest window we will make (a 1x1 window is a clickjacking pixel, not a sign-in). */
export const POPUP_WINDOW_MIN = { width: 200, height: 150 } as const;
/** Hard ceiling when the parent's size is unknown. */
export const POPUP_WINDOW_MAX = 8192;
/** A popup never covers more than this share of its parent window per axis. */
export const POPUP_WINDOW_PARENT_SHARE = 0.9;

/** The ONLY web preferences a popup keeps (Electron ignores them for an existing guest, which inherits the opener's secure defaults — pinned anyway). */
export const POPUP_WEB_PREFERENCES = Object.freeze({ sandbox: true, contextIsolation: true, nodeIntegration: false });

export interface ParentSize {
  width: number;
  height: number;
}

const own = (o: object, k: string): unknown => (Object.prototype.hasOwnProperty.call(o, k) ? (o as Record<string, unknown>)[k] : undefined);

/** A finite page-supplied number as an integer; anything else (NaN from `width=abc`, a string, Infinity, absent) is `undefined`. */
function int(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : undefined;
}

function clampSize(v: unknown, dflt: number, min: number, parentMax: number | undefined): number {
  const asked = int(v);
  const max = Math.min(POPUP_WINDOW_MAX, parentMax === undefined ? POPUP_WINDOW_MAX : Math.max(min, Math.floor(parentMax * POPUP_WINDOW_PARENT_SHARE)));
  return Math.min(max, Math.max(min, asked !== undefined && asked > 0 ? asked : dflt));
}

/**
 * The options for `new BrowserWindow(...)` of a popup child window, from Electron's merged options (`given`: the real guest `webContents` plus whatever the
 * page's features string produced) — an ALLOWLIST: `webContents` (only when it is an object: a page can smuggle `webContents=x` as a string), a clamped
 * `width`/`height`, and our own fixed `parent`, `show:false` (shown by the caller only when its workspace is on screen), `resizable:false` (a resizable child is
 * TILED by sway, halving the app), `autoHideMenuBar` and `webPreferences`. No position (the window manager places it), no frame / transparency / z-order / fullscreen /
 * modal / closable / focusable key: they take their safe defaults by being absent.
 */
export function buildChildWindowOptions(given: object, ctx: { parent: unknown; parentSize?: ParentSize }): Record<string, unknown> {
  const wc = own(given, 'webContents');
  const ps = ctx.parentSize;
  return {
    ...(typeof wc === 'object' && wc !== null ? { webContents: wc } : {}),
    parent: ctx.parent,
    show: false,
    width: clampSize(own(given, 'width'), POPUP_WINDOW_DEFAULT.width, POPUP_WINDOW_MIN.width, ps && int(ps.width)),
    height: clampSize(own(given, 'height'), POPUP_WINDOW_DEFAULT.height, POPUP_WINDOW_MIN.height, ps && int(ps.height)),
    autoHideMenuBar: true,
    resizable: false,
    webPreferences: { ...POPUP_WEB_PREFERENCES },
  };
}

/** Does a `window.open` features string carry a `webContents` key? Electron spreads it over the real guest handle (`{ webContents: guest, ...pageOptions }`), so the
 *  factory would receive a string and the window could not be built: such a popup is refused outright. Electron's parser: split on `,`, key = text before the first `=`, trimmed, case-sensitive. */
export function featuresSmuggleWebContents(features: string): boolean {
  return features.split(',').some((item) => item.split('=')[0].trim() === 'webContents');
}

const TITLE_MAX = 80;
// control characters, and the bidi override / isolate marks a title could use to visually reorder the origin shown before it
const TITLE_STRIP = /[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g;

/** What the origin looks like to the user: `https://accounts.example`, `about:blank` for a blank page, `unknown origin` for anything unparseable. */
export function popupOrigin(url: string): string {
  const u = url.trim();
  if (u === '' || /^about:blank$/i.test(u)) return 'about:blank';
  try {
    const parsed = new URL(u);
    return parsed.origin !== 'null' ? parsed.origin : 'unknown origin';
  } catch {
    return 'unknown origin';
  }
}

/** The child window's title: the page's origin FIRST (a frameless-looking or spoofed page title cannot push it out), then the page's own title, sanitised and cut. */
export function popupWindowTitle(url: string, pageTitle: string): string {
  const origin = popupOrigin(url);
  const title = pageTitle.replace(TITLE_STRIP, '').replace(/\s+/g, ' ').trim().slice(0, TITLE_MAX);
  return title ? `${origin} — ${title}` : origin;
}
