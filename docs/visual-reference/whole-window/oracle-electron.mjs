#!/usr/bin/env node
/**
 * T0 — ELECTRON HALF of the whole-window diff: read the reference from the DOM
 * ORACLE, never from pixels.
 *
 * WHY AN ORACLE AND NOT A SCREENSHOT. Two distinct failure modes are removed:
 *
 *  1. TRANSLUCENCY. A screenshot flattens alpha, so a surface specified at
 *     rgba(...,0.12) over bg reads as some opaque blend, and a correct tint is
 *     indistinguishable from a wrong solid colour. M4 filed a banner at "88.8%
 *     regional dominance" as a defect; alpha was exactly the specified 0.12.
 *     getComputedStyle returns `rgba()` with alpha EXPLICIT, so the reference
 *     half never has to infer it.
 *
 *  2. DATA-PATH DIVERGENCE MASQUERADING AS A RENDERING DEFECT. A pill that
 *     renders differently looks like a port defect in a screenshot. Here we
 *     also dump the row TEXT, so "GTK draws this wrong" and "the two halves
 *     were given different data" are separable. Filing the second as the first
 *     sends someone to fix a renderer that is already correct.
 *
 * WHAT IT EMITS: one JSON document with, per region, the region's element
 * bounds (getBoundingClientRect, device-independent px) and its computed
 * background-color / color, alpha explicit, plus the surface CLASS (fill vs
 * ink) so a reader can weight it. The GTK half is measured in pixels because
 * it has no oracle; this side never guesses.
 *
 * REGIONS are resolved by SELECTOR, and a selector that matches NOTHING is a
 * hard failure, not a silent skip — an absent region is otherwise
 * indistinguishable from a matching one in the final diff, and silence reads
 * as coverage.
 *
 * Usage: oracle-electron.mjs <cdp-port> <out.json>
 */
import { writeFileSync } from 'node:fs';

const [, , port, outPath] = process.argv;
if (!port || !outPath) {
  console.error('usage: oracle-electron.mjs <cdp-port> <out.json>');
  process.exit(1);
}

// ── Region table ────────────────────────────────────────────────────────────
// Selectors READ from src/renderer, not guessed. `class` is the SURFACE CLASS:
// 'fill' = a painted background area (alpha risk lives here), 'ink' = glyph
// colour (opaque both sides, so a dominance figure over it is trustworthy).
// The GTK counterpart for each region is named so the diff can pair them
// without positional guessing.
// SELECTORS WERE VERIFIED AGAINST THE REAL NAMESPACE, NOT GUESSED. The first
// draft of this table guessed `.main-area` and `.status-bar`; NEITHER EXISTS in
// src/renderer (0 hits, against a known-absent control that also returned 0, so
// the zero is meaningful). The real main pane is `.main` (styles.css:1937) and
// Electron HAS NO STATUS BAR — the GTK `status-bar` region in the M5 plan's
// table has no Electron counterpart at all, which is itself a finding rather
// than a colour delta. Guessed identifiers are how M4's inventory produced
// directional false negatives; this table is derived from source both sides.
//
// `.main` sets NO background (styles.css:1937 is layout only), so its painted
// colour comes from an ancestor — which is precisely why effectiveBg() below
// walks up rather than reporting the transparent own-value.
const REGIONS = [
  { id: 'header-strip', sel: '.sidebar-header', gtk: 'sidebar-header', class: 'fill' },
  { id: 'sidebar-body', sel: '.sidebar', gtk: 'sidebar', class: 'fill' },
  { id: 'sidebar-bottom', sel: '.sidebar-footer', gtk: 'sidebar-footer', class: 'fill' },
  { id: 'toolbar', sel: '.toolbar', gtk: 'toolbar', class: 'fill' },
  { id: 'main-pane', sel: '.main', gtk: 'main-area', class: 'fill' },
  { id: 'app-root', sel: '.app', gtk: 'main-window', class: 'fill' },
  { id: 'ws-row', sel: '.ws-item', gtk: 'ws-row-*', class: 'fill' },
  { id: 'ws-name', sel: '.ws-item .ws-name', gtk: 'ws-name', class: 'ink' },
];

const res = await fetch(`http://127.0.0.1:${port}/json`);
const targets = await res.json();
const page = targets.find((t) => t.type === 'page');
if (!page) {
  console.error('no page target on CDP');
  process.exit(1);
}

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((ok, bad) => {
  ws.onopen = ok;
  ws.onerror = () => bad(new Error('CDP websocket failed'));
});

let nextId = 1;
const pending = new Map();
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  const p = pending.get(msg.id);
  if (!p) return;
  pending.delete(msg.id);
  msg.error ? p.bad(new Error(JSON.stringify(msg.error))) : p.ok(msg.result);
};

// Every CDP call is timeout-raced: a call against a window that cannot produce
// frames hangs forever rather than failing, and a hung harness reads as a slow
// one until someone kills it.
const send = (method, params = {}, ms = 20000) => {
  const id = nextId++;
  ws.send(JSON.stringify({ id, method, params }));
  return Promise.race([
    new Promise((ok, bad) => pending.set(id, { ok, bad })),
    new Promise((_, bad) =>
      setTimeout(() => bad(new Error(`${method} timed out after ${ms}ms`)), ms),
    ),
  ]);
};

const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(`eval threw: ${JSON.stringify(r.exceptionDetails)}`);
  return r.result.value;
};

await send('Page.enable');
await send('Runtime.enable');

// The renderer is an SPA — content arrives AFTER load. One-shot reading the DOM
// at did-finish-load yields an empty page that measures "successfully".
let rows = 0;
for (let i = 0; i < 60; i++) {
  rows = await evaluate(`document.querySelectorAll('.ws-item').length`);
  if (rows > 0) break;
  await new Promise((r) => setTimeout(r, 500));
}
if (!rows) {
  console.error('FAIL: no .ws-item rows rendered — the seed never reached the UI');
  console.error(await evaluate(`document.body.innerText.slice(0,800)`));
  process.exit(1);
}
console.log(`-- ${rows} workspace rows rendered`);
await new Promise((r) => setTimeout(r, 1500)); // async badge/pill work

// ── The achieved viewport, asserted rather than assumed ─────────────────────
// Setting geometry is not holding it. The consumer compares this against the
// GTK side's achieved size and refuses to diff a mismatched pair.
const viewport = await evaluate(
  `({ w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio })`,
);
console.log(`-- achieved viewport ${viewport.w}x${viewport.h} @dpr ${viewport.dpr}`);

// ── Read each region from the oracle ────────────────────────────────────────
const readRegion = (sel) =>
  evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(sel)});
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return {
      bounds: { x: r.x, y: r.y, w: r.width, h: r.height },
      backgroundColor: cs.backgroundColor,
      color: cs.color,
      fontSize: cs.fontSize,
      fontWeight: cs.fontWeight,
      fontFamily: cs.fontFamily,
      borderTopWidth: cs.borderTopWidth,
      borderBottomWidth: cs.borderBottomWidth,
      opacity: cs.opacity,
      text: (el.innerText || '').slice(0, 120),
    };
  })()`);

/**
 * Resolve what a region ACTUALLY paints, walking up to the nearest painting
 * ancestor when the element itself is transparent — the oracle-side equivalent
 * of "snapshot an ancestor that paints an opaque background".
 *
 * READING background-color ALONE IS THE TRAP THIS FUNCTION EXISTS TO AVOID, and
 * the first version of it shipped exactly that bug. `.sidebar` (styles.css:513)
 * and `.toolbar` (styles.css:1938) paint via `background: linear-gradient(...)`
 * with NO background-color at all. getComputedStyle().backgroundColor therefore
 * returns rgba(0,0,0,0) for both — indistinguishable from a genuinely
 * transparent element — so the walk climbed past them to the root and reported
 * every region as the SAME rgb(11,13,16). That is a clean, specific, WRONG
 * reference: it would have told five agents the toolbar is the root colour and
 * that the main pane matches, inverting the known ground truth.
 *
 * COULD THIS BE EXPRESSED ANOTHER WAY? — the question that catches this class.
 * A paint can be a colour OR a gradient OR an image, so all three are checked
 * before an element is declared non-painting. Gradient stops are returned
 * verbatim (and the first stop resolved for comparison) rather than averaged:
 * the GTK side may legitimately implement a gradient as a flat fill, and that
 * IS the finding — flattening it here would hide it.
 */
const effectiveBg = (sel) =>
  evaluate(`(() => {
    const alphaOf = (c) => {
      const m = String(c).match(/rgba?\\(([^)]+)\\)/);
      if (!m) return 0;
      const p = m[1].split(',').map(s => parseFloat(s.trim()));
      return p.length === 4 ? p[3] : 1;
    };
    let el = document.querySelector(${JSON.stringify(sel)});
    if (!el) return null;
    const ownCs = getComputedStyle(el);
    const own = ownCs.backgroundColor;
    const ownImg = ownCs.backgroundImage;
    // WHICH STATE IS THIS ELEMENT IN? A rule can be perfectly correct and
    // still be the wrong REFERENCE: .ws-item paints nothing at rest and only
    // :hover/.active paint it, so an oracle reading of a SELECTED row compared
    // against a RESTING GTK row is a state mismatch wearing the costume of a
    // colour defect. Reported so diff-report.py can refuse the pair rather
    // than emit a precise, actionable, wrong delta.
    const stateAtCapture =
      el.matches(':hover') ? 'hover'
      : (el.classList.contains('active') || el.classList.contains('selected')) ? 'active'
      : el.matches(':focus-within') ? 'focus'
      : 'rest';
    let node = el, hops = 0;
    while (node) {
      const cs = getComputedStyle(node);
      const bg = cs.backgroundColor;
      const img = cs.backgroundImage;
      // A gradient/image paint is a paint, even with a transparent bg-color.
      if (img && img !== 'none') {
        const stops = [...img.matchAll(/rgba?\\([^)]+\\)/g)].map(m => m[0]);
        return {
          own, ownImage: ownImg, painted: stops[0] || bg,
          alpha: stops.length ? alphaOf(stops[0]) : alphaOf(bg),
          paintKind: 'gradient', gradientStops: stops, gradient: img,
          from: node === el ? 'self' : (node.className || node.tagName), hops,
          stateAtCapture,
        };
      }
      if (alphaOf(bg) > 0) {
        return {
          own, ownImage: ownImg, painted: bg, alpha: alphaOf(bg),
          paintKind: 'color', gradientStops: null, gradient: null,
          from: node === el ? 'self' : (node.className || node.tagName), hops,
          stateAtCapture,
        };
      }
      node = node.parentElement; hops++;
    }
    return { own, ownImage: ownImg, painted: null, alpha: 0,
             paintKind: 'none', gradientStops: null, gradient: null,
             from: 'none', hops, stateAtCapture };
  })()`);

const out = { viewport, rows, regions: {} };
const missing = [];
for (const r of REGIONS) {
  const data = await readRegion(r.sel);
  if (!data) {
    missing.push(`${r.id} (${r.sel})`);
    continue;
  }
  out.regions[r.id] = {
    ...data,
    selector: r.sel,
    gtkWidget: r.gtk,
    surfaceClass: r.class,
    effectiveBg: await effectiveBg(r.sel),
  };
  const eb = out.regions[r.id].effectiveBg;
  const kind = eb.paintKind === 'gradient'
    ? `GRADIENT(${eb.gradientStops.length} stops)`
    : eb.paintKind;
  console.log(
    `   ${r.id.padEnd(16)} ${String(eb.painted).padEnd(24)} a=${eb.alpha}` +
      ` ${kind} from=${eb.from} [${r.class}]` +
      ` ${Math.round(data.bounds.w)}x${Math.round(data.bounds.h)}`,
  );
}

// An unmatched selector is a HARD failure. If it were skipped, the region would
// simply be absent from the diff — and an absent region looks exactly like a
// matching one to anyone reading the ranked output.
if (missing.length) {
  console.error(`FAIL: ${missing.length} region selector(s) matched nothing:`);
  for (const m of missing) console.error(`   - ${m}`);
  console.error('A region that cannot be read must not be silently dropped.');
  writeFileSync(outPath, JSON.stringify({ ...out, missing }, null, 2));
  process.exit(1);
}

writeFileSync(outPath, JSON.stringify(out, null, 2));
console.log(`-- oracle written to ${outPath} (${Object.keys(out.regions).length} regions)`);
process.exit(0);
