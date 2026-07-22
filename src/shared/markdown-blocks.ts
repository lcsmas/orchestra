/**
 * Split a (possibly still-streaming) markdown string into top-level blocks so
 * the structured agent view can render finished blocks ONCE and only re-render
 * the growing tail as tokens arrive.
 *
 * ## Why
 *
 * The streaming assistant bubble appends a token every animation frame. If the
 * whole accumulated markdown is handed to `<ReactMarkdown>` each frame, remark
 * re-parses the ENTIRE string and React reconciles the ENTIRE rebuilt element
 * tree every frame — a cost that grows with message length. Past a few KB this
 * blows the 16ms frame budget and the text visibly arrives in BLOCKS instead of
 * streaming smoothly (the symptom this module fixes).
 *
 * A markdown document is a sequence of top-level blocks separated by blank
 * lines. While streaming, every block EXCEPT the last is already complete and
 * will never change again — only the final block is still growing. So we split
 * the text into blocks, render each finished block as its own memoized
 * `<ReactMarkdown>` (React reuses those DOM subtrees untouched), and re-render
 * only the active tail block each frame. Per-frame parse/reconcile cost is then
 * bounded by the current paragraph, not the whole transcript.
 *
 * ## Correctness
 *
 * The one hazard is splitting INSIDE a fenced code block: a ```fence``` can
 * legitimately contain blank lines, and those must NOT be treated as block
 * boundaries. So the splitter is fence-aware — it tracks open fences (``` or
 * ~~~, per CommonMark, allowing an indented fence up to 3 spaces and a longer
 * closing run) and only breaks on a blank line when no fence is open.
 *
 * This is a splitter for STABLE-PREFIX memoization, not a markdown parser: the
 * actual rendering is still react-markdown per block, so we don't need to model
 * every CommonMark container (lists, blockquotes). We only need the split points
 * to be places where "everything before is final." Blank lines outside a fence
 * are exactly such points — a new top-level block can always start there, and
 * remark parses a block the same whether or not the text after it exists. The
 * one construct that changes meaning across a blank line is the fenced block,
 * which we handle explicitly. (A "setext" heading — text then `===` — and a
 * loose-list item are unaffected: they contain no blank line within the unit.)
 */

/** True if `line` opens or closes a fenced code block (``` or ~~~), returning
 *  the fence char + run length so we can require the closing run to be at least
 *  as long (CommonMark §4.5). Leading indentation up to 3 spaces is allowed. */
function fenceMarker(line: string): { char: '`' | '~'; len: number } | null {
  const m = /^ {0,3}(`{3,}|~{3,})/.exec(line);
  if (!m) return null;
  const run = m[1];
  return { char: run[0] as '`' | '~', len: run.length };
}

/**
 * Split `text` into top-level markdown blocks, fence-aware.
 *
 * Blocks are separated by one or more blank lines that occur OUTSIDE a fenced
 * code block. The blank-line separators are attached to the END of the block
 * that precedes them, so joining all blocks reproduces `text` EXACTLY
 * (`splitMarkdownBlocks(t).join('') === t`) — important so a stable block's
 * rendered output is identical to what it would be inside the full document.
 *
 * Returns `[]` for an empty string.
 */
export function splitMarkdownBlocks(text: string): string[] {
  if (text === '') return [];

  // Preserve exact bytes by remembering each line's trailing newline. We split
  // on '\n' and re-add it, so a final line without a newline round-trips too.
  const rawLines = text.split('\n');
  const blocks: string[] = [];

  let current = '';
  // Open fence state: the marker char + min length needed to close it, or null.
  let fence: { char: '`' | '~'; len: number } | null = null;
  // Whether we've seen content in the current block since the last boundary —
  // guards against emitting empty leading blocks from leading blank lines.
  let sawContent = false;

  for (let i = 0; i < rawLines.length; i++) {
    const line = rawLines[i];
    // Re-add the newline for every line except a possible final one that had none.
    const withNl = i < rawLines.length - 1 ? line + '\n' : line;

    if (fence) {
      // Inside a fence: a matching closing fence (same char, run >= open len,
      // nothing but the fence + optional trailing spaces) closes it. Blank lines
      // here are NOT boundaries.
      current += withNl;
      const close = fenceMarker(line);
      if (close && close.char === fence.char && close.len >= fence.len && /^ {0,3}[`~]+\s*$/.test(line)) {
        fence = null;
      }
      sawContent = true;
      continue;
    }

    const open = fenceMarker(line);
    if (open) {
      // Opening a fence — the fence line is content; blank lines within won't split.
      current += withNl;
      fence = open;
      sawContent = true;
      continue;
    }

    if (line.trim() === '') {
      // Blank line outside a fence: a block boundary. Attach it to the current
      // block, then (once real content follows) start a fresh block. Consecutive
      // blank lines all stick to the same trailing separator.
      current += withNl;
      if (sawContent) {
        // Peek: only close the block if a NON-blank, non-continued line follows.
        // We defer the actual push until content restarts so trailing blank
        // separators stay with this block.
        // Look ahead for the next non-blank line.
        let j = i + 1;
        while (j < rawLines.length && rawLines[j].trim() === '') {
          current += rawLines[j] + (j < rawLines.length - 1 ? '\n' : '');
          j++;
        }
        i = j - 1; // consumed the blank run
        if (j < rawLines.length) {
          blocks.push(current);
          current = '';
          sawContent = false;
        }
        // else: trailing blank lines at EOF — keep them on `current`, flushed below.
      }
      continue;
    }

    // Ordinary content line.
    current += withNl;
    sawContent = true;
  }

  if (current !== '') blocks.push(current);
  return blocks;
}

/**
 * Partition a streaming markdown string into a stable prefix (blocks that are
 * final and safe to memoize) and the active tail block (still growing).
 *
 * - `done === true` (stream finished): everything is stable; `active` is ''.
 *   The whole message renders once as stable blocks — no live tail.
 * - `done === false` (streaming): the LAST block is the one currently being
 *   written, so it's the active tail; all earlier blocks are stable.
 *
 * `stable.join('') + active === text` always holds.
 */
export function partitionStreamingMarkdown(
  text: string,
  done: boolean,
): { stable: string[]; active: string } {
  const blocks = splitMarkdownBlocks(text);
  if (done) return { stable: blocks, active: '' };
  if (blocks.length === 0) return { stable: [], active: '' };
  const active = blocks[blocks.length - 1];
  return { stable: blocks.slice(0, -1), active };
}
