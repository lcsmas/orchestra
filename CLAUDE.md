# Orchestra

Electron app for running parallel Claude Code agents in isolated git worktrees —
agents can spawn other agents. Three processes: **main** (`src/main/`, Node
backend), **renderer** (`src/renderer/`, React 19 + Zustand), **preload**
(`src/preload/`); plus a bundled **CLI** (`src/cli/`) and **shared** code
(`src/shared/`, where `types.ts` is the documented domain backbone).

## Codebase map — read this before working on a subsystem

A per-subsystem architecture reference lives in **`docs/codebase-map/`**. Before
editing or debugging a subsystem, open the one doc below that matches your task
and read it — each carries concrete `file:line` anchors and the non-obvious
design decisions, so you get accurate context without grepping the tree first.

| Task touches… | Reference doc |
|---|---|
| Workspace lifecycle, worktrees, spawn/promote/attach, store, setup scripts, secrets | `docs/codebase-map/workspaces.md` |
| Diffs, merge-state, PR/release tracking, branch ops, base sync | `docs/codebase-map/git.md` |
| Local socket, per-worktree hook scripts, the `orchestra` CLI | `docs/codebase-map/hooks-cli-socket.md` |
| Status dot, events spool, PTYs, xterm terminals, logging | `docs/codebase-map/activity-pty-terminal.md` |
| Multi-account login/inheritance, usage bars, Linear badges | `docs/codebase-map/accounts-usage-linear.md` |
| Main bootstrap, IPC, React UI, Zustand store, Sidebar, dialogs, chime | `docs/codebase-map/renderer-ipc-ui.md` |
| Vite/electron-builder build, release pipeline, CI, bundled skills | `docs/codebase-map/build-release.md` |

The map is reference material — verify a `file:line` against live source before
relying on it, since line numbers drift.

### Keep the map current (do this as part of the task)

The map is maintained by convention, not automation — so it's on you. **When a
change adds, removes, or restructures a feature/subsystem, update the matching
`docs/codebase-map/*.md` in the same change** (new function or flow → add it with
its `file:line`; moved/renamed code → fix the anchors; new subsystem → add a doc
and add its row to the routing table above). Treat the doc edit as part of
"done," like a test. For a sweeping change, run `/map-codebase` to regenerate the
whole map instead of hand-editing.

## Build / test / release

- `pnpm run dev` — Vite + Electron with HMR (`ORCHESTRA_HOME=~/.orchestra-dev`).
- `pnpm run build` — `vite build && build:cli && electron-builder`.
- `pnpm run lint` — `eslint src --ext .ts,.tsx`.
- `pnpm run test` — `node --test --experimental-strip-types 'src/**/*.test.ts'`
  (built-in runner; pure logic lives in `src/shared/` so it's testable without Electron).
- Release: the **`ship` skill** drives `scripts/release.sh` (worktree-safe; never
  checks out master). See `reference/build-release.md`.

## Conventions

- End git commit messages with the repo's `Co-Authored-By` trailer.
- Match the surrounding code's style; `src/shared/types.ts` is heavily commented —
  read it to learn the domain model fast.
