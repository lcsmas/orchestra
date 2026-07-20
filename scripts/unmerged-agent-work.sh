#!/usr/bin/env bash
# Surface child-agent work that is committed but NOT merged.
#
# WHY THIS EXISTS — and NOT the reason first assumed.
#
# The first version of this comment claimed agent messages "evaporate between
# turns". That was fabricated to explain an absence I had not investigated, and
# it was wrong at BOTH layers of a two-layer mechanism:
#
#   1. Claude Code queues input typed while a turn is running and delivers it
#      to the agent — nothing is lost by arriving mid-turn. Orchestra writes
#      into a running agent's PTY, so this is the layer that actually carries
#      peer messages.
#   2. Orchestra's inbox (~/.orchestra/inbox/<wsid>.txt, drained by
#      inbox-instruction.sh) is a SEPARATE fallback for a workspace whose agent
#      is not running at all — workspaces.ts:1890 wakes a stopped target, and
#      only if waking fails is the message parked.
#
# Both work. The inbox directory did not even exist — not "empty", absent —
# because nothing had ever failed to deliver.
#
# THE ACTUAL CAUSE, and it is one level above the missing instruction: I NEVER
# INVOKED THE verified-fanout SKILL. I hand-wrote the M5 brief and called
# `orchestra spawn` seven times directly, reconstructing the brief from memory
# and losing the parts I did not happen to recall — the `orchestra message
# <ws-id>` report-back line among them, and also the skill's requirement for a
# DEDICATED VERIFIER gating merges, which M5 has none of.
#
# So the missing instruction was a symptom. Adding a grep check inside the skill
# helps whoever invokes the skill; it does nothing for the failure where the
# skill is bypassed. The guard that would have caught this is invoking it at
# all — which standing instructions already require for any multi-agent fan-out.
#
# The remaining gaps are quieter, and none of them is a broken queue:
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
dirty=""
while read -r _id branch _rest; do
  case "$branch" in ''|id|-*) continue ;; esac
  case " $DECLINED " in *" $branch "*) continue ;; esac
  git rev-parse --verify --quiet "$branch" >/dev/null 2>&1 || continue
  git merge-base HEAD "$branch" >/dev/null 2>&1 || continue

  # UNCOMMITTED work is a SEPARATE question from unmerged commits, and the
  # range check below is structurally blind to it. An agent whose last act
  # generates artifacts (regenerated fixtures, captures, reports) routinely
  # leaves them unstaged AFTER its final commit: the branch merges clean, the
  # range reads 0, and the work is still missing. It then dies with the
  # worktree. Cost a full set of regenerated reference captures once, and the
  # resulting freshness-gate failure was misattributed to something else.
  wt=$(git worktree list --porcelain 2>/dev/null |
       awk -v b="refs/heads/$branch" '/^worktree /{w=$2} $0=="branch "b{print w; exit}')
  if [ -n "$wt" ] && [ -d "$wt" ]; then
    nd=$(git -C "$wt" status --porcelain 2>/dev/null | wc -l)
    [ "${nd:-0}" -gt 0 ] && dirty="${dirty}  ${branch} — ${nd} uncommitted file(s) in ${wt}\n"
  fi

  n=$(git rev-list --count "HEAD..$branch" 2>/dev/null) || continue
  [ "${n:-0}" -gt 0 ] || continue
  subject=$(git log --format=%s -1 "$branch" 2>/dev/null | cut -c1-58)
  out="${out}  ${branch} — ${n} commit(s), tip: ${subject}\n"
done <<< "$(awk 'NR>2 {print $1, $2}' <<< "$peers")"

if [ -n "$out" ]; then
  printf '[unmerged agent work] child branches with commits not on this branch:\n'
  printf "%b" "$out"
  printf 'Commits exist before a report is sent, and an agent may still be working. Check the tip; do not wait to be told.\n'
fi

if [ -n "$dirty" ]; then
  printf '[uncommitted agent work] child worktrees with unstaged changes:\n'
  printf "%b" "$dirty"
  printf 'A merged branch does NOT mean the work landed — this is invisible to the range check above, and it is lost when the worktree is removed.\n'
fi
