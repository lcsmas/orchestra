import { useStore } from '../store';
import type { UsageErrorKind, UsageSnapshot } from '../../shared/types';

// The account a repo's workspaces log in as, shown discreetly next to the repo
// name in the sidebar header — it's a repo-wide setting (RepoEntry.accountId),
// not a per-workspace one. Just the account label, tinted by that account's
// rolling 5h / 7d utilization; the numbers live in the title. Data comes from
// the main-process poller (>=180s cached) via the renderer store. Repos with no
// account override fall back to Orchestra's default login, shown the same way
// (label + usage tint) but sourced from the global `~/.claude` poller.

// Clamp a raw 0–100 utilization to an integer percent for display.
function clampPct(util: number): number {
  return Math.max(0, Math.min(100, Math.round(util)));
}

// "just now" / "12m ago" — coarse age for the usage tooltip.
function ageText(fetchedAt: number): string {
  const ageMin = Math.floor((Date.now() - fetchedAt) / 60_000);
  return ageMin <= 0 ? 'just now' : `${ageMin}m ago`;
}

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

export function RepoAccountBadge({ repoPath }: { repoPath: string }) {
  const accountId = useStore(
    (s) => s.repos.find((r) => r.path === repoPath)?.accountId ?? null,
  );
  const label = useStore((s) =>
    accountId ? (s.accounts.find((a) => a.id === accountId)?.label ?? null) : null,
  );
  const usage = useStore((s) => (accountId ? s.accountUsage[accountId] : undefined));
  const globalUsage = useStore((s) => s.globalUsage);

  // Repo has no account override (or it points at a deleted account) → its
  // workspaces use Orchestra's default login. Show it the same way a pinned
  // account is shown, tinted by the default login's own rolling usage.
  if (!accountId || !label) return <DefaultLoginBadge usage={globalUsage} />;

  // First poll still in flight.
  if (!usage) {
    return (
      <span className="account-badge inline pending" title={`${label}: fetching usage…`}>
        {label}
      </span>
    );
  }

  if (!usage.ok || !usage.data) {
    return (
      <span
        className={`account-badge inline err ${usage.errorKind ?? 'error'}`}
        title={errorTitle(label, usage.errorKind)}
      >
        {label}
      </span>
    );
  }

  const data = usage.data;
  const five = clampPct(data.fiveHour.utilization);
  const seven = clampPct(data.sevenDay.utilization);
  // Tint by the hotter window so a near-limit account reads hot even if only one
  // window is high.
  const sev = severityClass(Math.max(five, seven));
  const extra = data.extraUtilization;
  const title =
    `${label} — Claude usage (repo-wide login)\n` +
    `5-hour window: ${five}%\n` +
    `7-day window: ${seven}%` +
    (extra != null ? `\nextra usage: ${Math.round(extra)}%` : '') +
    `\nas of ${ageText(usage.fetchedAt)}`;
  return (
    <span className={`account-badge inline usage ${sev}`} title={title}>
      {label}
    </span>
  );
}

// The repo-header badge for Orchestra's default login. Mirrors the pinned-
// account badge but reads the global `~/.claude` usage poller (a bare
// UsageSnapshot — no error/extra fields). Null usage means the first global
// fetch hasn't landed yet.
const DEFAULT_LOGIN_LABEL = 'default login';

function DefaultLoginBadge({ usage }: { usage: UsageSnapshot | null }) {
  if (!usage) {
    return (
      <span
        className="account-badge inline pending"
        title={`${DEFAULT_LOGIN_LABEL}: fetching usage…`}
      >
        {DEFAULT_LOGIN_LABEL}
      </span>
    );
  }

  const five = clampPct(usage.fiveHour.utilization);
  const seven = clampPct(usage.sevenDay.utilization);
  const sev = severityClass(Math.max(five, seven));
  const title =
    `${DEFAULT_LOGIN_LABEL} — Claude usage (Orchestra's default login)\n` +
    `5-hour window: ${five}%\n` +
    `7-day window: ${seven}%` +
    `\nas of ${ageText(usage.fetchedAt)}`;
  return (
    <span className={`account-badge inline usage ${sev}`} title={title}>
      {DEFAULT_LOGIN_LABEL}
    </span>
  );
}
