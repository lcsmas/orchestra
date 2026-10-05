// Load-time MUTANTS of the shipped pause-trap source (#252 D1b G2) — same mechanism as
// scripts/session-budget/mutants.mjs: the source text is rewritten as node loads it (nothing on disk,
// nothing to restore). Every anchor must match EXACTLY ONCE or the run throws PATTERN-GONE.

/** name -> { file suffix, find (global regex), replace, mustRedden (the rig check that has to go red) } */
export const MUTANTS = {
  // V-F1: a tracked, alive, unanswering keeper reads as NONE (idle): the member is confirmed host-idle while its turn may be running.
  'keeper-unknown-is-none': {
    file: '/src/shared/pause-douce.ts',
    find: /  return i\.keeperPidState === 'keeper' \|\| i\.keeperPidState === 'unknown';/g,
    replace: '  return false;',
    mustRedden: 'keeper_stopped_member_not_confirmed_idle',
  },
  // follow-up R1-2: a human mark made in the waiting window still admits the first CLI-started turn AFTER the escalation (its notBefore is the pause, not the escalation).
  'mark-left-in-pausing': {
    file: '/src/main/pause-trap.ts',
    find: /    const marked = consumeHumanMark\(m\.wsId, deps\.now\(\), since\);/g,
    replace: '    const marked = consumeHumanMark(m.wsId, deps.now(), carrier.pausedAt);',
    mustRedden: 'human_mark_spent_cli_turn_trapped_after_escalation',
  },
  // The hook lets a SUBAGENT's tool call take the order (the member's own next boundary never sees it).
  'subagent-takes-order': {
    file: '/src/main/workspaces.ts',
    find: /        \*'"agent_id"'\*\) ;;\n/g,
    replace: '',
    mustRedden: 'subagent_calls_never_took_the_order_msb',
  },
  // ── #254 Pause douce (each edits the shipped host code in memory; the named douce-arm check must go red) ──
  // The 3-min deadline never escalates: a member that never answers is waited on for ever.
  'no-deadline-escalation': {
    file: '/src/main/pause-douce.ts',
    find: /  if \(allConfirmed \|\| now >= deadline\) \{/g,
    replace: '  if (allConfirmed) {',
    mustRedden: 'straggler_not_cut_short_then_escalated_at_deadline',
  },
  // The accusé COUNT: escalates as soon as ANY member confirmed (instead of ALL): a straggler is cut short.
  'escalate-on-any-confirm': {
    file: '/src/main/pause-douce.ts',
    find: /const allConfirmed = members\.length > 0 && sum\.confirmed === members\.length;/g,
    replace: 'const allConfirmed = members.length > 0 && sum.confirmed > 0;',
    mustRedden: 'straggler_not_cut_short_then_escalated_at_deadline',
  },
  // The trap is owed at once for a douce too (trapOwed ignores the escalation): stragglers are taken before the deadline.
  'trap-owed-before-escalation': {
    file: '/src/main/bus-pause.ts',
    find: /        trapOwed\(\{\n          pausedAt: r\.pausedAt,/g,
    replace: '        ((_c: unknown) => r.trapAt === null)({\n          pausedAt: r.pausedAt,',
    mustRedden: 'trap_not_started_before_escalation',
  },
  // The host sends the pause row but drops the order the member's tool-result hook injects: nobody ever sees the Pause.
  'no-order-file': {
    file: '/src/main/pause-douce.ts',
    find: /        deps\.pauseOrders\?\.write\(m\.wsId, text\); \/\/ the order file first[^\n]*\n/g,
    replace: '        /* mutant: order not written */\n',
    mustRedden: 'order_delivered_at_tool_boundary_mid',
  },
  // Every member is read as idle: confirmed `host-idle` without ever being told (a running turn is never notified).
  'host-idle-for-running': {
    file: '/src/main/pause-douce.ts',
    find: /      const act = await deps\.activityOf\(m\);\n      running = act\.turnRunning \|\| act\.unknown === true;/g,
    replace: '      await deps.activityOf(m);\n      running = false;',
    mustRedden: 'order_delivered_at_tool_boundary_mid',
  },
  // bus-status counts every roster row as "en pause": the N/M line lies.
  'summary-counts-all': {
    file: '/src/shared/pause-lifecycle.ts',
    find: /    done: rows\.filter\(isDone\)\.length,/g,
    replace: '    done: rows.length,',
    mustRedden: 'bus_status_names_who_is_missing',
  },
  // The trap never records the members it took: a straggler stays "not confirmed" in the roster for ever.
  'no-trap-roster': {
    file: '/src/main/pause-trap.ts',
    find: /            confirmByTrap\(db, carrier, m, deps\.now\(\)\); \/\/ #254: taken by the host = paused \(a member that already confirmed keeps its own accusé\)/g,
    replace: '            /* mutant: trap not recorded */',
    mustRedden: 'roster_accusés_by_kind',
  },
  // The douce sweep ignores the frozen `pause` switch: a stale soft pause on an OFF run is acted on.
  'sweep-ignores-switch': {
    file: '/src/main/pause-douce.ts',
    find: /\.pause === true\)\n    \.map\(\(r\) => \(\{\n      runId: String\(r\.id\),\n      pausedAt: Number\(r\.paused_at\),\n      pausedBy: \(r\.paused_by as string \| null\) \?\? null,\n      mode: 'soft',/g,
    replace: ".pause === true || true)\n    .map((r) => ({\n      runId: String(r.id),\n      pausedAt: Number(r.paused_at),\n      pausedBy: (r.paused_by as string | null) ?? null,\n      mode: 'soft',",
    mustRedden: 'off_host_inert_on_a_stale_soft_pause',
  },
  // The UNFIXED build (G1): master has no host trap at all — `startPauseTrap` does nothing, so a pause is only a bus row.
  'no-trap': {
    file: '/src/main/pause-trap.ts',
    find: /export function startPauseTrap\(deps: TrapDeps\): void \{\n  if \(timer\) return;/g,
    replace: 'export function startPauseTrap(deps: TrapDeps): void {\n  if (timer || true) return;',
    mustRedden: 'no_surviving_tool_procs',
  },
  // CLI killed: the killer also signals the CLI at the end of its run.
  'kill-cli': {
    file: '/src/main/pause-kill.ts',
    find: /(  const finalPlan = planNow\(\);\n)/g,
    replace: "  deps.signal(cli.pid, 'SIGTERM');\n$1",
    mustRedden: 'cli_and_keeper_alive',
  },
  // Keeper killed.
  'kill-keeper': {
    file: '/src/main/pause-kill.ts',
    find: /(  const finalPlan = planNow\(\);\n)/g,
    replace: "  if (keeperPid) deps.signal(keeperPid, 'SIGTERM');\n$1",
    mustRedden: 'cli_and_keeper_alive',
  },
  // Snapshot touches the REAL index: `git add -A` without the temporary GIT_INDEX_FILE.
  'snapshot-touches-index': {
    file: '/src/main/pause-snapshot.ts',
    find: /return git\(cwd, \['add', '-A', '--ignore-errors', '--', \.\.\.argv\], env, undefined, \[1\], timeoutMs\);/g,
    replace: "return git(cwd, ['add', '-A', '--ignore-errors', '--', ...argv], {}, undefined, [1], timeoutMs);",
    mustRedden: 'snapshot_no_touch',
  },
  // The trap never kills (interrupt + snapshot only).
  'skip-kill': {
    file: '/src/main/pause-trap.ts',
    find: /const rep = await deps\.killTrees\(target\.cli, target\.keeperPid, \{\n        stillPaused: \(\) => stillPaused\(db, carrier\),/g,
    replace: "const rep = await (async (_a: unknown, _b: unknown, _o: unknown) => ({ cliPid: target.cli.pid, killed: [] as never[], refused: [] as never[], spared: [] as never[], survivors: [] as never[], rounds: 0 }))(target.cli, target.keeperPid, {\n        stillPaused: () => stillPaused(db, carrier),",
    mustRedden: 'trap_killed_what_survives_an_interrupt', // (also reddens no_surviving_tool_procs on the background arm)
  },
  // The trap never snapshots.
  'skip-snapshot': {
    file: '/src/main/pause-trap.ts',
    find: /const r = await deps\.snapshot\(\{ worktreePath: m\.worktreePath, runId: carrier\.runId, wsId: m\.wsId, at: deps\.now\(\) \}\);/g,
    replace: "throw new Error('mutant: snapshot skipped'); const r = await deps.snapshot({ worktreePath: m.worktreePath, runId: carrier.runId, wsId: m.wsId, at: deps.now() });",
    mustRedden: 'pause_ref_holds_uncommitted_work',
  },
  // Idle detached keepers are never re-armed (attached): a CLI-started turn after an app restart runs unobserved (row 29 after a restart).
  'no-arm': {
    file: '/src/main/pause-trap-host.ts',
    find: /      await sdkAttachIfDetached\(m\.wsId\);\n    \},/g,
    replace: '      /* mutant: never attach */\n    },',
    mustRedden: 'turn_while_paused_interrupted',
  },
  // The pause interrupt clears the app-side queue (the plain user Stop button's behaviour): a queued prompt is lost.
  'drop-queue-on-pause-interrupt': {
    file: '/src/main/agent-sdk.ts',
    find: /    await session\.q\.interrupt\(\); \/\/ plain interrupt: no cancel_queued, no queue clearing/g,
    replace: '    await interruptCancellingQueued(session);',
    mustRedden: 'queued_prompt_survives_pause',
  },
  // F1: the supervisor guard removed ENTIRELY (planner AND signal-time re-read, descendant AND ancestor walks — layers cover each other).
  'supervisor-guard-removed': {
    file: '/src/shared/pause-procs.ts',
    edits: [
      { find: /    if \(via !== 'tree' && \(hasSupervisor\(p\.pid\) \|\| supervisorAncestorOf\(p, \(pid\) => byPid\.get\(pid\) \?\? 'gone', cli\.pid\) !== 'no'\)\) \{/g, replace: '    if (false) {' },
      { find: /  if \(target\.via !== 'tree' && isSupervisorProc\(fresh\)\) return \{ ok: false, reason: 'supervisor \(keeper \/ claude CLI \/ Orchestra app of another session\)' \};\n/g, replace: '' },
      { find: /  if \(target\.via !== 'tree' && supervisorAncestorOf\(fresh, read, plan\.cli\.pid\) !== 'no'\) return \{[^\n]*\n/g, replace: '' },
    ],
    mustRedden: 'other_session_supervisor_survives',
  },
  // Pre-review M1: only the ANCESTOR walk removed (planner AND signal-time): the foreign CLI's MCP server (a child of a spared claude) is killed.
  'supervisor-ancestor-removed': {
    file: '/src/shared/pause-procs.ts',
    edits: [
      { find: /\(hasSupervisor\(p\.pid\) \|\| supervisorAncestorOf\(p, \(pid\) => byPid\.get\(pid\) \?\? 'gone', cli\.pid\) !== 'no'\)/g, replace: 'hasSupervisor(p.pid)' },
      { find: /  if \(target\.via !== 'tree' && supervisorAncestorOf\(fresh, read, plan\.cli\.pid\) !== 'no'\) return \{[^\n]*\n/g, replace: '' },
    ],
    mustRedden: 'other_session_mcp_survives',
  },
  // The pauser exemption removed: the coordinator that pauses its own run is interrupted + its tools killed.
  'no-pauser-exemption': {
    file: '/src/main/pause-trap.ts',
    find: /  const pauser = spareRoot !== undefined;/g,
    replace: '  const pauser = false;',
    mustRedden: 'pauser_keeps_its_call_tree',
  },
  // D11: the env provenance matches ANY CLAUDE_PID (planner AND signal-time re-read — two layers cover each other, so both are edited).
  'env-pid-not-matched': {
    file: '/src/shared/pause-procs.ts',
    edits: [
      { find: /      if \(opts\.claudePidOf\(p\) !== cli\.pid\) continue;/g, replace: "      if (opts.claudePidOf(p) === null) continue;" },
      { find: /  if \(env === plan\.cli\.pid && fresh\.startTicks > plan\.cli\.startTicks\) \{/g, replace: '  if (env !== null && fresh.startTicks > plan.cli.startTicks) {' },
    ],
    mustRedden: 'other_member_orphan_survives',
  },
  // D11: the env provenance ignores the CLI's START-TIME (a bare pid match): planner AND re-read.
  'env-start-time-ignored': {
    file: '/src/shared/pause-procs.ts',
    edits: [
      { find: / \|\| p\.startTicks <= cli\.startTicks\) continue;/g, replace: ') continue;' },
      { find: /  if \(env === plan\.cli\.pid && fresh\.startTicks > plan\.cli\.startTicks\) \{/g, replace: '  if (env === plan.cli.pid) {' },
    ],
    mustRedden: 'stale_orphan_before_cli_survives',
  },
  // The old rule: the pauser is whoever's ws id equals `paused_by` (`--as`), which a human typing in a plain shell also is (review F5).
  'exempt-by-handle': {
    file: '/src/main/pause-trap.ts',
    find: /  const pauser = spareRoot !== undefined;/g,
    replace: '  const pauser = spareRoot !== undefined || (carrier.pausedBy !== null && carrier.pausedBy.trim().toLowerCase() === m.wsId.trim().toLowerCase());',
    mustRedden: 'human_as_coordinator_is_not_exempt',
  },
  // UNKNOWN recorded as NONE (review F4): an unprovable/unresponsive member no longer keeps the trap open — it is stamped done anyway.
  'stamp-on-unknown': {
    file: '/src/main/pause-trap.ts',
    edits: [
      { find: /  return incomplete \? 'incomplete' : 'complete';/g, replace: "  return 'complete';" },
    ],
    mustRedden: 'trap_not_stamped_while_keeper_unresponsive',
  },
  // The signal-time identity re-read removed: a recycled pid is signalled (real pid reuse: recycle-rig.mjs).
  'identity-reread-removed': {
    file: '/src/shared/pause-procs.ts',
    find: /  if \(fresh\.startTicks !== target\.startTicks\) return \{ ok: false, reason: 'reused \(start-time changed\)' \};\n/g,
    replace: '',
    mustRedden: 'innocent_inheritor_survives',
  },
  // #282: the trap never asks the CLI to stop a background task (stopTask unwired): the task dies by SIGTERM and the CLI starts a task-notification turn by itself.
  'no-stop-task': {
    file: '/src/main/pause-trap-host.ts',
    find: /    stopTask: \(m, taskId\) => stopWithin\(/g,
    replace: '    stopTask: undefined as never, __stopTaskUnused: (m: { wsId: string }, taskId: string) => stopWithin(',
    mustRedden: 'no_model_request_while_paused',
  },
  // #282: the stop_task requests are made AFTER the signal rounds (the order is the fix: a task the CLI did not stop itself is notified when its process exits).
  'stop-task-after-signals': {
    file: '/src/main/pause-kill.ts',
    edits: [
      { find: /    const asked = await stopRoots\(plan\);\n    let signalled = 0;/g, replace: '    const asked = 0;\n    let signalled = 0;' },
      { find: /    await waitUntilGone\(termed, deps, 500\);\n/g, replace: '    await waitUntilGone(termed, deps, 500);\n    await stopRoots(plan);\n' },
    ],
    mustRedden: 'no_model_request_while_paused',
  },
  // #282 review R1: the `(deleted)` suffix of an unlinked task output file is not matched — the link is lost, the SIGTERM path starts the task-notification turn.
  'deleted-link-unmatched': {
    file: '/src/main/pause-kill.ts',
    find: /\.output\(\?: \\\(deleted\\\)\)\?\$\/;/g,
    replace: '.output$/;',
    mustRedden: 'no_model_request_while_paused',
  },
  // #282 review R2: the stop_task request is NOT bounded — a wedged CLI hangs the trap for ever.
  'no-stop-timeout': {
    file: '/src/main/pause-kill.ts',
    find: /    return await Promise\.race\(\[req, new Promise<StopTaskResult>\(\(resolve\) => \{ t = setTimeout\(\(\) => resolve\(\{ ok: false, note: `sdk stop_task timed out after \$\{ms\} ms` \}\), ms\); \}\)\]\);/g,
    replace: '    return await req;',
    mustRedden: 'trap_finished',
  },
  // The turn-start observer is never registered (rows 29/30).
  'no-turn-observer': {
    file: '/src/main/pause-trap-host.ts',
    find: /void onTurnStart\(deps, toMember\(ws\)\)/g,
    replace: "void Promise.resolve('allowed')",
    mustRedden: 'turn_while_paused_interrupted',
  },
};

let active = null;
export async function initialize(data) {
  active = data?.mutant ?? null;
  if (active && !MUTANTS[active]) throw new Error(`unknown mutant: ${active}`);
}
export async function load(url, context, nextLoad) {
  const result = await nextLoad(url, context);
  if (!active || !url.endsWith(MUTANTS[active].file)) return result;
  const m = MUTANTS[active];
  let src = String(result.source);
  const edits = m.edits ?? [{ find: m.find, replace: m.replace }];
  for (const e of edits) {
    const hits = [...src.matchAll(e.find)].length;
    if (hits !== 1) throw new Error(`mutant ${active}: PATTERN-GONE — anchor matched ${hits}× in ${m.file} (want exactly 1)`);
    src = src.replace(e.find, e.replace);
  }
  return { ...result, source: src };
}
