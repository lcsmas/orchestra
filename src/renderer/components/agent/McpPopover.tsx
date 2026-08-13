import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { AgentMcpServer, AgentSession } from '../../../shared/types';

/**
 * The MCP health chip (Option-A indicator) — a small `◌ mcp · N` chip in the
 * session-controls bar that renders ONLY while at least one server needs
 * attention (`failed` / `needs-auth`); a healthy session shows nothing. Red
 * when anything failed, amber when it's auth-only. The native tooltip lists
 * the affected servers; clicking opens the /mcp popover (the remedy lives one
 * click from the signal). Reacts live with no polling: the folded
 * `session.mcpServers` refreshes on every request's init and on each
 * `session/mcp` broadcast.
 */
export function McpIndicator({
  session,
  onOpen,
}: {
  session: AgentSession | undefined;
  onOpen?: () => void;
}) {
  const attention = (session?.mcpServers ?? []).filter(
    (s) => s.status === 'failed' || s.status === 'needs-auth',
  );
  if (attention.length === 0) return null;
  const anyFailed = attention.some((s) => s.status === 'failed');
  const title = [
    ...attention.map((s) => `${s.name} — ${s.status === 'failed' ? 'failed' : 'needs auth'}`),
    'Click to open /mcp',
  ].join('\n');
  return (
    <button
      type="button"
      className={`av-mcp-ind ${anyFailed ? 'av-mcp-ind-failed' : ''}`}
      onClick={onOpen}
      title={title}
      aria-label={`${attention.length} MCP server${attention.length === 1 ? '' : 's'} need${attention.length === 1 ? 's' : ''} attention`}
    >
      <span className="av-mcp-ind-dot" aria-hidden />
      mcp · {attention.length}
    </button>
  );
}

/**
 * The `/mcp` manager popover (Option-A-v2 design): opened by SUBMITTING `/mcp`
 * in the composer (intercepted Orchestra-side, never sent to the model), it
 * anchors above the composer field like the skills autocomplete (`.av-ac`).
 *
 * Enabled servers render as a flat list — status dot, tool count, an
 * enable/disable switch, and a **hover-revealed ↻ reconnect** on every row
 * (always visible, attention-tinted, on failed / needs-auth rows). Disabled
 * servers collapse into a "▸ disabled · N" section (collapsed by default) so
 * a long tail of switched-off servers is one quiet line.
 *
 * **↻ on a `needs-auth` server runs the real OAuth flow** (parity with Claude
 * Code's /mcp authenticate): `agentSdkMcpAuth` opens the provider's
 * authorization link in the SYSTEM browser and pends until the fresh token
 * lands and the CLI reconnects the server (or ~3 min timeout) — the row shows
 * "waiting for authentication…" meanwhile. ↻ elsewhere is a plain reconnect.
 *
 * Data path: mounts with the folded `session.mcpServers` as a SEED (instant
 * paint), then refreshes via `agentSdkMcpStatus` — which lazily starts the SDK
 * session if needed and broadcasts `session/mcp` so the store agrees. Every op
 * resolves with the refreshed list, and its outcome lands as a quiet
 * `mcp`/`mcp-error` hairline notice in the transcript (the tracking half).
 *
 * CSS contract: anchors to `.av-composer-field`, which MUST keep
 * `position: relative` and must never gain `overflow: hidden` — the same
 * fragility as `.av-ac` (see agent-view-design.md).
 */

/** Dot modifier for a server status (open-ended: unknown statuses → 'off'). */
function dotClass(status: string): string {
  switch (status) {
    case 'connected':
      return 'ok';
    case 'pending':
      return 'pending';
    case 'failed':
    case 'needs-auth':
      return 'bad';
    default:
      return 'off';
  }
}

/** Meta line for a server row — "12 tools", "failed", "needs auth", … */
function metaText(s: AgentMcpServer): string {
  switch (s.status) {
    case 'connected':
      return s.toolCount !== undefined ? `${s.toolCount} tool${s.toolCount === 1 ? '' : 's'}` : 'connected';
    case 'pending':
      return 'connecting…';
    case 'failed':
      return 'failed';
    case 'needs-auth':
      return 'needs auth';
    case 'disabled':
      return '';
    default:
      return s.status;
  }
}

/** What kind of operation is in flight for a server (drives the row state). */
type Busy = 'op' | 'auth';

/** Sentinel key in the `busy` map for the popover-wide refresh (which restarts
 *  the session rather than touching one server). Not a real server name, and
 *  `#` can't collide with one. */
const REFRESH_KEY = '#refresh';

export function McpPopover({
  workspaceId,
  seed,
  onClose,
}: {
  workspaceId: string;
  /** Last known server list from the folded session (instant paint while the
   *  live status request — which may lazily boot the session — is in flight). */
  seed?: AgentMcpServer[];
  onClose: () => void;
}) {
  const [servers, setServers] = useState<AgentMcpServer[] | null>(seed ?? null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showDisabled, setShowDisabled] = useState(false);
  /** Server name → in-flight operation ('auth' pends for the whole OAuth flow). */
  const [busy, setBusy] = useState<Readonly<Record<string, Busy>>>({});
  const rootRef = useRef<HTMLDivElement | null>(null);
  // Guards state updates after unmount: the auth IPC promise can outlive a
  // closed popover by minutes.
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true; // re-set on strict-mode remount (cleanup ran between)
    return () => {
      alive.current = false;
    };
  }, []);

  // Refresh on open. Errors render inline (the session may fail to boot).
  useEffect(() => {
    let cancelled = false;
    window.orchestra
      .agentSdkMcpStatus(workspaceId)
      .then((list) => {
        if (cancelled) return;
        setServers(list);
        setLoading(false);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  // Esc closes (capture so the CodeMirror/vim Esc handling never eats it while
  // the popover is up); click outside the popover closes too.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && e.target instanceof Node && !rootRef.current.contains(e.target)) {
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('mousedown', onDown);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('mousedown', onDown);
    };
  }, [onClose]);

  const runOp = useCallback((name: string, kind: Busy, op: () => Promise<AgentMcpServer[]>) => {
    setBusy((prev) => ({ ...prev, [name]: kind }));
    setError(null);
    op()
      .then((list) => {
        if (alive.current) setServers(list);
      })
      .catch((e) => {
        if (alive.current) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!alive.current) return;
        setBusy((prev) => {
          const next = { ...prev };
          delete next[name];
          return next;
        });
      });
  }, []);

  const toggle = (s: AgentMcpServer) =>
    runOp(s.name, 'op', () =>
      window.orchestra.agentSdkMcpToggle(workspaceId, s.name, s.status === 'disabled'),
    );
  /** The ↻ action: OAuth flow for needs-auth, plain reconnect otherwise. */
  const reconnect = (s: AgentMcpServer) =>
    s.status === 'needs-auth'
      ? runOp(s.name, 'auth', () => window.orchestra.agentSdkMcpAuth(workspaceId, s.name))
      : runOp(s.name, 'op', () => window.orchestra.agentSdkMcpReconnect(workspaceId, s.name));

  /** Re-enumerate from a fresh CLI. This is the ONLY way to pick up
   *  account-level connector changes (claude.ai connectors are resolved once
   *  at process start), and it is NOT what relaunching Orchestra does — the
   *  detached keeper survives that, so a stale list can outlive every app
   *  restart. Preserves the conversation; rejects while a turn is running. */
  const refresh = () =>
    runOp(REFRESH_KEY, 'op', () => window.orchestra.agentSdkMcpRefresh(workspaceId));

  const all = servers ?? [];
  const enabled = all.filter((s) => s.status !== 'disabled');
  const disabled = all.filter((s) => s.status === 'disabled');
  const refreshing = busy[REFRESH_KEY] !== undefined;

  const renderRow = (s: AgentMcpServer) => {
    const b = busy[s.name];
    const isOff = s.status === 'disabled';
    const attention = s.status === 'failed' || s.status === 'needs-auth';
    return (
      <div key={s.name} className={`av-mcp-row ${isOff ? 'av-mcp-row-off' : ''}`}>
        <span className={`av-mcp-dot av-mcp-dot-${dotClass(s.status)}`} aria-hidden />
        <span className="av-mcp-name">{s.name}</span>
        <span className="av-mcp-meta" title={s.error ?? undefined}>
          {b === 'auth' ? (
            <span className="av-mcp-authwait">
              <span className="av-mcp-spin" aria-hidden /> waiting for authentication…
            </span>
          ) : b === 'op' ? (
            '…'
          ) : (
            metaText(s)
          )}
        </span>
        {!isOff && !b && (
          <button
            type="button"
            className={`av-mcp-reconnect ${attention ? 'av-mcp-reconnect-attn' : ''}`}
            title={s.status === 'needs-auth' ? `Authenticate ${s.name}` : `Reconnect ${s.name}`}
            aria-label={s.status === 'needs-auth' ? `Authenticate ${s.name}` : `Reconnect ${s.name}`}
            onClick={() => reconnect(s)}
          >
            <svg viewBox="0 0 16 16" width="11" height="11" aria-hidden>
              <path
                d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 1.5v3h-3"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        )}
        <button
          type="button"
          role="switch"
          aria-checked={!isOff}
          aria-label={`${isOff ? 'Enable' : 'Disable'} ${s.name}`}
          className={`av-mcp-switch ${isOff ? '' : 'av-mcp-switch-on'}`}
          onClick={() => toggle(s)}
          disabled={!!b}
        >
          <span className="av-mcp-knob" aria-hidden />
        </button>
      </div>
    );
  };

  return (
    <div className="av-mcp" role="dialog" aria-label="MCP servers" ref={rootRef}>
      <div className="av-mcp-title">
        MCP servers
        {loading && <span className="av-mcp-loading">checking…</span>}
      </div>
      {all.length > 0 ? (
        <>
          {enabled.map(renderRow)}
          {disabled.length > 0 && (
            <>
              <div className="av-mcp-sep" aria-hidden />
              <button
                type="button"
                className="av-mcp-sect"
                aria-expanded={showDisabled}
                onClick={() => setShowDisabled((v) => !v)}
              >
                <span className="av-mcp-sect-chev">{showDisabled ? '▾' : '▸'}</span>
                disabled <span className="av-mcp-sect-n">· {disabled.length}</span>
              </button>
              {showDisabled && disabled.map(renderRow)}
            </>
          )}
        </>
      ) : (
        <div className="av-mcp-empty">
          {loading
            ? 'Checking MCP servers…'
            : 'No MCP servers configured — add them in ~/.claude.json or the project’s .mcp.json.'}
        </div>
      )}
      {error && <div className="av-mcp-error">{error}</div>}
      <div className="av-mcp-hint">
        from ~/.claude.json · .mcp.json — <kbd>Esc</kbd> to close
        <button
          type="button"
          className="av-mcp-refresh"
          onClick={refresh}
          disabled={refreshing}
          title={
            'Restart the agent process and re-enumerate MCP servers.\n' +
            'Needed to pick up claude.ai connectors added/removed on your account — ' +
            'those are read once at process start, and the process survives an app restart.\n' +
            'Your conversation is preserved.'
          }
        >
          {refreshing ? (
            <>
              <span className="av-mcp-spin" aria-hidden /> restarting…
            </>
          ) : (
            're-enumerate'
          )}
        </button>
      </div>
    </div>
  );
}
