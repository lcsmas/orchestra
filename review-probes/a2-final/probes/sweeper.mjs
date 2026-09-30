// P2 sweeper: loops the REAL sweepStaleKeeperFiles (tip) on one ws until told to stop.
import fs from 'node:fs'; import os from 'node:os';
const REPO = '/home/lmas/a2f-tip', HOME = process.env.HOME; if (!HOME.startsWith('/home/lmas/rf')) throw new Error('scratch guard');
const home = `${HOME}/p2home`; fs.mkdirSync(`${home}/keepers`, { recursive: true }); process.env.ORCHESTRA_HOME = home;
const { initPlatform } = await import(`${REPO}/src/main/platform/index.ts`);
initPlatform({ kind: 'p2', broadcast: () => {}, broadcastPtyData: () => {}, canBroadcast: () => true, isFocused: () => false, hasAttachedUi: () => false, notify: () => {}, openExternal: () => {}, showItemInFolder: () => {}, openPath: () => {}, openAccountLoginUrl: () => {}, closeAccountLogin: () => {}, getUserDataDir: () => home, getLogsDir: () => `${home}/logs`, getAppVersion: () => '0', getAppMetrics: () => [], isEncryptionAvailable: () => false, encryptString: (s) => s, decryptString: (s) => s });
(await import(`${REPO}/src/main/logger.ts`)).initLogger();
const kc = await import(`${REPO}/src/main/keeper-client.ts`);
const stop = `${home}/STOP`; let n = 0;
fs.writeFileSync(`${home}/READY`, String(process.pid));
while (!fs.existsSync(stop)) { await kc.sweepStaleKeeperFiles('ws-p2'); n++; }
fs.writeFileSync(`${home}/sweeps`, String(n)); process.exit(0);
