// Typing a workspace's opening brief into a freshly opened terminal agent (`pty:start`, first ever spawn), lifted out of api-handlers.ts so
// the REAL pause gate is driven by a rig (the Electron-bound handler cannot load under node --test). #252 ledger #261 row 11.

import { pauseRefusalById } from './pause-gate.ts';
import { log } from './logger.ts';

/** How long the TUI gets to initialise before the brief is typed. */
export const OPENING_BRIEF_DELAY_MS = 1200;

/** Type `task` into terminal `id` after the TUI had a moment to start — unless the workspace's run is PAUSED at FIRE time: the human only
 *  opened the terminal, typing the brief is an AUTO turn start. `write` is the pty writer (injected for the rig). Returns the timer. */
export function scheduleOpeningBrief(
  id: string,
  task: string,
  write: (id: string, data: string) => void,
  delayMs: number = OPENING_BRIEF_DELAY_MS,
): ReturnType<typeof setTimeout> {
  return setTimeout(() => {
    const pausedRun = pauseRefusalById(id, 'auto');
    if (pausedRun) return log.info(`pty:start ${id}: opening brief not typed — ${pausedRun}`);
    write(id, task + '\n');
    // Status flips to running once Claude fires its UserPromptSubmit hook.
  }, delayMs);
}
