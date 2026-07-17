# Accounts & usage

Running many agents in parallel makes usage limits a first-class concern. Orchestra treats Claude accounts and their headroom as part of the dashboard.

## Multiple Claude logins

Add extra Claude accounts via the users icon in the sidebar header. Each account is a separate Claude Code login (its own config dir); the login flow opens in an isolated in-app browser window so it never disturbs your default browser session.

- **Pin a workspace to an account** — each workspace runs its agent under a chosen login; the sidebar badge shows which.
- **Migrate mid-conversation** — move an existing workspace to another account (`orchestra migrate-account <id> <accountId>`, or the UI menu). Orchestra stops the agent, relocates the conversation into the target login, and resumes it where it left off — `claude --continue` keeps working.
- **Inheritance** — alternate logins inherit your global `~/.claude` configuration (settings, skills, MCP servers) via symlinks/merges, so every account behaves like *your* Claude.

**Use case:** a personal account and a work account; or two Max accounts so a heavy fan-out doesn't starve your interactive session.

## Usage bars

The bottom of the sidebar shows per-account utilization — the 5-hour window and the weekly window (including model-scoped weekly limits) — hottest account first, with details on hover. You can see a fleet burning through a window *before* it hits the wall, and pin new workspaces to the account with headroom.

## The prompt queue

When a workspace's account is over its limit, prompts you submit don't vanish and don't error: they **park in a queue** (with a banner showing what's queued) and auto-submit in order when the usage window resets. Close the laptop, come back, and the work continued the moment the limit lifted.
