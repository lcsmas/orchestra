// Stand-in for src/main/transport/local-pty.ts in the R1/R2 harnesses ONLY.
//
// The real module uses a TS parameter property, which node's strip-only mode
// refuses to parse — so it cannot be imported directly by these harnesses.
// This implements the SAME SessionTransport interface over a real child
// process instead of a node-pty. That matters for R1: the failure path under
// test is reached only when `isRunning(id)` is TRUE, and `isRunning` is
// `sessions.has(id)` — so the transport must really spawn and really register,
// not be faked. The process is real; only the tty layer is absent, which
// nothing on the path under test reads.
import { spawn } from 'node:child_process';

class ChildTransport {
  constructor(proc) { this.proc = proc; }
  get pid() { return this.proc.pid; }
  onData(listener) {
    const h = (b) => listener(String(b));
    this.proc.stdout?.on('data', h);
    return { dispose: () => this.proc.stdout?.off('data', h) };
  }
  onExit(listener) {
    const h = (code) => listener({ exitCode: code ?? 0 });
    this.proc.on('exit', h);
    return { dispose: () => this.proc.off('exit', h) };
  }
  write(data) { this.proc.stdin?.write(data); }
  resize() {}
  kill() { try { this.proc.kill(); } catch {} }
}

export class LocalPtyTransport extends ChildTransport {}

export const createLocalPtyTransport = async (opts) => {
  const proc = spawn(opts.command, opts.args ?? [], {
    cwd: opts.cwd, env: opts.env, stdio: ['pipe', 'pipe', 'pipe'],
  });
  return new ChildTransport(proc);
};

export default { LocalPtyTransport, createLocalPtyTransport };
