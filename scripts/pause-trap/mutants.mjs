// Load-time MUTANTS of the shipped pause-trap source (#252 D1b G2) — same mechanism as
// scripts/session-budget/mutants.mjs: the source text is rewritten as node loads it (nothing on disk,
// nothing to restore). Every anchor must match EXACTLY ONCE or the run throws PATTERN-GONE.

/** name -> { file suffix, find (global regex), replace, mustRedden (the rig check that has to go red) } */
export const MUTANTS = {
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
    find: /await git\(cwd, \['add', '-A', '--ignore-errors', '--', \.\.\.pathspec\], env, undefined, \[1\]\);/g,
    replace: "await git(cwd, ['add', '-A', '--ignore-errors', '--', ...pathspec], {}, undefined, [1]);",
    mustRedden: 'snapshot_no_touch',
  },
  // The trap never kills (interrupt + snapshot only).
  'skip-kill': {
    file: '/src/main/pause-trap.ts',
    find: /const rep = await deps\.killTrees\(target\.cli, target\.keeperPid\);\n        killed = rep;/g,
    replace: "const rep = { cliPid: target.cli.pid, killed: [], refused: [], spared: [], survivors: [], rounds: 0 };\n        killed = rep;",
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
  // The pauser exemption removed: the coordinator that pauses its own run is interrupted + its tools killed.
  'no-pauser-exemption': {
    file: '/src/main/pause-trap.ts',
    find: /const exempt = carrier\.pausedBy !== null && isCoordinatorHandle\(carrier\.pausedBy, m\.wsId\);/g,
    replace: 'const exempt = false;',
    mustRedden: 'pauser_keeps_its_turn',
  },
  // D11: the env provenance matches ANY CLAUDE_PID (planner AND signal-time re-read — two layers cover each other, so both are edited).
  'env-pid-not-matched': {
    file: '/src/shared/pause-procs.ts',
    edits: [
      { find: /      if \(opts\.claudePidOf\(p\) === cli\.pid\) add\(p, null, 99, 'env'\);/g, replace: "      if (opts.claudePidOf(p) !== null) add(p, null, 99, 'env');" },
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
  // The signal-time identity re-read removed: a recycled pid is signalled (real pid reuse: recycle-rig.mjs).
  'identity-reread-removed': {
    file: '/src/shared/pause-procs.ts',
    find: /  if \(fresh\.startTicks !== target\.startTicks\) return \{ ok: false, reason: 'reused \(start-time changed\)' \};\n/g,
    replace: '',
    mustRedden: 'innocent_inheritor_survives',
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
