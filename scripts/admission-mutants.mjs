// #286 self-gate — IN-PLACE mutation sweep of Admission. Each mutant edits ONE clause of the real source, runs the unit suites + the named arms of the
// end-to-end rig (scripts/e2e-admission-hold.mjs: real workspaces/restart/admission/guard modules, fake memory source + recording seam), and must turn the
// NAMED arm red. Byte-exact backup + `cmp` restore after every mutant; `git diff` of the mutated files must be empty at the end (commit first). A CLI mutant
// rebuilds dist-electron/cli.js (the instrument is rebuilt, never reused stale). HEAVY by the wave rule (a mutation sweep): needs the heavy-rig token.
// Run: node scripts/admission-mutants.mjs [--only A01,A02] [--no-rig] [--check-anchors]

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const BACKUP = path.join(os.homedir(), '.cache', 'g3-286', 'mutant-backup');
fs.mkdirSync(BACKUP, { recursive: true });
const args = process.argv.slice(2);
const only = args.includes('--only') ? new Set(args[args.indexOf('--only') + 1].split(',')) : null;
const noRig = args.includes('--no-rig');

const SH = 'src/shared/admission.ts';
const AD = 'src/main/admission.ts';
const WS = 'src/main/workspaces.ts';
const RS = 'src/main/restart-workspace.ts';
const HK = 'src/main/hooks-server.ts';
const CL = 'src/cli/index.ts';
const IX = 'src/main/index.ts';
// `expect` = a substring of the reddened unit test name or `rig:<arm>` that MUST be among the red ones; `arms` = the rig arms to run for it.
const MUTANTS = [
  { id: 'A01_human_held', file: SH, find: "return args.origin === 'auto' && isFleetMember(args.ws)", to: 'return isFleetMember(args.ws)', expect: ['human_passes', 'rig:human_passes'], arms: ['human_passes'] },
  { id: 'A02_non_member_held', file: SH, find: "args.origin === 'auto' && isFleetMember(args.ws) &&", to: "args.origin === 'auto' && true &&", expect: ['non_member_passes'], arms: ['human_passes'] },
  { id: 'A03_newcomer_jumps_the_line', file: SH, find: '(args.holding || args.queued)', to: 'args.holding', expect: ['not_holding', 'newcomer_joins_the_line'], arms: [] },
  { id: 'A04_coordinators_not_first', file: SH, find: '(h.coordinator && !best.coordinator)', to: 'false', expect: ['release_order', 'rig:release_order'], arms: ['release_order'] },
  { id: 'A05_arrival_order_reversed', file: SH, find: 'h.seq < best.seq', to: 'h.seq > best.seq', expect: ['release_order', 'rig:release_order'], arms: ['release_order'] },
  { id: 'A06_toggle_off_still_waits', file: SH, find: '  if (!snap.admissionEnabled) return { action: \'release\', entry };\n', to: '', expect: ['plan_release_toggle_off'], arms: [] },
  { id: 'A07_dead_meter_releases', file: SH, find: "  if (!snap.measured) return { action: 'wait', reason: 'unmeasured' };\n", to: '', expect: ['plan_release'], arms: [] },
  { id: 'A08_release_ignores_room', file: SH, find: "  if (!snap.mayReleaseOneStart) return { action: 'wait', reason: 'memory' };\n", to: '', expect: ['plan_release', 'rig:dip_stops'], arms: ['dip_stops'] },
  { id: 'A09_no_kick_on_newcomer', file: AD, find: '      if (!holding) void kick();\n', to: '', expect: ['newcomer_triggers_the_release'], arms: [] },
  { id: 'A10_kick_swallowed', file: AD, find: '      rerun = true;\n', to: '', expect: ['kick_during_wind_down'], arms: [] },
  { id: 'A11_no_settle_pause', file: AD, find: '      if (queue.size > 0) await deps.sleep(deps.settleMs);\n', to: '', expect: ['release_order'], arms: [] },
  { id: 'A12_not_owed_still_run', file: AD, find: '      if (!stillOwedSafe(entry)) {', to: '      if (false) {', expect: ['not_owed_anymore'], arms: [] },
  { id: 'A13_request_refresh_dropped', file: AD, find: '        entry.run = a.run; // the newest request wins; the original arrival (since, seq) is kept\n', to: '', expect: ['repeat_request_keeps_the_original_slot'], arms: [] },
  { id: 'A14_reopen_edge_ignored', file: AD, find: "if (e.transition.kind === 'admission_reopened') void singleton.kick();", to: '', expect: ['facade'], arms: [] },
  { id: 'A15_release_runs_without_fresh_sample', file: AD, find: '      const snap = deps.sample();\n      const step = planRelease(', to: '      const snap = lastSnap ?? deps.sample();\n      lastSnap = snap;\n      const step = planRelease(', expect: ['release_order', 'rig:release_order'], arms: ['release_order'], pre: [{ file: AD, find: '  let waitLogged: string | null = null;\n', to: '  let waitLogged: string | null = null;\n  let lastSnap: MemoryGuardSnapshot | null = null;\n' }] },
  { id: 'A16_run_failure_silent', file: AD, find: '      } else if (isFailure(outcome)) {', to: '      } else if (false) {', expect: ['run_failure_is_logged_not_silent', 'refused_while_paused_keeps_its_slot'], arms: [] },
  { id: 'A17_refused_release_lost', file: AD, find: '        if (entry.retryLater?.(outcome)) {', to: '        if (false) {', expect: ['refused_while_paused_keeps_its_slot', 'rig:pause_keeps_slot'], arms: ['pause_keeps_slot'] },
  { id: 'A18_release_unbounded', file: AD, find: '      const timer = deps.schedule(() => finish(TIMED_OUT), deps.runTimeoutMs);', to: '      const timer = {};', expect: ['hung_release_does_not_block_the_line'], arms: [] },
  { id: 'A19_duplicate_during_release', file: AD, find: "      if (inFlight && a.origin === 'auto') return {", to: "      if (false) return {", expect: ['repeat_auto_request_during_release'], arms: [] },
  { id: 'A20_human_start_leaves_entry', file: AD, find: "if (isHumanOrigin(a.origin) && queue.delete(a.wsId))", to: "if (false && queue.delete(a.wsId))", expect: ['human_start_drops_the_held_entry', 'rig:human_passes'], arms: ['human_passes'] },
  { id: 'A21_retry_handle_never_spent', file: AD, find: '        retry = null; // the handle is spent: a pass that throws below must be able to re-arm\n', to: '', expect: ['retry_rearms_after_a_throwing_pass'], arms: [] },
  { id: 'A22_throwing_owed_means_not_owed', file: AD, find: "treated as still owed`, e);\n      return true;", to: "treated as still owed`, e);\n      return false;", expect: ['throwing_still_owed_is_treated_as_owed'], arms: [] },
  { id: 'C01_spawn_gate_off', file: WS, find: '  if (!admitted) {\n    const gate = admissionGate({', to: '  if (false) {\n    const gate = admissionGate({', expect: ['spawn gate', 'rig:spawn_held'], arms: ['spawn_held'] },
  { id: 'C02_spawn_gate_human_origin', file: WS, find: "      origin: origin ?? 'auto',\n      kind: 'spawn',", to: "      origin: 'human',\n      kind: 'spawn',", expect: ['spawn gate', 'rig:spawn_held'], arms: ['spawn_held'] },
  { id: 'C03_release_re_held', file: WS, find: "run: () => startWorkspaceAgentHeadless(id, 'auto', true),", to: "run: () => startWorkspaceAgentHeadless(id, 'auto'),", expect: ['spawn gate', 'rig:release_order'], arms: ['release_order', 'dip_stops'] },
  { id: 'C04_restart_coordinator_flag', file: RS, find: '      coordinator: canOrchestrate(ws),\n      run: () => dispatchRestartRequest(', to: '      coordinator: false,\n      run: () => dispatchRestartRequest(', expect: ['rig:release_order'], arms: ['release_order'] },
  { id: 'C05_restart_gate_off', file: RS, find: '  if (!input.admitted && id && ws) {', to: '  if (false) {', expect: ['restart gate', 'rig:restart_waits'], arms: ['restart_waits'] },
  { id: 'C06_owed_route_re_held', file: RS, find: 'const started = await startWorkspaceAgentHeadless(id, origin, admitted);', to: 'const started = await startWorkspaceAgentHeadless(id, origin);', expect: ['restart gate', 'rig:release_order'], arms: ['release_order'] },
  { id: 'C07_toolbar_not_human', file: RS, find: "const restartOrigin: PauseOrigin = trigger === 'toolbar' ? 'human' : 'auto';", to: "const restartOrigin: PauseOrigin = 'auto';", expect: ['restart gate', 'rig:human_passes'], arms: ['human_passes'] },
  { id: 'C08_busstatus_no_held_starts', file: HK, find: '              heldStarts: listHeldStarts().map((h) => {', to: '              heldStarts: [].map((h: { wsId: string; kind: string; since: number; coordinator: boolean; seq: number }) => {', expect: ['/busStatus lists', 'rig:visible'], arms: ['visible'] },
  { id: 'C09_peers_without_held', file: WS, find: '    ...(heldStartFor(w.id) ? { heldForMemory:', to: '    ...(false ? { heldForMemory:', expect: ['spawn reply carries held', 'rig:visible'], arms: ['visible'] },
  { id: 'C10_cli_no_held_line', file: CL, find: '        if (held) process.stdout.write(`${held}\\n`);', to: '        void held;', expect: ['/busStatus lists', 'rig:visible'], arms: ['visible'], cli: true },
  { id: 'C11_cli_peers_unmarked', file: CL, find: "status: p.heldForMemory ? `${p.status} · ${p.heldForMemory.kind} HELD for memory since", to: "status: false ? `${p.status} · ${p.heldForMemory.kind} HELD for memory since", expect: ['/busStatus lists', 'rig:visible'], arms: ['visible'], cli: true },
  { id: 'C13_reparent_counts_held_as_restarted', file: WS, find: '      if (res.ok && res.held) {', to: '      if (false) {', expect: ['reparent reconcile'], arms: [] },
  { id: 'C14_spawn_pause_refusal_loses_slot', file: WS, find: "retryLater: () => pauseRefusal(store.getWorkspace(id), 'auto') !== null,", to: 'retryLater: () => false,', expect: ['a release refused by a fleet Pause keeps its slot'], arms: [] },
  { id: 'C15_restart_pause_refusal_loses_slot', file: RS, find: 'retryLater: () => pauseRefusal(store.getWorkspace(id) ?? null, restartOrigin) !== null,', to: 'retryLater: () => false,', expect: ['a release refused by a fleet Pause keeps its slot', 'rig:pause_keeps_slot'], arms: ['pause_keeps_slot'] },
  { id: 'C12_admission_never_started', file: IX, find: '  startAdmission();\n', to: '', expect: ['lifecycle'], arms: [] },
];

const TESTS = ['src/shared/admission.test.ts', 'src/main/admission.test.ts', 'src/main/admission-wiring.test.ts', 'src/main/memory-guard-wiring.test.ts'];
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(path.join(REPO, f))).digest('hex');
const sh = (cmd, a, opts = {}) => spawnSync(cmd, a, { cwd: REPO, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 300_000, ...opts });

function unitRed() {
  const r = sh(process.execPath, ['--test', '--experimental-strip-types', ...TESTS]);
  const names = [...(r.stdout ?? '').matchAll(/^not ok \d+ - (.*)$/gm)].map((m) => m[1]);
  const pass = Number(/^# pass (\d+)/m.exec(r.stdout ?? '')?.[1] ?? NaN);
  const skipped = Number(/^# skipped (\d+)/m.exec(r.stdout ?? '')?.[1] ?? NaN);
  return { names, pass, skipped, status: r.status };
}
function rigRed(arms) {
  if (noRig) return { arms: [], pass: 0, line: '(rig skipped)' };
  const env = { ...process.env, ...(arms && arms.length ? { RIG_ARMS: arms.join(',') } : {}) };
  const r = sh(process.execPath, ['--experimental-strip-types', '--import', pathToFileURL(path.join(HERE, '.r2-register.mjs')).href, path.join(HERE, 'e2e-admission-hold.mjs')], { env });
  const out = r.stdout ?? '';
  return { arms: [...out.matchAll(/^FAIL (\w+)/gm)].map((m) => m[1]), pass: (out.match(/^PASS \w+/gm) ?? []).length, line: (out.split('\n').filter((l) => l.startsWith('ADMISSION RIG')).pop() ?? `no summary (exit ${r.status})`) };
}
const buildCli = () => { const r = sh('pnpm', ['run', 'build:cli']); if (r.status !== 0) throw new Error(`build:cli failed: ${r.stderr}`); };

if (args.includes('--check-anchors')) { // dry check: does every mutant's find resolve exactly once on the CURRENT sources? (no mutation, no run)
  let bad = 0;
  for (const m of MUTANTS) {
    let text = fs.readFileSync(path.join(REPO, m.file), 'utf8'); let why = null;
    for (const e of m.edits ?? [...(m.pre ?? []), { find: m.find, to: m.to }]) { const c = text.split(e.find).length - 1; if (c !== 1) { why = `${c}× ${e.find.slice(0, 70)}`; break; } text = text.replace(e.find, () => e.to); }
    if (why) { bad++; console.log(`ANCHOR-BAD ${m.id}: ${why}`); }
  }
  console.log(`ANCHORS: ${MUTANTS.length - bad}/${MUTANTS.length} resolve exactly once`);
  process.exit(bad ? 1 : 0);
}

// ── guard: the tree must be committed (git diff is the independent restoration proof) ──
const files = [...new Set(MUTANTS.map((m) => m.file))];
const dirty = sh('git', ['diff', '--quiet', '--', ...files, ...TESTS, 'scripts/e2e-admission-hold.mjs', 'scripts/admission-mutants.mjs']).status !== 0;
if (dirty) { console.error('REFUSING: the mutated files / suites / rig have uncommitted changes — commit first (the end-of-sweep `git diff` must prove restoration)'); process.exit(2); }
const before = Object.fromEntries(files.map((f) => [f, sha(f)]));
buildCli();

// ── POSITIVE CONTROL: the unmutated tree must be all green, else every "killed" below is vacuous ──
const base = unitRed();
const baseRig = rigRed();
console.log(`BASELINE unit: pass ${base.pass} fail ${base.names.length} skipped ${base.skipped} | rig: ${baseRig.line}`);
if (base.names.length || base.status !== 0 || base.skipped !== 0 || baseRig.arms.length || (!noRig && baseRig.pass !== 10)) { console.error('BASELINE NOT GREEN — aborting (nothing was mutated)'); process.exit(3); }

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
  const edits = m.edits ?? [...(m.pre ?? []), { find: m.find, to: m.to }];
  let mutated = original; let anchorBad = null;
  for (const e of edits) { const c = mutated.split(e.find).length - 1; if (c !== 1) { anchorBad = `find occurs ${c}× (need exactly 1): ${e.find.slice(0, 60)}`; break; } mutated = mutated.replace(e.find, () => e.to); }
  if (anchorBad) { rows.push({ id: m.id, verdict: 'ANCHOR-BAD', detail: anchorBad }); continue; }
  const backupFile = path.join(BACKUP, `${m.id}.orig`);
  fs.writeFileSync(backupFile, original);
  const onSig = () => { restore(m, backupFile); process.exit(130); };
  process.once('SIGINT', onSig); process.once('SIGTERM', onSig);
  try {
    fs.writeFileSync(abs, mutated);
    if (fs.readFileSync(abs, 'utf8') === original) { rows.push({ id: m.id, verdict: 'NO-OP', detail: 'the mutation changed nothing' }); continue; }
    if (m.cli) buildCli();
    const u = unitRed();
    const r = m.arms && m.arms.length === 0 ? { arms: [] } : rigRed(m.arms);
    const red = [...u.names, ...r.arms.map((a) => `rig:${a}`)];
    const hit = m.expect.filter((e) => red.some((n) => n.includes(e)));
    rows.push({ id: m.id, verdict: hit.length > 0 ? 'KILLED' : red.length ? 'KILLED-BUT-NOT-BY-NAMED-ARM' : 'SURVIVED', detail: `named ${JSON.stringify(m.expect)} hit ${JSON.stringify(hit)}; red: ${red.slice(0, 4).join(' | ')}${red.length > 4 ? ` (+${red.length - 4})` : ''}` });
  } finally {
    restore(m, backupFile);
    process.removeListener('SIGINT', onSig); process.removeListener('SIGTERM', onSig);
    if (m.cli) buildCli();
  }
}
const after = Object.fromEntries(files.map((f) => [f, sha(f)]));
const sameSha = files.every((f) => before[f] === after[f]);
const gitClean = sh('git', ['diff', '--quiet', '--', ...files]).status === 0;
const post = unitRed();
const postRig = rigRed();
for (const r of rows) console.log(`${r.verdict.padEnd(30)} ${r.id.padEnd(30)} ${r.detail}`);
const killed = rows.filter((r) => r.verdict === 'KILLED').length;
console.log(`RESTORED: sha-identical ${sameSha} · git diff clean ${gitClean} · cmp-restore ${!restoreBad} · post-sweep unit fail ${post.names.length} rig ${postRig.line}`);
console.log(`MUTANTS: ${killed}/${rows.length} killed by their NAMED arm${rows.length === killed ? '' : ` — NOT ALL: ${rows.filter((r) => r.verdict !== 'KILLED').map((r) => `${r.id}=${r.verdict}`).join(', ')}`}`);
process.exit(rows.length === killed && sameSha && gitClean && !restoreBad && post.names.length === 0 && postRig.arms.length === 0 ? 0 : 1);
