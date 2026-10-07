// #286 + #287 self-gate — IN-PLACE mutation sweep of Admission (starts + wakes). Each mutant edits ONE clause of the real source, runs the unit suites + the named arms of the
// end-to-end rigs (scripts/e2e-admission-hold.mjs, and `rig: 'wake'` = scripts/e2e-admission-wake.mjs: real workspaces/restart/admission/guard modules, fake memory source + recording seam), and must turn the
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
const SHD = SH;
const BW = 'src/main/bus-wake.ts';
const WR = 'src/main/wake-roster.ts';
const AW = 'src/main/admission-wake.ts';
const PQ = 'src/main/prompt-queue.ts';
const AH = 'src/main/api-handlers.ts';
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
  { id: 'A12_not_owed_still_run', file: AD, find: '      if (!stillOwedSafe(entry)) {', to: '      if (false) {', expect: ['not_owed_anymore_is_dropped_not_run'], arms: [] },
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
  { id: 'A23_no_boot_reconcile', file: AD, find: '  void singleton.kick(); // the reconcile: whatever is already queued meets a FRESH reading now (it samples; a still-held guard just waits)\n', to: '', expect: ['subscribe_then_reconcile'], arms: [] },
  // ── G3 review fix round (F1–F4) ──
  { id: 'R01_kick_body_sync', file: AD, find: '    draining = Promise.resolve()\n      .then(async () => {', to: '    draining = (async () => {', expect: ['own_sample_recovery_releases_one_at_a_time', 'rig:release_selfsample'], arms: ['release_selfsample'], extra: [{ file: AD, find: '          await pass();\n        } while (rerun);\n      })\n      .catch', to: '          await pass();\n        } while (rerun);\n      })()\n      .catch' }] },
  { id: 'R02_refused_blocks_the_line', file: AD, find: '          deferred.add(entry.wsId);\n', to: '          return arm();\n', expect: ['pause_refused_does_not_block_the_line', 'pause_refused_coordinator', 'rig:pause_other_run'], arms: ['pause_other_run'] },
  { id: 'R03_refused_entry_picked_again_same_pass', file: AD, find: '      const waiting = [...queue.values()].filter((e) => !deferred.has(e.wsId));', to: '      const waiting = [...queue.values()];', expect: ['pause_refused_does_not_block_the_line'], arms: [] },
  { id: 'R05_failure_not_told', file: AD, find: '        tell(entry, releaseFailureBody(entry.kind, entry.wsId, entry.since, failureText(outcome)));', to: '        void failureText;', expect: ['failed_release_is_reported_to_the_coordinator', 'rig:failed_release_reported'], arms: ['failed_release_reported'] },
  { id: 'R06_timeout_not_told', file: AD, find: '        tell(entry, releaseTimeoutBody(entry.kind, entry.wsId, entry.since, secs));', to: '        void secs;', expect: ['timed_out_release_is_reported'], arms: [] },
  { id: 'R07_report_throw_breaks_the_line', file: AD, find: '      entry.report?.(body);\n    } catch (e) {\n      deps.warn(`could not report the failed release of ${entry.wsId} to its coordinator`, e);\n    }', to: '      entry.report?.(body);\n    } finally {\n      void 0;\n    }', expect: ['failed_release_is_reported_to_the_coordinator'], arms: [] },
  { id: 'R08_drop_noop', file: AD, find: '      const had = queue.delete(wsId);', to: '      const had = false;', expect: ['drop_forgets_a_deleted_workspace', 'rig:deleted_while_held'], arms: ['deleted_while_held'] },
  { id: 'R09_drop_keeps_timer', file: AD, find: '      if (queue.size === 0) disarm();\n      return had;', to: '      return had;', expect: ['drop_forgets_a_deleted_workspace'], arms: [] },
  { id: 'R10_no_prune_on_read', file: AD, find: '    heldFor(wsId) {\n      pruneUnowed();', to: '    heldFor(wsId) {', expect: ['superseded_entry_is_pruned_at_read_time', 'rig:composer_drops_restart'], arms: ['composer_drops_restart'] },
  { id: 'R11_no_prune_in_list', file: AD, find: '    list() {\n      pruneUnowed();', to: '    list() {', expect: ['superseded_entry_is_pruned_by_list_alone'], arms: [] },
  { id: 'R12_no_prune_in_gate', file: AD, find: '      pruneUnowed(); // an entry a person already superseded', to: '      void 0; // an entry a person already superseded', expect: ['superseded_entry_is_pruned_by_gate_alone'], arms: [] },
  { id: 'R13_delete_does_not_drop', file: WS, find: '  dropHeldStart(id); // #286: a deleted workspace (single AND bulk delete)', to: '  void dropHeldStart; // #286: a deleted workspace (single AND bulk delete)', expect: ['F4 delete', 'rig:deleted_while_held'], arms: ['deleted_while_held'] },
  { id: 'R14_restart_owed_ignores_live', file: RS, find: 'return !!w && !w.archived && (liveAtHold || !(isRunning(id) || sdkSessionLive(id)));', to: 'return !!w && !w.archived;', expect: ['F4 composer', 'rig:composer_drops_restart'], arms: ['composer_drops_restart'] },
  { id: 'R15_roster_ignores_held', file: IX, find: " || livenessSilencedByAdmission(ws.id)));", to: "));", expect: ['F3 liveness'], arms: [] },
  { id: 'R16_spawn_gate_no_report', file: WS, find: '      report: (text) => reportAdmissionFailure(id, text),\n      stillOwed: () => {', to: '      stillOwed: () => {', expect: ['F4 report', 'rig:failed_release_reported'], arms: ['failed_release_reported'] },
  { id: 'R17_report_sent_as_status', file: WS, find: "kind: 'escalation', body: text });\n  log.info(`admission: told coordinator", to: "kind: 'status', body: text });\n  log.info(`admission: told coordinator", expect: ['F4 report', 'rig:failed_release_reported'], arms: ['failed_release_reported'] },
  { id: 'R18_report_body_changed', file: SHD, find: "It is not queued any more: retry it with", to: "retry it with", expect: ['release_failure_body', 'failed_release_is_reported_to_the_coordinator'], arms: ['failed_release_reported'] },
  // ── seat 2's gap list (c/6041378956) ──
  { id: 'B03_in_flight_never_cleared', file: AD, find: '        releasing.delete(entry.wsId);\n', to: '', expect: ['B03 in_flight_marker_is_cleared'], arms: [] },
  { id: 'B05_retry_ms', file: AD, find: 'export const ADMISSION_RETRY_MS = 10_000;', to: 'export const ADMISSION_RETRY_MS = 30_000;', expect: ['B05/B06/B07'], arms: [] },
  { id: 'B06_settle_ms', file: AD, find: 'export const ADMISSION_SETTLE_MS = 3_000;', to: 'export const ADMISSION_SETTLE_MS = 0;', expect: ['B05/B06/B07'], arms: [] },
  { id: 'B07_run_timeout', file: AD, find: 'export const ADMISSION_RUN_TIMEOUT_MS = 90_000;', to: 'export const ADMISSION_RUN_TIMEOUT_MS = 900_000;', expect: ['B05/B06/B07'], arms: [] },
  { id: 'B08_stop_keeps_queue', file: AD, find: '      disarm();\n      queue.clear();\n    },', to: '      disarm();\n    },', expect: ['B08 stopAdmission'], arms: [] },
  { id: 'B10_list_drops_coordinator', file: AD, find: 'return [...queue.values()].map(({ wsId, kind, seq: s, since, coordinator }) => ({ wsId, kind, seq: s, since, coordinator }));', to: 'return [...queue.values()].map(({ wsId, kind, seq: s, since }) => ({ wsId, kind, seq: s, since, coordinator: false }));', expect: ['B10 list()'], arms: [] },
  { id: 'B15_repeat_keeps_old_stillowed', file: AD, find: '        entry.stillOwed = a.stillOwed;\n', to: '', expect: ['B15 a repeat request'], arms: [] },
  { id: 'B16_in_flight_new_since', file: AD, find: 'return { held: true, since: inFlight.since, kind: inFlight.kind };', to: 'return { held: true, since: deps.now(), kind: inFlight.kind };', expect: ['repeat_auto_request_during_release'], arms: [] },
  { id: 'B17_restart_owed_always_true', file: RS, find: 'return !!w && !w.archived && (liveAtHold || !(isRunning(id) || sdkSessionLive(id)));', to: 'return true;', expect: ['rig:archived_while_held', 'rig:composer_drops_restart'], arms: ['archived_while_held', 'composer_drops_restart'] },
  { id: 'B17b_restart_owed_ignores_archived', file: RS, find: 'return !!w && !w.archived && (liveAtHold ||', to: 'return !!w && (liveAtHold ||', expect: ['rig:archived_while_held'], arms: ['archived_while_held'] },
  { id: 'B18_spawn_owed_ignores_live_session', file: WS, find: 'return !!w && !w.archived && owesOpeningTask(w) && !sdkSessionLive(id) && !isRunning(id);', to: 'return !!w && !w.archived && owesOpeningTask(w) && !isRunning(id);', expect: ['rig:composer_drops_spawn'], arms: ['composer_drops_spawn'] },
  { id: 'B18b_spawn_owed_ignores_running_pty', file: WS, find: 'owesOpeningTask(w) && !sdkSessionLive(id) && !isRunning(id);', to: 'owesOpeningTask(w) && !sdkSessionLive(id);', expect: ['spawn stillOwed'], arms: [] },
  // ── #286 leftovers (review r2 N1 L1 T1; seat 2 F1-F4) ──
  { id: 'N01_queued_counts_paused', file: AD, find: 'queued: [...queue.values()].some((e) => !e.paused) })) {', to: 'queued: queue.size > 0 })) {', expect: ['N1 paused_entry_is_not_a_line', 'pause_refused_does_not_block_the_line'], arms: [] },
  { id: 'N02_paused_never_set', file: AD, find: '          entry.paused = true;\n', to: '', expect: ['N1 paused_entry_is_not_a_line'], arms: [] },
  { id: 'L01_releasing_window_dropped', file: AD, find: '      return releasing.get(wsId) ?? null;', to: '      return null;', expect: ['L1 releasing_window_keeps_the_marker', 'F3 + L1', 'facade livenessSilencedByAdmission'], arms: [] },
  { id: 'L02_predicate_inverted', file: AD, find: 'return singleton.heldFor(wsId) !== null;', to: 'return singleton.heldFor(wsId) === null;', expect: ['facade livenessSilencedByAdmission', 'F3 + L1'], arms: [] },
  { id: 'T01_timeout_told_as_failure', file: AD, find: 'tell(entry, releaseTimeoutBody(entry.kind, entry.wsId, entry.since, secs));', to: "tell(entry, releaseFailureBody(entry.kind, entry.wsId, entry.since, `did not settle within ${secs} s`));", expect: ['timed_out_release_is_reported'], arms: [] },
  { id: 'T02_timeout_body_says_did_not_start', file: SHD, find: 'it may still be starting. Check', to: 'it did NOT start. Check', expect: ['T1 release_timeout_body', 'timed_out_release_is_reported'], arms: [] },
  { id: 'F201_report_ignores_switch', file: SHD, find: "  if (!a.switchOn) return { action: 'skip', why: 'switch-off' };\n", to: '', expect: ['F2 decide_admission_report'], arms: [] },
  { id: 'F202_report_ignores_bus', file: SHD, find: "  if (!a.hasBus) return { action: 'skip', why: 'no-bus' };\n", to: '', expect: ['F2 decide_admission_report'], arms: [] },
  { id: 'F203_report_ignores_archived_coordinator', file: SHD, find: "  if (!a.hasMember || !a.coordinatorLive) return { action: 'skip', why: 'no-coordinator' };", to: "  if (!a.hasMember) return { action: 'skip', why: 'no-coordinator' };", expect: ['F2 decide_admission_report'], arms: [] },
  { id: 'F204_report_wiring_bypasses_decision', file: WS, find: "  const d = decideAdmissionReport({ hasMember: !!ws, coordinatorLive: !!parent && !parent.archived, hasBus: !!db, switchOn: on });", to: "  const d = decideAdmissionReport({ hasMember: !!ws, coordinatorLive: !!parent && !parent.archived, hasBus: !!db, switchOn: true });", expect: ['F4 report'], arms: [] },
  { id: 'F301_label_ignores_branch', file: SHD, find: 'return w ? (w.name ?? w.branch ?? wsId) : wsId;', to: 'return w ? (w.name ?? wsId) : wsId;', expect: ['F3 held_start_label'], arms: [] },
  { id: 'F302_busstatus_label_inline', file: HK, find: 'label: heldStartLabel(w, h.wsId),', to: 'label: h.wsId,', expect: ['F1 the restart reply carries its note'], arms: [] },
  { id: 'F101_restart_reply_loses_note', file: RS, find: "if (gate.held) return { ok: true, held: { since: gate.since }, note: heldPhrase('restart', gate.since) };", to: "if (gate.held) return { ok: true, held: { since: gate.since } };", expect: ['F1 the restart reply carries its note', 'rig:restart_waits'], arms: ['restart_waits'] },
  { id: 'F102_cli_prints_normal_line', file: CL, find: 'process.stdout.write(`${formatRestartHeldReply(target, res.note)}\\n`);', to: 'process.stdout.write(`Restarted ${target} (conversation preserved)\\n`);', expect: ['F1 the restart reply carries its note'], arms: [] },
  { id: 'F103_restart_held_text', file: SHD, find: 'return `Restart of ${target} accepted — ${note}`;', to: 'return `Restarted ${target} — ${note}`;', expect: ['F1 restart_held_reply'], arms: [] },
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
  // ── #287 Admission for WAKES — `rig: 'wake'` runs scripts/e2e-admission-wake.mjs ──
  { id: 'W01_wake_ranks_with_starts', file: SH, find: "return kind === 'wake' ? 1 : 2;", to: 'return 2;', expect: ['W6 a held SPAWN/RESTART covers a wake', 'W7 a real start supersedes'], arms: [] },
  { id: 'W02_live_member_held', file: AD, find: 'if (!a.fleetMember || !a.sleeping) return { held: false };', to: 'if (!a.fleetMember) return { held: false };', expect: ['W2 never held'], arms: [] },
  { id: 'W03_non_fleet_held', file: AD, find: 'if (!a.fleetMember || !a.sleeping) return { held: false };', to: 'if (!a.sleeping) return { held: false };', expect: ['W2 never held'], arms: [] },
  { id: 'W04_permit_not_consumed', file: AD, find: 'if (permits.delete(a.wsId)) return { held: false };', to: 'if (false) return { held: false };', expect: ['W3 release'], arms: [] },
  { id: 'W06_permit_not_revoked', file: AD, find: '            permits.delete(a.wsId); // never leave a stale permit that could bypass a LATER hold\n', to: '', expect: ['W4 an unconsumed permit is revoked'], arms: [] },
  { id: 'W07_permit_not_granted', file: AD, find: '          permits.add(a.wsId);\n', to: '', expect: ['W3 release', 'rig:wake_release'], arms: ['wake_release'], rig: 'wake' },
  { id: 'W09_wake_coordinator_flag_dropped', file: AD, find: "        coordinator: a.coordinator,\n        stillOwed: a.stillOwed,\n        report: a.report,\n        run: async () => {", to: "        coordinator: false,\n        stillOwed: a.stillOwed,\n        report: a.report,\n        run: async () => {", expect: ['W5 order'], arms: [] },
  { id: 'W10_wake_not_a_fleet_member_in_gate', file: AD, find: "ws: { parentId: 'fleet' },", to: 'ws: {},', expect: ['W1 baseline'], arms: [] },
  { id: 'W11_sweep_hold_removed', file: BW, find: "if (action.kind === 'fire' && entry?.fleetMember === true && entry.sleeping === true) {", to: 'if (false) {', expect: ['#287 bus-wake', 'rig:wake_held'], arms: ['wake_held', 'wake_release'], rig: 'wake' },
  { id: 'W12_sweep_holds_live_member', file: BW, find: "if (action.kind === 'fire' && entry?.fleetMember === true && entry.sleeping === true) {", to: "if (action.kind === 'fire' && entry?.fleetMember === true) {", expect: ['rig:wake_live_passes'], arms: ['wake_live_passes'], rig: 'wake' },
  { id: 'W12b_sweep_holds_non_fleet', file: BW, find: "if (action.kind === 'fire' && entry?.fleetMember === true && entry.sleeping === true) {", to: "if (action.kind === 'fire' && entry?.sleeping === true) {", expect: ['rig:wake_non_fleet_passes'], arms: ['wake_non_fleet_passes'], rig: 'wake' },
  { id: 'W13_held_branch_falls_through', file: BW, find: "          logWakeableTransition(reader, 'held-for-memory');\n          continue;", to: "          logWakeableTransition(reader, 'held-for-memory');", expect: ['#287 bus-wake', 'rig:wake_held'], arms: ['wake_held'], rig: 'wake' },
  { id: 'W14_release_sweep_not_guaranteed', file: BW, find: 'retry: () => sweepBusWakeNow(),', to: 'retry: () => sweepBusWake(),', expect: ['#287 bus-wake'], arms: [] },
  { id: 'W15_sweep_still_owed_always', file: BW, find: 'stillOwed: () => readRoster().some((r) => r.reader === reader && r.wakeable && r.sleeping === true),', to: 'stillOwed: () => true,', expect: ['rig:wake_human_drops'], arms: ['wake_human_drops'], rig: 'wake' },
  { id: 'W16_held_logged_every_sweep', file: BW, find: "          logWakeableTransition(reader, 'held-for-memory');\n", to: "          log.info(`bus-wake: ${reader} is PENDING and its réveil is HELD for memory (Admission) — again`);\n", expect: ['rig:wake_held'], arms: ['wake_held'], rig: 'wake' },
  { id: 'W17_sweep_coordinator_flag_dropped', file: BW, find: 'coordinator: entry.coordinator === true,', to: 'coordinator: false,', expect: ['rig:wake_order'], arms: ['wake_order'], rig: 'wake' },
  { id: 'W19_roster_not_fleet', file: WR, find: 'fleetMember: !!ws.parentId,', to: 'fleetMember: false,', expect: ['#287 roster', 'rig:wake_held'], arms: ['wake_held'], rig: 'wake' },
  { id: 'W19b_roster_all_fleet', file: WR, find: 'fleetMember: !!ws.parentId,', to: 'fleetMember: true,', expect: ['#287 roster', 'rig:wake_non_fleet_passes'], arms: ['wake_non_fleet_passes'], rig: 'wake' },
  { id: 'W20_roster_ignores_sdk_session', file: WR, find: 'sleeping: !isRunning(ws.id) && !sdkSessionLive(ws.id),', to: 'sleeping: !isRunning(ws.id),', expect: ['#287 roster', 'rig:wake_live_passes'], arms: ['wake_live_passes'], rig: 'wake' },
  { id: 'W21_roster_coordinator_dropped', file: WR, find: 'coordinator: canOrchestrate(ws),', to: 'coordinator: false,', expect: ['#287 roster', 'rig:wake_order'], arms: ['wake_order'], rig: 'wake' },
  { id: 'W22_sleeping_ignores_sdk_session', file: AW, find: 'return !isRunning(id) && !sdkSessionLive(id);', to: 'return !isRunning(id);', expect: ['#287 admission-wake'], arms: [] },
  { id: 'W23_wake_wrapper_all_fleet', file: AW, find: 'fleetMember: !!ws.parentId,', to: 'fleetMember: true,', expect: ['#287 admission-wake'], arms: [] },
  { id: 'W24_flush_hold_removed', file: PQ, find: '    !opts.force &&\n    wakeHeldForMemory(ws, () => flushQueuedPrompts(id), {', to: '    false &&\n    wakeHeldForMemory(ws, () => flushQueuedPrompts(id), {', expect: ['#287 prompt-queue', 'rig:flush_held'], arms: ['flush_held'], rig: 'wake' },
  { id: 'W25_send_now_held_too', file: PQ, find: '    !opts.force &&\n    wakeHeldForMemory(ws, () => flushQueuedPrompts(id), {', to: '    wakeHeldForMemory(ws, () => flushQueuedPrompts(id), {', expect: ['#287 prompt-queue', 'rig:flush_held'], arms: ['flush_held'], rig: 'wake' },
  { id: 'W26_flush_still_owed_always', file: PQ, find: 'return !!w && !w.archived && (w.queuedPrompts ?? []).length > 0 && isSleeping(id);', to: 'return true;', expect: ['rig:flush_held'], arms: ['flush_held'], rig: 'wake' },
  { id: 'W27_resume_hold_removed', file: PQ, find: "      action === 'nudge' &&\n      wakeHeldForMemory(ws, () => resumeUsageLimited(Date.now()), {", to: "      false &&\n      wakeHeldForMemory(ws, () => resumeUsageLimited(Date.now()), {", expect: ['#287 prompt-queue', 'rig:resume_held'], arms: ['resume_held'], rig: 'wake' },
  { id: 'W28_resume_hold_before_wait', file: PQ, find: "      action === 'nudge' &&\n      wakeHeldForMemory(ws, () => resumeUsageLimited(Date.now()), {", to: "      wakeHeldForMemory(ws, () => resumeUsageLimited(Date.now()), {", expect: ['#287 prompt-queue'], arms: [] },
  { id: 'W29_message_hold_removed', file: WS, find: 'if (wakeHeldForMemory(target, () => wakeHeldMessageTarget(input.to))) {', to: 'if (false && wakeHeldForMemory(target, () => wakeHeldMessageTarget(input.to))) {', expect: ['#287 peer message', 'rig:message_held'], arms: ['message_held'], rig: 'wake' },
  { id: 'W30_failed_park_keeps_hold', file: WS, find: '    dropHeldStart(input.to); // nothing parked → nothing to wake it for', to: '    void dropHeldStart; // nothing parked → nothing to wake it for', expect: ['#287 peer message'], arms: [] },
  { id: 'W31_message_reply_claims_started', file: WS, find: "if (await queueInbox(input.to, body)) return { ok: true, delivery: 'inbox', branch: target.branch };\n    dropHeldStart", to: "if (await queueInbox(input.to, body)) return { ok: true, delivery: 'started', branch: target.branch };\n    dropHeldStart", expect: ['rig:message_held'], arms: ['message_held'], rig: 'wake' },
  { id: 'W32_message_block_never_released', file: WS, find: "  await releaseAllInboxBlocks(id, 'auto').catch((e) => log.warn(`held message wake: parked re-release failed for ${id}`, e));", to: '  void releaseAllInboxBlocks;', expect: ['rig:message_held'], arms: ['message_held'], rig: 'wake' },
  { id: 'W35_recovery_hold_removed', file: AH, find: 'if (w && (w.sdkPendingPrompts ?? []).length > 0 && wakeHeldForMemory(w, recoverNow)) return;', to: 'if (false && w && (w.sdkPendingPrompts ?? []).length > 0 && wakeHeldForMemory(w, recoverNow)) return;', expect: ['#287 recovery'], arms: [] },
];

const TESTS = ['src/shared/admission.test.ts', 'src/main/admission.test.ts', 'src/main/admission-wiring.test.ts', 'src/main/memory-guard-wiring.test.ts', 'src/main/admission-liveness.test.ts'];
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(path.join(REPO, f))).digest('hex');
const sh = (cmd, a, opts = {}) => spawnSync(cmd, a, { cwd: REPO, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 300_000, ...opts });

function unitRed() {
  const r = sh(process.execPath, ['--test', '--experimental-strip-types', ...TESTS]);
  const names = [...(r.stdout ?? '').matchAll(/^not ok \d+ - (.*)$/gm)].map((m) => m[1]);
  const pass = Number(/^# pass (\d+)/m.exec(r.stdout ?? '')?.[1] ?? NaN);
  const skipped = Number(/^# skipped (\d+)/m.exec(r.stdout ?? '')?.[1] ?? NaN);
  return { names, pass, skipped, status: r.status };
}
const RIGS = { hold: ['e2e-admission-hold.mjs', 'ADMISSION RIG'], wake: ['e2e-admission-wake.mjs', 'ADMISSION-WAKE RIG'] };
function rigRed(arms, which = 'hold') {
  if (noRig) return { arms: [], pass: 0, line: '(rig skipped)' };
  const [script, summary] = RIGS[which];
  const env = { ...process.env, ...(arms && arms.length ? { RIG_ARMS: arms.join(',') } : {}) };
  const r = sh(process.execPath, ['--experimental-strip-types', '--import', pathToFileURL(path.join(HERE, '.r2-register.mjs')).href, path.join(HERE, script)], { env });
  const out = r.stdout ?? '';
  return { arms: [...out.matchAll(/^FAIL (\w+)/gm)].map((m) => m[1]), pass: (out.match(/^PASS \w+/gm) ?? []).length, line: (out.split('\n').filter((l) => l.startsWith(summary)).pop() ?? `no summary (exit ${r.status})`) };
}
const buildCli = () => { const r = sh('pnpm', ['run', 'build:cli']); if (r.status !== 0) throw new Error(`build:cli failed: ${r.stderr}`); };

if (args.includes('--check-anchors')) { // dry check: does every mutant's find resolve exactly once on the CURRENT sources? (no mutation, no run)
  let bad = 0;
  for (const m of MUTANTS) {
    let text = fs.readFileSync(path.join(REPO, m.file), 'utf8'); let why = null;
    for (const e of m.edits ?? [...(m.pre ?? []), { find: m.find, to: m.to }, ...(m.extra ?? [])]) { const c = text.split(e.find).length - 1; if (c !== 1) { why = `${c}× ${e.find.slice(0, 70)}`; break; } text = text.replace(e.find, () => e.to); }
    if (why) { bad++; console.log(`ANCHOR-BAD ${m.id}: ${why}`); }
  }
  console.log(`ANCHORS: ${MUTANTS.length - bad}/${MUTANTS.length} resolve exactly once`);
  process.exit(bad ? 1 : 0);
}

// ── guard: the tree must be committed (git diff is the independent restoration proof) ──
const files = [...new Set(MUTANTS.map((m) => m.file))];
const dirty = sh('git', ['diff', '--quiet', '--', ...files, ...TESTS, 'scripts/e2e-admission-hold.mjs', 'scripts/e2e-admission-wake.mjs', 'scripts/admission-mutants.mjs']).status !== 0;
if (dirty) { console.error('REFUSING: the mutated files / suites / rig have uncommitted changes — commit first (the end-of-sweep `git diff` must prove restoration)'); process.exit(2); }
const before = Object.fromEntries(files.map((f) => [f, sha(f)]));
buildCli();

// ── POSITIVE CONTROL: the unmutated tree must be all green, else every "killed" below is vacuous ──
const base = unitRed();
const baseRig = rigRed();
const baseWake = rigRed(null, 'wake');
console.log(`BASELINE unit: pass ${base.pass} fail ${base.names.length} skipped ${base.skipped} | rig: ${baseRig.line} | wake rig: ${baseWake.line}`);
if (base.names.length || base.status !== 0 || base.skipped !== 0 || baseRig.arms.length || baseWake.arms.length || (!noRig && (baseRig.pass !== 17 || baseWake.pass !== 12))) { console.error('BASELINE NOT GREEN — aborting (nothing was mutated)'); process.exit(3); }

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
  const edits = m.edits ?? [...(m.pre ?? []), { find: m.find, to: m.to }, ...(m.extra ?? [])];
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
    const r = m.arms && m.arms.length === 0 ? { arms: [] } : rigRed(m.arms, m.rig ?? 'hold');
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
const postWake = rigRed(null, 'wake');
for (const r of rows) console.log(`${r.verdict.padEnd(30)} ${r.id.padEnd(30)} ${r.detail}`);
const killed = rows.filter((r) => r.verdict === 'KILLED').length;
console.log(`RESTORED: sha-identical ${sameSha} · git diff clean ${gitClean} · cmp-restore ${!restoreBad} · post-sweep unit fail ${post.names.length} rig ${postRig.line} · wake rig ${postWake.line}`);
console.log(`MUTANTS: ${killed}/${rows.length} killed by their NAMED arm${rows.length === killed ? '' : ` — NOT ALL: ${rows.filter((r) => r.verdict !== 'KILLED').map((r) => `${r.id}=${r.verdict}`).join(', ')}`}`);
process.exit(rows.length === killed && sameSha && gitClean && !restoreBad && post.names.length === 0 && postRig.arms.length === 0 && postWake.arms.length === 0 ? 0 : 1);
