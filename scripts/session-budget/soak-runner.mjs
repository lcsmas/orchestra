// The soak campaign's RUNNER (C5 #212), INSIDE the harness containment (net+pid namespaces, scratch HOME): the app-process analog.
// ONE process hosts N concurrent REAL sessions (agent-sdk.ts sdkSend → ensureSession → keeper → real `claude`, each in its own heavy
// fixture repo) the way Orchestra's main process does, against the fake Anthropic API running in a SEPARATE process
// (soak-api-proc.mjs — the runner carries no instrument state, so its memory slope is the app's). Zero tokens (D6).
//
// It only COLLECTS: every observation is one JSON line on stdout — `{"soak":"start|sample|turn|event|abort|final",…}` — and the parent
// (soak-lib.mjs) turns the lines into a report with src/shared/soak-campaign.ts. A runner that dies still leaves its lines behind.
// Config arrives in SB_CONFIG (harness.runSoakCampaign). D7: caps re-checked every sample; SIGTERM = graceful abort + teardown.
import fs from 'node:fs';
import path from 'node:path';
import { fork, execFileSync } from 'node:child_process';

const cfg = JSON.parse(process.env.SB_CONFIG ?? '{}');
const { REPO, root, sessions: N = 3, durationMs = 300_000, turnIntervalMs = 20_000, sampleMs = 10_000, turnDeadlineMs = 60_000,
  replyDelayMs = 500, faultPlan = null, profile = {}, seedLeak = null, pidns = false, containment = 'proxy-only', caps = null } = cfg;
const HERE = path.join(REPO, 'scripts', 'session-budget');

const { assertScratch } = await import(`${HERE}/scratch-guard.mjs`);
const home = path.join(root, 'home');
const orchHome = path.join(root, 'orchestra');
const cfgDir = path.join(home, '.claude');
if (!Array.isArray(cfg.live) || cfg.live.length === 0) throw new Error('soak-runner: cfg.live (the invoker\'s live-dir list) is absent or empty — refusing to run without the scratch guard\'s live list');
if (!caps || !(caps.minMemAvailKB > 0) || !(caps.maxLoad1 > 0)) throw new Error('soak-runner: cfg.caps (D7 abort thresholds) absent — refusing to run without the resource caps');
for (const [label, p] of [['HOME', home], ['ORCHESTRA_HOME', orchHome], ['CLAUDE_CONFIG_DIR', cfgDir]]) assertScratch(label, p, root, cfg.live);
fs.mkdirSync(cfgDir, { recursive: true });
fs.mkdirSync(orchHome, { recursive: true });
process.env.HOME = home;
process.env.ORCHESTRA_HOME = orchHome;
process.env.CLAUDE_CONFIG_DIR = cfgDir;

const { generateHeavyFixture } = await import(`${HERE}/fixture.mjs`);
const { snapshotProcs, classify } = await import(`${HERE}/proc-census.mjs`);
const { decideAbort } = await import(`${REPO}/src/shared/soak-campaign.ts`);
const { TRAFFIC_KNOBS } = await import(`${REPO}/src/shared/session-budget.ts`);

const emit = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const tSec = () => Math.round((Date.now() - t0) / 100) / 10;

// ── fixtures: one heavy repo per session (a workspace worktree each) ────────────────────────────────────────────────────────────
const fixtures = [];
for (let i = 0; i < N; i++) {
  const leak = seedLeak && seedLeak.session === i ? { mcpLeakMbPerMin: seedLeak.mbPerMin } : {};
  fixtures.push(generateHeavyFixture(path.join(root, 'repos', `s${i}`), { ...profile, ...leak }));
}

// ── the fake API, in its own process (inside the same namespace: its loopback is the CLI's) ─────────────────────────────────────
if (!cfg.apiPort || !cfg.proxyPort) throw new Error('soak-runner: cfg.apiPort/proxyPort absent — the app-process egress proxy cannot be wired (fails closed)');
const apiEnv = { PATH: process.env.PATH, HOME: home, LANG: 'C.UTF-8', SB_API_CONFIG: JSON.stringify({ apiPort: cfg.apiPort, proxyPort: cfg.proxyPort, replyDelayMs, faultPlan, markers: fixtures[0].markers }) };
const apiChild = fork(`${HERE}/soak-api-proc.mjs`, [], { env: apiEnv, stdio: ['ignore', 'inherit', 'inherit', 'ipc'], execArgv: ['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON'] });
const apiPid = apiChild.pid;
const api = await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('fake API process did not come up in 15 s')), 15_000);
  apiChild.once('exit', (c) => reject(new Error(`fake API process exited (rc=${c}) before it was ready — a malformed/unimplemented fault plan exits here`)));
  apiChild.on('message', (m) => { if (m?.t === 'ready') { clearTimeout(t); resolve(m); } });
});
if (api.proxyUrl !== process.env.HTTPS_PROXY || process.env.NODE_USE_ENV_PROXY !== '1') {
  throw new Error(`soak-runner: this process is not routed through the recording proxy (HTTPS_PROXY=${process.env.HTTPS_PROXY} NODE_USE_ENV_PROXY=${process.env.NODE_USE_ENV_PROXY}, proxy=${api.proxyUrl}) — app-process egress would be invisible (fails closed)`);
}
delete process.env.NODE_USE_ENV_PROXY; // production parity: the env copy handed to the CLI must not carry an instrument-only var
let statsSeq = 0;
const statsWaiters = new Map();
apiChild.on('message', (m) => { if (m?.t === 'stats') { statsWaiters.get(m.id)?.(m); statsWaiters.delete(m.id); } });
const apiStats = () => new Promise((resolve) => {
  const id = ++statsSeq;
  statsWaiters.set(id, resolve);
  try { apiChild.send({ t: 'stats', id }); } catch { resolve(null); }
  setTimeout(() => { if (statsWaiters.delete(id)) resolve(null); }, 3000).unref();
});

// The CLI's environment (buildSdkEnv copies process.env): fake API, a per-session dummy key (set right before each session's start),
// the refusing proxy, NONE of the traffic-suppressing knobs (production parity). No real credential is ever in this env.
for (const k of [...TRAFFIC_KNOBS, 'ANTHROPIC_AUTH_TOKEN']) delete process.env[k];
Object.assign(process.env, {
  ANTHROPIC_BASE_URL: api.url,
  HTTPS_PROXY: api.proxyUrl, HTTP_PROXY: api.proxyUrl, https_proxy: api.proxyUrl, http_proxy: api.proxyUrl,
  NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost',
});
const keyFor = (i) => `sk-ant-api03-soak-s${i}-fake-key-not-real`;

const keeperSrc = path.join(REPO, 'dist-electron', 'keeper.js');
if (!fs.existsSync(keeperSrc)) throw new Error('dist-electron/keeper.js missing — run `pnpm run build:keeper`');
fs.mkdirSync(path.join(orchHome, 'bin'), { recursive: true });
fs.copyFileSync(keeperSrc, path.join(orchHome, 'bin', 'keeper.js'));

// ── the app seam: per-workspace event counters ──────────────────────────────────────────────────────────────────────────────────
const S = fixtures.map((fx, i) => ({ i, ws: `ws-soak-${i}`, fx, key: keyFor(i), sent: 0, turnEnds: 0, errors: 0, lastError: null, wedged: false, init: null, stopped: false }));
const byWs = new Map(S.map((s) => [s.ws, s]));
const { initPlatform } = await import(`${REPO}/src/main/platform/index.ts`);
initPlatform({
  kind: 'headless-soak',
  broadcast: (channel, wsId, ev) => {
    if (channel !== 'agent:event' || !ev) return;
    const s = byWs.get(wsId);
    if (!s) return;
    if (ev.type === 'session/init' && !s.init) s.init = { mcpConnected: (ev.mcpServers ?? []).filter((m) => s.fx.mcpServerNames.includes(m.name) && m.status === 'connected').length, tools: ev.tools?.length ?? 0 };
    if (ev.type === 'turn-end') s.turnEnds++;
    if (ev.type === 'error') { s.errors++; s.lastError = String(ev.message ?? '').slice(0, 200); }
  },
  broadcastPtyData: () => {}, canBroadcast: () => true, isFocused: () => false, hasAttachedUi: () => false,
  notify: () => {}, openExternal: () => {}, showItemInFolder: () => {}, openPath: () => {},
  openAccountLoginUrl: () => {}, closeAccountLogin: () => {},
  getUserDataDir: () => orchHome, getLogsDir: () => `${orchHome}/logs`, getAppVersion: () => '0.0.0-soak',
  getAppMetrics: () => [], isEncryptionAvailable: () => false, encryptString: (x) => x, decryptString: (x) => x,
});
const { store } = await import(`${REPO}/src/main/store.ts`);
const sdk = await import(`${REPO}/src/main/agent-sdk.ts`);
const keeper = await import(`${REPO}/src/main/keeper-client.ts`);
await store.load?.();
for (const s of S) {
  await store.upsertWorkspace({ id: s.ws, name: `soak-${s.i}`, kind: 'scratch', repoPath: '', worktreePath: s.fx.dir, status: 'idle', createdAt: Date.now(), hasInput: true });
}
const cliPath = execFileSync('sh', ['-c', 'command -v claude'], { env: process.env, encoding: 'utf8' }).trim();
const cliVersion = execFileSync(cliPath, ['--version'], { env: process.env, encoding: 'utf8' }).trim();

// ── samplers ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const readMemAvailKB = () => { try { return Number(/^MemAvailable:\s+(\d+) kB/m.exec(fs.readFileSync('/proc/meminfo', 'utf8'))?.[1] ?? NaN); } catch { return NaN; } };
const readLoad1 = () => { try { return Number(fs.readFileSync('/proc/loadavg', 'utf8').split(' ')[0]); } catch { return NaN; } };

/** One /proc pass → per-session tree (keeper + descendants), the runner, the API process, and everything else in the namespace. */
function scan() {
  const procs = snapshotProcs();
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  const kids = new Map();
  for (const p of procs) (kids.get(p.ppid) ?? kids.set(p.ppid, []).get(p.ppid)).push(p);
  const ancestors = new Set([process.pid]);
  for (let p = byPid.get(process.pid); p && p.ppid > 0 && !ancestors.has(p.ppid); p = byPid.get(p.ppid)) ancestors.add(p.ppid);
  const claimed = new Set([...ancestors, apiPid, 1]);
  const per = S.map((s) => {
    const rootPid = keeper.readTrackedKeeperPid?.(s.ws) ?? null;
    const tree = [];
    if (rootPid && byPid.has(rootPid)) {
      const stack = [byPid.get(rootPid)];
      while (stack.length) { const p = stack.pop(); tree.push(p); stack.push(...(kids.get(p.pid) ?? [])); }
    }
    for (const p of tree) claimed.add(p.pid);
    const live = tree.filter((p) => p.state !== 'Z');
    const byKind = { cli: 0, keeper: 0, mcp: 0, hook: 0, other: 0 };
    for (const p of live) byKind[classify(p)]++;
    return { i: s.i, rssKB: live.length ? live.reduce((a, p) => a + p.rssKB, 0) : null, swapKB: live.reduce((a, p) => a + p.swapKB, 0), procs: live.length, byKind, pids: live.map((p) => p.pid) };
  });
  const strays = procs.filter((p) => !claimed.has(p.pid) && p.state !== 'Z');
  return { per, strays, runnerRssKB: byPid.get(process.pid)?.rssKB ?? null, runnerSwapKB: byPid.get(process.pid)?.swapKB ?? 0, apiRssKB: byPid.get(apiPid)?.rssKB ?? null, apiSwapKB: byPid.get(apiPid)?.swapKB ?? 0, procs, ancestors };
}

let lastPerPids = new Map(); // pid → session index, from the most recent sample (survivor attribution after the delete)
async function sample(phase) {
  const sc = scan();
  for (const p of sc.per) for (const pid of p.pids) lastPerPids.set(pid, p.i);
  const st = await apiStats();
  emit({
    soak: 'sample', tSec: tSec(), phase, memAvailKB: readMemAvailKB(), load1: readLoad1(), runnerRssKB: sc.runnerRssKB, runnerSwapKB: sc.runnerSwapKB, apiRssKB: sc.apiRssKB, apiSwapKB: sc.apiSwapKB,
    strays: sc.strays.length, strayKinds: sc.strays.slice(0, 5).map((p) => `${classify(p)}:${p.cmd.join(' ').slice(0, 80)}`),
    s: sc.per.map((p) => ({ i: p.i, rssKB: p.rssKB, swapKB: p.swapKB, procs: p.procs, k: p.byKind, apiMain: st?.sessions?.[`s${p.i}`]?.main ?? null, apiHeld: st?.sessions?.[`s${p.i}`]?.held ?? 0 })),
  });
  return sc;
}

// ── the campaign ────────────────────────────────────────────────────────────────────────────────────────────────────────────────
let stopping = false;
let abortInfo = null;
let wake = null;
const stopSignal = new Promise((r) => { wake = r; });
function abort(reason, detail) {
  if (abortInfo) return;
  abortInfo = { reason, detail, tSec: tSec() };
  emit({ soak: 'abort', ...abortInfo });
  stopping = true;
  wake();
}
process.on('SIGTERM', () => abort('signal', 'SIGTERM'));
process.on('SIGINT', () => abort('signal', 'SIGINT'));
// The driver's abort request (D7 watchdog, the app yielding to the user) arrives as a file — see harness.mjs `runContained`.
const abortFile = path.join(root, 'ABORT');
const abortPoll = setInterval(() => {
  if (abortInfo || !fs.existsSync(abortFile)) return;
  try { const a = JSON.parse(fs.readFileSync(abortFile, 'utf8')); abort(String(a.reason ?? 'signal'), String(a.detail ?? 'abort file')); } catch { abort('signal', 'abort file (unreadable)'); }
}, 1000);
const sleepInterruptible = (ms) => Promise.race([sleep(ms), stopSignal]);

function beginTurn(s) {
  const n = s.sent++;
  const p = { s, n, tSend: Date.now(), endsBefore: s.turnEnds, errsBefore: s.errors, sendErr: null, done: false };
  p.sent = Promise.race([
    sdk.sdkSend(s.ws, `Reply with the single word ok. (soak turn ${n})`).then(() => {}, (e) => { p.sendErr = String(e?.message ?? e).slice(0, 200); }),
    sleep(turnDeadlineMs).then(() => {}),
  ]).then(() => { p.done = true; });
  return p;
}
async function settle(p) {
  const { s } = p;
  await p.sent;
  let outcome = null;
  while (Date.now() - p.tSend < turnDeadlineMs) {
    if (p.sendErr) { outcome = 'error'; break; }
    if (s.turnEnds > p.endsBefore) { outcome = 'ok'; break; }
    if (s.errors > p.errsBefore) { outcome = 'error'; break; }
    if (abortInfo) break; // an abort (caps / signal): do not wait out the deadline on every session
    await sleep(100);
  }
  const ms = Date.now() - p.tSend;
  if (!outcome) outcome = abortInfo && ms < turnDeadlineMs ? 'unfinished' : 'wedged';
  emit({ soak: 'turn', i: s.i, n: p.n, tSec: Math.round((p.tSend - t0) / 100) / 10, ms, outcome, phase: p.n === 0 ? 'startup' : 'steady', ...(outcome === 'error' ? { err: p.sendErr ?? s.lastError } : {}) });
  return outcome;
}

async function drive(s, first) {
  let pend = first;
  for (;;) {
    const outcome = await settle(pend);
    if (outcome === 'wedged') { s.wedged = true; emit({ soak: 'event', tSec: tSec(), i: s.i, kind: 'wedged', detail: `turn ${pend.n} unfinished after ${turnDeadlineMs} ms; no further turns are sent to this session` }); return; }
    if (stopping) return;
    await sleepInterruptible(Math.round(turnIntervalMs * (0.75 + Math.random() * 0.5)));
    if (stopping) return;
    pend = beginTurn(s);
  }
}

emit({ soak: 'start', at: new Date(t0).toISOString(), sessions: N, durationMs, turnIntervalMs, sampleMs, turnDeadlineMs, replyDelayMs, containment, pidns, cli: { version: cliVersion, path: fs.realpathSync(cliPath) },
  fixture: { skills: fixtures[0].profile.skills, memoryFiles: fixtures[0].profile.memoryFiles, mcpServers: fixtures[0].profile.mcpServers, toolsPerServer: fixtures[0].profile.toolsPerServer, claudeMdKB: fixtures[0].profile.claudeMdKB },
  seedLeak, faultPlan, caps, pageKB: Math.round(Number(execFileSync('getconf', ['PAGESIZE'], { encoding: 'utf8' })) / 1024), nproc: (await import('node:os')).cpus().length });

await sample('boot');
const sampler = setInterval(async () => {
  if (stopping) return;
  const why = decideAbort({ memAvailKB: readMemAvailKB(), load1: readLoad1() }, caps);
  if (why) return abort(why.reason, why.detail);
  await sample('run').catch((e) => emit({ soak: 'event', tSec: tSec(), kind: 'sample-error', detail: String(e).slice(0, 200) }));
}, sampleMs);

const endAt = t0 + durationMs;
const drives = [];
try {
  for (const s of S) {
    if (stopping) break;
    process.env.ANTHROPIC_API_KEY = s.key; // buildSdkEnv copies process.env inside ensureSession, which sdkSend awaits before returning
    const first = beginTurn(s);
    await first.sent; // ensureSession done (this session's env is captured) — the next session may change the key
    drives.push(drive(s, first));
    emit({ soak: 'event', tSec: tSec(), i: s.i, kind: 'started', detail: `session ${s.i} launched` });
  }
  // The duration counts from the first launch; sessions keep going until it is over (or an abort).
  await Promise.race([sleep(Math.max(0, endAt - Date.now())), stopSignal]);
} catch (e) {
  emit({ soak: 'event', tSec: tSec(), kind: 'runner-error', detail: String(e?.stack ?? e).slice(0, 600) });
}
stopping = true;
clearInterval(sampler);
clearInterval(abortPoll);
await Promise.race([Promise.allSettled(drives), sleep(turnDeadlineMs + 5000)]);
const endScan = await sample('end');

// ── teardown as a workspace delete does (workspaces.ts stopStructuredSession), then who is left ────────────────────────────────────
async function teardown(s) {
  const guard = (p, ms) => Promise.race([p, sleep(ms).then(() => { throw new Error(`timeout ${ms} ms`); })]);
  try {
    keeper.forbidKeeperLaunch(s.ws);
    const tree = keeper.snapshotKeeperTree(s.ws);
    await guard(Promise.resolve(sdk.sdkStop?.(s.ws)).catch(() => {}), 15_000).catch(() => {});
    await guard(keeper.killKeeper(s.ws, 'soak-teardown').catch(() => {}), 15_000).catch(() => {});
    await guard(keeper.killKeeperTree(s.ws, tree, 'soak-teardown').catch(() => {}), 15_000).catch(() => {});
    return null;
  } catch (e) { return String(e?.message ?? e); }
}
const tdErrors = (await Promise.all(S.map(teardown))).map((e, i) => (e ? { i, error: e } : null)).filter(Boolean);
await sleep(3000);
const after = scan();
const survivors = after.procs.filter((p) => p.state !== 'Z' && p.pid !== 1 && p.pid !== apiPid && !after.ancestors.has(p.pid));
const survivorList = survivors.map((p) => ({ pid: p.pid, kind: classify(p), session: lastPerPids.get(p.pid) ?? null, rssKB: p.rssKB, cmd: p.cmd.join(' ').slice(0, 140) }));
const apiFinal = await apiStats();
try { apiChild.send({ t: 'stop' }); } catch { /* gone */ }
await sleep(300);
emit({
  soak: 'final', ok: true, cli: { version: cliVersion, path: fs.realpathSync(cliPath) }, containment, aborted: abortInfo, tSec: tSec(),
  init: S.map((s) => ({ i: s.i, ...(s.init ?? { mcpConnected: null, tools: null }) })),
  sessions: S.map((s) => ({ i: s.i, sent: s.sent, turnEnds: s.turnEnds, errors: s.errors, lastError: s.lastError, wedged: s.wedged })),
  survivors: { total: survivors.length, zombies: after.procs.filter((p) => p.state === 'Z').length, list: survivorList, teardownErrors: tdErrors },
  api: apiFinal ? { totals: apiFinal.totals, sessions: apiFinal.sessions, rssKB: apiFinal.rssKB } : null,
  endTree: endScan.per.map((p) => ({ i: p.i, procs: p.procs, k: p.byKind })),
});
process.exit(0);
