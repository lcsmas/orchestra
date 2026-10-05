// #257 G3 — the fleet Pause UI driven on the BUILT app inside the contained rig's own headless sway (scripts/pause-ui/e2e-pause-ui.sh):
//   arm `ipc` : the data layer in the REAL app — preload → ipcMain → the shipped writers → the REAL host trap (snapshot refs, Bilan) → `pause:update` push.
//   arm `ui`  : the chosen option's controls/badges/progress/refusals (added with the UI — see ui-arm.mjs).
// Usage (via the .sh): <app-dir | --packaged <bin>> --live-home <real $HOME> [--out dir] [--label name] [--arms ipc,ui] [--expect-red]
//   --expect-red = the must-FAIL arm (run against a build WITHOUT the feature, e.g. master): exit 0 only if every `G*` clause is RED and every `ctl/*` clause GREEN.
import fs from 'node:fs';
import path from 'node:path';
import { Cdp, FLEET, IDS, NAME_OF, REPO, buildWorld, git, launchApp, liveBusOpenedBy, liveCanary, makeGuard, makeRecorder, md5, sh, sleep, waitFor } from './lib.mjs';

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const PACKAGED = flag('--packaged', null);
const APP_DIR = !PACKAGED && argv[0] && !argv[0].startsWith('--') ? fs.realpathSync(argv[0]) : null;
const LIVE_HOME = flag('--live-home', null);
const LABEL = flag('--label', PACKAGED ? path.basename(path.dirname(PACKAGED)) : APP_DIR ? path.basename(APP_DIR) : 'app');
const ARMS = flag('--arms', 'ipc').split(',');
const EXPECT_RED = argv.includes('--expect-red');
const RIG_DIR = process.env.RIG_DIR, RIG_WAYLAND = process.env.RIG_WAYLAND;
if (!APP_DIR && !PACKAGED) { console.log('REFUSED: no <app-dir> / --packaged'); process.exit(3); }
const guard = makeGuard({ liveHome: LIVE_HOME, rigDir: RIG_DIR, rigWayland: RIG_WAYLAND });
const OUT = flag('--out', null) || path.join(RIG_DIR, 'shots');
const rec = makeRecorder(OUT);
const { clause } = rec;

const TRAP_DEADLINE_MS = 120_000;

async function bootArm(arm, size = [1440, 900]) {
  const armDir = path.join(RIG_DIR, `arm-${LABEL}-${arm}`);
  fs.mkdirSync(armDir, { recursive: true });
  const world = buildWorld(armDir, guard);
  console.log(`\n== arm ${LABEL}/${arm} == scratch ${armDir}`);
  const a = await launchApp({ appDir: APP_DIR, packaged: PACKAGED, world, guard, rigWayland: RIG_WAYLAND, size, tag: arm });
  const where = a.target.url;
  const ident = PACKAGED ? where.includes(path.dirname(PACKAGED)) : where.includes(APP_DIR) && !where.includes('app.asar');
  clause(arm, 'ctl/app-identity-path', ident, `target url ${where} (${PACKAGED ? 'packaged ⊇ ' + path.dirname(PACKAGED) : 'checkout ⊇ ' + APP_DIR + ', no app.asar'})`);
  const environ = fs.readFileSync(`/proc/${a.app.pid}/environ`, 'utf8').split('\0');
  const ev = (k) => (environ.find((e) => e.startsWith(k + '=')) || '').slice(k.length + 1);
  clause(arm, 'ctl/scratch-env', ev('ORCHESTRA_HOME') === world.ohome && ev('CLAUDE_CONFIG_DIR') === world.cfg && ev('HOME') === world.home && !environ.some((e) => e.startsWith('DISPLAY=')) && ev('WAYLAND_DISPLAY') === RIG_WAYLAND, `app environ: ORCHESTRA_HOME=${ev('ORCHESTRA_HOME')} CLAUDE_CONFIG_DIR=${ev('CLAUDE_CONFIG_DIR')} WAYLAND_DISPLAY=${ev('WAYLAND_DISPLAY')} DISPLAY=${ev('DISPLAY') || '<unset>'}`);
  const inSway = await waitFor(() => new RegExp(`"pid":\\s*${a.app.pid}\\b`).test(sh('swaymsg', ['-t', 'get_tree'])), 20000, "the app window in my sway's tree", 500).catch(() => false);
  clause(arm, 'ctl/app-in-my-sway', inSway, `app pid ${a.app.pid} present in my sway's get_tree (polled: the window maps a moment after the page target)`);
  await waitFor(() => a.cdp.eval(`document.querySelectorAll('.ws-item').length`).then((n) => n >= FLEET.length), 60000, `${FLEET.length} workspace rows`);
  const ver = JSON.parse(fs.readFileSync(path.join(APP_DIR ?? REPO, 'package.json'), 'utf8')).version;
  clause(arm, 'ctl/app-version', true, `package.json ${ver}; ${FLEET.length} sidebar rows rendered`);
  return { armDir, world, a, liveBusCheck: () => { const r = liveBusOpenedBy(world.ohome, LIVE_HOME); clause(arm, 'ctl/live-bus-never-opened', r.holders.length === 0 && r.opened === path.join(world.ohome, 'bus.sqlite'), `the app opened ${r.opened} (= its scratch bus); rig processes holding ~/.orchestra/bus.sqlite open: ${r.holders.length ? r.holders.join(',') : 'none'}`); } };
}

// ── arm ipc ──────────────────────────────────────────────────────────────────────────────────────────
async function armIpc() {
  const arm = 'ipc';
  const { world, a, liveBusCheck } = await bootArm(arm);
  const cdp = a.cdp;
  const call = (expr) => cdp.eval(`(async () => JSON.parse(JSON.stringify(await (${expr}))))()`);
  const I = IDS;
  const bus = () => world.readBus();
  const runRow = (id) => bus().runs.find((r) => r.id === id);
  const marker = (k) => ({ tracked: fs.readFileSync(path.join(world.workspaces.find((w) => w.id === I[k]).worktreePath, 'a.txt'), 'utf8'), untracked: fs.readFileSync(path.join(world.workspaces.find((w) => w.id === I[k]).worktreePath, `wip-${NAME_OF[I[k]]}.txt`), 'utf8') });
  const before = Object.fromEntries(['w1', 'w2', 'w3', 'w4', 'docs'].map((k) => [k, marker(k)]));
  try {
    // 1. pre-state — the READ
    const ov0 = await call('window.orchestra.pauseOverview()');
    clause(arm, 'G1/ipc-overview-available', ov0.available === true && ov0.error === null && ov0.runs.length === 0 && Object.keys(ov0.byWorkspace).length === 0, `pauseOverview(): available=${ov0.available}, runs=${ov0.runs.length}, badges=${Object.keys(ov0.byWorkspace).length}`);
    const ctl = ov0.controls;
    clause(arm, 'G1/ipc-controls-per-orchestrator', JSON.stringify(Object.keys(ctl).sort()) === JSON.stringify([I.lead, I.ops, I.legacy].sort()) && ctl[I.lead].switchOn === true && ctl[I.legacy].switchOn === false && ctl[I.lead].anchored === true, `controls for ${Object.keys(ctl).map((k) => NAME_OF[k]).join(', ')}; lead switchOn=${ctl[I.lead]?.switchOn}, legacy switchOn=${ctl[I.legacy]?.switchOn} (the FROZEN flags, read from the bus)`);
    await cdp.eval(`window.__pe = []; window.orchestra.onPauseOverviewUpdate((o) => window.__pe.push({ runs: o.runs.map((r) => [r.carrierRunId, r.phase, r.progress.done, r.progress.total, r.progress.kind]), badges: Object.keys(o.byWorkspace).length })); true`);

    // 2. refusals: typed outcomes, NOTHING written
    const busBefore = JSON.stringify(bus().runs.map((r) => [r.id, r.paused_at, r.pause_mode]));
    const wk = await call(`window.orchestra.pausePause(${JSON.stringify(I.w1)}, 'soft')`);
    clause(arm, 'G1/ipc-refusal-worker', wk.outcome === 'refused' && wk.runId === I.ops && wk.explain?.tone === 'error' && /n'est pas coordinateur/.test(wk.explain?.title ?? ''), `worker-1 → outcome=${wk.outcome} run=${NAME_OF[wk.runId] ?? wk.runId}; "${wk.explain?.title}"`);
    const off = await call(`window.orchestra.pausePause(${JSON.stringify(I.legacy)}, 'hard')`);
    clause(arm, 'G1/ipc-refusal-switch-off', off.outcome === 'switch-off' && /désactivée/.test(off.explain?.title ?? ''), `legacy-sweep → outcome=${off.outcome}; "${off.explain?.title}"`);
    const ghost = await call(`window.orchestra.pausePause('00000000-0000-4000-8000-00000000dead', 'soft')`);
    clause(arm, 'G1/ipc-refusal-unknown-workspace', ghost.outcome === 'unknown-workspace' && ghost.runId === null, `unknown id → outcome=${ghost.outcome}`);
    const busAfterRefusals = JSON.stringify(bus().runs.map((r) => [r.id, r.paused_at, r.pause_mode]));
    clause(arm, 'G1/ipc-refusals-write-nothing', busBefore === busAfterRefusals && bus().roster.length === 0, `runs' pause columns identical before/after the 3 refusals (${busBefore === busAfterRefusals}); pause_members rows ${bus().roster.length}`);

    // 3. Pause dure from the lead row — the REAL host trap
    const t0 = Date.now();
    const p = await call(`window.orchestra.pausePause(${JSON.stringify(I.lead)}, 'hard')`);
    clause(arm, 'G1/ipc-pause-dure-written-by-the-shipped-writer', p.outcome === 'paused' && p.actor === I.lead && runRow(I.lead).paused_by === I.lead && runRow(I.lead).pause_mode === 'hard', `outcome=${p.outcome}; bus: paused_by=${NAME_OF[runRow(I.lead).paused_by]} mode=${runRow(I.lead).pause_mode}`);
    await waitFor(() => runRow(I.lead).pause_trap_at !== null, TRAP_DEADLINE_MS, 'the host trap to finish', 500);
    const dureMs = Date.now() - t0;
    const b1 = bus();
    const rows = b1.roster.filter((r) => r.run_id === I.lead);
    clause(arm, 'G1/ipc-trap-took-every-member', rows.length === 7 && rows.every((r) => r.pause_confirmed_at !== null) && b1.bilan.length === 7, `${rows.length}/7 roster rows confirmed (${[...new Set(rows.map((r) => r.pause_confirm_via))].join('+')}), ${b1.bilan.length} Bilan rows — all paused in ${dureMs} ms (bar < 60 s)`);
    const refs = {};
    for (const k of ['w1', 'w2', 'w3', 'w4', 'docs']) {
      const wt = world.workspaces.find((w) => w.id === I[k]).worktreePath;
      const list = git(wt, 'for-each-ref', 'refs/orchestra/pause', '--format=%(refname)').split('\n').filter((r) => r.includes(`/${I[k]}/`)); // the refs live in the SHARED repo: this member's only
      const diff = list.length ? git(wt, 'diff', 'HEAD', list[0]) : '';
      refs[k] = { n: list.length, work: diff.includes(`WIP-${NAME_OF[I[k]]}`) };
      const untracked = list.length ? git(wt, 'ls-tree', '-r', '--name-only', list[0]) : '';
      refs[k].untracked = untracked.includes(`wip-${NAME_OF[I[k]]}.txt`);
    }
    clause(arm, 'G1/ipc-no-lost-work', Object.values(refs).every((r) => r.n === 1 && r.work && r.untracked) && ['w1', 'w2', 'w3', 'w4', 'docs'].every((k) => JSON.stringify(marker(k)) === JSON.stringify(before[k])), `each worker's pause ref holds its tracked edit AND its untracked file (${JSON.stringify(refs)}); worktrees byte-identical after the pause`);
    const ov1 = await call('window.orchestra.pauseOverview()');
    const run1 = ov1.runs.find((r) => r.carrierRunId === I.lead);
    clause(arm, 'G1/ipc-overview-paused', run1?.phase === 'paused' && run1.progress.done === 7 && run1.progress.total === 7 && Object.keys(ov1.byWorkspace).length === 7 && Object.values(ov1.byWorkspace).every((b) => b.ui === 'paused') && !ov1.byWorkspace[I.legacy] && !ov1.byWorkspace[I.sa], `phase=${run1?.phase} ${run1?.progress.done}/${run1?.progress.total}; badges ${Object.keys(ov1.byWorkspace).length} (all paused); legacy wave untouched`);
    const w1m = run1?.members.find((m) => m.wsId === I.w1);
    clause(arm, 'G1/ipc-bilan-carried', !!w1m?.bilan?.snapshotRef && w1m.bilan.snapshotRef.startsWith('refs/orchestra/pause/') && w1m.bilan.dirty === true && w1m.confirmVia === 'trap', `worker-1 Bilan: ${w1m?.bilan?.snapshotRef}, dirty=${w1m?.bilan?.dirty}, via=${w1m?.confirmVia}`);
    const pe = await call('window.__pe');
    clause(arm, 'G1/ipc-push-reached-the-renderer', pe.length > 0 && pe.some((e) => e.runs.some((r) => r[1] === 'paused' && r[2] === 7 && r[3] === 7)), `${pe.length} pause:update push(es); one carries paused 7/7`);

    // 4. Reprise: coordinators first, workers released afterwards
    const rs = await call(`window.orchestra.pauseResume(${JSON.stringify(I.lead)})`);
    const ov2 = rs.overview, run2 = ov2.runs.find((r) => r.carrierRunId === I.lead);
    const blocked = (run2?.blocked ?? []).map((id) => NAME_OF[id]).sort();
    clause(arm, 'G1/ipc-reprise-coordinators-first', rs.outcome === 'resuming' && run2?.phase === 'resuming' && run2.progress.kind === 'repris' && JSON.stringify(blocked) === JSON.stringify(['docs-sweep', 'worker-1', 'worker-2', 'worker-3', 'worker-4']), `outcome=${rs.outcome}; phase=${run2?.phase}; blocked=[${blocked.join(', ')}]; coordinators released=${run2?.members.filter((m) => m.role === 'coordinator' && m.releasedAt !== null).length}/2`);
    const wr = await call(`window.orchestra.pauseRelease(${JSON.stringify(I.w1)}, [${JSON.stringify(I.w2)}])`);
    clause(arm, 'G1/ipc-release-refused-for-a-worker', wr.result?.refused?.length === 1 && wr.result.released.length === 0 && wr.explain.some((e) => e.tone === 'error'), `worker-1 releasing worker-2 → refused=${JSON.stringify(wr.result?.refused?.map((x) => [NAME_OF[x.wsId], x.mayBe.map((m) => NAME_OF[m])]))}, released=${wr.result?.released.length}`);
    const ra = await call(`window.orchestra.pauseRelease(${JSON.stringify(I.ops)}, ${JSON.stringify([I.w1, I.w2, I.w3, I.w4])})`);
    const rb = await call(`window.orchestra.pauseRelease(${JSON.stringify(I.lead)}, ${JSON.stringify([I.docs])})`);
    clause(arm, 'G1/ipc-release-by-owner', ra.result.released.length === 4 && rb.result.released.length === 1 && rb.result.finished === true, `wave-ops released ${ra.result.released.length}/4 workers; fleet-lead released docs-sweep (${rb.result.released.length}); finished=${rb.result.finished}`);
    const ov3 = await call('window.orchestra.pauseOverview()');
    clause(arm, 'G1/ipc-badges-clear', runRow(I.lead).paused_at === null && Object.keys(ov3.byWorkspace).length === 0, `paused_at=${runRow(I.lead).paused_at}; badges ${Object.keys(ov3.byWorkspace).length}; tracked run: ${ov3.runs.map((r) => `${NAME_OF[r.carrierRunId]} ${r.phase} ${r.progress.done}/${r.progress.total} ${r.progress.kind}`).join('; ') || 'none'}`);

    // 5. Pause douce from the lead row: members idle ⇒ the host confirms them, escalates, takes them
    const t1 = Date.now();
    const sp = await call(`window.orchestra.pausePause(${JSON.stringify(I.lead)}, 'soft')`);
    clause(arm, 'G1/ipc-pause-douce-written', sp.outcome === 'paused' && runRow(I.lead).pause_mode === 'soft' && runRow(I.lead).pause_deadline_at - runRow(I.lead).paused_at === 180000, `outcome=${sp.outcome}; mode=${runRow(I.lead).pause_mode}; deadline − paused_at = ${runRow(I.lead).pause_deadline_at - runRow(I.lead).paused_at} ms (3 min)`);
    await waitFor(() => runRow(I.lead).pause_trap_at !== null, TRAP_DEADLINE_MS, 'the douce to escalate and the trap to finish', 500);
    const ov4 = await call('window.orchestra.pauseOverview()');
    const run4 = ov4.runs.find((r) => r.carrierRunId === I.lead);
    clause(arm, 'G1/ipc-douce-all-idle-confirmed-then-trapped', run4?.phase === 'paused' && run4.progress.done === 7 && run4.mode === 'soft' && run4.escalatedAt !== null, `phase=${run4?.phase} ${run4?.progress.done}/${run4?.progress.total}; escalated at +${(run4?.escalatedAt ?? 0) - (run4?.pausedAt ?? 0)} ms (idle members: no wait for the 3 min); wall ${Date.now() - t1} ms`);
    const esc = await call(`window.orchestra.pausePause(${JSON.stringify(I.lead)}, 'hard')`);
    clause(arm, 'G1/ipc-repeat-pause-is-already-paused', esc.outcome === 'already-paused' && esc.explain?.tone === 'info', `second pause → ${esc.outcome} (${esc.explain?.title})`);
    await call(`window.orchestra.pauseResume(${JSON.stringify(I.lead)})`);
    await call(`window.orchestra.pauseRelease(${JSON.stringify(I.ops)}, ${JSON.stringify([I.w1, I.w2, I.w3, I.w4])})`);
    await call(`window.orchestra.pauseRelease(${JSON.stringify(I.lead)}, ${JSON.stringify([I.docs])})`);
    clause(arm, 'G1/ipc-back-to-active-nothing-lost', runRow(I.lead).paused_at === null && ['w1', 'w2', 'w3', 'w4', 'docs'].every((k) => JSON.stringify(marker(k)) === JSON.stringify(before[k])), `lead paused_at=${runRow(I.lead).paused_at}; every worktree byte-identical to its pre-pause content after 2 cycles`);
  } catch (e) {
    clause(arm, 'G1/ipc-arm-completed', false, `ARM ABORTED: ${e.stack || e}`);
  } finally {
    cdp.close();
    liveBusCheck();
    const left = await a.kill();
    clause(arm, 'ctl/teardown-no-survivors', left.length === 0, `processes still carrying ${world.ohome}: ${left.length ? left.join(',') : 'none'}`);
  }
}

// ── main ───────────────────────────────────────────────────────────────────────────────────────────
const before = liveCanary(LIVE_HOME);
console.log(`[rig] app ${APP_DIR ?? PACKAGED} label ${LABEL} arms ${ARMS.join(',')} expect-red=${EXPECT_RED} out=${OUT}`);
for (const arm of ARMS) {
  if (arm === 'ipc') await armIpc();
  else if (arm === 'ui') { const { armUi } = await import('./ui-arm.mjs'); await armUi({ bootArm, rec, guard, OUT, LABEL, RIG_DIR, RIG_WAYLAND, APP_DIR, PACKAGED }); }
  else refuse(`unknown arm ${arm}`);
}
const after = liveCanary(LIVE_HOME);
const same = JSON.stringify(before) === JSON.stringify(after);
clause('rig', 'ctl/live-dirs-untouched', same, `${Object.keys(before).length} live ~/.claude* dirs (symlink-set + mcpServers hashes) ${same ? 'identical before/after' : 'CHANGED: ' + JSON.stringify({ before, after })}`);

console.log('\n== shots (md5) ==');
for (const s of rec.shots) console.log(`  ${s.md5}  ${s.file}`);
const dup = rec.shots.length - new Set(rec.shots.map((s) => s.md5)).size;
console.log(`  duplicates among captures: ${dup}`);
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, `${LABEL}-result.json`), JSON.stringify({ app: APP_DIR ?? PACKAGED, label: LABEL, arms: ARMS, results: rec.results, shots: rec.shots }, null, 2));
const isCtl = (c) => c.clause.startsWith('ctl/');
const ctlRed = rec.results.filter((c) => isCtl(c) && !c.ok), gAll = rec.results.filter((c) => !isCtl(c)), gRed = gAll.filter((c) => !c.ok);
let verdict, rc;
if (EXPECT_RED) {
  ({ verdict, rc } = ctlRed.length === 0 && gAll.length > 0 && gRed.length === gAll.length ? { verdict: `EXPECTED-RED CONFIRMED: ${gRed.length}/${gAll.length} G-clauses red, every ctl/* green`, rc: 0 } : { verdict: `EXPECTED-RED NOT MET: ${gRed.length}/${gAll.length} G-clauses red; controls red: ${ctlRed.map((c) => `${c.arm} ${c.clause}`).join('; ') || 'none'}`, rc: 1 });
} else {
  ({ verdict, rc } = ctlRed.length === 0 && gRed.length === 0 && gAll.length > 0 ? { verdict: `ALL GREEN: ${rec.results.length} clauses (${gAll.length} G, ${rec.results.length - gAll.length} control)`, rc: 0 } : { verdict: `RED: ${rec.results.filter((c) => !c.ok).map((c) => `${c.arm} ${c.clause}`).join('; ')}`, rc: 1 });
}
console.log(`\nVERDICT: ${verdict}`);
process.exit(rc);
