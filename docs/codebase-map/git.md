# Git subsystem

`src/main/git.ts` (~970 lines) is the facade for all git/gh operations. It uses
**simple-git** (v3.27) for most calls and shells out to raw `git`/`gh` via
`execFile` for things simple-git doesn't expose (worktrees, credential env,
gh CI queries). Tests: `git-merge-state.test.ts`.

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
**`getDiffStats`** `:237` is the lightweight count-only variant used on the 8s poll.
Helpers: `safeRaw` `:264`, `safeShow` `:272`, `readWorking` `:280`, `truncate` `:442`.

### Review-pane diffs (raw patch text, two scopes)

`getDiff` above returns per-file *content pairs*; the Diff review pane instead
consumes raw unified-diff TEXT, because it renders hunks and git has already
computed them (see `src/shared/diff-hunks.ts` for the parser/patch-rebuilder).

**`getRawDiff(worktreePath)`** — `git.ts:305`. Uncommitted scope: `diff -M HEAD`
plus untracked files folded in via `diff --no-index /dev/null <file>` — `git add
-N` would mutate the index, and without this a brand-new file (the most common
thing an agent produces) is invisible. The `--no-index` output is used VERBATIM:
it already matches the tracked-addition stanza, and an earlier "normalizing"
regex pass duplicated `new file mode` and clobbered `index`, corrupting the
patch. `--no-index` exits 1 when files differ, which is the success path here.

**`getBranchDiff(worktreePath, baseBranch, branch)`** — `git.ts:359`. vs-base
scope: the **three-dot** committed diff `merge-base(base, branch)..branch`.
Two-dot would misattribute base progress since the cut as branch regressions
(measured: it reports a base-only file as a branch *deletion*). Falls back
`base` → `origin/base`, and returns `''` on an unresolvable base rather than
silently degrading to two-dot.

**`applyPatchToIndex(worktreePath, patch, reverse)`** — `git.ts:397`. Selective
staging: `git apply --cached [--reverse]` with the rebuilt patch on stdin.
Rethrows git's own stderr, because "does not exist in index" / "corrupt patch"
is precisely the signal that the tree moved under an open review.
**`unstagePaths`** `:427` (`reset -q --`) and **`stagePaths`** `:436` (`add --`)
handle whole files, for binaries and pure renames that carry no selectable hunks.

Measured against real git while building these (worth knowing before changing
the patch rebuilder): hunk **line counts** are strictly validated (`corrupt
patch`, rc 128), while new-side **start offsets** are ignored — `git apply`
matches on old-side context, so a deliberately absurd `+9999` still applies.

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

## CI checks (gh CLI, cached)

No PR or release tracking: the PR lookup (`orchestra link --pr`, `findPR`), the
release-pill detection (`gh api …/releases`) and their sidebar/toolbar badges
were removed on 2026-10-26 as UI clutter. CI is the only `gh` poll left.
**REST, not GraphQL**: a per-branch `gh pr list` (GraphQL, own 5k/hr budget)
once drained that budget in ~27 min; every polled `gh` call stays on REST.

- **`findBranchChecks(repoPath, branch)`** — CI (GitHub Actions) verdict per
  branch, repo-wide + cached: ONE REST
  `actions/runs?per_page=100` page per repo per 60s TTL (deliberately NOT
  `--paginate` — the newest page IS the freshness window; a branch whose last
  run fell off shows no badge). Reduction to per-branch state lives in the pure
  `shared/ci-state.ts` (`branchChecksFromRuns`): only runs on the branch's
  newest head sha count, siblings aggregate (fail > running > pass),
  cancelled/skipped → none. Failures aren't cached EXCEPT `HTTP 404`
  ("Actions disabled"), which is stable and cached to stop per-TTL retries.
  Renderer polls `git:findChecks` per workspace (30s, `refreshAllChecks`);
  the Sidebar renders a red `.ci-badge` ONLY on `fail`, whose click →
  `git:fixChecks` hands the failing run (`gh run view <id> --log-failed`) to
  the workspace's agent via `wakeAgentWithPrompt` (the live SDK session, or a wake) — and,
  when the SDK session cannot start (#227/#232: there is no PTY to type into), throwing
  `AGENT_WAKE_FAILED` instead of answering "requested".

## Base-branch sync & credentials
- `getBaseSyncState` `:856` (local `<base>` vs `origin/<base>`, no network).
- `syncBaseBranch` `:949` — cascade: `fetch origin base:base` (atomic) → `pull
  --ff-only` (if base checked out) → `fetch origin base` (worktree-safe fallback).
- **All fetch/pull use a non-interactive credential env** (`runGit` `:918`,
  env block ~`:881`): `GIT_TERMINAL_PROMPT=0`, askpass → `/bin/echo`, and a
  `gh auth git-credential` helper. The desktop app has no TTY, so it must fail
  fast on auth rather than hang on `gnome-ssh-askpass`.

## No merge / open-PR handler
Merging and PR creation are the agent's job, done from its own prompt — there is
no `git:merge` IPC channel, no `mergeWorktree` preload wrapper, and no toolbar
"Open PR" button (removed in #229; both only typed a prompt into the agent PTY).
The toolbar's `PR #N` link button was removed with PR tracking (2026-10-26).

## Error handling
Helpers swallow and return safe defaults (`[]`/`''`/`null`/all-false merge
state). User-facing errors (branch-switch collision) are re-thrown with a
readable message. `runGit` surfaces the first stderr line on failure.
