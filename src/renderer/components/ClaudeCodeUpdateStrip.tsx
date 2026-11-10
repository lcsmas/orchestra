import { useEffect, useLayoutEffect, useReducer, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { claudeCodeUpdateCopy, type ClaudeCodeUpdateState } from '../../shared/claude-code-update';

/** « Mise à jour disponible » (Lucas 2026-11-10, prototype verdict B): a quiet strip above the sidebar footer while a newer Claude
 *  Code is published than the one installed; a click opens the popover with both versions and the one button (« Mettre à jour » =
 *  `claude update`, « Réessayer » after a failure, « OK » once installed). No « Plus tard »: closing the popover is enough, the strip
 *  stays while an update exists. State: the pull `claudeCodeUpdate:state` + the push `claudeCodeUpdate:update` (one per renderer). */
let state: ClaudeCodeUpdateState = { kind: 'none' };
let pushed = false;
let started = false;
const subs = new Set<() => void>();

function apply(s: ClaudeCodeUpdateState, fromPush: boolean): void {
  // the boot pull can land after a push: the push is the newer one
  if (!fromPush && pushed) return;
  pushed ||= fromPush;
  state = s;
  subs.forEach((f) => f());
}
function ensureStarted(): void {
  if (started) return;
  started = true;
  window.orchestra.onClaudeCodeUpdate((s) => apply(s, true));
  window.orchestra.claudeCodeUpdateState().then((s) => apply(s, false)).catch(() => {});
}


export function ClaudeCodeUpdateStrip() {
  const [, rerender] = useReducer((x: number) => x + 1, 0);
  const [open, setOpen] = useState(false);
  const [at, setAt] = useState<{ left: number; bottom: number; width: number } | null>(null);
  const stripRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ensureStarted();
    subs.add(rerender);
    return () => {
      subs.delete(rerender);
    };
  }, []);
  const copy = claudeCodeUpdateCopy(state);
  const shown = open && !!copy;
  const nothing = !copy;
  // the notice went away by itself (updated in a terminal): the popover must not come back open with the next one
  useEffect(() => {
    if (nothing) setOpen(false);
  }, [nothing]);
  // anchored above the strip and as wide as it (within reason), kept inside the window whatever the sidebar width
  useLayoutEffect(() => {
    if (!shown) return;
    const place = () => {
      const r = stripRef.current?.getBoundingClientRect();
      if (!r) return;
      const width = Math.min(Math.max(r.width, 280), 380, window.innerWidth - 16);
      setAt({ left: Math.max(8, Math.min(r.left, window.innerWidth - width - 8)), bottom: window.innerHeight - r.top + 8, width });
    };
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [shown]);
  useEffect(() => {
    if (!shown) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!popRef.current?.contains(t) && !stripRef.current?.contains(t)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [shown]);
  if (!copy) return null;
  const act = () => {
    if (copy.action === 'ack') {
      setOpen(false);
      void window.orchestra.ackClaudeCodeUpdate().catch(() => {});
    } else void window.orchestra.runClaudeCodeUpdate().catch(() => {});
  };
  return (
    <>
      <button
        ref={stripRef}
        className={`claude-code-update-strip ${copy.tone}`}
        data-claude-code-update={state.kind}
        aria-haspopup="dialog"
        aria-expanded={shown}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="claude-code-update-ico" aria-hidden="true">
          {copy.icon}
        </span>
        <span className="claude-code-update-label">{copy.strip}</span>
        <span className="claude-code-update-ver">{copy.installed}</span>
      </button>
      {shown &&
        at &&
        createPortal(
          <div ref={popRef} className="claude-code-update-pop" role="dialog" aria-label={copy.title} data-claude-code-update-pop={state.kind} style={{ left: at.left, bottom: at.bottom, width: at.width }}>
            <h3>{copy.title}</h3>
            <dl>
              <dt>Installée</dt>
              <dd data-claude-code-update-installed>{copy.installed}</dd>
              {copy.published && (
                <>
                  <dt>Publiée</dt>
                  <dd data-claude-code-update-published>{copy.published}</dd>
                </>
              )}
            </dl>
            {copy.note && <p>{copy.note}</p>}
            {copy.error && (
              <pre className="claude-code-update-error" role="alert" data-claude-code-update-error>
                {copy.error}
              </pre>
            )}
            <div className="claude-code-update-actions">
              <button className="claude-code-update-action" data-claude-code-update-action={copy.action} onClick={act} disabled={copy.busy}>
                {copy.actionLabel}
              </button>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
