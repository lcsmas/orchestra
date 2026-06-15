import { app, shell } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
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
//   1. ~/.orchestra/logs/orchestra.log  — next to the per-workspace PTY
//      scrollback and worktrees, so all Orchestra data lives under one root.
//      This is the primary (what the "Logs" button reveals).
//   2. <Electron logs dir>/orchestra.log — the platform-standard per-app logs
//      dir (Linux: ~/.config/orchestra/logs), where tooling expects app logs.
// Distinct from the per-workspace PTY scrollback (terminal replay) — this is
// app diagnostics.
//
// Writes are synchronous (appendFileSync): the log carries only low-frequency
// lifecycle + error lines, never the high-volume PTY stream, so blocking I/O per
// line is negligible — and it guarantees every line is on disk before a crash or
// SIGTERM, which a buffered WriteStream cannot.

type Level = 'debug' | 'info' | 'warn' | 'error';

// Rotate each log once it passes this, keeping a single .1 backup. Two files of
// this size is plenty to capture a session leading up to a crash without letting
// the log grow unbounded.
const MAX_BYTES = 5 * 1024 * 1024; // 5 MB

const isDev = !!process.env.VITE_DEV_SERVER_URL;

interface Sink {
  dir: string;
  file: string;
  bytes: number;
}

let sinks: Sink[] = [];
let ready = false;

function electronLogsDir(): string {
  // app.getPath('logs') is only valid after `ready`; fall back to userData if
  // called earlier so init never throws.
  try {
    return app.getPath('logs');
  } catch {
    return path.join(app.getPath('userData'), 'logs');
  }
}

/** Log directories in priority order; the first is the primary (revealed by the
 *  UI). De-duplicated in case the platform ever resolves them to the same path. */
function logDirs(): string[] {
  const orchestraDir = path.join(os.homedir(), '.orchestra', 'logs');
  return Array.from(new Set([orchestraDir, electronLogsDir()]));
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

function formatMeta(meta: unknown): string {
  if (meta === undefined) return '';
  if (meta instanceof Error) {
    return ` ${meta.stack || `${meta.name}: ${meta.message}`}`;
  }
  if (typeof meta === 'string') return ` ${meta}`;
  try {
    return ` ${JSON.stringify(meta)}`;
  } catch {
    return ` ${String(meta)}`;
  }
}

function write(level: Level, message: string, meta?: unknown) {
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
  debug: (message: string, meta?: unknown) => write('debug', message, meta),
  info: (message: string, meta?: unknown) => write('info', message, meta),
  warn: (message: string, meta?: unknown) => write('warn', message, meta),
  error: (message: string, meta?: unknown) => write('error', message, meta),
};

/** Path to the primary log file (empty before initLogger runs). */
export function getLogFile(): string {
  return sinks[0]?.file ?? '';
}

/** Reveal the primary log file in the OS file manager (falls back to its dir). */
export async function revealLogs(): Promise<void> {
  const primary = sinks[0];
  if (!primary) return;
  if (fs.existsSync(primary.file)) {
    shell.showItemInFolder(primary.file);
  } else {
    await shell.openPath(primary.dir);
  }
}

/**
 * Prepare the log files and install process-wide crash handlers.
 * Call once, after `app.whenReady()`.
 */
export function initLogger(): void {
  if (ready) return;
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

  log.info(
    `=== Orchestra ${app.getVersion()} starting === pid=${process.pid} platform=${process.platform} electron=${process.versions.electron} node=${process.versions.node}`,
  );
}
