import React, { useMemo, useState } from 'react';
import type { RenderMessage } from '../../../shared/types';
import { ToolCard } from './ToolCard';
import { ToolIcon } from './tool-icons';

interface Props {
  /** A run of consecutive `tool` messages (length ≥ 1). */
  tools: RenderMessage[];
}

/**
 * A run of consecutive tool calls, rendered collapsed by default (Claude-Code
 * app style): a single summary row — "2 Read · 1 Bash · 1 Skill" — with one
 * overall status, that expands to reveal every individual {@link ToolCard}.
 *
 * A single tool in the run is shown expanded-as-a-plain-card (no summary
 * wrapper) so a lone tool call still reads exactly as before. Two or more fold
 * into the collapsible summary.
 *
 * Memoized on the tools' identity + result/done state so an unrelated delta
 * elsewhere doesn't re-render the whole group.
 */
function ToolGroupImpl({ tools }: Props) {
  // A lone tool renders as its own card — nothing to aggregate.
  if (tools.length === 1) {
    return <ToolCard message={tools[0]} />;
  }
  return <ToolGroupMany tools={tools} />;
}

function ToolGroupMany({ tools }: Props) {
  const [open, setOpen] = useState(false);

  // Count by tool name in run order, e.g. [["Read",2],["Bash",1]] → "2 Read · 1 Bash".
  const summary = useMemo(() => summarizeToolRun(tools), [tools]);

  const anyError = tools.some((t) => t.toolResult?.isError === true);
  const anyPending = tools.some((t) => !t.toolResult && !t.done);
  const statusKind = anyError ? 'error' : anyPending ? 'pending' : 'ok';
  const statusLabel = anyError ? 'failed' : anyPending ? 'running' : 'done';

  return (
    <div className={`av-tool-group ${open ? 'av-open' : 'av-closed'}`}>
      <button
        type="button"
        className="av-tool-group-header"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <span className={`av-caret ${open ? 'av-caret-open' : ''}`} aria-hidden>
          <svg
            width="10"
            height="10"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M5.5 3 10.5 8 5.5 13" />
          </svg>
        </span>
        {/* Distinct tool-type icons in run order (deduped), so the row reads at
            a glance even before the text. */}
        <span className="av-tool-group-icons" aria-hidden>
          {distinctNames(tools).map((n) => (
            <ToolIcon key={n} name={n} />
          ))}
        </span>
        <span className="av-tool-group-summary">{summary}</span>
        <span
          className={`av-tool-group-status av-tool-group-status-${statusKind}`}
        >
          <span className="av-tool-group-status-dot" aria-hidden />
          <span className="av-sr-only">{statusLabel}</span>
        </span>
        <span className="av-tool-group-count">{tools.length}</span>
      </button>
      {open && (
        <div className="av-tool-group-body">
          {tools.map((t) => (
            <ToolCard key={t.id} message={t} />
          ))}
        </div>
      )}
    </div>
  );
}

/** Distinct tool names in first-seen order (for the icon strip). */
function distinctNames(tools: RenderMessage[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of tools) {
    const n = t.toolUse?.name ?? 'tool';
    if (!seen.has(n)) {
      seen.add(n);
      out.push(n);
    }
  }
  return out;
}

/** "2 Read · 1 Bash · 1 Skill" — counts per tool name, in first-seen order. */
export function summarizeToolRun(tools: RenderMessage[]): string {
  const order: string[] = [];
  const counts = new Map<string, number>();
  for (const t of tools) {
    const n = t.toolUse?.name ?? 'tool';
    if (!counts.has(n)) order.push(n);
    counts.set(n, (counts.get(n) ?? 0) + 1);
  }
  return order.map((n) => `${counts.get(n)} ${n}`).join(' · ');
}

function areEqual(a: Props, b: Props): boolean {
  if (a.tools.length !== b.tools.length) return false;
  for (let i = 0; i < a.tools.length; i++) {
    const x = a.tools[i];
    const y = b.tools[i];
    if (
      x.id !== y.id ||
      x.done !== y.done ||
      x.toolResult?.isError !== y.toolResult?.isError ||
      !!x.toolResult !== !!y.toolResult ||
      x.toolUse?.name !== y.toolUse?.name
    ) {
      return false;
    }
  }
  return true;
}

export const ToolGroup = React.memo(ToolGroupImpl, areEqual);
