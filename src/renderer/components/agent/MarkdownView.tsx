import React, { useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import type { Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import remend from 'remend';
import { CodeBlock } from './CodeBlock';
import { partitionStreamingMarkdown } from '../../../shared/markdown-blocks';

/**
 * A link whose destination hasn't finished streaming is closed by `remend` with
 * the placeholder href `streamdown:incomplete-link`. react-markdown's own
 * protocol allowlist (http/https/irc/mailto/xmpp) rejects that unknown scheme
 * and rewrites it to an EMPTY string before our `a` component ever sees it —
 * verified against the real pipeline, the component receives `""`. So an empty
 * href is the signal to render plain text rather than a dead link.
 */
function isIncompleteLink(href: string | undefined): boolean {
  return !href;
}

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
 * ## Line breaks — why `remark-breaks`
 *
 * Strict CommonMark treats a SINGLE newline as a "soft break" and renders it as a
 * SPACE; only a blank line (paragraph) or a two-trailing-space "hard break" starts
 * a new visual line. That is wrong for this surface: the agent writes chat prose,
 * and a drafted message with real line breaks collapsed into one run-on paragraph
 * (verified: 4 lines → 1 `<p>`, 0 `<br>`). Nothing downstream rescues it either —
 * `.av-message-text` is `white-space: normal`, so the newline really does paint as
 * a space. `remark-breaks` maps every soft break to a `<br>`, which is the
 * convention every chat renderer uses (GitHub comments, Slack, Discord) and what a
 * reader typing a newline actually expects.
 *
 * Ordering matters: `remarkGfm` runs FIRST so its block constructs (tables, task
 * lists) are parsed before soft breaks become `<br>` nodes — a `<br>` injected
 * inside a pipe-table row would otherwise break the table parse.
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
        // A link whose destination hasn't streamed in yet renders as plain text
        // so a mid-stream click can't hit a dead href; it becomes a real link on
        // the next delta once the `](url)` arrives. See {@link isIncompleteLink}.
        if (isIncompleteLink(href)) return <>{children}</>;
        return (
          <a className="av-md-link" href={href} target="_blank" rel="noreferrer">
            {children}
          </a>
        );
      },
      // Class hooks so the existing av-md-* theme layer styles these unchanged.
      // `node` is react-markdown's internal mdast node — it is NOT a DOM
      // attribute, so it must be stripped before spreading onto a real element
      // (otherwise every one of these emits a junk `node="[object Object]"`
      // attribute into the DOM; React 19 passes unknown props straight through).
      h1: ({ node: _n, ...p }) => <h1 className="av-md-h" {...p} />,
      h2: ({ node: _n, ...p }) => <h2 className="av-md-h" {...p} />,
      h3: ({ node: _n, ...p }) => <h3 className="av-md-h" {...p} />,
      h4: ({ node: _n, ...p }) => <h4 className="av-md-h" {...p} />,
      h5: ({ node: _n, ...p }) => <h5 className="av-md-h" {...p} />,
      h6: ({ node: _n, ...p }) => <h6 className="av-md-h" {...p} />,
      p: ({ node: _n, ...p }) => <p className="av-md-p" {...p} />,
      ul: ({ node: _n, ...p }) => <ul className="av-md-ul" {...p} />,
      ol: ({ node: _n, ...p }) => <ol className="av-md-ol" {...p} />,
      blockquote: ({ node: _n, ...p }) => <blockquote className="av-md-quote" {...p} />,
      hr: () => <hr className="av-md-hr" />,
      strong: ({ node: _n, ...p }) => <strong className="av-md-strong" {...p} />,
      em: ({ node: _n, ...p }) => <em className="av-md-em" {...p} />,
      // GFM tables — the headline gap the old parser couldn't render at all.
      table: ({ node: _n, ...p }) => (
        <div className="av-md-table-wrap">
          <table className="av-md-table" {...p} />
        </div>
      ),
      del: ({ node: _n, ...p }) => <del className="av-md-del" {...p} />,
    }),
    [done],
  );

  // Close dangling INLINE tokens while this block is still streaming, so a
  // half-written `**bold` / `[link` / `` `code `` renders as formatted text
  // instead of flashing its raw markers on screen for a frame. Only the active
  // tail block is ever incomplete — a stable block is final by construction, so
  // it skips this work entirely (and `done` messages skip it altogether).
  //
  // Note this is an INLINE-only fix: CommonMark already handles unterminated
  // BLOCK constructs correctly (an unclosed ```fence``` and a partial GFM table
  // both parse fine), so `remend` deliberately leaves those alone.
  const source = useMemo(() => (done ? text : remend(text)), [text, done]);

  return (
    <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]} components={components}>
      {source}
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
