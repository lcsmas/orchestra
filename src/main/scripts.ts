import { spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { mkdir } from 'node:fs/promises';
import type { Workspace } from '../shared/types';

const SCRIPT_LOG_DIR = path.join(os.homedir(), '.orchestra', 'scripts');

async function ensureLogDir() {
  if (!fs.existsSync(SCRIPT_LOG_DIR)) {
    await mkdir(SCRIPT_LOG_DIR, { recursive: true });
  }
}

export function setupLogPath(workspaceId: string): string {
  return path.join(SCRIPT_LOG_DIR, `${workspaceId}-setup.log`);
}

export function archiveLogPath(workspaceId: string): string {
  return path.join(SCRIPT_LOG_DIR, `${workspaceId}-archive.log`);
}

export function readScriptLog(p: string): string {
  try {
    if (!fs.existsSync(p)) return '';
    return fs.readFileSync(p, 'utf8');
  } catch {
    return '';
  }
}

/** Build the `ORCHESTRA_*` env block. Mirrors what Conductor injects, trimmed
 * to what orchestra actually needs. The script's cwd is already the worktree,
 * so most scripts won't read these — the exceptions are `ORCHESTRA_ROOT_PATH`
 * (for symlinking `.env` from the source repo) and `ORCHESTRA_PORT` (for
 * non-colliding dev servers). */
export function buildScriptEnv(ws: Workspace): Record<string, string> {
  const env: Record<string, string> = {
    ORCHESTRA_WORKSPACE_PATH: ws.worktreePath,
    ORCHESTRA_ROOT_PATH: ws.repoPath,
    ORCHESTRA_BRANCH: ws.branch,
  };
  if (typeof ws.port === 'number') env.ORCHESTRA_PORT = String(ws.port);
  return env;
}

/** Build the argv for running `script` under the user's interactive login shell.
 * We use `$SHELL` (not hardcoded `bash`) with `-i` because version managers like
 * nvm install their shell *function* into the interactive rc — `~/.zshrc` for a
 * zsh user, `~/.bashrc` for bash — which a non-interactive or login-only shell
 * never sources. A hardcoded `bash -lc` reads `~/.bash_profile`/`~/.bashrc` and
 * never touches `~/.zshrc`, so `nvm` is undefined for zsh users. Mirrors how
 * `shell-env` (`$SHELL -ilc env`) captures the env at startup. */
export function loginShellArgv(script: string): { command: string; args: string[] } {
  return { command: process.env.SHELL || 'bash', args: ['-ilc', script] };
}

export interface OneShotResult {
  exitCode: number;
  /** Last non-empty line of stderr, or '' if none. Surfaces in the UI as
   * `setupError` so the user sees the gist without opening the log. */
  lastStderrLine: string;
}

/** Run a one-shot script (setup, archive) under the user's interactive login
 * shell (see `loginShellArgv`), capture both streams to `logFile`, return exit
 * code. Running it the way the user's terminal would makes `pnpm`, `nvm`, etc.
 * resolve to the same versions they see interactively — important on Linux
 * desktops where the desktop launcher's PATH is bare. */
export async function runOneShot(opts: {
  script: string;
  cwd: string;
  env: Record<string, string>;
  logFile: string;
}): Promise<OneShotResult> {
  await ensureLogDir();
  return new Promise<OneShotResult>((resolve) => {
    let logStream: fs.WriteStream;
    try {
      logStream = fs.createWriteStream(opts.logFile, { flags: 'w' });
    } catch (err) {
      resolve({ exitCode: -1, lastStderrLine: `failed to open log: ${(err as Error).message}` });
      return;
    }

    const header = `$ ${opts.script.split('\n').join('\n  ')}\n--- ORCHESTRA_* env ---\n`;
    logStream.write(header);
    for (const [k, v] of Object.entries(opts.env)) {
      if (k.startsWith('ORCHESTRA_')) logStream.write(`${k}=${v}\n`);
    }
    logStream.write('--- output ---\n');

    let lastStderrLine = '';
    let proc;
    try {
      const { command, args } = loginShellArgv(opts.script);
      proc = spawn(command, args, {
        cwd: opts.cwd,
        env: { ...process.env, ...opts.env },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      logStream.end(`spawn failed: ${(err as Error).message}\n`);
      resolve({ exitCode: -1, lastStderrLine: (err as Error).message });
      return;
    }

    proc.stdout?.on('data', (chunk: Buffer) => logStream.write(chunk));
    proc.stderr?.on('data', (chunk: Buffer) => {
      logStream.write(chunk);
      const text = chunk.toString('utf8');
      const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      if (lines.length > 0) lastStderrLine = lines[lines.length - 1];
    });

    proc.on('error', (err) => {
      logStream.end(`\nspawn error: ${err.message}\n`);
      resolve({ exitCode: -1, lastStderrLine: err.message });
    });

    proc.on('exit', (code) => {
      logStream.end(`\n--- exit ${code ?? 'null'} ---\n`);
      resolve({ exitCode: code ?? -1, lastStderrLine });
    });
  });
}
