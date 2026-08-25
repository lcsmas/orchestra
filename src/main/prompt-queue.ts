import { randomUUID } from 'node:crypto';
import { platform } from './platform';
import { log } from './logger';
import { store } from './store';
import { isRunning, writePty } from './pty';
import { wakeAgentWithPrompt } from './workspaces';
import { sdkSessionLive } from './sdk-delivery';
import { getAccountUsage, refreshAccountsNow } from './account-usage';
import { getLastUsage } from './usage';
import {
  canAutoFlushQueue,
  resolveWorkspaceAccountId,
  usageLimitedUntil,
  type UsageWindows,
} from '../shared/accounts';
import type { QueuedPrompt, Workspace } from '../shared/types';
import {
  decideResume,
  isCoordinatorWorkspace,
  RESUME_NUDGE_TEXT,
} from '../shared/usage-resume.ts';
import { clearStopReason, markStoppedOnUsageLimit } from './activity';

// Prompt queue for usage-limited accounts. While a workspace's account is over
// its 5h/7d limit, Claude answers every prompt with a "limit reached" error —
// so the UI offers to park prompts here instead. Each queued prompt lives on
// its workspace record (store.json → survives restarts); this module's flusher
// watches the usage pollers' caches and delivers a workspace's queue as soon as
// a snapshot fetched AFTER the newest queued prompt shows the account usable
// again. Delivery reuses the peer-message path: typed into the live TUI, or
// waking the stopped agent with `claude --continue`.
//
// No network calls of its own — it only reads the two pollers' caches
// (account-usage.ts ≥180s per account, usage.ts ~60s for the default login) and
// nudges refreshAccountsNow once a blocked window's reset time has passed.

const MAX_PROMPT_CHARS = 100_000;
const MAX_QUEUE_LENGTH = 50;
// Flusher cadence. Purely local cache reads, so cheap; actual latency after a
// reset is dominated by the pollers' own cadence (60s global / ≤180s+30s per
// account), not by this tick.
const TICK_MS = 20_000;
// Don't nudge the per-account poller more often than this per workspace, even
// if the reset time has long passed (e.g. the endpoint keeps reporting 100%).
const REFRESH_NUDGE_MS = 120_000;
// Max usage-limit resumes started per tick (#74, review-74 R5). At TICK_MS this
// spreads a large fleet over successive ticks rather than waking every
// workspace on one account in the same pass. Deliberately > 1 so a small fleet
// still recovers promptly, and small enough that a big one ramps.
const MAX_RESUMES_PER_TICK = 3;

function broadcast(ws: Workspace): void {
  platform.broadcast('workspace:update', ws);
}

/** The freshest usage reading for the account a workspace logs in as: the
 *  per-account cache for a pinned account, the global (default-login) poller
 *  otherwise. Null when that source has nothing yet. */
function usageForWorkspace(ws: Workspace): { fetchedAt: number; data: UsageWindows | null } | null {
  const knownIds = new Set(store.accounts.map((a) => a.id));
  const accountId = resolveWorkspaceAccountId(ws.accountId, knownIds);
  if (accountId) {
    const status = getAccountUsage(accountId);
    return status ? { fetchedAt: status.fetchedAt, data: status.data } : null;
  }
  const snap = getLastUsage();
  return snap
    ? { fetchedAt: snap.fetchedAt, data: { fiveHour: snap.fiveHour, sevenDay: snap.sevenDay } }
    : null;
}

/** Park a prompt on a workspace's queue. Rejects unknown/archived workspaces,
 *  empty text, and a full queue. Returns the updated workspace (also
 *  broadcast, so every renderer view sees the new queue immediately). */
export async function addQueuedPrompt(id: string, text: string): Promise<Workspace> {
  const ws = store.getWorkspace(id);
  if (!ws || ws.archived) throw new Error('unknown workspace');
  const body = text.replace(/\r\n?/g, '\n').trim();
  if (!body) throw new Error('empty prompt');
  const queue = ws.queuedPrompts ?? [];
  if (queue.length >= MAX_QUEUE_LENGTH) throw new Error('prompt queue is full');
  const entry: QueuedPrompt = {
    id: randomUUID(),
    text: body.slice(0, MAX_PROMPT_CHARS),
    queuedAt: Date.now(),
  };
  const updated: Workspace = { ...ws, queuedPrompts: [...queue, entry] };
  await store.upsertWorkspace(updated);
  broadcast(updated);
  return updated;
}

/** Drop one queued prompt by its entry id. No-op when already gone. */
export async function removeQueuedPrompt(id: string, promptId: string): Promise<Workspace> {
  const ws = store.getWorkspace(id);
  if (!ws) throw new Error('unknown workspace');
  const queue = ws.queuedPrompts ?? [];
  const next = queue.filter((p) => p.id !== promptId);
  if (next.length === queue.length) return ws;
  const updated: Workspace = { ...ws, queuedPrompts: next };
  await store.upsertWorkspace(updated);
  broadcast(updated);
  return updated;
}

export interface FlushResult {
  ok: boolean;
  /** How many prompts were handed to the agent (they go as ONE turn). */
  delivered: number;
  error?: string;
}

/** Deliver a workspace's queued prompts to its agent as one turn and clear the
 *  queue. `force` (the UI's "Send now") skips the limit check; the flusher
 *  passes false so an auto-flush re-verifies right before sending. If the
 *  agent is stopped it is woken via `claude --continue`; if the woken process
 *  dies within seconds (e.g. nothing to resume and CC bails), the prompts are
 *  re-queued so nothing is silently lost. */
export async function flushQueuedPrompts(
  id: string,
  opts: { force?: boolean } = {},
): Promise<FlushResult> {
  const ws = store.getWorkspace(id);
  if (!ws || ws.archived) return { ok: false, delivered: 0, error: 'unknown workspace' };
  const queue = ws.queuedPrompts ?? [];
  if (queue.length === 0) return { ok: true, delivered: 0 };

  if (!opts.force) {
    const usage = usageForWorkspace(ws);
    const now = Date.now();
    if (usage?.data && usageLimitedUntil(usage.data, now) !== null) {
      return { ok: false, delivered: 0, error: 'account still at its usage limit' };
    }
  }

  // One turn, oldest-first. Joining beats submitting N separate turns: the
  // live-TUI path would race Claude's own input handling on the later sends,
  // and the wake path can only hand over a single opening prompt.
  const body = queue
    .map((p) => p.text)
    .join('\n\n')
    .replace(/\r/g, '');

  // Clear the queue BEFORE delivery so a re-entrant flush (tick + "Send now"
  // racing) can't double-send; failure paths below re-queue.
  const cleared: Workspace = { ...ws, queuedPrompts: [] };
  await store.upsertWorkspace(cleared);
  broadcast(cleared);

  const requeue = async (): Promise<void> => {
    const current = store.getWorkspace(id);
    if (!current) return;
    const restored: Workspace = {
      ...current,
      queuedPrompts: [...queue, ...(current.queuedPrompts ?? [])],
    };
    await store.upsertWorkspace(restored);
    broadcast(restored);
  };

  if (isRunning(id)) {
    // Type the body, then a SEPARATE carriage return a beat later so the TUI
    // submits it as one turn — same trick as the peer-message live path.
    writePty(id, body);
    setTimeout(() => writePty(id, '\r'), 80);
    return { ok: true, delivered: queue.length };
  }

  try {
    if (await wakeAgentWithPrompt(id, body)) {
      // Insurance mirrored from dispatchMessageRequest: a woken agent that
      // dies almost immediately lost the injected prompt — restore the queue
      // so the user still sees (and can re-send) it. A structured (SDK) session
      // has no PTY, so isRunning is always false for it: treat a live SDK
      // session as "still up" too, or the insurance would wrongly re-queue an
      // already-delivered structured turn.
      setTimeout(() => {
        if (!isRunning(id) && !sdkSessionLive(id)) void requeue();
      }, 5000);
      return { ok: true, delivered: queue.length };
    }
  } catch (e) {
    log.warn(`prompt-queue wake failed for ${id}`, e);
  }
  await requeue();
  return { ok: false, delivered: 0, error: 'could not start the agent' };
}

let timer: ReturnType<typeof setInterval> | null = null;
// Last time this workspace's stale limit made us nudge the account poller.
const lastNudge = new Map<string, number>();

/** Auto-resume the sessions a usage limit killed (#74).
 *
 *  Runs on the flusher's existing tick rather than a loop of its own: it needs
 *  exactly the same inputs (each workspace's freshest usage reading) and the
 *  same cadence, and sharing the tick keeps the queue-vs-nudge precedence
 *  decidable in ONE place instead of racing two timers against each other.
 *
 *  All policy lives in `decideResume` (src/shared/usage-resume.ts) — this
 *  function only gathers inputs and executes the verdict, which is what makes
 *  the behaviour testable without Electron, a network, or a real usage limit.
 *
 *  COORDINATORS FIRST: the list is sorted so orchestrators are handled before
 *  their children within a single tick. A coordinator's first act after waking
 *  is to re-read its ledger and re-dispatch, so it must be up before the fleet
 *  starts asking it for work — which is exactly what did NOT happen in the
 *  field incident this ticket comes from. */
async function resumeUsageLimited(now: number): Promise<void> {
  const candidates = store.workspaces
    .filter((ws) => !ws.archived && ws.lastStopReason === 'usage_limit')
    // Coordinators first (see above). Stable within each group otherwise.
    .sort((a, b) => Number(isCoordinatorWorkspace(b)) - Number(isCoordinatorWorkspace(a)));

  // Spread over TIME, not just order (review-74 R5). Coordinators-first only
  // orders resumes WITHIN one tick; without a cap, 20 workspaces sharing one
  // account all gate open on the same cache reading and are woken in the same
  // pass — which is the thundering herd #74 §3 set out to avoid, just arriving
  // in a fixed order. Capping resumes per tick spreads the fleet across
  // successive ticks (TICK_MS apart) instead; the remainder is not dropped,
  // it is simply reconsidered next tick, because a workspace keeps its
  // `usage_limit` marker until it is actually woken.
  let budget = MAX_RESUMES_PER_TICK;
  for (const ws of candidates) {
    if (budget <= 0) {
      log.info(
        `usage-limit auto-resume: ${candidates.length - MAX_RESUMES_PER_TICK} workspace(s) ` +
          `deferred to a later tick (cap ${MAX_RESUMES_PER_TICK}/tick)`,
      );
      break;
    }
    const usage = usageForWorkspace(ws);
    // The staggering gate for non-coordinators, and the ONLY evidence a
    // workspace with no known reset time has. Reuses `canAutoFlushQueue`'s
    // fetchedAt-after-block rule verbatim rather than reimplementing it:
    // a reading fetched BEFORE the limit hit predates the block and would
    // flush straight back into it. `lastStopReasonAt` is when the limit was
    // recorded, which is the "block" instant for this purpose.
    const blockedAt = ws.lastStopReasonAt ?? 0;
    const freshUsageSaysRecovered = canAutoFlushQueue(blockedAt, usage, now);

    const action = decideResume({
      lastStopReason: ws.lastStopReason,
      resetsAtMs: ws.usageLimitResetsAt ?? null,
      isCoordinator: isCoordinatorWorkspace(ws),
      queuedCount: (ws.queuedPrompts ?? []).length,
      freshUsageSaysRecovered,
      now,
    });

    if (action === 'wait') continue;
    // Consumed only by a real resume — a `wait` costs nothing, or a fleet of
    // not-yet-due workspaces would exhaust the budget and starve the ones that
    // ARE due (the cap would then delay resumes instead of spreading them).
    budget--;

    if (action === 'queue') {
      // Banner-queued prompts carry real user intent and WIN over the
      // synthesized nudge (#74). Deliberately NOT delivered here: the queue
      // loop below already owns that path, gated on the same usage evidence.
      // Clearing the pause marker is what hands it over — without this the
      // queue would flush AND this driver would keep re-deciding every tick.
      await clearStopReason(ws.id).catch(() => {});
      continue;
    }

    // action === 'nudge'. Clear the marker BEFORE waking so a wake slower than
    // one tick cannot be started twice — but RE-MARK on failure (review-74 R1).
    //
    // The clear-before-delivery ordering is borrowed from flushQueuedPrompts,
    // and the first version of this code borrowed only half of it. That path
    // pairs the early clear with a `requeue()` COMPENSATOR on every failure
    // exit; this one had none, which made the failure path the worst outcome in
    // the whole feature:
    //   wake returns false → marker already cleared → the workspace has left
    //   the `lastStopReason === 'usage_limit'` candidate filter above → NO
    //   later tick ever reconsiders it → the session is frozen FOREVER, and
    //   the ⏸ glyph is gone too, so nothing on screen tells a human to look.
    // That is strictly worse than never having shipped auto-resume.
    //
    // Reachable, not theoretical: `wakeAgentWithPrompt` returns false when
    // `!ws || ws.archived || isRunning(id)`, and `isRunning` is a plain
    // PTY-session check (`pty.ts`) — the candidate filter does NOT exclude a
    // workspace with a coexisting terminal PTY, which is precisely the
    // `driveStatus` configuration `markStoppedOnUsageLimit`'s own doc discusses.
    await clearStopReason(ws.id).catch(() => {});
    let woke = false;
    try {
      // GENERIC nudge — never the interrupted input. The killed turn may have
      // half-executed, so replaying it would re-run side effects (#57 family).
      woke = await wakeAgentWithPrompt(ws.id, RESUME_NUDGE_TEXT);
    } catch (e) {
      log.warn(`usage-limit auto-resume failed for ${ws.id}`, e);
    }
    if (woke) {
      log.info(
        `usage-limit auto-resume: nudged ${ws.id}` +
          `${isCoordinatorWorkspace(ws) ? ' (coordinator)' : ''}`,
      );
      continue;
    }
    // THE COMPENSATOR. Restore the pause marker so the workspace re-enters the
    // candidate filter and a later tick retries — and so the ⏸ glyph comes
    // back, which is the only thing that tells a human this session is stuck.
    // Re-marked with its ORIGINAL reset time: the limit did not move, and
    // fabricating a new one would push the retry further out each attempt.
    log.warn(`usage-limit auto-resume: could not wake ${ws.id} — re-marking so a later tick retries`);
    await markStoppedOnUsageLimit(ws.id, ws.usageLimitResetsAt ?? null).catch((e) =>
      log.warn(`usage-limit auto-resume: re-mark failed for ${ws.id}`, e),
    );
  }
}

async function tick(): Promise<void> {
  const now = Date.now();
  // Before the queue loop: a coordinator that is still marked limit-killed must
  // be back up before its fleet starts asking it for work.
  await resumeUsageLimited(now).catch((e) => log.warn('usage-limit resume tick failed', e));
  for (const ws of store.workspaces) {
    if (ws.archived) continue;
    const queue = ws.queuedPrompts ?? [];
    if (queue.length === 0) continue;
    const usage = usageForWorkspace(ws);
    const newestQueuedAt = Math.max(...queue.map((p) => p.queuedAt));
    if (canAutoFlushQueue(newestQueuedAt, usage, now)) {
      const res = await flushQueuedPrompts(ws.id).catch((e) => {
        log.warn(`prompt-queue auto-flush failed for ${ws.id}`, e);
        return null;
      });
      if (res?.ok && res.delivered > 0) {
        log.info(`prompt-queue: delivered ${res.delivered} queued prompt(s) to ${ws.id}`);
      }
      continue;
    }
    // Still limited (or the cached reading predates the queue): once the
    // blocked window's reset time has passed, nudge the per-account poller so
    // the cache proves the reset without waiting out its full 180s TTL. The
    // default login needs no nudge — its 60s poller refreshes on its own.
    if (usage?.data) {
      const until = usageLimitedUntil(usage.data, now);
      const nudged = lastNudge.get(ws.id) ?? 0;
      if (until !== null && now >= until && now - nudged >= REFRESH_NUDGE_MS) {
        lastNudge.set(ws.id, now);
        void refreshAccountsNow().catch(() => {});
      }
    }
  }
}

/** Start the queue flusher (idempotent). Ticks are pure cache reads unless a
 *  queue is actually waiting, so the steady-state cost is nil. */
export function startPromptQueueFlusher(): void {
  if (timer) return;
  timer = setInterval(() => void tick(), TICK_MS);
}

export function stopPromptQueueFlusher(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  lastNudge.clear();
}
