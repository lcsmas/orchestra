// resctl exec --run <id> -- <cmd...>: run a lane as a child of this CLI, in its own process group/session, marked with the run's token.
import { spawn } from 'node:child_process';
import os from 'node:os';
import { parse } from '../args.ts';
import { TOKEN_ENV } from '../cleanup.ts';
import { stateDir } from '../env.ts';
import { refused, usageError } from '../errors.ts';
import { groupMembers, readStat, signalGroupIfOurs, type Identity } from '../proc.ts';
import { withState } from '../state.ts';

const FORWARDED: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];

export async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parse(argv, { run: { type: 'string' } });
  if (!values.run) throw usageError('--run <id> is required');
  if (positionals.length === 0) throw usageError('a command is required: exec --run <id> -- <cmd> [args...]');
  const [cmd, ...args] = positionals;
  const dir = stateDir();

  const token = await withState((s) => {
    const run = s.runs[values.run!];
    if (!run) throw refused(`no such run: ${values.run}`);
    if (run.state === 'cleaned') throw refused(`run ${values.run} is cleaned`);
    return run.token;
  }, dir);

  const child = spawn(cmd, args, {
    stdio: 'inherit',
    detached: true, // setsid: the lane is its own group leader, so the group is the lane
    env: { ...process.env, RESCTL_RUN: values.run, [TOKEN_ENV]: token, RESCTL_STATE_DIR: dir },
  });
  const failed = new Promise<NodeJS.ErrnoException>((resolve) => child.once('error', resolve));
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));

  let leader: Identity | null = null;
  if (child.pid !== undefined) {
    const st = readStat(child.pid);
    if (st) leader = { pid: child.pid, startTime: st.startTime };
    for (const sig of FORWARDED) process.on(sig, () => leader && signalGroupIfOurs(leader, sig));
    if (leader) {
      const lane = { pid: child.pid, pgid: child.pid, startTime: leader.startTime, cmd: [cmd, ...args], startedAt: Date.now() };
      const ok = await withState((s) => {
        const run = s.runs[values.run!];
        if (!run || run.state === 'cleaned') return false;
        run.lanes.push(lane);
        return true;
      }, dir);
      if (!ok) {
        signalGroupIfOurs(leader, 'SIGKILL');
        throw refused(`run ${values.run} was cleaned while the lane started`);
      }
    }
  }

  const r = await Promise.race([exited.then((x) => ({ ok: x })), failed.then((e) => ({ err: e }))]);
  if ('err' in r) {
    process.stderr.write(`resctl: exec: ${cmd}: ${r.err.code === 'ENOENT' ? 'command not found' : r.err.message}\n`);
    return r.err.code === 'ENOENT' ? 127 : 126;
  }
  const lanePid = child.pid;
  // The lane record leaves the state when its whole group is gone; a group that still has members (daemonised kids) stays recorded so a cleanup reaches it.
  if (groupMembers(lanePid!).length === 0) {
    await withState((s) => {
      const run = s.runs[values.run!];
      if (run) run.lanes = run.lanes.filter((l) => l.pid !== lanePid);
    }, dir).catch(() => undefined);
  }
  const { code, signal } = r.ok;
  return code ?? 128 + (signal ? os.constants.signals[signal] : 0);
}
