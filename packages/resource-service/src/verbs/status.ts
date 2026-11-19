// resctl status [--json]: every run of the state dir with its owner, state, processes, containers and memory.
import path from 'node:path';
import { parse } from '../args.ts';
import { daemonRunning, daemonLockPath } from '../daemon.ts';
import { dockerTimeoutMs, stateDir, type Env } from '../env.ts';
import { usageError } from '../errors.ts';
import { readHolder } from '../lockfile.ts';
import { isAlive, type Identity } from '../proc.ts';
import { readState, type Lane, type RunState } from '../state.ts';
import { asked, CONTAINER_SOURCES, processesOf, SOURCE_TIMEOUT_MS, type ContainerInfo, type ContainerSource, type ProcessInfo } from '../status-sources.ts';

export type RunStatus = {
  id: string;
  state: RunState;
  owner: Identity & { alive: boolean };
  startedAt: number;
  graceEndsAt?: number;
  graceLeftMs?: number;
  maxLifeAt?: number;
  cleanedAt?: number;
  lanes: (Pick<Lane, 'pid' | 'pgid' | 'cmd' | 'startedAt'> & { alive: boolean })[];
  processes: ProcessInfo[];
  memory: { rssKb: number };
  containers: ContainerInfo[];
};
export type Status = {
  stateDir: string;
  now: number;
  daemon: { running: boolean; pid?: number };
  containers: { available: boolean; reasons: string[] };
  orphanContainers: ContainerInfo[]; // labelled with a run this state dir does not know
  runs: RunStatus[];
  /** state.json unreadable (corrupt / newer version): `runs` is empty, the other lines are still true. */
  stateError?: string;
};

/** Everything `status` prints, as data. `sources` is the A2 seam (default: CONTAINER_SOURCES). */
export async function collectStatus(env: Env = process.env, sources: ContainerSource[] = CONTAINER_SOURCES, now: number = Date.now(), sourceTimeoutMs: number = Math.max(SOURCE_TIMEOUT_MS, dockerTimeoutMs(env) + 2000)): Promise<Status> {
  const dir = stateDir(env);
  let state: ReturnType<typeof readState> = { version: 1, runs: {} };
  let stateError: string | undefined;
  try {
    state = readState(dir);
  } catch (e) {
    stateError = `${path.join(dir, 'state.json')} is unreadable (${(e as Error).message.split('\n')[0]}): runs cannot be listed; nothing will be reaped from it either (fail closed)`;
  }
  const holder = readHolder(daemonLockPath(dir));
  const running = daemonRunning(dir);
  const reports = await Promise.all(sources.map(async (s) => ({ s, r: await asked(s, env, sourceTimeoutMs) })));
  const seen = new Set<string>();
  const containers: ContainerInfo[] = [];
  const reasons: string[] = [];
  for (const { s, r } of reports) {
    if (!r.available) reasons.push(`${s.name}: ${r.reason}`);
    else for (const c of r.containers) if (!seen.has(c.id)) (seen.add(c.id), containers.push(c));
  }
  const runs = Object.values(state.runs).sort((a, b) => a.startedAt - b.startedAt).map((run): RunStatus => {
    const processes = run.state === 'cleaned' ? [] : processesOf(run);
    return {
      id: run.id,
      state: run.state,
      owner: { pid: run.owner.pid, startTime: run.owner.startTime, alive: isAlive(run.owner) },
      startedAt: run.startedAt,
      ...(run.graceEndsAt !== undefined ? { graceEndsAt: run.graceEndsAt, graceLeftMs: Math.max(0, run.graceEndsAt - now) } : {}),
      ...(run.maxLifeAt !== undefined ? { maxLifeAt: run.maxLifeAt } : {}),
      ...(run.cleanedAt !== undefined ? { cleanedAt: run.cleanedAt } : {}),
      lanes: run.lanes.map((l) => ({ pid: l.pid, pgid: l.pgid, cmd: l.cmd, startedAt: l.startedAt, alive: processes.some((p) => p.pid === l.pid) })),
      processes,
      memory: { rssKb: processes.reduce((sum, p) => sum + p.rssKb, 0) },
      containers: containers.filter((c) => c.run === run.id),
    };
  });
  const known = new Set(runs.map((r) => r.id));
  return {
    stateDir: dir,
    now,
    daemon: { running, ...(running && holder && holder !== 'unreadable' ? { pid: holder.pid } : {}) },
    containers: { available: reasons.length < sources.length, reasons },
    // with an unreadable state every run is unknown: calling all containers orphans would be false
    orphanContainers: stateError ? [] : containers.filter((c) => !known.has(c.run)),
    runs,
    ...(stateError ? { stateError } : {}),
  };
}

const mb = (kb: number): string => (kb >= 1024 ? `${(kb / 1024).toFixed(1)}M` : `${kb}K`);
const secs = (ms: number): string => `${Math.ceil(ms / 1000)}s`;

export function render(s: Status): string {
  const out: string[] = [];
  out.push(`state dir: ${s.stateDir}`);
  out.push(`daemon: ${s.daemon.running ? `running (pid ${s.daemon.pid ?? '?'})` : 'NOT RUNNING — nothing will reap a run whose owner dies (start `resctl serve` or the unit)'}`);
  out.push(`containers: ${s.containers.available ? 'visible' : 'unavailable'}${s.containers.reasons.length ? ` (${s.containers.reasons.join('; ')})` : ''}`);
  if (s.stateError) out.push(`ERROR: ${s.stateError}`);
  else if (s.runs.length === 0) out.push('no runs');
  for (const r of s.runs) {
    const label = r.state === 'grace' ? `in grace (${secs(r.graceLeftMs ?? 0)} left)` : r.state === 'alive' && !r.owner.alive ? 'alive (owner gone, not yet noticed by the reaper)' : r.state;
    out.push('');
    out.push(`run ${r.id}: ${label}`);
    out.push(`  owner: pid ${r.owner.pid} ${r.owner.alive ? 'alive' : 'dead'}`);
    out.push(`  processes: ${r.processes.length}, memory ${mb(r.memory.rssKb)} RSS`);
    for (const p of r.processes) out.push(`    ${p.lane ? 'lane' : '    '} pid ${p.pid} ${mb(p.rssKb)} ${p.cmd}`);
    for (const l of r.lanes) if (!l.alive) out.push(`    lane pid ${l.pid} gone: ${l.cmd.join(' ')}`);
    out.push(`  containers: ${r.containers.length ? r.containers.map((c) => `${c.name} (${c.state})`).join(', ') : s.containers.available ? 'none' : 'unknown'}`);
  }
  if (s.orphanContainers.length) out.push('', `containers labelled with an unknown run: ${s.orphanContainers.map((c) => `${c.name} (run ${c.run}, ${c.state})`).join(', ')}`);
  return out.join('\n') + '\n';
}

export async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parse(argv, { json: { type: 'boolean' } });
  if (positionals.length) throw usageError(`unexpected argument: ${positionals[0]}`);
  const s = await collectStatus();
  process.stdout.write(values.json ? JSON.stringify(s, null, 2) + '\n' : render(s));
  return s.stateError ? 1 : 0;
}
