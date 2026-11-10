// « Mise à jour disponible » — the HOST: which `claude` and which channel, the two clocks (the network every 6 h, the installed
// version every 30 s — an update made in a terminal clears the notice by itself), the `claudeCodeUpdate:*` IPC, and « Mettre à jour »
// = `claude update` under no Compte. Logic: claude-code-update.ts / shared/claude-code-update.ts.
import { ipcMain } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { platform } from './platform';
import { scoped } from './logger';
import { claudeBinaryVersion, resolveClaudeBinary } from './claude-binary';
import { createClaudeCodeUpdateMonitor, readPublishedVersion, runClaudeUpdate, updateCommandEnv, type ClaudeCodeUpdateMonitor } from './claude-code-update';
import { CLAUDE_CODE_RELEASES_URL, publishedVersionUrl, updateChannel, type ClaudeCodeUpdateState } from '../shared/claude-code-update';

const log = scoped('claude-code-update');
export const CLAUDE_CODE_UPDATE_PULL_CHANNEL = 'claudeCodeUpdate:state';
export const CLAUDE_CODE_UPDATE_PUSH_CHANNEL = 'claudeCodeUpdate:update';
export const CLAUDE_CODE_UPDATE_RUN_CHANNEL = 'claudeCodeUpdate:run';
export const CLAUDE_CODE_UPDATE_ACK_CHANNEL = 'claudeCodeUpdate:ack';
const PUBLISHED_CHECK_MS = 6 * 60 * 60_000;
const INSTALLED_POLL_MS = 30_000;
const NETWORK_TIMEOUT_MS = 15_000;
/** Measured 6 s on a fast link (2.1.310 → 2.1.322, ~340 MB). The command says nothing while it downloads, so there is no progress
 *  to bound on: an hour lets a 1 Mbit/s link finish, and a wedged run still ends (« en cours » disables the button). */
const UPDATE_TIMEOUT_MS = 60 * 60_000;

/** ORCHESTRA_CLAUDE_RELEASES_URL points the e2e rig at a local server; captured at module load like ORCHESTRA_INSTALLED_APP. */
const RELEASES_URL = process.env.ORCHESTRA_CLAUDE_RELEASES_URL || CLAUDE_CODE_RELEASES_URL;

let monitor: ClaudeCodeUpdateMonitor | null = null;
let stopClocks: (() => void) | null = null;

/** The `claude` a new session would start — the app's own PATH, re-resolved each time (it can be installed while the app runs). */
function claudeBin(): string | null {
  return resolveClaudeBinary(updateCommandEnv());
}

/** The channel of the settings `claude update` reads when it runs under no Compte: the Configuration source's. */
function channelNow() {
  try {
    return updateChannel(fs.readFileSync(path.join(os.homedir(), '.claude', 'settings.json'), 'utf8'));
  } catch {
    return updateChannel(null);
  }
}

export function claudeCodeUpdateState(): ClaudeCodeUpdateState {
  return monitor?.current() ?? { kind: 'none' };
}

export function startClaudeCodeUpdate(): void {
  if (monitor) return;
  const m = (monitor = createClaudeCodeUpdateMonitor({
    installed: async (fresh) => {
      const bin = claudeBin();
      return bin ? claudeBinaryVersion(bin, { fresh }) : null;
    },
    published: () => readPublishedVersion(publishedVersionUrl(RELEASES_URL, channelNow()), NETWORK_TIMEOUT_MS),
    update: async () => {
      const bin = claudeBin();
      if (!bin) return { code: null, stdout: '', stderr: 'claude est introuvable sur le PATH' };
      log.info(`running ${bin} update`);
      // from the home directory, like a terminal: no project settings of some other directory decide the channel
      return runClaudeUpdate(bin, { env: updateCommandEnv(), cwd: os.homedir(), timeoutMs: UPDATE_TIMEOUT_MS });
    },
    push: (s) => {
      log.info(`state → ${s.kind}${s.kind === 'available' ? ` (${s.installed} → ${s.published})` : ''}`);
      platform.broadcast(CLAUDE_CODE_UPDATE_PUSH_CHANNEL, s);
    },
    info: (msg) => log.info(msg),
  }));
  void m.checkPublished();
  const network = setInterval(() => void m.checkPublished(), PUBLISHED_CHECK_MS);
  const local = setInterval(() => void m.checkInstalled(), INSTALLED_POLL_MS);
  network.unref?.();
  local.unref?.();
  stopClocks = () => {
    clearInterval(network);
    clearInterval(local);
  };
}

export function stopClaudeCodeUpdate(): void {
  stopClocks?.();
  stopClocks = null;
}

/** Called ONCE at module scope from index.ts. Renderer-only channels (never on the hooks socket): updating is the human's gesture. */
export function registerClaudeCodeUpdateIpc(): void {
  ipcMain.handle(CLAUDE_CODE_UPDATE_PULL_CHANNEL, (): ClaudeCodeUpdateState => claudeCodeUpdateState());
  ipcMain.handle(CLAUDE_CODE_UPDATE_RUN_CHANNEL, async (): Promise<ClaudeCodeUpdateState> => {
    await monitor?.run();
    return claudeCodeUpdateState();
  });
  ipcMain.handle(CLAUDE_CODE_UPDATE_ACK_CHANNEL, (): ClaudeCodeUpdateState => {
    monitor?.acknowledge();
    return claudeCodeUpdateState();
  });
}
