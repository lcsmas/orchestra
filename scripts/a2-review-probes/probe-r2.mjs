// Reviewer probe: fake /proc world through the REAL reapKeepersNow. Tracked keeper T is dead-and-recycled by a
// non-keeper at kill time; D is the only real keeper of a LIVE workspace. Clean tree must signal NOTHING.
import fs from 'node:fs';
import path from 'node:path';
const REPO = path.resolve(process.env.SUBJECT_REPO ?? '/home/lmas/a2r-probe');
const base = '/home/lmas/a2r-attack/arms/r2';
fs.rmSync(base, { recursive: true, force: true });
const home = path.join(base, 'home');
fs.mkdirSync(home, { recursive: true });
process.env.ORCHESTRA_HOME = home; process.env.HOME = home;
const { initPlatform } = await import(`${REPO}/src/main/platform/index.ts`);
initPlatform({
  kind: 'headless-reviewer-probe', broadcast: () => {}, broadcastPtyData: () => {}, canBroadcast: () => true,
  isFocused: () => false, hasAttachedUi: () => false, notify: () => {}, openExternal: () => {}, showItemInFolder: () => {},
  openPath: () => {}, openAccountLoginUrl: () => {}, closeAccountLogin: () => {},
  getUserDataDir: () => home, getLogsDir: () => `${home}/logs`, getAppVersion: () => '0.0.0-probe', getAppMetrics: () => [],
  isEncryptionAvailable: () => false, encryptString: (s) => s, decryptString: (s) => s,
});
(await import(`${REPO}/src/main/logger.ts`)).initLogger();
const M = await import(`${REPO}/src/main/resource-monitor.ts`);
const WS = 'ws-fake', T = 4001, D = 4002, C = 4003;
const proc = (pid, ppid, comm, st) => ({ pid, ppid, comm, cpuTicks: 0, cpuPct: 0, memBytes: 1, startTicks: st });
const table = [proc(T, 1, 'node', 100), proc(D, 1, 'node', 200), proc(C, D, 'claude', 210)];
const keeperArgv = ['/usr/bin/node', `${home}/bin/keeper.js`, WS, 's', path.join(home, 'keepers', `${WS}.pid`), 'l'];
async function run(over) {
  const sent = [];
  await M.reapKeepersNow({
    now: () => 0, procTable: async () => table, keeperRoots: () => [{ workspaceId: WS, keeperPid: T }],
    keeperProcs: () => [{ pid: T, workspaceId: WS }, { pid: D, workspaceId: WS }],
    trackedKeeperPid: () => T, liveWorkspaceIds: () => new Set([WS]), storeLoadedFromDisk: () => true, statusFor: () => 'idle',
    electronProcs: () => [], cpuCores: () => 1, memTotalBytes: () => 1, memUsedBytes: () => 1, appendLine: () => {},
    readProcStat: (pid) => table.find((p) => p.pid === pid) ?? null,
    readCmdline: (pid) => (pid === D ? keeperArgv : pid === T ? keeperArgv : ['/bin/sleep', '1']),
    signal: (pid, sig) => { sent.push(`${sig}:${pid}`); return true; }, sleep: async () => {}, warn: () => {}, info: () => {}, ...over,
  });
  return sent;
}
const control = await run({});                                                    // T & D are both keepers → D (dup) + its CLI are signalled
const trackedRecycled = await run({ readCmdline: (pid) => (pid === D ? keeperArgv : ['/bin/sleep', '1']) }); // T's pid now a non-keeper; D = the ONLY keeper left
console.log(JSON.stringify({ control, trackedRecycled_signals: trackedRecycled, soleKeeperD_signalled: trackedRecycled.some((s) => s.endsWith(`:${D}`)) }));
process.exit(0);
