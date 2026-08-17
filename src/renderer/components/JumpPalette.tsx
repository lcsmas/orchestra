import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../store';
import { rankJumpTargets } from '../../shared/jump-rank';
import { WorkspaceStatusGlyph, statusGlyphTitle } from './WorkspaceStatusGlyph';
import type { Workspace } from '../../shared/types';

/** Repo label for a palette row. Mirrors the Sidebar's basename labeling for
 * git workspaces; non-git rows say what they are instead of a path. */
function jumpRepoLabel(w: Workspace): string {
  if (w.kind === 'orchestrator') return 'orchestrator';
  if (!w.repoPath) return 'scratch';
  const parts = w.repoPath.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? w.repoPath;
}

/** Jump Palette (Ctrl/Cmd+J) — fuzzy-jump across every live workspace.
 *
 * Orca-inspired: recents-first when the query is empty (session open-history),
 * fuzzy over branch + repo label as you type, Enter jumps. Selection state is
 * local; the palette reads the store directly so App only owns the open flag. */
export function JumpPalette({ onClose }: { onClose: () => void }) {
  const workspaces = useStore((s) => s.workspaces);
  const openHistory = useStore((s) => s.openHistory);
  const setActive = useStore((s) => s.setActive);
  const [query, setQuery] = useState('');
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const live = useMemo(() => workspaces.filter((w) => !w.archived), [workspaces]);
  const byId = useMemo(() => new Map(live.map((w) => [w.id, w] as const)), [live]);
  const targets = useMemo(
    () =>
      live.map((w) => ({
        id: w.id,
        branch: w.branch,
        repoLabel: jumpRepoLabel(w),
        createdAt: w.createdAt,
      })),
    [live],
  );
  const ranked = useMemo(
    () => rankJumpTargets(query, targets, openHistory).slice(0, 50),
    [query, targets, openHistory],
  );

  useEffect(() => setSel(0), [query]);
  useEffect(() => inputRef.current?.focus(), []);
  // Keep the keyboard selection visible as it moves through a scrolled list.
  useEffect(() => {
    const el = listRef.current?.querySelector('[data-sel="true"]');
    (el as HTMLElement | null)?.scrollIntoView({ block: 'nearest' });
  }, [sel, ranked]);

  const jump = (id: string) => {
    setActive(id);
    onClose();
  };

  return (
    <div
      className="jump-overlay"
      onMouseDown={(e) => {
        // Backdrop click closes; clicks inside the panel don't bubble here
        // because the panel stops at its own row/input handlers.
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="jump-panel" role="dialog" aria-label="Jump to workspace">
        <input
          ref={inputRef}
          className="jump-input"
          placeholder="Jump to workspace… (branch or repo)"
          spellCheck={false}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault();
              onClose();
            } else if (e.key === 'ArrowDown') {
              e.preventDefault();
              setSel((s) => Math.min(s + 1, Math.max(0, ranked.length - 1)));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setSel((s) => Math.max(s - 1, 0));
            } else if (e.key === 'Enter') {
              e.preventDefault();
              const t = ranked[sel];
              if (t) jump(t.id);
            }
          }}
        />
        <div className="jump-list" ref={listRef}>
          {ranked.length === 0 && <div className="jump-empty">No matching workspace</div>}
          {ranked.map((t, i) => {
            const w = byId.get(t.id);
            if (!w) return null;
            return (
              <div
                key={t.id}
                className={`jump-row${i === sel ? ' selected' : ''}`}
                data-sel={i === sel ? 'true' : undefined}
                onMouseEnter={() => setSel(i)}
                onMouseDown={(e) => {
                  // Jump on mousedown (not click) so the palette closes before
                  // the input can lose focus and flicker.
                  e.preventDefault();
                  jump(t.id);
                }}
              >
                <WorkspaceStatusGlyph
                  status={w.status}
                  hibernated={w.hibernatedAt !== undefined}
                  unread={!!w.markedUnread}
                  autoUnread={!!w.autoUnread}
                  looping={!!w.loopingSince}
                  title={statusGlyphTitle(w)}
                />
                <span className="jump-branch">{t.branch}</span>
                <span className="jump-repo">{t.repoLabel}</span>
                {w.statusText && <span className="jump-note">{w.statusText}</span>}
              </div>
            );
          })}
        </div>
        <div className="jump-hint">↑↓ navigate · Enter jump · Esc close</div>
      </div>
    </div>
  );
}
