#!/usr/bin/env node
// #378 self-gate — IN-PLACE mutation sweep of the post-wave-B cleanup (stop the SDK session before moving files, `orchestra read` retired,
// dead PTY leftovers). Each mutant re-adds ONE removed thing (or reverts ONE changed clause) in the real source and must turn its NAMED unit
// file and/or rig arm red. Byte-exact backup + `cmp` restore after every mutant; run it on a COMMITTED tree (the restore proof is `git diff` empty).
// Rig part (light, no Electron): scripts/e2e-stop-before-move.mjs arms in a scratch HOME — a mutant is killed by the rig when the arm exits
// non-zero AND prints a `FAIL  <clause>` line containing `clause`. CLI mutants rebuild dist-electron/cli.js (help.test.ts drives the BUILT bundle).
// Unmutated CONTROL first: every named unit file and every named rig arm must be GREEN, so a RED later is the mutant's doing.
// Run: node scripts/post-wave-b-cleanup-mutants.mjs [--only S01,R02] [--no-rig] [--check-anchors]

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const only = args.includes('--only') ? new Set(args[args.indexOf('--only') + 1].split(',')) : null;
const noRig = args.includes('--no-rig');
const WS = 'src/main/workspaces.ts', SI = 'src/main/sandbox-import.ts', ACT = 'src/main/activity.ts', HS = 'src/main/hooks-server.ts', ES = 'src/main/events-spool.ts';
const CLI = 'src/cli/index.ts', HELP = 'src/cli/help.ts', SDK = 'src/main/agent-sdk.ts', TYPES = 'src/shared/types.ts', BPR = 'src/main/bus-pause-records.ts';
const SM = 'src/main/transport/sandbox-manager.ts', PROTO = 'src/shared/sandbox-protocol.ts';
const T = {
  move: 'src/main/stop-before-move-wiring.test.ts', read: 'src/main/orchestra-read-removed.test.ts', dead: 'src/main/post-wave-b-cleanup.test.ts',
  help: 'src/cli/help.test.ts', live: 'src/main/liveness-dropped-posttool.test.ts', trap: 'src/main/pause-trap-wiring.test.ts', self: 'src/cli/self-workspace-id.test.ts',
};
const RIG = (arm) => ({ arm });

/** One mutant = exact-once edits [file, find, replacement]. `tests` = unit files that must go red; `rig` = {arm, clause}; `cli` = rebuild the CLI bundle first. */
const MUTANTS = [
  // ── strand 1: stop the real session before the move ──
  { id: 'S01_adopt_stops_only_a_pty', clause: 'adopt-repo stops the SDK session (the agent PTY is gone)', edits: [[WS, "await stopAgentSessionForMove(id, 'adopt-repo');", 'stopPty(id);']], tests: [T.move], rig: { ...RIG('adopt_live'), clause: 'the agent session is NOT live after the adopt' } },
  { id: 'S02_adopt_stops_after_the_copy', clause: 'adopt-repo stops the session BEFORE copying .claude/.orchestra (mutant: stops only after the hooks install, ≥ one heartbeat later)', edits: [
      [WS, "    await stopAgentSessionForMove(id, 'adopt-repo');\n", ''],
      [WS, "    await installOrchestraHooks(newWorktreePath);\n", "    await installOrchestraHooks(newWorktreePath);\n    await stopAgentSessionForMove(id, 'adopt-repo');\n"]], tests: [T.move], rig: { ...RIG('adopt_live'), clause: 'no agent write after the snapshot' } },
  { id: 'S03_helper_never_stops_the_session', clause: 'the helper stops the SDK session', edits: [[WS, "  await sdkStopIfLive(id);\n  await killKeeper(id, reason);", "  await killKeeper(id, reason);"]], tests: [T.move], rig: { ...RIG('adopt_live'), clause: 'the agent session is NOT live after the adopt' } },
  { id: 'S04_helper_does_not_fail_closed', clause: 'a session/keeper still alive aborts the move', edits: [[WS, "  if (sdkSessionLive(id) || readTrackedKeeperPid(id) !== null) {", "  if (false) {"]], tests: [T.move] },
  { id: 'S05_helper_does_not_await_the_keeper', clause: 'the helper awaits the keeper/CLI death', edits: [[WS, "  await killKeeper(id, reason); // a session that answered the interrupt closes gracefully on the keeper's own clock; this awaits the death\n", ""]], tests: [T.move] },
  { id: 'S06_import_stops_nothing', clause: 'import stops the session before staging', edits: [[SI, "  await stopAgentSessionForMove(id, 'sandbox-import');\n", ""]], tests: [T.move], rig: { ...RIG('import_live'), clause: 'when the POST landed the agent session was NOT live' } },
  { id: 'S07_import_stops_only_a_pty', clause: 'import stops the SDK session, not a PTY', edits: [[SI, "await stopAgentSessionForMove(id, 'sandbox-import');", "stopPty(id);"]], tests: [T.move], rig: { ...RIG('import_live'), clause: 'when the POST landed the agent session was NOT live' } },
  { id: 'S08_eject_stops_nothing', clause: 'eject stops the session before the export', edits: [[SI, "  await stopAgentSessionForMove(id, 'sandbox-eject');\n", ""]], tests: [T.move], rig: { ...RIG('eject_live'), clause: 'when the export was requested the agent session was NOT live' } },
  // ── strand 2: `orchestra read` retired ──
  { id: 'R01_cli_read_verb_back', clause: '`orchestra read` is an unknown command with no help entry', cli: true, edits: [
      [CLI, "    case 'message': {\n      // THE BRANCH IS CHOSEN FROM args[0] ALONE", "    case 'read': {\n      fail('mutant');\n      return;\n    }\n\n    case 'message': {\n      // THE BRANCH IS CHOSEN FROM args[0] ALONE"],
      [HELP, "  {\n    name: 'whoami',", "  {\n    name: 'read',\n    group: 'Workspaces',\n    summary: 'mutant',\n    detail: `usage: orchestra read <id>\\n\\nmutant`,\n  },\n  {\n    name: 'whoami',"]], tests: [T.help, T.read] },
  { id: 'R02_read_route_back', clause: 'no `/read` socket route', edits: [[HS, "          } else if (route === '/message') {", "          } else if (route === '/read') {\n            send(200, { ok: true });\n          } else if (route === '/message') {"]], tests: [T.read] },
  { id: 'R03_brief_recommends_read', clause: 'the orchestrator brief polls children through `peers`', edits: [[WS, "poll it yourself with `orchestra peers`. ", "poll it yourself with `orchestra read <id>`. "]], tests: [T.read] },
  { id: 'R04_skill_sections_not_renumbered', clause: 'the generated comms skill is renumbered 1..6', edits: [[WS, "## 2. Send a peer a message", "## 3. Send a peer a message"]], tests: [T.read] },
  { id: 'R05_readme_lists_read', clause: 'README no longer lists `orchestra read`', edits: [["README.md", "orchestra peers                                       # list the other agent workspaces (id, branch, repo, status)\n", "orchestra peers                                       # list the other agent workspaces (id, branch, repo, status)\norchestra read <id> [--lines N]                       # print a workspace's transcript\n"]], tests: [T.read] },
  { id: 'R06_sandbox_wire_has_read', clause: 'the sandbox wire has no `read` rpc', edits: [[PROTO, "export type RpcRoute = 'rename' | 'spawn' | 'peers' | 'message';", "export type RpcRoute = 'rename' | 'spawn' | 'peers' | 'read' | 'message';"]], tests: [T.read] },
  { id: 'R07_manager_dispatches_read', clause: 'the sandbox manager has no `read` case', edits: [[SM, "    case 'peers': {\n      const p = payload as RpcRequestPayloads['peers'];", "    case 'read': {\n      return { ok: false, error: 'mutant' };\n    }\n    case 'peers': {\n      const p = payload as RpcRequestPayloads['peers'];"]], tests: [T.read] },
  { id: 'R08_dispatchReadRequest_back', clause: 'no dispatchReadRequest in the host', edits: [[WS, "export interface MessageResult {", "export function dispatchReadRequest(): void {}\n\nexport interface MessageResult {"]], tests: [T.read] },
  // ── strand 3: dead code and the things kept on purpose ──
  { id: 'C01_queuedSubmit_param_back', clause: 'applyAgentEvent has no queuedSubmit parameter', edits: [[ACT, "  toolUseId?: string | null,\n): void {", "  toolUseId?: string | null,\n  queuedSubmit?: boolean,\n): void {"]], tests: [T.live, T.dead] },
  { id: 'C02_submit_no_longer_clears_in_flight', clause: 'every submit clears the in-flight tools (#199)', edits: [[ACT, "      clearInFlightTools(id);\n      // #252 D1b (rows 29/30)", "      // #252 D1b (rows 29/30)"]], tests: [T.live] },
  { id: 'C03_submit_never_notifies_turn_start', clause: 'every submit notifies the pause trap', edits: [[ACT, "      notifyTurnStart(id);\n", ""]], tests: [T.trap] },
  { id: 'C04_stopfail_loses_its_error_reason', clause: 'stopfail derives the error stop reason from the event name', edits: [[ACT, "fireFinished(id, event === 'stopfail' ? 'error' : undefined);", "fireFinished(id, undefined);"]], tests: [T.dead] },
  { id: 'C05_spool_passes_the_old_slot_order', clause: 'the spool reader passes (transcript, crons, toolUseId)', edits: [[ES, "applyAgentEvent(id, ev.event, tool, transcript, crons, toolUseId);", "applyAgentEvent(id, ev.event, tool, transcript, undefined, crons, toolUseId);"]], tests: [T.dead] },
  { id: 'C06_dispatchHookEvent_back', clause: 'the legacy /event entry point is gone', edits: [[ACT, "      alog.warn(`unhandled agent event \"${event}\" (ws=${id}) — status unchanged`);\n  }\n}\n", "      alog.warn(`unhandled agent event \"${event}\" (ws=${id}) — status unchanged`);\n  }\n}\n\nexport function dispatchHookEvent(id: string, event: string): void {\n  applyAgentEvent(id, event, undefined);\n}\n"]], tests: [T.dead] },
  { id: 'C07_bilan_pty_surface_back', clause: 'the Bilan surface has no `pty` value', edits: [[BPR, "surface: 'sdk' | 'none' | 'remote';", "surface: 'sdk' | 'pty' | 'none' | 'remote';"]], tests: [T.dead] },
  { id: 'C08_archive_stops_the_bare_id_again', clause: 'archive stops no agent PTY', edits: [[WS, "    stopPty(`${ws.id}:run`);\n    stopPty(`${ws.id}:nvim`);\n    // Tear down the embedded browser panel", "    stopPty(ws.id);\n    stopPty(`${ws.id}:run`);\n    stopPty(`${ws.id}:nvim`);\n    // Tear down the embedded browser panel"]], tests: [T.dead] },
  { id: 'C09_delete_stops_the_bare_id_again', clause: 'delete stops no agent PTY', edits: [[WS, "  stopPty(`${id}:run`);\n  stopPty(`${id}:nvim`);\n  removeAgentTmpDir(id);", "  stopPty(id);\n  stopPty(`${id}:run`);\n  stopPty(`${id}:nvim`);\n  removeAgentTmpDir(id);"]], tests: [T.dead] },
  { id: 'C10_prune_stops_the_bare_id_again', clause: 'prune stops no agent PTY', edits: [[WS, "      stopPty(`${ws.id}:run`);\n      stopPty(`${ws.id}:nvim`);\n      clearScrollback(ws.id);", "      stopPty(ws.id);\n      stopPty(`${ws.id}:run`);\n      stopPty(`${ws.id}:nvim`);\n      clearScrollback(ws.id);"]], tests: [T.dead] },
  { id: 'C11_run_nvim_stops_dropped_from_archive', clause: 'archive still stops the Run/nvim terminals (control of C08)', edits: [[WS, "    stopPty(`${ws.id}:run`);\n    stopPty(`${ws.id}:nvim`);\n    // Tear down the embedded browser panel", "    // Tear down the embedded browser panel"]], tests: [T.dead] },
  { id: 'C12_identity_fallback_removed', clause: 'KEEP: the ORCHESTRA_WS_ID_IDENTITY fallback (a keeper born before #233)', edits: [[CLI, "const id = env.ORCHESTRA_WS_ID || env.ORCHESTRA_WS_ID_IDENTITY;", "const id = env.ORCHESTRA_WS_ID;"]], tests: [T.self, T.dead] },
  { id: 'C13_anyTranscriptExists_back', clause: 'anyTranscriptExists is gone', edits: [[SDK, "/** Run `fn` with `CLAUDE_CONFIG_DIR` pinned", "function anyTranscriptExists(ws: Workspace): boolean { return !!ws; }\n\n/** Run `fn` with `CLAUDE_CONFIG_DIR` pinned"]], tests: [T.dead] },
  { id: 'C14_sandbox_workspace_dir_back', clause: 'SANDBOX_WORKSPACE_DIR is gone', edits: [[TYPES, "/** Cross-machine ownership state for one sandbox endpoint", "export const SANDBOX_WORKSPACE_DIR = '/workspace';\n\n/** Cross-machine ownership state for one sandbox endpoint"]], tests: [T.dead] },
  { id: 'C15_branch_switch_clears_an_agent_log', clause: 'a branch switch clears no agent log', edits: [[WS, "  stopPty(nvimId);\n  // The STRUCTURED session", "  stopPty(nvimId);\n  clearScrollback(id);\n  // The STRUCTURED session"]], tests: [T.dead] },
  // ── LEAD addition: every generated coordination text names the host-enforced stop ──
  { id: 'L01_brief_drops_the_stop_line', clause: 'the orchestrator brief names `orchestra run pause`', edits: [[WS, "  'To stop or pause a wave or a fleet: `orchestra run pause` (soft) or `orchestra run pause --hard` — never a message asking it to stop. ' +\n", ""]], tests: [T.dead] },
  { id: 'L02_dual_reminder_drops_the_stop_line', clause: 'the dual-role reminder names `orchestra run pause`', edits: [[WS, "alongside your own work. To stop or pause a wave or a fleet: \\`orchestra run pause\\` (soft) or \\`orchestra run pause --hard\\` — never a message asking it to stop. And close the loop", "alongside your own work. And close the loop"]], tests: [T.dead] },
  { id: 'L03_pure_reminder_drops_the_stop_line', clause: 'the coordinator reminder names `orchestra run pause`', edits: [[WS, "reporting to the user. To stop or pause a wave or a fleet: \\`orchestra run pause\\` (soft) or \\`orchestra run pause --hard\\` — never a message asking it to stop. And close the loop", "reporting to the user. And close the loop"]], tests: [T.dead] },
  { id: 'L04_comms_skill_drops_the_stop_line', clause: 'the comms skill names `orchestra run pause`', edits: [[WS, "To stop or pause a wave or a fleet: \\`orchestra run pause\\` (soft) or \\`orchestra run pause --hard\\` (§6) — never a message asking it to stop.\n\n", ""]], tests: [T.dead] },
];

// ── instrument checks that need no run ──
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(path.join(REPO, f))).digest('hex');
const count = (src, s) => src.split(s).length - 1;
function anchorsOk() {
  let bad = 0, total = 0;
  for (const m of MUTANTS) for (const [f, find] of m.edits) {
    total++;
    // edits of one mutant apply in order: an anchor may be produced by an earlier edit of the same mutant, so check against the file as that mutant leaves it
    let src = fs.readFileSync(path.join(REPO, f), 'utf8');
    for (const [f2, find2, to2] of m.edits) { if (f2 !== f) continue; if (find2 === find) break; src = src.replace(find2, () => to2); }
    const n = count(src, find);
    if (n !== 1) { bad++; console.log(`ANCHOR-BAD ${m.id}: ${f} matches ${n}× (need exactly 1): ${JSON.stringify(find.slice(0, 70))}`); }
  }
  console.log(`ANCHORS: ${total - bad}/${total} resolve exactly once`);
  return bad === 0;
}
if (args.includes('--check-anchors')) process.exit(anchorsOk() ? 0 : 1);
if (!anchorsOk()) process.exit(2);
const touched = [...new Set(MUTANTS.flatMap((m) => m.edits.map(([f]) => f)))];
if (spawnSync('git', ['-C', REPO, 'diff', '--quiet', '--', ...touched]).status !== 0) { console.error('ABORT: a file a mutant edits has uncommitted changes — commit first (the restore proof is `git diff` empty)'); process.exit(2); }

const BACKUP = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'cleanup378-mutants-'));
const unit = (files) => spawnSync(process.execPath, ['--test', '--experimental-strip-types', ...files], { cwd: REPO, encoding: 'utf8', timeout: 300000 });
const failedNames = (out) => [...out.matchAll(/^\s*not ok \d+ - (.*)$/gm)].map((m) => m[1]);
const buildCli = () => execFileSync('pnpm', ['run', 'build:cli'], { cwd: REPO, stdio: 'ignore', timeout: 300000 });
function rigRun(arm) {
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', '--import', './scripts/.r2-register.mjs', 'scripts/e2e-stop-before-move.mjs', arm], { cwd: REPO, encoding: 'utf8', timeout: 300000, env: { ...process.env, E2E_HOME: path.join(BACKUP, 'rig-home') } });
  const out = `${r.stdout}\n${r.stderr}`;
  fs.writeFileSync(path.join(BACKUP, `rig-${arm}-${Date.now()}.log`), out);
  return { fails: [...out.matchAll(/^FAIL\s+(.*?) —/gm)].map((m) => m[1]), summary: (out.match(/^\S+: \d+\/\d+ clauses PASS.*$/m) ?? ['(no summary line)'])[0], rc: r.status };
}

// ── CONTROL: the unmutated tree — every named unit file and rig arm must be GREEN, so a later RED is the mutant's doing ──
{
  buildCli();
  const files = [...new Set(MUTANTS.flatMap((m) => m.tests ?? []))];
  const u = unit(files); const red = failedNames(u.stdout);
  console.log(`CONTROL unmutated unit files (${files.length}): ${u.status === 0 && red.length === 0 ? 'GREEN (instrument can pass)' : `RED ${JSON.stringify(red)} — INSTRUMENT BROKEN`}`);
  if (u.status !== 0) process.exit(4);
  if (!noRig) for (const arm of [...new Set(MUTANTS.filter((m) => m.rig).map((m) => m.rig.arm))]) {
    const g = rigRun(arm);
    console.log(`CONTROL unmutated rig ${arm}: ${g.rc === 0 && g.fails.length === 0 ? `GREEN (${g.summary})` : `RED ${JSON.stringify(g.fails)} rc=${g.rc} — INSTRUMENT BROKEN`}`);
    if (g.rc !== 0) process.exit(4);
  }
}

let killed = 0; const survived = []; const rows = [];
function restore(files) {
  for (const f of files) {
    fs.copyFileSync(path.join(BACKUP, f.replaceAll('/', '__')), path.join(REPO, f));
    if (spawnSync('cmp', ['-s', path.join(BACKUP, f.replaceAll('/', '__')), path.join(REPO, f)]).status !== 0) { console.error(`FATAL: restore of ${f} is not byte-exact`); process.exit(3); }
  }
}
for (const m of MUTANTS) {
  if (only && !only.has(m.id.split('_')[0])) continue;
  const files = [...new Set(m.edits.map(([f]) => f))];
  for (const f of files) fs.copyFileSync(path.join(REPO, f), path.join(BACKUP, f.replaceAll('/', '__')));
  const before = Object.fromEntries(files.map((f) => [f, sha(f)]));
  try {
    for (const [f, find, to] of m.edits) { const src = fs.readFileSync(path.join(REPO, f), 'utf8'); fs.writeFileSync(path.join(REPO, f), src.replace(find, () => to)); }
    if (m.cli) buildCli();
    const u = m.tests?.length ? unit(m.tests) : null; const red = u ? failedNames(u.stdout) : [];
    const unitKilled = u ? u.status !== 0 && red.length > 0 : null;
    let rigKilled = null, rigNote = '';
    if (m.rig && !noRig) { const g = rigRun(m.rig.arm); rigKilled = g.rc !== 0 && g.fails.some((c) => c.includes(m.rig.clause)); rigNote = ` rig[${m.rig.arm}] ${rigKilled ? `RED (${g.fails.length} FAIL: ${g.fails[0] ?? ''})`.slice(0, 120) : `GREEN/INCONCLUSIVE ${g.summary}`}`; }
    const ok = (unitKilled === null || unitKilled) && (rigKilled === null || rigKilled) && !(unitKilled === null && rigKilled === null);
    rows.push(`${ok ? 'KILLED  ' : 'SURVIVED'} ${m.id} — ${m.clause} — tests ${unitKilled === null ? 'n/a' : unitKilled ? `RED (${red.length}: ${red.slice(0, 2).join(' | ').slice(0, 110)})` : 'GREEN'}${rigNote}`);
    if (ok) killed++; else survived.push(m.id);
  } finally {
    restore(files);
    for (const f of files) if (sha(f) !== before[f]) { console.error(`FATAL: ${f} differs after restore`); process.exit(3); }
  }
  console.log(rows[rows.length - 1]);
}
buildCli(); // leave dist-electron/cli.js built from the RESTORED tree
const dirty = spawnSync('git', ['-C', REPO, 'diff', '--stat', '--', 'src', 'scripts', 'README.md', 'sandbox']).stdout.toString().trim();
console.log(`TREE: ${dirty ? `DIRTY\n${dirty}` : 'clean (git diff empty) — every file byte-exact restored'}`);
console.log(`MUTATE-CLEANUP-378: ${survived.length ? 'FAIL' : 'PASS'} (${killed}/${rows.length} killed${survived.length ? `; survived: ${survived.join(', ')}` : ''})`);
process.exit(survived.length || dirty ? 1 : 0);
