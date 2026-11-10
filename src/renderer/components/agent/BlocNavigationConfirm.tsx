import { useEffect, useRef, useState } from 'react';
import { openArmed, type BlocNavigationRequest } from '../../../shared/bloc-html-navigation';

const OPEN_ARM_MS = 600;

/**
 * The confirmation a Bloc HTML's navigation raises (#416, ADR 0011): the COMPLETE URL, nothing opens until « Open link ». Main holds the one pending
 * request (pull on mount + push); only the active conversation renders it, and the answer carries the id — never the URL.
 */
export function BlocNavigationConfirm({ active }: { active: boolean }) {
  const [req, setReq] = useState<BlocNavigationRequest | null>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const answered = useRef<string | null>(null);
  const pushed = useRef(false);
  const [armedFor, setArmedFor] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    // A push that arrived first is newer than the pull: a late pull must not resurrect a request main already retracted.
    void window.orchestra.blocNavigationPending().then((r) => { if (live && r && !pushed.current) setReq(r); }).catch(() => {});
    const off = window.orchestra.onBlocNavigation((r) => { pushed.current = true; setReq(r); });
    return () => { live = false; off(); };
  }, []);

  const shown = active && req && answered.current !== req.id ? req : null;
  const answer = (id: string, confirmed: boolean) => {
    if (!req || req.id !== id) return; // never answer a request other than the one the human is looking at
    answered.current = id;
    setReq(null);
    void window.orchestra.answerBlocNavigation(id, confirmed).catch(() => {});
  };

  useEffect(() => {
    if (!shown) return;
    const before = document.activeElement as HTMLElement | null;
    const id = shown.id;
    setArmedFor(null);
    const arm = window.setTimeout(() => setArmedFor(id), OPEN_ARM_MS); // a bloc that navigates on mousedown must not get the human's double-click onto « Open link »
    cancelRef.current?.focus(); // the safe answer holds the focus: a stray Enter opens nothing
    // Capture + stop: Escape here dismisses THIS confirmation and must not also cancel a permission dialog's window listener.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') {
        if (e.key === 'Enter' || /^[1-9]$/.test(e.key)) e.stopPropagation(); // the AskUserQuestion card's window listener must not act on keys meant for this dialog
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      answer(id, false);
    };
    window.addEventListener('keydown', onKey, true);
    return () => { window.clearTimeout(arm); window.removeEventListener('keydown', onKey, true); before?.focus?.(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shown?.id]);

  if (!shown) return null;
  return (
    <div className="av-permission-backdrop" role="presentation">
      <div className="av-permission-dialog av-bloc-nav-confirm" role="alertdialog" aria-modal="true" aria-labelledby="av-bloc-nav-title" aria-describedby="av-bloc-nav-url">
        <div className="av-permission-header">
          <span className="av-permission-eyebrow">HTML block</span>
        </div>
        <h2 id="av-bloc-nav-title" className="av-permission-title">Open this link in your browser?</h2>
        <p className="av-permission-subtitle">A block in this reply tried to navigate. Nothing has been opened.</p>
        <div id="av-bloc-nav-url" className="av-bloc-nav-url" data-testid="bloc-nav-url">{shown.url}</div>
        <div className="av-permission-actions">
          <button ref={cancelRef} type="button" className="av-bloc-nav-cancel" onClick={() => answer(shown.id, false)}>Don’t open</button>
          <button type="button" className="av-bloc-nav-open" disabled={!openArmed(armedFor, shown.id)} onClick={() => { if (openArmed(armedFor, shown.id)) answer(shown.id, true); }}>Open link</button>
        </div>
      </div>
    </div>
  );
}
