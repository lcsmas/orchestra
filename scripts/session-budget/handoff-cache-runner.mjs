// One handoff-cache rig run (#466), INSIDE the session-budget containment (harness.mjs `runHandoffCacheArm`): Orchestra's REAL path —
// agent-sdk.ts `sdkSend` ×N → the real keeper + real `claude` CLI against the local fake API (zero tokens) — with the PRODUCTION handoff host
// (handoff-host.ts: `/handoff` dispatch with the real session-key registry + a REAL bus run row, the turn-end seam, the bound nudge,
// `sdkRestart({fresh})`, the Relance delivery of the opening turn). The one thing played by the rig is the MODEL: when the request it receives
// carries the host's nudge, the fake reply is the moment the agent runs `orchestra handoff` — the rig calls the production `dispatchHandoffRequest`
// with the registered key (what the CLI verb would POST). SIMULATED: the API's prompt cache (fake-anthropic-api.mjs `cacheModel`). Last stdout line: `{"handoffCache": {...}}`.
import fs from 'node:fs';
import path from 'node:path';
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

const cfg = JSON.parse(process.env.SB_CONFIG ?? '{}');
const { REPO, root, arm, mutant = null, turns = 24, bound = 0, fillerChars = 1800, replyChars = 1200, timeoutMs = 240_000 } = cfg;
const HERE = path.join(REPO, 'scripts', 'session-budget');

const { assertScratch } = await import(`${HERE}/scratch-guard.mjs`);
const home = path.join(root, 'home');
const orchHome = path.join(root, 'orchestra');
const cfgDir = path.join(home, '.claude');
if (!Array.isArray(cfg.live) || cfg.live.length === 0) throw new Error('handoff-cache-runner: cfg.live is absent or empty — refusing to run without the scratch guard\'s live list');
for (const [label, p] of [['HOME', home], ['ORCHESTRA_HOME', orchHome], ['CLAUDE_CONFIG_DIR', cfgDir]]) assertScratch(label, p, root, cfg.live);
fs.mkdirSync(cfgDir, { recursive: true });
fs.mkdirSync(orchHome, { recursive: true });
process.env.HOME = home;
process.env.ORCHESTRA_HOME = orchHome;
process.env.CLAUDE_CONFIG_DIR = cfgDir;
if (bound > 0) process.env.ORCHESTRA_HANDOFF_BOUND_TURNS = String(bound); else delete process.env.ORCHESTRA_HANDOFF_BOUND_TURNS;

if (mutant) register(pathToFileURL(`${HERE}/mutants.mjs`).href, { parentURL: import.meta.url, data: { mutant } });
const { startFakeApi } = await import(`${HERE}/fake-anthropic-api.mjs`);

const repoDir = path.join(root, 'repo');
fs.mkdirSync(repoDir, { recursive: true });
fs.writeFileSync(path.join(repoDir, 'README.md'), '# handoff-cache rig (light fixture)\n');
execFileSync('git', ['init', '-q'], { cwd: repoDir });
execFileSync('git', ['add', '.'], { cwd: repoDir });
execFileSync('git', ['-c', 'user.email=rig@invalid', '-c', 'user.name=rig', 'commit', '-qm', 'init'], { cwd: repoDir });

const WS_ID = 'ws-handoff-rig';
const KEY = 'handoff-rig-session-key-not-real';
const SUMMARY = [
  'STATE: HANDOFF-SUMMARY-MARK — implemented the lever, tests green on branch handoff-bounded-lifetime-466.',
  'NEXT STEPS: 1. run the rig  2. nominate on the ledger.',
  'REFS: https://github.com/lcsmas/orchestra/issues/471 and fanout/ops/state.json',
  'NOT VERIFIED: the packaged app was not driven.',
].join('\n');
// deterministic filler: the prompt of turn i / the reply of turn i (distinct text per turn, so only a REAL shared prefix is cached)
const filler = (tag, i, n) => { let s = ''; for (let k = 0; s.length < n; k++) s += `${tag}${i}.${k} work log line ${(i * 7919 + k * 104729) % 100003}; `; return s.slice(0, n); };
const lastUser = (msgs) => JSON.stringify([...(msgs ?? [])].reverse().find((m) => m.role === 'user')?.content ?? '');

const out = { arm, mutant, turns, bound, nudges: 0, handoffsDispatched: 0, dispatchResults: [] };
let hostRef = null;
const api = await startFakeApi({
  apiPort: cfg.apiPort, proxyPort: cfg.proxyPort, keepMessages: true, cacheModel: true,
  reply: (rec) => {
    if (!(rec.tools > 0)) return undefined;
    const last = lastUser(rec.messages);
    if (last.includes('[Orchestra] This context has run')) {
      // THE MODEL'S MOVE: the nudge reaches it, it runs `orchestra handoff` (= POST /handoff {id,key,summary}) and ends its turn.
      out.nudges++;
      if (hostRef) {
        identity.registerSessionKey(WS_ID, KEY); // the rig plays the CLI, which holds the live key: a restart's fresh keeper registered its own meanwhile
        const r = hostRef.dispatchHandoffRequest({ id: WS_ID, key: KEY, summary: SUMMARY });
        out.handoffsDispatched++;
        out.dispatchResults.push(r.ok ? 'scheduled' : r.error.slice(0, 80));
      }
      return { text: 'REPLY-NUDGE handing off' };
    }
    if (last.includes('HANDOFF-SUMMARY-MARK')) return { text: 'REPLY-OPENING resumed from the summary' };
    const m = /PROMPT-(\d+)/.exec(last);
    return { text: `REPLY-${m ? m[1] : '?'} ${filler('r', m ? Number(m[1]) : 0, replyChars)}` };
  },
});
if (api.proxyUrl !== process.env.HTTPS_PROXY || process.env.NODE_USE_ENV_PROXY !== '1') throw new Error(`handoff-cache-runner: not routed through the recording proxy (HTTPS_PROXY=${process.env.HTTPS_PROXY}, proxy=${api.proxyUrl})`);
delete process.env.NODE_USE_ENV_PROXY;
delete process.env.ANTHROPIC_AUTH_TOKEN;
Object.assign(process.env, {
  ANTHROPIC_BASE_URL: api.url, ANTHROPIC_API_KEY: 'sk-ant-api03-handoff-rig-fake-key-not-real',
  HTTPS_PROXY: api.proxyUrl, HTTP_PROXY: api.proxyUrl, https_proxy: api.proxyUrl, http_proxy: api.proxyUrl,
  NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost',
});

const keeperSrc = path.join(REPO, 'dist-electron', 'keeper.js');
if (!fs.existsSync(keeperSrc)) throw new Error('dist-electron/keeper.js missing — run `pnpm run build:keeper` (harness.ensureBuilt does)');
fs.mkdirSync(path.join(orchHome, 'bin'), { recursive: true });
fs.copyFileSync(keeperSrc, path.join(orchHome, 'bin', 'keeper.js'));

const { initPlatform } = await import(`${REPO}/src/main/platform/index.ts`);
let turnEnds = 0;
let errorEvent = null;
initPlatform({
  kind: 'headless-handoff-rig',
  broadcast: (channel, _wsId, ev) => {
    if (channel !== 'agent:event' || !ev) return;
    if (ev.type === 'turn-end') turnEnds++;
    if (ev.type === 'error' && !errorEvent) errorEvent = ev;
  },
  broadcastPtyData: () => {}, canBroadcast: () => true, isFocused: () => false, hasAttachedUi: () => false,
  notify: () => {}, openExternal: () => {}, showItemInFolder: () => {}, openPath: () => {},
  openAccountLoginUrl: () => {}, closeAccountLogin: () => {},
  getUserDataDir: () => orchHome, getLogsDir: () => `${orchHome}/logs`, getAppVersion: () => '0.0.0-handoff-rig',
  getAppMetrics: () => [], isEncryptionAvailable: () => false, encryptString: (s) => s, decryptString: (s) => s,
});

let identity;
const { store } = await import(`${REPO}/src/main/store.ts`);
const sdk = await import(`${REPO}/src/main/agent-sdk.ts`);
const keeper = await import(`${REPO}/src/main/keeper-client.ts`);
const bus = await import(`${REPO}/src/main/bus.ts`);
const busRuns = await import(`${REPO}/src/main/bus-runs.ts`);
identity = await import(`${REPO}/src/main/session-identity-host.ts`);
const { DEFAULT_BUS_SWITCHES } = await import(`${REPO}/src/shared/bus-switches.ts`);
hostRef = await import(`${REPO}/src/main/handoff-host.ts`); // the PRODUCTION host: registers the turn-end listener at load
await store.load?.();
bus.initBus();
await store.upsertWorkspace({ id: WS_ID, name: 'impl-handoff-rig', kind: 'scratch', repoPath: '', worktreePath: repoDir, status: 'idle', createdAt: Date.now(), hasInput: true });
busRuns.startRun(bus.getBus(), { id: WS_ID, kind: 'mission', coordinator: WS_ID }, DEFAULT_BUS_SWITCHES);

const deadline = Date.now() + timeoutMs;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Quiet = no new request for `quietMs` AND every started turn ended — a nudge turn / the opening turn start a moment after a turn end. */
async function settle(quietMs = 1500) {
  let lastN = -1, lastT = Date.now();
  while (Date.now() < deadline) {
    if (errorEvent) throw new Error(`agent error event: ${errorEvent.message}`);
    const n = api.requests.length;
    if (n !== lastN) { lastN = n; lastT = Date.now(); }
    if (Date.now() - lastT >= quietMs) return;
    await sleep(100);
  }
  throw new Error('settle: deadline');
}
async function userTurn(i) {
  const want = turnEnds + 1;
  await sdk.sdkSend(WS_ID, `PROMPT-${i} ${filler('p', i, fillerChars)}`);
  while (turnEnds < want && !errorEvent && Date.now() < deadline) await sleep(25);
  if (errorEvent) throw new Error(`agent error event: ${errorEvent.message}`);
  if (turnEnds < want) throw new Error(`turn ${i} never ended`);
  await settle();
}

let error = null;
try {
  // positive controls of the instrument, once, before the run: a wrong key and a workspace with no run are REFUSED with their names
  const wrong = hostRef.dispatchHandoffRequest({ id: WS_ID, key: 'not-the-key', summary: SUMMARY });
  out.controlWrongKey = wrong.ok ? 'ACCEPTED' : wrong.error.split(':')[0];
  await store.upsertWorkspace({ id: 'ws-no-run', name: 'impl-no-run', kind: 'scratch', repoPath: '', worktreePath: repoDir, status: 'idle', createdAt: Date.now(), hasInput: true, parentId: 'ws-missing-parent' });
  identity.registerSessionKey('ws-no-run', 'k2');
  identity.registerSessionKey(WS_ID, KEY);
  const norun = hostRef.dispatchHandoffRequest({ id: 'ws-no-run', key: 'k2', summary: SUMMARY });
  out.controlNoRun = norun.ok ? 'ACCEPTED' : norun.error.split(':')[0];

  for (let i = 1; i <= turns; i++) await userTurn(i);
} catch (e) {
  error = String(e?.stack ?? e);
}

// ── what the fake API received / reported (main chain = tool-carrying requests; side calls carry no cache usage) ──
const main = api.requests.filter((r) => r.type === 'model' && r.tools > 0 && r.usage);
const sum = (k) => main.reduce((a, r) => a + (r.usage[k] ?? 0), 0);
out.mainRequests = main.length;
out.cacheReadTokens = sum('cache_read_input_tokens');
out.cacheCreationTokens = sum('cache_creation_input_tokens');
const sumPrev = (k) => main.reduce((a, r) => a + (r.usagePrev?.[k] ?? 0), 0);
out.prevOnly = { cacheReadTokens: sumPrev('cache_read_input_tokens'), cacheCreationTokens: sumPrev('cache_creation_input_tokens') };
out.lastRequestTokens = main.length ? Math.floor(main[main.length - 1].usage.prefixChars / 4) : 0;
out.maxRequestTokens = main.reduce((a, r) => Math.max(a, Math.floor(r.usage.prefixChars / 4)), 0);
out.perRequest = main.map((r) => ({ read: r.usage.cache_read_input_tokens, create: r.usage.cache_creation_input_tokens }));
const flat = (r) => JSON.stringify(r.messages ?? []);
out.openingRequests = main.filter((r) => lastUser(r.messages).includes('HANDOFF-SUMMARY-MARK')).length;
// the context REALLY ended: some request carrying the summary has no earlier user prompt in it
out.freshContextAfterHandoff = main.some((r) => lastUser(r.messages).includes('HANDOFF-SUMMARY-MARK') && !/PROMPT-\d+ /.test(flat(r).replace(/HANDOFF-SUMMARY-MARK/g, '')));
out.nudgeRequests = main.filter((r) => lastUser(r.messages).includes('[Orchestra] This context has run')).length;
out.handoffFiles = (() => { try { return fs.readdirSync(path.join(orchHome, 'handoff', WS_ID)).length; } catch { return 0; } })();

try {
  keeper.forbidKeeperLaunch(WS_ID);
  const tree = keeper.snapshotKeeperTree(WS_ID);
  await sdk.sdkStop?.(WS_ID).catch?.(() => {});
  await keeper.killKeeper(WS_ID, 'handoff-rig-teardown').catch(() => {});
  await keeper.killKeeperTree(WS_ID, tree, 'handoff-rig-teardown').catch(() => {});
} catch (e) {
  error = error ?? `teardown: ${String(e?.stack ?? e)}`;
}
bus.closeBus?.();
await api.stop().catch(() => {});
if (error) out.error = error;
console.log(JSON.stringify({ handoffCache: out }));
process.exit(0);
