---
status: accepted
date: 2026-09-30
---

# Remove the Raw (PTY) agent view; the Agent view is the only way to drive an agent

[ADR 0001](0001-sdk-structured-agent-view.md) made the SDK-driven view the default and demoted the embedded `claude` TUI to a "Raw" fallback tab, keeping "keep embedding the terminal" as the way back. Nobody uses Raw, and the fallback keeps a second launch path alive per agent. We remove the Raw tab, the "Default agent view" setting and every agent-launching PTY path. Terminals survive only for the Run script, nvim and account login. This supersedes ADR 0001's fallback clause. Decided with the maintainer in a grilling session on [#219](https://github.com/lcsmas/orchestra/issues/219).

## Consequences

- The escape hatch is closed. No launch fallback: if the SDK session cannot start, spawn returns not-ok (workspace kept, stopped, error shown in the Agent view); wake / fix-checks / send-review fail loudly.
- Sandbox agents are paused, not deleted. They are PTY-only and nothing shows the SDK path reaching the container. Shim/transport/manager code and tests stay; starting a sandbox agent fails with an explicit message. A follow-up ticket ([#220](https://github.com/lcsmas/orchestra/issues/220)) reconciles them; the old launcher is recoverable from git history.
- Lost with the TUI: in-app re-login of the default `~/.claude` account (use `claude /login`; configured accounts keep the login modal), TUI-only slash commands, the heavy-resume menu guard.
- Deleted as no-ops without a PTY: the "Open PR" button and the merge handler.
- Unchanged, known: `orchestra read` reads the PTY log and is already empty for Agent-view workspaces.
- Glossary drift: `CONTEXT.md` says "Agent view"; code identifiers keep `StructuredView` / `'structured'`.
- Legacy workspaces (has input, no SDK session id) restart through the SDK wake path, which adopts the terminal transcript — and so does the composer's first send; no data migration.
- A `terminal` value left in `localStorage` by the removed "Default agent view" setting (`orchestra:defaultAgentView`) is never read: the workspace opens on the Agent view and nothing cleans the key up.
