# Getting started

## Install

**Linux:** download `Orchestra.AppImage` from the [releases page](https://github.com/lcsmas/orchestra/releases), `chmod +x` it, run it (FUSE required; otherwise `--appimage-extract-and-run`).

**macOS / Windows / ARM64:** build from source — see the [README](../../README.md#build-from-source).

You'll also want the [`claude`](https://docs.anthropic.com/claude-code) CLI (logged in) and [`gh`](https://cli.github.com/) (authenticated) on your `PATH` — Orchestra drives both.

## First launch

An empty Orchestra shows the welcome screen with three entry points, mirrored by the buttons in the sidebar header:

- **+ New workspace** (`Repo`) — register a git repo, then create workspaces off it. This is the main path.
- **⚡ Scratch session** — a throwaway agent with no repo and no git. Perfect for quick questions, experiments, or as a future [orchestrator](multi-agent.md#orchestrators).
- **🌿 Orchestrator** — a coordinator agent that delegates work to child agents instead of coding itself.

The **?** button in the sidebar header opens the in-app feature guide any time.

## Your first workspace

1. Click **Repo** and pick a local git repository. It appears as a section in the sidebar with a **+** button.
2. Click **+** on the repo section. Orchestra cuts a new branch off the repo's base branch, creates a worktree for it under `~/.orchestra/worktrees/`, and starts a Claude Code agent there.
3. Type your task into the agent's terminal. The branch starts with an auto-generated name; the agent renames it to something meaningful once it understands the work ([self-naming branches](workspaces.md#branch-naming)).
4. Watch the status dot: blue while the agent works, orange when it's waiting for you.
5. Open the **Diff** tab to review the change as it grows — it refreshes live.
6. Happy? Click the PR button: Orchestra commits, pushes, and opens a `gh pr create` PR against the base branch. The sidebar tracks the PR from then on.
7. Done with the workspace? **Archive** it — worktree and branch are removed together (recoverable via unarchive until you delete).

## Where things live

- Config + workspace list: `<userData>/orchestra/store.json`
- Worktrees: `~/.orchestra/worktrees/<repo>-<branch>-<uid>/`
- Per-workspace setup log: `<worktree>/.orchestra/setup.log`

## If a repo needs setup

Most real repos need `npm install` or similar before an agent can build. Configure per-repo **setup / run / archive scripts** via the gear icon on the repo header — setup runs automatically when each workspace is created (with a progress banner), run powers the [Run tab](workspaces.md#terminals), archive runs at cleanup. See [Workspaces & sessions](workspaces.md#per-repo-scripts).

## Next steps

- Spawn several workspaces at once and work them in parallel — that's the point.
- Let an agent do the fan-out for you: [Multi-agent orchestration](multi-agent.md).
- Running out of usage on one account? [Add another login](accounts-and-usage.md).
