import { useState } from 'react';
import { useStore } from '../store';
import type { Workspace, WorkspaceStatus } from '../../shared/types';
import { SoundSettings } from './SoundSettings';
import { dialog } from './Dialog';

interface Props {
  onNewFromRepo: () => void;
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
    prs,
    setActive,
    archive,
    unarchive,
    deleteWorkspace,
    createWorkspace,
  } = useStore();
  const [archivedOpen, setArchivedOpen] = useState(false);
  const [soundSettingsOpen, setSoundSettingsOpen] = useState(false);

  const active = workspaces.filter((w) => !w.archived);
  const archived = workspaces.filter((w) => w.archived);

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
    try {
      await deleteWorkspace(id);
    } catch (err) {
      void dialog.error('Could not delete workspace', (err as Error).message);
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

  const repoLabel = (repoPath: string) => {
    const repo = repos.find((r) => r.path === repoPath);
    if (repo) return repo.name;
    const segments = repoPath.split('/').filter(Boolean);
    return segments[segments.length - 1] ?? repoPath;
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
        {active.length === 0 && archived.length === 0 && (
          <div style={{ padding: '20px', color: 'var(--text-dim)', fontSize: 12 }}>
            No agents running. Click <strong>Repo</strong> to map a git repo and spawn one.
          </div>
        )}
        {Array.from(activeGroups.entries()).map(([repoPath, items]) => (
          <div key={repoPath} className="repo-section">
            <div className="repo-header" title={repoPath}>
              <span className="repo-name">{repoLabel(repoPath)}</span>
              <span className="repo-header-actions">
                <span className="repo-count">{items.length}</span>
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
            {items.map((w) => {
              const s = stats[w.id];
              const hasChanges = !!s && (s.additions > 0 || s.deletions > 0);
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
              return (
                <div
                  key={w.id}
                  className={`ws-item ${activeId === w.id ? 'active' : ''} ${w.mergedAt ? 'merged' : ''}`}
                  onClick={() => setActive(w.id)}
                >
                  <div
                    className={`ws-dot ${w.status as WorkspaceStatus}`}
                    title={
                      w.status === 'running'
                        ? 'Agent is working…'
                        : w.status === 'idle'
                          ? 'Agent is idle'
                          : w.status
                    }
                  />
                  <div className="ws-body">
                    <div className="ws-name-row">
                      <div className="ws-name" title={w.branch}>{w.branch}</div>
                      {w.mergedAt && (
                        <span className="merged-pill" title={`Merged into ${w.baseBranch}`}>
                          merged
                        </span>
                      )}
                      {hasChanges && (
                        <span className="diff-indicator compact" title={`${s.files} file${s.files === 1 ? '' : 's'} changed`}>
                          {s.additions > 0 && <span className="add">+{s.additions}</span>}
                          {s.deletions > 0 && <span className="del">−{s.deletions}</span>}
                        </span>
                      )}
                    </div>
                    {visiblePRs.length > 0 && (
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
        ))}

        {soundSettingsOpen && <SoundSettings onClose={() => setSoundSettingsOpen(false)} />}

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
                {archived.map((w) => (
                  <div key={w.id} className="ws-item archived" title={w.name}>
                    <div className={`ws-dot ${w.status as WorkspaceStatus}`} />
                    <div className="ws-meta">
                      <div className="ws-name">{w.branch}</div>
                      <div className="ws-sub">
                        {repoLabel(w.repoPath)} · {w.agent}
                      </div>
                    </div>
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
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </aside>
  );
}
