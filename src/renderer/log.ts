// Renderer-side diagnostic logging.
//
// Why this exists: until now NOTHING in the renderer reached the diagnostic log
// file. A React error, a failed IPC call, a bad store transition — all of it
// went to the DevTools console, which is closed in a packaged build and whose
// buffer dies with the window. Half of Orchestra's user-visible bugs live in the
// renderer, and they were the half leaving no evidence behind.
//
// Every line here is forwarded over the `logs:write` IPC into the SAME
// orchestra.log the main process writes, so one artifact tells the whole story
// across both processes, in causal order. Lines are tagged `[renderer]` by the
// main-side handler and with a subsystem scope by `scoped()` here, so
// `grep '\[renderer\] \[store\]'` isolates one subsystem in one process.
//
// Level gating mirrors the main process: verbose levels are compiled in but
// dormant, enabled per-session without a rebuild. Because the renderer can't
// read the environment, the level is mirrored from the main process at startup
// (see `initRendererLog`) and can be overridden live from DevTools via
// `window.__orchestraLogLevel = 'trace'` — useful when a bug is already on
// screen and you don't want to restart and lose the state.

type Level = 'trace' | 'debug' | 'info' | 'warn' | 'error';

const LEVEL_RANK: Record<Level, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
};

declare global {
  interface Window {
    /** Live override, settable from the DevTools console without a reload. */
    __orchestraLogLevel?: Level;
  }
}

let threshold = LEVEL_RANK.info;

/** Adopt the main process's configured level so one env var governs both
 *  processes. Called once at renderer startup; failure is non-fatal (we simply
 *  keep the `info` default rather than losing logging entirely). */
export async function initRendererLog(): Promise<void> {
  try {
    const level = (await window.orchestra?.logLevel?.()) as Level | undefined;
    if (level && level in LEVEL_RANK) threshold = LEVEL_RANK[level];
  } catch {
    /* keep the default; never let logging setup break startup */
  }
}

function enabled(level: Level): boolean {
  const override = typeof window !== 'undefined' ? window.__orchestraLogLevel : undefined;
  const floor = override && override in LEVEL_RANK ? LEVEL_RANK[override] : threshold;
  return LEVEL_RANK[level] >= floor;
}

/** Errors don't survive `structuredClone` across the IPC boundary — an Error
 *  arrives as `{}`, silently discarding the message and stack that were the
 *  whole point. Flatten to a plain string/object here, on the sending side. */
function serialize(meta: unknown): unknown {
  if (meta === undefined) return undefined;
  if (meta instanceof Error) {
    const cause = (meta as { cause?: unknown }).cause;
    return {
      name: meta.name,
      message: meta.message,
      stack: meta.stack,
      ...(cause !== undefined
        ? { cause: cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause) }
        : {}),
    };
  }
  if (typeof meta === 'object' && meta !== null) {
    // Strip anything non-cloneable (DOM nodes, functions, React fibers) that
    // would make the IPC call itself throw and lose the line.
    try {
      return JSON.parse(JSON.stringify(meta));
    } catch {
      return String(meta);
    }
  }
  return meta;
}

function emit(level: Level, message: string, meta?: unknown): void {
  if (!enabled(level)) return;
  // Mirror to the console too: in dev, DevTools is where you're already looking.
  if (level === 'error') console.error(message, meta ?? '');
  else if (level === 'warn') console.warn(message, meta ?? '');
  try {
    void window.orchestra?.log?.(level, message, serialize(meta));
  } catch {
    /* the log must never be the thing that breaks the UI */
  }
}

export interface RendererLogger {
  trace(message: string, meta?: unknown): void;
  debug(message: string, meta?: unknown): void;
  info(message: string, meta?: unknown): void;
  warn(message: string, meta?: unknown): void;
  error(message: string, meta?: unknown): void;
  /** Explicit replacement for a silent `catch {}` in the renderer. */
  swallow(what: string, err: unknown): void;
}

/** A logger tagged with a UI subsystem, e.g. `scoped('sidebar')`. */
export function scoped(scope: string): RendererLogger {
  const tag = `[${scope}]`;
  const at = (level: Level) => (message: string, meta?: unknown) =>
    emit(level, `${tag} ${message}`, meta);
  return {
    trace: at('trace'),
    debug: at('debug'),
    info: at('info'),
    warn: at('warn'),
    error: at('error'),
    swallow(what: string, err: unknown) {
      emit('warn', `${tag} ${what} failed (non-fatal)`, err);
    },
  };
}

export const log = scoped('ui');

/**
 * Capture the failures that today vanish entirely: an exception escaping any
 * event handler, and a promise rejection nobody caught. Both are common shapes
 * for renderer bugs (an unawaited IPC call that rejects shows as *nothing* —
 * the UI just silently fails to update) and neither currently leaves a trace.
 *
 * Install once, as early as possible in renderer startup.
 */
export function installRendererCrashHandlers(): void {
  window.addEventListener('error', (e) => {
    log.error('uncaught error', e.error ?? `${e.message} @ ${e.filename}:${e.lineno}:${e.colno}`);
  });
  window.addEventListener('unhandledrejection', (e) => {
    log.error('unhandled promise rejection', e.reason);
  });
}
