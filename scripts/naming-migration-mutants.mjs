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
  M('M03_archived_renamed', PL, "    if (ws.archived) {\n      rows.push({ ...base, action: 'untouched-archived'", "    if (false) {\n      rows.push({ ...base, action: 'untouched-archived'"),
  M('M04_done_not_detected', PL, 'if (ws.branch === to && ws.namedByParent) {', 'if (false) {'),
  M('M05_no_parent_applied', PL, 'if (!asParent) {', 'if (false) {'),
    M('M07_namer_before_spawner', PL, 'const ids = [w.parentId, w.namedByParent].filter(', 'const ids = [w.namedByParent, w.parentId].filter('),
  M('M08_human_created_misclassified', PL, 'else if (!ws.parentId && !ws.namedByParent) rows.push', 'else if (false) rows.push'),
  M('M09_rejected_row_not_marked', PL, 'if (rejectedIds.has(ws.id)) rows.push', 'if (false) rows.push'),
  M('M10_renames_include_done', PL, ".filter((r) => r.action === 'rename')", ".filter((r) => r.action === 'rename' || r.action === 'done')"),
  M('M11_remote_checked_after_vague', PL, "    if (input.remoteBranches.has(ws.branch)) {\n      rows.push({ ...base, action: 'skip-remote'", "    if (!input.activeVagueMembers.has(ws.id) && input.remoteBranches.has(ws.branch)) {\n      rows.push({ ...base, action: 'skip-remote'"),
  // ── planner: the table rows ──
  M('M12_unknown_id_accepted', PL, "if (!ws) return reject('unknown-workspace'", "if (!ws) return void 0; if (false) return reject('unknown-workspace'"),
  M('M13_duplicate_row_accepted', PL, "if ((idCount.get(r.id) ?? 0) > 1) return reject(", "if (false) return reject("),
  M('M14_human_pin_overridden', PL, "if (!decision.allow) return reject('refused-by-policy', decision.error);", "if (false) return reject('refused-by-policy', '');"),
  M('M45_policy_asked_as_the_human', PL, "{ kind: 'agent', id: caller })", "{ kind: 'human' })"),
  M('M46_policy_asked_as_a_stranger', PL, "{ kind: 'agent', id: caller })", "{ kind: 'agent', id: 'someone-else' })"),
  M('M15_invalid_name_accepted', PL, "if (!check.ok) return reject('invalid-name', check.error);\n    const to = check.name;", "const to = check.ok ? check.name : r.new;"),
  M('M16_raw_name_used', PL, 'const to = check.name;', 'const to = r.new;'),
  M('M17_stale_old_ignored', PL, 'if (drifted && ws.namedByParent && ws.formerBranch !== r.old) {', 'if (false) {'),
  M('M18_applied_row_stale', PL, 'r.old !== ws.branch && ws.branch !== to;', 'r.old !== ws.branch;'),
  M('M19_duplicate_target_accepted', PL, "if ((targetCount.get(to) ?? 0) > 1) return reject(", "if (false) return reject("),
  M('M20_name_taken_ignored', PL, 'const clashing = ws.branch === to ? undefined : clash(to, ws.branch);', 'const clashing: string | undefined = undefined;'),
  M('M21_taken_ignores_remote', PL, 'new Set<string>([...input.remoteBranches, ...input.localBranches])', 'new Set<string>([...input.localBranches])'),
  M('M22_taken_ignores_local', PL, 'new Set<string>([...input.remoteBranches, ...input.localBranches])', 'new Set<string>([...input.remoteBranches])'),
  M('M23_taken_holds_archived_names', PL, 'for (const w of input.workspaces) if (!w.archived) taken.add(w.branch);', 'for (const w of input.workspaces) taken.add(w.branch);'),
  M('M24_taken_ignores_workspaces', PL, 'for (const w of input.workspaces) if (!w.archived) taken.add(w.branch);', ''),
  // ── planner: which vagues are running ──
  M('M25_mission_counts_as_vague', PL, "    if (!a.parentId) continue; // a top-level orchestrator runs a mission, not a vague (an OPS whose parent left the store stays a vague: held is the safe side)\n", ''),
  M('M26_empty_vague_still_active', PL, '|| !hasLiveBelow.has(a.id) ||', '||'),
  M('M27_archived_ops_still_active', PL, 'if (!canOrchestrate(a) || !live(a) ||', 'if (!canOrchestrate(a) ||'),
  M('M28_sandbox_counts_live', PL, "w.host?.kind !== 'sandbox'", 'true'),
  M('M29_non_orchestrator_anchors', PL, 'if (!canOrchestrate(a) ||', 'if ('),
  M('M30_vague_members_only_anchor', PL, '    for (const w of workspaces) if (ancestors(w.id).has(a.id)) members.add(w.id);\n', ''),
  // ── planner: reviewed additions ──
  M('M31_closed_declaration_ignored', PL, '|| closed.has(a.id)) continue;', ') continue;'),
  M('M32_dangling_parent_untouched', PL, 'return ids.find((p) => byId.has(p)) ?? ids[0];', 'return ids.find((p) => byId.has(p));'),
  M('M33_pin_only_lost', PL, 'if (ws.branch === to && ws.namedByParent) {', 'if (ws.branch === to) {'),
  M('M34_archived_row_not_exempt', PL, "    if (ws.archived) {\n      valid.set(r.id, { index, to });\n      return;\n    }\n", ''),
  M('M35_archived_rows_steal_names', PL, 'if (c.ok && w && !w.archived) targetCount', 'if (c.ok) targetCount'),
  M('M36_prefix_clash_down_ignored', PL, '|| t.startsWith(`${to}/`)', ''),
  M('M39_own_branch_clashes', PL, 'if (t !== own && (t === to', 'if ((t === to'),
  M('M40_gone_always', PL, 'const gone = (x: RejectedRow): boolean => !!opts.allowGone && x.code', 'const gone = (x: RejectedRow): boolean => x.code'),
  M('M41_verbose_ignored', PL, 'new Set<RowAction>(opts.verbose ? [] : [', 'new Set<RowAction>(false ? [] : ['),
  M('M42_gone_counts_as_rejected', PL, 'plan.rejected.filter((x) => !gone(x)).length} rejected', 'plan.rejected.length} rejected'),
  M('M43_drifted_legacy_child_refused', PL, 'if (drifted && ws.namedByParent && ws.formerBranch !== r.old) {', 'if (drifted && ws.formerBranch !== r.old) {'),
  M('M47_own_rename_counts_as_stale', PL, ' && ws.formerBranch !== r.old) {', ') {'),
  M('M48_settled_not_exempt_from_policy', PL, 'if (!settled) {', 'if (true) {'),
  M('M49_no_hypothetical_parent', PL, 'decideRename(asParentId ? ws : { ...ws, parentId: caller }', 'decideRename(ws'),
  M('M50_expect_parent_not_existing_namer', PL, 'expectNamer: ws.namedByParent || asParent,', 'expectNamer: asParent,'),
  M('M51_orphaned_ops_is_a_mission', PL, 'if (!a.parentId) continue;', 'if (!a.parentId || !byId.has(a.parentId)) continue;'),
  M('M44_drift_not_shown', PL, 'row.drift !== undefined ?', 'false ?'),
  // ── planner: the six rulings of the #385 review ──
  M('M52_namer_is_not_a_vague_edge', PL, '[w?.parentId, w?.namedByParent].filter(', '[w?.parentId].filter('),
  M('M53_closed_hint_dropped', PL, 're-run with `--closed <its OPS id>`, declared BEFORE archiving', 're-run at its close, declared before'),
  M('M54_live_head_ignored', PL, 'if (head !== ws.branch) {', 'if (false) {'),
  M('M55_live_heads_not_consulted', PL, 'if (input.liveHeads?.has(ws.id)) {', 'if (false) {'),
  M('M56_unreadable_head_trusted', PL, 'if (head !== ws.branch) {', 'if (head !== null && head !== ws.branch) {'),
  M('M57_dependents_ignored', PL, 'if (dependent) {', 'if (false) {'),
  M('M58_archived_dependent_holds', PL, '!o.archived && !!o.baseBranch', '!!o.baseBranch'),
  M('M59_dependent_in_another_repo_holds', PL, ' && o.repoPath === ws.repoPath);', ');'),
  M('M60_former_lost_never_marked', PL, 'const formerLost = ws.branch === to && row.old !== undefined && row.old !== to && !ws.formerBranch ? row.old : undefined;', 'const formerLost: string | undefined = undefined;'),
  M('M61_former_lost_when_recorded', PL, 'row.old !== to && !ws.formerBranch ? row.old', 'row.old !== to ? row.old'),
  M('M62_settled_ignores_the_pin', PL, 'const settled = ws.branch === to && !!ws.namedByParent;', 'const settled = ws.branch === to;'),
  // ── script ──
  M('S01_dry_run_applies', SC, 'if (!apply) {', 'if (false) {'),
  M('S02_wrong_identity', SC, 'ORCHESTRA_WS_ID: step.asParent,', 'ORCHESTRA_WS_ID: step.id,'),
  M('S03_fallback_identity_leaks', SC, 'ORCHESTRA_WS_ID_IDENTITY: step.asParent', 'X_UNUSED: step.asParent'),
  M('S04_rejected_rows_apply_anyway', SC, 'if (blocking.length > 0) die(', 'if (false) die('),
  M('S05_table_not_required', SC, "if (!tableFile) die(", "if (false) die("),
  M('S06_socket_guard_off', SC, 'if (process.env.ORCHESTRA_SOCK) {', 'if (false) {'),
  M('S07_failure_exits_zero', SC, 'process.exit(failed ? 1 : 0);', 'process.exit(0);'),
  M('S08_ls_remote_ignored', SC, 'if (m) remoteBranches.add(m[1]);', 'void m;'),
  M('S10_local_branches_ignored', SC, 'if (b) localBranches.add(b);', 'void b;'),
  M('S11_unreadable_store_is_empty', SC, 'die(`cannot read the store ${storeFile}: ${e.message}`);', 'workspaces = [];'),
  M('S12_git_failure_is_empty', SC, "if (r.error || r.status !== 0) die(`git", "if (false) die(`git"),
  M('S13_unreadable_table_is_empty', SC, 'die(`cannot read the table ${tableFile}: ${e.message}`);', 'table = [];'),
  M('S14_enoent_not_aborted', SC, "if (r.error?.code === 'ENOENT') {", 'if (false) {'),
  M('S15_apply_ignores_cli_failure', SC, 'if (r.error || r.status !== 0 || !final) {', 'if (false) {'),
  M('S17_only_origin_read', SC, "for (const remote of git(repo, 'remote').split('\\n').filter(Boolean)) {", "for (const remote of git(repo, 'remote').split('\\n').filter((r) => r === 'origin')) {"),
  M('S18_closed_ids_ignored', SC, 'new Set(closedIds)', 'new Set()'),
  M('S19_closed_typo_accepted', SC, 'if (!byId.has(id)) die(`--closed', 'if (false) die(`--closed'),
  M('S20_allow_gone_excuses_everything', SC, "const blocking = plan.rejected.filter((x) => !(allowGone && x.code === 'unknown-workspace'));", 'const blocking = allowGone ? [] : plan.rejected;'),
  M('S21_read_back_off', SC, '  if (!seen.ok) {\n    failed++;\n    out(`FAILED   ${id8}', '  if (false) {\n    failed++;\n    out(`FAILED   ${id8}'),
  M('S22_namer_unchecked', SC, 'w.namedByParent === step.expectNamer && ', ''),
  M('S23_former_unchecked', SC, ' && (step.to === step.from || (!!w.formerBranch && w.formerBranch !== step.to))', ''),
  M('S32_git_head_unchecked', SC, ' && (head === undefined || head === step.to)', ''),
  M('S33_git_head_never_read', SC, "|| !fs.existsSync(path.join(w.worktreePath, '.git'))) return undefined;", '|| true) return undefined;'),
  M('S34_former_any_accepted', SC, '(!!w.formerBranch && w.formerBranch !== step.to)', 'true'),
  M('S27_target_name_unchecked', SC, 'w.branch === step.to && ', ''),
  M('S28_settle_pass_off', SC, 'if (applied.length > 0) {', 'if (false) {'),
  M('S29_settle_never_fails', SC, '    const seen = readBack(step);\n    if (!seen.ok) {\n      lost++;', '    const seen = readBack(step);\n    if (false) {\n      lost++;'),
  M('S30_lost_not_counted', SC, '      lost++;\n      failed++;', '      lost++;'),
  M('S35_canary_does_not_stop', SC, '    aborted = true;\n    break;\n  }\n  if (step.formerLost) {', '    aborted = true;\n  }\n  if (step.formerLost) {'),
  M('S36_former_lost_ignored', SC, 'if (step.formerLost) {', 'if (false) {'),
  M('S37_former_lost_is_green', SC, '    failed++;\n    formerLost++;', '    formerLost++;'),
  M('S38_preflight_off', SC, 'if (!appVerdict.ok && !assumeAppCurrent) die(', 'if (false) die('),
  M('S39_older_app_accepted', SC, 'else if (olderThan(running.version, checkoutVersion))', 'else if (false)'),
  M('S40_dead_app_pid_accepted', SC, 'else if (!aliveProcess(running.pid))', 'else if (false)'),
  M('S41_unknown_app_accepted', SC, "if (!running) appVerdict = { ok: false,", "if (!running) appVerdict = { ok: true,"),
  M('S42_override_ignored', SC, 'if (!appVerdict.ok && !assumeAppCurrent) die(', 'if (!appVerdict.ok) die('),
  M('S43_archived_rows_not_warned', SC, 'const warnings = allowGone ? 0 : archivedRows.length;', 'const warnings = 0;'),
  M('S44_allow_gone_does_not_excuse_archived', SC, 'const warnings = allowGone ? 0 : archivedRows.length;', 'const warnings = archivedRows.length;'),
  M('S45_live_heads_not_passed', SC, 'table, liveHeads });', 'table });'),
  M('S46_unreadable_head_ignored', SC, 'return r.status === 0 ? r.stdout.trim() : null;', 'return r.status === 0 ? r.stdout.trim() : undefined;'),
  M('S47_warnings_do_not_fail_the_apply', SC, 'process.exit(failed || warnings ? 1 : 0);', 'process.exit(failed ? 1 : 0);'),
  M('S25_verbose_not_passed', SC, 'renderPlan(plan, { verbose, allowGone })', 'renderPlan(plan, { allowGone })'),
  M('S26_allow_gone_not_passed', SC, 'renderPlan(plan, { verbose, allowGone })', 'renderPlan(plan, { verbose })'),
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
