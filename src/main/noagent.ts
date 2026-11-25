// #612 — production wiring of the no-agent runner (logic: noagent-runner.ts, pure helpers: shared/noagent.ts): the real store, the host's session-key registry, the hooks socket.
import { createNoAgentRunner, type NoAgentRunner, type StartOutcome } from './noagent-runner.ts';
import { store } from './store.ts';
import { orchestraHome } from './platform/index.ts';
import { registerSessionKey, forgetSessionKey } from './session-identity-host.ts';
import { getHookSocketPath } from './hooks-server.ts';
import { buildScriptEnv } from './scripts.ts';
import { agentCliBinDir } from './cli-shim.ts';
import path from 'node:path';
import { runIdOf } from '../shared/run-position.ts';
import { scoped } from './logger.ts';

const nlog = scoped('noagent');

let runner: NoAgentRunner | null = null;

/** Lazy: `orchestraHome()` is known once the platform is up. */
export function noAgentRunner(): NoAgentRunner {
  return (runner ??= createNoAgentRunner({
    home: orchestraHome(),
    getWorkspace: (id) => store.getWorkspace(id),
    runIdOf: (ws) => runIdOf(ws, (x) => store.getWorkspace(x)),
    // like an agent session: the orchestra-owned bin dir FIRST on PATH (so `orchestra` resolves without the user's login PATH) and the worktree the role guard / hooks read
    scriptEnv: (ws) => ({ ...buildScriptEnv(ws), ORCHESTRA_WORKTREE: ws.worktreePath, PATH: process.env.PATH ? `${agentCliBinDir()}${path.delimiter}${process.env.PATH}` : agentCliBinDir() }),
    hostEnv: process.env,
    sock: () => getHookSocketPath(),
    registerKey: registerSessionKey,
    forgetKey: forgetSessionKey,
    log: nlog,
  }));
}

/** `POST /noagent/start { id }` — start (or confirm) the detached command of a no-agent workspace. Never throws: `{ ok:false, error }` carries the `[name]` refusal. */
export async function dispatchNoAgentStart(msg: Record<string, unknown>): Promise<{ ok: true; pid: number; reused: boolean; log: string } | { ok: false; error: string }> {
  const id = typeof msg.id === 'string' ? msg.id.trim() : '';
  if (!id) return { ok: false, error: 'missing id' };
  try {
    const r: StartOutcome = await noAgentRunner().start(id);
    return r;
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Stop the command of `id` if it has one (delete / archive). Best effort, never throws. */
export async function stopNoAgentCommand(id: string): Promise<void> {
  try {
    if (store.getWorkspace(id)?.noAgent === true) await noAgentRunner().stop(id);
  } catch (e) {
    nlog.warn(`could not stop the no-agent command of ${id}`, e);
  }
}
