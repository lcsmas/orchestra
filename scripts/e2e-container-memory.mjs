// #293 (wave G, ledger #295; epic #284; contract FI-3) — container memory counted per workspace, unattributed containers reported — driven on the host's REAL dockerd.
// The real modules (container-accounting.ts → docker-api.ts on the real socket, the monitor's `sampleTick`) against REAL containers this rig creates and removes. HEAVY (a
// Docker stack): needs the heavy-rig token + MemAvailable > 9 GB (the rig refuses to start below 9 GB unless RIG_SKIP_MEMCHECK=1).
//
// SAFETY (D4): every container the rig creates carries `--label g9rig=<prefix>` and a `<prefix>-` name, and is removed BY ID (name prefix ∪ rig label ∪ orchestra.ws=<prefix>);
// the human's own stacks are only ever READ (`docker ps` before/after: ids + states must be identical); no real bus / ~/.claude* is touched (scratch HOME + ORCHESTRA_HOME);
// the real socket is used directly (never a relay); a stray (unattributed) container is NEVER stopped by the code under test — the rig asserts it is still running.
//
//   known_magnitude        ★ a labelled container holding ~200 MB (tmpfs) raises its workspace's measured memory by about that amount (baseline 0 → ~200 MB; a 2nd container SUMS)
//                            — through the real monitor tick (`containerBytes` on the workspace's session, `rssBytes` untouched) and the Resources-page fold
//   no_stats_without_attributed  ★ with only unlabelled / older containers (the host's bystander stacks included) the daemon is LISTED but NEVER asked for stats; control: an attributed
//                            container → exactly one stats call for it
//   unattributed_visible   ★ an unlabelled container created on the real socket AFTER the live run start, and a container stamped for a DELETED workspace (orphan), show as unattributed (counted, listed, the `containers:` line names them),
//                            the human's older containers do NOT, and the code under test never touches it (still running)
//   docker_down_is_not_zero  ★ no daemon at the socket → `docker: unavailable` (nothing measured, previous bytes dropped), not "0 containers"; the tick still completes
//   escalation_counts_it   ★ (AC3, FI-3.4; ~50 s: the alert's settle window is REAL) a stray container created on the real socket during a run is counted in the NEXT memory escalation the REAL alert host writes to the
//                            LEAD ("1 unattributed container(s)", no placeholder suffix); with Docker unreachable the next episode's row says "not measured", never "0"
//
// Run all: node --experimental-strip-types --import ./scripts/.r2-register.mjs scripts/e2e-container-memory.mjs   (RIG_REPO=<tree> = the must-FAIL run on master; RIG_ARMS=a,b subset)

import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { RIG_LOCK_PATH, RIG_LOCK_TIMEOUT_RC, RIG_LOCK_WAIT_S, armScratch, lockedArgv, newRigRunId, pruneOldRuns, rigRunId } from './rig-isolation.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(process.env.RIG_REPO ?? path.join(HERE, '..'));
const ARM = process.argv[2] ?? '';
const ARMS = ['known_magnitude', 'no_stats_without_attributed', 'unattributed_visible', 'docker_down_is_not_zero', 'escalation_counts_it'];
const MB = 1024 * 1024;
const RIG_BASE = path.resolve(process.env.CONTAINER_MEMORY_RIG_HOME ?? path.join(os.homedir(), '.cache', 'e2e-container-memory'));

function memAvailableGb() {
  try {
    const kb = Number(/MemAvailable:\s+(\d+) kB/.exec(fs.readFileSync('/proc/meminfo', 'utf8'))?.[1]);
    return kb / 1048576;
  } catch {
    return null;
  }
}

if (!ARM) {
  const gb = memAvailableGb();
  if (process.env.RIG_SKIP_MEMCHECK !== '1' && (gb === null || gb <= 9)) {
    console.error(`SAFETY: MemAvailable ${gb === null ? 'unreadable' : gb.toFixed(1) + ' GB'} — a Docker rig needs > 9 GB (heavy-rig rule D-tok2); set RIG_SKIP_MEMCHECK=1 only for a deliberate override`);
    process.exit(2);
  }
  const rows = [];
  const runId = newRigRunId();
  pruneOldRuns(RIG_BASE);
  const only = process.env.RIG_ARMS ? new Set(process.env.RIG_ARMS.split(',')) : null;
  for (const arm of ARMS) {
    if (only && !only.has(arm)) continue;
    const argv = lockedArgv(process.execPath, ['--experimental-strip-types', '--import', pathToFileURL(path.join(HERE, '.r2-register.mjs')).href, fileURLToPath(import.meta.url), arm]);
    const r = spawnSync(argv[0], argv.slice(1), { env: { ...process.env, RIG_RUN_ID: runId }, encoding: 'utf8', timeout: 240_000 + RIG_LOCK_WAIT_S * 1000 });
    const lastJson = (r.stdout ?? '').split('\n').reverse().find((l) => l.startsWith('{') && l.includes('"arm"'));
    let v = null;
    try { v = lastJson ? JSON.parse(lastJson) : null; } catch { /* below */ }
    rows.push({ arm, ok: v?.ok === true, detail: v ? (v.ok ? '' : v.why ?? v.abort ?? '') : r.status === RIG_LOCK_TIMEOUT_RC ? `rig lock ${RIG_LOCK_PATH} not acquired` : `no verdict (exit ${r.status}) ${(r.stderr ?? '').split('\n').slice(-3).join(' ')}` });
  }
  for (const r of rows) console.log(`${r.ok ? 'PASS' : 'FAIL'} ${r.arm}${r.detail ? ` — ${r.detail}` : ''}`);
  const red = rows.filter((r) => !r.ok);
  if (red.length === 0) fs.rmSync(path.join(RIG_BASE, runId), { recursive: true, force: true });
  console.log(`CONTAINER-MEMORY RIG: ${red.length === 0 ? 'ALL PASS' : `RED ${red.map((r) => r.arm).join(',')}`} (${rows.length - red.length}/${rows.length})${only ? ' PARTIAL(RIG_ARMS)' : ''} tree ${REPO}`);
  process.exit(red.length === 0 ? 0 : 1);
}
if (!ARMS.includes(ARM)) { console.error(`unknown arm: ${ARM} (expected: ${ARMS.join(', ')})`); process.exit(2); }

// ── SAFETY: scratch HOME / ORCHESTRA_HOME under ~/.cache, never near a live dir ──
const REAL_HOME = os.homedir();
const tmpHome = armScratch(RIG_BASE, rigRunId(), ARM);
const live = [path.join(REAL_HOME, '.orchestra'), path.join(REAL_HOME, '.claude'), path.join(REAL_HOME, '.claude-mc'), path.join(REAL_HOME, '.config')];
if (!(tmpHome + path.sep).startsWith(path.join(REAL_HOME, '.cache') + path.sep) || live.some((l) => (tmpHome + path.sep).startsWith(l + path.sep) || l.startsWith(tmpHome + path.sep))) {
  console.error(`SAFETY: refusing scratch path ${tmpHome}`); process.exit(2);
}
fs.rmSync(tmpHome, { recursive: true, force: true });
fs.mkdirSync(path.join(tmpHome, '.orchestra'), { recursive: true });
const dockerHostBefore = process.env.DOCKER_HOST;
for (const k of Object.keys(process.env)) if (/^(ORCHESTRA_|CLAUDE_CONFIG_DIR|CLAUDECODE|CLAUDE_CODE_|DOCKER_HOST)/.test(k)) delete process.env[k];   // the REAL socket: a relay-inherited DOCKER_HOST must not leak in
process.env.ORCHESTRA_HOME = path.join(tmpHome, '.orchestra');
process.env.HOME = tmpHome;
process.env.CLAUDE_CONFIG_DIR = path.join(tmpHome, '.claude-scratch');
fs.mkdirSync(process.env.CLAUDE_CONFIG_DIR, { recursive: true });
// docker/compose read their config from $HOME — keep the user's (contexts!) for the ground-truth CLI, never for the code under test
const DOCKER_ENV = { ...process.env, HOME: REAL_HOME };
delete DOCKER_ENV.DOCKER_HOST;
void dockerHostBefore;

const out = { arm: ARM, tree: REPO };
const fails = [];
let ID = randomBytes(4).toString('hex');
const PFX = `g9r${ID}`;
const RIG_LABEL = 'g9rig';
const WS = PFX; // rig-unique workspace id
const dk = (args, timeout = 90_000) => {
  const r = spawnSync('docker', args, { env: DOCKER_ENV, encoding: 'utf8', timeout });
  return { code: r.status ?? -1, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() };
};
const idsBy = (filter) => dk(['ps', '-a', '-q', '--no-trunc', '--filter', filter]).out.split('\n').filter(Boolean);
const mineIds = () => [...new Set([`name=^${PFX}`, `label=${RIG_LABEL}=${PFX}`, `label=orchestra.ws=${PFX}`].flatMap(idsBy))];
const bystanders = () => {
  const own = new Set(mineIds());
  return dk(['ps', '-a', '--no-trunc', '--format', '{{.ID}} {{.Names}} {{.State}}']).out.split('\n').filter((l) => l && !own.has(l.split(' ')[0])).sort();
};
const BEFORE = bystanders();
const cleanup = () => {
  const ids = mineIds();
  if (ids.length) dk(['rm', '-f', '-v', ...ids]);
};
const verdict = (extra = {}) => {
  cleanup();
  const leaked = mineIds();
  if (leaked.length) fails.push(`LEAK: ${leaked.length} rig container(s) survived cleanup`);
  // bystanders: the host is SHARED with the live app's fleet, whose agents start and stop their own containers all day — a before/after diff proves nothing about OUR code (it flagged an unrelated
  // agent's container). What proves "the code under test touched nothing" is (a) the seam spy (zero stop/start calls, asserted per arm) and (b) DockerApi has no other mutating method; this is
  // recorded for the reader, never a verdict.
  const AFTER = bystanders();
  out.bystander_churn_on_the_shared_host = BEFORE.filter((l) => !AFTER.includes(l)).length + AFTER.filter((l) => !BEFORE.includes(l)).length;
  console.log(JSON.stringify({ ...out, ...extra, ok: fails.length === 0, ...(fails.length ? { why: fails.join(' | ') } : {}) }));
  process.exit(fails.length === 0 ? 0 : 1);
};
setTimeout(() => { fails.push('deadline: the arm hung'); verdict(); }, ARM === 'escalation_counts_it' ? 280_000 : 200_000).unref?.();
process.on('SIGTERM', () => { cleanup(); process.exit(143); });
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function check(name, got, want) { const ok = eq(got, want); out[name] = got; if (!ok) fails.push(`${name}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`); return ok; }
function within(name, got, lo, hi) { const ok = typeof got === 'number' && got >= lo && got <= hi; out[name] = got; if (!ok) fails.push(`${name}: got ${got} want [${lo}, ${hi}]`); return ok; }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (pred, ms = 30_000, step = 250) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await pred()) return true; await sleep(step); } return false; };

if (dk(['version', '--format', '{{.Server.Version}}']).code !== 0) { console.error('rig fault: no Docker daemon answers `docker version`'); process.exit(3); }

// a fresh install has no store.json (load() then leaves loadedFromDisk=false); the fleet the escalation arm seeds is an EXISTING install
const STORE_FILE = path.join(tmpHome, 'orchestra', 'store.json');
fs.mkdirSync(path.dirname(STORE_FILE), { recursive: true });
fs.writeFileSync(STORE_FILE, JSON.stringify({ repos: [], workspaces: [], accounts: [], selfTuneRuns: [] }));

// ── the code under test (absent on master → the arms read RED) ──
let acc = null, dockerApi = null, shared = null, monitor = null;
try {
  acc = await import(`${REPO}/src/main/container-accounting.ts`);
  dockerApi = await import(`${REPO}/src/main/docker-api.ts`);
  shared = await import(`${REPO}/src/shared/container-accounting.ts`);
} catch (e) {
  fails.push(`the container-accounting feature is absent in ${REPO}: ${String(e?.message ?? e).split('\n')[0]}`);
  verdict({ absent: true });
}
const { initPlatform } = await import(`${REPO}/src/main/platform/index.ts`);
initPlatform({
  kind: 'headless-e2e-container-memory', broadcast: () => {}, broadcastPtyData: () => true, canBroadcast: () => true, isFocused: () => false, hasAttachedUi: () => false, notify: () => {},
  openExternal: () => {}, showItemInFolder: () => {}, openPath: () => {}, openAccountLoginUrl: () => {}, closeAccountLogin: () => {},
  getUserDataDir: () => tmpHome, getLogsDir: () => `${tmpHome}/logs`, getAppVersion: () => '0.0.0-e2e-container-memory', getAppMetrics: () => [],
  isEncryptionAvailable: () => false, encryptString: (s) => s, decryptString: (s) => s,
});
(await import(`${REPO}/src/main/logger.ts`)).initLogger();
monitor = await import(`${REPO}/src/main/resource-monitor.ts`);

// the real client on the real socket, optionally wrapped to count calls (the AC "no stats call" is counted at the seam the daemon is reached through)
const calls = { list: 0, stats: [], stop: [], start: [] };
const spyApi = (real) => ({
  ...real,
  listContainers: (o) => { calls.list += 1; return real.listContainers(o); },
  containerStats: (id) => { calls.stats.push(id); return real.containerStats(id); },
  // "never touched" is checked at the seam too: the code under test must not even TRY to stop or start anything
  stopContainer: (id, t) => { calls.stop.push(id); return real.stopContainer(id, t); },
  startContainer: (id) => { calls.start.push(id); return real.startContainer(id); },
});
const realApi = dockerApi.createDockerApi();   // no pinned socket: resolved like the app does (own DOCKER_HOST scrubbed above → /var/run/docker.sock or the active context)
let runStartMs = Date.now() - 60_000;           // the (fake) earliest live fleet run: a minute ago
const mkDeps = (api) => ({ api, earliestLiveRunStartMs: () => runStartMs, workspaceKnown: (id) => id === WS, runKnown: (r) => r === `${PFX}-run`, now: () => Date.now(), info: (m) => out.log = [...(out.log ?? []), `info: ${m}`].slice(-6), warn: (m) => out.log = [...(out.log ?? []), `warn: ${m}`].slice(-6) });

/** One REAL monitor tick: the real `sampleTick` with a fake /proc (no sessions) and the container pass on the real socket. Returns the JSONL line it logged. */
async function tick(api) {
  const lines = [];
  const cad = mkDeps(api);
  const base = monitor.realResourceMonitorDeps();
  const line = await monitor.sampleTick({
    ...base,
    procTable: async () => [],
    keeperRoots: () => [{ workspaceId: WS, keeperPid: 999_999 }],
    keeperProcs: () => [],
    trackedKeeperPid: () => null,
    liveWorkspaceIds: () => new Set([WS]),
    statusFor: () => 'idle',
    storeLoadedFromDisk: () => false,   // the reaper refuses (absence is not proof) — it must not act in a rig
    electronProcs: () => [],
    memUsedBytes: () => null,
    appendLine: (l) => lines.push(l),
    refreshContainers: async () => { await acc.refreshContainerAccounting(cad); },
    containerView: () => shared.accountingView(acc.getContainerAccounting()),
  });
  return line;
}
/** The ground truth, computed with the docker CLI and NOT with the code under test: running containers carrying NO orchestra.ws label, created at/after the (fake) run start. The host is shared with
 *  the live app's fleet, so other agents' containers come and go — the assertions compare against this, never against "just mine". */
function oracleUnattributed(sinceMs) {
  const ids = dk(['ps', '-q', '--no-trunc']).out.split('\n').filter(Boolean);
  if (!ids.length) return [];
  const rows = dk(['inspect', '-f', '{{.Id}}|{{.Created}}|{{index .Config.Labels "orchestra.ws"}}', ...ids]).out.split('\n').filter(Boolean).map((l) => l.split('|'));
  const since = Math.floor(sinceMs / 1000);
  // docker's template prints `<no value>` for a label the container lacks (not an empty string) — the first version of this oracle took it for a value and listed NOTHING
  const unlabelled = (ws) => !ws || ws === '<no value>';
  return rows.filter(([, created, ws]) => unlabelled(ws) && Math.floor(new Date(created).getTime() / 1000) >= since).map(([id]) => id).sort();
}
const run = (name, labels, memMb) =>
  // a container whose memory footprint is KNOWN: memMb MB written into a tmpfs (shmem is charged to the container's cgroup and is not reclaimable page cache)
  dk(['run', '-d', '--name', `${PFX}-${name}`, '--label', `${RIG_LABEL}=${PFX}`, ...labels.flatMap((l) => ['--label', l]), ...(memMb ? ['--tmpfs', `/m:rw,size=${memMb + 200}m`] : []), 'alpine:3', 'sh', '-c',
    memMb ? `dd if=/dev/zero of=/m/f bs=1M count=${memMb} 2>/dev/null; echo ready; exec sleep 3600` : 'echo ready; exec sleep 3600']);
const ready = (name) => until(() => dk(['logs', `${PFX}-${name}`]).out.includes('ready'), 40_000);

// ═══════════════════════════════════════════════════════════════════════════════════════════════
if (ARM === 'known_magnitude') {
  const spy = spyApi(realApi);
  const t0 = await tick(spy);
  check('baseline_tick_measured_zero_containers_for_the_workspace', [t0.sessions[0].containerBytes, t0.sessions[0].rssBytes], [0, 0]);
  const baselineAttrib = t0.containers.attributed.find((a) => a.wsId === WS)?.bytes ?? 0;
  const c1 = run('known', [`orchestra.ws=${WS}`, `orchestra.run=${PFX}-run`], 200);
  check('control_container_started', c1.code, 0);
  check('control_container_ready', await ready('known'), true);
  const t1 = await tick(spy);
  const b1 = t1.sessions[0].containerBytes;
  out.bytes_after_first_container = b1;
  within('workspace_memory_rises_by_about_200MB', b1 - baselineAttrib, 190 * MB, 230 * MB);
  check('process_rss_is_untouched', t1.sessions[0].rssBytes, 0);
  check('line_lists_the_workspace_in_the_containers_block', t1.containers.attributed.find((a) => a.wsId === WS)?.count, 1);
  const c2 = run('second', [`orchestra.ws=${WS}`], 100);
  check('second_container_started', c2.code, 0);
  check('second_container_ready', await ready('second'), true);
  const t2 = await tick(spy);
  within('a_second_container_SUMS_to_about_300MB', t2.sessions[0].containerBytes - baselineAttrib, 285 * MB, 345 * MB);
  check('count_is_now_two', t2.containers.attributed.find((a) => a.wsId === WS)?.count, 2);
  // the page fold, through the SAME pure function ResourcesView renders from: the owning workspace's existing row figure = process memory + its containers
  const resources = await import(`${REPO}/src/shared/resources.ts`);
  const pageSession = { ptyId: WS, workspaceId: WS, kind: 'agent', remote: false, cpuPct: 1, memBytes: 50 * MB, procCount: 3, processes: [] };
  within('page_row_is_process_plus_containers', resources.groupSessionsByWorkspace([pageSession], shared.accountingView(acc.getContainerAccounting())).rows[0].memBytes, 50 * MB + 285 * MB, 50 * MB + 345 * MB);
  check('page_row_without_the_accounting_is_the_process_figure', resources.groupSessionsByWorkspace([pageSession], null).rows[0].memBytes, 50 * MB);
  // gone → back to zero (the figure follows the container, it does not accumulate)
  dk(['rm', '-f', '-v', `${PFX}-known`, `${PFX}-second`]);
  const t3 = await tick(spy);
  check('after_removal_the_workspace_returns_to_zero', t3.sessions[0].containerBytes, 0);
  verdict();
}

if (ARM === 'no_stats_without_attributed') {
  // the host's own bystander stacks are RUNNING and older than the (fake) run start; a rig container without the label is created BEFORE the run start too
  const bystanderRunning = dk(['ps', '-q']).out.split('\n').filter(Boolean).length;
  out.bystander_running_containers = bystanderRunning;
  const plain = run('plain', [], 0);
  check('unlabelled_container_started', plain.code, 0);
  check('unlabelled_container_ready', await ready('plain'), true);
  runStartMs = Date.now() + 120_000;   // the "live run" starts AFTER everything that exists → nothing is unattributed, nothing is attributed
  const spy = spyApi(realApi);
  const t0 = await tick(spy);
  check('daemon_was_listed', calls.list >= 1, true);
  check('NO_stats_call_without_an_attributed_container', calls.stats.length, 0);
  check('nothing_attributed_nothing_unattributed', [t0.containers.attributed.length, t0.containers.unattributed.count, t0.containers.docker], [0, 0, 'ok']);
  // control: the instrument CAN see a stats call — an attributed container makes exactly one, for that container only
  const att = run('att', [`orchestra.ws=${WS}`], 20);
  check('attributed_container_started', att.code, 0);
  check('attributed_container_ready', await ready('att'), true);
  const attId = dk(['inspect', '-f', '{{.Id}}', `${PFX}-att`]).out;
  calls.stats.length = 0;
  await tick(spy);
  check('control_exactly_one_stats_call_and_it_is_the_attributed_container', calls.stats, [attId]);
  verdict();
}

if (ARM === 'unattributed_visible') {
  runStartMs = Date.now() - 2_000;     // the live run began just now; the host's older stacks predate it
  const spy = spyApi(realApi);
  // the host is shared with the live app's fleet: other agents' containers come and go, so every set is compared with the INDEPENDENT docker-CLI oracle, bracketed around the tick
  const bracket = async (name) => {
    const before = oracleUnattributed(runStartMs);
    const t = await tick(spy);
    const after = oracleUnattributed(runStartMs);
    out[`${name}_detail`] = { accounted: t.containers.unattributed.names, oracleBefore: before.map((i) => i.slice(0, 12)), oracleAfter: after.map((i) => i.slice(0, 12)), accountedIds: t.containers.unattributed.ids.map((i) => i.slice(0, 12)) };
    // a container other agents stop between the tick and the 2nd oracle read is in `before` only: the set the tick saw lies between the two oracle reads (union as the upper bound)
    check(name, [before.every((i) => t.containers.unattributed.ids.includes(i) || !after.includes(i)), t.containers.unattributed.ids.every((i) => before.includes(i) || after.includes(i))], [true, true]);
    return t;
  };
  const t0 = await bracket('control_unattributed_set_matches_the_oracle_before_the_stray');
  check('control_no_older_container_is_unattributed', t0.containers.unattributed.ids.filter((i) => !oracleUnattributed(0).includes(i)), []);
  await sleep(1100);                   // docker `Created` has 1 s resolution: the stray must land at/after the run start second
  const stray = run('stray', [], 0);   // NO orchestra.ws label, created on the REAL socket during the run
  check('stray_started', stray.code, 0);
  check('stray_ready', await ready('stray'), true);
  const strayId = dk(['inspect', '-f', '{{.Id}}', `${PFX}-stray`]).out;
  // an ATTRIBUTED container beside it, so a stats pass really runs: the stray must still get no stats call (a pass over only-unattributed containers never starts)
  const att = run('att', [`orchestra.ws=${WS}`], 10);
  check('attributed_neighbour_started', att.code, 0);
  check('attributed_neighbour_ready', await ready('att'), true);
  const attId = dk(['inspect', '-f', '{{.Id}}', `${PFX}-att`]).out;
  calls.stats.length = 0;
  const t1 = await bracket('unattributed_set_matches_the_oracle_with_the_stray');
  check('the_pass_measured_the_attributed_neighbour_and_never_the_stray', [calls.stats.includes(attId), calls.stats.includes(strayId)], [true, false]);
  check('stray_is_counted_unattributed', t1.containers.unattributed.ids.includes(strayId), true);
  check('stray_is_named', t1.containers.unattributed.names.includes(`${PFX}-stray`), true);
  const line = shared.formatContainersLine(t1.containers, (id) => id);
  out.bus_status_line = line;
  check('bus_status_line_names_it_and_says_never_touched', [line.startsWith('containers: '), line.includes(`${PFX}-stray`), line.includes('never touched')], [true, true, true]);
  // an ORPHAN: a container stamped for a workspace that does not exist (a deleted workspace's container keeps running) — unattributed whatever its age, never touched
  const orphan = run('orphan', [`orchestra.ws=${PFX}-gone`, `orchestra.run=${PFX}-run`], 0);
  check('orphan_started', orphan.code, 0);
  check('orphan_ready', await ready('orphan'), true);
  const orphanId = dk(['inspect', '-f', '{{.Id}}', `${PFX}-orphan`]).out;
  // …and a container stamped by ANOTHER Orchestra instance sharing this daemon (unknown workspace AND unknown run): not ours — neither attributed nor reported
  const foreign = run('foreign', [`orchestra.ws=${PFX}-elsewhere`, `orchestra.run=${PFX}-other-run`], 0);
  check('foreign_started', foreign.code, 0);
  check('foreign_ready', await ready('foreign'), true);
  const foreignId = dk(['inspect', '-f', '{{.Id}}', `${PFX}-foreign`]).out;
  const tOrphan = await tick(spy);
  check('orphan_is_unattributed_and_named_as_such', [tOrphan.containers.unattributed.ids.includes(orphanId), tOrphan.containers.unattributed.names.includes(`${PFX}-orphan (orphan of ${PFX}-gone)`)], [true, true]);
  check('orphan_is_not_attributed_to_the_deleted_workspace', tOrphan.containers.attributed.some((a) => a.wsId === `${PFX}-gone`), false);
  check('another_instances_container_is_ignored_entirely', [tOrphan.containers.unattributed.ids.includes(foreignId), tOrphan.containers.attributed.some((a) => a.wsId === `${PFX}-elsewhere`)], [false, false]);
  // NEVER touched: after several more ticks the stray, the orphan and the foreign container are still running, same ids, and no stop/start was even attempted
  for (let i = 0; i < 2; i++) await tick(spy);
  check('stray_never_touched_still_running', dk(['inspect', '-f', '{{.State.Running}}', `${PFX}-stray`]).out, 'true');
  check('orphan_never_touched_still_running', dk(['inspect', '-f', '{{.State.Running}}', `${PFX}-orphan`]).out, 'true');
  check('foreign_never_touched_still_running', dk(['inspect', '-f', '{{.State.Running}}', `${PFX}-foreign`]).out, 'true');
  check('no_stats_call_for_the_stray_the_orphan_or_the_foreign_one', [calls.stats.includes(strayId), calls.stats.includes(orphanId), calls.stats.includes(foreignId)], [false, false, false]);
  check('no_stop_or_start_call_was_even_attempted', [calls.stop, calls.start], [[], []]);
  // no live run → it cannot be "created during a run" (the orphan needs none)
  runStartMs = null;
  const t2 = await tick(spy);
  check('without_a_live_run_the_stray_is_not_unattributed_but_the_orphan_still_is', [t2.containers.unattributed.ids.includes(strayId), t2.containers.unattributed.ids.includes(orphanId)], [false, true]);
  verdict();
}

if (ARM === 'docker_down_is_not_zero') {
  const dead = dockerApi.createDockerApi({ socketPath: path.join(tmpHome, 'no-daemon.sock') });
  // seed the accounting with a real figure first, so "dropped, not stale" is observable
  const c1 = run('seed', [`orchestra.ws=${WS}`], 50);
  check('seed_container_started', c1.code, 0);
  check('seed_container_ready', await ready('seed'), true);
  const up = await tick(realApi);
  within('seed_bytes_measured', up.sessions[0].containerBytes, 40 * MB, 80 * MB);
  const down = await tick(dead);
  check('docker_unavailable_is_reported_as_such', down.containers.docker, 'unavailable');
  check('previous_bytes_are_dropped_not_kept_stale', [down.containers.attributed.length, 'containerBytes' in down.sessions[0]], [0, false]);
  check('the_tick_still_completed_and_logged', typeof down.at, 'number');
  check('bus_status_line_says_not_measured', shared.formatContainersLine(down.containers, (i) => i), 'containers: Docker unavailable — not measured');
  verdict();
}

if (ARM === 'escalation_counts_it') {
  const GIB = 1024 ** 3;
  const SETTLE_WAIT_MS = 23_000; // ALERT_SETTLE_MS (20 s) + margin
  const { store } = await import(`${REPO}/src/main/store.ts`);
  await store.load?.();
  const busMod = await import(`${REPO}/src/main/bus.ts`);
  const runsMod = await import(`${REPO}/src/main/bus-runs.ts`);
  busMod.initBus();
  const db = busMod.getBus();
  if (!db || !String(busMod.busPath()).startsWith(tmpHome)) { console.error(`SAFETY: bus resolved outside scratch: ${busMod.busPath()}`); process.exit(2); }
  const { DEFAULT_BUS_SWITCHES } = await import(`${REPO}/src/shared/bus-switches.ts`);
  const mkWs = (id, extra = {}) => store.upsertWorkspace({ id, name: id, kind: 'scratch', repoPath: '', baseBranch: '', branch: id, worktreePath: path.join(tmpHome, `wt-${id}`), status: 'idle', createdAt: Date.now(), hasInput: true, ...extra });
  await mkWs('lead', { kind: 'orchestrator' });
  await mkWs('w1', { parentId: 'lead' });
  runsMod.startRun(db, { id: 'lead', kind: 'mission', coordinator: 'lead' }, { ...DEFAULT_BUS_SWITCHES, delivery: true });
  // the guard: the REAL sampler on a fake MemAvailable source + a hand-fired timer; the alert host: REAL (real store, real bus, real setTimeout settle)
  let mem = 12 * GIB;
  let clock = Date.parse('2026-10-07T14:00:00Z');
  let pending = null;
  const guardMod = await import(`${REPO}/src/main/memory-guard.ts`);
  guardMod.setMemoryGuardSettingsReader(() => store.getMemoryGuardSettings());
  guardMod.__rebuildMemoryGuardForTests({ now: () => clock, schedule: (fn, ms) => { pending = { fn, ms }; return pending; }, cancel: (h) => { if (pending === h) pending = null; } }, () => mem).start();
  const step = (gb) => { mem = gb * GIB; clock += pending?.ms ?? 10_000; const p = pending; pending = null; p?.fn(); };
  let alertHost = null;
  try { alertHost = await import(`${REPO}/src/main/memory-alert-host.ts`); } catch (e) { fails.push(`the alert host is absent in ${REPO}: ${String(e?.message ?? e).split('\n')[0]}`); verdict({ absent: true }); }
  alertHost.startMemoryAlert();
  const rows = () => db.prepare("SELECT run_id, recipient, body FROM messages WHERE kind = 'escalation' ORDER BY sequence").all();
  const unattributedLine = (body) => /(\d+) unattributed container\(s\)\./.exec(body)?.[1] ?? (/unattributed containers not measured \(Docker unreachable\)\./.test(body) ? 'not-measured' : null);

  runStartMs = Date.now() - 60_000;
  const stray = run('stray', [], 0);   // NO orchestra.ws label, created on the REAL socket during the run
  check('stray_started', stray.code, 0);
  check('stray_ready', await ready('stray'), true);
  const strayId = dk(['inspect', '-f', '{{.Id}}', `${PFX}-stray`]).out;
  const oracleBefore = oracleUnattributed(runStartMs);   // taken before the pass …
  await acc.refreshContainerAccounting(mkDeps(realApi));   // what the monitor's tick does
  const oracleAfter = oracleUnattributed(runStartMs);    // … and after: the set the pass saw lies between them
  check('accounting_sees_the_stray_and_nothing_the_oracle_never_saw', [acc.getContainerAccounting().docker, acc.getContainerAccounting().unattributed.ids.includes(strayId), acc.getContainerAccounting().unattributed.ids.every((i) => oracleBefore.includes(i) || oracleAfter.includes(i))], ['ok', true, true]);
  const expectedCount = acc.getContainerAccounting().unattributed.count;   // frozen at this refresh: the row is written from the SAME accounting
  step(12);
  step(5.5);   // Admission HELD: episode 1
  check('episode_1_control', guardMod.getMemoryGuardSnapshot().episode, 1);
  check('nothing_before_the_settle_window', rows().length, 0);
  await sleep(SETTLE_WAIT_MS);
  check('one_escalation_to_the_lead', [rows().length, rows()[0]?.recipient], [1, 'lead']);
  const b1 = rows()[0]?.body ?? '';
  out.row_1_actions_line = b1.split('\n').find((l) => l.startsWith('Host actions')) ?? '';
  check('the_row_counts_what_the_accounting_counted_including_the_stray', unattributedLine(b1), String(expectedCount));
  check('the_placeholder_suffix_is_gone', /not measured yet — #293/.test(b1), false);
  check('the_stray_was_never_touched', dk(['inspect', '-f', '{{.State.Running}}', `${PFX}-stray`]).out, 'true');

  // Docker unreachable at the next episode: the accounting says so and the row must NOT say "0 unattributed"
  await acc.refreshContainerAccounting(mkDeps(dockerApi.createDockerApi({ socketPath: path.join(tmpHome, 'no-daemon.sock') })));
  check('accounting_now_unavailable', acc.getContainerAccounting().docker, 'unavailable');
  step(8);     // recovery above 7 GB: episode 1 over
  step(5.1);   // a NEW downward crossing: episode 2
  check('episode_2_control', guardMod.getMemoryGuardSnapshot().episode, 2);
  await sleep(SETTLE_WAIT_MS);
  check('a_second_escalation', rows().length, 2);
  check('with_docker_down_the_row_says_not_measured_never_zero', unattributedLine(rows()[1]?.body ?? ''), 'not-measured');
  verdict();
}
