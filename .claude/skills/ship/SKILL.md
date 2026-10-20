---
name: ship
description: Ship the current branch's work — rebase onto master, commit, push, fast-forward master, release a patch, and install the build locally. Use when the user asks to ship, release, or publish — AND, unasked, as the last step of any finished, verified work in a top-level workspace (not one spawned by another agent or in a fleet; see CLAUDE.md "Auto-ship").
---

# Ship orchestra

Take the work on the current worktree branch all the way out: rebase it onto
master, land it on master, cut a patch release, and swap the local launcher to
the freshly built AppImage.

Shipping does not verify the work: it **checks that the evidence exists**. UI and
idle-CPU verification belong to finishing the work (the `verify` skill);
`scripts/release.sh` re-runs the gates that the rebase can break. Its
header documents every flag (`--to-master`, `--install`, `--notes-file`,
`--dry-run`, `--ci-only`) — read it there.

## Steps

1. **Commit pending work.** The release refuses a dirty tree. Commit what
   `git status --short` lists, with the repo's `Co-Authored-By` trailer.
   Done when `git status --short` prints nothing.

2. **Rebase onto the latest master.** `--to-master` needs a clean fast-forward.

   ```bash
   git fetch origin && git rebase origin/master
   ```

   Done when `git merge-base --is-ancestor origin/master HEAD` exits 0. A
   conflict you can't resolve cleanly: stop and surface it to the user.

3. **Check the verification evidence — don't produce it here.** Let the diff
   name the surfaces:

   ```bash
   git diff --name-only origin/master..HEAD | grep -E '^src/(renderer|preload)/|\.css$'
   git diff -U0 origin/master..HEAD -- src/ | grep -E '^\+' \
     | grep -nE 'setInterval|setTimeout|execFile|spawn|simpleGit|useEffect'
   ```

   Done when, for this branch's work, you can cite:
   - **per matched UI file**: a `verify` report (a `pre-state -> post-state`
     assertion + a screenshot path you read). A `src/main/`-only change with a
     visible effect needs one too; otherwise one line saying why not.
   - **per hot-path hit**: its cadence and what its cost scales with; an idle-CPU
     reading from the `verify` skill if any hit polls or spawns.

   A report made before the rebase still counts unless master's new commits
   touch the same UI files — compare the first command's output with
   `git diff --name-only $(git merge-base ORIG_HEAD origin/master)..origin/master`.
   Missing or stale evidence: stop, run the `verify` skill, then come back. A
   caveat ("not e2e-verified") is not evidence.

4. **Write the release notes** from the commits this release adds:

   ```bash
   git log origin/master..HEAD --pretty='%s%n%n%b' --reverse
   ```

   A few user-facing bullets grouped by theme, written to
   `"$TMPDIR/orchestra-release-notes.md"` (the worktree's tmp guard blocks a
   literal `/tmp/…` path). Done when every non-chore commit is
   represented; a branch of trivial commits earns one line.

5. **Release, land on master, install locally.**

   ```bash
   pnpm run release patch --to-master --install --notes-file "$TMPDIR/orchestra-release-notes.md"
   ```

   `patch` is the default; use `minor`/`major`/`X.Y.Z` when the user asks.
   The script first runs `tsc`, the full suite (0 fail, **0 skipped**) and
   `build:bus-abi` (#207, `scripts/release-gate.sh`); any refusal leaves the
   repo untouched — fix and re-run. `--skip-release-gate "<reason>"` is never
   a way past a red suite. A "not an ancestor" refusal usually means a sibling
   moved master: redo step 2, then this step.

6. **Report back**: the new version/tag, the evidence cited in step 3, and tell
   the user to **relaunch Orchestra** (the local AppImage is already swapped).
   CI adds the x64/arm64 AppImages to the GitHub release a few minutes later.
