import React, { useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import type { Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { CodeBlock } from './CodeBlock';
import { partitionStreamingMarkdown } from '../../../shared/markdown-blocks';

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
 * ## Smooth streaming — block-level memoization
 *
 * While a message streams, a naive `<ReactMarkdown>{text}</ReactMarkdown>` would
 * re-parse the ENTIRE accumulated markdown and reconcile the whole rebuilt tree
 * on every animation frame (every ~token). That cost grows with message length
 * and, past a few KB, blows the frame budget so text arrives in visible BLOCKS
 * instead of streaming smoothly. Fix: split the markdown into top-level blocks
 * (fence-aware — see `shared/markdown-blocks.ts`); every block but the last is
 * already FINAL, so render each as its own {@link MarkdownBlock} keyed by its
 * text. React reuses those DOM subtrees untouched, and only the growing tail
 * block re-parses/re-renders each frame — bounding per-frame work to the current
 * paragraph regardless of transcript length. When `done`, there's no live tail;
 * the whole message is stable blocks. `MarkdownView` is still memoized on
 * `(text, done)` so an unrelated delta elsewhere never reaches this bubble at all.
 */
function MarkdownBlockImpl({ text, done }: Props) {
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

/**
 * One top-level markdown block. Memoized on `(text, done)` so a FINISHED block
 * (its text never changes again once the stream moves past it) is parsed and
 * reconciled exactly once — React reuses its DOM subtree on every later frame.
 * This is the unit that makes streaming smooth: only the active tail block's
 * `text` changes per frame, so only it re-renders.
 */
const MarkdownBlock = React.memo(
  MarkdownBlockImpl,
  (a, b) => a.text === b.text && a.done === b.done,
);

function MarkdownViewImpl({ text, done }: Props) {
  // Split into already-final "stable" blocks + the still-growing "active" tail.
  // Only the tail changes as tokens arrive, so only it re-renders each frame;
  // the stable blocks are memoized by their (unchanging) text. See
  // `shared/markdown-blocks.ts` for why this is the fix for block-y streaming.
  const { stable, active } = useMemo(
    () => partitionStreamingMarkdown(text, done),
    [text, done],
  );

  return (
    <>
      {stable.map((block, i) => (
        // A stable block's text is immutable once emitted, so keying by its
        // content is safe and lets React skip re-rendering unchanged blocks even
        // if an earlier block's length shifts the index. Finished blocks always
        // render with done=true (they will not stream further), so fenced code
        // in them highlights immediately.
        <MarkdownBlock key={`s:${i}:${block.length}`} text={block} done />
      ))}
      {active !== '' ? <MarkdownBlock key="active" text={active} done={done} /> : null}
    </>
  );
}

export const MarkdownView = React.memo(
  MarkdownViewImpl,
  (a, b) => a.text === b.text && a.done === b.done,
);
