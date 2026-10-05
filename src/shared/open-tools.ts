// Open tool calls of a structured session — the hook-independent answer to "which calls did a Pause interrupt" (#255 review M2). Pure.

import { summarizeToolInput } from './tool-input-summary.ts';

export interface OpenTool {
  tool: string;
  input: string | null;
  startedAt: number;
}
/** Bound on the map (a runaway stream must not grow it without limit): the OLDEST entries go first. */
export const OPEN_TOOLS_CAP = 200;

/** The slice of an `AgentEvent` the reducer reads (structural: src/shared never imports the full union here). */
export interface ToolEventLike {
  type: string;
  toolUseId?: string | null;
  name?: string;
  input?: unknown;
}

/** Fold one event into the open set: `tool-use` opens (bounded), `tool-result` closes, `turn-end` clears (a call can never outlive its turn). Returns the call's input
 *  summary for a `tool-use` (so the caller can feed the hook-side detail tracker), else null. */
export function applyToolEvent(open: Map<string, OpenTool>, ev: ToolEventLike, now: number = Date.now()): string | null {
  if (ev.type === 'tool-use' && typeof ev.toolUseId === 'string') {
    const input = summarizeToolInput(ev.name, ev.input);
    open.set(ev.toolUseId, { tool: ev.name ?? '?', input, startedAt: now });
    while (open.size > OPEN_TOOLS_CAP) open.delete(open.keys().next().value as string);
    return input;
  }
  if (ev.type === 'tool-result' && typeof ev.toolUseId === 'string') open.delete(ev.toolUseId);
  else if (ev.type === 'turn-end') open.clear();
  return null;
}

/** The in-flight list a Bilan records. A live SDK session object is AUTHORITATIVE (its stream saw every call open and close): the hook-fed tracker is read ONLY when there is
 *  no SDK session (a terminal agent, a keeper that survived an app restart) — merging both strands a hook entry whose `tool_result` hook was dropped and duplicates id-less ones. */
export function mergeInFlight<T>(sdkSide: readonly T[] | null, hookSide: readonly T[]): T[] {
  return sdkSide !== null ? [...sdkSide] : [...hookSide];
}
