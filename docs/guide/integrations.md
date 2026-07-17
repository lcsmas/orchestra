# Integrations & extras

## Linear

Name a branch after a Linear issue (`TEAM-123-anything`, which happens naturally when agents pick branch names from tickets) and the sidebar row grows a live Linear badge — issue title and state, linked to the issue. Configure your Linear API key in settings; it's stored encrypted via the OS keychain.

## Insights & Improvements (self-tune)

Orchestra runs a **monthly self-tune pass** over your Claude Code setup (the sparkle row at the bottom of the sidebar, or "Run now" in its pane):

1. For each configured login, it regenerates Claude Code's insights report (`/insights`).
2. A fold pass distills the fresh findings into durable, one-line lessons in `~/.claude/LESSONS.md` — which is loaded into every future session.

The result: recurring friction (a flag agents always forget, a build quirk, a workflow correction you keep repeating) turns into standing guidance, and your agents get a little better every month. The pane shows run history, live transcripts, per-login reports, and the current LESSONS.md.

This tunes *your Claude Code configuration*. For Orchestra improving its own **code**, see [Self-improvement](self-improvement.md).

## Notification chime

When an agent finishes while the window is unfocused, Orchestra plays a chime — pick from ~20 synthesized sounds (or mute) via the bell icon. A louder sound fires when an agent explicitly needs your attention.

## Per-repo scripts & secrets

Covered in [Workspaces & sessions](workspaces.md#per-repo-scripts): setup / run / archive scripts per repo, plus per-repo agent environment variables with encrypted secret storage.

## In-app help

The **?** button in the sidebar header opens the feature guide — a condensed version of this documentation, always available offline inside the app.
