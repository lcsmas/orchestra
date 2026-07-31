import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  parseUnifiedDiff,
  buildPatch,
  allHunkIds,
  fileStats,
  hunkStats,
  fileCheckState,
  countSelected,
  stagedHunkIds,
  stagedSelection,
  type DiffFilePatch,
  type DiffHunk,
  type DiffLine,
  type HunkSelection,
} from '../../shared/diff-hunks';
import {
  composeRevisionPrompt,
  summarizeAnnotations,
  type DiffAnnotation,
} from '../../shared/diff-annotations';

type Scope = 'uncommitted' | 'base';

/** Rows above/below the viewport kept in the DOM. Generous enough that a fast
 *  wheel scroll doesn't reveal blank space, small enough that a 20k-line diff
 *  keeps its node count in the hundreds — the reason this pane is plain DOM and
 *  not Monaco (which is what drove the GPU-crash black screens). */
const OVERSCAN = 40;
/** Fixed row height, in px. Must match `.diff-line`'s height in styles.css:
 *  virtualization needs an exact number, and measuring every row would defeat
 *  the point. Word wrap is opt-in for exactly this reason — a wrapped row is
 *  taller than ROW_H, so wrap mode turns virtualization off (see `wrap`). */
const ROW_H = 18;
/** Above this many rendered lines the pane virtualizes. Below it, everything
 *  renders — cheaper than the bookkeeping, and keeps ctrl-F working on small
 *  diffs, which is the common case. */
const VIRTUALIZE_ABOVE = 600;

/** One flattened row in the scrollable list. Files and hunks become rows too,
 *  so a single windowed list can render the whole document — otherwise a file
 *  collapsed far above the viewport still costs DOM. */
type Row =
  | { kind: 'file'; file: DiffFilePatch; key: string }
  | { kind: 'hunk'; file: DiffFilePatch; hunk: DiffHunk; key: string }
  | {
      kind: 'line';
      file: DiffFilePatch;
      hunk: DiffHunk;
      line: DiffLine;
      key: string;
    }
  | { kind: 'note'; file: DiffFilePatch; text: string; key: string }
  | { kind: 'annotation'; annotation: DiffAnnotation; key: string };

function statusLabel(f: DiffFilePatch): string {
  if (f.status === 'added') return 'added';
  if (f.status === 'deleted') return 'deleted';
  if (f.status === 'renamed') return 'renamed';
  return '';
}

/** Stable key for an annotation anchor, so a comment reattaches to the same
 *  line across a refetch (annotations outlive the diff they were written on).
 *
 *  The delimiter is U+241F SYMBOL FOR UNIT SEPARATOR written as an ESCAPE
 *  SEQUENCE (\u241F), never a raw byte. This started life as a literal NUL,
 *  which made git classify this whole .tsx as BINARY: "Bin 0 -> 21345 bytes",
 *  zero reviewable lines and no textual merge, permanently. ANY control byte in
 *  a source file does that, so the delimiter must stay a printable codepoint.
 *  Collision-safety is unchanged: it cannot appear in a path git reports. */
function anchorKey(path: string, side: 'old' | 'new', line: number): string {
  return `${path}\u241F${side}\u241F${line}`;
}

export function DiffPane({ workspaceId, isActive }: { workspaceId: string; isActive: boolean }) {
  const [scope, setScope] = useState<Scope>('uncommitted');
  const [raw, setRaw] = useState('');
  // `git diff --cached` for the uncommitted scope. The scope's own diff merges
  // index and working tree, so this is the ONLY signal saying which hunks are
  // staged — and therefore which ones Unstage can actually reverse.
  const [stagedRaw, setStagedRaw] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [selection, setSelection] = useState<HunkSelection>(() => new Map());
  const [annotations, setAnnotations] = useState<DiffAnnotation[]>([]);
  const [composingAt, setComposingAt] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [wrap, setWrap] = useState(false);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [viewport, setViewport] = useState({ scrollTop: 0, height: 0 });

  const refresh = useCallback(
    async (which: Scope) => {
      setLoading(true);
      setError(null);
      try {
        const text = await window.orchestra.getReviewDiff(workspaceId, which);
        setRaw(text);
        // Only the uncommitted scope can stage; vs-base has no index view.
        setStagedRaw(which === 'uncommitted' ? await window.orchestra.getStagedDiff(workspaceId) : '');
      } catch (e) {
        setError((e as Error).message);
        setRaw('');
        setStagedRaw('');
      } finally {
        setLoading(false);
      }
    },
    [workspaceId],
  );

  // Fetch when the pane becomes visible or the scope changes. Deliberately NOT
  // polled: a diff that reflows under the reader mid-review is worse than a
  // stale one, and staging surfaces git's own "does not exist in index" if the
  // tree moved. The Refresh button is the explicit way to resync.
  useEffect(() => {
    if (!isActive) return;
    void refresh(scope);
  }, [isActive, scope, refresh]);

  const files = useMemo(() => parseUnifiedDiff(raw), [raw]);
  /** Hunk ids (per file) that are already in the index. */
  const staged = useMemo(
    () => stagedHunkIds(files, parseUnifiedDiff(stagedRaw)),
    [files, stagedRaw],
  );

  // Selection is keyed on hunk ids that come from header offsets, so a refetch
  // that changed a file invalidates its ids. Drop anything that no longer
  // exists rather than carrying a stale selection into a patch build.
  useEffect(() => {
    setSelection((prev) => {
      if (prev.size === 0) return prev;
      const live = new Map(files.map((f) => [f.path, allHunkIds(f)]));
      const next: HunkSelection = new Map();
      let changed = false;
      for (const [path, ids] of prev) {
        const alive = live.get(path);
        if (!alive) {
          changed = true;
          continue;
        }
        const kept = new Set([...ids].filter((id) => alive.has(id)));
        if (kept.size !== ids.size) changed = true;
        if (kept.size) next.set(path, kept);
      }
      return changed ? next : prev;
    });
  }, [files]);

  const annotationsByAnchor = useMemo(() => {
    const m = new Map<string, DiffAnnotation[]>();
    for (const a of annotations) {
      const k = anchorKey(a.path, a.side, a.line);
      const list = m.get(k);
      if (list) list.push(a);
      else m.set(k, [a]);
    }
    return m;
  }, [annotations]);

  // Flatten to rows. Collapsed files contribute only their header row.
  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    for (const f of files) {
      out.push({ kind: 'file', file: f, key: `f:${f.path}` });
      if (collapsed.has(f.path)) continue;
      if (f.binary) {
        out.push({ kind: 'note', file: f, text: 'Binary file — not shown', key: `b:${f.path}` });
        continue;
      }
      if (f.hunks.length === 0) {
        out.push({
          kind: 'note',
          file: f,
          text: f.status === 'renamed' ? 'Renamed with no content change' : 'No textual changes',
          key: `n:${f.path}`,
        });
        continue;
      }
      for (const h of f.hunks) {
        out.push({ kind: 'hunk', file: f, hunk: h, key: `h:${f.path}:${h.id}` });
        h.lines.forEach((l, i) => {
          out.push({ kind: 'line', file: f, hunk: h, line: l, key: `l:${f.path}:${h.id}:${i}` });
          const side: 'old' | 'new' = l.kind === 'del' ? 'old' : 'new';
          const num = side === 'old' ? l.oldLine : l.newLine;
          if (num == null) return;
          for (const a of annotationsByAnchor.get(anchorKey(f.path, side, num)) ?? []) {
            out.push({ kind: 'annotation', annotation: a, key: `a:${a.id}` });
          }
        });
      }
    }
    return out;
  }, [files, collapsed, annotationsByAnchor]);

  // Wrapped rows have variable height, so windowing (which assumes ROW_H) would
  // misplace them. Wrap therefore disables virtualization — acceptable because
  // wrap is opt-in and mostly used on small diffs.
  const virtualize = !wrap && rows.length > VIRTUALIZE_ABOVE && composingAt === null;
  const first = virtualize
    ? Math.max(0, Math.floor(viewport.scrollTop / ROW_H) - OVERSCAN)
    : 0;
  const last = virtualize
    ? Math.min(rows.length, Math.ceil((viewport.scrollTop + viewport.height) / ROW_H) + OVERSCAN)
    : rows.length;
  const visible = virtualize ? rows.slice(first, last) : rows;

  const onScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    setViewport({ scrollTop: el.scrollTop, height: el.clientHeight });
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) setViewport((v) => ({ ...v, height: el.clientHeight }));
  }, [isActive, rows.length]);

  const toggleFile = (path: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  const toggleHunk = (file: DiffFilePatch, hunk: DiffHunk) =>
    setSelection((prev) => {
      const next = new Map(prev);
      const cur = new Set(next.get(file.path) ?? []);
      if (cur.has(hunk.id)) cur.delete(hunk.id);
      else cur.add(hunk.id);
      if (cur.size) next.set(file.path, cur);
      else next.delete(file.path);
      return next;
    });

  const toggleWholeFile = (file: DiffFilePatch) =>
    setSelection((prev) => {
      const next = new Map(prev);
      const state = fileCheckState(file, prev);
      if (state === 'all') next.delete(file.path);
      else next.set(file.path, allHunkIds(file));
      return next;
    });

  const selectedCount = countSelected(selection);
  /** The staged subset of the selection — what an Unstage would actually act
   *  on. Gating Unstage on `selectedCount` alone (as this first shipped) let a
   *  purely-unstaged selection send a reverse patch git rejects with a raw
   *  "patch does not apply". */
  const stagedSelected = useMemo(() => stagedSelection(selection, staged), [selection, staged]);
  const stagedSelectedCount = countSelected(stagedSelected);

  const runStaging = async (mode: 'stage' | 'unstage') => {
    // Unstage may only touch hunks git can actually reverse: the staged subset.
    // Sending the raw selection would fail on any unstaged hunk in it.
    const effective = mode === 'unstage' ? stagedSelected : selection;
    if (countSelected(effective) === 0 || busy) return;
    setBusy(true);
    setError(null);
    try {
      const patch = buildPatch(files, effective);
      // Files with no hunks (binary, pure rename) can't ride in a patch, so they
      // are staged whole-file by path instead.
      const paths = files
        .filter((f) => effective.has(f.path) && f.hunks.length === 0)
        .map((f) => f.path);
      await window.orchestra.applyReviewPatch(workspaceId, { patch, paths, mode });
      setSelection(new Map());
      setToast(mode === 'stage' ? 'Staged' : 'Unstaged');
      await refresh(scope);
    } catch (e) {
      // git's own message ("does not exist in index", "corrupt patch") is the
      // useful signal here — it means the working tree moved under the review.
      setError(`${mode === 'stage' ? 'Stage' : 'Unstage'} failed: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const saveAnnotation = (file: DiffFilePatch, line: DiffLine) => {
    const body = draft.trim();
    if (!body) {
      setComposingAt(null);
      setDraft('');
      return;
    }
    const side: 'old' | 'new' = line.kind === 'del' ? 'old' : 'new';
    const num = side === 'old' ? line.oldLine : line.newLine;
    if (num == null) return;
    setAnnotations((prev) => [
      ...prev,
      {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        path: file.path,
        line: num,
        side,
        code: line.text,
        body,
      },
    ]);
    setComposingAt(null);
    setDraft('');
  };

  const sendReview = async () => {
    if (annotations.length === 0 || busy) return;
    setBusy(true);
    setError(null);
    try {
      const prompt = composeRevisionPrompt(annotations, { scope });
      await window.orchestra.sendReviewToAgent(workspaceId, prompt);
      setAnnotations([]);
      setToast('Review sent to the agent');
    } catch (e) {
      setError(`Could not send review: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 2600);
    return () => clearTimeout(t);
  }, [toast]);

  const totals = useMemo(() => {
    let additions = 0;
    let deletions = 0;
    for (const f of files) {
      const s = fileStats(f);
      additions += s.additions;
      deletions += s.deletions;
    }
    return { additions, deletions, files: files.length };
  }, [files]);

  const renderRow = (row: Row) => {
    switch (row.kind) {
      case 'file': {
        const f = row.file;
        const s = fileStats(f);
        const check = fileCheckState(f, selection);
        const isCollapsed = collapsed.has(f.path);
        const label = statusLabel(f);
        return (
          <div className="diff-file-head" key={row.key}>
            {scope === 'uncommitted' && (
              <input
                type="checkbox"
                className="diff-check"
                checked={check === 'all'}
                ref={(el) => {
                  if (el) el.indeterminate = check === 'some';
                }}
                onChange={() => toggleWholeFile(f)}
                aria-label={`Select all changes in ${f.path}`}
              />
            )}
            <button
              className="diff-file-toggle"
              onClick={() => toggleFile(f.path)}
              aria-expanded={!isCollapsed}
            >
              <span className={`diff-caret ${isCollapsed ? 'collapsed' : ''}`} aria-hidden="true">
                ▾
              </span>
              <span className="diff-file-path">
                {f.status === 'renamed' && f.oldPath !== f.path ? (
                  <>
                    <span className="diff-old-path">{f.oldPath}</span>
                    <span aria-hidden="true"> → </span>
                    {f.path}
                  </>
                ) : (
                  f.path
                )}
              </span>
            </button>
            {label && <span className="diff-file-tag">{label}</span>}
            <span className="diff-file-stat">
              {s.additions > 0 && <span className="diff-plus">+{s.additions}</span>}
              {s.deletions > 0 && <span className="diff-minus">−{s.deletions}</span>}
            </span>
          </div>
        );
      }
      case 'note':
        return (
          <div className="diff-note" key={row.key}>
            {row.text}
          </div>
        );
      case 'hunk': {
        const h = row.hunk;
        const st = hunkStats(h);
        const checked = selection.get(row.file.path)?.has(h.id) ?? false;
        return (
          <div className="diff-hunk-head" key={row.key}>
            {scope === 'uncommitted' && (
              <input
                type="checkbox"
                className="diff-check"
                checked={checked}
                onChange={() => toggleHunk(row.file, h)}
                aria-label={`Select hunk at line ${h.newStart} of ${row.file.path}`}
              />
            )}
            <span className="diff-hunk-range">
              @@ −{h.oldStart},{h.oldCount} +{h.newStart},{h.newCount} @@
            </span>
            {staged.get(row.file.path)?.has(h.id) && (
              <span className="diff-staged-tag" title="Already staged (in the index)">
                staged
              </span>
            )}
            {h.heading && <span className="diff-hunk-heading">{h.heading}</span>}
            <span className="diff-hunk-stat">
              {st.additions > 0 && <span className="diff-plus">+{st.additions}</span>}
              {st.deletions > 0 && <span className="diff-minus">−{st.deletions}</span>}
            </span>
          </div>
        );
      }
      case 'annotation': {
        const a = row.annotation;
        return (
          <div className="diff-annotation" key={row.key}>
            <span className="diff-annotation-mark" aria-hidden="true">
              ▸
            </span>
            <span className="diff-annotation-body">{a.body}</span>
            <button
              className="diff-annotation-del"
              onClick={() => setAnnotations((prev) => prev.filter((x) => x.id !== a.id))}
              aria-label="Delete comment"
              title="Delete comment"
            >
              ×
            </button>
          </div>
        );
      }
      case 'line': {
        const l = row.line;
        const cls = l.kind === 'add' ? 'add' : l.kind === 'del' ? 'del' : 'ctx';
        const composing = composingAt === row.key;
        return (
          <div key={row.key}>
            <div className={`diff-line ${cls} ${wrap ? 'wrap' : ''}`}>
              <button
                className="diff-gutter"
                title="Comment on this line"
                aria-label={`Comment on line ${l.newLine ?? l.oldLine} of ${row.file.path}`}
                onClick={() => {
                  setComposingAt(composing ? null : row.key);
                  setDraft('');
                }}
              >
                <span className="diff-lineno old">{l.oldLine ?? ''}</span>
                <span className="diff-lineno new">{l.newLine ?? ''}</span>
                <span className="diff-comment-dot" aria-hidden="true">
                  +
                </span>
              </button>
              <span className="diff-sign" aria-hidden="true">
                {l.kind === 'add' ? '+' : l.kind === 'del' ? '−' : ' '}
              </span>
              <span className="diff-text">{l.text === '' ? ' ' : l.text}</span>
            </div>
            {composing && (
              <div className="diff-composer">
                <textarea
                  className="diff-composer-input"
                  autoFocus
                  value={draft}
                  placeholder="Leave a comment (markdown). Cmd/Ctrl+Enter to save."
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                      e.preventDefault();
                      saveAnnotation(row.file, l);
                    } else if (e.key === 'Escape') {
                      e.preventDefault();
                      setComposingAt(null);
                      setDraft('');
                    }
                  }}
                />
                <div className="diff-composer-actions">
                  <span className="diff-composer-hint">⌘↵ to save · Esc to cancel</span>
                  <button
                    className="diff-btn"
                    onClick={() => {
                      setComposingAt(null);
                      setDraft('');
                    }}
                  >
                    Cancel
                  </button>
                  <button
                    className="diff-btn primary"
                    disabled={!draft.trim()}
                    onClick={() => saveAnnotation(row.file, l)}
                  >
                    Comment
                  </button>
                </div>
              </div>
            )}
          </div>
        );
      }
    }
  };

  return (
    <div className="pane diff-pane">
      <div className="diff-header">
        <div className="diff-scopes" role="tablist" aria-label="Diff scope">
          <button
            role="tab"
            aria-selected={scope === 'uncommitted'}
            className={`diff-scope ${scope === 'uncommitted' ? 'active' : ''}`}
            onClick={() => setScope('uncommitted')}
            title="Working tree and index vs HEAD, plus untracked files"
          >
            Uncommitted
          </button>
          <button
            role="tab"
            aria-selected={scope === 'base'}
            className={`diff-scope ${scope === 'base' ? 'active' : ''}`}
            onClick={() => setScope('base')}
            title="Committed changes on this branch vs its base (three-dot)"
          >
            vs base
          </button>
        </div>
        <div className="diff-summary">
          {totals.files > 0 && (
            <>
              {totals.files} file{totals.files === 1 ? '' : 's'}
              <span className="diff-plus"> +{totals.additions}</span>
              <span className="diff-minus"> −{totals.deletions}</span>
            </>
          )}
        </div>
        <div className="diff-actions">
          <button
            className={`diff-btn ${wrap ? 'active' : ''}`}
            onClick={() => setWrap((v) => !v)}
            title="Toggle word wrap"
            aria-pressed={wrap}
          >
            Wrap
          </button>
          <button className="diff-btn" onClick={() => void refresh(scope)} disabled={loading}>
            {loading ? 'Loading…' : 'Refresh'}
          </button>
          {scope === 'uncommitted' && (
            <>
              <button
                className="diff-btn"
                disabled={selectedCount === 0 || busy}
                onClick={() => void runStaging('stage')}
                title="git apply --cached the selected hunks"
              >
                Stage{selectedCount > 0 ? ` ${selectedCount}` : ''}
              </button>
              <button
                className="diff-btn"
                disabled={stagedSelectedCount === 0 || busy}
                onClick={() => void runStaging('unstage')}
                title={
                  stagedSelectedCount > 0
                    ? `Unstage ${stagedSelectedCount} staged hunk${stagedSelectedCount === 1 ? '' : 's'}`
                    : selectedCount > 0
                      ? 'Nothing selected is staged — Unstage only applies to hunks already in the index'
                      : 'Select staged hunks to unstage'
                }
              >
                Unstage{stagedSelectedCount > 0 ? ` ${stagedSelectedCount}` : ''}
              </button>
            </>
          )}
          <button
            className="diff-btn primary"
            disabled={annotations.length === 0 || busy}
            onClick={() => void sendReview()}
            title={
              annotations.length
                ? `Send ${summarizeAnnotations(annotations)} to the agent as one revision prompt`
                : 'Comment on lines first'
            }
          >
            Send to agent{annotations.length > 0 ? ` (${annotations.length})` : ''}
          </button>
        </div>
      </div>

      {error && <div className="diff-error">{error}</div>}
      {toast && <div className="diff-toast">{toast}</div>}

      <div className="diff-scroll" ref={scrollRef} onScroll={onScroll}>
        {!loading && files.length === 0 && !error && (
          <div className="diff-empty">
            {scope === 'uncommitted'
              ? 'No uncommitted changes.'
              : 'No committed changes on this branch vs its base.'}
          </div>
        )}
        {virtualize ? (
          <div style={{ height: rows.length * ROW_H, position: 'relative' }}>
            <div style={{ transform: `translateY(${first * ROW_H}px)` }}>
              {visible.map(renderRow)}
            </div>
          </div>
        ) : (
          visible.map(renderRow)
        )}
      </div>
    </div>
  );
}
