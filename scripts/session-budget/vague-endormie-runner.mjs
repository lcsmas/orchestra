// One Vague-endormie rig run (#428), INSIDE the session-budget containment (harness.mjs `runVagueArm`): Orchestra's REAL path — agent-sdk.ts `sdkSend` → the real keeper + real `claude` CLI against the
// local fake API (zero tokens) — with the PRODUCTION asleep-vague sweep (vague-endormie-host.ts: store + REAL bus roster, kernel-scope census, `deliverRelance` → `sdkStartAndDeliver` behind Admission).
// Five vagues (a coordinator + one member each) run side by side with SHORTENED delays (quiet 10 s, process bound 45 s); the rig observes what the fleet observes: did the COORDINATOR get a turn, which, how
// many. The kernel scope is the one thing not real (a FAKE cgroup tree fed every 100 ms from a REAL /proc scan of the scripts' sessions). `cfg.vague=false` is the control arm: never started.
// Last stdout line: `{"vague": {...}}`.
import fs from 'node:fs';
import path from 'node:path';
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

const cfg = JSON.parse(process.env.SB_CONFIG ?? '{}');
const { REPO, root, arm, mutant = null, vague = true, timeoutMs = 280_000 } = cfg;
const QUIET_MS = 10_000;
const PROCESS_MS = 45_000;
const HERE = path.join(REPO, 'scripts', 'session-budget');

const { assertScratch } = await import(`${HERE}/scratch-guard.mjs`);
const home = path.join(root, 'home');
const orchHome = path.join(root, 'orchestra');
const cfgDir = path.join(home, '.claude');
if (!Array.isArray(cfg.live) || cfg.live.length === 0) throw new Error('vague-endormie-runner: cfg.live is absent or empty — refusing to run without the scratch guard\'s live list');
for (const [label, p] of [['HOME', home], ['ORCHESTRA_HOME', orchHome], ['CLAUDE_CONFIG_DIR', cfgDir]]) assertScratch(label, p, root, cfg.live);
fs.mkdirSync(cfgDir, { recursive: true });
fs.mkdirSync(orchHome, { recursive: true });
process.env.HOME = home;
process.env.ORCHESTRA_HOME = orchHome;
process.env.CLAUDE_CONFIG_DIR = cfgDir;

const UID = process.getuid();
const cgRoot = path.join(root, 'cgroup');
const slice = path.join(cgRoot, 'user.slice', `user-${UID}.slice`, `user@${UID}.service`, 'app.slice');
fs.mkdirSync(slice, { recursive: true });
assertScratch('ORCHESTRA_CGROUP_ROOT', cgRoot, root, cfg.live);
process.env.ORCHESTRA_CGROUP_ROOT = cgRoot;
delete process.env.ORCHESTRA_MEMORY_SCOPE_PREFIX;
delete process.env.ORCHESTRA_RELANCE;

if (mutant) register(pathToFileURL(`${HERE}/mutants.mjs`).href, { parentURL: import.meta.url, data: { mutant } });

const { startFakeApi } = await import(`${HERE}/fake-anthropic-api.mjs`);
const sigDir = path.join(root, 'sig');
fs.mkdirSync(sigDir, { recursive: true });

// what each member's model does on its prompt: `PROMPT-LAUNCH` = launch N detached scripts and end; `PROMPT-SLEEP` = a FOREGROUND command that keeps the turn running for a while
const PLAN = {};
const scriptCmd = (mark, k) => {
  const d = path.join(sigDir, `ws-impl-${mark}`);
  return `setsid sh -c ': VAGSCRIPT-${mark}-${k}; echo $$ > ${d}/pid-${k}; while [ ! -e ${d}/rel-${k} ]; do sleep 0.2; done' </dev/null >/dev/null 2>&1 &`;
};
const launchCommand = (mark) => {
  const lines = [];
  for (let k = 1; k <= PLAN[mark].scripts; k++) lines.push(scriptCmd(mark, k));
  lines.push('sleep 0.6', 'echo launched');
  return lines.join('\n');
};

const lastUser = (msgs) => JSON.stringify([...(msgs ?? [])].reverse().find((m) => m.role === 'user')?.content ?? '');
const api = await startFakeApi({
  apiPort: cfg.apiPort, proxyPort: cfg.proxyPort, keepMessages: true,
  reply: (rec) => {
    if (!(rec.tools > 0)) return undefined;
    const last = lastUser(rec.messages);
    if (last.includes('[orchestra] Relance')) return { text: 'REPLY-RELANCE' };
    if (last.includes('tool_result')) return { text: 'REPLY-DONE' };
    const sleep = /PROMPT-SLEEP MARK-([a-z0-9]+) SECS-(\d+)/.exec(last);
    if (sleep) return { toolUse: { name: 'Bash', input: { command: `timeout ${sleep[2]} tail -f /dev/null; echo slept`, description: 'a long foreground command' } } };
    const mark = /PROMPT-LAUNCH MARK-([a-z0-9]+)/.exec(last)?.[1];
    if (mark && PLAN[mark]) return { toolUse: { name: 'Bash', input: { command: launchCommand(mark), description: 'launch detached scripts' } } };
    return { text: 'REPLY' };
  },
});
if (api.proxyUrl !== process.env.HTTPS_PROXY || process.env.NODE_USE_ENV_PROXY !== '1') {
  throw new Error(`vague-endormie-runner: not routed through the recording proxy (HTTPS_PROXY=${process.env.HTTPS_PROXY}, proxy=${api.proxyUrl})`);
}
delete process.env.NODE_USE_ENV_PROXY;
delete process.env.ANTHROPIC_AUTH_TOKEN;
Object.assign(process.env, {
  ANTHROPIC_BASE_URL: api.url,
  ANTHROPIC_API_KEY: 'sk-ant-api03-vague-rig-fake-key-not-real',
  HTTPS_PROXY: api.proxyUrl, HTTP_PROXY: api.proxyUrl, https_proxy: api.proxyUrl, http_proxy: api.proxyUrl,
  NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost',
});

const keeperSrc = path.join(REPO, 'dist-electron', 'keeper.js');
if (!fs.existsSync(keeperSrc)) throw new Error('dist-electron/keeper.js missing — run `pnpm run build:keeper` (harness.ensureBuilt does)');
fs.mkdirSync(path.join(orchHome, 'bin'), { recursive: true });
fs.copyFileSync(keeperSrc, path.join(orchHome, 'bin', 'keeper.js'));

const { initPlatform } = await import(`${REPO}/src/main/platform/index.ts`);
// In the app the status dot and the idle clock are fed by the per-worktree HOOK scripts (UserPromptSubmit / PreToolUse / PostToolUse / Stop → events spool → `applyAgentEvent`); the rig installs no hooks, so the
// same lifecycle is derived from the SDK events the real CLI session emits and handed to the SAME funnel (activity.ts `applyAgentEvent`) — status `running` for a turn in flight, the idle clock stamped on every event.
const turnRunning = new Set();
let applyEvt = null;
function feedHooks(wsId, ev) {
  if (!applyEvt) return;
  try {
    if (ev.type === 'turn-end') { turnRunning.delete(wsId); applyEvt(wsId, 'stop', undefined); return; }
    if (!turnRunning.has(wsId) && ['user-message', 'block-start', 'text-delta', 'thinking-start', 'tool-use'].includes(ev.type)) { turnRunning.add(wsId); applyEvt(wsId, 'submit', undefined); }
    if (ev.type === 'tool-use') applyEvt(wsId, 'pretool', ev.name, undefined, undefined, ev.toolUseId);
    if (ev.type === 'tool-result') applyEvt(wsId, 'posttool', undefined, undefined, undefined, ev.toolUseId);
  } catch { /* the rig's feed must never break the session */ }
}
const turnEnds = new Map();
let errorEvent = null;
initPlatform({
  kind: 'headless-vague-rig',
  broadcast: (channel, wsId, ev) => {
    if (channel !== 'agent:event' || !ev) return;
    if (ev.type === 'turn-end') turnEnds.set(wsId, (turnEnds.get(wsId) ?? 0) + 1);
    if (ev.type === 'error' && !errorEvent) errorEvent = ev;
    feedHooks(wsId, ev);
  },
  broadcastPtyData: () => {}, canBroadcast: () => true, isFocused: () => false, hasAttachedUi: () => false,
  notify: () => {}, openExternal: () => {}, showItemInFolder: () => {}, openPath: () => {},
  openAccountLoginUrl: () => {}, closeAccountLogin: () => {},
  getUserDataDir: () => orchHome, getLogsDir: () => `${orchHome}/logs`, getAppVersion: () => '0.0.0-vague-rig',
  getAppMetrics: () => [], isEncryptionAvailable: () => false, encryptString: (s) => s, decryptString: (s) => s,
});

const { store } = await import(`${REPO}/src/main/store.ts`);
const sdk = await import(`${REPO}/src/main/agent-sdk.ts`);
const keeper = await import(`${REPO}/src/main/keeper-client.ts`);
const sdkDelivery = await import(`${REPO}/src/main/sdk-delivery.ts`);
const bus = await import(`${REPO}/src/main/bus.ts`);
const vagueHost = await import(`${REPO}/src/main/vague-endormie-host.ts`);
const vagueMod = await import(`${REPO}/src/main/vague-endormie.ts`);
const { getLastActivity } = await import(`${REPO}/src/main/hibernation-activity.ts`);
({ applyAgentEvent: applyEvt } = await import(`${REPO}/src/main/activity.ts`));
await store.load?.();
bus.initBus(); // the REAL bus file under the scratch ORCHESTRA_HOME: the roster's released / waiting / held reads are the shipped queries

const deadline = Date.now() + timeoutMs;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const wsIds = [];
const dirOf = (id) => path.join(sigDir, id); // per WORKSPACE: a coordinator's scope never holds its member's scripts

async function makeWs(id, over = {}) {
  const dir = path.join(root, `repo-${id}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'README.md'), '# vague rig\n');
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['-c', 'user.email=rig@invalid', '-c', 'user.name=rig', 'commit', '-qm', 'init'], { cwd: dir });
  await store.upsertWorkspace({ id, name: id, kind: 'scratch', repoPath: '', worktreePath: dir, status: 'idle', createdAt: Date.now() - 3600_000, hasInput: true, ...over });
  fs.mkdirSync(dirOf(id), { recursive: true });
  wsIds.push(id);
}

// ── the fake kernel (as in relance-runner): a scope per workspace holding the processes of its detached scripts' sessions (REAL /proc scan) ──
const scopeUnit = (id) => `orchestra-ws-${id}-aaaaaa.scope`;
function sessionsOf(id) {
  const d = dirOf(id);
  const sids = [];
  for (const n of fs.readdirSync(d)) {
    if (!n.startsWith('pid-')) continue;
    const v = Number(fs.readFileSync(path.join(d, n), 'utf8').trim());
    if (Number.isInteger(v) && v > 0) sids.push(v);
  }
  return sids;
}
function procsInSessions(sids) {
  const want = new Set(sids);
  const out = [];
  if (want.size === 0) return out;
  for (const name of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const st = fs.readFileSync(`/proc/${name}/stat`, 'utf8');
      const f = st.slice(st.lastIndexOf(')') + 2).split(' ');
      if (f[0] !== 'Z' && want.has(Number(f[3]))) out.push(Number(name));
    } catch { /* gone */ }
  }
  return out;
}
const listedEver = new Map();
function feedKernel() {
  for (const id of wsIds) {
    let pids = [];
    try { pids = procsInSessions(sessionsOf(id)); } catch { /* dir gone */ }
    const dir = path.join(slice, scopeUnit(id));
    if (pids.length === 0) { fs.rmSync(dir, { recursive: true, force: true }); continue; }
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'cgroup.procs'), pids.join('\n') + '\n');
    listedEver.set(id, Math.max(listedEver.get(id) ?? 0, pids.length));
  }
}
const kernel = setInterval(() => { try { feedKernel(); } catch { /* next tick */ } }, 100);

const pidOf = (id, k) => Number(fs.readFileSync(path.join(dirOf(id), `pid-${k}`), 'utf8').trim());
const alive = (pid) => { try { const st = fs.readFileSync(`/proc/${pid}/stat`, 'utf8'); return st.slice(st.lastIndexOf(')') + 2)[0] !== 'Z'; } catch { return false; } };
async function waitFor(fn, ms) {
  const until = Math.min(deadline, Date.now() + ms);
  while (Date.now() < until) { if (await fn()) return true; await sleep(100); }
  return !!(await fn());
}

/** What a COORDINATOR observes: model requests of the real CLI whose last user message is a Relance about THIS vague (its member's task text), and the turns that ended in its own conversation. */
const vagueTurns = (v) => api.requests.filter((r) => r.type === 'model' && r.tools > 0 && lastUser(r.messages).includes('[orchestra] Relance — your vague is asleep') && lastUser(r.messages).includes(`TASK-${v}`));
/** The Relance as the CLI sent it (the last user message carries the system reminders first; cut at the header). */
const relanceText = (rec) => { if (!rec) return null; const t = lastUser(rec.messages); const i = t.indexOf('[orchestra] Relance'); return i < 0 ? null : t.slice(i, i + 2400); };
const coordTurnEnds = (v) => turnEnds.get(`ws-ops-${v}`) ?? 0;
const lastActAge = (id) => Date.now() - (getLastActivity(id) ?? 0);

async function runTurn(id, prompt) {
  const want = (turnEnds.get(id) ?? 0) + 1;
  await sdk.sdkSend(id, prompt);
  if (!(await waitFor(() => (turnEnds.get(id) ?? 0) >= want || errorEvent, 60_000)) || errorEvent) throw new Error(`turn of ${id} never ended${errorEvent ? `: ${errorEvent.message}` : ''}`);
}
async function launch(v, scripts) {
  const id = `ws-impl-${v}`;
  PLAN[v] = { scripts };
  await runTurn(id, `PROMPT-LAUNCH MARK-${v} go`);
  if (!(await waitFor(() => fs.readdirSync(dirOf(`ws-impl-${v}`)).filter((n) => n.startsWith('pid-')).length >= scripts, 10_000))) throw new Error(`${id}: the Bash tool did not launch ${scripts} detached script(s)`);
}

const out = { arm, mutant, vague, quietMs: QUIET_MS, processMs: PROCESS_MS, vagues: {} };
let error = null;
try {
  // a: idle member with a task, nothing alive.   b: same + a live detached script (protects < 45 s, then is named).   c: a member whose turn runs for a while (active).
  // d: its task is finished (worker_done on the REAL bus, not re-tasked).   e: a hand-made workspace under the coordinator, no dispatched task.
  for (const v of ['a', 'b', 'c', 'd', 'e']) {
    await makeWs(`ws-ops-${v}`, { name: `ops-${v}`, status: 'idle', canOrchestrate: true });
    await makeWs(`ws-impl-${v}`, { name: `impl-${v}`, parentId: `ws-ops-${v}`, ...(v === 'e' ? {} : { lastTask: `TASK-${v}: finish the ${v} fix and push` }) });
  }
  await launch('a', 0);
  await launch('b', 1);
  await launch('d', 0);
  await launch('e', 0);
  // d reported done and was not re-tasked: a POSITIVE completion marker on the real bus
  bus.send(bus.getBus(), { runId: 'ws-ops-d', sender: 'ws-impl-d', recipient: 'ws-ops-d', kind: 'worker_done', body: 'done' });
  await waitFor(() => (listedEver.get('ws-impl-b') ?? 0) >= 1, 5_000);
  out.scriptAliveAtStart = alive(pidOf('ws-impl-b', 1));

  if (vague) vagueMod.startVagueEndormie({ ...vagueHost.productionVagueDeps, bounds: () => ({ quietMs: QUIET_MS, processMs: PROCESS_MS }) }, 2_000);
  const t0 = Date.now();
  // c: a member runs a FOREGROUND command for 26 s — a turn in flight the whole time the others fall asleep
  PLAN.c = { scripts: 0 };
  await sdk.sdkSend('ws-impl-c', 'PROMPT-SLEEP MARK-c SECS-26 go');
  await waitFor(() => store.getWorkspace('ws-impl-c')?.status === 'running', 15_000);

  if (!vague) {
    // CONTROL: the mechanism never runs. Long enough for every vague to have been quiet past the delay AND for b's process bound to lapse; nobody may get a turn.
    await sleep(PROCESS_MS + 25_000);
    for (const v of ['a', 'b', 'c', 'd', 'e']) out.vagues[v] = { relances: vagueTurns(v).length, coordinatorTurnEnds: coordTurnEnds(v) };
    out.finalQuietAgeMs = Object.fromEntries(['a', 'b', 'c', 'd', 'e'].map((v) => [v, lastActAge(`ws-impl-${v}`)]));
    out.bScriptAlive = alive(pidOf('ws-impl-b', 1));
    throw new Error('__control_done__');
  }
  // a falls asleep ⇒ its coordinator is told (once). Wait for it, then for b / d / e to have been quiet LONGER than the delay, and sample
  const aTold = await waitFor(() => coordTurnEnds('a') >= 1, 60_000);
  await waitFor(() => lastActAge('ws-impl-b') > QUIET_MS + 2_000 && lastActAge('ws-impl-d') > QUIET_MS + 2_000 && lastActAge('ws-impl-e') > QUIET_MS + 2_000, 30_000);
  out.sample = {
    aTold,
    cStatus: store.getWorkspace('ws-impl-c')?.status,
    cRunningForMs: Date.now() - t0,
    quietAgeMs: { b: lastActAge('ws-impl-b'), d: lastActAge('ws-impl-d'), e: lastActAge('ws-impl-e') },
    turns: Object.fromEntries(['a', 'b', 'c', 'd', 'e'].map((v) => [v, vagueTurns(v).length])),
    bScriptAlive: alive(pidOf('ws-impl-b', 1)),
  };
  out.aView = vagueMod.asleepVagues().find((x) => x.runId === 'ws-ops-a') ?? null;
  out.aText = relanceText(vagueTurns('a')[0]);
  out.aCoordinatorSessionLive = sdkDelivery.sdkSessionLive('ws-ops-a');

  // c's turn ends ⇒ it was active the whole time; THEN it falls quiet ⇒ its coordinator is told
  await waitFor(() => store.getWorkspace('ws-impl-c')?.status !== 'running', 40_000);
  out.cTurnEndedAtMs = Date.now() - t0;
  out.cToldAfterQuiet = await waitFor(() => coordTurnEnds('c') >= 1, 40_000);
  // b: the script (alive, no agent activity) protects the vague until PROCESS_MS of inactivity, then is NAMED
  out.bToldAfterBound = await waitFor(() => coordTurnEnds('b') >= 1, PROCESS_MS + 30_000);
  out.bText = relanceText(vagueTurns('b')[0]);
  out.bQuietAgeAtTold = lastActAge('ws-impl-b');
  // a stays ONE Relance for the whole episode: wait two more delays
  await sleep(2 * QUIET_MS + 3_000);
  out.aBeforeResume = vagueTurns('a').length;
  out.aEpisodeStillOpen = vagueMod.asleepVagues().some((x) => x.runId === 'ws-ops-a' && x.declaredAt === out.aView?.declaredAt);
  // a member of a resumes: the episode ENDS; it falls quiet again ⇒ a NEW episode ⇒ the coordinator is told a second time
  await runTurn('ws-impl-a', 'PROMPT-LAUNCH MARK-a again');
  await sleep(2_500);
  out.aEpisodeEndedByResume = !vagueMod.asleepVagues().some((x) => x.runId === 'ws-ops-a' && x.declaredAt === out.aView?.declaredAt);
  out.aSecondEpisodeTold = await waitFor(() => vagueTurns('a').length >= 2, QUIET_MS + 30_000);
  await sleep(QUIET_MS + 3_000);
  out.aFinal = vagueTurns('a').length;
  for (const v of ['a', 'b', 'c', 'd', 'e']) out.vagues[v] = { relances: vagueTurns(v).length, coordinatorTurnEnds: coordTurnEnds(v) };
  out.counters = vagueMod.vagueCounters();
  out.finalQuietAgeMs = Object.fromEntries(['a', 'b', 'c', 'd', 'e'].map((v) => [v, lastActAge(`ws-impl-${v}`)]));
} catch (e) {
  if (!String(e?.message ?? e).includes('__control_done__')) error = String(e?.stack ?? e);
}

clearInterval(kernel);
vagueMod.stopVagueEndormie?.();
for (const id of wsIds) {
  try { for (const n of fs.readdirSync(dirOf(id))) if (n.startsWith('pid-')) fs.writeFileSync(path.join(dirOf(id), `rel-${n.slice(4)}`), ''); } catch { /* none */ }
}
for (const id of wsIds) {
  try {
    keeper.forbidKeeperLaunch(id);
    const tree = keeper.snapshotKeeperTree(id);
    await sdk.sdkStop?.(id).catch?.(() => {});
    await keeper.killKeeper(id, 'vague-rig-teardown').catch(() => {});
    await keeper.killKeeperTree(id, tree, 'vague-rig-teardown').catch(() => {});
  } catch (e) {
    error = error ?? `teardown: ${String(e?.stack ?? e)}`;
  }
}
await api.stop().catch(() => {});
bus.closeBus();
if (error) out.error = error;
console.log(JSON.stringify({ vague: out }));
process.exit(0);
