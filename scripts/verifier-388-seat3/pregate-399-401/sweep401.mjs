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
await (await import(`${TREE}/scripts/neutral-memory-guard.mjs`)).neutralizeMemoryGuard(TREE);
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


// ───────────────── seat 3: RANDOMIZED delete-vs-spawn interleaving sweep (the member's d1/d2 are two fixed schedules) ─────────────────
const N = Number(process.env.SWEEP_N ?? 300);
let seed = Number(process.env.SWEEP_SEED ?? 12345); const rnd = () => { seed ^= seed << 13; seed >>>= 0; seed ^= seed >>> 17; seed ^= seed << 5; seed >>>= 0; return seed / 4294967296; };
const sleepMs = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));
const shuffle = (a) => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const classes = {}; const violations = [];
for (let trial = 0; trial < N; trial++) {
  await reset();
  gates.record = gates.setProfiles = gates.settle = null;
  const gs = { record: rnd() < 0.6 ? hold() : null, setProfiles: rnd() < 0.4 ? hold() : null, settle: rnd() < 0.6 ? hold() : null };
  gates.record = gs.record?.p ?? null; gates.setProfiles = gs.setProfiles?.p ?? null; gates.settle = gs.settle?.p ?? null;
  fs.rmSync(path.join(marks, 'release'), { force: true }); fs.rmSync(path.join(marks, 'hold-reached'), { force: true });
  fs.writeFileSync(path.join(marks, 'hold-enabled'), '');
  const sp = spawnAs({ profile: P.id });
  await until(() => fs.existsSync(path.join(marks, 'hold-reached')), 30000, 'the spawn to be held');
  const tDel = rnd() * 60, tRel = rnd() * 60; let del = null; const t0 = Date.now();
  const acts = [[tDel, () => { del = svc.remove(P.id); }], [tRel, () => { fs.writeFileSync(path.join(marks, 'release'), ''); fs.rmSync(path.join(marks, 'hold-enabled'), { force: true }); }]].sort((a, b) => a[0] - b[0]);
  for (const [t, fn] of acts) { await sleepMs(t - (Date.now() - t0)); fn(); }
  for (const g of shuffle(Object.values(gs).filter(Boolean))) { await sleepMs(rnd() * 40); g.release(); }
  const spRes = await sp; const delRes = del ? await del : null;
  gates.record = gates.setProfiles = gates.settle = null;
  const profiles = store.getBrowserProfiles(); const hasP = profiles.some((p) => p.id === P.id);
  const carriers = store.workspaces.filter((w) => w.browserProfileId === P.id).map((w) => w.id);
  const child = spRes?.id ? store.getWorkspace(spRes.id) : undefined;
  const msg = spRes?.profile?.message ?? '';
  const outcome = !spRes?.profile ? 'no-report' : spRes.profile.applied ? 'applied' : /being deleted/.test(msg) ? 'refused-deleting' : /you hold no profil/.test(msg) ? 'refused-holds-none' : 'refused-other';
  const key = `${outcome} | delete:${delRes ? (delRes.ok ? 'ok' : 'refused') : '-'} | profile:${hasP ? 'present' : 'gone'} | child:${child?.browserProfileId ? 'holds' : 'ephemeral'}`;
  classes[key] = (classes[key] ?? 0) + 1;
  if (!hasP && carriers.length) violations.push(`trial ${trial}: profile DELETED yet carried by ${carriers.join(',')} — ${key}`);
  if (child && child.browserProfileId !== undefined && child.browserProfileId !== P.id) violations.push(`trial ${trial}: child carries an unknown profile ${child.browserProfileId}`);
  if (outcome === 'refused-deleting' && child?.browserProfileId) violations.push(`trial ${trial}: refused but the child carries ${child.browserProfileId}`);
  if (spRes?.ok !== true) violations.push(`trial ${trial}: spawn not ok ${JSON.stringify(spRes).slice(0, 150)}`);
  if (child) await store.removeWorkspace(child.id);
}
console.log(`SWEEP ${process.env.SWEEP_LABEL ?? 'subject'}: ${N} trials, ${violations.length} violations`);
for (const [k, v] of Object.entries(classes).sort()) console.log(`  ${String(v).padStart(4)}  ${k}`);
for (const v of violations.slice(0, 5)) console.log('  VIOLATION', v);
process.exit(violations.length ? 1 : 0);
