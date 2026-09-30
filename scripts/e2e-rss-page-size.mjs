#!/usr/bin/env node
// Driven proof for the RSS page-size fix (#214 finding): the always-on monitor's RSS must equal the kernel's own
// VmRSS. Drives the REAL src/main/resource-monitor.ts `procTable` and `sampleTick` over the REAL /proc of this
// host (a session tree = this process + a child holding ~200 MB), and compares with /proc/<pid>/status VmRSS read
// independently. On a 16 KB-page host the pre-fix build reads 4x LOW; on a 4 KB host the arms cannot discriminate
// (said loudly) and the explicit-16384 unit arms carry the proof.
// Run: node --experimental-strip-types --import ./scripts/.r2-register.mjs scripts/e2e-rss-page-size.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const HOME = fs.mkdtempSync(path.join(os.homedir(), '.cache', 'rss-page-size-rig-'));
process.env.ORCHESTRA_HOME = HOME;
const M = await import('../src/main/resource-monitor.ts');
console.log(`module under test: ${path.relative(ROOT, fileURLToPath(new URL('../src/main/resource-monitor.ts', import.meta.url)))}`);
const PAGE = Number(execFileSync('getconf', ['PAGESIZE'], { encoding: 'utf8' }).trim());
console.log(`host page size (getconf PAGESIZE): ${PAGE}${PAGE === 4096 ? ' — NON-DISCRIMINATING host: only the explicit-16384 unit arms can see the bug' : ''}`);

let failures = 0;
const check = (name, ok, detail) => { if (ok) console.log(`  ✓ ${name}`); else { failures++; console.log(`  ✗ ${name}${detail !== undefined ? ` — ${detail}` : ''}`); } };
const vmRssBytes = (pid) => Number(/VmRSS:\s+(\d+)/.exec(fs.readFileSync(`/proc/${pid}/status`, 'utf8'))?.[1] ?? NaN) * 1024;
const within = (a, b, tol) => Math.abs(a - b) / b <= tol;

const results = [];
async function arm(name, fn) {
  console.log(`== arm ${name}`);
  const before = failures;
  try { await fn(); } catch (e) { failures++; console.log(`  ✗ arm threw — ${e?.stack ?? e}`); }
  results.push([name, failures === before]);
}

await arm('self_vs_vmrss', async () => {
  const d = M.realResourceMonitorDeps();
  const table = await d.procTable();
  const self = table.find((p) => p.pid === process.pid);
  check('the monitor\'s process table lists this process', !!self);
  const vm = vmRssBytes(process.pid);
  check(`monitor RSS of this process is within 15% of its VmRSS (monitor ${Math.round((self?.memBytes ?? 0) / 1048576)} MB, VmRSS ${Math.round(vm / 1048576)} MB)`, !!self && within(self.memBytes, vm, 0.15), `ratio ${(self?.memBytes ?? 0) / vm}`);
});

await arm('tree_line', async () => {
  const child = spawn(process.execPath, ['-e', "const b = Buffer.alloc(200 * 1024 * 1024, 1); process.stdout.write('ready\\n'); setInterval(() => b[0]++, 1000);"], { stdio: ['ignore', 'pipe', 'ignore'] });
  try {
    await new Promise((resolve, reject) => { child.stdout.once('data', resolve); child.once('exit', () => reject(new Error('child exited early'))); setTimeout(() => reject(new Error('child not ready')), 20000); });
    const lines = [];
    const warns = [];
    const d = { ...M.realResourceMonitorDeps(), keeperRoots: () => [{ workspaceId: 'ws-rss', keeperPid: process.pid }], keeperProcs: () => [], trackedKeeperPid: () => null, liveWorkspaceIds: () => new Set(['ws-rss']), statusFor: () => 'idle', storeLoadedFromDisk: () => true, electronProcs: () => [], signal: () => false, appendLine: (l) => lines.push(l), warn: (m) => warns.push(m) };
    await M.sampleTick(d);
    const s = lines[0]?.sessions?.find((x) => x.workspaceId === 'ws-rss');
    check('sampleTick produced a session tree line for the rig tree (rig + child)', !!s && s.procCount >= 2, JSON.stringify(s));
    const truth = vmRssBytes(process.pid) + vmRssBytes(child.pid);
    check(`the logged tree RSS is within 15% of Σ VmRSS over the tree (logged ${Math.round((s?.rssBytes ?? 0) / 1048576)} MB, kernel ${Math.round(truth / 1048576)} MB)`, !!s && within(s.rssBytes, truth, 0.15), `ratio ${(s?.rssBytes ?? 0) / truth}`);
    check('the child\'s ~200 MB is visible in the tree (the tree is not just this process)', !!s && s.rssBytes >= 190 * 1048576, String(s?.rssBytes));
    check(`every jsonl line carries the page size its RSS used (regime marker) = the kernel's ${PAGE}`, lines[0]?.pageSize === PAGE, String(lines[0]?.pageSize));
  } finally { child.kill('SIGKILL'); }
});

await arm('resources_page_sampler', async () => {
  const { execFileSync: run } = await import('node:child_process');
  let out = '';
  let code = 0;
  try {
    out = run(process.execPath, ['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', '--experimental-strip-types', '--import', path.join(ROOT, 'scripts', 'rss-page-size', 'register-resources-stubs.mjs'), path.join(ROOT, 'scripts', 'rss-page-size', 'drive-resources.mjs')], { cwd: ROOT, encoding: 'utf8', timeout: 90_000, env: { PATH: process.env.PATH, HOME: process.env.HOME } });
  } catch (e) { out = `${e.stdout ?? ''}${e.stderr ?? ''}`; code = e.status ?? 1; }
  const m = /RESOURCES-PAGE-SAMPLER: (PASS|FAIL) ratio ([\d.]+)/.exec(out);
  check(`the REAL Resources-page sampler (sampleResources over real /proc; only pty/events/statfs/platform stubbed) reads the tree within 15% of Σ VmRSS (ratio ${m?.[2]})`, code === 0 && m?.[1] === 'PASS', out.slice(-300));
});

await arm('call_sites_pin', async () => {
  const pin = (f, re) => re.test(fs.readFileSync(path.join(ROOT, f), 'utf8'));
  check('resource-monitor.ts: the table, readProcStat and the jsonl marker all use hostPageSize()', pin('src/main/resource-monitor.ts', /parseProcStatLine\(fs\.readFileSync\(`\/proc\/\$\{name\}\/stat`, 'utf8'\), pageSize\)/) && pin('src/main/resource-monitor.ts', /parseProcStatLine\(fs\.readFileSync\(`\/proc\/\$\{pid\}\/stat`, 'utf8'\), hostPageSize\(\)\)/) && pin('src/main/resource-monitor.ts', /pageSize: hostPageSize\(\),/));
});

fs.rmSync(HOME, { recursive: true, force: true });
console.log(`arms: ${results.map(([n, ok]) => `${n}=${ok ? 'ok' : 'FAIL'}`).join(' ')}`);
console.log(failures === 0 ? 'RSS-PAGE-SIZE: PASS' : `RSS-PAGE-SIZE: FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
