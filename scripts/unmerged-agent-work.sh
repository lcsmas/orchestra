#!/usr/bin/env bash
# Surface child-agent work that is committed but NOT merged.
#
# WHY THIS EXISTS — and NOT the reason first assumed.
#
# The first version of this comment claimed agent messages "evaporate between
# turns". That was fabricated to explain an absence I had not investigated.
# Orchestra's delivery is sound: workspaces.ts:1890 types the message into a
# RUNNING target's PTY and submits it; a STOPPED target gets woken, and only
# if waking fails is the message parked in ~/.orchestra/inbox/<wsid>.txt, which
# inbox-instruction.sh drains on the next session. Live, started, inbox — three
# paths, all covered.
#
# The real gaps are quieter, and none of them is a broken queue:
#   - An agent COMMITS BEFORE IT REPORTS. Work exists on a branch for minutes
#     or hours before any message is sent — and if the agent is still working,
#     no message is owed yet. "No report" often just means "not finished".
#   - An agent can stop, be killed, or run out of context after committing and
#     before reporting. Then no message is ever owed, and nothing is wrong
#     anywhere — the commits simply sit there.
#   - A report that DOES arrive can be missed in a long turn among tool output.
#
# So this is not a workaround for a broken mechanism. It is a second,
# independent signal that does not depend on an agent choosing to speak:
# commits on a branch are a fact about the repo, not a message anyone sent.
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
printf 'Commits exist before a report is sent, and an agent may still be working. Check the tip; do not wait to be told.\n'
