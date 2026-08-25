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
[workspaces.md](workspaces.md)):

| Route | Required body | Response |
|---|---|---|
| `/rename` | `id`, `branch` | `{ ok, branch? }` |
| `/spawn` | `task` (+ optional `repoPath`,`baseBranch`,`from`,`detached`,`model` — `detached:true` skips parent nesting; `from` still drives repo inheritance; `model` pins the agent's model, passed as `claude --model` on every launch) | `{ ok, id?, branch? }` |
| `/peers` | — (+ `stats?: true` — adds each git peer's committed three-dot diff vs base as `diff: {files,insertions,deletions}\|null`; one git subprocess per peer, so opt-in — the comms-resurface hook hits `/peers` on every prompt) | `{ ok, peers?: PeerInfo[] }` |
| `/read` | `id` (+ `lines?`) | `{ ok, branch?, transcript? }` |
| `/message` | `to`, `text` (+ `from`) | `{ ok, delivery?: 'live'\|'started'\|'inbox' }` — **`'live'` is a PROVEN claim, not an optimistic one (issue #57 fault b):** it is returned only once the message actually became the target's turn (`sdkDeliverConfirmed` awaits the delivery watcher; see `structured-agent-view.md`). A turn discarded before running (Escape, session end, tray cancel, stop) or still unconfirmed after `DELIVERY_START_TIMEOUT_MS` falls back to the durable inbox and reports **`'inbox'`** — it previously reported `'live'` on the queue push alone and never corrected it, which is how senders lost messages silently. The CLI prints this verbatim as `Delivered (<delivery>).` |
| `/addRepo` | `path` | `{ ok, repo? }` |
| `/deleteWorkspace` | `id` | `{ ok, id?, branch? }` |
| `/promote` | `id` | `{ ok, id?, branch?, kind? }` |
| `/attach` | `id` (+ `parentId?`) | `{ ok, id?, parentId? }` |
| `/setRepoAssociation` | `id` (+ `repoPath?`) | `{ ok, id?, branch?, repoAssociation? }` — files an orchestrator under a repo's sidebar section (omit `repoPath` to clear). DISPLAY ONLY: writes `repoAssociation`, never `repoPath`, so the coordinator stays repo-less and `/spawn` still won't inherit from it. |
| `/verifyLanded` | `id` (+ `from?`, `into?`) | `{ ok, id?, branch?, target?, unmerged?, commits? }` — coordinator close-out: are all commits on the child's branch tip on the target (explicit `into` ref, else the `from` caller's branch)? The route never throws and answers `{ ok }`; the CLI maps that to exit `0` LANDED / `2` NOT LANDED / `1` could-not-check (see the `verify-landed` entry below). |
| `/link` | `id` (+ `prUrls?: string[]`, `linearKey?`, `clear?`) | `{ ok, prUrls?, linearKey?, cleared? }` — attach the PR(s) / Linear issue this workspace is working on. The **only** writer of `linkedPrs`/`linkedLinearKey`; both badges are agent-reported, never derived. Validates strictly (`parsePrUrl`, `parseLinearTicketRef`) and rejects a branch name or non-PR URL. PRs **accumulate**: each call appends, deduped on `prLinkKey` (`owner/repo#number`), because one workspace can own several PRs across different repos. `clear:true` + a *named* `prUrls` drops those PRs; `prUrls: []` (flag present, no value) drops them **all** — so the route must not collapse an empty array to `undefined`, which would silently turn clear-all into a no-op. `prUrls` in the reply is the resulting full set, not the delta. |
| `/whoami` | `id` | `{ ok, id?, name?, branch?, kind?, orchestrator?, parentId?, repoPath?, baseBranch?, linkedPrUrls?: string[], linkedLinearKey? }` — a workspace's own record; the only in-band way an agent learns its `parentId` (peers excludes the caller). The two link fields are what `link-instruction.sh` reads to decide whether to nudge. |
| `/status` | `id` (+ `text?`) | `{ ok, statusText? }` — set/clear the workspace's agent-authored one-line status note (`Workspace.statusText`, shown under the sidebar row and in `/peers`). Empty/absent `text` clears; sanitized to a single ≤160-char line (`shared/status-text.ts`). |
| `/migrateAccount` | `id` (+ `accountId?` — null/'' = default login) | `{ ok, id?, branch?, accountId?, resumed? }` |
| `/accounts` | — | `{ ok, accounts?: {id,label,configDir}[] }` |
| `/loginUrl` | `accountId`, `url` | `{ ok, mode?: 'window'\|'external' }` — routes a login PTY's browser-open into the account's isolated OAuth window (`main/login-browser.ts`) |
| `/reloadSkills` | `id` OR `all: true` (+ `plugins?: true`) | `{ ok, results?: ReloadResult[] }` — hot-reload skills (and optionally plugins) into ALREADY-RUNNING SDK sessions via the retained `session.q`, so an out-of-band install lands without restarting the agent and losing its context. Handled by `agent-sdk.ts dispatchReloadSkillsRequest` (the one route served from `agent-sdk.ts` rather than `workspaces.ts`; importing it there would cycle, since `agent-sdk` already imports `workspaces`). Fans out over the LIVE `sessions` map, not the store — only a live session can be reloaded, and a workspace without one reports `outcome:'skipped'`, which is NOT a failure and does not colour the exit code. `plugins:true` waits ~2.5s once per fan-out for the CLI's settings cache before calling `reloadPlugins()`, and an empty `plugins: []` is expected rather than an error. |
| default (no match) | `id`, `event` | `{}` 200 — legacy activity-event path |

## Hooks installed into each worktree
`installOrchestraHooks(worktreePath)` writes into `<worktree>/.orchestra/` (8
shell scripts, mode 0755) and merges commands into
`<worktree>/.claude/settings.local.json`. Idempotent via a `HOOKS_VERSION` hash.
**Every script guards on `[ -n "${ORCHESTRA_WS_ID:-}" ] || exit 0`** — running
`claude` outside Orchestra is a silent no-op.

Scripts and the Claude Code events they fire on:
- **`orchestra-hook.sh`** (~`workspaces.ts:1901`) — UserPromptSubmit, Stop,
  Notification, PreToolUse, PostToolUse, SessionStart. The **durable activity
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
  `{"seq":N,"event":"…","tool":"…","transcript":"…"}`. For the `session` event
  the `tool` slot carries the SessionStart `source`
  (startup|resume|clear|compact) so main can reset the context badge on
  clear/compact.
- **`rename-instruction.sh`** — UserPromptSubmit + SessionStart. **Two-stage**
  progressive nudge while `ORCHESTRA_BRANCH_AUTO=1`: stage 0 pushes hard for an
  early provisional name on the first prompt; stage 1 (after one auto-rename)
  pushes to refine it once the work is well-defined. Stage comes from the
  `.branch-renamed` sentinel count (fresher than `ORCHESTRA_AUTO_RENAME_COUNT`
  env); self-disables once the count hits `MAX_AUTO_RENAMES` (=2). See
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
  redirects the agent to `orchestra message` / spawn. Own-worktree writes
  (notes, plans), relative paths, and parse misses fail open.
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
into `HOOKS_VERSION`, so adding one forces exactly one reinstall per workspace. A SessionStart readiness hook touches `$ORCHESTRA_READY_FILE` so
spawn task-injection knows the TUI is live.

PTY env that makes it all work (set in `pty.ts`): `ORCHESTRA_WS_ID`,
`ORCHESTRA_SOCK`, `ORCHESTRA_EVENTS_DIR`, `ORCHESTRA_WORKTREE`,
`ORCHESTRA_BRANCH`, `ORCHESTRA_BRANCH_AUTO`, `ORCHESTRA_KIND`,
`ORCHESTRA_READY_FILE`; PATH is
prepended with `~/.orchestra/bin` so bare `orchestra` resolves.

## The `orchestra` CLI (src/cli/index.ts, ~349 lines)
Standalone Node HTTP client (no npm deps) that POSTs to the socket. Reads
`$ORCHESTRA_SOCK`/pointer for the socket and, for self-identity (sent as `from`),
`$ORCHESTRA_WS_ID` with a fallback to `$ORCHESTRA_WS_ID_IDENTITY`
(`resolveSelfWorkspaceId`) — the latter is set unconditionally by the SDK session's
`buildSdkEnv` so identity survives even when the spool gate withholds
`$ORCHESTRA_WS_ID` in a structured-view session. Exit 0 on `{ok:true}`, 1 otherwise
(error to stderr).
Subcommands: `peers [--stats]` (`--stats` adds per-peer committed diff vs base),
`read <id> [--lines N]`, `message <id> <text…>`, `spawn
--task <text> [--repo <path>] [--base <branch>] [--model <model>] [--detached]`
(`--model` pins the agent's model — alias or full id; `--detached`
creates the workspace parentless — its own top-level section), `rename <id> <branch>`,
`reload-skills [<id>|--all] [--plugins]` (make an out-of-band skill/plugin
install visible to sessions that are ALREADY RUNNING, without the restart that
would cost the agent its warm context — defaults to **self**; `--all` fans out
over every live session; `--plugins` also reloads plugins, which unlike plain
`~/.claude/skills` are not watched for changes. Prints one row per workspace so
it is visible WHICH sessions picked the install up, and exits non-zero only on a
real failure — "no live session" is a normal outcome, not an error),
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
rides on `$ORCHESTRA_LOGIN_ACCOUNT`).
Fully non-interactive (destructive `delete` needs `--yes`).

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
`RIG_WAYLAND` to be set *and* to equal `WAYLAND_DISPLAY` — the signature only
`scripts/e2e-contained-rig.sh` produces — and otherwise exits **rc=3** with a
NAMED precondition error naming the unmet condition and the command that
satisfies it. This is fail-closed by design, and a generic non-zero exit would
not have been enough: the earlier version silently blanked both display handles
when run bare, so Electron died on "Missing X server or $DISPLAY" and exited at
**0 bytes**, which this gate scored as TRUNCATION — a **fabricated failure
shaped exactly like #62, the bug under test**. Wave-6's verifier hit it for real
(`TRUNCATED 20/20`, `HUNG 6/6`, RC=1) and correctly blamed its own rig; a naive
CI invocation would have "reproduced" #62 forever. Run it as:

```
scripts/e2e-contained-rig.sh pnpm run test:cli-pipe
```

### The rig's own self-test — `pnpm run test:rig-selftest`

`scripts/e2e-contained-rig-selftest.sh` proves the rig's pre-flight assert can
FAIL: four hostile arms (the human's `wayland-1`, a sibling socket, a bogus
socket, an added `DISPLAY`) must each abort **rc=90 without launching the
child**, and a fifth CONTROL arm must launch — without it, an assert that
aborted unconditionally would score 4/4. Each arm also requires its **own abort
reason**, so an arm that aborts for a different reason than the one it tests is
a failure, not a pass.

It needs a live compositor, so it is deliberately **not** in `pnpm run test`
(which must stay runnable on a headless CI box). The wrapper
`scripts/run-rig-selftest.sh` makes the two bad outcomes distinguishable:

- **it never self-skips** — missing `sway`/`swaymsg`/`grim` is a NAMED failure,
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
  (the AppImage mount path changes per run) and prepended to every agent PTY's PATH.
- **Login-browser** — `installLoginBrowserShim()` writes fake `xdg-open`/`open`
  scripts into `~/.orchestra/bin/login-shim/`; the account-login PTY (only)
  gets that dir prepended to PATH so `claude /login`'s automatic browser-open
  is forwarded (`orchestra login-url` → `/loginUrl`) into the account's
  isolated OAuth window instead of the system browser. POSIX only (returns
  null on Windows). See [accounts-usage.md](accounts-usage.md).

## Tests (orchestra-hook.test.ts, ~121 lines)
Validates `seq` allocation: sequential `[1,2,3,4]` with flock (`[0,0,0,0]`
without); 50 concurrent invocations yield exactly `1..N` (no dupes/gaps);
numbering restarts after `.seq` deletion (mirrors the reader's fresh-run reset).
