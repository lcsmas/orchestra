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
const T = { wiring: 'src/main/pause-trap-wiring.test.ts', snap: 'src/main/pause-snapshot.test.ts', procs: 'src/shared/pause-procs.test.ts', kill: 'src/main/pause-kill.test.ts', trap: 'src/main/pause-trap.test.ts', status: 'src/cli/run-status.test.ts' };

const M = [
  // ── snapshot (pause-snapshot.ts)
  { id: 'snap-real-index', file: SNAP, find: "await git(cwd, ['add', '-A', '--', ...pathspec], env);", rep: "await git(cwd, ['add', '-A', '--', ...pathspec], {});", tests: [T.snap], expect: /NO-TOUCH|captures unstaged/ },
  { id: 'snap-large-files-captured', file: SNAP, find: 'if (st.isFile() && st.size > SNAPSHOT_MAX_UNTRACKED_BYTES) out.push', rep: 'if (false && st.isFile() && st.size > SNAPSHOT_MAX_UNTRACKED_BYTES) out.push', tests: [T.snap], expect: /over the size cap/ },
  { id: 'snap-ref-overwrite', file: SNAP, find: "await git(cwd, ['update-ref', ref, commit, ''], env);", rep: "await git(cwd, ['update-ref', ref, commit], env);", tests: [T.snap], expect: /same `at` twice/ },
  { id: 'snap-no-parent', file: SNAP, find: "...(head ? ['-p', head] : []), '-F', '-'", rep: "'-F', '-'", tests: [T.snap], expect: /captures unstaged|unborn|clean worktree/ },
  { id: 'snap-no-torn-index-fallback', file: SNAP, find: '      tree = await buildTree(cwd, tmp.file, false, head, excludes);', rep: "      throw new Error('no fallback');", tests: [T.snap], expect: /corrupt\/torn/ },
  { id: 'snap-dirty-always-false', file: SNAP, find: 'const dirty = headTree === null ? true : headTree !== tree;', rep: 'const dirty = false;', tests: [T.snap, T.trap], expect: /captures unstaged|unborn|ORDER \+ CONTENT/ },
  // ── identity / lineage (pause-procs.ts)
  { id: 'procs-protected-pid-removed', file: PROCS, find: "  if (target.pid <= 1 || target.pid === plan.cli.pid || target.pid === protect.keeperPid || target.pid === protect.selfPid) {\n    return { ok: false, reason: 'protected-pid (cli/keeper/app/init)' };\n  }\n", rep: '', tests: [T.procs], expect: /NEVER signals the CLI/ },
  { id: 'procs-identity-reread-removed', file: PROCS, find: "  if (fresh.startTicks !== target.startTicks) return { ok: false, reason: 'reused (start-time changed)' };\n", rep: '', tests: [T.procs, T.kill], expect: /REFUSES a recycled pid|RECYCLED PID/ },
  { id: 'procs-unreadable-fails-open', file: PROCS, find: "  if (fresh === 'unreadable') return { ok: false, reason: 'unreadable' };\n", rep: "  if (fresh === 'unreadable') return { ok: true, via: 'chain' };\n", tests: [T.procs, T.kill], expect: /FAILS CLOSED|UNREADABLE identity/ },
  { id: 'procs-cli-identity-unchecked', file: PROCS, find: "  if (cli === 'gone' || cli === 'unreadable' || cli.startTicks !== plan.cli.startTicks || cli.state === 'Z') {", rep: "  if (false) {", tests: [T.procs], expect: /no provable CLI/ },
  { id: 'procs-non-shell-is-tool', file: PROCS, find: '  if (!SHELLS.has(shell) && !SHELLS.has(p.comm)) return false;', rep: '', tests: [T.procs, T.kill], expect: /isToolShell|planToolTrees: tool shells/ },
  { id: 'procs-kill-order-root-first', file: PROCS, find: 'return [...members].sort((a, b) => Number(a.isRoot) - Number(b.isRoot) || b.depth - a.depth);', rep: 'return [...members].sort((a, b) => Number(b.isRoot) - Number(a.isRoot) || a.depth - b.depth);', tests: [T.procs, T.kill], expect: /killOrder|leaf-first/ },
  { id: 'procs-env-older-than-cli', file: PROCS, find: '|| p.startTicks <= cli.startTicks) continue;', rep: ') continue;', tests: [T.procs], expect: /env provenance/ },
  { id: 'procs-env-sidecar-descendants', file: PROCS, find: '|| sidecar.has(p.pid) ||', rep: '||', tests: [T.procs], expect: /env provenance/ },
  { id: 'procs-env-keeper-member', file: PROCS, find: 'p.pid === cliNow.ppid || p.pid <= 1 || ', rep: '', tests: [T.procs], expect: /never makes the CLI a member/ },
  { id: 'procs-env-verify-ignores-marker', file: PROCS, find: '  if (env === plan.cli.pid && fresh.startTicks > plan.cli.startTicks) return { ok: true, via: \'env\' };', rep: "  if (true) return { ok: true, via: 'env' };", tests: [T.procs], expect: /env path/ },
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
  { id: 'trap-members-without-descendants', file: TRAP, find: 'const members = deps.members(runSubtreeIds(db, carrier.runId));', rep: 'const members = deps.members([carrier.runId]);', tests: [T.trap], expect: /DESCENDANTS/ },
  { id: 'trap-human-mark-reusable', file: TRAP, find: '  humanTurnMarks.delete(wsId);\n', rep: '', tests: [T.trap], expect: /HUMAN prompt is ALLOWED/ },
  { id: 'trap-no-burst-guard', file: TRAP, find: "    if (last !== undefined && now - last < 1000) return 'skipped'; // one handler per burst", rep: '', tests: [T.trap], expect: /burst/ },
  { id: 'trap-pauser-observed', file: TRAP, find: "    if (carrier.pausedBy !== null && isCoordinatorHandle(carrier.pausedBy, m.wsId)) return 'allowed';", rep: '', tests: [T.trap], expect: /pauser keeps its own turns/ },
  { id: 'trap-sweep-not-reentrant', file: TRAP, find: '    if (inflight.has(key)) continue;\n', rep: '', tests: [T.trap], expect: /SWEEP/ },
  { id: 'trap-always-resnapshot', file: TRAP, find: '  if (!snapshotRef) {\n    if (!m.worktreePath)', rep: '  if (true) {\n    if (!m.worktreePath)', tests: [T.trap], expect: /BOOT COMPLETION/ },
  { id: 'trap-done-member-redone', file: TRAP, find: '  if (existing && existing.killed !== null) return; // already fully trapped (boot completion after a mid-trap quit)\n', rep: '', tests: [T.trap], expect: /BOOT COMPLETION/ },
  { id: 'rec-trap-stamp-unguarded', file: REC, find: "'UPDATE runs SET pause_trap_at = ? WHERE id = ? AND paused_at = ? AND pause_trap_at IS NULL'", rep: "'UPDATE runs SET pause_trap_at = ? WHERE id = ? AND ? IS NOT NULL AND pause_trap_at IS NULL'", tests: [T.trap], expect: /markTrapDone is keyed on paused_at/ },
  // ── wiring (index.ts / agent-sdk.ts / activity.ts / pause-trap-host.ts) — pause-trap-wiring.test.ts
  { id: 'wire-human-observer-unregistered', file: IDX, find: "    setPauseHumanTurnObserver(markPauseHumanTurn); // sdkSend(origin 'human') marks the turn the pause allows\n", rep: '', tests: [T.wiring], expect: /index\.ts starts the trap/ },
  { id: 'wire-stop-after-close', file: IDX, find: '  stopPauseTrap();\n  // Last: a clean close', rep: '  // Last: a clean close', tests: [T.wiring], expect: /index\.ts starts the trap/ },
  { id: 'wire-stream-observer-any-turn', file: SDK, find: "if (session.turnGate === null && !session.unexplainedTurnSeen && !session.stopping && (msg.type === 'assistant'", rep: "if (!session.unexplainedTurnSeen && !session.stopping && (msg.type === 'assistant'", tests: [T.wiring], expect: /consume\(\): a CLI-started turn/ },
  { id: 'wire-interrupt-idle-not-skipped', file: SDK, find: "  if (!attached && session.turnGate === null && session.queue.length === 0 && session.unexplainedTurnSeen !== true) return 'idle';\n", rep: '', tests: [T.wiring], expect: /never touches an idle session/ },
  { id: 'wire-submit-notifies-parked-prompt', file: ACT, find: 'if (!queuedSubmit) notifyTurnStart(id);', rep: 'notifyTurnStart(id);', tests: [T.wiring], expect: /submit. chokepoint/ },
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

// Gate 0: a clean control over every file any mutant uses — a tree that is already red proves nothing.
const allFiles = [...new Set(sel.flatMap((m) => m.tests))];
const control = runTests(allFiles);
console.log(`control (clean tree, ${allFiles.length} files): pass ${control.pass}, fail ${control.fail}`);
if (control.fail !== 0 || !(control.pass > 0)) { console.log(`MUTATE-UNIT: FAIL — the clean control is not green (${control.red.join(' | ')})`); process.exit(1); }

let caught = 0;
const bak = fs.mkdtempSync(path.join(os.tmpdir(), 'mutate-unit-'));
for (const m of sel) {
  const abs = path.join(REPO, m.file);
  const backup = path.join(bak, `${m.id}.bak`);
  fs.copyFileSync(abs, backup);
  const src = fs.readFileSync(abs, 'utf8');
  const edits = m.edits ?? [{ find: m.find, rep: m.rep }];
  const bad = edits.map((e) => ({ e, hits: src.split(e.find).length - 1 })).find((x) => x.hits !== 1);
  if (bad) { console.log(`✗ ${m.id}: PATTERN-GONE — anchor matched ${bad.hits}× in ${m.file} (want exactly 1): ${bad.e.find.slice(0, 70)}`); continue; }
  let res;
  try {
    fs.writeFileSync(abs, edits.reduce((acc, e) => acc.replace(e.find, () => e.rep), src));
    res = runTests(m.tests);
  } finally {
    fs.copyFileSync(backup, abs); // byte-exact restore
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
