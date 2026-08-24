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
#   pnpm run release patch --notes-file NOTES.md  # use NOTES.md as the release description (see below)
#
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

# ------------------------------------------------- package.json integrity ---
# Twice now (v0.5.250, v0.5.253 — issue #40) a ship worktree's package.json was
# found post-release stripped down to ~50 lines: the whole `scripts` block gone,
# `devDependencies` gone, `build` gone, but `version` intact. That content is
# byte-for-byte what electron-builder's `cleanupPackageJson(isMain: true)`
# produces for the app bundle (app-builder-lib/out/fileTransformer.js) — it
# deletes exactly {scripts, devDependencies, build, keywords, …} and reserializes
# with `JSON.stringify(data, null, 2)`. Reproducing that transform over the tag's
# package.json regenerates the reported diff hunk-for-hunk (`@@ -23,33 +23,6 @@`,
# `@@ -74,37 +47,5 @@`) and the reported `wc -l` of 50 vs 109.
#
# THE WRITER IS `npx asar extract-file`, AND IT IS NOT THIS SCRIPT. Its second
# argument is a SELECTOR inside the archive, never a destination: output always
# lands in the CURRENT DIRECTORY. So an artifact-identity check like
#     cd <repo> && npx asar extract-file <app.asar> package.json
# silently REPLACES that repo's package.json with the packaged, stripped copy —
# deterministic, exit code 0, no warning. Both #40 sightings were post-release
# worktree-only because a post-release verify step does exactly this. Confirmed
# on a control fixture: `name` flipped from the fixture's own value to the
# archive's, i.e. the file was REPLACED, not edited.
#
# Note the JS API is safe and differently shaped: `extractFile()` RETURNS a
# buffer and touches nothing (that is what scripts/after-pack-check.cjs uses).
# Only the CLI writes to cwd.
#
# Do not re-derive the dead hypothesis: electron-builder's own pipeline does NOT
# do this. Its transform result is held in memory and packed into app.asar, and
# every copy destination resolves under `release/` — true, verified, and a dead
# end. Full evidence on issue #40.
#
# This stays a GUARD rather than a fix because release.sh is not the writer and
# has no extract-file on any path: a stripped package.json breaks every later
# `pnpm run …` in the worktree, and if it ever landed BEFORE the build it would
# ship broken metadata; nothing in the flow noticed either time.
#
# Cheap, total check: the file must parse, and carry the keys a stripped one
# lacks. Called after the bump (so a pre-build mangling aborts before we ship)
# and again at the very end (the post-release window where both sightings fell).
check_package_json() {
  local when="$1"
  [ "$DRY_RUN" != "1" ] || { printf '  [dry-run] check package.json integrity (%s)\n' "$when"; return 0; }

  # The verdict rides on node's EXIT CODE, never on whether it printed anything.
  # An earlier version decided on captured stdout alone; any death before the
  # first console.log (OOM-kill — plausible with ~30 agents on this box — an
  # unwritable redirect target, a bad NODE_OPTIONS) then produced no output and
  # was read as success, printing "package.json intact" over a stripped file.
  # A guard whose instrument can die into a PASS is worse than no guard.
  # No temp file: command substitution keeps it in-process, so there is nothing
  # for a sibling to pre-create and nothing to leak on an early return.
  local bad rc
  bad="$(node -e '
    const fs = require("node:fs");
    let raw, pkg;
    try { raw = fs.readFileSync("package.json", "utf8"); }
    catch (e) { console.log("unreadable: " + e.message); process.exit(1); }
    try { pkg = JSON.parse(raw); }
    catch (e) { console.log("does not parse as JSON: " + e.message); process.exit(1); }
    // The keys electron-builder strips for the bundle. Their absence is the
    // signature of a stripped file landing on the source tree.
    // NOTE: the ">= 5 scripts" floor and the "build" key are assumptions about
    // THIS repo shape. Pruning devDependencies, moving build config out to
    // electron-builder.yml, or legitimately dropping below 5 scripts would each
    // trip this — intentionally, so the layout change gets a deliberate edit here.
    const missing = ["scripts", "devDependencies", "build"].filter(k => pkg[k] == null);
    if (missing.length) { console.log("missing top-level key(s): " + missing.join(", ")); process.exit(1); }
    if (typeof pkg.scripts.release !== "string") { console.log("scripts.release is absent"); process.exit(1); }
    const n = Object.keys(pkg.scripts).length;
    if (n < 5) { console.log("scripts block has only " + n + " entr(y|ies)"); process.exit(1); }
  ' 2>&1)"; rc=$?

  # rc != 0 fails the check whether or not anything was captured. A nonzero exit
  # with empty output means the checker itself died — report that as a failure of
  # the CHECK, not of package.json, so nobody reads it as a corrupt tree.
  if [ "$rc" != 0 ]; then
    if [ -z "$bad" ]; then
      echo "error: package.json integrity check could not run ($when): the checker exited $rc without output." >&2
      echo "       Treat package.json as UNVERIFIED — inspect it by hand before trusting this release." >&2
    else
      echo "error: package.json integrity check failed ($when): $bad" >&2
      echo "       This is issue #40. The working-tree file has been mangled — the" >&2
      echo "       shipped tag is almost certainly fine. Inspect, then restore with:" >&2
      echo "           git checkout HEAD -- package.json" >&2
      echo "       and report the observed diff on https://github.com/lcsmas/orchestra/issues/40" >&2
    fi
    return 1
  fi
  echo "  ok: package.json intact ($when)"
}

# Any `set -e` abort between the bump and the end-of-run check would skip the
# check entirely. The sharpest case is the build-failure path: `pnpm run build`
# IS electron-builder, the only named producer of the corrupt content, and that
# path tells the operator to `git reset --hard HEAD~1` — which would discard the
# mangled package.json and destroy the evidence #40 exists to collect. So check
# on the way out too, however we leave.
_pkg_check_on_exit() {
  local ec=$?
  trap - EXIT                      # never re-enter, whatever the handler does
  [ "${_PKG_CHECKED_AT_END:-0}" = 1 ] || check_package_json "on exit" || true
  exit "$ec"                       # preserve the original exit code
}
# Armed after the bump, not here: before the bump there is nothing to protect,
# and a preflight refusal (dirty tree, no gh auth) would otherwise print a
# spurious "package.json intact" on its way out.

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

# The bump rewrites package.json — verify it survived before we build and ship
# from it (issue #40). Aborting here costs a `git reset`; shipping stripped
# metadata costs a release.
check_package_json "after version bump" || {
  echo "       Undo the local bump with: git tag -d $TAG && git reset --hard HEAD~1" >&2
  exit 1
}

# From here on, every exit path — including a `set -e` abort inside the build —
# passes through the integrity check on its way out (see F3 rationale above).
trap _pkg_check_on_exit EXIT

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

# ------------------------------------------------ package.json integrity (end) ---
# Both #40 sightings were noticed only AFTER release.sh had exited, so this is
# the window that actually caught them. The release itself is already published
# at this point — this does not unship anything, it tells you the worktree needs
# restoring instead of leaving you to discover it when the next `pnpm run` fails.
say "Verify package.json integrity"
_PKG_CHECKED_AT_END=1          # the EXIT trap must not re-run this check
if ! check_package_json "end of release"; then
  echo "       The release itself completed; only the working tree is affected." >&2
  exit 1
fi

if [ "$DRY_RUN" = "1" ]; then echo "(dry run — nothing was changed)"; fi
