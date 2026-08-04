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

## PRs & releases (gh CLI, cached)

**PRs are agent-reported ONLY — there is no branch-name derivation.** The badge
reads `ws.linkedPrs` (`PrLink[]`, each `{url, owner, repo, number}`), written
solely by `orchestra link --pr` (see
[hooks-cli-socket.md](hooks-cli-socket.md)). The head-ref match it replaced was
exact string equality, so it silently lost the PR whenever the branch was
renamed — and Orchestra *nudges* every agent to rename its branch, often after
the PR already exists, so the feature broke its own detection.

**A list, because one workspace owns several PRs.** A metarepo branch spans
submodules that live in *separate GitHub repos*; each `PrLink` is polled by its
own `owner`/`repo`, so a workspace's PRs are no longer confined to its
`repoPath` — which the repo-wide fetch, rooted at one path, structurally could
not do. The link supplies only **which** PRs; live open/merged/closed state is
re-read every poll, so a badge cannot go stale on an idle workspace whose agent
never runs again.
- **`findPullRequest(linkedPrs?)`** — one **REST** `gh api
  repos/{owner}/{repo}/pulls/{number}` call **per linked PR**, with **no `cwd`**
  (the URL carries the coordinates, so no checkout is involved), returning the
  same `PRsForBranch` shape (`all/open/latest/mergedCount`). 60s cache + in-flight
  dedup keyed by **`prLinkKey`** (`owner/repo#number`, case-insensitive as GitHub
  is), so several workspaces linking one PR collapse into a single request.
  Failures are per-PR: a partial failure keeps the PRs that resolved, and only an
  all-failed result carries `error`. Unlinked → `EMPTY_PRS`, for every workspace
  kind (which is why `findPR` no longer needs its `kind === 'scratch'` guard;
  release detection, which *does* need the local repo, is gated on `repoPath`).
- **`findPullRequestsByBranch(repoPath, branch)`** — the RETIRED derivation, kept
  for exactly one caller: the one-shot backfill (`link-backfill.ts`) that seeds
  `linkedPrs` for workspaces predating agent-reported links. Not on the badge
  path. It keeps the repo-wide `gh api
  repos/{owner}/{repo}/pulls?state=all --paginate` fetch indexed by head branch
  (`fetchRepoPRs`), 60s cache keyed by **repo** + in-flight dedup, because the
  backfill hits every workspace at once — the exact fan-out that drained the
  quota before. Once the backfill has run everywhere, both can go.
  **Why REST and not `gh pr list --head`** (applies to both paths): `gh pr list`
  is a **GraphQL** query with its own separate 5k/hr budget — the one actually
  drained (measured: graphql 0/5000 while core sat at 4977/5000). The old
  per-branch call also made ~45 requests to answer what ~5 answered, ~11k
  calls/hr against a 5k/hr budget, exhausting it in ~27 min, after which every
  row showed "PR?". REST additionally answers from gh's conditional-request
  cache, so repeat polls often cost no quota at all. REST reports merged-ness via
  `merged_at` (its `state` is only open/closed), mapped to `OPEN/CLOSED/MERGED`
  in the `--jq`; results are sorted newest-first since REST returns oldest-first.
  Misses aren't cached (retry immediately). On failure it returns the
  empty result **plus `error: <first stderr line>`** (`PRsForBranch.error`): an
  empty `all` alone is indistinguishable from "this branch has no PRs", so a
  broken `gh` (missing binary, invalid `GITHUB_TOKEN`, rate limit) used to make
  the PR badge silently vanish — failing in the passing direction. The Sidebar
  renders `error` as an amber `.pr-badge.error` ("PR?") whose tooltip carries the
  `gh` stderr line, so "could not ask" reads differently from "nothing to show".
  Note `gh` puts its real diagnostic on **stderr** — `err.message` is only the
  exec wrapper's "Command failed".
- **`findBranchChecks(repoPath, branch)`** — CI (GitHub Actions) verdict per
  branch, same repo-wide + cached pattern as PRs: ONE REST
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
  the workspace's agent via `wakeAgentWithPrompt`, falling back to typing into
  a live PTY like `git:merge`.
- **`getReleaseState`** `:722` / **`getReleaseVersionsContaining`** `:797` — pill
  policy: the earliest published release containing the branch's *authored*
  commits (`authoredCommits` `:870`, reflog-derived) **plus** each release the
  branch itself cut (it authored the tag's version-bump commit). Ancestry alone
  would credit the whole history; per-commit first-containing-release would let a
  stray follow-up commit earn another branch's release pill (both were prior
  bugs). Releases come from **REST** `gh api repos/{owner}/{repo}/releases`
  (`--jq` reshapes the field names to the `tagName/isDraft/isPrerelease/
  publishedAt` shape this code already parsed), cached 30s per repo. It was
  `gh release list`, which is GraphQL — keeping every *polled* `gh` call on REST
  means one drained budget can no longer blank both the PR badge and the release
  pill at once.
- **Release-pill cost model** (a per-(release × commit) `merge-base
  --is-ancestor` storm here once pegged the main process at 70% CPU): ancestry
  is asked per authored commit via one `git tag --contains` (`tagsContaining`
  `:748`), the whole result is memoized per (repo, branch) keyed on (tip sha,
  release list) (`versionsCache` `:769`) so an unchanged branch costs one
  `rev-parse` per poll, and tag→sha resolutions are memoized per repo
  (`tagShaCache` `:627`, tags are immutable). Transient failures are not
  memoized — the next poll retries.

## Base-branch sync & credentials
- `getBaseSyncState` `:856` (local `<base>` vs `origin/<base>`, no network).
- `syncBaseBranch` `:949` — cascade: `fetch origin base:base` (atomic) → `pull
  --ff-only` (if base checked out) → `fetch origin base` (worktree-safe fallback).
- **All fetch/pull use a non-interactive credential env** (`runGit` `:918`,
  env block ~`:881`): `GIT_TERMINAL_PROMPT=0`, askpass → `/bin/echo`, and a
  `gh auth git-credential` helper. The desktop app has no TTY, so it must fail
  fast on auth rather than hang on `gnome-ssh-askpass`.

## Merge is delegated to the agent
The `git:merge` IPC handler (`api-handlers.ts:217`, `mergeWorktree`) does **not** merge in the main
process. It injects a prompt into the agent's PTY telling it to run `git -C
<repoPath> merge … && git push`. Rationale: keeps the checked-out worktree HEAD
stable, and lets the agent write a meaningful commit message with full context.

## Error handling
Helpers swallow and return safe defaults (`[]`/`''`/`null`/all-false merge
state). User-facing errors (branch-switch collision) are re-thrown with a
readable message. `runGit` surfaces the first stderr line on failure.
