#!/usr/bin/env bash
#
# Release Orchestra: bump version, tag, push, and optionally build locally.
#
# Tags and releases the CURRENT branch (worktree-safe — does NOT require or
# checkout master). The v* tag drives CI; bring the code onto master separately.
#
# Usage (run from any branch / orchestra worktree):
#   npm run release                  # patch bump (default): 0.1.11 -> 0.1.12
#   npm run release -- minor         # minor bump:            0.1.11 -> 0.2.0
#   npm run release -- major         # major bump:            0.1.11 -> 1.0.0
#   npm run release -- 1.2.3         # explicit version
#   npm run release -- patch --dry-run   # print every step, change nothing
#   npm run release -- patch --ci-only   # skip local build, let GitHub Actions handle it
#
# By default, this script:
#   1. Bumps version, commits, tags
#   2. Builds AppImage locally (for current arch)
#   3. Installs that build over the launcher's AppImage (the path your
#      orchestra.desktop / rofi entry runs) so your daily driver updates
#   4. Pushes tag (triggers GitHub Actions for multi-arch builds)
#   5. Creates GitHub release with local build
#   6. GitHub Actions adds x64 and arm64 AppImages to the release
#
# With --ci-only (faster, but does NOT refresh your local launcher):
#   1. Bumps version, commits, tags
#   2. Pushes tag (triggers GitHub Actions)
#   3. GitHub Actions creates release with x64 and arm64 AppImages
#   Run WITHOUT --ci-only when you want the rofi-launched binary updated.
#
# Requirements: a clean working tree on a non-detached branch, up to date with
# its own remote, and an authenticated gh CLI.

set -euo pipefail

BUMP="patch"
DRY_RUN=0
CI_ONLY=0
for arg in "$@"; do
  case "$arg" in
    patch|minor|major) BUMP="$arg" ;;
    --dry-run|-n) DRY_RUN=1 ;;
    --ci-only|--ci) CI_ONLY=1 ;;
    [0-9]*.[0-9]*.[0-9]*) BUMP="$arg" ;;
    *) echo "error: unknown argument '$arg'" >&2; exit 2 ;;
  esac
done

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

  # Install the fresh build over the AppImage your launcher (rofi/.desktop)
  # actually runs. Releasing from a worktree builds into THAT worktree's
  # release/ dir, but the desktop entry points at a fixed path (typically the
  # main clone's release/), so without this step a worktree release never
  # updates the binary you launch. Target is read from the .desktop Exec line so
  # it tracks wherever the launcher points; skipped only if that resolves back
  # to the file we just built. Atomic (temp + mv) so an interrupted copy can't
  # leave a half-written, unlaunchable AppImage.
  DESKTOP="$HOME/.local/share/applications/orchestra.desktop"
  LAUNCH_TARGET=""
  [ -f "$DESKTOP" ] && LAUNCH_TARGET="$(sed -n 's/^Exec=\([^ ]*\).*/\1/p' "$DESKTOP" | head -n1)"
  if [ -n "$LAUNCH_TARGET" ] && [ "$(readlink -f "$LAUNCH_TARGET" 2>/dev/null)" != "$(readlink -f "$APPIMAGE" 2>/dev/null)" ]; then
    say "Install build into launcher target ($LAUNCH_TARGET)"
    run "mkdir -p \"\$(dirname '$LAUNCH_TARGET')\""
    run "cp '$APPIMAGE' '$LAUNCH_TARGET.new' && chmod +x '$LAUNCH_TARGET.new' && mv -f '$LAUNCH_TARGET.new' '$LAUNCH_TARGET'"
    echo "  launcher now runs $NEW — quit and relaunch Orchestra to pick it up"
  else
    echo "  launcher target is the build itself (or no .desktop) — nothing to install"
  fi
else
  say "Skipping local build (--ci-only mode)"
fi

# ------------------------------------------------------ push commit + tag ---
say "Push $BRANCH + $TAG"
run "git push --follow-tags origin '$BRANCH'"

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
