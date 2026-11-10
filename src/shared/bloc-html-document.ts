/**
 * The document a Bloc HTML frame loads (ADR 0011, ledger #423 FI-3). Pure: a string in, a string out.
 * Order is the contract: policy `<meta>` FIRST in `<head>`, then the theme, then the model's HTML.
 * NO `color-scheme` (measured: Chromium then paints the frame opaque) — see prototype/bloc-html.
 */

/** Policy v2 (ADR 0011, D5): inline script/style + `https:` (script, style, img, font, fetch/XHR, `wss:`) + `data:`/`blob:`; plain `http:`, frames, forms, `<base>` refused. */
export const BLOC_HTML_POLICY =
  "default-src 'none'; script-src 'unsafe-inline' https: blob:; style-src 'unsafe-inline' https:; img-src https: data: blob:; font-src https: data:; connect-src https: wss: data: blob:; base-uri 'none'; form-action 'none'";

/** The custom properties a bloc may use (`var(--bloc-fg)`, …) — what the model's instruction (#418) names. */
export const BLOC_THEME_KEYS = ['fg', 'muted', 'surface', 'border', 'accent', 'ok', 'warn', 'err'] as const;
export type BlocThemeKey = (typeof BLOC_THEME_KEYS)[number];

export type BlocTokens = Partial<Record<BlocThemeKey, string>> & { fontSize?: string; fontFamily?: string; lineHeight?: string };

/** The tag of the one message a frame sends its parent: `{ __blocHtml: 1, h: <px> }`. */
export const BLOC_HEIGHT_TAG = '__blocHtml';
/** The parent clamps a reported height to [0, this]. */
export const BLOC_MAX_HEIGHT_PX = 20000;

/** A token value comes from the app's computed style; refuse anything that could leave the declaration. */
export function safeCssValue(v: string | undefined, fallback: string): string {
  const s = (v ?? '').trim();
  return s !== '' && s.length <= 200 && !/[;{}<>\\]/.test(s) ? s : fallback;
}

function themeCss(t: BlocTokens): string {
  const vars = BLOC_THEME_KEYS.map((k) => `--bloc-${k}:${safeCssValue(t[k], 'inherit')};`).join('');
  const size = safeCssValue(t.fontSize, '13px');
  const lh = safeCssValue(t.lineHeight, '1.55');
  const family = safeCssValue(t.fontFamily, 'system-ui,sans-serif');
  // The frame is opaque to its parent: `overflow:hidden` because it is sized to its content and must never scroll on its own.
  return `:root{${vars}}html{overflow:hidden}html,body{margin:0;background:transparent;color:var(--bloc-fg);font:${size}/${lh} ${family}}`;
}

/** The frame's only way to tell the parent its height (the parent accepts it from this frame alone, and clamps). */
const HEIGHT_REPORTER =
  `<script>(function(){function s(){parent.postMessage({${BLOC_HEIGHT_TAG}:1,h:Math.ceil(document.documentElement.getBoundingClientRect().height)},'*')}` +
  `new ResizeObserver(s).observe(document.documentElement);s()})()</script>`;

export function buildBlocDocument(input: { source: string; tokens: BlocTokens }): string {
  return (
    `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${BLOC_HTML_POLICY}">` +
    `<style>${themeCss(input.tokens)}</style>${HEIGHT_REPORTER}</head><body>${input.source}</body></html>`
  );
}
