import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { AgentMcpServer } from '../../../shared/types';

/**
 * The `/mcp` manager popover (Option-D design): opened by SUBMITTING `/mcp`
 * in the composer (intercepted Orchestra-side, never sent to the model), it
 * anchors above the composer field like the skills autocomplete (`.av-ac`) and
 * lists the session's MCP servers — status dot, tool count, a reconnect action
 * for failed/needs-auth servers, and an enable/disable switch per server.
 *
 * Data path: mounts with the folded `session.mcpServers` as a SEED (last known
 * state, instant paint), then refreshes via `agentSdkMcpStatus` — which lazily
 * starts the SDK session if needed (CC's /mcp also runs in-session) and
 * broadcasts a `session/mcp` event so the store agrees. Toggle/reconnect
 * resolve with the refreshed list, so the popover never waits on a second
 * round-trip; their transcript-notice side effects render as quiet `mcp` /
 * `mcp-error` hairlines in the flow (the tracking half of Option D).
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
      return 'disabled';
    default:
      return s.status;
  }
}

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
  /** Server names with a toggle/reconnect in flight (rows disable themselves). */
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const rootRef = useRef<HTMLDivElement | null>(null);
  // Guards state updates after unmount: every IPC promise below outlives a
  // closed popover, and the refresh may take seconds when it boots the session.
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

  const runOp = useCallback(
    (name: string, op: () => Promise<AgentMcpServer[]>) => {
      setBusy((prev) => new Set(prev).add(name));
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
            const next = new Set(prev);
            next.delete(name);
            return next;
          });
        });
    },
    [],
  );

  const toggle = (s: AgentMcpServer) =>
    runOp(s.name, () =>
      window.orchestra.agentSdkMcpToggle(workspaceId, s.name, s.status === 'disabled'),
    );
  const reconnect = (s: AgentMcpServer) =>
    runOp(s.name, () => window.orchestra.agentSdkMcpReconnect(workspaceId, s.name));

  return (
    <div className="av-mcp" role="dialog" aria-label="MCP servers" ref={rootRef}>
      <div className="av-mcp-title">
        MCP servers
        {loading && <span className="av-mcp-loading">checking…</span>}
      </div>
      {servers && servers.length > 0 ? (
        servers.map((s) => {
          const isBusy = busy.has(s.name);
          const canRetry = s.status === 'failed' || s.status === 'needs-auth';
          const enabled = s.status !== 'disabled';
          return (
            <div key={s.name} className={`av-mcp-row ${enabled ? '' : 'av-mcp-row-off'}`}>
              <span className={`av-mcp-dot av-mcp-dot-${dotClass(s.status)}`} aria-hidden />
              <span className="av-mcp-name">{s.name}</span>
              <span className="av-mcp-meta" title={s.error ?? undefined}>
                {isBusy ? '…' : metaText(s)}
                {!isBusy && canRetry && (
                  <button
                    type="button"
                    className="av-mcp-retry"
                    onClick={() => reconnect(s)}
                    disabled={isBusy}
                  >
                    retry
                  </button>
                )}
              </span>
              <button
                type="button"
                role="switch"
                aria-checked={enabled}
                aria-label={`${enabled ? 'Disable' : 'Enable'} ${s.name}`}
                className={`av-mcp-switch ${enabled ? 'av-mcp-switch-on' : ''}`}
                onClick={() => toggle(s)}
                disabled={isBusy}
              >
                <span className="av-mcp-knob" aria-hidden />
              </button>
            </div>
          );
        })
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
      </div>
    </div>
  );
}
