// « Mise à jour disponible » — the MONITOR (Electron-free): what is installed vs what the channel publishes, pushed only when the
// state changes. Host binding (PATH, network, `claude update`, IPC): claude-code-update-host.ts. Words + compare: shared/claude-code-update.ts.
import { spawn } from 'node:child_process';
import { childEnv } from '../shared/child-env.ts';
import {
  CLAUDE_CODE_UPDATE_NONE,
  claudeCodeUpdateStateKey,
  decideClaudeCodeUpdate,
  parsePublishedVersion,
  updateFailureText,
  type ClaudeCodeUpdateState,
  type UpdateRunResult,
} from '../shared/claude-code-update.ts';

export interface ClaudeCodeUpdateDeps {
  /** The version of the `claude` a new session would start (null: none on PATH / unreadable). Local. `fresh` = ask the program
   *  itself, no memo: a wrapper script never changes on disk when what it runs is updated. */
  installed(fresh: boolean): Promise<string | null>;
  /** The version the followed channel publishes (null: the network did not answer). */
  published(): Promise<string | null>;
  /** Runs `claude update` to its end. NEVER rejects. */
  update(): Promise<UpdateRunResult>;
  push(state: ClaudeCodeUpdateState): void;
  info?(msg: string): void;
}

export interface ClaudeCodeUpdateMonitor {
  /** Asks the network (boot, then every few hours). */
  checkPublished(): Promise<void>;
  /** Re-reads the installed version only (the short poll): an update made elsewhere clears the notice. */
  checkInstalled(): Promise<void>;
  /** « Mettre à jour » / « Réessayer »: runs the command to its end. Nothing to update, or already running ⇒ nothing started. */
  run(): Promise<void>;
  /** « OK » on « installé »: the notice goes away. */
  acknowledge(): void;
  current(): ClaudeCodeUpdateState;
}

export function createClaudeCodeUpdateMonitor(deps: ClaudeCodeUpdateDeps): ClaudeCodeUpdateMonitor {
  let state: ClaudeCodeUpdateState = CLAUDE_CODE_UPDATE_NONE;
  let installed: string | null = null;
  let published: string | null = null;

  function set(next: ClaudeCodeUpdateState): void {
    if (claudeCodeUpdateStateKey(next) === claudeCodeUpdateStateKey(state)) return;
    state = next;
    deps.push(state);
  }
  /** « en cours » ends with the command, « installé » with the human: a check never replaces either. « échec » ends at the next
   *  network check or once there is nothing left to install (updated elsewhere) — not at a mere re-read. */
  function settle(networkCheck: boolean): void {
    if (state.kind === 'running' || state.kind === 'installed') return;
    const next = decideClaudeCodeUpdate(installed, published);
    if (state.kind === 'failed' && !networkCheck && next.kind === 'available') return;
    set(next);
  }
  async function readInstalled(networkCheck: boolean): Promise<void> {
    const now = await deps.installed(networkCheck);
    // unreadable at a mere re-read (the link mid-swap) is UNKNOWN, not gone: keep what was known until a network check
    if (now === null && !networkCheck) return;
    installed = now;
    settle(networkCheck);
  }
  async function update(from: string, target: string): Promise<void> {
    set({ kind: 'running', installed: from, published: target });
    let result: UpdateRunResult;
    let now: string | null = from;
    try {
      result = await deps.update();
      now = await deps.installed(true);
    } catch (e) {
      // never leave « en cours » (a disabled button) behind
      result = { code: null, stdout: '', stderr: e instanceof Error ? e.message : String(e) };
    }
    // the proof is the installed version, not the exit code: a command that ends well but installs nothing has not updated
    if (now === null) {
      // …and a version that cannot be read proves nothing either way: back to « disponible », the next re-read settles it
      deps.info?.(`claude update ended (code ${result.code}) but the installed version cannot be read`);
      set({ kind: 'available', installed: from, published: target });
    } else if (now !== from) {
      installed = now;
      deps.info?.(`Claude Code updated ${from} → ${now}`);
      set({ kind: 'installed', from, version: now });
    } else {
      const error = updateFailureText(result);
      deps.info?.(`claude update installed nothing (code ${result.code}): ${error.split('\n')[0]}`);
      set({ kind: 'failed', installed: from, published: target, error });
    }
  }
  return {
    async checkPublished() {
      // a check the network did not answer is not « up to date »: keep the last known version
      published = (await deps.published()) ?? published;
      await readInstalled(true);
    },
    checkInstalled: () => readInstalled(false),
    run() {
      // « en cours » is not a state to start from: a second click while the command runs starts nothing
      if (state.kind !== 'available' && state.kind !== 'failed') return Promise.resolve();
      return update(state.installed, state.published);
    },
    acknowledge() {
      if (state.kind === 'installed') set(decideClaudeCodeUpdate(installed, published));
    },
    current: () => state,
  };
}

// ---- the real edges (still Electron-free): the env, the command, the network ----

/** The env `claude update` runs in: the app's own — as if typed in a terminal — under NO Compte. The install is the same for every
 *  Compte, and the command writes into the config it runs under (it sets `installMethod`): never a Compte's, so no CLAUDE_CONFIG_DIR. */
export function updateCommandEnv(base: Record<string, string | undefined> = process.env): Record<string, string> {
  const env = childEnv(base);
  delete env.CLAUDE_CONFIG_DIR;
  return env;
}

const OUTPUT_MAX = 64 * 1024;

/** Runs `<bin> update` from `cwd` to its end. NEVER rejects: a command that cannot start, or is killed at the deadline, ends with
 *  code null and the reason on stderr. */
export function runClaudeUpdate(bin: string, o: { env: Record<string, string>; cwd: string; timeoutMs: number }): Promise<UpdateRunResult> {
  const { env, cwd, timeoutMs } = o;
  return new Promise((resolve) => {
    let stdout = '', stderr = '', done = false;
    const finish = (r: UpdateRunResult) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(r);
    };
    const child = spawn(bin, ['update'], { env, cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish({ code: null, stdout, stderr: `${stderr}mise à jour interrompue après ${Number((timeoutMs / 1000).toFixed(1))} s sans réponse` });
    }, timeoutMs);
    child.stdout?.on('data', (c: Buffer) => (stdout = (stdout + c.toString('utf8')).slice(-OUTPUT_MAX)));
    child.stderr?.on('data', (c: Buffer) => (stderr = (stderr + c.toString('utf8')).slice(-OUTPUT_MAX)));
    child.on('error', (e) => finish({ code: null, stdout, stderr: `${stderr}${e.message}` }));
    child.on('close', (code) => finish({ code, stdout, stderr }));
  });
}

/** The version a channel URL publishes, or null (no answer in time, an error status, anything that is not a bare version). */
export async function readPublishedVersion(url: string, timeoutMs: number): Promise<string | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'follow', cache: 'no-store' });
    if (!res.ok) return null;
    return parsePublishedVersion((await res.text()).slice(0, 64));
  } catch {
    return null;
  }
}
