// Explicit index.ts path so this module also resolves under Node's
// type-stripping test runner (logger.test.ts pulls it in).
import { platform, orchestraHome } from './platform/index.ts';
import fs from 'node:fs';
import path from 'node:path';

// Persistent diagnostic logger for the main process. Orchestra is usually
// launched from a desktop entry / AppImage with no attached terminal, so the
// main process's stdout is invisible and the many best-effort `.catch(() => {})`
// sites used to swallow failures without a trace. This writes a timestamped,
// leveled log to a file the user can hand over when reporting a bug, and routes
// uncaught crashes there too.
//
// The log is written to TWO locations so it's easy to find regardless of where
// you look:
//   1. <ORCHESTRA_HOME>/logs/orchestra.log (default ~/.orchestra/logs) — next
//      to the per-workspace PTY scrollback and worktrees, so all Orchestra
//      data lives under one root. This is the primary (what the "Logs" button
//      reveals), and it follows the $ORCHESTRA_HOME override so an isolated
//      dev instance never writes into the real home's log.
//   2. <Electron logs dir>/orchestra.log — the platform-standard per-app logs
//      dir (Linux: ~/.config/orchestra/logs), where tooling expects app logs.
// Distinct from the per-workspace PTY scrollback (terminal replay) — this is
// app diagnostics.
//
// Writes are synchronous (appendFileSync): the log carries only low-frequency
// lifecycle + error lines, never the high-volume PTY stream, so blocking I/O per
// line is negligible — and it guarantees every line is on disk before a crash or
// SIGTERM, which a buffered WriteStream cannot.

type Level = 'trace' | 'debug' | 'info' | 'warn' | 'error';

/** Numeric severity so a threshold check is a single comparison on the hot path.
 *  `trace` is for per-event firehose lines (every IPC call, every status
 *  transition, every spool event) that would drown the log at `debug`. */
const LEVEL_RANK: Record<Level, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
};

// Rotate each log once it passes this, keeping a single .1 backup. Two files of
// this size is plenty to capture a session leading up to a crash without letting
// the log grow unbounded.
const MAX_BYTES = 5 * 1024 * 1024; // 5 MB

const isDev = !!process.env.VITE_DEV_SERVER_URL;

/**
 * Minimum level actually written, from `$ORCHESTRA_LOG_LEVEL` (default `info`).
 *
 * The verbose levels are opt-in for two reasons: disk cost (a `trace` session
 * rotates 5 MB in minutes) and signal-to-noise (an always-on firehose buries the
 * three lines that matter). Reproducing a bug is then:
 *   ORCHESTRA_LOG_LEVEL=trace orchestra
 * …with no rebuild, which is the point — the instrumentation is compiled in and
 * dormant, not something you add after the bug appears and can't reproduce.
 *
 * Unknown/misspelled values fall back to `info` rather than silently disabling
 * logging: a typo'd level must never be the reason a crash went unrecorded.
 */
function resolveThreshold(): number {
  const raw = (process.env.ORCHESTRA_LOG_LEVEL || '').trim().toLowerCase();
  if (raw && raw in LEVEL_RANK) return LEVEL_RANK[raw as Level];
  if (raw) console.error(`logger: unknown ORCHESTRA_LOG_LEVEL "${raw}"; using "info"`);
  return LEVEL_RANK.info;
}

let threshold = resolveThreshold();

/** True when `level` would be written — lets a caller skip building an
 *  expensive meta payload (a diff, a process tree) that would be discarded. */
export function isLevelEnabled(level: Level): boolean {
  return LEVEL_RANK[level] >= threshold;
}

/** The active minimum level, e.g. `'info'`. Surfaced over `app:info` so a
 *  frontend process (renderer / GTK) can mirror the backend's verbosity. */
export function getLogLevel(): Level {
  return (
    (Object.keys(LEVEL_RANK) as Level[]).find((l) => LEVEL_RANK[l] === threshold) ?? 'info'
  );
}

interface Sink {
  dir: string;
  file: string;
  bytes: number;
}

let sinks: Sink[] = [];
let ready = false;

/** Log directories in priority order; the first is the primary (revealed by the
 *  UI). De-duplicated in case the platform ever resolves them to the same path.
 *  The per-app dir comes through the seam (Electron's logs path, or its
 *  userData/logs fallback before `ready`). */
function logDirs(): string[] {
  const orchestraDir = path.join(orchestraHome(), 'logs');
  return Array.from(new Set([orchestraDir, platform.getLogsDir()]));
}

function rotateIfNeeded(sink: Sink) {
  if (sink.bytes <= MAX_BYTES) return;
  try {
    fs.renameSync(sink.file, `${sink.file}.1`); // overwrites the previous backup
  } catch {
    /* rotation is best-effort — keep appending to the current file */
  }
  sink.bytes = 0;
}

/** Cap on a single serialized meta payload. An agent event or a git diff can be
 *  megabytes; one such line would blow the rotation window and evict the history
 *  around the bug. Truncation is marked so a reader knows the value was cut
 *  rather than genuinely short. */
const MAX_META_CHARS = 4000;

function clamp(s: string): string {
  return s.length <= MAX_META_CHARS ? s : `${s.slice(0, MAX_META_CHARS)}…(+${s.length - MAX_META_CHARS} chars)`;
}

function formatMeta(meta: unknown): string {
  if (meta === undefined) return '';
  if (meta instanceof Error) {
    // Include an attached `cause` chain — Node wraps low-level errors (ENOENT,
    // ECONNREFUSED) as a cause, and that inner error is usually the actual
    // diagnosis while the outer message is generic.
    const cause = (meta as { cause?: unknown }).cause;
    const base = meta.stack || `${meta.name}: ${meta.message}`;
    const extra =
      cause instanceof Error
        ? `\n  caused by: ${cause.stack || `${cause.name}: ${cause.message}`}`
        : cause !== undefined
          ? `\n  caused by: ${String(cause)}`
          : '';
    // Surface errno-style fields (code/errno/syscall/path) that live on the
    // object but never appear in `.stack`.
    const e = meta as NodeJS.ErrnoException;
    const bits = [
      e.code && `code=${e.code}`,
      e.syscall && `syscall=${e.syscall}`,
      e.path && `path=${e.path}`,
    ].filter(Boolean);
    const errno = bits.length ? ` (${bits.join(' ')})` : '';
    return clamp(` ${base}${errno}${extra}`);
  }
  if (typeof meta === 'string') return clamp(` ${meta}`);
  try {
    return clamp(` ${JSON.stringify(meta)}`);
  } catch {
    // Circular or BigInt-bearing payload — don't lose the line over it.
    try {
      return clamp(` ${inspectSafe(meta)}`);
    } catch {
      return ` ${String(meta)}`;
    }
  }
}

/** JSON.stringify with cycles replaced by a marker, so a circular object still
 *  yields readable diagnostics instead of throwing away the whole meta. */
function inspectSafe(value: unknown): string {
  const seen = new WeakSet<object>();
  return JSON.stringify(value, (_k, v) => {
    if (typeof v === 'bigint') return `${v}n`;
    if (typeof v === 'object' && v !== null) {
      if (seen.has(v)) return '[circular]';
      seen.add(v);
    }
    return v;
  });
}

function write(level: Level, message: string, meta?: unknown) {
  if (LEVEL_RANK[level] < threshold) return;
  const line = `${new Date().toISOString()} [${level.toUpperCase()}] ${message}${formatMeta(meta)}\n`;
  if (isDev) {
    const sink = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
    sink(line.trimEnd());
  }
  if (!ready) return;
  const len = Buffer.byteLength(line);
  for (const s of sinks) {
    try {
      fs.appendFileSync(s.file, line);
      s.bytes += len;
      rotateIfNeeded(s);
    } catch {
      /* a write failure on one sink must never crash the app it diagnoses */
    }
  }
}

export const log = {
  trace: (message: string, meta?: unknown) => write('trace', message, meta),
  debug: (message: string, meta?: unknown) => write('debug', message, meta),
  info: (message: string, meta?: unknown) => write('info', message, meta),
  warn: (message: string, meta?: unknown) => write('warn', message, meta),
  error: (message: string, meta?: unknown) => write('error', message, meta),
};

export interface ScopedLogger {
  trace(message: string, meta?: unknown): void;
  debug(message: string, meta?: unknown): void;
  info(message: string, meta?: unknown): void;
  warn(message: string, meta?: unknown): void;
  error(message: string, meta?: unknown): void;
  /** Log an error without rethrowing — the explicit replacement for a silent
   *  `catch {}`. Returns undefined so it can tail an expression arm. */
  swallow(what: string, err: unknown): void;
  /** Time an async operation: emits `trace` on entry and `debug` on exit with a
   *  duration, or `error` with the duration if it throws (then rethrows). The
   *  duration is what turns "it's slow sometimes" into a specific culprit. */
  time<T>(what: string, fn: () => Promise<T>): Promise<T>;
  /** Derive a narrower scope: `scoped('git').child('merge')` → `[git:merge]`. */
  child(sub: string): ScopedLogger;
  /** True when `trace` is being recorded. Lets a caller take a MORE EXPENSIVE
   *  path purely for diagnostics (e.g. evaluating each branch of a short-circuit
   *  chain separately so the log can name which one decided the result) without
   *  paying for it when tracing is off. */
  traceEnabled(): boolean;
}

/**
 * A logger that tags every line with a subsystem, e.g.
 *   2026-07-26T…Z [WARN] [pty] spawn failed …
 *
 * The tag is what makes the log greppable once it's verbose: `grep '\[pty\]'`
 * isolates one subsystem's story out of an interleaved multi-subsystem trace,
 * which is the difference between a 5 MB file being useful and being noise.
 */
export function scoped(scope: string): ScopedLogger {
  const tag = `[${scope}]`;
  const at = (level: Level) => (message: string, meta?: unknown) =>
    write(level, `${tag} ${message}`, meta);
  return {
    trace: at('trace'),
    debug: at('debug'),
    info: at('info'),
    warn: at('warn'),
    error: at('error'),
    swallow(what: string, err: unknown) {
      write('warn', `${tag} ${what} failed (non-fatal)`, err);
    },
    async time<T>(what: string, fn: () => Promise<T>): Promise<T> {
      const started = Date.now();
      write('trace', `${tag} ${what} …`);
      try {
        const out = await fn();
        write('debug', `${tag} ${what} ok in ${Date.now() - started}ms`);
        return out;
      } catch (err) {
        write('error', `${tag} ${what} threw after ${Date.now() - started}ms`, err);
        throw err;
      }
    },
    child(sub: string) {
      return scoped(`${scope}:${sub}`);
    },
    traceEnabled() {
      return isLevelEnabled('trace');
    },
  };
}

/** Path to the primary log file (empty before initLogger runs). */
export function getLogFile(): string {
  return sinks[0]?.file ?? '';
}

/** Reveal the primary log file in the OS file manager (falls back to its dir). */
export async function revealLogs(): Promise<void> {
  const primary = sinks[0];
  if (!primary) return;
  if (fs.existsSync(primary.file)) {
    platform.showItemInFolder(primary.file);
  } else {
    await platform.openPath(primary.dir);
  }
}

/**
 * Prepare the log files and install process-wide crash handlers.
 * Call once, after `app.whenReady()`.
 */
export function initLogger(): void {
  if (ready) return;
  // Re-read here as well as at module load: tests and the daemon entry set
  // ORCHESTRA_LOG_LEVEL after this module is first imported.
  threshold = resolveThreshold();
  for (const dir of logDirs()) {
    const file = path.join(dir, 'orchestra.log');
    try {
      fs.mkdirSync(dir, { recursive: true });
      const bytes = fs.existsSync(file) ? fs.statSync(file).size : 0;
      const sink: Sink = { dir, file, bytes };
      rotateIfNeeded(sink);
      sinks.push(sink);
    } catch (e) {
      // Skip a sink we can't open; others may still work.
      console.error(`logger: cannot open log dir ${dir}`, e);
    }
  }
  ready = sinks.length > 0;
  if (!ready) console.error('logger init failed; logging to console only');

  // Last-resort capture: anything that escapes a try/catch lands here instead
  // of vanishing into a dead desktop-launched process.
  process.on('uncaughtException', (err) => {
    log.error('uncaughtException', err);
  });
  process.on('unhandledRejection', (reason) => {
    log.error('unhandledRejection', reason);
  });

  // The banner is the first thing anyone reading a bug report looks at, so it
  // carries everything needed to reproduce: build, runtime, and — critically —
  // the active log level, so a reader knows whether an ABSENT line means "the
  // event didn't happen" or "that level wasn't being recorded". Without this,
  // a quiet log is ambiguous in exactly the way that wastes debugging time.
  const level = (Object.keys(LEVEL_RANK) as Level[]).find((l) => LEVEL_RANK[l] === threshold);
  log.info(
    `=== Orchestra ${platform.getAppVersion()} (${platform.kind}) starting === pid=${process.pid} platform=${process.platform} electron=${process.versions.electron ?? 'none'} node=${process.versions.node} logLevel=${level}${process.env.ORCHESTRA_LOG_LEVEL ? '' : ' (default; set ORCHESTRA_LOG_LEVEL=trace|debug for more)'} home=${orchestraHome()}`,
  );
}
