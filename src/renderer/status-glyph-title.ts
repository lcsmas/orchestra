// The status tooltip string, split out of WorkspaceStatusGlyph.tsx so it is
// unit-testable: node:test cannot import a .tsx (JSX doesn't parse under
// --experimental-strip-types), and this is the only logic in that component
// with branches worth guarding. The component re-exports it, so every existing
// import site is unchanged.

import type { Workspace } from '../shared/types.ts';
import { THINKING_TOOL_LABEL } from '../shared/types.ts';

/** Tooltip for a workspace's status marker, wherever agents are listed (sidebar
 *  rows, Inbox, jump palette, Resources table).
 *
 *  `tool` is the ephemeral `agent:tool` label: a real tool name (Bash, Edit, …)
 *  while one is running, or {@link THINKING_TOOL_LABEL} in the gap between
 *  tools where the model is generating. */
export function statusGlyphTitle(
  w: Pick<Workspace, 'status' | 'markedUnread' | 'hibernatedAt'>,
  tool?: string,
): string {
  if (w.markedUnread) return 'Tagged unread — come back to this workspace';
  if (w.hibernatedAt !== undefined)
    return 'Agent is hibernated — process stopped to free memory, resumes on input';
  // The thinking sentinel is NOT a tool name — it marks the between-tools gap
  // (main sets it on submit/posttool). Render it as its own phrase rather than
  // "(thinking)", which would read like a tool called "thinking". Any other
  // label IS a real tool name and keeps the parenthesised form.
  if (w.status === 'running' && tool === THINKING_TOOL_LABEL) return 'Agent is thinking…';
  if (w.status === 'running') return tool ? `Agent is working… (${tool})` : 'Agent is working…';
  if (w.status === 'idle') return 'Agent is idle';
  if (w.status === 'waiting') return 'Agent is waiting for you';
  if (w.status === 'error') return 'Agent hit an error';
  return w.status;
}
