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
import { spawnSync } from 'node:child_process';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ONLY = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : null;
const SNAP = 'src/main/pause-snapshot.ts', PROCS = 'src/shared/pause-procs.ts', KILL = 'src/main/pause-kill.ts', TRAP = 'src/main/pause-trap.ts', REC = 'src/main/bus-pause-records.ts';
const IDX = 'src/main/index.ts', SDK = 'src/main/agent-sdk.ts', ACT = 'src/main/activity.ts', HOST = 'src/main/pause-trap-host.ts';
const T = { wiring: 'src/main/pause-trap-wiring.test.ts', snap: 'src/main/pause-snapshot.test.ts', procs: 'src/shared/pause-procs.test.ts', kill: 'src/main/pause-kill.test.ts', trap: 'src/main/pause-trap.test.ts', status: 'src/cli/run-status.test.ts', runpause: 'src/cli/run-pause.test.ts' };

const M = [
  // ── snapshot (pause-snapshot.ts)
  { id: 'snap-real-index', file: SNAP, find: "await git(cwd, ['add', '-A', '--ignore-errors', '--', ...pathspec], env, undefined, [1]);", rep: "await git(cwd, ['add', '-A', '--ignore-errors', '--', ...pathspec], {}, undefined, [1]);", tests: [T.snap], expect: /NO-TOUCH|captures unstaged/ },
  { id: 'snap-large-files-captured', file: SNAP, find: 'if (st.isFile() && st.size > SNAPSHOT_MAX_UNTRACKED_BYTES) out.push', rep: 'if (false && st.isFile() && st.size > SNAPSHOT_MAX_UNTRACKED_BYTES) out.push', tests: [T.snap], expect: /over the size cap/ },
  { id: 'snap-ref-overwrite', file: SNAP, find: "await git(cwd, ['update-ref', ref, commit, ''], env);", rep: "await git(cwd, ['update-ref', ref, commit], env);", tests: [T.snap], expect: /same `at` twice/ },
  { id: 'snap-no-parent', file: SNAP, find: "...(head ? ['-p', head] : []), '-F', '-'", rep: "'-F', '-'", tests: [T.snap], expect: /captures unstaged|unborn|clean worktree/ },
  { id: 'snap-no-torn-index-fallback', file: SNAP, find: '      tree = await buildTree(cwd, tmp.file, false, head, excludes, warnings);', rep: "      throw new Error('no fallback');", tests: [T.snap], expect: /corrupt\/torn/ },
  { id: 'snap-dirty-always-false', file: SNAP, find: 'const dirty = headTree === null ? true : headTree !== tree;', rep: 'const dirty = false;', tests: [T.snap, T.trap], expect: /captures unstaged|unborn|ORDER \+ CONTENT/ },
  { id: 'snap-runs-repo-hooks', file: SNAP, find: "'-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args],", rep: "'-c', 'commit.gpgsign=false', ...args],", tests: [T.snap], expect: /HOOKS never run/ },
  { id: 'snap-abort-on-unreadable', file: SNAP, find: "['add', '-A', '--ignore-errors', '--', ...pathspec], env, undefined, [1]", rep: "['add', '-A', '--', ...pathspec], env, undefined, []", tests: [T.snap], expect: /unreadable untracked file/i },
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
  { id: 'procs-env-planner-pid-unmatched', file: PROCS, find: "      if (opts.claudePidOf(p) === cli.pid) add(p, null, 99, 'env');", rep: "      if (opts.claudePidOf(p) !== null) add(p, null, 99, 'env');", tests: [T.procs], expect: /env provenance/ },
  { id: 'procs-env-evidence-dropped', file: PROCS, find: "      evidence: `re-read now: environ CLAUDE_PID=${env} == CLI ${plan.cli.pid} whose start-time ${plan.cli.startTicks} was just re-verified; process started after it (${fresh.startTicks} > ${plan.cli.startTicks})`,", rep: "      evidence: '',", tests: [T.procs], expect: /D11: planner records cwd/ },
  { id: 'kill-cwd-not-recorded', file: KILL, find: '    cwdOf: (p: ProcIdent) => deps.readCwd(p.pid),\n', rep: '', tests: [T.kill], expect: /listed with its cmdline, cwd/ },
  { id: 'procs-env-keeper-member', file: PROCS, find: 'p.pid === cliNow.ppid || p.pid <= 1 || ', rep: '', tests: [T.procs], expect: /never makes the CLI a member/ },
  { id: 'procs-env-verify-ignores-marker', file: PROCS, find: '  if (env === plan.cli.pid && fresh.startTicks > plan.cli.startTicks) {', rep: '  if (true) {', tests: [T.procs], expect: /env path/ },
  // ── killer (pause-kill.ts)
  { id: 'kill-no-sigkill-escalation', file: KILL, find: "      if (v.ok && deps.signal(m.pid, 'SIGKILL')) {", rep: '      if (false) {', tests: [T.kill], expect: /SIGTERM ignored/ },
  // TWO LAYERS cover each other here (isAlive's identity read + verifyAtSignal): each alone survives, so the mutant removes BOTH.
  { id: 'kill-no-second-identity-reread', file: KILL, edits: [
    { find: "      if (!isAlive(m, deps)) continue;\n      // SIGTERM was ignored/slow", rep: "      // SIGTERM was ignored/slow" },
    { find: "      const v = verifyAtSignal(m, plan, protect, deps.read, deps.readClaudePid);\n      if (v.ok && deps.signal(m.pid, 'SIGKILL')) {", rep: "      const v = { ok: true as const, via: 'chain' as const };\n      if (v.ok && deps.signal(m.pid, 'SIGKILL')) {" },
  ], tests: [T.kill], expect: /between SIGTERM and SIGKILL/ },
  { id: 'kill-unbounded-rounds', file: KILL, find: 'for (let round = 1; round <= maxRounds; round++) {', rep: 'for (let round = 1; round <= maxRounds + 5; round++) {', tests: [T.kill], expect: /keeps respawning/ },
  { id: 'kill-no-replan', file: KILL, find: '    if (signalled === 0) break; // nothing provable to signal: more rounds cannot change that', rep: '    break;', tests: [T.kill], expect: /spawned WHILE killing|keeps respawning/ },
  // ── orchestrator (pause-trap.ts) + records
  { id: 'trap-no-pauser-exemption', file: TRAP, find: "  const exempt = carrier.pausedBy !== null && isCoordinatorHandle(carrier.pausedBy, m.wsId);", rep: '  const exempt = false;', tests: [T.trap], expect: /PAUSER is exempt/ },
  { id: 'trap-interrupt-after-kill', file: TRAP, find: "    try {\n      activity.interrupt = await deps.interrupt(m);\n    } catch (e) {\n      activity.interrupt = 'failed';\n      errors.push(`interrupt: ${errMsg(e)}`);\n    }\n", rep: '', tests: [T.trap], expect: /ORDER \+ CONTENT|PAUSER|surviving/ },
  { id: 'trap-no-lift-check-before-kill', file: TRAP, find: "    if (deps.settleMs > 0) await deps.sleep(deps.settleMs);\n    if (!stillPaused(db, carrier)) return;\n    // 4.", rep: "    if (deps.settleMs > 0) await deps.sleep(deps.settleMs);\n    // 4.", tests: [T.trap], expect: /LIFT landing DURING the interrupt/ },
  { id: 'trap-members-without-descendants', file: TRAP, find: 'const members = deps.members(runSubtreeIds(db, carrier.runId), carrier.runId);', rep: 'const members = deps.members([carrier.runId], carrier.runId);', tests: [T.trap], expect: /DESCENDANTS/ },
  { id: 'trap-human-mark-reusable', file: TRAP, find: '  humanTurnMarks.delete(wsId);\n', rep: '', tests: [T.trap], expect: /HUMAN prompt is ALLOWED/ },
  { id: 'trap-sweep-not-reentrant', file: TRAP, find: '    if (inflight.has(key)) continue;\n', rep: '', tests: [T.trap], expect: /SWEEP/ },
  { id: 'trap-always-resnapshot', file: TRAP, find: '  if (!snapshotRef) {\n    if (!m.worktreePath)', rep: '  if (true) {\n    if (!m.worktreePath)', tests: [T.trap], expect: /BOOT COMPLETION/ },
  { id: 'trap-done-member-redone', file: TRAP, find: '  if (existing && existing.killed !== null) return; // already fully trapped (boot completion after a mid-trap quit)\n', rep: '', tests: [T.trap], expect: /BOOT COMPLETION/ },
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
  { id: 'trap-observer-ignores-carrierFor', file: TRAP, find: '    if (deps.carrierFor) carrier = deps.carrierFor(m);', rep: '    if (false) carrier = deps.carrierFor!(m);', tests: [T.trap], expect: /carrierFor/ },
  { id: 'wire-observer-not-gate-decision', file: HOST, find: 'return db && ws ? pausedCarrierForWorkspace(db, ws, (id) => store.getWorkspace(id)) : null;', rep: 'return null;', tests: [T.wiring], expect: /UNION|live parent chain|membership/ },
  { id: 'trap-observer-pauser-exempt', file: TRAP, find: "    if (consumeHumanMark(m.wsId, deps.now())) return 'allowed';\n", rep: "    if (consumeHumanMark(m.wsId, deps.now())) return 'allowed';\n    if (carrier.pausedBy !== null && isCoordinatorHandle(carrier.pausedBy, m.wsId)) return 'allowed';\n", tests: [T.trap], expect: /pauser is spared only the PAUSE-TIME/ },
  { id: 'trap-burst-dropped', file: TRAP, find: '        if (!st.again) break;\n', rep: '        break;\n', tests: [T.trap], expect: /COALESCED, not dropped/ },
  { id: 'trap-burst-parallel', file: TRAP, find: '    if (st.running) {\n      st.again = true;', rep: '    if (false) {\n      st.again = true;', tests: [T.trap], expect: /COALESCED, not dropped/ },
  { id: 'trap-members-unbounded', file: TRAP, find: 'Math.min(deps.concurrency ?? 3, members.length)', rep: 'members.length', tests: [T.trap], expect: /PARALLEL/ },
  { id: 'trap-members-serial', file: TRAP, find: 'Math.min(deps.concurrency ?? 3, members.length)', rep: '1', tests: [T.trap], expect: /PARALLEL/ },
  { id: 'trap-no-arm-in-trap', file: TRAP, find: '  await deps.arm?.(m).catch((e) => errors.push(`arm: ${errMsg(e)}`));\n', rep: '', tests: [T.trap], expect: /arm: every member/ },
  { id: 'trap-arm-failure-blocks', file: TRAP, find: '  await deps.arm?.(m).catch((e) => errors.push(`arm: ${errMsg(e)}`));', rep: '  await deps.arm?.(m);', tests: [T.trap], expect: /arm failure is recorded/ },
  { id: 'trap-arm-pass-owed-only', file: TRAP, find: '    carriers = activePauseCarriers(db);', rep: '    carriers = activePauseCarriers(db).filter((c) => c.trapAt === null);', tests: [T.trap], expect: /arm: every member/ },
  { id: 'rec-active-ignores-switch', file: REC, find: '    .filter((r) => parseSwitches((r.flags_json as string | null | undefined) ?? null).pause === true)\n', rep: '', tests: [T.trap], expect: /activePauseCarriers honours the FROZEN switch/ },
  { id: 'rec-latest-bilan-oldest', file: REC, find: "  const recent = db.prepare('SELECT * FROM pause_records ORDER BY id DESC LIMIT 500').all() as RawRow[];", rep: "  const recent = db.prepare('SELECT * FROM pause_records ORDER BY id ASC LIMIT 500').all() as RawRow[];", tests: [T.trap], expect: /latestPauseBilanFor/ },
  { id: 'status-lastpause-never-read', file: 'src/cli/run-status.ts', find: '  const last = pause ? null : (deps.latestPauseBilan?.(db, runId) ?? null);', rep: '  const last = null as ReturnType<NonNullable<RunStatusDeps[\'latestPauseBilan\']>>;', tests: [T.status], expect: /AFTER the lift/ },
  { id: 'trap-observer-kills-unrecorded', file: TRAP, find: '          appendObserverKills(db, carrier.runId, m.wsId, carrier.pausedAt, rep.killed);\n', rep: '', tests: [T.trap], expect: /what the turn observer KILLS/ },
  { id: 'trap-final-write-drops-observer-kills', file: TRAP, find: '    ...(fresh?.activity?.observerKilled ? { observerKilled: fresh.activity.observerKilled } : {}),\n', rep: '', tests: [T.trap], expect: /DURING the trap/ },
  { id: 'trap-provisional-row-blind-overwrite', file: TRAP, find: '  if (cur?.activity?.observerKilled) activity.observerKilled = cur.activity.observerKilled;\n', rep: '', tests: [T.trap], expect: /what the turn observer KILLS/ },
  // ── review round (F1 F2 F4 F5 F8 F9 F10)
  { id: 'procs-supervisor-guard-planner', file: PROCS, find: "    if (via !== 'tree' && hasSupervisor(p.pid)) {", rep: "    if (false && hasSupervisor(p.pid)) {", tests: [T.procs], expect: /F1: an env-proven orphan that IS or HAS/ },
  { id: 'procs-supervisor-guard-verify', file: PROCS, find: "  if (target.via !== 'tree' && isSupervisorProc(fresh)) return { ok: false, reason: 'supervisor (keeper / claude CLI / Orchestra app of another session)' };\n", rep: '', tests: [T.procs], expect: /F1: the signal-time re-read refuses a keeper/ },
  { id: 'procs-session-root-start-optional', file: PROCS, find: '    const rootOk = rootStart !== undefined && (root ===', rep: '    const rootOk = (root ===', tests: [T.procs], expect: /F9/ },
  { id: 'kill-no-pause-check-round', file: KILL, find: '    if (!paused()) break;\n    const plan: ToolPlan = planNow();', rep: '    const plan: ToolPlan = planNow();', tests: [T.kill], expect: /F8: a lift landing mid-kill/ },
  { id: 'kill-no-pause-check-signal', file: KILL, find: '      if (!paused()) break;\n      const v = verifyAtSignal(m, plan, protect, deps.read, deps.readClaudePid);\n      if (!v.ok) {', rep: '      const v = verifyAtSignal(m, plan, protect, deps.read, deps.readClaudePid);\n      if (!v.ok) {', tests: [T.kill], expect: /F8: a lift landing mid-kill/ },
  { id: 'kill-no-pause-check-sigkill', file: KILL, find: '      if (!isAlive(m, deps)) continue;\n      if (!paused()) break;', rep: '      if (!isAlive(m, deps)) continue;', tests: [T.kill], expect: /F8: the SIGKILL escalation re-checks/ },
  { id: 'kill-startedbefore-ignored', file: KILL, find: '    if (opts.startedBeforeMs !== undefined) {', rep: '    if (false) {', tests: [T.kill], expect: /F2: startedBeforeMs spares/ },
  { id: 'kill-sparerooots-ignored', file: KILL, find: '    if (opts.spareRoots?.length) {', rep: '    if (false) {', tests: [T.kill], expect: /F5: spareRoots spares/ },
  { id: 'trap-incomplete-reads-complete', file: TRAP, find: "  return incomplete ? 'incomplete' : 'complete';", rep: "  return 'complete';", tests: [T.trap], expect: /F4 UNKNOWN is not NONE|F4 a FAILED/ },
  { id: 'trap-incomplete-writes-killed', file: TRAP, find: '  updateBilan(db, rowId, { activity: merged, killed: incomplete ? null : killed,', rep: '  updateBilan(db, rowId, { activity: merged, killed: killed ?? { skipped: \'incomplete\' },', tests: [T.trap], expect: /F4 UNKNOWN is not NONE/ },
  { id: 'trap-pauser-by-handle', file: TRAP, find: '  const pauser = spareRoot !== undefined;', rep: '  const pauser = spareRoot !== undefined || (carrier.pausedBy !== null && isCoordinatorHandle(carrier.pausedBy, m.wsId));', tests: [T.trap], expect: /F5 a pause typed by a HUMAN/ },
  { id: 'trap-origin-start-time-ignored', file: TRAP, find: '(p) => p.pid === target.cli.pid && p.startTicks === target.cli.startTicks', rep: '(p) => p.pid === target.cli.pid', tests: [T.trap], expect: /F5 a RECYCLED CLI pid/ },
  { id: 'trap-pauser-spares-nothing', file: TRAP, find: "        ...(spareRoot !== undefined ? { spareRoots: [spareRoot] } : {}),\n", rep: '', tests: [T.trap], expect: /F5 the PAUSER/ },
  { id: 'trap-pauser-interrupted', file: TRAP, find: "  if (pauser) activity.interrupt = 'exempt';\n  else if (humanDuringTrap) {", rep: "  if (false) activity.interrupt = 'exempt';\n  else if (humanDuringTrap) {", tests: [T.trap], expect: /F5 the PAUSER/ },
  { id: 'trap-origin-not-awaited', file: TRAP, find: '    if (carrier.pausedAt + limit < start || deps.now() - start >= limit) return null;', rep: '    return null;', tests: [T.trap], expect: /F5 a RECENT pause waits/ },
  { id: 'trap-zero-members-stamped', file: TRAP, find: '  if (members.length === 0) {', rep: '  if (false) {', tests: [T.trap], expect: /F10 ZERO members/ },
  { id: 'trap-store-not-ready-ignored', file: TRAP, find: '  if (deps.storeReady && !deps.storeReady()) {', rep: '  if (false) {', tests: [T.trap], expect: /F10 ZERO members/ },
  { id: 'trap-human-window-ignored', file: TRAP, find: '  const humanDuringTrap = humanAtInterrupt !== undefined && humanAtInterrupt >= trapStart;', rep: '  const humanDuringTrap = false;', tests: [T.trap], expect: /F2 a HUMAN turn that STARTS during the trap window/ },
  { id: 'trap-human-mark-only-first', file: TRAP, find: '    const at = marks.shift() as number;\n    if (now - at <= HUMAN_MARK_TTL_MS) {\n      humanTurnMarks.set(wsId, marks);', rep: '    const at = marks.shift() as number;\n    if (now - at <= HUMAN_MARK_TTL_MS) {\n      marks.length = 0;\n      humanTurnMarks.set(wsId, marks);', tests: [T.trap], expect: /F2 a human prompt PARKED/ },
  { id: 'trap-observer-no-lift-recheck', file: TRAP, find: '        if (round > 0 && !resolveCarrier(deps, db, m)) break; // lifted meanwhile (review F8): never touch a turn the lift just released\n', rep: '', tests: [T.trap], expect: /F8 the turn observer stops/ },
  { id: 'trap-observer-no-stillpaused-opt', file: TRAP, find: '{ stillPaused: () => resolveCarrier(deps, db, m) !== null }', rep: '{}', tests: [T.trap], expect: /F8 the turn observer stops/ },
  { id: 'rec-origin-listed-as-member', file: REC, find: '  return rows.map(toRow).filter((r) => r.wsId !== PAUSE_ORIGIN_WS);', rep: '  return rows.map(toRow);', tests: [T.trap], expect: /F5 the PAUSER/ },
  { id: 'trap-retry-blanks-error', file: TRAP, find: "errors.length ? errors.join('; ') : (cur.error ?? null) }), cur.id)", rep: "errors.length ? errors.join('; ') : null }), cur.id)", tests: [T.trap], expect: /F4 a RETRY keeps/ },
  { id: 'status-control-chars-not-stripped', file: 'src/cli/run-status.ts', find: "  const clean = s.replace(/[\\u0000-\\u001f\\u007f-\\u009f]/g, ' ');", rep: '  const clean = s;', tests: [T.status], expect: /F11/ },
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
  { id: 'trap-no-lift-check-before-interrupt', file: TRAP, find: "  if (!stillPaused(db, carrier)) return 'lifted';\n  let killed: unknown = null;", rep: '  let killed: unknown = null;', tests: [T.trap], expect: /M7 a LIFT landing while the trap arms/ },
  { id: 'trap-lifted-kill-report-dropped', file: TRAP, find: "        updateBilan(db, rowId, { activity, killed: rep, error: errors.length ? errors.join('; ') : null });\n        return 'lifted';", rep: "        return 'lifted';", tests: [T.trap], expect: /M7 a lift DURING the kill step/ },
  { id: 'trap-human-window-anchored-on-trap-start', file: TRAP, find: 'humanAtInterrupt >= carrier.pausedAt;', rep: 'humanAtInterrupt >= deps.now();', tests: [T.trap], expect: /M5 a human turn that started AFTER the pause/ },
  { id: 'kill-human-cutoff-read-once', file: KILL, find: '      if (tooNew(m)) continue; // started after a human turn that began mid-kill\n', rep: '', tests: [T.kill], expect: /M5: startedBeforeMs as a GETTER/ },
  { id: 'trap-pre-pause-mark-admits-turn', file: TRAP, find: 'if (now - at <= HUMAN_MARK_TTL_MS && at >= notBefore) {', rep: 'if (now - at <= HUMAN_MARK_TTL_MS) {', tests: [T.trap], expect: /M4 a human mark from BEFORE the pause/ },
  { id: 'trap-own-arm-turn-start-not-ignored', file: TRAP, find: "    if (trapArming.has(m.wsId)) return 'skipped'; // the member trap's own arm() attach fired this start: trapMember handles the turn (pauser-aware)\n", rep: '', tests: [T.trap], expect: /M9 the turn start fired by THIS trap/ },
  { id: 'trap-arm-hang-not-incomplete', file: TRAP, find: '    if (e instanceof DeadlineError) incompleteEarly = true;', rep: '', tests: [T.trap], expect: /M8 a HUNG arm/ },
  { id: 'host-unknown-keeper-is-none', file: HOST, find: "(ks === 'keeper' || ks === 'unknown')", rep: "(ks === 'keeper')", tests: [T.wiring], expect: /unknown/ },
  { id: 'sdk-unknown-keeper-is-idle', file: SDK, find: "return ks === 'keeper' || ks === 'unknown' ? 'unresponsive' : 'idle';", rep: "return ks === 'keeper' ? 'unresponsive' : 'idle';", tests: [T.wiring], expect: /unknown/ },
  { id: 'status-orphan-cwd-raw', file: 'src/cli/run-status.ts', find: "pid ${c(o.pid)} cwd ${c(o.cwd ?? '?')} — ${c(o.evidence ?? '')}`);\n        }\n        if (k.survivors", rep: "pid ${c(o.pid)} cwd ${o.cwd ?? '?'} — ${o.evidence ?? ''}`);\n        }\n        if (k.survivors", tests: [T.status], expect: /F11 \(round 2\)/ },
  { id: 'status-error-raw', file: 'src/cli/run-status.ts', find: 'out.push(`      error: ${c(r.error)}`);', rep: 'out.push(`      error: ${r.error}`);', tests: [T.status], expect: /F11 \(round 2\)/ },
  { id: 'status-note-raw', file: 'src/cli/run-status.ts', find: 'out.push(`      note: ${c(n)}`);', rep: 'out.push(`      note: ${n}`);', tests: [T.status], expect: /F11 \(round 2\)/ },
  { id: 'trap-live-chain-never-climbs', file: TRAP, find: '    cur = node.parentId;\n', rep: '    cur = undefined;\n', tests: [T.trap], expect: /liveChainIncludes/ },
  { id: 'trap-live-chain-no-cycle-guard', file: TRAP, find: 'while (cur !== undefined && !seen.has(cur)) {', rep: 'while (cur !== undefined) {\n    if (seen.has(cur)) return { includes: true, dangling: false };', tests: [T.trap], expect: /liveChainIncludes/ },
  { id: 'wire-reattach-turn-not-flagged', file: SDK, find: '                  live.unexplainedTurnSeen = true;\n                  notifyTurnStart(wsId);\n', rep: '                  notifyTurnStart(wsId);\n', tests: [T.wiring], expect: /keeper REATTACH with a turn in flight/ },
  { id: 'wire-host-observer-pty-too', file: HOST, find: '    if (sdkPauseActivity(wsId) === null) return; // no live structured session ⇒ nothing the trap can own\n', rep: '', tests: [T.wiring], expect: /host observer stands down/ },
];

const sel = ONLY ? M.filter((m) => m.id === ONLY) : M;
if (sel.length === 0) { console.error(`unknown mutant ${ONLY}`); process.exit(2); }

function runTests(files) {
  const r = spawnSync(process.execPath, ['--test', '--experimental-strip-types', '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', ...files], { cwd: REPO, encoding: 'utf8', timeout: 240_000 });
  const out = (r.stdout ?? '') + (r.stderr ?? '');
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
const control = runTests(allFiles);
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
    res = runTests(m.tests);
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
const post = runTests(allFiles);
console.log(`post-restore control: pass ${post.pass}, fail ${post.fail}; changed vs index for mutated files: ${gitDirty === 0 ? 'no (only what was already uncommitted)' : 'see git diff (uncommitted edits exist)'}`);
const ok = caught === sel.length && post.fail === 0;
console.log(`MUTATE-UNIT: ${ok ? 'PASS' : 'FAIL'} (${caught}/${sel.length} caught)`);
process.exit(ok ? 0 : 1);
