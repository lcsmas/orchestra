import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { platform, orchestraHome } from './platform';
import { store } from './store';
import {
  detectRemoteUrl,
  getDiff,
  findPullRequest,
  listBranches,
  getDiffStats,
} from './git';
import {
  verifyLinearIssue,
  verifyLinearApiKey,
  getLinearKeySource,
  resetLinearAuthState,
} from './linear';
import { setLinearApiKey, clearLinearApiKey } from './secrets';
import { getEnvStatus } from './env-status';
import {
  addRepoByPath,
  removeRepoByPath,
  archiveWorkspace,
  createWorkspace,
  createScratchWorkspace,
  createOrchestratorWorkspace,
  deleteWorkspace,
  deleteWorkspaces,
  dispatchAttachRequest,
  dispatchDemoteRequest,
  dispatchMigrateAccountRequest,
  dispatchPromoteRequest,
  ensureWorkspacePort,
  getWorktreeSizes,
  renameWorkspaceBranch,
  runSetupScript,
  startAgentPty,
  switchWorkspaceBranch,
  unarchiveWorkspace,
} from './workspaces';
import { buildScriptEnv, loginShellArgv, readScriptLog, setupLogPath } from './scripts';
import {
  repaintPty,
  resizePty,
  startPty,
  stopPty,
  writePty,
  readScrollback,
  isRunning,
} from './pty';
import { sampleResources } from './resources';
import { getHookSocketPath } from './hooks-server';
import { installLoginBrowserShim } from './cli-shim';
import { getLastUsage } from './usage';
import {
  getAccountUsage,
  snapshotAccountUsage,
  computeWorkspaceAccounts,
  refreshAccountsNow,
  accountConfigDir,
  armLoginWatch,
  cancelLoginWatch,
} from './account-usage';
import { listInheritables, syncAccountInheritance, syncAllAccountsInheritance } from './account-inherit';
import { getSandboxControlState, takeSandboxControl } from './transport/sandbox-manager';
import {
  importWorkspaceToSandbox,
  ejectWorkspaceFromSandbox,
  backupSandboxWorkspace,
} from './sandbox-import';
import {
  detectAndUpdateBranchName,
  detectAndUpdateMergeState,
  detectAndUpdateReleaseState,
  reconcileExited,
} from './activity';
import { snapshotSyncStates, syncOneRepo } from './repo-sync';
import { addQueuedPrompt, removeQueuedPrompt, flushQueuedPrompts } from './prompt-queue';
import {
  getSelfTuneOutput,
  getSelfTuneRuns,
  listSelfTuneReports,
  openSelfTuneReport,
  readSelfTuneLessons,
  startSelfTuneRun,
} from './self-tune';
import { dispatchLoginUrlRequest } from './login-url';
import {
  sdkSend,
  sdkInterrupt,
  sdkPermissionReply,
  sdkSetModel,
  sdkSetPermissionMode,
  sdkSetRemoteControl,
  sdkHistory,
  sdkListSkills,
  sdkStopMany,
} from './agent-sdk';
import { probeDependencies, type DepsStatus } from './deps';
import { log, revealLogs, getLogFile } from './logger';
import type { OrchestraAPI } from '../shared/ipc';
import type { Account, CreateWorkspaceInput, DiffFile, RepoScripts, Workspace } from '../shared/types';

// The single shared request/response surface of the backend, extracted from
// index.ts's inline `ipcMain.handle` registrations. The table is keyed by
// `OrchestraAPI` MEMBER NAMES (src/shared/ipc.ts), not IPC channel names, and
// is consumed by BOTH transports:
//
//   • index.ts wires each entry to its historical ipcMain channel via
//     {@link METHOD_IPC_CHANNELS} — channel names unchanged, so the renderer
//     and preload never notice the extraction;
//   • the ui-rpc server (src/main/ui-rpc.ts) dispatches `req` frames straight
//     into the same entries, method name = table key, per
//     docs/ui-rpc-protocol.md §4.
//
// One source of truth, so the two surfaces cannot drift. `pickDirectory` is
// deliberately NOT here: it is frontend-local by design (native file chooser)
// and stays an Electron-only handler in index.ts. The three trailing entries
// ('deps:status' / 'app:info' / 'pty:scrollback') are the protocol's M1
// additions — they ride the same table (and get IPC channels of the same
// name, unused by today's renderer).

/** The `OrchestraAPI` member names that are request/response methods — every
 *  member except the `on*` event subscriptions. */
type ApiMethodName = {
  [K in keyof OrchestraAPI]: K extends `on${string}` ? never : K;
}[keyof OrchestraAPI];

/** The servable slice of `OrchestraAPI`: all methods minus the frontend-local
 *  `pickDirectory`. */
type ServableApi = Omit<Pick<OrchestraAPI, ApiMethodName>, 'pickDirectory'>;

/** Methods added by the ui-rpc protocol (docs/ui-rpc-protocol.md §4/§6) that
 *  are not (yet) part of the renderer-facing `OrchestraAPI`. */
export interface ExtraApiMethods {
  /** The git/gh/claude dependency probe, for frontend-rendered warnings. */
  'deps:status': () => Promise<DepsStatus>;
  /** Backend identity: version, host kind, home dir, diagnostic log path. */
  'app:info': () => Promise<{
    version: string;
    backendKind: 'electron' | 'daemon';
    orchestraHome: string;
    logPath: string;
  }>;
  /** Base64 of a PTY's scrollback tail (pty.ts readScrollback) — the GTK
   *  terminal replays it through feed() on (re)mount. */
  'pty:scrollback': (id: string) => Promise<string>;
  /** Full working-tree diff vs. the base branch. No longer used by the Electron
   *  renderer (its Diff tab was removed — Monaco was too heavy), but the native
   *  GTK frontend still has a diff view that calls this over ui-rpc, so it stays
   *  a served backend method rather than part of the renderer-facing
   *  `OrchestraAPI`. */
  getDiff: (id: string) => Promise<DiffFile[]>;
}

export type ApiHandlerTable = ServableApi & ExtraApiMethods;

/** Member name → the ipcMain channel index.ts has always registered for it.
 *  MUST stay in lockstep with src/preload/index.ts (which encodes the same
 *  mapping from the renderer side). The three protocol-added methods use
 *  their own names as channels — no renderer calls them today. */
export const METHOD_IPC_CHANNELS: Record<keyof ApiHandlerTable, string> = {
  addRepo: 'repos:add',
  removeRepo: 'repos:remove',
  listRepos: 'repos:list',
  listRepoSyncStates: 'repos:listSyncStates',
  syncRepoBase: 'repos:syncBase',
  reorderRepos: 'repos:reorder',
  listRepoBranches: 'repos:listBranches',
  setRepoDefaultBranch: 'repos:setDefaultBranch',
  openExternal: 'app:openExternal',
  getAppVersion: 'app:version',
  getEnvStatus: 'app:envStatus',
  getLinearKeySource: 'linear:keySource',
  checkLinearKey: 'linear:checkKey',
  saveLinearKey: 'linear:saveKey',
  clearLinearKey: 'linear:clearKey',
  getUsage: 'usage:get',
  listAccounts: 'accounts:list',
  setAccounts: 'accounts:set',
  setRepoAccount: 'repos:setAccount',
  migrateWorkspaceAccount: 'workspaces:migrateAccount',
  getAccountUsage: 'accounts:usage',
  getAllAccountUsage: 'accounts:usageAll',
  getWorkspaceAccounts: 'accounts:workspaceAccounts',
  accountLoginStart: 'accounts:loginStart',
  accountLoginStop: 'accounts:loginStop',
  accountLoginOpenUrl: 'accounts:loginOpenUrl',
  refreshAccounts: 'accounts:refresh',
  listGlobalInheritables: 'accounts:listGlobalInheritables',
  revealLogs: 'logs:reveal',
  logPath: 'logs:path',
  log: 'logs:write',
  listWorkspaces: 'workspaces:list',
  createWorkspace: 'workspaces:create',
  createScratchWorkspace: 'workspaces:createScratch',
  createOrchestratorWorkspace: 'workspaces:createOrchestrator',
  archiveWorkspace: 'workspaces:archive',
  unarchiveWorkspace: 'workspaces:unarchive',
  deleteWorkspace: 'workspaces:delete',
  deleteWorkspaces: 'workspaces:deleteMany',
  importToSandbox: 'workspaces:importToSandbox',
  ejectFromSandbox: 'workspaces:ejectFromSandbox',
  backupSandbox: 'sandbox:backup',
  markSeen: 'workspaces:markSeen',
  setUnread: 'workspaces:setUnread',
  promoteWorkspace: 'workspaces:promote',
  demoteWorkspace: 'workspaces:demote',
  setWorkspaceParent: 'workspaces:setParent',
  renameBranch: 'workspaces:renameBranch',
  reorderWorkspaces: 'workspaces:reorder',
  queuePrompt: 'queue:add',
  removeQueuedPrompt: 'queue:remove',
  flushQueuedPrompts: 'queue:flush',
  ptyStart: 'pty:start',
  ptyWrite: 'pty:write',
  ptyResize: 'pty:resize',
  ptyRepaint: 'pty:repaint',
  saveClipboardImage: 'clipboard:saveImage',
  restartAgent: 'agent:restart',
  stopAgent: 'agent:stop',
  agentSdkSend: 'agent:sdkSend',
  agentSdkInterrupt: 'agent:sdkInterrupt',
  agentSdkPermissionReply: 'agent:sdkPermissionReply',
  agentSdkSetModel: 'agent:sdkSetModel',
  agentSdkSetPermissionMode: 'agent:sdkSetPermissionMode',
  agentSdkSetRemoteControl: 'agent:sdkSetRemoteControl',
  agentSdkHistory: 'agent:sdkHistory',
  agentSdkOpenTaskTranscript: 'agent:sdkOpenTaskTranscript',
  agentSkills: 'agent:skills',
  nvimStart: 'nvim:start',
  sandboxControlState: 'sandbox:controlState',
  takeSandboxControl: 'sandbox:takeControl',
  getDiff: 'git:diff',
  getDiffStats: 'git:stats',
  getWorktreeSizes: 'workspaces:sizes',
  sampleResources: 'resources:sample',
  findPR: 'git:findPR',
  verifyLinear: 'linear:verify',
  listBranches: 'git:listBranches',
  switchBranch: 'git:switchBranch',
  mergeWorktree: 'git:merge',
  getRepoScripts: 'repos:getScripts',
  setRepoScripts: 'repos:setScripts',
  retrySetup: 'scripts:retrySetup',
  readSetupLog: 'scripts:readSetupLog',
  runScriptStart: 'scripts:runStart',
  runScriptStop: 'scripts:runStop',
  runScriptScrollback: 'scripts:runScrollback',
  runScriptStatus: 'scripts:runStatus',
  listSelfTuneRuns: 'selfTune:list',
  startSelfTune: 'selfTune:run',
  getSelfTuneOutput: 'selfTune:output',
  listSelfTuneReports: 'selfTune:reports',
  openSelfTuneReport: 'selfTune:openReport',
  readSelfTuneLessons: 'selfTune:lessons',
  'deps:status': 'deps:status',
  'app:info': 'app:info',
  'pty:scrollback': 'pty:scrollback',
};

// Only allow http(s) URLs out to the OS. Other schemes are ignored to avoid
// opening arbitrary things (file://, javascript:, etc.) from PTY output.
function isSafeHttpUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

/** Open a URL with the system handler iff it is a plain web URL. Shared with
 *  index.ts's window-open interception. */
export async function openUrlExternally(url: string): Promise<void> {
  if (!isSafeHttpUrl(url)) return;
  await platform.openExternal(url);
}

/** Read a workspace back after a mutation that reported success, for handlers
 *  whose contract is "return the updated record". The lookup failing here means
 *  the record vanished between the write and the read, which is a bug rather
 *  than a caller error — surface it instead of returning a stale/blank struct. */
function requireWorkspace(id: string): Workspace {
  const ws = store.getWorkspace(id);
  if (!ws) throw new Error(`unknown workspace: ${id}`);
  return ws;
}

export const apiHandlers: ApiHandlerTable = {
  // ---------- Repos ----------

  addRepo: (absPath) => addRepoByPath(absPath),

  removeRepo: (absPath) => removeRepoByPath(absPath),

  listRepos: async () => {
    // Lazy-backfill `remoteUrl` for any repo added before that field existed,
    // or whose origin URL changed since it was first mapped. Best-effort —
    // missing origin / unknown URL shape just leaves remoteUrl undefined.
    for (const r of store.repos) {
      if (r.remoteUrl) continue;
      const url = await detectRemoteUrl(r.path).catch(() => undefined);
      if (url) await store.updateRepo(r.path, { remoteUrl: url });
    }
    return store.repos;
  },

  listRepoSyncStates: async () => snapshotSyncStates(),

  syncRepoBase: (repoPath) => syncOneRepo(repoPath),

  reorderRepos: (orderedPaths) => store.reorderRepos(orderedPaths),

  listRepoBranches: async (repoPath) => {
    if (!store.repos.some((r) => r.path === repoPath)) throw new Error('unknown repo');
    return listBranches(repoPath);
  },

  // Change the branch new workspaces of a repo are cut from (its "default
  // base"). Validated against the repo's actual local branches so a typo
  // can't leave the repo pointing at a branch `git worktree add` will refuse.
  // Re-syncs the repo's sync pill immediately — it tracks `origin/<default>`.
  setRepoDefaultBranch: async (repoPath, branch) => {
    const repo = store.repos.find((r) => r.path === repoPath);
    if (!repo) throw new Error('unknown repo');
    const target = branch.trim();
    if (!target) throw new Error('branch required');
    if (target !== repo.defaultBranch) {
      const branches = await listBranches(repoPath);
      if (!branches.includes(target))
        throw new Error(`branch "${target}" does not exist in ${repo.name}`);
      await store.updateRepo(repoPath, { defaultBranch: target });
      platform.broadcast('repos:update', store.repos);
      void syncOneRepo(repoPath).catch(() => {});
    }
    return store.repos.find((r) => r.path === repoPath)!;
  },

  // ---------- App ----------

  openExternal: (url) => openUrlExternally(url),

  getAppVersion: async () => platform.getAppVersion(),

  // Optional-setup status (e.g. Linear API key present?). The renderer reads
  // this on load and on a slow poll to surface a small "needs setup" notice.
  getEnvStatus: async () => getEnvStatus(),

  // ---------- Linear API key (set in-app, stored encrypted) ----------

  getLinearKeySource: async () => getLinearKeySource(),

  checkLinearKey: (key) => verifyLinearApiKey(key),

  // Save the key (encrypted via safeStorage where available). Clears
  // verification caches so the new key takes effect immediately.
  saveLinearKey: async (key) => {
    await setLinearApiKey(key);
    resetLinearAuthState();
  },

  clearLinearKey: async () => {
    await clearLinearApiKey();
    resetLinearAuthState();
  },

  // ---------- Usage ----------

  getUsage: async () => getLastUsage(),

  // ---------- Accounts ----------

  listAccounts: async () => store.accounts,

  // Replace the whole list, then immediately recompute the workspace→account
  // map and refresh usage so the badges react without waiting for the poll.
  setAccounts: async (accounts: Account[]) => {
    const saved = await store.setAccounts(accounts);
    // Re-materialize each account's inheritance so edited selections take
    // effect immediately (symlinks added/removed, MCP servers merged/pruned).
    void syncAllAccountsInheritance();
    void refreshAccountsNow();
    return saved;
  },

  setRepoAccount: async (repoPath, accountId) => {
    const repo = await store.setRepoAccount(repoPath, accountId);
    void refreshAccountsNow();
    return repo;
  },

  // Migrate an EXISTING workspace to a different account (or back to the
  // default login with a null accountId) — relocates the pinned workspace's
  // conversation, re-pins it, auto-resumes if it was running.
  migrateWorkspaceAccount: async (id, accountId) => {
    const res = await dispatchMigrateAccountRequest({ id, accountId });
    if (!res.ok) throw new Error(res.error ?? 'migrate failed');
    void refreshAccountsNow();
    return res;
  },

  getAccountUsage: async (accountId) => getAccountUsage(accountId),

  getAllAccountUsage: async () => snapshotAccountUsage(),

  getWorkspaceAccounts: async () => computeWorkspaceAccounts(),

  // Interactive `claude /login` in an account's config dir, under the pty id
  // `account-login:<accountId>` (no workspaceId — it's not an agent). See the
  // in-body comments; behavior is unchanged from the index.ts original.
  accountLoginStart: async (accountId, cols, rows) => {
    const account = store.accounts.find((a) => a.id === accountId);
    if (!account) throw new Error('account not found');
    const dir = accountConfigDir(account);
    if (!dir) throw new Error('account has no config dir');
    const ptyId = `account-login:${accountId}`;
    if (isRunning(ptyId)) {
      repaintPty(ptyId, cols, rows);
      return;
    }
    // Ensure the dir exists so Claude Code can write its credentials there,
    // and materialize the account's inherited config so the login session
    // itself has the user's settings/skills/MCP (not just a bare creds dir).
    await fs.promises.mkdir(dir, { recursive: true });
    await syncAccountInheritance(account).catch((err) =>
      log.warn('account-inherit: login-time sync failed', err),
    );
    // `claude /login` does NOT exit after authenticating — watch the config
    // dir: once a fresh OAuth token lands, kill the PTY, close the account's
    // OAuth surface, and tell the frontend login is done.
    armLoginWatch(account, () => {
      if (isRunning(ptyId)) stopPty(ptyId);
      platform.closeAccountLogin(accountId);
      platform.broadcast('accounts:loginDone', accountId);
      void refreshAccountsNow();
    });
    // Intercept claude's automatic browser-open so the OAuth page lands in
    // this account's ISOLATED login surface, not the system browser whose
    // claude.ai session is the user's main account. The shim dir shadows
    // xdg-open/open on PATH for this PTY only.
    const shimDir = installLoginBrowserShim();
    const sock = getHookSocketPath();
    // The PATH we set below goes through the user's LOGIN shell, whose
    // profile may rebuild PATH and push the shim behind the real /usr/bin
    // openers — so re-prepend it in the command itself. Skipped for fish,
    // which doesn't parse POSIX prefix assignment.
    const shell = path.basename(process.env.SHELL || 'bash');
    const loginScript =
      shimDir && shell !== 'fish'
        ? `PATH=${JSON.stringify(shimDir)}:"$PATH" claude /login`
        : 'claude /login';
    const { command, args } = loginShellArgv(loginScript);
    await startPty({
      id: ptyId,
      cwd: dir,
      command,
      args,
      cols,
      rows,
      extraEnv: {
        CLAUDE_CONFIG_DIR: dir,
        ORCHESTRA_LOGIN_ACCOUNT: accountId,
        ...(sock ? { ORCHESTRA_SOCK: sock } : {}),
        ...(shimDir
          ? {
              PATH: `${shimDir}${path.delimiter}${process.env.PATH ?? ''}`,
              // Belt-and-braces for openers that honor $BROWSER over PATH.
              BROWSER: path.join(shimDir, 'xdg-open'),
            }
          : {}),
      },
    });
  },

  accountLoginStop: async (accountId) => {
    cancelLoginWatch(accountId);
    platform.closeAccountLogin(accountId);
    const ptyId = `account-login:${accountId}`;
    if (isRunning(ptyId)) stopPty(ptyId);
  },

  // Link clicked inside the login modal's terminal. Same routing as the shim
  // path: Claude OAuth pages open in the account's isolated login surface,
  // anything else externally.
  accountLoginOpenUrl: async (accountId, url) => {
    const res = dispatchLoginUrlRequest({ accountId, url });
    if (!res.ok) throw new Error(res.error ?? 'failed to open url');
  },

  refreshAccounts: () => refreshAccountsNow(),

  listGlobalInheritables: async () => listInheritables(),

  // ---------- Diagnostic logs ----------

  revealLogs: () => revealLogs(),

  logPath: async () => getLogFile(),

  // Forward renderer/frontend logs into the same file so a single artifact
  // captures every process. Level is clamped to the known set.
  log: async (level, message, meta) => {
    const fn =
      level === 'error'
        ? log.error
        : level === 'warn'
          ? log.warn
          : level === 'debug'
            ? log.debug
            : log.info;
    fn(`[renderer] ${message}`, meta);
  },

  // ---------- Workspaces ----------

  listWorkspaces: async () => store.workspaces,

  createWorkspace: (input: CreateWorkspaceInput) => createWorkspace(input),

  createScratchWorkspace: () => createScratchWorkspace(),

  createOrchestratorWorkspace: () => createOrchestratorWorkspace(),

  archiveWorkspace: (id) => {
    sdkStopMany([id]);
    return archiveWorkspace(id);
  },

  unarchiveWorkspace: (id) => unarchiveWorkspace(id),

  deleteWorkspace: (id) => {
    sdkStopMany([id]);
    return deleteWorkspace(id);
  },

  deleteWorkspaces: (ids) => {
    sdkStopMany(ids);
    return deleteWorkspaces(ids, (done, total) => {
      platform.broadcast('workspaces:deleteProgress', done, total);
    });
  },

  importToSandbox: (id, endpoint) => importWorkspaceToSandbox(id, endpoint),

  ejectFromSandbox: (id) => ejectWorkspaceFromSandbox(id),

  backupSandbox: (id) => backupSandboxWorkspace(id),

  markSeen: async (id) => {
    const ws = store.getWorkspace(id);
    if (!ws || ws.archived) return;
    if (ws.status !== 'waiting') return;
    const updated: Workspace = { ...ws, status: 'idle' };
    await store.upsertWorkspace(updated);
    platform.broadcast('workspace:update', updated);
  },

  setUnread: async (id, unread) => {
    const ws = store.getWorkspace(id);
    if (!ws || !!ws.markedUnread === !!unread) return;
    // Drop the key entirely when clearing so store.json doesn't accumulate
    // `markedUnread: false` on every workspace that was ever tagged.
    const updated: Workspace = { ...ws, markedUnread: unread || undefined };
    await store.upsertWorkspace(updated);
    platform.broadcast('workspace:update', updated);
  },

  // The dispatch* entry points are the socket/CLI contract and answer an
  // `{ ok, error }` envelope rather than throwing. On the wire an envelope
  // inside a result would be a second, redundant error channel — the frame
  // already carries `{ ok: false, error }` — so unwrap here: reject on failure
  // (the rejection becomes the frame-level error) and hand back the fresh
  // record so the caller can assert the transition it just asked for.
  promoteWorkspace: async (id) => {
    const res = await dispatchPromoteRequest({ id });
    if (!res.ok) throw new Error(res.error || 'promote failed');
    return requireWorkspace(id);
  },

  demoteWorkspace: async (id) => {
    const res = await dispatchDemoteRequest({ id });
    if (!res.ok) throw new Error(res.error || 'demote failed');
    return requireWorkspace(id);
  },

  setWorkspaceParent: async (id, parentId) => {
    const res = await dispatchAttachRequest({ id, parentId });
    if (!res.ok) throw new Error(res.error || 'set parent failed');
    return requireWorkspace(id);
  },

  renameBranch: (id, newBranch) => renameWorkspaceBranch(id, newBranch, { manual: true }),

  reorderWorkspaces: (orderedIds) => store.reorderWorkspaces(orderedIds),

  // ---------- Prompt queue (usage-limited accounts) ----------

  queuePrompt: (id, text) => addQueuedPrompt(id, text),

  removeQueuedPrompt: (id, promptId) => removeQueuedPrompt(id, promptId),

  // The UI's "Send now" — deliver regardless of what the usage cache says.
  flushQueuedPrompts: (id) => flushQueuedPrompts(id, { force: true }),

  // ---------- Terminal (pty) ----------

  ptyStart: async (id, cols, rows) => {
    const ws = store.getWorkspace(id);
    if (!ws) throw new Error('workspace not found');
    if (isRunning(id)) {
      // Renderer remounted (HMR / reload) but the PTY is still alive. The
      // fresh xterm canvas is blank and Claude has no reason to repaint on
      // their own, so bounce the size to force a SIGWINCH-driven redraw.
      repaintPty(id, cols, rows);
      return;
    }
    // Spawn the agent PTY. The resume gate (`claude --continue` only when the
    // user has actually submitted a prompt — ws.hasInput), hook install, and
    // env setup all live in startAgentPty, shared with the account-migration
    // resume. This is also where a workspace that was running before an app
    // restart comes back to life — deliberately on first open, never at boot.
    const resuming = ws.hasInput === true;
    await startAgentPty(ws, cols, rows);
    // Preserve the `waiting` yellow dot across restarts; only clear stale
    // `running` state left over from a prior crash.
    if (ws.status === 'running') {
      const updated: Workspace = { ...ws, status: 'idle' };
      await store.upsertWorkspace(updated);
      platform.broadcast('workspace:update', updated);
    }
    // First-ever spawn: pipe the initial task (if any) into the agent once it
    // has had a moment to initialize its TUI.
    if (!resuming && ws.lastTask) {
      const task = ws.lastTask;
      setTimeout(() => {
        writePty(id, task + '\n');
        // Status flips to running once Claude fires its UserPromptSubmit hook.
      }, 1200);
    }
  },

  ptyWrite: async (id, data) => {
    const submitted = data.includes('\r') || data.includes('\n');
    // Heavy-resume gate (armed in startAgentPty when `claude --continue` is
    // about to reload a large session). While armed, Claude Code is showing
    // its compaction menu; a typed task + Enter would proceed the FULL resume
    // and drain the usage pool. See the branch comments below.
    const wsGate = store.getWorkspace(id);
    if (wsGate?.heavyResumePending) {
      // ESC is '\x1b'; arrows are '\x1b[A'… Any escape sequence here =
      // deliberate menu navigation → disarm and let the input through.
      if (data.includes('\x1b')) {
        const updated = { ...wsGate, heavyResumePending: false };
        await store.upsertWorkspace(updated);
        platform.broadcast('workspace:update', updated);
        return writePty(id, data);
      }
      if (submitted) {
        // Blind submit into a heavy resume — suppress so it can't proceed the
        // full-context resume. The user navigates CC's menu (arrow/Esc) to
        // disarm, then their Enter answers the menu for real.
        return;
      }
      // non-submit, non-escape keystroke (typing) — pass through harmlessly.
      return writePty(id, data);
    }
    // Flip hasInput the first time the user actually submits something. This
    // is what gates `claude --continue` on the next PTY start. Activity
    // status itself flips from Claude's own UserPromptSubmit hook.
    if (submitted) {
      const ws = store.getWorkspace(id);
      if (ws && !ws.hasInput) {
        const updated = { ...ws, hasInput: true };
        await store.upsertWorkspace(updated);
        platform.broadcast('workspace:update', updated);
      }
    }
    return writePty(id, data);
  },

  ptyResize: async (id, cols, rows) => resizePty(id, cols, rows),

  // Force a full child repaint via a SIGWINCH bounce — the only reliable heal
  // when a frontend terminal's state diverged from the child TUI's per-cell
  // diff-render model (the "scattered words" garble).
  ptyRepaint: async (id, cols, rows) => repaintPty(id, cols, rows),

  // Clipboard image paste: spill the renderer-read image bytes to a temp file
  // and return the path for a bracketed paste (Claude auto-attaches it).
  saveClipboardImage: async (mime, bytes) => {
    if (!bytes || bytes.byteLength === 0) return null;
    const ext =
      mime === 'image/jpeg'
        ? 'jpg'
        : mime === 'image/gif'
          ? 'gif'
          : mime === 'image/webp'
            ? 'webp'
            : 'png';
    const dir = path.join(os.tmpdir(), 'orchestra-paste');
    await fs.promises.mkdir(dir, { recursive: true });
    // Prune stale spills so the temp dir doesn't grow unbounded. Best-effort —
    // a file Claude is mid-read on is days younger than the cutoff anyway.
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    try {
      for (const name of await fs.promises.readdir(dir)) {
        const fp = path.join(dir, name);
        const st = await fs.promises.stat(fp).catch(() => null);
        if (st && st.mtimeMs < cutoff) await fs.promises.unlink(fp).catch(() => {});
      }
    } catch {
      // ignore prune failures
    }
    const file = path.join(dir, `paste-${Date.now()}-${process.pid}.${ext}`);
    await fs.promises.writeFile(file, Buffer.from(bytes));
    return file;
  },

  restartAgent: async (id) => {
    // Mirror the branch-switch path: stop the agent PTY (the frontend's
    // terminal just resets) and tell it to spawn a fresh PTY. `pty:start`
    // picks `claude --continue` since ws.hasInput is true, which is what
    // makes MCP/settings.json edits take effect.
    if (!isRunning(id)) return;
    stopPty(id);
    platform.broadcast('pty:restart', id);
  },

  stopAgent: async (id) => {
    // The Resources page's per-agent stop: kill the agent PTY and do NOT
    // respawn. stopPty disposes the transport listeners before killing, so
    // the exit handler's reconciliation floor never fires on this path —
    // reconcile the status dot here. `pty:stopped` lets the terminal show
    // the stop and re-arm its lazy start.
    if (!isRunning(id)) return;
    stopPty(id);
    reconcileExited(id);
    platform.broadcast('pty:stopped', id);
  },

  // ---------- Structured agent view (Claude Agent SDK) ----------
  // The reverse path into the per-workspace SDK session manager (agent-sdk.ts).
  // Each starts/reuses the workspace's lazy session; the forward event stream
  // is broadcast on `agent:event` from that module.

  agentSdkSend: async (wsId, text, images) => {
    await sdkSend(wsId, text, images);
  },

  agentSdkInterrupt: async (wsId) => {
    await sdkInterrupt(wsId);
  },

  agentSdkPermissionReply: async (wsId, requestId, reply) => {
    sdkPermissionReply(wsId, requestId, reply);
  },

  agentSdkSetModel: async (wsId, model) => {
    await sdkSetModel(wsId, model);
  },

  agentSdkSetPermissionMode: async (wsId, mode) => {
    await sdkSetPermissionMode(wsId, mode);
  },

  agentSdkSetRemoteControl: async (wsId, enabled) => {
    await sdkSetRemoteControl(wsId, enabled);
  },

  agentSdkHistory: async (wsId) => sdkHistory(wsId),

  // Open a finished background-task's transcript file (the SDK
  // `task_notification.output_file`) with the OS handler, mirroring how
  // self-tune reports open. Returns false when the path is missing or not a
  // real file (a stale/incomplete task) so the caller can no-op quietly rather
  // than surfacing an error. Guarded to a regular file to avoid opening a
  // directory or a non-existent path the renderer happened to hold.
  agentSdkOpenTaskTranscript: async (filePath) => {
    if (typeof filePath !== 'string' || filePath.length === 0) return false;
    try {
      if (!fs.statSync(filePath).isFile()) return false;
    } catch {
      return false;
    }
    const err = await platform.openPath(filePath);
    if (err) throw new Error(err);
    return true;
  },

  agentSkills: async (wsId) => sdkListSkills(wsId),

  nvimStart: async (id, cols, rows) => {
    const ws = store.getWorkspace(id);
    if (!ws) throw new Error('workspace not found');
    const nvimId = `${id}:nvim`;
    if (isRunning(nvimId)) {
      // Renderer remounted — nudge a repaint.
      repaintPty(nvimId, cols, rows);
      return;
    }
    await startPty({
      id: nvimId,
      cwd: ws.worktreePath,
      command: 'nvim',
      args: ['.'],
      cols,
      rows,
    });
  },

  // ---------- Sandbox cross-machine ownership ----------

  sandboxControlState: async (id) => {
    const ws = store.getWorkspace(id);
    if (ws?.host?.kind !== 'sandbox') return null;
    return getSandboxControlState(ws.host.endpoint);
  },

  takeSandboxControl: async (id) => {
    const ws = store.getWorkspace(id);
    if (ws?.host?.kind !== 'sandbox') return;
    takeSandboxControl(ws.host.endpoint);
  },

  // ---------- Git / Diff ----------

  // Served for the native GTK frontend's diff view (the Electron renderer no
  // longer has a Diff tab). See the ExtraApiMethods declaration above.
  getDiff: async (id) => {
    const ws = store.getWorkspace(id);
    if (!ws) throw new Error('workspace not found');
    if (ws.kind === 'scratch') return []; // non-git dir — no diff against a base
    return getDiff(ws.worktreePath, ws.baseBranch);
  },

  getDiffStats: async (id) => {
    const ws = store.getWorkspace(id);
    if (!ws) throw new Error('workspace not found');
    // Scratch sessions aren't git-backed: no diff stats, and none of the
    // merge / branch reconciliation below applies.
    if (ws.kind === 'scratch') return { additions: 0, deletions: 0, files: 0 };
    // Piggyback merge/unpushed state refresh on the renderer's 8s stats poll.
    void detectAndUpdateMergeState(id).catch(() => {});
    // Same cadence: catch branches renamed outside orchestra so the stored
    // branch name doesn't drift from what's actually checked out.
    void detectAndUpdateBranchName(id).catch(() => {});
    return getDiffStats(ws.worktreePath, ws.baseBranch);
  },

  getWorktreeSizes: () => getWorktreeSizes(),

  // One live resource sample. Pulled by the Resources page on its own 2s
  // visible poll — no standing poller in main.
  sampleResources: () => sampleResources(),

  findPR: async (id) => {
    const ws = store.getWorkspace(id);
    if (!ws) throw new Error('workspace not found');
    if (ws.kind === 'scratch') return { all: [], open: null, latest: null, mergedCount: 0 };
    // Piggyback release detection on the PR poll — never on the hot stats
    // poll; the underlying computation is memoized on (branch tip, releases).
    void detectAndUpdateReleaseState(id).catch(() => {});
    return findPullRequest(ws.repoPath, ws.branch);
  },

  verifyLinear: async (id) => {
    const ws = store.getWorkspace(id);
    if (!ws) throw new Error('workspace not found');
    // Scratch sessions have no git branch encoding an issue; skip the spawn.
    if (ws.kind === 'scratch') return null;
    return verifyLinearIssue(ws.branch);
  },

  listBranches: async (id) => {
    const ws = store.getWorkspace(id);
    if (!ws) throw new Error('workspace not found');
    return listBranches(ws.repoPath);
  },

  switchBranch: (id, branch) => switchWorkspaceBranch(id, branch),

  mergeWorktree: async (id) => {
    const ws = store.getWorkspace(id);
    if (!ws) throw new Error('workspace not found');

    // Hand the merge off to the agent: it has full context of the work it
    // just did and writes its own commit messages along the way. To update
    // the base branch it must operate on the main repo via `git -C` since the
    // worktree's HEAD is pinned.
    const prompt =
      `Please merge this branch into \`${ws.baseBranch}\` and push.\n\n` +
      `- Feature branch: \`${ws.branch}\` (current worktree HEAD)\n` +
      `- Base branch: \`${ws.baseBranch}\`\n` +
      `- Main repo path: \`${ws.repoPath}\`\n\n` +
      `If there are uncommitted changes, commit them first with a clear message. ` +
      `Then run the merge against the main repo (use \`git -C "${ws.repoPath}" ...\` so the worktree HEAD stays put), ` +
      `and \`git push\` the base branch. ` +
      `Tell me when it's done or if anything goes wrong.`;

    writePty(id, prompt);
    setTimeout(() => writePty(id, '\r'), 80);

    return { status: 'requested' as const };
  },

  // ---------- Repo scripts (setup / run / archive) ----------

  getRepoScripts: async (repoPath) => store.getRepoScripts(repoPath),

  setRepoScripts: (repoPath, scripts: RepoScripts) => store.setRepoScripts(repoPath, scripts),

  retrySetup: (id) => runSetupScript(id),

  readSetupLog: async (id) => readScriptLog(setupLogPath(id)),

  runScriptStart: async (id, cols, rows) => {
    const ws0 = store.getWorkspace(id);
    if (!ws0) throw new Error('workspace not found');
    const script = store.getRepoScripts(ws0.repoPath).run;
    if (!script) throw new Error('no run script configured for this repo');
    // Lazy port allocation for legacy workspaces created before scripts.
    const ws = (await ensureWorkspacePort(id)) ?? ws0;
    const runId = `${id}:run`;
    if (isRunning(runId)) {
      resizePty(runId, Math.max(20, cols - 1), Math.max(5, rows));
      setTimeout(() => resizePty(runId, cols, rows), 40);
      return;
    }
    const { command, args } = loginShellArgv(script);
    await startPty({
      id: runId,
      cwd: ws.worktreePath,
      command,
      args,
      cols,
      rows,
      // Run pty inherits ORCHESTRA_* via the env passed at spawn time. The
      // agent hook env (ORCHESTRA_SOCK, ORCHESTRA_WS_ID) is intentionally
      // absent — the run script isn't an agent.
      extraEnv: buildScriptEnv(ws),
    });
  },

  runScriptStop: async (id) => {
    stopPty(`${id}:run`);
  },

  runScriptScrollback: async (id) => readScrollback(`${id}:run`),

  runScriptStatus: async (id) => isRunning(`${id}:run`),

  // ---------- Insights & Improvements (monthly self-tune) ----------

  listSelfTuneRuns: async () => getSelfTuneRuns(),

  startSelfTune: async () => startSelfTuneRun('manual'),

  getSelfTuneOutput: async (runId) => getSelfTuneOutput(runId),

  listSelfTuneReports: async () => listSelfTuneReports(),

  openSelfTuneReport: (loginId) => openSelfTuneReport(loginId),

  readSelfTuneLessons: async () => readSelfTuneLessons(),

  // ---------- Protocol-added methods (docs/ui-rpc-protocol.md §4/§6) ----------

  'deps:status': () => probeDependencies(),

  'app:info': async () => ({
    version: platform.getAppVersion(),
    backendKind: platform.kind,
    orchestraHome: orchestraHome(),
    logPath: getLogFile(),
  }),

  'pty:scrollback': async (id) => Buffer.from(readScrollback(id), 'utf8').toString('base64'),
};
