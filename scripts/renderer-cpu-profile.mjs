// T9 / issue #198 D11 — renderer idle-CPU profile driver (before/after).
//
// Launches the BUILT Orchestra app under headless sway, seeds a structured
// session (the row-measure path's subject), then over CDP:
//   1. installs a frame counter by wrapping requestAnimationFrame in the page
//      BEFORE the app mounts is not possible post-hoc, so instead we count the
//      perpetual-loop's frames indirectly via a CPU profile + an in-page rAF
//      probe over a fixed IDLE window;
//   2. runs Profiler over a fixed idle window and reports total scripting time
//      attributed to StructuredView's tick.
//
// The discriminator (master vs fix, SAME seeded state, SAME idle window):
//   - `rafPerSec`: how many times/sec a self-scheduling rAF fires while idle.
//     On master the StructuredView reset-loop reschedules every frame (~60/s
//     per mounted pane); on the fix an idle pane schedules none.
//   - `scriptMsPerSec`: renderer main-thread scripting ms per wall-second from
//     a CPU profile — the % of a core the renderer burns while idle.
//
// Usage: node scripts/renderer-cpu-profile.mjs <appDir> <label> [panes]
//   appDir: repo root whose dist/ + dist-electron/ to run (this worktree, or a
//           checkout of master built separately)
//   label:  'master' | 'fix' (for the output filename)
//   panes:  how many structured panes to mount (default 6)

import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';

const APP_DIR = process.argv[2];
const LABEL = process.argv[3] || 'run';
const PANES = Number(process.argv[4] || 6);
if (!APP_DIR) { console.error('usage: renderer-cpu-profile.mjs <appDir> <label> [panes]'); process.exit(2); }

const RIG = process.pid;
const SWAYSOCK = `/tmp/rcpu-sway-${RIG}.sock`;
const CFG = join(tmpdir(), `rcpu-sway-${RIG}.cfg`);
const DEBUG_PORT = 9000 + (RIG % 900);
const XDG = process.env.XDG_RUNTIME_DIR || '/run/user/1000';
const ORCH_HOME = join(XDG, `rcpu-${RIG}`);
const FAKE_HOME = mkdtempSync(join(tmpdir(), `rcpu-home-${RIG}-`));
const OUT_DIR = join(APP_DIR, 'build', 'renderer-cpu');
mkdirSync(OUT_DIR, { recursive: true });
mkdirSync(ORCH_HOME, { recursive: true });

const MARK_G = (RIG % 251).toString(16).padStart(2, '0').toUpperCase();
const MARK_B = ((RIG % 239) + 5).toString(16).padStart(2, '0').toUpperCase();
const MARK = `FF${MARK_G}${MARK_B}`;
const MARK_RGB = [255, parseInt(MARK_G, 16), parseInt(MARK_B, 16)];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const children = [];
function sh(cmd, args, opts = {}) {
  const c = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], ...opts });
  children.push(c);
  return c;
}

async function grimDecode(display) {
  // returns fraction of pixels matching MARK_RGB on HEADLESS-1 for `display`
  const png = join(tmpdir(), `rcpu-grim-${RIG}-${display}.png`);
  await new Promise((res) => {
    const g = spawn('grim', ['-o', 'HEADLESS-1', png], {
      env: { ...minEnv(), WAYLAND_DISPLAY: display },
      stdio: 'ignore',
    });
    g.on('exit', res);
    g.on('error', () => res(1));
  });
  try {
    const buf = readFileSync(png);
    // crude: count how many of MARK_RGB triplets appear in raw IDAT-inflated?
    // Too heavy — instead sample: use a tiny PNG decoder. Keep it simple: the
    // marker check only needs "is this predominantly MARK". Use sharp-free
    // zlib inflate of the single IDAT.
    return decodeSolidFraction(buf, MARK_RGB);
  } catch {
    return 0;
  }
}

import zlib from 'node:zlib';
function decodeSolidFraction(buf, [r, g, b]) {
  // Minimal PNG parse: assume 8-bit RGBA/RGB, single IHDR+IDAT. Good enough for
  // a solid-color marker check.
  if (buf.readUInt32BE(0) !== 0x89504e47) return 0;
  let off = 8, width = 0, height = 0, colorType = 0, bitDepth = 0;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4);
      bitDepth = data.readUInt8(8); colorType = data.readUInt8(9);
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  if (bitDepth !== 8) return 0;
  const bpp = colorType === 6 ? 4 : colorType === 2 ? 3 : 0;
  if (!bpp) return 0;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * bpp;
  // Full PNG filter reconstruction (0 None, 1 Sub, 2 Up, 3 Average, 4 Paeth).
  const out = Buffer.alloc(height * stride);
  const paeth = (a, b, c) => {
    const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  };
  for (let y = 0; y < height; y++) {
    const inRow = y * (stride + 1);
    const filter = raw[inRow];
    const outRow = y * stride;
    for (let x = 0; x < stride; x++) {
      const val = raw[inRow + 1 + x];
      const a = x >= bpp ? out[outRow + x - bpp] : 0;
      const bb = y > 0 ? out[outRow - stride + x] : 0;
      const c = x >= bpp && y > 0 ? out[outRow - stride + x - bpp] : 0;
      let recon;
      switch (filter) {
        case 0: recon = val; break;
        case 1: recon = val + a; break;
        case 2: recon = val + bb; break;
        case 3: recon = val + ((a + bb) >> 1); break;
        case 4: recon = val + paeth(a, bb, c); break;
        default: recon = val;
      }
      out[outRow + x] = recon & 0xff;
    }
  }
  let match = 0, total = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = y * stride + x * bpp;
      total++;
      if (out[p] === r && out[p + 1] === g && out[p + 2] === b) match++;
    }
  }
  return total ? match / total : 0;
}

function minEnv() {
  return {
    HOME: FAKE_HOME,
    PATH: process.env.PATH,
    XDG_RUNTIME_DIR: XDG,
    SWAYSOCK,
  };
}

async function main() {
  // 1. sway
  writeFileSync(CFG, 'output HEADLESS-1 resolution 1600x1000\n');
  const sway = sh('sway', ['-c', CFG], {
    env: { ...minEnv(), WLR_BACKENDS: 'headless', WLR_LIBINPUT_NO_DEVICES: '1', WAYLAND_DISPLAY: '' },
  });
  const swayPid = sway.pid;
  await sleep(1500);

  // 2. paint marker, find my display
  await new Promise((res) => {
    const m = spawn('swaymsg', ['--', `output HEADLESS-1 background #${MARK} solid_color`],
      { env: minEnv(), stdio: 'ignore' });
    m.on('exit', res); m.on('error', () => res());
  });
  await sleep(500);
  let myDisplay = null;
  for (const n of [1, 2, 3, 4, 5, 6, 7, 8]) {
    const frac = await grimDecode(`wayland-${n}`);
    if (frac > 0.98) {
      if (myDisplay) { console.error('ABORT: two sockets read my marker'); await teardown(swayPid); process.exit(1); }
      myDisplay = `wayland-${n}`;
    }
  }
  if (!myDisplay) { console.error('ABORT: no display captured from my sway'); await teardown(swayPid); process.exit(1); }
  console.error(`[rig] my display=${myDisplay} marker=#${MARK}`);

  // Build the child's env as an explicit ALLOWLIST (never a spread of the
  // parent's — the parent carries the HUMAN's DISPLAY=:0 + WAYLAND_DISPLAY).
  // Then assert, on the ARRAY we will actually pass, that no X11 DISPLAY leaks
  // and WAYLAND_DISPLAY equals the socket MY sway produced and painted. This is
  // the load-bearing guard (the skill's step 3); reading process.env would go
  // green while pointing at the human.
  const childEnv = {
    ...minEnv(),
    WAYLAND_DISPLAY: myDisplay,
    ELECTRON_OZONE_PLATFORM_HINT: 'wayland',
    ORCHESTRA_HOME: ORCH_HOME,
  };
  // NEGATIVE ARM (self-test): force the human's display and an X11 leak; the
  // guard MUST refuse and NAME the clause. Run with RCPU_NEGATIVE_ARM=1.
  if (process.env.RCPU_NEGATIVE_ARM) {
    const forced = { ...childEnv, WAYLAND_DISPLAY: 'wayland-1', DISPLAY: ':0' };
    if (forced.DISPLAY) console.error('NEG-ARM refused: X11 DISPLAY leaks into child (clause: childEnv.DISPLAY)');
    if (forced.WAYLAND_DISPLAY !== myDisplay) console.error(`NEG-ARM refused: child WAYLAND_DISPLAY ${forced.WAYLAND_DISPLAY} !== my captured ${myDisplay} (clause: WAYLAND_DISPLAY mismatch)`);
    await teardown(swayPid); process.exit(3);
  }
  if (childEnv.DISPLAY) { console.error('ABORT: X11 DISPLAY leaks into child'); await teardown(swayPid); process.exit(1); }
  if (childEnv.WAYLAND_DISPLAY !== myDisplay) { console.error('ABORT: child WAYLAND_DISPLAY not my captured socket'); await teardown(swayPid); process.exit(1); }

  // reset bg so it doesn't tint captures
  spawn('swaymsg', ['--', 'output HEADLESS-1 background #000000 solid_color'], { env: minEnv(), stdio: 'ignore' });

  // 3. launch Electron (built app) with debug port
  const electronBin = join(APP_DIR, 'node_modules', 'electron', 'dist', 'electron');
  const app = sh(electronBin, ['.', '--ozone-platform=wayland', `--remote-debugging-port=${DEBUG_PORT}`], {
    cwd: APP_DIR,
    env: childEnv,
  });
  app.stderr.on('data', (d) => { if (process.env.RCPU_VERBOSE) process.stderr.write(`[app] ${d}`); });

  // 4. connect CDP (raw WebSocket — no chrome-remote-interface dependency)
  const target = await waitForTarget(DEBUG_PORT, APP_DIR);
  const cdp = await connectCDP(target.webSocketDebuggerUrl);
  await cdp.send('Runtime.enable');
  await cdp.send('Profiler.enable');
  const Runtime = { evaluate: (p) => cdp.send('Runtime.evaluate', p) };
  const Profiler = {
    start: () => cdp.send('Profiler.start'),
    stop: () => cdp.send('Profiler.stop'),
  };

  // wait for the app to render its shell
  await evalUntil(Runtime, `typeof window.__orchestraSetState === 'function' && typeof window.__injectAgentEvent === 'function'`, 30000);

  // Capture the guard's warnings in-page: `log.warn` mirrors to console.warn, so
  // wrapping it counts `row-measure loop guard tripped` without touching app code.
  await Runtime.evaluate({
    expression: `(() => { window.__warns = []; const o = console.warn.bind(console); console.warn = (...a) => { try { window.__warns.push(String(a[0])); } catch {} return o(...a); }; })()`,
    returnByValue: true,
  });
  const countTrips = async () => (await Runtime.evaluate({
    expression: `window.__warns.filter((w) => w.includes('row-measure loop guard tripped')).length`,
    returnByValue: true,
  })).result.value;

  // 5. seed PANES structured workspaces. StructuredView mounts for every
  // workspace in App's LRU (`lruOrder`, filled only as `activeId` CHANGES), so a
  // bare setState mounts just the active one — cycle `activeId` through every
  // workspace so each enters the LRU, ending on ws-0. App may also reconcile
  // liveWorkspaces from the main store and drop the fakes, so re-apply until
  // EVERY pane is mounted. Transcript injection is idempotent (only workspaces
  // below the target message count are topped up), so retries never inflate it.
  // POSITIVE CONTROL: `.av-view` count must equal PANES — a 0 rAF on fewer
  // mounted panes than asked would be a vacuous (or under-scaled) pass.
  let mounted = false;
  for (let attempt = 0; attempt < 20 && !mounted; attempt++) {
    await Runtime.evaluate({ expression: seedWorkspacesExpr(PANES), awaitPromise: true, returnByValue: true });
    for (let i = PANES - 1; i >= 0; i--) {
      await Runtime.evaluate({ expression: `window.__orchestraSetState({ activeId: 'ws-${i}', view: 'structured' })`, returnByValue: true });
      await sleep(150); // let App's LRU effect run for this activeId
    }
    await Runtime.evaluate({ expression: injectTranscriptExpr([...Array(PANES).keys()].map((i) => 'ws-' + i)), returnByValue: true });
    await sleep(600);
    const r = await Runtime.evaluate({
      expression: `document.querySelectorAll('.av-view').length`,
      returnByValue: true,
    });
    if ((r.result.value || 0) === PANES) mounted = true;
  }
  if (!mounted) { console.error(`ABORT: ${PANES} structured panes never all mounted — subject absent/under-scaled`); await teardown(swayPid); process.exit(4); }
  await sleep(1500); // let measures settle

  // POSITIVE CONTROL readback: folded session + live DOM.
  const ctrl = await Runtime.evaluate({
    expression: `(() => {
      const sess = window.__readAgentSession('ws-0');
      return {
        foldedMessages: sess ? sess.messages.length : 0,
        avViews: document.querySelectorAll('.av-view').length,
        messageLists: document.querySelectorAll('.av-message-list').length,
        mountedRows: document.querySelectorAll('.av-message-list-inner > div > *').length,
      };
    })()`,
    returnByValue: true,
  });
  const control = ctrl.result.value;
  console.error('[rig] positive control:', JSON.stringify(control));
  const guardTripsDuringMount = await countTrips();

  // Diagnostic: CSS animations/transitions currently RUNNING in the page. A
  // renderer with rAF≈0 that still burns Compositor+GPU time is usually animating.
  const animRes = await Runtime.evaluate({
    expression: `(() => {
      const by = {};
      for (const a of document.getAnimations()) {
        if (a.playState !== 'running') continue;
        const t = a.effect && a.effect.target;
        const el = t ? (t.tagName.toLowerCase() + (t.className && typeof t.className === 'string' ? '.' + t.className.trim().split(/\\s+/).join('.') : '')) : '?';
        const key = (a.animationName || a.transitionProperty || a.constructor.name) + ' @ ' + el;
        by[key] = (by[key] || 0) + 1;
      }
      return Object.entries(by).sort((x, y) => y[1] - x[1]).slice(0, 12);
    })()`,
    returnByValue: true,
  });
  const runningAnimations = animRes.result.value;
  console.error('[rig] running animations:', JSON.stringify(runningAnimations));

  // 6. IDLE measurement window.
  const IDLE_MS = Number(process.env.RCPU_IDLE_MS || 4000);
  // Count the APP'S OWN requestAnimationFrame callbacks during idle by wrapping
  // rAF so every scheduled callback increments a counter. This counts frames the
  // application requests — NOT frames a probe requests — so an idle app that
  // schedules nothing reads ~0, while master's perpetual per-pane reset loop
  // reads ~60/s × mounted panes. (Installed AFTER seeding so we only count the
  // steady-state idle behavior, not the one-time mount/measure burst.)
  await Runtime.evaluate({
    expression: `(() => {
      window.__rafCount = 0;
      const orig = window.requestAnimationFrame.bind(window);
      window.requestAnimationFrame = (cb) => orig((t) => { window.__rafCount++; return cb(t); });
    })()`,
    returnByValue: true,
  });

  // Find the renderer process (Electron --type=renderer child) so we can sample
  // its REAL OS-level CPU — the field metric ("~36% of a core") is process CPU,
  // which a perpetual 60fps rAF keeps hot via paint/composite even when the JS
  // body is trivial (the V8 self-time profile alone undercounts that).
  const rendererPid = findRendererPid(app.pid);

  // N consecutive idle windows so OS-CPU transients (GC, background timers)
  // average out — a single 4s window on this box is too noisy to attribute
  // (block-structured A/B measures drift, not the build). We report the per-
  // window series + median for both the OS renderer CPU and the app-rAF rate.
  const clkTck = 100; // sysconf(_SC_CLK_TCK) is 100 on Linux
  const REPS = Number(process.env.RCPU_REPS || 5);
  const rendererCorePctSeries = [];
  const appRafPerSecSeries = [];
  let profile = null, scriptMs = 0, wallMsFirst = 0;
  for (let rep = 0; rep < REPS; rep++) {
    await Runtime.evaluate({ expression: 'window.__rafCount = 0', returnByValue: true });
    const cpu0 = rendererPid ? readProcCpuTicks(rendererPid) : null;
    if (rep === 0) await Profiler.start();
    const tStart = Date.now();
    await sleep(IDLE_MS);
    const wallMs = Date.now() - tStart;
    const cpu1 = rendererPid ? readProcCpuTicks(rendererPid) : null;
    if (rep === 0) { const s = await Profiler.stop(); profile = s.profile; scriptMs = profileScriptMs(profile); wallMsFirst = wallMs; }
    const corePct = cpu0 != null && cpu1 != null
      ? +(((cpu1 - cpu0) / clkTck) / (wallMs / 1000) * 100).toFixed(1)
      : null;
    const rafRead = await Runtime.evaluate({ expression: 'window.__rafCount', returnByValue: true });
    rendererCorePctSeries.push(corePct);
    appRafPerSecSeries.push(+((rafRead.result.value || 0) / (wallMs / 1000)).toFixed(1));
  }
  // BREAKDOWN window: which process / thread burns the CPU while "idle"? (The
  // rAF counter is the gate; this is the diagnostic that says where the rest goes.)
  const BD_MS = 5000;
  const tree0 = listTreeTicks(app.pid);
  const thr0 = rendererPid ? listThreadTicks(rendererPid) : new Map();
  await sleep(BD_MS);
  const tree1 = listTreeTicks(app.pid);
  const thr1 = rendererPid ? listThreadTicks(rendererPid) : new Map();
  const pct = (d) => +((d / clkTck) / (BD_MS / 1000) * 100).toFixed(1);
  const processes = [...tree1].map(([pid, v]) => ({ pid, type: v.type, corePct: pct(v.ticks - (tree0.get(pid)?.ticks ?? v.ticks)) }))
    .sort((a, b) => b.corePct - a.corePct).slice(0, 8);
  const threads = [...thr1].map(([tid, v]) => ({ tid, comm: v.comm, corePct: pct(v.ticks - (thr0.get(tid)?.ticks ?? v.ticks)) }))
    .sort((a, b) => b.corePct - a.corePct).slice(0, 8);
  const median = (a) => { const b = [...a].filter((x) => x != null).sort((x, y) => x - y); return b.length ? b[Math.floor(b.length / 2)] : null; };
  // OPTIONAL in-page A/B (RCPU_AB=<css>): SAME build, the given CSS injected vs
  // not, windows INTERLEAVED in alternating order (block-structured A/B measures
  // drift, not the build). Measures renderer+GPU CPU together (an animation's cost
  // lands in both). Used to price a candidate cause without a second build.
  let ab = null;
  if (process.env.RCPU_AB) {
    const css = process.env.RCPU_AB === '1' ? '*,*::before,*::after{animation:none !important}' : process.env.RCPU_AB;
    const ROUNDS = Number(process.env.RCPU_AB_ROUNDS || 6), AB_MS = 4000;
    const sumRG = (t) => [...t.values()].filter((v) => v.type === 'renderer' || v.type === 'gpu-process').reduce((a, v) => a + v.ticks, 0);
    const setOff = (on) => Runtime.evaluate({
      expression: `(() => { let el = document.getElementById('rcpu-ab'); if (${on}) { if (!el) { el = document.createElement('style'); el.id = 'rcpu-ab'; el.textContent = ${JSON.stringify(css)}; document.head.appendChild(el); } } else if (el) el.remove(); const by = {}; for (const a of document.getAnimations()) { if (a.playState === 'running') { const k = a.animationName || a.transitionProperty || 'wapi'; by[k] = (by[k] || 0) + 1; } } return Object.entries(by).map(([k, v]) => k + 'x' + v).sort().join(','); })()`,
      returnByValue: true,
    });
    const base = [], off = [], runningBase = [], runningOff = [];
    for (let r = 0; r < ROUNDS; r++) {
      for (const on of (r % 2 === 0 ? [false, true] : [true, false])) {
        const nRunning = (await setOff(on)).result.value;
        await sleep(400); // settle after the style flip, before the window
        const t0 = sumRG(listTreeTicks(app.pid)); const w0 = Date.now();
        await sleep(AB_MS);
        const pctRG = +(((sumRG(listTreeTicks(app.pid)) - t0) / 100) / ((Date.now() - w0) / 1000) * 100).toFixed(1);
        (on ? off : base).push(pctRG); (on ? runningOff : runningBase).push(nRunning);
      }
    }
    await setOff(false);
    ab = { css, rounds: ROUNDS, windowMs: AB_MS, baseRendererPlusGpuPct: base, animationsOffPct: off, runningAnimationsBase: runningBase, runningAnimationsOff: runningOff, medianBase: median(base), medianOff: median(off) };
    console.error('[rig] A/B renderer+gpu %core base=', JSON.stringify(base), 'off=', JSON.stringify(off));
  }

  // GUARD ARMS. `measureLoopWarned` latches ONCE PER INSTANCE, so each arm uses a
  // FRESH workspace (never mounted before) or an already-tripped instance would
  // mask it. Both read the count of `row-measure loop guard tripped` warnings.
  const ALL = [...Array(PANES).keys()].map((i) => 'ws-' + i);
  const activate = (id) => Runtime.evaluate({ expression: `window.__orchestraSetState({ activeId: '${id}', view: 'structured' })`, returnByValue: true });
  const rowsInDom = async () => (await Runtime.evaluate({ expression: `document.querySelectorAll('.av-message-list-inner > div > *').length`, returnByValue: true })).result.value;
  const msgs = async (id) => (await Runtime.evaluate({ expression: `window.__readAgentSession('${id}')?.messages.length ?? 0`, returnByValue: true })).result.value;
  await Runtime.evaluate({ expression: seedWorkspacesExpr(PANES, ['ws-cold', 'ws-stream'], 'ws-0'), returnByValue: true });
  await Runtime.evaluate({ expression: injectTranscriptExpr(['ws-cold']), returnByValue: true });
  await sleep(500);

  // (a) COLD ACTIVATION: an 80-message pane that has never been visible first
  // shows a full window (> MAX_SYNC_MEASURE_PASSES rows) in ONE commit. That is
  // ONE pass, not N — per-row counting trips the guard on every such open (the
  // field's 88 warnings). Control: the activation must really mount > 12 rows.
  const rows0 = await rowsInDom();
  const tripsA0 = await countTrips();
  await activate('ws-cold');
  await sleep(1500);
  const cold = { rowsMounted: (await rowsInDom()) - rows0, guardTrips: (await countTrips()) - tripsA0 };
  console.error('[rig] cold-activation arm:', JSON.stringify(cold));

  // (b) STREAMING ACROSS FRAMES on an EMPTY fresh pane: each new row is a
  // first-measure pass in its OWN commit, so > 12 cumulative passes trip the guard
  // iff the frame-boundary reset stops firing — a "fix" that removes the loop by
  // never resetting reads 0 rAF/s yet fails HERE. Control: the fold must grow.
  const STREAM_N = 40;
  await activate('ws-stream');
  await sleep(1000);
  const streamBefore = await msgs('ws-stream');
  const tripsB0 = await countTrips();
  await Runtime.evaluate({
    expression: `new Promise((res) => { let i = 0; const t = setInterval(() => {
      window.__injectAgentEvent('ws-stream', { type: 'user-message', text: 'stream ' + i + ' ' + 'lorem ipsum '.repeat(1 + (i % 5)), seq: i, at: Date.now() });
      if (++i >= ${STREAM_N}) { clearInterval(t); res(true); } }, 120); })`,
    awaitPromise: true, returnByValue: true,
  });
  await sleep(800);
  const streamed = { startedEmpty: streamBefore === 0, rowsAdded: (await msgs('ws-stream')) - streamBefore, expected: STREAM_N, guardTrips: (await countTrips()) - tripsB0 };
  const tripMessages = (await Runtime.evaluate({
    expression: `window.__warns.filter((w) => w.includes('row-measure loop guard tripped')).slice(0, 2)`,
    returnByValue: true,
  })).result.value;
  console.error('[rig] streaming arm:', JSON.stringify(streamed), 'mount-phase trips:', guardTripsDuringMount);

  const result = {
    label: LABEL,
    panes: PANES,
    idleWindowMs: IDLE_MS,
    reps: REPS,
    scriptMsPerSec: +(scriptMs / (wallMsFirst / 1000)).toFixed(1),
    corePctIdleJs: +((scriptMs / wallMsFirst) * 100).toFixed(1),
    appRafPerSecSeries,
    appRafPerSecMedian: median(appRafPerSecSeries),
    appRafPerSecPerPane: +(median(appRafPerSecSeries) / control.avViews).toFixed(1),
    rendererPid,
    rendererCorePctSeries,          // REAL OS-level renderer CPU % of one core per window
    rendererCorePctMedian: median(rendererCorePctSeries),
    // Artifact identity: which renderer bundle this run actually drove.
    bundle: (() => { try { const f = readFileSync(join(APP_DIR, 'dist', 'index.html'), 'utf8').match(/assets\/(index-[^"]+\.js)/)?.[1]; return f ? `${f} (${statSync(join(APP_DIR, 'dist', 'assets', f)).mtime.toISOString()})` : null; } catch { return null; } })(),
    positiveControl: control,
    guardTripsDuringMount,
    cold,
    streamed,
    tripMessages,
    runningAnimations,
    ab,
    breakdown: { windowMs: BD_MS, processes, rendererThreads: threads },
    topFunctions: topSelfFns(profile, 8),
  };
  // Assertion (makes this a GATE, not just a report). The invariant under test:
  // an IDLE mounted structured pane schedules NO application rAF frames. The
  // unfixed (master) arm reddens here — it schedules ~60/s — while the fixed arm
  // passes. Threshold 5/s tolerates a stray one-shot without admitting the loop.
  const IDLE_RAF_MAX = 5;
  const clauses = [
    { name: 'idle-raf', ok: result.appRafPerSecMedian <= IDLE_RAF_MAX, detail: `idle appRafPerSecMedian (${result.appRafPerSecMedian}) <= ${IDLE_RAF_MAX}` },
    { name: 'cold-rows', ok: cold.rowsMounted > 12, detail: `cold pane mounted rows (${cold.rowsMounted}) > 12 [positive control]` },
    { name: 'cold-guard', ok: cold.rowsMounted > 12 && cold.guardTrips === 0, detail: `guard trips on a cold ${cold.rowsMounted}-row pane open (${cold.guardTrips}) == 0` },
    { name: 'stream-rows', ok: streamed.startedEmpty && streamed.rowsAdded === STREAM_N, detail: `streamed rows added (${streamed.rowsAdded}) == ${STREAM_N} on an empty pane [positive control]` },
    { name: 'stream-guard', ok: streamed.rowsAdded === STREAM_N && streamed.guardTrips === 0, detail: `guard trips streaming ${STREAM_N} rows across frames (${streamed.guardTrips}) == 0` },
  ];
  result.clauses = clauses;
  result.failed = clauses.filter((c) => !c.ok).map((c) => c.name);
  result.pass = result.failed.length === 0;
  result.assertion = clauses.map((c) => `${c.ok ? 'ok ' : 'FAIL'} ${c.name}: ${c.detail}`).join(' | ');

  const outPath = join(OUT_DIR, `${LABEL}.json`);
  writeFileSync(outPath, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  console.error(`[rig] wrote ${outPath} — ${result.pass ? 'PASS' : 'FAIL'}: ${result.assertion}`);

  cdp.close();
  await teardown(swayPid);
  process.exit(result.pass ? 0 : 1);
}

// Minimal CDP-over-WebSocket client using the built-in fetch/WebSocket (Node 22
// ships a global WebSocket). One request/response map keyed by id; we don't need
// event subscriptions here.
async function connectCDP(url) {
  const ws = new WebSocket(url);
  let nextId = 1;
  const pending = new Map();
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result);
    }
  };
  return {
    send(method, params = {}) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params }));
      });
    },
    close() { try { ws.close(); } catch {} },
  };
}

function seedWorkspacesExpr(panes, extra = [], activeId = 'ws-0') {
  return `(() => {
    const ids = [...Array(${panes}).keys()].map((i) => 'ws-' + i).concat(${JSON.stringify(extra)});
    const wss = ids.map((id) => ({
      id,
      title: id,
      repoPath: '/tmp/repo',
      worktreePath: '/tmp/repo-' + id,
      branch: 'b-' + id,
      view: 'structured',
      status: '${process.env.RCPU_WS_STATUS || 'idle'}',
      activity: '${process.env.RCPU_WS_STATUS || 'idle'}',
      createdAt: Date.now(),
    }));
    window.__orchestraSetState({ workspaces: wss, activeId: '${activeId}', view: 'structured' });
    return true;
  })()`;
}

// Idempotent: tops each listed workspace up to TARGET rows only if below it.
function injectTranscriptExpr(ids) {
  return `(() => {
    const TARGET = 80;
    const pad = (n) => Array(n).fill('lorem ipsum dolor sit amet consectetur').join(' ');
    for (const wsId of ${JSON.stringify(ids)}) {
      const have = window.__readAgentSession(wsId)?.messages.length ?? 0;
      if (have >= TARGET) continue;
      let seq = 0;
      for (let m = 0; m < TARGET / 2; m++) {
        // user-message rows are self-contained (no block-start needed) and vary
        // in height, which is exactly what the row-measure path exercises.
        window.__injectAgentEvent(wsId, { type: 'user-message', text: 'message ' + m + ' ' + pad(1 + (m % 4)), seq: seq++, at: Date.now() });
        window.__injectAgentEvent(wsId, { type: 'notice', kind: 'info', text: 'reply ' + m + ' ' + pad(1 + ((m + 2) % 3)), seq: seq++, at: Date.now() });
      }
    }
    return true;
  })()`;
}

function profileScriptMs(profile) {
  // Profiler profile: nodes[], samples[], timeDeltas[] (microseconds).
  // Total scripting time = sum of timeDeltas for samples NOT in (idle)/(program)/(garbage collector) roots.
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  const idleNames = new Set(['(idle)', '(program)', '(root)']);
  let scriptUs = 0;
  const deltas = profile.timeDeltas || [];
  const samples = profile.samples || [];
  for (let i = 0; i < samples.length; i++) {
    const node = byId.get(samples[i]);
    const name = node?.callFrame?.functionName || '';
    if (idleNames.has(name)) continue;
    scriptUs += deltas[i] || 0;
  }
  return +(scriptUs / 1000).toFixed(1);
}

function topSelfFns(profile, k) {
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  const self = new Map();
  const deltas = profile.timeDeltas || [];
  const samples = profile.samples || [];
  for (let i = 0; i < samples.length; i++) {
    const node = byId.get(samples[i]);
    const cf = node?.callFrame;
    if (!cf) continue;
    const key = `${cf.functionName || '(anon)'} @ ${(cf.url || '').split('/').pop()}:${cf.lineNumber}`;
    self.set(key, (self.get(key) || 0) + (deltas[i] || 0));
  }
  return [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, k)
    .map(([fn, us]) => ({ fn, ms: +(us / 1000).toFixed(1) }));
}

// Walk the process tree under the Electron app pid and return the first child
// whose cmdline carries --type=renderer. Uses /proc only (no child process).
function findRendererPid(appPid) {
  try {
    const all = readdirSync('/proc').filter((f) => /^\d+$/.test(f));
    for (const pid of all) {
      try {
        const cmd = readFileSync(`/proc/${pid}/cmdline`, 'utf8');
        if (cmd.includes('--type=renderer')) {
          // confirm it descends from our app pid
          if (isDescendant(Number(pid), appPid)) return Number(pid);
        }
      } catch {}
    }
  } catch {}
  return null;
}

function isDescendant(pid, ancestor) {
  let cur = pid, guard = 0;
  while (cur && cur !== 1 && guard++ < 50) {
    if (cur === ancestor) return true;
    try {
      const stat = readFileSync(`/proc/${cur}/stat`, 'utf8');
      // ppid is field 4, but comm (field 2) may contain spaces/parens — split after the last ')'
      const after = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      cur = Number(after[1]); // ppid
    } catch { return false; }
  }
  return false;
}

function readProcCpuTicks(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const after = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    // fields (0-indexed from after comm): state(0) ppid(1) ... utime(11) stime(12)
    const utime = Number(after[11]);
    const stime = Number(after[12]);
    return utime + stime;
  } catch { return null; }
}


// Every process in the app's tree (browser/gpu/renderer/utility) → cumulative CPU ticks.
function listTreeTicks(appPid) {
  const out = new Map();
  for (const f of readdirSync('/proc')) {
    if (!/^\d+$/.test(f)) continue;
    const pid = Number(f);
    if (!isDescendant(pid, appPid)) continue;
    let type = 'browser';
    try {
      const m = readFileSync(`/proc/${pid}/cmdline`, 'utf8').match(/--type=([a-z-]+)/);
      if (m) type = m[1];
    } catch { continue; }
    const t = readProcCpuTicks(pid);
    if (t != null) out.set(pid, { type, ticks: t });
  }
  return out;
}

// Per-thread CPU ticks of one process (main thread vs compositor vs raster vs GC workers).
function listThreadTicks(pid) {
  const out = new Map();
  try {
    for (const tid of readdirSync(`/proc/${pid}/task`)) {
      try {
        const comm = readFileSync(`/proc/${pid}/task/${tid}/comm`, 'utf8').trim();
        const stat = readFileSync(`/proc/${pid}/task/${tid}/stat`, 'utf8');
        const after = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
        out.set(tid, { comm, ticks: Number(after[11]) + Number(after[12]) });
      } catch {}
    }
  } catch {}
  return out;
}

async function evalUntil(Runtime, expr, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const r = await Runtime.evaluate({ expression: expr, returnByValue: true }).catch(() => null);
    if (r?.result?.value === true) return;
    await sleep(300);
  }
  throw new Error('evalUntil timeout: ' + expr);
}

async function waitForTarget(port, appDir) {
  const t0 = Date.now();
  while (Date.now() - t0 < 30000) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json`);
      const list = await res.json();
      const page = list.find((t) => t.type === 'page' && t.url && !t.url.startsWith('devtools://'));
      if (page) return page;
    } catch {}
    await sleep(400);
  }
  throw new Error('no CDP target on port ' + port);
}

async function teardown(swayPid) {
  for (const c of children) { try { c.kill('SIGKILL'); } catch {} }
  try { if (swayPid) process.kill(swayPid, 'SIGKILL'); } catch {}
  try { rmSync(CFG); } catch {}
  try { rmSync(FAKE_HOME, { recursive: true, force: true }); } catch {}
  try { rmSync(ORCH_HOME, { recursive: true, force: true }); } catch {}
}

process.on('SIGINT', async () => { await teardown(); process.exit(130); });
main().catch(async (e) => { console.error('FATAL', e); await teardown(); process.exit(1); });
