import { useCallback, useEffect, useMemo, useState } from 'react';
import { useStore } from '../store';
import type {
  EnvStatusItem,
  LinearIssue,
  PRsForBranch,
  Workspace,
  WorkspaceStatus,
} from '../../shared/types';
import { isScratchLike } from '../../shared/types';
import { SoundSettings } from './SoundSettings';
import { LinearSettings } from './LinearSettings';
import { RepoScriptsModal } from './RepoScriptsModal';
import { UsageBars } from './UsageBars';
import { AccountsSettings } from './AccountsSettings';
import {
  RepoAccountBadge,
  WorkspaceAccountBadge,
  WorkspaceContextBadge,
} from './AccountBadge';
import { dialog } from './Dialog';

interface Props {
  onNewFromRepo: () => void;
  onNewScratch: () => void;
  onNewOrchestrator: () => void;
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

function ZapIcon() {
  // Lucide `zap` — a quick, throwaway scratch session.
  return (
    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor"
      strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z" />
    </svg>
  );
}

export function OrchestratorIcon() {
  // Lucide `network` — a node branching to two children, evoking an
  // orchestrator delegating to the agents it spawns.
  return (
    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor"
      strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <rect x="9" y="2" width="6" height="6" rx="1" />
      <rect x="2" y="16" width="6" height="6" rx="1" />
      <rect x="16" y="16" width="6" height="6" rx="1" />
      <path d="M12 8v4M12 12H5v4M12 12h7v4" />
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

function UsersIcon() {
  // Lucide `users` — accounts. Same stroke family as the gear/setup icons.
  return (
    <svg
      viewBox="0 0 24 24"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  );
}

function SetupIcon() {
  // Lucide `info` — a calm "heads up, optional setup" marker, not an alarm.
  return (
    <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor"
      strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 16v-4M12 8h.01" />
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

// Linear's mark, simplified to a single tilted-square glyph at the icon size.
function LinearIcon() {
  return (
    <svg {...ICON_PROPS}>
      <rect x="5" y="5" width="14" height="14" rx="3" transform="rotate(45 12 12)" />
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

/** PRs for a branch, ordered open-first then gh's newest-first, capped at the
 * three we surface. Shared so the row and its merged-pill suppression agree on
 * which PRs are "visible". */
function orderedVisiblePRs(prRecord?: PRsForBranch): {
  visible: PRsForBranch['all'];
  hidden: number;
} {
  const all = (prRecord?.all ?? []).slice().sort((a, b) => {
    if (a.state === 'OPEN' && b.state !== 'OPEN') return -1;
    if (b.state === 'OPEN' && a.state !== 'OPEN') return 1;
    return 0;
  });
  return { visible: all.slice(0, 3), hidden: Math.max(0, all.length - 3) };
}

/** The Linear-issue and PR-link badge spans for a workspace — a bare fragment
 * with no row/container wrapper, so it can drop into the name-row pill strip
 * (inline, beside the repo tag) or into a standalone `ws-meta-row`. Returns null
 * when the workspace has neither a verified Linear issue nor any PR. */
function PrLinearBadges({
  prRecord,
  linearIssue,
}: {
  prRecord?: PRsForBranch;
  linearIssue: LinearIssue | null;
}) {
  const { visible: visiblePRs, hidden: hiddenPRs } = orderedVisiblePRs(prRecord);
  if (visiblePRs.length === 0 && !linearIssue) return null;
  return (
    <>
      {linearIssue && (
        <span
          className="pr-badge linear"
          title={`Linear ${linearIssue.identifier}: ${linearIssue.title} — open in Linear`}
          onClick={(e) => {
            e.stopPropagation();
            window.orchestra.openExternal(linearIssue.url);
          }}
        >
          <LinearIcon />
          <span className="pr-badge-num">{linearIssue.identifier}</span>
        </span>
      )}
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
    </>
  );
}

/** PR/Linear badges in their own `ws-meta-row` below the branch name — the
 * layout used by regular workspace rows, which have the vertical room. */
function WsMetaBadges({
  prRecord,
  linearIssue,
}: {
  prRecord?: PRsForBranch;
  linearIssue: LinearIssue | null;
}) {
  const { visible: visiblePRs } = orderedVisiblePRs(prRecord);
  if (visiblePRs.length === 0 && !linearIssue) return null;
  return (
    <div className="ws-meta-row">
      <span className="pr-badges">
        <PrLinearBadges prRecord={prRecord} linearIssue={linearIssue} />
      </span>
    </div>
  );
}

/** A workspace paired with its depth in the orchestrator→children tree. Depth 0
 * is a root (no live parent); each spawned child sits one level deeper than the
 * orchestrator that spawned it. */
interface TreeRow {
  ws: Workspace;
  depth: number;
}

/** Spawn forest derived from the active workspace set. A workspace spawned via
 * `/spawn` carries the `parentId` of the workspace that spawned it; this links
 * them into trees. A "root" is any workspace whose `parentId` is absent or
 * points outside the set (parent deleted/archived) — dangling parents degrade
 * gracefully to roots. */
interface SpawnForest {
  /** parentId → its direct children, in store order. */
  childrenOf: Map<string, Workspace[]>;
  /** Workspaces with no live parent, in store order. */
  roots: Workspace[];
  /** id → its root ancestor (walking parentId up). A node maps to itself when
   * it is a root. Cycles (which should never occur) resolve to the node where
   * the walk first repeats, so the lookup always terminates. */
  rootOf: Map<string, Workspace>;
}

function buildSpawnForest(list: Workspace[]): SpawnForest {
  const byId = new Map(list.map((w) => [w.id, w]));
  const childrenOf = new Map<string, Workspace[]>();
  const roots: Workspace[] = [];
  for (const ws of list) {
    const parent = ws.parentId ? byId.get(ws.parentId) : undefined;
    if (parent) {
      const sibs = childrenOf.get(parent.id);
      if (sibs) sibs.push(ws);
      else childrenOf.set(parent.id, [ws]);
    } else {
      roots.push(ws);
    }
  }
  const rootOf = new Map<string, Workspace>();
  for (const ws of list) {
    let cur = ws;
    const seen = new Set<string>([cur.id]);
    for (;;) {
      const parent = cur.parentId ? byId.get(cur.parentId) : undefined;
      if (!parent || seen.has(parent.id)) break;
      seen.add(parent.id);
      cur = parent;
    }
    rootOf.set(ws.id, cur);
  }
  return { childrenOf, roots, rootOf };
}

/** Flatten one root's subtree into depth-first rows carrying each node's depth,
 * so children render indented under the workspace that spawned them. Uses an
 * iterative walk (deep trees can't blow the stack) and a visited set (a corrupt
 * cycle can't loop forever). */
function flattenSubtree(
  root: Workspace,
  childrenOf: Map<string, Workspace[]>,
  visited: Set<string>,
): TreeRow[] {
  const rows: TreeRow[] = [];
  const stack: TreeRow[] = [{ ws: root, depth: 0 }];
  while (stack.length) {
    const row = stack.pop()!;
    if (visited.has(row.ws.id)) continue;
    visited.add(row.ws.id);
    rows.push(row);
    const kids = childrenOf.get(row.ws.id) ?? [];
    // Push reversed so children are visited in their natural order.
    for (let i = kids.length - 1; i >= 0; i--) {
      stack.push({ ws: kids[i], depth: row.depth + 1 });
    }
  }
  return rows;
}

/** Group git workspaces into repo sections, threaded as spawn trees. Each root
 * is filed under its own `repoPath`; its descendants follow it depth-first in
 * the SAME section, so a child in repo B still appears under its parent in repo
 * A — the spawn relationship wins over repo grouping. Roots whose tree belongs
 * to the Orchestrators section are passed in pre-filtered, so they never appear
 * here. */
function groupRootsByRepo(roots: Workspace[], forest: SpawnForest): Map<string, TreeRow[]> {
  const groups = new Map<string, TreeRow[]>();
  const visited = new Set<string>();
  for (const root of roots) {
    const rows = flattenSubtree(root, forest.childrenOf, visited);
    const existing = groups.get(root.repoPath);
    if (existing) existing.push(...rows);
    else groups.set(root.repoPath, rows);
  }
  return groups;
}

export function Sidebar({ onNewFromRepo, onNewScratch, onNewOrchestrator }: Props) {
  const {
    workspaces,
    repos,
    activeId,
    stats,
    sizes,
    prs,
    linear,
    tools,
    repoSync,
    setActive,
    archive,
    unarchive,
    deleteWorkspace,
    createWorkspace,
    removeRepo,
    reorderWorkspaces,
    reorderRepos,
  } = useStore();
  const [version, setVersion] = useState('');
  const [archivedOpen, setArchivedOpen] = useState(false);
  // Per-repo collapse state, persisted across sessions so a repo the user
  // folded away stays folded next launch.
  const [collapsedRepos, setCollapsedRepos] = useState<Set<string>>(() => {
    try {
      const raw = localStorage.getItem('orchestra.collapsedRepos');
      return new Set(raw ? (JSON.parse(raw) as string[]) : []);
    } catch {
      return new Set();
    }
  });
  // Optional-setup status (e.g. Linear API key missing) plus the set of items
  // the user has dismissed. Dismissals persist so a notice the user waved away
  // stays gone across launches — until they fix it (an item that flips to `ok`
  // is dropped from the notice regardless of dismissal).
  const [envStatus, setEnvStatus] = useState<EnvStatusItem[]>([]);
  const [dismissedEnv, setDismissedEnv] = useState<Set<string>>(() => {
    try {
      const raw = localStorage.getItem('orchestra.dismissedEnvNotices');
      return new Set(raw ? (JSON.parse(raw) as string[]) : []);
    } catch {
      return new Set();
    }
  });
  const [soundSettingsOpen, setSoundSettingsOpen] = useState(false);
  const [linearSettingsOpen, setLinearSettingsOpen] = useState(false);
  const [accountsSettingsOpen, setAccountsSettingsOpen] = useState(false);
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

  const refreshEnvStatus = useCallback(
    () => void window.orchestra.getEnvStatus().then(setEnvStatus).catch(() => {}),
    [],
  );

  // Pull optional-setup status on mount and re-check on a slow cadence — config
  // changes mostly on relaunch (env var) or via the in-app Linear settings
  // (which calls refreshEnvStatus directly), but a periodic re-read is cheap and
  // keeps the notice honest if anything resolves it mid-session.
  useEffect(() => {
    refreshEnvStatus();
    const t = setInterval(refreshEnvStatus, 60_000);
    return () => clearInterval(t);
  }, [refreshEnvStatus]);

  const dismissEnvNotice = (id: string) => {
    setDismissedEnv((prev) => {
      const next = new Set(prev);
      next.add(id);
      try {
        localStorage.setItem('orchestra.dismissedEnvNotices', JSON.stringify(Array.from(next)));
      } catch {
        /* persistence is best-effort */
      }
      return next;
    });
  };

  // Notices to show: not-ok items the user hasn't dismissed. A resolved item
  // never shows (even if previously dismissed); we don't bother un-dismissing
  // it in storage since the `ok` filter already hides it.
  const envNotices = envStatus.filter((it) => !it.ok && !dismissedEnv.has(it.id));

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

  const toggleRepoCollapsed = (repoPath: string) => {
    setCollapsedRepos((prev) => {
      const next = new Set(prev);
      if (next.has(repoPath)) next.delete(repoPath);
      else next.add(repoPath);
      try {
        localStorage.setItem('orchestra.collapsedRepos', JSON.stringify(Array.from(next)));
      } catch {
        /* persistence is best-effort — ignore quota/serialization failures */
      }
      return next;
    });
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

  // The whole workspace-tree derivation (filter → spawn forest → orchestrator
  // trees → scratch list) is a pure function of `workspaces`, but the Sidebar
  // re-renders on every `agent:tool` / stats / prs tick (it shows per-row tool
  // labels and badges) — none of which change `workspaces`. Memoizing on
  // `workspaces` identity skips rebuilding three Maps and walking the forest on
  // each of those high-frequency ticks; it only recomputes when the workspace
  // set actually changes.
  const { active, archived, forest, orchestratorTrees, scratchSessions } = useMemo(() => {
    const active = workspaces.filter((w) => !w.archived);
    const archived = workspaces.filter((w) => w.archived);
    // The spawn forest links every active workspace to the one that spawned it.
    // Section membership is decided by a workspace's ROOT ancestor, so an agent
    // spawned by an orchestrator nests under that orchestrator even if the agent
    // itself is a git worktree in some repo.
    const forest = buildSpawnForest(active);
    const rootIsOrchestrator = (w: Workspace) =>
      forest.rootOf.get(w.id)?.kind === 'orchestrator';
    // Orchestrator sessions and everything they (transitively) spawned, threaded
    // into trees and pinned at the very top.
    const orchestratorRoots = forest.roots.filter((w) => w.kind === 'orchestrator');
    const orchestratorTrees = orchestratorRoots.map((root) => ({
      root,
      rows: flattenSubtree(root, forest.childrenOf, new Set<string>()),
    }));
    // Plain scratch sessions that aren't part of an orchestrator's tree — their
    // own pinned group below the orchestrators.
    const scratchSessions = active.filter(
      (w) => w.kind === 'scratch' && !rootIsOrchestrator(w),
    );
    return { active, archived, forest, orchestratorTrees, scratchSessions };
  }, [workspaces]);

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

  const onDeleteScratch = async (e: React.MouseEvent, id: string, label: string) => {
    e.stopPropagation();
    const ok = await dialog.confirm({
      title: 'Delete scratch session',
      message: `Delete scratch session "${label}"?`,
      detail: 'This removes its working directory and conversation from disk. Scratch sessions are not tracked by git, so this cannot be undone.',
      tone: 'danger',
      confirmLabel: 'Delete',
    });
    if (!ok) return;
    markDeleting(id, true);
    try {
      await deleteWorkspace(id);
    } catch (err) {
      void dialog.error('Could not delete scratch session', (err as Error).message);
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

  const onRemoveRepo = async (e: React.MouseEvent, repoPath: string) => {
    e.stopPropagation();
    const name = repoLabel(repoPath);
    const ok = await dialog.confirm({
      title: 'Remove repo',
      message: `Remove "${name}" from Orchestra?`,
      detail: 'This only un-maps the repo from Orchestra — your git repository on disk is left untouched.',
      tone: 'danger',
      confirmLabel: 'Remove',
    });
    if (!ok) return;
    try {
      await removeRepo(repoPath);
    } catch (err) {
      void dialog.error('Could not remove repo', (err as Error).message);
    }
  };

  // Repo sections are built from git-worktree ROOTS only. A git workspace that
  // was spawned by an orchestrator has a live parent, so it isn't a root here —
  // it surfaces inside that orchestrator's tree instead (spawn beats repo). Its
  // subtree, flattened by groupRootsByRepo, still nests any further children.
  const { activeGroups, repoOrder } = useMemo(() => {
    const repoRoots = forest.roots.filter((w) => !isScratchLike(w));
    const activeGroups = groupRootsByRepo(repoRoots, forest);
    // Show every registered repo as a section, plus any orphan repoPaths that
    // still have workspaces (e.g. the repo entry was removed but workspaces
    // remain). This way a repo header stays visible — with a 0 count and an
    // active "+" button — even after every workspace in it is archived.
    const repoOrder: string[] = [
      ...repos.map((r) => r.path),
      ...Array.from(activeGroups.keys()).filter((p) => !repos.some((r) => r.path === p)),
    ];
    return { activeGroups, repoOrder };
  }, [forest, repos]);

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
            className="header-icon-btn"
            onClick={() => setAccountsSettingsOpen(true)}
            title="Claude accounts — usage badges per workspace"
            aria-label="Claude accounts settings"
          >
            <UsersIcon />
          </button>
          <button
            className="header-repo-btn"
            onClick={onNewScratch}
            title="New scratch session — throwaway, no git repo needed"
            aria-label="New scratch session"
          >
            <ZapIcon />
            <span>Scratch</span>
          </button>
          <button
            className="header-repo-btn"
            onClick={onNewOrchestrator}
            title="New orchestrator — an agent that delegates work by spawning child agents"
            aria-label="New orchestrator session"
          >
            <OrchestratorIcon />
            <span>Orchestrator</span>
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
        {repoOrder.length === 0 &&
          archived.length === 0 &&
          scratchSessions.length === 0 &&
          orchestratorTrees.length === 0 && (
          <div style={{ padding: '20px', color: 'var(--text-dim)', fontSize: 12 }}>
            No agents running. Click <strong>Scratch</strong> for a quick throwaway session, or <strong>Repo</strong> to map a git repo.
          </div>
        )}
        {orchestratorTrees.length > 0 && (
          <div className="repo-section orchestrator-section">
            <div className="repo-header">
              <div className="repo-collapse" style={{ cursor: 'default' }}>
                <span className="scratch-glyph" aria-hidden="true"><OrchestratorIcon /></span>
                <span className="repo-name">Orchestrators</span>
              </div>
              <span className="repo-header-actions">
                <span className="repo-count">{orchestratorTrees.length}</span>
                <button
                  className="repo-add"
                  title="New orchestrator"
                  aria-label="New orchestrator"
                  onClick={(e) => {
                    e.stopPropagation();
                    onNewOrchestrator();
                  }}
                >
                  +
                </button>
              </span>
            </div>
            {orchestratorTrees.flatMap(({ rows }) =>
              rows.map(({ ws: w, depth }) => {
                const isDeleting = deletingIds.has(w.id);
                const isChild = depth > 0;
                // The orchestrator root is scratch-like (deletable, no git); a
                // child can be a real git worktree (archivable) or a nested
                // scratch/orchestrator. Show the repo it lives in for git kids.
                const childIsGit = isChild && !isScratchLike(w);
                return (
                  <div
                    key={w.id}
                    className={`ws-item ${activeId === w.id ? 'active' : ''}${isChild ? ' ws-child' : ''}${isDeleting ? ' deleting' : ''}`}
                    style={isChild ? ({ '--ws-depth': depth } as React.CSSProperties) : undefined}
                    onClick={() => setActive(w.id)}
                  >
                    {isChild && (
                      <span className="ws-tree-connector" aria-hidden="true">
                        ╰─
                      </span>
                    )}
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
                      <div className="ws-name-row ws-name-row-login">
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
                            className="ws-name ws-name-tight"
                            title={
                              depth === 0
                                ? `${w.branch} — orchestrator · double-click to rename`
                                : `${w.branch} — spawned by this orchestrator · double-click to rename`
                            }
                            onDoubleClick={(e) => startRename(e, w)}
                          >
                            {w.branch}
                          </div>
                        )}
                        <WorkspaceContextBadge workspaceId={w.id} />
                        <span className="ws-login">
                          <span className="ws-context-sep" aria-hidden="true">
                            ·
                          </span>
                          <WorkspaceAccountBadge workspaceId={w.id} migratable />
                        </span>
                        {childIsGit && (
                          <span className="ws-pills mini">
                            <span
                              className="repo-tag-pill"
                              title={`Spawned into ${repoLabel(w.repoPath)}`}
                            >
                              {repoLabel(w.repoPath)}
                            </span>
                            <PrLinearBadges
                              prRecord={prs[w.id]}
                              linearIssue={linear[w.id] ?? null}
                            />
                          </span>
                        )}
                      </div>
                    </div>
                    {isDeleting ? (
                      <span className="ws-spinner" title="Removing…" aria-label="Removing" role="status" />
                    ) : childIsGit ? (
                      <button
                        className="ws-icon-btn"
                        title="Archive workspace"
                        aria-label={`Archive workspace ${w.name}`}
                        onClick={(e) => onArchive(e, w.id)}
                      >
                        <ArchiveIcon />
                      </button>
                    ) : (
                      <button
                        className="ws-icon-btn danger"
                        title={depth === 0 ? 'Delete orchestrator' : 'Delete session'}
                        aria-label={`Delete ${w.branch}`}
                        onClick={(e) => onDeleteScratch(e, w.id, w.branch)}
                      >
                        <TrashIcon />
                      </button>
                    )}
                  </div>
                );
              }),
            )}
          </div>
        )}
        {scratchSessions.length > 0 && (
          <div className="repo-section scratch-section">
            <div className="repo-header">
              <div className="repo-collapse" style={{ cursor: 'default' }}>
                <span className="scratch-glyph" aria-hidden="true"><ZapIcon /></span>
                <span className="repo-name">Scratch</span>
              </div>
              <span className="repo-header-actions">
                <span className="repo-count">{scratchSessions.length}</span>
                <button
                  className="repo-add"
                  title="New scratch session"
                  aria-label="New scratch session"
                  onClick={(e) => {
                    e.stopPropagation();
                    onNewScratch();
                  }}
                >
                  +
                </button>
              </span>
            </div>
            {scratchSessions.map((w) => {
              const isDeleting = deletingIds.has(w.id);
              return (
                <div
                  key={w.id}
                  className={`ws-item ${activeId === w.id ? 'active' : ''}${isDeleting ? ' deleting' : ''}`}
                  onClick={() => setActive(w.id)}
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
                    <div className="ws-name-row ws-name-row-login">
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
                          className="ws-name ws-name-tight"
                          title={`${w.branch} — scratch session (not tracked by git) · double-click to rename`}
                          onDoubleClick={(e) => startRename(e, w)}
                        >
                          {w.branch}
                        </div>
                      )}
                      <WorkspaceContextBadge workspaceId={w.id} />
                      <span className="ws-login">
                        <span className="ws-context-sep" aria-hidden="true">
                          ·
                        </span>
                        <WorkspaceAccountBadge workspaceId={w.id} migratable />
                      </span>
                    </div>
                  </div>
                  {isDeleting ? (
                    <span className="ws-spinner" title="Deleting…" aria-label="Deleting" role="status" />
                  ) : (
                    <button
                      className="ws-icon-btn danger"
                      title="Delete scratch session"
                      aria-label={`Delete scratch session ${w.branch}`}
                      onClick={(e) => onDeleteScratch(e, w.id, w.branch)}
                    >
                      <TrashIcon />
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}
        {repoOrder.map((repoPath) => {
          const items = activeGroups.get(repoPath) ?? [];
          // Only registered repos can be reordered — orphan repoPaths (entry
          // removed but workspaces remain) always trail and aren't draggable.
          const isRegisteredRepo = repos.some((r) => r.path === repoPath);
          // A repo can only be removed once it holds no workspaces at all
          // (active, archived, or scratch) — otherwise main rejects the call
          // to avoid orphaning worktrees. Gate the button on the same rule so
          // we never offer an action that's bound to fail.
          const canRemoveRepo =
            isRegisteredRepo && !workspaces.some((w) => w.repoPath === repoPath);
          const collapsed = collapsedRepos.has(repoPath);
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
              <button
                className="repo-collapse"
                aria-expanded={!collapsed}
                aria-label={`${collapsed ? 'Expand' : 'Collapse'} ${repoLabel(repoPath)}`}
                onClick={(e) => {
                  e.stopPropagation();
                  toggleRepoCollapsed(repoPath);
                }}
              >
                <span className={`caret ${collapsed ? '' : 'open'}`}>▸</span>
                <span className="repo-name">{repoLabel(repoPath)}</span>
                <span className="ws-context-sep" aria-hidden="true">
                  ·
                </span>
                <RepoAccountBadge repoPath={repoPath} />
              </button>
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
                {canRemoveRepo && (
                  <button
                    className="repo-scripts-btn danger"
                    title={`Remove ${repoLabel(repoPath)} from Orchestra (your git repo is left untouched)`}
                    aria-label={`Remove ${repoLabel(repoPath)} from Orchestra`}
                    onClick={(e) => onRemoveRepo(e, repoPath)}
                  >
                    <TrashIcon />
                  </button>
                )}
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
            {!collapsed && (() => {
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
            {!collapsed && items.map(({ ws: w, depth }) => {
              const s = stats[w.id];
              const hasChanges = !!s && (s.additions > 0 || s.deletions > 0);
              const sizeBytes = sizes[w.id];
              const prRecord = prs[w.id];
              // The purple #N merged PR badge already conveys "merged", so
              // suppress the standalone merged pill when one is visible.
              const hasMergedPRBadge = orderedVisiblePRs(prRecord).visible.some(
                (p) => p.state === 'MERGED',
              );
              // Linear issue badge — shown ONLY for an issue the main process
              // verified to exist via Linear's GraphQL API. A branch whose name
              // merely looks like it carries a key (`usage-poll-429`) resolves to
              // null and shows nothing. URL/identifier come straight from Linear,
              // so they're never fabricated.
              const linearIssue = linear[w.id] ?? null;
              const wsDnd =
                dragWs?.id === w.id
                  ? ' dragging'
                  : dropWs?.id === w.id
                    ? ` drop-${dropWs.pos}`
                    : '';
              // Spawned children are positioned by the orchestrator tree, not by
              // manual order, so they are not drag-reorderable (only depth-0
              // roots are). Indent each level; a child in a different repo than
              // its orchestrator gets a small repo tag so the nesting reads.
              const isChild = depth > 0;
              const crossRepoChild = isChild && w.repoPath !== repoPath;
              return (
                <div
                  key={w.id}
                  className={`ws-item ${activeId === w.id ? 'active' : ''} ${w.mergedAt && !w.divergedFromBase ? 'merged' : ''}${isChild ? ' ws-child' : ''}${wsDnd}`}
                  style={isChild ? ({ '--ws-depth': depth } as React.CSSProperties) : undefined}
                  onClick={() => setActive(w.id)}
                  draggable={!isChild && renamingId !== w.id}
                  onDragStart={(e) => {
                    if (isChild) {
                      e.preventDefault();
                      return;
                    }
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
                    // Same-repo reordering only — cross-repo drops are a no-op,
                    // and tree-nested children are not reorder targets.
                    if (isChild || !dragWs || dragWs.repoPath !== w.repoPath || dragWs.id === w.id) return;
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
                  {isChild && (
                    <span className="ws-tree-connector" aria-hidden="true">
                      ╰─
                    </span>
                  )}
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
                      <WorkspaceContextBadge workspaceId={w.id} />
                      <span className="ws-login">
                        <span className="ws-context-sep" aria-hidden="true">
                          ·
                        </span>
                        <WorkspaceAccountBadge workspaceId={w.id} migratable />
                      </span>
                      {sizeBytes != null && (
                        <span
                          className="ws-size"
                          title="Worktree size on disk (apparent; btrfs reflinks are shared between worktrees, so this is not all reclaimable)"
                        >
                          {formatBytes(sizeBytes)}
                        </span>
                      )}
                      <span className="ws-pills">
                      {crossRepoChild && (
                        <span
                          className="repo-tag-pill"
                          title={`Spawned into ${repoLabel(w.repoPath)} (different repo than its orchestrator)`}
                        >
                          {repoLabel(w.repoPath)}
                        </span>
                      )}
                      {w.mergedAt && !w.divergedFromBase && !hasMergedPRBadge && (
                        <span className="merged-pill" title={`Merged into ${w.baseBranch}`}>
                          merged
                        </span>
                      )}
                      {w.releasedAt &&
                        (() => {
                          // Show one pill per release that contains this
                          // branch's work. Fall back to the single
                          // releasedVersion for pre-upgrade records, then to a
                          // bare "released" when no tag is known.
                          const versions =
                            w.releasedVersions && w.releasedVersions.length > 0
                              ? w.releasedVersions
                              : w.releasedVersion
                                ? [w.releasedVersion]
                                : [];
                          if (versions.length === 0) {
                            return (
                              <span className="released-pill" title="Shipped in a published release">
                                released
                              </span>
                            );
                          }
                          return versions.map((v) => (
                            <span key={v} className="released-pill" title={`Shipped in release ${v}`}>
                              {v}
                            </span>
                          ));
                        })()}
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
                      </span>
                    </div>
                    <WsMetaBadges prRecord={prRecord} linearIssue={linearIssue} />
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
        {accountsSettingsOpen && (
          <AccountsSettings onClose={() => setAccountsSettingsOpen(false)} />
        )}
        {linearSettingsOpen && (
          <LinearSettings
            onClose={() => setLinearSettingsOpen(false)}
            onChanged={refreshEnvStatus}
          />
        )}
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
      {envNotices.length > 0 && (
        <div className="env-notices">
          {envNotices.map((it) => (
            <div key={it.id} className="env-notice" role="status">
              <span className="env-notice-icon" aria-hidden="true">
                <SetupIcon />
              </span>
              <div className="env-notice-body">
                <div className="env-notice-title">{it.label} not configured</div>
                <div className="env-notice-detail">
                  {it.detail}
                  {it.id === 'linear' ? (
                    <>
                      {' '}
                      <button
                        className="env-notice-link"
                        onClick={() => setLinearSettingsOpen(true)}
                      >
                        Set API key…
                      </button>
                    </>
                  ) : (
                    it.docsUrl && (
                      <>
                        {' '}
                        <button
                          className="env-notice-link"
                          onClick={() => it.docsUrl && window.orchestra.openExternal(it.docsUrl)}
                        >
                          Get a key
                        </button>
                      </>
                    )
                  )}
                </div>
              </div>
              <button
                className="env-notice-dismiss"
                title="Dismiss"
                aria-label={`Dismiss ${it.label} setup notice`}
                onClick={() => dismissEnvNotice(it.id)}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}
      <UsageBars />
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
        <button
          className="sidebar-footer-link"
          onClick={() => setLinearSettingsOpen(true)}
          title="Linear API key — verify branch issue keys against Linear"
          aria-label="Linear settings"
        >
          <LinearIcon />
          <span>Linear</span>
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
