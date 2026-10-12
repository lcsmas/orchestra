import type { AgentToolNonExecutionKind, RenderMessage } from '../../../shared/types';
import type { ToolRow } from '../../../shared/agent-render-items';

/**
 * Flatten a `tool_result` content payload into displayable plain text. The SDK
 * sends most results as a string, but MAY send a content-block array for richer
 * results (which the contract passes through verbatim as `unknown[]`). We pull
 * the text out of the common block shapes and fall back to a JSON dump so nothing
 * is ever silently dropped.
 */
export function resultText(content: string | unknown[] | undefined): string {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block === 'string') {
      parts.push(block);
    } else if (block && typeof block === 'object') {
      const b = block as Record<string, unknown>;
      if (typeof b.text === 'string') parts.push(b.text);
      else if (typeof b.content === 'string') parts.push(b.content);
      else parts.push(JSON.stringify(block, null, 2));
    } else {
      parts.push(String(block));
    }
  }
  return parts.join('\n');
}

/** Read a string field from a tool input, or '' when absent/non-string. */
export function inputStr(input: Record<string, unknown> | undefined, key: string): string {
  const v = input?.[key];
  return typeof v === 'string' ? v : '';
}

/** Pretty-print an arbitrary value as JSON for the generic tool fallback. */
export function pretty(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/** A one-line summary of a tool's arguments for the collapsed card header. */
export function summarizeInput(name: string, input: Record<string, unknown> | undefined): string {
  if (!input) return '';
  switch (name) {
    case 'Bash':
      return inputStr(input, 'command');
    case 'Read':
    case 'Write':
    case 'Edit':
      return inputStr(input, 'file_path');
    case 'Grep':
      return inputStr(input, 'pattern');
    case 'Glob':
      return inputStr(input, 'pattern');
    case 'Task':
      return inputStr(input, 'description') || inputStr(input, 'subagent_type');
    case 'Skill':
      return skillName(input);
    case 'WebFetch':
      return inputStr(input, 'url');
    default: {
      // First string-valued arg, truncated.
      const firstStr = Object.values(input).find((v) => typeof v === 'string') as
        | string
        | undefined;
      return firstStr ?? '';
    }
  }
}

/** Truncate a single-line summary for header display. */
export function truncate(s: string, max = 120): string {
  const oneLine = s.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? oneLine.slice(0, max - 1) + '…' : oneLine;
}

/** The TodoWrite `todos` array shape, as Claude Code emits it. */
export interface TodoItem {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
  activeForm?: string;
}

/** Extract a typed todo list from a TodoWrite tool input, tolerant of shape. */
export function todosFrom(input: Record<string, unknown> | undefined): TodoItem[] {
  const raw = input?.todos;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((t): t is Record<string, unknown> => !!t && typeof t === 'object')
    .map((t) => ({
      content: typeof t.content === 'string' ? t.content : '',
      status:
        t.status === 'in_progress' || t.status === 'completed' ? t.status : 'pending',
      activeForm: typeof t.activeForm === 'string' ? t.activeForm : undefined,
    }));
}

/** The skill name from a Skill tool input. The SDK carries it on `skill` (e.g.
 *  `{skill:'ship'}`, sometimes with `args`); fall back to `command`/`name` and
 *  then the first string arg so a shape change doesn't blank the label. */
export function skillName(input: Record<string, unknown> | undefined): string {
  return (
    inputStr(input, 'skill') ||
    inputStr(input, 'command') ||
    inputStr(input, 'name') ||
    (Object.values(input ?? {}).find((v) => typeof v === 'string') as string | undefined) ||
    ''
  );
}

/** Whether two RenderMessages are equivalent for a tool card's render output. */
export function toolMessageEqual(a: RenderMessage, b: RenderMessage): boolean {
  if (a.id !== b.id || a.done !== b.done) return false;
  const au = a.toolUse;
  const bu = b.toolUse;
  if (!!au !== !!bu) return false;
  if (au && bu) {
    if (au.name !== bu.name || au.inputJson !== bu.inputJson) return false;
    // `input` is set once (finalized) — identity compare is enough.
    if (au.input !== bu.input) return false;
  }
  const ar = a.toolResult;
  const br = b.toolResult;
  if (!!ar !== !!br) return false;
  if (ar && br) {
    if (ar.isError !== br.isError || ar.content !== br.content) return false;
    // The classification drives the card's status word, so a change in it is a
    // render-visible change — omitting it here would memoize a "failed" card
    // that should read "denied".
    if (ar.nonExecutionKind !== br.nonExecutionKind) return false;
    if (ar.userFeedback !== br.userFeedback) return false;
  }
  return true;
}

/** Whether two tool-line runs render the same (ToolGroup's memo): a line whose result just landed (… → ✓) must NOT compare equal. */
export function toolRowsEqual(a: ToolRow[], b: ToolRow[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].id !== b[i].id || a[i].label !== b[i].label || a[i].state !== b[i].state || !toolMessageEqual(a[i].message, b[i].message)) return false;
  }
  return true;
}

/** Human label for a structurally-classified non-execution, or `null` when the
 *  tool genuinely ran and failed (no sidecar, or an unknown kind).
 *
 *  This is the STRUCTURAL replacement for matching result prose: the CLI stamps
 *  `non_execution_kind` on its `tool_result_meta` sidecar and its own contract
 *  says clients read that "instead of string-matching the result prose". The
 *  three automode-* kinds collapse to one user-facing word — the distinction is
 *  about WHY automode declined, which the result body already explains. */
export function nonExecutionLabel(
  kind: AgentToolNonExecutionKind | null | undefined,
): string | null {
  switch (kind) {
    case 'user-rejected':
    case 'permission-rule':
      return 'denied';
    case 'automode-blocked':
    case 'automode-unavailable':
    case 'automode-parsing-error':
      return 'blocked';
    case 'interrupted':
      return 'interrupted';
    case 'cancelled':
      return 'cancelled';
    default:
      return null;
  }
}
