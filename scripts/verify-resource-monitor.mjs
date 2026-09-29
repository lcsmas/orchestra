#!/usr/bin/env node
// G3 driven proof for issue #198 T8: the always-on resource monitor + reaper.
//
// Drives the REAL src/main/resource-monitor.ts `sampleTick` (what the 60s timer runs)
// over a FAKED /proc *world* that can recycle a pid at the two moments that matter —
// between the sample and the kill (`afterSample`) and during the SIGTERM grace
// (`onSleep`) — through the REAL append (a real resources.jsonl under a temp
// ORCHESTRA_HOME on btrfs) and the REAL reap decision. Every delivered signal is
// recorded with the OCCUPANT of the pid at that instant, so "killed an unrelated
// process" is observed, never inferred. Each arm names the clause it exercises.
//
// Run: node --experimental-strip-types --import ./scripts/.r2-register.mjs \
//        scripts/verify-resource-monitor.mjs
// Also runnable against the PRE-FIX build (deps carry an old-build `kill` alias):
// the F1/F3/F4 arms must redden there — see docs/codebase-map/resources.md.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const HOME = fs.mkdtempSync(path.join(ROOT, '.resmon-rig-'));
process.env.ORCHESTRA_HOME = HOME;

const M = await import('../src/main/resource-monitor.ts');
const { sampleTick, resourcesLogPath, __resetResourceMonitorForTest } = M;
console.log(`module under test: ${path.relative(ROOT, fileURLToPath(new URL('../src/main/resource-monitor.ts', import.meta.url)))}`);

let failures = 0;
function check(name, cond, detail) {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failures++;
    console.log(`  ✗ ${name}${detail !== undefined ? ` — ${detail}` : ''}`);
  }
}

// ── The fake /proc world ─────────────────────────────────────────────────────
const KEEPER_ARGV = (ws) => ['/opt/Orchestra/orchestra', `${HOME}/bin/keeper.js`, ws, 's', 'p', 'l'];

class World {
  constructor() {
    this.now = 1_700_000_000_000;
    this.procs = new Map(); // pid -> occupant
    this.signals = []; // {pid, sig, comm, startTicks} — occupant AT delivery
    this.warns = [];
    this.infos = [];
    this.slept = [];
    this.roots = [];
    this.live = new Set();
    this.storeLoaded = true;
    this.electronMetrics = [];
    this.afterSample = null;
    this.onSleep = null;
    this.blindTable = false; // non-Linux ps fallback: no start-times
    this.liveCalls = 0;
    this.liveAfterFirstCall = null; // fn → Set, used from the 2nd liveWorkspaceIds() call on
  }
  add(pid, ppid, comm, o = {}) {
    this.procs.set(pid, {
      pid, ppid, comm,
      startTicks: o.startTicks ?? 1000 + pid,
      memMb: o.memMb ?? 10,
      cpuTicks: o.cpuTicks ?? 0,
      argv: o.argv ?? [comm],
      onTerm: o.onTerm ?? 'die',
    });
  }
  /** keeper(k) → claude(k+1) → chrome-mcp(k+2); keeper → server-filesystem(k+3). */
  addTree(k, ws, over = {}) {
    this.add(k, 1, `keeper.js ${ws}`, { memMb: 56, argv: KEEPER_ARGV(ws), ...over[k] });
    this.add(k + 1, k, 'claude', { memMb: 350, ...over[k + 1] });
    this.add(k + 2, k + 1, 'chrome-devtools-mcp', { memMb: 220, ...over[k + 2] });
    this.add(k + 3, k, 'server-filesystem', { memMb: 130, ...over[k + 3] });
    this.roots.push({ workspaceId: ws, keeperPid: k });
  }
  sample(p) {
    return {
      pid: p.pid, ppid: p.ppid, comm: p.comm, cpuTicks: p.cpuTicks,
      memBytes: p.memMb * 1024 * 1024, cpuPct: null,
      ...(this.blindTable ? {} : { startTicks: p.startTicks }),
    };
  }
  table() { return [...this.procs.values()].map((p) => this.sample(p)); }
  readProcStat(pid) {
    const p = this.procs.get(pid);
    return p ? { ...this.sample(p), startTicks: p.startTicks } : null;
  }
  readCmdline(pid) { return this.procs.get(pid)?.argv ?? null; }
  signal(pid, sig) {
    const p = this.procs.get(pid);
    if (!p) return false;
    this.signals.push({ pid, sig, comm: p.comm, startTicks: p.startTicks });
    if (sig === 'SIGKILL' || p.onTerm === 'die') this.procs.delete(pid);
    return true;
  }
  deps() {
    return {
      now: () => this.now,
      procTable: async () => {
        const t = this.table();
        this.afterSample?.(); // the pid is recycled AFTER the sample, BEFORE the kill
        return t;
      },
      keeperRoots: () => this.roots,
      liveWorkspaceIds: () => {
        this.liveCalls++;
        return this.liveCalls > 1 && this.liveAfterFirstCall ? this.liveAfterFirstCall() : this.live;
      },
      statusFor: (id) => (this.live.has(id) ? 'running' : null),
      storeLoadedFromDisk: () => this.storeLoaded,
      electronProcs: () => this.electronMetrics,
      cpuCores: () => 8,
      memTotalBytes: () => 32 * 1024 ** 3,
      memUsedBytes: () => 18 * 1024 ** 3,
      appendLine: M.appendResourceLogLine ?? ((l) => {
        fs.mkdirSync(path.dirname(resourcesLogPath()), { recursive: true });
        fs.appendFileSync(resourcesLogPath(), `${JSON.stringify(l)}\n`);
      }),
      readProcStat: (pid) => this.readProcStat(pid),
      readCmdline: (pid) => this.readCmdline(pid),
      signal: (pid, sig) => this.signal(pid, sig),
      sleep: async (ms) => { this.slept.push(ms); this.onSleep?.(); },
      warn: (m) => this.warns.push(m),
      info: (m) => this.infos.push(m),
      // PRE-FIX build compat: decb7169's sampleTick calls deps.kill (raw SIGKILL). Unused by the fix.
      kill: (pid) => this.signal(pid, 'SIGKILL'),
    };
  }
}

function freshArm() {
  __resetResourceMonitorForTest();
  fs.rmSync(path.join(HOME, 'logs'), { recursive: true, force: true });
  const w = new World();
  w.addTree(100, 'alive');
  w.live.add('alive');
  w.add(999, 1, 'electron', { memMb: 800 });
  w.electronMetrics = [{ type: 'Browser', pid: 999, cpuPct: 999, rssBytes: 800 * 1024 * 1024 }];
  return w;
}
const sigsFor = (w, pred) => w.signals.filter(pred);
/** Universal must-PASS: the LIVE workspace's tree and Electron are never signalled. */
function neverTouchedLive(w, label) {
  const bad = sigsFor(w, (s) => (s.pid >= 100 && s.pid <= 103) || s.pid === 999 || s.pid === 1);
  check(`${label}: live tree (100-103) + Electron (999) never signalled`, bad.length === 0, JSON.stringify(bad));
}
const seq = (w) => w.signals.map((s) => `${s.sig === 'SIGTERM' ? 'T' : 'K'}${s.pid}`).join(' ');

// ── A1: cooperative orphan → SIGTERM leaf-first, NO SIGKILL, JSONL shape ─────
console.log('A1 — orphan reaped gracefully (SIGTERM only), live spared, JSONL written [clause: SIGTERM-first]:');
{
  const w = freshArm();
  w.addTree(200, 'gone');
  const line = await sampleTick(w.deps());
  check('orphan tree SIGTERMed leaf-first, keeper last (T202 T203 T201 T200)', seq(w) === 'T202 T203 T201 T200', seq(w));
  check('cooperative tree got NO SIGKILL (graceful)', !w.signals.some((s) => s.sig === 'SIGKILL'), seq(w));
  check('one grace sleep of 5000 ms between SIGTERM and the survivor check', JSON.stringify(w.slept) === '[5000]', JSON.stringify(w.slept));
  check('reap WARN names the workspace and "identity verified" BEFORE signalling',
    w.warns.some((m) => m.includes('reaping orphaned session tree') && m.includes('gone') && m.includes('identity verified')), JSON.stringify(w.warns));
  neverTouchedLive(w, 'A1');
  const written = fs.readFileSync(resourcesLogPath(), 'utf8').trim().split('\n');
  const parsed = JSON.parse(written[written.length - 1]);
  console.log('  ── JSONL line written to resources.jsonl:');
  console.log('     ' + JSON.stringify(parsed).slice(0, 380) + '…');
  check('line: totals.memUsedBytes + electron[] row', parsed.totals?.memUsedBytes === 18 * 1024 ** 3 && parsed.electron?.length === 1);
  check('line: a row per keeper tree keyed by ws id (alive present/running; gone absent+reaped)',
    parsed.sessions?.length === 2 &&
      parsed.sessions.some((s) => s.workspaceId === 'alive' && s.present && s.status === 'running' && !s.reaped) &&
      parsed.sessions.some((s) => s.workspaceId === 'gone' && !s.present && s.reaped), JSON.stringify(parsed.sessions));
  check('line: session tree rss rolled up (56+350+220+130 MB)',
    parsed.sessions.find((s) => s.workspaceId === 'alive')?.rssBytes === (56 + 350 + 220 + 130) * 1024 * 1024);
  void line;
}

// ── A2: stubborn CLI ignores SIGTERM → SIGKILL only that survivor, after the grace ──
console.log('\nA2 — CLI ignores SIGTERM → SIGKILL it (only it) after the grace [clause: survivor SIGKILL]:');
{
  const w = freshArm();
  w.addTree(200, 'gone', { 201: { onTerm: 'ignore' } });
  await sampleTick(w.deps());
  check('4 SIGTERM then exactly one SIGKILL, to the stubborn pid 201', seq(w) === 'T202 T203 T201 T200 K201', seq(w));
  neverTouchedLive(w, 'A2');
}

// ── A3: pid reused between sample and kill → NOT killed (must-FAIL on the pre-fix build) ──
console.log('\nA3 — a member pid REUSED by an unrelated process between sample and kill is NOT signalled [clause: member start-time]:');
{
  const w = freshArm();
  w.addTree(200, 'gone');
  w.afterSample = () => w.add(202, 1, 'unrelated-editor', { startTicks: 9_999_999, argv: ['/usr/bin/editor'] });
  await sampleTick(w.deps());
  const victims = sigsFor(w, (s) => s.comm === 'unrelated-editor');
  check('the unrelated occupant of pid 202 was NEVER signalled', victims.length === 0, JSON.stringify(victims));
  check('the genuine members (200, 201, 203) were still reaped', ['T203', 'T201', 'T200'].every((t) => seq(w).includes(t)), seq(w));
  check('WARN names the withheld pid and "pid reused"', w.warns.some((m) => m.includes('pid 202') && m.includes('pid reused')), JSON.stringify(w.warns));
  neverTouchedLive(w, 'A3');
}

// ── A3b: same-PARENT reuse → only the start-time clause can catch it ─────────
console.log('\nA3b — pid reused by a process under the SAME parent (ppid matches): only start-time can tell [clause: member start-time, unmasked]:');
{
  const w = freshArm();
  w.addTree(200, 'gone');
  w.afterSample = () => w.add(202, 201, 'unrelated-sibling', { startTicks: 9_999_998, argv: ['/usr/bin/sibling'] });
  await sampleTick(w.deps());
  check('the same-parent newcomer at pid 202 was NEVER signalled',
    !w.signals.some((s) => s.comm === 'unrelated-sibling'), seq(w));
  check('WARN names pid 202 as "pid reused" (not "reparented")', w.warns.some((m) => m.includes('pid 202') && m.includes('pid reused')), JSON.stringify(w.warns));
}

// ── A4: recycled keeper ROOT (stale pid file) → whole tree refused (must-FAIL on the pre-fix build) ──
console.log('\nA4 — stale <wsId>.pid whose pid is now an UNRELATED program with children: reap REFUSED [clause: keeper cmdline]:');
{
  const w = freshArm();
  w.add(200, 1, 'postgres', { argv: ['/usr/bin/postgres', '-D', '/data'], startTicks: 5_000_000 });
  w.add(201, 200, 'postgres: writer', { startTicks: 5_000_001 });
  w.add(202, 200, 'postgres: wal', { startTicks: 5_000_002 });
  w.roots.push({ workspaceId: 'gone', keeperPid: 200 });
  await sampleTick(w.deps());
  check('ZERO signals delivered (unrelated tree untouched)', w.signals.length === 0, seq(w));
  check('WARN says WITHHELD + keeper-cmdline-mismatch', w.warns.some((m) => m.includes('WITHHELD') && m.includes('keeper-cmdline-mismatch')), JSON.stringify(w.warns));
  const written = JSON.parse(fs.readFileSync(resourcesLogPath(), 'utf8').trim().split('\n').pop());
  const row = written.sessions.find((s) => s.workspaceId === 'gone');
  check('log row shows the orphan as present:false, reaped:false (visible, not silently dropped)', row && !row.present && !row.reaped, JSON.stringify(row));
  neverTouchedLive(w, 'A4');
}

// ── A4b: root replaced by a real keeper.js <ws> with a different start-time → only start-time can tell ──
console.log('\nA4b — keeper root replaced by ANOTHER `keeper.js gone` process (cmdline matches, start-time differs): tree REFUSED [clause: keeper start-time, unmasked]:');
{
  const w = freshArm();
  w.addTree(200, 'gone');
  w.afterSample = () => w.add(200, 1, 'keeper.js gone', { startTicks: 7_777_777, memMb: 56, argv: KEEPER_ARGV('gone') });
  await sampleTick(w.deps());
  check('ZERO signals delivered', w.signals.length === 0, seq(w));
  check('WARN says keeper-start-time-changed', w.warns.some((m) => m.includes('WITHHELD') && m.includes('keeper-start-time-changed')), JSON.stringify(w.warns));
}

// ── A5: pid reused DURING the grace → the late occupant is NOT SIGKILLed ─────
console.log('\nA5 — a member exits on SIGTERM and its pid is recycled DURING the grace: no SIGKILL to the newcomer [clause: survivor identity]:');
{
  const w = freshArm();
  w.addTree(200, 'gone', { 201: { onTerm: 'ignore' } });
  w.onSleep = () => w.add(203, 1, 'unrelated-late', { startTicks: 8_888_888, argv: ['/usr/bin/late'] });
  await sampleTick(w.deps());
  check('the late occupant of pid 203 was never signalled with anything after the grace',
    !w.signals.some((s) => s.comm === 'unrelated-late'), seq(w));
  check('the stubborn genuine survivor 201 WAS SIGKILLed', w.signals.some((s) => s.pid === 201 && s.sig === 'SIGKILL'), seq(w));
  check('WARN reports the reused pid as left alone', w.warns.some((m) => m.includes('pid reused (left alone) 203')), JSON.stringify(w.warns));
  neverTouchedLive(w, 'A5');
}

// ── A6: identity unverifiable (no start-times: non-Linux ps fallback) → refuse ──
console.log('\nA6 — no start-times in the table (non-Linux): reap REFUSED, fail closed [clause: unverifiable identity]:');
{
  const w = freshArm();
  w.addTree(200, 'gone');
  w.blindTable = true;
  await sampleTick(w.deps());
  check('ZERO signals delivered', w.signals.length === 0, seq(w));
  check('WARN says identity-unverifiable', w.warns.some((m) => m.includes('identity-unverifiable')), JSON.stringify(w.warns));
}

// ── A7 / A8 / A9: store gates ────────────────────────────────────────────────
console.log('\nA7 — store NOT loaded from disk: reaper REFUSES [clause: store-loaded gate]:');
{
  const w = freshArm();
  w.addTree(200, 'gone');
  w.storeLoaded = false;
  await sampleTick(w.deps());
  check('ZERO signals delivered', w.signals.length === 0, seq(w));
  check('info line explains the skip', w.infos.some((m) => m.includes('reap skipped') && m.includes('store not loaded')), JSON.stringify(w.infos));
}
console.log('\nA8 — "gone" IS in the store → not an orphan → spared [clause: live-workspace guard]:');
{
  const w = freshArm();
  w.addTree(200, 'gone');
  w.live.add('gone');
  await sampleTick(w.deps());
  check('ZERO signals delivered', w.signals.length === 0, seq(w));
}
console.log('\nA9 — ws absent at tick start but PRESENT at kill time (store re-read): reap ABORTED [clause: kill-time store re-read]:');
{
  const w = freshArm();
  w.addTree(200, 'gone');
  w.liveAfterFirstCall = () => new Set(['alive', 'gone']); // re-created between decision and kill
  await sampleTick(w.deps());
  check('ZERO signals delivered', w.signals.length === 0, seq(w));
  check('WARN says ABORTED — present in the store at kill time', w.warns.some((m) => m.includes('ABORTED')), JSON.stringify(w.warns));
}

// ── A10: F3 — Electron cpu from the monitor's own jiffy deltas, not the shared-cursor metric ──
console.log('\nA10 — Electron cpuPct comes from own /proc deltas, not app.getAppMetrics (F3) [clause: electron cpu source]:');
{
  const w = freshArm();
  await sampleTick(w.deps()); // baseline
  w.now += 60_000;
  w.procs.get(999).cpuTicks += 3000; // 30 s of CPU over 60 s → 50 % of one core
  const line = await sampleTick(w.deps());
  check('electron cpuPct === 50 (derived), not the 999 the metric reported', line.electron[0].cpuPct === 50, `${line.electron[0].cpuPct}`);
}

// ── A11: F4 — ≤7 days / ≤50 MB on disk, by SAMPLE age, through the real append ──
console.log('\nA11 — retention is enforced by sample AGE on the active file and the .1 backup (F4) [clause: age rotate + backup drop]:');
{
  __resetResourceMonitorForTest();
  fs.rmSync(path.join(HOME, 'logs'), { recursive: true, force: true });
  check('module exports appendResourceLogLine (the bounded append)', typeof M.appendResourceLogLine === 'function');
  if (typeof M.appendResourceLogLine === 'function') {
    const DAY = 86_400_000;
    const T = 1_700_000_000_000;
    const mk = (at) => ({ t: new Date(at).toISOString(), at, totals: { cpuCores: 1, memTotalBytes: 1, memUsedBytes: 1 }, electron: [], sessions: [] });
    const ats = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l).at) : []);
    const oldest = (now) => Math.max(0, ...[...ats(resourcesLogPath()), ...ats(`${resourcesLogPath()}.1`)].map((a) => now - a));
    for (const [label, dt] of [['t+0', 0], ['t+1d', 1 * DAY], ['t+3.6d', 3.6 * DAY], ['t+7.05d', 7.05 * DAY], ['t+7.3d', 7.3 * DAY]]) {
      M.appendResourceLogLine(mk(T + dt));
      check(`${label}: no sample older than 7 days remains on disk`, oldest(T + dt) <= 7 * DAY, `oldest=${(oldest(T + dt) / DAY).toFixed(2)}d`);
    }
    check('t+7.3d: active + .1 both exist (rotation happened)', fs.existsSync(resourcesLogPath()) && fs.existsSync(`${resourcesLogPath()}.1`));
  }
}

try {
  fs.rmSync(HOME, { recursive: true, force: true });
} catch {
  /* fine */
}
console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} — ${failures} failing check(s)`);
process.exit(failures === 0 ? 0 : 1);
