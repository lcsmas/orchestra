// One rewind-rig run, INSIDE the session-budget containment (harness.mjs `runRewindArm`): Orchestra's REAL path —
// agent-sdk.ts `sdkSend` ×3 → `sdkRewind` → `sdkSend` → `sdkHistory`, through the real keeper and the real `claude`
// CLI, against the local fake API (zero tokens). It records what the MODEL received after the rewind, which is the
// only place the conversation truncation is observable (the UI shows the renderer's fold, not the CLI's chain).
// Last stdout line: `{"rewind": {...}}`.
import fs from 'node:fs';
import path from 'node:path';
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

const cfg = JSON.parse(process.env.SB_CONFIG ?? '{}');
const { REPO, root, arm, mutant = null, timeoutMs = 90_000, exitDelayMs = 0, cold = false } = cfg;
const HERE = path.join(REPO, 'scripts', 'session-budget');

const { assertScratch } = await import(`${HERE}/scratch-guard.mjs`);
const home = path.join(root, 'home');
const orchHome = path.join(root, 'orchestra');
const cfgDir = path.join(home, '.claude');
if (!Array.isArray(cfg.live) || cfg.live.length === 0) throw new Error('rewind-runner: cfg.live is absent or empty — refusing to run without the scratch guard\'s live list');
for (const [label, p] of [['HOME', home], ['ORCHESTRA_HOME', orchHome], ['CLAUDE_CONFIG_DIR', cfgDir]]) assertScratch(label, p, root, cfg.live);
fs.mkdirSync(cfgDir, { recursive: true });
fs.mkdirSync(orchHome, { recursive: true });
process.env.HOME = home;
process.env.ORCHESTRA_HOME = orchHome;
process.env.CLAUDE_CONFIG_DIR = cfgDir;

if (mutant) register(pathToFileURL(`${HERE}/mutants.mjs`).href, { parentURL: import.meta.url, data: { mutant } });

const { startFakeApi } = await import(`${HERE}/fake-anthropic-api.mjs`);

// A tiny git repo: turn 2 CREATES a file, so the file half of the rewind is observable too.
const repoDir = path.join(root, 'repo');
fs.mkdirSync(repoDir, { recursive: true });
fs.writeFileSync(path.join(repoDir, 'README.md'), '# rewind rig\n');
// `exitDelayMs`: a SessionEnd hook that holds a gracefully-stopped CLI alive — widens the window in which the next
// send can attach to the dying CLI (a real workspace's shutdown is slower than this bare fixture's ~25 ms).
if (exitDelayMs) {
  fs.mkdirSync(path.join(repoDir, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(repoDir, '.claude', 'settings.json'), JSON.stringify({
    hooks: { SessionEnd: [{ hooks: [{ type: 'command', command: `sleep ${exitDelayMs / 1000}` }] }] },
  }));
}
execFileSync('git', ['init', '-q'], { cwd: repoDir });
execFileSync('git', ['add', '.'], { cwd: repoDir });
execFileSync('git', ['-c', 'user.email=rig@invalid', '-c', 'user.name=rig', 'commit', '-qm', 'init'], { cwd: repoDir });
const created = path.join(repoDir, 'created-by-turn-2.txt');

// Each prompt carries a marker; the fake model answers by the LAST user message's marker. NEW is checked before T1:
// a wrong cut merges the dangling T1 prompt and the new prompt into one user message.
const lastUser = (msgs) => JSON.stringify([...(msgs ?? [])].reverse().find((m) => m.role === 'user')?.content ?? '');
const api = await startFakeApi({
  apiPort: cfg.apiPort, proxyPort: cfg.proxyPort, keepMessages: true,
  reply: (rec) => {
    if (!(rec.tools > 0)) return undefined;
    const last = lastUser(rec.messages);
    if (last.includes('tool_result')) return { text: 'REPLY-T2-AFTER-WRITE' };
    if (last.includes('PROMPT-NEW')) return { text: 'REPLY-NEW' };
    if (last.includes('PROMPT-T3')) return { text: 'REPLY-T3' };
    if (last.includes('PROMPT-T2')) return { toolUse: { name: 'Write', input: { file_path: created, content: 'written by turn 2\n' } } };
    if (last.includes('PROMPT-T1')) return { text: 'REPLY-T1' };
    return { text: 'REPLY-UNROUTED' };
  },
});
if (api.proxyUrl !== process.env.HTTPS_PROXY || process.env.NODE_USE_ENV_PROXY !== '1') {
  throw new Error(`rewind-runner: not routed through the recording proxy (HTTPS_PROXY=${process.env.HTTPS_PROXY}, proxy=${api.proxyUrl})`);
}
delete process.env.NODE_USE_ENV_PROXY;
delete process.env.ANTHROPIC_AUTH_TOKEN;
Object.assign(process.env, {
  ANTHROPIC_BASE_URL: api.url,
  ANTHROPIC_API_KEY: 'sk-ant-api03-rewind-rig-fake-key-not-real',
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
const rewindEvents = [];
initPlatform({
  kind: 'headless-rewind-rig',
  broadcast: (channel, _wsId, ev) => {
    if (channel !== 'agent:event' || !ev) return;
    if (ev.type === 'turn-end') turnEnds++;
    if (ev.type === 'error' && !errorEvent) errorEvent = ev;
    if (ev.type === 'session/rewind') rewindEvents.push(ev);
  },
  broadcastPtyData: () => {}, canBroadcast: () => true, isFocused: () => false, hasAttachedUi: () => false,
  notify: () => {}, openExternal: () => {}, showItemInFolder: () => {}, openPath: () => {},
  openAccountLoginUrl: () => {}, closeAccountLogin: () => {},
  getUserDataDir: () => orchHome, getLogsDir: () => `${orchHome}/logs`, getAppVersion: () => '0.0.0-rewind-rig',
  getAppMetrics: () => [], isEncryptionAvailable: () => false, encryptString: (s) => s, decryptString: (s) => s,
});

const { store } = await import(`${REPO}/src/main/store.ts`);
const sdk = await import(`${REPO}/src/main/agent-sdk.ts`);
const keeper = await import(`${REPO}/src/main/keeper-client.ts`);

const WS_ID = 'ws-rewind';
await store.load?.();
await store.upsertWorkspace({
  id: WS_ID, name: 'rewind-rig', kind: 'scratch', repoPath: '', worktreePath: repoDir,
  status: 'idle', createdAt: Date.now(), hasInput: true,
});

const deadline = Date.now() + timeoutMs;
async function turn(text) {
  const want = turnEnds + 1;
  const id = await sdk.sdkSend(WS_ID, text);
  while (turnEnds < want && !errorEvent && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
  if (errorEvent) throw new Error(`agent error event: ${errorEvent.message}`);
  if (turnEnds < want) throw new Error(`turn "${text}" never ended`);
  return id;
}
const textOf = (m) => (typeof m.content === 'string' ? m.content : (m.content ?? []).map((c) => c.text ?? `[${c.type}]`).join(' | '));

const out = { arm, mutant };
let error = null;
try {
  const id1 = await turn('PROMPT-T1 reply alpha.');
  const id2 = await turn('PROMPT-T2 create the file.');
  await turn('PROMPT-T3 reply gamma.');
  out.fileAfterTurn2 = fs.existsSync(created);

  if (cold) {
    // `cold`: the session hibernated (idle sweep, 5 min by default) before the user opened the rewind popover.
    const sleep = async () => {
      await sdk.sdkStop(WS_ID, { hibernate: true });
      await keeper.killKeeper(WS_ID, 'rewind-rig-hibernate');
    };
    await sleep();
    const p = await sdk.sdkRewindPreview(WS_ID, id2);
    out.coldPreview = { canRewind: p.canRewind, files: p.filesChanged?.length ?? 0, error: p.error ?? null };
    await sleep(); // the confirm, too, must not depend on the preview having woken the session
  }
  // Undo turn 2 (and with it turn 3) — exactly what the renderer sends: the target and its predecessor.
  const ev = await sdk.sdkRewind(WS_ID, id2, id1);
  out.rewindEvent = { filesChanged: ev.filesChanged ?? null, filesError: ev.filesError ?? null };
  out.fileAfterRewind = fs.existsSync(created);
  // The parked cut is ON DISK (an app restart before the next send keeps it), not only in this process.
  out.cutPersisted = (() => {
    const cut = store.getWorkspace(WS_ID)?.sdkRewindCut;
    try { return !!cut && fs.readFileSync(path.join(orchHome, 'orchestra', 'store.json'), 'utf8').includes(cut); } catch { return false; }
  })();
  // A pane reopened BEFORE the next send (the cut is only parked until then) must not bring the undone turns back.
  out.historyBeforeSend = (await sdk.sdkHistory(WS_ID)).filter((e) => e.type === 'user-message').map((e) => String(e.text ?? '').slice(0, 30));

  const before = api.requests.length;
  // A lost prompt is a context failure (it never reached a model with the cut), not a broken run.
  await turn('PROMPT-NEW after the rewind.').catch((e) => {
    out.newTurnError = String(e?.message ?? e);
    errorEvent = null;
  });
  const req = api.requests.slice(before).find((r) => r.type === 'model' && r.tools > 0);
  const msgs = (req?.messages ?? []).filter((m) => m.role === 'user' || m.role === 'assistant');
  out.modelSaw = msgs.map((m) => `${m.role}: ${textOf(m).replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').replace(/\s+/g, ' ').trim().slice(0, 80)}`);
  const flat = JSON.stringify(msgs);
  out.context = {
    keptT1Prompt: flat.includes('PROMPT-T1'),
    keptT1Reply: flat.includes('REPLY-T1'),
    droppedT2: !flat.includes('PROMPT-T2') && !flat.includes('REPLY-T2'),
    droppedT3: !flat.includes('PROMPT-T3') && !flat.includes('REPLY-T3'),
    hasNew: flat.includes('PROMPT-NEW'),
    ...(out.newTurnError ? { newTurnError: out.newTurnError } : {}),
  };

  // A reopened pane / app restart backfills from disk: the rewound turns must not come back.
  const hist = await sdk.sdkHistory(WS_ID);
  out.historyUserTexts = hist.filter((e) => e.type === 'user-message').map((e) => String(e.text ?? '').slice(0, 30));
  out.historyRewindIds = hist.filter((e) => e.type === 'user-message').map((e) => e.rewindId ?? null);
} catch (e) {
  error = String(e?.stack ?? e);
}

try {
  keeper.forbidKeeperLaunch(WS_ID);
  const tree = keeper.snapshotKeeperTree(WS_ID);
  await sdk.sdkStop?.(WS_ID).catch?.(() => {});
  await keeper.killKeeper(WS_ID, 'rewind-rig-teardown').catch(() => {});
  await keeper.killKeeperTree(WS_ID, tree, 'rewind-rig-teardown').catch(() => {});
} catch (e) {
  error = error ?? `teardown: ${String(e?.stack ?? e)}`;
}
await api.stop().catch(() => {});
// Handoff: once a CLI got its graceful stop (`stdinEnd`), any client attaching before that keeper exits must be the
// kill (`kill frame` on the next line) — anything else is a new session bridged onto the dying CLI.
try {
  const klog = fs.readFileSync(path.join(orchHome, 'keepers', `${WS_ID}.log`), 'utf8').split('\n');
  let dying = false;
  out.attachesToDyingCli = 0;
  out.gracefulStops = 0;
  klog.forEach((l, i) => {
    if (l.includes('shutdown: stdinEnd')) { dying = true; out.gracefulStops++; }
    else if (/\] exit code=/.test(l)) dying = false;
    else if (dying && l.includes('client attached') && !(klog[i + 1] ?? '').includes('kill frame')) out.attachesToDyingCli++;
  });
} catch (e) {
  error = error ?? `keeper log unreadable: ${String(e?.message ?? e)}`;
}
if (error) out.error = error;
console.log(JSON.stringify({ rewind: out }));
process.exit(0);
