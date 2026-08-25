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
  computeCtxShift,
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
          // pluginName is part of the key AND the meta (issue #31): it is the
          // only thing distinguishing two plugins' same-named skills, so
          // omitting it risks duplicate React keys and an ambiguous row. Shown
          // as the source when present, since "plugin" alone says less than
          // which plugin.
          key: `${s.source}/${s.pluginName ?? ''}/${s.name}`,
          label: s.name,
          meta: s.pluginName ?? s.source,
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

  // Keep the panel inside the viewport horizontally (issue #35).
  //
  // The panel is `position:absolute; left:0` off `.av-ctx-anchor`, with a FIXED
  // 320px width — so whether it fits is purely a function of how far right the
  // gauge sits. Measured on the built app at the enforced minimum window width
  // (`minWidth:900`, src/main/index.ts): dragging the sidebar to its max (560,
  // clamped in App.tsx) puts the panel's right edge at 1097.63 against a 900px
  // viewport — 197.63px, 62% of it, off-screen. The exact sidebar width at
  // which overflow BEGINS is RIG-DEPENDENT (it moves with chrome height and
  // font metrics): this rig saw the last fit at 360, an independent second rig
  // at 350. Do not quote a threshold as a constant — what is stable is that the
  // wide end of the sidebar range overflows and the narrow end does not.
  //
  // WHY THIS IS JS AND NOT A CSS ONE-LINER — both cheaper fixes were measured
  // and REJECTED, so don't "simplify" this back into them:
  //   • `max-width:calc(100vw - 16px)` (the fix issue #35 itself suggests) is a
  //     NO-OP. It binds only if 100vw-16px < the panel's width; at vw=900 that
  //     is 884px vs a 320px panel, so it never applies at any reachable width.
  //     The panel is MISPOSITIONED, not too wide.
  //   • An unconditional `right:0` flip fixes the right edge but RE-ANCHORS
  //     UNCONDITIONALLY, moving the panel even where it already fitted
  //     (measured at sidebar=240: left 463.89 -> 211.73). THAT is the
  //     disqualifier. An earlier note here claimed it pushed the panel to
  //     left=-248px; that reading came from forcing the anchor to x=4 with an
  //     inline style, a state `SIDEBAR_WIDTH_MIN = 240` makes UNREACHABLE, so
  //     it is not a real-world argument. The conclusion stood, the reason did
  //     not — recorded so this is not re-litigated. (`computeCtxShift` still
  //     clamps the left edge: that guard is about the panel being wider than
  //     the viewport, which IS reachable.)
  //   • `position:fixed` (which WOULD make a pure-CSS clamp possible, since the
  //     containing block becomes the viewport) breaks the vertical axis —
  //     `bottom:calc(100% + 8px)` then resolves against the viewport and the
  //     panel's bottom measured 1108px on a 871px-tall viewport.
  // So we shift left by exactly the overhang, and by ZERO once the panel is
  // clear of the gutter. NOTE the shift engages slightly BEFORE the panel truly
  // overflows, because the gutter is inside the overhang: at sidebar=355 the
  // panel still fitted (right=894.4 < 900) yet took a 4.49px shift. Intended —
  // the gutter is what keeps it off the window edge — so placement is unchanged
  // in the common case but NOT byte-identical right at the boundary. The
  // vertical contract (`max-height:60vh` + internal scroll) is untouched.
  React.useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const apply = () => {
      // Clear first so we measure the panel's UNSHIFTED position — otherwise a
      // previous shift is baked into the reading and the correction compounds
      // toward zero on every resize.
      el.style.removeProperty('--av-ctx-shift');
      const rect = el.getBoundingClientRect();
      // The arithmetic (gutter, the zero floor, the left-edge cap) lives in
      // `computeCtxShift` so the unit suite can execute it — a decision sited
      // in this .tsx would be untestable, which is the documented failure mode
      // this component's sibling comment in TurnFooter.tsx warns about. This
      // effect only MEASURES and APPLIES.
      const shift = computeCtxShift({
        left: rect.left,
        right: rect.right,
        innerWidth: window.innerWidth,
      });
      if (shift > 0) el.style.setProperty('--av-ctx-shift', `${shift}px`);
    };
    apply();
    window.addEventListener('resize', apply);
    return () => {
      window.removeEventListener('resize', apply);
    };
  }, [breakdown]);

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
