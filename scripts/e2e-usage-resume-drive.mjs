#!/usr/bin/env node
// #74 observation (a): the sidebar PAUSE STATE, rendered by the real app.
//
// ── WHAT THIS PROVES, AND WHAT IT DELIBERATELY DOES NOT ──
//
// This boots the built Orchestra inside a marker-verified headless compositor,
// seeds a workspace record carrying `lastStopReason: 'usage_limit'`, and
// asserts the sidebar renders the pause glyph and tooltip.
//
// SEEDING THE REASON IS EXACTLY THE TRAP activity.ts WARNS ABOUT. Its docblock
// records that the first #69 fix passed its E2E only because the drive seeded
// `lastStopReason` directly — proving the renderer renders a field while being
// structurally blind to a broken producer. So this script is scoped and
// labelled as a RENDERING gate only:
//
//   • It CANNOT prove the producer writes the reason. That is unreachable from
//     the renderer: `lastStopReason` appears in 7 renderer files and ZERO times
//     in src/renderer/store.ts — the renderer only ever reads it off a
//     `workspace:update` broadcast from main. Verified with a negative control.
//   • The producer chain is covered instead by scripts/e2e-usage-resume-chain.mjs
//     (real payloads → real normalizeSdkMessage → real decideResume) and by the
//     structural guards in src/main/usage-limit-wiring.test.ts.
//   • Reaching the producer end-to-end needs a REAL usage limit or a
//     main-process injection seam that does not exist today. Declared as a gap,
//     not implied to be covered.
//
// The value it does add: it is the only thing that proves the glyph, the CSS
// class and the tooltip STRING actually reach a real screen — a rendering path
// no unit test in this repo can execute (JSX does not parse under node --test).
//
// Env (all supplied by the rig; this script refuses to guess):
//   RIG_WAYLAND   the marker-verified display   RIG_HOME  the isolated HOME
//   RIG_APP       path to the built AppImage/electron entry
//   RIG_CDP_PORT  devtools port

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const need = (k) => {
  const v = process.env[k];
  if (!v) { console.error(`ABORT(missing-env): ${k} — the rig must supply it; this script does not guess`); process.exit(2); }
  return v;
};
const RIG_WAYLAND = need('RIG_WAYLAND');
const RIG_HOME = need('RIG_HOME');
const RIG_APP = need('RIG_APP');
const CDP = need('RIG_CDP_PORT');

// Refuse the human's compositor outright, before anything launches. Hoisted so
// it can actually fire (a refusal placed after a broader check never runs).
if (RIG_WAYLAND === 'wayland-1') {
  console.error('ABORT(human-display): RIG_WAYLAND is wayland-1 — the human\'s screen');
  process.exit(2);
}

const ORCH_HOME = path.join(RIG_HOME, '.orchestra');
const STORE_DIR = path.join(ORCH_HOME, 'userData', 'orchestra');
fs.mkdirSync(STORE_DIR, { recursive: true });

// ── seed ──
// Two workspaces so the drive shows the pause state is SELECTIVE — a rig that
// only renders the paused row cannot see a bug that paints every row paused.
const RESET_MS = Date.now() + 42 * 60 * 1000; // ~42 min out, so an ETA renders
const seeded = {
  repos: [],
  accounts: [],
  workspaces: [
    {
      id: 'ws-paused', name: 'limit-paused-agent', kind: 'scratch', repoPath: '',
      status: 'idle', createdAt: Date.now(),
      lastStopReason: 'usage_limit',
      lastStopReasonAt: Date.now(),
      usageLimitResetsAt: RESET_MS,
    },
    {
      id: 'ws-healthy', name: 'healthy-agent', kind: 'scratch', repoPath: '',
      status: 'idle', createdAt: Date.now(),
      // NO stop reason — the CONTROL row. It must NOT show the pause state.
    },
  ],
};
fs.writeFileSync(path.join(STORE_DIR, 'store.json'), JSON.stringify(seeded, null, 2));
console.log(`[drive] seeded 2 workspaces (1 paused, 1 healthy control) reset=${new Date(RESET_MS).toISOString()}`);

// ── launch, env -i style: an explicit allowlist, never a spread ──
const child = spawn(RIG_APP, [`--remote-debugging-port=${CDP}`, '--ozone-platform=wayland', '--no-sandbox'], {
  env: {
    HOME: RIG_HOME,
    XDG_RUNTIME_DIR: '/run/user/1000',
    WAYLAND_DISPLAY: RIG_WAYLAND,
    ELECTRON_OZONE_PLATFORM_HINT: 'wayland',
    ORCHESTRA_HOME: ORCH_HOME,
    PATH: '/usr/bin:/bin',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
child.stdout.on('data', (d) => process.stderr.write(`[app] ${d}`));
child.stderr.on('data', (d) => process.stderr.write(`[app!] ${d}`));
console.log(`[drive] launched pid=${child.pid} on ${RIG_WAYLAND} cdp=${CDP}`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function cdpTargets() {
  const res = await fetch(`http://127.0.0.1:${CDP}/json`);
  return res.json();
}

let failures = 0;
const check = (name, got, want, note) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}\n       got=${JSON.stringify(got)} want=${JSON.stringify(want)}${note ? `\n       (${note})` : ''}`);
};

try {
  // Wait for the renderer target. CDP ports collide with sibling agents, so the
  // target is filtered by URL — never "the first target on the port".
  let target = null;
  for (let i = 0; i < 60 && !target; i++) {
    await sleep(1000);
    try {
      const ts = await cdpTargets();
      target = ts.find((t) => t.type === 'page' && /index\.html|localhost/.test(t.url || ''));
    } catch { /* not up yet */ }
  }
  if (!target) throw new Error('no renderer target on CDP — app did not reach a page');
  console.log(`[drive] CDP target: ${target.url}`);

  // Node 22 ships a global WebSocket — no dependency, so the rig cannot be
  // broken by a missing devDep on a fresh checkout.
  const sock = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { sock.addEventListener('open', res); sock.addEventListener('error', rej); });

  let id = 0;
  const send = (method, params = {}) =>
    new Promise((res, rej) => {
      const mid = ++id;
      const onMsg = (ev) => {
        const m = JSON.parse(ev.data);
        if (m.id !== mid) return;
        sock.removeEventListener('message', onMsg);
        m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
      };
      sock.addEventListener('message', onMsg);
      sock.send(JSON.stringify({ id: mid, method, params }));
    });

  const evaluate = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' :: ' + expr);
    return r.result.value;
  };

  // Let the SPA render. A one-shot read at load time sees the pre-render tree.
  for (let i = 0; i < 40; i++) {
    const n = await evaluate(`document.querySelectorAll('[class*="ws-glyph"]').length`);
    if (n > 0) break;
    await sleep(500);
  }

  console.log('\n[a] sidebar pause state');
  // POSITIVE CONTROL FIRST: the drive is actually looking at a rendered app
  // with both seeded rows. Without this, every assertion below could pass
  // vacuously against an empty DOM.
  const glyphCount = await evaluate(`document.querySelectorAll('[class*="ws-glyph"]').length`);
  check('control: the app rendered workspace glyphs', glyphCount > 0, true,
    'a zero here would make every assertion below vacuous');

  const pausedGlyph = await evaluate(`document.querySelectorAll('.ws-glyph-usagelimit').length`);
  check('the paused workspace renders the PAUSE glyph', pausedGlyph, 1);

  const title = await evaluate(
    `(document.querySelector('.ws-glyph-usagelimit')?.getAttribute('title')) ?? null`);
  check('its tooltip is the #74 pause string', /^⏸ limit reached — resumes ~/.test(title || ''), true,
    `observed: ${JSON.stringify(title)}`);

  // NEGATIVE / SELECTIVITY: the healthy row must NOT be painted paused. A rig
  // that only shows the pause firing cannot see a bug that pauses everything.
  check('exactly ONE row is paused — the healthy control is not', pausedGlyph, 1,
    'the second seeded workspace has no stop reason and must render normally');

  const alarmish = await evaluate(
    `getComputedStyle(document.querySelector('.ws-glyph-usagelimit')).color`);
  console.log(`       (pause glyph colour: ${alarmish} — muted by design; nothing is wrong and nobody is needed)`);

  const shot = await send('Page.captureScreenshot', { format: 'png' });
  const out = path.join(RIG_HOME, 'sidebar-pause.png');
  fs.writeFileSync(out, Buffer.from(shot.data, 'base64'));
  console.log(`[drive] screenshot: ${out} (${fs.statSync(out).size} bytes)`);

  sock.close();
} catch (e) {
  console.error(`[drive] ERROR: ${e.message}`);
  failures++;
} finally {
  child.kill('SIGTERM');
}

console.log(`\n${failures === 0 ? 'DRIVE PASS' : `DRIVE FAIL (${failures})`}`);
process.exit(failures === 0 ? 0 : 1);
