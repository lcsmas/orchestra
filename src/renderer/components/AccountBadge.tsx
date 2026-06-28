import { useEffect, useState } from 'react';
import { useStore } from '../store';
import type { UsageErrorKind, UsageSnapshot } from '../../shared/types';

// Compact per-workspace badge: the account a workspace logs in as plus that
// account's rolling 5h / 7d utilization, e.g. "acme · 5h 38% · 7d 28%". Colored
// by the hotter of the two windows. Data comes from the main-process poller
// (>=180s cached) via the renderer store — this component is pure presentation.

// Color by how close to the limit, mirroring UsageBars' thresholds.
function severityClass(pct: number): string {
  if (pct >= 90) return 'crit';
  if (pct >= 75) return 'warn';
  return 'ok';
}

function errorText(kind: UsageErrorKind | null): string {
  switch (kind) {
    case 'no-scope':
      return 'no usage scope';
    case 'rate-limited':
      return 'rate limited';
    case 'not-logged-in':
      return 'not logged in';
    case 'no-dir':
      return 'no config dir';
    default:
      return 'usage unavailable';
  }
}

function errorTitle(label: string, kind: UsageErrorKind | null): string {
  switch (kind) {
    case 'no-scope':
      return `${label}: this account's token lacks the user:profile OAuth scope, so usage can't be read`;
    case 'rate-limited':
      return `${label}: usage endpoint is rate-limiting us — will retry`;
    case 'not-logged-in':
      return `${label}: no login found in this account's config dir — use the Login button in account settings`;
    case 'no-dir':
      return `${label}: the account's config dir doesn't exist — check the path in account settings`;
    default:
      return `${label}: usage temporarily unavailable`;
  }
}

export function AccountBadge({ workspaceId }: { workspaceId: string }) {
  const mapping = useStore((s) => s.workspaceAccounts[workspaceId]);
  const usage = useStore((s) =>
    mapping?.accountId ? s.accountUsage[mapping.accountId] : undefined,
  );

  // No mapping computed yet → render nothing (avoids a flash before the first
  // workspace-accounts push lands).
  if (!mapping) return null;

  const label = mapping.label;

  // Workspace uses the default/stored login (no per-repo token override or no
  // configured account matched) — e.g. every scratch/orchestrator session. Show
  // that login's usage from the same snapshot the sidebar UsageBars reads, so
  // these rows get a badge too.
  if (!mapping.accountId) {
    return <DefaultLoginBadge label={label} />;
  }

  // Account matched but no usage status yet (first poll in flight).
  if (!usage) {
    return (
      <span className="account-badge pending" title={`${label}: fetching usage…`}>
        {label} · …
      </span>
    );
  }

  if (!usage.ok || !usage.data) {
    return (
      <span
        className={`account-badge err ${usage.errorKind ?? 'error'}`}
        title={errorTitle(label, usage.errorKind)}
      >
        {label} · {errorText(usage.errorKind)}
      </span>
    );
  }

  const data = usage.data;
  return (
    <UsageBadge
      label={label}
      fiveHour={data.fiveHour.utilization}
      sevenDay={data.sevenDay.utilization}
      extra={data.extraUtilization}
      fetchedAt={usage.fetchedAt}
    />
  );
}

// The default/stored login (scratch, orchestrator, or any unmatched workspace).
// Reuses the global usage snapshot the sidebar UsageBars consumes, so it stays
// in sync with that without a second poller.
function DefaultLoginBadge({ label }: { label: string }) {
  const [snap, setSnap] = useState<UsageSnapshot | null>(null);
  useEffect(() => {
    void window.orchestra.getUsage().then((u) => {
      if (u) setSnap(u);
    });
    return window.orchestra.onUsageUpdate((u) => setSnap(u));
  }, []);

  // No snapshot yet (e.g. API-key login where the OAuth usage endpoint is
  // unavailable) — show just the label so the row still names its login.
  if (!snap) {
    return (
      <span className="account-badge default" title="Uses the default Claude login (no account override)">
        {label}
      </span>
    );
  }
  return (
    <UsageBadge
      label={label}
      fiveHour={snap.fiveHour.utilization}
      sevenDay={snap.sevenDay.utilization}
      extra={null}
      fetchedAt={snap.fetchedAt}
    />
  );
}

function UsageBadge({
  label,
  fiveHour,
  sevenDay,
  extra,
  fetchedAt,
}: {
  label: string;
  fiveHour: number;
  sevenDay: number;
  extra: number | null;
  fetchedAt: number;
}) {
  const five = Math.max(0, Math.min(100, Math.round(fiveHour)));
  const seven = Math.max(0, Math.min(100, Math.round(sevenDay)));
  // The badge's color reflects the hotter window so a near-limit account reads
  // hot even if only one window is high.
  const sev = severityClass(Math.max(five, seven));
  const extraPct = extra != null ? ` · extra ${Math.round(extra)}%` : '';
  const ageMin = Math.floor((Date.now() - fetchedAt) / 60_000);
  const title =
    `${label} — Claude usage\n` +
    `5-hour window: ${five}%\n` +
    `7-day window: ${seven}%` +
    (extra != null ? `\nextra usage: ${Math.round(extra)}%` : '') +
    `\nas of ${ageMin <= 0 ? 'just now' : `${ageMin}m ago`}`;
  return (
    <span className={`account-badge usage ${sev}`} title={title}>
      <span className="account-badge-label">{label}</span>
      <span className="account-badge-sep">·</span>
      <span className="account-badge-metric">5h {five}%</span>
      <span className="account-badge-sep">·</span>
      <span className="account-badge-metric">7d {seven}%</span>
      {extraPct && <span className="account-badge-extra">{extraPct}</span>}
    </span>
  );
}
