#!/usr/bin/env node
// In-place mutants of every clause of the auto Pause / auto Reprise (#256, wave E ledger #276 G2). Each mutant edits the REAL source file, runs the
// unit files that can reach the clause, requires ≥1 test to go RED (naming which), then restores the file from a BYTE-EXACT backup and `cmp`s it —
// never a reverse sed. A clean control run (0 red) gates the whole harness, and every anchor must match EXACTLY ONCE (else PATTERN-GONE: a mutant
// that matched nothing would "survive" vacuously).
//   node scripts/pause-auto/mutate-unit.mjs [--only <id[,id]>] [--anchors-only]   →  last line: MUTATE-UNIT: PASS|FAIL (n/N caught)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ONLY = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : null;
const ONLY_SET = ONLY ? new Set(ONLY.split(',')) : null;
const POL = 'src/shared/pause-auto.ts', CORE = 'src/main/pause-auto.ts', HOST = 'src/main/pause-auto-host.ts';
const ACT = 'src/main/activity.ts', PQ = 'src/main/prompt-queue.ts', WS = 'src/main/workspaces.ts', API = 'src/main/api-handlers.ts', AU = 'src/main/account-usage.ts';
const BP = 'src/main/bus-pause.ts';
const T = {
  pure: 'src/shared/pause-auto.test.ts', unit: 'src/main/pause-auto.test.ts', wiring: 'src/main/pause-auto-wiring.test.ts', rig: 'src/main/pause-auto-rig.test.ts',
};

const M = [
  // ── pure policy (src/shared/pause-auto.ts)
  { id: 'verdict-no-quota-override', file: POL, find: "if (until === null) return { ok: true, via: 'quota' };", rep: "if (until === null && (e.resetsAtMs === null || e.now >= e.resetsAtMs)) return { ok: true, via: 'quota' };", tests: [T.pure, T.unit], expect: /VERDICT quota override|REPRISE quota override/ },
  { id: 'verdict-stale-reading-accepted', file: POL, find: "r.fetchedAt > e.blockedAt && (e.accountChangedAt", rep: "(e.accountChangedAt", tests: [T.pure, T.unit], expect: /VERDICT staleness|REPRISE waits while/ },
  { id: 'verdict-blocked-same-ms-fresh', file: POL, find: "r.fetchedAt > e.blockedAt && (e.accountChangedAt", rep: "r.fetchedAt >= e.blockedAt && (e.accountChangedAt", tests: [T.pure], expect: /VERDICT staleness/ },
  { id: 'verdict-account-change-ignored', file: POL, find: " && (e.accountChangedAt === null || r.fetchedAt >= e.accountChangedAt)) {", rep: ") {", tests: [T.pure, T.unit], expect: /VERDICT account change|ACCOUNT CHANGE migrate: WITHOUT/ },
  { id: 'verdict-account-change-strict', file: POL, find: "r.fetchedAt >= e.accountChangedAt", rep: "r.fetchedAt > e.accountChangedAt", tests: [T.pure], expect: /VERDICT account change/ },
  { id: 'verdict-limited-not-waited', file: POL, find: "    if (e.now < until) return { ok: false, why: 'limited', refresh: false };\n", rep: "", tests: [T.pure], expect: /VERDICT limited/ },
  { id: 'verdict-expired-limited-vetoes', file: POL, find: "    if (e.now < until) return { ok: false, why: 'limited', refresh: false };", rep: "    return { ok: false, why: 'limited', refresh: false };", tests: [T.pure], expect: /OWN reset has passed/ },
  { id: 'verdict-grace-zero', file: POL, find: "e.now >= resetsAtMs + RESET_GRACE_MS) return { ok: true, via: 'reset-grace' };", rep: "e.now >= resetsAtMs) return { ok: true, via: 'reset-grace' };", tests: [T.pure], expect: /VERDICT reset grace/ },
  { id: 'verdict-unknown-reset-resumes', file: POL, find: "if (resetsAtMs !== null && e.now >= resetsAtMs + RESET_GRACE_MS)", rep: "if (e.now >= (resetsAtMs ?? 0) + RESET_GRACE_MS)", tests: [T.pure], expect: /VERDICT reset grace/ },
  { id: 'verdict-grace-vetoes-skipped', file: POL, find: "    if (e.now < until) return { ok: false, why: 'limited', refresh: false };\n    // the reading's own block has expired since it was taken: it says nothing about now\n", rep: "    // mutant: a limited reading never vetoes\n", tests: [T.pure], expect: /still-limited reading taken AFTER the reset|VERDICT limited/ },
  { id: 'verdict-refresh-never-asked', file: POL, find: "refresh: resetsAtMs === null || e.now >= resetsAtMs }", rep: "refresh: false }", tests: [T.pure, T.unit], expect: /VERDICT reset grace|REPRISE refresh/ },
  { id: 'verdict-null-data-is-reading', file: POL, find: "if (r && r.data && r.fetchedAt", rep: "if (r && r.fetchedAt", tests: [T.pure], expect: /reading without data/ },
  { id: 'run-any-member-enough', file: POL, find: "if (!i.verdicts.every((v) => v.ok))", rep: "if (!i.verdicts.some((v) => v.ok))", tests: [T.pure, T.unit], expect: /RUN decision: every trigger|REPRISE trigger set/ },
  { id: 'run-trap-ignored', file: POL, find: "if (i.trapAt === null && i.now < i.pausedAt + TRAP_WAIT_MAX_MS) return", rep: "if (false) return", tests: [T.pure, T.unit, T.rig], expect: /RUN decision: the Reprise waits for the trap|REPRISE trap|RIG trap_wait/ },
  { id: 'run-trap-wait-forever', file: POL, find: "export const TRAP_WAIT_MAX_MS = 10 * 60_000;", rep: "export const TRAP_WAIT_MAX_MS = 1e15;", tests: [T.pure], expect: /constants/ },
  { id: 'run-no-trigger-reprises', file: POL, find: "  if (i.verdicts.length === 0) return { action: 'wait', why: 'no-trigger-member' };\n", rep: "", tests: [T.pure], expect: /RUN decision: every trigger/ },
  { id: 'parse-epoch-ignored', file: POL, find: "  if (o.epoch !== pausedAt) return null;\n", rep: "", tests: [T.pure, T.unit], expect: /ENCODING: pause_auto round-trips|REPRISE manual/ },
  { id: 'parse-reason-unchecked', file: POL, find: "  if (o.reason !== 'usage_limit') return null;\n", rep: "", tests: [T.pure], expect: /ENCODING: malformed/ },
  { id: 'parse-shape-unchecked', file: POL, find: "  if (!Array.isArray(o.wsIds) || !o.wsIds.every((x) => typeof x === 'string')) return null;\n", rep: "", tests: [T.pure], expect: /ENCODING: malformed/ },
  { id: 'merge-duplicates-member', file: POL, find: "  if (i >= 0) accountIds[i] = add.accountId;\n  else {", rep: "  if (false) accountIds[i] = add.accountId;\n  else {", tests: [T.pure], expect: /MERGE/ },
  { id: 'auto-label-changed', file: POL, find: "export const PAUSE_AUTO_BY = 'host:usage_limit';", rep: "export const PAUSE_AUTO_BY = 'host';", tests: [T.pure, T.unit], expect: /constants|PAUSE: a worker/ },
  // ── bus half (src/main/pause-auto.ts)
  { id: 'pause-switch-ignored', file: CORE, find: "for (const id of ids) if (getRun(db, id)?.flags.pause === true) return id;", rep: "for (const id of ids) if (getRun(db, id) !== null) return id;", tests: [T.unit, T.rig], expect: /PAUSE carrier|PAUSE OFF identity/ },
  { id: 'pause-carrier-top-down', file: CORE, find: "for (const id of ids) if (getRun(db, id)?.flags.pause === true) return id;", rep: "for (const id of [...ids].reverse()) if (getRun(db, id)?.flags.pause === true) return id;", tests: [T.unit], expect: /PAUSE: a worker/ },
  { id: 'pause-dangling-fallback-removed', file: CORE, find: "  if (dangling) {\n    // a workspace on the chain is gone from the store: the bus run tree", rep: "  if (false) {\n    // a workspace on the chain is gone from the store: the bus run tree", tests: [T.unit], expect: /PAUSE dangling/ },
  { id: 'pause-manual-adopted', file: CORE, find: "if (row.pausedAt === null || (auto === null && !resuming)) return 'manual-pause';", rep: "if (row.pausedAt === null) return 'manual-pause';", tests: [T.unit, T.rig], expect: /PAUSE manual|PAUSE ancestor|RIG manual_never/ },
  { id: 'pause-soft-mode', file: CORE, find: "SET paused_at = ?, paused_by = ?, pause_mode = 'hard', pause_deadline_at", rep: "SET paused_at = ?, paused_by = ?, pause_mode = 'soft', pause_deadline_at", tests: [T.unit, T.rig], expect: /PAUSE: a worker|RIG limit_pause/ },
  { id: 'pause-trap-stamped-at-write', file: CORE, find: "pause_trap_at = NULL, resume_started_at = NULL, pause_auto = ?\n        WHERE id = ? AND paused_at IS NULL", rep: "pause_trap_at = 1, resume_started_at = NULL, pause_auto = ?\n        WHERE id = ? AND paused_at IS NULL", tests: [T.unit], expect: /PAUSE: a worker/ },
  { id: 'pause-merge-dropped', file: CORE, find: "run(encodePauseAuto(merged, row.pausedAt as number), gov.runId, row.pausedAt);", rep: "run(encodePauseAuto(auto, row.pausedAt as number), gov.runId, row.pausedAt);", tests: [T.unit], expect: /PAUSE merge|PAUSE ancestor/ },
  { id: 'pause-resuming-not-repaused', file: CORE, find: "    if (resuming) {\n      // A Pause while RESUMING", rep: "    if (false) {\n      // A Pause while RESUMING", tests: [T.unit, T.rig], expect: /PAUSE while RESUMING|RIG repause/ },
  { id: 'int-repause-reason-dropped', file: CORE, find: "{ auto: (epoch) => encodePauseAuto(merged, epoch) }", rep: "{}", tests: [T.unit, T.rig], expect: /PAUSE while RESUMING|RIG repause/ },
  { id: 'int-repause-owned-by-someone-else', file: CORE, find: "revertResumeToPaused(db, gov.runId, PAUSE_AUTO_BY, deps.now()", rep: "revertResumeToPaused(db, gov.runId, 'someone', deps.now()", tests: [T.unit], expect: /PAUSE while RESUMING/ },
  { id: 'pause-repause-origin-not-recorded', file: CORE, find: "        if (epoch !== null && epoch !== undefined) recordHostOrigin(db, deps, gov.runId, epoch);\n", rep: "", tests: [T.unit], expect: /PAUSE while RESUMING/ },
  { id: 'pause-origin-not-recorded', file: CORE, find: "    recordHostOrigin(db, deps, carrier, now);\n", rep: "", tests: [T.unit], expect: /PAUSE origin/ },
  { id: 'pause-pinned-account-lost', file: CORE, find: "  const accountId = resolveWorkspaceAccountId(ws.accountId, deps.knownAccountIds());\n\n  // Already governed", rep: "  const accountId = null;\n\n  // Already governed", tests: [T.unit, T.rig], expect: /PAUSE: a worker|PAUSE merge|RIG limit_pause/ },
  { id: 'eval-switch-ignored', file: CORE, find: "    if (parseSwitches((r.flags_json as string | null | undefined) ?? null).pause !== true) continue;\n", rep: "", tests: [T.unit], expect: /REPRISE frozen switch/ },
  // TWO LAYERS cover each other (the SQL filter AND the pre-call re-read): the mutant removes BOTH — a run already RESUMING is then Reprised again.
  { id: 'eval-resuming-reselected', file: CORE, edits: [
    { find: "AND r.pause_auto IS NOT NULL AND r.resume_started_at IS NULL`", rep: "AND r.pause_auto IS NOT NULL`" },
    { find: "cur.pausedAt !== run.pausedAt || cur.resumeStartedAt !== null || parsePauseAuto", rep: "cur.pausedAt !== run.pausedAt || parsePauseAuto" },
  ], tests: [T.unit], expect: /REPRISE once/ },
  // TWO LAYERS cover each other (the SQL pre-filter AND the null-reason skip): the mutant removes BOTH — a manual pause then evaluates like an auto one.
  { id: 'eval-manual-selected', file: CORE, edits: [
    { find: "WHERE r.paused_at IS NOT NULL AND r.pause_auto IS NOT NULL AND", rep: "WHERE r.paused_at IS NOT NULL AND" },
    { find: "    if (!reason) continue;\n", rep: "" },
    { find: "    const reason = parsePauseAuto((r.pause_auto as string | null) ?? null, pausedAt);", rep: "    const reason = parsePauseAuto((r.pause_auto as string | null) ?? null, pausedAt) ?? { reason: 'usage_limit' as const, wsIds: ['w1'], accountIds: ['A'] };" },
  ], tests: [T.unit], expect: /REPRISE manual/ },
  { id: 'eval-order-unsorted', file: CORE, find: "  return out.sort((a, b) => a.depth - b.depth);", rep: "  return out;", tests: [T.unit], expect: /REPRISE order/ },
  { id: 'eval-order-deepest-first', file: CORE, find: "  return out.sort((a, b) => a.depth - b.depth);", rep: "  return out.sort((a, b) => b.depth - a.depth);", tests: [T.unit], expect: /REPRISE order/ },
  { id: 'eval-stored-account-used', file: CORE, find: "    const account = resolveWorkspaceAccountId(ws.accountId, known); // the CURRENT pin — a migration moved it", rep: "    const account = run.reason.accountIds[run.reason.wsIds.indexOf(wsId)] ?? null;", tests: [T.unit], expect: /REPRISE current pin/ },
  { id: 'eval-marker-time-ignored', file: CORE, find: "    const blockedAt = marker ?? run.pausedAt;", rep: "    const blockedAt = 0;", tests: [T.unit], expect: /REPRISE waits while/ },
  { id: 'eval-gone-trigger-blocks', file: CORE, find: "  if (live.length === 0) {", rep: "  if (false) {", tests: [T.unit], expect: /REPRISE gone trigger/ },
  { id: 'eval-reprise-not-host', file: CORE, find: "deps.beginReprise(db, run.runId, 'host', { host: true, reason: 'usage_limit' })", rep: "deps.beginReprise(db, run.runId, null, {})", tests: [T.unit], expect: /REPRISE quota override/ },
  { id: 'eval-refresh-not-requested', file: CORE, find: "    if (refresh.length > 0) deps.requestRefresh(refresh);\n", rep: "", tests: [T.unit], expect: /REPRISE refresh/ },
  { id: 'eval-throw-propagates', file: CORE, find: "  } catch (e) {\n    deps.log.warn(`pause-auto: Reprise of run ${run.runId} threw — retried next tick`, e);", rep: "  } catch (e) {\n    throw e;\n    deps.log.warn(`pause-auto: Reprise of run ${run.runId} threw — retried next tick`, e);", tests: [T.unit], expect: /REPRISE once/ },
  { id: 'change-no-force', file: CORE, find: "    await deps.forceRefresh(forced);\n", rep: "", tests: [T.unit, T.rig], expect: /ACCOUNT CHANGE migrate|RIG switch_resume|RIG relogin_resume/ },
  { id: 'change-no-note', file: CORE, find: "        deps.noteAccountChanged(wsId, deps.now()); // readings older than this were taken for the OLD account / login\n", rep: "", tests: [T.unit], expect: /ACCOUNT CHANGE migrate: WITHOUT/ },
  { id: 'change-forces-when-idle', file: CORE, find: "  if (runs.length === 0) return none;\n", rep: "", tests: [T.unit, T.rig], expect: /ACCOUNT CHANGE nothing waiting|RIG off_identity/ },
  { id: 'change-login-matches-any', file: CORE, find: "(change.kind === 'login' && account === change.accountId)", rep: "(change.kind === 'login')", tests: [T.unit], expect: /ACCOUNT CHANGE login|ACCOUNT CHANGE nothing waiting/ },
  { id: 'change-migrate-matches-any', file: CORE, find: "(change.kind === 'migrate' && wsId === change.wsId)", rep: "(change.kind === 'migrate')", tests: [T.unit], expect: /ACCOUNT CHANGE nothing waiting/ },
  { id: 'change-display-account-stale', file: CORE, find: "          db.prepare('UPDATE runs SET pause_auto = ? WHERE id = ? AND paused_at = ?').run(encodePauseAuto(merged, run.pausedAt), run.runId, run.pausedAt);\n", rep: "", tests: [T.unit, T.rig], expect: /ACCOUNT CHANGE migrate: forces|RIG switch_resume/ },
  { id: 'change-no-reevaluate', file: CORE, find: "  return { runs, forced, evaluated: await evaluateAutoPaused(deps) };", rep: "  return { runs, forced, evaluated: [] };", tests: [T.unit, T.rig], expect: /ACCOUNT CHANGE migrate|RIG switch_resume|RIG relogin_resume/ },
  { id: 'change-force-failure-aborts', file: CORE, find: "    deps.log.warn('pause-auto: forced usage refresh failed — evaluating on what is cached', e);", rep: "    throw e;", tests: [T.unit], expect: /ACCOUNT CHANGE: a failed forced read/ },
  { id: 'verdict-reset-survives-account-change', file: POL, find: "const resetsAtMs = e.accountChangedAt !== null ? null : e.resetsAtMs;", rep: "const resetsAtMs = e.resetsAtMs;", tests: [T.pure, T.unit], expect: /VERDICT account change: the stored reset|ACCOUNT CHANGE reset/ },
  { id: 'run-backoff-ignored', file: POL, find: "  if (i.holdoffUntil != null && i.now < i.holdoffUntil) return { action: 'wait', why: 'backoff' };\n", rep: "", tests: [T.pure, T.unit, T.rig], expect: /RUN decision: the flap guard|REPRISE backoff|RIG repause/ },
  { id: 'backoff-doubling-removed', file: POL, find: "Math.min(REPRISE_BACKOFF_BASE_MS * 2 ** (streak - 1), REPRISE_BACKOFF_CAP_MS)", rep: "Math.min(REPRISE_BACKOFF_BASE_MS, REPRISE_BACKOFF_CAP_MS)", tests: [T.pure, T.unit], expect: /constants: the flap guard|REPRISE backoff/ },
  { id: 'backoff-uncapped', file: POL, find: "Math.min(REPRISE_BACKOFF_BASE_MS * 2 ** (streak - 1), REPRISE_BACKOFF_CAP_MS)", rep: "REPRISE_BACKOFF_BASE_MS * 2 ** (streak - 1)", tests: [T.pure, T.unit], expect: /constants: the flap guard|REPRISE backoff/ },
  { id: 'backoff-window-removed', file: POL, find: "export const REPRISE_STREAK_WINDOW_MS = 2 * 3_600_000;", rep: "export const REPRISE_STREAK_WINDOW_MS = 1e15;", tests: [T.pure, T.unit], expect: /constants: the flap guard|REPRISE backoff/ },
  { id: 'eval-streak-not-noted', file: CORE, find: "    deps.noteReprise(run.runId, now);\n", rep: "", tests: [T.unit], expect: /REPRISE quota override|REPRISE backoff/ },
  { id: 'eval-latest-block-ignored', file: CORE, find: "holdoffUntil: streak > 0 ? latestBlock + repriseBackoffMs(streak) : null", rep: "holdoffUntil: streak > 0 ? run.pausedAt + repriseBackoffMs(streak) : null", tests: [T.unit, T.rig], expect: /REPRISE backoff|RIG repause/ },
  { id: 'eval-ancestor-ignored', file: CORE, find: "  if (ancestorStillPaused(db, deps, run.runId)) return { runId: run.runId, action: 'wait', why: 'ancestor-paused' };\n", rep: "", tests: [T.unit], expect: /REPRISE ancestor/ },
  { id: 'eval-ancestor-resuming-blocks', file: CORE, find: "    if (c && c.pausedAt !== null && c.resumeStartedAt === null) return true;", rep: "    if (c && c.pausedAt !== null) return true;", tests: [T.unit], expect: /REPRISE ancestor|REPRISE order/ },
  { id: 'eval-reread-removed', file: CORE, find: "  if (!cur || cur.pausedAt !== run.pausedAt || cur.resumeStartedAt !== null || parsePauseAuto(cur.pauseAuto, cur.pausedAt) === null) {", rep: "  if (false) {", tests: [T.unit], expect: /REPRISE changed meanwhile/ },
  { id: 'eval-no-per-run-isolation', file: CORE, find: "      deps.log.warn(`pause-auto: evaluating run ${run.runId} threw — retried next tick`, e);\n      out.push({ runId: run.runId, action: 'wait', why: 'evaluate-threw' });", rep: "      throw e;", tests: [T.unit], expect: /REPRISE isolation/ },
  // ── host seams (activity / prompt-queue / workspaces / api-handlers / account-usage / host binding)
  { id: 'wire-observer-fires-on-remark', file: ACT, find: "  if (!opts.remark) {\n    try {\n      usageLimitStopObserver?.(id);", rep: "  if (true) {\n    try {\n      usageLimitStopObserver?.(id);", tests: [T.wiring], expect: /WIRING activity/ },
  { id: 'wire-observer-never-fires', file: ACT, find: "      usageLimitStopObserver?.(id);\n", rep: "", tests: [T.wiring, T.rig], expect: /WIRING activity|RIG limit_pause/ },
  { id: 'wire-tick-no-evaluate', file: PQ, find: "  await evaluatePausedRuns();\n  const candidates", rep: "  const candidates", tests: [T.wiring, T.rig], expect: /WIRING prompt-queue|RIG quota_back_tick/ },
  { id: 'wire-tick-evaluates-after-nudge', file: PQ, find: "  await evaluatePausedRuns();\n  const candidates = store.workspaces\n    .filter((ws) => !ws.archived && ws.lastStopReason === 'usage_limit')\n    // Coordinators first (see above). Stable within each group otherwise.\n    .sort((a, b) => Number(isCoordinatorWorkspace(b)) - Number(isCoordinatorWorkspace(a)));", rep: "  const candidates = store.workspaces\n    .filter((ws) => !ws.archived && ws.lastStopReason === 'usage_limit')\n    // Coordinators first (see above). Stable within each group otherwise.\n    .sort((a, b) => Number(isCoordinatorWorkspace(b)) - Number(isCoordinatorWorkspace(a)));\n  await evaluatePausedRuns();", tests: [T.wiring], expect: /WIRING prompt-queue/ },
  { id: 'wire-remark-not-silent', file: PQ, find: "ws.usageLimitResetsAt ?? null, { remark: true })", rep: "ws.usageLimitResetsAt ?? null)", tests: [T.wiring], expect: /WIRING prompt-queue/ },
  { id: 'wire-flusher-no-observer', file: PQ, find: "  startPauseAuto(); // #256:", rep: "  // #256:", tests: [T.wiring, T.rig], expect: /WIRING prompt-queue|RIG limit_pause/ },
  { id: 'wire-flusher-stop-leaves-observer', file: PQ, find: "export function stopPromptQueueFlusher(): void {\n  stopPauseAuto();", rep: "export function stopPromptQueueFlusher(): void {", tests: [T.wiring], expect: /WIRING prompt-queue/ },
  { id: 'wire-tick-constant', file: PQ, find: "const TICK_MS = 20_000;", rep: "const TICK_MS = 60_000;", tests: [T.wiring], expect: /WIRING prompt-queue/ },
  { id: 'wire-migrate-no-hook', file: WS, find: "    void pauseAutoOnMigrate(id);\n", rep: "", tests: [T.wiring, T.rig], expect: /WIRING workspaces|RIG switch_resume/ },
  { id: 'wire-login-no-hook', file: API, find: "      void pauseAutoOnLogin(accountId);\n", rep: "", tests: [T.wiring, T.rig], expect: /WIRING api-handlers|RIG relogin_resume/ },
  { id: 'wire-force-oauth-ignored', file: AU, find: "    const fresh = prev && prev.dir === creds.dir && prev.status.ok && now - prev.status.fetchedAt < CACHE_MS && !force.has(acc.id);", rep: "    const fresh = prev && prev.dir === creds.dir && prev.status.ok && now - prev.status.fetchedAt < CACHE_MS;", tests: [T.wiring, T.rig], expect: /WIRING account-usage|RIG switch_resume|RIG relogin_resume/ },
  { id: 'wire-force-apikey-ignored', file: AU, find: "      const fresh = prev && prev.dir === dir && prev.status.ok && now - prev.status.fetchedAt < CACHE_MS && !force.has(acc.id);", rep: "      const fresh = prev && prev.dir === dir && prev.status.ok && now - prev.status.fetchedAt < CACHE_MS;", tests: [T.wiring], expect: /WIRING account-usage/ },
  { id: 'wire-refresh-drops-force', file: AU, find: "refreshStale(Date.now(), new Set(opts.force ?? []))", rep: "refreshStale(Date.now())", tests: [T.wiring, T.rig], expect: /WIRING account-usage|RIG switch_resume|RIG quota_back_tick/ },
  { id: 'wire-key-save-no-hook', file: API, find: "    void pauseAutoOnLogin(accountId); // #256: a replaced key is a new credential — forced fresh reading for the paused runs waiting on this account\n", rep: "", tests: [T.wiring], expect: /WIRING api-handlers.ts: a replaced API key/ },
  { id: 'wire-remark-fires-observer-in-rig', file: PQ, find: "ws.usageLimitResetsAt ?? null, { remark: true })", rep: "ws.usageLimitResetsAt ?? null)", tests: [T.rig], expect: /RIG remark_no_repause/ },
  { id: 'int-adopt-removed', file: BP, find: "      // #256: a human re-asserting a pause the HOST wrote on a usage limit takes it over — `pause_auto` NULL = manual, never auto-resumed (D6).\n      db.prepare('UPDATE runs SET pause_auto = NULL WHERE id = ? AND paused_at IS NOT NULL').run(runId);\n", rep: "", tests: [T.unit, T.wiring], expect: /INTEGRATION human re-assert|WIRING #255/ },
  { id: 'int-include-released-removed', file: CORE, find: "pausedCarrierForWorkspace(db, ws, deps.getWorkspace, { includeReleased: true })", rep: "pausedCarrierForWorkspace(db, ws, deps.getWorkspace)", tests: [T.unit, T.wiring], expect: /INTEGRATION released member|WIRING #255/ },
  { id: 'int-reprise-not-host', file: CORE, find: "deps.beginReprise(db, run.runId, 'host', { host: true, reason: 'usage_limit' })", rep: "deps.beginReprise(db, run.runId, 'nobody', { reason: 'usage_limit' })", tests: [T.unit], expect: /INTEGRATION Reprise: the REAL beginReprise|REPRISE quota override/ },
  { id: 'int-host-reprise-unbound', file: HOST, find: "\n  beginReprise,\n", rep: "\n  beginReprise: () => 'not-paused',\n", tests: [T.wiring, T.rig], expect: /WIRING #255|RIG switch_resume/ },
  { id: 'r2-streak-not-reset', file: CORE, find: "      deps.resetStreak(run.runId); // an explicit switch / re-login is new evidence: the flap guard must not hold the Reprise it exists to make prompt\n", rep: "", tests: [T.unit], expect: /ACCOUNT CHANGE streak/ },
  { id: 'r2-old-change-honored', file: CORE, find: "accountChangedAt: changed !== null && changed > blockedAt ? changed : null,", rep: "accountChangedAt: changed,", tests: [T.unit], expect: /REPRISE stale account change/ },
  { id: 'r2-ancestor-bus-only', file: CORE, find: "  if (anchor) {\n    const chain = liveChain(deps, anchor);", rep: "  if (false as boolean && anchor) {\n    const chain = liveChain(deps, anchor!);", tests: [T.unit], expect: /REPRISE ancestor: the LIVE tree/ },
  { id: 'r2-ancestor-dangling-no-bus', file: CORE, find: "  if (!live) {\n    const seen = new Set<string>([runId, ...ids]);", rep: "  if (false) {\n    const seen = new Set<string>([runId, ...ids]);", tests: [T.unit], expect: /REPRISE ancestor: the LIVE tree/ },
  { id: 'r2-ancestor-switch-ignored', file: CORE, find: "    if (run?.flags.pause !== true) continue; // a run with the switch OFF carries no pause (a stale column is inert)\n", rep: "", tests: [T.unit], expect: /REPRISE ancestor: the LIVE tree/ },
  { id: 'r2-store-ready-ignored', file: CORE, find: "  if (deps.storeReady && !deps.storeReady()) return [];", rep: "  if (false) return [];", tests: [T.unit], expect: /REPRISE store not ready/ },
  { id: 'r2-manual-resuming-ignored', file: CORE, find: "if (row.pausedAt === null || (auto === null && !resuming)) return 'manual-pause';", rep: "if (row.pausedAt === null || auto === null) return 'manual-pause';", tests: [T.unit], expect: /PAUSE manual Reprise/ },
  { id: 'r2-nearest-ignored', file: CORE, find: "govRow?.resumeStartedAt !== null && govRow !== null && nearest !== null && nearest !== gov.runId", rep: "false", tests: [T.unit], expect: /PAUSE nearest run/ },
  { id: 'r2-race-overwrites', file: CORE, find: "        WHERE id = ? AND paused_at IS NULL`,\n    )\n    .run(now, PAUSE_AUTO_BY, encodePauseAuto(reason, now), carrier);", rep: "        WHERE id = ?`,\n    )\n    .run(now, PAUSE_AUTO_BY, encodePauseAuto(reason, now), carrier);", tests: [T.unit], expect: /PAUSE race/ },
  { id: 'r2-bus-pause-race-unhandled', file: BP, find: "    if (wrote.changes === 0) {", rep: "    if (false) {", tests: [T.unit], expect: /INTEGRATION human race/ },
  { id: 'r2-host-store-ready-unbound', file: HOST, find: "  storeReady: () => store.loadedFromDisk,\n", rep: "", tests: [T.wiring], expect: /WIRING usage\.ts/ },
  { id: 'r2-host-reset-streak-unbound', file: HOST, find: "  resetStreak: (runId) => void reprises.delete(runId),\n", rep: "  resetStreak: () => {},\n", tests: [T.wiring], expect: /WIRING usage\.ts/ },
  { id: 'm3-account-forced-not-protected', file: AU, find: "  if (prev && prev.dir === entry.dir && prev.forcedSeq !== undefined && prev.forcedSeq > seq) return;\n", rep: "", tests: [T.wiring, T.rig], expect: /WIRING account-usage.ts: a plain refresh ISSUED|RIG relogin_race/ },
  { id: 'm3-usage-seq-always-applies', file: 'src/main/usage.ts', find: "    if (seq > forcedSeq) {\n", rep: "    if (true) {\n", tests: [T.wiring, T.rig], expect: /WIRING usage\.ts|RIG usage_newer_wins/ },
  { id: 'm3-usage-forced-not-marked', file: 'src/main/usage.ts', find: "      if (forced) forcedSeq = seq;\n", rep: "", tests: [T.wiring, T.rig], expect: /WIRING usage\.ts|RIG usage_newer_wins/ },
  { id: 'm1-wake-guard-removed', file: CORE, find: "  if (getRun(db, carrier)?.flags.wake !== true) return 'no-wake';\n", rep: "", tests: [T.unit, T.wiring, T.rig], expect: /PAUSE wake guard|WIRING wake guard|RIG wake_off_no_pause/ },
  { id: 'm1-marker-older-row-clears', file: CORE, find: "if (!m || r.created_at < m.markedAt) continue;", rep: "if (!m) continue;", tests: [T.unit], expect: /MARKERS \(m1\): a member sent/ },
  { id: 'm1-marker-recipient-case-sensitive', file: CORE, find: "byId.get(String(r.recipient).toLowerCase())", rep: "byId.get(String(r.recipient))", tests: [T.unit], expect: /MARKERS \(m1\): a member sent/ },
  { id: 'm1-marker-cursor-not-advanced', file: CORE, find: "  deps.repriseCursor.set(hi);\n  return out;", rep: "  return out;", tests: [T.unit], expect: /MARKERS \(m1\): a member sent/ },
  { id: 'm1-marker-never-cleared', file: CORE, find: "        await deps.clearLimitMarker(m.id);\n", rep: "", tests: [T.unit, T.rig], expect: /MARKERS \(m1\)|RIG release_clears_marker/ },
  { id: 'm1-host-clear-not-called', file: HOST, find: "      await clearRepriseDeliveredMarkers(realDeps).catch((e) => log.warn('pause-auto: marker clearing failed', e));\n", rep: "", tests: [T.wiring, T.rig], expect: /WIRING markers \(m1\)|RIG release_clears_marker/ },
  { id: 'm2-reset-without-marker', file: CORE, find: "resetsAtMs: marker !== null ? ws.usageLimitResetsAt ?? null : null,", rep: "resetsAtMs: ws.usageLimitResetsAt ?? null,", tests: [T.unit], expect: /REPRISE stored reset \(m2\)/ },
  { id: 'm2-archived-trigger-is-live', file: CORE, find: "    if (!ws || ws.archived) return; // a deleted trigger cannot be waited for", rep: "    if (!ws) return; // a deleted trigger cannot be waited for", tests: [T.unit], expect: /REPRISE archived trigger \(m2\)/ },
  { id: 'm2-nudge-throttle-removed', file: HOST, find: "    const due = ids.filter((id) => now - (lastNudge.get(id ?? '') ?? 0) >= NUDGE_MS);", rep: "    const due = ids;", tests: [T.rig], expect: /RIG nudge_throttle/ },
  { id: 'host-default-login-not-forced', file: HOST, find: "    if (ids.includes(null)) jobs.push(refreshUsageNow());", rep: "", tests: [T.rig], expect: /RIG switch_default_login/ },
  { id: 'host-core-imports-store', file: CORE, find: "import type { WaveNode } from './wave-run-id.ts';\n", rep: "import type { WaveNode } from './wave-run-id.ts';\nimport { store as _s } from './store.ts';\nvoid _s;\n", tests: [T.wiring], expect: /WIRING pause-auto\.ts is Electron-free/ },
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

function rebuildCli() { // (no mutant here builds the CLI; kept for the shared runner shape)
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
