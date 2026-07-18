import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { BranchPopoverPanel } from './BranchPicker';

/** Floating branch picker for "new workspace from a chosen base branch".
 * Opened by right-clicking a repo's "+" button; a plain click keeps the
 * zero-friction default-base flow. Rendered through a portal at fixed
 * viewport coordinates — anchored inside the sidebar it would be clipped by
 * the sidebar's overflow scroll and trapped by its `backdrop-filter`
 * containing block (same reason RepoScriptsModal portals). */
export function NewWorkspaceBranchPopover({
  repoPath,
  repoName,
  defaultBranch,
  anchor,
  onPick,
  onClose,
}: {
  repoPath: string;
  repoName: string;
  defaultBranch?: string;
  /** Viewport coordinates of the invoking click. */
  anchor: { x: number; y: number };
  onPick: (branch: string) => void;
  onClose: () => void;
}) {
  const [branches, setBranches] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    window.orchestra
      .listRepoBranches(repoPath)
      .then((list) => {
        if (!cancelled) setBranches(list);
      })
      .catch((e) => {
        if (!cancelled) setError((e as Error).message);
      });
    return () => {
      cancelled = true;
    };
  }, [repoPath]);

  useEffect(() => {
    const onDocDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', onDocDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  // Keep the popover on-screen whatever corner the "+" sits in.
  const WIDTH = 320;
  const MAX_HEIGHT = 340;
  const left = Math.max(8, Math.min(anchor.x, window.innerWidth - WIDTH - 8));
  const top = Math.max(8, Math.min(anchor.y + 6, window.innerHeight - MAX_HEIGHT - 8));

  return createPortal(
    <div
      ref={rootRef}
      className="branch-popover floating"
      role="dialog"
      aria-label={`New workspace in ${repoName} — pick base branch`}
      style={{ left, top }}
    >
      <div className="branch-popover-title" title={repoPath}>
        New workspace in <strong>{repoName}</strong> based on…
      </div>
      <BranchPopoverPanel
        branches={branches}
        error={error}
        highlightBranch={defaultBranch}
        badgeLabel="default"
        actionVerb="create"
        onPick={onPick}
      />
    </div>,
    document.body,
  );
}
