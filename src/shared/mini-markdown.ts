// A small Markdown parser for the phone (Accès mobile, Lucas 2026-10-12: « il n'y a pas de formattage .md »). It returns BLOCKS
// of plain strings — never HTML: the phone builds DOM from them with textContent only, so agent text can never become markup.
// ONE self-contained function (its helpers are inner functions): conversation.ts injects `parseMarkdown.toString()` into the
// phone script, which only works if nothing it calls lives outside its own body.

export type MdSpan =
  | { t: 'text'; text: string }
  | { t: 'b'; text: string }
  | { t: 'i'; text: string }
  | { t: 'code'; text: string }
  | { t: 'a'; text: string; href: string };

export type MdBlock =
  | { t: 'p'; spans: MdSpan[] }
  | { t: 'h'; level: number; spans: MdSpan[] }
  | { t: 'code'; text: string }
  | { t: 'ul' | 'ol'; items: MdSpan[][] }
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
          out.push({ t: 'b', text: text.slice(i + 2, end) });
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
            out.push({ t: 'i', text: text.slice(i + 1, end) });
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
    const ul = /^\s*[-*+]\s+/;
    const ol = /^\s*\d+[.)]\s+/;
    if (ul.test(line) || ol.test(line)) {
      endPara();
      const kind = ul.test(line) ? 'ul' : 'ol';
      const re = kind === 'ul' ? ul : ol;
      const items: MdSpan[][] = [];
      while (i < lines.length && re.test(lines[i])) {
        let item = lines[i++].replace(re, '');
        // a continuation line indented under the item belongs to it
        while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !ul.test(lines[i]) && !ol.test(lines[i])) item += '\n' + lines[i++].trim();
        items.push(inline(item));
      }
      blocks.push({ t: kind, items });
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
