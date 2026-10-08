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
const HOST = 'src/main/scope-stop-host.ts';
const WS = 'src/main/workspaces.ts';
const SDK = 'src/main/agent-sdk.ts';
const U_CORE = ['src/main/scope-stop.test.ts'];
const U_WIRE = ['src/main/scope-stop-wiring.test.ts'];

/** target: { unit: [test files], rig: [arms] }.  clause = the AC / design clause the mutant attacks. */
const MUTANTS = [
  // ── the core: scope-stop.ts ────────────────────────────────────────────────────────────────────────────────────
  { id: 'ss-no-scope-not-null', clause: 'a member with no tracked scope reports null (nothing to do)', file: CORE, find: 'if (found.length === 0) return null;', replace: 'if (found.length === 0) return { wsId, reason, scopes: [], stopped: [], kept: [], killed: 0 };', target: { unit: U_CORE } },
  { id: 'ss-lookup-failure-silent', clause: 'an unreadable scope lookup is UNKNOWN (reported), not "no scope"', file: CORE, find: '    return { wsId, reason, scopes: [], stopped: [], kept: [], killed: 0, unknown };', replace: '    return null;', target: { unit: U_CORE } },
  { id: 'ss-keeper-guard-off', clause: 'a RUNNING member (live keeper) is never touched: its detached jobs are not Reliquats', file: CORE, find: 'if (deps.keeperAlive()) {', replace: 'if (false) {', target: { unit: U_CORE, rig: ['live_keeper_untouched'] } },
  { id: 'ss-skip-reliquat-kill', clause: 'the Reliquats are killed BY IDENTITY (#325 killReliquats) before any unit is stopped', file: CORE, find: 'rel = await deps.killReliquats();', replace: 'rel = null;', target: { unit: U_CORE, rig: ['delete_stops_scope'] } },
  { id: 'ss-kill-throw-ignored', clause: 'a throwing Reliquat kill is UNKNOWN: no unit stopped', file: CORE, find: '    report.unknown = `Reliquat kill failed: ${e instanceof Error ? e.message : String(e)}`;', replace: '    void e;', target: { unit: U_CORE } },
  { id: 'ss-kill-unknown-ignored', clause: 'a Reliquat kill that could not read the scope is UNKNOWN: no unit stopped', file: CORE, find: 'if (rel.unknown) report.unknown = rel.unknown;', replace: 'if (false) report.unknown = rel.unknown;', target: { unit: U_CORE } },
  { id: 'ss-kill-error-ignored', clause: 'a Reliquat kill that errored is UNKNOWN: no unit stopped', file: CORE, find: 'else if (rel.error) report.unknown = rel.error;', replace: 'else if (false) report.unknown = rel.error;', target: { unit: U_CORE } },
  { id: 'ss-unknown-still-stops', clause: 'UNKNOWN is not NONE: on an unknown, return before any unit is stopped', file: CORE, find: ' — no unit stopped (UNKNOWN is not NONE)`);\n    return report;', replace: ' — no unit stopped (UNKNOWN is not NONE)`);', target: { unit: U_CORE } },
  { id: 'ss-stale-unit-list', clause: 'the units to stop come from a FRESH lookup after the kill (a generation may have come or gone)', file: CORE, find: 'fresh = deps.scopes();', replace: 'fresh = found;', target: { unit: U_CORE } },
  { id: 'ss-foreign-unit-stopped', clause: 'never another member\'s scope: a unit the workspace does not own is kept untouched', file: CORE, find: 'if (!deps.ownsUnit(scope.unit)) {', replace: 'if (false) {', target: { unit: U_CORE } },
  { id: 'ss-gone-not-counted', clause: 'a unit whose processes all died (systemd removed it) counts as stopped', file: CORE, find: 'report.stopped.push(scope.unit); // every process died with the kill: systemd already removed the unit', replace: '// dropped', target: { unit: U_CORE } },
  { id: 'ss-unreadable-listing-stopped', clause: 'a scope whose cgroup.procs is unreadable is kept, not stopped on an unknown', file: CORE, find: "if (listing === 'unreadable') {", replace: 'if (false) {', target: { unit: U_CORE } },
  { id: 'ss-refused-still-stops', clause: 'a Reliquat REFUSED (identity unreadable/changed) keeps its unit: a unit stop would kill it unchecked', file: CORE, find: 'if (refused > 0) {', replace: 'if (false) {', target: { unit: U_CORE } },
  { id: 'ss-live-session-unit-stopped', clause: 'a unit that holds a live session of the member (a newer generation) is not stopped', file: CORE, find: "if (listing.some((m) => m.role === 'keeper' || m.role === 'cli' || m.role === 'session')) {", replace: 'if (false) {', target: { unit: U_CORE } },
  { id: 'ss-unit-stop-skipped', clause: 'THEN the member\'s unit is stopped (takes what the Reliquat kill spared)', file: CORE, find: 'await deps.stopUnit(scope.unit);', replace: 'void 0;', target: { unit: U_CORE, rig: ['unit_stop_takes_spared'] } },
  { id: 'ss-stop-failure-counted-stopped', clause: 'a failed `systemctl stop` is reported kept, never stopped', file: CORE, find: "reason: `systemctl stop failed: ${e instanceof Error ? e.message : String(e)}` });\n      continue;", replace: "reason: `systemctl stop failed: ${e instanceof Error ? e.message : String(e)}` });", target: { unit: U_CORE } },
  { id: 'ss-gone-unverified', clause: 'a stop is reported done only once the unit is verifiably gone', file: CORE, find: "if (deps.list(scope) === 'gone') {", replace: 'if (true) {', target: { unit: U_CORE } },
  // ── the host adapter: scope-stop-host.ts ───────────────────────────────────────────────────────────────────────
  { id: 'host-owns-any-unit', clause: 'ownership = the workspace\'s own unit names (FI-1 prefix + id + generation)', file: HOST, find: 'ownsUnit: (unit) => scopeGenForWorkspace(scopePrefix(e), wsId, unit) !== null,', replace: 'ownsUnit: () => true,', target: { unit: U_WIRE } },
  { id: 'host-keeper-alive-false', clause: 'the keeper-alive precondition reads the TRACKED keeper', file: HOST, find: 'keeperAlive: () => readTrackedKeeperPid(wsId) !== null,', replace: 'keeperAlive: () => false,', target: { unit: U_WIRE, rig: ['live_keeper_untouched'] } },
  { id: 'host-throws', clause: 'a failed scope stop never blocks the delete / archive / clear / migration', file: HOST, find: '    log.warn(`scope-stop[${wsId}] (${reason}) failed`, e);\n    return null;', replace: '    throw e;', target: { unit: U_WIRE } },
  { id: 'host-systemctl-glob', clause: 'systemctl --user stop on ONE named unit — never a glob', file: HOST, find: "['--user', 'stop', '--', unit]", replace: "['--user', 'stop', '--', unit.replace(/-[0-9]+\\.scope$/, '-*')]", target: { unit: U_WIRE } },
  // ── FI-1 (shared): the member's own scopes only ────────────────────────────────────────────────────────────────
  { id: 'fi1-scan-any-workspace', clause: 'never another member\'s scope (also an id that EXTENDS this one\'s)', file: 'src/shared/memory-scope.ts', find: 'return p && p.wsId === wsId ? p.gen : null;', replace: 'return p ? p.gen : null;', target: { unit: ['src/shared/memory-scope.test.ts'], rig: ['other_member_untouched'] } },
  // ── call sites: explicit stops stop the scope ──────────────────────────────────────────────────────────────────
  { id: 'wire-delete-missing', clause: 'delete / prune stops the member\'s scope', file: WS, find: "await stopMemberScopeFor(id, 'workspace-deleted');", replace: '', target: { unit: U_WIRE } },
  { id: 'wire-delete-before-keeper-kill', clause: 'delete: the scope stop comes AFTER the keeper tree is killed', file: WS, find: "  await killKeeperTree(id, tree, 'workspace-deleted').catch((e) => log.warn(`delete: descendant sweep failed for ${id}`, e));\n  await stopMemberScopeFor(id, 'workspace-deleted');", replace: "  await stopMemberScopeFor(id, 'workspace-deleted');\n  await killKeeperTree(id, tree, 'workspace-deleted').catch((e) => log.warn(`delete: descendant sweep failed for ${id}`, e));", target: { unit: U_WIRE } },
  { id: 'wire-archive-missing', clause: 'archive stops the member\'s scope', file: WS, find: "await stopMemberScopeFor(ws.id, 'workspace-archived');", replace: '', target: { unit: U_WIRE } },
  { id: 'wire-archive-keeper-not-killed', clause: 'archive: the keeper is killed (awaited) before the scope stop', file: WS, find: "    await killKeeper(ws.id, 'workspace-archived').catch((e) => log.warn(`archive: killKeeper failed for ${ws.id}`, e));\n", replace: '', target: { unit: U_WIRE } },
  { id: 'wire-archive-session-not-stopped', clause: 'archive: the session is stopped (awaited) first', file: WS, find: "    await sdkStopIfLive(ws.id).catch((e) => log.warn(`archive: session stop failed for ${ws.id}`, e));\n", replace: '', target: { unit: U_WIRE } },
  { id: 'wire-migrate-missing', clause: 'account migration stops the old session\'s scope', file: WS, find: "await stopMemberScopeFor(id, 'account-migration');", replace: '', target: { unit: U_WIRE } },
  { id: 'wire-migrate-ungated', clause: 'account migration: only a member that HAD a session', file: WS, find: '    if (hadSdkSession) {\n      await sdkStopIfLive(id);', replace: '    if (true) {\n      await sdkStopIfLive(id);', target: { unit: U_WIRE } },
  { id: 'wire-clear-missing', clause: '/clear stops the old conversation\'s scope', file: SDK, find: "await stopMemberScopeFor(wsId, 'clear');", replace: '', target: { unit: U_WIRE } },
  { id: 'wire-clear-keeper-not-killed', clause: 'clear: the keeper is killed before the scope stop', file: SDK, find: "    await killKeeper(wsId, 'clear').catch(() => {});\n", replace: '', target: { unit: U_WIRE } },
  // ── call sites: a restart / resume / refresh / Veille keeps its Reliquats ──────────────────────────────────────
  { id: 'norestart-restart-stops-scope', clause: 'a RESTART (resume by id) never stops a scope', file: SDK, find: '  const live = sessions.get(wsId);\n  // #179 — the mid-turn guard', replace: "  await stopMemberScopeFor(wsId, 'restart');\n  const live = sessions.get(wsId);\n  // #179 — the mid-turn guard", target: { unit: U_WIRE } },
  { id: 'norestart-mcp-refresh-stops-scope', clause: 'an MCP refresh (stop + restart) never stops a scope', file: SDK, find: "  await sdkStop(wsId);\n  await killKeeper(wsId).catch(() => {\n    /* already gone — the common case after a graceful stop */\n  });\n  const session = await ensureSession(wsId);", replace: "  await sdkStop(wsId);\n  await killKeeper(wsId).catch(() => {\n    /* already gone — the common case after a graceful stop */\n  });\n  await stopMemberScopeFor(wsId, 'mcp-refresh');\n  const session = await ensureSession(wsId);", target: { unit: U_WIRE } },
  { id: 'norestart-sdkstop-stops-scope', clause: 'sdkStop (the Veille, branch switch, rewind all funnel through it) never stops a scope', file: SDK, find: "  session.stopping = true;\n  // Session-scoped (a successor is a new object): this stop is the idle-hibernate sweep's, not a crash.", replace: "  void stopMemberScopeFor(wsId, 'sdk-stop');\n  session.stopping = true;\n  // Session-scoped (a successor is a new object): this stop is the idle-hibernate sweep's, not a crash.", target: { unit: U_WIRE } },
  { id: 'norestart-veille-stops-scope', clause: 'the Veille (#326 hibernation) never stops a scope', file: 'src/main/hibernation.ts', find: 'if (isBeingDeleted(ws.id)) continue; // delete owns the teardown (#205)', replace: "if (isBeingDeleted(ws.id)) continue; // delete owns the teardown (#205)\n    void stopMemberScopeFor(ws.id, 'hibernate');", target: { unit: U_WIRE } },
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

const unitRun = (files) => sh(process.execPath, ['--test', '--experimental-strip-types', ...files]);
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
