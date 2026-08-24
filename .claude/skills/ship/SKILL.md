---
name: ship
description: Ship the current branch's work — rebase onto master, commit, push, fast-forward master, release a patch, and install the build locally. Use when the user asks to ship, release, or publish their orchestra work.
---

# Ship orchestra

Take the work on the current orchestra worktree branch all the way out: rebase
it onto master, commit, push, land it on master, cut a patch release, and swap
the local launcher to the freshly built AppImage.

The release script (`scripts/release.sh`) is worktree-safe: it tags the CURRENT
branch, because master is checked out in another worktree. Its header block
documents every flag (`--to-master`, `--install`, `--notes-file`, `--dry-run`,
`--ci-only`) and their interactions — read it there rather than from a copy.

## Steps

1. **Commit any pending work.** The release refuses to run on a dirty tree.

   ```bash
   git status --short
   ```

   Stage and commit anything it lists, ending the message with the repo's
   `Co-Authored-By` trailer. Done when `git status --short` prints nothing.

2. **Rebase onto the latest master.** `--to-master` requires the branch to be a
   clean fast-forward ahead of `origin/master`, so rebase first.

   ```bash
   git fetch origin && git rebase origin/master
   ```

   Done when `git status` reports no rebase in progress and
   `git merge-base --is-ancestor origin/master HEAD` exits 0. If a conflict
   can't be resolved cleanly, stop and surface it to the user.

3. **Verify the build before releasing.** The release script runs the real
   build, but only *after* the version bump — and it never runs typecheck or
   tests. Catch failures now, while they're free to fix:

   ```bash
   [ -d node_modules ] || pnpm install
   npx tsc --noEmit && pnpm test
   ```

   Done when both commands exit 0. On a failure, stop and report it — tagging
   waits for a green typecheck and suite. (The release script builds the
   AppImage itself and aborts if that fails, so a separate `pnpm run build`
   adds nothing here.)

4. **Drive the changed UI surface — state AND pixels.** Typecheck and tests are
   structurally blind to the defects that actually reach users: a composition
   bug where every source is individually correct (a placeholder `''` masking a
   persisted value, so the store is right and the display never moves), a CSS
   rule that black-screens the app, an element that exists in the DOM and paints
   nothing. All of those pass a green suite.

   Let the diff decide, rather than your read of it:

   ```bash
   git diff --name-only origin/master..HEAD \
     | grep -E '^src/(renderer|preload)/|\.css$|^src/main/' \
     && echo "VISIBLE-SURFACE: run verify" \
     || echo "NO-SURFACE: record the exemption"
   ```

   On `VISIBLE-SURFACE`, run the `verify` skill and produce BOTH artifacts:

   - **State assertions** over the real user path, driven with trusted CDP
     input. Assert the CHANGE — capture pre-state and require it to differ —
     rather than a state that may already have been true.
   - **A screenshot** of the changed surface, saved to a stated path. This is
     the only thing that catches "rendered nothing".

   CSS-only edits take this same path, and are the highest-risk category for it:
   they cannot fail a typecheck and rarely fail a build, yet a bad selector can
   leave the app unusable.

   On `NO-SURFACE` (pure logic, CLI, main-process plumbing with no visible
   result), write the exemption into the release report naming the files the
   command matched, so the skip is a claim the reviewer can check.

   **Done when** the release report contains, for each matched surface, a
   `pre-state -> post-state` assertion showing a difference AND a screenshot
   path that you have read — or, for `NO-SURFACE`, the written exemption. A
   caveat fails this test: "not e2e-verified" shipped a user-facing regression
   here in v0.5.153 that a ~10-minute drive caught in one run for v0.5.154.
   Disclosure leaves the obligation open.

5. **Stress-test performance before releasing.** A change can pass typecheck
   and tests and still melt the app at scale — work that runs per workspace ×
   per poll × per release adds up to a pegged main process. Two parts, both
   cheap; treat a failure like a failing test:

   - **Enumerate the hot paths the diff adds.** Let the diff name them:

     ```bash
     git diff -U0 origin/master..HEAD \
       | grep -E '^\+' \
       | grep -nE 'setInterval|setTimeout|execFile|spawn|simpleGit|useEffect'
     ```

     Account for every hit: state, per hit, what its cadence is and what its
     per-tick cost scales with. The existing cadences are the renderer's 8s
     stats poll, the 12s PR poll, and the Resources page's 2s tick. A cost that
     scales with the number of workspaces, releases, commits, or files gets
     cached or batched before shipping — size it at ~20 live workspaces and a
     50-release history, not 2 and 5. **Done when** every line the command
     printed has a stated cadence and scaling factor, or the command printed
     nothing.

   - **Measure the built app idle.** Launch the release build (the `verify`
     skill's isolated-`ORCHESTRA_HOME` harness works) with several workspaces,
     let it sit for a minute, then let the number decide:

     ```bash
     ps -o pcpu= -p <main-pid> | awk '{print ($1 > 10) ? "HOT: profile" : "OK: " $1 "%"}'
     ```

     An idle main process sits at ~0–5% CPU. On `HOT`, profile before shipping:
     `kill -USR1 <main-pid>` opens the Node inspector on `127.0.0.1:9229`; a
     short CPU profile names the offender. Sustained double-digit idle CPU, or
     a stream of short-lived `git`/`gh`/`du` children, is a release blocker.
     **Done when** the report carries the measured percentage.

6. **Write the release description.** Compose a short, human-readable changelog
   of what's in this release and write it to a temp file. Base it on the commits
   that this release adds on top of `origin/master`:

   ```bash
   git log origin/master..HEAD --pretty='%s%n%n%b' --reverse
   ```

   (Run this *before* the rebase folds the branch onto master, or use the commit
   range from step 2's rebase.) Turn that into a few bullet points grouped by
   theme — focus on user-facing changes, not the version-bump commit. Write it as
   Markdown to a scratch file, e.g.:

   ```bash
   cat > /tmp/orchestra-release-notes.md <<'EOF'
   ## What's new

   - Short, user-facing summary of each notable change
   - …
   EOF
   ```

   Done when every non-chore commit the `git log` printed is represented by a
   bullet, and the file exists at the path you pass in step 7. A branch of only
   trivial commits earns a one-line summary.

7. **Release + land on master + install locally.** One command does the push,
   the master fast-forward, the tag/build, the local install, and attaches your
   description to the GitHub release:

   ```bash
   pnpm run release patch --to-master --install --notes-file /tmp/orchestra-release-notes.md
   ```

   `patch` is the default bump; use `minor`/`major`/`X.Y.Z` when the user asks
   for one.

8. **Report back.** Show the new version/tag. The local AppImage is already
   swapped — tell the user to **relaunch Orchestra** to pick it up. CI then adds
   the x64/arm64 AppImages to the GitHub release a few minutes later.

## Notes

- Flag semantics (`--to-master`, `--install`, `--notes-file`, `--dry-run`,
  `--ci-only`) live in the header comment of `scripts/release.sh`. Read them
  there.
- The script preflights gh auth, a clean tree, branch-up-to-date, and that
  `origin/master` fast-forwards to HEAD. Each of those aborts before anything is
  tagged or pushed, so a failure at this stage is safe to read and fix — and a
  "not an ancestor" rejection is usually just a sibling agent having moved
  master mid-run: re-run `git fetch origin && git rebase origin/master` and
  release again.
