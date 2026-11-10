// One Bloc HTML rig run (#418), INSIDE the session-budget containment (harness.mjs `runBlocHtmlArm`): Orchestra's REAL path —
// bloc-html-setting.ts → agent-sdk.ts `sdkSend` → the installed SessionStart hook → the real keeper + real `claude` CLI against the
// local fake API (zero tokens). It records, per scenario, how many times the Bloc HTML instruction is in the context the MODEL received.
// Last stdout line: `{"bloc": {...}}`.
import fs from 'node:fs';
import path from 'node:path';
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

const cfg = JSON.parse(process.env.SB_CONFIG ?? '{}');
const { REPO, root, arm, mutant = null, timeoutMs = 120_000 } = cfg;
const HERE = path.join(REPO, 'scripts', 'session-budget');

const { assertScratch } = await import(`${HERE}/scratch-guard.mjs`);
const home = path.join(root, 'home');
const orchHome = path.join(root, 'orchestra');
const cfgDir = path.join(home, '.claude');
if (!Array.isArray(cfg.live) || cfg.live.length === 0) throw new Error('bloc-html-runner: cfg.live is absent or empty — refusing to run without the scratch guard\'s live list');
for (const [label, p] of [['HOME', home], ['ORCHESTRA_HOME', orchHome], ['CLAUDE_CONFIG_DIR', cfgDir]]) assertScratch(label, p, root, cfg.live);
fs.mkdirSync(cfgDir, { recursive: true });
fs.mkdirSync(orchHome, { recursive: true });
process.env.HOME = home;
process.env.ORCHESTRA_HOME = orchHome;
process.env.CLAUDE_CONFIG_DIR = cfgDir;

if (mutant) register(pathToFileURL(`${HERE}/mutants.mjs`).href, { parentURL: import.meta.url, data: { mutant } });

const { startFakeApi } = await import(`${HERE}/fake-anthropic-api.mjs`);

// The instruction's opening words, read from the SHIPPED text (never retyped here), so a reworded instruction cannot leave the rig counting nothing.
const { BLOC_HTML_INSTRUCTION } = await import(`${REPO}/src/shared/bloc-html-instruction.ts`);
const NEEDLE = BLOC_HTML_INSTRUCTION.split('\n')[0].slice(0, 48);
if (!NEEDLE.startsWith('[orchestra] Bloc HTML:')) throw new Error(`bloc-html-runner: unexpected instruction head ${JSON.stringify(NEEDLE)}`);
const countIn = (messages) => JSON.stringify(messages ?? []).split(NEEDLE).length - 1;

const lastUser = (msgs) => JSON.stringify([...(msgs ?? [])].reverse().find((m) => m.role === 'user')?.content ?? '');
const api = await startFakeApi({
  apiPort: cfg.apiPort, proxyPort: cfg.proxyPort, keepMessages: true,
  reply: (rec) => {
    if (!(rec.tools > 0)) return undefined;
    const last = lastUser(rec.messages);
    if (last.includes('SUBAGENT-PROMPT')) return { text: 'SUB-REPLY' };
    if (last.includes('tool_result')) return { text: 'REPLY-AFTER-AGENT' };
    if (last.includes('PROMPT-AGENT')) return { toolUse: { name: 'Agent', input: { description: 'rig sub-agent', prompt: 'SUBAGENT-PROMPT say hi', subagent_type: 'general-purpose' } } };
    return { text: 'REPLY' };
  },
});
if (api.proxyUrl !== process.env.HTTPS_PROXY || process.env.NODE_USE_ENV_PROXY !== '1') {
  throw new Error(`bloc-html-runner: not routed through the recording proxy (HTTPS_PROXY=${process.env.HTTPS_PROXY}, proxy=${api.proxyUrl})`);
}
delete process.env.NODE_USE_ENV_PROXY;
delete process.env.ANTHROPIC_AUTH_TOKEN;
Object.assign(process.env, {
  ANTHROPIC_BASE_URL: api.url,
  ANTHROPIC_API_KEY: 'sk-ant-api03-bloc-html-rig-fake-key-not-real',
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
  kind: 'headless-bloc-html-rig',
  broadcast: (channel, _wsId, ev) => {
    if (channel !== 'agent:event' || !ev) return;
    if (ev.type === 'turn-end') turnEnds++;
    if (ev.type === 'error' && !errorEvent) errorEvent = ev;
  },
  broadcastPtyData: () => {}, canBroadcast: () => true, isFocused: () => false, hasAttachedUi: () => false,
  notify: () => {}, openExternal: () => {}, showItemInFolder: () => {}, openPath: () => {},
  openAccountLoginUrl: () => {}, closeAccountLogin: () => {},
  getUserDataDir: () => orchHome, getLogsDir: () => `${orchHome}/logs`, getAppVersion: () => '0.0.0-bloc-html-rig',
  getAppMetrics: () => [], isEncryptionAvailable: () => false, encryptString: (s) => s, decryptString: (s) => s,
});

const { store } = await import(`${REPO}/src/main/store.ts`);
const sdk = await import(`${REPO}/src/main/agent-sdk.ts`);
const keeper = await import(`${REPO}/src/main/keeper-client.ts`);
const setting = await import(`${REPO}/src/main/bloc-html-setting.ts`);
await store.load?.();

const deadline = Date.now() + timeoutMs;
const wsIds = [];
async function makeWs(id) {
  const dir = path.join(root, `repo-${id}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'README.md'), '# bloc html rig\n');
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['-c', 'user.email=rig@invalid', '-c', 'user.name=rig', 'commit', '-qm', 'init'], { cwd: dir });
  await store.upsertWorkspace({ id, name: id, kind: 'scratch', repoPath: '', worktreePath: dir, status: 'idle', createdAt: Date.now(), hasInput: true });
  wsIds.push(id);
}
/** One turn; returns the FIRST tool-carrying model request it produced (the context the model received) and its instruction count. */
async function turn(id, text) {
  const want = turnEnds + 1;
  const before = api.requests.length;
  await sdk.sdkSend(id, text);
  while (turnEnds < want && !errorEvent && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
  if (errorEvent) throw new Error(`agent error event: ${errorEvent.message}`);
  if (turnEnds < want) throw new Error(`turn "${text}" never ended`);
  const reqs = api.requests.slice(before).filter((r) => r.type === 'model' && r.tools > 0);
  const main = reqs.find((r) => !lastUser(r.messages).includes('SUBAGENT-PROMPT'));
  if (!main) throw new Error(`turn "${text}": no tool-carrying model request recorded`);
  return { count: countIn(main.messages), reqs };
}
const hibernate = async (id) => {
  await sdk.sdkStop(id, { hibernate: true });
  await keeper.killKeeper(id, 'bloc-html-rig-hibernate');
};

const out = { arm, mutant, needle: NEEDLE };
let error = null;
try {
  // new-on: switch ON, a fresh session → the instruction is in the model's context.
  await makeWs('ws-new-on');
  await setting.setBlocHtmlEnabled(true);
  out.newOn = (await turn('ws-new-on', 'PROMPT hello')).count;

  // new-off: switch OFF, a fresh session → absent (the model still got the request).
  await makeWs('ws-new-off');
  await setting.setBlocHtmlEnabled(false);
  out.newOff = (await turn('ws-new-off', 'PROMPT hello')).count;

  // resumed-on: started OFF, flipped ON, hibernated, resumed → the resumed CLI's SessionStart delivers it.
  await makeWs('ws-resumed-on');
  await setting.setBlocHtmlEnabled(false);
  out.resumedOnBefore = (await turn('ws-resumed-on', 'PROMPT one')).count;
  await setting.setBlocHtmlEnabled(true);
  await hibernate('ws-resumed-on');
  out.resumedOn = (await turn('ws-resumed-on', 'PROMPT two')).count;

  // resumed-off: started ON, flipped OFF, hibernated, resumed → still the ONE copy from the first start (nothing added, nothing duplicated).
  await makeWs('ws-resumed-off');
  await setting.setBlocHtmlEnabled(true);
  out.resumedOffBefore = (await turn('ws-resumed-off', 'PROMPT one')).count;
  await setting.setBlocHtmlEnabled(false);
  await hibernate('ws-resumed-off');
  out.resumedOff = (await turn('ws-resumed-off', 'PROMPT two')).count;

  // resumed-on-on: started ON, still ON at resume (a Veille wake) → ONE copy, not a second one replayed from the transcript.
  await makeWs('ws-resumed-on-on');
  await setting.setBlocHtmlEnabled(true);
  out.resumedOnOnBefore = (await turn('ws-resumed-on-on', 'PROMPT one')).count;
  await hibernate('ws-resumed-on-on');
  out.resumedOnOn = (await turn('ws-resumed-on-on', 'PROMPT two')).count;

  // running-off: a LIVE session started OFF, switch flipped ON, next turn on the SAME session → still absent (a running session is untouched).
  await makeWs('ws-running-off');
  await setting.setBlocHtmlEnabled(false);
  out.runningOffBefore = (await turn('ws-running-off', 'PROMPT one')).count;
  await setting.setBlocHtmlEnabled(true);
  out.runningOff = (await turn('ws-running-off', 'PROMPT two')).count;

  // running-on: a LIVE session started ON, switch flipped OFF, next turn → still exactly the one copy.
  await makeWs('ws-running-on');
  await setting.setBlocHtmlEnabled(true);
  out.runningOnBefore = (await turn('ws-running-on', 'PROMPT one')).count;
  await setting.setBlocHtmlEnabled(false);
  out.runningOn = (await turn('ws-running-on', 'PROMPT two')).count;

  // sub-agent: with the switch ON the main session has it; the Agent tool's sub-agent request does not.
  await makeWs('ws-subagent');
  await setting.setBlocHtmlEnabled(true);
  const sub = await turn('ws-subagent', 'PROMPT-AGENT go');
  out.subMain = sub.count;
  const subReq = sub.reqs.find((r) => lastUser(r.messages).includes('SUBAGENT-PROMPT'));
  out.subSeen = !!subReq;
  out.subAgent = subReq ? countIn(subReq.messages) : null;

  // The scenarios above ran under the real host reader: record what it said at the end (OFF after the last flip).
  out.finalSwitch = setting.isBlocHtmlEnabled();
} catch (e) {
  error = String(e?.stack ?? e);
}

for (const id of wsIds) {
  try {
    keeper.forbidKeeperLaunch(id);
    const tree = keeper.snapshotKeeperTree(id);
    await sdk.sdkStop?.(id).catch?.(() => {});
    await keeper.killKeeper(id, 'bloc-html-rig-teardown').catch(() => {});
    await keeper.killKeeperTree(id, tree, 'bloc-html-rig-teardown').catch(() => {});
  } catch (e) {
    error = error ?? `teardown: ${String(e?.stack ?? e)}`;
  }
}
await api.stop().catch(() => {});
if (error) out.error = error;
console.log(JSON.stringify({ bloc: out }));
process.exit(0);
