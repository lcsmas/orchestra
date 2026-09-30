// C2 #209 — MULTI-TURN session scenario, inside a network+pid namespace (see session-scenario.mjs): Orchestra's REAL
// session path (agent-sdk.ts → keeper → real `claude`) in C1's heavy fixture WITH Orchestra's real hooks installed
// (installOrchestraHooks + hooks server + events spool), against a fake API that can request tool calls. Measures, per
// turn and per idle window: API requests by type, process spawns by argv (LD_PRELOAD logger), CPU per process class.
// One scenario per process (agent-sdk.ts state is global). Result = last stdout line `{"result": …}`.
import fs from 'node:fs';
import path from 'node:path';
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

const cfg = JSON.parse(process.env.HC_CONFIG ?? '{}');
const { REPO, root, live, turns = [{ tools: 0 }, { tools: 1 }, { tools: 3 }], probeModels = false, httpMcp = 0, idleSeconds = 60, profile = {}, replyDelayMs = 150, hooks = true, execlogSo, label = 'scenario' } = cfg;
const SB = path.join(REPO, 'scripts', 'session-budget');
const { assertScratch } = await import(`${SB}/scratch-guard.mjs`);
const home = path.join(root, 'home');
const orchHome = path.join(root, 'orchestra');
const cfgDir = path.join(home, '.claude');
for (const [l, p] of [['HOME', home], ['ORCHESTRA_HOME', orchHome], ['CLAUDE_CONFIG_DIR', cfgDir]]) assertScratch(l, p, root, live);
fs.mkdirSync(cfgDir, { recursive: true }); fs.mkdirSync(orchHome, { recursive: true });
Object.assign(process.env, { HOME: home, ORCHESTRA_HOME: orchHome, CLAUDE_CONFIG_DIR: cfgDir });
const EXECLOG = path.join(root, 'execlog.txt');
fs.writeFileSync(EXECLOG, '');
if (execlogSo) Object.assign(process.env, { LD_PRELOAD: execlogSo, EXECLOG_FILE: EXECLOG });

const { startFakeApiWithTools } = await import(`${REPO}/scripts/hidden-cost/fake-api-tools.mjs`);
const { generateHeavyFixture } = await import(`${SB}/fixture.mjs`);
const api = await startFakeApiWithTools({ replyDelayMs });
const fx = generateHeavyFixture(path.join(root, 'repo'), profile);
if (httpMcp > 0) {
  // Remote (http) MCP servers as a real config has them (linear/datadog-style): unreachable inside the netns, so every attempt is a counted DNS/connect try.
  const f = path.join(fx.dir, '.mcp.json'); const j = JSON.parse(fs.readFileSync(f, 'utf8'));
  for (let i = 0; i < httpMcp; i++) j.mcpServers[`remote${i + 1}`] = { type: 'http', url: `https://mcp-remote-${i + 1}.hidden-cost.invalid/mcp` };
  fs.writeFileSync(f, JSON.stringify(j, null, 2));
}
Object.assign(process.env, {
  ANTHROPIC_BASE_URL: api.url, ANTHROPIC_API_KEY: 'sk-ant-api03-hidden-cost-fake-key-not-real',
  HTTPS_PROXY: api.proxyUrl, HTTP_PROXY: api.proxyUrl, https_proxy: api.proxyUrl, http_proxy: api.proxyUrl, NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost',
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_TELEMETRY: '1', DISABLE_AUTOUPDATER: '1', DISABLE_ERROR_REPORTING: '1',
});
delete process.env.ANTHROPIC_AUTH_TOKEN;

fs.mkdirSync(path.join(orchHome, 'bin'), { recursive: true });
const keeperSrc = path.join(REPO, 'dist-electron', 'keeper.js');
if (!fs.existsSync(keeperSrc)) throw new Error('dist-electron/keeper.js missing — pnpm run build:keeper');
fs.copyFileSync(keeperSrc, path.join(orchHome, 'bin', 'keeper.js'));

const { initPlatform } = await import(`${REPO}/src/main/platform/index.ts`);
const events = [];
const bc = { calls: 0, bytes: 0, byType: {} };   // every agent:event the app would push to the renderer over IPC
let turnEnds = 0, errorEvent = null;
initPlatform({
  kind: 'headless-hidden-cost',
  broadcast: (channel, _ws, ev) => { if (channel !== 'agent:event' || !ev) return; bc.calls++; bc.bytes += JSON.stringify(ev).length; bc.byType[ev.type] = (bc.byType[ev.type] ?? 0) + 1; events.push({ t: Number(process.hrtime.bigint() / 1000000n), type: ev.type }); if (ev.type === 'turn-end') turnEnds++; if (ev.type === 'error' && !errorEvent) errorEvent = ev; },
  broadcastPtyData: () => {}, canBroadcast: () => true, isFocused: () => false, hasAttachedUi: () => true,
  notify: () => {}, openExternal: () => {}, showItemInFolder: () => {}, openPath: () => {}, openAccountLoginUrl: () => {}, closeAccountLogin: () => {},
  getUserDataDir: () => orchHome, getLogsDir: () => `${orchHome}/logs`, getAppVersion: () => '0.0.0-hidden-cost', getAppMetrics: () => [],
  isEncryptionAvailable: () => false, encryptString: (s) => s, decryptString: (s) => s,
});
const { store } = await import(`${REPO}/src/main/store.ts`);
const sdk = await import(`${REPO}/src/main/agent-sdk.ts`);
const keeper = await import(`${REPO}/src/main/keeper-client.ts`);
const WS = 'ws-hc';
await store.load?.();
await store.upsertWorkspace({ id: WS, name: 'hidden-cost', kind: 'worktree', repoPath: fx.dir, worktreePath: fx.dir, branch: 'main', baseBranch: 'main', status: 'idle', createdAt: Date.now(), hasInput: true });
let hooksInstalled = false;
if (hooks) {
  const { installOrchestraHooks } = await import(`${REPO}/src/main/workspaces.ts`);
  const spool = await import(`${REPO}/src/main/events-spool.ts`);
  const hs = await import(`${REPO}/src/main/hooks-server.ts`);
  await installOrchestraHooks(fx.dir);
  await hs.startHooksServer();
  spool.startEventsSpool();
  hooksInstalled = fs.existsSync(path.join(fx.dir, '.claude', 'settings.local.json'));
}

// ── /proc helpers (whole pid namespace minus pid 1 and my ancestors) ───────
function readProc(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8'); const rp = stat.lastIndexOf(')'); const f = stat.slice(rp + 2).split(' ');
    const cmd = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean);
    let rssKB = 0; try { const m = /^VmRSS:\s+(\d+) kB/m.exec(fs.readFileSync(`/proc/${pid}/status`, 'utf8')); rssKB = m ? Number(m[1]) : 0; } catch { /* gone */ }  // VmRSS is kB whatever the page size (statm*4 read 4x LOW on this 16 KB-page host)
    return { pid, ppid: Number(f[1]), state: f[0], utime: Number(f[11]), stime: Number(f[12]), cutime: Number(f[13]), cstime: Number(f[14]), cmd, rssKB };
  } catch { return null; }
}
const anc = new Set([process.pid]);
for (let p = readProc(process.pid); p && p.ppid > 0 && !anc.has(p.ppid); p = readProc(p.ppid)) anc.add(p.ppid);
function classOf(p) {
  const line = p.cmd.join(' '); const a0 = p.cmd[0] ?? '';
  if (line.includes('fake-mcp-server.mjs')) return 'mcp';
  if (/(^|\/)keeper\.js(\s|$)/.test(line)) return 'keeper';
  if (/(^|\/)claude$/.test(a0) || /\/claude\/versions\//.test(a0)) return 'cli';
  if (/\.orchestra\/[a-z-]+\.sh/.test(line)) return 'hook-script';
  return 'other';
}
const cpuNow = () => {
  const t = {};
  for (const d of fs.readdirSync('/proc')) { if (!/^\d+$/.test(d)) continue; const p = readProc(Number(d)); if (!p || p.pid === 1 || anc.has(p.pid) || p.state === 'Z') continue;
    const c = classOf(p); t[c] = t[c] ?? { own: 0, kids: 0, n: 0, rssKB: 0 }; t[c].own += p.utime + p.stime; t[c].kids += p.cutime + p.cstime; t[c].n++; t[c].rssKB += p.rssKB; }
  return t;
};
const mono = () => Number(process.hrtime.bigint() / 1000000n); // CLOCK_MONOTONIC ms — the shim's clock
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const windows = [];
async function window_(name, fn) {
  const m0 = process.cpuUsage(); const c0 = cpuNow(); const t0 = mono(); const r0 = api.requests.length; const b0 = { calls: bc.calls, bytes: bc.bytes, byType: { ...bc.byType } };
  const extra = await fn();
  const t1 = mono(); const c1 = cpuNow(); const m1 = process.cpuUsage(m0); // Orchestra-main analogue: the runner process (agent-sdk consume, spool reader, hooks server, emitContext)
  const reqs = api.requests.slice(r0);
  const count = { model: 0, count_tokens: 0, other: 0 };
  for (const r of reqs) count[r.type === 'model' || r.type === 'count_tokens' ? r.type : 'other']++;
  const cpu = {};
  for (const k of new Set([...Object.keys(c0), ...Object.keys(c1)])) { const a = c0[k] ?? { own: 0, kids: 0 }, b = c1[k] ?? { own: 0, kids: 0, n: 0, rssKB: 0 }; cpu[k] = { ownCpuMs: (b.own - a.own) * 10, waitedKidsCpuMs: (b.kids - a.kids) * 10, n: b.n ?? 0, rssKB: b.rssKB ?? 0 }; }
  const rendererIpc = { events: bc.calls - b0.calls, jsonBytes: bc.bytes - b0.bytes, byType: Object.fromEntries(Object.entries(bc.byType).map(([k, n]) => [k, n - (b0.byType[k] ?? 0)]).filter(([, n]) => n > 0)) };
  windows.push({ name, t0, t1, mainProcessCpuMs: Math.round((m1.user + m1.system) / 1000), rendererIpc, seconds: Number(((t1 - t0) / 1000).toFixed(2)), requests: count, otherPaths: [...new Set(reqs.filter((r) => r.type !== 'model' && r.type !== 'count_tokens').map((r) => `${r.method} ${r.path}`))], cpu, ...(extra ?? {}) });
}

let error = null;
try {
  if (probeModels) {
    // The composer's model picker on a COLD workspace (no live session): currentClaudeRuntime + a throwaway CLI (probeRuntimeModels).
    for (const round of [1, 2]) await window_(`probe-models-${round}`, async () => { const m = await sdk.sdkListModels(WS); await sleep(1500); return { modelsReturned: m.length }; });
  }
  // Turn 0 is preceded by a `boot` window: session creation (ensureSession → keeper spawn → CLI init) is part of turn 0's cost.
  for (let i = 0; i < turns.length; i++) {
    const { tools, stream = 0 } = turns[i];
    await window_(`turn${i}-tools${tools}${stream ? `-stream${stream}` : ''}`, async () => {
      const before = turnEnds;
      await sdk.sdkSend(WS, `Reply with the single word ok. TOOLS=${tools}${stream ? ` STREAM=${stream}` : ''}`);
      const t0 = Date.now();
      while (turnEnds === before && !errorEvent && Date.now() - t0 < 90_000) await sleep(25);
      await sleep(3000); // let the turn-end gauge refresh (getContextUsage → count_tokens burst) and the Stop hook land
      return { turnEnded: turnEnds > before };
    });
  }
  await window_('idle', async () => { await sleep(idleSeconds * 1000); });
} catch (e) { error = String(e?.stack ?? e); }
const censusEnd = cpuNow();

let survivors = null;
try {
  keeper.forbidKeeperLaunch(WS);
  const tree = keeper.snapshotKeeperTree(WS);
  await sdk.sdkStop?.(WS).catch?.(() => {});
  await keeper.killKeeper(WS, 'hidden-cost-teardown').catch(() => {});
  await keeper.killKeeperTree(WS, tree, 'hidden-cost-teardown').catch(() => {});
  await sleep(1500);
  const left = cpuNow(); survivors = Object.values(left).reduce((a, x) => a + x.n, 0);
} catch (e) { error = error ?? `teardown: ${e}`; }

// ── exec log → per-window tallies ─────────────────────────────────────────
const lines = fs.existsSync(EXECLOG) ? fs.readFileSync(EXECLOG, 'utf8').split('\n').filter(Boolean) : [];
function keyOf(argv0, rest) {
  const base = path.basename(argv0);
  if (base === 'git') { const a = [...rest]; const skip = new Set(['-C', '-c']); for (let i = 0; i < a.length; i++) { if (skip.has(a[i])) { i++; continue; } if (a[i].startsWith('-')) continue; return `git ${a[i]}`; } return 'git'; }
  if (/^(ba|z)?sh$/.test(base)) { const c = rest[rest.findIndex((x) => x === '-c' || x === '-lc') + 1] ?? rest[0] ?? ''; const s = /\.orchestra\/([a-z-]+\.sh)/.exec(c) ?? /\.orchestra\/([a-z-]+\.sh)/.exec(rest.join(' ')); return s ? `${base} [hook ${s[1]}]` : `${base} ${c.slice(0, 50)}`; }
  if (base === 'node' && rest.some((x) => x.includes('fake-mcp-server'))) return 'node fake-mcp-server';
  if (base === 'claude' || /\/claude\/versions\//.test(argv0)) return 'claude (CLI)';
  if (base === 'node' && rest.some((x) => x.includes('keeper.js'))) return 'node keeper.js';
  return `${base}${rest[0] && !rest[0].startsWith('-') ? ' ' + rest[0].slice(0, 28) : ''}`;
}
const execs = lines.filter((l) => l.startsWith('EXEC ')).map((l) => { const p = l.split(' '); return { t: Number(p[1]), pid: Number(p[2]), key: keyOf(p[5] ?? p[4], p.slice(6)) }; });
const dns = lines.filter((l) => l.startsWith('DNS ')).map((l) => ({ t: Number(l.split(' ')[1]), host: l.split(' ')[3] }));
const inet = lines.filter((l) => l.startsWith('CONNECT ') && / inet6? /.test(l)).map((l) => ({ t: Number(l.split(' ')[1]), addr: l.split(' ').slice(4).join(' ') }));
for (const w of windows) {
  const tally = (arr, k) => { const o = {}; for (const x of arr) if (x.t >= w.t0 && x.t < w.t1) o[k(x)] = (o[k(x)] ?? 0) + 1; return o; };
  w.execByKey = Object.fromEntries(Object.entries(tally(execs, (x) => x.key)).sort((a, b) => b[1] - a[1]));
  w.execTotal = Object.values(w.execByKey).reduce((a, n) => a + n, 0);
  w.hookScriptExecs = execs.filter((x) => x.t >= w.t0 && x.t < w.t1 && x.key.includes('[hook ')).length;
  w.dns = tally(dns, (x) => x.host); w.connectInet = tally(inet, (x) => x.addr);
}
const first = api.requests.find((r) => r.type === 'model');
const result = {
  label, cfg: { turns, idleSeconds, hooks, profile, probeModels, httpMcp },
  controls: { hooksInstalled, execlogLines: lines.length, ranAnyHookScript: windows.some((w) => w.hookScriptExecs > 0), firstModelTools: first?.tools ?? 0, egress: api.egress.map((e) => e.target), survivorsAfterTeardown: survivors },
  windows, finalRssKB: Object.fromEntries(Object.entries(censusEnd).map(([k, v]) => [k, v.rssKB])),
  ...(error || errorEvent ? { error: error ?? `agent error: ${errorEvent?.message}` } : {}),
};
await api.stop().catch(() => {});
console.log(JSON.stringify({ result }));
process.exit(0);
