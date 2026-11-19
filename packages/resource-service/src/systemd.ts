// The systemd USER unit of the reaper daemon: render, install, uninstall. The unit's only process is `resctl serve`; runs and their lanes are NOT in its cgroup,
// so stopping the unit stops the reaper and nothing else.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { diskPath, graceMs, keepMs, minFreeDisk, minFreeMem, stateDir, termWaitMs, tickMs, unitName, type Env } from './env.ts';
import { CliError, EXIT, usageError } from './errors.ts';
import { daemonLockPath } from './daemon.ts';
import { readHolder } from './lockfile.ts';
import { isAlive, sleep } from './proc.ts';

/** First line of every unit we write: uninstall (and a re-install) only touch a file that carries it. */
export const MARKER = '# managed by `resctl install-unit` — do not edit; re-run it instead';
/** Config the unit pins at install time (the unit does not inherit the installer's shell). Every value is parsed at install so a typo fails there, not in a restart loop. */
const PINNED = ['RESCTL_GRACE', 'RESCTL_TICK', 'RESCTL_KEEP', 'RESCTL_TERM_WAIT', 'RESCTL_MIN_FREE_MEM', 'RESCTL_MIN_FREE_DISK', 'RESCTL_DISK_PATH'] as const;

export function resolveUnitName(env: Env): string {
  const name = unitName(env);
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*\.service$/.test(name)) throw usageError(`RESCTL_UNIT_NAME ${JSON.stringify(name)}: must look like <letters, digits, . _ ->.service`);
  return name;
}

export function unitDir(env: Env): string {
  return path.join(env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'systemd', 'user');
}

/**
 * The directory to write the unit into: one the USER manager really searches (`UnitPath`). The installer's `$XDG_CONFIG_HOME` is used only when the manager
 * searches it too; otherwise `~/.config/systemd/user`; neither → refuse BEFORE writing (a unit the manager cannot see is "does not exist" at `enable`).
 */
export function resolveUnitDir(env: Env): string {
  const paths = systemctl(['show', '--property=UnitPath', '--value'], env).stdout.trim().split(/[\s:]+/).filter(Boolean);
  const want = unitDir(env);
  const home = path.join(os.homedir(), '.config', 'systemd', 'user');
  for (const d of [want, home]) if (paths.includes(d)) return d;
  throw new CliError(EXIT.failure, `the systemd user manager searches neither ${want} nor ${home} (UnitPath: ${paths.join(' ') || 'unknown'}): not writing a unit it cannot see`);
}

/** `--print` / `uninstall-unit --print` need no systemd: ask the manager when there is one, else the conventional dir. */
export const unitDirFor = (env: Env): string => (userManager(env).ok ? resolveUnitDir(env) : unitDir(env));

/** Inverse of `envLine` over a unit file we rendered: every `Environment="K=V"` line, unescaped (JSON string, `%%` → `%`). */
export function parseUnitEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of text.matchAll(/^Environment=(".*")$/gm)) {
    try {
      const kv = JSON.parse(m[1].replace(/%%/g, '%')) as string;
      const i = kv.indexOf('=');
      if (i > 0) out[kv.slice(0, i)] = kv.slice(i + 1);
    } catch {
      /* not one of ours */
    }
  }
  return out;
}

/** One ExecStart word: double-quoted, with the characters systemd would expand escaped. */
export const execWord = (w: string): string => `"${w.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\$/g, '$$$$').replace(/%/g, '%%')}"`;
const envLine = (k: string, v: string): string => `Environment=${JSON.stringify(`${k}=${v}`).replace(/%/g, '%%')}`;

export type UnitSpec = { name: string; execStart: string[]; environment: Record<string, string> };

/** What the unit will run and with which config, from the installer's env. Throws a usage error for a value the service itself would reject. */
export function unitSpec(env: Env): UnitSpec {
  const bin = fileURLToPath(new URL('../bin/resctl.mjs', import.meta.url));
  const environment: Record<string, string> = { RESCTL_STATE_DIR: stateDir(env) };
  for (const k of PINNED) if (env[k]) environment[k] = env[k]!;
  const readers: Record<string, (e: Env) => unknown> = { RESCTL_GRACE: graceMs, RESCTL_TICK: tickMs, RESCTL_KEEP: keepMs, RESCTL_TERM_WAIT: termWaitMs, RESCTL_MIN_FREE_MEM: minFreeMem, RESCTL_MIN_FREE_DISK: minFreeDisk, RESCTL_DISK_PATH: diskPath };
  for (const [k, read] of Object.entries(readers)) {
    try {
      read(env);
    } catch (e) {
      throw usageError(`${k}: ${(e as Error).message}`);
    }
  }
  return { name: resolveUnitName(env), execStart: [process.execPath, bin, 'serve'], environment };
}

export function renderUnit(spec: UnitSpec): string {
  return [
    MARKER,
    '[Unit]',
    'Description=resctl resource service (reaper daemon for declared runs)',
    '',
    '[Service]',
    'Type=simple',
    `ExecStart=${spec.execStart.map(execWord).join(' ')}`,
    ...Object.entries(spec.environment).map(([k, v]) => envLine(k, v)),
    'Restart=on-failure',
    'RestartSec=5',
    'RestartPreventExitStatus=3', // 3 = another daemon already holds daemon.lock: do not fight it
    'TimeoutStopSec=15',
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n');
}

export type Sh = { status: number | null; stdout: string; stderr: string; missing: boolean };
export function systemctl(args: string[], env: Env): Sh {
  const r = spawnSync('systemctl', ['--user', ...args], { env: env as NodeJS.ProcessEnv, encoding: 'utf8', timeout: 60_000 });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', missing: (r.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT' };
}

/** Can we talk to a systemd user manager? `missing` = no systemctl at all; `unreachable` = systemctl exists but no manager answers. */
export function userManager(env: Env): { ok: true } | { ok: false; kind: 'missing' | 'unreachable'; detail: string } {
  const r = systemctl(['show', '--property=Version', '--value'], env);
  if (r.missing) return { ok: false, kind: 'missing', detail: 'systemctl not found' };
  if (r.status !== 0) return { ok: false, kind: 'unreachable', detail: (r.stderr || r.stdout).trim() || `systemctl exit ${r.status}` };
  return { ok: true };
}

/** Fail BEFORE touching the disk when there is no user manager to talk to (no systemd, no session bus). */
export function requireUserManager(env: Env): void {
  const m = userManager(env);
  if (m.ok) return;
  if (m.kind === 'missing') throw new CliError(EXIT.failure, 'systemctl not found: this host has no systemd. Run `resctl serve` in the foreground instead (container main command).');
  throw new CliError(EXIT.failure, `no systemd user manager reachable (${m.detail}): is XDG_RUNTIME_DIR set? Run \`resctl serve\` in the foreground instead.`);
}

/**
 * `restart` of a Type=simple unit returns at fork. Success = the unit's main process HOLDS daemon.lock (no clock: a loaded host boots node slowly); failure = it
 * left `active` / is waiting to auto-restart (it crashed, or exit 3 = another daemon holds the lock), or never took the lock within `waitMs`.
 */
export async function settle(name: string, stateDir: string, env: Env, waitMs = 20_000): Promise<string | null> {
  const t0 = Date.now();
  const down = (why: string): string => `${why}; see \`journalctl --user -u ${name}\``;
  for (;;) {
    const q = Object.fromEntries(systemctl(['show', '--property=ActiveState,SubState,MainPID', name], env).stdout.trim().split('\n').map((l) => l.split('=')));
    const state = `${q.ActiveState ?? ''}${q.SubState ? ` (${q.SubState})` : ''}`;
    // `activating (auto-restart)` = it already died and systemd is waiting to retry: not up
    if ((q.ActiveState !== 'active' && q.ActiveState !== 'activating') || q.SubState === 'auto-restart') {
      const status = systemctl(['show', '--property=ExecMainStatus', '--value', name], env).stdout.trim();
      return down(`${name} is ${state || 'not running'} right after start (exit status ${status || '?'}${status === '3' ? ': another resctl serve already holds daemon.lock for this state dir' : ''})`);
    }
    const h = readHolder(daemonLockPath(stateDir));
    if (h && h !== 'unreadable' && h.pid === Number(q.MainPID) && isAlive(h)) return null;
    if (Date.now() - t0 >= waitMs) return down(`${name} is ${state} but its main process holds no daemon.lock in ${stateDir} after ${waitMs / 1000}s`);
    await sleep(100);
  }
}

export const isManaged = (file: string): boolean => {
  try {
    return fs.readFileSync(file, 'utf8').startsWith(MARKER);
  } catch {
    return false;
  }
};
