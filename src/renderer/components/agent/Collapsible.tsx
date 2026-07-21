import React, { useState } from 'react';

interface Props {
  /** Row shown always — click toggles the body. */
  header: React.ReactNode;
  /** Revealed when expanded. */
  children: React.ReactNode;
  /** Start expanded. Default false (collapsed). */
  defaultOpen?: boolean;
  /** Extra class on the root (e.g. a per-tool modifier). */
  className?: string;
  /** Small trailing element on the header row (e.g. a status pill). */
  aside?: React.ReactNode;
}

/**
 * The collapsible primitive every tool card is built on. A clickable header row
 * with a disclosure caret plus an expandable body. Purely structural — A5 styles
 * the `av-collapsible*` classes. Uncontrolled (own open state) so the parent tool
 * card doesn't have to thread it.
 */
export function Collapsible({ header, children, defaultOpen = false, className, aside }: Props) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className={`av-collapsible ${open ? 'av-open' : 'av-closed'} ${className ?? ''}`}>
      <button
        type="button"
        className="av-collapsible-header"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <span className={`av-caret ${open ? 'av-caret-open' : ''}`} aria-hidden>
          <svg
            width="10"
            height="10"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M5.5 3 10.5 8 5.5 13" />
          </svg>
        </span>
        <span className="av-collapsible-title">{header}</span>
        {aside != null && <span className="av-collapsible-aside">{aside}</span>}
      </button>
      {open && <div className="av-collapsible-body">{children}</div>}
    </div>
  );
}
