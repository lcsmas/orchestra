// JSX rendering for the lightweight markdown subset Claude emits. The pure block
// splitting + language mapping live in the JSX-free `markdown-parse.ts` (so they
// load under the node:test type-strip runner); this module turns the non-code
// prose of an `html` block into React nodes.
//
// We deliberately do NOT pull in remark/markdown-it/react-markdown: the agent
// view streams token-by-token and re-renders on every RAF flush, so the parser
// runs constantly. A focused, allocation-light renderer that covers headings,
// bold/italic/code, links, lists, and blockquotes keeps that hot path cheap and
// never executes arbitrary HTML from model output.

import React from 'react';

export { parseMarkdown, monacoLang, langFromPath } from './markdown-parse';
export type { MdBlock } from './markdown-parse';

/**
 * Render the prose (non-code) text of a markdown `html` block into React nodes.
 * Handles headings, blockquotes, unordered/ordered lists, horizontal rules, and
 * paragraphs; inline formatting is handled by {@link renderInline}.
 */
export function MarkdownProse({ text }: { text: string }): React.ReactElement {
  return <>{renderMarkdownBlocks(text)}</>;
}

function renderMarkdownBlocks(src: string): React.ReactNode {
  const lines = src.split('\n');
  const out: React.ReactNode[] = [];
  let i = 0;
  let key = 0;
  const nextKey = () => `b${key++}`;

  while (i < lines.length) {
    const raw = lines[i];
    const line = raw.replace(/\s+$/, '');

    // Blank line — skip (paragraph separation is handled structurally).
    if (line.trim() === '') {
      i++;
      continue;
    }

    // Heading (#..######).
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      const level = heading[1].length;
      const Tag = `h${Math.min(level + 2, 6)}` as keyof React.JSX.IntrinsicElements;
      out.push(
        <Tag key={nextKey()} className="av-md-h">
          {renderInline(heading[2])}
        </Tag>
      );
      i++;
      continue;
    }

    // Horizontal rule.
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(line.trim())) {
      out.push(<hr key={nextKey()} className="av-md-hr" />);
      i++;
      continue;
    }

    // Blockquote (one or more consecutive `>` lines).
    if (/^\s*>/.test(line)) {
      const quote: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) {
        quote.push(lines[i].replace(/^\s*>\s?/, ''));
        i++;
      }
      out.push(
        <blockquote key={nextKey()} className="av-md-quote">
          {renderMarkdownBlocks(quote.join('\n'))}
        </blockquote>
      );
      continue;
    }

    // Ordered list.
    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+\.\s+/, ''));
        i++;
      }
      out.push(
        <ol key={nextKey()} className="av-md-ol">
          {items.map((it, idx) => (
            <li key={idx}>{renderInline(it)}</li>
          ))}
        </ol>
      );
      continue;
    }

    // Unordered list.
    if (/^\s*[-*+]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*+]\s+/, ''));
        i++;
      }
      out.push(
        <ul key={nextKey()} className="av-md-ul">
          {items.map((it, idx) => (
            <li key={idx}>{renderInline(it)}</li>
          ))}
        </ul>
      );
      continue;
    }

    // Paragraph — gather consecutive non-blank, non-special lines.
    const para: string[] = [];
    while (i < lines.length) {
      const l = lines[i];
      if (
        l.trim() === '' ||
        /^(#{1,6})\s+/.test(l) ||
        /^\s*>/.test(l) ||
        /^\s*[-*+]\s+/.test(l) ||
        /^\s*\d+\.\s+/.test(l) ||
        /^(-{3,}|\*{3,}|_{3,})$/.test(l.trim())
      ) {
        break;
      }
      para.push(l);
      i++;
    }
    out.push(
      <p key={nextKey()} className="av-md-p">
        {renderInline(para.join('\n'))}
      </p>
    );
  }

  return out;
}

/**
 * Render inline markdown (bold, italic, inline code, links) within a text run.
 * Newlines become `<br>`. Deliberately conservative — it recognises the common
 * emphasis/code/link forms and leaves everything else as literal text, so no
 * model output is ever interpreted as HTML.
 */
export function renderInline(text: string): React.ReactNode {
  const nodes: React.ReactNode[] = [];
  let key = 0;
  const push = (n: React.ReactNode) =>
    nodes.push(<React.Fragment key={key++}>{n}</React.Fragment>);

  const segments = text.split('\n');
  segments.forEach((seg, idx) => {
    if (idx > 0) push(<br />);
    push(renderInlineSegment(seg));
  });
  return nodes;
}

// Inline token matcher: inline code, links, bold, italic. Ordered so code wins
// first (its contents are literal), then links, then bold, then italic.
const INLINE_RE =
  /(`[^`]+`)|(\[[^\]]+\]\([^)]+\))|(\*\*[^*]+\*\*)|(__[^_]+__)|(\*[^*]+\*)|(_[^_]+_)/;

function renderInlineSegment(seg: string): React.ReactNode {
  const out: React.ReactNode[] = [];
  let rest = seg;
  let key = 0;
  const nextKey = () => `i${key++}`;

  while (rest.length > 0) {
    const m = rest.match(INLINE_RE);
    if (!m || m.index === undefined) {
      out.push(<React.Fragment key={nextKey()}>{rest}</React.Fragment>);
      break;
    }
    if (m.index > 0) {
      out.push(<React.Fragment key={nextKey()}>{rest.slice(0, m.index)}</React.Fragment>);
    }
    const tok = m[0];
    if (tok.startsWith('`')) {
      out.push(
        <code key={nextKey()} className="av-md-code-inline">
          {tok.slice(1, -1)}
        </code>
      );
    } else if (tok.startsWith('[')) {
      const link = tok.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
      if (link) {
        out.push(
          <a key={nextKey()} href={link[2]} className="av-md-link" target="_blank" rel="noreferrer">
            {link[1]}
          </a>
        );
      } else {
        out.push(<React.Fragment key={nextKey()}>{tok}</React.Fragment>);
      }
    } else if (tok.startsWith('**') || tok.startsWith('__')) {
      out.push(
        <strong key={nextKey()} className="av-md-strong">
          {tok.slice(2, -2)}
        </strong>
      );
    } else {
      out.push(
        <em key={nextKey()} className="av-md-em">
          {tok.slice(1, -1)}
        </em>
      );
    }
    rest = rest.slice(m.index + tok.length);
  }

  return out;
}
