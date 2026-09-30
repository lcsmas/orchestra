// One session-budget run, INSIDE its containment (see harness.mjs): Orchestra's REAL session path —
// agent-sdk.ts `sdkSend` → `ensureSession` → SDK `query()` → the real detached KEEPER → the real `claude`
// CLI — in a generated heavy fixture repo, against the LOCAL FAKE Anthropic API (zero tokens, D6).
// Module state in agent-sdk.ts is global, so ONE run per process. Config arrives as JSON in SB_CONFIG;
// the last stdout line is the JSON result `{ report, judgement }`.
import fs from 'node:fs';
import path from 'node:path';
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

const cfg = JSON.parse(process.env.SB_CONFIG ?? '{}');
const { REPO, root, arm, mutant = null, replyDelayMs = 250, settleMs = 2500, timeoutMs = 90_000, pidns = false, containment = 'proxy-only', profile = {}, realApi = null } = cfg;
const HERE = path.join(REPO, 'scripts', 'session-budget');

// D7: scratch HOME / config dir / ORCHESTRA_HOME only — refuse anything live BEFORE the app can boot.
const { assertScratch } = await import(`${HERE}/scratch-guard.mjs`);
const home = path.join(root, 'home');
const orchHome = path.join(root, 'orchestra');
const cfgDir = path.join(home, '.claude');
for (const [label, p] of [['HOME', home], ['ORCHESTRA_HOME', orchHome], ['CLAUDE_CONFIG_DIR', cfgDir]]) assertScratch(label, p, root, cfg.live ?? []);
fs.mkdirSync(cfgDir, { recursive: true });
fs.mkdirSync(orchHome, { recursive: true });
process.env.HOME = home;
process.env.ORCHESTRA_HOME = orchHome;
process.env.CLAUDE_CONFIG_DIR = cfgDir;

if (mutant) register(pathToFileURL(`${HERE}/mutants.mjs`).href, { parentURL: import.meta.url, data: { mutant } });

const { startFakeApi } = await import(`${HERE}/fake-anthropic-api.mjs`);
const { generateHeavyFixture } = await import(`${HERE}/fixture.mjs`);
const { census } = await import(`${HERE}/proc-census.mjs`);
const { judgeSessionBudget } = await import(`${REPO}/src/shared/session-budget.ts`);

const fx = generateHeavyFixture(path.join(root, 'repo'), profile);
const api = await startFakeApi({ replyDelayMs, markers: fx.markers });

// The CLI's environment (buildSdkEnv copies process.env): fake API, dummy key, traffic disabled, the
// refusing proxy for anything that still reaches for a host. NO real credential is ever in this env.
Object.assign(process.env, {
  ANTHROPIC_BASE_URL: api.url,
  ANTHROPIC_API_KEY: 'sk-ant-api03-session-budget-fake-key-not-real',
  HTTPS_PROXY: api.proxyUrl, HTTP_PROXY: api.proxyUrl, https_proxy: api.proxyUrl, http_proxy: api.proxyUrl,
  NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost',
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_TELEMETRY: '1', DISABLE_AUTOUPDATER: '1', DISABLE_ERROR_REPORTING: '1',
});
delete process.env.ANTHROPIC_AUTH_TOKEN;
if (realApi) throw new Error('realApi smoke is driven by smoke-real.mjs, never by this runner (D6)');

// The keeper bundle the app would have installed at startup (`installKeeper()` copies dist-electron/keeper.js).
const keeperSrc = path.join(REPO, 'dist-electron', 'keeper.js');
if (!fs.existsSync(keeperSrc)) throw new Error(`dist-electron/keeper.js missing — run \`pnpm run build:keeper\` (harness.ensureBuilt does)`);
fs.mkdirSync(path.join(orchHome, 'bin'), { recursive: true });
fs.copyFileSync(keeperSrc, path.join(orchHome, 'bin', 'keeper.js'));

const { initPlatform } = await import(`${REPO}/src/main/platform/index.ts`);
const events = [];
let tInit = null, tFirstReply = null, tTurnEnd = null, initEvent = null, errorEvent = null;
let censusAtFirstReply = null;
initPlatform({
  kind: 'headless-session-budget',
  broadcast: (channel, _wsId, ev) => {
    if (channel !== 'agent:event' || !ev) return;
    const t = api.now();
    events.push({ t, type: ev.type });
    if (ev.type === 'session/init' && tInit === null) { tInit = t; initEvent = ev; }
    if (ev.type === 'error' && !errorEvent) errorEvent = ev;
    if (ev.type === 'text-delta' && tFirstReply === null) {
      tFirstReply = t; // the first token the user would see
      censusAtFirstReply = census({ pidns });
    }
    if (ev.type === 'turn-end' && tTurnEnd === null) tTurnEnd = t;
  },
  broadcastPtyData: () => {}, canBroadcast: () => true, isFocused: () => false, hasAttachedUi: () => false,
  notify: () => {}, openExternal: () => {}, showItemInFolder: () => {}, openPath: () => {},
  openAccountLoginUrl: () => {}, closeAccountLogin: () => {},
  getUserDataDir: () => orchHome, getLogsDir: () => `${orchHome}/logs`, getAppVersion: () => '0.0.0-session-budget',
  getAppMetrics: () => [], isEncryptionAvailable: () => false, encryptString: (s) => s, decryptString: (s) => s,
});

const { store } = await import(`${REPO}/src/main/store.ts`);
const sdk = await import(`${REPO}/src/main/agent-sdk.ts`);
const keeper = await import(`${REPO}/src/main/keeper-client.ts`);

const WS_ID = 'ws-sb';
await store.load?.();
await store.upsertWorkspace({
  id: WS_ID, name: 'session-budget', kind: 'scratch', repoPath: '', worktreePath: fx.dir,
  status: 'idle', createdAt: Date.now(), hasInput: true,
});

const cliPath = execFileSync('sh', ['-c', 'command -v claude'], { env: process.env, encoding: 'utf8' }).trim();
const cliVersion = execFileSync(cliPath, ['--version'], { env: process.env, encoding: 'utf8' }).trim();

let error = null;
const done = new Promise((resolve) => {
  const iv = setInterval(() => { if (tTurnEnd !== null || errorEvent) { clearInterval(iv); resolve(); } }, 25);
  setTimeout(() => { clearInterval(iv); resolve(); }, timeoutMs).unref();
});
try {
  await sdk.sdkSend(WS_ID, 'Reply with the single word ok.');
  await done;
  await new Promise((r) => setTimeout(r, settleMs)); // let post-reply traffic (the turn-end gauge refresh) land
} catch (e) {
  error = String(e?.stack ?? e);
}
const censusAtEnd = census({ pidns });

// Teardown exactly as a workspace delete does (workspaces.ts stopStructuredSession), then census survivors.
let survivors = null;
try {
  keeper.forbidKeeperLaunch(WS_ID);
  const tree = keeper.snapshotKeeperTree(WS_ID);
  await sdk.sdkStop?.(WS_ID).catch?.(() => {});
  await keeper.killKeeper(WS_ID, 'session-budget-teardown').catch(() => {});
  await keeper.killKeeperTree(WS_ID, tree, 'session-budget-teardown').catch(() => {});
  await new Promise((r) => setTimeout(r, 1500));
  survivors = census({ pidns }).total;
} catch (e) {
  error = error ?? `teardown: ${String(e?.stack ?? e)}`;
}

const beforeReq = tFirstReply === null ? api.requests : api.requests.filter((r) => r.tMs <= tFirstReply);
const afterReq = tFirstReply === null ? [] : api.requests.filter((r) => r.tMs > tFirstReply);
const countOf = (rs) => {
  const c = { model: 0, count_tokens: 0, other: 0, total: rs.length };
  for (const r of rs) c[r.type === 'model' || r.type === 'count_tokens' ? r.type : 'other']++;
  return c;
};
const firstModel = api.requests.find((r) => r.type === 'model');
const strip = ({ procs, ...c }) => c;
const report = {
  schema: 1,
  arm,
  cli: { version: cliVersion, path: fs.realpathSync(cliPath) },
  fixture: { skills: fx.profile.skills, memoryFiles: fx.profile.memoryFiles, mcpServers: fx.profile.mcpServers, toolsPerServer: fx.profile.toolsPerServer, claudeMdKB: fx.profile.claudeMdKB },
  containment,
  timing: { timeToFirstReplyMs: tFirstReply === null ? null : Math.round(tFirstReply), fakeModelLatencyMs: replyDelayMs },
  requests: { beforeFirstReply: countOf(beforeReq), afterFirstReply: countOf(afterReq), total: countOf(api.requests) },
  processes: { atFirstReply: strip(censusAtFirstReply ?? { total: 0, zombies: 0, rssKB: 0, byKind: { cli: 0, keeper: 0, mcp: 0, hook: 0, other: 0 } }), atEnd: strip(censusAtEnd), survivorsAfterTeardown: survivors },
  egress: api.egress.map((e) => e.target),
  subject: {
    firstModelRequestTools: firstModel?.tools ?? 0,
    firstModelRequestBytes: firstModel?.bodyBytes ?? 0,
    markersSeen: firstModel?.marks ?? [],
    mcpServersConnected: (initEvent?.mcpServers ?? []).filter((s) => fx.mcpServerNames.includes(s.name) && s.status === 'connected').length,
    toolsAtInit: initEvent?.tools?.length ?? 0,
  },
  timeline: { initMs: tInit === null ? null : Math.round(tInit), turnEndMs: tTurnEnd === null ? null : Math.round(tTurnEnd) },
  paths: [...new Set(api.requests.map((r) => `${r.method} ${r.path}`))],
  ...(error || errorEvent ? { error: error ?? `agent error event: ${errorEvent?.message}` } : {}),
};
const judgement = judgeSessionBudget(report);
await api.stop().catch(() => {});
console.log(JSON.stringify({ report, judgement }));
process.exit(0);
