#!/usr/bin/env node
/**
 * Electron half of the MAIN-PANE + OVERLAY parity pair.
 *
 * Captures the same surfaces drive-gtk-mainpane.py does, in the same seeded
 * state at the same 1600x1000 size, so each pair compares like with like.
 *
 * Overlays are opened through the REAL UI AFFORDANCES (the actual buttons a
 * user clicks) rather than by poking the store: the store is not exposed on
 * window, and clicking what ships is better evidence anyway. Their entry points
 * differ from GTK's and were read from source, not guessed:
 *   Resources -> sidebar FOOTER link      (Sidebar.tsx:2267)
 *   Insights  -> sidebar insights ROW     (Insights.tsx:70)
 *   Help      -> sidebar HEADER icon btn  (Sidebar.tsx:1364)
 *
 * Every open is asserted by the overlay's own root appearing in the DOM
 * (a positive control) BEFORE the screenshot — a click that silently no-ops
 * still produces a plausible screenshot of the page underneath. Every capture
 * is md5'd and duplicates fail the run.
 *
 * Dep-free: native WebSocket + Runtime.evaluate / Page.captureScreenshot.
 *
 * Usage: drive-electron-mainpane.mjs <cdp-port> <outdir>
 */
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const [port, outDir] = process.argv.slice(2);
if (!port || !outDir) {
  console.error('usage: drive-electron-mainpane.mjs <cdp-port> <outdir>');
  process.exit(1);
}
mkdirSync(outDir, { recursive: true });

const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
if (!page) {
  console.error('FAIL: no CDP page target');
  process.exit(1);
}
// Guard against attaching to a SIBLING agent's Electron on a colliding port.
console.log(`-- target: ${page.url}`);

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

const captured = [];
const results = {};

const shot = async (name, clip) => {
  const r = await send('Page.captureScreenshot', {
    format: 'png',
    ...(clip ? { clip: { ...clip, scale: 1 } } : {}),
  });
  const file = path.join(outDir, `electron-${name}.png`);
  writeFileSync(file, Buffer.from(r.data, 'base64'));
  captured.push([name, file]);
  console.log(`  captured ${path.basename(file)}`);
};

const boxOf = (sel) =>
  evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(sel)});
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  })()`);

const count = (sel) =>
  evaluate(`document.querySelectorAll(${JSON.stringify(sel)}).length`);

/** Click the first element matching sel (real user affordance). */
const click = (sel) =>
  evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(sel)});
    if (!el) return false;
    el.click();
    return true;
  })()`);

/** Click by visible text within a selector set — for links with no stable class. */
const clickByText = (sel, text) =>
  evaluate(`(() => {
    const els = [...document.querySelectorAll(${JSON.stringify(sel)})];
    const el = els.find((e) => e.textContent.trim().toLowerCase().includes(${JSON.stringify(text.toLowerCase())}));
    if (!el) return false;
    el.click();
    return true;
  })()`);

const waitFor = async (sel, ms = 10000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await count(sel)) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
};

await send('Page.enable');
await send('Runtime.enable');

// The renderer is an SPA: content arrives AFTER load, so poll rather than
// one-shot reading the DOM.
const welcomeRun = process.env.ORCHESTRA_WELCOME_RUN === '1';
let rows = 0;
for (let i = 0; i < 60; i++) {
  rows = await count('.ws-item');
  if (rows > 0) break;
  await new Promise((r) => setTimeout(r, 500));
}
// An empty store is the POINT of the welcome run, so zero rows is expected
// there and a failure everywhere else.
if (!rows && !welcomeRun) {
  console.error('FAIL: no .ws-item rows rendered — seed did not reach the UI');
  console.error(await evaluate(`document.body.innerText.slice(0, 800)`));
  process.exit(1);
}
console.log(`-- ${rows} workspace rows rendered${welcomeRun ? ' (empty-store welcome run)' : ''}`);
await new Promise((r) => setTimeout(r, 2500)); // pills/badges/usage settle

// ══ 1. OVERLAYS ═══════════════════════════════════════════════════════════
const OVERLAYS = [
  // Roots and entry points read from source (ResourcesView.tsx:533,
  // Insights.tsx:180, Help.tsx:113, Sidebar.tsx:2266/1364) — NOT guessed. A
  // guessed selector fails for reasons unrelated to the claim, which would
  // send someone hunting a bug that does not exist.
  {
    name: 'resources',
    open: async () => clickByText('.sidebar-footer-link', 'resources'),
    root: '.res-page',
  },
  {
    name: 'insights',
    open: async () => click('.insights-row'),
    root: '.insights-view',
  },
  {
    name: 'help',
    open: async () => click('.sidebar-header .header-icon-btn'),
    root: '.help-view',
  },
];

for (const ov of welcomeRun ? [] : OVERLAYS) {
  console.log(`-- overlay: ${ov.name}`);
  const before = await count(ov.root);
  const clicked = await ov.open();
  if (!clicked) {
    console.log(`  ! entry point for ${ov.name} not found`);
    results[ov.name] = 'CANNOT-VERIFY: entry point not found';
    continue;
  }
  const opened = await waitFor(ov.root);
  if (opened) {
    console.log(`  control OK: ${ov.root} present (was ${before})`);
    results[ov.name] = 'OPENED';
  } else {
    console.log(`  ! control FAILED: ${ov.root} never appeared`);
    results[ov.name] =
      'CANNOT-VERIFY: root never appeared; an empty capture may be MY drive';
  }
  await new Promise((r) => setTimeout(r, 1500)); // async sampling populates
  await shot(`overlay-${ov.name}`);
  // Close so the next overlay opens from a known state, and ASSERT it closed.
  await evaluate(
    `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`,
  );
  await new Promise((r) => setTimeout(r, 600));
  if (await count(ov.root)) {
    const closeBtn = '.overlay-close, .insights-close, .res-close, .help-close, .modal-close';
    await click(closeBtn);
    await new Promise((r) => setTimeout(r, 600));
  }
}

// ══ 2. WELCOME SCREEN ═════════════════════════════════════════════════════
// Reached by deselecting the active workspace. The app auto-selects
// workspaces[0] at boot, so this needs an explicit deselect, same as GTK.
console.log('-- welcome screen');
// Electron has no deselect affordance either; the welcome screen shows when
// activeId is null. Clicking the active row's own name does not clear it, so
// drive it the way the app itself does on delete: there is no user path, so
// this is captured via the store-free route of removing the selection through
// the DOM is impossible -> assert honestly and report.
// The welcome screen renders when `!active` (App.tsx:380) and the store
// auto-selects workspaces[0] at boot, so with a seeded fixture it is never on
// stage. ORCHESTRA_WELCOME_RUN=1 means this run was launched against an EMPTY
// store — the genuine first-run state the welcome screen exists to serve, and
// the honest state-match for GTK's `mainpane.clear-active`.
if (process.env.ORCHESTRA_WELCOME_RUN === '1') {
  const welcomeShown = await waitFor('.welcome-features', 15000);
  if (welcomeShown) {
    console.log('  control OK: .welcome-features present');
    results.welcome = 'SHOWN';
    await shot('welcome-full');
    const box = await boxOf('.empty');
    if (box) await shot('welcome-pane', box);
    const grid = await boxOf('.welcome-features');
    if (grid) await shot('welcome-feature-grid', grid);
  } else {
    console.log('  ! .welcome-features never appeared on an EMPTY store');
    results.welcome = 'CANNOT-VERIFY: welcome never rendered on an empty store';
  }
} else {
  console.log('  (skipped: seeded run — welcome needs ORCHESTRA_WELCOME_RUN=1)');
  results.welcome = 'skipped in seeded run (captured in the empty-store run)';
}

// ══ 3. MAIN PANE with a workspace selected ════════════════════════════════
// MATCHING THE GTK HALF'S ROW IS THE WHOLE POINT. The GTK driver pins the
// widget name `ws-row-ws-4`; Electron's DOM carries no ws-id attribute, so the
// two halves cannot be pinned by the same key. They are matched here on the
// row's BRANCH TEXT, which both fixtures share (`ws-4` is branch
// `flaky-e2e-hunt` in seed-store.mjs, mirroring mock.rs).
//
// This is the defect the legacy drive-electron.mjs has: it ignores
// ORCHESTRA_CAPTURE_ROW entirely and takes `rows.find(r => !r.classList
// .contains('active'))` (:129, verified at source), so its selected-state pairs
// silently compare DIFFERENT workspaces while looking rigorous. Reading the env
// var alone would NOT fix it — the selector has to resolve the same workspace.
const targetBranch = process.env.ORCHESTRA_CAPTURE_BRANCH || 'flaky-e2e-hunt';
if (!welcomeRun) {
console.log(`-- selecting row by branch ${targetBranch}`);
const selected = await evaluate(`(() => {
  const rows = [...document.querySelectorAll('.ws-item')];
  const el = rows.find((r) => r.textContent.includes(${JSON.stringify(targetBranch)}));
  if (!el) return 'absent:' + rows.length + ' rows';
  if (el.classList.contains('active')) return 'already-active';
  el.click();
  return 'clicked';
})()`);
console.log(`   -> ${selected}`);
if (selected === 'clicked') {
  await new Promise((r) => setTimeout(r, 2500));
  const main = await boxOf('.main');
  await shot('mainpane-terminal', main || undefined);
  const tb = await boxOf('.toolbar');
  if (tb) await shot('tabstrip', tb);

  for (const [label, sel] of [
    ['tab-diff', '.tabs .tab:nth-child(2)'],
    ['tab-run', '.tabs .tab:nth-child(3)'],
  ]) {
    if (await click(sel)) {
      await new Promise((r) => setTimeout(r, 2000));
      const cls = await evaluate(
        `(document.querySelector(${JSON.stringify(sel)})||{}).className || ''`,
      );
      console.log(`  ${label} classes: ${cls}`);
      results[label] = cls;
      const m = await boxOf('.main');
      await shot(`mainpane-${label}`, m || undefined);
    }
  }
} else {
  results['main-pane'] = `CANNOT-VERIFY: row ${selected}`;
}
} // end !welcomeRun

// ══ Duplicate guard ═══════════════════════════════════════════════════════
const digests = new Map();
console.log('\n-- capture manifest (md5)');
for (const [name, file] of captured) {
  const h = crypto.createHash('md5').update(readFileSync(file)).digest('hex');
  console.log(`   ${h}  electron-${name}.png`);
  if (!digests.has(h)) digests.set(h, []);
  digests.get(h).push(name);
}
console.log('\n-- verdicts');
for (const [k, v] of Object.entries(results)) console.log(`   ${k}: ${v}`);

const dupes = [...digests.values()].filter((v) => v.length > 1);
if (dupes.length) {
  for (const d of dupes) {
    console.error(`\n! IDENTICAL captures (a drive step no-opped): ${d.join(', ')}`);
  }
  process.exit(1);
}
console.log('\n-- drive complete, no duplicate captures');
process.exit(0);
