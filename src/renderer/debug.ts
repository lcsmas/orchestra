// Runtime-toggleable debug logging for the renderer's activity/status pipeline.
//
// Off by default — zero overhead and zero console noise in normal use. Enable
// from the devtools console WITHOUT a rebuild (it persists across reloads):
//
//   orchestraDebug()        // turn on, then reloads
//   orchestraDebug(false)   // turn off, then reloads
//
// When on, the status-dot transitions and the agent-lifecycle IPC the renderer
// actually receives are logged. That's what lets you tell a renderer-side
// desync (a `workspace:update` that arrived stale, late, or never reached the
// store) apart from a main-side one (main never sent it) — the exact ambiguity
// behind a status dot that's stuck on the wrong colour.
const KEY = 'orchestra:debug';

let enabled = false;
try {
  enabled = localStorage.getItem(KEY) === '1';
} catch {
  /* storage unavailable — stay disabled */
}

/** Whether debug logging is on. Cheap; call it to gate any extra work a log
 *  line would need (e.g. looking up the previous status) before logging. */
export function debugEnabled(): boolean {
  return enabled;
}

/** Log a tagged line when debug is enabled; a no-op otherwise. */
export function dlog(tag: string, ...args: unknown[]): void {
  if (!enabled) return;
  // eslint-disable-next-line no-console
  console.log(`%c[orchestra:${tag}]`, 'color:#7aa2f7;font-weight:600', ...args);
}

declare global {
  interface Window {
    orchestraDebug?: (on?: boolean) => void;
  }
}

// Expose the toggle on `window` so it's reachable from the devtools console
// without importing anything.
try {
  window.orchestraDebug = (on = true) => {
    try {
      localStorage.setItem(KEY, on ? '1' : '0');
    } catch {
      /* ignore */
    }
    location.reload();
  };
} catch {
  /* non-browser context (tests) — no global to attach to */
}
