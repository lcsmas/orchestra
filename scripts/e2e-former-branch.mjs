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
const { renameWorkspaceBranch, dispatchPeersRequest } = await import(`${REPO}/src/main/workspaces.ts`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = { arm: ARM };

if (ARM === 'table') {
  const cases = {};
  // `disk` = what store.json holds right after THIS rename (not only the returned object).
  // `bc*` = the LAST `workspace:update` payload main broadcast for this workspace (what the renderer merges): its branch proves a broadcast
  // really happened for THIS rename, its formerBranch is what the sidebar tooltip is built from.
  const lastBroadcast = (id) => [...broadcasts].reverse().find((b) => b.channel === 'workspace:update' && b.args?.[0]?.id === id)?.args[0];
  const record = (name, ws, extra = {}) => { const bc = lastBroadcast(ws.id); cases[name] = { formerBranch: ws.formerBranch, branch: ws.branch, disk: onDisk(ws.id)?.formerBranch, bcBranch: bc?.branch, bcFormer: bc?.formerBranch, ...extra }; };

  // 1-3. parent-named: first rename, second replaces, same-name no-op leaves it
  const wtA = await mkWt('A', 'lucky-willow', { namedByParent: 'P' });
  broadcasts.length = 0;
  record('first', await renameWorkspaceBranch('A', 'impl-x-1', { manual: false, bumpAutoCount: false }), { live: liveBranch(wtA) });
  const firstBroadcast = broadcasts.filter((b) => b.channel === 'workspace:update').pop();
  cases.first.broadcastFormer = firstBroadcast?.args?.[0]?.formerBranch;
  record('second', await renameWorkspaceBranch('A', 'impl-x-2', { manual: false, bumpAutoCount: false }), { live: liveBranch(wtA) });
  record('same_name', await renameWorkspaceBranch('A', 'impl-x-2', { manual: false, bumpAutoCount: false }), { live: liveBranch(wtA) });
  record('same_name_human', await renameWorkspaceBranch('A', 'impl-x-2', { manual: true, bumpAutoCount: false }), { live: liveBranch(wtA) });
  record('human_rename', await renameWorkspaceBranch('A', 'impl-x-3', { manual: true, bumpAutoCount: false }), { live: liveBranch(wtA) });

  // 4. human-created workspace: the two provisional self-renames record NOTHING
  await mkWt('H', 'silver-moth');
  record('human_created_1', await renameWorkspaceBranch('H', 'fix-typo', { manual: false, bumpAutoCount: true }));
  record('human_created_2', await renameWorkspaceBranch('H', 'fix-typo-refined', { manual: false, bumpAutoCount: true }));
  // …and a human sidebar rename of a human-created workspace records nothing either
  record('human_created_ui', await renameWorkspaceBranch('H', 'fix-typo-ui', { manual: true, bumpAutoCount: false }));

  // 5. pin-on-rename: unnamed before, parent-named AFTER (#383/#385) ⇒ recorded
  await mkWt('U', 'calm-otter');
  record('pin_on_rename', await renameWorkspaceBranch('U', 'impl-u-1', { manual: false, bumpAutoCount: false, namedByParent: 'P' }));

  // 6. scratch-like relabel (no git branch): parent-named records, human-created does not
  for (const [id, named] of [['S1', true], ['S2', false]]) {
    await store.upsertWorkspace({
      id, name: `scratch · lab-${id}`, kind: 'scratch', repoPath: '', branch: `lab-${id}`,
      worktreePath: path.join(tmpHome, 'wt', id), status: 'idle', createdAt: Date.now(), hasInput: false,
      ...(named ? { namedByParent: 'P' } : {}),
    });
    record(named ? 'scratch_named' : 'scratch_human', await renameWorkspaceBranch(id, `explo-${id}`, { manual: false, bumpAutoCount: false }));
  }
  record('scratch_same', await renameWorkspaceBranch('S1', 'explo-S1', { manual: false, bumpAutoCount: false }));

  // 7. drifted STORED branch: HEAD was renamed out of band (reconciler not yet visited) — the recorded former is the DISPLAYED (stored) name,
  //    never the live name nobody saw; and a request equal to the displayed name is NO name change (no `ex-` on an unchanged name)
  const wtD = await mkWt('D', 'stored-stale', { namedByParent: 'P' });
  git(wtD, 'branch', '-m', 'stored-stale', 'really-live');
  record('drifted', await renameWorkspaceBranch('D', 'impl-d-1', { manual: false, bumpAutoCount: false }), { live: liveBranch(wtD) });
  const wtK = await mkWt('K', 'k-shown', { namedByParent: 'P' });
  git(wtK, 'branch', '-m', 'k-shown', 'k-live');
  record('drift_same_displayed', await renameWorkspaceBranch('K', 'k-shown', { manual: false, bumpAutoCount: false }), { live: liveBranch(wtK) });

  // 9. drift ADOPTION write: requested name == live branch, stored name stale (an out-of-band `git branch -m` the reconciler has not
  //    visited yet) and a human pin advances the gate ⇒ the record's name changes stored→live, and that is recorded too
  const wtE = await mkWt('E', 'e-old', { namedByParent: 'P' });
  git(wtE, 'branch', '-m', 'e-old', 'e-live');
  record('drift_adopt', await renameWorkspaceBranch('E', 'e-live', { manual: true, bumpAutoCount: false }), { live: liveBranch(wtE) });

  // 10. the out-of-band reconciler (`git branch -m` by hand, adopted by detectAndUpdateBranchName): parent-named records, human-created does not
  const { detectAndUpdateBranchName } = await import(`${REPO}/src/main/activity.ts`);
  for (const [id, named] of [['F', true], ['G', false]]) {
    const wt = await mkWt(id, `${id.toLowerCase()}-old`, named ? { namedByParent: 'P' } : {});
    git(wt, 'branch', '-m', `${id.toLowerCase()}-old`, `${id.toLowerCase()}-new`);
    await detectAndUpdateBranchName(id);
    await sleep(400);
    record(named ? 'oob_named' : 'oob_human', store.getWorkspace(id), { live: liveBranch(wt), pinned: store.getWorkspace(id).branchManuallySet });
  }

  // the REAL /peers payload: a renamed workspace carries `formerBranch`, a never-renamed one carries no such key
  const peers = (await dispatchPeersRequest({ from: 'nobody' })).peers ?? [];
  const peersById = Object.fromEntries(peers.map((p) => [p.id, { formerBranch: p.formerBranch, hasKey: 'formerBranch' in p }]));
  Object.assign(out, { cases, peers: peersById });
  out.ok = true;
} else if (ARM === 'persist_write') {
  await mkWt('A', 'lucky-willow', { namedByParent: 'P' });
  const ws = await renameWorkspaceBranch('A', 'impl-persist-1', { manual: false, bumpAutoCount: false });
  Object.assign(out, { formerBranch: ws.formerBranch, onDisk: onDisk('A')?.formerBranch, home: tmpHome });
  out.ok = ws.formerBranch === 'lucky-willow' && onDisk('A')?.formerBranch === 'lucky-willow';
} else if (ARM === 'persist_read') {
  const ws = store.getWorkspace('A');
  Object.assign(out, { loadedFromDisk: store.loadedFromDisk, found: !!ws, branch: ws?.branch, formerBranch: ws?.formerBranch });
  out.ok = store.loadedFromDisk && ws?.formerBranch === 'lucky-willow';
}

console.log(JSON.stringify(out));
process.exit(out.ok ? 0 : 1);
