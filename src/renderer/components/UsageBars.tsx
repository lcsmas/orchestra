import { useEffect, useRef, useState } from 'react';
import { useStore } from '../store';
import { loginColor } from './AccountBadge';
import type { UsageErrorKind, UsageWindowDetail } from '../../shared/types';

// Slim progress bars showing the active workspace's account rolling usage
// limits: the 5-hour session window, the 7-day weekly window, and — when the
// plan has one — the Fable-scoped 7-day window. Plus, when the account has a
// pay-as-you-go pool enabled, an "extra credits" cell showing how full that
// pool is. Unlike the three rolling windows it has NO reset — it's a spend
// meter, not a countdown — so its tooltip omits the "resets in" clause.
// When the
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
// glanceable, not precise timers. Exported for the PromptQueueBanner, which
// shows the same countdown for a limit-blocked account.
export function formatResetsIn(resetsAt: string, now: number): string {
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

// "updated 3m ago" — age of the snapshot behind the bars. The pollers refresh
// every 60–180s, so minute granularity matches the data's actual freshness.
// Exported for the Resources page, which stamps its account cards the same way.
export function formatUpdatedAgo(fetchedAt: number, now: number): string {
  if (!Number.isFinite(fetchedAt) || fetchedAt <= 0) return '';
  const mins = Math.floor(Math.max(0, now - fetchedAt) / 60_000);
  if (mins < 1) return 'updated just now';
  const days = Math.floor(mins / 1440);
  const hours = Math.floor((mins % 1440) / 60);
  const m = mins % 60;
  if (days > 0) return `updated ${days}d ${hours}h ago`;
  if (hours > 0) return `updated ${hours}h ${m}m ago`;
  return `updated ${m}m ago`;
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

/* One window inside the compact strip: label · track · percent on a single
   line, so all cells (5h / 7d / Fable / extra credits) share one row of footer
   height. The reset countdown and window name live on the cell's tooltip;
   the per-account breakdown stays on the hover panel. `window.resetsAt` is ''
   for the extra-credits pool (a spend meter, not a rolling window) — the
   tooltip then omits the countdown clause. */
function StripCell({
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
  const pct = clampPct(window.utilization);
  const resets = formatResetsIn(window.resetsAt, now);
  return (
    <span className="usage-strip-cell" title={`${title} — ${pct}%${resets ? ` · ${resets}` : ''}`}>
      <span className="usage-strip-label">{label}</span>
      <span className="usage-bar-track">
        <span
          className="usage-bar-fill"
          style={{ width: `${pct}%`, background: severityVar(pct) }}
        />
      </span>
      <span className="usage-strip-pct">{pct}%</span>
    </span>
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
  | {
      kind: 'ok';
      fiveHour: UsageWindowDetail;
      sevenDay: UsageWindowDetail;
      /** Fable-scoped weekly window; null when the account's plan has none. */
      fable: UsageWindowDetail | null;
      /** Pay-as-you-go pool fill 0–100; null when the pool isn't enabled. Has
       *  no reset, so it renders as a labelled bar with no countdown. */
      extraUtilization: number | null;
      expired?: boolean;
      /** Epoch ms of the snapshot the bars render — shows as "updated Xm ago". */
      fetchedAt: number;
    }
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
        <span className="usage-bars-row-name" style={{ color: loginColor(row.label) }}>
          {row.label}
        </span>
        {row.state.kind === 'pending' && (
          <span className="usage-bars-row-status">fetching usage…</span>
        )}
        {row.state.kind === 'error' && (
          <span className="usage-bars-row-status">{errorText(row.state.errorKind)}</span>
        )}
        {row.state.kind === 'ok' && row.state.expired && (
          <span className="usage-bars-row-status">token expired</span>
        )}
        {row.state.kind === 'ok' && (
          <span className="usage-bars-row-updated">
            {formatUpdatedAgo(row.state.fetchedAt, now)}
          </span>
        )}
      </div>
      {row.state.kind === 'ok' && (
        <>
          <MiniBar label="5h" window={row.state.fiveHour} now={now} />
          <MiniBar label="7d" window={row.state.sevenDay} now={now} />
          {row.state.fable && <MiniBar label="f7d" window={row.state.fable} now={now} />}
          {row.state.extraUtilization !== null && (
            <MiniBar
              label="ex"
              window={{ utilization: row.state.extraUtilization, resetsAt: '' }}
              now={now}
            />
          )}
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
  let fable: { utilization: number; resetsAt: string } | null = null;
  // Pay-as-you-go pool fill 0–100, or null when the account has no enabled
  // extra-usage pool (then the "ex" cell is hidden, like the Fable bar).
  let extra: number | null = null;
  let accountLabel: string | null = null;
  let fetchedAt = 0;

  if (accountId !== null) {
    // Show bars whenever we have data — including a cached snapshot kept across
    // an expired token (perAccountStatus.expired). The hover panel row carries
    // the "token expired" note; the strip just shows the last-known consumption.
    if (perAccountStatus?.data) {
      fiveHour = perAccountStatus.data.fiveHour;
      sevenDay = perAccountStatus.data.sevenDay;
      fable = perAccountStatus.data.fable ?? null;
      extra = perAccountStatus.data.extraUtilization;
      accountLabel = activeAccount?.label ?? null;
      fetchedAt = perAccountStatus.fetchedAt;
    }
    // No data yet for this account → hide bars rather than show the wrong account.
  } else if (globalUsage) {
    fiveHour = globalUsage.fiveHour;
    sevenDay = globalUsage.sevenDay;
    fable = globalUsage.fable ?? null;
    extra = globalUsage.extraUtilization ?? null;
    // Surface the default login by name too, the same as a pinned account, so
    // the bars always say which login they're measuring.
    accountLabel = activeAccount?.label ?? 'default';
    fetchedAt = globalUsage.fetchedAt;
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
        hotness: Math.max(
          u.data.fiveHour.utilization,
          u.data.sevenDay.utilization,
          u.data.fable?.utilization ?? 0,
        ),
        state: {
          kind: 'ok',
          fiveHour: u.data.fiveHour,
          sevenDay: u.data.sevenDay,
          fable: u.data.fable ?? null,
          extraUtilization: u.data.extraUtilization,
          expired: u.expired,
          fetchedAt: u.fetchedAt,
        },
      });
    }
  }
  const defaultActive = accountId === null;
  if (!globalUsage) {
    rows.push({
      key: '__default__',
      label: 'default',
      isActive: defaultActive,
      hotness: -1,
      state: { kind: 'pending' },
    });
  } else {
    rows.push({
      key: '__default__',
      label: 'default',
      isActive: defaultActive,
      hotness: Math.max(
        globalUsage.fiveHour.utilization,
        globalUsage.sevenDay.utilization,
        globalUsage.fable?.utilization ?? 0,
      ),
      state: {
        kind: 'ok',
        fiveHour: globalUsage.fiveHour,
        sevenDay: globalUsage.sevenDay,
        fable: globalUsage.fable ?? null,
        extraUtilization: globalUsage.extraUtilization ?? null,
        fetchedAt: globalUsage.fetchedAt,
      },
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
      <div
        className="usage-strip"
        role="group"
        aria-label={`Claude usage${accountLabel ? ` — ${accountLabel}` : ''}`}
      >
        {accountLabel && (
          <span
            className="usage-strip-account"
            title={`Usage for ${accountLabel} — ${formatUpdatedAgo(fetchedAt, now)}`}
          >
            {accountLabel}
          </span>
        )}
        <StripCell label="5h" title="5-hour session window" window={fiveHour} now={now} />
        <StripCell label="7d" title="7-day weekly window" window={sevenDay} now={now} />
        {fable && <StripCell label="F" title="Fable 7-day weekly window" window={fable} now={now} />}
        {extra !== null && (
          <StripCell
            label="EX"
            title="Extra credits (pay-as-you-go pool)"
            window={{ utilization: extra, resetsAt: '' }}
            now={now}
          />
        )}
      </div>
    </div>
  );
}
