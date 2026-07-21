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

3. **Verify the build before releasing.** The release script runs the real
   build, but only *after* the version bump — and it never runs typecheck or
   tests. Catch failures now, while they're free to fix:

   ```bash
   [ -d node_modules ] || pnpm install
   npx tsc --noEmit && pnpm test
   ```

   If either fails, stop and report the failures instead of releasing — never
   tag unverified code. (No separate `pnpm run build` needed here: the release
   script builds the AppImage itself and aborts if that fails.)

4. **Stress-test performance before releasing.** A change can pass typecheck
   and tests and still melt the app at scale — work that runs per workspace ×
   per poll × per release adds up to a pegged main process. Two parts, both
   cheap; treat a failure like a failing test:

   - **Reason about hot paths in the diff.** Anything new on a poll cadence
     (the renderer's 8s stats poll, 12s PR poll, the Resources page's 2s tick)?
     Any new timer, or a child-process spawn (`execFile`/`spawn`/simple-git)
     reachable from a loop? If per-tick cost scales with the number of
     workspaces, releases, commits, or files, cache it or batch it first —
     assume ~20 live workspaces and a 50-release history, not 2 and 5.
   - **Measure the built app idle.** Launch the release build (the `verify`
     skill's isolated-`ORCHESTRA_HOME` harness works) with several workspaces,
     let it sit for a minute, then check the main process:

     ```bash
     ps -o pcpu=,comm= -p <main-pid>   # idle main process should be ~0–5% CPU
     ```

     If it's hot, profile before shipping: `kill -USR1 <main-pid>` opens the
     Node inspector on `127.0.0.1:9229`; a short CPU profile names the
     offender. Sustained double-digit idle CPU, or a stream of short-lived
     `git`/`gh`/`du` children, is a release blocker.

5. **Write the release description.** Compose a short, human-readable changelog
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

   Keep it concise and skip noise (chore/version-bump commits). If the branch has
   only trivial commits, a one-line summary is fine.

6. **Release + land on master + install locally.** One command does the push,
   the master fast-forward, the tag/build, the local install, rebuilds the
   native GTK frontend, and attaches your description to the GitHub release:

   ```bash
   pnpm run release patch --to-master --install --with-gtk --notes-file /tmp/orchestra-release-notes.md
   ```

   Use `minor`/`major` or an explicit `X.Y.Z` instead of `patch` only if the
   user asks for a different bump. Omit `--notes-file` to fall back to
   auto-generated notes (gh's commit list).

   **`--with-gtk` is not optional here.** The GTK binary bakes its version in at
   compile time (`build.rs` reads `package.json` → `ORCHESTRA_APP_VERSION`), and
   the launcher execs the worktree's `native/target/release/orchestra-gtk`. If a
   ship bumps `package.json` without rebuilding GTK, the native frontend keeps
   its *old* version while the Electron backend advances — the app then shows a
   "Version mismatch" dialog on every launch because the two are genuinely out of
   lockstep. `--with-gtk` rebuilds the binary in place so its baked version tracks
   the bump. (`release.sh` sources `native/env.sh` itself for the localdeps link
   chain, so no manual sourcing is needed.) On a box with no `.localdeps` and no
   system GTK devel packages the build will fail loudly — drop `--with-gtk` only
   then, and rebuild GTK separately once deps are available.

7. **Report back.** Show the new version/tag. The local AppImage is already
   swapped — tell the user to **relaunch Orchestra** to pick it up. CI then adds
   the x64/arm64 AppImages to the GitHub release a few minutes later.

## Notes

- The GitHub release body comes from `--notes-file`. Without it, the release
  falls back to gh's auto-generated commit list (`--generate-notes`).
- Preview without changing anything: append `--dry-run` to the release command.
- The script preflights gh auth, a clean tree, branch-up-to-date, and that
  `origin/master` fast-forwards to HEAD — if any fails it aborts before tagging,
  so a failure here is safe to read and fix.
- `--install` resolves the destination from `$ORCHESTRA_INSTALL_PATH`, falling
  back to the `Exec=` line of `~/.local/share/applications/orchestra.desktop`.
