// A small Markdown parser for the phone (Accès mobile, Lucas 2026-10-12: « il n'y a pas de formattage .md »). It returns BLOCKS
// of plain strings — never HTML: the phone builds DOM from them with textContent only, so agent text can never become markup.
// ONE self-contained function (its helpers are inner functions): conversation.ts injects `parseMarkdown.toString()` into the
// phone script, which only works if nothing it calls lives outside its own body.

export type MdSpan =
  | { t: 'text'; text: string }
  | { t: 'b'; spans: MdSpan[] }
  | { t: 'i'; spans: MdSpan[] }
  | { t: 'code'; text: string }
  | { t: 'a'; text: string; href: string };

/** A list item: its text (continuation lines kept as `\n`) and the lists indented under it. */
export type MdItem = { spans: MdSpan[]; sub: MdList[] };
/** `start` only when an ordered list does not begin at 1. */
export type MdList = { t: 'ul' | 'ol'; start?: number; items: MdItem[] };

export type MdBlock =
  | { t: 'p'; spans: MdSpan[] }
  | { t: 'h'; level: number; spans: MdSpan[] }
  | { t: 'code'; text: string }
  | MdList
  | { t: 'quote'; spans: MdSpan[] }
  | { t: 'table'; rows: MdSpan[][][] }
  | { t: 'hr' };

export function parseMarkdown(src: string): MdBlock[] {
  function inline(text: string): MdSpan[] {
    const out: MdSpan[] = [];
    let buf = '';
    const flush = () => {
      if (buf) out.push({ t: 'text', text: buf });
      buf = '';
    };
    let i = 0;
    while (i < text.length) {
      const c = text[i];
      if (c === '`') {
        const end = text.indexOf('`', i + 1);
        if (end > i + 1) {
          flush();
          out.push({ t: 'code', text: text.slice(i + 1, end) });
          i = end + 1;
          continue;
        }
      }
      if ((c === '*' || c === '_') && text[i + 1] === c) {
        const end = text.indexOf(c + c, i + 2);
        if (end > i + 2) {
          flush();
          out.push({ t: 'b', spans: inline(text.slice(i + 2, end)) });
          i = end + 2;
          continue;
        }
      }
      if ((c === '*' || c === '_') && text[i + 1] !== c && text[i + 1] !== ' ' && text[i + 1] !== undefined) {
        // a word-internal underscore (snake_case) is not emphasis
        const before = i > 0 ? text[i - 1] : ' ';
        if (c === '*' || !/[A-Za-z0-9]/.test(before)) {
          const end = text.indexOf(c, i + 1);
          const after = end >= 0 ? text[end + 1] : undefined;
          if (end > i + 1 && text[end - 1] !== ' ' && (c === '*' || after === undefined || !/[A-Za-z0-9]/.test(after))) {
            flush();
            out.push({ t: 'i', spans: inline(text.slice(i + 1, end)) });
            i = end + 1;
            continue;
          }
        }
      }
      if (c === '[') {
        const close = text.indexOf('](', i + 1);
        const end = close >= 0 ? text.indexOf(')', close + 2) : -1;
        if (close > i && end > close) {
          const href = text.slice(close + 2, end).trim();
          if (/^https?:\/\/\S+$/.test(href)) {
            flush();
            out.push({ t: 'a', text: text.slice(i + 1, close), href });
            i = end + 1;
            continue;
          }
        }
      }
      if (c === 'h' && (i === 0 || !/[A-Za-z0-9]/.test(text[i - 1]))) {
        // a bare URL is a link too; trailing punctuation (and an unbalanced ')') stays text
        const m = /^https?:\/\/[^\s<>`]+/.exec(text.slice(i));
        if (m) {
          let url = m[0].replace(/[.,;:!?'"*_]+$/, '');
          while (url.endsWith(')') && url.split('(').length < url.split(')').length) url = url.slice(0, -1);
          if (/^https?:\/\/\S+$/.test(url) && url.length > 8) {
            flush();
            out.push({ t: 'a', text: url, href: url });
            i += url.length;
            continue;
          }
        }
      }
      buf += c;
      i++;
    }
    flush();
    return out;
  }

  const lines = String(src).replace(/\r\n?/g, '\n').split('\n');
  const blocks: MdBlock[] = [];
  let para: string[] = [];
  const endPara = () => {
    if (para.length) blocks.push({ t: 'p', spans: inline(para.join('\n')) });
    para = [];
  };
  let i = 0;
  // One list from lines[i]: items at its indent; a deeper item nests under the last item; an indented non-item line continues the
  // last item (kept as \n — « - point » then « → why »); blank lines between items do not split the list (split ones restarted at 1).
  const itemRe = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
  const indentOf = (l: string): number => (/^\s*/.exec(l) as RegExpExecArray)[0].replace(/\t/g, '    ').length;
  function list(): MdList {
    const first = itemRe.exec(lines[i]) as RegExpExecArray;
    const ordered = /\d/.test(first[2]);
    const base = indentOf(lines[i]);
    const out: MdList = { t: ordered ? 'ol' : 'ul', items: [] };
    if (ordered && parseInt(first[2], 10) !== 1) out.start = parseInt(first[2], 10);
    const raw: string[] = [];
    while (i < lines.length) {
      const line = lines[i];
      if (!line.trim()) {
        let j = i;
        while (j < lines.length && !lines[j].trim()) j++;
        const next = j < lines.length ? itemRe.exec(lines[j]) : null;
        const ind = next ? indentOf(lines[j]) : -1;
        if (next && (ind > base || (ind === base && /\d/.test(next[2]) === ordered))) {
          i = j;
          continue;
        }
        break;
      }
      const m = itemRe.exec(line);
      const ind = indentOf(line);
      if (m && ind === base) {
        if (/\d/.test(m[2]) !== ordered) break; // another kind at the same level is another list
        out.items.push({ spans: [], sub: [] });
        raw.push(m[3]);
        i++;
        continue;
      }
      if (ind <= base || /^\s*(```|~~~)/.test(line)) break;
      if (m) out.items[out.items.length - 1].sub.push(list());
      else raw[raw.length - 1] += '\n' + lines[i++].trim();
    }
    out.items.forEach((it, k) => (it.spans = inline(raw[k])));
    return out;
  }
  while (i < lines.length) {
    const line = lines[i];
    const fence = /^\s*(```|~~~)/.exec(line);
    if (fence) {
      endPara();
      const body: string[] = [];
      i++;
      while (i < lines.length && !new RegExp('^\\s*' + fence[1]).test(lines[i])) body.push(lines[i++]);
      i++; // the closing fence (or the end)
      blocks.push({ t: 'code', text: body.join('\n') });
      continue;
    }
    if (!line.trim()) {
      endPara();
      i++;
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      endPara();
      blocks.push({ t: 'h', level: h[1].length, spans: inline(h[2].replace(/\s+#+\s*$/, '')) });
      i++;
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      endPara();
      blocks.push({ t: 'hr' });
      i++;
      continue;
    }
    if (/^\s*>/.test(line)) {
      endPara();
      const body: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) body.push(lines[i++].replace(/^\s*>\s?/, ''));
      blocks.push({ t: 'quote', spans: inline(body.join('\n')) });
      continue;
    }
    if (itemRe.test(line)) {
      endPara();
      blocks.push(list());
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line)) {
      endPara();
      const rows: MdSpan[][][] = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) {
        const cells = lines[i++].trim().slice(1, -1).split('|').map((x) => x.trim());
        if (cells.every((x) => /^:?-+:?$/.test(x))) continue; // the header separator (|---|:-:|)
        rows.push(cells.map((x) => inline(x)));
      }
      blocks.push({ t: 'table', rows });
      continue;
    }
    para.push(line);
    i++;
  }
  endPara();
  return blocks;
}
