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
          ▶
        </span>
        <span className="av-collapsible-title">{header}</span>
        {aside != null && <span className="av-collapsible-aside">{aside}</span>}
      </button>
      {open && <div className="av-collapsible-body">{children}</div>}
    </div>
  );
}
