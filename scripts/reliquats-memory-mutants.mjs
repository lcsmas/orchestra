// #328 self-gate — IN-PLACE mutation sweep of the Reliquats / per-member scope memory. Each mutant edits ONE clause of the real source, runs the unit + wiring suites (and, for a clause only the REAL
// keeper-in-a-scope can judge, the NAMED rig arm: scripts/e2e-reliquats-memory.mjs), and must turn at least the NAMED test/arm red. Restored by byte-exact backup + `cmp` after every mutant; `git diff` of the
// mutated files must be empty at the end (commit first). A CLI-affecting mutant rebuilds dist-electron/cli.js (the instrument is rebuilt, never reused stale); the clean build is restored at the end.
//
// HEAVY by the wave rule (a mutation sweep): needs the OPS's heavy-rig token + MemAvailable > 6 GB right before. A rig arm starts a real keeper in a disposable ≤ 300 MB scope and prints its survivors.
// Run: node scripts/reliquats-memory-mutants.mjs [--only M01,M02] [--check-anchors] [--no-rig]

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const BACKUP = path.join(os.homedir(), '.cache', 'h2-328', 'mutant-backup');
fs.mkdirSync(BACKUP, { recursive: true });
const args = process.argv.slice(2);
const only = args.includes('--only') ? new Set(args[args.indexOf('--only') + 1].split(',')) : null;
const noRig = args.includes('--no-rig');

const S = 'src/shared/member-memory.ts';
const P = 'src/main/member-memory.ts';
const HOST = 'src/main/member-memory-host.ts';
const SR = 'src/shared/resources.ts';
const SM = 'src/shared/resource-monitor.ts';
const MON = 'src/main/resource-monitor.ts';
const RES = 'src/main/resources.ts';
const HS = 'src/main/hooks-server.ts';
const CLI = 'src/cli/index.ts';
const V = 'src/renderer/components/ResourcesView.tsx';
const CSS = 'src/renderer/styles.css';
const TESTS = ['src/shared/member-memory.test.ts', 'src/main/member-memory.test.ts', 'src/main/member-memory-wiring.test.ts', 'src/shared/resources.test.ts', 'src/shared/resource-monitor.test.ts'];
// `expect` = a substring of the reddened unit test name or `rig:<arm>` that MUST be among the red ones; `rig` = the arms to run for this mutant (none = unit suites only); `shot: true` also runs the headless-sway screenshot gate (scripts/reliquats-screenshot.mjs — `shot:<check label substring>`).
const MUTANTS = [
  // ── pure half: the fold of a member's scope generations ──
  { id: 'M01_unreadable_is_zero', file: S, find: 'bytes: meters.length === 0 ? null : sum(meters),', to: 'bytes: meters.length === 0 ? 0 : sum(meters),', expect: ['M3 unmeasured is never 0'] },
  { id: 'M02_generations_not_summed', file: S, find: 'bytes: meters.length === 0 ? null : sum(meters),', to: 'bytes: meters.length === 0 ? null : Math.max(...meters),', expect: ['M1 memberViewFrom', 'rig:two_generations'], rig: ['two_generations'] },
  { id: 'M03_reliquat_is_every_non_keeper', file: S, find: "(r.procs ?? []).filter((p) => p.role === 'reliquat')", to: "(r.procs ?? []).filter((p) => p.role !== 'keeper')", expect: ['M1 memberViewFrom', 'M2 memberViewFrom', 'rig:known_magnitude'], rig: ['known_magnitude'] },
  { id: 'M04_unreadable_not_counted', file: S, find: 'unreadable: readings.length - meters.length,', to: 'unreadable: 0,', expect: ['M3 unmeasured is never 0'] },
  { id: 'M05_unlisted_is_zero_reliquats', file: S, find: 'reliquats: listed.length === 0 ? null : reliquats.length,', to: 'reliquats: reliquats.length,', expect: ['M3 unmeasured is never 0'] },
  { id: 'M06_junk_meter_summed', file: S, find: "typeof n === 'number' && Number.isFinite(n) && n >= 0;", to: "typeof n === 'number';", expect: ['M3 unmeasured is never 0'] },
  { id: 'M07_rssbytes_junk_summed', file: S, find: 'sum(reliquats.map((p) => (finite(p.rssBytes) ? p.rssBytes : 0)))', to: 'sum(reliquats.map((p) => p.rssBytes))', expect: ['M3b a junk RSS'] },
  { id: 'M08_heaviest_not_first', file: S, find: 'const order = (v: MemberMemoryView): number => v.bytes ?? -1;', to: 'const order = (v: MemberMemoryView): number => 0;', expect: ['M4 buildMemberMemoryReport'] },
  { id: 'M09_unmeasured_sorts_first', file: S, find: 'v.bytes ?? -1;', to: 'v.bytes ?? Infinity;', expect: ['M4 buildMemberMemoryReport'] },
  // ── the row's figure ──
  { id: 'M10_sdk_tree_added_twice', file: S, find: 'const outside = all - sdk;', to: 'const outside = all;', expect: ['M5 rowProcessBytes', 'G6'] },
  { id: 'M11_unreadable_meter_trusted', file: S, find: 'if (!view || view.bytes === null) return all;', to: 'if (!view) return all;', expect: ['M6 rowProcessBytes', 'G7'] },
  { id: 'M12_partial_not_lower_bound', file: S, find: 'view.unreadable > 0 ? Math.max(view.bytes, sdk) : view.bytes', to: 'view.bytes', expect: ['M7 rowProcessBytes'] },
  { id: 'M13_pty_sessions_dropped', file: S, find: 'const outside = all - sdk;', to: 'const outside = 0;', expect: ['M5 rowProcessBytes', 'G6'] },
  // ── the line ──
  { id: 'M14_not_tracked_text', file: S, find: '`reliquats: Reliquats not tracked — ${untrackedWhy(r)}${stray > 0', to: '`reliquats: untracked — ${untrackedWhy(r)}${stray > 0', expect: ['M8 formatReliquatsLine', 'rig:untracked_fallback', 'rig:bus_status_line'], rig: ['untracked_fallback', 'bus_status_line'], cli: true },
  { id: 'M15_untracked_remainder_hidden', file: S, find: 'if (r.untracked.length > 0) parts.push(', to: 'if (r.untracked.length > 99) parts.push(', expect: ['M9 formatReliquatsLine', 'rig:bus_status_line'], rig: ['bus_status_line'], cli: true },
  { id: 'M16_zero_reliquats_hidden', file: S, find: "if (withR.length === 0) parts.push(t.anyUnlisted ? '0 live (lower bound)' : '0 live');", to: "if (withR.length === 0) parts.push('');", expect: ['M9 formatReliquatsLine'] },
  { id: 'M17_lower_bound_not_marked', file: S, find: "parts.push(`${t.count} live${t.anyUnlisted ? ' (lower bound)' : ''} — ", to: "parts.push(`${t.count} live — ", expect: ['M9 formatReliquatsLine'] },
  // ── the producer ──
  { id: 'M18_untracked_includes_tracked', file: P, find: 'const untracked = [...new Set(live)].filter((id) => !trackedIds.has(id) || keeperless.has(id));', to: 'const untracked = [...new Set(live)];', expect: ['P1 a tracked member', 'rig:bus_status_line'], rig: ['bus_status_line'], cli: true },
  { id: 'M19_no_untracked_at_all', file: P, find: "    live = d.liveMemberIds();", to: '    live = [];', expect: ['P1 a tracked member', 'rig:untracked_fallback'], rig: ['untracked_fallback'] },
  { id: 'M20_workspace_asked_twice', file: P, find: 'for (const wsId of new Set(d.workspaceIds())) {', to: 'for (const wsId of d.workspaceIds()) {', expect: ['P6 the same workspace id'] },
  { id: 'M21_no_scope_member_tracked', file: P, find: '    if (scopes.length === 0) continue;\n', to: '', expect: ['P1 a tracked member', 'rig:untracked_fallback'], rig: ['untracked_fallback'] },
  { id: 'M22_scope_lookup_throw_escapes', file: P, find: "      warnOnce(`memberScopes(${wsId})`, e);\n      continue; // an unreadable directory scan = not tracked: today's behaviour", to: '      throw e;', expect: ['P4 FI-1 calls that throw'] },
  { id: 'M23_unreadable_meter_is_zero', file: P, find: 'currentBytes = d.readMemory(s)?.currentBytes ?? null;', to: 'currentBytes = d.readMemory(s)?.currentBytes ?? 0;', expect: ['P4 FI-1 calls that throw'] },
  { id: 'M24_support_throw_escapes', file: P, find: "    support = { ok: false, reason: `scope support could not be probed: ${(e as Error)?.message ?? e}` };", to: '    throw e;', expect: ['P5 a support probe'] },
  { id: 'M25_unsupported_reason_dropped', file: P, find: 'const unsupported = support.ok ? null : support.reason;', to: 'const unsupported = null;', expect: ['P3 no scope anywhere'] },
  { id: 'M26_scopes_ignore_fi1', file: P, find: 'scopes: (wsId) => memberScopes(wsId),', to: 'scopes: (_wsId) => [],', expect: ['rig:known_magnitude', 'rig:keeper_gone_reliquat_stays'], rig: ['known_magnitude', 'keeper_gone_reliquat_stays'] },
  { id: 'M27_list_procs_ignored', file: P, find: 'listProcs: (s) => listScopeProcs(s),', to: 'listProcs: (_s) => null,', expect: ['rig:known_magnitude', 'rig:keeper_gone_reliquat_stays'], rig: ['known_magnitude', 'keeper_gone_reliquat_stays'] },
  // ── the shared read ──
  { id: 'M28_cache_never_expires', file: HOST, find: '&& now - cache.at < MEMBER_MEMORY_TTL_MS) return cache.report;', to: '&& true) return cache.report;', expect: ['W4 the host facade'] },
  { id: 'M29_fresh_ignored', file: HOST, find: 'if (!opts.fresh && cache &&', to: 'if (cache &&', expect: ['W4 the host facade'] },
  { id: 'M30_keepers_not_asked', file: HOST, find: 'workspaceIds: () => [...store.workspaces.map((w) => w.id), ...live]', to: 'workspaceIds: () => [...store.workspaces.map((w) => w.id)]', expect: ['W4 the host facade'] },
  // ── the three consumers ──
  { id: 'M31_monitor_no_member_dep', file: MON, find: '    memberMemory: () => currentMemberMemory({ fresh: true }),\n', to: '', expect: ['W3 the monitor line', 'rig:known_magnitude'], rig: ['known_magnitude'] },
  { id: 'M32_monitor_cached_read', file: MON, find: 'memberMemory: () => currentMemberMemory({ fresh: true }),', to: 'memberMemory: () => currentMemberMemory(),', expect: ['W3 the monitor line'] },
  { id: 'M33_monitor_line_without_members', file: MON, find: '      members: readMembers(d),\n', to: '', expect: ['W3 the monitor line', 'rig:known_magnitude'], rig: ['known_magnitude'] },
  { id: 'M34_monitor_read_failure_breaks_tick', file: MON, find: "    d.warn('resources: member scope read failed — this line carries no member figures', e);\n    return undefined;", to: '    throw e;', expect: ['W3 the monitor line'] },
  { id: 'M35_line_drops_members', file: SM, find: '    ...(input.members ? { members: input.members } : {}),\n', to: '', expect: ['the scope reading rides on the line', 'rig:known_magnitude'], rig: ['known_magnitude'] },
  { id: 'M36_default_deps_read_cgroups', file: MON, find: "  warn: (message, meta) => rlog.warn(message, meta),\n  info: (message, meta) => rlog.info(message, meta),\n};", to: "  warn: (message, meta) => rlog.warn(message, meta),\n  info: (message, meta) => rlog.info(message, meta),\n  memberMemory: () => currentMemberMemory({ fresh: true }),\n};", expect: ['W3 the monitor line'] },
  { id: 'M37_page_snapshot_no_members', file: RES, find: '    members: currentMemberMemory(), // read AFTER the awaits above: the cache stamp is its own, not this sample\'s start\n', to: '', expect: ['W5 the Resources snapshot', 'rig:page_snapshot'], rig: ['page_snapshot'] },
  { id: 'M38_remote_row_reads_local_scope', file: SR, find: 'const view = remote ? undefined : viewFor(members, key);', to: 'const view = viewFor(members, key);', expect: ['G7'] },
  { id: 'M39_row_ignores_scope', file: SR, find: 'memBytes: (view ? rowProcessBytes(list, view) : list.reduce((n, s) => n + s.memBytes, 0))', to: 'memBytes: (list.reduce((n, s) => n + s.memBytes, 0))', expect: ['G6', 'G7', 'rig:page_snapshot'], rig: ['page_snapshot'] },
  { id: 'M40_row_no_reliquat_count', file: SR, find: 'reliquats: view && view.reliquats !== null ? { count: view.reliquats, bytes: view.reliquatBytes ?? 0, partial: view.unlisted > 0, procs: view.reliquatProcs } : null,', to: 'reliquats: null,', expect: ['G6'] },
  { id: 'M41_busstatus_no_members', file: HS, find: '              members: membersView,\n', to: '', expect: ['W6 /busStatus', 'rig:bus_status_line'], rig: ['bus_status_line'] },
  { id: 'M42_busstatus_no_labels', file: HS, find: '              memberLabels: Object.fromEntries(membersView.tracked.map((m) => [m.wsId, heldStartLabel(store.getWorkspace(m.wsId), m.wsId)])),\n', to: '', expect: ['W6 /busStatus'] },
  // ── review dispositions (pre-review c. 2026-10-08): RSS label, stray scopes, the Reliquat advisory, honest cause text ──
  { id: 'M44_reliquat_size_not_labelled_rss', file: S, find: "${fmtBytes(m.reliquatBytes ?? 0)} RSS`", to: "${fmtBytes(m.reliquatBytes ?? 0)}`", expect: ['M9 formatReliquatsLine', 'M12 a Reliquat size', 'rig:bus_status_line'], rig: ['bus_status_line'], cli: true },
  { id: 'M45_stray_never_said', file: S, find: "  if (stray > 0) parts.push(strayText);\n", to: '', expect: ['M11 strayScopes'] },
  { id: 'M46_stray_blames_a_cause', file: S, find: "r.unsupported ?? 'no live member has a scope (e.g. memory_cap OFF", to: "r.unsupported ?? 'no live member has a scope (memory_cap OFF", expect: ['M8 formatReliquatsLine', 'M11 strayScopes'] },
  { id: 'M47_stray_counts_read_scopes', file: P, find: 'stray = Math.max(0, all - tracked.reduce((n, m) => n + m.scopes, 0));', to: 'stray = Math.max(0, all);', expect: ['P9 a scope of a workspace'] },
  { id: 'M48_stray_negative_not_clamped', file: P, find: 'stray = Math.max(0, all - tracked.reduce((n, m) => n + m.scopes, 0));', to: 'stray = all - tracked.reduce((n, m) => n + m.scopes, 0);', expect: ['P9 a scope of a workspace'] },
  { id: 'M49_uncountable_is_zero', file: P, find: 'if (all !== null) stray = Math.max(', to: 'stray = Math.max(', expect: ['P9 a scope of a workspace'] },
  { id: 'M50_advisory_threshold_gte', file: SM, find: "(m.reliquatBytes ?? 0) > SESSION_RSS_WARN_BYTES) {", to: "(m.reliquatBytes ?? 0) >= SESSION_RSS_WARN_BYTES) {", expect: ['decideReliquatWarnings'] },
  { id: 'M52_advisory_not_in_tick', file: MON, find: ", ...decideReliquatWarnings(line.members)]) {", to: "]) {", expect: ['W7 the Reliquat advisory'] },
  { id: 'M53_page_stamp_is_sample_start', file: RES, find: 'members: currentMemberMemory(), // read AFTER', to: 'members: currentMemberMemory({ now }), // read AFTER', expect: ['W5 the Resources snapshot'] },
  { id: 'M54_support_uncached', file: P, find: 'support: () => scopeSupportCached(),', to: 'support: () => scopeSupport(),', expect: ['W1 FI-1.3'] },
  // ── the page (D-Q3 option A) + the display helpers ──
  { id: 'M55_page_ignores_members', file: SR, find: 'return groupSessionsByWorkspace(snap?.sessions ?? [], snap?.containers, snap?.members);', to: 'return groupSessionsByWorkspace(snap?.sessions ?? [], snap?.containers);', expect: ['G9 (#328) groupSnapshot', 'W8 the Resources page', 'shot:seeded: feat-x carries'], shot: true },
  { id: 'M56_chip_at_zero', file: V, find: '{reliquats && reliquats.count > 0 && (', to: '{reliquats && (', expect: ['W8 the Resources page', 'shot:seeded: feat-y (tracked, no Reliquat) has NO chip'], shot: true },
  { id: 'M57_reliquat_only_row_not_rendered_as_container_only', file: V, find: ') : row.containerOnly || row.scopeOnly ? (', to: ') : row.containerOnly ? (', expect: ['W8 the Resources page', 'shot:seeded: the finished member'], shot: true },
  { id: 'M58_chip_without_tooltip', file: V, find: ' title={reliquatChipTitle(reliquats)}>', to: '>', expect: ['W8 the Resources page', 'shot:seeded: feat-x carries'], shot: true },
  { id: 'M59_reliquat_procs_not_listed', file: V, find: '{reliquatProcs.map((p) => (', to: '{([] as typeof reliquatProcs).map((p) => (', expect: ['shot:expanded: the opened feat-x row lists'], shot: true },
  { id: 'M60_note_line_removed', file: V, find: '{reliquatsLine && (', to: '{false && reliquatsLine && (', expect: ['W8 the Resources page', 'shot:seeded: the dim line names'], shot: true },
  { id: 'M61_chip_not_yellow', file: CSS, find: '.res-chip.reliquat { color: var(--yellow);', to: '.res-chip.reliquat { color: var(--accent);', expect: ['W8 the Resources page', 'shot:seeded: the chip is YELLOW'], shot: true },
  { id: 'M62_note_is_yellow', file: CSS, find: 'line-height: 1.4; color: var(--text-dim); }\n/* The dim line under the Agents table', to: 'line-height: 1.4; color: var(--yellow); }\n/* The dim line under the Agents table', expect: ['W8 the Resources page', 'shot:seeded: the dim line is DIM'], shot: true },
  { id: 'M63_procs_sorted_ascending', file: S, find: '.sort((a, b) => b.rssBytes - a.rssBytes || a.pid - b.pid)', to: '.sort((a, b) => a.rssBytes - b.rssBytes || a.pid - b.pid)', expect: ['M13 reliquatProcs'] },
  { id: 'M64_procs_not_capped', file: S, find: '      .slice(0, MAX_RELIQUAT_PROCS),', to: '      ,', expect: ['M13 reliquatProcs'] },
  { id: 'M65_note_for_a_healthy_page', file: S, find: 'if (r.untracked.length > 0 || stray > 0) bits.push(`Reliquats not tracked — ${untrackedWhy(r)}`);', to: 'bits.push(`Reliquats not tracked — ${untrackedWhy(r)}`);', expect: ['M14 reliquatsNote'] },
  { id: 'M66_chip_title_without_rss', file: S, find: '${fmtBytes(c.bytes)} RSS — processes this workspace', to: '${fmtBytes(c.bytes)} — processes this workspace', expect: ['M15 reliquatChipTitle', 'shot:seeded: feat-x carries'], shot: true },
  { id: 'M67_container_only_row_added_next_to_scope_only', file: SR, find: '!byWs.has(a.wsId) && !scopeOnly.has(a.wsId))', to: '!byWs.has(a.wsId))', expect: ['G8'] },
  { id: 'M68_empty_scope_gets_a_row', file: SR, find: "if (byWs.has(m.wsId) || ((m.bytes ?? 0) <= 0 && (m.reliquats ?? 0) <= 0)) continue;", to: 'if (byWs.has(m.wsId)) continue;', expect: ['G8'] },
  // ── delta review (renderer round): real FI-1 binding, keeper outside its scopes, keeper without its pid file, archived names ──
  { id: 'M69_count_scopes_stubbed', file: P, find: 'countScopes: () => countMemberScopes()?.total ?? null,', to: 'countScopes: () => null,', expect: ['P7 the REAL FI-1 binding', 'rig:bus_status_line'], rig: ['bus_status_line'], cli: true },
  { id: 'M70_read_memory_stubbed', file: P, find: 'readMemory: (s) => readScopeMemory(s),', to: 'readMemory: (_s) => null,', expect: ['P7 the REAL FI-1 binding'] },
  { id: 'M71_list_procs_stubbed', file: P, find: '    listProcs: (s) => listScopeProcs(s),\n', to: '    listProcs: (_s) => null,\n', expect: ['P7 the REAL FI-1 binding'] },
  { id: 'M74_keeperless_member_not_untracked', file: P, find: ' || keeperless.has(id));', to: ');', expect: ['P10 a live member whose keeper runs OUTSIDE'] },
  { id: 'M75_disjoint_rule_dropped', file: S, find: '  if (!view.keeperInScope) return all + view.bytes;\n', to: '', expect: ['M16 keeperInScope', 'G10'] },
  { id: 'M76_keeper_always_in_scope', file: S, find: 'keeperInScope: readings.some((r) => r.keeperPid !== null && r.keeperPid !== undefined),', to: 'keeperInScope: true,', expect: ['M16 keeperInScope', 'G10', 'P10 a live member whose keeper runs OUTSIDE'] },
  { id: 'M78_archived_row_shows_raw_id', file: V, find: 'fallbackName: nameById.get(g.key) ?? g.key }));', to: 'fallbackName: g.key }));', expect: ['W8 the Resources page'] },
  { id: 'M79_reliquat_lines_not_labelled_rss', file: V, find: '{formatBytes(p.rssBytes)} RSS</span>', to: '{formatBytes(p.rssBytes)}</span>', expect: ['shot:expanded: the opened feat-x row lists'], shot: true },
  { id: 'M43_cli_no_reliquats_line', file: CLI, find: 'process.stdout.write(`${formatReliquatsLine(res.members as MemberMemoryReport, (id) => mlabels[id] ?? id)}\\n`);', to: 'void 0;', expect: ['W6 /busStatus', 'rig:bus_status_line'], rig: ['bus_status_line'], cli: true },
];

const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(path.join(REPO, f))).digest('hex');
const sh = (cmd, a, opts = {}) => spawnSync(cmd, a, { cwd: REPO, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 400_000, ...opts });

function unitRed() {
  const r = sh(process.execPath, ['--test', '--experimental-strip-types', ...TESTS]);
  const names = [...(r.stdout ?? '').matchAll(/^not ok \d+ - (.*)$/gm)].map((m) => m[1]);
  const pass = Number(/^# pass (\d+)/m.exec(r.stdout ?? '')?.[1] ?? NaN);
  const skipped = Number(/^# skipped (\d+)/m.exec(r.stdout ?? '')?.[1] ?? NaN);
  return { names, pass, skipped, status: r.status };
}
function shotRed() {
  if (noRig) return { fails: [], pass: 0, status: 0, line: '(screenshot gate not run)' };
  const r = sh('bash', [path.join(HERE, 'e2e-contained-rig.sh'), 'node', path.join(HERE, 'reliquats-screenshot.mjs')]);
  const out = r.stdout ?? '';
  return { fails: [...out.matchAll(/^\s+FAIL (.*)$/gm)].map((m) => m[1]), pass: (out.match(/^\s+ok\s/gm) ?? []).length, status: r.status, line: (out.split('\n').filter((l) => /^reliquats-screenshot:/.test(l)).pop() ?? `no summary (exit ${r.status})`) };
}
function rigRed(arms) {
  if (noRig || !arms || arms.length === 0) return { arms: [], line: '(rig not run)', survivors: 0 };
  const r = sh(process.execPath, ['--experimental-strip-types', '--import', pathToFileURL(path.join(HERE, '.r2-register.mjs')).href, path.join(HERE, 'e2e-reliquats-memory.mjs')], { env: { ...process.env, RIG_ARMS: arms.join(',') } });
  const out = r.stdout ?? '';
  const survivors = [...out.matchAll(/survivors after \w+: rig processes=(\d+) rig scopes=(\d+)/g)].reduce((n, m) => n + Number(m[1]) + Number(m[2]), 0);
  return { arms: [...out.matchAll(/^FAIL (\w+)/gm)].map((m) => m[1]), pass: (out.match(/^PASS \w+/gm) ?? []).length, survivors, line: (out.split('\n').filter((l) => l.startsWith('RELIQUATS-MEMORY RIG')).pop() ?? `no summary (exit ${r.status})`) };
}
const buildCli = () => { const r = sh('pnpm', ['run', 'build:cli']); if (r.status !== 0) throw new Error(`build:cli failed: ${r.stderr}`); };

if (args.includes('--check-anchors')) { // dry check: does every mutant's find resolve exactly once on the CURRENT sources? (no mutation, no run)
  let bad = 0;
  for (const m of MUTANTS) {
    let text = fs.readFileSync(path.join(REPO, m.file), 'utf8'); let why = null;
    for (const e of m.edits ?? [{ find: m.find, to: m.to }]) { const c = text.split(e.find).length - 1; if (c !== 1) { why = `${c}× ${e.find.slice(0, 70)}`; break; } text = text.replace(e.find, () => e.to); }
    if (why) { bad++; console.log(`ANCHOR-BAD ${m.id}: ${why}`); }
  }
  console.log(`ANCHORS: ${MUTANTS.length - bad}/${MUTANTS.length} resolve exactly once`);
  process.exit(bad ? 1 : 0);
}

// ── guard: the tree must be committed (git diff is the independent restoration proof) ──
const files = [...new Set(MUTANTS.map((m) => m.file))];
const dirty = sh('git', ['diff', '--quiet', '--', ...files, ...TESTS, 'scripts/e2e-reliquats-memory.mjs', 'scripts/reliquats-memory-mutants.mjs']).status !== 0;
if (dirty) { console.error('REFUSING: the mutated files / suites / rig have uncommitted changes — commit first (the end-of-sweep `git diff` must prove restoration)'); process.exit(2); }
const before = Object.fromEntries(files.map((f) => [f, sha(f)]));
buildCli();

// ── POSITIVE CONTROL: the unmutated tree must be all green, else every "killed" below is vacuous ──
const base = unitRed();
const ALL_ARMS = ['known_magnitude', 'keeper_gone_reliquat_stays', 'two_generations', 'untracked_fallback', 'bus_status_line', 'production_launch', 'page_snapshot'];
const baseRig = rigRed(ALL_ARMS);
const baseShot = shotRed();
console.log(`BASELINE unit: pass ${base.pass} fail ${base.names.length} skipped ${base.skipped} | rig: ${baseRig.line} (pass ${baseRig.pass}, survivors ${baseRig.survivors}) | shot: ${baseShot.line} (ok ${baseShot.pass})`);
if (base.names.length || base.status !== 0 || base.skipped !== 0 || (!noRig && (baseRig.arms.length || baseRig.pass !== ALL_ARMS.length || baseRig.survivors !== 0 || baseShot.fails.length || baseShot.status !== 0))) { console.error('BASELINE NOT GREEN — aborting (nothing was mutated)'); process.exit(2); }

const rows = [];
let restoreBad = false;
const restore = (m, backupFile) => {
  fs.copyFileSync(backupFile, path.join(REPO, m.file));
  if (spawnSync('cmp', ['-s', backupFile, path.join(REPO, m.file)]).status !== 0) { restoreBad = true; console.error(`RESTORE FAILED for ${m.file} — stop and fix by hand: git checkout -- ${m.file}`); }
};
let leaked = 0;
for (const m of MUTANTS) {
  if (only && !only.has(m.id)) continue;
  const abs = path.join(REPO, m.file);
  const original = fs.readFileSync(abs, 'utf8');
  const edits = m.edits ?? [{ find: m.find, to: m.to }];
  let mutated = original; let anchorBad = null;
  for (const e of edits) { const c = mutated.split(e.find).length - 1; if (c !== 1) { anchorBad = `find occurs ${c}× (need exactly 1): ${e.find.slice(0, 60)}`; break; } mutated = mutated.replace(e.find, () => e.to); }
  if (anchorBad) { rows.push({ id: m.id, verdict: 'ANCHOR-BAD', detail: anchorBad }); continue; }
  const backupFile = path.join(BACKUP, `${m.id}.orig`);
  fs.writeFileSync(backupFile, original);
  const onSig = () => { restore(m, backupFile); process.exit(130); };
  process.once('SIGINT', onSig); process.once('SIGTERM', onSig);
  try {
    fs.writeFileSync(abs, mutated);
    if (fs.readFileSync(abs, 'utf8') === original) { rows.push({ id: m.id, verdict: 'NO-OP', detail: 'the mutation changed nothing' }); continue; }
    if (m.cli) buildCli();
    const u = unitRed();
    const r = rigRed(m.rig);
    leaked += r.survivors ?? 0;
    const sh_ = m.shot ? shotRed() : { fails: [] };
    const red = [...u.names, ...r.arms.map((a) => `rig:${a}`), ...sh_.fails.map((f) => `shot:${f}`)];
    const hit = m.expect.filter((e) => red.some((n) => n.includes(e)));
    const shotNames = m.expect.filter((e) => e.startsWith('shot:'));
    const shotOk = shotNames.length === 0 || shotNames.some((e) => red.some((n) => n.includes(e))); // a mutant that names a shot: check must be caught by the SCREENSHOT gate — W8's source pins alone do not count
    rows.push({ id: m.id, verdict: hit.length > 0 && shotOk ? 'KILLED' : red.length ? 'KILLED-BUT-NOT-BY-NAMED-ARM' : 'SURVIVED', detail: `named ${JSON.stringify(m.expect)} hit ${JSON.stringify(hit)}; red: ${red.slice(0, 4).join(' | ')}${red.length > 4 ? ` (+${red.length - 4})` : ''}` });
  } finally {
    restore(m, backupFile);
    process.removeListener('SIGINT', onSig); process.removeListener('SIGTERM', onSig);
    if (m.cli) buildCli();
  }
}
const after = Object.fromEntries(files.map((f) => [f, sha(f)]));
const sameSha = files.every((f) => before[f] === after[f]);
const gitClean = sh('git', ['diff', '--quiet', '--', ...files]).status === 0;
const post = unitRed();
for (const r of rows) console.log(`${r.verdict.padEnd(30)} ${r.id.padEnd(38)} ${r.detail}`);
const killed = rows.filter((r) => r.verdict === 'KILLED').length;
console.log(`RESTORED: sha-identical ${sameSha} · git diff clean ${gitClean} · cmp-restore ${!restoreBad} · post-sweep unit fail ${post.names.length} · rig survivors over the sweep ${leaked}`);
console.log(`MUTANTS: ${killed}/${rows.length} killed by their NAMED test/arm${rows.length === killed ? '' : ` — NOT ALL: ${rows.filter((r) => r.verdict !== 'KILLED').map((r) => `${r.id}=${r.verdict}`).join(', ')}`}`);
process.exit(rows.length === killed && sameSha && gitClean && !restoreBad && post.names.length === 0 && leaked === 0 ? 0 : 1);
