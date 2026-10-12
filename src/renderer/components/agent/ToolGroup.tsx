import React, { useState } from 'react';
import type { ToolRow } from '../../../shared/agent-render-items';
import { TOOL_GLYPH, type ToolState } from '../../../shared/tool-line';
import { ToolCard } from './ToolCard';
import { toolRowsEqual } from './tool-util';

interface Props {
  /** A run of consecutive tool lines (length ≥ 1) — built by `buildRenderItems` with the phone's shared label + state. */
  rows: ToolRow[];
  /** Ids of the lines that start open — for the SSR render smoke only (the click is the real way to open one). */
  defaultOpenIds?: readonly string[];
}

const STATE_WORD: Record<ToolState, string> = { running: 'running', ok: 'done', error: 'failed' };

/**
 * A run of tool calls as the phone shows it (#374): ONE always-visible line per tool — the state glyph (… running /
 * ✓ ok / red ✗ failed) and the label (`Bash · description`, `Edit · dir/file`, MCP `server.tool`…) — consecutive
 * lines in one compact block. Clicking a line opens that tool's {@link ToolCard} under it (command, output, diff);
 * a second click closes it. No summary row, no ±diff on a line.
 *
 * Memoized on the rows' label/state and the tool messages (`toolRowsEqual`), so an unrelated delta elsewhere doesn't re-render the group.
 */
function ToolGroupImpl({ rows, defaultOpenIds }: Props) {
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set(defaultOpenIds));
  const toggle = (id: string) =>
    setOpen((cur) => {
      const next = new Set(cur);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  return (
    <div className="av-tool-run">
      {rows.map((r) => {
        const isOpen = open.has(r.id);
        return (
          <div
            key={r.id}
            className={`av-tool-line av-tool-line-${r.state} ${isOpen ? 'av-open' : 'av-closed'}`}
            data-state={r.state}
            data-tool-id={r.id}
          >
            <button type="button" className="av-tool-line-head" aria-expanded={isOpen} onClick={() => toggle(r.id)}>
              <span className="av-tool-line-glyph" role="img" aria-label={STATE_WORD[r.state]}>
                {TOOL_GLYPH[r.state]}
              </span>
              <span className="av-tool-line-label">{r.label}</span>
            </button>
            {isOpen && (
              <div className="av-tool-line-body">
                <ToolCard message={r.message} startOpen />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

export const ToolGroup = React.memo(ToolGroupImpl, (a, b) => toolRowsEqual(a.rows, b.rows));
