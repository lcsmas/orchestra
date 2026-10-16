// One session-identity arm (#379 / ADR 0008), INSIDE the session-budget containment (harness.mjs): the REAL `sdkSend` → real keeper →
// real `claude` CLI against the local fake Anthropic API (zero tokens), the REAL hooks server on a real `$ORCHESTRA_SOCK`, the BUILT
// `orchestra` CLI as the Bash tool's `orchestra`, a REAL bus.sqlite. The fake model is scripted to run Bash tool calls (`orchestra
// promote`, `orchestra send`, `orchestra check`); every fact is read from ground truth (/proc, the bus db, session-keys.json, files).
// MEASURES only — the verdict is judge.mjs. The session KEY is never printed, logged or put in a fact: only its length / sha256.
// Last stdout line: `{"identity": {arm, facts | error}}`.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import net from 'node:net';
import { spawn, execFileSync } from 'node:child_process';

const cfg = JSON.parse(process.env.SB_CONFIG ?? '{}');
const { REPO, root, arm, phase = 'all', timeoutMs = 100_000 } = cfg;
const HERE = path.join(REPO, 'scripts', 'session-budget');
const SELF = new URL(import.meta.url).pathname;

// ── everything this process prints is kept (bounded) so the end of the run can prove the key was never in it ──
const outBuf = [];
let outBytes = 0;
for (const s of [process.stdout, process.stderr]) {
  const w = s.write.bind(s);
  s.write = (c, ...a) => {
    if (outBytes < 4_000_000) { const t = typeof c === 'string' ? c : Buffer.from(c).toString('latin1'); outBuf.push(t); outBytes += t.length; }
    return w(c, ...a);
  };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha256 = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');
const emitResult = (obj) => console.log(JSON.stringify({ identity: obj }));

const LEAD = 'ws-si-lead';
const MEMBER = 'ws-si-member';
const KEY_ENV = 'ORCHESTRA_SESSION_KEY';

// ═════════════ phase "supervise": the attach arm needs TWO app processes sharing one ORCHESTRA_HOME (the keeper survives the first) ═════════════
if (phase === 'supervise') {
  const runPhase = (ph) => new Promise((resolve) => {
    const child = spawn(process.execPath, [...process.execArgv, SELF], { env: { ...process.env, SB_CONFIG: JSON.stringify({ ...cfg, phase: ph }) }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    const t = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, timeoutMs + 30_000);
    child.on('close', (code) => {
      clearTimeout(t);
      const line = out.split('\n').reverse().find((l) => l.startsWith('{"identity"'));
      let parsed = null;
      try { parsed = line ? JSON.parse(line).identity : null; } catch { /* below */ }
      resolve({ code, parsed, err: err.trim().slice(-400) });
    });
  });
  const p1 = await runPhase('attach1');
  if (!p1.parsed || p1.parsed.error) { emitResult({ arm, error: `phase 1 failed (rc=${p1.code}): ${p1.parsed?.error ?? p1.err}` }); process.exit(0); }
  // The first app instance is GONE (process exit, no sdkStop): the keeper + CLI are detached and live on — the real quit shape.
  const p2 = await runPhase('attach2');
  if (!p2.parsed || p2.parsed.error) { emitResult({ arm, error: `phase 2 failed (rc=${p2.code}): ${p2.parsed?.error ?? p2.err}` }); process.exit(0); }
  const facts = p2.parsed.facts;
  facts.phase1 = p1.parsed.facts;
  facts.leak.runnerOutput = !!(facts.leak.runnerOutput || p1.parsed.facts.leak.runnerOutput);
  emitResult({ arm, facts });
  process.exit(0);
}

// ═════════════ an app process (phase all | attach1 | attach2) ═════════════
const { assertScratch } = await import(`${HERE}/scratch-guard.mjs`);
const { census } = await import(`${HERE}/proc-census.mjs`);
const home = path.join(root, 'home');
const orchHome = path.join(root, 'orchestra');
const cfgDir = path.join(home, '.claude');
if (!Array.isArray(cfg.live) || cfg.live.length === 0) throw new Error('identity-runner: cfg.live is absent or empty — refusing to run without the scratch guard\'s live list');
for (const [label, p] of [['HOME', home], ['ORCHESTRA_HOME', orchHome], ['CLAUDE_CONFIG_DIR', cfgDir]]) assertScratch(label, p, root, cfg.live);
fs.mkdirSync(cfgDir, { recursive: true });
fs.mkdirSync(orchHome, { recursive: true });
for (const k of Object.keys(process.env)) if (/^(ORCHESTRA_|CLAUDE_CODE_|CLAUDECODE)/.test(k) && k !== 'ORCHESTRA_NEVER') delete process.env[k];
delete process.env.CLAUDE_CONFIG_DIR;
Object.assign(process.env, { HOME: home, ORCHESTRA_HOME: orchHome, CLAUDE_CONFIG_DIR: cfgDir, ORCHESTRA_AGENT_TMP_BASE: 'off' }); // 'off': a scratch home must not leave a /var/tmp/orch-* root

const repoDir = path.join(root, 'repo');           // the member's worktree: a tiny git repo
const leadDir = path.join(root, 'lead');
const CLI = path.join(REPO, 'dist-electron', 'cli.js');
const REGISTRY = path.join(orchHome, 'session-keys.json');
const userData = path.join(orchHome, 'userData'); // the app's own rule (src/main/index.ts): userData = $ORCHESTRA_HOME/userData — the CLI's OFFLINE store read depends on it

// ── the fake model's script: one PLAN per prompt marker; a plan is a list of Bash tool calls then a final text ──
const bash = (id, command, before) => ({ id, before, command: `${command}; rc=$?; echo "RIG-RC=$rc"; exit $rc` });
const hooksRef = { mod: null };
const PLANS = {
  same_turn: [{ marker: 'PROMPT-SI-1', final: 'REPLY-SI-DONE', steps: [
    bash('toolu_si_promote', 'orchestra promote "$ORCHESTRA_WS_ID"'),
    bash('toolu_si_send', `orchestra send --type status --to ${LEAD} "same-turn-379"`),
  ] }],
  app_closed: [{ marker: 'PROMPT-AC-1', final: 'REPLY-AC-DONE', steps: [
    bash('toolu_ac_promote', 'orchestra promote "$ORCHESTRA_WS_ID"'),
    // The app goes away BETWEEN the promote and the next tool call (the model's next request is answered after promote's reply).
    bash('toolu_ac_send', `orchestra send --type status --to ${LEAD} "app-closed-379"`, () => { facts.hookSock = hooksRef.mod.getHookSocketPath(); hooksRef.mod.stopHooksServer(); }),
    bash('toolu_ac_check', 'orchestra check'),
  ] }],
  superseded: [
    { marker: 'PROMPT-SUP-1', final: 'REPLY-SUP-1', steps: [] },
    { marker: 'PROMPT-SUP-2', final: 'REPLY-SUP-2', steps: [bash('toolu_sup_send', `orchestra send --type status --to ${LEAD} "new-session-379"`)] },
  ],
  attach_keeps_key: [
    { marker: 'PROMPT-ATT-1', final: 'REPLY-ATT-1', steps: [] },
    { marker: 'PROMPT-ATT-2', final: 'REPLY-ATT-2', steps: [bash('toolu_att_send', `orchestra send --type status --to ${LEAD} "attach-379"`)] },
  ],
}[arm];
if (!PLANS) throw new Error(`unknown arm ${arm}`);
const facts = { leak: {}, steps: {} };
const scriptErrors = [];

function route(rec) {
  try {
    if (!(rec.tools > 0)) return undefined;
    const lastUser = [...(rec.messages ?? [])].reverse().find((m) => m.role === 'user');
    const blocks = Array.isArray(lastUser?.content) ? lastUser.content : [];
    const trIds = blocks.filter((b) => b?.type === 'tool_result').map((b) => b.tool_use_id);
    const flat = JSON.stringify(lastUser?.content ?? '');
    const next = (p, i) => {
      const step = p.steps[i];
      if (!step) return { text: p.final };
      step.before?.();
      snapshotAt(step.id);
      return { toolUse: { id: step.id, name: 'Bash', input: { command: step.command, description: 'session-identity rig step' } } };
    };
    for (const p of PLANS) {
      const idx = p.steps.findIndex((s) => trIds.includes(s.id));
      if (idx >= 0) return next(p, idx + 1);
      if (!trIds.length && flat.includes(p.marker)) return next(p, 0);
    }
    facts.unrouted = true;
    return { text: 'REPLY-UNROUTED' };
  } catch (e) {
    scriptErrors.push(String(e?.stack ?? e).slice(0, 300));
    return undefined;
  }
}

// ── /proc ground truth ──
const environOf = (pid) => {
  try {
    const m = {};
    for (const kv of fs.readFileSync(`/proc/${pid}/environ`, 'latin1').split('\0')) { const i = kv.indexOf('='); if (i > 0) m[kv.slice(0, i)] = kv.slice(i + 1); }
    return m;
  } catch { return null; }
};
const startOf = (pid) => { try { const s = fs.readFileSync(`/proc/${pid}/stat`, 'utf8'); return s.slice(s.lastIndexOf(')') + 2).split(' ')[19]; } catch { return null; } };
const ident = (pid) => (pid ? { pid, start: startOf(pid) } : null);
const pidns = cfg.containment === 'netns+pidns';
/** The member's keeper and CLI(s), by identity (pid + /proc start time). The CLI is the one `claude` process whose env names this workspace. */
function sessionProcs(ws, keeperMod) {
  const kp = (() => { try { return keeperMod.readTrackedKeeperPid(ws); } catch { return null; } })();
  const cli = census({ pidns }).procs.filter((p) => p.kind === 'cli' && environOf(p.pid)?.ORCHESTRA_WS_ID === ws).map((p) => ident(p.pid));
  return { keeper: ident(kp), cli };
}
const sameIdent = (a, b) => !!a && !!b && a.pid === b.pid && a.start === b.start;

// ── key / registry facts (the key itself stays in a local, never in a fact) ──
const secrets = new Set();
function keyFacts(ws, cliPid) {
  const env = cliPid ? environOf(cliPid) : null;
  const key = env?.[KEY_ENV] ?? '';
  if (key) secrets.add(key);
  let reg = null, mode = null;
  try { reg = JSON.parse(fs.readFileSync(REGISTRY, 'utf8')); mode = (fs.statSync(REGISTRY).mode & 0o777).toString(8); } catch { /* absent */ }
  const entry = reg?.sessions?.[ws];
  return {
    key,
    facts: {
      keyLen: key.length, keyHex: /^[0-9a-f]{64}$/.test(key), keySha: key ? sha256(key) : null,
      envRunId: env?.ORCHESTRA_RUN_ID ?? null, envWsId: env?.ORCHESTRA_WS_ID ?? null, envGeneration: env?.ORCHESTRA_COORDINATOR_GENERATION ?? null,
      registryFile: !!reg, registryMode: mode, registryEntries: Object.keys(reg?.sessions ?? {}), registryHash: entry?.hash ?? null, registryIssuedAt: entry?.issuedAt ?? null,
      hashMatches: !!key && entry?.hash === sha256(key),
    },
  };
}

// ── bus ground truth ──
let busRef = null;
const rowsLike = (needle) => busRef.getBus().prepare('SELECT run_id, sender, recipient, kind FROM messages WHERE body LIKE ?').all(`%${needle}%`);
const runRow = (id) => busRef.getBus().prepare('SELECT id, kind, coordinator, parent_run_id FROM runs WHERE id = ?').get(id) ?? null;

// ── the fake API's recorded tool results (what the model was told each Bash call did) ──
function toolResults(api) {
  const out = {};
  for (const r of api.requests) {
    if (r.type !== 'model' || !(r.tools > 0)) continue;
    for (const m of r.messages ?? []) {
      if (m.role !== 'user' || !Array.isArray(m.content)) continue;
      for (const b of m.content) {
        if (b?.type !== 'tool_result') continue;
        const text = typeof b.content === 'string' ? b.content : (b.content ?? []).map((c) => c.text ?? '').join('\n');
        out[b.tool_use_id] = { isError: b.is_error === true, rc: /RIG-RC=(\d+)/.exec(text)?.[1] ?? null, text: text.replace(/RIG-RC=\d+/, '').replace(/\s+/g, ' ').trim().slice(0, 260) };
      }
    }
  }
  return out;
}

// ── leak scan: the key must be in NO file under the scratch root nor the container's /tmp, and in none of the run's own output ──
function walkFiles(dir, out = []) {
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of ents) {
    const f = path.join(dir, e.name);
    if (e.isDirectory()) walkFiles(f, out);
    else if (e.isFile()) out.push(f);
  }
  return out;
}
function scanFiles(keys) {
  const hits = [];
  let scanned = 0;
  for (const f of [...walkFiles(root), ...walkFiles(os.tmpdir())]) {
    let buf;
    try { if (fs.statSync(f).size > 64 * 1024 * 1024) continue; buf = fs.readFileSync(f); } catch { continue; }
    scanned++;
    for (const k of keys) if (buf.includes(k)) hits.push(path.relative(root, f).startsWith('..') ? f : path.relative(root, f));
  }
  return { hits: [...new Set(hits)], scanned };
}
function leakFacts(api) {
  const keys = [...secrets];
  // POSITIVE CONTROL: plant a canary string in a file under the scratch root AND in the container's tmp dir — the scan must find both, or it is blind.
  const canary = crypto.randomBytes(32).toString('hex');
  const planted = [path.join(repoDir, '.si-canary'), path.join(os.tmpdir(), '.si-canary')];
  for (const f of planted) fs.writeFileSync(f, `${canary}\n`);
  const found = scanFiles([canary]).hits.length;
  for (const f of planted) fs.rmSync(f, { force: true });
  const files = keys.length ? scanFiles(keys) : { hits: [], scanned: 0 };
  const apiJson = JSON.stringify(api.requests);
  const out = outBuf.join('');
  return {
    keysChecked: keys.length, filesScanned: files.scanned, files: files.hits, canaryFound: found === 2,
    apiRequests: keys.some((k) => apiJson.includes(k)), runnerOutput: keys.some((k) => out.includes(k)),
  };
}

// ── talk to the real hooks server over its socket ──
const hostPost = (sock, route, body) => new Promise((resolve) => {
  const req = http.request({ socketPath: sock, path: route, method: 'POST', headers: { 'content-type': 'application/json' }, timeout: 5000 }, (res) => {
    let d = '';
    res.on('data', (c) => (d += c));
    res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve({ unparsable: d.slice(0, 80) }); } });
  });
  req.on('error', (e) => resolve({ transportError: e.code ?? String(e.message) }));
  req.on('timeout', () => req.destroy());
  req.end(JSON.stringify(body));
});
const canConnect = (sock) => new Promise((resolve) => { const s = net.connect(sock); s.on('connect', () => { s.destroy(); resolve(true); }); s.on('error', () => resolve(false)); });

/** The built CLI run BY HAND against the live hooks socket (never through a model) with an explicit identity env.
 *  ASYNC on purpose: the hooks server lives in THIS process, so a blocking spawnSync would starve the very host the CLI is asking. */
function handCli(args, idEnv) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd: repoDir, stdio: ['ignore', 'pipe', 'pipe'],
      env: { PATH: process.env.PATH, HOME: home, ORCHESTRA_HOME: orchHome, ORCHESTRA_SOCK: facts.sock, ORCHESTRA_WORKTREE: repoDir, ORCHESTRA_WS_ID: MEMBER, ...idEnv },
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    const t = setTimeout(() => child.kill('SIGKILL'), 25_000);
    child.on('close', (rc) => {
      clearTimeout(t);
      for (const k of secrets) if ((stdout + stderr).includes(k)) facts.leak.handOutput = true;
      // `check` prints its lot as JSON: the run it read is the run the CLI RESOLVED (the host's answer overrides the env's).
      let run = null;
      try { run = JSON.parse(stdout).run ?? null; } catch { /* not JSON (a refusal) */ }
      resolve({ rc, run, stderr: stderr.replace(/\s+/g, ' ').trim().slice(0, 240), stdout: stdout.replace(/\s+/g, ' ').trim().slice(0, 100) });
    });
  });
}

// ═════════════ boot: the fake API, the platform seam, the real store/bus/hooks server, the fleet ═════════════
const { startFakeApi } = await import(`${HERE}/fake-anthropic-api.mjs`);
const api = await startFakeApi({ apiPort: cfg.apiPort, proxyPort: cfg.proxyPort, keepMessages: true, reply: route });
if (api.proxyUrl !== process.env.HTTPS_PROXY || process.env.NODE_USE_ENV_PROXY !== '1') throw new Error(`identity-runner: not routed through the recording proxy (HTTPS_PROXY=${process.env.HTTPS_PROXY}, proxy=${api.proxyUrl})`);
delete process.env.NODE_USE_ENV_PROXY;
delete process.env.ANTHROPIC_AUTH_TOKEN;
Object.assign(process.env, {
  ANTHROPIC_BASE_URL: api.url, ANTHROPIC_API_KEY: 'sk-ant-api03-session-identity-rig-fake-key-not-real',
  HTTPS_PROXY: api.proxyUrl, HTTP_PROXY: api.proxyUrl, https_proxy: api.proxyUrl, http_proxy: api.proxyUrl, NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost',
});

if (!fs.existsSync(CLI)) throw new Error('dist-electron/cli.js missing — run `pnpm run build:cli` (run.mjs does)');
const keeperSrc = path.join(REPO, 'dist-electron', 'keeper.js');
if (!fs.existsSync(keeperSrc)) throw new Error('dist-electron/keeper.js missing — run `pnpm run build:keeper` (run.mjs does)');
fs.mkdirSync(path.join(orchHome, 'bin'), { recursive: true });
fs.copyFileSync(keeperSrc, path.join(orchHome, 'bin', 'keeper.js'));
// The `orchestra` the agent's Bash tool resolves: agentCliBinDir() (= <ORCHESTRA_HOME>/bin) is prepended to the session PATH by buildSdkEnv.
// The shipped shim re-invokes the Electron app; here it runs the BUILT CLI under system node (the same bundle the packaged shim runs).
fs.writeFileSync(path.join(orchHome, 'bin', 'orchestra'), `#!/bin/sh\nexec "${process.execPath}" "${CLI}" "$@"\n`, { mode: 0o755 });

if (cfg.mutant) {
  const { register } = await import('node:module');
  const { pathToFileURL } = await import('node:url');
  register(pathToFileURL(`${REPO}/scripts/session-identity/mutants.mjs`).href, { parentURL: import.meta.url, data: { mutant: cfg.mutant } });
}
const { initPlatform } = await import(`${REPO}/src/main/platform/index.ts`);
let turnEnds = 0;
let errorEvent = null;
initPlatform({
  kind: 'headless-session-identity-rig',
  broadcast: (channel, _wsId, ev) => {
    if (channel !== 'agent:event' || !ev) return;
    if (ev.type === 'turn-end') turnEnds++;
    if (ev.type === 'error' && !errorEvent) errorEvent = ev;
  },
  broadcastPtyData: () => {}, canBroadcast: () => true, isFocused: () => false, hasAttachedUi: () => false,
  notify: () => {}, openExternal: () => {}, showItemInFolder: () => {}, openPath: () => {},
  openAccountLoginUrl: () => {}, closeAccountLogin: () => {},
  getUserDataDir: () => userData, getLogsDir: () => `${orchHome}/logs`, getAppVersion: () => '0.0.0-session-identity-rig',
  getAppMetrics: () => [], isEncryptionAvailable: () => false, encryptString: (s) => s, decryptString: (s) => s,
});
(await import(`${REPO}/src/main/logger.ts`)).initLogger();
const resuming = phase === 'attach2';
if (!resuming) {
  fs.mkdirSync(path.join(userData, 'orchestra'), { recursive: true });
  fs.writeFileSync(path.join(userData, 'orchestra', 'store.json'), JSON.stringify({ repos: [], workspaces: [], accounts: [], selfTuneRuns: [] }));
}
const { store } = await import(`${REPO}/src/main/store.ts`);
await store.load?.();
busRef = await import(`${REPO}/src/main/bus.ts`);
const busRuns = await import(`${REPO}/src/main/bus-runs.ts`);
const { DEFAULT_BUS_SWITCHES } = await import(`${REPO}/src/shared/bus-switches.ts`);
busRef.initBus();
if (!busRef.getBus()) throw new Error('bus failed to open');
if (!String(busRef.busPath()).startsWith(root)) throw new Error(`SAFETY: bus resolved outside the scratch root: ${busRef.busPath()}`);
const sdk = await import(`${REPO}/src/main/agent-sdk.ts`);       // registers the REAL delivery seam (promote's `sdkSessionLive`)
const keeper = await import(`${REPO}/src/main/keeper-client.ts`);
const hooks = await import(`${REPO}/src/main/hooks-server.ts`);
hooksRef.mod = hooks;

if (!resuming) {
  // The LEAD owns a run (its frozen switches come from the shipped startRun); the MEMBER is a worker under it in a real git repo.
  busRuns.startRun(busRef.getBus(), { id: LEAD, kind: 'mission', coordinator: LEAD }, { ...DEFAULT_BUS_SWITCHES });
  fs.mkdirSync(repoDir, { recursive: true });
  fs.mkdirSync(leadDir, { recursive: true });
  fs.writeFileSync(path.join(repoDir, 'README.md'), '# session-identity rig\n');
  const g = (args) => execFileSync('git', args, { cwd: repoDir, env: { PATH: process.env.PATH, HOME: home, GIT_AUTHOR_NAME: 'rig', GIT_AUTHOR_EMAIL: 'rig@invalid', GIT_COMMITTER_NAME: 'rig', GIT_COMMITTER_EMAIL: 'rig@invalid' } });
  g(['init', '-q', '-b', 'main']); g(['add', '.']); g(['commit', '-q', '-m', 'init']);
  const now = Date.now();
  await store.upsertWorkspace({ id: LEAD, name: 'orchestrator · si lead', branch: 'si-lead', kind: 'orchestrator', repoPath: '', worktreePath: leadDir, status: 'idle', createdAt: now, hasInput: true });
  await store.upsertWorkspace({ id: MEMBER, name: 'scratch · si member', branch: 'si-member', kind: 'scratch', repoPath: '', worktreePath: repoDir, parentId: LEAD, status: 'idle', createdAt: now, hasInput: true });
}
await hooks.startHooksServer();
facts.sock = hooks.getHookSocketPath();
facts.leadId = LEAD;
facts.memberId = MEMBER;

const deadline = Date.now() + timeoutMs;
async function turn(text) {
  const want = turnEnds + 1;
  await sdk.sdkSend(MEMBER, text);
  while (turnEnds < want && !errorEvent && Date.now() < deadline) await sleep(25);
  if (errorEvent) throw new Error(`agent error event: ${errorEvent.message}`);
  if (turnEnds < want) throw new Error(`turn "${text.slice(0, 20)}" never ended`);
  await sleep(300); // consume() releases the turn gate just after turn-end
}
function snapshotAt(stepId) {
  facts.steps[stepId] = { procs: sessionProcs(MEMBER, keeper), sdkSessionId: store.getWorkspace(MEMBER)?.sdkSessionId ?? null, modelRequests: api.requests.filter((r) => r.type === 'model' && r.tools > 0).length };
}
/** The member's keeper + CLI identity and session id NOW (pid + /proc start time), for the "no restart" comparison. */
const snapNow = () => ({ procs: sessionProcs(MEMBER, keeper), sdkSessionId: store.getWorkspace(MEMBER)?.sdkSessionId ?? null });
const firstCli = (s) => s?.procs?.cli?.[0] ?? null;

/** Shared close-out of the promote-shaped arms: bus rows, tool results, identity of the processes, key + registry facts. */
function collectCommon(needle) {
  facts.toolResults = toolResults(api);
  facts.rows = needle ? rowsLike(needle) : [];
  facts.memberRun = runRow(MEMBER);
  facts.leadRun = runRow(LEAD);
  const end = snapNow();
  facts.end = end;
  facts.promoteMarker = (() => { try { return fs.readFileSync(path.join(repoDir, '.orchestra', 'bus-run-stale'), 'utf8'); } catch { return null; } })();
  const cli = firstCli(end);
  const kf = keyFacts(MEMBER, cli?.pid);
  facts.env = kf.facts;
  facts.keyHolder = kf.key;
}

async function teardown() {
  const out = {};
  try {
    keeper.forbidKeeperLaunch(MEMBER);
    const tree = keeper.snapshotKeeperTree(MEMBER);
    await sdk.sdkStop?.(MEMBER).catch?.(() => {});
    await keeper.killKeeper(MEMBER, 'session-identity-rig-teardown').catch(() => {});
    await keeper.killKeeperTree(MEMBER, tree, 'session-identity-rig-teardown').catch(() => {});
  } catch (e) { out.teardownError = String(e?.stack ?? e).slice(0, 300); }
  try { hooks.stopHooksServer(); } catch { /* already stopped */ }
  await api.stop().catch(() => {});
  // zero survivors: in the pid namespace the census is EVERY process but pid 1 and this process's ancestors
  let left = [];
  for (let i = 0; i < 60; i++) {
    left = census({ pidns }).procs.filter((p) => p.pid !== process.pid);
    if (left.length === 0) break;
    await sleep(100);
  }
  out.survivors = left.map((p) => `${p.kind}:${p.pid}:${p.cmd.slice(0, 60)}`);
  return out;
}

// ═════════════ the arms ═════════════
let error = null;
try {
  const guardHome = (f) => { for (const k of secrets) if (JSON.stringify(f).includes(k)) throw new Error('SAFETY: a fact carried the session key — refusing to print it'); };
  if (arm === 'same_turn' || arm === 'app_closed') {
    const tag = arm === 'same_turn' ? 'SI' : 'AC';
    await turn(`PROMPT-${tag}-1 promote yourself, then send to your lead.`);
    collectCommon(arm === 'same_turn' ? 'same-turn-379' : 'app-closed-379');
    const first = facts.steps[arm === 'same_turn' ? 'toolu_si_promote' : 'toolu_ac_promote'];
    const second = facts.steps[arm === 'same_turn' ? 'toolu_si_send' : 'toolu_ac_send'];
    facts.noRestart = {
      keeperSame: sameIdent(first?.procs?.keeper, facts.end.procs.keeper), cliSame: sameIdent(first?.procs?.cli?.[0], facts.end.procs.cli[0]),
      cliCountStart: first?.procs?.cli?.length ?? 0, cliCountEnd: facts.end.procs.cli.length,
      sessionIdStart: first?.sdkSessionId ?? null, sessionIdMid: second?.sdkSessionId ?? null, sessionIdEnd: facts.end.sdkSessionId,
      mainRequests: api.requests.filter((r) => r.type === 'model' && r.tools > 0).length,
    };
    if (arm === 'app_closed') {
      facts.hostDown = { sockFileExists: facts.hookSock ? fs.existsSync(facts.hookSock) : null, connectable: facts.hookSock ? await canConnect(facts.hookSock) : null, pointerFile: fs.existsSync(path.join(orchHome, 'sock')) };
      facts.marker = { body: facts.promoteMarker ? facts.promoteMarker.split('\n').slice(0, 3).join(' | ').slice(0, 240) : null, newRun: /^new run:[ \t]*(\S+)/m.exec(facts.promoteMarker ?? '')?.[1] ?? null };
    }
  } else if (arm === 'superseded') {
    await turn('PROMPT-SUP-1 first session.');
    const s1 = snapNow();
    const cli1 = firstCli(s1);
    const k1 = keyFacts(MEMBER, cli1?.pid);
    facts.old = { ...k1.facts, cli: cli1, keeper: s1.procs.keeper };
    const oldKey = k1.key;
    const oldRun = k1.facts.envRunId;
    const oldWs = k1.facts.envWsId;
    // A FRESH session start for the same workspace: the production `orchestra restart` path (stop + kill keeper + ensureSession).
    let restartErr = null;
    for (let i = 0; i < 8; i++) {
      try { await sdk.sdkRestart(MEMBER, { fresh: false }); restartErr = null; break; } catch (e) { restartErr = String(e?.message ?? e); await sleep(500); }
    }
    if (restartErr) throw new Error(`sdkRestart: ${restartErr}`);
    await turn('PROMPT-SUP-2 second session sends.');
    collectCommon('new-session-379');
    const cli2 = firstCli(facts.end);
    facts.new = { ...facts.env, cli: cli2, keeper: facts.end.procs.keeper };
    facts.distinctKeys = !!oldKey && !!facts.keyHolder && oldKey !== facts.keyHolder;
    facts.oldCliGone = cli1 ? startOf(cli1.pid) !== cli1.start : null;
    facts.registryHoldsOldHash = facts.new.registryHash === facts.old.keySha;
    facts.registryHoldsNewHash = facts.new.registryHash === facts.new.keySha;
    // The host's own answer for each key (ground truth of who is live), then the built CLI by hand with the OLD env, then the NEW one as the control.
    const pr = (r) => ({ ok: r.ok === true, code: r.code ?? null, runId: r.runId ?? null, transportError: r.transportError ?? null });
    facts.hostOld = pr(await hostPost(facts.sock, '/identity', { id: MEMBER, key: oldKey }));
    facts.hostNew = pr(await hostPost(facts.sock, '/identity', { id: MEMBER, key: facts.keyHolder }));
    const before = rowsLike('stale-key-379').length;
    const oldSend = await handCli(['send', '--type', 'status', '--to', LEAD, 'stale-key-379'], { ORCHESTRA_RUN_ID: oldRun, ORCHESTRA_WS_ID: oldWs, [KEY_ENV]: oldKey });
    const oldCheck = await handCli(['check'], { ORCHESTRA_RUN_ID: oldRun, ORCHESTRA_WS_ID: oldWs, [KEY_ENV]: oldKey });
    facts.handOld = { send: oldSend, check: oldCheck, rowsBefore: before, rowsAfter: rowsLike('stale-key-379').length };
    // CONTROL (proves the hand rig reaches the live host): the NEW key with a deliberately WRONG env run must read the host's run, not the env's.
    facts.handNew = { check: await handCli(['check'], { ORCHESTRA_RUN_ID: 'ws-si-bogus-env-run', ORCHESTRA_WS_ID: MEMBER, [KEY_ENV]: facts.keyHolder }) };
    facts.leakExtra = { oldKeyInRegistry: fs.existsSync(REGISTRY) && fs.readFileSync(REGISTRY, 'utf8').includes(oldKey) };
  } else if (arm === 'attach_keeps_key' && phase === 'attach1') {
    await turn('PROMPT-ATT-1 first app instance.');
    const s1 = snapNow();
    const cli1 = firstCli(s1);
    const k1 = keyFacts(MEMBER, cli1?.pid);
    facts.env = k1.facts;
    facts.procs = s1.procs;
    facts.sdkSessionId = s1.sdkSessionId;
    facts.leak = leakFacts(api);
    guardHome(facts);
    // The app QUITS: mark it (keeper bridges read the exit as a detach), leave everything else exactly as a quit does — no sdkStop, no kill.
    keeper.setAppQuitting();
    emitResult({ arm, facts });
    await sleep(100);
    process.exit(0);
  } else if (arm === 'attach_keeps_key' && phase === 'attach2') {
    const reg0 = (() => { try { return JSON.parse(fs.readFileSync(REGISTRY, 'utf8')); } catch { return null; } })();
    facts.registryAtStart = { file: !!reg0, entries: Object.keys(reg0?.sessions ?? {}), hash: reg0?.sessions?.[MEMBER]?.hash ?? null, issuedAt: reg0?.sessions?.[MEMBER]?.issuedAt ?? null };
    facts.sessionBefore = store.getWorkspace(MEMBER)?.sdkSessionId ?? null;
    facts.hasSessionBeforeAttach = sdk.sdkHasSession(MEMBER);
    facts.probe = await keeper.probeKeeper(MEMBER).then((p) => (p ? { running: p.running, pid: p.pid ?? null, shuttingDown: !!p.shuttingDown } : null)).catch(() => null);
    // The facade's attach to the live keeper completes just AFTER sdkAttachIfDetached returns: wait for the keeper's own log to say it
    // ("client attached" — one more than before) so everything below is measured AFTER the attach, never in its window.
    const attachCount = () => { try { return (fs.readFileSync(path.join(orchHome, 'keepers', `${MEMBER}.log`), 'utf8').match(/client attached/g) ?? []).length; } catch { return 0; } };
    const attachesBefore = attachCount();
    facts.attached = await sdk.sdkAttachIfDetached(MEMBER);
    for (let i = 0; i < 100 && attachCount() <= attachesBefore; i++) await sleep(50);
    facts.attachSettled = attachCount() > attachesBefore;
    facts.hasSessionAfterAttach = sdk.sdkHasSession(MEMBER);
    const s2 = snapNow();
    const cli2 = firstCli(s2);
    const k = keyFacts(MEMBER, cli2?.pid);
    facts.env = k.facts;
    facts.procs = s2.procs;
    facts.sessionAfter = s2.sdkSessionId;
    const pr = (r) => ({ ok: r.ok === true, code: r.code ?? null, runId: r.runId ?? null, transportError: r.transportError ?? null });
    facts.hostLive = pr(await hostPost(facts.sock, '/identity', { id: MEMBER, key: k.key }));
    facts.hostRandom = pr(await hostPost(facts.sock, '/identity', { id: MEMBER, key: crypto.randomBytes(32).toString('hex') }));
    // K1 with a deliberately WRONG env run: the CLI must read the HOST's run (the lead's) — proof the host vouched for K1, not an env fallback.
    facts.handLive = { check: await handCli(['check'], { ORCHESTRA_RUN_ID: 'ws-si-bogus-env-run', ORCHESTRA_WS_ID: MEMBER, [KEY_ENV]: k.key }) };
    // The reattached session keeps working through the NEW app instance's host: the model's own `orchestra send` lands.
    await turn('PROMPT-ATT-2 second app instance sends.');
    facts.toolResults = toolResults(api);
    facts.rows = rowsLike('attach-379');
    facts.leadRun = runRow(LEAD);
    facts.end = snapNow();
    facts.registryAtEnd = (() => { const f = keyFacts(MEMBER, firstCli(facts.end)?.pid).facts; return { hash: f.registryHash, issuedAt: f.registryIssuedAt, hashMatches: f.hashMatches, entries: f.registryEntries, mode: f.registryMode }; })();
    facts.keyHolder = k.key;
  }
} catch (e) {
  error = String(e?.stack ?? e);
}

if (arm === 'attach_keeps_key' && phase === 'attach1' && error) { emitResult({ arm, error }); process.exit(0); }
facts.leak = { ...(facts.leak ?? {}), ...leakFacts(api), handOutput: facts.leak?.handOutput === true };
const td = await teardown();
facts.survivors = td.survivors;
const finalLeak = leakFacts(api); // again after the teardown: logs the keeper/app wrote on the way out
facts.leak.files = [...new Set([...(facts.leak.files ?? []), ...finalLeak.files])];
facts.leak.runnerOutput = facts.leak.runnerOutput || finalLeak.runnerOutput;
if (td.teardownError && !error) error = `teardown: ${td.teardownError}`;
if (scriptErrors.length) facts.scriptErrors = scriptErrors;
delete facts.keyHolder;
delete facts.promoteMarker;
try {
  for (const k of secrets) if (JSON.stringify(facts).includes(k)) throw new Error('SAFETY: a fact carried the session key — refusing to print it');
} catch (e) { error = String(e.message); delete facts.env; }
emitResult(error ? { arm, error, facts: undefined } : { arm, facts });
process.exit(0);
