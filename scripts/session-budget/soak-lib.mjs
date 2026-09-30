// Load/soak campaign DRIVER (C5 #212) — everything around the contained runner: D7 preflight + watchdog, the single-flight lock,
// the code/CLI identity, the report files. `soak-campaign.mjs` (the ONE command), `soak-selftest.mjs` (the must-FAIL arms) and,
// later, C6 #213 (network faults) all call `runCampaign`. Pure decisions live in src/shared/soak-campaign.ts.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { ensureBuilt, detectContainment, findOnPath, runSoakCampaign } from './harness.mjs';
import { SOAK_BUDGETS } from '../../src/shared/session-budget.ts';
import { buildSoakReport, decideAbort, emptyRaw, formatSoakMarkdown, formatSoakText, ingestSoakLine, judgeSoak, preflight, soakExitCode, soakTerminator, tightenCaps } from '../../src/shared/soak-campaign.ts';

export const CACHE = path.join(os.homedir(), '.cache', 'session-budget');
export const LOCK_PATH = path.join(CACHE, 'campaign.lock');
export const DEFAULT_OUT_DIR = path.join(CACHE, 'soak-reports');

const readTicks = (pid) => { try { const t = fs.readFileSync(`/proc/${pid}/stat`, 'utf8'); return Number(t.slice(t.lastIndexOf(')') + 2).split(' ')[19]); } catch { return null; } };
export const readMemAvailKB = () => { try { return Number(/^MemAvailable:\s+(\d+) kB/m.exec(fs.readFileSync('/proc/meminfo', 'utf8'))?.[1] ?? NaN); } catch { return NaN; } };
export const readLoad1 = () => { try { return Number(fs.readFileSync('/proc/loadavg', 'utf8').split(' ')[0]); } catch { return NaN; } };

/** Single-flight lock shared by EVERY campaign on this host (D7: never two at once). Holder identity = pid + /proc start time. */
export function acquireLock(lockPath = LOCK_PATH, label = 'soak') {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const mine = { pid: process.pid, startTicks: readTicks(process.pid), label, at: new Date().toISOString() };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(lockPath, 'wx');
      fs.writeSync(fd, JSON.stringify(mine));
      fs.closeSync(fd);
      return { release() { try { const cur = JSON.parse(fs.readFileSync(lockPath, 'utf8')); if (cur.pid === process.pid && cur.startTicks === mine.startTicks) fs.unlinkSync(lockPath); } catch { /* gone */ } } };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let holder = null;
      try { holder = JSON.parse(fs.readFileSync(lockPath, 'utf8')); } catch { /* torn/unreadable: treat as stale below */ }
      const alive = holder && readTicks(holder.pid) !== null && readTicks(holder.pid) === holder.startTicks;
      if (alive) throw new Error(`another campaign is running (${holder.label} pid ${holder.pid} since ${holder.at}) — D7: never two campaigns at once`);
      try { fs.unlinkSync(lockPath); } catch { /* raced */ }
    }
  }
  throw new Error(`could not take ${lockPath}`);
}

/** Independent of the lock file: a campaign RUNNER already alive anywhere on this host (identified by its argv). */
export function otherRunnerAlive() {
  for (const n of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(n) || Number(n) === process.pid) continue;
    try { if (fs.readFileSync(`/proc/${n}/cmdline`, 'latin1').includes('soak-runner.mjs')) return Number(n); } catch { /* gone */ }
  }
  return null;
}

/** What code the campaign exercised: git tree hashes of the paths it depends on (+ any uncommitted change). `codeId` is the change gate's key. */
export function codeIdentity(repo) {
  const git = (...a) => { try { return execFileSync('git', a, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 1 << 28 }).trim(); } catch { return ''; } };
  const paths = ['src', 'scripts/session-budget', 'pnpm-lock.yaml'];
  const trees = paths.map((p) => git('rev-parse', `HEAD:${p}`));
  const diff = git('diff', 'HEAD', '--', ...paths);
  const untracked = git('ls-files', '--others', '--exclude-standard', '--', 'src', 'scripts/session-budget').split('\n').filter(Boolean)
    .map((f) => { try { return `${f}:${crypto.createHash('sha1').update(fs.readFileSync(path.join(repo, f))).digest('hex')}`; } catch { return f; } });
  const dirty = diff || untracked.length ? crypto.createHash('sha1').update(diff + '\n' + untracked.join('\n')).digest('hex').slice(0, 12) : null;
  const gitSha = git('rev-parse', 'HEAD').slice(0, 12);
  // Not a git checkout (or git unreadable): NO identity — the change gate must fail closed, never hash a constant.
  const codeId = gitSha && trees.every(Boolean) ? crypto.createHash('sha1').update([...trees, dirty ?? ''].join('\n')).digest('hex').slice(0, 16) : null;
  return { codeId, gitSha, dirty, trees: Object.fromEntries(paths.map((p, i) => [p, trees[i].slice(0, 12)])) };
}

export function cliVersion() {
  const claude = findOnPath('claude');
  if (!claude) return null;
  // `--version` prints before any config is loaded, but never point even that at a live config dir: a fixed scratch one.
  const scratch = path.join(CACHE, 'version-probe-config');
  fs.mkdirSync(scratch, { recursive: true });
  try { return execFileSync(claude, ['--version'], { encoding: 'utf8', timeout: 20_000, env: { ...process.env, CLAUDE_CONFIG_DIR: scratch } }).trim(); } catch { return null; }
}

const stamp = (d = new Date()) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');

/**
 * Run one campaign end to end. Returns `{ refused: string[] }` (usage/lock refusals — nothing was started) or
 * `{ report, judgement, terminator, rc, files }`. A D7 abort (before the start OR during it) is a REPORT with status ABORTED, not a refusal.
 * @param {{repo:string, params:object, faultPlan?:object|null, seedLeak?:object|null, profile?:object, outDir?:string, label?:string, meta?:object,
 *          capsOverride?:object, runnerCapsOverride?:object, readResources?:()=>{memAvailKB:number,load1:number}, signal?:AbortSignal,
 *          onLine?:(l:string)=>void, skipBuild?:boolean, containment?:object, lockPath?:string}} o
 *   capsOverride tightens the caps for preflight + the parent watchdog + the runner; runnerCapsOverride tightens ONLY the runner's own per-sample
 *   check; readResources replaces the /proc readings the preflight and the parent watchdog use. All three are for the self-test's abort arms:
 *   they can only make the campaign stop SOONER, never later or larger.
 */
export async function runCampaign(o) {
  const { repo, params, faultPlan = null, seedLeak = null, profile = {}, outDir = DEFAULT_OUT_DIR, label = 'soak', meta = {}, onLine } = o;
  const caps = tightenCaps({ minMemAvailKB: SOAK_BUDGETS.minMemAvailKB, maxLoad1: SOAK_BUDGETS.maxLoad1 }, o.capsOverride);
  const readRes = o.readResources ?? (() => ({ memAvailKB: readMemAvailKB(), load1: readLoad1() }));
  const pf = { params, ...readRes() };
  // Usage errors refuse outright; resource shortfalls become an ABORTED report (D7: "says so in its report").
  const usage = preflight({ ...pf, memAvailKB: Number.POSITIVE_INFINITY, load1: 0 }).filter((r) => !r.startsWith('machine not fit'));
  if (usage.length) return { refused: usage };
  const other = otherRunnerAlive();
  if (other) return { refused: [`another campaign runner is alive (pid ${other}) — D7: never two campaigns at once`] };
  let lock;
  try { lock = acquireLock(o.lockPath ?? LOCK_PATH, label); } catch (e) { return { refused: [String(e.message)] }; }
  const raw = emptyRaw();
  const abortCtl = new AbortController();
  const tStart = performance.now();
  const elapsedSec = () => Math.round((performance.now() - tStart) / 100) / 10; // monotonic: a suspend must not read as elapsed campaign time
  let parentAbort = null;
  let watchdog = null;
  try {
    const id = codeIdentity(repo);
    const metaAll = { ...id, cli: cliVersion(), node: process.version, kernel: os.release(), ...meta };
    const why = preflight(pf).filter((r) => r.startsWith('machine not fit') || r.startsWith('projected'));
    const tight = decideAbort({ memAvailKB: pf.memAvailKB, load1: pf.load1 }, caps);
    if (why.length || tight) {
      raw.abort = { reason: tight?.reason ?? 'preflight', detail: (tight ? [tight.detail] : []).concat(why).join('; '), tSec: 0 };
      return finish(raw, metaAll, { outDir, label, rc: null, params, faultPlan, seedLeak });
    }
    if (!o.skipBuild && process.env.SESSION_BUDGET_SKIP_BUILD !== '1') ensureBuilt(repo);
    const containment = o.containment ?? detectContainment();
    // The parent's OWN watchdog on the D7 caps — a second, independent channel next to the runner's per-sample check.
    watchdog = setInterval(() => {
      const w = decideAbort(readRes(), caps);
      if (w && !parentAbort) { parentAbort = { reason: w.reason, detail: `${w.detail} (parent watchdog)`, tSec: elapsedSec() }; abortCtl.abort(parentAbort); }
    }, 5000);
    o.signal?.addEventListener('abort', () => {
      const r = o.signal.reason;
      parentAbort ??= { ...(r && typeof r === 'object' && r.reason ? r : { reason: 'signal', detail: String(r ?? 'aborted by the caller') }), tSec: elapsedSec() };
      abortCtl.abort(parentAbort);
    }, { once: true });
    let buf = '';
    const res = await runSoakCampaign({
      repo, sessions: params.sessions, durationMs: params.durationSec * 1000, turnIntervalMs: params.turnIntervalSec * 1000, sampleMs: params.sampleSec * 1000,
      turnDeadlineMs: params.turnDeadlineSec * 1000, replyDelayMs: params.replyDelayMs, toolEvery: params.toolEvery ?? 0, faultPlan, seedLeak, profile,
      caps: tightenCaps(caps, o.runnerCapsOverride), containment, signal: abortCtl.signal, keep: o.keep,
      onStdout: (chunk) => {
        buf += chunk;
        for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
          const line = buf.slice(0, i); buf = buf.slice(i + 1);
          if (ingestSoakLine(raw, line)) onLine?.(line);
        }
      },
    });
    if (res.void) { raw.harnessError = res.error; return finish(raw, metaAll, { outDir, label, rc: null, params, faultPlan, seedLeak, voidRun: true }); }
    if (!raw.final && res.error) raw.harnessError = res.error;
    // The runner reports the reason it read from the abort file; if it died first (killed at the grace limit) the parent's own record stands.
    if (parentAbort && !raw.abort) raw.abort = parentAbort;
    if (res.reaped) raw.events.push({ tSec: -1, kind: 'reaped', detail: `${res.reaped} leftover scratch process(es) reaped by HOME marker` });
    return finish(raw, metaAll, { outDir, label, rc: res.rc, params, faultPlan, seedLeak });
  } finally {
    if (watchdog) clearInterval(watchdog);
    lock.release();
  }
}

function finish(raw, meta, o) {
  const report = buildSoakReport(raw, meta);
  // A run that never started has no `start` line: still say what was asked, so the ABORTED/VOID report is not an empty shell.
  if (!raw.start) Object.assign(report.params, { sessions: o.params.sessions, durationSec: o.params.durationSec, turnIntervalSec: o.params.turnIntervalSec, sampleSec: o.params.sampleSec, turnDeadlineSec: o.params.turnDeadlineSec, replyDelayMs: o.params.replyDelayMs, seedLeak: o.seedLeak ?? null, faultPlan: o.faultPlan ?? null });
  const judgement = judgeSoak(report);
  report.verdicts = judgement.verdicts;
  report.judgement = { ok: judgement.ok, void: judgement.void, aborted: judgement.aborted };
  const terminator = o.voidRun ? 'VOID' : soakTerminator(report, judgement);
  const rc = soakExitCode(terminator);
  const files = writeReport(report, terminator, o);
  return { report, judgement, terminator, rc, files };
}

function writeReport(report, terminator, o) {
  fs.mkdirSync(o.outDir, { recursive: true });
  const base = path.join(o.outDir, `soak-${stamp(new Date(report.startedAt ?? report.endedAt))}-${o.label}`);
  fs.writeFileSync(`${base}.json`, `${JSON.stringify({ terminator, ...report }, null, 1)}\n`);
  fs.writeFileSync(`${base}.md`, formatSoakMarkdown(report, terminator));
  return { json: `${base}.json`, md: `${base}.md` };
}

export { formatSoakText };
