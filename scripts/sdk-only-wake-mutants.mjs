#!/usr/bin/env node
// #232 self-gate — IN-PLACE mutation sweep of "wake, messages, prompt queue, review/fix-checks, migration, peers, branch switch, hibernation and restart know only
// SDK sessions". Each mutant re-adds ONE removed live-agent-PTY branch (or reverts one fix clause) in the real source and must turn its NAMED test or rig clause red.
// Byte-exact backup + `cmp` restore after every mutant; run it on a COMMITTED tree (`git diff` of the mutated files must be empty at the end).
// Unit part (cheap): `node --test` of the named files. Rig part (HEAVY by the wave rule — boots the built app: needs the heavy-rig token): rebuild `build:bundles`, then
// `scripts/e2e-agent-view-removal.sh <repo> --arm <arm>` — the mutant is killed when the rig reports a FAIL line whose clause contains `clause`.
// #233: the stray-agent-PTY rig arms (sdk_only_seams / sdk_only_hibernate) went with the launcher — a stray PTY can no longer be conjured — so the PTY-branch mutants
// (M03–M05, M07, M10, M12: they re-add a branch that only bites with a live agent PTY) are killed by the source pins in sdk-only-wake-wiring.test.ts. #233-fu (review #233 F1)
// restores the built-app coverage of the HEALTHY seams with the slim arms `sdk_seams` / `sdk_hibernate`: M09, M13, M14 get their rig clause back, and each PTY-branch
// mutant has a rig TWIN F03–F12 that breaks the same site's healthy path (rig-only: `tests: []`).
// Run: node scripts/sdk-only-wake-mutants.mjs [--only M01,M02] [--no-rig] [--check-anchors]

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
const OT = 'src/shared/opening-task.ts';
const WS = 'src/main/workspaces.ts', AH = 'src/main/api-handlers.ts', AS = 'src/main/agent-sdk.ts', PQ = 'src/main/prompt-queue.ts', HB = 'src/main/hibernation.ts';
const SH = 'src/shared/hibernation.ts', RM = 'src/shared/restart-mode.ts', WR = 'src/main/wake-roster.ts';
const T = {
  opening: 'src/shared/opening-task.test.ts', wiring: 'src/main/sdk-only-wake-wiring.test.ts', resume: 'src/main/resume-guard-binding.test.ts', wakeFailed: 'src/main/wake-failed-guards.test.ts',
  reparent: 'src/main/reparent-run-binding.test.ts', hib: 'src/shared/hibernation.test.ts', restart: 'src/shared/restart-mode.test.ts', admission: 'src/main/admission-wiring.test.ts',
};
const SEAMS = 'sdk_seams', HIB = 'sdk_hibernate', REFUSED = 'refused_id_not_readopted';   // #233-fu: the slim NO-STRAY arms (the stray-PTY arms of #232 went with the launcher)
const PTY = "const pty = await import('./pty');";

/** One mutant = one or more exact-once edits. `tests` = unit files that must go red; `rig` = {arm, clause} killed by a FAIL line containing `clause`. */
const MUTANTS = [
  { id: 'M01_refused_sdk_born_id_clears_to_undefined', clause: '#232 F1: consume clears ANY refused id to the \'\' marker', edits: [[AS, "void persistWorkspacePatch(session.wsId, { sdkSessionId: refusedResumeClearValue(wsNow) });", "void persistWorkspacePatch(session.wsId, { sdkSessionId: wasAdopted ? '' : undefined });"]], tests: [T.resume, T.wiring], rig: { arm: REFUSED, clause: 'refused-id-cleared-to-marker' } },
  { id: 'M02_sdksend_start_failure_clears_to_undefined', clause: '#232 F1: the sdkSend start-failure catch clears to \'\' too', edits: [[AS, "await persistWorkspacePatch(wsId, { sdkSessionId: refusedResumeClearValue(wsNow) }).catch(() => {}); // #232:", "await persistWorkspacePatch(wsId, { sdkSessionId: undefined }).catch(() => {}); // #232:"]], tests: [T.resume, T.wiring] },
  { id: 'M03_message_typed_into_a_live_pty', clause: 'message delivery never types into a PTY', edits: [[WS, "  // #287 Admission: a stopped FLEET member's wake would START a process", `  if (isRunning(input.to)) { writePty(input.to, body); setTimeout(() => writePty(input.to, '\\r'), 80); return { ok: true, delivery: 'live', branch: target.branch }; }\n  // #287 Admission: a stopped FLEET member's wake would START a process`]], tests: [T.wiring] },
  { id: 'M04_wake_refused_for_a_live_pty', clause: 'wakeAgentWithPrompt ignores an agent PTY', edits: [[WS, "  if (!ws || ws.archived) return false;\n  // #226: sandbox agents are paused — refuse here too", "  if (!ws || ws.archived || isRunning(id)) return false;\n  // #226: sandbox agents are paused — refuse here too"]], tests: [T.wiring] },
  { id: 'M05_prompt_queue_typed_into_a_live_pty', clause: 'the prompt-queue flush never types into a PTY', edits: [[PQ, "  try {\n    if (await wakeAgentWithPrompt(id, body,", `  ${PTY} if (pty.isRunning(id)) { pty.writePty(id, body); setTimeout(() => pty.writePty(id, '\\r'), 80); return { ok: true, delivered: queue.length }; }\n  try {\n    if (await wakeAgentWithPrompt(id, body,`]], tests: [T.wiring] },
  { id: 'M06_fix_checks_types_into_a_live_pty', clause: 'fix-checks has no PTY branch (an unwakeable agent surfaces the error)', edits: [[AH, "if (!(await wakeAgentWithPrompt(id, prompt, { origin: 'human' }))) throw new Error(AGENT_WAKE_FAILED); // #252: a human click (row 28)\n", "if (!(await wakeAgentWithPrompt(id, prompt, { origin: 'human' }))) { if (!isRunning(id)) throw new Error(AGENT_WAKE_FAILED); writePty(id, prompt); } // #252: a human click (row 28)\n"]], tests: [T.wakeFailed, T.wiring] },
  { id: 'M07_toolbar_restart_stops_a_live_pty', clause: 'the toolbar Restart has no live-PTY branch', edits: [[AH, "    const { dispatchRestartRequest } = await import('./restart-workspace.ts');\n    const res = await dispatchRestartRequest({ id, fresh: false, trigger: 'toolbar' });", "    if (isRunning(id)) { stopPty(id); return; }\n    const { dispatchRestartRequest } = await import('./restart-workspace.ts');\n    const res = await dispatchRestartRequest({ id, fresh: false, trigger: 'toolbar' });"]], tests: [T.wiring] },
  { id: 'M08_migration_resumes_a_live_pty', clause: 'account migration never stops/relaunches a PTY', edits: [[WS, "    // Move the conversation before re-pinning so a failure leaves the workspace", "    const wasRunning = isRunning(id); if (wasRunning) stopPty(id);\n    // Move the conversation before re-pinning so a failure leaves the workspace"]], tests: [T.wiring] },
  { id: 'M09_peers_running_flag_back', clause: '/peers carries no PTY-derived `running` flag', edits: [[WS, "    status: w.status,\n    lastTask: w.lastTask ? w.lastTask.slice(0, 200) : undefined,", "    status: w.status,\n    running: isRunning(w.id),\n    lastTask: w.lastTask ? w.lastTask.slice(0, 200) : undefined,"]], tests: [T.wiring], rig: { arm: SEAMS, clause: 'peers/entry-present-without-a-running-flag' } },
  { id: 'M10_branch_switch_stops_the_agent_pty', clause: 'a branch switch recycles only the nvim PTY', edits: [[WS, "  const restartNvim = isRunning(nvimId);\n  stopPty(nvimId);", "  const restartNvim = isRunning(nvimId);\n  stopPty(id);\n  stopPty(nvimId);"]], tests: [T.wiring] },
  { id: 'M11_reparent_live_includes_the_pty', clause: 'the reparent reconcile asks the SDK session only', edits: [[WS, "        live: sdkSessionLive(ws.id),", "        live: sdkSessionLive(ws.id) || isRunning(ws.id),"]], tests: [T.reparent, T.wiring] },
  { id: 'M12_hibernation_counts_a_stray_pty', clause: 'the Veille sweep asks the SDK session only', edits: [[HB, "    const hasLiveSdk = sdkSessionLive(ws.id);", "    const hasLiveSdk = sdkSessionLive(ws.id) || isRunning(ws.id);"], [HB, "          hasLiveSdk: sdkSessionLive(ws.id),", "          hasLiveSdk: sdkSessionLive(ws.id) || isRunning(ws.id),"], [HB, "    const liveSdkNow = sdkSessionLive(ws.id);", "    const liveSdkNow = sdkSessionLive(ws.id) || isRunning(ws.id);"]], tests: [T.wiring] },
  { id: 'M13_run_terminal_no_longer_spares', clause: 'a live Run terminal still blocks the Veille', edits: [[SH, "  if (hasLiveRunPty) return false;\n", ""]], tests: [T.hib, T.wiring], rig: { arm: HIB, clause: 'hibernation/live-run-terminal-still-spares' } },
  { id: 'M14_idle_sdk_workspace_never_hibernates', clause: 'an idle SDK workspace still hibernates', edits: [[SH, "  if (!hasLiveSdk) return false;", "  return false;"]], tests: [T.hib], rig: { arm: HIB, clause: 'hibernation/idle-sdk-workspace-hibernates' } },
  { id: 'M15_roster_sleeping_always_true', clause: 'a sleeping member = no live SDK session', edits: [[WR, "sleeping: !sdkSessionLive(ws.id),", "sleeping: true,"]], tests: [T.admission] },
  { id: 'M16_router_drops_the_structured_branch', clause: 'the classifier routes a structured workspace to its own effect', edits: [[RM, "  if (mode === 'structured') {\n    await effects.restartStructured(fresh);\n    return 'structured';\n  }\n", ""]], tests: [T.restart] },
  { id: 'M17_start_once_refuses_for_a_live_pty', clause: 'startWorkspaceAgentOnce has no PTY branch', edits: [[WS, "  if (!ws || ws.archived) return { ok: false, error: 'unknown workspace' };\n  // #226: sandbox agents are paused", "  if (!ws || ws.archived) return { ok: false, error: 'unknown workspace' };\n  if (isRunning(id)) return { ok: true };\n  // #226: sandbox agents are paused"]], tests: [T.wiring] },
  { id: 'M18_refused_id_always_undefined', clause: 'a refused hasInput id clears to the \'\' marker (no re-adoption)', edits: [[OT, "return owesOpeningTask({ ...ws, sdkSessionId: undefined }) ? undefined : '';", "return undefined;"]], tests: [T.opening] },
  { id: 'M19_refused_id_always_marker', clause: 'a kept child owing its brief keeps undefined (Restart redelivers)', edits: [[OT, "return owesOpeningTask({ ...ws, sdkSessionId: undefined }) ? undefined : '';", "return '';"]], tests: [T.opening] },
  // ── rig TWINS (#233-fu): break the healthy path at the SAME site as M03/M04/M05/M07/M10/M12 — rig-only, killed by the built-app arms ──
  { id: 'F03_message_live_delivery_reports_dropped', clause: 'a live session receives `orchestra message` (rig twin of M03)', edits: [[WS, "  const confirmed = await sdkDeliverConfirmed(input.to, body, peerOrigin);", "  const confirmed = ((c) => (c === 'none' ? c : ('dropped' as const)))(await sdkDeliverConfirmed(input.to, body, peerOrigin));"]], tests: [], rig: { arm: SEAMS, clause: 'message/live-session-is-delivered-to' } },
  { id: 'F04_wake_always_refused', clause: 'wakeAgentWithPrompt wakes a stopped workspace (rig twin of M04)', edits: [[WS, "  if (!ws || ws.archived) return false;\n  // #226: sandbox agents are paused — refuse here too", "  if (!ws || ws.archived || ws) return false;\n  // #226: sandbox agents are paused — refuse here too"]], tests: [], rig: { arm: SEAMS, clause: 'message/stopped-workspace-is-woken' } },
  { id: 'F05_prompt_queue_never_wakes', clause: 'the prompt-queue flush delivers to the session (rig twin of M05)', edits: [[PQ, "  try {\n    if (await wakeAgentWithPrompt(id, body,", "  try {\n    if (false && await wakeAgentWithPrompt(id, body,"]], tests: [], rig: { arm: SEAMS, clause: 'queue/flush-delivers-to-the-session' } },
  { id: 'F07_toolbar_restart_is_a_no_op', clause: 'the toolbar Restart launches a new session CLI (rig twin of M07 — the review #233 F1 probe)', edits: [[AH, "    const { dispatchRestartRequest } = await import('./restart-workspace.ts');\n    const res = await dispatchRestartRequest({ id, fresh: false, trigger: 'toolbar' });", "    if (id) return;\n    const { dispatchRestartRequest } = await import('./restart-workspace.ts');\n    const res = await dispatchRestartRequest({ id, fresh: false, trigger: 'toolbar' });"]], tests: [], rig: { arm: SEAMS, clause: 'restart/a-new-session-cli-is-launched' } },
  { id: 'F10_branch_switch_skips_the_checkout', clause: 'a branch switch checks the branch out (rig twin of M10)', edits: [[WS, "  await switchWorktreeBranch(ws.worktreePath, branch);\n", "  void switchWorktreeBranch;\n"]], tests: [], rig: { arm: SEAMS, clause: 'branch-switch/the-checkout-moved' } },
  { id: 'F08_migration_leaves_the_session_live', clause: 'account migration stops the live session before moving its transcript (rig twin of M08)', edits: [[WS, "      const keeperBefore = readTrackedKeeperPid(id);\n      await sdkStopIfLive(id);", "      const keeperBefore = readTrackedKeeperPid(id);"]], tests: [], rig: { arm: SEAMS, clause: 'migrate/the-live-session-is-stopped-before-the-move' } },
  { id: 'F10b_branch_switch_leaves_the_session_live', clause: 'a branch switch stops the live session (rig twin of M10)', edits: [[WS, "  await sdkStopIfLive(id);\n\n  const repoName = path.basename(ws.repoPath);", "  const repoName = path.basename(ws.repoPath);"]], tests: [], rig: { arm: SEAMS, clause: 'branch-switch/the-live-session-is-stopped' } },
  { id: 'F12_hibernation_sees_no_sdk_session', clause: 'the Veille sweep sees a live SDK session (rig twin of M12)', edits: [[HB, "    const hasLiveSdk = sdkSessionLive(ws.id);", "    const hasLiveSdk = false;"]], tests: [], rig: { arm: HIB, clause: 'hibernation/idle-sdk-workspace-hibernates' } },
];

// ── instrument checks that need no app ──
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(path.join(REPO, f))).digest('hex');
const count = (src, s) => src.split(s).length - 1;
function anchorsOk() {
  let bad = 0;
  for (const m of MUTANTS) for (const [f, find] of m.edits) { const n = count(fs.readFileSync(path.join(REPO, f), 'utf8'), find); if (n !== 1) { bad++; console.log(`ANCHOR-BAD ${m.id}: ${f} matches ${n}× (need exactly 1): ${JSON.stringify(find.slice(0, 70))}`); } }
  console.log(`ANCHORS: ${MUTANTS.reduce((a, m) => a + m.edits.length, 0) - bad}/${MUTANTS.reduce((a, m) => a + m.edits.length, 0)} resolve exactly once`);
  return bad === 0;
}
if (args.includes('--check-anchors')) process.exit(anchorsOk() ? 0 : 1);
if (!anchorsOk()) process.exit(2);
if (spawnSync('git', ['-C', REPO, 'diff', '--quiet', '--', ...new Set(MUTANTS.flatMap((m) => m.edits.map(([f]) => f)))]).status !== 0) { console.error('ABORT: a file a mutant edits has uncommitted changes — commit first (the restore proof is `git diff` empty)'); process.exit(2); }

const BACKUP = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'sdkonly-mutants-'));
const unit = (files) => spawnSync(process.execPath, ['--test', '--experimental-strip-types', ...files], { cwd: REPO, encoding: 'utf8', timeout: 300000 });
const failedNames = (out) => [...out.matchAll(/^\s*not ok \d+ - (.*)$/gm)].map((m) => m[1]);
function rigRun(arm) {
  execFileSync('pnpm', ['run', 'build:bundles'], { cwd: REPO, stdio: 'ignore', timeout: 600000 });
  const r = spawnSync('bash', [path.join(REPO, 'scripts/e2e-agent-view-removal.sh'), REPO, '--arm', arm], { cwd: REPO, encoding: 'utf8', timeout: 900000 });
  const out = `${r.stdout}\n${r.stderr}`;
  fs.writeFileSync(path.join(BACKUP, `rig-${arm}-${Date.now()}.log`), out); // kept for forensics (a GREEN rig must be readable)
  return { fails: [...out.matchAll(/^FAIL\s+(\S+) —/gm)].map((m) => m[1]), last: (out.match(/RIG-RESULT .*/) ?? ['(no RIG-RESULT)'])[0], rc: r.status };
}

let killed = 0, survived = [];
const rows = [];
function restore(files) {
  for (const f of files) {
    fs.copyFileSync(path.join(BACKUP, f.replaceAll('/', '__')), path.join(REPO, f));
    if (spawnSync('cmp', ['-s', path.join(BACKUP, f.replaceAll('/', '__')), path.join(REPO, f)]).status !== 0) { console.error(`FATAL: restore of ${f} is not byte-exact`); process.exit(3); }
  }
}
// CONTROL 1: a no-op "mutant" (same text) must leave the named tests GREEN — the instrument can say PASS.
{
  const [f, find] = MUTANTS[0].edits[0];
  const orig = fs.readFileSync(path.join(REPO, f), 'utf8');
  fs.writeFileSync(path.join(REPO, f), orig.replace(find, () => find));
  const r = unit(MUTANTS[0].tests); const red = failedNames(`${r.stdout}`);
  fs.writeFileSync(path.join(REPO, f), orig);
  console.log(`CONTROL no-op mutant: tests ${r.status === 0 && red.length === 0 ? 'GREEN (instrument can pass)' : `RED ${JSON.stringify(red)} — INSTRUMENT BROKEN`}`);
  if (r.status !== 0) process.exit(4);
}
for (const m of MUTANTS) {
  if (only && !only.has(m.id.split('_')[0])) continue;
  const files = [...new Set(m.edits.map(([f]) => f))];
  for (const f of files) fs.copyFileSync(path.join(REPO, f), path.join(BACKUP, f.replaceAll('/', '__')));
  const before = Object.fromEntries(files.map((f) => [f, sha(f)]));
  try {
    for (const [f, find, to] of m.edits) { const src = fs.readFileSync(path.join(REPO, f), 'utf8'); fs.writeFileSync(path.join(REPO, f), src.replace(find, () => to)); }
    const u = m.tests.length ? unit(m.tests) : null; const red = u ? failedNames(u.stdout) : [];
    const unitKilled = u ? u.status !== 0 && red.length > 0 : null;   // null = rig-only mutant (a twin of a PTY-branch mutant)
    let rigKilled = null, rigNote = '';
    if (m.rig && !noRig) { const g = rigRun(m.rig.arm); rigKilled = g.fails.some((c) => c.includes(m.rig.clause)); if (!g.last.startsWith('RIG-RESULT')) { rigKilled = false; rigNote = ` rig[${m.rig.arm}] INCONCLUSIVE — the rig produced no RIG-RESULT (${g.last}; rc ${g.rc}) — see ${BACKUP}`; } else rigNote = ` rig[${m.rig.arm}] ${rigKilled ? 'RED' : 'GREEN'} on '${m.rig.clause}' (${g.fails.length} FAIL: ${g.fails.slice(0, 3).join(', ')}) ${g.last.slice(0, 90)}`; }
    const skipped = unitKilled === null && noRig;   // a rig-only mutant under --no-rig cannot be judged: reported SKIPPED, never counted as a survivor
    const ok = skipped || ((unitKilled === null || unitKilled) && (rigKilled === null || rigKilled) && !(unitKilled === null && rigKilled === null));
    rows.push(`${skipped ? 'SKIPPED ' : ok ? 'KILLED  ' : 'SURVIVED'} ${m.id} — ${m.clause} — tests ${unitKilled === null ? 'n/a (rig-only)' : unitKilled ? `RED (${red.length}: ${red.slice(0, 2).join(' | ').slice(0, 110)})` : 'GREEN'}${rigNote}`);
    if (skipped) { /* not counted */ } else if (ok) killed++; else survived.push(m.id);
  } finally {
    restore(files);
    for (const f of files) if (sha(f) !== before[f]) { console.error(`FATAL: ${f} differs after restore`); process.exit(3); }
  }
  console.log(rows[rows.length - 1]);
}
if (!noRig && rows.some((r) => r.includes('rig['))) execFileSync('pnpm', ['run', 'build:bundles'], { cwd: REPO, stdio: 'ignore', timeout: 600000 }); // leave dist/ built from the RESTORED tree
const dirty = spawnSync('git', ['-C', REPO, 'diff', '--stat', '--', 'src', 'scripts']).stdout.toString().trim();
console.log(`TREE: ${dirty ? `DIRTY\n${dirty}` : 'clean (git diff empty) — every file byte-exact restored'}`);
const nSkipped = rows.filter((r) => r.startsWith('SKIPPED')).length;
console.log(`MUTATE-SDK-ONLY: ${survived.length ? 'FAIL' : 'PASS'} (${killed}/${rows.length - nSkipped} killed${nSkipped ? `, ${nSkipped} rig-only skipped (--no-rig)` : ''}${survived.length ? `; survived: ${survived.join(', ')}` : ''})`);
process.exit(survived.length || dirty ? 1 : 0);
