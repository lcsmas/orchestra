// #385 self-gate — IN-PLACE mutation sweep of the migration planner + script. Each mutant edits ONE clause of the real source, runs the two suites
// (src/shared/naming-migration.test.ts, naming-migration-script.test.ts) and must turn at least one test RED (fail > 0 — a crash is not a kill).
// Byte-exact backup + `cmp` after every mutant; the baseline must be green with 0 skipped first, and every `find` must occur exactly once.
// Run: node scripts/naming-migration-mutants.mjs [--only M01,M02]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PL = 'src/shared/naming-migration.ts';
const SC = 'scripts/migrate-parent-names.mjs';
const SUITES = ['src/shared/naming-migration.test.ts', 'src/shared/naming-migration-script.test.ts'];
const only = process.argv.includes('--only') ? new Set(process.argv[process.argv.indexOf('--only') + 1].split(',')) : null;
const BACKUP = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'nm385-mut-'));

const M = (id, file, find, to) => ({ id, file, find, to });
const MUTANTS = [
  // ── planner: the outcome of a workspace ──
  M('M01_remote_skip_off', PL, 'if (input.remoteBranches.has(ws.branch)) {', 'if (false) {'),
  M('M02_vague_skip_off', PL, 'if (input.activeVagueMembers.has(ws.id)) {', 'if (false) {'),
  M('M03_archived_renamed', PL, 'if (ws.archived) {', 'if (false) {'),
  M('M04_done_not_detected', PL, 'if (ws.branch === to) {', 'if (false) {'),
  M('M05_no_parent_applied', PL, 'if (!asParent) {', 'if (false) {'),
  M('M06_dangling_parent_accepted', PL, '(p): p is string => !!p && byId.has(p)', '(p): p is string => !!p'),
  M('M07_namer_before_spawner', PL, '[ws.parentId, ws.namedByParent].find', '[ws.namedByParent, ws.parentId].find'),
  M('M08_human_created_misclassified', PL, 'else if (!ws.parentId && !ws.namedByParent) rows.push', 'else if (false) rows.push'),
  M('M09_rejected_row_not_marked', PL, 'if (rejectedIds.has(ws.id)) rows.push', 'if (false) rows.push'),
  M('M10_renames_include_done', PL, ".filter((r) => r.action === 'rename')", ".filter((r) => r.action === 'rename' || r.action === 'done')"),
  M('M11_remote_checked_after_vague', PL, "    if (input.remoteBranches.has(ws.branch)) {\n      rows.push({ ...base, action: 'skip-remote'", "    if (!input.activeVagueMembers.has(ws.id) && input.remoteBranches.has(ws.branch)) {\n      rows.push({ ...base, action: 'skip-remote'"),
  // ── planner: the table rows ──
  M('M12_unknown_id_accepted', PL, "if (!ws) return reject('unknown-workspace'", "if (!ws) return void 0; if (false) return reject('unknown-workspace'"),
  M('M13_duplicate_row_accepted', PL, "if ((idCount.get(r.id) ?? 0) > 1) return reject(", "if (false) return reject("),
  M('M14_human_pin_overridden', PL, 'if (ws.branchManuallySet === true) return reject(', 'if (false) return reject('),
  M('M15_invalid_name_accepted', PL, "if (!check.ok) return reject('invalid-name', check.error);\n    const to = check.name;", "const to = check.ok ? check.name : r.new;"),
  M('M16_raw_name_used', PL, 'const to = check.name;', 'const to = r.new;'),
  M('M17_stale_old_ignored', PL, 'if (r.old !== undefined && r.old !== ws.branch && ws.branch !== to) {', 'if (false) {'),
  M('M18_applied_row_stale', PL, 'r.old !== ws.branch && ws.branch !== to)', 'r.old !== ws.branch)'),
  M('M19_duplicate_target_accepted', PL, "if ((targetCount.get(to) ?? 0) > 1) return reject(", "if (false) return reject("),
  M('M20_name_taken_ignored', PL, 'if (ws.branch !== to && taken.has(to)) return reject(', 'if (false) return reject('),
  M('M21_taken_ignores_remote', PL, 'new Set<string>([...input.remoteBranches, ...input.localBranches])', 'new Set<string>([...input.localBranches])'),
  M('M22_taken_ignores_local', PL, 'new Set<string>([...input.remoteBranches, ...input.localBranches])', 'new Set<string>([...input.remoteBranches])'),
  M('M23_taken_holds_archived_names', PL, 'for (const w of input.workspaces) if (!w.archived) taken.add(w.branch);', 'for (const w of input.workspaces) taken.add(w.branch);'),
  M('M24_taken_ignores_workspaces', PL, 'for (const w of input.workspaces) if (!w.archived) taken.add(w.branch);', ''),
  // ── planner: which vagues are running ──
  M('M25_mission_counts_as_vague', PL, 'if (!a.parentId || !byId.has(a.parentId)) continue;', ''),
  M('M26_empty_vague_still_active', PL, '|| !hasLiveBelow.has(a.id)) continue;', ') continue;'),
  M('M27_archived_ops_still_active', PL, 'if (!canOrchestrate(a) || !live(a) ||', 'if (!canOrchestrate(a) ||'),
  M('M28_sandbox_counts_live', PL, "w.host?.kind !== 'sandbox'", 'true'),
  M('M29_non_orchestrator_anchors', PL, 'if (!canOrchestrate(a) ||', 'if ('),
  M('M30_vague_members_only_anchor', PL, '    for (const w of workspaces) if (ancestors(w.id).includes(a.id)) members.add(w.id);\n', ''),
  // ── script ──
  M('S01_dry_run_applies', SC, 'if (!apply) {', 'if (false) {'),
  M('S02_wrong_identity', SC, 'ORCHESTRA_WS_ID: step.asParent,', 'ORCHESTRA_WS_ID: step.id,'),
  M('S03_fallback_identity_leaks', SC, 'ORCHESTRA_WS_ID_IDENTITY: step.asParent', 'X_UNUSED: step.asParent'),
  M('S04_rejected_rows_apply_anyway', SC, 'if (plan.rejected.length > 0) die(', 'if (false) die('),
  M('S05_table_not_required', SC, "if (!tableFile) die(", "if (false) die("),
  M('S06_socket_guard_off', SC, 'if (process.env.ORCHESTRA_SOCK) {', 'if (false) {'),
  M('S07_failure_exits_zero', SC, 'process.exit(failed ? 1 : 0);', 'process.exit(0);'),
  M('S08_ls_remote_ignored', SC, 'if (m) remoteBranches.add(m[1]);', 'void m;'),
  M('S09_origin_never_read', SC, ".includes('origin')) continue;", ".includes('origin') || true) continue;"),
  M('S10_local_branches_ignored', SC, 'if (b) localBranches.add(b);', 'void b;'),
  M('S11_unreadable_store_is_empty', SC, 'die(`cannot read the store ${storeFile}: ${e.message}`);', 'workspaces = [];'),
  M('S12_git_failure_is_empty', SC, "if (r.error || r.status !== 0) die(`git", "if (false) die(`git"),
  M('S13_unreadable_table_is_empty', SC, 'die(`cannot read the table ${tableFile}: ${e.message}`);', 'table = [];'),
  M('S14_enoent_not_aborted', SC, "if (r.error?.code === 'ENOENT') {", 'if (false) {'),
  M('S15_apply_ignores_cli_failure', SC, 'if (r.error || r.status !== 0 || !final) {', 'if (false) {'),
  M('S16_final_name_unchecked', SC, "${final === step.to ? '' : `  [the app changed the requested name ${step.to}]`}", ''),
];

// A killed sweep must not leave a mutant behind: restore the file in flight on any signal.
let inFlight = null;
const restoreInFlight = () => { if (inFlight) fs.writeFileSync(inFlight.file, fs.readFileSync(inFlight.bak)); inFlight = null; };
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => { restoreInFlight(); process.exit(130); });
process.on('exit', restoreInFlight);

const run = (suites = SUITES) => {
  const env = { ...process.env };
  delete env.ORCHESTRA_SOCK;
  const r = spawnSync(process.execPath, ['--test', '--experimental-strip-types', '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', ...suites], { cwd: REPO, encoding: 'utf8', env, timeout: 600_000 });
  const n = (k) => Number(new RegExp(`^# ${k} (\\d+)`, 'm').exec(r.stdout)?.[1] ?? NaN);
  return { rc: r.status, pass: n('pass'), fail: n('fail'), skipped: n('skipped'), red: [...r.stdout.matchAll(/^not ok \d+ - (.+)$/gm)].map((m) => m[1]) };
};

const base = run();
console.log(`baseline: pass ${base.pass} fail ${base.fail} skipped ${base.skipped} rc ${base.rc}`);
if (base.rc !== 0 || base.fail !== 0 || base.skipped !== 0 || !(base.pass > 0)) {
  console.error('BASELINE NOT GREEN — no mutant can be judged');
  process.exit(2);
}
let survivors = 0;
let dirty = 0;
let ran = 0;
for (const m of MUTANTS) {
  if (only && !only.has(m.id.split('_')[0])) continue;
  ran++;
  const file = path.join(REPO, m.file);
  const original = fs.readFileSync(file);
  const text = original.toString('utf8');
  const count = text.split(m.find).length - 1;
  if (count !== 1) {
    console.log(`${m.id}  ANCHOR ERROR: find occurs ${count}x`);
    survivors++;
    continue;
  }
  const bak = path.join(BACKUP, m.id);
  fs.writeFileSync(bak, original);
  inFlight = { file, bak };
  fs.writeFileSync(file, text.replace(m.find, () => m.to));
  let res;
  try {
    // the cheap suite first (a planner mutant is normally killed by the planner suite alone); the other one only for survivors
    const first = m.file === SC ? [SUITES[1]] : [SUITES[0]];
    res = run(first);
    if (!(res.fail > 0)) res = run();
  } finally {
    restoreInFlight(); // byte-exact restore
  }
  const same = spawnSync('cmp', [bak, file]).status === 0;
  if (!same) dirty++;
  const killed = res.fail > 0;
  if (!killed) survivors++;
  console.log(`${m.id}  ${killed ? `KILLED by ${res.fail} (${res.red.slice(0, 2).map((x) => x.slice(0, 48)).join(' | ')})` : `SURVIVED (rc ${res.rc}, pass ${res.pass})`}${same ? '' : '  RESTORE MISMATCH'}`);
}
console.log(`\n${survivors === 0 && dirty === 0 ? 'CLEAN' : 'DIRTY'}: ${ran} of ${MUTANTS.length} mutants run, ${survivors} survivor(s)/anchor error(s), ${dirty} restore mismatch(es)`);
process.exit(survivors === 0 && dirty === 0 ? 0 : 1);
