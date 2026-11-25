// #612 — start / probe / stop the DETACHED command of a no-agent workspace. Node-only, every host fact injected (wiring: noagent.ts) so the REAL lifecycle runs under node --test.
// Detached (`setsid`: own session + process group) so it survives the app's quit; a pid + /proc start-time record per workspace tells a restarted app it is the SAME live process.
// The session key is minted ONCE per start of the command and registered with the host BEFORE the process exists; an already-live command is never re-keyed (a new key would supersede it).
import { spawn as nodeSpawn, type SpawnOptions } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Workspace } from '../shared/types.ts';
import { mintSessionKey } from './session-identity.ts';
import { noAgentCommandEnv, noAgentRefusal, noDisplayRefusal, parseNoAgentRecord, parseProcStartTicks, recordIsAlive, runCommandRefusal, type NoAgentRecord } from '../shared/noagent.ts';

export interface NoAgentDeps {
  /** `<ORCHESTRA_HOME>` — the records live in `<home>/noagent/`. */
  home: string;
  getWorkspace(id: string): Workspace | undefined;
  /** The run the host vouches for this workspace today (`runIdOf`). */
  runIdOf(ws: Workspace): string;
  /** The ORCHESTRA_* script env of the workspace (`buildScriptEnv`). */
  scriptEnv(ws: Workspace): Record<string, string>;
  /** The host's own env (display check + what the command inherits). */
  hostEnv: Record<string, string | undefined>;
  /** The hooks socket path the command's CLI talks to; null = the host has none yet. */
  sock(): string | null;
  registerKey(wsId: string, key: string): void;
  forgetKey(wsId: string): void;
  /** Test seam; production = node's spawn. */
  spawn?: (command: string, args: string[], opts: SpawnOptions) => import('node:child_process').ChildProcess;
  now?: () => Date;
  platform?: string;
  log?: { info(m: string): void; warn(m: string, e?: unknown): void };
}

export type StartOutcome = { ok: true; pid: number; reused: boolean; log: string } | { ok: false; error: string };

export interface NoAgentRunner {
  start(id: string): Promise<StartOutcome>;
  /** true = the recorded command is the same live process. */
  running(id: string): boolean;
  /** Stop the command (SIGTERM to its whole process group, SIGKILL after `graceMs`); resolves when it is gone. */
  stop(id: string, graceMs?: number): Promise<{ stopped: boolean }>;
  recordOf(id: string): NoAgentRecord | null;
  logFile(id: string): string;
}

const safeId = (id: string): string => {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id)) throw new Error(`unsafe workspace id ${JSON.stringify(id.slice(0, 40))}`);
  return id;
};

function readTicks(pid: number): number | null {
  try {
    return parseProcStartTicks(fs.readFileSync(`/proc/${pid}/stat`, 'utf8'));
  } catch {
    return null;
  }
}

function pidProbe(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function createNoAgentRunner(deps: NoAgentDeps): NoAgentRunner {
  const dir = path.join(deps.home, 'noagent');
  const recFile = (id: string): string => path.join(dir, `${safeId(id)}.json`);
  const logFile = (id: string): string => path.join(dir, `${safeId(id)}.log`);
  const spawnFn = deps.spawn ?? nodeSpawn;
  const inFlight = new Map<string, Promise<StartOutcome>>();

  const recordOf = (id: string): NoAgentRecord | null => {
    try {
      return parseNoAgentRecord(fs.readFileSync(recFile(id), 'utf8'));
    } catch {
      return null;
    }
  };
  const aliveRec = (rec: NoAgentRecord): boolean => recordIsAlive(rec, readTicks(rec.pid), pidProbe(rec.pid));
  const running = (id: string): boolean => {
    const rec = recordOf(id);
    return !!rec && aliveRec(rec);
  };

  async function startOnce(id: string): Promise<StartOutcome> {
    const ws = deps.getWorkspace(id);
    if (!ws) return { ok: false, error: `unknown workspace ${id}` };
    if (ws.noAgent !== true) return { ok: false, error: noAgentRefusal('noagent-not-noagent', `workspace ${id} is not a no-agent workspace (created by \`orchestra spawn --no-agent\`): nothing was started.`) };
    if (ws.archived) return { ok: false, error: `workspace ${id} is archived: nothing was started` };
    const cmdRefusal = runCommandRefusal(ws.runCommand);
    if (cmdRefusal) return { ok: false, error: cmdRefusal };
    const live = recordOf(id);
    if (live && aliveRec(live)) return { ok: true, pid: live.pid, reused: true, log: logFile(id) }; // already running: no new key (it would supersede the live command)
    const noDisplay = noDisplayRefusal(deps.hostEnv, deps.platform);
    if (noDisplay) return { ok: false, error: noDisplay };
    const sock = deps.sock();
    if (!sock) return { ok: false, error: `the host has no hooks socket yet (still starting?): ${id} was not started — try again in a few seconds` };
    const key = mintSessionKey();
    // registered (persisted) BEFORE the process exists: its first CLI call must already be vouched. A key that cannot be persisted starts nothing.
    try {
      deps.registerKey(id, key);
    } catch (e) {
      return { ok: false, error: `could not register the session key for ${id}: ${e instanceof Error ? e.message : String(e)} — nothing was started` };
    }
    const env = noAgentCommandEnv({ base: deps.hostEnv, scriptEnv: deps.scriptEnv(ws), sock, wsId: id, key, runId: deps.runIdOf(ws) });
    let fd: number | null = null;
    try {
      fs.mkdirSync(dir, { recursive: true });
      fd = fs.openSync(logFile(id), 'a', 0o600);
      const child = spawnFn('/bin/sh', ['-c', ws.runCommand!.trim()], { cwd: ws.worktreePath, env, detached: true, stdio: ['ignore', fd, fd] });
      const pid = await new Promise<number>((resolve, reject) => {
        child.once('error', reject);
        child.once('spawn', () => resolve(child.pid ?? -1));
      });
      child.unref();
      if (!(pid > 1)) throw new Error('no pid');
      const startTicks = readTicks(pid);
      // on Linux a pid whose start time cannot be read is already gone (exited at once / zombie): a record without ticks would later let a REUSED pid pass for the command (and `stop` signal an unrelated group)
      if (startTicks === null && (deps.platform ?? process.platform) === 'linux') throw new Error(`the command exited immediately — see ${logFile(id)}`);
      const rec: NoAgentRecord = { version: 1, pid, startTicks, startedAt: (deps.now?.() ?? new Date()).toISOString(), command: ws.runCommand!.trim().slice(0, 200) };
      const tmp = `${recFile(id)}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(rec), { mode: 0o600 });
      fs.renameSync(tmp, recFile(id));
      deps.log?.info(`no-agent command of ${id} started (pid ${pid}, detached)`);
      return { ok: true, pid, reused: false, log: logFile(id) };
    } catch (e) {
      deps.forgetKey(id); // the key vouched a process that never existed
      return { ok: false, error: `could not start the command of ${id}: ${e instanceof Error ? e.message : String(e)}` };
    } finally {
      if (fd !== null) fs.closeSync(fd);
    }
  }

  return {
    start(id) {
      const cur = inFlight.get(id);
      if (cur) return cur;
      const p = startOnce(id).finally(() => inFlight.delete(id));
      inFlight.set(id, p);
      return p;
    },
    running,
    recordOf,
    logFile,
    async stop(id, graceMs = 3000) {
      const rec = recordOf(id);
      if (!rec || !aliveRec(rec)) {
        fs.rmSync(recFile(id), { force: true });
        return { stopped: false };
      }
      const signal = (sig: NodeJS.Signals): void => {
        try {
          process.kill(-rec.pid, sig); // the whole process group (setsid made pid its leader)
        } catch {
          try { process.kill(rec.pid, sig); } catch { /* gone */ }
        }
      };
      signal('SIGTERM');
      const deadline = Date.now() + graceMs;
      while (aliveRec(rec) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
      if (aliveRec(rec)) signal('SIGKILL');
      fs.rmSync(recFile(id), { force: true });
      return { stopped: true };
    },
  };
}
