#!/usr/bin/env node
// Driven proof for #214 (field budget alarms). Drives the REAL src/main/resource-monitor.ts `sampleTick` (what the
// 60 s timer runs) wired to the REAL engine built by `createAppBudgetAlarms` (src/main/session-budget-alarms.ts),
// over a faked /proc world + REAL debug-log files in a scratch directory. Only the clock, the /proc table, the
// sessions dir and the alarm SINK are faked — the same seams `startResourceMonitor` fills with real ones.
//
// Run:  node --experimental-strip-types --import ./scripts/.r2-register.mjs scripts/e2e-field-budget-alarms.mjs [--real-cli]
//   --real-cli  also drives C1's session-budget harness (#208): the REAL agent-sdk → keeper → `claude` CLI against the
//               fake API, then points the engine at the debug log THAT session wrote (zero tokens, D6; ~30 s).
// Env: FBA_ARMS=a,b runs only those arms. Exit 0 = every arm as expected.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const REAL_CLI = process.argv.includes('--real-cli');
const ONLY = process.env.FBA_ARMS ? new Set(process.env.FBA_ARMS.split(',')) : null;

// D7: a scratch ORCHESTRA_HOME + scratch sessions dirs only; refuse anything that resolves into a live dir.
const BASE = path.join(os.homedir(), '.cache', 'field-alarms-rig');
fs.mkdirSync(BASE, { recursive: true });
const RIG = fs.mkdtempSync(path.join(BASE, 'run-'));
const LIVE = [path.join(os.homedir(), '.orchestra'), path.join(os.homedir(), '.claude'), process.env.CLAUDE_CONFIG_DIR].filter(Boolean).map((p) => path.resolve(p));
// C1's harness (#208) roots its own scratch runs under ~/.cache/session-budget (it asserts them scratch itself).
const BASES = [BASE, path.join(os.homedir(), '.cache', 'session-budget')];
function scratch(p) {
  const r = path.resolve(p);
  if (!BASES.some((b) => r.startsWith(`${b}${path.sep}`))) throw new Error(`refusing non-scratch path ${r}`);
  for (const l of LIVE) if (r === l || r.startsWith(`${l}${path.sep}`) || l.startsWith(`${r}${path.sep}`)) throw new Error(`refusing live dir ${r} (~ ${l})`);
  return r;
}
const HOME = scratch(path.join(RIG, 'orchestra-home'));
fs.mkdirSync(HOME, { recursive: true });
process.env.ORCHESTRA_HOME = HOME;

const M = await import('../src/main/resource-monitor.ts');
const SB = await import('../src/shared/session-budget.ts');
const SA = await import('../src/shared/session-budget-alarms.ts');
const { sampleTick, createAppBudgetAlarms, __resetResourceMonitorForTest } = M;
console.log(`module under test: ${path.relative(ROOT, fileURLToPath(new URL('../src/main/resource-monitor.ts', import.meta.url)))} + src/main/session-budget-alarms.ts`);
console.log(`budgets (imported from src/shared/session-budget.ts): field=${JSON.stringify(SB.SESSION_BUDGETS.field)} beforeFirstReply=${JSON.stringify(SB.SESSION_BUDGETS.beforeFirstReply)}`);
const PREFIX = 'session-budget-alarm:'; // the grep contract, spelled out on purpose: it must not follow the constant
if (SA.SESSION_BUDGET_ALARM_PREFIX !== PREFIX) { console.log(`  ✗ SESSION_BUDGET_ALARM_PREFIX is ${SA.SESSION_BUDGET_ALARM_PREFIX}, the contract is ${PREFIX}`); process.exitCode = 1; }
const MB = 1024 * 1024;
const FIX = path.join(ROOT, 'scripts', 'fixtures', 'session-debug-logs');
const fixture = (n) => fs.readFileSync(path.join(FIX, n), 'utf8');
const nameFor = (ws, atMs) => `${ws}__${new Date(atMs).toISOString().replace(/[:.]/g, '-')}.log`;

let failures = 0;
const results = [];
function check(name, cond, detail) {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.log(`  ✗ ${name}${detail !== undefined ? ` — ${detail}` : ''}`); }
}

// ── the world: sessions' process trees, a clock, a sessions dir, an alarm sink ─────────
class World {
  constructor(tag) {
    this.now = Date.now();
    this.sessions = new Map(); // ws -> { keeperPid, procs, rssMb, status }
    this.bg = new Set(); // ws ids with live background work (the engine's backgroundWork seam)
    this.alarms = [];
    this.warns = [];
    this.signals = [];
    this.dir = scratch(path.join(RIG, `sessions-${tag}`));
    fs.mkdirSync(this.dir, { recursive: true });
    this.nextPid = 1000;
  }
  set(ws, procs, rssMb, status = 'idle') {
    const s = this.sessions.get(ws) ?? { keeperPid: (this.nextPid += 100) };
    this.sessions.set(ws, { ...s, procs, rssMb, status });
  }
  drop(ws) { this.sessions.delete(ws); }
  table() {
    const out = [];
    for (const [, s] of this.sessions) {
      const each = Math.floor((s.rssMb * MB) / s.procs);
      for (let i = 0; i < s.procs; i++) {
        out.push({ pid: s.keeperPid + i, ppid: i === 0 ? 1 : s.keeperPid, comm: i === 0 ? 'keeper.js' : 'child', cpuTicks: 0, memBytes: each, cpuPct: null, startTicks: 1000 + s.keeperPid + i });
      }
    }
    return out;
  }
  engine(over = {}) {
    return createAppBudgetAlarms({ now: () => this.now, sessionsDir: () => this.dir, warn: (m) => this.alarms.push(m), label: (ws) => `label-${ws}`, backgroundWork: (ws) => this.bg.has(ws), ...over });
  }
  deps(engine) {
    const w = this;
    return {
      now: () => w.now,
      procTable: async () => w.table(),
      keeperRoots: () => [...w.sessions].map(([workspaceId, s]) => ({ workspaceId, keeperPid: s.keeperPid })),
      keeperProcs: () => [],
      trackedKeeperPid: () => null,
      liveWorkspaceIds: () => new Set(w.sessions.keys()),
      statusFor: (ws) => w.sessions.get(ws)?.status ?? null,
      storeLoadedFromDisk: () => true,
      electronProcs: () => [],
      cpuCores: () => 8,
      memTotalBytes: () => 32 * 1024 ** 3,
      memUsedBytes: () => 18 * 1024 ** 3,
      appendLine: M.appendResourceLogLine,
      readProcStat: () => null,
      readCmdline: () => null,
      signal: (pid, sig) => { w.signals.push({ pid, sig }); return false; },
      sleep: async () => {},
      warn: (m) => w.warns.push(m),
      info: () => {},
      ...(engine ? { budgetAlarms: (line) => engine.tick(line) } : {}),
    };
  }
  /** One 60 s tick through the REAL sampleTick. `mut(w, i)` sets the world for tick i first. */
  async run(engine, ticks, mut) {
    const d = this.deps(engine);
    for (let i = 0; i < ticks; i++) {
      mut?.(this, i);
      await sampleTick(d);
      this.now += 60_000;
    }
  }
  seedLog(ws, text, ageMs = 5_000) {
    const name = nameFor(ws, this.now - ageMs);
    fs.writeFileSync(path.join(this.dir, name), text);
    return name;
  }
  /** A session's debug log with `stdio` stdio MCP servers (+1 http one, which has no process) connected. */
  mcpLog(ws, stdio = 1, ageMs = 5 * 60_000) {
    const at = new Date(this.now - ageMs).toISOString();
    const rows = Array.from({ length: stdio }, (_, i) => `${at} [DEBUG] MCP server "srv-${i}": Successfully connected (transport: stdio) in 9ms`);
    rows.push(`${at} [DEBUG] MCP server "remote-http": Successfully connected (transport: http) in 90ms`);
    return this.seedLog(ws, `${rows.join('\n')}\n`, ageMs);
  }
}
const P = SB.SESSION_BUDGETS.processes;
/** The oracle, written out separately from the module under test: what `processes` allows n stdio servers. */
const allowed = (n) => ({ procs: P.keeper + P.cli + P.mcpPerConfiguredServer * n + P.hook + P.other });
const lines = (w, id) => w.alarms.filter((m) => m.includes(id));

const arms = {
  // ── session tree: settled processes / memory / idle slope ───────────────────
  async tree_procs_once() {
    const w = new World('procs'); const e = w.engine(); const d = w.deps(e);
    const F = SB.SESSION_BUDGETS.field; const lim = allowed(1);
    w.mcpLog('ws-P', 1);
    const counts = [];
    for (let i = 0; i < 22; i++) { w.set('ws-P', lim.procs + 7, 300); await sampleTick(d); w.now += 60_000; counts.push(w.alarms.length); }
    check(`no alarm before the excess has been settled for ${F.settledSamples} samples`, counts.slice(0, F.settledSamples - 1).every((n) => n === 0), JSON.stringify(counts));
    check('exactly ONE alarm at the sustained tick and none after it (22 ticks)', w.alarms.length === 1 && counts[F.settledSamples - 1] === 1 && counts[21] === 1, JSON.stringify({ counts, alarms: w.alarms }));
    const a = w.alarms[0] ?? '';
    check('the line has the stable prefix and names session, budget, limit and measured value', a.startsWith(`${PREFIX} session ws-P (label-ws-P) — BUDGET BROKEN session.processes.atEnd.total: allowed at most ${lim.procs}, saw ${lim.procs + 7}`), a);
    check('the limit was derived for the session\'s ONE stdio MCP server (the http one is not a process)', e.mcpStdio()['ws-P'] === 1, JSON.stringify(e.mcpStdio()));
  },
  async tree_memory_not_judged() {
    const w = new World('mem'); const e = w.engine();
    const lim = allowed(1);
    w.mcpLog('ws-M', 1); w.mcpLog('ws-bad', 1);
    await w.run(e, 25, (x) => { x.set('ws-M', lim.procs, 4000); x.set('ws-bad', lim.procs + 4, 300); });
    check('exactly ONE alarm (the process twin) — a flat 4 GB settled skeleton tree is not a breach: tree MEMORY level is deliberately not judged in the field', w.alarms.length === 1 && w.alarms[0].includes('ws-bad') && !w.alarms.some((m) => m.includes('memoryMB')), JSON.stringify(w.alarms));
  },
  async tree_slope_once() {
    const w = new World('slope'); const e = w.engine();
    const lim = allowed(1); const limitMB = SB.SESSION_BUDGETS.field.maxIdleRssSlopeBytesPerMin / MB;
    w.mcpLog('ws-S', 1);
    // 1.5× the slope budget from 50 MB: crosses neither the process nor the memory budget in 32 ticks.
    await w.run(e, 32, (x, i) => x.set('ws-S', lim.procs, 50 + i * 1.5 * limitMB));
    const slope = lines(w, 'session.field.settledRssSlopeBytesPerMin');
    check('exactly ONE slope alarm and no other alarm for the settled leak-shaped ramp', w.alarms.length === 1 && slope.length === 1, JSON.stringify(w.alarms));
    check('it reports the measured settled slope in MB/min', new RegExp(`grew ${Math.round(1.5 * limitMB)} MB/min`).test(slope[0] ?? ''), slope[0]);
  },
  async tree_running_silent() {
    const w = new World('running'); const e = w.engine();
    const big = allowed(1).procs + 40;
    w.mcpLog('ws-run', 1); w.mcpLog('ws-bad', 1);
    await w.run(e, 40, (x, i) => { x.set('ws-run', big, 3000, 'running'); x.set('ws-run-ramp', allowed(1).procs, 100 + i * 60, 'running'); x.set('ws-bad', big, 300); });
    check('exactly ONE alarm (the idle twin) — a RUNNING session over every limit, and one ramping 60 MB/min, are silent', w.alarms.length === 1 && w.alarms[0].includes('ws-bad'), JSON.stringify(w.alarms));
  },
  async tree_background_silent() {
    const w = new World('bg'); const e = w.engine();
    const big = allowed(1).procs + 40;
    w.mcpLog('ws-bg', 1); w.mcpLog('ws-bad', 1);
    w.bg.add('ws-bg'); w.bg.add('ws-bg-ramp');
    await w.run(e, 40, (x, i) => { x.set('ws-bg', big, 3000); x.set('ws-bg-ramp', allowed(1).procs, 100 + i * 4); x.set('ws-bad', big, 300); });
    check('exactly ONE alarm (the twin without background work) — idle with live background work is busy, not leaked', w.alarms.length === 1 && w.alarms[0].includes('ws-bad'), JSON.stringify(w.alarms));
    // The exclusion is LIVE state, not a flag on the session: once the background work ends, the same tree alarms.
    w.bg.delete('ws-bg');
    await w.run(e, 20, (x) => x.set('ws-bg', big, 3000));
    const own = w.alarms.filter((m) => m.includes('session ws-bg ('));
    check('when the background work ends and the tree stays over budget it alarms once, never for the ramp still in background', own.length === 1 && own[0].includes('atEnd.total') && !w.alarms.some((m) => m.includes('session ws-bg-ramp')), JSON.stringify(w.alarms));
  },
  async tree_background_unknown_silent() {
    const w = new World('bgthrow'); const e = w.engine({ backgroundWork: () => { throw new Error('sdk registry gone'); } });
    const big = allowed(1).procs + 40;
    w.mcpLog('ws-x', 1);
    await w.run(e, 20, (x) => x.set('ws-x', big, 300));
    check('when the background-work state cannot be read the tree reads as busy: NO alarm (fail toward silence), no engine error line', w.alarms.length === 0, JSON.stringify(w.alarms));
  },
  async tree_unknown_n_unjudged() {
    const w = new World('unk'); const e = w.engine();
    const big = allowed(1).procs + 40;
    w.mcpLog('ws-bad', 1); // ws-nolog has NO debug log ⇒ its stdio-server count is unknown
    await w.run(e, 20, (x) => { x.set('ws-nolog', big, 3000); x.set('ws-bad', big, 300); });
    check('exactly ONE alarm (the twin whose server count is known) — an unknown count is never turned into a guessed limit', w.alarms.length === 1 && w.alarms[0].includes('ws-bad'), JSON.stringify(w.alarms));
    check('the engine reports the unknown count as null', e.mcpStdio()['ws-nolog'] === null && e.mcpStdio()['ws-bad'] === 1, JSON.stringify(e.mcpStdio()));
  },
  async mcp_count_settles() {
    const w = new World('settle'); const e = w.engine(); const d = w.deps(e);
    const name = w.mcpLog('ws-Y', 1, 30_000); // a log 30 s old: MCP servers may still be connecting
    w.set('ws-Y', 3, 200);
    await sampleTick(d); w.now += 60_000;
    check('a session younger than the settle age has an UNKNOWN server count (not 1, and not cached)', e.mcpStdio()['ws-Y'] === null, JSON.stringify(e.mcpStdio()));
    fs.appendFileSync(path.join(w.dir, name), `${new Date(w.now).toISOString()} [DEBUG] MCP server "srv-late": Successfully connected (transport: stdio) in 3s\n`);
    await sampleTick(d); w.now += 60_000; // 90 s → still young
    await sampleTick(d); w.now += 60_000; // 150 s → settled
    check('once settled the count includes the server that connected late (2), so nothing was cached early', e.mcpStdio()['ws-Y'] === 2, JSON.stringify(e.mcpStdio()));
  },
  async tree_normal_silent() {
    const w = new World('normal'); const e = w.engine();
    // Healthy shapes: the idle skeleton, a heavy-but-within-budget 4-server tree, a running fork burst, a slow idle creep.
    // Plus ONE breaching twin — the positive control in the same run.
    const l1 = allowed(1); const l4 = allowed(4);
    w.mcpLog('ws-idle', 1); w.mcpLog('ws-heavy', 4); w.mcpLog('ws-burst', 1); w.mcpLog('ws-creep', 1); w.mcpLog('ws-bad', 1);
    await w.run(e, 45, (x, i) => {
      x.set('ws-idle', l1.procs, 106);
      x.set('ws-heavy', l4.procs, 900);
      x.set('ws-burst', i === 17 ? 94 : l1.procs, 200, i === 17 ? 'running' : 'idle');
      x.set('ws-creep', l1.procs, 150 + i * 3);
      x.set('ws-bad', l1.procs + 5, 300);
    });
    check('exactly ONE alarm in total (the breaching twin) — every healthy shape is silent', w.alarms.length === 1 && w.alarms[0].includes('ws-bad'), JSON.stringify(w.alarms));
  },
  async tree_rearm_per_breach() {
    const w = new World('rearm'); const e = w.engine();
    const F = SB.SESSION_BUDGETS.field; const lim = allowed(1);
    const big = lim.procs + 7; const N = F.settledSamples + 3;
    w.mcpLog('ws-A', 1);
    await w.run(e, N, (x) => x.set('ws-A', big, 300));
    check('first breach alarms once', w.alarms.length === 1, JSON.stringify(w.alarms));
    await w.run(e, 1, (x) => x.set('ws-A', lim.procs, 300));
    await w.run(e, N, (x) => x.set('ws-A', big, 300));
    check('after the tree recovered, a NEW breach alarms once more (2 total, one per breach)', w.alarms.length === 2, JSON.stringify(w.alarms));
    await w.run(e, 2, (x) => x.drop('ws-A'));
    check('a vanished tree leaves no breach in the ledger (state hygiene)', e.alarmOwners().length === 0, JSON.stringify(e.alarmOwners()));
    await w.run(e, N, (x) => x.set('ws-A', big, 300));
    check('a tree that vanished and came back breaching alarms again (3 total)', w.alarms.length === 3, JSON.stringify(w.alarms));
  },
  // ── requests per session start, from real debug-log files ───────────────────
  async log_burst_once() {
    const w = new World('burst'); const e = w.engine();
    const name = w.seedLog('ws-L', fixture('real-count-tokens-burst.txt'));
    await w.run(e, 5);
    check('exactly ONE alarm across 5 ticks over the real #176 burst', w.alarms.length === 1, JSON.stringify(w.alarms));
    const a = w.alarms[0] ?? '';
    check('it names the session, the budget, the measured 52 and the log file', a.startsWith(`${PREFIX} session ws-L (label-ws-L) — BUDGET BROKEN session.beforeFirstReply.countTokensRequests: allowed at most ${SB.SESSION_BUDGETS.beforeFirstReply.countTokensRequests}, saw 52`) && a.includes(name), a);
    fs.appendFileSync(path.join(w.dir, name), fixture('real-count-tokens-burst.txt'));
    await w.run(e, 2);
    check('lines appended after the window closed re-alarm nothing', w.alarms.length === 1, JSON.stringify(w.alarms));
    w.seedLog('ws-L', fixture('real-count-tokens-burst.txt'), 1_000);
    await w.run(e, 2);
    check('a RESTART of the session (a new debug log) that breaks the budget alarms again (2 total)', w.alarms.length === 2, JSON.stringify(w.alarms));
  },
  async log_normal_silent() {
    const w = new World('lognormal'); const e = w.engine();
    w.seedLog('ws-N1', fixture('real-title-and-opening-turn.txt'));
    w.seedLog('ws-N2', fixture('real-errored-opening-request.txt') + `${new Date(w.now).toISOString()} [DEBUG] [API REQUEST] /v1/messages x-client-request-id=retry-x source=sdk\n${new Date(w.now + 900).toISOString()} [DEBUG] [API:timing] first byte after 900ms\n`);
    w.seedLog('ws-BAD', fixture('real-one-count-tokens-before-reply.txt'));
    await w.run(e, 4);
    check('exactly ONE alarm — the real one-count_tokens start; the real normal start and the 429-then-retry start are silent', w.alarms.length === 1 && w.alarms[0].includes('ws-BAD') && /saw 1\b/.test(w.alarms[0]), JSON.stringify(w.alarms));
  },
  async log_partial_then_complete() {
    const w = new World('partial'); const e = w.engine();
    const all = fixture('real-count-tokens-burst.txt').split('\n').filter(Boolean);
    const name = w.seedLog('ws-Q', `${all.slice(0, 26).join('\n')}\n${all[26].slice(0, 40)}`); // 26 whole lines + a torn one
    await w.run(e, 1);
    check('a torn last line is not parsed; the breach is reported from the whole lines, flagged as a lower bound', w.alarms.length === 1 && /saw 26/.test(w.alarms[0]) && /window still open/.test(w.alarms[0]), JSON.stringify(w.alarms));
    fs.writeFileSync(path.join(w.dir, name), `${all.join('\n')}\n`);
    await w.run(e, 3);
    check('the rest of the burst + first reply arrives: still ONE alarm for this breach', w.alarms.length === 1, JSON.stringify(w.alarms));
    const c = e.logCounts()[name];
    check('the torn line was re-read whole: the window ends with the EXACT count (52 count_tokens, 1 model, closed)', c?.count_tokens === 52 && c?.model === 1 && c?.closed === true, JSON.stringify(c));
  },
  async log_old_ignored() {
    const w = new World('old'); const e = w.engine();
    w.seedLog('ws-OLD', fixture('real-count-tokens-burst.txt'), 2 * 60 * 60 * 1000);
    w.seedLog('ws-MID', fixture('real-count-tokens-burst.txt'), 20 * 60 * 1000); // past the 10 min lookback, inside the 30 min give-up age
    await w.run(e, 3);
    check('a capture older than the lookback is never opened (0 alarms, 0 tracked) — at 2 h AND at 20 min', w.alarms.length === 0 && e.trackedLogs().length === 0, JSON.stringify({ a: w.alarms, t: e.trackedLogs() }));
    w.seedLog('ws-NEW', fixture('real-count-tokens-burst.txt'), 5_000);
    await w.run(e, 1);
    check('control: the identical content with a fresh spawn time alarms', w.alarms.length === 1 && w.alarms[0].includes('ws-NEW'), JSON.stringify(w.alarms));
  },
  async tree_orphan_not_judged() {
    const w = new World('orphan'); const e = w.engine();
    const big = allowed(1).procs + 7;
    w.mcpLog('ws-orphan', 1); w.mcpLog('ws-live', 1);
    const d = w.deps(e);
    d.liveWorkspaceIds = () => new Set([...w.sessions.keys()].filter((k) => k !== 'ws-orphan')); // absent from the store
    for (let i = 0; i < 20; i++) {
      w.set('ws-orphan', big, 300);
      w.set('ws-live', big, 300);
      await sampleTick(d); w.now += 60_000;
    }
    check('an orphan tree (workspace absent from the store) is the reaper\'s business, never alarmed; the live twin alarms once', w.alarms.length === 1 && w.alarms[0].includes('ws-live') && !w.alarms.some((m) => m.includes('ws-orphan')), JSON.stringify(w.alarms));
  },
  // The APP's own backgroundWork default (createAppBudgetAlarms without the override): busy-or-unknown reads true.
  async default_background_signal() {
    const { registerSdkDelivery } = await import('../src/main/sdk-delivery.ts');
    const { initPlatform } = await import('../src/main/platform/index.ts');
    initPlatform({
      kind: 'headless-field-alarms-rig',
      broadcast: () => {}, broadcastPtyData: () => {}, canBroadcast: () => true, isFocused: () => false, hasAttachedUi: () => false,
      notify: () => {}, openExternal: () => {}, showItemInFolder: () => {}, openPath: () => {}, openAccountLoginUrl: () => {}, closeAccountLogin: () => {},
      getUserDataDir: () => HOME, getLogsDir: () => `${HOME}/logs`, getAppVersion: () => '0.0.0-field-alarms-rig',
      getAppMetrics: () => [], isEncryptionAvailable: () => false, encryptString: (x) => x, decryptString: (x) => x,
    });
    const { store } = await import('../src/main/store.ts');
    await store.load?.();
    const live = new Set(); const bgTasks = new Set();
    registerSdkDelivery({ hasSession: (id) => live.has(id), hasBackgroundTask: (id) => bgTasks.has(id) });
    const ids = { unattached: 'ws-d-unattached', attached: 'ws-d-attached', bgtask: 'ws-d-bgtask', looping: 'ws-d-looping' };
    for (const id of Object.values(ids)) await store.upsertWorkspace({ id, name: id, kind: 'scratch', repoPath: '', worktreePath: HOME, status: 'idle', createdAt: Date.now(), hasInput: true, ...(id === ids.looping ? { loopingSince: Date.now() } : {}) });
    live.add(ids.attached); live.add(ids.bgtask); live.add(ids.looping); bgTasks.add(ids.bgtask);
    const w = new World('defbg');
    const e = createAppBudgetAlarms({ now: () => w.now, sessionsDir: () => w.dir, warn: (m) => w.alarms.push(m), label: () => null }); // NO backgroundWork override
    const big = allowed(1).procs + 7;
    for (const id of Object.values(ids)) w.mcpLog(id, 1);
    await w.run(e, 20, (x) => { for (const id of Object.values(ids)) x.set(id, big, 300); });
    const alarmed = Object.entries(ids).filter(([, id]) => w.alarms.some((m) => m.includes(`session ${id} `))).map(([k]) => k);
    check('the app default: only the ATTACHED session with no background task and no armed loop alarms', JSON.stringify(alarmed) === JSON.stringify(['attached']) && w.alarms.length === 1, JSON.stringify({ alarmed, alarms: w.alarms }));
  },
  async wiring() {
    const w = new World('wiring');
    w.seedLog('ws-W', fixture('real-count-tokens-burst.txt'));
    w.mcpLog('ws-W', 1);
    await w.run(null, 20, (x) => x.set('ws-W', allowed(1).procs + 10, 300));
    check('without the budgetAlarms seam wired, the same breaches alarm NOTHING (alarms come only through sampleTick → engine)', w.alarms.length === 0 && !w.warns.some((m) => m.includes(PREFIX)), JSON.stringify({ a: w.alarms, w: w.warns }));
    const src = fs.readFileSync(path.join(ROOT, 'src/main/resource-monitor.ts'), 'utf8');
    check('startResourceMonitor installs the engine (createAppBudgetAlarms + budgetAlarms) on the timer\'s deps', /budgetEngine = createAppBudgetAlarms\(\)/.test(src) && /budgetAlarms: \(line\) => budgetEngine\?\.tick\(line\)/.test(src) && /sampleTick\(appDeps\)/.test(src));
  },
};

if (REAL_CLI) {
  arms.real_cli = async function realCli() {
    const { ensureBuilt, runSessionArm, detectContainment } = await import(pathToFileURL(path.join(HERE, 'session-budget', 'harness.mjs')).href);
    ensureBuilt(ROOT);
    const containment = detectContainment();
    for (const [arm, mutant] of [['normal', null], ['boot-context-read', 'boot-context-read']]) {
      const res = await runSessionArm({ repo: ROOT, arm: `fba-${arm}`, mutant, containment, keep: true });
      if (res.error || !res.report) { check(`${arm}: the harness run itself completed`, false, res.error); continue; }
      const dir = path.join(res.root, 'orchestra', 'logs', 'sessions');
      const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.log')) : [];
      check(`${arm}: the REAL session wrote a per-session debug log (${files.length} file)`, files.length === 1, JSON.stringify(files));
      const alarms = [];
      const engine = createAppBudgetAlarms({ now: () => Date.now() + 1000, sessionsDir: () => scratch(dir), warn: (m) => alarms.push(m), label: () => null });
      const line = { t: new Date().toISOString(), at: Date.now(), totals: { cpuCores: 1, memTotalBytes: 1, memUsedBytes: null }, electron: [], sessions: [] };
      engine.tick(line); engine.tick(line); engine.tick(line);
      const apiSide = res.report.requests.beforeFirstReply;
      if (arm === 'normal') {
        check('normal: the real CLI log is silent (API side saw main=1, count_tokens=0, its one haiku title call)', alarms.length === 0 && apiSide.main === 1 && apiSide.count_tokens === 0 && Object.keys(apiSide.side ?? {}).length === 1, JSON.stringify({ alarms, apiSide }));
      } else {
        const m = alarms.map((a) => /saw (\d+)/.exec(a)?.[1]).map(Number);
        check('boot-context-read: exactly ONE alarm across 3 ticks, naming ws-sb and the count_tokens budget', alarms.length === 1 && alarms[0].includes('session ws-sb') && alarms[0].includes('session.beforeFirstReply.countTokensRequests'), JSON.stringify(alarms));
        check(`boot-context-read: the log-derived count equals the fake API's own count (${apiSide.count_tokens})`, m[0] === apiSide.count_tokens && apiSide.count_tokens >= 50, JSON.stringify({ m, apiSide }));
      }
      fs.rmSync(res.root, { recursive: true, force: true });
    }
  };
}

const wanted = Object.keys(arms).filter((n) => !ONLY || ONLY.has(n));
for (const name of wanted) {
  __resetResourceMonitorForTest();
  fs.rmSync(path.join(HOME, 'logs'), { recursive: true, force: true });
  console.log(`== arm ${name}`);
  const before = failures;
  try { await arms[name](); } catch (e) { failures++; console.log(`  ✗ arm threw — ${e?.stack ?? e}`); }
  results.push([name, failures === before]);
}
fs.rmSync(RIG, { recursive: true, force: true });
console.log(`arms: ${results.map(([n, ok]) => `${n}=${ok ? 'ok' : 'FAIL'}`).join(' ')}`);
console.log(failures === 0 && wanted.length > 0 ? 'FIELD-BUDGET-ALARMS: PASS' : `FIELD-BUDGET-ALARMS: FAIL (${failures})`);
process.exit(failures === 0 && wanted.length > 0 ? 0 : 1);
