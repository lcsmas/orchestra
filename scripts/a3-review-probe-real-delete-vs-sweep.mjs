// REVIEWER probe (not part of the candidate): REAL deleteWorkspace racing REAL sweepHibernation.
import path from 'node:path'; import fs from 'node:fs'; import os from 'node:os';
import { fileURLToPath } from 'node:url';
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
delete process.env.ORCHESTRA_HIBERNATE_AFTER_MS; delete process.env.ORCHESTRA_HIBERNATE_SWEEP_MS;
const tmpHome = path.join(os.homedir(), '.cache', 'a3-review-probe-home');
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
const { createScratchWorkspace, deleteWorkspace } = await import(`${REPO}/src/main/workspaces.ts`);
const delivery = await import(`${REPO}/src/main/sdk-delivery.ts`);
const hib = await import(`${REPO}/src/main/hibernation.ts`);
const act = await import(`${REPO}/src/main/hibernation-activity.ts`);
const stops = [];
delivery.registerSdkDelivery({ hasSession: () => true, hasBackgroundTask: () => false, send: async () => {}, sendAwaitingStart: async () => 'started', start: async () => {}, stop: async (id) => { stops.push(id); } });
const STORE_JSON = path.join(tmpHome, 'orchestra', 'store.json');
const onDisk = (id) => (JSON.parse(fs.readFileSync(STORE_JSON, 'utf8')).workspaces ?? []).some((w) => w.id === id);
const ws = await createScratchWorkspace();
const id = ws.id;
const pre = { present: !!store.getWorkspace(id), dirExists: fs.existsSync(ws.worktreePath) };
act.noteActivity(id);                 // a real, seen workspace
skewMs = 6 * 60_000;                  // idle past the 5-min threshold
const control = { eligibleWithoutDelete: true };
const d = deleteWorkspace(id);        // REAL teardown: sync part runs (forgetHibernationActivity, stopPty) then yields at clearInbox
const swept = await hib.sweepHibernation();   // the sweep tick lands mid-teardown
await d;
const out = { pre, stops, swept, presentAfter: !!store.getWorkspace(id), onDiskAfter: onDisk(id), dirGone: !fs.existsSync(ws.worktreePath),
  removedBroadcast: broadcasts.some((b) => b.c === 'workspace:removed' && b.a[0] === id) };
out.ok = pre.present && pre.dirExists && stops.length === 0 && swept.length === 0 && !out.presentAfter && !out.onDiskAfter && out.dirGone && out.removedBroadcast;
console.log(JSON.stringify(out)); process.exit(0);
