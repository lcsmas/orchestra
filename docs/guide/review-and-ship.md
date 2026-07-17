# Review & ship

Orchestra is diff-first: the point of parallel agents is that *you* stay in the reviewer's seat.

## Diff review

The **Diff** tab shows a side-by-side Monaco diff of the workspace against its base, refreshing every few seconds while the agent works. You don't wait for "done" to start reviewing — watch the change take shape, and steer the agent in the terminal when it drifts. Every sidebar row shows live +/− line counts so you can see at a glance which workspaces have real work in them.

## One-click PR

The PR button in the toolbar runs the whole chain: commit → `push -u origin <branch>` → `gh pr create --base <baseBranch>`. From then on the sidebar row carries a PR badge tracking the PR's state (open / merged / closed), linked to GitHub.

## Merge & release tracking

Sidebar pills answer "where is this branch in its life?" without you asking git:

- **Merged** — the branch's work is in the base (detected via several proof-of-merge signals, so squash merges count).
- **Diverged / unpushed** — local work that never made it up, or a branch that split from its remote.
- **Release pill** — the earliest release tag that contains the branch's commits, so you know when a change actually shipped.

Merges themselves are delegated to the agent's terminal — Orchestra asks the agent to perform the merge in its own PTY, so conflicts land in front of an agent that can resolve them, not in a background job.

## Base sync

Orchestra tracks each repo's base branch against `origin`: behind/ahead counts refresh when the window regains focus. Stale bases are the silent killer of long-lived worktrees — the counts make them visible so agents rebase before the drift compounds.

## Suggested flow

1. Spawn workspaces per task; let agents work.
2. Review diffs as they grow; steer in the terminal.
3. PR the winners; archive the rest (worktree + branch removed in one step).
4. Watch merge and release pills to confirm work actually landed and shipped.
