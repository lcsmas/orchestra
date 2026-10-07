// #293 self-gate — IN-PLACE mutation sweep of the container-memory accounting. Each mutant edits ONE clause of the real source, runs the unit suites + (for `arms`) the named arms
// of the REAL-dockerd rig (scripts/e2e-container-memory.mjs), and must turn the NAMED test/arm red. Byte-exact backup + `cmp` restore after every mutant, in a PRIVATE backup dir;
// `git diff` of the mutated files must be empty at the end (commit first). Unit-only mutants (`arms: []`) need no Docker; a mutant with `arms` runs the rig → the heavy-rig token.
// Run: node scripts/container-memory-mutants.mjs [--only M01,M02] [--no-rig] [--check-anchors]

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const args = process.argv.slice(2);
const only = args.includes('--only') ? new Set(args[args.indexOf('--only') + 1].split(',')) : null;
const noRig = args.includes('--no-rig');

const SHD = 'src/shared/container-accounting.ts';
const CA = 'src/main/container-accounting.ts';
const MO = 'src/main/resource-monitor.ts';
const SR = 'src/shared/resource-monitor.ts';
const RES = 'src/main/resources.ts';
const VIEW = 'src/renderer/components/ResourcesView.tsx';
const HK = 'src/main/hooks-server.ts';
const CL = 'src/cli/index.ts';
const DL = 'src/shared/docker-labels.ts';
const CW = 'src/main/container-window.ts';
const RS2 = 'src/shared/resources.ts';
const AHOST = 'src/main/memory-alert-host.ts';
const ALERT = 'src/main/memory-alert.ts';
const SALERT = 'src/shared/memory-alert.ts';
const BANNER = 'src/main/memory-banner.ts';
// `expect` = a substring of the reddened unit test name or `rig:<arm>` that MUST be among the red ones; `arms` = the rig arms to run for it ([] = units only).
const MUTANTS = [
  // ── pure half ──
  { id: 'M01_label_ignored', file: SHD, find: 'const ws = attributedWorkspaceId(c.labels);', to: 'const ws: string | null = null;', expect: ['C1 classify'], arms: ['known_magnitude'] },
  { id: 'M02_label_not_exact', file: DL, find: 'v.length > 0 && v === v.trim() ? v : null;', to: 'v.length > 0 ? v : null;', expect: ['C3 classify'], arms: [] },
  { id: 'M03_unattributed_ignores_run_start', file: SHD, find: 'else if (since !== null && c.created >= since)', to: 'else if (true)', expect: ['C1 classify', 'C2 classify'], arms: ['unattributed_visible'] },
  { id: 'M04_run_start_strict', file: SHD, find: 'c.created >= since', to: 'c.created > since', expect: ['C1 classify'], arms: [] },
  { id: 'M05_run_start_not_floored', file: SHD, find: 'Math.floor(earliestLiveRunStartMs / 1000)', to: '(earliestLiveRunStartMs / 1000)', expect: ['C1 classify'], arms: [] },
  { id: 'M06_no_run_counts_all', file: SHD, find: 'const since = earliestLiveRunStartMs === null ? null :', to: 'const since = earliestLiveRunStartMs === null ? 0 :', expect: ['C2 classify'], arms: [] },
  { id: 'M07_v2_cache_not_subtracted', file: SHD, find: 'v2 < usage) return usage - v2;', to: 'v2 < usage) return usage;', expect: ['C4 containerMemoryBytes', 'C14 a REAL stats document'], arms: [] },
  { id: 'M08_v1_cache_not_subtracted', file: SHD, find: 'v1 < usage) return usage - v1;', to: 'v1 < usage) return usage;', expect: ['C5 containerMemoryBytes'], arms: [] },
  { id: 'M09_missing_usage_is_zero', file: SHD, find: 'usage < 0) return null;', to: 'usage < 0) return 0;', expect: ['C6 containerMemoryBytes'], arms: [] },
  { id: 'M10_v2_cache_above_usage_negative', file: SHD, find: 'Number.isFinite(v2) && v2 < usage)', to: 'Number.isFinite(v2))', expect: ['C6 containerMemoryBytes'], arms: [] },
  { id: 'M10b_v1_cache_above_usage_negative', file: SHD, find: 'Number.isFinite(v1) && v1 < usage)', to: 'Number.isFinite(v1))', expect: ['C6 containerMemoryBytes'], arms: [] },
  { id: 'M10c_v2_key_first', file: SHD, find: "  const v1 = Number(ms.stats?.total_inactive_file);\n  if (ms.stats?.total_inactive_file !== undefined && Number.isFinite(v1) && v1 < usage) return usage - v1;\n  const v2 = Number(ms.stats?.inactive_file);\n  if (ms.stats?.inactive_file !== undefined && Number.isFinite(v2) && v2 < usage) return usage - v2;", to: "  const v2 = Number(ms.stats?.inactive_file);\n  if (ms.stats?.inactive_file !== undefined && Number.isFinite(v2) && v2 < usage) return usage - v2;\n  const v1 = Number(ms.stats?.total_inactive_file);\n  if (ms.stats?.total_inactive_file !== undefined && Number.isFinite(v1) && v1 < usage) return usage - v1;", expect: ['C5 containerMemoryBytes'], arms: [] },
  { id: 'M11_unmeasured_guessed_zero', file: SHD, find: "    if (a.bytes === null) {\n      out.unmeasured += 1;", to: "    out.byWorkspace.set(a.wsId, out.byWorkspace.get(a.wsId) ?? 0);\n    if (a.bytes === null) {\n      out.unmeasured += 1;", expect: ['C7 buildAccounting'], arms: [] },
  { id: 'M12_bytes_not_summed', file: SHD, find: '(out.byWorkspace.get(a.wsId) ?? 0) + a.bytes', to: 'a.bytes', expect: ['C7 buildAccounting'], arms: ['known_magnitude'] },
  { id: 'M13_count_skips_unmeasured', file: SHD, find: "    out.countByWorkspace.set(a.wsId, (out.countByWorkspace.get(a.wsId) ?? 0) + 1);\n    if (a.bytes === null) {", to: "    if (a.bytes !== null) out.countByWorkspace.set(a.wsId, (out.countByWorkspace.get(a.wsId) ?? 0) + 1);\n    if (a.bytes === null) {", expect: ['C7 buildAccounting'], arms: [] },
  { id: 'M14_view_bytes_always_zero', file: SHD, find: 'return view.attributed.find((a) => a.wsId === wsId)?.bytes ?? 0;', to: 'return 0;', expect: ['C9 viewBytesFor', 'G1 groupSessionsByWorkspace'], arms: ['known_magnitude'] },
  { id: 'M15_unmeasured_reads_as_bytes', file: SHD, find: 'return a.unmeasured >= a.count ? undefined : a.bytes;', to: 'return a.bytes;', expect: ['C9 viewBytesFor'], arms: [] },
  { id: 'M16_view_unsorted', file: SHD, find: '.sort((a, b) => b.bytes - a.bytes || a.wsId.localeCompare(b.wsId));', to: '.sort((a, b) => a.wsId.localeCompare(b.wsId));', expect: ['C10 accountingView'], arms: [] },
  { id: 'M17_view_drops_unmeasured_ws', file: SHD, find: 'new Set([...acc.countByWorkspace.keys(), ...acc.byWorkspace.keys()])', to: 'new Set([...acc.byWorkspace.keys()])', expect: ['C10 accountingView'], arms: [] },
  { id: 'M18_unavailable_reads_as_zero', file: SHD, find: "if (view.docker === 'unavailable') return 'containers: Docker unavailable — not measured';", to: "if (view.docker === 'unavailable') return 'containers: 0 attributed · 0 unattributed';", expect: ['C11 formatContainersLine'], arms: ['docker_down_is_not_zero'] },
  { id: 'M19_never_touched_dropped', file: SHD, find: " — never touched`", to: "`", expect: ['C11 formatContainersLine'], arms: ['unattributed_visible'] },
  { id: 'M25_error_state_reads_as_ok', file: SHD, find: "  if (view.docker === 'error') return 'containers: accounting failed — not measured';\n", to: '', expect: ['C11 formatContainersLine'], arms: [] },
  // ── producer ──
  { id: 'M30_stats_for_unattributed_too', file: CA, find: 'await measure(attributed.map((a) => ({ ...a, api: apiOf.get(a.id) as DockerApi })), d);', to: 'await measure([...attributed, ...unattributed.map((u) => ({ id: u.id, name: u.name, wsId: u.id }))].map((a) => ({ ...a, api: apiOf.get(a.id) as DockerApi })), d);', expect: ['K3 AC'], arms: ['unattributed_visible'] },
  { id: 'M31_stats_even_with_no_attributed', file: CA, find: 'const measured = attributed.length === 0 ? [] : await measure(attributed.map((a) => ({ ...a, api: apiOf.get(a.id) as DockerApi })), d);', to: 'const measured = await measure(running.map((r) => ({ id: r.id, name: r.name, wsId: r.id, api: r.api })), d);', expect: ['K1 AC'], arms: ['no_stats_without_attributed'] },
  { id: 'M32_lists_stopped_containers', file: CA, find: "await api.listContainers({ status: ['running'] })", to: 'await api.listContainers({})', expect: ['K10 the daemon is asked'], arms: [] },
  { id: 'M33_stats_unbounded_concurrency', file: CA, find: 'Math.min(STATS_CONCURRENCY, attributed.length)', to: 'attributed.length', expect: ['K7 the pass is bounded'], arms: [] },
  { id: 'M34_no_pass_cap', file: CA, find: 'if (i >= MAX_STATS_PER_PASS) {', to: 'if (false) {', expect: ['K7 the pass is bounded'], arms: [] },
  { id: 'M35_one_stats_failure_aborts_the_pass', file: CA, find: "        d.warn(`container-accounting: stats of ${a.id.slice(0, 12)} (workspace ${a.wsId}) failed — counted unmeasured`, e);\n        out[i] = { wsId: a.wsId, bytes: null };", to: "        throw e;", expect: ['K6 a stats failure'], arms: [] },
  { id: 'M36_vanished_container_counted', file: CA, find: 'if (stats === null) out[i] = null;', to: 'if (stats === null) out[i] = { wsId: a.wsId, bytes: null };', expect: ['K6 a stats failure'], arms: [] },
  { id: 'M37_not_single_flight', file: CA, find: '  if (inflight) return inflight;\n', to: '', expect: ['K8 single-flight'], arms: [] },
  { id: 'M38_unavailable_keeps_stale_bytes', file: CA, find: "      current = emptyAccounting('unavailable', now);", to: "      current = { ...current, docker: 'unavailable', sampledAt: now };", expect: ['K5 Docker unreachable'], arms: ['docker_down_is_not_zero'] },
  { id: 'M39_unavailable_logged_every_tick', file: CA, find: "if (lastDocker !== 'unavailable') d.info(", to: 'if (true) d.info(', expect: ['K5 Docker unreachable'], arms: [] },
  { id: 'M40_unattributed_logged_every_tick', file: CA, find: '  if (key === lastUnattributedKey) return;\n', to: '', expect: ['K4 unattributed is logged once'], arms: [] },
  { id: 'M42_app_uses_a_member_relay_client', file: CA, find: 'return (sharedApi ??= createDockerApi());', to: "return (sharedApi ??= createDockerApi({ socketPath: process.env.DOCKER_HOST?.replace(/^unix:\\/\\//, '') ?? null }));", expect: ['W1 the producer'], arms: [] },
  { id: 'M43_member_pinned_daemons_ignored', file: CA, find: 'for (const extra of d.extraApis?.() ?? []) {', to: 'for (const extra of [] as DockerApi[]) {', expect: ['K11 a member whose relay'], arms: [] },
  { id: 'M44_same_socket_queried_twice', file: CA, find: 'if (p === null || seen.has(p)) continue;', to: 'if (p === null) continue;', expect: ['K11 a member whose relay'], arms: [] },
  { id: 'M45_one_daemon_down_is_all_down', file: CA, find: 'if (answered === 0) {', to: 'if (answered < apis.length) {', expect: ['K12 one daemon down'], arms: [] },
  { id: 'M46_refresh_error_keeps_stale_figures', file: CA, find: "      current = emptyAccounting('error', d.now());", to: '      void 0;', expect: ['K9 before any refresh'], arms: [] },
  { id: 'M47_partial_outage_warned_every_tick', file: CA, find: 'if (answered < apis.length && lastPartial !== true)', to: 'if (answered < apis.length)', expect: ['K12 one daemon down'], arms: [] },
  { id: 'M48_orphan_input_dropped', file: CA, find: 'classifyContainers(running, d.earliestLiveRunStartMs(), d.workspaceKnown, d.runKnown)', to: 'classifyContainers(running, d.earliestLiveRunStartMs(), undefined, d.runKnown)', expect: ['K13 a container labelled'], arms: ['unattributed_visible'] },
  // ── monitor wiring ──
  { id: 'M49_run_stamp_check_dropped', file: CA, find: 'd.workspaceKnown, d.runKnown)', to: 'd.workspaceKnown)', expect: ['K14 an orphan needs a run stamp'], arms: ['unattributed_visible'] },
  { id: 'M51_line_without_containers', file: MO, find: 'containers: d.containerView?.() ?? undefined,', to: 'containers: undefined,', expect: ['W2 the container pass'], arms: ['known_magnitude'] },
  { id: 'M52_production_timer_without_containers', file: MO, find: '  const deps = productionDeps();\n', to: '  const deps = { ...defaultDeps };\n', expect: ['W3 only the PRODUCTION timer'], arms: [] },
  { id: 'M53_default_deps_hit_docker', file: MO, find: "const defaultDeps: ResourceMonitorDeps = {\n  now: () => Date.now(),", to: "const defaultDeps: ResourceMonitorDeps = {\n  refreshContainers: async () => { await refreshContainerAccounting(realContainerAccountingDeps(earliestLiveRunStartMs)); },\n  now: () => Date.now(),", expect: ['W3 only the PRODUCTION timer'], arms: [] },
  { id: 'M55_pass_failure_breaks_the_tick', file: MO, find: "      d.warn('resources: container accounting pass failed', e);", to: '      throw e;', expect: ['W2 the container pass'], arms: [] },
  { id: 'M57_member_pinned_daemons_not_wired', file: MO, find: '    extraApis: memberPinnedApis,\n', to: '', expect: ['W4 the production deps feed the window'], arms: [] },
  // ── log line (pure) ──
  { id: 'M60_containers_folded_into_rss', file: SR, find: 'return containerBytes !== undefined ? { ...tree, containerBytes } : tree;', to: 'return containerBytes !== undefined ? { ...tree, rssBytes: tree.rssBytes + containerBytes, containerBytes } : tree;', expect: ['R-C1 the line carries'], arms: ['known_magnitude'] },
  { id: 'M61_containerbytes_guessed_zero', file: SR, find: 'const containerBytes = measuredContainerBytes(view, root.workspaceId);', to: 'const containerBytes = view ? (view.attributed.find((a) => a.wsId === root.workspaceId)?.bytes ?? 0) : undefined;', expect: ['R-C2 no accounting passed'], arms: ['docker_down_is_not_zero'] },
  { id: 'M62_containers_block_omitted', file: SR, find: '    ...(view ? { containers: view } : {}),\n', to: '', expect: ['R-C1 the line carries'], arms: ['known_magnitude'] },
  // ── page + bus-status ──
  { id: 'M70_snapshot_without_containers', file: RES, find: '    containers: accountingView(getContainerAccounting()),\n', to: '', expect: ['W5 the Resources page'], arms: [] },
  { id: 'M72b_busstatus_reads_twice', file: HK, find: 'containerLabels: Object.fromEntries(containersView.attributed.map(', to: 'containerLabels: Object.fromEntries(accountingView(getContainerAccounting()).attributed.map(', expect: ['W6 /busStatus'], arms: [] },
  { id: 'M24c_run_stamp_not_passed_to_workspace_known', file: SHD, find: 'workspaceKnown(ws, runLabel)', to: "workspaceKnown(ws, '')", expect: ['C16 classify'], arms: [] },
  { id: 'M71c_unmeasured_view_adds_bytes', file: SHD, find: "if (!view || !wsId || view.docker !== 'ok') return 0;", to: 'if (!view || !wsId) return 0;', expect: ['C9 viewBytesFor'], arms: [] },
  { id: 'M71_row_figure_without_containers', file: RS2, find: '(remote ? 0 : viewBytesFor(containers, key))', to: '0', expect: ['G1 groupSessionsByWorkspace'], arms: ['known_magnitude'] },
  { id: 'M71b_remote_row_gets_local_containers', file: RS2, find: '(remote ? 0 : viewBytesFor(containers, key))', to: 'viewBytesFor(containers, key)', expect: ['G2 groupSessionsByWorkspace'], arms: [] },
  { id: 'M71c_page_ignores_the_accounting', file: VIEW, find: 'groupSessionsByWorkspace(snap?.sessions ?? [], snap?.containers);', to: 'groupSessionsByWorkspace(snap?.sessions ?? []);', expect: ['W5 the Resources page'], arms: [] },
  // ── option A (D-pick4): structured agents on the page, the chip, the container-only row, the unattributed line ──
  { id: 'M74_sdk_session_not_classified', file: RS2, find: "if (id.endsWith(':sdk')) return { kind: 'sdk', workspaceId: id.slice(0, -4) };", to: '', expect: ['G4 (D-pick4 A)'], arms: [] },
  { id: 'M75_no_container_only_rows', file: RS2, find: "if (a.count > 0 && !byWs.has(a.wsId)) rows.push(", to: "if (false && !byWs.has(a.wsId)) rows.push(", expect: ['G3 (D-pick4 A)'], arms: [] },
  { id: 'M76_chip_when_docker_down', file: RS2, find: "const a = containers?.docker === 'ok' ? containers.attributed.find((x) => x.wsId === key) : undefined;", to: 'const a = containers ? containers.attributed.find((x) => x.wsId === key) : undefined;', expect: ['G3 (D-pick4 A)'], arms: [] },
  { id: 'M78_dead_keeper_gets_a_row', file: RS2, find: 'if (s.procCount > 0) out.push(s);', to: 'out.push(s);', expect: ['G5 (D-pick4 A)'], arms: [] },
  { id: 'M80b_chip_title_drops_unmeasured', file: SHD, find: "if (c.unmeasured >= c.count) return `${n} · not measured`;", to: '', expect: ['C18 containersChipTitle'], arms: [] },
  { id: 'M82b_unattributed_line_not_rendered', file: VIEW, find: 'warning={unattributedWarning(snap?.containers)}', to: 'warning={null}', expect: ['W8 (D-pick4 A)'], arms: [] },
  { id: 'M83b_container_chip_not_rendered', file: VIEW, find: '<SessionChips sessions={row.sessions} containers={row.containers} />', to: '<SessionChips sessions={row.sessions} />', expect: ['W8 (D-pick4 A)'], arms: [] },
  { id: 'M72_busstatus_without_containers', file: HK, find: '              containers: containersView,\n', to: '', expect: ['W6 /busStatus'], arms: [] },
  // ── the LEAD's memory escalation (FI-3.4) + verifier seat 2's two #289 pins (A21, C05) ──
  { id: 'M80_alert_row_always_zero', file: AHOST, find: 'unattributedContainers: () => getContainerAccounting().unattributed.count,', to: 'unattributedContainers: () => 0,', expect: ['WIRING'], arms: ['escalation_counts_it'] },
  { id: 'M84_now_line_shows_the_stale_reading', file: ALERT, find: 'nowAvailBytes: snap.availBytes === null ? null : snap.measured ? snap.availBytes : null,', to: 'nowAvailBytes: snap.availBytes,', expect: ['NOW line (A21'], arms: [] },
  { id: 'M85_banner_failure_not_rearmed', file: BANNER, find: "      rearm(snap ? watching(snap) : last.kind !== 'none');", to: '      void 0;', expect: ['PUBLISH failure path (C05)'], arms: [] },
  { id: 'M86_banner_snapshot_failure_not_rearmed', file: BANNER, find: "rearm(snap ? watching(snap) : last.kind !== 'none');", to: 'rearm(snap ? watching(snap) : false);', expect: ['PUBLISH failure path (C05)'], arms: [] },
  // ── pre-review #2 re-anchors / new (FI-3 v1.3: the window is liveFleetRuns over a real bus; untrusted store; partial outage; stale; per-state wording) ──
  { id: 'M20_every_run_counts', file: CW, find: 'for (const r of liveFleetRuns(db, deps)) {', to: "for (const r of db.prepare('SELECT id FROM runs').all() as Array<{ id: string }>) {", expect: ['CW1 the window starts'], arms: [] },
  { id: 'M21_no_bus_window_is_zero', file: CW, find: 'if (!db) return null;', to: 'if (!db) return 0;', expect: ['CW2 the window follows the fleet'], arms: [] },
  { id: 'M22_latest_run_instead_of_earliest', file: CW, find: 'min = min === null ? run.created_at : Math.min(min, run.created_at);', to: 'min = min === null ? run.created_at : Math.max(min, run.created_at);', expect: ['CW1 the window starts'], arms: [] },
  { id: 'M23_orphan_attributed_to_nobody', file: SHD, find: 'if (workspaceKnown && !workspaceKnown(ws, runLabel)) {', to: 'if (false) {', expect: ['C15 classify'], arms: ['unattributed_visible'] },
  { id: 'M24_orphan_needs_a_run_window', file: SHD, find: "    if (ws !== null) {\n      const runLabel", to: "    if (ws !== null && (since !== null || !workspaceKnown || workspaceKnown(ws, c.labels?.[DOCKER_LABEL_RUN] ?? ''))) {\n      const runLabel", expect: ['C15 classify'], arms: [] },
  { id: 'M24b_foreign_instance_container_reported', file: SHD, find: 'if (!runKnown || runKnown(runLabel)) unattributed.push(', to: 'if (true) unattributed.push(', expect: ['C16 classify'], arms: ['unattributed_visible'] },
  { id: 'M41_figure_accumulates_across_ticks', file: CA, find: '    current = buildAccounting(measured, unattributed, now, apis.length - answered);', to: '    const next = buildAccounting(measured, unattributed, now, apis.length - answered);\n    for (const [k, v] of next.byWorkspace) next.byWorkspace.set(k, v + (current.byWorkspace.get(k) ?? 0));\n    current = next;', expect: ['K2 positive control'], arms: ['known_magnitude'] },
  { id: 'M50_container_pass_unbounded', file: MO, find: "if ((await withBudget(d.refreshContainers(), budgetMs)) === 'budget') {", to: "if ((await d.refreshContainers().then(() => 'done')) === 'budget') {", expect: ['W2 the container pass'], arms: [] },
  { id: 'M50b_overrun_not_warned', file: MO, find: "=== 'budget') {\n        d.warn(`resources: container accounting pass exceeded", to: "=== 'never') {\n        d.warn(`resources: container accounting pass exceeded", expect: ['B1 the container pass is bounded'], arms: [] },
  { id: 'M50c_budget_injection_ignored', file: MO, find: 'const budgetMs = d.containerBudgetMs ?? CONTAINER_PASS_BUDGET_MS;', to: 'const budgetMs = CONTAINER_PASS_BUDGET_MS;', expect: ['B1 the container pass is bounded', 'W2 the container pass'], arms: [] },
  { id: 'M54_untrusted_store_attributes_everything', file: CW, find: ': runKnownIn(deps)(runId));', to: ': true);', expect: ['CW3 workspaceKnownIn'], arms: [] },
  { id: 'M54b_loaded_store_not_authoritative', file: CW, find: '(deps.storeReady() ? !!deps.getWorkspace(id) :', to: '(deps.storeReady() ? true :', expect: ['CW3 workspaceKnownIn'], arms: [] },
  { id: 'M56_foreign_run_known', file: CW, find: "return !!db && runId !== '' && getRun(db, runId) !== null;", to: "return !!db && runId !== '';", expect: ['CW4 runKnownIn'], arms: [] },
  { id: 'M59_run_stamp_predicate_not_wired', file: MO, find: '    runKnown: runKnownIn(windowDeps),\n', to: '', expect: ['W4 the production deps feed the window'], arms: [] },
  { id: 'M58_window_wired_to_keepers_again', file: MO, find: 'export const earliestLiveRunStartMs = (): number | null => earliestLiveFleetRunStart(windowDeps);', to: 'export const earliestLiveRunStartMs = (): number | null => (listKeeperRoots().length > 0 ? earliestLiveFleetRunStart(windowDeps) : null);', expect: ['W4 the production deps feed the window'], arms: [] },
  { id: 'M77_pty_tree_keeper_counted_twice', file: RS2, find: 'if (claimed.has(r.keeperPid)) continue;', to: '', expect: ['G5 (D-pick4 A)'], arms: [] },
  { id: 'M77b_keeper_dropped_whenever_a_pty_exists', file: RS2, find: 'if (claimed.has(r.keeperPid)) continue;', to: 'if (ptyRootPids.length > 0) continue;', expect: ['G5 (D-pick4 A)'], arms: [] },
  { id: 'M79_warning_when_docker_down', file: SHD, find: "if (!view || view.docker !== 'ok') return null;", to: 'if (!view) return null;', expect: ['C17 unattributedWarning'], arms: [] },
  { id: 'M79b_partial_outage_not_warned', file: SHD, find: 'if (view.daemonsDown > 0) parts.push(`${view.daemonsDown} Docker daemon(s) did not answer — container figures incomplete`);', to: '', expect: ['C19 (pre-review'], arms: [] },
  { id: 'M79c_partial_outage_not_in_the_line', file: SHD, find: 'if (view.daemonsDown > 0) parts.push(`${view.daemonsDown} Docker daemon(s) did not answer — figures incomplete`);', to: '', expect: ['C19 (pre-review'], arms: [] },
  { id: 'M79d_daemons_down_not_counted', file: CA, find: 'current = buildAccounting(measured, unattributed, now, apis.length - answered);', to: 'current = buildAccounting(measured, unattributed, now, 0);', expect: ['K12 one daemon down'], arms: [] },
  { id: 'M79e_stale_pass_read_as_current', file: CA, find: "if (current.docker === 'ok' && current.sampledAt !== null && now - current.sampledAt > ACCOUNTING_STALE_MS) return emptyAccounting('stale', current.sampledAt);", to: '', expect: ['K15 (pre-review'], arms: [] },
  { id: 'M79f_stale_limit_off_by_one', file: CA, find: 'now - current.sampledAt > ACCOUNTING_STALE_MS', to: 'now - current.sampledAt >= ACCOUNTING_STALE_MS', expect: ['K15 (pre-review'], arms: [] },
  { id: 'M81b_page_without_keeper_sessions', file: RES, find: 'const sessions = [...ptySessions, ...aggregateKeeperSessions(listKeeperRoots(), ptyList.flatMap((s) => (s.remote || s.pid === undefined ? [] : [s.pid])), table, cpuPcts)];', to: 'const sessions = ptySessions;', expect: ['W8 (D-pick4 A)'], arms: [] },
  { id: 'M81c_live_agents_tile_ignores_sdk', file: VIEW, find: "r.sessions.some((s) => s.kind === 'agent' || s.kind === 'sdk')", to: "r.sessions.some((s) => s.kind === 'agent')", expect: ['W8 (D-pick4 A)'], arms: [] },
  { id: 'M81d_first_container_pass_waits_a_tick', file: MO, find: "  if (deps.refreshContainers) void withBudget(deps.refreshContainers(), CONTAINER_PASS_BUDGET_MS).catch((e) => rlog.swallow('resource-monitor first container pass', e));\n", to: '', expect: ['W3 only the PRODUCTION timer'], arms: [] },
  { id: 'M81_docker_state_read_as_ok', file: AHOST, find: 'unattributedDocker: () => getContainerAccounting().docker,', to: "unattributedDocker: () => 'ok' as const,", expect: ['WIRING'], arms: ['escalation_counts_it'] },
  { id: 'M81e_daemons_down_not_wired_to_alert', file: AHOST, find: 'unattributedDaemonsDown: () => getContainerAccounting().daemonsDown,', to: '', expect: ['WIRING'], arms: [] },
  { id: 'M82_unreachable_prints_a_count', file: SALERT, find: "case 'unavailable': return 'unattributed containers not measured (Docker unreachable)';", to: "case 'unavailable': return `${f.unattributedContainers} unattributed container(s)`;", expect: ['BODY'], arms: ['escalation_counts_it'] },
  { id: 'M82b_not_sampled_says_unreachable', file: SALERT, find: "case 'not-sampled': return 'unattributed containers not measured yet (no monitor tick since the app started)';", to: "case 'not-sampled': return 'unattributed containers not measured (Docker unreachable)';", expect: ['BODY'], arms: [] },
  { id: 'M82c_stale_prints_a_count', file: SALERT, find: "    case 'stale': return 'unattributed containers not measured (the last Docker pass is too old)';\n", to: '', expect: ['BODY'], arms: [] },
  { id: 'M82d_partial_count_not_a_lower_bound', file: SALERT, find: "(f.unattributedDaemonsDown ?? 0) > 0 ?", to: 'false ?', expect: ['BODY'], arms: [] },
  { id: 'M83_alert_drops_the_docker_state', file: ALERT, find: 'unattributedDocker: deps.unattributedDocker ? deps.unattributedDocker() : undefined,', to: 'unattributedDocker: undefined,', expect: ['unmeasured): when the container accounting could not measure'], arms: [] },
  { id: 'M83c_alert_drops_daemons_down', file: ALERT, find: 'unattributedDaemonsDown: deps.unattributedDaemonsDown ? deps.unattributedDaemonsDown() : undefined,', to: 'unattributedDaemonsDown: undefined,', expect: ['partial outage): a daemon that did not answer'], arms: [] },
  { id: 'M73_cli_prints_no_line', file: CL, find: "process.stdout.write(`${formatContainersLine(res.containers as ContainerAccountingView, (id) => clabels[id] ?? id)}\\n`);", to: 'void clabels;', expect: ['W6 /busStatus'], arms: [] },
];
const TESTS = ['src/shared/container-accounting.test.ts', 'src/main/container-accounting.test.ts', 'src/main/container-accounting-wiring.test.ts', 'src/shared/resource-monitor.test.ts', 'src/shared/resources.test.ts', 'src/shared/memory-alert.test.ts', 'src/main/memory-alert.test.ts', 'src/main/memory-alert-wiring.test.ts', 'src/main/memory-banner.test.ts', 'src/main/container-window.test.ts', 'src/main/container-budget.test.ts'];
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(path.join(REPO, f))).digest('hex');
const sh = (cmd, a, opts = {}) => spawnSync(cmd, a, { cwd: REPO, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 600_000, ...opts });

function unitRed() {
  const r = sh(process.execPath, ['--test', '--experimental-strip-types', ...TESTS]);
  const names = [...(r.stdout ?? '').matchAll(/^not ok \d+ - (.*)$/gm)].map((m) => m[1]);
  const pass = Number(/^# pass (\d+)/m.exec(r.stdout ?? '')?.[1] ?? NaN);
  const skipped = Number(/^# skipped (\d+)/m.exec(r.stdout ?? '')?.[1] ?? NaN);
  return { names, pass, skipped, status: r.status };
}
function rigRed(arms) {
  if (noRig) return { arms: [], pass: 0, line: '(rig skipped)' };
  const env = { ...process.env, ...(arms && arms.length ? { RIG_ARMS: arms.join(',') } : {}) };
  const r = sh(process.execPath, ['--experimental-strip-types', '--import', pathToFileURL(path.join(HERE, '.r2-register.mjs')).href, path.join(HERE, 'e2e-container-memory.mjs')], { env });
  const out = r.stdout ?? '';
  return { arms: [...out.matchAll(/^FAIL (\w+)/gm)].map((m) => m[1]), pass: (out.match(/^PASS \w+/gm) ?? []).length, line: out.split('\n').filter((l) => l.startsWith('CONTAINER-MEMORY RIG')).pop() ?? `no summary (exit ${r.status}: ${(r.stderr ?? '').split('\n').slice(-2).join(' ')})` };
}

if (args.includes('--check-anchors')) { // dry check: does every mutant's find resolve exactly once on the CURRENT sources? (no mutation, no run)
  let bad = 0;
  for (const m of MUTANTS) {
    let text = fs.readFileSync(path.join(REPO, m.file), 'utf8'); let why = null;
    for (const e of [{ find: m.find, to: m.to }, ...(m.extra ?? [])]) { const c = text.split(e.find).length - 1; if (c !== 1) { why = `${c}× ${e.find.slice(0, 70)}`; break; } text = text.replace(e.find, () => e.to); }
    if (why) { bad++; console.log(`ANCHOR-BAD ${m.id}: ${why}`); }
  }
  console.log(`ANCHORS: ${MUTANTS.length - bad}/${MUTANTS.length} resolve exactly once`);
  process.exit(bad ? 1 : 0);
}

// ── guard: the tree must be committed (git diff is the independent restoration proof) ──
const files = [...new Set(MUTANTS.map((m) => m.file))];
const dirty = sh('git', ['diff', '--quiet', '--', ...files, ...TESTS, 'scripts/e2e-container-memory.mjs', 'scripts/container-memory-mutants.mjs']).status !== 0;
if (dirty) { console.error('REFUSING: the mutated files / suites / rig have uncommitted changes — commit first (the end-of-sweep `git diff` must prove restoration)'); process.exit(2); }
const before = Object.fromEntries(files.map((f) => [f, sha(f)]));
const BACKUP = fs.mkdtempSync(path.join(os.homedir(), '.cache', 'container-memory-mutants-'));   // private per sweep: two sweeps never share a backup

// ── POSITIVE CONTROL: the unmutated tree must be all green, else every "killed" below is vacuous ──
const needsRig = !noRig && MUTANTS.some((m) => (!only || only.has(m.id)) && m.arms.length > 0);
const base = unitRed();
const baseRig = needsRig ? rigRed() : { arms: [], pass: 5, line: '(rig not needed for the selected mutants)' };
console.log(`BASELINE unit: pass ${base.pass} fail ${base.names.length} skipped ${base.skipped} | rig: ${baseRig.line}`);
if (base.names.length || base.status !== 0 || base.skipped !== 0 || baseRig.arms.length || (needsRig && baseRig.pass !== 5)) { console.error('BASELINE NOT GREEN — aborting (nothing was mutated)'); process.exit(3); }

const rows = [];
let restoreBad = false;
const restore = (m, backupFile) => {
  fs.copyFileSync(backupFile, path.join(REPO, m.file));
  if (spawnSync('cmp', ['-s', backupFile, path.join(REPO, m.file)]).status !== 0) { restoreBad = true; console.error(`RESTORE FAILED for ${m.file} — stop and fix by hand: git checkout -- ${m.file}`); }
};
for (const m of MUTANTS) {
  if (only && !only.has(m.id)) continue;
  const abs = path.join(REPO, m.file);
  const original = fs.readFileSync(abs, 'utf8');
  let mutated = original; let anchorBad = null;
  for (const e of [{ find: m.find, to: m.to }, ...(m.extra ?? [])]) { const c = mutated.split(e.find).length - 1; if (c !== 1) { anchorBad = `find occurs ${c}× (need exactly 1): ${e.find.slice(0, 60)}`; break; } mutated = mutated.replace(e.find, () => e.to); }
  if (anchorBad) { rows.push({ id: m.id, verdict: 'ANCHOR-BAD', detail: anchorBad }); continue; }
  const backupFile = path.join(BACKUP, `${m.id}.orig`);
  fs.writeFileSync(backupFile, original);
  const onSig = () => { restore(m, backupFile); process.exit(130); };
  process.once('SIGINT', onSig); process.once('SIGTERM', onSig);
  try {
    fs.writeFileSync(abs, mutated);
    if (fs.readFileSync(abs, 'utf8') === original) { rows.push({ id: m.id, verdict: 'NO-OP', detail: 'the mutation changed nothing' }); continue; }
    const u = unitRed();
    const r = m.arms.length === 0 || noRig ? { arms: [] } : rigRed(m.arms);
    const red = [...u.names, ...r.arms.map((a) => `rig:${a}`)];
    // a rig-named mutant that the unit suite already killed still has to be killed by the NAMED expectation(s); the rig arm is reported separately
    const hit = m.expect.filter((e) => red.some((n) => n.includes(e)));
    const rigHit = m.arms.length === 0 || noRig ? null : m.arms.every((a) => r.arms.includes(a));
    rows.push({ id: m.id, verdict: hit.length > 0 ? 'KILLED' : red.length ? 'KILLED-BUT-NOT-BY-NAMED-ARM' : 'SURVIVED', detail: `named ${JSON.stringify(m.expect)} hit ${JSON.stringify(hit)}${rigHit === null ? '' : ` · rig ${rigHit ? 'RED' : 'GREEN'}(${m.arms.join(',')})`}; red: ${red.slice(0, 3).join(' | ')}${red.length > 3 ? ` (+${red.length - 3})` : ''}`, rigGreen: rigHit === false });
  } finally {
    restore(m, backupFile);
    process.removeListener('SIGINT', onSig); process.removeListener('SIGTERM', onSig);
  }
}
const after = Object.fromEntries(files.map((f) => [f, sha(f)]));
const sameSha = files.every((f) => before[f] === after[f]);
const gitClean = sh('git', ['diff', '--quiet', '--', ...files]).status === 0;
const post = unitRed();
const postRig = needsRig ? rigRed() : { arms: [], line: '(rig not run)' };
for (const r of rows) console.log(`${r.verdict.padEnd(30)} ${r.id.padEnd(40)} ${r.detail}`);
const killed = rows.filter((r) => r.verdict === 'KILLED').length;
const rigMiss = rows.filter((r) => r.rigGreen);
if (sameSha && gitClean && !restoreBad) fs.rmSync(BACKUP, { recursive: true, force: true });
console.log(`RESTORED: sha-identical ${sameSha} · git diff clean ${gitClean} · cmp-restore ${!restoreBad} · post-sweep unit fail ${post.names.length} rig ${postRig.line}`);
console.log(`MUTANTS: ${killed}/${rows.length} killed by their NAMED test${rows.length === killed ? '' : ` — NOT ALL: ${rows.filter((r) => r.verdict !== 'KILLED').map((r) => `${r.id}=${r.verdict}`).join(', ')}`}${rigMiss.length ? ` · rig stayed GREEN for: ${rigMiss.map((r) => r.id).join(', ')}` : ''}`);
process.exit(rows.length === killed && !rigMiss.length && sameSha && gitClean && !restoreBad && post.names.length === 0 && postRig.arms.length === 0 ? 0 : 1);
