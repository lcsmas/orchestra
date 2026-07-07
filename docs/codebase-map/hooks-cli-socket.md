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
| `/spawn` | `task` (+ optional `repoPath`,`baseBranch`,`from`) | `{ ok, id?, branch? }` |
| `/peers` | — | `{ ok, peers?: PeerInfo[] }` |
| `/read` | `id` (+ `lines?`) | `{ ok, branch?, transcript? }` |
| `/message` | `to`, `text` (+ `from`) | `{ ok, delivery?: 'live'|'started'|'inbox' }` |
| `/addRepo` | `path` | `{ ok, repo? }` |
| `/deleteWorkspace` | `id` | `{ ok, id?, branch? }` |
| `/promote` | `id` | `{ ok, id?, branch?, kind? }` |
| `/attach` | `id` (+ `parentId?`) | `{ ok, id?, parentId? }` |
| `/migrateAccount` | `id` (+ `accountId?` — null/'' = default login) | `{ ok, id?, branch?, accountId?, resumed? }` |
| `/accounts` | — | `{ ok, accounts?: {id,label,configDir}[] }` |
| default (no match) | `id`, `event` | `{}` 200 — legacy activity-event path |

## Hooks installed into each worktree
`installOrchestraHooks(worktreePath)` writes into `<worktree>/.orchestra/` (6
shell scripts, mode 0755) and merges commands into
`<worktree>/.claude/settings.local.json`. Idempotent via a `HOOKS_VERSION` hash.
**Every script guards on `[ -n "${ORCHESTRA_WS_ID:-}" ] || exit 0`** — running
`claude` outside Orchestra is a silent no-op.

Scripts and the Claude Code events they fire on:
- **`orchestra-hook.sh`** (~`workspaces.ts:1901`) — UserPromptSubmit, Stop,
  Notification, PreToolUse, PostToolUse. The **durable activity writer**: appends
  one JSON line per event to `~/.orchestra/events/<wsid>.jsonl`, allocating a
  monotonic `seq` under `flock` on `<wsid>.seq` (2s timeout; falls back to
  `seq=0` without flock). Pure bash (no jq/sed); JSON-escapes the transcript
  path. Line: `{"seq":N,"event":"…","tool":"…","transcript":"…"}`.
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

Also installs 7 **capability skills** as `<worktree>/.claude/skills/<name>/SKILL.md`
(orchestra-spawn / -comms / -repos / -promote / -attach / -rename /
-migrate-account) so the agent discovers them. A SessionStart readiness hook touches `$ORCHESTRA_READY_FILE` so
spawn task-injection knows the TUI is live.

PTY env that makes it all work (set in `pty.ts`): `ORCHESTRA_WS_ID`,
`ORCHESTRA_SOCK`, `ORCHESTRA_EVENTS_DIR`, `ORCHESTRA_WORKTREE`,
`ORCHESTRA_BRANCH`, `ORCHESTRA_BRANCH_AUTO`, `ORCHESTRA_KIND`,
`ORCHESTRA_READY_FILE`; PATH is
prepended with `~/.orchestra/bin` so bare `orchestra` resolves.

## The `orchestra` CLI (src/cli/index.ts, ~349 lines)
Standalone Node HTTP client (no npm deps) that POSTs to the socket. Reads
`$ORCHESTRA_SOCK`/pointer for the socket and `$ORCHESTRA_WS_ID` for self-identity
(sent as `from`). Exit 0 on `{ok:true}`, 1 otherwise (error to stderr).
Subcommands: `peers`, `read <id> [--lines N]`, `message <id> <text…>`, `spawn
--task <text> [--repo <path>] [--base <branch>]`, `rename <id> <branch>`,
`promote <id>`, `attach <id> <parentId>`, `detach <id>`, `add-repo <path>`,
`delete <id> --yes`, `accounts` (list configured accounts), `migrate-account <id>
<accountId|--default>` (migrate a workspace to another login / back to default).
Fully non-interactive (destructive `delete` needs `--yes`).

## CLI shims (cli-shim.ts, ~157 lines)
- **User-facing** — Linux `~/.local/bin/orchestra` (`exec "$APPIMAGE" cli "$@"`),
  Windows `%LOCALAPPDATA%\Orchestra\bin\orchestra.cmd`. Only overwritten if it
  carries the orchestra marker or is absent. macOS skipped (no agreed location).
- **Agent-facing** — `~/.orchestra/bin/orchestra`, re-installed every GUI startup
  (the AppImage mount path changes per run) and prepended to every agent PTY's PATH.

## Tests (orchestra-hook.test.ts, ~121 lines)
Validates `seq` allocation: sequential `[1,2,3,4]` with flock (`[0,0,0,0]`
without); 50 concurrent invocations yield exactly `1..N` (no dupes/gaps);
numbering restarts after `.seq` deletion (mirrors the reader's fresh-run reset).
