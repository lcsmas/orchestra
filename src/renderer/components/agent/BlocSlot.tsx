import React, { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { BlocFrame } from './BlocFrame';
import { blocBoxKey, recallBlocHeight } from '../../../shared/bloc-live-budget';
import { registerBlocSlot } from './bloc-live-manager';
import { BlocPinContext, RowPinContext } from './bloc-pin';

interface Props {
  title: string;
  source: string;
}

/**
 * The live-frame budget of one Bloc HTML (#419, ADR 0011): the frame is mounted only while the bloc is near the scroll viewport; otherwise an empty
 * box of its LAST measured height holds the layout (no scroll jump) and the frame — scripts restarted — remounts when it comes back.
 * `bloc-live-manager.ts` picks the live set: within the mount margin (kept until the keep margin), at most BLOC_LIVE_MAX nearest. A hidden pane has no box ⇒ not near ⇒ its frames unmount.
 */
export function BlocSlot({ title, source }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const key = useMemo(() => blocBoxKey(source), [source]);
  const [pins, setPins] = useState(0);
  const rowPin = useContext(RowPinContext);
  const focusRef = useRef(false); // focus is inside the slot (read by the pin handoff below)
  const alive = useRef(true); // cleared at unmount: the handoff must not take a row pin for a slot that is gone
  const focusRowPin = useRef<(() => void) | null>(null);
  // A pin (open overlay / source view) keeps THIS frame mounted and its ROW rendered; released, the budget decides again.
  // HANDOFF: closing the overlay hands focus to the bloc's button right after the pin is released; the row pin is let go two frames later and, if focus
  // is inside by then, TRANSFERRED to the focus (acquired before the old one is released: the count never hits 0, so the transcript window never flips).
  const pin = useCallback(() => {
    setPins((n) => n + 1);
    const rel = rowPin?.();
    return () => {
      setPins((n) => n - 1);
      requestAnimationFrame(() => requestAnimationFrame(() => {
        if (alive.current && focusRef.current && !focusRowPin.current) focusRowPin.current = rowPin?.() ?? null;
        rel?.();
      }));
    };
  }, [rowPin]);
  const [live, setLive] = useState(typeof IntersectionObserver === 'undefined'); // no observer (tests): always live
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    return registerBlocSlot(el, setLive);
  }, []);
  // Focus inside the slot keeps it mounted: closing an overlay hands focus to the bloc's button in the same flush that releases the pin — unmounting then would drop focus to <body> (#419 review).
  // A BARE focus (a click on « Afficher tout », a Tab stop) pins nothing else: taking the ROW pin there re-windowed the transcript under the pointer mid-click (#419 chrome-rig flake).
  const [focusWithin, setFocusWithin] = useState(false);
  const dropFocus = useCallback(() => { focusRef.current = false; setFocusWithin(false); focusRowPin.current?.(); focusRowPin.current = null; }, []);
  useEffect(() => { if (focusWithin && !ref.current?.contains(document.activeElement)) dropFocus(); }); // the focused node can vanish without a blur
  useEffect(() => { alive.current = true; return () => { alive.current = false; focusRowPin.current?.(); focusRowPin.current = null; }; }, []);
  const shown = live || pins > 0 || focusWithin;
  return (
    <div ref={ref} className="av-bloc-slot" data-live={shown ? '1' : '0'} onFocus={() => { focusRef.current = true; setFocusWithin(true); }} onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) dropFocus(); }}>
      <BlocPinContext.Provider value={pin}>
        {shown ? <BlocFrame title={title} source={source} /> : <div className="av-bloc av-bloc-idle" role="img" aria-label={title}><div style={{ height: recallBlocHeight(key) }} /></div>}
      </BlocPinContext.Provider>
    </div>
  );
}
