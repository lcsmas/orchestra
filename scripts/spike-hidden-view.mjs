// #402 hidden-view spike harness. Runs INSIDE the contained rig (scripts/spike-hidden-view.sh): own headless sway,
// scratch HOME. For every arm x N iterations it launches ONE fresh Electron (scripts/spike-hidden-view-main.cjs),
// collects its SPIKE_RESULT json, then prints the matrix + a verdict per arm. At most one Electron at a time.
// Usage (via the .sh): spike-hidden-view.sh <repo-dir> [--arms a,b,…|all] [--n 5] [--window 8] [--out dir] [--resume] [--summarize-only] [--markdown]
//   knobs: --mutant noflip (instrument self-test, must turn the control red) · --leak-sampler (grim all through the hidden phase) · --skip screencast,framesub (no phase-2 instruments) · --p2-ms 0 (capture right after the throttling toggle)
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import os from 'node:os';
import { privateRuntimeDir, handedEnvProblems } from './lib/rig-runtime.mjs'; // incident Q2: the child gets the rig's PRIVATE runtime dir, never the human's runtime dir

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const REPO = path.resolve(argv[0] || '');
const flag = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const SUMMARIZE_ONLY = argv.includes('--summarize-only'); // re-print the matrix from <out>/*/result.json; no rig needed
const N = Number(flag('--n', '5')), WINDOW = Number(flag('--window', '8')); // timers throttle to ~1/s from the first second hidden (measured), so 8 s is enough; --window 24 re-checks the long tail
const RIG_DIR = process.env.RIG_DIR, RIG_WAYLAND = process.env.RIG_WAYLAND;
const refuse = (m) => { console.error('ABORT: ' + m); process.exit(2); };
if (!SUMMARIZE_ONLY && (!RIG_DIR || !RIG_WAYLAND)) refuse('RIG_DIR / RIG_WAYLAND unset — run via scripts/spike-hidden-view.sh (the contained rig)');
if (!SUMMARIZE_ONLY && process.env.DISPLAY) refuse('DISPLAY set — X11 would reach the human');
if (!SUMMARIZE_ONLY && (process.env.WAYLAND_DISPLAY !== RIG_WAYLAND || RIG_WAYLAND === 'wayland-1')) refuse(`WAYLAND_DISPLAY=${process.env.WAYLAND_DISPLAY} != marker-verified ${RIG_WAYLAND}`);
const ELECTRON = path.join(REPO, 'node_modules/electron/dist/electron');
const SPIKE_BUS = SUMMARIZE_ONLY ? '' : (() => { const b = process.env.DBUS_SESSION_BUS_ADDRESS ?? ''; if (!b.startsWith(`unix:path=${RIG_DIR}/`)) refuse(`DBUS_SESSION_BUS_ADDRESS=${b || '<unset>'} is not the rig's nonexistent session bus under ${RIG_DIR}`); return b; })();
const SPIKE_XDG = SUMMARIZE_ONLY ? '' : (() => { try { return privateRuntimeDir(); } catch (e) { refuse(e.message); } })();
if (!SUMMARIZE_ONLY && !fs.existsSync(ELECTRON)) refuse(`${ELECTRON} missing — pnpm install first`);
const OUT = flag('--out', path.join(RIG_DIR || '.', 'spike'));
fs.mkdirSync(OUT, { recursive: true });

const BASE_ARMS = ['ctl-visible', 'm1-multi-hidden', 'a1-detached-never', 'a2-detached-after-shown', 'b1-hidden-window', 'b2-hidden-window-view', 'c1-rehost-moved', 'c2-rehost-wrapped', 'c3-rehost-basewindow', 'c4-rehost-browserview', 'd1-setvisible-false', 'd2-setvisible-false-first', 'e1-offscreen-window', 'e2-offscreen-view'];
const BT0 = ['a1-detached-never', 'a2-detached-after-shown', 'b1-hidden-window', 'b2-hidden-window-view', 'c1-rehost-moved', 'd1-setvisible-false', 'd2-setvisible-false-first', 'e1-offscreen-window'].map((a) => a + '-bt0');
// product-relevant extras (still N runs): throttling toggled on demand, resize while hidden, and the human-in-another-workspace case
const EXTRA = ['d3-setvisible-false-bt-on-demand', 'd5-resize-while-hidden-bt0', 'ctl-visible+away', 'd1-setvisible-false-bt0+away', 'e1-offscreen-window+away'];
// informational (N=3): crash probe, first-paint/occlusion/retry questions for a NEW background tab, clipped/zero bounds, concealment trick, Chromium no-throttle switches
const INFO = ['e1-offscreen-window-fs0', 'd4-tiny-first-paint-bt0', 'g1-occluded-new', 'g2-occluded-then-hidden-bt0', 'd1-setvisible-false-bt0+retry', 'd2-setvisible-false-first-bt0+retry', 'g1-occluded-new+retry', 'g2-occluded-then-hidden-bt0+retry', 'a1-detached-never-bt0+retry', 'f1-clipped-bounds', 'f2-zero-bounds', 'x1-showinactive-opacity0', 'b1-hidden-window-bt0+sw', 'c1-rehost-moved-bt0+sw', 'd1-setvisible-false-bt0+sw'];
// --arms key: the regression subset (positive control, the app's two current paths, the candidate design, OSR, the away case) with --assert
const KEY = ['ctl-visible', 'm1-multi-hidden', 'a1-detached-never', 'a2-detached-after-shown', 'b1-hidden-window', 'c1-rehost-moved', 'd1-setvisible-false', 'd1-setvisible-false-bt0', 'd2-setvisible-false-first-bt0', 'd3-setvisible-false-bt-on-demand', 'e1-offscreen-window', 'ctl-visible+away', 'd1-setvisible-false-bt0+away'];
const EXPECT = { 'ctl-visible': /^PAINTS \(/, 'm1-multi-hidden': /^PAINTS-ON-DEMAND/, 'a1-detached-never': /^NO FRAMES/, 'a2-detached-after-shown': /^NO FRAMES/, 'b1-hidden-window': /^NO FRAMES/, 'c1-rehost-moved': /^(ONE-SHOT|NO FRAMES)/, 'd1-setvisible-false': /^PARTIAL/, 'd1-setvisible-false-bt0': /^PAINTS-ON-DEMAND/, 'd2-setvisible-false-first-bt0': /^NO FRAMES/, 'd3-setvisible-false-bt-on-demand': /^PAINTS-ON-DEMAND/, 'e1-offscreen-window': /^PAINTS \(/, 'ctl-visible+away': /^NO FRAMES/, 'd1-setvisible-false-bt0+away': /^NO FRAMES/ };
const SW = 'disable-renderer-backgrounding,disable-background-timer-throttling,disable-backgrounding-occluded-windows';
const armsFlag = flag('--arms', 'all');
const ARMS0 = armsFlag === 'all' ? [...BASE_ARMS, ...BT0, ...EXTRA, ...INFO] : armsFlag === 'key' ? KEY : armsFlag.split(',');
const ARMS = ARMS0.includes('ctl-visible') ? ARMS0 : ['ctl-visible', ...ARMS0]; // the positive-control gate must exist in EVERY run
const N_INFO = Math.min(N, 3); // informational arms (not in the ticket's list) run fewer times
const nFor = (arm) => (INFO.includes(arm) && armsFlag === 'all' ? N_INFO : N);
const RESUME = argv.includes('--resume');

// G10-style hygiene: sha256 of the human's live config files (read-only) before/after; agents' normal churn on .claude.json may differ.
const REAL_HOME = os.userInfo().homedir;
const liveHashes = () => { const out = {}; const dirs = fs.readdirSync(REAL_HOME).filter((n) => /^\.claude(-[\w-]+)?$/.test(n)).map((n) => path.join(REAL_HOME, n)); dirs.push(path.join(REAL_HOME, '.config/orchestra'));
  for (const d of dirs) for (const f of ['settings.json', '.credentials.json', '.claude.json', 'CLAUDE.md', 'config.json', 'settings.local.json']) { const fp = path.join(d, f); try { if (fs.statSync(fp).isFile()) out[fp] = crypto.createHash('sha256').update(fs.readFileSync(fp)).digest('hex').slice(0, 16); } catch {} } return out; };
const HASH_BEFORE = SUMMARIZE_ONLY ? {} : liveHashes(); // never opens the live config files in --summarize-only
const sh = (cmd, args, opt = {}) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opt });
if (!SUMMARIZE_ONLY) try { sh('swaymsg', ['output', 'HEADLESS-1', 'resolution', '1400x900']); sh('swaymsg', ['default_border', 'none']); } catch (e) { refuse('swaymsg on the rig sway failed: ' + e.message); }

async function runOne(arm, iter) {
  const dir = path.join(OUT, `${arm.replace(/[^\w.+-]/g, '_')}-${iter}`);
  fs.mkdirSync(dir, { recursive: true });
  if (RESUME && fs.existsSync(path.join(dir, 'result.json'))) return JSON.parse(fs.readFileSync(path.join(dir, 'result.json'), 'utf8'));
  const fakeHome = path.join(dir, 'home'); fs.mkdirSync(fakeHome, { recursive: true });
  const env = {
    PATH: '/usr/local/bin:/usr/bin:/bin', HOME: fakeHome, XDG_RUNTIME_DIR: SPIKE_XDG, DBUS_SESSION_BUS_ADDRESS: SPIKE_BUS,
    XDG_CONFIG_HOME: path.join(fakeHome, '.config'), XDG_CACHE_HOME: path.join(fakeHome, '.cache'),
    WAYLAND_DISPLAY: RIG_WAYLAND, SWAYSOCK: process.env.SWAYSOCK, ELECTRON_OZONE_PLATFORM_HINT: 'wayland',
    SPIKE_ARM: arm, SPIKE_OUT: dir, SPIKE_WINDOW_S: String(WINDOW),
    SPIKE_ORDER: iter % 2 ? 'rev' : 'fwd', SPIKE_SWITCHES: /\+sw/.test(arm) ? SW : '',
    SPIKE_MUTANT: flag('--mutant', ''), SPIKE_P2_MS: flag('--p2-ms', '4000'), SPIKE_LEAK_SAMPLER: argv.includes('--leak-sampler') ? '1' : '0', // knobs are CLI flags: the rig's env -i strips anything exported outside
    SPIKE_SKIP: flag('--skip', '') || (/^e\d/.test(arm) && !/-fs0/.test(arm) ? 'cap:cdpScreenshot_fromSurfaceFalse' : ''), // OSR + fromSurface:false = SIGSEGV; the -fs0 arm records it
  };
  if ('DISPLAY' in env || env.WAYLAND_DISPLAY !== RIG_WAYLAND) refuse('child env would reach the human display');
  const handed = handedEnvProblems(env, { ohome: env.ORCHESTRA_HOME, cfg: env.CLAUDE_CONFIG_DIR, home: fakeHome, wayland: RIG_WAYLAND, xdg: SPIKE_XDG, noBusPath: SPIKE_BUS.replace(/^unix:path=/, '') }); // shared contract check (bare Electron: no ORCHESTRA_HOME / CLAUDE_CONFIG_DIR handed)
  if (handed.length) refuse(`child env violates the rig runtime contract: ${handed.join('; ')}`);
  const child = spawn(ELECTRON, [path.join(HERE, 'spike-hidden-view-main.cjs'), '--ozone-platform=wayland'], { cwd: REPO, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  let out = ''; child.stdout.on('data', (d) => { out += d; }); child.stderr.on('data', (d) => { out += d; });
  const exited = new Promise((res) => child.on('exit', (code, sig) => res({ code, sig })));
  const timer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 170000);
  const ex = await exited; clearTimeout(timer);
  for (const d of ['home', 'userData']) fs.rmSync(path.join(dir, d), { recursive: true, force: true }); // Chromium profile dirs: not evidence, ~10 MB each
  try { process.kill(-child.pid, 'SIGKILL'); } catch {} // the group may hold GPU/zygote stragglers
  fs.writeFileSync(path.join(dir, 'out.txt'), out);
  for (const d of ['home', 'userData']) fs.rmSync(path.join(dir, d), { recursive: true, force: true });
  const line = out.split('\n').find((l) => l.startsWith('SPIKE_RESULT '));
  if (!line) { const r = { arm, iter, valid: false, error: `no SPIKE_RESULT; exit=${ex.code} signal=${ex.sig}; last step: ${(out.match(/SPIKE_STEP (\S+)/g) || []).pop() || 'none'}; tail: ` + out.split('\n').filter((l) => !/bus\.cc|SPIKE_STEP/.test(l)).join('\n').slice(-400) }; fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify(r, null, 1)); return r; }
  const r = JSON.parse(line.slice('SPIKE_RESULT '.length)); r.iter = iter; fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify(r, null, 1));
  return r;
}

// ---- aggregation --------------------------------------------------------------------------------
const med = (a) => { const s = a.filter((x) => typeof x === 'number').sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null; };
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const tally = (rs, get) => { const t = {}; for (const r of rs) { const v = get(r) ?? 'n/a'; t[v] = (t[v] || 0) + 1; } return Object.entries(t).map(([k, v]) => `${k}×${v}`).join(' '); };
const capKind = (c) => (!c ? 'n/a' : c.outcome === 'ok' ? c.kind : c.outcome);
const rate = (arr, from, to) => { const s = (arr || []).slice(from, to); return s.length ? mean(s) : null; };
const f1 = (x) => (x === null || x === undefined ? 'n/a' : (+x).toFixed(1));

function summarize(arm, rs) {
  const valid = rs.filter((r) => r.valid), bad = rs.length - valid.length;
  const p = (get) => med(valid.map(get));
  const caps = ['capturePage', 'cdpScreenshot', 'cdpScreenshot_fromSurfaceFalse', 'cdpScreenshot_captureBeyondViewport', 'invalidate_then_capturePage', 'lastPaintBitmap'];
  const row = {
    arm, n: rs.length, valid: valid.length, invalid: bad, desc: rs.find((r) => r.desc)?.desc,
    vis: tally(valid, (r) => r.phase1?.visibilityState),
    raf_0_10: p((r) => rate(r.phase1?.rafPerSec, 0, 10)), raf_10_end: p((r) => rate(r.phase1?.rafPerSec, 10)),
    timer_0_10: p((r) => rate(r.phase1?.timerPerSec, 0, 10)), timer_10_end: p((r) => rate(r.phase1?.timerPerSec, 10)),
    screencast: p((r) => r.phase2?.screencastFrames), frameSub: p((r) => r.phase2?.frameSubscriptionCallbacks), paint: p((r) => r.phase2?.paintEvents),
    raf_p2: p((r) => r.phase2?.raf),
    leakAB: Math.max(0, ...valid.flatMap((r) => ['grim_hidden', 'grim_during_capture', 'grim_after_captures'].map((k) => (r[k]?.A ?? 0) + (r[k]?.B ?? 0)))), sway_windows: tally(valid, (r) => r.sway_windows_hidden),
    caps: Object.fromEntries(caps.map((c) => [c, tally(valid, (r) => capKind(r.captures?.[c]))])),
    inputHidden: tally(valid, (r) => { const d = r.input?.deliveredWhileHidden; return d ? `click${d.mouse} type${d.typed === 'hello' ? 'OK' : JSON.stringify(d.typed)} wheel${d.scrollY > 0 ? 'OK' : 0}` : 'n/a'; }),
    inputDispatch: tally(valid, (r) => r.input ? `${r.input.dispatch.click.join('+')}|${r.input.dispatch.type.join('+')}|${r.input.dispatch.wheel.join('+')}` : 'n/a'),
    inputAfterShow: tally(valid, (r) => { const d = r.input?.deliveredByAfterShow; return d ? `click${d.mouse} type${d.typed === 'hello' ? 'OK' : JSON.stringify(d.typed)} wheel${d.scrollY > 0 ? 'OK' : 0}` : 'n/a'; }),
    neighbors: valid.some((r) => r.neighbors?.v0) ? { v0_raf_per_s_median: p((r) => r.neighbors?.v0?.rafPerSec), v0_mouse_events_max: Math.max(...valid.map((r) => r.neighbors?.v0?.mouseDelta ?? 0)), v0_input_events_max: Math.max(...valid.map((r) => r.neighbors?.v0?.inputEvents ?? 0)), v0_typed: tally(valid, (r) => JSON.stringify(r.neighbors?.v0?.typed)), v0_scrollY_max: Math.max(...valid.map((r) => r.neighbors?.v0?.scrollY ?? 0)), v0_capture: tally(valid, (r) => r.neighbors?.v0?.capturePage && `A${r.neighbors.v0.capturePage.A}`), v2_capture: tally(valid, (r) => r.neighbors?.v2?.capturePage && `A${r.neighbors.v2.capturePage.A}/B${r.neighbors.v2.capturePage.B}`) } : undefined,
    leakSampler: valid.some((r) => r.leak_sampler) ? tally(valid, (r) => r.leak_sampler ? `post-hide max ${((r.leak_sampler.maxAB ?? 0) * 100).toFixed(1)}% over ${r.leak_sampler.postHide} samples (${r.leak_sampler.over1pct} >1%; ${r.leak_sampler.preHideOrSettling} pre-hide/settling max ${((r.leak_sampler.preMaxAB ?? 0) * 100).toFixed(0)}%)` : 'n/a') : undefined,
    inCount: { click: valid.filter((r) => r.input?.deliveredWhileHidden?.mouse > 0).length, type: valid.filter((r) => r.input?.deliveredWhileHidden?.typed === 'hello').length, wheel: valid.filter((r) => r.input?.deliveredWhileHidden?.scrollY > 0).length },
    retry: valid.some((r) => r.retry) ? tally(valid, (r) => r.retry ? `capturePage ${r.retry.firstFreshMs === null ? `never fresh in ${r.retry.attempts} tries` : `fresh after ${r.retry.firstFreshMs} ms`}; beyondViewport ${r.retry.beyondFirstFreshMs === null || r.retry.beyondFirstFreshMs === undefined ? 'never fresh' : `fresh after ${r.retry.beyondFirstFreshMs} ms`}` : 'n/a') : undefined,
    recovers: tally(valid, (r) => (r.recovers ? 'show-back OK' : 'WEDGED (show-back capture failed)')),
    firstCapture: tally(valid, (r) => { const k = Object.keys(r.captures || {}).filter((x) => x !== 'lastPaintBitmap')[0]; return k ? `${k}:${capKind(r.captures[k])}` : 'n/a'; }),
    errors: [...new Set(rs.flatMap((r) => (r.errors || []).concat(r.error ? [r.error.slice(0, 160)] : [])))].slice(0, 5),
  };
  const freshAll = (c) => valid.length > 0 && valid.every((r) => capKind(r.captures?.[c]) === 'fresh');
  const freshAny = (c) => valid.some((r) => capKind(r.captures?.[c]) === 'fresh');
  const frames = (row.raf_0_10 ?? 0) >= 30 && ((row.screencast ?? 0) > 0 || (row.paint ?? 0) > 0);
  // ONE-SHOT: whichever capture ran FIRST was fresh in every valid run, and no later one ever was (the order alternates per iteration)
  const firstFresh = (r) => { const ks = Object.keys(r.captures || {}).filter((x) => x !== 'lastPaintBitmap'); return ks.length && capKind(r.captures[ks[0]]) === 'fresh'; };
  const laterFresh = (r) => Object.keys(r.captures || {}).filter((x) => x !== 'lastPaintBitmap').slice(1).some((k) => capKind(r.captures[k]) === 'fresh');
  const oneShot = valid.length > 1 && valid.every(firstFresh) && !valid.some(laterFresh);
  const anyCap = caps.slice(0, 5).some(freshAny), allCap = freshAll('capturePage') && freshAll('cdpScreenshot');
  const crashed = rs.filter((r) => /signal=SIG/.test(r.error || ''));
  const unsupp = rs.filter((r) => r.hideError || r.makeError).map((r) => r.hideError || r.makeError);
  const refused = rs.filter((r) => r.hideError).map((r) => r.hideError);
  row.verdict = refused.length === rs.length ? `UNSUPPORTED (Electron refuses: ${refused[0]})` : crashed.length === rs.length ? `CRASH (${crashed.length}/${rs.length} runs: ${(crashed[0].error.match(/signal=\w+/) || [''])[0]}, ${(crashed[0].error.match(/last step: SPIKE_STEP \S+/) || [''])[0].replace('last step: SPIKE_STEP ', 'during ')})` : valid.length === 0 && unsupp.length === rs.length ? `UNSUPPORTED (${unsupp[0]})` : valid.length === 0 ? 'INVALID (no valid run)' : allCap && frames ? 'PAINTS (frames + both captures fresh)'
    : allCap ? 'PAINTS-ON-DEMAND (captures fresh, no continuous frames)'
    : oneShot ? 'ONE-SHOT (only the first capture in each run is fresh, every later one hangs)'
    : anyCap ? 'PARTIAL (some capture oracle fresh: ' + caps.slice(0, 5).filter(freshAny).join(',') + ')' : 'NO FRAMES';
  if (!refused.length && !/^e\d/.test(arm) && valid.length && valid.some((r) => !r.recovers)) row.verdict += ` · WEDGED after capture in ${valid.filter((r) => !r.recovers).length}/${valid.length} runs (show-back capture failed)`;
  return row;
}

const all = {};
const t0 = Date.now();
const runDir = (arm, i) => path.join(OUT, `${arm.replace(/[^\w.+-]/g, '_')}-${i}`);
if (!SUMMARIZE_ONLY) {
  // ITERATION-MAJOR: every arm's run i happens before any arm's run i+1, so slow drift of host load hits all arms alike.
  for (let i = 0; i < N; i++) {
    for (const arm of ARMS) {
      if (i >= nFor(arm)) continue;
      const r = await runOne(arm, i);
      console.error(`[spike] ${arm} #${i} valid=${r.valid} capturePage=${capKind(r.captures?.capturePage)} raf0-10=${f1(rate(r.phase1?.rafPerSec, 0, 10))}/s ${r.error ? 'ERR ' + String(r.error).slice(0, 160) : ''}`);
    }
  }
}
// The matrix is always built FROM DISK (every result.json under OUT), so interrupted runs can be --resume'd and merged.
// INSTRUMENT validity is recomputed here from the recorded evidence (not trusted from the probe): the page was alive, and
// the object was READABLE when it should have been — arms that start composited need their PRE-hide control to read colour A;
// never-visible arms need the show-back capture to read the fresh colour (offscreen arms: page liveness + e1 as the OSR control).
// A failed show-back after a hang on a composited-at-start arm is a RESULT ("wedged"), reported in `recovers`, not an invalid run.
function revalidate(r) {
  if (!r.phase1 || r.error && !r.phase1) return false;
  const alive = !!r.phase1?.timerPerSec?.some((n) => n > 0);
  const okPre = r.pre?.capturePage?.outcome === 'ok' && (r.pre.capturePage.A >= 0.5 || (/^d4/.test(r.arm) && r.pre.capturePage.w > 0)); // d4: the tiny first paint only has to EXIST (2x2); its colour is recorded in rgb
  const okPost = r.postShow?.capturePage?.outcome === 'ok' && r.postShow.capturePage.kind === 'fresh';
  r.recovers = okPost;
  return alive && (r.pre ? okPre : /^e\d/.test(r.arm) ? true : okPost);
}
const ORDER = [...BASE_ARMS, ...BT0, ...EXTRA, ...INFO];
for (const arm of ORDER) {
  const rs = [];
  for (let i = 0; i < 50; i++) { const f = path.join(runDir(arm, i), 'result.json'); if (fs.existsSync(f)) { const r = JSON.parse(fs.readFileSync(f, 'utf8')); r.validProbe = r.valid; r.valid = revalidate(r); rs.push(r); } }
  if (rs.length) all[arm] = rs;
}
const rows = Object.entries(all).map(([a, rs]) => summarize(a, rs));
fs.writeFileSync(path.join(OUT, 'matrix.json'), JSON.stringify({ electron: Object.values(all)[0]?.[0]?.electron, chrome: Object.values(all)[0]?.[0]?.chrome, n: N, window_s: WINDOW, wall_s: Math.round((Date.now() - t0) / 1000), rows }, null, 1));

console.log(`\nelectron ${Object.values(all)[0]?.[0]?.electron} (chrome ${Object.values(all)[0]?.[0]?.chrome}) on ${Object.values(all)[0]?.[0]?.wayland ?? RIG_WAYLAND}; N=${N}, hidden window ${WINDOW}s; out ${OUT}\n`);
const hdr = ['arm', 'valid', 'vis', 'rAF/s 0-10|10+', 'timer/s 0-10|10+', 'screencast|frameSub|paint', 'capturePage', 'cdpShot', 'leak', 'verdict'];
console.log(hdr.join(' | '));
for (const r of rows) console.log([r.arm, `${r.valid}/${r.n}`, r.vis, `${f1(r.raf_0_10)}|${f1(r.raf_10_end)}`, `${f1(r.timer_0_10)}|${f1(r.timer_10_end)}`, `${r.screencast}|${r.frameSub}|${r.paint}`, r.caps.capturePage, r.caps.cdpScreenshot, `${(r.leakAB * 100).toFixed(0)}%`, r.verdict].join(' | '));
console.log('\nSecondary oracles + input (per arm):');
for (const r of rows) console.log(`${r.arm}: fromSurface:false ${r.caps.cdpScreenshot_fromSurfaceFalse} · beyondViewport ${r.caps.cdpScreenshot_captureBeyondViewport} · invalidate+capturePage ${r.caps.invalidate_then_capturePage}${r.caps.lastPaintBitmap !== 'n/a×' + r.valid ? ' · lastPaintBitmap ' + r.caps.lastPaintBitmap : ''} · input dispatch ${r.inputDispatch}; delivered hidden ${r.inputHidden}; by after-show ${r.inputAfterShow}; sway windows hidden ${r.sway_windows}${r.errors.length ? ' · errors: ' + r.errors.join(' ; ') : ''}${r.retry ? ' · RETRY ' + r.retry : ''}${r.leakSampler ? ' · LEAK-SAMPLER ' + r.leakSampler : ''}${r.neighbors ? ' · NEIGHBORS ' + JSON.stringify(r.neighbors) : ''}`);
// positive-control gate: the matrix is only meaningful if the visible control painted in every valid run
const ctl = rows.find((r) => r.arm === 'ctl-visible');
// --markdown: the table committed in docs/codebase-map/browser-panel.md (generated from the same result.json files).
if (argv.includes('--markdown')) {
  const k = (t) => (t || 'n/a');
  const verdictShort = (v) => v.replace('cdpScreenshot_captureBeyondViewport', 'beyondViewport').replace('cdpScreenshot_fromSurfaceFalse', 'fromSurface:false').replace('invalidate_then_capturePage', 'invalidate+capturePage').replace('cdpScreenshot', 'cdpShot').replace(/ \(Electron refuses: .*\)/, ' (Electron refuses to wrap an owned webContents)').replace(/ · WEDGED after capture in (\d+\/\d+) runs.*/, ' · wedged after capture $1').replace(/\(captures fresh.*?\)/, '').replace(/\(frames \+ both captures fresh\)/, '').replace(/\(only the first capture.*?\)/, '').trim();
  console.log('\n| arm | valid | capturePage | CDP shot | CDP shot beyondViewport | rAF/s · timers/s | screencast fr./4 s | click · type · wheel landed | leak | verdict |\n|---|---|---|---|---|---|---|---|---|---|');
  for (const r of rows) {
    const refused = /^UNSUPPORTED/.test(r.verdict);
    console.log(`| \`${r.arm}\` | ${r.valid}/${r.n} | ${refused ? '—' : k(r.caps.capturePage)} | ${refused ? '—' : k(r.caps.cdpScreenshot)} | ${refused ? '—' : k(r.caps.cdpScreenshot_captureBeyondViewport)} | ${refused ? '—' : `${f1(r.raf_0_10)} · ${f1(r.timer_0_10)}`} | ${refused ? '—' : (r.screencast ?? 'n/a')} | ${refused ? '—' : `${r.inCount.click} · ${r.inCount.type} · ${r.inCount.wheel}`} | ${(r.leakAB * 100).toFixed(0)}% | ${verdictShort(r.verdict)} |`);
  }
}
// --export-jsonl <file> [--tag <set>] [--append]: compact per-run evidence (one JSON object per run) to commit next to the doc.
{
  const ex = flag('--export-jsonl', null);
  if (ex) {
    const out = [];
    for (const [arm, rs] of Object.entries(all)) for (const r of rs) {
      const caps = Object.fromEntries(Object.entries(r.captures || {}).map(([c, v]) => [c, v.outcome === 'ok' ? `${v.kind}${v.w ? ` ${v.w}x${v.h}` : ''}` : v.outcome]));
      out.push(JSON.stringify({ set: flag('--tag', undefined), arm, iter: r.iter, order: r.order, valid: r.valid, recovers: r.recovers, electron: r.electron, rig: r.wayland === 'wayland-rig' ? 'private' : 'pre-private', vis: r.phase1?.visibilityState, rafPerSec: r.phase1?.rafPerSec, timerPerSec: r.phase1?.timerPerSec, screencast: r.phase2?.screencastFrames, frameSub: r.phase2?.frameSubscriptionCallbacks, paintEvents: r.phase2?.paintEvents, caps, input: r.input, leak: [r.grim_hidden, r.grim_during_capture, r.grim_after_captures].map((g) => g && +((g.A ?? 0) + (g.B ?? 0)).toFixed(3)), leakSampler: r.leak_sampler, retry: r.retry, neighbors: r.neighbors, swayWindows: r.sway_windows_hidden, error: r.error ? String(r.error).slice(0, 200) : undefined, hideError: r.hideError }));
    }
    fs.writeFileSync(ex, out.join('\n') + '\n', { flag: argv.includes('--append') ? 'a' : 'w' });
    console.error(`[spike] exported ${out.length} runs to ${ex}`);
  }
}
const ASSERT = argv.includes('--assert');
let assertFails = 0;
if (ASSERT) {
  console.log('\nASSERT (expected verdict class per arm; --mutant noflip must turn the control red):');
  for (const r of rows) { const ex = EXPECT[r.arm]; if (!ex) continue; const ok = ex.test(r.verdict); if (!ok) assertFails++; console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${r.arm}: ${r.verdict.slice(0, 90)}  (want ${ex})`); }
  console.log(assertFails ? `ASSERT FAILED: ${assertFails} arm(s)` : 'ASSERT OK');
}
const ctlOk = ctl && (flag('--skip', '').includes('screencast') ? /^PAINTS/.test(ctl.verdict) || (ctl.caps.capturePage === `fresh×${ctl.valid}` && ctl.caps.cdpScreenshot === `fresh×${ctl.valid}`) : ctl.verdict.startsWith('PAINTS ('));
if (ctl && !ctlOk) { console.log('\nCONTROL FAILED: ctl-visible did not read PAINTS — the instrument cannot be trusted; matrix is INVALID'); process.exit(1); }
if (!SUMMARIZE_ONLY) {
  const HASH_AFTER = liveHashes();
  const diff = Object.keys({ ...HASH_BEFORE, ...HASH_AFTER }).filter((k) => HASH_BEFORE[k] !== HASH_AFTER[k]);
  console.log(`\nHYGIENE: ${Object.keys(HASH_BEFORE).length} live config files hashed before/after → ${diff.length ? 'DIFFERENT: ' + diff.join(', ') + ' (check agents\' normal churn)' : 'byte-equal'}; the rig child env had no DISPLAY / CLAUDE_CONFIG_DIR, a fake HOME, the rig's private XDG_RUNTIME_DIR and its NONEXISTENT session bus; a differing ~/.claude*/.credentials.json|.claude.json is the invoking agent session's own churn (its CLAUDE_CONFIG_DIR), not the probe's`);
}
if (ASSERT && assertFails) process.exit(1);
