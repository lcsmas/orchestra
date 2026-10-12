// In-place mutants for #343 (the scope's BACKSTOP kill is reported by the app, from the kernel log; the keeper leaf's margin; the #323 red rule): one per clause. Each mutant edits ONE anchor in the live
// source (byte-exact backup, restored in `finally`, compared with Buffer.compare AND `git diff --quiet`), runs its unit test files and — with --rig — its rig arms, and REQUIRES a red.
//
//   node scripts/scope-net-mutants.mjs --check                   every anchor matches exactly once (no run)
//   node scripts/scope-net-mutants.mjs --unit-only [--only a,b]  unit/wiring targets only (cheap); a mutant only a rig arm can kill prints NEEDS-RIG, not SURVIVED
//   node scripts/scope-net-mutants.mjs --rig [--only a,b]        unit + rig targets (HEAVY: real keepers in real scopes ≤ 210 MB — check MemAvailable first)
//   node scripts/scope-net-mutants.mjs --selftest                positive control: a no-op mutant must stay green on the unit targets
// `--only` takes EXACT ids: an unknown / empty / missing one exits 2 and runs NOTHING. Separate from memory-cap-mutants.mjs on purpose; the rig itself is shared: scripts/e2e-memory-cap.mjs.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RIG = ['--experimental-strip-types', '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', '--import', path.join(REPO, 'scripts', '.r2-register.mjs'), path.join(REPO, 'scripts', 'e2e-memory-cap.mjs')];
const SN = 'src/shared/scope-net.ts';
const KR = 'src/shared/keeper-room.ts';
const MS = 'src/shared/memory-scope.ts';
const MN = 'src/shared/mem-notice.ts';
const HOST = 'src/main/scope-net.ts';
const KC = 'src/main/keeper-client.ts';
const RD = 'src/main/memory-scope.ts';
const MM = 'src/shared/member-memory.ts';
const CV = 'src/shared/memory-cap-view.ts';
const U_SN = ['src/shared/scope-net.test.ts'];
const U_HOST = ['src/main/scope-net.test.ts'];
const U_WIRE = ['src/main/scope-net-wiring.test.ts'];
const U_RD = ['src/main/memory-scope.test.ts'];
const U_MM = ['src/shared/member-memory.test.ts'];
const U_CV = ['src/shared/memory-cap-view.test.ts'];

/** target: { unit: [test files], rig: [arms] }.  clause = the AC / design / review clause the mutant attacks. */
const MUTANTS = [
  // ── classifier: which kernel lines are a BACKSTOP kill ─────────────────────────────────────────────────────────
  { id: 'nk-oom-level-ignored', clause: 'the TOOL leaf reaching its own limit is the Plafond at work — never a backstop kill', file: SN, find: "const oomLevel: NetKill['oomLevel'] | null = base(l.oomMemcg) === unit ? 'scope'", replace: "const oomLevel: NetKill['oomLevel'] | null = base(l.oomMemcg) === unit || parentBase(l.oomMemcg) === unit ? 'scope'", target: { unit: U_SN.concat(U_HOST), rig: ['net_tool_kill_stays_a_tool_kill'] } },
  { id: 'nk-root-victim-counts', clause: 'a victim in the scope ROOT is the flat shape / the keeper before it moved into k — not the backstop', file: SN, find: "if (!(parentBase(l.taskMemcg) === unit && base(l.taskMemcg) === SCOPE_LEAF_KEEPER)) continue;", replace: "if (!(base(l.taskMemcg) === unit || (parentBase(l.taskMemcg) === unit && base(l.taskMemcg) === SCOPE_LEAF_KEEPER))) continue;", target: { unit: U_SN } },
  { id: 'nk-tool-victim-counts', clause: 'review M2: a TOOL killed by the scope\'s episode is the KEEPER\'s record — the app\'s backstop path never tells it again', file: SN, find: "if (!(parentBase(l.taskMemcg) === unit && base(l.taskMemcg) === SCOPE_LEAF_KEEPER)) continue;", replace: "if (!(parentBase(l.taskMemcg) === unit)) continue;", target: { unit: U_SN, rig: ['net_tool_kill_at_scope_level'] } },
  { id: 'nk-unit-prefix-match', clause: 'a longer unit sharing the prefix is another scope: the basename is compared whole', file: SN, find: "base(l.oomMemcg) === unit ? 'scope'", replace: "base(l.oomMemcg).startsWith(unit) ? 'scope'", target: { unit: U_SN } },
  { id: 'nk-since-ignored', clause: 'a line older than the scope (a recycled name) never matches', file: SN, find: 'if (l.atMs < sinceMs) continue;\n', replace: '', target: { unit: U_SN.concat(U_HOST) } },
  { id: 'nk-k-victim-dropped', clause: 'a victim in the keeper leaf is THE case: keeper / CLI killed by the scope-level episode', file: SN, find: "if (!(parentBase(l.taskMemcg) === unit && base(l.taskMemcg) === SCOPE_LEAF_KEEPER)) continue;", replace: "if (true) continue;", target: { unit: U_SN, rig: ['net_cli_killed_reported'] } },
  { id: 'nk-seq-not-the-line', clause: 'the notice identity (unit, seq) is the first kernel line\'s time: deterministic, so a replay stores once', file: SN, find: '    seq: first.atMs,', replace: '    seq: Date.now(),', target: { unit: U_SN } },
  { id: 'nk-session-flag-forced', clause: 'the session verdict is what the reporter KNOWS, not a constant', file: SN, find: 'net: { backstopBytes: facts.backstopBytes, sessionEnded, victims },', replace: 'net: { backstopBytes: facts.backstopBytes, sessionEnded: true, victims },', target: { unit: U_SN } },
  // ── the words ─────────────────────────────────────────────────────────────────────────────────────────────────
  { id: 'txt-row-is-tool-text', clause: 'the member\'s row for a backstop kill is its own sentence, not the tool-kill one', file: MS, find: "if (!isSoftRecord(rec) && rec.level === 'net' && rec.net) {", replace: 'if (false) {', target: { unit: U_SN, rig: ['net_cli_killed_reported'] } },
  { id: 'txt-bus-is-tool-text', clause: 'the coordinator\'s message names the SCOPE BACKSTOP and says it is NOT a tool kill', file: MS, find: "  if (rec.level === 'net' && rec.net) {\n    const after", replace: "  if (false) {\n    const after", target: { unit: U_SN, rig: ['net_cli_killed_reported'] } },
  { id: 'txt-log-is-tool-line', clause: 'the app-log line for a backstop kill is distinct from a tool kill\'s', file: MS, find: "if (rec.level === 'net' && rec.net) return `memory-cap[", replace: "if (false) return `memory-cap[", target: { unit: U_SN, rig: ['net_cli_killed_reported'] } },
  { id: 'txt-session-verdict-constant', clause: 'the row says « the session ended » only when it did', file: MS, find: "rec.net.sessionEnded ? 'the session ended' : 'a process was killed'}: keeper + CLI outgrew the room above the tool cap (not a tool kill)", replace: "'the session ended'}: keeper + CLI outgrew the room above the tool cap (not a tool kill)", target: { unit: U_SN } },
  { id: 'txt-room-phrase-lost', clause: 'the limit is said as what it is made of: tool cap + room', file: MS, find: 'const room = hardBytes !== null && net.backstopBytes > hardBytes ?', replace: 'const room = false ?', target: { unit: U_SN } },
  { id: 'txt-bidi-not-stripped', clause: 'a comm is attacker-influenced: bidi controls never reach the sentence', file: MS, find: '${cutChars(stripBidi(v.comm), 40)} (pid ${v.pid})', replace: '${v.comm} (pid ${v.pid})', target: { unit: U_SN } },
  { id: 'txt-victims-not-a-chip', clause: 'the victims ride in a chip of the dedicated row (red tone)', file: MN, find: '        chipOf(netVictimsPhrase(rec.net)),', replace: "        { kind: 'text', text: netVictimsPhrase(rec.net) },", target: { unit: U_SN, rig: ['net_cli_killed_reported'] } },
  // ── the host: ledger, once-only, owed deliveries ───────────────────────────────────────────────────────────────
  { id: 'host-ledger-not-persisted', clause: 'the ledger is written to disk: it survives an app restart (the cgroup does not survive its scope)', file: HOST, find: '      fs.renameSync(tmp, deps.ledgerFile); // atomic: a reader never sees a torn file', replace: '      void tmp;', target: { unit: U_HOST, rig: ['net_cli_killed_reported'] } },
  { id: 'host-reported-not-recorded', clause: 'every kernel line is told ONCE: reported lines are remembered', file: HOST, find: '            e.reported = [...e.reported, ...fresh.map(netKillKey)].slice(-100);\n            dirty = true;', replace: '            dirty = true;', target: { unit: U_HOST, rig: ['net_cli_killed_reported'] } },
  { id: 'host-failed-delivery-marked', clause: 'a delivery that FAILED (bus down) stays owed — never marked reported', file: HOST, find: '            owed = unitOwed = true;', replace: '            owed = unitOwed = true;\n            e.reported = [...e.reported, ...fresh.map(netKillKey)];', target: { unit: U_HOST } },
  { id: 'host-no-retry', clause: 'an owed delivery is retried by a timer', file: HOST, find: '        if (r.owed) {\n          scheduleRetry(wsId, units, sessionEnded);', replace: '        if (r.owed) {\n          void scheduleRetry;', target: { unit: U_HOST } },
  { id: 'host-log-every-attempt', clause: 'the log line is written once per kill, not once per delivery attempt', file: HOST, find: 'if (!logged.has(`${unit}:${rec.seq}`)) {', replace: 'if (true) {', target: { unit: U_HOST } },
  { id: 'host-not-serialized', clause: 'an `exit` and a `close` of one session never report the same line twice (per-workspace chain)', file: HOST, find: '    const prev = chains.get(wsId) ?? Promise.resolve();\n    const next = prev.then(async () => {', replace: '    const prev = Promise.resolve();\n    const next = prev.then(async () => {', target: { unit: U_HOST } },
  { id: 'host-done-while-alive', clause: 'a LIVE scope is never marked done (it may still be hit)', file: HOST, find: 'if (!unitOwed && (lastAttempt || told) && !e.done && !deps.scopeAlive(unit)) {', replace: 'if (!unitOwed && (lastAttempt || told) && !e.done) {', target: { unit: U_HOST } },
  { id: 'host-done-at-first-attempt', clause: 'a unit is closed only after the LAST attempt (the journal lags the kill) or once its kills are told', file: HOST, find: 'if (!unitOwed && (lastAttempt || told) && !e.done && !deps.scopeAlive(unit)) {', replace: 'if (!unitOwed && !e.done && !deps.scopeAlive(unit)) {', target: { unit: U_HOST } },
  { id: 'host-done-owed', clause: 'a unit with an OWED delivery is never closed', file: HOST, find: 'if (!unitOwed && (lastAttempt || told) && !e.done && !deps.scopeAlive(unit)) {', replace: 'if ((lastAttempt || told) && !e.done && !deps.scopeAlive(unit)) {', target: { unit: U_HOST } },
  { id: 'host-unreadable-as-empty', clause: 'an UNREADABLE journal is UNKNOWN, not « nothing happened » (nothing marked done)', file: HOST, find: 'const lines = preread ?? (await deps.readKernelKills(since, needleFor(live)));', replace: 'const lines = preread ?? ((await deps.readKernelKills(since, needleFor(live))) ?? []);', target: { unit: U_HOST } },
  { id: 'host-journal-unfiltered', clause: 'the journal is grepped for the units asked about (an unfiltered window of days can overflow the buffer and read as « unreadable »)', file: HOST, find: 'const lines = preread ?? (await deps.readKernelKills(since, needleFor(live)));', replace: 'const lines = preread ?? (await deps.readKernelKills(since));', target: { unit: U_HOST } },
  { id: 'host-needle-dots-unescaped', clause: 'the needle is a regex: the dots of a unit name are escaped', file: HOST, find: "u.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')", replace: "u", target: { unit: U_HOST } },
  { id: 'host-sweep-per-workspace-read', clause: 'the boot sweep reads the journal ONCE for every workspace', file: HOST, find: 'await run(wsId, units, true, [0], lines);', replace: 'await run(wsId, units, true, [0]);', target: { unit: U_HOST } },
  { id: 'host-sweep-checks-live', clause: 'the boot sweep leaves LIVE scopes to their own session end', file: HOST, find: 'if (e.done || deps.scopeAlive(unit)) continue;', replace: 'if (e.done) continue;', target: { unit: U_HOST } },
  { id: 'host-sweep-tells-deleted', clause: 'a deleted workspace is closed without a word', file: HOST, find: 'if (isKnownWorkspace && !isKnownWorkspace(e.wsId)) {\n            e.done = true; // a deleted workspace: nobody to tell\n            continue;\n          }', replace: '', target: { unit: U_HOST } },
  { id: 'host-first-look-immediate', clause: 'the first look after a session end waits for the burst (keeper then CLI) to land: ONE report', file: HOST, find: 'export const END_ATTEMPT_DELAYS_MS: readonly number[] = [500, 1000, 2500, 5000];', replace: 'export const END_ATTEMPT_DELAYS_MS: readonly number[] = [0, 1000, 2500, 5000];', target: { unit: U_HOST } },
  // ── wiring: keeper-client / index ─────────────────────────────────────────────────────────────────────────────
  { id: 'wire-launch-not-noted', clause: 'a launched scope is remembered (else its end finds nothing)', file: KC, find: 'if (cap?.limits) noteScopeLaunch(wsId, cap, launchedAt);', replace: '', target: { unit: U_WIRE, rig: ['net_cli_killed_reported', 'net_keeper_killed_reported'] } },
  { id: 'wire-exit-not-checked', clause: 'a CLI killed by a signal triggers the check', file: KC, find: 'if (f.signal !== null || (f.code !== null && f.code !== 0)) scopeNetSessionEnded(wsId);', replace: '', target: { unit: U_WIRE, rig: ['net_cli_killed_reported'] } },
  { id: 'wire-exit-clean-checked', clause: 'a clean exit costs no journal read', file: KC, find: 'if (f.signal !== null || (f.code !== null && f.code !== 0)) scopeNetSessionEnded(wsId);', replace: 'scopeNetSessionEnded(wsId);', target: { unit: U_WIRE } },
  { id: 'wire-close-not-checked', clause: 'a keeper that vanished under a live session triggers the check (it is the victim, or died with it)', file: KC, find: '          scopeNetSessionEnded(wsId); // #343: the keeper vanished', replace: '          // #343: the keeper vanished', target: { unit: U_WIRE, rig: ['net_keeper_killed_reported'] } },
  { id: 'wire-no-listener-delivers', clause: 'no memory-notice listener yet ⇒ the line stays OWED (never marked reported into the void)', file: KC, find: "if (memKillListeners.length === 0) throw new Error('no memory-notice listener is subscribed yet');", replace: '', target: { unit: U_WIRE } },
  { id: 'wire-listener-failure-swallowed', clause: 'a listener that throws (bus down) leaves the line owed', file: KC, find: '  if (failure !== null) throw failure;', replace: '', target: { unit: U_WIRE } },
  { id: 'wire-sweep-missing', clause: 'a scope the backstop emptied while the app was down is found at app start', file: 'src/main/index.ts', find: 'void sweepScopeNet((id) => !!store.getWorkspace(id));', replace: '', target: { unit: U_WIRE } },
  { id: 'wire-adopt-missing', clause: 'the scopes of keepers an older app launched are adopted at app start', file: KC, find: '    adoptHostScopes();\n    await scopeNet().sweep(isKnownWorkspace);', replace: '    await scopeNet().sweep(isKnownWorkspace);', target: { unit: U_WIRE } },
  // ── the margin of the keeper leaf ─────────────────────────────────────────────────────────────────────────────
  { id: 'room-uses-bill', clause: 'k is measured by its WORKING SET (page cache is reclaimed before any kill), the bill only when it cannot be separated', file: KR, find: 'const k = i.kWorkingSetBytes ?? i.kCurrentBytes;', replace: 'const k = i.kCurrentBytes ?? i.kWorkingSetBytes;', target: { unit: U_SN } },
  { id: 'room-is-whole-backstop', clause: 'the room is backstop − hard (what a FULL tool leaf leaves), not the whole backstop', file: KR, find: 'const roomBytes = i.backstopBytes - i.hardBytes;', replace: 'const roomBytes = i.backstopBytes;', target: { unit: U_SN } },
  { id: 'room-warn-strict', clause: 'amber AT 70 % of the room', file: KR, find: "frac >= ROOM_WARN_FRACTION ? 'warn'", replace: "frac > ROOM_WARN_FRACTION ? 'warn'", target: { unit: U_SN } },
  { id: 'room-crit-strict', clause: 'red when k ALONE fills the room (at 100 %)', file: KR, find: "tone: frac >= 1 ? 'crit'", replace: "tone: frac > 1 ? 'crit'", target: { unit: U_SN } },
  { id: 'room-pct-rounded', clause: 'the printed percent is FLOORED (« 70 % » always means at/over the amber line)', file: KR, find: 'pct: Math.floor(frac * 100 + 1e-9),', replace: 'pct: Math.round(frac * 100),', target: { unit: U_SN } },
  { id: 'rd-k-working-set-raw', clause: 'the keeper leaf\'s working set is never the raw bill when memory.stat has no inactive_file', file: RD, find: 'if (Number.isFinite(stat.inactive_file)) workingSet = workingSetBytes(current, stat);', replace: 'workingSet = current;', target: { unit: U_RD } },
  { id: 'rd-backstop-from-work-leaf', clause: 'the backstop is the SCOPE\'s own memory.max (the work leaf carries the hard level)', file: RD, find: "backstopBytes: capDir !== d ? num(e, path.join(d, 'memory.max')) : null,", replace: "backstopBytes: capDir !== d ? num(e, path.join(capDir, 'memory.max')) : null,", target: { unit: U_RD, rig: ['net_margin_reads_k'] } },
  { id: 'rd-flat-scope-has-backstop', clause: 'a flat scope\'s own limit is its hard level, not a backstop', file: RD, find: "backstopBytes: capDir !== d ? num(e, path.join(d, 'memory.max')) : null,", replace: "backstopBytes: num(e, path.join(d, 'memory.max')),", target: { unit: U_RD } },
  { id: 'rd-episodes-hierarchical', clause: 'the scope\'s own OOM episodes are memory.events.local (memory.events counts its descendants too)', file: RD, find: "e.readFile(path.join(d, 'memory.events.local'))", replace: "e.readFile(path.join(d, 'memory.events'))", target: { unit: U_RD } },
  { id: 'rd-k-kills-from-scope', clause: 'kills charged to the keeper leaf are read from ITS memory.events', file: RD, find: "parseMemoryEvents(e.readFile(path.join(kDir, 'memory.events')))?.oomKill ?? null;", replace: "parseMemoryEvents(e.readFile(path.join(scopeDir, 'memory.events')))?.oomKill ?? null;", target: { unit: U_RD } },
  { id: 'view-room-first-generation', clause: 'the margin is the scope that HOLDS the keeper — an older generation kept alive by Reliquats is not the session\'s', file: MM, find: 'function roomOf(readings: readonly ScopeReading[]): KeeperRoom | null {\n  const r = keeperReading(readings);', replace: 'function roomOf(readings: readonly ScopeReading[]): KeeperRoom | null {\n  const r = readings[0];', target: { unit: U_MM } },
  { id: 'line-closest-not-max', clause: 'the bus-status line names the member with the LEAST room', file: MM, find: 'const closest = withRoom.reduce((a, b) => (b.room.frac > a.room.frac ? b : a));', replace: 'const closest = withRoom[0];', target: { unit: U_MM } },
  { id: 'line-events-dropped', clause: 'the line counts the backstop events (kills in k + scope episodes)', file: MM, find: 'const events = withRoom.reduce((n, x) => n + x.room.netEvents, 0);', replace: 'const events = 0;', target: { unit: U_MM } },
  { id: 'wire-roomline-unprinted', clause: 'bus-status prints the keeper-leaf margin line', file: 'src/cli/index.ts', find: "process.stdout.write(`${formatRoomLine(res.members as MemberMemoryReport, (id) => mlabels[id] ?? id)}\\n`);", replace: '', target: { unit: U_WIRE } },
  { id: 'view-room-dropped', clause: 'every tracked member view carries its room', file: MM, find: '    room: roomOf(readings),', replace: '    room: null,', target: { unit: U_MM } },
  // ── review M2: the keeper's scope-level tool kill ──────────────────────────────────────────────────────────────
  { id: 'sl-never-tagged', clause: 'a tool killed by the SCOPE\'s episode gets the scopeLevel tag from the kernel line', file: MS, find: '...(isScopeLevelToolKill(k, r.unit) ? { scopeLevel: true as const } : {}),', replace: '', target: { unit: ['src/shared/memory-scope.test.ts'], rig: ['net_tool_kill_at_scope_level'] } },
  { id: 'sl-tool-leaf-limit-tagged', clause: 'the TOOL leaf reaching its own limit is the Plafond at work — never tagged scope-level', file: MS, find: 'return base(l.oomMemcg) === unit && base(l.taskMemcg) === SCOPE_LEAF_WORK && parentBase(l.taskMemcg) === unit;', replace: 'return (base(l.oomMemcg) === unit || base(l.oomMemcg) === SCOPE_LEAF_WORK) && base(l.taskMemcg) === SCOPE_LEAF_WORK && parentBase(l.taskMemcg) === unit;', target: { unit: ['src/shared/memory-scope.test.ts'] } },
  { id: 'sl-flat-root-victim-tagged', clause: 'a flat scope\'s root victim (its hard level) is never tagged scope-level', file: MS, find: 'return base(l.oomMemcg) === unit && base(l.taskMemcg) === SCOPE_LEAF_WORK && parentBase(l.taskMemcg) === unit;', replace: 'return base(l.oomMemcg) === unit && (base(l.taskMemcg) === SCOPE_LEAF_WORK || base(l.taskMemcg) === unit);', target: { unit: ['src/shared/memory-scope.test.ts'] } },
  { id: 'sl-words-are-pressure', clause: 'the row of a scope-level tool kill is its own sentence, not « under memory pressure »', file: MS, find: '  const reason = rec.scopeLevel\n    ? SCOPE_LEVEL_REASON\n    :', replace: '  const reason = false\n    ? SCOPE_LEVEL_REASON\n    :', target: { unit: ['src/shared/memory-scope.test.ts'], rig: ['net_tool_kill_at_scope_level'] } },
  { id: 'sl-bus-says-hard-level', clause: 'the coordinator\'s message for a scope-level tool kill names the SCOPE BACKSTOP, not the hard level', file: MS, find: "const lvl = rec.scopeLevel ? 'SCOPE BACKSTOP (keeper + CLI outgrew the room above the tool cap — the tool died before the cap did)' :", replace: 'const lvl = false ? \'\' :', target: { unit: ['src/shared/memory-scope.test.ts'], rig: ['net_tool_kill_at_scope_level'] } },
  { id: 'sl-tag-lost-in-notice-file', clause: 'the scopeLevel tag survives the keeper\'s durable notice file', file: 'src/shared/mem-notice-file.ts', find: '...(r.scopeLevel === true ? { scopeLevel: true as const } : {}), // #343 M2: it must survive the trip through the keeper\'s file', replace: '', target: { unit: ['src/shared/memory-scope.test.ts'] } },
  // ── review M4: an unreadable journal is not an empty one ──────────────────────────────────────────────────────
  { id: 'jr-stderr-ignored', clause: 'exit 1 with a message on stderr is UNKNOWN (null), never « nothing matched »', file: 'src/keeper/kernel-oom-log.ts', find: "if (err && String(stderr ?? '').trim() !== '') return resolve(null);", replace: '', target: { unit: ['src/keeper/kernel-oom-log.test.ts'] } },
  { id: 'jr-quiet-mode', clause: 'no `-q`: it hides the inaccessible-journal warnings the exit-1 rule reads', file: 'src/keeper/kernel-oom-log.ts', find: "'--no-pager', '-o', 'json', '--grep'", replace: "'--no-pager', '-q', '-o', 'json', '--grep'", target: { unit: ['src/keeper/kernel-oom-log.test.ts'] } },
  { id: 'jr-current-boot-only', clause: 'the app\'s long window reads every boot (a scope may have ended before a reboot)', file: 'src/keeper/kernel-oom-log.ts', find: "...(opts.allBoots ? ['-b', 'all'] : []),", replace: '', target: { unit: ['src/keeper/kernel-oom-log.test.ts'] } },
  // ── review M3: an unattached keeper's cap state ────────────────────────────────────────────────────────────────
  { id: 'cs-never-probed', clause: 'a keeper nobody is attached to is PROBED for its cap state', file: 'src/main/cap-state-cache.ts', find: 'const pr = await deps.probe(wsId);', replace: 'const pr = null as { cap?: CapStateValue } | null;', target: { unit: ['src/main/cap-state-cache.test.ts'] } },
  { id: 'cs-ttl-ignored', clause: 'a fresh entry is not probed again; a stale one is', file: 'src/main/cap-state-cache.ts', find: 'if (e && t - e.at >= 0 && t - e.at < CAP_STATE_TTL_MS) continue;', replace: 'if (e) continue;', target: { unit: ['src/main/cap-state-cache.test.ts'] } },
  { id: 'cs-probe-every-poll', clause: 'a fresh entry is not probed again', file: 'src/main/cap-state-cache.ts', find: 'if (e && t - e.at >= 0 && t - e.at < CAP_STATE_TTL_MS) continue;', replace: '', target: { unit: ['src/main/cap-state-cache.test.ts'] } },
  { id: 'cs-no-negative-entry', clause: 'a keeper launched without a cap is remembered as such (no probe every 2 s)', file: 'src/main/cap-state-cache.ts', find: 'else entries.set(wsId, { cap: null, at: deps.now() });', replace: '', target: { unit: ['src/main/cap-state-cache.test.ts'] } },
  { id: 'cs-inflight-unguarded', clause: 'one probe in flight per workspace', file: 'src/main/cap-state-cache.ts', find: 'if (inflight.has(wsId)) continue;', replace: '', target: { unit: ['src/main/cap-state-cache.test.ts'] } },
  { id: 'cs-change-silent', clause: 'a flip of state inside one scope is logged', file: 'src/main/cap-state-cache.ts', find: 'if (prev && prev.unit === cap.unit && prev.state !== cap.state) deps.log.warn(', replace: 'if (false) deps.log.warn(', target: { unit: ['src/main/cap-state-cache.test.ts'] } },
  { id: 'cs-answerless-wipes-state', clause: 'a keeper that does not answer keeps its last known state', file: 'src/main/cap-state-cache.ts', find: 'if (!pr) return; // no answer: keep what we knew, try again at the next look', replace: 'if (!pr) { entries.delete(wsId); return; }', target: { unit: ['src/main/cap-state-cache.test.ts'] } },
  { id: 'cs-refresh-not-called-by-the-page', clause: 'the page/bus-status/monitor path asks the keepers it has not heard from', file: 'src/main/member-memory-host.ts', find: '  refreshCapStates(live);', replace: '  // refreshCapStates(live);', target: { unit: U_WIRE } },
  { id: 'cs-not-primed-at-boot', clause: 'every live keeper\'s cap state is learned at app start', file: 'src/main/index.ts', find: '  primeCapStates(); // #343 gap 2', replace: '  // primeCapStates(); // #343 gap 2', target: { unit: U_WIRE } },
  // ── minor fixes ───────────────────────────────────────────────────────────────────────────────────────────────
  { id: 'room-events-summed', clause: 'one scope-level episode that kills a k victim is ONE event (the counters overlap)', file: KR, find: 'netEvents: Math.max(i.kOomKills ?? 0, i.scopeEpisodes ?? 0),', replace: 'netEvents: (i.kOomKills ?? 0) + (i.scopeEpisodes ?? 0),', target: { unit: U_SN } },
  // ── #323 minor: the bar is red on the WORKING SET ─────────────────────────────────────────────────────────────
  { id: 'cap-red-on-bill', clause: '#323 m1: the bar does not turn red on a bill that is mostly page cache', file: CV, find: "const tone: CapTone = pressureFrac(cap) >= CAP_NEAR_FRACTION ? 'crit'", replace: "const tone: CapTone = billFrac >= CAP_NEAR_FRACTION ? 'crit'", target: { unit: U_CV } },
  { id: 'cap-unknown-working-set-quiet', clause: 'an unreadable working set falls back to the bill (cautious): we cannot tell cache from anonymous memory', file: CV, find: 'export const pressureFrac = (cap: MemberCapView): number => (cap.workingSetBytes === null ? cap.billBytes : cap.workingSetBytes) / cap.hardBytes;', replace: 'export const pressureFrac = (cap: MemberCapView): number => (cap.workingSetBytes ?? 0) / cap.hardBytes;', target: { unit: U_CV } },
];

const argv = process.argv.slice(2);
const KNOWN = new Set(['--check', '--unit-only', '--rig', '--selftest', '--only']);
const stray = argv.filter((a, i) => a.startsWith('--') && !KNOWN.has(a.split('=')[0]) && !(argv[i - 1] === '--only'));
if (stray.length) { console.error(`unknown option(s): ${stray.join(' ')} — nothing run`); process.exit(2); }
const onlyIdx = argv.findIndex((a) => a === '--only' || a.startsWith('--only='));
const onlyRaw = onlyIdx < 0 ? null : argv[onlyIdx].startsWith('--only=') ? argv[onlyIdx].slice(7) : (argv[onlyIdx + 1] ?? '');
const only = onlyRaw === null ? [] : onlyRaw.split(',').filter(Boolean);
if (onlyRaw !== null && only.length === 0) { console.error('--only needs at least one id — nothing run'); process.exit(2); }
const unknown = only.filter((id) => !MUTANTS.some((m) => m.id === id));
if (unknown.length) { console.error(`unknown mutant id(s): ${unknown.join(', ')} — nothing run`); process.exit(2); }
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
    for (const u of m.target.unit ?? []) if (!fs.existsSync(path.join(REPO, u))) { console.log(`FAIL ${m.id}: unit target ${u} does not exist`); bad++; }
  }
  console.log(`${MUTANTS.length} mutants, ${bad} anchor problem(s)`);
  return bad;
}
if (mode === 'help') { console.log('usage: --check | --unit-only [--only a,b] | --rig [--only a,b] | --selftest'); process.exit(2); }
if (mode === 'check') process.exit(check() ? 1 : 0);
if (check()) { console.log('refusing to run with broken anchors'); process.exit(1); }

const unitRun = (files) => sh(process.execPath, ['--test', '--test-timeout=30000', '--experimental-strip-types', ...files]);
const unitFiles = [...new Set((mode === 'selftest' ? MUTANTS : list).flatMap((m) => m.target.unit ?? []))];
let baseBad = 0;
for (const u of unitFiles) { const r = unitRun([u]); const ok = r.status === 0 && /# skipped 0/.test(r.stdout); console.log(`baseline ${ok ? 'GREEN' : 'RED  '} unit:${u}`); if (!ok) baseBad++; }
const arms = mode === 'rig' ? [...new Set(list.flatMap((m) => m.target.rig ?? []))] : [];
for (const arm of arms) { const r = sh(process.execPath, [...RIG, arm, '--contained']); const ok = armPass(r.stdout + r.stderr, arm); console.log(`baseline ${ok ? 'GREEN' : 'RED  '} rig:${arm}`); if (!ok) baseBad++; }
if (baseBad) { console.log(`BASELINE NOT GREEN (${baseBad}) — a mutant cannot be judged against a red baseline`); process.exit(1); }

if (mode === 'selftest') {
  const noop = { file: SN, find: '/** The identity of one kernel line, for « reported once ».', replace: '/**  The identity of one kernel line, for « reported once ».' };
  const abs = path.join(REPO, noop.file);
  const orig = fs.readFileSync(abs);
  try {
    if (count(orig.toString('utf8'), noop.find) !== 1) { console.log('SELFTEST VOID: no-op anchor not found'); process.exit(1); }
    fs.writeFileSync(abs, orig.toString('utf8').replace(noop.find, () => noop.replace));
    const r = unitRun([...U_SN, ...U_HOST, ...U_WIRE]);
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
console.log(`SCOPE-NET MUTANTS (${mode}): ${list.length - survived - needsRig}/${list.length} killed, ${survived} survived/void, ${needsRig} need the rig, restore mismatches ${restoreBad}`);
console.log(dirty ? `NOTE: mutated files show in git status (expected only if they carry uncommitted work):\n${dirty}` : 'tree clean after the sweep');
process.exit(survived || restoreBad ? 1 : 0);
