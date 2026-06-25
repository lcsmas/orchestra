import { useEffect, useState } from 'react';
import type { UsageSnapshot } from '../../shared/types';

// Two slim progress bars showing the signed-in Claude account's rolling usage
// limits: the 5-hour session window and the 7-day weekly window. The data is
// the same one Claude Code's own `/usage` view reads, polled by the main
// process (see src/main/usage.ts) and pushed here over `usage:update`.

// Color the fill by how close the window is to its limit. Mirrors the
// "normal / warning / critical" severity Claude's usage endpoint reports, but
// derived from the percentage so we don't depend on the server's thresholds.
function severityVar(pct: number): string {
  if (pct >= 90) return 'var(--red)';
  if (pct >= 75) return 'var(--yellow)';
  return 'var(--accent)';
}

// "resets in 3h 12m" / "resets in 2d 4h" — a compact relative countdown. We
// keep it coarse (two units max) since the windows are long and the bars are
// glanceable, not precise timers.
function formatResetsIn(resetsAt: string, now: number): string {
  const target = Date.parse(resetsAt);
  if (!Number.isFinite(target)) return '';
  const ms = target - now;
  if (ms <= 0) return 'resets now';
  const mins = Math.floor(ms / 60_000);
  const days = Math.floor(mins / 1440);
  const hours = Math.floor((mins % 1440) / 60);
  const m = mins % 60;
  if (days > 0) return `resets in ${days}d ${hours}h`;
  if (hours > 0) return `resets in ${hours}h ${m}m`;
  return `resets in ${m}m`;
}

function UsageBar({
  label,
  title,
  window,
  now,
}: {
  label: string;
  title: string;
  window: { utilization: number; resetsAt: string };
  now: number;
}) {
  const pct = Math.max(0, Math.min(100, Math.round(window.utilization)));
  const resets = formatResetsIn(window.resetsAt, now);
  return (
    <div className="usage-bar" title={`${title}${resets ? ` — ${resets}` : ''}`}>
      <div className="usage-bar-head">
        <span className="usage-bar-label">{label}</span>
        <span className="usage-bar-pct">{pct}%</span>
      </div>
      <div className="usage-bar-track">
        <div
          className="usage-bar-fill"
          style={{ width: `${pct}%`, background: severityVar(pct) }}
        />
      </div>
    </div>
  );
}

export function UsageBars() {
  const [usage, setUsage] = useState<UsageSnapshot | null>(null);
  // Tick once a minute so the "resets in …" countdown stays roughly current
  // between the main process's 60s usage polls.
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    void window.orchestra.getUsage().then((u) => {
      if (u) setUsage(u);
    });
    return window.orchestra.onUsageUpdate((u) => setUsage(u));
  }, []);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);

  // Hidden entirely until the first successful fetch — e.g. for users signed in
  // with a raw API key, where the OAuth usage endpoint isn't available.
  if (!usage) return null;

  return (
    <div className="usage-bars">
      <UsageBar
        label="5h"
        title="Claude usage — 5-hour session window"
        window={usage.fiveHour}
        now={now}
      />
      <UsageBar
        label="7d"
        title="Claude usage — 7-day weekly window"
        window={usage.sevenDay}
        now={now}
      />
    </div>
  );
}
