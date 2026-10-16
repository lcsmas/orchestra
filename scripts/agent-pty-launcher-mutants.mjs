#!/usr/bin/env node
// #233 self-gate — IN-PLACE mutation sweep of "delete the agent-PTY launcher and its machinery". Each mutant re-adds ONE removed piece (or breaks one KEPT piece) in the real source
// and must turn its NAMED unit test or rig clause red. Byte-exact backup + `cmp` restore after every mutant; run it on a COMMITTED tree (`git diff` of the mutated files must be empty at the end).
// Unit part (cheap): `node --test` of the named files. Rig part (HEAVY by the wave rule — boots the built app: needs the heavy-rig token): rebuild `build:bundles`, then
// `scripts/e2e-agent-view-removal.sh <repo> --arm <arm>` — the mutant is killed when the rig reports a FAIL line whose clause contains `clause`. `tests: []` = rig-only mutant.
// Run: node scripts/agent-pty-launcher-mutants.mjs [--only U01,R02] [--no-rig] [--check-anchors]

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const only = args.includes('--only') ? new Set(args[args.indexOf('--only') + 1].split(',')) : null;
const noRig = args.includes('--no-rig');
const WS = 'src/main/workspaces.ts', AH = 'src/main/api-handlers.ts', AS = 'src/main/agent-sdk.ts', PT = 'src/main/pty.ts', PH = 'src/main/pause-trap-host.ts', ST = 'src/main/store.ts';
const PL = 'src/preload/index.ts', AC = 'src/main/activity.ts', ES = 'src/main/events-spool.ts', RL = 'src/shared/refreeze-liveness.ts', RG = 'scripts/e2e-agent-view-removal.mjs', RS = 'scripts/e2e-agent-view-removal.sh';
const T = {
  wiring: 'src/main/sdk-only-wake-wiring.test.ts', refreeze: 'src/shared/refreeze-liveness.test.ts', trap: 'src/main/pause-trap-wiring.test.ts', effort: 'src/main/effort-defaults-wiring.test.ts',
  model: 'src/main/model-defaults-wiring.test.ts', spool: 'src/main/events-spool.test.ts', usage: 'src/main/usage-limit-wiring.test.ts',
};
const LAUNCH = 'launcher_removed', READY = 'ready_hook_retired', KEPT = 'kept_by_content', SOCK = 'socket_guard_selftest', SEAMS = 'sdk_seams';   // SEAMS: the #233 follow-up arm

/** One mutant = one or more exact-once edits. `tests` = unit files that must go red ([] = rig-only); `rig` = {arm, clause} killed by a FAIL line containing `clause`. */
const MUTANTS = [
  { id: 'U01_refreeze_probe_always_false', clause: 'a live SDK child makes the refreeze gate see a live child', edits: [[RL, "return childIds.some((id) => isSdkLive(id));", "return childIds.some((id) => false && isSdkLive(id));"]], tests: [T.refreeze] },
  { id: 'U02_refreeze_call_site_drops_the_probe', clause: 'dispatchRunRefreezeRequest wires sdkSessionLive for the mission children', edits: [[WS, "const hasLiveChild = anyChildLive(children.map((w) => w.id), sdkSessionLive);", "const hasLiveChild = anyChildLive(children.map((w) => w.id), () => false);"]], tests: [T.wiring] },
  { id: 'U03_ptyStart_handler_back', clause: 'no ptyStart handler in the API table', edits: [[AH, "  ptyWrite: async (id, data) => writePty(id, data),", "  ptyStart: async (id, cols, rows) => { void id; void cols; void rows; },\n  ptyWrite: async (id, data) => writePty(id, data),"]], tests: [T.wiring] },
  { id: 'U04_ptyWrite_heavy_gate_back', clause: 'ptyWrite is a plain writePty', edits: [[AH, "  ptyWrite: async (id, data) => writePty(id, data),", "  ptyWrite: async (id, data) => { if (store.getWorkspace(id)?.heavyResumePending) return; return writePty(id, data); },"]], tests: [T.wiring] },
  { id: 'U05_pty_workspace_env_back', clause: 'startPty has no per-workspace agent env option', edits: [[PT, "  extraEnv?: Record<string, string>;\n  /** Where the process runs.", "  extraEnv?: Record<string, string>;\n  workspaceId?: string;\n  /** Where the process runs."]], tests: [T.wiring] },
  { id: 'U06_pty_getPtyPid_back', clause: 'no getPtyPid getter', edits: [[PT, "export function isRunning(id: string) {", "export function getPtyPid(id: string): number | undefined { return sessions.get(id)?.transport.pid; }\nexport function isRunning(id: string) {"]], tests: [T.wiring] },
  { id: 'U07_exit_floor_guarded_by_a_pty_probe', clause: 'agent-sdk.ts reads no PTY and its exit floor reconciles unconditionally', edits: [[AS, "import { getEventsDir } from './events-spool';\n", "import { getEventsDir } from './events-spool';\nimport { isRunning as isPtyRunning } from './pty';\n"], [AS, "      reconcileExited(session.wsId);", "      if (!isPtyRunning(session.wsId)) reconcileExited(session.wsId);"]], tests: [T.wiring] },
  { id: 'U08_exit_floor_removed', clause: 'the SDK exit floor still reconciles a dead session', edits: [[AS, "      reconcileExited(session.wsId);", "      void 0;"]], tests: [T.wiring], rig: { arm: KEPT, clause: 'exit/a-dead-sessions-running-dot-is-reconciled' } },
  { id: 'U09_launcher_function_back', clause: 'workspaces.ts has no launcher', edits: [[WS, "export interface SpawnResult {", "export async function startAgentPty(): Promise<void> {}\n\nexport interface SpawnResult {"]], tests: [T.wiring] },
  { id: 'U10_launcher_argv_back', clause: 'no `claude` argv is built outside the SDK start (effort)', edits: [[WS, "export interface SpawnResult {", "const claudeArgs: string[] = [];\n\nexport interface SpawnResult {"]], tests: [T.effort, T.model] },
  { id: 'U11_ready_eviction_removed', clause: 'the retired readiness hook is evicted from an installed worktree', edits: [[WS, "    sessionStartList = removeHookCommand(sessionStartList, isRetiredReadyCmd);\n", ""]], tests: [T.wiring], rig: { arm: READY, clause: 'install/ready-hook' } },
  { id: 'U12_pause_trap_pty_probe_back', clause: 'activityOf asks keeperActivityUnknown with session + probe + tracked keeper only', edits: [[PH, "probeAnswered: !!probe,\n        trackedKeeperPid,", "probeAnswered: !!probe,\n        ptyLive: false,\n        trackedKeeperPid,"]], tests: [T.trap] },
  { id: 'R01_preload_ptyStart_wrapper_back', clause: 'the preload bridge has no ptyStart', edits: [[PL, "  ptyWrite: (id, data) => ipcRenderer.invoke('pty:write', id, data),", "  ptyStart: (id, cols, rows) => ipcRenderer.invoke('pty:start', id, cols, rows),\n  ptyWrite: (id, data) => ipcRenderer.invoke('pty:write', id, data),"]], tests: [], rig: { arm: LAUNCH, clause: 'preload/ptyStart-wrapper' } },
  { id: 'R02_preload_stopAgent_wrapper_back', clause: 'the preload bridge has no stopAgent', edits: [[PL, "  restartAgent: (id) => ipcRenderer.invoke('agent:restart', id),", "  restartAgent: (id) => ipcRenderer.invoke('agent:restart', id),\n  stopAgent: (id) => ipcRenderer.invoke('agent:stop', id),"]], tests: [], rig: { arm: LAUNCH, clause: 'preload/stopAgent-wrapper' } },
  { id: 'R03_store_drops_the_removed_field', clause: 'a record carrying the removed flag loads untouched', edits: [[ST, "    let mutated = false;\n    for (const ws of this.data.workspaces) {", "    let mutated = false;\n    for (const ws of this.data.workspaces) {\n      delete (ws as { heavyResumePending?: boolean }).heavyResumePending;"]], tests: [], rig: { arm: LAUNCH, clause: 'store/record-with-the-removed-flag-loads' } },
  { id: 'R04_ready_eviction_matches_nothing', clause: 'the eviction predicate matches the retired command', edits: [[WS, "cmd.includes('ORCHESTRA_READY_FILE')", "cmd.includes('ORCHESTRA_READY_FILEX')"]], tests: [], rig: { arm: READY, clause: 'install/ready-hook' } },
  { id: 'R05_ready_eviction_evicts_everything', clause: 'the eviction leaves an unrelated user hook alone', edits: [[WS, "const isRetiredReadyCmd = (cmd: string): boolean => cmd.includes('ORCHESTRA_READY_FILE');", "const isRetiredReadyCmd = (cmd: string): boolean => cmd.length > 0;"]], tests: [], rig: { arm: READY, clause: 'install/unrelated-user-hook-kept' } },
  { id: 'R06_spool_ownership_dropped', clause: 'the SDK session env owns the events spool', edits: [[AS, "    env.ORCHESTRA_WS_ID = ws.id;\n", ""]], tests: [], rig: { arm: KEPT, clause: 'env/the-sdk-session-owns-the-spool-and-the-identity' } },
  { id: 'R07_hook_script_writes_nothing', clause: 'the installed hook script appends to the spool and moves the dot', edits: [[WS, '[ -n "\\$event" ] || exit 0', 'exit 0']], tests: [], rig: { arm: KEPT, clause: 'spool/a-submit-line-moves-the-dot-to-running' } },
  { id: 'R08_spool_reader_applies_nothing', clause: 'the spool reader applies a line to the status machine', edits: [[ES, "      applyAgentEvent(id, ev.event, tool, transcript, crons, toolUseId);", "      void 0;"]], tests: [], rig: { arm: KEPT, clause: 'spool/a-submit-line-moves-the-dot-to-running' } },
  { id: 'R09_context_tokens_ignore_cache_reads', clause: 'a stop line with a transcript persists the transcript-derived context tokens', edits: [[AC, "      num(usage.cache_read_input_tokens);", "      0;"]], tests: [], rig: { arm: KEPT, clause: 'spool/a-stop-line-with-a-transcript-persists-the-context-tokens' } },
  { id: 'R10_socket_guard_constant_ok', clause: 'the rig-base guard can refuse', edits: [[RG, "  const worst = rows[0];\n  if (!worst || worst.len <= KEEPER_SOCKET_LIMIT)", "  const worst = rows[0];\n  if (true)"]], tests: [], rig: { arm: SOCK, clause: 'pure/over-the-limit-refused' } },
  { id: 'R11_socket_guard_not_called_by_bootApp', clause: 'bootApp refuses a long base before launching', edits: [[RG, "  if (!sock.ok) throw new Error(`REFUSED before launch [${sock.clause}]: ${sock.detail}`);\n", ""]], tests: [], rig: { arm: SOCK, clause: 'bootApp/refuses-a-long-base-before-launch' } },
  { id: 'R12_wrapper_default_base_long_again', clause: 'the wrapper default base fits every booting arm', edits: [[RS, 'E2E_RIG_BASE="${E2E_RIG_BASE:-/var/tmp/avr-$(id -u)}"', 'E2E_RIG_BASE="${E2E_RIG_BASE:-$HOME/.cache/e2e-agent-view-removal}"']], tests: [], rig: { arm: SOCK, clause: 'wrapper/default-base-fits-every-booting-arm', noBuild: true } },
  { id: 'R13_driver_early_check_removed', clause: 'the driver refuses a long base once, up front', edits: [[RG, "    if (!b.ok) { pre.clause(b.clause, false, `arm ${arm.name}: ${b.detail}`); return finish(sel); }\n", ""]], tests: [], rig: { arm: SOCK, clause: 'driver/refuses-a-long-base-before-any-boot', noBuild: true } },
  // ── the 3 KEEP clauses the verifier's own mutants found unpinned (ledger c/6133999354), pinned by the #233 follow-up ──
  { id: 'R14_exit_floor_loses_its_identity_guard', clause: 'a live successor\'s dot is not floored by the predecessor\'s teardown', edits: [[AS, "    if (sessions.get(session.wsId) === session) {\n      sessions.delete(session.wsId);", "    {\n      sessions.delete(session.wsId);"]], tests: [], rig: { arm: SEAMS, clause: 'restart/a-live-successors-dot-is-not-floored' } },
  { id: 'R15_hook_script_never_increments_seq', clause: 'the installed hook script numbers its spool lines', edits: [[WS, "    seq=\\$((cur + 1))", "    seq=\\$((cur + 0))"]], tests: [], rig: { arm: KEPT, clause: 'hook/seq-is-strictly-increasing' } },
  { id: 'R17_run_terminal_never_loads_its_webgl_addon', clause: 'the Run terminal loads the WebGL addon into the terminal', edits: [['src/renderer/components/RunTerminal.tsx', "      term.loadAddon(webgl);\n", "      void webgl;\n"]], tests: [T.wiring] },
  { id: 'R16_run_terminal_loses_its_webgl_renderer', clause: 'the Run terminal instantiates the WebGL addon', edits: [['src/renderer/components/RunTerminal.tsx', "      webgl = new WebglAddon();\n", "      webgl = null;\n"]], tests: [T.wiring] },
];

// ── instrument checks that need no app ──
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(path.join(REPO, f))).digest('hex');
const count = (src, s) => src.split(s).length - 1;
function anchorsOk() {
  let bad = 0;
  for (const m of MUTANTS) for (const [f, find] of m.edits) { const n = count(fs.readFileSync(path.join(REPO, f), 'utf8'), find); if (n !== 1) { bad++; console.log(`ANCHOR-BAD ${m.id}: ${f} matches ${n}× (need exactly 1): ${JSON.stringify(find.slice(0, 70))}`); } }
  console.log(`ANCHORS: ${MUTANTS.reduce((a, m) => a + m.edits.length, 0) - bad}/${MUTANTS.reduce((a, m) => a + m.edits.length, 0)} resolve exactly once`);
  return bad === 0;
}
if (args.includes('--check-anchors')) process.exit(anchorsOk() ? 0 : 1);
if (!anchorsOk()) process.exit(2);
if (spawnSync('git', ['-C', REPO, 'diff', '--quiet', '--', ...new Set(MUTANTS.flatMap((m) => m.edits.map(([f]) => f)))]).status !== 0) { console.error('ABORT: a file a mutant edits has uncommitted changes — commit first (the restore proof is `git diff` empty)'); process.exit(2); }

const BACKUP = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'ptyl-mutants-'));
const unit = (files) => spawnSync(process.execPath, ['--test', '--experimental-strip-types', ...files], { cwd: REPO, encoding: 'utf8', timeout: 300000 });
const failedNames = (out) => [...out.matchAll(/^\s*not ok \d+ - (.*)$/gm)].map((m) => m[1]);
function rigRun(arm, noBuild = false) {
  if (!noBuild) execFileSync('pnpm', ['run', 'build:bundles'], { cwd: REPO, stdio: 'ignore', timeout: 600000 });
  const r = spawnSync('bash', [path.join(REPO, 'scripts/e2e-agent-view-removal.sh'), REPO, '--arm', arm], { cwd: REPO, encoding: 'utf8', timeout: 900000 });
  const out = `${r.stdout}\n${r.stderr}`;
  fs.writeFileSync(path.join(BACKUP, `rig-${arm}-${Date.now()}.log`), out); // kept for forensics (a GREEN rig must be readable)
  return { fails: [...out.matchAll(/^FAIL\s+(\S+) —/gm)].map((m) => m[1]), last: (out.match(/RIG-RESULT .*/) ?? ['(no RIG-RESULT)'])[0], rc: r.status };
}

let killed = 0, survived = [];
const rows = [];
function restore(files) {
  for (const f of files) {
    fs.copyFileSync(path.join(BACKUP, f.replaceAll('/', '__')), path.join(REPO, f));
    if (spawnSync('cmp', ['-s', path.join(BACKUP, f.replaceAll('/', '__')), path.join(REPO, f)]).status !== 0) { console.error(`FATAL: restore of ${f} is not byte-exact`); process.exit(3); }
  }
}
// CONTROL 1: a no-op "mutant" (same text) must leave the named tests GREEN — the instrument can say PASS.
{
  const [f, find] = MUTANTS[0].edits[0];
  const orig = fs.readFileSync(path.join(REPO, f), 'utf8');
  fs.writeFileSync(path.join(REPO, f), orig.replace(find, () => find));
  const r = unit(MUTANTS[0].tests); const red = failedNames(`${r.stdout}`);
  fs.writeFileSync(path.join(REPO, f), orig);
  console.log(`CONTROL no-op mutant: tests ${r.status === 0 && red.length === 0 ? 'GREEN (instrument can pass)' : `RED ${JSON.stringify(red)} — INSTRUMENT BROKEN`}`);
  if (r.status !== 0) process.exit(4);
}
for (const m of MUTANTS) {
  if (only && !only.has(m.id.split('_')[0])) continue;
  const files = [...new Set(m.edits.map(([f]) => f))];
  for (const f of files) fs.copyFileSync(path.join(REPO, f), path.join(BACKUP, f.replaceAll('/', '__')));
  const before = Object.fromEntries(files.map((f) => [f, sha(f)]));
  try {
    for (const [f, find, to] of m.edits) { const src = fs.readFileSync(path.join(REPO, f), 'utf8'); fs.writeFileSync(path.join(REPO, f), src.replace(find, () => to)); }
    const u = m.tests.length ? unit(m.tests) : null; const red = u ? failedNames(u.stdout) : [];
    const unitKilled = u ? u.status !== 0 && red.length > 0 : null;   // null = rig-only mutant
    let rigKilled = null, rigNote = '';
    if (m.rig && !noRig) { const g = rigRun(m.rig.arm, !!m.rig.noBuild); rigKilled = g.fails.some((c) => c.includes(m.rig.clause)); if (!g.last.startsWith('RIG-RESULT')) { rigKilled = false; rigNote = ` rig[${m.rig.arm}] INCONCLUSIVE — the rig produced no RIG-RESULT (${g.last}; rc ${g.rc}) — see ${BACKUP}`; } else rigNote = ` rig[${m.rig.arm}] ${rigKilled ? 'RED' : 'GREEN'} on '${m.rig.clause}' (${g.fails.length} FAIL: ${g.fails.slice(0, 3).join(', ')}) ${g.last.slice(0, 90)}`; }
    const skipped = unitKilled === null && noRig;   // a rig-only mutant under --no-rig cannot be judged: reported SKIPPED, never counted as a survivor
    const ok = skipped || ((unitKilled === null || unitKilled) && (rigKilled === null || rigKilled) && !(unitKilled === null && rigKilled === null));
    rows.push(`${skipped ? 'SKIPPED ' : ok ? 'KILLED  ' : 'SURVIVED'} ${m.id} — ${m.clause} — tests ${unitKilled === null ? 'n/a (rig-only)' : unitKilled ? `RED (${red.length}: ${red.slice(0, 2).join(' | ').slice(0, 110)})` : 'GREEN'}${rigNote}`);
    if (skipped) { /* not counted */ } else if (ok) killed++; else survived.push(m.id);
  } finally {
    restore(files);
    for (const f of files) if (sha(f) !== before[f]) { console.error(`FATAL: ${f} differs after restore`); process.exit(3); }
  }
  console.log(rows[rows.length - 1]);
}
if (!noRig && rows.some((r) => r.includes('rig['))) execFileSync('pnpm', ['run', 'build:bundles'], { cwd: REPO, stdio: 'ignore', timeout: 600000 }); // leave dist/ built from the RESTORED tree
const dirty = spawnSync('git', ['-C', REPO, 'diff', '--stat', '--', 'src', 'scripts']).stdout.toString().trim();
console.log(`TREE: ${dirty ? `DIRTY\n${dirty}` : 'clean (git diff empty) — every file byte-exact restored'}`);
const nSkipped = rows.filter((r) => r.startsWith('SKIPPED')).length;
console.log(`MUTATE-PTY-LAUNCHER: ${survived.length ? 'FAIL' : 'PASS'} (${killed}/${rows.length - nSkipped} killed${nSkipped ? `, ${nSkipped} rig-only skipped (--no-rig)` : ''}${survived.length ? `; survived: ${survived.join(', ')}` : ''})`);
process.exit(survived.length || dirty ? 1 : 0);
