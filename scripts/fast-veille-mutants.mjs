// #288 self-gate — IN-PLACE mutation sweep of fast Veille. Each mutant edits ONE clause of the real source, runs the unit suites + the NAMED arms of the
// end-to-end rig (scripts/e2e-fast-veille.mjs: real sweeper + real guard on a fake MemAvailable source + stub CLI), and must turn EVERY named test/arm red.
// Byte-exact backup + `cmp` restore after every mutant; `git diff` of the mutated files must be empty at the end (commit first). A mutation sweep is HEAVY by
// the wave rule: needs a heavy-rig token + MemAvailable > 9 GB.
// Run: node scripts/fast-veille-mutants.mjs [--only V01,V02] [--no-rig] [--check-anchors]

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const BACKUP = path.join(os.homedir(), '.cache', 'g5-288', 'mutant-backup');
fs.mkdirSync(BACKUP, { recursive: true });
const args = process.argv.slice(2);
const only = args.includes('--only') ? new Set(args[args.indexOf('--only') + 1].split(',')) : null;
const noRig = args.includes('--no-rig');

const SH = 'src/shared/hibernation.ts';
const HB = 'src/main/hibernation.ts';
const MG = 'src/main/memory-guard.ts';
const AG = 'src/main/agent-sdk.ts';
const FAST = '  if (admissionHeld && isFleetMember(ws)) return true;\n';
const GUARD_ARMS = ['guard_turn', 'guard_pending_prompt', 'guard_loop', 'guard_bg_task', 'guard_active_pane', 'guard_run_pty', 'guard_waiting'];
// Move the fast clause to sit just BEFORE one guard line (so that guard — and every one after it — is bypassed).
const before = (guardLine) => ({ edits: [{ find: FAST, to: '' }, { find: guardLine, to: FAST + guardLine }] });

// `expect` = substrings of reddened unit test names or `rig:<arm>` — EVERY one must be among the red ones; `arms` = the rig arms to run ([] = none).
const MUTANTS = [
  // ── pure rule (shared/hibernation.ts) ──
  { id: 'V01_fast_clause_removed', file: SH, find: FAST, to: '', expect: ['baseline pair', 'rig:held_veille', 'rig:edge_sweep'], arms: ['held_veille', 'edge_sweep'] },
  { id: 'V02_non_member_goes', file: SH, find: 'if (admissionHeld && isFleetMember(ws)) return true;', to: 'if (admissionHeld) return true;', expect: ['without a coordinator', 'rig:no_coordinator'], arms: ['no_coordinator'] },
  { id: 'V03_open_fleet_goes', file: SH, find: 'if (admissionHeld && isFleetMember(ws)) return true;', to: 'if (isFleetMember(ws)) return true;', expect: ['baseline pair', 'rig:open_waits'], arms: ['open_waits'] },
  { id: 'V04_clause_before_all_guards', file: SH, ...before("  // Nothing running → nothing to reclaim.\n  if (!hasLivePty && !hasLiveSdk) return false;\n"), expect: ['no live process', ...GUARD_ARMS.map((a) => `rig:${a}`)], arms: GUARD_ARMS },
  { id: 'V05_before_status', file: SH, ...before("  if (ws.status !== 'idle') return false;\n"), expect: ['running turn (status running)', 'rig:guard_turn', 'rig:guard_waiting'], arms: ['guard_turn', 'guard_waiting'] },
  { id: 'V06_before_pending_prompt', file: SH, ...before('  if (ws.sdkPendingPrompts?.length) return false;\n'), expect: ['pending prompt', 'rig:guard_pending_prompt'], arms: ['guard_pending_prompt'] },
  { id: 'V07_before_loop', file: SH, ...before('  if (ws.loopingSince) return false;\n'), expect: ['/loop', 'rig:guard_loop'], arms: ['guard_loop'] },
  { id: 'V08_before_active', file: SH, ...before('  if (isActive) return false;\n'), expect: ['active pane', 'rig:guard_active_pane'], arms: ['guard_active_pane'] },
  { id: 'V09_before_sandbox', file: SH, ...before('  if (ws.host) return false;\n'), expect: ['sandbox-hosted'], arms: [] },
  { id: 'V10_before_archived', file: SH, ...before('  if (ws.archived) return false;\n'), expect: ['archived'], arms: [] },
  { id: 'V11_before_run_pty', file: SH, ...before('  if (hasLiveRunPty) return false;\n'), expect: ['run-script PTY', 'rig:guard_run_pty'], arms: ['guard_run_pty'] },
  { id: 'V12_before_bg_task', file: SH, ...before('  if (hasLiveBackgroundTask) return false;\n'), expect: ['background task', 'rig:guard_bg_task'], arms: ['guard_bg_task'] },
  { id: 'V13_before_unknown_activity', file: SH, ...before('  if (lastActivityAt === undefined) return false;\n'), expect: ['unknown activity'], arms: [] },
  { id: 'V14_before_kill_switch', file: SH, ...before('  if (thresholdMs === HIBERNATION_DISABLED) return false;\n'), expect: ['disabled sentinel'], arms: [] },
  // ── log tail (shared, unit-pinned; the rig pins the end-to-end line) ──
  { id: 'L01_open_line_changed', file: SH, find: "  if (!admissionHeld) return '';\n", to: '', expect: ['empty with Admission open', 'rig:open_waits'], arms: ['open_waits'] },
  { id: 'L02_early_always', file: SH, find: '${early ? `, fast Veille', to: '${true ? `, fast Veille', expect: ['marks an EARLY Veille only when', 'rig:held_mixed'], arms: ['held_mixed'] },
  { id: 'L03_unknown_meter_figure', file: SH, find: "snap.availBytes === null ? 'MemAvailable unknown' :", to: "false ? 'MemAvailable unknown' :", expect: ['unreadable meter'], arms: [] },
  { id: 'L04_last_good_unmarked', file: SH, find: "${snap.measured ? '' : ' (last good reading)'}", to: '', expect: ['unreadable meter'], arms: [] },
  { id: 'L05_one_decimal', file: SH, find: 'formatGb(snap.availBytes, 2)', to: 'formatGb(snap.availBytes, 1)', expect: ['names MemAvailable (2 decimals)', 'rig:held_veille'], arms: ['held_veille'] },
  { id: 'L06_mem_not_named', file: SH, find: '` — Admission HELD, ${mem}${early', to: '` — Admission HELD${early', expect: ['names MemAvailable (2 decimals)', 'rig:held_veille'], arms: ['held_veille'] },
  // ── sweeper (main/hibernation.ts) ──
  { id: 'S01_never_held', file: HB, find: 'const admissionHeld = isAdmissionHolding(guardSnap);', to: 'const admissionHeld = false;', expect: ['PER MEMBER', 'rig:held_veille', 'rig:edge_sweep', 'rig:boot_held'], arms: ['held_veille', 'edge_sweep', 'boot_held'] },
  // #326 (Veille and Reliquats): the sweep now re-judges every member on FRESH state after its verdict awaited (`again`, a real read of the guard snapshot) and serialises same-member passes (`veilleBusy`). That DEFENCE IN DEPTH hides the
  // OUTCOME of S02 / S13 / O04-O06 from the original arms (measured: S02 turns `toggle_off` red only when the re-check is disabled too) — #326-fu m5 pins them again at the rig level through what they still change: WHO IS ASKED
  // (a Reliquat census for a member that is not eligible: `toggle_off_census`, `reopen_census`) and WHEN a second pass can slip in (`overlap_post_verdict`, with a REAL yield — see the O04-O06 note).
  { id: 'S02_ignores_the_toggle', file: HB, find: 'const admissionHeld = isAdmissionHolding(guardSnap);', to: "const admissionHeld = guardSnap.admission === 'held';", expect: ['PER MEMBER', 'rig:toggle_off_census'], arms: ['toggle_off_census'] },
  { id: 'S03_early_never', file: HB, find: 'const early = admissionHeld && !shouldHibernate(ws, { ...signals, admissionHeld: false, liveReliquats: verdict.liveReliquats });', to: 'const early = false;', expect: ['log tail', 'rig:held_veille', 'rig:held_mixed'], arms: ['held_veille', 'held_mixed'] },
  { id: 'S04_early_always', file: HB, find: 'const early = admissionHeld && !shouldHibernate(ws, { ...signals, admissionHeld: false, liveReliquats: verdict.liveReliquats });', to: 'const early = admissionHeld;', expect: ['log tail', 'rig:held_mixed'], arms: ['held_mixed'] },
  { id: 'S05_signal_not_passed', file: HB, find: '      admissionHeld,\n      reliquatDelayMs,\n    };', to: '      admissionHeld: false,\n      reliquatDelayMs,\n    };', expect: ['PER MEMBER', 'rig:held_veille'], arms: ['held_veille'] },
  { id: 'F01_sample_listener_dead', file: HB, find: 'if (isAdmissionHolding(snap)) sweepNow();', to: 'void snap;', expect: ['every guard SAMPLE', 'rig:late_idler', 'rig:edge_sweep'], arms: ['late_idler', 'edge_sweep'] },
  { id: 'F02_sample_sweeps_when_open', file: HB, find: 'if (isAdmissionHolding(snap)) sweepNow();', to: 'sweepNow();', expect: ['every guard SAMPLE', 'rig:samples_quiet'], arms: ['samples_quiet'] },
  { id: 'F03_edge_trigger_only', file: HB, edits: [{ find: "import { getMemoryGuardSnapshot, subscribeMemoryGuardSamples } from './memory-guard.ts';", to: "import { getMemoryGuardSnapshot, subscribeMemoryGuard } from './memory-guard.ts';" }, { find: '  unsubscribeGuard = subscribeMemoryGuardSamples((snap) => {\n    if (isAdmissionHolding(snap)) sweepNow();\n  });', to: "  unsubscribeGuard = subscribeMemoryGuard((e) => {\n    if (e.transition.kind === 'admission_held' && isAdmissionHolding(e.snapshot)) sweepNow();\n  });" }], expect: ['every guard SAMPLE', 'rig:late_idler'], arms: ['late_idler'] },
  { id: 'F04_second_timer', file: HB, find: '  unsubscribeGuard = subscribeMemoryGuardSamples((snap) => {', to: '  setInterval(sweepNow, 10_000).unref?.();\n  unsubscribeGuard = subscribeMemoryGuardSamples((snap) => {', expect: ['every guard SAMPLE'], arms: [] },
  { id: 'S08_no_boot_reconcile', file: HB, find: '  if (isAdmissionHolding(getMemoryGuardSnapshot())) sweepNow();\n', to: '', expect: ['every guard SAMPLE', 'rig:boot_held'], arms: ['boot_held'] },
  { id: 'S09_reconcile_before_subscribe', file: HB, edits: [{ find: '  if (isAdmissionHolding(getMemoryGuardSnapshot())) sweepNow();\n', to: '' }, { find: '  unsubscribeGuard = subscribeMemoryGuardSamples((snap) => {', to: '  if (isAdmissionHolding(getMemoryGuardSnapshot())) sweepNow();\n  unsubscribeGuard = subscribeMemoryGuardSamples((snap) => {' }], expect: ['every guard SAMPLE'], arms: [] },
  { id: 'S10_timer_never_ticks', file: HB, find: 'timer = setInterval(sweepNow, sweepMs);', to: 'timer = setInterval(() => {}, sweepMs);', expect: ['SAME un-queued sweep'], arms: [] },
  { id: 'S11_sweep_rejection_unhandled', file: HB, find: ".catch((e) => hlog.swallow('sweep', e));\n", to: ';\n', expect: ['SAME un-queued sweep'], arms: [] },
  { id: 'S12_no_unsubscribe', file: HB, find: '  unsubscribeGuard?.();\n  unsubscribeGuard = null;\n', to: '', expect: ['stop path unsubscribes'], arms: [] },
  { id: 'S13_snapshot_hoisted_out_of_the_loop', file: HB, edits: [{ find: '    const guardSnap = getMemoryGuardSnapshot();\n    const admissionHeld = isAdmissionHolding(guardSnap);\n\n    const signals = {', to: '    const signals = {' }, { find: '  for (const ws of store.workspaces) {\n    if (isBeingDeleted(ws.id)) continue;', to: '  const guardSnap = getMemoryGuardSnapshot();\n  const admissionHeld = isAdmissionHolding(guardSnap);\n  for (const ws of store.workspaces) {\n    if (isBeingDeleted(ws.id)) continue;' }], expect: ['PER MEMBER', 'rig:reopen_census'], arms: ['reopen_census'] },
  { id: 'S14_sweep_samples_the_meter', file: HB, find: 'const guardSnap = getMemoryGuardSnapshot();', to: 'const guardSnap = sampleMemoryGuardNow();', expect: ['PER MEMBER'], arms: [], extra: [{ find: "import { getMemoryGuardSnapshot, subscribeMemoryGuardSamples } from './memory-guard.ts';", to: "import { getMemoryGuardSnapshot, sampleMemoryGuardNow, subscribeMemoryGuardSamples } from './memory-guard.ts';" }] },
  // ── per-sample guard hook (memory-guard.ts, FI-2 item 7) ──
  { id: 'G01_samples_never_delivered', file: MG, find: '    drainSamples();\n    return snap;', to: '    return snap;', expect: ['onSample: one call per SAMPLE', 'rig:late_idler', 'rig:edge_sweep'], arms: ['late_idler', 'edge_sweep'] },
  { id: 'G02_stale_snapshot_delivered', file: MG, find: '    sampleQueue.push(snapshot());', to: '    sampleQueue.push(snap);', expect: ['OUTER sample reports the freshest'], arms: [] },
  { id: 'G03_throwing_sample_listener_breaks_the_guard', file: MG, find: "deps.warn('a sample listener threw (ignored)', err);", to: 'throw err;', expect: ['onSample: one call per SAMPLE'], arms: [] },
  { id: 'G10_facade_throw_breaks_the_line', file: MG, find: "glog.warn('a sample listener threw (ignored)', err);", to: 'throw err;', expect: ['facade: subscribeMemoryGuardSamples'], arms: [] },
  { id: 'G04_samples_before_edges', file: MG, find: "    drain();\n    // The freshest state, not `snap`: an edge listener may have re-measured (nested `sampleNow`) while the batch was delivered.\n    sampleQueue.push(snapshot());\n    drainSamples();\n    return snap;", to: "    sampleQueue.push(snapshot());\n    drainSamples();\n    drain();\n    return snap;", expect: ["a sample's listeners run AFTER its own edges"], arms: [] },
  { id: 'G09_sample_listener_reentered', file: MG, find: '    if (drainingSamples) return;\n    drainingSamples = true;', to: '    drainingSamples = true;', expect: ['never re-entered'], arms: [] },
  { id: 'G05_sample_unsubscribe_noop', file: MG, find: '    onSample(listener) {\n      sampleListeners.add(listener);\n      return () => {\n        sampleListeners.delete(listener);', to: '    onSample(listener) {\n      sampleListeners.add(listener);\n      return () => {\n        void 0;', expect: ['onSample: one call per SAMPLE'], arms: [] },
  { id: 'G06_facade_not_forwarded', file: MG, find: '  g.onSample((snap) => {\n    for (const l of [...sampleListeners]) {\n      try {\n        l(snap);', to: '  void ((snap: MemoryGuardSnapshot) => {\n    for (const l of [...sampleListeners]) {\n      try {\n        l(snap);', expect: ['facade: subscribeMemoryGuardSamples', 'rig:late_idler'], arms: ['late_idler'] },
  { id: 'G07_rebuild_drops_sample_subscribers', file: MG, find: '  sourceOverride = source;\n  singleton = buildSingleton(over);', to: '  sourceOverride = source;\n  sampleListeners.clear();\n  singleton = buildSingleton(over);', expect: ['facade: subscribeMemoryGuardSamples'], arms: [] },
  { id: 'G08_sample_not_delivered_when_unreadable', file: MG, find: '    drain();\n    // The freshest state', to: '    drain();\n    if (!d.measured) return snap;\n    // The freshest state', expect: ['onSample: one call per SAMPLE'], arms: [] },
  // ── overlap safety (agent-sdk.ts; seat-1 MINOR on #288) ──
  { id: 'O01_stopping_session_reads_live', file: AG, find: 'export function sdkHasSession(wsId: string): boolean {\n  const s = sessions.get(wsId);\n  return !!s && !s.stopping;', to: 'export function sdkHasSession(wsId: string): boolean {\n  const s = sessions.get(wsId);\n  return !!s;', expect: ['sdkHasSession excludes a stopping session', 'rig:overlap_probe'], arms: ['overlap_probe'] },
  { id: 'O02_await_before_the_stopping_mark', file: AG, find: '  session.stopping = true;\n  // Session-scoped (a successor is a new object)', to: '  await Promise.resolve();\n  session.stopping = true;\n  // Session-scoped (a successor is a new object)', expect: ['nothing yields between sdkStop'], arms: [] },
  { id: 'O03_stopping_never_marked', file: AG, find: '  session.stopping = true;\n  // Session-scoped (a successor is a new object)', to: '  // Session-scoped (a successor is a new object)', expect: ['rig:overlap_probe'], arms: ['overlap_probe'] },
  // O04-O06 inject a REAL yield (a 40 ms timer), not `await Promise.resolve()`: since #326 a competing pass awaits its own verdict before it re-reads liveness, so a ONE-microtask await is behaviourally EQUIVALENT (the stop wins the race) —
  // the hazard is an await long enough for the second pass to finish its checks inside the window. `overlap_post_verdict` starts that second pass the instant the first yields after its verdict.
  { id: 'O04_await_before_the_session_check', file: AG, find: 'export async function sdkStop(wsId: string, opts?: { hibernate?: boolean }): Promise<void> {\n  const session = sessions.get(wsId);', to: 'export async function sdkStop(wsId: string, opts?: { hibernate?: boolean }): Promise<void> {\n  const session = sessions.get(wsId);\n  await new Promise((r) => setTimeout(r, 40));', expect: ['nothing yields between sdkStop', 'rig:overlap_post_verdict'], arms: ['overlap_post_verdict'] },
  { id: 'O05_await_between_live_check_and_stop', file: HB, find: '    if (!liveSdkNow && !livePtyNow) continue;\n', to: '    if (!liveSdkNow && !livePtyNow) continue;\n    await new Promise((r) => setTimeout(r, 40));\n', expect: ['nothing yields between the sweep', 'rig:overlap_post_verdict'], arms: ['overlap_post_verdict'] },
  { id: 'O06_await_before_impl_stop', file: 'src/main/sdk-delivery.ts', find: '  const had = impl.hasSession(wsId);\n  await impl.stop(wsId, opts);', to: '  const had = impl.hasSession(wsId);\n  await new Promise((r) => setTimeout(r, 40));\n  await impl.stop(wsId, opts);', expect: ['nothing yields between the sweep', 'rig:overlap_post_verdict'], arms: ['overlap_post_verdict'] },
];

const TESTS = ['src/shared/hibernation.test.ts', 'src/main/memory-guard.test.ts', 'src/main/hibernation-fast-veille-wiring.test.ts', 'src/main/memory-guard-wiring.test.ts', 'src/main/hibernation-no-disk.test.ts'];
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(path.join(REPO, f))).digest('hex');
const sh = (cmd, a, opts = {}) => spawnSync(cmd, a, { cwd: REPO, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 300_000, ...opts });
const editsOf = (m) => m.edits ?? [{ find: m.find, to: m.to }, ...(m.extra ?? [])];

function unitRed() {
  const r = sh(process.execPath, ['--test', '--experimental-strip-types', ...TESTS]);
  const names = [...(r.stdout ?? '').matchAll(/^\s*not ok \d+ - (.*)$/gm)].map((m) => m[1]);
  const pass = Number(/^# pass (\d+)/m.exec(r.stdout ?? '')?.[1] ?? NaN);
  const skipped = Number(/^# skipped (\d+)/m.exec(r.stdout ?? '')?.[1] ?? NaN);
  return { names, pass, skipped, status: r.status };
}
function rigRed(arms) {
  if (noRig) return { arms: [], pass: 0, total: 0, line: '(rig skipped)' };
  const env = { ...process.env, ...(arms && arms.length ? { RIG_ARMS: arms.join(',') } : {}) };
  const r = sh(process.execPath, ['--experimental-strip-types', '--import', pathToFileURL(path.join(HERE, '.r2-register.mjs')).href, path.join(HERE, 'e2e-fast-veille.mjs')], { env });
  const out = r.stdout ?? '';
  const pass = (out.match(/^PASS \w+/gm) ?? []).length;
  return { arms: [...out.matchAll(/^FAIL (\w+)/gm)].map((m) => m[1]), pass, total: pass + (out.match(/^FAIL \w+/gm) ?? []).length, line: (out.split('\n').filter((l) => l.startsWith('FAST-VEILLE RIG')).pop() ?? `no summary (exit ${r.status})`) };
}

if (args.includes('--check-anchors')) { // dry check: does every mutant's anchors resolve exactly once on the CURRENT sources, and does each mutant change something?
  let bad = 0;
  for (const m of MUTANTS) {
    let text = fs.readFileSync(path.join(REPO, m.file), 'utf8'); const orig = text; let why = null;
    for (const e of editsOf(m)) { const c = text.split(e.find).length - 1; if (c !== 1) { why = `${c}× ${e.find.slice(0, 70)}`; break; } text = text.replace(e.find, () => e.to); }
    if (!why && text === orig) why = 'no-op mutation';
    if (why) { bad++; console.log(`ANCHOR-BAD ${m.id}: ${why}`); }
  }
  console.log(`ANCHORS: ${MUTANTS.length - bad}/${MUTANTS.length} resolve exactly once`);
  process.exit(bad ? 1 : 0);
}

// ── guard: the tree must be committed (git diff is the independent restoration proof) ──
const files = [...new Set(MUTANTS.map((m) => m.file))];
const dirty = sh('git', ['diff', '--quiet', '--', ...files, ...TESTS, 'scripts/e2e-fast-veille.mjs', 'scripts/fast-veille-mutants.mjs']).status !== 0;
if (dirty) { console.error('REFUSING: the mutated files / suites / rig have uncommitted changes — commit first (the end-of-sweep `git diff` must prove restoration)'); process.exit(2); }
const shaBefore = Object.fromEntries(files.map((f) => [f, sha(f)]));

// ── POSITIVE CONTROL: the unmutated tree must be all green, else every "killed" below is vacuous ──
// the baseline rig must pass EVERY arm the rig declares (derived from its own ARMS list: a hard-coded count went stale the day the rig gained arms and aborted the whole gate — #326-fu review F1)
const RIG_ARM_COUNT = (/const ARMS = \[([^\]]*)\]/.exec(fs.readFileSync(path.join(HERE, 'e2e-fast-veille.mjs'), 'utf8'))?.[1].match(/'[^']+'/g) ?? []).length;
const base = unitRed();
const baseRig = rigRed();
console.log(`BASELINE unit: pass ${base.pass} fail ${base.names.length} skipped ${base.skipped} | rig: ${baseRig.line} (declared arms: ${RIG_ARM_COUNT})`);
if (base.names.length || base.status !== 0 || base.skipped !== 0 || baseRig.arms.length || (!noRig && (RIG_ARM_COUNT === 0 || baseRig.pass !== RIG_ARM_COUNT || baseRig.total !== RIG_ARM_COUNT))) { console.error('BASELINE NOT GREEN — aborting (nothing was mutated)'); process.exit(3); }

const rows = [];
let restoreBad = false;
const restore = (m, backupFile) => {
  fs.copyFileSync(backupFile, path.join(REPO, m.file));
  if (spawnSync('cmp', ['-s', backupFile, path.join(REPO, m.file)]).status !== 0) { restoreBad = true; console.error(`RESTORE FAILED for ${m.file} — stop and fix by hand: git checkout -- ${m.file}`); }
};
for (const m of MUTANTS) {
  if (only && !only.has(m.id)) continue;
  const abs = path.join(REPO, m.file);
  const original = fs.readFileSync(abs, 'utf8');
  let mutated = original; let anchorBad = null;
  for (const e of editsOf(m)) { const c = mutated.split(e.find).length - 1; if (c !== 1) { anchorBad = `find occurs ${c}× (need exactly 1): ${e.find.slice(0, 60)}`; break; } mutated = mutated.replace(e.find, () => e.to); }
  if (anchorBad) { rows.push({ id: m.id, verdict: 'ANCHOR-BAD', detail: anchorBad }); continue; }
  const backupFile = path.join(BACKUP, `${m.id}.orig`);
  fs.writeFileSync(backupFile, original);
  const onSig = () => { restore(m, backupFile); process.exit(130); };
  process.once('SIGINT', onSig); process.once('SIGTERM', onSig);
  try {
    fs.writeFileSync(abs, mutated);
    if (fs.readFileSync(abs, 'utf8') === original) { rows.push({ id: m.id, verdict: 'NO-OP', detail: 'the mutation changed nothing' }); continue; }
    const u = unitRed();
    const r = m.arms && m.arms.length === 0 ? { arms: [] } : rigRed(m.arms);
    const red = [...u.names, ...r.arms.map((a) => `rig:${a}`)];
    const hit = m.expect.filter((e) => red.some((n) => n.includes(e)));
    const all = hit.length === m.expect.length;
    rows.push({ id: m.id, verdict: all ? 'KILLED' : red.length ? 'KILLED-BUT-NOT-BY-ALL-NAMED' : 'SURVIVED', detail: `named ${JSON.stringify(m.expect)} hit ${JSON.stringify(hit)}; red: ${red.slice(0, 4).join(' | ')}${red.length > 4 ? ` (+${red.length - 4})` : ''}` });
  } finally {
    restore(m, backupFile);
    process.removeListener('SIGINT', onSig); process.removeListener('SIGTERM', onSig);
  }
}
const shaAfter = Object.fromEntries(files.map((f) => [f, sha(f)]));
const sameSha = files.every((f) => shaBefore[f] === shaAfter[f]);
const gitClean = sh('git', ['diff', '--quiet', '--', ...files]).status === 0;
const post = unitRed();
const postRig = rigRed();
for (const r of rows) console.log(`${r.verdict.padEnd(30)} ${r.id.padEnd(30)} ${r.detail}`);
const killed = rows.filter((r) => r.verdict === 'KILLED').length;
console.log(`RESTORED: sha-identical ${sameSha} · git diff clean ${gitClean} · cmp-restore ${!restoreBad} · post-sweep unit fail ${post.names.length} rig ${postRig.line}`);
console.log(`MUTANTS: ${killed}/${rows.length} killed by ALL their named tests/arms${rows.length === killed ? '' : ` — NOT ALL: ${rows.filter((r) => r.verdict !== 'KILLED').map((r) => `${r.id}=${r.verdict}`).join(', ')}`}`);
process.exit(rows.length === killed && sameSha && gitClean && !restoreBad && post.names.length === 0 && postRig.arms.length === 0 ? 0 : 1);
