/** Compose a set of review annotations into ONE revision prompt for the agent.
 *
 *  Why one prompt rather than one message per comment: every delivery path
 *  (`sdkDeliver` → next turn, `sdkStartAndDeliver` → wake, or the PTY fallback)
 *  costs the agent a full turn, and N separate turns would make it revise
 *  against a moving file N times. Batching also lets the agent see the review as
 *  a whole, which is how a human reviewer's comments are meant to be read.
 *
 *  Kept pure and in `src/shared/` so the exact prompt text is asserted by tests
 *  instead of being discovered after it reaches an agent — a malformed anchor
 *  (missing line number, wrong path) sends the agent editing the wrong place,
 *  and that failure is silent. */

export interface DiffAnnotation {
  /** Stable id for renderer-local state (dedupe, delete). */
  id: string;
  /** Post-image file path, repo-relative — what the agent will open. */
  path: string;
  /** 1-based line number on the side the comment was anchored to. */
  line: number;
  /** Which side the gutter click landed on. A comment on a deleted line refers
   *  to the OLD file, so the prompt says so rather than quoting a line number
   *  that no longer exists in the new file. */
  side: 'old' | 'new';
  /** The diff line's text, quoted back so the agent can locate the spot even if
   *  line numbers have drifted since the review was written. */
  code: string;
  /** The reviewer's markdown comment. */
  body: string;
}

/** Indent every line of a block by two spaces so it nests under its list item
 *  and markdown doesn't terminate the item at the first blank line. */
function indentBlock(text: string): string {
  return text
    .split('\n')
    .map((l) => (l.trim() === '' ? '' : `  ${l}`))
    .join('\n');
}

/** Trim a quoted source line so a 400-char minified line doesn't swamp the
 *  prompt. The anchor is the file:line; the quote is only an aid. */
function clipCode(code: string, max = 160): string {
  const t = code.replace(/\t/g, '  ').trimEnd();
  if (t.length <= max) return t;
  return `${t.slice(0, max - 1)}…`;
}

export interface ComposeOptions {
  /** Branch under review — orients the agent when the prompt arrives cold via a
   *  wake (it has no memory of the review pane being open). */
  branch?: string;
  /** 'uncommitted' | 'base' — which scope the reviewer was looking at. Changes
   *  the instruction: uncommitted work is edited in place, whereas a vs-base
   *  review may span already-committed code. */
  scope?: 'uncommitted' | 'base';
}

/**
 * Build the revision prompt. Annotations are grouped by file (preserving
 * first-seen file order) and sorted by line within each file, so the agent
 * works top-down through each file instead of jumping around.
 *
 * Returns '' for an empty list — callers use that to disable the Send button
 * rather than delivering an empty turn.
 */
export function composeRevisionPrompt(
  annotations: DiffAnnotation[],
  opts: ComposeOptions = {},
): string {
  if (annotations.length === 0) return '';

  const byFile = new Map<string, DiffAnnotation[]>();
  for (const a of annotations) {
    const list = byFile.get(a.path);
    if (list) list.push(a);
    else byFile.set(a.path, [a]);
  }

  const n = annotations.length;
  const fileCount = byFile.size;
  const scopeNote =
    opts.scope === 'base'
      ? "These are review notes on this branch's committed changes vs its base."
      : 'These are review notes on the current uncommitted changes.';

  const head =
    `I reviewed the diff${opts.branch ? ` on \`${opts.branch}\`` : ''} and left ` +
    `${n} comment${n === 1 ? '' : ''} across ${fileCount} file${fileCount === 1 ? '' : 's'}. ` +
    `${scopeNote}\n\n` +
    `Address each one. Where a comment is a question rather than a change request, answer it ` +
    `instead of editing. When you're done, summarise what you changed per file.`;

  const sections: string[] = [];
  for (const [path, list] of byFile) {
    const sorted = [...list].sort((a, b) => a.line - b.line);
    const items = sorted.map((a) => {
      const anchor = a.side === 'old' ? `line ${a.line} (removed line)` : `line ${a.line}`;
      const quoted = clipCode(a.code);
      const code = quoted.trim() === '' ? '' : `\n  \`${quoted}\`\n`;
      return `- **${anchor}**${code}\n${indentBlock(a.body.trim())}`;
    });
    sections.push(`### \`${path}\`\n\n${items.join('\n\n')}`);
  }

  return `${head}\n\n${sections.join('\n\n')}\n`;
}

/** Human-readable summary for the Send button / confirm dialog. */
export function summarizeAnnotations(annotations: DiffAnnotation[]): string {
  const n = annotations.length;
  if (n === 0) return 'No comments';
  const files = new Set(annotations.map((a) => a.path)).size;
  return `${n} comment${n === 1 ? '' : 's'} on ${files} file${files === 1 ? '' : 's'}`;
}
