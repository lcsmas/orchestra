import { useEffect, useRef, useState } from 'react';
import { useStore } from '../store';
import type { UsageErrorKind, UsageWindowDetail } from '../../shared/types';

// Two slim progress bars showing the active workspace's account rolling usage
// limits: the 5-hour session window and the 7-day weekly window. When the
// active workspace has a pinned account, the data comes from the per-account
// poller (src/main/account-usage.ts, pushed via accounts:usageUpdate). When
// the workspace uses the default login (no pinned account), it falls back to
// the global poller (src/main/usage.ts, pushed via usage:update).
//
// On hover the strip lifts a popover listing EVERY configured account plus the
// default login, each with its own 5h/7d bars — so you can compare usage across
// all logins without switching workspaces. The panel is pure render: it reads
// the same store slices the per-account poller already keeps fresh, so it adds
// no IPC or polling of its own.

// Color the fill by how close the window is to its limit. Mirrors the
// "normal / warning / critical" severity Claude's usage endpoint reports, but
// derived from the percentage so we don't depend on the server's thresholds.
function severityVar(pct: number): string {
  if (pct >= 90) return 'var(--red)';
  if (pct >= 75) return 'var(--yellow)';
  return 'var(--accent)';
}

// Clamp a raw 0–100 utilization to an integer percent for display.
function clampPct(util: number): number {
  return Math.max(0, Math.min(100, Math.round(util)));
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

// Short reason text for an account whose usage can't be read — mirrors the
// vocabulary used on the sidebar AccountBadge so the two stay consistent.
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
  const pct = clampPct(window.utilization);
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

// One compact bar inside a panel row: a tiny window label (5H/7D), the track,
// and the percent — laid out on a single grid line so rows stack tightly.
function MiniBar({
  label,
  window,
  now,
}: {
  label: string;
  window: UsageWindowDetail;
  now: number;
}) {
  const pct = clampPct(window.utilization);
  const resets = formatResetsIn(window.resetsAt, now);
  return (
    <div className="usage-row-bar" title={resets || undefined}>
      <span className="usage-row-bar-label">{label}</span>
      <div className="usage-bar-track">
        <div
          className="usage-bar-fill"
          style={{ width: `${pct}%`, background: severityVar(pct) }}
        />
      </div>
      <span className="usage-row-pct">{pct}%</span>
    </div>
  );
}

// State of one account in the all-accounts panel, derived from its usage slice.
type RowState =
  | { kind: 'ok'; fiveHour: UsageWindowDetail; sevenDay: UsageWindowDetail; expired?: boolean }
  | { kind: 'pending' }
  | { kind: 'error'; errorKind: UsageErrorKind | null };

interface UsageRow {
  key: string;
  label: string;
  isActive: boolean;
  /** Hotter of the two windows, used to sort near-limit accounts to the top;
   *  -1 for rows with no readable usage so they sink below the live ones. */
  hotness: number;
  state: RowState;
}

function UsageRowView({ row, now }: { row: UsageRow; now: number }) {
  const cls = `usage-bars-row${row.isActive ? ' active' : ''}${
    row.state.kind === 'error' ? ' err' : ''
  }`;
  return (
    <div className={cls}>
      <div className="usage-bars-row-head">
        <span className="usage-bars-row-name">{row.label}</span>
        {row.state.kind === 'pending' && (
          <span className="usage-bars-row-status">fetching usage…</span>
        )}
        {row.state.kind === 'error' && (
          <span className="usage-bars-row-status">{errorText(row.state.errorKind)}</span>
        )}
        {row.state.kind === 'ok' && row.state.expired && (
          <span className="usage-bars-row-status">token expired</span>
        )}
      </div>
      {row.state.kind === 'ok' && (
        <>
          <MiniBar label="5h" window={row.state.fiveHour} now={now} />
          <MiniBar label="7d" window={row.state.sevenDay} now={now} />
        </>
      )}
    </div>
  );
}

export function UsageBars() {
  // Atomic selectors, not `useStore()`: subscribing to the whole store would
  // re-render this component on every store mutation — including the very high
  // frequency `agent:tool` tick and the stats/PR polls — even though it only
  // reads these slices. Each selector re-renders only when its slice changes by
  // Object.is.
  //
  // globalUsage is the fallback for workspaces on the default login (no pinned
  // account). It lives in the store (hydrated on load, kept fresh by
  // `usage:update`) so the repo-header default-login badge shares the source.
  const activeId = useStore((s) => s.activeId);
  const workspaceAccounts = useStore((s) => s.workspaceAccounts);
  const accountUsage = useStore((s) => s.accountUsage);
  const globalUsage = useStore((s) => s.globalUsage);
  const accounts = useStore((s) => s.accounts);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);

  // Hover-to-expand panel. A short close delay keeps the panel from flickering
  // shut when the cursor crosses the small gap between the strip and the popover.
  const [open, setOpen] = useState(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const openPanel = () => {
    if (closeTimer.current) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
    setOpen(true);
  };
  const closePanel = () => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    closeTimer.current = setTimeout(() => setOpen(false), 120);
  };
  useEffect(() => () => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
  }, []);

  const activeAccount = activeId ? workspaceAccounts[activeId] : null;
  const accountId = activeAccount?.accountId ?? null;
  const perAccountStatus = accountId ? accountUsage[accountId] : null;

  let fiveHour: { utilization: number; resetsAt: string } | null = null;
  let sevenDay: { utilization: number; resetsAt: string } | null = null;
  let accountLabel: string | null = null;

  if (accountId !== null) {
    // Show bars whenever we have data — including a cached snapshot kept across
    // an expired token (perAccountStatus.expired). The hover panel row carries
    // the "token expired" note; the strip just shows the last-known consumption.
    if (perAccountStatus?.data) {
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

  // Build the all-accounts panel rows: one per configured account, plus the
  // default login. The active workspace's login is flagged and floated to the
  // top; the rest sort by their hotter window so a near-limit account is the
  // first thing you see.
  const rows: UsageRow[] = [];
  for (const a of accounts) {
    const u = accountUsage[a.id];
    const isActive = accountId === a.id;
    if (!u) {
      rows.push({ key: a.id, label: a.label, isActive, hotness: -1, state: { kind: 'pending' } });
    } else if (!u.data) {
      // No cached usage to show → a hard error (no dir / scope / login). An
      // expired token keeps its last-good data, so it renders as an 'ok' row
      // with the 'token expired' note instead of hiding the bars.
      rows.push({
        key: a.id,
        label: a.label,
        isActive,
        hotness: -1,
        state: { kind: 'error', errorKind: u.errorKind },
      });
    } else {
      rows.push({
        key: a.id,
        label: a.label,
        isActive,
        hotness: Math.max(u.data.fiveHour.utilization, u.data.sevenDay.utilization),
        state: { kind: 'ok', fiveHour: u.data.fiveHour, sevenDay: u.data.sevenDay, expired: u.expired },
      });
    }
  }
  const defaultActive = accountId === null;
  if (!globalUsage) {
    rows.push({
      key: '__default__',
      label: 'default login',
      isActive: defaultActive,
      hotness: -1,
      state: { kind: 'pending' },
    });
  } else {
    rows.push({
      key: '__default__',
      label: 'default login',
      isActive: defaultActive,
      hotness: Math.max(globalUsage.fiveHour.utilization, globalUsage.sevenDay.utilization),
      state: { kind: 'ok', fiveHour: globalUsage.fiveHour, sevenDay: globalUsage.sevenDay },
    });
  }
  rows.sort(
    (a, b) => Number(b.isActive) - Number(a.isActive) || b.hotness - a.hotness,
  );

  // With no custom accounts the panel would just repeat the single default-login
  // row the strip already shows — nothing to reveal, so skip the hover affordance.
  const hasPanel = accounts.length > 0;
  const showPanel = open && hasPanel;

  return (
    <div
      className={`usage-bars${hasPanel ? ' expandable' : ''}`}
      tabIndex={hasPanel ? 0 : undefined}
      onMouseEnter={hasPanel ? openPanel : undefined}
      onMouseLeave={hasPanel ? closePanel : undefined}
      onFocus={hasPanel ? openPanel : undefined}
      onBlur={hasPanel ? closePanel : undefined}
    >
      {showPanel && (
        <div className="usage-bars-panel" role="group" aria-label="Usage by account">
          <div className="usage-bars-panel-title">Usage by account</div>
          {rows.map((row) => (
            <UsageRowView key={row.key} row={row} now={now} />
          ))}
        </div>
      )}
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
