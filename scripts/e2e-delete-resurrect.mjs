// #205 (A3) — a DELETED workspace must never be re-inserted by a stale read-modify-write.
// Drives the REAL store + REAL callers (clearBusRunStale, syncWorkspaceGateCounts, sweepHibernation,
// persistWorkspacePatch via sdkSetModel) — one arm per process (module state is global).
//
// Arms (ok:true = the shipped behaviour; on unfixed master the ★ arms print ok:false):
//   store_stale_upsert ★ remove A, then upsert a pre-remove copy → A must stay absent (memory AND disk)
//   bulk_remove        ★ same through removeWorkspaces (bulk delete path)
//   stale_marker       ★ real clearBusRunStale: get → await rm → upsert(stale); delete lands mid-await
//   gate_counts        ★ real syncWorkspaceGateCounts loop: delete lands between two awaited upserts
//   sweep_serial       ★ real sweepHibernation must not stop/stamp a workspace whose delete has begun
//   sweep_delete_begins_midstop ★ delete's teardown begins DURING the sweep's stop → no hibernatedAt stamp
//   real_delete_vs_sweep ★ REAL deleteWorkspace + a concurrent REAL sweepHibernation → no stop (pins teardown's forgetHibernationActivity)
//   stale_during_save  ★ a stale upsert issued WHILE removeWorkspace(s)'s save is awaited → tombstone must already be set
//   wake_stale         ★ real wakeAgentWithPrompt: get → await sdkStartAndDeliver → upsert(stale); delete mid-start
//   fresh_insert         must-PASS: a never-removed id still inserts (memory + disk) and updates in place
//   spawn_insert         must-PASS: the real createScratchWorkspace insert still lands
//   patch_control        persistWorkspacePatch (sdkSetModel) is NOT a racer: get→upsert has no await
//   sweep_delete_midstop hibernation's own post-stop write is guarded (fresh-record re-read)
//
// Run: node --experimental-strip-types --import ./scripts/.r2-register.mjs scripts/e2e-delete-resurrect.mjs <arm>

import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ARM = process.argv[2] ?? 'store_stale_upsert';
const ARMS = [
  'store_stale_upsert', 'bulk_remove', 'stale_marker', 'gate_counts', 'sweep_serial',
  'sweep_delete_begins_midstop', 'wake_stale', 'real_delete_vs_sweep', 'stale_during_save',
  'fresh_insert', 'spawn_insert', 'patch_control', 'sweep_delete_midstop',
];
if (!ARMS.includes(ARM)) { console.error(`unknown arm: ${ARM}`); process.exit(2); }

delete process.env.ORCHESTRA_HIBERNATE_AFTER_MS;
delete process.env.ORCHESTRA_HIBERNATE_SWEEP_MS;

// Under the real home (btrfs), NOT /tmp: the fs is part of the instrument.
const tmpHome = path.join(process.env.E2E_HOME ?? path.join(os.homedir(), '.cache', 'e2e-delete-resurrect'), ARM);
fs.rmSync(tmpHome, { recursive: true, force: true });
fs.mkdirSync(path.join(tmpHome, '.orchestra'), { recursive: true });
process.env.ORCHESTRA_HOME = path.join(tmpHome, '.orchestra');
process.env.HOME = tmpHome;

const realNow = Date.now.bind(Date);
let skewMs = 0;
Date.now = () => realNow() + skewMs;
const MIN = 60_000;

const { initPlatform } = await import(`${REPO}/src/main/platform/index.ts`);
const broadcasts = [];
initPlatform({
  kind: 'headless-e2e-delete-resurrect',
  broadcast: (channel, ...args) => { broadcasts.push({ channel, args }); },
  broadcastPtyData: () => true, canBroadcast: () => true,
  isFocused: () => false, hasAttachedUi: () => false, notify: () => {},
  openExternal: () => {}, showItemInFolder: () => {}, openPath: () => {},
  openAccountLoginUrl: () => {}, closeAccountLogin: () => {},
  getUserDataDir: () => tmpHome, getLogsDir: () => `${tmpHome}/logs`,
  getAppVersion: () => '0.0.0-e2e-delete-resurrect', getAppMetrics: () => [],
  isEncryptionAvailable: () => false, encryptString: (s) => s, decryptString: (s) => s,
});

const { store } = await import(`${REPO}/src/main/store.ts`);
await store.load?.();

const STORE_JSON = path.join(tmpHome, 'orchestra', 'store.json');
const onDisk = (id) => {
  const j = JSON.parse(fs.readFileSync(STORE_JSON, 'utf8'));
  return (j.workspaces ?? []).some((w) => w.id === id);
};
const mk = (id, extra = {}) => ({
  id, name: id, kind: 'scratch', repoPath: '', branch: id,
  worktreePath: path.join(tmpHome, 'wt', id), status: 'idle', createdAt: realNow(), hasInput: false,
  ...extra,
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const has = (id) => store.getWorkspace(id) !== undefined;

const out = { arm: ARM };
let ok = false;

if (ARM === 'store_stale_upsert') {
  await store.upsertWorkspace(mk('A'));
  const stale = { ...store.getWorkspace('A') };            // the pre-await capture
  await store.removeWorkspace('A');
  const preAbsent = !has('A') && !onDisk('A');             // positive control: the delete itself worked
  await store.upsertWorkspace({ ...stale, name: 'ghost' });
  Object.assign(out, { preAbsent, presentAfter: has('A'), onDiskAfter: onDisk('A'), count: store.workspaces.length });
  ok = preAbsent && !has('A') && !onDisk('A');
} else if (ARM === 'bulk_remove') {
  await store.upsertWorkspace(mk('A'));
  await store.upsertWorkspace(mk('B'));
  const stale = { A: { ...store.getWorkspace('A') }, B: { ...store.getWorkspace('B') } };
  await store.removeWorkspaces(['A', 'B']);
  const preAbsent = !has('A') && !has('B');
  await store.upsertWorkspace({ ...stale.A, name: 'ghost' });
  await store.upsertWorkspace({ ...stale.B, name: 'ghost' });
  Object.assign(out, { preAbsent, presentA: has('A'), presentB: has('B'), onDiskA: onDisk('A'), onDiskB: onDisk('B') });
  ok = preAbsent && !has('A') && !has('B') && !onDisk('A') && !onDisk('B');
} else if (ARM === 'stale_marker') {
  const ws = mk('A', { busRunStale: true });
  fs.mkdirSync(ws.worktreePath, { recursive: true });
  await store.upsertWorkspace(ws);
  const { clearBusRunStale } = await import(`${REPO}/src/main/workspaces.ts`);
  const p = clearBusRunStale('A');                         // get → (await rm) → upsert(stale)
  const r = store.removeWorkspace('A');                    // delete lands mid-await
  await Promise.all([p, r]);
  Object.assign(out, { presentAfter: has('A'), onDiskAfter: onDisk('A') });
  ok = !has('A') && !onDisk('A');
} else if (ARM === 'gate_counts') {
  for (const id of ['A', 'B', 'C']) await store.upsertWorkspace(mk(id));
  const { syncWorkspaceGateCounts } = await import(`${REPO}/src/main/human-gates.ts`);
  const gates = ['A', 'B', 'C'].map((id) => ({ askedByWorkspaceId: id }));
  const p = syncWorkspaceGateCounts(gates);                // loop suspends inside A's awaited upsert
  const r = store.removeWorkspace('B');                    // B deleted; the loop still holds the old array
  await Promise.all([p, r]);
  Object.assign(out, {
    presentA: has('A'), presentB: has('B'), presentC: has('C'), onDiskB: onDisk('B'),
    countA: store.getWorkspace('A')?.openHumanGateCount, countC: store.getWorkspace('C')?.openHumanGateCount,
  });
  // A and C must still be updated (the fix must not stop the loop); B must stay gone.
  ok = !has('B') && !onDisk('B') && out.countA === 1 && out.countC === 1;
} else if (ARM === 'wake_stale') {
  const delivery = await import(`${REPO}/src/main/sdk-delivery.ts`);
  let release = () => {}; let startEntered = () => {};
  const entered = new Promise((r) => { startEntered = r; });
  const gate = new Promise((r) => { release = r; });
  const { wakeAgentWithPrompt } = await import(`${REPO}/src/main/workspaces.ts`);  // may load agent-sdk → register AFTER
  delivery.registerSdkDelivery({
    hasSession: () => false, hasBackgroundTask: () => false,
    send: async () => {}, sendAwaitingStart: async () => 'started', stop: async () => {},
    start: async () => { startEntered(); await gate; },   // a slow session start (init hang)
  });
  await store.upsertWorkspace(mk('A', { hasInput: false }));
  const p = wakeAgentWithPrompt('A', 'wake up');           // captures ws, then awaits the start
  await entered;
  await store.removeWorkspace('A');                        // the delete lands during the start
  release();
  const woke = await p;
  await sleep(50);
  Object.assign(out, { woke, presentAfter: has('A'), onDiskAfter: onDisk('A') });
  ok = woke === true && !has('A') && !onDisk('A');
} else if (ARM === 'stale_during_save') {
  // No timers: the stale upsert is issued between the sync part of the removal and its awaited save.
  await store.upsertWorkspace(mk('A')); await store.upsertWorkspace(mk('B'));
  const staleA = { ...store.getWorkspace('A') }; const staleB = { ...store.getWorkspace('B') };
  const pb = store.removeWorkspaces(['A']);
  const bulkSyncRan = !has('A');                           // control: the removal's sync part already ran
  await store.upsertWorkspace({ ...staleA, name: 'ghost' });
  await pb;
  const bulk = { bulkSyncRan, presentAfter: has('A'), onDisk: onDisk('A') };
  const ps = store.removeWorkspace('B');
  const singleSyncRan = !has('B');
  await store.upsertWorkspace({ ...staleB, name: 'ghost' });
  await ps;
  const single = { singleSyncRan, presentAfter: has('B'), onDisk: onDisk('B') };
  Object.assign(out, { bulk, single });
  ok = bulkSyncRan && singleSyncRan && !bulk.presentAfter && !bulk.onDisk && !single.presentAfter && !single.onDisk;
} else if (ARM === 'real_delete_vs_sweep') {
  const { createScratchWorkspace, deleteWorkspace } = await import(`${REPO}/src/main/workspaces.ts`);
  const delivery = await import(`${REPO}/src/main/sdk-delivery.ts`);   // register AFTER workspaces.ts (may load agent-sdk)
  const hib = await import(`${REPO}/src/main/hibernation.ts`);
  const act = await import(`${REPO}/src/main/hibernation-activity.ts`);
  const stops = [];
  delivery.registerSdkDelivery({
    hasSession: () => true, hasBackgroundTask: () => false,
    send: async () => {}, sendAwaitingStart: async () => 'started', start: async () => {},
    stop: async (id, opts) => { if (opts?.hibernate) stops.push(id); },   // only the SWEEP's stop: the delete's own stop (#201) is legit
  });
  const ws = await createScratchWorkspace();
  const pre = { present: has(ws.id), dirExists: fs.existsSync(ws.worktreePath) };
  act.noteActivity(ws.id);
  skewMs = 6 * MIN;                                        // idle past the 5-min default
  const d = deleteWorkspace(ws.id);                        // REAL teardown: its sync head runs, then it yields
  const swept = await hib.sweepHibernation();              // the sweep tick lands mid-teardown
  await d;
  Object.assign(out, { pre, stops, swept, presentAfter: has(ws.id), onDiskAfter: onDisk(ws.id), dirGone: !fs.existsSync(ws.worktreePath) });
  ok = pre.present && pre.dirExists && stops.length === 0 && swept.length === 0 && !has(ws.id) && !onDisk(ws.id) && out.dirGone;
} else if (ARM === 'fresh_insert') {
  await store.upsertWorkspace(mk('A'));
  await store.removeWorkspace('A');                        // a tombstone for A must not affect B
  await store.upsertWorkspace(mk('B'));
  const insertedMem = has('B'); const insertedDisk = onDisk('B');
  await store.upsertWorkspace({ ...store.getWorkspace('B'), name: 'renamed' });
  const updated = store.getWorkspace('B')?.name === 'renamed';
  const n = store.workspaces.filter((w) => w.id === 'B').length;
  Object.assign(out, { insertedMem, insertedDisk, updated, copies: n, aStillGone: !has('A') });
  ok = insertedMem && insertedDisk && updated && n === 1 && !has('A');
} else if (ARM === 'spawn_insert') {
  const { createScratchWorkspace } = await import(`${REPO}/src/main/workspaces.ts`);
  const ws = await createScratchWorkspace();
  Object.assign(out, { id: ws.id, presentAfter: has(ws.id), onDiskAfter: onDisk(ws.id) });
  ok = !!ws.id && has(ws.id) && onDisk(ws.id);
} else if (ARM === 'patch_control') {
  const sdk = await import(`${REPO}/src/main/agent-sdk.ts`);
  await store.upsertWorkspace(mk('A'));
  await sdk.sdkSetModel('A', 'model-live');                // positive control: the patch path really writes
  const patched = store.getWorkspace('A')?.model === 'model-live';
  const p1 = sdk.sdkSetModel('A', 'model-mid');            // patch starts, delete lands right behind it
  const r1 = store.removeWorkspace('A');
  await Promise.all([p1, r1]);
  const afterMid = has('A');
  await sdk.sdkSetModel('A', 'model-late');                // patch after the delete
  const afterLate = has('A');
  Object.assign(out, { patched, afterMid, afterLate, onDisk: onDisk('A') });
  ok = patched && !afterMid && !afterLate && !onDisk('A');
} else {
  // sweep_serial / sweep_delete_midstop — the REAL sweeper over a fake structured-session seam.
  const delivery = await import(`${REPO}/src/main/sdk-delivery.ts`);
  const hib = await import(`${REPO}/src/main/hibernation.ts`);
  const act = await import(`${REPO}/src/main/hibernation-activity.ts`);
  const stops = [];
  let release = () => {}; let stopStarted = () => {};
  const started = new Promise((r) => { stopStarted = r; });
  const gate = new Promise((r) => { release = r; });
  let hold = false;
  delivery.registerSdkDelivery({
    hasSession: () => true, hasBackgroundTask: () => false,
    send: async () => {}, sendAwaitingStart: async () => 'started', start: async () => {},
    stop: async (id) => { stops.push(id); stopStarted(); if (hold) await gate; },
  });
  await store.upsertWorkspace(mk('A'));
  act.noteActivity('A');
  skewMs = 6 * MIN;                                        // past the 5-min default
  if (ARM === 'sweep_delete_begins_midstop') {
    hold = true;
    const sweep = hib.sweepHibernation();                  // eligible: delete has NOT begun yet → stop starts
    await started;
    act.forgetHibernationActivity('A');                    // delete's teardown begins mid-stop (record still present)
    release();
    const hibernated = await sweep;
    Object.assign(out, { stops, hibernated, hibernatedAt: store.getWorkspace('A')?.hibernatedAt ?? null, present: has('A') });
    ok = stops.length === 1 && hibernated.length === 0 && store.getWorkspace('A')?.hibernatedAt == null && has('A');
  } else if (ARM === 'sweep_serial') {
    // delete's teardown has begun (forgetHibernationActivity is its first act), record still present
    act.forgetHibernationActivity('A');
    const hibernated = await hib.sweepHibernation();
    Object.assign(out, { stops, hibernated, hibernatedAt: store.getWorkspace('A')?.hibernatedAt ?? null });
    ok = stops.length === 0 && hibernated.length === 0 && store.getWorkspace('A')?.hibernatedAt == null;
  } else {
    // positive control: WITHOUT a delete the sweeper does hibernate this record (the rig can hibernate)
    const control = await hib.sweepHibernation();
    const controlStamped = store.getWorkspace('A')?.hibernatedAt != null;
    stops.length = 0;
    await store.upsertWorkspace({ ...store.getWorkspace('A'), hibernatedAt: undefined });
    hold = true;
    const sweep = hib.sweepHibernation();                  // suspends inside the (held) stop
    await started;
    await store.removeWorkspace('A');                      // the delete lands during the stop
    release();
    const hibernated = await sweep;
    await sleep(50);
    Object.assign(out, { control, controlStamped, stops, hibernated, presentAfter: has('A'), onDiskAfter: onDisk('A') });
    ok = control.length === 1 && controlStamped && stops.length === 1 && !has('A') && !onDisk('A');
  }
}

out.ok = ok;
console.log(JSON.stringify(out));
process.exit(0);
