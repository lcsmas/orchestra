// Turn footer for the structured agent view: renders AgentSession.lastTurn —
// total cost, token usage (input/output/cache), turns, duration — plus a
// running session total. Renders a clear, non-crashing ERROR state when the last
// result was an is_error / api_error result (a transient 500 shows as
// "API error — retrying", not a crash; see spike note 6).

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

  // Running turn, no result yet: a slim live indicator.
  if (!turn) {
    if (session.running) {
      return (
        <div className="av-turn-footer av-turn-footer-running" role="status">
          <span className="av-turn-spinner" aria-hidden="true" />
          <span className="av-turn-running-label">Working…</span>
        </div>
      );
    }
    return null;
  }

  // Error result — surfaced gracefully (transient 500 is common, not a crash).
  if (turn.isError) {
    return <TurnFooterError turn={turn} running={session.running} />;
  }

  const usage = turn.usage;
  const cacheTotal = usage
    ? usage.cacheCreationInputTokens + usage.cacheReadInputTokens
    : 0;

  return (
    <div className="av-turn-footer" role="status">
      {typeof turn.costUsd === 'number' && (
        <Stat
          label="cost"
          value={formatCost(turn.costUsd)}
          title={`Session total ${formatCost(session.totalCostUsd)}`}
        />
      )}
      {usage && (
        <>
          <Stat label="in" value={formatTokens(usage.inputTokens)} title="Input tokens" />
          <Stat label="out" value={formatTokens(usage.outputTokens)} title="Output tokens" />
          <Stat
            label="cache"
            value={formatTokens(cacheTotal)}
            title={`Cache: ${usage.cacheReadInputTokens} read + ${usage.cacheCreationInputTokens} written`}
          />
        </>
      )}
      {turn.numTurns > 0 && (
        <Stat label={turn.numTurns === 1 ? 'turn' : 'turns'} value={String(turn.numTurns)} />
      )}
      {typeof turn.durationMs === 'number' && (
        <Stat label="took" value={formatDuration(turn.durationMs)} />
      )}
      {session.running && (
        <span className="av-turn-footer-live" aria-hidden="true">
          <span className="av-turn-spinner" />
        </span>
      )}
    </div>
  );
}

/** The error variant of the footer. A transient API error advertises a retry
 *  (from the agent-events note); other errors read as a plain failure. */
function TurnFooterError({ turn, running }: { turn: AgentTurnEndEvent; running: boolean }) {
  const transient = turn.stopReason === 'error' || turn.stopReason === 'interrupted';
  const interrupted = turn.stopReason === 'interrupted';
  const label = interrupted
    ? 'Turn interrupted'
    : running
      ? 'API error — retrying'
      : 'Turn ended with an error';
  return (
    <div className="av-turn-footer av-turn-footer-error" role="status">
      <span className="av-turn-error-icon" aria-hidden="true">
        {interrupted ? '■' : '⚠'}
      </span>
      <span className="av-turn-error-label">{label}</span>
      {turn.resultText && <span className="av-turn-error-detail">{turn.resultText}</span>}
      {transient && running && (
        <span className="av-turn-spinner av-turn-error-spinner" aria-hidden="true" />
      )}
    </div>
  );
}
