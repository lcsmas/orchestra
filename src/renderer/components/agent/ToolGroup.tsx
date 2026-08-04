import React, { useMemo, useState } from 'react';
import type { RenderMessage } from '../../../shared/types';
import { ToolCard } from './ToolCard';
import { describeToolRun, aggregateDiff, type ToolLike } from './tool-util';

interface Props {
  /** A run of consecutive `tool` messages (length ≥ 1). */
  tools: RenderMessage[];
}

/**
 * A run of tool calls, rendered collapsed by default in the Claude-Code desktop
 * style: ONE muted, low-contrast one-line row —
 *
 *   › Created 5 files  +134 −0
 *   › Used 6 tools
 *   › Ran a command, used a tool
 *
 * — with an inline red/green diff count when any Edit/Write is in the run (no
 * per-tool icons, and no status dot at all — the verb label carries the meaning,
 * Claude-Code-desktop style). "Running" survives only as a visually-hidden word
 * for screen readers; the visible row is identical whatever the run's state.
 * The whole row is a plain
 * clickable label; expanding reveals the individual
 * {@link ToolCard}s. A LONE tool renders the same compact row (not a full card),
 * so a single tool call is just as quiet as a run — the transcript stays about
 * the assistant's prose, and tool detail is one click away.
 *
 * Memoized on the tools' identity + result/done state so an unrelated delta
 * elsewhere doesn't re-render the whole group.
 */
function ToolGroupImpl({ tools }: Props) {
  const [open, setOpen] = useState(false);

  const toolLikes: ToolLike[] = useMemo(
    () => tools.map((t) => ({ name: t.toolUse?.name ?? 'tool', input: t.toolUse?.input })),
    [tools],
  );
  const label = useMemo(() => describeToolRun(toolLikes), [toolLikes]);
  const diff = useMemo(() => aggregateDiff(toolLikes), [toolLikes]);

  // A failed tool gets NO special treatment on the collapsed row — a non-zero
  // exit is routine (a grep that matched nothing, a probe that was meant to
  // fail), and colouring the whole run red cries wolf. The failure is still
  // visible where it matters: expand the run and the individual ToolCard keeps
  // its error tint + stderr.
  const anyPending = tools.some((t) => !t.toolResult && !t.done);
  const statusKind = anyPending ? 'pending' : 'ok';

  return (
    <div className={`av-tool-run ${open ? 'av-open' : 'av-closed'} av-tool-run-${statusKind}`}>
      <button
        type="button"
        className="av-tool-run-header"
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
        <span className="av-tool-run-label">{label}</span>
        {(diff.added > 0 || diff.removed > 0) && (
          <span className="av-tool-run-diff">
            {diff.added > 0 && <span className="av-diff-add">{`+${diff.added}`}</span>}
            {diff.removed > 0 && <span className="av-diff-del">{`−${diff.removed}`}</span>}
          </span>
        )}
        {anyPending && <span className="av-sr-only">running</span>}
      </button>
      {open && (
        <div className="av-tool-run-body">
          {tools.map((t) => (
            <ToolCard key={t.id} message={t} />
          ))}
        </div>
      )}
    </div>
  );
}

/** "2 Read · 1 Bash · 1 Skill" — counts per tool name, in first-seen order.
 *  Retained for tests / callers that want the name-count breakdown. */
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
      x.toolUse?.name !== y.toolUse?.name ||
      // input identity affects the label/diff counts (finalized once).
      x.toolUse?.input !== y.toolUse?.input
    ) {
      return false;
    }
  }
  return true;
}

export const ToolGroup = React.memo(ToolGroupImpl, areEqual);
