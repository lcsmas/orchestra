// Turn footer for the structured agent view: renders AgentSession.lastTurn —
// deliberately slim (one row): cost, turn count, and a context-used gauge with
// a progress bar. Token/duration details live in the stats' tooltips rather
// than as their own chips — the user reads them rarely, and the extra chips
// used to wrap the deck bar onto a second row. Renders a clear, non-crashing
// ERROR state when the last result was an is_error / api_error result (a
// transient 500 shows as "API error — retrying", not a crash; see spike note 6).

import { useEffect, useState } from 'react';
import type { AgentSession, AgentTurnEndEvent } from '../../../shared/types';
import type { ContextUsage } from '../../../shared/context-usage';

/** k/M token formatter, mirroring AccountBadge.formatTokens for consistency. */
function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) {
    const k = n / 1000;
    return `${k < 10 ? k.toFixed(1) : Math.round(k)}k`;
  }
  const m = n / 1_000_000;
  return `${m < 10 ? m.toFixed(1) : Math.round(m)}M`;
}

/** Rough chars→tokens estimate for the LIVE counter (~4 chars/token for English
 *  prose + code). Approximate by design — the exact count arrives at turn-end and
 *  the footer snaps to it. Kept deliberately simple; a fancier tokenizer isn't
 *  worth shipping on the streaming hot path. */
function estimateTokens(chars: number): number {
  return Math.max(0, Math.round(chars / 4));
}

/** Live clock: re-renders every `ms` while `active`, so a derived value like
 *  elapsed time or a live token estimate ticks up. Returns a monotonically
 *  increasing tick counter (unused by callers — they read Date.now()/props). */
function useTick(active: boolean, ms = 1000): void {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setTick((t) => t + 1), ms);
    return () => clearInterval(id);
  }, [active, ms]);
}

/** Cost in USD, cents-precise for small amounts. */
function formatCost(usd: number): string {
  if (usd === 0) return '$0';
  if (usd < 0.01) return '<$0.01';
  if (usd < 1) return `$${usd.toFixed(2)}`;
  return `$${usd.toFixed(2)}`;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s < 10 ? s.toFixed(1) : Math.round(s)}s`;
  const m = Math.floor(s / 60);
  const rem = Math.round(s % 60);
  return `${m}m ${rem}s`;
}

function Stat({ label, value, title }: { label: string; value: string; title?: string }) {
  return (
    <div className="av-turn-stat" title={title}>
      <span className="av-turn-stat-value">{value}</span>
      <span className="av-turn-stat-label">{label}</span>
    </div>
  );
}

export function TurnFooter({ session }: { session: AgentSession | undefined }) {
  if (!session) return null;
  const turn = session.lastTurn;
  if (!turn) return null;

  // While a new turn is in flight the live "Working…" readout renders INSIDE
  // the transcript (WorkingIndicator, mounted by MessageList below the
  // streaming output — CC-desktop style). The deck bar keeps showing the
  // PREVIOUS turn's stats so cost/context don't blink out mid-run; a stale
  // error result is the one thing not worth persisting.
  if (turn.isError) {
    return session.running ? null : <TurnFooterError turn={turn} />;
  }

  const usage = turn.usage;
  const cacheTotal = usage
    ? usage.cacheCreationInputTokens + usage.cacheReadInputTokens
    : 0;
  // Token / turn-count / duration detail rides on the cost chip's tooltip
  // instead of rendering as separate chips (slim single-row footer).
  const costDetail = [
    `Session total ${formatCost(session.totalCostUsd)}`,
    usage &&
      `Tokens: ${formatTokens(usage.inputTokens)} in · ${formatTokens(usage.outputTokens)} out · ${formatTokens(cacheTotal)} cache`,
    turn.numTurns > 0 && `${turn.numTurns} turn${turn.numTurns === 1 ? '' : 's'}`,
    typeof turn.durationMs === 'number' && `Last turn took ${formatDuration(turn.durationMs)}`,
  ]
    .filter(Boolean)
    .join('\n');

  return (
    <div className="av-turn-footer" role="status">
      {typeof turn.costUsd === 'number' && (
        <Stat label="cost" value={formatCost(turn.costUsd)} title={costDetail} />
      )}
      <ContextGauge turn={turn} usage={session.contextUsage} />
    </div>
  );
}

/**
 * The context strip's readout: last-turn cost + the context gauge, at caption
 * weight, rendered UNDER the composer card rather than in a bordered deck row.
 *
 * Same data as {@link TurnFooter} (which is no longer mounted — the deck bar it
 * lived in was folded into the composer card). Kept in this file so the
 * formatters and the gauge have exactly one definition; `TurnFooter` itself is
 * retained for the error state and for any caller that still wants the old row.
 */
export function StripStats({ session }: { session: AgentSession | undefined }) {
  if (!session) return null;
  // The cost readout needs a closed, non-errored turn; an errored turn is
  // surfaced by TurnFooterError in the transcript, not repeated here. The GAUGE
  // has no such dependency once a live SDK reading exists — that reading is
  // available from pane mount, before any turn — so it renders on its own
  // rather than being suppressed along with the cost.
  const rawTurn = session.lastTurn;
  const turn = rawTurn && !rawTurn.isError ? rawTurn : undefined;
  if (!turn && !session.contextUsage) return null;

  const usage = turn?.usage;
  const cacheTotal = usage ? usage.cacheCreationInputTokens + usage.cacheReadInputTokens : 0;
  const costDetail = [
    `Session total ${formatCost(session.totalCostUsd)}`,
    usage &&
      `Tokens: ${formatTokens(usage.inputTokens)} in · ${formatTokens(usage.outputTokens)} out · ${formatTokens(cacheTotal)} cache`,
    turn && turn.numTurns > 0 && `${turn.numTurns} turn${turn.numTurns === 1 ? '' : 's'}`,
    typeof turn?.durationMs === 'number' && `Last turn took ${formatDuration(turn.durationMs)}`,
  ]
    .filter(Boolean)
    .join('\n');

  return (
    <>
      {typeof turn?.costUsd === 'number' && (
        <span className="av-strip-item" title={costDetail}>
          {formatCost(turn.costUsd)}
        </span>
      )}
      <ContextGauge turn={turn} usage={session.contextUsage} />
    </>
  );
}

/**
 * Context-used gauge — the most-felt daily gap: long sessions used to hit the
 * context ceiling with zero warning. Reads as "N% used" plus a small progress
 * bar; quiet by default, amber past 75% used and red past 90%.
 *
 * TWO sources, in order of preference:
 *   • `usage` — the live SDK reading (`session/context`, from
 *     `Query.getContextUsage()`). The CLI's own accounting, always carries a
 *     window, and available from pane mount.
 *   • `turn` — the per-turn inference (`contextUsedTokens` ≈ the last API
 *     call's input+output — the per-call usage, NOT the result's cumulative
 *     one, which once pinned this at 100%; `contextWindow` from modelUsage).
 *     The fallback for sessions with no live Query: detached keeper sessions
 *     and history replay. Note its `contextWindow` is null on many turns, which
 *     makes the gauge render nothing — the live source has no such gap.
 */
function ContextGauge({
  turn,
  usage,
}: {
  turn: AgentTurnEndEvent | undefined;
  usage: ContextUsage | undefined;
}) {
  // Prefer the live SDK reading (`session/context`) over the per-turn
  // inference: it is the CLI's own accounting, it always carries a window size
  // (the inferred `contextWindow` is null on many turns, which used to make the
  // gauge vanish outright), and it exists before the first turn closes.
  const used = usage ? usage.totalTokens : turn?.contextUsedTokens;
  const window = usage ? usage.maxTokens : turn?.contextWindow;
  if (!used || !window || window <= 0) return null;
  const rawPct = Math.round((used / window) * 100);
  // The BAR is clamped (a fill can't exceed its track), but the NUMBER is not:
  // an over-limit session genuinely reads past 100%, and pinning it to 100
  // would hide exactly the state this gauge exists to warn about.
  const usedPct = Math.max(0, rawPct);
  const fillPct = Math.max(0, Math.min(100, rawPct));
  const level = usedPct >= 90 ? 'critical' : usedPct >= 75 ? 'low' : 'ok';
  return (
    <div
      className={`av-turn-stat av-turn-context av-turn-context-${level}`}
      title={`Context: ${formatTokens(used)} of ${formatTokens(window)} tokens in use${
        level !== 'ok' ? ' — consider /compact' : ''
      }`}
    >
      <span className="av-turn-stat-value">{usedPct}%</span>
      <span className="av-turn-stat-label">used</span>
      <span className="av-turn-context-bar" aria-hidden="true">
        <span className="av-turn-context-fill" style={{ width: `${fillPct}%` }} />
      </span>
    </div>
  );
}

/**
 * The real-time "working" readout, styled like the Claude-Code desktop app: an
 * animated spark icon, elapsed time counting up (from `session.turnStartedAt`),
 * and a live token estimate (from `session.liveOutputChars`, ~chars/4). Rendered
 * by MessageList INSIDE the transcript, below the streaming output (CC-desktop
 * placement), not in the deck bar. Ticks itself once a second; the token number
 * is approximate until the turn closes, when the exact `lastTurn.usage` lands
 * in the deck-bar footer.
 */
export function WorkingIndicator({ session }: { session: AgentSession }) {
  // Self-ticking: this component only mounts while a turn is in flight.
  useTick(true);
  const startedAt = session.turnStartedAt;
  const elapsedMs = startedAt !== undefined ? Date.now() - startedAt : -1;
  // Only show the live clock when the elapsed reads as a sane in-progress turn:
  // ≥ 0 and under a day. A bogus/future `turnStartedAt` (should never happen —
  // the manager stamps real Date.now()) would otherwise print a nonsense
  // duration; guard it rather than trust the timestamp blindly.
  const showTime = elapsedMs >= 0 && elapsedMs < 24 * 60 * 60 * 1000;
  const liveTokens = estimateTokens(session.liveOutputChars);
  // Redacted thinking streams no visible output — the SDK's thinking-token
  // estimate is the only number that moves, so show it while it's the freshest
  // signal (cleared at turn boundaries by the fold).
  const thinkingTokens = session.liveThinkingTokens ?? 0;

  return (
    <div className="av-working-line" role="status">
      <span className="av-turn-spark" aria-hidden="true">✳</span>
      <span className="av-turn-running-label">Working</span>
      {showTime && <span className="av-turn-live-sep" aria-hidden="true">·</span>}
      {showTime && (
        <span className="av-turn-live-time" title="Elapsed">
          {formatDuration(elapsedMs)}
        </span>
      )}
      {liveTokens > 0 && (
        <>
          <span className="av-turn-live-sep" aria-hidden="true">·</span>
          <span className="av-turn-live-tokens" title="Estimated output tokens (exact at turn end)">
            {formatTokens(liveTokens)} tokens
          </span>
        </>
      )}
      {liveTokens === 0 && thinkingTokens > 0 && (
        <>
          <span className="av-turn-live-sep" aria-hidden="true">·</span>
          <span className="av-turn-live-tokens" title="Estimated thinking tokens">
            thinking · {formatTokens(thinkingTokens)} tokens
          </span>
        </>
      )}
      {session.statusNotice && (
        <>
          <span className="av-turn-live-sep" aria-hidden="true">·</span>
          {/* Transient turn status ("Compacting conversation…", "API 529 —
              retrying in 8s") — the multi-minute silent stall, now named. */}
          <span className="av-turn-status-notice">{session.statusNotice}</span>
        </>
      )}
    </div>
  );
}

/** The error variant of the footer. (The old "API error — retrying" branch was
 *  UNREACHABLE — this component only renders when `running` is false, and the
 *  manager never auto-retries — and would have promised a retry that doesn't
 *  exist. Mid-turn API retries now surface live via `session.statusNotice`
 *  in the running footer instead.) */
function TurnFooterError({ turn }: { turn: AgentTurnEndEvent }) {
  const interrupted = turn.stopReason === 'interrupted';
  const label = interrupted ? 'Turn interrupted' : 'Turn ended with an error';
  return (
    <div className="av-turn-footer av-turn-footer-error" role="status">
      <span className="av-turn-error-icon" aria-hidden="true">
        {interrupted ? '■' : '⚠'}
      </span>
      <span className="av-turn-error-label">{label}</span>
      {turn.resultText && <span className="av-turn-error-detail">{turn.resultText}</span>}
    </div>
  );
}
