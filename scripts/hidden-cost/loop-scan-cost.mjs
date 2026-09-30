#!/usr/bin/env node
// C2 #209 — cost of ONE firing of the 5-min loop-scan sweep (src/main/loop-scan.ts) at fleet scale: N workspaces whose
// transcripts CHANGED since the last sweep (an active fleet: mtime moves every turn), sizes bracketing the real distribution
// (field: median 2.4 MB, max 47 MB, cap 8 MB per read — src/shared/tail-read.ts TAIL_MAX_BYTES). Real `sweepLoopScan`, real
// store, scratch HOME/config dir (D7). Reports wall ms + process CPU ms per sweep, and bytes the sweep read.
//   bash scripts/hidden-cost/loop-scan-cost.sh [--ws 32] [--runs 5]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertScratch } from '../session-budget/scratch-guard.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const N = Number(opt('ws', '32'));
const RUNS = Number(opt('runs', '5'));
const live = JSON.parse(opt('live', 'null') ?? 'null');
const ROOT = process.env.HC_ROOT;
if (!ROOT || !Array.isArray(live) || !live.length) { console.error('run via scripts/hidden-cost/loop-scan-cost.sh'); process.exit(90); }
const home = path.join(ROOT, 'home'), orch = path.join(ROOT, 'orchestra'), cfg = path.join(home, '.claude');
for (const [l, p] of [['HOME', home], ['ORCHESTRA_HOME', orch], ['CLAUDE_CONFIG_DIR', cfg]]) assertScratch(l, p, ROOT, live);
fs.mkdirSync(cfg, { recursive: true }); fs.mkdirSync(orch, { recursive: true });
Object.assign(process.env, { HOME: home, ORCHESTRA_HOME: orch, CLAUDE_CONFIG_DIR: cfg });

const { initPlatform } = await import(`${REPO}/src/main/platform/index.ts`);
initPlatform({ kind: 'headless-loop-scan-cost', broadcast: () => {}, broadcastPtyData: () => {}, canBroadcast: () => true, isFocused: () => false, hasAttachedUi: () => false,
  notify: () => {}, openExternal: () => {}, showItemInFolder: () => {}, openPath: () => {}, openAccountLoginUrl: () => {}, closeAccountLogin: () => {},
  getUserDataDir: () => orch, getLogsDir: () => `${orch}/logs`, getAppVersion: () => '0.0.0-loop-scan-cost', getAppMetrics: () => [],
  isEncryptionAvailable: () => false, encryptString: (s) => s, decryptString: (s) => s });
const { store } = await import(`${REPO}/src/main/store.ts`);
const { sweepLoopScan } = await import(`${REPO}/src/main/loop-scan.ts`);
const { mangleProjectDir } = await import(`${REPO}/src/main/workspaces.ts`);
await store.load?.();

// A realistic-ish transcript line (~1.6 KB: assistant text + a tool_use + usage), none carrying "ScheduleWakeup" — the worst case for a
// backward scan (the needle is never found, so the read runs to the cap).
const line = (i) => JSON.stringify({ parentUuid: `u${i}`, isSidechain: false, type: 'assistant', uuid: `a${i}`, timestamp: new Date(1_790_000_000_000 + i * 1000).toISOString(),
  message: { id: `msg_${i}`, role: 'assistant', model: 'claude-opus-4-8', content: [{ type: 'text', text: 'x'.repeat(900) }, { type: 'tool_use', id: `toolu_${i}`, name: 'Bash', input: { command: 'pnpm run test '.repeat(8) } }], usage: { input_tokens: 10, cache_read_input_tokens: 50000, output_tokens: 200 } } });
const mkTranscript = (file, bytes) => { const fd = fs.openSync(file, 'w'); let n = 0, i = 0; while (n < bytes) { const l = line(i++) + '\n'; fs.writeSync(fd, l); n += l.length; } fs.closeSync(fd); };

const out = { generatedAt: new Date().toISOString(), ws: N, runs: RUNS, capBytes: 8 * 1024 * 1024, loadavg: fs.readFileSync('/proc/loadavg', 'utf8').split(' ').slice(0, 3).join(' '), cases: [] };
const median = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
// 9 MB stands for every transcript >= the 8 MB cap (the field's 47 MB one reads the same 8 MB): no need to write 1.5 GB of files.
for (const mb of [0.25, 2.4, 9]) {
  const bytes = Math.round(mb * 1024 * 1024);
  const ids = [];
  for (let i = 0; i < N; i++) {
    const id = `ws-ls-${mb}-${i}`; ids.push(id);
    const wt = path.join(ROOT, 'wt', `${mb}-${i}`); fs.mkdirSync(wt, { recursive: true });
    const dir = path.join(cfg, 'projects', mangleProjectDir(wt)); fs.mkdirSync(dir, { recursive: true });
    mkTranscript(path.join(dir, `sess-${i}.jsonl`), bytes);
    await store.upsertWorkspace({ id, name: id, kind: 'scratch', repoPath: '', worktreePath: wt, status: 'idle', createdAt: Date.now(), sdkSessionId: `sess-${i}` });
  }
  const walls = [], cpus = [];
  for (let r = 0; r < RUNS + 1; r++) {
    // every transcript "changed": bump mtime so the stat gate does not skip it
    const now = new Date(Date.now() + r * 1000);
    for (let i = 0; i < N; i++) { const wt = path.join(ROOT, 'wt', `${mb}-${i}`); fs.utimesSync(path.join(cfg, 'projects', mangleProjectDir(wt), `sess-${i}.jsonl`), now, now); }
    const c0 = process.cpuUsage(); const t0 = process.hrtime.bigint();
    await sweepLoopScan();
    const wall = Number(process.hrtime.bigint() - t0) / 1e6; const c = process.cpuUsage(c0);
    if (r === 0) continue; // warm-up: page cache + first-parse JIT
    walls.push(wall); cpus.push((c.user + c.system) / 1000);
  }
  // control: an UNCHANGED fleet costs one stat per workspace
  const c0 = process.cpuUsage(); const t0 = process.hrtime.bigint(); await sweepLoopScan();
  const unchanged = { wallMs: Number(process.hrtime.bigint() - t0) / 1e6, cpuMs: (() => { const c = process.cpuUsage(c0); return (c.user + c.system) / 1000; })() };
  out.cases.push({ transcriptMB: mb, bytesReadPerWorkspace: Math.min(bytes, out.capBytes), bytesReadPerSweep: N * Math.min(bytes, out.capBytes), wallMsMedian: Math.round(median(walls)), cpuMsMedian: Math.round(median(cpus)), unchangedFleetControl: { wallMs: Math.round(unchanged.wallMs), cpuMs: Math.round(unchanged.cpuMs) } });
  for (const id of ids) await store.removeWorkspace?.(id).catch?.(() => {});
  fs.rmSync(path.join(cfg, 'projects'), { recursive: true, force: true }); // free the disk between cases
}
fs.writeFileSync(path.join(ROOT, 'loop-scan-cost.json'), JSON.stringify(out, null, 1));
console.log(JSON.stringify(out));
process.exit(0);
