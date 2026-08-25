#!/usr/bin/env node
// Resources-page evidence rig for the disk-space guard (issue #87).
//
// WHAT IT PROVES, AND WHY TWO ARMS. One screenshot cannot distinguish "renders
// the warning" from "always renders the warning". So this renders the REAL
// FreeSpaceSection component TWICE — same component, same stylesheet, same
// browser, differing ONLY in the volumes handed to it — and captures both:
//
//   arm `warn`   — one healthy volume + one tmpfs at 0 bytes free
//   arm `normal` — the same two volumes, both healthy
//
// It asserts the DOM difference AND writes two PNGs. It also runs a NEGATIVE
// arm on itself: the `normal` capture must NOT contain the warning chrome. A
// rig whose every arm passes is the tell that it is measuring nothing.
//
// DISPLAY CONTAINMENT follows ~/.claude/skills/headless-sway-e2e: this rig
// launches its OWN sway, identifies its display by an ACTIVE PID-DERIVED
// MARKER (never a socket diff, never #FF00FF — measured 2026-08-25, two
// sibling rigs both read 100% magenta), aborts if two sockets match, refuses
// wayland-1 explicitly BEFORE the equality check, and builds the child env as
// an ALLOWLIST (`env -i`), never a spread.
//
// Usage: node scripts/verify-disk-guard-ui.mjs [--outdir <dir>]
// Exit: 0 = both arms captured and every claim held.

import { execFileSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require_ = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argOut = process.argv.indexOf('--outdir');
const OUTDIR =
  argOut >= 0 && process.argv[argOut + 1]
    ? path.resolve(process.argv[argOut + 1])
    : path.join(ROOT, '.evidence', 'issue-87');

let failures = 0;
const created = [];
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
};
const log = (...a) => console.log('[ui-rig]', ...a);

// ── 1. render the REAL component to HTML, both arms ────────────────────────
function loadEsbuild() {
  try {
    return require_('esbuild');
  } catch {
    const store =
      fs.globSync?.(path.join(ROOT, 'node_modules/.pnpm/esbuild@*/node_modules/esbuild')) ?? [];
    if (store.length) return require_(store[0]);
    throw new Error('esbuild not resolvable — run `pnpm install` first');
  }
}

const GiB = 1024 * 1024 * 1024;
const vol = (over) => ({
  path: '/x',
  label: 'x',
  freeBytes: 0,
  totalBytes: 16 * GiB,
  deviceId: 'd0',
  ...over,
});

// The two arms differ ONLY here. Same paths, same totals, same labels — only
// the free bytes move. Anything else differing would confound the comparison.
const ARMS = {
  warn: [
    vol({ path: '/home/lmas/.orchestra', label: 'Orchestra data', freeBytes: 465 * GiB, totalBytes: 550 * GiB, deviceId: 'd1' }),
    // the incident shape: a 16 GiB tmpfs at 100%
    vol({ path: '/tmp', label: 'Temp (/tmp)', freeBytes: 0, totalBytes: 16 * GiB, deviceId: 'd2' }),
  ],
  normal: [
    vol({ path: '/home/lmas/.orchestra', label: 'Orchestra data', freeBytes: 465 * GiB, totalBytes: 550 * GiB, deviceId: 'd1' }),
    vol({ path: '/tmp', label: 'Temp (/tmp)', freeBytes: 14.8 * GiB, totalBytes: 16 * GiB, deviceId: 'd2' }),
  ],
};

async function renderArms() {
  const esbuild = loadEsbuild();
  // The bundle must live INSIDE the repo tree: `react`/`react-dom` are marked
  // external, so node resolves them relative to the OUTPUT file. A bundle in
  // /tmp cannot see node_modules and dies with ERR_MODULE_NOT_FOUND.
  const tmp = fs.mkdtempSync(path.join(ROOT, '.diskguard-ui-'));
  created.push(tmp);
  const entry = path.join(tmp, 'entry.tsx');
  const outfile = path.join(tmp, 'out.mjs');
  const comp = path.join(ROOT, 'src/renderer/components/ResourcesView.tsx');
  fs.writeFileSync(
    entry,
    `import { FreeSpaceSection } from ${JSON.stringify(comp)};\nexport { FreeSpaceSection };\n`,
  );
  esbuild.buildSync({
    entryPoints: [entry],
    bundle: true,
    format: 'esm',
    outfile,
    platform: 'node',
    jsx: 'automatic',
    external: ['react', 'react-dom', 'react/jsx-runtime'],
    loader: { '.css': 'empty' },
    logLevel: 'silent',
  });
  // Module-load environment for the bundle. The component itself is pure, but
  // bundling it pulls in the renderer store, which touches the preload bridge
  // at import time. Same Proxy pattern as scripts/sidebar-boot-render-smoke.mjs.
  globalThis.self = globalThis;
  const store = new Map();
  globalThis.window = {
    addEventListener: () => {},
    removeEventListener: () => {},
    matchMedia: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
    },
  };
  globalThis.document = {
    addEventListener: () => {},
    removeEventListener: () => {},
    documentElement: { style: { setProperty: () => {} }, classList: { add: () => {}, remove: () => {} } },
    body: { classList: { add: () => {}, remove: () => {} } },
  };
  globalThis.localStorage = globalThis.window.localStorage;
  if (!globalThis.navigator?.platform) {
    Object.defineProperty(globalThis, 'navigator', {
      value: { userAgent: 'node', platform: 'linux' },
      configurable: true,
    });
  }
  const never = () => new Promise(() => {});
  globalThis.window.orchestra = new Proxy(
    { openExternal: () => {}, onEvent: () => () => {} },
    { get: (t, k) => (k in t ? t[k] : never) },
  );
  const { renderToString } = await import('react-dom/server');
  const React = (await import('react')).default;
  const { FreeSpaceSection } = await import(`${outfile}?t=${Date.now()}`);
  const out = {};
  for (const [name, volumes] of Object.entries(ARMS)) {
    out[name] = renderToString(React.createElement(FreeSpaceSection, { volumes }));
  }
  return out;
}

// ── 2. headless sway containment (skill: headless-sway-e2e) ────────────────
function startContainedSway() {
  const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'diskguard-sway-'));
  created.push(cfgDir);
  const cfg = path.join(cfgDir, 'sway.cfg');
  fs.writeFileSync(cfg, 'output HEADLESS-1 resolution 1400x900\n');
  const sock = path.join(cfgDir, 'sway.sock');

  const swayEnv = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: cfgDir,
    XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid?.() ?? 1000}`,
    WLR_BACKENDS: 'headless',
    WLR_LIBINPUT_NO_DEVICES: '1',
    SWAYSOCK: sock,
  };
  const proc = spawn('sway', ['-c', cfg], { env: swayEnv, stdio: 'ignore', detached: true });
  const swayPid = proc.pid;
  log('sway pid', swayPid, 'sock', sock);

  // wait for the socket
  for (let i = 0; i < 100; i += 1) {
    if (fs.existsSync(sock)) break;
    execFileSync('sleep', ['0.1']);
  }
  if (!fs.existsSync(sock)) return { swayPid, display: null, reason: 'sway socket never appeared' };

  // ACTIVE MARKER, derived from OUR pid — never #FF00FF (a shared namespace;
  // measured 2026-08-25, two sibling rigs both read 100% magenta).
  const pid = process.pid;
  const g = pid % 256;
  const b = Math.floor(pid / 256) % 256;
  const hex = `FF${g.toString(16).padStart(2, '0').toUpperCase()}${b.toString(16).padStart(2, '0').toUpperCase()}`;
  spawnSync('swaymsg', ['--', `output HEADLESS-1 background #${hex} solid_color`], {
    env: { ...swayEnv },
    encoding: 'utf8',
  });
  execFileSync('sleep', ['0.5']);

  // grim every candidate display; keep the one that is 100% OUR colour.
  const matches = [];
  const xdg = swayEnv.XDG_RUNTIME_DIR;
  const candidates = fs
    .readdirSync(xdg)
    .filter((n) => /^wayland-\d+$/.test(n))
    .sort();
  for (const disp of candidates) {
    const shot = path.join(cfgDir, `m-${disp}.png`);
    const r = spawnSync('grim', ['-o', 'HEADLESS-1', shot], {
      env: { ...swayEnv, WAYLAND_DISPLAY: disp },
      encoding: 'utf8',
    });
    if (r.status !== 0 || !fs.existsSync(shot)) continue;
    // Decode with PIL and require 100% of pixels to be OUR exact triple — not
    // a channel MEAN. A mean would let a half-painted or half-sibling frame
    // pass, which is exactly the collision this marker exists to detect.
    const id = spawnSync(
      'python3',
      [
        '-c',
        'import sys;from PIL import Image;im=Image.open(sys.argv[1]).convert("RGB");' +
          'cs=im.getcolors(maxcolors=1<<24) or [];' +
          'print("MULTI" if len(cs)!=1 else "%d,%d,%d" % cs[0][1])',
        shot,
      ],
      { encoding: 'utf8' },
    );
    if (id.status !== 0) continue;
    const t = id.stdout.trim();
    if (t === 'MULTI') continue; // not a uniform frame — not our fresh marker
    const [r255, g255, b255] = t.split(',').map((n) => Number(n));
    if (r255 === 255 && g255 === g && b255 === b) matches.push(disp);
  }
  if (matches.length !== 1) {
    return {
      swayPid,
      display: null,
      reason: `expected exactly ONE display carrying marker #${hex}, got ${matches.length} (${matches.join(',') || 'none'}) — refusing to guess`,
    };
  }
  // reset the background so it does not tint the screenshots
  spawnSync('swaymsg', ['--', 'output HEADLESS-1 background #1e1e1e solid_color'], {
    env: { ...swayEnv, WAYLAND_DISPLAY: matches[0] },
    encoding: 'utf8',
  });
  return { swayPid, display: matches[0], sock, cfgDir, marker: hex, reason: null };
}

/** The pre-flight. Three conjuncts, each naming the clause that fired. */
function preflight(display) {
  if (!display) return 'no display captured from my own sway';
  if (display === 'wayland-1') return 'refused wayland-1 — that is the human compositor';
  return null;
}

// ── 3. capture ─────────────────────────────────────────────────────────────
function capture(html, cssPath, display, cfgDir, outPng) {
  const tag = path.basename(outPng, '.png');
  const page = path.join(cfgDir, `page-${tag}.html`);
  fs.writeFileSync(
    page,
    `<!doctype html><meta charset="utf-8"><style>${fs.readFileSync(cssPath, 'utf8')}</style>` +
      `<style>html,body{margin:0;background:#161616;padding:24px;` +
      `font-family:system-ui,sans-serif;color:#ddd}.res-page{max-width:900px}</style>` +
      `<body class="theme-dark"><div class="res-page"><div class="res-scroll">${html}</div></div></body>`,
  );

  // Electron, not chromium: `chromium` on this box is a SHELL FUNCTION, which
  // spawnSync cannot see (it returned rc=null/timeout, indistinguishable from
  // a hung browser until probed). Electron is a real binary in node_modules
  // AND is the runtime Orchestra actually renders in, so these are pixels from
  // the real engine rather than a stand-in.
  const mainJs = path.join(cfgDir, `main-${tag}.cjs`);
  fs.writeFileSync(
    mainJs,
    `const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
app.disableHardwareAcceleration();
app.on('ready', async () => {
  // show:true is LOAD-BEARING. A frame-less window makes capturePage return an
  // empty image — it wrote a 0-byte PNG at rc=0, a silent no-op that looked
  // like a rendering bug. This is exactly why the rig owns a real compositor:
  // the window gets a real frame inside OUR sway, never the human's.
  const win = new BrowserWindow({ width: 1000, height: 620, show: true });
  await win.loadFile(${JSON.stringify(page)});
  await new Promise((r) => setTimeout(r, 1200));
  const img = await win.webContents.capturePage();
  const buf = img.toPNG();
  if (!buf || buf.length === 0) {
    console.error('CAPTURE_EMPTY size=' + JSON.stringify(img.getSize()));
    app.exit(3);
    return;
  }
  fs.writeFileSync(${JSON.stringify(outPng)}, buf);
  console.log('CAPTURE_OK bytes=' + buf.length);
  app.exit(0);
});
`,
  );

  // ALLOWLIST env, built from scratch — never a spread. A spread inherits the
  // human's WAYLAND_DISPLAY/DISPLAY and puts the window on their real screen.
  const childEnv = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: cfgDir,
    XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid?.() ?? 1000}`,
    WAYLAND_DISPLAY: display,
    ELECTRON_OZONE_PLATFORM_HINT: 'wayland',
    ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
  };
  // DISPLAY must be absent: Electron falls back to X11 and reaches the human's
  // screen even with a correct WAYLAND_DISPLAY.
  if ('DISPLAY' in childEnv) throw new Error('DISPLAY leaked into the child env');
  if (childEnv.WAYLAND_DISPLAY !== display) throw new Error('child env display mismatch');

  const electronBin = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron');
  const r = spawnSync(electronBin, ['--ozone-platform=wayland', mainJs], {
    env: childEnv,
    encoding: 'utf8',
    timeout: 90_000,
  });
  return { rc: r.status, err: `${r.stderr ?? ''}${r.stdout ?? ''}`.slice(-400) };
}

// ── main ───────────────────────────────────────────────────────────────────
let sway = null;
try {
  const arms = await renderArms();

  // DOM claims first — these hold with or without a compositor.
  console.log('\n-- DOM arms --');
  check(
    'WARN arm renders the warning badge',
    arms.warn.includes('data-testid="disk-warning-badge"'),
  );
  check(
    'NORMAL arm renders NO warning badge (the negative arm)',
    !arms.normal.includes('data-testid="disk-warning-badge"'),
    'without this, one screenshot cannot distinguish "renders the warning" from "always renders it"',
  );
  check('WARN arm marks the section critical', arms.warn.includes('data-disk-level="critical"'));
  check('NORMAL arm marks the section ok', arms.normal.includes('data-disk-level="ok"'));
  check(
    'WARN arm flags the FULL volume specifically, not every row',
    (arms.warn.match(/data-volume-level="critical"/g) ?? []).length === 1 &&
      arms.warn.includes('data-volume-level="ok"'),
    'the healthy home volume must stay ok while /tmp is critical',
  );
  check(
    'WARN arm states the no-auto-delete rule',
    arms.warn.includes('does not auto-delete'),
  );
  check(
    'NORMAL arm does NOT state it (chrome is warning-only)',
    !arms.normal.includes('does not auto-delete'),
  );
  check(
    'both arms name the mounts',
    ['warn', 'normal'].every((a) => arms[a].includes('/tmp') && arms[a].includes('.orchestra')),
  );

  // ── screenshots, inside our own compositor ───────────────────────────────
  console.log('\n-- containment pre-flight --');
  sway = startContainedSway();
  if (sway.reason) log('sway setup note:', sway.reason);
  const refusal = preflight(sway.display);
  check(
    'pre-flight identified exactly one display by an ACTIVE pid-derived marker',
    refusal === null,
    refusal ?? `display=${sway.display} marker=#${sway.marker}`,
  );

  // NEGATIVE ARM of the guard itself: force the human's display and require a
  // refusal that NAMES the clause. A refusal for an incidental reason would be
  // vacuous.
  const forced = preflight('wayland-1');
  check(
    'NEGATIVE ARM: pre-flight REFUSES a forced wayland-1 and names the clause',
    forced !== null && /wayland-1/.test(forced) && /human/.test(forced),
    `forced value=wayland-1 → refusal="${forced}"`,
  );

  if (!refusal) {
    fs.mkdirSync(OUTDIR, { recursive: true });
    const css = path.join(ROOT, 'src/renderer/styles.css');
    console.log('\n-- screenshots --');
    for (const arm of ['warn', 'normal']) {
      const png = path.join(OUTDIR, `resources-free-space-${arm}.png`);
      const { rc, err } = capture(arms[arm], css, sway.display, sway.cfgDir, png);
      const ok = rc === 0 && fs.existsSync(png) && fs.statSync(png).size > 2000;
      check(
        `captured the ${arm.toUpperCase()} arm`,
        ok,
        ok
          ? `${png} (${fs.statSync(png).size} bytes)`
          : `rc=${rc} ${String(err ?? '').slice(0, 200)}`,
      );
    }
    // The two PNGs must DIFFER. Byte-identical captures would mean the arms
    // never reached the page — a green nobody would question.
    const a = path.join(OUTDIR, 'resources-free-space-warn.png');
    const b = path.join(OUTDIR, 'resources-free-space-normal.png');
    if (fs.existsSync(a) && fs.existsSync(b)) {
      check(
        'the two captures DIFFER (the arms actually reached the pixels)',
        Buffer.compare(fs.readFileSync(a), fs.readFileSync(b)) !== 0,
        `warn=${fs.statSync(a).size}B normal=${fs.statSync(b).size}B`,
      );
    }
  }
} catch (e) {
  console.error('[ui-rig] error:', e);
  failures += 1;
} finally {
  if (sway?.swayPid) {
    try {
      process.kill(-sway.swayPid, 'SIGTERM');
    } catch {
      try {
        process.kill(sway.swayPid, 'SIGTERM');
      } catch { /* already gone */ }
    }
    log('sent SIGTERM to sway pid', sway.swayPid, '— re-verify in the NEXT shell call');
  }
  for (const p of created) {
    // Only paths THIS process created, and only under the two prefixes it
    // creates under. Never anything it merely found.
    const okPrefix =
      p.startsWith(path.join(os.tmpdir(), 'diskguard-')) ||
      p.startsWith(path.join(ROOT, '.diskguard-ui-'));
    if (!okPrefix) {
      console.error('[ui-rig] refusing to remove unexpected path:', p);
      continue;
    }
    fs.rmSync(p, { recursive: true, force: true });
  }
}

console.log(failures === 0 ? '\nALL CLAIMS PASSED' : `\n${failures} CLAIM(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
