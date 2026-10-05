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
// SRC = the tree whose src/main + keeper bundle this stand-in loads (default the working tree; the `unfixed:` arms point it at a MASTER checkout).
const SRC = cfg.SRC ?? REPO;
// #254: the fleet's workers. Default = the legacy single `w1`; douce arms pass several ({ id, scenario?, files? }).
const workers = cfg.workers ?? [{ id: 'w1', scenario, legacy: true }];
const pauseSwitch = cfg.pauseSwitch !== false;
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

if (mutant) register(pathToFileURL(`${HERE}/${mutant.startsWith('reprise-') ? 'mutants-reprise-rig.mjs' : 'mutants.mjs'}`).href, { parentURL: import.meta.url, data: { mutant } });

const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
const { initPlatform } = await import(`${SRC}/src/main/platform/index.ts`);
initPlatform({
  kind: 'headless-pause-trap',
  broadcast: (channel, wsId, ev) => {
    if (channel !== 'agent:event' || !ev) return;
    if (ev.type === 'task') out({ ev: 'task', ws: wsId, kind: ev.kind, taskId: ev.taskId ?? null, status: ev.status ?? null, liveIds: ev.liveIds ?? null, t: Date.now() }); // #282: the CLI's own task lifecycle (a stop_task answers with kind 'notification' status 'stopped')
    if (['turn-end', 'error', 'session/attach', 'session/init'].includes(ev.type) || (ev.type === 'text-delta' && !app.sawText.has(wsId))) {
      if (ev.type === 'text-delta') app.sawText.add(wsId);
      out({ ev: ev.type, ws: wsId, stopReason: ev.stopReason ?? null, isError: ev.isError ?? null, message: ev.message ?? null, turnInFlight: ev.turnInFlight ?? null, t: Date.now() });
    }
  },
  broadcastPtyData: () => {}, canBroadcast: () => true, isFocused: () => false, hasAttachedUi: () => false,
  notify: () => {}, openExternal: () => {}, showItemInFolder: () => {}, openPath: () => {},
  openAccountLoginUrl: () => {}, closeAccountLogin: () => {},
  getUserDataDir: () => path.join(orchHome, 'userData'), getLogsDir: () => `${orchHome}/logs`, getAppVersion: () => '0.0.0-pause-trap',
  getAppMetrics: () => [], isEncryptionAvailable: () => false, encryptString: (s) => s, decryptString: (s) => s,
});
const app = { sawText: new Set() };

const { store } = await import(`${SRC}/src/main/store.ts`);
const busMod = await import(`${SRC}/src/main/bus.ts`);
const runsMod = await import(`${SRC}/src/main/bus-runs.ts`);
const { DEFAULT_BUS_SWITCHES } = await import(`${SRC}/src/shared/bus-switches.ts`);
const sdk = await import(`${SRC}/src/main/agent-sdk.ts`);
const activity = await import(`${SRC}/src/main/activity.ts`);
const trap = await import(`${SRC}/src/main/pause-trap.ts`);
const host = await import(`${SRC}/src/main/pause-trap-host.ts`);

// The keeper bundle the app would have installed at startup.
fs.mkdirSync(path.join(orchHome, 'bin'), { recursive: true });
fs.copyFileSync(path.join(SRC, 'dist-electron', 'keeper.js'), path.join(orchHome, 'bin', 'keeper.js'));

// A fresh install has no store.json (load() then leaves loadedFromDisk=false); the fleet this rig seeds is an EXISTING install, so start from an
// (empty) store file on disk — F10: the trap refuses to act on a store that was not loaded from disk.
const STORE_FILE = path.join(orchHome, 'userData', 'orchestra', 'store.json'); // $ORCHESTRA_HOME/userData/orchestra/store.json — the real app's path (and where the store-less CLI looks, #255 M3)
if (!fs.existsSync(STORE_FILE)) { fs.mkdirSync(path.dirname(STORE_FILE), { recursive: true }); fs.writeFileSync(STORE_FILE, JSON.stringify({ repos: [], workspaces: [], accounts: [], selfTuneRuns: [] })); }
await store.load?.();
const version = busMod.initBus(); // the real boot gate: opens <ORCHESTRA_HOME>/bus.sqlite + migrates
out({ ev: 'booted', phase, busSchema: version });

const W = { lead: path.join(root, 'wt-lead'), ops: path.join(root, 'wt-ops'), ...Object.fromEntries(workers.map((w) => [w.id, path.join(root, `wt-${w.id}`)])) };
const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_AUTHOR_NAME: 'rig', GIT_AUTHOR_EMAIL: 'r@r', GIT_COMMITTER_NAME: 'rig', GIT_COMMITTER_EMAIL: 'r@r' } }).trim();

if (phase === 'first') {
  for (const [id, dir] of Object.entries(W)) {
    fs.mkdirSync(dir, { recursive: true });
    git(dir, 'init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'base\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'init');
  }
  // legacy w1 carries UNCOMMITTED work (tracked edit + staged-then-edited + untracked): what the pause ref must hold.
  if (workers.some((w) => w.legacy)) {
    fs.writeFileSync(path.join(W.w1, 'a.txt'), 'UNCOMMITTED-EDIT\n');
    fs.writeFileSync(path.join(W.w1, 'untracked.txt'), 'UNTRACKED-WORK\n');
  }
  // #254 douce workers: a local BARE origin (the member's "commit + push your own work" lands there) and its own uncommitted files.
  for (const w of workers.filter((x) => !x.legacy)) {
    const bare = path.join(root, `origin-${w.id}.git`);
    git(root, 'init', '-q', '--bare', '-b', 'main', bare);
    git(W[w.id], 'remote', 'add', 'origin', bare);
    git(W[w.id], 'push', '-q', 'origin', 'main');
    for (const [name, content] of Object.entries(w.files ?? {})) fs.writeFileSync(path.join(W[w.id], name), content);
  }
  const mk = (id, extra) => store.upsertWorkspace({ id, name: id, kind: 'scratch', repoPath: '', baseBranch: '', branch: id, worktreePath: W[id], status: 'idle', createdAt: Date.now(), hasInput: true, ...extra });
  await mk('lead', { kind: 'orchestrator' });
  await mk('ops', { kind: 'orchestrator', parentId: 'lead' });
  for (const w of workers) await mk(w.id, { parentId: 'ops', lastTask: `rig task of ${w.id}` });
  const db = busMod.getBus();
  const sw = { ...DEFAULT_BUS_SWITCHES, pause: pauseSwitch };
  runsMod.startRun(db, { id: 'lead', kind: 'mission', coordinator: 'lead' }, sw);
  runsMod.startRun(db, { id: 'ops', kind: 'vague', coordinator: 'ops', parentRunId: 'lead' }, sw);
  // make sure store.json has the fleet on disk before anything can kill this process (the restart arm)
  const storeFile = () => { try { return fs.readFileSync(STORE_FILE, 'utf8'); } catch { return ''; } };
  for (let i = 0; i < 100 && !(storeFile().includes(`"${workers.at(-1).id}"`) && storeFile().includes('"ops"')); i++) await new Promise((r) => setTimeout(r, 50));
}

// THE PRODUCTION WIRING (index.ts): host deps + the turn-start observer + detection (WAL watch + sweep + boot drain).
const deps = host.buildPauseTrapDeps();
if (cfg.noStopTask) delete deps.stopTask; // #282: the documented FALLBACK (signals only) — keeps the CLI-started-turn OBSERVER arms (rows 29/30) honest: a SIGTERMed bg task makes the CLI start a turn by itself
activity.setTurnStartObserver(host.makeTurnStartObserver(deps));
if (!cfg.noTrap) trap.startPauseTrap(deps);
// NO rig-side sweep: detection is ONLY the production path (startPauseTrap: boot drain + WAL dir watch + timer) — a second trigger here defeated the no-trap mutant
out({ ev: 'trap-started', phase, noTrap: !!cfg.noTrap });

if (phase === 'first' && scenario) {
  if (cfg.opsScenario) await sdk.sdkSend('ops', `SCN:${cfg.opsScenario}`); // the coordinator has its OWN live session + tool (pauser-exempt arm)
  if (cfg.w2Scenario && W.w2) await sdk.sdkSend('w2', `SCN:${cfg.w2Scenario}`);
  await sdk.sdkSend('w1', `SCN:${scenario}`);
  out({ ev: 'sent', ws: 'w1', scenario });
}
if (phase === 'first' && !scenario) {
  // #254: each douce worker starts its own turn (the order the arm lists them in)
  for (const w of workers.filter((x) => x.scenario)) {
    await sdk.sdkSend(w.id, `SCN:${w.scenario}`);
    out({ ev: 'sent', ws: w.id, scenario: w.scenario, t: Date.now() });
  }
  out({ ev: 'all-sent' });
}

// #254: a stand-in for the app's socket: `/busStatus` answered with the REAL bus readers, so the REAL built `orchestra bus-status` prints the pause line.
if (process.env.ORCHESTRA_SOCK && cfg.statusSock) {
  const douce = await import(`${SRC}/src/main/pause-douce.ts`).catch(() => null);
  const http = await import('node:http');
  try { fs.rmSync(process.env.ORCHESTRA_SOCK, { force: true }); } catch { /* none */ }
  http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      let runId = 'default';
      try { runId = JSON.parse(body).runId || runId; } catch { /* default */ }
      const db = busMod.getBus();
      const payload = { ok: true, runId: 'host-rig', counters: [], busAvailable: !!db, badRecipientCount: 0, badRecipients: [], ...(db ? runsMod.busStatusRunView(db, runId, '{}') : {}), ...(db && douce ? douce.busStatusPausePayload(db, runId, (id) => store.getWorkspace(id)?.name ?? null) : {}) };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
    });
  }).listen(process.env.ORCHESTRA_SOCK);
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
    } else if (c.cmd === 'bgtasks') {
      // #282 probe: the background tasks the app-side session tracks for this member (ids come from the CLI's task_started / background_tasks_changed)
      out({ reply: 'bgtasks', ws: c.ws, tasks: sdk.sdkPauseActivity(c.ws)?.bgTasks ?? null });
    } else if (c.cmd === 'stop-task') {
      out({ reply: 'stop-task', ws: c.ws, taskId: c.taskId, ok: await sdk.sdkStopTask(c.ws, c.taskId) });
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
