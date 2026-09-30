#!/usr/bin/env node
// C2 #209 — cost of ONE resource-monitor tick's /proc walks (src/main/resource-monitor.ts, every 60 s, always on): sampleProcTable()
// (read /proc/<pid>/stat for EVERY pid) + scanKeeperProcs() (read /proc/<pid>/cmdline for EVERY pid), on THIS host's live process table.
// Read-only: only the two /proc-walk deps are called — never sampleTick (its reaper can signal processes).
//   bash scripts/hidden-cost/proc-table-cost.sh   (scratch HOME/ORCHESTRA_HOME via the wrapper)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertScratch } from '../session-budget/scratch-guard.mjs';
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const live = JSON.parse(process.argv[process.argv.indexOf('--live') + 1] ?? 'null');
const ROOT = process.env.HC_ROOT;
if (!ROOT || !Array.isArray(live)) { console.error('run via scripts/hidden-cost/proc-table-cost.sh'); process.exit(90); }
const home = path.join(ROOT, 'home'), orch = path.join(ROOT, 'orchestra');
for (const [l, p] of [['HOME', home], ['ORCHESTRA_HOME', orch]]) assertScratch(l, p, ROOT, live);
fs.mkdirSync(home, { recursive: true }); fs.mkdirSync(orch, { recursive: true });
Object.assign(process.env, { HOME: home, ORCHESTRA_HOME: orch });
const { initPlatform } = await import(`${REPO}/src/main/platform/index.ts`);
initPlatform({ kind: 'headless-proc-table', broadcast: () => {}, broadcastPtyData: () => {}, canBroadcast: () => true, isFocused: () => false, hasAttachedUi: () => false,
  notify: () => {}, openExternal: () => {}, showItemInFolder: () => {}, openPath: () => {}, openAccountLoginUrl: () => {}, closeAccountLogin: () => {},
  getUserDataDir: () => orch, getLogsDir: () => `${orch}/logs`, getAppVersion: () => '0.0.0', getAppMetrics: () => [],
  isEncryptionAvailable: () => false, encryptString: (s) => s, decryptString: (s) => s });
const { realResourceMonitorDeps } = await import(`${REPO}/src/main/resource-monitor.ts`);
const d = realResourceMonitorDeps();
const pids = fs.readdirSync('/proc').filter((n) => /^\d+$/.test(n)).length;
const time = async (fn, runs = 20) => { const w = [], c = []; for (let i = 0; i < runs + 2; i++) { const c0 = process.cpuUsage(); const t0 = process.hrtime.bigint(); await fn(); const wall = Number(process.hrtime.bigint() - t0) / 1e6; const cu = process.cpuUsage(c0); if (i >= 2) { w.push(wall); c.push((cu.user + cu.system) / 1000); } } const med = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)]; return { wallMsMedian: Number(med(w).toFixed(1)), cpuMsMedian: Number(med(c).toFixed(1)) }; };
const table = await d.procTable();
const out = { generatedAt: new Date().toISOString(), loadavg: fs.readFileSync('/proc/loadavg', 'utf8').split(' ').slice(0, 3).join(' '), pidsInProc: pids, procTableRows: table.length,
  sampleProcTable: await time(() => d.procTable()), scanKeeperProcs: await time(() => d.keeperProcs()) };
console.log(JSON.stringify(out));
process.exit(0);
