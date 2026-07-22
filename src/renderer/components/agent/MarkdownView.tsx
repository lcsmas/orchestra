import React, { useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import type { Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { CodeBlock } from './CodeBlock';

interface Props {
  /** The raw markdown text (may be a partial stream). */
  text: string;
  /** Whether the surrounding message has finished streaming — forwarded to
   *  CodeBlock so fenced blocks only syntax-highlight once finalized. */
  done: boolean;
}

/**
 * Full CommonMark + GFM markdown rendering for the structured agent view, via
 * `react-markdown` + `remark-gfm` — replacing the old hand-rolled dep-free
 * subset parser, which silently dropped tables, strikethrough, task lists, and
 * nested lists (the "bad markdown reader"). Matches the Claude Code desktop app,
 * which uses react-markdown + shiki.
 *
 * Fenced code blocks route to {@link CodeBlock} (Shiki-highlighted); everything
 * else uses react-markdown's default element mapping under our `av-md-*` classes.
 * react-markdown never renders raw HTML from the source (no `rehype-raw`), so
 * model output can't inject markup.
 *
 * The whole thing is memoized on `(text, done)` in {@link MarkdownView} so a
 * token delta elsewhere in the transcript doesn't re-parse this block; the
 * heavier guard lives in MessageBubble's `React.memo`.
 */
function MarkdownViewImpl({ text, done }: Props) {
  const components: Components = useMemo(
    () => ({
      // Fenced blocks (`className` carries `language-xxx`) → CodeBlock. Inline
      // code (no language class, single line) → a plain <code>. react-markdown
      // passes both through `code`; we distinguish by the language class + a
      // newline, mirroring how the previous parser split fences from inline.
      code(props) {
        const { className, children } = props as {
          className?: string;
          children?: React.ReactNode;
        };
        const raw = String(children ?? '');
        const match = /language-(\w+)/.exec(className ?? '');
        const isBlock = !!match || raw.includes('\n');
        if (isBlock) {
          return (
            <CodeBlock
              code={raw.replace(/\n$/, '')}
              lang={match?.[1] ?? ''}
              done={done}
            />
          );
        }
        return <code className="av-md-code-inline">{children}</code>;
      },
      // Links open externally, never navigate the renderer away from the app.
      a(props) {
        const { href, children } = props as { href?: string; children?: React.ReactNode };
        return (
          <a className="av-md-link" href={href} target="_blank" rel="noreferrer">
            {children}
          </a>
        );
      },
      // Class hooks so the existing av-md-* theme layer styles these unchanged.
      h1: (p) => <h1 className="av-md-h" {...p} />,
      h2: (p) => <h2 className="av-md-h" {...p} />,
      h3: (p) => <h3 className="av-md-h" {...p} />,
      h4: (p) => <h4 className="av-md-h" {...p} />,
      h5: (p) => <h5 className="av-md-h" {...p} />,
      h6: (p) => <h6 className="av-md-h" {...p} />,
      p: (p) => <p className="av-md-p" {...p} />,
      ul: (p) => <ul className="av-md-ul" {...p} />,
      ol: (p) => <ol className="av-md-ol" {...p} />,
      blockquote: (p) => <blockquote className="av-md-quote" {...p} />,
      hr: () => <hr className="av-md-hr" />,
      strong: (p) => <strong className="av-md-strong" {...p} />,
      em: (p) => <em className="av-md-em" {...p} />,
      // GFM tables — the headline gap the old parser couldn't render at all.
      table: (p) => (
        <div className="av-md-table-wrap">
          <table className="av-md-table" {...p} />
        </div>
      ),
      del: (p) => <del className="av-md-del" {...p} />,
    }),
    [done],
  );

  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
      {text}
    </ReactMarkdown>
  );
}

export const MarkdownView = React.memo(
  MarkdownViewImpl,
  (a, b) => a.text === b.text && a.done === b.done,
);
