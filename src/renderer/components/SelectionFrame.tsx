// The sidebar's ONE selection surface (Orca's lineage card): a rounded frame behind the selected tree —
// root + visible descendants — or, when the selection has no tree, behind the selected row alone.
// It SLIDES when the selection changes and follows rows while they fold/unfold.
//
// Aiming at the live mid-fold position overshot 37–100px (measured), so a selection change eases toward the
// END-STATE rect, read by fast-forwarding the rows' CSS transitions for one synchronous measure. Any other
// render (data update, chevron fold, resize) tracks the live rect.
import React, { useLayoutEffect, useRef } from 'react';

type Rect = { top: number; height: number; left: number; width: number };
const DUR = 280;
const TRACK_MS = 450; // ≥ the rows' 240ms fold transition, with margin
const ease = (x: number) => 1 - Math.pow(1 - x, 3);
const lerp = (a: Rect, b: Rect, w: number): Rect => ({
  top: a.top + (b.top - a.top) * w,
  height: a.height + (b.height - a.height) * w,
  left: a.left + (b.left - a.left) * w,
  width: a.width + (b.width - a.width) * w,
});

export function SelectionFrame({ selectionKey }: { selectionKey: string | null }) {
  const ref = useRef<HTMLDivElement>(null);
  const st = useRef({
    raf: 0,
    until: 0,
    anim: null as { from: Rect; dest: Rect; t0: number } | null,
    shown: null as Rect | null,
    key: undefined as string | null | undefined,
  });

  const measure = (list: HTMLElement, frame: HTMLElement): Rect | null => {
    const tree = [...list.querySelectorAll<HTMLElement>('.ws-item.ws-in-selected-tree:not(.ws-folded)')];
    const target = tree.length ? tree : [...list.querySelectorAll<HTMLElement>('.ws-item.active:not(.ws-folded)')];
    if (!target.length) return null;
    const lr = list.getBoundingClientRect();
    let top = Infinity, bottom = -Infinity, left = Infinity, right = -Infinity;
    for (const r of target) {
      const b = r.getBoundingClientRect();
      top = Math.min(top, b.top); bottom = Math.max(bottom, b.bottom);
      left = Math.min(left, b.left); right = Math.max(right, b.right);
    }
    frame.classList.toggle('tree', tree.length > 0);
    return { top: top - lr.top + list.scrollTop, height: bottom - top, left: left - lr.left, width: right - left };
  };

  /** One frame: place the frame at the live rect, or along the slide while one is running. */
  const paint = () => {
    const frame = ref.current;
    const list = frame?.parentElement;
    if (!frame || !list) return;
    const s = st.current;
    const live = measure(list, frame);
    if (!live) {
      frame.classList.remove('on');
      s.shown = null;
      return;
    }
    let r = live;
    if (s.anim) {
      const w = ease(Math.min(1, (performance.now() - s.anim.t0) / DUR));
      if (w < 1) r = lerp(s.anim.from, s.anim.dest, w);
      else s.anim = null;
    }
    frame.style.top = `${r.top}px`;
    frame.style.height = `${r.height}px`;
    frame.style.left = `${r.left}px`;
    frame.style.width = `${r.width}px`;
    frame.classList.add('on');
    s.shown = r;
  };
  const track = (ms: number) => {
    const s = st.current;
    s.until = Math.max(s.until, performance.now() + ms);
    if (s.raf) return;
    const tick = () => {
      paint();
      s.raf = performance.now() < s.until || s.anim ? requestAnimationFrame(tick) : 0;
    };
    s.raf = requestAnimationFrame(tick);
  };

  // Every render: rows may have moved (data update). On a selection change, start the slide.
  useLayoutEffect(() => {
    const frame = ref.current;
    const list = frame?.parentElement;
    if (!frame || !list) return;
    const s = st.current;
    if (s.key !== selectionKey) {
      const first = s.key === undefined;
      s.key = selectionKey;
      // End state: jump every running row transition to its end, measure, put them back (one sync frame).
      void list.offsetHeight; // flush style so this render's fold transitions exist
      const anims = list.getAnimations({ subtree: true }).filter((a) =>
        ((a.effect as KeyframeEffect | null)?.target as Element | null)?.classList.contains('ws-item'),
      );
      const saved = anims.map((a) => a.currentTime);
      for (const a of anims) a.currentTime = Number(a.effect?.getComputedTiming().endTime ?? 0);
      const dest = measure(list, frame);
      anims.forEach((a, i) => { a.currentTime = saved[i]; });
      const still = first || !s.shown || !dest || window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      s.anim = still ? null : { from: s.shown!, dest: dest!, t0: performance.now() };
      track(TRACK_MS);
    }
    paint();
  });

  // Folds without a selection change (chevron) and sidebar width changes: track for a transition's length.
  useLayoutEffect(() => {
    const list = ref.current?.parentElement;
    if (!list) return;
    const onT = (e: Event) => {
      if ((e.target as HTMLElement).classList?.contains('ws-item')) track(TRACK_MS);
    };
    list.addEventListener('transitionrun', onT);
    const ro = new ResizeObserver(() => track(100));
    ro.observe(list);
    return () => {
      list.removeEventListener('transitionrun', onT);
      ro.disconnect();
      cancelAnimationFrame(st.current.raf);
      st.current.raf = 0;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <div ref={ref} className="ws-selection-frame" aria-hidden="true" />;
}
