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

## `orchestra fanout deliver` — one PR per ticket (#467, verified-fanout v2)
The CLI side of merging, store-less (only `gh`, behind the injectable `GhRunner`; no socket). Pure decision
`src/shared/fanout-deliver.ts` (`decideDelivery` → wait / refuse / merge / already-merged), I/O in `src/cli/fanout-deliver.ts` (`deliver`, `runDeliver`).
- Flow: `gh pr list --head B --base INTO` (reuse the OPEN PR, else `gh pr create`) → poll `gh pr view --json …statusCheckRollup` → for each passing Actions
  check `gh run view <run> --json jobs` counts the job's non-skipped steps (a lookup failure is could-not-check, never "no steps") → decide.
- Steps = non-skipped, `success` steps of the job that are not runner bookkeeping (`isUserStep`: not "Set up job"/"Complete job"/"Post …", which every real job has). A merge also needs the check-name set unchanged across two polls (a fast status can register before the real workflow) and every `--require-check <name>` present (waits `--no-checks-grace`, then `no-checks`). A MERGED PR is reused only at the verified head. A `--require-check` that is skipped/neutral ⇒ `zero-steps`; without it green needs ≥1 check with counted steps (statuses alone are not green — name external CI with `--require-check`). The step cache is keyed per JOB (`run/job`), never per run (two jobs of one run must not share a count); `--into`/`--branch` are validated at parse AND at the top of `deliver()` (`bad-args`, exit 1). `merged` is reported only after a read-back shows `state==='MERGED'` (merge queue ⇒ could-not-check); an already-merged PR with BLOCKING/MAJOR in the verdict is refused.
- Refuses (exit 2): `zero-steps` (a passing check with 0 steps, or nothing actually passed), `no-checks` (0 checks after `--no-checks-grace`, default 120 s),
  `ci-red`, `review-blocking` (verdict BLOCKING/MAJOR > 0), `verdict-head-mismatch`, `head-moved` (PR head ≠ verified head — also a merged PR at another head),
  `wrong-base`, `pr-closed`, `merge-conflict`. Could-not-check (exit 1): gh failed, timeout (`--timeout`, default 1800 s), unreadable/ill-typed verdict, no verified head, a non-head `gh pr merge` failure.
- **Check and act are ONE call**: the merge is `gh pr merge N --merge|--squash|--rebase --match-head-commit <verified head>`; GitHub compares the head inside the merge, so a push between the last
  check and the merge makes `gh` refuse (`classifyMergeFailure` → `head-moved`, exit 2). The verified head = `--verified-head` or the verdict's `head` (both given and different ⇒ refused).
- Verdict file (frozen): `{"round":1,"blocking":0,"major":0,"minor":2,"head":"<40-hex>"}`; strict parse, `minor` never refuses. **The review gate is mandatory (#473)**: no `--review-verdict` ⇒ refused (exit 2, `no-verdict`, before any gh call) unless the explicit `--no-review-gate` is given (then the result says `reviewGated:false`); both flags together is a usage error (exit 1). Role-guarded: only the coordinator may run `deliver` / `state init|set` (`hooks-cli-socket.md`).
- Output: ONE JSON line on stdout (`verdict` merged|already-merged|refused|unchecked, `reason`, `pr`, `url`, `head`, `mergeCommit`, `combinedSuite`); progress on stderr. `combinedSuite` is the exact command the **#487**: the test command inside `combinedSuite` is read from the TARGET ref on GitHub (`suiteCommandForTarget`: `gh api` root listing + `package.json`; `detectPackageManager`: `packageManager` field > `pnpm-lock.yaml` > `yarn.lock` > `bun.lock[b]` > `package-lock.json`; none/unreadable → `npm test`), `--suite-cmd` overrides; `combinedSuiteSource` (`flag|packageManager|lockfile|fallback`) says which.
  coordinator runs on the target after N merges (`git fetch … && git checkout --detach origin/INTO && … && <--suite-cmd, default pnpm run test>`); the verb never runs a repo suite.
- Tests: `src/shared/fanout-deliver.test.ts` + `src/cli/fanout-deliver.test.ts` (fake gh that, like GitHub, refuses a merge whose `--match-head-commit` ≠ its head). Must-FAIL arms: zero-step green (single and mixed), moved head (before the check AND between check and merge), MAJOR/BLOCKING verdict, omitted verdict without `--no-review-gate`.

### `orchestra fanout gate` — what the verifier may skip (#495)
`src/cli/fanout-gate.ts` (`gatePr`, `parseGateArgs`, `runGate`; routed by the `fanout` case of `cli/index.ts` before deliver) + the pure `decideGate` / `workflowRunsOnPr` in `src/shared/fanout-deliver.ts`. **Read-only** (gh `api` / `pr list|view` / `run view`), store-less, open to EVERY role (the role guard names only deliver/open/state writes). `gate --branch --into --head <40-hex> [--repo] [--require-check]…` prints ONE JSON line: `repoCi` (`pr-workflows` = a workflow on the TARGET branch that provably runs for a PR into it (`pull_request`, `branches` admit the target, `types` include `synchronize`, no `paths` filter), `none`, `unknown`), `ci` of the PR's CURRENT head, `headMatches`, `fullSuite` (`ci` | `verifier`), `ciGreenOnHead`, and the derived `checklist` `{skip,wait,keep,run}`. Exit 0 = answered, 1 = could not check.
- Fail closed (#495 review): no provable PR CI, or an unreadable workflow listing, → `fullSuite:"verifier"` (the old rule; a check on the head alone — push workflow, external status — is NOT PR CI); a PR head ≠ `--head` → `ciGreenOnHead:false`; pending / red / 0-step / no-PR is never green; the check set is read TWICE (5 s apart) and a changed name set is `pending` (a fast lint must not stand for the whole CI); `ciChecks` lists the check names — a lint-only CI is not the suite (`--require-check` pins it). `workflowRunsOnPr(yaml, into)` is a line reader, not a YAML parser: any shape it cannot read the same way is false.
- ONE reading of "CI is green": `ciVerdict` (extracted from `decideDelivery`, behaviour unchanged) is shared by deliver and gate; `readPrChecks` (cli) is the shared snapshot reader. `deliver` stays the merge authority and re-checks at merge.
- Tests: `src/cli/fanout-gate.test.ts` (fake gh: green-on-head / no PR CI / moved head / 0 steps / pending / unreadable listing / read-only argv audit), `decideGate` arms in `src/shared/fanout-deliver.test.ts`; mutants (head ignored, no-CI skips suite, detector always true, 0-step green, unreadable = CI, pending green) each seen to FAIL. The skill points at it (§0b); #497's fix-round rule is its next line.

### `orchestra fanout open` — the PR at nomination (#479)
`src/cli/fanout-open.ts` (`openPr`, `parseOpenArgs`, `runOpenRoute`), same store-less `GhRunner` as deliver. `open --branch --into --ticket [--repo]` ≡ `deliver --open-only …` (ONE path: `runOpenRoute` in the `fanout` case of `cli/index.ts` runs before deliver; `--open-only` plus merge flags is a usage error). Opens `<branch> → <target>` at nomination so CI runs while the verifier gates, or REUSES the open one; **never merges** (only `gh pr list|create|view`).
- Lists `--head B --state all` WITHOUT `--base`: an open PR of the branch on another base ⇒ `wrong-base` (exit 2, no second PR); newest PR CLOSED unmerged and none open ⇒ `pr-closed` (exit 2); an earlier MERGED PR is ignored (new round). gh failure / no PR url ⇒ exit 1 `gh-failed`.
- Output: ONE JSON line `{verdict:"opened",pr,url,head,reused,ticket,branch,into}` (refusal: `verdict:"refused",reason,detail`). Feed `pr` to `fanout state set <ticket> --pr <n>`.
- Contract with deliver: deliver already reuses an OPEN PR; it still merges only at the verified head with CI green ON that head (`--match-head-commit`). A head pushed after open ⇒ CI reruns on the new head, deliver refuses `head-moved` (or waits for CI when re-verified at the new head).
- Tests: `src/cli/fanout-open.test.ts` (stateful fake GitHub: open / reuse / closed / wrong base / head moved after open, deliver composed on the same fake) + rig `scripts/e2e-fanout-open.mjs` (`pnpm run test:fanout-open`, mutants `pnpm run test:fanout-open-mutants`).

## Error handling
Helpers swallow and return safe defaults (`[]`/`''`/`null`/all-false merge
state). User-facing errors (branch-switch collision) are re-thrown with a
readable message. `runGit` surfaces the first stderr line on failure.
