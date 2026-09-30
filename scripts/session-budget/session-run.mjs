// ONE session-budget run as a FUNCTION (C4 #211): `runSession(cfg, mods)` is the body of a run, with every module it
// drives passed IN — so ONE run body serves the SOURCE runner (session-runner.mjs loads `mods` by REPO path: dev, tests,
// the release gate) and the BUNDLE a packaged app ships (bundle-entry.mjs imports `mods` statically: the app has no `src/`
// tree, and Electron 33's Node 20 has no --experimental-strip-types). No top-level await, no import.meta, no dynamic import
// of repo paths — it must bundle to CJS. The scratch guard + env pinning stay with the CALLERS (session-runner.mjs before
// it imports anything; bundle-env-guard.mjs as the bundle's first import): module load must already see scratch env.
// The harness starts BOTH callers with HTTPS_PROXY/NODE_USE_ENV_PROXY aimed at the recording proxy on `cfg.proxyPort`.
//
// Module state in agent-sdk.ts is global, so ONE run per process. Returns `{ report, judgement }`.
// (Regenerated from C1's session-runner.mjs body: ~/c4-work/port_runner.py — keep the two in step.)
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

/**
 * @param {object} cfg  harness config (see harness.mjs runContained)
 * @param {{ startFakeApi: any, generateHeavyFixture: any, census: any, judgeSessionBudget: any, summarizeWindow: any, egressUpTo: any, TRAFFIC_KNOBS: any, STARTUP_CUT_MARGIN_MS: any, initPlatform: any, store: any, sdk: any, keeper: any }} mods
 */
export async function runSession(cfg, mods) {
  const { root, arm, replyDelayMs = 500, settleMs = 2500, timeoutMs = 90_000, pidns = false, containment = 'proxy-only', profile = {}, realApi = null } = cfg;
  const { startFakeApi, generateHeavyFixture, census, judgeSessionBudget, summarizeWindow, egressUpTo, TRAFFIC_KNOBS, STARTUP_CUT_MARGIN_MS, initPlatform, store, sdk, keeper } = mods;
  const orchHome = path.join(root, 'orchestra');

  const fx = generateHeavyFixture(path.join(root, 'repo'), profile);
  // Fixed ports: this process was started with HTTPS_PROXY/NODE_USE_ENV_PROXY already aimed at the proxy port (the harness
  // chose it) — Node reads NODE_USE_ENV_PROXY at bootstrap, so the proxy must come up on exactly that port.
  if (!cfg.apiPort || !cfg.proxyPort) throw new Error('session-runner: cfg.apiPort/proxyPort absent — the app-process egress proxy cannot be wired (fails closed)');
  const api = await startFakeApi({ replyDelayMs, markers: fx.markers, apiPort: cfg.apiPort, proxyPort: cfg.proxyPort })
  if (api.proxyUrl !== process.env.HTTPS_PROXY || process.env.NODE_USE_ENV_PROXY !== '1') {
    throw new Error(`session-runner: this process is not routed through the recording proxy (HTTPS_PROXY=${process.env.HTTPS_PROXY} NODE_USE_ENV_PROXY=${process.env.NODE_USE_ENV_PROXY}, proxy=${api.proxyUrl}) — app-process egress would be invisible (fails closed)`);
  }
  delete process.env.NODE_USE_ENV_PROXY; // production parity: the env copy handed to the CLI must not carry an instrument-only var

  // The CLI's environment (buildSdkEnv copies process.env): fake API, dummy key, and the refusing proxy that NAMES
  // any host the CLI still reaches for. PRODUCTION PARITY (review F2): Orchestra sets NONE of the CLI's
  // traffic-disabling knobs (CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, DISABLE_TELEMETRY, DISABLE_AUTOUPDATER,
  // DISABLE_ERROR_REPORTING — `git grep` finds them nowhere in src/ or scripts/ outside this suite), so this run
  // sets none either; the netns makes the resulting egress attempts harmless and the proxy names them.
  // NO real credential is ever in this env.
  for (const k of [...TRAFFIC_KNOBS, 'ANTHROPIC_AUTH_TOKEN']) delete process.env[k];
  Object.assign(process.env, {
    ANTHROPIC_BASE_URL: api.url,
    ANTHROPIC_API_KEY: 'sk-ant-api03-session-budget-fake-key-not-real',
    HTTPS_PROXY: api.proxyUrl, HTTP_PROXY: api.proxyUrl, https_proxy: api.proxyUrl, http_proxy: api.proxyUrl,
    NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost',
  });
  if (realApi) throw new Error('realApi smoke is driven by smoke-real.mjs, never by this runner (D6)');

  // The keeper bundle the app would have installed at startup (`installKeeper()` copies dist-electron/keeper.js).
  // read+write, not copyFileSync: the bundled runner reads it out of app.asar.
  const keeperSrc = cfg.keeperBundle ?? path.join(cfg.REPO, 'dist-electron', 'keeper.js');
  if (!fs.existsSync(keeperSrc)) throw new Error(`${keeperSrc} missing — run \`pnpm run build:keeper\` (harness.ensureBuilt does)`);
  fs.mkdirSync(path.join(orchHome, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(orchHome, 'bin', 'keeper.js'), fs.readFileSync(keeperSrc), { mode: 0o755 });

  const events = [];
  let tInit = null, tFirstReply = null, tTurnEnd = null, initEvent = null, errorEvent = null;
  let censusAtFirstReply = null;
  let cliEnv = null;
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
        // F1 (round 2): judge the env the CLI was actually HANDED — /proc/<cli pid>/environ — not this process's own env.
        const cliProc = censusAtFirstReply.procs.find((p) => p.kind === 'cli');
        if (cliProc) {
          try {
            const keys = new Set(fs.readFileSync(`/proc/${cliProc.pid}/environ`, 'latin1').split('\0').map((kv) => kv.split('=')[0]));
            cliEnv = { cliPid: cliProc.pid, trafficKnobsSet: TRAFFIC_KNOBS.filter((k) => keys.has(k)) };
          } catch (e) { cliEnv = { cliPid: cliProc.pid, error: String(e?.message ?? e), trafficKnobsSet: null }; }
        }
      }
      if (ev.type === 'turn-end' && tTurnEnd === null) tTurnEnd = t;
    },
    broadcastPtyData: () => {}, canBroadcast: () => true, isFocused: () => false, hasAttachedUi: () => false,
    notify: () => {}, openExternal: () => {}, showItemInFolder: () => {}, openPath: () => {},
    openAccountLoginUrl: () => {}, closeAccountLogin: () => {},
    getUserDataDir: () => orchHome, getLogsDir: () => `${orchHome}/logs`, getAppVersion: () => '0.0.0-session-budget',
    getAppMetrics: () => [], isEncryptionAvailable: () => false, encryptString: (s) => s, decryptString: (s) => s,
  });


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
  let tSend = null;
  try {
    tSend = api.now(); // F5: the clock for time-to-first-reply starts HERE, not at fake-API start (runner setup is ~1.5 s)
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

  // The request windows end at the first turn's turn-end: the legitimate gauge refresh is triggered BY that event, so it can
  // never fall inside the window whatever the reply latency or observation lag (review round 2 F3); a boot read deferred past
  // the first token but before turn-end is now inside it too. No turn-end (a run that broke): everything is "before".
  const cut = tTurnEnd ?? Infinity;
  const win = (from, to) => summarizeWindow(api.requests, api.egress, from, to);
  // F2: the user's turn is the model call that CARRIES TOOLS — never "the first request" (a tool-less side call can precede it).
  const mainModel = api.requests.find((r) => r.type === 'model' && (r.tools ?? 0) > 0);
  // STARTUP egress: attempts made before the main request STARTED (headers in, body not yet read) minus a margin — a causal cut, not a race with the reply or with the request-coupled attempts.
  const startupEgress = mainModel ? egressUpTo(api.egress, mainModel.tStartMs - STARTUP_CUT_MARGIN_MS) : undefined;
  const strip = ({ procs, ...c }) => c;
  const report = {
    schema: 1,
    arm,
    runtime: { node: process.versions.node, electron: process.versions.electron ?? null },
    cli: { version: cliVersion, path: fs.realpathSync(cliPath) },
    fixture: { skills: fx.profile.skills, memoryFiles: fx.profile.memoryFiles, mcpServers: fx.profile.mcpServers, toolsPerServer: fx.profile.toolsPerServer, claudeMdKB: fx.profile.claudeMdKB },
    containment,
    ...(cfg.containmentOptOut ? { containmentOptOut: true } : {}),
    envParity: cliEnv === null ? undefined : { source: `/proc/${cliEnv.cliPid}/environ at the first reply`, trafficKnobsSet: cliEnv.trafficKnobsSet, ...(cliEnv.error ? { error: cliEnv.error } : {}) },
    timing: { timeToFirstReplyMs: tFirstReply === null || tSend === null ? null : Math.round(tFirstReply - tSend), fakeModelLatencyMs: replyDelayMs, setupMs: tSend === null ? undefined : Math.round(tSend), firstReplyAbsMs: tFirstReply === null ? undefined : Math.round(tFirstReply), turnEndAbsMs: tTurnEnd === null ? undefined : Math.round(tTurnEnd), mainRequestStartAbsMs: mainModel ? Math.round(mainModel.tStartMs) : undefined,
      startupEgressSpanMs: mainModel && api.egress.length ? Math.round(mainModel.tStartMs - api.egress[0].tMs) : undefined },
    startupEgress,
    requests: { beforeFirstReply: win(-Infinity, cut), afterFirstReply: win(cut, Infinity), total: win(-Infinity, Infinity) },
    processes: { atFirstReply: strip(censusAtFirstReply ?? { total: 0, zombies: 0, rssKB: 0, byKind: { cli: 0, keeper: 0, mcp: 0, hook: 0, other: 0 } }), atEnd: strip(censusAtEnd), survivorsAfterTeardown: survivors },
    egress: api.egress.map((e) => e.target),
    egressLog: api.egress.map((e) => ({ tMs: Math.round(e.tMs), target: e.target })),
    subject: {
      firstModelRequestTools: mainModel?.tools ?? 0,
      firstModelRequestBytes: mainModel?.bodyBytes ?? 0,
      markersSeen: mainModel?.marks ?? [],
      mcpServersConnected: (initEvent?.mcpServers ?? []).filter((s) => fx.mcpServerNames.includes(s.name) && s.status === 'connected').length,
      toolsAtInit: initEvent?.tools?.length ?? 0,
    },
    timeline: { initMs: tInit === null ? null : Math.round(tInit), turnEndMs: tTurnEnd === null ? null : Math.round(tTurnEnd) },
    paths: [...new Set(api.requests.map((r) => `${r.method} ${r.path}`))],
    requestLog: api.requests.map((r) => ({ tMs: Math.round(r.tMs), type: r.type, path: r.path, model: r.model ?? null, tools: r.tools ?? null, ...((r.tools ?? 0) === 0 && r.type === 'model' ? { preview: r.preview } : {}) })),
    ...(error || errorEvent ? { error: error ?? `agent error event: ${errorEvent?.message}` } : {}),
  };
  const judgement = judgeSessionBudget(report);
  await api.stop().catch(() => {});
  return { report, judgement };

}
