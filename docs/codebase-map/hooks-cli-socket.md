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
`installOrchestraHooks(worktreePath)` writes into `<worktree>/.orchestra/` (4
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
- **`rename-instruction.sh`** (~`:1578`) — UserPromptSubmit + SessionStart. Nudges
  the agent to `orchestra rename` while `ORCHESTRA_BRANCH_AUTO=1`; self-disables
  once the branch was renamed (live git check / sentinel).
- **`comms-resurface.sh`** (~`:1844`) — UserPromptSubmit. Queries `/peers`; prints
  the one-line `orchestra-comms` reminder only if peers exist (silent when solo).
- **`inbox-instruction.sh`** (~`:1871`) — SessionStart + UserPromptSubmit. Prints
  and drains `~/.orchestra/inbox/<wsid>.txt` (inter-agent messages).

Also installs 7 **capability skills** as `<worktree>/.claude/skills/<name>/SKILL.md`
(orchestra-spawn / -comms / -repos / -promote / -attach / -rename /
-migrate-account) so the agent discovers them. A SessionStart readiness hook touches `$ORCHESTRA_READY_FILE` so
spawn task-injection knows the TUI is live.

PTY env that makes it all work (set in `pty.ts`): `ORCHESTRA_WS_ID`,
`ORCHESTRA_SOCK`, `ORCHESTRA_EVENTS_DIR`, `ORCHESTRA_WORKTREE`,
`ORCHESTRA_BRANCH`, `ORCHESTRA_BRANCH_AUTO`, `ORCHESTRA_READY_FILE`; PATH is
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
