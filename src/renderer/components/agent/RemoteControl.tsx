// Remote Control toggle for the structured agent view — Orchestra's parity with
// Claude Code's `/remote-control`. Enabling opens a bridge to Anthropic's relay
// (via the SDK's `enableRemoteControl(true)`) so the session can be driven from
// claude.ai/code or the Claude mobile app; the returned `session_url` is the
// shareable link, surfaced here exactly like the CC app ("Control this session
// from claude.ai/code or the Claude mobile app").
//
// State is fully server-owned: this component only fires the IPC and reflects
// `session.remoteControl` (folded from `session/remote-control` events), so it
// survives a view remount and mirrors a change made from another surface.

import React from 'react';
import type { AgentSession, RemoteControlState } from '../../../shared/types';

function icon(paths: React.ReactNode, viewBox = '0 0 16 16') {
  return (
    <svg
      width="14"
      height="14"
      viewBox={viewBox}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths}
    </svg>
  );
}

// A broadcast / signal glyph — concentric arcs over a dot. (Even-armed / arced
// so it doesn't read as wifi-only; paired with the "Remote control" label.)
const broadcast = icon(
  <>
    <circle cx="8" cy="8" r="1.3" fill="currentColor" stroke="none" />
    <path d="M5.2 10.8a4 4 0 0 1 0-5.6M10.8 5.2a4 4 0 0 1 0 5.6" />
    <path d="M3.4 12.6a6.6 6.6 0 0 1 0-9.2M12.6 3.4a6.6 6.6 0 0 1 0 9.2" opacity="0.6" />
  </>,
);
const copyGlyph = icon(
  <>
    <rect x="5.5" y="5.5" width="7.5" height="7.5" rx="1.5" />
    <path d="M10.5 5.5V4A1.5 1.5 0 0 0 9 2.5H4A1.5 1.5 0 0 0 2.5 4v5A1.5 1.5 0 0 0 4 10.5h1.5" />
  </>,
);
const openGlyph = icon(
  <>
    <path d="M9.5 3h3.5v3.5" />
    <path d="M13 3 7.5 8.5" />
    <path d="M12 9.5V12a1.5 1.5 0 0 1-1.5 1.5h-6A1.5 1.5 0 0 1 3 12V6a1.5 1.5 0 0 1 1.5-1.5H7" />
  </>,
);

/** Whether the state means "connected and remotely controllable". */
function isActive(rc: RemoteControlState | undefined): boolean {
  return !!rc?.active;
}

export function RemoteControl({
  workspaceId,
  session,
}: {
  workspaceId: string;
  session: AgentSession | undefined;
}) {
  const rc = session?.remoteControl;
  const active = isActive(rc);
  const pending = !!rc?.pending;
  const [open, setOpen] = React.useState(false);
  const [copied, setCopied] = React.useState(false);
  const rootRef = React.useRef<HTMLDivElement | null>(null);

  // Auto-open the popover the moment it becomes active (so the URL is shown
  // without a second click), and close it when it goes inactive.
  const prevActive = React.useRef(active);
  React.useEffect(() => {
    if (active && !prevActive.current) setOpen(true);
    if (!active) setOpen(false);
    prevActive.current = active;
  }, [active]);

  // Dismiss the popover on outside click / Escape.
  React.useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const enable = (enabled: boolean) => {
    void window.orchestra.agentSdkSetRemoteControl(workspaceId, enabled);
  };

  const onTriggerClick = () => {
    if (pending) return;
    if (active) setOpen((v) => !v); // toggle the detail popover
    else enable(true); // turn it on
  };

  const url = rc?.sessionUrl;
  const copyUrl = async () => {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      /* clipboard denied — ignore, the URL is still shown */
    }
  };

  return (
    <div className="av-rc" ref={rootRef}>
      <button
        type="button"
        className={`av-menu-trigger av-rc-trigger${active ? ' av-rc-active' : ''}`}
        aria-pressed={active}
        aria-haspopup={active ? 'dialog' : undefined}
        aria-expanded={active ? open : undefined}
        disabled={pending}
        title={
          active
            ? 'Remote Control is on — control this session from claude.ai/code or the Claude mobile app'
            : 'Enable Remote Control to drive this session from claude.ai/code or the Claude mobile app'
        }
        onClick={onTriggerClick}
      >
        <span className={`av-rc-dot${active ? ' av-rc-dot-on' : ''}`} aria-hidden="true" />
        {broadcast}
        <span className="av-rc-label">Remote control</span>
      </button>

      {rc?.error && !active && (
        <span className="av-rc-error" role="status" title={rc.error}>
          {rc.error}
        </span>
      )}

      {active && open && (
        <div className="av-rc-panel" role="dialog" aria-label="Remote Control">
          <div className="av-rc-panel-head">
            <span className="av-rc-dot av-rc-dot-on" aria-hidden="true" />
            <span className="av-rc-panel-title">Remote Control is on</span>
          </div>
          <p className="av-rc-panel-desc">
            Control this session from claude.ai/code or the Claude mobile app.
          </p>
          {url ? (
            <div className="av-rc-url-row">
              <code className="av-rc-url" title={url}>
                {url}
              </code>
              <button
                type="button"
                className="av-rc-iconbtn"
                title={copied ? 'Copied' : 'Copy link'}
                onClick={() => void copyUrl()}
              >
                {copyGlyph}
              </button>
              <button
                type="button"
                className="av-rc-iconbtn"
                title="Open in browser"
                onClick={() => void window.orchestra.openExternal(url)}
              >
                {openGlyph}
              </button>
            </div>
          ) : (
            <p className="av-rc-panel-desc av-rc-muted">Connecting…</p>
          )}
          {copied && (
            <span className="av-rc-copied" role="status">
              Link copied
            </span>
          )}
          {rc?.error && (
            <span className="av-rc-error" role="status" title={rc.error}>
              {rc.error}
            </span>
          )}
          <button
            type="button"
            className="av-btn av-btn-ghost av-rc-disconnect"
            disabled={pending}
            onClick={() => enable(false)}
          >
            Disconnect
          </button>
        </div>
      )}
    </div>
  );
}
