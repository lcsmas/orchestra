// One-line summary of a tool call's INPUT (what a member was running when a Pause interrupted its turn) — pure, bounded. The Bilan de pause keeps it so a
// Consigne de reprise can say "the interrupt aborted `npm test`" instead of only "a Bash was in flight" (#255 review M2).

const MAX_CHARS = 300;
const KEYS = ['file_path', 'path', 'pattern', 'url', 'query', 'description', 'prompt'] as const;

/** `Bash` → its command; any other tool → its first descriptive field (`key=value`), else a bounded JSON; null when there is nothing to say. */
export function summarizeToolInput(name: string | null | undefined, input: unknown): string | null {
  if (!input || typeof input !== 'object') return null;
  const o = input as Record<string, unknown>;
  const clip = (s: string): string => (s.length > MAX_CHARS ? `${s.slice(0, MAX_CHARS - 1)}…` : s);
  if (name === 'Bash' && typeof o.command === 'string' && o.command.trim()) return clip(o.command.trim());
  for (const k of KEYS) {
    const v = o[k];
    if (typeof v === 'string' && v.trim()) return clip(`${k}=${v.trim()}`);
  }
  try {
    const j = JSON.stringify(o);
    return j && j !== '{}' ? clip(j) : null;
  } catch {
    return null;
  }
}
