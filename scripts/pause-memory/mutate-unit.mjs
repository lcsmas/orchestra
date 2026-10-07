#!/usr/bin/env node
// In-place mutants of every clause of the MEMORY Pause (#290, wave G ledger #295). Each mutant edits the REAL source file, runs the unit files that can reach the clause, requires ≥1 test to go
// RED NAMING the expected arm, then restores the file from a BYTE-EXACT backup and `cmp`s it — never a reverse sed. A clean control run (0 red) gates the whole harness, and every anchor must match
// EXACTLY ONCE (else PATTERN-GONE: a mutant that matched nothing would "survive" vacuously).
//   node scripts/pause-memory/mutate-unit.mjs [--only <id[,id]>] [--anchors-only]   →  last line: MUTATE-UNIT: PASS|FAIL (n/N caught)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ONLY = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : null;
const ONLY_SET = ONLY ? new Set(ONLY.split(',')) : null;
const POL = 'src/shared/pause-memory.ts', CORE = 'src/main/pause-memory.ts', HOST = 'src/main/pause-memory-host.ts', SHAUTO = 'src/shared/pause-auto.ts', AUTO = 'src/main/pause-auto.ts';
const IDX = 'src/main/index.ts', RST = 'src/cli/run-status.ts', UI = 'src/main/pause-ui.ts';
const T = {
  pure: 'src/shared/pause-memory.test.ts',
  unit: 'src/main/pause-memory.test.ts',
  wiring: 'src/main/pause-memory-wiring.test.ts',
  status: 'src/cli/run-status-held.test.ts',
  ui: 'src/main/pause-ui.test.ts',
  uiview: 'src/shared/pause-ui-view.test.ts',
  uishared: 'src/shared/pause-ui.test.ts',
  auto: 'src/main/pause-auto.test.ts',
};

const M = [
  // ── pure half (src/shared/pause-memory.ts)
  { id: 'parse-epoch-ignored', file: POL, find: "if (o.reason !== 'memory' || o.epoch !== pausedAt) return null;", rep: "if (o.reason !== 'memory') return null;", tests: [T.pure, T.unit], expect: /STORED MOTIVE|LIFT stale motive/ },
  { id: 'parse-reason-unchecked', file: POL, find: "if (o.reason !== 'memory' || o.epoch !== pausedAt) return null;", rep: "if (o.epoch !== pausedAt) return null;", tests: [T.pure], expect: /STORED MOTIVE/ },
  { id: 'parse-shape-unchecked', file: POL, find: "  if (!n(o.pauseCycle) || !n(o.episode) || !n(o.availBytes) || !n(o.thresholdBytes)) return null;\n", rep: "", tests: [T.pure], expect: /STORED MOTIVE/ },
  { id: 'encode-epoch-dropped', file: POL, find: "    thresholdBytes: reason.thresholdBytes,\n    epoch,\n", rep: "    thresholdBytes: reason.thresholdBytes,\n    epoch: 0,\n", tests: [T.pure, T.unit], expect: /STORED MOTIVE|IMPOSE: critical/ },
  { id: 'encode-held-motive-dropped', file: POL, find: ", motive: 'memory' as const } } : {}),", rep: " } } : {}),", tests: [T.pure, T.unit], expect: /HELD|LIFT held/ },
  { id: 'by-label-changed', file: POL, find: "export const MEMORY_PAUSE_BY = 'host:memory';", rep: "export const MEMORY_PAUSE_BY = 'host:usage_limit';", tests: [T.pure, T.unit, T.ui], expect: /host-written marker|IMPOSE: critical|« l'hôte \(mémoire\) »/ },
  { id: 'want-held-not-impose', file: POL, find: "  if (i.pause === 'held') return 'impose';\n", rep: "", tests: [T.pure], expect: /WANT/ },
  { id: 'want-lift-at-threshold', file: POL, find: "return i.availBytes > i.admissionBytes ? 'lift' : 'none';", rep: "return i.availBytes >= i.admissionBytes ? 'lift' : 'none';", tests: [T.pure, T.unit], expect: /WANT|LIFT level/ },
  { id: 'want-lift-below-admission', file: POL, find: "return i.availBytes > i.admissionBytes ? 'lift' : 'none';", rep: "return i.availBytes > 0 ? 'lift' : 'none';", tests: [T.pure, T.unit], expect: /WANT|LIFT level|LIFT after an app restart/ },
  { id: 'want-unmeasured-acts', file: POL, find: "  if (!i.measured || i.availBytes === null) return 'none';\n", rep: "  if (i.availBytes === null) return 'none';\n", tests: [T.pure], expect: /WANT/ },
  { id: 'lift-ancestor-ignored-pure', file: POL, find: "  if (i.ancestorPaused) return { action: 'wait', why: 'ancestor-paused' };\n", rep: "", tests: [T.pure, T.unit], expect: /LIFT decision|LIFT waits for an ANCESTOR/ },
  { id: 'lift-trap-ignored-pure', file: POL, find: "if (i.trapAt === null && i.now < i.pausedAt + MEMORY_TRAP_WAIT_MAX_MS)", rep: "if (false as boolean)", tests: [T.pure, T.unit], expect: /LIFT decision|LIFT waits for the TRAP/ },
  { id: 'lift-trap-wait-forever', file: POL, find: "export const MEMORY_TRAP_WAIT_MAX_MS = 10 * 60_000;", rep: "export const MEMORY_TRAP_WAIT_MAX_MS = 1e15;", tests: [T.pure, T.unit], expect: /LIFT decision|LIFT waits for the TRAP/ },
  // ── held codec (src/shared/pause-auto.ts) — the memory motive rides the usage-limit codec
  { id: 'held-memory-rejected', file: SHAUTO, find: "if (!parsePauseAuto(json, pausedAt) && !parseMemoryPause(json, pausedAt)) return null;", rep: "if (!parsePauseAuto(json, pausedAt)) return null;", tests: [T.pure, T.unit], expect: /HELD|LIFT held/ },
  { id: 'held-motive-not-read', file: SHAUTO, find: "...(h.motive === 'memory' ? { motive: 'memory' as const } : {}) };", rep: "};", tests: [T.pure, T.status], expect: /HELD|run status \(built CLI\): a HELD memory/ },
  // ── bus half (src/main/pause-memory.ts): candidates
  { id: 'cand-switch-ignored', file: CORE, find: "    .filter((r) => parseSwitches(r.flags_json ?? null).pause === true)\n", rep: "", tests: [T.unit], expect: /IMPOSE switch OFF/ },
  { id: 'cand-topmost-ignored', file: CORE, find: "  return fleet.filter((id) => !ancestorRunIds(db, deps, id).some((a) => set.has(a)));", rep: "  return fleet;", tests: [T.unit], expect: /IMPOSE: critical memory|IMPOSE topmost/ },
  { id: 'cand-archived-ok', file: CORE, find: "const local = (w: { archived?: boolean; host?: { kind: string } } | undefined): boolean => !!w && !w.archived && w.host?.kind !== 'sandbox';", rep: "const local = (w: { archived?: boolean; host?: { kind: string } } | undefined): boolean => !!w && w.host?.kind !== 'sandbox';", tests: [T.unit], expect: /IMPOSE fleet/ },
  { id: 'cand-sandbox-ok', file: CORE, find: "const local = (w: { archived?: boolean; host?: { kind: string } } | undefined): boolean => !!w && !w.archived && w.host?.kind !== 'sandbox';", rep: "const local = (w: { archived?: boolean; host?: { kind: string } } | undefined): boolean => !!w && !w.archived;", tests: [T.unit], expect: /IMPOSE fleet/ },
  { id: 'cand-anchorless-ok', file: CORE, find: "    .filter((id) => local(deps.getWorkspace(id)) && hasMembers.has(id));", rep: "    .filter((id) => hasMembers.has(id));", tests: [T.unit], expect: /IMPOSE fleet/ },
  { id: 'cand-no-members-ok', file: CORE, find: "    .filter((id) => local(deps.getWorkspace(id)) && hasMembers.has(id));", rep: "    .filter((id) => local(deps.getWorkspace(id)));", tests: [T.unit], expect: /IMPOSE fleet: a run whose anchor has NO live workspace below it/ },
  { id: 'cand-member-archived-counts', file: CORE, find: "    if (!local(w)) continue;\n    for (const id of liveChain(deps, w).ids.slice(1)) hasMembers.add(id);", rep: "    for (const id of liveChain(deps, w).ids.slice(1)) hasMembers.add(id);", tests: [T.unit], expect: /IMPOSE fleet: a run whose anchor has NO live workspace below it/ },
  { id: 'impose-wake-refusal-back', file: CORE, find: "  const res = db\n    .prepare(\n      `UPDATE runs SET paused_at = ?, paused_by = ?, pause_mode = 'hard'", rep: "  if (wakeOffAddressees(db, deps, runId).length > 0) return 'other-pause';\n  const res = db\n    .prepare(\n      `UPDATE runs SET paused_at = ?, paused_by = ?, pause_mode = 'hard'", tests: [T.unit], expect: /IMPOSE wake OFF/ },
  // TWO LAYERS cover each other (the classification guard AND the motive re-check inside the re-pause transaction): the mutant removes BOTH — a MANUAL Reprise is then re-paused.
  { id: 'impose-foreign-reprise-repaused', file: CORE, edits: [
    { find: "    if (!mine && !usage) return 'other-pause'; // a MANUAL Reprise is in progress: the human's, not ours to re-pause\n", rep: "" },
    { find: "        if (parseMemoryPause(c.pauseAuto, c.pausedAt) === null && parsePauseAuto(c.pauseAuto, c.pausedAt) === null) return false;\n", rep: "" },
  ], tests: [T.unit], expect: /IMPOSE re-pause: a MANUAL/ },
  { id: 'impose-usage-reprise-ignored', file: CORE, find: "    if (!mine && !usage) return 'other-pause'; // a MANUAL Reprise", rep: "    if (!mine) return 'other-pause'; // a MANUAL Reprise", tests: [T.unit], expect: /IMPOSE usage-limit Reprise/ },
  { id: 'impose-already-misclassified', file: CORE, find: "    if (cur.resumeStartedAt === null) return mine ? 'already' : usage ? 'usage-pause' : 'other-pause';", rep: "    if (cur.resumeStartedAt === null) return 'other-pause';", tests: [T.unit], expect: /IMPOSE already|IMPOSE usage-limit|IMPOSE level read after an app restart/ },
  { id: 'impose-usage-pause-misclassified', file: CORE, find: "    if (cur.resumeStartedAt === null) return mine ? 'already' : usage ? 'usage-pause' : 'other-pause';", rep: "    if (cur.resumeStartedAt === null) return mine ? 'already' : 'other-pause';", tests: [T.unit], expect: /IMPOSE usage-limit/ },
  { id: 'impose-manual-ledgered', file: CORE, find: "      if (outcome === 'paused' || outcome === 'repaused' || outcome === 'already') ledger.imposed.set(runId, ctx.pauseCycle);", rep: "      if (outcome !== 'usage-pause') ledger.imposed.set(runId, ctx.pauseCycle);", tests: [T.unit], expect: /IMPOSE manual ENDED inside the cycle/ },
  { id: 'impose-usage-pause-ledgered', file: CORE, find: "      if (outcome === 'paused' || outcome === 'repaused' || outcome === 'already') ledger.imposed.set(runId, ctx.pauseCycle);", rep: "      ledger.imposed.set(runId, ctx.pauseCycle);", tests: [T.unit], expect: /IMPOSE usage-limit Reprise/ },
  { id: 'impose-repause-tx-recheck-removed', file: CORE, find: "        if (!c || c.pausedAt !== cur.pausedAt || c.resumeStartedAt === null) return false;\n        if (parseMemoryPause(c.pauseAuto, c.pausedAt) === null && parsePauseAuto(c.pauseAuto, c.pausedAt) === null) return false;\n", rep: "", tests: [T.unit], expect: /IMPOSE re-pause: a takeover landing/ },
  { id: 'lift-cas-skipped', file: CORE, edits: [
    { find: " || parseMemoryPause(cur.pauseAuto, cur.pausedAt) === null) return { runId: run.runId, action: 'wait', why: 'changed-meanwhile' };", rep: ") return { runId: run.runId, action: 'wait', why: 'changed-meanwhile' };" },
    { find: " || parseMemoryPause(again.pauseAuto, again.pausedAt) === null) return 'changed-meanwhile';", rep: ") return 'changed-meanwhile';" },
  ], tests: [T.unit], expect: /LIFT changed meanwhile/ },
  { id: 'lift-cas-tx-skipped', file: CORE, find: " || parseMemoryPause(again.pauseAuto, again.pausedAt) === null) return 'changed-meanwhile';", rep: ") return 'changed-meanwhile';", tests: [T.unit], expect: /LIFT changed between the check and the Reprise/ },
  // review m2: a MANUAL Reprise of a memory Pause takes the motive away; the host's own Reprise keeps it
  { id: 'manual-reprise-keeps-motive', file: 'src/main/pause-reprise.ts', find: "    if (opts?.host !== true && parseMemoryPause((db.prepare('SELECT pause_auto FROM runs WHERE id = ?').get(carrierRunId) as { pause_auto: string | null } | undefined)?.pause_auto, pausedAt)) {\n      db.prepare('UPDATE runs SET pause_auto = NULL WHERE id = ? AND paused_at = ?').run(carrierRunId, pausedAt);\n    }\n", rep: "", tests: [T.unit], expect: /IMPOSE re-pause \(review m2\)/ },
  { id: 'host-reprise-clears-motive', file: 'src/main/pause-reprise.ts', find: "    if (opts?.host !== true && parseMemoryPause(", rep: "    if (parseMemoryPause(", tests: [T.unit], expect: /IMPOSE re-pause \(review m2\)|LIFT: memory back/ },
  { id: 'ui-takeover-copy-usage-only', file: 'src/shared/pause-ui.ts', find: "Si l'hôte l'avait posée (limite d'usage ou mémoire), elle devient manuelle", rep: "Si l'hôte l'avait posée sur une limite d'usage, elle devient manuelle", tests: [T.uishared], expect: /explainPauseOutcome|explain|outcome/i },
  { id: 'usage-evaluator-ignores-memory-pause', file: AUTO, find: "  if (deps.memoryPauseHeld?.()) return { runId: run.runId, action: 'wait', why: 'memory-pause-held' };\n", rep: "", tests: [T.unit, T.wiring], expect: /USAGE Reprise defers|WIRING review #2/ },
  { id: 'usage-host-memory-held-unbound', file: 'src/main/pause-auto-host.ts', find: "  memoryPauseHeld: () => getMemoryGuardSnapshot().pause === 'held', // #290: no usage-limit Reprise while the memory Pause is in effect\n", rep: "", tests: [T.wiring], expect: /WIRING review #2/ },
  { id: 'ui-headline-hardcoded-usage', file: 'src/shared/pause-ui-view.ts', find: "const by = run.auto ? (run.pausedByLabel ? `posée par ${run.pausedByLabel}` : 'posée par l\\'hôte (limite d\\'usage)') : run.pausedByLabel", rep: "const by = run.auto ? 'posée par l\\'hôte (limite d\\'usage)' : run.pausedByLabel", tests: [T.uiview, T.ui], expect: /headline|#290: a Pause the memory guard wrote|run headline/i },
  // ── bus half: impose
  // TWO LAYERS cover each other (the "already paused" branch AND the `paused_at IS NULL` guard of the write): the mutant removes BOTH — a manual pause is then overwritten.
  { id: 'impose-manual-overwritten', file: CORE, edits: [
    { find: "  if (cur && cur.pausedAt !== null) {\n    const mine", rep: "  if (false as boolean) {\n    const mine" },
    { find: "        WHERE id = ? AND paused_at IS NULL`,\n    )\n    .run(now, MEMORY_PAUSE_BY", rep: "        WHERE id = ?`,\n    )\n    .run(now, MEMORY_PAUSE_BY" },
  ], tests: [T.unit], expect: /IMPOSE manual|IMPOSE usage-limit|IMPOSE already/ },
  { id: 'impose-repause-removed', file: CORE, find: "        return revertResumeToPaused(db, runId, MEMORY_PAUSE_BY, now, { auto: (epoch) => encodeMemoryPause(reason, epoch) });", rep: "        return false;", tests: [T.unit], expect: /IMPOSE re-pause: memory falls again|IMPOSE usage-limit Reprise/ },
  { id: 'impose-repause-motive-dropped', file: CORE, find: "{ auto: (epoch) => encodeMemoryPause(reason, epoch) }", rep: "{}", tests: [T.unit, T.wiring], expect: /IMPOSE re-pause: memory falls again|WIRING the guard acts ONLY/ },
  { id: 'impose-repause-origin-not-recorded', file: CORE, find: "      if (epoch !== null && epoch !== undefined) recordHostOrigin(db, deps, runId, epoch);\n", rep: "", tests: [T.unit], expect: /IMPOSE re-pause: memory falls again/ },
  { id: 'impose-origin-not-recorded', file: CORE, find: "    recordHostOrigin(db, deps, runId, now);\n    deps.log.info(`memory-pause: ${mem(ctx.availBytes)} < critical ${formatGb(ctx.criticalBytes, 2)} — run ${runId} is now PAUSED", rep: "    deps.log.info(`memory-pause: ${mem(ctx.availBytes)} < critical ${formatGb(ctx.criticalBytes, 2)} — run ${runId} is now PAUSED", tests: [T.unit], expect: /IMPOSE: critical memory/ },
  { id: 'impose-soft-mode', file: CORE, find: "SET paused_at = ?, paused_by = ?, pause_mode = 'hard', pause_deadline_at = NULL, pause_escalated_at = NULL,\n              pause_trap_at = NULL, resume_started_at = NULL, pause_auto = ?\n        WHERE id = ? AND paused_at IS NULL", rep: "SET paused_at = ?, paused_by = ?, pause_mode = 'soft', pause_deadline_at = NULL, pause_escalated_at = NULL,\n              pause_trap_at = NULL, resume_started_at = NULL, pause_auto = ?\n        WHERE id = ? AND paused_at IS NULL", tests: [T.unit], expect: /IMPOSE: critical memory/ },
  { id: 'impose-trap-stamped-at-write', file: CORE, find: "pause_trap_at = NULL, resume_started_at = NULL, pause_auto = ?\n        WHERE id = ? AND paused_at IS NULL", rep: "pause_trap_at = 1, resume_started_at = NULL, pause_auto = ?\n        WHERE id = ? AND paused_at IS NULL", tests: [T.unit], expect: /IMPOSE: critical memory/ },
  { id: 'impose-motive-not-written', file: CORE, find: "    .run(now, MEMORY_PAUSE_BY, encodeMemoryPause(reason, now), runId);", rep: "    .run(now, MEMORY_PAUSE_BY, null, runId);", tests: [T.unit], expect: /IMPOSE: critical memory/ },
  { id: 'impose-store-unready-acts', file: CORE, find: "  if (deps.storeReady && !deps.storeReady()) return []; // UNKNOWN is not NONE: with the store unloaded every fleet would read as \"not there\"\n", rep: "", tests: [T.unit], expect: /IMPOSE unknown/ },
  { id: 'impose-ledger-ignored', file: CORE, find: "    if (ledger.imposed.get(runId) === ctx.pauseCycle) continue;\n", rep: "", tests: [T.unit], expect: /IMPOSE level read \(the tick/ },
  { id: 'impose-ledger-never-set', file: CORE, find: "      if (outcome === 'paused' || outcome === 'repaused' || outcome === 'already') ledger.imposed.set(runId, ctx.pauseCycle);", rep: "", tests: [T.unit], expect: /IMPOSE level read \(the tick/ },
  { id: 'impose-throw-propagates', file: CORE, find: "      deps.log.warn(`memory-pause: imposing the Pause on run ${runId} threw — retried at the next read`, e);", rep: "      throw e;", tests: [T.unit], expect: /IMPOSE a run whose evaluation throws/ },
  // ── bus half: the entry
  { id: 'apply-unmeasured-acts', file: CORE, find: "  if (!view.measured || view.availBytes === null) return none;", rep: "  if (view.availBytes === null) return none;", tests: [T.unit], expect: /IMPOSE unknown/ },
  { id: 'apply-due-ignored', file: CORE, find: "trigger === 'due' ? 'impose' : trigger === 'liftable'", rep: "trigger === 'due' ? 'none' : trigger === 'liftable'", tests: [T.unit], expect: /IMPOSE: critical memory/ },
  { id: 'apply-liftable-ignored', file: CORE, find: "trigger === 'liftable' ? 'lift' : memoryPauseWant(", rep: "trigger === 'liftable' ? 'none' : memoryPauseWant(", tests: [T.unit], expect: /LIFT: memory back/ },
  // ── bus half: lift
  // TWO LAYERS cover each other (the SQL pre-filter AND the null-reason skip): the mutant removes ALL — a manual pause then reads as a memory one.
  { id: 'lift-manual-selected', file: CORE, edits: [
    { find: "WHERE r.paused_at IS NOT NULL AND r.pause_auto IS NOT NULL AND r.resume_started_at IS NULL`", rep: "WHERE r.paused_at IS NOT NULL AND r.resume_started_at IS NULL`" },
    { find: "    if (!reason) continue;\n", rep: "" },
    { find: "    const reason = parseMemoryPause((r.pause_auto as string | null) ?? null, pausedAt);", rep: "    const reason = parseMemoryPause((r.pause_auto as string | null) ?? null, pausedAt) ?? { reason: 'memory' as const, pauseCycle: 0, episode: 0, availBytes: 0, thresholdBytes: 0 };" },
  ], tests: [T.unit], expect: /IMPOSE manual|IMPOSE usage-limit|LIFT human takeover|LIFT stale motive/ },
  { id: 'lift-switch-ignored', file: CORE, find: "    if (parseSwitches((r.flags_json as string | null | undefined) ?? null).pause !== true) continue;\n    const pausedAt = Number(r.paused_at);", rep: "    const pausedAt = Number(r.paused_at);", tests: [T.unit], expect: /LIFT stale motive/ },
  { id: 'lift-epoch-ignored', file: CORE, find: "    const pausedAt = Number(r.paused_at);\n    const reason = parseMemoryPause((r.pause_auto as string | null) ?? null, pausedAt);", rep: "    const pausedAt = Number(r.paused_at);\n    const reason = parseMemoryPause((r.pause_auto as string | null) ?? null, (JSON.parse(String(r.pause_auto)) as { epoch?: number }).epoch ?? null);", tests: [T.unit], expect: /LIFT stale motive/ },
  // TWO LAYERS: the SQL filter AND the pre-call re-read — the mutant removes BOTH, a run already RESUMING is then lifted again.
  { id: 'lift-resuming-reselected', file: CORE, edits: [
    { find: "WHERE r.paused_at IS NOT NULL AND r.pause_auto IS NOT NULL AND r.resume_started_at IS NULL`", rep: "WHERE r.paused_at IS NOT NULL AND r.pause_auto IS NOT NULL`" },
    { find: "cur.pausedAt !== run.pausedAt || cur.resumeStartedAt !== null || parseMemoryPause", rep: "cur.pausedAt !== run.pausedAt || parseMemoryPause" },
  ], tests: [T.unit], expect: /LIFT: memory back|LIFT level/ },
  { id: 'lift-order-unsorted', file: CORE, find: "  return out.sort((a, b) => a.depth - b.depth);", rep: "  return out;", tests: [T.unit], expect: /LIFT order/ },
  { id: 'lift-order-deepest-first', file: CORE, find: "  return out.sort((a, b) => a.depth - b.depth);", rep: "  return out.sort((a, b) => b.depth - a.depth);", tests: [T.unit], expect: /LIFT order/ },
  { id: 'lift-ancestor-ignored', file: CORE, find: "ancestorPaused: ancestorStillPaused(db, deps, run.runId), now });", rep: "ancestorPaused: false, now });", tests: [T.unit], expect: /LIFT waits for an ANCESTOR|LIFT order/ },
  { id: 'lift-wake-hold-removed', file: CORE, find: "  const off = wakeOffAddressees(db, deps, run.runId, run.pausedAt);\n  if (off.length > 0) {\n    const key", rep: "  const off = wakeOffAddressees(db, deps, run.runId, run.pausedAt);\n  if (false as boolean) {\n    const key", tests: [T.unit], expect: /LIFT held/ },
  { id: 'lift-hold-retold-every-read', file: CORE, find: "    if (!curHeld || curHeld.addressees.join('|') !== key.join('|')) {", rep: "    if (true as boolean) {", tests: [T.unit], expect: /LIFT held/ },
  { id: 'lift-hold-set-change-ignored', file: CORE, find: "    if (!curHeld || curHeld.addressees.join('|') !== key.join('|')) {", rep: "    if (!curHeld) {", tests: [T.unit], expect: /LIFT held/ },
  { id: 'lift-hold-record-skipped', file: CORE, find: "encodeMemoryPause(run.reason, run.pausedAt, held), run.runId, run.pausedAt, rawPauseAuto);", rep: "encodeMemoryPause(run.reason, run.pausedAt, null), run.runId, run.pausedAt, rawPauseAuto);", tests: [T.unit], expect: /LIFT held/ },
  { id: 'lift-hold-never-cleared', file: CORE, find: "  if (parseAutoHeld(cur.pauseAuto, cur.pausedAt)) db.prepare('UPDATE runs SET pause_auto = ? WHERE id = ? AND paused_at = ? AND pause_auto = ?').run(encodeMemoryPause(run.reason, run.pausedAt, null), run.runId, run.pausedAt, cur.pauseAuto); // the offending run is gone: the hold ends with it\n", rep: "", tests: [T.unit], expect: /LIFT held/ },
  { id: 'lift-reprise-not-host', file: CORE, find: "deps.beginReprise(db, run.runId, 'host', { host: true, reason: 'memory' })", rep: "deps.beginReprise(db, run.runId, null, {})", tests: [T.unit, T.wiring], expect: /LIFT: memory back|WIRING the guard acts ONLY/ },
  { id: 'lift-reprise-throw-propagates', file: CORE, find: "    return { runId: run.runId, action: 'wait', why: 'reprise-threw' };", rep: "    throw e;", tests: [T.unit], expect: /LIFT a throwing Reprise/ },
  { id: 'lift-store-unready-acts', file: CORE, find: "  if (deps.storeReady && !deps.storeReady()) return []; // UNKNOWN is not NONE: with the store unloaded the live tree is unknown, the ancestor walk would lie\n", rep: "", tests: [T.unit], expect: /IMPOSE unknown|LIFT/ },
  { id: 'lift-log-without-memory', file: CORE, find: "deps.log.info(`memory-pause: ${mem(availBytes)} — memory is back, run ${run.runId} Reprise started", rep: "deps.log.info(`memory-pause: memory is back, run ${run.runId} Reprise started", tests: [T.unit], expect: /LIFT: memory back/ },
  // ── host binding (src/main/pause-memory-host.ts) + wiring
  { id: 'host-reconcile-before-subscribe', file: HOST, edits: [
    { find: "  if (unsubscribe) return;\n  unsubscribe = subscribeMemoryGuard(", rep: "  if (unsubscribe) return;\n  reconcileMemoryPauseNow();\n  unsubscribe = subscribeMemoryGuard(" },
    { find: "  reconcileMemoryPauseNow();\n  timer = setInterval(", rep: "  timer = setInterval(" },
  ], tests: [T.wiring], expect: /WIRING host \(FI-2\.5\)/ },
  { id: 'host-all-edges', file: HOST, find: "    if (transition.kind !== 'pause_due' && transition.kind !== 'pause_liftable') return;\n", rep: "", tests: [T.wiring], expect: /WIRING host \(FI-2\.5\)/ },
  { id: 'host-no-tick', file: HOST, find: "  timer = setInterval(() => void reconcileMemoryPauseNow(), MEMORY_PAUSE_TICK_MS);\n  timer.unref?.();\n", rep: "", tests: [T.wiring], expect: /WIRING host \(FI-2\.5\)/ },
  { id: 'host-store-ready-dropped', file: HOST, find: "  storeReady: () => store.loadedFromDisk,\n", rep: "", tests: [T.wiring], expect: /WIRING host: the real store/ },
  { id: 'host-thresholds-not-passed', file: HOST, find: "admissionBytes: s.admissionBytes, criticalBytes: s.criticalBytes }", rep: "admissionBytes: 6 * 1024 ** 3, criticalBytes: 3 * 1024 ** 3 }", tests: [T.wiring], expect: /WIRING host: the real store/ },
  { id: 'index-start-removed', file: IDX, find: "  startMemoryPause();\n", rep: "", tests: [T.wiring], expect: /WIRING index\.ts/ },
  // The memory Pause starts BEFORE `buildPauseTrapDeps()` registered the live workspace tree (review m3): a boot-time reconcile lifts on the bus run tree alone.
  { id: 'index-start-before-trap-deps', file: IDX, edits: [
    { find: "  startMemoryPause();\n", rep: "" },
    { find: "    const pauseTrapDeps = buildPauseTrapDeps();\n", rep: "    startMemoryPause();\n    const pauseTrapDeps = buildPauseTrapDeps();\n" },
  ], tests: [T.wiring], expect: /WIRING index\.ts/ },
  { id: 'index-stop-removed', file: IDX, find: "  stopMemoryPause();\n", rep: "", tests: [T.wiring], expect: /WIRING index\.ts/ },
  { id: 'core-imports-store', file: CORE, find: "import { parseSwitches } from '../shared/bus-switches.ts';", rep: "import { parseSwitches } from '../shared/bus-switches.ts';\nimport { store as _s } from './store.ts';", tests: [T.wiring], expect: /WIRING pause-memory\.ts is Electron-free/ },
  { id: 'core-owns-container-step', file: CORE, find: "import { revertResumeToPaused } from './pause-reprise.ts';", rep: "import { revertResumeToPaused } from './pause-reprise.ts';\nimport { restartOwedContainers as _r } from './pause-containers.ts';", tests: [T.wiring], expect: /WIRING the guard acts ONLY/ },
  // ── the usage-limit motive must keep ignoring a memory Pause
  { id: 'usage-parser-accepts-memory', file: SHAUTO, find: "  if (o.reason !== 'usage_limit') return null;\n  if (o.epoch !== pausedAt) return null;\n  if (!Array.isArray(o.wsIds)", rep: "  if (o.reason !== 'usage_limit' && o.reason !== 'memory') return null;\n  if (o.epoch !== pausedAt) return null;\n  if (!Array.isArray(o.wsIds)", tests: [T.wiring, T.unit, T.pure], expect: /WIRING the quota evaluator|USAGE motive|usage-limit parser never accepts/ },
  // ── display
  { id: 'status-held-wording-usage-only', file: RST, find: "${st.autoHeld.motive === 'memory' ? 'memory is back' : 'the usage quota is back'}", rep: "the usage quota is back", tests: [T.status], expect: /run status \(built CLI\): a HELD memory/, build: true },
  { id: 'ui-label-memory-dropped', file: UI, find: ` : pv.pausedBy === MEMORY_PAUSE_BY ? "l'hôte (mémoire)" : label(`, rep: " : label(", tests: [T.ui], expect: /#290: a Pause the memory guard wrote/ },
];

const sel = ONLY ? M.filter((m) => ONLY_SET.has(m.id)) : M;
if (sel.length === 0) { console.error(`unknown mutant ${ONLY}`); process.exit(2); }

// --anchors-only: every anchor must match the CURRENT source exactly once, and every `expect` must match the TITLE of a test in the mutant's own files (an expect naming a renamed test can never be "caught").
if (process.argv.includes('--anchors-only')) {
  let gone = 0;
  for (const m of sel) {
    const src = fs.readFileSync(path.join(REPO, m.file), 'utf8');
    for (const e of (m.edits ?? [{ find: m.find }])) {
      const hits = src.split(e.find).length - 1;
      if (hits !== 1) { gone++; console.log(`✗ ${m.id}: anchor matched ${hits}× in ${m.file}: ${e.find.slice(0, 70)}`); }
    }
  }
  const titlesOf = (f) => [...fs.readFileSync(path.join(REPO, f), 'utf8').matchAll(/\btest\((['"`])((?:\\.|(?!\1)[^\\])*)\1/g)].map((x) => x[2].replace(/\\'/g, "'"));
  for (const m of sel) {
    const titles = m.tests.flatMap(titlesOf);
    if (!titles.some((t) => m.expect.test(t.replace(/#/g, '\\#')) || m.expect.test(t))) { gone++; console.log(`✗ ${m.id}: expect ${m.expect} matches no test title in ${m.tests.join(', ')}`); }
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
  const skipped = Number(/^# skipped (\d+)/m.exec(out)?.[1] ?? NaN);
  const red = [...out.matchAll(/^not ok \d+ - (.+)$/gm)].map((m) => m[1]);
  return { fail, pass, skipped, red, raw: out };
}
function rebuildCli() { // the CLI-side mutants (run-status.ts) exec the BUILT bundle: rebuild it under the mutation and again after the restore
  const r = spawnSync('pnpm', ['run', 'build:cli'], { cwd: REPO, encoding: 'utf8', timeout: 120_000 });
  if (r.status !== 0) { console.error(`build:cli failed rc=${r.status}: ${(r.stderr ?? '').slice(-300)}`); process.exit(3); }
}
rebuildCli(); // a stale bundle makes the control vacuous
const allFiles = [...new Set(sel.flatMap((m) => m.tests))];
const control = await runTests(allFiles);
console.log(`control (clean tree, ${allFiles.length} files): pass ${control.pass}, fail ${control.fail}, skipped ${control.skipped}`);
if (control.fail !== 0 || !(control.pass > 0) || control.skipped !== 0) { console.log(`MUTATE-UNIT: FAIL — the clean control is not green with 0 skipped (${control.red.join(' | ')})`); process.exit(1); }

let caught = 0;
const bak = fs.mkdtempSync(path.join(os.tmpdir(), 'mutate-unit-pause-memory-'));
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
    if (m.build) rebuildCli();
    res = await runTests(m.tests);
  } finally {
    fs.copyFileSync(backup, abs); // byte-exact restore
    activeRestore = null;
    if (m.build) rebuildCli();
  }
  const restored = spawnSync('cmp', [abs, backup]).status === 0;
  const named = res.red.filter((n) => m.expect.test(n) || m.expect.test(n.replace(/\\#/g, '#')));
  const ok = restored && res.red.length > 0 && named.length > 0;
  if (ok) caught++;
  console.log(`${ok ? '✓' : '✗'} ${m.id}: ${res.red.length} red${named.length ? ` — named arm: ${named[0].slice(0, 90)}` : res.red.length ? ` — RED BUT NOT THE EXPECTED ARM (${res.red[0].slice(0, 80)})` : ' — SURVIVED'}${restored ? '' : ' — NOT RESTORED'}`);
}
const gitDirty = spawnSync('git', ['diff', '--quiet', '--', ...[...new Set(sel.map((m) => m.file))]], { cwd: REPO }).status;
fs.rmSync(bak, { recursive: true, force: true });
const post = await runTests(allFiles);
console.log(`post-restore control: pass ${post.pass}, fail ${post.fail}, skipped ${post.skipped}; changed vs index for mutated files: ${gitDirty === 0 ? 'no' : 'yes (uncommitted edits exist — compare with cmp above)'}`);
const ok = caught === sel.length && post.fail === 0 && post.skipped === 0;
console.log(`MUTATE-UNIT: ${ok ? 'PASS' : 'FAIL'} (${caught}/${sel.length} caught)`);
process.exit(ok ? 0 : 1);
