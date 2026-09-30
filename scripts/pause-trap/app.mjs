// The pause-trap rig's MAIN-PROCESS STAND-IN (#252 D1b): REAL src/main modules (store, bus, agent-sdk,
// keeper-client, pause-trap + its host wiring) in a headless-platform node process — the same shape as the
// session-budget runner — driving the real detached keeper and the real `claude` CLI against the scripted
// fake API. One process = one "app run": `first` seeds the fleet and starts a turn; `second` boots over the
// state `first` left (the app-restart arm). Commands arrive as JSON lines on stdin, results as JSON lines
// on stdout (`{"ev":…}` events, `{"reply":…}` answers).
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { execFileSync } from 'node:child_process';
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';

const cfg = JSON.parse(process.env.PT_CONFIG ?? '{}');
const { REPO, root, phase, apiUrl, mutant = null, scenario } = cfg;
const HERE = path.join(REPO, 'scripts', 'pause-trap');
const { assertScratch } = await import(`${REPO}/scripts/session-budget/scratch-guard.mjs`);
const home = path.join(root, 'home');
const orchHome = path.join(root, 'orchestra');
const cfgDir = path.join(home, '.claude');
if (!Array.isArray(cfg.live) || cfg.live.length === 0) throw new Error('app.mjs: cfg.live (the invoker\'s live-dir list) is absent — refusing to run without the scratch guard\'s list');
for (const [label, p] of [['HOME', home], ['ORCHESTRA_HOME', orchHome], ['CLAUDE_CONFIG_DIR', cfgDir]]) assertScratch(label, p, root, cfg.live);
fs.mkdirSync(cfgDir, { recursive: true });
fs.mkdirSync(orchHome, { recursive: true });
process.env.HOME = home;
process.env.ORCHESTRA_HOME = orchHome;
process.env.CLAUDE_CONFIG_DIR = cfgDir;
Object.assign(process.env, {
  ANTHROPIC_BASE_URL: apiUrl,
  ANTHROPIC_API_KEY: 'sk-ant-api03-pause-trap-fake-key-not-real',
  NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost',
});
for (const k of ['ANTHROPIC_AUTH_TOKEN', 'HTTPS_PROXY', 'HTTP_PROXY', 'https_proxy', 'http_proxy']) delete process.env[k];

if (mutant) register(pathToFileURL(`${HERE}/mutants.mjs`).href, { parentURL: import.meta.url, data: { mutant } });

const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
const { initPlatform } = await import(`${REPO}/src/main/platform/index.ts`);
initPlatform({
  kind: 'headless-pause-trap',
  broadcast: (channel, wsId, ev) => {
    if (channel !== 'agent:event' || !ev) return;
    if (['turn-end', 'error', 'session/attach', 'session/init'].includes(ev.type) || (ev.type === 'text-delta' && !app.sawText.has(wsId))) {
      if (ev.type === 'text-delta') app.sawText.add(wsId);
      out({ ev: ev.type, ws: wsId, stopReason: ev.stopReason ?? null, isError: ev.isError ?? null, message: ev.message ?? null, turnInFlight: ev.turnInFlight ?? null, t: Date.now() });
    }
  },
  broadcastPtyData: () => {}, canBroadcast: () => true, isFocused: () => false, hasAttachedUi: () => false,
  notify: () => {}, openExternal: () => {}, showItemInFolder: () => {}, openPath: () => {},
  openAccountLoginUrl: () => {}, closeAccountLogin: () => {},
  getUserDataDir: () => orchHome, getLogsDir: () => `${orchHome}/logs`, getAppVersion: () => '0.0.0-pause-trap',
  getAppMetrics: () => [], isEncryptionAvailable: () => false, encryptString: (s) => s, decryptString: (s) => s,
});
const app = { sawText: new Set() };

const { store } = await import(`${REPO}/src/main/store.ts`);
const busMod = await import(`${REPO}/src/main/bus.ts`);
const runsMod = await import(`${REPO}/src/main/bus-runs.ts`);
const { DEFAULT_BUS_SWITCHES } = await import(`${REPO}/src/shared/bus-switches.ts`);
const sdk = await import(`${REPO}/src/main/agent-sdk.ts`);
const activity = await import(`${REPO}/src/main/activity.ts`);
const trap = await import(`${REPO}/src/main/pause-trap.ts`);
const host = await import(`${REPO}/src/main/pause-trap-host.ts`);

// The keeper bundle the app would have installed at startup.
fs.mkdirSync(path.join(orchHome, 'bin'), { recursive: true });
fs.copyFileSync(path.join(REPO, 'dist-electron', 'keeper.js'), path.join(orchHome, 'bin', 'keeper.js'));

// A fresh install has no store.json (load() then leaves loadedFromDisk=false); the fleet this rig seeds is an EXISTING install, so start from an
// (empty) store file on disk — F10: the trap refuses to act on a store that was not loaded from disk.
const STORE_FILE = path.join(orchHome, 'orchestra', 'store.json'); // userData(=ORCHESTRA_HOME)/orchestra/store.json — the real store's path
if (!fs.existsSync(STORE_FILE)) { fs.mkdirSync(path.dirname(STORE_FILE), { recursive: true }); fs.writeFileSync(STORE_FILE, JSON.stringify({ repos: [], workspaces: [], accounts: [], selfTuneRuns: [] })); }
await store.load?.();
const version = busMod.initBus(); // the real boot gate: opens <ORCHESTRA_HOME>/bus.sqlite + migrates
out({ ev: 'booted', phase, busSchema: version });

const W = {
  lead: path.join(root, 'wt-lead'),
  ops: path.join(root, 'wt-ops'),
  w1: path.join(root, 'wt-w1'),
};
const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_AUTHOR_NAME: 'rig', GIT_AUTHOR_EMAIL: 'r@r', GIT_COMMITTER_NAME: 'rig', GIT_COMMITTER_EMAIL: 'r@r' } }).trim();

if (phase === 'first') {
  for (const [id, dir] of Object.entries(W)) {
    fs.mkdirSync(dir, { recursive: true });
    git(dir, 'init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'base\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'init');
  }
  // w1 carries UNCOMMITTED work (tracked edit + staged-then-edited + untracked): what the pause ref must hold.
  fs.writeFileSync(path.join(W.w1, 'a.txt'), 'UNCOMMITTED-EDIT\n');
  fs.writeFileSync(path.join(W.w1, 'untracked.txt'), 'UNTRACKED-WORK\n');
  const mk = (id, extra) => store.upsertWorkspace({ id, name: id, kind: 'scratch', repoPath: '', baseBranch: '', branch: id, worktreePath: W[id], status: 'idle', createdAt: Date.now(), hasInput: true, ...extra });
  await mk('lead', { kind: 'orchestrator' });
  await mk('ops', { kind: 'orchestrator', parentId: 'lead' });
  await mk('w1', { parentId: 'ops', lastTask: 'rig task: run the long command' });
  const db = busMod.getBus();
  const sw = { ...DEFAULT_BUS_SWITCHES, pause: true };
  runsMod.startRun(db, { id: 'lead', kind: 'mission', coordinator: 'lead' }, sw);
  runsMod.startRun(db, { id: 'ops', kind: 'vague', coordinator: 'ops', parentRunId: 'lead' }, sw);
  // make sure store.json has the fleet on disk before anything can kill this process (the restart arm)
  const storeFile = () => { try { return fs.readFileSync(STORE_FILE, 'utf8'); } catch { return ''; } };
  for (let i = 0; i < 100 && !(storeFile().includes('"w1"') && storeFile().includes('"ops"')); i++) await new Promise((r) => setTimeout(r, 50));
}

// THE PRODUCTION WIRING (index.ts): host deps + the turn-start observer + detection (WAL watch + sweep + boot drain).
const deps = host.buildPauseTrapDeps();
activity.setTurnStartObserver(host.makeTurnStartObserver(deps));
if (!cfg.noTrap) trap.startPauseTrap(deps);
// autopsy aid: the rig's own sweep reports every TrapSummary (the host logger is silent outside dev)
if (!cfg.noTrap) setInterval(() => void trap.sweepPauseTrap(deps).then((r) => { if (r.length) out({ ev: 'sweep', r }); }).catch((e) => out({ ev: 'sweep-error', error: String(e?.stack ?? e) })), 4000).unref();
out({ ev: 'trap-started', phase, noTrap: !!cfg.noTrap });

if (phase === 'first' && scenario) {
  if (cfg.opsScenario) await sdk.sdkSend('ops', `SCN:${cfg.opsScenario}`); // the coordinator has its OWN live session + tool (pauser-exempt arm)
  await sdk.sdkSend('w1', `SCN:${scenario}`);
  out({ ev: 'sent', ws: 'w1', scenario });
}

const rl = readline.createInterface({ input: process.stdin });
for await (const line of rl) {
  let c;
  try { c = JSON.parse(line); } catch { continue; }
  try {
    if (c.cmd === 'human-send') {
      // exactly what api-handlers agentSdkSend does for a composer prompt (origin 'human' → the registered observer marks it)
      await sdk.sdkSend(c.ws, c.text, undefined, undefined, undefined, false, false, 'human');
      out({ reply: 'human-send', ws: c.ws });
    } else if (c.cmd === 'auto-send') {
      // an AUTOMATIC send (peer message / queued follow-up): origin 'auto' — refused once paused, parked app-side if a turn is running
      await sdk.sdkSend(c.ws, c.text);
      out({ reply: 'auto-send', ws: c.ws });
    } else if (c.cmd === 'interrupt') {
      await sdk.sdkInterrupt(c.ws); // the plain human Stop button (no trap)
      out({ reply: 'interrupt', ws: c.ws });
    } else if (c.cmd === 'state') {
      const ws = store.getWorkspace(c.ws);
      out({ reply: 'state', ws: c.ws, status: ws?.status ?? null, hasSession: sdk.sdkHasSession(c.ws) });
    } else if (c.cmd === 'quit') {
      trap.stopPauseTrap();
      out({ reply: 'quit' });
      process.exit(0);
    }
  } catch (e) {
    out({ reply: 'error', cmd: c.cmd, error: String(e?.stack ?? e) });
  }
}
