// #383 self-gate — IN-PLACE mutation sweep of rename authority (human > parent > child). Each mutant edits ONE clause of the real
// source, runs the four #383 test files, and must turn red at least one NAMED test title (`expect` = substring of a failing title).
// Restored by byte-exact backup + sha compare after every mutant; the CLI bundle is REBUILT for a CLI mutant (the instrument is never a
// stale binary) and rebuilt clean at the end. A baseline run on the clean tree must be all-green first (a red base voids the sweep).
// Run: node scripts/rename-authority-mutants.mjs [--only M01,M02] [--check]   (--check = dry anchor check: every `find` occurs the expected number of times)
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const only = args.includes('--only') ? new Set((args[args.indexOf('--only') + 1] ?? '').split(',')) : null;
const dry = args.includes('--check');

const POLICY = 'src/shared/naming-policy.ts';
const WS = 'src/main/workspaces.ts';
const HS = 'src/main/hooks-server.ts';
const SB = 'src/main/transport/sandbox-manager.ts';
const API = 'src/main/api-handlers.ts';
const ACT = 'src/main/activity.ts';
const WT = 'src/main/naming-policy-wiring.test.ts';
const SDK = 'src/main/agent-sdk.ts';
const SHARED_PLANT = 'src/shared/workspace-name.ts';
const REND = 'src/renderer/components/Sidebar.tsx';
const CLI = 'src/cli/index.ts';
const TESTS = [
  'src/shared/rename-authority.test.ts',
  'src/shared/naming-policy.test.ts',
  'src/main/rename-authority-wiring.test.ts',
  'src/main/naming-policy-wiring.test.ts',
  'src/cli/rename-from.test.ts',
];

const HUMAN_ARM = "if (caller.kind === 'human') return { allow: true, pin: { manual: true, bumpAutoCount: false } };";
const H_BLOCK = "    if (namer || isParent) return { allow: false, error: NAMED_BY_HUMAN_REFUSAL };\n    return { allow: true, pin: { manual: false, bumpAutoCount: nudgeActive(target) } };";
const P_PARENT = "if (isParent) return { allow: true, pin: { manual: false, bumpAutoCount: false, namedByParent: namer } };";
const P_REFUSE = "return { allow: false, error: namedByParentRefusal(ctx.parentName) };";
const U_PARENT = "if (isParent) return { allow: true, pin: { manual: false, bumpAutoCount: false, namedByParent: caller.id } };";
const U_TAIL = U_PARENT + "\n  return { allow: true, pin: { manual: false, bumpAutoCount: nudgeActive(target) } };";

// [id, file, find, to, expectSubstring, {count?: expected occurrences, cli?: true}]
const MUTANTS = [
  ['M01_human_not_pinned', POLICY, HUMAN_ARM, HUMAN_ARM.replace('manual: true', 'manual: false'), 'human always allowed, pins manual'],
  ['M02_human_refused_when_pinned', POLICY, "if (caller.kind === 'human') return", "if (caller.kind === 'human' && !target.branchManuallySet) return", 'human may rename a human-pinned workspace'],
  ['M03_human_pin_rewrites_namer', POLICY, HUMAN_ARM, HUMAN_ARM.replace('bumpAutoCount: false }', 'bumpAutoCount: false, namedByParent: undefined }'), 'the human pin never carries namedByParent'],
  ['M04_unknown_caller_is_a_parent', POLICY, 'const isParent = !!caller.id && (', 'const isParent = (', 'an absent caller id is never a parent'],
  ['M05_parentId_not_authority', POLICY, 'caller.id === target.parentId || caller.id === namer', 'caller.id === namer', 'parent by parentId'],
  ['M06_namer_not_authority', POLICY, 'caller.id === target.parentId || caller.id === namer', 'caller.id === target.parentId', 'P-detached + the NAMER'],
  ['M07_H_with_namer_allowed', POLICY, H_BLOCK, H_BLOCK.replace('if (namer || isParent) return { allow: false, error: NAMED_BY_HUMAN_REFUSAL };\n', ''), 'H + self: REFUSED'],
  ['M08_H_without_namer_refused', POLICY, H_BLOCK, H_BLOCK.replace('if (namer || isParent) return', 'return'), 'H on a human-created workspace + self: allowed as today'],
  ['M09_H_human_created_counted', POLICY, H_BLOCK, H_BLOCK.replace('bumpAutoCount: nudgeActive(target)', 'bumpAutoCount: true'), 'H human-created + an id: as today'],
  ['M10_parent_overrides_human_pin', POLICY, 'if (target.branchManuallySet) {', 'if (target.branchManuallySet && !isParent) {', 'H + parent: REFUSED'],
  ['M11_P_parent_counted', POLICY, P_PARENT, P_PARENT.replace('bumpAutoCount: false', 'bumpAutoCount: true'), 'P + parent: allowed, stays P, no counter bump'],
  ['M12_P_parent_refused', POLICY, '    ' + P_PARENT + '\n', '', 'P + parent: allowed, stays P'],
  ['M13_P_parent_rewrites_namer', POLICY, P_PARENT, P_PARENT.replace('namedByParent: namer', 'namedByParent: caller.id'), 're-attached child'],
  ['M14_P_child_may_self_rename', POLICY, P_REFUSE, 'return { allow: true, pin: { manual: false, bumpAutoCount: nudgeActive(target) } };', 'P + self: REFUSED'],
  ['M15_P_unknown_may_rename', POLICY, '  if (namer) {\n    if (isParent)', '  if (namer && caller.id) {\n    if (isParent)', 'P + unknown (old CLI, no from): REFUSED'],
  ['M16_U_parent_does_not_pin', POLICY, U_PARENT, U_PARENT.replace(', namedByParent: caller.id', ''), 'U + parent: allowed and PINS P'],
  ['M17_U_parent_counted', POLICY, U_PARENT, U_PARENT.replace('bumpAutoCount: false', 'bumpAutoCount: true'), 'not counted as the child'],
  ['M18_U_nonparent_not_counted', POLICY, U_TAIL, U_TAIL.replace('bumpAutoCount: nudgeActive(target)', 'bumpAutoCount: false'), 'U + self: as today'],
  ['M19_U_unknown_refused', POLICY, U_TAIL, U_PARENT + '\n  ' + P_REFUSE, 'U + unknown caller (no from): as today'],
  ['M20_refusal_drops_parent_name', POLICY, '  return parentName\n    ? `named by your parent (${parentName})', '  return false\n    ? `named by your parent (${parentName})', 'P refusal names the parent'],
  ['M21_refusal_drops_instruction', POLICY, '— ask them to run \\`orchestra rename\\`', '', 'ask them to run `orchestra rename`'],
  ['M22_human_refusal_text', POLICY, "'named by the human — the name is pinned, only the human can change it'", "'locked'", 'H refusal says "named by the human"'],
  ['M23_unnamed_nudge_ignored', POLICY, U_TAIL, U_PARENT + "\n  return { allow: true, pin: { manual: false, bumpAutoCount: true } };", 'U with the budget spent'],
  ['M24_D6_parent_may_override_legacy_human_pin', POLICY, 'if (namer || isParent) return { allow: false, error: NAMED_BY_HUMAN_REFUSAL };', 'if (namer) return { allow: false, error: NAMED_BY_HUMAN_REFUSAL };', 'REFUSED (D6'],
  ['M25_H_refuses_only_the_parent', POLICY, 'if (namer || isParent) return { allow: false, error: NAMED_BY_HUMAN_REFUSAL };', 'if (isParent) return { allow: false, error: NAMED_BY_HUMAN_REFUSAL };', 'H + self: REFUSED'],
  ['A01_adopted_rename_of_P_pins_human', POLICY, '  if (target.namedByParent && !target.branchManuallySet) return { manual: false, bumpAutoCount: false };\n', '', 'P (parent-named, not human-pinned): the name is adopted but NOT pinned'],
  ['A02_adopted_rename_of_H_unpinned', POLICY, 'if (target.namedByParent && !target.branchManuallySet) return', 'if (target.namedByParent) return', 'H already human-pinned and parent-named: stays pinned'],
  ['A03_adopted_rename_never_pins', POLICY, 'return { manual: true, bumpAutoCount: false };\n}\n\n/** Does `pin` change anything', 'return { manual: false, bumpAutoCount: false };\n}\n\n/** Does `pin` change anything', 'U human-created: today'],
  ['A04_activity_bypasses_adoption_policy', ACT, 'const pin = adoptedBranchPin(fresh);', 'const pin = { manual: true, bumpAutoCount: false };', 'human pin sites'],
  // ── the broadened no-inline-copy detector (#381 review MINOR + verifier F1, folded into #383) ──
  ['D01_detector_blind_to_bare_reads', WT, "/\\.\\s*(?:branchManuallySet|autoRenameCount)\\b|", '/(?!x)x|', 'DETECTOR CONTROL'],
  ['D02_detector_property_write_only_true_false', WT, "/\\b(?:branchManuallySet|autoRenameCount)\\s*:/]", "/\\bbranchManuallySet\\s*:\\s*(true|false)\\b/]", 'DETECTOR CONTROL'],
  ['D03_detector_blind_to_sanitizer_literal', WT, "/\\[\\^a-zA-Z0-9\\._\\/-\\]/]", "/(?!x)x/]", 'DETECTOR CONTROL'],
  ['D04_detector_blind_to_sanitizer_body', WT, "/\\.trim\\(\\)\\s*\\.replace\\(\\s*\\/\\\\s\\+\\/g\\s*,\\s*['\"]-['\"]\\s*\\)/]", "/(?!x)x/]", 'DETECTOR CONTROL'],
  ['D05_allowlist_not_per_file', WT, "let c = code(src);\n  for (const [f, statement] of SANCTIONED_READS) if (f === file) c = c.split(statement).join(' ');", "let c = code(src);\n  for (const [f, statement] of SANCTIONED_READS) c = c.split(statement).join(' ');", 'DETECTOR CONTROL'],
  ['D06_shared_not_scanned', WT, "  walk('src/shared');\n", '', 'CONTROL: sources are readable'],
  ['P01_real_copy_planted_in_shared', SHARED_PLANT, 'export function workspaceDisplayName(', 'export const _plant = (w: { branchManuallySet?: boolean }) => !w.branchManuallySet;\nexport function workspaceDisplayName(', 'no inline copy of the naming rule anywhere'],
  ['P02_real_read_planted_in_the_rename_route', HS, "if (route === '/rename') {", "if (route === '/rename') {\n            if (msg.ws?.branchManuallySet) { send(200, { ok: false }); return; }", 'no inline copy of the naming rule anywhere'],
  ['P03_real_sanitizer_body_planted', WS, '  const newBranch = sanitizeBranchName(rawNewBranch);\n  if (!newBranch) throw new Error(\'invalid branch name\');\n  // Fields', "  const newBranch = rawNewBranch.trim().replace(/\\s+/g, '-').replace(/[^a-zA-Z0-9._/-]/g, '').slice(0, 80);\n  if (!newBranch) throw new Error('invalid branch name');\n  // Fields", 'no inline copy of the naming rule anywhere'],
  ['P04_second_read_beside_the_sanctioned_one', SDK, 'env.ORCHESTRA_AUTO_RENAME_COUNT = String(ws.autoRenameCount ?? 0);', "env.ORCHESTRA_AUTO_RENAME_COUNT = String(ws.autoRenameCount ?? 0);\n  if (ws.branchManuallySet) env.ORCHESTRA_X = '1';", 'no inline copy of the naming rule anywhere'],
  ['P05_sanctioned_statement_drifts', SDK, 'env.ORCHESTRA_AUTO_RENAME_COUNT = String(ws.autoRenameCount ?? 0);', 'env.ORCHESTRA_AUTO_RENAME_COUNT = String(ws.autoRenameCount ?? 1);', 'allow-list has not rotted'],
  // ── follow-up #383 (review m1, verifier F1, dangling namer) ──
  ['N01_namer_name_discarded', POLICY, 'if (name && name.trim()) return name;', 'if (name && name.trim()) return undefined;', 'parent resolvable → its branch'],
  ['N02_namer_order_swapped', POLICY, 'for (const id of [target.parentId, target.namedByParent])', 'for (const id of [target.namedByParent, target.parentId])', 'parent AND a different namer resolvable'],
  ['N03_blank_branch_is_a_name', POLICY, 'if (name && name.trim()) return name;', 'if (name) return name;', 'a blank branch is no name'],
  ['N04_dangling_text_is_the_old_one', POLICY, "'named by your parent, who no longer exists — it can be renamed from the sidebar'", "'named by your parent — ask them to run `orchestra rename`'", 'DANGLING'],
  ['N05_dangling_text_loses_the_sidebar', POLICY, ' — it can be renamed from the sidebar', '', 'DANGLING'],
  ['W18_dispatch_lookup_returns_undefined', WS, 'namerName(ws, (pid) => store.getWorkspace(pid)?.branch)', 'namerName(ws, (pid) => undefined)', 'dispatchRenameRequest builds an AGENT caller'],
  ['W19_dispatch_has_no_parent_name', WS, 'const parentName = namerName(ws, (pid) => store.getWorkspace(pid)?.branch);', 'const parentName = undefined;', 'dispatchRenameRequest builds an AGENT caller'],
  ['D07_detector_blind_to_namer_reads', WT, "/\\.\\s*namedByParent\\b|\\[\\s*['\"`]namedByParent['\"`]\\s*\\]/]", '/(?!x)x/]', 'DETECTOR CONTROL'],
  ['D08a_detector_blind_to_parentId_vs_caller', WT, '/\\bparentId\\b[^;]{0,120}?(?:[!=]==?|\\.includes\\(|\\.indexOf\\()', '/(?!x)x[^;]{0,120}?(?:[!=]==?|\\.includes\\(|\\.indexOf\\()', 'DETECTOR CONTROL'],
  ['D08b_detector_blind_to_caller_vs_parentId', WT, '|\\b(?:from|caller|requester|actor|sender)\\w*\\b[^;]{0,120}?(?:[!=]==?|\\.includes\\(|\\.indexOf\\()[^;]{0,120}?\\bparentId\\b/]', '|(?!x)x/]', 'DETECTOR CONTROL'],
  ['D09_surface_ban_ignores_parentId', WT, '/\\.\\s*(?:parentId|namedByParent|branchManuallySet|autoRenameCount)\\b|', '/\\.\\s*(?:namedByParent|branchManuallySet|autoRenameCount)\\b|', 'DETECTOR CONTROL: the surface ban'],
  ['D10_a_surface_dropped', WT, "  ['sandbox-manager rename rpc', 'src/main/transport/sandbox-manager.ts', sandboxMgrSrc, (x) => between(x, \"case 'rename': {\", \"case 'spawn': {\"), /dispatchRenameRequest\\(/],\n", '', 'the rename surfaces read no authority field'],
  ['D11_surface_allowlist_not_per_file', WT, 'let c = code(slice);\n  for (const [f, statement] of SANCTIONED_READS) if (f === file) c', 'let c = code(slice);\n  for (const [f, statement] of SANCTIONED_READS) if (true) c', 'DETECTOR CONTROL: the surface ban'],
  ['D12_former_branch_not_allowed', WT, ' && !((d === NAMER_READ || d === NAMER_SHORTHAND) && NAMER_READ_FILES.has(file))', '', 'no inline copy of the naming rule anywhere'],
  ['P06_real_namer_refuse_in_the_rename_route', HS, "if (route === '/rename') {", "if (route === '/rename') {\n            const w0 = store.getWorkspace(msg.id); if (w0?.namedByParent && msg.from !== w0.namedByParent) { send(200, { ok: false }); return; }", 'no inline copy of the naming rule anywhere'],
  ['P07_real_from_vs_parentId_in_the_sandbox_rpc', SB, "      const p = payload as RpcRequestPayloads['rename'];\n", "      const p = payload as RpcRequestPayloads['rename'];\n      if (p.from !== store.getWorkspace(p.id)?.parentId) return { ok: false, error: 'no' };\n", 'no inline copy of the naming rule anywhere'],
  ['P08_real_namer_gate_in_the_adoption', ACT, '  const pin = adoptedBranchPin(fresh);\n', '  if (fresh.namedByParent) return;\n  const pin = adoptedBranchPin(fresh);\n', 'the rename surfaces read no authority field'],
  ['P09_real_parentId_local_in_dispatch', WS, '  const parentName = namerName(ws, (pid) => store.getWorkspace(pid)?.branch);', '  const par = ws.parentId; if (par === from) void 0;\n  const parentName = namerName(ws, (pid) => store.getWorkspace(pid)?.branch);', 'the rename surfaces read no authority field'],
  ['D08c_detector_blind_to_includes', WT, '[^;]{0,120}?(?:[!=]==?|\\.includes\\(|\\.indexOf\\()[^;]{0,120}?\\b(?:from|caller|requester|actor|sender)\\w*\\b|', '[^;]{0,120}?(?:[!=]==?)[^;]{0,120}?\\b(?:from|caller|requester|actor|sender)\\w*\\b|', 'DETECTOR CONTROL'],
  ['D13_detector_blind_to_namer_shorthand', WT, '/\\bnamedByParent\\s*[:,}]/]', '/(?!x)x/]', 'DETECTOR CONTROL'],
  ['D14_surface_ban_ignores_shorthand', WT, '|\\b(?:parentId|namedByParent)\\s*[:,}]/;', '/;', 'DETECTOR CONTROL: the surface ban'],
  ['P10_real_destructured_namer_in_the_rename_route', HS, "if (route === '/rename') {", "if (route === '/rename') {\n            const { namedByParent } = store.getWorkspace(msg.id)!;", 'no inline copy of the naming rule anywhere'],
  ['P11_real_namer_read_in_the_renderer', REND, 'const startRename = (e: React.MouseEvent, ws: Workspace) => {', 'const startRename = (e: React.MouseEvent, ws: Workspace) => {\n    const _locked = ws.namedByParent;', 'the pin is main-process / policy only'],
  // ── wiring (source-reading) ──
  ['W01_dispatch_ignores_from', WS, "decideRename(ws, { kind: 'agent', id: from }", "decideRename(ws, { kind: 'agent' }", 'asks the policy BEFORE touching git'],
  ['W02_refusal_swallowed', WS, 'if (!decision.allow) return { ok: false, error: decision.error };', 'if (!decision.allow) void 0;', 'asks the policy BEFORE touching git'],
  ['W03_write_before_refusal', WS, '  const decision = decideRename(ws, { kind: \'agent\', id: from }, { parentName });\n  if (!decision.allow) return { ok: false, error: decision.error };', '  const live0 = await getCurrentBranch(ws.worktreePath);\n  const decision = decideRename(ws, { kind: \'agent\', id: from }, { parentName });\n  if (!decision.allow) return { ok: false, error: decision.error };', 'asks the policy BEFORE touching git'],
  ['W04_inline_authority_copy', WS, '  const { pin } = decision;\n  try {\n    let updated: Workspace;\n    // A scratch session has no branch namespace', '  const { pin } = decision;\n  if (ws.parentId === from) void 0;\n  try {\n    let updated: Workspace;\n    // A scratch session has no branch namespace', 'NO inline authority copy'],
  ['W05_pin_not_applied', WS, 'renameWorkspaceBranch(id, target, pin)', 'renameWorkspaceBranch(id, target, { manual: false, bumpAutoCount })', 'asks the policy BEFORE touching git', { count: 2 }],
  ['W06_live_nudge_not_retired', WS, '    else if (pin.namedByParent) await writeRenameProgress(ws.worktreePath, MAX_AUTO_RENAMES);\n', '', 'retires the LIVE session'],
  ['W07_namer_pin_not_written', POLICY, "    ...(pin.namedByParent ? { namedByParent: pin.namedByParent } : {}),\n", '', 'namedByParent is written only when the pin carries one'],
  ['W08_same_name_parent_rename_not_persisted', POLICY, ' || (!!pin.namedByParent && pin.namedByParent !== ws.namedByParent);', ';', 'same-name'],
  ['W09_refusal_lookup_over_an_empty_target', WS, 'namerName(ws, (pid)', 'namerName({}, (pid)', 'dispatchRenameRequest builds an AGENT caller'],
  ['W10_sidebar_bypasses_policy', API, 'return renameWorkspaceBranch(id, newBranch, decision.pin);', 'return renameWorkspaceBranch(id, newBranch, { manual: true, bumpAutoCount: false });', 'sidebar rename is the HUMAN caller'],
  ['W11_human_path_skips_policy', API, "const decision = decideRename(ws, { kind: 'human' });", "const decision = { allow: true, pin: { manual: true, bumpAutoCount: false } };", 'sidebar rename is the HUMAN caller'],
  ['W12_route_drops_from', HS, ", typeof msg.from === 'string' ? msg.from : undefined));", '));', '/rename (hooks-server) passes the caller identity'],
  ['W13_sandbox_drops_from', SB, ", typeof p.from === 'string' ? p.from : undefined));", '));', 'sandbox transport route passes the caller identity'],
  ['W14_wire_type_drops_from', 'src/shared/sandbox-protocol.ts', 'rename: { id: string; branch: string; from?: string };', 'rename: { id: string; branch: string };', 'sandbox transport route passes the caller identity'],
  ['W15_cli_drops_from', CLI, "{ id, branch, from: selfWorkspaceId() }", '{ id, branch }', 'rename sends the caller identity', { cli: true }],
  ['W16_cli_source_wire_changed', CLI, "{ id, branch, from: selfWorkspaceId() }", "{ id, branch, from: undefined }", 'rename sends the caller identity', { cli: true }],
  ['W17_cli_sends_target_as_from', CLI, "{ id, branch, from: selfWorkspaceId() }", '{ id, branch, from: id }', 'rename sends the caller identity', { cli: true }],
];

const abs = (f) => path.join(REPO, f);
const shaOf = (f) => crypto.createHash('sha256').update(fs.readFileSync(abs(f))).digest('hex');
const sh = (cmd, a, opts = {}) => spawnSync(cmd, a, { cwd: REPO, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 280_000, ...opts });
const runTests = () => {
  const r = sh(process.execPath, ['--test', '--experimental-strip-types', ...TESTS]);
  const out = (r.stdout ?? '') + (r.stderr ?? '');
  const failed = [...out.matchAll(/^\s*not ok \d+ - (.*)$/gm)].map((m) => m[1]);
  const pass = Number(/^# pass (\d+)/m.exec(out)?.[1] ?? NaN);
  const fail = Number(/^# fail (\d+)/m.exec(out)?.[1] ?? NaN);
  const skipped = Number(/^# skipped (\d+)/m.exec(out)?.[1] ?? NaN);
  return { failed, pass, fail, skipped, status: r.status };
};
const buildCli = () => sh('pnpm', ['run', 'build:cli']);

// the CLI bundle is gitignored build output the sweep REBUILDS itself: it is verified against the sweep's own clean build below (`cleanCli`), never against a pre-sweep snapshot
const touched = [...new Set(MUTANTS.map((m) => m[1]))];
const before = Object.fromEntries(touched.map((f) => [f, fs.existsSync(abs(f)) ? shaOf(f) : null]));

if (dry) {
  let bad = 0;
  for (const [id, file, find, to, , o = {}] of MUTANTS) {
    const n = fs.readFileSync(abs(file), 'utf8').split(find).length - 1;
    const want = o.count ?? 1;
    if (n !== want || find === to) { bad++; console.log(`ANCHOR ${id}: ${n} occurrence(s) of find (want ${want})${find === to ? ' / find === to' : ''}`); }
  }
  console.log(bad ? `${bad} bad anchor(s)` : `all ${MUTANTS.length} anchors present exactly as expected`);
  process.exit(bad ? 1 : 0);
}

// Baseline: the instrument must say PASS on the clean tree (and the CLI bundle must be the clean build).
buildCli();
const cleanCli = shaOf('dist-electron/cli.js');
const base = runTests();
console.log(`BASELINE clean tree: pass=${base.pass} fail=${base.fail} skipped=${base.skipped} rc=${base.status}`);
if (base.fail !== 0 || base.skipped !== 0 || !(base.pass > 0)) { console.error('RED/PARTIAL BASELINE — sweep voided'); process.exit(2); }

let survivors = 0;
let ran = 0;
for (const [id, file, find, to, expect, o = {}] of MUTANTS) {
  if (only && !only.has(id) && !only.has(id.split('_')[0])) continue;
  const backup = fs.readFileSync(abs(file));
  const src = backup.toString('utf8');
  const n = src.split(find).length - 1;
  const want = o.count ?? 1;
  if (n !== want) { console.log(`${id}: ANCHOR MISSING (${n} of ${want}) — not run`); survivors++; continue; }
  fs.writeFileSync(abs(file), src.split(find).join(to));
  let verdict;
  try {
    if (shaOf(file) === crypto.createHash('sha256').update(backup).digest('hex')) { verdict = 'NOT-APPLIED'; survivors++; }
    else {
      if (o.cli) {
        buildCli();
        if (shaOf('dist-electron/cli.js') === cleanCli) { verdict = 'MUTANT-NOT-LIVE (bundle unchanged)'; survivors++; }
      }
      if (!verdict) {
        const r = runTests();
        const hit = r.failed.filter((t) => t.includes(expect));
        if (hit.length) verdict = `RED (${r.failed.length} failing; named: ${hit.length}) e.g. "${hit[0].slice(0, 90)}"`;
        else { verdict = `SURVIVED-OR-WRONG-RED (failing: ${r.failed.length ? r.failed.slice(0, 3).map((t) => t.slice(0, 60)).join(' | ') : 'none'}; wanted "${expect}")`; survivors++; }
      }
    }
  } finally {
    fs.writeFileSync(abs(file), backup);
    if (o.cli) buildCli();
  }
  ran++;
  console.log(`${id}: ${verdict}`);
}

// Byte-exact restore check (+ the CLI bundle is the clean build again).
let dirty = 0;
for (const f of touched) if (before[f] !== (fs.existsSync(abs(f)) ? shaOf(f) : null)) { dirty++; console.log(`DIRTY after sweep: ${f}`); }
if (shaOf('dist-electron/cli.js') !== cleanCli) { dirty++; console.log('DIRTY: dist-electron/cli.js is not the clean build'); }
const after = runTests();
console.log(`AFTER restore: pass=${after.pass} fail=${after.fail} skipped=${after.skipped}`);
console.log(`${ran} mutant(s) run, ${survivors} survivor/void, ${dirty} dirty file(s) => ${survivors === 0 && dirty === 0 && after.fail === 0 ? 'CLEAN' : 'DIRTY'}`);
process.exit(survivors === 0 && dirty === 0 && after.fail === 0 ? 0 : 1);
