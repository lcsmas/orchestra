import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  HTML_CAP,
  TRUNCATION_MARKER,
  STYLE_PROPS,
  CLIP_PADDING,
  SELECTOR_MAX_SEGMENTS,
  trimHtml,
  subsetStyles,
  shapePick,
  clipForBox,
  selectorSegment,
  buildSelectorPath,
  formatPickBlock,
  appendPickToDraft,
  type DesignPick,
  type RawPickedElement,
} from './design-mode.ts';

// --- trimHtml --------------------------------------------------------------

test('trimHtml passes short HTML through untouched', () => {
  const html = '<button class="a">Hi</button>';
  assert.equal(trimHtml(html), html);
});

test('trimHtml cuts at the cap and marks the truncation', () => {
  const html = 'x'.repeat(HTML_CAP + 500);
  const out = trimHtml(html);
  assert.ok(out.endsWith(TRUNCATION_MARKER), 'carries the explicit marker');
  assert.equal(out.slice(0, HTML_CAP), 'x'.repeat(HTML_CAP));
  // The marker must be ADDITIONAL, not part of the budget — a reader must be
  // able to tell the content ended vs was cut.
  assert.equal(out.length, HTML_CAP + TRUNCATION_MARKER.length);
});

test('trimHtml at exactly the cap does not mark truncation', () => {
  const html = 'y'.repeat(HTML_CAP);
  assert.equal(trimHtml(html), html);
  assert.ok(!trimHtml(html).includes(TRUNCATION_MARKER));
});

// --- subsetStyles ----------------------------------------------------------

test('subsetStyles keeps only the documented subset', () => {
  const computed: Record<string, string> = {
    color: 'rgb(0, 0, 0)',
    'background-color': 'rgba(0, 0, 0, 0)',
    'font-size': '14px',
    // Noise that must NOT survive:
    'align-content': 'normal',
    'text-rendering': 'auto',
    zoom: '1',
  };
  const out = subsetStyles(computed);
  assert.equal(out.color, 'rgb(0, 0, 0)');
  assert.equal(out['font-size'], '14px');
  assert.ok(!('align-content' in out));
  assert.ok(!('zoom' in out));
});

test('subsetStyles omits empty/absent values rather than emitting blanks', () => {
  const out = subsetStyles({ color: '', 'font-size': '  ', width: '100px' });
  assert.deepEqual(Object.keys(out), ['width']);
  assert.equal(out.width, '100px');
});

test('subsetStyles trims whitespace around values', () => {
  const out = subsetStyles({ color: '  rgb(1, 2, 3)  ' });
  assert.equal(out.color, 'rgb(1, 2, 3)');
});

test('every STYLE_PROPS entry is actually extractable (no typo in the list)', () => {
  const computed = Object.fromEntries(STYLE_PROPS.map((p) => [p, `v-${p}`]));
  const out = subsetStyles(computed);
  assert.equal(Object.keys(out).length, STYLE_PROPS.length);
  for (const p of STYLE_PROPS) assert.equal(out[p], `v-${p}`);
});

// --- selector segments -----------------------------------------------------

test('selectorSegment prefers a stable id', () => {
  assert.equal(selectorSegment({ tag: 'DIV', id: 'main', classes: ['a', 'b'] }), 'div#main');
});

test('selectorSegment ignores an id that is not a valid bare selector', () => {
  // Numeric-leading ids need escaping; fall back to classes instead of emitting
  // a selector that would throw in querySelector.
  assert.equal(selectorSegment({ tag: 'div', id: '123', classes: ['card'] }), 'div.card');
});

test('selectorSegment uses at most two stable classes', () => {
  assert.equal(
    selectorSegment({ tag: 'span', classes: ['one', 'two', 'three'] }),
    'span.one.two',
  );
});

test('selectorSegment drops hashed framework classes', () => {
  // css-modules / styled-components / emotion churn between renders — a
  // selector built on them is wrong the next time the page paints.
  assert.equal(selectorSegment({ tag: 'div', classes: ['sc-bdVaJa'] }), 'div');
  assert.equal(selectorSegment({ tag: 'div', classes: ['css-1q2w3e'] }), 'div');
  assert.equal(selectorSegment({ tag: 'div', classes: ['Button_root__1a2b3'] }), 'div');
  // ...but keeps a real one sitting beside them.
  assert.equal(selectorSegment({ tag: 'div', classes: ['sc-bdVaJa', 'card'] }), 'div.card');
});

test('selectorSegment drops classes needing CSS escaping', () => {
  assert.equal(selectorSegment({ tag: 'div', classes: ['w-[32px]', 'p-2'] }), 'div.p-2');
});

test('selectorSegment falls back to nth-of-type when nothing identifies it', () => {
  assert.equal(selectorSegment({ tag: 'li', nthOfType: 3 }), 'li:nth-of-type(3)');
  // Index 1 is not disambiguating enough to be worth the noise.
  assert.equal(selectorSegment({ tag: 'li', nthOfType: 1 }), 'li');
});

// --- selector path ---------------------------------------------------------

test('buildSelectorPath joins root-first nodes with >', () => {
  const path = buildSelectorPath([
    { tag: 'body' },
    { tag: 'div', id: 'app' },
    { tag: 'button', classes: ['cta'] },
  ]);
  assert.equal(path, 'body > div#app > button.cta');
});

test('buildSelectorPath keeps the TAIL and marks elision when too deep', () => {
  const nodes = Array.from({ length: SELECTOR_MAX_SEGMENTS + 4 }, (_, i) => ({
    tag: `t${i}`,
  }));
  const path = buildSelectorPath(nodes);
  assert.ok(path.startsWith('… > '), 'marks that the path is relative');
  // The nearest ancestors — the identifying end — are what survive.
  assert.ok(path.endsWith(`t${nodes.length - 1}`));
  assert.equal(path.split(' > ').length, SELECTOR_MAX_SEGMENTS + 1); // +1 for the '…'
  assert.ok(!path.includes('t0'), 'the least specific end is what gets dropped');
});

test('buildSelectorPath on an empty chain is empty, not a stray separator', () => {
  assert.equal(buildSelectorPath([]), '');
});

// --- clipForBox ------------------------------------------------------------

const VIEWPORT = { width: 1000, height: 800 };

test('clipForBox pads the box on all sides', () => {
  const clip = clipForBox({ x: 100, y: 100, width: 50, height: 20 }, VIEWPORT);
  assert.equal(clip.x, 100 - CLIP_PADDING);
  assert.equal(clip.y, 100 - CLIP_PADDING);
  assert.equal(clip.width, 50 + CLIP_PADDING * 2);
  assert.equal(clip.height, 20 + CLIP_PADDING * 2);
  assert.equal(clip.scale, 1);
});

test('clipForBox clamps an origin-hugging element without running off the far edge', () => {
  // An element flush to the top-left (headers, sidebars — very common) would
  // pad to a NEGATIVE origin, which CDP rejects. Clamping the origin alone
  // would leave the width overshooting; the width must shrink to match.
  const clip = clipForBox({ x: 0, y: 0, width: 40, height: 30 }, VIEWPORT);
  assert.equal(clip.x, 0);
  assert.equal(clip.y, 0);
  assert.equal(clip.width, 40 + CLIP_PADDING, 'right pad only');
  assert.equal(clip.height, 30 + CLIP_PADDING, 'bottom pad only');
});

test('clipForBox clamps to the viewport at the far edge', () => {
  const clip = clipForBox({ x: 960, y: 780, width: 40, height: 20 }, VIEWPORT);
  assert.equal(clip.x, 960 - CLIP_PADDING);
  assert.equal(clip.y, 780 - CLIP_PADDING);
  assert.equal(clip.x + clip.width, VIEWPORT.width);
  assert.equal(clip.y + clip.height, VIEWPORT.height);
});

test('clipForBox never returns a zero-size clip', () => {
  // A zero-size element (collapsed/hidden) must still produce a valid clip
  // rather than a rect CDP rejects.
  const clip = clipForBox({ x: 500, y: 400, width: 0, height: 0 }, VIEWPORT, 0);
  assert.ok(clip.width >= 1 && clip.height >= 1);
});

// --- shapePick -------------------------------------------------------------

function rawFixture(over: Partial<RawPickedElement> = {}): RawPickedElement {
  return {
    url: 'https://example.com/pricing',
    title: 'Pricing',
    selector: 'body > main > button.cta',
    outerHTML: '<button class="cta">Buy</button>',
    computed: { color: 'rgb(255, 255, 255)', 'font-size': '16px', zoom: '1' },
    box: { x: 10, y: 20, width: 120, height: 40 },
    ...over,
  };
}

test('shapePick trims, subsets, and carries the screenshot', () => {
  const pick = shapePick('ws-1', rawFixture(), 'BASE64PNG');
  assert.equal(pick.wsId, 'ws-1');
  assert.equal(pick.url, 'https://example.com/pricing');
  assert.equal(pick.html, '<button class="cta">Buy</button>');
  assert.deepEqual(pick.styles, { color: 'rgb(255, 255, 255)', 'font-size': '16px' });
  assert.equal(pick.screenshotBase64, 'BASE64PNG');
});

test('shapePick omits screenshotBase64 entirely when the capture failed', () => {
  // The text half of a pick is useful on its own, so a screenshot failure must
  // degrade the pick rather than abort it — but it must not leave an empty
  // string that the renderer would try to render as an image.
  const pick = shapePick('ws-1', rawFixture());
  assert.ok(!('screenshotBase64' in pick), 'absent, not empty-string');
});

test('shapePick applies the HTML cap', () => {
  const pick = shapePick('ws-1', rawFixture({ outerHTML: 'z'.repeat(HTML_CAP + 10) }));
  assert.ok(pick.html.endsWith(TRUNCATION_MARKER));
});

// --- composer block --------------------------------------------------------

function pickFixture(over: Partial<DesignPick> = {}): DesignPick {
  return {
    wsId: 'ws-1',
    url: 'https://example.com/pricing',
    title: 'Pricing',
    selector: 'body > main > button.cta',
    html: '<button class="cta">Buy</button>',
    styles: { color: 'rgb(255, 255, 255)', 'font-size': '16px' },
    box: { x: 10.4, y: 20.6, width: 120.2, height: 40.8 },
    ...over,
  };
}

test('formatPickBlock renders selector, url, fenced html and fenced css', () => {
  const block = formatPickBlock(pickFixture());
  assert.ok(block.includes('- selector: `body > main > button.cta`'));
  assert.ok(block.includes('- url: https://example.com/pricing'));
  assert.ok(block.includes('```html\n<button class="cta">Buy</button>\n```'));
  assert.ok(block.includes('```css'));
  assert.ok(block.includes('  color: rgb(255, 255, 255);'));
  assert.ok(block.includes('  font-size: 16px;'));
});

test('formatPickBlock rounds the box readout', () => {
  const block = formatPickBlock(pickFixture());
  assert.ok(block.includes('- box: 120×41 at (10, 21)'), block);
});

test('formatPickBlock omits the css fence entirely when no styles survived', () => {
  const block = formatPickBlock(pickFixture({ styles: {} }));
  assert.ok(!block.includes('```css'), 'no empty rule block');
  assert.ok(block.includes('```html'));
});

test('formatPickBlock omits the page line when the title is empty', () => {
  const block = formatPickBlock(pickFixture({ title: '' }));
  assert.ok(!block.includes('- page:'));
});

// --- draft append ----------------------------------------------------------

test('appendPickToDraft preserves the user text and separates with a blank line', () => {
  const out = appendPickToDraft('make this bigger', pickFixture());
  assert.ok(out.startsWith('make this bigger\n\nSelected element'), out.slice(0, 60));
});

test('appendPickToDraft on an empty draft has no leading blank lines', () => {
  const out = appendPickToDraft('', pickFixture());
  assert.ok(out.startsWith('Selected element'));
});

test('appendPickToDraft is stackable — two picks both survive', () => {
  const one = appendPickToDraft('', pickFixture({ selector: 'a.first' }));
  const two = appendPickToDraft(one, pickFixture({ selector: 'b.second' }));
  assert.ok(two.includes('a.first'));
  assert.ok(two.includes('b.second'));
});

test('appendPickToDraft does not accumulate trailing whitespace across picks', () => {
  let draft = '';
  for (let i = 0; i < 3; i++) draft = appendPickToDraft(draft, pickFixture());
  assert.ok(!/\n{3,}/.test(draft), 'no runs of 3+ newlines');
});
