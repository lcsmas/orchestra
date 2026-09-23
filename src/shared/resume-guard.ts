// Resume-guard policy (issues #178 / #179) — pure decision functions, no
// Electron, no fs, so they are unit- and mutation-testable without a running
// app. The effectful callers (agent-sdk.ts, workspaces.ts, restart-mode.ts)
// inject a transcript-existence PROBE and act on the verdict.
//
// ── The guarantee-breaking hole this closes (field incident 2026-09-21) ──────
//
// A session that NEVER emitted a first stream message (boot-wedged in CLI init,
// `firstMessageSeen === false`) can still carry a `sdkSessionId` on its
// workspace record — MINTED by an earlier partial session or by `sdkWake`
// adoption, NOT by the wedged session itself (a boot wedge emits no
// `system/init`, so consume() never reaches its `persistSessionId` — verified
// at agent-sdk.ts:1176/1185 and docs/research/issue-176-init-hang.md §2). When
// that id has NO transcript `.jsonl` on disk, every restart entry point that
// resumes it dead-ends on the CLI/SDK error `No conversation found with session
// ID: <id>` (structured, 15:34:05) or `No conversation found to continue`
// (terminal `--continue`, 15:35:08), and the workspace becomes unrecoverable.
//
// The reactive heal (`isBadResumeError`, agent-sdk.ts:1323/2432) only clears the
// phantom id AFTER the resume already failed and the consume loop errored — the
// field failure. This module is the PROACTIVE discriminator: at the moment a
// resume is about to be attempted, prove the id is resumable (its transcript
// exists) BEFORE handing it to `query({resume})` / `claude --continue`.
//
// ── The discriminator: transcript-exists, not firstMessageSeen ───────────────
//
// The sound test is "does the on-disk transcript `.jsonl` for this id exist",
// NOT the live-session `firstMessageSeen` flag — because these functions run at
// ensureSession/startAgentPty time where there is NO live session to read a flag
// from. This is the EXACT discriminator `sdkWake` already uses to gate adopting
// an id (agent-sdk.ts:2830-2833: `fs.existsSync(<dir>/<sessionId>.jsonl)`), so
// the resume path and the adoption path now agree on one definition of
// "resumable".

/** The sdkClear marker: an explicit "conversation cleared, start fresh" signal
 *  persisted as `sdkSessionId: ''`. It is NOT a phantom — it is a deliberate
 *  fresh-start request, and it already resolves to "no resume" via the
 *  truthiness gate at the call site. Named here so the pure logic can be read
 *  without re-deriving the convention. */
export const SDK_CLEARED_MARKER = '';

/** Decide the resume id to hand `query({ resume })` for a structured
 *  (SDK) session — issue #178 seam (a).
 *
 *  `sdkSessionId` is the persisted id (or undefined / the `''` cleared marker).
 *  `transcriptExists(id)` reports whether the on-disk transcript `.jsonl` for a
 *  given id exists (the caller supplies the fs probe, scoped to the workspace's
 *  account config dir + worktree — same resolution `transcriptDir` uses).
 *
 *  Returns the id to resume, or `undefined` to start FRESH. Fresh whenever:
 *   - there is no id (`undefined`) — never a structured session before;
 *   - the id is the `''` cleared marker — an explicit fresh-start request;
 *   - the id has NO transcript on disk — a PHANTOM id (the #178 field failure);
 *     resuming it would dead-end on "No conversation found".
 *
 *  A real id WITH a transcript resumes exactly as before (the must-PASS arm).
 *
 *  Note the deliberate asymmetry from `classifyRestartMode`: THAT decides which
 *  SURFACE owns the workspace (a phantom id still means "structured surface");
 *  THIS decides whether the resume is SAFE. A phantom-id structured workspace is
 *  still restarted structured — it just starts fresh instead of resuming a
 *  corpse. */
export function resolveResumeId(
  sdkSessionId: string | undefined,
  transcriptExists: (id: string) => boolean,
): string | undefined {
  if (!sdkSessionId) return undefined; // undefined OR '' (cleared) → fresh
  if (!transcriptExists(sdkSessionId)) return undefined; // phantom id → fresh
  return sdkSessionId;
}

/** Decide whether a terminal (PTY) launch should pass `claude --continue` —
 *  issue #178 seam (b). SEPARATE discriminator from the structured seam: the
 *  terminal path keys on `hasInput` (the user submitted at least one prompt to
 *  the TUI), NOT on `sdkSessionId`, and `--continue` resumes the NEWEST
 *  transcript for the worktree rather than a named id.
 *
 *   - `hasInput` false → nothing was ever typed → fresh launch (unchanged).
 *   - `fresh` true → an explicit `--fresh` request → fresh launch (unchanged).
 *   - `hasInput` true but NO newest transcript on disk → a PHANTOM terminal
 *     workspace (the 15:35:08 exit-1): `--continue` would find no conversation.
 *     Start fresh instead of dead-ending.
 *   - `hasInput` true AND a newest transcript exists → `--continue` (unchanged).
 *
 *  `newestTranscriptExists` is the caller's fs probe: does ANY transcript
 *  `.jsonl` exist in the workspace's transcript dir (what `--continue` reads)? */
export function shouldContinuePty(input: {
  hasInput: boolean | undefined;
  fresh: boolean;
  newestTranscriptExists: boolean;
}): boolean {
  if (input.hasInput !== true) return false;
  if (input.fresh) return false;
  return input.newestTranscriptExists;
}

/** How a structured restart's mid-turn guard should treat the live session —
 *  issue #179 defect 1.
 *
 *  The old guard refused ANY restart while `turnGate !== null` ("The agent is
 *  working — interrupt it first, then restart."). But a BOOT-wedged session
 *  holds its OPENING turn's gate forever having never emitted a single stream
 *  message (`firstMessageSeen === false`): the generator armed the gate and
 *  yielded the opening prompt to a CLI stuck in init, so `turnGate !== null` is
 *  true yet nothing is meaningfully "working". The field loop
 *  (2026-09-21 15:28-15:33) was exactly this — promote/reparent restart refused
 *  every ~27s forever while the keeper reported `everStarted:false`.
 *
 *  Four verdicts:
 *   - `'refuse'`  — a turn is in flight AND the session has started
 *     (`firstMessageSeen === true`) with recent stream activity: a genuine
 *     working turn; refusing protects it (the must-PASS arm).
 *   - `'fresh'`   — a turn is in flight but the session NEVER started
 *     (`firstMessageSeen === false`): a never-started opening turn is
 *     interruptible; tear it down and start FRESH, redelivering the opening
 *     prompt (per #178). This converges the #179 loop.
 *   - `'stalled'` — a started turn silent for {@link RESTART_STALL_MS}+: an
 *     explicit restart of a session showing no activity (2026-09-23 bloc2: CLI
 *     hung after `system/init`, pane idle with no Stop, restart refused). Tear
 *     down, keep the conversation, redeliver pending prompts.
 *   - `'resume'`  — no turn in flight (or no live session): the ordinary
 *     conversation-preserving restart, unchanged.
 *
 *  `firstMessageSeen` is read from the LIVE session (agent-sdk.ts consume() sets
 *  it true on the first stream message) — the same proof-of-life the boot-wedge
 *  watchdog keys on (session-wedge.ts `decideBootWedge`), so the restart guard
 *  and the watchdog share ONE definition of "never started". */
export type RestartGuardVerdict = 'refuse' | 'fresh' | 'stalled' | 'resume';

/** Silence after which an EXPLICIT restart may tear down a started turn
 *  (`'stalled'`). Keyed on `session.lastStreamAt` (bumped at turn arm AND by
 *  every stream message), so a turn that just started is never "stalled". */
export const RESTART_STALL_MS = 2 * 60 * 1000;

export function decideRestartGuard(input: {
  /** A live in-memory session exists for this workspace. */
  hasLiveSession: boolean;
  /** A turn is in flight (`session.turnGate !== null`). */
  turnInFlight: boolean;
  /** The live session has emitted at least one stream message
   *  (`session.firstMessageSeen`). Meaningless when `hasLiveSession` is false. */
  firstMessageSeen: boolean;
  /** Ms since the session's last stream activity (`now - session.lastStreamAt`).
   *  Absent ⇒ unknown ⇒ a started turn is refused (the pre-'stalled' behaviour). */
  silentForMs?: number;
  /** Injectable {@link RESTART_STALL_MS} for tests. */
  stallMs?: number;
}): RestartGuardVerdict {
  if (!input.hasLiveSession) return 'resume';
  if (!input.turnInFlight) return 'resume';
  // A turn is in flight. A never-started opening turn is interruptible and
  // starts fresh (#179/#178).
  if (!input.firstMessageSeen) return 'fresh';
  // Started: refuse unless the stream has been silent past the stall bound.
  const stallMs = input.stallMs ?? RESTART_STALL_MS;
  if (input.silentForMs !== undefined && input.silentForMs >= stallMs) return 'stalled';
  return 'refuse';
}
