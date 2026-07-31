// Design mode — the pure half of the embedded browser's element picker.
//
// The user arms "design mode" in the browser panel, hovers to highlight, and
// clicks an element; Orchestra then captures that element (HTML, computed
// styles, a cropped screenshot, its selector + page URL) and drops the whole
// bundle into the agent composer as one attachment. That mirrors Orca's
// element-picker: instead of describing "the button in the header is too
// cramped", the user points at it and the agent receives the real markup, the
// real cascade values, and a picture.
//
// This module holds every part of that with NO Electron/CDP dependency, so it
// is unit-testable: the shapes on the wire, the CSS-selector path builder, the
// computed-style subset, the HTML trimmer, and the markdown block the composer
// receives. The Electron side (browser-panel.ts) does the CDP calls and calls
// into here to shape what it got.

/** The properties we lift out of `getComputedStyle`.
 *
 *  A full computed style is ~340 declarations — nearly all of them defaults
 *  that would bury the handful that actually explain what the user is looking
 *  at, and would blow the composer text block up past anything readable. This
 *  subset is the "why does it look like that" set: colour, type, box, border.
 *
 *  Order matters: it is the order the block renders in, grouped by concern
 *  (paint → type → box → border), not alphabetically — a reader scanning the
 *  block wants related values adjacent. */
export const STYLE_PROPS = [
  'color',
  'background-color',
  'font-family',
  'font-size',
  'font-weight',
  'line-height',
  'margin',
  'padding',
  'width',
  'height',
  'border',
  'border-radius',
] as const;

export type StyleProp = (typeof STYLE_PROPS)[number];

/** Max characters of `outerHTML` carried into the composer. A picked element
 *  can be a whole page section; past a few KB the block stops being readable
 *  and starts costing the agent context for no gain. Trimmed HTML is marked
 *  with an explicit truncation marker so neither the user nor the model reads
 *  a cut-off tag as the element's real markup. */
export const HTML_CAP = 4000;

/** Marker appended to `outerHTML` that exceeded {@link HTML_CAP}. Explicit
 *  rather than a bare `…` so the model can tell "the element ends here" from
 *  "this was cut". */
export const TRUNCATION_MARKER = '\n<!-- … truncated by Orchestra design mode … -->';

/** One captured element, as it crosses from main to the renderer. */
export interface DesignPick {
  /** The workspace whose browser panel the pick came from. */
  wsId: string;
  /** Page URL at capture time. */
  url: string;
  /** Page title at capture time (may be empty). */
  title: string;
  /** A CSS-ish selector path locating the element from the document root. */
  selector: string;
  /** `outerHTML`, trimmed to {@link HTML_CAP}. */
  html: string;
  /** The {@link STYLE_PROPS} subset of the element's computed style. Keys
   *  absent from the page's computed style are omitted rather than emitted
   *  empty, so the block never shows `color: ` with nothing after it. */
  styles: Partial<Record<StyleProp, string>>;
  /** The element's viewport box (CSS px), as used for the screenshot clip. */
  box: DesignPickBox;
  /** Base64 PNG of the element, cropped to {@link box } (padded). Absent when
   *  the screenshot failed — the text half of a pick is still useful alone, so
   *  a capture failure degrades rather than aborting the pick. */
  screenshotBase64?: string;
}

export interface DesignPickBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The minimal element description the in-page picker script returns, before
 *  main turns it into a {@link DesignPick}. Kept separate so the shaping
 *  (trim, subset, selector) is testable without a browser. */
export interface RawPickedElement {
  url: string;
  title: string;
  selector: string;
  outerHTML: string;
  /** The FULL computed style as `{prop: value}` — subsetting happens here, not
   *  in the page, so the property list lives in one place (STYLE_PROPS) that
   *  the tests can assert against. */
  computed: Record<string, string>;
  box: DesignPickBox;
}

/** Trim `outerHTML` to {@link HTML_CAP}, marking the cut explicitly.
 *
 *  Deliberately a plain character cut rather than a tag-aware trim: a
 *  half-parsed "smart" truncation invents structure that was never in the page,
 *  which is worse for a model reading it than an obviously-cut string with a
 *  marker saying so. */
export function trimHtml(html: string, cap: number = HTML_CAP): string {
  if (html.length <= cap) return html;
  return html.slice(0, cap) + TRUNCATION_MARKER;
}

/** Pull {@link STYLE_PROPS} out of a full computed-style map.
 *
 *  Omits properties the page didn't report and ones whose value is empty, so
 *  the rendered block only carries values that mean something. */
export function subsetStyles(computed: Record<string, string>): Partial<Record<StyleProp, string>> {
  const out: Partial<Record<StyleProp, string>> = {};
  for (const prop of STYLE_PROPS) {
    const v = computed[prop];
    if (typeof v === 'string' && v.trim() !== '') out[prop] = v.trim();
  }
  return out;
}

/** Turn the raw in-page capture into the wire shape (trim + subset). */
export function shapePick(
  wsId: string,
  raw: RawPickedElement,
  screenshotBase64?: string,
): DesignPick {
  return {
    wsId,
    url: raw.url,
    title: raw.title,
    selector: raw.selector,
    html: trimHtml(raw.outerHTML),
    styles: subsetStyles(raw.computed),
    box: raw.box,
    ...(screenshotBase64 ? { screenshotBase64 } : {}),
  };
}

// ---------------------------------------------------------------------------
// Screenshot clip
// ---------------------------------------------------------------------------

/** Padding (CSS px) added around the element box in the cropped screenshot, so
 *  the shot carries a sliver of context (what it sits on, what it is next to)
 *  rather than a flush-cut rectangle that could be anything. */
export const CLIP_PADDING = 8;

/** Compute the `Page.captureScreenshot` clip rect for an element box.
 *
 *  Pads by {@link CLIP_PADDING}, then clamps to the viewport — CDP rejects a
 *  clip that starts at a negative origin, and an element flush against the top
 *  or left edge (very common: headers, sidebars) produces exactly that once
 *  padded. Clamping the ORIGIN alone is not enough: the width must shrink by
 *  however much the origin moved, or the clip runs off the far edge. */
export function clipForBox(
  box: DesignPickBox,
  viewport: { width: number; height: number },
  padding: number = CLIP_PADDING,
): DesignPickBox & { scale: number } {
  const x = Math.max(0, box.x - padding);
  const y = Math.max(0, box.y - padding);
  // Right/bottom edge of the padded box, clamped to the viewport, then back to
  // a width/height relative to the (already clamped) origin.
  const right = Math.min(viewport.width, box.x + box.width + padding);
  const bottom = Math.min(viewport.height, box.y + box.height + padding);
  return {
    x,
    y,
    width: Math.max(1, right - x),
    height: Math.max(1, bottom - y),
    scale: 1,
  };
}

// ---------------------------------------------------------------------------
// Selector path
// ---------------------------------------------------------------------------

/** A single element's description as the in-page walker reports it, used to
 *  build a selector segment. */
export interface SelectorNode {
  tag: string;
  id?: string;
  classes?: string[];
  /** 1-based index among same-tag siblings; omitted/1 when unambiguous. */
  nthOfType?: number;
}

/** Class names we never put in a selector: framework/utility churn that changes
 *  between renders and would make the selector wrong the moment the page
 *  re-renders. Hash-suffixed CSS-module and styled-components classes are the
 *  common case. */
function isStableClass(cls: string): boolean {
  if (!cls) return false;
  // css-modules: `Button_root__1a2b3`, styled-components: `sc-bdVaJa`,
  // emotion: `css-1q2w3e`. All share a hash-looking trailing segment.
  if (/^(sc|css)-[a-z0-9]{5,}$/i.test(cls)) return false;
  if (/__[a-z0-9]{5,}$/i.test(cls)) return false;
  // Tailwind-ish arbitrary values contain characters that need escaping and
  // add no identifying value in a human-readable path.
  if (/[[\]()#:./%!]/.test(cls)) return false;
  return true;
}

/** Build one selector segment for a node: `tag#id`, `tag.a.b`, or
 *  `tag:nth-of-type(n)` — the most specific STABLE form available. */
export function selectorSegment(node: SelectorNode): string {
  const tag = node.tag.toLowerCase();
  // An id is the strongest anchor; nothing else needs to be appended.
  if (node.id && /^[A-Za-z][\w-]*$/.test(node.id)) return `${tag}#${node.id}`;
  const classes = (node.classes ?? []).filter(isStableClass).slice(0, 2);
  if (classes.length > 0) return `${tag}.${classes.join('.')}`;
  if (node.nthOfType && node.nthOfType > 1) return `${tag}:nth-of-type(${node.nthOfType})`;
  return tag;
}

/** Max segments in a selector path. A deep DOM produces a path so long it
 *  stops communicating "where is this" — the tail (nearest ancestors) is what
 *  identifies the element, so we keep the tail and mark the elision. */
export const SELECTOR_MAX_SEGMENTS = 6;

/** Join a root→element node chain into a readable selector path.
 *
 *  `nodes` is ordered ROOT FIRST (…, body, div, button). Anything past
 *  {@link SELECTOR_MAX_SEGMENTS} is dropped from the FRONT (the least specific
 *  end) and replaced with a leading `… ` so the reader knows the path is
 *  relative, not absolute. */
export function buildSelectorPath(
  nodes: SelectorNode[],
  maxSegments: number = SELECTOR_MAX_SEGMENTS,
): string {
  if (nodes.length === 0) return '';
  const segs = nodes.map(selectorSegment);
  if (segs.length <= maxSegments) return segs.join(' > ');
  return '… > ' + segs.slice(segs.length - maxSegments).join(' > ');
}

// ---------------------------------------------------------------------------
// Composer text block
// ---------------------------------------------------------------------------

/** Render a pick as the fenced text block appended to the composer.
 *
 *  Shape is deliberately model-friendly: a one-line header naming what this is
 *  (so the agent knows the user pointed at something rather than pasted random
 *  markup), then selector/url as plain key lines, then two fenced blocks —
 *  `html` and `css` — that a model reads natively. The cropped screenshot
 *  rides alongside as a real image attachment, not in this text. */
export function formatPickBlock(pick: DesignPick): string {
  const lines: string[] = [];
  lines.push('Selected element from the browser pane (Design Mode):');
  lines.push('');
  lines.push(`- selector: \`${pick.selector}\``);
  lines.push(`- url: ${pick.url}`);
  if (pick.title) lines.push(`- page: ${pick.title}`);
  lines.push(
    `- box: ${Math.round(pick.box.width)}×${Math.round(pick.box.height)} at (${Math.round(pick.box.x)}, ${Math.round(pick.box.y)})`,
  );
  lines.push('');
  lines.push('```html');
  lines.push(pick.html);
  lines.push('```');
  const styleEntries = Object.entries(pick.styles);
  if (styleEntries.length > 0) {
    lines.push('');
    lines.push('```css');
    lines.push(`${pick.selector} {`);
    for (const [prop, value] of styleEntries) lines.push(`  ${prop}: ${value};`);
    lines.push('}');
    lines.push('```');
  }
  return lines.join('\n');
}

/** Append a pick block to whatever draft text the composer already holds,
 *  preserving the user's own text and separating with a blank line. */
export function appendPickToDraft(draft: string, pick: DesignPick): string {
  const block = formatPickBlock(pick);
  const base = draft.trimEnd();
  return base ? `${base}\n\n${block}\n` : `${block}\n`;
}
