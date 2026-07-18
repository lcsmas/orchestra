import { useEffect, useRef, useState } from 'react';
import { useStore } from '../store';
import { loginColor } from './AccountBadge';
import { dialog } from './Dialog';
import { formatResetsIn, formatUpdatedAgo } from './UsageBars';
import type { ResourceSnapshot, SessionResourceStat } from '../../shared/resources';
import type { UsageErrorKind, UsageWindow, Workspace } from '../../shared/types';

// The Resources page: a live monitor of everything Orchestra is consuming.
// System side (CPU / memory / processes / disk) comes from `resources:sample`,
// polled every SAMPLE_MS while the page is open and the document visible —
// there is no push channel and no background cost when closed. Token usage
// reuses the store slices the existing account pollers already keep fresh
// (accountUsage / globalUsage / workspaceAccounts), so that half adds no IPC.

const SAMPLE_MS = 2000;
// ~3 minutes of trace at the 2s cadence. Enough to see a spike's shape without
// the sparkline compressing into noise.
const HISTORY_LEN = 90;

function formatBytes(n: number | null | undefined): string {
  if (n == null) return '—';
  if (n < 1024) return `${n} B`;
  const kb = n / 1024;
  if (kb < 1024) return `${Math.round(kb)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return mb < 10 ? `${mb.toFixed(1)} MB` : `${Math.round(mb)} MB`;
  const gb = mb / 1024;
  return gb < 10 ? `${gb.toFixed(2)} GB` : `${gb.toFixed(1)} GB`;
}

function formatCpu(pct: number): string {
  return `${Math.round(pct)}%`;
}

function formatTokens(n: number | undefined): string {
  if (n == null) return '—';
  return n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);
}

// Same thresholds as the sidebar UsageBars — limits are genuine status, so
// they get the status colors. CPU/memory meters deliberately do NOT use these
// (high CPU isn't a problem state); they stay on the accent hue.
function severityVar(pct: number): string {
  if (pct >= 90) return 'var(--red)';
  if (pct >= 75) return 'var(--yellow)';
  return 'var(--accent)';
}

function usageErrorText(kind: UsageErrorKind | null): string {
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

/** The signature mark of the page: a small right-aligned CPU trace. New
 *  samples enter from the right; the area fill keeps it readable at 20px
 *  tall. Scale is max(100, peak) so a quiet agent isn't magnified into
 *  fake drama and a hot one isn't clipped. */
function Spark({ values, width = 96, height = 22 }: { values: number[]; width?: number; height?: number }) {
  const peak = values.reduce((m, v) => Math.max(m, v), 0);
  const max = Math.max(100, peak);
  if (values.length < 2) {
    return <svg className="res-spark" width={width} height={height} aria-hidden="true" />;
  }
  const step = width / (HISTORY_LEN - 1);
  const pts = values.map((v, i) => {
    const x = width - (values.length - 1 - i) * step;
    const y = height - 1.5 - (Math.min(v, max) / max) * (height - 3);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const first = pts[0].split(',')[0];
  const area = `M ${pts[0]} L ${pts.slice(1).join(' L ')} L ${width},${height} L ${first},${height} Z`;
  return (
    <svg className="res-spark" width={width} height={height} aria-hidden="true">
      <path d={area} fill="var(--accent)" opacity="0.14" stroke="none" />
      <polyline
        points={pts.join(' ')}
        fill="none"
        stroke="var(--accent)"
        strokeWidth="1.5"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** One labeled meter row (account cards / disk): label, track, value, and an
 *  optional right-hand detail ("resets in 3h 12m"). `pct` drives the fill;
 *  `text` is what's printed. */
function Meter({
  label,
  pct,
  text,
  fill,
  detail,
}: {
  label: string;
  pct: number;
  text: string;
  fill: string;
  detail?: string;
}) {
  const clamped = Math.max(0, Math.min(100, pct));
  return (
    <div className="res-meter">
      <span className="res-meter-label">{label}</span>
      <div className="usage-bar-track">
        <div className="usage-bar-fill" style={{ width: `${clamped}%`, background: fill }} />
      </div>
      <span className="res-meter-value">{text}</span>
      <span className="res-meter-detail">{detail ?? ''}</span>
    </div>
  );
}

/** Compact CPU cell for table rows: a slim track + percent, no label. The
 *  fill maxes out at one full core; the printed number keeps counting past
 *  it (a multi-threaded build can legitimately read 300%). */
function CpuCell({ pct }: { pct: number }) {
  const clamped = Math.max(0, Math.min(100, pct));
  return (
    <span className="res-cpu-cell">
      <span className="usage-bar-track">
        <span
          className="usage-bar-fill"
          style={{ width: `${clamped}%`, background: 'var(--accent)', display: 'block' }}
        />
      </span>
      <span className="res-cell">{formatCpu(pct)}</span>
    </span>
  );
}

interface AgentRow {
  key: string;
  ws: Workspace | null;
  /** Display name when the workspace record is unknown (stale session). */
  fallbackName: string;
  sessions: SessionResourceStat[];
  cpuPct: number;
  memBytes: number;
  procCount: number;
  remote: boolean;
}

function SessionChips({ sessions }: { sessions: SessionResourceStat[] }) {
  return (
    <span className="res-chips">
      {sessions.map((s) => (
        <span key={s.ptyId} className={`res-chip ${s.kind}`}>
          {s.kind}
        </span>
      ))}
    </span>
  );
}

function AgentRowView({
  row,
  trace,
  diskBytes,
  ctxTokens,
  accountLabel,
}: {
  row: AgentRow;
  trace: number[];
  diskBytes: number | undefined;
  ctxTokens: number | undefined;
  accountLabel: string | null;
}) {
  const [open, setOpen] = useState(false);
  const procs = row.sessions.flatMap((s) => s.processes).sort((a, b) => b.memBytes - a.memBytes);
  const name = row.ws ? row.ws.branch : row.fallbackName;
  const repo = row.ws?.repoPath ? row.ws.repoPath.split('/').pop() : row.ws ? 'scratch' : '';
  // The stop target is the agent PTY (its id IS the workspace id) — run/nvim
  // sessions are left alone. Rows with no live agent session get no button.
  const agentSession = row.sessions.find((s) => s.kind === 'agent');
  const onStop = async (e: React.MouseEvent) => {
    // The row itself is a disclosure toggle — a stop must not also expand it.
    e.stopPropagation();
    if (!agentSession) return;
    if (row.ws?.status === 'running') {
      const ok = await dialog.confirm({
        title: 'Stop agent?',
        message: `${name} is mid-turn. Stopping will kill the current response.`,
        detail:
          'The agent process exits and frees its CPU/memory. Reopening the workspace (or pressing a key in its terminal) relaunches it with `claude --continue`.',
        tone: 'danger',
      });
      if (!ok) return;
    }
    try {
      await window.orchestra.stopAgent(agentSession.ptyId);
    } catch (err) {
      void dialog.error(`Could not stop agent: ${(err as Error).message}`);
    }
  };
  return (
    <>
      {/* div[role=button], not <button>: the stop control nests inside, and
          interactive content is invalid inside a real <button>. */}
      <div
        className={`res-agent-row${open ? ' open' : ''}`}
        role="button"
        tabIndex={0}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => {
          if (e.target !== e.currentTarget) return; // let the stop button keep Enter/Space
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            setOpen((v) => !v);
          }
        }}
        aria-expanded={open}
        title={open ? 'Hide processes' : 'Show processes'}
      >
        <span className={`ws-dot ${row.ws?.status ?? 'idle'}`} />
        <span className="res-agent-name">
          <span className="res-agent-branch">{name}</span>
          <span className="res-agent-sub">
            {repo}
            {accountLabel && (
              <span className="res-agent-account" style={{ color: loginColor(accountLabel) }}>
                {accountLabel}
              </span>
            )}
          </span>
        </span>
        <SessionChips sessions={row.sessions} />
        {row.remote ? (
          <span className="res-remote-note">runs in sandbox — no local footprint</span>
        ) : (
          <>
            <span className="res-col-trace">
              <Spark values={trace} />
            </span>
            <CpuCell pct={row.cpuPct} />
            <span className="res-cell">{formatBytes(row.memBytes)}</span>
            <span className="res-cell dim res-col-procs">{row.procCount}</span>
          </>
        )}
        <span className="res-cell dim res-col-disk">{formatBytes(diskBytes)}</span>
        <span className="res-cell dim res-col-ctx">{formatTokens(ctxTokens)}</span>
        <span className="res-col-stop">
          {agentSession && (
            <button
              className="res-stop-btn"
              onClick={(e) => void onStop(e)}
              title="Stop this agent's process (conversation resumes on relaunch)"
              aria-label={`Stop agent ${name}`}
            >
              <svg width="8" height="8" viewBox="0 0 8 8" aria-hidden="true">
                <rect x="0.5" y="0.5" width="7" height="7" rx="1.5" fill="currentColor" />
              </svg>
            </button>
          )}
        </span>
      </div>
      {open && !row.remote && (
        <div className="res-procs">
          {procs.length === 0 && <div className="res-procs-empty">No live processes.</div>}
          {procs.map((p) => (
            <div key={p.pid} className="res-proc">
              <span className="res-proc-comm">{p.comm}</span>
              <span className="res-cell dim">{p.pid}</span>
              <span className="res-cell">{formatCpu(p.cpuPct)}</span>
              <span className="res-cell">{formatBytes(p.memBytes)}</span>
            </div>
          ))}
          {row.procCount > procs.length && (
            <div className="res-procs-empty">
              +{row.procCount - procs.length} more (smallest not shown)
            </div>
          )}
        </div>
      )}
    </>
  );
}

/** One rolling-limit row inside an account card: label, colored fill, percent
 *  and reset countdown spelled out (the sidebar bars only tooltip these). */
function LimitRow({
  label,
  window: w,
  now,
}: {
  label: string;
  window: UsageWindow;
  now: number;
}) {
  const pct = Math.max(0, Math.min(100, Math.round(w.utilization)));
  return (
    <Meter
      label={label}
      pct={pct}
      text={`${pct}%`}
      fill={severityVar(pct)}
      detail={formatResetsIn(w.resetsAt, now)}
    />
  );
}

export function ResourcesView() {
  const setPage = useStore((s) => s.setPage);
  const workspaces = useStore((s) => s.workspaces);
  const sizes = useStore((s) => s.sizes);
  const contextTokens = useStore((s) => s.contextTokens);
  const accounts = useStore((s) => s.accounts);
  const accountUsage = useStore((s) => s.accountUsage);
  const globalUsage = useStore((s) => s.globalUsage);
  const workspaceAccounts = useStore((s) => s.workspaceAccounts);

  const [snap, setSnap] = useState<ResourceSnapshot | null>(null);
  const [now, setNow] = useState(() => Date.now());
  // CPU traces per workspace (plus the '__total__' fleet trace), kept in a ref
  // so a tick appends without re-creating the map. The setSnap that follows
  // every append is what re-renders the sparklines.
  const histRef = useRef<Map<string, number[]>>(new Map());

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setInterval> | null = null;
    const push = (key: string, v: number) => {
      const h = histRef.current;
      const arr = h.get(key) ?? [];
      arr.push(v);
      if (arr.length > HISTORY_LEN) arr.splice(0, arr.length - HISTORY_LEN);
      h.set(key, arr);
    };
    const tick = async () => {
      try {
        const s = await window.orchestra.sampleResources();
        if (stopped) return;
        const byWs = new Map<string, number>();
        let total = 0;
        for (const sess of s.sessions) {
          if (sess.remote) continue;
          total += sess.cpuPct;
          const k = sess.workspaceId ?? sess.ptyId;
          byWs.set(k, (byWs.get(k) ?? 0) + sess.cpuPct);
        }
        push('__total__', total);
        // Keys with no live session this tick decay to 0 so a stopped agent's
        // trace visibly flatlines instead of freezing at its last value.
        for (const key of histRef.current.keys()) {
          if (key !== '__total__' && !byWs.has(key)) push(key, 0);
        }
        for (const [k, v] of byWs) push(k, v);
        setNow(Date.now());
        setSnap(s);
      } catch {
        /* main busy or shutting down — skip this tick */
      }
    };
    const start = () => {
      if (timer) return;
      void tick();
      timer = setInterval(() => void tick(), SAMPLE_MS);
    };
    const stop = () => {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    };
    const onVisibility = () => {
      if (document.visibilityState === 'visible') start();
      else stop();
    };
    onVisibility();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      stopped = true;
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);

  // Esc closes the page (same affordance as the ✕ button).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPage('workspaces');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setPage]);

  const live = workspaces.filter((w) => !w.archived);
  const wsById = new Map(live.map((w) => [w.id, w]));

  // Group the sampled sessions into per-workspace rows + login PTYs.
  const byWs = new Map<string, SessionResourceStat[]>();
  const loginSessions: SessionResourceStat[] = [];
  for (const s of snap?.sessions ?? []) {
    if (s.kind === 'login') {
      loginSessions.push(s);
      continue;
    }
    const k = s.workspaceId ?? s.ptyId;
    const list = byWs.get(k);
    if (list) list.push(s);
    else byWs.set(k, [s]);
  }
  const rows: AgentRow[] = Array.from(byWs, ([key, sessions]) => ({
    key,
    ws: wsById.get(key) ?? null,
    fallbackName: key,
    sessions,
    cpuPct: sessions.reduce((n, s) => n + s.cpuPct, 0),
    memBytes: sessions.reduce((n, s) => n + s.memBytes, 0),
    procCount: sessions.reduce((n, s) => n + s.procCount, 0),
    remote: sessions.every((s) => s.remote),
  })).sort((a, b) => b.cpuPct - a.cpuPct || b.memBytes - a.memBytes);

  const agentCpu = rows.filter((r) => !r.remote).reduce((n, r) => n + r.cpuPct, 0);
  const agentMem = rows.filter((r) => !r.remote).reduce((n, r) => n + r.memBytes, 0);
  const agentProcs = rows.filter((r) => !r.remote).reduce((n, r) => n + r.procCount, 0);
  const appMem = (snap?.app ?? []).reduce((n, p) => n + p.memBytes, 0);
  const appCpu = (snap?.app ?? []).reduce((n, p) => n + p.cpuPct, 0);
  const worktreeBytes = live.reduce((n, w) => n + (sizes[w.id] ?? 0), 0);
  const agentCount = rows.filter((r) => r.sessions.some((s) => s.kind === 'agent')).length;

  const appTypeLabel = (t: string): string => {
    switch (t) {
      case 'Browser':
        return 'Main process';
      case 'Tab':
        return 'Renderer';
      case 'GPU':
        return 'GPU';
      default:
        return t;
    }
  };

  // Account cards: every configured login + the default one, hottest first,
  // each with the workspaces currently pinned to it.
  const wsByAccount = new Map<string | null, Workspace[]>();
  for (const w of live) {
    const acc = workspaceAccounts[w.id]?.accountId ?? null;
    const list = wsByAccount.get(acc);
    if (list) list.push(w);
    else wsByAccount.set(acc, [w]);
  }
  interface Card {
    key: string;
    label: string;
    fiveHour: UsageWindow | null;
    sevenDay: UsageWindow | null;
    fable: UsageWindow | null;
    extraUtilization: number | null;
    fetchedAt: number;
    expired: boolean;
    error: UsageErrorKind | null | 'pending';
    workspaces: Workspace[];
    hotness: number;
  }
  const cards: Card[] = [];
  for (const a of accounts) {
    const u = accountUsage[a.id];
    cards.push({
      key: a.id,
      label: a.label,
      fiveHour: u?.data?.fiveHour ?? null,
      sevenDay: u?.data?.sevenDay ?? null,
      fable: u?.data?.fable ?? null,
      extraUtilization: u?.data?.extraUtilization ?? null,
      fetchedAt: u?.fetchedAt ?? 0,
      expired: !!u?.expired,
      error: u ? (u.data ? null : u.errorKind) : 'pending',
      workspaces: wsByAccount.get(a.id) ?? [],
      hotness: u?.data
        ? Math.max(
            u.data.fiveHour.utilization,
            u.data.sevenDay.utilization,
            u.data.fable?.utilization ?? 0,
          )
        : -1,
    });
  }
  cards.push({
    key: '__default__',
    label: 'default',
    fiveHour: globalUsage?.fiveHour ?? null,
    sevenDay: globalUsage?.sevenDay ?? null,
    fable: globalUsage?.fable ?? null,
    extraUtilization: globalUsage?.extraUtilization ?? null,
    fetchedAt: globalUsage?.fetchedAt ?? 0,
    expired: false,
    error: globalUsage ? null : 'pending',
    workspaces: wsByAccount.get(null) ?? [],
    hotness: globalUsage
      ? Math.max(
          globalUsage.fiveHour.utilization,
          globalUsage.sevenDay.utilization,
          globalUsage.fable?.utilization ?? 0,
        )
      : -1,
  });
  cards.sort((a, b) => b.hotness - a.hotness);

  const disk = snap?.disk ?? null;
  const diskItems: Array<{ label: string; bytes: number | null; note?: string }> = [
    {
      label: 'Worktrees',
      bytes: worktreeBytes || null,
      note: 'apparent size — reflinked extents may be shared',
    },
    { label: 'Scratch sessions', bytes: disk?.scratchBytes ?? null },
    { label: 'Terminal logs', bytes: disk?.logsBytes ?? null },
    { label: 'Sandbox backups', bytes: disk?.backupsBytes ?? null },
    { label: 'Events spool', bytes: disk?.eventsBytes ?? null },
  ];
  const diskMax = diskItems.reduce((m, d) => Math.max(m, d.bytes ?? 0), 0);

  const memPctOfSystem = snap ? ((agentMem + appMem) / snap.memTotalBytes) * 100 : 0;
  const accountLabelFor = (row: AgentRow): string | null =>
    row.ws ? workspaceAccounts[row.ws.id]?.label ?? null : null;

  return (
    <div className="res-page" role="region" aria-label="Resources">
      <div className="res-header">
        <h2>Resources</h2>
        <span className="res-live" title={`Sampled every ${SAMPLE_MS / 1000}s while this page is open`}>
          <span className="res-live-dot" aria-hidden="true" />
          {snap ? 'live' : 'sampling…'}
        </span>
        <button
          className="res-close"
          onClick={() => setPage('workspaces')}
          title="Back to workspaces (Esc)"
          aria-label="Close the Resources page"
        >
          ×
        </button>
      </div>
      <div className="res-scroll">
        <div className="res-tiles">
          <div className="res-tile res-tile-cpu">
            <div className="res-tile-label">Agent CPU</div>
            <div className="res-tile-value">
              {formatCpu(agentCpu)}
            </div>
            <div className="res-tile-sub">{snap?.cpuCores ?? '—'} cores available</div>
            <div className="res-tile-spark">
              <Spark values={histRef.current.get('__total__') ?? []} width={180} height={30} />
            </div>
          </div>
          <div className="res-tile">
            <div className="res-tile-label">Agent memory</div>
            <div className="res-tile-value">{formatBytes(agentMem)}</div>
            <div className="res-tile-sub">{agentProcs} processes</div>
          </div>
          <div className="res-tile">
            <div className="res-tile-label">App memory</div>
            <div className="res-tile-value">{formatBytes(appMem)}</div>
            <div className="res-tile-sub">Electron · {formatCpu(appCpu)} CPU</div>
          </div>
          <div className="res-tile">
            <div className="res-tile-label">Worktrees on disk</div>
            <div className="res-tile-value">{formatBytes(worktreeBytes || null)}</div>
            <div className="res-tile-sub">{live.filter((w) => sizes[w.id] != null).length} worktrees</div>
          </div>
          <div className="res-tile">
            <div className="res-tile-label">Live agents</div>
            <div className="res-tile-value">{agentCount}</div>
            <div className="res-tile-sub">{memPctOfSystem >= 0.5 ? `${memPctOfSystem.toFixed(1)}% of system RAM` : 'idle'}</div>
          </div>
        </div>

        <section className="res-section">
          <div className="res-section-title">Agents</div>
          {rows.length === 0 && (
            <div className="res-empty">
              No agent processes right now — open a workspace terminal and its
              agent will appear here.
            </div>
          )}
          {rows.length > 0 && (
            <div className="res-table">
              <div className="res-table-head">
                <span />
                <span>workspace</span>
                <span>sessions</span>
                <span className="res-col-trace">trace · 3m</span>
                <span>cpu</span>
                <span>memory</span>
                <span className="res-col-procs">procs</span>
                <span className="res-col-disk">disk</span>
                <span className="res-col-ctx">ctx</span>
                <span className="res-col-stop" />
              </div>
              {rows.map((row) => (
                <AgentRowView
                  key={row.key}
                  row={row}
                  trace={histRef.current.get(row.key) ?? []}
                  diskBytes={row.ws ? sizes[row.ws.id] : undefined}
                  ctxTokens={row.ws ? contextTokens[row.ws.id] : undefined}
                  accountLabel={accountLabelFor(row)}
                />
              ))}
              {loginSessions.map((s) => (
                <div key={s.ptyId} className="res-agent-row static">
                  <span className="ws-dot running" />
                  <span className="res-agent-name">
                    <span className="res-agent-branch">login</span>
                    <span className="res-agent-sub">{s.ptyId.slice('account-login:'.length)}</span>
                  </span>
                  <SessionChips sessions={[s]} />
                  <span className="res-col-trace" />
                  <CpuCell pct={s.cpuPct} />
                  <span className="res-cell">{formatBytes(s.memBytes)}</span>
                  <span className="res-cell dim res-col-procs">{s.procCount}</span>
                  <span className="res-cell dim res-col-disk">—</span>
                  <span className="res-cell dim res-col-ctx">—</span>
                  <span className="res-col-stop" />
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="res-section">
          <div className="res-section-title">App processes</div>
          <div className="res-table res-table-app">
            <div className="res-table-head">
              <span>process</span>
              <span>pid</span>
              <span>cpu</span>
              <span>memory</span>
            </div>
            {(snap?.app ?? [])
              .slice()
              .sort((a, b) => b.memBytes - a.memBytes)
              .map((p) => (
                <div key={p.pid} className="res-app-row">
                  <span className="res-cell">{appTypeLabel(p.type)}</span>
                  <span className="res-cell dim">{p.pid}</span>
                  <span className="res-cell">{formatCpu(p.cpuPct)}</span>
                  <span className="res-cell">{formatBytes(p.memBytes)}</span>
                </div>
              ))}
          </div>
        </section>

        <section className="res-section">
          <div className="res-section-title">Token usage by login</div>
          <div className="res-cards">
            {cards.map((c) => (
              <div key={c.key} className="res-account-card">
                <div className="res-account-head">
                  <span className="res-account-name" style={{ color: loginColor(c.label) }}>
                    {c.label}
                  </span>
                  {c.error === 'pending' && <span className="res-account-note">fetching…</span>}
                  {c.error && c.error !== 'pending' && (
                    <span className="res-account-note err">{usageErrorText(c.error)}</span>
                  )}
                  {!c.error && c.expired && <span className="res-account-note err">token expired</span>}
                  {!c.error && c.fetchedAt > 0 && (
                    <span className="res-account-note">{formatUpdatedAgo(c.fetchedAt, now)}</span>
                  )}
                </div>
                {c.fiveHour && <LimitRow label="5h" window={c.fiveHour} now={now} />}
                {c.sevenDay && <LimitRow label="7d" window={c.sevenDay} now={now} />}
                {c.fable && <LimitRow label="fable" window={c.fable} now={now} />}
                {c.extraUtilization !== null && (
                  <Meter
                    label="extra"
                    pct={c.extraUtilization}
                    text={`${Math.round(c.extraUtilization)}%`}
                    fill={severityVar(c.extraUtilization)}
                    detail="pay-as-you-go pool"
                  />
                )}
                <div className="res-account-ws">
                  {c.workspaces.length === 0
                    ? 'no workspaces'
                    : `${c.workspaces.length} workspace${c.workspaces.length === 1 ? '' : 's'}: ` +
                      c.workspaces
                        .slice(0, 3)
                        .map((w) => w.branch)
                        .join(', ') +
                      (c.workspaces.length > 3 ? ` +${c.workspaces.length - 3} more` : '')}
                </div>
              </div>
            ))}
          </div>
        </section>

        <section className="res-section">
          <div className="res-section-title">Orchestra data on disk</div>
          <div className="res-disk">
            {diskItems.map((d) => (
              <div key={d.label} className="res-disk-row" title={d.note}>
                <span className="res-disk-label">{d.label}</span>
                <div className="usage-bar-track">
                  <div
                    className="usage-bar-fill"
                    style={{
                      width: diskMax > 0 && d.bytes ? `${(d.bytes / diskMax) * 100}%` : '0%',
                      background: 'var(--accent-2)',
                    }}
                  />
                </div>
                <span className="res-cell">{formatBytes(d.bytes)}</span>
              </div>
            ))}
            {disk && (
              <div className="res-disk-note">
                directories measured {formatUpdatedAgo(disk.measuredAt, now)}
              </div>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
