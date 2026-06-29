import { useEffect, useState } from 'react';
import { useStore } from '../store';

// Two slim progress bars showing the active workspace's account rolling usage
// limits: the 5-hour session window and the 7-day weekly window. When the
// active workspace has a pinned account, the data comes from the per-account
// poller (src/main/account-usage.ts, pushed via accounts:usageUpdate). When
// the workspace uses the default login (no pinned account), it falls back to
// the global poller (src/main/usage.ts, pushed via usage:update).

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
  accountLabel,
}: {
  label: string;
  title: string;
  window: { utilization: number; resetsAt: string };
  now: number;
  accountLabel?: string;
}) {
  const pct = Math.max(0, Math.min(100, Math.round(window.utilization)));
  const resets = formatResetsIn(window.resetsAt, now);
  return (
    <div className="usage-bar" title={`${title}${resets ? ` — ${resets}` : ''}`}>
      <div className="usage-bar-head">
        <span className="usage-bar-label">{label}</span>
        {accountLabel && <span className="usage-bars-account">{accountLabel}</span>}
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
  // Atomic selectors, not `useStore()`: subscribing to the whole store would
  // re-render this component on every store mutation — including the very high
  // frequency `agent:tool` tick and the stats/PR polls — even though it only
  // reads these four slices. Each selector re-renders only when its slice
  // changes by Object.is.
  //
  // globalUsage is the fallback for workspaces on the default login (no pinned
  // account). It lives in the store (hydrated on load, kept fresh by
  // `usage:update`) so the repo-header default-login badge shares the source.
  const activeId = useStore((s) => s.activeId);
  const workspaceAccounts = useStore((s) => s.workspaceAccounts);
  const accountUsage = useStore((s) => s.accountUsage);
  const globalUsage = useStore((s) => s.globalUsage);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);

  const activeAccount = activeId ? workspaceAccounts[activeId] : null;
  const accountId = activeAccount?.accountId ?? null;
  const perAccountStatus = accountId ? accountUsage[accountId] : null;

  let fiveHour: { utilization: number; resetsAt: string } | null = null;
  let sevenDay: { utilization: number; resetsAt: string } | null = null;
  let accountLabel: string | null = null;

  if (accountId !== null) {
    if (perAccountStatus?.ok && perAccountStatus.data) {
      fiveHour = perAccountStatus.data.fiveHour;
      sevenDay = perAccountStatus.data.sevenDay;
      accountLabel = activeAccount?.label ?? null;
    }
    // No data yet for this account → hide bars rather than show the wrong account.
  } else if (globalUsage) {
    fiveHour = globalUsage.fiveHour;
    sevenDay = globalUsage.sevenDay;
    // Surface the default login by name too, the same as a pinned account, so
    // the bars always say which login they're measuring.
    accountLabel = activeAccount?.label ?? 'default login';
  }

  if (!fiveHour || !sevenDay) return null;

  return (
    <div className="usage-bars">
      <UsageBar
        label="5h"
        title={`Claude usage${accountLabel ? ` (${accountLabel})` : ''} — 5-hour session window`}
        window={fiveHour}
        now={now}
        accountLabel={accountLabel ?? undefined}
      />
      <UsageBar
        label="7d"
        title={`Claude usage${accountLabel ? ` (${accountLabel})` : ''} — 7-day weekly window`}
        window={sevenDay}
        now={now}
      />
    </div>
  );
}
