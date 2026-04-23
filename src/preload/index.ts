import { contextBridge, ipcRenderer } from 'electron';
import type { OrchestraAPI } from '../shared/ipc';

const api: OrchestraAPI = {
  addRepo: (p) => ipcRenderer.invoke('repos:add', p),
  listRepos: () => ipcRenderer.invoke('repos:list'),
  removeRepo: (p) => ipcRenderer.invoke('repos:remove', p),
  pickDirectory: () => ipcRenderer.invoke('dialog:pickDir'),

  listWorkspaces: () => ipcRenderer.invoke('workspaces:list'),
  createWorkspace: (input) => ipcRenderer.invoke('workspaces:create', input),
  archiveWorkspace: (id) => ipcRenderer.invoke('workspaces:archive', id),
  openInEditor: (id, editor) => ipcRenderer.invoke('workspaces:openInEditor', id, editor),

  ptyStart: (id, cols, rows) => ipcRenderer.invoke('pty:start', id, cols, rows),
  ptyWrite: (id, data) => ipcRenderer.invoke('pty:write', id, data),
  ptyResize: (id, cols, rows) => ipcRenderer.invoke('pty:resize', id, cols, rows),
  ptyStop: (id) => ipcRenderer.invoke('pty:stop', id),
  ptyScrollback: (id) => ipcRenderer.invoke('pty:scrollback', id),
  ptyClearScrollback: (id) => ipcRenderer.invoke('pty:clearScrollback', id),
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

  getDiff: (id) => ipcRenderer.invoke('git:diff', id),
  commit: (id, msg) => ipcRenderer.invoke('git:commit', id, msg),
  push: (id) => ipcRenderer.invoke('git:push', id),
  createPR: (id, title, body) => ipcRenderer.invoke('git:pr', id, title, body),

  onWorkspaceUpdate: (cb) => {
    const listener = (_e: unknown, w: unknown) => cb(w as never);
    ipcRenderer.on('workspace:update', listener);
    const listener2 = (_e: unknown, id: string) =>
      cb({ id, status: 'stopped' } as never);
    ipcRenderer.on('workspace:removed', listener2);
    return () => {
      ipcRenderer.off('workspace:update', listener);
      ipcRenderer.off('workspace:removed', listener2);
    };
  },
};

contextBridge.exposeInMainWorld('orchestra', api);
