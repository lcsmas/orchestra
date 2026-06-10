#!/usr/bin/env bash
#
# Release Orchestra: bump version, tag, push, and optionally build locally.
#
# Usage (run from the main repo on `master`):
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
#   3. Pushes tag (triggers GitHub Actions for multi-arch builds)
#   4. Creates GitHub release with local build
#   5. GitHub Actions adds x64 and arm64 AppImages to the release
#
# With --ci-only:
#   1. Bumps version, commits, tags
#   2. Pushes tag (triggers GitHub Actions)
#   3. GitHub Actions creates release with x64 and arm64 AppImages
#
# Requirements: a clean working tree on `master`, and an authenticated gh CLI.

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

BRANCH="$(git rev-parse --abbrev-ref HEAD)"
[ "$BRANCH" = "master" ] || { echo "error: must be on 'master' (currently on '$BRANCH')" >&2; exit 1; }

git diff-index --quiet HEAD -- || { echo "error: working tree is dirty — commit or stash first" >&2; exit 1; }

if git fetch origin master --quiet 2>/dev/null; then
  BEHIND="$(git rev-list --count HEAD..origin/master)"
  [ "$BEHIND" = "0" ] || { echo "error: local master is $BEHIND commit(s) behind origin/master — pull first" >&2; exit 1; }
else
  echo "  warn: could not fetch origin/master (offline?) — skipping behind-check"
fi
echo "  ok: on master, clean, gh authed"

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
else
  say "Skipping local build (--ci-only mode)"
fi

# ------------------------------------------------------ push commit + tag ---
say "Push master + $TAG"
run "git push --follow-tags origin master"

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
