#!/usr/bin/env bash
# C2 #209 — CPU/wall cost of ONE firing of each git command the renderer's 8 s stats poll makes per workspace, on REAL repos
# (argv copied from the app's own exec log, scripts/hidden-cost/app-idle-rig.sh). Read-only (GIT_OPTIONAL_LOCKS=0: no index refresh write).
#   bash scripts/hidden-cost/git-poll-cost.sh <repo-worktree> [runs=20]
set -u
repo="${1:?repo path}"; runs="${2:-20}"
[ -d "$repo/.git" ] || [ -f "$repo/.git" ] || { echo "not a git worktree: $repo" >&2; exit 2; }
export GIT_OPTIONAL_LOCKS=0 LC_ALL=C
branch="$(git -C "$repo" rev-parse --abbrev-ref HEAD)"
tracked="$(git -C "$repo" ls-files | wc -l)"
echo "repo=$repo branch=$branch tracked_files=$tracked load=$(cut -d' ' -f1-3 /proc/loadavg)"
run() {  # label, argv...
  local label="$1"; shift
  local tf; tf="$(mktemp)"
  TIMEFORMAT='%3R %3U %3S'
  { time { for _ in $(seq "$runs"); do git -C "$repo" "$@" >/dev/null 2>&1; done; } ; } 2>"$tf"
  read -r real user sys < "$tf"; rm -f "$tf"
  awk -v l="$label" -v r="$real" -v u="$user" -v s="$sys" -v n="$runs" 'BEGIN { printf "%-44s wall %7.1f ms   cpu(user+sys) %7.1f ms   per spawn (mean of %d)\n", l, r*1000/n, (u+s)*1000/n, n }'
}
run "git diff --numstat HEAD" diff --numstat HEAD
run "git ls-files --others --exclude-standard" ls-files --others --exclude-standard
run "git rev-parse --verify origin/<branch>" rev-parse --verify "origin/$branch"
run "git rev-parse <branch> main" rev-parse "$branch" main
run "git rev-parse --abbrev-ref HEAD" rev-parse --abbrev-ref HEAD
