// #149 STEP 3 — the PACKAGED-APP wake-latency acceptance gate (authoritative).
//
// Proves, on the BUILT AppImage (btrfs, native ABI, real boot order — the only
// arm the ticket calls authoritative), that a lone cross-process `orchestra send`
// triggers the sweep sub-second:
//
//   must-PASS   p95 latency (send → the watcher's "WAL event → sweep scheduled"
//               debug line) < 2s over 20 lone sends.
//   must-FAIL   the SAME rig with ORCHESTRA_BUS_WATCHER=off: the watcher never
//               arms, so NO "WAL event" line ever appears — latency reverts to
//               the 60s sweep. This is what proves the watcher (not some other
//               path) buys the sub-second wake.
//
// The latency observable is a DEBUG log line the watcher emits on every WAL
// event (bus-wake.ts `fire()`), off at the shipped `info` level and turned on
// here with ORCHESTRA_LOG_LEVEL=debug — so no roster/run/workspace seeding is
// needed: the watcher fires on the raw filesystem event, upstream of the sweep's
// pending predicate and the (OFF this wave) wake switch.
//
// Windows open ONLY inside a second headless sway (headless-sway-e2e). env -i
// allowlist, DISPLAY unset. Rig hygiene: its OWN ORCHESTRA_HOME under real disk
// (btrfs), never the live ~/.orchestra/bus.sqlite.
//
// Usage: node scripts/verify-149-wake-latency.mjs

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APPIMAGE = path.join(ROOT, 'release', 'Orchestra.AppImage');
const CLI = path.join(ROOT, 'dist-electron', 'cli.js');
const ELECTRON = path.join(ROOT, 'node_modules', '.bin', 'electron');
const N_SENDS = 20;
const P95_BUDGET_MS = 2000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function fail(msg) {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

// Work under real disk (btrfs), NOT tmpfs: the #149 defect is filesystem-specific
// and a ~300 MB AppImage extract exhausts /tmp. Mirror verify-bus-packaged-boot.sh.
const RIG_ROOT = process.env.ORCHESTRA_HOME
  ? path.dirname(process.env.ORCHESTRA_HOME)
  : os.homedir();
const WORK = fs.mkdtempSync(path.join(RIG_ROOT, '.orchestra-wake149-rig-'));
const SWAY_SOCK = path.join(WORK, 'sway.sock');
let swayPid = null;
const children = [];

function cleanup() {
  for (const c of children) {
    try { c.kill('SIGKILL'); } catch { /* gone */ }
  }
  if (swayPid) { try { process.kill(swayPid, 'SIGKILL'); } catch { /* gone */ } }
  if (!process.env.KEEP_WORK) fs.rmSync(WORK, { recursive: true, force: true });
  else console.log(`  (kept rig dir: ${WORK})`);
}
process.on('exit', cleanup);

// ── artifact identity: refuse a stale binary ────────────────────────────────
if (!fs.existsSync(APPIMAGE)) fail(`no built AppImage at ${APPIMAGE} — run pnpm run build first`);
{
  const stale = spawnSync(
    'find',
    [path.join(ROOT, 'src', 'main'), '-name', '*.ts', '-newer', APPIMAGE, '-print', '-quit'],
    { encoding: 'utf8' },
  ).stdout.trim();
  if (stale) fail(`STALE BUILD: source newer than the AppImage (${stale}) — run pnpm run build`);
}
if (!fs.existsSync(CLI)) fail(`MISSING ${CLI} — run pnpm run build:cli`);
if (!fs.existsSync(ELECTRON)) fail(`MISSING ${ELECTRON} — run pnpm install`);
const fsType = spawnSync('findmnt', ['-no', 'FSTYPE', '-T', WORK], { encoding: 'utf8' }).stdout.trim();
console.log(`[rig] AppImage      ${APPIMAGE} (${(fs.statSync(APPIMAGE).size / 1e6).toFixed(1)} MB)`);
console.log(`[rig] rig home fs   ${fsType}${fsType !== 'btrfs' ? '  (WARNING: not btrfs — the defect may not reproduce)' : ''}`);

// ── 1. our own headless sway ────────────────────────────────────────────────
fs.writeFileSync(path.join(WORK, 'sway.conf'), 'output HEADLESS-1 resolution 1600x1000\n');
{
  const sway = spawn('sway', ['-c', path.join(WORK, 'sway.conf')], {
    env: { ...process.env, WLR_BACKENDS: 'headless', WLR_LIBINPUT_NO_DEVICES: '1', WAYLAND_DISPLAY: '', SWAYSOCK: SWAY_SOCK },
    stdio: ['ignore', fs.openSync(path.join(WORK, 'sway.log'), 'w'), fs.openSync(path.join(WORK, 'sway.log'), 'a')],
    detached: false,
  });
  swayPid = sway.pid;
  children.push(sway);
}
for (let i = 0; i < 50 && !fs.existsSync(SWAY_SOCK); i++) await sleep(200);
if (!fs.existsSync(SWAY_SOCK)) fail(`sway socket never appeared (see ${WORK}/sway.log)`);

// Identify OUR display by an active marker (mirror the boot rig). A unique colour
// painted through our socket, then find which wayland-N reads it back.
const RIG_PID = process.pid;
const markR = 255;
const markG = Math.floor(RIG_PID / 251) % 256;
const markB = (RIG_PID % 251) + 5;
const marker = `FF${markG.toString(16).padStart(2, '0').toUpperCase()}${markB.toString(16).padStart(2, '0').toUpperCase()}`;
spawnSync('swaymsg', ['--', `output HEADLESS-1 background #${marker} solid_color`], { env: { ...process.env, SWAYSOCK: SWAY_SOCK } });
await sleep(500);
let myDisplay = null;
for (let n = 1; n <= 8; n++) {
  const shot = path.join(WORK, `marker-${n}.png`);
  const g = spawnSync('grim', ['-o', 'HEADLESS-1', shot], { env: { ...process.env, WAYLAND_DISPLAY: `wayland-${n}` } });
  if (g.status !== 0 || !fs.existsSync(shot) || fs.statSync(shot).size === 0) continue;
  const pct = spawnSync('python3', ['-c', `
import sys
from PIL import Image
try: im = Image.open(${JSON.stringify(shot)}).convert('RGB').resize((40,25))
except Exception: print(0); sys.exit()
px=list(im.getdata()); hit=sum(1 for (r,g,b) in px if abs(r-${markR})<20 and abs(g-${markG})<20 and abs(b-${markB})<20)
print(round(100*hit/len(px)))`], { encoding: 'utf8' }).stdout.trim();
  if (Number(pct) >= 90) {
    if (myDisplay) fail(`two displays read the marker (${myDisplay} and wayland-${n}) — cannot disambiguate`);
    myDisplay = `wayland-${n}`;
  }
}
if (!myDisplay) fail('could not identify our own sway display by marker');
console.log(`[rig] our display   ${myDisplay} (marker #${marker})`);

// ── launching the app and driving the CLI ───────────────────────────────────

function bootApp(home, watcherOff) {
  fs.mkdirSync(home, { recursive: true });
  const env = {
    HOME: home,
    PATH: '/usr/bin:/bin',
    XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid()}`,
    WAYLAND_DISPLAY: myDisplay,
    ELECTRON_OZONE_PLATFORM_HINT: 'wayland',
    ORCHESTRA_HOME: path.join(home, '.orchestra'),
    ORCHESTRA_LOG_LEVEL: 'debug',
  };
  if (watcherOff) env.ORCHESTRA_BUS_WATCHER = 'off';
  const child = spawn(APPIMAGE, ['--ozone-platform=wayland', '--no-sandbox'], {
    env, // env -i shape: only the allowlist above, DISPLAY unset
    stdio: ['ignore', fs.openSync(path.join(WORK, `${path.basename(home)}.stdout`), 'w'), fs.openSync(path.join(WORK, `${path.basename(home)}.stdout`), 'a')],
  });
  children.push(child);
  return { child, applog: path.join(home, '.orchestra', 'logs', 'orchestra.log'), busHome: path.join(home, '.orchestra') };
}

async function waitForLogLine(applog, re, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(applog)) {
      const txt = fs.readFileSync(applog, 'utf8');
      const m = txt.split('\n').find((l) => re.test(l));
      if (m) return m;
    }
    await sleep(200);
  }
  return null;
}

// A lone cross-process send via the built CLI under real Electron (abi130), with
// ORCHESTRA_HOME pinned to the app's home so it writes the SAME bus.
function cliSend(busHome, i) {
  const mainJs = path.join(WORK, `cli-main-${i}.cjs`);
  // A BROADCAST (no --to) is a lone WAL write with NO workspace-store dependency:
  // the #144 recipient canonicalizer only runs when --to is present, so an empty
  // rig store (no workspaces) does not refuse it. The watcher fires on the WAL
  // write regardless of recipient — which is exactly the latency we measure.
  fs.writeFileSync(mainJs,
    `const { app } = require('electron');
     app.disableHardwareAcceleration();
     app.whenReady().then(async () => {
       const { runCli } = require(${JSON.stringify(CLI)});
       await runCli(['send','--type','status','--as','ops','lone-'+${i}]);
     });`);
  const r = spawnSync(ELECTRON, [mainJs, '--no-sandbox', '--ozone-platform=wayland'], {
    // The CLI runs inside a real Electron main process (app.whenReady), which must
    // init a platform — point it at OUR headless display (it opens no window; the
    // runCli call exits). DISPLAY stays UNSET so nothing can reach the human.
    env: {
      HOME: process.env.HOME,
      PATH: '/usr/bin:/bin',
      XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid()}`,
      WAYLAND_DISPLAY: myDisplay,
      ELECTRON_OZONE_PLATFORM_HINT: 'wayland',
      ORCHESTRA_HOME: busHome,
      ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
    },
    encoding: 'utf8',
    timeout: 60_000,
  });
  if (r.status !== 0 && process.env.KEEP_WORK) {
    console.error(`  [cliSend ${i}] rc=${r.status} stderr: ${(r.stderr || '').split('\n').slice(-4).join(' | ')}`);
  }
  return r.status === 0;
}

// Parse the ISO timestamp off a log line: "2026-09-16T10:20:30.123Z [DEBUG] …".
function tsOf(line) {
  const m = line.match(/^(\S+)\s/);
  return m ? Date.parse(m[1]) : NaN;
}

// Count how many "WAL event → sweep scheduled" lines exist in the log right now.
function countWalEvents(applog) {
  if (!fs.existsSync(applog)) return 0;
  return fs.readFileSync(applog, 'utf8').split('\n').filter((l) => /WAL event → sweep scheduled/.test(l)).length;
}
function lastWalEventLine(applog) {
  if (!fs.existsSync(applog)) return null;
  const hits = fs.readFileSync(applog, 'utf8').split('\n').filter((l) => /WAL event → sweep scheduled/.test(l));
  return hits.length ? hits[hits.length - 1] : null;
}

// ── ARM A — must-PASS: the watcher is ON, latency p95 < 2s ──────────────────
console.log('\n── ARM A (must-PASS): watcher ON, measure send→watcher-event latency ──');
const A = bootApp(path.join(WORK, 'home-on'), false);
const armed = await waitForLogLine(A.applog, /WAL accelerator armed on directory/, 180_000);
if (!armed) fail('ARM A: the packaged app never logged "WAL accelerator armed on directory" — the fix did not ship or the app did not boot');
console.log(`  armed: ${armed.trim()}`);
// Confirm it is the DIRECTORY watch, not an inode watch (the shipped-symbol check).
if (!/armed on directory .+ \(filter .*-wal\)/.test(armed)) fail('ARM A: the armed line is not the directory-watch shape');

const latencies = [];
for (let i = 0; i < N_SENDS; i++) {
  const before = countWalEvents(A.applog);
  const t0 = Date.now();
  const ok = cliSend(A.busHome, i);
  if (!ok) fail(`ARM A: cliSend ${i} failed`);
  // Wait for the NEXT WAL-event line to appear, then time it by its log timestamp.
  const deadline = Date.now() + 5000;
  let line = null;
  while (Date.now() < deadline) {
    if (countWalEvents(A.applog) > before) { line = lastWalEventLine(A.applog); break; }
    await sleep(15);
  }
  if (!line) fail(`ARM A: send ${i} produced NO watcher event within 5s — the watcher is not firing`);
  const lat = tsOf(line) - t0;
  // Guard against clock skew between the CLI child and the app; floor at 0.
  latencies.push(Math.max(0, lat));
  await sleep(250); // let the debounce settle before the next lone send
}
latencies.sort((a, b) => a - b);
const p95 = latencies[Math.min(latencies.length - 1, Math.ceil(0.95 * latencies.length) - 1)];
const p50 = latencies[Math.floor(0.5 * latencies.length)];
console.log(`  latencies (ms) sorted: ${latencies.join(', ')}`);
console.log(`  p50=${p50}ms  p95=${p95}ms  max=${latencies[latencies.length - 1]}ms  over ${N_SENDS} lone sends`);
A.child.kill('SIGKILL');
await sleep(500);
const armAPass = p95 < P95_BUDGET_MS;
console.log(`  ARM A verdict: p95 ${p95}ms ${armAPass ? '<' : '>='} ${P95_BUDGET_MS}ms → ${armAPass ? 'PASS' : 'FAIL'}`);

// ── ARM B — must-FAIL control: watcher OFF, NO watcher events at all ─────────
console.log('\n── ARM B (must-FAIL): ORCHESTRA_BUS_WATCHER=off → no sub-2s trigger ──');
const B = bootApp(path.join(WORK, 'home-off'), true);
const disabled = await waitForLogLine(B.applog, /WAL accelerator DISABLED .*ORCHESTRA_BUS_WATCHER=off/, 180_000);
if (!disabled) fail('ARM B: the app did not log the accelerator DISABLED line — the must-FAIL lever did not engage');
console.log(`  disabled: ${disabled.trim()}`);
const beforeB = countWalEvents(B.applog);
for (let i = 0; i < N_SENDS; i++) {
  if (!cliSend(B.busHome, i)) fail(`ARM B: cliSend ${i} failed`);
  await sleep(100);
}
await sleep(3000); // ample time for any (absent) watcher event to appear
const afterB = countWalEvents(B.applog);
const armBPass = afterB === beforeB; // ZERO watcher events with the watcher off
console.log(`  WAL-event lines with watcher OFF: ${afterB - beforeB} (expected 0)`);
console.log(`  ARM B verdict: ${armBPass ? 'PASS — reverts to the 60s sweep, no sub-2s trigger' : 'FAIL — watcher fired while disabled'}`);
B.child.kill('SIGKILL');
await sleep(500);

// ── overall ─────────────────────────────────────────────────────────────────
console.log('\n══ #149 packaged wake-latency gate ══');
console.log(`  ARM A must-PASS (watcher ON, p95<2s):   ${armAPass ? 'PASS' : 'FAIL'}  (p95=${p95}ms)`);
console.log(`  ARM B must-FAIL (watcher OFF, 0 events): ${armBPass ? 'PASS' : 'FAIL'}`);
if (armAPass && armBPass) {
  console.log('#149 packaged wake-latency: PASS');
  process.exit(0);
}
fail('#149 packaged wake-latency gate did not pass both arms');
