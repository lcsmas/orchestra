// One Relance rig run (#427), INSIDE the session-budget containment (harness.mjs `runRelanceArm`): Orchestra's REAL path — agent-sdk.ts `sdkSend` → the real keeper + real `claude` CLI against the
// local fake API (zero tokens) — with the PRODUCTION Relance (relance-host.ts: store roster, kernel-scope census, `sdkStartAndDeliver` behind Admission). A member's model calls the real Bash tool to
// launch DETACHED scripts (`setsid … &`, exactly the incident's shape) and ends its turn; the rig then lets a script end and observes what the fleet observes: did the member get a turn, which, how many.
// The kernel scope is the one thing not real: no systemd user manager exists in the pid namespace, so a FAKE cgroup tree (ORCHESTRA_CGROUP_ROOT) is fed every 100 ms from a REAL /proc scan (the
// processes of the script's session) — the census, the roles, the identity re-reads and the sweep over it are the shipped code. `cfg.relance=false` is the control arm: the mechanism is never started.
// Last stdout line: `{"relance": {...}}`.
import fs from 'node:fs';
import path from 'node:path';
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

const cfg = JSON.parse(process.env.SB_CONFIG ?? '{}');
const { REPO, root, arm, mutant = null, relance = true, timeoutMs = 150_000 } = cfg;
const HERE = path.join(REPO, 'scripts', 'session-budget');

const { assertScratch } = await import(`${HERE}/scratch-guard.mjs`);
const home = path.join(root, 'home');
const orchHome = path.join(root, 'orchestra');
const cfgDir = path.join(home, '.claude');
if (!Array.isArray(cfg.live) || cfg.live.length === 0) throw new Error('relance-runner: cfg.live is absent or empty — refusing to run without the scratch guard\'s live list');
for (const [label, p] of [['HOME', home], ['ORCHESTRA_HOME', orchHome], ['CLAUDE_CONFIG_DIR', cfgDir]]) assertScratch(label, p, root, cfg.live);
fs.mkdirSync(cfgDir, { recursive: true });
fs.mkdirSync(orchHome, { recursive: true });
process.env.HOME = home;
process.env.ORCHESTRA_HOME = orchHome;
process.env.CLAUDE_CONFIG_DIR = cfgDir;

// the fake kernel: the scope tree the production census reads (realScopeEnv() honours ORCHESTRA_CGROUP_ROOT) — under the scratch root, never the host's cgroup tree
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

// what each member's model does on its launch prompt: N detached scripts (each ends when its release file appears) and optionally a "server" that keeps running
const PLAN = {};
const scriptCmd = (mark, k) => {
  const d = path.join(sigDir, mark);
  return `setsid sh -c ': RELSCRIPT-${mark}-${k}; echo $$ > ${d}/pid-${k}; while [ ! -e ${d}/rel-${k} ]; do sleep 0.2; done' </dev/null >/dev/null 2>&1 &`;
};
const launchCommand = (mark) => {
  const { scripts, server } = PLAN[mark];
  const lines = [];
  for (let k = 1; k <= scripts; k++) lines.push(scriptCmd(mark, k));
  if (server) lines.push(scriptCmd(mark, 'server'));
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
    if (last.includes('tool_result')) return { text: 'REPLY-LAUNCHED' };
    const mark = /PROMPT-LAUNCH MARK-([a-z0-9]+)/.exec(last)?.[1];
    if (mark && PLAN[mark]) return { toolUse: { name: 'Bash', input: { command: launchCommand(mark), description: 'launch detached scripts' } } };
    return { text: 'REPLY' };
  },
});
if (api.proxyUrl !== process.env.HTTPS_PROXY || process.env.NODE_USE_ENV_PROXY !== '1') {
  throw new Error(`relance-runner: not routed through the recording proxy (HTTPS_PROXY=${process.env.HTTPS_PROXY}, proxy=${api.proxyUrl})`);
}
delete process.env.NODE_USE_ENV_PROXY;
delete process.env.ANTHROPIC_AUTH_TOKEN;
Object.assign(process.env, {
  ANTHROPIC_BASE_URL: api.url,
  ANTHROPIC_API_KEY: 'sk-ant-api03-relance-rig-fake-key-not-real',
  HTTPS_PROXY: api.proxyUrl, HTTP_PROXY: api.proxyUrl, https_proxy: api.proxyUrl, http_proxy: api.proxyUrl,
  NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost',
});

const keeperSrc = path.join(REPO, 'dist-electron', 'keeper.js');
if (!fs.existsSync(keeperSrc)) throw new Error('dist-electron/keeper.js missing — run `pnpm run build:keeper` (harness.ensureBuilt does)');
fs.mkdirSync(path.join(orchHome, 'bin'), { recursive: true });
fs.copyFileSync(keeperSrc, path.join(orchHome, 'bin', 'keeper.js'));

const { initPlatform } = await import(`${REPO}/src/main/platform/index.ts`);
const turnEnds = new Map();
let errorEvent = null;
initPlatform({
  kind: 'headless-relance-rig',
  broadcast: (channel, wsId, ev) => {
    if (channel !== 'agent:event' || !ev) return;
    if (ev.type === 'turn-end') turnEnds.set(wsId, (turnEnds.get(wsId) ?? 0) + 1);
    if (ev.type === 'error' && !errorEvent) errorEvent = ev;
  },
  broadcastPtyData: () => {}, canBroadcast: () => true, isFocused: () => false, hasAttachedUi: () => false,
  notify: () => {}, openExternal: () => {}, showItemInFolder: () => {}, openPath: () => {},
  openAccountLoginUrl: () => {}, closeAccountLogin: () => {},
  getUserDataDir: () => orchHome, getLogsDir: () => `${orchHome}/logs`, getAppVersion: () => '0.0.0-relance-rig',
  getAppMetrics: () => [], isEncryptionAvailable: () => false, encryptString: (s) => s, decryptString: (s) => s,
});

const { store } = await import(`${REPO}/src/main/store.ts`);
const sdk = await import(`${REPO}/src/main/agent-sdk.ts`);
const keeper = await import(`${REPO}/src/main/keeper-client.ts`);
const sdkDelivery = await import(`${REPO}/src/main/sdk-delivery.ts`);
const host = await import(`${REPO}/src/main/relance-host.ts`);
const { RELANCE_MIN_AGE_MS } = await import(`${REPO}/src/shared/relance.ts`);
await store.load?.();

const deadline = Date.now() + timeoutMs;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const wsIds = [];

async function makeWs(id, over = {}) {
  const dir = path.join(root, `repo-${id}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'README.md'), '# relance rig\n');
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['-c', 'user.email=rig@invalid', '-c', 'user.name=rig', 'commit', '-qm', 'init'], { cwd: dir });
  await store.upsertWorkspace({ id, name: id, kind: 'scratch', repoPath: '', worktreePath: dir, status: 'idle', createdAt: Date.now() - 3600_000, hasInput: true, ...over });
  fs.mkdirSync(path.join(sigDir, id.replace(/^ws-/, '')), { recursive: true });
  wsIds.push(id);
}
const markOf = (id) => id.replace(/^ws-/, '');

// ── the fake kernel: a scope per member holding the processes of its detached scripts' sessions (REAL /proc scan) ──
const scopeUnit = (id) => `orchestra-ws-${id}-aaaaaa.scope`;
function sessionsOf(id) {
  const d = path.join(sigDir, markOf(id));
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
  for (const name of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const st = fs.readFileSync(`/proc/${name}/stat`, 'utf8');
      const f = st.slice(st.lastIndexOf(')') + 2).split(' '); // state ppid pgrp session …
      if (f[0] !== 'Z' && want.has(Number(f[3]))) out.push(Number(name));
    } catch { /* gone */ }
  }
  return out;
}
const listedEver = new Map();
function feedKernel() {
  for (const id of wsIds) {
    let pids = [];
    try { pids = procsInSessions(sessionsOf(id)); } catch { /* member dir gone */ }
    const dir = path.join(slice, scopeUnit(id));
    if (pids.length === 0) { fs.rmSync(dir, { recursive: true, force: true }); continue; }
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'cgroup.procs'), pids.join('\n') + '\n');
    listedEver.set(id, Math.max(listedEver.get(id) ?? 0, pids.length));
  }
}
const kernel = setInterval(() => { try { feedKernel(); } catch { /* next tick */ } }, 100);

const pidOf = (id, k) => Number(fs.readFileSync(path.join(sigDir, markOf(id), `pid-${k}`), 'utf8').trim());
const alive = (pid) => { try { const st = fs.readFileSync(`/proc/${pid}/stat`, 'utf8'); return st.slice(st.lastIndexOf(')') + 2)[0] !== 'Z'; } catch { return false; } };
const release = (id, k) => fs.writeFileSync(path.join(sigDir, markOf(id), `rel-${k}`), '');
async function waitFor(fn, ms) {
  const until = Math.min(deadline, Date.now() + ms);
  while (Date.now() < until) { if (await fn()) return true; await sleep(100); }
  return !!(await fn());
}

/** Relance turns a member received: model requests whose last user message is the Relance, in the conversation of THIS member (its mark). */
const relanceTurns = (id) => api.requests.filter((r) => r.type === 'model' && r.tools > 0 && lastUser(r.messages).includes('[orchestra] Relance') && JSON.stringify(r.messages).includes(`MARK-${markOf(id)}`));
async function launch(id, scripts, server = false) {
  PLAN[markOf(id)] = { scripts, server };
  const want = (turnEnds.get(id) ?? 0) + 1;
  await sdk.sdkSend(id, `PROMPT-LAUNCH MARK-${markOf(id)} go`);
  if (!(await waitFor(() => (turnEnds.get(id) ?? 0) >= want || errorEvent, 60_000)) || errorEvent) throw new Error(`launch turn of ${id} never ended${errorEvent ? `: ${errorEvent.message}` : ''}`);
  const need = scripts + (server ? 1 : 0);
  if (!(await waitFor(() => fs.readdirSync(path.join(sigDir, markOf(id))).filter((n) => n.startsWith('pid-')).length >= need, 10_000))) throw new Error(`${id}: the Bash tool did not launch ${need} detached script(s)`);
}

const out = { arm, mutant, relance, scenarios: {} };
let error = null;
try {
  // the coordinator exists (a member needs a live parent) but never runs; `ws-solo` has none
  await makeWs('ws-lead', { name: 'lead', status: 'idle' });
  const member = (id) => makeWs(id, { parentId: 'ws-lead', lastTask: `do ${id}`, kind: 'scratch' });
  await member('ws-basic');
  await member('ws-survivor');
  await member('ws-group');
  await member('ws-veille');
  await makeWs('ws-solo', { lastTask: 'do solo' }); // a task but NO coordinator
  await launch('ws-basic', 1);
  await launch('ws-survivor', 1, true);
  await launch('ws-group', 3);
  await launch('ws-veille', 1);
  await launch('ws-solo', 1);
  for (const id of ['ws-basic', 'ws-survivor', 'ws-group', 'ws-veille', 'ws-solo']) out.scenarios[markOf(id)] = { status: store.getWorkspace(id)?.status };
  // Veille: the session is stopped while its detached script lives on (the script is a Reliquat of a sleeping member)
  await sdk.sdkStop('ws-veille', { hibernate: true });
  await keeper.killKeeper('ws-veille', 'relance-rig-hibernate');
  out.scenarios.veille.sessionLiveBefore = sdkDelivery.sdkSessionLive('ws-veille');
  // let the kernel feed list every script, THEN start the mechanism: what lives now is the baseline, not an end
  await waitFor(() => ['ws-basic', 'ws-survivor', 'ws-group', 'ws-veille', 'ws-solo'].every((id) => (listedEver.get(id) ?? 0) >= 1), 5_000);
  if (relance) host.startRelanceHost();
  await sleep(RELANCE_MIN_AGE_MS + 6_000); // the baseline: the scripts must be KNOWN for the minimum age before their end can count
  out.baselineTurns = Object.fromEntries(['basic', 'survivor', 'group', 'veille', 'solo'].map((m) => [m, relanceTurns(`ws-${m}`).length]));
  out.listedEver = Object.fromEntries([...listedEver]);
  out.aliveBefore = { basic: alive(pidOf('ws-basic', 1)), group: [1, 2, 3].every((k) => alive(pidOf('ws-group', k))), survivor: alive(pidOf('ws-survivor', 'server')) };

  // the scripts end: basic's, survivor's (its server keeps running), group's three one after the other, veille's, solo's
  const t0 = Date.now();
  release('ws-basic', 1);
  release('ws-survivor', 1);
  release('ws-veille', 1);
  release('ws-solo', 1);
  release('ws-group', 1);
  await sleep(2_000);
  release('ws-group', 2);
  await sleep(2_000);
  release('ws-group', 3);
  const gone = await waitFor(() => !alive(pidOf('ws-basic', 1)) && !alive(pidOf('ws-survivor', 1)) && !alive(pidOf('ws-veille', 1)) && !alive(pidOf('ws-solo', 1)) && [1, 2, 3].every((k) => !alive(pidOf('ws-group', k))), 15_000);
  out.scriptsEnded = gone;
  out.survivorServerAlive = alive(pidOf('ws-survivor', 'server'));
  // observation window: long enough for sweep (5 s) + grouping (15 s) + a resumed start, and for a DUPLICATE to show; the control arm waits the same
  const window = cfg.windowMs ?? 50_000;
  if (relance) await waitFor(() => ['basic', 'survivor', 'group', 'veille'].every((m) => relanceTurns(`ws-${m}`).length >= 1), window);
  await sleep(relance ? 20_000 : window); // a second turn per group would land here
  for (const m of ['basic', 'survivor', 'group', 'veille', 'solo']) {
    const turns = relanceTurns(`ws-${m}`);
    Object.assign(out.scenarios[m], { relances: turns.length, text: turns[0] ? lastUser(turns[0].messages).slice(0, 2000) : null });
  }
  out.scenarios.veille.sessionLiveAfter = sdkDelivery.sdkSessionLive('ws-veille');
  out.scenarios.veille.resumedConversation = relanceTurns('ws-veille').some((r) => JSON.stringify(r.messages).includes('PROMPT-LAUNCH'));
  out.elapsedMsSinceRelease = Date.now() - t0;
} catch (e) {
  error = String(e?.stack ?? e);
}

clearInterval(kernel);
host.stopRelance?.();
// release everything still holding, then tear the sessions down
for (const id of wsIds) {
  try { for (const n of fs.readdirSync(path.join(sigDir, markOf(id)))) if (n.startsWith('pid-')) fs.writeFileSync(path.join(sigDir, markOf(id), `rel-${n.slice(4)}`), ''); } catch { /* none */ }
}
for (const id of wsIds) {
  try {
    keeper.forbidKeeperLaunch(id);
    const tree = keeper.snapshotKeeperTree(id);
    await sdk.sdkStop?.(id).catch?.(() => {});
    await keeper.killKeeper(id, 'relance-rig-teardown').catch(() => {});
    await keeper.killKeeperTree(id, tree, 'relance-rig-teardown').catch(() => {});
  } catch (e) {
    error = error ?? `teardown: ${String(e?.stack ?? e)}`;
  }
}
await api.stop().catch(() => {});
if (error) out.error = error;
console.log(JSON.stringify({ relance: out }));
process.exit(0);
