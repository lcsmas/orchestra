#!/usr/bin/env node
// #211 rig — the CLI-version budget re-run, driven through the PRODUCTION wiring (src/main/cli-budget-runner.ts:
// real `claude` lookup + `--version` probe, real record + locks, the real BUNDLED runner dist-electron/
// session-budget.js, the real harness at nice 19 under bwrap, the real platform.notify seam) against the REAL
// `claude` and a local FAKE API (zero tokens, D6). The only stand-in is a `claude` WRAPPER on PATH that (a) reports
// the version in a file, (b) counts every session start (the independent "how many runs" counter), (c) can model a
// CLI update that adds startup calls (`inflate`), hangs (`hang`) or is slow (`slow`), then execs the real binary.
//
//   node --experimental-strip-types --import scripts/.r2-register.mjs scripts/e2e-cli-version-budget.mjs [--arm <name>]
//
// Needs dist-electron/{keeper,session-budget}.js (e2e-cli-version-budget.sh rebuilds both). Last line: CLI-VERSION-BUDGET-RIG: PASS|FAIL.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { execFileSync, spawnSync } from 'node:child_process';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const WANT = args.includes('--arm') ? args[args.indexOf('--arm') + 1] : 'all';
const RESULT_FILE = process.env.RIG_RESULT_FILE ?? null;

// The production wiring resolves the runner bundle next to main.js (`__dirname` = dist-electron in the built app).
globalThis.__dirname = path.join(REPO, 'dist-electron');
for (const f of ['session-budget.js', 'keeper.js']) {
  if (!fs.existsSync(path.join(globalThis.__dirname, f))) { process.stderr.write(`ABORT: dist-electron/${f} missing — run scripts/e2e-cli-version-budget.sh (it builds both)\n`); process.exit(2); }
}
const realClaude = execFileSync('sh', ['-c', 'command -v claude'], { encoding: 'utf8' }).trim();
if (!realClaude) { process.stderr.write('ABORT: no real `claude` on PATH\n'); process.exit(2); }
const REAL_CLAUDE = fs.realpathSync(realClaude);

const RIG_BASE = path.join(os.homedir(), '.cache', 'cli-budget-rig');
fs.mkdirSync(RIG_BASE, { recursive: true });
const say = (m) => process.stderr.write(`${m}\n`);
const notices = [];
const { initPlatform } = await import(`${REPO}/src/main/platform/index.ts`);
const sc = path.join(RIG_BASE, `platform-${process.pid}`);
fs.mkdirSync(sc, { recursive: true });
process.env.ORCHESTRA_HOME = path.join(sc, 'orchestra-logs'); // the logger's sink dir; each arm swaps in its own home afterwards
initPlatform({
  kind: 'electron', broadcast() {}, broadcastPtyData: () => true, canBroadcast: () => true, isFocused: () => false, hasAttachedUi: () => false,
  notify: (n) => notices.push(n), openExternal: async () => {}, showItemInFolder() {}, openPath: async () => '', openAccountLoginUrl() {}, closeAccountLogin() {},
  getUserDataDir: () => sc, getLogsDir: () => path.join(sc, 'logs'), getAppVersion: () => '0.0.0-rig', getAppMetrics: () => [],
  isEncryptionAvailable: () => false, encryptString: (s) => Buffer.from(s), decryptString: (b) => String(b),
});
const { initLogger } = await import(`${REPO}/src/main/logger.ts`);
initLogger(); // the REAL logger, file sink: <sc>/orchestra-logs/logs/orchestra.log
const LOG_FILE = path.join(sc, 'orchestra-logs', 'logs', 'orchestra.log');
const logText = () => { try { return fs.readFileSync(LOG_FILE, 'utf8'); } catch { return ''; } };
const mod = await import(`${REPO}/src/main/cli-budget-rerun.ts`);
const runner = await import(`${REPO}/src/main/cli-budget-runner.ts`);
const lock = await import(`${REPO}/src/shared/budget-lock.ts`);

// ── the `claude` wrapper (scripts/session-budget/claude-shim.mjs) ────────────────────────────────────────────────
const shim = await import(`${REPO}/scripts/session-budget/claude-shim.mjs`);
const { makeShim, starts, setMode } = shim;
const setVersion = (dir, v) => shim.setVersion(dir, v, REAL_CLAUDE);

/** Live processes whose environment names one of THIS rig's harness scratch roots (identity from /proc, not a pattern on ps). */
function survivors() {
  const needle = `.cache/session-budget/cli-version-rerun-${process.pid}-`;
  const out = [];
  for (const n of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(n) || Number(n) === process.pid) continue;
    try { if (fs.readFileSync(`/proc/${n}/environ`, 'latin1').includes(needle)) out.push(Number(n)); } catch { /* gone / not ours */ }
  }
  return out;
}
/** Death is observed by EFFECT with a bounded wait: SIGKILL returns before the kernel has torn the tree down (under load a
 *  bare instant read raced it — 1 red in 3 runs at load 21). Returns the survivors left after up to `ms`. */
async function settled(ms = 5000) {
  const t0 = Date.now();
  while (survivors().length && Date.now() - t0 < ms) await sleep(50);
  return { alive: survivors(), waitedMs: Date.now() - t0 };
}
const scratchRoots = () => { try { return fs.readdirSync(path.join(os.homedir(), '.cache', 'session-budget')).filter((n) => n.startsWith(`cli-version-rerun-${process.pid}-`)); } catch { return []; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── arms ─────────────────────────────────────────────────────────────────────────────────────────────────────────
const results = [];
let failed = 0;
function check(arm, name, ok, detail = '') {
  results.push({ arm, name, ok: !!ok, detail });
  if (!ok) failed++;
  say(`${ok ? '  ok  ' : '  FAIL'} [${arm}] ${name}${detail ? ` — ${detail}` : ''}`);
}

const state = { dir: '', home: '', shim: '', prevPath: process.env.PATH, prevHome: process.env.ORCHESTRA_HOME };
function freshWorld(tag) {
  mod.__resetCliBudgetRerunForTest();
  notices.length = 0;
  state.dir = fs.mkdtempSync(path.join(RIG_BASE, `${tag}-`));
  state.home = path.join(state.dir, 'orchestra');
  state.shim = path.join(state.dir, 'shim');
  fs.mkdirSync(state.home, { recursive: true });
  makeShim(state.shim);
  process.env.ORCHESTRA_HOME = state.home;
  process.env.PATH = `${state.shim}:${state.prevPath}`;
}
// The machine gate (RAM / load) is unit-tested and has its own arm; every OTHER arm pins it open so a load spike from a
// sibling agent cannot turn a run into a `skip: load` (that is D7 doing its job, not what these arms measure).
const OPEN = () => ({ availableRamMB: 8192, load1: 1 });
const deps = (o = {}) => ({ ...runner.cliBudgetDeps(), resources: OPEN, ...o });
const rec = () => mod.readRecord(state.home);
const step = async (label, fn) => { say(`-- ${label}`); return fn(); };

const ARMS = {
  // D7 guard of the BUNDLE: it must refuse a non-scratch env before agent-sdk/store/logger load. The "live" dir here is a
  // SCRATCH dir declared live (`cfg.live`) — so if the guard goes missing (a mutant), the bundle boots against scratch and
  // the arm reddens WITHOUT ever touching a real ~/.claude* (a must-FAIL arm of a destructive guard must be unable to do the act).
  async guard() {
    freshWorld('guard');
    const A = 'guard';
    const bundle = path.join(REPO, 'dist-electron', 'session-budget.js');
    const root = path.join(state.dir, 'gd');
    const home = path.join(root, 'home');
    const orch = path.join(root, 'orchestra');
    const liveLike = path.join(root, 'livelike'); // beside HOME, not inside it: HOME must not be the clause that refuses
    fs.mkdirSync(liveLike, { recursive: true });
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(orch, { recursive: true });
    const sb = JSON.stringify({ root, arm: 'guard', live: [liveLike] });
    const launch = (env) => spawnSync(process.execPath, [bundle], { env: { PATH: process.env.PATH, HOME: home, SB_CONFIG: sb, ...env }, encoding: 'utf8', timeout: 25_000 });
    const refused = launch({ ORCHESTRA_HOME: orch, CLAUDE_CONFIG_DIR: liveLike });
    check(A, 'G1 a CLAUDE_CONFIG_DIR that is a live dir is REFUSED, naming the guard', refused.status !== 0 && /scratch-guard: REFUSED CLAUDE_CONFIG_DIR=.*resolves to\/into\/over the live dir/.test(refused.stderr), `rc=${refused.status} ${refused.stderr.split('\n').find((l) => /REFUSED/.test(l)) ?? refused.stderr.slice(0, 160)}`);
    check(A, 'G1 …before anything ran (no result line, no keeper installed)', !/"report"/.test(refused.stdout) && !fs.existsSync(path.join(orch, 'bin')), `${refused.stdout.slice(0, 80)} bin=${fs.existsSync(path.join(orch, 'bin'))}`);
    const unset = launch({ ORCHESTRA_HOME: orch });
    check(A, 'G2 an UNSET CLAUDE_CONFIG_DIR is refused (the launcher must pin it)', unset.status !== 0 && /REFUSED CLAUDE_CONFIG_DIR unset/.test(unset.stderr), `rc=${unset.status} ${unset.stderr.split('\n').find((l) => /REFUSED/.test(l)) ?? ''}`);
    const liveOrch = launch({ ORCHESTRA_HOME: liveLike, CLAUDE_CONFIG_DIR: path.join(home, '.claude') });
    check(A, 'G3 an ORCHESTRA_HOME that is a live dir is refused too', liveOrch.status !== 0 && /scratch-guard: REFUSED ORCHESTRA_HOME=/.test(liveOrch.stderr), `rc=${liveOrch.status} ${liveOrch.stderr.split('\n').find((l) => /REFUSED/.test(l)) ?? ''}`);
    const noLive = spawnSync(process.execPath, [bundle], { env: { PATH: process.env.PATH, HOME: home, ORCHESTRA_HOME: orch, CLAUDE_CONFIG_DIR: path.join(home, '.claude'), SB_CONFIG: JSON.stringify({ root, arm: 'guard' }) }, encoding: 'utf8', timeout: 25_000 });
    check(A, 'G5 a caller that hands over NO live-dir list is refused (the guard must not fail open)', noLive.status !== 0 && /REFUSED SB_CONFIG\.live missing\/empty/.test(noLive.stderr), `rc=${noLive.status} ${noLive.stderr.split('\n').find((l) => /REFUSED/.test(l)) ?? ''}`);
    const { reapScratchProcesses } = await import(`${REPO}/scripts/session-budget/harness.mjs`);
    reapScratchProcesses(root); // a red arm (guard gone) would have started a real session in scratch: never leave it running
    // The look-alike that must be ACCEPTED: the production launch env (scratch dirs pinned) through the real harness.
    setVersion(state.shim, '3.0.1');
    const ok = await mod.checkCliBudgetOnce(deps());
    check(A, 'G4 a proper scratch env is accepted (the production launch runs to a PASS through the same guard)', ok.action === 'ran' && ok.status === 'pass', JSON.stringify(ok));
  },

  async chain() {
    freshWorld('chain');
    const A = 'chain';
    const sample = mod.sampleResources();
    check(A, 'R0 the production RAM/load sampler measures this host (positive control for the gate the other arms pin open)', typeof sample.availableRamMB === 'number' && sample.availableRamMB > 0 && typeof sample.load1 === 'number', JSON.stringify(sample));
    const sat = await mod.checkCliBudgetOnce(deps({ resources: () => ({ availableRamMB: 512, load1: 30 }) }));
    check(A, 'R0 a saturated machine defers through the production wiring, consuming nothing', sat.action === 'skip' && (sat.reason === 'ram' || sat.reason === 'load') && rec() === null, JSON.stringify(sat));
    const h = monitorEventLoopDelay({ resolution: 5 });
    setVersion(state.shim, '1.0.1');
    // R1 — a version with no record: exactly ONE background run, silent pass, at nice 19
    h.enable();
    const r1 = await step('R1 new version', () => mod.checkCliBudgetOnce(deps()));
    h.disable();
    check(A, 'R1 version change → ran once, PASS', r1.action === 'ran' && r1.status === 'pass' && r1.version === '1.0.1', JSON.stringify(r1));
    check(A, 'R1 independent counter: the wrapper saw exactly ONE session start', starts(state.shim).length === 1, `${starts(state.shim).length}`);
    check(A, 'R1 low priority: the session CLI ran at nice 19', /nice=19$/.test(starts(state.shim)[0] ?? ''), starts(state.shim)[0]);
    check(A, 'R1 a pass is SILENT (no notice)', notices.length === 0, `${notices.length}`);
    check(A, 'R1 durable record written', rec()?.status === 'pass' && rec()?.version === '1.0.1', JSON.stringify(rec()));
    check(A, 'R1 the suite\'s scratch root is gone (no litter)', scratchRoots().length === 0, scratchRoots().join(','));
    check(A, 'R1 the run never blocked the main loop', h.max / 1e6 < 500, `max event-loop stall ${(h.max / 1e6).toFixed(0)} ms, p99 ${(h.percentile(99) / 1e6).toFixed(0)} ms`);
    check(A, 'R1 the run\'s log line went through the real logger', /\[INFO\] \[cli-budget\] cli-budget: claude 1\.0\.1 differs from the last budgeted \(none\) — running the session budget suite once/.test(logText()));
    // R2 — the same version: zero runs, record untouched
    const mtime = fs.statSync(mod.recordPath(state.home)).mtimeMs;
    const outs = [];
    for (let i = 0; i < 3; i++) outs.push(await mod.checkCliBudgetOnce(deps()));
    check(A, 'R2 same version ×3 → zero runs', outs.every((o) => o.action === 'skip' && o.reason === 'same-version') && starts(state.shim).length === 1, JSON.stringify(outs));
    check(A, 'R2 the record was not rewritten', fs.statSync(mod.recordPath(state.home)).mtimeMs === mtime);
    // R3 — a restart (fresh module state, same home) still runs nothing
    mod.__resetCliBudgetRerunForTest();
    const r3 = await mod.checkCliBudgetOnce(deps());
    check(A, 'R3 restart (durable record) → zero runs', r3.action === 'skip' && r3.reason === 'same-version' && starts(state.shim).length === 1, JSON.stringify(r3));
    // R4 — `claude update`: exactly one more
    setVersion(state.shim, '1.0.2');
    const r4 = await step('R4 claude update', () => mod.checkCliBudgetOnce(deps()));
    check(A, 'R4 new version → exactly one more run', r4.action === 'ran' && r4.status === 'pass' && starts(state.shim).length === 2 && rec()?.version === '1.0.2', `${JSON.stringify(r4)} starts=${starts(state.shim).length}`);
    // R5 — a CLI whose update adds startup calls: broken budget, ONE notice naming budget + version, never again
    setVersion(state.shim, '1.0.3');
    setMode(state.shim, 'inflate');
    const r5 = await step('R5 broken CLI', () => mod.checkCliBudgetOnce(deps()));
    check(A, 'R5 broken budget detected through the real bundle path', r5.action === 'ran' && r5.status === 'broken' && r5.notified === true, JSON.stringify(r5));
    check(A, 'R5 exactly ONE notice', notices.length === 1, `${notices.length}`);
    const n = notices[0] ?? { title: '', body: '', wsId: '', kind: '' };
    check(A, 'R5 the notice names the CLI version', /1\.0\.3/.test(n.title) && /claude 1\.0\.3/.test(n.body), `${n.title} | ${n.body}`);
    check(A, 'R5 the notice names the budget', /session\.beforeFirstReply\.countTokensRequests: allowed at most 0, saw 6/.test(n.body), n.body);
    check(A, 'R5 existing-style notice (D5): platform.notify kind needsInput, no workspace, no new UI', n.kind === 'needsInput' && n.wsId === '');
    check(A, 'R5 a WARN log line carries the same', /\[WARN\] \[cli-budget\] cli-budget: BUDGET BROKEN on claude 1\.0\.3: .*countTokensRequests/.test(logText()));
    check(A, 'R5 record = broken, naming the budget', rec()?.status === 'broken' && rec()?.broken[0]?.id === 'session.beforeFirstReply.countTokensRequests', JSON.stringify(rec()));
    const before = starts(state.shim).length;
    for (let i = 0; i < 3; i++) await mod.checkCliBudgetOnce(deps());
    check(A, 'R5 the broken version is not re-run or re-announced', starts(state.shim).length === before && notices.length === 1, `starts ${before}→${starts(state.shim).length}, notices ${notices.length}`);
    setMode(state.shim, 'pass');
    // R6 — a load campaign holds the campaign lock: deferred (nothing consumed), then runs when it ends
    setVersion(state.shim, '1.0.4');
    const camp = lock.tryAcquire(state.home, 'campaign', 'rig-soak');
    const r6a = await mod.checkCliBudgetOnce(deps());
    check(A, 'R6 campaign lock live → zero runs (deferred)', r6a.action === 'skip' && r6a.reason === 'campaign' && starts(state.shim).length === before && rec()?.version === '1.0.3', JSON.stringify(r6a));
    camp.ok && camp.release();
    const r6b = await mod.checkCliBudgetOnce(deps());
    check(A, 'R6 campaign over → the deferred run happens once', r6b.action === 'ran' && starts(state.shim).length === before + 1, JSON.stringify(r6b));
    { const g = await settled(); check(A, 'R6 no process of any run survives', g.alive.length === 0, `${g.alive.join(',')} (waited ${g.waitedMs} ms)`); }
  },

  async bounded() {
    freshWorld('bounded');
    const A = 'bounded';
    setVersion(state.shim, '2.0.1');
    setMode(state.shim, 'hang');
    const t0 = Date.now();
    const r = await step('hang: a CLI that never answers, bound 12 s', () => mod.checkCliBudgetOnce(deps({ runBoundMs: 12_000 })));
    const took = Date.now() - t0;
    check(A, 'B1 the run is cut at its bound (12 s) — not the 90 s turn timeout', r.action === 'ran' && r.status === 'error' && took < 26_000, `${JSON.stringify(r)} took ${took} ms`);
    check(A, 'B1 recorded as an error naming the bound, NOT a pass, NO notice', /bound and was killed/.test(rec()?.note ?? '') && rec()?.status === 'error' && notices.length === 0, JSON.stringify(rec()));
    { const g = await settled(); check(A, 'B1 the whole process tree is dead', g.alive.length === 0, `${g.alive.join(',')} (waited ${g.waitedMs} ms)`); }
    check(A, 'B1 the suite lock is freed and the single-flight slot released', !fs.existsSync(lock.lockPath(state.home, 'suite')) && !mod.isCliBudgetRunning());
    const r2 = await mod.checkCliBudgetOnce(deps());
    check(A, 'B1 a hang is consumed: the next poll is backed off, not another hang', r2.action === 'skip' && r2.reason === 'retry-backoff', JSON.stringify(r2));
  },

  // A run that measured NOTHING (no first reply) must never read as a pass, never announce a broken budget, and never
  // count as "budgeted" (the version is retried, bounded) — the mutant "VOID judged as pass" survived the chain arm.
  async void() {
    freshWorld('void');
    const A = 'void';
    setVersion(state.shim, '4.0.1');
    setMode(state.shim, 'deadapi');
    const prod = runner.cliBudgetDeps();
    const r = await step('void: the CLI never gets a model reply', () => mod.checkCliBudgetOnce(deps({ runSuite: (o) => prod.runSuite({ ...o, turnTimeoutMs: 8_000 }) })));
    check(A, 'V1 a run with no first reply is VOID (not pass, not broken)', r.action === 'ran' && r.status === 'void', JSON.stringify(r));
    check(A, 'V1 no notice for a run that measured nothing', notices.length === 0, `${notices.length}`);
    check(A, 'V1 recorded as void, naming the failed instrument', rec()?.status === 'void' && /INSTRUMENT VOID/.test(rec()?.note ?? ''), JSON.stringify(rec()));
    const again = await mod.checkCliBudgetOnce(deps());
    check(A, 'V1 a void version is NOT budgeted: the next poll defers on the backoff (not "same-version")', again.action === 'skip' && again.reason === 'retry-backoff', JSON.stringify(again));
    const g = await settled();
    check(A, 'V1 no process of the run survives', g.alive.length === 0, `${g.alive.join(',')} (waited ${g.waitedMs} ms)`);
  },

  async cancel() {
    freshWorld('cancel');
    const A = 'cancel';
    const prior = { schema: 1, version: '0.9.0', status: 'pass', attempts: 1, startedAt: 1, finishedAt: 2, broken: [] };
    fs.mkdirSync(path.dirname(mod.recordPath(state.home)), { recursive: true });
    fs.writeFileSync(mod.recordPath(state.home), JSON.stringify(prior));
    setVersion(state.shim, '2.0.2');
    setMode(state.shim, 'slow');
    const pending = mod.checkCliBudgetOnce(deps());
    await sleep(5000);
    check(A, 'C1 the run is in flight (lock held, record running)', mod.isCliBudgetRunning() && fs.existsSync(lock.lockPath(state.home, 'suite')) && rec()?.status === 'running');
    const t0 = Date.now();
    mod.stopCliBudgetRerun(); // = shutdownSubsystems() at app quit
    check(A, 'C1 quit restores the record and frees the lock SYNCHRONOUSLY', JSON.stringify(rec()) === JSON.stringify(prior) && !fs.existsSync(lock.lockPath(state.home, 'suite')));
    const out = await pending;
    const took = Date.now() - t0;
    check(A, 'C1 cancelled (not error, not pass)', out.action === 'ran' && out.status === 'cancelled', JSON.stringify(out));
    { const g = await settled(); check(A, 'C1 the process tree is killed promptly', took < 5000 && g.alive.length === 0, `${took} ms to return, survivors ${g.alive.join(',')} (waited ${g.waitedMs} ms)`); }
    check(A, 'C1 nothing announced', notices.length === 0);
    setMode(state.shim, 'pass');
    const again = await mod.checkCliBudgetOnce(deps());
    check(A, 'C1 the cancelled run happens on the next start (attempt not consumed)', again.action === 'ran' && again.status === 'pass' && rec()?.attempts === 1, `${JSON.stringify(again)} ${JSON.stringify(rec())}`);
  },
};

const t0 = Date.now();
try {
  for (const [name, fn] of Object.entries(ARMS)) {
    if (WANT !== 'all' && WANT !== name) continue;
    await fn();
  }
} catch (e) {
  failed++;
  results.push({ arm: 'rig', name: 'rig threw', ok: false, detail: String(e?.stack ?? e) });
  say(`RIG THREW: ${e?.stack ?? e}`);
} finally {
  process.env.PATH = state.prevPath;
  mod.__resetCliBudgetRerunForTest();
}
const ok = failed === 0 && results.length > 0;
if (RESULT_FILE) { fs.writeFileSync(`${RESULT_FILE}.tmp`, JSON.stringify({ ok, results, seconds: (Date.now() - t0) / 1000 }, null, 1)); fs.renameSync(`${RESULT_FILE}.tmp`, RESULT_FILE); }
say(`${results.filter((r) => r.ok).length}/${results.length} checks in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
say(`CLI-VERSION-BUDGET-RIG: ${ok ? 'PASS' : 'FAIL'}`);
process.exit(ok ? 0 : 1);
