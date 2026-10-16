// #382 follow-up — agent spawn names under CONCURRENCY and EXHAUSTION, through the REAL workspaces.ts (dispatchAgentSpawnRequest →
// dispatchSpawnRequest → createWorkspace → git worktree) + the REAL store, over a fake SDK seam (no agent runs). One arm per process.
//   race        N parallel spawns of the SAME name all succeed with DISTINCT names (impl-race, -2, -3 …) — before the fix 1 ok + N-1 raw
//               `a branch named … already exists`; control: the same N spawned one by one give the same set
//   exhausted   the requested name AND -2 … -99 all taken ⇒ the agent route REFUSES (nothing created); controls: -99 still free ⇒ ok `-99`;
//               a HUMAN path (no exactName: pinned-Linear / mobile shape) keeps today's random-branch fallback
//   alias       the SAME repo registered under two spellings (a symlink): parallel same-name spawns split across both still all succeed (lock keyed on the real path)
//   folder      a branch `impl-z/sub` exists ⇒ the agent route's `impl-z` suffixes to `impl-z-2` (git cannot hold both) instead of failing on git
//   released    a spawn whose `git worktree add` FAILS releases its reserved name: the next spawn of that name gets the bare name, not `-2`
// Run: node --experimental-strip-types --no-warnings --import ./scripts/.r2-register.mjs scripts/e2e-spawn-name-race.mjs <race|exhausted|alias|folder|released>
// Prints ONE JSON verdict line `{arm, ok, ...}` last; exit 0 iff ok. Scratch home under ~/.cache (the fs is part of the instrument).
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ARM = process.argv[2] ?? 'race';
if (!['race', 'exhausted', 'alias', 'folder', 'released'].includes(ARM)) { console.error(`unknown arm: ${ARM}`); process.exit(2); }
const tmpHome = path.join(process.env.SPAWN_RACE_HOME ?? path.join(os.homedir(), '.cache', 'e2e-spawn-name-race'), `${ARM}-${process.pid}`);
fs.rmSync(tmpHome, { recursive: true, force: true });
fs.mkdirSync(path.join(tmpHome, '.orchestra'), { recursive: true });
process.env.ORCHESTRA_HOME = path.join(tmpHome, '.orchestra');
process.env.HOME = tmpHome;
const stubBin = path.join(tmpHome, 'stub-bin'); fs.mkdirSync(stubBin, { recursive: true });
fs.writeFileSync(path.join(stubBin, 'claude'), '#!/bin/sh\nsleep 30\n', { mode: 0o755 });
process.env.PATH = `${stubBin}:/usr/local/bin:/usr/bin:/bin`;

const { initPlatform } = await import(`${REPO}/src/main/platform/index.ts`);
initPlatform({
  kind: 'headless-e2e-spawn-race', broadcast: () => {}, broadcastPtyData: () => true, canBroadcast: () => true, isFocused: () => false, hasAttachedUi: () => false, notify: () => {},
  openExternal: () => {}, showItemInFolder: () => {}, openPath: () => {}, openAccountLoginUrl: () => {}, closeAccountLogin: () => {},
  getUserDataDir: () => tmpHome, getLogsDir: () => `${tmpHome}/logs`, getAppVersion: () => '0.0.0-e2e-spawn-race', getAppMetrics: () => [],
  isEncryptionAvailable: () => false, encryptString: (s) => s, decryptString: (s) => s,
});
const { store } = await import(`${REPO}/src/main/store.ts`);
await (await import('./neutral-memory-guard.mjs')).neutralizeMemoryGuard(REPO);
await store.load?.();
const workspaces = await import(`${REPO}/src/main/workspaces.ts`);
await import(`${REPO}/src/main/restart-workspace.ts`);
const delivery = await import(`${REPO}/src/main/sdk-delivery.ts`);
delivery.registerSdkDelivery({
  hasSession: () => false, hasBackgroundTask: () => false, send: async () => {}, sendAwaitingStart: async () => 'started', stop: async () => {},
  start: async () => {},
});

const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: tmpHome, GIT_AUTHOR_NAME: 'e2e', GIT_AUTHOR_EMAIL: 'e2e@example.invalid', GIT_COMMITTER_NAME: 'e2e', GIT_COMMITTER_EMAIL: 'e2e@example.invalid' } });
const repoDir = path.join(tmpHome, 'repo'); fs.mkdirSync(repoDir, { recursive: true });
git(repoDir, ['init', '-q', '-b', 'main']); fs.writeFileSync(path.join(repoDir, 'README.md'), '# e2e\n'); git(repoDir, ['add', '.']); git(repoDir, ['commit', '-q', '-m', 'seed']);
await store.addRepo({ path: repoDir, name: 'repo', defaultBranch: 'main' });
const opsWt = path.join(tmpHome, 'wt-ops'); git(repoDir, ['worktree', 'add', '-q', '-b', 'ops-parent', opsWt]);
await store.upsertWorkspace({ id: 'ws-ops', name: 'repo · ops-parent', repoPath: repoDir, worktreePath: opsWt, branch: 'ops-parent', baseBranch: 'main', createdAt: 1, status: 'idle', agent: 'claude', canOrchestrate: true, branchManuallySet: true, setupStatus: 'ok' });

const branches = () => git(repoDir, ['branch', '--format=%(refname:short)']).trim().split('\n').filter(Boolean).sort();
const worktreeDirs = () => fs.readdirSync(path.join(os.homedir(), '.orchestra', 'worktrees')).length; // ORCHESTRA_ROOT under the scratch HOME
const agentSpawn = (name, over = {}) => workspaces.dispatchAgentSpawnRequest({ from: 'ws-ops', task: `brief for ${name}`, agent: 'claude', name, ...over });
const out = { arm: ARM };
let ok = false;

if (ARM === 'race') {
  const N = 5;
  const before = { ws: store.workspaces.length, branches: branches() };
  const results = await Promise.all(Array.from({ length: N }, () => agentSpawn('impl-race')));
  const got = results.map((r) => r.branch).sort();
  const want = ['impl-race', ...Array.from({ length: N - 1 }, (_, i) => `impl-race-${i + 2}`)].sort();
  const created = store.workspaces.filter((w) => w.parentId === 'ws-ops');
  const wsAfterRace = store.workspaces.length; // BEFORE the control spawns below add theirs
  // control: the same N, one by one, in a fresh name space ⇒ the same shape (the suffix contract itself is not what changed)
  const seq = []; for (let i = 0; i < N; i++) seq.push((await agentSpawn('impl-seq')).branch);
  Object.assign(out, {
    results: results.map((r) => ({ ok: r.ok, branch: r.branch ?? null, error: r.error ?? null })), got, want,
    allOk: results.every((r) => r.ok === true), distinct: new Set(got).size === N, expectedSet: JSON.stringify(got) === JSON.stringify(want),
    gitHasThem: want.every((b) => branches().includes(b)), recordsMatch: created.filter((w) => w.branch.startsWith('impl-race')).length === N && created.filter((w) => w.branch.startsWith('impl-race')).every((w) => w.namedByParent === 'ws-ops'),
    wsDelta: wsAfterRace - before.ws - N, // 0 = exactly N children, nothing half-created
    sequentialControl: seq.sort(), sequentialOk: JSON.stringify(seq.sort()) === JSON.stringify(['impl-seq', 'impl-seq-2', 'impl-seq-3', 'impl-seq-4', 'impl-seq-5']),
  });
  ok = out.allOk && out.distinct && out.expectedSet && out.gitHasThem && out.recordsMatch && out.wsDelta === 0 && out.sequentialOk;
}

if (ARM === 'exhausted') {
  const take = (base, upTo) => { git(repoDir, ['branch', base]); for (let n = 2; n <= upTo; n++) git(repoDir, ['branch', `${base}-${n}`]); };
  // boundary: impl-y … impl-y-98 taken ⇒ `-99` is the last slot ⇒ still ok
  take('impl-y', 98);
  const last = await agentSpawn('impl-y');
  // now impl-x … impl-x-99 ALL taken ⇒ refused
  take('impl-x', 99);
  const before = { ws: store.workspaces.length, branches: branches(), dirs: worktreeDirs() };
  const refused = await agentSpawn('impl-x');
  const after = { ws: store.workspaces.length, branches: branches(), dirs: worktreeDirs() };
  // control: a HUMAN path (pinned-Linear / accès-mobile shape: no exactName) keeps today's random fallback when its slots are gone
  const human = await workspaces.dispatchSpawnRequest({ repoPath: repoDir, task: 'human path', branch: 'impl-x', detached: true, defaultKind: 'workspace' });
  Object.assign(out, {
    lastSlot: { ok: last.ok, branch: last.branch ?? null },
    refused: { ok: refused.ok, error: refused.error ?? null, id: refused.id ?? null },
    nothingCreated: after.ws === before.ws && JSON.stringify(after.branches) === JSON.stringify(before.branches) && after.dirs === before.dirs,
    human: { ok: human.ok, branch: human.branch ?? null, randomShape: /^[a-z]+-[a-z]+$/.test(human.branch ?? '') },
  });
  ok = out.lastSlot.ok === true && out.lastSlot.branch === 'impl-y-99'
    && out.refused.ok === false && /all its suffixes/.test(out.refused.error ?? '') && /Nothing was created/.test(out.refused.error ?? '') && out.refused.id === null
    && out.nothingCreated && out.human.ok === true && out.human.randomShape;
}

if (ARM === 'alias') {
  const link = path.join(tmpHome, 'repo-link');
  fs.symlinkSync(repoDir, link);
  await store.addRepo({ path: link, name: 'repo-link', defaultBranch: 'main' });
  const results = await Promise.all([repoDir, link, repoDir, link].map((repoPath) => agentSpawn('impl-al', { repoPath })));
  const got = results.map((r) => r.branch ?? null).sort();
  Object.assign(out, {
    results: results.map((r) => ({ ok: r.ok, branch: r.branch ?? null, error: r.error ?? null })), got,
    allOk: results.every((r) => r.ok === true), distinct: new Set(got).size === 4,
    expectedSet: JSON.stringify(got) === JSON.stringify(['impl-al', 'impl-al-2', 'impl-al-3', 'impl-al-4']),
  });
  ok = out.allOk && out.distinct && out.expectedSet;
}

if (ARM === 'folder') {
  git(repoDir, ['branch', 'impl-z/sub']);
  const r = await agentSpawn('impl-z');
  // control: no folder conflict ⇒ the bare name (the avoidance does not suffix names that are free)
  const plain = await agentSpawn('impl-w');
  Object.assign(out, { folder: { ok: r.ok, branch: r.branch ?? null, error: r.error ?? null }, plain: { ok: plain.ok, branch: plain.branch ?? null } });
  ok = r.ok === true && r.branch === 'impl-z-2' && plain.ok === true && plain.branch === 'impl-w';
}

if (ARM === 'released') {
  const failed = await agentSpawn('impl-r', { baseBranch: 'no-such-base' });          // `git worktree add -b impl-r <path> no-such-base` fails
  const after = await agentSpawn('impl-r');
  const wsAfterFail = store.workspaces.filter((w) => w.branch === 'impl-r' || w.branch === 'impl-r-2').length;
  Object.assign(out, { failed: { ok: failed.ok, error: (failed.error ?? '').slice(0, 120) }, after: { ok: after.ok, branch: after.branch ?? null }, records: wsAfterFail, branchesNow: branches().filter((b) => b.startsWith('impl-r')) });
  ok = failed.ok === false && after.ok === true && after.branch === 'impl-r' && out.records === 1 && JSON.stringify(out.branchesNow) === JSON.stringify(['impl-r']);
}

out.ok = ok;
console.log(JSON.stringify(out));
fs.rmSync(tmpHome, { recursive: true, force: true });
process.exit(ok ? 0 : 1);
