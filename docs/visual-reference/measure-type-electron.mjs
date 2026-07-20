#!/usr/bin/env node
/**
 * T2 — measure the RENDERED type of every text role in the Electron frontend.
 *
 * Electron has a DOM oracle, so this reads `getComputedStyle` rather than
 * inferring anything from pixels: fontFamily, fontSize, fontWeight and
 * letterSpacing come back fully resolved, with every var() chain and cascade
 * already applied. That is the reference half of the T2 pair.
 *
 * TWO THINGS THIS DELIBERATELY REPORTS SEPARATELY:
 *
 *  1. `fontFamily` is the DECLARED STACK, not the face that rendered. Chromium
 *     resolves the first INSTALLED family at paint time and getComputedStyle
 *     still echoes the whole list — so a stack naming Inter reports Inter even
 *     on a machine with no Inter installed. Comparing that string against the
 *     GTK side's single resolved family would compare a request to a result.
 *     `document.fonts.check()` is queried per family to find which one actually
 *     resolves, and BOTH are emitted.
 *  2. Elements are grouped by their class signature, and the count plus a text
 *     sample rides along, so a reader can tell which role a row describes
 *     without trusting this script's naming.
 *
 * Usage: measure-type-electron.mjs <cdp-port> <out.json>
 */
import { writeFileSync } from 'node:fs';

const [, , port, outPath] = process.argv;
if (!port || !outPath) {
  console.error('usage: measure-type-electron.mjs <cdp-port> <out.json>');
  process.exit(1);
}

const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page = targets.find((t) => t.type === 'page');
if (!page) {
  console.error('no page target on CDP');
  process.exit(1);
}

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((ok, bad) => {
  ws.onopen = ok;
  ws.onerror = bad;
});

let nextId = 1;
const pending = new Map();
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(JSON.stringify(msg.error)));
    else resolve(msg.result);
  }
};
const send = (method, params) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });

const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (r.exceptionDetails) {
    throw new Error(`evaluate threw: ${JSON.stringify(r.exceptionDetails)}`);
  }
  return r.result.value;
};

// Wait for the app to actually render rows — a measurement taken against an
// empty SPA shell would report a handful of chrome elements and look like a
// clean, small result set rather than a premature read.
await evaluate(`new Promise((ok) => {
  const done = () => document.querySelectorAll('.ws-item').length > 0;
  if (done()) return ok(true);
  const mo = new MutationObserver(() => { if (done()) { mo.disconnect(); ok(true); } });
  mo.observe(document.body, { childList: true, subtree: true });
  setTimeout(() => ok(false), 15000);
})`);

const payload = await evaluate(`(() => {
  const out = [];
  const els = document.querySelectorAll('*');
  for (const el of els) {
    // Only elements with their OWN text — a wrapper inherits type it does not
    // set, and counting it would inflate every role it contains.
    const own = Array.from(el.childNodes)
      .filter((n) => n.nodeType === 3)
      .map((n) => n.textContent.trim())
      .join(' ')
      .trim();
    if (!own) continue;
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    out.push({
      tag: el.tagName.toLowerCase(),
      classes: Array.from(el.classList),
      text: own.slice(0, 40),
      fontFamily: cs.fontFamily,
      fontSize: cs.fontSize,
      fontWeight: cs.fontWeight,
      fontStyle: cs.fontStyle,
      letterSpacing: cs.letterSpacing,
      lineHeight: cs.lineHeight,
      textTransform: cs.textTransform,
      rendered: r.width > 0 && r.height > 0,
    });
  }

  // Which family in the body stack ACTUALLY paints? This is the
  // request-vs-result distinction the GTK side resolves to one family.
  //
  // NOT document.fonts.check(): it returns true for EVERY specifier, absent
  // families included, because fallback always renders something. Measured
  // here it returned true for all ten families on a box with none of the
  // first nine installed — a check that cannot fail is not evidence.
  //
  // Differential advance width does discriminate. A family whose width equals
  // the deliberately-absent baseline is itself falling back; one that differs
  // is genuinely installed. The absent family is negative control and
  // baseline at once.
  const stack = getComputedStyle(document.body).fontFamily
    .split(',')
    .map((s) => s.trim().replace(/^["']|["']$/g, ''));
  const c = document.createElement('canvas').getContext('2d');
  const SAMPLE = 'Handgloves 0123456789 workspace ORCHESTRA';
  const widthOf = (spec) => {
    c.font = '13px ' + spec;
    return c.measureText(SAMPLE).width;
  };
  const fallbackBaseline = widthOf('"ZzNoSuchFamily12345"');
  const availability = stack.map((f) => {
    const w = widthOf('"' + f + '"');
    return {
      family: f,
      width: Math.round(w * 100) / 100,
      // check() is recorded only to document that it does NOT discriminate.
      check12_unreliable: document.fonts.check('12px "' + f + '"'),
      installed: Math.abs(w - fallbackBaseline) > 0.01,
    };
  });
  const resolvedFamily =
    availability.find((a) => a.installed)?.family ?? '(all fell back)';

  return {
    controls: {
      elements_scanned: els.length,
      text_elements: out.length,
      ws_items: document.querySelectorAll('.ws-item').length,
    },
    bodyStack: stack,
    bodyStackAvailability: availability,
    fallbackBaseline: Math.round(fallbackBaseline * 100) / 100,
    resolvedBodyFamily: resolvedFamily,
    elements: out,
  };
})()`);

// --- POSITIVE CONTROL -------------------------------------------------------
// A zero-row read means the SPA had not rendered; every "role absent" below
// would then be an artifact of sampling too early.
if (!payload || payload.controls.ws_items === 0) {
  console.error(
    `INSTRUMENT FAILURE: 0 .ws-item rows rendered ` +
      `(${payload?.controls?.text_elements ?? 0} text elements). Refusing to emit.`,
  );
  process.exit(1);
}

writeFileSync(outPath, JSON.stringify(payload, null, 2));
console.log(
  `measured ${payload.controls.text_elements} text elements ` +
    `(${payload.controls.ws_items} rows) -> ${outPath}`,
);
ws.close();
