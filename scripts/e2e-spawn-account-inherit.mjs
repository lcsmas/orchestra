// #480 (closes #477) — a spawned child inherits its CALLER's Claude account; `--account` overrides.
// Drives the REAL dispatchAgentSpawnRequest / dispatchAddRepoRequest / createWorkspace + REAL store over a fake SDK seam
// (`registerSdkDelivery`: no claude process, no token) in a SCRATCH home. `<tree>` = the tree under test, or a worktree of origin/master
// for the must-FAIL (unfixed) run: there the ★ arms print ok:false.
//   inherit_added_repo ★ caller on `vf2`, repo just added via add-repo (no repo account) → child pinned `vf2`
//   inherit_detached   ★ same with --detached (skips only the nesting)           override_other ★ `account:'other'` → `other`
//   override_default     `account:'default'` → default login (no pin)             override_by_label ★ account given by its LABEL → its id
//   caller_default       caller on the default login + repo account `other` → `other` (today's behaviour, unchanged)
//   caller_dangling      caller pinned to a DELETED account + repo account `other` → `other`      no_caller  human path (no `from`) → repo's account
//   unknown_refused    ★ unknown `--account` → ok:false naming it, NOTHING created (no workspace, no branch)
//   inherit_beats_repo ★ caller on `vf2` + repo account `other` → `vf2`
// Run: node --experimental-strip-types --import ./scripts/.r2-register.mjs scripts/e2e-spawn-account-inherit.mjs [tree]   → prints one JSON, RC 0 = all ok
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
// Imported (hoisted) BEFORE the HOME override: the live dirs are captured at its load.
import { checkScratch } from './.scratch-guard.mjs';

const TREE = path.resolve(process.argv[2] ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
const BASE = process.env.E2E_HOME ?? path.join(process.env.TMPDIR ?? os.tmpdir(), 'e2e-spawn-account');
const home = path.join(BASE, path.basename(TREE) + '-' + process.pid);
const g = checkScratch(home, BASE);
if (!g.ok) { console.log(JSON.stringify({ ok: false, error: `SAFETY: ${g.clause} ${g.detail}` })); process.exit(3); }
fs.rmSync(home, { recursive: true, force: true });
fs.mkdirSync(path.join(home, '.orchestra'), { recursive: true });
process.env.ORCHESTRA_HOME = path.join(home, '.orchestra');
process.env.HOME = home;
delete process.env.CLAUDE_CONFIG_DIR;
// A stub `claude` on PATH records any launch: the fake SDK seam must make it unreachable.
const stubBin = path.join(home, 'stub-bin'); fs.mkdirSync(stubBin, { recursive: true });
const ranMarker = path.join(stubBin, 'claude.ran');
fs.writeFileSync(path.join(stubBin, 'claude'), `#!/bin/sh\necho ran >> '${ranMarker}'\nsleep 30\n`, { mode: 0o755 });
process.env.PATH = `${stubBin}:/usr/local/bin:/usr/bin:/bin`;

const { initPlatform } = await import(`${TREE}/src/main/platform/index.ts`);
initPlatform({
  kind: 'headless-e2e-spawn-account', broadcast: () => {}, broadcastPtyData: () => true, canBroadcast: () => true, isFocused: () => false, hasAttachedUi: () => false, notify: () => {},
  openExternal: () => {}, showItemInFolder: () => {}, openPath: () => {}, openAccountLoginUrl: () => {}, closeAccountLogin: () => {},
  getUserDataDir: () => home, getLogsDir: () => `${home}/logs`, getAppVersion: () => '0.0.0-e2e-spawn-account', getAppMetrics: () => [],
  isEncryptionAvailable: () => false, encryptString: (s) => s, decryptString: (s) => s,
});
const { store } = await import(`${TREE}/src/main/store.ts`);
await (await import('./neutral-memory-guard.mjs')).neutralizeMemoryGuard(TREE);
await store.load?.();
// A spawn with a spawner writes its task as that spawner's dispatch on the bus and is refused when the bus is not open (#435): open a real SCRATCH bus.
(await import(`${TREE}/src/main/bus.ts`)).initBus();
const workspaces = await import(`${TREE}/src/main/workspaces.ts`);
await import(`${TREE}/src/main/restart-workspace.ts`);
const delivery = await import(`${TREE}/src/main/sdk-delivery.ts`);
delivery.registerSdkDelivery({
  hasSession: () => false, hasBackgroundTask: () => false, send: async () => {}, sendAwaitingStart: async () => 'started', stop: async () => {},
  start: async () => {},
});

const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: home, GIT_AUTHOR_NAME: 'e2e', GIT_AUTHOR_EMAIL: 'e2e@example.invalid', GIT_COMMITTER_NAME: 'e2e', GIT_COMMITTER_EMAIL: 'e2e@example.invalid' } });
const repoDir = path.join(home, 'repo'); fs.mkdirSync(repoDir, { recursive: true });
git(repoDir, ['init', '-q', '-b', 'main']); fs.writeFileSync(path.join(repoDir, 'README.md'), '# e2e\n'); git(repoDir, ['add', '.']); git(repoDir, ['commit', '-q', '-m', 'seed']);
// Fake account dirs (scratch): no credentials, never read.
const acct = (id, label) => ({ id, label, configDir: path.join(home, `acct-${id}`) });
await store.setAccounts([acct('vf2', 'VF Two'), acct('other', 'Other')]);
// "the first spawn into a repo newly added with `orchestra add-repo`": the REAL add-repo route, so the repo carries NO account.
const added = await workspaces.dispatchAddRepoRequest({ path: repoDir });
const wt = (b) => { const p = path.join(home, `wt-${b}`); git(repoDir, ['worktree', 'add', '-q', '-b', b, p]); return p; };
const caller = (id, branch, accountId) => store.upsertWorkspace({ id, name: `repo · ${branch}`, repoPath: repoDir, worktreePath: wt(branch), branch, baseBranch: 'main', createdAt: 1, status: 'idle', agent: 'claude', ownsRun: true, branchManuallySet: true, setupStatus: 'ok', ...(accountId ? { accountId } : {}) });
await caller('ws-vf2', 'ops-vf2', 'vf2');
await caller('ws-plain', 'ops-plain');
await caller('ws-dangling', 'ops-dangling', 'gone');

const pin = (res) => (res?.id ? store.getWorkspace(res.id)?.accountId ?? null : '<no workspace: ' + (res?.error ?? '?') + '>');
const arms = [];
const arm = (name, star, got, want, extra = {}) => arms.push({ arm: name, star, got, want, ok: JSON.stringify(got) === JSON.stringify(want), ...extra });
const spawn = (from, name, more = {}) => workspaces.dispatchAgentSpawnRequest({ from, task: `task ${name}`, agent: 'claude', name, ...more });

const control = { addRepoOk: added.ok && !added.repo?.accountId, callerPin: store.getWorkspace('ws-vf2')?.accountId, accounts: store.accounts.map((a) => a.id) };
arm('control', false, control, { addRepoOk: true, callerPin: 'vf2', accounts: ['vf2', 'other'] });
arm('inherit_added_repo', true, pin(await spawn('ws-vf2', 'impl-child-a')), 'vf2');
arm('inherit_detached', true, pin(await spawn('ws-vf2', 'impl-child-b', { detached: true })), 'vf2');
arm('override_other', true, pin(await spawn('ws-vf2', 'impl-child-c', { account: 'other' })), 'other');
arm('override_by_label', true, pin(await spawn('ws-vf2', 'impl-child-d', { account: 'Other' })), 'other');
arm('override_default', false, pin(await spawn('ws-vf2', 'impl-child-e', { account: 'default' })), null);
const nBefore = store.workspaces.length; const branchesBefore = git(repoDir, ['branch', '--format=%(refname:short)']);
const refused = await spawn('ws-vf2', 'impl-child-f', { account: 'nope' });
arm('unknown_refused', true, { ok: refused.ok, names: /unknown account.*nope/.test(refused.error ?? ''), created: store.workspaces.length - nBefore, branchesSame: git(repoDir, ['branch', '--format=%(refname:short)']) === branchesBefore }, { ok: false, names: true, created: 0, branchesSame: true });
await store.setRepoAccount(repoDir, 'other');
arm('caller_default', false, pin(await spawn('ws-plain', 'impl-child-g')), 'other');
arm('caller_dangling', false, pin(await spawn('ws-dangling', 'impl-child-h')), 'other');
arm('no_caller', false, pin(await workspaces.dispatchSpawnRequest({ repoPath: repoDir, task: 'phone task', detached: true, defaultKind: 'workspace', origin: 'human' })), 'other');
arm('inherit_beats_repo', true, pin(await spawn('ws-vf2', 'impl-child-i')), 'vf2');
const ran = fs.existsSync(ranMarker);
const bad = arms.filter((a) => !a.ok).map((a) => a.arm);
const verdict = { tree: TREE, ok: bad.length === 0 && !ran, bad, stubClaudeRan: ran, home: checkScratch(home, BASE).ok ? 'scratch' : 'NOT-SCRATCH', arms };
console.log(JSON.stringify(verdict, null, 1));
process.exit(verdict.ok ? 0 : 1);
