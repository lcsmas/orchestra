// The context gauge's breakdown panel (issue #16) — "what is filling my
// context window?", one click off the gauge in the composer strip.
//
// Renders the model `src/shared/context-breakdown.ts` builds: a segmented bar
// of the used categories, a legend, then the three detail lists the CLI
// reports (memory files, MCP servers, skills/agents). All arithmetic, ordering
// and truncation lives in that shared module and is unit-tested; this file is
// markup and the popover's dismiss behaviour only.
//
// LIVE-SESSION ONLY, by construction rather than by a `source` check: the
// transcript fallback carries a token count and nothing else, so
// `buildContextBreakdown` returns null for it and the gauge renders as a plain
// readout with no affordance. There is deliberately no empty-state panel — an
// empty popover is worse than no popover.
//
// Styling follows the view's popover language (`.av-rc-panel`, the app's
// branch-popover on --av-* tokens); every class here is `av-ctx-*` in
// agent-view-theme.css. No inline colours.

import React from 'react';
import {
  buildContextBreakdown,
  shortenMemoryPath,
  truncateList,
  type BreakdownRow,
  type ContextBreakdown,
} from '../../../shared/context-breakdown';
import type { ContextUsage } from '../../../shared/context-usage';

/** How many rows each detail list shows before collapsing to "+N more". A
 *  session can load dozens of memory files and hundreds of MCP tools; the
 *  popover must stay shorter than the window or it buries the categories that
 *  answer the actual question. */
const LIST_LIMIT = 5;

/** k/M formatter, matching TurnFooter.formatTokens so the panel and the gauge
 *  above it never disagree on how a number reads. */
function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) {
    const k = n / 1000;
    return `${k < 10 ? k.toFixed(1) : Math.round(k)}k`;
  }
  const m = n / 1_000_000;
  return `${m < 10 ? m.toFixed(1) : Math.round(m)}M`;
}

function formatPercent(p: number | null): string {
  if (p == null) return '';
  // A row that is present but rounds below 0.1% reads as "<0.1%", never "0%" —
  // 0 would say "this costs nothing", which is not what a listed row means.
  return p < 0.1 ? '<0.1%' : `${p}%`;
}

/** Deterministic segment/legend colour per category, cycling a 5-slot palette
 *  defined in the theme. Keyed by INDEX (rows arrive sorted largest-first, so
 *  the biggest category always takes slot 0) rather than by name — the CLI's
 *  category names are presentation strings that have changed between versions,
 *  and a name-keyed map would silently fall through to one colour. */
function slot(i: number): number {
  return (i % 5) + 1;
}

function CategoryBar({ rows, windowTokens }: { rows: BreakdownRow[]; windowTokens: number | null }) {
  if (!windowTokens || windowTokens <= 0 || !rows.length) return null;
  return (
    <div className="av-ctx-bar" aria-hidden="true">
      {rows.map((r, i) => (
        <span
          key={r.name}
          className={`av-ctx-seg av-ctx-seg-${slot(i)}`}
          style={{ width: `${(r.tokens / windowTokens) * 100}%` }}
        />
      ))}
      {/* The remainder is the free space; drawn as the track's own background
          rather than a segment, so a producer that sent no `free` row still
          renders a correct-looking bar. */}
    </div>
  );
}

function Legend({ rows }: { rows: BreakdownRow[] }) {
  return (
    <ul className="av-ctx-legend">
      {rows.map((r, i) => (
        <li className="av-ctx-legend-row" key={r.name}>
          <span className={`av-ctx-dot av-ctx-seg-${slot(i)}`} aria-hidden="true" />
          <span className="av-ctx-legend-name">{r.name}</span>
          <span className="av-ctx-legend-tokens">{formatTokens(r.tokens)}</span>
          <span className="av-ctx-legend-pct">{formatPercent(r.percentOfWindow)}</span>
        </li>
      ))}
    </ul>
  );
}

/** A titled detail list with a "+N more" tail. Renders nothing at all when the
 *  list is empty — the panel must not show empty section headers. */
function DetailList({
  title,
  rows,
}: {
  title: string;
  rows: { key: string; label: string; meta?: string; tokens: number; title?: string }[];
}) {
  if (!rows.length) return null;
  const { shown, more } = truncateList(rows, LIST_LIMIT);
  return (
    <section className="av-ctx-section">
      <h4 className="av-ctx-section-title">
        {title}
        <span className="av-ctx-section-count">{rows.length}</span>
      </h4>
      <ul className="av-ctx-list">
        {shown.map((r) => (
          <li className="av-ctx-list-row" key={r.key} title={r.title}>
            <span className="av-ctx-list-label">{r.label}</span>
            {r.meta && <span className="av-ctx-list-meta">{r.meta}</span>}
            <span className="av-ctx-list-tokens">{formatTokens(r.tokens)}</span>
          </li>
        ))}
        {more > 0 && (
          <li className="av-ctx-list-row av-ctx-list-more">
            <span className="av-ctx-list-label">+{more} more</span>
          </li>
        )}
      </ul>
    </section>
  );
}

/**
 * The panel body. Split from the popover shell so a caller (or a visual rig)
 * can render it standalone.
 */
export function ContextBreakdownBody({
  usage,
  breakdown,
}: {
  usage: ContextUsage;
  breakdown: ContextBreakdown;
}) {
  const { used, deferred, free } = breakdown;
  return (
    <>
      <div className="av-ctx-head">
        <span className="av-ctx-title">Context</span>
        <span className="av-ctx-total">
          {formatTokens(usage.totalTokens)}
          {usage.maxTokens ? ` / ${formatTokens(usage.maxTokens)}` : ''}
          {usage.percentage != null ? ` · ${usage.percentage}%` : ''}
        </span>
      </div>
      {usage.model && (
        <div className="av-ctx-model" title={usage.model}>
          {usage.model}
        </div>
      )}

      <CategoryBar rows={used} windowTokens={usage.maxTokens} />
      <Legend rows={used} />
      {free && (
        <div className="av-ctx-free">
          {formatTokens(free.tokens)} free
          {free.percentOfWindow != null ? ` · ${formatPercent(free.percentOfWindow)}` : ''}
        </div>
      )}

      <DetailList
        title="Memory files"
        rows={breakdown.memoryFiles.map((f) => ({
          key: f.path,
          label: shortenMemoryPath(f.path),
          meta: f.type,
          tokens: f.tokens,
          title: f.path,
        }))}
      />
      <DetailList
        title="MCP servers"
        rows={breakdown.mcpServers.map((s) => ({
          key: s.serverName,
          label: s.serverName,
          meta: `${s.toolCount} tool${s.toolCount === 1 ? '' : 's'}`,
          tokens: s.tokens,
        }))}
      />
      <DetailList
        title="Skills"
        rows={breakdown.skills.map((s) => ({
          key: `${s.source}/${s.name}`,
          label: s.name,
          meta: s.source,
          tokens: s.tokens,
        }))}
      />
      <DetailList
        title="Agents"
        rows={breakdown.agents.map((a) => ({
          key: `${a.source}/${a.agentType}`,
          label: a.agentType,
          meta: a.source,
          tokens: a.tokens,
        }))}
      />

      {deferred.length > 0 && (
        <section className="av-ctx-section av-ctx-deferred">
          {/* Deferred schemas are held OUT of the window and are explicitly
              excluded from usage math — saying so is the point of the section.
              Folding them in with `used` would report >100% on a 37%-full
              session (verified capture: 67.8K deferred against a 200K window). */}
          <h4 className="av-ctx-section-title">
            Deferred
            <span className="av-ctx-section-count">{deferred.length}</span>
          </h4>
          <ul className="av-ctx-list">
            {deferred.map((r) => (
              <li className="av-ctx-list-row" key={r.name}>
                <span className="av-ctx-list-label">{r.name}</span>
                <span className="av-ctx-list-tokens">{formatTokens(r.tokens)}</span>
              </li>
            ))}
          </ul>
          <p className="av-ctx-note">Not loaded — excluded from the totals above.</p>
        </section>
      )}
    </>
  );
}

/**
 * The popover shell: dismiss on outside click / Escape, matching the other
 * `av-*` popovers (RemoteControl, McpPopover). Anchored by the caller's
 * positioned wrapper.
 */
export function ContextBreakdownPanel({
  usage,
  onDismiss,
}: {
  usage: ContextUsage;
  onDismiss: () => void;
}) {
  const breakdown = buildContextBreakdown(usage);
  const ref = React.useRef<HTMLDivElement | null>(null);

  React.useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onDismiss();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        // The gauge is inside the composer card; without stopping propagation
        // the same Escape would also reach the composer's own handler.
        e.stopPropagation();
        onDismiss();
      }
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [onDismiss]);

  // Defensive: the trigger is only rendered when `hasBreakdown` is true, so
  // this should be unreachable. It exists so a future caller that forgets the
  // gate degrades to nothing rather than to an empty popover.
  if (!breakdown) return null;

  return (
    <div className="av-ctx-panel" role="dialog" aria-label="Context breakdown" ref={ref}>
      <ContextBreakdownBody usage={usage} breakdown={breakdown} />
    </div>
  );
}
