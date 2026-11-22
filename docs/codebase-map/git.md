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
add`, then pins the owner's git identity into the worktree — #513, `git-identity.ts`, see [workspaces.md](workspaces.md)) · `listWorktreePaths` `:128` (porcelain parse) · `removeWorktree` `:138`
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
- **Order + content (#506)**: a dependent is nominated and gated EARLY on its upstream's verified candidate (state rules: `hooks-cli-socket.md` §`orchestra fanout state|resume`, `builtOn`), but `deliver` is where order is enforced, BEFORE the PR is opened and before any wait.
  `deps.upstreams` (production: `upstreamsFromState` — reads `<ORCHESTRA_HOME>/fanout/<run>/state.json`, `--run` else the caller's own run; FAILS CLOSED: an explicit `--run` with no state, a ticket the existing state does not name, or an unreadable state ⇒ exit 1 `bad-state`; only no `--run` + no state at the caller's own run keeps the old store-less behaviour, and the JSON then says `upstreamsChecked:false`, never silently)
  names the ticket's `dependsOn` with branch/pr/`builtOn`/`mergedAccepted`. Why the state file and not flags: `builtOn` lives only there and a forgotten flag would silently skip the rule. `gatherUpstreamFacts` (gh only: the RECORDED upstream PR by `pr view <n>` — its own base/state decide, never a look-alike by branch name — else `pr list --head <upstream branch> --base INTO --state all`,
  `api commits/<sha>` for trees, `api compare/<a>...<b>` for ancestry; any unreadable fact ⇒ exit 1) feeds the pure `decideUpstreams` (shared/fanout-deliver.ts): each upstream must be MERGED into INTO (`upstream-not-merged`, exit 2: a dependent never merges first);
  when `builtOn` is recorded the upstream must have merged THAT content — same head, or same tree (`upstream-changed`: a fix round / refusal since the dependent's gate voids its verdict, re-gate) — and the verified head must contain the built-on head OR the upstream's merge commit
  (a rebase-merge rewrites the target's shas, never the PR head; a dependent rebuilt on the merged target contains the merge commit, not the old sha). `mergedAccepted` upstreams are skipped (the human override). No `builtOn` = built after the upstream merged: merged-ness is the whole rule.
- Tests: `src/shared/fanout-deliver.test.ts` + `src/cli/fanout-deliver.test.ts` (fake gh that, like GitHub, refuses a merge whose `--match-head-commit` ≠ its head). Must-FAIL arms: zero-step green (single and mixed), moved head (before the check AND between check and merge), MAJOR/BLOCKING verdict, omitted verdict without `--no-review-gate`. #506: `src/cli/fanout-deliver-stacked.test.ts` (REAL git on a scratch bare origin, a stateful fake GitHub merging with real git incl. `--rebase` that rewrites shas, the production state reader): must-PASS both merge in order (merge + rebase); must-FAIL dependent before upstream (no PR opened), upstream fix round after the dependent's PASS, dependent cut before the merge; `decideUpstreams` arms per clause in `fanout-deliver.test.ts`. Mutants (`S*`/`D*`/`C*`/`G*`/`K*`/`R*`, 43 at the fix round, + the follow-ups' own) each seen to FAIL; production wiring (`realDeps().upstreams`, `--run` parse, `realGateDeps().stack`) is driven by name in the stacked + gate tests.

### `orchestra fanout gate` — what the verifier may skip (#495)
`src/cli/fanout-gate.ts` (`gatePr`, `parseGateArgs`, `runGate`; routed by the `fanout` case of `cli/index.ts` before deliver) + the pure `decideGate` / `workflowRunsOnPr` in `src/shared/fanout-deliver.ts`. **Read-only** (gh `api` / `pr list|view|diff` / `run view`), store-less, open to EVERY role (the role guard names only deliver/open/state writes). `gate --branch --into --head <40-hex> [--repo] [--require-check]…` prints ONE JSON line: `repoCi` (`pr-workflows` = a workflow on the TARGET branch that provably runs for a PR into it (`pull_request`, `branches` admit the target, `types` include `synchronize`, no `paths` filter), `none`, `unknown`), `ci` of the PR's CURRENT head, `headMatches`, `fullSuite` (`ci` | `verifier`), `ciGreenOnHead`, and the derived `checklist` `{skip,wait,keep,run}`. Exit 0 = answered, 1 = could not check.
- Fail closed (#495 review): no provable PR CI, or an unreadable workflow listing, → `fullSuite:"verifier"` (the old rule; a check on the head alone — push workflow, external status — is NOT PR CI); a PR head ≠ `--head` → `ciGreenOnHead:false`; pending / red / 0-step / no-PR is never green; the check set is read TWICE (5 s apart) and a changed name set is `pending` (a fast lint must not stand for the whole CI); **a green check is the suite only if proven so** (review A MAJOR): `suiteChecks` = the `--require-check` names (`suiteSource:"pinned"`) else the PR workflows' jobs whose steps run a test command (`suiteJobsOf`, `suiteSource:"derived"`; matrix legs / `caller / job` match via `suiteMatches`) — ALL must be green on the head; neither ⇒ `fullSuite:"verifier"` (a lint-only PR CI never skips the suite). `pull_request_target` and `!` branch patterns fail closed. Follow-up (#495 r2 + pre-review + review): `suiteJobsOf` is a STRICT step-scoped reader — CRLF stripped; `steps:` dashes may sit at the `steps:` indent (GitHub's starter) or deeper; keys (`run`, `if`, `continue-on-error`) are read at the STEP-KEY indent only (a `run:` under `with:` is not one); a job derives only when a step's `run:` is a plain runner invocation (`STRICT_TEST`: `pnpm test[:ci|:unit…]`, `jest`/`pytest`/`rspec` behind `python -m`, `poetry|uv|pipenv run`, `bundle exec`, `npx`, `VAR=x` env prefixes, `${{ … }}`/`$VAR` args, `2>&1`/`> file` redirects, `nx run-many -t test`, `go|cargo|dotnet test`…; never `pnpm test:lint`, `pip install pytest`, `echo pnpm test`; no `--passWithNoTests`/`--pass-with-no-tests`/`--dry`/`--graph`/`--listTests`/`--collect-only`/`--if-present`/`--fixtures`/`--showConfig`/`vitest list`…, a deny-list), unmasked (`MASKED`: no `||`, pipe, `;`, `set +e`, backgrounding; `\\`-continued/`>`-folded lines are ONE command), on a step and job without a non-benign `if:`/`continue-on-error`, under the default shell (any `shell:` — also dash-first — other than `bash` ⇒ whole workflow out), with no shell control flow / function / heredoc line in the step's `run:` (`SHELL_FLOW`), comments stripped quote-aware (`stripComment`: `echo "a # b" || true` keeps its `||`); `workflowRunsOnPr` strips CR too (CRLF keeps `paths:`/`branches:`/`types:` filters) and with no YAML anchor/alias/merge key in the job; anything unreadable is not derived (fail closed). Recall on 78 common real test commands: 66 derive (`RECALL_CMDS`; master's textual reader 54); PIN-ONLY by design: `make test|check`, `tox`/`nox`, `mvn`, `composer test`, `yarn workspaces foreach`, playwright/cypress, `test:e2e`. `suiteMatches`: a PINNED name is exact (as `deliver --require-check`), a DERIVED one also matches a matrix leg `n (…)`; a reusable-workflow suite is pinned by its full name (`ci / test`), never derived. `gate` runs `gh pr diff --name-only` (git-quoted / `./` paths normalised): a PR that edits `.github/`, or whose file list is unread / empty / failed (HTTP 406, > 300 files — caught, NOT exit 1) ⇒ `fullSuite:"verifier"`. A suite check absent from the head is in `absentSuiteChecks` and `detail`. NOT detected: a PR that changes what `test` runs (package.json scripts, runner config).
- **`--ticket <id> [--run <id>]` (#506)** adds `stack` (read from the fanout state, no gh): `order` = `none` | `wait-upstream` (stacked on a verified upstream candidate — gate it now, `deliver` merges only after the upstream) | `re-gate` (the upstream moved since the ticket was built on it: its verdict is void, never "ready to merge") | `blocked` (an upstream is no admissible candidate), + a row per upstream (`merged|candidate|changed|ineligible`); `null` = no such ticket. The CI answer is unchanged. Reader `stackFromState`, pure `stackView` (fanout-state.ts).
- ONE reading of "CI is green": `ciVerdict` (extracted from `decideDelivery`, behaviour unchanged) is shared by deliver and gate; `readPrChecks` (cli) is the shared snapshot reader. `deliver` stays the merge authority and re-checks at merge.
- Tests: `src/cli/fanout-gate.test.ts` (fake gh: green-on-head / no PR CI / moved head / 0 steps / pending / unreadable listing / read-only argv audit), `decideGate` arms in `src/shared/fanout-deliver.test.ts`; mutants (head ignored, no-CI skips suite, detector always true, 0-step green, unreadable = CI, pending green) each seen to FAIL. The skill points at it (§0b); #497's fix-round rule is its next line.

### `orchestra fanout open` — the PR at nomination (#479)
`src/cli/fanout-open.ts` (`openPr`, `parseOpenArgs`, `runOpenRoute`), same store-less `GhRunner` as deliver. `open --branch --into --ticket [--repo]` ≡ `deliver --open-only …` (ONE path: `runOpenRoute` in the `fanout` case of `cli/index.ts` runs before deliver; `--open-only` plus merge flags is a usage error). Opens `<branch> → <target>` at nomination so CI runs while the verifier gates, or REUSES the open one; **never merges** (only `gh pr list|create|view`).
- Lists `--head B --state all` WITHOUT `--base`: an open PR of the branch on another base ⇒ `wrong-base` (exit 2, no second PR); newest PR CLOSED unmerged and none open ⇒ `pr-closed` (exit 2); an earlier MERGED PR is ignored (new round). gh failure / no PR url ⇒ exit 1 `gh-failed`.
- Output: ONE JSON line `{verdict:"opened",pr,url,head,reused,ticket,branch,into}` (refusal: `verdict:"refused",reason,detail`). Feed `pr` to `fanout state set <ticket> --pr <n>`.
- Contract with deliver: deliver already reuses an OPEN PR; it still merges only at the verified head with CI green ON that head (`--match-head-commit`). A head pushed after open ⇒ CI reruns on the new head, deliver refuses `head-moved` (or waits for CI when re-verified at the new head).
- Tests: `src/cli/fanout-open.test.ts` (stateful fake GitHub: open / reuse / closed / wrong base / head moved after open, deliver composed on the same fake) + rig `scripts/e2e-fanout-open.mjs` (`pnpm run test:fanout-open`, mutants `pnpm run test:fanout-open-mutants`).

### Frozen acceptance tests — `fanout acceptance`, the gate clause, deliver's receipt (#510)
A test writer (no product code) writes per-ticket acceptance tests from the spec; the coordinator freezes `{path → sha256 of bytes}` in the ticket's state (`acceptance`, schema + `acceptanceHash(files, run)` + `assertAcceptancePath` in `src/shared/fanout-state.ts`; `state set` cannot write it — not in `SETTABLE_KEYS`, `--json` included; a hand-edited file fails the `hash` re-derivation on parse). Pure half `src/shared/fanout-acceptance.ts` (`freezeInto`/`amendInto`, `decisionNamesSentence`, `decideGateAcceptance`, `parseReceipt`, `decideDeliverReceipt`); I/O `src/cli/fanout-acceptance.ts`.
- **`fanout acceptance freeze|amend|show`** (`runAcceptance`, routed in `cli/index.ts` before `runFanout`; exits 0 ok · 2 policy refusal · 1 usage/could-not-check). `freeze` reads the files committed at `--from` (a ref resolved in the cwd repo, or a checkout dir whose tracked files are clean; regular blobs only, UTF-8) and refuses a second freeze. **`run` is a DIRECT runner argv** (`parseRunArgv` in fanout-state.ts, enforced at freeze, amend, state load AND gate): first word in an allowlist (node, tsx, vitest [run], jest, mocha, pytest, python -I -m pytest|unittest, deno test, bun test, ruby, rspec; NO `npx|pnpm exec|yarn exec` launcher — they resolve the runner in the candidate's node_modules/.bin / .npmrc), no shell metacharacter / quote / `#` / glob, flags ONLY from the runner's inert-flag ALLOWLIST (`RUNNERS` in fanout-state.ts: a deny list was beaten by `--env-file-if-exists`, `--experimental-config-file`, `--test-reporter=./x`, `--preload`, `--test-name-pattern <path>`, `--check`…), every other argument EXACTLY a frozen path, ≥ 1; the gate executes the argv with `spawnSync`, NO shell. Residue stated in the help, not claimed fixed: argv[0] and anything on its search path (PATH, the module/import path, a runner config, a helper the test imports) resolve in the candidate's tree. `amend` needs `--decision <GitHub ledger comment URL>` read through gh (fail closed ⇒ 1) whose body contains `--spec-sentence` (≥ 12 chars, whitespace-normalised) else 2; appends `{at,decision,specSentence,bodySha256,hashBefore,hashAfter[,runAfter]}`; a no-op amend (same files AND same command) is refused, and so is a decision URL already in the ticket's amendments (one decision comment = one amendment, keyed on lower-cased repo + numeric comment id, however the URL is spelled); the decision's repo must equal the state's `repo` when set; optional `--run-cmd` replaces the command (same rules). Role guard: `freeze|amend` coordinator-only (`FANOUT_ACCEPTANCE_WRITE`), `show` open.
- **gate** (`--ticket <id> --cwd <checkout>`, `checkAcceptanceInCheckout`): runs BEFORE any CI read; ticket with `acceptance` ⇒ `--cwd` required (`acceptance-unproven`), cwd must be the checkout root with `HEAD == --head` and clean tracked files (`acceptance-stale-checkout`), every frozen file a regular blob at HEAD hashed on disk (`frozen-test-changed`, status same|changed|missing; the command never runs on changed bytes), then `run` executes in the cwd (`frozen-test-failed`; `NODE_TEST_CONTEXT` scrubbed). Refusal = exit 2 `verdict:"refused"`; success adds `acceptance.{ok,hash,files,ran,receipt:{head,hash,ok}}`. A KNOWN ticket without `acceptance` ⇒ output unchanged. `hash` = sha256 of the sorted `path\0sha\n` lines then `run\0<run>\n`: the command is part of the frozen identity (a receipt gated under another command is stale). State/ticket not found: without `--run` the ticket is looked up in the caller's own run then the INHERITED run (a verifier); with an explicit `--run` ⇒ exit 1 `bad-state`; without it ⇒ `acceptance:{consulted:false}` + a log line (nothing was checked).
- **deliver** (`--acceptance <receipt.json>`, step 1a before upstreams/PR): `deps.acceptance` (production `acceptanceFromState`, fail-closed like `upstreams`: unreadable state / explicit `--run` with none / unknown ticket ⇒ exit 1 `bad-state`); ticket with `acceptance` ⇒ receipt REQUIRED and must match the verified head + the state hash + `ok:true` (`acceptance-unproven|acceptance-stale|frozen-test-failed`), PLUS an independent `gh api contents/<path>?ref=<verified head>` byte re-read of every frozen path (`rereadFrozenAtHead`; 404 = missing; other gh failure ⇒ exit 1) ⇒ `frozen-test-changed`. Receipt file = the gate's `acceptance.receipt`, or the whole gate JSON line. `--acceptance` for a ticket without frozen tests ⇒ exit 1. Result gains `acceptanceChecked:true`.
- Tests: `src/cli/fanout-acceptance.test.ts` (REAL git: writer branch + candidate checkout; production `realGateDeps`/`realDeps` wiring; only gh faked, reading real bytes from the scratch repo), role-guard arms + must-FAIL arm in `src/shared/role-guard.test.ts`, rig `scripts/e2e-fanout-acceptance-mutants.mjs` through the BUILT CLI (`pnpm run test:fanout-acceptance`; mutants `pnpm run test:fanout-acceptance-mutants`: one must-PASS + one must-FAIL arm per clause, each clause mutated in the bundle).


## Error handling
Helpers swallow and return safe defaults (`[]`/`''`/`null`/all-false merge
state). User-facing errors (branch-switch collision) are re-thrown with a
readable message. `runGit` surfaces the first stderr line on failure.
