---
status: accepted
date: 2026-10-25
---

# The browser panel is driven through a per-workspace loopback CDP proxy and `agent-browser`, not hand-written tools

Agents drive the embedded panel with 8 hand-written `mcp__browser__*` tools, and mostly avoid it: across all transcripts (counted 2026-10-25) about 150 calls hit the panel against about 1,500 on the human's own Chrome through chrome-devtools MCP, and on the panel `evaluate` stands in for the missing primitives (click by text, wait for a modal, read a token from `localStorage`). We take Orca's shape instead ([research note](../research/orca-linux-cannibalize.md) §2.2): each workspace's panel tabs sit behind a `127.0.0.1` CDP proxy over `webContents.debugger` that fakes the browser-level `Target.*`/`/json` surface, and the bundled `agent-browser` binary (Rust, Apache-2.0, ships linux-arm64) drives it. Agents call it through `orchestra browser <cmd>` from Bash, with the workspace resolved by the host per call (ADR 0008), so "an agent drives only its own panel" holds, and one script can chain several actions instead of one turn per click. The hand-written tools are removed once the replacement passes the same rig. The panel gets real tabs (several `WebContentsView` per workspace, capped at 8) because `agent-browser` and agents work in tabs. Decided with the maintainer in a grilling session (2026-10-25).

## Considered options

- **Add `console` and `network` tools by hand** — rejected: agents almost never call those even where they exist (1 call each on chrome-devtools MCP); the gap is snapshot/click/fill/wait/tabs/upload/dialogs.
- **`chrome-devtools-mcp` against the proxy** — rejected for now: puppeteer discovers pages through `Target.targetCreated`/`tab` targets the single-page fake does not emit (unverified by running it).
- **One MCP tool per command, or one `browser` MCP tool** — rejected: a CLI reaches sub-agents and scripts, and lets an agent batch actions.

## Consequences

- The proxy is the only debugger attacher; design mode moves onto it.
- Electron has no `Target.createTarget`: the proxy maps "new tab" onto the panel's own tab creation.
- An agent driving a non-visible tab hits the no-frames limit of a detached `WebContentsView`, the same one that blocks background workspaces. Until a spike proves a hidden view can paint, an agent action brings its tab to the front.
- An agent may open tabs and close the ones it opened; it never closes the human's.
