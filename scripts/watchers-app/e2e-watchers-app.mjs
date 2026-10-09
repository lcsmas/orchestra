// #330 (wave H, ledger #329) — the app HEALS after a resource crunch, driven on the BUILT app inside the contained rig's own headless sway (scripts/watchers-app/e2e-watchers-app.sh):
//   phase 1  healthy boot → every watcher ok, no warning; the lead's wave is put under a Pause dure (the host trap, real git worktrees) → the sidebar says « en pause » on 7 rows
//   phase 2  the app is relaunched with `ORCHESTRA_WATCH_FAULT_FILE` present (every directory watch fails EMFILE — injected, never real exhaustion) → the 6 boot watchers are DEGRADED and listed; the boot
//            pull still shows « en pause »; a Reprise is then written ON THE BUS by another process (the CLI's shape) — the app is not told: the sidebar stays « en pause » (the incident's symptom) —
//            the fault is lifted → the watchers re-arm BY THEMSELVES (no restart, no new write) and the sidebar moves to « Reprise … repris » through the catch-up push; the warning disappears;
//            then a further bus-side release is shown live (< 3 s).
// State assertions AND decoded screenshots (pixels, not DOM alone). Containment as scripts/pause-ui: scratch ORCHESTRA_HOME/HOME/CLAUDE_CONFIG_DIR, second headless sway, nothing live touched, survivors printed.
// Usage (via the .sh): <app-dir | --packaged <bin>> --live-home <real $HOME> [--out dir] [--label name] [--no-chip] [--expect-red]
//   --no-chip     skip the warning-chip clauses (the chip waits for the D4 pick)
//   --expect-red  the must-FAIL arm: against a build WITHOUT the feature (master) every G-clause must be RED and every ctl/* clause GREEN.
import fs from 'node:fs';
import path from 'node:path';
import { IDS, NAME_OF, REPO, FLEET, buildWorld, crop, decodePng, diffPx, distinctColours, launchApp, liveBusOpenedBy, liveCanary, makeGuard, makeRecorder, sh, sleep, waitFor } from '../pause-ui/lib.mjs';

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const PACKAGED = flag('--packaged', null);
const APP_DIR = !PACKAGED && argv[0] && !argv[0].startsWith('--') ? fs.realpathSync(argv[0]) : null;
const LIVE_HOME = flag('--live-home', null);
const LABEL = flag('--label', PACKAGED ? path.basename(path.dirname(PACKAGED)) : APP_DIR ? path.basename(APP_DIR) : 'app');
const NO_CHIP = argv.includes('--no-chip');
const EXPECT_RED = argv.includes('--expect-red');
const RIG_DIR = process.env.RIG_DIR, RIG_WAYLAND = process.env.RIG_WAYLAND;
if (!APP_DIR && !PACKAGED) { console.log('REFUSED: no <app-dir> / --packaged'); process.exit(3); }
const guard = makeGuard({ liveHome: LIVE_HOME, rigDir: RIG_DIR, rigWayland: RIG_WAYLAND });
const OUT = flag('--out', null) || path.join(RIG_DIR, 'shots');
const rec = makeRecorder(OUT);
const { clause, saveShot } = rec;
const J = JSON.stringify;
const HERE = path.dirname(new URL(import.meta.url).pathname);
const SIX = ['bus-wake', 'events-spool', 'human-gates', 'inbox-tray', 'pause-trap', 'pause-ui'];
const SIDE = { x: 0, y: 100, width: 345, height: 470 };
const TRAP_DEADLINE_MS = 120_000;
const HEAL_BOUND_MS = 75_000; // the backoff cap is 60 s, plus a probe + margin
const arm = 'heal';

const opsEnv = { PATH: '/usr/bin:/bin', HOME: '/nonexistent' };
const busOps = (world, ...a) => { const out = sh(process.execPath, ['--no-warnings', '--experimental-strip-types', path.join(HERE, 'bus-ops.mjs'), world.ohome, ...a], { env: opsEnv }); return JSON.parse(out.split('\n').filter((l) => l.startsWith('{')).pop()); };

async function boot(world, phase, extraEnv = {}) {
  const a = await launchApp({ appDir: APP_DIR, packaged: PACKAGED, world, guard, rigWayland: RIG_WAYLAND, size: [1440, 900], tag: `${arm}-${phase}`, extraEnv });
  const where = a.target.url;
  clause(arm, `ctl/${phase}-app-identity-path`, PACKAGED ? where.includes(path.dirname(PACKAGED)) : where.includes(APP_DIR) && !where.includes('app.asar'), `target url ${where}`);
  const environ = fs.readFileSync(`/proc/${a.app.pid}/environ`, 'utf8').split('\0');
  const ev = (k) => (environ.find((e) => e.startsWith(k + '=')) || '').slice(k.length + 1);
  clause(arm, `ctl/${phase}-scratch-env`, ev('ORCHESTRA_HOME') === world.ohome && ev('CLAUDE_CONFIG_DIR') === world.cfg && ev('HOME') === world.home && !environ.some((e) => e.startsWith('DISPLAY=')) && ev('WAYLAND_DISPLAY') === RIG_WAYLAND, `ORCHESTRA_HOME=${ev('ORCHESTRA_HOME')} WAYLAND_DISPLAY=${ev('WAYLAND_DISPLAY')} DISPLAY=${ev('DISPLAY') || '<unset>'}`);
  const inSway = await waitFor(() => new RegExp(`"pid":\\s*${a.app.pid}\\b`).test(sh('swaymsg', ['-t', 'get_tree'])), 20000, "the app window in my sway's tree", 500).catch(() => false);
  clause(arm, `ctl/${phase}-app-in-my-sway`, inSway, `app pid ${a.app.pid} present in my sway's get_tree`);
  await waitFor(() => a.cdp.eval(`document.querySelectorAll('.ws-item').length`).then((n) => n >= FLEET.length), 60000, `${FLEET.length} workspace rows`);
  return a;
}

const evalSafe = async (cdp, expr) => { try { return { ok: true, v: await cdp.eval(`(async () => JSON.parse(JSON.stringify(await (${expr}))))()`) }; } catch (e) { return { ok: false, err: String(e.message ?? e).slice(0, 160) }; } };
const sideState = (cdp, leadId) => cdp.eval(`(() => ({ badges: [...document.querySelectorAll('[data-pause-badge]')].map((e) => [e.getAttribute('data-pause-badge'), e.getAttribute('data-pause-state'), e.textContent.trim()]), note: document.querySelector('[data-pause-note="${leadId}"]')?.textContent ?? null }))()`);
const chipState = (cdp) => cdp.eval(`(() => { const e = document.querySelector('[data-watchers-chip]'); if (!e) return null; const b = e.getBoundingClientRect(); return { visible: b.width > 0 && b.height > 0, text: e.textContent.trim(), title: e.getAttribute('title') || '' }; })()`);

async function armHeal() {
  const armDir = path.join(RIG_DIR, `arm-${LABEL}-${arm}`);
  fs.mkdirSync(armDir, { recursive: true });
  const world = buildWorld(armDir, guard);
  const I = IDS;
  const fault = path.join(armDir, 'watch-fault');
  console.log(`\n== arm ${LABEL}/${arm} == scratch ${armDir}`);
  const bus = () => world.readBus();
  const run = (id) => bus().runs.find((r) => r.id === id);
  let a = null;
  try {
    // ─── phase 1: healthy boot, then the wave is paused ───────────────────────────────────────────
    a = await boot(world, 'p1');
    const st1 = await evalSafe(a.cdp, 'window.orchestra.watchersStatus()');
    clause(arm, 'G1/healthy-boot-every-watcher-ok', st1.ok && J(st1.v.watchers.map((w) => w.name).sort()) === J(SIX) && st1.v.watchers.every((w) => w.state === 'ok'), st1.ok ? `watchers ${st1.v.watchers.map((w) => `${w.name}:${w.state}`).join(', ')}` : `watchersStatus() — ${st1.err}`);
    if (!NO_CHIP) clause(arm, 'G2/no-warning-when-healthy', (await chipState(a.cdp)) === null, `chip: ${J(await chipState(a.cdp))}`);
    const p = await evalSafe(a.cdp, `window.orchestra.pausePause(${J(I.lead)}, 'hard')`);
    await waitFor(() => run(I.lead).pause_trap_at !== null, TRAP_DEADLINE_MS, 'the host trap to finish', 500);
    await waitFor(async () => (await sideState(a.cdp, I.lead)).badges.length === 7, 20000, '7 « en pause » badges', 300);
    const s1 = await sideState(a.cdp, I.lead);
    clause(arm, 'ctl/p1-wave-paused-in-the-sidebar', p.ok && s1.badges.every((b) => b[1] === 'paused' && b[2] === 'en pause') && /^En pause · 7\/7/.test(s1.note ?? ''), `pause dure → ${s1.badges.length} badges « en pause », lead note "${s1.note}"`);
    const left1 = await a.kill();
    a = null;
    clause(arm, 'ctl/p1-teardown-no-survivors', left1.length === 0, `processes still carrying ${world.ohome}: ${left1.join(',') || 'none'}`);

    // ─── phase 2: relaunch inside the crunch (injected EMFILE) ────────────────────────────────────
    fs.writeFileSync(fault, 'inject EMFILE\n');
    a = await boot(world, 'p2', { ORCHESTRA_WATCH_FAULT_FILE: fault });
    const cdp = a.cdp;
    await sleep(1500);
    const s2 = await sideState(cdp, I.lead);
    clause(arm, 'ctl/p2-boot-pull-shows-the-pause', s2.badges.length === 7 && /^En pause · 7\/7/.test(s2.note ?? ''), `after the relaunch the sidebar reads the bus once at boot: ${s2.badges.length} badges, note "${s2.note}"`);
    const st2 = await waitFor(async () => { const r = await evalSafe(cdp, 'window.orchestra.watchersStatus()'); return r.ok && r.v.watchers.length >= 6 ? r.v : null; }, 20000, 'the watcher status', 400).catch(() => null);
    const degraded = st2 ? st2.watchers.filter((w) => w.state === 'degraded') : [];
    clause(arm, 'G3/boot-degraded-all-six-listed', degraded.length === 6 && J(degraded.map((w) => w.name).sort()) === J(SIX) && degraded.every((w) => w.lastError?.code === 'EMFILE' && /injected/.test(w.lastError.message ?? '')), st2 ? `degraded: ${degraded.map((w) => `${w.name}(${w.lastError?.code})`).join(', ')}` : 'watchersStatus() unavailable');
    const log2 = () => { try { return fs.readFileSync(path.join(world.ohome, 'logs', 'orchestra.log'), 'utf8'); } catch { return ''; } };
    clause(arm, 'G3/log-one-warn-per-degradation-naming-the-limit', (log2().match(/\[WARN\][^\n]*watcher\[[a-z-]+\]: DEGRADED/g) ?? []).length === 6 && /system watch limit reached \(EMFILE\)/.test(log2()), `WARN×${(log2().match(/\[WARN\][^\n]*watcher\[[a-z-]+\]: DEGRADED/g) ?? []).length} (want 6), names the system limit: ${/system watch limit reached \(EMFILE\)/.test(log2())}`);
    if (!NO_CHIP) {
      const chip = await waitFor(async () => { const c = await chipState(cdp); return c?.visible ? c : null; }, 15000, 'the warning', 300).catch(() => null);
      clause(arm, 'G4/warning-visible-while-degraded', !!chip && /Réveils/.test(`${chip.text} ${chip.title}`) && /Vue Pause|Pause view/i.test(`${chip.text} ${chip.title}`), `warning: ${J(chip)}`);
    }
    await cdp.eval(`window.__pe = []; window.__wu = []; window.orchestra.onPauseOverviewUpdate((o) => window.__pe.push(o.runs.map((r) => [r.carrierRunId, r.phase]))); window.orchestra.onWatchersUpdate((s) => window.__wu.push(s.watchers.filter((w) => w.state === 'degraded').length)); true`);
    await cdp.mouse(5, 890); await sleep(500); await cdp.eval('document.fonts.ready.then(() => true)');
    const shotStale0 = await cdp.shot(SIDE); saveShot(`${LABEL}-1-degraded-before-reprise.png`, shotStale0);

    // the Reprise is written ON THE BUS by another process; the app is not told
    const tReprise = Date.now();
    const rp = busOps(world, 'reprise', 'fleet-lead');
    await sleep(4000);
    const sStale = await sideState(cdp, I.lead);
    const pushesWhileDown = await cdp.eval('window.__pe.length');
    clause(arm, 'G5/stale-while-degraded-the-incident-symptom', run(I.lead).resume_started_at !== null && /^En pause · 7\/7/.test(sStale.note ?? '') && pushesWhileDown === 0, `bus: resume_started_at=${run(I.lead).resume_started_at} (outcome ${rp.outcome}); 4 s later the sidebar still reads "${sStale.note}", ${pushesWhileDown} pause:update push — the watch that would have told it is down`);
    const stale = await cdp.shot(SIDE); saveShot(`${LABEL}-2-degraded-stale-sidebar.png`, stale);
    const stalePng = decodePng(stale);
    clause(arm, 'ctl/p2-stale-frame-painted', distinctColours(stalePng) > 30, `${distinctColours(stalePng)} distinct colours in the sidebar clip`);

    // ─── the crunch ends ──────────────────────────────────────────────────────────────────────────
    fs.rmSync(fault);
    const tLift = Date.now();
    await cdp.eval('window.__pe.length = 0; true');
    const healed = await waitFor(async () => { const r = await evalSafe(cdp, 'window.orchestra.watchersStatus()'); return r.ok && r.v.watchers.length >= 6 && r.v.watchers.every((w) => w.state === 'ok') ? r.v : null; }, HEAL_BOUND_MS, 'every watcher back', 500).catch(() => null);
    const healMs = Date.now() - tLift;
    clause(arm, 'G6/heals-without-restart-within-the-backoff-cap', !!healed && healed.watchers.length === 6 && healed.watchers.every((w) => w.recoveries === 1), healed ? `all 6 ok ${healMs} ms after the fault was lifted (bound ${HEAL_BOUND_MS} ms); recoveries ${healed.watchers.map((w) => w.recoveries).join(',')}` : `still degraded after ${HEAL_BOUND_MS} ms`);
    const tNote = await waitFor(async () => /^Reprise/.test((await sideState(cdp, I.lead)).note ?? ''), 8000, 'the sidebar to move to « Reprise »', 200).then(() => Date.now() - tLift).catch(() => null);
    const sHealed = await sideState(cdp, I.lead);
    clause(arm, 'G7/sidebar-moves-to-reprise-without-a-new-write', tNote !== null && /^Reprise · \d+\/7 repris/.test(sHealed.note ?? '') && (await cdp.eval('window.__pe.length')) >= 1, `lead note "${sHealed.note}" (${tNote === null ? 'never' : `${tNote} ms after the lift`}); ${await cdp.eval('window.__pe.length')} pause:update push(es) since — no bus write was made after the Reprise`);
    await cdp.mouse(5, 890); await sleep(600); await cdp.eval('document.fonts.ready.then(() => true)');
    const healedShot = await cdp.shot(SIDE); saveShot(`${LABEL}-3-healed-sidebar.png`, healedShot);
    const healedPng = decodePng(healedShot);
    const dpx = diffPx(stalePng, healedPng, 12);
    clause(arm, 'G7/sidebar-pixels-changed', dpx > 800, `${dpx} px differ between the stale and the healed sidebar clips (the note, the bar and the badges moved)`);
    if (!NO_CHIP) {
      const gone = await waitFor(async () => (await chipState(cdp)) === null || !(await chipState(cdp)).visible, 10000, 'the warning to disappear', 300).then(() => true).catch(() => false);
      clause(arm, 'G4/warning-gone-on-its-own', gone, `warning after recovery: ${J(await chipState(cdp))}`);
    }
    const wu = await cdp.eval('window.__wu');
    clause(arm, 'G8/renderer-told-the-all-clear-once-per-change', wu.length >= 1 && wu[wu.length - 1] === 0, `watchers:update pushes (degraded count after each): ${J(wu)}`);
    clause(arm, 'G8/log-one-info-per-recovery', (log2().match(/\[INFO\][^\n]*watcher\[[a-z-]+\]: RECOVERED/g) ?? []).length === 6, `INFO×${(log2().match(/\[INFO\][^\n]*watcher\[[a-z-]+\]: RECOVERED/g) ?? []).length} (want 6)`);

    // ─── live again: a further bus-side release is shown within seconds ───────────────────────────
    const before = (await sideState(cdp, I.lead)).badges.filter((b) => b[1] === 'blocked').length;
    const rel = busOps(world, 'release', 'fleet-lead', 'worker-1', 'worker-2', 'worker-3', 'worker-4', 'docs-sweep');
    const tRel = Date.now();
    const live = await waitFor(async () => (await sideState(cdp, I.lead)).badges.filter((b) => b[1] === 'blocked').length < before, 8000, 'the release to reach the sidebar', 100).then(() => Date.now() - tRel).catch(() => null);
    clause(arm, 'G9/live-path-back-after-recovery', live !== null && live < 3000, `bus-side release of ${rel.released?.length ?? '?'} members → blocked badges ${before} → ${(await sideState(cdp, I.lead)).badges.filter((b) => b[1] === 'blocked').length} in ${live} ms (bound 3000)`);
    liveBusCheck(world, 'p2');
  } catch (e) {
    clause(arm, 'G0/arm-completed', false, `ARM ABORTED: ${e.stack || e}`);
  } finally {
    if (a) { a.cdp.close(); const left = await a.kill(); clause(arm, 'ctl/teardown-no-survivors', left.length === 0, `processes still carrying ${world.ohome}: ${left.join(',') || 'none'}`); }
  }
}
function liveBusCheck(world, tag) {
  const r = liveBusOpenedBy(world.ohome, LIVE_HOME);
  clause(arm, `ctl/${tag}-live-bus-never-opened`, r.holders.length === 0 && r.opened === path.join(world.ohome, 'bus.sqlite'), `the app opened ${r.opened}; rig processes holding ~/.orchestra/bus.sqlite: ${r.holders.join(',') || 'none'}`);
}

const canaryBefore = liveCanary(LIVE_HOME);
console.log(`[rig] app ${APP_DIR ?? PACKAGED} label ${LABEL} expect-red=${EXPECT_RED} no-chip=${NO_CHIP} out=${OUT}`);
await armHeal();
const canaryAfter = liveCanary(LIVE_HOME);
clause('rig', 'ctl/live-dirs-untouched', J(canaryBefore) === J(canaryAfter), `${Object.keys(canaryBefore).length} live ~/.claude* dirs ${J(canaryBefore) === J(canaryAfter) ? 'identical before/after' : 'CHANGED'}`);

console.log('\n== shots (md5) ==');
for (const s of rec.shots) console.log(`  ${s.md5}  ${s.file}`);
const dup = rec.shots.length - new Set(rec.shots.map((s) => s.md5)).size;
console.log(`  duplicates among captures: ${dup}`);
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, `${LABEL}-result.json`), JSON.stringify({ app: APP_DIR ?? PACKAGED, label: LABEL, results: rec.results, shots: rec.shots }, null, 2));
const isCtl = (c) => c.clause.startsWith('ctl/');
const ctlRed = rec.results.filter((c) => isCtl(c) && !c.ok), gAll = rec.results.filter((c) => !isCtl(c)), gRed = gAll.filter((c) => !c.ok);
let verdict, rc;
if (EXPECT_RED) {
  ({ verdict, rc } = ctlRed.length === 0 && gAll.length > 0 && gRed.length === gAll.length ? { verdict: `EXPECTED-RED CONFIRMED: ${gRed.length}/${gAll.length} G-clauses red, every ctl/* green`, rc: 0 } : { verdict: `EXPECTED-RED NOT MET: ${gRed.length}/${gAll.length} G-clauses red; controls red: ${ctlRed.map((c) => c.clause).join('; ') || 'none'}`, rc: 1 });
} else {
  ({ verdict, rc } = ctlRed.length === 0 && gRed.length === 0 && gAll.length > 0 ? { verdict: `ALL GREEN: ${rec.results.length} clauses (${gAll.length} G, ${rec.results.length - gAll.length} control)`, rc: 0 } : { verdict: `RED: ${rec.results.filter((c) => !c.ok).map((c) => c.clause).join('; ')}`, rc: 1 });
}
console.log(`\nVERDICT: ${verdict}`);
process.exit(rc);
