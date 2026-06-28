import { useStore } from '../store';
import type { AccountUsageStatus, UsageErrorKind } from '../../shared/types';

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
    case 'no-token':
      return 'no token';
    default:
      return 'usage unavailable';
  }
}

function errorTitle(label: string, kind: UsageErrorKind | null): string {
  switch (kind) {
    case 'no-scope':
      return `${label}: this token lacks the user:profile OAuth scope, so usage can't be read`;
    case 'rate-limited':
      return `${label}: usage endpoint is rate-limiting us — will retry`;
    case 'no-token':
      return `${label}: the account's \${VAR} token isn't set in Orchestra's environment`;
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
  // configured account matched). Show just the label, no usage — the main
  // sidebar UsageBars already covers the default login's usage.
  if (!mapping.accountId) {
    return (
      <span className="account-badge default" title="Uses the default Claude login (no account override)">
        {label}
      </span>
    );
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

  return <AccountUsageBadge label={label} status={usage} />;
}

function AccountUsageBadge({ label, status }: { label: string; status: AccountUsageStatus }) {
  const data = status.data!;
  const five = Math.max(0, Math.min(100, Math.round(data.fiveHour.utilization)));
  const seven = Math.max(0, Math.min(100, Math.round(data.sevenDay.utilization)));
  // The badge's color reflects the hotter window so a near-limit account reads
  // hot even if only one window is high.
  const sev = severityClass(Math.max(five, seven));
  const extra =
    data.extraUtilization != null
      ? ` · extra ${Math.round(data.extraUtilization)}%`
      : '';
  const ageMin = Math.floor((Date.now() - status.fetchedAt) / 60_000);
  const title =
    `${label} — Claude usage\n` +
    `5-hour window: ${five}%\n` +
    `7-day window: ${seven}%` +
    (data.extraUtilization != null ? `\nextra usage: ${Math.round(data.extraUtilization)}%` : '') +
    `\nas of ${ageMin <= 0 ? 'just now' : `${ageMin}m ago`}`;
  return (
    <span className={`account-badge usage ${sev}`} title={title}>
      <span className="account-badge-label">{label}</span>
      <span className="account-badge-sep">·</span>
      <span className="account-badge-metric">5h {five}%</span>
      <span className="account-badge-sep">·</span>
      <span className="account-badge-metric">7d {seven}%</span>
      {extra && <span className="account-badge-extra">{extra}</span>}
    </span>
  );
}
