import { useEffect, useState } from 'react';
import { useStore } from '../store';
import type { Workspace, WorkspaceStatus } from '../../shared/types';
import { SoundSettings } from './SoundSettings';
import { RepoScriptsModal } from './RepoScriptsModal';
import { dialog } from './Dialog';

interface Props {
  onNewFromRepo: () => void;
}

/** Compact human size for a worktree, e.g. 1536 → "1.5 KB", 2.8e9 → "2.6 GB".
 *  Binary units (matches what `du`/file managers report). */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let val = bytes / 1024;
  let i = 0;
  while (val >= 1024 && i < units.length - 1) {
    val /= 1024;
    i += 1;
  }
  return `${val < 10 ? val.toFixed(1) : Math.round(val)} ${units[i]}`;
}

function BellIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="15"
      height="15"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
      <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
    </svg>
  );
}

function FolderPlusIcon() {
  return (
    <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" focusable="false">
      <path
        fill="currentColor"
        d="M1.5 3A1.5 1.5 0 0 1 3 1.5h3.09a1.5 1.5 0 0 1 1.06.44l.91.91H13A1.5 1.5 0 0 1 14.5 4.35V5.5H13V4.35a.35.35 0 0 0-.35-.35H7.65a.5.5 0 0 1-.35-.15l-1.06-1.06a.5.5 0 0 0-.35-.14H3a.5.5 0 0 0-.5.5v8.35a.35.35 0 0 0 .35.35H7.5V13H2.85a1.35 1.35 0 0 1-1.35-1.35V3ZM12 8a.5.5 0 0 1 .5.5V11h2.5a.5.5 0 0 1 0 1H12.5v2.5a.5.5 0 0 1-1 0V12H9a.5.5 0 0 1 0-1h2.5V8.5A.5.5 0 0 1 12 8Z"
      />
    </svg>
  );
}

function ArchiveIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">
      <path
        fill="currentColor"
        d="M2 2h12a1 1 0 0 1 1 1v2a1 1 0 0 1-1 1h-0.2v7.4A1.6 1.6 0 0 1 12.2 15H3.8A1.6 1.6 0 0 1 2.2 13.4V6H2a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1Zm1 1v2h10V3H3Zm0.2 3v7.4c0 .33.27.6.6.6h8.4c.33 0 .6-.27.6-.6V6H3.2Zm3.3 2h3a.5.5 0 0 1 0 1h-3a.5.5 0 0 1 0-1Z"
      />
    </svg>
  );
}

function RestoreIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">
      <path
        fill="currentColor"
        d="M8 3a5 5 0 1 1-4.9 6h1.05A4 4 0 1 0 8 4V5.6L5.5 3.8 8 2v1Z"
      />
    </svg>
  );
}

function GearIcon() {
  // Lucide `settings` — same stroke vocabulary as the merge / restart / PR
  // icons elsewhere in the app, so it visually belongs to that family.
  return (
    <svg
      viewBox="0 0 24 24"
      width="13"
      height="13"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      shapeRendering="geometricPrecision"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2Z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">
      <path
        fill="currentColor"
        d="M6 2h4a1 1 0 0 1 1 1v1h3a.5.5 0 0 1 0 1h-.6l-.77 8.47A1.5 1.5 0 0 1 11.14 15H4.86a1.5 1.5 0 0 1-1.49-1.53L2.6 5H2a.5.5 0 0 1 0-1h3V3a1 1 0 0 1 1-1Zm0 2h4V3H6v1Zm-2.4 1 .77 8.41a.5.5 0 0 0 .49.47h6.28a.5.5 0 0 0 .5-.47L12.4 5H3.6Zm2.4 2a.5.5 0 0 1 1 0v5a.5.5 0 0 1-1 0V7Zm3 0a.5.5 0 0 1 1 0v5a.5.5 0 0 1-1 0V7Z"
      />
    </svg>
  );
}

// Exact Lucide paths — clean, well-balanced strokes. Rendered at 13×13 with
// 1.6-weight strokes on a 24-viewBox so lines stay crisp and airy.
const ICON_PROPS = {
  viewBox: '0 0 24 24',
  width: 13,
  height: 13,
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.6,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
  focusable: false as const,
  shapeRendering: 'geometricPrecision',
};

function PROpenIcon() {
  return (
    <svg {...ICON_PROPS}>
      <circle cx="6" cy="6" r="3" />
      <circle cx="6" cy="18" r="3" />
      <path d="M6 9v6" />
      <circle cx="18" cy="18" r="3" />
      <path d="M13 6h3a2 2 0 0 1 2 2v7" />
    </svg>
  );
}

function PRMergedIcon() {
  return (
    <svg {...ICON_PROPS}>
      <circle cx="18" cy="18" r="3" />
      <circle cx="6" cy="6" r="3" />
      <path d="M6 21V9a9 9 0 0 0 9 9" />
    </svg>
  );
}

function PRClosedIcon() {
  return (
    <svg {...ICON_PROPS}>
      <circle cx="6" cy="6" r="3" />
      <circle cx="18" cy="18" r="3" />
      <path d="M6 9v12" />
      <path d="m21 3-6 6" />
      <path d="m21 9-6-6" />
      <path d="M18 11.5V15" />
    </svg>
  );
}

function GitHubIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">
      <path
        fill="currentColor"
        d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8z"
      />
    </svg>
  );
}

function LogsIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">
      <path
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M3 2.25h7L13 5v8.75H3V2.25Z M9.5 2.5V5.5H13 M5.25 8h5.5 M5.25 10.5h5.5"
      />
    </svg>
  );
}

function ExternalLinkIcon() {
  return (
    <svg viewBox="0 0 16 16" width="10" height="10" aria-hidden="true" focusable="false">
      <path
        fill="currentColor"
        d="M9 1a.5.5 0 0 1 .5-.5h5a.5.5 0 0 1 .5.5v5a.5.5 0 0 1-1 0V2.207L7.354 8.854a.5.5 0 1 1-.708-.708L13.293 1.5H9.5A.5.5 0 0 1 9 1zM2.5 3A1.5 1.5 0 0 0 1 4.5v9A1.5 1.5 0 0 0 2.5 15h9a1.5 1.5 0 0 0 1.5-1.5v-5a.5.5 0 0 0-1 0v5a.5.5 0 0 1-.5.5h-9a.5.5 0 0 1-.5-.5v-9a.5.5 0 0 1 .5-.5h5a.5.5 0 0 0 0-1h-5z"
      />
    </svg>
  );
}

function groupByRepo(list: Workspace[]): Map<string, Workspace[]> {
  const groups = new Map<string, Workspace[]>();
  for (const ws of list) {
    const existing = groups.get(ws.repoPath);
    if (existing) existing.push(ws);
    else groups.set(ws.repoPath, [ws]);
  }
  return groups;
}

export function Sidebar({ onNewFromRepo }: Props) {
  const {
    workspaces,
    repos,
    activeId,
    stats,
    sizes,
    prs,
    tools,
    repoSync,
    setActive,
    archive,
    unarchive,
    deleteWorkspace,
    createWorkspace,
    reorderWorkspaces,
    reorderRepos,
  } = useStore();
  const [version, setVersion] = useState('');
  const [archivedOpen, setArchivedOpen] = useState(false);
  const [soundSettingsOpen, setSoundSettingsOpen] = useState(false);
  const [scriptsRepoPath, setScriptsRepoPath] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [selectedArchived, setSelectedArchived] = useState<Set<string>>(new Set());
  // Workspaces whose worktree is mid-deletion — drives the per-row spinner and
  // disables that row's buttons until `deleteWorkspace` resolves.
  const [deletingIds, setDeletingIds] = useState<Set<string>>(new Set());
  // Determinate progress for a bulk "Delete N" run: how many of `total` have
  // finished. Null when no bulk delete is in flight.
  const [bulkDelete, setBulkDelete] = useState<{ done: number; total: number } | null>(null);
  // Drag-and-drop reordering state. A workspace drag and a repo-group drag are
  // mutually exclusive — only one of these is ever non-null at a time.
  const [dragWs, setDragWs] = useState<{ id: string; repoPath: string } | null>(null);
  const [dropWs, setDropWs] = useState<{ id: string; pos: 'before' | 'after' } | null>(null);
  const [dragRepo, setDragRepo] = useState<string | null>(null);
  const [dropRepo, setDropRepo] = useState<{ path: string; pos: 'before' | 'after' } | null>(null);

  useEffect(() => {
    void window.orchestra.getAppVersion().then(setVersion);
  }, []);

  const clearDnd = () => {
    setDragWs(null);
    setDropWs(null);
    setDragRepo(null);
    setDropRepo(null);
  };

  // Commit a workspace move: pull the dragged id out of the full ordering and
  // re-insert it before/after the drop target, then persist the new order.
  const commitWsDrop = () => {
    if (!dragWs || !dropWs || dragWs.id === dropWs.id) return clearDnd();
    const ids = workspaces.map((w) => w.id);
    const from = ids.indexOf(dragWs.id);
    if (from < 0) return clearDnd();
    ids.splice(from, 1);
    let to = ids.indexOf(dropWs.id);
    if (to < 0) return clearDnd();
    if (dropWs.pos === 'after') to += 1;
    ids.splice(to, 0, dragWs.id);
    void reorderWorkspaces(ids);
    clearDnd();
  };

  const commitRepoDrop = () => {
    if (!dragRepo || !dropRepo || dragRepo === dropRepo.path) return clearDnd();
    const paths = repos.map((r) => r.path);
    const from = paths.indexOf(dragRepo);
    if (from < 0) return clearDnd();
    paths.splice(from, 1);
    let to = paths.indexOf(dropRepo.path);
    if (to < 0) return clearDnd();
    if (dropRepo.pos === 'after') to += 1;
    paths.splice(to, 0, dragRepo);
    void reorderRepos(paths);
    clearDnd();
  };

  const dropPosFromEvent = (e: React.DragEvent): 'before' | 'after' => {
    const rect = e.currentTarget.getBoundingClientRect();
    return e.clientY < rect.top + rect.height / 2 ? 'before' : 'after';
  };

  const startRename = (e: React.MouseEvent, ws: Workspace) => {
    e.stopPropagation();
    setRenamingId(ws.id);
    setRenameDraft(ws.branch);
  };

  const commitRename = async (ws: Workspace) => {
    const next = renameDraft.trim();
    setRenamingId(null);
    if (!next || next === ws.branch) return;
    try {
      await window.orchestra.renameBranch(ws.id, next);
    } catch (err) {
      alert(`Could not rename branch: ${(err as Error).message}`);
    }
  };

  const active = workspaces.filter((w) => !w.archived);
  const archived = workspaces.filter((w) => w.archived);

  const allArchivedSelected =
    archived.length > 0 && archived.every((w) => selectedArchived.has(w.id));
  const someArchivedSelected = selectedArchived.size > 0 && !allArchivedSelected;

  // Reset selection when the section is collapsed.
  useEffect(() => {
    if (!archivedOpen) setSelectedArchived(new Set());
  }, [archivedOpen]);

  const toggleArchivedSelection = (id: string) => {
    setSelectedArchived((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleSelectAllArchived = () => {
    setSelectedArchived(allArchivedSelected ? new Set() : new Set(archived.map((w) => w.id)));
  };

  const markDeleting = (id: string, on: boolean) =>
    setDeletingIds((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  const onDeleteSelectedArchived = async () => {
    const ids = archived.filter((w) => selectedArchived.has(w.id)).map((w) => w.id);
    if (ids.length === 0) return;
    const ok = await dialog.confirm({
      title: ids.length === 1 ? 'Delete workspace' : 'Delete archived workspaces',
      message:
        ids.length === 1
          ? 'Delete the selected workspace permanently?'
          : `Delete ${ids.length} archived workspaces permanently?`,
      detail:
        ids.length === 1
          ? 'This removes the git worktree from disk.'
          : 'This removes all selected git worktrees from disk.',
      tone: 'danger',
      confirmLabel: ids.length === 1 ? 'Delete' : `Delete ${ids.length}`,
    });
    if (!ok) return;
    setSelectedArchived(new Set());
    // Sequential so the bar advances one worktree at a time and disk I/O stays
    // gentle. Each row spins while its own deletion is in flight.
    setBulkDelete({ done: 0, total: ids.length });
    for (const id of ids) {
      markDeleting(id, true);
      try {
        await deleteWorkspace(id);
      } catch (err) {
        void dialog.error('Could not delete workspace', (err as Error).message);
      } finally {
        markDeleting(id, false);
        setBulkDelete((prev) => (prev ? { ...prev, done: prev.done + 1 } : prev));
      }
    }
    setBulkDelete(null);
  };

  const onArchive = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    try {
      await archive(id);
    } catch (err) {
      void dialog.error('Could not archive workspace', (err as Error).message);
    }
  };

  const onUnarchive = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    try {
      await unarchive(id);
    } catch (err) {
      void dialog.error('Could not restore workspace', (err as Error).message);
    }
  };

  const onDelete = async (e: React.MouseEvent, id: string, name: string) => {
    e.stopPropagation();
    const ok = await dialog.confirm({
      title: 'Delete workspace',
      message: `Delete "${name}" permanently?`,
      detail: 'This removes the git worktree from disk.',
      tone: 'danger',
      confirmLabel: 'Delete',
    });
    if (!ok) return;
    markDeleting(id, true);
    try {
      await deleteWorkspace(id);
    } catch (err) {
      void dialog.error('Could not delete workspace', (err as Error).message);
    } finally {
      markDeleting(id, false);
    }
  };

  const onAddToRepo = async (e: React.MouseEvent, repoPath: string) => {
    e.stopPropagation();
    try {
      await createWorkspace({ repoPath });
    } catch (err) {
      void dialog.error('Could not create workspace', (err as Error).message);
    }
  };

  const activeGroups = groupByRepo(active);
  // Show every registered repo as a section, plus any orphan repoPaths that
  // still have workspaces (e.g. the repo entry was removed but workspaces
  // remain). This way a repo header stays visible — with a 0 count and an
  // active "+" button — even after every workspace in it is archived.
  const repoOrder: string[] = [
    ...repos.map((r) => r.path),
    ...Array.from(activeGroups.keys()).filter((p) => !repos.some((r) => r.path === p)),
  ];

  const repoLabel = (repoPath: string) => {
    const repo = repos.find((r) => r.path === repoPath);
    if (repo) return repo.name;
    const segments = repoPath.split('/').filter(Boolean);
    return segments[segments.length - 1] ?? repoPath;
  };

  const repoRemoteUrl = (repoPath: string): string | undefined => {
    return repos.find((r) => r.path === repoPath)?.remoteUrl;
  };

  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <h1>Orchestra</h1>
        <div className="sidebar-header-actions">
          <button
            className="header-icon-btn"
            onClick={() => setSoundSettingsOpen(true)}
            title="Notification sound settings"
            aria-label="Notification sound settings"
          >
            <BellIcon />
          </button>
          <button
            className="header-repo-btn"
            onClick={onNewFromRepo}
            title="New workspace from a git repo…"
            aria-label="New workspace from a git repo"
          >
            <FolderPlusIcon />
            <span>Repo</span>
          </button>
        </div>
      </div>
      <div className="ws-list">
        {repoOrder.length === 0 && archived.length === 0 && (
          <div style={{ padding: '20px', color: 'var(--text-dim)', fontSize: 12 }}>
            No agents running. Click <strong>Repo</strong> to map a git repo and spawn one.
          </div>
        )}
        {repoOrder.map((repoPath) => {
          const items = activeGroups.get(repoPath) ?? [];
          // Only registered repos can be reordered — orphan repoPaths (entry
          // removed but workspaces remain) always trail and aren't draggable.
          const isRegisteredRepo = repos.some((r) => r.path === repoPath);
          const repoDnd =
            dragRepo === repoPath
              ? ' repo-dragging'
              : dropRepo?.path === repoPath
                ? ` repo-drop-${dropRepo.pos}`
                : '';
          return (
          <div
            key={repoPath}
            className={`repo-section${repoDnd}`}
            onDragOver={(e) => {
              if (!dragRepo || dragRepo === repoPath || !isRegisteredRepo) return;
              e.preventDefault();
              e.dataTransfer.dropEffect = 'move';
              const pos = dropPosFromEvent(e);
              setDropRepo((prev) =>
                prev?.path === repoPath && prev.pos === pos ? prev : { path: repoPath, pos },
              );
            }}
            onDrop={(e) => {
              if (!dragRepo) return;
              e.preventDefault();
              commitRepoDrop();
            }}
          >
            <div
              className="repo-header"
              title={repoPath}
              draggable={isRegisteredRepo}
              onDragStart={(e) => {
                if ((e.target as HTMLElement).closest('button')) {
                  e.preventDefault();
                  return;
                }
                setDragWs(null);
                setDragRepo(repoPath);
                e.dataTransfer.effectAllowed = 'move';
                try {
                  e.dataTransfer.setData('text/plain', repoPath);
                } catch {
                  /* some platforms reject setData — drag still works */
                }
              }}
              onDragEnd={clearDnd}
            >
              <span className="repo-name">{repoLabel(repoPath)}</span>
              <span className="repo-header-actions">
                <span className="repo-count">{items.length}</span>
                {repoRemoteUrl(repoPath) && (
                  <button
                    className="repo-scripts-btn"
                    title={`Open ${repoLabel(repoPath)} on GitHub`}
                    aria-label={`Open ${repoLabel(repoPath)} on GitHub`}
                    onClick={(e) => {
                      e.stopPropagation();
                      const url = repoRemoteUrl(repoPath);
                      if (url) window.orchestra.openExternal(url);
                    }}
                  >
                    <GitHubIcon />
                  </button>
                )}
                <button
                  className="repo-scripts-btn"
                  title={`Configure setup / run / archive scripts for ${repoLabel(repoPath)}`}
                  aria-label={`Configure scripts for ${repoLabel(repoPath)}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    setScriptsRepoPath(repoPath);
                  }}
                >
                  <GearIcon />
                </button>
                <button
                  className="repo-add"
                  title={`New workspace in ${repoLabel(repoPath)}`}
                  aria-label={`New workspace in ${repoLabel(repoPath)}`}
                  onClick={(e) => onAddToRepo(e, repoPath)}
                >
                  +
                </button>
              </span>
            </div>
            {(() => {
              const sync = repoSync[repoPath];
              if (!sync) return null;
              return (
                <div
                  className={`repo-sync ${sync.syncing ? 'syncing' : ''} ${sync.error ? 'error' : ''}`}
                  title={
                    sync.error
                      ? `Last fetch failed: ${sync.error}`
                      : sync.syncedAt
                        ? `Last synced ${new Date(sync.syncedAt).toLocaleTimeString()}`
                        : 'Not yet synced'
                  }
                  onClick={(e) => {
                    e.stopPropagation();
                    if (!sync.syncing) window.orchestra.syncRepoBase(repoPath);
                  }}
                >
                  <span className="repo-sync-base">{sync.baseBranch}</span>
                  {!sync.hasUpstream ? (
                    <span className="repo-sync-status muted">no upstream</span>
                  ) : sync.behind === 0 && sync.ahead === 0 ? (
                    <span className="repo-sync-status muted">
                      up to date
                    </span>
                  ) : (
                    <span className="repo-sync-status">
                      {sync.behind > 0 && <span className="behind">↓{sync.behind}</span>}
                      {sync.ahead > 0 && <span className="ahead">↑{sync.ahead}</span>}
                    </span>
                  )}
                  {sync.syncing && <span className="repo-sync-spinner" />}
                </div>
              );
            })()}
            {items.map((w) => {
              const s = stats[w.id];
              const hasChanges = !!s && (s.additions > 0 || s.deletions > 0);
              const sizeBytes = sizes[w.id];
              const prRecord = prs[w.id];
              const allPRs = prRecord?.all ?? [];
              // Show open first, then the rest in gh's newest-first order.
              const orderedPRs = allPRs.slice().sort((a, b) => {
                if (a.state === 'OPEN' && b.state !== 'OPEN') return -1;
                if (b.state === 'OPEN' && a.state !== 'OPEN') return 1;
                return 0;
              });
              const visiblePRs = orderedPRs.slice(0, 3);
              const hiddenPRs = orderedPRs.length - visiblePRs.length;
              // The purple #N merged PR badge already conveys "merged", so
              // suppress the standalone merged pill when one is visible.
              const hasMergedPRBadge = visiblePRs.some((p) => p.state === 'MERGED');
              const wsDnd =
                dragWs?.id === w.id
                  ? ' dragging'
                  : dropWs?.id === w.id
                    ? ` drop-${dropWs.pos}`
                    : '';
              return (
                <div
                  key={w.id}
                  className={`ws-item ${activeId === w.id ? 'active' : ''} ${w.mergedAt && !w.divergedFromBase ? 'merged' : ''}${wsDnd}`}
                  onClick={() => setActive(w.id)}
                  draggable={renamingId !== w.id}
                  onDragStart={(e) => {
                    if ((e.target as HTMLElement).closest('button, input')) {
                      e.preventDefault();
                      return;
                    }
                    e.stopPropagation();
                    setDragRepo(null);
                    setDragWs({ id: w.id, repoPath: w.repoPath });
                    e.dataTransfer.effectAllowed = 'move';
                    try {
                      e.dataTransfer.setData('text/plain', w.id);
                    } catch {
                      /* some platforms reject setData — drag still works */
                    }
                  }}
                  onDragOver={(e) => {
                    // Same-repo reordering only — cross-repo drops are a no-op.
                    if (!dragWs || dragWs.repoPath !== w.repoPath || dragWs.id === w.id) return;
                    e.preventDefault();
                    e.dataTransfer.dropEffect = 'move';
                    const pos = dropPosFromEvent(e);
                    setDropWs((prev) =>
                      prev?.id === w.id && prev.pos === pos ? prev : { id: w.id, pos },
                    );
                  }}
                  onDrop={(e) => {
                    if (!dragWs) return;
                    e.preventDefault();
                    e.stopPropagation();
                    commitWsDrop();
                  }}
                  onDragEnd={clearDnd}
                >
                  <div
                    className={`ws-dot ${w.status as WorkspaceStatus}`}
                    title={
                      w.status === 'running'
                        ? tools[w.id]
                          ? `Agent is working… (${tools[w.id]})`
                          : 'Agent is working…'
                        : w.status === 'idle'
                          ? 'Agent is idle'
                          : w.status
                    }
                  />
                  <div className="ws-body">
                    <div className="ws-name-row">
                      {renamingId === w.id ? (
                        <input
                          className="ws-name-input"
                          autoFocus
                          value={renameDraft}
                          onClick={(e) => e.stopPropagation()}
                          onChange={(e) => setRenameDraft(e.target.value)}
                          onBlur={() => commitRename(w)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') commitRename(w);
                            else if (e.key === 'Escape') setRenamingId(null);
                          }}
                        />
                      ) : (
                        <div
                          className="ws-name"
                          title={
                            w.branchManuallySet
                              ? `${w.branch} (locked)`
                              : `${w.branch} — double-click to rename`
                          }
                          onDoubleClick={(e) => startRename(e, w)}
                        >
                          {w.branch}
                          {!w.branchManuallySet && (
                            <span className="ws-name-auto"> · auto</span>
                          )}
                        </div>
                      )}
                      {w.mergedAt && !w.divergedFromBase && !hasMergedPRBadge && (
                        <span className="merged-pill" title={`Merged into ${w.baseBranch}`}>
                          merged
                        </span>
                      )}
                      {w.releasedAt && (
                        <span
                          className="released-pill"
                          title={
                            w.releasedVersion
                              ? `Shipped in release ${w.releasedVersion}`
                              : 'Shipped in a published release'
                          }
                        >
                          {w.releasedVersion ?? 'released'}
                        </span>
                      )}
                      {!!w.unpushedAhead && w.unpushedAhead > 0 && (
                        <span
                          className="unpushed-pill"
                          title={`${w.unpushedAhead} commit${w.unpushedAhead === 1 ? '' : 's'} not yet on origin — ready to push`}
                        >
                          ↑{w.unpushedAhead}
                        </span>
                      )}
                      {hasChanges && (
                        <span className="diff-indicator compact" title={`${s.files} file${s.files === 1 ? '' : 's'} changed`}>
                          {s.additions > 0 && <span className="add">+{s.additions}</span>}
                          {s.deletions > 0 && <span className="del">−{s.deletions}</span>}
                        </span>
                      )}
                      {w.setupStatus === 'failed' && (
                        <span
                          className="setup-pill failed"
                          title={`Setup script failed: ${w.setupError ?? 'see log'}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            setActive(w.id);
                          }}
                        >
                          setup
                        </span>
                      )}
                      {w.setupStatus === 'running' && (
                        <span className="setup-pill running" title="Setup script running">
                          setup…
                        </span>
                      )}
                    </div>
                    {(visiblePRs.length > 0 || sizeBytes != null) && (
                      <div className="ws-meta-row">
                        <span className="pr-badges">
                          {visiblePRs.map((p) => (
                            <span
                              key={p.number}
                              className={`pr-badge ${p.state.toLowerCase()}`}
                              title={`PR #${p.number} · ${p.state.toLowerCase()} · ${p.title}`}
                              onClick={(e) => {
                                e.stopPropagation();
                                window.orchestra.openExternal(p.url);
                              }}
                            >
                              {p.state === 'MERGED' ? (
                                <PRMergedIcon />
                              ) : p.state === 'CLOSED' ? (
                                <PRClosedIcon />
                              ) : (
                                <PROpenIcon />
                              )}
                              <span className="pr-badge-num">#{p.number}</span>
                            </span>
                          ))}
                          {hiddenPRs > 0 && (
                            <span
                              className="pr-badge more"
                              title={`${hiddenPRs} more PR${hiddenPRs === 1 ? '' : 's'} from this branch`}
                            >
                              +{hiddenPRs}
                            </span>
                          )}
                        </span>
                        {sizeBytes != null && (
                          <span
                            className="ws-size"
                            title="Worktree size on disk (apparent; btrfs reflinks are shared between worktrees, so this is not all reclaimable)"
                          >
                            {formatBytes(sizeBytes)}
                          </span>
                        )}
                      </div>
                    )}
                  </div>
                  <button
                    className="ws-icon-btn"
                    title="Archive workspace"
                    aria-label={`Archive workspace ${w.name}`}
                    onClick={(e) => onArchive(e, w.id)}
                  >
                    <ArchiveIcon />
                  </button>
                </div>
              );
            })}
          </div>
          );
        })}

        {soundSettingsOpen && <SoundSettings onClose={() => setSoundSettingsOpen(false)} />}
        {scriptsRepoPath && (
          <RepoScriptsModal
            repoPath={scriptsRepoPath}
            repoName={repoLabel(scriptsRepoPath)}
            onClose={() => setScriptsRepoPath(null)}
          />
        )}

        {archived.length > 0 && (
          <div className="archived-section">
            <button
              className="archived-toggle"
              onClick={() => setArchivedOpen((v) => !v)}
              aria-expanded={archivedOpen}
            >
              <span className={`caret ${archivedOpen ? 'open' : ''}`}>▸</span>
              <span>Archived</span>
              <span className="repo-count">{archived.length}</span>
            </button>
            {archivedOpen && (
              <div className="archived-list">
                {bulkDelete ? (
                  <div className="archived-bar archived-bar-progress">
                    <div className="archived-progress-label">
                      Deleting {bulkDelete.done} of {bulkDelete.total}…
                    </div>
                    <div className="archived-progress-track">
                      <div
                        className="archived-progress-fill"
                        style={{ width: `${(bulkDelete.done / bulkDelete.total) * 100}%` }}
                      />
                    </div>
                  </div>
                ) : (
                  <div className="archived-bar">
                    <label className="archived-check" onClick={(e) => e.stopPropagation()}>
                      <input
                        type="checkbox"
                        checked={allArchivedSelected}
                        ref={(el) => {
                          if (el) el.indeterminate = someArchivedSelected;
                        }}
                        onChange={toggleSelectAllArchived}
                        aria-label={allArchivedSelected ? 'Deselect all' : 'Select all archived'}
                      />
                    </label>
                    <span className="archived-bar-count">
                      {selectedArchived.size > 0 ? `${selectedArchived.size} selected` : 'Select all'}
                    </span>
                    {selectedArchived.size > 0 && (
                      <button
                        className="archived-bar-delete"
                        onClick={onDeleteSelectedArchived}
                      >
                        Delete {selectedArchived.size}
                      </button>
                    )}
                  </div>
                )}
                {archived.map((w) => {
                  const isSelected = selectedArchived.has(w.id);
                  const sizeBytes = sizes[w.id];
                  const isDeleting = deletingIds.has(w.id);
                  return (
                    <div
                      key={w.id}
                      className={`ws-item archived${isSelected ? ' selected' : ''}${isDeleting ? ' deleting' : ''}`}
                      title={w.name}
                    >
                      <label
                        className="archived-check"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <input
                          type="checkbox"
                          checked={isSelected}
                          disabled={isDeleting}
                          onChange={() => toggleArchivedSelection(w.id)}
                          aria-label={`Select workspace ${w.name}`}
                        />
                      </label>
                      <div className={`ws-dot ${w.status as WorkspaceStatus}`} />
                      <div className="ws-meta">
                        <div className="ws-name">{w.branch}</div>
                        <div className="ws-sub">
                          {repoLabel(w.repoPath)} · {w.agent}
                        </div>
                      </div>
                      {sizeBytes != null && (
                        <span
                          className="ws-size"
                          title="Worktree size on disk (apparent; btrfs reflinks are shared between worktrees, so this is not all reclaimable)"
                        >
                          {formatBytes(sizeBytes)}
                        </span>
                      )}
                      {isDeleting ? (
                        <span
                          className="ws-spinner"
                          title="Deleting worktree from disk…"
                          aria-label="Deleting"
                          role="status"
                        />
                      ) : (
                        <>
                          <button
                            className="ws-icon-btn"
                            title="Restore workspace"
                            aria-label={`Restore workspace ${w.name}`}
                            onClick={(e) => onUnarchive(e, w.id)}
                          >
                            <RestoreIcon />
                          </button>
                          <button
                            className="ws-icon-btn danger"
                            title="Delete workspace permanently"
                            aria-label={`Delete workspace ${w.name}`}
                            onClick={(e) => onDelete(e, w.id, w.name)}
                          >
                            <TrashIcon />
                          </button>
                        </>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>
      <div className="sidebar-footer">
        <button
          className="sidebar-footer-link"
          onClick={() => window.orchestra.openExternal('https://github.com/lcsmas/orchestra')}
          title="Open Orchestra on GitHub"
          aria-label="Open Orchestra on GitHub"
        >
          <GitHubIcon />
          <span>lcsmas/orchestra</span>
          <ExternalLinkIcon />
        </button>
        <button
          className="sidebar-footer-link"
          onClick={() => void window.orchestra.revealLogs()}
          title="Reveal Orchestra's diagnostic log file (for bug reports)"
          aria-label="Open diagnostic logs"
        >
          <LogsIcon />
          <span>Logs</span>
        </button>
        {version && (
          <span className="sidebar-footer-version" title="Orchestra version">
            v{version}
          </span>
        )}
      </div>
    </aside>
  );
}
