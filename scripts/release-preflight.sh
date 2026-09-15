#!/usr/bin/env bash
#
# release-preflight.sh — the tag-vs-master race guards, factored OUT of
# release.sh so they can be exercised by a fixture rig without driving a real
# release (issue #78).
#
# WHY THIS EXISTS. The "3rd race shape" — a stale package.json `version` PLUS an
# existing origin tag that does NOT contain master's work — fired on three
# consecutive ships (v0.5.257 / v0.5.260 / v0.5.261). The only defence each time
# was a CONVENTION the ship agent had to remember from memory/release-ship-flow.md:
#
#     git log --oneline origin/master..v<newest>   # what the tag has, master lacks
#     git log --oneline v<newest>..origin/master   # if NONEMPTY → a real release is due
#
# A guard living in an agent's memory fails the day someone ships without loading
# it. These functions move it into the release flow as a PREFLIGHT.
#
# TESTABILITY SEAM. Every external read goes through an indirection so the fixture
# rig (scripts/verify-release-preflight.sh) can stub it without a network, a real
# origin, or a real `gh`:
#   - _rp_ls_remote_tags  → prints one `<sha>\trefs/tags/<tag>` line per remote tag
#   - _rp_gh_release_tags → prints one release tag per line
#   - _rp_log_count A B    → count of commits in `A..B` (git rev-list --count)
# Each honours an env override (RP_LS_REMOTE_TAGS / RP_GH_RELEASE_TAGS /
# RP_LOG_COUNT_CMD) so a test can feed canned data; unset, they hit the real
# git/gh. The verdict TEXT the functions print is part of the contract the rig
# asserts — do not reword it without updating the rig.

# ---- injectable external reads ---------------------------------------------

# All remote tags as `<sha>\trefs/tags/<name>` lines (peeled `^{}` refs included,
# the caller strips them). Override RP_LS_REMOTE_TAGS with a command whose stdout
# is that format to stub the network.
_rp_ls_remote_tags() {
  if [ -n "${RP_LS_REMOTE_TAGS:-}" ]; then
    eval "$RP_LS_REMOTE_TAGS"
  else
    git ls-remote --tags "${RP_REMOTE:-origin}" 'v*' 2>/dev/null
  fi
}

# Release tags, one per line. Override RP_GH_RELEASE_TAGS to stub `gh`.
_rp_gh_release_tags() {
  if [ -n "${RP_GH_RELEASE_TAGS:-}" ]; then
    eval "$RP_GH_RELEASE_TAGS"
  else
    # `gh release list` columns are tab-separated; the LAST field is the tag.
    # -L is bounded but we only need existence, and 200 covers every release.
    gh release list -L 200 2>/dev/null | awk -F'\t' 'NF{print $NF}'
  fi
}

# Number of commits in the range A..B (git rev-list --count semantics).
# Override RP_LOG_COUNT_CMD with a shell snippet; it sees the range endpoints as
# $1 (A) and $2 (B) — e.g. RP_LOG_COUNT_CMD='[ "$1" = v0.5.270 ] && echo 5 || echo 0'.
_rp_log_count() {
  if [ -n "${RP_LOG_COUNT_CMD:-}" ]; then
    set -- "$1" "$2"
    eval "$RP_LOG_COUNT_CMD"
  else
    git rev-list --count "$1..$2" 2>/dev/null || echo "ERR"
  fi
}

# ---- newest tag (version order, NOT ls-remote's alphabetical order) --------

# `git ls-remote --tags` lists refs in ALPHABETICAL order, so v0.5.99 sorts
# AFTER v0.5.270 — reading `tail -1` off it picks the wrong "newest". Strip to
# bare `vN.N.N` names, drop peeled `^{}` duplicates, and `sort -V` (version sort)
# to get the true newest. Prints the newest tag name, or nothing if there are no
# `vN.N.N` tags.
rp_newest_origin_tag() {
  _rp_ls_remote_tags \
    | sed -n 's#.*refs/tags/\(v[0-9][0-9.]*\)$#\1#p' \
    | sort -V \
    | tail -1
}

# ---- T78.1 two-way discriminator -------------------------------------------
#
# Given the newest origin tag and origin/master (both refs must be resolvable in
# the current repo — the caller fetches them), decide whether a release is due.
# Prints exactly one verdict line and returns:
#   0  → master is ahead: 'master ahead by N commits → shipping them'
#   3  → the tag already contains master: 'tag already contains master → refuse …'
#         (nonzero, with the evidence, so release.sh aborts)
#   4  → a range could not be computed (bad ref / instrument error) — fail closed
#
# Arg 1: newest tag ref (e.g. v0.5.270). Arg 2: master ref (default origin/master).
rp_two_way_discriminator() {
  local tag="$1" master="${2:-origin/master}"
  if [ -z "$tag" ]; then
    echo "release-preflight: no origin tag found → first release, nothing to compare → proceeding"
    return 0
  fi
  local ahead behind
  ahead="$(_rp_log_count "$tag" "$master")"      # commits master has that the tag lacks
  behind="$(_rp_log_count "$master" "$tag")"     # commits the tag has that master lacks
  case "$ahead$behind" in
    *ERR*|*[!0-9]*|"")
      echo "release-preflight: ERROR could not compute $tag..$master ranges (ahead='$ahead' behind='$behind') → refusing (fail closed)" >&2
      return 4 ;;
  esac
  if [ "$ahead" -eq 0 ]; then
    # master adds nothing beyond the newest tag → cutting a new tag here would be
    # a DUPLICATE of already-released code. This is the 3rd race shape.
    echo "release-preflight: tag already contains master → refuse to cut a duplicate (newest tag $tag is level with or ahead of $master; master adds 0 commits, tag adds $behind)" >&2
    return 3
  fi
  echo "release-preflight: master ahead by $ahead commits → shipping them (newest origin tag $tag; $master adds $ahead, tag adds $behind)"
  return 0
}

# ---- T78.2 next version free on BOTH surfaces ------------------------------
#
# The chosen NEW tag must not already exist as an origin tag NOR as a gh release
# (the v0.5.253 race took the number mid-flight, between the two reads). Prints a
# verdict line; returns 0 if free, 5 if taken on either surface.
# Arg 1: the tag to check (e.g. v0.5.271).
rp_next_version_free() {
  local tag="$1"
  local hit_tag="" hit_rel=""
  if _rp_ls_remote_tags | sed -n 's#.*refs/tags/\(v[0-9][0-9.]*\)$#\1#p' | grep -qx -- "$tag"; then
    hit_tag="origin-tag"
  fi
  if _rp_gh_release_tags | grep -qx -- "$tag"; then
    hit_rel="gh-release"
  fi
  if [ -n "$hit_tag" ] || [ -n "$hit_rel" ]; then
    echo "release-preflight: next version $tag is ALREADY TAKEN (${hit_tag:+$hit_tag}${hit_tag:+ }${hit_rel:-}) → pick the next free number" >&2
    return 5
  fi
  echo "release-preflight: next version $tag is free on origin tags and gh releases"
  return 0
}
