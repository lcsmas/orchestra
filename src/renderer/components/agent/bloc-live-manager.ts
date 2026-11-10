import { BLOC_KEEP_MARGIN_PX, BLOC_LIVE_MAX, BLOC_MOUNT_MARGIN_PX, chooseLiveBlocs } from '../../../shared/bloc-live-budget';

/**
 * Decides which Bloc HTML slots are live (#419): a slot is a CANDIDATE while it is within the mount margin of its scroller (or, once live, within the
 * keep margin); of the candidates the BLOC_LIVE_MAX nearest to the viewport centre are live. One recompute per animation frame, on any observer change
 * and — only while candidates exceed the ceiling — on scroll. A slot only reads `live`; it never mounts itself.
 */
interface Entry { el: Element; root: Element | null; setLive: (live: boolean) => void; near: boolean; kept: boolean; live: boolean; id: string }

const entries = new Set<Entry>();
let seq = 0;
let scheduled = false;
const scrollers = new Map<Element, { count: number; off: () => void }>();

function recompute() {
  scheduled = false;
  const byRoot = new Map<Element | null, Entry[]>();
  for (const e of entries) (byRoot.get(e.root) ?? byRoot.set(e.root, []).get(e.root)!).push(e);
  for (const [root, group] of byRoot) {
    const r = root ? root.getBoundingClientRect() : { top: 0, bottom: window.innerHeight };
    const mid = (r.top + r.bottom) / 2;
    const cands = group.filter((e) => (e.live ? e.kept : e.near));
    const chosen = chooseLiveBlocs(cands.map((e) => {
      const b = e.el.getBoundingClientRect();
      return { id: e.id, dist: Math.abs((b.top + b.bottom) / 2 - mid), live: e.live };
    }), BLOC_LIVE_MAX);
    for (const e of group) {
      const want = chosen.has(e.id);
      if (want !== e.live) { e.live = want; e.setLive(want); }
    }
  }
}
function schedule() {
  if (scheduled) return;
  scheduled = true;
  requestAnimationFrame(recompute);
}

/** Registers a slot; returns its unregister. `setLive` is called only on a change. */
export function registerBlocSlot(el: Element, setLive: (live: boolean) => void): () => void {
  const root = el.closest('.av-message-list'); // rootMargin widens an ELEMENT root only, not an ancestor's clip
  const e: Entry = { el, root, setLive, near: false, kept: false, live: false, id: `s${++seq}` };
  const watch = (margin: number, on: (inside: boolean) => void) => {
    const io = new IntersectionObserver((es) => { for (const x of es) on(x.isIntersecting); schedule(); }, { root, rootMargin: `${margin}px 0px` });
    io.observe(el);
    return () => io.disconnect();
  };
  const stopNear = watch(BLOC_MOUNT_MARGIN_PX, (v) => { e.near = v; });
  const stopKept = watch(BLOC_KEEP_MARGIN_PX, (v) => { e.kept = v; });
  entries.add(e);
  if (root) {
    // Distances change with the scroll while no observer fires: re-rank, but only when the ceiling can matter.
    const s = scrollers.get(root) ?? (() => {
      const onScroll = () => { let n = 0; for (const x of entries) if (x.root === root && (x.live ? x.kept : x.near)) n++; if (n > BLOC_LIVE_MAX) schedule(); };
      root.addEventListener('scroll', onScroll, { passive: true });
      return { count: 0, off: () => root.removeEventListener('scroll', onScroll) };
    })();
    s.count++; scrollers.set(root, s);
  }
  return () => {
    stopNear(); stopKept(); entries.delete(e);
    if (root) { const s = scrollers.get(root); if (s && --s.count === 0) { s.off(); scrollers.delete(root); } }
    if (e.live) schedule(); // a freed place may let a waiting neighbour mount
  };
}
