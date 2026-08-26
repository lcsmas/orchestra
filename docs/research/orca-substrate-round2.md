# orca substrate, round 2 — wake mechanism, preamble verbatim, schema SQL, federation ordering

Resolves the NOT VERIFIED gaps of the round-1 deep-research (recorded in map
[#104](https://github.com/lcsmas/orchestra/issues/104)'s first comment). Research
ticket: [#106](https://github.com/lcsmas/orchestra/issues/106).

Read 2026-08-26 via `gh api` (contents + code search) against
**stablyai/orca `main` @ `1fafccb26bf8f1151cfea3f5ca915abb848d8741`**. All
paths below are orca paths at that sha; re-verify before relying on line-level
claims — this is a fast-moving repo.

## Attribution / license

orca is **MIT — `Copyright (c) 2026 Lovecast Inc.`** (`LICENSE` at repo root).
The notice condition: *"The above copyright notice and this permission notice
shall be included in all copies or substantial portions of the Software."*
So: lifting any of the code below (schema SQL, preamble text, waiter pattern)
into Orchestra is allowed, but the lifted file must carry the MIT notice with
the Lovecast Inc. copyright line and a pointer to the source path + sha.
Source paths quoted per section.

---

## 1. `check --wait` wake mechanism: PUSH (in-process promise waiters), not poll

**Verdict: push.** The blocking lives in the runtime (Electron main) as an
in-memory promise waiter registered per mailbox handle; the send path resolves
it directly. Nothing polls the SQLite DB while waiting; the only timers are the
wait's own timeout and a cosmetic CLI stderr keepalive.

The chain, with evidence:

1. **CLI side is a single awaited RPC** —
   `src/cli/handlers/orchestration/message-check-handler.ts`: the handler
   makes one `client.call('orchestration.check', { …, wait: true, timeoutMs })`
   and awaits it. The only loop on the CLI side is
   `src/cli/handlers/orchestration/check-keepalive.ts`, a 15 s `setInterval`
   that writes `{"_keepalive":true,"_heartbeat":true,elapsedMs,deadlineMs}` to
   **stderr** — liveness cosmetics for harnesses watching the process, not a
   wake mechanism ("Why: test-only escape hatch so subprocess tests avoid the
   full 15 s window" for the env override).

2. **Runtime registers a waiter, no DB re-read until woken** —
   `src/main/runtime/rpc/methods/orchestration.ts`, direct-mailbox check
   handler:

   ```ts
   const result = readAndReturn()
   if (result.count > 0 || !params.wait) {
     return result
   }
   // Why: signal aborts this waiter when the client socket closes, freeing the
   // long-poll slot immediately rather than after timeoutMs (design doc §3.1).
   const waitResult = await runtime.waitForMessage(handle, {
     typeFilter: typeFilter as string[] | undefined,
     timeoutMs: params.timeoutMs ?? undefined,
     signal
   })
   ...
   return readAndReturn()
   ```

   Pattern: read once → if empty, park on `waitForMessage` → on wake, re-read.
   (Run-scoped and dispatch-scoped variants at ~lines 1050 and 1276 of the same
   file follow the same shape, with `exclusive: true` for the run coordinator —
   a second concurrent waiter gets `'waiter_exists'`.)

3. **`waitForMessage` is a Promise + Set, resolved by the send path** —
   `src/main/runtime/orca-runtime.ts` (~line 35456):

   ```ts
   waitForMessage(handle, options?): Promise<MessageWaitResult> {
     return new Promise((resolve) => {
       ...
       const waiter: MessageWaiter = { handle, typeFilter, resolve, timeout: null, abortCleanup: null }
       ...
       waiter.timeout = setTimeout(() => { this.removeMessageWaiter(waiter); resolve('timed_out') }, timeoutMs)
       let waiters = this.messageWaitersByHandle.get(handle)
       if (!waiters) { waiters = new Set(); this.messageWaitersByHandle.set(handle, waiters) }
       waiters.add(waiter)
     })
   }
   ```

   Registered in `messageWaitersByHandle = new Map<string, Set<MessageWaiter>>()`
   (~line 3263). The only ways out: `resolve('notified')` via the send path,
   `'timed_out'` via the setTimeout, `'cancelled'` via AbortSignal (client
   socket closed) or `cancelMessageWaiters`, `'waiter_exists'` for exclusive
   collisions.

4. **Send resolves the waiter synchronously with the insert** — the
   `orchestration.send` RPC handler calls
   `runtime.notifyMessageArrived(msg.to_handle, msg.type)` right after the DB
   insert (`src/main/runtime/rpc/methods/orchestration.ts` lines ~773–893, one
   call per recipient). The runtime side (~line 35448):

   ```ts
   // Why: wake blocking orchestration.check --wait calls on this handle so they
   // return the new message immediately instead of polling.
   notifyMessageArrived(handle: string, messageType?: string): void {
   ```

   which delegates to
   `src/main/runtime/orchestration/mailbox-notification-coordinator.ts` →
   `notifyMessageArrived()` filters the handle's waiters by `typeFilter` and
   calls `resolveMessageWaiter(waiter)` for each match. If **no** waiter
   matches, it falls back to the PTY pointer-injection path
   (`queueMicrotask(() => this.deps.deliverForHandle(mailboxHandle, reservedTypes))`
   — "Let a check awakened in this drain mark its rows read before the push
   re-reads them"), i.e. an idle agent with no parked check gets the mail
   pushed into its terminal as a pointer instead
   (`mailbox-pointer-delivery.ts`, gated on
   `leaf.lastAgentStatus === 'idle' && leaf.lastAgentStatusObservedLive`).

**Adoption note for Orchestra:** this only works because coordinator, workers'
mailboxes, and the DB all live in one long-lived process (Electron main = the
runtime; CLI is a thin RPC client over a socket). That is structurally the same
as our main-process + `orchestra` CLI + local socket topology, so the same
"park a promise in main, resolve on insert" design is directly liftable —
it is what would replace pull-based `orchestra check` polling loops.

## 2. Injected preamble, verbatim

Source: `src/main/runtime/orchestration/preamble.ts` (201 lines, captured in
full below — this is the entire file at sha `1fafccb`; the template proper is
`buildDispatchPreamble`). Snapshot-tested in
`__snapshots__/preamble.test.ts.snap`.

Noteworthy vs. round-1 summary: the behavioural rules are deliberately placed
as comments **inside the CLI examples** ("LLM readers anchor on examples and
skim trailing prose, so rules must land at the point of use"); the
post-`worker_done` section differs for `prompt-returning-agent` vs `bare-shell`
workers; a direct user instruction explicitly overrides the idle rule.

```ts
import type { OrchestrationCliCommand } from './cli-command'

export type PreambleParams = {
  taskId: string
  // Why: completion and heartbeat payloads attribute activity to a specific
  // dispatch context (not just a task). A retried task has multiple
  // dispatch_contexts rows; keying worker_done/heartbeat on dispatchId
  // prevents stale messages from a previously-failed dispatch from completing
  // or refreshing the retry.
  dispatchId: string
  dispatchCapability?: string
  taskSpec: string
  coordinatorHandle: string
  workerHandle: string
  devMode?: boolean
  // Why: packaged WSL panes install the scoped launcher as `orca-ide`;
  // other execution hosts keep their existing bare `orca` bridge.
  cliCommand?: OrchestrationCliCommand
  // Why: populated by the coordinator's dispatch pre-flight (§3.1) only
  // when the target worktree is behind its tracking remote. When absent
  // or when `behind === 0`, the preamble emits no drift section. Callers
  // must NOT pre-populate this with empty data; the drift section is a
  // loud-but-rare signal tied to the `allow-stale-base: true` override
  // path, and polluting it for fresh worktrees would train workers to
  // ignore it.
  baseDrift?: {
    base: string
    behind: number
    recentSubjects: string[]
  }
  // Why: prompt-returning agents should idle after worker_done, while bare
  // shells have no agent prompt for Orca to reuse.
  workerKind?: 'prompt-returning-agent' | 'bare-shell'
}

// Why: 5 minutes is frequent enough that the coordinator's stale-heartbeat
// check (threshold 10 min) catches a hung worker within one tick, and
// infrequent enough to avoid inbox spam on long tasks. One constant so
// cadence tuning is a single-line change (Q1 in DESIGN_DOC_PREAMBLE_FIX.md).
const HEARTBEAT_INTERVAL_MIN = 5

// Why: the dispatch preamble teaches agents about Orca's CLI commands for
// structured communication. Behavioral rules (body summary, heartbeat cadence,
// no-AskUserQuestion) live as inline comments above the relevant CLI example,
// not as a separate prose block — LLM readers anchor on examples and skim
// trailing prose, so rules must land at the point of use.
export function buildDispatchPreamble(params: PreambleParams): string {
  // Why: in dev mode, agents must use orca-dev to connect to the dev runtime's
  // socket. Without this, agents inside the dev Electron app would call the
  // production CLI and talk to the wrong Orca instance (Section 6.4).
  const cli = params.devMode ? 'orca-dev' : (params.cliCommand ?? 'orca')
  const postDoneInstructions = buildPostWorkerDoneInstructions({
    cli,
    workerKind: params.workerKind ?? 'prompt-returning-agent'
  })
  const capabilityFlag = params.dispatchCapability
    ? ` --dispatch-capability ${params.dispatchCapability}`
    : ''

  const header = `You are working inside Orca, a multi-agent IDE. You are a dispatched worker.
Your coordinator's terminal handle is: ${params.coordinatorHandle}
Your task ID is: ${params.taskId}

You talk to the coordinator only through the CLI commands below. Do not use
Slack, GitHub comments, or any other channel to reach a human during the run.

=== CLI COMMANDS ===

  # Report the terminal task outcome (REQUIRED exactly once).
  #
  # RULE: --body must be a 3-sentence executive summary (what you did,
  # what you found, what's left). Never send an empty body; the coordinator
  # reads the body first and only opens artifacts if it needs more detail.
  # If you produced a long-form artifact, include its path as
  # payload.reportPath so the coordinator can find it without a file search.
  #
  # RULE: send worker_done exactly once. Use --outcome succeeded when the
  # requested work is done, or replace it with --outcome failed when it is not.
  # Never encode failure only in prose and never silently exit.
  # Include BOTH taskId and dispatchId in the payload so a late completion
  # from a failed retry cannot complete the current dispatch.
  ${cli} orchestration send --from ${params.workerHandle}${capabilityFlag} \\
    --type worker_done --subject "<short status>" \\
    --body "<3-sentence summary: what you did, what you found, what's left>" \\
    --task-id ${params.taskId} --dispatch-id ${params.dispatchId} --outcome succeeded \\
    --files-modified "path/a,path/b" \\
    --report-path "<optional: path to the full artifact>"

  # BEHAVIOR RULE: send a heartbeat every ${HEARTBEAT_INTERVAL_MIN} minutes
  # while actively working on the task. The coordinator uses this to
  # distinguish "still thinking" from "hung / crashed." Skip heartbeats only
  # while blocked inside \`check --wait\` or \`ask\` — those calls are
  # themselves liveness signals.
  #
  # Include BOTH taskId and dispatchId in the payload: the coordinator
  # attributes the heartbeat to the specific dispatch context, not just
  # the task, so a straggler heartbeat from a previously-failed dispatch
  # cannot mask a hung retry.
  ${cli} orchestration send --from ${params.workerHandle}${capabilityFlag} \\
    --type heartbeat --subject "alive" \\
    --task-id ${params.taskId} --dispatch-id ${params.dispatchId} \\
    --phase "<short: investigating|implementing|reviewing|waiting>"

  # Ask the coordinator a question and block until it answers.
  #
  # BEHAVIOR RULE #1 (MUST NOT VIOLATE):
  # NEVER use AskUserQuestion; use \`${cli} orchestration ask\`.
  # AskUserQuestion opens a local TUI prompt that the
  # coordinator cannot see and cannot answer — your session will hang forever
  # waiting on a human. Every interactive question goes through \`ask\` below.
  #
  # The \`ask\` verb durably records a question in this Dispatch's Run and
  # blocks until the coordinator replies, then prints the reply body. If the
  # call times out or disconnects, resume with the returned message ID instead
  # of creating a duplicate question.
  ${cli} orchestration ask --from ${params.workerHandle}${capabilityFlag} \\
    --question "<your question>" \\
    --options "<optional,comma,separated>" \\
    --timeout-ms 600000

  # Escalate a blocker or failure (pre-completion, when you need the
  # coordinator to do something before you can continue):
  ${cli} orchestration send --from ${params.workerHandle}${capabilityFlag} \\
    --type escalation --subject "Blocked: <reason>" \\
    --body "<details>" \\
    --task-id ${params.taskId} --dispatch-id ${params.dispatchId}

  # Check for messages from the coordinator:
  ${cli} orchestration check --terminal ${params.workerHandle}

${postDoneInstructions}`

  // Why: the drift section fires only when the coordinator allowed dispatch
  // against a stale worktree (via `allow-stale-base: true` in the task spec,
  // see §3.4) OR when behind>0 but under the refusal threshold. Either way
  // it is defense-in-depth: the worker sees the drift from line 1 instead
  // of discovering it via stale line numbers in artifacts later.
  const drift =
    params.baseDrift && params.baseDrift.behind > 0 ? buildDriftSection(params.baseDrift) : ''

  return `${header}${drift}

=== TASK ===
${params.taskSpec}`
}

function buildPostWorkerDoneInstructions({
  cli,
  workerKind
}: {
  cli: string
  workerKind: NonNullable<PreambleParams['workerKind']>
}): string {
  // Why: re-dispatch reaches idle agents as terminal input; inbox polling
  // after completion cannot receive that new TASK block and looks hung.
  if (workerKind === 'bare-shell') {
    return `=== AFTER YOU SEND worker_done ===

worker_done ends your turn for this task. Your dispatched work is complete:
stop and take no further actions — do NOT start new or unrelated work,
do NOT run a sleep/poll loop, and do NOT keep calling
\`${cli} orchestration check\`. The coordinator has already recorded your
completion and expects no further output.

Exit the shell after completion. Bare-shell workers have no idle agent
prompt for Orca to reuse; if the coordinator has more for you it will
dispatch or prompt another worker with a fresh TASK block.`
  }

  return `=== AFTER YOU SEND worker_done ===

worker_done ends your turn for this task. Your dispatched work is complete:
stop, return to an idle prompt, and take no further actions — do NOT start
new or unrelated work, do NOT run a sleep/poll loop, and do NOT keep calling
\`${cli} orchestration check\`. The coordinator has already recorded your
completion and expects no further output.

A direct instruction from the user takes precedence over this idle rule.
Treat it as new user-owned work: follow it without coordinator approval or a
fresh Dispatch, and do not send lifecycle messages using the settled task or
Dispatch IDs. Never refuse a direct user request because you were a worker.

Do not exit the shell. Your terminal stays available, and if the
coordinator has more for you it will re-engage this terminal with a fresh
preamble + TASK block, which arrives as new input. Treat that as supervised
work under the new Dispatch; ignore stale follow-ups from the settled task.`
}

function buildDriftSection(drift: NonNullable<PreambleParams['baseDrift']>): string {
  const subjects = drift.recentSubjects.map((s) => `  - ${s}`).join('\n')
  return `

--- BASE DRIFT ---
Your worktree HEAD is ${drift.behind} commits behind ${drift.base}. The 5 most recent
subjects on ${drift.base} NOT in your worktree:
${subjects}

If any look relevant to your task, either pull them in (\`git pull --rebase
${drift.base}\` or equivalent) or escalate to the coordinator before starting.
---`
}
```

## 3. CREATE TABLE SQL, verbatim

Both files return a template string; interpolated TS constants come from
`db/schema/../contract-constants.ts` (`LEGACY_RUN_ID`, `CURRENT_CONTRACT_VERSION`)
and `db/pane-key-match.ts` (two SQL expression fragments for suffix-matching
pane keys) — those interpolations are left as `${...}` below, exactly as in
source. Migrations live separately (`migrate-v2-v12.ts`, `migrate-v13-v29.ts` —
schema was at v29+ at this sha).

### 3a. `src/main/runtime/orchestration/db/schema/create-core-tables-sql.ts`

```sql
CREATE TABLE IF NOT EXISTS runs (
  id                    TEXT PRIMARY KEY,
  objective             TEXT NOT NULL,
  home_database         TEXT NOT NULL DEFAULT 'this_database',
  coordinator_handle    TEXT,
  coordinator_pane_key  TEXT,
  consumer_generation   INTEGER NOT NULL DEFAULT 0,
  legacy                INTEGER NOT NULL DEFAULT 0,
  created_at            TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at            TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS messages (
  id            TEXT NOT NULL,
  run_id        TEXT NOT NULL DEFAULT '${LEGACY_RUN_ID}',
  delivery_contract TEXT NOT NULL DEFAULT 'current_delivery'
    CHECK(delivery_contract IN ('legacy_direct', 'current_delivery', 'audit_only')),
  from_handle   TEXT NOT NULL,
  to_handle     TEXT NOT NULL,
  subject       TEXT NOT NULL,
  body          TEXT NOT NULL DEFAULT '',
  type          TEXT NOT NULL DEFAULT 'status'
    CHECK(type IN (
      'status', 'dispatch', 'worker_done', 'merge_ready',
      'escalation', 'handoff', 'decision_gate', 'question', 'heartbeat'
    )),
  priority      TEXT NOT NULL DEFAULT 'normal'
    CHECK(priority IN ('normal', 'high', 'urgent')),
  thread_id     TEXT,
  payload       TEXT,
  read          INTEGER NOT NULL DEFAULT 0,
  sequence      INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  delivered_at  TEXT,
  sender_pane_key TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_id ON messages(id);
CREATE INDEX IF NOT EXISTS idx_inbox ON messages(to_handle, read);
CREATE INDEX IF NOT EXISTS idx_thread ON messages(thread_id);

CREATE TABLE IF NOT EXISTS run_coordinator_handles (
  run_id          TEXT NOT NULL,
  terminal_handle TEXT NOT NULL,
  first_bound_at  TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (run_id, terminal_handle)
);

CREATE INDEX IF NOT EXISTS idx_run_coordinator_handles_handle
  ON run_coordinator_handles(terminal_handle, run_id);

CREATE TRIGGER IF NOT EXISTS trg_runs_remember_coordinator_insert
AFTER INSERT ON runs
WHEN NEW.legacy = 0 AND NEW.coordinator_handle IS NOT NULL
BEGIN
  INSERT OR IGNORE INTO run_coordinator_handles (run_id, terminal_handle)
  VALUES (NEW.id, NEW.coordinator_handle);
END;

CREATE TRIGGER IF NOT EXISTS trg_runs_remember_coordinator_update
AFTER UPDATE OF coordinator_handle ON runs
WHEN NEW.legacy = 0 AND NEW.coordinator_handle IS NOT NULL
BEGIN
  INSERT OR IGNORE INTO run_coordinator_handles (run_id, terminal_handle)
  VALUES (NEW.id, NEW.coordinator_handle);
END;

CREATE TRIGGER IF NOT EXISTS trg_runs_forget_coordinator_handles
AFTER DELETE ON runs
BEGIN
  DELETE FROM run_coordinator_handles WHERE run_id = OLD.id;
END;

CREATE TABLE IF NOT EXISTS deliveries (
  id                    TEXT PRIMARY KEY,
  run_id                TEXT NOT NULL,
  consumer_generation   INTEGER NOT NULL,
  message_ids           TEXT NOT NULL,
  status                TEXT NOT NULL DEFAULT 'outstanding'
    CHECK(status IN ('outstanding', 'acknowledged', 'fenced')),
  created_at            TEXT NOT NULL DEFAULT (datetime('now')),
  acknowledged_at       TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_deliveries_one_outstanding
  ON deliveries(run_id) WHERE status = 'outstanding';
CREATE INDEX IF NOT EXISTS idx_deliveries_run_created
  ON deliveries(run_id, created_at);

CREATE TABLE IF NOT EXISTS mutation_receipts (
  caller_fingerprint  TEXT NOT NULL,
  request_id          TEXT NOT NULL,
  method              TEXT NOT NULL,
  payload_hash        TEXT NOT NULL,
  state               TEXT NOT NULL DEFAULT 'pending'
    CHECK(state IN ('pending', 'completed')),
  receipt             TEXT,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (caller_fingerprint, request_id)
);

CREATE TABLE IF NOT EXISTS mutation_caller_identities (
  transport           TEXT PRIMARY KEY,
  caller_fingerprint  TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS worker_dispatches (
  dispatch_id            TEXT PRIMARY KEY,
  runtime_epoch          TEXT,
  state                  TEXT NOT NULL DEFAULT 'starting'
    CHECK(state IN (
      'starting', 'ready', 'start_unknown', 'failed', 'succeeded',
      'stopping', 'stop_unknown', 'stopped', 'abandoned'
    )),
  stage                  TEXT NOT NULL DEFAULT 'accepted',
  worktree_id            TEXT,
  agent_terminal_handle  TEXT,
  setup_state            TEXT NOT NULL DEFAULT 'not_applicable',
  effects                TEXT NOT NULL DEFAULT '[]',
  residual_resources     TEXT NOT NULL DEFAULT '[]',
  start_options          TEXT NOT NULL DEFAULT '{}',
  last_error             TEXT,
  created_at             TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at             TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS worker_terminal_resources (
  id                       TEXT PRIMARY KEY,
  origin_dispatch_id       TEXT NOT NULL,
  owner_dispatch_id        TEXT NOT NULL,
  prior_owner_dispatch_ids TEXT NOT NULL DEFAULT '[]',
  worktree_id              TEXT,
  terminal_handle          TEXT NOT NULL,
  pane_key                 TEXT,
  process_incarnation      TEXT,
  host_scope               TEXT,
  ownership_state          TEXT NOT NULL DEFAULT 'owned'
    CHECK(ownership_state IN ('owned', 'transferred', 'user_owned', 'external', 'released')),
  release_state            TEXT NOT NULL DEFAULT 'not_requested'
    CHECK(release_state IN (
      'not_requested', 'retained', 'requested', 'releasing', 'released', 'unknown'
    )),
  retained_reason          TEXT,
  release_requested_at     TEXT,
  release_completed_at     TEXT,
  release_error            TEXT,
  archive_source           TEXT,
  archive_status           TEXT,
  created_at               TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at               TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_worker_terminal_resources_owner
  ON worker_terminal_resources(owner_dispatch_id);
CREATE INDEX IF NOT EXISTS idx_worker_terminal_resources_handle
  ON worker_terminal_resources(terminal_handle);
CREATE INDEX IF NOT EXISTS idx_worker_terminal_resources_pane
  ON worker_terminal_resources(pane_key);
CREATE INDEX IF NOT EXISTS idx_worker_terminal_resources_identity
  ON worker_terminal_resources(process_incarnation, host_scope);
CREATE INDEX IF NOT EXISTS idx_worker_terminal_resources_release
  ON worker_terminal_resources(release_state);

CREATE TABLE IF NOT EXISTS worker_terminal_archives (
  dispatch_id   TEXT PRIMARY KEY,
  resource_id   TEXT NOT NULL,
  kind          TEXT NOT NULL CHECK(kind IN ('transcript_pin', 'terminal_tail')),
  content       TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
```

### 3b. `src/main/runtime/orchestration/db/schema/create-graph-tables-sql.ts`

```sql
CREATE TABLE IF NOT EXISTS federated_dispatches (
  dispatch_id             TEXT PRIMARY KEY,
  environment_id          TEXT NOT NULL,
  environment_name        TEXT NOT NULL,
  peer_fingerprint        TEXT NOT NULL,
  remote_runtime_epoch    TEXT,
  protocol_version        INTEGER NOT NULL DEFAULT 1,
  remote_worktree_id      TEXT,
  remote_terminal_handle  TEXT,
  to_home_imported_sequence INTEGER NOT NULL DEFAULT 0,
  to_home_acknowledged_sequence INTEGER NOT NULL DEFAULT 0,
  created_at              TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at              TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS remote_dispatch_attachments (
  dispatch_id             TEXT PRIMARY KEY,
  task_id                 TEXT NOT NULL,
  home_peer_fingerprint   TEXT NOT NULL,
  protocol_version        INTEGER NOT NULL DEFAULT 1,
  runtime_epoch           TEXT NOT NULL,
  capability_hash         TEXT,
  pane_key                TEXT,
  process_incarnation     TEXT,
  state                   TEXT NOT NULL DEFAULT 'starting'
    CHECK(state IN (
      'starting', 'ready', 'start_unknown', 'failed', 'succeeded',
      'stopping', 'stop_unknown', 'stopped', 'abandoned'
    )),
  stage                   TEXT NOT NULL DEFAULT 'accepted',
  worktree_id             TEXT,
  terminal_handle         TEXT,
  setup_state             TEXT NOT NULL DEFAULT 'not_applicable',
  effects                 TEXT NOT NULL DEFAULT '[]',
  residual_resources      TEXT NOT NULL DEFAULT '[]',
  to_worker_imported_sequence INTEGER NOT NULL DEFAULT 0,
  last_error              TEXT,
  created_at              TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at              TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_remote_dispatch_attachments_active_pane
  ON remote_dispatch_attachments(pane_key)
  WHERE state IN ('starting', 'ready');
CREATE INDEX IF NOT EXISTS idx_remote_dispatch_attachments_active_pane_suffix
  ON remote_dispatch_attachments(${REMOTE_ATTACHMENT_PANE_KEY_MATCH_SUFFIX_SQL})
  WHERE state IN ('starting', 'ready') AND pane_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS federation_relay_items (
  dispatch_id   TEXT NOT NULL,
  direction     TEXT NOT NULL CHECK(direction IN ('to_home', 'to_worker')),
  sequence      INTEGER NOT NULL,
  message_id    TEXT NOT NULL,
  kind          TEXT NOT NULL,
  payload       TEXT NOT NULL,
  byte_count    INTEGER NOT NULL,
  acked_at      TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (dispatch_id, direction, sequence),
  UNIQUE (dispatch_id, direction, message_id)
);

CREATE INDEX IF NOT EXISTS idx_federation_relay_pending
  ON federation_relay_items(dispatch_id, direction, acked_at, sequence);

CREATE TABLE IF NOT EXISTS remote_questions (
  message_id        TEXT PRIMARY KEY,
  dispatch_id       TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'pending'
    CHECK(status IN ('pending', 'answered', 'closed')),
  answer_message_id TEXT,
  answer_body       TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  answered_at       TEXT
);

CREATE INDEX IF NOT EXISTS idx_remote_questions_dispatch_status
  ON remote_questions(dispatch_id, status);

CREATE TABLE IF NOT EXISTS tasks (
  id            TEXT PRIMARY KEY,
  run_id        TEXT NOT NULL DEFAULT '${LEGACY_RUN_ID}',
  parent_id     TEXT,
  created_by_terminal_handle TEXT,
  created_by_pane_key TEXT,
  created_by_process_incarnation TEXT,
  created_by_run_generation INTEGER,
  task_title    TEXT,
  display_name  TEXT,
  spec          TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending'
    CHECK(status IN (
      'pending', 'ready', 'dispatched',
      'completed', 'failed', 'blocked'
    )),
  deps          TEXT NOT NULL DEFAULT '[]',
  result        TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at  TEXT
);

CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks(parent_id);

CREATE TABLE IF NOT EXISTS dispatch_contexts (
  id                  TEXT PRIMARY KEY,
  run_id              TEXT NOT NULL DEFAULT '${LEGACY_RUN_ID}',
  task_id             TEXT NOT NULL,
  contract_version    INTEGER NOT NULL DEFAULT ${CURRENT_CONTRACT_VERSION},
  launch_token_hash   TEXT,
  assignee_handle     TEXT,
  assignee_pane_key   TEXT,
  capability_hash     TEXT,
  process_incarnation TEXT,
  capability_revoked_at TEXT,
  status              TEXT NOT NULL DEFAULT 'pending'
    CHECK(status IN ('pending', 'dispatched', 'completed', 'failed', 'circuit_broken')),
  failure_count       INTEGER NOT NULL DEFAULT 0,
  last_failure        TEXT,
  -- Why the process is gone, when Orca could establish it. See TerminalExitCause.
  termination_reason  TEXT,
  dispatched_at       TEXT,
  completed_at        TEXT,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  last_heartbeat_at   TEXT
);

CREATE INDEX IF NOT EXISTS idx_dispatch_task ON dispatch_contexts(task_id);
CREATE INDEX IF NOT EXISTS idx_dispatch_status ON dispatch_contexts(status);
CREATE INDEX IF NOT EXISTS idx_dispatch_assignee_handle ON dispatch_contexts(assignee_handle);

CREATE TABLE IF NOT EXISTS decision_gates (
  id            TEXT PRIMARY KEY,
  run_id        TEXT NOT NULL DEFAULT '${LEGACY_RUN_ID}',
  task_id       TEXT NOT NULL,
  question      TEXT NOT NULL,
  options       TEXT NOT NULL DEFAULT '[]',
  status        TEXT NOT NULL DEFAULT 'pending'
    CHECK(status IN ('pending', 'resolved', 'timeout')),
  resolution    TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at   TEXT
);

CREATE INDEX IF NOT EXISTS idx_gates_task ON decision_gates(task_id);
CREATE INDEX IF NOT EXISTS idx_gates_status ON decision_gates(status);

CREATE INDEX IF NOT EXISTS idx_runs_coordinator_pane_leaf
  ON runs(${RUN_PANE_KEY_MATCH_SUFFIX_SQL})
  WHERE coordinator_pane_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS coordinator_runs (
  id                  TEXT PRIMARY KEY,
  spec                TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'idle'
    CHECK(status IN ('idle', 'running', 'completed', 'failed')),
  coordinator_handle  TEXT NOT NULL,
  poll_interval_ms    INTEGER NOT NULL DEFAULT 2000,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at        TEXT,
  scheduler_lost_at   TEXT
);
```

(`coordinator_runs` is the retired autonomous-scheduler table — note its
`poll_interval_ms`; the live coordinator loop is agent-driven, per round 1.)

## 4. Does message `sequence` survive federation import? NO (numerically) / YES (as per-dispatch order)

Two distinct sequence spaces exist, and they answer the question differently:

- **The `messages.sequence` global total order does NOT cross databases.**
  `importFederatedRelayItem`
  (`src/main/runtime/orchestration/db/federation/federation-relay-import.ts`)
  materializes an imported message via `this.insertMessage(params.message)`,
  and `insertMessage`
  (`db/messages/message-insert.ts`) inserts only
  `(id, run_id, delivery_contract, from_handle, to_handle, subject, body,
  type, priority, thread_id, payload, sender_pane_key)` — **`sequence` is not
  in the column list**, so the importing DB's
  `sequence INTEGER PRIMARY KEY AUTOINCREMENT` assigns a fresh local value at
  import time. The origin DB's global sequence number is never transported
  (the relayed message shape in `importFederatedRelayItem` has no sequence
  field; `params.sequence` is the relay stream's own counter, below).

- **Per-(dispatch, direction) relative order DOES survive, enforced strictly.**
  The relay carries its own contiguous counter:
  `federation_relay_items` PK is `(dispatch_id, direction, sequence)`, assigned
  as `MAX(sequence)+1` per stream at enqueue
  (`federation-relay-enqueue.ts`). Import runs under `BEGIN IMMEDIATE` and
  refuses gaps and reorders outright:

  ```ts
  const duplicate = params.sequence <= federated.to_home_imported_sequence
  ...
  if (!duplicate && params.sequence !== federated.to_home_imported_sequence + 1) {
    throw new OrchestrationError(
      'operation_unknown',
      `Federated relay for ${params.dispatchId} is not contiguous after sequence ${federated.to_home_imported_sequence}.`
    )
  }
  ```

  with the high-water mark advanced in the same transaction
  (`setFederatedHomeImportSequence`), duplicates detected both by relay
  sequence and by message `id` (unique `idx_messages_id`; a re-imported id with
  mismatched run/recipient/type throws `request_mismatch`). So each federated
  dispatch stream lands in the home DB in exact origin order, exactly once.

- **What is NOT preserved: cross-stream interleaving.** Messages from two
  federated dispatches (or a federated dispatch racing local senders) get local
  `sequence` values in import-arrival order, which need not match origin-side
  wall-clock or origin sequence order. Within one run's mailbox this is the
  same "total order is per-database, assigned at insert" semantics as local
  mail — consumers that only assume per-sender/per-dispatch FIFO are safe;
  anything assuming a global cross-database order is not.

  Caveats on capacity/coalescing (enqueue side, same file): a stream carries at
  most 256 unacked items / 1 MiB / 64 KiB per item; `heartbeat` items are
  coalesced in place (updated, keeping their old relay sequence) and a
  `worker_done` may overwrite the oldest unacked heartbeat's slot when the
  stream is full — so heartbeats are explicitly not order-faithful; substantive
  message types are.

## Q1–Q4 verdict table

| # | Question | Verdict |
|---|---|---|
| 1 | `check --wait` wake | **Push**: in-memory promise waiter in the runtime, resolved synchronously by the send path (`notifyMessageArrived`); timeout + abort are the only timers; no DB polling |
| 2 | Preamble | Captured verbatim above (`preamble.ts`, whole file) |
| 3 | Schema SQL | Captured verbatim above (core + graph, whole `CREATE` scripts) |
| 4 | `sequence` across federation | Origin's global `messages.sequence` is dropped (re-assigned locally by AUTOINCREMENT); per-dispatch order strictly preserved by a contiguous relay counter that rejects gaps; cross-stream interleaving is import-order; heartbeats coalesce |

## VERIFIED / NOT VERIFIED

VERIFIED (all reads at sha `1fafccb26bf8f1151cfea3f5ca915abb848d8741` via
`gh api repos/stablyai/orca/contents/<path> -H "Accept: application/vnd.github.raw"`):
- Files read in full: `check-keepalive.ts`, `message-check-handler.ts`,
  `mailbox-notification-coordinator.ts`, `mailbox-pointer-delivery.ts`,
  `preamble.ts`, `create-core-tables-sql.ts`, `create-graph-tables-sql.ts`,
  `federation-relay-import.ts`, `federation-relay-enqueue.ts`,
  `federation-relay-item.ts`, `message-insert.ts`; plus the
  `waitForMessage`/`notifyMessageArrived`/check-handler regions of
  `rpc/methods/orchestration.ts` (2053 lines) and `orca-runtime.ts`
  (41734 lines).
- LICENSE text (MIT, Lovecast Inc. 2026) read from the repo.

NOT VERIFIED:
- Runtime behaviour was **read, not executed** — no orca build was run; the
  push claim is source-derived (the waiter Set has no polling reader anywhere I
  searched, and the code comments assert "instead of polling", but I did not
  drive a live `check --wait`).
- `contract-constants.ts` / `pane-key-match.ts` interpolated values were not
  fetched; the `${...}` placeholders above are unexpanded.
- The remaining ~41k lines of `orca-runtime.ts` and the legacy-mail/question
  paths (`orchestration-legacy-*.ts`), which also call `waitForMessage` — not
  read; a poll loop hiding there is unlikely (grep for `setInterval` near
  message paths found only unrelated timers) but not excluded.
- Line numbers cited are for sha `1fafccb` only.
