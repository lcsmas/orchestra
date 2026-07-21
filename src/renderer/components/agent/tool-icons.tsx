// Per-tool icons for the structured agent view's tool cards. One consistent
// 14px stroke family (1.5px, round caps, currentColor) so cards read by shape
// at a glance instead of by reading the tool name. Decorative only — every
// usage sits next to the visible tool name, so they are aria-hidden.
import React from 'react';

function Svg({ children }: { children: React.ReactNode }) {
  return (
    <svg
      className="av-tool-icon"
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

const terminal = (
  <Svg>
    <path d="M3 5.5 6 8l-3 2.5" />
    <path d="M8.5 11H13" />
  </Svg>
);

const pencil = (
  <Svg>
    <path d="M9.5 3.5 12.5 6.5 6 13H3v-3z" />
    <path d="M8.25 4.75 11.25 7.75" />
  </Svg>
);

const filePlus = (
  <Svg>
    <path d="M9 2H4.5A1 1 0 0 0 3.5 3v10a1 1 0 0 0 1 1h7a1 1 0 0 0 1-1V5.5z" />
    <path d="M9 2v3.5h3.5" />
    <path d="M8 8v3M6.5 9.5h3" />
  </Svg>
);

const fileLines = (
  <Svg>
    <path d="M9 2H4.5A1 1 0 0 0 3.5 3v10a1 1 0 0 0 1 1h7a1 1 0 0 0 1-1V5.5z" />
    <path d="M9 2v3.5h3.5" />
    <path d="M5.75 8.5h4.5M5.75 11h4.5" />
  </Svg>
);

const magnifier = (
  <Svg>
    <circle cx="7" cy="7" r="4" />
    <path d="M10 10l3.5 3.5" />
  </Svg>
);

const checklist = (
  <Svg>
    <path d="M3 4.5 4.2 5.7 6.4 3.5" />
    <path d="M9 4.5h4" />
    <path d="M3 10.5 4.2 11.7 6.4 9.5" />
    <path d="M9 10.5h4" />
  </Svg>
);

const agent = (
  <Svg>
    <circle cx="8" cy="5" r="2.5" />
    <path d="M8 7.5v2" />
    <path d="M4.5 13.5a3.5 3.5 0 0 1 7 0" />
  </Svg>
);

const globe = (
  <Svg>
    <circle cx="8" cy="8" r="5.5" />
    <path d="M2.5 8h11" />
    <path d="M8 2.5c1.8 1.5 2.7 3.4 2.7 5.5S9.8 12 8 13.5C6.2 12 5.3 10.1 5.3 8S6.2 4 8 2.5z" />
  </Svg>
);

const gear = (
  <Svg>
    <circle cx="8" cy="8" r="2" />
    <path d="M8 2.8v1.4M8 11.8v1.4M13.2 8h-1.4M4.2 8H2.8M11.7 4.3l-1 1M5.3 10.7l-1 1M11.7 11.7l-1-1M5.3 5.3l-1-1" />
  </Svg>
);

const ICONS: Record<string, React.ReactNode> = {
  bash: terminal,
  edit: pencil,
  notebookedit: pencil,
  write: filePlus,
  read: fileLines,
  grep: magnifier,
  glob: magnifier,
  websearch: globe,
  webfetch: globe,
  task: agent,
  agent: agent,
  todowrite: checklist,
};

/** Icon for a tool by SDK name; unknown tools get the gear. */
export function ToolIcon({ name }: { name: string }) {
  return <>{ICONS[name.toLowerCase()] ?? gear}</>;
}
