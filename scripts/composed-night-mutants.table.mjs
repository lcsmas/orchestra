// GENERATED once from the tracks' own mutant tables (admission-mutants.mjs, fast-veille-mutants.mjs, docker-relay-mutants.mjs, memory-alert/mutate-unit.mjs, pause-memory/mutate-unit.mjs) — the `from` field names the
// source row — plus two own mutants on the #285 base. Every edit is an exact-once anchor in the CURRENT tree (the sweep refuses a stale one: PATTERN-GONE). `arm` + `check` = the named arm of
// scripts/e2e-composed-night.mjs and the named check inside it that MUST be red (a mutant killed by a different check, or by a crash, is not a kill).
// #291 (the relay stamping labels) is not here: the Seam-1 night hand-labels its fake containers; its clauses are the packaged-app drive's (scripts/e2e-composed-drive.mjs mutants).
export const MUTANTS = [
 {
  "id": "286-C01_spawn_gate_off",
  "from": "admission-mutants.mjs:C01_spawn_gate_off",
  "ticket": "#286",
  "clause": "an AUTO spawn is held at the chokepoint: accepted, brief owed, no session",
  "arm": "n1_starts_held",
  "check": "auto_spawn_accepted_and_held",
  "edits": [
   {
    "file": "src/main/workspaces.ts",
    "find": "  if (!admitted) {\n    const gate = admissionGate({",
    "to": "  if (false) {\n    const gate = admissionGate({"
   }
  ]
 },
 {
  "id": "286-C05_restart_gate_off",
  "from": "admission-mutants.mjs:C05_restart_gate_off",
  "ticket": "#286",
  "clause": "an AUTO restart waits BEFORE any stop",
  "arm": "n1_starts_held",
  "check": "auto_restart_accepted_and_held",
  "edits": [
   {
    "file": "src/main/restart-workspace.ts",
    "find": "  if (!input.admitted && id && ws) {",
    "to": "  if (false) {"
   }
  ]
 },
 {
  "id": "286-A01_human_held",
  "from": "admission-mutants.mjs:A01_human_held",
  "ticket": "#286",
  "clause": "a HUMAN-initiated start passes while held",
  "arm": "n1_starts_held",
  "check": "human_toolbar_restart_passes_while_held",
  "edits": [
   {
    "file": "src/shared/admission.ts",
    "find": "return args.origin === 'auto' && isFleetMember(args.ws)",
    "to": "return isFleetMember(args.ws)"
   }
  ]
 },
 {
  "id": "286-C09_peers_without_held",
  "from": "admission-mutants.mjs:C09_peers_without_held",
  "ticket": "#286",
  "clause": "the OPS sees the held member (since-when) in `peers`",
  "arm": "n1_starts_held",
  "check": "peers_marks_the_held_spawn_with_since",
  "edits": [
   {
    "file": "src/main/workspaces.ts",
    "find": "    ...(heldStartFor(w.id) ? { heldForMemory:",
    "to": "    ...(false ? { heldForMemory:"
   }
  ]
 },
 {
  "id": "286-C08_busstatus_no_held_starts",
  "from": "admission-mutants.mjs:C08_busstatus_no_held_starts",
  "ticket": "#286",
  "clause": "the OPS sees the held starts in `bus-status`",
  "arm": "n1_starts_held",
  "check": "the_ops_sees_it_in_bus_status_the_cli",
  "edits": [
   {
    "file": "src/main/hooks-server.ts",
    "find": "              heldStarts: listHeldStarts().map((h) => {",
    "to": "              heldStarts: [].map((h: { wsId: string; kind: string; since: number; coordinator: boolean; seq: number }) => {"
   }
  ]
 },
 {
  "id": "286-A04_coordinators_not_first",
  "from": "admission-mutants.mjs:A04_coordinators_not_first",
  "ticket": "#286",
  "clause": "held starts go out COORDINATORS FIRST",
  "arm": "n8_release_order",
  "check": "coordinators_first_then_arrival_order",
  "edits": [
   {
    "file": "src/shared/admission.ts",
    "find": "(h.coordinator && !best.coordinator)",
    "to": "false"
   }
  ]
 },
 {
  "id": "286-C04_restart_coordinator_flag",
  "from": "admission-mutants.mjs:C04_restart_coordinator_flag",
  "ticket": "#286",
  "clause": "a held coordinator restart carries its coordinator flag",
  "arm": "n8_release_order",
  "check": "coordinators_first_then_arrival_order",
  "edits": [
   {
    "file": "src/main/restart-workspace.ts",
    "find": "      coordinator: canOrchestrate(ws),\n      run: () => dispatchRestartRequest(",
    "to": "      coordinator: false,\n      run: () => dispatchRestartRequest("
   }
  ]
 },
 {
  "id": "286-A05_arrival_order_reversed",
  "from": "admission-mutants.mjs:A05_arrival_order_reversed",
  "ticket": "#286",
  "clause": "then in ARRIVAL order",
  "arm": "n8_release_order",
  "check": "coordinators_first_then_arrival_order",
  "edits": [
   {
    "file": "src/shared/admission.ts",
    "find": "h.seq < best.seq",
    "to": "h.seq > best.seq"
   }
  ]
 },
 {
  "id": "286-A15_release_runs_without_fresh_sample",
  "from": "admission-mutants.mjs:A15_release_runs_without_fresh_sample",
  "ticket": "#286",
  "clause": "a FRESH reading before each release",
  "arm": "n8_release_order",
  "check": "a_recovery_that_dips_again_stops_the_release_after_one",
  "edits": [
   {
    "file": "src/main/admission.ts",
    "find": "  let waitLogged: string | null = null;\n",
    "to": "  let waitLogged: string | null = null;\n  let lastSnap: MemoryGuardSnapshot | null = null;\n"
   },
   {
    "file": "src/main/admission.ts",
    "find": "      const snap = deps.sample();\n      const step = planRelease(",
    "to": "      const snap = lastSnap ?? deps.sample();\n      lastSnap = snap;\n      const step = planRelease("
   }
  ]
 },
 {
  "id": "286-A08_release_ignores_room",
  "from": "admission-mutants.mjs:A08_release_ignores_room",
  "ticket": "#286",
  "clause": "a recovery that dips again stops the release",
  "arm": "n8_release_order",
  "check": "a_recovery_that_dips_again_stops_the_release_after_one",
  "edits": [
   {
    "file": "src/shared/admission.ts",
    "find": "  if (!snap.mayReleaseOneStart) return { action: 'wait', reason: 'memory' };\n",
    "to": ""
   }
  ]
 },
 {
  "id": "286-C03_release_re_held",
  "from": "admission-mutants.mjs:C03_release_re_held",
  "ticket": "#286",
  "clause": "a released start is not re-held by its own gate",
  "arm": "n8_release_order",
  "check": "the_released_spawn_really_started_with_its_brief",
  "edits": [
   {
    "file": "src/main/workspaces.ts",
    "find": "run: () => startWorkspaceAgentHeadless(id, 'auto', true),",
    "to": "run: () => startWorkspaceAgentHeadless(id, 'auto'),"
   }
  ]
 },
 {
  "id": "287-W11_sweep_hold_removed",
  "from": "admission-mutants.mjs:W11_sweep_hold_removed",
  "ticket": "#287",
  "clause": "a réveil of a sleeping fleet member is HELD (no start)",
  "arm": "n3_reveil_held",
  "check": "no_process_started",
  "edits": [
   {
    "file": "src/main/bus-wake.ts",
    "find": "if (action.kind === 'fire' && entry?.fleetMember === true) {",
    "to": "if (false) {"
   }
  ]
 },
 {
  "id": "287-W19_roster_not_fleet",
  "from": "admission-mutants.mjs:W19_roster_not_fleet",
  "ticket": "#287",
  "clause": "only a FLEET member's réveil is held (roster fleetMember)",
  "arm": "n3_reveil_held",
  "check": "no_process_started",
  "edits": [
   {
    "file": "src/main/wake-roster.ts",
    "find": "fleetMember: !!ws.parentId,",
    "to": "fleetMember: false,"
   }
  ]
 },
 {
  "id": "287-W13_held_branch_falls_through",
  "from": "admission-mutants.mjs:W13_held_branch_falls_through",
  "ticket": "#287",
  "clause": "the held branch skips the failure path",
  "arm": "n3_reveil_held",
  "check": "no_failure_counted_nothing_fired_nothing_withdrawn",
  "edits": [
   {
    "file": "src/main/bus-wake.ts",
    "find": "            logWakeableTransition(reader, 'held-for-memory');\n            continue;",
    "to": "            logWakeableTransition(reader, 'held-for-memory');"
   }
  ]
 },
 {
  "id": "287-W16_held_logged_every_sweep",
  "from": "admission-mutants.mjs:W16_held_logged_every_sweep",
  "ticket": "#287",
  "clause": "the held reason is logged ONCE per transition",
  "arm": "n3_reveil_held",
  "check": "held_reason_logged_once_per_transition",
  "edits": [
   {
    "file": "src/main/bus-wake.ts",
    "find": "            logWakeableTransition(reader, 'held-for-memory');\n",
    "to": "            log.info(`bus-wake: ${reader} is PENDING and its réveil is HELD for memory (Admission) — again`);\n"
   }
  ]
 },
 {
  "id": "287-W07_permit_not_granted",
  "from": "admission-mutants.mjs:W07_permit_not_granted",
  "ticket": "#287",
  "clause": "the release grants the held réveil its one-shot permit",
  "arm": "n8_release_order",
  "check": "the_release_finishes_once_memory_is_back",
  "edits": [
   {
    "file": "src/main/admission.ts",
    "find": "      if (site.reenters) permits.add(id);\n",
    "to": ""
   }
  ]
 },
 {
  "id": "287-W38_no_first_turn_settle",
  "from": "admission-mutants.mjs:W38_no_first_turn_settle",
  "ticket": "#287",
  "clause": "a woken member settles its first turn before the next reading",
  "arm": "n8_release_order",
  "check": "one_booting_at_a_time",
  "edits": [
   {
    "file": "src/main/admission.ts",
    "find": "      await deps.settleWake?.(id);",
    "to": "      void deps.settleWake;"
   }
  ]
 },
 {
  "id": "287-W60_release_sweep_never_sweeps",
  "from": "admission-mutants.mjs:W60_release_sweep_never_sweeps",
  "ticket": "#287",
  "clause": "the release re-runs a guaranteed sweep so the réveil is delivered",
  "arm": "n9_reveil_delivered",
  "check": "the_held_reveil_was_delivered_exactly_once_as_the_start",
  "edits": [
   {
    "file": "src/main/bus-wake.ts",
    "find": "  await sweepBusWake();\n}",
    "to": "}"
   }
  ]
 },
 {
  "id": "288-V01_fast_clause_removed",
  "from": "fast-veille-mutants.mjs:V01_fast_clause_removed",
  "ticket": "#288",
  "clause": "an idle fleet member goes into Veille at once while held",
  "arm": "n2_fast_veille",
  "check": "idle_fleet_members_go_to_veille_at_once",
  "edits": [
   {
    "file": "src/shared/hibernation.ts",
    "find": "  if (admissionHeld && isFleetMember(ws)) return true;\n",
    "to": ""
   }
  ]
 },
 {
  "id": "288-S01_never_held",
  "from": "fast-veille-mutants.mjs:S01_never_held",
  "ticket": "#288",
  "clause": "the sweeper reads the hold PER MEMBER from the guard",
  "arm": "n2_fast_veille",
  "check": "idle_fleet_members_go_to_veille_at_once",
  "edits": [
   {
    "file": "src/main/hibernation.ts",
    "find": "const admissionHeld = isAdmissionHolding(guardSnap);",
    "to": "const admissionHeld = false;"
   }
  ]
 },
 {
  "id": "288-V03_open_fleet_goes",
  "from": "fast-veille-mutants.mjs:V03_open_fleet_goes",
  "ticket": "#288",
  "clause": "with Admission OPEN the fleet waits out its idle threshold",
  "arm": "n0_control",
  "check": "control_no_veille_at_open_admission",
  "edits": [
   {
    "file": "src/shared/hibernation.ts",
    "find": "if (admissionHeld && isFleetMember(ws)) return true;",
    "to": "if (isFleetMember(ws)) return true;"
   }
  ]
 },
 {
  "id": "288-V02_non_member_goes",
  "from": "fast-veille-mutants.mjs:V02_non_member_goes",
  "ticket": "#288",
  "clause": "a session without a coordinator is untouched",
  "arm": "n2_fast_veille",
  "check": "a_session_with_no_coordinator_is_untouched",
  "edits": [
   {
    "file": "src/shared/hibernation.ts",
    "find": "if (admissionHeld && isFleetMember(ws)) return true;",
    "to": "if (admissionHeld) return true;"
   }
  ]
 },
 {
  "id": "288-V05_before_status",
  "from": "fast-veille-mutants.mjs:V05_before_status",
  "ticket": "#288",
  "clause": "a running turn still spares the member",
  "arm": "n2_fast_veille",
  "check": "a_running_turn_is_spared",
  "edits": [
   {
    "file": "src/shared/hibernation.ts",
    "find": "  if (admissionHeld && isFleetMember(ws)) return true;\n",
    "to": ""
   },
   {
    "file": "src/shared/hibernation.ts",
    "find": "  if (ws.status !== 'idle') return false;\n",
    "to": "  if (admissionHeld && isFleetMember(ws)) return true;\n  if (ws.status !== 'idle') return false;\n"
   }
  ]
 },
 {
  "id": "288-V06_before_pending_prompt",
  "from": "fast-veille-mutants.mjs:V06_before_pending_prompt",
  "ticket": "#288",
  "clause": "a pending prompt still spares the member",
  "arm": "n2_fast_veille",
  "check": "a_pending_prompt_is_spared",
  "edits": [
   {
    "file": "src/shared/hibernation.ts",
    "find": "  if (admissionHeld && isFleetMember(ws)) return true;\n",
    "to": ""
   },
   {
    "file": "src/shared/hibernation.ts",
    "find": "  if (ws.sdkPendingPrompts?.length) return false;\n",
    "to": "  if (admissionHeld && isFleetMember(ws)) return true;\n  if (ws.sdkPendingPrompts?.length) return false;\n"
   }
  ]
 },
 {
  "id": "289-timer-not-armed",
  "from": "memory-alert/mutate-unit.mjs:timer-not-armed",
  "ticket": "#289",
  "clause": "the episode row is written (after the settle window)",
  "arm": "n4_alert_one_row",
  "check": "the_row_arrives_after_the_settle_window",
  "edits": [
   {
    "file": "src/main/memory-alert.ts",
    "find": "    tracked.set(episode, t);\n    arm(t);\n    return t;",
    "to": "    tracked.set(episode, t);\n    return t;"
   }
  ]
 },
 {
  "id": "289-recipients-all-fleet-runs",
  "from": "memory-alert/mutate-unit.mjs:recipients-all-fleet-runs",
  "ticket": "#289",
  "clause": "the row goes to the LEAD only (topmost reader per root)",
  "arm": "n4_alert_one_row",
  "check": "exactly_one_escalation_for_the_oscillating_episode",
  "edits": [
   {
    "file": "src/main/memory-alert.ts",
    "find": "  return topmostRunIds(db, deps, [...readers.keys()]).map((runId) => ({ runId, coordinator: readers.get(runId)! }));",
    "to": "  return [...readers.keys()].map((runId) => ({ runId, coordinator: readers.get(runId)! }));"
   }
  ]
 },
 {
  "id": "289-facts-held-starts-zero",
  "from": "memory-alert/mutate-unit.mjs:facts-held-starts-zero",
  "ticket": "#289",
  "clause": "the row names the EFFECTIVE held-start count",
  "arm": "n4_alert_one_row",
  "check": "names_the_effective_actions",
  "edits": [
   {
    "file": "src/main/memory-alert.ts",
    "find": "        heldStarts: deps.heldStarts(),",
    "to": "        heldStarts: 0,"
   }
  ]
 },
 {
  "id": "289-facts-veille-zero",
  "from": "memory-alert/mutate-unit.mjs:facts-veille-zero",
  "ticket": "#289",
  "clause": "the row names the members put in Veille since the crossing",
  "arm": "n4_alert_one_row",
  "check": "names_the_effective_actions",
  "edits": [
   {
    "file": "src/main/memory-alert.ts",
    "find": "        veille: deps.veilleSince(t.ep.admission.at),",
    "to": "        veille: 0,"
   }
  ]
 },
 {
  "id": "290-apply-due-ignored",
  "from": "pause-memory/mutate-unit.mjs:apply-due-ignored",
  "ticket": "#290",
  "clause": "critical memory imposes the Pause on the pause-ON run",
  "arm": "n5_memory_pause",
  "check": "the_pause_on_run_is_paused",
  "edits": [
   {
    "file": "src/main/pause-memory.ts",
    "find": "trigger === 'due' ? 'impose' : trigger === 'liftable'",
    "to": "trigger === 'due' ? 'none' : trigger === 'liftable'"
   }
  ]
 },
 {
  "id": "290-impose-motive-not-written",
  "from": "pause-memory/mutate-unit.mjs:impose-motive-not-written",
  "ticket": "#290",
  "clause": "the Pause carries the motive `memory`",
  "arm": "n5_memory_pause",
  "check": "written_by_the_host_hard_with_the_motive_memory",
  "edits": [
   {
    "file": "src/main/pause-memory.ts",
    "find": "    .run(now, MEMORY_PAUSE_BY, encodeMemoryPause(reason, now), runId);",
    "to": "    .run(now, MEMORY_PAUSE_BY, null, runId);"
   }
  ]
 },
 {
  "id": "290-impose-soft-mode",
  "from": "pause-memory/mutate-unit.mjs:impose-soft-mode",
  "ticket": "#290",
  "clause": "the Pause is a Pause DURE",
  "arm": "n5_memory_pause",
  "check": "written_by_the_host_hard_with_the_motive_memory",
  "edits": [
   {
    "file": "src/main/pause-memory.ts",
    "find": "SET paused_at = ?, paused_by = ?, pause_mode = 'hard', pause_deadline_at = NULL, pause_escalated_at = NULL,\n              pause_trap_at = NULL, resume_started_at = NULL, pause_auto = ?\n        WHERE id = ? AND paused_at IS NULL",
    "to": "SET paused_at = ?, paused_by = ?, pause_mode = 'soft', pause_deadline_at = NULL, pause_escalated_at = NULL,\n              pause_trap_at = NULL, resume_started_at = NULL, pause_auto = ?\n        WHERE id = ? AND paused_at IS NULL"
   }
  ]
 },
 {
  "id": "290-cand-switch-ignored",
  "from": "pause-memory/mutate-unit.mjs:cand-switch-ignored",
  "ticket": "#290",
  "clause": "a run with the `pause` switch OFF is never paused",
  "arm": "n5_memory_pause",
  "check": "the_pause_off_run_is_byte_identical",
  "edits": [
   {
    "file": "src/main/pause-memory.ts",
    "find": "liveFleetRuns(db, deps).filter((r) => r.flags.pause === true).map((r) => r.id)",
    "to": "liveFleetRuns(db, deps).map((r) => r.id)"
   }
  ]
 },
 {
  "id": "290-apply-liftable-ignored",
  "from": "pause-memory/mutate-unit.mjs:apply-liftable-ignored",
  "ticket": "#290",
  "clause": "recovery above the Admission threshold lifts it (automatic Reprise)",
  "arm": "n7_reprise",
  "check": "the_stopped_containers_are_started_again",
  "edits": [
   {
    "file": "src/main/pause-memory.ts",
    "find": "trigger === 'liftable' ? 'lift' : memoryPauseWant(",
    "to": "trigger === 'liftable' ? 'none' : memoryPauseWant("
   }
  ]
 },
 {
  "id": "292-P13",
  "from": "docker-relay-mutants.mjs:P13",
  "ticket": "#292",
  "clause": "a Pause dure runs the Docker step (stops attributed containers)",
  "arm": "n6_pause_containers",
  "check": "attributed_containers_of_the_paused_members_are_stopped",
  "edits": [
   {
    "file": "src/main/pause-trap.ts",
    "find": "  if (dockerApi) {\n    let liftedDuringStop = false;",
    "to": "  if (false as boolean && dockerApi) {\n    let liftedDuringStop = false;"
   }
  ]
 },
 {
  "id": "292-P4",
  "from": "docker-relay-mutants.mjs:P4",
  "ticket": "#292",
  "clause": "a --rm container is never stopped (it would be DELETED)",
  "arm": "n6_pause_containers",
  "check": "an_autoremove_container_is_skipped",
  "edits": [
   {
    "file": "src/main/pause-containers.ts",
    "find": "else if (insp.autoRemove)",
    "to": "else if (false as boolean)"
   }
  ]
 },
 {
  "id": "292-P1+P2",
  "from": "docker-relay-mutants.mjs:P1+P2",
  "ticket": "#292",
  "clause": "unattributed / other members' containers are never stopped (neither selected NOR re-asserted by label: both defences removed)",
  "arm": "n6_pause_containers",
  "check": "bystander_other_member_and_pause_off_run_are_untouched",
  "edits": [
   {
    "file": "src/main/pause-containers.ts",
    "find": "labels: [attributedLabelFilter(wsId)], status: STOPPABLE_STATES",
    "to": "status: STOPPABLE_STATES"
   },
   {
    "file": "src/main/pause-containers.ts",
    "find": "    if (row.labels[DOCKER_LABEL_WS] !== wsId) continue;\n",
    "to": ""
   }
  ]
 },
 {
  "id": "292-Q4",
  "from": "docker-relay-mutants.mjs:Q4",
  "ticket": "#292",
  "clause": "the Reprise knows containers are owed: it parks the coordinators until they are back",
  "arm": "n7b_coordinators_after_containers",
  "check": "coordinators_are_released_only_after_the_containers_are_back",
  "edits": [
   {
    "file": "src/main/pause-reprise.ts",
    "find": "return !ancestorPauseStands(db, carrierRunId) && owedRowsUnder(db, carrierRunId).length > 0;",
    "to": "return false;"
   }
  ]
 },
 {
  "id": "292-Q5",
  "from": "docker-relay-mutants.mjs:Q5",
  "ticket": "#292",
  "clause": "the Reprise restarts EXACTLY the stopped entries",
  "arm": "n7_reprise",
  "check": "exactly_the_stopped_ones_restarted_each_once_and_in_REVERSE_stop_order",
  "edits": [
   {
    "file": "src/shared/pause-containers.ts",
    "find": "return c.stopped.filter((s) => (s.outcome === 'stopped' || s.outcome === 'stopping') && !done.has(s.id));",
    "to": "return c.stopped.filter((s) => !done.has(s.id));"
   }
  ]
 },
 {
  "id": "292-Q30",
  "from": "docker-relay-mutants.mjs:Q30",
  "ticket": "#292",
  "clause": "containers restart in the REVERSE of the stop order",
  "arm": "n7_reprise",
  "check": "exactly_the_stopped_ones_restarted_each_once_and_in_REVERSE_stop_order",
  "edits": [
   {
    "file": "src/shared/pause-containers.ts",
    "find": ".sort((a, b) => b[0].atMs - a[0].atMs || b[1] - a[1])",
    "to": ".sort((a, b) => a[0].atMs - b[0].atMs || a[1] - b[1])"
   }
  ]
 },
 {
  "id": "292-Q7",
  "from": "docker-relay-mutants.mjs:Q7",
  "ticket": "#292",
  "clause": "restart results (started / gone) are recorded in the Bilan",
  "arm": "n7_reprise",
  "check": "the_bilan_records_each_restart_and_the_gone_one",
  "edits": [
   {
    "file": "src/main/pause-containers.ts",
    "find": "        updateBilanContainers(db, row.carrier, row.wsId, row.pausedAt, (cur) => ({ stopped: cur?.stopped ?? [], restarted: mergeRestarted(cur?.restarted, mine), ...(cur?.error ? { error: cur.error } : {}) }));\n",
    "to": ""
   }
  ]
 },
 {
  "id": "292-Q1",
  "from": "docker-relay-mutants.mjs:Q1",
  "ticket": "#292",
  "clause": "the coordinators are released only AFTER the containers are back",
  "arm": "n7b_coordinators_after_containers",
  "check": "coordinators_are_released_only_after_the_containers_are_back",
  "edits": [
   {
    "file": "src/main/pause-reprise.ts",
    "find": "if (containersOwed(db, carrierRunId)) deferCoordinatorRelease(db, carrierRunId, pausedAt, by);",
    "to": "if (false as boolean) deferCoordinatorRelease(db, carrierRunId, pausedAt, by);"
   }
  ]
 },
 {
  "id": "285-reopen-margin-dropped",
  "from": "own (memory-guard-mutants M02 family)",
  "ticket": "#285",
  "clause": "Admission reopens only above threshold + margin (6.5 GB is still HELD)",
  "arm": "n7_reprise",
  "check": "held_starts_stay_held_while_admission_is_held",
  "edits": [
   {
    "file": "src/shared/memory-guard.ts",
    "find": "return availBytes > t.admissionBytes + t.releaseMarginBytes;",
    "to": "return availBytes > t.admissionBytes;"
   }
  ]
 },
 {
  "id": "285-critical-never-due",
  "from": "own (memory-guard-mutants M03 family)",
  "ticket": "#285",
  "clause": "below the critical threshold the memory Pause is due",
  "arm": "n5_memory_pause",
  "check": "guard_decided_the_memory_pause_is_due",
  "edits": [
   {
    "file": "src/shared/memory-guard.ts",
    "find": "return availBytes < t.criticalBytes;",
    "to": "return false;"
   }
  ]
 },
 {
  "id": "286-W12_sweep_holds_live_member",
  "from": "admission-mutants.mjs:W12_sweep_holds_live_member",
  "ticket": "#286",
  "clause": "a turn to an ALREADY-RUNNING member passes while held (the sweep holds only a SLEEPING member)",
  "arm": "n3_reveil_held",
  "check": "a_running_members_pending_lot_is_delivered_live_while_held",
  "edits": [
   {
    "file": "src/main/bus-wake.ts",
    "find": "if (now.fleetMember === true && now.sleeping === true && !resident) {",
    "to": "if (now.fleetMember === true && !resident) {"
   }
  ]
 },
 {
  "id": "286-W20_roster_ignores_sdk_session",
  "from": "admission-mutants.mjs:W20_roster_ignores_sdk_session",
  "ticket": "#286",
  "clause": "a member with a live SDK session is not \"sleeping\" (its turn is never held)",
  "arm": "n3_reveil_held",
  "check": "a_running_members_pending_lot_is_delivered_live_while_held",
  "edits": [
   {
    "file": "src/main/wake-roster.ts",
    "find": "sleeping: !isRunning(ws.id) && !sdkSessionLive(ws.id),",
    "to": "sleeping: !isRunning(ws.id),"
   }
  ]
 },
 {
  "id": "288-V07_before_loop",
  "from": "fast-veille-mutants.mjs:V07_before_loop",
  "ticket": "#288",
  "clause": "a member with a running /loop is still spared while held",
  "arm": "n2_fast_veille",
  "check": "a_looping_member_is_spared",
  "edits": [
   {
    "file": "src/shared/hibernation.ts",
    "find": "  if (admissionHeld && isFleetMember(ws)) return true;\n",
    "to": ""
   },
   {
    "file": "src/shared/hibernation.ts",
    "find": "  if (ws.loopingSince) return false;\n",
    "to": "  if (admissionHeld && isFleetMember(ws)) return true;\n  if (ws.loopingSince) return false;\n"
   }
  ]
 },
 {
  "id": "288-V12_before_bg_task",
  "from": "fast-veille-mutants.mjs:V12_before_bg_task",
  "ticket": "#288",
  "clause": "a member with a running background task is still spared while held",
  "arm": "n2_fast_veille",
  "check": "a_member_with_a_background_task_is_spared",
  "edits": [
   {
    "file": "src/shared/hibernation.ts",
    "find": "  if (admissionHeld && isFleetMember(ws)) return true;\n",
    "to": ""
   },
   {
    "file": "src/shared/hibernation.ts",
    "find": "  if (hasLiveBackgroundTask) return false;\n",
    "to": "  if (admissionHeld && isFleetMember(ws)) return true;\n  if (hasLiveBackgroundTask) return false;\n"
   }
  ]
 },
 {
  "id": "290-lift-manual-selected",
  "from": "pause-memory/mutate-unit.mjs:lift-manual-selected",
  "ticket": "#290",
  "clause": "a MANUAL Pause in effect during the episode is never lifted by the guard",
  "arm": "n7_reprise",
  "check": "a_manual_pause_is_not_lifted_by_the_recovery",
  "edits": [
   {
    "file": "src/main/pause-memory.ts",
    "find": "WHERE r.paused_at IS NOT NULL AND r.pause_auto IS NOT NULL AND r.resume_started_at IS NULL`",
    "to": "WHERE r.paused_at IS NOT NULL AND r.resume_started_at IS NULL`"
   },
   {
    "file": "src/main/pause-memory.ts",
    "find": "    if (!reason) continue;\n",
    "to": ""
   },
   {
    "file": "src/main/pause-memory.ts",
    "find": "    const reason = parseMemoryPause((r.pause_auto as string | null) ?? null, pausedAt);",
    "to": "    const reason = parseMemoryPause((r.pause_auto as string | null) ?? null, pausedAt) ?? { reason: 'memory' as const, pauseCycle: 0, episode: 0, availBytes: 0, thresholdBytes: 0 };"
   }
  ]
 },
 {
  "id": "290-impose-manual-overwritten",
  "from": "pause-memory/mutate-unit.mjs:impose-manual-overwritten",
  "ticket": "#290",
  "clause": "a MANUAL Pause is never re-imposed / overwritten by the memory Pause",
  "arm": "n5_memory_pause",
  "check": "a_manual_pause_in_effect_is_left_as_is_never_re_imposed_by_the_guard",
  "edits": [
   {
    "file": "src/main/pause-memory.ts",
    "find": "  if (cur && cur.pausedAt !== null) {\n    const mine",
    "to": "  if (false as boolean) {\n    const mine"
   },
   {
    "file": "src/main/pause-memory.ts",
    "find": "        WHERE id = ? AND paused_at IS NULL`,\n    )\n    .run(now, MEMORY_PAUSE_BY",
    "to": "        WHERE id = ?`,\n    )\n    .run(now, MEMORY_PAUSE_BY"
   }
  ]
 },
 {
  "id": "292-gone-reported-failed",
  "from": "own (restartContainers, #292 AC4)",
  "ticket": "#292",
  "clause": "a container removed by hand during the Pause is reported `gone` (skipped), not a failure",
  "arm": "n7_reprise",
  "check": "the_bilan_records_each_restart_and_the_gone_one",
  "edits": [
   {
    "file": "src/main/pause-containers.ts",
    "find": "        done = { id: e.id, outcome: await api.startContainer(e.id), atMs: now() };",
    "to": "        done = { id: e.id, outcome: await api.startContainer(e.id).then((o) => { if (o === 'gone') throw new Error('gone'); return o; }), atMs: now() };"
   }
  ]
 },
 {
  "id": "292-gone-aborts-the-step",
  "from": "own (restartContainers, #292 AC4)",
  "ticket": "#292",
  "clause": "a container removed by hand does not break the Reprise (the others are still restarted)",
  "arm": "n7_reprise",
  "check": "the_stopped_containers_are_started_again",
  "edits": [
   {
    "file": "src/main/pause-containers.ts",
    "find": "        done = { id: e.id, outcome: await api.startContainer(e.id), atMs: now() };",
    "to": "        done = { id: e.id, outcome: await api.startContainer(e.id), atMs: now() };\n        if (done.outcome === 'gone') return out;"
   }
  ]
 },
 {
  "id": "286-A03_newcomer_jumps_the_line",
  "from": "admission-mutants.mjs:A03_newcomer_jumps_the_line",
  "ticket": "#286",
  "clause": "a newcomer arriving while the queue is non-empty joins the line (never jumps it)",
  "arm": "n8_release_order",
  "check": "a_newcomer_arriving_mid_release_joins_the_line_instead_of_jumping_it",
  "edits": [
   {
    "file": "src/shared/admission.ts",
    "find": "(args.holding || args.queued)",
    "to": "args.holding"
   }
  ]
 },
 {
  "id": "287-W12b_sweep_holds_non_fleet",
  "from": "admission-mutants.mjs:W12b_sweep_holds_non_fleet",
  "ticket": "#287",
  "clause": "a session with NO coordinator is woken at once while held (the sweep holds fleet members only)",
  "arm": "n3_reveil_held",
  "check": "a_session_with_no_coordinator_is_woken_at_once_while_held",
  "edits": [
   {
    "file": "src/main/bus-wake.ts",
    "find": "if (action.kind === 'fire' && entry?.fleetMember === true) {",
    "to": "if (action.kind === 'fire') {"
   },
   {
    "file": "src/main/bus-wake.ts",
    "find": "if (now.fleetMember === true && now.sleeping === true && !resident) {",
    "to": "if (now.sleeping === true && !resident) {"
   }
  ]
 },
 {
  "id": "287-W19b_roster_all_fleet",
  "from": "admission-mutants.mjs:W19b_roster_all_fleet",
  "ticket": "#287",
  "clause": "the roster marks only members with a parent as fleet members",
  "arm": "n3_reveil_held",
  "check": "a_session_with_no_coordinator_is_woken_at_once_while_held",
  "edits": [
   {
    "file": "src/main/wake-roster.ts",
    "find": "fleetMember: !!ws.parentId,",
    "to": "fleetMember: true,"
   }
  ]
 },
 {
  "id": "287-W21_roster_coordinator_dropped",
  "from": "admission-mutants.mjs:W21_roster_coordinator_dropped",
  "ticket": "#287",
  "clause": "a woken COORDINATOR goes before the earlier arrivals (roster coordinator flag)",
  "arm": "n8_release_order",
  "check": "a_coordinators_wake_that_arrived_last_goes_before_the_earlier_arrivals",
  "edits": [
   {
    "file": "src/main/wake-roster.ts",
    "find": "coordinator: canOrchestrate(ws),",
    "to": "coordinator: false,"
   }
  ]
 },
 {
  "id": "288-V08_before_active",
  "from": "fast-veille-mutants.mjs:V08_before_active",
  "ticket": "#288",
  "clause": "the workspace the human has open (active pane) is still spared while held",
  "arm": "n2_fast_veille",
  "check": "the_active_workspace_is_spared",
  "edits": [
   {
    "file": "src/shared/hibernation.ts",
    "find": "  if (admissionHeld && isFleetMember(ws)) return true;\n",
    "to": ""
   },
   {
    "file": "src/shared/hibernation.ts",
    "find": "  if (isActive) return false;\n",
    "to": "  if (admissionHeld && isFleetMember(ws)) return true;\n  if (isActive) return false;\n"
   }
  ]
 },
 {
  "id": "289-sent-guard-removed",
  "from": "memory-alert/mutate-unit.mjs:sent-guard-removed",
  "ticket": "#289",
  "clause": "ONE row per episode: an episode already told is never told again (episode end writes no second row)",
  "arm": "n8_release_order",
  "check": "still_one_escalation_row_the_episode_ended_with_it",
  "edits": [
   {
    "file": "src/main/memory-alert.ts",
    "find": "    if (t.sent) return;\n    try {",
    "to": "    try {"
   },
   {
    "file": "src/main/memory-alert.ts",
    "find": "            if (!t.sent) settle(t); // the episode ended before its settle window: tell it now",
    "to": "            settle(t);"
   }
  ]
 },
 {
  "id": "289-facts-paused-runs-empty",
  "from": "memory-alert/mutate-unit.mjs:facts-paused-runs-empty",
  "ticket": "#289",
  "clause": "the row names the runs under the memory Pause",
  "arm": "n10_second_episode",
  "check": "the_second_row_names_the_paused_run_and_both_thresholds",
  "edits": [
   {
    "file": "src/main/memory-alert.ts",
    "find": "        veille: deps.veilleSince(t.ep.admission.at),\n        pausedRuns,\n",
    "to": "        veille: deps.veilleSince(t.ep.admission.at),\n        pausedRuns: [],\n"
   }
  ]
 },
 {
  "id": "289-body-no-critical",
  "from": "memory-alert/mutate-unit.mjs:body-no-critical",
  "ticket": "#289",
  "clause": "the row names the CRITICAL threshold crossed and the MemAvailable there",
  "arm": "n10_second_episode",
  "check": "the_second_row_names_the_paused_run_and_both_thresholds",
  "edits": [
   {
    "file": "src/shared/memory-alert.ts",
    "find": "    (ep.critical ? ` and below the CRITICAL threshold (${formatGb(ep.critical.thresholdBytes, 2)}) at ${formatGb(ep.critical.availBytes, 2)}` : '');",
    "to": "    '';"
   }
  ]
 },
 {
  "id": "286-release-not-awaited",
  "from": "own (admission.ts release loop, #286 \"one at a time\")",
  "ticket": "#286",
  "clause": "held starts are released ONE AT A TIME (the loop awaits each start)",
  "arm": "n8_release_order",
  "check": "one_at_a_time",
  "edits": [
   {
    "file": "src/main/admission.ts",
    "find": "        outcome = await runBounded(entry);",
    "to": "        outcome = (void runBounded(entry), undefined);"
   }
  ]
 },
 {
  "id": "285-lift-below-admission",
  "from": "own (memory-guard-mutants M04 family)",
  "ticket": "#285",
  "clause": "the Pause is liftable only ABOVE the Admission threshold (hysteresis: 5.5 GB keeps it)",
  "arm": "n6_pause_containers",
  "check": "the_pause_is_not_lifted_below_the_admission_threshold",
  "edits": [
   {
    "file": "src/shared/memory-guard.ts",
    "find": "  return availBytes > t.admissionBytes;\n",
    "to": "  return availBytes > t.criticalBytes;\n"
   }
  ]
 },
 {
  "id": "290-reprise-releases-workers",
  "from": "own (pause-trap/mutants-reprise.mjs reprise-begin-releases-workers, re-anchored)",
  "ticket": "#290",
  "clause": "the automatic Reprise releases the COORDINATORS only: workers wait for their OPS",
  "arm": "n7b_coordinators_after_containers",
  "check": "the_host_sent_its_consigne_to_the_coordinators_only_workers_stay_blocked",
  "edits": [
   {
    "file": "src/main/pause-reprise.ts",
    "find": "  const coordRows = roster.filter((r) => r.role === 'coordinator');",
    "to": "  const coordRows = roster;"
   }
  ]
 },
 {
  "id": "292-docker-unavailable-blocks-the-trap",
  "from": "own (pause-trap.ts container step, FI-1.5)",
  "ticket": "#292",
  "clause": "Docker unavailable is RECORDED and never blocks the trap or keeps it incomplete",
  "arm": "n10_second_episode",
  "check": "docker_unavailable_does_not_block_the_trap",
  "edits": [
   {
    "file": "src/main/pause-trap.ts",
    "find": "error: `stop: ${errMsg(e)}` };\n    }\n    if (liftedDuringStop) {",
    "to": "error: `stop: ${errMsg(e)}` };\n      incomplete = true;\n    }\n    if (liftedDuringStop) {"
   }
  ]
 }
];
