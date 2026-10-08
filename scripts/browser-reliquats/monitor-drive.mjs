// #331 — drives the REAL src/main/resource-monitor.ts `sampleTick` (the 60 s timer's body) with the browser-Reliquat bridge installed, over a fake /proc world. The monitor cannot be
// imported bare under the strip-types runner (extensionless imports), so src/main/browser-reliquats-monitor.test.ts runs this in one child with the repo's resolve hook and asserts its checks.
//   node --experimental-strip-types --import ./scripts/.r2-register.mjs scripts/browser-reliquats/monitor-drive.mjs   → last line {"checks":[{name,ok,detail}]}
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
process.env.ORCHESTRA_HOME = fs.mkdtempSync(path.join(os.homedir(), '.cache', 'browser-monitor-drive-'));
const { realResourceMonitorDeps, sampleTick, __resetResourceMonitorForTest } = await import(`${REPO}/src/main/resource-monitor.ts`);
const { BrowserTracker } = await import(`${REPO}/src/main/browser-reliquats.ts`);

const ROOT = '/h/.orchestra/agent-tmp';
const checks = [];
const check = (name, ok, detail = '') => checks.push({ name, ok: !!ok, detail: String(detail).slice(0, 300) });

function world() {
  const procs = new Map();
  const signals = [];
  const notes = [];
  const warns = [];
  const orphan = (pid, ws, mode = 'pipe') => procs.set(pid, { pid, ppid: 1, comm: 'chrome', startTicks: 1000 + pid, argv: ['/opt/chrome', '--headless=new', mode === 'pipe' ? '--remote-debugging-pipe' : '--remote-debugging-port=0', `--user-data-dir=${ROOT}/${ws}/tmp/p${pid}`] });
  const table = () => [...procs.values()].map((p) => ({ pid: p.pid, ppid: p.ppid, comm: p.comm, cpuTicks: 0, memBytes: 0, cpuPct: null, startTicks: p.startTicks }));
  const browserDeps = {
    now: () => 5_000_000, agentTmpRoot: () => ROOT, workspaceKnown: (id) => id.startsWith('ws-'),
    readProcStat: (pid) => { const p = procs.get(pid); return p ? { pid, ppid: p.ppid, comm: p.comm, cpuTicks: 0, memBytes: 0, cpuPct: null, startTicks: p.startTicks } : null; },
    readCmdline: (pid) => procs.get(pid)?.argv ?? null,
    clientState: () => ({ ports: [], client: 'no' }), startMs: (t) => t,
    signal: (pid, sig) => { signals.push({ pid, sig }); return procs.delete(pid); },
    sleep: async () => {}, warn: (m) => { warns.push(m); }, info: () => {}, graceMs: 1,
  };
  const deps = (extra = {}) => ({
    ...realResourceMonitorDeps(), now: () => 5_000_000, procTable: async () => table(), keeperRoots: () => [], keeperProcs: () => [], trackedKeeperPid: () => null,
    liveWorkspaceIds: () => new Set(['ws-1', 'ws-2']), storeLoadedFromDisk: () => true, electronProcs: () => [], cpuCores: () => 4, memTotalBytes: () => 8 * 1024 ** 3, memUsedBytes: () => 1024 ** 3,
    appendLine: () => {}, warn: (m) => { warns.push(m); }, info: () => {}, ...extra,
  });
  return { procs, signals, notes, warns, orphan, browserDeps, deps };
}

{ // arm 1 — the tick stops pipe orphans; ONE status per member; nothing to say next pass
  __resetResourceMonitorForTest();
  const w = world();
  w.orphan(500, 'ws-1'); w.orphan(501, 'ws-1'); w.orphan(600, 'ws-2');
  const tracker = new BrowserTracker();
  const browser = () => ({ deps: w.browserDeps, tracker, notifyOwner: (ws, text) => w.notes.push({ ws, text }) });
  await sampleTick(w.deps({ browser: browser() }));
  check('tick_stops_the_pipe_orphans', JSON.stringify(w.signals.filter((s) => s.sig === 'SIGTERM').map((s) => s.pid).sort((a, b) => a - b)) === '[500,501,600]', JSON.stringify(w.signals));
  check('one_status_per_member_not_per_browser', JSON.stringify(w.notes.map((n) => n.ws).sort()) === '["ws-1","ws-2"]', JSON.stringify(w.notes.map((n) => n.ws)));
  const n1 = w.notes.find((n) => n.ws === 'ws-1')?.text ?? '';
  check('status_names_the_count_and_the_profile_prefix', /stopped 2 orphaned headless browser\(s\)/.test(n1) && n1.includes(`${ROOT}/ws-1/tmp/`), n1);
  check('counter_counts_every_stop', tracker.view().total === 3, JSON.stringify(tracker.view()));
  w.notes.length = 0;
  await sampleTick(w.deps({ browser: browser() }));
  check('no_empty_status_on_a_quiet_pass', w.notes.length === 0, JSON.stringify(w.notes));
}
{ // arm 2 — no `browser` dep: never touched
  __resetResourceMonitorForTest();
  const w = world();
  w.orphan(500, 'ws-1');
  await sampleTick(w.deps());
  check('without_the_browser_dep_nothing_is_touched', w.signals.length === 0 && w.procs.size === 1, JSON.stringify(w.signals));
}
{ // arm 3 — failures never break the tick
  __resetResourceMonitorForTest();
  const w = world();
  w.orphan(500, 'ws-1');
  const line = await sampleTick(w.deps({ browser: { deps: { ...w.browserDeps, agentTmpRoot: () => { throw new Error('root exploded'); } }, tracker: new BrowserTracker(), notifyOwner: () => {} } }));
  check('a_throwing_pass_still_produces_the_line', line.at > 0 && w.warns.some((m) => /browser pass failed/.test(m)), w.warns.join(' | '));
  const w2 = world();
  w2.orphan(500, 'ws-1');
  const l2 = await sampleTick(w2.deps({ browser: { deps: w2.browserDeps, tracker: new BrowserTracker(), notifyOwner: () => { throw new Error('bus down'); } } }));
  check('a_throwing_notification_does_not_undo_the_stop', l2.at > 0 && w2.signals.some((s) => s.pid === 500 && s.sig === 'SIGTERM') && w2.warns.some((m) => /could not tell workspace ws-1 about its 1 stopped browser/.test(m)), w2.warns.join(' | '));
}
fs.rmSync(process.env.ORCHESTRA_HOME, { recursive: true, force: true });
console.log(JSON.stringify({ checks }));
