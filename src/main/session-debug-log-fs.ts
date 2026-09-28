// Main-side filesystem wiring for the per-session debug-log black box (#177).
//
// The pure retention policy lives in `src/shared/session-debug-log.ts`; this
// module owns the side effects: resolve the sessions dir under the active
// ORCHESTRA_HOME, mint a per-session file path, and sweep the dir against the
// caps. agent-sdk.ts sets the minted path as the SDK `debugFile` option (which
// the SDK maps to the CLI's `--debug-file <path>` flag — the same surface the
// #176 rig used) at the LOCAL query() launch, then calls `sweepSessionDebugLogs`
// so retention is enforced the moment new captures appear.

import fs from 'node:fs';
import path from 'node:path';
import { orchestraHome } from './platform';
import { log } from './logger';
import {
  DEFAULT_SESSION_DEBUG_RETENTION,
  SESSION_DEBUG_LOG_EXT,
  planSessionDebugLogSweep,
  sessionDebugLogName,
  type SessionDebugLogFile,
  type SessionDebugLogRetention,
} from '../shared/session-debug-log';

/** `<ORCHESTRA_HOME>/logs/sessions` — a sibling of orchestra.log and the pty
 *  logs, but its own dir so the sweep can enumerate ONLY session captures.
 *  Deliberately NOT under the worktree (dies with the worktree) nor under
 *  `keepers/` (swept when the keeper dies) — this must OUTLIVE deletion. */
export function sessionDebugLogDir(): string {
  return path.join(orchestraHome(), 'logs', 'sessions');
}

/**
 * Mint the debug-log path for a session spawning now, creating the dir. Returns
 * `null` (never throws) if the dir can't be created — a capture is best-effort
 * observability and must never block a session from starting.
 */
export function newSessionDebugLogPath(wsId: string, spawnedAtMs = Date.now()): string | null {
  const dir = sessionDebugLogDir();
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (e) {
    log.warn(`session-debug-log: cannot create ${dir} — no per-session capture`, e);
    return null;
  }
  return path.join(dir, sessionDebugLogName(wsId, spawnedAtMs));
}

/**
 * Enforce retention on the sessions dir. Best-effort: any error is logged and
 * swallowed (never blocks a spawn). `keepPath`, when given, is the file this
 * spawn is about to write — it is excluded from eviction so a fresh capture is
 * never deleted before it holds anything.
 */
export function sweepSessionDebugLogs(
  keepPath?: string | null,
  retention: SessionDebugLogRetention = DEFAULT_SESSION_DEBUG_RETENTION,
  nowMs = Date.now(),
): void {
  const dir = sessionDebugLogDir();
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return; // no dir yet → nothing to sweep
  }
  const files: SessionDebugLogFile[] = [];
  for (const name of entries) {
    if (!name.endsWith(SESSION_DEBUG_LOG_EXT)) continue;
    try {
      const st = fs.statSync(path.join(dir, name));
      if (!st.isFile()) continue;
      files.push({ name, size: st.size, mtimeMs: st.mtimeMs });
    } catch {
      /* raced deletion — skip */
    }
  }
  const keepName = keepPath ? path.basename(keepPath) : undefined;
  const doomed = planSessionDebugLogSweep(files, retention, nowMs, keepName);
  for (const name of doomed) {
    try {
      fs.unlinkSync(path.join(dir, name));
    } catch {
      /* already gone / raced */
    }
  }
  if (doomed.length) log.debug(`session-debug-log: swept ${doomed.length} old capture(s) from ${dir}`);
}
