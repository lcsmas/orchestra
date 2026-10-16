// #384 — `formerBranch` ("ex-…") recorded by the REAL renameWorkspaceBranch (real git worktrees, real store).
// One arm per process; prints one JSON line. Driven by src/main/former-branch-rig.test.ts.
//   table         the rename-records-former table (first / second / same-name no-op / human-created / pin-on-rename /
//                 human rename / scratch relabel / drifted stored branch) + the workspace:update payload
//   persist_write rename a parent-named workspace, leave the home dir behind
//   persist_read  FRESH process: store.load() the home persist_write left, read formerBranch back
// Run: node --experimental-strip-types --import ./scripts/.r2-register.mjs scripts/e2e-former-branch.mjs <arm>

import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ARM = process.argv[2] ?? 'table';
if (!['table', 'persist_write', 'persist_read'].includes(ARM)) { console.error(`unknown arm: ${ARM}`); process.exit(2); }

// Under the real home (btrfs), NOT /tmp: the fs is part of the instrument. Scratch HOME — never the live ~/.orchestra.
const tmpHome = process.env.E2E_HOME ?? path.join(os.homedir(), '.cache', 'e2e-former-branch');
if (ARM !== 'persist_read') fs.rmSync(tmpHome, { recursive: true, force: true });
fs.mkdirSync(path.join(tmpHome, '.orchestra'), { recursive: true });
process.env.ORCHESTRA_HOME = path.join(tmpHome, '.orchestra');
process.env.HOME = tmpHome;

const { initPlatform } = await import(`${REPO}/src/main/platform/index.ts`);
const broadcasts = [];
initPlatform({
  kind: 'headless-e2e-former-branch',
  broadcast: (channel, ...args) => { broadcasts.push({ channel, args }); },
  broadcastPtyData: () => true, canBroadcast: () => true,
  isFocused: () => false, hasAttachedUi: () => false, notify: () => {},
  openExternal: () => {}, showItemInFolder: () => {}, openPath: () => {},
  openAccountLoginUrl: () => {}, closeAccountLogin: () => {},
  getUserDataDir: () => tmpHome, getLogsDir: () => `${tmpHome}/logs`,
  getAppVersion: () => '0.0.0-e2e-former-branch', getAppMetrics: () => [],
  isEncryptionAvailable: () => false, encryptString: (s) => s, decryptString: (s) => s,
});

const { store } = await import(`${REPO}/src/main/store.ts`);
await store.load?.();
const STORE_JSON = path.join(tmpHome, 'orchestra', 'store.json');
const onDisk = (id) => (JSON.parse(fs.readFileSync(STORE_JSON, 'utf8')).workspaces ?? []).find((w) => w.id === id);

const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.email=e@e', '-c', 'user.name=e', ...args], { cwd, encoding: 'utf8' }).trim();
const repo = path.join(tmpHome, 'repo');
if (ARM !== 'persist_read') {
  fs.mkdirSync(repo, { recursive: true });
  git(repo, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repo, 'f'), 'x');
  git(repo, 'add', 'f');
  git(repo, 'commit', '-q', '-m', 'init');
}
const mkWt = async (id, branch, extra = {}) => {
  const worktreePath = path.join(tmpHome, 'wt', id);
  git(repo, 'worktree', 'add', '-q', '-b', branch, worktreePath);
  await store.upsertWorkspace({
    id, name: `repo · ${branch}`, kind: 'worktree', repoPath: repo, branch, baseBranch: 'main',
    worktreePath, status: 'idle', createdAt: Date.now(), hasInput: false, ...extra,
  });
  return worktreePath;
};
const liveBranch = (wt) => git(wt, 'rev-parse', '--abbrev-ref', 'HEAD');
const { renameWorkspaceBranch } = await import(`${REPO}/src/main/workspaces.ts`);

const out = { arm: ARM };

if (ARM === 'table') {
  const cases = {};
  // `disk` = what store.json holds right after THIS rename (not only the returned object).
  const record = (name, ws, extra = {}) => { cases[name] = { formerBranch: ws.formerBranch, branch: ws.branch, disk: onDisk(ws.id)?.formerBranch, ...extra }; };

  // 1-3. parent-named: first rename, second replaces, same-name no-op leaves it
  const wtA = await mkWt('A', 'lucky-willow', { namedByParent: 'P' });
  broadcasts.length = 0;
  record('first', await renameWorkspaceBranch('A', 'impl-x-1', { manual: false }), { live: liveBranch(wtA) });
  const firstBroadcast = broadcasts.filter((b) => b.channel === 'workspace:update').pop();
  cases.first.broadcastFormer = firstBroadcast?.args?.[0]?.formerBranch;
  record('second', await renameWorkspaceBranch('A', 'impl-x-2', { manual: false }), { live: liveBranch(wtA) });
  record('same_name', await renameWorkspaceBranch('A', 'impl-x-2', { manual: false }), { live: liveBranch(wtA) });
  record('same_name_human', await renameWorkspaceBranch('A', 'impl-x-2', { manual: true }), { live: liveBranch(wtA) });
  record('human_rename', await renameWorkspaceBranch('A', 'impl-x-3', { manual: true }), { live: liveBranch(wtA) });

  // 4. human-created workspace: the two provisional self-renames record NOTHING
  await mkWt('H', 'silver-moth');
  record('human_created_1', await renameWorkspaceBranch('H', 'fix-typo', { manual: false, bumpAutoCount: true }));
  record('human_created_2', await renameWorkspaceBranch('H', 'fix-typo-refined', { manual: false, bumpAutoCount: true }));
  // …and a human sidebar rename of a human-created workspace records nothing either
  record('human_created_ui', await renameWorkspaceBranch('H', 'fix-typo-ui', { manual: true }));

  // 5. pin-on-rename: unnamed before, parent-named AFTER (#383/#385) ⇒ recorded
  await mkWt('U', 'calm-otter');
  record('pin_on_rename', await renameWorkspaceBranch('U', 'impl-u-1', { manual: false, namedByParent: 'P' }));

  // 6. scratch-like relabel (no git branch): parent-named records, human-created does not
  for (const [id, named] of [['S1', true], ['S2', false]]) {
    await store.upsertWorkspace({
      id, name: `scratch · lab-${id}`, kind: 'scratch', repoPath: '', branch: `lab-${id}`,
      worktreePath: path.join(tmpHome, 'wt', id), status: 'idle', createdAt: Date.now(), hasInput: false,
      ...(named ? { namedByParent: 'P' } : {}),
    });
    record(named ? 'scratch_named' : 'scratch_human', await renameWorkspaceBranch(id, `explo-${id}`, { manual: false }));
  }
  record('scratch_same', await renameWorkspaceBranch('S1', 'explo-S1', { manual: false }));

  // 7. drifted STORED branch: HEAD was renamed out of band — the recorded former is the LIVE name
  const wtD = await mkWt('D', 'stored-stale', { namedByParent: 'P' });
  git(wtD, 'branch', '-m', 'stored-stale', 'really-live');
  record('drifted', await renameWorkspaceBranch('D', 'impl-d-1', { manual: false }), { live: liveBranch(wtD) });

  Object.assign(out, { cases });
  out.ok = true;
} else if (ARM === 'persist_write') {
  await mkWt('A', 'lucky-willow', { namedByParent: 'P' });
  const ws = await renameWorkspaceBranch('A', 'impl-persist-1', { manual: false });
  Object.assign(out, { formerBranch: ws.formerBranch, onDisk: onDisk('A')?.formerBranch, home: tmpHome });
  out.ok = ws.formerBranch === 'lucky-willow' && onDisk('A')?.formerBranch === 'lucky-willow';
} else if (ARM === 'persist_read') {
  const ws = store.getWorkspace('A');
  Object.assign(out, { loadedFromDisk: store.loadedFromDisk, found: !!ws, branch: ws?.branch, formerBranch: ws?.formerBranch });
  out.ok = store.loadedFromDisk && ws?.formerBranch === 'lucky-willow';
}

console.log(JSON.stringify(out));
process.exit(out.ok ? 0 : 1);
