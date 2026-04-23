import { useEffect, useMemo, useRef, useState } from 'react';

interface Props {
  workspaceId: string;
  currentBranch: string;
  onSwitched?: (branch: string) => void;
}

function BranchIcon() {
  return (
    <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
      <path
        fill="currentColor"
        d="M9.5 3.25a2.25 2.25 0 1 1 3 2.122V6A2.5 2.5 0 0 1 10 8.5H6a1 1 0 0 0-1 1v1.128a2.251 2.251 0 1 1-1.5 0V5.372a2.25 2.25 0 1 1 1.5 0v1.836A2.492 2.492 0 0 1 6 7h4a1 1 0 0 0 1-1v-.628A2.25 2.25 0 0 1 9.5 3.25Zm-6 0a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Zm8.25-.75a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5ZM4.25 12a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Z"
      />
    </svg>
  );
}

function SearchIcon() {
  return (
    <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
      <path
        fill="currentColor"
        d="M10.68 11.74a6 6 0 1 1 1.06-1.06l3.04 3.04a.75.75 0 1 1-1.06 1.06l-3.04-3.04ZM11.5 7a4.5 4.5 0 1 0-9 0 4.5 4.5 0 0 0 9 0Z"
      />
    </svg>
  );
}

function highlight(name: string, query: string) {
  if (!query) return <>{name}</>;
  const lower = name.toLowerCase();
  const q = query.toLowerCase();
  const i = lower.indexOf(q);
  if (i === -1) return <>{name}</>;
  return (
    <>
      {name.slice(0, i)}
      <mark className="branch-item-match">{name.slice(i, i + q.length)}</mark>
      {name.slice(i + q.length)}
    </>
  );
}

export function BranchPicker({ workspaceId, currentBranch, onSwitched }: Props) {
  const [open, setOpen] = useState(false);
  const [branches, setBranches] = useState<string[] | null>(null);
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeIdx, setActiveIdx] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setError(null);
    setActiveIdx(0);
    setBranches(null);
    window.orchestra
      .listBranches(workspaceId)
      .then((list) => setBranches(list))
      .catch((e) => setError((e as Error).message));
    const raf = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(raf);
  }, [open, workspaceId]);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const filtered = useMemo(() => {
    const list = branches ?? [];
    const q = query.trim().toLowerCase();
    const base = q ? list.filter((b) => b.toLowerCase().includes(q)) : list;
    // Current branch sorts first, then alphabetical.
    return base.slice().sort((a, b) => {
      if (a === currentBranch) return -1;
      if (b === currentBranch) return 1;
      return a.localeCompare(b);
    });
  }, [branches, query, currentBranch]);

  useEffect(() => {
    setActiveIdx(0);
  }, [query, branches]);

  useEffect(() => {
    if (!open || !listRef.current) return;
    const el = listRef.current.querySelector<HTMLElement>(
      `[data-idx="${activeIdx}"]`,
    );
    el?.scrollIntoView({ block: 'nearest' });
  }, [activeIdx, open]);

  const switchTo = async (branch: string) => {
    if (branch === currentBranch) {
      setOpen(false);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await window.orchestra.switchBranch(workspaceId, branch);
      onSwitched?.(branch);
      setOpen(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div ref={rootRef} className="branch-picker">
      <button
        type="button"
        className={`branch-chip head ${open ? 'open' : ''}`}
        onClick={() => setOpen((v) => !v)}
        disabled={busy}
        title={`workspace branch: ${currentBranch} (click to switch)`}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span className="branch-chip-text">{currentBranch}</span>
        <svg viewBox="0 0 12 12" width="10" height="10" aria-hidden="true">
          <path fill="currentColor" d="M2 4.5l4 4 4-4z" />
        </svg>
      </button>
      {open && (
        <div className="branch-popover" role="dialog">
          <div className="branch-search-wrap">
            <span className="branch-search-icon" aria-hidden="true">
              <SearchIcon />
            </span>
            <input
              ref={inputRef}
              className="branch-search"
              type="text"
              placeholder="Search branches…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'ArrowDown') {
                  e.preventDefault();
                  setActiveIdx((i) => Math.min(filtered.length - 1, i + 1));
                } else if (e.key === 'ArrowUp') {
                  e.preventDefault();
                  setActiveIdx((i) => Math.max(0, i - 1));
                } else if (e.key === 'Enter') {
                  e.preventDefault();
                  const pick = filtered[activeIdx];
                  if (pick) void switchTo(pick);
                }
              }}
            />
            {query && (
              <button
                type="button"
                className="branch-search-clear"
                aria-label="Clear search"
                onClick={() => {
                  setQuery('');
                  inputRef.current?.focus();
                }}
              >
                ×
              </button>
            )}
          </div>
          <div ref={listRef} className="branch-list" role="listbox">
            {branches === null && <div className="branch-empty">Loading branches…</div>}
            {branches !== null && filtered.length === 0 && (
              <div className="branch-empty">
                No branches match <span className="branch-empty-q">“{query}”</span>
              </div>
            )}
            {filtered.map((b, i) => {
              const isCurrent = b === currentBranch;
              const isActive = i === activeIdx;
              return (
                <button
                  key={b}
                  type="button"
                  role="option"
                  data-idx={i}
                  aria-selected={isCurrent}
                  className={`branch-item ${isActive ? 'active' : ''} ${isCurrent ? 'current' : ''}`}
                  onMouseEnter={() => setActiveIdx(i)}
                  onClick={() => void switchTo(b)}
                  disabled={busy}
                  title={b}
                >
                  <span className="branch-item-icon" aria-hidden="true">
                    <BranchIcon />
                  </span>
                  <span className="branch-item-name">{highlight(b, query)}</span>
                  {isCurrent && <span className="branch-item-badge">current</span>}
                </button>
              );
            })}
          </div>
          {error ? (
            <div className="branch-error">{error}</div>
          ) : (
            <div className="branch-footer">
              <span className="branch-hint"><kbd>↑</kbd><kbd>↓</kbd> navigate</span>
              <span className="branch-hint"><kbd>↵</kbd> switch</span>
              <span className="branch-hint"><kbd>esc</kbd> close</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
