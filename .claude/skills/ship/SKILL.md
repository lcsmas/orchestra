---
name: ship
description: Ship the current branch's work — rebase onto master, commit, push, fast-forward master, release a patch, and install the build locally. Use when the user asks to ship, release, or publish their orchestra work.
---

# Ship orchestra

Take the work on the current orchestra worktree branch all the way out: rebase
it onto master, commit, push, land it on master, cut a patch release, and swap
the local launcher to the freshly built AppImage.

The release script (`scripts/release.sh`) is worktree-safe — it never checks out
master (master is checked out in another worktree). `--to-master` fast-forwards
`origin/master` with non-checkout pushes; `--install` atomically replaces the
launcher's AppImage with the local build.

## Steps

1. **Commit any pending work.** The release refuses to run on a dirty tree.

   ```bash
   git status --short
   ```

   If there are changes, stage and commit them with a clear message (end the
   message with the `Co-Authored-By` trailer, per the repo convention).

2. **Rebase onto the latest master.** `--to-master` requires the branch to be a
   clean fast-forward ahead of `origin/master`, so rebase first.

   ```bash
   git fetch origin && git rebase origin/master
   ```

   Resolve any conflicts before continuing. If the rebase can't complete
   cleanly, stop and surface it to the user rather than forcing.

3. **Release + land on master + install locally.** One command does the push,
   the master fast-forward, the tag/build, and the local install:

   ```bash
   npm run release -- patch --to-master --install
   ```

   Use `minor`/`major` or an explicit `X.Y.Z` instead of `patch` only if the
   user asks for a different bump.

4. **Report back.** Show the new version/tag. The local AppImage is already
   swapped — tell the user to **relaunch Orchestra** to pick it up. CI then adds
   the x64/arm64 AppImages to the GitHub release a few minutes later.

## Notes

- Preview without changing anything: append `--dry-run` to the release command.
- The script preflights gh auth, a clean tree, branch-up-to-date, and that
  `origin/master` fast-forwards to HEAD — if any fails it aborts before tagging,
  so a failure here is safe to read and fix.
- `--install` resolves the destination from `$ORCHESTRA_INSTALL_PATH`, falling
  back to the `Exec=` line of `~/.local/share/applications/orchestra.desktop`.
