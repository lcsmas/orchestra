// Session hibernation — the idle sweeper.
//
// Stops the agent process of workspaces that have sat `idle` past the
// threshold, reclaiming their memory while leaving the conversation intact
// (terminal resumes via `claude --continue`, structured via ws.sdkSessionId).
// The eligibility rules are pure and unit-tested in src/shared/hibernation.ts;
// this file supplies the live signals and performs the stop.
//
// Two things this module deliberately does NOT do:
//   - It never touches status. A hibernated workspace stays `idle`, because
//     that IS its state — nothing is running and nobody is needed. Flipping it
//     to `stopped` would repaint the dot and make housekeeping look like an
//     event; `hibernatedAt` carries the distinction instead, for the quiet
//     sidebar chip alone.
//   - It never hibernates a workspace whose run-script PTY is live. The agent
//     may be idle for hours while its dev server does the work, and killing
//     the agent beside a running server reads to the user as "my app died".

import { store } from './store';
import { platform } from './platform';
import { scoped } from './logger';
import { getPtyPid, isRunning, stopPty } from './pty';
import { sdkSessionLive, sdkStopIfLive } from './sdk-delivery';
// NOTE the .ts extension on this VALUE import: main modules pulled into
// `node --test --experimental-strip-types` suites do not resolve extensionless
// relative specifiers (see commit 05adb90 — git.ts/ci-state.ts hit this).
import {
  formatIdleDuration,
  resolveHibernateAfterMs,
  resolveHibernateSweepMs,
  shouldHibernate,
  HIBERNATION_DISABLED,
} from '../shared/hibernation.ts';
// The last-activity map is a dependency-free leaf module because its stamping
// call site (activity.ts applyAgentEvent) cannot import THIS file: hibernation
// → pty → activity would close an import cycle. See hibernation-activity.ts.
import {
  getAppStartedAt,
  getLastActivity,
  noteActivity,
  noteAppStart,
} from './hibernation-activity.ts';
import type { Workspace } from '../shared/types';

const hlog = scoped('hibernate');

let timer: ReturnType<typeof setInterval> | null = null;

// Last-activity tracking lives in ./hibernation-activity.ts (imported above):
// `applyAgentEvent` (activity.ts) is the ONE funnel every agent lifecycle event
// passes through — spool-tailed hook events for the terminal path AND
// `driveStatusFromEvent` for the structured path — so stamping it there is the
// cheapest correct source. The store has no per-workspace activity timestamp
// (statusTextAt is agent-authored prose, not lifecycle), and deriving one from
// the spool files would re-read disk every sweep to recover data we already saw
// go past in memory.

// --- active-workspace tracking ----------------------------------------------
//
// Main has no notion of "the workspace the user is looking at" — selection is
// renderer state. The renderer reports it over `workspaces:setActive` (the same
// call that already drives markSeen's read moment), and the sweeper reads it
// here. Absent (no window, nothing selected) simply means "no workspace is
// protected by activity", which is correct: with no UI attached nothing is
// under the user's cursor.
let activeWorkspaceId: string | null = null;

/** Renderer-reported active workspace. Also clears `hibernatedAt` on the newly
 *  activated row, so opening a hibernated workspace drops the chip immediately
 *  rather than waiting for the process to actually respawn. */
export function setActiveWorkspace(id: string | null): void {
  activeWorkspaceId = id;
  if (id) {
    // Activation is a restore intent: the pane is about to lazy-start its PTY
    // or resume its SDK session. Stamp activity so the next sweep can't kill
    // the process the user just came back to, and clear the chip.
    noteActivity(id);
    clearHibernated(id);
  }
}

export function getActiveWorkspaceId(): string | null {
  return activeWorkspaceId;
}

// --- hibernation state on the workspace record ------------------------------

/** Record `hibernatedAt` and broadcast, following the mutation-site broadcast
 *  convention (persist in the background, broadcast immediately — the store's
 *  disk flush is serialized and must not gate the UI). */
function markHibernated(ws: Workspace, at: number): void {
  const updated: Workspace = { ...ws, hibernatedAt: at };
  void store.upsertWorkspace(updated).catch((e) => hlog.swallow('persist hibernatedAt', e));
  platform.broadcast('workspace:update', updated);
}

/** Clear `hibernatedAt` — the workspace has a process again (or is about to).
 *  Idempotent and cheap: a no-op when the field is already absent, so the
 *  restore paths can call it unconditionally. Exported for those call sites
 *  (pty:start, sdkSend/sdkWake, wakeAgentWithPrompt). */
export function clearHibernated(wsId: string): void {
  const ws = store.getWorkspace(wsId);
  if (!ws || ws.hibernatedAt === undefined) return;
  // Set the key to `undefined` EXPLICITLY — do NOT rest-spread it away. The
  // renderer's `workspace:update` reducer MERGES (`{...old, ...incoming}`), so
  // a record with the key simply ABSENT cannot clear the value already in the
  // renderer's copy: main goes correct, the row keeps its "zZ" chip forever.
  // (Verified e2e: main reported hibernatedAt:null while the DOM still showed
  // the chip.) An explicit `undefined` survives the spread and overwrites it —
  // the same reason `setUnread` sends `markedUnread: unread || undefined`.
  // JSON.stringify omits undefined values, so store.json still stays clean.
  const updated: Workspace = { ...ws, hibernatedAt: undefined };
  void store.upsertWorkspace(updated).catch((e) => hlog.swallow('clear hibernatedAt', e));
  platform.broadcast('workspace:update', updated);
  hlog.debug(`${ws.name}: woke from hibernation`);
  noteActivity(wsId);
}

// --- the sweep --------------------------------------------------------------

/** One pass over the fleet. Exported for the e2e rig and for a caller wanting
 *  a deterministic sweep instead of waiting out the interval. Returns the ids
 *  it hibernated. */
export async function sweepHibernation(): Promise<string[]> {
  const thresholdMs = resolveHibernateAfterMs(process.env.ORCHESTRA_HIBERNATE_AFTER_MS);
  if (thresholdMs === HIBERNATION_DISABLED) return [];
  const now = Date.now();
  const hibernated: string[] = [];

  for (const ws of store.workspaces) {
    const hasLivePty = isRunning(ws.id);
    const hasLiveSdk = sdkSessionLive(ws.id);
    // Seed unseen workspaces at the app-start floor rather than leaving them
    // `undefined` — otherwise a session that has been quietly live since launch
    // (started, never emitted another event) would never become eligible at all.
    const lastActivityAt = getLastActivity(ws.id) ?? getAppStartedAt();

    const eligible = shouldHibernate(ws, {
      now,
      lastActivityAt,
      isActive: activeWorkspaceId === ws.id,
      hasLivePty,
      hasLiveSdk,
      // The run-script PTY registry uses the `<id>:run` naming convention
      // (api-handlers.ts runScript*). Check it BEFORE killing anything.
      hasLiveRunPty: isRunning(`${ws.id}:run`),
      thresholdMs,
    });
    if (!eligible) continue;

    const idleFor = formatIdleDuration(now - lastActivityAt);
    // Sample the pid BEFORE stopping — after `stopPty` the session is gone from
    // the registry and the pid is unrecoverable. Naming it in the log is what
    // makes process death assertable by `ps -p <pid>`: UI text or an absent
    // registry entry proves the app's bookkeeping changed, not that the OS
    // process actually exited.
    const ptyPid = hasLivePty ? getPtyPid(ws.id) : undefined;
    hlog.info(
      `hibernating ${ws.name} (${ws.id}) — idle ${idleFor}` +
        `${hasLivePty ? ` pty${ptyPid !== undefined ? ` pid=${ptyPid}` : ' pid=unknown'}` : ''}` +
        `${hasLiveSdk ? ' sdk' : ''}`,
    );

    if (hasLiveSdk) {
      // Stop the structured session first: it is the path that persists
      // `sdkSessionId`, and stopping it is async. A failure here must not
      // prevent the PTY stop below or abort the whole sweep.
      await sdkStopIfLive(ws.id).catch((e) => hlog.swallow(`sdk stop for ${ws.id}`, e));
    }
    if (hasLivePty) stopPty(ws.id);

    markHibernated(ws, now);
    hibernated.push(ws.id);
  }
  return hibernated;
}

/** Start the periodic sweeper (called once from the main bootstrap). */
export function startHibernationSweeper(): void {
  if (timer) return;
  noteAppStart();
  const thresholdMs = resolveHibernateAfterMs(process.env.ORCHESTRA_HIBERNATE_AFTER_MS);
  if (thresholdMs === HIBERNATION_DISABLED) {
    hlog.info('session hibernation disabled (ORCHESTRA_HIBERNATE_AFTER_MS=-1)');
    return;
  }
  const sweepMs = resolveHibernateSweepMs(process.env.ORCHESTRA_HIBERNATE_SWEEP_MS);
  // Print the raw ms alongside the friendly duration: a test rig injecting a
  // few seconds gets "<1m" from the human formatter, which cannot confirm the
  // injection actually took (5s and 55s both read "<1m").
  hlog.info(
    `session hibernation on — idle threshold ${formatIdleDuration(thresholdMs)} (${thresholdMs}ms), ` +
      `sweep every ${formatIdleDuration(sweepMs)} (${sweepMs}ms)`,
  );
  timer = setInterval(() => {
    void sweepHibernation().catch((e) => hlog.swallow('sweep', e));
  }, sweepMs);
  // Never hold the event loop open for housekeeping.
  timer.unref?.();
}

export function stopHibernationSweeper(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}
