#!/usr/bin/env bash
#
# Release Orchestra: bump version, tag, push, and optionally build locally.
#
# Tags and releases the CURRENT branch (worktree-safe — does NOT require or
# checkout master). The v* tag drives CI; bring the code onto master separately,
# or pass --to-master to fold that in (see below).
#
# Usage (run from any branch / orchestra worktree):
#   npm run release                  # patch bump (default): 0.1.11 -> 0.1.12
#   npm run release -- minor         # minor bump:            0.1.11 -> 0.2.0
#   npm run release -- major         # major bump:            0.1.11 -> 1.0.0
#   npm run release -- 1.2.3         # explicit version
#   npm run release -- patch --dry-run   # print every step, change nothing
#   npm run release -- patch --ci-only   # skip local build, let GitHub Actions handle it
#   npm run release -- patch --to-master # also land the release on master (see below)
#   npm run release -- patch --install   # also install the local build to the launcher (see below)
#
# --to-master: the script can't `git checkout master` (each orchestra workspace
# is a worktree pinned to its own branch, and master is checked out elsewhere),
# so instead it advances origin/master with non-checkout pushes:
#   1. Before tagging, fast-forward origin/master up to HEAD (requires the
#      current branch to be a clean fast-forward ahead of origin/master).
#   2. After the bump commit, fast-forward origin/master again to include it.
# The result: master, the released branch, and the v* tag all point at the same
# commit. Refuses (before changing anything) if master can't be fast-forwarded.
#
# --install: after the local build, atomically replace the AppImage that your
# launcher runs with the freshly built one — so the app you start is the version
# you just released, without a manual copy. The destination is resolved in order:
#   1. $ORCHESTRA_INSTALL_PATH if set
#   2. the Exec= target of ~/.local/share/applications/orchestra.desktop
# The copy is temp-file + rename (atomic on the same filesystem), so a running
# instance's mmap'd binary is never truncated mid-write. Relaunch to pick it up.
# Incompatible with --ci-only (there is no local build to install).
#
# By default, this script:
#   1. Bumps version, commits, tags
#   2. Builds AppImage locally (for current arch)
#   3. Pushes tag (triggers GitHub Actions for multi-arch builds)
#   4. Creates GitHub release with local build
#   5. GitHub Actions adds x64 and arm64 AppImages to the release
#
# With --ci-only:
#   1. Bumps version, commits, tags
#   2. Pushes tag (triggers GitHub Actions)
#   3. GitHub Actions creates release with x64 and arm64 AppImages
#
# Requirements: a clean working tree on a non-detached branch, up to date with
# its own remote, and an authenticated gh CLI.

set -euo pipefail

BUMP="patch"
DRY_RUN=0
CI_ONLY=0
TO_MASTER=0
INSTALL=0
for arg in "$@"; do
  case "$arg" in
    patch|minor|major) BUMP="$arg" ;;
    --dry-run|-n) DRY_RUN=1 ;;
    --ci-only|--ci) CI_ONLY=1 ;;
    --to-master) TO_MASTER=1 ;;
    --install) INSTALL=1 ;;
    [0-9]*.[0-9]*.[0-9]*) BUMP="$arg" ;;
    *) echo "error: unknown argument '$arg'" >&2; exit 2 ;;
  esac
done

if [ "$INSTALL" = 1 ] && [ "$CI_ONLY" = 1 ]; then
  echo "error: --install needs the local build, so it can't be combined with --ci-only" >&2
  exit 2
fi

cd "$(git rev-parse --show-toplevel)"

say()  { printf '\n\033[1;36m▶ %s\033[0m\n' "$*"; }
# In dry-run, mutating steps are printed instead of run.
run()  { if [ "$DRY_RUN" = 1 ]; then printf '  [dry-run] %s\n' "$*"; else eval "$*"; fi; }

# ---------------------------------------------------------------- preflight ---
say "Preflight"
gh auth status >/dev/null 2>&1 || { echo "error: gh CLI not authenticated — run 'gh auth login'" >&2; exit 1; }

# Release the CURRENT branch — not necessarily master. Orchestra runs each
# workspace as a git worktree pinned to its own branch, and checking out master
# inside a worktree would corrupt that workspace's branch tracking. The release
# is driven by the v* tag (CI builds from the tag, branch-agnostic), so we tag
# wherever HEAD is. Get the released code onto master afterward with a separate
# fast-forward push (no worktree checkout) if needed.
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
[ "$BRANCH" != "HEAD" ] || { echo "error: detached HEAD — checkout a branch first" >&2; exit 1; }

git diff-index --quiet HEAD -- || { echo "error: working tree is dirty — commit or stash first" >&2; exit 1; }

# Don't tag a branch that's behind its own remote — you'd ship stale code.
if git fetch origin "$BRANCH" --quiet 2>/dev/null; then
  BEHIND="$(git rev-list --count "HEAD..origin/$BRANCH")"
  [ "$BEHIND" = "0" ] || { echo "error: local $BRANCH is $BEHIND commit(s) behind origin/$BRANCH — pull first" >&2; exit 1; }
else
  echo "  warn: could not fetch origin/$BRANCH (new branch or offline?) — skipping behind-check"
fi
echo "  ok: on '$BRANCH', clean, gh authed"

# --to-master safety: verify origin/master can be fast-forwarded to HEAD before
# we change anything, so a non-FF situation fails the whole release up front
# rather than after we've already tagged and built.
if [ "$TO_MASTER" = 1 ]; then
  git fetch origin master --quiet 2>/dev/null || {
    echo "error: --to-master: could not fetch origin/master" >&2; exit 1; }
  if [ "$BRANCH" = "master" ]; then
    echo "error: --to-master is meaningless on the master branch itself" >&2; exit 1
  fi
  git merge-base --is-ancestor origin/master HEAD || {
    echo "error: --to-master: origin/master is not an ancestor of HEAD —" >&2
    echo "       master can't be fast-forwarded. Rebase '$BRANCH' onto origin/master first." >&2
    exit 1; }
  echo "  ok: origin/master fast-forwards to HEAD (--to-master)"
fi

# --install: resolve (and sanity-check) the destination up front, so a missing
# launcher target fails before we tag/build rather than after.
INSTALL_PATH=""
if [ "$INSTALL" = 1 ]; then
  if [ -n "${ORCHESTRA_INSTALL_PATH:-}" ]; then
    INSTALL_PATH="$ORCHESTRA_INSTALL_PATH"
  else
    DESKTOP="$HOME/.local/share/applications/orchestra.desktop"
    if [ -f "$DESKTOP" ]; then
      # Take the binary from the Exec= line (first token, strip any %-field args).
      INSTALL_PATH="$(grep -m1 '^Exec=' "$DESKTOP" | sed 's/^Exec=//' | awk '{print $1}')"
    fi
  fi
  [ -n "$INSTALL_PATH" ] || {
    echo "error: --install: could not resolve a destination. Set ORCHESTRA_INSTALL_PATH" >&2
    echo "       or add an Exec= path to ~/.local/share/applications/orchestra.desktop." >&2
    exit 1; }
  INSTALL_DIR="$(dirname "$INSTALL_PATH")"
  [ -d "$INSTALL_DIR" ] || {
    echo "error: --install: destination dir does not exist: $INSTALL_DIR" >&2; exit 1; }
  echo "  ok: --install target is $INSTALL_PATH"
fi

# ------------------------------------------------------------ next version ---
CURRENT="$(node -p "require('./package.json').version")"
case "$BUMP" in
  patch|minor|major)
    IFS=. read -r MAJOR MINOR PATCH <<<"$CURRENT"
    case "$BUMP" in
      patch) PATCH=$((PATCH + 1)) ;;
      minor) MINOR=$((MINOR + 1)); PATCH=0 ;;
      major) MAJOR=$((MAJOR + 1)); MINOR=0; PATCH=0 ;;
    esac
    NEW="$MAJOR.$MINOR.$PATCH" ;;
  *) NEW="$BUMP" ;;
esac
TAG="v$NEW"

if git rev-parse "$TAG" >/dev/null 2>&1; then
  echo "error: tag $TAG already exists" >&2; exit 1
fi
say "Releasing $CURRENT → $NEW  (tag $TAG)"

# ------------------------------------------------- advance master (pre-bump) ---
# Fast-forward origin/master up to HEAD without checking it out (safe inside a
# worktree). FF-safety was already verified in preflight. The post-bump push
# below carries the version-bump commit onto master too.
if [ "$TO_MASTER" = 1 ]; then
  say "Advance origin/master → HEAD (--to-master)"
  run "git push origin HEAD:master"
fi

# ------------------------------------------------------- bump + commit + tag ---
say "Bump version, commit, tag"
run "npm version '$NEW' -m 'chore: bump version to %s'"

# ------------------------------------------------------------ build AppImage ---
if [ "$CI_ONLY" = 0 ]; then
  say "Build AppImage (local)"
  APPIMAGE="release/Orchestra.AppImage"
  if ! run "npm run build"; then
    echo "error: build failed. Undo the local bump with:" >&2
    echo "    git tag -d $TAG && git reset --hard HEAD~1" >&2
    exit 1
  fi
  if [ "$DRY_RUN" != "1" ] && [ ! -f "$APPIMAGE" ]; then
    echo "error: build did not produce $APPIMAGE" >&2
    echo "  undo the bump with: git tag -d $TAG && git reset --hard HEAD~1" >&2
    exit 1
  fi

  # --install: atomically swap the launcher's AppImage with the fresh build.
  # cp to a temp file in the destination dir (same filesystem → rename is
  # atomic), then mv over the target, so a running instance is never left
  # reading a half-written binary.
  if [ "$INSTALL" = 1 ]; then
    say "Install local build → $INSTALL_PATH"
    run "cp '$APPIMAGE' '$INSTALL_PATH.tmp'"
    run "chmod +x '$INSTALL_PATH.tmp'"
    run "mv -f '$INSTALL_PATH.tmp' '$INSTALL_PATH'"
    [ "$DRY_RUN" = "1" ] || echo "  installed — relaunch Orchestra to pick up $NEW"
  fi
else
  say "Skipping local build (--ci-only mode)"
fi

# ------------------------------------------------------ push commit + tag ---
say "Push $BRANCH + $TAG"
run "git push --follow-tags origin '$BRANCH'"

# ----------------------------------------------- advance master (post-bump) ---
# Carry the version-bump commit onto master so master, the released branch, and
# the v* tag all point at the same commit. Still a fast-forward (HEAD is now the
# bump commit, one ahead of where we left master pre-bump).
if [ "$TO_MASTER" = 1 ]; then
  say "Advance origin/master → $TAG bump commit (--to-master)"
  run "git push origin HEAD:master"
fi

# ----------------------------------------------------- publish GitHub release ---
if [ "$CI_ONLY" = 0 ]; then
  say "Publish GitHub release $TAG (local build)"
  APPIMAGE="release/Orchestra.AppImage"
  ASSETS="$APPIMAGE"
  # electron-builder also emits the auto-update manifest; ship it if present.
  [ -f release/latest-linux.yml ] && ASSETS="$ASSETS release/latest-linux.yml"
  run "gh release create '$TAG' --title '$TAG' --generate-notes $ASSETS"
  say "Released $TAG ✅"
  echo "  GitHub Actions will add x64 and arm64 AppImages shortly."
else
  say "Tag pushed — GitHub Actions will build and publish release"
  echo "  Monitor: https://github.com/lcsmas/orchestra/actions"
fi

[ "$DRY_RUN" = "1" ] && echo "(dry run — nothing was changed)"
