// #330 self-gate — IN-PLACE mutation sweep of the resilient watchers. Each mutant edits ONE clause of the real source, runs the unit + wiring suites AND the NAMED composition-rig arms
// (scripts/e2e-resilient-watchers.mjs), and must turn red at least one NAMED test / rig check. Restored by byte-exact backup + `cmp` after every mutant; `git diff` of the mutated files must be empty at
// the end (commit first). A CLI-affecting mutant rebuilds dist-electron/cli.js (the instrument is rebuilt, never reused stale); the clean build is restored at the end.
// NOT heavy by the wave rule: no browser / app / keeper / scope / Docker — unit suites + the rig (one node process per arm + the built CLI). Survivors printed: stray rig processes + leftover scratch dirs.
// Run: node scripts/resilient-watchers-mutants.mjs [--only R01,R02] [--check-anchors] [--no-rig]
// `expect` = a substring of a reddened unit test title, or `rig:<arm>:<check>` (a failing rig check), or `rig:<arm>` (any check of that arm) — at least one MUST be red.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const BACKUP = path.join(os.homedir(), '.cache', 'h2-330', 'mutant-backup');
fs.mkdirSync(BACKUP, { recursive: true });
const args = process.argv.slice(2);
const only = args.includes('--only') ? new Set(args[args.indexOf('--only') + 1].split(',')) : null;
const noRig = args.includes('--no-rig');

const RW = 'src/shared/resilient-watch.ts';
const WS = 'src/shared/watcher-status.ts';
const WR = 'src/main/watchers.ts';
const WH = 'src/main/watchers-host.ts';
const BW = 'src/main/bus-wake.ts';
const PU = 'src/main/pause-ui-host.ts';
const PT = 'src/main/pause-trap.ts';
const HG = 'src/main/human-gates.ts';
const IT = 'src/main/inbox-tray.ts';
const ES = 'src/main/events-spool.ts';
const AU = 'src/main/account-usage.ts';
const IDX = 'src/main/index.ts';
const HS = 'src/main/hooks-server.ts';
const CLI = 'src/cli/index.ts';
const PRE = 'src/preload/index.ts';
const TESTS = ['src/shared/resilient-watch.test.ts', 'src/shared/watcher-status.test.ts', 'src/main/watchers.test.ts', 'src/main/watchers-wiring.test.ts', 'src/main/pause-ui-wiring.test.ts', 'src/main/bus-wake-watcher.test.ts'];
const ALL_ARMS = ['control', 'degraded', 'recovery', 'midlife', 'silent_detach', 'shutdown'];
const SITE_STOP = (id, file, find, to, name) => ({ id, file, find, to, expect: [`SITE ${name}`] });

const MUTANTS = [
  // ── the state machine (src/shared/resilient-watch.ts) ──
  { id: 'R01_no_retry_scheduled', file: RW, find: '    retryTimer = deps.setTimer(() => {\n      retryTimer = null;\n      arm();\n    }, delay);', to: '    void delay;', expect: ['at arm → degraded', 'rig:recovery:bus_status_clean_within_backoff'], rig: ['recovery'] },
  { id: 'R02_backoff_uncapped', file: RW, find: 'const delay = WATCH_BACKOFF_MS[Math.min(attempts - 1, WATCH_BACKOFF_MS.length - 1)];', to: 'const delay = 1_000 * 2 ** attempts;', expect: ['backoff is capped'] },
  { id: 'R03_backoff_never_grows', file: RW, find: 'const delay = WATCH_BACKOFF_MS[Math.min(attempts - 1, WATCH_BACKOFF_MS.length - 1)];', to: 'const delay = WATCH_BACKOFF_MS[0];', expect: ['backoff is capped'] },
  { id: 'R04_first_retry_slow', file: RW, find: '[1_000, 2_000, 5_000, 15_000, 30_000, 60_000];', to: '[20_000, 30_000, 60_000];', expect: ['first retry lands within a few seconds', 'rig:recovery:bus_status_clean_within_backoff'], rig: ['recovery'] },
  { id: 'R05_stop_keeps_retrying', file: RW, edits: [{ find: '      stopped = true;\n      clearTimers();\n      closeHandle();', to: '      stopped = true;\n      closeHandle();' }, { find: 'function arm(): void {\n    if (stopped) return;\n', to: 'function arm(): void {\n' }], expect: ['stop() cancels pending retries', 'rig:shutdown:no_retry_after_shutdown'], rig: ['shutdown'] },
  { id: 'R05b_stop_leaves_timers', file: RW, find: '      stopped = true;\n      clearTimers();\n      closeHandle();', to: '      stopped = true;\n      closeHandle();', expect: ['stop() cancels pending retries'] },
  { id: 'R06_stale_event_acts', file: RW, find: '          if (stopped || myGen !== gen) return;\n          if (spec.filter', to: '          if (stopped) return;\n          if (spec.filter', expect: ['a stale watch (closed, replaced) cannot act'] },
  { id: 'R07_stale_error_degrades', file: RW, find: "          if (stopped || myGen !== gen) return; // a stale watch's error is not this watch's", to: '          if (stopped) return;', expect: ['a stale watch (closed, replaced) cannot act'] },
  { id: 'R08_warn_every_failed_retry', file: RW, find: "    if (state !== 'degraded') {\n      state = 'degraded';", to: "    if (true) {\n      state = 'degraded';", expect: ['logging is edge-triggered', 'rig:recovery:log_one_warn_one_info_per_watcher'], rig: ['recovery'] },
  { id: 'R09_no_recovery_info', file: RW, find: '      deps.info(`watcher[${spec.name}]: RECOVERED after ${Math.round(downMs / 1000)} s — directory watch re-armed (${spec.label})`);', to: '      void downMs;', expect: ['logging is edge-triggered', 'rig:recovery:log_one_warn_one_info_per_watcher'], rig: ['recovery'] },
  { id: 'R10_no_catchup', file: RW, find: '        spec.onRecover?.(); // the catch-up pass: whatever was written while the watch was down', to: '        void 0;', expect: ['at arm → degraded', 'mid-life error event', 'rig:recovery:catchup_wake_delivered', 'rig:recovery:catchup_pause_ui_push'], rig: ['recovery'] },
  { id: 'R11_catchup_on_first_arm', file: RW, find: '    if (recovered) {\n      try {\n        spec.onRecover?.();', to: '    if (true) {\n      try {\n        spec.onRecover?.();', expect: ['healthy arm: stays ok'] },
  { id: 'R12_since_reset_each_failure', file: RW, find: "    if (state !== 'degraded') {\n      state = 'degraded';\n      since = deps.now();", to: "    since = deps.now();\n    if (state !== 'degraded') {\n      state = 'degraded';" , expect: ['`since` is stable'] },
  { id: 'R13_transition_every_failure', file: RW, find: '      transition();\n    }\n    const delay', to: '    }\n    transition();\n    const delay', expect: ['transitions: ok→degraded'] },
  { id: 'R14_lasterror_kept_after_recovery', file: RW, find: '      lastError = null;\n      attempts = 0;', to: '      attempts = 0;', expect: ['at arm → degraded'] },
  { id: 'R15_enospc_not_a_limit', file: RW, find: "if (info.code === 'EMFILE' || info.code === 'ENOSPC') return", to: "if (info.code === 'EMFILE') return", expect: ['describeWatchError / plainWatchError'] },
  { id: 'R16_ensuredir_dropped', file: RW, find: '      if (spec.ensureDir) deps.mkdirp?.(spec.dir);', to: '      void 0;', expect: ['ensureDir: the directory is created before EVERY arm'] },
  { id: 'R17_health_ignores_new_inode', file: RW, find: 'else if (armedIno !== null && ino !== armedIno) degrade(', to: 'else if (false) degrade(', expect: ['silent detach: the directory replaced', 'rig:silent_detach:rearmed_and_pushed'], rig: ['silent_detach'] },
  { id: 'R18_health_ignores_vanished_dir', file: RW, find: "if (ino === null) degrade({ code: 'ENOENT'", to: "if (false) degrade({ code: 'ENOENT'", expect: ['silent detach: the watched directory vanishing'] },
  { id: 'R19_health_not_rescheduled', file: RW, find: '      else scheduleHealth();', to: '      else void 0;', expect: ['silent detach: the directory replaced'] },
  { id: 'R20_transition_listener_failure_escapes', file: RW, find: '      deps.warn(`watcher[${spec.name}]: transition listener failed`, e);', to: '      throw e;', expect: ['a throwing catch-up'] },
  { id: 'R21_filter_ignored', file: RW, find: '          if (spec.filter && !spec.filter(filename)) return;', to: '          void 0;', expect: ['events reach onChange'] },
  { id: 'R22_persistent_not_forwarded', file: RW, find: 'spec.persistent === undefined ? undefined : { persistent: spec.persistent },', to: 'undefined,', expect: ['the persistent option is forwarded'] },
  { id: 'R23_health_period_ignored', file: RW, find: '    }, deps.healthMs ?? WATCH_HEALTH_MS);', to: '    }, WATCH_HEALTH_MS);', expect: ['healthMs dep shortens'] },
  { id: 'R24_dead_watch_not_closed', file: RW, find: '    if (stopped) return;\n    closeHandle();\n    if (healthTimer', to: '    if (stopped) return;\n    if (healthTimer', expect: ['mid-life error event'] },
  { id: 'R25_start_not_idempotent', file: RW, find: '      if (started || stopped) return;', to: '      if (stopped) return;', expect: ['start() twice arms ONCE'] },
  // ── what bus-status and the app say (src/shared/watcher-status.ts) ──
  { id: 'S01_summary_word_lowercase', file: WS, find: '· ${d.length} DEGRADED —', to: '· ${d.length} degraded —', expect: ['degraded: summary line names', 'rig:degraded:bus_status_lists_six_degraded'], rig: ['degraded'], cli: true },
  { id: 'S02_limit_never_named', file: WS, find: "${limit ? ' (system watch limit reached)' : ''}; the app re-arms by itself", to: "${limit ? '' : ''}; the app re-arms by itself", expect: ['degraded: summary line names', 'a non-limit degradation', 'rig:degraded:bus_status_names_the_system_limit'], rig: ['degraded'], cli: true },
  { id: 'S03_every_error_is_the_limit', file: WS, find: "const limit = d.some((w) => w.lastError?.code === 'EMFILE' || w.lastError?.code === 'ENOSPC');", to: 'const limit = true;', expect: ['a non-limit degradation'] },
  { id: 'S04_edge_key_counts_attempts', file: WS, find: '.map((w) => `${w.name}@${w.since}`)', to: '.map((w) => `${w.name}@${w.since}@${w.attempts}`)', expect: ['degradedOf / degradedLabels / degradedKey'] },
  { id: 'S05_labels_not_deduplicated', file: WS, find: '[...new Set(degradedOf(s).map((w) => w.label))]', to: 'degradedOf(s).map((w) => w.label)', expect: ['degradedOf / degradedLabels / degradedKey'] },
  { id: 'S06_healthy_prints_nothing', file: WS, find: 'if (d.length === 0) return [`watchers: ${total} ok`];', to: 'if (d.length === 0) return [];', expect: ['all ok → ONE calm line', 'rig:control:bus_status_all_ok'], rig: ['control'], cli: true },
  { id: 'S07_none_armed_silent', file: WS, find: "if (total === 0) return ['watchers: none armed'];", to: 'if (total === 0) return [];', expect: ['all ok → ONE calm line'] },
  { id: 'S08_fallback_not_named', file: WS, find: ' · meanwhile: ${w.fallback}`', to: '`', expect: ['degraded: summary line names'] },
  { id: 'S09_since_is_now', file: WS, find: 'DEGRADED since ${clock(w.since)} (', to: 'DEGRADED since ${clock(now)} (', expect: ['degraded: summary line names'] },
  { id: 'S10_warning_silent', file: WS, find: "  if (d.length === 0) return null;\n  return `${degradedLabels(s)", to: "  if (d.length === 0) return null;\n  return null;\n  return `${degradedLabels(s)", expect: ['watchersWarning'] },
  // ── the registry + production binding (src/main/watchers.ts) ──
  { id: 'W01_never_registered', file: WR, find: '      armed.add(handle);\n      inner.start();', to: '      inner.start();', expect: ['EMFILE at arm: bus-status data lists it degraded', 'rig:degraded:bus_status_lists_six_degraded'], rig: ['degraded'], cli: false },
  { id: 'W02_stop_keeps_registered', file: WR, find: '      armed.delete(handle); // first:', to: '      void 0; // first:', expect: ['stop() of a DEGRADED watcher clears', 'healthy watcher: listed as ok', 'rig:shutdown:registry_empty_after_shutdown'], rig: ['shutdown'] },
  { id: 'W03_push_not_edge_triggered', file: WR, find: '  if (key === lastPushedKey) return; // edge-triggered', to: '  void lastPushedKey; // edge-triggered', expect: ['healthy watcher: listed as ok, no push'] },
  { id: 'W04_push_on_wrong_channel', file: WR, find: "export const WATCHERS_UPDATE_CHANNEL = 'watchers:update';", to: "export const WATCHERS_UPDATE_CHANNEL = 'watchers:updated';", expect: ['the renderer push is the whole status', 'rig:degraded:renderer_told_once_per_degradation'], rig: ['degraded'] },
  { id: 'W05_listener_failure_escapes', file: WR, find: "      log.warn('watchers: a status listener failed', e);", to: '      throw e;', expect: ['a throwing push listener'] },
  { id: 'W06_stop_all_is_a_noop', file: WR, find: '  for (const w of [...armed]) w.stop();', to: '  void 0;', expect: ['stopAllWatchers() stops every', 'rig:shutdown:registry_empty_after_shutdown'], rig: ['shutdown'] },
  { id: 'W07_status_not_sorted', file: WR, find: '.sort((a, b) => a.name.localeCompare(b.name) || a.dir.localeCompare(b.dir)) };', to: ' };', expect: ['the status is sorted by name'] },
  { id: 'W08_fault_file_existence_ignored', file: WR, find: 'if (f && fs.existsSync(f)) throw', to: 'if (f) throw', expect: ['ORCHESTRA_WATCH_FAULT_FILE: while the file exists'] },
  { id: 'W09_retry_timer_holds_the_process', file: WR, find: '    t.unref?.(); // a pending retry must never keep the process alive (a CLI-less rig, a quit)\n', to: '', expect: ['the production retry timer is unref'] },
  { id: 'W10_no_health_check_in_production', file: WR, find: '  inodeOf,\n  get healthMs() {', to: '  get healthMs() {', expect: ['rig:silent_detach:rearmed_and_pushed'], rig: ['silent_detach'] },
  { id: 'W11_mkdirp_dep_missing', file: WR, find: '  mkdirp: (d) => void fs.mkdirSync(d, { recursive: true }),\n', to: '', expect: ['ensureDir creates a missing directory'] },
  { id: 'W12_error_event_not_wired', file: WR, find: '  w.on(\'error\', onError);\n', to: '', expect: ['rig:midlife:rearmed_and_caught_up', 'rig:midlife:error_event_has_a_listener'], rig: ['midlife'] },
  { id: 'W13_options_dropped_at_the_binding', file: WR, find: '(primitiveOverride ?? withFaultInjection(realWatch))(dir, onEvent, onError, opts)', to: '(primitiveOverride ?? withFaultInjection(realWatch))(dir, onEvent, onError)', expect: ['the primitive receives the site’s persistent option'] },
  // W14 (notifyIfChanged() at creation) was EQUIVALENT: a notify pushes only when the degraded-set key changed, and creating a watcher cannot change it — removed after the first sweep (ledger #329 c/…).
  // ── the seven sites: the catch-up on recovery, the stop, the filter, ensureDir ──
  { id: 'T01_busWake_no_catchup', file: BW, find: '    onRecover: () => void sweepBusWake(),\n', to: '', expect: ['SITE bus-wake', 'rig:recovery:catchup_wake_delivered'], rig: ['recovery'] },
  { id: 'T02_pauseUi_no_catchup', file: PU, find: '    onRecover: reconcilePauseUi,\n', to: '', expect: ['SITE pause-ui', 'rig:recovery:catchup_pause_ui_push'], rig: ['recovery'] },
  { id: 'T03_trap_no_catchup', file: PT, find: '    onRecover: () => {\n      if (activeDeps) void sweepPauseTrap(activeDeps);\n    },\n', to: '', expect: ['SITE pause-trap', 'rig:recovery:catchup_trap_stamped'], rig: ['recovery'] },
  { id: 'T04_gates_no_catchup', file: HG, find: '    onRecover: reconcileHumanGates,\n', to: '', expect: ['SITE human-gates', 'rig:recovery:catchup_gate_push'], rig: ['recovery'] },
  { id: 'T05_inbox_no_catchup', file: IT, find: '    onRecover: () => {\n      // a drain by the shell hook while the watch was down never retracted its chip: re-broadcast every live workspace\'s count\n      for (const ws of store.workspaces) if (!ws.archived) broadcastInbox(ws.id);\n    },\n', to: '', expect: ['SITE inbox-tray', 'rig:recovery:catchup_inbox_push'], rig: ['recovery'] },
  { id: 'T06_spool_no_catchup', file: ES, find: '    onRecover: drainAll,\n', to: '', expect: ['SITE events-spool'] },
  { id: 'T07_login_no_catchup', file: AU, find: '    onRecover: check,\n', to: '', expect: ['SITE login-watch'] },
  SITE_STOP('T08_busWake_stop_leaks', BW, '  watcher?.stop();\n  watcher = null;\n  started = false;', '  watcher = null;\n  started = false;', 'bus-wake'),
  SITE_STOP('T09_pauseUi_stop_leaks', PU, '  watcher?.stop();\n  watcher = null;', '  watcher = null;', 'pause-ui'),
  SITE_STOP('T10_trap_stop_leaks', PT, '  watcher?.stop();\n  watcher = null;\n  activeDeps = null;', '  watcher = null;\n  activeDeps = null;', 'pause-trap'),
  SITE_STOP('T11_gates_stop_leaks', HG, '  watcher?.stop();\n  watcher = null;\n}', '  watcher = null;\n}', 'human-gates'),
  SITE_STOP('T12_inbox_stop_leaks', IT, '  watcher?.stop();\n  watcher = null;\n}', '  watcher = null;\n}', 'inbox-tray'),
  SITE_STOP('T13_spool_stop_leaks', ES, '  if (watcher) {\n    watcher.stop();\n    watcher = null;\n  }', '  if (watcher) {\n    watcher = null;\n  }', 'events-spool'),
  SITE_STOP('T14_login_stop_leaks', AU, '      fsWatcher.stop();\n      fsWatcher = null;', '      fsWatcher = null;', 'login-watch'),
  { id: 'T15_busWake_filter_rejects_wal', file: BW, find: 'filter: (filename) => filename === null || filename === walName,', to: "filter: (filename) => filename === 'never',", expect: ['wakes on a cross-process WAL write', 'rig:control:wake_live_under_1s'], rig: ['control'] },
  { id: 'T16_pauseUi_filter_rejects', file: PU, find: 'filter: (filename) => !filename || filename === `${base}-wal` || filename === base,', to: 'filter: () => false,', expect: ['rig:control:pause_ui_live_under_1s'], rig: ['control'] },
  { id: 'T17_trap_filter_rejects', file: PT, find: 'filter: (filename) => filename === null || filename === walName || filename === path.basename(bus),', to: 'filter: () => false,', expect: ['rig:control:trap_live_under_1s'], rig: ['control'] },
  { id: 'T18_gates_filter_rejects', file: HG, find: 'filter: (filename) => !filename || filename === walName || filename === path.basename(bus),', to: 'filter: () => false,', expect: ['rig:control:human_gates_live_under_1s'], rig: ['control'] },
  { id: 'T19_inbox_filter_rejects', file: IT, find: "filter: (filename) => !!filename && filename.endsWith('.txt'),", to: 'filter: () => false,', expect: ['rig:control:inbox_live_under_1s'], rig: ['control'] },
  { id: 'T20_spool_ignores_events', file: ES, find: '      const id = idFromFilename(filename.toString());\n      if (id) drain(id);\n    },\n    onRecover', to: '      void 0;\n    },\n    onRecover', expect: ['rig:control:spool_events_applied_within_250ms_all_six'], rig: ['control'] },
  { id: 'T21_gates_ensuredir_dropped', file: HG, find: '    ensureDir: true,\n    // A null filename', to: '    // A null filename', expect: ['the sites that used to mkdir before watching'] },
  { id: 'T22_busWake_creates_the_bus_dir', file: BW, find: "    fallback: `${SWEEP_MS / 1000} s sweep`,\n", to: "    fallback: `${SWEEP_MS / 1000} s sweep`,\n    ensureDir: true,\n", expect: ['the sites that used to mkdir before watching'] },
  { id: 'T23_login_watch_persistent', file: AU, find: '    persistent: false,\n', to: '', expect: ['the transient login watch stays non-persistent'] },
  { id: 'T24_pauseUi_poke_dropped', file: PU, find: '    onChange: () => coalescer.poke(),', to: '    onChange: () => {},', expect: ['rig:control:pause_ui_live_under_1s'], rig: ['control'] },
  // ── plumbing: index.ts, /busStatus, the CLI, the preload, the pull channel ──
  { id: 'P01_index_never_subscribes_the_push', file: IDX, find: '  pushWatchersToRenderer();\n', to: '', expect: ['index.ts: the push is subscribed BEFORE'] },
  { id: 'P02_index_no_stop_all', file: IDX, find: '  stopAllWatchers(); // #330:', to: '  void 0; // #330:', expect: ['index.ts: the push is subscribed BEFORE'] },
  { id: 'P03_busstatus_no_watchers', file: HS, find: '              watchers: watchersStatus(),\n', to: '', expect: ['bus-status: the /busStatus payload', 'rig:control:bus_status_all_ok'], rig: ['control'] },
  { id: 'P04_cli_never_prints_watchers', file: CLI, find: "process.stdout.write(`${formatWatchersLines(res.watchers as WatchersStatus, Date.now()).join('\\n')}\\n`);", to: 'void 0;', expect: ['bus-status: the /busStatus payload', 'rig:control:bus_status_all_ok'], rig: ['control'], cli: true },
  { id: 'P05_preload_listens_on_the_wrong_channel', file: PRE, find: "ipcRenderer.on('watchers:update', listener);", to: "ipcRenderer.on('watchers:updat', listener);", expect: ['the renderer push is the whole status'] },
  { id: 'P06_pull_channel_renamed', file: WH, find: "export const WATCHERS_PULL_CHANNEL = 'watchers:status';", to: "export const WATCHERS_PULL_CHANNEL = 'watchers:statu';", expect: ['the renderer push is the whole status'] },
];

const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(path.join(REPO, f))).digest('hex');
const sh = (cmd, a, opts = {}) => spawnSync(cmd, a, { cwd: REPO, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 500_000, ...opts });

function unitRed() {
  const r = sh(process.execPath, ['--test', '--experimental-strip-types', ...TESTS]);
  const names = [...(r.stdout ?? '').matchAll(/^not ok \d+ - (.*)$/gm)].map((m) => m[1].replace(/\\([#])/g, '$1'));
  const pass = Number(/^# pass (\d+)/m.exec(r.stdout ?? '')?.[1] ?? NaN);
  const skipped = Number(/^# skipped (\d+)/m.exec(r.stdout ?? '')?.[1] ?? NaN);
  return { names, pass, skipped, status: r.status };
}
/** the rig's parent prints `FAIL <arm> (…) — name: note | name: note`; the failing checks become `rig:<arm>:<name>`, plus `rig:<arm>` for the arm */
function rigRed(arms) {
  if (noRig || !arms || arms.length === 0) return { red: [], pass: 0, line: '(rig not run)' };
  const r = sh(process.execPath, ['--experimental-strip-types', '--import', pathToFileURL(path.join(HERE, '.r2-register.mjs')).href, path.join(HERE, 'e2e-resilient-watchers.mjs')], { env: { ...process.env, RIG_ARMS: arms.join(',') } });
  const out = r.stdout ?? '';
  const red = [];
  for (const m of out.matchAll(/^FAIL (\w+) \([^)]*\)(?: — (.*))?$/gm)) {
    red.push(`rig:${m[1]}`);
    for (const part of (m[2] ?? '').split(' | ')) { const name = /^([a-z0-9_]+):/.exec(part)?.[1]; if (name) red.push(`rig:${m[1]}:${name}`); }
    if (!m[2]) red.push(`rig:${m[1]}:(no verdict)`);
  }
  return { red, pass: (out.match(/^PASS \w+/gm) ?? []).length, line: (out.split('\n').filter((l) => l.startsWith('RESILIENT WATCHERS')).pop() ?? `no summary (exit ${r.status})`) };
}
const buildCli = () => { const r = sh('pnpm', ['run', 'build:cli']); if (r.status !== 0) throw new Error(`build:cli failed: ${r.stderr}`); };
const strays = () => {
  const out = [];
  for (const n of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(n) || Number(n) === process.pid) continue;
    try { if (fs.readFileSync(`/proc/${n}/cmdline`, 'utf8').includes('e2e-resilient-watchers.mjs')) out.push(Number(n)); } catch { /* gone */ }
  }
  return out.length;
};
const scratchLeft = () => { try { return fs.readdirSync(path.join(os.homedir(), '.cache', 'e2e-rw')).length; } catch { return 0; } };

const editsOf = (m) => m.edits ?? [{ find: m.find, to: m.to }];
// a restore re-stamps the file: any mutant under src/shared or src/cli (the CLI bundle's inputs) makes the bundle STALE for the next mutant's rig — rebuild around it, always
for (const m of MUTANTS) if (m.file.startsWith('src/shared/') || m.file.startsWith('src/cli/')) m.cli = true;
if (args.includes('--check-anchors')) {
  let bad = 0;
  for (const m of MUTANTS) {
    let text = fs.readFileSync(path.join(REPO, m.file), 'utf8'); let why = null;
    for (const e of editsOf(m)) { const c = text.split(e.find).length - 1; if (c !== 1) { why = `${c}× ${e.find.slice(0, 80)}`; break; } text = text.replace(e.find, () => e.to); }
    if (why) { bad++; console.log(`ANCHOR-BAD ${m.id}: ${why}`); }
  }
  console.log(`ANCHORS: ${MUTANTS.length - bad}/${MUTANTS.length} resolve exactly once`);
  process.exit(bad ? 1 : 0);
}

const files = [...new Set(MUTANTS.map((m) => m.file))];
const dirty = sh('git', ['diff', '--quiet', '--', ...files, ...TESTS, 'scripts/e2e-resilient-watchers.mjs', 'scripts/resilient-watchers-mutants.mjs']).status !== 0;
if (dirty) { console.error('REFUSING: the mutated files / suites / rig have uncommitted changes — commit first (the end-of-sweep `git diff` must prove restoration)'); process.exit(2); }
const before = Object.fromEntries(files.map((f) => [f, sha(f)]));
buildCli();

// ── POSITIVE CONTROL: the unmutated tree must be all green (and the CLI fresh), else every "killed" below is vacuous ──
const base = unitRed();
const baseRig = rigRed(ALL_ARMS);
console.log(`BASELINE unit: pass ${base.pass} fail ${base.names.length} skipped ${base.skipped} | rig: ${baseRig.line} (pass ${baseRig.pass}, red ${JSON.stringify(baseRig.red)}) | strays ${strays()} scratch ${scratchLeft()}`);
if (base.names.length || base.status !== 0 || base.skipped !== 0 || (!noRig && (baseRig.red.length || baseRig.pass !== ALL_ARMS.length))) { console.error('BASELINE NOT GREEN — aborting (nothing was mutated)'); process.exit(2); }

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
  for (const e of editsOf(m)) { const c = mutated.split(e.find).length - 1; if (c !== 1) { anchorBad = `find occurs ${c}× (need exactly 1): ${e.find.slice(0, 60)}`; break; } mutated = mutated.replace(e.find, () => e.to); }
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
    const red = [...u.names, ...r.red];
    const hit = m.expect.filter((e) => red.some((n) => n.includes(e)));
    rows.push({ id: m.id, verdict: hit.length > 0 ? 'KILLED' : red.length ? 'KILLED-BUT-NOT-BY-NAMED-ARM' : 'SURVIVED', detail: `named ${JSON.stringify(m.expect)} hit ${JSON.stringify(hit)}; red: ${red.slice(0, 4).join(' | ')}${red.length > 4 ? ` (+${red.length - 4})` : ''}` });
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
for (const r of rows) console.log(`${r.verdict.padEnd(30)} ${r.id.padEnd(40)} ${r.detail}`);
const killed = rows.filter((r) => r.verdict === 'KILLED').length;
const sv = strays(); const sc = scratchLeft();
console.log(`RESTORED: sha-identical ${sameSha} · git diff clean ${gitClean} · cmp-restore ${!restoreBad} · post-sweep unit fail ${post.names.length} · survivors: rig processes=${sv} scratch dirs=${sc}`);
console.log(`MUTANTS: ${killed}/${rows.length} killed by their NAMED test/arm${rows.length === killed ? '' : ` — NOT ALL: ${rows.filter((r) => r.verdict !== 'KILLED').map((r) => `${r.id}=${r.verdict}`).join(', ')}`}`);
process.exit(rows.length === killed && sameSha && gitClean && !restoreBad && post.names.length === 0 && sv === 0 && sc === 0 ? 0 : 1);
