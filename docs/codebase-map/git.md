# Git subsystem

`src/main/git.ts` (~970 lines) is the facade for all git/gh operations. It uses
**simple-git** (v3.27) for most calls and shells out to raw `git`/`gh` via
`execFile` for things simple-git doesn't expose (worktrees, credential env,
gh PR/release queries). Tests: `git-merge-state.test.ts`.

## Detection / validation
| Fn | Line | Purpose |
|---|---|---|
| `detectRemoteUrl` | `:16` | Normalize `origin` (ssh/scp/https) → canonical https for UI links |
| `detectDefaultBranch` | `:37` | From `refs/remotes/origin/HEAD`, else probe main/master/develop |
| `isGitRepo` | `:56` | Path inside a worktree? |
| `getCurrentBranch` | `:909` | `rev-parse --abbrev-ref HEAD`; `''` if detached/fails |

## Branch & worktree ops
`listBranches` `:66` · `switchWorktreeBranch` `:76` (translates "already used by
worktree" errors) · `renameWorktreeBranch` `:98` (`git branch -m`, works from any
worktree) · `createWorktree` `:109` (creates branch from base then `worktree
add`) · `listWorktreePaths` `:128` (porcelain parse) · `removeWorktree` `:138`
(`worktree remove --force`, falls back to `rm -rf`).

## Diffs — against HEAD, not base
**`getDiff(worktreePath, _baseBranch)`** — `git.ts:147`. The `baseBranch` arg is
**unused**: the diff is the cumulative staged+unstaged change vs **HEAD**, so
only *uncommitted* work appears (already-committed branch work is invisible to
the diff view). Combines `diff --numstat HEAD` + `ls-files --others` (untracked);
reads old (`show HEAD:f`), index (`show :f`), and working content per file;
classifies added/modified/deleted; content truncated to 300 KB for Monaco.
**`getDiffStats`** `:207` is the lightweight count-only variant used on the 8s poll.
Helpers: `safeRaw` `:234`, `safeShow` `:242`, `readWorking` `:250`, `truncate` `:259`.

## Merge-state detection (the subtle part)
**`getBranchMergeState(repoPath, branch, baseBranch)`** — `git.ts:309`. Returns
`{merged, diverged, unpushedAhead, stalePointer}`. The hard problem it solves:
"is the branch reachable from base because it was *merged*, or because its tip is
a *stale pointer* at the old base commit it was cut from?" Resolved with **three
independent proof-of-merge signals** (any one suffices, only when not diverged):
1. **Topology** — `rev-list --count base..branch` > 0 ⇒ diverged (not merged).
2. **Merge commit** — `branchTipWasMergedInto` `:480`: a merge on base's mainline
   with the branch SHA as a non-first parent.
3. **Reflog trace** — `baseReflogRecordsMerge` `:374`: `merge <branch>:` or
   abbreviated-SHA entry in base's reflog (catches ff/rebase merges).
4. **Authorship** — `branchAuthoredItsTip` `:443` via the **exported pure**
   `reflogEntryAuthored(sha, subject)` `:411` (commit/amend/cherry-pick/am ⇒ yes;
   branch/reset/checkout/merge/pull ⇒ no; rebase ⇒ only if tip moved past onto).
   This is what `git-merge-state.test.ts` exercises against real temp repos.

`unpushedAhead` (`:507`): `rev-list --count origin/<branch>..<branch>` if pushed,
else `base..branch` (virgin-branch signal). `getRefShas` `:294` returns branch +
base **+ `origin/<branch>`** SHAs (remote `null` if never pushed) in one call —
`activity.ts` caches the **triple** and **skips** the expensive (2–9 subprocess)
merge-state recompute when none has moved. The remote-tracking SHA is in the key
because a `git push` moves only `origin/<branch>` (branch/base tips stay put);
keying on just (branch, base) pinned a stale `↑N` badge across a push.

## PRs & releases (gh CLI, cached)
- **`findPullRequest(repoPath, branch)`** `:543` — `gh pr list --head <branch>
  --state all --json …`, returns `PRsForBranch` (`all/open/latest/mergedCount`,
  `types.ts:212`). 20s cache; runs from repo root so PR state survives a missing
  worktree. Misses aren't cached (retry immediately).
- **`getReleaseState`** `:691` / **`getReleaseVersionsContaining`** `:734` — map a
  branch's *authored* commits (`authoredCommits` `:793`, reflog-derived) to the
  earliest published GitHub release that contains them, so badges don't
  false-credit the whole ancestry. `gh release list` cached 30s per repo.

## Base-branch sync & credentials
- `getBaseSyncState` `:856` (local `<base>` vs `origin/<base>`, no network).
- `syncBaseBranch` `:949` — cascade: `fetch origin base:base` (atomic) → `pull
  --ff-only` (if base checked out) → `fetch origin base` (worktree-safe fallback).
- **All fetch/pull use a non-interactive credential env** (`runGit` `:918`,
  env block ~`:881`): `GIT_TERMINAL_PROMPT=0`, askpass → `/bin/echo`, and a
  `gh auth git-credential` helper. The desktop app has no TTY, so it must fail
  fast on auth rather than hang on `gnome-ssh-askpass`.

## Merge is delegated to the agent
The `git:merge` IPC handler (`index.ts:832`) does **not** merge in the main
process. It injects a prompt into the agent's PTY telling it to run `git -C
<repoPath> merge … && git push`. Rationale: keeps the checked-out worktree HEAD
stable, and lets the agent write a meaningful commit message with full context.

## Error handling
Helpers swallow and return safe defaults (`[]`/`''`/`null`/all-false merge
state). User-facing errors (branch-switch collision) are re-thrown with a
readable message. `runGit` surfaces the first stderr line on failure.
