import { useEffect, useRef, useState, useCallback } from 'react';
import type { BrowserPanelState } from '../../shared/types';
import { useStore } from '../store';

// The renderer half of the embedded browser panel. The actual web content is a
// native Electron `WebContentsView` in the main process (browser-panel.ts) —
// this component draws the CHROME around it (URL bar, back/forward/reload, tab
// title) and a PLACEHOLDER div whose on-screen rect it continuously syncs to
// main via `browserSetBounds`, so the native view sits exactly over the
// placeholder. Navigation state (URL/title/loading, from BOTH manual and
// agent-driven navigation) arrives on `onBrowserEvent` and updates the URL bar.
//
// The panel is mounted only while open + active; on unmount it hides the native
// view (so it stops compositing) but does NOT destroy it — re-opening is instant
// and the page/history survive.

interface Props {
  workspaceId: string;
  /** Whether this panel is the visible one (active workspace + panel open). */
  isActive: boolean;
}

const BLANK: (wsId: string) => BrowserPanelState = (wsId) => ({
  wsId,
  url: '',
  title: '',
  loading: false,
  canGoBack: false,
  canGoForward: false,
});

export function BrowserPanel({ workspaceId, isActive }: Props) {
  const holderRef = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<BrowserPanelState>(() => BLANK(workspaceId));
  // The URL bar is a controlled input the user can edit without it being
  // clobbered by every navigation event; we only sync it from state when the
  // input isn't focused.
  const [urlInput, setUrlInput] = useState('');
  const urlFocused = useRef(false);

  // Push the placeholder's rect to main so the native view tracks it. Called on
  // mount, resize, scroll, and whenever the active/open state flips.
  const syncBounds = useCallback(() => {
    const el = holderRef.current;
    if (!el || !isActive) return;
    const r = el.getBoundingClientRect();
    void window.orchestra.browserSetBounds(workspaceId, {
      x: r.left,
      y: r.top,
      width: r.width,
      height: r.height,
    });
  }, [workspaceId, isActive]);

  // Subscribe to navigation state for THIS workspace (once).
  useEffect(() => {
    let mounted = true;
    // Prime from the current main-side state (covers a re-mount after the agent
    // already navigated while the panel was closed).
    void window.orchestra.browserState(workspaceId).then((s) => {
      if (mounted) {
        setState(s);
        if (!urlFocused.current) setUrlInput(s.url);
      }
    });
    const off = window.orchestra.onBrowserEvent((id, s) => {
      if (id !== workspaceId) return;
      setState(s);
      if (!urlFocused.current) setUrlInput(s.url);
    });
    return () => {
      mounted = false;
      off();
    };
  }, [workspaceId]);

  // Show/hide the native view as this panel becomes active/inactive, and keep
  // its bounds in sync while active.
  useEffect(() => {
    if (isActive) {
      void window.orchestra.browserShow(workspaceId).then((s) => {
        setState(s);
        if (!urlFocused.current) setUrlInput(s.url);
        // Bounds must be applied AFTER the view is added; do it next frame so
        // the placeholder has laid out.
        requestAnimationFrame(syncBounds);
      });
    } else {
      void window.orchestra.browserHide(workspaceId);
    }
    // Hide on unmount too (leaving the workspace / closing the panel).
    return () => {
      void window.orchestra.browserHide(workspaceId);
    };
  }, [workspaceId, isActive, syncBounds]);

  // Track placeholder resizes (pane resizer drag, window resize, sidebar drag).
  useEffect(() => {
    if (!isActive) return;
    const el = holderRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => syncBounds());
    ro.observe(el);
    window.addEventListener('resize', syncBounds);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', syncBounds);
    };
  }, [isActive, syncBounds]);

  // --- Design mode (element picker) ----------------------------------------
  //
  // Armed state lives here (not in the store) because it is per-panel UI state
  // that must die with the panel: leaving design mode armed on an unmounted
  // panel would leave an invisible click-swallowing overlay in that page.
  const [designArmed, setDesignArmed] = useState(false);
  const addDesignPick = useStore((s) => s.addDesignPick);

  // While armed, poll main for a completed pick. The picker holds no CDP event
  // subscription (one debugger, one attach — see browser-panel.ts), so main
  // cannot push; the renderer asks. 150ms is well under the perceptual budget
  // for "I clicked and something happened" while costing one trivial
  // Runtime.evaluate per tick, and only while the user is actively picking.
  useEffect(() => {
    if (!designArmed) return;
    let stopped = false;
    const timer = setInterval(() => {
      void window.orchestra
        .browserDesignPoll(workspaceId)
        .then((res) => {
          if (stopped || !res) return;
          // Escape in the page = cancel; disarm without capturing.
          if ('cancelled' in res) {
            setDesignArmed(false);
            return;
          }
          // One-shot by design (spec): a pick disarms, so a stray second click
          // never captures something the user didn't mean to send. The toolbar
          // button re-arms.
          addDesignPick(workspaceId, res);
          setDesignArmed(false);
        })
        .catch((e) => {
          // A poll failing (panel navigating, view reaped) must not leave the
          // UI stuck in an armed state that no longer has an overlay behind it.
          console.error('browserDesignPoll failed', e);
          setDesignArmed(false);
        });
    }, 150);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [designArmed, workspaceId, addDesignPick]);

  // Push the armed state into the page (inject/tear down the overlay). Also
  // disarms on unmount and whenever the panel goes inactive, so no page is ever
  // left with a live click-swallowing overlay.
  useEffect(() => {
    if (designArmed && isActive) {
      void window.orchestra.browserDesignArm(workspaceId).catch((e) => {
        console.error('browserDesignArm failed', e);
        setDesignArmed(false);
      });
    } else {
      void window.orchestra.browserDesignDisarm(workspaceId).catch(() => {
        /* nothing armed / no live view — disarm is best-effort by design */
      });
    }
  }, [designArmed, isActive, workspaceId]);

  // A navigation replaces the document, taking the injected overlay with it —
  // so an armed picker silently stops working. Re-arm on every URL change while
  // armed, so design mode survives the user clicking a link mid-pick.
  useEffect(() => {
    if (!designArmed || !isActive || !state.url) return;
    void window.orchestra.browserDesignArm(workspaceId).catch(() => {
      /* re-arm is best effort; the toggle stays available */
    });
  }, [state.url, designArmed, isActive, workspaceId]);

  const submitUrl = (e: React.FormEvent) => {
    e.preventDefault();
    const v = urlInput.trim();
    if (!v) return;
    void window.orchestra.browserNavigate(workspaceId, v);
  };

  return (
    <div
      className={`browser-panel ${isActive ? '' : 'browser-panel-hidden'} ${designArmed ? 'browser-panel-design' : ''}`}
    >
      <div className="browser-toolbar">
        <button
          className="browser-nav-btn"
          title="Back"
          aria-label="Back"
          disabled={!state.canGoBack}
          onClick={() => void window.orchestra.browserBack(workspaceId)}
        >
          <svg viewBox="0 0 16 16" width="18" height="18" aria-hidden="true">
            <path fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" d="M10 3.5 5.5 8 10 12.5" />
          </svg>
        </button>
        <button
          className="browser-nav-btn"
          title="Forward"
          aria-label="Forward"
          disabled={!state.canGoForward}
          onClick={() => void window.orchestra.browserForward(workspaceId)}
        >
          <svg viewBox="0 0 16 16" width="18" height="18" aria-hidden="true">
            <path fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" d="M6 3.5 10.5 8 6 12.5" />
          </svg>
        </button>
        <button
          className="browser-nav-btn"
          title="Reload"
          aria-label="Reload"
          onClick={() => void window.orchestra.browserReload(workspaceId)}
        >
          <svg viewBox="0 0 16 16" width="18" height="18" aria-hidden="true">
            <path fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" d="M12.5 4.5a5 5 0 1 0 1 3" />
            <path fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" d="M12.8 2.5v2.4h-2.4" />
          </svg>
        </button>
        <form className="browser-url-form" onSubmit={submitUrl}>
          <input
            className="browser-url-input"
            value={urlInput}
            spellCheck={false}
            placeholder="Enter a URL or search…"
            onFocus={() => {
              urlFocused.current = true;
            }}
            onBlur={() => {
              urlFocused.current = false;
              setUrlInput(state.url);
            }}
            onChange={(e) => setUrlInput(e.target.value)}
          />
          {state.loading && <span className="browser-spinner" aria-label="Loading" />}
        </form>
        <button
          className={`browser-nav-btn browser-design-btn ${designArmed ? 'browser-design-btn-on' : ''}`}
          title={
            designArmed
              ? 'Design mode: click an element to send it to the agent (Esc to cancel)'
              : 'Design mode — pick an element to send to the agent'
          }
          aria-label="Design mode"
          aria-pressed={designArmed}
          onClick={() => setDesignArmed((v) => !v)}
        >
          {/* Crosshair */}
          <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
            <circle cx="8" cy="8" r="4" fill="none" stroke="currentColor" strokeWidth="1.4" />
            <path
              fill="none"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinecap="round"
              d="M8 1v2.2M8 12.8V15M1 8h2.2M12.8 8H15"
            />
          </svg>
        </button>
      </div>
      {designArmed && (
        <div className="browser-design-hint">
          Click an element to send its HTML, styles and a screenshot to the agent ·{' '}
          <kbd>Esc</kbd> to cancel
        </div>
      )}
      {state.error && <div className="browser-error">{state.error}</div>}
      {/* The native WebContentsView is composited over this placeholder. */}
      <div className="browser-holder" ref={holderRef} />
    </div>
  );
}
