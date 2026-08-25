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
| Multi-account login/inheritance, usage bars, usage-limit prompt queue | `docs/codebase-map/accounts-usage.md` |
| Insights & Improvements: monthly self-tune pipeline, Insights sidebar/pane | `docs/codebase-map/self-tune.md` |
| Resources page: live CPU/memory/disk sampling, process trees, token-usage dashboard | `docs/codebase-map/resources.md` |
| Linear issue badges, Linear API key | `docs/codebase-map/linear.md` |
| Main bootstrap, IPC, React UI, Zustand store, Sidebar, dialogs, chime | `docs/codebase-map/renderer-ipc-ui.md` |
| Sandbox/remote agents: wire protocol, shim, Docker image, transports, reconnect, ownership lock, import/eject/backups | `docs/codebase-map/sandbox-transport.md` |
| Vite/electron-builder build, release pipeline, CI, bundled skills | `docs/codebase-map/build-release.md` |
| Structured agent view: SDK-driven agent pane — `agent-sdk.ts` session manager, `AgentEvent` contract, normalize/fold, `agent:event` channel, StructuredView + tool cards / diffs / permission dialog; voice dictation (composer mic, ghost partials, voice-edit) | `docs/codebase-map/structured-agent-view.md` |
| Detached session keeper: structured sessions surviving app quit — keeper daemon, `spawnClaudeCodeProcess` bridge, attach/reattach, linger policy, kill/quit semantics | `docs/codebase-map/session-keeper.md` |
| Structured agent-view design system: the 3 `av-*` CSS layers, tokens, theming, states, a11y contract the SDK-view components render against | `docs/codebase-map/agent-view-design.md` |
| Embedded browser panel: per-workspace `WebContentsView`, user + agent shared surface, `webContents.debugger` driving, `mcp__browser__*` SDK tools, URL bar / pane wiring | `docs/codebase-map/browser-panel.md` |

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
- `npx tsc --noEmit` — the typecheck, and the static gate this repo actually runs.
  (`pnpm run lint` is declared in `package.json` but eslint is not a dependency, so
  it exits `eslint: command not found` — use the typecheck instead.)
- `pnpm run test` — `node --test --experimental-strip-types 'src/**/*.test.ts'`
  (built-in runner; pure logic lives in `src/shared/` so it's testable without Electron).
  A `pretest` hook runs `build:cli` first, because the 12 `src/cli/*` tests
  SELF-SKIP when `dist-electron/cli.js` is absent — without it the suite reports
  a green `1039 pass / 12 skipped` that looks complete and silently omits every
  CLI regression test. **Cite the PASS count, and check `# skipped` is 0**: a
  partial green is the failure mode this hook exists to prevent.
- Release: the **`ship` skill** drives `scripts/release.sh` (worktree-safe; never
  checks out master). See `docs/codebase-map/build-release.md`.

## Conventions

- End git commit messages with the repo's `Co-Authored-By` trailer.
- Match the surrounding code's style; `src/shared/types.ts` is heavily commented —
  read it to learn the domain model fast.

## Agent skills

### Issue tracker

Issues live in this repo's GitHub Issues (`lcsmas/orchestra`, via the `gh` CLI). See `docs/agents/issue-tracker.md`.

### Triage labels

The five default labels (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `CONTEXT.md` at the repo root (created lazily) + `docs/adr/`. See `docs/agents/domain.md`.
