import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { orchestraHome, platform } from './platform';
import { store } from './store';
import { scoped } from './logger';
import { getAppStartedAt, getLastActivity } from './hibernation-activity';
import { buildCampaignEnv, DEFAULT_SOAK_POLICY, type SoakActivity, type SoakState } from '../shared/soak-schedule';
import { soakTick, EMPTY_SOAK_STATE, yieldRunningSoak, type SoakDeps, type SoakRunResult } from './soak-tick';

// Automatic load/soak campaigns (C5 #212) — the I/O half. The decision (idle, change-gated, caps) is
// src/shared/soak-schedule.ts; the campaign itself is scripts/session-budget/soak-campaign.mjs (N real sessions against a FAKE
// local API: zero tokens, D6). Nothing here is UI-visible (D5): start/finish are INFO lines and a breached budget is one WARN line
// in the `[soak]` scope of orchestra.log. Design + gates: docs/codebase-map/session-budget.md §Load/soak campaign.

const slog = scoped('soak');

/** A minute is plenty: the gates are cheap and a campaign is hours apart. */
export const TICK_MS = 60_000;
const IDENTITY_TTL_MS = 5 * 60_000;
const KEEP_REPORTS = 30;

export interface SoakConfig {
  /** Off switch. Default: on whenever an Orchestra checkout is found. `ORCHESTRA_SOAK=0` also disables. */
  enabled?: boolean;
  /** The Orchestra checkout to run the campaign from (default: a registered repo that carries scripts/session-budget/soak-campaign.mjs). */
  repo?: string;
  /** Absolute path of a Node ≥ 22.6 (the campaign runs under --experimental-strip-types; Electron's own node is too old). */
  node?: string;
  durationSec?: number;
}

// ── the real dependencies ───────────────────────────────────────────────────────────────────────────────────────────────────────

const soakDir = (): string => path.join(orchestraHome(), 'soak');
const statePath = (): string => path.join(soakDir(), 'state.json');

function readConfig(): SoakConfig {
  let cfg: SoakConfig = {};
  try {
    cfg = JSON.parse(fs.readFileSync(path.join(soakDir(), 'config.json'), 'utf8')) as SoakConfig;
  } catch {
    /* no config: defaults */
  }
  if (process.env.ORCHESTRA_SOAK === '0') cfg.enabled = false;
  if (process.env.ORCHESTRA_SOAK_REPO) cfg.repo = process.env.ORCHESTRA_SOAK_REPO;
  return cfg;
}

const SCRIPT = path.join('scripts', 'session-budget', 'soak-campaign.mjs');

function isOrchestraCheckout(dir: string): boolean {
  try {
    if (!fs.existsSync(path.join(dir, SCRIPT))) return false;
    return (JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')) as { name?: string }).name === 'orchestra';
  } catch {
    return false;
  }
}

function resolveRepo(): string | null {
  const cfg = readConfig();
  if (cfg.repo) return isOrchestraCheckout(cfg.repo) ? cfg.repo : null;
  for (const r of store.repos) if (isOrchestraCheckout(r.path)) return r.path;
  return null;
}

function readState(): SoakState {
  try {
    const s = JSON.parse(fs.readFileSync(statePath(), 'utf8')) as SoakState;
    return s?.schema === 1 ? s : EMPTY_SOAK_STATE;
  } catch {
    return EMPTY_SOAK_STATE;
  }
}

function writeState(s: SoakState): void {
  try {
    fs.mkdirSync(soakDir(), { recursive: true });
    const tmp = `${statePath()}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(s)}\n`);
    fs.renameSync(tmp, statePath());
  } catch (e) {
    slog.swallow('writing soak state', e);
  }
}

function readMachine(): { memAvailKB: number; load1: number } {
  let memAvailKB = Number.NaN;
  let load1 = Number.NaN;
  try {
    memAvailKB = Number(/^MemAvailable:\s+(\d+) kB/m.exec(fs.readFileSync('/proc/meminfo', 'utf8'))?.[1] ?? Number.NaN);
    load1 = Number(fs.readFileSync('/proc/loadavg', 'utf8').split(' ')[0]);
  } catch {
    /* non-Linux / unreadable: NaN → the decision fails closed */
  }
  return { memAvailKB, load1 };
}

let lastFocusedAt: number | undefined;

function readActivity(): SoakActivity {
  const now = Date.now();
  const focused = platform.isFocused();
  if (focused) lastFocusedAt = now;
  return {
    appUptimeMs: now - getAppStartedAt(),
    windowFocused: focused,
    // Never focused since launch counts from launch: an app nobody opened is idle.
    lastFocusedAt: lastFocusedAt ?? getAppStartedAt(),
    systemIdleSec: platform.getSystemIdleSeconds?.() ?? null,
    workspaces: store.workspaces.map((w) => ({ id: w.id, status: w.status, lastActivityAt: getLastActivity(w.id) })),
  };
}

let nodeBin: string | null | undefined;
/** A Node ≥ 22.6 to run the campaign under (`--experimental-strip-types`); Electron's embedded node is older. Cached. */
async function findNode(cfg: SoakConfig): Promise<string | null> {
  if (nodeBin !== undefined && !cfg.node) return nodeBin;
  const cands = [cfg.node, ...(process.env.PATH ?? '').split(path.delimiter).map((d) => (d ? path.join(d, 'node') : '')), '/usr/local/bin/node', '/usr/bin/node', path.join(os.homedir(), '.local', 'bin', 'node')];
  for (const c of cands) {
    if (!c) continue;
    try {
      fs.accessSync(c, fs.constants.X_OK);
      const v = await new Promise<string>((resolve, reject) => execFile(c, ['--version'], { timeout: 10_000 }, (e, out) => (e ? reject(e) : resolve(String(out).trim()))));
      const m = /^v(\d+)\.(\d+)/.exec(v);
      if (m && (Number(m[1]) > 22 || (Number(m[1]) === 22 && Number(m[2]) >= 6))) {
        nodeBin = c;
        return c;
      }
    } catch {
      /* next */
    }
  }
  nodeBin = cfg.node ? undefined : null;
  return null;
}

/** The directory holding executable `bin` — on the app's PATH first, then the usual user-level install dirs (a desktop-launched app's PATH is thin). */
function dirOf(bin: string): string | null {
  const pnpmHome = process.env.PNPM_HOME;
  for (const d of [...(process.env.PATH ?? '').split(path.delimiter), path.join(os.homedir(), '.local', 'bin'), ...(pnpmHome ? [pnpmHome] : []), path.join(os.homedir(), '.local', 'share', 'pnpm'), '/usr/local/bin', '/usr/bin']) {
    if (!d) continue;
    try {
      fs.accessSync(path.join(d, bin), fs.constants.X_OK);
      return d;
    } catch {
      /* next */
    }
  }
  return null;
}

const campaignEnv = (): NodeJS.ProcessEnv => buildCampaignEnv(process.env, os.homedir(), [dirOf('claude'), dirOf('pnpm')]);

let identityCache: { repo: string; at: number; value: { codeId: string | null; cliVersion: string | null } } | null = null;
async function realIdentity(repo: string): Promise<{ codeId: string | null; cliVersion: string | null }> {
  if (identityCache && identityCache.repo === repo && Date.now() - identityCache.at < IDENTITY_TTL_MS) return identityCache.value;
  const node = await findNode(readConfig());
  let value: { codeId: string | null; cliVersion: string | null } = { codeId: null, cliVersion: null };
  if (node) {
    value = await new Promise((resolve) => {
      execFile(node, ['--experimental-strip-types', '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', path.join(repo, SCRIPT), '--identity'], { cwd: repo, timeout: 30_000, env: campaignEnv() }, (e, out) => {
        if (e) return resolve({ codeId: null, cliVersion: null });
        try {
          const j = JSON.parse(String(out).trim().split('\n').pop() ?? '') as { codeId?: string; cli?: string | null };
          resolve({ codeId: j.codeId ?? null, cliVersion: j.cli ?? null });
        } catch {
          resolve({ codeId: null, cliVersion: null });
        }
      });
    });
  }
  identityCache = { repo, at: Date.now(), value };
  return value;
}

function pruneReports(dir: string): void {
  try {
    const stems = [...new Set(fs.readdirSync(dir).filter((f) => /^soak-.*\.(json|md)$/.test(f)).map((f) => f.replace(/\.(json|md)$/, '')))].sort();
    for (const stem of stems.slice(0, Math.max(0, stems.length - KEEP_REPORTS))) for (const ext of ['json', 'md']) fs.rmSync(path.join(dir, `${stem}.${ext}`), { force: true });
  } catch {
    /* best effort */
  }
}

function realLaunch(o: { repo: string; sessions: number }): { done: Promise<SoakRunResult>; yieldNow(reason: string): void } {
  const cfg = readConfig();
  const outDir = path.join(soakDir(), 'reports');
  fs.mkdirSync(outDir, { recursive: true });
  let child: ChildProcess | null = null;
  const done = (async (): Promise<SoakRunResult> => {
    const node = await findNode(cfg);
    if (!node) return { terminator: 'BROKE', reportJson: null, failing: [], detail: 'no Node ≥ 22.6 found to run the campaign (set node in <ORCHESTRA_HOME>/soak/config.json)' };
    const argv = [
      '--experimental-strip-types', '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', path.join(o.repo, SCRIPT),
      '--sessions', String(o.sessions), '--duration', `${cfg.durationSec ?? DEFAULT_SOAK_POLICY.durationSec}s`, '--turn-interval', '30s', '--sample', '30s',
      '--out-dir', outDir, '--label', 'sched', '--parent-pid', String(process.pid),
    ];
    const logFile = path.join(soakDir(), 'last-run.log');
    let tail = '';
    child = spawn(node, argv, { cwd: o.repo, env: campaignEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
    const collect = (d: Buffer): void => {
      tail = (tail + String(d)).slice(-65536);
    };
    child.stdout?.on('data', collect);
    child.stderr?.on('data', collect);
    const rc = await new Promise<number | string>((resolve) => {
      child?.on('error', (e) => resolve(`spawn error: ${e.message}`));
      child?.on('close', (code, sig) => resolve(code ?? sig ?? 'unknown'));
    });
    try {
      fs.writeFileSync(logFile, tail);
    } catch {
      /* best effort */
    }
    const term = /^SOAK-CAMPAIGN: (\w+)$/m.exec(tail)?.[1] ?? 'BROKE';
    const reportJson = /^report: (\S+\.json)/m.exec(tail)?.[1] ?? null;
    let failing: string[] = [];
    if (reportJson) {
      try {
        failing = ((JSON.parse(fs.readFileSync(reportJson, 'utf8')) as { verdicts?: Array<{ id: string; ok: boolean; kind: string }> }).verdicts ?? []).filter((v) => !v.ok && v.kind === 'budget').map((v) => v.id);
      } catch {
        /* report unreadable: the terminator still stands */
      }
    }
    pruneReports(outDir);
    return { terminator: term, reportJson, failing, detail: `rc=${rc}${term === 'BROKE' ? `; ${tail.trim().split('\n').slice(-2).join(' | ').slice(0, 300)}` : ''}` };
  })();
  return {
    done,
    yieldNow(reason: string) {
      slog.info(`asking the campaign to stop: ${reason}`);
      try {
        child?.kill('SIGTERM');
      } catch {
        /* gone */
      }
    },
  };
}

const realDeps = (): SoakDeps => ({
  now: () => Date.now(),
  resolveRepo,
  enabled: () => readConfig().enabled !== false,
  readState,
  writeState,
  identity: realIdentity,
  activity: readActivity,
  machine: readMachine,
  launch: realLaunch,
  log: { info: (m) => slog.info(m), warn: (m) => slog.warn(m), debug: (m) => slog.debug(m) },
});

/** One tick over the REAL dependencies, with any of them overridable — the driven rig (scripts/verify-soak-scheduler.mjs) injects only the
 *  machine reading so the run does not depend on how loaded the host is; repo resolution, identity, spawn, env, state and logging stay real. */
export const soakTickWith = (over: Partial<SoakDeps> = {}): ReturnType<typeof soakTick> => soakTick({ ...realDeps(), ...over });

let timer: ReturnType<typeof setInterval> | null = null;

/** Start the scheduler (index.ts, after the store loaded). A no-op tick loop when no checkout is found or it is disabled. */
export function startSoakScheduler(): void {
  if (timer) return;
  const deps = realDeps();
  timer = setInterval(() => {
    void soakTick(deps).catch((e) => slog.swallow('soak tick', e));
  }, TICK_MS);
  timer.unref?.();
}

/** App quit: stop ticking and ask a running campaign to tear down (its own parent-death watch covers a hard kill). */
export function stopSoakScheduler(): void {
  if (timer) clearInterval(timer);
  timer = null;
  yieldRunningSoak('app quitting');
}
