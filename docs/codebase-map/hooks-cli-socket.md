# Hooks server, local socket & CLI

The IPC fabric that lets agents (and the `orchestra` CLI) talk to the running
app. Files: `src/main/hooks-server.ts`, `src/cli/index.ts`, `src/main/cli-shim.ts`,
hook scripts authored in `src/main/workspaces.ts` (~`:1500–2327`). Tests:
`orchestra-hook.test.ts`.

## The Unix-socket HTTP server (hooks-server.ts)
A minimal HTTP daemon on a Unix domain socket (POSIX:
`$XDG_RUNTIME_DIR/orchestra-<pid>.sock`; Windows: named pipe). Socket is mode
`0o600`; stale socket unlinked before bind.

**Discovery** (used by CLI and hooks), in order:
1. `$ORCHESTRA_SOCK` env var;
2. the pointer file `~/.orchestra/sock` (its body is the absolute socket path);
3. else error.

**Routes** — all POST, all reply `{ ok: boolean, ... }` (per-route body size
limits; 4 KB default, 1 MB for `/spawn` and `/message`). Each routes to a
`dispatch*Request` exported from `workspaces.ts` (see
[workspaces.md](workspaces.md)). An UNKNOWN route — incl. the retired `/event` activity POST and `/read` (#378) — answers an empty `200 {}`:

| Route | Required body | Response |
|---|---|---|
| `/rename` | `id`, `branch` (+ `from` — the caller's `ORCHESTRA_WS_ID`, resolved by the CLI like `/spawn`'s; absent = unknown caller, e.g. an old CLI) | `{ ok, branch?, error? }` — **#383 rename authority (human > parent > child):** `dispatchRenameRequest(id, branch, from?)` (`workspaces.ts:1101`) builds `{kind:'agent', id: from}` and asks `decideRename` (`naming-policy.ts:129`) BEFORE any git/store write; a refusal is `{ok:false, error}` ("named by your parent (<parent name>) — ask them to run `orchestra rename`" / "named by your parent, who no longer exists — it can be renamed from the sidebar" when the namer was deleted / "named by the human …"), branch unchanged, nothing written. The sandbox rpc (`sandbox-manager.ts:85`, payload `rename: {id, branch, from?}` in `sandbox-protocol.ts`) passes `from` too. Identity is self-asserted (same trust as every socket route). The sidebar rename never uses this route (it is the `human` caller, `api-handlers.ts` `renameBranch`). |
| `/spawn` | `task`, **`name` (REQUIRED, #382 — `<rôle>-<objet>[-<ticket>]`, rôle ∈ ops\|impl\|verif\|review\|explo; the CLI refuses a missing/unknown name before the socket, the route re-checks via `dispatchAgentSpawnRequest` for an old CLI: `{ok:false,error}`, nothing created; it becomes the child's branch, `from` its `namedByParent`)** (+ optional `repoPath`,`baseBranch`,`from`,`detached`,`model`,`effort`,**`profile`+`key` (#401, ADR 0010 — `orchestra spawn --profile <id|name>` plus the caller's `ORCHESTRA_SESSION_KEY`; the body NEVER says what the caller holds)** — `detached:true` skips parent nesting; `from` still drives repo inheritance; `model` pins the agent's model, passed as `claude --model` on every launch; `effort` pins `ws.sdkEffort`, validated by `parseEffortArg` — unknown levels are refused) | `{ ok, id?, branch?, error?, note?, profile?: {applied, message} }` — **`profile` (#401) is present only when `profile` was sent: `applied:true` = the new record carries the caller's profil navigateur; `applied:false` = the worker WAS created in navigation éphémère and `message` says why (never a spawn refusal — the caller's other work does not wait). Decided host-side by the pure `decideSpawnProfile` (`shared/spawn-profile.ts`) from the caller's LIVE record (`store.getWorkspace(from).browserProfileId` through `effectiveProfileId`) + `store.getBrowserProfiles()` + `sessionKeys().verify(from, key) === 'ok'` (ADR 0008: only the live session of `from`; no key / superseded / unregistered ⇒ refused `unvouched`); refusals: `--detached` (a parentless worker has no parent to hold it — fails closed) · no spawning workspace · unvouched · holds none (or a dangling id) · holds a different profile. The requested value is matched ONLY against the held profile (id or case-insensitive name), so a refusal never reveals the human's other profiles. Decided at the RECORD BUILD, not at request time (M1): `dispatchSpawnRequest` hands `createWorkspace` a thunk (`decideProfile`, only when `--profile` was sent) that runs synchronously after the slow `git worktree add` with no `await` before the first upsert — so a human detach / switch / delete of the parent or the profile, or a superseded session, during creation is honoured (host harness `scripts/verify-spawn-profile-host.mjs` HOLDS the spawn inside `git worktree add` with a `post-checkout` hook to prove it). Honoured ⇒ the id is written into the INITIAL record — no panel exists yet and the human-only attach IPC (`browserProfileAttach`) is never involved; the sandbox wire and the human paths (pinned-Linear, accès mobile) carry no profile (always ephemeral). Pinned by `main/spawn-profile-wiring.test.ts`; built-app drive `scripts/e2e-spawn-profile.sh`.** **`note` = ok with a caveat (D6/D7: no first-turn outcome seen within the 20 s wait); `ok:false` with `id`/`branch` set = the child was created but its SDK session failed to start (#227): kept stopped, task retained, no PTY fallback; `error` names the reason and the id, `orchestra restart <id>` retries** |
| `/peers` | — (+ `stats?: true` — adds each git peer's committed three-dot diff vs base as `diff: {files,insertions,deletions}\|null`; one git subprocess per peer, so opt-in — the comms-resurface hook hits `/peers` on every prompt) | `{ ok, peers?: PeerInfo[] }` — `PeerInfo` is `{id,branch,repo,status,lastTask?,statusText?,formerBranch?,heldForMemory?,diff?}` (`formerBranch` = the name before the latest rename, #384); **#232 dropped the PTY-derived `running` flag** (nothing printed it) |
| `/message` | `to`, `text` (+ `from`) | `{ ok, delivery?: 'live'\|'started'\|'inbox' }` — **`'live'` is a PROVEN claim, not an optimistic one (issue #57 fault b):** it is returned only once the message actually became the target's turn (`sdkDeliverConfirmed` awaits the delivery watcher; see `structured-agent-view.md`). A turn discarded before running (Escape, session end, tray cancel, stop) or still unconfirmed after `DELIVERY_START_TIMEOUT_MS` falls back to the durable inbox and reports **`'inbox'`** — it previously reported `'live'` on the queue push alone and never corrected it, which is how senders lost messages silently. The CLI prints this verbatim as `Delivered (<delivery>).` **#232: nothing is ever typed into a PTY** — a live SDK session, else a structured wake (`started`), else the inbox. |
| `/message` (broadcast) | `to: string[]` **or** `children: true` (+ `from`, `text`) | `{ ok, results?: [{id, ok, branch?, delivery?, error?}] }` — issue #86. **Three shapes share this one route** and are discriminated by the TYPE of `to`: a `string` takes the original single-target path above and answers the original `{ok,delivery,branch}` shape (so an older CLI against a newer app is byte-for-byte unaffected); an ARRAY, or `children:true`, takes `dispatchBroadcastMessageRequest` and answers `results` instead — a per-target report cannot be squeezed into one `delivery` field without lying about which target it describes. `children:true` resolves the caller's **DIRECT children only**, never the descendant subtree (a subtree broadcast is a foot-gun mid-wave), SERVER-SIDE — `/peers` deliberately omits `parentId`, and client-side enumeration would race the store. A missing `from` with `children:true`, and an empty child set, are both NAMED refusals (`{ok:false,error}` with no `results`), never a silent success: a halt that reached nobody must not exit 0. Each target goes through the SAME `dispatchMessageRequest` as the single form, so `live`/`started`/`inbox` keep their exact meanings — INCLUDING the #169 fleet-coordination refusal: a broadcast is NOT a bypass by virtue of its shape (F3 / LEAD ruling D-W8-1). `dispatchBroadcastMessageRequest` threads the caller's explicit `emergency` flag through per target, so on a delivery-ON fleet a plain `--to <peer>`/`--children` of coordination text is REFUSED just like a positional send, and ONLY `--emergency --to`/`--children` (the #86 group-stop) bypasses and lands. Without an explicit `--emergency`, a halt of coordination text reaches nobody by design — the safe direction, since arbitrary coordination must not dodge the bus via `--to`; dispatch is CONCURRENT (`allSettled`, results re-ordered back into the caller's order): each delivery awaits a 10s bounded turn-start, so sequential dispatch would make those bounds ADD UP and a 7-target halt would not attempt target #7 until T+60s — and a hung agent, the thing you broadcast *about*, is exactly what consumes the full bound. Every target is attempted (no abort-on-first-failure — the point of a broadcast halt is that it reaches everyone), a THROWN target becomes its own failure row rather than sinking the report, and `ok` is the AND of all targets so a partial failure is a failure. A non-string member of the `to` array is REFUSED, never silently dropped. |
| `/addRepo` | `path` | `{ ok, repo? }` |
| `/deleteWorkspace` | `id` | `{ ok, id?, branch? }` |
| `/promote` | `id` | `{ ok, id?, branch?, kind? }` |
| `/attach` | `id` (+ `parentId?`) | `{ ok, id?, parentId? }` |
| `/setRepoAssociation` | `id` (+ `repoPath?`) | `{ ok, id?, branch?, repoAssociation? }` — files an orchestrator under a repo's sidebar section (omit `repoPath` to clear). DISPLAY ONLY: writes `repoAssociation`, never `repoPath`, so the coordinator stays repo-less and `/spawn` still won't inherit from it. |
| `/verifyLanded` | `id` (+ `from?`, `into?`) | `{ ok, id?, branch?, target?, unmerged?, commits? }` — coordinator close-out: are all commits on the child's branch tip on the target (explicit `into` ref, else the `from` caller's branch)? The route never throws and answers `{ ok }`; the CLI maps that to exit `0` LANDED / `2` NOT LANDED / `1` could-not-check (see the `verify-landed` entry below). |
| `/link` | `id` (+ `prUrls?: string[]`, `linearKey?`, `clear?`) | `{ ok, prUrls?, linearKey?, cleared? }` — attach the PR(s) / Linear issue this workspace is working on. The **only** writer of `linkedPrs`/`linkedLinearKey`; both badges are agent-reported, never derived. Validates strictly (`parsePrUrl`, `parseLinearTicketRef`) and rejects a branch name or non-PR URL. PRs **accumulate**: each call appends, deduped on `prLinkKey` (`owner/repo#number`), because one workspace can own several PRs across different repos. `clear:true` + a *named* `prUrls` drops those PRs; `prUrls: []` (flag present, no value) drops them **all** — so the route must not collapse an empty array to `undefined`, which would silently turn clear-all into a no-op. `prUrls` in the reply is the resulting full set, not the delta. |
| `/whoami` | `id` (+ `key` — #401: the caller's `ORCHESTRA_SESSION_KEY`, sent by the CLI when set) | `{ ok, id?, name?, branch?, kind?, orchestrator?, parentId?, repoPath?, baseBranch?, linkedPrUrls?: string[], linkedLinearKey?, browserProfile?: {id, name}\|null }` — a workspace's own record (**`browserProfile` #401 = the profil navigateur it HOLDS (a dangling id reads null), returned ONLY when `sessionKeys().verify(id, key) === 'ok'` — the vouched live session of that workspace; otherwise the field is OMITTED (never `null`, which would claim "ephemeral"), since `/whoami {id}` is any-id and a profile name is the human's sign-in label. The CLI prints it as the `browser` row — `<name> (<id>)` · `ephemeral` · `(not vouched)` — i.e. the value `orchestra spawn --profile` accepts**); the only in-band way an agent learns its `parentId` (peers excludes the caller). The two link fields are what `link-instruction.sh` reads to decide whether to nudge. |
| `/status` | `id` (+ `text?`) | `{ ok, statusText? }` — set/clear the workspace's agent-authored one-line status note (`Workspace.statusText`, shown under the sidebar row and in `/peers`). Empty/absent `text` clears; sanitized to a single ≤160-char line (`shared/status-text.ts`). |
| `/migrateAccount` | `id` (+ `accountId?` — null/'' = default login) | `{ ok, id?, branch?, accountId?, warnings? }` — stops the SDK session, moves the transcript (by dir IDENTITY, never deleting what was not moved, #240), re-pins; a 2nd call while one is in flight → `ok:false` "already in progress"; **no main-side resume (#232)**: the old `resumed` field and the CLI's `(resumed)` suffix are gone |
| `/accounts` | — | `{ ok, accounts?: {id,label,configDir}[] }` |
| `/loginUrl` | `accountId`, `url` | `{ ok, mode?: 'window'\|'external' }` — routes a login PTY's browser-open into the account's isolated OAuth window (`main/login-browser.ts`) |
| `/reloadSkills` | `id` OR `all: true` (+ `plugins?: true`) | `{ ok, results?: ReloadResult[] }` — hot-reload skills (and optionally plugins) into ALREADY-RUNNING SDK sessions via the retained `session.q`, so an out-of-band install lands without restarting the agent and losing its context. Handled by `agent-sdk.ts dispatchReloadSkillsRequest` (the one route served from `agent-sdk.ts` rather than `workspaces.ts`; importing it there would cycle, since `agent-sdk` already imports `workspaces`). Fans out over the LIVE `sessions` map, not the store — only a live session can be reloaded, and a workspace without one reports `outcome:'skipped'`, which is NOT a failure and does not colour the exit code. `plugins:true` waits ~2.5s once per fan-out for the CLI's settings cache before calling `reloadPlugins()`, and an empty `plugins: []` is expected rather than an error. |
| `/restart` | `id` (+ `fresh?: true`) | `{ ok, mode?: 'structured'\|'wake', fresh? }` — issue #111. Relaunch a workspace's `claude` process so a fresh boot re-reads CLAUDE.md/settings, **WITHOUT touching worktree/branch/commits**. The lifecycle had `spawn`/`delete` but nothing between, so an agent could not restart a peer (or itself) by script; a rule added to `~/.claude/CLAUDE.md` is read only at startup and a live session never re-reads it. Handled by `main/restart-workspace.ts dispatchRestartRequest` (a SEPARATE module — the structured path calls `sdkStop`/`ensureSession`/`sdkClear` through `agent-sdk.ts sdkRestart` without editing them, per the on-hold issue #124 boundary). Routes the SDK-session surfaces only (#232 removed the PTY mode) — the ticket's gap #3 was that the UI Restart button gated on `isRunning(id)` = PTY-only and silently skipped a structured session; the toolbar Restart (`api-handlers.ts restartAgent`) now goes straight through this dispatcher (`trigger:'toolbar'`). The whole glue is PURE and runtime-tested in `shared/restart-mode.ts` (issue #111 F1 — no Electron in the test path): `classifyRestartMode` decides the surface (live SDK → `structured`; else persisted `sdkSessionId!==undefined` → `structured`, `hasInput` alone (a STOPPED legacy terminal-only workspace, **#228**) → `wake`; neither → refuse diagnosably); `resolveRestart` owns every guard (missing-id / unknown-ws / archived / nothing-ran) + the routing (`routeRestart`) + the thrown-effect wrap; `dispatchRestartRequest` is a thin adapter that only injects the store record, the live probes, and the real effects. `shared/restart-mode.test.ts` gates all of it (21 tests: legacy → `wake`, SDK-session → `structured`, no-input → `unknown`, a live session of a legacy-shaped ws → `structured`, the always-wake must-FAIL control). **Wake (#228)**: `sdkWakeRestart(id,{fresh,trigger})` in `agent-sdk.ts` — the same adoption step `sdkWake` uses (`adoptTerminalTranscript`: newest on-disk terminal transcript → `ws.sdkSessionId`, gated on the `.jsonl` existing) then `sdkRestart`, so the legacy conversation resumes in the Agent view and NO PTY starts; `--fresh` skips adoption (→ `sdkClear`). Once adopted the workspace classifies `structured` on every later restart. The PTY mode (stop + main-side PTY relaunch) is gone (#232; the launcher itself, #233): `RestartMode` is `structured | wake | unknown`, `RestartLiveness` is `{sdkLive}` and `RestartEffects` has no `restartPty`. **Structured**: `sdkRestart(id,{fresh})` — default = `sdkStop`+`killKeeper`+`ensureSession` (resumes `sdkSessionId`, same transcript); `--fresh` = `sdkClear` (blanks `sdkSessionId` to `''` → next send is vierge). Unknown/archived id → `{ok:false,error}`, CLI exits non-zero (no stack trace). **#227 — a kept child whose SDK start failed at spawn (`owesOpeningTask`: `lastTask` retained, `hasInput` unset, no `sdkSessionId`) is routed BEFORE the classifier (which would answer `unknown`) to `startWorkspaceAgentHeadless`: the task is delivered as its opening turn (mode reported `structured`, reply `openingTask:true`), or `restart failed: <reason>` when the start still fails.** |
| `/runRefreeze` | `runId` | `{ ok, outcome?: 'no-run'\|'not-mission'\|'live-child'\|'refrozen'\|'no-flags', runId?, frozenFlags?: string\|null }` — issue #156. ADMIN re-freeze of a FLAT mission's bus switches to the current live switches. A flat orchestrator (plain children only, no promoted sub-OPS) never hits `bus-run-anchor.ts` D1b's wave-boundary re-freeze, so its mission is stuck at its first anchor forever; this is the operator path. Handled by `workspaces.ts dispatchRunRefreezeRequest` (in main, NOT the store-less CLI, because the live-child gate needs the store's liveness probes — the bus cannot see a plain child's turn state; the mission run id IS its coordinator ws id, so children = `collectWorkspaceTree(runId)` minus the root, and `hasLiveChild` is `isRunning(w) || sdkSessionLive(w)` per child — BOTH surfaces, since `isRunning` alone is the #111 PTY-only blind spot). The gate is the pure `bus-runs.ts refreezeMissionRun`: mission-only (re-asserts `refreezeRun`'s `kind='mission'` guard), refused while any child is live mid-turn, and it calls only `refreezeRun` (a pure UPDATE) so **#134 F1 holds — never a late insert** (a mission with no `run_flags` row is `no-flags`, reads all-OFF). CLI verb `orchestra run refreeze [--run <id>]` prints the frozen table on `refrozen` (exit 0) and a diagnosable line on every refusal (non-zero, no stack). |
| `/browser` | `id`, `key` (+ `shotDir?`) | `{ ok:true, binary, wsUrl, env }` · `{ ok:false, code:'superseded'\|'unregistered'\|'unknown-workspace'\|'unavailable', error }` — #395/ADR 0009: `orchestra browser` asks for ITS workspace's agent-browser endpoint. `{id, key}` is verified like `/identity` (`sessionKeys().verify`) but with NO env fallback: a missing key, another workspace's key or an unknown id is refused. The host lazily starts that workspace's loopback CDP proxy, makes sure its host-owned agent-browser daemon is connected, and returns the binary path, the proxy ws URL and the `AGENT_BROWSER_*` env (+ scratch `HOME`) the client must run with. Service: `src/main/browser-cdp-host.ts` `dispatchBrowserRequest`; map: [browser-panel.md](browser-panel.md) § CDP proxy. |
| `/identity` | `id`, `key` | `{ ok:true, runId, generation: number\|null }` · `{ ok:false, code:'superseded'\|'unregistered', error }` — #379/ADR 0008: the HOST resolves a session's bus identity on every bus CLI call. `key` is the session's `ORCHESTRA_SESSION_KEY`; answered only to the live session of workspace `id` (hash match against `<ORCHESTRA_HOME>/session-keys.json`), so a promotion takes effect at the next call and a replaced session is refused (`superseded`). `unregistered` = the host holds no key for `id` → the CLI falls back to its env. The key is never echoed or logged. Service: `src/main/session-identity.ts` (Electron-free, #137 seam inventory); wiring `session-identity-host.ts`. |
| default (no match) | `id`, `event` | `{}` 200 — legacy activity-event path |

## Hooks installed into each worktree
`installOrchestraHooks(worktreePath)` writes into `<worktree>/.orchestra/` (8
shell scripts, mode 0755) and merges commands into
`<worktree>/.claude/settings.local.json`. Idempotent via a `HOOKS_VERSION` hash.
**Every script guards on `[ -n "${ORCHESTRA_WS_ID:-}" ] || exit 0`** — running
`claude` outside Orchestra is a silent no-op.

Scripts and the Claude Code events they fire on:
- **`orchestra-hook.sh`** (`ORCHESTRA_HOOK_SCRIPT`, ~`workspaces.ts:4849`; on `posttool` it also delivers a Pause douce ORDER once as the tool result's `additionalContext` — `<events dir>/../pause-orders/<ws>.json` → `.taken`, #254, `docs/codebase-map/pause-trap.md`) — UserPromptSubmit, Stop,
  Notification, PreToolUse, PostToolUse(+Failure), PostToolBatch, SessionStart. The **durable activity
  writer**: appends one JSON line per event to
  `~/.orchestra/events/<wsid>.jsonl`, allocating a monotonic `seq` under `flock`
  on `<wsid>.seq` (2s timeout; falls back to `seq=0` **and an unlocked append**
  without flock). The `seq` bump **and the spool append happen under that one
  lock** — `printf >> "$spool"` is one shell redirect but not one `write()` once
  the line is long (a long transcript path does it), so an append outside the
  lock let concurrent hooks interleave fragments and **tear a line**, which the
  reader then dropped — losing a lifecycle event (issues #28/#37; the turn-end
  `stop` going missing is what left the status dot stuck on `running`). Pure bash
  (no jq/sed); JSON-escapes the transcript path **before** taking the lock to
  keep the critical section short. Line:
  `{"seq":N,"event":"…","tool":"…","toolUseId":"…","transcript":"…","crons":"…"}`.
  Payload values (`tool_name`, `tool_use_id`, SessionStart `source`,
  `transcript_path`) come from ONE `mine KEY` helper — a single `[[ =~ ]]` scan
  under `LC_ALL=C`, **linear in the payload**. Never `${payload#*"KEY"}`: bash
  evaluates it in O(n²), and a PostToolUse carries the whole `tool_response`
  (an Edit's `originalFile`) BEFORE the top-level id — 46 s on a 287 KB Edit,
  with the agent blocked by the CLI the whole time (#198 D20). The hook never
  reads the transcript. `tool_use_id` is the **LAST `"tool_use_id": "<str>"`
  pair** (`mine tool_use_id last`): the call's own id follows tool_input /
  tool_response in every real shape, and a WebSearch `tool_response` nests
  `srvtoolu_` ids before it (#198 T11 F1). The installer writes every script
  to a temp file and `rename()`s it over the old one, so a hook still running
  the previous build keeps its own inode. An in-place rewrite fed that bash
  the new bytes at its old offset and lost the posttool (T11 F2). For the `session` event
  the `tool` slot carries the SessionStart `source`
  (startup|resume|clear|compact) so main can reset the context badge on
  clear/compact.
- **`rename-instruction.sh`** — UserPromptSubmit + SessionStart. **Two-stage**
  progressive nudge while `ORCHESTRA_BRANCH_AUTO=1`: stage 0 pushes hard for an
  early provisional name on the first prompt; stage 1 (after one auto-rename)
  pushes to refine it once the work is well-defined. Stage comes from the
  `.branch-renamed` sentinel count (fresher than `ORCHESTRA_AUTO_RENAME_COUNT`
  env); self-disables once the count hits `MAX_AUTO_RENAMES` (=2, `naming-policy.ts`; the env gate is `nudgeActive`). See
  [workspaces.md](workspaces.md) "Branch management".
- **`comms-resurface.sh`** (~`:1844`) — UserPromptSubmit. Queries `/peers`; prints
  the one-line `orchestra-comms` reminder only if peers exist (silent when solo).
- **`inbox-instruction.sh`** (~`:1871`) — SessionStart + UserPromptSubmit. Prints
  and drains `~/.orchestra/inbox/<wsid>.txt` (inter-agent messages).
- **`orchestrator-instruction.sh`** — SessionStart ONLY (which fires on
  startup, resume, clear and **post-compaction** — exactly when role text gets
  lost). Standing delegation reminder for **orchestrator** sessions: the
  one-time `--append-system-prompt` brief and the promote skill's role text
  live in conversation state that compaction summarizes away, so this
  re-injects the contract at every context reset. Deliberately NOT per-prompt
  (a per-turn injection compounds in the transcript). Self-silences unless
  `ORCHESTRA_KIND=orchestrator` (pty env) OR the `.orchestra/.orchestrator`
  sentinel exists (written at creation and by `/promote`, so a mid-session
  promotion is picked up before any pty restart).
- **`orchestrator-guard.sh`** — PreToolUse with matcher
  `Edit|MultiEdit|Write|NotebookEdit` (via `upsertMatcherHookCommand`). Hard
  enforcement between context resets, at zero token cost until it fires: for
  orchestrator sessions (same env/sentinel gate as above) it parses
  `tool_input.file_path` from the hook's stdin JSON and **denies (exit 2)**
  edits targeting another workspace's files (`~/.orchestra{,-dev}/worktrees/*`
  or `scratch/*` outside its own worktree), with a stderr message that
  redirects the agent to `orchestra send` (the bus) / spawn — no longer
  `orchestra message`, which #169 retired as a coordination path on a bus run.
  Own-worktree writes
  (notes, plans), relative paths, and parse misses fail open.
  **Caveat:** its install command ends `&& bash "$f" || true`, and the
  `|| true` turns the exit 2 into 0, so the deny never reaches the CLI
  (measured 2026-10-01 with a real `claude -p` against the same wrapper).
- **`home-root-guard.sh`** — PreToolUse, matcher
  `Bash|Edit|MultiEdit|Write|NotebookEdit`, every workspace. Script lives in
  `src/shared/home-root-guard.ts` (its test runs that same string). **Denies
  (exit 2)** a call that names a NON-existent entry (dot-entries included)
  directly under `$HOME` (`~/x`, `$HOME/x`, `${HOME}/x`, or the literal home
  path). Bash calls scan the payload minus `transcript_path`/`cwd`, while file
  tools scan only `file_path`/`notebook_path`.
  The deny message points the agent at `~/.orchestra/agent-tmp/<wsid>/`.
  Existing entries pass. Relative paths (`cd ~ && mkdir x`) slip through, and
  so does a script that writes there by itself — so tests/rigs needing
  `$HOME`'s btrfs use `mkHomeScratch()` (`src/shared/home-scratch.ts`,
  `~/.cache/orchestra-test/`). The command has no `|| true`
  (see the caveat above).
- **`tmp-guard.sh`** — PreToolUse, same matcher, every workspace; script in
  `src/shared/tmp-guard.ts` (its test runs that string). Inert unless the session has
  a disk TMPDIR (`ORCHESTRA_AGENT_TMPDIR`, set by `src/main/agent-tmpdir.ts`). **Denies
  (exit 2)** a call naming a NON-existent entry directly under `/tmp` (tmpfs = RAM on
  Fedora: agents' literal `/tmp` rigs + leaking tests filled 14 GB of it, 2026-10-12) and
  points at `$TMPDIR`. Existing `/tmp` entries, `/var/tmp`, `~/tmp`, `$TMPDIR/...` pass.
  A script that writes `/tmp` by itself slips through — the TMPDIR covers `os.tmpdir()`/`mktemp`.
- **`fieldguide-instruction.sh`** — SessionStart ONLY. Injects the parent
  orchestrator's **swarm field guide** (`<orchestra-home>/fieldguide/
  <orchestrator-id>.md`, written by the orchestrator per the `orchestra-spawn`
  skill) into every child, hard-capped at 60 lines. Parent is resolved LIVE
  via `orchestra whoami` each fire — `parentId` is mutable (`/attach`), so
  baking it into env/sentinel would go stale. Self-silences without a
  parent/guide/CLI.
- **`link-instruction.sh`** — SessionStart **and** UserPromptSubmit (the latter
  passes the arg `prompt`; two distinct hook command strings so both register).
  Asks the agent to report its PR(s)
  (`orchestra link --pr`, repeatable) and/or Linear issue (`--linear`), because
  neither badge is derived from the branch name any more — this hook is the sole
  discovery path for the capability, and it explicitly tells the agent to link
  **every** PR when work spans several repos. **Gated on being unlinked**: it
  parses `orchestra whoami`'s padded `key  value` table (NOT json — the CLI
  prints a text table) for the `pr` / `linear` rows and prints nothing once both
  are set, so a linked workspace pays zero tokens forever. Multiple PRs render
  space-separated on the one `pr` row, so the gate stays a simple `http*`
  presence test regardless of count. Rows are read anchored to line start, so a
  branch named e.g. `pr-linear-stuff` can't be mistaken for a row. Fails
  **silent** (not nagging) when `whoami` is unreachable or returns a non-table
  body — a restarting daemon must not nag every SessionStart.
  **Branch-mined suggestion**: it greps the LIVE git branch (never
  `$ORCHESTRA_BRANCH`, stale after a rename) for a `TEAM-123` shape, mirroring
  `parseLinearIssueCandidate` in `src/shared/linear.ts`, and names that key plus
  the exact command in the message. The badge is still never *inferred* — the
  hook suggests, the agent confirms with `orchestra link`.
  **`prompt` mode** (`workspaces.ts:3604` `LINK_PROMPT_NUDGE_BUDGET = 3`)
  is the only per-turn part and is deliberately the narrowest possible. Gates
  run strictly **cheapest-first**, because this fires on every turn of every
  workspace: spent budget (`.orchestra/.link-nudges`, one stat) → branch
  candidate (one local `git rev-parse`) → `whoami` (the only socket
  round-trip). It exists because SessionStart alone loses the link: an agent
  handed a ticket reads the turn-1 nudge, works, and never returns to it. The
  budget is charged when a nudge prints — so a false-positive branch nags 3
  times and goes quiet — and is **spent outright when the link is found**, which
  is what stops a linked, key-named branch from re-querying `whoami` every turn
  forever to rediscover the same answer (a cleared link is still covered by the
  SessionStart ask). A branch with *no* candidate deliberately does NOT retire:
  a rename can introduce the key at any turn, and that is the case this exists
  to catch. The generic
  full ask (including the PR half) stays SessionStart-only. Covered by
  `src/main/link-nudge.test.ts`, which extracts the real script from
  `workspaces.ts` and runs it against a fake `orchestra` + real git repo.
  Paired skill: `orchestra-link`.
- **`self-modify-instruction.sh`** — SessionStart ONLY. Self-modification
  notice for agents working on **Orchestra's own repo**: tells the agent this
  repo is the app currently running it, that changes only land after a
  release+install (ship skill), and that the generated worktree files
  (`.orchestra/*.sh`, hooks, skills) must be changed at their source in
  `src/main/workspaces.ts`. Installed unconditionally like every other hook;
  self-gates at runtime on the worktree actually being Orchestra (double gate:
  `"name": "orchestra"` in `package.json` AND `docs/codebase-map/` exists, so
  an unrelated repo named "orchestra" stays silent). Exception to the
  `$ORCHESTRA_WS_ID` guard note above — its gate is repo identity, not env.

Also installs 10 **capability skills** as `<worktree>/.claude/skills/<name>/SKILL.md`
(orchestra-spawn / -comms / -repos / -promote / -attach / -set-repo / -rename /
-link / -migrate-account / -status) so the agent discovers them. They are
template literals in `workspaces.ts`, NOT tracked `.md` files — each is hashed
into `HOOKS_VERSION`, so adding one forces exactly one reinstall per workspace.
The old SessionStart readiness-sentinel hook (it touched a ready file for the PTY task
injector) is retired (#233): the installer no longer writes it and EVICTS it (`isRetiredReadyCmd`) from an
already-installed `settings.local.json` on the next reinstall.

Session env that makes it all work (set in `buildSdkEnv`, `agent-sdk.ts` — the SDK session is the only
agent launch path): `ORCHESTRA_WS_ID`, `ORCHESTRA_WS_ID_IDENTITY`, `ORCHESTRA_SOCK`, `ORCHESTRA_EVENTS_DIR`,
`ORCHESTRA_WORKTREE`, `ORCHESTRA_BRANCH`, `ORCHESTRA_BRANCH_AUTO`, `ORCHESTRA_KIND`, `ORCHESTRA_RUN_ID`;
PATH is prepended with `~/.orchestra/bin` so bare `orchestra` resolves. (`pty.ts` sets none of these any
more: the Run / nvim / login terminals are not agents.)

## The `orchestra` CLI (src/cli/index.ts, ~349 lines)
Standalone Node HTTP client (no npm deps) that POSTs to the socket. **Bus identity (#379/ADR 0008):**
before any identity verb (`HOST_IDENTITY_VERBS`: send/check/ack/ask/token/gate/run/bus-status) the CLI POSTs `/identity {id, key}` (`$ORCHESTRA_SESSION_KEY`, 3 s timeout)
and reads the run + coordinator generation from the host's answer through `liveEnv()` instead of the env baked at session start; a superseded session is refused,
and without a key / with the host unreachable / unvouched it falls back to the baked env + the `bus-run-stale` marker guard on `send` (transitional, removed with #136).
`orchestra promote|attach|detach|demote` print "new run in effect at the next CLI call (resolved by the host, no restart)" for such sessions. Details: [bus.md](bus.md) → Session identity resolved by the HOST. Reads
`$ORCHESTRA_SOCK`/pointer for the socket and, for self-identity (sent as `from`),
`$ORCHESTRA_WS_ID` with a fallback to `$ORCHESTRA_WS_ID_IDENTITY`
(`resolveSelfWorkspaceId`) — the latter is still set by the SDK session's
`buildSdkEnv` and the fallback is KEPT (#378) for a keeper born before #233, whose
frozen env withheld `$ORCHESTRA_WS_ID` while an agent PTY owned the spool. Exit 0 on `{ok:true}`, 1 otherwise
(error to stderr).
Subcommands: `peers [--stats]` (`--stats` adds per-peer committed diff vs base; an `ex` column — `ex-<previous name>`, blank for a never-renamed peer — sits beside `branch` ONLY when some peer was renamed, #384; `peersExColumn` in `shared/former-branch.ts`),
`message [--emergency] <id> <text…>`
(**#169 P4 — `message` is the LEGACY channel**: `dispatchMessageRequest` refuses
a single-target send when the target's anchored run has the `delivery` switch ON,
returning an error that names `orchestra send`; the pure decision is
`decideMessageChannel` in `src/shared/message-channel-gate.ts`, the switch is read
via `busSwitch(db, resolveWaveRunId(target), 'delivery')` — a missing run row reads
OFF and is never refused. Two escapes survive: a delivery-OFF run (legacy/bloc2),
and the leading `--emergency` token — the out-of-band liveness poke. `--emergency`
is recognised ONLY as `args[0]`, same body-hijack reasoning as the routing below.
The refusal is server-side so the socket enforces it even without this CLI),
`message --children <text…>` / `message --to <id,id,…> <text…>` (issue #86 broadcast:
one delivery line PER TARGET as a table, `--children` = your DIRECT children only,
`--to` collapses duplicates and drops blanks so a trailing comma is a typo not a
phantom target. **Flags are only recognised in the LEADING position** (`args[0]`):
a message BODY is data, so `orchestra message ws1 pass --to bob` sends to `ws1`
with the text verbatim. Scanning the whole argv first and branching afterwards
shipped once and silently misdelivered to `bob` at RC=0 — the mirror image of the
defect this ticket exists to fix. Exits **non-zero if ANY target failed** while still delivering to the
rest — an all-or-nothing 0 would hide the targets an emergency halt never reached —
and prints a `N of M target(s) failed: <ids>` summary to stderr. The positional
single-target form is unchanged, byte for byte, including its `Delivered (<kind>).`
line, which agents and scripts already parse), `spawn
--name <name> --task <text> [--repo <path>] [--base <branch>] [--model <model>] [--effort <level>] [--profile <id|name>] [--detached]`
(**`--profile` (#401): the CLI sends the request + `$ORCHESTRA_SESSION_KEY` (only with `--profile`), refuses a valueless `--profile` before the socket, and prints a refused pass as `warning: --profile not applied: …` on stderr (rc 0 — the worker exists) / an honoured one on stdout — also for a kept child (`ok:false` + id) before the start error, and a reply with NO decision (an app that predates `--profile`) is warned about too; `whoami` shows what you hold**) (`--name` is REQUIRED (#382): a stray word (`--name impl-sidebar lent 123`, `--name=x`, an unknown option) and a value option with no value (`--repo` last, `--model --detached`) are REFUSED before the socket — never silently dropped; `checkSpawnName` runs in the CLI BEFORE any socket I/O — a missing/unknown-rôle name exits 1 with `NAME_CONVENTION` restated and nothing created; it is sent as `name`, and the printed `Spawned <id> on branch <branch>` is the FINAL (collision-suffixed) branch; `--model` pins the agent's model — alias or full id; `--detached`
creates the workspace parentless — its own top-level section), `rename <id> <branch>` (sends `from: selfWorkspaceId()` — #383: the app refuses a rename the caller has no authority for and the CLI exits non-zero with the app's text),
`reload-skills [<id>|--all] [--plugins]` (make an out-of-band skill/plugin
install visible to sessions that are ALREADY RUNNING, without the restart that
would cost the agent its warm context — defaults to **self**; `--all` fans out
over every live session; `--plugins` also reloads plugins, which unlike plain
`~/.claude/skills` are not watched for changes. Prints one row per workspace so
it is visible WHICH sessions picked the install up, and exits non-zero only on a
real failure — "no live session" is a normal outcome, not an error),
`restart [<id>] [--fresh]` (issue #111 — relaunch the workspace's `claude`
process so it re-reads CLAUDE.md/settings WITHOUT touching worktree/branch/commits;
defaults to **self**, handled main-side (surface routing: `shared/restart-mode.ts`); the
reply names no surface — `Restarted <id> (conversation preserved)` / `(fresh (conversation cleared))`
(#228); default keeps the conversation, `--fresh` starts vierge. `takeBoolFlag(args,'--fresh')`
so the flag is position-independent; POSTs `/restart {id,fresh}`. `src/cli/index.ts` `case 'restart'`),
`promote <id>`, `attach <id> <parentId>`, `detach <id>`, `verify-landed <id>
[--into <branch>]` (close-out check: is every commit on the workspace's branch
tip on the target — the caller's branch by default? **Exit codes: `0` LANDED ·
`2` NOT LANDED · `1` could-not-check** — unknown/missing id, no git branch, no
target branch, different repos, or git itself failed. The `1`/`2` split is the
point: a coordinator gating close-out must tell "this branch has unmerged work"
apart from "I never actually checked", and collapsing them lets a broken
invocation read as a verdict. The NOT-LANDED text goes to **stdout** and is
unchanged; errors go to stderr via `fail()`. Terminating is done by throwing
(`exitWith`/`CliExit`, `cli/index.ts`) — a bare `process.exit()` does not
terminate synchronously inside the socket-response callback in the Electron
main process, so it used to fall through into the next `switch` case and exit 0,
printing a whoami record under the verdict (issue #59; same class as the
v0.5.209 `fail()` bug). Gate: `scripts/verify-verify-landed-exit.mjs`, which
drives the built bundle under real Electron — a plain-Node unit test cannot
observe this),
`browser <cmd>` (#395, ADR 0009 — drive THIS workspace's Browser panel through the bundled agent-browser: `prepareBrowserCommand` (split known `--flag=value`, make file arguments absolute, THEN allowlist the final argv; `--cdp/--session/--profile/…` and `connect/install/plugin/batch/…` refused BEFORE any socket I/O) → `POST /browser {id: $ORCHESTRA_WS_ID, key: $ORCHESTRA_SESSION_KEY}` (45 s) → spawns `agent-browser <args>` with a scrubbed env that carries `AGENT_BROWSER_CDP=<wsUrl>` from the host (never in argv: `/proc/<pid>/cmdline` is world-readable), buffers its output, maps a stale-ref failure to `browser_stale_ref`, exits with the client's code. Not in `HOST_IDENTITY_VERBS`: it never reads the run/generation. Pure half: `src/shared/browser-cli.ts`; rig `scripts/e2e-browser-cli.sh`),
`whoami` (this workspace's own record: kind, orchestrator role, parent, and the
`pr`/`linear` link rows), `link [--pr <url>]... [--linear <KEY>] [--clear] [id]`
(report which PR(s) / Linear issue this workspace is working on — defaults to
**self**, since the common caller is the agent linking its own work; an explicit
id is for a coordinator fixing up a child. `--pr` REPEATS and appends, deduped
on `owner/repo#number`, because one workspace can own several PRs across
different repos; `--clear --pr <url>` drops one, a bare `--clear --pr` drops
all. Argument parsing lives in the pure exported **`parseLinkArgs`**
(`link-args.test.ts`) because the two modes parse the same flags differently and
that asymmetry has already shipped a bug: in CLEAR mode `--linear` is a
*valueless selector*, so parsing it as a value-flag silently consumes the next
token — the positional workspace id — and the command reports "unknown
workspace" while looking well-formed. Only the explicit-id form breaks, so an
agent clearing its own links via `$ORCHESTRA_WS_ID` never sees it),
`status <text…>` / `status --clear` (set/clear THIS workspace's one-line status
note — rendered under its sidebar row and surfaced to peers; self-targeted via
the identity env vars; whitespace-only text is REJECTED at the CLI — `--clear`
is the only clear path, though the socket route itself treats empty `text` as
clear for programmatic callers),
`add-repo <path>`,
`delete <id> --yes`, `accounts` (list configured accounts), `migrate-account <id>
<accountId|--default>` (migrate a workspace to another login / back to default),
`login-url <url>` (internal — invoked by the login-browser shim below; account id
rides on `$ORCHESTRA_LOGIN_ACCOUNT`),
`run refreeze [--run <id>]` (issue #156 — ADMIN re-freeze of a FLAT mission's bus
switches to the current live ones; a flat orchestrator never hits D1b's
wave-boundary re-freeze so its mission is stuck at its first anchor. Resolves the
run `--run > $ORCHESTRA_RUN_ID > default` and POSTs `/runRefreeze`; prints the
frozen flag table on `refrozen` and a diagnosable line on every refusal
(`not-mission` / `live-child` / `no-run` / `no-flags`), non-zero, no stack.
`src/cli/index.ts` `case 'run'`; arg/outcome contract in
`src/cli/run-refreeze-args.test.ts`),
`run hold|resume [--run <id>] [--as <handle>] [--generation <n>]` (issue #204 — set/clear
the per-run HOLD flag that makes liveness skip every member of the run; STORE-LESS like
`send`/`ack` — writes `runs.held_at`/`held_by` in the bus directly, no socket route,
so it works while the app is down; refuses a run with no row; idempotent; AUTHORIZED —
only the run's coordinator or an ancestor run's coordinator (D7); FENCED through A6's
`fencedWrite` (F7); the hold shows in `orchestra bus-status` (`/busStatus` returns
`heldAt`/`heldBy`); see `bus.md` §Active coordinator + per-run HOLD),
`run pause --hard [--run <id>] [--as <handle>]` (#252 — STORE-LESS like `hold`; writes
`runs.paused_at`/`paused_by`/`pause_mode`; same authority + fencing as hold; refused while the run's
frozen `pause` switch is OFF; `run resume` lifts the pause AND the hold; see `bus.md` §Fleet PAUSE),
Fully non-interactive (destructive `delete` needs `--yes`).

### Message bodies (`src/cli/body-args.ts`)
`send`, `ask`, `gate open` and `status` build their body with `resolveBody` (via
`bodyOrFail` in `index.ts`), BEFORE any bus write or socket call: options only
before a `--` separator (`splitAtSeparator`), an unknown `--option` left in the
body is REFUSED (rc 1, "nothing was sent", the verb's options listed), and
`--body-file <path>` (`-` = stdin) reads a long body (exclusive with inline text;
missing/empty refused). Before this, `send … --file x` delivered the text
"--file x" with rc 0 (2026-10-04). `message` keeps its verbatim body (#59 —
slated for removal by ADR 0002). Tests: `body-args.test.ts` (pure),
`body-unknown-flag.test.ts` (built CLI, real bus, dead `ORCHESTRA_SOCK`).

### Help (`src/cli/help.ts`)
`COMMANDS` is the single help registry (group, one-line summary, full detail per
verb); `overview()` renders the grouped `orchestra --help`. `main()` short-circuits
`help <cmd>` and `<cmd> --help|-h` (also `<cmd> <sub> --help`, e.g. `gate open
--help`) BEFORE dispatch, so a help flag never executes the verb; unknown verbs get
`suggest()` typo hints. `src/cli/help.test.ts` fails when a `case` in `main()` has
no registry entry — adding a verb means adding its entry.

### Exiting the CLI: flush before you terminate (issue #62)

Every terminal exit funnels through **`exitAfterFlush(code)`** (`src/cli/index.ts`),
which awaits a `write('', cb)` on stdout AND stderr before calling
`process.exit`. `exitWith()` and `fail()` deliberately **do not call
`process.exit` themselves any more** — they only set `process.exitCode` and
throw their sentinel (`CliExit` / `CliFailure`); `runCli`'s catch does the
flush-then-exit. The `: never` signatures and the load-bearing throw from #59
are unchanged.

**Why.** `process.stdout.write()` to a PIPE is asynchronous — libuv buffers what
the pipe will not take at once. `process.exit()` in the SAME TICK as a large
write abandons the remainder: the reader sees a truncated prefix and **no error
on any stream**. A 3000-commit `verify-landed` verdict is ~182 KB and the
surviving prefix was 146496 bytes. (That is NOT a round buffer size — 143*1024
is 146432, 64 bytes short — and no mechanism for the exact figure is asserted
here. It is an observation, not an explanation.)

Two properties worth knowing before touching this code:

- **It is a RACE, not a threshold.** The same unfixed bundle with the same input
  truncated only **4/20** runs; a drain-neutered mutant **9/20**; the fixed
  build **0/20**. A single run of the *unfixed* build passes most of the time,
  so any one-shot check here is a dice roll that reads as a measurement.
- **It is not socket-specific and not Electron-specific**, contrary to what
  issue #62 originally proposed: the identical byte count reproduces under plain
  `node` with no socket involved. The axis is same-tick-exit vs
  flushed-exit. (#62's separate claim that the same payload written *outside*
  the socket callback flushed completely did **not** reproduce.)

**Two failure modes pull in OPPOSITE directions**, and the drain has to serve
both:

- **Dead reader** (`… | head -1`). EPIPE is delivered *as the write happens*, and
  after it the stream still reports `destroyed=false`, `writableEnded=false`,
  `writableLength=0` **indefinitely** — so flag-based guards are blind. Listeners
  attached later (inside the drain, after the verdict is written) wait for an
  event that already fired: measured **5/5 hangs**. The hang-up listeners are
  therefore installed at **module startup** (`outputHungUp`), giving **0/12**.
- **Slow but LIVE reader** (a slow parser, a loaded box). A drain bounded on a
  fixed wall-clock cuts it off — a 2000 ms bound truncated it **4/4 at 146496
  bytes with RC=2**, i.e. #62's defect wearing a success status. The deadline is
  therefore reset by **progress** (`'drain'`), not elapsed time, so a slow reader
  keeps extending it while a dead one does not.

A slow reader and a dead reader are indistinguishable to a timer; that is why
neither a pure timeout nor a pure listener works alone.

Gate: **`scripts/verify-cli-pipe-flush.mjs`** — drives the built bundle under
real Electron with stdout on a pipe, N runs per arm, asserting on the truncation
RATE (`--runs`, `--bundle`, `--expect-broken`), plus a **slow-live-reader** arm
and a **broken-pipe** arm (both required to be 0/N), the LANDED/ERROR contracts,
and that nothing of ours leaks onto stderr. Master fails all three axes through
the same rig (7/12, 3/3, 5/6), so no arm can pass on both builds. Wired as
`pnpm run test:cli-pipe`.

**It refuses to run outside the contained rig (issue #76).** It requires
`RIG_WAYLAND` to be set *and* to equal `WAYLAND_DISPLAY` (both the alias `wayland-rig`) — the signature only
`scripts/e2e-contained-rig.sh` produces — and otherwise exits **rc=3** with a
NAMED precondition error naming the unmet condition and the command that
satisfies it.

**What that pairing does and does not prove.** The rig assigns both variables
from the same value in one `CHILD_ENV` array (`scripts/e2e-contained-rig.sh`
`set_child_env WAYLAND_DISPLAY` / `RIG_WAYLAND`), so they agree *only* when the env came from the rig — that is
the discriminator. It is **not** a liveness check: because they are set
together, an env left over from a rig whose compositor has since exited still
has them equal and passes. What makes that case safe is that the sway socket is
gone, so Electron fails to connect rather than landing on somebody's screen.
The signature is also forgeable by hand — an accepted gap, declared in PR #79
and pre-existing at `561e3e9`. This is fail-closed by design, and a generic non-zero exit would
not have been enough: the earlier version silently blanked both display handles
when run bare, so Electron died on "Missing X server or $DISPLAY" and exited at
**0 bytes**, which this gate scored as TRUNCATION — a **fabricated failure
shaped exactly like #62, the bug under test**. Wave-6's verifier hit it for real
(`TRUNCATED 20/20`, `HUNG 6/6`, RC=1) and correctly blamed its own rig; a naive
CI invocation would have "reproduced" #62 forever. Run it as:

```
scripts/e2e-contained-rig.sh pnpm run test:cli-pipe
```

`e2e-contained-rig.sh` puts its rig dir (fake `HOME`, `ORCHESTRA_HOME`, sway socket) under
`${E2E_RIG_BASE:-/tmp}`; a rig whose filesystem is part of the instrument (btrfs, not the
tmpfs `/tmp`) sets `E2E_RIG_BASE` to a btrfs path — `scripts/e2e-agent-view-removal.sh` does, SHORT on
purpose (`/var/tmp/avr-<uid>`: a keeper socket path past 100 chars falls back to a shared hashed socket, which its
driver refuses — see [activity-pty-terminal.md](activity-pty-terminal.md) § Removal rig). Default unchanged.

### The rig's PRIVATE runtime world (incident Q2, ledger #405)

The human's `gnome-keyring-daemon` aborted twice (00:03:53 and 00:18:59 on 2026-10-26, `gkd_secret_service_get_pkcs11_session:
assertion 'client' failed` → GLib abort) seconds after rig Electrons crashed; every rig passed the REAL `XDG_RUNTIME_DIR=/run/user/<uid>`,
which holds the daemon's `bus` / `keyring/` / `p11-kit/` sockets (GLib's libsecret resolves `$XDG_RUNTIME_DIR/bus` even with
`DBUS_SESSION_BUS_ADDRESS` unset — Chromium's own "Could not parse server address" log speaks only for its OWN D-Bus client). So
`scripts/e2e-contained-rig.sh` now runs **its sway and the child in `<rig dir>/xdg`** (mode 0700, fresh per rig, never reused):

- **Env.** `SWAY_ENV` / `CHILD_ENV` are `env -i` arrays built before anything launches: `XDG_RUNTIME_DIR=<rig dir>/xdg`,
  `DBUS_SESSION_BUS_ADDRESS=unix:path=<rig dir>/no-session-bus` (a path that must never exist), no `/run/user/` in any value. The marker
  pass (grim) lists only the private dir's sockets — the rig never lists or connects to `/run/user/<uid>`.
- **Display name.** sway names its socket `wayland-1` in a fresh dir (also the human's compositor name; ~15 drivers refuse that name), so the
  child connects through the alias `wayland-rig` → the marker-verified socket (created after the marker pass). A driver that mixes a
  hard-coded real `XDG_RUNTIME_DIR` with the rig's name now fails closed (no `wayland-rig` in the human's dir) instead of landing on `wayland-1`.
- **`preflight_runtime_world <array> <stage>`** (rc=90 before the child; run on `CHILD_ENV` and `SWAY_ENV` before sway, and on the final
  `CHILD_ENV` right before launch): R0 no key twice (`env -i` lets the LAST duplicate win; the preflight reads the first) · R1 not `/run/user/*`
  (string compare after `norm_path` collapses `//`, `/./`, `x/../`; uses `id -u`) · R2 exactly the rig's `xdg` · R3 not a symlink
  nor resolving into `/run/user/` · R4 a directory I own, mode 0700 · R5 no `keyring*`/`bus*`/`pulse*`/`p11-kit*` entry · R6 the D-Bus var is exactly the
  private nonexistent path and that path does not exist · R7 no env VALUE contains `/run/user/` (normalized) and no absolute path in a value RESOLVES into it (`readlink -m`: a link — e.g. a caller-supplied `CLAUDE_CONFIG_DIR_PIN` — or `<link>/..` that passes every text test) · R8 path ≤ 84 chars (room for the hooks socket
  `orchestra-<12hex>.sock` in sun_path; the phone-access socket needs ≤ 66). Before any of it, an `E2E_RIG_BASE` under `/run/user/` (also after
  `readlink -m`) aborts before a single `mkdir`.
  `preflight_assert` (display) additionally refuses a `WAYLAND_DISPLAY` that is a path and checks the alias resolves to the verified socket.
- **Teardown** reaps a `gnome-keyring-d*` / `p11-kit-*` process that LISTENS on a socket inside this rig's private dir (`ss -xlpn`, by identity;
  never a `/proc/*/environ` scan — that opens the human's daemon's environ). `ss -p` still enumerates the unix-listener table and `readlink`s
  `/proc/*/fd` of same-uid processes — read-only, no connection. It logs the private dir's contents at exit (a `keyring` entry there =
  something reached for a keyring and found OUR empty dir).
- **Drivers**: take `XDG_RUNTIME_DIR` from `scripts/lib/rig-runtime.mjs` `privateRuntimeDir()` (throws unless it is `$RIG_DIR/xdg`), never a
  literal. `src/shared/rig-runtime-world.test.ts` is the ratchet: no script may keep the literal `/run/user` in a CODE line (pattern `\/run\/user\b`: also `'/run/user/' + uid`; split forms like `'/run/' + 'user/'` are uncatchable by regex — the hidden-world backstop is the only net) outside its reviewed `ALLOW` list
  (the list only shrinks; the remaining entries build their own sway/env — see the ledger #405 report). The 7 of them one `pnpm run test:*` away are
  routed through `scripts/refuse-real-runtime.mjs` in `package.json` (prints why, exits 3) until migrated.
- **Opt-in backstop** `RIG_HIDE_REAL_RUNTIME=1`: the rig re-execs under `bwrap --dev-bind / / --tmpfs /run/user/<uid>`, so the real dir is an
  EMPTY tmpfs for the whole rig (a hard-coded path cannot reach anything; entries created there at exit are logged). Use it for a rig's first
  Electron run. Default off. **Known cost of the private world:** the app inside a rig has no systemd user manager (`scopeSupport` ⇒ « no user manager socket »,
  keepers start uncapped); `pause-canary --exercise memhog-app` therefore REFUSES (rc 3, `run.mjs` + `drive.mjs`) instead of reading 0 units;
  rigs needing rootless docker through the contained rig get none either.
- **Mutant stamp**: a mutation run stamps the file it breaks (`# RIG-MUTANT:`); the rig and the self-test refuse a stamped file outside the driver
  (`RIG_SELFTEST_MUTANT_RUN=1`), so a SIGKILLed run cannot leave a hole behind.

### The rig's own self-test — `pnpm run test:rig-selftest`

`scripts/e2e-contained-rig-selftest.sh` proves the rig's two pre-flights can FAIL (32 arms). **Display (W1–W6):** a `WAYLAND_DISPLAY`
that is a path to the human's compositor, a sibling socket, a bogus one, the raw sway name `wayland-1`, an alias pointing at the wrong
socket, an added `DISPLAY` — each must abort **rc=90 without launching the child**. **Runtime world (R0–R10, 22 arms):** forced real
`XDG_RUNTIME_DIR` (and one under it, one disguised `/run/./user/<uid>`), a duplicated key, one outside the rig dir, a symlinked / 0755 private dir,
planted `keyring`/`bus`/`pulse`/`p11-kit` entries, forced real/`disabled:` D-Bus address, an existing bus path, an env value containing
`/run/user/<uid>` (pre-sway, added after sway, disguised, or reached through a symlink), an over-long path, sway's own env carrying the real dir and a rig base under
`/run/user/` and one through a SYMLINK into it (those three inside the hidden world) — hostile values go into the CHILD array only via `RIG_SELFTEST_*` and the rig aborts before launching; the pre-sway
arms also assert `sway pid=` never appeared. **Controls (C1–C4):** normal run launches the child; the same run with `/run/user/<uid>`
hidden behind an empty tmpfs (needs `bwrap`) passes and creates nothing in it; the child's REAL `env` (read from the child, not the array)
is private; a keyring-named stand-in listening in the private dir is reaped at teardown. Each arm also requires its **own abort reason** (`grep -E`), so an arm that aborts for a different clause is a failure.
`RIG_SELFTEST_ONLY="ID …"` runs a subset and can only print `PARTIAL-*` (never the gate's `PASSED`).

Mutation proof: `node scripts/e2e-contained-rig-mutants.mjs --unfixed` edits the real rig in place (33 clause-removal / construction-drift
mutants (one PAIRED: R3's resolved-path clause and the canonicalised base guard shadow each other), byte-exact restore + `cmp`) and demands exactly the named arms go FAIL; `--unfixed` also runs the pre-Q2 rig through the same
arms (it must fail them). No survivor: R3's resolved-path clause is killed together with the base guard (arm R10). Never run an Electron rig while it runs — it mutates the rig file.

It needs a live compositor, so it is deliberately **not** in `pnpm run test`
(which must stay runnable on a headless CI box). The wrapper
`scripts/run-rig-selftest.sh` makes the two bad outcomes distinguishable:

- **it never self-skips** — missing `sway`/`swaymsg`/`grim`/`bwrap` is a NAMED failure,
  **rc=2**, not a skip. A test that skips itself is an absent failure wearing a
  pass (wave-6 shipped exactly that: 12 self-skipping CLI tests inside a green
  suite, now guarded by the `pretest` hook);
- **silence is never success** — the child emits one `RIG-SELFTEST: <outcome>`
  line and the wrapper *requires* it. A child that dies early, is killed, or is
  replaced by something printing plausible `PASS` lines and exiting 0 yields no
  terminator and **fails (rc=1)**. A `PASSED` terminator is additionally
  cross-checked against the child's exit code, so the line alone is not trusted.

Exit codes: `0` ran and passed · `1` ran and an arm failed, or the terminator was
missing/inconsistent · `2` precondition unmet (no compositor) — named, never a skip.

## CLI shims (cli-shim.ts)
- **User-facing** — Linux `~/.local/bin/orchestra` (`exec "<AppImage>" cli "$@"`,
  the path from `APPIMAGE_PATH` in `src/main/app-image.ts` — `process.env.APPIMAGE`
  itself is stripped at startup, so read it only from there),
  Windows `%LOCALAPPDATA%\Orchestra\bin\orchestra.cmd`. Only overwritten if it
  carries the orchestra marker or is absent. macOS skipped (no agreed location).
- **Agent-facing** — `~/.orchestra/bin/orchestra`, re-installed every GUI startup
  (the AppImage mount path changes per run) and prepended to every agent session's PATH (`buildSdkEnv`).
- **Login-browser** — `installLoginBrowserShim()` writes fake `xdg-open`/`open`
  scripts into `~/.orchestra/bin/login-shim/`; the account-login PTY (only)
  gets that dir prepended to PATH so `claude /login`'s automatic browser-open
  is forwarded (`orchestra login-url` → `/loginUrl`) into the account's
  isolated OAuth window instead of the system browser. POSIX only (returns
  null on Windows). See [accounts-usage.md](accounts-usage.md).

## Tests (orchestra-hook.test.ts)
Validates `seq` allocation: sequential `[1,2,3,4]` with flock (`[0,0,0,0]`
without); 50 concurrent invocations yield exactly `1..N` (no dupes/gaps);
numbering restarts after `.seq` deletion (mirrors the reader's fresh-run reset).
Payload mining runs the REAL script (rendered from the template literal): Stop
`session_crons` states; a real-size Edit PostToolUse / Write PreToolUse mined in
bounded time (Edit, Write, failed Write); the spool line equal to the frozen
pre-D20 parse (spliced into the real script) on a seeded CLI-shaped corpus,
except a mis-mined nested id, which becomes the call's own (enumerated); the
real-shape WebSearch posttool; invalid UTF-8 kept byte-for-byte. The real-chain rig (installer → hook → spool reader → tracker,
plus a real-`claude` arm and a byte-identity arm vs another tree) is
`scripts/e2e-hook-cost.sh`.
