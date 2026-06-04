# Orchestra

> **Run N coding agents in parallel, each in its own git worktree, watched from one dashboard.**

Spawn a swarm of Claude Code or Codex agents, give each its own branch in an isolated git worktree, and review their work side-by-side in a diff-first UI. No more agents clobbering each other's files, no more juggling `git stash` while you switch contexts.

[![License: Apache 2.0](https://img.shields.io/badge/license-Apache_2.0-blue.svg)](LICENSE)
![Platform](https://img.shields.io/badge/platform-linux%20%7C%20macOS%20%7C%20windows-lightgrey)
![Electron](https://img.shields.io/badge/electron-33-47848F?logo=electron&logoColor=white)

![Orchestra dashboard with three parallel workspaces in the sidebar and a live agent terminal](docs/screenshot.png)

## Why Orchestra

Running multiple coding agents at once usually means N terminal windows, N branches, and N opportunities for them to step on each other's working tree. Orchestra gives each agent a real git worktree (separate directory, separate `HEAD`, same shared `.git`), so they can edit, commit, and run scripts in parallel without conflict. Then it puts the live terminal, the cumulative diff, and a one-click "commit → push → open PR" flow behind a single dashboard.

## Features

- **Parallel worktrees** — each workspace is its own `git worktree`; no working-tree collisions
- **Live terminals** — real TTY per agent via `node-pty`, full color, resize, scrollback
- **Diff-first review** — Monaco side-by-side diff per workspace, refreshes while the agent works
- **One-click PR** — commit → `git push -u` → `gh pr create`, all from the dashboard
- **Activity tracking** — status flips running ↔ waiting from Claude Code's own `UserPromptSubmit` / `Stop` hooks (no polling, no PTY scraping)
- **Agent-driven branch rename** — the agent picks a kebab-case branch name once it understands the work, via a one-time `SessionStart` instruction
- **Per-repo setup scripts** — bootstrap dependencies, copy `.env` files, install hooks per workspace
- **Clean archive** — archiving removes the worktree *and* the branch in one step

## Install

### Linux (AppImage)

Download the latest `Orchestra.AppImage` from the [releases page](https://github.com/lcsmas/orchestra/releases), then:

```bash
chmod +x Orchestra.AppImage
./Orchestra.AppImage
```

### macOS / Windows

Pre-built binaries aren't published yet — [build from source](#build-from-source) below. Contributions to the release pipeline welcome.

## Build from source

Requires Node 20+, plus the [`claude`](https://docs.anthropic.com/claude-code) CLI (and/or [`codex`](https://github.com/openai/codex)) and [`gh`](https://cli.github.com/) on `PATH`. On Linux you'll also need standard build tools for the `node-pty` native module (`build-essential` on Debian/Ubuntu, `gcc-c++ make` on Fedora).

```bash
git clone https://github.com/lcsmas/orchestra.git
cd orchestra
npm install
npx electron-rebuild   # rebuild node-pty for Electron's node ABI
npm run dev            # vite + electron, hot reload
```

To produce a distributable:

```bash
npm run build          # outputs to release/
```

## How it works

- **Worktrees** — each workspace gets `~/.orchestra/worktrees/<repo>-<branch>-<uid>/`, created with `git worktree add`. The branch is created off the configured base branch. Archiving removes the worktree with `git worktree remove --force` and deletes the branch.
- **Agents** — spawned via `node-pty` in the worktree directory. stdin/stdout wired to an xterm.js instance in the renderer via Electron IPC.
- **Diffs** — every 4s, Orchestra builds a `DiffFile[]` by combining `git diff --numstat` (committed + working) and `ls-files --others` (untracked), then renders contents in Monaco's `DiffEditor`.
- **PRs** — `commit → push -u origin <branch> → gh pr create --base <baseBranch>`.
- **Hooks** — Orchestra installs `UserPromptSubmit`, `Stop`, and `SessionStart` hooks into each worktree's `.claude/settings.local.json`. They `POST` to a Unix-socket HTTP server in the main process so the UI knows when an agent starts working, finishes a turn, or should be asked to rename its branch. All hook commands are env-guarded (`[ -n "$ORCHESTRA_SOCK" ] || true`) so running `claude` outside Orchestra is a silent no-op.

## Layout

```
src/
  main/         Electron main process (git, pty, IPC, store, hooks-server)
  preload/      contextBridge → window.orchestra
  renderer/     React UI (sidebar, terminal, diff, modals)
  shared/       Types and IPC surface shared between main + renderer
```

## Storage

- Config + workspace list: `<userData>/orchestra/store.json`
- Worktrees: `~/.orchestra/worktrees/`
- Per-workspace setup logs: `<worktreePath>/.orchestra/setup.log`

## Contributing

Issues and PRs welcome. For non-trivial changes, please open an issue first to discuss the approach.

## License

Apache License 2.0 — see [LICENSE](LICENSE).
