// In-place mutants for the Plafond mémoire (#320): one per changed clause. Each mutant edits ONE anchor in the live source (byte-exact backup, restored in `finally`, then
// compared with `Buffer.compare` AND `git diff --quiet`), rebuilds the keeper bundle when the file ships in it, runs the named arm(s) and REQUIRES the mutant to be KILLED
// (the arm that guards that clause goes red). A survivor, an anchor that no longer matches exactly once, or a restore that differs = a non-zero exit.
//
//   node scripts/memory-cap-mutants.mjs --check          verify every anchor matches exactly once (no run)
//   node scripts/memory-cap-mutants.mjs [--only id,id]   run the sweep (HEAVY: take the heavy-rig token first — ledger §Roster)
//   node scripts/memory-cap-mutants.mjs --selftest       positive control: an unmutated tree must report every baseline arm GREEN, and a no-op mutant must SURVIVE

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RIG = ['--experimental-strip-types', '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', '--import', path.join(REPO, 'scripts', '.r2-register.mjs'), path.join(REPO, 'scripts', 'e2e-memory-cap.mjs')];
const REAL_CLI = [path.join(REPO, 'scripts', 'memory-cap', 'real-cli-prefix.mjs')];
const UNIT = (...files) => ({ unit: files });

/** target: { rig: ['arm',…] } | { realcli: ['prefix_on'] } | { unit: ['src/…test.ts'] }.  clause = the AC clause the mutant attacks. */
const MUTANTS = [
  // ── victim protection ──────────────────────────────────────────────────────────────────────────────────────────
  { id: 'wrapper-no-raise', clause: 'victim protection: tool commands are raised to +1000', file: 'src/shared/memory-scope.ts', find: 'echo ${OOM_ADJ_TOOLS} > /proc/self/oom_score_adj 2>/dev/null', replace: 'true', target: { rig: ['kill_at_hard'], realcli: ['prefix_on'], unit: ['src/shared/memory-scope.test.ts'] } },
  { id: 'keeper-no-prefix', clause: 'victim protection: the keeper points CLAUDE_CODE_SHELL_PREFIX at the wrapper', file: 'src/keeper/index.ts', find: 'const out: Record<string, string | undefined> = { ...base, CLAUDE_CODE_SHELL_PREFIX: cap.wrapper };', replace: 'const out: Record<string, string | undefined> = { ...base };', rebuild: true, target: { rig: ['kill_at_hard'] } },
  { id: 'wrapper-not-installed', clause: 'victim protection: the app lays the wrapper down', file: 'src/main/keeper-client.ts', find: 'export function installKeeper(): void {\n  installOomWrapper();', replace: 'export function installKeeper(): void {', target: { rig: ['kill_at_hard'] } },
  { id: 'spawn-frame-no-cap', clause: 'victim protection + watch: the spawn frame carries memoryCap', file: 'src/main/keeper-client.ts', find: '...(cap?.limits ? { memoryCap: { unit: cap.unit, hardBytes: cap.limits.hardBytes, wrapper: oomWrapperPath() } } : {}),', replace: '', target: { rig: ['kill_at_hard'] } },
  { id: 'wrapper-path-any', clause: 'victim protection: a wrapper path with whitespace is never set as the prefix', file: 'src/shared/memory-scope.ts', find: "return typeof p === 'string' && p.startsWith('/') && !/\\s/.test(p);", replace: "return typeof p === 'string';", target: { unit: ['src/shared/memory-scope.test.ts'] } },
  { id: 'wrapper-path-unchecked', clause: 'victim protection: the keeper checks the wrapper path', file: 'src/keeper/index.ts', find: 'if (cap.wrapper && !wrapperPathUsable(cap.wrapper)) {', replace: 'if (false) {', rebuild: true, target: { unit: ['src/main/memory-cap-binding.test.ts'] } },
  // ── human exemption / switch (the two clauses) ─────────────────────────────────────────────────────────────────
  { id: 'human-capped', clause: 'human exemption: a top-level workspace is never capped', file: 'src/shared/memory-scope.ts', find: "if (!i.hasCoordinator) return none('human');", replace: '', target: { rig: ['human_no_scope'], unit: ['src/shared/memory-scope.test.ts', 'src/main/memory-cap-switch.test.ts'] } },
  { id: 'switch-ignored', clause: 'switch: clause 1 (create the scope) follows the frozen switch', file: 'src/shared/memory-scope.ts', find: 'const createScope = i.switchOn;', replace: 'const createScope = true;', target: { rig: ['switch_off_no_scope'], unit: ['src/shared/memory-scope.test.ts'] } },
  { id: 'switch-live-not-frozen', clause: 'switch: read from the FROZEN run row, never from the live settings', file: 'src/main/memory-cap-switch.ts', find: "return !!db && busSwitch(db, runId, 'memory_cap');", replace: 'return true;', target: { unit: ['src/main/memory-cap-switch.test.ts'] } },
  // ── levels ─────────────────────────────────────────────────────────────────────────────────────────────────────
  { id: 'hard-is-soft', clause: 'levels: MemoryMax is the HARD level from the Garde mémoire settings', file: 'src/shared/memory-scope.ts', find: 'const hardBytes = Math.round(i.hardGb * GIB);', replace: 'const hardBytes = Math.round(i.softGb * GIB);', target: { rig: ['kill_at_hard'], unit: ['src/shared/memory-scope.test.ts', 'src/main/memory-cap-switch.test.ts'] } },
  { id: 'swap-allowed', clause: 'levels: no swap escape (MemorySwapMax=0) — without it zram absorbs the overflow and nothing is ever killed', file: 'src/shared/memory-scope.ts', find: 'props.push(`MemoryMax=${a.limits.hardBytes}`, `MemorySwapMax=${a.limits.swapMaxBytes}`);', replace: 'props.push(`MemoryMax=${a.limits.hardBytes}`);', target: { rig: ['kill_at_hard'], unit: ['src/shared/memory-scope.test.ts'] } },
  { id: 'oompolicy-default', clause: 'never group-kill: OOMPolicy=continue', file: 'src/shared/memory-scope.ts', find: "const props: string[] = ['OOMPolicy=continue'];", replace: 'const props: string[] = [];', target: { rig: ['kill_at_hard'], unit: ['src/shared/memory-scope.test.ts'] } },
  { id: 'soft-applied', clause: 'levels: the soft level is NEVER a kernel MemoryHigh (ledger D-Q2: it would crawl a runaway instead of killing it)', file: 'src/shared/memory-scope.ts', find: 'props.push(`MemoryMax=${a.limits.hardBytes}`, `MemorySwapMax=${a.limits.swapMaxBytes}`);', replace: 'props.push(`MemoryMax=${a.limits.hardBytes}`, `MemorySwapMax=${a.limits.swapMaxBytes}`, `MemoryHigh=${a.limits.softBytes ?? a.limits.hardBytes}`);', target: { rig: ['kill_at_hard'], unit: ['src/shared/memory-scope.test.ts'] } },
  // ── kill detection / report ────────────────────────────────────────────────────────────────────────────────────
  { id: 'watch-off', clause: 'detection: the keeper reports each kernel kill', file: 'src/keeper/memory-watch.ts', find: 'if (cur && last && cur.oomKill > last.oomKill) {\n        const killsNow', replace: 'if (false && cur && last && cur.oomKill > last.oomKill) {\n        const killsNow', rebuild: true, target: { rig: ['kill_at_hard', 'kill_while_detached'], unit: ['src/keeper/memory-watch.test.ts'] } },
  { id: 'no-catchup', clause: 'detection while the app is down: helloAck carries the records', file: 'src/keeper/index.ts', find: '...(memKills.length ? { memKills: memKills.slice() } : {}),', replace: '', rebuild: true, target: { rig: ['kill_while_detached'] } },
  { id: 'kill-not-logged', clause: 'report: one app-log line per kill', file: 'src/main/keeper-client.ts', find: 'log.warn(formatMemKillLine(wsId, rec));', replace: '', target: { rig: ['kill_at_hard'] } },
  { id: 'victim-ranking-reversed', clause: 'naming the killed command: ranked by the kernel badness', file: 'src/shared/memory-scope.ts', find: '.sort((x, y) => estimateOomBadness(y, totalPages) - estimateOomBadness(x, totalPages) || y.rssPages - x.rssPages);', replace: '.sort((x, y) => estimateOomBadness(x, totalPages) - estimateOomBadness(y, totalPages) || x.rssPages - y.rssPages);', target: { unit: ['src/shared/memory-scope.test.ts', 'src/keeper/memory-watch.test.ts'] } },
  // ── no migration / fallback / Reliquats ────────────────────────────────────────────────────────────────────────
  { id: 'attach-gate-open', clause: 'running sessions are never migrated: a live keeper is attached to, not relaunched', file: 'src/main/keeper-client.ts', find: 'if (ack.running && ack.everStarted !== false && ack.shuttingDown !== true) {', replace: 'if (false) {', target: { rig: ['no_migration'] } },
  { id: 'no-plain-fallback', clause: 'a failed launcher falls back to a plain keeper', file: 'src/main/keeper-client.ts', find: 'if (code !== 0 && launcherFailed === null) launcherFailed = `exit ${code ?? signal}`;', replace: 'if (false) launcherFailed = `exit ${code ?? signal}`;', target: { rig: ['launcher_fails_plain'] } },
  { id: 'reliquat-by-ancestry', clause: 'FI-1 c: a member whose chain does not reach the keeper is a Reliquat', file: 'src/shared/memory-scope.ts', find: '      if (cur === keeperPid) return true;\n      cur = parent(cur);', replace: '      return true;\n      cur = parent(cur);', target: { rig: ['reliquat_outlives_keeper'], unit: ['src/shared/memory-scope.test.ts'] } },
  { id: 'keeper-pid-no-fallback', clause: 'FI-1 c: the keeper is found by argv in its scope before it wrote its pid file (else it and its CLI read as Reliquats)', file: 'src/main/memory-scope.ts', find: "if (parseKeeperArgv(argv, e.keeperPidFile) === wsId) return pid;", replace: 'if (false) return pid;', target: { unit: ['src/main/memory-scope.test.ts'] } },
  { id: 'scope-scan-any-workspace', clause: 'FI-1 a: memberScopes finds THIS workspace\'s scopes only', file: 'src/shared/memory-scope.ts', find: 'return p && p.wsId === wsId ? p.gen : null;', replace: 'return p ? p.gen : null;', target: { unit: ['src/shared/memory-scope.test.ts', 'src/main/memory-scope.test.ts'] } },
  { id: 'unit-name-no-generation', clause: 'a restart while Reliquats keep the old scope must not collide (unique generation)', file: 'src/main/memory-cap-switch.ts', find: 'const unit = memoryScopeUnitName(deps.prefix(), a.wsId, newScopeGen(deps.now()));', replace: "const unit = memoryScopeUnitName(deps.prefix(), a.wsId, 'aaaaaa');", target: { rig: ['reliquat_outlives_keeper'] } },
  // ── pre-review fixes ───────────────────────────────────────────────────────────────────────────────────────────
  { id: 'watch-keeps-vanished', clause: 'pre-review MAJOR 1: a member that left in an EARLIER look is never named as a later kill\'s victim', file: 'src/keeper/memory-watch.ts', find: 'for (const k of before.keys()) if (!alive.has(k)) snap.delete(k); // forgotten, named or not', replace: '', target: { unit: ['src/keeper/memory-watch.test.ts'] } },
  { id: 'watch-no-death-grace', clause: 'the counter moves just BEFORE the victim dies: the look waits for the death', file: 'src/keeper/memory-watch.ts', find: 'if (gone.length < delta) {', replace: 'if (false) {', target: { unit: ['src/keeper/memory-watch.test.ts'] } },
  { id: 'kill-cursor-memory-only', clause: 'pre-review MAJOR 2: delivered kills are remembered ACROSS app restarts (persisted cursor)', file: 'src/main/memkill-cursor.ts', find: "        fs.renameSync(tmp, file); // atomic: a reader never sees a torn file", replace: '        void tmp; // MUTANT: never written', target: { rig: ['kill_while_detached'], unit: ['src/main/memkill-cursor.test.ts'] } },
  { id: 'kill-dedupe-off', clause: 'pre-review MAJOR 2: a record already delivered is not delivered again', file: 'src/main/keeper-client.ts', find: 'if (rec.seq <= cursor().seen(rec.unit)) return;', replace: '', target: { rig: ['kill_while_detached'] } },
  { id: 'wrapper-ready-unchecked', clause: 'pre-review MAJOR 4: no usable tool wrapper ⇒ no scope', file: 'src/main/keeper-client.ts', find: 'if (cap && !oomWrapperReady()) {', replace: 'if (false) {', target: { rig: ['wrapper_missing_no_scope'] } },
  { id: 'cap-state-unreported', clause: 'pre-review MAJOR 4: the app reads the cap state back and says it', file: 'src/main/keeper-client.ts', find: 'if (cap?.limits) void reportCapState(wsId, cap).catch(() => {});', replace: '', target: { rig: ['kill_at_hard', 'launcher_fails_plain'] } },
  { id: 'launcher-stderr-dropped', clause: 'a failed launcher says WHY (its stderr reaches the app log)', file: 'src/main/keeper-client.ts', find: "stdio: ['ignore', 'ignore', logFd]", replace: "stdio: ['ignore', 'ignore', 'ignore']", target: { rig: ['launcher_fails_plain'] } },
  { id: 'unlimited-scope-uncounted', clause: 'bus-status says how many scopes are NOT a cap (no limit applied)', file: 'src/main/memory-scope.ts', find: 'if (mem === null || mem.maxBytes === null || !swapLimitApplied(swapText, swapTotalKb)) unlimited++;', replace: '', target: { unit: ['src/main/memory-scope.test.ts'] } },
  { id: 'paused-read-error-is-none', clause: 'D1: an unreadable bus is UNKNOWN, never "memory Pause none"', file: 'src/main/pause-memory.ts', find: 'return null; // UNKNOWN is not NONE', replace: 'return []; // UNKNOWN is not NONE', target: { unit: ['src/main/pause-memory-views.test.ts'] } },
  // ── follow-up (review m3/m4/m5) ────────────────────────────────────────────────────────────────────────────────
  { id: 'd1-wanted-says-in-effect', clause: 'review m3: guard held + a known-empty bus list is not "IN EFFECT"', file: 'src/shared/memory-guard.ts', find: "? `memory Pause WANTED by the guard since", replace: "? `memory Pause IN EFFECT since", target: { unit: ['src/shared/memory-guard.test.ts'] } },
  { id: 'swap-limit-unread', clause: 'review m4: the keeper reads the swap limit back (memory.swap.max = 0)', file: 'src/keeper/index.ts', find: 'const swapOk = swapLimitApplied(swapMaxText, swapTotalKb);', replace: 'const swapOk = true;', rebuild: true, target: { unit: ['src/main/memory-cap-binding.test.ts'], rig: ['not_applied_reported'] } },
  { id: 'swap-limit-any', clause: 'review m4: only a literal 0 closes the swap escape', file: 'src/shared/memory-scope.ts', find: "if (swapMaxText !== null) return swapMaxText.trim() === '0';", replace: 'if (swapMaxText !== null) return true;', target: { unit: ['src/shared/memory-scope.test.ts'] } },
  { id: 'launcher-hang-not-killed', clause: 'review m5: a hung systemd-run falls back to a plain keeper (and is killed)', file: 'src/main/keeper-client.ts', find: "    if (launcherFailed === null) {\n      // The launcher is still running", replace: "    if (false as boolean) {\n      // The launcher is still running", target: { rig: ['launcher_hangs_plain'] } },
  { id: 'launcher-reason-overwritten', clause: 'review m5: the FIRST launcher failure reason wins', file: 'src/main/keeper-client.ts', find: 'if (code !== 0 && launcherFailed === null) launcherFailed', replace: 'if (code !== 0) launcherFailed', target: { rig: ['launcher_hangs_plain'] } },
  // ── gate F1: the oom credit carries across looks ─────────────────────────────────────────────────────────────────
  { id: 'oom-credit-not-carried', clause: 'F1: a look between the `oom` bump and the `oom_kill` bump does not turn a hard kill into «external» (credit carried)', file: 'src/keeper/memory-watch.ts', find: 'if (cur && last) for (let i = 0; i < cur.oom - last.oom; i++) oomCredits.push(t);', replace: 'oomCredits = [];\n      if (cur && last) for (let i = 0; i < cur.oom - last.oom; i++) oomCredits.push(t);', rebuild: true, target: { unit: ['src/keeper/memory-watch.test.ts'] } },
  { id: 'oom-credit-never-expires', clause: 'F1: a credit that never produced a kill expires (it cannot hard-label a later outside OOM)', file: 'src/keeper/memory-watch.ts', find: 'oomCredits = oomCredits.filter((at) => t - at <= OOM_CREDIT_TTL_MS);', replace: '', rebuild: true, target: { unit: ['src/keeper/memory-watch.test.ts'] } },
  { id: 'oom-credit-not-spent', clause: 'F1: a kill spends its credit (one oom event = one hard kill)', file: 'src/keeper/memory-watch.ts', find: 'oomCredits = oomCredits.slice(hardCredit); // the oldest credits are spent', replace: '', rebuild: true, target: { unit: ['src/keeper/memory-watch.test.ts'] } },
  { id: 'every-kill-hard', clause: 'F1: level is per record: kills beyond the credit are «external»', file: 'src/shared/memory-scope.ts', find: "level: i < a.delta.hardCredit ? 'hard' : 'external',", replace: "level: 'hard',", rebuild: true, target: { unit: ['src/keeper/memory-watch.test.ts', 'src/shared/memory-scope.test.ts'] } },
  // ── follow-up: the 4 unpinned MINOR of the gate ───────────────────────────────────────────────────────────────────
  { id: 'wrapper-arity-guard-removed', clause: 'gate MINOR: the wrapper execs argv as given when it is not ONE command string', file: 'src/shared/memory-scope.ts', find: '[ "$#" -eq 1 ] || exec "$@"\n', replace: '', target: { unit: ['src/shared/memory-scope.test.ts'] } },
  { id: 'cli-guess-any-child', clause: 'gate MINOR: the CLI is guessed only for a SOLE direct child of the keeper', file: 'src/main/memory-scope.ts', find: 'if (kids.length === 1) cli = kids[0].pid;', replace: 'if (kids.length >= 1) cli = kids[0].pid;', target: { unit: ['src/main/memory-scope.test.ts'] } },
  { id: 'hooks-unlimited-dropped', clause: 'gate MINOR: /busStatus sends how many scopes have no limit applied', file: 'src/main/hooks-server.ts', find: 'unlimited: sup.ok ? (countMemberScopes()?.unlimited ?? 0) : 0, supported: sup.ok,', replace: 'supported: sup.ok,', target: { unit: ['src/main/memory-cap-binding.test.ts'] } },
  { id: 'hooks-supported-dropped', clause: 'gate MINOR: /busStatus says whether this host can scope at all', file: 'src/main/hooks-server.ts', find: 'unlimited: sup.ok ? (countMemberScopes()?.unlimited ?? 0) : 0, supported: sup.ok,', replace: 'unlimited: sup.ok ? (countMemberScopes()?.unlimited ?? 0) : 0, supported: true,', target: { unit: ['src/main/memory-cap-binding.test.ts'] } },
  { id: 'cli-unlimited-unprinted', clause: 'gate MINOR: bus-status prints the scopes that are not a cap', file: 'src/shared/memory-scope.ts', find: "${v.unlimited ? `, ${v.unlimited} WITHOUT a limit applied` : ''}", replace: "", target: { unit: ['src/shared/memory-scope.test.ts', 'src/cli/bus-status-memory-cap.test.ts'] } },
  { id: 'applied-memory-max-unchecked', clause: 'gate MINOR: the keeper reports not-applied when memory.max is not the asked limit', file: 'src/keeper/index.ts', find: 'const limitOk = limit !== null && limit <= cap.hardBytes && limit >= cap.hardBytes - LIMIT_SLACK_BYTES;', replace: 'const limitOk = true;', rebuild: true, target: { rig: ['not_applied_reported'] } },
  { id: 'oom-credit-leftover-dropped', clause: 're-gate MINOR: a look carries the credit it did not spend to the next kill', file: 'src/keeper/memory-watch.ts', find: 'oomCredits = oomCredits.slice(hardCredit); // the oldest credits are spent', replace: 'oomCredits = []; // MUTANT: the leftover is thrown away', rebuild: true, target: { unit: ['src/keeper/memory-watch.test.ts'] } },
  { id: 'oom-credit-spend-uncapped', clause: 're-gate MINOR: a kill spends at most its own credit (min(kills, credit))', file: 'src/keeper/memory-watch.ts', find: 'const hardCredit = Math.min(killsNow, oomCredits.length);', replace: 'const hardCredit = oomCredits.length;', rebuild: true, target: { unit: ['src/keeper/memory-watch.test.ts'] } },
  { id: 'count-ignores-swap-escape', clause: 're-gate MINOR (pre-review m4): bus-status counts a scope with the swap escape open as «not a cap»', file: 'src/main/memory-scope.ts', find: 'if (mem === null || mem.maxBytes === null || !swapLimitApplied(swapText, swapTotalKb)) unlimited++;', replace: 'if (mem === null || mem.maxBytes === null) unlimited++;', target: { unit: ['src/main/memory-scope.test.ts'] } },
  // ── FI-1 v1.9 (H2 review F1): a browser that leaves the scope ──────────────────────────────────────────────────────
  { id: 'chain-in-scope-only', clause: 'FI-1 v1.9: the ppid chain is walked across the whole host (a helper whose parent left the scope is the session\'s)', file: 'src/main/memory-scope.ts', find: 'return classifyScopeMembers(members, scope.keeperPid, cli, hostParentOf(e));', replace: 'return classifyScopeMembers(members, scope.keeperPid, cli);', target: { unit: ['src/main/memory-scope.test.ts'] } },
  { id: 'outside-lists-in-scope', clause: 'FI-1 v1.9: only processes OUTSIDE the scope are listed as escaped', file: 'src/main/memory-scope.ts', find: 'if (cg === null || cg === scopeCg) continue;', replace: 'if (cg === null) continue;', target: { unit: ['src/main/memory-scope.test.ts'] } },
  { id: 'outside-lists-whole-host', clause: 'FI-1 v1.9: only the keeper\'s OWN tree is billed (not the human\'s browser)', file: 'src/main/memory-scope.ts', find: 'const seen = new Set<number>([scope.keeperPid]);\n  const queue = [scope.keeperPid];', replace: 'const seen = new Set<number>([scope.keeperPid]);\n  const queue = [scope.keeperPid, 1];', target: { unit: ['src/main/memory-scope.test.ts'] } },
  { id: 'dbus-address-kept', clause: 'H2 review F1: a capped member\'s CLI env has no session-bus address — a browser cannot leave the scope', file: 'src/keeper/index.ts', find: '    delete base.DBUS_SESSION_BUS_ADDRESS;', replace: '    void 0;', rebuild: true, target: { rig: ['kill_at_hard'], unit: ['src/main/memory-cap-binding.test.ts'] } },
  { id: 'outside-keeper-unchecked', clause: 'pre-review m1: a keeper pid that is no longer in the scope claims nothing (never another process\'s tree)', file: 'src/main/memory-scope.ts', find: "if (parseProcCgroupV2(e.readFile(`${e.procRoot}/${scope.keeperPid}/cgroup`)) !== scopeCg) return [];", replace: 'void 0;', target: { unit: ['src/main/memory-scope.test.ts'] } },
  { id: 'outside-ppid-unchecked', clause: 'pre-review m2: a pid recycled since the ppid snapshot is not billed to the keeper', file: 'src/main/memory-scope.ts', find: 'if (Number(f[1]) !== cur) continue;', replace: 'void 0;', target: { unit: ['src/main/memory-scope.test.ts'] } },
  { id: 'count-ghost-scope', clause: 'pre-review m3: a scope listed but gone is neither counted nor unlimited', file: 'src/main/memory-scope.ts', find: 'if (!e.exists(dir)) continue;', replace: 'void 0;', target: { unit: ['src/main/memory-scope.test.ts'] } },
  { id: 'count-nocontroller-ok', clause: 'pre-review m3: a scope that exists without the memory controller is a leak, not a cap', file: 'src/main/memory-scope.ts', find: 'if (mem === null || mem.maxBytes === null || !swapLimitApplied(swapText, swapTotalKb)) unlimited++;', replace: 'if ((mem !== null && mem.maxBytes === null) || !swapLimitApplied(swapText, swapTotalKb)) unlimited++;', target: { unit: ['src/main/memory-scope.test.ts'] } },
  { id: 'swap-open-unwrapped', clause: 'pre-review m4: memory.max enforced + swap escape open ⇒ tools stay wrapped and the kill watch stays on', file: 'src/keeper/index.ts', find: '  if (!limitOk) {\n    capInfo = ', replace: '  if (!limitOk || !swapOk) {\n    capInfo = ', rebuild: true, target: { rig: ['not_applied_reported'] } },
  { id: 'swap-open-state-active', clause: 'pre-review m4: …but the STATE still says not-applied (the cap leaks)', file: 'src/keeper/index.ts', find: "state: !swapOk ? 'not-applied' : wrapperOk ? 'active' : 'unprotected'", replace: "state: wrapperOk ? 'active' : 'unprotected'", rebuild: true, target: { rig: ['not_applied_reported'] } },
  { id: 'slow-keeper-killed', clause: 'pre-review m6: a keeper that systemd-run already exec\'d into, merely slow to listen, is waited for — not killed and replaced by an uncapped one', file: 'src/main/keeper-client.ts', find: 'child.pid !== undefined && launcherExecedKeeper(', replace: 'child.pid !== undefined && false && launcherExecedKeeper(', target: { rig: ['slow_keeper_keeps_cap'] } },
  { id: 'exec-check-matches-launcher', clause: 'pre-review m6: the launcher\'s own argv (it contains the keeper command) is not «the keeper»', file: 'src/shared/memory-scope.ts', find: "if (argv.length === 0 || /(^|\\/)systemd-run$/.test(argv[0])) return false;", replace: 'if (argv.length === 0) return false;', target: { unit: ['src/shared/memory-scope.test.ts'] } },
  { id: 'walk-rereads-member-ppid', clause: 'review F1: a member is walked from its SNAPSHOT ppid — one that exits between the snapshot and the walk is not a Reliquat', file: 'src/shared/memory-scope.ts', find: '    return m ? m.ppid : (parentOf?.(pid) ?? null);', replace: '    return parentOf ? parentOf(pid) : (m ? m.ppid : null);', target: { unit: ['src/shared/memory-scope.test.ts'] } },
  // ── D1 ─────────────────────────────────────────────────────────────────────────────────────────────────────────
  { id: 'd1-guard-word-only', clause: 'D1: a memory Pause IN FORCE on the bus is shown as such', file: 'src/shared/memory-guard.ts', find: 'if (paused && paused.length > 0) {', replace: 'if (false) {', target: { unit: ['src/shared/memory-guard.test.ts', 'src/main/pause-memory-views.test.ts'] } },
  { id: 'd1-views-ignore-epoch', clause: 'D1: only an epoch-matched memory motive counts as a memory Pause', file: 'src/main/pause-memory.ts', find: "if (parseMemoryPause((r.pause_auto as string | null) ?? null, pausedAt) === null) continue;", replace: '', target: { unit: ['src/main/pause-memory-views.test.ts'] } },
];

const argv = process.argv.slice(2);
const only = (argv.find((a) => a.startsWith('--only='))?.slice(7) ?? (argv.includes('--only') ? argv[argv.indexOf('--only') + 1] : '')).split(',').filter(Boolean);
const mode = argv.includes('--check') ? 'check' : argv.includes('--selftest') ? 'selftest' : 'run';
const list = only.length ? MUTANTS.filter((m) => only.includes(m.id)) : MUTANTS;
const count = (s, needle) => s.split(needle).length - 1;

function check() {
  let bad = 0;
  for (const m of MUTANTS) {
    const s = fs.readFileSync(path.join(REPO, m.file), 'utf8');
    const n = count(s, m.find);
    console.log(`${n === 1 ? 'ok  ' : 'FAIL'} anchor ${m.id} in ${m.file}: ${n} match${n === 1 ? '' : 'es (must be exactly 1)'}`);
    if (n !== 1) bad++;
    if (m.find === m.replace) { console.log(`FAIL ${m.id}: replace === find`); bad++; }
  }
  console.log(`${MUTANTS.length} mutants, ${bad} anchor problem(s)`);
  return bad;
}

const sh = (cmd, args, env = {}) => spawnSync(cmd, args, { cwd: REPO, encoding: 'utf8', env: { ...process.env, ...env }, timeout: 20 * 60_000 });
const rebuildKeeper = () => { const r = sh('pnpm', ['run', 'build:keeper']); if (r.status !== 0) throw new Error(`build:keeper failed: ${(r.stdout + r.stderr).slice(-300)}`); };
const armPass = (out, arm) => new RegExp(`^PASS ${arm}\\b`, 'm').test(out);
const armFail = (out, arm) => new RegExp(`^FAIL ${arm}\\b`, 'm').test(out);

function runTarget(t, tag) {
  const outcomes = []; // { what, red }
  for (const arm of t.rig ?? []) {
    const r = sh(process.execPath, [...RIG, arm, '--contained'], { MC_MUTANT_TAG: tag, MC_BROWSER: '1' });
    const out = r.stdout + r.stderr;
    outcomes.push({ what: `rig:${arm}`, red: armFail(out, arm), void: !armPass(out, arm) && !armFail(out, arm) });
  }
  for (const arm of t.realcli ?? []) {
    const r = sh(process.execPath, [...REAL_CLI, arm], { MC_MUTANT_TAG: tag });
    const out = r.stdout + r.stderr;
    outcomes.push({ what: `real-cli:${arm}`, red: new RegExp(`^FAIL ${arm}\\b`, 'm').test(out), void: !new RegExp(`^(PASS|FAIL) ${arm}\\b`, 'm').test(out) });
  }
  if (t.unit?.length) {
    const r = sh(process.execPath, ['--test', '--experimental-strip-types', ...t.unit]);
    outcomes.push({ what: `unit:${t.unit.map((u) => path.basename(u)).join('+')}`, red: r.status !== 0, void: false });
  }
  return outcomes;
}

if (mode === 'check') process.exit(check() ? 1 : 0);
if (check()) { console.log('refusing to run with broken anchors'); process.exit(1); }

// Baseline (the positive control): every arm a mutant relies on must be GREEN on the unmutated tree, or "red under mutation" means nothing.
const armsNeeded = [...new Set(list.flatMap((m) => m.target.rig ?? []))];
const realNeeded = [...new Set(list.flatMap((m) => m.target.realcli ?? []))];
rebuildKeeper();
const base = sh(process.execPath, [...RIG, 'all'], { MC_BROWSER: '1' });
const baseOut = base.stdout + base.stderr;
let baseBad = 0;
for (const arm of armsNeeded) { const ok = armPass(baseOut, arm); console.log(`baseline ${ok ? 'GREEN' : 'RED  '} rig:${arm}`); if (!ok) baseBad++; }
for (const arm of realNeeded) { const r = sh(process.execPath, [...REAL_CLI, arm]); const ok = new RegExp(`^PASS ${arm}\\b`, 'm').test(r.stdout); console.log(`baseline ${ok ? 'GREEN' : 'RED  '} real-cli:${arm}`); if (!ok) baseBad++; }
for (const u of [...new Set(list.flatMap((m) => m.target.unit ?? []))]) { const r = sh(process.execPath, ['--test', '--experimental-strip-types', u]); const ok = r.status === 0; console.log(`baseline ${ok ? 'GREEN' : 'RED  '} unit:${u}`); if (!ok) baseBad++; }
if (baseBad) { console.log(`BASELINE NOT GREEN (${baseBad}) — a mutant cannot be judged against a red baseline`); process.exit(1); }
if (mode === 'selftest') {
  // positive control of the instrument: a mutation that changes nothing observable must SURVIVE (else "killed" proves nothing)
  const noop = { id: 'noop', file: 'src/shared/memory-scope.ts', find: '// Plafond mémoire — the per-member kernel scope, PURE half', replace: '// Plafond mémoire — the per-member kernel scope, PURE half ', target: { rig: ['kill_at_hard'], unit: ['src/shared/memory-scope.test.ts'] } };
  const abs = path.join(REPO, noop.file);
  const orig = fs.readFileSync(abs);
  try {
    fs.writeFileSync(abs, orig.toString('utf8').replace(noop.find, noop.replace));
    const o = runTarget(noop.target, 'noop');
    console.log(`selftest no-op mutant: ${o.map((x) => `${x.what}=${x.red ? 'RED' : 'green'}`).join(' ')}`);
    if (o.some((x) => x.red)) { console.log('SELFTEST FAILED: a no-op mutation went red — the instrument cries wolf'); process.exitCode = 1; } else console.log('SELFTEST OK: a no-op mutant survives, the baseline is green');
  } finally { fs.writeFileSync(abs, orig); }
  process.exit(process.exitCode ?? 0);
}

let survived = 0, voided = 0, restoreBad = 0;
const rows = [];
for (const m of list) {
  const abs = path.join(REPO, m.file);
  const orig = fs.readFileSync(abs); // byte-exact backup
  const src = orig.toString('utf8');
  const cleanBefore = sh('git', ['diff', '--quiet', '--', m.file]).status === 0; // the git cross-check only means something for a file with no uncommitted work
  let outcomes = [];
  try {
    fs.writeFileSync(abs, src.replace(m.find, () => m.replace));
    if (m.rebuild) rebuildKeeper();
    outcomes = runTarget(m.target, m.id);
  } finally {
    fs.writeFileSync(abs, orig);
    const same = Buffer.compare(fs.readFileSync(abs), orig) === 0 && (!cleanBefore || sh('git', ['diff', '--quiet', '--', m.file]).status === 0);
    if (!same) { restoreBad++; console.error(`RESTORE MISMATCH for ${m.file}`); }
    if (m.rebuild) rebuildKeeper();
  }
  const killed = outcomes.length > 0 && outcomes.some((o) => o.red);
  const anyVoid = outcomes.some((o) => o.void);
  if (!killed) survived++;
  if (anyVoid) voided++;
  rows.push({ id: m.id, clause: m.clause, killed, by: outcomes.filter((o) => o.red).map((o) => o.what).join(','), notRed: outcomes.filter((o) => !o.red).map((o) => o.what).join(','), void: anyVoid });
  console.log(`${killed ? 'KILLED  ' : 'SURVIVED'} ${m.id}  [${m.clause}]  by: ${rows.at(-1).by || '—'}${rows.at(-1).notRed ? `  (not red: ${rows.at(-1).notRed})` : ''}${anyVoid ? '  ← VOID run (no verdict from at least one target)' : ''}`);
}
// the tree must be byte-clean again
const dirty = sh('git', ['status', '--porcelain', '--', ...new Set(list.map((m) => m.file))]).stdout.trim();
console.log(`MEMORY-CAP MUTANTS: ${rows.length - survived}/${rows.length} killed, ${survived} survived, ${voided} void, restore mismatches ${restoreBad}`);
console.log(dirty ? `NOTE: mutated files show in git status (expected only if they carry uncommitted work):\n${dirty}` : 'tree clean after the sweep');
process.exit(survived || voided || restoreBad ? 1 : 0);
