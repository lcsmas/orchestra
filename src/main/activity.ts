import fs from 'node:fs/promises';
import path from 'node:path';
import { platform } from './platform';
import { log } from './logger';
import { store } from './store';
import {
  getBranchMergeState,
  getCurrentBranch,
  getRefShas,
  getReleaseVersionsContaining,
} from './git';
import type { Workspace, WorkspaceStatus } from '../shared/types';

// Hook-driven activity tracker.
//
// Claude Code's lifecycle hooks (installed per-workspace in
// .claude/settings.local.json by workspaces.ts) append one JSON line per event
// to a durable per-workspace spool file; events-spool.ts tails it and calls
// `applyAgentEvent` here. (A legacy Unix-socket path still feeds
// `dispatchHookEvent` for any pre-upgrade session whose hooks were not yet
// rewritten — same handling, minus the per-tool detail.)
//
// State is a clean function of those events:
//   submit   → running
//   pretool  → running, with the active tool name surfaced to the renderer
//   posttool → running, tool cleared
//   stop     → waiting (chime + finished-toast)
//   notify   → waiting (chime + needs-input-toast) — Claude fires this when the
//              agent is prompting the user for an answer (permission prompts
//              and the 60s idle reminder).

/** Update a workspace's status. Returns the workspace plus whether this call
 *  was a real transition (`changed`) — callers that fire a one-shot side effect
 *  on entering a state (a chime, an OS notification) gate on `changed` so a
 *  redundant event (e.g. a `notify` right after a `stop`, both → `waiting`)
 *  doesn't re-fire it. Returns null only when the workspace is gone/archived. */
async function setStatus(
  id: string,
  status: WorkspaceStatus,
): Promise<{ ws: Workspace; changed: boolean } | null> {
  const ws = store.getWorkspace(id);
  if (!ws || ws.archived) return null;
  if (ws.status === status) return { ws, changed: false };
  const updated: Workspace = { ...ws, status };
  // Broadcast to the renderer first, then persist. upsertWorkspace mutates the
  // in-memory store synchronously (before its first await), so state is already
  // consistent here — but its disk flush is serialized through one write chain
  // (tmp-write + atomic rename of the whole store.json). The 8s stats poll
  // enqueues a save per workspace onto that same chain, so awaiting the flush
  // would make the status dot wait behind a batch of unrelated full-file
  // writes — the visible latency. The dot is ephemeral UI; it must not block on
  // durability, so fire the persist and let it flush in the background.
  void store.upsertWorkspace(updated).catch(() => {});
  platform.broadcast('workspace:update', updated);
  return { ws: updated, changed: true };
}

function fireFinished(id: string): void {
  // Focus is the OR of the Electron window and every attached ui-rpc client
  // (the seam guards a destroyed window internally — an isFocused throw here
  // used to abort the whole spool drain batch and strand the `stop`).
  const focused = platform.isFocused();
  void setStatus(id, 'waiting').then((res) => {
    if (!res) return;
    const { ws, changed } = res;
    // Ship the main-process focus state with the event. document.hasFocus()
    // is unreliable in the renderer (returns stale true on Wayland when the
    // window is hidden on another workspace / CDP is attached), so the
    // renderer trusts this flag instead.
    platform.broadcast('agent:finished', id, focused);
    // Re-evaluate "is this branch in sync with base after a merge, or has
    // it diverged again?" each time the agent's turn ends. Agents drive the
    // merge themselves via the Merge button's prompt, and may keep working
    // on the branch afterward — so the pill cycles on/off with each merge
    // and re-divergence rather than being a one-shot terminal state.
    void detectAndUpdateMergeState(id);
    // Only raise the OS notification on a real running→waiting transition. A
    // redundant terminal event that didn't move the status (already waiting)
    // must not pop a second toast. The seam posts the native Electron toast
    // (click-to-focus) and/or emits the `ui:notify` event for GTK clients.
    if (focused || !changed) return;
    platform.notify({
      wsId: id,
      kind: 'finished',
      title: 'Agent finished',
      body: `${ws.name} is ready for review`,
    });
  });
}

/** Flip a workspace to `waiting` because the agent is blocked on the user, and
 *  raise the "needs input" toast/chime if the window is unfocused. The terminal
 *  path reaches this via the Claude Code `Notification` hook → the events spool
 *  → `applyAgentEvent('notify')`. The structured (SDK) path has no spool signal
 *  for a parked question — its `canUseTool` bridge (agent-sdk.ts) emits a
 *  renderer-only `permission-request` event — so it calls this directly when it
 *  parks an interactive tool call. Exported for that caller. */
export function fireNeedsInput(id: string): void {
  const focused = platform.isFocused();
  void setStatus(id, 'waiting').then((res) => {
    if (!res) return;
    const { ws, changed } = res;
    platform.broadcast('agent:needs-input', id, focused);
    if (focused || !changed) return;
    platform.notify({
      wsId: id,
      kind: 'needsInput',
      title: 'Agent needs input',
      body: `${ws.name} is waiting for your answer`,
    });
  });
}

// Cache the (branchSha, baseSha, remoteSha) triple from each workspace's last
// full merge probe. The 8s stats poll calls this for every workspace, and
// getBranchMergeState spawns 2-9 git processes per call — the expensive reflog
// branch is precisely the idle steady state (branch tip == base, nothing
// ahead) that idle/fresh workspaces sit in. Merge state AND `unpushedAhead` are
// a pure function of these three SHAs, so when none has moved since the last
// probe the result cannot have changed: one cheap `rev-parse` (one process)
// short-circuits the whole computation. Any ref movement busts the cache and
// forces a recompute. The remote-tracking SHA (`origin/<branch>`) MUST be in
// the key: a `git push` moves only that ref — the branch tip and base tip stay
// put — so keying on just (branchSha, baseSha) would never notice the push and
// would pin a stale ↑N badge until the branch or base tip later moved.
const lastMergeProbe = new Map<
  string,
  { branchSha: string; baseSha: string; remoteSha: string | null }
>();

export async function detectAndUpdateMergeState(id: string): Promise<void> {
  const ws = store.getWorkspace(id);
  if (!ws || ws.archived || ws.kind === 'scratch') return;
  const heads = await getRefShas(ws.repoPath, ws.branch, ws.baseBranch);
  if (heads) {
    const prev = lastMergeProbe.get(id);
    if (
      prev &&
      prev.branchSha === heads.branchSha &&
      prev.baseSha === heads.baseSha &&
      prev.remoteSha === heads.remoteSha
    )
      return;
  }
  const { merged, diverged, unpushedAhead, stalePointer } = await getBranchMergeState(
    ws.repoPath,
    ws.branch,
    ws.baseBranch,
  );
  // Record the probed SHAs so the next poll can skip recomputation while the
  // refs hold still. Set even when the derived state is unchanged below.
  if (heads) lastMergeProbe.set(id, heads);
  // mergedAt is "timestamp of most recent merge" — set/refresh on every
  // merge cycle. `divergedFromBase` is what tells the renderer whether the
  // branch is currently in sync with that merge (pill visible) or has new
  // commits since (pill hidden, button enabled). Cleared only on
  // `stalePointer`, which signals the branch tip is just an old commit on
  // base's history with no real merge — clears false positives written by
  // the pre-fix detection.
  const fresh = store.getWorkspace(id);
  if (!fresh || fresh.archived) return;
  const nextMergedAt = merged ? Date.now() : stalePointer ? undefined : fresh.mergedAt;
  const nextDiverged = diverged;
  const nextUnpushed = unpushedAhead;
  const changed =
    nextMergedAt !== fresh.mergedAt ||
    Boolean(fresh.divergedFromBase) !== nextDiverged ||
    (fresh.unpushedAhead ?? 0) !== nextUnpushed;
  if (!changed) return;
  const updated: Workspace = {
    ...fresh,
    mergedAt: nextMergedAt,
    divergedFromBase: nextDiverged,
    unpushedAhead: nextUnpushed,
  };
  // Broadcast before persisting — see setStatus: the renderer must not wait on
  // the serialized store-write chain to reflect the merge pill / ↑N badge.
  void store.upsertWorkspace(updated).catch(() => {});
  platform.broadcast('workspace:update', updated);
}

/** Reconcile the stored branch name with what's actually checked out in the
 *  worktree. A branch renamed outside orchestra — `git branch -m` in a
 *  terminal, an editor's VCS UI, a teammate's script — leaves `ws.branch`
 *  stale, and that name is threaded into every downstream git call (merge
 *  state, PR lookup, the rename instruction's env), so a stale value quietly
 *  poisons all of them. We piggyback this on the hot 8s stats poll: one cheap
 *  `rev-parse` per workspace. When the live HEAD differs from the stored
 *  branch we adopt it, refresh the display name, and set `branchManuallySet` —
 *  an out-of-band rename is a deliberate choice, so the auto-rename
 *  instruction should stop firing. Detached HEAD (getCurrentBranch → '') is
 *  ignored: there's no branch to adopt and the worktree is mid-rebase/bisect. */
// Throttle the per-workspace out-of-band-rename probe. The stats poll calls
// this every 8s per workspace, but a `git branch -m` from a terminal is a rare,
// deliberate event — there's no value in spawning a `git rev-parse` per
// workspace 7-8 times a minute to catch it. Cap each workspace's probe to once
// per BRANCH_PROBE_MS; the rename is still adopted within a minute. With N
// workspaces this turns ~N·7.5 git spawns/min into ~N.
const BRANCH_PROBE_MS = 60_000;
const lastBranchProbe = new Map<string, number>();

/** Drop a workspace's cached probe state. Called when a workspace is deleted or
 *  archived: the renderer stops polling it, so its entries would otherwise
 *  linger as dead ids accumulating over a long session. */
export function forgetWorkspaceProbes(id: string): void {
  lastBranchProbe.delete(id);
  lastMergeProbe.delete(id);
  lastContext.delete(id);
}

export async function detectAndUpdateBranchName(id: string): Promise<void> {
  const ws = store.getWorkspace(id);
  if (!ws || ws.archived || ws.kind === 'scratch') return;
  const now = Date.now();
  const last = lastBranchProbe.get(id) ?? 0;
  if (now - last < BRANCH_PROBE_MS) return;
  lastBranchProbe.set(id, now);
  const live = await getCurrentBranch(ws.worktreePath);
  if (!live || live === ws.branch) return;
  // Re-read after the await — a concurrent orchestra-driven rename may have
  // already adopted the same name, in which case there's nothing left to do.
  const fresh = store.getWorkspace(id);
  if (!fresh || fresh.archived || fresh.branch === live) return;
  const repoName = path.basename(fresh.repoPath);
  const updated: Workspace = {
    ...fresh,
    branch: live,
    name: `${repoName} · ${live}`,
    branchManuallySet: true,
  };
  // Broadcast before persisting — see setStatus: don't gate the renamed-branch
  // UI on the serialized store-write chain.
  void store.upsertWorkspace(updated).catch(() => {});
  platform.broadcast('workspace:update', updated);
}

/** Detect the published GitHub Releases this branch's work shipped in and
 *  stamp `releasedAt` + `releasedVersions` (and `releasedVersion`, the
 *  earliest, for back-compat). An unmerged branch naturally yields no pills —
 *  its authored commits are in no release. The version list still tracks later
 *  ships and policy changes because `getReleaseVersionsContaining` recomputes
 *  whenever the branch tip or the release list moves — and serves a memoized
 *  result (one `rev-parse`) on every poll in between. `getPublishedReleases`
 *  is cached per-repo (30s) and shared across that repo's workspaces, so this
 *  stays at roughly one `gh` call per repo per TTL even on the PR poll
 *  cadence. Writes/broadcasts only when the version list actually changes.
 *  Deliberately NOT wired into `detectAndUpdateMergeState`, which runs on the
 *  hot 8s stats poll and must stay network-free. */
export async function detectAndUpdateReleaseState(id: string): Promise<void> {
  const ws = store.getWorkspace(id);
  if (!ws || ws.archived || ws.kind === 'scratch') return;
  // One pill for the release that FIRST shipped this branch's own work, plus
  // one per release this branch itself cut (it authored the version-bump tag
  // commit). getReleaseVersionsContaining derives the branch's authored commit
  // set (from its reflog, falling back to the base..branch range), so a fresh
  // branch cut from an old release commit it never authored gets nothing, a
  // merged/stale-pointer branch still gets exactly what it shipped, and a
  // stray follow-up commit riding along in another branch's release earns no
  // extra pill. An empty authored set already yields no versions.
  // getPublishedReleases is cached per-repo (30s), so this costs at most one
  // gh call per repo per TTL.
  const { versions, releasedAt } = await getReleaseVersionsContaining(
    ws.repoPath,
    ws.branch,
    ws.baseBranch,
  );
  const fresh = store.getWorkspace(id);
  if (!fresh || fresh.archived) return;
  const prev = fresh.releasedVersions ?? (fresh.releasedVersion ? [fresh.releasedVersion] : []);
  // No change → avoid a redundant write/broadcast. (Covers both staying empty
  // and staying identical.)
  if (prev.length === versions.length && prev.every((v, i) => v === versions[i])) return;
  if (versions.length === 0) {
    // The branch shipped nothing (or a prior over-eager computation left stale
    // pills): clear the release fields so the badges disappear.
    const cleared: Workspace = {
      ...fresh,
      releasedAt: undefined,
      releasedVersion: undefined,
      releasedVersions: undefined,
    };
    void store.upsertWorkspace(cleared).catch(() => {});
    platform.broadcast('workspace:update', cleared);
    return;
  }
  const updated: Workspace = {
    ...fresh,
    // Recompute releasedAt from the fresh result rather than preserving a stale
    // one — the version list itself just changed, so the "shipped when" anchor
    // should track it.
    releasedAt: releasedAt ?? fresh.releasedAt ?? Date.now(),
    releasedVersion: versions[0], // earliest = the "shipped when" signal
    releasedVersions: versions,
  };
  // Broadcast before persisting — see setStatus: don't gate the released-version
  // pill on the serialized store-write chain.
  void store.upsertWorkspace(updated).catch(() => {});
  platform.broadcast('workspace:update', updated);
}

/** Reconciliation floor for the status dot: the agent's process is gone, so it
 *  cannot possibly still be `running`. Called from the PTY exit handler. This
 *  is the durability backstop that makes a lost terminal event self-heal — even
 *  if a `stop`/`notify` line were never delivered, the dot can never outlive the
 *  process. We move to `waiting` (not `idle`) so the workspace still reads as
 *  "has unreviewed output, go look" and keeps its yellow dot until the user
 *  opens it; a clean idle is reserved for never-run / already-seen workspaces.
 *  A no-op when the workspace already left `running` via a real stop/notify. */
export function reconcileExited(id: string): void {
  const ws = store.getWorkspace(id);
  if (!ws || ws.archived) return;
  if (ws.status !== 'running') return;
  void setStatus(id, 'waiting');
}

/** Restore `running` after a parked interactive tool call is answered (the
 *  structured/SDK path's inverse of {@link fireNeedsInput}). The agent stopped
 *  to ask; once the user replies it resumes work, so the dot must go back to
 *  green. Guarded to only act on the `waiting` we set when parking — never
 *  resurrect a session that legitimately reached `idle`/`stopped`, and a
 *  redundant call when already `running` is a no-op (`setStatus` short-circuits
 *  on an unchanged status). No toast/chime on this direction. */
export function resumeRunning(id: string): void {
  const ws = store.getWorkspace(id);
  if (!ws || ws.archived) return;
  if (ws.status !== 'waiting') return;
  void setStatus(id, 'running');
}

/** Push the agent's currently-running tool (or null to clear) to the renderer.
 *  This is ephemeral UI state — it rides its own IPC channel rather than
 *  `Workspace.status`/the store so per-tool churn never writes store.json. */
function emitTool(id: string, tool: string | null): void {
  platform.broadcast('agent:tool', id, tool);
}

// Cap how much of a transcript we read. The context figure lives on the LAST
// assistant turn, which is at the file's tail, so we read the trailing slice
// rather than the whole JSONL — a long session's transcript is multi-MB and
// re-reading it on every posttool would be wasteful. 512 KiB comfortably holds
// the final few turns even when one carries a large tool result.
const TRANSCRIPT_TAIL_BYTES = 512 * 1024;

/** The size of a Claude Code session's context window, in tokens, derived from
 *  its transcript. This is the figure the TUI's `/context` view shows as
 *  "used": on the most recent MAIN-CHAIN assistant message (sub-agent /
 *  sidechain turns don't count toward the parent's context), the sum of the
 *  three input components — fresh input, cache writes, and cache reads. Output
 *  tokens are excluded: they're what the model produced, not what's fed back in.
 *  Returns 0 when the newest relevant entry is a compaction boundary: the
 *  pre-compact assistant usage behind it is stale (compaction just shrank the
 *  live context), and the true post-compact size is unknown until the next
 *  assistant turn — 0 tells the caller "reset the badge" rather than
 *  resurfacing the pre-compact figure.
 *  Returns null when the transcript is missing/unreadable or has no usable
 *  assistant turn yet (e.g. the very first event of a brand-new session). */
async function computeContextTokens(transcriptPath: string): Promise<number | null> {
  let text: string;
  try {
    const handle = await fs.open(transcriptPath, 'r');
    try {
      const { size } = await handle.stat();
      const start = Math.max(0, size - TRANSCRIPT_TAIL_BYTES);
      const len = size - start;
      const buf = Buffer.alloc(len);
      await handle.read(buf, 0, len, start);
      text = buf.toString('utf8');
    } finally {
      await handle.close();
    }
  } catch {
    return null; // transcript not created yet, removed, or unreadable
  }
  // Walk lines newest-first; the first main-chain assistant turn we hit carries
  // the live context size. Reading from the tail means we stop almost
  // immediately. A leading partial line (we sliced mid-file) just fails to
  // parse and is skipped.
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const trimmed = lines[i].trim();
    if (!trimmed) continue;
    let entry: {
      type?: unknown;
      subtype?: unknown;
      isSidechain?: unknown;
      message?: { usage?: Record<string, unknown> };
    };
    try {
      entry = JSON.parse(trimmed);
    } catch {
      continue;
    }
    // A compaction boundary newer than any assistant turn means the context
    // was just rewritten: everything behind it is pre-compact and stale.
    if (entry.type === 'system' && entry.subtype === 'compact_boundary') return 0;
    if (entry.type !== 'assistant' || entry.isSidechain === true) continue;
    const usage = entry.message?.usage;
    if (!usage) continue;
    const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
    const tokens =
      num(usage.input_tokens) +
      num(usage.cache_creation_input_tokens) +
      num(usage.cache_read_input_tokens);
    return tokens > 0 ? tokens : null;
  }
  return null;
}

// The last context size pushed per workspace, so a recompute that lands on the
// same number (common on a posttool that didn't move the model) doesn't spam a
// redundant IPC message. Cleared lazily — a stale entry only costs one skipped
// no-op send.
const lastContext = new Map<string, number>();

/** Recompute a workspace's context size from its transcript and push it to the
 *  renderer if it changed. Like {@link emitTool}, the live figure is ephemeral UI
 *  state on its own IPC channel — so per-turn growth (every posttool) never
 *  writes store.json. The exception is `persist: true`, passed only at turn-end
 *  (`stop`/`notify`), which also stamps `Workspace.contextTokens` so the badge
 *  can be seeded at startup before any live event fires. That write is free: the
 *  turn-end status→`waiting` transition already saves the store, so we fold the
 *  token number into that same record rather than adding a write. No-ops when the
 *  hook carried no transcript path (legacy sessions). */
async function emitContext(
  id: string,
  transcriptPath: string | undefined,
  persist = false,
): Promise<void> {
  if (!transcriptPath) return;
  let tokens: number | null;
  try {
    tokens = await computeContextTokens(transcriptPath);
  } catch (e) {
    log.error(`activity: computeContextTokens failed for ${id}`, e);
    return;
  }
  if (tokens == null) return;
  // Persist the turn-end figure onto the workspace record so the sidebar badge
  // survives a restart. Only when it actually changed from what's stored, to keep
  // this a no-op when the cached value already matches (and so a `notify` right
  // after a `stop`, both turn-ends, doesn't double-write). `upsertWorkspace`
  // already runs on the status transition; this just carries one more field.
  // 0 is the "context reset by compaction" signal — drop the persisted figure
  // rather than storing a literal zero, so the startup seed shows no badge.
  if (persist) {
    const ws = store.getWorkspace(id);
    const persisted = tokens > 0 ? tokens : undefined;
    if (ws && !ws.archived && ws.contextTokens !== persisted) {
      void store.upsertWorkspace({ ...ws, contextTokens: persisted }).catch(() => {});
    }
  }
  if (lastContext.get(id) === tokens) return;
  lastContext.set(id, tokens);
  platform.broadcast('agent:context', id, tokens);
}

/** Force-clear a workspace's context badge without consulting the transcript.
 *  Used at SessionStart when the hook's `source` says the context was just
 *  discarded (`clear`) or rewritten (`compact`): the true new size is unknown
 *  until the next assistant turn, and for `clear` the fresh transcript may not
 *  even exist yet — so a recompute can't be trusted to notice the reset. Sends
 *  the 0 sentinel (renderer drops the badge) and drops the persisted figure. */
function resetContext(id: string): void {
  const ws = store.getWorkspace(id);
  if (ws && !ws.archived && ws.contextTokens != null) {
    void store.upsertWorkspace({ ...ws, contextTokens: undefined }).catch(() => {});
  }
  if (lastContext.get(id) === 0) return;
  lastContext.set(id, 0);
  platform.broadcast('agent:context', id, 0);
}

/** Apply one lifecycle event to a workspace's status. Fed by the durable spool
 *  tailer (with the per-tool `tool` for pretool/posttool) and, for legacy
 *  sessions, by the Unix-socket route via `dispatchHookEvent`. `setStatus`
 *  only writes the store on a real transition, so the idempotent `running`
 *  re-assertions on every pretool are free. */
export function applyAgentEvent(
  id: string,
  event: string,
  tool: string | undefined,
  transcript?: string,
): void {
  switch (event) {
    case 'submit':
      emitTool(id, null);
      void setStatus(id, 'running');
      break;
    case 'pretool':
      emitTool(id, tool ?? null);
      void setStatus(id, 'running');
      break;
    case 'posttool':
      // Stay running between tools; just clear the active-tool label. Refresh
      // the context-size badge here so it climbs live through a long turn, not
      // only at turn-end.
      emitTool(id, null);
      void emitContext(id, transcript);
      break;
    case 'stop':
    // Claude's `StopFailure` hook (turn ended on an API error) maps here too:
    // an error-terminated turn is still a turn-end, so the dot must leave
    // `running`. Without this the dot stuck on `running` after every rate-limit
    // / overload turn-end.
    case 'stopfail':
      emitTool(id, null);
      // Turn-end: persist the figure (piggybacks the status write fireFinished
      // is about to make) so the badge can be restored at next startup.
      void emitContext(id, transcript, true);
      fireFinished(id);
      break;
    case 'notify':
      emitTool(id, null);
      void emitContext(id, transcript, true);
      fireNeedsInput(id);
      break;
    case 'session':
      // SessionStart. The `tool` slot carries the hook payload's `source`
      // (startup | resume | clear | compact). clear/compact just invalidated
      // the persisted context figure — without this the badge kept showing the
      // pre-compact size (e.g. 288k) while the TUI statusline showed ~0% until
      // the next turn ended. startup/resume instead refresh the badge from the
      // (existing) transcript, which still carries a valid last-turn figure.
      if (tool === 'clear' || tool === 'compact') {
        resetContext(id);
      } else {
        void emitContext(id, transcript, true);
      }
      break;
  }
}

/** Legacy Unix-socket entry point (hooks-server `/event` route). Pre-upgrade
 *  workspaces still POST bare `{id, event}` here until their hooks are
 *  rewritten on the next pty:start; they carry no per-tool detail. */
export function dispatchHookEvent(id: string, event: string): void {
  applyAgentEvent(id, event, undefined);
}
