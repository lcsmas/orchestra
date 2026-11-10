/**
 * The shared reader of an agent reply (Bloc HTML, spec #414, ADR 0011): turns a
 * reply's text into prose / bloc segments. Pure — no DOM, no Node — so the
 * desktop renderer, the main process and the phone page's self-contained reader
 * all import it. Ledger #423 FI-1; `summarizeReply` (#420) sits below, outside `splitReply`.
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
/** Cap on a bloc's source (UTF-8 bytes), FINAL (#419, docs/evidence/419-*: +11 MB live at 250 KiB; the over-cap code fallback stalls the window ~0.5 s). */
export const BLOC_HTML_MAX_SOURCE_BYTES = 256 * 1024;

export type ReplySegment =
  | { kind: 'prose'; text: string }
  /** A fence that is closed. */
  | { kind: 'bloc'; title: string; source: string; raw: string }
  /** A fence still open at the end of the text (still being written). */
  | { kind: 'bloc-pending'; title: string; source: string; raw: string }
  /** A closed fence over the size cap: render it as a code block. */
  | { kind: 'bloc-refused'; title: string; source: string; raw: string; reason: 'too-large' };

/**
 * ONE self-contained function (ledger #423 FI-1 v2): the phone page injects `splitReply.toString()`, so the body may reference NO module-level
 * binding — helpers are nested, the label / default title / default cap are literals (a test pins them equal to the exported constants and runs the
 * injected copy in a vm). Backtick fence with a backtick in its info string is not a fence (CommonMark §4.5).
 */
export function splitReply(text: string, opts?: { maxSourceBytes?: number }): ReplySegment[] {
  type Fence = { char: string; len: number; indent: number; info: string };
  /** An opening fence line: ≤3 spaces of indent, a run of ≥3 ` or ~. */
  const openingFence = (line: string): Fence | null => {
    const m = /^( {0,3})(`{3,}|~{3,})([^\n]*)$/.exec(line);
    if (!m) return null;
    const info = m[3].trim();
    if (m[2][0] === '`' && info.includes('`')) return null;
    return { char: m[2][0], len: m[2].length, indent: m[1].length, info };
  };
  const closesFence = (line: string, f: Fence): boolean => {
    const m = /^ {0,3}(`{3,}|~{3,})[ \t\r]*$/.exec(line);
    return !!m && m[1][0] === f.char && m[1].length >= f.len;
  };
  /** The title of a bloc fence, or null when `info` is not a bloc fence's info string. */
  const blocInfo = (info: string): { title: string } | null => {
    const m = /^(\S+)(?:\s+([^\n]*))?$/.exec(info);
    if (!m || m[1] !== 'html-render') return null;
    const t = /(?:^|\s)title="((?:[^"\\]|\\[^\n])*)"/.exec(m[2] ?? '');
    const title = t ? t[1].replace(/\\(["\\])/g, '$1').trim() : ''; // `\"` and `\\` are the only escapes
    return { title: title === '' ? 'Bloc HTML' : title };
  };
  /** UTF-16 length bounds the byte length from below (×1) and above (×3): encode only when that cannot decide. */
  const overCap = (source: string, cap: number): boolean => {
    if (source.length > cap) return true;
    if (source.length * 3 <= cap) return false;
    return new TextEncoder().encode(source).length > cap;
  };
  /** Remove up to `n` leading spaces from every line (an indented fence's content, CommonMark §4.5). */
  const dedent = (source: string, n: number): string => (n === 0 ? source : source.replace(new RegExp('^ {0,' + n + '}', 'gm'), ''));

  if (text === '') return [];
  // Fast path (every streaming frame): no bloc label anywhere ⇒ one prose segment.
  if (!text.includes('html-render')) return [{ kind: 'prose', text }];
  const max = opts?.maxSourceBytes ?? 256 * 1024;

  const segs: ReplySegment[] = [];
  let proseStart = 0;
  let fence: Fence | null = null;
  let bloc: { start: number; contentStart: number; title: string; indent: number } | null = null;

  let pos = 0;
  while (pos <= text.length) {
    let lineEnd = text.indexOf('\n', pos);
    if (lineEnd === -1) lineEnd = text.length;
    const line = text.slice(pos, lineEnd).replace(/\r$/, ''); // CRLF text: `.` in the fence regexes does not match \r
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

/** A reply as a summary reads it: prose kept, every bloc (closed, open, refused) replaced by its title — never its source (#420). */
export function summarizeReply(text: string): string {
  const segs = splitReply(text);
  if (segs.length === 1 && segs[0].kind === 'prose') return text;
  return segs.map((s) => (s.kind === 'prose' ? s.text : s.title)).join('');
}
