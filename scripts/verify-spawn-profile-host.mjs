// #401 — the HOST half of `orchestra spawn --profile`, Electron-free (no GUI, no D-Bus): the REAL workspaces.ts / store / session-key registry /
// git over a fake SDK seam (same loader as e2e-spawn-name-human-paths.mjs). Deterministic where the GUI rig cannot be: a `post-checkout` hook inside
// `git worktree add` HOLDS the spawn at its slowest step so the harness can change the parent's record, the profile list or the session key
// while the child is being created — the TOCTOU window of review M1.
//   h1  honoured: record carries the held profile + report applied
//   h2  refused (a profile the parent does not hold) · h3 --detached · h4 unvouched (no key / wrong key / superseded) · h5 no --profile
//   t1  CONTROL window (nothing changes while held) → honoured: the instrument can say yes
//   t2  parent DETACHED by the human while the child is being created → child ephemeral    t3  profile DELETED meanwhile → ephemeral
//   t4  parent SWITCHED to another profile meanwhile → ephemeral          t5  parent's session SUPERSEDED meanwhile → refused (unvouched)
//   d1  (REAL profile service #400, serial chain) a delete of the profile is RUNNING at the record build (carriers already scanned) → refused 'deleting', child ephemeral
//   d2  a delete is QUEUED behind another op (not started) at the record build → honoured, and the delete's carrier scan then DETACHES the child: no child ends up carrying a deleted profile
//   w1  whoami: held profile shown ONLY to the vouched live session of that workspace (M2); omitted (never null) otherwise
// Run: node --experimental-strip-types --import ./scripts/.r2-register.mjs scripts/verify-spawn-profile-host.mjs <tree>     (rc 0 = every clause PASS; prints FAIL <label>)
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

const TREE = path.resolve(process.argv[2] ?? '.');
const tmpHome = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'verify-spawn-profile-host-'));
fs.mkdirSync(path.join(tmpHome, '.orchestra'), { recursive: true });
process.env.ORCHESTRA_HOME = path.join(tmpHome, '.orchestra');
process.env.HOME = tmpHome;
const stubBin = path.join(tmpHome, 'stub-bin'); fs.mkdirSync(stubBin, { recursive: true });
fs.writeFileSync(path.join(stubBin, 'claude'), '#!/bin/sh\nsleep 30\n', { mode: 0o755 });
process.env.PATH = `${stubBin}:/usr/local/bin:/usr/bin:/bin`;

let failures = 0, total = 0;
const check = (label, cond, detail = '') => { total++; if (cond) console.log(`  ok   ${label}`); else { failures++; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms, what) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return; await sleep(25); } throw new Error(`timeout waiting for ${what}`); }

const { initPlatform } = await import(`${TREE}/src/main/platform/index.ts`);
initPlatform({
  kind: 'headless-verify-spawn-profile', broadcast: () => {}, broadcastPtyData: () => true, canBroadcast: () => true, isFocused: () => false, hasAttachedUi: () => false, notify: () => {},
  openExternal: () => {}, showItemInFolder: () => {}, openPath: () => {}, openAccountLoginUrl: () => {}, closeAccountLogin: () => {},
  getUserDataDir: () => tmpHome, getLogsDir: () => `${tmpHome}/logs`, getAppVersion: () => '0.0.0-verify-spawn-profile', getAppMetrics: () => [],
  isEncryptionAvailable: () => false, encryptString: (s) => s, decryptString: (s) => s,
});
const { store } = await import(`${TREE}/src/main/store.ts`);
await (await import('./neutral-memory-guard.mjs')).neutralizeMemoryGuard(TREE);
await store.load?.();
const workspaces = await import(`${TREE}/src/main/workspaces.ts`);
const identity = await import(`${TREE}/src/main/session-identity-host.ts`);
await import(`${TREE}/src/main/restart-workspace.ts`);
const profileSvcMod = await import(`${TREE}/src/main/browser-profiles.ts`);
const gate = await import(`${TREE}/src/main/spawn-profile-gate.ts`);
const delivery = await import(`${TREE}/src/main/sdk-delivery.ts`);
delivery.registerSdkDelivery({ hasSession: () => false, hasBackgroundTask: () => false, send: async () => {}, sendAwaitingStart: async () => 'started', stop: async () => {}, start: async () => {} });

const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: tmpHome, GIT_AUTHOR_NAME: 'e2e', GIT_AUTHOR_EMAIL: 'e2e@example.invalid', GIT_COMMITTER_NAME: 'e2e', GIT_COMMITTER_EMAIL: 'e2e@example.invalid' } });
const repoDir = path.join(tmpHome, 'repo'); fs.mkdirSync(repoDir, { recursive: true });
git(repoDir, ['init', '-q', '-b', 'main']); fs.writeFileSync(path.join(repoDir, 'README.md'), '# e2e\n'); git(repoDir, ['add', '.']); git(repoDir, ['commit', '-q', '-m', 'seed']);
await store.addRepo({ path: repoDir, name: 'repo', defaultBranch: 'main' });
// the hold: a post-checkout hook (fires inside `git worktree add`) that blocks while `hold-enabled` exists, until `release` appears
const marks = path.join(tmpHome, 'marks'); fs.mkdirSync(marks);
fs.writeFileSync(path.join(repoDir, '.git', 'hooks', 'post-checkout'), `#!/bin/sh\nif [ -f ${marks}/hold-enabled ]; then : > ${marks}/hold-reached; while [ ! -f ${marks}/release ]; do sleep 0.05; done; fi\nexit 0\n`, { mode: 0o755 });

const P = { id: 'bp-0123456789ab', name: 'Staging admin', createdAt: 1 }, Q = { id: 'bp-fedcba987654', name: 'Prod', createdAt: 2 };
await store.setBrowserProfiles([P, Q]);
const wsRec = (id, over = {}) => {
  const wt = path.join(tmpHome, `wt-${id}`); git(repoDir, ['worktree', 'add', '-q', '-b', `b-${id}`, wt]);
  return { id, name: `repo · b-${id}`, repoPath: repoDir, worktreePath: wt, branch: `b-${id}`, baseBranch: 'main', createdAt: 1, status: 'idle', agent: 'claude', canOrchestrate: true, branchManuallySet: true, ...over };
};
// the REAL profile service (#400) over the real store: its serial chain + deleting() are what the spawn's decision reads (spawn-profile-gate.ts)
const gates = { settle: null, setProfiles: null, record: null }; // a held promise per effect: the harness decides when each resolves
const svc = profileSvcMod.createBrowserProfilesService({
  getProfiles: () => store.getBrowserProfiles(),
  setProfiles: async (next) => { if (gates.setProfiles) await gates.setProfiles; await store.setBrowserProfiles(next); },
  workspaces: () => store.workspaces,
  setWorkspaceProfile: async (id, pid) => { if (gates.record) await gates.record; const cur = store.getWorkspace(id); if (!cur) return; const u = { ...cur }; if (pid === undefined) delete u.browserProfileId; else u.browserProfileId = pid; await store.upsertWorkspace(u); },
  reprofilePanel: (wsId) => ({ wsId, url: '', title: '', loading: false, canGoBack: false, canGoForward: false, tabs: [], activeTabId: '' }),
  openPanelsOn: () => [],
  settleViews: async () => { if (gates.settle) await gates.settle; return true; },
  stopSignIns: () => {},
  clearEphemeral: async () => {},
  clearStorage: async () => {},
  mintId: () => 'bp-999999999999',
  now: () => 1,
});
gate.setDeletingProfilesProbe(() => svc.deleting());
const hold = () => { let release; const p = new Promise((r) => (release = r)); return { p, release }; };
const OPS = wsRec('ws-ops', { browserProfileId: P.id });
await store.upsertWorkspace(OPS);
await store.upsertWorkspace(wsRec('ws-bare'));
await store.upsertWorkspace(wsRec('ws-ops2', { browserProfileId: P.id })); // a second holder, for the arm that DELETES its parent (a deleted id is never resurrected, #205)
const KEY = 'key-ops-live-0001', KEY_BARE = 'key-bare-live-0002';
identity.registerSessionKey('ws-ops', KEY);
identity.registerSessionKey('ws-bare', KEY_BARE);
const KEY2 = 'key-ops2-live-0003'; identity.registerSessionKey('ws-ops2', KEY2);
const holdsP = () => store.getWorkspace('ws-ops')?.browserProfileId;
const reset = async () => { await store.setBrowserProfiles([P, Q]); await store.upsertWorkspace({ ...OPS, browserProfileId: P.id }); identity.registerSessionKey('ws-ops', KEY); };
let n = 0;
const spawnAs = (over) => workspaces.dispatchAgentSpawnRequest({ from: 'ws-ops', key: KEY, task: 'do the thing', agent: 'claude', name: `impl-h-${++n}`, ...over });
const profileOf = (res) => (res?.id ? store.getWorkspace(res.id)?.browserProfileId : undefined);

console.log('\nh — the host decision on the REAL dispatch:');
{
  const r = await spawnAs({ profile: 'Staging admin' });
  check('h1 honoured: ok, report applied, the NEW record carries the held profile', r.ok === true && r.profile?.applied === true && profileOf(r) === P.id, JSON.stringify(r).slice(0, 220));
}
{
  const r = await spawnAs({ profile: 'Prod' });
  check('h2 a profile the parent does not hold: worker created, report refused, record WITHOUT a profile', r.ok === true && r.profile?.applied === false && /you hold “Staging admin”/.test(r.profile.message) && profileOf(r) === undefined, JSON.stringify(r).slice(0, 220));
  check('h2b the refusal does not name the unheld profile', !!r.profile?.message && !r.profile.message.includes(Q.id) && !r.profile.message.includes('Prod”'), r.profile?.message);
}
{
  const r = await spawnAs({ profile: P.id, detached: true });
  check('h3 --detached: worker created parentless, refused, no profile', r.ok === true && r.profile?.applied === false && /--detached worker has no parent/.test(r.profile.message) && profileOf(r) === undefined && store.getWorkspace(r.id)?.parentId === undefined, JSON.stringify(r).slice(0, 220));
}
{
  const noKey = await spawnAs({ profile: P.id, key: undefined });
  const wrong = await spawnAs({ profile: P.id, key: KEY_BARE });
  const empty = await spawnAs({ profile: P.id, key: '' });
  const noFrom = await workspaces.dispatchAgentSpawnRequest({ repoPath: repoDir, key: KEY, task: 'x', agent: 'claude', name: `impl-h-${++n}`, profile: P.id });
  const all = [noKey, wrong, empty, noFrom];
  check('h4 unvouched (no key · another session\'s key · empty key · no `from`): every worker created, every pass refused, none carries a profile', all.every((r) => r.ok === true && r.profile?.applied === false && profileOf(r) === undefined), all.map((r) => r.profile?.message?.slice(0, 40)).join(' | '));
}
{
  const r = await spawnAs({});
  check('h5 no --profile: no report at all, ephemeral — even though the parent holds a profile', r.ok === true && !('profile' in r) && profileOf(r) === undefined, JSON.stringify(r).slice(0, 200));
}

console.log('\nt — the M1 window: the child is created slowly, the parent changes meanwhile:');
async function held(change, over = {}) {
  fs.rmSync(path.join(marks, 'release'), { force: true }); fs.rmSync(path.join(marks, 'hold-reached'), { force: true });
  fs.writeFileSync(path.join(marks, 'hold-enabled'), '');
  const p = spawnAs({ profile: P.id, ...over });
  try {
    await until(() => fs.existsSync(path.join(marks, 'hold-reached')), 30000, 'the spawn to be HELD inside git worktree add');
    await change(); // the human acts while the worktree is being added
  } finally { fs.writeFileSync(path.join(marks, 'release'), ''); fs.rmSync(path.join(marks, 'hold-enabled'), { force: true }); }
  return p;
}
{
  await reset();
  const r = await held(async () => {});
  check('t1 CONTROL — nothing changes during the hold: honoured (the instrument can say yes; the spawn really was held)', r.ok === true && r.profile?.applied === true && profileOf(r) === P.id, JSON.stringify(r).slice(0, 200));
}
{
  await reset();
  const r = await held(async () => { await store.upsertWorkspace({ ...store.getWorkspace('ws-ops'), browserProfileId: undefined }); });
  check('t2 the parent is DETACHED from its profile during creation → the child is ephemeral and the report says so', r.ok === true && r.profile?.applied === false && /you hold no profil navigateur/.test(r.profile.message) && profileOf(r) === undefined, JSON.stringify(r).slice(0, 220));
}
{
  await reset();
  const r = await held(async () => { await store.setBrowserProfiles([Q]); });
  check('t3 the profile is DELETED during creation → no dangling id on the child', r.ok === true && r.profile?.applied === false && profileOf(r) === undefined, JSON.stringify(r).slice(0, 220));
}
{
  await reset();
  const r = await held(async () => { await store.upsertWorkspace({ ...store.getWorkspace('ws-ops'), browserProfileId: Q.id }); });
  check('t4 the parent is SWITCHED to another profile during creation → the child does not get the one it asked for', r.ok === true && r.profile?.applied === false && /you hold “Prod”/.test(r.profile.message) && profileOf(r) === undefined, JSON.stringify(r).slice(0, 220));
}
{
  await reset();
  const r = await held(async () => { identity.registerSessionKey('ws-ops', 'key-ops-replacement'); });
  check('t5 the parent\'s session is SUPERSEDED during creation → refused (unvouched), child ephemeral', r.ok === true && r.profile?.applied === false && /could not vouch/.test(r.profile.message) && profileOf(r) === undefined, JSON.stringify(r).slice(0, 220));
}
{
  await reset();
  const r = await held(async () => { await store.removeWorkspace('ws-ops2'); }, { from: 'ws-ops2', key: KEY2 });
  // the parent is gone: the child is created (parentless, as before #401) and carries nothing
  check('t6 the parent is DELETED during creation → no caller: child ephemeral, still created', r.ok === true && r.profile?.applied === false && profileOf(r) === undefined, JSON.stringify(r).slice(0, 220));
}

console.log('\nd — a profile delete (#400 service) vs the spawn:');
{
  // d1 — the delete is RUNNING and is still inside its detach loop (the parent's record is not cleared yet): the flag is what refuses, the parent still holds the profile
  await reset();
  const rec = hold(); gates.record = rec.p; const settle = hold(); gates.settle = settle.p;
  let del, flagUp = true;
  const r = await held(async () => { del = svc.remove(P.id); await until(() => svc.deleting().includes(P.id), 3000, 'the delete to be RUNNING').catch(() => { flagUp = false; }); });
  check('d1 a delete is RUNNING (parent not yet detached) at the record build → refused "deleting", the child is created ephemeral', flagUp && r.ok === true && r.profile?.applied === false && /being deleted/.test(r.profile.message) && profileOf(r) === undefined && store.getWorkspace('ws-ops')?.browserProfileId === P.id, JSON.stringify(r).slice(0, 240));
  rec.release(); gates.record = null; settle.release(); gates.settle = null; const dr = await del;
  check('d1b control: that delete then completed — profile gone, the parent detached', dr.ok === true && store.getBrowserProfiles().every((p) => p.id !== P.id) && store.getWorkspace('ws-ops')?.browserProfileId === undefined, JSON.stringify(dr).slice(0, 120));
}
{
  // d1c — later in the same delete (the parent already detached, profile still listed, flag still up): the parent holds nothing, so the pass is refused anyway
  await reset();
  const settle = hold(); gates.settle = settle.p;
  let del, flagUp = true;
  const r = await held(async () => { del = svc.remove(P.id); await until(() => svc.deleting().includes(P.id) && store.getWorkspace('ws-ops')?.browserProfileId === undefined, 3000, 'the delete held in settleViews with the parent detached').catch(() => { flagUp = false; }); });
  check('d1c later in the delete (parent detached, profile still listed): refused, child ephemeral', flagUp && r.ok === true && r.profile?.applied === false && profileOf(r) === undefined, JSON.stringify(r).slice(0, 200));
  settle.release(); gates.settle = null; await del;
}
{
  await reset();
  const blockWrite = hold(); gates.setProfiles = blockWrite.p;
  let ren, del;
  const r = await held(async () => {
    ren = svc.rename(Q.id, 'Prod renamed'); // an unrelated op holds the serial chain (its profile-list write is blocked)
    await sleep(100);
    del = svc.remove(P.id); // QUEUED behind it: not started, so no flag yet
    await sleep(50);
  });
  check('d2 the delete is QUEUED (not started) at the record build → honoured: the flag is only up while a delete RUNS', r.ok === true && r.profile?.applied === true && profileOf(r) === P.id && svc.deleting().length === 0, JSON.stringify(r).slice(0, 200));
  blockWrite.release(); gates.setProfiles = null;
  await ren; const dr = await del;
  check('d2b …and then the delete\'s carrier scan finds the child and DETACHES it: no child carries a deleted profile', dr.ok === true && store.getBrowserProfiles().every((p) => p.id !== P.id) && profileOf(r) === undefined && store.getWorkspace('ws-ops')?.browserProfileId === undefined, `child record browserProfileId ${profileOf(r)}; profiles ${store.getBrowserProfiles().map((p) => p.name).join(',')}`);
}

console.log('\nw — whoami (M2):');
{
  await reset();
  const mine = workspaces.dispatchWhoamiRequest({ id: 'ws-ops', key: KEY });
  check('w1 the vouched live session sees what it holds', mine.ok && mine.browserProfile?.id === P.id && mine.browserProfile?.name === P.name, JSON.stringify(mine));
  const noKey = workspaces.dispatchWhoamiRequest({ id: 'ws-ops' });
  const wrong = workspaces.dispatchWhoamiRequest({ id: 'ws-ops', key: KEY_BARE });
  const other = workspaces.dispatchWhoamiRequest({ id: 'ws-ops', key: 'key-guess' });
  check('w2 no key · another session\'s key · a guessed key: the row is OMITTED (not null), the rest of the record still answers', [noKey, wrong, other].every((r) => r.ok && !('browserProfile' in r) && r.branch === 'b-ws-ops'), [noKey, wrong, other].map((r) => JSON.stringify(r.browserProfile)).join(' | '));
  const bareSelf = workspaces.dispatchWhoamiRequest({ id: 'ws-bare', key: KEY_BARE });
  check('w3 a vouched session that holds nothing reads null (ephemeral), a session of another workspace reads nothing of ws-ops', bareSelf.ok && bareSelf.browserProfile === null, JSON.stringify(bareSelf.browserProfile));
  await store.upsertWorkspace({ ...store.getWorkspace('ws-ops'), browserProfileId: 'bp-aaaaaaaaaaaa' });
  const dangling = workspaces.dispatchWhoamiRequest({ id: 'ws-ops', key: KEY });
  check('w4 a dangling recorded id reads null, never the id', dangling.ok && dangling.browserProfile === null, JSON.stringify(dangling.browserProfile));
}

console.log(`\n${total - failures}/${total} clauses PASS${failures ? ` — ${failures} FAILED` : ''}`);
process.exit(failures ? 1 : 0);
