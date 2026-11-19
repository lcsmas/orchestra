// Where `resctl status` gets what the state file does not hold. THE SEAM A2 plugs into: a container source is `{name, collect}`; append one to
// CONTAINER_SOURCES (or replace `dockerLabelSource`) and `status` merges its containers by id. A source must DEGRADE, never throw: it returns {available:false, reason}.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import { dockerTimeoutMs, type Env } from './env.ts';
import { collectRunProcesses } from './cleanup.ts';
import type { Run } from './state.ts';

export type ContainerInfo = { id: string; name: string; image: string; state: string; run: string };
export type ContainersReport = { available: true; containers: ContainerInfo[] } | { available: false; reason: string };
export type ContainerSource = { name: string; collect: (env: Env) => Promise<ContainersReport> };

const SEP = '\t';

/** Every container carrying the label `resctl.run` (A2's relay stamps it; the freeze names it), grouped later by its value. A missing/unreachable docker is a report, not an error. */
export const dockerLabelSource: ContainerSource = {
  name: 'docker label resctl.run',
  collect: (env) =>
    new Promise((resolve) => {
      const fmt = ['{{.ID}}', '{{.Names}}', '{{.State}}', '{{.Image}}', '{{.Label "resctl.run"}}'].join(SEP);
      execFile('docker', ['ps', '-a', '--filter', 'label=resctl.run', '--format', fmt], { env: env as NodeJS.ProcessEnv, timeout: dockerTimeoutMs(env), encoding: 'utf8' }, (err, stdout, stderr) => {
        if (err) {
          const e = err as NodeJS.ErrnoException & { killed?: boolean };
          const reason = e.code === 'ENOENT' ? 'docker not found' : e.killed ? `docker did not answer within ${dockerTimeoutMs(env) / 1000}s` : (String(stderr).trim().split('\n')[0] || e.message);
          return resolve({ available: false, reason });
        }
        const containers = String(stdout).split('\n').filter(Boolean).map((l): ContainerInfo => {
          const [id, name, state, image, run] = l.split(SEP);
          return { id, name, state, image, run };
        });
        resolve({ available: true, containers });
      });
    }),
};

export const CONTAINER_SOURCES: ContainerSource[] = [dockerLabelSource];

/** A source gets this long; a hung one must not hang `status`. */
export const SOURCE_TIMEOUT_MS = 10_000;

/** Ask one source and NEVER throw: a synchronous throw, a rejection and silence all become {available:false}. */
export async function asked(s: ContainerSource, env: Env, timeoutMs: number): Promise<ContainersReport> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      s.collect(env), // a synchronous throw is caught below, like a rejection
      new Promise<ContainersReport>((resolve) => (timer = setTimeout(() => resolve({ available: false, reason: `no answer within ${timeoutMs}ms` }), timeoutMs))),
    ]);
  } catch (e) {
    return { available: false, reason: String((e as Error).message) };
  } finally {
    clearTimeout(timer);
  }
}

export type ProcessInfo = { pid: number; startTime: number; rssKb: number; cmd: string; lane: boolean };

/** VmRSS in kB from /proc/<pid>/status (page-size independent: the host may use 16k pages); null when unreadable (a kernel thread has none). */
export function rssKbOf(pid: number): number | null {
  try {
    const m = /^VmRSS:\s+(\d+) kB$/m.exec(fs.readFileSync(`/proc/${pid}/status`, 'utf8'));
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

function cmdOf(pid: number): string {
  try {
    return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean).join(' ').slice(0, 200);
  } catch {
    return '';
  }
}

/** Every live process of the run — the lane groups plus whatever carries the run token — the same set cleanup would signal. */
export function processesOf(run: Run): ProcessInfo[] {
  const leaders = new Set(run.lanes.map((l) => l.pid));
  return collectRunProcesses(run).map((p) => ({ pid: p.pid, startTime: p.startTime, rssKb: rssKbOf(p.pid) ?? 0, cmd: cmdOf(p.pid), lane: leaders.has(p.pid) }));
}
