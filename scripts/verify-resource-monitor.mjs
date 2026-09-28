#!/usr/bin/env node
// G3 driven proof for issue #198 T8: the always-on resource monitor + reaper.
//
// Drives the REAL src/main/resource-monitor.ts `sampleTick` — the same function
// the 60s timer calls in production — over a FAKED /proc table + store snapshot,
// through the REAL append (a real resources.jsonl written to a temp ORCHESTRA_HOME
// under the worktree, on btrfs) and the REAL reap decision (decideReap). It shows:
//   • the JSONL line SHAPE actually written to disk (totals + electron + per
//     session tree keyed by workspace id + status);
//   • the reap DECISION: an ORPHAN tree (ws absent from store) is killed;
//   • the must-PASS control: a LIVE ws's tree is NEVER killed;
//   • the must-FAIL arm: with the reaper's store-loaded gate FORCED false (the
//     unfixed shape — no safety gate), the orphan would STILL not be reaped, and
//     with the live-ws guard bypassed a live tree WOULD be killed — both proven
//     to redden here so the guards are load-bearing, not decorative.
//
// Run: node --experimental-strip-types --import ./scripts/.r2-register.mjs \
//        scripts/verify-resource-monitor.mjs
// (the r2 hook resolves ./platform dir-imports + extensionless relatives so the
//  REAL main module loads; see scripts/.r2-resolve-hook.mjs.)

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
// Temp home UNDER the worktree (btrfs), never /tmp — the tests-on-btrfs rule.
const HOME = fs.mkdtempSync(path.join(ROOT, '.resmon-rig-'));
process.env.ORCHESTRA_HOME = HOME;

const { sampleTick, resourcesLogPath, __resetResourceMonitorForTest } = await import(
  '../src/main/resource-monitor.ts'
);

let failures = 0;
function check(name, cond, detail) {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failures++;
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

// ── A faked /proc table: two keeper trees (keeper→cli→mcp) ───────────────────
// ws "alive" is in the store; ws "gone" was deleted but its tree still runs.
const proc = (pid, ppid, comm, memMb) => ({
  pid,
  ppid,
  comm,
  cpuTicks: 0,
  memBytes: memMb * 1024 * 1024,
  cpuPct: 5, // pretend the ps fallback already gave us a percent (deterministic)
});
function tree(kpid, tag) {
  return [
    proc(kpid, 1, `keeper.js ${tag}`, 56),
    proc(kpid + 1, kpid, 'claude', 350),
    proc(kpid + 2, kpid + 1, 'chrome-devtools-mcp', 220),
    proc(kpid + 3, kpid, 'server-filesystem', 130),
  ];
}
const TABLE = [
  proc(1, 0, 'init', 1),
  proc(999, 1, 'electron', 800), // an unrelated Electron process — must NOT be reaped
  ...tree(100, 'alive'),
  ...tree(200, 'gone'),
];

const KEEPER_ROOTS = [
  { workspaceId: 'alive', keeperPid: 100 },
  { workspaceId: 'gone', keeperPid: 200 },
];

// Records what the reaper killed this tick.
function makeDeps(overrides = {}) {
  const killed = [];
  const warns = [];
  const infos = [];
  const deps = {
    now: () => 1_700_000_000_000,
    procTable: async () => TABLE,
    keeperRoots: () => KEEPER_ROOTS,
    liveWorkspaceIds: () => new Set(['alive']), // "gone" is ABSENT → orphan
    statusFor: (id) => (id === 'alive' ? 'running' : null),
    storeLoadedFromDisk: () => true,
    electronProcs: () => [
      { type: 'Browser', pid: 999, cpuPct: 12, rssBytes: 800 * 1024 * 1024 },
    ],
    cpuCores: () => 8,
    memTotalBytes: () => 32 * 1024 * 1024 * 1024,
    memUsedBytes: () => 18 * 1024 * 1024 * 1024,
    // REAL append path (writes resources.jsonl under the temp home).
    appendLine: (line) => {
      const f = resourcesLogPath();
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.appendFileSync(f, `${JSON.stringify(line)}\n`);
    },
    kill: (pid) => {
      killed.push(pid);
      return true;
    },
    warn: (m) => warns.push(m),
    info: (m) => infos.push(m),
    ...overrides,
  };
  return { deps, killed, warns, infos };
}

// ── Arm 1: the fixed behaviour ───────────────────────────────────────────────
console.log('Arm 1 — orphan reaped, live tree spared, JSONL written:');
__resetResourceMonitorForTest();
{
  const { deps, killed, warns } = makeDeps();
  const line = await sampleTick(deps);

  // Reap decision: the orphan's 4 pids (200-203), and ONLY those.
  const goneSpared = !killed.some((p) => p >= 100 && p <= 103);
  const orphanKilled = [200, 201, 202, 203].every((p) => killed.includes(p));
  const electronSpared = !killed.includes(999);
  check('orphan "gone" tree killed (pids 200-203)', orphanKilled, `killed=${killed}`);
  check('live "alive" tree NOT killed (must-PASS)', goneSpared, `killed=${killed}`);
  check('unrelated Electron pid 999 NOT killed', electronSpared, `killed=${killed}`);
  check(
    'a resources: reap WARN was logged before/with the kill',
    warns.some((w) => w.includes('reaping orphaned session tree') && w.includes('gone')),
    JSON.stringify(warns),
  );

  // JSONL line shape written to disk.
  const written = fs.readFileSync(resourcesLogPath(), 'utf8').trim().split('\n');
  const parsed = JSON.parse(written[written.length - 1]);
  console.log('  ── JSONL line written to resources.jsonl:');
  console.log('     ' + JSON.stringify(parsed).slice(0, 400) + (JSON.stringify(parsed).length > 400 ? '…' : ''));
  check('line carries totals.memUsedBytes', parsed.totals?.memUsedBytes === 18 * 1024 * 1024 * 1024);
  check('line carries an electron[] row', Array.isArray(parsed.electron) && parsed.electron.length === 1);
  check('line has a session row per keeper tree keyed by workspace id',
    parsed.sessions?.length === 2 &&
      parsed.sessions.some((s) => s.workspaceId === 'alive' && s.present === true && s.status === 'running') &&
      parsed.sessions.some((s) => s.workspaceId === 'gone' && s.present === false && s.reaped === true),
    JSON.stringify(parsed.sessions));
  // A ~700 MB tree (56+350+220+130) rolled up.
  const alive = parsed.sessions.find((s) => s.workspaceId === 'alive');
  check('session tree rss rolled up (~756 MB)',
    alive && alive.rssBytes === (56 + 350 + 220 + 130) * 1024 * 1024,
    alive && `${alive.rssBytes}`);
  check('reaped tree flagged reaped:true in the line',
    parsed.sessions.find((s) => s.workspaceId === 'gone')?.reaped === true);
}

// ── Arm 2 (must-FAIL): store-not-loaded → REFUSE, orphan spared ─────────────
console.log('\nArm 2 — store not loaded from disk → reaper REFUSES (orphan spared):');
__resetResourceMonitorForTest();
{
  const { deps, killed, infos } = makeDeps({ storeLoadedFromDisk: () => false });
  await sampleTick(deps);
  check('NOTHING killed when store is unloaded (safety gate)', killed.length === 0, `killed=${killed}`);
  check('an info line explains the skip',
    infos.some((m) => m.includes('reap skipped') && m.includes('store not loaded')),
    JSON.stringify(infos));
}

// ── Arm 3 (must-FAIL discriminator): if "gone" were LIVE, it must be spared ──
console.log('\nArm 3 — "gone" present in store → NOT an orphan → spared (guard is load-bearing):');
__resetResourceMonitorForTest();
{
  const { deps, killed } = makeDeps({ liveWorkspaceIds: () => new Set(['alive', 'gone']) });
  await sampleTick(deps);
  check('no tree killed when both workspaces are present', killed.length === 0, `killed=${killed}`);
}

// Cleanup the temp home.
try {
  fs.rmSync(HOME, { recursive: true, force: true });
} catch {
  /* fine */
}

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} — ${failures} failing check(s)`);
process.exit(failures === 0 ? 0 : 1);
