import React from 'react';
import { inputStr } from './tool-util';

interface Props {
  /** Tool name — 'Edit' or 'Write'. */
  name: string;
  input: Record<string, unknown> | undefined;
}

/**
 * A compact summary of a Write/Edit tool call, reconstructed from the tool_use
 * INPUT (per Phase 0 spike finding g: the tool_result is plain success text, so
 * the change info MUST come from the input).
 *
 * This used to render a full Monaco `DiffEditor`, but every mounted Edit/Write
 * card (they default-open) spun up an editor instance — Monaco is by far the
 * heaviest thing the structured view mounts, and with many workspaces mounted
 * at once it was the dominant driver of the GPU-process crash that turned the
 * whole content area black. We now show just the file path and a +added/−removed
 * line count; no editor, no diff body, effectively zero GPU/memory cost. (Monaco
 * has been removed from the app entirely.)
 *
 *  • **Edit** — `old_string` → `new_string` are both in the input, so the line
 *    counts are the added/removed lines of the edited region.
 *  • **Write** — only `content` exists (a brand-new file body), so every line
 *    counts as added; flagged as "new file".
 */
function ToolDiffImpl({ name, input }: Props) {
  const filePath = inputStr(input, 'file_path');
  const isWrite = name === 'Write';
  const original = isWrite ? '' : inputStr(input, 'old_string');
  const modified = isWrite ? inputStr(input, 'content') : inputStr(input, 'new_string');

  // An empty string splits to `['']` (1 element), so treat "no text" as 0 lines
  // rather than 1 — otherwise a pure insertion/deletion reads as "1 line" off.
  const countLines = (s: string) => (s === '' ? 0 : s.split('\n').length);
  const added = countLines(modified);
  const removed = countLines(original);

  return (
    <div className="av-diff av-diff-summary">
      <span className="av-diff-path" title={filePath}>
        {filePath || '(unknown file)'}
      </span>
      <span className="av-diff-kind">
        {isWrite ? 'new file' : 'edit'}
      </span>
      <span className="av-diff-counts">
        {added > 0 && <span className="av-diff-add">{`+${added}`}</span>}
        {removed > 0 && <span className="av-diff-del">{`−${removed}`}</span>}
      </span>
    </div>
  );
}

export const ToolDiff = React.memo(ToolDiffImpl);
