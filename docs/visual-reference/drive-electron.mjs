#!/usr/bin/env node
/**
 * CDP driver for the Electron half of the visual reference pair (M4-V0).
 *
 * Dep-free: native WebSocket + Runtime.evaluate / Page.captureScreenshot.
 * Captures one full-window PNG per surface plus element-clipped crops of the
 * sidebar and the toolbar, so a V-agent can diff a region without cropping by
 * hand.
 *
 * Selectors below were READ from src/renderer (App.tsx / Sidebar.tsx /
 * Dialog.tsx), not guessed — `.ws-item` is the row class (there is no
 * `.ws-row`), `.dialog-backdrop` is the dialog root.
 *
 * Usage: drive-electron.mjs <cdp-port> <outdir>
 */
import { writeFileSync } from 'node:fs';
import path from 'node:path';

const [, , port, outDir] = process.argv;
if (!port || !outDir) {
  console.error('usage: drive-electron.mjs <cdp-port> <outdir>');
  process.exit(1);
}

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

/** Every CDP call is timeout-raced: a screenshot on a window that cannot
 *  produce frames hangs forever rather than failing. */
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
  const r = await send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (r.exceptionDetails) {
    throw new Error(`eval threw: ${JSON.stringify(r.exceptionDetails)}`);
  }
  return r.result.value;
};

const shot = async (name, clip) => {
  const r = await send('Page.captureScreenshot', {
    format: 'png',
    ...(clip ? { clip: { ...clip, scale: 1 } } : {}),
  });
  const file = path.join(outDir, `electron-${name}.png`);
  writeFileSync(file, Buffer.from(r.data, 'base64'));
  console.log(`  captured ${path.basename(file)}`);
};

/** Bounding box of a selector, for a clipped (region) capture. */
const boxOf = (sel) =>
  evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(sel)});
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  })()`);

await send('Page.enable');
await send('Runtime.enable');

// The renderer is an SPA: content arrives AFTER load, so poll for the seeded
// rows rather than one-shot reading the DOM.
let rows = 0;
for (let i = 0; i < 60; i++) {
  rows = await evaluate(`document.querySelectorAll('.ws-item').length`);
  if (rows > 0) break;
  await new Promise((r) => setTimeout(r, 500));
}
if (!rows) {
  console.error('FAIL: no .ws-item rows rendered — seed did not reach the UI');
  const body = await evaluate(`document.body.innerText.slice(0, 800)`);
  console.error(body);
  process.exit(1);
}
console.log(`-- ${rows} workspace rows rendered`);
// Let pill/badge async work (PR lookups, sizes, usage) settle before pixels.
await new Promise((r) => setTimeout(r, 2500));

// ── Surface 1: full window (default view, no workspace selected) ───────────
await shot('full-window');

// ── Surface 2: sidebar region ─────────────────────────────────────────────
const sidebar = await boxOf('.sidebar');
if (sidebar) await shot('sidebar', sidebar);
else console.warn('  ! .sidebar not found — skipping sidebar crop');

// ── Surface 3: main pane with a workspace selected (toolbar + terminal) ────
// Click a row that is NOT already active. The app boots with the first row
// selected, so clicking `.ws-item[0]` is a no-op that yields a screenshot
// byte-identical to the full-window one — a capture that silently proves
// nothing. Pick the first INACTIVE row and assert the selection moved.
const selected = await evaluate(`(() => {
  const rows = [...document.querySelectorAll('.ws-item')];
  const target = rows.find((r) => !r.classList.contains('active'));
  if (!target) return null;
  const name = target.textContent.trim().slice(0, 40);
  target.click();
  return name;
})()`);
if (!selected) {
  console.error('FAIL: no inactive .ws-item to select');
  process.exit(1);
}
await new Promise((r) => setTimeout(r, 2000));
const activeNow = await evaluate(
  `(document.querySelector('.ws-item.active') || {}).textContent?.trim().slice(0, 40) ?? ''`,
);
if (!activeNow) {
  console.error('FAIL: selection did not move — .ws-item.active is empty');
  process.exit(1);
}
console.log(`-- selected row: ${activeNow}`);
await shot('workspace-selected');

const main = await boxOf('.main');
if (main) await shot('main-pane', main);
const toolbar = await boxOf('.toolbar');
if (toolbar) await shot('toolbar', toolbar);
else console.warn('  ! .toolbar not found — skipping toolbar crop');

// ── Surface 4: archived section expanded (multi-select chrome) ─────────────
// Assert the list actually expanded — a toggle click that silently no-ops
// would otherwise produce a duplicate of the plain sidebar capture.
await evaluate(`(() => {
  const t = document.querySelector('.archived-toggle');
  if (t) t.click();
  return !!t;
})()`);
let archivedRows = 0;
for (let i = 0; i < 20; i++) {
  archivedRows = await evaluate(
    `document.querySelectorAll('.archived-list .ws-item.archived').length`,
  );
  if (archivedRows > 0) break;
  await new Promise((r) => setTimeout(r, 250));
}
if (!archivedRows) {
  console.error('FAIL: archived section never expanded (no .ws-item.archived)');
  process.exit(1);
}
console.log(`-- archived expanded: ${archivedRows} rows`);
const sbArch = await boxOf('.sidebar');
if (sbArch) await shot('sidebar-selected', sbArch);

// ── Surface 5: a dialog ────────────────────────────────────────────────────
// Real user path: with the archived section open, tick "select all" and press
// the bulk-delete button — Sidebar.tsx's onDeleteSelectedArchived raises a
// `dialog.confirm`, so the captured chrome is the genuine Dialog component
// rather than a hand-built div. (`.del` is the diff-count span, NOT a delete
// button — a tempting but wrong selector.)
const dialogShown = await evaluate(`(() => {
  const check = document.querySelector('.archived-bar .archived-check input');
  if (!check) return false;
  check.click();
  return true;
})()`);
if (dialogShown) {
  await new Promise((r) => setTimeout(r, 500));
  await evaluate(`(() => {
    const b = document.querySelector('.archived-bar-delete');
    if (b) b.click();
    return !!b;
  })()`);
}
if (dialogShown) {
  let seen = false;
  for (let i = 0; i < 20; i++) {
    seen = await evaluate(`!!document.querySelector('.dialog-backdrop')`);
    if (seen) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  if (seen) {
    await new Promise((r) => setTimeout(r, 400));
    await shot('dialog');
  } else {
    console.warn('  ! delete button did not raise a .dialog-backdrop');
  }
} else {
  console.warn('  ! no .ws-item .del button found — skipping dialog surface');
}

// Guard against no-op drives: a click that silently fails yields a screenshot
// byte-identical to the previous surface, which LOOKS like a successful capture
// but proves nothing. Fail loudly instead.
const { createHash } = await import('node:crypto');
const { readdirSync, readFileSync } = await import('node:fs');
const digests = new Map();
for (const f of readdirSync(outDir).sort()) {
  if (!f.startsWith('electron-') || !f.endsWith('.png')) continue;
  const d = createHash('md5').update(readFileSync(path.join(outDir, f))).digest('hex');
  digests.set(d, [...(digests.get(d) ?? []), f]);
}
let dupeFound = false;
for (const files of digests.values()) {
  if (files.length > 1) {
    console.error(`  ! IDENTICAL captures (a drive step no-opped): ${files.join(', ')}`);
    dupeFound = true;
  }
}
if (dupeFound) process.exit(1);

console.log('-- electron capture complete');
ws.close();
process.exit(0);
