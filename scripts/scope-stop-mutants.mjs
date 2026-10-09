// In-place mutants for #327 (an explicit stop kills the member's Reliquats by identity, then stops ITS scope units): one per clause. Each mutant edits ONE anchor in the live source
// (byte-exact backup, restored in `finally`, compared with Buffer.compare AND `git diff --quiet`), runs its unit test files and — with --rig — its rig arms, and REQUIRES a red.
//
//   node scripts/scope-stop-mutants.mjs --check                 every anchor matches exactly once (no run)
//   node scripts/scope-stop-mutants.mjs --unit-only [--only a,b]  unit/wiring targets only (cheap, no token); a mutant only a rig arm can kill prints NEEDS-RIG, not SURVIVED
//   node scripts/scope-stop-mutants.mjs --rig [--only a,b]        unit + rig targets (HEAVY: real keepers in real scopes — take the heavy-rig token first)
//   node scripts/scope-stop-mutants.mjs --selftest                positive control: a no-op mutant must stay green on the unit targets
// Separate from scripts/memory-cap-mutants.mjs on purpose (that file is #320/#322's; the rig itself is shared: scripts/e2e-memory-cap.mjs).

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RIG = ['--experimental-strip-types', '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', '--import', path.join(REPO, 'scripts', '.r2-register.mjs'), path.join(REPO, 'scripts', 'e2e-memory-cap.mjs')];
const CORE = 'src/main/scope-stop.ts';
const HOST = 'src/main/scope-stop-host-core.ts'; // the injectable host logic (unit-tested behaviourally in scope-stop-host.test.ts)
const WS = 'src/main/workspaces.ts';
const SDK = 'src/main/agent-sdk.ts';
const U_CORE = ['src/main/scope-stop.test.ts'];
const U_WIRE = ['src/main/scope-stop-wiring.test.ts'];
const U_HOST = ['src/main/scope-stop-host.test.ts', 'src/main/scope-stop-wiring.test.ts'];

/** target: { unit: [test files], rig: [arms] }.  clause = the AC / design / review clause the mutant attacks. */
const MUTANTS = [
  // ── the core: scope-stop.ts ────────────────────────────────────────────────────────────────────────────────────
  { id: 'ss-no-scope-not-null', clause: 'a member with no tracked scope reports null (nothing to do)', file: CORE, find: 'if (found.length === 0) return null;', replace: 'if (found.length === 0) return { wsId, reason, scopes: [], stopped: [], kept: [], killed: 0, survivors: 0 };', target: { unit: U_CORE } },
  { id: 'ss-lookup-failure-silent', clause: 'an unreadable scope lookup is UNKNOWN (reported), not "no scope"', file: CORE, find: '    return { wsId, reason, scopes: [], stopped: [], kept: [], killed: 0, survivors: 0, unknown };', replace: '    return null;', target: { unit: U_CORE } },
  { id: 'ss-live-listing-ignored', clause: 'review m1: a scope whose LISTING holds a keeper/cli/session is live even when the pid file says nothing (untracked keeper)', file: CORE, find: "if (hasLive(listing) || scope.unit === liveUnit) return { kind: 'live' };", replace: "if (scope.unit === liveUnit) return { kind: 'live' };", target: { unit: U_CORE, rig: ['pidfile_absent_untouched'] } },
  { id: 'ss-tracked-keeper-unit-ignored', clause: "the TRACKED keeper's own unit is live even when its listing shows no keeper role", file: CORE, find: "if (hasLive(listing) || scope.unit === liveUnit) return { kind: 'live' };", replace: "if (hasLive(listing)) return { kind: 'live' };", target: { unit: U_CORE } },
  { id: 'ss-live-unplaceable-proceeds', clause: 'a live keeper that cannot be placed in a scope ⇒ fail closed, nothing touched', file: CORE, find: "if (liveUnit === 'unknown') {", replace: 'if (false) {', target: { unit: U_CORE } },
  { id: 'ss-skip-reliquat-kill', clause: 'the Reliquats are killed BY IDENTITY (#325 killReliquats) before any unit is stopped', file: CORE, find: 'rel = await deps.killReliquats(dead);', replace: 'rel = null;', target: { unit: U_CORE, rig: ['delete_stops_scope'] } },
  { id: 'ss-kill-all-scopes', clause: 'review m3: the Reliquat kill is restricted to the DEAD scopes — a live successor\'s detached job is never killed', file: CORE, find: 'rel = await deps.killReliquats(dead);', replace: 'rel = await deps.killReliquats(found);', target: { unit: U_CORE, rig: ['successor_untouched'] } },
  { id: 'ss-kill-throw-ignored', clause: 'a throwing Reliquat kill is UNKNOWN: no unit stopped', file: CORE, find: '    report.unknown = `Reliquat kill failed: ${e instanceof Error ? e.message : String(e)}`;', replace: '    void e;', target: { unit: U_CORE } },
  { id: 'ss-kill-unknown-ignored', clause: 'a Reliquat kill that could not read the scope is UNKNOWN: no unit stopped', file: CORE, find: 'if (rel.unknown) report.unknown = rel.unknown;', replace: 'if (false) report.unknown = rel.unknown;', target: { unit: U_CORE } },
  { id: 'ss-kill-error-ignored', clause: 'a Reliquat kill that errored is UNKNOWN: no unit stopped', file: CORE, find: 'else if (rel.error) report.unknown = rel.error;', replace: 'else if (false) report.unknown = rel.error;', target: { unit: U_CORE } },
  { id: 'ss-rel-null-stops', clause: 'fail closed: no Reliquat report at all is UNKNOWN, not "nothing to kill"', file: CORE, find: '} else if (!report.unknown) {', replace: '} else if (false) {', target: { unit: U_CORE } },
  { id: 'ss-survivors-counted-killed', clause: 'review m2: only Reliquats that EXITED count as killed', file: CORE, find: "report.killed = rel.killed.filter((k) => k.outcome === 'exited').length;", replace: 'report.killed = rel.killed.length;', target: { unit: U_CORE } },
  { id: 'ss-survivors-not-logged', clause: 'review m2: the Reliquats still alive after the kill rounds are logged', file: CORE, find: 'if (rel.survivors.length > 0) deps.log.warn(', replace: 'if (false) deps.log.warn(', target: { unit: U_CORE } },
  { id: 'ss-unknown-still-stops', clause: 'UNKNOWN is not NONE: on an unknown, return before any unit is stopped', file: CORE, find: ' — no unit stopped (UNKNOWN is not NONE)`);\n    return report;', replace: ' — no unit stopped (UNKNOWN is not NONE)`);', target: { unit: U_CORE } },
  { id: 'ss-foreign-unit-stopped', clause: "never another member's scope: a unit the workspace does not own is kept untouched", file: CORE, find: "if (!deps.ownsUnit(scope.unit)) return { kind: 'foreign' };", replace: '', target: { unit: U_CORE } },
  { id: 'ss-gone-not-counted', clause: 'a unit whose processes all died (systemd removed it) counts as stopped', file: CORE, find: "if (v.kind === 'gone') report.stopped.push(scope.unit); // every process died: systemd already removed the unit", replace: "if (v.kind === 'gone') void 0;", target: { unit: U_CORE } },
  { id: 'ss-unreadable-listing-stopped', clause: 'a scope whose cgroup.procs is unreadable is kept, not stopped on an unknown', file: CORE, find: "if (listing === 'unreadable') return { kind: 'unreadable' };", replace: '', target: { unit: U_CORE } },
  { id: 'ss-vanished-not-counted', clause: 'a unit systemd removed after the kill (the kill emptied it) counts as stopped, not "stopped 0/1"', file: CORE, find: 'report.stopped.push(scope.unit); // the kill emptied it', replace: 'void scope; // the kill emptied it', target: { unit: U_CORE, rig: ['delete_stops_scope'] } },
  { id: 'ss-appeared-unreported', clause: 'a unit that appeared after the first lookup is reported kept (not examined), never silently dropped', file: CORE, find: "    report.kept.push({ unit: scope.unit, reason: 'appeared after the lookup — its Reliquats were not examined, not stopped' });\n", replace: '', target: { unit: U_CORE } },
  { id: 'ss-refused-still-stops', clause: 'a Reliquat REFUSED (identity unreadable/changed) keeps its unit: a unit stop would kill it unchecked', file: CORE, find: 'if (refused > 0) {', replace: 'if (false) {', target: { unit: U_CORE } },
  { id: 'ss-live-recheck-off', clause: 'the listing is re-read right before each unit stop (a live member that came up during the kill keeps its unit)', file: CORE, find: "if (v.kind !== 'dead') {", replace: 'if (false) {', target: { unit: U_CORE } },
  { id: 'ss-unit-stop-skipped', clause: "THEN the member's unit is stopped (takes what the Reliquat kill spared)", file: CORE, find: 'await deps.stopUnit(scope.unit);', replace: 'void 0;', target: { unit: U_CORE, rig: ['unit_stop_takes_spared'] } },
  { id: 'ss-stop-failure-counted-stopped', clause: 'a failed `systemctl stop` is reported kept, never stopped', file: CORE, find: "reason: `systemctl stop failed: ${e instanceof Error ? e.message : String(e)}` });\n      continue;", replace: "reason: `systemctl stop failed: ${e instanceof Error ? e.message : String(e)}` });", target: { unit: U_CORE } },
  { id: 'ss-gone-unverified', clause: 'a stop is reported done only once the unit is verifiably gone', file: CORE, find: "if (deps.list(scope) === 'gone') {", replace: 'if (true) {', target: { unit: U_CORE } },
  { id: 'ss-second-lookup-failure-ignored', clause: 'a scope lookup that fails AFTER the kill is UNKNOWN: no unit stopped', file: CORE, find: "    report.unknown = `scope lookup failed after the kill: ${e instanceof Error ? e.message : String(e)}`;\n    deps.log.warn(`scope-stop[${wsId}] (${reason}): ${report.unknown}`);\n    return report;", replace: '    fresh = found;', target: { unit: U_CORE } },
  // ── the host logic: scope-stop-host-core.ts ────────────────────────────────────────────────────────────────────
  { id: 'host-owns-any-unit', clause: "ownership = the workspace's own unit names (FI-1 prefix + id + generation)", file: HOST, find: 'ownsUnit: (unit) => scopeGenForWorkspace(scopePrefix(e), wsId, unit) !== null,', replace: 'ownsUnit: () => true,', target: { unit: U_WIRE } },
  { id: 'host-live-unit-null', clause: "the tracked keeper's unit is read from ITS OWN cgroup", file: HOST, find: 'liveKeeperUnit: () => trackedKeeperUnit(wsId, e, io.pidOf),', replace: 'liveKeeperUnit: () => null,', target: { unit: U_WIRE } },
  { id: 'host-kill-unrestricted', clause: 'review m3: the identity-checked kill sees only the DEAD scopes it is handed', file: HOST, find: 'scopes: () => scopeDeps.scopes(wsId).filter((s) => only.some((o) => o.unit === s.unit))', replace: 'scopes: () => scopeDeps.scopes(wsId)', target: { unit: U_WIRE, rig: ['successor_untouched'] } },
  { id: 'host-throws', clause: 'a failed scope stop never blocks the delete / archive / clear / migration', file: HOST, find: '    d.log.warn(`scope-stop[${wsId}] (${reason}) failed`, e);\n    return null;', replace: '    throw e;', target: { unit: U_HOST } },
  { id: 'host-stop-no-lock', clause: "the stop runs under the member's keeper lock", file: HOST, find: 'within(d.lock(wsId, () => d.stop(wsId, reason)), deadlineMs', replace: 'within(d.stop(wsId, reason), deadlineMs', target: { unit: U_HOST } },
  { id: 'host-clear-no-lock', clause: "the /clear tail runs in ONE hold of the member's keeper lock: a keeper launch (a wake) cannot interleave", file: HOST, find: 'const run = d.lock(wsId, async () => {', replace: 'const run = ((_w: string, op: () => Promise<ScopeStopReport | null>) => op())(wsId, async () => {', target: { unit: U_HOST, rig: ['clear_wake_waits'] } },
  { id: 'host-no-deadline', clause: 'the caller never waits longer than the deadline (a wedged systemd cannot park a delete)', file: HOST, find: '          onLate();\n          resolve(undefined);', replace: '          onLate();', target: { unit: U_HOST } },
  { id: 'host-systemctl-glob', clause: 'systemctl --user stop on ONE named unit — never a glob', file: HOST, find: "['--user', 'stop', '--', unit]", replace: "['--user', 'stop', '--', unit.replace(/-[0-9]+\\.scope$/, '-*')]", target: { unit: U_WIRE } },
  { id: 'host-has-scope-always', clause: 'review m4 / D-Q1: a member WITHOUT a scope changes nothing — the gate reads the real scopes', file: HOST, find: 'return memberScopeDeps(wsId, e).scopes(wsId).length > 0;', replace: 'return true;', target: { unit: U_HOST, rig: ['no_scope_changes_nothing'] } },
  { id: 'host-has-scope-unreadable-yes', clause: 'an unreadable scope lookup reads as NO scope (the stops behave as before)', file: HOST, find: '    return false;\n  }\n}\n\n/** Upper bound', replace: '    return true;\n  }\n}\n\n/** Upper bound', target: { unit: U_HOST } },
  { id: 'host-ifany-ungated', clause: 'review m4: `extra` and the stop run only for a member WITH a scope', file: HOST, find: '  if (!d.hasScope(wsId)) return null;\n', replace: '', target: { unit: U_HOST, rig: ['no_scope_changes_nothing'] } },
  { id: 'host-extra-skipped', clause: 'the "extra" stops (a descendant\'s session + keeper at archive, the keeper at a migration) run for a member WITH a scope', file: HOST, find: 'await within(extra(), deadlineMs,', replace: 'await within(Promise.resolve(), deadlineMs,', target: { unit: U_HOST, rig: ['scoped_extra_runs_first'] } },
  { id: 'host-extra-throw-fatal', clause: 'a throwing "extra" step never blocks the scope stop', file: HOST, find: "d.log.warn(`scope-stop[${wsId}] (${reason}): pre-stop step failed`, e);", replace: 'throw e;', target: { unit: U_HOST } },
  { id: 'host-clear-announce-outside-lock', clause: 'review m3: the announce runs INSIDE the lock hold (no wake between the announce and the teardown)', file: HOST, find: 'const run = d.lock(wsId, async () => {', replace: 'await announce().catch(() => {});\n  const run = d.lock(wsId, async () => {', target: { unit: U_HOST } },
  { id: 'host-clear-announce-skipped', clause: 'review m3: the clear is announced (resume id dropped, session/clear) inside the lock, before the teardown', file: HOST, find: '      await announce();\n    } catch (e) {', replace: '      void announce;\n    } catch (e) {', target: { unit: U_HOST, rig: ['successor_untouched'] } },
  { id: 'host-clear-teardown-after-failed-announce', clause: 'a failed announce means a failed clear: no teardown on top of it', file: HOST, find: '      announceFailed = { e };\n      return null;', replace: '      announceFailed = { e };', target: { unit: U_HOST } },
  { id: 'host-clear-failure-swallowed', clause: 'a failed clear is surfaced to the caller, exactly as without a scope', file: HOST, find: 'if (announceFailed) throw', replace: 'if (false) throw', target: { unit: U_HOST } },
  { id: 'host-clear-lock-wait-under-deadline', clause: 'review MAJOR: the announce is awaited however long the lock wait — the deadline bounds only the teardown after it', file: HOST, find: 'await Promise.race([announced, run.then(() => undefined, () => undefined)]);', replace: 'await within(Promise.race([announced, run.then(() => undefined, () => undefined)]), deadlineMs, () => {});', target: { unit: U_HOST } },
  { id: 'host-clear-keeper-kill-fatal', clause: 'a failing old-keeper kill never blocks the scope stop', file: HOST, find: "d.killKeeperIfHeld(wsId, oldKeeperPid, 'clear').catch((e) => d.log.warn(`scope-stop[${wsId}] (clear): keeper kill failed`, e));", replace: "d.killKeeperIfHeld(wsId, oldKeeperPid, 'clear');", target: { unit: U_HOST } },
  { id: 'host-tracked-unit-full-path', clause: "the tracked keeper's unit is the BASENAME of its cgroup", file: HOST, find: "return cg ? path.posix.basename(cg) : 'unknown';", replace: "return cg ? cg : 'unknown';", target: { unit: U_HOST } },
  { id: 'host-tracked-unit-vanished-unknown', clause: 'a keeper whose /proc entry vanished is "no live keeper", not an unplaceable one', file: HOST, find: "return code === 'ENOENT' || code === 'ESRCH' ? null : 'unknown';", replace: "return 'unknown';", target: { unit: U_HOST } },
  // ── keeper-client: the conditional kill ────────────────────────────────────────────────────────────────────────
  { id: 'keeper-kill-if-any', clause: 'review m3: only THE keeper read before the stop is killed — a successor a wake launched has another pid', file: 'src/main/keeper-client.ts', find: 'if (expectedPid === null || readTrackedKeeperPid(wsId) !== expectedPid) return;', replace: 'if (expectedPid === null) return;', target: { unit: U_WIRE, rig: ['successor_untouched'] } },
  // ── FI-1 (shared): the member's own scopes only ────────────────────────────────────────────────────────────────
  { id: 'fi1-scan-any-workspace', clause: "never another member's scope (also an id that EXTENDS this one's)", file: 'src/shared/memory-scope.ts', find: 'return p && p.wsId === wsId ? p.gen : null;', replace: 'return p ? p.gen : null;', target: { unit: ['src/shared/memory-scope.test.ts'], rig: ['other_member_untouched'] } },
  // ── call sites: explicit stops stop the scope — of a member that HAS one ──────────────────────────────────────
  { id: 'wire-delete-missing', clause: 'delete / prune stops the member\'s scope', file: WS, find: "await stopMemberScopeIfAny(id, 'workspace-deleted');", replace: '', target: { unit: U_WIRE } },
  { id: 'wire-delete-before-keeper-kill', clause: 'delete: the scope stop comes AFTER the keeper tree is killed', file: WS, find: "  await killKeeperTree(id, tree, 'workspace-deleted').catch((e) => log.warn(`delete: descendant sweep failed for ${id}`, e));\n  await stopMemberScopeIfAny(id, 'workspace-deleted');", replace: "  await stopMemberScopeIfAny(id, 'workspace-deleted');\n  await killKeeperTree(id, tree, 'workspace-deleted').catch((e) => log.warn(`delete: descendant sweep failed for ${id}`, e));", target: { unit: U_WIRE } },
  { id: 'wire-delete-not-awaited', clause: 'delete: the scope stop is AWAITED (the worktree is removed right after)', file: WS, find: "await stopMemberScopeIfAny(id, 'workspace-deleted');", replace: "void stopMemberScopeIfAny(id, 'workspace-deleted');", target: { unit: U_WIRE } },
  { id: 'wire-archive-missing', clause: "archive stops a scoped member's scope", file: WS, find: "    await stopMemberScopeIfAny(ws.id, 'workspace-archived', async () => {\n      await sdkStopIfLive(ws.id).catch((e) => log.warn(`archive: session stop failed for ${ws.id}`, e));\n      await killKeeperIf(ws.id, keeperBefore, 'workspace-archived').catch((e) => log.warn(`archive: keeper kill failed for ${ws.id}`, e));\n    });\n", replace: '', target: { unit: U_WIRE } },
  { id: 'wire-archive-extra-unconditional', clause: 'review m4 / D-Q1: the session + keeper stop of every descendant at archive happens ONLY for a member with a scope (master: the root only)', file: WS, find: "    await stopMemberScopeIfAny(ws.id, 'workspace-archived', async () => {\n      await sdkStopIfLive(ws.id).catch((e) => log.warn(`archive: session stop failed for ${ws.id}`, e));\n      await killKeeperIf(ws.id, keeperBefore, 'workspace-archived').catch((e) => log.warn(`archive: keeper kill failed for ${ws.id}`, e));\n    });\n", replace: "    await sdkStopIfLive(ws.id).catch((e) => log.warn(`archive: session stop failed for ${ws.id}`, e));\n    await killKeeperIf(ws.id, keeperBefore, 'workspace-archived');\n    await stopMemberScopeIfAny(ws.id, 'workspace-archived');\n", target: { unit: U_WIRE } },
  { id: 'wire-archive-keeper-any', clause: 'archive: only THE keeper read before is killed (a successor is not)', file: WS, find: "await killKeeperIf(ws.id, keeperBefore, 'workspace-archived').catch((e) => log.warn(`archive: keeper kill failed for ${ws.id}`, e));\n    });", replace: "await killKeeper(ws.id, 'workspace-archived');\n    });", target: { unit: U_WIRE } },
  { id: 'wire-migrate-missing', clause: "account migration stops a scoped member's old session scope", file: WS, find: "      await stopMemberScopeIfAny(id, 'account-migration', () => killKeeperIf(id, keeperBefore, 'account-migration'));\n", replace: '', target: { unit: U_WIRE } },
  { id: 'wire-migrate-ungated', clause: 'account migration: only a member that HAD a session', file: WS, find: '    if (hadSdkSession) {\n      const keeperBefore', replace: '    if (true) {\n      const keeperBefore', target: { unit: U_WIRE } },
  { id: 'wire-migrate-keeper-unconditional', clause: 'review m4 / D-Q1: the migration kills the old keeper ONLY for a member with a scope (master did not)', file: WS, find: "      await stopMemberScopeIfAny(id, 'account-migration', () => killKeeperIf(id, keeperBefore, 'account-migration'));\n", replace: "      await killKeeperIf(id, keeperBefore, 'account-migration');\n      await stopMemberScopeIfAny(id, 'account-migration');\n", target: { unit: U_WIRE } },
  { id: 'wire-clear-no-scope-gate', clause: 'review m4 / D-Q1: a member WITHOUT a scope is cleared exactly as before (no lock, no keeper kill)', file: SDK, find: '  if (!scoped) return announce();\n', replace: '', target: { unit: U_WIRE } },
  { id: 'wire-clear-missing', clause: "clear stops a scoped member's old conversation scope", file: SDK, find: '  await clearScopedMember(wsId, keeperBefore, announce);', replace: '  await announce();', target: { unit: U_WIRE } },
  { id: 'wire-clear-keeper-forgotten', clause: 'clear: the keeper pid is read BEFORE the stop (the one to kill; a successor is not it)', file: SDK, find: 'const keeperBefore = scoped ? readTrackedKeeperPid(wsId) : null;', replace: 'const keeperBefore = null;', target: { unit: U_WIRE } },
  { id: 'wire-clear-announce-order', clause: "clear announce = persist the cleared id, THEN session/clear (master's order)", file: SDK, find: "    await persistWorkspacePatch(wsId, { sdkSessionId: '' });\n    emit(wsId, {\n      type: 'session/clear',\n      seq: cursorFor(wsId).seq++,\n      at: Date.now(),\n    });", replace: "    emit(wsId, {\n      type: 'session/clear',\n      seq: cursorFor(wsId).seq++,\n      at: Date.now(),\n    });\n    await persistWorkspacePatch(wsId, { sdkSessionId: '' });", target: { unit: U_WIRE } },
  // ── call sites: a restart / resume / refresh / Veille keeps its Reliquats ──────────────────────────────────────
  { id: 'norestart-restart-stops-scope', clause: 'a RESTART (resume by id) never stops a scope', file: SDK, find: '  const live = sessions.get(wsId);\n  // #179 — the mid-turn guard', replace: "  await stopMemberScopeIfAny(wsId, 'restart');\n  const live = sessions.get(wsId);\n  // #179 — the mid-turn guard", target: { unit: U_WIRE } },
  { id: 'norestart-mcp-refresh-stops-scope', clause: 'an MCP refresh (stop + restart) never stops a scope', file: SDK, find: "  await sdkStop(wsId);\n  await killKeeper(wsId).catch(() => {\n    /* already gone — the common case after a graceful stop */\n  });\n  const session = await ensureSession(wsId);", replace: "  await sdkStop(wsId);\n  await killKeeper(wsId).catch(() => {\n    /* already gone — the common case after a graceful stop */\n  });\n  await stopMemberScopeIfAny(wsId, 'mcp-refresh');\n  const session = await ensureSession(wsId);", target: { unit: U_WIRE } },
  { id: 'norestart-sdkstop-stops-scope', clause: 'sdkStop (the Veille, branch switch, rewind all funnel through it) never stops a scope', file: SDK, find: "  session.stopping = true;\n  // Session-scoped (a successor is a new object): this stop is the idle-hibernate sweep's, not a crash.", replace: "  void stopMemberScopeIfAny(wsId, 'sdk-stop');\n  session.stopping = true;\n  // Session-scoped (a successor is a new object): this stop is the idle-hibernate sweep's, not a crash.", target: { unit: U_WIRE } },
  { id: 'norestart-veille-stops-scope', clause: 'the Veille (#326 hibernation) never stops a scope', file: 'src/main/hibernation.ts', find: 'if (isBeingDeleted(ws.id)) continue; // delete owns the teardown (#205)', replace: "if (isBeingDeleted(ws.id)) continue; // delete owns the teardown (#205)\n    void stopMemberScopeIfAny(ws.id, 'hibernate');", target: { unit: U_WIRE } },
  { id: 'norestart-extra-caller', clause: 'no OTHER module stops a scope (the only-users guard sees a call in any file, also the one after agent-sdk.ts alphabetically)', file: 'src/main/api-handlers.ts', find: 'await sdkClear(wsId);', replace: "await sdkClear(wsId);\n    await stopMemberScopeIfAny(wsId, 'x');", target: { unit: U_WIRE } },
];

const argv = process.argv.slice(2);
const only = (argv.find((a) => a.startsWith('--only=')) ? argv.find((a) => a.startsWith('--only=')).slice(7) : argv.includes('--only') ? argv[argv.indexOf('--only') + 1] : '').split(',').filter(Boolean);
const mode = argv.includes('--check') ? 'check' : argv.includes('--selftest') ? 'selftest' : argv.includes('--rig') ? 'rig' : argv.includes('--unit-only') ? 'unit' : 'help';
const list = only.length ? MUTANTS.filter((m) => only.includes(m.id)) : MUTANTS;
const count = (s, needle) => s.split(needle).length - 1;
const sh = (cmd, args, env = {}) => spawnSync(cmd, args, { cwd: REPO, encoding: 'utf8', env: { ...process.env, ...env }, timeout: 20 * 60_000 });
const armPass = (out, arm) => new RegExp(`^PASS ${arm}\\b`, 'm').test(out);
const armFail = (out, arm) => new RegExp(`^FAIL ${arm}\\b`, 'm').test(out);

function check() {
  let bad = 0;
  const ids = new Set();
  for (const m of MUTANTS) {
    if (ids.has(m.id)) { console.log(`FAIL duplicate id ${m.id}`); bad++; }
    ids.add(m.id);
    const s = fs.readFileSync(path.join(REPO, m.file), 'utf8');
    const n = count(s, m.find);
    console.log(`${n === 1 ? 'ok  ' : 'FAIL'} anchor ${m.id} in ${m.file}: ${n} match${n === 1 ? '' : 'es (must be exactly 1)'}`);
    if (n !== 1) bad++;
    if (m.find === m.replace) { console.log(`FAIL ${m.id}: replace === find`); bad++; }
  }
  console.log(`${MUTANTS.length} mutants, ${bad} anchor problem(s)`);
  return bad;
}
if (mode === 'help') { console.log('usage: --check | --unit-only [--only a,b] | --rig [--only a,b] | --selftest'); process.exit(2); }
if (mode === 'check') process.exit(check() ? 1 : 0);
if (check()) { console.log('refusing to run with broken anchors'); process.exit(1); }

const unitRun = (files) => sh(process.execPath, ['--test', '--test-timeout=20000', '--experimental-strip-types', ...files]);
const unitFiles = [...new Set(list.flatMap((m) => m.target.unit ?? []))];
let baseBad = 0;
for (const u of unitFiles) { const r = unitRun([u]); const ok = r.status === 0 && /# skipped 0/.test(r.stdout); console.log(`baseline ${ok ? 'GREEN' : 'RED  '} unit:${u}`); if (!ok) baseBad++; }
const arms = mode === 'rig' ? [...new Set(list.flatMap((m) => m.target.rig ?? []))] : [];
for (const arm of arms) { const r = sh(process.execPath, [...RIG, arm, '--contained']); const ok = armPass(r.stdout + r.stderr, arm); console.log(`baseline ${ok ? 'GREEN' : 'RED  '} rig:${arm}`); if (!ok) baseBad++; }
if (baseBad) { console.log(`BASELINE NOT GREEN (${baseBad}) — a mutant cannot be judged against a red baseline`); process.exit(1); }

if (mode === 'selftest') {
  const noop = { file: CORE, find: '/** Stop the member\'s whole scope(s).', replace: '/**  Stop the member\'s whole scope(s).' };
  const abs = path.join(REPO, noop.file);
  const orig = fs.readFileSync(abs);
  try {
    if (count(orig.toString('utf8'), noop.find) !== 1) { console.log('SELFTEST VOID: no-op anchor not found'); process.exit(1); }
    fs.writeFileSync(abs, orig.toString('utf8').replace(noop.find, () => noop.replace));
    const r = unitRun([...U_CORE, ...U_WIRE]);
    console.log(`selftest no-op mutant: unit ${r.status === 0 ? 'green' : 'RED'}`);
    if (r.status !== 0) { console.log('SELFTEST FAILED: a no-op mutation went red — the instrument cries wolf'); process.exitCode = 1; } else console.log('SELFTEST OK: a no-op mutant survives the unit targets');
  } finally { fs.writeFileSync(abs, orig); }
  process.exit(process.exitCode ?? 0);
}

let survived = 0, needsRig = 0, restoreBad = 0;
for (const m of list) {
  const abs = path.join(REPO, m.file);
  const orig = fs.readFileSync(abs); // byte-exact backup
  const src = orig.toString('utf8');
  const cleanBefore = sh('git', ['diff', '--quiet', '--', m.file]).status === 0;
  const reds = [];
  const notRed = [];
  let voided = false;
  try {
    fs.writeFileSync(abs, src.replace(m.find, () => m.replace));
    if (m.target.unit?.length) { const r = unitRun(m.target.unit); (r.status !== 0 ? reds : notRed).push(`unit:${m.target.unit.map((u) => path.basename(u)).join('+')}`); }
    if (mode === 'rig') for (const arm of m.target.rig ?? []) {
      const r = sh(process.execPath, [...RIG, arm, '--contained'], { MC_MUTANT_TAG: m.id });
      const out = r.stdout + r.stderr;
      if (armFail(out, arm)) reds.push(`rig:${arm}`); else { notRed.push(`rig:${arm}`); if (!armPass(out, arm)) voided = true; }
    }
  } finally {
    fs.writeFileSync(abs, orig);
    const same = Buffer.compare(fs.readFileSync(abs), orig) === 0 && (!cleanBefore || sh('git', ['diff', '--quiet', '--', m.file]).status === 0);
    if (!same) { restoreBad++; console.error(`RESTORE MISMATCH for ${m.file}`); }
  }
  const killed = reds.length > 0;
  const rigOnly = !killed && mode === 'unit' && (m.target.rig?.length ?? 0) > 0;
  if (rigOnly) needsRig++; else if (!killed || voided) survived++;
  console.log(`${killed ? 'KILLED  ' : rigOnly ? 'NEEDS-RIG' : 'SURVIVED'} ${m.id}  [${m.clause}]  by: ${reds.join(',') || '—'}${notRed.length ? `  (not red: ${notRed.join(',')})` : ''}${voided ? '  ← VOID run (no verdict from a rig arm)' : ''}`);
}
const dirty = sh('git', ['status', '--porcelain', '--', ...new Set(list.map((m) => m.file))]).stdout.trim();
console.log(`SCOPE-STOP MUTANTS (${mode}): ${list.length - survived - needsRig}/${list.length} killed, ${survived} survived/void, ${needsRig} need the rig, restore mismatches ${restoreBad}`);
console.log(dirty ? `NOTE: mutated files show in git status (expected only if they carry uncommitted work):\n${dirty}` : 'tree clean after the sweep');
process.exit(survived || restoreBad ? 1 : 0);
