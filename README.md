# Orchestra

Run parallel Claude Code / Codex agents in isolated git worktrees, with a visual dashboard and a diff-first review UI. Cross-platform Electron app (Linux / macOS / Windows).

## Features

- Spawn N agents in parallel, each in its own git worktree (no conflicts, no stepping on each other)
- Live terminal pane per agent (real TTY via `node-pty`, full color/resize)
- Monaco side-by-side diff viewer per workspace (auto-refreshes while agent works)
- One-click commit → push → `gh pr create`
- Open worktree in VS Code / Cursor
- Archive cleans up the worktree AND the branch

## Requirements

- Node 20+
- `claude` CLI (Claude Code) on PATH, and/or `codex` CLI
- `gh` CLI authenticated (for the PR button)
- Linux needs standard build tools for `node-pty` native module

## Dev

```bash
npm install
npx electron-rebuild   # rebuild node-pty for Electron's node ABI
npm run dev            # vite + electron, hot reload
```

## Build distributable

```bash
npm run build          # outputs to release/
```

## How it works

- **Worktrees**: each workspace gets `~/.orchestra/worktrees/<repo>-<branch>-<uid>/`, created with `git worktree add`. The branch is created off the base branch. Archiving removes the worktree with `git worktree remove --force`.
- **Agents**: spawned via `node-pty` in the worktree directory. stdin/stdout wired to an xterm.js instance in the renderer via IPC.
- **Diffs**: on each poll (4s) we build a `DiffFile[]` by combining `git diff --numstat` (committed + working) + `ls-files --others` (untracked), and render contents in Monaco's `DiffEditor`.
- **PRs**: `commit → push -u origin <branch> → gh pr create --base <baseBranch>`.

## Layout

```
src/
  main/         Electron main process (git, pty, IPC, store)
  preload/      contextBridge → window.orchestra
  renderer/    React UI (sidebar, terminal, diff, modals)
  shared/       Types and IPC surface shared between main + renderer
```

## Storage

- Config + workspace list: `<userData>/orchestra/store.json`
- Worktrees: `~/.orchestra/worktrees/`
