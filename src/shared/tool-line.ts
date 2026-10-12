// ONE tool line for both surfaces (#374): the label (`Bash · run the suite`, `Edit · shared/foo.ts`, MCP `server.tool`), the state
// (running / ok / error) and its glyph. The phone's conversation projection (acces-mobile-conversation.ts) and the desktop's
// render-item builder (agent-render-items.ts) both call `toolLine` — never a second label implementation. Pure: no fs, no Electron.

import type { RenderMessage } from './types.ts';

export type ToolState = 'running' | 'ok' | 'error';

/** The glyph of a state — the phone page injects this same map into its script. */
export const TOOL_GLYPH: Record<ToolState, string> = { running: '…', ok: '✓', error: '✗' };

export const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}…` : s);
export const oneLine = (s: string, n = 120): string => clip(s.replace(/\s+/g, ' ').trim(), n);

/** The one thing worth reading about a tool call, per well-known tool; else the first string input. */
export function toolLabel(name: string, input: Record<string, unknown> | undefined): string {
  const s = (k: string): string | undefined => (typeof input?.[k] === 'string' ? (input[k] as string) : undefined);
  const base = (p: string | undefined): string | undefined => (p ? p.split('/').filter(Boolean).slice(-2).join('/') : undefined);
  let detail: string | undefined;
  switch (name) {
    case 'Bash':
      detail = s('description') ?? s('command');
      break;
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      detail = base(s('file_path') ?? s('notebook_path'));
      break;
    case 'Grep':
    case 'Glob':
      detail = s('pattern');
      break;
    case 'WebFetch':
      detail = s('url');
      break;
    case 'WebSearch':
      detail = s('query');
      break;
    case 'Task':
    case 'Agent':
      detail = s('description');
      break;
    case 'Skill':
      detail = s('skill');
      break;
    default:
      detail = input ? (Object.values(input).find((v) => typeof v === 'string') as string | undefined) : undefined;
  }
  const short = name.startsWith('mcp__') ? name.split('__').slice(1).join('.') : name;
  return detail ? `${short} · ${oneLine(detail, 100)}` : short;
}

/** running until the result lands, then error (`isError`) or ok. */
export function toolState(m: Pick<RenderMessage, 'toolResult'>): ToolState {
  return !m.toolResult ? 'running' : m.toolResult.isError ? 'error' : 'ok';
}

/** The line of a `tool` message — what both surfaces show for it. */
export function toolLine(m: Pick<RenderMessage, 'toolUse' | 'toolResult'>): { label: string; state: ToolState } {
  return { label: toolLabel(m.toolUse?.name || 'tool', m.toolUse?.input), state: toolState(m) };
}
