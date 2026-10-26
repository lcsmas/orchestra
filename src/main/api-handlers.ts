import path from 'node:path';
import fs from 'node:fs';
import { platform } from './platform';
import { store } from './store';
import {
  detectRemoteUrl,
  getDiff,
  findPullRequest,
  findBranchChecks,
  listBranches,
  getDiffStats,
  getRawDiff,
  getStagedDiff,
  getBranchDiff,
  applyPatchToIndex,
  stagePaths,
  unstagePaths,
} from './git';
import {
  verifyLinearIssueByKey,
  verifyLinearApiKey,
  getLinearKeySource,
  resetLinearAuthState,
} from './linear';
import {
  dispatchLinearRemoveRequest,
  refreshPinnedTickets,
  spawnWorkspaceForTicket,
} from './linear-tickets';
import {
  setLinearApiKey,
  clearLinearApiKey,
  accountApiKeyIds,
  accountBaseUrlIds,
  setAccountBaseUrl,
  setAccountApiKey,
  clearAccountApiKey as clearAccountApiKeySecret,
  pruneAccountApiKeys,
  getSecretsState,
  reencryptInBackground,
} from './secrets';
import { getEnvStatus } from './env-status';
import { busDivergenceReport } from './bus-mirror.ts';
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
  wakeAgentWithPrompt,
  getWorktreeSizes,
  renameWorkspaceBranch,
  runSetupScript,
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
import { setActiveWorkspace } from './hibernation.ts';
import { sampleResources } from './resources';
import { getHookSocketPath } from './hooks-server';
import {
  readInbox,
  releaseInboxBlock,
  refuseInboxBlock,
  releaseAllInboxBlocks,
} from './inbox-tray';
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
import { listInheritables, syncAccountInheritance, syncAfterAccountsSave } from './account-inherit';
import { pauseAutoOnLogin } from './pause-auto-host';
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
  sdkRunBash,
  sdkStatus,
  sdkInterrupt,
  sdkQueueRemove,
  sdkQueueEdit,
  sdkQueueMove,
  sdkQueueSetCoalesce,
  sdkClear,
  sdkRewind,
  sdkRewindPreview,
  sdkFork,
  sdkPermissionReply,
  sdkAnswerableReply,
  sdkSetModel,
  sdkStopTask,
  sdkBackgroundForegroundTasks,
  sdkSetEffort,
  sdkSetPermissionMode,
  sdkSetRemoteControl,
  sdkMcpStatus,
  sdkMcpToggle,
  sdkMcpReconnect,
  sdkMcpRefresh,
  sdkMcpAuth,
  sdkHistory,
  sdkDefaultModel,
  sdkListSkills,
  sdkListModels,
  sdkStopMany,
  sdkAttachIfDetached,
  recoverPendingPrompts,
} from './agent-sdk';
import { log, revealLogs, getLogFile, getLogLevel, scoped } from './logger';
import * as browserPanel from './browser-panel';
import { HUMAN_OPENER } from '../shared/browser-tab-policy.ts';
import type { OrchestraAPI } from '../shared/ipc';
// NOTE the .ts extension: this is a VALUE import (the others from
// ../shared/types below are type-only and erased at compile). Any main-process
// file reachable from a `node --test --experimental-strip-types` suite must use
// .ts-suffixed relative specifiers for value imports or it dies at runtime with
// ERR_MODULE_NOT_FOUND — see commit 05adb90.
import { isScratchLike } from '../shared/types.ts';
import { normalizeModelDefaults } from '../shared/model-defaults.ts';
import { memoryGuardView, setMemoryGuardSettings } from './memory-guard-settings.ts';
import { accesMobileView, regenerateAccesMobileToken, setAccesMobileSettings } from './acces-mobile-host.ts';
import { markWorkspaceSeen } from './mark-seen.ts';
import { wakeHeldForMemory } from './admission-wake';
import { normalizeEffortDefaults } from '../shared/effort-defaults.ts';
import { sandboxPausedMessage } from '../shared/sandbox-pause.ts';
import { decideRename } from '../shared/naming-policy.ts';
import type {
  Account,
  BrowserBounds,
  BrowserPanelState,
  BrowserTabResult,
  CreateWorkspaceInput,
  DiffFile,
  RepoScripts,
  Workspace,
} from '../shared/types';

// The single shared request/response surface of the backend, extracted from
// index.ts's inline `ipcMain.handle` registrations. The table is keyed by
// `OrchestraAPI` MEMBER NAMES (src/shared/ipc.ts), not IPC channel names:
// index.ts wires each entry to its historical ipcMain channel via
// {@link METHOD_IPC_CHANNELS}, so the renderer and preload never notice the
// extraction.
//
// `pickDirectory` is deliberately NOT here: it is frontend-local by design
// (native file chooser) and stays an Electron-only handler in index.ts.

/** The `OrchestraAPI` member names that are request/response methods — every
 *  member except the `on*` event subscriptions. */
type ApiMethodName = {
  [K in keyof OrchestraAPI]: K extends `on${string}` ? never : K;
}[keyof OrchestraAPI];

/** The servable slice of `OrchestraAPI`: all methods minus the frontend-local
 *  ones — `pickDirectory` (native file chooser) and the `voice*` family
 *  (registered inline by src/main/voice.ts: high-frequency PCM, dev-gated). */
type ServableApi = Omit<
  Pick<OrchestraAPI, ApiMethodName>,
  | 'pickDirectory'
  | 'pathForFile'
  | 'voiceAvailable'
  | 'voiceStart'
  | 'voicePcm'
  | 'voiceStop'
  // The bus pane's three READ-ONLY channels (#118) are registered by
  // registerBusPaneIpc() in src/main/bus-pane.ts, not from this generic table.
  // That is the point: the registrar iterates BUS_PANE_IPC_CHANNELS and REFUSES
  // any entry marked `writes: true`, so the v1 read-only boundary is enforced by
  // code at registration time. Routing them through the generic table would
  // silently bypass that check the day someone adds a write handler.
  | 'busSnapshot'
  | 'busListRuns'
  | 'busSwitches'
  | 'busCapSummary'
  | 'setBusSwitches'
  // #161 — the human-gate READ (bus:humanGates) is registered by
  // registerBusPaneIpc() alongside the other pane reads; the RESOLVE
  // (bus:resolveHumanGate) is a write registered separately in index.ts, exactly
  // like setBusSwitches. Neither goes through this generic table.
  | 'busHumanGates'
  | 'resolveHumanGate'
  // #257 — the Pause UI channels (`pause:*`) are registered by registerPauseUiIpc() (src/main/pause-ui-host.ts), with the same read/write split as the bus pane:
  // not from this generic table (a write must not be reachable as a "served read").
  | 'pauseOverview'
  | 'pausePause'
  | 'pauseResume'
  | 'pauseRelease'
  // #330 — the directory-watcher health pull (`watchers:status`) is registered by registerWatchersIpc() (src/main/watchers-host.ts), next to its push; not from this generic table.
  | 'watchersStatus'
  // « Nouvelle version installée »: the pull (`appUpdate:state`) and the relaunch (`appUpdate:relaunch`) are registered by registerAppUpdateIpc() (src/main/app-update-host.ts), next to the push.
  | 'appUpdateState'
  | 'relaunchInstalled'
  // #289 — the memory banner's pull (`memoryGuard:banner`) is registered by registerMemoryBannerIpc() (src/main/memory-banner-host.ts), next to its push; not from this generic table.
  | 'memoryBanner'
>;

/** Served backend methods that are not part of the renderer-facing
 *  `OrchestraAPI`. */
export interface ExtraApiMethods {
  /** Full working-tree diff vs. the base branch. Not used by the renderer (its
   *  Diff tab was removed — Monaco was too heavy); kept as a served backend
   *  method behind the `git:diff` channel. */
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
  getBusDivergence: 'bus:divergence',
  getLinearKeySource: 'linear:keySource',
  checkLinearKey: 'linear:checkKey',
  saveLinearKey: 'linear:saveKey',
  clearLinearKey: 'linear:clearKey',
  getUsage: 'usage:get',
  listAccounts: 'accounts:list',
  setAccounts: 'accounts:set',
  isSecretStorageEncrypted: 'accounts:secretsEncrypted',
  getSecretsState: 'secrets:state',
  listAccountApiKeyIds: 'accounts:apiKeyIds',
  saveAccountApiKey: 'accounts:saveApiKey',
  listAccountBaseUrlIds: 'accounts:baseUrlIds',
  saveAccountBaseUrl: 'accounts:saveBaseUrl',
  clearAccountApiKey: 'accounts:clearApiKey',
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
  logLevel: 'logs:level',
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
  setActiveWorkspace: 'workspaces:setActive',
  setUnread: 'workspaces:setUnread',
  promoteWorkspace: 'workspaces:promote',
  demoteWorkspace: 'workspaces:demote',
  setWorkspaceParent: 'workspaces:setParent',
  renameBranch: 'workspaces:renameBranch',
  reorderWorkspaces: 'workspaces:reorder',
  queuePrompt: 'queue:add',
  removeQueuedPrompt: 'queue:remove',
  flushQueuedPrompts: 'queue:flush',
  listInbox: 'inbox:list',
  releaseInboxMessage: 'inbox:release',
  refuseInboxMessage: 'inbox:refuse',
  releaseAllInboxMessages: 'inbox:releaseAll',
  ptyWrite: 'pty:write',
  ptyResize: 'pty:resize',
  restartAgent: 'agent:restart',
  agentSdkSend: 'agent:sdkSend',
  agentSdkRunBash: 'agent:sdkRunBash',
  agentSdkStatus: 'agent:sdkStatus',
  agentSdkInterrupt: 'agent:sdkInterrupt',
  agentSdkQueueRemove: 'agent:sdkQueueRemove',
  agentSdkQueueEdit: 'agent:sdkQueueEdit',
  agentSdkQueueMove: 'agent:sdkQueueMove',
  agentSdkQueueCoalesce: 'agent:sdkQueueCoalesce',
  agentSdkClear: 'agent:sdkClear',
  agentSdkRewind: 'agent:sdkRewind',
  agentSdkRewindPreview: 'agent:sdkRewindPreview',
  agentSdkFork: 'agent:sdkFork',
  agentSdkPermissionReply: 'agent:sdkPermissionReply',
  agentSdkAnswerableReply: 'agent:sdkAnswerableReply',
  agentSdkSetModel: 'agent:sdkSetModel',
  agentSdkSetEffort: 'agent:sdkSetEffort',
  agentSdkSetPermissionMode: 'agent:sdkSetPermissionMode',
  agentSdkSetRemoteControl: 'agent:sdkSetRemoteControl',
  agentSdkMcpStatus: 'agent:sdkMcpStatus',
  agentSdkMcpToggle: 'agent:sdkMcpToggle',
  agentSdkMcpReconnect: 'agent:sdkMcpReconnect',
  agentSdkMcpRefresh: 'agent:sdkMcpRefresh',
  agentSdkMcpAuth: 'agent:sdkMcpAuth',
  agentSdkHistory: 'agent:sdkHistory',
  agentSdkDefaultModel: 'agent:sdkDefaultModel',
  agentSdkOpenTaskTranscript: 'agent:sdkOpenTaskTranscript',
  agentSdkStopTask: 'agent:sdkStopTask',
  agentSdkBackgroundTasks: 'agent:sdkBackgroundTasks',
  agentSkills: 'agent:skills',
  agentModels: 'agent:models',
  browserShow: 'browser:show',
  browserHide: 'browser:hide',
  browserNavigate: 'browser:navigate',
  browserBack: 'browser:back',
  browserForward: 'browser:forward',
  browserReload: 'browser:reload',
  browserSetBounds: 'browser:setBounds',
  browserState: 'browser:state',
  browserTabNew: 'browser:tabNew',
  browserTabActivate: 'browser:tabActivate',
  browserTabClose: 'browser:tabClose',
  browserDesignArm: 'browser:designArm',
  browserDesignDisarm: 'browser:designDisarm',
  browserDesignPoll: 'browser:designPoll',
  nvimStart: 'nvim:start',
  sandboxControlState: 'sandbox:controlState',
  takeSandboxControl: 'sandbox:takeControl',
  getDiff: 'git:diff',
  getDiffStats: 'git:stats',
  getWorktreeSizes: 'workspaces:sizes',
  sampleResources: 'resources:sample',
  findPR: 'git:findPR',
  findChecks: 'git:findChecks',
  fixChecks: 'git:fixChecks',
  getReviewDiff: 'git:reviewDiff',
  getStagedDiff: 'git:stagedDiff',
  applyReviewPatch: 'git:applyReviewPatch',
  sendReviewToAgent: 'git:sendReview',
  verifyLinear: 'linear:verify',
  listTickets: 'tickets:list',
  modelDefaults: 'settings:modelDefaults',
  setModelDefaults: 'settings:setModelDefaults',
  effortDefaults: 'settings:effortDefaults',
  setEffortDefaults: 'settings:setEffortDefaults',
  memoryGuard: 'settings:memoryGuard',
  setMemoryGuard: 'settings:setMemoryGuard',
  accesMobile: 'settings:accesMobile',
  setAccesMobile: 'settings:setAccesMobile',
  regenerateAccesMobileToken: 'settings:regenerateAccesMobileToken',
  refreshTickets: 'tickets:refresh',
  removeTicket: 'tickets:remove',
  spawnFromTicket: 'tickets:spawn',
  listBranches: 'git:listBranches',
  switchBranch: 'git:switchBranch',
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
};

/** External-URL opens. Its own scope so `[open-url]` lines can be grepped out
 *  of a busy log when tracing a duplicate-window report. */
const olog = scoped('open-url');

/** #227 — fix-checks / send-review to an agent whose SDK session could not start (the reason is an error row in its Agent view). */
const AGENT_WAKE_FAILED =
  'The agent could not be started, so nothing was sent — see the error in its Agent view, fix the cause, then Restart it.';

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
 *  index.ts's window-open interception.
 *
 * `origin` names the call site so a single user gesture that produces MORE than
 * one open is legible in the log. This path was previously silent, which made
 * the "one link click tiled six browser windows" report impossible to diagnose
 * from logs alone: the duplication could live in Orchestra (both the
 * window-open handler and `will-navigate` firing for one click — neither is
 * deduped) or entirely below it (on Linux `shell.openExternal` shells out to
 * `xdg-open`, and a Chromium whose profile SingletonLock is stale cannot hand
 * the URL to the running browser, so every invocation forks a fresh competing
 * instance). The two are indistinguishable without a per-call record, so log
 * every call with its origin before deciding which layer to fix. */
export async function openUrlExternally(url: string, origin = 'unknown'): Promise<void> {
  if (!isSafeHttpUrl(url)) {
    olog.debug(`refused non-http(s) url from ${origin}: ${url.slice(0, 120)}`);
    return;
  }
  olog.info(`open external (${origin}): ${url.slice(0, 200)}`);
  try {
    await platform.openExternal(url);
  } catch (err) {
    olog.warn(`open external failed (${origin}) for ${url.slice(0, 200)}`, err);
  }
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

  openExternal: (url) => openUrlExternally(url, 'renderer-ipc'),

  getAppVersion: async () => platform.getAppVersion(),

  // Optional-setup status (e.g. Linear API key present?). The renderer reads
  // this on load and on a slow poll to surface a small "needs setup" notice.
  getEnvStatus: async () => getEnvStatus(),
  // #116 shadow mirror. Cannot throw when the bus is down — busDivergenceReport
  // reports `busAvailable: false` instead, so the pane renders a state rather
  // than an error boundary (D1).
  getBusDivergence: async () => busDivergenceReport(),

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
    const before = store.accounts; // captured BEFORE the save: the de-selection signal (#235 residual/C10)
    const saved = await store.setAccounts(accounts);
    // Re-materialize each account's inheritance so edited selections take
    // effect immediately (symlinks added/removed, MCP servers merged/pruned).
    void syncAfterAccountsSave(before, saved);
    void refreshAccountsNow();
    // A removed account's stored API key must not outlive it in the keystore.
    await pruneAccountApiKeys(saved.map((a) => a.id)).catch(() => {});
    return saved;
  },

  // ---------- per-account Anthropic API keys (keystore, never in store.json) ----------

  isSecretStorageEncrypted: async () => platform.isEncryptionAvailable(),

  getSecretsState: async () => {
    const state = await getSecretsState();
    // The keyring works but plaintext is still on disk (saved while it did not, or a startup skipped it): seal it now.
    if (state.encrypted && state.plaintextEntries > 0) reencryptInBackground('settings');
    return state;
  },

  listAccountApiKeyIds: async () => accountApiKeyIds(),

  saveAccountApiKey: async (accountId, key) => {
    await setAccountApiKey(accountId, key);
    void refreshAccountsNow();
    void pauseAutoOnLogin(accountId); // #256: a replaced key is a new credential — forced fresh reading for the paused runs waiting on this account
  },

  listAccountBaseUrlIds: async () => accountBaseUrlIds(),

  saveAccountBaseUrl: async (accountId, url) => {
    await setAccountBaseUrl(accountId, url);
    void refreshAccountsNow();
    void pauseAutoOnLogin(accountId);
  },

  clearAccountApiKey: async (accountId) => {
    await clearAccountApiKeySecret(accountId);
    void refreshAccountsNow();
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
    await syncAccountInheritance(account, { caller: 'login' }).catch((err) =>
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
      // #256: re-login = a NEW token — force a fresh reading of this account for the paused runs waiting on it and re-evaluate them now.
      void pauseAutoOnLogin(accountId);
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

  logLevel: async () => getLogLevel(),

  // Forward renderer/frontend logs into the same file so a single artifact
  // captures every process. Level is clamped to the known set; the renderer
  // already tags its own subsystem scope, so `[renderer]` prefixes it to keep
  // the origin process unambiguous when reading an interleaved log.
  log: async (level, message, meta) => {
    const fn =
      level === 'error'
        ? log.error
        : level === 'warn'
          ? log.warn
          : level === 'debug'
            ? log.debug
            : level === 'trace'
              ? log.trace
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
    // NOTE: the browser panel is torn down inside archiveWorkspace() itself, so
    // the whole orchestrator subtree is covered and every caller gets it — not
    // just this handler.
    return archiveWorkspace(id);
  },

  unarchiveWorkspace: (id) => unarchiveWorkspace(id),

  deleteWorkspace: (id) => {
    sdkStopMany([id]);
    browserPanel.destroyPanel(id);
    return deleteWorkspace(id);
  },

  deleteWorkspaces: (ids) => {
    sdkStopMany(ids);
    for (const id of ids) browserPanel.destroyPanel(id);
    return deleteWorkspaces(ids, (done, total) => {
      platform.broadcast('workspaces:deleteProgress', done, total);
    });
  },

  importToSandbox: (id, endpoint) => importWorkspaceToSandbox(id, endpoint),

  ejectFromSandbox: (id) => ejectWorkspaceFromSandbox(id),

  backupSandbox: (id) => backupSandboxWorkspace(id),

  // The user opened this workspace: that is the "read" moment for BOTH
  // attention signals. It clears the auto-unread bell (they have now seen the
  // finished output) and resolves a `waiting` row to `idle`.
  //
  // Note `waiting` no longer means "finished, unseen" — it means "the agent is
  // blocked on your answer" — so clearing it on open is a deliberate,
  // pre-existing behaviour: opening the workspace is where you answer. The bell
  // is the part that specifically encodes "never looked at".
  markSeen: async (id) => markWorkspaceSeen(id), // shared with the Accès mobile (#337) — mark-seen.ts

  setActiveWorkspace: async (id) => {
    setActiveWorkspace(id);
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

  // The sidebar rename is the HUMAN caller of the naming policy: it pins the name (and stops the nudge) for everyone.
  renameBranch: async (id, newBranch) => {
    const ws = store.getWorkspace(id);
    if (!ws) throw new Error('workspace not found');
    const decision = decideRename(ws, { kind: 'human' });
    if (!decision.allow) throw new Error(decision.error);
    return renameWorkspaceBranch(id, newBranch, decision.pin);
  },

  reorderWorkspaces: (orderedIds) => store.reorderWorkspaces(orderedIds),

  // ---------- Prompt queue (usage-limited accounts) ----------

  queuePrompt: (id, text) => addQueuedPrompt(id, text),

  removeQueuedPrompt: (id, promptId) => removeQueuedPrompt(id, promptId),

  // The UI's "Send now" — deliver regardless of what the usage cache says.
  flushQueuedPrompts: (id) => flushQueuedPrompts(id, { force: true }),

  // ---- Inbox tray (issue #64). Blocks are addressed by TEXT, not index: the
  //      `inbox-instruction.sh` hook can drain the file between the tray
  //      rendering a row and the human clicking it, so an index would act on the
  //      wrong message. The action result reports what actually happened
  //      (including the normal 'gone' outcome) rather than throwing.
  listInbox: async (id) => readInbox(id),
  releaseInboxMessage: (id, text) => releaseInboxBlock(id, text, 'human'), // #252 row 22: the tray click is a human act
  refuseInboxMessage: (id, text) => refuseInboxBlock(id, text),
  releaseAllInboxMessages: async (id) => {
    const res = await releaseAllInboxBlocks(id, 'human');
    return {
      released: res.released,
      remaining: res.remaining,
      ...(res.failed ? { error: res.failed.reason } : {}),
    };
  },

  // ---------- Terminal (pty) ----------

  // Shared by the Run, nvim and account-login terminals — no agent PTY exists since #233 (the Agent view drives agents).
  ptyWrite: async (id, data) => writePty(id, data),

  ptyResize: async (id, cols, rows) => resizePty(id, cols, rows),

  restartAgent: async (id) => {
    // #148 gap #3 / #232: the toolbar Restart goes through the same conversation-preserving
    // restart the CLI / #142 use, tagged `toolbar` so the neutral restart row's detail names
    // the producer. dispatchRestartRequest classifies the surface (a live or persisted
    // structured session → sdkRestart; a stopped legacy terminal-only workspace →
    // sdkWakeRestart, #228). It refuses diagnosably when nothing has ever run.
    const { dispatchRestartRequest } = await import('./restart-workspace.ts');
    const res = await dispatchRestartRequest({ id, fresh: false, trigger: 'toolbar' });
    if (!res.ok) log.warn(`restartAgent: ${id} — ${res.error ?? 'unknown'}`);
    // #226: a paused sandbox agent must SURFACE the pause (the callers show the rejection), never a silent resolve.
    const paused = sandboxPausedMessage(store.getWorkspace(id));
    if (!res.ok && paused) throw new Error(paused);
  },

  // ---------- Structured agent view (Claude Agent SDK) ----------
  // The reverse path into the per-workspace SDK session manager (agent-sdk.ts).
  // Each starts/reuses the workspace's lazy session; the forward event stream
  // is broadcast on `agent:event` from that module.

  agentSdkSend: async (wsId, text, images) => {
    // #252 fleet PAUSE (ledger #261 row 1): a prompt the HUMAN types is allowed while the run is paused and un-pauses nothing.
    await sdkSend(wsId, text, images, undefined, undefined, false, false, 'human');
  },

  agentSdkRunBash: async (wsId, command) => {
    await sdkRunBash(wsId, command);
  },

  agentSdkStatus: async (wsId) => {
    await sdkStatus(wsId);
  },

  agentSdkInterrupt: async (wsId) => {
    await sdkInterrupt(wsId);
  },

  // Queue-tray mutations. Each returns false when the id is unknown — the entry
  // drained while the user was clicking, a benign race the tray ignores (the
  // authoritative `queue-update` event has already re-rendered it).
  agentSdkQueueRemove: async (wsId, id) => sdkQueueRemove(wsId, id),
  agentSdkQueueEdit: async (wsId, id, text) => sdkQueueEdit(wsId, id, text),
  agentSdkQueueMove: async (wsId, id, dir) => sdkQueueMove(wsId, id, dir),
  agentSdkQueueCoalesce: async (wsId, id, on) => sdkQueueSetCoalesce(wsId, id, on),

  agentSdkClear: async (wsId) => {
    await sdkClear(wsId);
  },

  agentSdkRewind: async (wsId, rewindId, prevRewindId) =>
    sdkRewind(wsId, rewindId, prevRewindId),

  agentSdkRewindPreview: async (wsId, rewindId) => sdkRewindPreview(wsId, rewindId),
  agentSdkFork: async (wsId, upToMessageId, title) => sdkFork(wsId, upToMessageId, title),

  agentSdkPermissionReply: async (wsId, requestId, reply) => {
    sdkPermissionReply(wsId, requestId, reply);
  },

  agentSdkAnswerableReply: async (wsId, requestId, answer) => {
    sdkAnswerableReply(wsId, requestId, answer);
  },

  agentSdkSetModel: async (wsId, model) => {
    await sdkSetModel(wsId, model);
  },

  agentSdkSetEffort: async (wsId, effort) => {
    await sdkSetEffort(wsId, effort);
  },

  agentSdkSetPermissionMode: async (wsId, mode) => {
    await sdkSetPermissionMode(wsId, mode);
  },

  agentSdkMcpStatus: async (wsId) => sdkMcpStatus(wsId),

  agentSdkMcpToggle: async (wsId, serverName, enabled) => sdkMcpToggle(wsId, serverName, enabled),

  agentSdkMcpReconnect: async (wsId, serverName) => sdkMcpReconnect(wsId, serverName),

  agentSdkMcpRefresh: async (wsId) => sdkMcpRefresh(wsId),

  agentSdkMcpAuth: async (wsId, serverName) => sdkMcpAuth(wsId, serverName),

  agentSdkSetRemoteControl: async (wsId, enabled) => {
    await sdkSetRemoteControl(wsId, enabled);
  },

  agentSdkHistory: async (wsId) => {
    const events = await sdkHistory(wsId);
    // Opening a structured view is the LAZY reattach point: if this
    // workspace's CLI outlived a previous app run in a detached keeper
    // (keeper-client.ts), rebuild the session around it now so the in-flight
    // turn streams live again. Then replay any prompt that was sent before a
    // quit but never ran (recoverPendingPrompts) — SEQUENCED after the attach
    // so the resend can't race the attach's session start. Fire-and-forget —
    // the backfill result below paints the on-disk transcript either way, and
    // attach/replay events layer on top.
    void (async () => {
      await sdkAttachIfDetached(wsId);
      // #287 Admission: a recovery that would RESEND pending prompts to a SLEEPING FLEET member STARTS its process — under low memory it WAITS (the pending prompts
      // stay durable in `sdkPendingPrompts`; the queue re-runs the recovery when the member's turn comes). Attaching to a CLI that already runs is not a start.
      const recoverNow = async (): Promise<void> => recoverPendingPrompts(wsId, await sdkHistory(wsId));
      const w = store.getWorkspace(wsId);
      if (w && (w.sdkPendingPrompts ?? []).length > 0 && (await wakeHeldForMemory(w, recoverNow, { site: 'recovery', reenters: false }))) return;
      await recoverPendingPrompts(wsId, events);
    })().catch((err) => log.warn(`agent:sdkHistory attach/recover failed for ${wsId}`, err));
    return events;
  },

  agentSdkDefaultModel: async (wsId) => sdkDefaultModel(wsId),

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

  // Kill a running background task (SDK `Query.stopTask`). Deliberately does
  // NOT patch the folded card: the CLI answers with its own
  // `task_notification { status: 'stopped' }`, which the normal event path
  // folds. That keeps "the button was clicked" and "the task actually died"
  // distinguishable — an optimistic flip here would collapse them.
  agentSdkStopTask: async (wsId, taskId) => sdkStopTask(wsId, taskId),

  // Ctrl+B parity: move in-flight FOREGROUND work into the background. Returns
  // the SDK's boolean (false = nothing matched, a contract outcome not an
  // error). Not a state query — see the ipc.ts note.
  agentSdkBackgroundTasks: async (wsId, toolUseId) =>
    sdkBackgroundForegroundTasks(wsId, toolUseId),

  agentSkills: async (wsId) => sdkListSkills(wsId),
  agentModels: async (wsId) => sdkListModels(wsId),

  // --- Embedded browser panel (see browser-panel.ts) ---
  // The renderer opens/positions the native WebContentsView; navigation can also
  // come from the agent's browser tools, which reach the same panel directly.
  browserShow: async (wsId: string): Promise<BrowserPanelState> => browserPanel.showPanel(wsId),
  browserHide: async (wsId: string): Promise<void> => browserPanel.hidePanel(wsId),
  browserNavigate: (wsId: string, url: string): Promise<BrowserPanelState> =>
    browserPanel.navigate(wsId, url),
  browserBack: async (wsId: string): Promise<void> => browserPanel.goBack(wsId),
  browserForward: async (wsId: string): Promise<void> => browserPanel.goForward(wsId),
  browserReload: async (wsId: string): Promise<void> => browserPanel.reload(wsId),
  browserSetBounds: async (wsId: string, bounds: BrowserBounds): Promise<void> =>
    browserPanel.setBounds(wsId, bounds),
  browserState: async (wsId: string): Promise<BrowserPanelState> => browserPanel.getState(wsId),
  browserTabNew: async (wsId: string, url?: string): Promise<BrowserTabResult> =>
    browserPanel.tryOpenTab(wsId, { url, openedBy: HUMAN_OPENER, activate: true }),
  browserTabActivate: async (wsId: string, tabId: string): Promise<BrowserTabResult> =>
    browserPanel.tryActivateTab(wsId, tabId),
  browserTabClose: async (wsId: string, tabId: string): Promise<BrowserTabResult> =>
    browserPanel.tryCloseTab(wsId, tabId, HUMAN_OPENER),

  // --- Design mode: the browser pane's element picker ---
  // Arm/disarm inject and tear down the in-page highlight overlay; poll drains
  // a completed pick (and captures its cropped screenshot). The renderer polls
  // while armed — see browser-panel.ts for why this is polled, not pushed.
  browserDesignArm: async (wsId: string): Promise<void> => browserPanel.designModeArm(wsId),
  browserDesignDisarm: async (wsId: string): Promise<void> => browserPanel.designModeDisarm(wsId),
  browserDesignPoll: (wsId: string) => browserPanel.designModePoll(wsId),

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

  // Served behind the `git:diff` channel; the renderer no longer has a Diff
  // tab. See the ExtraApiMethods declaration above.
  getDiff: async (id) => {
    const ws = store.getWorkspace(id);
    if (!ws) throw new Error('workspace not found');
    if (isScratchLike(ws)) return []; // non-git dir — no diff against a base
    return getDiff(ws.worktreePath, ws.baseBranch);
  },

  getDiffStats: async (id) => {
    const ws = store.getWorkspace(id);
    if (!ws) throw new Error('workspace not found');
    // Scratch sessions aren't git-backed: no diff stats, and none of the
    // merge / branch reconciliation below applies.
    if (isScratchLike(ws)) return { additions: 0, deletions: 0, files: 0 };
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
    // Release detection still needs the workspace's own repo (it compares the
    // branch tip against local tags), so it stays gated on being a git
    // workspace even though the PR lookup below no longer is. It remains
    // piggybacked here rather than on the hot stats poll because the
    // underlying computation is memoized on (branch tip, releases).
    // `isScratchLike`, not `kind !== 'scratch'`: an orchestrator is equally
    // repo-less, and this guard let it through. That was inert only because an
    // orchestrator's `repoPath` is `''`, so the `&& ws.repoPath` half caught it
    // by accident — a pre-existing hole that any repo-ish field on a
    // coordinator would reopen, spending the shared gh/GraphQL budget resolving
    // a branch that does not exist in that repo.
    if (!isScratchLike(ws) && ws.repoPath) {
      void detectAndUpdateReleaseState(id).catch(() => {});
    }
    // PRs are whatever the AGENT linked (`orchestra link --pr`) — no branch
    // matching, and no dependence on `ws.repoPath`, so a workspace can track
    // PRs that live in other repos entirely (metarepo submodules). Unlinked
    // workspaces of every kind return empty here, which is why the old
    // `kind === 'scratch'` early-return is no longer needed.
    return findPullRequest(ws.linkedPrs);
  },

  findChecks: async (id) => {
    const ws = store.getWorkspace(id);
    if (!ws) throw new Error('workspace not found');
    // Non-git sessions have no branch to run CI on. Mirrors findPR's guard,
    // extended to orchestrator (also repo-less).
    if (isScratchLike(ws) || !ws.repoPath) {
      return { state: 'none' as const };
    }
    return findBranchChecks(ws.repoPath, ws.branch);
  },

  fixChecks: async (id) => {
    const ws = store.getWorkspace(id);
    if (!ws) throw new Error('workspace not found');
    // #226: a paused sandbox agent cannot take the prompt — throw the pause, never answer 'requested'.
    const paused = sandboxPausedMessage(ws);
    if (paused) throw new Error(paused);
    const checks = await findBranchChecks(ws.repoPath, ws.branch);
    const logCmd = checks.runId
      ? `gh run view ${checks.runId} --log-failed`
      : `gh run list --branch "${ws.branch}" --limit 5` + ' then `gh run view <id> --log-failed`';
    const prompt =
      `CI is failing on this branch${checks.name ? ` (workflow "${checks.name}")` : ''}.\n\n` +
      `- Branch: \`${ws.branch}\`\n` +
      (checks.url ? `- Run: ${checks.url}\n` : '') +
      `\nRead the failing logs with \`${logCmd}\` (run it in this worktree), ` +
      `fix the root cause, run the failing checks locally to prove the fix, then commit and push. ` +
      `Tell me what was broken and what you changed.`;
    // Live SDK session or stopped agent: wakeAgentWithPrompt handles both (deliver-as-next-turn /
    // structured-first wake). #227/#232: false = the SDK session would not start (no PTY to type into):
    // never answer "requested" for a prompt that went nowhere.
    if (!(await wakeAgentWithPrompt(id, prompt, { origin: 'human' }))) throw new Error(AGENT_WAKE_FAILED); // #252: a human click (row 28)
    return { status: 'requested' as const };
  },

  getReviewDiff: async (id, scope) => {
    const ws = store.getWorkspace(id);
    if (!ws) throw new Error('workspace not found');
    // Scratch/orchestrator sessions are repo-less, so there is nothing to diff.
    // Same guard as findChecks; the Diff tab is hidden for them anyway, but the
    // channel must not throw if something calls it.
    if (isScratchLike(ws) || !ws.worktreePath) return '';
    return scope === 'base'
      ? getBranchDiff(ws.worktreePath, ws.baseBranch, ws.branch)
      : getRawDiff(ws.worktreePath);
  },

  getStagedDiff: async (id) => {
    const ws = store.getWorkspace(id);
    if (!ws) throw new Error('workspace not found');
    if (isScratchLike(ws) || !ws.worktreePath) return '';
    return getStagedDiff(ws.worktreePath);
  },

  applyReviewPatch: async (id, input) => {
    const ws = store.getWorkspace(id);
    if (!ws) throw new Error('workspace not found');
    if (isScratchLike(ws) || !ws.worktreePath) throw new Error('not a git workspace');
    const reverse = input.mode === 'unstage';
    // Whole-file paths and a hunk patch are independent inputs: binaries and
    // pure renames arrive as paths (no hunks to select), everything else as a
    // rebuilt patch. Both may be present in one call.
    if (input.paths?.length) {
      if (reverse) await unstagePaths(ws.worktreePath, input.paths);
      else await stagePaths(ws.worktreePath, input.paths);
    }
    if (input.patch?.trim()) {
      await applyPatchToIndex(ws.worktreePath, input.patch, reverse);
    }
    return { status: 'applied' as const };
  },

  sendReviewToAgent: async (id, prompt) => {
    const ws = store.getWorkspace(id);
    if (!ws) throw new Error('workspace not found');
    if (!prompt.trim()) throw new Error('empty review');
    // #226: same as fixChecks — a paused sandbox agent cannot take the review; throw, never 'requested'.
    const paused = sandboxPausedMessage(ws);
    if (paused) throw new Error(paused);
    // Exactly the fixChecks delivery seam: a live SDK session takes it as its next turn, a stopped agent gets a structured-first wake.
    if (!(await wakeAgentWithPrompt(id, prompt, { origin: 'human' }))) throw new Error(AGENT_WAKE_FAILED); // #252: a human click (row 28); #227/#232 — see fixChecks
    return { status: 'requested' as const };
  },

  listTickets: async () => store.tickets,

  modelDefaults: async () => store.getModelDefaults(),

  // Normalized before persisting; the echo is what the settings modal shows.
  setModelDefaults: async (next) => {
    await store.setModelDefaults(normalizeModelDefaults({ ...store.getModelDefaults(), ...next }));
    return store.getModelDefaults();
  },

  effortDefaults: async () => store.getEffortDefaults(),

  setEffortDefaults: async (next) => {
    await store.setEffortDefaults(normalizeEffortDefaults({ ...store.getEffortDefaults(), ...next }));
    return store.getEffortDefaults();
  },

  memoryGuard: async () => memoryGuardView(store.getMemoryGuardSettings()),

  // Validated, persisted, then applied HOT (the guard re-samples at once) — see memory-guard-settings.ts.
  setMemoryGuard: async (next) => setMemoryGuardSettings(next, store),

  // Accès mobile (#334): validated → persisted → the server process (re)started or stopped at once — see acces-mobile-host.ts.
  accesMobile: async () => accesMobileView(),
  setAccesMobile: async (next) => setAccesMobileSettings(next),
  regenerateAccesMobileToken: async () => regenerateAccesMobileToken(),

  refreshTickets: async () => refreshPinnedTickets(),

  removeTicket: async (identifier) => {
    const res = await dispatchLinearRemoveRequest({ ref: identifier });
    if (!res.ok) throw new Error(res.error ?? 'failed to un-pin ticket');
  },

  spawnFromTicket: async (identifier, repoPath) => {
    const res = await spawnWorkspaceForTicket(identifier, repoPath);
    if (!res.ok || !res.workspaceId) {
      throw new Error(res.error ?? 'failed to spawn workspace for ticket');
    }
    return { workspaceId: res.workspaceId };
  },

  verifyLinear: async (id) => {
    const ws = store.getWorkspace(id);
    if (!ws) throw new Error('workspace not found');
    // The badge is now driven SOLELY by what the agent reported via
    // `orchestra link --linear` — the branch name is no longer mined for a
    // key. Branch-name mining guessed in both directions: it invented issues
    // from branches that encode none (`usage-poll-429-backoff` → `POLL-429`)
    // and could never see a ticket whose key was never typed into the branch.
    // No link → no badge, for scratch sessions and git worktrees alike.
    if (!ws.linkedLinearKey) return null;
    // Still verified against the API: the key is the agent's assertion, and an
    // unverified assertion would render a badge that opens a 404.
    return verifyLinearIssueByKey(ws.linkedLinearKey);
  },

  listBranches: async (id) => {
    const ws = store.getWorkspace(id);
    if (!ws) throw new Error('workspace not found');
    return listBranches(ws.repoPath);
  },

  switchBranch: (id, branch) => switchWorkspaceBranch(id, branch),

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
};
