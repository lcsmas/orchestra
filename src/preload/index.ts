import { contextBridge, ipcRenderer } from 'electron';
import type { OrchestraAPI } from '../shared/ipc';

const api: OrchestraAPI = {
  addRepo: (p) => ipcRenderer.invoke('repos:add', p),
  listRepos: () => ipcRenderer.invoke('repos:list'),
  removeRepo: (p) => ipcRenderer.invoke('repos:remove', p),
  pickDirectory: () => ipcRenderer.invoke('dialog:pickDir'),
  openExternal: (url) => ipcRenderer.invoke('app:openExternal', url),

  listWorkspaces: () => ipcRenderer.invoke('workspaces:list'),
  createWorkspace: (input) => ipcRenderer.invoke('workspaces:create', input),
  archiveWorkspace: (id) => ipcRenderer.invoke('workspaces:archive', id),
  unarchiveWorkspace: (id) => ipcRenderer.invoke('workspaces:unarchive', id),
  deleteWorkspace: (id) => ipcRenderer.invoke('workspaces:delete', id),
  openInEditor: (id, editor) => ipcRenderer.invoke('workspaces:openInEditor', id, editor),
  markSeen: (id) => ipcRenderer.invoke('workspaces:markSeen', id),
  renameBranch: (id, newBranch) => ipcRenderer.invoke('workspaces:renameBranch', id, newBranch),

  ptyStart: (id, cols, rows) => ipcRenderer.invoke('pty:start', id, cols, rows),
  ptyWrite: (id, data) => ipcRenderer.invoke('pty:write', id, data),
  ptyResize: (id, cols, rows) => ipcRenderer.invoke('pty:resize', id, cols, rows),
  ptyStop: (id) => ipcRenderer.invoke('pty:stop', id),
  restartAgent: (id) => ipcRenderer.invoke('agent:restart', id),
  ptyScrollback: (id) => ipcRenderer.invoke('pty:scrollback', id),
  ptyClearScrollback: (id) => ipcRenderer.invoke('pty:clearScrollback', id),
  nvimStart: (id, cols, rows) => ipcRenderer.invoke('nvim:start', id, cols, rows),
  nvimStop: (id) => ipcRenderer.invoke('nvim:stop', id),

  getRepoScripts: (repoPath) => ipcRenderer.invoke('repos:getScripts', repoPath),
  setRepoScripts: (repoPath, scripts) => ipcRenderer.invoke('repos:setScripts', repoPath, scripts),
  retrySetup: (id) => ipcRenderer.invoke('scripts:retrySetup', id),
  readSetupLog: (id) => ipcRenderer.invoke('scripts:readSetupLog', id),
  runScriptStart: (id, cols, rows) => ipcRenderer.invoke('scripts:runStart', id, cols, rows),
  runScriptStop: (id) => ipcRenderer.invoke('scripts:runStop', id),
  runScriptScrollback: (id) => ipcRenderer.invoke('scripts:runScrollback', id),
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

  getDiff: (id) => ipcRenderer.invoke('git:diff', id),
  getDiffStats: (id) => ipcRenderer.invoke('git:stats', id),
  commit: (id, msg) => ipcRenderer.invoke('git:commit', id, msg),
  push: (id) => ipcRenderer.invoke('git:push', id),
  createPR: (id, title, body) => ipcRenderer.invoke('git:pr', id, title, body),
  findPR: (id) => ipcRenderer.invoke('git:findPR', id),
  listBranches: (id) => ipcRenderer.invoke('git:listBranches', id),
  switchBranch: (id, branch) => ipcRenderer.invoke('git:switchBranch', id, branch),
  mergeWorktree: (id) => ipcRenderer.invoke('git:merge', id),

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
};

contextBridge.exposeInMainWorld('orchestra', api);
