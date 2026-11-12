// #442 prep (D) — driver of scripts/e2e-packaged-run-proof.sh. Run ONLY through that wrapper (it provides the private sway + env).
// Observes the packaged app on a synthetic pre-update ORCHESTRA_HOME; reads the result off DISK (store.json + bus.sqlite, readonly)
// and off the rendered UI (CDP body text + screenshot). Never touches ~/.claude*, ~/.orchestra, or the live bus.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { createRequire } from 'node:module';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { censusHome } from './pre-update-fixture-census.mjs';
import { privateRuntimeDir, handedEnvProblems } from './lib/rig-runtime.mjs';
import { descendantsOf, procStat, signalIfSame } from './lib/rig-procs.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const COMMON = ['env-isolated', 'fixture-built', 'survivor-instrument-flips'];
const CLAUSES = { before: [...COMMON, 'census-flips', 'ui-sees-fixture', 'gap-visible-after-boot', 'survivors-none', 'live-dirs-untouched'],
  after: [...COMMON, 'census-flips', 'ui-sees-fixture', 'every-workspace-has-a-run', 'mail-flows (TODO final run)', 'survivors-none', 'live-dirs-untouched'],
  fleet: [...COMMON, 'fleet-rows-flags-mail-unchanged', 'survivors-none', 'live-dirs-untouched'] };
if (process.argv.includes('--list')) { for (const [a, c] of Object.entries(CLAUSES)) console.log(`${a}: ${c.join(', ')}`); process.exit(0); }

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d; };
const ARM = arg('arm', 'before');
if (!CLAUSES[ARM]) { console.error(`unknown --arm '${ARM}' (before|after|fleet)`); process.exit(2); }
const EXE = fs.realpathSync(arg('exe'));
const SETTLE_S = Number(arg('settle', '45'));
const MIN_AVAIL_GB = Number(arg('min-avail-gb', '8'));
const REAL_HOME = os.userInfo().homedir;
const RESULTS = [];
const clause = (name, ok, detail = '') => { RESULTS.push({ arm: ARM, clause: name, ok: !!ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${ARM}/${name}${detail ? ' — ' + detail : ''}`); return !!ok; };
const skip = (name, why) => { RESULTS.push({ arm: ARM, clause: name, skip: true, detail: why }); console.log(`SKIP  ${ARM}/${name} — ${why}`); };

// ── containment: everything comes from e2e-contained-rig.sh; refuse to run bare ──
for (const k of ['RIG_WAYLAND', 'SWAYSOCK', 'RIG_DIR', 'HOME', 'XDG_RUNTIME_DIR']) if (!process.env[k]) { console.error(`REFUSED: ${k} unset — run through scripts/e2e-packaged-run-proof.sh`); process.exit(2); }
const RIG_DIR = process.env.RIG_DIR;
const FAKE_HOME = process.env.HOME;
if (!fs.realpathSync(RIG_DIR).startsWith(fs.realpathSync('/var/tmp') + path.sep) || fs.realpathSync(FAKE_HOME) === REAL_HOME) { console.error('REFUSED: rig dir not under the scratch base, or HOME is the real home'); process.exit(2); }

// ── protected dirs: ~/.claude and every ~/.claude-* (surface the app's account-inherit sync could rewrite) ──
const hash = (f) => { try { return require('node:crypto').createHash('sha256').update(fs.readFileSync(f)).digest('hex').slice(0, 16); } catch { return null; } };
function protectedDirs() {
  const dirs = new Set([process.env.CLAUDE_CONFIG_DIR_PIN, path.join(REAL_HOME, '.claude')].filter(Boolean));
  for (const n of fs.readdirSync(REAL_HOME)) if (n.startsWith('.claude-')) dirs.add(path.join(REAL_HOME, n));
  return [...dirs].filter((d) => fs.existsSync(d));
}
function snapshot(dir) { // structure + content hashes of what the sync manages; volatile files (history, projects) are out by design
  const s = { links: [], managed: {} };
  for (const sub of ['', 'skills']) {
    let ents = []; try { ents = fs.readdirSync(path.join(dir, sub)).sort(); } catch { /* absent */ }
    for (const n of ents) { const f = path.join(dir, sub, n); try { if (fs.lstatSync(f).isSymbolicLink()) s.links.push(`${sub}/${n} -> ${fs.readlinkSync(f)}`); } catch { /* raced */ } }
  }
  for (const n of ['CLAUDE.md', 'settings.json', 'LESSONS.md', '.orchestra-inherited.json']) s.managed[n] = hash(path.join(dir, n));
  try { s.mcp = Object.keys(JSON.parse(fs.readFileSync(path.join(dir, '.claude.json'), 'utf8')).mcpServers ?? {}).sort(); } catch { s.mcp = null; }
  return JSON.stringify(s);
}
const snapAll = () => Object.fromEntries(protectedDirs().map((d) => [d, snapshot(d)]));

// ── 1. env isolation + resource pre-flight ──
const pre = (() => { try { privateRuntimeDir(); return null; } catch (e) { return e.message; } })();
clause('env-isolated', !pre && !('DISPLAY' in process.env) && process.env.WAYLAND_DISPLAY !== 'wayland-1', pre ?? `WAYLAND_DISPLAY=${process.env.WAYLAND_DISPLAY}, private XDG ${process.env.XDG_RUNTIME_DIR}`);
const avail = Number(/MemAvailable:\s+(\d+)/.exec(fs.readFileSync('/proc/meminfo', 'utf8'))[1]) / 1048576;
const df = spawnSync('df', ['-BG', '--output=avail', RIG_DIR], { encoding: 'utf8' }).stdout.split('\n')[1].trim();
console.log(`[ppr] resources: MemAvailable ${avail.toFixed(1)} GB (floor ${MIN_AVAIL_GB}), disk free under rig ${df}`);
if (avail < MIN_AVAIL_GB) { clause('resources', false, `MemAvailable ${avail.toFixed(1)} GB < ${MIN_AVAIL_GB} GB — cannot run alongside the fleet`); process.exit(1); }

const liveBefore = snapAll(); // BEFORE anything of master's runs (the builder executes master's Store with the real $HOME)
// ── 2. fixture (master's own Store/bus, synthetic) built INSIDE the rig dir; census instrument proven able to flip ──
const FX = path.join(RIG_DIR, 'fx');
const built = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', path.join(HERE, 'build-pre-update-fixture.mjs'), '--out', FX, ...(arg('base') ? ['--base', arg('base')] : [])], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: REAL_HOME, TMPDIR: RIG_DIR, ORCHESTRA_AGENT_TMPDIR: RIG_DIR } });
const ohome = path.join(FX, 'home');
const manifest = built.status === 0 ? JSON.parse(fs.readFileSync(path.join(FX, 'MANIFEST.json'), 'utf8')) : null;
clause('fixture-built', built.status === 0 && /FIXTURE_OK/.test(built.stdout), built.status === 0 ? `base ${manifest.baseSha.slice(0, 8)}, ${manifest.census.workspaces} workspaces, ${manifest.census.runs} runs` : (built.stderr || built.stdout).split('\n').slice(-3).join(' | '));
if (!manifest) process.exit(1);
const Database = require('better-sqlite3');
const census = () => censusHome(ohome, { betterSqlite: Database });
const preCensus = census();
{ // positive control: add a run for P in a COPY of the bus — P must leave the run-less list, or the census cannot see a run at all
  const ctl = path.join(RIG_DIR, 'ctl'); fs.mkdirSync(path.join(ctl, 'userData', 'orchestra'), { recursive: true });
  fs.copyFileSync(path.join(ohome, 'bus.sqlite'), path.join(ctl, 'bus.sqlite'));
  fs.copyFileSync(path.join(ohome, 'userData', 'orchestra', 'store.json'), path.join(ctl, 'userData', 'orchestra', 'store.json'));
  const w = new Database(path.join(ctl, 'bus.sqlite')); w.prepare("INSERT INTO runs (id,kind,coordinator,created_at) VALUES (?, 'mission', ?, 1)").run(manifest.ids.P, manifest.ids.P); w.close();
  const after = censusHome(ctl, { betterSqlite: Database });
  clause('census-flips', preCensus.runlessOwn.includes('fixture · P') && !after.runlessOwn.includes('fixture · P'), `P run-less ${preCensus.runlessOwn.includes('fixture · P')} → with a run row ${!after.runlessOwn.includes('fixture · P') ? 'gone from the list' : 'STILL listed'}`);
}

{ // positive/negative control for the survivor instrument: a live process must read ALIVE by identity, a killed one must not
  const sl = spawn('sleep', ['30'], { stdio: 'ignore' }); const id = { p: sl.pid, s: procStat(sl.pid)?.start };
  const aliveA = !!id.s && procStat(id.p)?.start === id.s && procStat(id.p)?.state !== 'Z';
  signalIfSame(id.p, id.s, 'SIGKILL'); await new Promise((r) => sl.on('exit', r));
  const aliveB = !!procStat(id.p) && procStat(id.p)?.start === id.s && procStat(id.p)?.state !== 'Z';
  clause('survivor-instrument-flips', aliveA && !aliveB, `sleep ${id.p}: alive-by-identity ${aliveA} → after SIGKILL ${aliveB}`);
}

// ── 3. boot the packaged app on the fixture (allowlist env), settle, observe ──
const port = await new Promise((r) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const env = {
  PATH: '/usr/local/bin:/usr/bin:/bin', HOME: FAKE_HOME, XDG_RUNTIME_DIR: privateRuntimeDir(), TMPDIR: path.join(RIG_DIR, 'tmp'),
  XDG_CONFIG_HOME: path.join(FAKE_HOME, '.config'), XDG_CACHE_HOME: path.join(FAKE_HOME, '.cache'),
  DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS, WAYLAND_DISPLAY: process.env.RIG_WAYLAND, SWAYSOCK: process.env.SWAYSOCK, LANG: 'C.UTF-8',
  ELECTRON_OZONE_PLATFORM_HINT: 'wayland', ORCHESTRA_OZONE: 'wayland', ORCHESTRA_OZONE_RELAUNCHED: '1',
  ORCHESTRA_HOME: ohome, ORCHESTRA_DEBUG_PORT: String(port), ORCHESTRA_SELF_TUNE_CMD: '/bin/true',
  CLAUDE_CONFIG_DIR: path.join(FAKE_HOME, '.claude-scratch'), // scratch account dir: the protected ~/.claude* are never handed over
  ...(EXE.endsWith('.AppImage') ? { APPIMAGE_EXTRACT_AND_RUN: '1' } : {}), // no FUSE mount to leak; unpacks under TMPDIR (inside the rig dir)
};
fs.mkdirSync(env.TMPDIR, { recursive: true }); fs.mkdirSync(env.CLAUDE_CONFIG_DIR, { recursive: true });
const problems = handedEnvProblems(env, { ohome, cfg: env.CLAUDE_CONFIG_DIR, home: FAKE_HOME, wayland: process.env.RIG_WAYLAND, xdg: env.XDG_RUNTIME_DIR, noBusPath: process.env.DBUS_SESSION_BUS_ADDRESS.replace(/^unix:path=/, '') });
if (problems.length || !ohome.startsWith(RIG_DIR + path.sep) || protectedDirs().some((d) => env.CLAUDE_CONFIG_DIR === d || env.CLAUDE_CONFIG_DIR.startsWith(d + path.sep))) { console.error(`REFUSED before launch: ${problems.join('; ') || 'home outside rig dir / config dir overlaps a protected dir'}`); process.exit(2); }

const logFd = fs.openSync(path.join(RIG_DIR, 'app.log'), 'w');
const child = spawn(EXE, ['--ozone-platform=wayland', '--no-sandbox'], { env, stdio: ['ignore', logFd, logFd], cwd: RIG_DIR });
const start = procStat(child.pid)?.start; let exited = false; child.on('exit', () => { exited = true; });
let peakKb = 0; const sample = setInterval(() => { let sum = 0; for (const p of descendantsOf(child.pid)) { try { sum += Number(/VmRSS:\s+(\d+)/.exec(fs.readFileSync(`/proc/${p}/status`, 'utf8'))?.[1] ?? 0); } catch { /* gone */ } } peakKb = Math.max(peakKb, sum); }, 1000);
let bodyText = '', shot = null;
try {
  const targets = await (async () => { for (let i = 0; i < 150; i++) { if (exited) throw new Error(`app exited early (see ${RIG_DIR}/app.log)`); try { const j = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); const t = j.filter((x) => x.type === 'page' && x.url.includes('index.html')); if (t.length) return t; } catch { /* not yet */ } await sleep(300); } throw new Error('no renderer page on the CDP port in 45 s'); })();
  console.log(`[ppr] app up (pid ${child.pid}); settling ${SETTLE_S}s so the boot-time work (migration, run backfill) can finish`);
  await sleep(SETTLE_S * 1000);
  const ws = new WebSocket(targets[0].webSocketDebuggerUrl); await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let id = 0; const pend = new Map(); ws.onmessage = (m) => { const d = JSON.parse(m.data); pend.get(d.id)?.(d); };
  const cdp = (method, params = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  bodyText = (await cdp('Runtime.evaluate', { expression: 'document.body.innerText', returnByValue: true })).result?.result?.value ?? '';
  const png = (await cdp('Page.captureScreenshot', { format: 'png' })).result?.data;
  if (png) { shot = path.join(RIG_DIR, `ui-${ARM}.png`); fs.writeFileSync(shot, Buffer.from(png, 'base64')); }
  ws.close();
} catch (e) { console.error(`[ppr] boot/observe failed: ${e.message}`); }
clearInterval(sample);
const post = (() => { try { return census(); } catch (e) { return { error: e.message }; } })();

// ── 4. teardown by identity (pid + start time re-read at signal time; plus detached procs carrying THIS home) ──
const tree = descendantsOf(child.pid).map((p) => ({ p, s: procStat(p)?.start }));
const keeperPids = () => { try { return fs.readdirSync(path.join(ohome, 'keepers')).filter((f) => f.endsWith('.pid')).map((f) => Number(fs.readFileSync(path.join(ohome, 'keepers', f), 'utf8').trim())).filter(Boolean); } catch { return []; } };
const detached = keeperPids().map((p) => ({ p, s: procStat(p)?.start })); // identity captured now; a pid file is the app's own inventory of what it detached
const everyone = () => [...tree, ...detached, ...descendantsOf(child.pid).map((p) => ({ p, s: procStat(p)?.start })).filter((x) => x.s)]; // re-read after the grace: late children count
const aliveNow = (list) => list.filter(({ p, s }) => s && procStat(p)?.start === s && procStat(p)?.state !== 'Z');
signalIfSame(child.pid, start, 'SIGTERM'); await sleep(4000);
const late = everyone(); // children spawned during the grace
for (const { p, s } of late) if (s) signalIfSame(p, s, 'SIGKILL');
let survivors = aliveNow(late);
for (let i = 0; i < 10 && survivors.length; i++) { await sleep(500); survivors = aliveNow(late); } // SIGKILL is not instantaneous: count only what outlives a 5 s grace
const survivorNames = survivors.map(({ p }) => { try { return `${p}:${fs.readFileSync(`/proc/${p}/cmdline`, 'utf8').split('\0')[0].split('/').pop()}`; } catch { return `${p}`; } });

// ── 5. verdicts ──
console.log(`[ppr] peak app-tree RSS ${(peakKb / 1048576).toFixed(2)} GB; survivors after teardown: ${survivors.length}`);
const names = ['P', 'P1', 'P2', 'S'].map((n) => `fixture · ${n}`);
const rows = ['fixture-s', 'fixture-p', 'fixture-p1', 'fixture-p2', 'fixture-l']; // the sidebar labels a row by its branch
const lowered = bodyText.toLowerCase();
const booted = bodyText.length > 0; // the app rendered: a disk census alone could be the fixture's own, unread by any app
clause('ui-sees-fixture', rows.every((n) => new RegExp(`(^|[^a-z0-9-])${n}(?![a-z0-9-])`).test(lowered)), shot ? `sidebar rows ${rows.filter((n) => new RegExp(`(^|[^a-z0-9-])${n}(?![a-z0-9-])`).test(lowered)).join(', ') || 'none'} of ${rows.length}; screenshot ${shot}` : 'no UI read (CDP never answered)');
if (post.error) clause('census-after-boot', false, post.error);
else if (ARM === 'before') clause('gap-visible-after-boot', booted && names.every((n) => post.runlessOwn.includes(n)), `run-less after boot: ${post.runlessOwn.length}/${post.workspaces} (${post.runlessOwn.join(', ')}) — on master this must stay >0`);
else if (ARM === 'after') { clause('every-workspace-has-a-run', booted && post.runlessOwn.length === 0, `run-less after boot (own-run criterion; #433/#434 may narrow it): ${post.runlessOwn.join(', ') || 'none'} | in-run criterion: ${post.runlessIn.join(', ') || 'none'}`); skip('mail-flows', 'TODO final #442 run: drive parent→child `orchestra send` + `check` on the fixture workspaces (they are hibernated: needs a wake)'); }
else {
  const flagsOf = (c) => c.runRows.filter((r) => [manifest.ids.L, manifest.ids.O].includes(r.id)).map((r) => [r.id, r.flags]).sort();
  const fleet = post.runRows.filter((r) => [manifest.ids.L, manifest.ids.O].includes(r.id));
  const q = (run) => { const d = new Database(path.join(ohome, 'bus.sqlite'), { readonly: true }); try { return d.prepare('SELECT COUNT(*) n FROM messages WHERE run_id=?').get(run).n; } finally { d.close(); } };
  const same = booted && fleet.length === 2 && JSON.stringify(flagsOf(post)) === JSON.stringify(flagsOf(preCensus)) && q(manifest.ids.L) >= 1 && q(manifest.ids.O) >= 2 && JSON.stringify(fleet.map((r) => r.parent)) === JSON.stringify(preCensus.runRows.filter((r) => [manifest.ids.L, manifest.ids.O].includes(r.id)).map((r) => r.parent));
  clause('fleet-rows-flags-mail-unchanged', same, `L/O rows ${fleet.length}/2, messages L=${q(manifest.ids.L)} (≥1) O=${q(manifest.ids.O)} (≥2), parent pointers + run_flags of L/O equal pre-boot, app rendered`);
}
clause('survivors-none', survivors.length === 0, `${survivors.length} left${survivors.length ? ': ' + survivorNames.join(', ') : ''}`);
const liveAfter = snapAll(); const changed = Object.keys({ ...liveBefore, ...liveAfter }).filter((d) => liveBefore[d] !== liveAfter[d]);
clause('live-dirs-untouched', changed.length === 0, changed.length ? `CHANGED: ${changed.join(', ')} (compare by hand: a user edit mid-run is not the app)` : `${Object.keys(liveBefore).length} dir(s) snapshotted identical before/after`);
fs.writeFileSync(path.join(RIG_DIR, 'results.json'), JSON.stringify({ arm: ARM, exe: EXE, results: RESULTS, preCensus, post, peakRssGb: peakKb / 1048576 }, null, 2));
const bad = RESULTS.filter((r) => r.ok === false);
console.log(`[ppr] ${RESULTS.length} clauses, ${bad.length} FAIL, ${RESULTS.filter((r) => r.skip).length} SKIP — results ${RIG_DIR}/results.json`);
process.exit(bad.length ? 1 : 0);
