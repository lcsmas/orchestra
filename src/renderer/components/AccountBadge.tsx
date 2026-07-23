import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useStore } from '../store';
import { dialog } from './Dialog';
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

// A stable, distinct color per login so two accounts side by side read as
// different at a glance. Derived deterministically from the login's name (the
// account label, or DEFAULT_LOGIN_LABEL) so the same login always gets the same
// color across sidebar rows and the repo header. We pick the hue from a string
// hash and keep saturation/lightness fixed in a muted, dark-theme-friendly band
// so every color stays legible against the sidebar without one shouting.
export function loginColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = (hash * 31 + name.charCodeAt(i)) | 0;
  }
  const hue = ((hash % 360) + 360) % 360;
  return `hsl(${hue}, 55%, 68%)`;
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

// Compact token count for the context badge: 41679 → "42k", 1240000 → "1.2M".
// Whole-thousands below 100k so the figure stays narrow next to the branch.
function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) {
    const k = n / 1000;
    return `${k < 10 ? k.toFixed(1) : Math.round(k)}k`;
  }
  const m = n / 1_000_000;
  return `${m < 10 ? m.toFixed(1) : Math.round(m)}M`;
}

// The live context-window size of a workspace's agent session, shown next to
// the branch name with a leading dot separator, in the same discreet yellow as
// the login badge. Ephemeral (store.contextTokens, fed by `agent:context`):
// nothing renders until the agent's first turn lands a usage figure, so a
// never-run workspace shows only its branch.
export function WorkspaceContextBadge({ workspaceId }: { workspaceId: string }) {
  const tokens = useStore((s) => s.contextTokens[workspaceId]);
  // Falsy also covers a 0 that slipped through (the reset sentinel): no badge.
  if (!tokens) return null;
  return (
    <span className="ws-context" title={`Context size: ${tokens.toLocaleString()} tokens`}>
      <span className="ws-context-sep" aria-hidden="true">
        ·
      </span>
      {formatTokens(tokens)}
    </span>
  );
}

export function RepoAccountBadge({ repoPath }: { repoPath: string }) {
  const accountId = useStore(
    (s) => s.repos.find((r) => r.path === repoPath)?.accountId ?? null,
  );
  return <AccountUsageBadge accountId={accountId} />;
}

// The login a workspace's agent logs in as, shown discreetly next to the branch
// name in the sidebar for orchestrators, their spawned children, and scratch
// sessions — the cases where the login isn't otherwise visible. Non-git sessions
// (orchestrators/scratch) have no pinned account, so they fall back to the
// default-login badge; a git child carries its repo's pinned account. The
// resolved accountId comes from the main-process `computeWorkspaceAccounts`
// mapping (null = default login) via the renderer store.
export function WorkspaceAccountBadge({
  workspaceId,
  migratable = false,
}: {
  workspaceId: string;
  /** When true, clicking the badge opens a menu to migrate this workspace to a
   *  different account (moves its conversation + re-pins). Valid for git
   *  workspaces AND scratch/orchestrator sessions — the pin drives
   *  CLAUDE_CONFIG_DIR the same way for both. */
  migratable?: boolean;
}) {
  const accountId = useStore(
    (s) => s.workspaceAccounts[workspaceId]?.accountId ?? null,
  );
  if (!migratable) return <AccountUsageBadge accountId={accountId} />;
  return <WorkspaceAccountMenu workspaceId={workspaceId} accountId={accountId} />;
}

// The clickable per-workspace account control: renders the usage badge, and on
// click drops a small menu of every configured account plus the default login.
// Picking one migrates THIS workspace — the main process auto-stops the agent,
// relocates its conversation into the target account's config dir, re-pins it,
// and resumes if it was running. Confirmed first (the agent restarts). The
// badge repaints itself once the `accounts:workspaceAccounts` broadcast lands.
function WorkspaceAccountMenu({
  workspaceId,
  accountId,
}: {
  workspaceId: string;
  accountId: string | null;
}) {
  const accounts = useStore((s) => s.accounts);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  // Fixed viewport coords for the portalled popover, measured from the trigger.
  // Anchored by `top` when it drops DOWN, by `bottom` when it flips UP (see
  // `place`), so the menu grows away from the edge it would otherwise overflow.
  const [pos, setPos] = useState<{ top?: number; bottom?: number; left: number } | null>(
    null,
  );

  // The popover is rendered in a portal on <body> (not inside the row) so the
  // sidebar's `overflow: hidden` — which clips the scrolling workspace list —
  // can't cut it off. That means we position it manually against the trigger's
  // viewport rect. Measure on open (and on scroll/resize) so it tracks the
  // badge. Left-align to the trigger, but clamp within the viewport so a
  // near-edge badge doesn't push the menu off-screen.
  //
  // VERTICAL FLIP: this badge renders both in the sidebar (plenty of room
  // below) and in the structured view's deck bar, which sits at the BOTTOM of
  // the window — there, a menu anchored at `t.bottom + 4` opened past the
  // viewport and its options were unreachable. So pick the side by measured
  // space rather than assuming downward: drop down when the menu fits below,
  // otherwise flip above the trigger. Anchoring the flipped case by `bottom`
  // (not a computed `top`) keeps it pinned to the trigger while the list grows
  // upward, so adding accounts can't push it off the top either.
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const t = triggerRef.current?.getBoundingClientRect();
      if (!t) return;
      const width = popoverRef.current?.offsetWidth ?? 160;
      const margin = 8;
      const gap = 4;
      const left = Math.min(t.left, window.innerWidth - width - margin);
      const clampedLeft = Math.max(margin, left);
      // Measured height once rendered; fall back to a sane guess on first pass.
      const height = popoverRef.current?.offsetHeight ?? 0;
      const spaceBelow = window.innerHeight - t.bottom - gap - margin;
      const spaceAbove = t.top - gap - margin;
      // Flip up only when it genuinely doesn't fit below AND there's more room
      // above — a cramped viewport otherwise flips to an equally-clipped side.
      const flipUp = height > spaceBelow && spaceAbove > spaceBelow;
      setPos(
        flipUp
          ? { bottom: window.innerHeight - t.top + gap, left: clampedLeft }
          : { top: t.bottom + gap, left: clampedLeft },
      );
    };
    place();
    // The first pass runs BEFORE the popover has laid out, so `offsetHeight` is
    // still 0 and the flip test can't fire (it would always read "fits below").
    // Re-place on the next frame, once the panel has a real height — same
    // reason the width fallback above exists. Without this the deck-bar menu
    // renders downward off-screen for a frame and then never corrects.
    const raf = requestAnimationFrame(place);
    // A scroll inside the sidebar or a window resize moves the trigger — keep up,
    // and close on scroll of the list to avoid a detached floating menu.
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open]);

  // Close on an outside click or Escape. The trigger and the portalled popover
  // are in different DOM subtrees, so an outside click is one that hits neither.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (triggerRef.current?.contains(target)) return;
      if (popoverRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const migrate = async (targetId: string | null, targetLabel: string) => {
    setOpen(false);
    // Same account → nothing to do.
    if ((accountId ?? null) === (targetId ?? null)) return;
    const ok = await dialog.confirm({
      title: 'Migrate account',
      message:
        `Migrate this workspace to “${targetLabel}”?\n\n` +
        `Its Claude conversation moves into that account and the agent restarts ` +
        `(resuming where it left off if it was running).`,
      confirmLabel: 'Migrate',
    });
    if (!ok) return;
    setBusy(true);
    try {
      const res = await window.orchestra.migrateWorkspaceAccount(workspaceId, targetId);
      if (!res.ok) throw new Error(res.error ?? 'migrate failed');
    } catch (err) {
      void dialog.error('Could not migrate account', (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <span className="ws-account-menu">
      <button
        ref={triggerRef}
        type="button"
        className="ws-account-trigger"
        title="Click to migrate this workspace to another account"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={busy}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
      >
        <AccountUsageBadge accountId={accountId} />
      </button>
      {open &&
        createPortal(
          <div
            ref={popoverRef}
            className="ws-account-popover"
            role="menu"
            // Anchor by `bottom` when flipped up, `top` otherwise — exactly one
            // is set, so the unused edge must stay `auto` rather than inherit a
            // stale value from the previous placement. Before the first measure
            // (pos === null) park it off-screen, as the width pass already did.
            style={
              pos?.bottom !== undefined
                ? { top: 'auto', bottom: pos.bottom, left: pos.left }
                : { bottom: 'auto', top: pos?.top ?? -9999, left: pos?.left ?? -9999 }
            }
            onClick={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              role="menuitemradio"
              aria-checked={accountId === null}
              className={`ws-account-option${accountId === null ? ' current' : ''}`}
              onClick={() => void migrate(null, DEFAULT_LOGIN_LABEL)}
            >
              <span className="dot" style={{ background: loginColor(DEFAULT_LOGIN_LABEL) }} />
              <span className="ws-account-label">{DEFAULT_LOGIN_LABEL} login</span>
            </button>
            {accounts.map((a) => (
              <button
                key={a.id}
                type="button"
                role="menuitemradio"
                aria-checked={accountId === a.id}
                className={`ws-account-option${accountId === a.id ? ' current' : ''}`}
                onClick={() => void migrate(a.id, a.label)}
              >
                <span className="dot" style={{ background: loginColor(a.label) }} />
                <span className="ws-account-label">{a.label}</span>
              </button>
            ))}
          </div>,
          document.body,
        )}
    </span>
  );
}

// Shared core: render an account's label tinted by its rolling usage, or the
// default-login badge when there's no pinned account.
function AccountUsageBadge({ accountId }: { accountId: string | null }) {
  const label = useStore((s) =>
    accountId ? (s.accounts.find((a) => a.id === accountId)?.label ?? null) : null,
  );
  const usage = useStore((s) => (accountId ? s.accountUsage[accountId] : undefined));
  const globalUsage = useStore((s) => s.globalUsage);

  // No pinned account (or it points at a deleted account) → Orchestra's default
  // login. Show it the same way a pinned account is shown, tinted by the default
  // login's own rolling usage.
  if (!accountId || !label) return <DefaultLoginBadge usage={globalUsage} />;

  // First poll still in flight.
  if (!usage) {
    return (
      <span
        className="account-badge inline pending"
        style={{ color: loginColor(label) }}
        title={`${label}: fetching usage…`}
      >
        {label}
      </span>
    );
  }

  // No data to show: a hard error (no dir, no scope, never logged in, …).
  // An expired token keeps its last-good `data`, so it falls through to the
  // usage render below with an "expired" note rather than hiding consumption.
  if (!usage.data) {
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
  // window is high. Per design, an expired login does NOT dim the badge — the
  // cached consumption stays normally tinted; only the tooltip flags expiry.
  const sev = severityClass(Math.max(five, seven));
  const extra = data.extraUtilization;
  const title =
    `${label} — Claude usage\n` +
    `5-hour window: ${five}%\n` +
    `7-day window: ${seven}%` +
    (extra != null ? `\nextra usage: ${Math.round(extra)}%` : '') +
    (usage.expired ? `\n⚠ token expired — re-login (showing cached usage)` : '') +
    `\nas of ${ageText(usage.fetchedAt)}`;
  return (
    <span
      className={`account-badge inline usage ${sev}`}
      style={{ color: loginColor(label) }}
      title={title}
    >
      {label}
    </span>
  );
}

// The repo-header badge for Orchestra's default login. Mirrors the pinned-
// account badge but reads the global `~/.claude` usage poller (a bare
// UsageSnapshot — no error/extra fields). Null usage means the first global
// fetch hasn't landed yet.
const DEFAULT_LOGIN_LABEL = 'default';

function DefaultLoginBadge({ usage }: { usage: UsageSnapshot | null }) {
  if (!usage) {
    return (
      <span
        className="account-badge inline pending"
        style={{ color: loginColor(DEFAULT_LOGIN_LABEL) }}
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
    <span
      className={`account-badge inline usage ${sev}`}
      style={{ color: loginColor(DEFAULT_LOGIN_LABEL) }}
      title={title}
    >
      {DEFAULT_LOGIN_LABEL}
    </span>
  );
}
