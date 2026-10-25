// #394 — the producer (Electron-free: a fake source, a fake table, and the REAL /proc or `ps` read of this very process) + text pins on the
// un-importable wiring (Electron-bound modules): the page snapshot, the 60 s monitor line, /busStatus + the CLI line, the panel's source.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { currentBrowserTabMemory, psTable, readPidTable, sampleBrowserTabMemory, setBrowserTabSource, type BrowserTabSource } from './browser-tab-memory.ts';
import type { ProcSample } from '../shared/resources.ts';

const MB = 1024 * 1024;
const row = (pid: number, memBytes: number): ProcSample => ({ pid, ppid: 1, comm: 'chrome', cpuTicks: 0, cpuPct: null, memBytes });
const src = (tabs: Array<[string, string, number | null]>, nonTab: number[] = []): BrowserTabSource => ({ tabs: () => tabs.map(([wsId, tabId, pid]) => ({ wsId, tabId, pid })), nonTabPids: () => nonTab });

test('P1 sampleBrowserTabMemory bills each tab\'s renderer from the table it is GIVEN (the caller\'s own read — no second source)', () => {
  const v = sampleBrowserTabMemory([row(10, 300 * MB), row(11, 40 * MB), row(12, 999 * MB)], src([['A', 't1', 10], ['B', 't1', 11]]));
  assert.deepEqual(v?.byWorkspace.map((w) => [w.wsId, w.bytes]), [['A', 300 * MB], ['B', 40 * MB]]);
  assert.deepEqual(v?.attributedPids, [10, 11], 'pid 12 is nobody\'s tab — never billed');
});

test('P2 no source registered (a rig, an older main) = undefined, NOT an empty view; a source with no tab = an empty view', () => {
  setBrowserTabSource(null);
  assert.equal(sampleBrowserTabMemory([row(10, 1)]), undefined);
  assert.deepEqual(sampleBrowserTabMemory([row(10, 1)], src([])), { byWorkspace: [], attributedPids: [] });
});

test('P3 a pid that also hosts the app\'s own page is never billed (nonTabPids)', () => {
  const v = sampleBrowserTabMemory([row(10, 900 * MB)], src([['A', 't1', 10]], [10]));
  assert.equal(v?.byWorkspace[0].bytes, null);
  assert.deepEqual(v?.attributedPids, []);
});

test('P4 a throwing source never throws out of the sampler: undefined + ONE warn per source', () => {
  const bad: BrowserTabSource = { tabs: () => { throw new Error('boom'); }, nonTabPids: () => [] };
  const warns: string[] = [];
  setBrowserTabSource(bad);
  assert.equal(sampleBrowserTabMemory([], undefined, (m) => warns.push(m)), undefined);
  assert.equal(sampleBrowserTabMemory([], undefined, (m) => warns.push(m)), undefined);
  assert.equal(warns.length, 1);
  assert.match(warns[0], /browser tab memory could not be read/);
  setBrowserTabSource(null);
});

test('P4b a caller with no logger (the page, bus-status) never consumes the ONE warning the monitor owes', () => {
  const bad: BrowserTabSource = { tabs: () => { throw new Error('boom'); }, nonTabPids: () => [] };
  const warns: string[] = [];
  setBrowserTabSource(bad);
  assert.equal(sampleBrowserTabMemory([]), undefined, 'the page path: silent, no logger');
  assert.equal(currentBrowserTabMemory(), undefined, 'the bus-status path: silent, no logger');
  assert.equal(sampleBrowserTabMemory([], undefined, (m) => warns.push(m)), undefined);
  assert.equal(warns.length, 1, 'the monitor still gets its WARN');
  setBrowserTabSource(null);
});

test('P7 psTable (non-Linux): `ps -p` exits 1 when one pid is gone — the surviving rows are salvaged, not all unmeasured; a clean run and a total failure behave', () => {
  const rows = '  10     1 300000  0.0 chrome\n';
  assert.deepEqual(psTable([10, 11], () => rows).map((p) => [p.pid, p.memBytes]), [[10, 300000 * 1024]]);
  assert.deepEqual(psTable([10, 11], () => { throw Object.assign(new Error('exit 1'), { stdout: rows }); }).map((p) => p.pid), [10], 'a pid gone: ps still printed the other rows');
  assert.deepEqual(psTable([10], () => { throw new Error('ps missing'); }), [], 'nothing to salvage');
});

test('P5 currentBrowserTabMemory reads ONLY the tabs\' own pids (bus-status: no full-table scan) and agrees with the table path', () => {
  const asked: number[][] = [];
  const v = currentBrowserTabMemory(src([['A', 't1', 10], ['A', 't2', 10], ['B', 't1', null], ['C', 't1', 0]]), undefined, (pids) => { asked.push(pids); return [row(10, 80 * MB)]; });
  assert.deepEqual(asked, [[10]], 'one read, the distinct live pids only');
  assert.equal(v?.byWorkspace.find((w) => w.wsId === 'A')?.bytes, 80 * MB);
  assert.equal(v?.byWorkspace.find((w) => w.wsId === 'B')?.bytes, null);
});

test('P6 readPidTable on THIS process: a real, plausible resident size on this host\'s page size; an unknown pid reads nothing', () => {
  const [me] = readPidTable([process.pid]);
  assert.equal(me?.pid, process.pid);
  assert.ok(me.memBytes > 10 * MB && me.memBytes < 4096 * MB, `rss ${me.memBytes}`);
  if (process.platform === 'linux') {
    const vmrss = Number(/VmRSS:\s+(\d+) kB/.exec(fs.readFileSync('/proc/self/status', 'utf8'))?.[1]) * 1024;
    assert.ok(me.memBytes / vmrss > 0.8 && me.memBytes / vmrss < 1.25, `stat RSS ${me.memBytes} vs VmRSS ${vmrss}: a hard-coded 4 KB page reads 4x low on a 16 KB host`);
  }
  assert.deepEqual(readPidTable([]), []);
  assert.deepEqual(readPidTable([2 ** 22 + 12345]), []);
});

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');

test('W1 the producer module stays Electron-free and read-only (the samplers import it under plain node)', () => {
  const m = read('src/main/browser-tab-memory.ts').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, ''); // code only — the comments name what it does NOT call
  assert.doesNotMatch(m, /from 'electron'|require\('electron'\)|getAppMetrics|\.webContents/);
  assert.doesNotMatch(m, /process\.kill|\.kill\(|SIGTERM|writeFile/);
});

test('W2 the panel registers the source at init: live tabs only (never reaps or publishes), the app\'s own UI pid excluded', () => {
  const bp = read('src/main/browser-panel.ts');
  const init = bp.slice(bp.indexOf('export function initBrowserPanels('), bp.indexOf('/** The session partition holding'));
  assert.match(init, /setBrowserTabSource\(\{/);
  assert.match(init, /liveContents\(t\)/);
  assert.match(init, /getOSProcessId\(\)/);
  assert.doesNotMatch(init, /reapIfDead|publish\(/, 'a sampler read must not change panel state');
  assert.match(init, /nonTabPids: \(\) => /);
});

test('W3 the Resources snapshot measures tabs against THIS sample\'s process table', () => {
  assert.match(read('src/main/resources.ts'), /browserTabs: sampleBrowserTabMemory\(table\),/);
});

test('W4 the 60 s monitor line carries the tabs: ONLY productionDeps installs it (a rig calling sampleTick() reads no panel), measured against the tick\'s own table', () => {
  const mon = read('src/main/resource-monitor.ts');
  const dflt = mon.slice(mon.indexOf('const defaultDeps: ResourceMonitorDeps = {'), mon.indexOf('/** Boot pass (#203)'));
  assert.doesNotMatch(dflt, /browserTabs/);
  const prod = mon.slice(mon.indexOf('export function productionDeps()'), mon.indexOf('async function withBudget('));
  assert.match(prod, /browserTabs: \(table\) => sampleBrowserTabMemory\(table, undefined, /);
  const body = mon.slice(mon.indexOf('export async function sampleTick('), mon.indexOf('let timer: NodeJS.Timeout | null = null;'));
  assert.match(body, /browserTabs: readBrowserTabs\(d, table\),/);
  const rb = mon.slice(mon.indexOf('function readBrowserTabs('), mon.indexOf('/** One sample + detect'));
  assert.match(rb, /if \(!d\.browserTabs\) return undefined;/);
  assert.match(rb, /catch \(e\) \{\s*\n\s*d\.warn\('resources: browser tab memory read failed — this line carries no browser figure', e\);/);
});

test('W5 /busStatus returns the tabs + labels only when measurable; the CLI prints the line only for that shape', () => {
  const hs = read('src/main/hooks-server.ts');
  assert.match(hs, /const browserTabsView = currentBrowserTabMemory\(\);/);
  assert.match(hs, /\.\.\.\(browserTabsView \? \{ browserTabs: browserTabsView, browserTabLabels: /);
  const cli = read('src/cli/index.ts');
  assert.match(cli, /Array\.isArray\(\(res\.browserTabs as BrowserTabMemoryView\)\.byWorkspace\)/);
  assert.match(cli, /process\.stdout\.write\(`\$\{formatBrowserTabsLine\(res\.browserTabs as BrowserTabMemoryView, \(id\) => blabels\[id\] \?\? id\)\}\\n`\);/);
});

test('W6 the page: rows read the snapshot through the ONE grouping call, the App tile leaves out billed renderers, the chip + browser-only row render', () => {
  const v = read('src/renderer/components/ResourcesView.tsx');
  assert.match(v, /const grouped = groupSnapshot\(snap\);/);
  assert.match(v, /const appMem = appMemoryExcludingTabs\(snap\?\.app \?\? \[\], snap\?\.browserTabs\);/);
  assert.match(v, /row\.containerOnly \|\| row\.scopeOnly \|\| row\.browserOnly \? \(/);
  assert.match(v, /data-res-tabs=\{browser\.tabs\}/);
  assert.match(v, /formatBytes\(row\.browserOnly && row\.browser\?\.bytes == null && !row\.containers \? null : row\.memBytes\)/, 'a browser-only row whose tabs are all unmeasured reads « — », never 0 B');
});
