# Workspaces & sessions

Orchestra has three kinds of session, all showing up as rows in the sidebar with a live agent behind them.

## Worktree workspaces

The standard unit: a **branch + isolated git worktree + Claude Code agent**. The worktree is a real `git worktree` — own directory, own `HEAD`, shared `.git` — so any number of workspaces on the same repo coexist without conflicts. Use one workspace per task: a feature, a bug fix, an experiment.

**Lifecycle:**

- **Create** — the **+** button on a repo section (or an agent [spawns](multi-agent.md) one). Branch is cut from the repo's base branch; the setup script (if configured) runs first, with a progress banner.
- **Archive** — one step removes the worktree and deletes the branch. Archived workspaces stay listed in a collapsed section; **unarchive** re-creates the worktree from the branch point.
- **Delete** — permanently removes an archived workspace (bulk delete supported).
- **Resume on restart** — workspaces that were running when Orchestra quit come back automatically with `claude --continue`. A very large session triggers a heavy-resume gate so you consciously drive Claude Code's compaction menu instead of silently burning usage.
- **Switch branch** — the branch chip in the toolbar lets you point an existing worktree at a different branch.

### Branch naming

New branches get an auto-generated placeholder name (e.g. `crimson-meadow`). The agent is nudged — at session start and again once the task sharpens — to rename the branch itself via `orchestra rename`, in two stages: an early provisional name, then a refined one. Rename it manually in the sidebar any time; a manual rename turns the auto-nudge off.

## Scratch sessions

**⚡ Scratch** starts an agent in a throwaway directory — no repo, no git, no setup. Use it for quick questions, one-off scripts, or anything that doesn't belong in a project. A scratch session can later be [promoted to an orchestrator](multi-agent.md#orchestrators).

## Orchestrators

**🌿 Orchestrator** sessions coordinate instead of code: they spawn child agents for the actual work, and every workspace they spawn nests beneath them in the sidebar. See [Multi-agent orchestration](multi-agent.md#orchestrators) for the full story.

## Terminals

Each workspace has up to three panes:

- **Terminal** — the agent's real TTY (xterm.js): full color, resize, scrollback, image paste.
- **Run** — a second, independent PTY that runs the repo's configured **run script** (dev server, test watcher) with Start/Stop. The tab is always visible so the affordance is discoverable; without a script it points you at the gear icon.
- **Nvim** — a file-pane toggle splits the main pane with Neovim opened on the worktree, for when you want to poke at files yourself.

## Status at a glance

- **Status dots** — idle / running / waiting / error per workspace, driven by Claude Code's own lifecycle hooks writing to a local event spool. No polling, no terminal scraping: the dot flips the moment the agent starts or stops working, and an ephemeral label shows which tool it's currently running.
- **Context badge** — the agent's current context size in tokens, computed from its transcript, so you can see a session approaching compaction.
- **Diff counts** — +/− line counts per row, refreshed while agents work.
- **Chime** — when an agent finishes while the window is unfocused, Orchestra plays a notification sound (~20 synthesized options; bell icon in the sidebar header to pick, or mute).

## Per-repo scripts

The gear icon on a repo header configures three scripts:

- **setup** — runs on workspace creation (install dependencies, copy `.env`, …). Output goes to a banner and `<worktree>/.orchestra/setup.log`.
- **run** — what the Run tab starts (dev server, tests).
- **archive** — runs before a workspace is torn down (stop containers, release ports, …).

Repos can also carry per-repo agent environment variables and secrets (stored encrypted via the OS keychain).

## Under the hood (worth knowing)

Orchestra installs Claude Code hooks and `orchestra-*` skills into each worktree's `.claude/` and `.orchestra/` directories. That's how status tracking, branch-rename nudges, spawn/comms capabilities, and inter-agent messaging work. Everything is env-guarded: running `claude` in the same directory outside Orchestra is a silent no-op, and the generated files are rewritten on each spawn (don't edit them in place — they're listed in `.orchestra/.gitignore` and never committed).
