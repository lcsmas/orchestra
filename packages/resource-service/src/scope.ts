// A4: the systemd user scope behind `exec --mem`. The command runs as the main process of its OWN transient scope with MemoryMax + MemorySwapMax=0, so the kernel
// OOM-kills it (never the resctl CLI or its caller). Spec: docs ADR 0005 (same cgroup facts); no Orchestra import — the few facts needed are restated here.
import { spawnSync, execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import { forceNoSystemd, noOomWatch, systemctlBin, systemdRunBin, type Env } from './env.ts';
import { sleep } from './proc.ts';

/** A scope name this service made: never `resctl.service`, never an option (`resctl-` first), the run id charset of `run start`, a counter last. */
export const SCOPE_NAME_RE = /^resctl-[A-Za-z0-9][A-Za-z0-9._-]*-\d+\.scope$/;
export const scopeUnitName = (runId: string, n: number): string => `resctl-${runId}-${n}.scope`;
/** The scope's description carries the run INSTANCE token: a stop re-reads it (a same-named scope of another state dir / instance is not ours). */
export const scopeDescription = (runId: string, token: string): string => `resctl run ${runId} ${token}`;

/**
 * `MemorySwapMax=0`: with swap on (zram), MemoryMax alone is not a cap — the overflow parks in swap (ADR 0005). `OOMPolicy=kill`: one oom_kill ends EVERYTHING in the
 * scope at once (systemd's default `stop` sends SIGTERM and waits), and marks the unit `Result=oom-kill`, which is how the CLI knows the cap was the cause.
 */
export const capProps = (bytes: number): string[] => [`MemoryMax=${bytes}`, 'MemorySwapMax=0', 'OOMPolicy=kill'];
const propArgs = (props: string[]): string[] => props.flatMap((p) => ['-p', p]);

export function scopeLaunch(a: { unit: string; bytes: number; description: string; cmd: string; args: string[] }, env: Env = process.env): { cmd: string; args: string[] } {
  return { cmd: systemdRunBin(env), args: ['--user', '--scope', '--quiet', `--unit=${a.unit}`, `--description=${a.description}`, ...propArgs(capProps(a.bytes)), '--', a.cmd, ...a.args] };
}

export type Support = { ok: true } | { ok: false; reason: string };
const no = (reason: string): Support => ({ ok: false, reason });

// Runs INSIDE the probe scope: the limits the kernel really holds (cgroup v2 files of its own cgroup).
const PROBE_SH = 'p=$(sed -n "s/^0:://p" /proc/self/cgroup); cat /sys/fs/cgroup$p/memory.max /sys/fs/cgroup$p/memory.swap.max';

/**
 * Can this host cap a command? Real detection, not a flag: a systemd (`/run/systemd/system`), a usable user manager, and — measured, not assumed — a probe scope that
 * comes up with the limit APPLIED (a user manager without the memory controller delegated accepts `MemoryMax` and enforces nothing).
 */
export function scopeSupport(bytes: number, env: Env = process.env): Support {
  if (forceNoSystemd(env)) return no('RESCTL_FORCE_NO_SYSTEMD=1');
  if (process.platform !== 'linux') return no(`${process.platform} has no systemd scopes`);
  if (!fs.existsSync('/run/systemd/system')) return no('this host does not run systemd (/run/systemd/system is missing)');
  const unit = `resctlprobe-${process.pid}-${randomBytes(3).toString('hex')}.scope`;
  const r = spawnSync(systemdRunBin(env), ['--user', '--scope', '--collect', '--quiet', `--unit=${unit}`, ...propArgs(capProps(bytes)), '--', 'sh', '-c', PROBE_SH], { encoding: 'utf8', timeout: 15_000, env });
  if (r.error) return no(`${systemdRunBin(env)} did not run (${(r.error as NodeJS.ErrnoException).code ?? r.error.message})`);
  if (r.status === null && r.signal) return no(`the probe scope's own shell was killed (${r.signal}): --mem ${bytes} bytes is too small to start any process (use at least 2M)`);
  if (r.status !== 0) return no(`the systemd user manager refused a scope (${(r.stderr || '').trim().split('\n')[0] || `exit ${r.status}`})`);
  const [max, swap] = r.stdout.trim().split('\n');
  const applied = /^\d+$/.test(max ?? '') && Number(max) > 0 && Number(max) <= bytes;
  if (!applied) return no(`the user manager does not enforce MemoryMax (memory.max = ${max ?? 'unreadable'}; is the memory controller delegated to the user manager?)`);
  if (swap !== '0') return no(`the user manager does not enforce MemorySwapMax=0 (memory.swap.max = ${swap ?? 'unreadable'}): an overflow would park in swap`);
  return { ok: true };
}

export type ScopeInfo = { load: string; active: string; result: string; description: string; cgroup: string };

function ctl(args: string[], env: Env, timeoutMs = 15_000): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(systemctlBin(env), ['--user', '--no-pager', ...args], { encoding: 'utf8', timeout: timeoutMs, env: env as NodeJS.ProcessEnv }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? ((err as { code: number }).code) : null) : 0;
      resolve({ status: code, stdout, stderr });
    });
  });
}

/** The unit as systemd sees it NOW, or null when systemctl could not be asked. */
export async function scopeInfo(unit: string, env: Env = process.env): Promise<ScopeInfo | null> {
  const r = await ctl(['show', '-p', 'LoadState', '-p', 'ActiveState', '-p', 'Result', '-p', 'Description', '-p', 'ControlGroup', unit], env);
  if (r.status !== 0) return null;
  const kv = new Map<string, string>();
  for (const line of r.stdout.split('\n')) {
    const i = line.indexOf('=');
    if (i > 0) kv.set(line.slice(0, i), line.slice(i + 1));
  }
  return { load: kv.get('LoadState') ?? '', active: kv.get('ActiveState') ?? '', result: kv.get('Result') ?? '', description: kv.get('Description') ?? '', cgroup: kv.get('ControlGroup') ?? '' };
}

/** Does the scope's cgroup still hold a process? ENOENT = the cgroup is gone = empty; anything unreadable = unknown = populated (fail closed). */
export function scopePopulated(info: ScopeInfo): boolean {
  if (!info.cgroup) return true;
  try {
    return fs.readFileSync(`/sys/fs/cgroup${info.cgroup}/cgroup.procs`, 'utf8').trim() !== '';
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== 'ENOENT';
  }
}

/**
 * After the lane's leader exited: wait for systemd to settle the scope and return what it recorded. Two things are still in flight right after the exit:
 *  - systemd has not yet processed cgroup-empty (the unit reads `active` with NO process left): wait (≤ waitMs) until it is not `active`, else an instantly-exiting command reads as « scope busy »;
 *  - the leader died by SIGKILL and the OOM event may still be on its way (the unit reads success / already collected): re-read `killReads` times (each read has its own systemctl timeout) before concluding it was not the cap.
 * A scope that ended cleanly is garbage-collected (load `not-found`).
 */
export async function settleScope(unit: string, diedByKill: boolean, env: Env = process.env, waitMs = 2000, killReads = 6): Promise<ScopeInfo | null> {
  const start = Date.now();
  for (let reads = 1; ; reads++) {
    const info = await scopeInfo(unit, env);
    if (!info) return info;
    const gone = info.load === 'not-found';
    const inFlight = !gone && (info.active === 'activating' || info.active === 'deactivating' || (info.active === 'active' && !scopePopulated(info)));
    const lostKill = diedByKill && info.result !== 'oom-kill';
    // the kill re-read is bounded by PROGRESS (reads that returned), not elapsed time: a slow `systemctl show` under load must not spend the budget and return the stale result
    if (!((inFlight && Date.now() - start < waitMs) || (lostKill && reads < killReads))) return info;
    await sleep(50);
  }
}

/** Where a user scope's cgroup lives: next to our own `user@<uid>.service` subtree, in its `app.slice` (systemd-run --user's default slice). Null when we are not inside one. */
export function userScopeCgroup(unit: string, selfCgroup: string): string | null {
  const m = /^(.*\/user@\d+\.service)(\/|$)/.exec(selfCgroup);
  return m ? `/sys/fs/cgroup${m[1]}/app.slice/${unit}` : null;
}

/**
 * systemd can lose the OOM event (measured: `Result=success` for 6 of 150 real cap kills under CPU load): it learns of the kill from `memory.events` only after the cgroup is
 * already empty. The scope's OWN `memory.events` `oom_kill` is the ground truth and is read while the cgroup exists: polled for the lane's life and once at the leader's exit.
 * Only the scope's own counter — a parent cgroup is shared with every sibling scope, so its counter says nothing about THIS lane. The path is derived from the unit name (no
 * dependence on the leader's /proc entry surviving) with the leader's /proc/<pid>/cgroup as a fallback.
 */
export function watchOomKills(pid: number, unit: string, env: Env = process.env, everyMs = 5): { read: () => void; stop: () => number } {
  let seen = 0;
  let file: string | null = null;
  const self = ((): string => {
    try {
      return fs.readFileSync('/proc/self/cgroup', 'utf8').split('\n').find((l) => l.startsWith('0::'))?.slice(3).trim() ?? '';
    } catch {
      return '';
    }
  })();
  const derived = userScopeCgroup(unit, self);
  const read = (): void => {
    try {
      if (!file) {
        if (derived && fs.existsSync(`${derived}/memory.events`)) file = `${derived}/memory.events`;
        else {
          const cg = fs.readFileSync(`/proc/${pid}/cgroup`, 'utf8').split('\n').find((l) => l.startsWith('0::'))?.slice(3).trim();
          if (!cg || !cg.endsWith(`/${unit}`)) return; // still systemd-run itself, not yet in the scope
          file = `/sys/fs/cgroup${cg}/memory.events`;
        }
      }
      const m = /^oom_kill (\d+)$/m.exec(fs.readFileSync(file, 'utf8'));
      if (m) seen = Math.max(seen, Number(m[1]));
    } catch {
      /* the process or the cgroup is gone: keep what was seen */
    }
  };
  if (noOomWatch(env)) return { read: () => undefined, stop: () => 0 };
  const timer = setInterval(read, everyMs);
  timer.unref();
  return { read, stop: () => (clearInterval(timer), read(), seen) };
}

/** What proves the lane was killed by its cap: systemd's record (`Result=oom-kill`) or the scope's own kernel counter; nothing else (an exit code, a sibling's kill, a parent counter prove nothing). */
export function capEvidence(v: { result?: string; own: number }): 'systemd' | 'counter' | null {
  if (v.result === 'oom-kill') return 'systemd';
  return v.own > 0 ? 'counter' : null;
}

/** Physical memory of the host in bytes, or null when unreadable. */
export function memTotalBytes(): number | null {
  try {
    const m = /^MemTotal:\s+(\d+) kB/m.exec(fs.readFileSync('/proc/meminfo', 'utf8'));
    return m ? Number(m[1]) * 1024 : null;
  } catch {
    return null;
  }
}

export async function resetFailed(unit: string, env: Env = process.env): Promise<void> {
  await ctl(['reset-failed', unit], env);
}

/**
 * Stop a scope recorded on a lane of THIS run instance: re-read its description (the instance token) right before acting, SIGKILL everything in its cgroup, stop it,
 * clear a failed state, then check it is gone. A scope that is not ours (other token) or already gone is left alone / counts as gone.
 */
export async function stopScope(unit: string, token: string, env: Env = process.env): Promise<'stopped' | 'gone' | 'not-ours'> {
  if (!SCOPE_NAME_RE.test(unit)) throw new Error(`refusing to stop ${JSON.stringify(unit)}: not a resctl scope name`);
  const before = await scopeInfo(unit, env);
  if (!before) throw new Error(`systemctl could not be asked about ${unit}`);
  if (before.load === 'not-found') return 'gone';
  if (!before.description.includes(token)) return 'not-ours';
  await ctl(['kill', '--kill-whom=all', '--signal=SIGKILL', unit], env);
  await ctl(['stop', unit], env);
  await ctl(['reset-failed', unit], env);
  const after = await settleStopped(unit, env);
  if (after && after.load !== 'not-found' && after.active !== 'inactive') throw new Error(`scope ${unit} is still ${after.active} after stop`);
  return 'stopped';
}

async function settleStopped(unit: string, env: Env): Promise<ScopeInfo | null> {
  const deadline = Date.now() + 5000;
  for (;;) {
    const info = await scopeInfo(unit, env);
    if (!info || info.load === 'not-found' || info.active === 'inactive' || Date.now() >= deadline) return info;
    await sleep(50);
  }
}
