// In-place UNIT mutants of the Pause douce (#254, wave E ledger #276 G2) — merged into scripts/pause-trap/mutate-unit.mjs's list (same harness:
// byte-exact backup + `cmp`, clean control before/after, every anchor must match EXACTLY ONCE, the named test must go RED).
// `expect` = a regex over the TITLE of a test in `tests`.
const D = 'src/main/pause-douce.ts', BP = 'src/main/bus-pause.ts', TRAP = 'src/main/pause-trap.ts', WS = 'src/main/workspaces.ts', IDX = 'src/cli/index.ts', RS = 'src/cli/run-status.ts';
const UT = 'src/main/pause-douce.test.ts', CT = 'src/cli/run-pause-douce.test.ts';

export const DOUCE_UNIT_MUTANTS = [
  // ── the escalation
  { id: 'douce-no-deadline-escalation', file: D, find: '  if (allConfirmed || now >= deadline) {', rep: '  if (allConfirmed) {', tests: [UT], expect: /ESCALATION deadline/ },
  { id: 'douce-deadline-off-by-one', file: D, find: '  if (allConfirmed || now >= deadline) {', rep: '  if (allConfirmed || now > deadline) {', tests: [UT], expect: /ESCALATION deadline/ },
  { id: 'douce-escalate-on-any-accusé', file: D, find: 'const allConfirmed = members.length > 0 && sum.confirmed === members.length;', rep: 'const allConfirmed = members.length > 0 && sum.confirmed > 0;', tests: [UT], expect: /ESCALATION all-confirmed: partial accusés/ },
  { id: 'douce-zero-members-is-all-confirmed', file: D, find: 'const allConfirmed = members.length > 0 && sum.confirmed === members.length;', rep: 'const allConfirmed = sum.confirmed === members.length;', tests: [UT], expect: /UNKNOWN is not NONE/ },
  { id: 'douce-escalate-wrong-epoch', file: D, find: "WHERE id = ? AND paused_at = ? AND pause_mode = 'soft' AND pause_escalated_at IS NULL", rep: "WHERE id = ? AND ? IS NOT NULL AND pause_mode = 'soft' AND pause_escalated_at IS NULL", tests: [UT], expect: /ESCALATE is guarded/ },
  { id: 'douce-escalate-hard-pause', file: D, find: "WHERE id = ? AND paused_at = ? AND pause_mode = 'soft' AND pause_escalated_at IS NULL", rep: "WHERE id = ? AND paused_at = ? AND pause_escalated_at IS NULL", tests: [UT], expect: /ESCALATE is guarded/ },
  { id: 'douce-escalate-twice', file: D, find: "AND pause_mode = 'soft' AND pause_escalated_at IS NULL AND pause_trap_at IS NULL AND resume_started_at IS NULL`", rep: "AND pause_mode = 'soft' AND pause_trap_at IS NULL AND resume_started_at IS NULL`", tests: [UT], expect: /ESCALATE is guarded/ },
  { id: 'douce-trap-owed-ignores-escalation', file: BP, find: '        trapOwed({\n          pausedAt: r.pausedAt,', rep: '        ((_c: unknown) => r.trapAt === null)({\n          pausedAt: r.pausedAt,', tests: [UT], expect: /TRAP OWED/ },
  { id: 'douce-writer-no-deadline', file: BP, find: 'mode === \'soft\' ? softDeadlineAt(now) : null', rep: 'null', tests: [UT], expect: /WRITER soft/ },
  { id: 'douce-writer-mode-always-hard', file: BP, find: ').run(now, who, mode, mode === \'soft\'', rep: ').run(now, who, \'hard\', mode === \'soft\'', tests: [UT], expect: /WRITER soft/ },
  { id: 'douce-hard-over-soft-not-escalated', file: BP, find: "      if (mode === 'hard' && row!.mode === 'soft'", rep: "      if (false && row!.mode === 'soft'", tests: [UT], expect: /`--hard` over a douce/ },
  { id: 'douce-lift-keeps-deadline', file: BP, find: 'pause_trap_at = NULL, pause_deadline_at = NULL,\n            pause_escalated_at = NULL,', rep: 'pause_trap_at = NULL,\n            pause_escalated_at = NULL,', tests: [UT], expect: /WRITER lift/ },
  { id: 'douce-lift-keeps-escalation', file: BP, find: '            pause_escalated_at = NULL, resume_started_at = NULL, pause_auto = NULL WHERE id = ?`', rep: '            resume_started_at = NULL, pause_auto = NULL WHERE id = ?`', tests: [UT], expect: /WRITER lift/ },
  { id: 'douce-switch-off-writes', file: BP, find: "    if (!getRun(db, runId)?.flags.pause) return 'switch-off';", rep: '', tests: [UT], expect: /WRITER switch OFF/ },
  // ── the roster and the accusé
  { id: 'douce-accusé-overwrites', file: D, find: '          WHERE run_id = ? AND paused_at = ? AND ws_id = ? AND pause_confirmed_at IS NULL`', rep: '          WHERE run_id = ? AND paused_at = ? AND ws_id = ?`', tests: [UT], expect: /ACCUSÉ: the first writer wins/ },
  { id: 'douce-role-always-worker', file: D, find: "  return run && isCoordinatorHandle(run.coordinator, wsId) ? 'coordinator' : 'worker';", rep: "  return 'worker';", tests: [UT], expect: /SWEEP: a member with a turn RUNNING/ },
  { id: 'douce-enroll-always-writes', file: D, find: '\n       WHERE role IS NOT excluded.role OR member_run IS NOT excluded.member_run`,', rep: '`,', tests: [UT], expect: /WRITE-QUIET/ },
  { id: 'douce-null-run-clobbers-roster', file: D, find: '  if (m.memberRun === null) {', rep: '  if (false) {', tests: [UT], expect: /never clobbers/ },
  // ── the sweep
  { id: 'douce-idle-not-confirmed', file: D, find: "    if (!running) {\n      confirmMember(db, c.runId, c.pausedAt, { wsId: m.wsId, memberRun: m.runId }, 'host-idle', now);", rep: "    if (!running) {", tests: [UT], expect: /SWEEP: a member with a turn RUNNING/ },
  { id: 'douce-unreadable-activity-is-idle', file: D, find: '    let running = true; // UNKNOWN is not NONE', rep: '    let running = false; // UNKNOWN is not NONE', tests: [UT], expect: /UNKNOWN is not NONE/ },
  { id: 'douce-notify-every-sweep', file: D, find: '      if (!orderSent(db, m, c.pausedAt) && stillWaiting(db, c)) {', rep: '      if (stillWaiting(db, c)) {', tests: [UT], expect: /idempotent and WRITE-QUIET/ },
  { id: 'douce-order-dedupe-ignores-epoch', file: D, find: "AND recipient = ? AND created_at >= ? LIMIT 1`,", rep: "AND recipient = ? AND created_at >= 0 * ? LIMIT 1`,", tests: [UT], expect: /SECOND pause of the same run/ },
  { id: 'douce-remote-not-idle', file: D, find: '    if (m.remote) {\n      confirmMember(', rep: '    if (false) {\n      confirmMember(', tests: [UT], expect: /REMOTE/ },
  { id: 'douce-no-order-file', file: D, find: '        deps.pauseOrders?.write(m.wsId, text); // the order file first', rep: '        void 0; // the order file first', tests: [UT], expect: /SWEEP: a member with a turn RUNNING/ },
  { id: 'douce-order-after-lift', file: D, find: '      if (!orderSent(db, m, c.pausedAt) && stillWaiting(db, c)) {', rep: '      if (!orderSent(db, m, c.pausedAt)) {', tests: [UT], expect: /LIFT landing mid-step/ },
  { id: 'douce-no-prune', file: D, find: '    if (complete) deps.pauseOrders?.prune(new Set(summaries.flatMap((x) => x.pending)));', rep: '', tests: [UT], expect: /PRUNE: only the orders/ },
  { id: 'douce-prune-when-incomplete', file: D, find: '    if (complete) deps.pauseOrders?.prune(', rep: '    if (true) deps.pauseOrders?.prune(', tests: [UT], expect: /PRUNE is skipped/ },
  { id: 'douce-sweep-ignores-switch', file: D, find: ".filter((r) => parseSwitches((r.flags_json as string | null | undefined) ?? null).pause === true)\n    .map((r) => ({\n      runId: String(r.id),\n      pausedAt: Number(r.paused_at),\n      pausedBy: (r.paused_by as string | null) ?? null,\n      mode: 'soft',", rep: ".filter((r) => parseSwitches((r.flags_json as string | null | undefined) ?? null).pause === true || true)\n    .map((r) => ({\n      runId: String(r.id),\n      pausedAt: Number(r.paused_at),\n      pausedBy: (r.paused_by as string | null) ?? null,\n      mode: 'soft',", tests: [UT], expect: /SWITCH OFF: a stale soft pause/ },
  { id: 'douce-sweep-takes-hard-pauses', file: D, find: "WHERE r.paused_at IS NOT NULL AND r.pause_mode = 'soft' AND r.pause_escalated_at IS NULL", rep: 'WHERE r.paused_at IS NOT NULL AND r.pause_escalated_at IS NULL', tests: [UT], expect: /HARD pause is never swept/ },
  { id: 'douce-store-not-ready-ignored', file: D, find: '  const ready = deps.storeReady ? deps.storeReady() : true;', rep: '  const ready = true;', tests: [UT], expect: /UNKNOWN is not NONE/ },
  { id: 'douce-payload-empty', file: D, find: '  if (!pv) return {};\n  const labels', rep: '  return {};\n  const labels', tests: [UT], expect: /BUS-STATUS payload/ },
  // ── the trap's half + the wiring in pause-trap.ts
  { id: 'trap-no-roster-enrol', file: TRAP, find: '    enrollRoster(db, carrier, members); // #254', rep: '    void enrollRoster; // #254', tests: [UT], expect: /TRAP roster/ },
  { id: 'trap-no-confirm-by-trap', file: TRAP, find: '            confirmByTrap(db, carrier, m, deps.now()); // #254', rep: '            void confirmByTrap; // #254', tests: [UT], expect: /TRAP roster/ },
  { id: 'trap-arms-while-pausing', file: TRAP, find: "    if (carrierPhase(db, c.runId) === 'pausing') continue;", rep: '', tests: [UT], expect: /ARM: a Pause douce still waiting/ },
  { id: 'trap-sweep-no-douce-pass', file: TRAP, find: '    const { dueAt } = await sweepSoftPauses(deps);\n    armDouceTimer(deps, dueAt);', rep: '    const dueAt = null as number | null;\n    armDouceTimer(deps, dueAt);', tests: [UT], expect: /SWEEP wiring/ },
  { id: 'trap-no-deadline-timer', file: TRAP, find: '    armDouceTimer(deps, dueAt);', rep: '    void dueAt;', tests: [UT], expect: /DEADLINE TIMER/ },
  { id: 'trap-no-poll-while-waiting', file: TRAP, find: '  const at = Math.min(dueAt, deps.now() + (deps.douceCheckMs ?? DOUCE_POLL_MS));', rep: '  const at = dueAt;', tests: [UT], expect: /POLL: a member whose turn ENDS/ },
  { id: 'trap-timer-never-fires', file: TRAP, find: '  }, Math.max(0, at - deps.now()) + 50);', rep: '  }, 3_600_000);', tests: [UT], expect: /DEADLINE TIMER/ },
  // ── the hook (the REAL script text from workspaces.ts) and the CLI
  { id: 'hook-delivers-on-any-event', file: WS, find: 'if [ "\\$event" = posttool ]; then\n  po=', rep: 'if [ "\\$event" != stop ]; then\n  po=', tests: [UT], expect: /HOOK: the real posttool hook script/ },
  { id: 'hook-not-once-only', file: WS, find: 'if mv "\\$po.json" "\\$po.taken" 2>/dev/null; then', rep: 'if cp "\\$po.json" "\\$po.taken" 2>/dev/null; then', tests: [UT], expect: /HOOK: the real posttool hook script/ },
  { id: 'hook-failure-event-name-lost', file: WS, find: '    mine hook_event_name && hen="\\$mined"\n', rep: '', tests: [UT], expect: /HOOK: the real posttool hook script/ },
  { id: 'cli-pause-always-hard', file: IDX, find: "hardFlag.present ? 'hard' : 'soft'", rep: "'hard'", tests: [CT, 'src/cli/run-pause.test.ts'], expect: /PAUSE DOUCE/, build: true },
  { id: 'cli-confirm-no-roster-fallback', file: IDX, find: ' ?? douce.carrierFromRoster(d, who);', rep: ' ?? null;', tests: [CT], expect: /found through the host-written roster/, build: true },
  { id: 'cli-status-no-roster', file: RS, find: '  if (st.roster) {', rep: '  if (false) {', tests: [CT], expect: /`run status` names the phase and the roster/, build: true },
  // ── pre-review dispositions (M1 M2 M3 M7 M8 M14 + hook staleness / fork)
  { id: 'douce-unknown-flag-ignored', file: D, find: '      running = act.turnRunning || act.unknown === true;', rep: '      running = act.turnRunning;', tests: [UT], expect: /UNKNOWN is not NONE \(production shape\)/ },
  { id: 'trap-observer-interrupts-while-pausing', file: TRAP, find: "    if (carrierPhase(db, carrier.runId) === 'pausing') return 'skipped';", rep: '', tests: [UT], expect: /OBSERVER: a turn that starts while a Pause douce/ },
  { id: 'douce-nested-outer-not-confirmed', file: D, find: '    if (outer && outer.runId === cur) confirmMember(db, outer.runId, outer.pausedAt, who, \'member\', now);', rep: '', tests: [UT], expect: /NESTED douces/ },
  { id: 'douce-vanished-kept', file: D, find: '  if (ready && members.length > 0) dropVanishedMembers(db, c, members);', rep: '', tests: [UT], expect: /ROSTER: a member archived/ },
  { id: 'douce-vanished-pruned-on-unloaded-store', file: D, find: '  if (ready && members.length > 0) dropVanishedMembers(db, c, members);', rep: '  if (true) dropVanishedMembers(db, c, members);', tests: [UT], expect: /ROSTER: a member archived/ },
  // TWO LAYERS (the JS guard + the SQL guard) cover each other: the mutant removes BOTH.
  { id: 'douce-vanished-drops-confirmed', file: D, edits: [
    { find: '    if (r.pauseConfirmedAt === null && !keep.has(r.wsId)) {', rep: '    if (!keep.has(r.wsId)) {' },
    { find: " AND ws_id = ? AND pause_confirmed_at IS NULL').run(c.runId, c.pausedAt, r.wsId);", rep: " AND ws_id = ?').run(c.runId, c.pausedAt, r.wsId);" },
  ], tests: [UT], expect: /ROSTER: a member archived/ },
  { id: 'trap-timer-armed-after-stop', file: TRAP, find: '  if (dueAt === null || douceStopped) return;', rep: '  if (dueAt === null) return;', tests: [UT], expect: /STOP: a sweep still in flight/ },
  { id: 'hook-subagent-takes-order', file: WS, find: "        *'\"agent_id\"'*) ;;\n", rep: '', tests: [UT], expect: /HOOK: the real posttool hook script/ },
  { id: 'hook-stale-order-delivered', file: WS, find: 'find "\\$po.json" -mmin +5', rep: 'find "\\$po.json" -mmin +500', tests: [UT], expect: /HOOK: the real posttool hook script/ },
  { id: 'hook-forks-dirname', file: WS, find: 'po="\\${dir%/*}/pause-orders/\\$ORCHESTRA_WS_ID"', rep: 'po="\\$(dirname "\\$dir")/pause-orders/\\$ORCHESTRA_WS_ID"', tests: [UT], expect: /PIN: the host writes the order where the hook looks/ },
  { id: 'cli-confirm-guesses-member-run', file: IDX, find: ': null; // never guess: a wrong run would overwrite what the host enrolled', rep: ': cfEnvRun || null;', tests: [CT], expect: /never overwrites what the host enrolled/, build: true },
  { id: 'cli-confirm-no-drop-order', file: IDX, find: "              if (ev) douce.pauseOrderFiles(path.join(path.dirname(ev), 'pause-orders')).remove(who);", rep: '', tests: [CT], expect: /READABLE store walks the live tree/, build: true },
];
