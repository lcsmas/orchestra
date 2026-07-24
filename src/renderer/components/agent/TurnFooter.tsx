// Turn footer for the structured agent view: renders AgentSession.lastTurn —
// deliberately slim (one row): cost, turn count, and a context-used gauge with
// a progress bar. Token/duration details live in the stats' tooltips rather
// than as their own chips — the user reads them rarely, and the extra chips
// used to wrap the deck bar onto a second row. Renders a clear, non-crashing
// ERROR state when the last result was an is_error / api_error result (a
// transient 500 shows as "API error — retrying", not a crash; see spike note 6).

import { useEffect, useState } from 'react';
import type { AgentSession, AgentTurnEndEvent } from '../../../shared/types';

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
  // Tick every second while a turn is in flight so the live elapsed/token
  // readout updates in real time. (Called unconditionally to satisfy the rules
  // of hooks; a no-op when the session is absent/idle.)
  useTick(!!session?.running);

  if (!session) return null;
  const turn = session.lastTurn;

  // A turn in flight: the real-time "working" readout — animated icon, elapsed
  // time counting up, and an estimated live token count (snaps to exact at
  // turn-end). Mirrors the Claude-Code desktop footer.
  if (session.running) {
    return <TurnFooterRunning session={session} />;
  }

  if (!turn) return null;

  // Error result — surfaced gracefully (transient 500 is common, not a crash).
  if (turn.isError) {
    return <TurnFooterError turn={turn} />;
  }

  const usage = turn.usage;
  const cacheTotal = usage
    ? usage.cacheCreationInputTokens + usage.cacheReadInputTokens
    : 0;
  // Token + duration detail rides on the cost chip's tooltip instead of
  // rendering as separate chips (slim single-row footer).
  const costDetail = [
    `Session total ${formatCost(session.totalCostUsd)}`,
    usage &&
      `Tokens: ${formatTokens(usage.inputTokens)} in · ${formatTokens(usage.outputTokens)} out · ${formatTokens(cacheTotal)} cache`,
    typeof turn.durationMs === 'number' && `Last turn took ${formatDuration(turn.durationMs)}`,
  ]
    .filter(Boolean)
    .join('\n');

  return (
    <div className="av-turn-footer" role="status">
      {typeof turn.costUsd === 'number' && (
        <Stat label="cost" value={formatCost(turn.costUsd)} title={costDetail} />
      )}
      {turn.numTurns > 0 && (
        <Stat label={turn.numTurns === 1 ? 'turn' : 'turns'} value={String(turn.numTurns)} />
      )}
      <ContextGauge turn={turn} />
    </div>
  );
}

/**
 * Context-used gauge — the most-felt daily gap: long sessions used to hit the
 * context ceiling with zero warning. Data comes free on every result message
 * (`contextUsedTokens` ≈ the final API call's total input+output;
 * `contextWindow` from modelUsage). Reads as "N% used" plus a small progress
 * bar; quiet by default, amber past 75% used and red past 90%.
 */
function ContextGauge({ turn }: { turn: AgentTurnEndEvent }) {
  const used = turn.contextUsedTokens;
  const window = turn.contextWindow;
  if (!used || !window || window <= 0) return null;
  const usedPct = Math.max(0, Math.min(100, Math.round((used / window) * 100)));
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
        <span className="av-turn-context-fill" style={{ width: `${usedPct}%` }} />
      </span>
    </div>
  );
}

/**
 * The real-time "working" footer, styled like the Claude-Code desktop app: an
 * animated spark icon, elapsed time counting up (from `session.turnStartedAt`),
 * and a live token estimate (from `session.liveOutputChars`, ~chars/4). Both
 * refresh via the parent's `useTick`; the token number is approximate until the
 * turn closes, when the footer swaps to the exact `lastTurn.usage`.
 */
function TurnFooterRunning({ session }: { session: AgentSession }) {
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
    <div className="av-turn-footer av-turn-footer-running" role="status">
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
