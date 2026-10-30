// #406 phase 2 design probe runner (inside the contained rig, via scripts/probe-hidden-drive.sh): one fresh Electron per (scenario, flip arm, rep),
// capture order alternating fwd/rev, prints one JSON line per run + a per-scenario summary. Usage: probe-hidden-drive.sh <repo> [--scen A,B,C,D,E] [--flip flip,noflip] [--n 5] [--attach-ms 800] [--others 8] [--out dir]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { privateRuntimeDir, handedEnvProblems } from './lib/rig-runtime.mjs';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const refuse = (m) => { console.error('ABORT: ' + m); process.exit(2); };
const REPO = path.resolve(argv[0] || '');
const { RIG_DIR, RIG_WAYLAND } = process.env;
if (!RIG_DIR || !RIG_WAYLAND) refuse('run via scripts/probe-hidden-drive.sh (the contained rig)');
if (process.env.DISPLAY || process.env.WAYLAND_DISPLAY !== RIG_WAYLAND || RIG_WAYLAND === 'wayland-1') refuse('display env is not the rig\'s');
const BUS = process.env.DBUS_SESSION_BUS_ADDRESS ?? ''; if (!BUS.startsWith(`unix:path=${RIG_DIR}/`)) refuse('bus is not the rig\'s nonexistent one');
let XDG; try { XDG = privateRuntimeDir(); } catch (e) { refuse(e.message); }
const ELECTRON = path.join(REPO, 'node_modules/electron/dist/electron'); if (!fs.existsSync(ELECTRON)) refuse('electron missing');
const OUT = path.resolve(flag('--out', path.join(process.env.TMPDIR || '/var/tmp', 'probe-406p2'))); fs.mkdirSync(OUT, { recursive: true });
import { execFileSync } from 'node:child_process';
try { execFileSync('swaymsg', ['output', 'HEADLESS-1', 'resolution', '1400x900']); execFileSync('swaymsg', ['default_border', 'none']); } catch (e) { refuse('swaymsg: ' + e.message); }
const SCENS = flag('--scen', 'A,B,C,D,E').split(','), FLIPS = flag('--flip', 'flip').split(','), N = Number(flag('--n', '5')), ATTACH = flag('--attach-ms', '800'), OTHERS = flag('--others', '8');
const results = [];
for (let rep = 0; rep < N; rep++) for (const scen of SCENS) for (const flip of ((scen === 'E' || scen === 'F' || scen === 'G') ? ['flip'] : FLIPS)) {
  const dir = path.join(OUT, `${scen}-${flip}-${flag('--strat', 'native')}-${flag('--back', 'bt')}-${flag('--hold', '0')}-${flag('--bfix', '')}-${flag('--others', '8')}-${flag('--away', '0')}-${flag('--idle', '2500')}-${flag('--attach-first', '0')}-${flag('--setbounds', '0')}-${rep}`); fs.mkdirSync(path.join(dir, 'home'), { recursive: true });
  const home = path.join(dir, 'home');
  const env = { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: home, XDG_RUNTIME_DIR: XDG, DBUS_SESSION_BUS_ADDRESS: BUS, XDG_CONFIG_HOME: path.join(home, '.config'), XDG_CACHE_HOME: path.join(home, '.cache'), WAYLAND_DISPLAY: RIG_WAYLAND, SWAYSOCK: process.env.SWAYSOCK, ELECTRON_OZONE_PLATFORM_HINT: 'wayland', PROBE_SCEN: scen, PROBE_FLIP: flip, PROBE_OUT: dir, PROBE_OTHERS: OTHERS, PROBE_ATTACH_MS: ATTACH, PROBE_ORDER: rep % 2 ? 'rev' : 'fwd', PROBE_STRAT: flag('--strat', 'native'), PROBE_BACK: flag('--back', 'bt'), PROBE_AWAY: flag('--away', '0'), PROBE_BFIX: flag('--bfix', ''), PROBE_IDLE_MS: flag('--idle', '2500'), PROBE_ATTACH_FIRST: flag('--attach-first', '0'), PROBE_SETBOUNDS_MS: flag('--setbounds', '0'), PROBE_HOLD_MS: flag('--hold', '1000') };
  const bad = handedEnvProblems(env, { ohome: undefined, cfg: undefined, home, wayland: RIG_WAYLAND, xdg: XDG, noBusPath: BUS.replace(/^unix:path=/, '') }); if (bad.length) refuse(bad.join('; '));
  const child = spawn(ELECTRON, [path.join(HERE, 'probe-hidden-drive-main.cjs'), '--ozone-platform=wayland'], { cwd: REPO, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  let out = ''; child.stdout.on('data', (d) => { out += d; }); child.stderr.on('data', (d) => { out += d; });
  const to = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 140000 + Number(flag('--idle', '2500')));
  await new Promise((r) => child.on('exit', r)); clearTimeout(to); try { process.kill(-child.pid, 'SIGKILL'); } catch {}
  fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(path.join(dir, 'userData'), { recursive: true, force: true });
  const line = out.split('\n').find((l) => l.startsWith('PROBE_RESULT '));
  const r = line ? JSON.parse(line.slice(13)) : { scen, flip, error: 'no PROBE_RESULT: ' + out.slice(-200) }; r.rep = rep; r.order = env.PROBE_ORDER; results.push(r);
  fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify(r));
  console.error(`[probe] ${scen}/${flip}#${rep} ${r.error ? 'ERR ' + r.error.slice(0, 120) : scen === 'G' ? `hold ${r.hold} ms → re-throttled at ${r.reThrottledAtMs} ms; timeline ${JSON.stringify(r.timeline500)}` : (scen === 'E' || scen === 'F') ? `shown ${r.shown.filter((x) => x.fired).length}/6 away ${r.away.filter((x) => x.fired).length}/6 back ${r.back.filter((x) => x.fired).length}/6` : `caps ${r.caps.map((c) => `${c.name}:${c.fresh ? 'fresh' : c.kind || c.outcome}@${c.ms}`).join(' ')} · input ${r.inputLandedMs}ms · throttle-back ${JSON.stringify(r.throttleBack)} · leakMax ${r.leakMaxBlue} · action ${r.actionMs}ms`}`);
}
console.log('\n=== summary ===');
for (const scen of SCENS) for (const flip of ((scen === 'E' || scen === 'F' || scen === 'G') ? ['flip'] : FLIPS)) {
  const rs = results.filter((r) => r.scen === scen && r.flip === (flip !== 'noflip') && !r.error);
  if (scen === 'G') { console.log(`G hold ${flag('--hold', '1000')} ms: re-throttled at ${rs.map((r) => r.reThrottledAtMs).join(',')} ms`); continue; }
  if (scen === 'F') { const t = (k) => rs.flatMap((r) => r[k].map((x) => x.ticks)); console.log(`F (child-view rAF ticks per 300 ms): shown ${t('shown').join(',')} · AWAY ${t('away').join(',')} · back ${t('back').join(',')}`); continue; }
  if (scen === 'E') { const f = (k) => rs.reduce((s, r) => s + r[k].filter((x) => x.fired).length, 0) + '/' + rs.length * 6; const ms = (k) => Math.max(0, ...rs.flatMap((r) => r[k].filter((x) => x.fired).map((x) => x.ms))); console.log(`E: window shown rAF fired ${f('shown')} (max ${ms('shown')} ms) · sway-away ${f('away')} · back ${f('back')} (max ${ms('back')} ms)`); continue; }
  const names = flag('--strat', 'native') === 'sub' ? ['sub-all', 'sub-dirty'] : flag('--strat', 'native') === 'fs0' ? ['fs0', 'fs0+beyond', 'fs0+beyond+clip', 'fs0+clip'] : ['capturePage', 'cdp-default', 'cdp-fromSurfaceFalse', 'cdp-beyondViewport'];
  const fresh = Object.fromEntries(names.map((n) => [n, rs.filter((r) => r.caps.find((c) => c.name === n)?.fresh).length]));
  const firstMs = rs.map((r) => r.caps.reduce((m, c) => Math.max(m, c.ms), 0)).sort((a, b) => a - b);
  console.log(`${scen}/${flip}: runs ${rs.length}/${results.filter((r) => r.scen === scen && r.flip === (flip !== 'noflip')).length} · fresh ${JSON.stringify(fresh)} · slowest capture ms (median/max) ${firstMs[firstMs.length >> 1]}/${firstMs[firstMs.length - 1]} · input landed ${rs.filter((r) => r.inputLandedMs !== null && r.inputLandedMs <= 700).length}/${rs.length} (≤700 ms) · throttle-back timeline (timers/s per 1 s bucket) ${rs.map((r) => JSON.stringify(r.throttleBack)).join(' ')} · leak max ${Math.max(0, ...rs.map((r) => r.leakMaxBlue || 0))}`);
}
