import { useEffect, useRef, useState, useCallback } from 'react';
import type { BrowserPanelState, BrowserProfile, BrowserTabResult } from '../../shared/types';
import { tabLabel } from '../../shared/browser-tab-state';
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
  tabs: [],
  activeTabId: '',
});

/** How long the « the agent brought a tab to the front » notice stays up (#397). */
const AGENT_NOTICE_MS = 9000;

export function BrowserPanel({ workspaceId, isActive }: Props) {
  const holderRef = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<BrowserPanelState>(() => BLANK(workspaceId));
  // The URL bar is a controlled input the user can edit without it being
  // clobbered by every navigation event; we only sync it from state when the
  // input isn't focused.
  const [urlInput, setUrlInput] = useState('');
  const urlFocused = useRef(false);
  // The LATEST url main pushed — read by onBlur (a ref, so it is not a render behind like `state.url` in a closure).
  // KNOWN PRE-EXISTING DEFECT, NOT FIXED here: after the first navigation of a blank tab the bar can stay EMPTY (seat 3: 8/26 on this
  // code vs 3/26 on the code before it — not distinguishable). Trace: submit -> the input blurs 10-38 ms later -> onBlur resets the bar
  // to latestUrl, still '' because main has not pushed the url yet -> the input is refocused 1-11 ms later -> the url event is skipped
  // (urlFocused) -> '' stays. A ref cannot help: both are '' at blur. Ledger #405 (#393 verifier report, F1).
  const latestUrl = useRef('');
  /** Take a state from main: remember its url for onBlur, and let the bar follow it unless the user is typing. */
  const applyState = useCallback((s: BrowserPanelState, force = false) => {
    latestUrl.current = s.url;
    setState(s);
    if (force || !urlFocused.current) setUrlInput(s.url);
  }, []);
  const urlInputRef = useRef<HTMLInputElement>(null);
  // A refused tab operation (the cap of 8) is shown, not swallowed: the user must be told why nothing opened.
  const [tabNotice, setTabNotice] = useState<string | null>(null);
  // Focus the URL bar once the NEW (blank) tab has become the active one.
  const focusUrlOnNewTab = useRef(false);
  // Profils navigateur (#400): the chip shows what ALL this workspace's tabs run on; the inline bar attaches / switches /
  // detaches it. Main owns the rules — this only asks (human-facing IPC), and a refusal is shown, never swallowed.
  const [profiles, setProfiles] = useState<BrowserProfile[]>([]);
  const [profileBarOpen, setProfileBarOpen] = useState(false);
  const [profileBusy, setProfileBusy] = useState(false);
  const settingsOpen = useStore((s) => s.browserSettingsOpen);
  const setBrowserSettingsOpen = useStore((s) => s.setBrowserSettingsOpen);

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
      if (mounted) applyState(s);
    });
    const off = window.orchestra.onBrowserEvent((id, s) => {
      if (id !== workspaceId) return;
      applyState(s);
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
        applyState(s);
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
    let inFlight = false; // one poll at a time: a pick's poll also takes the element screenshot (~100-150 ms), and a tick landing after main released the attach would re-take it (#406)
    const timer = setInterval(() => {
      if (inFlight) return;
      inFlight = true;
      void window.orchestra
        .browserDesignPoll(workspaceId)
        .finally(() => {
          inFlight = false;
        })
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

  // Leaving a workspace unmounts this component (App keys it by workspace, #393) — and nothing else disarms the picker on that
  // workspace: the effect above only runs for the NEW instance. Without this cleanup the workspace we leave keeps its overlay —
  // and, since #398, its lease on the proxy's debugger attach — until its panel is destroyed. (Also covers a changed `workspaceId`.)
  useEffect(() => {
    return () => {
      void window.orchestra.browserDesignDisarm(workspaceId).catch(() => {
        /* nothing armed / no live view */
      });
    };
  }, [workspaceId]);

  // A navigation replaces the document, taking the injected overlay with it —
  // so an armed picker silently stops working. Re-arm on every URL change while
  // armed, so design mode survives the user clicking a link mid-pick.
  useEffect(() => {
    if (!designArmed || !isActive || !state.url) return;
    void window.orchestra.browserDesignArm(workspaceId).catch(() => {
      /* re-arm is best effort; the toggle stays available */
    });
  }, [state.url, designArmed, isActive, workspaceId]);

  // --- Tabs (#393) -----------------------------------------------------------
  // Main owns the tab list (and the cap / ownership rules in shared/browser-tab-policy.ts); this strip only asks.
  // Design mode lives in the ACTIVE tab's page, so it is disarmed BEFORE the active tab changes — otherwise the
  // overlay would stay armed (click-swallowing, invisible to this UI) in the tab we are leaving.
  useEffect(() => {
    if (!tabNotice) return;
    const t = setTimeout(() => setTabNotice(null), 5000);
    return () => clearTimeout(t);
  }, [tabNotice]);

  // The AGENT swapped the tab on screen (#397): say so, offer « back », and let the notice lapse. A tab swap by anyone else clears
  // `agentSwitch` in main, and `to !== activeTabId` hides it here, so the notice is never about a tab you are no longer looking at.
  const [agentNoticeOn, setAgentNoticeOn] = useState(false);
  const agentSwitch = state.agentSwitch;
  useEffect(() => {
    const left = agentSwitch && agentSwitch.to === state.activeTabId ? AGENT_NOTICE_MS - (Date.now() - agentSwitch.at) : 0;
    setAgentNoticeOn(left > 0);
    if (left <= 0) return;
    const t = setTimeout(() => setAgentNoticeOn(false), left);
    return () => clearTimeout(t);
  }, [agentSwitch?.at, agentSwitch?.to, state.activeTabId]);

  useEffect(() => {
    if (focusUrlOnNewTab.current && !state.url) {
      focusUrlOnNewTab.current = false;
      urlInputRef.current?.focus();
    }
  }, [state.activeTabId, state.url]);

  // The profile list: on mount, when the choice bar opens, and after Settings > Browser closes (a profile may have been
  // created / renamed / deleted there).
  useEffect(() => {
    if (settingsOpen) return;
    let cancelled = false;
    void window.orchestra
      .browserProfiles()
      .then((list) => !cancelled && setProfiles(list))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [profileBarOpen, settingsOpen]);

  const chooseProfile = async (profileId: string | null) => {
    if (profileBusy) return;
    setProfileBusy(true);
    try {
      // Design mode lives in the pages being rebuilt: disarm first, like a tab change.
      if (designArmed) {
        await window.orchestra.browserDesignDisarm(workspaceId).catch(() => {});
        setDesignArmed(false);
      }
      const r = await window.orchestra.browserProfileAttach(workspaceId, profileId);
      setProfiles(r.profiles);
      if (r.ok) {
        if (r.state && r.state.wsId === workspaceId) applyState(r.state, true);
        setTabNotice(null);
        setProfileBarOpen(false);
      } else {
        setTabNotice(r.message);
      }
    } catch (e) {
      setTabNotice((e as Error).message);
    } finally {
      setProfileBusy(false);
    }
  };

  // Until main has pushed a state WITH tabs (first paint), show what the workspace records; afterwards what the panel really runs on.
  const recordedProfile = useStore((s) => s.workspaces.find((w) => w.id === workspaceId)?.browserProfileId);
  const profileId = state.tabs.length > 0 ? state.profileId : recordedProfile;
  const profileName = profileId ? (profiles.find((p) => p.id === profileId)?.name ?? 'Profile') : 'Ephemeral';

  const runTabOp = async (op: () => Promise<BrowserTabResult>) => {
    if (designArmed) {
      await window.orchestra.browserDesignDisarm(workspaceId).catch(() => {});
      setDesignArmed(false);
    }
    const r = await op();
    if (r.state.wsId !== workspaceId) return r; // a late result for a workspace we have since left
    // The user explicitly changed tab: the URL bar follows it even if it had focus.
    applyState(r.state, true);
    setTabNotice(r.ok ? null : r.message);
    return r;
  };

  const newTab = async () => {
    focusUrlOnNewTab.current = true;
    const r = await runTabOp(() => window.orchestra.browserTabNew(workspaceId));
    if (!r.ok) focusUrlOnNewTab.current = false;
  };

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
      <div className="browser-tabs" role="tablist" aria-label="Browser tabs">
        {state.tabs.map((t) => {
          const label = tabLabel(t);
          return (
            <div
              key={t.id}
              role="tab"
              aria-selected={t.active}
              data-tab-id={t.id}
              data-opened-by={t.openedBy}
              className={`browser-tab ${t.active ? 'browser-tab-active' : ''}`}
              title={t.url || label}
              onClick={() => {
                if (!t.active) void runTabOp(() => window.orchestra.browserTabActivate(workspaceId, t.id));
              }}
            >
              <span className="browser-tab-label">{label}</span>
              {t.openedBy === 'agent' && (
                <span className="browser-tab-agent-mark" title="Opened by the agent" aria-label="Opened by the agent">
                  agent
                </span>
              )}
              {t.loading && <span className="browser-tab-loading" aria-label="Loading" />}
              <button
                className="browser-tab-close"
                title="Close tab"
                aria-label={`Close tab ${label}`}
                onClick={(e) => {
                  e.stopPropagation();
                  void runTabOp(() => window.orchestra.browserTabClose(workspaceId, t.id));
                }}
              >
                ×
              </button>
            </div>
          );
        })}
        <button className="browser-tab-new" title="New tab" aria-label="New tab" onClick={() => void newTab()}>
          +
        </button>
      </div>
      {tabNotice && (
        <div className="browser-error browser-tab-notice" role="alert">
          {tabNotice}
        </div>
      )}
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
            ref={urlInputRef}
            className="browser-url-input"
            value={urlInput}
            spellCheck={false}
            placeholder="Enter a URL or search…"
            onFocus={() => {
              urlFocused.current = true;
            }}
            onBlur={() => {
              urlFocused.current = false;
              setUrlInput(latestUrl.current);
            }}
            onChange={(e) => setUrlInput(e.target.value)}
          />
          {state.loading && <span className="browser-spinner" aria-label="Loading" />}
        </form>
        <button
          className="browser-profile-btn"
          title={
            profileId
              ? `Browser profile “${profileName}” — all tabs of this workspace use it. Click to switch or detach.`
              : 'Ephemeral browsing — nothing is kept. Click to attach a browser profile (a persistent sign-in).'
          }
          aria-label={`Browser profile: ${profileName}`}
          aria-expanded={profileBarOpen}
          data-browser-profile-chip
          data-profile-id={profileId ?? ''}
          onClick={() => setProfileBarOpen((v) => !v)}
        >
          {/* person glyph */}
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
            <circle cx="8" cy="5.5" r="2.6" fill="none" stroke="currentColor" strokeWidth="1.4" />
            <path fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" d="M2.8 13.5c.6-2.6 2.6-4 5.2-4s4.6 1.4 5.2 4" />
          </svg>
          <span className="browser-profile-label">{profileName}</span>
        </button>
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
      {profileBarOpen && (
        <div className="browser-profile-bar" role="radiogroup" aria-label="Browser profile" data-browser-profile-bar>
          <span className="bp-bar-title">Browser profile</span>
          <button
            className="browser-profile-choice"
            role="radio"
            aria-checked={!profileId}
            disabled={profileBusy}
            data-profile-choice=""
            onClick={() => void chooseProfile(null)}
          >
            Ephemeral
          </button>
          {profiles.map((p) => (
            <button
              key={p.id}
              className="browser-profile-choice"
              role="radio"
              aria-checked={profileId === p.id}
              disabled={profileBusy}
              data-profile-choice={p.id}
              onClick={() => void chooseProfile(p.id)}
            >
              {p.name}
            </button>
          ))}
          <button className="browser-profile-manage" onClick={() => setBrowserSettingsOpen(true)}>
            {profiles.length === 0 ? 'Create a profile…' : 'Manage profiles…'}
          </button>
        </div>
      )}
      {agentNoticeOn && agentSwitch && (
        <div className="browser-agent-switch" role="status" data-agent-switch-to={agentSwitch.to}>
          <span className="browser-agent-switch-text">
            The agent brought « {tabLabel(state.tabs.find((t) => t.id === agentSwitch.to) ?? { title: '', url: '' })} » to the front.
          </span>
          {state.tabs.some((t) => t.id === agentSwitch.from) && (
            <button
              type="button"
              className="browser-agent-switch-back"
              onClick={() => void runTabOp(() => window.orchestra.browserTabActivate(workspaceId, agentSwitch.from))}
            >
              Back to « {tabLabel(state.tabs.find((t) => t.id === agentSwitch.from) ?? { title: '', url: '' })} »
            </button>
          )}
        </div>
      )}
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
