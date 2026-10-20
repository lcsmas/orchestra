// The `/` autocomplete's items — ONE source for the desktop composer (StructuredView) and the phone (Accès mobile).
// `slashQuery` and `filterSlashItems` are self-contained: the phone page injects their source with `toString()`.

import type { AgentSkillInfo } from './types';

/** One autocomplete row: an on-disk skill, or a built-in CLI slash command (`session/init`'s `slash_commands`). */
export interface SlashItem {
  name: string;
  description: string;
  source: AgentSkillInfo['source'] | 'builtin';
}

/** Descriptions for the built-ins worth explaining; the rest show bare. */
export const BUILTIN_DESC: Record<string, string> = {
  clear: 'Start a fresh conversation (clears the transcript)',
  compact: 'Compact the conversation to free context',
  usage: 'Show plan usage / rate-limit status',
  mcp: 'Manage MCP servers — status, enable/disable, reconnect',
};

/** Desktop: commands Orchestra guarantees whatever the CLI reports (`clear` / `mcp` are handled Orchestra-side by the composer). */
export const DESKTOP_ALWAYS = ['clear', 'compact', 'mcp'];

/** Phone: the desktop composer intercepts these Orchestra-side; the phone's send goes straight to the CLI, so they are not offered. */
export const PHONE_EXCLUDED = new Set(['clear', 'mcp', 'status']);

/** The query when `text` is exactly a slash-command prefix (`/`, `/shi`, `/slack:st`), else null. */
export function slashQuery(text: string): string | null {
  const m = /^\/([A-Za-z0-9_:-]*)$/.exec(text);
  return m ? m[1].toLowerCase() : null;
}

/** Skills first (they win a name clash), then `always` + the CLI's built-ins, deduped case-insensitively. Unfiltered. */
export function mergeSlashItems(
  skills: readonly AgentSkillInfo[],
  slashCommands: readonly string[] | undefined,
  always: readonly string[],
  exclude: ReadonlySet<string> = new Set(),
): SlashItem[] {
  const items: SlashItem[] = [];
  const have = new Set<string>();
  const add = (it: SlashItem): void => {
    const k = it.name.toLowerCase();
    if (!it.name || have.has(k) || exclude.has(k)) return;
    have.add(k);
    items.push(it);
  };
  for (const s of skills) add(s);
  for (const raw of [...always, ...(slashCommands ?? [])]) {
    const name = raw.replace(/^\//, '');
    add({ name, description: BUILTIN_DESC[name] ?? '', source: 'builtin' });
  }
  return items;
}

/** Substring match on the name; prefix matches first, then alphabetical; at most `limit`. */
export function filterSlashItems<T extends { name: string }>(items: readonly T[], query: string, limit: number): T[] {
  const q = query.toLowerCase();
  return items
    .filter((s) => s.name.toLowerCase().includes(q))
    .sort((a, b) => {
      const ap = a.name.toLowerCase().startsWith(q) ? 0 : 1;
      const bp = b.name.toLowerCase().startsWith(q) ? 0 : 1;
      return ap - bp || a.name.localeCompare(b.name);
    })
    .slice(0, limit);
}
