import { contextBridge, ipcRenderer } from 'electron';
import type { OrchestraAPI } from '../shared/ipc';

const api: OrchestraAPI = {
  addRepo: (p) => ipcRenderer.invoke('repos:add', p),
  removeRepo: (p) => ipcRenderer.invoke('repos:remove', p),
  listRepos: () => ipcRenderer.invoke('repos:list'),
  listRepoSyncStates: () => ipcRenderer.invoke('repos:listSyncStates'),
  syncRepoBase: (p) => ipcRenderer.invoke('repos:syncBase', p),
  reorderRepos: (paths) => ipcRenderer.invoke('repos:reorder', paths),
  listRepoBranches: (repoPath) => ipcRenderer.invoke('repos:listBranches', repoPath),
  setRepoDefaultBranch: (repoPath, branch) =>
    ipcRenderer.invoke('repos:setDefaultBranch', repoPath, branch),
  pickDirectory: () => ipcRenderer.invoke('dialog:pickDir'),
  openExternal: (url) => ipcRenderer.invoke('app:openExternal', url),
  getAppVersion: () => ipcRenderer.invoke('app:version'),
  getEnvStatus: () => ipcRenderer.invoke('app:envStatus'),
  getLinearKeySource: () => ipcRenderer.invoke('linear:keySource'),
  checkLinearKey: (key) => ipcRenderer.invoke('linear:checkKey', key),
  saveLinearKey: (key) => ipcRenderer.invoke('linear:saveKey', key),
  clearLinearKey: () => ipcRenderer.invoke('linear:clearKey'),
  getUsage: () => ipcRenderer.invoke('usage:get'),

  listAccounts: () => ipcRenderer.invoke('accounts:list'),
  setAccounts: (accounts) => ipcRenderer.invoke('accounts:set', accounts),
  setRepoAccount: (repoPath, accountId) => ipcRenderer.invoke('repos:setAccount', repoPath, accountId),
  migrateWorkspaceAccount: (id, accountId) =>
    ipcRenderer.invoke('workspaces:migrateAccount', id, accountId),
  getAccountUsage: (accountId) => ipcRenderer.invoke('accounts:usage', accountId),
  getAllAccountUsage: () => ipcRenderer.invoke('accounts:usageAll'),
  getWorkspaceAccounts: () => ipcRenderer.invoke('accounts:workspaceAccounts'),
  accountLoginStart: (accountId, cols, rows) => ipcRenderer.invoke('accounts:loginStart', accountId, cols, rows),
  accountLoginStop: (accountId) => ipcRenderer.invoke('accounts:loginStop', accountId),
  accountLoginOpenUrl: (accountId, url) => ipcRenderer.invoke('accounts:loginOpenUrl', accountId, url),
  refreshAccounts: () => ipcRenderer.invoke('accounts:refresh'),
  listGlobalInheritables: () => ipcRenderer.invoke('accounts:listGlobalInheritables'),
  onAccountLoginDone: (cb) => {
    const listener = (_e: unknown, accountId: string) => cb(accountId);
    ipcRenderer.on('accounts:loginDone', listener);
    return () => ipcRenderer.off('accounts:loginDone', listener);
  },

  revealLogs: () => ipcRenderer.invoke('logs:reveal'),
  logPath: () => ipcRenderer.invoke('logs:path'),
  log: (level, message, meta) => ipcRenderer.invoke('logs:write', level, message, meta),

  listWorkspaces: () => ipcRenderer.invoke('workspaces:list'),
  createWorkspace: (input) => ipcRenderer.invoke('workspaces:create', input),
  createScratchWorkspace: () => ipcRenderer.invoke('workspaces:createScratch'),
  createOrchestratorWorkspace: () => ipcRenderer.invoke('workspaces:createOrchestrator'),
  archiveWorkspace: (id) => ipcRenderer.invoke('workspaces:archive', id),
  unarchiveWorkspace: (id) => ipcRenderer.invoke('workspaces:unarchive', id),
  deleteWorkspace: (id) => ipcRenderer.invoke('workspaces:delete', id),
  deleteWorkspaces: (ids) => ipcRenderer.invoke('workspaces:deleteMany', ids),
  importToSandbox: (id, endpoint) => ipcRenderer.invoke('workspaces:importToSandbox', id, endpoint),
  ejectFromSandbox: (id) => ipcRenderer.invoke('workspaces:ejectFromSandbox', id),
  backupSandbox: (id) => ipcRenderer.invoke('sandbox:backup', id),
  markSeen: (id) => ipcRenderer.invoke('workspaces:markSeen', id),
  setUnread: (id, unread) => ipcRenderer.invoke('workspaces:setUnread', id, unread),
  renameBranch: (id, newBranch) => ipcRenderer.invoke('workspaces:renameBranch', id, newBranch),
  reorderWorkspaces: (ids) => ipcRenderer.invoke('workspaces:reorder', ids),

  queuePrompt: (id, text) => ipcRenderer.invoke('queue:add', id, text),
  removeQueuedPrompt: (id, promptId) => ipcRenderer.invoke('queue:remove', id, promptId),
  flushQueuedPrompts: (id) => ipcRenderer.invoke('queue:flush', id),

  ptyStart: (id, cols, rows) => ipcRenderer.invoke('pty:start', id, cols, rows),
  ptyWrite: (id, data) => ipcRenderer.invoke('pty:write', id, data),
  ptyResize: (id, cols, rows) => ipcRenderer.invoke('pty:resize', id, cols, rows),
  saveClipboardImage: (mime, bytes) => ipcRenderer.invoke('clipboard:saveImage', mime, bytes),
  restartAgent: (id) => ipcRenderer.invoke('agent:restart', id),
  stopAgent: (id) => ipcRenderer.invoke('agent:stop', id),
  nvimStart: (id, cols, rows) => ipcRenderer.invoke('nvim:start', id, cols, rows),

  getRepoScripts: (repoPath) => ipcRenderer.invoke('repos:getScripts', repoPath),
  setRepoScripts: (repoPath, scripts) => ipcRenderer.invoke('repos:setScripts', repoPath, scripts),
  retrySetup: (id) => ipcRenderer.invoke('scripts:retrySetup', id),
  readSetupLog: (id) => ipcRenderer.invoke('scripts:readSetupLog', id),
  runScriptStart: (id, cols, rows) => ipcRenderer.invoke('scripts:runStart', id, cols, rows),
  runScriptStop: (id) => ipcRenderer.invoke('scripts:runStop', id),
  runScriptScrollback: (id) => ipcRenderer.invoke('scripts:runScrollback', id),
  runScriptStatus: (id) => ipcRenderer.invoke('scripts:runStatus', id),
  onPtyData: (cb) => {
    const listener = (_e: unknown, id: string, data: string) => cb(id, data);
    ipcRenderer.on('pty:data', listener);
    return () => ipcRenderer.off('pty:data', listener);
  },
  onPtyExit: (cb) => {
    const listener = (_e: unknown, id: string, code: number) => cb(id, code);
    ipcRenderer.on('pty:exit', listener);
    return () => ipcRenderer.off('pty:exit', listener);
  },
  onPtyRestart: (cb) => {
    const listener = (_e: unknown, id: string) => cb(id);
    ipcRenderer.on('pty:restart', listener);
    return () => ipcRenderer.off('pty:restart', listener);
  },
  onPtyStopped: (cb) => {
    const listener = (_e: unknown, id: string) => cb(id);
    ipcRenderer.on('pty:stopped', listener);
    return () => ipcRenderer.off('pty:stopped', listener);
  },

  sandboxControlState: (id) => ipcRenderer.invoke('sandbox:controlState', id),
  takeSandboxControl: (id) => ipcRenderer.invoke('sandbox:takeControl', id),
  onSandboxControl: (cb) => {
    const listener = (_e: unknown, state: unknown) => cb(state as never);
    ipcRenderer.on('sandbox:control', listener);
    return () => ipcRenderer.off('sandbox:control', listener);
  },

  getDiff: (id) => ipcRenderer.invoke('git:diff', id),
  getDiffStats: (id) => ipcRenderer.invoke('git:stats', id),
  getWorktreeSizes: () => ipcRenderer.invoke('workspaces:sizes'),
  sampleResources: () => ipcRenderer.invoke('resources:sample'),
  findPR: (id) => ipcRenderer.invoke('git:findPR', id),
  verifyLinear: (id) => ipcRenderer.invoke('linear:verify', id),
  listBranches: (id) => ipcRenderer.invoke('git:listBranches', id),
  switchBranch: (id, branch) => ipcRenderer.invoke('git:switchBranch', id, branch),
  mergeWorktree: (id) => ipcRenderer.invoke('git:merge', id),

  listSelfTuneRuns: () => ipcRenderer.invoke('selfTune:list'),
  startSelfTune: () => ipcRenderer.invoke('selfTune:run'),
  getSelfTuneOutput: (runId) => ipcRenderer.invoke('selfTune:output', runId),
  listSelfTuneReports: () => ipcRenderer.invoke('selfTune:reports'),
  openSelfTuneReport: (loginId) => ipcRenderer.invoke('selfTune:openReport', loginId),
  readSelfTuneLessons: () => ipcRenderer.invoke('selfTune:lessons'),
  onSelfTuneUpdate: (cb) => {
    const listener = (_e: unknown, run: unknown) => cb(run as never);
    ipcRenderer.on('selfTune:update', listener);
    return () => ipcRenderer.off('selfTune:update', listener);
  },
  onSelfTuneOutput: (cb) => {
    const listener = (_e: unknown, runId: string, chunk: string) => cb(runId, chunk);
    ipcRenderer.on('selfTune:output', listener);
    return () => ipcRenderer.off('selfTune:output', listener);
  },

  onWorkspaceUpdate: (cb) => {
    const listener = (_e: unknown, w: unknown) => cb(w as never);
    ipcRenderer.on('workspace:update', listener);
    return () => ipcRenderer.off('workspace:update', listener);
  },
  onWorkspaceRemoved: (cb) => {
    const listener = (_e: unknown, id: string) => cb(id);
    ipcRenderer.on('workspace:removed', listener);
    return () => ipcRenderer.off('workspace:removed', listener);
  },
  onWorkspacesRemoved: (cb) => {
    const listener = (_e: unknown, ids: string[]) => cb(ids);
    ipcRenderer.on('workspaces:removed', listener);
    return () => ipcRenderer.off('workspaces:removed', listener);
  },
  onWorkspacesDeleteProgress: (cb) => {
    const listener = (_e: unknown, done: number, total: number) => cb(done, total);
    ipcRenderer.on('workspaces:deleteProgress', listener);
    return () => ipcRenderer.off('workspaces:deleteProgress', listener);
  },
  onWorkspaceFocus: (cb) => {
    const listener = (_e: unknown, id: string) => cb(id);
    ipcRenderer.on('workspace:focus', listener);
    return () => ipcRenderer.off('workspace:focus', listener);
  },
  onAgentFinished: (cb) => {
    const listener = (_e: unknown, id: string, focused: boolean) => cb(id, focused);
    ipcRenderer.on('agent:finished', listener);
    return () => ipcRenderer.off('agent:finished', listener);
  },
  onAgentNeedsInput: (cb) => {
    const listener = (_e: unknown, id: string, focused: boolean) => cb(id, focused);
    ipcRenderer.on('agent:needs-input', listener);
    return () => ipcRenderer.off('agent:needs-input', listener);
  },
  onAgentTool: (cb) => {
    const listener = (_e: unknown, id: string, tool: string | null) => cb(id, tool);
    ipcRenderer.on('agent:tool', listener);
    return () => ipcRenderer.off('agent:tool', listener);
  },
  onAgentContext: (cb) => {
    const listener = (_e: unknown, id: string, tokens: number) => cb(id, tokens);
    ipcRenderer.on('agent:context', listener);
    return () => ipcRenderer.off('agent:context', listener);
  },
  onRepoSyncState: (cb) => {
    const listener = (_e: unknown, s: unknown) => cb(s as never);
    ipcRenderer.on('repo:syncState', listener);
    return () => ipcRenderer.off('repo:syncState', listener);
  },
  onUsageUpdate: (cb) => {
    const listener = (_e: unknown, snap: unknown) => cb(snap as never);
    ipcRenderer.on('usage:update', listener);
    return () => ipcRenderer.off('usage:update', listener);
  },
  onAccountUsageUpdate: (cb) => {
    const listener = (_e: unknown, byId: unknown) => cb(byId as never);
    ipcRenderer.on('accounts:usageUpdate', listener);
    return () => ipcRenderer.off('accounts:usageUpdate', listener);
  },
  onWorkspaceAccountsUpdate: (cb) => {
    const listener = (_e: unknown, byId: unknown) => cb(byId as never);
    ipcRenderer.on('accounts:workspaceAccounts', listener);
    return () => ipcRenderer.off('accounts:workspaceAccounts', listener);
  },
  onReposUpdate: (cb) => {
    const listener = (_e: unknown, repos: unknown) => cb(repos as never);
    ipcRenderer.on('repos:update', listener);
    return () => ipcRenderer.off('repos:update', listener);
  },
};

contextBridge.exposeInMainWorld('orchestra', api);
