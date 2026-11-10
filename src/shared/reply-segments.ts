/**
 * The shared reader of an agent reply (Bloc HTML, spec #414, ADR 0011): turns a
 * reply's text into prose / bloc segments. Pure — no DOM, no Node — so the
 * desktop renderer, the main process and the phone page's self-contained reader
 * all import it. Ledger #423 FI-1; `summarizeReply` (#420) is added here later.
 *
 * A bloc is a fenced block whose info string STARTS with the whole word
 * `html-render` (`html-render` ≠ `html`, `html-renderer`, `HTML-RENDER`), with an
 * optional `title="…"` after it. Fence-aware the way `markdown-blocks.ts` is: a
 * `html-render` fence quoted INSIDE another (longer or different) fence is prose.
 *
 * Round-trip: `segments.map(s => s.kind === 'prose' ? s.text : s.raw).join('') === text`.
 * `raw` is the fence text from the first char of the opening line to the last
 * char of the closing fence line (NO trailing newline — that opens the next
 * prose segment); `source` is what sits between the fence lines.
 */

/** The fence label. Frozen: it lives in every transcript from now on. */
export const BLOC_HTML_LABEL = 'html-render';
/** Shown when the title is missing or empty. */
export const BLOC_HTML_DEFAULT_TITLE = 'Bloc HTML';
/** Provisional cap on a bloc's source (UTF-8 bytes) — #419 sets the final value from its measure. */
export const BLOC_HTML_MAX_SOURCE_BYTES = 256 * 1024;

export type ReplySegment =
  | { kind: 'prose'; text: string }
  /** A fence that is closed. */
  | { kind: 'bloc'; title: string; source: string; raw: string }
  /** A fence still open at the end of the text (still being written). */
  | { kind: 'bloc-pending'; title: string; source: string; raw: string }
  /** A closed fence over the size cap: render it as a code block. */
  | { kind: 'bloc-refused'; title: string; source: string; raw: string; reason: 'too-large' };

interface Fence {
  char: '`' | '~';
  len: number;
  indent: number;
  /** The info string, trimmed. */
  info: string;
}

/** An opening fence line (CommonMark §4.5): ≤3 spaces of indent, a run of ≥3 ` or ~; a backtick fence's info string holds no backtick. */
function openingFence(line: string): Fence | null {
  const m = /^( {0,3})(`{3,}|~{3,})(.*)$/.exec(line);
  if (!m) return null;
  const char = m[2][0] as '`' | '~';
  const info = m[3].trim();
  if (char === '`' && info.includes('`')) return null;
  return { char, len: m[2].length, indent: m[1].length, info };
}

function closesFence(line: string, f: Fence): boolean {
  const m = /^ {0,3}(`{3,}|~{3,})[ \t\r]*$/.exec(line);
  return !!m && m[1][0] === f.char && m[1].length >= f.len;
}

/** The title of a bloc fence, or null when `info` is not a bloc fence's info string. */
function blocInfo(info: string): { title: string } | null {
  const m = /^(\S+)(?:\s+(.*))?$/.exec(info);
  if (!m || m[1] !== BLOC_HTML_LABEL) return null;
  const t = /(?:^|\s)title="([^"]*)"/.exec(m[2] ?? '');
  const title = t ? t[1].trim() : '';
  return { title: title === '' ? BLOC_HTML_DEFAULT_TITLE : title };
}

/** UTF-16 length bounds the byte length from below (×1) and above (×3): encode only when that cannot decide. */
function overCap(source: string, max: number): boolean {
  if (source.length > max) return true;
  if (source.length * 3 <= max) return false;
  return new TextEncoder().encode(source).length > max;
}

/** Remove up to `n` leading spaces from every line (an indented fence's content, CommonMark §4.5). */
function dedent(source: string, n: number): string {
  if (n === 0) return source;
  const re = new RegExp(`^ {0,${n}}`, 'gm');
  return source.replace(re, '');
}

export function splitReply(text: string, opts?: { maxSourceBytes?: number }): ReplySegment[] {
  if (text === '') return [];
  // Fast path (every streaming frame): no bloc label anywhere ⇒ one prose segment.
  if (!text.includes(BLOC_HTML_LABEL)) return [{ kind: 'prose', text }];
  const max = opts?.maxSourceBytes ?? BLOC_HTML_MAX_SOURCE_BYTES;

  const segs: ReplySegment[] = [];
  let proseStart = 0;
  let fence: Fence | null = null;
  let bloc: { start: number; contentStart: number; title: string; indent: number } | null = null;

  let pos = 0;
  while (pos <= text.length) {
    let lineEnd = text.indexOf('\n', pos);
    if (lineEnd === -1) lineEnd = text.length;
    const line = text.slice(pos, lineEnd);
    const lineStart = pos;
    pos = lineEnd + 1;

    if (fence) {
      if (!closesFence(line, fence)) continue;
      if (bloc) {
        if (bloc.start > proseStart) segs.push({ kind: 'prose', text: text.slice(proseStart, bloc.start) });
        const bodyEnd = Math.max(bloc.contentStart, lineStart - 1); // drop the newline that precedes the closing fence
        const source = dedent(text.slice(bloc.contentStart, bodyEnd), bloc.indent);
        const raw = text.slice(bloc.start, lineEnd);
        segs.push(overCap(source, max)
          ? { kind: 'bloc-refused', title: bloc.title, source, raw, reason: 'too-large' }
          : { kind: 'bloc', title: bloc.title, source, raw });
        proseStart = lineEnd;
        bloc = null;
      }
      fence = null;
      continue;
    }

    const open = openingFence(line);
    if (!open) continue;
    fence = open;
    const b = blocInfo(open.info);
    if (b) bloc = { start: lineStart, contentStart: Math.min(lineEnd + 1, text.length), title: b.title, indent: open.indent };
  }

  if (bloc) {
    // Still open at the end of the text: the placeholder state.
    if (bloc.start > proseStart) segs.push({ kind: 'prose', text: text.slice(proseStart, bloc.start) });
    segs.push({ kind: 'bloc-pending', title: bloc.title, source: dedent(text.slice(bloc.contentStart), bloc.indent), raw: text.slice(bloc.start) });
  } else if (proseStart < text.length) {
    segs.push({ kind: 'prose', text: text.slice(proseStart) });
  }
  return segs;
}
