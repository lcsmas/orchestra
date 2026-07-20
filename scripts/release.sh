#!/usr/bin/env bash
#
# Release Orchestra: bump version, tag, push, and optionally build locally.
#
# Tags and releases the CURRENT branch (worktree-safe — does NOT require or
# checkout master). The v* tag drives CI; bring the code onto master separately,
# or pass --to-master to fold that in (see below).
#
# Usage (run from any branch / orchestra worktree):
#   pnpm run release                  # patch bump (default): 0.1.11 -> 0.1.12
#   pnpm run release minor            # minor bump:            0.1.11 -> 0.2.0
#   pnpm run release major            # major bump:            0.1.11 -> 1.0.0
#   pnpm run release 1.2.3            # explicit version
#   pnpm run release patch --dry-run   # print every step, change nothing
#   pnpm run release patch --ci-only   # skip local build, let GitHub Actions handle it
#   pnpm run release patch --to-master # also land the release on master (see below)
#   pnpm run release patch --install   # also install the local build to the launcher (see below)
#   pnpm run release patch --with-gtk  # also build + attach the native GTK binary (see below)
#   pnpm run release patch --notes-file NOTES.md  # use NOTES.md as the release description (see below)
#
# --with-gtk: after the AppImage, also `cargo build --release` the native GTK
# frontend (native/orchestra-gtk) and attach the binary to the SAME GitHub
# release, named orchestra-gtk-<arch> (arch from `uname -m`: x86_64→x64,
# aarch64→arm64, to match the AppImage naming). The version is already in
# lockstep — build.rs bakes the repo package.json version into the crate — so
# the attached binary carries the release's version. Needs the crate's build
# deps present (gtk4/vte/gtksourceview/webkitgtk devel packages); on a rootless
# dev box, `source native/env.sh` first. Incompatible with --ci-only, where the
# release.yml matrix builds and attaches the GTK binaries for every arch.
# --notes-file FILE: use FILE's contents as the GitHub release description (body)
# instead of gh's auto-generated commit list. The release title stays the tag.
# Without it, the release falls back to `gh release create --generate-notes`.
# Ignored under --ci-only (CI generates the release).
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
WITH_GTK=0
NOTES_FILE=""
expect_notes_file=0
for arg in "$@"; do
  if [ "$expect_notes_file" = 1 ]; then
    NOTES_FILE="$arg"; expect_notes_file=0; continue
  fi
  case "$arg" in
    patch|minor|major) BUMP="$arg" ;;
    --dry-run|-n) DRY_RUN=1 ;;
    --ci-only|--ci) CI_ONLY=1 ;;
    --to-master) TO_MASTER=1 ;;
    --install) INSTALL=1 ;;
    --with-gtk) WITH_GTK=1 ;;
    --notes-file) expect_notes_file=1 ;;
    --notes-file=*) NOTES_FILE="${arg#--notes-file=}" ;;
    [0-9]*.[0-9]*.[0-9]*) BUMP="$arg" ;;
    *) echo "error: unknown argument '$arg'" >&2; exit 2 ;;
  esac
done
[ "$expect_notes_file" = 0 ] || { echo "error: --notes-file requires a path argument" >&2; exit 2; }

if [ "$INSTALL" = 1 ] && [ "$CI_ONLY" = 1 ]; then
  echo "error: --install needs the local build, so it can't be combined with --ci-only" >&2
  exit 2
fi

if [ "$WITH_GTK" = 1 ] && [ "$CI_ONLY" = 1 ]; then
  echo "error: --with-gtk builds the native binary locally, so it can't be combined with --ci-only" >&2
  echo "       (CI attaches the GTK binaries itself from the release.yml matrix)" >&2
  exit 2
fi

if [ -n "$NOTES_FILE" ]; then
  [ -f "$NOTES_FILE" ] || { echo "error: --notes-file: file not found: $NOTES_FILE" >&2; exit 2; }
  if [ "$CI_ONLY" = 1 ]; then
    echo "error: --notes-file can't be combined with --ci-only (CI generates the release notes)" >&2
    exit 2
  fi
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
      # Take the AppImage from the Exec= line: the first absolute-path token.
      # The launcher may wrap it (e.g. `env ORCHESTRA_OZONE=x11 /path %U`), so
      # picking `$1` would grab `env`/a `VAR=val` assignment — skip to the first
      # token starting with `/` and drop any trailing %-field args.
      INSTALL_PATH="$(grep -m1 '^Exec=' "$DESKTOP" | sed 's/^Exec=//' | tr ' ' '\n' | grep -m1 '^/')"
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

# --with-gtk asset naming: map the machine arch to the AppImage's x64/arm64
# labels so the GTK binary sits alongside Orchestra-<arch>.AppImage.
if [ "$WITH_GTK" = 1 ]; then
  case "$(uname -m)" in
    x86_64)  GTK_ARCH="x64" ;;
    aarch64|arm64) GTK_ARCH="arm64" ;;
    *) echo "error: --with-gtk: unsupported arch $(uname -m) (expected x86_64/aarch64)" >&2; exit 1 ;;
  esac
  GTK_BIN_SRC="native/target/release/orchestra-gtk"
  GTK_BIN_ASSET="orchestra-gtk-$GTK_ARCH"
fi

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
run "pnpm version '$NEW' --message 'chore: bump version to %s'"

# ------------------------------------------------------------ build AppImage ---
if [ "$CI_ONLY" = 0 ]; then
  say "Build AppImage (local)"
  APPIMAGE="release/Orchestra.AppImage"
  if ! run "pnpm run build"; then
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
    # Launchers (rofi, GNOME, …) resolve the desktop entry's `Icon=orchestra`
    # through the XDG icon theme, not the AppImage's embedded icon — install it
    # into the user's hicolor theme so the entry actually shows the logo.
    ICON_DIR="$HOME/.local/share/icons/hicolor"
    run "mkdir -p '$ICON_DIR/512x512/apps' '$ICON_DIR/scalable/apps'"
    run "cp build/icon.png '$ICON_DIR/512x512/apps/orchestra.png'"
    run "cp build/icon.svg '$ICON_DIR/scalable/apps/orchestra.svg'"
    [ "$DRY_RUN" = "1" ] || echo "  installed — relaunch Orchestra to pick up $NEW"
  fi

  # --with-gtk: build the native GTK frontend and stage the arch-suffixed
  # binary next to the AppImage so the publish step can attach it.
  if [ "$WITH_GTK" = 1 ]; then
    say "Build native GTK frontend (--with-gtk)"
    if ! run "pnpm run build:gtk"; then
      echo "error: GTK build failed. If this is a rootless dev box, 'source" >&2
      echo "       native/env.sh' first so the localdeps link chain is on PATH." >&2
      echo "       Undo the bump with: git tag -d $TAG && git reset --hard HEAD~1" >&2
      exit 1
    fi
    if [ "$DRY_RUN" != "1" ] && [ ! -f "$GTK_BIN_SRC" ]; then
      echo "error: GTK build did not produce $GTK_BIN_SRC" >&2
      echo "  undo the bump with: git tag -d $TAG && git reset --hard HEAD~1" >&2
      exit 1
    fi
    # Name it orchestra-gtk-<arch> to match the AppImage's arch labelling.
    run "cp '$GTK_BIN_SRC' 'release/$GTK_BIN_ASSET'"
    run "chmod +x 'release/$GTK_BIN_ASSET'"
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
  # --with-gtk: attach the native binary to the same release.
  if [ "$WITH_GTK" = 1 ]; then
    ASSETS="$ASSETS release/$GTK_BIN_ASSET"
  fi
  # Use a hand-written description if given, else fall back to gh's commit list.
  if [ -n "$NOTES_FILE" ]; then
    NOTES_OPT="--notes-file '$NOTES_FILE'"
  else
    NOTES_OPT="--generate-notes"
  fi
  run "gh release create '$TAG' --title '$TAG' $NOTES_OPT $ASSETS"
  say "Released $TAG ✅"
  echo "  GitHub Actions will add x64 and arm64 AppImages shortly."
else
  say "Tag pushed — GitHub Actions will build and publish release"
  echo "  Monitor: https://github.com/lcsmas/orchestra/actions"
fi

if [ "$DRY_RUN" = "1" ]; then echo "(dry run — nothing was changed)"; fi
