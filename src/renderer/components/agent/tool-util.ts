import type { RenderMessage } from '../../../shared/types';

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

/** Count non-empty lines in a string (empty → 0, not 1). Shared with ToolDiff. */
export function countLines(s: string): number {
  return s === '' ? 0 : s.split('\n').length;
}

/** Added/removed line counts for a Write/Edit tool, reconstructed from the input
 *  (the tool_result is plain success text — see the Phase-0 spike). A Write is a
 *  brand-new file so every line is added; an Edit diffs old_string→new_string. */
export function diffCounts(
  name: string,
  input: Record<string, unknown> | undefined,
): { added: number; removed: number } {
  const isWrite = name === 'Write';
  const original = isWrite ? '' : inputStr(input, 'old_string');
  const modified = isWrite ? inputStr(input, 'content') : inputStr(input, 'new_string');
  return { added: countLines(modified), removed: countLines(original) };
}

/** A minimal view of a tool for summarizing a run — just its name and input.
 *  RenderMessage satisfies it via `{ name: toolUse?.name, input: toolUse?.input }`. */
export interface ToolLike {
  name: string;
  input: Record<string, unknown> | undefined;
}

/** Aggregate red/green diff counts across a run of tools (only Edit/Write
 *  contribute). Backs the inline "+134 −0" on the collapsed summary row. */
export function aggregateDiff(tools: ToolLike[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const t of tools) {
    if (t.name === 'Edit' || t.name === 'Write') {
      const c = diffCounts(t.name, t.input);
      added += c.added;
      removed += c.removed;
    }
  }
  return { added, removed };
}

/** Pluralize a noun by count: `plural(1,'file') → '1 file'`, `plural(3,'file') → '3 files'`. */
function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

/**
 * A Claude-Code-desktop-style verb summary for a run of tool calls — the muted
 * one-line label on a collapsed tool row. Groups by the *action*, not the tool
 * name:
 *
 *   • all Write/Edit          → "Created 5 files"  /  "Created types.ts"  (single, named)
 *   • all Read                → "Read 3 files"     /  "Read types.ts"
 *   • all Bash                → "Ran 2 commands"   /  "Ran a command"
 *   • Bash + exactly one more → "Ran a command, used a tool"
 *   • anything else / mixed   → "Used 6 tools"     /  "Used a tool"
 *
 * The diff counts (from {@link aggregateDiff}) are rendered separately by the
 * caller so they can carry their own red/green color, so this returns text only.
 */
export function describeToolRun(tools: ToolLike[]): string {
  if (tools.length === 0) return 'Used a tool';

  const names = tools.map((t) => t.name || 'tool');
  const allSame = (n: string) => names.every((x) => x === n);
  const isCreate = (n: string) => n === 'Write' || n === 'Edit';

  // Single file/command reads nicer with its name than "1 file".
  const singleName = (): string => {
    const only = tools[0];
    return (
      inputStr(only.input, 'file_path') ||
      inputStr(only.input, 'pattern') ||
      inputStr(only.input, 'command') ||
      ''
    );
  };

  if (names.every(isCreate)) {
    if (tools.length === 1) {
      const f = fileBase(inputStr(tools[0].input, 'file_path'));
      return f ? `Created ${f}` : 'Created a file';
    }
    return `Created ${plural(tools.length, 'file')}`;
  }
  if (allSame('Read')) {
    if (tools.length === 1) {
      const f = fileBase(inputStr(tools[0].input, 'file_path'));
      return f ? `Read ${f}` : 'Read a file';
    }
    return `Read ${plural(tools.length, 'file')}`;
  }
  if (allSame('Bash')) {
    return tools.length === 1 ? 'Ran a command' : `Ran ${plural(tools.length, 'command')}`;
  }
  // Bash + exactly one other tool → the claude.ai "Ran a command, used a tool".
  const bashCount = names.filter((n) => n === 'Bash').length;
  if (bashCount >= 1 && tools.length - bashCount >= 1) {
    const others = tools.length - bashCount;
    const cmdPart = bashCount === 1 ? 'Ran a command' : `Ran ${plural(bashCount, 'command')}`;
    const toolPart = others === 1 ? 'used a tool' : `used ${plural(others, 'tool')}`;
    return `${cmdPart}, ${toolPart}`;
  }
  if (allSame('Grep') || allSame('Glob')) {
    if (tools.length === 1) {
      const only = singleName();
      return only ? `Searched for ${only}` : 'Searched';
    }
    return `Searched ${tools.length} times`;
  }
  if (allSame('Skill')) {
    if (tools.length === 1) {
      const n = skillName(tools[0].input);
      return n ? `Used a skill ${n}` : 'Used a skill';
    }
    return `Used ${plural(tools.length, 'skill')}`;
  }
  // Everything else: a plain tool count.
  return tools.length === 1 ? 'Used a tool' : `Used ${plural(tools.length, 'tool')}`;
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

/** Last path segment of a file path (`src/a/b.ts` → `b.ts`); '' when empty. */
export function fileBase(p: string): string {
  if (!p) return '';
  const parts = p.replace(/\/+$/, '').split('/');
  return parts[parts.length - 1] || p;
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
  }
  return true;
}
