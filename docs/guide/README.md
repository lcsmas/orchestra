# Orchestra user guide

Orchestra runs parallel Claude Code agents in isolated git worktrees — each on its own branch, all visible from one dashboard. This guide covers every feature and the use cases behind them. (The same tour, condensed, lives inside the app behind the **?** button in the sidebar.)

| Page | What it covers |
|---|---|
| [Getting started](getting-started.md) | Install, register a repo, first workspace, first PR |
| [Workspaces & sessions](workspaces.md) | Worktree workspaces, scratch sessions, orchestrators, lifecycle, terminals, status |
| [Multi-agent orchestration](multi-agent.md) | Agents spawning agents, peer comms, orchestrator fleets |
| [Review & ship](review-and-ship.md) | Diff review, one-click PR, merge & release tracking, base sync |
| [Accounts & usage](accounts-and-usage.md) | Multiple Claude logins, usage bars, the prompt queue |
| [Remote sandbox agents](sandbox.md) | Agents that keep working in Docker with the laptop closed |
| [Integrations & extras](integrations.md) | Linear badges, Insights & Improvements self-tune, chime, scripts |
| [CLI reference](cli.md) | The `orchestra` command, for humans and for agents |
| [Self-improvement](self-improvement.md) | Orchestra modifying Orchestra: the app as its own best project |

## The elevator pitch

The unit of work in Orchestra is a **workspace**: a git branch, checked out in its own worktree, with a live Claude Code agent working in it. Because every workspace has its own directory and its own `HEAD`, agents never trip over each other — you can have five features and two bug fixes in flight on the same repo at once, watch each agent's terminal live, review each branch's diff side by side, and turn any of them into a PR with one click.

Two ideas set Orchestra apart:

1. **Agents spawn agents.** Every agent knows it can delegate a self-contained task to a brand-new sibling workspace. Ask one agent to "parallelize this refactor across the four services" and the sidebar fills with worktrees, each with its own agent already working.
2. **Orchestra can improve itself.** Register Orchestra's own repo, and agents you point at it know they're modifying the app that runs them — and can release and install the result. See [Self-improvement](self-improvement.md).
