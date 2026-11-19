// resctl exec --run <id> [--mem <size>] -- <cmd...>: run a lane as a child of this CLI, in its own process group/session, marked with the run's token.
// A4: with --mem (and a systemd that can enforce it) the lane runs in its own user scope with a hard memory level — exit 137 + a stderr line when the kernel kills it for that.
import { spawn } from 'node:child_process';
import os from 'node:os';
import { parse } from '../args.ts';
import { TOKEN_ENV } from '../cleanup.ts';
import { stateDir } from '../env.ts';
import { capEvidence, memTotalBytes, resetFailed, scopeDescription, scopeLaunch, scopePopulated, scopeSupport, scopeUnitName, settleScope, watchOomKills } from '../scope.ts';
import { parseSize } from '../units.ts';
import { refused, usageError } from '../errors.ts';
import { groupMembers, readStat, signalGroupIfOurs, type Identity } from '../proc.ts';
import { withState } from '../state.ts';

const FORWARDED: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];
/** Exit code of a lane the kernel killed for exceeding its `--mem` level (the shell's 128 + SIGKILL). */
export const EXIT_MEM_CAP = 137;

export async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parse(argv, { run: { type: 'string' }, mem: { type: 'string' } });
  if (!values.run) throw usageError('--run <id> is required');
  if (positionals.length === 0) throw usageError('a command is required: exec --run <id> -- <cmd> [args...]');
  const [cmd, ...args] = positionals;
  const dir = stateDir();

  let capBytes = 0;
  if (values.mem !== undefined) {
    try {
      capBytes = parseSize(values.mem);
    } catch (e) {
      throw usageError(`--mem: ${(e as Error).message}`);
    }
    if (capBytes <= 0) throw usageError('--mem must be larger than 0');
  }
  let scoped = false;
  if (capBytes > 0) {
    const sup = scopeSupport(capBytes);
    scoped = sup.ok;
    const total = sup.ok ? memTotalBytes() : null;
    if (total !== null && capBytes > total) process.stderr.write(`resctl: exec: warning: --mem ${values.mem} is larger than this host's memory (${total} bytes): the cap can never fire\n`);
    if (!sup.ok) process.stderr.write(`resctl: exec: warning: --mem ${values.mem} ignored, the command runs WITHOUT a memory cap: ${sup.reason}\n`);
  }

  const { token, unit } = await withState((s) => {
    const run = s.runs[values.run!];
    if (!run) throw refused(`no such run: ${values.run}`);
    if (run.state === 'cleaned') throw refused(`run ${values.run} is cleaned`);
    if (scoped) run.scopeSeq = (run.scopeSeq ?? 0) + 1;
    return { token: run.token, unit: scoped ? scopeUnitName(values.run!, run.scopeSeq!) : undefined };
  }, dir);

  const launch = unit ? scopeLaunch({ unit, bytes: capBytes, description: scopeDescription(values.run!, token), cmd, args }) : { cmd, args };
  const child = spawn(launch.cmd, launch.args, {
    stdio: 'inherit',
    detached: true, // setsid: the lane is its own group leader, so the group is the lane
    env: { ...process.env, RESCTL_RUN: values.run, [TOKEN_ENV]: token, RESCTL_STATE_DIR: dir },
  });
  const oomWatch = unit && child.pid !== undefined ? watchOomKills(child.pid, unit) : null;
  child.once('exit', () => oomWatch?.read()); // the last chance to read the kernel's counter is the instant the leader is gone
  const failed = new Promise<NodeJS.ErrnoException>((resolve) => child.once('error', resolve));
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));

  let leader: Identity | null = null;
  if (child.pid !== undefined) {
    const st = readStat(child.pid);
    if (st) leader = { pid: child.pid, startTime: st.startTime };
    for (const sig of FORWARDED) process.on(sig, () => leader && signalGroupIfOurs(leader, sig));
    if (leader) {
      const lane = { pid: child.pid, pgid: child.pid, startTime: leader.startTime, cmd: [cmd, ...args], startedAt: Date.now(), ...(unit ? { scope: unit } : {}) };
      let registered = false;
      try {
        registered = await withState((s) => {
          const run = s.runs[values.run!];
          if (!run || run.state === 'cleaned') return false;
          run.lanes.push(lane);
          return true;
        }, dir);
      } finally {
        if (!registered) signalGroupIfOurs(leader, 'SIGKILL'); // never leave an unrecorded lane running (cleaned meanwhile, or the state was unreachable)
      }
      if (!registered) throw refused(`run ${values.run} was cleaned while the lane started`);
    }
  }

  const r = await Promise.race([exited.then((x) => ({ ok: x })), failed.then((e) => ({ err: e }))]);
  if ('err' in r) {
    process.stderr.write(`resctl: exec: ${cmd}: ${r.err.code === 'ENOENT' ? 'command not found' : r.err.message}\n`);
    return r.err.code === 'ENOENT' ? 127 : 126;
  }
  const lanePid = child.pid;
  const { code, signal } = r.ok;
  const ownOom = oomWatch?.stop() ?? 0;
  // The scope's own verdict: systemd records `Result=oom-kill` when the kernel killed something for the level. A scope with members left (a setsid-ed kid) stays active.
  let capKilled = false;
  let evidence: 'systemd' | 'counter' | null = null;
  let scopeBusy = false;
  if (unit) {
    const info = await settleScope(unit, signal === 'SIGKILL');
    evidence = capEvidence({ result: info?.result, own: ownOom });
    capKilled = evidence !== null; // systemd's record OR the kernel's own counter (systemd can lose the event)
    scopeBusy = info === null || ((info.active === 'active' || info.active === 'deactivating') && scopePopulated(info)); // unreachable systemd = unknown: keep the record; `active` with an EMPTY cgroup is systemd lagging, not a member
    if (info && info.load !== 'not-found' && !scopeBusy) await resetFailed(unit); // a failed scope would otherwise stay loaded
  }
  // The lane record leaves the state when its whole group is gone (and its scope, if any); a group/scope that still has members (daemonised kids) stays recorded so a cleanup reaches it.
  if (groupMembers(lanePid!).length === 0 && !scopeBusy) {
    await withState((s) => {
      const run = s.runs[values.run!];
      if (run) run.lanes = run.lanes.filter((l) => l.pid !== lanePid);
    }, dir).catch(() => undefined);
  }
  if (capKilled) {
    const seen = evidence === 'systemd' ? `systemd recorded Result=oom-kill for scope ${unit}` : `the kernel's oom_kill counter of scope ${unit} moved (systemd's record said otherwise)`;
    process.stderr.write(`resctl: exec: killed by the kernel OOM killer — ${seen} — most likely the memory cap --mem ${values.mem} (${capBytes} bytes, no swap) was exceeded. This process and its caller were not touched; exit ${EXIT_MEM_CAP}.\n`);
    return EXIT_MEM_CAP;
  }
  return code ?? 128 + (signal ? os.constants.signals[signal] : 0);
}
