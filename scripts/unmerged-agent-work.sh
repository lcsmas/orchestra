#!/usr/bin/env bash
# Surface child-agent work that is committed but NOT merged.
#
# WHY THIS EXISTS: agents report via `orchestra message`, which only lands
# while a turn is running. An agent that finishes between turns goes idle and
# its report evaporates — so "no agent reported" is indistinguishable from
# "no agent finished". That has stranded work five times in this project,
# including a case where the coordinator ran a merge check, reported it as
# proof, and the check was structurally wrong.
#
# Agent messages are not a reliable signal. The unmerged-commit count is.
# This runs on every prompt so the check fires without anyone remembering.
#
# Scoped deliberately: only branches that are BOTH a live peer AND share
# history with this branch. An unrelated branch also has commits we do not —
# that is normal divergence, not work waiting on anyone, and flagging it would
# invite merging someone else's release commits.

set -uo pipefail
cd "${ORCHESTRA_WORKTREE:-.}" 2>/dev/null || exit 0
command -v git >/dev/null 2>&1 || exit 0

APP=/home/lmas/Applications/orchestra/release/Orchestra.AppImage
[ -x "$APP" ] || exit 0

peers=$("$APP" cli peers 2>/dev/null) || exit 0

# Branches reviewed and deliberately NOT merged. Each was checked at file level:
#   port-b1-sidebar        — its copy of a drive script is OLDER; merging would
#                            revert an atexit daemon-cleanup fix
#   gtk4-port-verifier     — verifier-local scratch; its files landed via A2
#   m4-visual-reference    — superseded by regenerated captures
#   login-isolated-*       — unrelated Electron work, carries version bumps
# Listing them forever trains the reader to ignore the warning, which is worse
# than not warning. Remove an entry the moment its reason stops holding.
DECLINED="port-b1-sidebar gtk4-port-verifier m4-visual-reference login-isolated-browser-session"

out=""
while read -r _id branch _rest; do
  case "$branch" in ''|id|-*) continue ;; esac
  case " $DECLINED " in *" $branch "*) continue ;; esac
  git rev-parse --verify --quiet "$branch" >/dev/null 2>&1 || continue
  git merge-base HEAD "$branch" >/dev/null 2>&1 || continue
  n=$(git rev-list --count "HEAD..$branch" 2>/dev/null) || continue
  [ "${n:-0}" -gt 0 ] || continue
  subject=$(git log --format=%s -1 "$branch" 2>/dev/null | cut -c1-58)
  out="${out}  ${branch} — ${n} commit(s), tip: ${subject}\n"
done <<< "$(awk 'NR>2 {print $1, $2}' <<< "$peers")"

[ -n "$out" ] || exit 0

printf '[unmerged agent work] child branches with commits not on this branch:\n'
printf "%b" "$out"
printf 'An agent that goes idle between turns cannot report — verify at the branch tip, not by waiting for a message.\n'
