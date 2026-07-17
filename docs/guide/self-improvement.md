# Self-improvement: Orchestra modifying Orchestra

Orchestra is developed inside Orchestra — and your copy can do the same. The app that runs your agents is itself a repo those agents can work on, and everything about the workflow is built to make that safe and productive.

## The loop

1. **Register Orchestra's own repo** as a spawn target (`orchestra add-repo <path-to-orchestra-clone>` or the Repo button), like any other project.
2. **Spawn an agent on it** with a task: *"add a keyboard shortcut for the diff tab"*, *"make the chime per-repo"*, *"that sidebar glitch when archiving — fix it"*.
3. The agent works in an **isolated worktree** — the running app is a separately installed build, so nothing it edits can break the Orchestra instance currently hosting it.
4. Review the diff like any other workspace; merge or PR it.
5. **Ship**: the repo's `ship` skill drives the release script — rebase, build, release a version, install it locally. Restart Orchestra and you're running the improvement an agent just made at your request.

## Agents know they're self-modifying

An agent spawned on the Orchestra repo gets an automatic session-start notice telling it that this repo **is** the app currently running it, along with the two facts that trip up self-modification:

- **Changes don't take effect until released and installed.** "My change does nothing" usually means "not shipped yet", not "broken".
- **The per-worktree files Orchestra generates are not the source.** The hooks and skills Orchestra installs into each worktree (`.orchestra/*.sh`, `.claude/settings.local.json`, `.claude/skills/orchestra-*`) are rewritten on every spawn — the agent must edit their source in `src/main/workspaces.ts`, never the generated copies. (That includes the self-modification notice itself.)

## Why this works well

- **The codebase map.** `docs/codebase-map/` is a per-subsystem architecture reference with `file:line` anchors, maintained as part of every change — an agent starts from real context instead of grepping cold. The routing table in `CLAUDE.md` sends it to the right doc for the subsystem it's touching.
- **Worktree isolation.** Self-modification sounds risky; a worktree plus a separately installed build makes it exactly as safe as editing any other repo.
- **The app dogfoods its own features.** Diff review, PR flow, spawn, comms — the tools you use to review the agent's change to Orchestra *are* Orchestra.

## What to ask for

Anything. Real examples of the genre:

- UI: new panes, shortcuts, settings, empty-state improvements.
- Agent behavior: the hooks and skills Orchestra installs into worktrees — including the instructions that drive the very agent you're asking.
- Integrations: new badges, new trackers, new endpoints on the local socket.
- Docs: this guide is in the repo too.

Combined with [Insights & Improvements](integrations.md#insights--improvements-self-tune) (which tunes your Claude Code configuration monthly), the whole system — app and agents — is designed to get better the longer you use it.
