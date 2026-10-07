// #227 (wave "Agent view only" #219) — a child whose SDK session FAILS TO START is reported, never masked by a PTY.
// Drives the REAL dispatchSpawnRequest / startWorkspaceAgentHeadless / wakeAgentWithPrompt / dispatchMessageRequest /
// dispatchRestartRequest + the REAL store over a fake SDK seam (`registerSdkDelivery`), one arm per process.
// A stub `claude` on PATH records any launch: the masked (pre-#227) build runs it, the fixed one never does.
//
// Arms (ok:true = the shipped behaviour):
//   spawn_start_fails    spawn returns not-ok naming the reason + child id; child KEPT, task retained, hasInput unset; no PTY, stub not run
//   spawn_start_ok       must-PASS control: a start that works answers ok, delivers lastTask ONCE, flips hasInput
//   wake_start_fails     wakeAgentWithPrompt → false (no PTY); dispatchMessageRequest → 'inbox' with the text on disk
//   restart_retries      Restart of the kept child: still failing → reported not-ok; cause removed → ok, task delivered once, hasInput set
//   restart_single_flight two concurrent Restarts → ONE delivery; a third, after success, delivers nothing
//   ticket_spawn_failure  a pinned ticket whose spawn FAILS to start is graduated to the kept child (error reported); a retry
//                         finds that child instead of creating a duplicate (F4)
//
// Run: node --experimental-strip-types --import ./scripts/.r2-register.mjs scripts/e2e-spawn-failure.mjs <arm>

import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ARM = process.argv[2] ?? 'spawn_start_fails';
const ARMS = ['spawn_start_fails', 'spawn_start_ok', 'wake_start_fails', 'restart_retries', 'restart_single_flight', 'ticket_spawn_failure'];
if (!ARMS.includes(ARM)) { console.error(`unknown arm: ${ARM}`); process.exit(2); }

// Under the real home (btrfs), NOT /tmp: the fs is part of the instrument.
const tmpHome = path.join(process.env.E2E_HOME ?? path.join(os.homedir(), '.cache', 'e2e-spawn-failure'), ARM);
fs.rmSync(tmpHome, { recursive: true, force: true });
fs.mkdirSync(path.join(tmpHome, '.orchestra'), { recursive: true });
process.env.ORCHESTRA_HOME = path.join(tmpHome, '.orchestra');
process.env.HOME = tmpHome;
// The stub `claude`: a launch of the agent CLI (the PTY fallback's command) leaves a line in claude-ran.log.
const stubBin = path.join(tmpHome, 'stub-bin');
const ranLog = path.join(tmpHome, 'claude-ran.log');
fs.mkdirSync(stubBin, { recursive: true });
fs.writeFileSync(path.join(stubBin, 'claude'), `#!/bin/sh\necho "$@" >> ${JSON.stringify(ranLog)}\nsleep 30\n`, { mode: 0o755 });
process.env.PATH = `${stubBin}:/usr/local/bin:/usr/bin:/bin`;

const { initPlatform } = await import(`${REPO}/src/main/platform/index.ts`);
initPlatform({
  kind: 'headless-e2e-spawn-failure',
  broadcast: () => {}, broadcastPtyData: () => true, canBroadcast: () => true,
  isFocused: () => false, hasAttachedUi: () => false, notify: () => {},
  openExternal: () => {}, showItemInFolder: () => {}, openPath: () => {},
  openAccountLoginUrl: () => {}, closeAccountLogin: () => {},
  getUserDataDir: () => tmpHome, getLogsDir: () => `${tmpHome}/logs`,
  getAppVersion: () => '0.0.0-e2e-spawn-failure', getAppMetrics: () => [],
  isEncryptionAvailable: () => false, encryptString: (s) => s, decryptString: (s) => s,
});
const { store } = await import(`${REPO}/src/main/store.ts`);
await (await import('./neutral-memory-guard.mjs')).neutralizeMemoryGuard(REPO);   // #286: never read the HOST's real MemAvailable (the guard would hold auto starts below 6 GB)
await store.load?.();
const workspaces = await import(`${REPO}/src/main/workspaces.ts`);   // may load agent-sdk → register the fake seam AFTER
const delivery = await import(`${REPO}/src/main/sdk-delivery.ts`);
const pty = await import(`${REPO}/src/main/pty.ts`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const INJECTED = 'INJECTED-SDK-START-FAILURE-91c4';
const TASK = 'E2E-TASK-0b7e opening brief';
const starts = [];                 // every `start(wsId, text)` the seam saw
let failStarts = true;             // flip to "remove the cause"
let slowMs = 0;                    // hold each start (a slow session boot) to expose races
delivery.registerSdkDelivery({
  hasSession: () => false, hasBackgroundTask: () => false,
  send: async () => {}, sendAwaitingStart: async () => 'started', stop: async () => {},
  start: async (wsId, text) => {
    const willFail = failStarts;                            // the cause as it is when THIS start begins
    starts.push({ wsId, text, ok: !willFail });
    if (slowMs) await sleep(slowMs);
    if (willFail) throw new Error(INJECTED);
  },
});

const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: tmpHome, GIT_AUTHOR_NAME: 'e2e', GIT_AUTHOR_EMAIL: 'e2e@example.invalid', GIT_COMMITTER_NAME: 'e2e', GIT_COMMITTER_EMAIL: 'e2e@example.invalid', GIT_CONFIG_NOSYSTEM: '1' } });
const repoDir = path.join(tmpHome, 'repo');
fs.mkdirSync(repoDir, { recursive: true });
git(repoDir, ['init', '-q', '-b', 'main']);
fs.writeFileSync(path.join(repoDir, 'README.md'), '# e2e\n');
git(repoDir, ['add', '.']); git(repoDir, ['commit', '-q', '-m', 'seed']);
await store.addRepo({ path: repoDir, name: 'repo', defaultBranch: 'main' });

const spawnChild = () => workspaces.dispatchSpawnRequest({ task: TASK, repoPath: repoDir, agent: 'claude', detached: true, defaultKind: 'spawned' });
const noPtyEver = async () => { await sleep(600); return !pty.isRunning(ID_UNDER_TEST()) && !fs.existsSync(ranLog); };
let idUnderTest = null;
const ID_UNDER_TEST = () => idUnderTest ?? '';
const out = { arm: ARM };
let ok = false;

if (ARM === 'spawn_start_fails') {
  const res = await spawnChild();
  idUnderTest = res.id ?? null;
  const ws = idUnderTest ? store.getWorkspace(idUnderTest) : undefined;
  Object.assign(out, {
    res, kept: !!ws, lastTask: ws?.lastTask, hasInput: ws?.hasInput, archived: !!ws?.archived,
    starts: starts.length, noPty: idUnderTest ? await noPtyEver() : false,
  });
  ok = res.ok === false && typeof res.id === 'string' && res.branch === ws?.branch
    && String(res.error).includes(INJECTED) && String(res.error).includes(res.id) && /failed to start/.test(res.error)
    && !!ws && !ws.archived && ws.lastTask === TASK && ws.hasInput !== true
    && starts.length === 1 && starts[0].text === TASK && out.noPty;
} else if (ARM === 'spawn_start_ok') {
  failStarts = false;
  const res = await spawnChild();
  idUnderTest = res.id ?? null;
  const ws = idUnderTest ? store.getWorkspace(idUnderTest) : undefined;
  Object.assign(out, { res, starts: starts.length, hasInput: ws?.hasInput, noPty: idUnderTest ? await noPtyEver() : false });
  ok = res.ok === true && typeof res.id === 'string' && starts.length === 1 && starts[0].text === TASK && ws?.hasInput === true && out.noPty;
} else if (ARM === 'wake_start_fails') {
  // A STOPPED workspace (worktree exists, nothing ever started) receives a direct wake + a peer message. Created straight
  // from createWorkspace, NOT through spawn, so a masking spawn (which leaves a live PTY) cannot confound this arm.
  const stopped = await workspaces.createWorkspace({ repoPath: repoDir, task: TASK, agent: 'claude' }, 'spawned');
  idUnderTest = stopped.id;
  const created = { ok: false };
  const woke = await workspaces.wakeAgentWithPrompt(idUnderTest, 'wake me');
  const msg = await workspaces.dispatchMessageRequest({ to: idUnderTest, text: 'AVR-inbox-text-77', emergency: true });
  const inboxFile = path.join(tmpHome, '.orchestra', 'inbox', `${idUnderTest}.txt`);
  const inbox = fs.existsSync(inboxFile) ? fs.readFileSync(inboxFile, 'utf8') : '';
  Object.assign(out, { woke, msg, inboxHasText: inbox.includes('AVR-inbox-text-77'), starts: starts.length, noPty: await noPtyEver() });
  ok = woke === false && msg.ok === true && msg.delivery === 'inbox' && out.inboxHasText
    && starts.length === 2 && out.noPty;
} else if (ARM === 'restart_retries') {
  const created = await spawnChild();                       // fails → child kept stopped, task owed
  idUnderTest = created.id ?? null;
  const owedBefore = store.getWorkspace(idUnderTest);
  const still = await (await import(`${REPO}/src/main/restart-workspace.ts`)).dispatchRestartRequest({ id: idUnderTest });
  const afterFail = store.getWorkspace(idUnderTest);
  const startsWhileFailing = starts.length;                 // spawn's own attempt + the failed retry
  failStarts = false;                                       // "after removing the cause"
  const fixed = await (await import(`${REPO}/src/main/restart-workspace.ts`)).dispatchRestartRequest({ id: idUnderTest });
  const afterOk = store.getWorkspace(idUnderTest);
  const delivered = starts.filter((s) => s.ok && s.text === TASK).length;   // starts the CLI would have RECEIVED the brief on
  Object.assign(out, { created: created.ok, still, startsWhileFailing, fixed, delivered, hasInputBefore: owedBefore?.hasInput, hasInputAfterFail: afterFail?.hasInput, hasInputAfterOk: afterOk?.hasInput, noPty: await noPtyEver() });
  ok = created.ok === false && owedBefore?.lastTask === TASK
    && still.ok === false && /restart failed/.test(still.error ?? '') && String(still.error).includes(INJECTED)
    && afterFail?.hasInput !== true && afterFail?.lastTask === TASK && startsWhileFailing === 2
    && fixed.ok === true && fixed.mode === 'structured' && afterOk?.hasInput === true
    && delivered === 1 && starts.length === 3 /* spawn attempt + failed retry + the one that took the task */ && out.noPty;
} else if (ARM === 'restart_single_flight') {
  const created = await spawnChild();
  idUnderTest = created.id ?? null;
  const restart = (await import(`${REPO}/src/main/restart-workspace.ts`)).dispatchRestartRequest;
  failStarts = false; slowMs = 400; starts.length = 0;      // a slow boot: both Restarts land while the first start is in flight
  const [a, b] = await Promise.all([restart({ id: idUnderTest }), restart({ id: idUnderTest })]);
  const afterConcurrent = starts.length;
  const ws = store.getWorkspace(idUnderTest);
  // a THIRD Restart after success: the task is no longer owed, so nothing delivers it again through the retry path
  const c = typeof workspaces.startWorkspaceAgentHeadless === 'function'
    ? await workspaces.startWorkspaceAgentHeadless(idUnderTest)
    : { ok: false, error: 'startWorkspaceAgentHeadless is not exported' };   // an unfixed tree reddens on behaviour, not on a TypeError
  Object.assign(out, { created: created.ok, a, b, afterConcurrent, afterThird: starts.length, hasInput: ws?.hasInput, c });
  ok = created.ok === false && a.ok === true && b.ok === true && afterConcurrent === 1 && ws?.hasInput === true
    && c.ok === true && starts.length === 1;
}

else if (ARM === 'ticket_spawn_failure') {
  const linear = await import(`${REPO}/src/main/linear-tickets.ts`);
  await store.upsertTicket({ identifier: 'E2E-9001', url: 'https://linear.example/E2E-9001', title: 'probe ticket', pinnedAt: Date.now() });
  const first = await linear.spawnWorkspaceForTicket('E2E-9001', repoDir);        // the SDK start fails
  const afterFirst = store.getTicket('E2E-9001');
  const kept = first.workspaceId ? store.getWorkspace(first.workspaceId) : undefined;
  failStarts = false;                                                             // the cause is removed…
  const retry = await linear.spawnWorkspaceForTicket('E2E-9001', repoDir);        // …and the user clicks spawn again
  const spawnedChildren = store.workspaces.filter((w) => !w.archived && w.repoPath === repoDir).length;
  Object.assign(out, { first, graduatedTo: afterFirst?.workspaceId, kept: !!kept, retry, workspaces: spawnedChildren });
  ok = first.ok === false && /failed to start/.test(first.error ?? '') && typeof first.workspaceId === 'string'
    && afterFirst?.workspaceId === first.workspaceId && !!kept && kept.lastTask?.includes('E2E-9001')
    && retry.ok === false && /already has a workspace/.test(retry.error ?? '') && spawnedChildren === 1;
}

out.ok = ok;
console.log(JSON.stringify(out));
process.exit(0);
