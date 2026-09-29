// REVIEWER probe (not part of the candidate): REAL deleteWorkspace racing REAL sweepHibernation.
import path from 'node:path'; import fs from 'node:fs'; import os from 'node:os';
import { fileURLToPath } from 'node:url';
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
delete process.env.ORCHESTRA_HIBERNATE_AFTER_MS; delete process.env.ORCHESTRA_HIBERNATE_SWEEP_MS;
const tmpHome = path.join(os.homedir(), '.cache', 'a3-review-probe2-home');
fs.rmSync(tmpHome, { recursive: true, force: true }); fs.mkdirSync(path.join(tmpHome, '.orchestra'), { recursive: true });
process.env.ORCHESTRA_HOME = path.join(tmpHome, '.orchestra'); process.env.HOME = tmpHome;
const realNow = Date.now.bind(Date); let skewMs = 0; Date.now = () => realNow() + skewMs;
const { initPlatform } = await import(`${REPO}/src/main/platform/index.ts`);
const broadcasts = [];
initPlatform({ kind: 'headless-a3-review', broadcast: (c, ...a) => { broadcasts.push({ c, a }); }, broadcastPtyData: () => true, canBroadcast: () => true,
  isFocused: () => false, hasAttachedUi: () => false, notify: () => {}, openExternal: () => {}, showItemInFolder: () => {}, openPath: () => {},
  openAccountLoginUrl: () => {}, closeAccountLogin: () => {}, getUserDataDir: () => tmpHome, getLogsDir: () => `${tmpHome}/logs`,
  getAppVersion: () => '0.0.0-a3', getAppMetrics: () => [], isEncryptionAvailable: () => false, encryptString: (s) => s, decryptString: (s) => s });
const { store } = await import(`${REPO}/src/main/store.ts`); await store.load?.();

const mk = (id) => ({ id, name: id, kind: 'scratch', repoPath: '', branch: id, worktreePath: path.join(tmpHome, 'wt', id), status: 'idle', createdAt: realNow(), hasInput: false });
const STORE_JSON = path.join(tmpHome, 'orchestra', 'store.json');
const onDisk = (id) => (JSON.parse(fs.readFileSync(STORE_JSON, 'utf8')).workspaces ?? []).some((w) => w.id === id);
const out = {};
// bulk: stale upsert lands DURING removeWorkspaces' save await (deterministic: no timers)
await store.upsertWorkspace(mk('A')); await store.upsertWorkspace(mk('B'));
const staleA = { ...store.getWorkspace('A') };
const pb = store.removeWorkspaces(['A']);
const midBulkBefore = !!store.getWorkspace('A');           // control: sync part of the removal already ran
await store.upsertWorkspace({ ...staleA, name: 'ghost' });
await pb;
out.bulk = { midBulkBefore, presentAfter: !!store.getWorkspace('A'), onDisk: onDisk('A') };
// single: same shape
const staleB = { ...store.getWorkspace('B') };
const ps = store.removeWorkspace('B');
await store.upsertWorkspace({ ...staleB, name: 'ghost' });
await ps;
out.single = { presentAfter: !!store.getWorkspace('B'), onDisk: onDisk('B') };
out.ok = !out.bulk.midBulkBefore && !out.bulk.presentAfter && !out.bulk.onDisk && !out.single.presentAfter && !out.single.onDisk;
console.log(JSON.stringify(out)); process.exit(0);
