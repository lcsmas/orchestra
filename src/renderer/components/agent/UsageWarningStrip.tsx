import React, { useEffect, useReducer } from 'react';
import type { UsageWarningState } from '../../../shared/types';

/**
 * Persistent amber strip above the composer while the account is APPROACHING
 * its usage limit (SDK `rate_limit_event` / `allowed_warning`).
 *
 * This is a STATE surface, not an event surface: the SDK re-emits the warning
 * on every API call while near the limit, and rendering each as a transcript
 * notice spammed one identical row per call. The strip appears at the first
 * warning, its percentage updates in place, and it disappears when the SDK
 * reports `allowed` again, when a real rejection takes over (that path has its
 * own surfaces — the `rate-limit` notice row and the prompt-queue banner), or
 * when the reported reset time passes (self-expiry below, for quiet sessions
 * that make no further API call after the reset).
 */
function UsageWarningStripImpl({ warning }: { warning?: UsageWarningState }) {
  const [, bump] = useReducer((c: number) => c + 1, 0);

  // Self-expiry: past `resetsAt` the condition is over even if no further SDK
  // event ever says so (a session idle across the reset makes no API call, so
  // no `allowed` arrives to clear the fold state). One timer to the boundary.
  const resetsAtMs = warning?.resetsAt !== undefined ? warning.resetsAt * 1000 : undefined;
  useEffect(() => {
    if (resetsAtMs === undefined) return;
    const ms = resetsAtMs - Date.now();
    if (ms <= 0) return;
    const t = setTimeout(bump, ms + 1_000);
    return () => clearTimeout(t);
  }, [resetsAtMs]);

  if (!warning) return null;
  if (resetsAtMs !== undefined && resetsAtMs <= Date.now()) return null;

  const pct = typeof warning.utilization === 'number' ? Math.round(warning.utilization * 100) : undefined;
  const reset =
    resetsAtMs !== undefined
      ? new Date(resetsAtMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      : undefined;

  return (
    <div className="av-usage-strip" role="status" data-usage-warning>
      <span className="av-usage-strip-dot" aria-hidden />
      <span className="av-usage-strip-text">
        Approaching usage limit
        {pct !== undefined ? (
          <>
            {' — '}
            <strong className="av-usage-strip-pct">{pct}%</strong> used
          </>
        ) : null}
      </span>
      {reset !== undefined ? <span className="av-usage-strip-reset">resets {reset}</span> : null}
    </div>
  );
}

export const UsageWarningStrip = React.memo(UsageWarningStripImpl);
