// #382 / #380 D4 / ledger G7 — the HUMAN paths that reuse dispatchSpawnRequest stay byte-identical, even when `from` is set.
// Drives the REAL workspaces.ts / linear-tickets.ts / store over a fake SDK seam (like e2e-spawn-failure.mjs) against ANY source tree
// (`<tree>` = this repo or a worktree of the base): prints one JSON of normalised workspace records, one per path. The caller diffs the
// output of the BASE tree against the output of the tree under test — equal ⇒ no change in branch / name / nudge fields / opening task.
//   pinned_linear_from   an agent's `orchestra linear add --spawn` (spawnWorkspaceForTicket with `from` ⇒ defaultKind 'spawned', nested)
//   pinned_linear_human  the sidebar's « spawn from ticket » click (no `from` ⇒ 'workspace', top-level)
//   mobile_launch        the accès mobile call, verbatim: { repoPath, task, detached:true, defaultKind:'workspace', origin:'human' }
//   agent_named / agent_refused   (tree under test only) dispatchAgentSpawnRequest: a named spawn records the namer; a nameless one creates nothing
// Run: node --experimental-strip-types --import ./scripts/.r2-register.mjs scripts/e2e-spawn-name-human-paths.mjs <tree> <label> [out.json]
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

const TREE = path.resolve(process.argv[2] ?? '.');
const LABEL = process.argv[3] ?? 'tree';
const OUTFILE = process.argv[4];
const tmpHome = path.join(process.env.E2E_HOME ?? path.join(os.homedir(), '.cache', 'e2e-spawn-name-human'), LABEL);
fs.rmSync(tmpHome, { recursive: true, force: true });
fs.mkdirSync(path.join(tmpHome, '.orchestra'), { recursive: true });
process.env.ORCHESTRA_HOME = path.join(tmpHome, '.orchestra');
process.env.HOME = tmpHome;
const stubBin = path.join(tmpHome, 'stub-bin'); fs.mkdirSync(stubBin, { recursive: true });
fs.writeFileSync(path.join(stubBin, 'claude'), '#!/bin/sh\nsleep 30\n', { mode: 0o755 });
process.env.PATH = `${stubBin}:/usr/local/bin:/usr/bin:/bin`;

const { initPlatform } = await import(`${TREE}/src/main/platform/index.ts`);
initPlatform({
  kind: 'headless-e2e-spawn-name', broadcast: () => {}, broadcastPtyData: () => true, canBroadcast: () => true, isFocused: () => false, hasAttachedUi: () => false, notify: () => {},
  openExternal: () => {}, showItemInFolder: () => {}, openPath: () => {}, openAccountLoginUrl: () => {}, closeAccountLogin: () => {},
  getUserDataDir: () => tmpHome, getLogsDir: () => `${tmpHome}/logs`, getAppVersion: () => '0.0.0-e2e-spawn-name', getAppMetrics: () => [],
  isEncryptionAvailable: () => false, encryptString: (s) => s, decryptString: (s) => s,
});
const { store } = await import(`${TREE}/src/main/store.ts`);
await (await import('./neutral-memory-guard.mjs')).neutralizeMemoryGuard(TREE);
await store.load?.();
const workspaces = await import(`${TREE}/src/main/workspaces.ts`);
const linear = await import(`${TREE}/src/main/linear-tickets.ts`);
await import(`${TREE}/src/main/restart-workspace.ts`);
const delivery = await import(`${TREE}/src/main/sdk-delivery.ts`);
const starts = [];
delivery.registerSdkDelivery({
  hasSession: () => false, hasBackgroundTask: () => false, send: async () => {}, sendAwaitingStart: async () => 'started', stop: async () => {},
  start: async (wsId, text) => { starts.push({ wsId, text }); },
});

const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: tmpHome, GIT_AUTHOR_NAME: 'e2e', GIT_AUTHOR_EMAIL: 'e2e@example.invalid', GIT_COMMITTER_NAME: 'e2e', GIT_COMMITTER_EMAIL: 'e2e@example.invalid' } });
const repoDir = path.join(tmpHome, 'repo'); fs.mkdirSync(repoDir, { recursive: true });
git(repoDir, ['init', '-q', '-b', 'main']); fs.writeFileSync(path.join(repoDir, 'README.md'), '# e2e\n'); git(repoDir, ['add', '.']); git(repoDir, ['commit', '-q', '-m', 'seed']);
await store.addRepo({ path: repoDir, name: 'repo', defaultBranch: 'main' });
const opsWt = path.join(tmpHome, 'wt-ops'); git(repoDir, ['worktree', 'add', '-q', '-b', 'ops-parent', opsWt]);
await store.upsertWorkspace({ id: 'ws-ops', name: 'repo · ops-parent', repoPath: repoDir, worktreePath: opsWt, branch: 'ops-parent', baseBranch: 'main', createdAt: 1, status: 'idle', agent: 'claude', canOrchestrate: true, branchManuallySet: true, setupStatus: 'ok' });
for (const [identifier, title] of [['NMC-382', 'Rig ticket for the agent variant'], ['NMC-383', 'Rig ticket for the click variant']])
  await store.upsertTicket({ identifier, title, url: `https://linear.app/x/issue/${identifier}/rig`, pinnedAt: 1 });

/** The record, minus what legitimately differs run to run (ids, times, paths, port). The nudge verdict is derived from the stored fields. */
const RANDOM_NAME = /^[a-z]+-[a-z]+$/; // the generated adjective-noun branch: random per run, so it is masked and its SHAPE asserted instead
const normalise = (ws) => {
  const { id, createdAt, worktreePath, port, repoPath, ...rest } = ws;
  void id; void createdAt; void port; void repoPath;
  const nudge = !ws.branchManuallySet && !ws.namedByParent && (ws.autoRenameCount ?? 0) < 2;
  const out = { ...Object.fromEntries(Object.entries(rest).sort()), _nudgeActive: nudge, _worktreeBase: path.basename(worktreePath).replace(/-[0-9a-f]{8}$/, '-<id8>') };
  if (RANDOM_NAME.test(ws.branch)) {
    const mask = (v) => String(v).split(ws.branch).join('<generated>');
    return { ...out, branch: '<generated adjective-noun>', name: mask(out.name), _worktreeBase: mask(out._worktreeBase), _branchIsGenerated: true };
  }
  return { ...out, _branchIsGenerated: false };
};
const out = { label: LABEL, tree: TREE, paths: {} };
const record = (name, res, extra = {}) => {
  const ws = res?.id ? store.getWorkspace(res.id) : res?.workspaceId ? store.getWorkspace(res.workspaceId) : undefined;
  out.paths[name] = { ok: res?.ok ?? null, error: res?.error ?? null, branch: res?.branch && RANDOM_NAME.test(res.branch) ? '<generated adjective-noun>' : res?.branch ?? null, record: ws ? normalise(ws) : null, task: starts.find((s) => s.wsId === ws?.id)?.text ?? null, ...extra };
};

record('pinned_linear_from', await linear.spawnWorkspaceForTicket('NMC-382', repoDir, undefined, 'ws-ops'));
record('pinned_linear_human', await linear.spawnWorkspaceForTicket('NMC-383', repoDir));
record('mobile_launch', await workspaces.dispatchSpawnRequest({ repoPath: repoDir, task: 'phone task', detached: true, defaultKind: 'workspace', origin: 'human' }));
if (typeof workspaces.dispatchAgentSpawnRequest === 'function') {
  const before = store.workspaces.length;
  record('agent_named', await workspaces.dispatchAgentSpawnRequest({ from: 'ws-ops', task: 'agent task', agent: 'claude', name: 'impl-x-1' }));
  const refused = await workspaces.dispatchAgentSpawnRequest({ from: 'ws-ops', task: 'agent task', agent: 'claude' });
  record('agent_refused', refused, { workspacesBefore: before + 1, workspacesAfter: store.workspaces.length, branches: git(repoDir, ['branch', '--format=%(refname:short)']).trim().split('\n').sort() });
} else {
  out.paths.agent_named = 'n/a — this tree has no dispatchAgentSpawnRequest';
}
const json = JSON.stringify(out, null, 2);
if (OUTFILE) fs.writeFileSync(OUTFILE, json);
console.log(json);
process.exit(0);
