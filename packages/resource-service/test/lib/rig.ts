// Test rig: one private state dir per Rig, the real CLI driven as a subprocess, and a leak check — every process a lane starts inherits
// RESCTL_STATE_DIR=<this dir>, so "no process left behind" is a scan of /proc for that value.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findByEnv, identityOf, isAlive, sleep, type Identity } from '../../src/proc.ts';
import { readState, type Run } from '../../src/state.ts';

export const BIN = fileURLToPath(new URL('../../bin/resctl.mjs', import.meta.url));
const LANE = fileURLToPath(new URL('../fixtures/lane.mjs', import.meta.url));

export type Cli = { status: number | null; stdout: string; stderr: string };
export type Lane = { wrapper: ChildProcess; exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>; pidfile: string; pid: () => Promise<number> };

export async function waitFor<T>(what: string, fn: () => T | undefined | null | false, timeoutMs = 10_000, everyMs = 40): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() >= deadline) throw new Error(`timed out after ${timeoutMs}ms waiting for: ${what}`);
    await sleep(everyMs);
  }
}

/** Await `p`, but fail (never hang) after `ms`: a mutant that makes a verb run forever must turn a test RED, not stall the suite. */
export async function within<T>(what: string, p: Promise<T>, ms = 15_000): Promise<T> {
  let t: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([p, new Promise<never>((_, rej) => (t = setTimeout(() => rej(new Error(`timed out after ${ms}ms: ${what}`)), ms)))]);
  } finally {
    clearTimeout(t);
  }
}

export class Rig {
  readonly dir: string;
  readonly env: NodeJS.ProcessEnv;
  private kids: ChildProcess[] = [];
  private n = 0;

  constructor(opts: { grace?: string; tick?: string; termWait?: string; env?: NodeJS.ProcessEnv } = {}) {
    this.dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'resctl-test-'));
    this.env = {
      ...process.env,
      RESCTL_STATE_DIR: this.dir,
      RESCTL_NO_AUTOSTART: '1',
      RESCTL_GRACE: opts.grace ?? '2s',
      RESCTL_TICK: opts.tick ?? '100ms',
      RESCTL_TERM_WAIT: opts.termWait ?? '400ms',
      ...opts.env,
    };
    for (const k of ['RESCTL_RUN', 'RESCTL_RUN_TOKEN']) delete this.env[k];
  }

  /** The CLI, synchronously. */
  cli(args: string[], env: NodeJS.ProcessEnv = {}): Cli {
    const r = spawnSync(process.execPath, [BIN, ...args], { env: { ...this.env, ...env }, encoding: 'utf8', timeout: 60_000 });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr };
  }

  /** The CLI, asynchronously (long-running verbs). */
  spawnCli(args: string[], env: NodeJS.ProcessEnv = {}): { child: ChildProcess; exited: Lane['exited']; stderr: () => string } {
    const child = spawn(process.execPath, [BIN, ...args], { env: { ...this.env, ...env }, stdio: ['ignore', 'ignore', 'pipe'] });
    this.kids.push(child);
    let err = '';
    child.stderr!.on('data', (d) => (err += d));
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((r) => child.once('exit', (code, signal) => r({ code, signal })));
    return { child, exited, stderr: () => err };
  }

  /** A stand-in coordinator: a process that lives until killed. */
  coordinator(): { pid: number; kill: () => Promise<void> } {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e6)'], { stdio: 'ignore', env: this.env });
    this.kids.push(child);
    const gone = new Promise<void>((r) => child.once('exit', () => r()));
    return { pid: child.pid!, kill: async () => void (child.kill('SIGKILL'), await gone) };
  }

  /** `resctl exec --run <id> -- node lane.mjs <mode> <pidfile>` */
  lane(runId: string, mode: string): Lane {
    const pidfile = path.join(this.dir, `lane-${++this.n}.pid`);
    const { exited, child } = this.spawnCli(['exec', '--run', runId, '--', process.execPath, LANE, mode, pidfile]);
    return { wrapper: child, exited, pidfile, pid: () => waitFor(`lane pidfile ${pidfile}`, () => (fs.existsSync(pidfile) ? Number(fs.readFileSync(pidfile, 'utf8')) : 0)) };
  }

  /** A process that belongs to no run (carries only the rig's state-dir marker). */
  bystander(): { id: Identity; kill: () => void } {
    const child = spawn('sleep', ['300'], { stdio: 'ignore', env: this.env });
    this.kids.push(child);
    return { id: identityOf(child.pid!)!, kill: () => void child.kill('SIGKILL') };
  }

  startDaemon(): { child: ChildProcess; exited: Lane['exited']; stderr: () => string } {
    const d = this.spawnCli(['serve']);
    return d;
  }

  state() {
    return readState(this.dir);
  }
  run(id: string): Run | undefined {
    return this.state().runs[id];
  }

  /** Kill what the test started, end every open run, then report (and kill) anything still carrying this rig's marker. */
  async dispose(): Promise<number[]> {
    for (const k of this.kids) if (k.exitCode === null && k.signalCode === null) k.kill('SIGKILL');
    await sleep(100);
    try {
      for (const r of Object.values(this.state().runs)) if (r.state !== 'cleaned') this.cli(['run', 'end', '--id', r.id]);
    } catch {
      /* no state file: nothing to end */
    }
    const leaked = findByEnv('RESCTL_STATE_DIR', this.dir);
    // marker-identified (this rig's own state dir), so a raw kill is safe — and it must also reach a process in the test runner's own group, which signalIfSame refuses
    for (const id of leaked) if (isAlive(id)) process.kill(id.pid, 'SIGKILL');
    await waitFor('leaked processes to die', () => leaked.every((i) => !isAlive(i)), 5000).catch(() => undefined);
    fs.rmSync(this.dir, { recursive: true, force: true });
    return leaked.map((i) => i.pid);
  }
}

export { isAlive, identityOf };
