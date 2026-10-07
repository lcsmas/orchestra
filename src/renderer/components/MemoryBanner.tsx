import { useLayoutEffect, useRef } from 'react';
import { useStore } from '../store';
import { bannerCopy, bannerVisible, type MemoryBannerState } from '../../shared/memory-banner';

/** Memory banner (#289, epic #284 "Visibility"; D5 ruling D-pick3 = option B: main column above the pane, two lines, French, GLOBAL). Shown while the memory guard HOLDS Admission (amber) or a memory Pause is in
 *  effect (red); it vanishes by itself on recovery. « Masquer » hides exactly this banner until the episode ends — it comes back on an escalation (held → Pause), a new Pause cycle or the next episode. The words
 *  and the dismiss rule are pure (src/shared/memory-banner.ts); the state is pushed by main (`memoryGuard:bannerUpdate`) and cached WHOLESALE in the store. Same above-the-pane-row placement as SetupBanner so the
 *  absolutely-positioned TerminalView can't eclipse it; mounted for EVERY screen, with or without an active workspace. The full-page overlays (Bus, Insights, Help, Resources) are `inset: 0` in the same column: the
 *  banner publishes its height as `--memory-banner-h` on `main.main` and they start below it (styles.css), so none of them hides it. */
export function MemoryBanner() {
  const banner = useStore((s) => s.memoryBanner);
  const dismissed = useStore((s) => s.memoryBannerDismissed);
  if (!banner || !bannerVisible(banner, dismissed)) return null;
  return <MemoryBannerBar banner={banner} />;
}

function MemoryBannerBar({ banner }: { banner: MemoryBannerState }) {
  const dismiss = useStore((s) => s.dismissMemoryBanner);
  const ref = useRef<HTMLDivElement>(null);
  // the height the overlays start below; removed with the banner
  useLayoutEffect(() => {
    const el = ref.current;
    const host = el?.closest('main.main') as HTMLElement | null | undefined;
    if (!el || !host) return;
    const publish = () => host.style.setProperty('--memory-banner-h', `${el.offsetHeight}px`);
    publish();
    const ro = new ResizeObserver(publish);
    ro.observe(el);
    return () => {
      ro.disconnect();
      host.style.removeProperty('--memory-banner-h');
    };
  }, []);
  const copy = bannerCopy(banner);
  if (!copy) return null;
  const at = copy.title.indexOf(' — ');
  const lead = at > 0 ? copy.title.slice(0, at) : copy.title;
  const rest = at > 0 ? copy.title.slice(at) : '';
  return (
    <div ref={ref} className={`memory-banner ${copy.tone}`} role="status" aria-live="polite" data-kind={banner.kind} data-tone={copy.tone}>
      <span className="memory-banner-ico" aria-hidden="true">{copy.tone === 'crit' ? '⏸' : '!'}</span>
      <span className="memory-banner-text">
        <span className="memory-banner-title">
          <strong>{lead}</strong>
          {rest}
        </span>
        <span className="memory-banner-sub">{copy.sub}</span>
      </span>
      <button className="memory-banner-dismiss" onClick={dismiss} title="Masquer jusqu'à la fin de l'épisode — revient si la situation s'aggrave">
        Masquer
      </button>
    </div>
  );
}
