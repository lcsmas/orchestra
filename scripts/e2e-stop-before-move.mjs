// #378 — an operation that MOVES an agent's files stops (and awaits) its real SDK session first. Driven through the REAL
// dispatchAdoptRepoRequest / importWorkspaceToSandbox / ejectWorkspaceFromSandbox, the REAL sdkStartAndDeliver → ensureSession over a
// FAKE CLI (the SDK's `query()` factory) whose "turn" never ends and appends a heartbeat line to a file of the agent's worktree every
// 15 ms until it is interrupted — an agent mid-turn writing into its cwd. The sandbox is a local HTTP server that records, AT THE
// INSTANT it is hit, whether the agent session was still live and how many lines the agent had written.
//
//   adopt_live    ★ must-FAIL on master (its `stopPty(id)` stops a PTY that no longer exists): a live orchestrator adopts a repo →
//                   ok, the session is NOT live afterwards, the copy of the agent's file in the new checkout equals the source's
//                   FINAL content (no write after the snapshot), and the heartbeat stays frozen for 400 ms after the return
//   adopt_idle    — control: no session → the same adopt works (the rig can adopt; the `:run`/`:nvim` PTY stops still happen)
//   import_live   ★ must-FAIL on master: a live worktree agent is imported to a "sandbox" → when the POST /import lands the session
//                   is dead, and the payload's copy of the agent's file equals the file's final content (nothing written after staging)
//   import_idle   — control: no session → the import POST lands (the rig can import)
//   eject_live    ★ must-FAIL on master: a live session (synthetic: started local, then the record flipped to sandbox-hosted — a real
//                   sandbox agent cannot start while paused, #226) → when GET /export lands the session is dead
//
// NOT driven here (no seam can make `sdkStop` leave a session registered): the fail-closed throw of `stopAgentSessionForMove` is pinned by
// src/main/stop-before-move-wiring.test.ts and its mutant.
// Run: node --experimental-strip-types --import ./scripts/.r2-register.mjs scripts/e2e-stop-before-move.mjs <arm>
// Exit 0 = every clause PASS. The scratch HOME is `~/.cache/e2e-stop-before-move/<arm>` (never a live config dir).

import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ARM = process.argv[2] ?? 'adopt_live';
const ARMS = ['adopt_live', 'adopt_idle', 'import_live', 'import_idle', 'eject_live'];
if (!ARMS.includes(ARM)) { console.error(`unknown arm: ${ARM}`); process.exit(2); }

const tmpHome = path.join(process.env.E2E_HOME ?? path.join(os.homedir(), '.cache', 'e2e-stop-before-move'), ARM);
fs.rmSync(tmpHome, { recursive: true, force: true });
fs.mkdirSync(path.join(tmpHome, '.orchestra'), { recursive: true });
fs.mkdirSync(path.join(tmpHome, 'tmp'), { recursive: true });
process.env.ORCHESTRA_HOME = path.join(tmpHome, '.orchestra');
process.env.HOME = tmpHome;
process.env.TMPDIR = path.join(tmpHome, 'tmp');
process.env.PATH = '/usr/local/bin:/usr/bin:/bin';
for (const k of ['ORCHESTRA_WS_ID', 'ORCHESTRA_SOCK', 'CLAUDE_CONFIG_DIR']) delete process.env[k];

const { initPlatform } = await import(`${REPO}/src/main/platform/index.ts`);
initPlatform({
  kind: 'headless-e2e-stop-before-move',
  broadcast: () => {}, broadcastPtyData: () => true, canBroadcast: () => true,
  isFocused: () => false, hasAttachedUi: () => false, notify: () => {},
  openExternal: () => {}, showItemInFolder: () => {}, openPath: () => {},
  openAccountLoginUrl: () => {}, closeAccountLogin: () => {},
  getUserDataDir: () => tmpHome, getLogsDir: () => `${tmpHome}/logs`,
  getAppVersion: () => '0.0.0-e2e-stop-before-move', getAppMetrics: () => [],
  isEncryptionAvailable: () => false, encryptString: (s) => s, decryptString: (s) => s,
});
const { store } = await import(`${REPO}/src/main/store.ts`);
await (await import('./neutral-memory-guard.mjs')).neutralizeMemoryGuard(REPO);
await store.load?.();
const workspaces = await import(`${REPO}/src/main/workspaces.ts`);
const sdk = await import(`${REPO}/src/main/agent-sdk.ts`);
const delivery = await import(`${REPO}/src/main/sdk-delivery.ts`);
const sandboxImport = await import(`${REPO}/src/main/sandbox-import.ts`);
sdk.__setKillKeeperForTests?.(async () => {});   // no real keeper exists in this rig

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 5000) => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) return null; await sleep(20); } };
const sh = (cwd, ...args) => execFileSync(args[0], args.slice(1), { cwd, encoding: 'utf8' }).trim();
const lines = (f) => { try { return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).length; } catch { return -1; } };

process.on('unhandledRejection', (e) => console.log(`(unhandledRejection: ${e?.message ?? e})`));
const results = [];
const clause = (name, ok, evidence) => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} — ${evidence}`); };

// ── scratch repo + the agent's workspace ─────────────────────────────────────────
const repoPath = path.join(tmpHome, 'repo');
fs.mkdirSync(repoPath, { recursive: true });
sh(repoPath, 'git', 'init', '-q', '-b', 'main');
sh(repoPath, 'git', 'config', 'user.email', 'e2e@example.invalid');
sh(repoPath, 'git', 'config', 'user.name', 'e2e');
fs.writeFileSync(path.join(repoPath, 'README.md'), '# scratch\n');
sh(repoPath, 'git', 'add', '-A');
sh(repoPath, 'git', 'commit', '-q', '-m', 'init');
await store.addRepo({ path: repoPath, name: 'repo', defaultBranch: 'main' });

const WS = 'ws-stopmove';
const isAdopt = ARM.startsWith('adopt');
const wtPath = path.join(tmpHome, 'agent-cwd');
if (isAdopt) {
  fs.mkdirSync(wtPath, { recursive: true });
} else {
  sh(repoPath, 'git', 'worktree', 'add', '-q', '-b', 'agent-branch', wtPath, 'main');
}
fs.mkdirSync(path.join(wtPath, '.orchestra'), { recursive: true });
const HB = isAdopt ? path.join(wtPath, '.orchestra', 'hb.log') : path.join(wtPath, 'hb.log');   // adopt copies `.orchestra/`; import ships untracked files
await store.upsertWorkspace(isAdopt
  ? { id: WS, name: 'coordinator', kind: 'orchestrator', repoPath: '', branch: 'coord', baseBranch: 'main', worktreePath: wtPath, status: 'idle', createdAt: Date.now(), hasInput: false }
  : { id: WS, name: 'worker', kind: 'worktree', repoPath, branch: 'agent-branch', baseBranch: 'main', worktreePath: wtPath, status: 'idle', createdAt: Date.now(), hasInput: false });

// ── the fake CLI: a turn that never ends and writes into the agent's cwd until interrupted ──
let hbCount = 0;
sdk.__setQueryFactoryForTests(({ prompt }) => {
  let ended = false;
  let queued = 0;
  void (async () => { try { for await (const m of prompt) { void m; queued++; } } catch { /* torn down */ } })();
  return {
    async *[Symbol.asyncIterator]() {
      yield { type: 'system', subtype: 'init', session_id: 'sess-stopmove', tools: [], slash_commands: [] };
      while (!queued && !ended) await sleep(10);
      while (!ended) {                                   // the turn: an agent mid-tool writing to its cwd
        try { fs.appendFileSync(HB, `hb ${hbCount + 1}\n`); hbCount++; } catch { /* the dir moved away under a still-live agent */ }
        await sleep(15);
      }
    },
    interrupt: async () => {
      ended = true;
    },
    setModel: async () => {}, setPermissionMode: async () => {},
    mcpServerStatus: async () => ({}), supportedCommands: async () => [], supportedModels: async () => [],
    getContextUsage: async () => { await new Promise(() => {}); },
  };
});

const live = () => delivery.sdkSessionLive(WS);
async function startLiveAgent() {
  const started = await delivery.sdkStartAndDeliver(WS, 'work in your cwd');
  const writing = await waitFor(() => hbCount >= 8);
  clause('setup: the agent session is live and writing into its cwd (positive control for every clause below)', !!started && !!writing && live(), `started=${started} heartbeats=${hbCount} live=${live()}`);
  if (!started || !writing || !live()) { console.log('RIG BROKEN — setup failed'); process.exit(3); }
}

// ── the sandbox: a local HTTP server recording what the agent looked like when it was hit ──
const hits = [];
function startSandbox() {
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const hit = { method: req.method, url: req.url, liveAtHit: live(), hbAtHit: hbCount, body: Buffer.concat(chunks) };
      hits.push(hit);
      res.writeHead(req.url === '/import' ? 200 : 500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(req.url === '/import' ? { ok: true } : { ok: false, error: 'rig: stop here' }));
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, endpoint: `ws://127.0.0.1:${server.address().port}` })));
}

try {
  if (ARM === 'adopt_live' || ARM === 'adopt_idle') {
    if (ARM === 'adopt_live') await startLiveAgent();
    const before = fs.existsSync(HB) ? lines(HB) : 0;
    const res = await workspaces.dispatchAdoptRepoRequest({ id: WS, repoPath, noRestart: true });
    clause('adopt answers ok', res.ok === true, JSON.stringify({ ok: res.ok, error: res.error, branch: res.branch }));
    const newHb = res.worktreePath ? path.join(res.worktreePath, '.orchestra', 'hb.log') : '';
    const copied = lines(newHb);
    const hbAtReturn = hbCount;
    await sleep(400);
    const finalSrc = lines(HB);
    if (ARM === 'adopt_live') {
      clause('the agent session is NOT live after the adopt', !live(), `live=${live()}`);
      clause('no agent write after the snapshot: the new checkout\'s copy == the source\'s final content', copied > 0 && copied === finalSrc, `before=${before} copied=${copied} sourceFinal=${finalSrc}`);
      clause('the heartbeat stayed frozen for 400 ms after the return', hbCount === hbAtReturn, `atReturn=${hbAtReturn} 400ms later=${hbCount}`);
    } else {
      clause('control: the idle adopt copied the agent dir and left no session', !live() && res.ok === true && fs.existsSync(res.worktreePath ?? ''), `live=${live()} worktree=${res.worktreePath}`);
    }
  } else if (ARM === 'import_live' || ARM === 'import_idle') {
    if (ARM === 'import_live') await startLiveAgent();
    else fs.writeFileSync(HB, 'hb 0\n');
    const { server, endpoint } = await startSandbox();
    let err = null;
    try { await sandboxImport.importWorkspaceToSandbox(WS, endpoint); } catch (e) { err = e; }
    server.close();
    const hit = hits.find((h) => h.url === '/import');
    clause('the sandbox received the POST /import', !!hit && !err, `hit=${!!hit} err=${err?.message ?? ''}`);
    if (hit && ARM === 'import_live') {
      clause('when the POST landed the agent session was NOT live', hit.liveAtHit === false, `liveAtHit=${hit.liveAtHit}`);
      const tgz = path.join(tmpHome, 'payload.tgz');
      fs.writeFileSync(tgz, hit.body);
      const x = path.join(tmpHome, 'payload');
      fs.mkdirSync(x, { recursive: true });
      execFileSync('tar', ['-xzf', tgz, '-C', x]);
      await sleep(300);
      const shipped = lines(path.join(x, 'worktree', 'hb.log'));
      const finalLines = lines(path.join(os.homedir(), '.orchestra', 'trash', fs.readdirSync(path.join(os.homedir(), '.orchestra', 'trash'))[0] ?? '', 'hb.log'));
      clause('no agent write after staging: the shipped copy == the file\'s final content (retired to trash)', shipped > 0 && shipped === finalLines, `shipped=${shipped} final=${finalLines} hbAtHit=${hit.hbAtHit} hbNow=${hbCount}`);
    }
  } else if (ARM === 'eject_live') {
    await startLiveAgent();
    const { server, endpoint } = await startSandbox();
    await store.upsertWorkspace({ ...store.getWorkspace(WS), host: { kind: 'sandbox', endpoint } });   // synthetic: see the header
    let err = null;
    try { await sandboxImport.ejectWorkspaceFromSandbox(WS); } catch (e) { err = e; }
    server.close();
    const hit = hits.find((h) => h.url === '/export');
    clause('the sandbox received the GET /export', !!hit, `hit=${!!hit} err=${err?.message ?? ''}`);
    clause('when the export was requested the agent session was NOT live', !!hit && hit.liveAtHit === false, `liveAtHit=${hit?.liveAtHit}`);
  }
} catch (e) {
  clause('the arm ran to completion', false, `threw: ${e?.stack ?? e}`);
}

const bad = results.filter((r) => !r.ok).length;
console.log(`\n${ARM}: ${results.length - bad}/${results.length} clauses PASS${bad ? ` — ${bad} FAIL` : ''}`);
process.exit(bad ? 1 : 0);
