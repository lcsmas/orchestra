#!/usr/bin/env node
// In-place mutants of every clause of the pause trap (#252 D1b, ledger #261 G2). Each mutant edits the REAL source file,
// runs the unit files that can reach the clause, requires ≥1 test to go RED (naming which), then restores the file from a
// BYTE-EXACT backup and `cmp`s it — never a reverse sed. A clean control run (0 red) gates the whole harness, and every
// mutant anchor must match EXACTLY ONCE (else PATTERN-GONE: a mutant that matched nothing would "survive" vacuously).
//   node scripts/pause-trap/mutate-unit.mjs [--only <id>]   →  last line: MUTATE-UNIT: PASS|FAIL (n/N caught)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ONLY = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : null; // one id, or a comma-separated list (one control, one post-control)
const ONLY_SET = ONLY ? new Set(ONLY.split(',')) : null;
const SNAP = 'src/main/pause-snapshot.ts', PROCS = 'src/shared/pause-procs.ts', KILL = 'src/main/pause-kill.ts', TRAP = 'src/main/pause-trap.ts', REC = 'src/main/bus-pause-records.ts';
const IDX = 'src/main/index.ts', SDK = 'src/main/agent-sdk.ts', ACT = 'src/main/activity.ts', HOST = 'src/main/pause-trap-host.ts';
const GUARD = 'scripts/pause-trap/pidns-guard.mjs', PROV = 'scripts/pause-trap/provenance-inner.mjs';
const T = { rigguard: 'src/main/pause-rig-guard.test.ts', wiring: 'src/main/pause-trap-wiring.test.ts', snap: 'src/main/pause-snapshot.test.ts', procs: 'src/shared/pause-procs.test.ts', kill: 'src/main/pause-kill.test.ts', trap: 'src/main/pause-trap.test.ts', status: 'src/cli/run-status.test.ts', runpause: 'src/cli/run-pause.test.ts' };

const M = [
  // ── snapshot (pause-snapshot.ts)
  { id: 'snap-real-index', file: SNAP, find: "return git(cwd, ['add', '-A', '--ignore-errors', '--', ...argv], env, undefined, [1], timeoutMs);", rep: "return git(cwd, ['add', '-A', '--ignore-errors', '--', ...argv], {}, undefined, [1], timeoutMs);", tests: [T.snap], expect: /NO-TOUCH|captures unstaged/ },
  { id: 'snap-large-files-captured', file: SNAP, find: "files.filter((f) => !f.dir && f.bytes > perFileBytes)", rep: "files.filter((f) => false && !f.dir && f.bytes > perFileBytes)", tests: [T.snap], expect: /over the size cap/ },
  { id: 'snap-ref-overwrite', file: SNAP, find: "await git(cwd, ['update-ref', ref, commit, ''], env, undefined, [], addTimeout);", rep: "await git(cwd, ['update-ref', ref, commit], env, undefined, [], addTimeout);", tests: [T.snap], expect: /same `at` twice/ },
  { id: 'snap-no-parent', file: SNAP, find: "...(head ? ['-p', head] : []), '-F', '-'", rep: "'-F', '-'", tests: [T.snap], expect: /captures unstaged|unborn|clean worktree/ },
  { id: 'snap-no-torn-index-fallback', file: SNAP, find: "      try {\n        ({ tree, applied } = await buildTree(cwd, tmp.file, false, head, excludes, warnings, notes, input.legacyPathspec === true, addTimeout));", rep: "      throw new Error('no fallback');\n      try {\n        ({ tree, applied } = await buildTree(cwd, tmp.file, false, head, excludes, warnings, notes, input.legacyPathspec === true, addTimeout));", tests: [T.snap], expect: /corrupt\/torn/ },
  { id: 'snap-dirty-always-false', file: SNAP, find: 'const dirty = headTree === null ? true : headTree !== tree;', rep: 'const dirty = false;', tests: [T.snap, T.trap], expect: /captures unstaged|unborn|ORDER \+ CONTENT/ },
  { id: 'snap-runs-repo-hooks', file: SNAP, find: "'-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args],", rep: "'-c', 'commit.gpgsign=false', ...args],", tests: [T.snap], expect: /HOOKS never run/ },
  { id: 'snap-abort-on-unreadable', file: SNAP, find: "['add', '-A', '--ignore-errors', '--', ...argv], env, undefined, [1]", rep: "['add', '-A', '--', ...argv], env, undefined, []", tests: [T.snap], expect: /unreadable untracked file/i },
  { id: 'snap-nested-repo-ref', file: SNAP, find: '        if (!fs.lstatSync(dotGit).isFile()) {', rep: '        if (false) {', tests: [T.snap], expect: /nested STANDALONE repository/ },
  // ── identity / lineage (pause-procs.ts)
  { id: 'procs-protected-pid-removed', file: PROCS, find: "  if (target.pid <= 1 || target.pid === plan.cli.pid || target.pid === protect.keeperPid || target.pid === protect.selfPid) {\n    return { ok: false, reason: 'protected-pid (cli/keeper/app/init)' };\n  }\n", rep: '', tests: [T.procs], expect: /NEVER signals the CLI/ },
  { id: 'procs-identity-reread-removed', file: PROCS, find: "  if (fresh.startTicks !== target.startTicks) return { ok: false, reason: 'reused (start-time changed)' };\n", rep: '', tests: [T.procs, T.kill], expect: /REFUSES a recycled pid|RECYCLED PID/ },
  { id: 'procs-unreadable-fails-open', file: PROCS, find: "  if (fresh === 'unreadable') return { ok: false, reason: 'unreadable' };\n", rep: "  if (fresh === 'unreadable') return { ok: true, via: 'chain' };\n", tests: [T.procs, T.kill], expect: /FAILS CLOSED|UNREADABLE identity/ },
  { id: 'procs-cli-identity-unchecked', file: PROCS, find: "  if (cli === 'gone' || cli === 'unreadable' || cli.startTicks !== plan.cli.startTicks || cli.state === 'Z') {", rep: "  if (false) {", tests: [T.procs], expect: /no provable CLI/ },
  { id: 'procs-non-shell-is-tool', file: PROCS, find: '  if (!SHELLS.has(shell) && !SHELLS.has(p.comm)) return false;', rep: '', tests: [T.procs, T.kill], expect: /isToolShell|planToolTrees: tool shells/ },
  { id: 'procs-kill-order-root-first', file: PROCS, find: 'return [...members].sort((a, b) => Number(a.isRoot) - Number(b.isRoot) || b.depth - a.depth);', rep: 'return [...members].sort((a, b) => Number(b.isRoot) - Number(a.isRoot) || a.depth - b.depth);', tests: [T.procs, T.kill], expect: /killOrder|leaf-first/ },
  { id: 'procs-env-older-than-cli', file: PROCS, find: '|| p.startTicks <= cli.startTicks) continue;', rep: ') continue;', tests: [T.procs], expect: /env provenance/ },
  { id: 'procs-env-sidecar-descendants', file: PROCS, find: '|| sidecar.has(p.pid) ||', rep: '||', tests: [T.procs], expect: /env provenance/ },
  { id: 'procs-env-planner-pid-unmatched', file: PROCS, find: "      if (opts.claudePidOf(p) !== cli.pid) continue;", rep: "      if (opts.claudePidOf(p) === null) continue;", tests: [T.procs], expect: /env provenance/ },
  { id: 'procs-env-evidence-dropped', file: PROCS, find: "      evidence: `re-read now: environ CLAUDE_PID=${env} == CLI ${plan.cli.pid} whose start-time ${plan.cli.startTicks} was just re-verified; process started after it (${fresh.startTicks} > ${plan.cli.startTicks})`,", rep: "      evidence: '',", tests: [T.procs], expect: /D11: planner records cwd/ },
  { id: 'kill-cwd-not-recorded', file: KILL, find: '    cwdOf: (p: ProcIdent) => deps.readCwd(p.pid),\n', rep: '', tests: [T.kill], expect: /listed with its cmdline, cwd/ },
  // TWO LAYERS cover each other (the structural ppid/pid<=1 exclusion AND the F1 descendant-supervisor guard: the keeper always has the CLI below it): the mutant removes BOTH.
  { id: 'procs-env-keeper-member', file: PROCS, edits: [
    { find: 'p.pid === cliNow.ppid || p.pid <= 1 || ', rep: '' },
    { find: "(hasSupervisor(p.pid) || supervisorAncestorOf(p, (pid) => byPid.get(pid) ?? 'gone', cli.pid) !== 'no')", rep: 'false' },
  ], tests: [T.procs], expect: /never makes the CLI a member/ },
  { id: 'procs-env-verify-ignores-marker', file: PROCS, find: '  if (env === plan.cli.pid && fresh.startTicks > plan.cli.startTicks) {', rep: '  if (true) {', tests: [T.procs], expect: /env path/ },
  // ── killer (pause-kill.ts)
  { id: 'kill-no-sigkill-escalation', file: KILL, find: "      if (v.ok && deps.signal(m.pid, 'SIGKILL')) {", rep: '      if (false) {', tests: [T.kill], expect: /SIGTERM ignored/ },
  // TWO LAYERS cover each other here (isAlive's identity read + verifyAtSignal): each alone survives, so the mutant removes BOTH.
  { id: 'kill-no-second-identity-reread', file: KILL, edits: [
    { find: "      if (!isAlive(m, deps)) continue;\n      if (!paused()) break;\n      if (tooNew(m)) continue;\n      // SIGTERM was ignored/slow", rep: "      if (!paused()) break;\n      if (tooNew(m)) continue;\n      // SIGTERM was ignored/slow" },
    { find: "      const v = verifyAtSignal(m, plan, protect, deps.read, deps.readClaudePid);\n      if (v.ok && deps.signal(m.pid, 'SIGKILL')) {", rep: "      const v = { ok: true as const, via: 'chain' as const };\n      if (v.ok && deps.signal(m.pid, 'SIGKILL')) {" },
  ], tests: [T.kill], expect: /between SIGTERM and SIGKILL/ },
  { id: 'kill-unbounded-rounds', file: KILL, find: 'for (let round = 1; round <= maxRounds; round++) {', rep: 'for (let round = 1; round <= maxRounds + 5; round++) {', tests: [T.kill], expect: /keeps respawning/ },
  { id: 'kill-no-replan', file: KILL, find: '    if (signalled === 0) break; // nothing provable to signal: more rounds cannot change that', rep: '    break;', tests: [T.kill], expect: /spawned WHILE killing|keeps respawning/ },
  // ── orchestrator (pause-trap.ts) + records
  { id: 'trap-no-pauser-exemption', file: TRAP, find: '  const pauser = spareRoot !== undefined;', rep: '  const pauser = false;', tests: [T.trap], expect: /F5 the PAUSER/ },
  { id: 'trap-interrupt-never-called', file: TRAP, find: "      activity.interrupt = await deps.interrupt(m);\n      if (activity.interrupt === 'failed' || activity.interrupt === 'unresponsive') {", rep: "      activity.interrupt = 'interrupted';\n      if (activity.interrupt === 'failed' || activity.interrupt === 'unresponsive') {", tests: [T.trap], expect: /ORDER \+ CONTENT|PAUSER|surviving/ },
  { id: 'trap-no-lift-check-before-kill', file: TRAP, find: "  if (!stillPaused(db, carrier)) {\n    updateBilan(db, rowId, { activity, error: errors.length ? errors.join('; ') : null }); // keep what the interrupt did\n    return 'lifted';\n  }\n", rep: '', tests: [T.trap], expect: /LIFT landing DURING the interrupt/ },
  { id: 'trap-members-without-descendants', file: TRAP, find: 'const members = deps.members(runSubtreeIds(db, carrier.runId), carrier.runId);', rep: 'const members = deps.members([carrier.runId], carrier.runId);', tests: [T.trap], expect: /DESCENDANTS/ },
  { id: 'trap-human-mark-reusable', file: TRAP, find: '      humanTurnMarks.set(wsId, marks);\n      return true;', rep: '      humanTurnMarks.set(wsId, [at, ...marks]);\n      return true;', tests: [T.trap], expect: /HUMAN prompt is ALLOWED/ },
  { id: 'trap-sweep-not-reentrant', file: TRAP, find: '    if (inflight.has(key)) continue;\n', rep: '', tests: [T.trap], expect: /SWEEP/ },
  { id: 'trap-always-resnapshot', file: TRAP, find: "  else if (!snapshotRef) {\n    if (!m.worktreePath)", rep: "  else if (true) {\n    if (!m.worktreePath)", tests: [T.trap], expect: /BOOT COMPLETION/ },
  { id: 'trap-done-member-redone', file: TRAP, find: "  if (existing && existing.killed !== null) return 'complete'; // already fully trapped (boot completion after a mid-trap quit)\n", rep: '', tests: [T.trap], expect: /BOOT COMPLETION/ },
  { id: 'rec-trap-stamp-unguarded', file: REC, find: "'UPDATE runs SET pause_trap_at = ? WHERE id = ? AND paused_at = ? AND pause_trap_at IS NULL'", rep: "'UPDATE runs SET pause_trap_at = ? WHERE id = ? AND ? IS NOT NULL AND pause_trap_at IS NULL'", tests: [T.trap], expect: /markTrapDone is keyed on paused_at/ },
  // ── wiring (index.ts / agent-sdk.ts / activity.ts / pause-trap-host.ts) — pause-trap-wiring.test.ts
  { id: 'wire-human-mark-not-at-yield', file: SDK, find: '    if (humanTurn) markPauseHumanTurn(session.wsId); // the pause trap\'s turn-start observer lets exactly this start through\n', rep: '', tests: [T.wiring], expect: /promptStream marks a HUMAN turn at its YIELD/ },
  { id: 'wire-human-mark-ignores-coalesced', file: SDK, find: '      if (nextMsg.uuid && session.humanTurns.has(nextMsg.uuid)) humanTurn = true;\n', rep: '', tests: [T.wiring], expect: /promptStream marks a HUMAN turn at its YIELD/ },
  { id: 'wire-stop-after-close', file: IDX, find: '  stopPauseTrap();\n  // Last: a clean close', rep: '  // Last: a clean close', tests: [T.wiring], expect: /index\.ts starts the trap/ },
  { id: 'wire-stream-observer-any-turn', file: SDK, find: "if (session.turnGate === null && !session.unexplainedTurnSeen && !session.stopping && (msg.type === 'assistant'", rep: "if (!session.unexplainedTurnSeen && !session.stopping && (msg.type === 'assistant'", tests: [T.wiring], expect: /consume\(\): a CLI-started turn/ },
  { id: 'wire-interrupt-idle-not-skipped', file: SDK, find: "  if (!attached && session.turnGate === null && session.unexplainedTurnSeen !== true) return 'idle';\n", rep: '', tests: [T.wiring], expect: /never touches an idle session/ },
  { id: 'wire-interrupt-drops-queue', file: SDK, find: '    await session.q.interrupt(); // plain interrupt: no cancel_queued, no queue clearing', rep: '    await interruptCancellingQueued(session);', tests: [T.wiring], expect: /NEVER drops the queue/ },
  { id: 'wire-submit-notifies-parked-prompt', file: ACT, find: 'if (!queuedSubmit) notifyTurnStart(id);', rep: 'notifyTurnStart(id);', tests: [T.wiring], expect: /submit. chokepoint/ },
  { id: 'wire-members-closure-only', file: HOST, find: 'return c.includes || (c.dangling && set.has(m.runId));', rep: 'return set.has(m.runId);', tests: [T.wiring], expect: /UNION of the run closure/ },
  { id: 'trap-observer-ignores-live-chain', file: TRAP, find: 'for (const id of [m.runId, ...(m.chain ?? [])]) {', rep: 'for (const id of [m.runId]) {', tests: [T.trap], expect: /LIVE parent chain is\) is still trapped|NOT under the carrier/ },
  { id: 'trap-observer-ignores-carrierFor', file: TRAP, find: '  if (deps.carrierFor) return deps.carrierFor(m);', rep: '  if (false) return deps.carrierFor!(m);', tests: [T.trap], expect: /carrierFor/ },
  { id: 'wire-observer-not-gate-decision', file: HOST, find: 'return db && ws ? pausedCarrierForWorkspace(db, ws, (id) => store.getWorkspace(id)) : null;', rep: 'return null;', tests: [T.wiring], expect: /UNION|live parent chain|membership/ },
  { id: 'trap-observer-pauser-exempt', file: TRAP, find: "    if (humanNow || marked) return 'allowed';\n", rep: "    if (humanNow || marked) return 'allowed';\n    if (readPauseOrigin(db, carrier.runId, carrier.pausedAt)) return 'allowed'; // mutant: the pauser's later CLI-started turns are exempt too\n", tests: [T.trap], expect: /pauser is spared only the PAUSE-TIME/ },
  { id: 'trap-burst-dropped', file: TRAP, find: '        if (!st.again) break;\n', rep: '        break;\n', tests: [T.trap], expect: /COALESCED, not dropped/ },
  { id: 'trap-burst-parallel', file: TRAP, find: '    if (st.running) {\n      st.again = true;', rep: '    if (false) {\n      st.again = true;', tests: [T.trap], expect: /COALESCED, not dropped/ },
  { id: 'trap-members-unbounded', file: TRAP, find: 'Math.min(deps.concurrency ?? 3, members.length)', rep: 'members.length', tests: [T.trap], expect: /PARALLEL/ },
  { id: 'trap-members-serial', file: TRAP, find: 'Math.min(deps.concurrency ?? 3, members.length)', rep: '1', tests: [T.trap], expect: /PARALLEL/ },
  { id: 'trap-no-arm-in-trap', file: TRAP, find: "    await withDeadline(deps.arm?.(m), deps.armTimeoutMs ?? ARM_TIMEOUT_MS, 'arm');\n", rep: '', tests: [T.trap], expect: /arm: every member/ },
  { id: 'trap-arm-failure-blocks', file: TRAP, find: "    errors.push(`arm: ${errMsg(e)}${e instanceof DeadlineError ? ' — the trap stays open and is retried' : ''}`);", rep: '    throw e;', tests: [T.trap], expect: /arm failure is recorded/ },
  { id: 'trap-arm-pass-owed-only', file: TRAP, find: '    carriers = activePauseCarriers(db);', rep: '    carriers = activePauseCarriers(db).filter((c) => c.trapAt === null);', tests: [T.trap], expect: /arm: every member/ },
  { id: 'rec-active-ignores-switch', file: REC, find: '    .filter((r) => parseSwitches((r.flags_json as string | null | undefined) ?? null).pause === true)\n', rep: '', tests: [T.trap], expect: /activePauseCarriers honours the FROZEN switch/ },
  { id: 'rec-latest-bilan-oldest', file: REC, find: "  const recent = db.prepare('SELECT * FROM pause_records ORDER BY id DESC LIMIT 500').all() as RawRow[];", rep: "  const recent = db.prepare('SELECT * FROM pause_records ORDER BY id ASC LIMIT 500').all() as RawRow[];", tests: [T.trap], expect: /latestPauseBilanFor/ },
  { id: 'status-lastpause-never-read', file: 'src/cli/run-status.ts', find: '  const last = pause ? null : (deps.latestPauseBilan?.(db, runId) ?? null);', rep: '  const last = null as ReturnType<NonNullable<RunStatusDeps[\'latestPauseBilan\']>>;', tests: [T.status], expect: /AFTER the lift/ },
  { id: 'trap-observer-kills-unrecorded', file: TRAP, find: '          appendObserverKills(db, carrier.runId, m.wsId, carrier.pausedAt, rep.killed);\n', rep: '', tests: [T.trap], expect: /what the turn observer KILLS/ },
  { id: 'trap-final-write-drops-observer-kills', file: TRAP, find: '    ...(fresh?.activity?.observerKilled ? { observerKilled: fresh.activity.observerKilled } : {}),\n', rep: '', tests: [T.trap], expect: /DURING the trap/ },
  { id: 'trap-provisional-row-blind-overwrite', file: TRAP, find: '  if (cur?.activity?.observerKilled) activity.observerKilled = cur.activity.observerKilled;\n', rep: '', tests: [T.trap], expect: /what the turn observer KILLS/ },
  // ── review round (F1 F2 F4 F5 F8 F9 F10)
  { id: 'procs-supervisor-guard-planner', file: PROCS, find: "(hasSupervisor(p.pid) || supervisorAncestorOf(p, (pid) => byPid.get(pid) ?? 'gone', cli.pid) !== 'no')", rep: "supervisorAncestorOf(p, (pid) => byPid.get(pid) ?? 'gone', cli.pid) !== 'no'", tests: [T.procs], expect: /F1: an env-proven orphan that IS or HAS/ },
  { id: 'procs-supervisor-guard-verify', file: PROCS, find: "  if (target.via !== 'tree' && isSupervisorProc(fresh)) return { ok: false, reason: 'supervisor (keeper / claude CLI / Orchestra app of another session)' };\n", rep: '', tests: [T.procs], expect: /F1: the signal-time re-read refuses a keeper/ },
  { id: 'procs-session-root-start-optional', file: PROCS, find: '    const rootOk = rootStart !== undefined && (root ===', rep: '    const rootOk = (root ===', tests: [T.procs], expect: /F9/ },
  { id: 'kill-no-pause-check-round', file: KILL, find: '    if (!paused()) break;\n    const plan: ToolPlan = planNow();', rep: '    const plan: ToolPlan = planNow();', tests: [T.kill], expect: /F8: a lift landing mid-kill/ },
  { id: 'kill-no-pause-check-signal', file: KILL, find: '      if (!paused()) break;\n      if (tooNew(m)) continue; // started after a human turn that began mid-kill\n      const v = verifyAtSignal(m, plan, protect, deps.read, deps.readClaudePid);', rep: '      if (tooNew(m)) continue; // started after a human turn that began mid-kill\n      const v = verifyAtSignal(m, plan, protect, deps.read, deps.readClaudePid);', tests: [T.kill], expect: /F8: a lift landing mid-kill/ },
  { id: 'kill-no-pause-check-sigkill', file: KILL, find: '      if (!isAlive(m, deps)) continue;\n      if (!paused()) break;', rep: '      if (!isAlive(m, deps)) continue;', tests: [T.kill], expect: /F8: the SIGKILL escalation re-checks/ },
  // TWO LAYERS (plan-time filter + per-signal tooNew) cover each other: the mutant removes BOTH.
  { id: 'kill-startedbefore-ignored', file: KILL, edits: [
    { find: '    if (beforeMs() !== undefined || opts.humanWindows) {', rep: '    if (false) {' },
    { find: '    if (b !== undefined && ms >= b) return true;\n', rep: '' },
  ], tests: [T.kill], expect: /F2: startedBeforeMs spares/ },
  { id: 'kill-sparerooots-ignored', file: KILL, find: '    if (opts.spareRoots?.length) {', rep: '    if (false) {', tests: [T.kill], expect: /F5: spareRoots spares/ },
  { id: 'trap-incomplete-reads-complete', file: TRAP, find: "  return incomplete ? 'incomplete' : 'complete';", rep: "  return 'complete';", tests: [T.trap], expect: /F4 UNKNOWN is not NONE|F4 a FAILED/ },
  { id: 'trap-incomplete-writes-killed', file: TRAP, find: '  updateBilan(db, rowId, { activity: merged, killed: incomplete ? null : killed,', rep: '  updateBilan(db, rowId, { activity: merged, killed: killed ?? { skipped: \'incomplete\' },', tests: [T.trap], expect: /F4 UNKNOWN is not NONE/ },
  { id: 'trap-pauser-by-handle', file: TRAP, find: '  const pauser = spareRoot !== undefined;', rep: '  const pauser = spareRoot !== undefined || (carrier.pausedBy !== null && isCoordinatorHandle(carrier.pausedBy, m.wsId));', tests: [T.trap], expect: /F5 a pause typed by a HUMAN/ },
  { id: 'trap-origin-start-time-ignored', file: TRAP, find: '(p) => p.pid === target.cli.pid && p.startTicks === target.cli.startTicks', rep: '(p) => p.pid === target.cli.pid', tests: [T.trap], expect: /F5 a RECYCLED CLI pid/ },
  { id: 'trap-pauser-spares-nothing', file: TRAP, find: "        ...(spareRoot !== undefined ? { spareRoots: [spareRoot] } : {}),\n", rep: '', tests: [T.trap], expect: /F5 the PAUSER/ },
  { id: 'trap-pauser-interrupted', file: TRAP, find: "  if (pauser || carriedPauser) activity.interrupt = 'exempt';\n  else if (target !== null && 'error' in target && deferrals < MAX_INTERRUPT_DEFERRALS) {", rep: "  if (false) activity.interrupt = 'exempt';\n  else if (target !== null && 'error' in target && deferrals < MAX_INTERRUPT_DEFERRALS) {", tests: [T.trap], expect: /F5 the PAUSER/ },
  { id: 'trap-origin-not-awaited', file: TRAP, find: '    if (carrier.pausedAt + limit < start || deps.now() - start >= limit) return null;', rep: '    return null;', tests: [T.trap], expect: /F5 a RECENT pause waits/ },
  { id: 'trap-zero-members-stamped', file: TRAP, find: '  if (members.length === 0) {', rep: '  if (false) {', tests: [T.trap], expect: /F10 ZERO members/ },
  { id: 'trap-store-not-ready-ignored', file: TRAP, find: '  if (deps.storeReady && !deps.storeReady()) {', rep: '  if (false) {', tests: [T.trap], expect: /F10 ZERO members/ },
  { id: 'trap-human-window-ignored', file: TRAP, find: '  const humanDuringTrap = humanAtInterrupt !== undefined && humanAtInterrupt >= carrier.pausedAt && humanInFlightNow();', rep: '  const humanDuringTrap = false;', tests: [T.trap], expect: /F2 a HUMAN turn that STARTS during the trap window/ },
  { id: 'trap-human-mark-only-first', file: TRAP, find: '    if (now - at <= HUMAN_MARK_TTL_MS && at >= notBefore) {\n      humanTurnMarks.set(wsId, marks);', rep: '    if (now - at <= HUMAN_MARK_TTL_MS && at >= notBefore) {\n      marks.length = 0;\n      humanTurnMarks.set(wsId, marks);', tests: [T.trap], expect: /F2 a human prompt PARKED/ },
  { id: 'trap-observer-no-lift-recheck', file: TRAP, find: '        if (round > 0 && !resolveCarrier(deps, db, m)) break; // lifted meanwhile (review F8): never touch a turn the lift just released\n', rep: '', tests: [T.trap], expect: /F8 the turn observer stops/ },
  { id: 'trap-observer-no-stillpaused-opt', file: TRAP, find: '{ stillPaused: () => resolveCarrier(deps, db, m) !== null }', rep: '{}', tests: [T.trap], expect: /F8 the turn observer stops/ },
  { id: 'rec-origin-listed-as-member', file: REC, find: '  return rows.map(toRow).filter((r) => r.wsId !== PAUSE_ORIGIN_WS);', rep: '  return rows.map(toRow);', tests: [T.trap], expect: /F5 the PAUSER/ },
  { id: 'trap-retry-blanks-error', file: TRAP, find: "errors.length ? errors.join('; ') : (cur.error ?? null) }), cur.id)", rep: "errors.length ? errors.join('; ') : null }), cur.id)", tests: [T.trap], expect: /F4 a RETRY keeps/ },
  { id: 'status-control-chars-not-stripped', file: 'src/cli/run-status.ts', find: "  return String(s ?? '').replace(/[\\u0000-\\u001f\\u007f-\\u009f\\u00ad\\u061c\\u180e\\u200b-\\u200f\\u2028\\u2029\\u202a-\\u202e\\u2060-\\u2064\\u2066-\\u2069\\ufeff\\u{e0000}-\\u{e007f}]/gu, ' ');", rep: "  return String(s ?? '');", tests: [T.status], expect: /F11/ },
  // follow-up review F1: `run status` and `run resume` share ONE live cover walk. These tests EXEC dist-electron/cli.js → `build: true` rebuilds it per mutant.
  { id: 'status-uses-write-once-walk', file: 'src/cli/index.ts', find: 'activePauseFor: (d, id) => coverFor(d, id, busPause),', rep: 'activePauseFor: busPause.activePauseFor,', tests: [T.runpause], expect: /follow-up review F1/, build: true },
  { id: 'cover-for-ignores-live-tree', file: 'src/cli/index.ts', find: '  return node ? busPause.pausedCarrierForWorkspace(d, node, (id) => nodes.get(id)) : busPause.activePauseFor(d, runId);', rep: '  return busPause.activePauseFor(d, runId);', tests: [T.runpause], expect: /follow-up review F1|re-parented AFTER creation/, build: true },
  // ── pre-review round 2 (M1 M2 M3 M4 M5 M7 M8 M9 + F11 every string)
  { id: 'procs-no-supervisor-ancestor-plan', file: PROCS, find: "(hasSupervisor(p.pid) || supervisorAncestorOf(p, (pid) => byPid.get(pid) ?? 'gone', cli.pid) !== 'no')", rep: 'hasSupervisor(p.pid)', tests: [T.procs], expect: /M1: an env-proven process UNDER/ },
  { id: 'procs-no-supervisor-ancestor-signal', file: PROCS, find: "  if (target.via !== 'tree' && supervisorAncestorOf(fresh, read, plan.cli.pid) !== 'no') return", rep: "  if (false) return", tests: [T.procs], expect: /M1: the signal-time re-read refuses a process under/ },
  { id: 'procs-ancestor-unreadable-fails-open', file: PROCS, find: "    if (q === 'unreadable') return 'unknown';", rep: "    if (q === 'unreadable') return 'no';", tests: [T.procs], expect: /M1: the signal-time re-read refuses a process under/ },
  { id: 'procs-orchestra-cli-is-supervisor', file: PROCS, find: "    return argv.slice(1).find((a) => !a.startsWith('-')) !== 'cli';", rep: '    return true;', tests: [T.procs], expect: /M2:/ },
  { id: 'trap-retry-overwrites-observations', file: TRAP, find: '  if (prior && prior.turnRunning !== undefined) {', rep: '  if (false && prior && prior.turnRunning !== undefined) {', tests: [T.trap], expect: /M3 a RETRY keeps/ },
  { id: 'trap-retry-snapshot-facts-dropped', file: TRAP, find: '    if (prior.head !== undefined) activity.head = prior.head;\n', rep: '', tests: [T.trap], expect: /M3 a RETRY keeps/ },
  { id: 'trap-retry-interrupt-rewritten', file: TRAP, find: "activity.interrupt === 'no-session')) activity.interrupt = prior.interrupt;", rep: "activity.interrupt === 'no-session')) activity.interrupt = activity.interrupt;", tests: [T.trap], expect: /M3 a RETRY keeps/ },
  { id: 'trap-no-lift-check-before-interrupt', file: TRAP, find: "  if (!stillPaused(db, carrier)) return 'lifted';\n  if (!pauser && !carriedPauser) {", rep: "  if (!pauser && !carriedPauser) {", tests: [T.trap], expect: /M7 a LIFT landing while the trap arms/ },
  { id: 'trap-lifted-kill-report-dropped', file: TRAP, find: "        updateBilan(db, rowId, { activity, killed: rep, error: errors.length ? errors.join('; ') : null });\n        return 'lifted';", rep: "        return 'lifted';", tests: [T.trap], expect: /M7 a lift DURING the kill step/ },
  { id: 'trap-human-window-anchored-on-trap-start', file: TRAP, find: 'humanAtInterrupt >= carrier.pausedAt && humanInFlightNow();', rep: 'humanAtInterrupt >= deps.now() && humanInFlightNow();', tests: [T.trap], expect: /M5 a human turn that started AFTER the pause/ },
  { id: 'kill-human-cutoff-read-once', file: KILL, find: '      if (tooNew(m)) continue; // started after a human turn that began mid-kill\n', rep: '', tests: [T.kill], expect: /M5: startedBeforeMs as a GETTER/ },
  { id: 'trap-pre-pause-mark-admits-turn', file: TRAP, find: 'if (now - at <= HUMAN_MARK_TTL_MS && at >= notBefore) {', rep: 'if (now - at <= HUMAN_MARK_TTL_MS) {', tests: [T.trap], expect: /M4 a human mark from BEFORE the pause/ },
  { id: 'trap-own-arm-turn-start-not-ignored', file: TRAP, find: "    if (trapArming.has(m.wsId)) return 'skipped'; // the member trap's own arm() attach fired this start: trapMember handles the turn (pauser-aware)\n", rep: '', tests: [T.trap], expect: /M9 the turn start fired by THIS trap/ },
  { id: 'trap-arm-hang-not-incomplete', file: TRAP, find: '    if (e instanceof DeadlineError) incompleteEarly = true;', rep: '', tests: [T.trap], expect: /M8 a HUNG arm/ },
  { id: 'host-unknown-keeper-is-none', file: HOST, find: "(ks === 'keeper' || ks === 'unknown')", rep: "(ks === 'keeper')", tests: [T.wiring], expect: /snapshots through the no-touch/ },
  { id: 'sdk-unknown-keeper-is-idle', file: SDK, find: "return ks === 'keeper' || ks === 'unknown' ? 'unresponsive' : 'idle';", rep: "return ks === 'keeper' ? 'unresponsive' : 'idle';", tests: [T.wiring], expect: /unknown/ },
  { id: 'status-orphan-cwd-raw', file: 'src/cli/run-status.ts', find: "pid ${c(o.pid)} cwd ${c(o.cwd ?? '?')} — ${c(o.evidence ?? '')}`);\n        }\n        if (k.survivors", rep: "pid ${c(o.pid)} cwd ${o.cwd ?? '?'} — ${o.evidence ?? ''}`);\n        }\n        if (k.survivors", tests: [T.status], expect: /F11 \(round 2\)/ },
  { id: 'status-error-raw', file: 'src/cli/run-status.ts', find: 'out.push(`      error: ${c(r.error)}`);', rep: 'out.push(`      error: ${r.error}`);', tests: [T.status], expect: /F11 \(round 2\)/ },
  { id: 'status-note-raw', file: 'src/cli/run-status.ts', find: 'out.push(`      note: ${c(n)}`);', rep: 'out.push(`      note: ${n}`);', tests: [T.status], expect: /F11 \(round 2\)/ },
  // ── round-2 delta (F1b F2 F3 F7)
  { id: 'startms-floored-btime', file: KILL, find: 'if (up !== null) return startWallMs(Date.now(), up, startTicks, clkTck);', rep: 'if (false) return startWallMs(Date.now(), up, startTicks, clkTck);', tests: [T.kill], expect: /round-2 F1b REAL/ },
  { id: 'startwallms-wrong-sign', file: KILL, find: 'return nowMs - (uptimeSec - startTicks / tck) * 1000;', rep: 'return nowMs + (uptimeSec - startTicks / tck) * 1000;', tests: [T.kill], expect: /F1b: startWallMs/ },
  { id: 'trap-human-inflight-ignored', file: TRAP, find: "    if (humanNow || marked) return 'allowed';", rep: "    if (marked) return 'allowed';", tests: [T.trap], expect: /round-2 F3 a HUMAN turn in flight/ },
  { id: 'trap-exact-allow-keeps-mark', file: TRAP, find: '    const marked = consumeHumanMark(m.wsId, deps.now(), carrier.pausedAt);', rep: '    const marked = humanNow ? false : consumeHumanMark(m.wsId, deps.now(), carrier.pausedAt);', tests: [T.trap], expect: /CONSUMES the fresh mark/ },
  { id: 'sdk-gate-human-never-set', file: SDK, find: '    session.gateTurnHuman = humanTurn;', rep: '    session.gateTurnHuman = false;', tests: [T.wiring], expect: /round-2 F3: the session carries/ },
  { id: 'sdk-gate-human-stuck-after-release', file: SDK, find: "markPauseHumanTurnEnd(session.wsId); // closes the window the trap shields (round-3 F3i)\n  session.gateTurnHuman = false;\n", rep: "markPauseHumanTurnEnd(session.wsId); // closes the window the trap shields (round-3 F3i)\n", tests: [T.wiring], expect: /round-2 F3: the session carries/ },
  { id: 'sdk-gate-human-stuck-after-force-release', file: SDK, find: '  session.gateTurnHuman = false;\n  openNext?.();\n  return true;', rep: '  openNext?.();\n  return true;', tests: [T.wiring], expect: /round-2 F3: the session carries/ },
  { id: 'sdk-human-inflight-any-turn', file: SDK, find: 's.turnGate !== null && s.gateTurnHuman === true', rep: 's.turnGate !== null', tests: [T.wiring], expect: /round-2 F3: the session carries/ },
  { id: 'host-human-inflight-not-wired', file: HOST, find: '    humanTurnInFlight: (m) => sdkHumanTurnInFlight(m.wsId),\n', rep: '', tests: [T.wiring], expect: /round-2 F3: the session carries/ },
  { id: 'trap-probe-flake-interrupts', file: TRAP, find: "  else if (target !== null && 'error' in target && deferrals < MAX_INTERRUPT_DEFERRALS) {", rep: '  else if (false) {', tests: [T.trap], expect: /round-2 F2 a flaking keeper probe/ },
  // F7: the guard removed (the rig bodies then run in the HOST namespace but can only reach TAGGED pids and cannot write ns_last_pid) / the cleanup no longer keyed on the tag
  { id: 'rig-pidns-guard-removed', file: GUARD, find: "  if (!cfg.tag || !cfg.hostPidNs || own === null || own === cfg.hostPidNs || process.pid !== 1) {", rep: '  if (false) {', tests: [T.rigguard], expect: /F7 a DIRECT run/ },
  { id: 'rig-cleanup-untagged', file: PROV, find: 'if (p.pid !== process.pid && isTagged(p.pid, TAG)) {', rep: 'if (p.pid !== process.pid) {', tests: [T.rigguard], expect: /F7 the inner rigs kill only TAGGED/ },
  { id: 'trap-human-inflight-not-anchored', file: TRAP, find: "deps.humanTurnInFlight?.(m) === true && (lastHumanTurnStart(m.wsId) ?? 0) >= carrier.pausedAt;", rep: 'deps.humanTurnInFlight?.(m) === true;', tests: [T.trap], expect: /pre-review r2 .?#1/ },
  { id: 'trap-flake-retry-erases-interrupt', file: TRAP, find: "    if (prior?.interrupt === 'interrupted' || prior?.interrupt === 'attached-then-interrupted') activity.interrupt = prior.interrupt;\n    else {", rep: '    if (false) activity.interrupt = prior!.interrupt;\n    else {', tests: [T.trap], expect: /pre-review r2 .?#3/ },
  // ── round 3 (follow-ups): F1a F1c F2-bound F4 pins F5 F6 F7 F8 + verifier MINOR
  { id: 'kill-cutoff-per-process', file: KILL, find: "const ms = deps.startMs(m.rootStartTicks ?? m.startTicks);", rep: "const ms = deps.startMs(m.startTicks);", tests: [T.kill], expect: /round-3 F1a/ },
  { id: 'kill-cli-gone-start-unchecked', file: KILL, find: "  if (cliGone()) {\n    report.cliGone = true;\n    report.error = 'the CLI exited, was replaced or could not be read before the kill", rep: "  if (false) {\n    report.cliGone = true;\n    report.error = 'the CLI exited, was replaced or could not be read before the kill", tests: [T.kill], expect: /round-3 F5: a CLI that EXITED/ },
  { id: 'kill-cli-gone-end-unchecked', file: KILL, find: "  if (cliGone()) {\n    report.cliGone = true;\n    report.error = report.error ??", rep: "  if (false) {\n    report.cliGone = true;\n    report.error = report.error ??", tests: [T.kill], expect: /round-3 F5: a CLI that EXITED/ },
  { id: 'procs-tree-supervisor-spared', file: PROCS, find: "    if (via !== 'tree' && (hasSupervisor(p.pid) ||", rep: "    if ((hasSupervisor(p.pid) ||", tests: [T.procs, T.kill], expect: /F4 pin|F1: a TREE member/ },
  { id: 'procs-tree-supervisor-refused-at-signal', file: PROCS, find: "  if (target.via !== 'tree' && isSupervisorProc(fresh)) return", rep: "  if (isSupervisorProc(fresh)) return", tests: [T.procs], expect: /round-3 F4 pin \(signal-time/ },
  { id: 'trap-human-interrupt-skip-not-bounded', file: TRAP, find: 'humanAtInterrupt >= carrier.pausedAt && humanInFlightNow();', rep: 'humanAtInterrupt >= carrier.pausedAt;', tests: [T.trap], expect: /round-3 F1c/ },
  { id: 'trap-interrupt-deferral-unbounded', file: TRAP, find: "  else if (target !== null && 'error' in target && deferrals < MAX_INTERRUPT_DEFERRALS) {", rep: "  else if (target !== null && 'error' in target) {", tests: [T.trap], expect: /round-3 F2: the interrupt deferral is BOUNDED/ },
  { id: 'trap-notes-prefer-fresh', file: TRAP, find: 'notes: [...new Set([...(fresh?.activity?.notes ?? []), ...(activity.notes ?? [])])].slice(-50),', rep: 'notes: fresh?.activity?.notes ?? activity.notes,', tests: [T.trap], expect: /round-3 F2: the interrupt deferral is BOUNDED/ },
  { id: 'trap-cli-gone-not-incomplete', file: TRAP, find: '      if (rep.cliGone) {', rep: '      if (false) {', tests: [T.trap], expect: /round-3 F5/ },
  { id: 'trap-earlier-kills-dropped', file: TRAP, find: '  if (incomplete && attemptKills.length > 0) merged.earlierKilled', rep: '  if (false && attemptKills.length > 0) merged.earlierKilled', tests: [T.trap], expect: /round-3 F5/ },
  { id: 'sweep-retry-not-backed-off', file: TRAP, find: 'nextAttempt.set(key, deps.now() + pauseRetryDelay(n));', rep: 'nextAttempt.set(key, deps.now() + PAUSE_RETRY_MS);', tests: [T.trap], expect: /round-3 F6: the retry delay DOUBLES/ },
  { id: 'trap-warns-every-attempt', file: TRAP, find: 'warnOnce(`${carrier.runId}@${carrier.pausedAt}:incomplete`,', rep: 'warnOnce(`${carrier.runId}@${carrier.pausedAt}:incomplete:${Math.random()}`,', tests: [T.trap], expect: /round-3 F6: a retried trap WARNS ONCE/ },
  { id: 'trap-start-logged-every-attempt', file: TRAP, find: 'if (!warned.has(`${carrier.runId}@${carrier.pausedAt}:start`)) {', rep: 'if (true) {', tests: [T.trap], expect: /round-3 F6: a retried trap WARNS ONCE/ },
  { id: 'trap-no-task-notification-note', file: TRAP, find: '(now - (trapKilledAt.get(m.wsId) ?? Number.NEGATIVE_INFINITY) <= TASK_NOTIFICATION_WINDOW_MS', rep: '(false', tests: [T.trap], expect: /round-3 verifier MINOR/ },
  { id: 'trap-kill-stamp-missing', file: TRAP, find: '      if (rep.killed.length > 0) trapKilledAt.set(m.wsId, deps.now());\n', rep: '', tests: [T.trap], expect: /round-3 verifier MINOR/ },
  { id: 'snap-total-cap-ignored', file: SNAP, find: "for (let i = 0; i < rest.length && total > totalBytes; i++) {", rep: "for (let i = 0; i < 0; i++) {", tests: [T.snap], expect: /round-3 F7/ },
  // TWO edits: the exclude list capped (and always on argv) again — the pre-round-3 behaviour (file 201+ in the ref yet reported skipped)
  { id: 'snap-excludes-capped-again', file: SNAP, edits: [
    { find: 'if ((excludes.length <= MAX_ARGV_EXCLUDES && allUtf8) || legacyPathspec) {', rep: 'if (true) {' },
    { find: 'added = await viaArgv(legacyPathspec ? 1 + 200 : specs.length);', rep: 'added = await viaArgv(1 + 200);' },
  ], tests: [T.snap], expect: /round-3 F8: MORE than 200/ },
  { id: 'snap-real-index-pathspec-file', file: SNAP, find: "'--pathspec-file-nul'], env, undefined, [1], timeoutMs);", rep: "'--pathspec-file-nul'], {}, undefined, [1], timeoutMs);", tests: [T.snap], expect: /round-3 F8: MORE than 200/ },
  { id: 'snap-pathspec-file-not-nul', file: SNAP, find: ", '--pathspec-file-nul'], env, undefined, [1], timeoutMs);", rep: "], env, undefined, [1], timeoutMs);", tests: [T.snap], expect: /round-3 F8: MORE than 200/ },
  { id: 'status-bidi-not-stripped', file: 'src/cli/run-status.ts', find: "/[\\u0000-\\u001f\\u007f-\\u009f\\u00ad\\u061c\\u180e\\u200b-\\u200f\\u2028\\u2029\\u202a-\\u202e\\u2060-\\u2064\\u2066-\\u2069\\ufeff\\u{e0000}-\\u{e007f}]/gu", rep: "/[\\u0000-\\u001f\\u007f-\\u009f]/g", tests: [T.status], expect: /round-3 F8\/F7\/F5/ },
  { id: 'status-wording-reverted', file: 'src/cli/run-status.ts', find: 'shows the uncommitted non-ignored work)`);', rep: 'shows the uncommitted work)`);', tests: [T.status], expect: /round-3 F8\/F7\/F5/ },
  { id: 'status-earlier-kills-hidden', file: 'src/cli/run-status.ts', find: 'if (a?.earlierKilled?.length) out.push(', rep: 'if (false) out.push(', tests: [T.status], expect: /round-3 F8\/F7\/F5/ },
  // round-3 review fixes
  { id: 'procs-env-origin-own-start', file: PROCS, find: "      add(p, null, 99, 'env', origin);", rep: "      add(p, null, 99, 'env');", tests: [T.kill], expect: /round-3 F1a \(env orphans\)/ },
  { id: 'kill-cli-unreadable-ok', file: KILL, find: "    return c === 'gone' || c === 'unreadable' || c.startTicks !== cli.startTicks || c.state === 'Z';", rep: "    return c === 'gone' || (c !== 'unreadable' && (c.startTicks !== cli.startTicks || c.state === 'Z'));", tests: [T.kill], expect: /round-3 review .?#2/ },
  { id: 'snap-non-utf8-name-lstat', file: SNAP, find: "const st = fs.lstatSync(Buffer.concat([base, rel]));", rep: "const st = fs.lstatSync(Buffer.concat([base, rel]).toString('utf8'));", tests: [T.snap], expect: /round-3 review .?#4/ },
  { id: 'snap-non-utf8-through-argv', file: SNAP, find: 'if ((excludes.length <= MAX_ARGV_EXCLUDES && allUtf8) || legacyPathspec) {', rep: 'if (excludes.length <= MAX_ARGV_EXCLUDES || legacyPathspec) {', tests: [T.snap], expect: /round-3 review .?#4/ },
  { id: 'trap-earlier-kills-uncapped', file: TRAP, find: '.slice(-100); // bounded like observerKilled', rep: '; // uncapped', tests: [T.trap], expect: /round-3 review .?#3/ },
  { id: 'trap-deferral-count-not-carried', file: TRAP, find: '    if (prior.interruptDeferrals) activity.interruptDeferrals = prior.interruptDeferrals;\n', rep: '', tests: [T.trap], expect: /round-3 F2 \(carry\)/ },
  { id: 'trap-note-window-unbounded', file: TRAP, find: '<= TASK_NOTIFICATION_WINDOW_MS', rep: '<= 1e15', tests: [T.trap], expect: /round-3 verifier MINOR/ },
  { id: 'trap-kill-stamp-without-kills', file: TRAP, find: '      if (rep.killed.length > 0) trapKilledAt.set(m.wsId, deps.now());', rep: '      trapKilledAt.set(m.wsId, deps.now());', tests: [T.trap], expect: /round-3 verifier MINOR/ },
  { id: 'status-mb-integer', file: 'src/cli/run-status.ts', find: 'return `${m < 10 ? m.toFixed(1) : Math.round(m)} MB`;', rep: 'return `${Math.round(m)} MB`;', tests: [T.status], expect: /round-3 review nits/ },
  { id: 'status-skip-list-uncapped', file: 'src/cli/run-status.ts', find: 'a.skippedLarge.slice(0, 20).map(', rep: 'a.skippedLarge.map(', tests: [T.status], expect: /round-3 review nits/ },
  // ── fix round (review of pause-trap-followups): F1 perf/dir units, F2 carried pauser, F3i windows, F4 pins, F5b
  { id: 'snap-selectskipped-quadratic', file: SNAP, find: "  for (let i = 0; i < rest.length && total > totalBytes; i++) { // an index, never shift(): O(N), not O(N\u00b2) (240k files cost 150 s)\n    skipped.push({ ...rest[i], reason: 'total-cap' });\n    total -= rest[i].bytes;\n  }", rep: "  while (total > totalBytes && rest.length > 0) {\n    const f = rest.shift() as T;\n    skipped.push({ ...f, reason: 'total-cap' });\n    total -= f.bytes;\n  }", tests: [T.snap], expect: /round-3 F1 PERF: selectSkipped is linear/ },
  { id: 'snap-no-dir-collapse', file: SNAP, find: "'ls-files', '--others', '--exclude-standard', '--directory', '-z'", rep: "'ls-files', '--others', '--exclude-standard', '-z'", tests: [T.snap], expect: /round-3 F1/ },
  { id: 'snap-dir-bytes-not-summed', file: SNAP, find: "        unit.bytes += sz;\n", rep: "        unit.bytes += 0;\n", tests: [T.snap], expect: /round-3 F1: a wholly-untracked DIRECTORY/ },
  { id: 'snap-stored-uncapped', file: SNAP, find: "      .slice(0, SKIPPED_LARGE_STORED)\n", rep: "", tests: [T.snap], expect: /round-3 F8: MORE than 200/ },
  { id: 'snap-count-is-stored-length', file: SNAP, find: "skippedLargeCount: excluded.length", rep: "skippedLargeCount: skippedLarge.length", tests: [T.snap], expect: /round-3 F8: MORE than 200/ },
  { id: 'snap-legacy-lists-unapplied', file: SNAP, find: "const excluded = skipped.slice(0, applied);", rep: "const excluded = skipped;", tests: [T.snap], expect: /round-3 F4a/ },
  { id: 'snap-legacy-fallback-not-taken', file: SNAP, find: "      if (!(e instanceof GitError) || e.timedOut || e.exitCode !== 129 || !/unknown option/i.test(e.stderr) || !allUtf8) throw e;", rep: "      throw e;", tests: [T.snap], expect: /round-3 F4a/ },
  { id: 'snap-spec-file-in-worktree', file: SNAP, find: "const specFile = `${indexFile}.pathspec`;", rep: "const specFile = path.join(cwd, '.pt-spec');", tests: [T.snap], expect: /round-3 F8: MORE than 200/ },
  { id: 'kill-window-ignored', file: KILL, find: "    return (opts.humanWindows?.() ?? []).some((w) => ms >= w.from && (w.to === undefined || ms <= w.to));", rep: "    return false;", tests: [T.kill], expect: /round-3 F3i/ },
  { id: 'kill-window-end-unbounded', file: KILL, find: "(w.to === undefined || ms <= w.to)", rep: "true", tests: [T.kill], expect: /round-3 F3i/ },
  { id: 'kill-window-plan-filter-dropped', file: KILL, find: "    if (beforeMs() !== undefined || opts.humanWindows) {", rep: "    if (beforeMs() !== undefined) {", tests: [T.kill], expect: /round-3 F3i: a tool root started INSIDE/ },
  { id: 'kill-zombie-cli-ok', file: KILL, find: "|| c.startTicks !== cli.startTicks || c.state === 'Z';", rep: "|| c.startTicks !== cli.startTicks;", tests: [T.kill], expect: /round-3 F4d/ },
  { id: 'procs-origin-members-branch', file: PROCS, find: "        if (m) origin = Math.min(origin, m.rootStartTicks ?? m.startTicks);", rep: "        if (m) origin = origin;", tests: [T.kill], expect: /round-3 F4c \(origin walk, members branch\)/ },
  { id: 'procs-origin-env-ancestor-branch', file: PROCS, find: "        else if (q.startTicks > cli.startTicks && opts.claudePidOf(q) === cli.pid) origin = Math.min(origin, q.startTicks);", rep: "        else if (false) origin = origin;", tests: [T.kill], expect: /round-3 F1a \(env orphans, env-ancestor branch\)/ },
  { id: 'procs-origin-walk-never-breaks', file: PROCS, find: "        else break;\n      }\n      add(p, null, 99, 'env', origin);", rep: "        else continue;\n      }\n      add(p, null, 99, 'env', origin);", tests: [T.kill], expect: /round-3 F4c \(origin walk, never-break\)/ },
  { id: 'trap-pauser-not-carried', file: TRAP, find: "const carriedPauser = !pauser && target !== null && 'error' in target && prior?.exempt === 'pauser' && prior.pauserCli !== undefined;", rep: "const carriedPauser = false;", tests: [T.trap], expect: /round-3 F2 \(reviewer probe D1\)/ },
  { id: 'trap-pauser-cli-not-recorded', file: TRAP, find: "    activity.pauserCli = (target as { cli: RootRef }).cli;\n", rep: "", tests: [T.trap], expect: /round-3 F2 \(reviewer probe D1\)/ },
  { id: 'trap-window-not-passed', file: TRAP, find: "humanWindowsSince(m.wsId, carrier.pausedAt).map(", rep: "[].map(", tests: [T.trap], expect: /F2 a HUMAN turn that STARTS during the trap window|round-3 F1c\/F3i/ },
  { id: 'trap-window-before-pause-shielded', file: TRAP, find: ".filter((w) => w.from >= since)", rep: "", tests: [T.trap], expect: /round-3 F3i: markPauseHumanTurnEnd closes/ },
  { id: 'trap-window-never-closed', file: TRAP, find: "      w.to = now;\n      return;", rep: "      return;", tests: [T.trap], expect: /round-3 F3i: markPauseHumanTurnEnd closes|round-3 F1c\/F3i/ },
  { id: 'sdk-window-not-closed-at-release', file: SDK, find: "  session.gateTurnUuid = null;\n  if (session.gateTurnHuman) markPauseHumanTurnEnd(session.wsId); // closes the window the trap shields (round-3 F3i)", rep: "  session.gateTurnUuid = null;", tests: [T.wiring], expect: /round-2 F3: the session carries/ },
  { id: 'sdk-window-not-closed-at-force-release', file: SDK, find: "  if (session.gateTurnHuman) markPauseHumanTurnEnd(session.wsId);\n  session.gateTurnHuman = false;\n  openNext?.();\n  return true;", rep: "  session.gateTurnHuman = false;\n  openNext?.();\n  return true;", tests: [T.wiring], expect: /round-2 F3: the session carries/ },
  { id: 'trap-earlier-kills-for-complete', file: TRAP, find: "  if (incomplete && attemptKills.length > 0) merged.earlierKilled", rep: "  if (attemptKills.length > 0) merged.earlierKilled", tests: [T.trap], expect: /round-3 F4e/ },
  { id: 'status-notes-hidden', file: 'src/cli/run-status.ts', find: "for (const n of a?.snapshotNotes ?? [])", rep: "for (const n of [] as string[])", tests: [T.status], expect: /round-3 F1\/F4a/ },
  // ── pre-review of the fix round
  { id: 'snap-ignored-counted', file: SNAP, find: "['ls-files', '--others', '--exclude-standard', '-z'], env, timeoutMs)", rep: "['ls-files', '--others', '-z'], env, timeoutMs)", tests: [T.snap], expect: /round-3 review .?#1/ },
  { id: 'snap-selectskipped-dir-as-file-cap', file: SNAP, find: "files.filter((f) => !f.dir && f.bytes > perFileBytes)", rep: "files.filter((f) => f.bytes > perFileBytes)", tests: [T.snap], expect: /round-3 review .?#4/ },
  { id: 'snap-selectskipped-dir-not-counted', file: SNAP, find: "files.filter((f) => f.dir || f.bytes <= perFileBytes)", rep: "files.filter((f) => f.bytes <= perFileBytes)", tests: [T.snap], expect: /round-3 review .?#4/ },
  { id: 'trap-window-open-not-clamped', file: TRAP, find: "(w.to === undefined && !humanInFlightNow() ? { ...w, to: deps.now() } : w)", rep: "w", tests: [T.trap], expect: /round-3 review .?#5/ },
  { id: 'trap-window-end-closes-first', file: TRAP, find: "  for (let i = (ws?.length ?? 0) - 1; i >= 0; i--) {", rep: "  for (let i = 0; i < (ws?.length ?? 0); i++) {", tests: [T.trap], expect: /round-3 review .?#6/ },
  { id: 'sdk-window-closed-after-flag-clear', file: SDK, find: "  if (session.gateTurnHuman) markPauseHumanTurnEnd(session.wsId); // closes the window the trap shields (round-3 F3i)\n  session.gateTurnHuman = false;", rep: "  session.gateTurnHuman = false;\n  if (session.gateTurnHuman) markPauseHumanTurnEnd(session.wsId); // closes the window the trap shields (round-3 F3i)", tests: [T.wiring], expect: /round-2 F3: the session carries/ },
  { id: 'trap-prior-pauser-not-kept-on-provisional', file: TRAP, find: "    if (prior.exempt) activity.exempt = prior.exempt;\n    if (prior.pauserCli) activity.pauserCli = prior.pauserCli;\n", rep: "", tests: [T.trap], expect: /round-3 review .?#7/ },
  { id: 'trap-stale-exempt-not-cleared', file: TRAP, find: "    delete activity.exempt; // not a pauser on this attempt (proof gone / CLI replaced): never a stale label\n    delete activity.pauserCli;\n", rep: "", tests: [T.trap], expect: /round-3 review .?#7|F5 a RECYCLED CLI pid/ },
  // ── last delta: a git add TIMEOUT is not old git
  { id: 'snap-rebuild-after-timeout', file: SNAP, find: "      if (e instanceof GitError && e.timedOut) throw e; // a rebuild would only wait another full timeout (mapped to SnapshotTimeoutError by the caller)\n", rep: "", tests: [T.snap], expect: /round-4 \(verifier MAJOR\)/ },
  { id: 'snap-fallback-ignores-timeout', file: SNAP, find: "if (!(e instanceof GitError) || e.timedOut || e.exitCode !== 129", rep: "if (!(e instanceof GitError) || e.exitCode !== 129 && !e.timedOut", tests: [T.snap], expect: /round-4 review .?#2/ },
  { id: 'snap-fallback-takes-any-failure', file: SNAP, edits: [
    { find: "e.exitCode !== 129 || !/unknown option/i.test(e.stderr) || ", rep: "" },
  ], tests: [T.snap], expect: /round-4: the old-git fallback needs a USAGE error/ },
  { id: 'trap-timeout-not-flagged', file: TRAP, find: "        if (e instanceof Error && e.name === 'SnapshotTimeoutError') activity.snapshotIncomplete = 'timeout';\n", rep: "", tests: [T.trap], expect: /round-4: a snapshot TIMEOUT is recorded loud/ },
  { id: 'status-incomplete-hidden', file: 'src/cli/run-status.ts', find: "if (a?.snapshotIncomplete) out.push(", rep: "if (false) out.push(", tests: [T.status], expect: /round-4: a snapshot that timed out reads/ },
  // ── last delta, pre-review fixes
  { id: 'trap-timeout-snapshot-retried', file: TRAP, find: "if (!snapshotRef && prior?.snapshotIncomplete === 'timeout') errors.push(", rep: "if (false) errors.push(", tests: [T.trap], expect: /round-4 review .?#1/ },
  { id: 'snap-timeout-not-mapped-by-wrapper', file: SNAP, find: "    if (e instanceof GitError && e.timedOut) throw new SnapshotTimeoutError(input.gitTimeoutMs ?? GIT_TIMEOUT_MS, e.cmd);\n", rep: "", tests: [T.snap], expect: /round-4 \(verifier MAJOR\)|round-4 review .?#[235]/ },
  { id: 'snap-locale-not-forced', file: SNAP, find: "LC_ALL: 'C', ", rep: "", tests: [T.snap], expect: /round-4 review .?#4/ },
  { id: 'snap-listing-failure-swallowed', file: SNAP, find: "    if (e instanceof GitError && e.timedOut) throw e;\n    [collapsed, files] = await list(await headIndex());", rep: "    [collapsed, files] = [[], []];", tests: [T.snap], expect: /round-4 review .?#5: a ls-files TIMEOUT/ },
  { id: 'snap-update-ref-retries-timeout', file: SNAP, find: "if (attempt >= 5 || (e instanceof GitError && e.timedOut)) throw e;", rep: "if (attempt >= 5) throw e;", tests: [T.snap], expect: /round-4 review .?#5: a timeout in update-ref/ },
  { id: 'trap-live-chain-never-climbs', file: TRAP, find: '    cur = node.parentId;\n', rep: '    cur = undefined;\n', tests: [T.trap], expect: /liveChainIncludes/ },
  { id: 'trap-live-chain-no-cycle-guard', file: TRAP, find: 'while (cur !== undefined && !seen.has(cur)) {', rep: 'while (cur !== undefined) {\n    if (seen.has(cur)) return { includes: true, dangling: false };', tests: [T.trap], expect: /liveChainIncludes/ },
  { id: 'wire-reattach-turn-not-flagged', file: SDK, find: '                  live.unexplainedTurnSeen = true;\n                  notifyTurnStart(wsId);\n', rep: '                  notifyTurnStart(wsId);\n', tests: [T.wiring], expect: /keeper REATTACH with a turn in flight/ },
  { id: 'wire-host-observer-pty-too', file: HOST, find: '    if (sdkPauseActivity(wsId) === null) return; // no live structured session ⇒ nothing the trap can own\n', rep: '', tests: [T.wiring], expect: /host observer stands down/ },
];

const sel = ONLY ? M.filter((m) => ONLY_SET.has(m.id)) : M;
if (sel.length === 0) { console.error(`unknown mutant ${ONLY}`); process.exit(2); }

// --anchors-only: every anchor must match the CURRENT source exactly once (cheap; run after ANY edit of a mutated clause — a stale anchor is PATTERN-GONE, never a pass).
if (process.argv.includes('--anchors-only')) {
  let gone = 0;
  for (const m of sel) {
    const src = fs.readFileSync(path.join(REPO, m.file), 'utf8');
    for (const e of (m.edits ?? [{ find: m.find }])) {
      const hits = src.split(e.find).length - 1;
      if (hits !== 1) { gone++; console.log(`✗ ${m.id}: anchor matched ${hits}× in ${m.file}: ${e.find.slice(0, 70)}`); }
    }
  }
  // the LOAD-TIME mutants of the real-path rigs (mutants.mjs, regex anchors) too — a stale one only surfaced as "rig broke under the mutant" at the very end of a battery
  if (!ONLY) {
    const { MUTANTS } = await import('./mutants.mjs');
    for (const [id, m] of Object.entries(MUTANTS)) {
      const src = fs.readFileSync(path.join(REPO, m.file), 'utf8');
      for (const e of (m.edits ?? [{ find: m.find }])) {
        const hits = [...src.matchAll(e.find)].length;
        if (hits !== 1) { gone++; console.log(`✗ load-time ${id}: anchor matched ${hits}× in ${m.file}: ${String(e.find).slice(0, 80)}`); }
      }
    }
  }
  // every `expect` regex must match the TITLE of at least one test in the mutant's own files — an expect naming a renamed/missing test can never be "caught" and makes the whole run FAIL at the very end
  const titlesOf = (f) => [...fs.readFileSync(path.join(REPO, f), 'utf8').matchAll(/\btest\((['"`])((?:\\.|(?!\1)[^\\])*)\1/g)].map((x) => x[2].replace(/\\'/g, "'"));
  for (const m of sel) {
    const titles = m.tests.flatMap(titlesOf);
    // the harness matches the TAP output, where `#` is printed as `\#`
    if (!titles.some((t) => m.expect.test(t.replace(/#/g, '\\#')))) { gone++; console.log(`✗ ${m.id}: expect ${m.expect} matches no test title in ${m.tests.join(', ')}`); }
  }
  console.log(`ANCHORS: ${gone === 0 ? 'OK' : 'FAIL'} (${sel.length} mutants, ${gone} stale)`);
  process.exit(gone === 0 ? 0 : 1);
}

// ASYNC on purpose: a synchronous spawn keeps the event loop busy for the whole run, so the SIGINT/SIGTERM restore handler below could never fire and a killed harness left the source MUTATED.
function runTests(files) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--test', '--experimental-strip-types', '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', ...files], { cwd: REPO });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    const timer = setTimeout(() => child.kill('SIGKILL'), 240_000);
    child.on('close', () => { clearTimeout(timer); resolve(parseRun(out)); });
  });
}

function parseRun(out) {
  const fail = Number(/^# fail (\d+)/m.exec(out)?.[1] ?? NaN);
  const pass = Number(/^# pass (\d+)/m.exec(out)?.[1] ?? NaN);
  const red = [...out.matchAll(/^not ok \d+ - (.+)$/gm)].map((m) => m[1]);
  return { fail, pass, red, raw: out };
}

function rebuildCli() {
  const r = spawnSync('pnpm', ['run', 'build:cli'], { cwd: REPO, encoding: 'utf8', timeout: 120_000 });
  if (r.status !== 0) { console.error(`build:cli failed rc=${r.status}: ${(r.stderr ?? '').slice(-300)}`); process.exit(3); }
}
// Gate 0: a clean control over every file any mutant uses — a tree that is already red proves nothing.
const allFiles = [...new Set(sel.flatMap((m) => m.tests))];
const control = await runTests(allFiles);
console.log(`control (clean tree, ${allFiles.length} files): pass ${control.pass}, fail ${control.fail}`);
if (control.fail !== 0 || !(control.pass > 0)) { console.log(`MUTATE-UNIT: FAIL — the clean control is not green (${control.red.join(' | ')})`); process.exit(1); }

let caught = 0;
const bak = fs.mkdtempSync(path.join(os.tmpdir(), 'mutate-unit-'));
// A harness killed mid-mutant would leave the source MUTATED (a `finally` does not run on a signal): restore on SIGINT/SIGTERM.
let activeRestore = null;
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => { try { activeRestore?.(); } catch { /* best effort */ } process.exit(130); });
for (const m of sel) {
  const abs = path.join(REPO, m.file);
  const backup = path.join(bak, `${m.id}.bak`);
  fs.copyFileSync(abs, backup);
  const src = fs.readFileSync(abs, 'utf8');
  const edits = m.edits ?? [{ find: m.find, rep: m.rep }];
  const bad = edits.map((e) => ({ e, hits: src.split(e.find).length - 1 })).find((x) => x.hits !== 1);
  if (bad) { console.log(`✗ ${m.id}: PATTERN-GONE — anchor matched ${bad.hits}× in ${m.file} (want exactly 1): ${bad.e.find.slice(0, 70)}`); continue; }
  let res;
  activeRestore = () => fs.copyFileSync(backup, abs);
  try {
    fs.writeFileSync(abs, edits.reduce((acc, e) => acc.replace(e.find, () => e.rep), src));
    if (m.build) rebuildCli(); // the tests EXEC the built bundle: a stale one would run the unmutated code (vacuous survivor)
    res = await runTests(m.tests);
  } finally {
    fs.copyFileSync(backup, abs); // byte-exact restore
    activeRestore = null;
    if (m.build) rebuildCli(); // and never leave a mutated bundle behind
  }
  const restored = spawnSync('cmp', [abs, backup]).status === 0;
  const named = res.red.filter((n) => m.expect.test(n));
  const ok = restored && res.red.length > 0 && named.length > 0;
  if (ok) caught++;
  console.log(`${ok ? '✓' : '✗'} ${m.id}: ${res.red.length} red${named.length ? ` — named arm: ${named[0].slice(0, 90)}` : res.red.length ? ` — RED BUT NOT THE EXPECTED ARM (${res.red[0].slice(0, 80)})` : ' — SURVIVED'}${restored ? '' : ' — RESTORE FAILED'}`);
}
const gitDirty = spawnSync('git', ['diff', '--quiet', '--', ...[...new Set(sel.map((m) => m.file))]], { cwd: REPO }).status;
fs.rmSync(bak, { recursive: true, force: true });
const post = await runTests(allFiles);
console.log(`post-restore control: pass ${post.pass}, fail ${post.fail}; changed vs index for mutated files: ${gitDirty === 0 ? 'no (only what was already uncommitted)' : 'see git diff (uncommitted edits exist)'}`);
const ok = caught === sel.length && post.fail === 0;
console.log(`MUTATE-UNIT: ${ok ? 'PASS' : 'FAIL'} (${caught}/${sel.length} caught)`);
process.exit(ok ? 0 : 1);
