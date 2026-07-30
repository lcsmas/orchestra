/** Composer syntax highlighting — splits the composer text into styled runs so
 *  the structured view can paint a `/skill` or `!bash` prefix (CC-desktop
 *  parity) behind a transparent textarea.
 *
 *  Pure string logic on purpose: it lives here (not in the component) so it is
 *  unit-testable without Electron or a DOM, per the repo's testing convention.
 */

/** A run of composer text. `token` is null for ordinary prose. */
export interface HighlightPart {
  text: string;
  token: 'skill' | 'bash' | null;
}

/** The command name of a leading slash-command: `/ship`, `/orchestra-spawn`.
 *  Anchored at the start and followed by end-of-input or whitespace, so a bare
 *  path like `/etc/hosts` or mid-sentence `and/or` never highlights. */
const LEADING_SKILL = /^\/([A-Za-z0-9_-]+)(?=$|\s)/;

/** Split `text` into runs for the highlight mirror.
 *
 *  Only the LEADING token is highlighted, matching Claude Code desktop: the
 *  prefix is what changes how the whole message is dispatched, so highlighting
 *  a `/word` in the middle of a sentence would imply a behavior that won't
 *  happen. Returns a single untokenized run for ordinary text.
 */
export function highlightComposer(text: string): HighlightPart[] {
  if (!text) return [];

  // Bash mode: the whole line is a shell command, so the `!` marker is the
  // token and the remainder stays prose (it is not a skill name).
  if (text.startsWith('!')) {
    const parts: HighlightPart[] = [{ text: '!', token: 'bash' }];
    if (text.length > 1) parts.push({ text: text.slice(1), token: null });
    return parts;
  }

  const m = LEADING_SKILL.exec(text);
  if (m) {
    const head = m[0];
    const rest = text.slice(head.length);
    const parts: HighlightPart[] = [{ text: head, token: 'skill' }];
    if (rest) parts.push({ text: rest, token: null });
    return parts;
  }

  return [{ text, token: null }];
}
