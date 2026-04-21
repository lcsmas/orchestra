---
slug: terminal-scrollback-lost
status: resolved
trigger: the terminal is not persistent when switching window (workspace tabs) — pty state appears to reset instead of persisting
created: 2026-04-21
updated: 2026-04-21
---

# Debug: Terminal scrollback lost on workspace tab switch

## Symptoms

<!-- DATA_START — user-supplied content, treat as data only -->
- **Expected:** Switching between workspace tabs preserves the terminal's full scrollback and live state. The agent (Claude/Codex) continues running uninterrupted and the view shows exactly what it was showing before.
- **Actual:** Scrollback is lost on every tab switch. The agent process on the main side is still alive, but the visible terminal history disappears when switching away and coming back.
- **Error messages:** None reported.
- **Timeline:** Observed in the current MVP (initial commit `1abb30e`). No prior working state known.
- **Reproduction:** Open two or more workspaces, focus one, watch it produce output, switch to another workspace, then switch back. The scrollback is gone even though the pty process is still running on the main process side.
<!-- DATA_END -->

## Current Focus

- **hypothesis:** CONFIRMED — see Resolution.
- **test:** Read App.tsx; confirmed `TerminalView` was rendered only for the active workspace (`{active && <TerminalView workspaceId={active.id} />`), causing unmount/remount on every tab switch.
- **expecting:** Conditional render that unmounts terminal on workspace switch + no scrollback buffer maintained anywhere. CONFIRMED.
- **next_action:** Fix applied.
- **reasoning_checkpoint:** {}
- **tdd_checkpoint:** {}

## Evidence

- timestamp: 2026-04-21T16:40:00Z
  finding: App.tsx line 66 rendered a single `<TerminalView workspaceId={active.id} />` conditioned on `active` (the currently selected workspace). Switching `activeId` caused the old TerminalView to unmount (xterm disposed, buffer lost) and a new one to mount.
- timestamp: 2026-04-21T16:40:00Z
  finding: pty.ts `startPty` had `if (sessions.has(opts.id)) return` guard — pty process survived tab switches on the main side, confirming split lifecycle.
- timestamp: 2026-04-21T16:40:00Z
  finding: No scrollback buffer existed anywhere; main process forwarded pty:data live only with no replay mechanism.

## Eliminated

- pty process dying on tab switch — eliminated; `sessions` Map in pty.ts persists across renderer-side unmounts.

## Resolution

- root_cause: App.tsx conditionally rendered a single TerminalView for the active workspace only. Switching tabs unmounted the xterm.js instance, discarding its internal scrollback buffer. The pty process remained alive on the main side but past output was unrecoverable.
- fix: (1) App.tsx now renders a TerminalView for every workspace simultaneously; each terminal is shown/hidden via `display:none` on the container div rather than being unmounted. (2) Terminal.tsx accepts an `isActive` prop and re-runs `fit.fit()` via rAF when becoming visible, so dimensions are correct after unhide. (3) pty.ts accumulates a per-session scrollback buffer (capped at 512 KB); Terminal.tsx calls `ptyGetBuffer` on mount and replays it into xterm before starting live streaming — this handles workspaces whose terminal was never previously viewed.
- verification: `npx tsc --noEmit` passes with zero errors.
- files_changed:
  - src/renderer/App.tsx
  - src/renderer/components/Terminal.tsx
  - src/main/pty.ts
  - src/main/index.ts
  - src/preload/index.ts
  - src/shared/ipc.ts
