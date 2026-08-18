// Transcript-based loop reconcile — the fs/scheduling half of
// src/shared/loop-scan.ts (see that module for WHY live detection is not
// enough: CC-daemon-hosted loop iterations are invisible to both the spool
// hooks and the SDK stream).
//
// Runs once shortly after startup (backfills loops that predate the flag or
// ticked while the app was closed) and then on a coarse interval, stat-gated:
// a workspace's transcript is re-read ONLY when its mtime moved, so a quiet
// fleet costs one stat per workspace per sweep.

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { store } from './store';
import { scoped } from './logger';
import { markLooping } from './activity';
import { scanTranscriptTailForLoop } from '../shared/loop-scan.ts';
import { readTailUntil } from '../shared/tail-read.ts';
import { workspaceAccountConfigDir, mangleProjectDir } from './workspaces';
import type { Workspace } from '../shared/types';

const llog = scoped('loop-scan');


/** Sweep cadence. Coarse on purpose — the badge appearing within minutes of a
 *  daemon-hosted tick is plenty, and the steady-state cost is N stats. */
const SWEEP_MS = 5 * 60 * 1000;

/** mtimeMs of each workspace's transcript at its last scan — the stat gate. */
const lastScanned = new Map<string, number>();

/** Resolve the workspace's transcript file: the pinned account's config dir
 *  (default ~/.claude) + mangled worktree path + the known SDK session id, or
 *  the newest .jsonl when the session id is unknown (terminal sessions). Same
 *  resolution as `claude --continue` / agent-sdk's transcriptDir. */
async function transcriptFileFor(ws: Workspace): Promise<string | null> {
  const base =
    workspaceAccountConfigDir(ws, undefined) || path.join(os.homedir(), '.claude');
  const dir = path.join(base, 'projects', mangleProjectDir(ws.worktreePath));
  if (ws.sdkSessionId) {
    const p = path.join(dir, `${ws.sdkSessionId}.jsonl`);
    try {
      await fs.access(p);
      return p;
    } catch {
      /* fall through to newest — the id may be from a cleared session */
    }
  }
  try {
    const entries = await fs.readdir(dir);
    let best: string | null = null;
    let newest = 0;
    for (const name of entries) {
      if (!name.endsWith('.jsonl')) continue;
      const p = path.join(dir, name);
      const st = await fs.stat(p);
      if (st.mtimeMs > newest) {
        newest = st.mtimeMs;
        best = p;
      }
    }
    return best;
  } catch {
    return null;
  }
}

/** One reconcile pass over every live workspace. Exported for the e2e gate. */
export async function sweepLoopScan(): Promise<void> {
  const now = Date.now();
  for (const ws of store.workspaces) {
    if (ws.archived || !ws.worktreePath) continue;
    try {
      const file = await transcriptFileFor(ws);
      if (!file) continue;
      const mtime = (await fs.stat(file)).mtimeMs;
      if (lastScanned.get(ws.id) === mtime) continue;
      lastScanned.set(ws.id, mtime);
      // Backward chunked read until the newest ScheduleWakeup is in the
      // window (capped at 8 MiB): a fixed small tail went permanently
      // `unknown` on chatty sessions whose last ScheduleWakeup drifted out of
      // it, so a dead loop's badge could never clear (observed live: deciding
      // entry 474 KB from EOF of a 3.2 MB transcript vs a 256 KiB window).
      const tail = await readTailUntil(file, '"ScheduleWakeup"');
      if (tail === null) continue;
      const verdict = scanTranscriptTailForLoop(tail, now);
      llog.trace(`ws=${ws.id} verdict=${verdict.state}`);
      if (verdict.state === 'looping') {
        void markLooping(ws.id, true);
      } else if (verdict.state === 'stopped' || verdict.state === 'stale') {
        // Clears loops that self-terminated or died while nothing observed
        // them. `unknown` deliberately clears NOTHING — a bounded tail with no
        // ScheduleWakeup says nothing about the session (the empty-window
        // trap), and the live rules (stop:true / clear / process death) still
        // own the observable cases.
        void markLooping(ws.id, false);
      }
    } catch (e) {
      llog.swallow(`loop scan ws=${ws.id}`, e);
    }
  }
}

let timer: ReturnType<typeof setInterval> | null = null;

export function startLoopScan(): void {
  if (timer) return;
  void sweepLoopScan();
  timer = setInterval(() => void sweepLoopScan(), SWEEP_MS);
  timer.unref();
}

export function stopLoopScan(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
